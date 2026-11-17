/**
 * 全球财务数据：美股 SEC EDGAR XBRL companyfacts + 港股东财 F10。
 *
 * 边界：本文件是「获取 + 规范化」的独立模块，不注册 provider、不改 dossier/tools。
 * 网络请求只经由可注入的 fetchJson；解析器全部是纯函数，测试用 fixture 离线跑。
 *
 * 上游与实测状态（2026-11-17 本机实测可达）：
 * - SEC https://www.sec.gov/files/company_tickers.json（ticker→CIK；必须带 User-Agent，
 *   本模块要求 UA 含可联系邮箱，缺省读 DSH_SEC_EDGAR_UA，与仓库既有 SEC 纪律一致）
 * - SEC https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json（us-gaap XBRL 事实）
 * - 东财 https://datacenter.eastmoney.com/securities/api/data/v1/get
 *   reportName=RPT_HKF10_FN_MAININDICATOR（00700 最新 2026-06-30，CURRENCY=HKD）
 *   reportName=RPT_HKF10_INFO_ORGPROFILE（公司名/行业/上市日/网址）
 *
 * 口径纪律：
 * - fetchedAt 只是抓取时间；报告期一律来自源侧 REPORT_DATE / fact.end，两者不混用。
 * - 缺失就是 null，绝不补 0；金额保留源侧原始单位（美股 USD、港股为行内 CURRENCY），
 *   不做缩放、不做币种换算。
 * - 美股只认 form 10-K / 10-Q、只取 us-gaap 显式列出的 tag；EPS 只取单位
 *   「USD/shares」的事实，不把金额单位混进 EPS。
 * - 美股 10-Q 的流量指标取「单季度」事实（约 91 天），10-K 取「年度」事实（约 365 天）；
 *   找不到该口径就留空，绝不拿累计值/单季值顶替另一种期间口径。港股东财的
 *   OPERATE_INCOME / HOLDER_PROFIT 等是「年初至今累计」口径，跨市场对比时不能直接比。
 * - 期间身份 = (form, end, fp, fy)；同一期间在后续申报里重复披露时保留最新 filed
 *   （附 accession 可追溯）。同一 (form, fy, fp) 只保留 end 最大的那一期作为「申报期」，
 *   在更晚申报里作为比较期出现的旧资产负债表快照不单独成行。
 */

import { httpGetJson } from './http.js'

// ---------------------------------------------------------------- 常量与端点

/** SEC 官方 ticker→CIK 映射（约 1 万条，全市场）。 */
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
export const SEC_COMPANYFACTS_ORIGIN = 'https://data.sec.gov'

/** SEC companyfacts JSON 地址；CIK 补齐 10 位。 */
export function secCompanyFactsUrl(cik: string | number): string {
  const digits = String(cik ?? '').replace(/\D/g, '')
  if (!digits) throw new Error('SEC companyfacts 需要有效 CIK（数字）')
  return `${SEC_COMPANYFACTS_ORIGIN}/api/xbrl/companyfacts/CIK${digits.padStart(10, '0')}.json`
}

/** 东财 securities 数据中心统一入口，靠 reportName 区分报表。 */
export const EM_HK_F10_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
export const HK_F10_MAIN_INDICATOR_REPORT = 'RPT_HKF10_FN_MAININDICATOR'
export const HK_F10_ORG_PROFILE_REPORT = 'RPT_HKF10_INFO_ORGPROFILE'

/** 结果 source 标识：美股行来自 companyfacts，港股行来自 MAININDICATOR。 */
export const US_SOURCE = 'sec-edgar-companyfacts'
export const HK_SOURCE = 'eastmoney-hk-f10-main-indicator'

export const US_CURRENCY = 'USD' as const
export const US_AMOUNT_UNIT = 'USD' as const
export const US_EPS_UNIT = 'USD/shares' as const

export const GLOBAL_FINANCIALS_TIMEOUT_MS = 20_000
export const US_DEFAULT_MAX_PERIODS = 24
export const US_MAX_PERIODS_LIMIT = 120
export const HK_DEFAULT_PERIODS = 8
export const HK_MAX_PERIODS_LIMIT = 50

// ---------------------------------------------------------------- SEC User-Agent

const SEC_CONTACT_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

/**
 * SEC 要求 User-Agent 标识应用并含可联系邮箱。显式参数优先，其次环境变量
 * DSH_SEC_EDGAR_UA；都不满足时直接阻止请求（不发送无标识请求，避免 403/临时封禁）。
 */
