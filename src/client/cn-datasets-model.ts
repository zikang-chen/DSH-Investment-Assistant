/**
 * Pure presentation model for the CN free-dataset panel.
 *
 * No React, no network, no DOM, no writes — safe to unit test offline.
 * Types mirror src/data/cn-datasets.ts (`CnDatasetMeta` / `CnDatasetResult`); the
 * import is type-only, so nothing from the Python bridge (`node:child_process`) is
 * pulled into the client bundle.
 *
 * Status is never implied by a coloured dot alone: every consumer gets a text label
 * AND a tone, so "未测试 / 需要配置 / 数据过期" are never mistaken for "已验证可用".
 */
import type { CnDatasetMeta, CnDatasetResult } from '../data/cn-datasets.js'

export type DatasetStatus = 'verified' | 'untested' | 'needs_config' | 'unavailable' | 'stale'
export type DatasetTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

/** Shape returned by GET /plugins/dsh-finance/api/cn-datasets -> bridge. */
export interface BridgeHealth {
  ok: boolean
  latencyMs?: number
  asOf?: string | null
  error?: string
}

export interface BridgeView {
  ok: boolean
  label: string
  tone: DatasetTone
  detail: string
}

export interface StatusView {
  status: DatasetStatus
  label: string
  tone: DatasetTone
}

export type RowValue = string | number | boolean | null

/** Normalised result of one manual "测试" call. */
export interface TestOutcome {
  ok: boolean
  asOf: string | null
  /** null means "unknown / not returned"; never coerced to 0. */
  rowCount: number | null
  fields: string[]
  firstRow: Record<string, RowValue> | null
  error: string | null
  elapsedMs: number | null
  warnings: string[]
}

export interface PreviewField {
  key: string
  value: string
}

export interface ProviderGroup<T> {
  provider: string | null
  label: string
  items: T[]
}

export interface StaleOptions {
  /** Threshold for monthly / quarterly series (default 45 days). */
  staleDays?: number
  /** Threshold for daily series (default 7 days). */
  dailyStaleDays?: number
  now?: Date
}

export const DEFAULT_STALE_DAYS = 45
export const DEFAULT_DAILY_STALE_DAYS = 7

const MS_PER_DAY = 86_400_000

export const STATUS_LABEL: Record<DatasetStatus, string> = {
  verified: '已验证可用',
  untested: '未测试',
  needs_config: '需要配置',
  unavailable: '不可用',
  stale: '数据过期',
}

export const STATUS_TONE: Record<DatasetStatus, DatasetTone> = {
  verified: 'success',
  untested: 'neutral',
  needs_config: 'warning',
  unavailable: 'danger',
  stale: 'warning',
}

export function statusView(status: DatasetStatus): StatusView {
  return { status, label: STATUS_LABEL[status], tone: STATUS_TONE[status] }
}

const FREQUENCY_LABEL: Record<string, string> = {
  daily: '日频',
  weekly: '周频',
  monthly: '月度',
  quarterly: '季度',
  annual: '年度',
  yearly: '年度',
  event: '事件',
  snapshot: '快照',
}

export function frequencyLabel(frequency: string | null | undefined): string {
  if (frequency == null) return '—'
  const text = String(frequency).trim()
  if (!text) return '—'
  return FREQUENCY_LABEL[text.toLowerCase()] ?? text
}

export function providerLabel(provider: string | null | undefined): string {
  const text = provider == null ? '' : String(provider).trim()
  if (!text) return '未接入（无可用来源）'
  const known: Record<string, string> = { akshare: 'AKShare', baostock: 'BaoStock' }
  return known[text.toLowerCase()] ?? text
}

