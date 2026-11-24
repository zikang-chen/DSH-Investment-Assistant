import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { Button, EmptyState, PageHeader, StatusBadge } from './design-system/index.js'
import { groupBySource } from './sources-group.js'
import type { ReadApi, UsePanelBus } from './workbench-model.js'
import {
  capLabel, draftSelection, healthCounts, healthView, initialSourceDraftState,
  policyPayload, selectionSummary, setCapabilityMode, setFamilySelection,
  sourceDraftReducer, toggleProvider,
  type CapCatalog, type SourcePolicy,
} from './source-policy-model.js'
import { sourcesWorkspaceCss } from './sources-workspace-styles.js'

export type SourcePostApi = <T>(path: string, body: unknown) => Promise<T>
export interface SourcesWorkspaceProps { get: ReadApi; post: SourcePostApi; useBus: UsePanelBus; children?: ReactNode; onDirtyChange?: (dirty: boolean) => void }
interface CatalogResponse { catalog?: CapCatalog[]; ok?: boolean; error?: string }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
function responseCatalog(response: CatalogResponse): CapCatalog[] {
  if (response.ok === false || !Array.isArray(response.catalog)) throw new Error(response.error || '未收到有效的数据源目录')
  return response.catalog
}
const familyLabel = (name: string) => name === 'WeStock' ? 'WeStock' : name

