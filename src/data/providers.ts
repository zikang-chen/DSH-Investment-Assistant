/**
 * Direct HTTP market providers.
 * Endpoint shapes are taken from AkShare sources (comments cite function + file);
 * runtime does NOT import or spawn akshare.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  DEFAULT_UA,
  emSecMarket,
  httpGetJson,
  httpGetText,
  marketCode,
  normalizeCode,
  toSecuCode,
  toTxSymbol,
  type HttpGetOptions,
} from './http.js'
import { DEFAULT_INDEX_CODES, westockProviders } from './westock.js'
import {
  F10_ENDPOINTS,
  isAShareCode,
  normalizeBusinessComposition,
  normalizeCompanySurvey,
  normalizeCoreConcepts,
  normalizeMainFinancials,
  normalizePeers,
  normalizeShareholderCount,
  normalizeValuation,
} from './eastmoney-f10.js'
import { WESTOCK_CAPABILITY_PROVIDERS, WESTOCK_SPECS } from './westock-capabilities.js'
import {
  createEmMarketDetail,
  type EmDetailResult,
  type EmMarketDetailDeps,
  type EmHttpResponseLike,
} from './em-market-detail.js'
import {
  fetchHkFinancials,
  fetchUsFinancials,
  type GlobalFinancialRow,
  type GlobalFinancialsResult,
} from './global-financials.js'
import { fetchGlobalIndices } from './global-indices.js'
import { normalizeFundHoldingRows, type NormalizedHolding } from '../fund-analysis.js'
import {
  GLOBAL_MACRO_DEFAULT_POINTS,
  GLOBAL_MACRO_MAX_POINTS,
  GLOBAL_MACRO_SERIES_META,
  GLOBAL_MACRO_TIMEOUT_MS,
  applyGlobalMacroPointLimit,
  assembleGlobalMacroSeries,
  buildGlobalMacroReport,
  clampGlobalMacroLimit,
  globalMacroFailure,
  hasObservableValue,
  normalizeSeriesRequest,
  parseJsonStatDataset,
  parseSdmxGenericXml,
  parseSdmxJsonDataset,
  parseWorldBankIndicator,
  pickParsedSeriesGroup,
  type GlobalMacroRepresentation,
  type GlobalMacroReport,
  type GlobalMacroSeries,
  type GlobalMacroSeriesKey,
  type SeriesParseResult,
} from './global-macro.js'
import type { Capability, KlineBar, ProviderContext, ProviderFn, SearchResult, StockInfo, StockQuote, SymbolMatch } from '../types.js'

const execFileAsync = promisify(execFile)
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface ProviderMeta {
  id: string
  capability: Capability
  /** Upstream endpoint this provider was derived from (AkShare fn / vendor API). */
  endpointRef: string
  /** Args used when probing this provider standalone. */
  sampleArgs?: Record<string, unknown>
  call: ProviderFn
}

function opts(ctx: ProviderContext, referer?: string): HttpGetOptions {
  return { timeoutMs: ctx.timeoutMs, signal: ctx.signal, referer }
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

// Yahoo throttles cookieless requests (HTTP 429). Mirror yfinance: establish a
// cookie + crumb session once, cache it, and retry once with a fresh session.
interface YahooSession { cookie: string; crumb: string }
let yahooSession: YahooSession | undefined
let yahooSessionPending: Promise<YahooSession | undefined> | undefined

async function fetchYahooSession(ctx: ProviderContext): Promise<YahooSession | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('yahoo session timeout')), ctx.timeoutMs)
  try {
    const home = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': DEFAULT_UA }, signal: ctrl.signal })
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    if (!cookie) return undefined
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': DEFAULT_UA, Cookie: cookie },
      signal: ctrl.signal,
    })
    const crumb = (await res.text()).trim()
    if (!crumb || crumb.includes('<')) return undefined
    return { cookie, crumb }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function yahooSessionGet(ctx: ProviderContext, refresh = false): Promise<YahooSession | undefined> {
  if (refresh) yahooSession = undefined
  if (yahooSession) return yahooSession
  yahooSessionPending ??= fetchYahooSession(ctx).then((s) => {
    yahooSession = s
    yahooSessionPending = undefined
    return s
  })
  return yahooSessionPending
}

async function yahooChart(symbol: string, params: Record<string, string | number>, ctx: ProviderContext) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  const base: HttpGetOptions = { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: 'application/json' } }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await yahooSessionGet(ctx, attempt > 0)
    const headers = { ...base.headers, ...(session ? { Cookie: session.cookie } : {}) }
    const merged = session ? { ...params, crumb: session.crumb } : params
    try {
      return await httpGetJson<YahooChart>(url, merged, { ...base, headers })
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('yahoo chart failed')
}

interface YahooChart {
  chart?: {
    error?: { description?: string } | null
    result?: Array<{
      meta?: Record<string, unknown>
      timestamp?: number[]
      indicators?: { quote?: Array<Record<string, Array<number | null>>> }
    }>
  }
}

/**
 * Source: akshare.stock_feature.stock_hist_em.stock_zh_a_spot_em
 * (clist first page only — avoid full-market crawl)
 */
async function emAClist(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>>; total?: number } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '100',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f12',
      fs: 'm:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048',
      fields: 'f12,f14,f2,f3,f4',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/gridlist.html'),
  )
  const diff = json.data?.diff ?? []
  const rows = diff.map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  return { rows, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] }
}

// Shared eastmoney /qt/stock/get quote — works for any market once given a
// secid (`{market}.{code}`, e.g. 1.600519 沪A, 0.000001 深A, 116.00700 港股,
// 105.AAPL 美股). Source: stock_bid_ask_em / stock_individual_info_em.
const EM_QUOTE_FIELDS = 'f43,f57,f58,f169,f170,f46,f44,f45,f60,f47,f48'

async function emQuoteBySecid(secid: string, ctx: ProviderContext, referer?: string): Promise<StockQuote> {
  const json = await httpGetJson<{ data?: Record<string, unknown> }>(
    'https://push2.eastmoney.com/api/qt/stock/get',
    { fltt: '2', invt: '2', fields: EM_QUOTE_FIELDS, secid },
    opts(ctx, referer ?? 'https://quote.eastmoney.com/'),
  )
  const d = json.data
  if (!d) throw new Error('empty stock/get data')
  return {
    code: String(d.f57 ?? secid),
    name: d.f58 != null ? String(d.f58) : undefined,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    raw: d,
  }
}

async function emStockGet(args: Record<string, unknown>, ctx: ProviderContext) {
  const raw = String(args.code ?? '600519')
  const code = normalizeCode(raw)
  const referer = `https://quote.eastmoney.com/${emSecMarket(raw) === 1 ? 'sh' : 'sz'}${code}.html`
  const quote = await emQuoteBySecid(`${emSecMarket(raw)}.${code}`, ctx, referer)
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Alias provider id for individual info — same endpoint, probe separately. */
async function emIndividualInfo(args: Record<string, unknown>, ctx: ProviderContext) {
  return emStockGet(args, ctx)
}

// Shared eastmoney push2his kline — works for any market via secid.
// Source: stock_zh_a_hist / stock_hk_hist / stock_us_hist (same endpoint).
async function emKlineBySecid(secid: string, args: Record<string, unknown>, ctx: ProviderContext): Promise<KlineBar[]> {
  const period = String(args.period ?? 'daily')
  const periodMap: Record<string, string> = { daily: '101', week: '102', weekly: '102', month: '103', monthly: '103' }
  const adjust = String(args.adjust ?? 'qfq')
  const adjustMap: Record<string, string> = { qfq: '1', hfq: '2', '': '0' }
  const end = String(args.end ?? new Date().toISOString().slice(0, 10)).replace(/-/g, '')
  const start = String(
    args.start ?? new Date(Date.now() - Number(args.days ?? 60) * 86400000).toISOString().slice(0, 10),
  ).replace(/-/g, '')

  const json = await httpGetJson<{ data?: { klines?: string[] } }>(
    'https://push2his.eastmoney.com/api/qt/stock/kline/get',
    {
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116',
      ut: '7eea3edcaed734bea9cbfc24409ed989',
      klt: periodMap[period] ?? '101',
      fqt: adjustMap[adjust] ?? '1',
      secid,
      beg: start,
      end,
    },
    opts(ctx, 'https://quote.eastmoney.com/'),
  )
  return (json.data?.klines ?? []).map((line) => {
    const [date, open, close, high, low, volume] = line.split(',')
    return { date: date!, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume) }
  })
}

