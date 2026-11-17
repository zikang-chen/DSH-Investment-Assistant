/**
 * 全球主要指数行情（东方财富 push2 qt/stock/get）。
 *
 * 边界与口径：
 * - 上游一个 secid 一个请求；`fltt=2&invt=2` 时源侧已把 f43 点位、f170 涨跌幅（%）、
 *   f169 涨跌额转成小数，本模块**不再除以 100**，也不做币种/点位推算。
 * - 字段缺失一律 null，绝不补 0；`f43=0` 这种真实的 0 会保留为 0（与缺失区分）。
 * - `at`（报告级）是本次抓取时间；行内 `asOf` 来自源侧 `f86` 时间戳，是行情时间。
 *   两者分开，抓取失败时不会把抓取时间伪装成行情时间。
 * - 单个 secid 失败只影响该行：失败行 `price/changePct/change/asOf` 为 null 并带
 *   `error`，其余行照常返回；失败行不进缓存（下次调用会重试）。
 * - 小并发（3）+ 逐行短缓存（30s）：成功且有价格的行缓存；全部失败时报告 ok:false。
 * - 解析器是纯函数；`fetchJson`、`now` 可注入，测试全程离线跑 fixture。
 */

import { httpGetJson } from './http.js'

// ---------------------------------------------------------------- 区域与指数清单

/** 面板可切换的区域（默认 us）。commodities = 商品与美债收益率，便于看跨资产联动。 */
export const GLOBAL_REGIONS = ['us', 'asia', 'europe', 'china', 'commodities'] as const
export type GlobalRegion = (typeof GLOBAL_REGIONS)[number]
/** `all` 表示一次返回全部区域。 */
export type GlobalRegionFilter = GlobalRegion | 'all'

export const GLOBAL_REGION_LABELS: Record<GlobalRegion, string> = {
  us: '美国',
  asia: '亚太',
  europe: '欧洲',
  china: '中国',
  commodities: '商品/利率',
}

export interface GlobalIndexDef {
  /** 东财 secid：市场位.代码（100=全球指数，1=沪，0=深）。 */
  secid: string
  /** 展示/关联用的短代码（如 SPX、000001）。 */
  code: string
  name: string
  region: GlobalRegion
}

/**
 * 全球主要指数清单。secid 由东财行情页核对：
 * 100.SPX 标普500、100.DJIA 道琼斯、100.NDX 纳斯达克、100.HSI 恒生、
 * 100.N225 日经、100.KS11 韩国、100.SENSEX 印度、100.FTSE 英国、
 * 100.GDAXI 德国、100.FCHI 法国、100.AS51 澳洲、1.000001 上证、
 * 0.399001 深证、0.399006 创业板。
 */