/** Metadata-only reads. No endpoint probes, automatic writes, MCP changes or sorting controls. */
export function SourcesWorkspace({ get, post, useBus, children, onDirtyChange }: SourcesWorkspaceProps) {
  const [state, dispatch] = useReducer(sourceDraftReducer, initialSourceDraftState)
  const request = useRef(0)
  const mounted = useRef(false)
  const saveInFlight = useRef(false)
  // Let the shell warn before tab changes that would discard a dirty draft.
  useEffect(() => { onDirtyChange?.(state.dirty) }, [state.dirty, onDirtyChange])
  const reload = useCallback(async () => {
    const id = ++request.current
    dispatch({ type: 'load-start' })
    try {
      const catalog = responseCatalog(await get<CatalogResponse>('/providers'))
      if (mounted.current && id === request.current) dispatch({ type: 'load-success', catalog })
    } catch (error) {
      if (mounted.current && id === request.current) dispatch({ type: 'load-error', message: `读取目录失败：${errorMessage(error)}` })
    }
  }, [get])
  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; request.current++ }
  }, [reload])
  useBus((event) => { if (event.kind === 'providers' || event.kind === '__resync') void reload() })

  // This is the only write boundary. Defaults, selection and family actions only edit a draft.
  const save = async () => {
    if (!state.catalog || !state.dirty || saveInFlight.current) return
    saveInFlight.current = true
    request.current++ // invalidate reads that started before this save
    dispatch({ type: 'save-start' })
    try {
      const response = await post<CatalogResponse>('/providers', policyPayload(state.draft))
      if (response.ok !== true) throw new Error(response.error || '服务端未确认保存')
      const catalog = responseCatalog(response)
      request.current++ // also invalidate SSE reads triggered while the POST was in flight
      if (mounted.current) dispatch({ type: 'save-success', catalog })
    } catch (error) {
      if (mounted.current) dispatch({ type: 'save-error', message: `保存失败：${errorMessage(error)}` })
    } finally { saveInFlight.current = false }
  }
  const edit = (policy: SourcePolicy) => dispatch({ type: 'edit', policy })
  const catalog = state.catalog ?? []
  const multi = catalog.filter((cap) => cap.providers.length > 1)
  const single = catalog.filter((cap) => cap.providers.length <= 1)
  const byCap = new Map(single.map((cap) => [cap.capability, cap]))
  const families = groupBySource(single.map((cap) => ({ capability: cap.capability, group: cap.group, source: cap.providers[0]?.source ?? '无候选源' })))
  const providerHealth = healthCounts(catalog.flatMap((cap) => cap.providers))

  const capability = (cap: CapCatalog) => {
    const selection = draftSelection(cap, state.draft)
    const health = healthCounts(cap.providers)
    return <details key={cap.capability} className="fia-sources__fold">
      <summary className="fia-sources__summary">
        <span className="fia-sources__summary-main">{capLabel(cap)}</span>
        <span className="fia-sources__summary-meta">{selectionSummary(cap, state.draft)}</span>
        <span className="fia-sources__summary-sub">{cap.providers.length} 个候选源 · 探测可用 {health.ok} / 失败 {health.failed} / 未探测 {health.unknown}</span>
      </summary>
      <div className="fia-sources__body">
        <div className="fia-sources__mode">
          <label>调用策略
            <select aria-label={`${capLabel(cap)}调用策略`} value={selection.mode} disabled={state.saving || !cap.providers.length}
              onChange={(event) => edit(setCapabilityMode(state.draft, cap, event.target.value === 'custom' ? 'custom' : 'default'))}>
              <option value="default">使用默认来源</option><option value="custom">自定义选择</option>
            </select>
          </label>
          <code className="fia-sources__code">{cap.capability}</code>
        </div>
        {selection.ids === null
          ? <p className="fia-sources__note">默认设置待保存，保存后可查看来源与顺序。</p>
          : <p className="fia-sources__note">{selection.mode === 'default' ? '使用默认来源；切换为自定义可勾选来源。' : '取消全部勾选将停用此能力。'} 按序号依次尝试，新选来源排在末尾。</p>}
        {cap.providers.length > 0 ? <div className="fia-sources__table-wrap" role="region" aria-label={`${capLabel(cap)}候选源`} tabIndex={0}>
          <table className="fia-table fia-sources__table">
            <thead><tr><th scope="col">来源 / 端点引用</th><th scope="col">启用选择</th><th scope="col" data-numeric="true">回退序号</th><th scope="col">探测记录</th></tr></thead>
            <tbody>{cap.providers.map((provider) => {
              const health = healthView(provider.ok)
              const checked = selection.ids?.includes(provider.id) ?? false
              const rank = selection.ids?.indexOf(provider.id) ?? -1
              return <tr key={provider.id}>
                <td><div className="fia-sources__provider"><span>{provider.source}</span><code className="fia-sources__code">{provider.id}</code><code className="fia-sources__code">{provider.endpointRef || '未提供端点引用'}</code></div></td>
                <td>{selection.ids === null ? <span className="fia-sources__note">默认待确认</span>
                  : <label className="fia-sources__check"><input type="checkbox" checked={checked} disabled={state.saving || selection.mode === 'default'}
                    aria-label={`${capLabel(cap)}：${provider.source}（${provider.id}）参与调用`}
                    onChange={() => edit(toggleProvider(state.draft, cap, provider.id))} />{checked ? '已选' : '未选'}</label>}</td>
                <td data-numeric="true">{selection.ids === null ? '待确认' : rank >= 0 ? rank + 1 : '—'}</td>
                <td><StatusBadge tone={health.tone}>{health.label}</StatusBadge></td>
              </tr>
            })}</tbody>
          </table>
        </div> : <p className="fia-sources__note">暂无可选来源，请刷新目录。</p>}
      </div>
    </details>
  }

  return <section className="fia-sources" aria-label="数据源与接口配置">
    <style data-fia-sources-styles="workspace">{sourcesWorkspaceCss}</style>
    <PageHeader title="数据与接口" eyebrow="DATA SOURCES" description="查看数据覆盖与连接记录，选择需要的来源。"
      actions={<Button variant="primary" disabled={!state.dirty || state.saving || !state.catalog} onClick={() => void save()}>{state.saving ? '保存中…' : '保存配置'}</Button>} />
    <div className="fia-sources__toolbar">
      <div className="fia-sources__toolbar-copy">
        <StatusBadge tone={state.dirty ? 'warning' : 'neutral'}>{state.dirty ? '待保存' : state.catalog ? '已保存配置' : '尚未读取配置'}</StatusBadge>
        {state.catalog && <span>{catalog.length} 项能力 · {multi.length} 项可切换来源 · {families.length} 个单来源家族</span>}
      </div>
      <div className="fia-sources__actions">
        <Button disabled={state.loading || state.saving} onClick={() => void reload()}>{state.loading ? '读取中…' : '刷新目录'}</Button>
        <Button disabled={state.saving || !state.catalog || !Object.keys(state.draft).length} onClick={() => dispatch({ type: 'defaults' })} title="恢复默认来源，保存后生效">恢复全部默认</Button>
        <Button variant="ghost" disabled={state.saving || (!state.dirty && !state.pendingCatalog)} onClick={() => dispatch({ type: 'discard' })}>{state.dirty ? '放弃草稿' : '载入后台更新'}</Button>
      </div>
    </div>
    {state.error && <div className="fia-sources__feedback" data-tone="error" role="alert">{state.error} {state.catalog ? '当前目录与草稿仍保留。' : '请重试刷新目录。'}</div>}
    {state.notice && <div className="fia-sources__feedback" role="status">{state.notice}</div>}
    {state.pendingCatalog && <div className="fia-sources__feedback" data-tone="warning" role="status">已收到后台目录更新，未覆盖当前草稿。可保存草稿覆盖后台策略，或{state.dirty ? '放弃草稿' : '载入后台更新'}读取已暂存的最新目录。</div>}
    <p className="fia-sources__note">修改后点击「保存配置」生效。刷新目录可查看最新配置。</p>
    {state.catalog === null && !state.error && <div className="fia-sources__feedback" role="status">正在读取本机数据源目录…</div>}
    {state.catalog?.length === 0 && <EmptyState title="暂无能力目录" description="暂无数据源目录，请刷新重试。" />}
    {multi.length > 0 && <section className="fia-sources__section" aria-label="多来源能力">
      <h2 className="fia-sources__section-title">可切换来源</h2>
      <p className="fia-sources__note">展开选择来源，并查看尝试顺序。</p>
      {multi.map(capability)}
    </section>}
    {families.length > 0 && <section className="fia-sources__section" aria-label="单来源家族">
      <h2 className="fia-sources__section-title">单来源能力</h2>
      {families.map((family) => {
        const members = family.groups.flatMap((group) => group.caps.map((item) => byCap.get(item.capability)!))
        const chosen = members.filter((cap) => (draftSelection(cap, state.draft).ids?.length ?? 0) > 0).length
        const pending = members.filter((cap) => draftSelection(cap, state.draft).ids === null).length
        const disabled = members.filter((cap) => { const selection = draftSelection(cap, state.draft); return selection.mode === 'custom' && selection.ids?.length === 0 }).length
        return <details key={family.source} className="fia-sources__fold">
          <summary className="fia-sources__summary">
            <span className="fia-sources__summary-main">{familyLabel(family.source)}</span>
            <span className="fia-sources__summary-meta">{family.total} 项能力 · {chosen} 有已选源{disabled > 0 ? ` · ${disabled} 停用` : ''}{pending > 0 ? ` · ${pending} 默认待确认` : ''}</span>
            <span className="fia-sources__summary-sub">展开查看能力分组和批量选择</span>
          </summary>
          <div className="fia-sources__body">
            <div className="fia-sources__actions">
              <Button disabled={state.saving || !members.some((cap) => cap.providers.length)} onClick={() => edit(setFamilySelection(state.draft, members, true))} title="启用本组全部来源，保存后生效">全部启用</Button>
              <Button disabled={state.saving || !members.some((cap) => cap.providers.length)} onClick={() => edit(setFamilySelection(state.draft, members, false))} title="停用本组全部来源，保存后生效">全部停用</Button>
            </div>
            {family.groups.map((group) => <section key={group.group} className="fia-sources__group" aria-label={`${family.source} · ${group.group}`}>
              <h3 className="fia-sources__group-title">{group.group}</h3>
              {group.caps.map((item) => capability(byCap.get(item.capability)!))}
            </section>)}
          </div>
        </details>
      })}
    </section>}
    {state.catalog && <div className="fia-sources__legend" aria-label="探测记录说明">
      <span>已有探测记录：可用 {providerHealth.ok} / 失败 {providerHealth.failed} / 未探测 {providerHealth.unknown}（按能力与来源计）</span>
      <span>连接状态为上次测试记录，未测试项显示「未探测」。</span>
    </div>}
    {children != null && <details className="fia-sources__fold">
      <summary className="fia-sources__summary"><span className="fia-sources__summary-main">外部接口与凭证</span><span className="fia-sources__summary-meta">按需展开，独立管理整体接入状态</span></summary>
      <div className="fia-sources__body">{children}</div>
    </details>}
  </section>
}
