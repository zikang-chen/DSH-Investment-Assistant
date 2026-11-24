/** 只渲染标的上下文条（示例数据），用于核对紧凑布局与深色主题。 */
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { InstrumentBar, type InstrumentFocus } from '../../src/client/instrument-focus.js'

const focus: InstrumentFocus = { code: '600519', kind: 'a', name: '贵州茅台', at: Date.now() }
const noQuote: InstrumentFocus = { code: 'SPX', kind: 'global', secid: '100.SPX', name: '标普500', at: Date.now() }
const noop = () => {}
const bar = (f: InstrumentFocus, quote?: { price?: number | null; changePct?: number | null; asOf?: string }, liveAt?: string) =>
  h(InstrumentBar, { focus: f, quote, ...(liveAt ? { liveAt } : {}), onOpenChart: noop, onOpenDossier: noop, onAsk: noop, onClear: noop })

createRoot(document.getElementById('root')!).render(
  h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'system-ui, sans-serif', background: '#f3f5f7' } },
    h('div', { style: { fontSize: 12, opacity: 0.6 } }, '示例数据 · 标的上下文条（无真实持仓、无网络请求）'),
    h('div', { style: { border: '1px solid #d5dee6', borderRadius: 8, overflow: 'hidden', background: '#fff' } },
      bar(focus, { price: 1485.75, changePct: 1.24, asOf: '2026-11-24T02:30:00.000Z' })),
    h('div', { style: { border: '1px solid #d5dee6', borderRadius: 8, overflow: 'hidden', background: '#fff' } },
      bar(noQuote, undefined, '2026-11-24T03:00:00.000Z')),
  ),
)
