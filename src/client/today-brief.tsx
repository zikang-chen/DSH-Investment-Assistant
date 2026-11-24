/**
 * 首页「今日要点」：把今天该处理的三件事摆到最前面。
 *
 * 只做聚合与跳转，不改变任何判断：
 * - 持仓异动：来自面板已有的行情与持仓（|涨跌| ≥ 阈值），没有行情就明说没有；
 * - 待复核判断：/advice 的 dueForReview；
 * - 待整理资料：/research 的 byStatus.inbox。
 * 任一侧失败只影响该行，不合并成「加载失败」。
 */
import { createElement as h, useEffect, useState } from 'react'
import type { ReadApi } from './workbench-model.js'

export interface HoldingMove { code: string; name?: string; changePct: number }
export const MOVE_THRESHOLD = 3

/** 纯函数：从持仓与行情里挑出当日异动，按幅度降序；缺行情不算 0。 */
export function holdingMoves(
  holdings: ReadonlyArray<{ code: string; name?: string; type?: string }>,
  quoteOf: (code: string, type?: string) => { changePct?: number | null } | undefined,
  threshold = MOVE_THRESHOLD,
): HoldingMove[] {
  const rows: HoldingMove[] = []
  for (const holding of holdings) {
    const pct = quoteOf(holding.code, holding.type)?.changePct
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue
    if (Math.abs(pct) < threshold) continue
    rows.push({ code: holding.code, ...(holding.name ? { name: holding.name } : {}), changePct: pct })
  }
  return rows.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
}

export interface TodayBriefProps {
  moves: HoldingMove[]
  /** 持仓条数，用于区分「没有异动」与「没有持仓」。 */
  holdingCount: number
  /** 面板行情时间；为空表示还没有取到行情。 */
  liveAt?: string
  get: ReadApi
  onOpenQuotes: () => void
  onOpenAdvice: () => void
  onOpenResearch: () => void
}

export function TodayBrief(props: TodayBriefProps) {
  const [counts, setCounts] = useState<{ due?: number; inbox?: number; adviceError?: string; researchError?: string }>({})
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    void Promise.all([
      props.get<{ ok?: boolean; dueForReview?: number; error?: string }>('/advice?limit=1')
        .then((r) => (r.ok === false ? { adviceError: r.error || '投资判断读取失败' } : { due: Number(r.dueForReview ?? 0) }))
        .catch((error) => ({ adviceError: error instanceof Error ? error.message : String(error) })),
      props.get<{ ok?: boolean; stats?: { byStatus?: Record<string, number> }; error?: string }>('/research?status=inbox&limit=1')
        .then((r) => (r.ok === false
          ? { researchError: r.error || '资料读取失败' }
          : { inbox: Number(r.stats?.byStatus?.inbox ?? 0) }))
        .catch((error) => ({ researchError: error instanceof Error ? error.message : String(error) })),
    ]).then(([advice, research]) => { if (active) setCounts({ ...advice, ...research }) })
    return () => { active = false; controller.abort() }
  }, [props.get])

  const row = (key: string, label: string, value: string, detail: string, action: string, onClick: () => void, error?: string) =>
    h('div', { key, style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 12 } },
      h('span', { style: { fontWeight: 600, minWidth: 72 } }, label),
      error
        ? h('span', { role: 'alert', style: { color: 'var(--fia-danger)' } }, error)
        : h('span', null, value),
      h('span', { style: { color: 'var(--fia-muted)', fontSize: 11 } }, detail),
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', onClick,
        style: { padding: '1px 8px', borderRadius: 999, border: '1px solid var(--fia-border)', background: 'transparent',
          fontSize: 11, cursor: 'pointer' } }, action))

  const moveText = props.holdingCount === 0
    ? '还没有持仓'
    : props.moves.length
      ? props.moves.slice(0, 3).map((m) => `${m.name || m.code} ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`).join(' · ')
      : props.liveAt ? `持仓 ${props.holdingCount} 项，暂无 ±${MOVE_THRESHOLD}% 异动` : '行情还没取到，无法判断异动'

  return h('section', { 'aria-label': '今日要点',
    style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', marginBottom: 10,
      border: '1px solid var(--fia-border)', borderRadius: 8, background: 'var(--fia-surface)' } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
      h('strong', { style: { fontSize: 12.5 } }, '今日要点'),
      props.liveAt
        ? h('span', { style: { color: 'var(--fia-muted)', fontSize: 11 } }, `行情 ${props.liveAt.slice(5, 16).replace('T', ' ')}`)
        : h('span', { style: { color: 'var(--fia-muted)', fontSize: 11 } }, '行情未更新')),
    row('moves', '持仓异动', moveText, props.moves.length > 3 ? `另有 ${props.moves.length - 3} 只` : '', '看行情', props.onOpenQuotes),
    row('advice', '待复核判断', counts.adviceError ? '' : `${counts.due ?? '—'} 条`, counts.adviceError ? '' : '到期或已过期', '去复核', props.onOpenAdvice, counts.adviceError),
    row('research', '待整理资料', counts.researchError ? '' : `${counts.inbox ?? '—'} 条`, counts.researchError ? '' : '收件箱未归档', '去整理', props.onOpenResearch, counts.researchError),
  )
}
