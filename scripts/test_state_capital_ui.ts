/** Pure formatting, real React element trees and static wiring only; not browser/layout acceptance.
 * Fixtures are synthetic test inputs. No network, server, screenshot or real data files are used.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import ts from 'typescript'
import {
  StateCapitalPanel, formatStateCapitalDate, formatStateCapitalPercentage, formatStateCapitalQuantity,
  stateCapitalAddRequest, stateCapitalCheckRequest, stateCapitalConfigureRequest, stateCapitalDiffLabel,
  stateCapitalPanelCss, stateCapitalSourceUrl,
  type StateCapitalCatalogEntry, type StateCapitalDiffView, type StateCapitalTargetView,
} from '../src/client/state-capital-panel.js'
import type { StateCapitalDisclosure } from '../src/state-capital.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
type TestProps = Record<string, unknown> & { children?: ReactNode }
type TestElement = ReactElement<TestProps>

// This component is intentionally pure. Expanding its function components here checks real props
// and explicit click handlers, without pretending to test browser focus, scrolling or rendering.
function elements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as TestElement
  if (typeof element.type === 'function') return elements((element.type as (props: TestProps) => ReactNode)(element.props))
  return [element, ...elements(element.props.children)]
}
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (!isValidElement(node)) return ''
  const element = node as TestElement
  if (typeof element.type === 'function') return text((element.type as (props: TestProps) => ReactNode)(element.props))
  return element.type === 'style' ? '' : text(element.props.children)
}
const click = (element: TestElement) => {
  assert.equal(typeof element.props.onClick, 'function')
  ;(element.props.onClick as () => void)()
}

const catalog: StateCapitalCatalogEntry[] = [
  { id: 'huijin', name: '汇金本体测试主体', aliases: ['汇金本体'], recommendedCodes: [] },
  { id: 'huijin-asset', name: '汇金资产测试主体', aliases: ['汇金资产'], recommendedCodes: ['601288', '601398'] },
  { id: 'csf', name: '证金测试主体', aliases: ['证金'], recommendedCodes: ['601939'] },
]
const disclosure: StateCapitalDisclosure = {
  entityId: 'huijin', entityName: '汇金本体测试主体', scopeId: 'test-official-register',
  asOf: '2026-06-30', disclosedAt: null, capturedAt: '2026-11-25T08:09:10.123Z',
  sources: [
    { url: 'https://example.org/register', title: '测试官方股权表', hash: 'test-official-hash', level: 'official', publishedAt: null },
    { url: 'https://example.org/secondary', title: '测试聚合索引', hash: 'test-aggregated-hash', level: 'aggregated', publishedAt: '2026-08-01' },
  ],
  holdings: [
    { key: 'equity-test', name: '测试股权甲', code: '000001', assetType: 'equity', quantity: 1250000, unit: '股', rawQuantity: '125万股', percentage: 12.5, denominator: '总股本', holdingMode: 'direct', asOf: '2026-06-30', disclosedAt: null, sourceUrl: 'https://example.org/register', sourceHash: 'test-official-hash', locator: '股权表第2行' },
    { key: 'fund-test', name: '测试基金乙', assetType: 'fund', quantity: null, unit: '份', rawQuantity: '未披露', percentage: null, denominator: '基金总份额', holdingMode: 'indirect', asOf: null, disclosedAt: '2026-08-01', sourceUrl: 'javascript:alert(1)', sourceHash: 'test-aggregated-hash', locator: '中报持有人章节' },
  ],
  coverage: '仅限测试主体具名公开条目，不包含完整证券账户', warnings: ['测试口径：未核验拆分，不据此推断期间交易'],
}
const compared: StateCapitalDiffView = {
  status: 'compared', warnings: ['报告期末数量不能还原期间交易'], rows: [
    { key: 'up', name: '测试增加', code: '000001', status: 'quantity-increased', previousQuantity: 10, nextQuantity: 12, delta: 2, unit: '股', note: '同口径数量对照' },
    { key: 'missing', name: '测试未披露', status: 'not-disclosed', previousQuantity: 8, nextQuantity: null, delta: null, unit: '份', note: '本期未列示；不是持仓归零' },
    { key: 'new', name: '测试本期观察', status: 'newly-disclosed', previousQuantity: null, nextQuantity: 3, delta: null, unit: '元', note: '前期未知' },
  ],
}
const target: StateCapitalTargetView = { id: 'state-test-huijin', name: '汇金本体测试主体', kind: 'cn-state', stateEntityId: 'huijin', autoCheck: false, stateCapital: { latest: disclosure, diff: compared } }
const source = await readFile(new URL('../src/client/state-capital-panel.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('state-capital-panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

check('quantity formatting preserves original unit, real zero and fractional detail; missing stays unknown', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(formatStateCapitalQuantity(value, '股'), '未知')
  assert.equal(formatStateCapitalQuantity(0, '份'), '0 份')
  assert.equal(formatStateCapitalQuantity(1250000, '股'), '1,250,000 股')
  assert.equal(formatStateCapitalQuantity(1.23456789, '元'), '1.23456789 元')
  assert.equal(formatStateCapitalQuantity(2, '股', true), '+2 股')
  assert.equal(formatStateCapitalQuantity(-2, '股', true), '−2 股')
})

check('dates keep unknown report/disclosure distinct from capture, preserving timezone', () => {
  for (const value of [null, undefined, '', '  ']) assert.equal(formatStateCapitalDate(value), '未知')
  assert.equal(formatStateCapitalDate('2026-06-30'), '2026-06-30')
  assert.equal(formatStateCapitalDate('2026-11-25T08:09:10.123Z'), '2026-11-25 08:09:10 UTC')
  assert.equal(formatStateCapitalDate('2026-11-25T16:09:10+08:00'), '2026-11-25 16:09:10+08:00')
})

check('percentage is source percent, not ratio; denominator is always explicit', () => {
  assert.equal(formatStateCapitalPercentage(0.5, '总股本'), '0.5% · 分母：总股本')
  assert.equal(formatStateCapitalPercentage(0, '基金总份额'), '0% · 分母：基金总份额')
  assert.equal(formatStateCapitalPercentage(null, '基金总份额'), '未知 · 分母：基金总份额')
  assert.equal(formatStateCapitalPercentage(Infinity, ''), '未知 · 分母：未知')
})

check('only absolute http(s) evidence URLs become links', () => {
  assert.equal(stateCapitalSourceUrl('https://example.org/path?q=1#p2'), 'https://example.org/path?q=1#p2')
  assert.equal(stateCapitalSourceUrl(' HTTP://example.org/path '), 'http://example.org/path')
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/x', '//example.org/a', '/relative', 'https:example.org', 'https://', 'https://user:pass@example.org']) assert.equal(stateCapitalSourceUrl(url), undefined, url)
})

check('difference labels never turn first observation or absent disclosure into transactions', () => {
  assert.equal(stateCapitalDiffLabel('first-observation'), '首次观察')
  assert.equal(stateCapitalDiffLabel('newly-disclosed'), '本期观察')
  assert.equal(stateCapitalDiffLabel('not-disclosed'), '本期未披露')
  assert.equal(stateCapitalDiffLabel('quantity-increased'), '期末数量增加')
  assert.equal(stateCapitalDiffLabel('quantity-decreased'), '期末数量减少')
  assert.equal(stateCapitalDiffLabel('same-period-revision'), '同报告期修订')
  assert.equal(stateCapitalDiffLabel('unrecognized'), '待核对')
  for (const status of ['first-observation', 'newly-disclosed', 'not-disclosed', 'quantity-increased', 'quantity-decreased']) assert.doesNotMatch(stateCapitalDiffLabel(status), /新进|清仓|加仓|减仓|买入|卖出/)
})

check('empty targets still show three separate subject cards with check entry points and no invented snapshot', () => {
  const requests: string[] = []
  const tree = createElement(StateCapitalPanel, { targets: [], onRequest: value => requests.push(value) })
  const nodes = elements(tree)
  assert.deepEqual(nodes.filter(node => node.type === 'article').map(node => node.props['data-state-entity']), ['huijin', 'huijin-asset', 'csf'])
  assert.equal(nodes.filter(node => node.props.role === 'status' && text(node) === '尚无可用快照').length, 3)
  const buttons = nodes.filter(node => node.type === 'button')
  assert.equal(buttons.length, 3)
  buttons.forEach(button => { assert.equal(button.props.type, 'button'); click(button) })
  assert.equal(requests.length, 3)
  assert.ok(requests.every(request => request.includes('follow_add') && request.includes('"autoCheck":false')))
  assert.match(text(tree), /非实时、非全量/)
})

check('explicit empty catalog has an accessible empty state rather than fabricated subjects', () => {
  const tree = createElement(StateCapitalPanel, { targets: [], catalog: [], onRequest: () => {} })
  assert.match(text(tree), /暂无国家资本主体/)
  assert.equal(elements(tree).filter(node => node.type === 'article').length, 0)
})

check('snapshot exposes three independent dates, raw quantity, denominator and ownership mode', () => {
  const before = JSON.stringify(disclosure)
  const tree = createElement(StateCapitalPanel, { targets: [target], catalog, onRequest: () => {} })
  const content = text(tree)
  for (const value of ['报告期2026-06-30', '披露日期未知', '抓取时间2026-11-25 08:09:10 UTC', disclosure.coverage, '1,250,000 股', '原文：125万股', '12.5% · 分母：总股本', '未知 · 分母：基金总份额', '直接持有', '间接持有', '官方一手 · official', '聚合转述 · aggregated']) assert.ok(content.includes(value), value)
  assert.equal(JSON.stringify(disclosure), before, 'rendering cannot mutate received evidence')
  assert.ok(elements(tree).some(node => node.type === 'details' && text(node).includes('test-official-hash')))
  assert.ok(elements(tree).some(node => node.type === 'details' && text(node).includes('股权表第2行')))
  const links = elements(tree).filter(node => node.type === 'a')
  assert.ok(links.length > 0)
  for (const link of links) {
    assert.match(String(link.props.href), /^https?:\/\//)
    assert.equal(link.props.target, '_blank')
    assert.equal(link.props.rel, 'noopener noreferrer')
  }
  assert.ok(!links.some(link => String(link.props.href).startsWith('javascript:')))
})

check('difference rows show end quantities without zeroing missing rows or manufacturing new-position deltas', () => {
  const tree = createElement(StateCapitalPanel, { targets: [target], catalog, onRequest: () => {} })
  const rows = elements(tree).filter(node => node.type === 'tr')
  const increased = rows.find(node => text(node).includes('测试增加'))!
  assert.match(text(increased), /期末数量增加10 股12 股\+2 股/)
  const missing = rows.find(node => text(node).includes('测试未披露'))!
  assert.match(text(missing), /本期未披露8 份未知不可比/)
  assert.doesNotMatch(text(missing), /0 份/)
  const observed = rows.find(node => text(node).includes('测试本期观察'))!
  assert.match(text(observed), /本期观察未知3 元不可比/)
  assert.doesNotMatch(text(observed), /\+3|新进/)
  const changed: StateCapitalTargetView = { ...target, stateCapital: { diff: { ...compared, status: 'coverage-changed' } } }
  const changedTree = createElement(StateCapitalPanel, { targets: [changed], catalog, onRequest: () => {} })
  const changedRow = elements(changedTree).find(node => node.type === 'tr' && text(node).includes('测试增加'))!
  assert.match(text(changedRow), /不可比/)
  assert.doesNotMatch(text(changedRow), /\+2/)
})

check('no holdings, failed diff and subject mismatch are distinct accessible states with retained actions', () => {
  const noRows: StateCapitalTargetView = { ...target, stateCapital: { latest: { ...disclosure, holdings: [] } } }
  assert.match(text(createElement(StateCapitalPanel, { targets: [noRows], catalog, onRequest: () => {} })), /没有可展示的具名持有记录；不代表未持有/)
  const failed: StateCapitalTargetView = { ...target, stateCapital: { diff: { status: 'error', rows: [], warnings: ['测试读取错误'] } } }
  const failedNodes = elements(createElement(StateCapitalPanel, { targets: [failed], catalog, onRequest: () => {} }))
  assert.ok(failedNodes.some(node => node.props.role === 'alert' && text(node).includes('对照失败')))
  assert.ok(failedNodes.some(node => node.type === 'button' && text(node) === '检查披露'))
  const mismatch: StateCapitalTargetView = { ...target, stateCapital: { latest: { ...disclosure, entityId: 'csf' } } }
  const mismatchTree = createElement(StateCapitalPanel, { targets: [mismatch], catalog, onRequest: () => {} })
  assert.ok(elements(mismatchTree).some(node => node.props.role === 'alert' && text(node).includes('快照主体与追踪主体不匹配')))
  assert.ok(!text(mismatchTree).includes('测试股权甲'))
})

check('existing target buttons send fetch → diff → note or explicit range confirmation only', () => {
  const requests: string[] = []
  const tree = createElement(StateCapitalPanel, { targets: [target], catalog, onRequest: request => requests.push(request) })
  const nodes = elements(tree)
  const checkButton = nodes.find(node => node.type === 'button' && text(node) === '检查披露')!
  click(checkButton)
  assert.equal(requests[0], stateCapitalCheckRequest(target))
  assert.match(requests[0]!, /follow_fetch\(\{id:"state-test-huijin"\}\)[\s\S]*follow_diff\([\s\S]*follow_note\(/)
  const configureButton = nodes.find(node => node.type === 'button' && text(node) === '修改范围')!
  click(configureButton)
  assert.equal(requests[1], stateCapitalConfigureRequest(target))
  assert.match(requests[1]!, /先向我确认[\s\S]*follow_state_configure[\s\S]*autoCheck:false/)
  assert.match(stateCapitalConfigureRequest({ ...target, autoCheck: true }), /autoCheck:true/)
  assert.equal(nodes.filter(node => node.type === 'button' && text(node) === '添加并检查').length, 2)
  for (const request of requests) assert.doesNotMatch(request, /follow_replicate|capital_transaction_add|simulate_rebalance/)
})

check('add request carries catalog observation pool, independent entity id and manual-only configuration', () => {
  const request = stateCapitalAddRequest(catalog[1]!)
  assert.match(request, /"kind":"cn-state"/)
  assert.match(request, /"stateEntityId":"huijin-asset"/)
  assert.match(request, /"stateCodes":\["601288","601398"\]/)
  assert.match(request, /"autoCheck":false/)
  assert.match(request, /有限观察池，不是我的私人持仓或全量账户/)
  assert.match(stateCapitalAddRequest(catalog[0]!), /"stateCodes":\[\]/)
})

check('other follow kinds are ignored; multiple tracked subjects are never merged', () => {
  const other: StateCapitalTargetView = { id: 'other', kind: 'investor-13f', name: '不应出现的其他机构' }
  const asset: StateCapitalTargetView = { id: 'asset-test', kind: 'cn-state', name: catalog[1]!.name, stateEntityId: 'huijin-asset', stateCodes: ['601288'] }
  const tree = createElement(StateCapitalPanel, { targets: [target, asset, other], catalog, onRequest: () => {} })
  assert.ok(!text(tree).includes(other.name))
  assert.equal(elements(tree).filter(node => node.type === 'article').length, 3)
  assert.equal(elements(tree).filter(node => node.type === 'button' && text(node) === '检查披露').length, 2)
  assert.match(text(tree), /观察池：601288/)
})

check('table regions are keyboard-focusable with captions, row/column headers and theme-token horizontal scrolling', () => {
  const nodes = elements(createElement(StateCapitalPanel, { targets: [target], catalog, onRequest: () => {} }))
  const regions = nodes.filter(node => node.props.role === 'region')
  assert.ok(regions.length >= 2)
  assert.ok(regions.every(node => node.props.tabIndex === 0 && String(node.props['aria-label']).includes('横向滚动')))
  assert.ok(nodes.some(node => node.type === 'caption'))
  assert.ok(nodes.some(node => node.type === 'th' && node.props.scope === 'col'))
  assert.ok(nodes.some(node => node.type === 'th' && node.props.scope === 'row'))
  assert.match(stateCapitalPanelCss, /overflow-x:auto/)
  assert.match(stateCapitalPanelCss, /var\(--fia-border\)/)
  assert.match(stateCapitalPanelCss, /var\(--fia-surface-muted\)/)
  assert.doesNotMatch(stateCapitalPanelCss, /#[0-9a-f]{3,8}\b|(?:^|\n)(?:body|:root)[\s{]/i)
})

check('source module is type-only; requests remain explicit callbacks, with no business I/O or mock app', () => {
  const moduleImports = ast.statements.filter(ts.isImportDeclaration)
  const stateImport = moduleImports.find(node => (node.moduleSpecifier as ts.StringLiteral).text === '../state-capital.js')
  assert.ok(stateImport?.importClause?.isTypeOnly)
  assert.ok(moduleImports.some(node => (node.moduleSpecifier as ts.StringLiteral).text === './design-system/index.js'))
  assert.match(source, /export interface StateCapitalTargetView/)
  assert.match(source, /export function StateCapitalPanel/)
  assert.doesNotMatch(source, /\bfetch\(|apiGet|apiPost|useEffect|setInterval|setTimeout|localStorage|sessionStorage|createRoot|createPortal|dangerouslySetInnerHTML|follow_replicate|capital_transaction_add|sampleHoldings|mockData/)
  let callbacks = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick') callbacks++
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(callbacks, 3, 'only check, configure and add explicitly send text')
})

console.log(`\n${checks} state-capital UI checks passed (pure/React-element/static only; browser not exercised).`)
