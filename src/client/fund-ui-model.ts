/**
 * Fund tab presentation model. Pure functions only: query normalization for GET /fundrank,
 * pagination inference from returned row counts, display formatting and row view mapping.
 *
 * No React, DOM, network, storage, portfolio or trading access, and it never computes NAV or
 * returns. Missing values stay missing — they are never coerced to zero.
 */
import { formatDate, formatNumber, formatPercent } from './design-system/format.js'

/** GET /fundrank page size used by this view. The route caps size at 50. */
export const FUND_RANK_PAGE_SIZE = 20
/** Provider clamps page size to 1..50 (src/data/providers.ts fundRankRequest); mirror it for the URL. */
export const FUND_RANK_MAX_PAGE_SIZE = 50

/** Fund NAVs are disclosed T+1; the date column is the data date, not a live quote. */
export const FUND_NAV_T1_NOTE = '基金净值按 T+1 披露：净值日期是数据日期，不是实时成交价。'
export const FUND_NAV_T1_TAG = '净值日 · T+1'
export const FUND_SEARCH_ONLY_NOTE = '请选择基金；股票请到行情页查看。'

export const FUND_TYPES = [
  { value: 'all', label: '全部' },
  { value: 'stock', label: '股票' },
  { value: 'hybrid', label: '混合' },
  { value: 'bond', label: '债券' },
  { value: 'index', label: '指数' },
  { value: 'qdii', label: 'QDII' },
] as const
export type FundType = (typeof FUND_TYPES)[number]['value']

export const FUND_SORTS = [
  { value: 'm1', label: '近1月' },
  { value: 'm3', label: '近3月' },
  { value: 'm6', label: '近6月' },
  { value: 'y1', label: '近1年' },
  { value: 'y3', label: '近3年' },
  { value: 'ytd', label: '今年来' },
] as const
export type FundSort = (typeof FUND_SORTS)[number]['value']

export const DEFAULT_FUND_TYPE: FundType = 'all'
export const DEFAULT_FUND_SORT: FundSort = 'm6'

/** Shape returned by the existing GET /fundrank route (provider fields preserved). */
export interface FundRankRow {
  code: string
  name: string
  date?: string
  nav?: number | null
  accNav?: number | null
  dayGrowth?: number | null
  w1?: number | null
  m1?: number | null
  m3?: number | null
  m6?: number | null
  y1?: number | null
  y2?: number | null
  y3?: number | null
  ytd?: number | null
}
export interface FundRankPayload { ok: boolean; rows?: FundRankRow[]; error?: string }

export interface FundRankQueryInput { type?: unknown; sort?: unknown; page?: unknown; size?: unknown }
export interface FundRankQuery { type: FundType; sort: FundSort; page: number; size: number }

export function normalizeFundType(value: unknown): FundType {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  for (const option of FUND_TYPES) if (option.value === raw) return option.value
  return DEFAULT_FUND_TYPE
}

export function normalizeFundSort(value: unknown): FundSort {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  for (const option of FUND_SORTS) if (option.value === raw) return option.value
  return DEFAULT_FUND_SORT
}

/** Page numbers are 1-based integers. Missing, non-finite, fractional or <=0 input falls back to 1. */
export function normalizeFundPage(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.trunc(parsed))
}

/** Empty/unknown size falls back to the view default; the route/provider boundary is 1..50. */
export function normalizeFundSize(value: unknown = FUND_RANK_PAGE_SIZE): number {
  if (value === undefined || value === null || value === '') return FUND_RANK_PAGE_SIZE
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return FUND_RANK_PAGE_SIZE
  return Math.min(FUND_RANK_MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed)))
}

/** The one place that builds the existing route query. Unknown type/sort never reach the URL. */
export function fundRankQuery(input: FundRankQueryInput = {}): FundRankQuery {
  return {
    type: normalizeFundType(input.type),
    sort: normalizeFundSort(input.sort),
    page: normalizeFundPage(input.page),
    size: normalizeFundSize(input.size),
  }
}

export function fundRankPath(input: FundRankQueryInput = {}): string {
  const query = fundRankQuery(input)
  return `/fundrank?type=${query.type}&size=${query.size}&sort=${query.sort}&page=${query.page}`
}

export function fundSortLabel(sort: unknown): string {
  const normalized = normalizeFundSort(sort)
  for (const option of FUND_SORTS) if (option.value === normalized) return option.label
  return '近6月'
}

export interface FundPageState {
  page: number
  size: number
  /** Zero-based row offset for the displayed rank. */
  offset: number
  count: number
  hasPrevious: boolean
  hasNext: boolean
  isEmpty: boolean
  isFirstPage: boolean
  /** A non-first page with zero rows: most likely past the last page. */
  emptyPage: boolean
  /** Human-readable page/count statement. Never claims a total row or page count. */
  status: string
}

/**
 * Pagination is inferred only from the current response: a full page means a next page may exist,
 * a short page means the end. The API returns no total, so no total is displayed.
 */
