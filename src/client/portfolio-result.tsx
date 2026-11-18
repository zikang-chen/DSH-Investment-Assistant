import type { PortfolioPolicyResult } from '../strategy/portfolio-policy.js'
const pct=(v:number|undefined)=>v===undefined?'—':`${(v*100).toFixed(2)}%`
export function PortfolioResult({value:r}:{value:PortfolioPolicyResult}){
  return <div>
    <p role={r.ok?'status':'alert'}><strong>{r.status==='BLOCKED'?'方案未通过约束':r.status==='REVIEW_REQUIRED'?'需要复核':'当前在规则内'}</strong> · 仅纸面研究，需人工确认</p>
    {r.errors.length>0&&<ul>{r.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>}
    {r.current&&r.target&&<table className="fia-table"><caption>整体组合对比（现金计入集中度）</caption><thead><tr><th>指标</th><th>当前</th><th>候选</th></tr></thead><tbody><tr><th>第一大权重</th><td>{pct(r.current.top1)}</td><td>{pct(r.target.top1)}</td></tr><tr><th>集中度HHI</th><td>{r.current.hhi.toFixed(4)}</td><td>{r.target.hhi.toFixed(4)}</td></tr><tr><th>现金</th><td>{pct(r.current.cash)}</td><td>{pct(r.target.cash)}</td></tr><tr><th>含现金换手</th><td>—</td><td>{pct(r.turnover)}</td></tr></tbody></table>}
    {r.drifts&&<div style={{overflowX:'auto'}}><table className="fia-table"><caption>逐持仓偏离（不是买卖指令）</caption><thead><tr><th>资产</th><th>当前%</th><th>目标%</th><th>偏离（百分点）</th></tr></thead><tbody>{r.drifts.map(d=><tr key={d.id}><th>{d.id}</th><td>{pct(d.currentWeight)}</td><td>{pct(d.targetWeight)}</td><td>{(d.drift*100).toFixed(2)}</td></tr>)}</tbody></table></div>}
    <h4>触发原因</h4>{r.triggers.length?<ul>{r.triggers.map((t,i)=><li key={i}>{t.detail}</li>)}</ul>:<p>没有已确认的触发项。</p>}
    <h4>数据与执行缺口</h4>{r.gaps.length?<ul>{r.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul>:<p>本次输入无已报告缺口，不等于已核验外部来源。</p>}
    {r.constraintChecks?.some(c=>!c.satisfied)&&<p role="alert">候选违反预算，请先修正目标；系统不会自动归一化或偷偷放宽限制。</p>}
    <p>{r.proposed?'候选权重可作纸面对照，尚未批准或应用。':'未生成可供确认的权重方案。'} 估值、成本、税费和可成交性仍须核验。</p>
  </div>
}