export function resolveSecUserAgent(explicit?: string): string {
  const ua = String(explicit ?? process.env.DSH_SEC_EDGAR_UA ?? '').trim()
  if (!ua || !SEC_CONTACT_EMAIL.test(ua)) {
    throw new Error(
      'SEC EDGAR 要求 User-Agent 含可联系邮箱：请传入 userAgent 或设置 DSH_SEC_EDGAR_UA'
      + '（例如 "dsh-finance/0.1 ops@example.com"）；本次未发送请求。',
    )
  }
  return ua
}

// ---------------------------------------------------------------- 美股 ticker → CIK（纯）

export interface SecTickerEntry {
  /** 规范化后的 EDGAR ticker（大写，'.'/'/' 归一为 '-'，如 BRK-B）。 */
  ticker: string
  /** 数字字符串形式的 CIK。 */
  cik: string
  /** 补零到 10 位的 CIK。 */
  cik10: string
  title: string
}

export interface SecTickerIndex {
  byTicker: Map<string, SecTickerEntry>
  entries: SecTickerEntry[]
}

/**
 * ticker 规范化：大小写不敏感；`BRK.B` / `BRK/B` / `BRK-B` 统一为 `BRK-B`；
 * 忽略 `AAPL.US` 之类的市场后缀。空值返回 ''。
 */
export function canonicalUsTicker(raw: string): string {
  let t = String(raw ?? '').trim().toUpperCase()
  if (!t) return ''
  t = t.replace(/\.US$/, '')
  t = t.replace(/[\s_/]+/g, '-').replace(/\./g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return t
}

/**
 * 解析 SEC company_tickers.json → ticker 索引。结构不符/无有效条目时抛错，
 * 不把空映射当成功（否则会把所有 ticker 都误报成未知）。
 */
export function parseSecTickerMap(raw: unknown): SecTickerIndex {
  const rows = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.values(raw as Record<string, unknown>)
    : []
  const entries: SecTickerEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const o = row as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const cikNum = Number(o.cik_str ?? o.cik)
    if (!Number.isInteger(cikNum) || cikNum <= 0) continue
    const ticker = canonicalUsTicker(typeof o.ticker === 'string' ? o.ticker : '')
    if (!ticker || seen.has(ticker)) continue
    seen.add(ticker)
    entries.push({ ticker, cik: String(cikNum), cik10: String(cikNum).padStart(10, '0'), title })
  }
  if (!entries.length) throw new Error('SEC company_tickers 解析失败：没有有效的 ticker/CIK 条目')
  entries.sort((a, b) => a.ticker.localeCompare(b.ticker))
  return { byTicker: new Map(entries.map((e) => [e.ticker, e])), entries }
}

export interface SecTickerResolution {
  ok: boolean
  /** 用户原始输入（未规范化）。 */
  input: string
  ticker?: string
  cik?: string
  cik10?: string
  name?: string
  error?: string
  /** 未知 ticker 时给出少量前缀相近候选（仅供提示，不作为命中）。 */
  candidates?: string[]
}

/** ticker → CIK 精确解析（大小写/分隔符容忍）；未命中明确返回 error。 */
export function resolveSecTicker(rawTicker: string, index: SecTickerIndex): SecTickerResolution {
  const input = String(rawTicker ?? '').trim()
  const normalized = canonicalUsTicker(input)
  if (!normalized) return { ok: false, input, error: '美股 ticker 为空' }
  const hit = index.byTicker.get(normalized)
  if (hit) {
    return { ok: true, input, ticker: hit.ticker, cik: hit.cik, cik10: hit.cik10, name: hit.title || undefined }
  }
  const candidates = normalized.length >= 2
    ? index.entries.filter((e) => e.ticker.startsWith(normalized)).slice(0, 5).map((e) => e.ticker)
    : []
  return {
    ok: false,
    input,
    error: `SEC EDGAR 未找到 ticker「${input}」（规范化后 ${normalized}）`,
    ...(candidates.length ? { candidates } : {}),
  }
}

// ---------------------------------------------------------------- 美股 us-gaap 指标

export type UsMetricKey =
  | 'revenue'
  | 'netProfit'
  | 'operatingIncome'
  | 'totalAssets'
  | 'totalLiabilities'
  | 'equity'
  | 'cashAndCashEquivalents'
  | 'eps'

export interface UsMetricSpec {
  key: UsMetricKey
  label: string
  /** 按优先级从高到低的 us-gaap tag；只取这里列出的 tag。 */
  tags: readonly string[]
  /** 该指标接受的事实单位（美股金额 USD，EPS 为 USD/shares）。 */
  unit: string
  /** flow = 期间值（有 start）；instant = 时点值（只有 end）。 */
  kind: 'flow' | 'instant'
}

