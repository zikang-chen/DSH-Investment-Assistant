/**
 * 黄金 CFD 代理日线离线回归：默认不把 CFD 冒充 COMEX、JSONP/数据/超时/取消。
 * node --import tsx scripts/test_sina_futures.ts
 * 加 --live 才做有界真实 GC 请求：主源及 CFD 各至多一次，无穷举、不落盘行情。
 */
import assert from 'node:assert/strict'
import { fetchGlobalKline } from '../src/data/global-quotes.js'
import {
  SINA_FUTURES_BY_SECID, SINA_FUTURES_MAX_RESPONSE_BYTES,
  extractSinaFuturesArray, fetchSinaFuturesKline, parseSinaFuturesKline,
  sinaFuturesInstrument, sinaFuturesUrl,
} from '../src/data/sina-global-futures.js'

let checks = 0
async function check(name: string, run: () => void | Promise<void>) {
  await run(); checks++; console.log(`PASS ${name}`)
}
const SECID = '101.GC00Y'
const INSTRUMENT = { name: '纽约黄金CFD', symbol: 'GC', kind: 'cfd', unit: 'USD/troy oz', proxy: true, requestedSecid: SECID }
const row = (date: string, extra: Record<string, unknown> = {}) => ({ date, open: '3666.700', high: '3707.000', low: '3636.300', close: '3654.300', volume: '0', ...extra })
const jsonp = (rows: unknown[], symbol = 'GC') => `/*<script>location.href='//sina.com';</script>*/\nvar _${symbol}=(${JSON.stringify(rows)});`
const FIXTURE = jsonp([row('2026-11-24')])
const emDown = async () => { throw new Error('EM fetch failed') }

await check('映射：只保留核查过的黄金CFD，明确单位与非等价身份', () => {
  assert.deepEqual(Object.keys(SINA_FUTURES_BY_SECID), [SECID])
  assert.equal(SINA_FUTURES_BY_SECID[SECID], 'GC')
  for (const unsupported of ['101.SI00Y', '102.CL00Y', '112.B00Y', '101.HG00Y', '101.XAU', '105.GC', 'toString']) {
    assert.equal(sinaFuturesInstrument(unsupported), undefined)
    assert.equal(parseSinaFuturesKline(unsupported, [row('2026-11-24')]).ok, false)
  }
  assert.deepEqual(sinaFuturesInstrument(SECID), INSTRUMENT)
  const url = new URL(sinaFuturesUrl('GC'))
  assert.equal(url.protocol, 'https:')
  assert.equal(url.hostname, 'stock2.finance.sina.com.cn')
  assert.equal(url.searchParams.get('symbol'), 'GC')
  assert.match(decodeURIComponent(url.pathname), /\/var _GC=\/GlobalFuturesService\.getGlobalFuturesDailyKLine$/)
  for (const bad of ['SI', 'GC;alert(1)', '../GC', 'gc', '']) assert.throws(() => sinaFuturesUrl(bad))
})

await check('JSONP：接受真实固定wrapper/防XSS注释/空白，不执行任何脚本', () => {
  assert.deepEqual(extractSinaFuturesArray(FIXTURE), [row('2026-11-24')])
  assert.deepEqual(extractSinaFuturesArray('\ufeff  var _GC = ( [] ) ;\r\n'), [])
  assert.equal(extractSinaFuturesArray(FIXTURE, 'SI'), null)
  for (const bad of [
    jsonp([row('2026-11-24')], 'SI'),
    'callback([])', 'var _GC=({});', 'var _GC=(null);', '[]',
    'var _GC=([undefined]);', 'var _GC=([{date:"2026-11-24"}]);',
    'alert(1);var _GC=([]);', 'var _GC=([]);alert(1)',
    'var _GC=([]);var _GC=([]);', 'var _GC=([]/* comment */);',
    '/* other script */var _GC=([]);', '<html>var _GC=([]);</html>',
  ]) assert.equal(extractSinaFuturesArray(bad), null, bad)
  assert.equal(extractSinaFuturesArray('x'.repeat(SINA_FUTURES_MAX_RESPONSE_BYTES + 1)), null)
})

