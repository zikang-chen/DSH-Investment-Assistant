/**
 * Deterministic capital performance.
 *
 * Everything here is computed from ledger events — no model calls, no estimates.
 * Three numbers are kept deliberately separate because merging them is the most
 * common way to fake a return:
 *
 * - **net invested** = external deposits − withdrawals (never profit);
 * - **realized** = FIFO proceeds − cost basis (fees included in both);
 * - **unrealized** = current value − remaining cost basis (only for priced assets).
 *
 * TWR requires valuations at every external-flow boundary. Without them the
 * function returns `unavailable` instead of dressing up total-asset growth as a
 * time-weighted return. XIRR returns `no-root` / `multiple-roots` explicitly.
 */
import {
  EXTERNAL_FLOW_TYPES,
  convertCents,
  fromCents,
  toCents,
  type CapitalEvent,
  type FxTable,
  type PricePoint,
} from './types.js'

export interface AssetPosition {
  assetId: string
  accountId: string
  currency: string
  quantity: number
  /** Remaining FIFO cost basis in cents. */
  costCents: number
  averageCostCents: number
}

export interface CashBalance {
  accountId: string
  currency: string
  cents: number
}

export interface LedgerState {
  cash: CashBalance[]
  cashByCurrency: Record<string, number>
  positions: AssetPosition[]
  /** Realized P&L per currency, in cents. */
  realizedByCurrency: Record<string, number>
  /** Cumulative fees/taxes per currency. */
  feesByCurrency: Record<string, number>
  /** Cash income (dividend/interest) per currency. */
  incomeByCurrency: Record<string, number>
  /** External net invested per currency (deposits − withdrawals). */
  netInvestedByCurrency: Record<string, number>
  /** External flows for XIRR: dates + signed cents per currency. */
  externalFlows: Array<{ date: string; currency: string; cents: number }>
  warnings: string[]
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/** Cash effect of one event, in its own currency. */
function cashDelta(event: CapitalEvent): { currency: string; cents: number } | undefined {
  const gross = toCents(event.grossAmount)
  const net = toCents(event.netAmount)
  const fee = toCents(event.fee)
  const tax = toCents(event.tax)
  switch (event.eventType) {
    case 'DEPOSIT':
      return { currency: event.currency, cents: gross }
    case 'WITHDRAWAL':
      return { currency: event.currency, cents: -gross }
    case 'BUY':
      return { currency: event.currency, cents: -(gross || Math.round(toCents(event.quantity * event.price)) + fee + tax) }
    case 'SELL':
      return { currency: event.currency, cents: net || Math.round(toCents(event.quantity * event.price)) - fee - tax }
    case 'DIVIDEND':
    case 'INTEREST':
      return { currency: event.currency, cents: net || gross }
    case 'FEE':
    case 'TAX':
      return { currency: event.currency, cents: -gross }
    case 'FX_CONVERSION':
      // Leaves one currency (−gross) and enters another (+net); handled by caller.
      return { currency: event.currency, cents: -gross }
    case 'INTERNAL_TRANSFER':
      // Own money moving between own accounts: net zero across the pool.
      return { currency: event.currency, cents: 0 }
    case 'ADJUSTMENT':
      return gross !== 0 ? { currency: event.currency, cents: gross } : undefined
    default:
      return undefined
  }
}

/** Derive cash, positions (FIFO), realized P&L and external flows from events. */
export function deriveState(events: CapitalEvent[]): LedgerState {
  const warnings: string[] = []
  const cashMap = new Map<string, CashBalance>()
  const realized: Record<string, number> = {}
  const fees: Record<string, number> = {}
  const income: Record<string, number> = {}
  const invested: Record<string, number> = {}
  const flows: LedgerState['externalFlows'] = []
  const lots = new Map<string, Array<{ qty: number; unitCostCents: number }>>()
  const meta = new Map<string, { accountId: string; currency: string }>()

  const addCash = (accountId: string, currency: string, cents: number): void => {
    if (cents === 0) return
    const key = `${accountId}|${currency}`
    const existing = cashMap.get(key)
    if (existing) existing.cents += cents
    else cashMap.set(key, { accountId, currency, cents })
  }

  for (const event of events) {
    const qty = Number(event.quantity) || 0
    const price = Number(event.price) || 0
    const fee = toCents(event.fee)
    const tax = toCents(event.tax)
    const key = `${event.accountId}|${event.assetId}`

    if (event.fee !== 0 || event.tax !== 0) fees[event.currency] = (fees[event.currency] ?? 0) + fee + tax

    const delta = cashDelta(event)
    if (delta) addCash(event.accountId, delta.currency, delta.cents)
    if (event.eventType === 'FX_CONVERSION' && event.fxCurrency) {
      addCash(event.accountId, event.fxCurrency, toCents(event.netAmount))
    }
    if (event.eventType === 'CORPORATE_ACTION' && Math.round(toCents(event.grossAmount)) !== 0) {
      addCash(event.accountId, event.currency, Math.round(toCents(event.grossAmount)))
    }

    if (event.eventType === 'DIVIDEND' || event.eventType === 'INTEREST') {
      income[event.currency] = (income[event.currency] ?? 0) + (toCents(event.netAmount) || toCents(event.grossAmount))
    }
    if (EXTERNAL_FLOW_TYPES.includes(event.eventType)) {
      const signed = event.eventType === 'DEPOSIT' ? toCents(event.grossAmount) : -toCents(event.grossAmount)
      invested[event.currency] = (invested[event.currency] ?? 0) + signed
      flows.push({ date: event.occurredAt, currency: event.currency, cents: signed })
    }

    if (event.eventType === 'BUY' || event.eventType === 'SELL' || event.eventType === 'SPLIT' || event.eventType === 'CORPORATE_ACTION') {
      meta.set(key, { accountId: event.accountId, currency: event.currency })
    }

    if (event.eventType === 'BUY') {
      if (!(qty > 0)) { warnings.push(`买入数量为 0：${event.eventId}`); continue }
      const costCents = Math.round(qty * price * 100) + fee + tax
      const list = lots.get(key) ?? []
      list.push({ qty, unitCostCents: costCents / qty })
      lots.set(key, list)
    } else if (event.eventType === 'SELL') {
      const list = lots.get(key) ?? []
      let remaining = qty
      let costBasis = 0
      while (remaining > 1e-9 && list.length > 0) {
        const lot = list[0]!
        const take = Math.min(lot.qty, remaining)
        costBasis += take * lot.unitCostCents
        lot.qty -= take
        remaining -= take
        if (lot.qty <= 1e-9) list.shift()
      }
      if (remaining > 1e-6) warnings.push(`卖出数量超过持仓（${event.assetId} 缺 ${round2(remaining)}）：${event.eventId}`)
      const proceeds = (toCents(event.netAmount) || Math.round(qty * price * 100) - fee - tax)
      realized[event.currency] = (realized[event.currency] ?? 0) + Math.round(proceeds - costBasis)
    } else if (event.eventType === 'SPLIT') {
      const ratio = qty
      if (ratio > 0) {
        const list = lots.get(key) ?? []
        for (const lot of list) {
          lot.qty *= ratio
          lot.unitCostCents /= ratio
        }
      }
    } else if (event.eventType === 'CORPORATE_ACTION' && qty !== 0) {
      // 送股/配股：数量变化但成本按原成本摊薄
      const list = lots.get(key) ?? []
      const totalQty = list.reduce((sum, lot) => sum + lot.qty, 0)
      if (totalQty > 0 && qty > 0) {
        list.push({ qty, unitCostCents: 0 })
      } else if (qty < 0) {
        let remaining = -qty
        while (remaining > 1e-9 && list.length > 0) {
          const lot = list[0]!
          const take = Math.min(lot.qty, remaining)
          lot.qty -= take
          remaining -= take
          if (lot.qty <= 1e-9) list.shift()
        }
      }
    }
  }

  const positions: AssetPosition[] = []
  for (const [key, list] of lots) {
    const quantity = list.reduce((sum, lot) => sum + lot.qty, 0)
    if (quantity <= 1e-9) continue
    const costCents = Math.round(list.reduce((sum, lot) => sum + lot.qty * lot.unitCostCents, 0))
    const info = meta.get(key) ?? { accountId: '-', currency: 'CNY' }
    positions.push({
      assetId: key.split('|')[1] ?? '',
      accountId: info.accountId,
      currency: info.currency,
      quantity: round2(quantity),
      costCents,
      averageCostCents: Math.round(costCents / quantity),
    })
  }

  return {
    cash: [...cashMap.values()].filter((c) => c.cents !== 0).sort((a, b) => a.accountId.localeCompare(b.accountId)),
    cashByCurrency: sumInto(cashMap),
    positions: positions.sort((a, b) => a.assetId.localeCompare(b.assetId)),
    realizedByCurrency: realized,
    feesByCurrency: fees,
    incomeByCurrency: income,
    netInvestedByCurrency: invested,
    externalFlows: flows.sort((a, b) => a.date.localeCompare(b.date)),
    warnings,
  }
}

function sumInto(cashMap: Map<string, CashBalance>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of cashMap.values()) out[entry.currency] = (out[entry.currency] ?? 0) + entry.cents
  return out
}

