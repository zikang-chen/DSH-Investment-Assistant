/** Pure presentation/draft model for GET/POST /providers. Never reads config or probes endpoints. */
export interface CapProvider {
  id: string
  source: string
  endpointRef: string
  ok?: boolean
  selected: boolean
}
export interface CapCatalog {
  capability: string
  selected: string[]
  hasPolicy: boolean
  providers: CapProvider[]
  label?: string
  group?: string
}
export type SourcePolicy = Record<string, string[]>

export const CAP_LABEL: Record<string, string> = {
  stock_list: 'A股列表', quote: 'A股行情', quotes_batch: '批量行情', kline: 'A股K线', indices: '指数概览', financials: '财务指标', sectors: '行业板块',
  hk_quote: '港股行情', hk_kline: '港股K线', hk_list: '港股列表', us_quote: '美股行情', us_kline: '美股K线',
  fund_quote: '基金净值', fund_kline: '基金走势', fund_rank: '基金排行', fund_holdings: '基金重仓',
  etf_overview: 'ETF概览', etf_nav: 'ETF净值', etf_holdings: 'ETF重仓', macro: '宏观', news_flash: '市场快讯',
  stock_news: '个股新闻', research_report: '券商研报', symbol_search: '代码解析', stock_info: '个股档案', web_search: '网页搜索',
}
export const capLabel = (cap: CapCatalog): string => CAP_LABEL[cap.capability] ?? cap.label ?? cap.capability
const owns = (policy: SourcePolicy, cap: string) => Object.prototype.hasOwnProperty.call(policy, cap)
const clonePolicy = (policy: SourcePolicy): SourcePolicy => Object.fromEntries(Object.entries(policy).map(([cap, ids]) => [cap, [...ids]]))

/** GET catalog.selected is the real effective order; providers[] is NOT the priority order. */
export function catalogPolicy(catalog: CapCatalog[]): SourcePolicy {
  return Object.fromEntries(catalog.filter((cap) => cap.hasPolicy).map((cap) => [cap.capability, [...cap.selected]]))
}
export function samePolicy(left: SourcePolicy, right: SourcePolicy): boolean {
  const a = Object.keys(left).sort(), b = Object.keys(right).sort()
  return a.length === b.length && a.every((cap, index) => cap === b[index]
    && left[cap]!.length === right[cap]!.length
    && left[cap]!.every((id, rank) => id === right[cap]![rank]))
}

export interface DraftSelection {
  mode: 'default' | 'custom'
  /** null: the API does not expose the default order beneath an existing custom policy. */
  ids: string[] | null
}
export function draftSelection(cap: CapCatalog, draft: SourcePolicy): DraftSelection {
  if (owns(draft, cap.capability)) return { mode: 'custom', ids: [...draft[cap.capability]!] }
  return { mode: 'default', ids: cap.hasPolicy ? null : [...cap.selected] }
}
export function setCapabilityMode(draft: SourcePolicy, cap: CapCatalog, mode: 'default' | 'custom'): SourcePolicy {
  const next = clonePolicy(draft)
  if (mode === 'default') delete next[cap.capability]
  else if (!owns(next, cap.capability)) next[cap.capability] = [...cap.selected]
  return next
}
/** Keep existing priority, append newly checked providers; no invented sorting UI. */
export function toggleProvider(draft: SourcePolicy, cap: CapCatalog, id: string): SourcePolicy {
  if (!cap.providers.some((provider) => provider.id === id)) return draft
  const current = draftSelection(cap, draft).ids
  if (current === null) return draft // restoring defaults: do not guess the hidden fallback order
  return { ...clonePolicy(draft), [cap.capability]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] }
}
export function setFamilySelection(draft: SourcePolicy, members: CapCatalog[], enabled: boolean): SourcePolicy {
  const next = clonePolicy(draft)
  for (const cap of members) {
    if (!cap.providers.length) continue
    const ids = cap.providers.map((provider) => provider.id)
    const current = draftSelection(cap, draft).ids ?? cap.selected
    next[cap.capability] = enabled ? [...current.filter((id) => ids.includes(id)), ...ids.filter((id) => !current.includes(id))] : []
  }
  return next
}
/** Full replacement payload: absent key = use defaults; explicit [] = disable that capability.
 * Contract: server-routes POST /providers -> registry.setPolicy/effectiveOrder.
 */
