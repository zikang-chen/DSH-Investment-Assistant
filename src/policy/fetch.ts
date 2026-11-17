/**
 * Policy fetching with an explicit allowlist, size caps and a minimal robots.txt
 * check. Deliberately separate from the market-data HTTP layer: official policy
 * sites need raw bytes (hashing + immutable snapshots) and stricter rules.
 *
 * Honest identity: the User-Agent names this plugin and a contact URL; it never
 * impersonates a browser profile for policy sites. Set `DSH_POLICY_UA` to append
 * an operator contact address.
 */
import { createHash } from 'node:crypto'

export const POLICY_UA =
  'dsh-investment-assistant-policy/0.1 (+https://github.com/zikang-chen/DSH-Investment-Assistant)'

/** Appended from the environment so operators can add a contact address. */
export function policyUserAgent(): string {
  const extra = (process.env.DSH_POLICY_UA ?? '').trim()
  return extra ? `${POLICY_UA} ${extra}` : POLICY_UA
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

export interface RawResponse {
  /** Final URL after redirects. */
  url: string
  status: number
  contentType: string
  buffer: Buffer
  bytes: number
}

export interface FetchOptions {
  /** Host allowlist: exact host, or `*.example.com` for any subdomain. */
  hosts: string[]
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
  /** Check robots.txt first (default true). */
  respectRobots?: boolean
  /** Skip the robots check for a host we already cleared in this run. */
  robotsCache?: Map<string, string>
  headers?: Record<string, string>
}

export class PolicyFetchError extends Error {
  constructor(message: string, readonly code:
    | 'not-allowlisted'
    | 'bad-url'
    | 'http-error'
    | 'too-large'
    | 'robots-disallowed'
    | 'timeout'
    | 'aborted') {
    super(message)
    this.name = 'PolicyFetchError'
  }
}

/** Host allowlist check: `example.com` matches exactly; `*.example.com` matches subdomains. */
export function hostAllowed(url: string, hosts: string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return hosts.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (!entry) return false
    if (entry.startsWith('*.')) {
      const base = entry.slice(2)
      return host === base || host.endsWith(`.${base}`)
    }
    return host === entry
  })
}

/** Parse the subset of robots.txt that matters here: groups, Allow, Disallow, Crawl-delay. */
export interface RobotsRules {
  groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; crawlDelaySec?: number }>
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules['groups'] = []
  let current: RobotsRules['groups'][number] | undefined
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (field === 'user-agent') {
      // A new agent line after rules starts a new group.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (!current) {
      current = { agents: ['*'], rules: [] }
      groups.push(current)
    }
    if (field === 'allow') current.rules.push({ allow: true, path: value })
    else if (field === 'disallow') current.rules.push({ allow: false, path: value })
    else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n
    }
  }
  return { groups }
}

/** Longest-match Allow/Disallow evaluation for one path. */
export function robotsAllows(rules: RobotsRules, path: string, agentToken = 'dsh-finance-policy'): boolean {
  const token = agentToken.toLowerCase()
  const applicable = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)))
  const group = applicable.length > 0
    ? applicable[0]!
    : rules.groups.find((g) => g.agents.includes('*'))
  if (!group) return true
  const target = path === '' ? '/' : path
  let best: { allow: boolean; length: number } | undefined
  for (const rule of group.rules) {
    if (rule.path === '') continue
    const prefix = rule.path.replace(/\*$/, '')
    const matches = rule.path.endsWith('*') ? target.startsWith(prefix) : target.startsWith(rule.path)
    if (!matches) continue
    if (!best || rule.path.length > best.length) best = { allow: rule.allow, length: rule.path.length }
  }
  return best ? best.allow : true
}