export interface NetWorthResult {
  asOf: string
  baseCurrency: string
  /** Per-currency totals in cents (cash + priced positions). */
  byCurrency: Record<string, number>
  /** Converted total; `undefined` when any currency has no rate. */
  totalCents: number | undefined
  cashCents: number | undefined
  positionsCents: number | undefined
  unpricedAssets: string[]
  stalePrices: string[]
  missingFx: string[]
  note: string
}

/** Net worth = cash + priced positions, converted to the base currency explicitly. */
export function netWorth(
  state: LedgerState,
  prices: PricePoint[],
  baseCurrency: string,
  fx: FxTable,
  asOf: string,
): NetWorthResult {
  const base = baseCurrency.toUpperCase()
  const priceMap = new Map(prices.map((p) => [p.assetId, p]))
  const byCurrency: Record<string, number> = { ...state.cashByCurrency }
  const unpriced: string[] = []
  const stale: string[] = []

  for (const position of state.positions) {
    const price = priceMap.get(position.assetId)
    if (!price) {
      unpriced.push(position.assetId)
      continue
    }
    if (price.stale) stale.push(position.assetId)
    const valueCents = Math.round(position.quantity * price.price * 100)
    const marketCurrency = (price.currency || position.currency).toUpperCase()
    byCurrency[marketCurrency] = (byCurrency[marketCurrency] ?? 0) + valueCents
  }

  const missingFx: string[] = []
  let total = 0
  let cash = 0
  let positions = 0
  for (const [currency, cents] of Object.entries(byCurrency)) {
    const converted = convertCents(cents, currency, base, fx)
    if (converted === undefined) {
      missingFx.push(currency)
      continue
    }
    total += converted
    if (currency === base) { /* split below by recomputation */ }
  }
  // Recompute cash/positions split with the same conversion rules.
  for (const [currency, cents] of Object.entries(state.cashByCurrency)) {
    const converted = convertCents(cents, currency, base, fx)
    if (converted !== undefined) cash += converted
  }
  for (const position of state.positions) {
    const price = priceMap.get(position.assetId)
    if (!price) continue
    const marketCurrency = (price.currency || position.currency).toUpperCase()
    const converted = convertCents(Math.round(position.quantity * price.price * 100), marketCurrency, base, fx)
    if (converted !== undefined) positions += converted
  }

  const note = missingFx.length > 0
    ? `缺少 ${missingFx.join('/')} → ${base} 汇率：无法给出单一总资产，已按币种分别列示`
    : unpriced.length > 0
      ? `有 ${unpriced.length} 个资产没有行情：总资产不含这些持仓（不是 0）`
      : '总资产包含现金与全部已定价持仓'

  return {
    asOf,
    baseCurrency: base,
    byCurrency,
    totalCents: missingFx.length > 0 ? undefined : total,
    cashCents: missingFx.length > 0 ? undefined : cash,
    positionsCents: missingFx.length > 0 ? undefined : positions,
    unpricedAssets: unpriced,
    stalePrices: stale,
    missingFx,
    note,
  }
}