async function emKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const raw = String(args.code ?? '600519')
  const code = normalizeCode(raw)
  // 指数必须保留 sh 前缀语义：marketCode('000300') 会误判深市，基准 sh000300 依赖 1.000300。
  const bars = await emKlineBySecid(`${emSecMarket(raw)}.${code}`, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// Shared tencent kline — symbol is `sh600519`/`sz000001` (A) or `hk00700` (HK).
// Source: akshare stock_zh_a_hist_tx (same endpoint serves HK via hk-prefix).
async function txKlineBySymbol(symbol: string, args: Record<string, unknown>, ctx: ProviderContext): Promise<KlineBar[]> {
  const year = new Date().getFullYear()
  const adjust = String(args.adjust ?? 'qfq')
  const text = await httpGetText(
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
    { _var: `kline_day${adjust}${year}`, param: `${symbol},day,${year}-01-01,${year}-12-31,640,${adjust}`, r: '0.82' },
    opts(ctx, 'https://gu.qq.com/'),
  )
  const jsonStart = text.indexOf('={')
  if (jsonStart < 0) throw new Error('tencent kline: unexpected payload')
  const payload = JSON.parse(text.slice(jsonStart + 1)) as {
    data?: Record<string, { day?: string[][]; qfqday?: string[][]; hfqday?: string[][] }>
  }
  const block = payload.data?.[symbol]
  // Never silently relabel unadjusted/forward-adjusted bars as hfq.
  const day = adjust === 'hfq' ? block?.hfqday : adjust === 'qfq' ? block?.qfqday : block?.day
  if (!day?.length) throw new Error('tencent kline: empty day series')
  return day.map((row) => ({
    date: String(row[0]),
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    volume: Number(row[5]),
  }))
}

async function txKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const raw = String(args.code ?? '600519').trim()
  // 显式 sh/sz/hk 前缀原样保留（toTxSymbol 的首字符启发式会把 sh000300 错判成 sz000300）。
  const symbol = /^(sh|sz|bj|hk)[0-9]/i.test(raw) ? raw.toLowerCase() : toTxSymbol(normalizeCode(raw))
  const bars = await txKlineBySymbol(symbol, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

/**
 * Source: akshare.index.index_stock_zh.__stock_zh_main_spot_em
 * (沪深重要指数 — small list, good for probe)
 */
async function emIndexMain(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '100',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      dect: '1',
      wbp2u: '|0|0|0|web',
      fid: '',
      fs: 'b:MK0010',
      fields: 'f2,f3,f4,f12,f14',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/hszs.html'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  return { rows, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] }
}

/**
 * 全球主要指数（东财 push2 qt/stock/get）。一个 secid 一个请求；解析、短缓存、
 * 小并发与行级容错都在 global-indices.ts（可注入 fetchJson 离线测试）。
 * 整体全部失败时抛错交给 registry 记录/回退；单行失败保留在该行 error 里。
 */
async function emGlobalIndices(args: Record<string, unknown>, ctx: ProviderContext) {
  const report = await fetchGlobalIndices({
    region: args.region ?? 'us',
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })
  if (!report.ok) throw new Error(report.error ?? `全球指数行情不可用（region=${String(report.region ?? '')}）`)
  return { data: report, rows: report.rows, sampleKeys: ['ok', 'at', 'region', 'rows', 'cacheHits', 'failed'] }
}

/**
 * Source: akshare.stock_fundamental.stock_finance_sina.stock_financial_analysis_indicator_em
 * URL: https://datacenter.eastmoney.com/securities/api/data/get
 */
async function emMainFinadata(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = normalizeCode(String(args.code ?? '600519'))
  const secu = toSecuCode(code)
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    'https://datacenter.eastmoney.com/securities/api/data/get',
    {
      type: 'RPT_F10_FINANCE_MAINFINADATA',
      sty: 'APP_F10_MAINFINADATA',
      quoteColumns: '',
      filter: `(SECUCODE="${secu}")`,
      p: '1',
      ps: '5',
      sr: '-1',
      st: 'REPORT_DATE',
      source: 'HSF10',
      client: 'PC',
    },
    opts(ctx, 'https://emweb.securities.eastmoney.com/'),
  )
  const rows = json.result?.data ?? []
  if (!rows.length) throw new Error('empty financial main data')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- T4 东财 F10 七维（仅 A 股）----
// 规范化/口径在 eastmoney-f10.ts（纯函数、fixture 固定契约）；这里只做抓取。
// PageAjax code=SH601988 已于2026-11-17实测；单维度归一化契约仍分别保留核验状态。

function assertF10Code(code: unknown): string {
  const c = normalizeCode(String(code ?? ''))
  if (!isAShareCode(c)) throw new Error(`F10 仅支持 A 股（含北交所），不支持：${code}`)
  return c
}

async function emF10PageAjax(moduleUrl: string, code: unknown, ctx: ProviderContext): Promise<unknown> {
  const secu = toSecuCode(assertF10Code(code))
  return httpGetJson<Record<string, unknown>>(
    moduleUrl,
    { code: secu.split('.').reverse().join('') },
    opts(ctx, 'https://emweb.securities.eastmoney.com/'),
  )
}

async function emF10Survey(args: Record<string, unknown>, ctx: ProviderContext) {
  const data = normalizeCompanySurvey(await emF10PageAjax(F10_ENDPOINTS.companySurvey, args.code, ctx))
  if (!data.name && !data.orgName && !data.profile) throw new Error('F10公司概况未返回业务字段（非可用资料），请检查上游响应')
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Business(args: Record<string, unknown>, ctx: ProviderContext) {
  const data = normalizeBusinessComposition(await emF10PageAjax(F10_ENDPOINTS.businessAnalysis, args.code, ctx))
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Concepts(args: Record<string, unknown>, ctx: ProviderContext) {
  const data = normalizeCoreConcepts(await emF10PageAjax(F10_ENDPOINTS.coreConception, args.code, ctx))
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Holders(args: Record<string, unknown>, ctx: ProviderContext) {
  const data = normalizeShareholderCount(await emF10PageAjax(F10_ENDPOINTS.shareholderResearch, args.code, ctx))
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Financials(args: Record<string, unknown>, ctx: ProviderContext) {
  const secu = toSecuCode(assertF10Code(args.code))
  const ps = Math.min(Math.max(Number(args.pageSize ?? 14), 1), 50)
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    F10_ENDPOINTS.mainFinancials,
    {
      type: 'RPT_F10_FINANCE_MAINFINADATA',
      sty: 'APP_F10_MAINFINADATA',
      filter: `(SECUCODE="${secu}")`,
      p: '1', ps: String(ps), sr: '-1', st: 'REPORT_DATE',
      source: 'HSF10', client: 'PC',
    },
    opts(ctx, 'https://emweb.securities.eastmoney.com/'),
  )
  const data = normalizeMainFinancials({ result: json.result })
  if (!data.rows.length) throw new Error('F10主要财务指标返回空表，未取得有效报告期数据')
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Valuation(args: Record<string, unknown>, ctx: ProviderContext) {
  const secu = toSecuCode(assertF10Code(args.code))
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    F10_ENDPOINTS.valuation,
    {
      reportName: 'RPT_VALUEANALYSIS_DET',
      columns: 'ALL',
      filter: `(SECUCODE="${secu}")`,
      pageNumber: '1', pageSize: String(Math.min(Math.max(Number(args.pageSize ?? 500), 10), 2000)),
      sortColumns: 'TRADE_DATE', sortTypes: '-1',
      source: 'WEB', client: 'WEB',
    },
    opts(ctx, 'https://data.eastmoney.com/'),
  )
  const data = normalizeValuation({ result: json.result }, {
    windowDays: Number(args.windowDays ?? 1825),
    minSamples: Number(args.minSamples ?? 60),
  })
  return { data, sampleKeys: Object.keys(data) }
}

async function emF10Peers(args: Record<string, unknown>, ctx: ProviderContext) {
  // IndustryAnalysis/PageAjax structure probed on 2026-11-17; peers use CORRE_SECURITY_CODE.
  const data = normalizePeers(await emF10PageAjax(F10_ENDPOINTS.peerComparison, args.code, ctx))
  if (!data.rows.length) throw new Error('F10同行比较未取得有效可比公司记录')
  return { data, sampleKeys: Object.keys(data) }
}

/**
 * Source: akshare.stock.stock_board_industry_em.stock_board_industry_name_em
 * URL: https://17.push2.eastmoney.com/api/qt/clist/get (first page)
 */
async function emIndustryBoard(args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '50',
      po: String(args.order === 'asc' ? '0' : '1'), // 1=涨幅榜, 0=跌幅榜
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:90 t:2 f:!50',
      fields: 'f2,f3,f4,f12,f14',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/boardlist.html'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  if (!rows.length) throw new Error('empty industry board')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 通用：证券代码解析（东财 suggest，跨 A股/港股/美股/名称）----
// Source: eastmoney searchapi suggest (used internally by many akshare fns).
const secidCache = new Map<string, SymbolMatch | null>()

async function emSuggestMatches(keyword: string, ctx: ProviderContext, limit = 8): Promise<SymbolMatch[]> {
  const json = await httpGetJson<{ QuotationCodeTable?: { Data?: Array<Record<string, unknown>> } }>(
    'https://searchapi.eastmoney.com/api/suggest/get',
    { input: keyword, type: '14', count: String(limit), token: 'D43BF722C8E33BDC906FB84D85E326E8' },
    opts(ctx),
  )
  return (json.QuotationCodeTable?.Data ?? [])
    .filter((d) => d.QuoteID)
    .map((d) => ({ code: String(d.Code ?? ''), name: String(d.Name ?? ''), secid: String(d.QuoteID), market: String(d.SecurityTypeName ?? '') }))
}

async function emResolveSecid(keyword: string, ctx: ProviderContext, filter?: (m: SymbolMatch) => boolean): Promise<SymbolMatch | undefined> {
  const key = `${keyword.trim()}|${filter ? 'f' : ''}`
  if (secidCache.has(key)) return secidCache.get(key) ?? undefined
  const matches = await emSuggestMatches(keyword.trim(), ctx)
  const pick = filter ? matches.find(filter) : matches[0]
  secidCache.set(key, pick ?? null)
  return pick
}

async function emSuggest(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.query ?? args.code ?? '').trim()
  if (!kw) throw new Error('empty search query')
  const rawLimit = Number(args.limit ?? 8)
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 8
  const matches = await emSuggestMatches(kw, ctx, limit)
  if (!matches.length) throw new Error(`no symbol match for ${kw}`)
  return { rows: matches, data: matches, sampleKeys: Object.keys(matches[0]!) }
}

// ---- 港股（东财，secid 市场号 116）----
function hkCode(code: string): string {
  return String(code).trim().replace(/\D/g, '').padStart(5, '0').slice(-5)
}

/** Source: akshare stock_bid_ask_em (HK secid 116). */
async function emHkQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const quote = await emQuoteBySecid(`116.${code}`, ctx, `https://quote.eastmoney.com/hk/${code}.html`)
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Source: akshare stock_hk_hist (HK secid 116). */
async function emHkKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const bars = await emKlineBySecid(`116.${code}`, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// 港股腾讯兜底：gtimg 实时行情（GBK）+ qq 日 K（hk 前缀）。
async function txHkQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = hkCode(String(args.code ?? '00700'))
  const text = await httpGetText('https://qt.gtimg.cn/q=hk' + code, {}, { ...opts(ctx, 'https://gu.qq.com/'), encoding: 'gbk' })
  const m = text.match(/="([^"]*)"/)
  if (!m) throw new Error('tencent hk quote: unexpected payload')
  const f = m[1]!.split('~')
  const price = num(f[3])
  if (price == null) throw new Error('tencent hk quote: no price')
  const quote: StockQuote = {
    code: String(f[2] || code),
    name: f[1] || undefined,
    price,
    change: num(f[31]),
    changePercent: num(f[32]),
    raw: { fields: f },
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function txHkKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const bars = await txKlineBySymbol('hk' + hkCode(String(args.code ?? '00700')), args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

/** Source: akshare stock_hk_spot_em (港股实时行情列表，clist m:128 首页). */
async function emHkClist(_args: Record<string, unknown>, ctx: ProviderContext) {
  const json = await httpGetJson<{ data?: { diff?: Array<Record<string, unknown>> } }>(
    'https://push2.eastmoney.com/api/qt/clist/get',
    {
      pn: '1',
      pz: '50',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:128 t:3,m:128 t:4,m:128 t:1,m:128 t:2',
      fields: 'f12,f14,f2,f3,f4',
    },
    opts(ctx, 'https://quote.eastmoney.com/center/gridlist.html#hk_stocks'),
  )
  const rows = (json.data?.diff ?? []).map((d) => ({
    code: String(d.f12 ?? ''),
    name: String(d.f14 ?? ''),
    price: num(d.f2),
    changePercent: num(d.f3),
    change: num(d.f4),
  }))
  if (!rows.length) throw new Error('empty hk list')
  return { rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 美股（东财 fallback；Yahoo 限流时经此路）----
/** Source: akshare stock_us_spot_em/stock_us_hist — ticker resolved to secid. */
async function emUsQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? 'AAPL').trim()
  const m = await emResolveSecid(kw, ctx, (x) => x.market === '美股')
  if (!m) throw new Error(`us symbol not resolved: ${kw}`)
  const quote = await emQuoteBySecid(m.secid, ctx, `https://quote.eastmoney.com/us/${m.code}.html`)
  quote.name ??= m.name
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function emUsKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? 'AAPL').trim()
  const m = await emResolveSecid(kw, ctx, (x) => x.market === '美股')
  if (!m) throw new Error(`us symbol not resolved: ${kw}`)
  const bars = await emKlineBySecid(m.secid, args, ctx)
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// ---- 个股档案（东财，行情 + 市值字段；跨市场经 suggest 解析）----
const EM_INFO_FIELDS = 'f43,f57,f58,f60,f46,f44,f45,f47,f48,f116,f117,f84,f85,f169,f170'

/** Source: akshare stock_individual_info_em (基本面字段: 市值/股本等). */
async function emStockInfo(args: Record<string, unknown>, ctx: ProviderContext) {
  const kw = String(args.code ?? args.query ?? '600519').trim()
  const m = await emResolveSecid(kw, ctx)
  const secid = m?.secid ?? `${marketCode(normalizeCode(kw))}.${normalizeCode(kw)}`
  const json = await httpGetJson<{ data?: Record<string, unknown> }>(
    'https://push2.eastmoney.com/api/qt/stock/get',
    { fltt: '2', invt: '2', fields: EM_INFO_FIELDS, secid },
    opts(ctx),
  )
  const d = json.data
  if (!d) throw new Error('empty stock info')
  const info: StockInfo = {
    code: String(d.f57 ?? m?.code ?? kw),
    name: d.f58 != null ? String(d.f58) : m?.name,
    market: m?.market,
    price: num(d.f43),
    change: num(d.f169),
    changePercent: num(d.f170),
    prevClose: num(d.f60),
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    volume: num(d.f47),
    turnover: num(d.f48),
    marketCap: num(d.f116),
    floatMarketCap: num(d.f117),
    totalShares: num(d.f84),
    floatShares: num(d.f85),
  }
  return { rows: [info], data: info, sampleKeys: Object.keys(info) }
}

/**
 * Source: Yahoo Finance chart API v8 (free, no key).
 * URL: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 */
async function yahooQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = String(args.code ?? 'AAPL').trim().toUpperCase()
  const json = await yahooChart(symbol, { range: '1d', interval: '1d' }, ctx)
  const meta = json.chart?.result?.[0]?.meta
  if (!meta) throw new Error(json.chart?.error?.description ?? 'empty yahoo chart')
  const price = num(meta.regularMarketPrice)
  const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose)
  const quote: StockQuote = {
    code: String(meta.symbol ?? symbol),
    name: meta.shortName != null ? String(meta.shortName) : (meta.longName != null ? String(meta.longName) : undefined),
    price,
    change: price != null && prev != null ? Number((price - prev).toFixed(4)) : undefined,
    changePercent: price != null && prev ? Number((((price - prev) / prev) * 100).toFixed(4)) : undefined,
    raw: meta,
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

/** Source: Yahoo Finance chart API v8 (timestamp + OHLCV series). */
async function yahooKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const symbol = String(args.code ?? 'AAPL').trim().toUpperCase()
  const period = String(args.period ?? 'daily')
  const intervalMap: Record<string, string> = { daily: '1d', week: '1wk', weekly: '1wk', month: '1mo', monthly: '1mo' }
  const now = Math.floor(Date.now() / 1000)
  const period2 = args.end ? Math.floor(new Date(String(args.end)).getTime() / 1000) : now
  const period1 = args.start
    ? Math.floor(new Date(String(args.start)).getTime() / 1000)
    : period2 - Number(args.days ?? 120) * 86400
  const json = await yahooChart(symbol, { period1, period2, interval: intervalMap[period] ?? '1d' }, ctx)
  const result = json.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const q = result?.indicators?.quote?.[0] ?? {}
  const bars: KlineBar[] = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: Number(q.open?.[i]),
    close: Number(q.close?.[i]),
    high: Number(q.high?.[i]),
    low: Number(q.low?.[i]),
    volume: Number(q.volume?.[i]),
  })).filter((b) => Number.isFinite(b.close))
  if (!bars.length) throw new Error('empty yahoo kline')
  return { rows: bars, sampleKeys: Object.keys(bars[0]!) }
}

function searchQuery(args: Record<string, unknown>): string {
  const query = String(args.query ?? args.q ?? '').trim()
  if (!query) throw new Error('empty search query')
  return query
}

/** 解析 Bing RSS（纯函数，可离线测试）：提取 title/link/description 并还原实体转义。 */
/** 还原 XML 文本：CDATA 包裹 + 实体转义（Bing RSS 两者都会出现）。 */
function decodeXmlText(s: string): string {
  return s
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .trim()
}

/** 取一个 XML 标签的文本（不用正则转义，避免 `\s` 之类的转义陷阱）。 */
function pickXmlTag(item: string, tag: string): string {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const a = item.indexOf(open)
  if (a < 0) return ''
  const from = a + open.length
  const b = item.indexOf(close, from)
  return decodeXmlText(b < 0 ? item.slice(from) : item.slice(from, b))
}

/** 解析 Bing RSS（纯函数，可离线测试）：提取 title/link/description。 */
export function parseBingRss(xml: string, max = 10): SearchResult[] {
  const limit = Math.max(1, max)
  const out: SearchResult[] = []
  for (const chunk of xml.split('<item>').slice(1)) {
    const end = chunk.indexOf('</item>')
    const item = end >= 0 ? chunk.slice(0, end) : chunk
    const title = pickXmlTag(item, 'title')
    const url = pickXmlTag(item, 'link')
    if (!title || !url) continue
    out.push({ title, url, snippet: pickXmlTag(item, 'description').slice(0, 300), source: 'Bing' })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 回补数据源：Node 原生网页搜索（Bing RSS）。
 * 之前唯一实现是 Python `ddgs`，但宿主机没装（pip 依赖不可控），web_search 长期不可用。
 * Bing 的 `&format=rss` 输出是稳定的 XML，Node 侧直接解析即可，零安装成本。
 */
async function rssWebSearch(args: Record<string, unknown>, ctx: ProviderContext) {
  const query = searchQuery(args)
  const max = Number(args.size ?? args.maxResults ?? 10)
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.min(30, Math.max(1, max))}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: ctx.signal,
  })
  if (!res.ok) throw new Error(`bing rss http ${res.status}`)
  const results = parseBingRss(await res.text(), max)
  if (!results.length) throw new Error('bing rss: empty')
  return { rows: results, data: results, sampleKeys: Object.keys(results[0]!) }
}

/**
 * Python ddgs + primp → Bing/Google/Yandex (no DuckDuckGo)。
 * 作为可选增强：装了 ddgs 就能拿到多引擎结果，没装也不影响搜索能力。
 */
async function pyWebSearch(args: Record<string, unknown>, ctx: ProviderContext) {
  const query = searchQuery(args)
  const script = path.join(PKG_ROOT, 'scripts', 'web_search.py')
  const { stdout } = await execFileAsync('python3', [script, query], {
    timeout: ctx.timeoutMs,
    signal: ctx.signal,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const parsed = JSON.parse(stdout.trim()) as { results?: SearchResult[]; error?: string }
  if (parsed.error) throw new Error(parsed.error)
  const results = (parsed.results ?? []).filter((r) => r.title)
  if (!results.length) throw new Error('py web search: empty')
  return { rows: results, data: results, sampleKeys: Object.keys(results[0]!) }
}

// ---- 基金（东财 pingzhongdata：净值走势 + 画像数据，免费直连）----
interface FundData {
  name?: string
  navTrend: Array<{ date: string; nav: number }>
  profile: Record<string, unknown>
}
// 净值与画像都在 pingzhongdata.js（数百 KB）里：净值日频更新、画像更慢，5 分钟
// 缓存足够新；同码并发请求合并成一个 promise，避免多基金持仓首屏重复拉同一文件。
const FUND_DATA_TTL_MS = 5 * 60_000
const fundCache = new Map<string, { at: number; data: Promise<FundData> }>()

function fundCode(code: string): string {
  return String(code).replace(/\D/g, '').padStart(6, '0').slice(-6)
}

function parseFundVariable<T>(text: string, name: string): T | undefined {
  const match = text.match(new RegExp(`${name}\\s*=\\s*([\\[{][\\s\\S]*?);`))
  if (!match) return undefined
  try {
    return JSON.parse(match[1]!) as T
  } catch {
    return undefined
  }
}

// Source: fund.eastmoney.com pingzhongdata (Data_netWorthTrend + fS_name).
function emFundData(code: string, ctx: ProviderContext): Promise<FundData> {
  const c = fundCode(code)
  const hit = fundCache.get(c)
  if (hit && Date.now() - hit.at < FUND_DATA_TTL_MS) return hit.data
  const pending = (async (): Promise<FundData> => {
    const text = await httpGetText(`https://fund.eastmoney.com/pingzhongdata/${c}.js`, {}, opts(ctx, 'https://fund.eastmoney.com/'))
    const nameM = text.match(/fS_name\s*=\s*"([^"]*)"/)
    const trendM = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/)
    const navTrend: Array<{ date: string; nav: number }> = []
    if (trendM) {
      const arr = JSON.parse(trendM[1]!) as Array<{ x: number; y: number }>
      for (const p of arr) {
        const nav = num(p.y)
        if (nav != null) navTrend.push({ date: new Date(p.x).toISOString().slice(0, 10), nav })
      }
    }
    if (!navTrend.length) throw new Error(`fund ${c}: empty nav trend`)
    const profile: Record<string, unknown> = {}
    const profileKeys = [
      'Data_assetAllocation',
      'Data_buySedemption',
      'Data_currentFundManager',
      'Data_fluctuationScale',
      'Data_holderStructure',
      'Data_performanceEvaluation',
      'Data_rateInSimilarPersent',
      'Data_rateInSimilarType',
    ]
    for (const key of profileKeys) {
      const value = parseFundVariable<unknown>(text, key)
      if (value !== undefined) {
        profile[key.slice('Data_'.length)] = Array.isArray(value) ? value.slice(-180) : value
      }
    }
    const grandTotal = parseFundVariable<unknown[]>(text, 'Data_grandTotal')
    if (grandTotal) profile.grandTotal = grandTotal.slice(-180)
    return { name: nameM?.[1] || undefined, navTrend, profile }
  })()
  fundCache.set(c, { at: Date.now(), data: pending })
  // 失败不缓存：踢掉后下一个调用方重试（并发中的调用方共享同一错误）。
  pending.catch(() => {
    if (fundCache.get(c)?.data === pending) fundCache.delete(c)
  })
  return pending
}

async function emFundQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const code = fundCode(String(args.code ?? ''))
  const fd = await emFundData(code, ctx)
  const last = fd.navTrend.at(-1)!
  const prev = fd.navTrend.at(-2)
  const quote: StockQuote = {
    code,
    name: fd.name,
    price: last.nav,
    change: prev ? Number((last.nav - prev.nav).toFixed(4)) : undefined,
    changePercent: prev && prev.nav ? Number((((last.nav - prev.nav) / prev.nav) * 100).toFixed(2)) : undefined,
    // 净值日期 = 数据时点：面板据此标「T+1 待更新」，避免把昨日净值当实时价。
    asOf: last.date,
    raw: { navDate: last.date, profile: fd.profile },
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function emFundKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const fd = await emFundData(String(args.code ?? ''), ctx)
  // 净单位置无成交量：volume=0 仅作占位，必须标记 volumeMissing，不能当成零成交。
  const bars: KlineBar[] = fd.navTrend
    .filter((p) => Number.isFinite(p.nav) && p.nav > 0)
    .map((p) => ({ date: p.date, open: p.nav, high: p.nav, low: p.nav, close: p.nav, volume: 0, volumeMissing: true }))
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// ---- 宏观（东财 datacenter-web，中国月度/季度经济指标）----
interface MacroSeriesDef { report: string; unit: string; headline: string; label: string }
const MACRO_SERIES: Record<string, MacroSeriesDef> = {
  cpi: { report: 'RPT_ECONOMY_CPI', unit: '%', headline: 'NATIONAL_SAME', label: '全国 CPI 同比' },
  ppi: { report: 'RPT_ECONOMY_PPI', unit: '%', headline: 'BASE_SAME', label: 'PPI 同比' },
  pmi: { report: 'RPT_ECONOMY_PMI', unit: '', headline: 'MAKE_INDEX', label: '制造业 PMI' },
  gdp: { report: 'RPT_ECONOMY_GDP', unit: '%', headline: 'SUM_SAME', label: 'GDP 同比' },
  money_supply: { report: 'RPT_ECONOMY_CURRENCY_SUPPLY', unit: '%', headline: 'BASIC_CURRENCY_SAME', label: 'M2 同比' },
}
export const MACRO_SERIES_KEYS = Object.keys(MACRO_SERIES)

// Source: eastmoney datacenter-web api/data/v1/get (akshare macro_china_* 系列同源).
async function emMacro(args: Record<string, unknown>, ctx: ProviderContext) {
  const series = String(args.series ?? 'cpi')
  const def = MACRO_SERIES[series] ?? MACRO_SERIES.cpi!
  const json = await httpGetJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    'https://datacenter-web.eastmoney.com/api/data/v1/get',
    { columns: 'ALL', pageNumber: '1', pageSize: '24', sortColumns: 'REPORT_DATE', sortTypes: '-1', reportName: def.report },
    opts(ctx, 'https://data.eastmoney.com/'),
  )
  const rows = json.result?.data ?? []
  if (!rows.length) throw new Error(`macro ${series}: empty`)
  const points = rows.map((r) => ({ time: String(r.TIME ?? ''), value: num(r[def.headline]) })).reverse()
  const data = {
    series,
    label: def.label,
    unit: def.unit,
    latest: points.at(-1),
    points,
    rows: rows.slice(0, 6),
  }
  return { rows, data, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 全球宏观（OECD SDMX / Eurostat / World Bank / ECB data-api，结构化统计接口）----
// 解析器在 global-macro.ts（纯函数、fixture 离线测试）；这里只负责 HTTP、序列选取与缓存。
// 本机实测（2026-11-17）：OECD sdmx.oecd.org 的数据查询 JSON 表示返回 HTTP 500，
// genericdata XML 正常，因此 us_cpi 先请求 SDMX-JSON，失败/无值再回退 XML 并在 notes 注明。
// BLS/CNBC 在本机 403，未接入；WeStock CLI 在本机不可执行，也不作为宏观来源。

export const EURO_AREA_GEO_CODES: readonly string[] = ['EA21', 'EA20', 'EA19', 'EA']

const OECD_JSON_ACCEPT = 'application/vnd.sdmx.data+json;version=2.0.0'
const OECD_XML_ACCEPT = 'application/vnd.sdmx.genericdata+xml;version=2.1'
const GLOBAL_MACRO_CACHE_TTL_MS = 10 * 60_000
const GLOBAL_MACRO_FAILURE_TTL_MS = 60_000

/** 可注入的 HTTP 层：测试用假的 json/text，生产用 httpGetJson/httpGetText（自动带 UA/超时）。 */
export interface GlobalMacroHttp {
  json: (
    url: string,
    params: Record<string, string | number | undefined>,
    options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<unknown>
  text: (
    url: string,
    params: Record<string, string | number | undefined>,
    options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<string>
}

interface GlobalMacroFetchContext {
  timeoutMs: number
  signal?: AbortSignal
}

const DEFAULT_GLOBAL_MACRO_HTTP: GlobalMacroHttp = { json: httpGetJson, text: httpGetText }

function globalMacroErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/\s+/g, ' ').slice(0, 240)
}

/** 当前 UTC 月份往前推 N 个月的月初（YYYY-MM），用于构造 startPeriod/sinceTimePeriod。 */
function monthStartUtc(monthsBack: number): string {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** OECD SDMX 数据查询（DSD_PRICES：USA / 月度 / 国家CPI / 百分比 / 全部项目 / 未季调 / 同比）。 */
export function oecdCpiUrl(startPeriod: string): string {
  const key = 'USA.M.N.CPI.PA._T.N.GY'
  return `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/${key}?startPeriod=${encodeURIComponent(startPeriod)}`
}

/** Eurostat dissemination API：多欧元区聚合口径用重复 geo 参数（`+` 会被解析成空格）。 */
export function eurostatUrl(
  dataset: 'prc_hicp_manr' | 'une_rt_m',
  sinceTimePeriod: string,
  geos: readonly string[] = EURO_AREA_GEO_CODES,
): string {
  const base = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}?format=JSON&lang=en`
  const filter = dataset === 'prc_hicp_manr' ? '&coicop=CP00' : '&s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT'
  const geoQuery = geos.map((geo) => `&geo=${encodeURIComponent(geo)}`).join('')
  return `${base}${filter}${geoQuery}&sinceTimePeriod=${encodeURIComponent(sinceTimePeriod)}`
}

/** World Bank Indicators API（年度实际 GDP 增速；欧元区用 EMU 聚合）。 */
export function worldBankGdpUrl(country: 'USA' | 'EMU'): string {
  return `https://api.worldbank.org/v2/country/${country}/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=20`
}

/** ECB Data Portal：存款便利利率（DFR）日频水平值。 */
export function ecbDfrUrl(startPeriod: string): string {
  return `https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?format=jsondata&startPeriod=${encodeURIComponent(startPeriod)}`
}

async function fetchOecdUsCpi(ctx: GlobalMacroFetchContext, http: GlobalMacroHttp): Promise<GlobalMacroSeries> {
  const fetchedAt = new Date().toISOString()
  const url = oecdCpiUrl(monthStartUtc(36))
  const attempts: string[] = []
  let parsed: SeriesParseResult | undefined
  let representation: GlobalMacroRepresentation = 'sdmx-json'
  let representationNote: string | undefined

  try {
    const payload = await http.json(url, {}, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: OECD_JSON_ACCEPT } })
    const candidate = parseSdmxJsonDataset(payload, { frequency: 'monthly' })
    if (hasObservableValue(candidate)) parsed = candidate
    else attempts.push(`SDMX-JSON 无有效观测（${candidate.issues[0] ?? '空结果'}）`)
  } catch (err) {
    attempts.push(`SDMX-JSON: ${globalMacroErrorText(err)}`)
  }

  if (!parsed) {
    try {
      const xml = await http.text(url, {}, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: OECD_XML_ACCEPT } })
      parsed = parseSdmxGenericXml(xml, { frequency: 'monthly' })
      representation = 'sdmx-generic-xml'
      representationNote = `OECD SDMX-JSON 表示不可用（${attempts.join('；')}），本次回退 genericdata XML 解析`
    } catch (err) {
      return globalMacroFailure(
        'us_cpi',
        `OECD SDMX 获取失败：${[...attempts, `XML: ${globalMacroErrorText(err)}`].join('；')}`,
        fetchedAt,
      )
    }
  }

  const group = pickParsedSeriesGroup(parsed.groups)
  if (!group) {
    return globalMacroFailure('us_cpi', `OECD SDMX 无可用观测：${parsed.issues.join('；') || '序列为空'}`, fetchedAt)
  }
  return assembleGlobalMacroSeries({
    series: 'us_cpi',
    observations: group.observations,
    representation,
    fetchedAt,
    provenance: {
      provider: 'oecd_sdmx',
      endpoint: url,
      dataset: 'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0',
      indicator: 'USA.M.N.CPI.PA._T.N.GY（全部项目、未季调、同比）',
      geography: 'USA',
      frequency: 'monthly',
      statisticsTimeField: 'TIME_PERIOD',
      ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
      ...(group.key ? { seriesKey: group.key } : {}),
    },
    ...(representationNote ? { extraNotes: [representationNote] } : {}),
    limit: GLOBAL_MACRO_MAX_POINTS,
  })
}

