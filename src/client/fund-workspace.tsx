import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState, PageHeader, StatusBadge } from './design-system/index.js'
import { SecuritySearch } from './security-search.js'
import type { SecurityIdentity } from './security-model.js'
import type { ReadApi } from './workbench-model.js'
import {
  FUND_NAV_T1_NOTE, FUND_RANK_PAGE_SIZE, FUND_SEARCH_ONLY_NOTE, FUND_SORTS, FUND_TYPES,
  fundPageState, fundRankPath, fundRowViews, fundSortLabel,
  type FundRankPayload, type FundRankRow, type FundSort, type FundType,
} from './fund-ui-model.js'

/**
 * Scoped design-system CSS. Rendered inside the finance root; this task's write scope has no separate styles module.
 */
const fundWorkspaceCss = `
.fia-root .fia-fund-workspace{display:grid;gap:var(--fia-space-4);min-width:0;container-type:inline-size;container-name:fia-fund}
.fia-root .fia-fund-search{display:grid;gap:var(--fia-space-2);min-width:0;padding:var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface)}
.fia-root .fia-fund-search__hint{margin:0;color:var(--fia-muted);font-size:var(--fia-font-xs);overflow-wrap:anywhere}
.fia-root .fia-fund-search__reject{margin:0;padding:var(--fia-space-2) var(--fia-space-3);border:1px solid var(--fia-warning);border-radius:var(--fia-radius-sm);background:var(--fia-warning-soft);color:var(--fia-warning);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-fund-section{min-width:0;border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface);overflow:hidden}
.fia-root .fia-fund-section__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--fia-space-2);padding:var(--fia-space-3) var(--fia-space-4);border-bottom:1px solid var(--fia-border)}
.fia-root .fia-fund-section__head h2{margin:0;color:var(--fia-text);font-size:var(--fia-font-base);font-weight:650}
.fia-root .fia-fund-section__body{display:grid;gap:var(--fia-space-3);min-width:0;padding:var(--fia-space-4)}
.fia-root .fia-fund-filters{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-fund-filters__label{color:var(--fia-muted);font-size:var(--fia-font-xs);min-width:2em}
.fia-root .fia-fund-pill{height:28px;min-height:28px;padding:0 var(--fia-space-2);font-size:var(--fia-font-xs)}
.fia-root .fia-fund-note{margin:0;color:var(--fia-muted);font-size:var(--fia-font-xs);overflow-wrap:anywhere}
.fia-root .fia-fund-message{margin:0;padding:var(--fia-space-3) var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-fund-message--error{border-color:var(--fia-danger);background:var(--fia-danger-soft);color:var(--fia-danger)}
.fia-root .fia-fund-message--actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--fia-space-2)}
.fia-root .fia-fund-skeleton{height:44px;border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);opacity:.7}
.fia-root .fia-fund-head,.fia-root .fia-fund-row{display:grid;grid-template-columns:2.25rem minmax(0,1fr) minmax(5.5rem,7rem) minmax(5.5rem,7rem) minmax(6.5rem,8rem) 3.25rem;align-items:center;gap:var(--fia-space-3);min-width:0}
.fia-root .fia-fund-head{padding:0 var(--fia-space-3);color:var(--fia-muted);font-size:var(--fia-font-xs);font-weight:600}
.fia-root .fia-fund-head [data-numeric=true]{text-align:right}
.fia-root .fia-fund-list{display:grid;gap:var(--fia-space-2);margin:0;padding:0;list-style:none;min-width:0}
.fia-root .fia-fund-list__item{min-width:0}
.fia-root .fia-fund-row{width:100%;padding:var(--fia-space-2) var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface);color:var(--fia-text);font:inherit;line-height:var(--fia-line-height);text-align:start;cursor:pointer;transition:background-color var(--fia-duration-fast),border-color var(--fia-duration-fast)}
.fia-root .fia-fund-row:hover:not(:disabled){border-color:var(--fia-brand);background:var(--fia-hover)}
.fia-root .fia-fund-row:disabled{cursor:not-allowed;opacity:.6}
.fia-root .fia-fund-row__rank{color:var(--fia-muted);font-size:var(--fia-font-xs);font-variant-numeric:tabular-nums;text-align:right}
.fia-root .fia-fund-row__fund{display:grid;gap:2px;min-width:0}
.fia-root .fia-fund-row__name{font-size:var(--fia-font-base);font-weight:650;overflow-wrap:anywhere}
.fia-root .fia-fund-row__code{color:var(--fia-muted);font-family:var(--fia-font-mono);font-size:var(--fia-font-xs);font-variant-numeric:tabular-nums}
.fia-root .fia-fund-row__metric{display:flex;flex-direction:column;gap:2px;min-width:0}
.fia-root .fia-fund-row__metric[data-numeric=true]{text-align:right}
.fia-root .fia-fund-row__value{font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums lining-nums;white-space:nowrap}
.fia-root .fia-fund-row__label{display:none;color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-fund-row__date{display:flex;flex-direction:column;gap:2px;align-items:flex-end;color:var(--fia-secondary);font-size:var(--fia-font-xs);text-align:right;white-space:nowrap}
.fia-root .fia-fund-row__date .fia-fund-row__value{font-size:var(--fia-font-xs)}
.fia-root .fia-fund-row__t1{color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-fund-row__open{color:var(--fia-brand);font-size:var(--fia-font-xs);font-weight:600;text-align:right;white-space:nowrap}
.fia-root .fia-fund-pager{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2)}
.fia-root .fia-fund-pager__status{color:var(--fia-secondary);font-size:var(--fia-font-xs);font-variant-numeric:tabular-nums}
@container fia-fund (max-width:560px){
.fia-root .fia-fund-head{display:none}
.fia-root .fia-fund-row{grid-template-columns:minmax(0,1fr);gap:var(--fia-space-2);padding:var(--fia-space-3)}
.fia-root .fia-fund-row__rank{text-align:start}
.fia-root .fia-fund-row__metric{flex-direction:row;align-items:baseline;justify-content:space-between;gap:var(--fia-space-3);text-align:start}
.fia-root .fia-fund-row__metric[data-numeric=true]{text-align:start}
.fia-root .fia-fund-row__label{display:inline}
.fia-root .fia-fund-row__date{flex-direction:row;align-items:baseline;justify-content:space-between;gap:var(--fia-space-3);text-align:start;white-space:normal}
.fia-root .fia-fund-row__open{text-align:start}
}
@media(max-width:640px){
.fia-root .fia-fund-pill{height:32px;min-height:32px}
}
`

