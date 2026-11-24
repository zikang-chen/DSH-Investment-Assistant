import type { PortfolioPolicyResult } from '../strategy/portfolio-policy.js'
import type { PortfolioVerificationResult } from '../strategy/portfolio-verification.js'
import type { PortfolioBacktestResult } from '../strategy/portfolio-backtest.js'
import { assetClassLabels, policyResultHeading, portfolioCheckLabel } from './portfolio-product.js'
const pct = (v: number | undefined | null) => v === undefined || v === null ? '—' : `${(v * 100).toFixed(2)}%`
const amount = (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const delta = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}`
function message(text: string): string {
  if (text === 'current weights plus cashWeight must sum to 1 (no normalization)') return '当前权重与当前现金须合计100%'
  if (text === 'target weights plus targetCashWeight must sum to 1 (no normalization)') return '目标权重与目标现金须合计100%'
  if (text === 'FX rates, asset values, liquidity, transaction costs and execution feasibility are not verified.') return '汇率、资产估值、流动性、交易费用与税费尚未核验'
  const price = text.match(/^(.*): (missing|future|stale) priceAsOf$/)
  if (price) return `${price[1]}：${({ missing: '补充估值日期', future: '估值日期晚于复核日', stale: '估值日期已超过30天' })[price[2] as 'missing' | 'future' | 'stale']}`
  return text
}
function RawResult({ value }: { value: unknown }) { return <details><summary>查看完整数据与计算口径</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 500, overflow: 'auto' }}>{JSON.stringify(value, null, 2)}</pre></details> }
export function PortfolioResult({ value: r }: { value: PortfolioPolicyResult }) {
  const failed = r.constraintChecks?.filter(c => !c.satisfied) ?? []
  return <div data-testid="portfolio-policy-result">
    <p role={!r.ok || r.status === 'BLOCKED' ? 'alert' : 'status'}><strong>{policyResultHeading(r)}</strong> · 纸面情景</p>
    {r.errors.length > 0 && <ul>{r.errors.map((e, i) => <li key={i}>{message(e)}</li>)}</ul>}
    {r.current && r.target && <>
      <table className="fia-table"><caption>当前组合 → 目标情景（集中度含现金）</caption><thead><tr><th>指标</th><th>当前</th><th>目标</th></tr></thead><tbody><tr><th>第一大权重</th><td>{pct(r.current.top1)}</td><td>{pct(r.target.top1)}</td></tr><tr><th>集中度HHI</th><td>{r.current.hhi.toFixed(4)}</td><td>{r.target.hhi.toFixed(4)}</td></tr><tr><th>现金</th><td>{pct(r.current.cash)}</td><td>{pct(r.target.cash)}</td></tr><tr><th>单次换手（含现金）</th><td>—</td><td>{pct(r.turnover)}</td></tr></tbody></table>
      <details><summary>资产类别与币种暴露</summary>{(['assetClassWeights', 'currencyWeights'] as const).map(key => <table className="fia-table" key={key}><caption>{key === 'currencyWeights' ? '计价币种暴露（含基准币现金）' : '资产类别（不含现金）'}</caption><thead><tr><th>分类</th><th>当前</th><th>目标</th></tr></thead><tbody>{[...new Set([...Object.keys(r.current![key]), ...Object.keys(r.target![key])])].map(k => <tr key={k}><th>{key === 'assetClassWeights' ? assetClassLabels[k] ?? k : k}</th><td>{pct(r.current![key][k] ?? 0)}</td><td>{pct(r.target![key][k] ?? 0)}</td></tr>)}</tbody></table>)}</details>
    </>}
    {failed.length > 0 && <section><h4>先调整这些预算项</h4><table className="fia-table"><thead><tr><th>约束</th><th>目标情景</th><th>要求</th></tr></thead><tbody>{failed.map((c, i) => <tr key={i}><th>{portfolioCheckLabel(c)}</th><td>{pct(c.actual)}</td><td>{c.min !== undefined ? `至少${pct(c.min)}` : ''}{c.min !== undefined && c.max !== undefined ? '，' : ''}{c.max !== undefined ? `不超过${pct(c.max)}` : ''}</td></tr>)}</tbody></table></section>}
    {r.drifts && <div style={{ overflowX: 'auto' }}><table className="fia-table"><caption>权重变化预览 · 目标减当前，单位为百分点</caption><thead><tr><th>资产</th><th>当前</th><th>目标</th><th>变化</th></tr></thead><tbody>{r.drifts.map(d => <tr key={d.id}><th>{d.id}</th><td>{pct(d.currentWeight)}</td><td>{pct(d.targetWeight)}</td><td>{delta(-d.drift)}</td></tr>)}{r.current && r.target && <tr><th>现金</th><td>{pct(r.current.cash)}</td><td>{pct(r.target.cash)}</td><td>{delta(r.target.cash - r.current.cash)}</td></tr>}</tbody></table></div>}
    {r.triggers.length > 0 && <section><h4>复核触发</h4><ul>{r.triggers.filter(t => t.kind !== 'constraintBreach').map((t, i) => <li key={i}>{t.kind === 'due' ? '已到复核周期，或尚无上次复核记录' : t.kind === 'drift' ? `${t.detail === 'cash' ? '现金' : t.detail}偏离达到阈值` : t.detail}</li>)}</ul></section>}
    {r.gaps.length > 0 && <section><h4>待补数据与成本</h4><ul>{r.gaps.map((g, i) => <li key={i}>{message(g)}</li>)}</ul></section>}
    {r.ok && <p className="fia-muted">{r.proposed ? '可保存为草案，再提交审阅和批准纸面跟踪。' : failed.length ? '修改目标或预算后重新检查；也可保留为待修改草案。' : '补齐估值日期后重新检查，才可进入纸面批准。'} 本次只比较权重，未计入交易费用、税费与成交限制。</p>}
  </div>
}
export function PortfolioVerificationView({ value: r }: { value: PortfolioVerificationResult }) {
  return <div data-testid="portfolio-verification-result"><p role={r.valid ? 'status' : 'alert'}><strong>{!r.valid ? '核验输入待修正' : r.completeValuation ? '估值范围已覆盖' : '估值尚有缺口'}</strong> · {r.asOf} · {r.baseCurrency}</p>
    <p>{r.completeValuation ? '核验范围估值' : '仅已知部分估值'}：{amount(r.pricedKnownValue)} {r.baseCurrency}{!r.completeValuation && '（不能视为组合总额）'}</p>
    {r.errors.length > 0 && <ul>{r.errors.map((e, i) => <li key={i}>{message(e)}</li>)}</ul>}
    {r.unknownAssets.length > 0 && <table className="fia-table"><caption>补齐后重新核验</caption><thead><tr><th>未覆盖项目</th><th>币种</th><th>缺口</th></tr></thead><tbody>{r.unknownAssets.map((a, i) => <tr key={i}><th>{a.id}</th><td>{a.currency}</td><td>{a.reasons.join('；')}</td></tr>)}</tbody></table>}
    {r.weights && <table className="fia-table"><caption>含现金当前权重</caption><thead><tr><th>项目</th><th>币种</th><th>折算价值</th><th>权重</th></tr></thead><tbody>{r.weights.map((w, i) => <tr key={i}><th>{w.id}</th><td>{w.currency}</td><td>{amount(w.value)}</td><td>{pct(w.weight)}</td></tr>)}</tbody></table>}
    {r.currencyExposures && <p>币种暴露：{r.currencyExposures.map(c => `${c.currency} ${pct(c.weight)}`).join(' · ')}</p>}
    <p className="fia-muted">价格覆盖 {r.provenance.prices.filter(p => p.accepted).length}/{r.provenance.prices.length} · 可用汇率 {r.provenance.fx.filter(f => f.accepted).length}/{r.provenance.fx.length} · {r.covariance ? `${r.covariance.currency}同币种相关性：${r.covariance.observations}个日收益样本` : '相关性数据未就绪'}</p>
    {r.fundCoverage.length > 0 && <table className="fia-table"><caption>基金披露覆盖（未披露部分保持未知）</caption><thead><tr><th>基金</th><th>披露日期</th><th>已披露</th><th>未知</th></tr></thead><tbody>{r.fundCoverage.map(f => <tr key={f.fundId}><th>{f.fundId}</th><td>{f.asOf ?? '缺失'}</td><td>{pct(f.disclosedWeight)}</td><td>{pct(f.unknownWeight)}</td></tr>)}</tbody></table>}
    {r.gaps.length > 0 && <details open={!r.completeValuation}><summary>数据覆盖与待补项（{r.gaps.length}）</summary><ul>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></details>}
    <RawResult value={r}/>
  </div>
}
export function PortfolioBacktestView({ value: r }: { value: PortfolioBacktestResult }) {
  return <div data-testid="portfolio-backtest-result"><p role={r.ok ? 'status' : 'alert'}><strong>{!r.ok ? '回测未完成' : r.completeAccounting ? '纸面回测完成 · 输入声明口径齐备' : '纸面回测完成 · 部分口径'}</strong></p>
    {r.errors.length > 0 && <ul>{r.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    {r.metrics && <table className="fia-table"><caption>{r.coverage.actualStart} — {r.coverage.actualEnd} · {r.coverage.commonBars}个共同价格日</caption><tbody><tr><th>纸面区间收益</th><td>{pct(r.metrics.returnRate)}</td><th>最大回撤</th><td>{pct(r.metrics.maxDrawdown)}</td></tr><tr><th>期末权益</th><td>{amount(r.metrics.finalEquity)}</td><th>模拟成交次数</th><td>{r.metrics.tradeCount}</td></tr><tr><th>费用</th><td>{amount(r.metrics.fees)}</td><th>税费</th><td>{amount(r.metrics.taxes)}</td></tr></tbody></table>}
    <p className="fia-muted">按输入价格、汇率及税费假设计算；外部来源未核验，不能称完整总回报。</p>{r.gaps.length > 0 && <ul>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>}<RawResult value={r}/>
  </div>
}