export const GLOBAL_INDEX_DEFS: readonly GlobalIndexDef[] = [
  // ---- 美国 ----
  { secid: '100.SPX', code: 'SPX', name: '标普500', region: 'us' },
  { secid: '100.DJIA', code: 'DJIA', name: '道琼斯', region: 'us' },
  { secid: '100.NDX', code: 'NDX', name: '纳斯达克', region: 'us' },
  { secid: '100.TSX', code: 'TSX', name: '加拿大S&P/TSX', region: 'us' },
  // ---- 亚太（澳洲归入亚太，面板只有四个区域）----
  { secid: '100.HSI', code: 'HSI', name: '恒生指数', region: 'asia' },
  { secid: '124.HSTECH', code: 'HSTECH', name: '恒生科技指数', region: 'asia' },
  { secid: '100.N225', code: 'N225', name: '日经225', region: 'asia' },
  { secid: '100.KS11', code: 'KS11', name: '韩国综合指数', region: 'asia' },
  { secid: '100.SENSEX', code: 'SENSEX', name: '印度孟买Sensex', region: 'asia' },
  { secid: '100.AS51', code: 'AS51', name: '澳洲标普200', region: 'asia' },
  // ---- 欧洲 ----
  { secid: '100.SX5E', code: 'SX5E', name: '欧洲斯托克50', region: 'europe' },
  { secid: '100.FTSE', code: 'FTSE', name: '英国富时100', region: 'europe' },
  { secid: '100.GDAXI', code: 'GDAXI', name: '德国DAX', region: 'europe' },
  { secid: '100.FCHI', code: 'FCHI', name: '法国CAC40', region: 'europe' },
  // ---- 中国 ----
  { secid: '1.000001', code: '000001', name: '上证指数', region: 'china' },
  { secid: '0.399001', code: '399001', name: '深证成指', region: 'china' },
  { secid: '0.399006', code: '399006', name: '创业板指', region: 'china' },
  // ---- 商品与利率（跨资产参考）----
  { secid: '101.GC00Y', code: 'GC00Y', name: 'COMEX黄金', region: 'commodities' },
  { secid: '101.SI00Y', code: 'SI00Y', name: 'COMEX白银', region: 'commodities' },
  { secid: '101.HG00Y', code: 'HG00Y', name: 'COMEX铜', region: 'commodities' },
  { secid: '102.CL00Y', code: 'CL00Y', name: 'NYMEX原油', region: 'commodities' },
  { secid: '112.B00Y', code: 'B00Y', name: '布伦特原油', region: 'commodities' },
  { secid: '171.US10Y', code: 'US10Y', name: '美国10年期国债收益率', region: 'commodities' },
  { secid: '100.UDI', code: 'UDI', name: '美元指数', region: 'commodities' },
]

/**
 * 区域归一：空值 → us（默认美国）；大小写/空白容忍；`all` 原样；
 * 其它值返回 null（调用方必须显式报错，不猜区域）。
 */
export function normalizeGlobalRegion(value: unknown): GlobalRegionFilter | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!raw) return 'us'
  if (raw === 'all') return 'all'
  return (GLOBAL_REGIONS as readonly string[]).includes(raw) ? (raw as GlobalRegion) : null
}

/** 该区域的指数清单（保持清单顺序，便于面板稳定展示）。 */
export function globalIndicesForRegion(region: GlobalRegionFilter): GlobalIndexDef[] {
  return region === 'all'
    ? [...GLOBAL_INDEX_DEFS]
    : GLOBAL_INDEX_DEFS.filter((def) => def.region === region)
}

// ---------------------------------------------------------------- 常量

export const EM_GLOBAL_INDEX_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
/** 只取需要的 5 个字段：点位/名称/涨跌幅/涨跌额/行情时间戳。 */
export const EM_GLOBAL_INDEX_FIELDS = 'f43,f58,f170,f169,f86'
/** 行级来源标识（面板显示「东财」）。 */
export const GLOBAL_INDICES_SOURCE = 'eastmoney-push2'
export const GLOBAL_INDICES_TIMEOUT_MS = 10_000
/** 短缓存：指数点位秒级变化，但面板/路由可能连续刷新；30s 足够挡住重复请求。 */
export const GLOBAL_INDICES_CACHE_TTL_MS = 30_000
/** 小并发：14 个 secid 分 3 路取，避免同时打满 push2。 */
export const GLOBAL_INDICES_CONCURRENCY = 3

// ---------------------------------------------------------------- 类型

export interface GlobalIndexRow {
  secid: string
  code: string
  name: string
  region: GlobalRegion
  /** 点位；源字段缺失/非法时为 null（不补 0）。 */
  price: number | null
  /** 涨跌幅，单位 %；缺失为 null。 */
  changePct: number | null
  /** 涨跌额；缺失为 null。 */
  change: number | null
  /** 行情时间（来自 f86 时间戳，ISO 8601）；缺失为 null，不是抓取时间。 */
  asOf: string | null
  source: string
  /** 该行抓取失败时的原因；成功行没有此字段。 */
  error?: string
}

