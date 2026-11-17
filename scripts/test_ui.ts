/**
 * Real UI acceptance, ONLY against an already-open, user-authorized CDP browser.
 * Never launches another browser, reads profiles/tokens, serves a mock page, or treats a skip as pass.
 *
 * DSH_UI_URL=http://127.0.0.1:<existing-harness-port>
 * DSH_UI_CDP=http://127.0.0.1:<already-enabled-debug-port> npm run test:ui
 * Optional dependency: playwright (not a required plugin/runtime dependency).
 * Captures are local/private under data/ui-shots (gitignored), not published.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TARGET = process.env.DSH_UI_URL ?? ''
const CDP = process.env.DSH_UI_CDP ?? ''
const SHOT_DIR = path.resolve(process.env.DSH_UI_SHOTS ?? 'data/ui-shots')
function skip(reason: string): never {
  console.log(`SKIPPED: 真实浏览器验收未执行 — ${reason}`)
  console.log('未启动替代浏览器；未制作模拟截图；构建与离线测试不能代替视觉验收。')
  process.exit(0)
}
if (!TARGET || !CDP) skip('需要 DSH_UI_URL 和已连接浏览器的 DSH_UI_CDP；当前没有可用浏览器控制连接')
const targetUrl = new URL(TARGET)
const cdpUrl = new URL(CDP)
if (!['localhost', '127.0.0.1', '[::1]'].includes(targetUrl.hostname) || !['localhost', '127.0.0.1', '[::1]'].includes(cdpUrl.hostname)) {
  throw new Error('此验收脚本只连接本机已有 Harness 与本机已授权调试端口')
}
const moduleName = 'playwright'
let pw: any
try { pw = await import(moduleName) } catch { skip('未安装可选 Playwright；不能执行浏览器检查') }
let browser: any
try { browser = await pw.chromium.connectOverCDP(CDP, { timeout: 10_000 }) }
catch (err) { skip(`无法连接现有浏览器：${String(err)}`) }

const page = browser.contexts().flatMap((ctx: any) => ctx.pages()).find((p: any) => {
  try { return new URL(p.url()).origin === targetUrl.origin } catch { return false }
})
if (!page) { await browser.close(); skip('已连接浏览器中没有打开指定 Harness；脚本不会创建替代页面') }
const viewportBefore = page.viewportSize()
const consoleErrors: string[] = []
const onError = (error: Error) => consoleErrors.push(error.message)
page.on('pageerror', onError)
const saved = await page.evaluate(() => ({
  appearance: localStorage.getItem('fia.preferences.v1'),
  tab: localStorage.getItem('dsh-finance:tab'),
  width: localStorage.getItem('dsh-finance:width'),
}))
const checks: string[] = []
const screenshots: string[] = []
let initialPanelWidth = 520
let initialTab = 'home'
let failed: unknown
let restoreUi: (() => Promise<void>) | undefined
try {
  await mkdir(SHOT_DIR, { recursive: true })
  let root = page.locator('.fia-root.fia-panel')
  if (!await root.isVisible()) await page.locator('button[title="投资助手"]').first().click()
  await root.waitFor({ state: 'visible', timeout: 15_000 })
  initialPanelWidth = Math.round((await root.boundingBox()).width)
  initialTab = saved.tab ?? 'home'
  const primary = root.getByRole('navigation', { name: '投资助手一级导航' })
  const secondary = root.getByRole('navigation', { name: '投资助手二级导航' })
  const navigate = async (group: string, label?: string) => {
    await primary.getByRole('button', { name: group, exact: true }).click()
    if (label) await secondary.getByRole('button', { name: label, exact: true }).click()
  }
  const setTheme = async (theme: string) => {
    const control = root.locator('details.fia-appearance')
    if (await control.getAttribute('open') === null) await control.locator('summary').click()
    await control.getByLabel('金融面板主题', { exact: true }).selectOption(theme)
    if (await control.getAttribute('open') !== null) await control.locator('summary').click()
  }
  const shot = async (name: string) => {
    const file = path.join(SHOT_DIR, `${name}.png`)
    await root.screenshot({ path: file, animations: 'disabled' })
    screenshots.push(file)
  }
  const fitPanel = async (width: number) => {
    const box = await root.boundingBox()
    const handle = root.locator('[title="拖动调整面板宽度"]')
    const hbox = await handle.boundingBox()
    if (!box || !hbox) throw new Error('面板拖动把手不可见')
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + 80)
    await page.mouse.down()
    await page.mouse.move(hbox.x + hbox.width / 2 + box.width - width, hbox.y + 80, { steps: 5 })
    await page.mouse.up()
  }
  restoreUi = async () => {
    const dialog = root.getByRole('dialog')
    if (await dialog.isVisible()) await dialog.press('Escape')
    await fitPanel(initialPanelWidth)
    let appearance = { theme: 'system', marketMode: 'china' }
    try { if (saved.appearance) appearance = { ...appearance, ...JSON.parse(saved.appearance) } } catch { /* original malformed preference retained below */ }
    await setTheme(appearance.theme)
    const control = root.locator('details.fia-appearance')
    if (await control.getAttribute('open') === null) await control.locator('summary').click()
    await control.getByLabel('市场涨跌配色', { exact: true }).selectOption(appearance.marketMode)
    await control.locator('summary').click()
    const groups: Record<string, string[]> = { overview: ['home', 'evidence'], judgement: ['advice'], market: ['quotes', 'macro', 'policy', 'news', 'dossier', 'discover', 'research', 'learn'], capital: ['holdings', 'capital', 'wealth', 'funds', 'follow'], settings: ['sources', 'skills', 'health'] }
    const group = Object.keys(groups).find(key => groups[key]!.includes(initialTab))
    if (group) { await primary.locator(`[data-group="${group}"]`).click(); await secondary.locator(`[data-tab="${initialTab}"]`).click() }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fitPanel(1280)
  await navigate('总览')
  await setTheme('light')
  await root.getByRole('heading', { name: '今日投资工作台', exact: true }).waitFor()
  await root.locator('[data-testid="finance-overview"][aria-busy="false"]').waitFor({ timeout: 20_000 })
  await shot('light-dashboard')
  await setTheme('dark'); await shot('dark-dashboard')
  for (const [group, label, name] of [
    ['投资判断', '判断', 'investment-advice'], ['市场研究', '宏观', 'market-research'],
    ['我的资本', '持仓', 'portfolio'], ['设置', '数据源', 'data-sources'],
  ]) {
    await navigate(group, label); await shot(name)
    checks.push(`真实导航：${group} → ${label}`)
  }
  await navigate('投资判断')
  const explain = root.getByRole('button', { name: 'PE ⓘ', exact: true }).first()
  await explain.click()
  const drawer = root.getByRole('dialog')
  await drawer.waitFor({ state: 'visible' })
  await drawer.getByRole('button', { name: '进阶版', exact: true }).click()
  await drawer.getByRole('button', { name: '专业版', exact: true }).click()
  await drawer.press('Escape')
  if (await drawer.isVisible()) throw new Error('Escape 没有关闭解释抽屉')
  await root.getByTestId('finance-advice').waitFor()
  checks.push('解释抽屉三级切换与 Escape 返回原研究页面')
  for (const mode of ['china', 'international', 'accessible']) {
    const control = root.locator('details.fia-appearance')
    await control.locator('summary').click()
    await control.getByLabel('市场涨跌配色', { exact: true }).selectOption(mode)
    if (await root.getAttribute('data-fia-market') !== mode) throw new Error(`涨跌模式未生效：${mode}`)
    await control.locator('summary').click()
  }
  checks.push('三种市场配色切换（不发送金融请求）')
  for (const width of [1440, 1280, 820, 480, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await fitPanel(Math.min(width - 20, 1280))
    await navigate('总览')
    const overflow = await root.locator('.fia-panel-content').evaluate((el: HTMLElement) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    if (overflow.scroll > overflow.client + 2) throw new Error(`${width}px 内容溢出：${JSON.stringify(overflow)}`)
    await shot(width === 390 ? 'compact-sidebar' : `dashboard-${width}`)
    checks.push(`${width}px 当前页面根内容无水平溢出`)
  }
  if (consoleErrors.length) throw new Error(`浏览器错误：${consoleErrors.join('\n')}`)
} catch (error) { failed = error }
finally {
  // Restore UI preferences; no holdings, ledger, advice, API configuration or research writes.
  try {
    if (viewportBefore) await page.setViewportSize(viewportBefore)
    if (restoreUi) await restoreUi()
    await page.evaluate((values: Record<string, string | null>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value)
      }
    }, { 'fia.preferences.v1': saved.appearance, 'dsh-finance:tab': saved.tab, 'dsh-finance:width': saved.width })
    // A page reload is intentionally NOT performed on the user's current Harness session.
  } catch { checks.push('偏好存储恢复失败；请手动恢复主题与宽度') }
  page.off('pageerror', onError)
  await writeFile(path.join(SHOT_DIR, 'acceptance.json'), JSON.stringify({ target: targetUrl.origin, at: new Date().toISOString(), status: failed ? 'failed' : 'passed', checks, screenshots, errors: consoleErrors, initialPanelWidth, initialTab, note: '仅当前连接浏览器的实际结果；不执行真实交易。学习解释接口会记录seen学习状态，截图可能含本地私有研究，禁止提交。UI存储已恢复，运行内组件状态将在下次页面载入恢复。', error: failed ? String(failed) : undefined }, null, 2))
  await browser.close() // disconnects this CDP client; does not launch/close the user's browser process.
}
if (failed) { console.error(`FAIL: ${String(failed)}`); process.exitCode = 1 }
else { console.log(`PASS: ${checks.length} 项真实 UI 检查；${screenshots.length} 张真实截图，仅保存在 ${SHOT_DIR}`) }
