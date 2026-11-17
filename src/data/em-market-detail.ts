/**
 * A 股资金流与公司事件详情（东方财富公开接口，纯模块）。
 *
 * 本模块**不注册 provider、不读持仓、不写文件**，只做「构造 URL → 注入式抓取 →
 * 纯函数规范化」。所有抓取入口都以 `fetch` / `json` 注入，默认用全局 fetch +
 * JSON.parse；测试全部使用 fixture 离线跑，不触网。
 *
 * 契约核实状态（2026-11-17 实测，样本 600519 / 300750 / 000001 / 603596）：
 *  - 资金流 push2his fflow/daykline：可用，需 ut token；15 列 CSV。
 *    列序用求和关系核验：主力净额 = 大单净额 + 超大单净额、
 *    主力占比 = 大单占比 + 超大单占比；末两列 f64/f65 实测恒为 0，未映射。
 *  - 公司公告 np-anotice-stock：可用；`notice_date` 为公告日，`display_time`
 *    为展示时间（含毫秒段，格式 `YYYY-MM-DD HH:mm:ss:SSS`），两者分列保留。
 *  - 分红送配 RPT_SHAREBONUS_DET：可用。`PRETAX_BONUS_RMB` 实测为每 10 股
 *    税前派息（如 600519 “10派280.2423元” → 280.2423），`BONUS_RATIO` /
 *    `IT_RATIO` 为每 10 股送股/转增，`DIVIDENT_RATIO` 为小数股息率
 *    （0.0231 = 2.31%），均未换算、未补 0。
 *  - 业绩预告 RPT_PUBLIC_OP_NEWPREDICT、业绩快报 RPT_FCI_PERFORMANCEE、
 *    大宗交易 RPT_DATA_BLOCKTRADE、融资融券 RPTA_WEB_RZRQ_GGMX：均可用。
 *    大宗 `PREMIUM_RATIO` 是**小数**溢价率（-0.08756 = -8.76%），
 *    `CHANGE_RATE` 是百分数（0.5684 = 0.5684%），二者单位不同，字段名分开。
 *
 * 时点纪律：`asOf` 是数据自身的最新日期（交易日/公告日），`fetchedAt` 是抓取
 * 时间；二者不混用。缺字段一律 undefined / null，不补 0、不推日期、不猜单位。
 */

// ---------------------------------------------------------------------------
// 端点与常量
// ---------------------------------------------------------------------------

export const EM_MARKET_DETAIL_ENDPOINTS = {
  /** 逐日资金流（CSV klines）。 */
  fundFlow: 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get',
  /** 公司公告列表。 */
  announcements: 'https://np-anotice-stock.eastmoney.com/api/security/ann',
  /** 东财数据中心通用 JSON 接口（分红/业绩/大宗/两融）。 */
  datacenter: 'https://datacenter-web.eastmoney.com/api/data/v1/get',
} as const

/** 资金流接口必需 token（公开网页同款，非私密凭据）。 */
export const EM_FUND_FLOW_TOKEN = 'b2884a393a59ad64002292a3e90d46a5'

export const EM_FUND_FLOW_FIELDS1 = 'f1,f2,f3,f7'
export const EM_FUND_FLOW_FIELDS2 =
  'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65'

/** 东财数据中心 reportName（均于 2026-11-17 实测成功）。 */
export const EM_DATACENTER_REPORTS = {
  dividend: 'RPT_SHAREBONUS_DET',
  performanceForecast: 'RPT_PUBLIC_OP_NEWPREDICT',
  performanceExpress: 'RPT_FCI_PERFORMANCEE',
  blockTrade: 'RPT_DATA_BLOCKTRADE',
  marginTrade: 'RPTA_WEB_RZRQ_GGMX',
} as const

/** 人可读的详情页（仅作为行级 sourceUrl，行情/事件仍以接口为准）。 */
export const EM_MARKET_DETAIL_PAGES = {
  dividend: (code: string) => `https://data.eastmoney.com/yjfp/detail/${code}.html`,
  performanceForecast: (code: string) => `https://data.eastmoney.com/bbsj/yjyg/${code}.html`,
  performanceExpress: (code: string) => `https://data.eastmoney.com/bbsj/yjkb/${code}.html`,
  blockTrade: (code: string) => `https://data.eastmoney.com/dzjy/detail/${code}.html`,
  marginTrade: (code: string) => `https://data.eastmoney.com/rzrq/detail/${code}.html`,
  announcement: (code: string, artCode: string) =>
    `https://data.eastmoney.com/notices/detail/${code}/${encodeURIComponent(artCode)}.html`,
} as const

/** 各类结果的单位口径（原样写入结果，不做事后换算）。 */
export const EM_DETAIL_UNITS = {
  fundFlow: '净额 CNY；占比/涨跌幅 %；收盘价 CNY',
  announcements: '条',
  dividends: '每 10 股派息 CNY（含税）；送转 股/10 股；股息率 小数（0.01=1%）；金额 CNY',
  performance: '金额 CNY；同比 %',
  blockTrades: '价格 CNY；数量 股；金额 CNY；溢价率 小数（0.01=1%）；涨跌幅/换手率 %',
  marginTrades: '金额 CNY；数量 股；价格 CNY；占比/涨跌幅 %',
} as const

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const REFERER_QUOTE = 'https://quote.eastmoney.com/'
const REFERER_DATA = 'https://data.eastmoney.com/'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_FUND_FLOW_DAYS = 250

// ---------------------------------------------------------------------------
// 注入契约
// ---------------------------------------------------------------------------

