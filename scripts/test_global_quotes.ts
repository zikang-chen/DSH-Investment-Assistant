/** Offline contracts for global quotes/K-line and cross-asset snapshot wiring. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clampGlobalKlineBars, globalKlineUrl, globalQuoteTime, globalQuoteUrl,
  isValidSecid, normalizeSecid, parseGlobalKline, parseGlobalQuote,
  GLOBAL_KLINE_MAX_BARS, GLOBAL_KLINE_DEFAULT_BARS,
} from '../src/data/global-quotes.js'
import { identityFromMatch, isGlobalSecurity } from '../src/client/security-model.js'

let passed = 0
const test = (name: string, run: () => void) => { run(); passed++; console.log(`PASS ${name}`) }

test('secid validation rejects malformed values and accepts real ones', () => {
  for (const bad of ['', 'SPX', '100.', '.SPX', 'ab.SPX', '100.SPX;DROP', null, undefined, 42]) assert.equal(normalizeSecid(bad as never), null)
  for (const good of ['100.SPX', '105.NVDA', '101.GC00Y', '176.7203', '155.TYT']) {
    assert.equal(isValidSecid(good), true)
    assert.equal(normalizeSecid(good), good)
  }
  assert.equal(normalizeSecid(' 105.NVDA '), '105.NVDA')
})

test('quote parser keeps numbers as-is, null for missing, rejects empty data', () => {
  const ok = parseGlobalQuote('105.NVDA', { data: { f43: 123.45, f58: '英伟达', f169: 1.2, f170: 0.98, f86: 1794891619, f60: 122.25 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.quote!.price, 123.45)
  assert.equal(ok.quote!.changePct, 0.98)
  assert.equal(ok.quote!.asOf, new Date(1794891619 * 1000).toISOString())
  const missing = parseGlobalQuote('101.GC00Y', { data: { f43: 3883.5, f58: 'COMEX黄金' } })
  assert.equal(missing.ok, true)
  assert.equal(missing.quote!.changePct, null)
  assert.equal(missing.quote!.change, null)
  assert.equal(parseGlobalQuote('100.SPX', { data: null }).ok, false)
  assert.equal(parseGlobalQuote('100.SPX', { data: { f58: 'x' } }).ok, false)
  assert.equal(parseGlobalQuote('bad', { data: { f43: 1 } }).ok, false)
})

test('quote time handles seconds, milliseconds and invalid values', () => {
  assert.equal(globalQuoteTime(0), undefined)
  assert.equal(globalQuoteTime(-5), undefined)
  assert.equal(globalQuoteTime('abc'), undefined)
  assert.equal(globalQuoteTime(undefined), undefined)
  const seconds = globalQuoteTime(1794891619)!
  const millis = globalQuoteTime(1794891619000)!
  assert.equal(seconds, millis)
})

test('kline parser: ordered bars, zero/negative close dropped, missing volume not fabricated as price', () => {
  const payload = { data: { code: 'NVDA', name: '英伟达', klines: [
    '2026-11-13,120.0,121.5,122.0,119.5,1000000,0.0',
    '2026-11-16,121.5,123.8,124.2,121.0,900000,0.0',
    '2026-11-17,123.8,0,124.0,123.0,10,0.0',
    'bad-line,1,2,3',
    '2026-11-18,124,125,126,123,abc,0.0',
  ] } }
  const res = parseGlobalKline('105.NVDA', payload)
  assert.equal(res.ok, true)
  assert.equal(res.bars.length, 3)
  assert.deepEqual(res.bars.map(b => b.date), ['2026-11-13', '2026-11-16', '2026-11-18'])
  assert.equal(res.bars[2]!.volume, 0)
  assert.equal(parseGlobalKline('100.SPX', { data: null }).ok, false)
  assert.equal(parseGlobalKline('100.SPX', { data: { klines: [] } }).bars.length, 0)
})

test('kline limit clamps and URLs include token + secid', () => {
  assert.equal(clampGlobalKlineBars(undefined), GLOBAL_KLINE_DEFAULT_BARS)
  assert.equal(clampGlobalKlineBars(9999), GLOBAL_KLINE_MAX_BARS)
  assert.equal(clampGlobalKlineBars(0), 1)
  assert.match(globalKlineUrl('105.NVDA', 60), /secid=105\.NVDA/)
  assert.match(globalKlineUrl('105.NVDA', 60), /lmt=60/)
  assert.match(globalQuoteUrl('101.GC00Y'), /secid=101\.GC00Y/)
})

test('identity carries secid/market and only overseas markets take the global path', () => {
  const nvda = identityFromMatch({ code: 'NVDA', name: '英伟达', market: '美股', type: 'GP-US', secid: '105.NVDA' })!
  const toyota = identityFromMatch({ code: '7203', name: '丰田汽车', market: '日股', type: 'GP-JP', secid: '176.7203' })!
  const aShare = identityFromMatch({ code: '600519', name: '贵州茅台', market: '沪市', type: 'GP-A', secid: '1.600519' })!
  const fund = identityFromMatch({ code: '110022', name: '基金', market: '基金', type: 'FUND', secid: 'x' })!
  assert.equal(nvda.secid, '105.NVDA'); assert.equal(nvda.market, '美股')
  assert.equal(toyota.market, '日股')
  assert.equal(isGlobalSecurity(toyota), true, '日股走全球行情')
  assert.equal(isGlobalSecurity(nvda), false, '美股仍走既有档案链')
  assert.equal(isGlobalSecurity(aShare), false)
  assert.equal(isGlobalSecurity(fund), false)
  assert.equal(isGlobalSecurity({ code: 'X', type: 'stock' }), false, '无 secid 不走全球')
})

const register = readFileSync(new URL('../src/tools/register.ts', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/server-routes.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../src/client/security-workspace.tsx', import.meta.url), 'utf8')

test('agent tools expose global quote, kline and cross-asset snapshot', () => {
  assert.match(register, /name: 'get_global_quote'/)
  assert.match(register, /name: 'get_global_kline'/)
  assert.match(register, /name: 'get_global_market_snapshot'/)
  assert.match(register, /101\.GC00Y/)
  assert.match(register, /100\.SPX/)
  assert.match(register, /fetchGlobalQuote\(/)
})

test('http routes and UI wiring exist for global quote/kline and clickable index K-line', () => {
  assert.match(routes, /sub === '\/global\/quote'/)
  assert.match(routes, /sub === '\/global\/kline'/)
  assert.match(panel, /toggleIndex/)
  assert.match(panel, /\/global\/kline\?secid=/)
  assert.match(workspace, /isGlobalSecurity\(item\)/)
  assert.match(workspace, /\/global\/quote\?secid=/)
  assert.match(workspace, /\/global\/kline\?secid=/)
})
test('weStock-first tools fall back to Eastmoney when the CLI is unavailable', () => {
  const westock = readFileSync(new URL('../src/tools/westock.ts', import.meta.url), 'utf8')
  assert.match(westock, /fallback: 'dividend_plan'/)
  assert.match(westock, /fallback: 'margin_detail'/)
  assert.match(westock, /callCap\(finance, 'announcements', payload, exec\.signal\)/)
  assert.match(westock, /return callCap\(finance, 'notice_list', payload, exec\.signal\)/)
})
test('WeStock binary detection covers Windows .exe and .dsh-home installs', () => {
  const westock = readFileSync(new URL('../src/data/westock.ts', import.meta.url), 'utf8')
  assert.match(westock, /\.dsh-home/)
  assert.match(westock, /\.exe/)
  assert.match(westock, /process\.platform === 'win32'/)
})
console.log(`[global-quotes] ${passed} pure/static groups passed; no live network used in this test.`)
