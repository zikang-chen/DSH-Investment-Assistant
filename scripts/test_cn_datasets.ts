/** Offline contracts for the CN free-dataset bridge/adapter. No live market network. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  normalizeCnDataset, fetchCnDataset, listCnDatasets, checkCnBridge, clearCnDatasetCache, compareCnSeries,
} from '../src/data/cn-datasets.js'

let passed = 0
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`) }
const testAsync = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`) }

const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fin_cn_datasets.py')

test('normalize keeps success shape and never coerces missing to zero', () => {
  const r = normalizeCnDataset({
    ok: true, dataset: 'CN_MACRO_CPI', provider: 'akshare', source: '东方财富-中国CPI',
    source_url: 'https://data.eastmoney.com/cjsj/cpi.html', fetched_at: '2026-11-17T06:00:00+00:00',
    as_of: '2026年10月份', unit: '指数/%', period_field: '月份',
    fields: ['月份', '全国-同比增长', '缺口'], rows: [{ 月份: '2026年10月份', '全国-同比增长': 0.7, 缺口: null }],
    row_count: 1, truncated: false, warnings: [],
  })
  assert.equal(r.ok, true)
  assert.equal(r.asOf, '2026年10月份')
  assert.equal(r.rows[0]['全国-同比增长'], 0.7)
  assert.equal(r.rows[0]['缺口'], null, '缺失必须保持 null，不能变成 0')
  assert.equal(r.unit, '指数/%')
  assert.equal(r.sourceUrl.includes('eastmoney'), true)
})

test('normalize surfaces failures instead of empty success', () => {
  const r = normalizeCnDataset({ ok: false, dataset: 'CN_CREDIT_TSFIN_STOCK', error: '该数据集尚未接入：仅有增量' })
  assert.equal(r.ok, false)
  assert.match(r.error, /尚未接入/)
  assert.equal(r.rows, undefined)
})

test('normalize tolerates missing optional fields without inventing values', () => {
  const r = normalizeCnDataset({ ok: true, dataset: 'X', rows: [] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.rows, [])
  assert.equal(r.asOf, null)
  assert.equal(r.rowCount, 0)
})

await testAsync('fetch passes params/limit and caches success', async () => {
  clearCnDatasetCache()
  const calls: string[][] = []
  const runner = async (args: string[]) => {
    calls.push(args)
    return JSON.stringify({ ok: true, dataset: 'CN_A_SHARE_DAILY', source_url: 'u', fetched_at: 't', as_of: '2026-11-17', unit: '元', fields: ['日期', '收盘'], rows: [{ 日期: '2026-11-17', 收盘: 1460 }], row_count: 1 })
  }
  const a = await fetchCnDataset('CN_A_SHARE_DAILY', { params: { symbol: '600519' }, limit: 5, runner, now: () => 1000 })
  assert.equal(a.ok, true)
  assert.deepEqual(calls[0], ['--dataset', 'CN_A_SHARE_DAILY', '--params', '{"symbol":"600519"}', '--limit', '5'])
  const b = await fetchCnDataset('CN_A_SHARE_DAILY', { params: { symbol: '600519' }, limit: 5, runner, now: () => 2000 })
  assert.equal(b.cached, true)
  assert.equal(calls.length, 1, 'TTL 内应命中缓存')
})

await testAsync('fetch failure is not cached and carries the real error', async () => {
  clearCnDatasetCache()
  let n = 0
  const runner = async () => { n += 1; return JSON.stringify({ ok: false, dataset: 'CN_MACRO_CPI', error: 'ReadTimeout' }) }
  const first = await fetchCnDataset('CN_MACRO_CPI', { runner, now: () => 10 })
  assert.equal(first.ok, false)
  assert.match(first.error, /ReadTimeout/)
  await fetchCnDataset('CN_MACRO_CPI', { runner, now: () => 20 })
  assert.equal(n, 2, '失败不缓存，下一次重试')
})

await testAsync('runner error becomes structured failure, not empty data', async () => {
  clearCnDatasetCache()
  const runner = async () => { throw new Error('python not found') }
  const r = await fetchCnDataset('CN_MACRO_CPI', { runner })
  assert.equal(r.ok, false)
  assert.match(r.error, /python not found/)
})

await testAsync('list and health use the same bridge contract', async () => {
  clearCnDatasetCache()
  const listRunner = async () => JSON.stringify({ ok: true, datasets: [{ dataset: 'CN_MACRO_CPI', provider: 'akshare', available: true, source: 's', source_url: 'u', unit: 'u', frequency: 'monthly', period_field: '月份', params: [] }] })
  const list = await listCnDatasets({ runner: listRunner, force: true })
  assert.equal(list[0].dataset, 'CN_MACRO_CPI')
  assert.equal(list[0].periodField, '月份')
  const okRunner = async () => JSON.stringify({ ok: true, dataset: 'CN_MACRO_CPI', as_of: '2026年10月份', rows: [], fetched_at: 't' })
  const health = await checkCnBridge({ runner: okRunner })
  assert.equal(health.ok, true)
  assert.equal(health.asOf, '2026年10月份')
  assert.equal(typeof health.latencyMs, 'number')
  const badRunner = async () => JSON.stringify({ ok: false, dataset: 'CN_MACRO_CPI', error: 'boom' })
  const bad = await checkCnBridge({ runner: badRunner })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /boom/)
})

// ---- conflict detection between two providers ----
test('compareCnSeries flags mismatches instead of hiding them', () => {
  const left = { provider: 'akshare', periodField: '月份', valueField: '同比', rows: [{ 月份: '2026-10', 同比: 0.7 }, { 月份: '2026-09', 同比: 0.4 }] }
  const right = { provider: 'eastmoney', periodField: '月份', valueField: '同比', rows: [{ 月份: '2026-10', 同比: 0.7 }, { 月份: '2026-09', 同比: 0.9 }] }
  const diff = compareCnSeries(left, right, 0.05)
  assert.equal(diff.find(d => d.period === '2026-10').status, 'match')
  const mism = diff.find(d => d.period === '2026-09')
  assert.equal(mism.status, 'mismatch')
  assert.equal(mism.difference, -0.5)
  const missing = compareCnSeries(left, { provider: 'x', periodField: '月份', valueField: '同比', rows: [] }, 0.05)
  assert.equal(missing.every(d => d.status === 'missing'), true, '缺一方数据标记 missing，不当 0 处理')
})

// ---- real bridge registry (no network; --list imports akshare lazily only) ----
test('bridge --list exposes the required CN datasets and marks unavailable ones', () => {
  let out: string
  const py = process.env.DSH_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3')
  try {
    out = execFileSync(py, [bridgePath, '--list'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  } catch (err) {
    console.log(`SKIP bridge --list (python unavailable or failed): ${err.message?.slice(0, 120)}`)
    return
  }
  const parsed = JSON.parse(out.trim().split('\n').pop())
  assert.equal(parsed.ok, true)
  const ids = new Set(parsed.datasets.map(d => d.dataset))
  for (const required of ['CN_MACRO_GDP', 'CN_MACRO_CPI', 'CN_MACRO_PPI', 'CN_MACRO_PMI', 'CN_MONEY_M1_M2',
    'CN_CREDIT_TSFIN_FLOW', 'CN_FISCAL_REVENUE', 'CN_INDUSTRIAL_PRODUCTION', 'CN_IMPORT_EXPORT',
    'CN_REAL_ESTATE', 'CN_ELECTRICITY_CONSUMPTION', 'CN_A_SHARE_DAILY', 'CN_A_SHARE_FINANCIALS', 'CN_ETF_DAILY',
    'CN_FUND_NAV', 'CN_INDEX_DAILY', 'CN_BOND_YIELD', 'CN_CORPORATE_ANNOUNCEMENTS', 'CN_INDUSTRY_SECTOR']) {
    assert.ok(ids.has(required), `缺少数据集 ${required}`)
  }
  const unavailable = parsed.datasets.filter(d => d.available === false)
  assert.ok(unavailable.length >= 5, '未实现的数据集必须显式标记 available=false')
  for (const d of unavailable) assert.ok(d.reason, `${d.dataset} 必须写明不可用原因`)
})
console.log(`[cn-datasets] ${passed} groups passed (offline fixtures + bridge registry; no market network).`)
