/**
 * Global quotes & K-line by Eastmoney secid (indices and foreign individual stocks).
 *
 * Secids observed in production: 100.* = global indices, 105/106/107.* = US,
 * 116.* = HK, 176.* = Japan, 155.* = UK/LSE, plus other country namespaces that
 * Eastmoney's suggestion API returns. We do NOT hardcode a whitelist of markets:
 * the caller passes a secid obtained from the real search/indices payload, and we
 * only verify the response's own code/market before returning it.
 *
 * Prices/percentages come back already scaled (fltt=2), so they are NOT divided
 * by 100 again. Missing fields stay null; zero remains zero.
 */

export const GLOBAL_QUOTE_TIMEOUT_MS = 12_000
export const GLOBAL_QUOTE_CACHE_TTL_MS = 30_000
export const GLOBAL_KLINE_MAX_BARS = 500
export const GLOBAL_KLINE_DEFAULT_BARS = 120

/** Same public token other Eastmoney quote endpoints in this repo use. */
const QUOTE_UT = 'b2884a393a59ad64002292a3e90d46a5'

const SECID_RE = /^(\d{1,3})\.([A-Za-z0-9._-]{1,24})$/

export function isValidSecid(value: unknown): value is string {
  return typeof value === 'string' && SECID_RE.test(value.trim())
}

export function normalizeSecid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return SECID_RE.test(trimmed) ? trimmed : null
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim()
  return s ? s : undefined
}

