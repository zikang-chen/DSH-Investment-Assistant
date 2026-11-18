/** Offline synthetic fixtures only. No network, portfolio, account or research data. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { companyOverviewFields, dossierName, dossierRows } from '../src/client/security-model.js'

let passed = 0
const test = (name: string, run: () => void) => { run(); passed++; console.log(`PASS ${name}`) }
const values = (data: unknown) => companyOverviewFields(data).map(field => field.value)

test('provider CompanySurvey keys are readable and metadata remains separate', () => {
  const fields = companyOverviewFields({ name: '测试简称', orgName: '测试公司', industry: '测试行业', region: '测试地区', listingDate: '2020-01-01', mainBusiness: '主营\n第二行', businessScope: '范围', profile: '简介', website: 'https://example.invalid', meta: { provider: 'fixture', endpointRef: 'fixture://survey', retrievedAt: '2026-01-02', contractVerified: false, reportPeriod: '2025-12-31', unit: '原始单位', currency: 'CNY', missing: ['region'] } })
  for (const label of ['证券简称', '公司名称', '所属行业', '所在地区', '上市日期', '主营业务', '经营范围', '公司简介', '公司网站']) assert.ok(fields.some(field => field.label === label && !field.metadata), label)
  assert.ok(fields.some(field => field.metadata && field.label.endsWith('上游契约已核验') && field.value === 'false'))
  assert.ok(fields.some(field => field.label.includes('抓取时间（非数据时点）')))
  assert.ok(fields.some(field => field.label.includes('报告期') && field.value === '2025-12-31'))
  assert.ok(fields.some(field => field.label.includes('缺失字段') && field.value === 'region'))
})
test('nested arrays and object wrappers preserve all records, siblings and metadata', () => {
  const data = { result: { data: [{ ORG_NAME: '公司甲', MAIN_BUSINESS: '业务甲', employees: 0 }, { ORG_NAME: '公司乙', MAIN_BUSINESS: '业务乙', customKey: { detail: false } }], total: 2 }, meta: { source: 'fixture', unit: '人' }, warnings: ['未核验'], profile: { text: '嵌套简介' } }
  const fields = companyOverviewFields(data)
  assert.deepEqual(values(data), ['公司甲', '业务甲', '0', '公司乙', '业务乙', 'false', '2', 'fixture', '人', '未核验', '嵌套简介'])
  assert.ok(fields.some(field => field.label.includes('第 2 项') && field.label.includes('customKey / detail')))
  assert.equal(new Set(fields.map(field => field.key)).size, fields.length)
  assert.ok(!values(data).some(value => value.includes('[object Object]')))
  assert.equal(fields.find(field => field.value === '嵌套简介')?.metadata, false)
})
test('legacy field/value arrays retain extra columns and unknown fields', () => {
  const fields = companyOverviewFields([{ 字段: '公司名称', 值: '测试公司', 单位: '原始口径' }, { field: 'mainBusiness', value: { products: ['甲', '乙'] }, metadata: { checked: false } }])
  assert.ok(fields.some(field => field.label.endsWith('公司名称') && field.value === '测试公司'))
  assert.ok(fields.some(field => field.label.endsWith('单位') && field.value === '原始口径'))
  assert.ok(fields.some(field => field.label.includes('主营业务 / products / 第 2 项') && field.value === '乙'))
  assert.ok(fields.some(field => field.metadata && field.value === 'false'))
})
test('zero, false, null and empty values are not conflated or fabricated', () => {
  assert.deepEqual(values({ zero: 0, negative: -1, checked: false, missingValue: null, blank: '', emptyRows: [], emptyObject: {} }), ['0', '-1', 'false', '—', '—', '[]', '{}'])
  assert.equal(companyOverviewFields({ constructor: '未知字段值' })[0]?.label, 'constructor')
  assert.deepEqual(companyOverviewFields(undefined), [])
  assert.deepEqual(companyOverviewFields(null), [])
  const circular: Record<string, unknown> = {}; circular.self = circular
  assert.deepEqual(values(circular), ['（循环引用，无法展开）'])
})
test('name header recognizes normalized and nested company names, excluding metadata', () => {
  const dossier = (data: unknown) => ({ ok: true, code: '000001', at: '2026-01-01', ready: 1, total: 1, elapsedMs: 0, sections: [{ key: 'company_survey', label: '概况', group: '基本面', ok: true, rows: 1, ms: 0, data }] })
  assert.equal(dossierName(dossier({ name: '测试简称' })), '测试简称')
  assert.equal(dossierName(dossier({ result: { data: [{ ORG_NAME: '嵌套公司' }] } })), '嵌套公司')
  assert.equal(dossierName(dossier({ meta: { name: '非公司名' } }), '候选名'), '候选名')
  assert.equal(dossierName(dossier([{ 字段: '基金名称', 值: '测试基金' }])), '测试基金')
})
test('generic financial tables retain their existing row and unit contracts', () => {
  assert.deepEqual(dossierRows({ rows: [{ revenue: 0 }], meta: { unit: '元' } }), [{ unit: '元', revenue: '0' }])
})
const workspace = await readFile(new URL('../src/client/security-workspace.tsx', import.meta.url), 'utf8')
test('overview uses bounded two-column wrapping without hiding long narratives or metadata', () => {
  assert.match(workspace, /\['overview', 'company_survey'\]\.includes\(section\.key\)/)
  assert.match(workspace, /tableLayout: 'fixed'/)
  assert.match(workspace, /whiteSpace: 'pre-wrap'/)
  assert.match(workspace, /overflowWrap: 'anywhere'/)
  assert.match(workspace, /renderFields\(false\).*renderFields\(true\)/)
  const overview = workspace.slice(workspace.indexOf("if (['overview', 'company_survey']"), workspace.indexOf('const rows = dossierRows(section.data)'))
  assert.doesNotMatch(overview, /slice\(|lineClamp|textOverflow/)
  assert.match(overview, /rel="noopener noreferrer"/)
})
console.log(`[company-overview] ${passed} offline fixture/static groups passed; no live-provider or browser verification claimed.`)
