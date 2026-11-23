/** Offline integrity contracts: no network, private data or configuration access. */
import assert from 'node:assert/strict'
import {
  fetchIntraday, fetchTxIntraday, parseIntradayPayload, parseTxMinutePayload,
  type IntradayFetchOptions,
} from '../src/data/intraday.js'

let checks = 0
async function check(name: string, run: () => void | Promise<void>) {
  await run(); checks++; console.log(`PASS ${name}`)
}
const point = '2026-11-20 22:30,1,2,3,1,100,200,2'
const em = (code = 'AAPL', market = 105) => ({ data: { code, market, trends: [point], preClose: 1 } })
const txMeta = { code: '600519', kind: 'a' as const, symbol: 'sh600519', days: 1 }
function tx(lines: string[], date: string | undefined = '20261123', qtCode = '600519') {
  return { data: { sh600519: { data: { date, data: lines }, qt: { sh600519: ['1', '茅台', qtCode, '10', '9'] } } } }
}

await check('Tencent requires actual source date, including real calendar date', () => {
  for (const date of ['', 'bad', '20260230', '2026-11-31']) {
    assert.throws(() => parseTxMinutePayload(tx(['0930 10 10 10000'], date), txMeta), /日期/)
  }
  const missing = { data: { sh600519: { data: { data: ['0930 10 10 10000'] } } } }
  assert.throws(() => parseTxMinutePayload(missing, txMeta), /日期/)
  assert.equal(parseTxMinutePayload(tx(['0930 10 10 10000'], '20240229'), txMeta).points[0]!.time, '2024-02-29 09:30')
})
await check('Reject malformed Tencent times rather than normalize or silently skip', () => {
  for (const time of ['2460', '2360', '2400', '930', 'xx']) {
    assert.throws(() => parseTxMinutePayload(tx([`${time} 10 10 10000`]), txMeta), /时间/)
  }
})
await check('Missing cumulative fields break the minute-difference chain', () => {
  const s = parseTxMinutePayload(tx(['0930 10 10 10000', '0931 10 - -', '0932 10 30 30000', '0933 10 35 35000']), txMeta)
  assert.deepEqual(s.points.map(p => p.volume), [10, null, null, 5])
  assert.deepEqual(s.points.map(p => p.amount), [10000, null, null, 5000])
  assert.equal(s.points[2]!.avgPrice, 10, 'VWAP uses independently valid cumulative totals and A-share lots ×100')
})
await check('Counter reversal is unknown, not fabricated zero; valid next difference resumes', () => {
  const s = parseTxMinutePayload(tx(['0930 10 10 10000', '0931 10 5 5000', '0932 10 8 8000']), txMeta)
  assert.deepEqual(s.points.map(p => p.volume), [10, null, 3])
  assert.deepEqual(s.points.map(p => p.amount), [10000, null, 3000])
})
await check('Tencent qt identity must match requested instrument when supplied', () => {
  assert.throws(() => parseTxMinutePayload(tx(['0930 10 10 10000'], '20261123', '000001'), txMeta), /品种不匹配/)
})
await check('Eastmoney identity rejects wrong code and wrong market', () => {
  const meta = { code: 'AAPL', kind: 'us' as const, days: 1, secid: '105.AAPL' }
  assert.throws(() => parseIntradayPayload(em('NVDA'), meta), /品种不匹配/)
  assert.throws(() => parseIntradayPayload(em('AAPL', 106), meta), /市场不匹配/)
  assert.equal(parseIntradayPayload(em(), meta).points[0]!.at, '2026-11-20T14:30:00.000Z', 'US trends2 source text is already Beijing time')
})
await check('Eastmoney malformed dates/times are not repaired', () => {
  for (const time of ['2026-02-30 09:30', '2026-11-20 24:00', '2026/11/20 09:30', '']) {
    assert.throws(() => parseIntradayPayload({ data: { trends: [`${time},1,2,3,1,100,200,2`] } }, { code: '600519', kind: 'a', days: 1 }), /日期时间非法/)
  }
})
await check('US discovery tries Nasdaq then NYSE and verifies response identity', async () => {
  const calls: string[] = []
  const fetchJson: IntradayFetchOptions['fetchJson'] = async (_url, params) => {
    calls.push(String(params.secid))
    return params.secid === '106.BABA' ? em('BABA', 106) : { data: null }
  }
  const s = await fetchIntraday('BABA', 'us', 1, { fetchJson })
  assert.equal(s.code, 'BABA')
  assert.deepEqual(calls, ['105.BABA', '106.BABA'])
})
await check('US discovery reaches AMEX after wrong identity and empty candidate', async () => {
  const calls: string[] = []
  const s = await fetchIntraday('SPY', 'us', 1, { fetchJson: async (_url, params) => {
    calls.push(String(params.secid))
    if (params.secid === '105.SPY') return em('AAPL', 105)
    return params.secid === '107.SPY' ? em('SPY', 107) : { data: null }
  } })
  assert.equal(s.code, 'SPY')
  assert.deepEqual(calls, ['105.SPY', '106.SPY', '107.SPY'])
})
await check('US discovery refuses unidentified data rather than claim requested instrument', async () => {
  await assert.rejects(() => fetchIntraday('BABA', 'us', 1, { fetchJson: async () => ({ data: { trends: [point] } }) }), /code\/market/)
})
await check('Explicit real secid gets priority, never falls back to guessed markets', async () => {
  const calls: string[] = []
  await fetchIntraday('BABA', 'us', 1, { secid: '106.BABA', fetchJson: async (_url, params) => { calls.push(String(params.secid)); return em('BABA', 106) } })
  assert.deepEqual(calls, ['106.BABA'])
  await assert.rejects(() => fetchIntraday('BABA', 'us', 1, { secid: '106.BABA', fetchJson: async () => { throw new Error('offline') } }), /offline/)
  for (const secid of ['106.AAPL', '116.BABA', 'bad', '']) {
    await assert.rejects(() => fetchIntraday('BABA', 'us', 1, { secid, fetchJson: async () => { throw new Error('must not fetch') } }), /secid/)
  }
})
await check('Cancellation prevents initial requests and US market fallback', async () => {
  const pre = new AbortController(); pre.abort(new Error('cancelled before'))
  let calls = 0
  const fetchJson: IntradayFetchOptions['fetchJson'] = async () => { calls++; return em() }
  await assert.rejects(() => fetchIntraday('AAPL', 'us', 1, { signal: pre.signal, fetchJson }), /cancelled before/)
  assert.equal(calls, 0)
  const live = new AbortController()
  await assert.rejects(() => fetchIntraday('BABA', 'us', 1, { signal: live.signal, fetchJson: async () => { calls++; live.abort(new Error('cancelled during')); throw new Error('network') } }), /cancelled during/)
  assert.equal(calls, 1)
})
await check('Tencent US and five-day requests remain explicitly unsupported', async () => {
  await assert.rejects(() => fetchTxIntraday('AAPL', 'us', 1), /没有美股分钟/)
  await assert.rejects(() => fetchTxIntraday('600519', 'a', 5), /只支持当日/)
})
console.log(`[intraday-integrity] ${checks} offline groups passed`)
