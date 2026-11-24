/**
 * 新浪全球期货接口的黄金 CFD 参考日线（JSONP），不是 COMEX 等价备源。
 *
 * 2026-11-24 核查：https://finance.sina.com.cn/futures/quotes/GC.shtml 的
 * title / futures_app.name 明确是「纽约黄金CFD」。GC 报价为 USD/troy oz，
 * 不换算、不冒充固定到期或交易所连续合约，不与东财 GC00Y 拼接。
 * 仅保留本轮核查的 GC；SI/CL/OIL/HG 均不推测映射（HG 还存在单位差异）。
 * 实测接口 volume="0" 为占位，因此无量/零占位/非法量统一保留 null。
 */

export const SINA_FUTURES_BASE = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php'
export const SINA_FUTURES_TIMEOUT_MS = 12_000
export const SINA_FUTURES_MAX_RESPONSE_BYTES = 2_000_000
export const SINA_FUTURES_MAX_BARS = 500
export const SINA_FUTURES_DEFAULT_BARS = 120

/** 仅是显式选择代理走势时的查找表，不表示两家合约等价。 */
export const SINA_FUTURES_BY_SECID: Readonly<Record<string, string>> = Object.freeze({
  '101.GC00Y': 'GC',
})

export interface FuturesInstrument {
  name: '纽约黄金CFD'
  symbol: 'GC'
  kind: 'cfd'
  unit: 'USD/troy oz'
  proxy: true
  requestedSecid: string
}

export function sinaFuturesInstrument(secid: string): FuturesInstrument | undefined {
  if (secid !== '101.GC00Y') return undefined
  return { name: '纽约黄金CFD', symbol: 'GC', kind: 'cfd', unit: 'USD/troy oz', proxy: true, requestedSecid: secid }
}

export function sinaFuturesUrl(symbol: string): string {
  // The JSONP assignment is fixed by our request; do not accept arbitrary JS callbacks.
  if (symbol !== 'GC') throw new Error('该品种没有已核实的新浪代理映射')
  return `${SINA_FUTURES_BASE}/var%20_${symbol}=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${symbol}`
}

export interface FuturesBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface FuturesKlineDiagnostics {
  inputRows: number
  invalidRows: number
  duplicateRows: number
  latestSourceDate?: string
  /** 最多五个最近被丢弃的合法日期（升序），便于定位当前缺口；不是完整坏行清单。 */
  discardedDates: string[]
}

export interface FuturesKlineResult {
  ok: boolean
  secid: string
  symbol?: string
  bars: FuturesBar[]
  source: 'sina-global-futures'
  instrument?: FuturesInstrument
  warnings?: string[]
  diagnostics?: FuturesKlineDiagnostics
  error?: string
}

