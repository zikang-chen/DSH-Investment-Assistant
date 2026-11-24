/**
 * 数值元信息（横切约定）。
 *
 * 一个数字要能被引用，必须同时回答：单位是什么、什么时候的、算的是哪个窗口、
 * 谁给的、新不新、跟别的来源冲不冲突。缺任何一项，结论就只能写「大约」。
 *
 * 这里只提供纯函数与类型；具体数据仍由各自 provider 取，不做二次加工。
 */

/** 新鲜度：fresh=当期；t1=滞后一期（如 T+1 净值）；t2=更快滞后/未核准。 */
export type Freshness = 'fresh' | 't1' | 't2' | 'stale' | 'unknown'

export interface MetricMeta {
  unit: string
  /** 数据时点（YYYY-MM-DD，可含时间）。缺失即 null，绝不用抓取时间顶替。 */
  asOf: string | null
  /** 统计/计算窗口，如 5y / 20d / 当日。 */
  window?: string
  source: string
  stale: Freshness
  /** 与其他来源/内部反算不一致时为 true；此时不得单独引用。 */
  conflict: boolean
  /** 冲突或口径说明；没有就省略。 */
  note?: string
}

export interface Metric<T extends number = number> extends MetricMeta {
  value: T | null
}

export function metric<T extends number>(value: T | null, meta: MetricMeta): Metric<T> {
  return { value, ...meta }
}

const DAY = 86_400_000

/** 按预期更新节奏推算新鲜度；不判断市场是否开市。 */
export function staleness(asOf: string | null, cadence: 'intraday' | 'daily' | 't1' | 'monthly' | 'quarterly', now = Date.now()): Freshness {
  if (!asOf) return 'unknown'
  const time = Date.parse(asOf.length === 10 ? `${asOf}T00:00:00Z` : asOf)
  if (!Number.isFinite(time)) return 'unknown'
  const ageDays = (now - time) / DAY
  if (ageDays < 0 && ageDays > -2) return 'fresh'
  if (ageDays < 0) return 'unknown'
  switch (cadence) {
    case 'intraday': return ageDays <= 1 ? 'fresh' : ageDays <= 3 ? 't1' : 'stale'
    case 'daily': return ageDays <= 3 ? 'fresh' : ageDays <= 7 ? 't1' : 'stale'
    case 't1': return ageDays <= 3 ? 't1' : ageDays <= 7 ? 't2' : 'stale'
    case 'monthly': return ageDays <= 45 ? 'fresh' : ageDays <= 75 ? 't1' : 'stale'
    case 'quarterly': return ageDays <= 120 ? 'fresh' : ageDays <= 200 ? 't1' : 'stale'
  }
}

/**
 * 两个独立得到的同一个量：差异超过容差就算冲突。
 * 冲突时不给出「谁对」——只标记，让人去看口径。
 */
export function conflictOf(a: number | null, b: number | null, tolerance: number): { conflict: boolean; diff?: number } {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return { conflict: false }
  const diff = Math.abs(a - b)
  return { conflict: diff > tolerance, diff: Math.round(diff * 10000) / 10000 }
}

export type Market = 'a' | 'hk' | 'us'
export type SessionPhase = 'pre' | 'am' | 'lunch' | 'pm' | 'closed'

export interface SessionState {
  market: Market
  phase: SessionPhase
  /** 是否完整交易日（半日市/提前收市时 false）。 */
  fullSession: boolean
  note: string
}

/**
 * 交易时段标记。用固定时段 + 周末判断，**不接交易所节假日日历**：
 * 因此 holiday 只能由「工作日但没有当日数据」推断，不能在这里断言。
 */
export function sessionOf(market: Market, now: Date = new Date()): SessionState {
  // 把 UTC 平移到市场当地墙钟后，统一用 getUTC* 取值；不要再叠加本机时区差。
  const offsets: Record<Market, number> = { a: 8, hk: 8, us: -5 }
  const local = new Date(now.getTime() + offsets[market] * 3600_000)
  const day = local.getUTCDay()
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  const weekday = day >= 1 && day <= 5
  if (!weekday) return { market, phase: 'closed', fullSession: false, note: '周末休市（未接节假日日历）' }
  if (market === 'a') {
    if (minutes < 9 * 60 + 30) return { market, phase: 'pre', fullSession: false, note: '开盘前' }
    if (minutes <= 11 * 60 + 30) return { market, phase: 'am', fullSession: true, note: '上午连续竞价' }
    if (minutes < 13 * 60) return { market, phase: 'lunch', fullSession: false, note: '午间休市' }
    if (minutes <= 15 * 60) return { market, phase: 'pm', fullSession: true, note: '下午连续竞价' }
    return { market, phase: 'closed', fullSession: false, note: '已收盘' }
  }
  if (market === 'hk') {
    if (minutes < 9 * 60 + 30) return { market, phase: 'pre', fullSession: false, note: '开盘前' }
    if (minutes <= 12 * 60) return { market, phase: 'am', fullSession: true, note: '上午市' }
    if (minutes < 13 * 60) return { market, phase: 'lunch', fullSession: false, note: '午间休市' }
    if (minutes <= 16 * 60) return { market, phase: 'pm', fullSession: true, note: '下午市' }
    return { market, phase: 'closed', fullSession: false, note: '已收盘' }
  }
  if (minutes < 9 * 60 + 30) return { market, phase: 'pre', fullSession: false, note: '盘前' }
  if (minutes <= 16 * 60) return { market, phase: 'am', fullSession: false, note: '常规交易时段（美股连续）' }
  return { market, phase: 'closed', fullSession: false, note: '已收盘' }
}

/**
 * 半日市判定：只有已知的「提前收市」日期才标记。
 * 这里只放可维护的少量日期，避免把普通交易日误判成半日市。
 */
export const EARLY_CLOSE_DATES: Readonly<Record<Market, readonly string[]>> = {
  a: [],
  hk: [],
  us: ['2026-11-27', '2026-12-24'],
}

export function isEarlyClose(market: Market, date: string): boolean {
  return EARLY_CLOSE_DATES[market].includes(date)
}