async function fetchEurostatSeries(
  seriesKey: 'ea_hicp' | 'ea_unemployment',
  ctx: GlobalMacroFetchContext,
  http: GlobalMacroHttp,
): Promise<GlobalMacroSeries> {
  const fetchedAt = new Date().toISOString()
  const meta = GLOBAL_MACRO_SERIES_META[seriesKey]
  const dataset = seriesKey === 'ea_hicp' ? 'prc_hicp_manr' : 'une_rt_m'
  const url = eurostatUrl(dataset, monthStartUtc(48))
  try {
    const payload = await http.json(url, {}, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: 'application/json' } })
    const parsed = parseJsonStatDataset(payload, { frequency: 'monthly', seriesDimension: 'geo' })
    const group = pickParsedSeriesGroup(parsed.groups, EURO_AREA_GEO_CODES)
    if (!group) {
      return globalMacroFailure(seriesKey, `Eurostat ${dataset} 无可用观测：${parsed.issues.join('；') || '序列为空'}`, fetchedAt)
    }
    const geoLabel = group.label ? `${group.label}（${group.key ?? ''}）` : (group.key ?? meta.geography)
    const notes = parsed.groups.length > 1
      ? [`源内返回 ${parsed.groups.length} 个地理口径，按「最新有效统计期 → 观测数 → 首选顺序」选中 ${group.key ?? '默认组'}`]
      : []
    return assembleGlobalMacroSeries({
      series: seriesKey,
      observations: group.observations,
      representation: 'jsonstat',
      fetchedAt,
      provenance: {
        provider: 'eurostat',
        endpoint: url,
        dataset,
        indicator: seriesKey === 'ea_hicp' ? 'CP00 / RCH_A（年度变化率）' : 'TOTAL / SA / PC_ACT（季调失业率）',
        geography: geoLabel,
        frequency: 'monthly',
        statisticsTimeField: 'time',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
        ...(group.key ? { seriesKey: group.key } : {}),
      },
      extraNotes: notes,
      limit: GLOBAL_MACRO_MAX_POINTS,
    })
  } catch (err) {
    return globalMacroFailure(seriesKey, `Eurostat ${dataset} 获取失败：${globalMacroErrorText(err)}`, fetchedAt)
  }
}

