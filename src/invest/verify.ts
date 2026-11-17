/**
 * 历史投资建议验证（Phase 5）。
 *
 * 只回答一个问题：**当初的方向性判断，在给定价格序列下是否被支持**。
 * 它刻意不做四件事：
 * - 不把「观点被验证」说成「交易赚钱」（没成交就没有盈亏）；
 * - 不用涨跌判定 WATCH/HOLD 的对错（这两类要用条件是否触发来判）；
 * - 不在样本 < N 时给胜率；
 * - 不改写原建议（结论只写进 review 记录）。
 */
import type { InvestmentAdvice, Recommendation } from './schema.js'

export interface SimplePrice {
  date: string
  close: number
}

export type VerifyStatus = 'unverifiable' | 'inconclusive' | 'supported' | 'contradicted'

export interface VerifyResult {
  adviceId: string
  recommendation: Recommendation
  status: VerifyStatus
  priceAtStart?: number
  priceAtEnd?: number
  changePct?: number
  benchmarkChangePct?: number
  /** 相对基准的超额（百分点）。 */
  excessPct?: number
  days?: number
  notes: string[]
  caveat: string
}

/** 取 `date` 当日或之前最近一根收盘价。 */
function priceOnOrBefore(prices: SimplePrice[], date: string): { date: string; close: number } | undefined {
  const sorted = [...prices].filter((p) => Number.isFinite(p.close) && p.close > 0 && p.date).sort((a, b) => a.date.localeCompare(b.date))
  let found: { date: string; close: number } | undefined
  for (const point of sorted) {
    if (point.date <= date) found = { date: point.date, close: point.close }
    else break
  }
  return found
}

const DIRECTIONAL: Recommendation[] = ['CONSIDER_BUY', 'CONSIDER_REDUCE', 'CONSIDER_EXIT']
/** 小于这个幅度视为「没有方向信号」。 */
const NOISE_PCT = 1

export function verifyAdvice(input: {
  advice: InvestmentAdvice
  prices: SimplePrice[]
  benchmark?: SimplePrice[]
  asOf?: string
}): VerifyResult {
  const { advice, prices, benchmark } = input
  const asOf = String(input.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  const notes: string[] = []
  const caveat = '这是「观点是否被价格走势支持」的检验，不是交易结果：未成交就没有盈亏，也不是策略胜率。'

  if (advice.recommendation === 'INSUFFICIENT_DATA') {
    return { adviceId: advice.adviceId, recommendation: advice.recommendation, status: 'unverifiable', notes: ['当时结论是「证据不足」，没有方向性判断可验证'], caveat }
  }

  const startDate = advice.createdAt.slice(0, 10)
  const start = priceOnOrBefore(prices, startDate)
  const end = priceOnOrBefore(prices, asOf)
  if (!start || !end || start.date === end.date) {
    return {
      adviceId: advice.adviceId,
      recommendation: advice.recommendation,
      status: 'unverifiable',
      notes: [...notes, `价格序列不足以覆盖 ${startDate} → ${asOf}（需要至少两个不同日期的收盘价）`],
      caveat,
    }
  }

  const changePct = ((end.close - start.close) / start.close) * 100
  const days = Math.max(0, Math.round((Date.parse(end.date) - Date.parse(start.date)) / 86_400_000))
  const bStart = benchmark ? priceOnOrBefore(benchmark, startDate) : undefined
  const bEnd = benchmark ? priceOnOrBefore(benchmark, asOf) : undefined
  const benchmarkChangePct = bStart && bEnd
    ? ((bEnd.close - bStart.close) / bStart.close) * 100
    : undefined

  const base = {
    adviceId: advice.adviceId,
    recommendation: advice.recommendation,
    priceAtStart: start.close,
    priceAtEnd: end.close,
    changePct: Math.round(changePct * 100) / 100,
    ...(benchmarkChangePct === undefined ? {} : { benchmarkChangePct: Math.round(benchmarkChangePct * 100) / 100 }),
    ...(benchmarkChangePct === undefined ? {} : { excessPct: Math.round((changePct - benchmarkChangePct) * 100) / 100 }),
    days,
    caveat,
  }

  if (!DIRECTIONAL.includes(advice.recommendation)) {
    return {
      ...base,
      status: 'inconclusive',
      notes: [
        '观望/持有类建议不能用涨跌判定对错',
        `同期标的价格变动 ${base.changePct}%；请改用「条件是否触发 / 失效条件是否成立」来复盘`,
      ],
    }
  }

  const expectsUp = advice.recommendation === 'CONSIDER_BUY'
  if (Math.abs(changePct) < NOISE_PCT) {
    return { ...base, status: 'inconclusive', notes: [`同期变动 ${base.changePct}%，小于 ${NOISE_PCT}% 阈值，视为没有方向信号`] }
  }
  const movedUp = changePct > 0
  const supported = expectsUp === movedUp
  return {
    ...base,
    status: supported ? 'supported' : 'contradicted',
    notes: [
      `${advice.recommendation === 'CONSIDER_BUY' ? '看多' : '看空'}，实际${movedUp ? '上涨' : '下跌'} ${Math.abs(base.changePct)}%`,
      ...(benchmarkChangePct === undefined
        ? ['未提供基准：不计算超额收益，不能说明「跑赢/跑输」']
        : [`基准同期 ${base.benchmarkChangePct}%，超额 ${base.excessPct} 个百分点`]),
      ...(advice.dataFreshness.status !== 'fresh' ? ['当时的数据时效不是 fresh，判断本身的可信度受限'] : []),
    ],
  }
}

/** 样本层面的诚实结论：不编胜率。 */
export function summarizeVerification(results: VerifyResult[]): {
  total: number
  verifiable: number
  supported: number
  contradicted: number
  inconclusive: number
  unverifiable: number
  note: string
} {
  const count = (status: VerifyStatus): number => results.filter((r) => r.status === status).length
  const verifiable = results.filter((r) => r.status === 'supported' || r.status === 'contradicted').length
  return {
    total: results.length,
    verifiable,
    supported: count('supported'),
    contradicted: count('contradicted'),
    inconclusive: count('inconclusive'),
    unverifiable: count('unverifiable'),
    note: verifiable < 20
      ? `可验证样本 ${verifiable} 条（门槛 20）：不给胜率——小样本的「命中率」只是噪声`
      : '可验证样本已过门槛，但仍需注意选择性记录与市场环境变化：胜率不等于策略有效',
  }
}