export interface GlobalIndicesReport {
  ok: boolean
  /** 本次抓取的 ISO 时间；与行内 asOf（行情时间）分开。 */
  at: string
  /** 请求的区域；未知 region 时为 null（不猜默认）。 */
  region: GlobalRegionFilter | null
  rows: GlobalIndexRow[]
  /** 命中短缓存的行数（0 表示全部实时抓取）。 */
  cacheHits: number
  /** 抓取失败的行数（单行失败只影响该行）。 */
  failed: number
  /** 经 registry 调用时由 service 填入的 provider id。 */
  provider?: string
  /** 整体不可用（未知区域 / 全部行失败 / registry 无源）时的原因。 */
  error?: string
  /** registry 的各源尝试记录（service 透传）。 */
  attempts?: Array<{ provider: string; error: string }>
}

// ---------------------------------------------------------------- 纯解析

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 东财数值归一：number / 数字字符串 → number；'-'、'—'、''、null、NaN、Infinity → null。
 * 注意 0 是合法值，保留为 0。
 */
export function parseGlobalIndexNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text || text === '-' || text === '—' || text === '--') return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * f86 时间戳 → ISO 8601。东财给的是「秒」（如 1763371200），毫秒也容忍；
 * 0/负数/非法值返回 null（不会变成 1970）。
 */
