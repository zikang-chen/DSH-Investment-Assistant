/** Offline copy regression: rendered text + explicitly named presentation declarations only.
 * No private data, network, DOM, business prompts or concurrent page scopes are inspected.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import {
  emptyHoldingDraft, holdingPreviewFeedback, validateHoldingDraft,
} from '../src/client/holding-entry-model.js'

const root = new URL('../', import.meta.url)
const views = [
  'holding-entry.tsx', 'personal-home.tsx', 'security-search.tsx', 'workbench.tsx',
  'fund-workspace.tsx', 'sources-workspace.tsx', 'cn-datasets-panel.tsx', 'strategy-lab.tsx',
]
const presentationDeclarations: Record<string, string[]> = {
  'holding-entry-model.ts': ['validateHoldingDraft', 'holdingPreviewFeedback'],
  'fund-ui-model.ts': ['FUND_NAV_T1_NOTE', 'FUND_SEARCH_ONLY_NOTE'],
  'workbench-model.ts': ['deliveryFeedback'],
  'strategy-lab.tsx': ['labels'],
}
const banned = [
  /由候选(?:的)?市场\s*\/?\s*类型识别/u,
  /不按代码位数(?:猜测?|识别|判断)基金/u,
  /不自动换算汇率/u,
  /允许显式(?:填写)?\s*0/u,
  /空白(?:不会?按\s*0\s*处理|不等于\s*0)/u,
  /(?:只|仅)生成(?:变更)?预览[，；,;\s]*(?:不直接|不会|不)写入/u,
  /(?:不会|不)(?:使用|用)(?:虚构|演示).*?(?:填满|替代|代替|填充)/u,
  /不会用\s*0\s*填充|不伪造成功|unknown 保留为未知|每卡每周幂等/u,
  /默认候选与顺序将在保存后由后端返回/u,
]
const visibleAttributes = new Set(['label', 'title', 'description', 'placeholder', 'aria-label', 'aria-description', 'meta', 'text', 'eyebrow'])
type Copy = { text: string; line: number }
function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}
function literalText(node: ts.Node, add: (node: ts.Node, text: string) => void): void {
  if (ts.isStringLiteralLike(node)) { add(node, node.text); return }
  if (ts.isTemplateExpression(node)) {
    add(node, node.head.text)
    for (const span of node.templateSpans) { literalText(span.expression, add); add(span.literal, span.literal.text) }
    return
  }
  if (ts.isConditionalExpression(node)) { literalText(node.whenTrue, add); literalText(node.whenFalse, add); return }
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) {
    literalText(node.left, add); literalText(node.right, add); return
  }
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) {
    const expression = node.expression
    if (expression) literalText(expression, add)
  }
  // Deliberately do not traverse calls, event callbacks, business conditions, styles or prompts.
}
function renderedCopy(file: string, source: string): Copy[] {
  const ast = parse(file, source), result: Copy[] = []
  const add = (node: ts.Node, text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) result.push({ text: clean, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text)
    else if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(ast)) && node.initializer) literalText(node.initializer, add)
    else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) literalText(node, add)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return result
}
function namedPresentationCopy(file: string, source: string, names: string[]): Copy[] {
  const ast = parse(file, source), result: Copy[] = [], found = new Set<string>()
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && names.includes(node.name.getText(ast))) {
      found.add(node.name.getText(ast))
      const strings = (part: ts.Node) => {
        if (ts.isStringLiteralLike(part) || ts.isTemplateHead(part) || ts.isTemplateMiddle(part) || ts.isTemplateTail(part)) {
          result.push({ text: part.text, line: ast.getLineAndCharacterOfPosition(part.getStart(ast)).line + 1 })
        }
        ts.forEachChild(part, strings)
      }
      strings(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.deepEqual([...found].sort(), [...names].sort(), `${file}: presentation declarations must stay covered`)
  return result
}
function violations(rows: Copy[]): Copy[] { return rows.filter(row => banned.some(rule => rule.test(row.text))) }

// Prove the scanner sees visible copies, but ignores identical words in comments and business prompts.
const fixture = `// 不自动换算汇率
const businessPrompt = '不自动换算汇率';
const node = <><p>不自动换算汇率</p><input placeholder="不按代码位数猜测基金" />
<button onClick={() => deliver('不自动换算汇率')} className="不自动换算汇率">继续</button>
<p>{ready ? '只生成预览，不直接写入' : '待确认'}</p></>`
assert.equal(violations(renderedCopy('fixture.tsx', fixture)).length, 3)
for (const sentence of ['由候选的市场 / 类型识别', '不按代码位数猜测基金', '不自动换算汇率', '允许显式填写 0', '空白不会按 0 处理', '空白不等于 0', '只生成变更预览，不直接写入']) {
  assert.equal(violations(renderedCopy('fixture.tsx', `<p>${sentence}</p>`)).length, 1, sentence)
}

const sources = new Map<string, string>()
for (const file of new Set([...views, ...Object.keys(presentationDeclarations)])) {
  sources.set(file, await readFile(new URL(`src/client/${file}`, root), 'utf8'))
}
let copies = 0
for (const [file, source] of sources) {
  const rows = [
    ...(views.includes(file) ? renderedCopy(file, source) : []),
    ...(presentationDeclarations[file] ? namedPresentationCopy(file, source, presentationDeclarations[file]!) : []),
  ]
  copies += rows.length
  const found = violations(rows)
  assert.equal(found.length, 0, found.map(row => `${file}:${row.line}: ${row.text}`).join('\n'))
}

// Concise copy still identifies units, failure and pending confirmation accurately.
const holding = sources.get('holding-entry.tsx')!
assert.match(holding, /数量（\{unit\}）/u)
assert.match(holding, /平均成本（报价币种）/u)
assert.match(holding, /按证券报价币种填写每股 \/ 每份成本/u)
assert.match(holding, /feedback\.kind === 'confirmation' \? '待确认' : '预览失败'/u)
assert.match(holding, /disabled=\{submitting \|\| !props\.get \|\| unchangedPending\}/u)
const pending = holdingPreviewFeedback({ ok: true, confirmationRequired: true })
assert.equal(pending.kind, 'confirmation')
assert.match(pending.message, /个人首页.*确认/u)
assert.doesNotMatch(pending.message, /已保存|已写入/u)
for (const reply of [{ ok: true }, { ok: true, confirmationRequired: false }, { ok: false, error: '服务离线' }]) {
  assert.equal(holdingPreviewFeedback(reply).kind, 'error')
}
assert.match(holdingPreviewFeedback({ ok: false, error: '服务离线' }).message, /服务离线/u)
assert.equal(validateHoldingDraft(emptyHoldingDraft()).ok, false)
const home = sources.get('personal-home.tsx')!
assert.match(home, /action\('确认写入', \(\) => api\('\/confirm', \{ id: p\.id \}\), true, !seen\.has\(p\.id\)\)/u)
assert.match(home, /预览15分钟后过期/u)
assert.match(sources.get('workbench.tsx')!, /useState\(false\)/u)
assert.match(sources.get('workbench.tsx')!, /checked=\{portfolioAuthorized\}/u)
assert.match(sources.get('fund-ui-model.ts')!, /T\+1/u)
assert.match(sources.get('cn-datasets-panel.tsx')!, /数据时点：/u)
assert.match(sources.get('strategy-lab.tsx')!, /模拟本金（CNY）/u)
console.log(`[product-copy] PASS ${copies} visible/presentation fragments across ${sources.size} scoped files; scanner exclusions and confirmation/unit/error contracts passed`)
console.log('[product-copy] Scope excludes index.tsx, security-workspace.tsx, intraday*, kline*, chart*, capital* and portfolio-*; no browser/visual acceptance claimed')
