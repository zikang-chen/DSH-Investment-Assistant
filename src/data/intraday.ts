/**
 * 分时数据（东财 push2his trends2）：当日或近 5 日分钟级价格。
 *
 * 口径与边界：
 * - 只做行情展示：points 是「时间 + 成交价 + 均价 + 分钟量额」，不做聚合计算。
 * - 东财 trends2（包括美股）源侧 `YYYY-MM-DD HH:mm` 已是北京时间（实测契约），
 *   原样保留并按 +08:00 转 ISO；不是把美股交易所当地时间强行当作东八区。
 * - 非法/缺失日期时间显式拒绝，不用抓取日补造行情日期。
 * - 缺字段为 null，不补 0；`price=0` 这类真实 0 保留。
 * - 该接口不除权：分时只用于当日/近 5 日，不做复权推断。
 */

import { httpGetJson, emSecMarket, normalizeCode, stripMarketSuffix, type HttpGetOptions } from './http.js'

export const EM_INTRADAY_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
export const INTRADAY_TIMEOUT_MS = 12_000
export const INTRADAY_MAX_DAYS = 5

export type IntradayKind = 'a' | 'hk' | 'us' | 'global'

export interface IntradayPoint {
  /** 源侧时间原文，如 2026-11-23 09:30。 */
  time: string
  /** ISO 时间（+08:00），解析失败为 null。 */
  at: string | null
  price: number | null
  avgPrice: number | null
  volume: number | null
  amount: number | null
}

export interface IntradaySeries {
  code: string
  name?: string
  kind: IntradayKind
  days: number
  /** 昨收（用于分时基线与涨跌幅），缺失为 null。 */
  preClose: number | null
  points: IntradayPoint[]
  source: string
  /** 抓取时间；不是行情时间。 */
  at: string
  secid?: string
  timezone?: 'Asia/Shanghai' | 'unknown'
  volumeUnit?: 'shares' | 'lots' | 'source'
  amountUnit?: 'CNY' | 'HKD' | 'source'
  warnings?: string[]
}

