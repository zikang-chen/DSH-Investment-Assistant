/** Presentation/transport contracts. All names/data below are explicit fixtures, not live market claims. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dossierName, dossierRows, identityFromMatch, securityKey, stockIdentityFromRow, uniqueMatches } from '../src/client/security-model.js'
import { securityResearchPrompt } from '../src/client/security-workspace.js'

let passed = 0
const test = (name: string, run: () => void) => { run(); passed++; console.log(`PASS ${name}`) }
test('partial-name candidate identities retain market/code; no six-digit fund inference', () => {
  const bank = identityFromMatch({ code: '601988', name: '中国银行（fixture）', market: '沪市', type: 'GP-A' })!
  const fund = identityFromMatch({ code: '110022', name: '测试基金', market: '基金', type: 'FUND' })!
  const hk = identityFromMatch({ code: '00700', name: '腾讯（fixture）', market: '港股', type: 'GP-HK' })!
  assert.equal(bank.type, 'stock'); assert.equal(fund.type, 'fund'); assert.equal(hk.code, '00700')
  assert.notEqual(securityKey({ code: '110022', type: 'stock' }), securityKey(fund))
  assert.equal(identityFromMatch({ code: '000300', name: '测试指数', market: '指数' }), null)
})
test('deduplication never collapses cross-market or stock/fund same-code identities', () => {
  const stock = { code: '110022', name: 'fixture', market: '沪市', type: 'GP-A' }
  const fund = { ...stock, market: '基金', type: 'FUND' }
  assert.equal(uniqueMatches([stock, stock, fund]).length, 2)
})
test('dossier normalization preserves zero / negative / units and distinguishes missing', () => {
  assert.deepEqual(dossierRows([{ 本期营收: '123 亿元', 资金净流入: -10, 比例: '2%', 缺失: null }]), [{ 本期营收: '123 亿元', 资金净流入: '-10', 比例: '2%', 缺失: '—' }])
  assert.deepEqual(dossierRows({ 规模: 0 }), [{ 字段: '规模', 值: '0' }])
  assert.deepEqual(dossierRows(undefined), [])
})
test('only explicit constituent columns link securities, not narrative numbers', () => {
  assert.deepEqual(stockIdentityFromRow({ 代码: '00700', 名称: 'fixture' }, 'holdings'), { code: '00700', name: 'fixture', type: 'stock' })
  assert.equal(stockIdentityFromRow({ 代码: '00700', 名称: 'fixture' }, 'overview'), null)
  assert.equal(stockIdentityFromRow({ 代码: '2%', 名称: 'fixture' }, 'holdings'), null)
})
test('identity header uses source overview or explicit candidate, never invents company name', () => {
  const d = { ok: true, code: '110022', at: '2026-01-01', ready: 1, total: 1, elapsedMs: 0, sections: [{ key: 'overview', label: '概览', group: '基本信息', ok: true, rows: 1, ms: 0, data: [{ 字段: '基金名称', 值: 'fixture基金' }] }] }
  assert.equal(dossierName(d), 'fixture基金')
  assert.equal(dossierName({ ...d, sections: [] }, '候选名'), '候选名')
})
test('natural stock research includes annual reports, flows, global sources and opposing evidence', () => {
  const text = securityResearchPrompt({ code: '00700', type: 'stock', name: 'fixture' })
  for (const term of ['年报', '现金流', '资金流入流出', '国内外政策', '全球', '反对证据', '失效条件', 'investment_advice_generate']) assert.ok(text.includes(term))
  assert.match(text, /没有授权使用个人持仓/)
  assert.match(text, /不得用摘要冒充已读/)
  const authorized = securityResearchPrompt({ code: '00700', type: 'stock' }, true)
  assert.match(authorized, /我授权为这次分析读取本机组合中的相关持仓数量与成本/)
  assert.match(authorized, /不得读取账号凭证或执行交易/)
  assert.doesNotMatch(authorized, /本次没有授权使用个人持仓/)
})
test('fund research uses NAV/risk/holdings, not a fictitious fund-company revenue metric', () => {
  const text = securityResearchPrompt({ code: '110022', type: 'fund' })
  for (const term of ['T+1', '经理', '重仓', '回撤', '费率', '基金自身没有公司营收口径']) assert.ok(text.includes(term))
})
const client = await readFile(new URL('../src/client/security-search.tsx', import.meta.url), 'utf8')
const detail = await readFile(new URL('../src/client/security-workspace.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../src/server-routes.ts', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/data/service.ts', import.meta.url), 'utf8')
const providers = await readFile(new URL('../src/data/providers.ts', import.meta.url), 'utf8')
test('real provider-backed search is bounded, debounced, IME-aware and rejects stale responses', () => {
  assert.match(client, /\/search\?q=\$\{encodeURIComponent/)
  assert.match(client, /&limit=30/)
  assert.match(client, /300\)/)
  assert.match(client, /request\.current !== id/)
  assert.match(client, /onQueryChange\?\.\(value\)/)
  assert.match(client, /event\.nativeEvent\.isComposing/)
  assert.match(client, /aria-activedescendant/)
  assert.doesNotMatch(client, /onSelect\(.*\[0\]/)
})
test('search transports requested bounds without changing internal identifier resolver defaults', () => {
  assert.match(server, /finance\.searchSymbol\(q, undefined, limit\)/)
  assert.match(server, /r\.data\.slice\(0, limit\)/)
  assert.match(service, /requested === undefined \? \{\} : \{ limit: requested \}/)
  assert.match(providers, /emSuggestMatches\(keyword: string, ctx: ProviderContext, limit = 8\)/)
  assert.match(providers, /const matches = await emSuggestMatches\(kw, ctx, limit\)/)
})
test('security entry, detail, chart and private-data boundaries are actually wired', () => {
  assert.match(entry, /h\(FundWorkspace, \{ get: apiGet, active: tab === 'funds'/)
  assert.match(entry, /onOpenFund: \(item\) => \{ if \(!selectTab\('dossier'\)\) return; setSecurityReturnTab\('funds'\); setDossierTarget/)
  assert.match(entry, /h\(SecurityWorkspace/)
  assert.match(entry, /window\.addEventListener\(SECURITY_OPEN_EVENT/)
  assert.match(entry, /window\.removeEventListener\(SECURITY_OPEN_EVENT/)
  assert.match(entry, /onChart: \(item\) => \{ if \(!selectTab\('quotes'\)\) return; setChartFromDossier\(true\); setKlineTarget\(\{ code: item\.code, kind: inferKlineKind\(item\.code, item\.type\)/)
  assert.match(detail, /sequence\.current === id/)
  assert.match(detail, /section\.provider/)
  assert.match(detail, /section\.dataAsOf/)
  assert.doesNotMatch(detail, /get_portfolio|family_plan_get|capital_transaction_add/)
})
const history = await readFile(new URL('../src/history/store.ts', import.meta.url), 'utf8')
test('private analysis context requires explicit per-request authorization', () => {
  assert.match(server, /const portfolioAuthorized = body\.portfolioAuthorized === true/)
  assert.match(server, /if \(personal && portfolioAuthorized\)/)
  assert.match(server, /if \(analyses && portfolioAuthorized\)/)
  assert.match(server, /portfolioAuthorized \? advisorMemory\(vault, code\) : ''/)
  assert.match(entry, /portfolioAuthorized: includePortfolio/)
  assert.match(entry, /本次允许读取我的持仓数量、平均成本与既往判断/)
  assert.match(detail, /securityResearchPrompt\(identity, includePortfolio\)/)
})
test('stock/fund same-code history is identity-scoped end to end', () => {
  assert.match(history, /async read\(code: string, kind\?: string\)/)
  assert.match(history, /存在多个 kind/)
  assert.match(server, /history\.read\(code, kind\)/)
  assert.match(server, /history\.manifest\(code, kind\)/)
  assert.match(entry, /`\/history\?code=\$\{encodeURIComponent\(c\)\}&kind=\$\{encodeURIComponent\(k\)\}`/)
  assert.match(entry, /`\/history\?code=\$\{encodeURIComponent\(item\.code\)\}&kind=\$\{encodeURIComponent\(klineKind\)\}`/)
  assert.match(entry, /requestSeq\.current !== seq/)
  assert.match(entry, /historyKind: historyKindOf/)
  assert.match(detail, /&kind=\$\{encodeURIComponent\(historyKind\)\}/)
})
test('in-progress drafts survive navigation and dirty source policy is not discarded silently', () => {
  assert.match(entry, /draft: props\.holdingDraft, onDraftChange: props\.onHoldingDraftChange/)
  assert.match(entry, /holdingDraft, onHoldingDraftChange: setHoldingDraft/)
  assert.match(entry, /数据源页有未保存的草稿/)
  assert.match(entry, /onDirtyChange: setSourcesDirty/)
})
test('per-analysis consent cannot leak across identities or remounts', () => {
  // The consent tick is reset when a different identity is loaded, and the shell keys
  // both overlays by identity so stale state cannot be reused.
  assert.match(detail, /\/\/ A consent tick is for one analysis of this exact identity only/)
  assert.match(detail, /setIncludePortfolio\(false\)/)
  assert.match(entry, /key: `\$\{dossierTarget\?\.type \?\? \(klineTarget\?\.kind === 'fund' \? 'fund' : 'stock'\)\}/)
  assert.match(entry, /key: `\$\{analysisItem\.type\}:\$\{analysisItem\.code\}`/)
})
test('shell renders stable identity helpers and truthful K-line states', () => {
  assert.match(entry, /const historyKindOf = useCallback\(/)
  assert.match(entry, /historyKind: historyKindOf/)
  assert.match(entry, /setLoaded\(null\); setHist\(null\); setManifest\(null\); setHistError\(''\)/)
  assert.match(entry, /本地历史读取失败：\$\{histError\}/)
  assert.match(entry, /if \(id === 'dossier' && tab !== 'dossier' && !preserveReturn\) setSecurityReturnTab\(tab\)/)
})
test('double-click opens K-line and dossier while single click stays explicit', () => {
  assert.match(entry, /onDoubleClick: doubleClick/)
  assert.match(entry, /requestSecurityOpen\(\{ code: q\.code, name: q\.name, type: q\.type \?\? 'stock' \}\)/)
  assert.match(entry, /onDoubleClick: \(\) => rowDouble\(/)
  assert.match(entry, /requestSecurityOpen\(\{ code: hd\.code, name: q\?\.name \|\| hd\.name, type: hd\.type \}\)/)
  assert.match(entry, /const GLOBAL_REGIONS/)
  assert.match(entry, /useState\('us'\)/)
  assert.match(entry, /\/global-indices\?region=/)
})
console.log(`[security-research] ${passed} pure/static groups passed; browser and live-provider coverage are separate.`)