await check('日期：核验公历闰日，拒绝滚动日期/时间后缀/任意截断', () => {
  const r = parseSinaFuturesKline(SECID, [
    row('2024-02-29'), row('2023-02-29'), row('2026-11-31'), row('2026-00-10'),
    row('2026-13-01'), row('2026-11-24T00:00:00Z'), row('2026-11-24junk'),
    row(' 2026-11-24'), row('2026-11-24 '), row('2026-1-24'), row('2026-11-24', { date: 20261124 }),
  ])
  assert.equal(r.ok, true)
  assert.deepEqual(r.bars.map(b => b.date), ['2024-02-29'])
  assert.equal(r.diagnostics?.invalidRows, 10)
})

await check('OHLC：有限正数且上下界一致，不补值/缩放/强制转换布尔或对象', () => {
  const bad = [
    null, [], 'bad', row('2026-11-24', { open: true }), row('2026-11-24', { high: {} }),
    row('2026-11-24', { close: null }), row('2026-11-24', { close: '' }), row('2026-11-24', { close: '-' }),
    row('2026-11-24', { close: Infinity }), row('2026-11-24', { close: 'NaN' }), row('2026-11-24', { close: '0x10' }),
    row('2026-11-24', { close: 0 }), row('2026-11-24', { low: -1 }),
    row('2026-11-24', { high: 3600 }), row('2026-11-24', { low: 3670 }), row('2026-11-24', { open: 3500 }),
  ]
  const r = parseSinaFuturesKline(SECID, [...bad, row('2026-11-24')])
  assert.equal(r.bars.length, 1)
  assert.deepEqual(r.bars[0], { date: '2026-11-24', open: 3666.7, high: 3707, low: 3636.3, close: 3654.3, volume: null })
  assert.equal(r.diagnostics?.inputRows, bad.length + 1)
  assert.equal(r.diagnostics?.invalidRows, bad.length)
  assert.match(r.warnings?.join(' ') ?? '', /未修补/)
  assert.equal(parseSinaFuturesKline(SECID, bad).ok, false)
  assert.equal(parseSinaFuturesKline(SECID, {}).ok, false)
  assert.equal(parseSinaFuturesKline(SECID, []).ok, false)
})

await check('排序与去重：同日最后合法行胜出，非法重复不能覆盖，诊断保留', () => {
  const r = parseSinaFuturesKline(SECID, [
    row('2026-11-24'), row('2026-11-20'), row('2026-11-23'),
    row('2026-11-24', { close: '3655.0' }), row('2026-11-24', { close: '-' }),
    row('2026-11-25', { open: '3538.5', low: '3582.7' }),
  ])
  assert.deepEqual(r.bars.map(b => b.date), ['2026-11-20', '2026-11-23', '2026-11-24'])
  assert.equal(r.bars.at(-1)?.close, 3655)
  assert.equal(r.diagnostics?.invalidRows, 2)
  assert.equal(r.diagnostics?.duplicateRows, 1)
  assert.equal(r.diagnostics?.latestSourceDate, '2026-11-25')
  assert.deepEqual(r.diagnostics?.discardedDates, ['2026-11-24', '2026-11-25'])
  assert.match(r.warnings?.join(' ') ?? '', /尚未收盘/)
  const manyBad = parseSinaFuturesKline(SECID, [
    row('2026-11-24'), ...[8, 4, 7, 1, 3, 2, 6, 5].map(day => row(`2026-11-0${day}`, { close: '-' })),
  ])
  assert.deepEqual(manyBad.diagnostics?.discardedDates, ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
})

await check('成交量：缺失/零占位/非法量保留null，正数原样不伪造', () => {
  for (const volume of [undefined, null, '', ' ', 0, '0', '-', -1, '-1', NaN, Infinity, true, {}]) {
    const r = parseSinaFuturesKline(SECID, [row('2026-11-24', { volume })])
    assert.equal(r.ok, true)
    assert.equal(r.bars[0]?.volume, null, `volume=${String(volume)}`)
  }
  assert.equal(parseSinaFuturesKline(SECID, [row('2026-11-24', { volume: '1234' })]).bars[0]?.volume, 1234)
})

await check('根数：直接源调用也限1–500，非有限数默认120', async () => {
  const manyRows = Array.from({ length: 600 }, (_, i) => row(new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10)))
  const text = jsonp(manyRows)
  for (const [limit, expected] of [[60, 60], [9999, 500], [0, 1], [-10, 1], [2.9, 2], [NaN, 120], [Infinity, 120]]) {
    const r = await fetchSinaFuturesKline(SECID, limit!, { fetchText: async () => text })
    assert.equal(r.ok, true)
    assert.equal(r.bars.length, expected)
    assert.equal(r.bars.at(-1)?.date, manyRows.at(-1)?.date)
    assert.equal(r.diagnostics?.inputRows, 600)
  }
})