async function loadRobots(origin: string, opts: FetchOptions): Promise<RobotsRules | undefined> {
  const cache = opts.robotsCache
  if (cache?.has(origin)) {
    const cached = cache.get(origin)!
    return cached === '' ? undefined : parseRobots(cached)
  }
  try {
    const res = await rawFetch(`${origin}/robots.txt`, { ...opts, respectRobots: false, maxBytes: 256 * 1024 })
    const text = res.buffer.toString('utf8')
    cache?.set(origin, text)
    return parseRobots(text)
  } catch {
    // No robots.txt (404/timeout) is treated as "no rules published".
    cache?.set(origin, '')
    return undefined
  }
}

async function rawFetch(url: string, opts: FetchOptions): Promise<RawResponse> {
  if (!hostAllowed(url, opts.hosts)) throw new PolicyFetchError(`不在允许清单内的主机：${url}`, 'not-allowlisted')
  if (opts.signal?.aborted) throw new PolicyFetchError('已取消', 'aborted')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs)
  const onAbort = (): void => ctrl.abort(opts.signal?.reason ?? new Error('aborted'))
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let target = url
    let res: Response
    for (let hop = 0; ; hop++) {
      // Validate BEFORE sending each request; redirect:'follow' would contact an
      // off-allowlist host before the old final-URL check could reject it.
      if (!hostAllowed(target, opts.hosts)) throw new PolicyFetchError(`重定向到允许清单外的主机：${target}`, 'not-allowlisted')
      res = await fetch(target, {
        redirect: 'manual', signal: ctrl.signal,
        headers: {
          'User-Agent': policyUserAgent(),
          Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/pdf,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9', ...opts.headers,
        },
      })
      if (![301, 302, 303, 307, 308].includes(res.status)) break
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!location || hop >= 5) throw new PolicyFetchError('重定向过多或缺少 Location', 'http-error')
      target = new URL(location, target).toString()
      if (!hostAllowed(target, opts.hosts)) throw new PolicyFetchError(`重定向到允许清单外的主机：${target}`, 'not-allowlisted')
      if (opts.respectRobots !== false) {
        const next = new URL(target)
        const rules = await loadRobots(next.origin, opts)
        if (rules && !robotsAllows(rules, `${next.pathname}${next.search}`)) throw new PolicyFetchError('robots.txt 不允许重定向目标', 'robots-disallowed')
      }
    }
    if (!hostAllowed(res.url, opts.hosts)) {
      throw new PolicyFetchError(`重定向到允许清单外的主机：${res.url}`, 'not-allowlisted')
    }
    if (!res.ok) throw new PolicyFetchError(`HTTP ${res.status} ${res.statusText}`, 'http-error')
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > opts.maxBytes) throw new PolicyFetchError(`响应过大（${declared} 字节 > ${opts.maxBytes}）`, 'too-large')
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => {})
          throw new PolicyFetchError(`响应超过上限 ${opts.maxBytes} 字节`, 'too-large')
        }
        chunks.push(value)
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    return {
      url: res.url,
      status: res.status,
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      buffer,
      bytes: buffer.byteLength,
    }
  } catch (err) {
    if (err instanceof PolicyFetchError) throw err
    const e = err as Error
    if (e.name === 'AbortError') {
      throw new PolicyFetchError(opts.signal?.aborted ? '已取消' : `请求超时（${opts.timeoutMs}ms）`, opts.signal?.aborted ? 'aborted' : 'timeout')
    }
    throw new PolicyFetchError(e.message, 'http-error')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Fetch one document, honouring robots.txt unless the caller opts out. */
export async function fetchPolicyDocument(url: string, opts: FetchOptions): Promise<RawResponse> {
  const parsed = new URL(url)
  if (opts.respectRobots !== false) {
    const rules = await loadRobots(parsed.origin, opts)
    if (rules && !robotsAllows(rules, `${parsed.pathname}${parsed.search}`)) {
      throw new PolicyFetchError(`robots.txt 不允许抓取：${parsed.pathname}`, 'robots-disallowed')
    }
  }
  return rawFetch(url, opts)
}
