import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './design-system/index.js'
import { KlineChart } from './kline-chart.js'
import type { RawBar } from './kline-math.js'
import type { ChartTarget } from './chart-navigation.js'
import type { ReadApi } from './workbench-model.js'

/** Overseas identities retain secid instead of falling into the domestic history endpoint. */
export function GlobalSecurityChart({ target, get }: { target: ChartTarget; get: ReadApi }) {
  const [bars, setBars] = useState<RawBar[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const pending = useRef(false)
  const load = useCallback(async () => {
    if (!target.secid || pending.current) return
    const id = ++seq.current
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await get<{ ok?: boolean; bars?: RawBar[]; error?: string }>(`/global/kline?secid=${encodeURIComponent(target.secid)}&limit=500`)
      if (seq.current !== id) return
      if (result.ok === false) throw new Error(result.error || '海外K线取数失败')
      setBars(result.bars ?? [])
    } catch (err) { if (seq.current === id) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (seq.current === id) { pending.current = false; setBusy(false) } }
  }, [get, target.secid])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 90_000)
    return () => { seq.current++; pending.current = false; clearInterval(timer) }
  }, [load])
  return <section className="fia-research-section" data-testid="global-security-chart">
    <header className="fia-section-heading"><h3>{target.name || target.code} · {target.market || '海外市场'}</h3><Button disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '刷新走势'}</Button></header>
    <p className="fia-muted">{target.secid} · 最多500根 · 上游可能延迟，不是逐笔实时数据</p>
    {error && <p role="alert" className="fia-error-text">{error}（若有旧图则保留，不冒充最新）</p>}
    {bars.length ? <KlineChart bars={bars} title={`${target.name || target.code} · ${target.secid}`} /> : <p role="status">{busy ? '正在读取K线…' : '未取得有效历史数据'}</p>}
  </section>
}
