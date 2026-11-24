/** Fresh-profile CDP rendering, with the same crawl boundary as static requests. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hostAllowed, policyUserAgent } from './fetch.js'

export interface RenderOptions {
  timeoutMs?: number
  settleMs?: number
  scrollToBottom?: boolean
  signal?: AbortSignal
  hosts?: string[]
  maxBytes?: number
  /** Strict article/navigation boundary; same-origin dependencies are not crawl candidates. */
  isUrlAllowed?: (url: string) => boolean
}
export interface RenderResult { ok: boolean; url?: string; html?: string; error?: string; browser?: string }

const DEFAULT_CANDIDATES = [process.env.DSH_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
export function findChrome(candidates: Array<string | undefined> = DEFAULT_CANDIDATES): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try { if (existsSync(candidate)) return candidate } catch { /* unavailable */ }
  }
  return undefined
}
export function looksScriptRendered(html: string): boolean {
  const body = String(html ?? '')
  if (!body.trim()) return true
  const paragraphs = (body.match(/<p\b/gi) ?? []).length
  const anchors = (body.match(/<a\b[^>]*href=/gi) ?? []).length
  return paragraphs < 3 && (anchors < 8 || !/(zhengce|gongkai|xxgk|zcwj|articles?|list-item|policy-list)/i.test(body))
}

/** Do not turn login/challenge/denial pages into a browser bypass attempt. */
export function isAccessControlPage(html: string): boolean {
  return /<input\b[^>]*type\s*=\s*["']?password\b|(?:g-recaptcha|h-captcha|cf-chl-|challenge-platform)|<title[^>]*>[^<]*(?:Access Denied|Just a moment|验证|登录|登陆|Forbidden)/i.test(html)
}
interface CdpMessage { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, unknown>; error?: { message?: string } }
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  onEvent(listener: (method: string, params: Record<string, any>) => void): () => void
  close(): void
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const abort = (): void => { clearTimeout(timer); cleanup(); reject(signal.reason ?? new Error('已取消')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function connect(port: number, signal: AbortSignal): Promise<CdpSession> {
  let target: { webSocketDebuggerUrl?: string } | undefined
  while (!target) {
    signal.throwIfAborted()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal })
      const list = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch (error) { if (signal.aborted) throw error }
    if (!target) await delay(100, signal)
  }
  signal.throwIfAborted()
  const ws = new WebSocket(target.webSocketDebuggerUrl!)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', abort); ws.removeEventListener('open', open); ws.removeEventListener('error', error) }
    const abort = (): void => { cleanup(); ws.close(); reject(signal.reason ?? new Error('已取消')) }
    const open = (): void => { cleanup(); resolve() }
    const error = (): void => { cleanup(); reject(new Error('CDP 连接失败')) }
    signal.addEventListener('abort', abort, { once: true }); ws.addEventListener('open', open); ws.addEventListener('error', error)
  })
  let id = 0
  const pending = new Map<number, { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  const listeners = new Set<(method: string, params: Record<string, any>) => void>()
  const fail = (error: Error): void => { for (const entry of pending.values()) entry.reject(error); pending.clear() }
  const abort = (): void => { fail(new Error('CDP 已取消/超时')); try { ws.close() } catch { /* closed */ } }
  signal.addEventListener('abort', abort, { once: true })
  ws.addEventListener('close', () => fail(new Error('CDP 连接关闭')))
  ws.addEventListener('error', () => fail(new Error('CDP 连接失败')))
  ws.addEventListener('message', (event) => {
    let message: CdpMessage
    try { message = JSON.parse(String(event.data)) as CdpMessage } catch { fail(new Error('CDP 消息无效')); return }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message ?? 'CDP 调用失败'))
      else entry.resolve(message.result ?? {})
    } else if (message.method) for (const listener of listeners) listener(message.method, message.params ?? {})
  })
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('CDP 已取消/超时')); return }
      const current = ++id
      pending.set(current, { resolve, reject })
      try { ws.send(JSON.stringify({ id: current, method, params })) } catch (error) { pending.delete(current); reject(error) }
    }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    close: () => { signal.removeEventListener('abort', abort); fail(new Error('CDP 已关闭')); try { ws.close() } catch { /* closed */ } },
  }
}