async function fetchWorldBankGdp(
  seriesKey: 'us_gdp_growth' | 'ea_gdp_growth',
  country: 'USA' | 'EMU',
  ctx: GlobalMacroFetchContext,
  http: GlobalMacroHttp,
): Promise<GlobalMacroSeries> {
  const fetchedAt = new Date().toISOString()
  const url = worldBankGdpUrl(country)
  try {
    const payload = await http.json(url, {}, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, headers: { Accept: 'application/json' } })
    const parsed = parseWorldBankIndicator(payload)
    const group = pickParsedSeriesGroup(parsed.groups)
    if (!group) {
      return globalMacroFailure(seriesKey, `World Bank NY.GDP.MKTP.KD.ZG(${country}) 无可用观测：${parsed.issues.join('；') || '序列为空'}`, fetchedAt)
    }
    return assembleGlobalMacroSeries({
      series: seriesKey,
      observations: group.observations,
      representation: 'worldbank-json',
      fetchedAt,
      provenance: {
        provider: 'world_bank',
        endpoint: url,
        dataset: 'NY.GDP.MKTP.KD.ZG',
        indicator: `GDP growth, annual %（country=${country}）`,
        geography: country === 'EMU' ? 'EMU（Euro area）' : 'USA',
        frequency: 'annual',
        statisticsTimeField: 'date',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
        ...(group.key ? { seriesKey: group.key } : {}),
      },
      limit: GLOBAL_MACRO_MAX_POINTS,
    })
  } catch (err) {
    return globalMacroFailure(seriesKey, `World Bank NY.GDP.MKTP.KD.ZG(${country}) 获取失败：${globalMacroErrorText(err)}`, fetchedAt)
  }
}