export const US_METRIC_SPECS: readonly UsMetricSpec[] = [
  {
    key: 'revenue',
    label: '营业收入',
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
    ],
    unit: US_AMOUNT_UNIT,
    kind: 'flow',
  },
  { key: 'netProfit', label: '净利润', tags: ['NetIncomeLoss'], unit: US_AMOUNT_UNIT, kind: 'flow' },
  { key: 'operatingIncome', label: '营业利润', tags: ['OperatingIncomeLoss'], unit: US_AMOUNT_UNIT, kind: 'flow' },
  { key: 'totalAssets', label: '总资产', tags: ['Assets'], unit: US_AMOUNT_UNIT, kind: 'instant' },
  { key: 'totalLiabilities', label: '总负债', tags: ['Liabilities'], unit: US_AMOUNT_UNIT, kind: 'instant' },
  { key: 'equity', label: '股东权益', tags: ['StockholdersEquity'], unit: US_AMOUNT_UNIT, kind: 'instant' },
  {
    key: 'cashAndCashEquivalents',
    label: '现金及现金等价物',
    tags: ['CashAndCashEquivalentsAtCarryingValue'],
    unit: US_AMOUNT_UNIT,
    kind: 'instant',
  },
  { key: 'eps', label: '稀释每股收益', tags: ['EarningsPerShareDiluted'], unit: US_EPS_UNIT, kind: 'flow' },
]

/** 本模块认的全部 us-gaap tag（供调用方核对，不在此列表的一律忽略）。 */
export const US_GAAP_TAGS: readonly string[] = [...new Set(US_METRIC_SPECS.flatMap((s) => s.tags))]

/**
 * 期间口径窗口（天）：10-K 取年度事实，10-Q 取单季度事实。窗口用于拒绝同一
 * (form,end,fp,fy) 下混入的 Q4 单季值（10-K）或年初至今累计值（10-Q）。
 * 52/53 周财年常见 363~371 天，窗口留足余量。
 */
const ANNUAL_WINDOW = { target: 365, min: 320, max: 410 } as const
const QUARTER_WINDOW = { target: 91, min: 60, max: 120 } as const

export interface UsMetricSource {
  tag: string
  unit: string
  accession: string
  filed: string
  /** 该事实的期间起点（时点值为 null）。 */
  start: string | null
}

export interface UsFinancialRow {
  form: '10-K' | '10-Q'
  /** 报告期末（源侧 fact.end）。 */
  end: string
  start: string | null
  fy: number | null
  fp: string | null
  /** 10-K → annual（年度事实）；10-Q → quarterly（单季度事实）。 */
  periodType: 'annual' | 'quarterly'
  durationDays: number | null
  currency: typeof US_CURRENCY
  /** 金额单位（USD，原始单位不缩放）。 */
  unit: typeof US_AMOUNT_UNIT
  /** EPS 单位（USD/shares）。 */
  epsUnit: typeof US_EPS_UNIT
  /** 该行主要指标来源申报的提交日；不同指标可能来自不同申报，见 sources。 */
  filed: string
  accession: string
  revenue: number | null
  netProfit: number | null
  operatingIncome: number | null
  totalAssets: number | null
  totalLiabilities: number | null
  equity: number | null
  cashAndCashEquivalents: number | null
  eps: number | null
  /** 每个指标实际选用的 tag/单位/来源申报。 */
  sources: Partial<Record<UsMetricKey, UsMetricSource>>
}

interface UsFact {
  form: '10-K' | '10-Q'
  start?: string
  end: string
  val: number
  accn: string
  fy?: number
  fp?: string
  filed: string
}

interface UsFactCandidate {
  fact: UsFact
  tag: string
  tagRank: number
  unit: string
  /** 与该期间口径目标天数的距离（越小越优先）。 */
  distance: number
  duration: number | null
}

interface UsFactGroup {
  form: '10-K' | '10-Q'
  end: string
  fy: number | null
  fp: string | null
  metrics: Map<UsMetricKey, UsFactCandidate>
}

function isoDateOrEmpty(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round((b - a) / 86_400_000)
}

/** companyfacts 单条事实的防御式读取：结构/单位不符返回 null（忽略，不猜）。 */
function readUsFact(item: unknown): UsFact | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const o = item as Record<string, unknown>
  const end = isoDateOrEmpty(o.end)
  if (!end) return null
  const form = typeof o.form === 'string' ? o.form.trim() : ''
  if (form !== '10-K' && form !== '10-Q') return null
  const rawVal = o.val
  // null/undefined/空串/布尔都不是数值：忽略该事实，绝不 Number(null)=0 补零。
  if (rawVal === null || rawVal === undefined || rawVal === '' || typeof rawVal === 'boolean') return null
  const val = typeof rawVal === 'number' ? rawVal : Number(rawVal)
  if (!Number.isFinite(val)) return null
  const start = isoDateOrEmpty(o.start)
  const fy = typeof o.fy === 'number' && Number.isFinite(o.fy) ? o.fy : undefined
  const fp = typeof o.fp === 'string' && o.fp.trim() ? o.fp.trim() : undefined
  return {
    form,
    ...(start ? { start } : {}),
    end,
    val,
    accn: typeof o.accn === 'string' ? o.accn.trim() : '',
    ...(fy !== undefined ? { fy } : {}),
    ...(fp !== undefined ? { fp } : {}),
    filed: isoDateOrEmpty(o.filed),
  }
}