/** 只依赖 fetch 的最小子集，便于测试注入。 */
export interface EmFetchInit {
  method?: 'GET'
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface EmHttpResponseLike {
  ok: boolean
  status: number
  statusText?: string
  text(): Promise<string>
}

export type EmFetchLike = (url: string, init?: EmFetchInit) => Promise<EmHttpResponseLike>
export type EmJsonParser = (text: string) => unknown

export interface EmMarketDetailDeps {
  /** 注入 fetch；默认全局 fetch（Node >= 18）。 */
  fetch?: EmFetchLike
  /** 注入 JSON 解析；默认 JSON.parse。 */
  json?: EmJsonParser
  /** 注入时钟，测试可固定 fetchedAt。 */
  now?: () => Date
  /** 单次请求超时，默认 15s。 */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// 结果与行类型
// ---------------------------------------------------------------------------

export interface EmDetailResult<T> {
  ok: boolean
  /** 实际请求的接口 URL（含参数），失败时是尝试的 URL。 */
  source: string
  /** 数据自身的最新日期（YYYY-MM-DD）；空结果或失败时缺省。 */
  asOf?: string
  unit: string
  currency?: 'CNY'
  rows: T[]
  count: number
  /** 抓取时间（ISO），不是数据时点。 */
  fetchedAt: string
  error?: string
  warnings?: string[]
  /** 上游总数 / 分页信息（数据中心接口才有）。 */
  total?: number
  page?: number
  pageSize?: number
  /** 合并多源（业绩预告 + 快报）时，部分来源失败。 */
  partial?: boolean
}

export interface ParsedEmRows<T> {
  rows: T[]
  asOf?: string
  warnings: string[]
  total?: number
  page?: number
  pageSize?: number
}

export interface EmPageOptions {
  page?: number
  pageSize?: number
}

export interface FundFlowOptions {
  /** 返回最近 N 个交易日，1-250，默认 20。 */
  days?: number
}

export interface PerformanceOptions extends EmPageOptions {
  /** 默认 all（预告 + 快报），也可只取一边。 */
  kind?: 'all' | 'forecast' | 'express'
}

export interface FundFlowRow {
  date: string
  /** 主力净额（CNY）。 */
  mainNet: number | null
  smallNet: number | null
  mediumNet: number | null
  largeNet: number | null
  extraLargeNet: number | null
  /** 主力净占比（%）。 */
  mainPct: number | null
  smallPct: number | null
  mediumPct: number | null
  largePct: number | null
  extraLargePct: number | null
  /** 收盘价（CNY）。 */
  close: number | null
  /** 涨跌幅（%）。 */
  changePct: number | null
}

export interface AnnouncementRow {
  /** 公告 art_code。 */
  id: string
  title: string
  /** 公告日（notice_date 的日期部分）。 */
  noticeDate?: string
  /** 展示时间（display_time，保留 `YYYY-MM-DD HH:mm:ss`，不做时区换算）。 */
  displayTime?: string
  /** 公告栏目名（columns[].column_name），可能多条。 */
  categories: string[]
  stockCode?: string
  stockName?: string
  /** 公告详情页。 */
  sourceUrl?: string
}

export interface DividendRow {
  /** 分红对应报告期。 */
  reportDate?: string
  /** 实施公告日。 */
  noticeDate?: string
  /** 预案公告日。 */
  planNoticeDate?: string
  equityRecordDate?: string
  exDividendDate?: string
  progress?: string
  planText?: string
  /** 每 10 股税前派息（CNY，含税；原样保留上游）。 */
  bonusPer10SharesPretax?: number
  /** 每 10 股送股。 */
  bonusSharesPer10?: number
  /** 每 10 股转增。 */
  conversionSharesPer10?: number
  /** 每 10 股送转合计。 */
  totalBonusConversionPer10?: number
  /** 股息率（小数，0.0231 = 2.31%；未 ×100）。 */
  dividendYieldRatio?: number
  /** 详情页；上游缺证券代码时缺省，不拼接假 URL。 */
  sourceUrl?: string
}

export type PerformanceKind = 'forecast' | 'express'

export interface PerformanceRow {
  kind: PerformanceKind
  /** 业绩对应报告期。 */
  reportDate?: string
  /** 公告日。 */
  noticeDate?: string
  /** 快报的数据更新时间（UPDATE_DATE）。 */
  updateDate?: string
  /** 快报期间文案（如「2022年 年报」）。 */
  periodLabel?: string
  /** 预告指标（如「营业收入」「归属于上市公司股东的净利润」）。 */
  indicator?: string
  /** 预告类型（略增/略减/预增…）。 */
  forecastType?: string
  /** 预告金额区间（CNY）。 */
  amountLower?: number
  amountUpper?: number
  /** 预告同比区间（%）。 */
  yoyLowerPct?: number
  yoyUpperPct?: number
  content?: string
  reason?: string
  /** 上年同期金额（CNY）。 */
  priorYearAmount?: number
  /** 是否最新一期（上游 IS_LATEST === 'T'）。 */
  isLatest?: boolean
  /** 上游 state（increase/reduction…），不翻译、不推断。 */
  state?: string
  /** 快报：营业收入（CNY）与同比（%）。 */
  revenue?: number
  revenueYoY?: number
  /** 快报：归母净利润（CNY）与同比（%）。 */
  netProfit?: number
  netProfitYoY?: number
  eps?: number
  bps?: number
  /** 加权 ROE（%）。 */
  roeWeighted?: number
  /** 详情页；上游缺证券代码时缺省，不拼接假 URL。 */
  sourceUrl?: string
}

export interface BlockTradeRow {
  tradeDate?: string
  /** 成交价（CNY）。 */
  dealPrice?: number
  /** 溢价率（**小数**，-0.08756 = -8.76%）。 */
  premiumRatio?: number
  /** 成交量（股）。 */
  dealVolume?: number
  /** 成交额（CNY）。 */
  dealAmount?: number
  buyer?: string
  seller?: string
  closePrice?: number
  /** 当日涨跌幅（%）。 */
  changePct?: number
  /** 当日换手率（%）。 */
  turnoverPct?: number
  /** 详情页；上游缺证券代码时缺省，不拼接假 URL。 */
  sourceUrl?: string
}

export interface MarginTradeRow {
  tradeDate?: string
  /** 融资余额（CNY）。 */
  financingBalance?: number
  /** 融券余额（CNY）。 */
  securitiesBalance?: number
  /** 融资融券余额（CNY）。 */
  totalBalance?: number
  /** 融资买入额（CNY）。 */
  financingBuy?: number
  /** 融资偿还额（CNY）。 */
  financingRepay?: number
  /** 融资净买入（CNY）。 */
  financingNetBuy?: number
  /** 融资余额占流通市值比（%）。 */
  financingBalanceToFloatCapPct?: number
  /** 融券余量（股）。 */
  securitiesVolume?: number
  /** 融券卖出量（股）。 */
  securitiesSellVolume?: number
  closePrice?: number
  /** 涨跌幅（%）。 */
  changePct?: number
  /** 详情页；上游缺证券代码时缺省，不拼接假 URL。 */
  sourceUrl?: string
}

export interface EmMarketDetail {
  getFundFlow(code: string, opts?: FundFlowOptions): Promise<EmDetailResult<FundFlowRow>>
  getAnnouncements(code: string, opts?: EmPageOptions): Promise<EmDetailResult<AnnouncementRow>>
  getDividends(code: string, opts?: EmPageOptions): Promise<EmDetailResult<DividendRow>>
  getPerformance(code: string, opts?: PerformanceOptions): Promise<EmDetailResult<PerformanceRow>>
  getBlockTrades(code: string, opts?: EmPageOptions): Promise<EmDetailResult<BlockTradeRow>>
  getMarginTrades(code: string, opts?: EmPageOptions): Promise<EmDetailResult<MarginTradeRow>>
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

function asObject(v: unknown): JsonObject | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null
}

function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim()
    return s ? s : undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

function numOrUndef(v: unknown): number | undefined {
  return numOrNull(v) ?? undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isFailureFlag(v: unknown): boolean {
  return v === false || v === 0 || v === '0' || v === 'false'
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 严格 YYYY-MM-DD（拒绝 2026-02-31 这类不存在的日期）。 */
export function normalizeEmDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim())
  if (!m) return undefined
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined
  return `${m[1]}-${m[2]}-${m[3]}`
}

function dateTimeText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const date = normalizeEmDate(v)
  if (!date) return undefined
  const time = /[ T](\d{2}:\d{2}:\d{2})/.exec(v.trim())?.[1]
  return time ? `${date} ${time}` : date
}

/** 6 位 A 股代码归一（接受 SH600519 / 600519.SH / 600519）；非法返回 null。 */
export function normalizeAShareCode(raw: string): string | null {
  const s = String(raw ?? '').trim().toUpperCase()
  const m = /^(?:SH|SZ|BJ)?(\d{6})(?:\.(?:SH|SZ|BJ|SS))?$/.exec(s)
  return m ? m[1]! : null
}

function requireAShareCode(raw: string): string {
  const code = normalizeAShareCode(raw)
  if (!code) throw new Error(`不是合法的 6 位 A 股代码：${String(raw)}`)
  return code
}

/** 东财 secid 市场位：沪市（含 688/9 开头）为 1，其余为 0。 */
function emSecid(code: string): string {
  return `${/^[69]/.test(code) ? 1 : 0}.${code}`
}

function sortDescBy<T>(rows: T[], key: (row: T) => string | undefined): T[] {
  return rows.sort((a, b) => (key(b) ?? '').localeCompare(key(a) ?? ''))
}

function latestOf<T>(rows: T[], key: (row: T) => string | undefined): string | undefined {
  const dates = rows.map(key).filter((x): x is string => !!x).sort()
  return dates.at(-1)
}

function metaOf(raw: unknown): { total?: number; page?: number; pageSize?: number } {
  const data = asObject(raw)
  if (!data) return {}
  const total = numOrUndef(data.total_hits) ?? numOrUndef(data.count)
  const page = numOrUndef(data.page_index) ?? numOrUndef(data.pageNumber)
  const pageSize = numOrUndef(data.page_size) ?? numOrUndef(data.pageSize)
  return {
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

// ---------------------------------------------------------------------------
// URL 构造（导出便于测试断言）
// ---------------------------------------------------------------------------

export function buildFundFlowUrl(code: string, days = 20): string {
  const c = requireAShareCode(code)
  const limit = clampInt(days, 1, MAX_FUND_FLOW_DAYS, 20)
  const u = new URL(EM_MARKET_DETAIL_ENDPOINTS.fundFlow)
  u.searchParams.set('lmt', String(limit))
  u.searchParams.set('klt', '101')
  u.searchParams.set('secid', emSecid(c))
  u.searchParams.set('fields1', EM_FUND_FLOW_FIELDS1)
  u.searchParams.set('fields2', EM_FUND_FLOW_FIELDS2)
  u.searchParams.set('ut', EM_FUND_FLOW_TOKEN)
  return u.toString()
}

export function buildAnnouncementUrl(code: string, page = 1, pageSize = DEFAULT_PAGE_SIZE): string {
  const c = requireAShareCode(code)
  const u = new URL(EM_MARKET_DETAIL_ENDPOINTS.announcements)
  u.searchParams.set('sr', '-1')
  u.searchParams.set('page_size', String(clampInt(pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)))
  u.searchParams.set('page_index', String(clampInt(page, 1, 10_000, 1)))
  u.searchParams.set('ann_type', 'A')
  u.searchParams.set('client_source', 'web')
  u.searchParams.set('stock_list', c)
  return u.toString()
}

export interface DatacenterQuery {
  reportName: string
  code: string
  /** 过滤字段，默认 SECURITY_CODE；两融接口用 SCODE。 */
  filterField?: string
  sortColumns: string
  page?: number
  pageSize?: number
}

export function buildDatacenterUrl(q: DatacenterQuery): string {
  const c = requireAShareCode(q.code)
  const filterField = q.filterField ?? 'SECURITY_CODE'
  if (!/^[A-Z][A-Z0-9_]*$/.test(filterField)) throw new Error(`非法过滤字段：${filterField}`)
  if (!/^[A-Z][A-Z0-9_]*$/.test(q.sortColumns)) throw new Error(`非法排序列：${q.sortColumns}`)
  const u = new URL(EM_MARKET_DETAIL_ENDPOINTS.datacenter)
  u.searchParams.set('reportName', q.reportName)
  u.searchParams.set('columns', 'ALL')
  u.searchParams.set('filter', `(${filterField}="${c}")`)
  u.searchParams.set('pageNumber', String(clampInt(q.page, 1, 10_000, 1)))
  u.searchParams.set('pageSize', String(clampInt(q.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)))
  u.searchParams.set('sortColumns', q.sortColumns)
  u.searchParams.set('sortTypes', '-1')
  u.searchParams.set('source', 'WEB')
  u.searchParams.set('client', 'WEB')
  return u.toString()
}

export function announcementDetailUrl(code: string, artCode: string): string | undefined {
  const c = normalizeAShareCode(code)
  return c ? EM_MARKET_DETAIL_PAGES.announcement(c, artCode) : undefined
}

/** 行级详情页：优先用行内证券代码，缺失时回退到调用参数；都非法则不给 URL。 */
function eventPageUrl(
  builder: (code: string) => string,
  rowCode: unknown,
  fallback?: string,
): string | undefined {
  const fromRow = textOf(rowCode) ? normalizeAShareCode(String(rowCode)) : null
  const code = fromRow ?? (fallback ? normalizeAShareCode(fallback) : null)
  return code ? builder(code) : undefined
}

// ---------------------------------------------------------------------------
// 纯解析函数
// ---------------------------------------------------------------------------

function fundFlowCell(cells: Array<number | null>, i: number): number | null {
  return cells[i] ?? null
}

export function parseFundFlowDaykline(raw: unknown): ParsedEmRows<FundFlowRow> {
  const root = asObject(raw)
  if (!root) throw new Error('资金流响应不是 JSON 对象')
  const rc = numOrNull(root.rc)
  if (rc !== null && rc !== 0) {
    const dsc = textOf(root.dsc)
    throw new Error(`资金流接口 rc=${rc}${dsc ? `（${dsc}）` : ''}`)
  }
  const data = asObject(root.data)
  if (!data) throw new Error('资金流接口无 data（该代码可能没有资金流数据）')
  const klines = data.klines
  if (klines === null || klines === undefined) throw new Error('资金流接口 data.klines 缺失')
  if (!Array.isArray(klines)) throw new Error('资金流接口 data.klines 不是数组')

  const byDate = new Map<string, FundFlowRow>()
  const warnings: string[] = []
  let skipped = 0
  let badDate = 0
  let duplicate = 0
  let missingCells = 0
  let sumMismatch = 0

  for (const item of klines) {
    if (typeof item !== 'string') {
      skipped++
      continue
    }
    const cols = item.split(',')
    // f51..f63 共 13 列（日期 + 12 个交易字段）；f64/f65 实测恒 0，不映射。
    if (cols.length < 13) {
      skipped++
      continue
    }
    const date = normalizeEmDate(cols[0])
    if (!date) {
      badDate++
      continue
    }
    const cells = cols.slice(1).map((cell) => numOrNull(cell))
    for (let i = 0; i < 12; i++) if (cells[i] === null) missingCells++

    const row: FundFlowRow = {
      date,
      mainNet: fundFlowCell(cells, 0),
      smallNet: fundFlowCell(cells, 1),
      mediumNet: fundFlowCell(cells, 2),
      largeNet: fundFlowCell(cells, 3),
      extraLargeNet: fundFlowCell(cells, 4),
      mainPct: fundFlowCell(cells, 5),
      smallPct: fundFlowCell(cells, 6),
      mediumPct: fundFlowCell(cells, 7),
      largePct: fundFlowCell(cells, 8),
      extraLargePct: fundFlowCell(cells, 9),
      close: fundFlowCell(cells, 10),
      changePct: fundFlowCell(cells, 11),
    }

    // 列序验证（若上游换序，这里会留痕，而不是静默错位）。
    if (row.mainNet !== null && row.largeNet !== null && row.extraLargeNet !== null) {
      if (Math.abs(row.mainNet - (row.largeNet + row.extraLargeNet)) > 1) sumMismatch++
    }
    if (byDate.has(date)) duplicate++
    byDate.set(date, row)
  }

  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (skipped) warnings.push(`跳过 ${skipped} 行无法识别或不足 13 列的 CSV 记录`)
  if (badDate) warnings.push(`跳过 ${badDate} 行日期非法/缺失的记录`)
  if (duplicate) warnings.push(`${duplicate} 个重复交易日已按出现顺序保留最后一条`)
  if (missingCells) warnings.push(`${missingCells} 个数值字段为空/非数值，保留为 null（不补 0）`)
  if (sumMismatch) warnings.push(`${sumMismatch} 行的主力净额 ≠ 大单净额 + 超大单净额（列序可能变化，请复核）`)

  return { rows, asOf: rows.at(-1)?.date, warnings }
}

export function parseAnnouncements(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<AnnouncementRow> {
  const root = asObject(raw)
  if (!root) throw new Error('公告响应不是 JSON 对象')
  if (isFailureFlag(root.success)) {
    const message = textOf(root.error) ?? textOf(root.message) ?? '未知错误'
    throw new Error(`公告接口失败：${message}`)
  }
  const data = asObject(root.data)
  if (!data) throw new Error('公告接口无 data')
  const list = data.list
  if (list === null || list === undefined) throw new Error('公告接口 data.list 缺失')
  if (!Array.isArray(list)) throw new Error('公告接口 data.list 不是数组')

  const rows: AnnouncementRow[] = []
  const warnings: string[] = []
  let skipped = 0
  for (const item of list) {
    const o = asObject(item)
    if (!o) {
      skipped++
      continue
    }
    const id = textOf(o.art_code)
    const title = textOf(o.title) ?? textOf(o.title_ch)
    if (!id || !title) {
      skipped++
      continue
    }
    const codeObj = Array.isArray(o.codes) ? asObject(o.codes[0]) : null
    const stockCode = textOf(codeObj?.stock_code) ?? opts.code
    const noticeDate = normalizeEmDate(o.notice_date)
    const displayTime = dateTimeText(o.display_time)
    const categories = (Array.isArray(o.columns) ? o.columns : [])
      .map((c) => textOf(asObject(c)?.column_name))
      .filter((x): x is string => !!x)
    rows.push({
      id,
      title,
      ...(noticeDate ? { noticeDate } : {}),
      ...(displayTime ? { displayTime } : {}),
      categories,
      ...(stockCode ? { stockCode } : {}),
      ...(textOf(codeObj?.short_name) ? { stockName: textOf(codeObj?.short_name) } : {}),
      ...(stockCode ? { sourceUrl: announcementDetailUrl(stockCode, id) } : {}),
    })
  }
  sortDescBy(rows, (r) => r.noticeDate ?? r.displayTime?.slice(0, 10))
  if (skipped) warnings.push(`跳过 ${skipped} 条缺少 art_code/标题的公告`)
  const meta = metaOf(data)
  return { rows, asOf: latestOf(rows, (r) => r.noticeDate ?? r.displayTime?.slice(0, 10)), warnings, ...meta }
}

interface DataCenterRows {
  rows: JsonObject[]
  total?: number
  page?: number
  pageSize?: number
  warnings: string[]
}

function dataCenterRowsOf(raw: unknown, label: string): DataCenterRows {
  const root = asObject(raw)
  if (!root) throw new Error(`${label}响应不是 JSON 对象`)
  if (isFailureFlag(root.success)) {
    const message = textOf(root.message) ?? textOf(root.error) ?? '未知错误'
    throw new Error(`${label}接口失败：${message}（code=${textOf(root.code) ?? '?'}）`)
  }
  const result = asObject(root.result)
  if (!result) return { rows: [], warnings: [`${label}：上游 result 为空`] }
  const data = result.data
  if (data === null || data === undefined) {
    return { rows: [], warnings: [], ...metaOf(result) }
  }
  if (!Array.isArray(data)) throw new Error(`${label}：result.data 不是数组`)
  const rows: JsonObject[] = []
  let skipped = 0
  for (const item of data) {
    const o = asObject(item)
    if (o) rows.push(o)
    else skipped++
  }
  return {
    rows,
    ...metaOf(result),
    warnings: skipped ? [`${label}：跳过 ${skipped} 条非对象记录`] : [],
  }
}

export function parseDividends(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<DividendRow> {
  const { rows: rawRows, total, page, pageSize, warnings } = dataCenterRowsOf(raw, '分红送配')
  const rows: DividendRow[] = []
  let skipped = 0
  for (const o of rawRows) {
    const reportDate = normalizeEmDate(o.REPORT_DATE)
    const noticeDate = normalizeEmDate(o.NOTICE_DATE)
    const planNoticeDate = normalizeEmDate(o.PLAN_NOTICE_DATE)
    const planText = textOf(o.IMPL_PLAN_PROFILE)
    if (!reportDate && !noticeDate && !planText) {
      skipped++
      continue
    }
    rows.push({
      ...(reportDate ? { reportDate } : {}),
      ...(noticeDate ? { noticeDate } : {}),
      ...(planNoticeDate ? { planNoticeDate } : {}),
      ...(normalizeEmDate(o.EQUITY_RECORD_DATE) ? { equityRecordDate: normalizeEmDate(o.EQUITY_RECORD_DATE) } : {}),
      ...(normalizeEmDate(o.EX_DIVIDEND_DATE) ? { exDividendDate: normalizeEmDate(o.EX_DIVIDEND_DATE) } : {}),
      ...(textOf(o.ASSIGN_PROGRESS) ? { progress: textOf(o.ASSIGN_PROGRESS) } : {}),
      ...(planText ? { planText } : {}),
      ...(numOrUndef(o.PRETAX_BONUS_RMB) !== undefined ? { bonusPer10SharesPretax: numOrUndef(o.PRETAX_BONUS_RMB) } : {}),
      ...(numOrUndef(o.BONUS_RATIO) !== undefined ? { bonusSharesPer10: numOrUndef(o.BONUS_RATIO) } : {}),
      ...(numOrUndef(o.IT_RATIO) !== undefined ? { conversionSharesPer10: numOrUndef(o.IT_RATIO) } : {}),
      ...(numOrUndef(o.BONUS_IT_RATIO) !== undefined ? { totalBonusConversionPer10: numOrUndef(o.BONUS_IT_RATIO) } : {}),
      ...(numOrUndef(o.DIVIDENT_RATIO) !== undefined ? { dividendYieldRatio: numOrUndef(o.DIVIDENT_RATIO) } : {}),
      ...(eventPageUrl(EM_MARKET_DETAIL_PAGES.dividend, o.SECURITY_CODE, opts.code)
        ? { sourceUrl: eventPageUrl(EM_MARKET_DETAIL_PAGES.dividend, o.SECURITY_CODE, opts.code) }
        : {}),
    })
  }
  sortDescBy(rows, (r) => r.noticeDate ?? r.planNoticeDate ?? r.reportDate)
  if (skipped) warnings.push(`分红送配：跳过 ${skipped} 条无报告期/公告日/方案的记录`)
  return {
    rows,
    asOf: latestOf(rows, (r) => r.noticeDate ?? r.planNoticeDate ?? r.reportDate),
    warnings,
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

export function parsePerformanceForecast(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<PerformanceRow> {
  const { rows: rawRows, total, page, pageSize, warnings } = dataCenterRowsOf(raw, '业绩预告')
  const rows: PerformanceRow[] = []
  let skipped = 0
  for (const o of rawRows) {
    const reportDate = normalizeEmDate(o.REPORT_DATE)
    if (!reportDate) {
      skipped++
      continue
    }
    const noticeDate = normalizeEmDate(o.NOTICE_DATE)
    const isLatestRaw = textOf(o.IS_LATEST)?.toUpperCase()
    rows.push({
      kind: 'forecast',
      reportDate,
      ...(noticeDate ? { noticeDate } : {}),
      ...(textOf(o.PREDICT_FINANCE) ? { indicator: textOf(o.PREDICT_FINANCE) } : {}),
      ...(textOf(o.PREDICT_TYPE) ? { forecastType: textOf(o.PREDICT_TYPE) } : {}),
      ...(numOrUndef(o.PREDICT_AMT_LOWER) !== undefined ? { amountLower: numOrUndef(o.PREDICT_AMT_LOWER) } : {}),
      ...(numOrUndef(o.PREDICT_AMT_UPPER) !== undefined ? { amountUpper: numOrUndef(o.PREDICT_AMT_UPPER) } : {}),
      ...(numOrUndef(o.ADD_AMP_LOWER) !== undefined ? { yoyLowerPct: numOrUndef(o.ADD_AMP_LOWER) } : {}),
      ...(numOrUndef(o.ADD_AMP_UPPER) !== undefined ? { yoyUpperPct: numOrUndef(o.ADD_AMP_UPPER) } : {}),
      ...(textOf(o.PREDICT_CONTENT) ? { content: textOf(o.PREDICT_CONTENT) } : {}),
      ...(textOf(o.CHANGE_REASON_EXPLAIN) ? { reason: textOf(o.CHANGE_REASON_EXPLAIN) } : {}),
      ...(numOrUndef(o.PREYEAR_SAME_PERIOD) !== undefined ? { priorYearAmount: numOrUndef(o.PREYEAR_SAME_PERIOD) } : {}),
      ...(isLatestRaw === 'T' ? { isLatest: true } : isLatestRaw === 'F' ? { isLatest: false } : {}),
      ...(textOf(o.FORECAST_STATE) ? { state: textOf(o.FORECAST_STATE) } : {}),
      ...(eventPageUrl(EM_MARKET_DETAIL_PAGES.performanceForecast, o.SECURITY_CODE, opts.code)
        ? { sourceUrl: eventPageUrl(EM_MARKET_DETAIL_PAGES.performanceForecast, o.SECURITY_CODE, opts.code) }
        : {}),
    })
  }
  sortDescBy(rows, (r) => r.noticeDate ?? r.reportDate)
  if (skipped) warnings.push(`业绩预告：跳过 ${skipped} 条无报告期的记录`)
  return {
    rows,
    asOf: latestOf(rows, (r) => r.noticeDate ?? r.reportDate),
    warnings,
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

export function parsePerformanceExpress(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<PerformanceRow> {
  const { rows: rawRows, total, page, pageSize, warnings } = dataCenterRowsOf(raw, '业绩快报')
  const rows: PerformanceRow[] = []
  let skipped = 0
  for (const o of rawRows) {
    const reportDate = normalizeEmDate(o.REPORT_DATE)
    if (!reportDate) {
      skipped++
      continue
    }
    const noticeDate = normalizeEmDate(o.NOTICE_DATE)
    const updateDate = normalizeEmDate(o.UPDATE_DATE)
    rows.push({
      kind: 'express',
      reportDate,
      ...(noticeDate ? { noticeDate } : {}),
      ...(updateDate ? { updateDate } : {}),
      ...(textOf(o.DATATYPE) ? { periodLabel: textOf(o.DATATYPE) } : {}),
      ...(numOrUndef(o.TOTAL_OPERATE_INCOME) !== undefined ? { revenue: numOrUndef(o.TOTAL_OPERATE_INCOME) } : {}),
      ...(numOrUndef(o.YSTZ) !== undefined ? { revenueYoY: numOrUndef(o.YSTZ) } : {}),
      ...(numOrUndef(o.PARENT_NETPROFIT) !== undefined ? { netProfit: numOrUndef(o.PARENT_NETPROFIT) } : {}),
      ...(numOrUndef(o.JLRTBZCL) !== undefined ? { netProfitYoY: numOrUndef(o.JLRTBZCL) } : {}),
      ...(numOrUndef(o.BASIC_EPS) !== undefined ? { eps: numOrUndef(o.BASIC_EPS) } : {}),
      ...(numOrUndef(o.PARENT_BVPS) !== undefined ? { bps: numOrUndef(o.PARENT_BVPS) } : {}),
      ...(numOrUndef(o.WEIGHTAVG_ROE) !== undefined ? { roeWeighted: numOrUndef(o.WEIGHTAVG_ROE) } : {}),
      ...(eventPageUrl(EM_MARKET_DETAIL_PAGES.performanceExpress, o.SECURITY_CODE, opts.code)
        ? { sourceUrl: eventPageUrl(EM_MARKET_DETAIL_PAGES.performanceExpress, o.SECURITY_CODE, opts.code) }
        : {}),
    })
  }
  sortDescBy(rows, (r) => r.noticeDate ?? r.reportDate)
  if (skipped) warnings.push(`业绩快报：跳过 ${skipped} 条无报告期的记录`)
  return {
    rows,
    asOf: latestOf(rows, (r) => r.noticeDate ?? r.reportDate),
    warnings,
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

export function parseBlockTrades(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<BlockTradeRow> {
  const { rows: rawRows, total, page, pageSize, warnings } = dataCenterRowsOf(raw, '大宗交易')
  const rows: BlockTradeRow[] = []
  let skipped = 0
  for (const o of rawRows) {
    const tradeDate = normalizeEmDate(o.TRADE_DATE)
    if (!tradeDate) {
      skipped++
      continue
    }
    rows.push({
      tradeDate,
      ...(numOrUndef(o.DEAL_PRICE) !== undefined ? { dealPrice: numOrUndef(o.DEAL_PRICE) } : {}),
      ...(numOrUndef(o.PREMIUM_RATIO) !== undefined ? { premiumRatio: numOrUndef(o.PREMIUM_RATIO) } : {}),
      ...(numOrUndef(o.DEAL_VOLUME) !== undefined ? { dealVolume: numOrUndef(o.DEAL_VOLUME) } : {}),
      ...(numOrUndef(o.DEAL_AMT) !== undefined ? { dealAmount: numOrUndef(o.DEAL_AMT) } : {}),
      ...(textOf(o.BUYER_NAME) ? { buyer: textOf(o.BUYER_NAME) } : {}),
      ...(textOf(o.SELLER_NAME) ? { seller: textOf(o.SELLER_NAME) } : {}),
      ...(numOrUndef(o.CLOSE_PRICE) !== undefined ? { closePrice: numOrUndef(o.CLOSE_PRICE) } : {}),
      ...(numOrUndef(o.CHANGE_RATE) !== undefined ? { changePct: numOrUndef(o.CHANGE_RATE) } : {}),
      ...(numOrUndef(o.TURNOVER_RATE) !== undefined ? { turnoverPct: numOrUndef(o.TURNOVER_RATE) } : {}),
      ...(eventPageUrl(EM_MARKET_DETAIL_PAGES.blockTrade, o.SECURITY_CODE, opts.code)
        ? { sourceUrl: eventPageUrl(EM_MARKET_DETAIL_PAGES.blockTrade, o.SECURITY_CODE, opts.code) }
        : {}),
    })
  }
  sortDescBy(rows, (r) => r.tradeDate)
  if (skipped) warnings.push(`大宗交易：跳过 ${skipped} 条无交易日的记录`)
  return {
    rows,
    asOf: latestOf(rows, (r) => r.tradeDate),
    warnings,
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

export function parseMarginTrades(raw: unknown, opts: { code?: string } = {}): ParsedEmRows<MarginTradeRow> {
  const { rows: rawRows, total, page, pageSize, warnings } = dataCenterRowsOf(raw, '融资融券')
  const rows: MarginTradeRow[] = []
  let skipped = 0
  let sumMismatch = 0
  for (const o of rawRows) {
    const tradeDate = normalizeEmDate(o.DATE)
    if (!tradeDate) {
      skipped++
      continue
    }
    const row: MarginTradeRow = {
      tradeDate,
      ...(numOrUndef(o.RZYE) !== undefined ? { financingBalance: numOrUndef(o.RZYE) } : {}),
      ...(numOrUndef(o.RQYE) !== undefined ? { securitiesBalance: numOrUndef(o.RQYE) } : {}),
      ...(numOrUndef(o.RZRQYE) !== undefined ? { totalBalance: numOrUndef(o.RZRQYE) } : {}),
      ...(numOrUndef(o.RZMRE) !== undefined ? { financingBuy: numOrUndef(o.RZMRE) } : {}),
      ...(numOrUndef(o.RZCHE) !== undefined ? { financingRepay: numOrUndef(o.RZCHE) } : {}),
      ...(numOrUndef(o.RZJME) !== undefined ? { financingNetBuy: numOrUndef(o.RZJME) } : {}),
      ...(numOrUndef(o.RZYEZB) !== undefined ? { financingBalanceToFloatCapPct: numOrUndef(o.RZYEZB) } : {}),
      ...(numOrUndef(o.RQYL) !== undefined ? { securitiesVolume: numOrUndef(o.RQYL) } : {}),
      ...(numOrUndef(o.RQMCL) !== undefined ? { securitiesSellVolume: numOrUndef(o.RQMCL) } : {}),
      ...(numOrUndef(o.SPJ) !== undefined ? { closePrice: numOrUndef(o.SPJ) } : {}),
      ...(numOrUndef(o.ZDF) !== undefined ? { changePct: numOrUndef(o.ZDF) } : {}),
      ...(eventPageUrl(EM_MARKET_DETAIL_PAGES.marginTrade, o.SCODE, opts.code)
        ? { sourceUrl: eventPageUrl(EM_MARKET_DETAIL_PAGES.marginTrade, o.SCODE, opts.code) }
        : {}),
    }
    if (
      row.totalBalance !== undefined && row.financingBalance !== undefined && row.securitiesBalance !== undefined &&
      Math.abs(row.totalBalance - (row.financingBalance + row.securitiesBalance)) > 1
    ) sumMismatch++
    if (
      row.financingNetBuy !== undefined && row.financingBuy !== undefined && row.financingRepay !== undefined &&
      Math.abs(row.financingNetBuy - (row.financingBuy - row.financingRepay)) > 1
    ) sumMismatch++
    rows.push(row)
  }
  sortDescBy(rows, (r) => r.tradeDate)
  if (skipped) warnings.push(`融资融券：跳过 ${skipped} 条无交易日的记录`)
  if (sumMismatch) warnings.push(`${sumMismatch} 行两融合计/净买入与分项不闭合（请复核上游口径）`)
  return {
    rows,
    asOf: latestOf(rows, (r) => r.tradeDate),
    warnings,
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  }
}

// ---------------------------------------------------------------------------
// 抓取 + 结果包装
// ---------------------------------------------------------------------------

export function createEmMarketDetail(deps: EmMarketDetailDeps = {}): EmMarketDetail {
  const fetchImpl: EmFetchLike =
    deps.fetch ??
    ((url, init) => {
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('当前运行环境没有 fetch，请通过 deps.fetch 注入')
      }
      return globalThis.fetch(url, init as RequestInit) as unknown as Promise<EmHttpResponseLike>
    })
  const parseJson: EmJsonParser = deps.json ?? ((text) => JSON.parse(text) as unknown)
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function fetchJson(url: string, referer: string): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/json,text/plain,*/*',
          Referer: referer,
        },
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      const text = await res.text()
      try {
        return parseJson(text)
      } catch (err) {
        throw new Error(`JSON 解析失败：${errorMessage(err)}`)
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`请求超时（>${timeoutMs}ms）`)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  function failed<T>(
    label: string,
    source: string,
    unit: string,
    err: unknown,
    currency?: 'CNY',
  ): EmDetailResult<T> {
    return {
      ok: false,
      source,
      unit,
      ...(currency ? { currency } : {}),
      rows: [],
      count: 0,
      fetchedAt: now().toISOString(),
      error: `${label}：${errorMessage(err)}`,
    }
  }

  async function run<T>(
    label: string,
    source: string,
    referer: string,
    parser: (raw: unknown) => ParsedEmRows<T>,
    unit: string,
    currency?: 'CNY',
  ): Promise<EmDetailResult<T>> {
    const fetchedAt = now().toISOString()
    try {
      const raw = await fetchJson(source, referer)
      const parsed = parser(raw)
      return {
        ok: true,
        source,
        ...(parsed.asOf ? { asOf: parsed.asOf } : {}),
        unit,
        ...(currency ? { currency } : {}),
        rows: parsed.rows,
        count: parsed.rows.length,
        fetchedAt,
        ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
        ...(parsed.total !== undefined ? { total: parsed.total } : {}),
        ...(parsed.page !== undefined ? { page: parsed.page } : {}),
        ...(parsed.pageSize !== undefined ? { pageSize: parsed.pageSize } : {}),
      }
    } catch (err) {
      return failed<T>(label, source, unit, err, currency)
    }
  }

  return {
    async getFundFlow(code, opts = {}) {
      let source: string = EM_MARKET_DETAIL_ENDPOINTS.fundFlow
      try {
        source = buildFundFlowUrl(code, opts.days ?? 20)
      } catch (err) {
        return failed('资金流', source, EM_DETAIL_UNITS.fundFlow, err, 'CNY')
      }
      return run('资金流', source, REFERER_QUOTE, parseFundFlowDaykline, EM_DETAIL_UNITS.fundFlow, 'CNY')
    },

    async getAnnouncements(code, opts = {}) {
      let source: string = EM_MARKET_DETAIL_ENDPOINTS.announcements
      let code6: string
      try {
        code6 = requireAShareCode(code)
        source = buildAnnouncementUrl(code6, opts.page ?? 1, opts.pageSize ?? DEFAULT_PAGE_SIZE)
      } catch (err) {
        return failed('公告', source, EM_DETAIL_UNITS.announcements, err)
      }
      return run('公告', source, REFERER_DATA, (raw) => parseAnnouncements(raw, { code: code6 }), EM_DETAIL_UNITS.announcements)
    },

    async getDividends(code, opts = {}) {
      let source: string = EM_MARKET_DETAIL_ENDPOINTS.datacenter
      try {
        source = buildDatacenterUrl({
          reportName: EM_DATACENTER_REPORTS.dividend,
          code,
          sortColumns: 'NOTICE_DATE',
          page: opts.page,
          pageSize: opts.pageSize,
        })
      } catch (err) {
        return failed('分红送配', source, EM_DETAIL_UNITS.dividends, err, 'CNY')
      }
      return run('分红送配', source, REFERER_DATA, (raw) => parseDividends(raw, { code }), EM_DETAIL_UNITS.dividends, 'CNY')
    },

    async getPerformance(code, opts = {}) {
      const kind = opts.kind ?? 'all'
      const fetchedAt = now().toISOString()
      const page = opts.page
      const pageSize = opts.pageSize
      const code6 = normalizeAShareCode(code)

      const forecastUrl = (() => {
        try {
          return buildDatacenterUrl({
            reportName: EM_DATACENTER_REPORTS.performanceForecast,
            code,
            sortColumns: 'NOTICE_DATE',
            page,
            pageSize,
          })
        } catch {
          return EM_MARKET_DETAIL_ENDPOINTS.datacenter
        }
      })()
      const expressUrl = (() => {
        try {
          return buildDatacenterUrl({
            reportName: EM_DATACENTER_REPORTS.performanceExpress,
            code,
            sortColumns: 'NOTICE_DATE',
            page,
            pageSize,
          })
        } catch {
          return EM_MARKET_DETAIL_ENDPOINTS.datacenter
        }
      })()

      if (!code6) {
        return {
          ok: false,
          source: forecastUrl,
          unit: EM_DETAIL_UNITS.performance,
          currency: 'CNY',
          rows: [],
          count: 0,
          fetchedAt,
          error: `业绩：不是合法的 6 位 A 股代码：${String(code)}`,
        }
      }

      if (kind === 'forecast') {
        return run('业绩预告', forecastUrl, REFERER_DATA, (raw) => parsePerformanceForecast(raw, { code }), EM_DETAIL_UNITS.performance, 'CNY')
      }
      if (kind === 'express') {
        return run('业绩快报', expressUrl, REFERER_DATA, (raw) => parsePerformanceExpress(raw, { code }), EM_DETAIL_UNITS.performance, 'CNY')
      }

      const [forecast, express] = await Promise.all([
        run('业绩预告', forecastUrl, REFERER_DATA, (raw) => parsePerformanceForecast(raw, { code }), EM_DETAIL_UNITS.performance, 'CNY'),
        run('业绩快报', expressUrl, REFERER_DATA, (raw) => parsePerformanceExpress(raw, { code }), EM_DETAIL_UNITS.performance, 'CNY'),
      ])
      const warnings = [
        ...(forecast.warnings ?? []),
        ...(express.warnings ?? []),
        ...(forecast.ok ? [] : [`业绩预告抓取失败：${forecast.error ?? '未知错误'}`]),
        ...(express.ok ? [] : [`业绩快报抓取失败：${express.error ?? '未知错误'}`]),
      ]
      const rows = sortDescBy(
        [...forecast.rows, ...express.rows],
        (r) => r.noticeDate ?? r.reportDate,
      )
      if (!forecast.ok && !express.ok) {
        return {
          ok: false,
          source: `${forecastUrl} | ${expressUrl}`,
          unit: EM_DETAIL_UNITS.performance,
          currency: 'CNY',
          rows: [],
          count: 0,
          fetchedAt: now().toISOString(),
          error: `业绩：预告与快报均失败；预告：${forecast.error ?? '未知错误'}；快报：${express.error ?? '未知错误'}`,
        }
      }
      return {
        ok: true,
        source: `${forecastUrl} | ${expressUrl}`,
        ...(latestOf(rows, (r) => r.noticeDate ?? r.reportDate)
          ? { asOf: latestOf(rows, (r) => r.noticeDate ?? r.reportDate) }
          : {}),
        unit: EM_DETAIL_UNITS.performance,
        currency: 'CNY',
        rows,
        count: rows.length,
        fetchedAt,
        ...(warnings.length ? { warnings } : {}),
        ...(forecast.total !== undefined || express.total !== undefined
          ? { total: (forecast.total ?? 0) + (express.total ?? 0) }
          : {}),
        ...(forecast.ok && express.ok ? {} : { partial: true }),
      }
    },

    async getBlockTrades(code, opts = {}) {
      let source: string = EM_MARKET_DETAIL_ENDPOINTS.datacenter
      try {
        source = buildDatacenterUrl({
          reportName: EM_DATACENTER_REPORTS.blockTrade,
          code,
          sortColumns: 'TRADE_DATE',
          page: opts.page,
          pageSize: opts.pageSize,
        })
      } catch (err) {
        return failed('大宗交易', source, EM_DETAIL_UNITS.blockTrades, err, 'CNY')
      }
      return run('大宗交易', source, REFERER_DATA, (raw) => parseBlockTrades(raw, { code }), EM_DETAIL_UNITS.blockTrades, 'CNY')
    },

    async getMarginTrades(code, opts = {}) {
      let source: string = EM_MARKET_DETAIL_ENDPOINTS.datacenter
      try {
        source = buildDatacenterUrl({
          reportName: EM_DATACENTER_REPORTS.marginTrade,
          code,
          filterField: 'SCODE',
          sortColumns: 'DATE',
          page: opts.page,
          pageSize: opts.pageSize,
        })
      } catch (err) {
        return failed('融资融券', source, EM_DETAIL_UNITS.marginTrades, err, 'CNY')
      }
      return run('融资融券', source, REFERER_DATA, (raw) => parseMarginTrades(raw, { code }), EM_DETAIL_UNITS.marginTrades, 'CNY')
    },
  }
}