async function fetchEcbPolicyRate(ctx: GlobalMacroFetchContext, http: GlobalMacroHttp): Promise<GlobalMacroSeries> {
  const fetchedAt = new Date().toISOString()
  const url = ecbDfrUrl(monthStartUtc(6))
  try {
    const payload = await http.json(url, {}, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      // ECB data-api 只接受 application/json 一类媒体类型；带 version 参数的 Accept 会 406。
      headers: { Accept: 'application/json' },
    })
    const parsed = parseSdmxJsonDataset(payload, { frequency: 'daily' })
    const group = pickParsedSeriesGroup(parsed.groups)
    if (!group) {
      return globalMacroFailure('ea_policy_rate', `ECB data-api 无可用观测：${parsed.issues.join('；') || '序列为空'}`, fetchedAt)
    }
    return assembleGlobalMacroSeries({
      series: 'ea_policy_rate',
      observations: group.observations,
      representation: 'sdmx-json',
      fetchedAt,
      provenance: {
        provider: 'ecb_data_api',
        endpoint: url,
        dataset: 'FM',
        indicator: 'D.U2.EUR.4F.KR.DFR.LEV（存款便利利率水平）',
        geography: 'Euro area（U2）',
        frequency: 'daily',
        statisticsTimeField: 'TIME_PERIOD',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
        ...(group.key ? { seriesKey: group.key } : {}),
      },
      limit: GLOBAL_MACRO_MAX_POINTS,
    })
  } catch (err) {
    return globalMacroFailure('ea_policy_rate', `ECB data-api 获取失败：${globalMacroErrorText(err)}`, fetchedAt)
  }
}

async function loadGlobalMacroSeries(
  key: GlobalMacroSeriesKey,
  ctx: GlobalMacroFetchContext,
  http: GlobalMacroHttp,
): Promise<GlobalMacroSeries> {
  try {
    switch (key) {
      case 'us_cpi':
        return await fetchOecdUsCpi(ctx, http)
      case 'ea_hicp':
      case 'ea_unemployment':
        return await fetchEurostatSeries(key, ctx, http)
      case 'us_gdp_growth':
        return await fetchWorldBankGdp(key, 'USA', ctx, http)
      case 'ea_gdp_growth':
        return await fetchWorldBankGdp(key, 'EMU', ctx, http)
      case 'ea_policy_rate':
        return await fetchEcbPolicyRate(ctx, http)
      default:
        return globalMacroFailure(key as GlobalMacroSeriesKey, `未知宏观序列：${String(key)}`, new Date().toISOString())
    }
  } catch (err) {
    return globalMacroFailure(key, `全球宏观序列 ${key} 获取异常：${globalMacroErrorText(err)}`, new Date().toISOString())
  }
}

interface GlobalMacroCacheEntry {
  at: number
  ttlMs: number
  value?: Promise<GlobalMacroSeries>
}

const globalMacroCache = new Map<GlobalMacroSeriesKey, GlobalMacroCacheEntry>()

/** 清空进程内宏观缓存（测试或手动刷新用）。 */
export function clearGlobalMacroCache(): void {
  globalMacroCache.clear()
}

/** 同一序列并发请求合并；成功缓存 10 分钟，失败只缓存 60 秒，避免反复等同一个坏源。 */
async function globalMacroSeriesWithCache(
  key: GlobalMacroSeriesKey,
  ctx: GlobalMacroFetchContext,
): Promise<{ series: GlobalMacroSeries; cached: boolean }> {
  const hit = globalMacroCache.get(key)
  if (hit?.value && Date.now() - hit.at < hit.ttlMs) {
    return { series: await hit.value, cached: true }
  }
  const entry: GlobalMacroCacheEntry = { at: Date.now(), ttlMs: GLOBAL_MACRO_CACHE_TTL_MS }
  entry.value = loadGlobalMacroSeries(key, ctx, DEFAULT_GLOBAL_MACRO_HTTP).then((series) => {
    entry.ttlMs = series.error ? GLOBAL_MACRO_FAILURE_TTL_MS : GLOBAL_MACRO_CACHE_TTL_MS
    return series
  })
  globalMacroCache.set(key, entry)
  return { series: await entry.value, cached: false }
}

export interface GlobalMacroQuery {
  /** 序列名列表（也接受逗号分隔字符串）；缺省=全部 6 条。 */
  series?: string[] | string
  /** 每条序列返回最近多少期，1..120，默认 24。 */
  limit?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 测试注入：给定时不走进程缓存，也不会访问真实网络。 */
  http?: GlobalMacroHttp
}

/**
 * 全球宏观报告：6 条序列并发取回，单条失败不影响其它序列；
 * 每条都带 source/unit/asOf(统计期)/fetchedAt/points/latest/provenance/notes。
 */
export async function fetchGlobalMacroReport(query: GlobalMacroQuery = {}): Promise<GlobalMacroReport> {
  const fetchedAt = new Date().toISOString()
  const request = normalizeSeriesRequest(query.series)
  const limit = clampGlobalMacroLimit(query.limit ?? GLOBAL_MACRO_DEFAULT_POINTS)
  const ctx: GlobalMacroFetchContext = {
    timeoutMs: Number.isFinite(Number(query.timeoutMs)) ? Number(query.timeoutMs) : GLOBAL_MACRO_TIMEOUT_MS,
    signal: query.signal,
  }
  const http = query.http
  const series = await Promise.all(request.keys.map(async (key) => {
    try {
      if (http) return applyGlobalMacroPointLimit(await loadGlobalMacroSeries(key, ctx, http), limit, false)
      const cached = await globalMacroSeriesWithCache(key, ctx)
      return applyGlobalMacroPointLimit(cached.series, limit, cached.cached)
    } catch (err) {
      // 单条序列异常不影响整体；明确 error，不伪造数据。
      return globalMacroFailure(key, `全球宏观序列 ${key} 获取异常：${globalMacroErrorText(err)}`, fetchedAt)
    }
  }))
  return buildGlobalMacroReport(series, request, fetchedAt)
}

// ---- 基金排行（东财 rankhandler，akshare fund_open_fund_rank_em 同源）----
const FUND_RANK_TYPES: Record<string, string> = { all: 'all', stock: 'gp', hybrid: 'hh', bond: 'zq', index: 'zs', qdii: 'qdii', money: 'hb' }

/**
 * 排序键 → 东财 rankhandler `sc` 参数。键名对照 akshare/页面控件的区间列；
 * `m6`（6yzf，近6月）与货币基金 `1nsyl`（近1年收益）是既有默认口径，
 * 其余映射未逐个线上核实——非法键一律回落默认，不猜。
 */
export const FUND_RANK_SC: Record<string, string> = {
  m1: '1yzf', m3: '3yzf', m6: '6yzf', y1: '1nzf', y2: '2nzf', y3: '3nzf', ytd: 'jnzf',
}

/** ft 为已映射的东财类别码（all/gp/hh/zq/zs/qdii/hb）。 */
export function fundRankSc(ft: string, sortBy?: string): string {
  if (ft === 'hb') return '1nsyl'
  return FUND_RANK_SC[String(sortBy ?? '')] ?? FUND_RANK_SC.m6!
}

/** 构造 rankhandler 查询参数（纯函数，离线可测）。 */
export function fundRankRequest(fundType: string, size?: number, sortBy?: string, page?: number): Record<string, string> {
  const ft = FUND_RANK_TYPES[String(fundType ?? 'all')] ?? 'all'
  const pn = Math.min(Math.max(Math.trunc(Number(size ?? 20)) || 20, 1), 50)
  const pi = Math.min(Math.max(Math.trunc(Number(page ?? 1)) || 1, 1), 100)
  return { op: 'ph', dt: 'kf', ft, rs: '', gs: '0', sc: fundRankSc(ft, sortBy), st: 'desc', pi: String(pi), pn: String(pn), dx: '1' }
}

interface FundRankRow { code: string; name: string; date: string; nav?: number; accNav?: number; dayGrowth?: number; w1?: number; m1?: number; m3?: number; m6?: number; y1?: number; y2?: number; y3?: number; ytd?: number }

async function emFundRank(args: Record<string, unknown>, ctx: ProviderContext) {
  const query = fundRankRequest(
    String(args.fundType ?? 'all'),
    Number(args.size ?? 20),
    args.sortBy === undefined ? undefined : String(args.sortBy),
    Number(args.page ?? 1),
  )
  const text = await httpGetText(
    'https://fund.eastmoney.com/data/rankhandler.aspx',
    query,
    opts(ctx, 'https://fund.eastmoney.com/data/fundranking.html'),
  )
  const block = text.match(/datas:\[([\s\S]*?)\]\s*,/)?.[1] ?? text.match(/datas:\[([\s\S]*)\]/)?.[1] ?? ''
  const items = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.split(','))
  const rows: FundRankRow[] = items.filter((f) => f[0]).map((f) => ({
    code: f[0]!, name: f[1] ?? '', date: f[3] ?? '',
    nav: num(f[4]), accNav: num(f[5]), dayGrowth: num(f[6]),
    w1: num(f[7]), m1: num(f[8]), m3: num(f[9]), m6: num(f[10]), y1: num(f[11]), y2: num(f[12]), y3: num(f[13]), ytd: num(f[14]),
  }))
  if (!rows.length) throw new Error('fund rank: empty')
  return { rows, data: rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---- 基金历史净值回落源（东财 f10 lsjz）----
// 契约未线上核实：仅按命名字段（FSRQ/DWJZ/JZZZL/SGZT/SHZT）解析，命不中直接抛错回落，
// 绝不按位置猜字段。主源（pingzhongdata）失败时才走到这里。
export interface FundNavApiPoint {
  date: string
  nav: number
  accumNav?: number
  growthPct?: number
}

export interface FundNavApiResult {
  /** 新在前（降序）。 */
  series: FundNavApiPoint[]
  subscribeStatus?: string
  redeemStatus?: string
}

function pickField(obj: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (n in obj) return obj[n]
    const hit = Object.keys(obj).find((k) => k.toLowerCase() === n.toLowerCase())
    if (hit) return obj[hit]
  }
  return undefined
}