/** 该事实是否符合指标的期间口径；不符合就直接丢弃（留空，不拿别口径顶替）。 */
function acceptanceOf(spec: UsMetricSpec, fact: UsFact): { ok: true; distance: number; duration: number | null } | { ok: false } {
  if (spec.kind === 'instant') {
    // 时点指标不接受带 start 的事实，避免把某段期间值误当时点值。
    if (fact.start) return { ok: false }
    return { ok: true, distance: 0, duration: null }
  }
  if (!fact.start) return { ok: false }
  const duration = daysBetween(fact.start, fact.end)
  if (duration === null) return { ok: false }
  const window = fact.form === '10-K' ? ANNUAL_WINDOW : QUARTER_WINDOW
  if (duration < window.min || duration > window.max) return { ok: false }
  return { ok: true, distance: Math.abs(duration - window.target), duration }
}

/** 同一 (tag, form, end, fp, fy) 候选的确定性择优：口径更准 → tag 优先级 → filed 更新 → accession。 */
function betterCandidate(current: UsFactCandidate | undefined, next: UsFactCandidate): UsFactCandidate {
  if (!current) return next
  if (next.distance !== current.distance) return next.distance < current.distance ? next : current
  if (next.tagRank !== current.tagRank) return next.tagRank < current.tagRank ? next : current
  const filedCmp = next.fact.filed.localeCompare(current.fact.filed)
  if (filedCmp !== 0) return filedCmp > 0 ? next : current
  return next.fact.accn.localeCompare(current.fact.accn) > 0 ? next : current
}

export interface SecCompanyFactsParseOptions {
  /** 最多返回多少期（按 end 倒序取最近）；默认 24，范围 1..120。 */
  maxPeriods?: number
}

export interface SecCompanyFactsParse {
  cik: string | null
  entityName: string | null
  rows: UsFinancialRow[]
}

/** 统一限制「返回最近多少期」：非法值回落默认，范围 1..120。 */
export function clampUsMaxPeriods(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return US_DEFAULT_MAX_PERIODS
  return Math.min(US_MAX_PERIODS_LIMIT, Math.max(1, Math.trunc(n)))
}

/**
 * 解析 SEC companyfacts JSON（纯函数）。
 *
 * 步骤：只扫 facts['us-gaap'] 中 US_METRIC_SPECS 列出的 tag → 按单位取事实 →
 * 按 (form, end, fp, fy) 分组并做指标级去重（保留最新 filed 的申报）→
 * 每个 (form, fy, fp) 只保留 end 最大的申报期（剔除比较期快照）→ 按 end 倒序截断。
 *
 * 结构不符（非对象 / 缺 facts['us-gaap']）抛错；结构合法但没有目标 tag 返回空 rows
 * （由调用方决定是否 ok=false，绝不补 0）。
 */
