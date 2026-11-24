import { useRef, useState } from 'react'
import { Button, PageHeader, formatNumber } from './design-system/index.js'
import type { Deliver } from './workbench-model.js'
import { deliveryFeedback } from './workbench-model.js'
import type { StrategyExperimentSuccess } from '../strategy/lab.js'
import { ExperimentSummary } from './strategy-summary.js'

/** Raw values remain visible; no client-side return calculation or invented confidence score. */
export function StrategyLab({ post, deliver }: { post: <T>(path: string, payload: Record<string, unknown>) => Promise<T>; deliver: Deliver }) {
  const [code, setCode] = useState('')
  const [cash, setCash] = useState('100000')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const seq = useRef(0)
  const run = async () => {
    if (busy) return
    const id = ++seq.current
    setBusy(true); setResult(undefined); setError('')
    try { const r = await post<unknown>('/strategy/experiment', { code: code.trim(), initialCash: Number(cash) }); if (seq.current === id) setResult(r) }
    catch (e) { if (seq.current === id) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (seq.current === id) setBusy(false) }
  }
  const sendReview = async () => {
    if (sending) return
    setSending(true)
    try { setFeedback(deliveryFeedback(await deliver([
      `请对 ${code.trim()} 做策略环境复核，不读取我的真实资产或执行交易。`,
      '先用 strategy_experiment 核对可用数据和固定模板结果；读取现有策略草案，不覆盖冻结版本。',
      '按需要获取最新行情/波动/资金与市场宽度、全球市场快照、央行/贸易/国际事件官方新闻和国内政策。每条证据记录来源与日期，分支持/风险/未知。',
      '调用 strategy_environment_review；过期或缺证据必须说明。当前形势不能回填历史回测，不宣称因果或收益保证。',
      '提出保留/降低风险假设/调整规则的候选理由与反证；若需新规则，用 submit_strategy 存新草案、注明原版本hash和变化，重新验证后等待我批准，不能自动激活。',
      '把完整实验来源、hash、成本、样本外结果及环境复核存入资料库；证据不足时不提出买卖点位。',
    ].join('\n')))) }
    catch(e) { setFeedback(e instanceof Error ? e.message : String(e)) }
    finally { setSending(false) }
  }
  return <div className="fia-page" data-testid="strategy-lab">
    <PageHeader title="策略实验室" eyebrow="PAPER RESEARCH" description="比较价格策略、查看模拟结果，再结合市场变化复核。" />
    <section className="fia-research-section"><h3>价格策略对比</h3>
      <p className="fia-muted">支持普通A股主板，使用 CNY、未复权日线。费用与涨跌停采用简化假设，结果不含完整分红及公司行动。</p>
      <form onSubmit={e => {e.preventDefault(); void run()}} className="fia-inline-actions">
        <label>股票代码 <input aria-label="策略股票代码" value={code} disabled={busy} onChange={e => {setCode(e.target.value); setResult(undefined)}} placeholder="如 600519" /></label>
        <label>模拟本金（CNY） <input aria-label="模拟本金" type="number" min="1" value={cash} disabled={busy} onChange={e => {setCash(e.target.value); setResult(undefined)}} /></label>
        <Button type="submit" variant="primary" disabled={busy || !/^\d{6}$/.test(code.trim()) || !(Number(cash) > 0)}>{busy ? '校验与计算中…' : '运行纸面实验'}</Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
    {result !== undefined && <section className="fia-research-section"><h3>实验结果与数据校验</h3>
      {(result as {ok?:boolean}).ok === true && <ExperimentSummary result={result as StrategyExperimentSuccess} />}
      <details open={(result as {ok?:boolean}).ok !== true}><summary>完整结果、口径与可复现信息</summary><ResultTree value={result} /></details>
    </section>}
    <section className="fia-research-section"><h3>结合市场与国际形势复核</h3>
      <p>发送到对话，结合最新市场资料复核策略。</p>
      <Button disabled={sending || !/^\d{6}$/.test(code.trim())} onClick={() => void sendReview()}>{sending ? '正在投递…' : '让 Agent 复核市场环境'}</Button>
      {feedback && <p role="status">{feedback}</p>}
    </section>
  </div>
}
const labels: Record<string, string> = { ok: '数据校验通过', reason: '未通过原因', code: '标的', currency: '币种', adjustment: '价格口径', source: '原始来源', fetchedAt: '抓取时间', coverage: '覆盖范围', templates: '模板比较', metrics: '全段指标', totalReturnPct: '价格收益率（%）', maxDrawdownPct: '最大回撤（%）', tradeCount: '交易次数', totalCost: '费用（CNY）', finalEquity: '期末纸面资产', holdout: '留出段', warnings: '限制与警告', notices: '口径声明', gaps: '数据缺口', name: '名称', id: '模板', strategyHash: '规则校验码', dataHash: '数据校验码', configHash: '配置校验码', from: '起始', to: '截止', equity: '权益序列', trades: '模拟交易' }
function ResultTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span>—</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value === 'number') return <span className="fia-number">{Number.isFinite(value) ? formatNumber(value, { decimals: 2 }) : '—'}</span>
  if (typeof value === 'string') return <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{value}</span>
  if (Array.isArray(value)) return <div>{value.slice(0, 12).map((v,i) => <div key={i} style={{ marginBlock: 8 }}><ResultTree value={v} depth={depth+1} /></div>)}{value.length>12 && <details><summary>其余{value.length-12}项原始结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value.slice(12),null,2)}</pre></details>}</div>
  if (depth > 6) return <pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(value,null,2)}</pre>
  return <dl>{Object.entries(value as Record<string,unknown>).map(([k,v]) => <div key={k} style={{ marginBlock: 6 }}><dt><strong>{labels[k] ?? k}</strong></dt><dd style={{marginInlineStart:12}}>{['equity','trades'].includes(k) ? <details><summary>查看可复现序列</summary><ResultTree value={v} depth={depth+1}/></details> : <ResultTree value={v} depth={depth+1}/>}</dd></div>)}</dl>
}
