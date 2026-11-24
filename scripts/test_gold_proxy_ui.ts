import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isGoldProxy } from '../src/client/gold-proxy-chart.js'
import { aggregateBars, formatVolume, sanitizeBars, volumeRange } from '../src/client/kline-math.js'
import type { GlobalKlineResult } from '../src/data/global-quotes.js'

let passed = 0
function check(name: string, run: () => void) { run(); passed++; console.log('PASS', name) }
const proxy: GlobalKlineResult = {
  ok: true, secid: '101.GC00Y', source: 'sina-global-futures',
  instrument: { name: '纽约黄金CFD', symbol: 'GC', kind: 'cfd', unit: 'USD/troy oz', proxy: true, requestedSecid: '101.GC00Y' },
  bars: [{ date: '2026-11-23', open: 3600, high: 3620, low: 3590, close: 3610, volume: null }],
}
check('只有独立标明来源和CFD口径的结果才可进入参考图', () => {
  assert.equal(isGoldProxy(proxy), true)
  assert.equal(isGoldProxy({ ...proxy, ok: false }), false)
  assert.equal(isGoldProxy({ ...proxy, source: 'eastmoney-push2' }), false)
  assert.equal(isGoldProxy({ ...proxy, instrument: undefined }), false)
  assert.equal(isGoldProxy({ ...proxy, instrument: { ...proxy.instrument!, requestedSecid: '100.SPX' } }), false)
  assert.equal(isGoldProxy({ ...proxy, bars: [] }), false)
})
check('K线保留缺量null，悬浮提示不再显示成零成交', () => {
  const rows = sanitizeBars(proxy.bars)
  assert.equal(rows[0]?.volume, null)
  assert.equal(formatVolume(rows[0]!.volume), '—')
  assert.equal(formatVolume(0), '0')
  assert.deepEqual(volumeRange(rows), { min: 0, max: 1 })
  assert.equal(aggregateBars([...rows, { ...rows[0]!, date: '2026-11-24', volume: 100 }], 'week')[0]?.volume, null)
})
const chart = await readFile(new URL('../src/client/gold-proxy-chart.tsx', import.meta.url), 'utf8')
const market = await readFile(new URL('../src/client/market-chart.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../src/server-routes.ts', import.meta.url), 'utf8')
check('代理图默认关闭、显式点击后才请求、切换或超时取消', () => {
  assert.match(chart, /useState\(false\)/)
  assert.match(chart, /if \(!open\) return/)
  assert.match(chart, /\/global\/gold-cfd\?limit=500/)
  assert.match(chart, /非COMEX期货/)
  assert.match(chart, /controller\.abort/)
  assert.match(chart, /20_000/)
  assert.match(market, /error && target\.secid === '101\.GC00Y' && !bars\.length/)
  assert.match(server, /sub === '\/global\/gold-cfd'/)
  assert.match(server, /fetchSinaFuturesKline\('101\.GC00Y', clampGlobalKlineBars/)
  assert.match(server, /allowProxyFallback: url\.searchParams\.get\('allow_proxy'\) === 'true'/)
})
console.log(`[gold-proxy-ui] ${passed} offline groups passed (no browser interaction claimed)`)