export function parseSecCompanyFacts(raw: unknown, options: SecCompanyFactsParseOptions = {}): SecCompanyFactsParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('SEC companyfacts 解析失败：响应不是 JSON 对象')
  }
  const root = raw as Record<string, unknown>
  const facts = root.facts
  const gaap = facts && typeof facts === 'object' && !Array.isArray(facts)
    ? (facts as Record<string, unknown>)['us-gaap']
    : undefined
  if (!gaap || typeof gaap !== 'object' || Array.isArray(gaap)) {
    throw new Error("SEC companyfacts 解析失败：缺少 facts['us-gaap']（20-F/40-F 外国私人发行人、基金等可能不适用）")
  }
  const gaapObj = gaap as Record<string, unknown>
  const groups = new Map<string, UsFactGroup>()

  for (const spec of US_METRIC_SPECS) {
    for (let rank = 0; rank < spec.tags.length; rank++) {
      const tag = spec.tags[rank]!
      const node = gaapObj[tag]
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue
      const units = (node as Record<string, unknown>).units
      if (!units || typeof units !== 'object' || Array.isArray(units)) continue
      const list = (units as Record<string, unknown>)[spec.unit]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const fact = readUsFact(item)
        if (!fact) continue
        const acceptance = acceptanceOf(spec, fact)
        if (!acceptance.ok) continue
        const key = `${fact.form}|${fact.end}|${fact.fp ?? ''}|${fact.fy ?? ''}`
        let group = groups.get(key)
        if (!group) {
          group = { form: fact.form, end: fact.end, fy: fact.fy ?? null, fp: fact.fp ?? null, metrics: new Map() }
          groups.set(key, group)
        }
        const candidate: UsFactCandidate = {
          fact,
          tag,
          tagRank: rank,
          unit: spec.unit,
          distance: acceptance.distance,
          duration: acceptance.duration,
        }
        group.metrics.set(spec.key, betterCandidate(group.metrics.get(spec.key), candidate))
      }
    }
  }

  // 申报期主期间：同一 (form, fy, fp) 的 end 最大值即申报期本身；更早 end 是
  // 申报里带出的比较期（上一年资产负债表快照等），不单独成行。
  const primaryEnd = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.fy === null || group.fp === null) continue
    const key = `${group.form}|${group.fy}|${group.fp}`
    const current = primaryEnd.get(key)
    if (!current || group.end > current) primaryEnd.set(key, group.end)
  }

  const rows: UsFinancialRow[] = []
  for (const group of groups.values()) {
    const entries = [...group.metrics.entries()]
    if (!entries.length) continue
    if (group.fy !== null && group.fp !== null) {
      const key = `${group.form}|${group.fy}|${group.fp}`
      if (primaryEnd.get(key) !== group.end) continue
    }
    const valueOf = (key: UsMetricKey): number | null => group.metrics.get(key)?.fact.val ?? null
    const revenue = group.metrics.get('revenue')
    const flowStarts = entries
      .map(([, c]) => c.fact.start)
      .filter((s): s is string => typeof s === 'string')
    const start = revenue?.fact.start ?? flowStarts[0] ?? null
    const sources: Partial<Record<UsMetricKey, UsMetricSource>> = {}
    for (const [key, candidate] of entries) {
      sources[key] = {
        tag: candidate.tag,
        unit: candidate.unit,
        accession: candidate.fact.accn,
        filed: candidate.fact.filed,
        start: candidate.fact.start ?? null,
      }
    }
    const primarySource = entries
      .map(([, c]) => c.fact)
      .sort((a, b) => b.filed.localeCompare(a.filed) || b.accn.localeCompare(a.accn))[0]
    rows.push({
      form: group.form,
      end: group.end,
      start,
      fy: group.fy,
      fp: group.fp,
      periodType: group.form === '10-K' ? 'annual' : 'quarterly',
      durationDays: start ? daysBetween(start, group.end) : null,
      currency: US_CURRENCY,
      unit: US_AMOUNT_UNIT,
      epsUnit: US_EPS_UNIT,
      filed: primarySource?.filed ?? '',
      accession: primarySource?.accn ?? '',
      revenue: valueOf('revenue'),
      netProfit: valueOf('netProfit'),
      operatingIncome: valueOf('operatingIncome'),
      totalAssets: valueOf('totalAssets'),
      totalLiabilities: valueOf('totalLiabilities'),
      equity: valueOf('equity'),
      cashAndCashEquivalents: valueOf('cashAndCashEquivalents'),
      eps: valueOf('eps'),
      sources,
    })
  }

  rows.sort((a, b) => b.end.localeCompare(a.end) || (b.fy ?? 0) - (a.fy ?? 0) || a.form.localeCompare(b.form))
  const limit = clampUsMaxPeriods(options.maxPeriods)
  const cik = root.cik === undefined || root.cik === null ? null : String(root.cik)
  const entityName = typeof root.entityName === 'string' && root.entityName.trim() ? root.entityName.trim() : null
  return { cik, entityName, rows: rows.slice(0, limit) }
}

// ---------------------------------------------------------------- 港股（东财 F10，纯）

export interface HkFinancialRow {
  /** 报告期末 YYYY-MM-DD（REPORT_DATE，不是抓取时间）。 */
  reportDate: string
  /** 源侧报告类型，如「2026年中报」；缺失 null。 */
  reportType: string | null
  /** 报告币种（CURRENCY）；缺失 null。金额字段单位即该币种原始单位。 */
  currency: string | null
  revenue: number | null
  revenueYoY: number | null
  netProfit: number | null
  netProfitYoY: number | null
  /** 基本每股收益（BASIC_EPS）；源侧没有就 null。 */
  eps: number | null
  roe: number | null
  pe: number | null
  pb: number | null
  totalAssets: number | null
  totalLiabilities: number | null
  /** 归母权益（TOTAL_PARENT_EQUITY）。 */
  equity: number | null
  /** 经营活动现金流量净额（NETCASH_OPERATE）。 */
  operatingCashFlow: number | null
}

