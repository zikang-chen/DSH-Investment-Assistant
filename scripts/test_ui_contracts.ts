/** Static/pure presentation checks. NOT a browser or screenshot test. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { financeChartPalette } from '../src/client/chart-theme.js'
import { deliveryFeedback, displayDay, isSafeSourceUrl, researchPrompt, RECOMMENDATION_VIEW } from '../src/client/workbench-model.js'
import { contrastRatio, palette } from '../src/client/design-system/tokens.js'
import { WORKSPACE_CSS } from '../src/client/workspace-styles.js'

let count = 0
function test(name: string, fn: () => void) { fn(); count++; console.log(`PASS ${name}`) }

test('default research prompt explicitly refuses personal account access', () => {
  const text = researchPrompt('沪深300怎么看？', 'quick', false)
  assert.match(text, /本次未授权读取或向模型发送个人账户/)
  assert.doesNotMatch(text, /我授权为这次问题/)
  assert.match(text, /Evidence Request/)
  assert.match(text, /不能编造最新价格/)
})
test('portfolio usage requires explicit per-request consent and keeps risk constraints unknown', () => {
  const text = researchPrompt('组合集中吗？', 'deep', true)
  assert.match(text, /我授权为这次问题读取本机组合概要/)
  assert.match(text, /不得猜测仓位/)
  assert.match(text, /不要执行交易/)
})
test('delivery requested / copied / failed states are distinct and do not invent execution', () => {
  assert.match(deliveryFeedback('sent'), /已请求发送/)
  assert.match(deliveryFeedback('sent'), /目标对话查看/)
  assert.match(deliveryFeedback('copied'), /未自动发送/)
  assert.match(deliveryFeedback('failed'), /未能发送/)
  assert.doesNotMatch(deliveryFeedback('sent'), /已保存|分析完成/)
})
test('buy / hold are neutral research judgments, not profitable green or confidence claims', () => {
  assert.equal(RECOMMENDATION_VIEW.CONSIDER_BUY.tone, 'info')
  assert.equal(RECOMMENDATION_VIEW.HOLD.tone, 'neutral')
  assert.match(RECOMMENDATION_VIEW.CONSIDER_BUY.label, /有条件/)
  assert.equal(Object.keys(RECOMMENDATION_VIEW).length, 6)
})
test('external citations permit only http(s), never executable or local-file URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///D:/private', '/local-relative']) assert.equal(isSafeSourceUrl(url), false)
  assert.equal(isSafeSourceUrl('https://www.stats.gov.cn/'), true)
})
test('date-only metadata stays date-only and missing date is explicit', () => {
  assert.equal(displayDay('2026-01-01T00:01:00+08:00'), '2026-01-01')
  assert.equal(displayDay(undefined), '未注明')
})
test('canvas uses the same global market convention without changing chart geometry', () => {
  for (const theme of ['light', 'dark'] as const) {
    const cn = financeChartPalette(theme, 'china'), intl = financeChartPalette(theme, 'international'), accessible = financeChartPalette(theme, 'accessible')
    assert.equal(cn.up, intl.down); assert.equal(cn.down, intl.up)
    assert.notEqual(accessible.up, cn.up)
    assert.deepEqual(cn.ma, intl.ma)
    assert.deepEqual(cn.maDash, intl.maDash)
    assert.notEqual(cn.maDash[10].join(','), cn.maDash[20].join(','))
    assert.equal(cn.text, palette[theme].secondary)
  }
})
test('dark navy header has a separate visible focus ring', () => {
  for (const theme of ['light', 'dark'] as const) assert.ok(contrastRatio(palette[theme]['on-dark'], palette[theme].navy) >= 3)
  assert.match(WORKSPACE_CSS, /fia-header-action:focus-visible[\s\S]*?outline-color:var\(--fia-on-dark\)/)
})
test('container rules cover compact / wide / expanded and reduced-motion', () => {
  assert.match(WORKSPACE_CSS, /max-width:420px/)
  assert.match(WORKSPACE_CSS, /min-width:740px/)
  assert.match(WORKSPACE_CSS, /min-width:1050px/)
  assert.match(WORKSPACE_CSS, /prefers-reduced-motion/)
})

const entry = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const workspace = await readFile(new URL('../src/client/workbench.tsx', import.meta.url), 'utf8')
const home = await readFile(new URL('../src/client/personal-home.tsx', import.meta.url), 'utf8')
const uiTest = await readFile(new URL('./test_ui.ts', import.meta.url), 'utf8')
test('entry wires the new pages, embedded personal actions and separate theme roots', () => {
  assert.match(entry, /h\(OverviewWorkbench/); assert.match(entry, /h\(InvestmentWorkbench/)
  assert.match(entry, /h\(PersonalHome, \{ embedded: true/)
  assert.match(entry, /function FinanceOverlay[\s\S]*?createPortal\(h\(FinanceTheme/)
  assert.match(entry, /return h\(FinanceOverlay, \{ onClose: close \}/)
  assert.match(entry, /return h\(FinanceOverlay, \{ onClose: props.onClose \}/)
  assert.doesNotMatch(entry, /function OverviewAggregate|function InvestmentView/)
})
test('advice detail uses the real API shape, race guard, source refs and server-side status filter', () => {
  assert.match(workspace, /advice\.dataFreshness\.status/)
  assert.match(workspace, /advice\.dataFreshness\.asOf/)
  assert.match(workspace, /detailSeq\.current === seq/)
  assert.match(workspace, /query\.set\('status', filter\)/)
  assert.match(workspace, /list\.data\?\.dueForReview/)
  assert.match(workspace, /props\.onOpenPolicy\(doc\.id\)/)
})
test('explain modal retains research context and contains real dialog / Escape support', () => {
  assert.match(workspace, /el\.showModal\(\)/)
  assert.match(workspace, /onCancel=/)
  assert.match(workspace, /previous\?\.isConnected/)
  assert.match(workspace, /qs\.set\('asset', advice\.assets/)
  assert.match(workspace, /qs\.set\('period', advice\.dataFreshness\.asOf\)/)
})
test('portfolio-sensitive controls do not default to consent; UI does not write financial APIs', () => {
  assert.match(workspace, /\[portfolioAuthorized, setPortfolioAuthorized\] = useState\(false\)/)
  assert.doesNotMatch(workspace, /apiPost|\/capital\/transaction|\/holdings\/(?:add|remove)/)
  for (const anchor of ['overview', 'growth', 'journal', 'reviews', 'approvals']) assert.ok(home.includes(`'${anchor}'`))
})
test('browser test only connects to an existing authorized page, never launches one', () => {
  assert.match(uiTest, /chromium\.connectOverCDP/)
  assert.doesNotMatch(uiTest, /chromium\.launch|\.newPage\(|\.newContext\(/)
  for (const width of [1440, 1280, 820, 480, 390]) assert.ok(uiTest.includes(String(width)))
  assert.match(uiTest, /SKIPPED:/)
})
console.log(`[ui-contracts] ${count} groups passed (static/pure; real browser acceptance remains separate)`)
