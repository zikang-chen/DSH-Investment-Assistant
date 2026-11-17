/** Missing/non-finite values are unknown, never coerced to zero. */
export type NumericValue = number | null | undefined
export const MISSING_VALUE = '—'

export interface NumberFormatOptions {
  /** Fixed decimal places. Defaults to 2 (formatCompact trims trailing zeros). */
  decimals?: number
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  /** Include + for positive values; a value rounded to zero has no sign. */
  signed?: boolean
  locale?: string
  useGrouping?: boolean
}
type NumberOptions = NumberFormatOptions | number
export interface MoneyFormatOptions extends NumberFormatOptions {
  currency?: string
  /** Hide the currency symbol, e.g. when the column header already states CNY. */
  symbol?: boolean
}
export interface PercentFormatOptions extends NumberFormatOptions {
  /** Default 'percent': 5 means 5%. Only explicit 'ratio' turns .05 into 5%. */
  input?: 'percent' | 'ratio'
}
export interface PointsFormatOptions extends NumberFormatOptions {
  /** Default pp (percentage points), NOT a percent sign. Does not rescale input. */
  suffix?: ' pp' | ' 个百分点' | ' bp'
}
export interface DateFormatOptions { timeZone?: string; includeTime?: boolean }

function finite(value: NumericValue): value is number { return typeof value === 'number' && Number.isFinite(value) }
function options(value: NumberOptions = {}): NumberFormatOptions { return typeof value === 'number' ? { decimals: value } : value }
function digits(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(20, Math.max(0, Math.trunc(value))) : fallback
}

/** Sign is applied after rounding, so -0 and -0.001 at two decimals both print 0.00. */
function formatted(value: number, opts: NumberFormatOptions, trim = false): { magnitude: string; sign: string } {
  const max = digits(opts.maximumFractionDigits, digits(opts.decimals, 2))
  const min = Math.min(max, digits(opts.minimumFractionDigits, trim ? 0 : max))
  const magnitude = new Intl.NumberFormat(opts.locale ?? 'zh-CN', {
    minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: opts.useGrouping ?? true,
  }).format(Math.abs(value))
  // Inspect the rounded output numerically without relying on locale-specific separators.
  const roundedZero = Number(new Intl.NumberFormat('en-US', { maximumFractionDigits: max, useGrouping: false }).format(Math.abs(value))) === 0
  return { magnitude, sign: roundedZero ? '' : value < 0 ? '−' : opts.signed ? '+' : '' }
}

export function formatNumber(value: NumericValue, opts: NumberOptions = {}): string {
  if (!finite(value)) return MISSING_VALUE
  const result = formatted(value, options(opts))
  return `${result.sign}${result.magnitude}`
}

export function formatMoney(value: NumericValue, opts: MoneyFormatOptions | number = {}): string {
  if (!finite(value)) return MISSING_VALUE
  const config: MoneyFormatOptions = typeof opts === 'number' ? { decimals: opts } : opts
  const currency = (config.currency ?? 'CNY').toUpperCase()
  const currencySymbols: Record<string, string> = { CNY: '¥', USD: '$', HKD: 'HK$', EUR: '€', GBP: '£', JPY: '¥' }
  const symbol = config.symbol === false ? '' : currencySymbols[currency] ?? `${currency} `
  const result = formatted(value, config)
  return `${result.sign}${symbol}${result.magnitude}`
}

export function formatPercent(value: NumericValue, opts: PercentFormatOptions | number = {}): string {
  if (!finite(value)) return MISSING_VALUE
  const config: PercentFormatOptions = typeof opts === 'number' ? { decimals: opts } : opts
  const percent = config.input === 'ratio' ? value * 100 : value
  if (!Number.isFinite(percent)) return MISSING_VALUE
  return `${formatNumber(percent, config)}%`
}

export function formatPoints(value: NumericValue, opts: PointsFormatOptions | number = {}): string {
  if (!finite(value)) return MISSING_VALUE
  const config: PointsFormatOptions = typeof opts === 'number' ? { decimals: opts } : opts
  return `${formatNumber(value, config)}${config.suffix ?? ' pp'}`
}

/** Chinese financial compact units. Rounding across 10,000/100,000,000 promotes the unit. */
export function formatCompact(value: NumericValue, opts: NumberOptions = {}): string {
  if (!finite(value)) return MISSING_VALUE
  const config = options(opts)
  const max = digits(config.maximumFractionDigits, digits(config.decimals, 2))
  const units = [{ divisor: 1, suffix: '' }, { divisor: 1e4, suffix: '万' }, { divisor: 1e8, suffix: '亿' }]
  let index = Math.abs(value) >= 1e8 ? 2 : Math.abs(value) >= 1e4 ? 1 : 0
  if (index < 2 && Number((Math.abs(value) / units[index]!.divisor).toFixed(max)) >= 1e4) index++
  const unit = units[index]!
  const result = formatted(value / unit.divisor, config, true)
  return `${result.sign}${result.magnitude}${unit.suffix}`
}

/** Dates without a time remain dates. Instants default explicitly to Asia/Shanghai. */
export function formatDate(value: Date | string | number | null | undefined, opts: DateFormatOptions = {}): string {
  if (value === null || value === undefined || value === '') return MISSING_VALUE
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = value instanceof Date ? value : new Date(dateOnly ? `${value}T00:00:00Z` : value)
  if (!Number.isFinite(date.getTime())) return MISSING_VALUE
  if (dateOnly) {
    if (date.toISOString().slice(0, 10) !== value) return MISSING_VALUE
    if (!opts.includeTime) return value as string
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timeZone ?? 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      ...(opts.includeTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
    }).formatToParts(date)
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}${opts.includeTime ? ` ${part('hour')}:${part('minute')}` : ''}`
  } catch { return MISSING_VALUE }
}