export interface HkCompanyProfile {
  /** 证券简称（SECURITY_NAME_ABBR）。 */
  name: string | null
  /** 公司全称（ORG_NAME）。 */
  orgName: string | null
  industry: string | null
  listingDate: string | null
  /** 源侧原始网址（可能是 www.example.com，不补协议）。 */
  website: string | null
}

export interface HkIndicatorParse {
  rows: HkFinancialRow[]
  /** 第一行 SECURITY_NAME_ABBR（仅作展示名）。 */
  name: string | null
  /** 各行出现过的报告币种（去重，按行顺序）。 */
  currencies: string[]
}

function textOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s : null
}

/** 数值读取：0 是有效值，缺失/空串/非数字一律 null（绝不补 0）。 */
function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function dateOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** SECUCODE（如 "00700.HK"）或 1-5 位数字 → 5 位港股代码；非法返回 null。 */
export function normalizeHkCode(raw: string): string | null {
  let t = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!t) return null
  t = t.replace(/^HK[.:]?/, '').replace(/\.HK$/, '')
  if (!/^\d{1,5}$/.test(t)) return null
  return t.padStart(5, '0')
}

/** 港股主财务指标请求参数（已实测：filter=(SECUCODE="00700.HK")、sortColumns=REPORT_DATE desc）。 */
export function hkMainIndicatorParams(secucode: string, pageSize: number = HK_DEFAULT_PERIODS): Record<string, string | number> {
  return {
    reportName: HK_F10_MAIN_INDICATOR_REPORT,
    columns: 'ALL',
    filter: `(SECUCODE="${secucode}")`,
    pageNumber: 1,
    pageSize: clampHkPeriods(pageSize),
    sortTypes: -1,
    sortColumns: 'REPORT_DATE',
    source: 'F10',
    client: 'PC',
  }
}

/** 港股公司资料请求参数。 */
export function hkOrgProfileParams(secucode: string): Record<string, string | number> {
  return {
    reportName: HK_F10_ORG_PROFILE_REPORT,
    columns: 'ALL',
    filter: `(SECUCODE="${secucode}")`,
    pageNumber: 1,
    pageSize: 1,
    source: 'F10',
    client: 'PC',
  }
}

export function clampHkPeriods(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return HK_DEFAULT_PERIODS
  return Math.min(HK_MAX_PERIODS_LIMIT, Math.max(1, Math.trunc(n)))
}

/**
 * 东财 RPT_HKF10_FN_MAININDICATOR → 期间行（纯函数）。
 * success=false（未知代码时源侧返回 9201 +「返回数据为空」）抛错并带上游 message；
 * result 结构合法但为空返回 rows: []。所有字段缺失为 null，不补 0。
 * 行按 reportDate 倒序；同一报告期重复时保留先出现的那行。
 */
export function normalizeHkMainIndicator(raw: unknown): HkIndicatorParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('东财港股财务解析失败：响应不是 JSON 对象')
  }
  const root = raw as Record<string, unknown>
  if (root.success === false) {
    const message = textOrNull(root.message) ?? '未给出原因'
    throw new Error(`东财港股财务接口返回失败：${message}`)
  }
  const result = root.result
  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).data
    : undefined
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const rows: HkFinancialRow[] = []
  const seen = new Set<string>()
  const currencies: string[] = []
  let name: string | null = null
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const reportDate = dateOrNull(o.REPORT_DATE) ?? dateOrNull(o.STD_REPORT_DATE)
    if (!reportDate || seen.has(reportDate)) continue
    seen.add(reportDate)
    const currency = textOrNull(o.CURRENCY)?.toUpperCase() ?? null
    if (currency && !currencies.includes(currency)) currencies.push(currency)
    if (!name) name = textOrNull(o.SECURITY_NAME_ABBR)
    rows.push({
      reportDate,
      reportType: textOrNull(o.REPORT_TYPE),
      currency,
      revenue: numOrNull(o.OPERATE_INCOME),
      revenueYoY: numOrNull(o.OPERATE_INCOME_YOY),
      netProfit: numOrNull(o.HOLDER_PROFIT),
      netProfitYoY: numOrNull(o.HOLDER_PROFIT_YOY),
      eps: numOrNull(o.BASIC_EPS),
      roe: numOrNull(o.ROE_AVG),
      pe: numOrNull(o.PE_TTM),
      pb: numOrNull(o.PB_TTM),
      totalAssets: numOrNull(o.TOTAL_ASSETS),
      totalLiabilities: numOrNull(o.TOTAL_LIABILITIES),
      equity: numOrNull(o.TOTAL_PARENT_EQUITY),
      operatingCashFlow: numOrNull(o.NETCASH_OPERATE),
    })
  }
  rows.sort((a, b) => b.reportDate.localeCompare(a.reportDate))
  return { rows, name, currencies }
}

