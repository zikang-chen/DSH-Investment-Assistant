import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './design-system/index.js'
import { MarketChart } from './market-chart.js'
import type { RawBar } from './kline-math.js'
import type { ChartTarget } from './chart-navigation.js'
import type { ReadApi } from './workbench-model.js'

/** Overseas identities retain secid instead of falling into the domestic history endpoint. */
export function GlobalSecurityChart({ target, get }: { target: ChartTarget; get: ReadApi }) {
  const [state, setState] = useState<{ secid?: string; bars: RawBar[]; error?: string; busy?: boolean; updatedAt?: string }>({ bars: [] })
  const seq = useRef(0)
  const pending = useRef(false)
  const load = useCallback(async () => {
    if (!target.secid || pending.current) return
    const id = ++seq.current
    pending.current = true
    setState(old => ({ secid: target.secid, bars: old.secid === target.secid ? old.bars : [], busy: true }))
    try {
      const result = await get<{ ok?: boolean; bars?: RawBar[]; error?: string }>(`/global/kline?secid=${encodeURIComponent(target.secid)}&limit=500`)
      if (seq.current !== id) return
      if (result.ok === false) throw new Error(result.error || 'K线读取失败')
      setState({ secid: target.secid, bars: result.bars ?? [], updatedAt: new Date().toISOString() })
    } catch (err) { if (seq.current === id) setState(old => ({ ...old, busy: false, error: err instanceof Error ? err.message : String(err) })) }
    finally { if (seq.current === id) pending.current = false }
  }, [get, target.secid])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 90_000)
    return () => { seq.current++; pending.current = false; clearInterval(timer) }
  }, [load])
  const current = state.secid === target.secid ? state : undefined
  return <section className="fia-research-section" data-testid="global-security-chart">
    <header className="fia-section-heading"><h3>{target.name || target.code} · {target.market || '海外市场'}</h3><Button disabled={current?.busy} onClick={() => void load()}>{current?.busy ? '读取中…' : '刷新'}</Button></header>
    <MarketChart code={target.code} kind={target.kind} secid={target.secid} name={target.name} get={get}
      bars={current?.bars ?? []} loading={current?.busy} error={current?.error} updatedAt={current?.updatedAt} onRetry={() => void load()} />
  </section>
}
