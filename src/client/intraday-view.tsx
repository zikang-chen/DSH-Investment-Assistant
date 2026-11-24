import { createElement as h, useEffect, useState } from 'react'
import { IntradayChart } from './intraday-chart.js'
import type { IntradaySeries } from '../data/intraday.js'

export type IntradayRead = <T>(path: string, signal?: AbortSignal) => Promise<T>
export function IntradayView({ code, kind, days, get, secid }: {
  code: string; kind: string; days: number; get: IntradayRead; secid?: string
}) {
  const identity = `${kind}:${code}:${secid ?? ''}:${days}`
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ identity: string; data?: IntradaySeries; error?: string; refreshing?: boolean }>({ identity: '' })
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let pending = false
    const load = async () => {
      if (!active || pending) return
      if (kind === 'fund') {
        setState({ identity, error: '基金是每日净值（T+1），没有分时成交价；请看净值走势。' })
        return
      }
      pending = true
      setState(old => old.identity === identity ? { ...old, refreshing: true } : { identity, refreshing: true })
      try {
        const result = await get<IntradaySeries & { ok: boolean; error?: string }>(
          `/intraday?code=${encodeURIComponent(code)}&kind=${encodeURIComponent(kind)}&days=${days}${secid ? `&secid=${encodeURIComponent(secid)}` : ''}`, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
        if (!active) return
        if (!result.ok || !result.points?.some(p => p.price !== null && Number.isFinite(p.price) && p.price > 0)) {
          throw new Error(result.error || '未取得有效分时价格')
        }
        setState({ identity, data: result })
      } catch (error) {
        if (active) setState(old => ({ identity, ...(old.identity === identity && old.data ? { data: old.data } : {}),
          error: error instanceof Error ? error.message : String(error) }))
      } finally { pending = false }
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    const visible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [code, kind, secid, days, retry, get])
  // 切换身份后的第一帧也不能显示上一标的的数据。
  const current = state.identity === identity ? state : undefined
  return h('div', null,
    current?.error ? h('div', { role: 'alert', style: { fontSize: 12, color: 'var(--fia-danger)', marginBottom: 8 } },
      `${current.data ? '更新失败，保留上次结果：' : '分时读取失败：'}${current.error} `,
      h('button', { type: 'button', onClick: () => setRetry(v => v + 1) }, '重试')) : null,
    current?.data ? h('div', null,
      h(IntradayChart, { points: current.data.points, preClose: current.data.preClose,
        kind: current.data.timezone === 'unknown' ? 'global' : current.data.kind, days, title: `${current.data.name || code} · ${days > 1 ? '5日分时' : '分时'}` }),
      h('div', { role: 'status', style: { fontSize: 11, opacity: 0.7 } },
        `${current.data.source} · 最新数据 ${current.data.points.at(-1)?.time ?? '—'} · ${current.data.timezone === 'unknown' ? '源时间（时区未核准）' : '北京时间'}${current.refreshing ? ' · 更新中' : ''}`),
      current.data.warnings?.length ? h('div', { style: { fontSize: 11, opacity: 0.7 } }, current.data.warnings.join('；')) : null)
      : !current?.error ? h('div', { role: 'status', style: { padding: 16, fontSize: 12 } }, '正在读取分时…') : null)
}