export interface FundWorkspaceProps {
  get: ReadApi
  /** Only fund identities are forwarded; candidates of other security types are rejected in place. */
  onOpenFund: (item: SecurityIdentity) => void
  /** Parent tab visibility. `false` pauses ranking requests; omitted behaves as visible. */
  active?: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fund browser: provider-backed fund search plus the existing GET /fundrank ranking.
 * Read-only — it never adds watchlist entries or mutates holdings; the parent owns those actions.
 * NAV dates are T+1 data and are labelled as such, never presented as live prices.
 */
export function FundWorkspace({ get, onOpenFund, active }: FundWorkspaceProps) {
  const enabled = active !== false
  const [type, setType] = useState<FundType>('all')
  const [sort, setSort] = useState<FundSort>('m6')
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [rows, setRows] = useState<FundRankRow[]>([])
  const [loading, setLoading] = useState(enabled)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [searchReject, setSearchReject] = useState('')
  const sequence = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const request = ++sequence.current
    setLoading(true)
    setError('')
    setRows([])
    const path = fundRankPath({ type, sort, page, size: FUND_RANK_PAGE_SIZE })
    void get<FundRankPayload>(path).then(payload => {
      if (sequence.current !== request) return
      if (!payload || payload.ok !== true) throw new Error(payload?.error?.trim() || '基金排行暂不可用')
      setRows(Array.isArray(payload.rows) ? payload.rows : [])
      setLoaded(true)
      setLoading(false)
    }).catch((cause: unknown) => {
      if (sequence.current !== request) return
      setRows([])
      setError(errorText(cause))
      setLoaded(true)
      setLoading(false)
    })
    return () => { sequence.current++ }
  }, [enabled, get, type, sort, page, retry])

  const pageState = fundPageState(page, rows.length, FUND_RANK_PAGE_SIZE)
  const viewRows = fundRowViews(rows, sort, page, FUND_RANK_PAGE_SIZE)
  const periodLabel = fundSortLabel(sort)
  const selectType = (next: FundType) => {
    if (next === type) return
    setType(next)
    setPage(1)
  }
  const selectSort = (next: FundSort) => {
    if (next === sort) return
    setSort(next)
    setPage(1)
  }
  const reload = () => setRetry(value => value + 1)
  const openRow = (view: (typeof viewRows)[number]) => {
    if (!view.openable) return
    onOpenFund({ code: view.code, name: view.name, type: 'fund' })
  }

  return <div className="fia-fund-workspace">
    <style>{fundWorkspaceCss}</style>
    <PageHeader
      title="基金浏览"
      description="按类型与区间查看开放式基金排行；净值日期为 T+1 数据，不是实时价格。"
      actions={<Button onClick={reload} disabled={loading}>{loading ? '刷新中…' : '刷新排行'}</Button>}
    />
    <section className="fia-fund-search" aria-label="基金搜索">
      <SecuritySearch
        get={get}
        label="查找基金"
        placeholder="输入基金代码或名称片段，如：110022、沪深300、易方达"
        onQueryChange={() => setSearchReject('')}
        onSelect={item => {
          if (item.type !== 'fund') {
            setSearchReject(`${item.name ?? item.code} 不是基金候选。${FUND_SEARCH_ONLY_NOTE}`)
            return
          }
          setSearchReject('')
          onOpenFund(item)
        }}
      />
      <p className="fia-fund-search__hint">{FUND_SEARCH_ONLY_NOTE} 点击名称查看基金资料。</p>
      {searchReject && <p className="fia-fund-search__reject" role="status">{searchReject}</p>}
    </section>
    <section className="fia-fund-section" aria-label="开放式基金排行">
      <div className="fia-fund-section__head">
        <h2>开放式基金排行</h2>
        <StatusBadge tone="info" title={FUND_NAV_T1_NOTE}>T+1 净值</StatusBadge>
        {loaded && !loading && !error && <span className="fia-fund-note">本页 {rows.length} 只</span>}
      </div>
      <div className="fia-fund-section__body">
        <div className="fia-fund-filters" role="group" aria-label="基金类型">
          <span className="fia-fund-filters__label">类型</span>
          {FUND_TYPES.map(option => <Button
            key={option.value}
            className="fia-fund-pill"
            variant={type === option.value ? 'primary' : 'secondary'}
            aria-pressed={type === option.value}
            onClick={() => selectType(option.value)}
          >{option.label}</Button>)}
        </div>
        <div className="fia-fund-filters" role="group" aria-label="排序周期">
          <span className="fia-fund-filters__label">周期</span>
          {FUND_SORTS.map(option => <Button
            key={option.value}
            className="fia-fund-pill"
            variant={sort === option.value ? 'primary' : 'secondary'}
            aria-pressed={sort === option.value}
            onClick={() => selectSort(option.value)}
          >{option.label}</Button>)}
        </div>
        <p className="fia-fund-note">{FUND_NAV_T1_NOTE} 当前按「{periodLabel}」收益排序，每页最多 {FUND_RANK_PAGE_SIZE} 只。</p>
        {loading
          ? <div role="status" aria-live="polite">
            <p className="fia-fund-message">正在读取基金排行（{periodLabel} · 第 {page} 页）…</p>
            <div className="fia-fund-skeleton" aria-hidden="true" />
            <div className="fia-fund-skeleton" aria-hidden="true" />
            <div className="fia-fund-skeleton" aria-hidden="true" />
          </div>
          : error
            ? <div className="fia-fund-message fia-fund-message--error fia-fund-message--actions" role="alert">
              <span>基金排行读取失败：{error}</span>
              <Button onClick={reload}>重试</Button>
            </div>
            : rows.length === 0
              ? page > 1
                ? <EmptyState
                  title={`第 ${page} 页没有数据`}
                  description="可能已到最后一页，可返回上一页。"
                  action={<Button onClick={() => setPage(1)}>回到第一页</Button>}
                />
                : <EmptyState
                  title="暂无基金排行数据"
                  description="暂无数据，请刷新或调整类型与周期。"
                  action={<Button onClick={reload}>重试</Button>}
                />
              : <>
                <div className="fia-fund-head" aria-hidden="true">
                  <span className="fia-fund-row__rank">#</span>
                  <span>基金</span>
                  <span data-numeric="true">单位净值</span>
                  <span data-numeric="true">{periodLabel}</span>
                  <span data-numeric="true">净值日期</span>
                  <span>资料</span>
                </div>
                <ul className="fia-fund-list">
                  {viewRows.map(view => <li className="fia-fund-list__item" key={`${view.code || 'unknown'}-${view.rank}`}>
                    <button
                      type="button"
                      className="fia-fund-row"
                      aria-label={view.ariaLabel}
                      title={view.openable ? '打开基金资料' : '代码缺失，无法打开资料'}
                      disabled={!view.openable}
                      onClick={() => openRow(view)}
                    >
                      <span className="fia-fund-row__rank">{view.rank}</span>
                      <span className="fia-fund-row__fund">
                        <span className="fia-fund-row__name">{view.name}</span>
                        <code className="fia-fund-row__code">{view.code || '代码未提供'}</code>
                      </span>
                      <span className="fia-fund-row__metric" data-numeric="true">
                        <span className="fia-fund-row__label">单位净值</span>
                        <span className="fia-fund-row__value">{view.navText}</span>
                      </span>
                      <span className="fia-fund-row__metric" data-numeric="true">
                        <span className="fia-fund-row__label">{view.periodLabel}</span>
                        <span className="fia-fund-row__value fia-change" data-direction={view.returnDirection}>{view.returnText}</span>
                      </span>
                      <span className="fia-fund-row__date">
                        <span className="fia-fund-row__value">{view.dateText}</span>
                        <span className="fia-fund-row__t1">{view.t1}</span>
                      </span>
                      <span className="fia-fund-row__open">资料 →</span>
                    </button>
                  </li>)}
                </ul>
                <div className="fia-fund-pager">
                  <Button onClick={() => setPage(current => Math.max(1, current - 1))} disabled={loading || !pageState.hasPrevious}>上一页</Button>
                  <span className="fia-fund-pager__status" aria-live="polite">{pageState.status}</span>
                  <Button onClick={() => setPage(current => current + 1)} disabled={loading || !pageState.hasNext}>下一页</Button>
                </div>
                <p className="fia-fund-note">数据源：东财基金排行 · 净值 T+1 披露。</p>
              </>
        }
      </div>
    </section>
  </div>
}
