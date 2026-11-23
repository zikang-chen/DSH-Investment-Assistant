/**
 * 全球指数备用源：新浪 hq.sinajs.cn。
 *
 * 为什么需要它：东财 push2 会按 TLS 指纹重置非浏览器客户端的连接（curl 能过、Node 过不去），
 * 而 push2his 正常。这里改用新浪文本接口，Node 可稳定访问。
 *
 * 口径与边界：
 * - 一次请求取全部 symbol（GBK 编码），逐行解析；某行缺失只影响该行，不补 0。
 * - 部分品种（hf_ 期货、DINIW 美元指数）源只给「现价/昨结」，因此涨跌幅由本模块计算，
 *   并在该行注明 derivedFrom，避免把它当成源侧原始字段。
 * - 时间：能取到源侧日期/时间的才填 asOf，取不到就是 null（不是抓取时间）。
 * - 新浪美债 10Y 无对应 symbol：该行显式 error，不隐藏。
 */

import { httpGetJson, httpGetText } from './http.js'
import {
  GLOBAL_INDICES_TIMEOUT_MS,
  GLOBAL_INDEX_DEFS,
  type GlobalIndexDef,
  type GlobalIndexRow,
} from './global-indices.js'

export const SINA_GLOBAL_SOURCE = 'sina'
export const SINA_GLOBAL_URL = 'https://hq.sinajs.cn/list='
export const SINA_GLOBAL_REFERER = 'https://finance.sina.com.cn/'

/** secid → 新浪 symbol。没有映射的品种会返回带 error 的行。 */
export const SINA_SYMBOL_BY_SECID: Readonly<Record<string, string>> = {
  '100.DJIA': 'int_dji',
  '100.NDX': 'int_nasdaq',
  '100.SPX': 'int_sp500',
  '100.TSX': 'znb_SPTSX',
  '100.HSI': 'int_hangseng',
  '124.HSTECH': 'rt_hkHSTECH',
  '100.N225': 'int_nikkei',
  '100.KS11': 'znb_KOSPI',
  '100.SENSEX': 'znb_SENSEX',
  '100.AS51': 'znb_AS51',
  '100.SX5E': 'znb_SX5E',
  '100.FTSE': 'znb_UKX',
  '100.GDAXI': 'znb_DAX',
  '100.FCHI': 'znb_CAC',
  '1.000001': 'sh000001',
  '0.399001': 'sz399001',
  '0.399006': 'sz399006',
  '101.GC00Y': 'hf_GC',
  '101.SI00Y': 'hf_SI',
  '101.HG00Y': 'hf_CAD',
  '102.CL00Y': 'hf_CL',
  '112.B00Y': 'hf_OIL',
  '100.UDI': 'DINIW',
}

/** 解析 `var hq_str_symbol="a,b,c";` 为 [{ symbol, fields }]；空值行保留（fields=[]）。 */
export function parseSinaLines(text: string): Array<{ symbol: string; fields: string[] }> {
  const out: Array<{ symbol: string; fields: string[] }> = []
  for (const line of text.split('\n')) {
    const m = /hq_str_([A-Za-z0-9_$]+)\s*=\s*"([^"]*)"/.exec(line)
    if (!m) continue
    const body = m[2] ?? ''
    out.push({ symbol: m[1]!, fields: body ? body.split(',') : [] })
  }
  return out
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null
  const t = value.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function pctFrom(price: number | null, base: number | null): { change: number | null; pct: number | null } {
  if (price === null || base === null || base === 0) return { change: null, pct: null }
  const change = price - base
  return { change, pct: (change / base) * 100 }
}

/** 保留 4 位小数：国债收益率这类量级小，2 位会把涨跌抹成 0。展示层再按需格式化。 */
const round2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10000) / 10000)

/**
 * 按新浪各接口的字段顺序解析一行。返回 null 表示「该 symbol 的数据为空」。
 * 每个分支都注明字段位置，避免把不同接口的列混用。
 */
