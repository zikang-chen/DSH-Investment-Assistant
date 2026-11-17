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
const familyLabel = (name: string) => name === 'WeStock' ? 'WeStock（本地 CLI）' : name

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
              <option value="default">跟随后端默认</option><option value="custom">自定义选择</option>
            </select>
          </label>
          <code className="fia-sources__code">{cap.capability}</code>
        </div>
        {selection.ids === null
          ? <p className="fia-sources__note">恢复默认已加入草稿；默认候选与顺序将在保存后由后端返回，不按「全部已选」猜测。切换自定义时，以当前已保存选择为起点。</p>
          : <p className="fia-sources__note">{selection.mode === 'default' ? '当前跟随后端默认；切换为自定义后可勾选来源。' : '取消全部勾选会停用此能力；改为「跟随后端默认」才会恢复默认候选。'} 回退序号仅供查看，保留已有顺序，新勾选的来源追加到末尾。</p>}
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
        </div> : <p className="fia-sources__note">当前目录未提供可选来源；此页不推断或自动探测新端点。</p>}
      </div>
    </details>
  }

  return <section className="fia-sources" aria-label="数据源与接口配置">
    <style data-fia-sources-styles="workspace">{sourcesWorkspaceCss}</style>
    <PageHeader title="数据与接口" eyebrow="DATA SOURCES" description="先看覆盖摘要，按需展开来源和能力。选择策略与探测健康独立显示，未探测不等于故障。"
      actions={<Button variant="primary" disabled={!state.dirty || state.saving || !state.catalog} onClick={() => void save()}>{state.saving ? '保存中…' : '保存配置'}</Button>} />
    <div className="fia-sources__toolbar">
      <div className="fia-sources__toolbar-copy">
        <StatusBadge tone={state.dirty ? 'warning' : 'neutral'}>{state.dirty ? '有未保存草稿' : state.catalog ? '与已读取配置一致' : '尚未读取配置'}</StatusBadge>
        {state.catalog && <span>{catalog.length} 项能力 · {multi.length} 项可切换来源 · {families.length} 个单来源家族</span>}
      </div>
      <div className="fia-sources__actions">
        <Button disabled={state.loading || state.saving} onClick={() => void reload()}>{state.loading ? '读取中…' : '刷新目录'}</Button>
        <Button disabled={state.saving || !state.catalog || !Object.keys(state.draft).length} onClick={() => dispatch({ type: 'defaults' })} title="仅修改草稿；保存后清除自定义策略，恢复后端默认候选">恢复全部默认</Button>
        <Button variant="ghost" disabled={state.saving || (!state.dirty && !state.pendingCatalog)} onClick={() => dispatch({ type: 'discard' })}>{state.dirty ? '放弃草稿' : '载入后台更新'}</Button>
      </div>
    </div>
    {state.error && <div className="fia-sources__feedback" data-tone="error" role="alert">{state.error} {state.catalog ? '当前目录与草稿仍保留。' : '请重试刷新目录。'}</div>}
    {state.notice && <div className="fia-sources__feedback" role="status">{state.notice}</div>}
    {state.pendingCatalog && <div className="fia-sources__feedback" data-tone="warning" role="status">已收到后台目录更新，未覆盖当前草稿。可保存草稿覆盖后台策略，或{state.dirty ? '放弃草稿' : '载入后台更新'}读取已暂存的最新目录。</div>}
    <p className="fia-sources__note">所有选择、批量开关和恢复默认都只修改草稿；仅「保存配置」会写入。刷新只读取已有目录，不发起端点探测。</p>
    {state.catalog === null && !state.error && <div className="fia-sources__feedback" role="status">正在读取本机数据源目录…</div>}
    {state.catalog?.length === 0 && <EmptyState title="暂无能力目录" description="后端未返回数据源能力；刷新可重试读取，不会修改配置。" />}
    {multi.length > 0 && <section className="fia-sources__section" aria-label="多来源能力">
      <h2 className="fia-sources__section-title">可切换来源</h2>
      <p className="fia-sources__note">每项默认仅显示摘要，展开查看候选源、启用选择及回退顺序。此页不提供排序编辑。</p>
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
              <Button disabled={state.saving || !members.some((cap) => cap.providers.length)} onClick={() => edit(setFamilySelection(state.draft, members, true))} title="将本家族全部候选源加入草稿，保存后生效">全部启用</Button>
              <Button disabled={state.saving || !members.some((cap) => cap.providers.length)} onClick={() => edit(setFamilySelection(state.draft, members, false))} title="草稿中为本家族每项能力设置空选择，保存后停用">全部停用</Button>
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
      <span>健康记录不代表实时连通性，也不改变是否已选；unknown 保留为未知。</span>
    </div>}
    {children != null && <details className="fia-sources__fold">
      <summary className="fia-sources__summary"><span className="fia-sources__summary-main">外部接口与凭证</span><span className="fia-sources__summary-meta">按需展开，独立管理整体接入状态</span></summary>
      <div className="fia-sources__body">{children}</div>
    </details>}
  </section>
}