export interface FuturesFetchOptions {
  signal?: AbortSignal
  fetchText?: (url: string, signal?: AbortSignal) => Promise<string>
  /** 可缩短测试/调用预算，但不能突破默认 12 秒上限。 */
  timeoutMs?: number
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * 只接受本模块请求的 `var _GC=([...]);`，以及新浪已实测的固定防 XSS 注释。
 * 锚定整个响应并核对 symbol；只做 JSON.parse，绝不 eval/执行注释或尾部脚本。
 */
export function extractSinaFuturesArray(text: string, symbol = 'GC'): unknown[] | null {
  if (typeof text !== 'string' || text.length > SINA_FUTURES_MAX_RESPONSE_BYTES || symbol !== 'GC') return null
  const match = /^\s*(?:\/\*<script>location\.href='\/\/sina\.com';<\/script>\*\/\s*)?var\s+_([A-Z0-9]+)\s*=\s*\(\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/.exec(text)
  if (!match || match[1] !== symbol) return null
  try {
    const parsed: unknown = JSON.parse(match[2]!)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/**
 * 日期须为真实公历日，OHLC 须有限、为正且上下界一致；不修补坏行。
 * 同日期取最后一条合法源记录（非法重复不覆盖），排序后仍是一条独立源序列。
 */
export function parseSinaFuturesKline(secid: string, payload: unknown): FuturesKlineResult {
  const source = 'sina-global-futures' as const
  const instrument = sinaFuturesInstrument(secid)
  if (!instrument) return { ok: false, secid, bars: [], source, error: '该品种没有已核实的新浪代理映射' }
  if (!Array.isArray(payload)) return { ok: false, secid, bars: [], source, instrument, error: '新浪期货日K返回格式变化或品种不一致' }
  const byDate = new Map<string, FuturesBar>()
  const diagnostics: FuturesKlineDiagnostics = { inputRows: payload.length, invalidRows: 0, duplicateRows: 0, discardedDates: [] }
  const discard = (date?: string) => {
    diagnostics.invalidRows++
    if (date && !diagnostics.discardedDates.includes(date)) diagnostics.discardedDates = [...diagnostics.discardedDates, date].sort().slice(-5)
  }
  for (const row of payload) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { discard(); continue }
    const record = row as Record<string, unknown>
    const date = record.date
    if (!validDate(date)) { discard(); continue }
    if (!diagnostics.latestSourceDate || date > diagnostics.latestSourceDate) diagnostics.latestSourceDate = date
    const open = num(record.open), high = num(record.high), low = num(record.low), close = num(record.close)
    if (open === null || high === null || low === null || close === null ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) { discard(date); continue }
    const rawVolume = num(record.volume)
    if (byDate.has(date)) diagnostics.duplicateRows++
    byDate.set(date, { date, open, high, low, close, volume: rawVolume !== null && rawVolume > 0 ? rawVolume : null })
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  const warnings = [
    '新浪纽约黄金CFD参考走势，不等同COMEX黄金期货；不得将两源价格拼接或视为同一合约。',
    '最新日K可能尚未收盘；日期沿用源交易日，缺失成交量保留null。',
  ]
  if (diagnostics.invalidRows) warnings.push(`新浪完整响应${diagnostics.inputRows}条记录中有${diagnostics.invalidRows}条日期/OHLC无效，已丢弃且未修补。`)
  if (diagnostics.duplicateRows) warnings.push(`新浪源有${diagnostics.duplicateRows}条同日重复记录，取最后一条合法记录。`)
  if (!bars.length) return { ok: false, secid, symbol: instrument.symbol, bars: [], source, instrument, warnings, diagnostics, error: '新浪期货日K全部无效' }
  return { ok: true, secid, symbol: instrument.symbol, bars, source, instrument, warnings, diagnostics }
}

function clampBars(limit: number): number {
  if (!Number.isFinite(limit)) return SINA_FUTURES_DEFAULT_BARS
  return Math.min(SINA_FUTURES_MAX_BARS, Math.max(1, Math.trunc(limit)))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

/** 覆盖 headers + 完整 body 的总预算；即使注入源忽略 signal，也及时结束等待。 */
async function fetchTextWithDeadline(url: string, options: FuturesFetchOptions): Promise<string> {
  throwIfAborted(options.signal)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(SINA_FUTURES_TIMEOUT_MS, Math.max(1, Math.trunc(options.timeoutMs!))) : SINA_FUTURES_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('aborted'))
  const timer = setTimeout(() => controller.abort(new Error(`新浪期货日K超时（${timeoutMs}ms）`)), timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new Error('aborted'))
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    const text = await Promise.race([(options.fetchText ?? defaultFetchText)(url, controller.signal), aborted])
    throwIfAborted(options.signal)
    if (typeof text !== 'string' || text.length > SINA_FUTURES_MAX_RESPONSE_BYTES) throw new Error('新浪期货日K响应超过体积上限或不是文本')
    return text
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}

/** 调用者明确请求新浪代理走势；fetchGlobalKline 还须单独获得 allowProxyFallback。 */
export async function fetchSinaFuturesKline(secid: string, limit: number, options: FuturesFetchOptions = {}): Promise<FuturesKlineResult> {
  throwIfAborted(options.signal)
  const instrument = sinaFuturesInstrument(secid)
  if (!instrument) return { ok: false, secid, bars: [], source: 'sina-global-futures', error: '该品种没有已核实的新浪代理映射' }
  try {
    const text = await fetchTextWithDeadline(sinaFuturesUrl(instrument.symbol), options)
    const parsed = parseSinaFuturesKline(secid, extractSinaFuturesArray(text, instrument.symbol))
    throwIfAborted(options.signal)
    return parsed.ok ? { ...parsed, bars: parsed.bars.slice(-clampBars(limit)) } : parsed
  } catch (error) {
    // 用户取消不是源故障，不能吞掉后继续请求/返回旧图。
    throwIfAborted(options.signal)
    return { ok: false, secid, symbol: instrument.symbol, bars: [], source: 'sina-global-futures', instrument, error: error instanceof Error ? error.message : String(error) }
  }
}

async function defaultFetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' },
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status} for ${new URL(url).hostname}`)
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > SINA_FUTURES_MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('新浪期货日K响应超过体积上限')
  }
  if (!response.body) throw new Error('新浪期货日K返回空响应体')
  const reader = response.body.getReader()
  // 真实响应 charset=gbk；JSON 中数值/日期为 ASCII，但仍按源编码解码。
  const decoder = new TextDecoder('gbk')
  let text = '', bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > SINA_FUTURES_MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('新浪期货日K响应超过体积上限')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}