/** Stable grouping in first-appearance order; ungrouped (null provider) stays where it appears. */
export function groupByProvider<T extends { provider?: string | null }>(items: readonly T[]): ProviderGroup<T>[] {
  const groups: ProviderGroup<T>[] = []
  const index = new Map<string, ProviderGroup<T>>()
  for (const item of items) {
    const provider = item.provider ?? null
    const key = provider == null ? '\u0000null' : provider
    let group = index.get(key)
    if (!group) {
      group = { provider, label: providerLabel(provider), items: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

// ---- date / staleness -----------------------------------------------------

function utcDate(year: number, monthIndex: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) return null
  if (monthIndex < 0 || monthIndex > 12) return null
  if (day < 0 || day > 31) return null
  const date = new Date(Date.UTC(year, monthIndex, day))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Parse a statistical-period label into the LAST day that period covers.
 * Using the period end means a fresh monthly/quarterly release is not flagged stale
 * just because the period began weeks ago. Unparseable input returns null (unknown),
 * which is treated as "cannot judge" — never as day 0.
 */
export function parseAsOfDate(asOf: string | null | undefined): Date | null {
  if (asOf == null) return null
  const text = String(asOf).trim()
  if (!text) return null

  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (match) {
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return utcDate(Number(match[1]), month - 1, day)
  }

  match = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (match) {
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return utcDate(Number(match[1]), month - 1, day)
  }

  match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (match) {
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return utcDate(Number(match[1]), month - 1, day)
  }

  match = text.match(/(\d{4})\s*[Qq]\s*([1-4])/)
  if (match) return utcDate(Number(match[1]), Number(match[2]) * 3, 0)

  match = text.match(/(\d{4})\s*(?:年)?\s*(?:第)?\s*([一二三四1-4])\s*(?:季度|季)/)
  if (match) {
    const cnQuarter: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 }
    const quarter = cnQuarter[match[2]] ?? Number(match[2])
    if (!Number.isFinite(quarter)) return null
    return utcDate(Number(match[1]), quarter * 3, 0)
  }

  match = text.match(/(\d{4})\s*[年-]\s*(\d{1,2})\s*月?/)
  if (match) {
    const month = Number(match[2])
    if (month < 1 || month > 12) return null
    return utcDate(Number(match[1]), month, 0)
  }

  match = text.match(/^(\d{4})\s*年?$/)
  if (match) return utcDate(Number(match[1]), 11, 31)

  return null
}

/** null => this frequency has no staleness concept (event/snapshot/unknown). */
export function staleLimitDays(frequency: string | null | undefined, options: StaleOptions = {}): number | null {
  const text = frequency == null ? '' : String(frequency).trim().toLowerCase()
  if (text === 'monthly' || text === 'quarterly') {
    const raw = options.staleDays
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_STALE_DAYS
  }
  if (text === 'daily') {
    const raw = options.dailyStaleDays
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_STALE_DAYS
  }
  return null
}

export function isStale(asOf: string | null | undefined, frequency: string | null | undefined, options: StaleOptions = {}): boolean {
  const limit = staleLimitDays(frequency, options)
  if (limit == null) return false
  const date = parseAsOfDate(asOf)
  if (!date) return false
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return false
  const ageDays = (nowMs - date.getTime()) / MS_PER_DAY
  return ageDays > limit
}

// ---- status ---------------------------------------------------------------

export function deriveStatus(
  meta: Pick<CnDatasetMeta, 'available' | 'frequency' | 'reason'>,
  bridge: BridgeHealth | undefined,
  outcome: TestOutcome | null | undefined,
  options: StaleOptions = {},
): DatasetStatus {
  if (meta.available === false) return 'unavailable'
  if (bridge && bridge.ok === false) return 'needs_config'
  if (!outcome) return 'untested'
  if (!outcome.ok) return 'unavailable'
  return isStale(outcome.asOf, meta.frequency, options) ? 'stale' : 'verified'
}

export function statusReason(
  meta: Pick<CnDatasetMeta, 'available' | 'frequency' | 'reason'>,
  bridge: BridgeHealth | undefined,
  outcome: TestOutcome | null | undefined,
  options: StaleOptions = {},
): string {
  const status = deriveStatus(meta, bridge, outcome, options)
  switch (status) {
    case 'unavailable':
      if (meta.available === false) return (meta.reason ?? '').trim() || '该数据集未接入（暂无可用免费来源）'
      return (outcome?.error ?? '').trim() || '测试失败：未返回有效数据'
    case 'needs_config':
      return (bridge?.error ?? '').trim()
        ? `桥接不可用：${bridge!.error}`
        : '桥接未连接：无法取数，请检查 Python 桥接与依赖'
    case 'stale': {
      const limit = staleLimitDays(meta.frequency, options)
      return `最新统计期 ${formatAsOf(outcome?.asOf)} 距今日已超过 ${limit ?? DEFAULT_STALE_DAYS} 天阈值`
    }
    case 'untested':
      return '未测试：可点击「测试」发起一次真实请求'
    default:
      return ''
  }
}

// ---- formatting -----------------------------------------------------------

/** Missing stays a dash — 0 / false / '' are real values and preserved as-is. */
export function formatCell(value: RowValue | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export function formatAsOf(asOf: string | null | undefined): string {
  if (asOf == null) return '—'
  const text = String(asOf).trim()
  return text || '—'
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

/** First `max` fields of a row, formatted; empty when there is no row. */
export function firstRowPreview(row: Record<string, RowValue> | null | undefined, max = 3): PreviewField[] {
  if (!row) return []
  const limit = Math.max(0, Math.trunc(max))
  return Object.keys(row).slice(0, limit).map(key => ({ key, value: formatCell(row[key]) }))
}

export function bridgeView(bridge: BridgeHealth | undefined): BridgeView {
  if (!bridge) return { ok: false, label: '未检测', tone: 'neutral', detail: '尚未读取桥接健康状态' }
  if (bridge.ok) {
    return {
      ok: true,
      label: '已连接',
      tone: 'success',
      detail: `延迟 ${formatLatency(bridge.latencyMs)} · 最新统计期 ${formatAsOf(bridge.asOf)}`,
    }
  }
  return {
    ok: false,
    label: '不可用',
    tone: 'danger',
    detail: (bridge.error ?? '').trim() ? `错误原因：${bridge.error}` : '桥接不可用（未返回原因）',
  }
}

/** Map the bridge result to a normalised outcome; missing rowCount stays null, never 0. */
export function outcomeFromResult(result: CnDatasetResult, elapsedMs: number | null = null): TestOutcome {
  if (!result || result.ok !== true) {
    return {
      ok: false,
      asOf: null,
      rowCount: null,
      fields: [],
      firstRow: null,
      error: (result?.error ?? '').trim() || '取数失败：未返回有效结果',
      elapsedMs,
      warnings: Array.isArray(result?.warnings) ? result!.warnings : [],
    }
  }
  const rows = Array.isArray(result.rows) ? result.rows : []
  const firstRow = rows.length ? (rows[0] as Record<string, RowValue>) : null
  const fields = Array.isArray(result.fields) && result.fields.length
    ? result.fields
    : firstRow
      ? Object.keys(firstRow)
      : []
  const rowCount = typeof result.rowCount === 'number'
    ? result.rowCount
    : Array.isArray(result.rows)
      ? rows.length
      : null
  return {
    ok: true,
    asOf: result.asOf ?? null,
    rowCount,
    fields,
    firstRow,
    error: null,
    elapsedMs,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  }
}

export function outcomeView(outcome: TestOutcome): { ok: boolean; label: string; tone: DatasetTone } {
  return outcome.ok
    ? { ok: true, label: '测试成功', tone: 'success' }
    : { ok: false, label: '测试失败', tone: 'danger' }
}

/** Deterministic request path for one manual test (limit=1 to read the latest row only). */
export function buildDatasetQuery(dataset: string, limit = 1): string {
  return `/cn-dataset?dataset=${encodeURIComponent(dataset)}&limit=${limit}`
}

// ---- scoped styles (design-system tokens only) -----------------------------

export const cnDatasetsCss = `
.fia-root .fia-cn-datasets{display:flex;flex-direction:column;gap:var(--fia-space-4);min-width:0;container-type:inline-size;container-name:fia-cn-datasets}
.fia-root .fia-cn-datasets .fia-page-header{margin-bottom:0}
.fia-root .fia-cn-datasets__bridge{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2) var(--fia-space-3);padding:var(--fia-space-3) var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface-muted);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-cn-datasets__bridge[data-tone=success]{border-color:var(--fia-success);background:var(--fia-success-soft);color:var(--fia-success)}
.fia-root .fia-cn-datasets__bridge[data-tone=warning]{border-color:var(--fia-warning);background:var(--fia-warning-soft);color:var(--fia-warning)}
.fia-root .fia-cn-datasets__bridge[data-tone=danger]{border-color:var(--fia-danger);background:var(--fia-danger-soft);color:var(--fia-danger)}
.fia-root .fia-cn-datasets__bridge-detail{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.fia-root .fia-cn-datasets__meta{display:flex;flex-wrap:wrap;gap:var(--fia-space-2) var(--fia-space-4);color:var(--fia-secondary);font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums}
.fia-root .fia-cn-datasets__feedback{margin:0;padding:var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-cn-datasets__feedback[data-tone=error]{border-color:var(--fia-danger);color:var(--fia-danger);background:var(--fia-danger-soft)}
.fia-root .fia-cn-datasets__group{display:flex;flex-direction:column;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-cn-datasets__group-title{margin:0;color:var(--fia-text);font-size:var(--fia-font-lg);font-weight:600;line-height:1.4}
.fia-root .fia-cn-datasets__group-title span{color:var(--fia-muted);font-size:var(--fia-font-sm);font-weight:500}
.fia-root .fia-cn-datasets__card{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,240px);gap:var(--fia-space-3) var(--fia-space-4);min-width:0;padding:var(--fia-space-3) var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface)}
.fia-root .fia-cn-datasets__card[data-status=verified]{border-inline-start:3px solid var(--fia-success)}
.fia-root .fia-cn-datasets__card[data-status=needs_config],.fia-root .fia-cn-datasets__card[data-status=stale]{border-inline-start:3px solid var(--fia-warning)}
.fia-root .fia-cn-datasets__card[data-status=unavailable]{border-inline-start:3px solid var(--fia-danger)}
.fia-root .fia-cn-datasets__card-main{display:flex;flex-direction:column;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-cn-datasets__card-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2)}
.fia-root .fia-cn-datasets__id{font-family:var(--fia-font-mono);font-size:var(--fia-font-sm);color:var(--fia-text);overflow-wrap:anywhere;word-break:break-word}
.fia-root .fia-cn-datasets__facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--fia-space-2) var(--fia-space-3);margin:0}
.fia-root .fia-cn-datasets__facts>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.fia-root .fia-cn-datasets__facts dt{color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-cn-datasets__facts dd{margin:0;color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.fia-root .fia-cn-datasets__reason{margin:0;color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-cn-datasets__source-link{color:var(--fia-brand);font-size:var(--fia-font-xs);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
.fia-root .fia-cn-datasets__card-test{display:flex;flex-direction:column;gap:var(--fia-space-2);align-items:flex-start;min-width:0}
.fia-root .fia-cn-datasets__test-disabled{color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-cn-datasets__outcome{display:flex;flex-direction:column;gap:var(--fia-space-1);width:100%;padding:var(--fia-space-2) var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);font-size:var(--fia-font-xs);overflow-wrap:anywhere}
.fia-root .fia-cn-datasets__outcome[data-tone=success]{border-color:var(--fia-success);background:var(--fia-success-soft)}
.fia-root .fia-cn-datasets__outcome[data-tone=danger]{border-color:var(--fia-danger);background:var(--fia-danger-soft);color:var(--fia-danger)}
.fia-root .fia-cn-datasets__outcome-row{display:flex;flex-wrap:wrap;gap:var(--fia-space-2);color:var(--fia-secondary);font-variant-numeric:tabular-nums}
.fia-root .fia-cn-datasets__outcome-label{font-weight:600}
.fia-root .fia-cn-datasets__preview{margin:0;padding-left:var(--fia-space-4);color:var(--fia-secondary);font-variant-numeric:tabular-nums}
.fia-root .fia-cn-datasets__preview li{overflow-wrap:anywhere}
@container fia-cn-datasets (max-width:560px){.fia-root .fia-cn-datasets__card{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cn-datasets__facts{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cn-datasets__card-test{align-items:stretch}.fia-root .fia-cn-datasets__card-test .fia-button{width:100%}}
@media(max-width:560px){.fia-root .fia-cn-datasets__card{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cn-datasets__facts{grid-template-columns:minmax(0,1fr)}}
`
