import assert from 'node:assert/strict'
import { httpGetJson, httpGetText } from '../src/data/http.js'
import { parseGlobalQuote, parseGlobalKline, parseTencentGlobalKline, fetchGlobalKline } from '../src/data/global-quotes.js'
import { buildSinaGlobalRows } from '../src/data/sina-global-indices.js'
import { GLOBAL_INDEX_DEFS } from '../src/data/global-indices.js'
import { ProviderRegistry } from '../src/data/registry.js'
let count = 0
async function test(name: string, run: () => unknown) { await run(); console.log('PASS', name); count++ }
const original = globalThis.fetch
try {
  await test('HTTP body读取也受超时约束', async () => {
    globalThis.fetch = (async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }) })) as typeof fetch
    await assert.rejects(httpGetJson('https://unit.test', {}, { timeoutMs: 20 }), /timeout/)
  })
  await test('响应头返回后取消仍能终止body读取', async () => {
    const ctrl = new AbortController()
    globalThis.fetch = (async (_url, init) => ({ ok: true, text: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      ctrl.abort(new Error('user cancelled'))
    }) })) as typeof fetch
    await assert.rejects(httpGetText('https://unit.test', {}, { timeoutMs: 500, signal: ctrl.signal }), /user cancelled/)
  })
  await test('网络重置重试一次，HTTP错误不重试', async () => {
    let calls=0
    globalThis.fetch = (async () => {
      if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })
      return new Response('{"value":42}')
    }) as typeof fetch
    assert.deepEqual(await httpGetJson('https://unit.test', {}, { timeoutMs: 100 }), { value: 42 })
    assert.equal(calls, 2)
    calls=0
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 403 }) }) as typeof fetch
    await assert.rejects(httpGetJson('https://unit.test', {}, { timeoutMs: 100 }), /403/)
    assert.equal(calls, 1)
  })
} finally { globalThis.fetch=original }
await test('全球报价拒绝请求与响应代码/市场不一致', () => {
  assert.equal(parseGlobalQuote('105.NVDA', { data: { f57:'AAPL', f43:42 } }).ok, false)
  assert.equal(parseGlobalQuote('105.NVDA', { data: { f57:'NVDA', f107:106, f43:42 } }).ok, false)
  assert.equal(parseGlobalKline('100.HSI', { data: { code:'SPX', klines:['2026-11-20,1,1,1,1,0'] } }).ok, false)
})
await test('腾讯仅匹配指定symbol或已知别名，不取首个key', () => {
  const data={ 'us.INX': { day: [['2026-11-20','1','1','1','1','0']] } }
  assert.equal(parseTencentGlobalKline('100.HSI', { data }).ok,false)
  assert.equal(parseTencentGlobalKline('100.SPX', { data }).ok,true)
})
await test('缺OHLC/量不制造平盘蜡烛或零量', () => {
  assert.equal(parseGlobalKline('100.SPX', { data: { klines:['2026-11-20,,1,1,1,0'] } }).bars.length,0)
  assert.equal(parseTencentGlobalKline('100.SPX', { data:{'us.INX':{day:[['2026-11-20','','1','1','1','0']]}} }).bars.length,0)
})
await test('取消全球K线请求不再尝试备源', async () => {
  const ctrl=new AbortController(); ctrl.abort(new Error('cancelled'))
  let calls=0
  await assert.rejects(fetchGlobalKline('100.SPX',60,{signal:ctrl.signal,fetchJson:async()=>{calls++;return {}}}),/cancelled/)
  assert.equal(calls,0)
  const ctrl2=new AbortController()
  await assert.rejects(fetchGlobalKline('100.SPX',60,{signal:ctrl2.signal,fetchJson:async()=>{calls++; ctrl2.abort(new Error('cancelled')); throw new Error('fetch failed')}}),/cancelled/)
  assert.equal(calls,1)
})
await test('旧探测报告仍会补入新默认来源，显式用户policy不变', async () => {
  const registry = new ProviderRegistry({cacheTtlSec:0,requestGapMs:0,timeoutMs:100} as never)
  registry.applyReport({probedAt:'2026-11-17',results:[],providerOrder:{global_indices:['em_global_indices']}} as never)
  assert.deepEqual(registry.getCatalog().find(r=>r.capability==='global_indices')!.selected,['em_global_indices','sina_global_indices'])
  await registry.setPolicy({global_indices:['em_global_indices']},false)
  assert.deepEqual(registry.getCatalog().find(r=>r.capability==='global_indices')!.selected,['em_global_indices'])
})
await test('陈旧TSX/无时间快照不能成为成功行情，伦铜不冒用COMEX铜', () => {
  const defs=GLOBAL_INDEX_DEFS.filter(d=>['100.TSX','101.HG00Y'].includes(d.secid))
  const r=buildSinaGlobalRows('var hq_str_znb_SPTSX="TSX,29761.28,29.3,0.1,9/26/2025,1758859200";\nvar hq_str_hf_CAD="12000,,,,,,,,,,,,,伦铜";',defs,'2026-11-23T03:00:00Z')
  assert.equal(r.failed,2); assert.ok(r.rows.every(r=>r.price===null))
  assert.match(r.rows[0]!.error!,/过期/)
})
console.log(`[market-integrity] ${count} checks passed`)
