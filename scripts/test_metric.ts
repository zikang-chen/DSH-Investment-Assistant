/**
 * 数值元信息与市场工具（横切约定）离线测试。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EARLY_CLOSE_DATES, conflictOf, isEarlyClose, metric, sessionOf, staleness } from '../src/data/metric.js'
import { parseTreasuryCurve, pickTerms, treasuryDate } from '../src/data/us-real-yields.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log('PASS', name) }

const DAY = 86_400_000
const NOW = Date.parse('2026-11-24T05:00:00Z')

check('新鲜度：按节奏判断，缺 asOf 一律 unknown（不用抓取时间顶替）', () => {
  assert.equal(staleness(null, 'daily', NOW), 'unknown')
  assert.equal(staleness('2026-11-23', 'daily', NOW), 'fresh')
  assert.equal(staleness(new Date(NOW - 5 * DAY).toISOString().slice(0, 10), 'daily', NOW), 't1')
  assert.equal(staleness(new Date(NOW - 30 * DAY).toISOString().slice(0, 10), 'daily', NOW), 'stale')
  // T+1 净值：即使当天拿到，也只是 t1
  assert.equal(staleness('2026-11-23', 't1', NOW), 't1')
  // 同一天的分时价才算 fresh；隔了一天就是 t1
  assert.equal(staleness('2026-11-24T04:00:00Z', 'intraday', NOW), 'fresh')
  assert.equal(staleness('2026-11-23', 'intraday', NOW), 't1')
  assert.equal(staleness('2026-06-24', 'daily', NOW), 'stale', '半年前的数据必须判 stale')
})

check('冲突判定：只在两边都有数时比较，容差内不算冲突', () => {
  assert.deepEqual(conflictOf(22.56, 4.5, 1), { conflict: true, diff: 18.06 })
  assert.equal(conflictOf(4.8, 4.5, 1).conflict, false)
  assert.equal(conflictOf(null, 4.5, 1).conflict, false, '缺一边不制造冲突')
  assert.equal(conflictOf(Number.NaN, 4.5, 1).conflict, false)
})

check('metric：value + 单位/时点/窗口/来源/新鲜度/冲突', () => {
  const m = metric(73.9, { unit: '%', asOf: '2026-11-24', window: '5y', source: '东财', stale: 'fresh', conflict: false })
  assert.equal(m.value, 73.9)
  assert.equal(m.unit, '%')
  assert.equal(m.window, '5y')
  assert.equal(m.conflict, false)
  // 缺失保持 null，不补 0
  assert.equal(metric(null, { unit: '%', asOf: null, source: 'x', stale: 'unknown', conflict: false }).value, null)
})

check('交易时段：A 股午休/收盘，周末休市；未把工作日休市冒充 holiday', () => {
  const am = sessionOf('a', new Date('2026-11-24T02:00:00Z')) // 北京 10:00
  assert.equal(am.phase, 'am')
  assert.equal(am.fullSession, true)
  const lunch = sessionOf('a', new Date('2026-11-24T04:00:00Z')) // 北京 12:00
  assert.equal(lunch.phase, 'lunch')
  assert.equal(lunch.fullSession, false)
  const close = sessionOf('a', new Date('2026-11-24T08:00:00Z')) // 北京 16:00
  assert.equal(close.phase, 'closed')
  const weekend = sessionOf('a', new Date('2026-11-28T02:00:00Z')) // 周六
  assert.equal(weekend.phase, 'closed')
  assert.match(weekend.note, /周末/)
  assert.match(sessionOf('a', new Date('2026-11-24T02:00:00Z')).note, /未接节假日日历|竞价|开盘|午间|收盘|常规/)
})

check('提前收市只对登记过的日期成立', () => {
  assert.equal(isEarlyClose('us', EARLY_CLOSE_DATES.us[0]!), true)
  assert.equal(isEarlyClose('us', '2026-11-24'), false)
  assert.equal(isEarlyClose('a', '2026-11-24'), false)
})

check('财政部 CSV：日期/表头/缺失值', () => {
  assert.equal(treasuryDate('11/23/2026'), '2026-11-23')
  assert.equal(treasuryDate('2026-11-23'), null)
  const csv = 'Date,"5 YR","10 YR","30 YR"\n11/23/2026,2.59,2.79,3.17\n11/20/2026,2.53,2.77,3.17\n'
  const curve = parseTreasuryCurve(csv)!
  assert.equal(curve.asOf, '2026-11-23')
  assert.equal(curve.rates['10 YR'], 2.79)
  assert.deepEqual(pickTerms(curve.rates, ['10 YR', '30 YR']), { '10 YR': 2.79, '30 YR': 3.17 })
  assert.equal(parseTreasuryCurve('not,a,curve'), null)
  // 全是 N/A 的一行不算有效数据：返回 null，而不是把 N/A 当 0
  assert.equal(parseTreasuryCurve('Date,"10 YR"\n11/23/2026,N/A\n'), null)
  const partial = parseTreasuryCurve('Date,"5 YR","10 YR"\n11/23/2026,2.59,N/A\n')!
  assert.equal(partial.rates['10 YR'], undefined, 'N/A 不能当 0')
  assert.equal(partial.rates['5 YR'], 2.59)
})

check('接线：三个新工具已注册，且不写任何持久状态', () => {
  const register = readFileSync('src/tools/register.ts', 'utf8')
  assert.match(register, /name: 'get_us_real_yields'/)
  assert.match(register, /registerMetricTools\(ctx\)/)
  const metrics = readFileSync('src/tools/metrics.ts', 'utf8')
  assert.match(metrics, /name: 'get_market_session'/)
  assert.match(metrics, /name: 'check_etf_premium'/)
  assert.doesNotMatch(metrics, /writeFile|appendEvent|upsert_holding/)
  const historyTools = readFileSync('src/history/tools.ts', 'utf8')
  assert.match(historyTools, /name: 'get_history_coverage'/)
  // 全球快照每行带元信息
  assert.match(register, /meta: \{ unit: '指数点\/合约价（随品种）'/)
})

console.log(`\n[metric] ${checks} 组通过（离线；未验证上游可达性）`)
