/** Pure functions + static contracts only. No DOM, browser, network, private data or write APIs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  CAPITAL_NETWORTH_REQUEST, INITIAL_WEALTH_FORM, WEALTH_FIELDS,
  capitalCurrencyRows, parseWealthNumber, portfolioPrincipal, rateForWealthApi, wealthInputKey, wealthRequest,
  type CapitalPayload, type PortfolioSnapshot, type WealthForm,
} from '../src/client/capital-ui-model.js'
import { capitalWorkspaceCss } from '../src/client/capital-workspace-styles.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
const root = new URL('../', import.meta.url)
const [view, model, routes, compound] = await Promise.all([
  'src/client/capital-workspace.tsx', 'src/client/capital-ui-model.ts',
  'src/server-routes.ts', 'src/wealth/compound.ts',
].map(path => readFile(new URL(path, root), 'utf8')))
const ast = ts.createSourceFile('capital-workspace.tsx', view!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
/** 资金页的展示组件已拆到 capital-product.tsx：可见文案在两处之一即可。 */
const productSource = readFileSync('src/client/capital-product.tsx', 'utf8')

check('currency rows keep original denominations; never sum or coerce missing values', () => {
  const fixture: CapitalPayload = {
    ok: true,
    cashByCurrency: { USD: 50, CNY: 0 }, netInvested: { CNY: 100, HKD: -20 },
    realized: { USD: -4 }, fees: { USD: 0 }, income: { CNY: 2 },
  }
  const before = JSON.stringify(fixture)
  assert.deepEqual(capitalCurrencyRows(fixture), [
    { currency: 'CNY', cash: 0, netInvested: 100, realized: undefined, fees: undefined, income: 2 },
    { currency: 'HKD', cash: undefined, netInvested: -20, realized: undefined, fees: undefined, income: undefined },
    { currency: 'USD', cash: 50, netInvested: undefined, realized: -4, fees: 0, income: undefined },
  ])
  assert.equal(JSON.stringify(fixture), before)
  assert.deepEqual(capitalCurrencyRows({ ok: true }), [])
  assert.ok(Number.isNaN(capitalCurrencyRows({ ok: true, income: { CNY: NaN } })[0]!.income))
})

check('linked principal selects only complete currency value, never cost or other currencies', () => {
  const snapshot: PortfolioSnapshot = { at: '2026-11-17T02:00:00Z', basis: 'fixture', groups: [
    { currency: 'CNY', cost: 500, value: 600, profit: 100, missing: [] },
    { currency: 'USD', cost: 80, value: 0, profit: -80, missing: [] },
    { currency: 'HKD', cost: 100, value: 90, profit: -10, missing: ['unpriced'] },
  ] }
  const before = JSON.stringify(snapshot)
  assert.deepEqual(portfolioPrincipal(snapshot, 'CNY'), { ok: true, value: 600 })
  assert.deepEqual(portfolioPrincipal(snapshot, 'USD'), { ok: true, value: 0 })
  assert.equal(portfolioPrincipal(snapshot, 'HKD').ok, false, 'partial value must not become principal')
  assert.equal(portfolioPrincipal(snapshot, 'EUR').ok, false, 'no fabricated asset binding')
  assert.equal(portfolioPrincipal(undefined, 'CNY').ok, false)
  for (const value of [null, NaN, Infinity]) assert.equal(portfolioPrincipal({ groups: [{ currency: 'CNY', cost: 500, value, profit: null, missing: [] }] }, 'CNY').ok, false)
  const updated = { ...snapshot, groups: [{ currency: 'CNY', cost: 500, value: 650, profit: 150, missing: [] }] }
  assert.deepEqual(portfolioPrincipal(updated, 'CNY'), { ok: true, value: 650 })
  assert.equal(JSON.stringify(snapshot), before)
})