export function parseSinaQuote(symbol: string, fields: string[]): {
  name?: string
  price: number | null
  change: number | null
  changePct: number | null
  asOf: string | null
  derivedFrom?: string
} | null {
  if (!fields.length) return null

  // int_*：名称,现价,涨跌额,涨跌幅%
  if (symbol.startsWith('int_')) {
    return { name: fields[0], price: num(fields[1]), change: num(fields[2]), changePct: num(fields[3]), asOf: null }
  }

  // rt_hk*：代码,名称,今开,昨收,最高,最低,现价,涨跌额,涨跌幅,…,日期,时间
  if (symbol.startsWith('rt_hk')) {
    const date = fields[17]?.replaceAll('/', '-') ?? ''
    const time = fields[18] ?? ''
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString() : null
    return { name: fields[1], price: num(fields[6]), change: num(fields[7]), changePct: num(fields[8]), asOf }
  }

  // sh/sz 指数全量：名称,今开,昨收,现价,最高,最低,…,日期[30],时间[31]
  if (/^(sh|sz)\d{6}$/.test(symbol)) {
    const date = fields[30] ?? ''
    const time = fields[31] ?? ''
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString() : null
    const price = num(fields[3])
    const prev = num(fields[2])
    const { change, pct } = pctFrom(price, prev)
    return { name: fields[0], price, change: round2(change), changePct: round2(pct), asOf, derivedFrom: 'prevClose' }
  }

  // hf_* 期货：现价,,买,卖,高,低,时间,昨结,今开,…,日期[12],名称[13]
  if (symbol.startsWith('hf_')) {
    const price = num(fields[0])
    const prev = num(fields[7])
    const { change, pct } = pctFrom(price, prev)
    const date = fields[12] ?? ''
    const time = fields[6] ?? ''
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString() : null
    return { name: fields[13], price, change: round2(change), changePct: round2(pct), asOf, derivedFrom: 'prevSettle' }
  }

  // DINIW 美元指数：时间,现价,…,昨收[5],高[6],低[7],名称[9],日期[10]
  if (symbol === 'DINIW') {
    const price = num(fields[1])
    const prev = num(fields[5])
    const { change, pct } = pctFrom(price, prev)
    const date = fields[10] ?? ''
    const time = fields[0] ?? ''
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString() : null
    return { name: fields[9], price, change: round2(change), changePct: round2(pct), asOf, derivedFrom: 'prevClose' }
  }

  // znb_*（海外指数）：名称,现价,涨跌额,涨跌幅,… 有的带日期[6]/时间[7]，有的不带
  if (symbol.startsWith('znb_')) {
    const date = fields[6] ?? ''
    const time = fields[7] ?? ''
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString() : null
    return { name: fields[0], price: num(fields[1]), change: num(fields[2]), changePct: num(fields[3]), asOf }
  }

  return null
}

/** 把一次新浪响应变成与东财一致的 GlobalIndexRow[]；缺 symbol 的行显式 error。 */
export function buildSinaGlobalRows(text: string, defs: readonly GlobalIndexDef[] = GLOBAL_INDEX_DEFS, at = new Date().toISOString()): {
  rows: GlobalIndexRow[]
  failed: number
} {
  const bySymbol = new Map(parseSinaLines(text).map((entry) => [entry.symbol, entry.fields]))
  const rows: GlobalIndexRow[] = []
  let failed = 0
  for (const def of defs) {
    const symbol = SINA_SYMBOL_BY_SECID[def.secid]
    if (!symbol) {
      failed++
      rows.push({ secid: def.secid, code: def.code, name: def.name, region: def.region, price: null, changePct: null, change: null, asOf: null, source: SINA_GLOBAL_SOURCE, error: '新浪无此品种（需其他来源）' })
      continue
    }
    const parsed = parseSinaQuote(symbol, bySymbol.get(symbol) ?? [])
    if (!parsed || parsed.price === null) {
      failed++
      rows.push({ secid: def.secid, code: def.code, name: def.name, region: def.region, price: null, changePct: null, change: null, asOf: null, source: SINA_GLOBAL_SOURCE, error: `新浪 ${symbol} 未返回价格` })
      continue
    }
    rows.push({
      secid: def.secid,
      code: def.code,
      name: parsed.name?.trim() || def.name,
      region: def.region,
      price: parsed.price,
      changePct: parsed.changePct,
      change: parsed.change,
      asOf: parsed.asOf,
      source: SINA_GLOBAL_SOURCE,
    })
  }
  void at
  return { rows, failed }
}

