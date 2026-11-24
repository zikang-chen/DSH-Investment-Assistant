/** 单品种新浪行情回落：给全球跨资产快照用，东财整链不可用时至少还有一份价。 */
import { SINA_GLOBAL_REFERER, SINA_GLOBAL_URL, SINA_SYMBOL_BY_SECID, parseSinaLines, parseSinaQuote } from './sina-global-indices.js'
import { httpGetText } from './http.js'

export interface SinaSingleQuote {
  price: number
  change: number | null
  changePct: number | null
  asOf: string | null
  source: string
}

/**
 * 按 secid 取单个品种。只映射表里有的品种；其余返回 null 而不是拿同代码替代。
 * 过期（超过 7 天）或价格缺失一律 null。
 */
export async function fetchSinaGlobalQuote(secid: string, options: { signal?: AbortSignal; now?: number } = {}): Promise<SinaSingleQuote | null> {
  const symbol = SINA_SYMBOL_BY_SECID[secid]
  if (!symbol) return null
  try {
    const text = await httpGetText(`${SINA_GLOBAL_URL}${symbol}`, {}, {
      timeoutMs: 12_000, referer: SINA_GLOBAL_REFERER, encoding: 'gbk',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const row = parseSinaLines(text).find((line) => line.symbol === symbol)
    if (!row) return null
    const parsed = parseSinaQuote(symbol, row.fields)
    if (!parsed || parsed.price === null || !Number.isFinite(parsed.price) || parsed.price <= 0) return null
    const now = options.now ?? Date.now()
    if (parsed.asOf) {
      const age = now - Date.parse(parsed.asOf)
      if (!Number.isFinite(age) || age > 7 * 86_400_000 || age < -86_400_000) return null
    }
    return { price: parsed.price, change: parsed.change, changePct: parsed.changePct, asOf: parsed.asOf, source: 'sina' }
  } catch { return null }
}