check('numeric parser rejects missing/non-finite, preserves zero and signed inputs', () => {
  for (const raw of ['', ' ', 'bad', '1.2.3', 'NaN', 'Infinity', '-Infinity', '1e999']) assert.equal(parseWealthNumber(raw), undefined, raw)
  for (const [raw, expected] of [['0', 0], ['-20', -20], [' .5 ', .5], ['1e3', 1000], ['+1', 1]] as const) assert.equal(parseWealthNumber(raw), expected)
})

check('percentage transport fixes 0.5% fees and covers both server normalization branches', () => {
  const cases = [
    [0, 0], [0.5, .005], [1, .01], [6, .06], [100, 1], [150, 150],
    [-0.5, -.005], [-1, -.01], [-100, -1], [-150, -150],
  ] as const
  for (const [percent, wire] of cases) assert.equal(rateForWealthApi(percent), wire, `${percent}%`)
  // Protect the actual server's dual-format contract, not an invented new route/schema.
  assert.match(routes!, /const pct = \(value: unknown\): number => \{[\s\S]*?return Math\.abs\(n\) > 1 \? n \/ 100 : n/)
  assert.match(routes!, /annualRate: pct\(body\.annualRate\)/)
  assert.match(routes!, /annualFee: pct\(body\.annualFee\)/)
  assert.match(routes!, /inflation: pct\(body\.inflation\)/)
})

check('default fields submit unchanged money, explicit monthly/end, and correct percent units', () => {
  const request = wealthRequest(INITIAL_WEALTH_FORM)
  assert.equal(request.ok, true)
  if (!request.ok) throw new Error('invalid initial form')
  assert.deepEqual(request.body, {
    principal: 10000, contribution: 1000, years: 10, annualRate: .06, annualFee: .005, inflation: .03,
    frequency: 'monthly', timing: 'end',
  })
  assert.equal(INITIAL_WEALTH_FORM.annualFee, '0.5')
  assert.deepEqual(WEALTH_FIELDS.filter(field => field.unit === '%').map(field => field.key), ['annualRate', 'annualFee', 'inflation'])
})

check('validation returns named field errors; never substitutes zero', () => {
  const form = { ...INITIAL_WEALTH_FORM, principal: '', contribution: 'n/a', inflation: 'Infinity' }
  const result = wealthRequest(form)
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('invalid values passed')
  assert.deepEqual(Object.keys(result.errors).sort(), ['contribution', 'inflation', 'principal'])
  assert.match(result.errors.principal!, /一次性本金.*元/)
  assert.match(result.errors.inflation!, /年通胀率.*%/)
  assert.equal('body' in result, false)
})

check('UI rejects no invented numeric ranges; real engine remains domain validator', () => {
  for (const value of ['0', '-1', '100.01', '-150', '1000']) {
    const form: WealthForm = { ...INITIAL_WEALTH_FORM, years: value, principal: value, contribution: value, annualFee: value }
    assert.equal(wealthRequest(form).ok, true, value)
  }
  assert.match(compound!, /years <= 0 \|\| years > 100/)
  assert.match(compound!, /annualFee < 0 \|\| annualFee >= 1/)
  assert.match(compound!, /annualRate < -0\.999999/)
  assert.doesNotMatch(view!, /\b(?:min|max|step)=/)
})

check('result identity tracks numeric inputs, not saved scenario names', () => {
  const first = wealthRequest(INITIAL_WEALTH_FORM)
  const renamed = wealthRequest({ ...INITIAL_WEALTH_FORM, name: 'Alternative' })
  const changed = wealthRequest({ ...INITIAL_WEALTH_FORM, annualRate: '1' })
  if (!first.ok || !renamed.ok || !changed.ok) throw new Error('fixture invalid')
  assert.equal(wealthInputKey(first.body), wealthInputKey(renamed.body))
  assert.notEqual(wealthInputKey(first.body), wealthInputKey(changed.body))
  const context = { currency: 'CNY', principalSource: 'portfolio' as const, portfolioAt: '2026-11-17T02:00:00Z' }
  assert.notEqual(wealthInputKey(first.body, context), wealthInputKey(first.body, { ...context, portfolioAt: '2026-11-17T02:05:00Z' }))
  assert.notEqual(wealthInputKey(first.body, context), wealthInputKey(first.body, { ...context, currency: 'USD' }))
  assert.notEqual(wealthInputKey(first.body, context), wealthInputKey(first.body, { ...context, principalSource: 'manual' }))
})

check('public components, request endpoints, and delivery API match integration contract', () => {
  assert.match(view!, /export function CapitalWorkspace\(props: CapitalWorkspaceProps\)/)
  assert.match(view!, /export function WealthWorkspace\(props: WealthWorkspaceProps\)/)
  assert.match(view!, /get: ReadApi; deliver: Deliver; useBus\?: UsePanelBus/)
  assert.match(view!, /get: ReadApi; post: WealthPostApi/)
  assert.match(view!, /WealthPostApi = <T>\(path: string, body: unknown\) => Promise<T>/)
  assert.match(view!, /useLocalRead<CapitalPayload>\(props\.get, '\/capital'\)/)
  assert.match(view!, /useLocalRead<WealthPlansPayload>\(props\.get, '\/wealth\/plans'\)/)
  assert.match(view!, /props\.post<WealthResult>\(save \? '\/wealth\/plans\/save' : '\/wealth\/calc', body\)/)
  assert.match(view!, /CapitalProduct/)
  const capitalProduct = readFileSync('src/client/capital-product.tsx', 'utf8')
  assert.match(capitalProduct, /capitalDeliveryNotice\(outcome\)/)
  assert.match(capitalProduct, /useCapitalTransactions/)
  assert.match(view!, /event\.kind === 'capital' \|\| event\.kind === '__resync'/)
})

check('only explicit net-worth action can send to model; local ledger is not interpolated', () => {
  const deliveries: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'deliver') deliveries.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  // 页面本体不再直接发送；发送集中在 CapitalProduct 的显式按钮里。
  assert.equal(deliveries.length, 0)
  const productSource = readFileSync('src/client/capital-product.tsx', 'utf8')
  const productAst = ts.createSourceFile('capital-product.tsx', productSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const productDeliveries: ts.CallExpression[] = []
  const visitProduct = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(productAst) === 'deliver') productDeliveries.push(node)
    ts.forEachChild(node, visitProduct)
  }
  visitProduct(productAst)
  assert.equal(productDeliveries.length, 1, '只有 submit 一处发送入口')
  // 自动发送（effect 内直接发送）必须不存在。
  assert.doesNotMatch(productSource, /useEffect\(\(\)\s*=>\s*\{[^}]*submit\(/)
  assert.match(productSource, /onClick=\{\(\) => void submit\(CAPITAL_NETWORTH_REQUEST\)\}/)
  assert.equal(CAPITAL_NETWORTH_REQUEST, '请用 capital_networth_snapshot 计算我的净资产；如果你没有我当前的持仓价格，先问我或调用行情工具取最新价，并注明数据日期与汇率来源。')
  assert.doesNotMatch(model!, /accountId.*CAPITAL_NETWORTH_REQUEST/)
})

check('no frontend financial engine, mock result, new API, or absent-to-zero fallback', () => {
  assert.doesNotMatch(view! + model!, /from ['"][^'"]*\/(?:capital\/performance|wealth\/compound|wealth\/plans)/)
  assert.doesNotMatch(view! + model!, /Math\.pow|\.reduce\(|Number\([^)]*\)\s*\|\|\s*0|(?:finalYuan|growthYuan|realRate)\s*\?\?\s*0/)
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) assert.notEqual(node.operatorToken.kind, ts.SyntaxKind.AsteriskAsteriskToken)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.doesNotMatch(view!, /\bfetch\(|apiPost|capital_transaction_add|capital_account_save/)
  assert.doesNotMatch(view!, /rows\.slice\(/)
  assert.match(view! + productSource, /不跨币种求和/)
  assert.match(view!, /累计后续投入（\$\{result\.context\.currency\}）/)
  assert.match(view!, /不含一次性本金/)
  assert.match(view!, /本年后续投入/)
  assert.match(routes!, /contributedYuan: yuan\(r\.contributedCents\)/)
})

check('local busy/error/empty and input-result mismatch states stay distinct', () => {
  for (const copy of ['正在读取本机账本', '账本读取失败', '还没有资本账户', '尚未计算情景', '服务端未返回逐年明细', '情景读取失败', '还没有保存的情景', '持仓或输入已变更 · 旧结果待更新', '不是收益预测']) assert.ok((view! + productSource).includes(copy), copy)
  assert.match(view!, /sequence\.current === request/)
  assert.match(view!, /request\.current !== token/)
  assert.match(view!, /running\.current/)
  assert.match(view!, /aria-invalid=/)
  assert.match(view!, /aria-describedby=/)
  assert.match(view!, /role="region" aria-label=\{label\} tabIndex=\{0\}/)
  assert.match(view!, /<caption>/)
  assert.match(view!, /scope="col" data-numeric="true"/)
})

check('portfolio linkage is opt-in editable, currency-separated, and never automatically posts', () => {
  assert.match(view!, /portfolio\?: PortfolioSnapshot/g)
  assert.match(view!, /sourceChoice \?\? \(props\.portfolio\?\.groups\.length \? 'portfolio' : 'manual'\)/)
  assert.match(view!, /portfolioPrincipal\(props\.portfolio, currency\)/)
  assert.match(view!, /principal: linkedPrincipal\.ok \? String\(linkedPrincipal\.value\) : ''/)
  assert.match(view!, /readOnly=\{field\.key === 'principal' && source === 'portfolio'\}/)
  assert.match(view!, /disabled=\{!!operation \|\| principalUnavailable\}/)
  assert.match(view!, /context: submittedContext/)
  assert.match(view!, /name: form\.name\.trim\(\), notes/)
  assert.match(routes!, /notes: body\.notes \? String\(body\.notes\) : ''/)
  for (const copy of ['跟随当前持仓', '手动本金', '待补行情', '历史列表接口未回传币种', '不执行换汇']) assert.ok(view!.includes(copy), copy)
  // 拆分后的资金页在 capital-product.tsx 里说明「不与其他币种相加」。
  assert.ok(productSource.includes('贵金属、现金及其他资产') || view!.includes('贵金属、现金及其他资产'))
  const calculations: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'calculate') calculations.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(calculations.length, 2, 'only explicit form submit and save button may calculate')
  assert.match(view!, /onSubmit=\{event => \{ event\.preventDefault\(\); void calculate\(false\) \}\}/)
  assert.match(view!, /onClick=\{\(\) => void calculate\(true\)\}/)
})

check('all CSS selectors are finance-root scoped and use tokens rather than fixed colors', () => {
  let rules = 0
  for (const match of capitalWorkspaceCss.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
    const selector = match[1]!.trim()
    if (selector.startsWith('@container') || selector.startsWith('@media')) continue
    rules++
    assert.ok(selector.startsWith('.fia-root'), selector)
    let depth = 0
    for (let index = 0; index < selector.length; index++) {
      if ('(['.includes(selector[index]!)) depth++
      if (')]'.includes(selector[index]!)) depth--
      if (selector[index] === ',' && depth === 0) assert.ok(selector.slice(index + 1).trim().startsWith('.fia-root'), selector)
    }
  }
  assert.ok(rules > 30)
  assert.doesNotMatch(capitalWorkspaceCss, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  assert.match(capitalWorkspaceCss, /@container fia-capital \(max-width:480px\)/)
  assert.match(capitalWorkspaceCss, /grid-template-columns:minmax\(0,1fr\)/)
  assert.match(capitalWorkspaceCss, /overflow-x:auto/)
  assert.match(capitalWorkspaceCss, /text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums/)
})

console.log(`\nCapital/wealth UI: ${checks} pure/static checks passed. Browser appearance and interactive DOM are not verified.`)
