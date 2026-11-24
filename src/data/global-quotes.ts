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

import { httpGetJson } from './http.js'
import {
  fetchSinaFuturesKline, sinaFuturesInstrument,
  type FuturesInstrument, type FuturesKlineDiagnostics,
} from './sina-global-futures.js'

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
  // The first dot separates the market; later dots belong to the ticker (e.g. BRK.B).
  const [, market, requestedCode] = SECID_RE.exec(secid.trim())!
  if ((str(d.f57) && String(d.f57).toUpperCase() !== requestedCode!.toUpperCase()) ||
      (d.f107 !== undefined && String(d.f107) !== market)) return { ok: false, secid, error: '行情响应品种与请求不一致' }
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
  const fields = 'f43,f44,f45,f46,f57,f58,f60,f86,f107,f169,f170'
  return `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${fields}`
}

export interface GlobalBar { date: string; open: number; high: number; low: number; close: number; /** 源侧没有量时为 null，不当成 0 成交。 */ volume: number | null }

export interface GlobalKlineResult {
  ok: boolean
  secid?: string
  code?: string
  name?: string
  bars: GlobalBar[]
  error?: string
  source: 'eastmoney-push2' | 'tencent-kline' | 'sina-global-futures'
  /** 新浪 GC 是 CFD，不是所请求的 COMEX 交易所合约。 */
  instrument?: FuturesInstrument
  /** 东财失败、但用户尚未显式选择代理走势时供 UI 展示入口；不会自动取代理数据。 */
  availableProxy?: FuturesInstrument
  warnings?: string[]
  diagnostics?: FuturesKlineDiagnostics
}

/**
 * 腾讯日 K 备源映射（东财 push2his 被重置时的兜底）。
 * 只映射腾讯确有连续日线的品种：美股三大指数、恒指与恒生科技、沪深指数。
 * 100.NDX 在东财返回的其实是纳斯达克综合指数（与腾讯 usIXIC 同一数值），故按 usIXIC 取。
 * 其余品种（日经、欧洲、商品、美元指数）腾讯没有同日线，保持东财失败即报错。
 * 黄金可在用户显式选择后另看新浪 CFD 参考走势，但绝不当作等价合约自动回落。
 */
export const TX_GLOBAL_KLINE_SYMBOL: Readonly<Record<string, string>> = {
  '100.SPX': 'usINX',
  '100.DJIA': 'usDJI',
  '100.NDX': 'usIXIC',
  '100.HSI': 'hkHSI',
  '124.HSTECH': 'hkHSTECH',
  '1.000001': 'sh000001',
  '0.399001': 'sz399001',
  '0.399006': 'sz399006',
}

export function tencentKlineUrl(symbol: string, limit: number): string {
  const count = clampGlobalKlineBars(limit)
  return `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(symbol)},day,,,${count}`
}

/**
 * 解析腾讯日 K：`data[<key>].day` 里每行 `date,open,close,high,low,volume`（升序）。
 * 腾讯对部分品种返回的 key 带市场前缀（us.INX），所以按对象里的第一个 key 取，不写死。
 * 收盘价非正/非有限的行跳过，不补 0。
 */
export function parseTencentGlobalKline(secid: string, payload: unknown): GlobalKlineResult {
  const data = (payload as { data?: Record<string, { day?: unknown[][]; qt?: Record<string, string[]> }> } | null)?.data
  const symbol = TX_GLOBAL_KLINE_SYMBOL[secid]
  const alias = symbol?.startsWith('us') ? 'us.' + symbol.slice(2) : symbol
  const key = symbol && data && Object.hasOwn(data, symbol) ? symbol
    : alias && data && Object.hasOwn(data, alias) ? alias : undefined
  const node = key ? data![key] : undefined
  const rows = node?.day
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, secid, bars: [], error: '腾讯日K未返回数据', source: 'tencent-kline' }
  }
  const bars: GlobalBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const [date, rawOpen, rawClose, rawHigh, rawLow, rawVolume] = row
    const open = num(rawOpen), close = num(rawClose), high = num(rawHigh), low = num(rawLow), volume = num(rawVolume)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || open === null || close === null || high === null || low === null || volume === null ||
        Math.min(open, close, high, low) <= 0 || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close)) continue
    bars.push({ date: String(date), open, close, high, low, volume })
  }
  if (!bars.length) return { ok: false, secid, bars: [], error: '腾讯日K全部无效', source: 'tencent-kline' }
  const name = node?.qt?.[key!]?.[1]
  return { ok: true, secid, ...(typeof name === 'string' ? { name } : {}), bars, source: 'tencent-kline' }
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
  // The first dot separates the market; later dots belong to the ticker (e.g. BRK.B).
  const [, market, requestedCode] = SECID_RE.exec(secid.trim())!
  if ((str(d.code) && String(d.code).toUpperCase() !== requestedCode!.toUpperCase()) ||
      (d.market !== undefined && String(d.market) !== market)) return { ok: false, secid, bars: [], error: 'K线响应品种与请求不一致', source }
  const rawLines = Array.isArray(d.klines) ? d.klines : []
  const bars: GlobalBar[] = []
  for (const line of rawLines) {
    if (typeof line !== 'string') continue
    const parts = line.split(',')
    if (parts.length < 6) continue
    const date = parts[0]!.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const open = num(parts[1]), close = num(parts[2]), high = num(parts[3]), low = num(parts[4]), volume = num(parts[5])
    if (open === null || close === null || high === null || low === null || volume === null ||
        Math.min(open, close, high, low) <= 0 || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close)) continue
    bars.push({ date, open, high, low, close, volume })
  }
  return { ok: true, secid, code: str(d.code), name: str(d.name), bars, source }
}

