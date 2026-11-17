/**
 * Investment advice — schema and guardrails.
 *
 * This module does not write the analysis; it decides whether an analysis is
 * *admissible*. The rules below are the mechanical part of "给出有依据的投资建议":
 *
 * - a directional view must ship at least one supporting and one contradicting
 *   piece of evidence, each with a source and a date;
 * - every directional view must state what would invalidate it;
 * - a price zone is only allowed when the calculation behind it is referenced;
 * - `INSUFFICIENT_DATA` is a first-class answer, and it must not carry an action.
 *
 * The engine rejects an advice that fails these checks instead of quietly
 * downgrading it, so nothing incomplete can be persisted as a recommendation.
 */

export const RECOMMENDATIONS = [
  'CONSIDER_BUY',
  'HOLD',
  'CONSIDER_REDUCE',
  'CONSIDER_EXIT',
  'WATCH',
  'INSUFFICIENT_DATA',
] as const
export type Recommendation = (typeof RECOMMENDATIONS)[number]

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  CONSIDER_BUY: '满足条件时可考虑买入',
  HOLD: '维持当前持仓',
  CONSIDER_REDUCE: '满足条件时可考虑减仓',
  CONSIDER_EXIT: '满足条件时可考虑退出',
  WATCH: '暂时观望',
  INSUFFICIENT_DATA: '证据不足',
}

export const MARKETS = ['cn', 'hk', 'us', 'fund', 'bond', 'gold', 'crypto', 'macro', 'other'] as const
export type Market = (typeof MARKETS)[number]

export const HORIZONS = ['intraday', 'days', 'weeks', 'months', 'years'] as const
export type Horizon = (typeof HORIZONS)[number]

export const EVIDENCE_KINDS = [
  'policy', 'macro', 'fundamental', 'valuation', 'market', 'portfolio', 'calculation', 'news', 'research', 'evidence-request',
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface AdviceEvidence {
  kind: EvidenceKind
  /** One verifiable sentence — not "市场普遍看好". */
  claim: string
  /** Where it comes from (policy id, data series, filing, tool name). */
  source: string
  /** YYYY-MM-DD of the underlying data (not the day you wrote it). */
  asOf: string
  /** Optional pointer: policy id, research id, url. */
  ref?: string
}

export interface DataFreshness {
  status: 'fresh' | 'stale' | 'unknown'
  asOf: string
  note: string
}

export interface ProposedAction {
  summary: string
  conditions: string[]
  /** Only allowed together with `calculationRefs`. */
  priceZone?: { low: number; high: number; basis: string }
  sizingNote?: string
  simulated: boolean
}

export interface AdviceReview {
  reviewedAt: string
  /** Did the market/data confirm the original judgement? */
  outcome: 'supported' | 'contradicted' | 'inconclusive'
  dataAsOf: string
  note: string
  /** Whether the entry conditions actually triggered. */
  conditionTriggered?: boolean
  invalidationTriggered?: boolean
  benchmarkNote?: string
}

export interface InvestmentAdvice {
  adviceId: string
  userPrompt: string
  createdAt: string
  assets: string[]
  market: Market
  horizon: Horizon
  investmentGoal: string
  recommendation: Recommendation
  recommendationConditions: string[]
  rationale: string[]
  supporting: AdviceEvidence[]
  contradicting: AdviceEvidence[]
  invalidationConditions: string[]
  marketSnapshot: Array<{ asOf: string; note: string }>
  dataFreshness: DataFreshness
  valuationSummary: string
  portfolioContextUsed: boolean
  riskConstraints: string[]
  scenarioAssumptions: string[]
  proposedAction: ProposedAction | null
  nextReviewAt: string
  unresolvedQuestions: string[]
  calculationRefs: string[]
  modelVersion: string
  promptVersion: string
  status: 'open' | 'reviewed'
  reviews: AdviceReview[]
  /** Stable identity of the question for de-dup/provenance. */
  promptHash: string
}

export interface AdviceInput {
  userPrompt: string
  assets: string[]
  market: Market
  horizon: Horizon
  investmentGoal?: string
  recommendation: Recommendation
  recommendationConditions?: string[]
  rationale?: string[]
  supporting?: AdviceEvidence[]
  contradicting?: AdviceEvidence[]
  invalidationConditions?: string[]
  marketSnapshot?: Array<{ asOf: string; note: string }>
  dataFreshness: DataFreshness
  valuationSummary?: string
  portfolioContextUsed?: boolean
  riskConstraints?: string[]
  scenarioAssumptions?: string[]
  proposedAction?: ProposedAction | null
  nextReviewAt?: string
  unresolvedQuestions?: string[]
  calculationRefs?: string[]
  modelVersion?: string
  promptVersion?: string
}

export interface ValidationOutcome {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const ASSET_RE = /^(?:\d{5,6}|[A-Z]{1,6}(?:\.[A-Z]{1,3})?|BTC|ETH|GLD|IAU|SPY|QQQ|2800|2828)$/i

export function isDay(value: unknown): boolean {
  return DAY_RE.test(String(value ?? '').trim())
}

export function normalizeEvidence(raw: unknown): AdviceEvidence[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const value = (item ?? {}) as Record<string, unknown>
    return {
      kind: String(value.kind ?? 'research') as EvidenceKind,
      claim: String(value.claim ?? '').trim(),
      source: String(value.source ?? '').trim(),
      asOf: String(value.asOf ?? '').trim(),
      ...(value.ref ? { ref: String(value.ref) } : {}),
    }
  })
}

