import { useEffect, useState } from 'react'
import { Button } from './design-system/index.js'
import { KlineChart } from './kline-chart.js'
import type { IntradayRead } from './intraday-view.js'
import type { GlobalKlineResult } from '../data/global-quotes.js'

/** A CFD is a different instrument, not a silent replacement for COMEX futures. */
export function isGoldProxy(result: GlobalKlineResult): boolean {
  return result.ok && Array.isArray(result.bars) && result.bars.length > 0 && result.source === 'sina-global-futures'
    && result.instrument?.proxy === true && result.instrument.kind === 'cfd'
    && result.instrument.name === '纽约黄金CFD' && result.instrument.unit === 'USD/troy oz'
    && result.instrument.requestedSecid === '101.GC00Y' && result.instrument.symbol === 'GC'
}

/** Only mounted on an explicit failure; no request until the user chooses this separate chart. */
export function GoldProxyChart(props: { get: IntradayRead; height?: number }) {
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ busy?: boolean; result?: GlobalKlineResult; error?: string }>({})
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let live = true
    const timer = setTimeout(() => controller.abort(new Error('黄金CFD参考图读取超时')), 20_000)
    setState({ busy: true })
    void props.get<GlobalKlineResult>('/global/gold-cfd?limit=500', controller.signal)
      .then(result => {
        if (!live) return
        setState(isGoldProxy(result) ? { result } : { error: result.error || '未取得已标明口径的黄金CFD数据' })
      })
      .catch(error => { if (live) setState({ error: error instanceof Error ? error.message : String(error) }) })
      .finally(() => clearTimeout(timer))
    return () => { live = false; clearTimeout(timer); controller.abort() }
  }, [open, retry, props.get])
  if (!open) return <Button onClick={() => setOpen(true)}>查看纽约黄金CFD参考图（非COMEX期货）</Button>
  return <section aria-label="纽约黄金CFD参考图" style={{ marginTop: 8 }}>
    <div className="fia-notice" role="note">纽约黄金CFD · 新浪 · 美元/金衡盎司。不是COMEX期货，不能替代期货结算价或用于合约回测。
      <Button onClick={() => setOpen(false)}>收起参考图</Button>
    </div>
    {state.busy ? <p role="status">正在读取黄金CFD参考走势…</p> : null}
    {state.error ? <div role="alert">{state.error} <Button onClick={() => setRetry(value => value + 1)}>重试参考图</Button></div> : null}
    {state.result ? <>
      <KlineChart bars={state.result.bars} height={props.height} title="纽约黄金CFD · 参考走势（非COMEX期货）" />
      <p className="fia-muted">源数据日期 {state.result.bars.at(-1)?.date} · 日内最后一根可能未收盘；成交量缺失显示 —。</p>
      {state.result.warnings?.map((warning, index) => <p className="fia-muted" key={index}>{warning}</p>)}
    </> : null}
  </section>
}
