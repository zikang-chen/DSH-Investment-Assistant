/**
 * 标的上下文条：一次选中，全面板同一只标的。
 *
 * 参考交易终端（TradingView / dsh-trading）的做法：标的是第一类对象，图表、档案、
 * 研究、提问都围绕「当前这只」展开，而不是每切一个页面就重新找一次代码。
 *
 * 这里只做展示与跳转，不改变任何身份判断或行情取值。
 */
import { createElement as h } from 'react'
import { chartInstrument, type ChartMarket } from './chart-instrument.js'

export interface InstrumentFocus {
  code: string
  kind: ChartMarket
  name?: string
  secid?: string
  /** 最近一次选中时间，用于排序与刷新。 */
  at: number
}

export const FOCUS_STORAGE_KEY = 'fia.instrument.focus.v1'

/** 把来自持仓、行情、档案或命令的不同形状统一成一处。 */
export function normalizeFocus(input: {
  code?: unknown; kind?: unknown; type?: unknown; name?: unknown; secid?: unknown; at?: unknown
}): InstrumentFocus | undefined {
  const code = typeof input.code === 'string' ? input.code.trim() : ''
  if (!code) return undefined
  const resolved = chartInstrument({
    code,
    ...(typeof input.kind === 'string' ? { kind: input.kind } : {}),
    ...(typeof input.type === 'string' ? { type: input.type } : {}),
    ...(typeof input.secid === 'string' && input.secid.trim() ? { secid: input.secid.trim() } : {}),
    ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
  })
  return {
    code: resolved.code,
    kind: resolved.kind,
    ...(resolved.name ? { name: resolved.name } : {}),
    ...(resolved.secid ? { secid: resolved.secid } : {}),
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
  }
}

/** 行情缓存键与面板其它地方一致：股票/基金分开存。 */
export function focusQuoteKey(focus: InstrumentFocus): string {
  return `${focus.kind === 'fund' ? 'fund' : 'stock'}:${focus.code}`
}

export function focusTitle(focus: InstrumentFocus): string {
  return focus.name && focus.name !== focus.code ? `${focus.name} · ${focus.code}` : focus.code
}

export function focusStorage(): Storage | undefined {
  try {
    const storage = globalThis.localStorage
    return storage ?? undefined
  } catch { return undefined }
}

export function loadFocus(storage: Storage | undefined = focusStorage()): InstrumentFocus | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(FOCUS_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return normalizeFocus(parsed)
  } catch { return undefined }
}

export function saveFocus(focus: InstrumentFocus | undefined, storage: Storage | undefined = focusStorage()): void {
  if (!storage) return
  try {
    if (!focus) storage.removeItem(FOCUS_STORAGE_KEY)
    else storage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(focus))
  } catch { /* 隐私模式/配额满时不影响使用 */ }
}

export interface InstrumentBarProps {
  focus: InstrumentFocus
  quote?: { price?: number | null; changePct?: number | null; asOf?: string } | undefined
  /** 面板已加载的行情时间（不是报价里缺失时的兜底时间）。 */
  liveAt?: string
  onOpenChart: (focus: InstrumentFocus, mode: 'daily' | 'intraday') => void
  onOpenDossier: (focus: InstrumentFocus) => void
  onAsk: (focus: InstrumentFocus) => void
  onClear: () => void
}

/** 紧凑上下文条：一行放身份、价格、时点与四类动作。 */
export function InstrumentBar(props: InstrumentBarProps) {
  const { focus, quote, liveAt } = props
  const price = typeof quote?.price === 'number' && Number.isFinite(quote.price) ? quote.price : null
  const changePct = typeof quote?.changePct === 'number' && Number.isFinite(quote.changePct) ? quote.changePct : null
  const when = quote?.asOf ?? liveAt
  return h('div', { role: 'group', 'aria-label': '当前标的', 'data-testid': 'instrument-bar',
    style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 12px', fontSize: 12,
      borderBottom: '1px solid var(--fia-border)', background: 'var(--fia-surface)' } },
    h('span', { style: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, focusTitle(focus)),
    price === null ? null : h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 650 } }, price.toFixed(price >= 100 ? 2 : 3)),
    changePct === null ? null : h('span', {
      style: { fontVariantNumeric: 'tabular-nums', color: changePct >= 0 ? 'var(--fia-up)' : 'var(--fia-down)' },
    }, `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`),
    when ? h('span', { style: { color: 'var(--fia-muted)', fontSize: 11 } },
      `行情 ${String(when).slice(5, 16).replace('T', ' ')}`) : h('span', { style: { color: 'var(--fia-muted)', fontSize: 11 } }, '行情时点未知'),
    h('span', { style: { flex: 1 } }),
    button('K线', () => props.onOpenChart(focus, 'daily')),
    button('分时', () => props.onOpenChart(focus, 'intraday')),
    button('档案', () => props.onOpenDossier(focus)),
    button('问 Agent', () => props.onAsk(focus)),
    h('button', { type: 'button', 'aria-label': '取消当前标的', onClick: props.onClear,
      style: { border: 0, background: 'transparent', color: 'var(--fia-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1 } }, '×'))
}

function button(label: string, onClick: () => void) {
  return h('button', { type: 'button', onClick,
    style: { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--fia-border)', background: 'transparent',
      color: 'var(--fia-secondary)', cursor: 'pointer', fontSize: 11 } }, label)
}