export interface XirrResult {
  status: 'ok' | 'insufficient' | 'no-root' | 'multiple-roots'
  rate?: number
  roots?: number[]
  note: string
}

function npv(rate: number, flows: Array<{ days: number; cents: number }>): number {
  let total = 0
  for (const flow of flows) total += flow.cents / Math.pow(1 + rate, flow.days / 365)
  return total
}

/**
 * Money-weighted return (XIRR). Explicitly reports missing roots and multiple
 * roots instead of picking whichever number came out of the solver.
 */
export function xirr(input: Array<{ date: string; cents: number }>): XirrResult {
  const flows = input
    .filter((f) => Number.isFinite(f.cents) && f.cents !== 0)
    .map((f) => ({ at: Date.parse(f.date), cents: f.cents }))
    .filter((f) => Number.isFinite(f.at))
    .sort((a, b) => a.at - b.at)
  if (flows.length < 2) return { status: 'insufficient', note: '至少需要两笔现金流' }
  const hasNeg = flows.some((f) => f.cents < 0)
  const hasPos = flows.some((f) => f.cents > 0)
  if (!hasNeg || !hasPos) return { status: 'insufficient', note: '现金流必须同时包含流入与流出，否则 IRR 无定义' }

  const base = flows[0]!.at
  const days = flows.map((f) => ({ days: (f.at - base) / 86_400_000, cents: f.cents }))
  const roots: number[] = []
  const low = -0.9999
  const high = 10
  const steps = 4000
  let prevRate = low
  let prevValue = npv(low, days)
  for (let i = 1; i <= steps; i++) {
    const rate = low + ((high - low) * i) / steps
    const value = npv(rate, days)
    if (Number.isFinite(prevValue) && Number.isFinite(value) && prevValue === 0) {
      roots.push(prevRate)
    } else if (Number.isFinite(prevValue) && Number.isFinite(value) && prevValue * value < 0) {
      // Bisection for a precise root inside the bracket.
      let a = prevRate
      let b = rate
      let fa = prevValue
      for (let k = 0; k < 120; k++) {
        const mid = (a + b) / 2
        const fm = npv(mid, days)
        if (!Number.isFinite(fm)) break
        if (Math.abs(fm) < 1e-10) { a = mid; b = mid; break }
        if (fa * fm < 0) { b = mid } else { a = mid; fa = fm }
      }
      const root = (a + b) / 2
      if (!roots.some((r) => Math.abs(r - root) < 1e-6)) roots.push(root)
    }
    prevRate = rate
    prevValue = value
  }

  if (roots.length === 0) {
    return { status: 'no-root', note: '在 (−99.99%, 1000%) 区间内找不到有效解：现金流结构可能无解（例如总流入小于流出且期限极短）' }
  }
  if (roots.length > 1) {
    return { status: 'multiple-roots', roots: roots.map((r) => round6(r)), note: `检测到 ${roots.length} 个解（多次符号变化），不能只报一个；请改用 TWR 或缩短区间` }
  }
  return { status: 'ok', rate: round6(roots[0]!), note: '按实际现金流日期计算的年化内部收益率（MWR）' }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export interface TwrPoint { date: string; valueCents: number; flowCents?: number }

export interface TwrResult {
  status: 'ok' | 'unavailable' | 'invalid'
  rate?: number
  periods?: number
  note: string
}

/**
 * Time-weighted return. Needs a valuation at each boundary; without that series
 * the honest answer is "unavailable", not total-asset growth.
 */
export function twr(points: TwrPoint[]): TwrResult {
  if (points.length < 2) {
    return { status: 'unavailable', note: '缺少估值序列：TWR 需要每个现金流节点上的组合市值（至少两期）' }
  }
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))
  let product = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const curr = sorted[i]!
    if (!(prev.valueCents > 0)) return { status: 'invalid', note: `第 ${i} 期期初市值为 0 或负数，无法计算` }
    const flow = curr.flowCents ?? 0
    const growth = (curr.valueCents - flow) / prev.valueCents
    if (!Number.isFinite(growth)) return { status: 'invalid', note: `第 ${i} 期数据异常` }
    product *= growth
  }
  return { status: 'ok', rate: round6(product - 1), periods: sorted.length - 1, note: '按各期市值与现金流计算的链式时间加权收益率' }
}

