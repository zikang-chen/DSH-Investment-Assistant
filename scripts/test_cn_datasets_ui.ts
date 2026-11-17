/** Pure functions + static contracts only. No DOM, no browser, no network, no private data, no writes. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_DAILY_STALE_DAYS, DEFAULT_STALE_DAYS, STATUS_LABEL, STATUS_TONE,
  bridgeView, buildDatasetQuery, cnDatasetsCss, deriveStatus, firstRowPreview, formatAsOf,
  formatCell, formatDuration, formatLatency, frequencyLabel, groupByProvider, isStale,
  outcomeFromResult, outcomeView, parseAsOfDate, providerLabel, staleLimitDays,
  statusReason, statusView,
  type BridgeHealth, type TestOutcome,
} from '../src/client/cn-datasets-model.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

type Meta = { available: boolean; frequency?: string; reason?: string }
const meta = (over: Partial<Meta> = {}): Meta => ({ available: true, frequency: 'monthly', ...over })
const bridgeOk: BridgeHealth = { ok: true, latencyMs: 120, asOf: '2026年10月份' }
const bridgeDown: BridgeHealth = { ok: false, latencyMs: 30, error: 'python 未安装' }
const okOutcome = (over: Partial<TestOutcome> = {}): TestOutcome => ({
  ok: true, asOf: '2026年10月份', rowCount: 1, fields: ['月份'], firstRow: { 月份: '2026年10月份' },
  error: null, elapsedMs: 42, warnings: [], ...over,
})
const failOutcome = (over: Partial<TestOutcome> = {}): TestOutcome => ({
  ok: false, asOf: null, rowCount: null, fields: [], firstRow: null,
  error: 'ReadTimeout: upstream 502', elapsedMs: 900, warnings: [], ...over,
})

// ---- status mapping -------------------------------------------------------

check('all five status labels carry both text and tone (green never implies health)', () => {
  assert.deepEqual(statusView('verified'), { status: 'verified', label: '已验证可用', tone: 'success' })
  assert.equal(statusView('untested').label, '未测试')
  assert.equal(statusView('untested').tone, 'neutral', 'untested is neutral, not success')
  assert.equal(statusView('needs_config').label, '需要配置')
  assert.equal(statusView('needs_config').tone, 'warning')
  assert.equal(statusView('unavailable').label, '不可用')
  assert.equal(statusView('unavailable').tone, 'danger')
  assert.equal(statusView('stale').label, '数据过期')
  assert.equal(statusView('stale').tone, 'warning')
  // Every status has a distinct text label; only 'verified' maps to success/green.
  assert.equal(Object.keys(STATUS_LABEL).length, 5)
  const green = Object.entries(STATUS_TONE).filter(([, tone]) => tone === 'success').map(([status]) => status)
  assert.deepEqual(green, ['verified'])
})

check('deriveStatus precedence: unavailable > needs_config > untested > tested', () => {
  assert.equal(deriveStatus(meta({ available: false }), bridgeOk, okOutcome()), 'unavailable', 'available=false wins over everything')
  assert.equal(deriveStatus(meta(), bridgeDown, undefined), 'needs_config', 'bridge down => 需要配置')
  assert.equal(deriveStatus(meta(), bridgeDown, okOutcome()), 'needs_config', 'bridge gate precedes a cached outcome')
  assert.equal(deriveStatus(meta(), bridgeOk, null), 'untested')
  assert.equal(deriveStatus(meta(), bridgeOk, undefined), 'untested')
  assert.equal(deriveStatus(meta(), bridgeOk, okOutcome()), 'verified')
  assert.equal(deriveStatus(meta(), bridgeOk, failOutcome()), 'unavailable', 'a failed test is never verified')
  assert.equal(deriveStatus(meta(), undefined, okOutcome()), 'verified', 'unknown bridge does not gate an explicit success')
})

check('failure never surfaces as success, and the real error is shown', () => {
  const status = deriveStatus(meta(), bridgeOk, failOutcome())
  assert.notEqual(status, 'verified')
  assert.notEqual(status, 'stale')
  assert.equal(statusView(status).label, '不可用')
  assert.equal(outcomeView(failOutcome()).label, '测试失败')
  assert.equal(outcomeView(failOutcome()).tone, 'danger')
  assert.notEqual(outcomeView(failOutcome()).label, STATUS_LABEL.verified)
  assert.match(statusReason(meta(), bridgeOk, failOutcome()), /ReadTimeout/)
  assert.equal(outcomeView(okOutcome()).label, '测试成功')
})

check('statusReason covers each branch without inventing data', () => {
  assert.match(statusReason(meta({ available: false, reason: 'AKShare 无存量口径' }), bridgeOk, null), /存量口径/)
  assert.equal(statusReason(meta({ available: false, reason: '' }), bridgeOk, null), '该数据集未接入（暂无可用免费来源）')
  assert.match(statusReason(meta(), bridgeDown, null), /python 未安装/)
  assert.match(statusReason(meta(), { ok: false }, null), /桥接未连接/)
  assert.match(statusReason(meta(), bridgeOk, null), /未测试/)
  assert.equal(statusReason(meta(), bridgeOk, okOutcome()), '')
  assert.match(statusReason(meta(), bridgeOk, okOutcome({ asOf: '2020年1月' })), /超过 \d+ 天阈值/)
})

// ---- staleness ------------------------------------------------------------

check('asOf parsing uses the period end and handles date/month/quarter/year', () => {
  assert.deepEqual(parseAsOfDate('2026-11-17'), utc(2026, 10, 17))
  assert.deepEqual(parseAsOfDate('20261117'), utc(2026, 10, 17))
  assert.deepEqual(parseAsOfDate('2026年10月份'), utc(2026, 10, 0), 'Oct 31 (month end)')
  assert.deepEqual(parseAsOfDate('2026-11'), utc(2026, 11, 0), 'Nov 30 (month end)')
  assert.deepEqual(parseAsOfDate('2026Q3'), utc(2026, 9, 0), 'Sep 30 (quarter end)')
  assert.deepEqual(parseAsOfDate('2026年第三季度'), utc(2026, 9, 0))
  assert.deepEqual(parseAsOfDate('2026'), utc(2026, 11, 31), 'Dec 31 (year end)')
  for (const bad of [null, undefined, '', '   ', 'unknown', 'N/A', '2026年13月']) {
    assert.equal(parseAsOfDate(bad as string | null | undefined), null, String(bad))
  }
})

check('stale thresholds: monthly/quarterly default 45d, daily default 7d, event/snapshot exempt', () => {
  assert.equal(DEFAULT_STALE_DAYS, 45)
  assert.equal(DEFAULT_DAILY_STALE_DAYS, 7)
  assert.equal(staleLimitDays('monthly'), 45)
  assert.equal(staleLimitDays('quarterly'), 45)
  assert.equal(staleLimitDays('daily'), 7)
  assert.equal(staleLimitDays('event'), null)
  assert.equal(staleLimitDays('snapshot'), null)
  assert.equal(staleLimitDays('monthly', { staleDays: 10 }), 10, 'configurable')
})

check('isStale boundary is strict (> limit) and missing asOf is never day 0', () => {
  // Oct 31 + 45 days = Dec 15 (age 45 -> fresh); Dec 16 (age 46 -> stale)
  assert.equal(isStale('2026年10月份', 'monthly', { now: utc(2026, 11, 15) }), false)
  assert.equal(isStale('2026年10月份', 'monthly', { now: utc(2026, 11, 16) }), true)
  // daily: 2026-11-17 + 7 = 2026-11-24 (fresh); +8 = stale
  assert.equal(isStale('2026-11-17', 'daily', { now: utc(2026, 10, 24) }), false)
  assert.equal(isStale('2026-11-17', 'daily', { now: utc(2026, 10, 25) }), true)
  // event/snapshot never stale regardless of age
  assert.equal(isStale('2000-01-01', 'event', { now: utc(2026, 10, 17) }), false)
  assert.equal(isStale('2000-01-01', 'snapshot', { now: utc(2026, 10, 17) }), false)
  // unknown / missing => cannot judge, not stale
  assert.equal(isStale(null, 'monthly', { now: utc(2026, 10, 17) }), false)
  assert.equal(isStale('unknown', 'monthly', { now: utc(2026, 10, 17) }), false)
  // configurable threshold applies only to monthly/quarterly
  assert.equal(isStale('2026年10月份', 'monthly', { now: utc(2026, 10, 10), staleDays: 5 }), true)
})

check('a fresh success is verified; a stale success is 数据过期, not verified', () => {
  const m = meta({ frequency: 'monthly' })
  assert.equal(deriveStatus(m, bridgeOk, okOutcome({ asOf: '2026年10月份' }), { now: utc(2026, 11, 1) }), 'verified')
  assert.equal(deriveStatus(m, bridgeOk, okOutcome({ asOf: '2025年1月' }), { now: utc(2026, 11, 1) }), 'stale')
})

// ---- formatting: never turn missing into 0 --------------------------------

check('formatCell preserves real 0/false/empty but renders missing as a dash', () => {
  assert.equal(formatCell(null), '—')
  assert.equal(formatCell(undefined), '—')
  assert.equal(formatCell(0), '0', '0 is a real value, not missing')
  assert.equal(formatCell(false), 'false')
  assert.equal(formatCell(''), '')
  assert.equal(formatCell(0.7), '0.7')
  assert.equal(formatCell(NaN), '—', 'NaN is missing, not 0')
  assert.equal(formatCell(Number.POSITIVE_INFINITY), '—')
})

check('firstRowPreview keeps the first 3 fields and dashes missing values', () => {
  const preview = firstRowPreview({ 月份: '2026年10月份', 累计: 0, 缺口: null, 多余: 5 }, 3)
  assert.deepEqual(preview, [
    { key: '月份', value: '2026年10月份' },
    { key: '累计', value: '0' },
    { key: '缺口', value: '—' },
  ])
  assert.deepEqual(firstRowPreview(null), [])
  assert.deepEqual(firstRowPreview(undefined), [])
})

check('outcomeFromResult keeps missing rowCount as null, never 0', () => {
  const success = outcomeFromResult({ ok: true, dataset: 'X', asOf: '2026-11-17', rows: [{ a: 1, b: null }], rowCount: 1 } as never, 33)
  assert.equal(success.ok, true)
  assert.equal(success.rowCount, 1)
  assert.equal(success.asOf, '2026-11-17')
  assert.deepEqual(success.firstRow, { a: 1, b: null })
  assert.equal(success.elapsedMs, 33)

  const noCount = outcomeFromResult({ ok: true, dataset: 'X', asOf: null } as never, 5)
  assert.equal(noCount.rowCount, null, 'unknown rowCount must stay null, not 0')
  assert.equal(noCount.firstRow, null)

  const empty = outcomeFromResult({ ok: true, dataset: 'X', rows: [], rowCount: 0 } as never)
  assert.equal(empty.rowCount, 0, 'a genuinely empty table is 0, distinguishable from unknown')

  const failure = outcomeFromResult({ ok: false, dataset: 'X', error: 'boom' } as never, 10)
  assert.equal(failure.ok, false)
  assert.equal(failure.rowCount, null)
  assert.equal(failure.firstRow, null)
  assert.equal(failure.error, 'boom')

  const noError = outcomeFromResult({ ok: false, dataset: 'X' } as never)
  assert.match(noError.error!, /未返回有效结果/)
})

check('formatting helpers stay deterministic', () => {
  assert.equal(formatDuration(500), '500 ms')
  assert.equal(formatDuration(1500), '1.50 s')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatLatency(120), '120 ms')
  assert.equal(formatLatency(undefined), '—')
  assert.equal(formatAsOf(null), '—')
  assert.equal(formatAsOf('2026年10月份'), '2026年10月份')
  assert.equal(frequencyLabel('monthly'), '月度')
  assert.equal(frequencyLabel('DAILY'), '日频')
  assert.equal(frequencyLabel(null), '—')
})

// ---- bridge view / grouping / query --------------------------------------

check('bridgeView distinguishes connected / down / unknown with detail', () => {
  const ok = bridgeView(bridgeOk)
  assert.equal(ok.label, '已连接')
  assert.equal(ok.tone, 'success')
  assert.match(ok.detail, /120 ms/)
  assert.match(ok.detail, /2026年10月份/)

  const down = bridgeView(bridgeDown)
  assert.equal(down.label, '不可用')
  assert.equal(down.tone, 'danger')
  assert.match(down.detail, /python 未安装/)

  const downNoError = bridgeView({ ok: false, latencyMs: 12 })
  assert.match(downNoError.detail, /未返回原因/)

  const unknown = bridgeView(undefined)
  assert.equal(unknown.label, '未检测')
  assert.equal(unknown.tone, 'neutral')
})

check('groupByProvider groups by provider label in first-appearance order', () => {
  assert.equal(providerLabel('akshare'), 'AKShare')
  assert.equal(providerLabel('BaoStock'), 'BaoStock')
  assert.equal(providerLabel(null), '未接入（无可用来源）')
  assert.equal(providerLabel('  '), '未接入（无可用来源）')
  const items = [{ provider: 'akshare', id: 1 }, { provider: null, id: 2 }, { provider: 'akshare', id: 3 }]
  const groups = groupByProvider(items)
  assert.deepEqual(groups.map(group => [group.label, group.items.length]), [['AKShare', 2], ['未接入（无可用来源）', 1]])
  assert.deepEqual(groups[0]!.items.map(item => item.id), [1, 3])
})

check('buildDatasetQuery encodes the id and requests limit=1', () => {
  assert.equal(buildDatasetQuery('CN_MACRO_CPI', 1), '/cn-dataset?dataset=CN_MACRO_CPI&limit=1')
  assert.equal(buildDatasetQuery('A B', 1), '/cn-dataset?dataset=A%20B&limit=1')
  assert.match(buildDatasetQuery('CN_MACRO_CPI'), /limit=1$/)
})

// ---- static contracts on the panel + scoped styles ------------------------

const [view, modelSource] = await Promise.all([
  readFile(new URL('../src/client/cn-datasets-panel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/cn-datasets-model.ts', import.meta.url), 'utf8'),
])

check('static: panel exports the documented props and reads both endpoints', () => {
  assert.match(view, /export interface CnDatasetsPanelProps \{[\s\S]*?get: ReadApi[\s\S]*?active\?: boolean[\s\S]*?\}/)
  assert.match(view, /export function CnDatasetsPanel\(\{ get, active \}: CnDatasetsPanelProps\)/)
  assert.match(view, /get<CnDatasetsResponse>\('\/cn-datasets'\)/)
  assert.match(view, /get<CnDatasetResult>\(buildDatasetQuery\(dataset, 1\)\)/)
  assert.match(view, /import \{[\s\S]*?cnDatasetsCss[\s\S]*?\} from '\.\/cn-datasets-model\.js'/)
})

check('static: unavailable datasets disable the test button and are never auto-fetched', () => {
  assert.match(view, /const available = meta\.available !== false/)
  assert.match(view, /: <><Button variant="secondary" disabled title="不可用数据集不发起抓取">测试<\/Button>/)
  assert.match(view, /不可用，已禁用/)
  assert.match(view, /onClick=\{\(\) => void runTest\(meta\.dataset\)\}/)
  // No fire-and-forget effect that tests datasets automatically: the only effect loads metadata.
  const effect = view.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[load, active\]\)/)?.[0] ?? ''
  assert.ok(effect.includes('void load()'))
  assert.doesNotMatch(effect, /runTest/)
  assert.equal([...view.matchAll(/\brunTest\(/g)].length, 1, 'runTest is only triggered by the click handler')
})

check('static: outcome shows ok/asOf/rowCount/first-3 fields/elapsed and real error; failure is role=alert', () => {
  assert.match(view, /ok：\{String\(outcome\.ok\)\}/)
  assert.match(view, /asOf：\{formatAsOf\(outcome\.asOf\)\}/)
  assert.match(view, /rowCount：\{outcome\.rowCount == null \? '—' : String\(outcome\.rowCount\)\}/)
  assert.match(view, /耗时：\{formatDuration\(outcome\.elapsedMs\)\}/)
  assert.match(view, /firstRowPreview\(outcome\.firstRow, 3\)/)
  assert.match(view, /role=\{outcome\.ok \? 'status' : 'alert'\}/)
  assert.match(view, /错误：\{outcome\.error\}/)
  assert.match(view, /outcomeView\(outcome\)/)
})

check('static: loading, error and empty states are distinct, and no client-side probing', () => {
  assert.match(view, /正在读取数据集目录…/)
  assert.match(view, /data-tone="error" role="alert"/)
  assert.match(view, /暂无数据集/)
  assert.match(view, /role="status" aria-label="桥接健康"/)
  assert.doesNotMatch(view, /\bfetch\s*\(|apiPost|localStorage|setInterval\(|XMLHttpRequest/)
})

check('static: model exports the pure contract used by the panel', () => {
  for (const name of [
    'DatasetStatus', 'STATUS_LABEL', 'STATUS_TONE', 'statusView', 'deriveStatus', 'statusReason',
    'parseAsOfDate', 'staleLimitDays', 'isStale', 'formatCell', 'firstRowPreview', 'outcomeFromResult',
    'outcomeView', 'bridgeView', 'groupByProvider', 'buildDatasetQuery', 'cnDatasetsCss',
  ]) assert.ok(modelSource.includes(name), `model missing ${name}`)
  assert.match(modelSource, /import type \{ CnDatasetMeta, CnDatasetResult \} from '\.\.\/data\/cn-datasets\.js'/)
  assert.doesNotMatch(modelSource, /from ['"]react['"]|from ['"]node:|from ['"]node:child_process['"]/)
  assert.doesNotMatch(modelSource, /\bfetch\s*\(/)
})

check('static: styles are .fia-root scoped, token-only, single-column <=560px with tabular figures', () => {
  assert.match(cnDatasetsCss, /@container fia-cn-datasets \(max-width:560px\)/)
  assert.match(cnDatasetsCss, /grid-template-columns:minmax\(0,1fr\)/)
  assert.match(cnDatasetsCss, /font-variant-numeric:tabular-nums/)
  assert.doesNotMatch(cnDatasetsCss, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  for (const match of cnDatasetsCss.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
    const selector = match[1]!.trim()
    if (selector.startsWith('@container') || selector.startsWith('@media')) continue
    for (const part of selector.split(',')) {
      assert.ok(part.trim().startsWith('.fia-root .fia-cn-datasets'), `unscoped selector: ${part.trim()}`)
    }
  }
})

console.log(`\ncn-datasets UI: ${checks} pure/static checks passed (no DOM render, no network).`)
