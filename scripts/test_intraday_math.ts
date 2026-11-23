/** Offline regression tests: npx tsx scripts/test_intraday_math.ts */
import assert from 'node:assert/strict'
import { buildIntradayModel, intradaySlotAt, intradayX, type IntradayLikePoint } from '../src/client/intraday-math.js'
let passed = 0
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${name}`); passed++ }
const point = (time: string, price: number | null = 10, avgPrice: number | null = 10, volume: number | null = 100): IntradayLikePoint => ({ time, price, avgPrice, volume })

test('A half-day data leaves the full afternoon blank; x never stretches as data arrives', () => {
  const half = buildIntradayModel([point('2026-11-23 09:30'), point('2026-11-23 11:30')], 10)
  const full = buildIntradayModel([point('2026-11-23 09:30'), point('2026-11-23 11:30'), point('2026-11-23 15:00')], 10)
  assert.equal(half.slots.length, 242)
  assert.equal(half.slots.at(-1)!.time, '2026-11-23 15:00')
  assert.equal(half.last!.index, 120)
  assert.ok(intradayX(half.last!.index, half.slots.length, 0, 1000) < 500)
  assert.equal(intradayX(120, half.slots.length, 0, 1000), intradayX(120, full.slots.length, 0, 1000))
  assert.ok(half.slots.slice(121).every((p) => p.price === null && !p.present))
})
test('A lunch is folded, not plotted as data or bridged by a fake line', () => {
  const m = buildIntradayModel([point('2026-11-23 11:29'), point('2026-11-23 11:30'), point('2026-11-23 12:00', 999), point('2026-11-23 13:00'), point('2026-11-23 13:01')], 10)
  assert.deepEqual(m.priceSegments.map((s) => s.length), [2, 2])
  assert.deepEqual(m.avgSegments.map((s) => s.length), [2, 2])
  assert.equal(m.slots[121]!.time, '2026-11-23 13:00')
  assert.ok(m.max < 11)
})
test('HK uses 09:30–12:00 and 13:00–16:00; incomplete afternoon keeps trailing whitespace', () => {
  const m = buildIntradayModel([point('2026-11-23 12:00'), point('2026-11-23 13:00')], 10, 'hk')
  assert.equal(m.slots.length, 332)
  assert.equal(m.days[0]!.breaks[0], 151)
  assert.equal(m.slots.at(-1)!.time, '2026-11-23 16:00')
  assert.equal(m.priceSegments.length, 2)
})
test('null price/avg and omitted minutes break independently without shifting x', () => {
  const m = buildIntradayModel([
    point('09:30'), point('09:31', null, 10.1), point('09:32', 10.2, null), point('09:34', 10.3, 10.3),
  ], 10)
  assert.deepEqual(m.priceSegments.map((s) => s.map((p) => p.index)), [[0], [2], [4]])
  assert.deepEqual(m.avgSegments.map((s) => s.map((p) => p.index)), [[0, 1], [4]])
  assert.equal(m.slots[3]!.present, false)
  assert.equal(m.slots[1]!.present, true)
})
test('empty and constant prices have finite symmetric padded range and remain centered', () => {
  for (const m of [buildIntradayModel([]), buildIntradayModel([point('09:30'), point('09:31')], 10)]) {
    assert.ok(Number.isFinite(m.min) && Number.isFinite(m.max) && m.max > m.min)
    const center = m.base ?? 1
    assert.ok(Math.abs((m.min + m.max) / 2 - center) < 1e-9)
  }
  const m = buildIntradayModel([point('09:30', 13, 12)], 10)
  assert.ok(m.max > 13 && m.min < 7)
})
test('zero/NaN/Infinity prices and average are invalid; invalid volumes do not poison scale', () => {
  const m = buildIntradayModel([point('09:30', 0, NaN, -1), point('09:31', NaN, Infinity, NaN), point('09:32', 10, 0, Infinity)], 0)
  assert.equal(m.hasPreClose, false)
  assert.equal(m.base, 10)
  assert.equal(m.validPrices, 1)
  assert.equal(m.avgSegments.length, 0)
  assert.equal(m.maxVolume, 1)
  assert.ok(m.slots.every((p) => p.volume === null))
  assert.ok(Number.isFinite(m.min) && Number.isFinite(m.max))
})
test('five dates have equal full-day slots and independent lines with date boundaries', () => {
  const points = [16, 17, 18, 19, 20].flatMap((day) => [point(`2026-11-${day} 09:30`), point(`2026-11-${day} 09:31`)])
  const m = buildIntradayModel(points, 10, 'a', 5)
  assert.equal(m.days.length, 5)
  assert.equal(m.slots.length, 5 * 242)
  assert.deepEqual(m.days.map((d) => d.date), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'])
  assert.deepEqual(m.priceSegments.map((s) => s.length), [2, 2, 2, 2, 2])
  assert.deepEqual(m.days.map((d) => d.start), [0, 242, 484, 726, 968])
  assert.ok(m.slots[243]!.index - m.slots[1]!.index === 242)
})
test('requesting five days never expands one returned morning to five days; no invented dates', () => {
  const m = buildIntradayModel([point('2026-11-23 09:30')], 10, 'a', 5)
  // 源只回 1 天就只画 1 天：不补 4 个空面板，也不编造缺失日期。
  assert.equal(m.days.length, 1)
  assert.deepEqual(m.days.map((d) => d.date), ['2026-11-23'])
  assert.equal(m.slots.length, 242)
  assert.equal(m.validPrices, 1)
})
test('US summer source +08 times use 21:30–04:00, midnight is contiguous not a new trading day', () => {
  const m = buildIntradayModel([point('2026-07-15 21:30'), point('2026-07-15 23:59'), point('2026-07-16 00:00'), point('2026-07-16 04:00')], 10, 'us')
  assert.equal(m.slots.length, 391)
  assert.equal(m.days[0]!.date, '2026-07-15')
  assert.equal(m.slots.at(-1)!.time, '2026-07-16 04:00')
  assert.ok(m.priceSegments.some((s) => s.length === 2 && s[0]!.time.endsWith('23:59') && s[1]!.time.endsWith('00:00')))
})
test('US winter source +08 times use 22:30–05:00, five sessions do not split at midnight', () => {
  const m = buildIntradayModel([point('2026-11-19 22:30'), point('2026-11-20 05:00'), point('2026-11-20 22:30'), point('2026-11-21 05:00')], 10, 'us', 2)
  assert.equal(m.days.length, 2)
  assert.equal(m.slots.length, 782)
  assert.equal(m.slots[0]!.time, '2026-11-19 22:30')
  assert.equal(m.slots[390]!.time, '2026-11-20 05:00')
  assert.equal(m.slots[391]!.time, '2026-11-20 22:30')
  assert.equal(m.priceSegments.length, 4)
})
test('minute volumes follow preceding minute, not final price; gaps/days neutral', () => {
  const m = buildIntradayModel([point('2026-11-19 09:30', 11), point('2026-11-19 09:31', 10), point('2026-11-19 09:32', 11), point('2026-11-19 09:34', 12), point('2026-11-20 09:30', 20)], 10, 'a', 2)
  assert.deepEqual([0, 1, 2, 4, 242].map((i) => m.slots[i]!.direction), ['up', 'down', 'up', 'flat', 'flat'])
})
test('crosshair snaps exact whitespace slots, clamps edges and rejects nonfinite pointers', () => {
  const m = buildIntradayModel([point('09:30')])
  assert.equal(intradaySlotAt(1, m.slots.length), 241)
  assert.equal(intradaySlotAt(-5, m.slots.length), 0)
  assert.equal(intradaySlotAt(5, m.slots.length), 241)
  assert.equal(intradaySlotAt(NaN, m.slots.length), 0)
  assert.equal(m.slots[intradaySlotAt(1, m.slots.length)]!.price, null)
})
test('invalid times, impossible dates and out-of-session data are ignored; input is not mutated', () => {
  const points = [point('bad'), point('2026-02-30 09:30'), point('09:60'), point('09:00', 999), point('09:30')]
  const snapshot = JSON.stringify(points)
  const m = buildIntradayModel(points, 10)
  assert.equal(m.validPrices, 1)
  assert.equal(JSON.stringify(points), snapshot)
})
console.log(`\n${passed} intraday math tests passed (offline).`)