await check('失败：错品种wrapper/源异常均明确返回，不制造空成功', async () => {
  const invalid = await fetchSinaFuturesKline(SECID, 60, { fetchText: async () => jsonp([row('2026-11-24')], 'SI') })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error ?? '', /格式变化或品种不一致/)
  const down = await fetchSinaFuturesKline(SECID, 60, { fetchText: async () => { throw new Error('sina down') } })
  assert.equal(down.ok, false)
  assert.equal(down.error, 'sina down')
  let calls = 0
  const unsupported = await fetchSinaFuturesKline('101.HG00Y', 60, { fetchText: async () => { calls++; return FIXTURE } })
  assert.equal(unsupported.ok, false)
  assert.equal(calls, 0)
})

await check('默认链路：东财失败只提供CFD入口，不自动请求/冒充COMEX', async () => {
  let textCalls = 0
  for (const allowProxyFallback of [undefined, false, 'true' as never]) {
    const r = await fetchGlobalKline(SECID, 60, { fetchJson: emDown, allowProxyFallback, fetchText: async () => { textCalls++; return FIXTURE } })
    assert.equal(r.ok, false)
    assert.equal(r.source, 'eastmoney-push2')
    assert.deepEqual(r.availableProxy, INSTRUMENT)
    assert.equal(r.instrument, undefined)
    assert.equal(r.bars.length, 0)
    assert.match(r.error ?? '', /EM fetch failed/)
    assert.match(r.error ?? '', /不等同COMEX/)
  }
  assert.equal(textCalls, 0)
})

await check('显式代理链路：先东财后GC，不走腾讯，透传身份/warnings/坏行诊断', async () => {
  const calls: string[] = []
  const r = await fetchGlobalKline(` ${SECID} `, 1, {
    allowProxyFallback: true,
    fetchJson: async url => { calls.push(url); return { data: { klines: [] } } },
    fetchText: async url => { calls.push(url); return jsonp([row('2026-11-20'), row('2026-11-23', { open: '3538.5', low: '3582.7' }), row('2026-11-24')]) },
  })
  assert.equal(calls.length, 2)
  assert.match(calls[0]!, /push2his/)
  assert.equal(calls[1], sinaFuturesUrl('GC'))
  assert.equal(r.ok, true)
  assert.equal(r.secid, SECID)
  assert.equal(r.source, 'sina-global-futures')
  assert.deepEqual(r.instrument, INSTRUMENT)
  assert.equal(r.bars.length, 1)
  assert.equal(r.bars[0]?.volume, null)
  assert.equal(r.diagnostics?.invalidRows, 1)
  assert.deepEqual(r.diagnostics?.discardedDates, ['2026-11-23'])
  assert.match(r.warnings?.join(' ') ?? '', /CFD.*不等同COMEX/)
})

