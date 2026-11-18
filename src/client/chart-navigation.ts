import type { SecurityIdentity } from './security-model.js'

export interface ChartTarget {
  code: string
  kind: 'a' | 'hk' | 'us' | 'fund'
  name?: string
  secid?: string
  market?: string
  at: number
}

/** Keep identity from the selected security; never drop its explicit market on a chart hop. */
export function chartTargetFor(item: SecurityIdentity, at: number): ChartTarget {
  const code = item.code.trim()
  const market = item.market ?? ''
  const kind = item.type === 'fund' ? 'fund'
    : /港|hong.?kong/i.test(market) || /^116\./.test(item.secid ?? '') ? 'hk'
      : /美股|美国|NASDAQ|NYSE/i.test(market) || /^(105|106|107)\./.test(item.secid ?? '') ? 'us'
        : /沪市|深市|京市|北交所|A股/.test(market) || /^(sh|sz|bj)\d/i.test(code) ? 'a'
          : /^HK[:.]|\.HK$|^\d{4,5}$/i.test(code) ? 'hk'
            : /[A-Z]/i.test(code) ? 'us' : 'a'
  return { ...item, code, kind, at }
}