function strNum(v: unknown): number | undefined {
  if (typeof v === 'string') v = v.replace(/[%％,\s]/g, '')
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 从 lsjz JSON 提取净值序列；没有 FSRQ/DWJZ 这样的命名字段就拒绝解析。 */
export function parseFundNavLsjz(json: unknown): FundNavApiResult {
  const root = json && typeof json === 'object' ? json as Record<string, unknown> : undefined
  const data = root ? (root.Data ?? root.data) as Record<string, unknown> | undefined : undefined
  const listRaw = data ? (data.lsjzList ?? data.rows ?? data.list) : undefined
  const list = Array.isArray(listRaw) ? listRaw : undefined
  if (!list?.length) throw new Error('fund nav api: 响应缺少 Data.lsjzList（契约未线上核实）')
  const series: FundNavApiPoint[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const dateRaw = String(pickField(obj, ['FSRQ', 'date', '净值日期']) ?? '')
    const nav = strNum(pickField(obj, ['DWJZ', 'nav', '单位净值']))
    const date = dateRaw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
    if (!date || nav === undefined || nav <= 0 || nav > 10000) continue
    const point: FundNavApiPoint = { date, nav }
    const accum = strNum(pickField(obj, ['LJJZ', 'accumNav', '累计净值']))
    if (accum !== undefined && accum > 0) point.accumNav = accum
    const growth = strNum(pickField(obj, ['JZZZL', 'JZZDF', 'growthPct', '日增长率']))
    if (growth !== undefined) point.growthPct = growth
    series.push(point)
  }
  if (!series.length) throw new Error('fund nav api: 解析不到有效净值行（契约未线上核实）')
  series.sort((a, b) => b.date.localeCompare(a.date))
  const first = list.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined
  const result: FundNavApiResult = { series }
  if (first) {
    const sub = typeof pickField(first, ['SGZT', '申购状态']) === 'string' ? String(pickField(first, ['SGZT', '申购状态'])) : undefined
    const red = typeof pickField(first, ['SHZT', '赎回状态']) === 'string' ? String(pickField(first, ['SHZT', '赎回状态'])) : undefined
    if (sub) result.subscribeStatus = sub
    if (red) result.redeemStatus = red
  }
  return result
}

async function emFetchLsjz(code: string, pageSize: number, ctx: ProviderContext): Promise<FundNavApiResult> {
  const c = fundCode(code)
  const json = await httpGetJson(
    'https://api.fund.eastmoney.com/f10/lsjz',
    { fundCode: c, pageIndex: 1, pageSize },
    opts(ctx, 'https://fundf10.eastmoney.com/'),
  )
  return parseFundNavLsjz(json)
}

async function emNavQuote(args: Record<string, unknown>, ctx: ProviderContext) {
  const c = fundCode(String(args.code ?? ''))
  const res = await emFetchLsjz(c, 20, ctx)
  const last = res.series[0]!
  const prev = res.series[1]
  const quote: StockQuote = {
    code: c,
    price: last.nav,
    change: prev ? Number((last.nav - prev.nav).toFixed(4)) : undefined,
    changePercent: prev && prev.nav ? Number((((last.nav - prev.nav) / prev.nav) * 100).toFixed(2)) : undefined,
    asOf: last.date,
    raw: {
      navDate: last.date,
      accumNav: last.accumNav,
      subscribeStatus: res.subscribeStatus,
      redeemStatus: res.redeemStatus,
      source: 'em_fund_nav',
    },
  }
  return { rows: [quote], data: quote, sampleKeys: Object.keys(quote) }
}

async function emNavKline(args: Record<string, unknown>, ctx: ProviderContext) {
  const c = fundCode(String(args.code ?? ''))
  // lsjz 单页上限未知：按请求天数折算并封顶 500 行（近 1 年分析足够；全量历史由主源提供）。
  const days = Math.max(Number(args.days ?? 120) || 120, 30)
  const pageSize = Math.min(Math.max(Math.ceil(days * 1.6) + 30, 50), 500)
  const res = await emFetchLsjz(c, pageSize, ctx)
  const bars: KlineBar[] = [...res.series]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ date: p.date, open: p.nav, high: p.nav, low: p.nav, close: p.nav, volume: 0, volumeMissing: true }))
  return { rows: bars, sampleKeys: bars[0] ? Object.keys(bars[0]) : [] }
}

// ---- 基金重仓持仓（东财 f10 JJCC，穿透/重叠分析用）----
// 契约未线上核实：年份键优先 + 防御式行识别（normalizeFundHoldingRows ≥60% 认出代码才收），
// 识别不出就抛错，让档案/工具显式标缺失，不产出猜测数据。
export function parseFundHoldings(json: unknown): NormalizedHolding[] {
  const collectArrays = (v: unknown, depth = 0): unknown[][] => {
    if (depth > 6) return []
    if (Array.isArray(v)) {
      const out: unknown[][] = [v]
      for (const item of v.slice(0, 30)) out.push(...collectArrays(item, depth + 1))
      return out
    }
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap((x) => collectArrays(x, depth + 1))
    return []
  }
  const candidates: unknown[][] = []
  const root = json && typeof json === 'object' ? json as Record<string, unknown> : undefined
  const data = root ? (root.Data ?? root.data) as Record<string, unknown> | undefined : undefined
  // 1) Data: { "2025": [ ... ], "2024": [...] } → 取最新年份。
  for (const scope of [data, root]) {
    if (!scope || typeof scope !== 'object') continue
    const years = Object.keys(scope).filter((k) => /^\d{4}$/.test(k)).sort()
    const latest = years.at(-1)
    if (latest && Array.isArray((scope as Record<string, unknown>)[latest])) {
      candidates.push((scope as Record<string, unknown>)[latest] as unknown[])
      break
    }
  }
  // 2) 兜底：递归收集数组候选。
  candidates.push(...collectArrays(json))
  let best: NormalizedHolding[] = []
  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0 || arr.length > 100) continue
    if (!arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) continue
    try {
      const rows = normalizeFundHoldingRows(arr)
      if (rows.length > best.length) best = rows
    } catch { /* 候选不认，换下一个 */ }
  }
  if (!best.length) throw new Error('fund holdings: 无法从响应识别持仓结构（契约未线上核实，拒绝猜测）')
  return best
}

async function emFundHoldings(args: Record<string, unknown>, ctx: ProviderContext) {
  const c = fundCode(String(args.code ?? ''))
  const topN = Math.min(Math.max(Math.trunc(Number(args.topN ?? 10)) || 10, 1), 50)
  const json = await httpGetJson(
    'https://api.fund.eastmoney.com/f10/JJCC',
    { fundcode: c, topline: String(topN), year: '', month: '', rt: String(Math.random()) },
    opts(ctx, 'https://fundf10.eastmoney.com/'),
  )
  const rows = parseFundHoldings(json).slice(0, topN)
  return { rows, data: rows, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] }
}

// ---- 快讯 / 新闻（东财，akshare stock_info_global_em / stock_news_em 同源）----
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim()
}

// Source: eastmoney 全球财经快讯 (getFastNewsList). 单一时间线电报。
async function emNewsFlash(args: Record<string, unknown>, ctx: ProviderContext) {
  const size = Math.min(Math.max(Number(args.size ?? 20), 1), 50)
  const json = await httpGetJson<{ data?: { fastNewsList?: Array<Record<string, unknown>> } }>(
    'https://np-listapi.eastmoney.com/comm/web/getFastNewsList',
    { client: 'web', biz: 'web_724', fastColumn: '102', sortEnd: '', pageSize: String(size), req_trace: String(Date.now()), _: String(Date.now()) },
    opts(ctx, 'https://kuaixun.eastmoney.com/'),
  )
  const list = json.data?.fastNewsList ?? []
  const rows = list.map((it) => {
    const summary = stripHtml(String(it.summary ?? ''))
    const title = String(it.title ?? '') || summary.match(/^【(.+?)】/)?.[1] || summary.slice(0, 48)
    const code = it.code ? String(it.code) : undefined
    return {
      title,
      summary,
      time: String(it.showTime ?? it.showtime ?? it.time ?? ''),
      url: it.url ? String(it.url) : code ? `https://finance.eastmoney.com/a/${code}.html` : undefined,
    }
  })
  if (!rows.length) throw new Error('news flash: empty')
  return { rows, data: rows, sampleKeys: Object.keys(list[0]!) }
}

// Source: eastmoney 搜索 (search-api-web jsonp). 供 stock_news 复用。
async function emArticleSearch(keyword: string, size: number, ctx: ProviderContext): Promise<Array<SearchResult & { date?: string; source?: string }>> {
  const param = JSON.stringify({
    uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: size, preTag: '', postTag: '' } },
  })
  const text = await httpGetText('https://search-api-web.eastmoney.com/search/jsonp', { cb: 'x', param }, opts(ctx, 'https://so.eastmoney.com/'))
  const m = text.match(/^[^(]*\(([\s\S]*)\);?\s*$/)
  const json = JSON.parse(m ? m[1]! : text) as { result?: { cmsArticleWebOld?: Array<Record<string, unknown>> } }
  const list = json.result?.cmsArticleWebOld ?? []
  return list.map((it) => ({
    title: stripHtml(String(it.title ?? '')),
    url: it.url ? String(it.url) : undefined,
    snippet: stripHtml(String(it.content ?? '')).slice(0, 200),
    date: typeof it.date === 'string' ? it.date : undefined,
    source: typeof it.mediaName === 'string' ? it.mediaName : undefined,
  })).filter((r) => r.title)
}

async function emStockNews(args: Record<string, unknown>, ctx: ProviderContext) {
  const keyword = String(args.code ?? args.keyword ?? '').trim()
  if (!keyword) throw new Error('empty code for stock news')
  const size = Math.min(Math.max(Number(args.size ?? 10), 1), 20)
  const results = await emArticleSearch(keyword, size, ctx)
  const rows = results.map((r) => ({
    title: r.title,
    date: r.date ?? '',
    source: r.source ?? '',
    url: r.url,
    summary: r.snippet,
  }))
  if (!rows.length) throw new Error('stock news: empty')
  return { rows, data: rows, sampleKeys: Object.keys(rows[0]!) }
}

// ---------------------------------------------------------------------------
// T5 东财资金流 / 公司事件明细 + 全球财务（港股东财 HKF10 / 美股 SEC XBRL）
// 解析与口径在 em-market-detail.ts、global-financials.ts（纯函数、fixture 固定契约）；
// 这里只负责 HTTP 调用、错误转换（registry 约定：失败 throw，空数据不 throw）与 data 包装。
// ---------------------------------------------------------------------------

export type EmDetailKind = 'money_flow' | 'announcements' | 'dividend_plan' | 'performance' | 'block_trade' | 'margin_detail'

const EM_DETAIL_KIND_LABELS: Record<EmDetailKind, string> = {
  money_flow: '资金流',
  announcements: '公告',
  dividend_plan: '分红送配',
  performance: '业绩预告/快报',
  block_trade: '大宗交易',
  margin_detail: '融资融券明细',
}

/** 合并 registry 的取消信号与模块自身的超时信号；任一 abort 即取消。 */
function combineAbortSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  const ctrl = new AbortController()
  const abort = () => { ctrl.abort() }
  if (a.aborted || b.aborted) ctrl.abort()
  else {
    a.addEventListener('abort', abort, { once: true })
    b.addEventListener('abort', abort, { once: true })
  }
  return ctrl.signal
}

