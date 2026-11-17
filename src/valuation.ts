import { routeCode } from './data/route-code.js'
import type { AssetType } from './types.js'

export type Currency = 'CNY' | 'HKD' | 'USD'

/**
 * 报价币种无法确认时 `currency` 保持缺失（undefined），不能默认当成 CNY。
 * 沪B（900 开头 6 位，美元报价）与深B（200 开头 6 位，港币报价）当前返回 undefined：
 * 不把 B 股并进 A 股的 CNY 合计，也暂不推断其真实报价币种。
 * 仍未核实/未覆盖：外汇基金（QDII 场外份额可能以外币计价）与跨境 ETF（部分按港币/美元
 * 计价或折算）——这些仍沿用「基金 = CNY」的既有行为，未按实际计价币种校验。
 * 另外 200xxx 也可能是个别基金代码（如长城基金部分产品），所以只有非基金才按深B处理，
 * 调用方应尽量传入 `type`。
 */
export interface ValuationRow {
  code: string
  quantity: number
  avgCost: number
  price?: number
  currency?: Currency | null
  /** 可选，仅用于区分基金与深B（200xxx）等重叠代码形态；缺省按股票处理。 */
  type?: AssetType
}

export interface ValuationGroup {
  currency: Currency
  cost: number
  value: number | null
  profit: number | null
  profitPercent: number | null
  /**
   * 缺行情代码；组合里存在缺币种持仓（沪B/深B 等）时也会带上这些代码。
   * 这样既有的「分组是否完整」判断（只读 missing）不会把某个币种的分组当成完整组合估值。
   */
  missing: string[]
}

export interface ValuationResult {
  groups: ValuationGroup[]
  consolidated: ValuationGroup | null
  /** 报价币种无法确定的代码（沪B/深B 等）；不并入任何币种合计，也不参与 consolidated。 */
  missingCurrency: string[]
  /** 缺失说明：缺币种（B股等）与跨币种缺汇率都会写入；无完整口径时不提供合并值。 */
  missing: string[]
  basis: string
}

const CURRENCIES = ['CNY', 'HKD', 'USD'] as const

/** 沪B 900xxx / 深B 200xxx（6 位）。200xxx 与部分基金代码重叠，调用方须先按 type 排除基金。 */
const isBShareCode = (code: string): boolean => /^(?:900|200)\d{3}$/.test(code)

function knownCurrency(row: ValuationRow): Currency | null {
  const currency = row.currency
  if (currency !== 'CNY' && currency !== 'HKD' && currency !== 'USD') return null
  // 防御式校验：B 股不是 CNY 计价。即使调用方仍按旧逻辑传入 CNY，也不并表。
  if (currency === 'CNY' && row.type !== 'fund' && isBShareCode(routeCode(row.code, row.type ?? 'stock').code)) return null
  return currency
}

/** Cost and price both use the security's quote currency. No invented FX rates. */
export function valuation(rows: ValuationRow[]): ValuationResult {
  const classified = rows.map(row => ({ row, currency: knownCurrency(row) }))
  const missingCurrency = classified.filter(item => item.currency === null).map(item => item.row.code)
  const groups: ValuationGroup[] = CURRENCIES.flatMap(currency => {
    const items = classified.filter(item => item.currency === currency).map(item => item.row)
    if (!items.length) return []
    const missingPrices = items.filter(r => typeof r.price !== 'number' || !Number.isFinite(r.price) || r.price < 0).map(r => r.code)
    const cost = items.reduce((s, r) => s + r.quantity * r.avgCost, 0)
    const value = missingPrices.length ? null : items.reduce((s, r) => s + r.quantity * r.price!, 0)
    const profit = value === null ? null : value - cost
    // 缺币种行不属于本组，但它的存在让本组不再是「完整组合」：写入 missing 供既有消费者拒绝当完整估值。
    const missing = [...missingPrices, ...missingCurrency]
    return [{ currency, cost, value, profit, profitPercent: cost > 0 && profit !== null ? profit / cost * 100 : null, missing }]
  })
  const missing: string[] = []
  if (missingCurrency.length) missing.push(`缺币种/缺汇率，未并入任何币种合计：${missingCurrency.join('、')}（沪B/深B 等报价币种未确认，需单独核实）`)
  if (groups.length > 1) missing.push('跨币种汇率及历史成本汇率缺失，不提供合并收益或集中度')
  return {
    groups,
    // 只要存在缺币种持仓，任何单一币种分组都不是「完整组合估值」，不提供 consolidated。
    consolidated: groups.length === 1 && missingCurrency.length === 0 ? groups[0] : null,
    missingCurrency,
    missing,
    basis: '原币未实现价格盈亏=(现价−平均成本)×数量；不含已实现盈亏、费用、税、分红和汇兑损益。成本币种须与报价币种一致；无行情显示缺失，不用成本冒充现价；缺币种（沪B/深B 等）不并入任何币种合计。',
  }
}

/**
 * 沪B 900xxx（美元报价）与深B 200xxx（港币报价）不默认 CNY：返回 undefined，由 valuation()
 * 计入缺币种集合。A股/基金仍为 CNY、港股 HKD、美股 USD 的既有行为不变。
 * B 股以外未覆盖：外汇基金与跨境 ETF 的实际计价币种未核实，仍按「基金 = CNY」处理。
 * 200xxx 也可能是基金代码，故 `type === 'fund'` 时不做深B识别。
 */
export function quoteCurrency(code: string, type = 'stock'): Currency | undefined {
  const routed = routeCode(code, type === 'fund' ? 'fund' : 'stock')
  if (type !== 'fund' && isBShareCode(routed.code)) return undefined
  return ({ 'A股': 'CNY', '基金': 'CNY', '港股': 'HKD', '美股': 'USD' } as const)[routed.market]
}
