/**
 * Personal capital — data model.
 *
 * Money is stored and computed in **integer minor units** (cents) to avoid float
 * drift; user-facing numbers are converted once, at the edge. Every event is
 * append-only: a correction is a new event that points at the one it replaces,
 * never an overwrite.
 *
 * Currencies are never summed without an explicit rate. `convertCents` returns
 * `undefined` when no rate is available — callers must then report the amounts
 * per currency instead of inventing a total.
 */

export const EVENT_TYPES = [
  'DEPOSIT', // 外部入金（增加本金，不是收益）
  'WITHDRAWAL', // 外部出金
  'BUY', // 买入证券/基金
  'SELL', // 卖出
  'DIVIDEND', // 现金分红
  'INTEREST', // 利息
  'FEE', // 费用
  'TAX', // 税费
  'FX_CONVERSION', // 换汇（币种间转移，不是收益）
  'INTERNAL_TRANSFER', // 自有账户间转账（不是资金流入）
  'SPLIT', // 拆股/份额折算
  'CORPORATE_ACTION', // 送股/配股/合并等
  'ADJUSTMENT', // 人工调整（必须写理由）
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_LABEL: Record<EventType, string> = {
  DEPOSIT: '入金',
  WITHDRAWAL: '出金',
  BUY: '买入',
  SELL: '卖出',
  DIVIDEND: '分红',
  INTEREST: '利息',
  FEE: '费用',
  TAX: '税费',
  FX_CONVERSION: '换汇',
  INTERNAL_TRANSFER: '内部转账',
  SPLIT: '拆分',
  CORPORATE_ACTION: '公司行为',
  ADJUSTMENT: '人工调整',
}

export const ACCOUNT_TYPES = ['securities', 'fund', 'cash', 'bank', 'crypto', 'other'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export interface CapitalAccount {
  accountId: string
  name: string
  accountType: AccountType
  provider: string
  /** Currency the account is denominated in. */
  baseCurrency: string
  /** Currency used when reporting this account. */
  valuationCurrency: string
  createdAt: string
  /** personal | joint | other（不收集身份信息） */
  ownershipScope: string
}

export interface CapitalEvent {
  eventId: string
  accountId: string
  /** Asset code (600519 / 110022 / BTC …). Empty for pure cash events. */
  assetId: string
  eventType: EventType
  occurredAt: string
  settledAt: string
  quantity: number
  price: number
  /** Positive = money in for cash-increasing types, always in `currency`. */
  grossAmount: number
  netAmount: number
  fee: number
  tax: number
  currency: string
  /** For FX_CONVERSION / cross-currency accounting: rate + target currency. */
  fxRate: number
  fxCurrency: string
  source: string
  sourceTransactionId: string
  importBatchId: string
  createdAt: string
  /** Set when this event corrects an earlier one (append-only correction). */
  correctionOf: string
  note: string
}

export interface CapitalEventInput {
  accountId: string
  eventType: EventType
  occurredAt: string
  assetId?: string
  settledAt?: string
  quantity?: number
  price?: number
  grossAmount?: number
  netAmount?: number
  fee?: number
  tax?: number
  currency?: string
  fxRate?: number
  fxCurrency?: string
  source?: string
  sourceTransactionId?: string
  note?: string
  correctionOf?: string
  /** Set by the import path so a batch can be traced back. */
  importBatchId?: string
}

export interface ImportBatch {
  batchId: string
  createdAt: string
  source: string
  fileName: string
  rows: number
  imported: number
  duplicates: number
  invalid: number
  issues: string[]
}

/** Market price used for valuation; `stale` is surfaced, never hidden. */
export interface PricePoint {
  assetId: string
  price: number
  currency: string
  asOf: string
  stale?: boolean
}

export type FxTable = Map<string, { rate: number; asOf: string; source: string }>

export function fxKey(from: string, to: string): string {
  return `${from.toUpperCase()}->${to.toUpperCase()}`
}

/** Register a rate; also registers the inverse so lookups stay symmetric. */
export function setFx(table: FxTable, from: string, to: string, rate: number, asOf: string, source = 'manual'): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`无效汇率：${rate}`)
  table.set(fxKey(from, to), { rate, asOf, source })
  table.set(fxKey(to, from), { rate: 1 / rate, asOf, source })
}

