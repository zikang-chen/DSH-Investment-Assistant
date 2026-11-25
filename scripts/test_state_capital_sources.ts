/** Offline contracts by default. --live explicitly makes two official GETs and two
 * aggregate GETs (601288 only); prints evidence without writing files or reading holdings.
 * Aggregate fixture schema/fields reflect 2026-11-25 real RPT_F10_EH_HOLDERS responses.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HUIJIN_OVERVIEW_URL, HUIJIN_SHAREHOLDING_URL, STATE_CAPITAL_EM_REPORT, STATE_CAPITAL_MAX_CODES, fetchStateCapitalDisclosure, normalizeStateCapitalCodes, parseHuijinOfficialPages, parseStateCapitalEastmoneyResponse, parseStateCapitalQuantity, stateCapitalEastmoneyUrl } from '../src/data/state-capital-sources.js'
let checks = 0
async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> { await fn(); console.log(`PASS ${++checks}. ${name}`) }
const NOW = '2026-11-25T09:00:00.000Z'
const OVERVIEW = '<html><p>截至2025年12月31日，中央汇金公司直接持有2家金融机构股权。</p><p>除上述控参股企业外，汇金公司还全资持有子公司中央汇金资产管理有限责任公司。中央汇金资产管理有限责任公司于2015年11月设立，注册地北京，注册资本50亿元，从事资产管理业务。</p></html>'
function item(name: string, total: string, quantity: string, pct: string, indirect = ''): string {
  return `<div class="details-sheet-item${indirect ? ' details-sheet-item_last' : ''}"><div class="sheet-item-con"><div data-value="${pct}"></div><div class="sheet-data"><p><span class="sz">${total}</span></p><p><span class="sz">${quantity}</span></p></div><a href="https://example.invalid">${name}</a>${indirect}</div></div>`
}
const DETAIL = `<html>${item('国家开发银行', '4212.48亿元', '1460.92亿元', '34.68')}${item('中国农业银行股份有限公司', '3499.83亿股', '1404.89亿股', '40.14')}${item('中国银河证券股份有限公司', '109.34亿股', '51.87亿股', '47.44', '（注：中央汇金公司不直接持股该公司，以上显示为中国银河金融控股有限责任公司对该公司持股情况）')}${item('申万宏源证券有限公司', '535.00亿股', '535.00亿股', '100', '（注：中央汇金公司不直接持股该公司，以上显示为申万宏源集团股份有限公司对该公司持股情况）')}</html>`
const ROW = { SECUCODE: '601288.SH', SECURITY_CODE: '601288', ORG_CODE: '10008271', END_DATE: '2026-09-30 00:00:00', HOLDER_NAME: '中国证券金融股份有限公司', HOLD_NUM: 1842751177, HOLD_NUM_RATIO: 0.53, HOLDER_RANK: 7, SECURITY_NAME_ABBR: '农业银行', SHARES_TYPE: '流通A股', TOTAL_SHARES_NUM: 349983033873, HOLDER_STATE: '加仓', HOLDER_MARKET_CAP: 12843975703.69 }
function response(rows: unknown[] = [ROW], extra: Record<string, unknown> = {}): string { return JSON.stringify({ success: true, code: 0, result: { data: rows, count: rows.length, pages: rows.length ? 1 : 0 }, ...extra }) }
function stub(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = []
  return { calls, fetch: (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); calls.push(url); return await handler(url, init) }) as typeof globalThis.fetch }
}
await check('Official detail names, quantities and unit conversion come from same row', () => {
  const d = parseHuijinOfficialPages(OVERVIEW, DETAIL, NOW)
  assert.equal(d.entityId, 'huijin'); assert.equal(d.sources.length, 2); assert.equal(d.holdings.length, 5)
  assert.equal(d.holdings.find(h => h.name === '国家开发银行')!.unit, '元')
  assert.equal(d.holdings.find(h => h.name === '中国农业银行股份有限公司')!.quantity, 140489000000)
  assert.equal(d.holdings[0]!.quantityPrecision, 1_000_000)
  assert.equal(d.sources[0]!.asOf, '2025-12-31'); assert.equal(d.sources[1]!.asOf, null)
})
await check('Overview date never gets forced onto undated detail rows', () => {
  const d = parseHuijinOfficialPages(OVERVIEW, DETAIL, NOW)
  assert.equal(d.asOf, null); assert.ok(d.holdings.slice(0, 4).every(h => h.asOf === null && h.disclosedAt === null))
  assert.equal(d.sources[0]!.publishedAt, null); assert.equal(d.capturedAt, NOW)
})
await check('Indirect securities holdings stay separated', () => {
  const d = parseHuijinOfficialPages(OVERVIEW, DETAIL, NOW)
  assert.equal(d.holdings.filter(h => h.holdingMode === 'indirect').length, 2)
  assert.match(d.holdings.find(h => h.name === '中国银河证券股份有限公司')!.denominator, /中国银河金融控股有限责任公司/)
})
await check('Wholly-owned subsidiary does not invent paid-in capital quantity', () => {
  const h = parseHuijinOfficialPages(OVERVIEW, DETAIL, NOW).holdings.at(-1)!
  assert.equal(h.percentage, 100); assert.equal(h.quantity, null); assert.equal(h.asOf, '2025-12-31')
})
await check('Official hashes retain exact source text evidence', () => {
  const d = parseHuijinOfficialPages(OVERVIEW, DETAIL, NOW)
  assert.equal(d.sources[0]!.hash, createHash('sha256').update(OVERVIEW).digest('hex'))
  assert.equal(d.holdings[0]!.sourceHash, d.sources[1]!.hash)
})
await check('Schema drift / date absence / inconsistent count fail, not empty success', () => {
  assert.throws(() => parseHuijinOfficialPages('captcha', DETAIL))
  assert.throws(() => parseHuijinOfficialPages(OVERVIEW, 'captcha'))
  assert.throws(() => parseHuijinOfficialPages(OVERVIEW.replace('持有2家', '持有3家'), DETAIL))
  assert.throws(() => parseHuijinOfficialPages(OVERVIEW, DETAIL.replace('1404.89亿股', 'unknown')))
  assert.throws(() => parseHuijinOfficialPages(OVERVIEW, DETAIL.replace('3499.83亿股', '3499.83亿元')))
  assert.throws(() => parseHuijinOfficialPages(OVERVIEW, DETAIL.replace('1404.89亿股', '9999.99亿股')))
})
await check('Unit parser distinguishes shares, fund units, money and display precision', () => {
  assert.deepEqual(parseStateCapitalQuantity('1.23亿股'), { quantity: 123000000, unit: '股', precision: 1_000_000 })
  assert.equal(parseStateCapitalQuantity('5万份').unit, '份'); assert.equal(parseStateCapitalQuantity('2亿元').unit, '元')
  for (const raw of ['--', '0x10亿股', '-1亿股', '1亿美元', 'Infinity元']) assert.throws(() => parseStateCapitalQuantity(raw))
})
await check('Explicit code pool only, max five, no default holdings or ETF heuristics', () => {
  assert.equal(STATE_CAPITAL_MAX_CODES, 5)
  assert.deepEqual(normalizeStateCapitalCodes(['601288', '000001', '601288']), ['000001', '601288'])
  for (const codes of [undefined, [], ['601288', '600519', '000001', '300001', '600000', '601398'], ['510300'], ['588000'], ['00700'], ['601288.SH'], ['x601288'], ['601288)']]) assert.throws(() => normalizeStateCapitalCodes(codes))
})
await check('Request uses only the verified report and per-code latest-ten bounded filter', () => {
  const u = new URL(stateCapitalEastmoneyUrl('601288'))
  assert.equal(u.hostname, 'datacenter-web.eastmoney.com'); assert.equal(u.searchParams.get('reportName'), STATE_CAPITAL_EM_REPORT)
  assert.equal(u.searchParams.get('filter'), '(SECUCODE="601288.SH")'); assert.equal(u.searchParams.get('pageSize'), '10')
})
await check('Real schema exact legal-name match, shares not market value, no guessed notice date', () => {
  const p = parseStateCapitalEastmoneyResponse(response(), '601288', 'csf')
  assert.equal(p.holding.quantity, 1842751177); assert.equal(p.holding.unit, '股'); assert.equal(p.holding.asOf, '2026-09-30')
  assert.equal(p.source.level, 'aggregated'); assert.equal(p.holding.disclosedAt, null); assert.equal(p.source.publishedAt, null)
  assert.equal(p.holding.percentage, 0.53); assert.match(p.holding.locator, /HOLDER_RANK=7/)
})
await check('Containing legal name in a product name does not count as entity match', () => {
  const p = parseStateCapitalEastmoneyResponse(response([{ ...ROW, HOLDER_NAME: ROW.HOLDER_NAME + '-某产品' }]), '601288', 'csf')
  assert.equal(p.holding.quantity, null); assert.equal(p.holding.holdingMode, 'unknown')
})
await check('Other national or provincial owners do not get automatically combined', () => {
  const p = parseStateCapitalEastmoneyResponse(response([{ ...ROW, HOLDER_NAME: '全国社会保障基金理事会' }]), '601288', 'csf')
  assert.equal(p.holding.quantity, null); assert.equal(p.holding.percentage, null)
})
await check('Latest period absence does not reuse an older matched holding', () => {
  const p = parseStateCapitalEastmoneyResponse(response([{ ...ROW, HOLDER_NAME: '其他股东' }, { ...ROW, END_DATE: '2026-06-30 00:00:00' }]), '601288', 'csf')
  assert.equal(p.holding.quantity, null); assert.equal(p.holding.asOf, '2026-09-30')
})
await check('No returned list means unknown, not zero', () => {
  const p = parseStateCapitalEastmoneyResponse(response([]), '601288', 'huijin-asset')
  assert.equal(p.holding.quantity, null); assert.equal(p.holding.asOf, null)
})
await check('Malformed, duplicate, cross-code, negative, unsafe and bad-date records reject', () => {
  for (const text of ['<html>captcha</html>', response([], { success: false }), response([{ ...ROW, SECURITY_CODE: '600519' }]), response([{ ...ROW, END_DATE: '2026-02-30' }]), response([{ ...ROW, HOLD_NUM: -1 }]), response([{ ...ROW, HOLD_NUM: 0.5 }]), response([{ ...ROW, HOLD_NUM: Number.MAX_SAFE_INTEGER + 1 }]), response([{ ...ROW, HOLD_NUM_RATIO: 100.1 }]), response([ROW, ROW]), response(Array(11).fill(ROW))]) assert.throws(() => parseStateCapitalEastmoneyResponse(text, '601288', 'csf'))
})
await check('Default Huijin fetch calls exactly the two fixed official URLs without redirects', async () => {
  const s = stub((url, init) => { assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'GET'); return new Response(url === HUIJIN_OVERVIEW_URL ? OVERVIEW : DETAIL) })
  const d = await fetchStateCapitalDisclosure('huijin', { fetch: s.fetch, capturedAt: NOW })
  assert.deepEqual(s.calls, [HUIJIN_OVERVIEW_URL, HUIJIN_SHAREHOLDING_URL]); assert.equal(d.capturedAt, NOW)
})
await check('Explicit pool has <=5 HTTP calls and sorted stable scope, no retry or pagination', async () => {
  const s = stub(url => { const filter = new URL(url).searchParams.get('filter')!; const code = /\d{6}/.exec(filter)![0]; return new Response(response([{ ...ROW, SECURITY_CODE: code }])) })
  const d = await fetchStateCapitalDisclosure('csf', { codes: ['601288', '600519', '000001', '300001', '600000'], fetch: s.fetch })
  assert.equal(s.calls.length, 5); assert.equal(d.sources.length, 5); assert.match(d.scopeId, /000001,300001,600000,600519,601288/)
})
await check('Missing pool and invalid entity fail before any request', async () => {
  const s = stub(() => new Response('{}'))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { fetch: s.fetch }), /显式A股/)
  await assert.rejects(fetchStateCapitalDisclosure('huijin-asset', { fetch: s.fetch }), /显式A股/)
  await assert.rejects(fetchStateCapitalDisclosure('国新', { fetch: s.fetch }), /未知/)
  assert.equal(s.calls.length, 0)
})
await check('Source failure rejects whole snapshot and does not retry', async () => {
  const s = stub(() => new Response('failure', { status: 503 }))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch }), /503/)
  assert.equal(s.calls.length, 1)
})
await check('Partial pool failure does not return an incomplete replacement baseline', async () => {
  const s = stub(url => new URL(url).searchParams.get('filter')!.includes('000001') ? new Response(response([{ ...ROW, SECURITY_CODE: '000001' }])) : new Response('failed', { status: 500 }))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['000001', '601288'], fetch: s.fetch }), /500/)
  assert.equal(s.calls.length, 2)
})
await check('Pre-aborted caller sends no requests', async () => {
  const controller = new AbortController(); controller.abort(new Error('test cancelled'))
  const s = stub(() => new Response('{}'))
  await assert.rejects(fetchStateCapitalDisclosure('huijin', { signal: controller.signal, fetch: s.fetch }), /cancelled/)
  assert.equal(s.calls.length, 0)
})
await check('Network timeout cancels the current source and fails closed', async () => {
  const s = stub((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch, timeoutMs: 5 }), /超时/)
  assert.equal(s.calls.length, 1)
})
await check('Timeout covers response body after headers, not just initial fetch', async () => {
  const s = stub((_url, init) => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }) } })))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch, timeoutMs: 5 }), /超时/)
})
await check('Caller cancellation propagates through pending request', async () => {
  const controller = new AbortController()
  const s = stub((_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); controller.abort(new Error('caller stopped')) }))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch, signal: controller.signal }), /caller stopped/)
})
await check('Declared response byte cap and streaming byte cap both reject', async () => {
  for (const headers of [{ 'content-length': '1001' }, {}] as Record<string, string>[]) {
    const s = stub(() => new Response('x'.repeat(1001), { headers }))
    await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch, maxResponseBytes: 1000 }), /字节超预算/)
  }
})
await check('Non-JSON / silently redirected content fails, not empty source', async () => {
  const s = stub(() => new Response('captcha'))
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: s.fetch }), /不是JSON/)
  const redirected = stub(() => { const r = new Response(response()); Object.defineProperty(r, 'url', { value: 'https://example.invalid/elsewhere' }); return r })
  await assert.rejects(fetchStateCapitalDisclosure('csf', { codes: ['601288'], fetch: redirected.fetch }), /重定向/)
})
console.log(`state-capital-sources: ${checks} offline checks passed`)
if (process.argv.includes('--live')) {
  // Deliberately bounded live verification: 2 official GETs + 2 aggregate GETs, no writes.
  for (const [entity, codes] of [['huijin', undefined], ['csf', ['601288']], ['huijin-asset', ['601288']]] as const) {
    const d = await fetchStateCapitalDisclosure(entity, { ...(codes ? { codes: [...codes] } : {}) })
    console.log(JSON.stringify({ live: entity, asOf: d.asOf, disclosedAt: d.disclosedAt, capturedAt: d.capturedAt, scopeId: d.scopeId, holdings: d.holdings.length, direct: d.holdings.filter(h => h.holdingMode === 'direct').length, indirect: d.holdings.filter(h => h.holdingMode === 'indirect').map(h => ({ name: h.name, asOf: h.asOf })), evidence: d.sources, sample: d.holdings.filter(h => h.code || h.name.includes('农业银行') || h.name.includes('汇金资产')).map(h => ({ name: h.name, quantity: h.quantity, unit: h.unit, asOf: h.asOf, rawQuantity: h.rawQuantity, percentage: h.percentage })) }, null, 2))
  }
}