/**
 * 美债 10Y 收益率：新浪无对应 symbol，改用东财 push2his 日线（该主机 Node 可达）。
 * 明确标注来源为日线收盘、asOf 为交易日，不伪装成盘中实时。
 */
export async function fetchUs10yFromDailyHistory(options: { signal?: AbortSignal } = {}): Promise<{
  price: number
  change: number | null
  changePct: number | null
  asOf: string | null
} | null> {
  try {
    const json = await httpGetJson<{ data?: { klines?: string[] } }>(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get',
      {
        secid: '171.US10Y', ut: 'b2884a393a59ad64002292a3e90d46a5', klt: '101', fqt: '1',
        beg: '20260101', end: '20500101', lmt: '3',
        fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56',
      },
      { timeoutMs: GLOBAL_INDICES_TIMEOUT_MS, referer: 'https://quote.eastmoney.com/', ...(options.signal ? { signal: options.signal } : {}) },
    )
    const rows = (json.data?.klines ?? []).map((line) => line.split(','))
    const last = rows.at(-1)
    const prev = rows.at(-2)
    if (!last) return null
    const price = Number(last[2])
    if (!Number.isFinite(price)) return null
    const prevClose = prev ? Number(prev[2]) : NaN
    const change = Number.isFinite(prevClose) ? price - prevClose : null
    return {
      price,
      change: round2(change),
      changePct: round2(Number.isFinite(prevClose) && prevClose !== 0 && change !== null ? (change / prevClose) * 100 : null),
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(last[0] ?? '') ? new Date(`${last[0]}T00:00:00+08:00`).toISOString() : null,
    }
  } catch {
    return null
  }
}

/** 一次请求取全部品种（新浪支持逗号分隔），失败时抛错交给 registry 回落。 */
export async function fetchSinaGlobalIndices(
  region: 'all' | GlobalIndexDef['region'],
  options: { signal?: AbortSignal } = {},
): Promise<{ rows: GlobalIndexRow[]; failed: number }> {
  const defs = region === 'all' ? GLOBAL_INDEX_DEFS : GLOBAL_INDEX_DEFS.filter((d) => d.region === region)
  const symbols = defs.map((d) => SINA_SYMBOL_BY_SECID[d.secid]).filter((s): s is string => !!s)
  if (!symbols.length) return { rows: [], failed: defs.length }
  const text = await httpGetText(`${SINA_GLOBAL_URL}${symbols.join(',')}`, {}, {
    timeoutMs: GLOBAL_INDICES_TIMEOUT_MS,
    referer: SINA_GLOBAL_REFERER,
    encoding: 'gbk',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const { rows, failed } = buildSinaGlobalRows(text, defs)
  // 全部为空说明被封或接口变更，明确失败而不是返回一堆 null。
  if (rows.every((row) => row.price === null)) throw new Error('新浪全球指数未返回任何价格')

  // 新浪缺美债 10Y：用日线补这一行，并把来源标清楚。
  const us10y = rows.find((row) => row.secid === '171.US10Y')
  if (us10y && us10y.price === null) {
    const filled = await fetchUs10yFromDailyHistory(options)
    if (filled) {
      Object.assign(us10y, { ...filled, source: 'eastmoney-push2his-daily', error: undefined })
      delete (us10y as { error?: string }).error
      return { rows, failed: rows.filter((row) => row.price === null).length }
    }
  }
  return { rows, failed }
}
