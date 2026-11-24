/** Pure model + source contracts only. No DOM, browser, network, portfolio access or writes. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import {
  changeHoldingQuery, emptyHoldingDraft, holdingPreviewFeedback, holdingPreviewKey, holdingQuantityUnit,
  parseHoldingNumber, selectHoldingSecurity, validateHoldingDraft, type HoldingEntryDraft,
} from '../src/client/holding-entry-model.js'
import { identityFromMatch, type SecurityIdentity } from '../src/client/security-model.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
const root = new URL('../', import.meta.url)
const [view, model, store, routes] = await Promise.all([
  'src/client/holding-entry.tsx', 'src/client/holding-entry-model.ts', 'src/store.ts', 'src/server-routes.ts',
].map(path => readFile(new URL(path, root), 'utf8')))
const ast = ts.createSourceFile('holding-entry.tsx', view!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const stock: SecurityIdentity = { code: '000001', name: '股票候选', type: 'stock' }
const fund: SecurityIdentity = { code: '000001', name: '基金候选', type: 'fund' }
const draftFor = (item: SecurityIdentity): HoldingEntryDraft => ({
  ...selectHoldingSecurity(emptyHoldingDraft(), item), quantity: '12.5', avgCost: '1.2345',
})

check('draft starts blank, with no assumed quantity, cost or selected code', () => {
  assert.deepEqual(emptyHoldingDraft(), { query: '', selected: null, quantity: '', avgCost: '' })
  const first = emptyHoldingDraft(), second = emptyHoldingDraft()
  first.quantity = '100'
  assert.equal(second.quantity, '')
  const validation = validateHoldingDraft(second)
  assert.equal(validation.ok, false)
  assert.deepEqual(Object.keys(validation.errors).sort(), ['avgCost', 'quantity', 'security'])
  assert.equal('payload' in validation, false)
})

check('decimal parser preserves explicit zero and finite fractional/scientific values', () => {
  for (const [raw, expected] of [['0', 0], ['0.0', 0], [' .5 ', .5], ['1e3', 1000], ['+1', 1], ['1.', 1], ['001.2', 1.2]] as const) {
    assert.equal(parseHoldingNumber(raw), expected, raw)
  }
  for (const raw of ['', ' ', '\t', 'NaN', 'Infinity', '-Infinity', '1e999', '-1', '-0.1', '1,000', '0x10', 'bad', '.', '1.2.3']) {
    assert.equal(parseHoldingNumber(raw), undefined, raw)
  }
})

check('typing code or Chinese name fragments cannot submit without a real candidate selection', () => {
  for (const query of ['中国', '000001', 'AAPL', '基金候选']) {
    const result = validateHoldingDraft({ ...emptyHoldingDraft(), query, quantity: '1', avgCost: '0' })
    assert.equal(result.ok, false, query)
    assert.match(result.errors.security!, /从搜索结果中选择证券/)
    assert.equal('payload' in result, false)
  }
})

check('source market/type, not six-digit shape, distinguishes same-code stock and fund', () => {
  const matchedStock = identityFromMatch({ code: '000001', name: '股票候选', market: 'A股' })
  const matchedFund = identityFromMatch({ code: '000001', name: '基金候选', market: '基金' })
  const typedFund = identityFromMatch({ code: '000001', name: '基金候选', market: 'CN', type: 'fund' })
  assert.equal(matchedStock?.type, 'stock')
  assert.equal(matchedFund?.type, 'fund')
  assert.equal(typedFund?.type, 'fund')
  assert.equal(identityFromMatch({ code: '000001', name: '指数候选', market: '指数' }), null)
  assert.equal(identityFromMatch({ code: '000001', name: '债券候选', market: 'bond' }), null)
  for (const item of [matchedStock!, matchedFund!, typedFund!]) {
    const result = validateHoldingDraft(draftFor(item))
    if (!result.ok) throw new Error('valid candidate rejected')
    assert.equal(result.payload.code, '000001')
    assert.equal(result.payload.type, item.type)
    assert.deepEqual(Object.keys(result.payload).sort(), ['avgCost', 'code', 'quantity', 'type'])
  }
  assert.equal(holdingQuantityUnit(stock), '股')
  assert.equal(holdingQuantityUnit(fund), '份')
  assert.equal(holdingQuantityUnit(null), '股 / 份')
})

check('every new query immediately invalidates old selection without erasing quantity/cost', () => {
  const selected = draftFor(stock)
  const before = JSON.stringify(selected)
  for (const query of ['中国', '000001', '', '股票候选', ' 股票候选 ']) {
    const changed = changeHoldingQuery(selected, query)
    assert.equal(changed.selected, null)
    assert.equal(changed.query, query)
    assert.equal(changed.quantity, selected.quantity)
    assert.equal(changed.avgCost, selected.avgCost)
    const result = validateHoldingDraft(changed)
    assert.equal(result.ok, false)
    assert.equal('payload' in result, false)
  }
  assert.equal(JSON.stringify(selected), before)
  const reselected = selectHoldingSecurity(changeHoldingQuery(selected, '基金'), fund)
  const result = validateHoldingDraft(reselected)
  if (!result.ok) throw new Error('reselected candidate rejected')
  assert.equal(result.payload.type, 'fund')
})

check('selected identity is cloned and leading-zero code remains a string in preview', () => {
  const item = { ...fund }
  const draft = selectHoldingSecurity(emptyHoldingDraft(), item)
  item.code = '999999'
  assert.equal(draft.selected?.code, '000001')
  const result = validateHoldingDraft({ ...draft, quantity: '0', avgCost: '0' })
  if (!result.ok) throw new Error('explicit zero should match nonnegative store schema')
  assert.deepEqual(result.payload, { code: '000001', quantity: 0, avgCost: 0, type: 'fund' })
  assert.notEqual(holdingPreviewKey(result.payload), holdingPreviewKey({ ...result.payload, type: 'stock' }))
  assert.equal(holdingPreviewKey(result.payload), holdingPreviewKey({ ...result.payload }))
  assert.match(store!, /h\.quantity < 0/)
  assert.match(store!, /h\.avgCost < 0/)
  assert.match(store!, /Number\.isFinite\(h\.quantity\)/)
  assert.match(routes!, /action === 'upsertHolding'[\s\S]*?store\.previewHolding\(/)
})

check('invalid names/codes/types and empty/nonfinite/negative numeric fields never make a payload', () => {
  for (const item of [
    { ...stock, code: '中国' }, { ...stock, code: '' }, { ...stock, code: 'a/b' },
    { ...stock, type: 'bond' } as unknown as SecurityIdentity,
  ]) assert.equal(validateHoldingDraft(draftFor(item)).ok, false)
  for (const field of ['quantity', 'avgCost'] as const) {
    for (const raw of ['', ' ', 'NaN', 'Infinity', '-0.1']) {
      const result = validateHoldingDraft({ ...draftFor(stock), [field]: raw })
      assert.equal(result.ok, false, `${field}=${raw}`)
      assert.match(result.errors[field]!, /请填写有效.*可为 0/)
      assert.equal('payload' in result, false)
    }
  }
})

check('preview receipt requires manual confirmation and never says it wrote holdings', () => {
  const pending = holdingPreviewFeedback({ ok: true, confirmationRequired: true })
  assert.equal(pending.kind, 'confirmation')
  assert.match(pending.message, /个人首页.*确认变更/)
  assert.doesNotMatch(pending.message, /已保存|已写入/)
  for (const reply of [{ ok: true }, { ok: true, confirmationRequired: false }, { ok: false, error: '源异常' }]) {
    const feedback = holdingPreviewFeedback(reply)
    assert.equal(feedback.kind, 'error')
    assert.match(feedback.message, /预览状态未确认|预览失败/)
    assert.match(feedback.message, /个人首页/)
    assert.doesNotMatch(feedback.message, /已保存|已写入/)
  }
  assert.match(holdingPreviewFeedback({ ok: false, error: '源异常' }).message, /源异常/)
  assert.match(holdingPreviewFeedback({ ok: false }).message, /输入已保留/)
})

check('component exports exact integration props and delegates only real readonly security search', () => {
  assert.match(view!, /export function HoldingEntry\(props: HoldingEntryProps\)/)
  assert.match(view!, /get\?: ReadApi/)
  assert.match(view!, /onPreview: \(payload: HoldingPreviewPayload\) => Promise<HoldingPreviewReply>/)
  assert.match(view!, /onReview: \(\) => void/)
  assert.match(view!, /import \{ SecuritySearch \} from '\.\/security-search\.js'/)
  assert.match(view!, /<SecuritySearch get=\{props\.get\} onSelect=\{securitySelected\} onQueryChange=\{queryChanged\}/)
  assert.match(view!, /setDraft\(current => changeHoldingQuery\(current, query\)\)/)
  assert.match(view!, /搜索服务未连接[\s\S]*?暂不能生成持仓预览/)
  assert.match(view!, /requestSecurityOpen\(draft\.selected!\)/)
  assert.match(view!, /详细档案.*K 线.*Agent/)
  assert.doesNotMatch(view! + model!, /fetch\(|apiPost|\/mutate|\/confirm|previewHolding\(|writeFile|localStorage|sessionStorage|from ['"][^'"]*store/)
})

check('awaited preview handles failure, retains draft, blocks duplicates and guards unmount', () => {
  const submit = ast.statements.flatMap(statement => {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== 'HoldingEntry' || !statement.body) return []
    return statement.body.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'submit')
  })[0]
  assert.ok(submit)
  const text = submit!.getText(ast)
  assert.match(text, /await props\.onPreview\(result\.payload\)/)
  assert.match(text, /if \(busy\.current \|\| !props\.get \|\| unchangedPending\) return/)
  assert.match(text, /busy\.current = true/)
  assert.match(text, /catch \(error\)/)
  assert.match(text, /finally[\s\S]*?busy\.current = false/)
  assert.match(text, /if \(mounted\.current\) setFeedback/)
  assert.doesNotMatch(text, /setDraft\(|emptyHoldingDraft\(|setAttempted\(false\)/)
  assert.match(view!, /disabled=\{submitting\}/)
  assert.match(view!, /正在生成持仓预览…/)
  assert.match(view!, /feedback\.kind === 'confirmation' \? '待确认' : '预览失败'/)
})

check('named labels and decimal controls preserve units, accessible errors and compact layout', () => {
  for (const label of ['证券代码 / 名称', '资产类型', '数量（', '平均成本（报价币种）']) assert.ok(view!.includes(label))
  let numberInputs = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'input') {
      const attributes = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => [attribute.name.getText(ast), attribute.initializer?.getText(ast)]))
      if (attributes.get('type') === '"number"') {
        numberInputs++
        assert.equal(attributes.get('step'), '"any"')
        assert.equal(attributes.get('min'), '"0"')
        assert.ok(attributes.has('name'))
        assert.ok(attributes.has('aria-invalid'))
        assert.ok(attributes.has('aria-describedby'))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(numberInputs, 2)
  assert.match(view!, /选择证券后自动填写/)
  assert.match(view!, /按证券报价币种填写每股 \/ 每份成本/)
  assert.match(view!, /container-type:inline-size/)
  assert.match(view!, /grid-template-columns:minmax\(0,1fr\)/)
  assert.match(view!, /@container \(min-width:520px\)/)
  assert.match(view!, /--fia-control-height/)
  assert.match(view!, /min-height:32px/)
  assert.doesNotMatch(view!, /#[0-9a-f]{3,8}\b|\b(?:body|:root)\s*\{/i)
})

console.log(`[holding-entry] ${checks} groups passed (pure/static only; browser/visual acceptance not run)`)