/** 按调用注入超时与取消信号；不写死 UA / 私有配置。 */
function emDetailClient(ctx: ProviderContext) {
  const deps: EmMarketDetailDeps = { timeoutMs: ctx.timeoutMs }
  if (ctx.signal && typeof globalThis.fetch === 'function') {
    deps.fetch = (url, init) => {
      const signal = combineAbortSignals(init?.signal, ctx.signal)
      const requestInit: Record<string, unknown> = { ...(init ?? {}) }
      if (signal) requestInit.signal = signal
      return globalThis.fetch(url, requestInit as RequestInit) as unknown as Promise<EmHttpResponseLike>
    }
  }
  return createEmMarketDetail(deps)
}

export interface EmDetailProviderData<T = unknown> {
  kind: EmDetailKind
  /** 实际请求的接口 URL（含参数）。 */
  source: string
  /** 数据自身的最新日期（YYYY-MM-DD），不是抓取时间。 */
  asOf?: string
  unit: string
  currency?: 'CNY'
  rows: T[]
  count: number
  /** 抓取时间（ISO），只作溯源，不是数据时点。 */
  fetchedAt: string
  warnings?: string[]
  total?: number
  page?: number
  pageSize?: number
  partial?: boolean
}

export interface EmDetailProviderPayload<T = unknown> {
  rows: T[]
  data: EmDetailProviderData<T>
  sampleKeys: string[]
}

/** 纯映射：EmDetailResult → provider 的 {rows,data}；失败 throw（交给 registry 回退）。 */
export function emDetailProviderPayload<T>(kind: EmDetailKind, result: EmDetailResult<T>): EmDetailProviderPayload<T> {
  if (!result.ok) throw new Error(result.error ?? `${EM_DETAIL_KIND_LABELS[kind]}取数失败`)
  const data: EmDetailProviderData<T> = {
    kind,
    source: result.source,
    ...(result.asOf ? { asOf: result.asOf } : {}),
    unit: result.unit,
    ...(result.currency ? { currency: result.currency } : {}),
    rows: result.rows,
    count: result.count,
    fetchedAt: result.fetchedAt,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.total !== undefined ? { total: result.total } : {}),
    ...(result.page !== undefined ? { page: result.page } : {}),
    ...(result.pageSize !== undefined ? { pageSize: result.pageSize } : {}),
    ...(result.partial ? { partial: true } : {}),
  }
  const first = result.rows[0]
  return {
    rows: result.rows,
    data,
    sampleKeys: first && typeof first === 'object' ? Object.keys(first as object) : [],
  }
}

function emPerformanceKind(v: unknown): 'all' | 'forecast' | 'express' | undefined {
  return v === 'all' || v === 'forecast' || v === 'express' ? v : undefined
}

async function callEmDetail(kind: EmDetailKind, args: Record<string, unknown>, ctx: ProviderContext): Promise<EmDetailResult<unknown>> {
  const code = String(args.code ?? '').trim()
  if (!code) throw new Error(`${EM_DETAIL_KIND_LABELS[kind]}：code is required`)
  const client = emDetailClient(ctx)
  switch (kind) {
    case 'money_flow':
      return client.getFundFlow(code, { days: num(args.days) })
    case 'announcements':
      return client.getAnnouncements(code, { page: num(args.page), pageSize: num(args.pageSize) })
    case 'dividend_plan':
      return client.getDividends(code, { page: num(args.page), pageSize: num(args.pageSize) })
    case 'performance':
      return client.getPerformance(code, {
        kind: emPerformanceKind(args.kind),
        page: num(args.page),
        pageSize: num(args.pageSize),
      })
    case 'block_trade':
      return client.getBlockTrades(code, { page: num(args.page), pageSize: num(args.pageSize) })
    case 'margin_detail':
      return client.getMarginTrades(code, { page: num(args.page), pageSize: num(args.pageSize) })
  }
}

function emDetailProvider(kind: EmDetailKind): ProviderFn {
  return async (args, ctx) => emDetailProviderPayload(kind, await callEmDetail(kind, args, ctx))
}

export interface GlobalFinancialsProviderData {
  market: 'hk' | 'us'
  code: string
  name: string | null
  /** 美股恒为 USD；港股为各行共同币种，缺失/不一致时 null（不换算）。 */
  currency: string | null
  source: string
  /** 抓取时间（ISO）；不是任何报告期。 */
  fetchedAt: string
  rows: GlobalFinancialRow[]
  profile?: unknown
  warnings?: string[]
}

export interface GlobalFinancialsProviderPayload {
  rows: GlobalFinancialRow[]
  data: GlobalFinancialsProviderData
  sampleKeys: string[]
}

