/** UI-only presentation contracts. No valuation, return or recommendation calculation. */
import type { InvestmentAdvice, Recommendation } from '../invest/schema.js'

export type DeliveryOutcome = 'sent' | 'copied' | 'failed'
export type Deliver = (text: string) => Promise<DeliveryOutcome>
export type ReadApi = <T>(path: string) => Promise<T>
export type UsePanelBus = (fn: (event: { kind: string }) => void) => void

export interface AdviceRow {
  adviceId: string
  userPrompt: string
  assets: string[]
  market: string
  horizon: string
  recommendation: Recommendation
  label?: string
  dataFreshness: string
  supports: number
  contradicts: number
  status: string
  reviews: number
  createdAt: string
  nextReviewAt: string
}
export interface AdviceList {
  ok: boolean
  error?: string
  stats?: { total: number; open: number; reviewed: number; hitRateNote?: string }
  /** Kept at the route's top level, NOT inside stats. */
  dueForReview?: number
  advices?: AdviceRow[]
}
export interface AdviceDetail { ok: boolean; error?: string; advice?: InvestmentAdvice; label?: string }

export const RECOMMENDATION_VIEW: Record<Recommendation, { label: string; tone: 'info' | 'neutral' | 'warning' }> = {
  CONSIDER_BUY: { label: '考虑买入 · 有条件', tone: 'info' },
  HOLD: { label: '维持持有', tone: 'neutral' },
  CONSIDER_REDUCE: { label: '考虑减仓 · 有条件', tone: 'warning' },
  CONSIDER_EXIT: { label: '考虑退出 · 有条件', tone: 'warning' },
  WATCH: { label: '观望', tone: 'neutral' },
  INSUFFICIENT_DATA: { label: '证据不足', tone: 'warning' },
}
export const HORIZON_LABEL: Record<string, string> = { intraday: '日内', days: '数日', weeks: '数周', months: '数月', years: '长期' }
export const MARKET_LABEL: Record<string, string> = { cn: 'A 股', hk: '港股', us: '美股', fund: '基金', bond: '债券', gold: '黄金', crypto: '数字资产', macro: '宏观', other: '其他' }
export const EVIDENCE_LABEL: Record<string, string> = { policy: '政策', macro: '宏观', fundamental: '基本面', valuation: '估值', market: '行情', portfolio: '组合', calculation: '计算', news: '资讯', research: '资料', 'evidence-request': '证据请求' }
export const FRESHNESS_LABEL: Record<string, string> = { fresh: '时效：新鲜', stale: '时效：已过期', unknown: '时效：待核实' }

export function deliveryFeedback(outcome: DeliveryOutcome): string {
  return outcome === 'sent'
    ? '已请求提交到绑定会话，请在目标对话确认收到。保存研究后这里会自动更新。'
    : outcome === 'copied'
      ? '未自动发送，问题已复制。请在目标会话粘贴发送。'
      : '未能发送。请在面板上方绑定一个已打开的会话后重试。'
}

export function researchPrompt(question: string, mode: 'quick' | 'deep', portfolioAuthorized: boolean): string {
  return [
    question.trim(),
    '',
    `研究模式：${mode === 'deep' ? '深度研究（按需覆盖政策、宏观、基本面、估值和市场）' : '快速判断（先查直接影响结论的数据）'}。`,
    '按 investment-advisor 流程：核对行情与统计期间，寻找支持与反对证据，给出有条件的判断、失效条件和下次复核日期。',
    portfolioAuthorized
      ? '我授权为这次问题读取本机组合概要用于分析；不要读取账号凭证，不要执行交易。若缺少风险或流动性约束，先明确缺口，不得猜测仓位。'
      : '本次未授权读取或向模型发送个人账户、持仓、家庭财务明细；按非个性化市场研究继续。',
    '关键资料缺失时创建 Evidence Request；不能编造最新价格或精确点位。请用 investment_advice_generate 保存结构化结论。',
  ].join('\n')
}

export function isSafeSourceUrl(value?: string): value is string {
  if (!value) return false
  try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

/** Date-only metadata must not be shifted through UTC or treated as a current quote. */
export function displayDay(value?: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '未注明'
  return value.slice(0, 10)
}
