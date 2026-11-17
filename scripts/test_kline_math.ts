/** K-line math regression tests: marker alignment, viewport reset, aggregation, ranges. */
import assert from 'node:assert/strict'
import {
  aggregateBars, defaultViewport, fitAllViewport, markerBarIndex, priceRange, sanitizeBars, visibleRange, clampViewport, zoomViewport,
} from '../src/client/kline-math.js'

let passed = 0
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`) }

const daily = [
  { date: '2026-11-02', open: 10, high: 10.5, low: 9.9, close: 10.2, volume: 100 }, // 周一
  { date: '2026-11-03', open: 10.2, high: 10.6, low: 10.1, close: 10.4, volume: 120 }, // 周二
  { date: '2026-11-04', open: 10.4, high: 10.8, low: 10.3, close: 10.7, volume: 130 }, // 周三
  { date: '2026-11-05', open: 10.7, high: 11.0, low: 10.6, close: 10.9, volume: 140 }, // 周四
  { date: '2026-11-06', open: 10.9, high: 11.1, low: 10.8, close: 11.0, volume: 150 }, // 周五（该周收口）
  { date: '2026-11-09', open: 11.0, high: 11.2, low: 10.9, close: 11.1, volume: 160 }, // 下周一
  { date: '2026-11-10', open: 11.1, high: 11.3, low: 11.0, close: 11.2, volume: 170 },
]

test('daily markers map to their own bar', () => {
  const agg = aggregateBars(daily, 'day')
  assert.equal(markerBarIndex(agg, '2026-11-04'), 2)
  assert.equal(markerBarIndex(agg, '2026-11-10'), 6)
})

test('weekly markers land on the containing week, not the next one', () => {
  const agg = aggregateBars(daily, 'week')
  assert.equal(agg.length, 2)
  // 周三/周四/周五都属于第一周（10-02 那根，periodEnd=11-08）
  assert.equal(markerBarIndex(agg, '2026-11-04'), 0)
  assert.equal(markerBarIndex(agg, '2026-11-06'), 0)
  assert.equal(markerBarIndex(agg, '2026-11-09'), 1)
})

test('monthly markers land on the containing month', () => {
  const bars = [
    { date: '2026-10-30', open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { date: '2026-11-02', open: 2, high: 2, low: 2, close: 2, volume: 1 },
    { date: '2026-11-27', open: 3, high: 3, low: 3, close: 3, volume: 1 },
  ]
  const agg = aggregateBars(bars, 'month')
  assert.equal(markerBarIndex(agg, '2026-11-15'), 1)
  assert.equal(markerBarIndex(agg, '2026-10-31'), 0)
})

test('out-of-range markers return -1 or the next bar, never a wrong earlier bar', () => {
  const agg = aggregateBars(daily, 'day')
  assert.equal(markerBarIndex(agg, '2026-10-01'), 0) // before data → first bar
  assert.equal(markerBarIndex(agg, '2026-12-01'), -1) // after data
  assert.equal(markerBarIndex(agg, 'bad'), -1)
  assert.equal(markerBarIndex([], '2026-11-01'), -1)
})

test('weekly aggregation keeps open/close/high/low/volume consistent', () => {
  const agg = aggregateBars(daily, 'week')
  assert.equal(agg[0]!.open, 10)
  assert.equal(agg[0]!.close, 11.0)
  assert.equal(agg[0]!.high, 11.1)
  assert.equal(agg[0]!.low, 9.9)
  assert.equal(agg[0]!.volume, 100 + 120 + 130 + 140 + 150)
  assert.equal(agg[0]!.count, 5)
  assert.equal(agg[0]!.unfinished, false, '周五收盘后该周应已收口')
})

test('defaultViewport always shows the latest bars and clamps on small data', () => {
  assert.deepEqual(defaultViewport(500), { count: 80, offset: 0 })
  assert.deepEqual(defaultViewport(12), { count: 12, offset: 0 })
  assert.deepEqual(defaultViewport(0), { count: 1, offset: 0 })
  const vp = defaultViewport(12)
  assert.deepEqual(visibleRange(12, vp), { start: 0, end: 12 })
})

test('viewport clamps stale values when data shrinks (switch symbol)', () => {
  const vp = clampViewport(5, { count: 80, offset: 40 })
  assert.equal(vp.count, 5)
  assert.equal(vp.offset, 0)
  assert.deepEqual(visibleRange(5, { count: 80, offset: 40 }), { start: 0, end: 5 })
})

test('priceRange includes moving averages and pads constant series', () => {
  const bars = sanitizeBars([
    { date: '2026-11-02', open: 10, high: 10.2, low: 9.8, close: 10, volume: 1 },
    { date: '2026-11-03', open: 10, high: 10.2, low: 9.8, close: 10, volume: 1 },
  ])
  const flat = priceRange(bars)
  assert.ok(flat.max > flat.min, '恒定序列也要有呼吸空间，避免除零')
  const withMa = priceRange(bars, [[null, 12]])
  assert.ok(withMa.max >= 12, '均线值必须纳入价格轴范围')
})
test('zoom-out eventually fits ALL history from the earliest bar', () => {
  const total = 500
  let vp = defaultViewport(total) // 80
  // 连续缩小应能到达全览，并且 offset 归零（能看到最早一根）
  for (let i = 0; i < 40 && vp.count < total; i++) vp = zoomViewport(vp, 1 / 1.18, total)
  assert.equal(vp.count, total)
  assert.equal(vp.offset, 0)
  assert.deepEqual(visibleRange(total, vp), { start: 0, end: total })
})

test('zoom-out ignores stale pan offset instead of leaving the earliest bars hidden', () => {
  const total = 200
  // 用户先平移到较早区间（offset 大），再一路缩小
  let vp: { count: number; offset: number } = { count: 60, offset: 140 }
  for (let i = 0; i < 40; i++) vp = zoomViewport(vp, 1 / 1.18, total)
  assert.equal(vp.count, total)
  assert.equal(vp.offset, 0, '缩到全览时必须回到 offset=0，否则看不到最早/最新一段')
  assert.deepEqual(visibleRange(total, vp), { start: 0, end: total })
})

test('fitAllViewport shows every bar and is safe for empty data', () => {
  assert.deepEqual(fitAllViewport(300), { count: 300, offset: 0 })
  assert.deepEqual(fitAllViewport(0), { count: 1, offset: 0 })
})

console.log(`[kline-math] ${passed} groups passed (offline).`)
