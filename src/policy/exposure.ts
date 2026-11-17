/**
 * Policy ↔ portfolio exposure matching (read-only).
 *
 * Two levels only, because anything finer would be invented:
 * - `direct`: the security code is explicitly annotated on the document;
 * - `industryMatched`: the security's own company profile mentions one of the
 *   document's industries.
 *
 * A match is never called "beneficiary": the result explicitly carries the
 * missing evidence needed to upgrade it.
 */
import type { PolicyDocument } from './types.js'

export interface ExposureItem {
  code: string
  name?: string
  type?: string
  role: 'holding' | 'watchlist'
}

export interface ExposureMatch {
  code: string
  name: string
  role: 'holding' | 'watchlist'
  /** Which industry keyword matched. */
  industry: string
  source: 'stock-info'
}

export interface ExposureResult {
  direct: ExposureItem[]
  industryMatched: ExposureMatch[]
  checkedSymbols: number
  gaps: string[]
  note: string
}

export interface ExposureOptions {
  /** Company-profile lookup; return a text blob (name/industry/business) or undefined. */
  lookup?: (code: string) => Promise<string | undefined>
  /** Max symbols to look up (network-bound). */
  limit?: number
  /** Skip stocks that only exist as funds. */
  skipFunds?: boolean
}

/** Match one policy against a flat holdings+watchlist list. */
export async function matchExposure(doc: PolicyDocument, items: ExposureItem[], opts: ExposureOptions = {}): Promise<ExposureResult> {
  const direct = items.filter((item) => doc.relatedAssets.includes(item.code))
  const industries = doc.relatedIndustries.filter(Boolean)
  const limit = Math.max(0, Math.min(20, opts.limit ?? 5))
  const industryMatched: ExposureMatch[] = []
  let checked = 0

  if (opts.lookup && industries.length > 0) {
    for (const item of items) {
      if (checked >= limit) break
      if (direct.some((d) => d.code === item.code)) continue
      if (opts.skipFunds !== false && item.type === 'fund') continue
      checked++
      try {
        const blob = await opts.lookup(item.code)
        if (!blob) continue
        const hit = industries.find((industry) => blob.includes(industry))
        if (hit) industryMatched.push({ code: item.code, name: item.name ?? '', role: item.role, industry: hit, source: 'stock-info' })
      } catch {
        // One symbol failing must not fail the whole match.
      }
    }
  }

  const gaps: string[] = []
  if (doc.relatedAssets.length === 0) gaps.push('政策库尚未标注 relatedAssets：先用 policy_annotate 写入有业务证据的代码')
  if (industries.length === 0) gaps.push('政策库尚未标注 relatedIndustries：先用 policy_annotate 写入行业')
  if (!opts.lookup) gaps.push('未接行情/公司信息服务：只能做代码级匹配，无法按行业筛')
  if (items.length === 0) gaps.push('持仓与自选为空：先去「持仓」页导入，或先加自选')
  gaps.push('行业命中只代表「可能相关」，不等于受益：需看年报收入占比、订单/招投标、产品与政策的对应关系')

  return {
    direct,
    industryMatched,
    checkedSymbols: checked,
    gaps,
    note: '只读匹配，不修改持仓；不构成买卖建议。',
  }
}