export interface PerformanceSummary {
  asOf: string
  baseCurrency: string
  netInvested: Record<string, number>
  realized: Record<string, number>
  unrealized: Record<string, number>
  unrealizedTotalCents: number | undefined
  income: Record<string, number>
  fees: Record<string, number>
  netWorth: NetWorthResult
  xirr: XirrResult
  twr: TwrResult
  cashRatio: number | undefined
  warnings: string[]
  note: string
}

/** Assemble the reportable numbers. Every field is either computed or explicitly unavailable. */
export function performanceSummary(input: {
  state: LedgerState
  prices: PricePoint[]
  baseCurrency: string
  fx: FxTable
  asOf: string
  valuations?: TwrPoint[]
  costMethod?: 'fifo'
}): PerformanceSummary {
  const { state, prices, baseCurrency, fx, asOf } = input
  const worth = netWorth(state, prices, baseCurrency, fx, asOf)
  const priceMap = new Map(prices.map((p) => [p.assetId, p]))
  const realizedDollars: Record<string, number> = {}
  for (const [currency, cents] of Object.entries(state.realizedByCurrency)) realizedDollars[currency] = fromCents(cents)
  const netInvested: Record<string, number> = {}
  for (const [currency, cents] of Object.entries(state.netInvestedByCurrency)) netInvested[currency] = fromCents(cents)
  const income: Record<string, number> = {}
  for (const [currency, cents] of Object.entries(state.incomeByCurrency)) income[currency] = fromCents(cents)
  const fees: Record<string, number> = {}
  for (const [currency, cents] of Object.entries(state.feesByCurrency)) fees[currency] = fromCents(cents)

  const unrealized: Record<string, number> = {}
  let unrealizedTotal = 0
  let missingUnrealized = false
  for (const position of state.positions) {
    const price = priceMap.get(position.assetId)
    if (!price) { missingUnrealized = true; continue }
    const marketCents = Math.round(position.quantity * price.price * 100)
    const pnl = marketCents - position.costCents
    unrealized[position.currency] = (unrealized[position.currency] ?? 0) + pnl
    const converted = convertCents(pnl, position.currency, baseCurrency, fx)
    if (converted === undefined) missingUnrealized = true
    else unrealizedTotal += converted
  }
  for (const [currency, value] of Object.entries(unrealized)) unrealized[currency] = round2(value / 100)

  // XIRR: external flows per currency + today's value of that currency slice.
  const xirrResults: Record<string, XirrResult> = {}
  const fxFlows = state.externalFlows
  const currencies = [...new Set(fxFlows.map((f) => f.currency))]
  for (const currency of currencies) {
    const flows = fxFlows.filter((f) => f.currency === currency).map((f) => ({ date: f.date, cents: f.cents }))
    const valueInCurrency = worth.byCurrency[currency] ?? 0
    if (worth.unpricedAssets.length > 0) {
      xirrResults[currency] = { status: 'insufficient', note: '存在未定价持仓：终值不完整，不能计算 XIRR' }
      continue
    }
    flows.push({ date: asOf, cents: valueInCurrency })
    xirrResults[currency] = xirr(flows)
  }
  const singleCurrencyXirr = currencies.length === 1
    ? xirrResults[currencies[0]!]!
    : { status: 'insufficient' as const, note: currencies.length === 0 ? '没有外部资金流，无法计算资金加权收益' : '多币种账本：请按币种分别查看 XIRR，或先提供汇率再汇总' }

  const worthTotal = worth.totalCents
  const cashRatio = worthTotal !== undefined && worthTotal > 0 && worth.cashCents !== undefined
    ? round6(worth.cashCents / worthTotal)
    : undefined

  return {
    asOf,
    baseCurrency,
    netInvested,
    realized: realizedDollars,
    unrealized,
    unrealizedTotalCents: missingUnrealized ? undefined : unrealizedTotal,
    income,
    fees,
    netWorth: worth,
    xirr: singleCurrencyXirr,
    twr: twr(input.valuations ?? []),
    cashRatio,
    warnings: [
      ...state.warnings,
      ...(worth.unpricedAssets.length > 0 ? [`未定价资产 ${worth.unpricedAssets.length} 个：未实现收益与总资产不含它们`] : []),
      ...(worth.missingFx.length > 0 ? [`缺汇率 ${worth.missingFx.join('/')}：总资产与现金占比不给单一数值`] : []),
    ],
    note: 'TWR 需要逐期估值；XIRR 是资金加权收益。两者不可互相替代，也不等于总资产增长率。',
  }
}
