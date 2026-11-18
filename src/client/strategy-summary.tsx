import type { StrategyExperimentSuccess } from '../strategy/lab.js'
const n = (v: number) => Number.isFinite(v) ? v.toFixed(2) : '—'
export function ExperimentSummary({ result }: { result: StrategyExperimentSuccess }) {
  return <div>
    <p>{result.code} · {result.coverage.from} → {result.coverage.to} · {result.coverage.bars}根 · 未复权/CNY</p>
    <p>留出段：{result.boundary.testStart} → {result.boundary.testEnd}；固定规则，未优化参数。以下为价格模拟，非真实收益或收益预测。</p>
    <div style={{overflowX:'auto'}}><table className="fia-table"><caption>固定模板对比（收益/回撤单位%）</caption><thead><tr><th>模板</th><th>全段收益</th><th>全段回撤</th><th>留出收益</th><th>留出回撤</th><th>双倍成本留出收益</th><th>交易次数</th></tr></thead><tbody>
      {result.templates.map(t => <tr key={t.id}><th scope="row">{t.name}</th><td>{n(t.result.metrics.totalReturnPct)}</td><td>{n(t.result.metrics.maxDrawdownPct)}</td><td>{n(t.holdout.metrics.totalReturnPct)}</td><td>{n(t.holdout.metrics.maxDrawdownPct)}</td><td>{n(t.costSensitivity.holdoutMetrics.totalReturnPct)}</td><td>{t.holdout.metrics.tradeCount}</td></tr>)}
    </tbody></table></div>
    <ul>{result.gaps.map((gap,i)=><li key={i}>{gap}</li>)}</ul>
    <p>实验hash：<code style={{overflowWrap:'anywhere'}}>{result.hashes.experiment}</code></p>
  </div>
}