await check('东财成功：即使允许代理也不请求新浪，不拼接/覆盖真实主源', async () => {
  let textCalls = 0
  const r = await fetchGlobalKline(SECID, 1, {
    allowProxyFallback: true,
    fetchJson: async () => ({ data: { code: 'GC00Y', market: 101, klines: ['2026-11-20,10,11,12,9,100', '2026-11-24,11,12,13,10,200'] } }),
    fetchText: async () => { textCalls++; return FIXTURE },
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'eastmoney-push2')
  assert.equal(r.instrument, undefined)
  assert.equal(r.bars.length, 1)
  assert.equal(r.bars[0]?.close, 12)
  assert.equal(textCalls, 0)
})

await check('身份错误/双源错误/无映射：只报真实来源问题，未知商品不猜symbol', async () => {
  const mismatch = await fetchGlobalKline(SECID, 60, { allowProxyFallback: true, fetchJson: async () => ({ data: { code: 'SI00Y', klines: ['2026-11-24,10,11,12,9,100'] } }), fetchText: async () => FIXTURE })
  assert.equal(mismatch.source, 'sina-global-futures')
  assert.equal(mismatch.ok, true)
  const both = await fetchGlobalKline(SECID, 60, { allowProxyFallback: true, fetchJson: emDown, fetchText: async () => { throw new Error('Sina unavailable') } })
  assert.equal(both.ok, false)
  assert.deepEqual(both.availableProxy, INSTRUMENT)
  assert.match(both.error ?? '', /EM fetch failed.*Sina unavailable/)
  let calls = 0
  const unsupported = await fetchGlobalKline('101.HG00Y', 60, { allowProxyFallback: true, fetchJson: emDown, fetchText: async () => { calls++; return FIXTURE } })
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.error ?? '', /没有备用源/)
  assert.equal(calls, 0)
})

await check('取消：预取消不请求，东财取消不启动代理，已返回主源也不可覆盖取消', async () => {
  const ctrl = new AbortController(), reason = new Error('user cancelled')
  ctrl.abort(reason)
  let calls = 0
  await assert.rejects(fetchGlobalKline(SECID, 60, { signal: ctrl.signal, fetchJson: async () => { calls++; return {} } }), e => e === reason)
  await assert.rejects(fetchSinaFuturesKline(SECID, 60, { signal: ctrl.signal, fetchText: async () => { calls++; return FIXTURE } }), e => e === reason)
  assert.equal(calls, 0)
  for (const success of [false, true]) {
    const active = new AbortController()
    await assert.rejects(fetchGlobalKline(SECID, 60, {
      signal: active.signal, allowProxyFallback: true,
      fetchJson: async () => { active.abort(reason); if (!success) throw new Error('aborted fetch'); return { data: { klines: ['2026-11-24,10,11,12,9,100'] } } },
      fetchText: async () => { calls++; return FIXTURE },
    }), e => e === reason)
  }
  assert.equal(calls, 0)
})

await check('取消：腾讯备源也保留调用方取消reason，不吞成双源故障', async () => {
  const ctrl = new AbortController(), reason = new Error('cancel tencent')
  let calls = 0
  await assert.rejects(fetchGlobalKline('100.SPX', 60, {
    signal: ctrl.signal,
    fetchJson: async () => { calls++; if (calls === 1) throw new Error('EM down'); ctrl.abort(reason); throw new Error('TX aborted') },
  }), e => e === reason)
  assert.equal(calls, 2)
})

await check('取消：新浪即使忽略signal也及时结束等待，取消reason不转成源错误', async () => {
  const ctrl = new AbortController(), reason = new Error('cancel during body')
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let sourceSignal: AbortSignal | undefined
  const pending = fetchGlobalKline(SECID, 60, {
    signal: ctrl.signal, allowProxyFallback: true, fetchJson: emDown,
    fetchText: async (_url, signal) => { sourceSignal = signal; entered(); return new Promise<string>(() => {}) },
  })
  const rejected = assert.rejects(pending, e => e === reason)
  await started
  ctrl.abort(reason)
  await rejected
  assert.equal(sourceSignal?.aborted, true)
})

await check('超时：注入源不响应取消仍受总预算控制，超时为源失败', async () => {
  let sourceSignal: AbortSignal | undefined
  const r = await fetchSinaFuturesKline(SECID, 60, {
    timeoutMs: 15,
    fetchText: async (_url, signal) => { sourceSignal = signal; return new Promise<string>(() => {}) },
  })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /超时.*15ms/)
  assert.equal(sourceSignal?.aborted, true)
})