/**
 * 东财 RPT_HKF10_INFO_ORGPROFILE → 公司资料（纯函数）。
 * 无资料/接口 success=false 返回 null（资料是辅助信息，不编造）；字段缺失为 null。
 */
export function parseHkOrgProfile(raw: unknown): HkCompanyProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  if (root.success === false) return null
  const result = root.result
  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).data
    : undefined
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  const profile: HkCompanyProfile = {
    name: textOrNull(o.SECURITY_NAME_ABBR),
    orgName: textOrNull(o.ORG_NAME),
    industry: textOrNull(o.BELONG_INDUSTRY),
    listingDate: dateOrNull(o.LISTING_DATE),
    website: textOrNull(o.ORG_WEB),
  }
  return Object.values(profile).every((v) => v === null) ? null : profile
}

// ---------------------------------------------------------------- 统一结果 + 取数

export type GlobalFinancialMarket = 'us' | 'hk'

export type GlobalFinancialRow = UsFinancialRow | HkFinancialRow

export interface GlobalFinancialsResult {
  ok: boolean
  market: GlobalFinancialMarket
  code: string
  name: string | null
  /** 美股恒为 USD；港股为各行共同币种，缺失或各期不一致时 null（不换算）。 */
  currency: string | null
  source: string
  /** 抓取时间（ISO）；不是任何报告期。 */
  fetchedAt: string
  rows: GlobalFinancialRow[]
  profile?: HkCompanyProfile
  error?: string
  /** 非致命问题（如港股公司资料缺失、各期币种不一致）。 */
  warnings?: string[]
}

export interface UsFinancialsResult extends GlobalFinancialsResult {
  market: 'us'
  currency: 'USD'
  rows: UsFinancialRow[]
}

export interface HkFinancialsResult extends GlobalFinancialsResult {
  market: 'hk'
  rows: HkFinancialRow[]
  profile?: HkCompanyProfile
}