/** 纯映射：GlobalFinancialsResult → provider 的 {rows,data}；失败 throw（缺 SEC UA 也在这里显式失败）。 */
export function globalFinancialsProviderPayload(result: GlobalFinancialsResult): GlobalFinancialsProviderPayload {
  if (!result.ok) throw new Error(result.error ?? `${result.market === 'hk' ? '港股' : '美股'}财务取数失败`)
  const data: GlobalFinancialsProviderData = {
    market: result.market,
    code: result.code,
    name: result.name,
    currency: result.currency,
    source: result.source,
    fetchedAt: result.fetchedAt,
    rows: result.rows,
    ...(result.profile ? { profile: result.profile } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  }
  const first = result.rows[0]
  return {
    rows: result.rows,
    data,
    sampleKeys: first && typeof first === 'object' ? Object.keys(first) : [],
  }
}

/** market 归一：接受 hk/us 或 港股/美股，其它值显式报错（不猜市场）。 */
export function globalFinancialsMarket(value: unknown): 'hk' | 'us' {
  const m = String(value ?? '').trim().toLowerCase()
  if (m === 'hk' || m === '港股') return 'hk'
  if (m === 'us' || m === '美股') return 'us'
  throw new Error(`global_financials 需要 market=hk|us（收到：${m || '空'}）`)
}

async function globalFinancials(args: Record<string, unknown>, ctx: ProviderContext): Promise<GlobalFinancialsProviderPayload> {
  const code = String(args.code ?? '').trim()
  if (!code) throw new Error('global_financials：code is required')
  const market = globalFinancialsMarket(args.market)
  const options = { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) }
  const result = market === 'hk' ? await fetchHkFinancials(code, options) : await fetchUsFinancials(code, options)
  return globalFinancialsProviderPayload(result)
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'em_a_clist',
    capability: 'stock_list',
    endpointRef: 'stock_zh_a_spot_em (stock_hist_em.py) — clist page1',
    sampleArgs: {},
    call: emAClist,
  },
  {
    id: 'em_stock_get',
    capability: 'quote',
    endpointRef: 'stock_bid_ask_em (stock_ask_bid_em.py)',
    sampleArgs: { code: '600519' },
    call: emStockGet,
  },
  {
    id: 'em_individual_info',
    capability: 'quote',
    endpointRef: 'stock_individual_info_em (stock_info_em.py)',
    sampleArgs: { code: '600519' },
    call: emIndividualInfo,
  },
  {
    id: 'em_kline',
    capability: 'kline',
    endpointRef: 'stock_zh_a_hist (stock_hist_em.py)',
    sampleArgs: { code: '600519', days: 40 },
    call: emKline,
  },
  {
    id: 'tx_kline',
    capability: 'kline',
    endpointRef: 'stock_zh_a_hist_tx (stock_hist_tx.py)',
    sampleArgs: { code: '600519', days: 40 },
    call: txKline,
  },
  {
    id: 'em_index_main',
    capability: 'indices',
    endpointRef: '__stock_zh_main_spot_em (index_stock_zh.py)',
    sampleArgs: {},
    call: emIndexMain,
  },
  {
    id: 'em_global_indices',
    capability: 'global_indices',
    endpointRef: 'eastmoney push2 qt/stock/get（全球指数 secid：100.SPX/100.HSI/1.000001…；f43 点位、f170 涨跌幅、f86 行情时间戳）',
    sampleArgs: { region: 'us' },
    call: emGlobalIndices,
  },
  {
    id: 'em_main_finadata',
    capability: 'financials',
    endpointRef: 'stock_financial_analysis_indicator_em (stock_finance_sina.py)',
    sampleArgs: { code: '600519' },
    call: emMainFinadata,
  },
  {
    id: 'em_f10_survey',
    capability: 'company_survey',
    endpointRef: 'emweb PC_HSF10/CompanySurvey/PageAjax (F10 公司概况)',
    sampleArgs: { code: '600519' },
    call: emF10Survey,
  },
  {
    id: 'em_f10_business',
    capability: 'business_composition',
    endpointRef: 'emweb PC_HSF10/BusinessAnalysis/PageAjax (F10 主营构成)',
    sampleArgs: { code: '600519' },
    call: emF10Business,
  },
  {
    id: 'em_f10_financials',
    capability: 'main_financials',
    endpointRef: 'datacenter RPT_F10_FINANCE_MAINFINADATA (F10 主要财务指标)',
    sampleArgs: { code: '600519' },
    call: emF10Financials,
  },
  {
    id: 'em_f10_concepts',
    capability: 'core_concepts',
    endpointRef: 'emweb PC_HSF10/CoreConception/PageAjax (F10 核心题材)',
    sampleArgs: { code: '600519' },
    call: emF10Concepts,
  },
  {
    id: 'em_f10_holders',
    capability: 'shareholder_count',
    endpointRef: 'emweb PC_HSF10/ShareholderResearch/PageAjax (F10 股东户数)',
    sampleArgs: { code: '600519' },
    call: emF10Holders,
  },
  {
    id: 'em_f10_valuation',
    capability: 'valuation_analysis',
    endpointRef: 'datacenter-web RPT_VALUEANALYSIS_DET (F10 估值分析/分位)',
    sampleArgs: { code: '600519' },
    call: emF10Valuation,
  },
  {
    id: 'em_f10_peers',
    capability: 'peer_comparison',
    endpointRef: 'emweb PC_HSF10/IndustryAnalysis/PageAjax (同行比较；契约未核实)',
    sampleArgs: { code: '600519' },
    call: emF10Peers,
  },
  {
    id: 'em_industry_board',
    capability: 'sectors',
    endpointRef: 'stock_board_industry_name_em (stock_board_industry_em.py)',
    sampleArgs: {},
    call: emIndustryBoard,
  },
  {
    id: 'em_hk_quote',
    capability: 'hk_quote',
    endpointRef: 'stock_bid_ask_em (HK secid 116)',
    sampleArgs: { code: '00700' },
    call: emHkQuote,
  },
  {
    id: 'tx_hk_quote',
    capability: 'hk_quote',
    endpointRef: 'tencent gtimg q=hk{code}',
    sampleArgs: { code: '00700' },
    call: txHkQuote,
  },
  {
    id: 'em_hk_kline',
    capability: 'hk_kline',
    endpointRef: 'stock_hk_hist (stock_hist_em.py, HK secid 116)',
    sampleArgs: { code: '00700', days: 40 },
    call: emHkKline,
  },
  {
    id: 'tx_hk_kline',
    capability: 'hk_kline',
    endpointRef: 'stock_zh_a_hist_tx (hk 前缀)',
    sampleArgs: { code: '00700', days: 40 },
    call: txHkKline,
  },
  {
    id: 'em_hk_clist',
    capability: 'hk_list',
    endpointRef: 'stock_hk_spot_em (clist m:128 page1)',
    sampleArgs: {},
    call: emHkClist,
  },
  {
    id: 'yahoo_quote',
    capability: 'us_quote',
    endpointRef: 'Yahoo Finance chart v8 (regularMarketPrice)',
    sampleArgs: { code: 'AAPL' },
    call: yahooQuote,
  },
  {
    id: 'em_us_quote',
    capability: 'us_quote',
    endpointRef: 'stock_us_spot_em (secid via suggest)',
    sampleArgs: { code: 'AAPL' },
    call: emUsQuote,
  },
  {
    id: 'yahoo_kline',
    capability: 'us_kline',
    endpointRef: 'Yahoo Finance chart v8 (OHLCV series)',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: yahooKline,
  },
  {
    id: 'em_us_kline',
    capability: 'us_kline',
    endpointRef: 'stock_us_hist (secid via suggest)',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: emUsKline,
  },
  {
    id: 'em_fund_quote',
    capability: 'fund_quote',
    endpointRef: 'fund.eastmoney.com pingzhongdata (Data_netWorthTrend 单位净值)',
    sampleArgs: { code: '110022' },
    call: emFundQuote,
  },
  {
    // 回落源：主源（pingzhongdata）失败时用 f10 lsjz 命名字段解析；契约未线上核实。
    id: 'em_fund_nav_quote',
    capability: 'fund_quote',
    endpointRef: 'api.fund.eastmoney.com f10/lsjz（命名字段解析，契约未线上核实）',
    sampleArgs: { code: '110022' },
    call: emNavQuote,
  },
  {
    id: 'em_fund_kline',
    capability: 'fund_kline',
    endpointRef: 'fund.eastmoney.com pingzhongdata (净值走势序列)',
    sampleArgs: { code: '110022' },
    call: emFundKline,
  },
  {
    id: 'em_fund_nav_kline',
    capability: 'fund_kline',
    endpointRef: 'api.fund.eastmoney.com f10/lsjz 近段净值（回落源，契约未线上核实）',
    sampleArgs: { code: '110022', days: 120 },
    call: emNavKline,
  },
  {
    id: 'em_fund_holdings',
    capability: 'fund_holdings',
    endpointRef: 'api.fund.eastmoney.com f10/JJCC 重仓持仓（契约未线上核实，防御式解析）',
    sampleArgs: { code: '110022' },
    call: emFundHoldings,
  },
  {
    id: 'em_news_flash',
    capability: 'news_flash',
    endpointRef: 'eastmoney 全球财经快讯 getFastNewsList (akshare stock_info_global_em)',
    sampleArgs: { size: 5 },
    call: emNewsFlash,
  },
  {
    id: 'em_stock_news',
    capability: 'stock_news',
    endpointRef: 'eastmoney 搜索资讯 (akshare stock_news_em)',
    sampleArgs: { code: '600519', size: 5 },
    call: emStockNews,
  },
  {
    id: 'em_macro',
    capability: 'macro',
    endpointRef: 'eastmoney datacenter-web (中国 CPI/PPI/PMI/GDP/货币供应)',
    sampleArgs: { series: 'cpi' },
    call: emMacro,
  },
  {
    id: 'em_fund_rank',
    capability: 'fund_rank',
    endpointRef: 'fund.eastmoney rankhandler (开放式基金排行)',
    sampleArgs: { fundType: 'all', size: 10 },
    call: emFundRank,
  },
  {
    id: 'em_suggest',
    capability: 'symbol_search',
    endpointRef: 'eastmoney searchapi suggest (跨市场代码/名称解析)',
    sampleArgs: { query: '腾讯' },
    call: emSuggest,
  },
  {
    id: 'em_stock_info',
    capability: 'stock_info',
    endpointRef: 'stock_individual_info_em (行情+市值字段)',
    sampleArgs: { code: '600519' },
    call: emStockInfo,
  },
  {
    // 免安装的回补实现排在最前：没有 pip 依赖也能搜索。
    id: 'rss_web_search',
    capability: 'web_search',
    endpointRef: 'Bing Search RSS — Node 原生解析，零依赖',
    sampleArgs: { query: 'nvidia stock' },
    call: rssWebSearch,
  },
  {
    id: 'py_web_search',
    capability: 'web_search',
    endpointRef: 'Python ddgs + primp → Bing/Google/Yandex (可选，pip install ddgs)',
    sampleArgs: { query: 'nvidia stock' },
    call: pyWebSearch,
  },

  // ---- T5 东财资金流 / 公司事件明细 + 全球财务 ----
  // 条目顺序与 DEFAULT_PROVIDER_ORDER 对齐；放在 WeStock CLI 与 WESTOCK_SPECS 展开之前，
  // 静态顺序上 EM 优先。注意 registry 默认 preferWestock 会把 ws_* 提前，因此
  // service.westock('money_flow') 先走 money_flow_detail（EM 独占）再回退 WeStock。
  {
    id: 'em_market_detail_money_flow',
    capability: 'money_flow',
    endpointRef: 'eastmoney push2his fflow/daykline（逐日 20 日：主力/超大/大/中/小单净额，CNY）',
    sampleArgs: { code: '600519', days: 20 },
    call: emDetailProvider('money_flow'),
  },
  {
    id: 'em_market_detail_money_flow_detail',
    capability: 'money_flow_detail',
    endpointRef: 'eastmoney push2his fflow/daykline（EM 独占的资金流逐日明细，供 service 优先路由）',
    sampleArgs: { code: '600519', days: 20 },
    call: emDetailProvider('money_flow'),
  },
  {
    id: 'em_market_detail_announcements',
    capability: 'announcements',
    endpointRef: 'eastmoney np-anotice-stock 公告库（A 股；含原文链接）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('announcements'),
  },
  {
    id: 'em_market_detail_dividend_plan',
    capability: 'dividend_plan',
    endpointRef: 'eastmoney datacenter RPT_SHAREBONUS_DET（分红送配：预案/实施/除权，每 10 股口径）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('dividend_plan'),
  },
  {
    id: 'em_market_detail_performance',
    capability: 'performance',
    endpointRef: 'eastmoney datacenter 业绩预告 + 业绩快报（A 股；报告期口径）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('performance'),
  },
  {
    id: 'em_market_detail_block_trade',
    capability: 'block_trade',
    endpointRef: 'eastmoney datacenter RPT_DATA_BLOCKTRADE（大宗交易逐笔，CNY）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('block_trade'),
  },
  {
    id: 'em_market_detail_block_trade_detail',
    capability: 'block_trade_detail',
    endpointRef: 'eastmoney datacenter RPT_DATA_BLOCKTRADE（EM 独占的大宗交易明细）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('block_trade'),
  },
  {
    id: 'em_market_detail_margin_detail',
    capability: 'margin_detail',
    endpointRef: 'eastmoney datacenter RPT_MARGIN_DET（融资融券逐日余额/净买入，CNY）',
    sampleArgs: { code: '600519' },
    call: emDetailProvider('margin_detail'),
  },
  {
    id: 'global_financials_sources',
    capability: 'global_financials',
    endpointRef: '港股：东财 RPT_HKF10_FN_MAININDICATOR（累计口径）；美股：SEC EDGAR companyfacts XBRL（10-K/10-Q；需 DSH_SEC_EDGAR_UA）',
    sampleArgs: { code: '00700', market: 'hk' },
    call: globalFinancials,
  },

  // ---- WeStock CLI（腾讯自选股，免鉴权）----
  {
    id: 'ws_quote',
    capability: 'quote',
    endpointRef: 'westock quote <sh600519> — 腾讯自选股网关 (proxy.finance.qq.com)',
    sampleArgs: { code: '600519' },
    call: westockProviders.quote,
  },
  {
    id: 'ws_kline',
    capability: 'kline',
    endpointRef: 'westock kline <sh600519> --period day',
    sampleArgs: { code: '600519', days: 40 },
    call: westockProviders.kline,
  },
  {
    id: 'ws_hk_quote',
    capability: 'hk_quote',
    endpointRef: 'westock quote <hk00700>',
    sampleArgs: { code: '00700' },
    call: westockProviders.hkQuote,
  },
  {
    id: 'ws_hk_kline',
    capability: 'hk_kline',
    endpointRef: 'westock kline <hk00700> --period day',
    sampleArgs: { code: '00700', days: 40 },
    call: westockProviders.hkKline,
  },
  {
    id: 'ws_us_quote',
    capability: 'us_quote',
    endpointRef: 'westock quote <usAAPL>',
    sampleArgs: { code: 'AAPL' },
    call: westockProviders.usQuote,
  },
  {
    id: 'ws_us_kline',
    capability: 'us_kline',
    endpointRef: 'westock kline <usAAPL> --period day',
    sampleArgs: { code: 'AAPL', days: 40 },
    call: westockProviders.usKline,
  },
  {
    id: 'ws_research',
    capability: 'research_report',
    endpointRef: 'westock report list <sh600519> — 券商研报（标题/机构/评级/时间）',
    sampleArgs: { code: '600519', size: 5 },
    call: westockProviders.research,
  },
  {
    id: 'ws_news',
    capability: 'stock_news',
    endpointRef: 'westock news list <sh600519>',
    sampleArgs: { code: '600519', size: 5 },
    call: westockProviders.news,
  },
  {
    id: 'ws_financials',
    capability: 'financials',
    endpointRef: 'westock finance <sh600519> — 三大报表',
    sampleArgs: { code: '600519' },
    call: westockProviders.financials,
  },
  {
    id: 'ws_profile',
    capability: 'stock_info',
    endpointRef: 'westock profile <sh600519> — 公司简况',
    sampleArgs: { code: '600519' },
    call: westockProviders.profile,
  },
  {
    id: 'ws_search',
    capability: 'symbol_search',
    endpointRef: 'westock search <关键词> — 跨市场代码解析',
    sampleArgs: { query: '腾讯' },
    call: westockProviders.search,
  },
  {
    id: 'ws_quotes_batch',
    capability: 'quotes_batch',
    endpointRef: 'westock quote <sh600519,sz000858,hk00700> — 一次调用拿多只标的',
    sampleArgs: { codes: ['600519', '000858', '00700'] },
    call: westockProviders.quotesBatch,
  },
  {
    id: 'ws_indices',
    capability: 'indices',
    endpointRef: 'westock quote <sh000001,sz399001,…> — 指数批量行情',
    sampleArgs: { codes: DEFAULT_INDEX_CODES },
    call: westockProviders.indices,
  },

  // ---- WeStock CLI 扩展能力（表驱动，见 westock-capabilities.ts）----
  ...WESTOCK_SPECS.map((spec) => ({
    id: spec.id,
    capability: spec.capability,
    endpointRef: spec.usage,
    sampleArgs: spec.sampleArgs,
    call: WESTOCK_CAPABILITY_PROVIDERS[spec.id]!,
  })),
]

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))
