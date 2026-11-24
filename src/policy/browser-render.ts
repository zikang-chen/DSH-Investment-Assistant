/**
 * 脚本渲染页面的兜底：用本机 Chrome 的 CDP 取渲染后的 HTML。
 *
 * 什么时候用：静态抓取拿到的 HTML 里没有条目（列表由 JS 渲染），而不是站点拒绝访问。
 * 边界：
 * - 不绕过登录、验证码与付费墙；渲染只是让页面自己跑一遍 JS。
 * - 仍然先走静态抓取（含 robots 与允许清单检查），静态成功且有条目就不开浏览器。
 * - 找不到 Chrome 就明确报错，不静默退回空结果。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface RenderOptions {
  timeoutMs?: number
  /** 页面加载后额外等待时间，给异步列表留出渲染。 */
  settleMs?: number
  /** 是否先滚到底部触发懒加载。 */
  scrollToBottom?: boolean
  signal?: AbortSignal
}

export interface RenderResult {
  ok: boolean
  url?: string
  html?: string
  error?: string
  /** 实际使用的浏览器路径。 */
  browser?: string
}

const DEFAULT_CANDIDATES = [
  process.env.DSH_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findChrome(candidates: Array<string | undefined> = DEFAULT_CANDIDATES): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try { if (existsSync(candidate)) return candidate } catch { /* 权限问题当作不存在 */ }
  }
  return undefined
}

/**
 * 静态 HTML 是否「看起来没有条目」：正文段落少、且没有像政策链接的锚点。
 * 只用来决定要不要开浏览器，不做内容判断。
 */
export function looksScriptRendered(html: string): boolean {
  const body = String(html ?? '')
  if (!body.trim()) return true
  const paragraphs = (body.match(/<p\b/gi) ?? []).length
  const anchors = (body.match(/<a\b[^>]*href=/gi) ?? []).length
  const hasContentMarkers = /(zhengce|gongkai|xxgk|zcwj|articles?|list-item|policy-list)/i.test(body)
  return paragraphs < 3 && (anchors < 8 || !hasContentMarkers)
}

interface CdpMessage { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } }

async function connect(port: number, timeoutMs: number): Promise<{ ws: WebSocket; send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void }> {
  const deadline = Date.now() + timeoutMs
  let target: { webSocketDebuggerUrl?: string } | undefined
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch { /* 端口还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('浏览器调试端口未就绪')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  let id = 0
  const pending = new Map<number, (message: CdpMessage) => void>()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String((event as MessageEvent).data)) as CdpMessage
    if (message.id === undefined) return
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  })
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const current = ++id
    pending.set(current, (message) => {
      if (message.error) reject(new Error(message.error.message ?? 'CDP 调用失败'))
      else resolve(message.result ?? {})
    })
    ws.send(JSON.stringify({ id: current, method, params }))
  })
  return { ws, send, close: () => { try { ws.close() } catch { /* 已关闭 */ } } }
}

/** 渲染一个页面并返回最终 DOM 的 HTML。失败时返回错误，不返回空 HTML。 */
export async function renderWithChrome(url: string, options: RenderOptions = {}): Promise<RenderResult> {
  const browser = findChrome()
  if (!browser) return { ok: false, error: '未找到 Chrome（可用 DSH_CHROME 指定路径）' }
  const timeoutMs = Math.max(3000, options.timeoutMs ?? 20_000)
  const settleMs = Math.max(0, options.settleMs ?? 1200)
  const port = 9400 + Math.floor(Math.random() * 200)
  const profile = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `dsh-policy-render-${port}`)
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })
  let session: Awaited<ReturnType<typeof connect>> | undefined
  try {
    if (options.signal?.aborted) throw new Error('已取消')
    session = await connect(port, timeoutMs)
    await session.send('Page.enable')
    await session.send('Page.navigate', { url })
    await new Promise((resolve) => setTimeout(resolve, settleMs))
    if (options.scrollToBottom !== false) {
      await session.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight); 1' })
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    const evaluated = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ html: document.documentElement.outerHTML, url: location.href })',
      returnByValue: true,
    })
    const raw = (evaluated.result as { value?: string } | undefined)?.value
    if (!raw) return { ok: false, error: '渲染后未取到 DOM', browser }
    const parsed = JSON.parse(raw) as { html?: string; url?: string }
    if (!parsed.html) return { ok: false, error: '渲染结果为空', browser }
    return { ok: true, url: parsed.url ?? url, html: parsed.html, browser }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), browser }
  } finally {
    session?.close()
    try { child.kill() } catch { /* 已退出 */ }
  }
}