/** The guardrail. Returns every reason the advice is inadmissible. */
export function validateAdvice(input: AdviceInput): ValidationOutcome {
  const errors: string[] = []
  const warnings: string[] = []

  if (!String(input.userPrompt ?? '').trim()) errors.push('缺少 userPrompt（原始问题）')
  if (!Array.isArray(input.assets) || input.assets.length === 0) errors.push('缺少 assets（至少一个标的或行业）')
  else {
    for (const asset of input.assets) {
      const value = String(asset ?? '').trim()
      if (!value) errors.push('assets 里有空值')
      else if (!ASSET_RE.test(value) && !/[\u4e00-\u9fff]/.test(value)) errors.push(`无法识别的标的：${value}`)
    }
  }
  if (!(MARKETS as readonly string[]).includes(input.market)) errors.push(`market 必须是 ${MARKETS.join('/')}`)
  if (!(HORIZONS as readonly string[]).includes(input.horizon)) errors.push(`horizon 必须是 ${HORIZONS.join('/')}`)
  if (!(RECOMMENDATIONS as readonly string[]).includes(input.recommendation)) {
    errors.push(`recommendation 必须是 ${RECOMMENDATIONS.join('/')}`)
  }

  const freshness = input.dataFreshness
  if (!freshness || !['fresh', 'stale', 'unknown'].includes(freshness.status)) {
    errors.push('必须给出 dataFreshness.status（fresh/stale/unknown），不能省略数据时效')
  } else {
    if (!isDay(freshness.asOf)) errors.push('dataFreshness.asOf 需要 YYYY-MM-DD')
    if (freshness.status !== 'fresh') warnings.push(`数据时效为 ${freshness.status}：结论必须标注这一限制`)
  }

  const supporting = normalizeEvidence(input.supporting)
  const contradicting = normalizeEvidence(input.contradicting)
  const directional = input.recommendation !== 'INSUFFICIENT_DATA'

  for (const [label, list] of [['supporting', supporting], ['contradicting', contradicting]] as const) {
    for (const item of list) {
      if (!item.claim) errors.push(`${label} 里有一条缺少 claim`)
      if (!item.source) errors.push(`${label}「${item.claim.slice(0, 20)}」缺少 source`)
      if (!isDay(item.asOf)) errors.push(`${label}「${item.claim.slice(0, 20)}」缺少有效 asOf（YYYY-MM-DD）`)
    }
  }

  if (directional) {
    if (supporting.length < 1) errors.push('给出方向性判断时至少要有一条支持证据（kind/claim/source/asOf）')
    if (contradicting.length < 1) errors.push('必须至少列出一条反对证据：只列支持面等于没做反证')
    if (!Array.isArray(input.invalidationConditions) || input.invalidationConditions.filter((c) => String(c ?? '').trim()).length < 1) {
      errors.push('必须给出至少一条「判断失效条件」')
    }
    if (!Array.isArray(input.riskConstraints) || input.riskConstraints.length === 0) {
      warnings.push('建议补充风险约束（最大可承受回撤/仓位上限/流动性要求）')
    }
  } else {
    if (supporting.length > 0 && contradicting.length === 0) {
      warnings.push('证据不足时仍列了支持证据：请说明为什么仍判定不足')
    }
    if (!Array.isArray(input.unresolvedQuestions) || input.unresolvedQuestions.filter((q) => String(q ?? '').trim()).length < 1) {
      errors.push('INSUFFICIENT_DATA 必须列出还缺什么（unresolvedQuestions）')
    }
    if (input.proposedAction && String(input.proposedAction.summary ?? '').trim()) {
      errors.push('证据不足时不得给出行动方案（proposedAction 必须为空）')
    }
  }

  const action = input.proposedAction
  if (action) {
    if (!String(action.summary ?? '').trim()) errors.push('proposedAction.summary 不能为空')
    if (action.priceZone) {
      const { low, high } = action.priceZone
      if (!(low > 0) || !(high > 0) || high < low) errors.push('priceZone 的价格区间无效')
      if (!Array.isArray(input.calculationRefs) || input.calculationRefs.length === 0) {
        errors.push('给出价格区间必须引用计算方法（calculationRefs），不能凭空给点位')
      }
    }
    if (action.simulated !== true) warnings.push('行动方案应标明 simulated=true：本插件不执行真实交易')
  }

  if (!isDay(input.nextReviewAt)) warnings.push('建议给出下次复核日期（nextReviewAt）')
  if (!String(input.valuationSummary ?? '').trim() && ['CONSIDER_BUY', 'CONSIDER_REDUCE', 'CONSIDER_EXIT'].includes(input.recommendation)) {
    warnings.push('买卖类建议应包含估值摘要（valuationSummary）')
  }
  if (input.portfolioContextUsed && (!Array.isArray(input.riskConstraints) || input.riskConstraints.length === 0)) {
    warnings.push('使用了个人组合但没写风险约束')
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Deterministic id so the same prompt + assets on the same day is traceable. */
export function advicePromptHash(prompt: string, assets: string[]): string {
  const base = `${prompt.trim().toLowerCase()}|${assets.map((a) => a.trim().toUpperCase()).sort().join(',')}`
  let h = 0x811c9dc5
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `adv-${(h >>> 0).toString(16).padStart(8, '0')}`
}