function num(value: string | undefined): number | null {
  // 注意 Number('') === 0：空串必须当缺失，不能变成真实的 0。
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toIso(time: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})\s+([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time.trim())
  if (!m) return null
  const wall = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}`
  const d = new Date(`${wall}+08:00`)
  if (!Number.isFinite(d.getTime())) return null
  // Date 会将 2 月 30 日等归一化，必须回读验证而不是接受变造日期。
  if (new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) !== wall) return null
  return d.toISOString()
}

function bareCode(code: string, kind: IntradayKind): string {
  const raw = stripMarketSuffix(code)
  if (kind === 'us' || kind === 'global') return raw.trim().toUpperCase()
  if (kind === 'hk') return raw.replace(/\D/g, '').padStart(5, '0').slice(-5)
  return normalizeCode(raw)
}

/** 东财 secid：A 股 1./0.，港股 116.；美股这里只给首候选，fetchIntraday 会发现真实市场。 */
export function intradaySecid(code: string, kind: IntradayKind): string {
  if (kind === 'global') throw new Error('全球分时必须提供证券解析得到的 secid')
  if (kind === 'hk') return `116.${bareCode(code, kind)}`
  if (kind === 'us') return `105.${bareCode(code, kind)}`
  return `${emSecMarket(code)}.${normalizeCode(code)}`
}

interface IntradayMeta {
  code: string
  kind: IntradayKind
  days: number
  secid?: string
  /** 无真实美股 secid 时，候选响应必须有可验证的 code 和 market。 */
  requireIdentity?: boolean
}

function validateIdentity(data: { code?: unknown; market?: unknown }, meta: IntradayMeta): void {
  const expected = meta.secid ?? intradaySecid(meta.code, meta.kind)
  const [market, ...parts] = expected.split('.')
  const expectedCode = parts.join('.')
  if (meta.requireIdentity && (data.code === undefined || data.code === null || data.market === undefined || data.market === null)) {
    throw new Error('分时响应缺少可验证的 code/market，不能确认美股品种')
  }
  if (data.code !== undefined && data.code !== null && bareCode(String(data.code), meta.kind) !== expectedCode) {
    throw new Error(`分时品种不匹配：请求 ${expected}，响应 code=${String(data.code)}`)
  }
  if (data.market !== undefined && data.market !== null && String(data.market).trim() !== market) {
    throw new Error(`分时市场不匹配：请求 ${expected}，响应 market=${String(data.market)}`)
  }
}

/** 解析 trends2 响应；身份不符、时间非法或空 trends 均抛错。 */
export function parseIntradayPayload(payload: unknown, meta: IntradayMeta): IntradaySeries {
  const data = (payload as { data?: { trends?: string[]; preClose?: number; name?: string; code?: unknown; market?: unknown } } | null)?.data
  if (data) validateIdentity(data, meta)
  const raw = data?.trends
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('分时接口未返回数据')
  const points: IntradayPoint[] = []
  for (const line of raw) {
    if (typeof line !== 'string') throw new Error('分时点不是有效文本')
    const [time, open, close, high, low, volume, amount, avgPrice] = line.split(',')
    const at = time ? toIso(time) : null
    if (!time || !at) throw new Error(`分时点日期时间非法：${String(time ?? '')}`)
    // 分时点用「收盘价」作为当前价；开盘/最高/最低不在这里展开（分时图不画蜡烛）。
    void open; void high; void low
    points.push({
      time: time.trim(),
      at: meta.kind === 'global' ? null : at,
      price: num(close),
      avgPrice: num(avgPrice),
      volume: num(volume),
      amount: num(amount),
    })
  }
  if (!points.length) throw new Error('分时接口返回空序列')
  return {
    code: meta.code,
    ...(data?.name ? { name: String(data.name) } : {}),
    kind: meta.kind,
    days: meta.days,
    preClose: typeof data?.preClose === 'number' && Number.isFinite(data.preClose) ? data.preClose : null,
    points: [...new Map(points.map(p => [p.time, p])).values()].sort((a, b) => a.time.localeCompare(b.time)),
    source: 'eastmoney-push2his-trends2',
    at: new Date().toISOString(),
    ...(meta.secid ? { secid: meta.secid } : {}),
    timezone: meta.kind === 'global' ? 'unknown' : 'Asia/Shanghai',
    volumeUnit: 'source', amountUnit: 'source',
    warnings: meta.kind === 'global' ? ['保留源侧日期时分；该品种时区与成交量额单位未核准，ISO时间留空。'] : ['分钟量额使用源单位；不可跨品种直接相加。'],
  }
}

export interface IntradayFetchOptions {
  signal?: AbortSignal
  /** 来自真实证券解析结果；若给定则不猜测其它市场。 */
  secid?: string
  fetchJson?: (url: string, params: Record<string, string | number | undefined>, options: HttpGetOptions) => Promise<unknown>
}

export async function fetchIntraday(
  code: string,
  kind: IntradayKind,
  days: number,
  options: IntradayFetchOptions = {},
): Promise<IntradaySeries> {
  options.signal?.throwIfAborted()
  const ndays = Math.min(INTRADAY_MAX_DAYS, Math.max(1, Math.floor(days) || 1))
  const canonicalCode = bareCode(code, kind)
  let explicit = options.secid?.trim()
  if (options.secid !== undefined) {
    const m = /^(\d{1,3})\.([A-Za-z0-9._-]{1,24})$/.exec(explicit ?? '')
    const markets = kind === 'us' ? ['105', '106', '107'] : kind === 'hk' ? ['116'] : ['0', '1']
    if (!m || (kind !== 'global' && !markets.includes(m[1]!)) || bareCode(m[2]!, kind) !== canonicalCode) {
      throw new Error('分时 secid 与代码/市场不匹配')
    }
    explicit = `${m[1]}.${canonicalCode}`
  }
  const candidates = explicit ? [explicit] : kind === 'us'
    ? ['105', '106', '107'].map((market) => `${market}.${canonicalCode}`)
    : [intradaySecid(code, kind)]
  const fetchJson = options.fetchJson ?? httpGetJson
  const errors: string[] = []
  for (const secid of candidates) {
    options.signal?.throwIfAborted()
    try {
      const json = await fetchJson(EM_INTRADAY_URL, {
        secid,
        ut: 'b2884a393a59ad64002292a3e90d46a5',
        fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
        iscr: '0',
        ndays: String(ndays),
      }, { timeoutMs: INTRADAY_TIMEOUT_MS, referer: 'https://quote.eastmoney.com/', ...(options.signal ? { signal: options.signal } : {}) })
      options.signal?.throwIfAborted()
      return parseIntradayPayload(json, { code, kind, days: ndays, secid, requireIdentity: kind === 'global' || (kind === 'us' && !explicit) })
    } catch (error) {
      options.signal?.throwIfAborted()
      errors.push(`${secid}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`分时接口不可用（${errors.join('；')}）`)
}

// ---------------------------------------------------------------- 备用源：腾讯分时

export const TX_INTRADAY_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'

/** 腾讯分时 symbol：A 股加 sh/sz，港股 hk，美股 us。 */
export function txIntradaySymbol(code: string, kind: IntradayKind): string {
  if (kind === 'hk') return `hk${code.replace(/\D/g, '').padStart(5, '0').slice(-5)}`
  if (kind === 'us') return `us${code.trim().toUpperCase()}`
  const m = /^(sh|sz)/i.exec(code.trim())
  const market = m ? m[1]!.toLowerCase() : emSecMarket(code) === 1 ? 'sh' : 'sz'
  return `${market}${normalizeCode(code)}`
}

/**
 * 解析腾讯分时：每行 `HHMM 价格 当日累计量 当日累计额`。
 * 腾讯只给累计量，因此分钟量由前后差值得到，均价用 累计额/累计量（当日 VWAP）。
 * 日期/时分无法验证时拒绝；缺累计量或额会断开差分链，不能把跨缺口累计量当分钟量。
 */
