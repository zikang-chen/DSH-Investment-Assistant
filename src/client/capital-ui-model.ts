/** Presentation and request serialization only. Financial calculations stay on the existing server APIs. */
export interface CapitalPayload {
  ok: boolean
  error?: string
  accounts?: Array<{ accountId: string; name: string; accountType: string; baseCurrency: string }>
  events?: number
  cash?: Array<{ accountId: string; currency: string; amount: number }>
  cashByCurrency?: Record<string, number>
  positions?: Array<{ assetId: string; quantity: number; currency: string; cost: number; averageCost: number }>
  netInvested?: Record<string, number>
  realized?: Record<string, number>
  fees?: Record<string, number>
  income?: Record<string, number>
  warnings?: string[]
  note?: string
}

/** No cross-currency total, currency conversion, aggregation, or absent-to-zero fallback. */
export function capitalCurrencyRows(data: CapitalPayload) {
  const records = [data.cashByCurrency, data.netInvested, data.realized, data.fees, data.income]
  const currencies = [...new Set(records.flatMap(record => Object.keys(record ?? {})))].sort()
  return currencies.map(currency => ({
    currency,
    cash: data.cashByCurrency?.[currency],
    netInvested: data.netInvested?.[currency],
    realized: data.realized?.[currency],
    fees: data.fees?.[currency],
    income: data.income?.[currency],
  }))
}

export interface PortfolioSnapshot {
  at?: string
  groups: Array<{ currency: string; cost: number; value: number | null; profit: number | null; missing: string[] }>
  basis?: string
}
export type PrincipalSource = 'portfolio' | 'manual'
export interface WealthContext { currency: string; principalSource: PrincipalSource; portfolioAt?: string; portfolioBasis?: string }
export type PortfolioPrincipal = { ok: true; value: number } | { ok: false; reason: string; missing: string[] }
/** Select a complete existing valuation. Never sum currencies, price an asset or fall back to cost. */
export function portfolioPrincipal(portfolio: PortfolioSnapshot | undefined, currency: string): PortfolioPrincipal {
  const group = portfolio?.groups.find(item => item.currency === currency)
  if (!group) return { ok: false, reason: `尚无 ${currency} 持仓估值快照。`, missing: [] }
  if (group.missing.length || group.value === null || !Number.isFinite(group.value)) {
    return { ok: false, reason: `${currency} 持仓估值不完整，补齐行情后才能用作本金。`, missing: [...group.missing] }
  }
  return { ok: true, value: group.value }
}

export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  securities: '证券', fund: '基金', cash: '现金', bank: '银行', crypto: '数字资产', other: '其他',
}

/** The original user-initiated request. Never append any account or position data. */
export const CAPITAL_NETWORTH_REQUEST = '请用 capital_networth_snapshot 计算我的净资产；如果你没有我当前的持仓价格，先问我或调用行情工具取最新价，并注明数据日期与汇率来源。'

export const WEALTH_FIELDS = [
  { key: 'principal', label: '一次性本金', unit: '元' },
  { key: 'contribution', label: '每月后续投入', unit: '元 / 月' },
  { key: 'years', label: '情景期限', unit: '年' },
  { key: 'annualRate', label: '假设年有效收益率', unit: '%' },
  { key: 'annualFee', label: '年费率', unit: '%' },
  { key: 'inflation', label: '年通胀率', unit: '%' },
] as const
export type WealthNumericKey = typeof WEALTH_FIELDS[number]['key']
export type WealthForm = Record<WealthNumericKey, string> & { name: string }
export const INITIAL_WEALTH_FORM: WealthForm = {
  principal: '10000', contribution: '1000', annualRate: '6', years: '10', annualFee: '0.5', inflation: '3', name: '',
}
export interface WealthRequest {
  principal: number
  contribution: number
  annualRate: number
  years: number
  annualFee: number
  inflation: number
  frequency: 'monthly'
  timing: 'end'
}
export type WealthFieldErrors = Partial<Record<WealthNumericKey | 'name', string>>
export type WealthValidation = { ok: true; body: WealthRequest } | { ok: false; errors: WealthFieldErrors }

/** Reject only absent/non-finite numbers. Domain restrictions belong to the real server schema. */
export function parseWealthNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const number = Number(raw)
  return Number.isFinite(number) ? number : undefined
}

/**
 * UI rates are always percentage points (0.5 means 0.5%). The existing route accepts
 * fractions at abs <= 1 and percentages at abs > 1. Encode that dual-format transport
 * without changing the server, rejecting valid ranges, or interpreting 0.5 as 50%.
 */
export function rateForWealthApi(percent: number): number {
  return Math.abs(percent) > 100 ? percent : percent / 100
}

export function wealthRequest(form: WealthForm): WealthValidation {
  const values: Partial<Record<WealthNumericKey, number>> = {}
  const errors: WealthFieldErrors = {}
  for (const field of WEALTH_FIELDS) {
    const value = parseWealthNumber(form[field.key])
    if (value === undefined) errors[field.key] = `请填写可解析的${field.label}数值（${field.unit}）。`
    else values[field.key] = value
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, body: {
    principal: values.principal!,
    contribution: values.contribution!,
    years: values.years!,
    annualRate: rateForWealthApi(values.annualRate!),
    annualFee: rateForWealthApi(values.annualFee!),
    inflation: rateForWealthApi(values.inflation!),
    frequency: 'monthly', timing: 'end',
  } }
}

/** Name changes do not alter a calculation; numeric/frequency/timing changes do. */
export function wealthInputKey(body: WealthRequest, context?: WealthContext): string { return JSON.stringify({ body, context }) }

export interface WealthResult {
  ok: boolean
  error?: string
  finalYuan?: number
  finalRealYuan?: number
  /** Server meaning: subsequent contributions only, excluding the initial principal. */
  contributedYuan?: number
  growthYuan?: number
  netAnnualRate?: number
  realRate?: number
  assumptions?: string[]
  rows?: Array<{ year: number; contributedYuan: number; growthYuan: number; endYuan: number; realYuan: number }>
  plan?: { planId: string; name: string; engineVersion?: string }
}
export interface SavedWealthPlan {
  planId: string
  name: string
  finalYuan?: number
  contributedYuan?: number
  growthYuan?: number
  finalRealYuan?: number
  netAnnualRate?: number
  years?: number
  targetReached?: boolean
}
export interface WealthPlansPayload { ok: boolean; error?: string; count?: number; plans?: SavedWealthPlan[] }