/** Exported for offline protocol tests; no browser/network/store is created here. */
export async function renderCdpPage(session: CdpSession, url: string, options: RenderOptions, signal: AbortSignal): Promise<RenderResult> {
  const origin = new URL(url).origin
  const hosts = options.hosts ?? [new URL(url).hostname]
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1, options.maxBytes!) : 5_000_000
  const allowed = (target: string): boolean => hostAllowed(target, hosts) && new URL(target).origin === origin && options.isUrlAllowed?.(target) !== false
  if (!allowed(url)) return { ok: false, error: '渲染地址不在允许清单/抓取范围内' }
  let fatal: Error | undefined
  let receivedBytes = 0
  let requests = 0
  const sameOrigin = (target: string): boolean => hostAllowed(target, hosts) && new URL(target).origin === origin
  const send = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    signal.throwIfAborted()
    if (fatal) throw fatal
    const result = await session.send(method, params)
    signal.throwIfAborted()
    if (fatal) throw fatal
    return result
  }
  const stop = (message: string): void => { fatal ??= new Error(message); void session.send('Page.stopLoading').catch(() => {}) }
  const off = session.onEvent((method, params) => {
    if (method === 'Fetch.requestPaused') {
      const target = String(params.request?.url ?? '')
      requests++
      const isDocument = params.resourceType === 'Document'
      // JS/CSS/XHR needed by this page may live outside its article directory.
      // This does not add those URLs to the crawler's link frontier.
      const ok = requests <= 80 && (isDocument ? allowed(target) : sameOrigin(target))
      if (requests > 80) stop('渲染资源请求超过上限 80')
      if (!ok && isDocument) stop(`渲染导航超出抓取范围：${target}`)
      void session.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch((error) => stop(String(error)))
    } else if (method === 'Fetch.authRequired') {
      stop('渲染遇到身份验证，不尝试登录或绕过')
      void session.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: { response: 'CancelAuth' } }).catch(() => {})
    } else if (method === 'Network.dataReceived') {
      receivedBytes += Number(params.dataLength) || 0
      if (receivedBytes > maxBytes) stop(`渲染下载超过上限 ${maxBytes} 字节`)
    } else if (method === 'Network.responseReceived' && params.type === 'Document') {
      if (!allowed(String(params.response?.url ?? ''))) stop('渲染最终响应超出抓取范围')
      const status = Number(params.response?.status)
      if (status >= 400) stop(`渲染 HTTP ${status}，不绕过访问控制`)
      const headers = params.response?.headers ?? {}
      const size = Number(headers['content-length'] ?? headers['Content-Length'])
      if (size > maxBytes) stop(`渲染响应超过上限 ${maxBytes} 字节`)
    }
  })
  try {
    await send('Page.enable')
    await send('Network.enable')
    await send('Network.setBypassServiceWorker', { bypass: true })
    await send('Network.setCacheDisabled', { cacheDisabled: true })
    await send('Network.setUserAgentOverride', { userAgent: policyUserAgent() })
    // Pause BEFORE any request is sent, including JS redirects and subresources.
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true })
    const navigated = await send('Page.navigate', { url })
    if (navigated.errorText) throw new Error(String(navigated.errorText))
    await delay(Math.max(0, Math.min(options.settleMs ?? 1200, 10_000)), signal)
    if (options.scrollToBottom !== false) {
      await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body?.scrollHeight || 0); 1' })
      await delay(400, signal)
    }
    const evaluated = await send('Runtime.evaluate', {
      expression: `(() => { const html = document.documentElement?.outerHTML || ''; return JSON.stringify(new TextEncoder().encode(html).length > ${maxBytes} ? { error: '渲染 DOM 超过体积上限' } : { html, url: location.href }); })()`,
      returnByValue: true,
    })
    const raw = (evaluated.result as { value?: string } | undefined)?.value
    if (!raw || Buffer.byteLength(raw) > maxBytes * 2 + 4096) throw new Error('渲染后未取到有界 DOM')
    const parsed = JSON.parse(raw) as { html?: string; url?: string; error?: string }
    if (parsed.error) throw new Error(parsed.error)
    if (!parsed.url || !allowed(parsed.url)) throw new Error('渲染最终地址不在允许清单/抓取范围内')
    if (!parsed.html || Buffer.byteLength(parsed.html, 'utf8') > maxBytes) throw new Error('渲染 DOM 为空或超过体积上限')
    if (isAccessControlPage(parsed.html)) throw new Error('渲染结果为登录/验证码/访问控制页面，不继续采集')
    return { ok: true, url: parsed.url, html: parsed.html }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally { off() }
}

export async function renderWithChrome(url: string, options: RenderOptions = {}): Promise<RenderResult> {
  const hosts = options.hosts ?? (() => { try { return [new URL(url).hostname] } catch { return [] } })()
  if (!hostAllowed(url, hosts) || options.isUrlAllowed?.(url) === false) return { ok: false, error: '渲染地址不在允许清单/抓取范围内' }
  if (options.signal?.aborted) return { ok: false, error: '已取消' }
  const browser = findChrome()
  if (!browser) return { ok: false, error: '未找到 Chrome（可用 DSH_CHROME 指定路径）' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('浏览器渲染超时')), Math.max(1, Math.min(options.timeoutMs ?? 20_000, 300_000)))
  const onAbort = (): void => controller.abort(options.signal?.reason ?? new Error('已取消'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const signal = controller.signal
  let session: CdpSession | undefined
  let profile: string | undefined
  let child: ReturnType<typeof spawn> | undefined
  try {
    signal.throwIfAborted()
    // Never reuse a profile/cookies or connect to an unrelated debugging port.
    profile = await mkdtemp(path.join(tmpdir(), 'dsh-policy-render-'))
    child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
    child.on('error', (error) => controller.abort(error))
    let port = 0
    while (!port) {
      signal.throwIfAborted()
      if (child.exitCode !== null) throw new Error(`Chrome 提前退出（${child.exitCode}）`)
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]) } catch { /* not ready */ }
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) { port = 0; await delay(100, signal) }
    }
    session = await connect(port, signal)
    return { ...await renderCdpPage(session, url, { ...options, hosts }, signal), browser }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), browser }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    session?.close()
    if (child) {
      try { child.kill() } catch { /* exited */ }
      await new Promise<void>((resolve) => { if (child!.exitCode !== null) resolve(); else { const timer = setTimeout(resolve, 1500); child!.once('exit', () => { clearTimeout(timer); resolve() }) } })
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  }
}
