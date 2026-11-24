/** 首页要点与标的关联的示例渲染（固定 fixture，不发请求）。 */
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { TodayBrief } from '../../src/client/today-brief.js'
import { InstrumentRelated } from '../../src/client/instrument-related.js'

const get: any = async (path: string) => {
  if (path.startsWith('/advice')) return { ok: true, dueForReview: 2, advices: [{ adviceId: 'a1', assets: ['600519'], label: '考虑买入 · 有条件', createdAt: '2026-11-20', nextReviewAt: '2026-12-01' }] }
  if (path.startsWith('/research')) return { ok: true, count: 2, stats: { byStatus: { inbox: 7 } }, items: [
    { id: 'r1', title: '白酒渠道跟踪：批价与库存', kind: 'report', date: '2026-11-18', status: 'active' },
    { id: 'r2', title: '估值与股息率的取舍', kind: 'decision', date: '2026-11-21', status: 'inbox' },
  ] }
  return {}
}
const noop = () => {}
const frame = (children: unknown) => h('div', { style: { border: '1px solid #d5dee6', borderRadius: 8, background: '#fff', marginBottom: 12 } }, children)

createRoot(document.getElementById('root')!).render(
  h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'system-ui, sans-serif', background: '#f3f5f7' } },
    h('div', { style: { fontSize: 12, opacity: 0.6 } }, '示例数据 · 今日要点与标的关联（无真实持仓、无网络请求）'),
    frame(h(TodayBrief, {
      moves: [{ code: '600519', name: '贵州茅台', changePct: 4.2 }, { code: '510300', name: '沪深300ETF', changePct: -3.1 }],
      holdingCount: 5, liveAt: '2026-11-24T05:30:00Z', get,
      onOpenQuotes: noop, onOpenAdvice: noop, onOpenResearch: noop,
    })),
    frame(h(TodayBrief, { moves: [], holdingCount: 0, get, onOpenQuotes: noop, onOpenAdvice: noop, onOpenResearch: noop })),
    frame(h(InstrumentRelated, {
      code: '600519', name: '贵州茅台', get,
      onOpenResearch: noop, onOpenAdvice: noop, onAsk: noop, onTeam: noop,
    })),
    frame(h(InstrumentRelated, {
      code: '000001', name: '平安银行',
      get: (async (path: string) => (path.startsWith('/advice') ? { ok: false, error: '投资判断读取失败（示例）' } : { ok: true, count: 0, items: [] })) as any,
      onOpenResearch: noop, onOpenAdvice: noop, onAsk: noop,
    })),
  ),
)