/** Convert minor units; `undefined` means "no rate, do not invent a total". */
export function convertCents(cents: number, from: string, to: string, table: FxTable): number | undefined {
  if (from.toUpperCase() === to.toUpperCase()) return cents
  const direct = table.get(fxKey(from, to))
  if (direct) return Math.round(cents * direct.rate)
  return undefined
}

/** Decimal → minor units (cents). */
export function toCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n)) throw new Error(`无效金额：${String(value)}`)
  return Math.round(n * 100)
}

/** Minor units → decimal number rounded to 2 decimals. */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

/** Sum a list of amounts, refusing to mix currencies. */
export function sumByCurrency(items: Array<{ currency: string; cents: number }>): {
  byCurrency: Record<string, number>
  total: number | undefined
  currency?: string
} {
  const byCurrency: Record<string, number> = {}
  for (const item of items) {
    const code = item.currency.toUpperCase()
    byCurrency[code] = (byCurrency[code] ?? 0) + item.cents
  }
  const codes = Object.keys(byCurrency)
  if (codes.length === 0) return { byCurrency, total: 0 }
  if (codes.length === 1) return { byCurrency, total: byCurrency[codes[0]!]!, currency: codes[0] }
  return { byCurrency, total: undefined }
}

/** Events that move money in/out of the personal pool (not internal transfers). */
export const EXTERNAL_FLOW_TYPES: EventType[] = ['DEPOSIT', 'WITHDRAWAL']

/** Events that never count as investment income. */
export const NON_INCOME_TYPES: EventType[] = ['DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', 'FX_CONVERSION', 'ADJUSTMENT']

export function isIsoDate(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim())
}

/** Validate one event before it enters the ledger; throws with a precise reason. */
export function validateEventInput(input: CapitalEventInput): {
  normalized: Required<Pick<CapitalEventInput, 'accountId' | 'eventType' | 'occurredAt'>> & CapitalEventInput
  issues: string[]
} {
  const issues: string[] = []
  if (!input.accountId) throw new Error('缺少 accountId')
  if (!(EVENT_TYPES as readonly string[]).includes(input.eventType)) throw new Error(`无效事件类型：${input.eventType}`)
  const occurredAt = String(input.occurredAt ?? '').trim().slice(0, 10)
  if (!isIsoDate(occurredAt)) throw new Error(`occurredAt 需为 YYYY-MM-DD：${input.occurredAt}`)

  const type = input.eventType
  const qty = Number(input.quantity ?? 0)
  const price = Number(input.price ?? 0)

  if (type === 'BUY' || type === 'SELL' || type === 'DIVIDEND' || type === 'INTEREST') {
    if (type === 'BUY' || type === 'SELL') {
      if (!input.assetId) throw new Error(`${type} 需要 assetId`)
      if (!(qty > 0)) throw new Error(`${type} 需要正数 quantity`)
      if (!(price >= 0)) throw new Error(`${type} 需要非负 price`)
    }
  }
  if (type === 'SPLIT') {
    if (!input.assetId) throw new Error('SPLIT 需要 assetId')
    if (!(qty > 0)) throw new Error('SPLIT 需要正数 quantity（比例）')
  }
  if (type === 'FX_CONVERSION') {
    if (!(Number(input.fxRate) > 0)) throw new Error('FX_CONVERSION 需要正数 fxRate')
    if (!input.fxCurrency) throw new Error('FX_CONVERSION 需要 fxCurrency（换入币种）')
  }
  if (type === 'INTERNAL_TRANSFER' && !input.note) {
    issues.push('内部转账建议写明对向账户（note）')
  }
  if (type === 'ADJUSTMENT' && !input.note) throw new Error('ADJUSTMENT 必须写理由')
  if (type === 'CORPORATE_ACTION' && !input.note) issues.push('公司行为建议写明类型（送股/配股/合并）')

  const currency = String(input.currency ?? '').toUpperCase()
  if ((type === 'DEPOSIT' || type === 'WITHDRAWAL' || type === 'FEE' || type === 'TAX' || type === 'INTEREST' || type === 'DIVIDEND' || type === 'FX_CONVERSION')
    && !currency) {
    throw new Error(`${type} 需要 currency`)
  }
  if ((type === 'DEPOSIT' || type === 'WITHDRAWAL') && !(Number(input.grossAmount) > 0)) {
    throw new Error(`${type} 需要正数 grossAmount`)
  }
  return { normalized: { ...input, accountId: input.accountId, eventType: type, occurredAt }, issues }
}
