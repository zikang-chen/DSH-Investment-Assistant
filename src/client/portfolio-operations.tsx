import { useEffect, useState } from 'react'
import { Button } from './design-system/index.js'
import type { PortfolioPolicyInput } from '../strategy/portfolio-policy.js'
import type { PortfolioVersionEntry } from '../strategy/portfolio-versions.js'
import type { ReadApi } from './workbench-model.js'

type Post = <T>(path:string,body:Record<string,unknown>)=>Promise<T>
export function PortfolioOperations({ get, post, policy }: { get:ReadApi;post:Post;policy:()=>PortfolioPolicyInput }) {
  const [entries,setEntries]=useState<PortfolioVersionEntry[]>([])
  const [name,setName]=useState('')
  const [reason,setReason]=useState('')
  const [parent,setParent]=useState('')
  const [authorized,setAuthorized]=useState(false)
  const [verification,setVerification]=useState('')
  const [testInput,setTestInput]=useState('')
  const [output,setOutput]=useState<unknown>()
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const reload=async()=>{const r=await get<{ok:boolean;entries:PortfolioVersionEntry[]}>('/strategy/versions');setEntries(r.entries??[])}
  useEffect(()=>{void reload().catch(e=>setError(String(e)))},[get])
  const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const transition=(e:PortfolioVersionEntry,action:string)=>void run(async()=>{
    if(!reason.trim()){setError('请填写本次变更原因');return}
    if(!window.confirm(`${action==='approve'?'批准仅作纸面跟踪，不执行交易':action}：${e.name} v${e.version}？`))return
    await post('/strategy/transition',{id:e.id,action,expectedRevision:e.revision,reason:reason.trim(),userConfirmed:true});await reload()
  })
  return <div>
    <section className="fia-research-section"><h3>组合版本与审批</h3><div className="fia-inline-actions">
      <input aria-label="组合名称" placeholder="组合名称" value={name} onChange={e=>setName(e.target.value)}/>
      <input aria-label="变更原因" placeholder="变更/审批原因（必填）" value={reason} onChange={e=>setReason(e.target.value)}/>
      <select aria-label="父版本" value={parent} onChange={e=>setParent(e.target.value)}><option value="">新建组合</option>{entries.map(e=><option key={e.id} value={e.id}>{e.name} v{e.version} · {e.state}</option>)}</select>
      <Button disabled={busy||!name.trim()||!reason.trim()} onClick={()=>void run(async()=>{const base=entries.find(e=>e.id===parent);await post('/strategy/versions',{name:name.trim(),reason:reason.trim(),policy:policy(),...(base?{parentId:base.id,expectedParentRevision:base.revision}:{})});await reload()})}>保存新版本</Button>
      <Button disabled={busy} onClick={()=>void run(reload)}>刷新</Button>
    </div>
    {!entries.length&&<p className="fia-muted">尚无保存版本。</p>}
    {entries.map(e=><details key={e.id}><summary>{e.name} · v{e.version} · {({draft:'草案',review:'待审阅',approved:'已批准纸面跟踪',rejected:'已驳回',retired:'已退役'})[e.state]}</summary>
      <p>规则 {e.policyHash} · 修订 {e.revision}</p><p>{e.reason}</p><div className="fia-inline-actions">
        {e.state==='draft'&&<Button disabled={busy} onClick={()=>transition(e,'submit')}>提交审阅</Button>}
        {e.state==='review'&&<><Button disabled={busy} onClick={()=>transition(e,'approve')}>批准纸面跟踪</Button><Button disabled={busy} onClick={()=>transition(e,'reject')}>驳回</Button></>}
        {e.state==='approved'&&<Button disabled={busy} onClick={()=>transition(e,'retire')}>退役</Button>}
        <Button onClick={()=>{setParent(e.id);setName(e.name)}}>以此为父版本保存当前表单</Button>
      </div><details><summary>政策与审阅历史</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({policy:e.policy,history:e.history},null,2)}</pre></details>
    </details>)}
    </section>
    <section className="fia-research-section"><h3>资产与数据核验</h3>
      <p className="fia-muted">先授权导入，再补汇率、基金披露与历史序列。</p>
      <label><input type="checkbox" checked={authorized} onChange={e=>setAuthorized(e.target.checked)}/>本次允许只读导入持仓及取得对应行情（不读取账户凭证）</label>
      <Button disabled={busy||!authorized} onClick={()=>void run(async()=>{setAuthorized(false);const r=await post<Record<string,unknown>>('/strategy/import',{authorized:true});if(r.ok===false)throw Error(String(r.error));setVerification(JSON.stringify({asOf:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),baseCurrency:'CNY',...r},null,2))})}>授权读取并准备核验</Button>
      <details><summary>价格、汇率、基金披露与历史序列</summary><p className="fia-muted">导入不猜现金与汇率；补数须带来源和日期。</p><textarea aria-label="组合核验输入" rows={10} style={{width:'100%',boxSizing:'border-box'}} value={verification} onChange={e=>setVerification(e.target.value)}/><Button disabled={busy||!verification.trim()} onClick={()=>void run(async()=>setOutput(await post('/strategy/verify',JSON.parse(verification))))}>核验估值、穿透与协方差</Button></details>
    </section>
    <section className="fia-research-section"><h3>多资产历史再平衡</h3><details><summary>导入历史、公司行动与税费假设后运行</summary>
      <p className="fia-muted">需raw价格、权重、整手、费用税表、分红/拆股与逐期汇率。</p><details><summary>口径与限制</summary><p className="fia-muted">分红须含除息/支付日与来源，拆股须含比例。缺公司行动覆盖声明只能输出部分口径，不能称完整总回报；外部数据未核验。</p></details>
      <textarea aria-label="多资产回测输入" rows={12} placeholder="粘贴有来源的 PortfolioBacktestInput JSON" style={{width:'100%',boxSizing:'border-box'}} value={testInput} onChange={e=>setTestInput(e.target.value)}/>
      <Button disabled={busy||!testInput.trim()} onClick={()=>void run(async()=>setOutput(await post('/strategy/backtest',JSON.parse(testInput))))}>运行多资产纸面回测</Button>
    </details></section>
    {error&&<p role="alert" className="fia-error-text">{error}</p>}
    {output!==undefined&&<details open><summary>核验 / 回测结果</summary><pre style={{maxHeight:600,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(output,null,2)}</pre></details>}
  </div>
}
