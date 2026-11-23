/**
 * 分时数据（东财 push2his trends2）：当日或近 5 日分钟级价格。
 *
 * 口径与边界：
 * - 只做行情展示：points 是「时间 + 成交价 + 均价 + 分钟量额」，不做聚合计算。
 * - 时间原样保留源侧 `YYYY-MM-DD HH:mm`（交易所当地时间），另给 ISO（+08:00）便于排序；
 *   两者不一致时以原文为准，不猜时区。
 * - 缺字段为 null，不补 0；`price=0` 这类真实 0 保留。
 * - 该接口不除权：分时只用于当日/近 5 日，不做复权推断。
 */

import { httpGetJson, emSecMarket, normalizeCode } from './http.js'

export const EM_INTRADAY_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
export const INTRADAY_TIMEOUT_MS = 12_000
export const INTRADAY_MAX_DAYS = 5

export type IntradayKind = 'a' | 'hk' | 'us'

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
  at: string
}

function num(value: string | undefined): number | null {
  // 注意 Number('') === 0：空串必须当缺失，不能变成真实的 0。
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toIso(time: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?$/.exec(time.trim())
  if (!m) return null
  const iso = `${m[1]}T${m[2]}:${m[3] ?? '00'}+08:00`
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** 东财 secid：A 股 1./0.，港股 116.，美股 105./106./107.（按调用方给的 kind 决定前缀）。 */
export function intradaySecid(code: string, kind: IntradayKind): string {
  if (kind === 'hk') return `116.${code.replace(/\D/g, '').padStart(5, '0').slice(-5)}`
  if (kind === 'us') return `105.${code.trim().toUpperCase()}`
  return `${emSecMarket(code)}.${normalizeCode(code)}`
}

/** 解析 trends2 响应；空 trends 抛错（交给 provider 层转成失败）。 */
export function parseIntradayPayload(payload: unknown, meta: { code: string; kind: IntradayKind; days: number }): IntradaySeries {
  const data = (payload as { data?: { trends?: string[]; preClose?: number; name?: string } } | null)?.data
  const raw = data?.trends
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('分时接口未返回数据')
  const points: IntradayPoint[] = []
  for (const line of raw) {
    const [time, open, close, high, low, volume, amount, avgPrice] = line.split(',')
    if (!time) continue
    // 分时点用「收盘价」作为当前价；开盘/最高/最低不在这里展开（分时图不画蜡烛）。
    void open; void high; void low
    points.push({
      time: time.trim(),
      at: toIso(time),
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
    points,
    source: 'eastmoney-push2his-trends2',
    at: new Date().toISOString(),
  }
}

export async function fetchIntraday(
  code: string,
  kind: IntradayKind,
  days: number,
  options: { signal?: AbortSignal } = {},
): Promise<IntradaySeries> {
  const ndays = Math.min(INTRADAY_MAX_DAYS, Math.max(1, Math.floor(days) || 1))
  const json = await httpGetJson<unknown>(
    EM_INTRADAY_URL,
    {
      secid: intradaySecid(code, kind),
      ut: 'b2884a393a59ad64002292a3e90d46a5',
      fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
      iscr: '0',
      ndays: String(ndays),
    },
    { timeoutMs: INTRADAY_TIMEOUT_MS, referer: 'https://quote.eastmoney.com/', ...(options.signal ? { signal: options.signal } : {}) },
  )
  return parseIntradayPayload(json, { code, kind, days: ndays })
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
 * 解析不到日期的点 asOf 为 null；unit 未标注，图表只按相对高度画。
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
    : /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : new Date().toISOString().slice(0, 10)
  let prevVol = 0
  let prevAmount = 0
  // 腾讯 A 股累计量单位是「手」，成交额是「元」：算均价要乘 100 换成股。
  const shareFactor = meta.kind === 'a' ? 100 : 1
  const points: IntradayPoint[] = []
  for (const line of lines) {
    const [hhmm, price, cumVol, cumAmount] = line.trim().split(/\s+/)
    if (!hhmm || !/^\d{4}$/.test(hhmm)) continue
    const time = `${day} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
    const cumV = num(cumVol)
    const cumA = num(cumAmount)
    const vol = cumV === null ? null : Math.max(0, cumV - prevVol)
    const amount = cumA === null ? null : Math.max(0, cumA - prevAmount)
    if (cumV !== null) prevVol = cumV
    if (cumA !== null) prevAmount = cumA
    points.push({
      time,
      at: toIso(time),
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
  }
}

/** 备用源只支持当日分时（腾讯没有 5 日分钟接口），请求 5 日时显式拒绝。 */
export async function fetchTxIntraday(
  code: string,
  kind: IntradayKind,
  days: number,
  options: { signal?: AbortSignal } = {},
): Promise<IntradaySeries> {
  const ndays = Math.max(1, Math.floor(days) || 1)
  if (ndays > 1) throw new Error('备用分时源只支持当日（1 日），5 日分时需要东财可用')
  // 腾讯美股分钟只剩一条日终聚合价，画不出分时；明确拒绝而不是给一条单点曲线。
  if (kind === 'us') throw new Error('备用分时源没有美股分钟数据，美股分时需要东财可用')
  const symbol = txIntradaySymbol(code, kind)
  const json = await httpGetJson<unknown>(TX_INTRADAY_URL, { code: symbol }, {
    timeoutMs: INTRADAY_TIMEOUT_MS,
    referer: 'https://gu.qq.com/',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return parseTxMinutePayload(json, { code, kind, symbol, days: ndays })
}
