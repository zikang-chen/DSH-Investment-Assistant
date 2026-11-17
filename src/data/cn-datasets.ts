/**
 * CN free dataset adapter (AKShare / BaoStock via a small Python bridge).
 *
 * Design:
 *  - TypeScript keeps its shape; heavy Python libs stay in scripts/fin_cn_datasets.py.
 *  - Every dataset carries provenance (provider/source/url), unit and period.
 *  - Missing values stay null; this module never coerces NaN/None to 0.
 *  - `asOf` is the latest statistical period; `fetchedAt` is the fetch time.
 *  - Unavailable datasets return ok:false with a reason (no fake rows).
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export interface CnDatasetMeta {
  dataset: string
  provider: string | null
  available: boolean
  source?: string
  sourceUrl?: string
  unit?: string
  frequency?: string
  periodField?: string
  params?: Array<{ name: string; default?: string }>
  reason?: string
}

export interface CnDatasetResult {
  ok: boolean
  dataset: string
  provider?: string | null
  source?: string
  sourceUrl?: string
  fetchedAt?: string
  asOf?: string | null
  unit?: string
  periodField?: string
  fields?: string[]
  rows?: Array<Record<string, string | number | boolean | null>>
  rowCount?: number
  truncated?: boolean
  warnings?: string[]
  revisionNote?: string
  error?: string
  cached?: boolean
}

type Runner = (args: string[]) => Promise<string>

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/fin_cn_datasets.py')
const PYTHON = process.env.DSH_PYTHON_BIN || process.env.PYTHON || 'python'
export const CN_DATASET_TIMEOUT_MS = Number(process.env.DSH_CN_DATASET_TIMEOUT_MS || 60_000)
const CACHE_TTL_MS = 10 * 60_000
const META_TTL_MS = 60 * 60_000

const cache = new Map<string, { at: number; value: CnDatasetResult }>()
let metaCache: { at: number; value: CnDatasetMeta[] } | undefined

export function defaultRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [BRIDGE, ...args],
      {
        timeout: CN_DATASET_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`))
          return
        }
        resolve(String(stdout ?? '').trim())
      },
    )
  })
}

function parseJsonLine(text: string): unknown {
  const line = text.split('\n').filter(l => l.trim().startsWith('{')).pop()
  if (!line) throw new Error(`Python 桥未返回 JSON：${text.slice(0, 200)}`)
  return JSON.parse(line)
}

function snakeToCamel(meta: Record<string, unknown>): CnDatasetMeta {
  return {
    dataset: String(meta.dataset),
    provider: (meta.provider as string | null) ?? null,
    available: meta.available !== false,
    source: meta.source as string | undefined,
    sourceUrl: meta.source_url as string | undefined,
    unit: meta.unit as string | undefined,
    frequency: meta.frequency as string | undefined,
    periodField: meta.period_field as string | undefined,
    params: (meta.params as Array<{ name: string; default?: string }> | undefined) ?? [],
    reason: meta.reason as string | undefined,
  }
}

/** Validate the bridge payload without inventing values. */
export function normalizeCnDataset(payload: unknown, fetchedAt = new Date().toISOString()): CnDatasetResult {
  if (!payload || typeof payload !== 'object') return { ok: false, dataset: '', error: '桥返回非对象' }
  const p = payload as Record<string, unknown>
  const dataset = String(p.dataset ?? '')
  if (p.ok === false) return { ok: false, dataset, provider: (p.provider as string | null) ?? null, error: String(p.error ?? '未知错误') }
  const rows = Array.isArray(p.rows) ? (p.rows as Array<Record<string, string | number | boolean | null>>) : []
  return {
    ok: true,
    dataset,
    provider: (p.provider as string | null) ?? null,
    source: p.source as string | undefined,
    sourceUrl: p.source_url as string | undefined,
    fetchedAt: (p.fetched_at as string) ?? fetchedAt,
    asOf: (p.as_of as string | null) ?? null,
    unit: p.unit as string | undefined,
    periodField: p.period_field as string | undefined,
    fields: Array.isArray(p.fields) ? (p.fields as string[]) : (rows[0] ? Object.keys(rows[0]) : []),
    rows,
    rowCount: typeof p.row_count === 'number' ? p.row_count : rows.length,
    truncated: p.truncated === true,
    warnings: Array.isArray(p.warnings) ? (p.warnings as string[]) : [],
    revisionNote: p.revision_note as string | undefined,
  }
}

