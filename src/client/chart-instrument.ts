export type ChartMarket = 'a' | 'hk' | 'us' | 'global' | 'fund'
export interface ChartInstrument { code: string; kind: ChartMarket; secid?: string; name?: string }
/** 场内 ETF/LOF 有交易价与分时；fund 身份仍用于基金档案/净值，不能把场外净值伪装成分钟价。 */
export function isExchangeFund(code: string): boolean { return /^(?:5[168]|1[56])\d{4}$/.test(code.trim()) }
export function chartInstrument(input: { code: string; kind?: string; type?: string; secid?: string; name?: string }): ChartInstrument {
  const code = input.code.trim()
  const secid = input.secid?.trim()
  const kind = input.kind ?? (input.type === 'fund' ? 'fund' : /^[A-Za-z]/.test(code) ? 'us' : /^\d{4,5}$/.test(code) ? 'hk' : 'a')
  if (kind === 'fund' && isExchangeFund(code)) return { code, kind: 'a', secid: `${code.startsWith('5') ? '1' : '0'}.${code}`, name: input.name }
  if (secid) {
    const match = /^(\d{1,3})\.(.+)$/.exec(secid)
    if (match) {
      const market = match[1]!, symbol = match[2]!
      const resolved: ChartMarket = ['0', '1'].includes(market) ? 'a' : market === '116' ? 'hk' : ['105', '106', '107'].includes(market) ? 'us' : 'global'
      return { code: symbol, kind: resolved, secid, name: input.name }
    }
  }
  return { code, kind: ['a','hk','us','fund','global'].includes(kind) ? kind as ChartMarket : 'global', ...(secid ? { secid } : {}), name: input.name }
}
