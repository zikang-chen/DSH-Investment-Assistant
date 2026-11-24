import { useRef, useState } from 'react'
import { Button } from './design-system/index.js'
import type { PortfolioVerificationInput, PortfolioVerificationResult } from '../strategy/portfolio-verification.js'
import { PortfolioVerificationView } from './portfolio-result.js'
import { assetClassLabels, requirePortfolioResponse } from './portfolio-product.js'

export type PortfolioPost = <T>(path: string, body: Record<string, unknown>) => Promise<T>
type PositionRow = { id: string; currency: string; assetClass: string; quantity: string; price: string; priceAsOf: string; priceSource: string }
type CashRow = { currency: string; amount: string }
type FxRow = { currency: string; baseCurrency: string; rate: string; asOf: string; source: string }
type Snapshot = { ok: boolean; error?: string; positions: PortfolioVerificationInput['positions']; cash: PortfolioVerificationInput['cash']; fx: PortfolioVerificationInput['fx']; histories: PortfolioVerificationInput['histories']; fundHoldings?: PortfolioVerificationInput['fundHoldings']; gaps?: string[] }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const requiredNumber = (value: string, label: string) => { if (!value.trim() || !Number.isFinite(Number(value))) throw Error(`请填写${label}`); return Number(value) }

/** Authorized snapshot -> editable fields -> verification -> explicit current-weight handoff. */
export function PortfolioDataEditor({ post, onUse }: { post: PortfolioPost; onUse: (input: PortfolioVerificationInput, result: PortfolioVerificationResult, cashConfirmed: boolean) => void }) {
  const [authorized, setAuthorized] = useState(false)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [cash, setCash] = useState<CashRow[]>([{ currency: 'CNY', amount: '' }])
  const [fx, setFx] = useState<FxRow[]>([])
  const [baseCurrency, setBaseCurrency] = useState('CNY')
  const [asOf, setAsOf] = useState(today)
  const [cashConfirmed, setCashConfirmed] = useState(false)
  const [extra, setExtra] = useState('{"histories":[],"fundHoldings":[]}')
  const [importGaps, setImportGaps] = useState<string[]>([])
  const [checked, setChecked] = useState<{ input: PortfolioVerificationInput; result: PortfolioVerificationResult }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const invalidate = () => { revision.current++; setChecked(undefined); setNotice(''); setError('') }
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const importSnapshot = () => void run(async () => {
    if (!authorized) throw Error('请勾选本次只读授权')
    setAuthorized(false); invalidate()
    const r = requirePortfolioResponse(await post<Snapshot>('/strategy/import', { authorized: true }))
    if (!Array.isArray(r.positions) || !Array.isArray(r.fx)) throw Error('快照格式不完整，请重新读取')
    setPositions(r.positions.map(p => ({ id: p.id, currency: p.currency, assetClass: p.assetClass, quantity: String(p.quantity), price: p.price === undefined ? '' : String(p.price), priceAsOf: p.priceAsOf ?? '', priceSource: p.priceSource ?? '' })))
    setCash([{ currency: 'CNY', amount: '' }]); setCashConfirmed(false); setBaseCurrency('CNY'); setAsOf(today())
    setFx(r.fx.map(f => ({ ...f, rate: String(f.rate) })))
    setExtra(JSON.stringify({ histories: r.histories ?? [], fundHoldings: r.fundHoldings ?? [] }, null, 2)); setImportGaps(r.gaps ?? [])
    setNotice(r.positions.length ? `已读取${r.positions.length}项。请核对现金及缺失的价格、汇率，再核验当前权重。` : '没有可导入持仓；请使用下方权重表手动建立组合。')
  })
  const verify = () => void run(async () => {
    if (!cashConfirmed) throw Error('请先核对现金；无现金请填0')
    const extras = JSON.parse(extra) as Pick<PortfolioVerificationInput, 'histories' | 'fundHoldings'>
    const input: PortfolioVerificationInput = { asOf, baseCurrency: baseCurrency.trim(),
      positions: positions.map((p, i) => ({ id: p.id.trim(), currency: p.currency.trim(), assetClass: p.assetClass, quantity: requiredNumber(p.quantity, `第${i + 1}项数量`), ...(p.price.trim() ? { price: requiredNumber(p.price, '价格') } : {}), ...(p.priceAsOf ? { priceAsOf: p.priceAsOf } : {}), ...(p.priceSource.trim() ? { priceSource: p.priceSource.trim() } : {}) })),
      cash: cash.map(c => ({ currency: c.currency.trim(), amount: requiredNumber(c.amount, `${c.currency}现金金额（无现金填0）`) })),
      fx: fx.map(f => ({ ...f, currency: f.currency.trim(), baseCurrency: f.baseCurrency.trim(), source: f.source.trim(), rate: requiredNumber(f.rate, `${f.currency}汇率`) })), histories: extras.histories, ...(extras.fundHoldings ? { fundHoldings: extras.fundHoldings } : {}) }
    const requestRevision = revision.current
    const result = await post<PortfolioVerificationResult>('/strategy/verify', input as unknown as Record<string, unknown>)
    if (requestRevision === revision.current) setChecked({ input, result })
  })
  const foreignCash = checked?.input.cash.some(c => c.currency !== checked.input.baseCurrency && c.amount > 0)
  return <details className="fia-research-section"><summary><strong>从持仓生成当前权重</strong> · 可选，只读授权</summary>
    <p className="fia-muted">手动填权重可直接使用下方主表。导入路径会按价格、现金与汇率核验后，再由你带入。</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <label><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)}/>本次允许只读导入持仓及取得对应行情</label>{' '}
      <Button disabled={busy || !authorized} onClick={importSnapshot}>{busy ? '处理中…' : '授权读取持仓'}</Button>
      {positions.length > 0 && <div onChangeCapture={invalidate}>
        <div className="fia-inline-actions"><label>估值日期 <input aria-label="快照估值日期" type="date" value={asOf} onChange={e => setAsOf(e.target.value)}/></label><label>核验基准币种 <input aria-label="核验基准币种" value={baseCurrency} onChange={e => setBaseCurrency(e.target.value.toUpperCase())} style={{ width: 80 }}/></label></div>
        <div style={{ overflowX: 'auto' }}><table className="fia-table"><caption>持仓与估值来源（价格使用标的原币种）</caption><thead><tr><th>标的</th><th>类别</th><th>币种</th><th>数量</th><th>价格</th><th>价格日期</th><th>来源</th></tr></thead><tbody>{positions.map((p, i) => <tr key={i}><th>{p.id}</th><td><select aria-label={`快照类别${i + 1}`} value={p.assetClass} onChange={e => setPositions(v => v.map((r, j) => j === i ? { ...r, assetClass: e.target.value } : r))}>{Object.entries(assetClassLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></td>{(['currency', 'quantity', 'price', 'priceAsOf', 'priceSource'] as const).map(key => <td key={key}><input aria-label={`${p.id} ${key}`} type={key === 'priceAsOf' ? 'date' : key === 'quantity' || key === 'price' ? 'number' : 'text'} value={p[key]} style={{ width: key === 'priceSource' ? 180 : key === 'priceAsOf' ? 140 : 90 }} onChange={e => setPositions(v => v.map((r, j) => j === i ? { ...r, [key]: e.target.value } : r))}/></td>)}</tr>)}</tbody></table></div>
        <h4>现金与汇率</h4><p className="fia-muted">导入不包含账户现金。汇率表示1单位原币兑多少基准币；日期和来源必填。</p>
        {cash.map((c, i) => <div key={i} className="fia-inline-actions"><label>现金币种 <input aria-label={`现金币种${i + 1}`} value={c.currency} style={{ width: 75 }} onChange={e => { setCashConfirmed(false); setCash(v => v.map((r, j) => j === i ? { ...r, currency: e.target.value.toUpperCase() } : r)) }}/></label><label>现金金额 <input aria-label={`现金金额${i + 1}`} type="number" min="0" value={c.amount} onChange={e => { setCashConfirmed(false); setCash(v => v.map((r, j) => j === i ? { ...r, amount: e.target.value } : r)) }}/></label>{cash.length > 1 && <Button onClick={() => { invalidate(); setCashConfirmed(false); setCash(v => v.filter((_, j) => j !== i)) }}>移除此币种现金</Button>}</div>)}
        <Button disabled={cash.length >= 10} onClick={() => { invalidate(); setCashConfirmed(false); setCash(v => [...v, { currency: '', amount: '' }]) }}>添加现金币种</Button>
        {fx.map((f, i) => <div key={i} className="fia-inline-actions">{(['currency', 'baseCurrency', 'rate', 'asOf', 'source'] as const).map(key => <label key={key}>{({ currency: '原币', baseCurrency: '基准币', rate: '汇率', asOf: '汇率日期', source: '汇率来源' })[key]} <input aria-label={`汇率${i + 1} ${key}`} value={f[key]} type={key === 'asOf' ? 'date' : key === 'rate' ? 'number' : 'text'} style={{ width: key === 'source' ? 200 : key === 'asOf' ? 140 : 90 }} onChange={e => setFx(v => v.map((r, j) => j === i ? { ...r, [key]: e.target.value } : r))}/></label>)}<Button onClick={() => { invalidate(); setFx(v => v.filter((_, j) => j !== i)) }}>移除汇率</Button></div>)}
        <Button disabled={fx.length >= 10} onClick={() => { invalidate(); setFx(v => [...v, { currency: '', baseCurrency, rate: '', asOf: '', source: '' }]) }}>补充汇率</Button>
        <details><summary>高级：历史序列与基金披露</summary><p className="fia-muted">核验估值无需填写历史JSON。基金穿透与相关性需要各自的披露、历史日期和来源。</p><textarea aria-label="组合核验输入" rows={8} style={{ width: '100%', boxSizing: 'border-box' }} value={extra} onChange={e => setExtra(e.target.value)}/></details>
        <label><input type="checkbox" checked={cashConfirmed} onChange={e => setCashConfirmed(e.target.checked)}/>我已核对以上现金（无现金已明确填0）</label>
        <div className="fia-inline-actions"><Button variant="primary" disabled={busy || !cashConfirmed} onClick={verify}>核验当前组合</Button></div>
      </div>}
    </fieldset>
    {error && <p role="alert" className="fia-error-text">{error}。保留当前输入，可修正后重试。</p>}{notice && <p role="status">{notice}</p>}
    {importGaps.length > 0 && <details><summary>读取时的待补数据（{importGaps.length}）</summary><ul>{importGaps.map((g, i) => <li key={i}>{g}</li>)}</ul></details>}
    {checked && <section><PortfolioVerificationView value={checked.result}/>{foreignCash && <p role="alert">外币现金已计入核验；策略现金栏仅支持基准币种，暂不能带入此快照。</p>}<Button variant="primary" disabled={busy || !cashConfirmed || !checked.result.canCreatePolicy || !!foreignCash} onClick={() => { try { onUse(checked.input, checked.result, cashConfirmed); setNotice('已带入当前权重。请在主表明确设置目标与风险预算。') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }}>将核验权重带入当前组合</Button></section>}
  </details>
}
