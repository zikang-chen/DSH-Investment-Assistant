/**
 * 资本暴露与情景模拟（Phase 4）。
 *
 * 输入是账本持仓 + 显式价格 + 显式汇率：
 * - 没有价格的持仓标为 unknown，**不按 0 计入权重**；
 * - 没有汇率的币种单独列示，不加总；
 * - 集中度用 HHI 与 topN 权重，行业暴露需要公司信息（可选，缺失即 unknown）。
 *
 * 情景模拟只做「假设权重变化后集中度如何变化」的纸面推演，不产生交易。
 */
import { convertCents, fromCents, type FxTable, type PricePoint } from './types.js'
import type { LedgerState } from './performance.js'

export interface ExposureRow {
  assetId: string
  currency: string
  quantity: number
  /** 市值（分，原币）。 */
  valueCents: number
  /** 占总市值比例（0-1）；无法折算时为空。 */
  weight?: number
  price?: number
  priceAsOf?: string
  stale?: boolean
}

export interface ExposureResult {
  baseCurrency: string
  asOf: string
  totalCents: number | undefined
  cashCents: number | undefined
  cashRatio: number | undefined
  rows: ExposureRow[]
  unpriced: string[]
  missingFx: string[]
  /** 赫芬达尔指数（0-1）：越接近 1 越集中。 */
  hhi: number | undefined
  /** 有效持仓数 ≈ 1/HHI。 */
  effectiveHoldings: number | undefined
  top1: number | undefined
  top3: number | undefined
  byCurrency: Record<string, number>
  warnings: string[]
  note: string
}

/** 计算当前暴露。只使用传入的价格/汇率，不发起网络请求。 */
export function computeExposure(
  state: LedgerState,
  prices: PricePoint[],
  baseCurrency: string,
  fx: FxTable,
  asOf: string,
): ExposureResult {
  const base = baseCurrency.toUpperCase()
  const priceMap = new Map(prices.map((p) => [p.assetId, p]))
  const rows: ExposureRow[] = []
  const unpriced: string[] = []
  const missingFx = new Set<string>(state.warnings.length > 0 ? [] : [])

  for (const position of state.positions) {
    const price = priceMap.get(position.assetId)
    if (!price) {
      unpriced.push(position.assetId)
      rows.push({ assetId: position.assetId, currency: position.currency, quantity: position.quantity, valueCents: 0 })
      continue
    }
    const marketCurrency = (price.currency || position.currency).toUpperCase()
    const valueCents = Math.round(position.quantity * price.price * 100)
    rows.push({
      assetId: position.assetId,
      currency: marketCurrency,
      quantity: position.quantity,
      valueCents,
      price: price.price,
      priceAsOf: price.asOf,
      ...(price.stale ? { stale: true } : {}),
    })
  }

  // 换算到展示币种；缺汇率的币种单独列示，不加总。
  let positionsTotal = 0
  let cashTotal = 0
  const byCurrency: Record<string, number> = {}
  for (const row of rows) {
    if (row.valueCents === 0) continue
    byCurrency[row.currency] = (byCurrency[row.currency] ?? 0) + row.valueCents
    const converted = convertCents(row.valueCents, row.currency, base, fx)
    if (converted === undefined) { missingFx.add(row.currency); continue }
    row.weight = 0
    positionsTotal += converted
  }
  for (const [currency, cents] of Object.entries(state.cashByCurrency)) {
    const converted = convertCents(cents, currency, base, fx)
    if (converted === undefined) { missingFx.add(currency); continue }
    cashTotal += converted
    byCurrency[currency] = (byCurrency[currency] ?? 0) + cents
  }

  const total = missingFx.size > 0 ? undefined : positionsTotal + cashTotal
  const priced = rows.filter((r) => r.valueCents > 0 && r.weight !== undefined)
  for (const row of priced) {
    const converted = convertCents(row.valueCents, row.currency, base, fx)
    if (converted === undefined) continue
    row.weight = total && total > 0 ? converted / total : undefined
  }
  const weights = priced.map((r) => r.weight ?? 0).filter((w) => w > 0).sort((a, b) => b - a)
  const hhi = weights.length > 0 ? weights.reduce((sum, w) => sum + w * w, 0) : undefined

  const warnings: string[] = []
  if (unpriced.length > 0) warnings.push(`未定价资产 ${unpriced.length} 个（${unpriced.slice(0, 4).join('、')}${unpriced.length > 4 ? '…' : ''}）：未计入权重与集中度`)
  if (missingFx.size > 0) warnings.push(`缺汇率 ${[...missingFx].join('/')} → ${base}：不给单一总额`)
  if (rows.some((r) => r.stale)) warnings.push('存在过期价格：权重可能失真')

  return {
    baseCurrency: base,
    asOf,
    totalCents: total,
    cashCents: missingFx.size > 0 ? undefined : cashTotal,
    cashRatio: total && total > 0 ? cashTotal / total : undefined,
    rows: rows.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
    unpriced,
    missingFx: [...missingFx],
    hhi,
    effectiveHoldings: hhi && hhi > 0 ? 1 / hhi : undefined,
    top1: weights[0],
    top3: weights.slice(0, 3).reduce((sum, w) => sum + w, 0),
    byCurrency: Object.fromEntries(Object.entries(byCurrency).map(([c, v]) => [c, fromCents(v)])),
    warnings,
    note: '权重按显式价格与汇率计算；行业暴露需要公司信息（本工具不联网），缺失即 unknown。',
  }
}