export interface GlobalFinancialsHttpOptions {
  timeoutMs: number
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type GlobalFinancialsFetchJson = (
  url: string,
  params: Record<string, string | number | undefined>,
  options: GlobalFinancialsHttpOptions,
) => Promise<unknown>

export interface GlobalFinancialsFetchOptions {
  /** 测试注入点；默认走 data/http.ts 的 httpGetJson。 */
  fetchJson?: GlobalFinancialsFetchJson
  timeoutMs?: number
  /** 抓取时间来源（测试固定时间用）。 */
  now?: () => Date
  signal?: AbortSignal
  /** 美股 SEC User-Agent；缺省读 DSH_SEC_EDGAR_UA，必须含可联系邮箱。 */
  userAgent?: string
  /** 美股最多返回期数（默认 24，1..120）。 */
  maxPeriods?: number
  /** 港股 pageSize（默认 8，1..50）。 */
  periods?: number
  /** 港股是否顺带取公司资料（默认 true；失败只进 warnings，不影响 rows）。 */
  includeProfile?: boolean
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function usFailure(fetchedAt: string, code: string, error: string): UsFinancialsResult {
  return {
    ok: false,
    market: 'us',
    code,
    name: null,
    currency: US_CURRENCY,
    source: US_SOURCE,
    fetchedAt,
    rows: [],
    error,
  }
}

function hkFailure(fetchedAt: string, code: string, error: string): HkFinancialsResult {
  return {
    ok: false,
    market: 'hk',
    code,
    name: null,
    currency: null,
    source: HK_SOURCE,
    fetchedAt,
    rows: [],
    error,
  }
}

/**
 * 美股财务取数：company_tickers.json → ticker→CIK → companyfacts → 规范化 rows。
 * 任何失败都返回 ok:false + error（不抛），未知 ticker 会带相近候选提示。
 */
export async function fetchUsFinancials(ticker: string, options: GlobalFinancialsFetchOptions = {}): Promise<UsFinancialsResult> {
  const fetchedAt = (options.now?.() ?? new Date()).toISOString()
  const input = String(ticker ?? '').trim()
  const normalized = canonicalUsTicker(input)
  const timeoutMs = options.timeoutMs ?? GLOBAL_FINANCIALS_TIMEOUT_MS
  const fetchJson = options.fetchJson ?? httpGetJson
  if (!normalized) return usFailure(fetchedAt, input, '美股 ticker 为空')
  let headers: Record<string, string>
  try {
    headers = { 'User-Agent': resolveSecUserAgent(options.userAgent), Accept: 'application/json' }
  } catch (err) {
    return usFailure(fetchedAt, normalized, reasonOf(err))
  }

  let tickerRaw: unknown
  try {
    tickerRaw = await fetchJson(SEC_TICKERS_URL, {}, { timeoutMs, headers, signal: options.signal })
  } catch (err) {
    return usFailure(fetchedAt, normalized, `SEC company_tickers 请求失败：${reasonOf(err)}（SEC 要求 User-Agent 含可联系邮箱）`)
  }
  let index: SecTickerIndex
  try {
    index = parseSecTickerMap(tickerRaw)
  } catch (err) {
    return usFailure(fetchedAt, normalized, reasonOf(err))
  }
  const resolved = resolveSecTicker(normalized, index)
  if (!resolved.ok) {
    const hint = resolved.candidates?.length ? `；相近 ticker：${resolved.candidates.join(' / ')}` : ''
    return usFailure(fetchedAt, normalized, `${resolved.error ?? '未知 ticker'}${hint}`)
  }

  let factsRaw: unknown
  try {
    factsRaw = await fetchJson(secCompanyFactsUrl(resolved.cik10!), {}, { timeoutMs, headers, signal: options.signal })
  } catch (err) {
    return usFailure(fetchedAt, resolved.ticker ?? normalized, `SEC companyfacts 请求失败：${reasonOf(err)}`)
  }
  let parsed: SecCompanyFactsParse
  try {
    parsed = parseSecCompanyFacts(factsRaw, { maxPeriods: options.maxPeriods })
  } catch (err) {
    return usFailure(fetchedAt, resolved.ticker ?? normalized, reasonOf(err))
  }
  const name = parsed.entityName ?? resolved.name ?? null
  if (!parsed.rows.length) {
    return {
      ...usFailure(fetchedAt, resolved.ticker ?? normalized, '该 CIK 没有解析出 10-K/10-Q 的目标 us-gaap 指标（不补 0）'),
      name,
    }
  }
  return {
    ok: true,
    market: 'us',
    code: resolved.ticker ?? normalized,
    name,
    currency: US_CURRENCY,
    source: US_SOURCE,
    fetchedAt,
    rows: parsed.rows,
  }
}

/**
 * 港股财务取数：MAININDICATOR（期间行）+ ORGPROFILE（公司资料，默认取）。
 * success=false / 0 行都明确 ok:false；公司资料单独失败只进 warnings，不影响 rows。
 */
export async function fetchHkFinancials(code: string, options: GlobalFinancialsFetchOptions = {}): Promise<HkFinancialsResult> {
  const fetchedAt = (options.now?.() ?? new Date()).toISOString()
  const input = String(code ?? '').trim()
  const normalized = normalizeHkCode(input)
  const timeoutMs = options.timeoutMs ?? GLOBAL_FINANCIALS_TIMEOUT_MS
  const fetchJson = options.fetchJson ?? httpGetJson
  if (!normalized) return hkFailure(fetchedAt, input, '港股代码无效：请用 5 位代码（如 00700）或 00700.HK')
  const secucode = `${normalized}.HK`
  const headers = { Accept: 'application/json' }

  let mainRaw: unknown
  try {
    mainRaw = await fetchJson(EM_HK_F10_URL, hkMainIndicatorParams(secucode, options.periods), { timeoutMs, headers, signal: options.signal })
  } catch (err) {
    return hkFailure(fetchedAt, normalized, `东财港股财务请求失败：${reasonOf(err)}`)
  }
  let parsed: HkIndicatorParse
  try {
    parsed = normalizeHkMainIndicator(mainRaw)
  } catch (err) {
    return hkFailure(fetchedAt, normalized, reasonOf(err))
  }
  if (!parsed.rows.length) {
    return { ...hkFailure(fetchedAt, normalized, '东财港股财务接口未返回财务期间行（不补 0）'), name: parsed.name }
  }

  const warnings: string[] = []
  const currency = parsed.currencies.length === 1 ? parsed.currencies[0]! : null
  if (parsed.currencies.length > 1) {
    warnings.push(`各期报告币种不一致（${parsed.currencies.join(' / ')}）：未做换算，逐行 currency 为准`)
  }

  let profile: HkCompanyProfile | undefined
  if (options.includeProfile !== false) {
    try {
      const profileRaw = await fetchJson(EM_HK_F10_URL, hkOrgProfileParams(secucode), { timeoutMs, headers, signal: options.signal })
      const parsedProfile = parseHkOrgProfile(profileRaw)
      if (parsedProfile) profile = parsedProfile
      else warnings.push('东财未返回公司资料（profile 缺失，不用其它来源补齐）')
    } catch (err) {
      warnings.push(`东财公司资料请求失败：${reasonOf(err)}`)
    }
  }

  return {
    ok: true,
    market: 'hk',
    code: normalized,
    name: parsed.name ?? profile?.name ?? null,
    currency,
    source: HK_SOURCE,
    fetchedAt,
    rows: parsed.rows,
    ...(profile ? { profile } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}