export async function listCnDatasets(options: { runner?: Runner; force?: boolean } = {}): Promise<CnDatasetMeta[]> {
  if (!options.force && metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.value
  const runner = options.runner ?? defaultRunner
  const out = await runner(['--list'])
  const parsed = parseJsonLine(out) as { datasets?: Record<string, unknown>[] }
  const list = (parsed.datasets ?? []).map(snakeToCamel)
  metaCache = { at: Date.now(), value: list }
  return list
}

export interface FetchCnOptions {
  params?: Record<string, string | number>
  limit?: number
  runner?: Runner
  cache?: boolean
  now?: () => number
}

export async function fetchCnDataset(dataset: string, options: FetchCnOptions = {}): Promise<CnDatasetResult> {
  const key = `${dataset}|${JSON.stringify(options.params ?? {})}|${options.limit ?? 0}`
  const now = options.now ?? Date.now
  if (options.cache !== false) {
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true }
  }
  const runner = options.runner ?? defaultRunner
  const args = ['--dataset', dataset]
  if (options.params && Object.keys(options.params).length) args.push('--params', JSON.stringify(options.params))
  if (options.limit) args.push('--limit', String(options.limit))
  let result: CnDatasetResult
  try {
    const out = await runner(args)
    result = normalizeCnDataset(parseJsonLine(out))
  } catch (err) {
    result = { ok: false, dataset, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.ok) cache.set(key, { at: now(), value: result })
  return result
}

/** Health check: a tiny CPI request. Returns ok + latency, never fabricates health. */
export async function checkCnBridge(options: { runner?: Runner } = {}): Promise<{ ok: boolean; latencyMs: number; asOf?: string | null; error?: string }> {
  const started = Date.now()
  try {
    const result = await fetchCnDataset('CN_MACRO_CPI', { limit: 1, cache: false, ...(options.runner ? { runner: options.runner } : {}) })
    return { ok: result.ok, latencyMs: Date.now() - started, asOf: result.asOf ?? null, ...(result.ok ? {} : { error: result.error }) }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
  }
}

export function clearCnDatasetCache(): void { cache.clear(); metaCache = undefined }

export interface ConflictEntry {
  period: string
  field: string
  values: Array<{ provider: string; value: number | null }>
  difference: number | null
  status: 'match' | 'mismatch' | 'missing'
}

/**
 * Compare the same metric from two providers for the same periods and flag
 * mismatches. Never averages them away: differences are surfaced for review.
 * tolerance is absolute (default 0.05 in the metric's own unit).
 */
export function compareCnSeries(
  left: { provider: string; rows: Array<Record<string, unknown>>; periodField: string; valueField: string },
  right: { provider: string; rows: Array<Record<string, unknown>>; periodField: string; valueField: string },
  tolerance = 0.05,
): ConflictEntry[] {
  const key = (row: Record<string, unknown>, pf: string): string => String(row[pf] ?? '').trim()
  const toNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const rightMap = new Map<string, number | null>()
  for (const row of right.rows) rightMap.set(key(row, right.periodField), toNum(row[right.valueField]))
  const out: ConflictEntry[] = []
  for (const row of left.rows) {
    const period = key(row, left.periodField)
    if (!period) continue
    const a = toNum(row[left.valueField])
    const b = rightMap.has(period) ? rightMap.get(period)! : null
    const difference = a === null || b === null ? null : Number((a - b).toFixed(6))
    const status: ConflictEntry['status'] = difference === null ? 'missing' : Math.abs(difference) <= tolerance ? 'match' : 'mismatch'
    out.push({
      period,
      field: left.valueField,
      values: [{ provider: left.provider, value: a }, { provider: right.provider, value: b }],
      difference,
      status,
    })
  }
  return out
}