export function policyPayload(draft: SourcePolicy): { policy: SourcePolicy } {
  return { policy: clonePolicy(draft) }
}
export function healthView(ok: boolean | undefined): { label: string; tone: 'success' | 'warning' | 'neutral'; state: 'ok' | 'failed' | 'unknown' } {
  return ok === true ? { label: '探测可用', tone: 'success', state: 'ok' }
    : ok === false ? { label: '探测失败', tone: 'warning', state: 'failed' }
      : { label: '未探测 · unknown', tone: 'neutral', state: 'unknown' }
}
export function healthCounts(providers: CapProvider[]) {
  return providers.reduce((counts, provider) => {
    counts[healthView(provider.ok).state]++
    return counts
  }, { ok: 0, failed: 0, unknown: 0 })
}
export function selectionSummary(cap: CapCatalog, draft: SourcePolicy): string {
  const selection = draftSelection(cap, draft)
  if (selection.ids === null) return '待保存恢复默认'
  if (!cap.providers.length) return '无候选源'
  if (!selection.ids.length) return selection.mode === 'custom' ? '已停用 · 0 源' : '默认 · 暂无调用候选'
  return `${selection.mode === 'default' ? '默认' : '自定义'} · ${selection.ids.length}/${cap.providers.length} 源已选`
}

export interface SourceDraftState {
  /** Saved snapshot stays stable while dirty; incoming snapshots are held separately. */
  catalog: CapCatalog[] | null
  baseline: SourcePolicy
  draft: SourcePolicy
  dirty: boolean
  loading: boolean
  saving: boolean
  pendingCatalog: CapCatalog[] | null
  error: string
  notice: string
}
export const initialSourceDraftState: SourceDraftState = {
  catalog: null, baseline: {}, draft: {}, dirty: false, loading: false, saving: false,
  pendingCatalog: null, error: '', notice: '',
}
export type SourceDraftAction =
  | { type: 'load-start' }
  | { type: 'load-success'; catalog: CapCatalog[] }
  | { type: 'load-error'; message: string }
  | { type: 'edit'; policy: SourcePolicy }
  | { type: 'defaults' }
  | { type: 'discard' }
  | { type: 'save-start' }
  | { type: 'save-success'; catalog: CapCatalog[] }
  | { type: 'save-error'; message: string }

function applyCatalog(state: SourceDraftState, catalog: CapCatalog[]): SourceDraftState {
  const baseline = catalogPolicy(catalog)
  return { ...state, catalog, baseline, draft: clonePolicy(baseline), dirty: false, pendingCatalog: null, error: '' }
}
/** SSE/refetch must never replace an unsaved draft. Pure reducer also supports offline tests. */
export function sourceDraftReducer(state: SourceDraftState, action: SourceDraftAction): SourceDraftState {
  switch (action.type) {
    case 'load-start': return { ...state, loading: true, error: '' }
    case 'load-success':
      if (state.dirty || state.saving) return { ...state, loading: false, pendingCatalog: action.catalog, error: '' }
      return { ...applyCatalog(state, action.catalog), loading: false }
    case 'load-error': return { ...state, loading: false, error: action.message }
    case 'edit':
      if (state.saving || !state.catalog) return state
      return { ...state, draft: clonePolicy(action.policy), dirty: !samePolicy(action.policy, state.baseline), error: '', notice: '' }
    case 'defaults':
      if (state.saving || !state.catalog) return state
      return { ...state, draft: {}, dirty: !samePolicy({}, state.baseline), error: '', notice: '默认设置已放入草稿，点击「保存配置」才会生效。' }
    case 'discard':
      if (state.saving || !state.catalog) return state
      return { ...applyCatalog(state, state.pendingCatalog ?? state.catalog), loading: state.loading, notice: '已放弃草稿并载入最新已读取配置。' }
    case 'save-start': return { ...state, saving: true, loading: false, error: '', notice: '' }
    case 'save-success': return { ...applyCatalog(state, action.catalog), saving: false, loading: false, notice: '已保存，后续调用按此配置生效。' }
    case 'save-error': return { ...state, saving: false, loading: false, error: action.message, notice: '草稿已保留，可重试保存。' }
  }
}
