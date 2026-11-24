import { useEffect, useState } from 'react'
import { Button } from './design-system/index.js'
import type { PortfolioPolicyInput } from '../strategy/portfolio-policy.js'
import type { PortfolioVersionEntry } from '../strategy/portfolio-versions.js'
import type { ReadApi } from './workbench-model.js'
import { BacktestBuilder } from './backtest-builder.js'

type Post = <T>(path:string,body:Record<string,unknown>)=>Promise<T>
const STATE_LABEL: Record<string, string> = { draft: '草案', review: '待审阅', approved: '纸面跟踪中', rejected: '已驳回', retired: '已退役' }

export function PortfolioOperations({ get, post, policy, onLoad, loadedVersionId, readyToSave }: {
  get: ReadApi; post: Post; policy: () => PortfolioPolicyInput
  onLoad?: (entry: PortfolioVersionEntry) => void; loadedVersionId?: string; readyToSave?: boolean
}) {
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
    if(!window.confirm(`${action==='approve'?'批准仅作纸面跟踪，不执行交易':action==='reject'?'驳回':'提交审阅'}：${e.name} v${e.version}？`))return
    await post('/strategy/transition',{id:e.id,action,expectedRevision:e.revision,reason:reason.trim(),userConfirmed:true});await reload()
  })
  return <div>
    <section className="fia-research-section"><h3>4 · 保存与审批</h3>
      <div className="fia-inline-actions">
        <input aria-label="组合名称" placeholder="组合名称" value={name} onChange={e=>setName(e.target.value)}/>
        <input aria-label="变更原因" placeholder="变更原因" value={reason} onChange={e=>setReason(e.target.value)}/>
        <select aria-label="父版本" value={parent} onChange={e=>setParent(e.target.value)}><option value="">新建组合</option>{entries.map(e=><option key={e.id} value={e.id}>{e.name} v{e.version} · {STATE_LABEL[e.state]??e.state}</option>)}</select>
        <Button disabled={busy||!name.trim()||!reason.trim()} onClick={()=>void run(async()=>{const base=entries.find(e=>e.id===parent);await post('/strategy/versions',{name:name.trim(),reason:reason.trim(),policy:policy(),...(base?{parentId:base.id,expectedParentRevision:base.revision}:{})});await reload()})}>{readyToSave?'保存为版本':'保存当前表单'}</Button>
        <Button disabled={busy} onClick={()=>void run(reload)}>刷新</Button>
      </div>
      {readyToSave===false&&<p className="fia-muted">保存前先完成第 3 步检查。</p>}
      {loadedVersionId&&<p className="fia-muted">正在编辑已保存版本 <code>{loadedVersionId}</code> 的副本。</p>}
      {!entries.length&&<p className="fia-muted">尚无已保存版本。</p>}
      {entries.map(e=><details key={e.id} open={e.id===loadedVersionId}><summary>{e.name} · v{e.version} · {STATE_LABEL[e.state]??e.state}</summary>
        <div className="fia-inline-actions">
          {onLoad&&<Button disabled={busy} onClick={()=>onLoad(e)}>载入为编辑副本</Button>}
          {e.state==='draft'&&<Button disabled={busy} onClick={()=>transition(e,'submit')}>提交审阅</Button>}
          {e.state==='review'&&<><Button disabled={busy} onClick={()=>transition(e,'approve')}>批准纸面跟踪</Button><Button disabled={busy} onClick={()=>transition(e,'reject')}>驳回</Button></>}
          {e.state==='approved'&&<Button disabled={busy} onClick={()=>transition(e,'retire')}>退役</Button>}
          <Button onClick={()=>{setParent(e.id);setName(e.name)}}>以它为父版本</Button>
        </div>
        <details><summary>规则与审阅历史</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{JSON.stringify({policy:e.policy,history:e.history},null,2)}</pre></details>
      </details>)}
    </section>
    <section className="fia-research-section"><h3>数据核验</h3>
      <p className="fia-muted">核验估值、穿透与相关性；缺失项会逐条列出。</p>
      <Button disabled={busy||!authorized} onClick={()=>void run(async()=>{setAuthorized(false);const r=await post<Record<string,unknown>>('/strategy/import',{authorized:true});if(r.ok===false)throw Error(String(r.error));setVerification(JSON.stringify({asOf:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),baseCurrency:'CNY',...r},null,2))})}>授权读取持仓并准备核验</Button>
      <label style={{marginLeft:8}}><input type="checkbox" checked={authorized} onChange={e=>setAuthorized(e.target.checked)}/>本次允许读取我的持仓（只读）</label>
      <details><summary>价格、汇率与基金披露</summary><textarea aria-label="组合核验输入" rows={10} style={{width:'100%',boxSizing:'border-box'}} value={verification} onChange={e=>setVerification(e.target.value)}/><Button disabled={busy||!verification.trim()} onClick={()=>void run(async()=>setOutput(await post('/strategy/verify',JSON.parse(verification))))}>运行核验</Button></details>
    </section>
    <section className="fia-research-section"><h3>历史再平衡（纸面）</h3>
      <BacktestBuilder get={get} post={post} onResult={(result) => setOutput(result)} />
      <details><summary>高级：直接编辑输入 JSON</summary>
        <p className="fia-muted">需要含来源的原始价格、权重、费用税费与公司行动；缺公司行动覆盖声明只能输出部分口径。</p>
        <textarea aria-label="多资产回测输入" rows={12} placeholder="有来源的 PortfolioBacktestInput JSON" style={{width:'100%',boxSizing:'border-box'}} value={testInput} onChange={e=>setTestInput(e.target.value)}/>
        <Button disabled={busy||!testInput.trim()} onClick={()=>void run(async()=>setOutput(await post('/strategy/backtest',JSON.parse(testInput))))}>运行回测</Button>
      </details></section>
    {error&&<p role="alert" className="fia-error-text">{error}</p>}
    {output!==undefined&&<details><summary>核验 / 回测结果</summary><pre style={{maxHeight:600,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(output,null,2)}</pre></details>}
  </div>
}
