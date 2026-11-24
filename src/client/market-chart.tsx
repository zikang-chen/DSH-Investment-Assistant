import { useEffect, useRef, useState } from 'react'
import { Button } from './design-system/index.js'
import { KlineChart, type KlineMarker } from './kline-chart.js'
import { IntradayView, type IntradayRead } from './intraday-view.js'
import { chartInstrument } from './chart-instrument.js'
import { GoldProxyChart } from './gold-proxy-chart.js'
import type { RawBar } from './kline-math.js'
export type ChartMode = 'daily' | 'intraday1' | 'intraday5'

/** 所有入口共用周期切换与市场身份；日K日期和分钟时刻分别展示，不互相补造。 */
export function MarketChart(props: {
  code: string; kind?: string; secid?: string; name?: string; bars: RawBar[]; markers?: KlineMarker[]
  get: IntradayRead; height?: number; loading?: boolean; error?: string; updatedAt?: string
  onRetry?: () => void; onModeChange?: (mode: ChartMode) => void
}) {
  const target = chartInstrument(props)
  const identity = `${target.kind}:${target.code}:${target.secid ?? ''}`
  const [selection, setSelection] = useState<{ identity: string; mode: ChartMode }>({ identity, mode: 'daily' })
  const mode = selection.identity === identity ? selection.mode : 'daily'
  const onMode = useRef(props.onModeChange); onMode.current = props.onModeChange
  useEffect(() => { onMode.current?.(mode) }, [mode, identity])
  const [retry, setRetry] = useState(0)
  const [exchange, setExchange] = useState<{ identity: string; bars: RawBar[]; error?: string; busy?: boolean }>({ identity: '', bars: [] })
  // 基金档案里的场内ETF不能把NAV蜡烛当交易价，独立取场内日K。
  const exchangeFund = props.kind === 'fund' && target.kind === 'a'
  useEffect(() => {
    if (!exchangeFund || mode !== 'daily') return
    const controller = new AbortController()
    let live = true
    setExchange({ identity, bars: [], busy: true })
    void props.get<{ ok: boolean; bars?: RawBar[]; error?: string }>(`/global/kline?secid=${encodeURIComponent(target.secid!)}&limit=500`, controller.signal)
      .then(r => { if (live) setExchange({ identity, bars: r.bars ?? [], error: r.ok === false ? r.error || '场内日K读取失败' : undefined }) })
      .catch(error => { if (live) setExchange({ identity, bars: [], error: error instanceof Error ? error.message : String(error) }) })
    return () => { live = false; controller.abort() }
  }, [exchangeFund, identity, mode, props.get, retry])
  const currentExchange = exchange.identity === identity ? exchange : undefined
  const bars = exchangeFund ? currentExchange?.bars ?? [] : props.bars
  const error = exchangeFund ? currentExchange?.error : props.error
  const loading = exchangeFund ? currentExchange?.busy : props.loading
  const fundNav = target.kind === 'fund'
  return <div data-testid="market-chart" data-chart-identity={identity} style={{ minWidth: 0 }}>
    <div role="group" aria-label="走势图周期" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
      {([['daily', fundNav ? '净值' : 'K线'], ['intraday1', '分时'], ['intraday5', '5日分时']] as const).map(([value, label]) => <Button key={value}
        aria-pressed={mode === value} disabled={fundNav && value !== 'daily'}
        title={fundNav && value !== 'daily' ? '场外基金按日披露净值' : label}
        variant={mode === value ? 'primary' : 'ghost'}
        onClick={() => setSelection({ identity, mode: value })}>{label}</Button>)}
      {exchangeFund && <span className="fia-muted">场内价格</span>}
    </div>
    {mode === 'daily' ? <>
      {error ? <div role="alert" className="fia-notice fia-notice--error">{error} <Button onClick={() => { setRetry(n => n + 1); props.onRetry?.() }}>重试</Button></div> : null}
      {error && target.secid === '101.GC00Y' && !bars.length ? <GoldProxyChart key={identity} get={props.get} height={props.height} /> : null}
      {bars.length ? <>
        <KlineChart key={identity} bars={bars} markers={exchangeFund ? [] : props.markers} height={props.height} title={`${props.name || target.code} ${fundNav ? '净值' : 'K线'}`} />
        <div className="fia-muted" style={{ fontSize: 11, marginTop: 4 }}>最新{fundNav ? '净值日' : '交易日'} {bars.at(-1)!.date.slice(0, 10)}{props.updatedAt ? ` · 更新 ${displayChartTime(props.updatedAt)}` : ''}</div>
      </> : !error ? <p role="status" className="fia-muted">{loading ? '正在读取K线…' : '暂无日K，可切换分时查看。'}</p> : null}
    </> : <IntradayView key={`${identity}:${mode}`} code={target.code} kind={target.kind} secid={target.secid}
      days={mode === 'intraday5' ? 5 : 1} get={props.get} />}
  </div>
}
export function displayChartTime(value: string): string {
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time) + '（北京时间）' : value
}