const realFetch = globalThis.fetch
try {
  await check('默认HTTP：状态码明确报错并取消错误body，避免连接残留', async () => {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 })
    const r = await fetchSinaFuturesKline(SECID, 60)
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /HTTP 503/)
    assert.equal(cancelled, true)
  })

  await check('默认HTTP：超时覆盖headers之后的慢body，signal传入实际fetch', async () => {
    let aborted = false
    globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('var _GC=(['))
        init?.signal?.addEventListener('abort', () => { aborted = true; controller.error(init.signal!.reason) }, { once: true })
      },
    }))
    const r = await fetchSinaFuturesKline(SECID, 60, { timeoutMs: 15 })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /超时/)
    assert.equal(aborted, true)
  })

  await check('默认HTTP：Content-Length与流式体积都受限，超大body取消读取', async () => {
    for (const header of [true, false]) {
      let cancelled = false
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { if (!header) controller.enqueue(new Uint8Array(SINA_FUTURES_MAX_RESPONSE_BYTES + 1)) },
        cancel() { cancelled = true },
      }), { headers: header ? { 'content-length': String(SINA_FUTURES_MAX_RESPONSE_BYTES + 1) } : {} })
      const r = await fetchSinaFuturesKline(SECID, 60)
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /体积上限/)
      assert.equal(cancelled, true)
    }
  })

  await check('默认HTTP：有效GBK/ASCII响应走完整解析，无假volume', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), sinaFuturesUrl('GC'))
      assert.ok(init?.signal)
      assert.equal((init?.headers as Record<string, string>).Referer, 'https://finance.sina.com.cn/')
      return new Response(FIXTURE)
    }
    const r = await fetchSinaFuturesKline(SECID, 60)
    assert.equal(r.ok, true)
    assert.deepEqual(r.instrument, INSTRUMENT)
    assert.equal(r.bars[0]?.close, 3654.3)
    assert.equal(r.bars[0]?.volume, null)
  })
} finally {
  globalThis.fetch = realFetch
}

await check('注入源响应体积同样有界，防止绕过默认HTTP上限', async () => {
  const r = await fetchSinaFuturesKline(SECID, 60, { fetchText: async () => 'x'.repeat(SINA_FUTURES_MAX_RESPONSE_BYTES + 1) })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /体积上限/)
})

console.log(`\n[sina-futures] ${checks} offline groups passed; live network is opt-in.`)

if (process.argv.includes('--live')) {
  const start = Date.now()
  const result = await fetchGlobalKline(SECID, 60, { allowProxyFallback: true, signal: AbortSignal.timeout(40_000) })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.bars.length, 60)
  assert.ok(result.bars.every((b, i) => i === 0 || b.date > result.bars[i - 1]!.date))
  assert.ok(result.bars.every(b => b.low > 0 && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)))
  if (result.source === 'sina-global-futures') {
    assert.deepEqual(result.instrument, INSTRUMENT)
    assert.ok(result.bars.every(b => b.volume === null || b.volume > 0))
  }
  console.log('[LIVE GC 60]', JSON.stringify({
    source: result.source, instrument: result.instrument, elapsedMs: Date.now() - start,
    count: result.bars.length, first: result.bars[0], last: result.bars.at(-1),
    nullVolume: result.bars.filter(b => b.volume === null).length,
    diagnostics: result.diagnostics, warnings: result.warnings,
  }))
  // 若主源当时可用，再且只再核验一次显式 CFD；二者仍是各自完整序列。
  if (result.source !== 'sina-global-futures') {
    const proxy = await fetchSinaFuturesKline(SECID, 60, { signal: AbortSignal.timeout(15_000) })
    assert.equal(proxy.ok, true, proxy.error)
    assert.equal(proxy.bars.length, 60)
    assert.deepEqual(proxy.instrument, INSTRUMENT)
    assert.ok(proxy.bars.every((b, i) => (i === 0 || b.date > proxy.bars[i - 1]!.date) && b.low > 0 && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)))
    console.log('[LIVE CFD 60 — NOT COMEX]', JSON.stringify({
      source: proxy.source, instrument: proxy.instrument, count: proxy.bars.length,
      first: proxy.bars[0], last: proxy.bars.at(-1), nullVolume: proxy.bars.filter(b => b.volume === null).length,
      diagnostics: proxy.diagnostics, warnings: proxy.warnings,
    }))
  }
}