export interface GlobalQuoteFetchOptions {
  fetchJson?: (url: string, init?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>
  /** 注入口径为文本的源（新浪期货 JSONP）；缺省走真实网络。 */
  fetchText?: (url: string, signal?: AbortSignal) => Promise<string>
  /** 默认 false；显式允许在东财失败后查看非等价的新浪黄金 CFD 参考走势。 */
  allowProxyFallback?: boolean
  now?: () => number
  cache?: Map<string, { at: number; value: GlobalQuoteResult }>
  signal?: AbortSignal
}

async function defaultFetchJson(url: string, init?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  return httpGetJson(url, {}, { timeoutMs: init?.timeoutMs ?? GLOBAL_QUOTE_TIMEOUT_MS,
    referer: new URL(url).hostname.endsWith('gtimg.cn') ? 'https://gu.qq.com/' : 'https://quote.eastmoney.com/', signal: init?.signal })
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
  const throwIfAborted = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted') }
  throwIfAborted()
  const count = clampGlobalKlineBars(limit)
  const fetchJson = options.fetchJson ?? defaultFetchJson
  let emError = ''
  try {
    const payload = await fetchJson(globalKlineUrl(secid, count), { signal: options.signal })
    throwIfAborted()
    const parsed = parseGlobalKline(secid, payload)
    if (parsed.ok && parsed.bars.length) return { ...parsed, bars: parsed.bars.slice(-count) }
    emError = parsed.error ?? '东财未返回日K'
  } catch (err) {
    throwIfAborted()
    emError = err instanceof Error ? err.message : String(err)
  }
  // 东财源故障才尝试等价腾讯指数备源；调用方取消不得继续启动后续网络请求。
  throwIfAborted()
  const symbol = TX_GLOBAL_KLINE_SYMBOL[secid]
  if (!symbol) {
    const availableProxy = sinaFuturesInstrument(secid)
    if (!availableProxy) {
      return { ok: false, secid, bars: [], error: `东财日K不可用（${emError}），该品种没有备用源`, source: 'eastmoney-push2' }
    }
    if (options.allowProxyFallback !== true) {
      return { ok: false, secid, bars: [], availableProxy, error: `东财日K不可用（${emError}）；可选新浪纽约黄金CFD参考走势，不等同COMEX黄金期货，需显式选择`, source: 'eastmoney-push2' }
    }
    const futures = await fetchSinaFuturesKline(secid, count, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchText ? { fetchText: options.fetchText } : {}),
    })
    throwIfAborted()
    // 保留代理身份与坏行诊断；只返回独立新浪序列，绝不与东财价格拼接。
    return futures.ok ? futures : {
      ...futures, availableProxy,
      error: `东财日K与新浪黄金CFD参考走势都不可用：${emError} / ${futures.error ?? ''}`,
    }
  }
  try {
    const payload = await fetchJson(tencentKlineUrl(symbol, count), { signal: options.signal })
    throwIfAborted()
    const fallback = parseTencentGlobalKline(secid, payload)
    return fallback.ok ? { ...fallback, bars: fallback.bars.slice(-count) } : { ...fallback, error: `东财不可用（${emError}）；${fallback.error ?? ''}` }
  } catch (err) {
    throwIfAborted()
    return { ok: false, secid, bars: [], error: `东财与腾讯日K都不可用：${emError} / ${err instanceof Error ? err.message : String(err)}`, source: 'eastmoney-push2' }
  }
}