export function parseGlobalIndexTime(value: unknown): string | null {
  const n = parseGlobalIndexNumber(value)
  if (n === null || n <= 0) return null
  const ms = n >= 1e12 ? n : n * 1000
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * 解析单个指数的东财响应。`data` 缺失/不是对象/空对象时抛错（由 fetch 层转成该行
 * error，不影响其它行）；`data` 存在但字段缺失 → 对应字段 null，不补 0。
 */
export function parseGlobalIndexQuote(def: GlobalIndexDef, payload: unknown): GlobalIndexRow {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null
  if (!data || Object.keys(data).length === 0) {
    throw new Error(`全球指数 ${def.secid} 返回空 data`)
  }
  const name = typeof data.f58 === 'string' && data.f58.trim() ? data.f58.trim() : def.name
  return {
    secid: def.secid,
    code: def.code,
    name,
    region: def.region,
    price: parseGlobalIndexNumber(data.f43),
    changePct: parseGlobalIndexNumber(data.f170),
    change: parseGlobalIndexNumber(data.f169),
    asOf: parseGlobalIndexTime(data.f86),
    source: GLOBAL_INDICES_SOURCE,
  }
}

/** 构造一行「抓取失败」占位：字段 null + error，便于面板逐行展示而不是整段消失。 */
export function failedGlobalIndexRow(def: GlobalIndexDef, error: string): GlobalIndexRow {
  return {
    secid: def.secid,
    code: def.code,
    name: def.name,
    region: def.region,
    price: null,
    changePct: null,
    change: null,
    asOf: null,
    source: GLOBAL_INDICES_SOURCE,
    error,
  }
}

// ---------------------------------------------------------------- 抓取 + 短缓存

export interface GlobalIndicesHttpOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export type GlobalIndicesFetchJson = (
  url: string,
  params: Record<string, string | number | undefined>,
  options: GlobalIndicesHttpOptions,
) => Promise<unknown>

export interface FetchGlobalIndicesOptions {
  /** us/asia/europe/china/all；空值默认 us，未知值返回 ok:false（不猜）。 */
  region?: unknown
  /** 测试注入点；默认 data/http.ts 的 httpGetJson。 */
  fetchJson?: GlobalIndicesFetchJson
  timeoutMs?: number
  signal?: AbortSignal
  /** 毫秒时间源（测试固定时间/推进 TTL 用），默认 Date.now。 */
  now?: () => number
  /** false = 绕过短缓存强制重取（测试或手动刷新）。 */
  cache?: boolean
}

interface CachedIndexRow {
  at: number
  row: GlobalIndexRow
}

const rowCache = new Map<string, CachedIndexRow>()
const inFlight = new Map<string, { promise: Promise<GlobalIndexRow>; at: number }>()

/** 清空进程内短缓存（测试或手动刷新用）。 */
export function clearGlobalIndicesCache(): void {
  rowCache.clear()
  inFlight.clear()
}

function cloneRow(row: GlobalIndexRow): GlobalIndexRow {
  return { ...row }
}

/** 有界并发地按清单顺序执行（结果保序）。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

interface RowLoadContext {
  fetchJson: GlobalIndicesFetchJson
  timeoutMs: number
  signal?: AbortSignal
  now: () => number
  cache: boolean
}

async function loadGlobalIndexRow(
  def: GlobalIndexDef,
  ctx: RowLoadContext,
): Promise<{ row: GlobalIndexRow; cached: boolean; at: number }> {
  if (ctx.cache) {
    const hit = rowCache.get(def.secid)
    if (hit && ctx.now() - hit.at < GLOBAL_INDICES_CACHE_TTL_MS) {
      return { row: cloneRow(hit.row), cached: true, at: hit.at }
    }
  }

  // 同一 secid 的并发请求合并成一次上游调用（route 连续刷新时不重复打源）。
  const pending = ctx.cache ? inFlight.get(def.secid) : undefined
  if (pending) return { row: await pending.promise, cached: false, at: pending.at }

  const requestAt = ctx.now()
  const request = (async () => {
    const payload = await ctx.fetchJson(
      EM_GLOBAL_INDEX_URL,
      { secid: def.secid, fltt: 2, invt: 2, fields: EM_GLOBAL_INDEX_FIELDS },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    )
    const row = parseGlobalIndexQuote(def, payload)
    // 只有「成功且有点位」的行才缓存；请求异常/空 data/无价行下次重试。
    if (ctx.cache && row.price !== null) rowCache.set(def.secid, { at: requestAt, row: cloneRow(row) })
    return row
  })()

  if (ctx.cache) inFlight.set(def.secid, { promise: request, at: requestAt })
  try {
    return { row: await request, cached: false, at: requestAt }
  } finally {
    if (ctx.cache) inFlight.delete(def.secid)
  }
}

function clampTimeout(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return GLOBAL_INDICES_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(n), 1_000), 60_000)
}

/**
 * 取全球指数行情。默认美国；单行失败只影响该行；整体全部失败时 ok:false。
 * 返回值与 HTTP 路由同形：{ ok, at, region, rows, cacheHits, failed, error? }。
 */
export async function fetchGlobalIndices(options: FetchGlobalIndicesOptions = {}): Promise<GlobalIndicesReport> {
  const now = options.now ?? Date.now
  const at = new Date(now()).toISOString()
  const region = normalizeGlobalRegion(options.region)
  if (!region) {
    return {
      ok: false,
      at,
      region: null,
      rows: [],
      cacheHits: 0,
      failed: 0,
      error: `未知区域：${String(options.region ?? '')}；可选 us/asia/europe/china/all`,
    }
  }

  const defs = globalIndicesForRegion(region)
  const ctx: RowLoadContext = {
    fetchJson: options.fetchJson ?? httpGetJson,
    timeoutMs: clampTimeout(options.timeoutMs),
    signal: options.signal,
    now,
    cache: options.cache !== false,
  }

  let cacheHits = 0
  // 报告级 at = 所服务数据的最近一次实际抓取时间；全部命中缓存时不会假装刚刚抓过。
  let latestFetchedAt = 0
  const rows = await mapWithConcurrency(defs, GLOBAL_INDICES_CONCURRENCY, async (def) => {
    try {
      const loaded = await loadGlobalIndexRow(def, ctx)
      if (loaded.cached) cacheHits += 1
      latestFetchedAt = Math.max(latestFetchedAt, loaded.at)
      return loaded.row
    } catch (err) {
      latestFetchedAt = Math.max(latestFetchedAt, now())
      return failedGlobalIndexRow(def, err instanceof Error ? err.message : String(err))
    }
  })

  const failed = rows.filter((row) => row.error !== undefined).length
  const priced = rows.filter((row) => row.price !== null).length
  const ok = priced > 0
  return {
    ok,
    at: new Date(latestFetchedAt || now()).toISOString(),
    region,
    rows,
    cacheHits,
    failed,
    ...(ok
      ? {}
      : { error: `全球指数行情不可用（${failed}/${rows.length} 行抓取失败）` }),
  }
}