export function parseTxMinutePayload(
  payload: unknown,
  meta: { code: string; kind: IntradayKind; symbol: string; days: number },
): IntradaySeries {
  const node = (payload as { data?: Record<string, { data?: { data?: string[]; date?: string }; qt?: Record<string, string[]> }> } | null)?.data?.[meta.symbol]
  const lines = node?.data?.data
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('腾讯分时未返回数据')
  // 腾讯的 date 有时是 20261123，有时是 2026-11-23；统一成带横线格式。
  const rawDay = node?.data?.date ?? ''
  const day = /^\d{8}$/.test(rawDay)
    ? `${rawDay.slice(0, 4)}-${rawDay.slice(4, 6)}-${rawDay.slice(6, 8)}`
    : /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : ''
  if (!day || !toIso(`${day} 00:00`)) throw new Error('腾讯分时缺少有效行情日期')
  let prevVol: number | null = 0
  let prevAmount: number | null = 0
  let previousAt: string | null = null
  // 腾讯 A 股累计量单位是「手」，成交额是「元」：算均价要乘 100 换成股。
  const shareFactor = meta.kind === 'a' ? 100 : 1
  const points: IntradayPoint[] = []
  for (const line of lines) {
    if (typeof line !== 'string') throw new Error('腾讯分时点不是有效文本')
    const [hhmm, price, cumVol, cumAmount] = line.trim().split(/\s+/)
    if (!hhmm || !/^\d{4}$/.test(hhmm)) throw new Error('腾讯分时时间非法')
    const time = `${day} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
    const at = toIso(time)
    if (!at) throw new Error(`腾讯分时时间非法：${hhmm}`)
    const cumV = num(cumVol)
    const cumA = num(cumAmount)
    // 跨分钟缺口的累计差不是“这一分钟”的量；只在相邻分钟（或09:30首点）计算。
    const consecutive = previousAt ? Date.parse(at) - Date.parse(previousAt) === 60_000 : hhmm === '0930'
    const vol = !consecutive || cumV === null || prevVol === null || cumV < prevVol ? null : cumV - prevVol
    const amount = !consecutive || cumA === null || prevAmount === null || cumA < prevAmount ? null : cumA - prevAmount
    previousAt = at
    prevVol = cumV !== null && cumV >= 0 ? cumV : null
    prevAmount = cumA !== null && cumA >= 0 ? cumA : null
    points.push({
      time,
      at,
      price: num(price),
      // 当日均价 = 累计成交额 / 累计成交量（A 股成交量按手换算成股）；量或额为 0 时无意义，返回 null。
      avgPrice: cumV && cumA && cumV > 0 ? Math.round((cumA / (cumV * shareFactor)) * 10000) / 10000 : null,
      volume: vol,
      amount,
    })
  }
  if (!points.length) throw new Error('腾讯分时为空序列')
  // 昨收从 qt 段取（第 5 列），取不到就 null，不猜。
  const qtRow = node?.qt?.[meta.symbol]
  if (qtRow?.[2] !== undefined && bareCode(qtRow[2], meta.kind) !== bareCode(meta.code, meta.kind)) {
    throw new Error('腾讯分时品种不匹配')
  }
  const preClose = qtRow && qtRow.length > 4 && num(qtRow[4]) !== null ? num(qtRow[4]) : null
  const name = qtRow && typeof qtRow[1] === 'string' ? qtRow[1] : undefined
  return {
    code: meta.code,
    ...(name ? { name } : {}),
    kind: meta.kind,
    days: 1,
    preClose,
    points,
    source: 'tencent-minute',
    at: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    volumeUnit: meta.kind === 'a' ? 'lots' : 'shares',
    amountUnit: meta.kind === 'a' ? 'CNY' : meta.kind === 'hk' ? 'HKD' : 'source',
  }
}

/** 备用源只支持当日分时（腾讯没有 5 日分钟接口），请求 5 日时显式拒绝。 */
export async function fetchTxIntraday(
  code: string,
  kind: IntradayKind,
  days: number,
  options: IntradayFetchOptions = {},
): Promise<IntradaySeries> {
  options.signal?.throwIfAborted()
  const ndays = Math.max(1, Math.floor(days) || 1)
  if (ndays > 1) throw new Error('备用分时源只支持当日（1 日），5 日分时需要东财可用')
  // 腾讯美股分钟只剩一条日终聚合价，画不出分时；明确拒绝而不是给一条单点曲线。
  if (kind === 'global') throw new Error('该 secid 品种没有已核准的腾讯分钟映射，不以同代码股票替代')
  if (kind === 'us') throw new Error('备用分时源没有美股分钟数据，美股分时需要东财可用')
  const symbol = txIntradaySymbol(code, kind)
  const json = await (options.fetchJson ?? httpGetJson)(TX_INTRADAY_URL, { code: symbol }, {
    timeoutMs: INTRADAY_TIMEOUT_MS,
    referer: 'https://gu.qq.com/',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return parseTxMinutePayload(json, { code, kind, symbol, days: ndays })
}
