import type { PortfolioPolicyInput, PortfolioPolicyResult } from '../strategy/portfolio-policy.js'
import type { PortfolioVerificationInput, PortfolioVerificationResult } from '../strategy/portfolio-verification.js'
import type { PortfolioVersionEntry } from '../strategy/portfolio-versions.js'

/** UI adapters only. The policy and verification engines remain the authority. */
export interface PortfolioRow {
  id: string; name?: string; assetClass: string; currency: string
  current: string; target: string; priceAsOf: string; minWeight?: number; maxWeight?: number
}
export interface PortfolioDraft {
  rows: PortfolioRow[]; cash: string; targetCash: string; baseCurrency: string; asOf: string
  maxAsset: string; maxClass: string; minCash: string; turnover: string; drift: string
  lastReview: string; cadence: string; signals: NonNullable<PortfolioPolicyInput['signals']>
}
export const assetClassLabels: Record<string, string> = { equity: '股票', bond: '债券', gold: '黄金', fund: '基金', other: '其他' }
export const versionStateLabels: Record<PortfolioVersionEntry['state'], string> = { draft: '草案', review: '待审阅', approved: '已批准纸面跟踪', rejected: '已驳回', retired: '已退役' }
const percent = (v: string) => v.trim() === '' ? NaN : Number(v) / 100
const displayWeight = (v: number) => String(v * 100)
export const blankPortfolioRow = (): PortfolioRow => ({ id: '', assetClass: 'equity', currency: 'CNY', current: '', target: '', priceAsOf: '' })
export function createPortfolioDraft(asOf: string): PortfolioDraft {
  return { rows: [blankPortfolioRow(), { ...blankPortfolioRow(), assetClass: 'bond' }], cash: '', targetCash: '', baseCurrency: 'CNY', asOf,
    maxAsset: '40', maxClass: '70', minCash: '5', turnover: '20', drift: '5', lastReview: '', cadence: '30', signals: [] }
}
export function portfolioPolicyFromDraft(d: PortfolioDraft): PortfolioPolicyInput {
  return { asOf: d.asOf, baseCurrency: d.baseCurrency.trim(), positions: d.rows.map(r => ({ id: r.id.trim(), ...(r.name ? { name: r.name } : {}), assetClass: r.assetClass, currency: r.currency.trim(), currentWeight: percent(r.current), targetWeight: percent(r.target),
    ...(r.priceAsOf ? { priceAsOf: r.priceAsOf } : {}), ...(r.minWeight !== undefined ? { minWeight: r.minWeight } : {}), ...(r.maxWeight !== undefined ? { maxWeight: r.maxWeight } : {}) })),
    cashWeight: percent(d.cash), targetCashWeight: percent(d.targetCash),
    constraints: { maxAssetWeight: percent(d.maxAsset), maxAssetClassWeight: percent(d.maxClass), minCashWeight: percent(d.minCash), maxTurnover: percent(d.turnover), driftThreshold: percent(d.drift) },
    review: { ...(d.lastReview ? { lastReviewedAt: d.lastReview } : {}), cadenceDays: d.cadence.trim() ? Number(d.cadence) : NaN }, signals: d.signals.map(s => ({ ...s })) }
}
export function portfolioDraftFromPolicy(p: PortfolioPolicyInput): PortfolioDraft {
  return { rows: p.positions.map(r => ({ id: r.id, ...(r.name ? { name: r.name } : {}), assetClass: r.assetClass, currency: r.currency, current: displayWeight(r.currentWeight), target: displayWeight(r.targetWeight), priceAsOf: r.priceAsOf ?? '',
    ...(r.minWeight !== undefined ? { minWeight: r.minWeight } : {}), ...(r.maxWeight !== undefined ? { maxWeight: r.maxWeight } : {}) })),
    asOf: p.asOf, baseCurrency: p.baseCurrency, cash: displayWeight(p.cashWeight), targetCash: displayWeight(p.targetCashWeight), maxAsset: displayWeight(p.constraints.maxAssetWeight), maxClass: displayWeight(p.constraints.maxAssetClassWeight), minCash: displayWeight(p.constraints.minCashWeight), turnover: displayWeight(p.constraints.maxTurnover), drift: displayWeight(p.constraints.driftThreshold), lastReview: p.review.lastReviewedAt ?? '', cadence: String(p.review.cadenceDays), signals: (p.signals ?? []).map(s => ({ ...s })) }
}
export function portfolioTotals(d: PortfolioDraft): { current?: number; target?: number } {
  const sum = (values: string[]) => values.some(v => !v.trim() || !Number.isFinite(Number(v))) ? undefined : values.reduce((s, v) => s + Number(v), 0)
  return { current: sum([d.cash, ...d.rows.map(r => r.current)]), target: sum([d.targetCash, ...d.rows.map(r => r.target)]) }
}
/** Explicit user action; never normalizes a draft or chooses a target allocation. */
export function copyCurrentToTarget(d: PortfolioDraft): PortfolioDraft {
  return { ...d, rows: d.rows.map(r => ({ ...r, target: r.current })), targetCash: d.cash }
}
export function portfolioInputHints(d: PortfolioDraft): string[] {
  const hints: string[] = [], totals = portfolioTotals(d)
  d.rows.forEach((r, i) => {
    if (!r.id.trim()) hints.push(`第${i + 1}项：填写标的代码或名称`)
    if (!r.current.trim() || !r.target.trim()) hints.push(`第${i + 1}项：填写当前与目标权重（未持有可填0）`)
  })
  if (totals.current === undefined) hints.push('补齐当前权重与当前现金')
  else if (Math.abs(totals.current - 100) > 1e-7) hints.push(`当前合计${totals.current.toFixed(2)}%，请调整至100%`)
  if (totals.target === undefined) hints.push('补齐目标权重与目标现金')
  else if (Math.abs(totals.target - 100) > 1e-7) hints.push(`目标合计${totals.target.toFixed(2)}%，请调整至100%`)
  return hints
}
export function policyResultHeading(r: PortfolioPolicyResult): string {
  if (!r.ok) return '输入待补齐'
  if (r.status === 'BLOCKED') return '目标超出风险预算'
  if (!r.proposed) return '权重已检查，估值日期待补齐'
  return r.status === 'REVIEW_REQUIRED' ? '有变化需要复核' : '当前与目标在规则内'
}
/** Only a complete, explicitly cash-confirmed snapshot can populate current weights. */
export function verifiedCurrentDraft(d: PortfolioDraft, input: PortfolioVerificationInput, r: PortfolioVerificationResult, cashConfirmed: boolean): PortfolioDraft {
  if (!cashConfirmed || input.cash.length === 0) throw Error('请先核对现金；无现金也需明确填0。')
  if (!r.valid || !r.completeValuation || !r.canCreatePolicy || !r.weights) throw Error('价格或汇率尚有缺口，请补齐后重新核验。')
  if (input.cash.some(c => c.currency !== input.baseCurrency && c.amount > 0)) throw Error('当前策略仅有基准币种现金栏；外币现金仍在核验结果中展示，暂不能带入策略。')
  const active = input.positions.filter(p => p.quantity > 0)
  if (active.length < 2 || active.length > 20) throw Error('策略需要2–20项持仓。')
  const rows = active.map(p => {
    const w = r.weights!.find(w => w.kind === 'position' && w.id === p.id)
    if (!w) throw Error(`未找到${p.id}的完整核验权重`)
    return { id: p.id, assetClass: p.assetClass, currency: p.currency, current: displayWeight(w.weight), target: '', priceAsOf: p.priceAsOf ?? '' }
  })
  const cash = r.weights.filter(w => w.kind === 'cash').reduce((s, w) => s + w.weight, 0)
  return { ...d, rows, cash: displayWeight(cash), targetCash: '', baseCurrency: input.baseCurrency, asOf: input.asOf }
}
export function requirePortfolioResponse<T extends { ok?: boolean; error?: unknown }>(response: T): T {
  if (response.ok === false) throw Error(typeof response.error === 'string' ? response.error : '请求未完成，请检查输入后重试。')
  return response
}
export function paperApprovalIssue(e: PortfolioVersionEntry, today: string): string | undefined {
  if (e.state !== 'review') return '请先提交审阅'
  if (!e.evaluation.ok || e.evaluation.status === 'BLOCKED') return '目标超出约束，请修改后另存版本'
  if (!e.evaluation.proposed) return '估值日期待补齐，请重新核验并另存版本'
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.policy.asOf}T00:00:00Z`)) / 86400000
  if (!Number.isFinite(age) || age < 0 || age > 7) return '复核日期已过期或异常，请更新数据并另存版本'
  return undefined
}
export function portfolioCheckLabel(c: NonNullable<PortfolioPolicyResult['constraintChecks']>[number]): string {
  return c.kind === 'single' ? `${c.key}单项权重` : c.kind === 'assetClass' ? `${assetClassLabels[c.key] ?? c.key}类别权重` : c.kind === 'cash' ? '现金底线' : c.kind === 'turnover' ? '单次换手预算' : `${c.key}专属范围`
}
