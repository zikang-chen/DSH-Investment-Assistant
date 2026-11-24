/**
 * 标的关联：把「正在看的这只」连到它的资料与投资判断。
 *
 * 只做只读聚合与跳转：
 * - 资料库按 code 过滤（服务端已有 code 过滤，不在这里重新解释身份）；
 * - 投资判断按 assets 命中该代码（/advice 不支持按资产过滤，客户端筛，并在 UI 上写明
 *   「最近 N 条内命中」，不冒充全库统计）；
 * - 任一侧失败只影响该侧，不合并成一句「加载失败」。
 */
import { createElement as h, useEffect, useState } from 'react'
import type { ReadApi } from './workbench-model.js'

export interface RelatedResearchItem { id: string; title: string; kind?: string; date?: string; status?: string; summary?: string }
export interface RelatedAdviceItem { adviceId: string; assets?: string[]; label?: string; recommendation?: string; nextReviewAt?: string; createdAt?: string }

export interface RelatedState {
  research: { items: RelatedResearchItem[]; total: number; error?: string }
  advice: { items: RelatedAdviceItem[]; scanned: number; error?: string }
}

/** 资产代码大小写与后缀都要容错：600519 / 600519.SH / AAPL / aapl。 */
export function codeMatches(assets: readonly string[] | undefined, code: string): boolean {
  const target = code.trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK|US)$/, '')
  if (!target) return false
  return (assets ?? []).some((asset) => {
    const value = String(asset ?? '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK|US)$/, '')
    return value === target
  })
}

export function researchLine(item: RelatedResearchItem): string {
  return [item.date ? String(item.date).slice(0, 10) : '', item.kind ?? '', item.title].filter(Boolean).join(' · ')
}

const KIND_LABEL: Record<string, string> = {
  report: '研报', filing: '财报', note: '观点', news: '资讯', decision: '决策', learn: '学习', review: '复盘', policy: '政策', other: '其他',
}

export function InstrumentRelated(props: {
  code: string
  name?: string
  get: ReadApi
  onOpenResearch: (id: string) => void
  onOpenAdvice: (id: string) => void
  onAsk: () => void
}) {
  const { code, name, get } = props
  const [state, setState] = useState<RelatedState>({ research: { items: [], total: 0 }, advice: { items: [], scanned: 0 } })
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!code.trim()) return
    const controller = new AbortController()
    let active = true
    setBusy(true)
    setState((old) => ({ research: { ...old.research, error: undefined }, advice: { ...old.advice, error: undefined } }))
    const load = async () => {
      const [research, advice] = await Promise.all([
        get<{ ok?: boolean; items?: RelatedResearchItem[]; count?: number; error?: string }>(`/research?code=${encodeURIComponent(code)}&limit=20`)
          .then((r) => (r.ok === false ? { items: [] as RelatedResearchItem[], total: 0, error: r.error || '资料读取失败' } : { items: r.items ?? [], total: r.count ?? r.items?.length ?? 0 }))
          .catch((err) => ({ items: [] as RelatedResearchItem[], total: 0, error: err instanceof Error ? err.message : String(err) })),
        get<{ ok?: boolean; advices?: RelatedAdviceItem[]; error?: string }>('/advice?limit=50')
          .then((r) => {
            if (r.ok === false) return { items: [] as RelatedAdviceItem[], scanned: 0, error: r.error || '投资判断读取失败' }
            const all = r.advices ?? []
            return { items: all.filter((item) => codeMatches(item.assets, code)), scanned: all.length }
          })
          .catch((err) => ({ items: [] as RelatedAdviceItem[], scanned: 0, error: err instanceof Error ? err.message : String(err) })),
      ])
      if (!active) return
      setState({ research, advice })
    }
    void load().finally(() => { if (active) setBusy(false) })
    return () => { active = false; controller.abort() }
  }, [code, get, nonce])

  const title = name && name !== code ? `${name}（${code}）` : code
  const section = (heading: string, body: React.ReactNode, meta?: string) =>
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11.5, color: 'var(--fia-muted)' } },
        h('span', { style: { fontWeight: 600, color: 'var(--fia-secondary)' } }, heading),
        meta ? h('span', null, meta) : null),
      body)

  const item = (key: string, text: string, onClick: () => void) =>
    h('button', { key, type: 'button', onClick,
      style: { textAlign: 'left', border: '1px solid var(--fia-border)', background: 'transparent', borderRadius: 6,
        padding: '4px 8px', fontSize: 11.5, cursor: 'pointer', color: 'var(--fia-text)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text)

  return h('section', { 'aria-label': `${title} 关联资料与判断`,
    style: { padding: '8px 12px', borderBottom: '1px solid var(--fia-border)', background: 'var(--fia-surface-muted, var(--fia-surface))',
      display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('strong', null, `${title} 的关联`),
      busy ? h('span', { style: { color: 'var(--fia-muted)' } }, '读取中…') : null,
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', onClick: () => setNonce((n) => n + 1),
        style: { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--fia-border)', background: 'transparent', fontSize: 11, cursor: 'pointer' } }, '刷新'),
      h('button', { type: 'button', onClick: props.onAsk,
        style: { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--fia-border)', background: 'transparent', fontSize: 11, cursor: 'pointer' } }, '让 Agent 研究')),
    section('资料', state.research.error
      ? h('span', { role: 'alert', style: { color: 'var(--fia-danger)' } }, state.research.error)
      : state.research.items.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            state.research.items.slice(0, 4).map((entry) => item(entry.id, researchLine(entry) + (entry.status === 'inbox' ? '（待整理）' : ''), () => props.onOpenResearch(entry.id))))
        : h('span', { style: { color: 'var(--fia-muted)' } }, '还没有关联资料；让 Agent 收集后会出现在这里。'),
      state.research.total ? `共 ${state.research.total} 条` : undefined),
    section('投资判断', state.advice.error
      ? h('span', { role: 'alert', style: { color: 'var(--fia-danger)' } }, state.advice.error)
      : state.advice.items.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            state.advice.items.slice(0, 4).map((entry) => item(entry.adviceId,
              [entry.label, entry.createdAt ? String(entry.createdAt).slice(0, 10) : '', entry.nextReviewAt ? `复核 ${String(entry.nextReviewAt).slice(0, 10)}` : ''].filter(Boolean).join(' · '),
              () => props.onOpenAdvice(entry.adviceId))))
        : h('span', { style: { color: 'var(--fia-muted)' } },
            state.advice.scanned ? `最近 ${state.advice.scanned} 条判断里没有命中这只标的。` : '还没有投资判断。'),
      state.advice.items.length && state.advice.scanned ? `最近 ${state.advice.scanned} 条内命中 ${state.advice.items.length} 条` : undefined),
  )
}

export { KIND_LABEL }
