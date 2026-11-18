import type { FinanceDataService } from '../data/service.js'
import type { PortfolioStore } from '../store.js'
import { quoteCurrency } from '../valuation.js'
import { httpGetJson } from '../data/http.js'

/** Explicitly authorized read only. No cost-price fallback and no inferred cash. */
export async function importPortfolioSnapshot(store: PortfolioStore, finance: FinanceDataService, authorized: boolean) {
  if (authorized !== true) return { ok: false, error: '本次尚未授权读取持仓；未读取任何个人资产。' }
  await store.load()
  const holdings = store.get().holdings
  if (holdings.length > 20) return { ok: false, error: '当前最多核验20项，请先显式选择组合范围。' }
  const quotes = await finance.getQuotes(holdings.map(p => ({ code: p.code, type: p.type ?? 'stock' })))
  const rows = quotes.ok && Array.isArray(quotes.data) ? quotes.data : []
  const positions = holdings.map(p => {
    const q = rows.find(q => q.code === p.code && q.type === (p.type ?? 'stock'))
    // Quote metadata carries source time; missing time must stay missing.
    const rawDate = q?.asOf ?? q?.raw?.navDate ?? q?.raw?.time
    const priceAsOf = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0,10) : undefined
    return { id: `${p.type ?? 'stock'}:${p.code}`, code: p.code, name: p.name, type: p.type ?? 'stock',
      assetClass: p.type === 'fund' ? 'fund' : 'equity', currency: quoteCurrency(p.code, p.type) ?? '',
      quantity: p.quantity, price: q?.price, priceAsOf, priceSource: q?.provider,
    }
  })
  const gaps: string[] = []
  const fx: Array<{currency:string;baseCurrency:string;rate:number;asOf:string;source:string}> = []
  for (const currency of [...new Set(positions.map(p=>p.currency).filter(c=>c && c!=='CNY'))]) {
    try {
      const url=`https://api.frankfurter.dev/v1/latest`
      const r=await httpGetJson<{base:string;date:string;rates:Record<string,number>}>(url,{base:currency,symbols:'CNY'},{timeoutMs:15000})
      if(r.base!==currency || !(r.rates?.CNY>0)) throw Error('invalid FX response')
      fx.push({currency,baseCurrency:'CNY',rate:r.rates.CNY,asOf:r.date,source:`${url}?base=${currency}&symbols=CNY (reference, not executable FX)`})
    }catch(e){gaps.push(`${currency}汇率不可用：${String(e)}`)}
  }
  const histories: Array<{id:string;currency:string;points:Array<{date:string;close:number}>}> = []
  for(const p of positions){
    try{
      const r=await finance.getAutoKline(p.code,undefined,p.type)
      if(r.ok && Array.isArray(r.data)) histories.push({id:p.id,currency:p.currency,points:r.data.map(b=>({date:b.date,close:b.close}))})
      else gaps.push(`${p.id}历史不可用`)
    }catch(e){gaps.push(`${p.id}历史：${String(e)}`)}
  }
  return { ok: true, positions, cash: [], fx, histories, fundHoldings: [], gaps,
    fetchedAt: new Date().toISOString(), notice: '只读持仓快照，不含账户现金或成本替代价；FX为公开日参考汇率。基金重仓源未携带可靠披露时点，须补原始披露后穿透；不得用抓取日伪装披露日。数量单位以本机记录为准。' }
}
