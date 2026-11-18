import assert from 'node:assert/strict'
import { runStrategyExperiment, reviewStrategyEnvironment, type StrategyExperimentInput, type StrategyExperimentSuccess } from '../src/strategy/lab.js'
import type { KlineBar } from '../src/types.js'

// Offline synthetic fixtures only: no claims that these bars are actual market history.
function fixture(count = 720): KlineBar[] {
  const bars: KlineBar[] = []
  const date = new Date('2022-01-03T00:00:00Z')
  for (let i = 0; bars.length < count; i++) {
    date.setUTCDate(date.getUTCDate() + (i === 0 ? 0 : 1))
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue
    const close = 20 + bars.length * 0.008 + Math.sin(bars.length / 14) * 1.2
    bars.push({ date: date.toISOString().slice(0, 10), open: close * 0.999, high: close * 1.01, low: close * 0.99, close, volume: 100_000 })
  }
  return bars
}
const input: StrategyExperimentInput = { code: '600519', currency: 'CNY', adjustment: 'raw', bars: fixture(), source: 'offline synthetic fixture', fetchedAt: '2026-11-17T12:00:00Z' }
let tests = 0
function test(name: string, fn: () => void) { fn(); tests++; console.log(`PASS ${name}`) }
function fail(patch: Partial<StrategyExperimentInput>, reason: string) {
  const result = runStrategyExperiment({ ...input, ...patch })
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.reason, reason); assert.ok(result.gaps.length) }
}
function mutated(fn: (bars: KlineBar[]) => void) { const bars = structuredClone(input.bars); fn(bars); return bars }
const valid = runStrategyExperiment(input)
if (!valid.ok) throw new Error(valid.reason)
assert.equal(valid.ok, true)

