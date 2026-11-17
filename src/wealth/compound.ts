/**
 * Deterministic compound / wealth math.
 *
 * Everything here is a closed-form or explicitly-summed calculation over integer
 * cents. No model output is ever fed back into these functions, and no function
 * guesses a missing input:
 *
 * - annual rates are converted with `(1+r)^(1/12)-1`, never `r/12`;
 * - inflation uses `(1+nominal)/(1+inflation)-1`, never `nominal - inflation`;
 * - a zero rate falls back to the limit form `PMT × n`, not to a division by 0;
 * - contributions are either at the beginning or the end of each period, stated
 *   explicitly by the caller.
 */

export const CONTRIBUTION_FREQUENCIES = ['monthly', 'quarterly', 'annual'] as const
export type ContributionFrequency = (typeof CONTRIBUTION_FREQUENCIES)[number]

export const CONTRIBUTION_TIMING = ['begin', 'end'] as const
export type ContributionTiming = (typeof CONTRIBUTION_TIMING)[number]

const PERIODS_PER_YEAR: Record<ContributionFrequency, number> = { monthly: 12, quarterly: 4, annual: 1 }

const round2 = (value: number): number => Math.round(value * 100) / 100

/** Annual effective rate → rate per compounding period. */
export function periodRate(annualEffective: number, frequency: ContributionFrequency): number {
  const periods = PERIODS_PER_YEAR[frequency]
  if (annualEffective <= -1) throw new Error('年化收益率必须大于 -100%')
  return Math.pow(1 + annualEffective, 1 / periods) - 1
}

/** Real return from nominal return and inflation: (1+n)/(1+i)-1. */
export function realReturn(nominal: number, inflation: number): number {
  if (inflation <= -1) throw new Error('通胀率必须大于 -100%')
  return (1 + nominal) / (1 + inflation) - 1
}

/** Net rate after fees: (1+r)(1-fee)-1. */
export function netOfFees(annualReturn: number, annualFee: number): number {
  if (annualFee < 0 || annualFee >= 1) throw new Error('年费率需在 [0,1) 区间')
  return (1 + annualReturn) * (1 - annualFee) - 1
}

export interface CompoundInput {
  /** 一次性本金（分）。 */
  principalCents: number
  /** 每期追加（分）。 */
  contributionCents?: number
  frequency?: ContributionFrequency
  /** 期初投入还是期末投入。 */
  timing?: ContributionTiming
  /** 年有效收益率（0.08 = 8%），可为负。 */
  annualRate: number
  /** 年化费率（1% = 0.01），从收益率中扣除。 */
  annualFee?: number
  /** 年化通胀率，用于计算实际购买力。 */
  inflation?: number
  years: number
  /** 追加金额每年增长比例（如 0.03 = 每年多投 3%）。 */
  contributionGrowth?: number
}

export interface CompoundYear {
  year: number
  /** 年初本金+已投入部分。 */
  startCents: number
  /** 本年外部投入（分）。 */
  contributedCents: number
  /** 本年投资收益（分，可为负）。 */
  growthCents: number
  /** 年末名义价值。 */
  endCents: number
  /** 按通胀折算的实际购买力（分）。 */
  realCents: number
  /** 累计外部投入（分）。 */
  cumulativeContributedCents: number
}

export interface CompoundResult {
  years: number
  annualRate: number
  netAnnualRate: number
  periodRate: number
  frequency: ContributionFrequency
  timing: ContributionTiming
  /** 期末名义价值（分）。 */
  finalCents: number
  finalRealCents: number
  /** 累计外部投入（分）。 */
  contributedCents: number
  /** 期末收益 = 期末价值 − 累计投入（分）。 */
  growthCents: number
  /** 实际年化收益率（费后）。 */
  realRate: number
  rows: CompoundYear[]
  assumptions: string[]
}

/**
 * Year-by-year projection with per-period contributions.
 *
 * The loop compounds each period, so the result is the same closed form as
 * `FV = PV(1+r)^n + PMT·((1+r)^n−1)/r` for a constant payment, but it also
 * supports rising contributions and reports each year.
 */
