import { useState } from 'react'
import { Button, PageHeader } from './design-system/index.js'
import { deliveryFeedback, type Deliver } from './workbench-model.js'
import { evaluatePortfolioPolicy, type PortfolioPolicyInput } from '../strategy/portfolio-policy.js'
import { PortfolioResult } from './portfolio-result.js'
import { PortfolioOperations } from './portfolio-operations.js'
import type { ReadApi } from './workbench-model.js'

/** Explicit multi-position draft. Never imports personal holdings implicitly. */
export function PortfolioStrategy({ deliver, get, post }: { deliver: Deliver; get: ReadApi; post: <T>(path:string,body:Record<string,unknown>)=>Promise<T> }) {
  const [rows, setRows] = useState([{ id: '', assetClass: 'equity', currency: 'CNY', current: '', target: '', priceAsOf: '' }, { id: '', assetClass: 'bond', currency: 'CNY', current: '', target: '', priceAsOf: '' }])
  const [cash, setCash] = useState('')
  const [targetCash, setTargetCash] = useState('')
  const [maxAsset, setMaxAsset] = useState('40')
  const [maxClass, setMaxClass] = useState('70')
  const [minCash, setMinCash] = useState('5')
  const [turnover, setTurnover] = useState('20')
  const [drift, setDrift] = useState('5')
  const [lastReview, setLastReview] = useState('')
  const [cadence, setCadence] = useState('30')
  const [signals, setSignals] = useState('[]')
  const [asOf, setAsOf] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const percent = (v: string) => v.trim() === '' ? NaN : Number(v) / 100
  const input = (): PortfolioPolicyInput => ({
    asOf, baseCurrency: 'CNY', positions: rows.map(row => ({ id: row.id.trim(), assetClass: row.assetClass, currency: row.currency, currentWeight: percent(row.current), targetWeight: percent(row.target), ...(row.priceAsOf ? {priceAsOf: row.priceAsOf} : {}) })),
    cashWeight: percent(cash), targetCashWeight: percent(targetCash),
    constraints: { maxAssetWeight: percent(maxAsset), maxAssetClassWeight: percent(maxClass), minCashWeight: percent(minCash), maxTurnover: percent(turnover), driftThreshold: percent(drift) },
    review: { ...(lastReview ? { lastReviewedAt: lastReview } : {}), cadenceDays: Number(cadence) }, signals: JSON.parse(signals),
  })
  const evaluate = () => {setError('');try{setResult(evaluatePortfolioPolicy(input()))}catch(e){setResult(undefined);setError(e instanceof Error?e.message:String(e))}}
  const review = async () => {
    if(busy)return
    setBusy(true)
    try {
      const draft=input();const checked=evaluatePortfolioPolicy(draft)
      if(!checked.ok){setResult(checked);setError('先修正组合输入，不能把无效权重交给Agent当已确认目标。');return}
      setFeedback(deliveryFeedback(await deliver([
        '请按组合策略流程复核以下用户显式输入的组合草案，仅使用本次提供的数据，不读取其他私人资产。',
        JSON.stringify(draft),
        '先用 portfolio_strategy_review 校验当前/目标权重、现金、集中度、资产类别、币种暴露、漂移和换手预算。',
        '按组合资产暴露获取行情、风险、基金穿透/相关性、利率美元与国际形势、国内政策真实证据；每条附来源、日期和反面因素。缺数据先报告，必要时创建证据请求。',
        '变化先触发复核，不直接改变战略目标。若需要战术调整，请给保留原目标与调整候选两个情景，解释每项变化、组合风险、现金与换手、失效条件。再次用 portfolio_strategy_review 比较，不把单股看多等同组合应加仓。',
        '未经我批准不得覆盖草案、激活策略或改账本；不生成实际订单。保存完整来源、旧/新hash与候选方案到资料库，等待确认。',
      ].join('\n'))))
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const edit=(i:number,key:string,value:string)=>{setRows(prev=>prev.map((r,j)=>j===i?{...r,[key]:value}:r));setResult(undefined)}
  return <div className="fia-page" data-testid="portfolio-strategy" onChangeCapture={() => setResult(undefined)}><PageHeader title="组合策略" eyebrow="PORTFOLIO POLICY" description="整组合的战略目标、风险预算与调整复核。"/>
    <section className="fia-research-section"><h3>1 · 组合与战略基线</h3><p className="fia-muted">含现金两侧各须合计100%。</p>
      <div style={{overflowX:'auto'}}><table className="fia-table"><thead><tr><th>标的</th><th>资产类别</th><th>币种</th><th>当前%</th><th>目标%</th><th>估值日期</th><th>操作</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td><input aria-label={`标的${i+1}`} value={r.id} onChange={e=>edit(i,'id',e.target.value)}/></td><td><select value={r.assetClass} onChange={e=>edit(i,'assetClass',e.target.value)}>{['equity','bond','gold','fund','other'].map(k=><option key={k}>{k}</option>)}</select></td><td><input aria-label={`币种${i+1}`} style={{width:65}} value={r.currency} onChange={e=>edit(i,'currency',e.target.value.toUpperCase())}/></td><td><input aria-label={`当前权重${i+1}`} type="number" style={{width:75}} value={r.current} onChange={e=>edit(i,'current',e.target.value)}/></td><td><input aria-label={`目标权重${i+1}`} type="number" style={{width:75}} value={r.target} onChange={e=>edit(i,'target',e.target.value)}/></td><td><input aria-label={`估值日期${i+1}`} type="date" value={r.priceAsOf} onChange={e=>edit(i,'priceAsOf',e.target.value)}/></td><td><Button disabled={rows.length<=2} onClick={()=>{setRows(p=>p.filter((_,j)=>j!==i));setResult(undefined)}}>移除</Button></td></tr>)}</tbody></table></div>
      <Button disabled={rows.length>=20} onClick={()=>setRows(p=>[...p,{id:'',assetClass:'other',currency:'CNY',current:'',target:'',priceAsOf:''}])}>添加资产</Button>
      <div className="fia-inline-actions"><label>当前现金% <input type="number" value={cash} onChange={e=>setCash(e.target.value)}/></label><label>目标现金% <input type="number" value={targetCash} onChange={e=>setTargetCash(e.target.value)}/></label></div>
      <details><summary>口径与限制</summary><p className="fia-muted">跨币种权重须按同一估值时点折算CNY；此处不核验汇率。基金按顶层权重归类，穿透在下方“资产与数据核验”。</p></details>
    </section>
    <section className="fia-research-section"><h3>2 · 风险预算与复核</h3><p className="fia-muted">预填值仅为示例，需按自身约束修改。</p><div className="fia-inline-actions">
      {([['单资产上限%',maxAsset,setMaxAsset],['资产类别上限%',maxClass,setMaxClass],['最低现金%',minCash,setMinCash],['单次换手预算%',turnover,setTurnover],['漂移触发（百分点）',drift,setDrift]] as const).map(([label,value,set])=><label key={label}>{label}<input type="number" value={value} onChange={e=>set(e.target.value)}/></label>)}
      <label>复核日期<input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label><label>上次复核<input type="date" value={lastReview} onChange={e=>setLastReview(e.target.value)}/></label><label>周期（天）<input type="number" value={cadence} onChange={e=>setCadence(e.target.value)}/></label>
    </div></section>
    <section className="fia-research-section"><h3>3 · 环境变化证据</h3><details><summary>证据格式</summary><p className="fia-muted">数组：topic、claim、source、asOf、direction（risk/support/neutral）。来源存在不等于已核验。</p></details><textarea aria-label="组合环境证据JSON" style={{width:'100%',boxSizing:'border-box'}} rows={4} value={signals} onChange={e=>setSignals(e.target.value)}/><div className="fia-inline-actions"><Button onClick={evaluate}>检查组合与调整边界</Button><Button variant="primary" disabled={busy} onClick={()=>void review()}>{busy?'投递中…':'让Agent调研并比较调整情景'}</Button></div>{error&&<p role="alert">{error}</p>}{feedback&&<p role="status">{feedback}</p>}</section>
    <PortfolioOperations get={get} post={post} policy={input}/>
    {result!==undefined&&<section className="fia-research-section"><h3>4 · 校验与变化预览</h3><p className="fia-muted">仅权重预览；缺口需先补齐。</p><PortfolioResult value={result as ReturnType<typeof evaluatePortfolioPolicy>}/><details><summary>完整规则与审计结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:600,overflow:'auto'}}>{JSON.stringify(result,null,2)}</pre></details></section>}
  </div>
}