/** f86 is a Unix timestamp (seconds; tolerate milliseconds). Return UTC ISO or undefined. */
export function globalQuoteTime(raw: unknown): string | undefined {
  const n = num(raw)
  if (n === null || n <= 0) return undefined
  const ms = n > 1e12 ? n : n * 1000
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export interface GlobalQuote {
  secid: string
  code?: string
  name?: string
  price: number | null
  change: number | null
  changePct: number | null
  previousClose: number | null
  high: number | null
  low: number | null
  open: number | null
  asOf?: string
  source: 'eastmoney-push2'
}

export interface GlobalQuoteResult {
  ok: boolean
  secid?: string
  quote?: GlobalQuote
  error?: string
}

/** Pure parser for push2 `qt/stock/get` payload. */
export function parseGlobalQuote(secid: string, payload: unknown): GlobalQuoteResult {
  if (!isValidSecid(secid)) return { ok: false, error: `无效的 secid：${String(secid)}` }
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined
  if (!data || typeof data !== 'object') return { ok: false, secid, error: '行情源返回空数据（可能是暂停交易或代码不存在）' }
  const d = data as Record<string, unknown>
  const price = num(d.f43)
  // A quote with no price at all is not "zero"; treat as missing.
  if (price === null) return { ok: false, secid, error: '行情源未返回最新价' }
  const quote: GlobalQuote = {
    secid,
    code: str(d.f57),
    name: str(d.f58),
    price,
    change: num(d.f169),
    changePct: num(d.f170),
    previousClose: num(d.f60),
    high: num(d.f44),
    low: num(d.f45),
    open: num(d.f46),
    asOf: globalQuoteTime(d.f86),
    source: 'eastmoney-push2',
  }
  return { ok: true, secid, quote }
}

export function globalQuoteUrl(secid: string): string {
  const fields = 'f43,f44,f45,f46,f57,f58,f60,f86,f169,f170'
  return `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${fields}`
}

export interface GlobalBar { date: string; open: number; high: number; low: number; close: number; volume: number }

export interface GlobalKlineResult {
  ok: boolean
  secid?: string
  code?: string
  name?: string
  bars: GlobalBar[]
  error?: string
  source: 'eastmoney-push2'
}

export function clampGlobalKlineBars(limit: unknown): number {
  const n = num(limit)
  if (n === null) return GLOBAL_KLINE_DEFAULT_BARS
  return Math.min(GLOBAL_KLINE_MAX_BARS, Math.max(1, Math.trunc(n)))
}

export function globalKlineUrl(secid: string, limit: number): string {
  const lmt = clampGlobalKlineBars(limit)
  const fields1 = 'f1,f2,f3,f4,f5,f6'
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57'
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=${QUOTE_UT}&secid=${encodeURIComponent(secid)}&klt=101&fqt=1&lmt=${lmt}&end=20500101&fields1=${fields1}&fields2=${fields2}`
}

/**
 * Parse `kline/get` payload. Each kline string is
 * `date,open,close,high,low,volume,amount`. Rows with a non-positive or
 * non-finite close are skipped (suspension/placeholder), never coerced to 0.
 */
export function parseGlobalKline(secid: string, payload: unknown): GlobalKlineResult {
  const source = 'eastmoney-push2' as const
  if (!isValidSecid(secid)) return { ok: false, secid, bars: [], error: `无效的 secid：${String(secid)}`, source }
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined
  if (!data || typeof data !== 'object') return { ok: false, secid, bars: [], error: 'K线源返回空数据（可能无该市场历史）', source }
  const d = data as Record<string, unknown>
  const rawLines = Array.isArray(d.klines) ? d.klines : []
  const bars: GlobalBar[] = []
  for (const line of rawLines) {
    if (typeof line !== 'string') continue
    const parts = line.split(',')
    if (parts.length < 6) continue
    const date = parts[0]!.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const open = num(parts[1]), close = num(parts[2]), high = num(parts[3]), low = num(parts[4]), volume = num(parts[5])
    if (close === null || close <= 0) continue
    bars.push({ date, open: open ?? close, high: high ?? close, low: low ?? close, close, volume: volume ?? 0 })
  }
  return { ok: true, secid, code: str(d.code), name: str(d.name), bars, source }
}

export interface GlobalQuoteFetchOptions {
  fetchJson?: (url: string, init?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>
  now?: () => number
  cache?: Map<string, { at: number; value: GlobalQuoteResult }>
  signal?: AbortSignal
}

async function defaultFetchJson(url: string, init?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? GLOBAL_QUOTE_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  init?.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Referer: 'https://quote.eastmoney.com/' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    init?.signal?.removeEventListener('abort', onAbort)
  }
}

const quoteCache = new Map<string, { at: number; value: GlobalQuoteResult }>()

export async function fetchGlobalQuote(secidInput: unknown, options: GlobalQuoteFetchOptions = {}): Promise<GlobalQuoteResult> {
  const secid = normalizeSecid(secidInput)
  if (!secid) return { ok: false, error: `无效的 secid：${String(secidInput)}` }
  const now = options.now ?? Date.now
  const cache = options.cache ?? quoteCache
  const hit = cache.get(secid)
  if (hit && now() - hit.at < GLOBAL_QUOTE_CACHE_TTL_MS) return hit.value
  const fetchJson = options.fetchJson ?? defaultFetchJson
  try {
    const payload = await fetchJson(globalQuoteUrl(secid), { signal: options.signal })
    const result = parseGlobalQuote(secid, payload)
    if (result.ok) cache.set(secid, { at: now(), value: result })
    return result
  } catch (err) {
    return { ok: false, secid, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchGlobalKline(secidInput: unknown, limit: unknown = GLOBAL_KLINE_DEFAULT_BARS, options: GlobalQuoteFetchOptions = {}): Promise<GlobalKlineResult> {
  const secid = normalizeSecid(secidInput)
  if (!secid) return { ok: false, error: `无效的 secid：${String(secidInput)}`, bars: [], source: 'eastmoney-push2' }
  const fetchJson = options.fetchJson ?? defaultFetchJson
  try {
    const payload = await fetchJson(globalKlineUrl(secid, clampGlobalKlineBars(limit)), { signal: options.signal })
    return parseGlobalKline(secid, payload)
  } catch (err) {
    return { ok: false, secid, bars: [], error: err instanceof Error ? err.message : String(err), source: 'eastmoney-push2' }
  }
}