test('exact three frozen visible DSL specs and real A-share cost example', () => {
  assert.equal(valid.templates.length, 3)
  assert.deepEqual(valid.templates.map((t) => t.spec.signal), [
    { kind: 'momentum', lookback: 1, thresholdPct: -100 },
    { kind: 'ma_cross', fast: 20, slow: 60 },
    { kind: 'momentum', lookback: 20, thresholdPct: 0 },
  ])
  assert.deepEqual(valid.configuration.trading, { lotSize: 100, feeRateBps: 3, minFee: 5, stampDutyBps: 5, slippageBps: 5, limitPct: 10, tPlus1: true })
  assert.equal(valid.configuration.allocation, 'equal_weight')
})
test('deterministic entire JSON/hash and immutable input', () => {
  const before = JSON.stringify(input)
  assert.equal(JSON.stringify(runStrategyExperiment(input)), JSON.stringify(valid))
  assert.equal(JSON.stringify(input), before)
  assert.match(valid.hashes.experiment, /^[0-9a-f]{32}$/)
  const changed = runStrategyExperiment({ ...input, bars: mutated((b) => { b[100]!.volume++ }) })
  assert.ok(changed.ok)
  if (changed.ok) assert.notEqual(changed.hashes.data, valid.hashes.data)
})
test('only raw/none accepted; adjusted and unknown rejected', () => {
  for (const adjustment of ['qfq', 'hfq', 'unknown', 'forward', 'reconstructed', '', 'RAW']) fail({ adjustment }, 'adjustment_unsupported')
  assert.equal(runStrategyExperiment({ ...input, adjustment: 'none' }).ok, true)
})
test('strict supported identity and currency', () => {
  for (const code of ['300750', '688001', '510300', 'AAPL', '00700', 'ST600519', '600519,000001', 'sh600519']) fail({ code }, 'unsupported')
  fail({ currency: 'USD' }, 'unsupported')
})
test('minimum bars enforced after range selection', () => {
  fail({ bars: fixture(179) }, 'insufficient_bars')
  fail({ from: input.bars[600]!.date }, 'insufficient_bars')
  assert.equal(runStrategyExperiment({ ...input, bars: fixture(180) }).ok, true)
})
test('real dates, duplicates and order rejected without silent sorting', () => {
  fail({ bars: mutated((b) => { b[0]!.date = '2022-02-30' }) }, 'invalid_date')
  fail({ bars: mutated((b) => { b[2]!.date = b[1]!.date }) }, 'duplicate_date')
  fail({ bars: mutated((b) => { [b[1], b[2]] = [b[2]!, b[1]!] }) }, 'invalid_order')
  fail({ from: '2026-02-29' }, 'invalid_range')
  fail({ from: '2025-01-01', to: '2024-01-01' }, 'invalid_range')
})
test('positive coherent finite OHLC and known nonnegative volume', () => {
  for (const value of [0, -1, NaN, Infinity]) fail({ bars: mutated((b) => { b[1]!.close = value }) }, 'invalid_ohlc')
  fail({ bars: mutated((b) => { b[1]!.high = 1 }) }, 'invalid_ohlc')
  for (const value of [-1, NaN, Infinity]) fail({ bars: mutated((b) => { b[1]!.volume = value }) }, 'invalid_volume')
  fail({ bars: mutated((b) => { b[1]!.volumeMissing = true }) }, 'invalid_volume')
  assert.equal(runStrategyExperiment({ ...input, bars: mutated((b) => { b[1]!.volume = 0 }) }).ok, true)
})
test('provenance and initial capital validated', () => {
  fail({ source: '' }, 'invalid_provenance')
  for (const fetchedAt of ['bad', '2026-11-17', '2026-02-30T12:00:00Z', '2026-11-17T24:00:00Z']) fail({ fetchedAt }, 'invalid_provenance')
  for (const initialCash of [0, -1, NaN, Infinity]) fail({ initialCash }, 'invalid_cash')
})
test('bounded equity retains last point; full metrics and doubled sensitivity', () => {
  for (const t of valid.templates) {
    for (const r of [t.result, t.train, t.holdout]) assert.ok(r.equity.length <= 200)
    assert.equal(t.result.equity.at(-1)!.date, input.bars.at(-1)!.date)
    assert.equal(t.result.equity.at(-1)!.total, t.result.metrics.finalEquity)
    assert.equal(t.result.metrics.sampleDays, input.bars.length)
    assert.equal(t.holdout.equity[0]!.total, input.initialCash ?? 100_000)
    assert.equal(t.costSensitivity.trading.minFee, 10)
    assert.equal(t.costSensitivity.trading.feeRateBps, 6)
    assert.equal(t.costSensitivity.trading.stampDutyBps, 10)
    assert.equal(t.costSensitivity.trading.slippageBps, 10)
    assert.equal(t.costSensitivity.trading.limitPct, 10)
    assert.equal(t.costSensitivity.holdoutMetrics.sampleDays, valid.boundary.testBars)
  }
  assert.equal(valid.writesLedger, false)
  assert.equal(valid.executesTrades, false)
  assert.equal(valid.autoChange, false)
})
test('no lookahead: later mutations leave earlier trades, equity and training unchanged', () => {
  const boundaryIndex = Math.floor(input.bars.length * 0.7)
  const altered = runStrategyExperiment({ ...input, bars: mutated((bars) => {
    for (let i = boundaryIndex + 20; i < bars.length; i++) {
      for (const field of ['open', 'high', 'low', 'close'] as const) bars[i]![field] *= 1.7
    }
  }) })
  assert.ok(altered.ok)
  if (!altered.ok) return
  const cutoff = input.bars[boundaryIndex + 20]!.date
  for (let i = 0; i < valid.templates.length; i++) {
    const a: StrategyExperimentSuccess['templates'][number] = valid.templates[i]!
    const b: StrategyExperimentSuccess['templates'][number] = altered.templates[i]!
    assert.deepEqual(a.train.metrics, b.train.metrics)
    assert.deepEqual(a.result.trades.filter((t) => t.date < cutoff), b.result.trades.filter((t) => t.date < cutoff))
    assert.deepEqual(a.result.equity.filter((t) => t.date < cutoff), b.result.equity.filter((t) => t.date < cutoff))
    for (const r of [a.result, a.holdout]) for (const trade of r.trades) assert.ok(trade.signalDate < trade.date)
    assert.ok(a.holdout.trades.every((t) => t.signalDate >= valid.boundary.testStart))
  }
})
const signals = [
  { topic: '需求', claim: '合成支持证据', source: 'fixture', asOf: '2026-11-01', direction: 'support' as const },
  { topic: '风险', claim: '合成风险证据', source: 'fixture', asOf: '2026-10-18', direction: 'risk' as const },
]
test('environment is immutable review only, never automatic rule changes', () => {
  const before = JSON.stringify(signals)
  const review = reviewStrategyEnvironment(signals, '2026-11-17')
  assert.equal(review.ok, true)
  assert.equal(review.observations[1]!.ageDays, 30)
  assert.equal(review.recommendation, 'REVIEW_ONLY')
  assert.equal(review.autoChange, false)
  assert.equal(review.executesTrades, false)
  assert.equal(JSON.stringify(signals), before)
  assert.equal(JSON.stringify(runStrategyExperiment(input)), JSON.stringify(valid))
})
test('environment rejects stale/future/impossible/missing support or risk', () => {
  for (const asOf of ['2026-10-17', '2026-11-18', '2026-02-30', 'nonsense']) {
    const review = reviewStrategyEnvironment([{ ...signals[0]!, asOf }, signals[1]!], '2026-11-17')
    assert.equal(review.ok, false)
    assert.equal(review.observations.length, 1)
  }
  assert.equal(reviewStrategyEnvironment([], '2026-11-17').gaps.length, 2)
  assert.equal(reviewStrategyEnvironment(signals, '2026-02-30').ok, false)
  assert.equal(reviewStrategyEnvironment([signals[0]!], '2026-11-17').ok, false)
  assert.equal(reviewStrategyEnvironment([{ ...signals[0]!, source: '' }, signals[1]!], '2026-11-17').ok, false)
})
console.log(`Strategy lab: ${tests} offline tests passed`)