export interface ScenarioResult {
  before: { hhi?: number; top1?: number; top3?: number; weight?: number }
  after: { hhi?: number; top1?: number; top3?: number; weight?: number }
  delta: { hhi?: number; top1?: number; top3?: number }
  applied: Array<{ assetId: string; fromWeight?: number; toWeight: number }>
  feasible: boolean
  warnings: string[]
  note: string
}

/**
 * 情景：把某个资产的权重调到目标值（其他资产按比例缩放），比较集中度变化。
 * 纯模拟：不修改账本，也不代表真实可成交。
 */
export function simulateWeightChange(
  exposure: ExposureResult,
  changes: Array<{ assetId: string; targetWeight: number }>,
): ScenarioResult {
  const warnings: string[] = []
  const feasible = exposure.totalCents !== undefined
  if (!feasible) warnings.push('缺少汇率或价格：情景结果不可计算')
  if (changes.some((c) => c.targetWeight < 0 || c.targetWeight > 1)) warnings.push('目标权重需在 0–1 之间')

  const current = new Map(exposure.rows.filter((r) => r.weight !== undefined).map((r) => [r.assetId, r.weight!]))
  const requested = new Map(changes.map((c) => [c.assetId, c.targetWeight]))
  for (const assetId of requested.keys()) {
    if (!current.has(assetId)) warnings.push(`当前没有该资产的可定价持仓：${assetId}（情景只做权重替换，不虚构买入价）`)
  }

  const targetSum = [...requested.values()].reduce((sum, w) => sum + w, 0)
  if (targetSum > 1) warnings.push('目标权重合计超过 100%：情景不成立')

  const pricedAssets = [...current.keys()]
  const fixedAssets = pricedAssets.filter((id) => requested.has(id))
  const freeAssets = pricedAssets.filter((id) => !requested.has(id))
  const freeCurrentSum = freeAssets.reduce((sum, id) => sum + (current.get(id) ?? 0), 0)
  const remaining = Math.max(0, 1 - targetSum)
  const scale = freeCurrentSum > 0 ? remaining / freeCurrentSum : 0

  const after = new Map<string, number>()
  for (const id of freeAssets) after.set(id, (current.get(id) ?? 0) * scale)
  for (const id of fixedAssets) after.set(id, requested.get(id) ?? 0)

  const stats = (map: Map<string, number>) => {
    const ws = [...map.values()].filter((w) => w > 0).sort((a, b) => b - a)
    if (ws.length === 0) return { hhi: undefined, top1: undefined, top3: undefined }
    return {
      hhi: ws.reduce((sum, w) => sum + w * w, 0),
      top1: ws[0],
      top3: ws.slice(0, 3).reduce((sum, w) => sum + w, 0),
    }
  }
  const beforeStats = stats(current)
  const afterStats = stats(after)
  const delta = {
    hhi: beforeStats.hhi !== undefined && afterStats.hhi !== undefined ? afterStats.hhi - beforeStats.hhi : undefined,
    top1: beforeStats.top1 !== undefined && afterStats.top1 !== undefined ? afterStats.top1 - beforeStats.top1 : undefined,
    top3: beforeStats.top3 !== undefined && afterStats.top3 !== undefined ? afterStats.top3 - beforeStats.top3 : undefined,
  }

  return {
    before: beforeStats,
    after: afterStats,
    delta,
    applied: changes.map((c) => ({ assetId: c.assetId, fromWeight: current.get(c.assetId), toWeight: c.targetWeight })),
    feasible: feasible && targetSum <= 1,
    warnings,
    note: '纸面情景：假设按目标权重调整、其余资产等比例缩放；未考虑交易成本、税费、最小交易单位与真实可成交性，不构成任何买卖建议。',
  }
}
