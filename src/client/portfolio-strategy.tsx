import { useState } from 'react'
import { Button, PageHeader } from './design-system/index.js'
import { deliveryFeedback, type Deliver } from './workbench-model.js'
import { evaluatePortfolioPolicy, type PortfolioPolicyInput } from '../strategy/portfolio-policy.js'
import { PortfolioResult } from './portfolio-result.js'
import { PortfolioOperations } from './portfolio-operations.js'
import type { ReadApi } from './workbench-model.js'
import type { PortfolioVersionEntry } from '../strategy/portfolio-versions.js'
import { PortfolioDataEditor } from './portfolio-data-editor.js'
import { assetClassLabels, blankPortfolioRow, copyCurrentToTarget, createPortfolioDraft, portfolioDraftFromPolicy, portfolioInputHints, portfolioPolicyFromDraft, portfolioTotals, verifiedCurrentDraft, type PortfolioRow } from './portfolio-product.js'

/** Explicit multi-position draft. Never imports personal holdings implicitly. */
export function PortfolioStrategy({ deliver, get, post }: { deliver: Deliver; get: ReadApi; post: <T>(path:string,body:Record<string,unknown>)=>Promise<T> }) {
  const [draft, setDraft] = useState(() => createPortfolioDraft(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })))
  const [result, setResult] = useState<ReturnType<typeof evaluatePortfolioPolicy>>()
  const [source, setSource] = useState('手动组合草案')
  const [loadedVersionId, setLoadedVersionId] = useState('')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const input = (): PortfolioPolicyInput => portfolioPolicyFromDraft(draft)
  const totals = portfolioTotals(draft)
  const hints = portfolioInputHints(draft)
  const checked = evaluatePortfolioPolicy(input())
  const evaluate = () => { setError(''); setFeedback(''); setResult(evaluatePortfolioPolicy(input())) }
  const loadVersion = (entry: PortfolioVersionEntry) => {
    setDraft(portfolioDraftFromPolicy(entry.policy)); setResult(undefined); setError(''); setFeedback('')
    setLoadedVersionId(entry.id); setSource(`${entry.name} v${entry.version} 的编辑副本 · 数据日期 ${entry.policy.asOf}`)
  }
  const review = async () => {
    if (busy) return
    setBusy(true); setError(''); setFeedback('')
    try {
      const policy = input(), evaluation = evaluatePortfolioPolicy(policy)
      setResult(evaluation)
      if (!evaluation.ok) { setError('请先补齐权重与现金，使当前和目标分别合计100%。'); return }
      setFeedback(deliveryFeedback(await deliver([
        '请按组合策略流程复核以下用户显式输入的组合草案，仅使用本次提供的数据，不读取其他私人资产。', JSON.stringify(policy),
        '先用 portfolio_strategy_review 校验当前/目标权重、现金、集中度、资产类别、币种暴露、漂移和换手预算。',
        '按组合资产暴露获取行情、风险、基金穿透/相关性、利率美元与国际形势、国内政策真实证据；每条附来源、日期和反面因素。缺数据先报告，必要时创建证据请求。',
        '变化先触发复核，不直接改变战略目标。比较保留原目标与调整候选两个纸面情景，解释每项变化、组合风险、现金与换手、费用税费、失效条件及复核日期。再次用 portfolio_strategy_review 比较。',
        '保存完整来源、旧/新hash与候选方案到资料库，等待确认。未经我批准不得覆盖目标、激活策略或改账本，不生成实际订单。',
      ].join('\n'))))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const editRow = (i: number, patch: Partial<PortfolioRow>) => { setDraft(d => ({ ...d, rows: d.rows.map((r, j) => j === i ? { ...r, ...patch } : r) })); setResult(undefined); setError(''); setFeedback('') }
  const totalLabel = (v: number | undefined) => v === undefined ? '待补齐' : `${v.toFixed(2)}%${Math.abs(v - 100) <= 1e-7 ? ' ✓' : ' · 应为100%'}`
  return <div className="fia-page" data-testid="portfolio-strategy"><PageHeader title="组合策略" eyebrow="PORTFOLIO POLICY" description="建立当前组合，比较目标情景，再保存和复核。"/>
    <p role="status"><strong>纸面模拟</strong> · 当前组合 → 目标与预算 → 检查漂移 → 保存草案 → 审阅确认</p>
    <PortfolioDataEditor post={post} onUse={(snapshot, verification, confirmed) => {
      if (!window.confirm('将核验权重带入当前组合？当前表单将被替换，目标权重需重新确认。')) return
      setDraft(d => verifiedCurrentDraft(d, snapshot, verification, confirmed)); setResult(undefined); setError(''); setFeedback(''); setLoadedVersionId(''); setSource(`核验快照 · ${snapshot.asOf}`)
    }}/>
    <div onChangeCapture={() => setResult(undefined)}><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
    <section className="fia-research-section"><h3>1 · 当前组合与战略基线</h3><p className="fia-muted">{source}。权重含现金；当前与目标分别合计100%。</p>
      <div className="fia-inline-actions"><label>基准币种 <input aria-label="基准币种" value={draft.baseCurrency} style={{ width: 80 }} onChange={e => setDraft(d => ({ ...d, baseCurrency: e.target.value.toUpperCase() }))}/></label><label>复核日期 <input aria-label="复核日期" type="date" value={draft.asOf} onChange={e => setDraft(d => ({ ...d, asOf: e.target.value }))}/></label></div>
      <div style={{ overflowX: 'auto' }}><table className="fia-table"><thead><tr><th>标的</th><th>资产类别</th><th>币种</th><th>当前%</th><th>目标%</th><th>估值日期</th><th>操作</th></tr></thead><tbody>{draft.rows.map((r, i) => <tr key={i}><td><input aria-label={`标的${i + 1}`} placeholder="代码或名称" value={r.id} onChange={e => editRow(i, { id: e.target.value })}/>{r.name && <small>{r.name}</small>}</td><td><select aria-label={`资产类别${i + 1}`} value={r.assetClass} onChange={e => editRow(i, { assetClass: e.target.value })}>{!assetClassLabels[r.assetClass] && <option value={r.assetClass}>{r.assetClass}</option>}{Object.entries(assetClassLabels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></td><td><input aria-label={`币种${i + 1}`} style={{ width: 65 }} value={r.currency} onChange={e => editRow(i, { currency: e.target.value.toUpperCase() })}/></td><td><input aria-label={`当前权重${i + 1}`} type="number" min="0" max="100" style={{ width: 80 }} value={r.current} onChange={e => editRow(i, { current: e.target.value })}/></td><td><input aria-label={`目标权重${i + 1}`} type="number" min="0" max="100" style={{ width: 80 }} value={r.target} onChange={e => editRow(i, { target: e.target.value })}/></td><td><input aria-label={`估值日期${i + 1}`} type="date" value={r.priceAsOf} onChange={e => editRow(i, { priceAsOf: e.target.value })}/></td><td><Button disabled={draft.rows.length <= 2} onClick={() => { setDraft(d => ({ ...d, rows: d.rows.filter((_, j) => j !== i) })); setResult(undefined) }}>移除</Button></td></tr>)}</tbody><tfoot><tr><th colSpan={3}>含现金合计</th><td colSpan={2}>当前 {totalLabel(totals.current)}<br/>目标 {totalLabel(totals.target)}</td><td colSpan={2}>缺少估值日期时仍可检查漂移</td></tr></tfoot></table></div>
      <div className="fia-inline-actions"><Button disabled={draft.rows.length >= 20} onClick={() => { setDraft(d => ({ ...d, rows: [...d.rows, { ...blankPortfolioRow(), currency: d.baseCurrency }] })); setResult(undefined) }}>添加资产</Button><Button onClick={() => { setDraft(copyCurrentToTarget); setResult(undefined) }}>以当前权重作为目标起点</Button></div>
      <div className="fia-inline-actions"><label>当前现金% <input aria-label="当前现金" type="number" min="0" max="100" value={draft.cash} onChange={e => setDraft(d => ({ ...d, cash: e.target.value }))}/></label><label>目标现金% <input aria-label="目标现金" type="number" min="0" max="100" value={draft.targetCash} onChange={e => setDraft(d => ({ ...d, targetCash: e.target.value }))}/></label></div>
      <p className="fia-muted">权重按同一估值时点折算至{draft.baseCurrency || '基准币种'}，现金栏为基准币现金。需核对汇率时使用上方导入核验；基金当前按顶层权重展示。</p>
    </section>
    <section className="fia-research-section"><h3>2 · 目标与风险预算</h3><p className="fia-muted">预填预算是可编辑起点，请按自己的要求确认。</p><div className="fia-inline-actions">
      {([['单资产上限%', 'maxAsset'], ['资产类别上限%', 'maxClass'], ['最低现金%', 'minCash'], ['单次换手预算%', 'turnover'], ['漂移触发（百分点）', 'drift']] as const).map(([label, key]) => <label key={key}>{label}<input aria-label={label} type="number" min="0" max="100" value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}/></label>)}
      <label>上次复核 <input type="date" value={draft.lastReview} onChange={e => setDraft(d => ({ ...d, lastReview: e.target.value }))}/></label><label>复核周期（天）<input type="number" min="1" value={draft.cadence} onChange={e => setDraft(d => ({ ...d, cadence: e.target.value }))}/></label>
    </div><details><summary>高级：单项专属范围</summary>{draft.rows.map((r, i) => <div key={i} className="fia-inline-actions"><span>{r.id || `第${i + 1}项`}</span><label>最低% <input type="number" aria-label={`专属下限${i + 1}`} value={r.minWeight === undefined ? '' : r.minWeight * 100} onChange={e => editRow(i, { minWeight: e.target.value === '' ? undefined : Number(e.target.value) / 100 })}/></label><label>最高% <input type="number" aria-label={`专属上限${i + 1}`} value={r.maxWeight === undefined ? '' : r.maxWeight * 100} onChange={e => editRow(i, { maxWeight: e.target.value === '' ? undefined : Number(e.target.value) / 100 })}/></label></div>)}</details>
      <details><summary>环境变化证据 · 可选（{draft.signals.length}条）</summary><p className="fia-muted">证据触发复核，目标权重仍由你确认。也可留空，请Agent调研补齐。</p>{draft.signals.map((s, i) => <div key={i} className="fia-research-section">{(['topic', 'claim', 'source', 'asOf'] as const).map(key => <label key={key}>{({ topic: '主题', claim: '事实', source: '来源URL或文件', asOf: '数据日期' })[key]} <input aria-label={`证据${i + 1} ${key}`} type={key === 'asOf' ? 'date' : 'text'} value={s[key]} onChange={e => setDraft(d => ({ ...d, signals: d.signals.map((v, j) => j === i ? { ...v, [key]: e.target.value } : v) }))}/></label>)}<label>影响 <select aria-label={`证据影响${i + 1}`} value={s.direction} onChange={e => setDraft(d => ({ ...d, signals: d.signals.map((v, j) => j === i ? { ...v, direction: e.target.value as typeof s.direction } : v) }))}><option value="risk">风险</option><option value="support">支持</option><option value="neutral">中性</option></select></label><Button onClick={() => { setDraft(d => ({ ...d, signals: d.signals.filter((_, j) => j !== i) })); setResult(undefined) }}>移除此证据</Button></div>)}<Button onClick={() => { setDraft(d => ({ ...d, signals: [...d.signals, { topic: '', claim: '', source: '', asOf: '', direction: 'neutral' }] })); setResult(undefined) }}>添加证据</Button></details>
    </section></fieldset></div>
    <section className="fia-research-section"><h3>3 · 检查漂移与比较情景</h3>{hints.length > 0 && <details><summary>还需补齐 {hints.length} 项</summary><ul>{hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul></details>}<div className="fia-inline-actions"><Button variant="primary" disabled={busy} onClick={evaluate}>检查组合与调整边界</Button><Button disabled={busy || !checked.ok} onClick={() => void review()}>{busy ? '投递中…' : '让Agent调研并比较调整情景'}</Button></div>{error && <p role="alert">{error}</p>}{feedback && <p role="status">{feedback}</p>}
      {result !== undefined ? <><PortfolioResult value={result}/><details><summary>完整规则与审计结果</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 500, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre></details></> : <p className="fia-muted">检查后显示当前与目标的集中度、币种暴露、换手及待补数据。修改输入后需重新检查。</p>}
    </section>
    <PortfolioOperations get={get} post={post} policy={input} onLoad={loadVersion} loadedVersionId={loadedVersionId} readyToSave={!!result?.ok && result.inputHash === checked.inputHash}/>
  </div>
}