export function compound(input: CompoundInput): CompoundResult {
  const years = Number(input.years)
  if (!Number.isFinite(years) || years <= 0 || years > 100) throw new Error('期限需在 (0,100] 年内')
  const annualRate = Number(input.annualRate)
  if (!Number.isFinite(annualRate) || annualRate < -0.999999) throw new Error('年化收益率无效')
  const annualFee = Number(input.annualFee ?? 0)
  const netRate = netOfFees(annualRate, annualFee)
  const frequency = input.frequency ?? 'monthly'
  const timing = input.timing ?? 'end'
  const perYear = PERIODS_PER_YEAR[frequency]
  const rate = periodRate(netRate, frequency)
  const inflation = Number(input.inflation ?? 0)
  const contributionGrowth = Number(input.contributionGrowth ?? 0)

  const principal = Math.round(Number(input.principalCents ?? 0))
  let value = principal
  let contributed = 0
  let payment = Math.round(Number(input.contributionCents ?? 0))
  const rows: CompoundYear[] = []
  const totalPeriods = Math.round(years * perYear)

  for (let year = 1; year <= years; year++) {
    const startCents = value
    let yearContribution = 0
    let yearGrowth = 0
    for (let p = 0; p < perYear; p++) {
      const periodIndex = (year - 1) * perYear + p
      if (periodIndex >= totalPeriods) break
      const inflow = payment
      if (inflow !== 0) {
        if (timing === 'begin') {
          value += inflow
          yearContribution += inflow
          const growth = Math.round(value * rate)
          value += growth
          yearGrowth += growth
        } else {
          const growth = Math.round(value * rate)
          value += growth
          yearGrowth += growth
          value += inflow
          yearContribution += inflow
        }
      } else {
        const growth = Math.round(value * rate)
        value += growth
        yearGrowth += growth
      }
    }
    contributed += yearContribution
    if (contributionGrowth !== 0) payment = Math.round(payment * (1 + contributionGrowth))
    const realCents = inflation !== 0 ? Math.round(value / Math.pow(1 + inflation, year)) : value
    rows.push({
      year,
      startCents,
      contributedCents: yearContribution,
      growthCents: yearGrowth,
      endCents: value,
      realCents,
      cumulativeContributedCents: contributed,
    })
  }

  const realRate = inflation !== 0 ? realReturn(netRate, inflation) : netRate
  return {
    years,
    annualRate,
    netAnnualRate: netRate,
    periodRate: rate,
    frequency,
    timing,
    finalCents: value,
    finalRealCents: rows[rows.length - 1]?.realCents ?? value,
    contributedCents: contributed,
    growthCents: value - principal - contributed,
    realRate,
    rows,
    assumptions: [
      `年有效收益率 ${(netRate * 100).toFixed(2)}%（费后；原始 ${(annualRate * 100).toFixed(2)}%，年费 ${(annualFee * 100).toFixed(2)}%）`,
      `${frequency} 定投，${timing === 'begin' ? '期初' : '期末'}投入，期间收益率 ${(rate * 100).toFixed(4)}%`,
      inflation !== 0 ? `实际收益率 ${(realRate * 100).toFixed(2)}%（通胀 ${(inflation * 100).toFixed(2)}%）` : '未考虑通胀（实际=名义）',
      '这是确定性情景，不是收益预测；市场不会每年给同一个收益率',
    ],
  }
}

export interface CashFlowPoint {
  date: string
  /** Positive = 投入，negative = 取出（分）。 */
  cents: number
}

/** Compound irregular dated flows to a valuation date (act/365). */
export function futureValueOfFlows(
  flows: CashFlowPoint[],
  annualRate: number,
  valuationDate: string,
  opts: { annualFee?: number } = {},
): { valueCents: number; investedCents: number; growthCents: number; skipped: number } {
  const netRate = netOfFees(annualRate, Number(opts.annualFee ?? 0))
  const end = Date.parse(valuationDate)
  if (!Number.isFinite(end)) throw new Error(`无效估值日期：${valuationDate}`)
  let value = 0
  let invested = 0
  let skipped = 0
  for (const flow of flows) {
    const at = Date.parse(flow.date)
    if (!Number.isFinite(at)) { skipped++; continue }
    const days = (end - at) / 86_400_000
    if (days < 0) { skipped++; continue }
    const grown = flow.cents * Math.pow(1 + netRate, days / 365)
    value += grown
    if (flow.cents > 0) invested += flow.cents
  }
  return {
    valueCents: Math.round(value),
    investedCents: invested,
    growthCents: Math.round(value) - invested,
    skipped,
  }
}