export function fundPageState(
  pageInput: unknown,
  rowCount: unknown,
  sizeInput: unknown = FUND_RANK_PAGE_SIZE,
): FundPageState {
  const page = normalizeFundPage(pageInput)
  const size = normalizeFundSize(sizeInput)
  const parsedCount = typeof rowCount === 'number' ? rowCount : Number(rowCount)
  const count = Number.isFinite(parsedCount) ? Math.max(0, Math.trunc(parsedCount)) : 0
  const isEmpty = count === 0
  const hasNext = count === size
  const emptyPage = isEmpty && page > 1
  const status = emptyPage
    ? `第 ${page} 页没有数据，可能已超过最后一页`
    : isEmpty
      ? '暂无基金排行数据'
      : hasNext
        ? `第 ${page} 页 · 本页 ${count} 条，可能还有下一页`
        : `第 ${page} 页 · 本页 ${count} 条（不足 ${size} 条，已到末页）`
  return {
    page,
    size,
    offset: (page - 1) * size,
    count,
    hasPrevious: page > 1,
    hasNext,
    isEmpty,
    isFirstPage: page === 1,
    emptyPage,
    status,
  }
}

/** 4 decimals keeps NAV precision consistent; null/undefined/NaN are unknown, not zero. */
export function formatFundNav(value: number | null | undefined): string {
  return formatNumber(value, { decimals: 4 })
}

/** Percent values arrive already in percentage points (1.23 means 1.23%). */
export function formatFundReturn(value: number | null | undefined): string {
  return formatPercent(value, { decimals: 2, signed: true })
}

export type FundReturnDirection = 'up' | 'down' | 'flat' | 'missing'

export function fundReturnDirection(value: number | null | undefined): FundReturnDirection {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'missing'
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}

const PERIOD_FIELD = { m1: 'm1', m3: 'm3', m6: 'm6', y1: 'y1', y3: 'y3', ytd: 'ytd' } as const satisfies Record<FundSort, keyof FundRankRow>

/**
 * Period return for the selected sort. Unknown sorts normalize to m6, matching the provider's
 * own fallback, so the displayed column always matches the requested sort. Missing stays undefined.
 */
export function fundPeriodReturn(row: FundRankRow | null | undefined, sort: unknown): number | undefined {
  if (!row) return undefined
  const field = PERIOD_FIELD[normalizeFundSort(sort)]
  const value = row[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Date-only upstream values are kept as calendar dates (never shifted through a timezone). */
export function fundNavDate(value: unknown): string {
  if (typeof value !== 'string') return '未注明'
  const raw = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return '未注明'
  const formatted = formatDate(raw.slice(0, 10))
  return formatted === '—' ? '未注明' : formatted
}

export function fundNavDateText(value: unknown): string {
  return `净值日期 ${fundNavDate(value)}`
}

export interface FundRowView {
  rank: number
  code: string
  name: string
  /** False when the upstream row has no usable code, so opening dossier is impossible. */
  openable: boolean
  navText: string
  navKnown: boolean
  returnText: string
  returnDirection: FundReturnDirection
  periodLabel: string
  dateText: string
  dateKnown: boolean
  t1: string
  /** Full accessible name for the row button. */
  ariaLabel: string
}

export function fundRowView(row: FundRankRow, sort: unknown, rank: number): FundRowView {
  const code = typeof row.code === 'string' ? row.code.trim() : ''
  const rawName = typeof row.name === 'string' ? row.name.trim() : ''
  const name = rawName || code || '名称未提供'
  const nav = row.nav
  const navKnown = typeof nav === 'number' && Number.isFinite(nav)
  const period = fundPeriodReturn(row, sort)
  const periodLabel = fundSortLabel(sort)
  const dateText = fundNavDate(row.date)
  const dateKnown = dateText !== '未注明'
  const returnText = formatFundReturn(period)
  const navText = formatFundNav(nav)
  const ariaLabel = [
    `打开基金资料：${name}（${code || '代码未提供'}）`,
    `单位净值 ${navText}`,
    `${periodLabel}收益 ${returnText}`,
    `${dateText}${dateKnown ? '（T+1）' : '（净值日期未提供，T+1）'}`,
  ].join('，')
  return {
    rank: Number.isFinite(rank) ? Math.max(1, Math.trunc(rank)) : 1,
    code,
    name,
    openable: code.length > 0,
    navText,
    navKnown,
    returnText,
    returnDirection: fundReturnDirection(period),
    periodLabel,
    dateText,
    dateKnown,
    t1: FUND_NAV_T1_TAG,
    ariaLabel,
  }
}

/** Page-relative 1-based ranks; drops non-object rows defensively instead of inventing data. */
export function fundRowViews(
  rows: readonly FundRankRow[] | null | undefined,
  sort: unknown,
  page: unknown,
  sizeInput: unknown = FUND_RANK_PAGE_SIZE,
): FundRowView[] {
  const list = Array.isArray(rows) ? rows.filter(row => !!row && typeof row === 'object') : []
  const { offset } = fundPageState(page, list.length, sizeInput)
  return list.map((row, index) => fundRowView(row, sort, offset + index + 1))
}
