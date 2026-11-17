import { getFinanceTokens, type MarketMode, type ResolvedTheme } from './design-system/tokens.js'
import type { KlinePalette } from './kline-math.js'

/** Presentation-only adapter. OHLC, moving averages and return calculations stay untouched. */
export function financeChartPalette(theme: ResolvedTheme, mode: MarketMode): KlinePalette {
  const t = getFinanceTokens(theme, mode)
  return {
    up: t.up, down: t.down, upFill: `${t.up}22`,
    ma: { 5: t['chart-1'], 10: t['chart-2'], 20: t['chart-3'], 60: t['chart-4'] },
    maDash: { 5: [], 10: [6, 3], 20: [2, 3], 60: [8, 3, 2, 3] },
    grid: t.grid, text: t.secondary, cross: t.brand,
  }
}