export interface GoalSolution {
  /** 需要每期追加多少（分）；已达标时为 0。 */
  requiredContributionCents: number
  /** 需要多少年（按当前投入）；按给定年限无法达标时为 undefined。 */
  requiredYears?: number
  /** 需要的年化收益率；不可达时为 undefined。 */
  requiredAnnualRate?: number
  monthlyCents: number
  years: number
  annualRate: number
  achievedCents: number
  gapCents: number
  note: string
}

/** Solve the missing variable for a goal. Bisection only — no guessing. */
export function solveGoal(input: {
  targetCents: number
  principalCents: number
  monthlyContributionCents?: number
  annualRate: number
  years: number
  annualFee?: number
  inflation?: number
  mode?: 'contribution' | 'years' | 'rate' | 'all'
}): GoalSolution {
  const mode = input.mode ?? 'all'
  const target = Math.round(input.targetCents)
  if (!(target > 0)) throw new Error('目标金额必须为正')
  const base = {
    principalCents: input.principalCents,
    frequency: 'monthly' as ContributionFrequency,
    timing: 'end' as ContributionTiming,
    annualRate: input.annualRate,
    annualFee: input.annualFee ?? 0,
    inflation: input.inflation ?? 0,
  }
  const at = (contributionCents: number, years: number, annualRate: number): number =>
    compound({ ...base, annualRate, contributionCents, years }).finalCents

  let requiredContributionCents = 0
  if (mode === 'contribution' || mode === 'all') {
    const achievedAtZero = at(0, input.years, input.annualRate)
    if (achievedAtZero < target) {
      let lo = 0
      let hi = Math.max(1, target)
      let guard = 0
      while (at(hi, input.years, input.annualRate) < target && guard < 200) { hi *= 2; guard++ }
      for (let i = 0; i < 200; i++) {
        const mid = Math.floor((lo + hi) / 2)
        if (at(mid, input.years, input.annualRate) >= target) hi = mid
        else lo = mid
        if (hi - lo <= 1) break
      }
      requiredContributionCents = hi
    }
  }

  const monthly = Math.round(input.monthlyContributionCents ?? 0)
  let requiredYears: number | undefined
  if (mode === 'years' || mode === 'all') {
    if (at(monthly, 100, input.annualRate) < target) {
      requiredYears = undefined
    } else {
      let lo = 0
      let hi = 100
      for (let i = 0; i < 120; i++) {
        const mid = (lo + hi) / 2
        if (at(monthly, mid, input.annualRate) >= target) hi = mid
        else lo = mid
      }
      requiredYears = Math.round(hi * 100) / 100
    }
  }

  let requiredAnnualRate: number | undefined
  if (mode === 'rate' || mode === 'all') {
    const f = (rate: number): number => at(monthly, input.years, rate) - target
    let lo = -0.9
    let hi = 5
    if (f(lo) > 0) requiredAnnualRate = lo
    else if (f(hi) < 0) requiredAnnualRate = undefined
    else {
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2
        if (f(mid) >= 0) hi = mid
        else lo = mid
      }
      requiredAnnualRate = Math.round(hi * 1e6) / 1e6
    }
  }

  const achieved = at(monthly, input.years, input.annualRate)
  return {
    requiredContributionCents,
    ...(requiredYears === undefined ? {} : { requiredYears }),
    ...(requiredAnnualRate === undefined ? {} : { requiredAnnualRate }),
    monthlyCents: monthly,
    years: input.years,
    annualRate: input.annualRate,
    achievedCents: achieved,
    gapCents: Math.max(0, target - achieved),
    note: mode === 'all'
      ? '反解只用二分法求数值解；条件不可达时返回 undefined，不给「大概」值'
      : `已按 ${mode} 模式反解`,
  }
}

/** Formatting helper shared by tools and the panel (元, 2 decimals). */
export function yuan(cents: number): number {
  return round2(cents / 100)
}

/** 元 → 分；非法输入按 0 处理（工具层负责提示）。 */
export function toCentsSafe(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
