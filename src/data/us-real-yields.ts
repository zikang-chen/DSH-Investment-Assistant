/**
 * 美国实际利率（TIPS）与盈亏平衡通胀：来自美国财政部官方每日利率曲线 CSV。
 *
 * 为什么不用「10Y 名义 − CPI 同比」：那是期限错配（存量收益率 vs 过去 12 个月通胀）
 * 加口径错配（名义 vs 实际），只能算粗略代理。财政部同时发布
 * - 实际收益率曲线（TIPS 恒定到期）
 * - 名义收益率曲线（恒定到期）
 * 两者同一天相减就是市场定价的盈亏平衡通胀，口径一致。
 *
 * 数据源（官方、免费、无 key）：
 * https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_real_yield_curve
 * https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve
 */

export const TREASURY_CSV_BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv'
export const TREASURY_TIMEOUT_MS = 15_000

export interface TreasuryCurve {
  /** 最新一行日期（YYYY-MM-DD）。 */
  asOf: string
  /** 期限 → 收益率（%）。 */
  rates: Record<string, number>
}

export interface RealYieldReport {
  ok: boolean
  asOf?: string
  real: Record<string, number>
  nominal: Record<string, number>
  breakeven: Record<string, number>
  /** 实际与名义曲线的最新日期是否同一天；不同则盈亏平衡不可比。 */
  aligned: boolean
  source: string
  warnings: string[]
  error?: string
}

function csvUrl(type: string, year: number): string {
  return `${TREASURY_CSV_BASE}/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`
}

/** M/D/YYYY → YYYY-MM-DD；非法返回 null（不猜）。 */
export function treasuryDate(raw: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim())
  if (!match) return null
  const [, month, day, year] = match
  const iso = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null
}

/**
 * 解析财政部曲线 CSV。首行表头形如 `Date,"1 MO","2 MO",...,"30 YR"`；
 * 空值与 `N/A` 一律当缺失，不补 0。
 */
export function parseTreasuryCurve(csv: string): TreasuryCurve | null {
  const lines = String(csv ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const header = lines[0]!.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim())
  if (!/^date$/i.test(header[0] ?? '')) return null
  let best: TreasuryCurve | null = null
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim())
    const date = treasuryDate(cells[0] ?? '')
    if (!date) continue
    const rates: Record<string, number> = {}
    for (let i = 1; i < header.length; i++) {
      const value = Number(cells[i])
      if (!Number.isFinite(value)) continue
      rates[header[i]!] = value
    }
    if (!Object.keys(rates).length) continue
    if (!best || date > best.asOf) best = { asOf: date, rates }
  }
  return best
}

/** 只保留 TERM 里的期限，标签统一成 `10Y` 这类形式。 */
export function pickTerms(rates: Record<string, number>, terms: readonly string[]): Record<string, number> {
  const wanted = new Set(terms.map((t) => t.toUpperCase()))
  const out: Record<string, number> = {}
  for (const [label, value] of Object.entries(rates)) {
    const normalized = label.toUpperCase().replace(/\s+/g, ' ')
    if (wanted.has(normalized)) out[normalized] = value
  }
  return out
}

export const CURVE_TERMS = ['5 YR', '7 YR', '10 YR', '20 YR', '30 YR'] as const

export async function fetchRealYields(options: { year?: number; signal?: AbortSignal; fetchText?: (url: string, signal?: AbortSignal) => Promise<string> } = {}): Promise<RealYieldReport> {
  const year = options.year ?? new Date().getUTCFullYear()
  const fetchText = options.fetchText ?? defaultFetchText
  const source = 'home.treasury.gov（美国财政部每日利率曲线 CSV）'
  const warnings: string[] = []
  try {
    const [realCsv, nominalCsv] = await Promise.all([
      fetchText(csvUrl('daily_treasury_real_yield_curve', year), options.signal),
      fetchText(csvUrl('daily_treasury_yield_curve', year), options.signal),
    ])
    const real = parseTreasuryCurve(realCsv)
    const nominal = parseTreasuryCurve(nominalCsv)
    if (!real) return { ok: false, real: {}, nominal: {}, breakeven: {}, aligned: false, source, warnings, error: '实际收益率曲线为空或格式变化' }
    if (!nominal) return { ok: false, real: {}, nominal: {}, breakeven: {}, aligned: false, source, warnings, error: '名义收益率曲线为空或格式变化' }
    const realTerms = pickTerms(real.rates, CURVE_TERMS)
    const nominalTerms = pickTerms(nominal.rates, CURVE_TERMS)
    const aligned = real.asOf === nominal.asOf
    if (!aligned) warnings.push(`实际曲线日期 ${real.asOf} 与名义曲线 ${nominal.asOf} 不同，盈亏平衡通胀不可直接相减`)
    const breakeven: Record<string, number> = {}
    if (aligned) {
      for (const term of CURVE_TERMS) {
        if (realTerms[term] !== undefined && nominalTerms[term] !== undefined) {
          breakeven[term] = Math.round((nominalTerms[term]! - realTerms[term]!) * 100) / 100
        }
      }
    }
    if (realTerms['10 YR'] === undefined) warnings.push('缺 10 年期实际收益率')
    return {
      ok: true,
      asOf: real.asOf,
      real: realTerms,
      nominal: nominalTerms,
      breakeven,
      aligned,
      source,
      warnings,
    }
  } catch (error) {
    return { ok: false, real: {}, nominal: {}, breakeven: {}, aligned: false, source, warnings,
      error: error instanceof Error ? error.message : String(error) }
  }
}

async function defaultFetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv,*/*' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).hostname}`)
  return response.text()
}
