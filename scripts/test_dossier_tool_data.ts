/** Offline fixture/contract tests only. No real providers, files/config writes, network or private data. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dossierToolResult, DOSSIER_TOOL_LIMITS } from '../src/tools/dossier-data.js'
import { dossierSnapshotId, type DossierSection, type StockDossier } from '../src/data/dossier.js'
import { registerTools } from '../src/tools/register.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`) }
const section = (data?: unknown, extra: Partial<DossierSection> = {}): DossierSection => ({
  key: 'main_financials', label: '主要财务指标（测试夹具）', group: '基本面', ok: true,
  status: 'ready', rows: Array.isArray(data) ? data.length : data && typeof data === 'object' ? Object.keys(data).length : 0,
  provider: 'fixture-provider', dataAsOf: '2026-09-30', missing: ['测试夹具：尚未核验上游契约'], ms: 12,
  ...(data !== undefined ? { data } : {}), ...extra,
})
const dossier = (sections: DossierSection[], extra: Partial<StockDossier> = {}): StockDossier => ({
  code: '000001', type: 'stock', at: '2026-11-17T02:00:00.000Z', snapshotId: 'fixture-snapshot-id',
  ready: sections.filter((s) => s.status === 'ready').length, total: sections.length, elapsedMs: 20, sections, ...extra,
})
const shapeCount = (value: unknown): number => Array.isArray(value) || typeof value === 'string' ? value.length
  : value && typeof value === 'object' ? Object.keys(value).length : value == null ? 0 : 1
function assertBounds(result: ReturnType<typeof dossierToolResult>) {
  const actualDataChars = result.sections.reduce((sum, s) => sum + (s.data === undefined ? 0 : JSON.stringify(s.data).length), 0)
  assert.equal(result.dataPresentation.dataChars, actualDataChars)
  assert.ok(actualDataChars <= DOSSIER_TOOL_LIMITS.maxTotalDataChars)
  assert.ok(JSON.stringify(result, null, 2).length <= DOSSIER_TOOL_LIMITS.maxRenderedChars)
  assert.equal(result.dataPresentation.sections.returnedCount, result.sections.length)
  assert.equal(result.dataPresentation.sections.omittedCount + result.sections.length, result.dataPresentation.sections.originalCount)
  for (const s of result.sections) {
    assert.equal(s.dataPresentation.returnedCount, shapeCount(s.data), s.key)
    assert.ok((s.data === undefined ? 0 : JSON.stringify(s.data).length) <= DOSSIER_TOOL_LIMITS.maxSectionDataChars)
    assert.ok(s.dataPresentation.events.length <= DOSSIER_TOOL_LIMITS.maxEventsPerSection)
    const visit = (value: unknown, depth: number) => {
      if (Array.isArray(value)) { assert.ok(value.length <= DOSSIER_TOOL_LIMITS.maxArrayItems); value.forEach((child) => visit(child, depth + 1)) }
      else if (value && typeof value === 'object') { assert.ok(Object.keys(value).length <= DOSSIER_TOOL_LIMITS.maxObjectFields); Object.values(value).forEach((child) => visit(child, depth + 1)) }
      else if (typeof value === 'string') assert.ok(value.length <= DOSSIER_TOOL_LIMITS.maxStringChars)
      assert.ok(depth <= DOSSIER_TOOL_LIMITS.maxDepth)
    }
    if (s.data !== undefined) visit(s.data, 0)
  }
}

check('real array fields, units, literal zero/null and source metadata survive', () => {
  const rows = [{ 报告期: '2026Q3', 营业收入: 123.45, 单位: '亿元', 利润: 0, 缺失EPS: null }, { 报告期: '2025Q3', 营业收入: 100, 单位: '亿元' }]
  const d = dossier([section(rows)])
  const result = dossierToolResult(d)
  assert.deepEqual(result.sections[0]?.data, rows)
  assert.equal(result.sections[0]?.dataAsOf, '2026-09-30')
  assert.equal(result.sections[0]?.provider, 'fixture-provider')
  assert.deepEqual(result.sections[0]?.missing, d.sections[0]?.missing)
  assert.equal(result.sections[0]?.dataPresentation.truncated, false)
  assert.equal(result.code, '000001')
  assert.equal(result.at, d.at)
  assert.equal(result.snapshotId, d.snapshotId)
  assertBounds(result)
})
check('row prefixes disclose actual source and returned counts without changing rows', () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({ index, 比例: `${index}%`, 来源日期: '2026-09-30' }))
  const result = dossierToolResult(dossier([section(rows)]))
  const output = result.sections[0]!
  assert.deepEqual(output.data, rows.slice(0, 6))
  assert.equal(output.rows, 15)
  assert.equal(output.dataPresentation.sourceCount, 15)
  assert.equal(output.dataPresentation.returnedCount, 6)
  assert.equal(output.dataPresentation.selection, 'array-prefix')
  assert.deepEqual(output.dataPresentation.events.find((event) => event.path === 'data'), { path: 'data', reasons: ['array-item-limit'], originalCount: 15, returnedCount: 6, unit: 'items' })
  assert.equal(result.dataPresentation.truncated, true)
  assertBounds(result)
})
check('large objects preserve original names and prioritize units/source metadata', () => {
  const data = { ...Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`原字段_${index}`, index])), meta: { currency: 'CNY', unit: '元', endpointRef: 'fixture-ref', reportPeriod: '2026Q3', contractVerified: false } }
  const result = dossierToolResult(dossier([section(data)]))
  const output = result.sections[0]!
  assert.equal(Object.keys(output.data as object).length, 30)
  assert.deepEqual((output.data as Record<string, unknown>).meta, data.meta)
  assert.equal((output.data as Record<string, unknown>).原字段_0, 0)
  assert.equal(Object.hasOwn(output.data as object, '原字段_44'), false)
  assert.equal(output.dataPresentation.selection, 'metadata-first-then-source-order')
  assert.equal(output.dataPresentation.sourceCount, 46)
  assert.equal(output.dataPresentation.returnedCount, 30)
  assertBounds(result)
})
check('nested history objects retain report periods/units and expose nested array truncation', () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ reportPeriod: `fixture-${index}`, revenue: 500 + index, unit: '万元' }))
  const data = { history, latest: history[0], meta: { asOf: '2026-09-30', currency: 'CNY', missing: ['利润率缺失'] } }
  const result = dossierToolResult(dossier([section(data)]))
  const output = result.sections[0]!
  assert.deepEqual((output.data as Record<string, unknown>).history, history.slice(0, 6))
  assert.equal(output.dataPresentation.events.find((event) => event.path === 'data.history')?.returnedCount, 6)
  assert.equal(output.dataPresentation.countUnit, 'fields')
  assert.equal(output.rows, 3)
  assertBounds(result)
})
check('missing/error/unsupported statuses are retained without synthetic arrays, dates or zeros', () => {
  const sections = [
    section(undefined, { key: 'error', ok: false, status: 'error', rows: 0, error: 'fixture unavailable', dataAsOf: undefined, provider: undefined, missing: ['实际报告期未知'] }),
    section(undefined, { key: 'unsupported', ok: false, status: 'unsupported', rows: 0, error: '该资产不适用' }),
    section([], { key: 'empty', ok: true, status: 'empty', rows: 0 }),
    section(null, { key: 'null', ok: false, status: 'empty', rows: 0 }),
  ]
  const result = dossierToolResult(dossier(sections))
  assert.equal(result.sections[0]?.status, 'error')
  assert.equal(result.sections[0]?.data, undefined)
  assert.equal(result.sections[0]?.dataAsOf, undefined)
  assert.equal(result.sections[0]?.provider, undefined)
  assert.equal(result.sections[0]?.dataPresentation.sourceKind, 'missing')
  assert.equal(result.sections[0]?.dataPresentation.truncated, false)
  assert.equal(result.sections[1]?.status, 'unsupported')
  assert.deepEqual(result.sections[2]?.data, [])
  assert.equal(result.sections[2]?.dataPresentation.truncated, false)
  assert.equal(result.sections[3]?.data, null)
  assert.equal(result.sections[3]?.dataPresentation.sourceKind, 'null')
  assertBounds(result)
})
check('long text remains a truthful UTF-16 prefix with explicit truncation', () => {
  const text = '真实长文🧪"\\\n'.repeat(1200)
  const result = dossierToolResult(dossier([section({ 正文: text })]))
  const returned = (result.sections[0]?.data as Record<string, string>).正文!
  assert.ok(text.startsWith(returned))
  assert.ok(returned.length <= 1200)
  assert.doesNotMatch(returned, /[\uD800-\uDBFF]$/)
  const event = result.sections[0]?.dataPresentation.events.find((event) => event.path === 'data.正文')!
  assert.equal(event.originalCount, text.length)
  assert.equal(event.returnedCount, returned.length)
  assertBounds(result)
})
check('depth, circular and non-JSON values are explicit omissions rather than fabricated data', () => {
  const circular: Record<string, unknown> = { literalZero: 0, finite: 1.25, invalid: NaN, unsafe: Infinity, optional: undefined }
  circular.self = circular
  circular.deep = { a: { b: { c: { d: { e: { hidden: 'too deep' } } } } } }
  const result = dossierToolResult(dossier([section(circular)]))
  const data = result.sections[0]?.data as Record<string, unknown>
  assert.equal(data.literalZero, 0)
  assert.equal(data.finite, 1.25)
  assert.equal(Object.hasOwn(data, 'invalid'), false)
  assert.equal(Object.hasOwn(data, 'unsafe'), false)
  assert.equal(Object.hasOwn(data, 'self'), false)
  assert.equal(result.sections[0]?.dataPresentation.truncated, true)
  assert.ok(result.sections[0]?.dataPresentation.events.some((event) => event.reasons.includes('circular-value-omitted')))
  assert.ok(result.sections[0]?.dataPresentation.events.some((event) => event.reasons.includes('depth-limit')))
  assertBounds(result)
})
check('metadata truncation is explicit while errors and missing reasons retain their prefixes', () => {
  const missing = Array.from({ length: 20 }, (_, index) => `missing_${index}_` + '未核验'.repeat(120))
  const result = dossierToolResult(dossier([section(undefined, { status: 'error', ok: false, error: '错误细节'.repeat(400), missing })]))
  const output = result.sections[0]!
  assert.ok(output.error!.length <= 320)
  assert.equal(output.missing?.length, 6)
  assert.ok(missing[0]!.startsWith(output.missing![0]!))
  assert.ok(output.dataPresentation.events.some((event) => event.path === 'missing' && event.originalCount === 20 && event.returnedCount === 6))
  assert.equal(output.dataPresentation.truncated, true)
  assertBounds(result)
})
check('global data and rendered-response budgets are respected for adversarial large inputs', () => {
  const huge = Array.from({ length: 80 }, (_, index) => section(Array.from({ length: 40 }, (_, row) => ({ row, 内容: 'x"\\\n'.repeat(1000), meta: { unit: '亿元', source: 'fixture' } })), {
    key: `section_${index}`, label: '很长标签'.repeat(150), error: '错误'.repeat(400), missing: Array.from({ length: 12 }, () => '缺字段'.repeat(200)),
  }))
  const result = dossierToolResult(dossier(huge))
  assert.equal(result.dataPresentation.truncated, true)
  assert.ok(result.sections.length <= DOSSIER_TOOL_LIMITS.maxSections)
  assert.equal(result.dataPresentation.sections.originalCount, 80)
  assert.ok(result.dataPresentation.sections.omittedCount > 0)
  assertBounds(result)
})
check('total budget omissions do not masquerade as empty successful data', () => {
  const sections = Array.from({ length: 25 }, (_, index) => section(Array.from({ length: 6 }, () => ({ one: 'a'.repeat(1200), two: 'b'.repeat(1200), three: 'c'.repeat(1200) })), { key: `fixture_${index}`, missing: [] }))
  const result = dossierToolResult(dossier(sections))
  assert.ok(result.sections.some((s) => s.dataPresentation.omittedReason || s.dataPresentation.returnedCount < s.dataPresentation.sourceCount))
  for (const output of result.sections.filter((s) => s.data === undefined)) {
    assert.equal(output.status, 'ready', 'upstream status is not rewritten by presentation')
    assert.equal(output.rows, 6)
    assert.equal(output.dataPresentation.truncated, true)
    assert.equal(output.dataPresentation.returnedCount, 0)
    assert.ok(output.dataPresentation.omittedReason)
  }
  assertBounds(result)
})
check('event logs are bounded and explicitly count additional omitted details', () => {
  const data = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`missing_${index}`, undefined]))
  const result = dossierToolResult(dossier([section(data)]))
  const presentation = result.sections[0]!.dataPresentation
  assert.equal(presentation.events.length, DOSSIER_TOOL_LIMITS.maxEventsPerSection)
  assert.equal(presentation.omittedEventCount, 19, '30 missing values plus one object omission, 12 visible events')
  assert.equal(presentation.sourceCount, 30)
  assert.equal(presentation.returnedCount, 0)
  assert.equal(presentation.truncated, true)
  assertBounds(result)
})
check('rendered-output omissions retain metadata date truncation rather than stale data ranges', () => {
  const inputs = Array.from({ length: 32 }, (_, index) => section(Array.from({ length: 8 }, () => ({ text: 'x'.repeat(1600), reportPeriod: '2026Q3' })), {
    key: `section_${index}`, label: '标签'.repeat(100), group: '分组'.repeat(80), provider: 'fixture'.repeat(40),
    dataAsOf: '2026-09-30 fixture '.repeat(30), error: '错误'.repeat(200), missing: Array.from({ length: 6 }, () => '未核实字段'.repeat(100)),
  }))
  const result = dossierToolResult(dossier(inputs))
  const omitted = result.sections.filter((s) => s.dataPresentation.omittedReason === 'rendered-output-budget')
  assert.ok(omitted.length > 0)
  for (const output of omitted) {
    assert.equal(output.data, undefined)
    assert.equal(output.dataPresentation.events.find((event) => event.path === 'data')?.returnedCount, 0)
    assert.ok(output.dataPresentation.events.some((event) => event.path === 'dataAsOf'), 'source date metadata truncation must remain visible')
    assert.equal(output.dataPresentation.events.some((event) => event.path.startsWith('data[') || event.path.startsWith('data.')), false)
    assert.ok(output.dataPresentation.omittedEventCount >= 0)
  }
  assertBounds(result)
})
check('preview is deterministic, independent and does not change content-addressed snapshot', () => {
  const d = dossier([section({ history: [{ value: 123, 单位: '亿元' }], meta: { currency: 'CNY', contractVerified: false } })])
  const before = JSON.stringify(d)
  const hash = dossierSnapshotId(d)
  const first = dossierToolResult(d)
  assert.deepEqual(first, dossierToolResult(d))
  const data = first.sections[0]?.data as Record<string, unknown>
  ;(data.history as Array<Record<string, unknown>>)[0]!.value = 999
  assert.equal(JSON.stringify(d), before)
  assert.equal(dossierSnapshotId(d), hash)
})
check('fund risk/holdings previews retain true fields and route to real follow-up tools', () => {
  const holdings = Array.from({ length: 10 }, (_, index) => ({ 代码: `00000${index}`, 名称: `fixture${index}`, 占净值比例: '3.25' }))
  const result = dossierToolResult(dossier([
    section(holdings, { key: 'holdings', label: '重仓持仓（前10）', missing: ['上游字段按模式解析，未线上核实'] }),
    section([{ 指标: '最大回撤 %', 值: '15.25', 口径: '绝对值（15=15%）' }], { key: 'risk_metrics' }),
    section({ raw: 'fixture-profile' }, { key: 'manager', dataAsOf: undefined }),
  ], { type: 'fund', code: '110022' }), '基金深度档案')
  assert.deepEqual(result.sections[0]?.data, holdings.slice(0, 6))
  assert.equal(result.sections[0]?.dataPresentation.followUp.tool, 'westock_call')
  assert.equal(result.sections[0]?.dataPresentation.followUp.args.capability, 'fund_holdings')
  assert.equal(result.sections[1]?.dataPresentation.followUp.tool, 'calculate_fund_metrics')
  assert.equal(result.sections[2]?.dataPresentation.followUp.tool, 'get_fund_quote')
  assert.equal(result.sections[2]?.dataAsOf, undefined)
  assert.match(result.dataPresentation.note, /非完整年报/)
  assertBounds(result)
})
check('special property names do not mutate prototypes or rename source fields', () => {
  const data = JSON.parse('{"__proto__":{"unit":"亿元"},"constructor":12,"normal":0}')
  const output = dossierToolResult(dossier([section(data)])).sections[0]?.data as Record<string, unknown>
  assert.equal(Object.hasOwn(output, '__proto__'), true)
  assert.deepEqual(output.__proto__, { unit: '亿元' })
  assert.equal(output.constructor, 12)
  assert.equal(output.normal, 0)
})

await checkAsync('registered stock/fund tools return actual fixture data and preserve snapshot registration', async () => {
  type Result = ReturnType<typeof dossierToolResult>
  const tools: Record<string, { name: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>, context?: unknown) => Promise<Result> }> = {}
  const snapshots: unknown[][] = []
  const financials = { history: [{ reportPeriod: '2026Q3', revenue: 12345, revenueUnit: '万元' }], meta: { asOf: '2026-09-30', currency: 'CNY', contractVerified: false, missing: ['fixture contract unchecked'] } }
  const fakeFinance = {
    westock: async (capability: string) => capability === 'main_financials'
      ? { ok: true, provider: 'fixture_financials', data: financials }
      : { ok: false, error: `fixture-unavailable:${capability}` },
    getFundQuote: async () => ({ ok: true, provider: 'fixture_nav', data: { code: '110022', name: '夹具基金', price: 1.2345, asOf: '2026-11-13', raw: { navDate: '2026-11-13', profile: {} } } }),
    getFundKline: async () => ({ ok: false, error: 'fixture-no-nav-history' }),
    getFundHoldings: async () => ({ ok: true, provider: 'fixture_holdings', data: [{ code: '600000', name: '夹具公司', weightPct: 3.25 }] }),
    getKline: async () => { throw new Error('unexpected benchmark request in offline fixture') },
  }
  const ctx = { tools: { register: (tool: { name: string }) => { tools[tool.name] = tool as never } } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network forbidden in dossier unit tests') }
  try {
    registerTools(ctx as never, fakeFinance as never, {} as never, { noteSnapshot: async (...args: unknown[]) => { snapshots.push(args) } } as never, {} as never)
    assert.deepEqual(Object.keys(tools.stock_dossier!.parameters.properties as object), ['code', 'type'])
    assert.deepEqual(Object.keys(tools.fund_dossier!.parameters.properties as object), ['code', 'benchmark'])
    const stock = await tools.stock_dossier!.execute({ code: '000001', type: 'stock' })
    const financialSection = stock.sections.find((s) => s.key === 'main_financials')!
    assert.deepEqual(JSON.parse(JSON.stringify(financialSection.data)), financials)
    assert.equal(financialSection.dataAsOf, '2026-09-30')
    assert.equal(financialSection.provider, 'fixture_financials')
    assert.equal(stock.sections.find((s) => s.key === 'money_flow')?.status, 'error')
    assert.equal(stock.sections.find((s) => s.key === 'money_flow')?.data, undefined)
    assert.deepEqual(snapshots[0], [stock.snapshotId, '000001', 'stock'])
    const fund = await tools.fund_dossier!.execute({ code: '110022', benchmark: 'none' })
    assert.equal((fund.sections.find((s) => s.key === 'overview')?.data as Array<Record<string, unknown>>).find((row) => row.字段 === '最新净值')?.值, '1.2345')
    assert.deepEqual(fund.sections.find((s) => s.key === 'holdings')?.data, [{ 代码: '600000', 名称: '夹具公司', 占净值比例: '3.25' }])
    assert.equal(fund.sections.find((s) => s.key === 'risk_metrics')?.status, 'error')
    assert.deepEqual(snapshots[1], [fund.snapshotId, '110022', 'fund'])
    assert.equal(snapshots.length, 2)
    assertBounds(stock); assertBounds(fund)
  } finally { globalThis.fetch = originalFetch }
})

const [helper, registerSource] = await Promise.all([
  readFile(new URL('../src/tools/dossier-data.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/tools/register.ts', import.meta.url), 'utf8'),
])
check('static: only two dossier execute mappings use the helper; builders and snapshot calls remain', () => {
  assert.equal([...registerSource.matchAll(/return asJson\(dossierToolResult\(/g)].length, 2)
  assert.match(registerSource, /await buildStockDossier\(finance, code, type\)/)
  assert.match(registerSource, /await analyses\.noteSnapshot\(d\.snapshotId, code, type\)/)
  assert.match(registerSource, /await buildFundDossier\(finance, code, \{ benchmark: args\.benchmark \? String\(args\.benchmark\) : undefined \}\)/)
  assert.match(registerSource, /await analyses\.noteSnapshot\(d\.snapshotId, code, 'fund'\)/)
  assert.doesNotMatch(helper, /\bfetch\s*\(|readFile\(|writeFile\(|\.execute\(|\.westock\(|console\.|Date\.now\(/)
  assert.match(helper, /dataAsOf: clipMeta\(section\.dataAsOf/)
})
console.log(`\n${checks} dossier tool data checks passed (offline fixtures + static contracts, no live provider verification).`)
