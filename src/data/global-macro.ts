/**
 * 全球宏观结构化数据：序列枚举、元数据、纯解析器与结果装配。
 *
 * 设计约束（工具 get_macro_global、HTTP GET /macro/global、service.getMacroGlobal 共用）：
 * - 只解析真实统计源的原始响应，不做补零、不做估算、不做「全网摘要」。
 * - asOf 永远是「最新有效统计期」，fetchedAt 才是抓取时间，两者绝不混用。
 * - 解析不出数值就返回 error；空值/无效时间计入诊断，不伪造成 0。
 * - 本文件不发起网络请求（HTTP 在 data/providers.ts），便于 fixture 离线测试。
 */

export type GlobalMacroSeriesKey =
  | 'us_cpi'
  | 'ea_hicp'
  | 'ea_unemployment'
  | 'us_gdp_growth'
  | 'ea_gdp_growth'
  | 'ea_policy_rate'

export const GLOBAL_MACRO_SERIES_KEYS: readonly GlobalMacroSeriesKey[] = [
  'us_cpi',
  'ea_hicp',
  'ea_unemployment',
  'us_gdp_growth',
  'ea_gdp_growth',
  'ea_policy_rate',
]

export type GlobalMacroFrequency = 'monthly' | 'annual' | 'daily'

export type GlobalMacroProviderId = 'oecd_sdmx' | 'eurostat' | 'world_bank' | 'ecb_data_api'

/** 原始响应使用的结构化表示（便于 provenance 说明到底解析的是哪一种 JSON/SDMX）。 */
export type GlobalMacroRepresentation = 'jsonstat' | 'sdmx-json' | 'sdmx-generic-xml' | 'worldbank-json'

/** 单条观测：period 为源侧统计期字符串，value 为 null 表示源里确实没有值（不是 0）。 */
export interface RawObservation {
  period: string
  value: number | null
  status?: string
}

export interface ParsedSeriesGroup {
  /** 组键（如 Eurostat 的 geo 代码 EA20，或 SDMX series key）。 */
  key?: string
  /** 该组的维度集合（如 { geo: 'EA20', coicop: 'CP00' }）。 */
  dimensions?: Record<string, string>
  /** 源里的类目标签（人类可读，可能为空）。 */
  label?: string
  observations: RawObservation[]
}

export interface SeriesParseResult {
  groups: ParsedSeriesGroup[]
  /** 上游文档级更新时间（能解析到才有；不是抓取时间）。 */
  updated?: string
  /** 解析诊断：零类目、缺维度、格式不识别等。 */
  issues: string[]
}

export interface GlobalMacroPoint {
  /** 统计期（规范化后：月度 YYYY-MM / 年度 YYYY / 日度 YYYY-MM-DD）。 */
  period: string
  value: number
}

export interface GlobalMacroCoverage {
  sourceFirstPeriod: string | null
  sourceLastPeriod: string | null
  latestValidPeriod: string | null
}

export interface GlobalMacroProvenance {
  provider: GlobalMacroProviderId
  /** 实际请求的上游 URL（不含密钥；这些源都不需要鉴权）。 */
  endpoint: string
  dataset: string
  indicator: string
  geography: string
  frequency: GlobalMacroFrequency
  representation: GlobalMacroRepresentation | null
  /** 源里承载统计期的字段名（如 TIME_PERIOD / time）。 */
  statisticsTimeField: string
  /** 上游响应/元数据自带的时间戳（SDMX header.prepared、World Bank meta.lastupdated）；语义随源而异，不是统计期也不是抓取时间。 */
  upstreamTimestamp?: string
  /** 选中的序列键（SDMX series key / geo 代码）。 */
  seriesKey?: string
  cached: boolean
  pointsReturned: number
  pointsAvailable: number
  truncated: boolean
  /** 值统一四舍五入到该小数位；源精度不同会在此声明。 */
  valueRounding: number
  missingValues: number
  invalidPeriods: number
  droppedDuplicates: number
  coverage: GlobalMacroCoverage
}

export interface GlobalMacroSeries {
  series: GlobalMacroSeriesKey
  label: string
  source: string
  unit: string
  /** 最新有效统计期；无有效数据时为 null（绝不用抓取时间顶替）。 */
  asOf: string | null
  /** 本次（或本进程缓存首次）抓取时间 ISO 字符串。 */
  fetchedAt: string
  points: GlobalMacroPoint[]
  latest: GlobalMacroPoint | null
  provenance: GlobalMacroProvenance
  notes: string[]
  /** 失败/空结果时明确写出原因。 */
  error?: string
}

export interface GlobalMacroReport {
  ok: boolean
  /** 部分成功（既有数据又有失败）。 */
  partial: boolean
  fetchedAt: string
  requested: GlobalMacroSeriesKey[]
  series: GlobalMacroSeries[]
  errors: Array<{ series: string; error: string }>
  notes: string[]
}

export interface GlobalMacroSeriesMeta {
  key: GlobalMacroSeriesKey
  label: string
  source: string
  unit: string
  provider: GlobalMacroProviderId
  dataset: string
  indicator: string
  geography: string
  frequency: GlobalMacroFrequency
  defaultPoints: number
  notes: string[]
}

export const GLOBAL_MACRO_TIMEOUT_MS = 15_000
export const GLOBAL_MACRO_MAX_POINTS = 120
export const GLOBAL_MACRO_DEFAULT_POINTS = 24

/** 统一限制「返回最近多少期」：非法值回落默认，范围 1..120。 */
export function clampGlobalMacroLimit(limit: unknown): number {
  const n = Number(limit)
  if (!Number.isFinite(n)) return GLOBAL_MACRO_DEFAULT_POINTS
  return Math.min(GLOBAL_MACRO_MAX_POINTS, Math.max(1, Math.trunc(n)))
}

export const GLOBAL_MACRO_SERIES_META: Record<GlobalMacroSeriesKey, GlobalMacroSeriesMeta> = {
  us_cpi: {
    key: 'us_cpi',
    label: '美国 CPI 同比（全部项目，未季调）',
    source: 'OECD SDMX · DSD_PRICES@DF_PRICES_ALL（USA.M.N.CPI.PA._T.N.GY）',
    unit: '% 同比',
    provider: 'oecd_sdmx',
    dataset: 'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0',
    indicator: 'CPI all items, growth rate over 1 year（TRANSFORMATION=GY）',
    geography: 'USA',
    frequency: 'monthly',
    defaultPoints: 24,
    notes: ['同比口径直接取 OECD 的 growth rate over 1 year（GY），未在本地用指数二次计算。'],
  },
  ea_hicp: {
    key: 'ea_hicp',
    label: '欧元区 HICP 同比（全部项目）',
    source: 'Eurostat · prc_hicp_manr（HICP monthly annual rate of change）',
    unit: '% 同比',
    provider: 'eurostat',
    dataset: 'prc_hicp_manr',
    indicator: 'CP00 all-items HICP, annual rate of change（unit=RCH_A）',
    geography: 'Euro area',
    frequency: 'monthly',
    defaultPoints: 24,
    notes: ['Eurostat 原始口径为「月度同比」，本地未做季节调整或再加工。'],
  },
  ea_unemployment: {
    key: 'ea_unemployment',
    label: '欧元区失业率（季调）',
    source: 'Eurostat · une_rt_m（unemployment by sex and age, monthly）',
    unit: '%（季调）',
    provider: 'eurostat',
    dataset: 'une_rt_m',
    indicator: 'Total unemployment rate, s_adj=SA, unit=PC_ACT',
    geography: 'Euro area',
    frequency: 'monthly',
    defaultPoints: 24,
    notes: ['季调口径（s_adj=SA）由 Eurostat 提供，本地未改口径。'],
  },
  us_gdp_growth: {
    key: 'us_gdp_growth',
    label: '美国实际 GDP 增速（年度）',
    source: 'World Bank · NY.GDP.MKTP.KD.ZG（GDP growth, annual %）',
    unit: '% 同比',
    provider: 'world_bank',
    dataset: 'NY.GDP.MKTP.KD.ZG',
    indicator: 'GDP growth (annual %), constant 2015 US$',
    geography: 'USA',
    frequency: 'annual',
    defaultPoints: 10,
    notes: ['世界银行年度序列；年度值可能随后修订，以源侧统计期为准。'],
  },
  ea_gdp_growth: {
    key: 'ea_gdp_growth',
    label: '欧元区实际 GDP 增速（年度）',
    source: 'World Bank · NY.GDP.MKTP.KD.ZG（country=EMU）',
    unit: '% 同比',
    provider: 'world_bank',
    dataset: 'NY.GDP.MKTP.KD.ZG',
    indicator: 'GDP growth (annual %), constant 2015 US$',
    geography: 'EMU（Euro area）',
    frequency: 'annual',
    defaultPoints: 10,
    notes: ['World Bank 用 EMU 聚合代表欧元区；口径为实际 GDP 年增速。'],
  },
  ea_policy_rate: {
    key: 'ea_policy_rate',
    label: '欧央行存款便利利率（DFR）',
    source: 'ECB Data Portal · FM/D.U2.EUR.4F.KR.DFR.LEV',
    unit: '%',
    provider: 'ecb_data_api',
    dataset: 'FM',
    indicator: 'Deposit facility rate（level, D.U2.EUR.4F.KR.DFR.LEV）',
    geography: 'Euro area（U2）',
    frequency: 'daily',
    defaultPoints: 40,
    notes: ['日频政策利率，返回最近若干个观测日；不是市场掉期或预测值。'],
  },
}

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数值解析：只有真正可解析的有限数字才算值；空串/NA/null 都返回 null（绝不补 0）。 */
export function parseNumeric(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    if (/^(na|n\/a|null|nil|nan|\.|-|--)$/i.test(text)) return null
    const n = Number(text.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 按源精度展示：四舍五入到固定小数位（不改变量纲；provenance.valueRounding 会声明）。 */
export function roundValue(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/**
 * 统计期规范化：只接受可确定的期格式，非法期返回 undefined（由装配层计入 invalidPeriods）。
 * 月度 YYYY-MM、年度 YYYY、日度 YYYY-MM-DD（必须是真实日期）。
 */
export function normalizePeriod(raw: unknown, frequency: GlobalMacroFrequency): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!text) return undefined
  if (frequency === 'annual') {
    const m = /^(\d{4})$/.exec(text)
    if (!m) return undefined
    const year = Number(m[1])
    return year >= 1900 && year <= 2200 ? String(year) : undefined
  }
  if (frequency === 'monthly') {
    const m = /^(\d{4})-(\d{1,2})$/.exec(text)
    if (!m) return undefined
    const year = Number(m[1])
    const month = Number(m[2])
    if (year < 1900 || year > 2200 || month < 1 || month > 12) return undefined
    return `${year}-${String(month).padStart(2, '0')}`
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** 统计期比较（规范化后的 ISO 风格字符串可直接字典序比较）。 */
function comparePeriod(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 组内是否存在任何有效数值（用于选组；null 不算）。 */
export function hasObservableValue(result: SeriesParseResult): boolean {
  return result.groups.some((group) => group.observations.some((obs) => typeof obs.value === 'number' && Number.isFinite(obs.value)))
}

/**
 * 从多组（Eurostat 多 geo / SDMX 多 series）里挑一组：
 * 先比最新有效统计期，再比有效观测数，最后才用首选顺序兜底（避免因旧聚合口径而选到过期序列）。
 */
export function pickParsedSeriesGroup(
  groups: ParsedSeriesGroup[],
  preferredKeys: readonly string[] = [],
): ParsedSeriesGroup | undefined {
  const ranked = groups
    .map((group) => {
      const valid = group.observations.filter((obs) => typeof obs.value === 'number' && Number.isFinite(obs.value))
      const latest = valid.reduce((max, obs) => (obs.period > max ? obs.period : max), '')
      const preferredIndex = group.key === undefined ? -1 : preferredKeys.indexOf(group.key)
      return { group, valid: valid.length, latest, preferredIndex }
    })
    .filter((candidate) => candidate.valid > 0)
  ranked.sort((a, b) => {
    const byLatest = comparePeriod(b.latest, a.latest)
    if (byLatest !== 0) return byLatest
    if (a.valid !== b.valid) return b.valid - a.valid
    const aPref = a.preferredIndex < 0 ? Number.MAX_SAFE_INTEGER : a.preferredIndex
    const bPref = b.preferredIndex < 0 ? Number.MAX_SAFE_INTEGER : b.preferredIndex
    if (aPref !== bPref) return aPref - bPref
    return String(a.group.key ?? '').localeCompare(String(b.group.key ?? ''))
  })
  return ranked[0]?.group
}

// ---------------------------------------------------------------------------
// JSON-stat（Eurostat dissemination API v2.0）
// ---------------------------------------------------------------------------

interface JsonStatDimensionEntry {
  code: string
  index: number
  label?: string
}

function jsonStatEntries(dimension: unknown): JsonStatDimensionEntry[] {
  if (!isRecord(dimension)) return []
  const category = isRecord(dimension.category) ? dimension.category : {}
  const labels = isRecord(category.label) ? category.label : {}
  const rawIndex = category.index
  let entries: JsonStatDimensionEntry[] = []
  if (Array.isArray(rawIndex)) {
    entries = rawIndex.map((code, i) => ({ code: String(code), index: i, label: typeof labels[String(code)] === 'string' ? String(labels[String(code)]) : undefined }))
  } else if (isRecord(rawIndex)) {
    entries = Object.entries(rawIndex)
      .map(([code, index]) => ({ code, index: Number(index), label: typeof labels[code] === 'string' ? String(labels[code]) : undefined }))
      .filter((entry) => Number.isFinite(entry.index))
      .sort((a, b) => a.index - b.index)
  } else {
    // JSON-stat 允许省略 index（此时按 label 的书写顺序即类目顺序）。
    entries = Object.keys(labels).map((code, i) => ({ code, index: i, label: String(labels[code]) }))
  }
  return entries
}

export interface JsonStatParseOptions {
  frequency: GlobalMacroFrequency
  /** 作为序列分组键的维度（Eurostat 用 'geo'）；缺省时按全部非时间维度分组。 */
  seriesDimension?: string
  /** 时间维度 id，默认 'time'。 */
  timeDimension?: string
}

/**
 * 解析 JSON-stat 2.0（dataset class）为若干序列组。
 * 采用 JSON-stat 标准的扁平索引：最后一维变化最快。
 * 空值（缺失键）保留为 value:null，避免装配层误以为「有数据」。
 */
export function parseJsonStatDataset(json: unknown, options: JsonStatParseOptions): SeriesParseResult {
  const issues: string[] = []
  if (!isRecord(json)) return { groups: [], issues: ['JSON-stat 响应不是对象'] }
  const ids = Array.isArray(json.id) ? json.id.map(String) : []
  const sizes = Array.isArray(json.size) ? json.size.map((n) => Number(n)) : []
  const dimension = isRecord(json.dimension) ? json.dimension : {}
  const updated = typeof json.updated === 'string' ? json.updated : undefined
  if (!ids.length) return { groups: [], issues: ['JSON-stat 缺少 id 维度声明'] }
  if (ids.length !== sizes.length) issues.push(`JSON-stat 的 id/size 长度不一致（${ids.length}/${sizes.length}）`)
  if (!isRecord(json.value) && !Array.isArray(json.value)) issues.push('JSON-stat 缺少 value 映射（可能整批缺失）')

  const timeDimId = options.timeDimension ?? 'time'
  const timeIndex = ids.indexOf(timeDimId)
  if (timeIndex < 0) return { groups: [], issues: [...issues, `JSON-stat 缺少时间维度 ${timeDimId}`] }

  const entriesById: JsonStatDimensionEntry[][] = ids.map((id) => jsonStatEntries(dimension[id]))
  const dimSizes: number[] = []
  for (let i = 0; i < ids.length; i++) {
    const declared = Number.isFinite(sizes[i]) ? sizes[i]! : -1
    if (declared === 0) {
      issues.push(`维度 ${ids[i]} 的类目数为 0（筛选条件未命中或该口径无数据）`)
      return { groups: [], updated, issues }
    }
    const count = entriesById[i]!.length
    if (!count) issues.push(`维度 ${ids[i]} 没有类目`)
    dimSizes.push(declared > 0 && declared === count ? declared : count)
  }

  // 扁平索引步长：最后一维最快。
  const stride: number[] = new Array(ids.length).fill(1)
  for (let i = ids.length - 2; i >= 0; i--) stride[i] = stride[i + 1]! * (dimSizes[i + 1] ?? 0)

  const valueLookup = (flat: number): number | null => {
    // JSON-stat 允许稀疏对象（Eurostat）或完整数组两种 value 表示。
    if (Array.isArray(json.value)) return flat < json.value.length ? parseNumeric(json.value[flat]) : null
    if (!isRecord(json.value)) return null
    const key = String(flat)
    if (!(key in json.value)) return null
    return parseNumeric(json.value[key])
  }

  const seriesDimIndex = options.seriesDimension ? ids.indexOf(options.seriesDimension) : -1
  const otherDimIndexes = ids.map((_, i) => i).filter((i) => i !== timeIndex)
  const groups = new Map<string, ParsedSeriesGroup>()

  const touchGroup = (combination: number[]): ParsedSeriesGroup => {
    const dimensions: Record<string, string> = {}
    for (const dimIndex of otherDimIndexes) {
      const entry = entriesById[dimIndex]![combination[dimIndex]!]
      if (entry) dimensions[ids[dimIndex]!] = entry.code
    }
    let key: string
    if (seriesDimIndex >= 0) {
      key = dimensions[ids[seriesDimIndex]!] ?? ''
    } else {
      key = otherDimIndexes.map((dimIndex) => `${ids[dimIndex]}=${dimensions[ids[dimIndex]!] ?? ''}`).join('|')
    }
    const label = seriesDimIndex >= 0
      ? entriesById[seriesDimIndex]![combination[seriesDimIndex]!]?.label
      : undefined
    const existing = groups.get(key)
    if (existing) return existing
    const created: ParsedSeriesGroup = { key, dimensions, ...(label ? { label } : {}), observations: [] }
    groups.set(key, created)
    return created
  }

  // 遍历所有非时间维度的组合 → 每个组合一条时间序列。
  const combination: number[] = new Array(ids.length).fill(0)
  const emit = (): void => {
    let base = 0
    for (const idx of otherDimIndexes) base += combination[idx]! * stride[idx]!
    const group = touchGroup(combination)
    for (let t = 0; t < entriesById[timeIndex]!.length; t++) {
      const timeEntry = entriesById[timeIndex]![t]!
      group.observations.push({ period: timeEntry.code, value: valueLookup(base + t * stride[timeIndex]!) })
    }
  }
  const walk = (position: number): void => {
    if (position >= otherDimIndexes.length) {
      emit()
      return
    }
    const dimIndex = otherDimIndexes[position]!
    for (let i = 0; i < dimSizes[dimIndex]!; i++) {
      combination[dimIndex] = i
      walk(position + 1)
    }
    combination[dimIndex] = 0
  }
  if (otherDimIndexes.length === 0) emit()
  else walk(0)

  if (!groups.size) issues.push('JSON-stat 没有可枚举的类目组合')
  return { groups: [...groups.values()], updated, issues }
}

// ---------------------------------------------------------------------------
// SDMX-JSON（ECB data-api 1.0 / OECD 2.0 的容忍解析）
// ---------------------------------------------------------------------------

interface SdmxDimensionValues {
  id: string
  role?: string
  values: Array<{ id: string; name?: string }>
}

function sdmxDimensions(list: unknown): SdmxDimensionValues[] {
  if (!Array.isArray(list)) return []
  return list.map((raw, i) => {
    const dim = isRecord(raw) ? raw : {}
    const values = Array.isArray(dim.values)
      ? dim.values.map((value) => {
        const item = isRecord(value) ? value : {}
        return { id: String(item.id ?? ''), ...(typeof item.name === 'string' ? { name: item.name } : {}) }
      })
      : []
    return {
      id: typeof dim.id === 'string' ? dim.id : `dim_${i}`,
      ...(typeof dim.role === 'string' ? { role: dim.role } : {}),
      values,
    }
  })
}

interface SdmxDecodedSeries {
  dimensions: Record<string, string>
  label?: string
  observations: RawObservation[]
}

function sdmxSeriesKeyParts(key: string): number[] {
  return key.split(':').map((part) => Number(part))
}

/**
 * 容忍解析 SDMX-JSON：
 * - ECB data-api 1.0：{ header, dataSets:[{series:{key:{observations:{obsIndex:[value,...]}}}}], structure:{dimensions} }
 * - OECD 2.0：{ meta, data:{ structure:{dimensions}, dataSets:[...] } }
 * 观测数组的第 0 位是数值（其余是属性索引）；缺失观测键 = null，不当作 0。
 */
export function parseSdmxJsonDataset(json: unknown, options: { frequency: GlobalMacroFrequency }): SeriesParseResult {
  const issues: string[] = []
  if (!isRecord(json)) return { groups: [], issues: ['SDMX-JSON 响应不是对象'] }
  const root = isRecord(json.data) ? json.data : json
  const payload = root
  const structure = isRecord(payload.structure)
    ? payload.structure
    : Array.isArray(payload.structures) && isRecord(payload.structures[0])
      ? payload.structures[0]
      : undefined
  // ECB 的 header 在顶层；OECD 2.0 的 meta 在顶层；两者都可能带 prepared/updated。
  const header = isRecord(json.header) ? json.header : isRecord(json.meta) ? json.meta : isRecord(root.header) ? root.header : undefined
  const updated = header && typeof header.prepared === 'string' ? header.prepared : undefined
  const dimensions = structure && isRecord(structure.dimensions) ? structure.dimensions : undefined
  const datasets = Array.isArray(root.dataSets) ? root.dataSets : []
  if (!dimensions) return { groups: [], updated, issues: ['SDMX-JSON 缺少 structure.dimensions'] }
  if (!datasets.length) return { groups: [], updated, issues: ['SDMX-JSON 缺少 dataSets'] }

  const seriesDims = sdmxDimensions(dimensions.series)
  const obsDims = sdmxDimensions(dimensions.observation)
  if (!obsDims.length) return { groups: [], updated, issues: ['SDMX-JSON 缺少 observation 维度'] }
  const timeDim = obsDims.find((dim) => dim.role === 'time')
    ?? obsDims.find((dim) => /time|period/i.test(dim.id))
    ?? obsDims[obsDims.length - 1]!
  const timePosition = obsDims.indexOf(timeDim)

  const decodeObsIndex = (flat: number): number[] | undefined => {
    if (timePosition < 0) return undefined
    const indices: number[] = new Array(obsDims.length).fill(0)
    let remainder = flat
    for (let i = obsDims.length - 1; i >= 0; i--) {
      const size = obsDims[i]!.values.length
      if (size <= 0) return undefined
      indices[i] = remainder % size
      remainder = Math.floor(remainder / size)
    }
    if (remainder !== 0) return undefined
    return indices
  }

  const groups = new Map<string, SdmxDecodedSeries>()
  const pushGroup = (dimensionsMap: Record<string, string>, label: string | undefined): SdmxDecodedSeries => {
    const key = Object.entries(dimensionsMap).map(([name, code]) => `${name}=${code}`).join('|') || 'series'
    const existing = groups.get(key)
    if (existing) return existing
    const created: SdmxDecodedSeries = { dimensions: dimensionsMap, ...(label ? { label } : {}), observations: [] }
    groups.set(key, created)
    return created
  }

  for (const rawDataset of datasets) {
    const dataset = isRecord(rawDataset) ? rawDataset : {}

    if (isRecord(dataset.series)) {
      for (const [seriesKey, rawSeries] of Object.entries(dataset.series)) {
        const series = isRecord(rawSeries) ? rawSeries : {}
        const dimensionsMap: Record<string, string> = {}
        const keyParts = sdmxSeriesKeyParts(seriesKey)
        let label: string | undefined
        seriesDims.forEach((dim, i) => {
          const value = dim.values[keyParts[i] ?? -1]
          if (value) {
            dimensionsMap[dim.id] = value.id
            label ??= value.name
          }
        })
        const target = pushGroup(dimensionsMap, label)
        if (!isRecord(series.observations)) {
          issues.push(`SDMX 序列 ${seriesKey} 缺少 observations`)
          continue
        }
        for (const [obsKey, rawObs] of Object.entries(series.observations)) {
          const flat = Number(obsKey)
          if (!Number.isFinite(flat)) continue
          const indices = decodeObsIndex(flat)
          if (!indices) {
            issues.push(`SDMX 观测索引越界：${obsKey}`)
            continue
          }
          const timeValue = timeDim.values[indices[timePosition]!]
          if (!timeValue) continue
          const value = Array.isArray(rawObs) ? parseNumeric(rawObs[0]) : parseNumeric(rawObs)
          target.observations.push({ period: timeValue.id, value })
        }
      }
      continue
    }

    if (isRecord(dataset.observations)) {
      // 数据集级扁平观测（dimensionAtObservation=AllDimensions）：observation 维度包含全部维度。
      for (const [obsKey, rawObs] of Object.entries(dataset.observations)) {
        const flat = Number(obsKey)
        if (!Number.isFinite(flat)) continue
        const indices = decodeObsIndex(flat)
        if (!indices) continue
        const dimensionsMap: Record<string, string> = {}
        obsDims.forEach((dim, i) => {
          if (dim === timeDim) return
          const value = dim.values[indices[i]!]
          if (value) dimensionsMap[dim.id] = value.id
        })
        const timeValue = timeDim.values[indices[timePosition]!]
        if (!timeValue) continue
        const value = Array.isArray(rawObs) ? parseNumeric(rawObs[0]) : parseNumeric(rawObs)
        pushGroup(dimensionsMap, undefined).observations.push({ period: timeValue.id, value })
      }
      continue
    }

    issues.push('SDMX 数据集既没有 series 也没有 observations')
  }

  const decoded = [...groups.values()].filter((group) => group.observations.length > 0)
  if (!decoded.length) issues.push('SDMX-JSON 没有解析到任何观测')
  return {
    groups: decoded.map((group) => ({
      key: Object.values(group.dimensions).join(':'),
      dimensions: group.dimensions,
      ...(group.label ? { label: group.label } : {}),
      observations: group.observations,
    })),
    updated,
    issues,
  }
}

// ---------------------------------------------------------------------------
// SDMX-ML GenericData XML（OECD 实际可用的表示）
// ---------------------------------------------------------------------------

function stripSdmxPrefix(xml: string): string {
  // 只把 SDMX/XML 的命名空间前缀去掉，保留标签名本身，避免为每个前缀写两套正则。
  return xml.replace(/<\/?(?:message|generic|common|structure):/g, (match) => (match.startsWith('</') ? '</' : '<'))
}

/**
 * 解析 SDMX-ML 2.1 GenericData（OECD sdmx.oecd.org 在该主机上 JSON 表示返回 HTTP 500 时的回退表示）。
 * 结构：<generic:Series><generic:SeriesKey><generic:Value id="TIME_PERIOD"? .../></SeriesKey>
 *       <generic:Obs><generic:ObsDimension id="TIME_PERIOD" value="2025-01"/><generic:ObsValue value="3.0"/></Obs>
 * 注意：源返回的 Obs 顺序不保证，装配层会统一排序。
 */
export function parseSdmxGenericXml(xml: string, options: { frequency: GlobalMacroFrequency }): SeriesParseResult {
  const issues: string[] = []
  if (typeof xml !== 'string' || !xml.trim()) return { groups: [], issues: ['SDMX XML 响应为空'] }
  const text = stripSdmxPrefix(xml)
  const prepared = /<Prepared>([^<]+)<\/Prepared>/.exec(text)?.[1]?.trim()
  const seriesBlocks = [...text.matchAll(/<Series>([\s\S]*?)<\/Series>/g)].map((match) => match[1] ?? '')
  if (!seriesBlocks.length) return { groups: [], updated: prepared, issues: ['SDMX XML 里没有 Series 节点'] }

  const groups = new Map<string, ParsedSeriesGroup>()
  for (const block of seriesBlocks) {
    const obsStart = block.indexOf('<Obs')
    const seriesKeyBlock = /<SeriesKey>([\s\S]*?)<\/SeriesKey>/.exec(block)?.[1]
    const keyPart = seriesKeyBlock ?? (obsStart >= 0 ? block.slice(0, obsStart) : block)
    const keyValues: Record<string, string> = {}
    for (const match of keyPart.matchAll(/<Value\s+id="([^"]+)"\s+value="([^"]*)"/g)) {
      if (match[1] && match[2] !== undefined) keyValues[match[1]] = match[2]
    }
    const key = Object.entries(keyValues).map(([id, value]) => `${id}=${value}`).join('|')
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        dimensions: { ...keyValues },
        observations: [],
      }
      groups.set(key, group)
    }
    const obsBlocks = [...block.matchAll(/<Obs>([\s\S]*?)<\/Obs>/g)].map((match) => match[1] ?? '')
    if (!obsBlocks.length) {
      issues.push('SDMX XML 序列没有 Obs 节点')
      continue
    }
    for (const obsBlock of obsBlocks) {
      const period = /<ObsDimension[^>]*\bvalue="([^"]*)"/.exec(obsBlock)?.[1]
      const valueText = /<ObsValue[^>]*\bvalue="([^"]*)"/.exec(obsBlock)?.[1]
      if (!period) {
        issues.push('SDMX XML 观测缺少 ObsDimension')
        continue
      }
      const status = /<Value\s+id="OBS_STATUS"\s+value="([^"]*)"/.exec(obsBlock)?.[1]
      group.observations.push({
        period,
        value: parseNumeric(valueText),
        ...(status ? { status } : {}),
      })
    }
  }
  if (!groups.size) issues.push('SDMX XML 没有可用的序列')
  return { groups: [...groups.values()], updated: prepared, issues }
}

// ---------------------------------------------------------------------------
// World Bank Indicators API
// ---------------------------------------------------------------------------

export interface WorldBankParseResult extends SeriesParseResult {
  countryIso3?: string
  indicatorId?: string
  totalPages?: number
  totalObservations?: number
}

/**
 * 解析 World Bank `country/indicator` 响应：[meta, [{date,value,countryiso3code,indicator:{id}}...]]。
 * 年度统计期只接受 4 位年份；value 为 null 的年份保留为缺失，不填 0。
 */
export function parseWorldBankIndicator(json: unknown): WorldBankParseResult {
  const issues: string[] = []
  if (!Array.isArray(json) || json.length < 2) return { groups: [], issues: ['World Bank 响应不是 [meta, rows] 数组'] }
  const meta = isRecord(json[0]) ? json[0] : {}
  const rows = Array.isArray(json[1]) ? json[1] : []
  const observations: RawObservation[] = []
  let countryIso3: string | undefined
  let indicatorId: string | undefined
  for (const raw of rows) {
    if (!isRecord(raw)) continue
    const indicator = isRecord(raw.indicator) ? raw.indicator : undefined
    countryIso3 ??= typeof raw.countryiso3code === 'string' ? raw.countryiso3code : undefined
    indicatorId ??= indicator && typeof indicator.id === 'string' ? indicator.id : undefined
    const period = typeof raw.date === 'string' ? raw.date : ''
    if (!period) {
      issues.push('World Bank 行缺少 date')
      continue
    }
    observations.push({ period, value: parseNumeric(raw.value) })
  }
  if (!observations.length) issues.push('World Bank 返回 0 行观测')
  const updated = typeof meta.lastupdated === 'string' ? meta.lastupdated : undefined
  return {
    groups: [{
      key: [countryIso3, indicatorId].filter(Boolean).join(':') || 'worldbank',
      dimensions: {
        ...(countryIso3 ? { country: countryIso3 } : {}),
        ...(indicatorId ? { indicator: indicatorId } : {}),
      },
      observations,
    }],
    updated,
    issues,
    ...(countryIso3 ? { countryIso3 } : {}),
    ...(indicatorId ? { indicatorId } : {}),
    ...(Number.isFinite(Number(meta.pages)) ? { totalPages: Number(meta.pages) } : {}),
    ...(Number.isFinite(Number(meta.total)) ? { totalObservations: Number(meta.total) } : {}),
  }
}

// ---------------------------------------------------------------------------
// 装配：原始观测 → 统一序列结果（排序/去重/空值诊断/asOf）
// ---------------------------------------------------------------------------

export interface AssembleGlobalMacroSeriesInput {
  series: GlobalMacroSeriesKey
  observations: RawObservation[]
  representation: GlobalMacroRepresentation | null
  fetchedAt: string
  provenance: Partial<Omit<GlobalMacroProvenance, 'pointsReturned' | 'pointsAvailable' | 'truncated' | 'cached'>> & {
    provider: GlobalMacroProviderId
    endpoint: string
  }
  extraNotes?: string[]
  limit?: number
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || limit === null) return fallback
  return clampGlobalMacroLimit(limit)
}

/**
 * 装配一条序列：规范化统计期 → 去重（同期后者覆盖）→ 升序 → 丢弃空值/非法期 → 截断。
 * 没有任何有效值时返回 points:[] + latest:null + asOf:null + error（绝不拿 fetchedAt 顶 asOf）。
 */
export function assembleGlobalMacroSeries(input: AssembleGlobalMacroSeriesInput): GlobalMacroSeries {
  const meta = GLOBAL_MACRO_SERIES_META[input.series]
  const limit = clampLimit(input.limit, meta.defaultPoints)
  const notes = [...meta.notes, ...(input.extraNotes ?? [])]
  let invalidPeriods = 0
  let missingValues = 0
  let droppedDuplicates = 0
  const byPeriod = new Map<string, number | null>()

  for (const observation of input.observations) {
    const period = normalizePeriod(observation.period, meta.frequency)
    if (!period) {
      invalidPeriods += 1
      continue
    }
    const value = observation.value === null || observation.value === undefined ? null : parseNumeric(observation.value)
    if (value === null) missingValues += 1
    if (byPeriod.has(period)) droppedDuplicates += 1
    byPeriod.set(period, value)
  }

  const sorted = [...byPeriod.entries()].sort((a, b) => comparePeriod(a[0], b[0]))
  const valid = sorted.filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
  const sourceFirstPeriod = sorted[0]?.[0] ?? null
  const sourceLastPeriod = sorted[sorted.length - 1]?.[0] ?? null
  const latestValidPeriod = valid[valid.length - 1]?.[0] ?? null
  const points: GlobalMacroPoint[] = valid
    .slice(-limit)
    .map(([period, value]) => ({ period, value: roundValue(value, 2) }))
  const latest = points[points.length - 1] ?? null

  if (sourceLastPeriod && latestValidPeriod && sourceLastPeriod !== latestValidPeriod) {
    notes.push(`源数据最后统计期 ${sourceLastPeriod} 无数值（缺失或未发布），最新有效统计期 ${latestValidPeriod}`)
  }
  if (invalidPeriods > 0) notes.push(`忽略 ${invalidPeriods} 条无法识别的时间值`)
  if (missingValues > 0) notes.push(`跳过 ${missingValues} 条空值（不补 0）`)
  if (droppedDuplicates > 0) notes.push(`同期重复观测 ${droppedDuplicates} 条，保留最后一条`)
  if (valid.length > points.length) notes.push(`只返回最近 ${points.length} 期（源内有效观测 ${valid.length} 期）`)

  const provenance: GlobalMacroProvenance = {
    provider: input.provenance.provider,
    endpoint: input.provenance.endpoint,
    dataset: input.provenance.dataset ?? meta.dataset,
    indicator: input.provenance.indicator ?? meta.indicator,
    geography: input.provenance.geography ?? meta.geography,
    frequency: input.provenance.frequency ?? meta.frequency,
    representation: input.representation,
    statisticsTimeField: input.provenance.statisticsTimeField ?? 'TIME_PERIOD',
    ...(input.provenance.upstreamTimestamp ? { upstreamTimestamp: input.provenance.upstreamTimestamp } : {}),
    ...(input.provenance.seriesKey ? { seriesKey: input.provenance.seriesKey } : {}),
    cached: false,
    pointsReturned: points.length,
    pointsAvailable: valid.length,
    truncated: valid.length > points.length,
    valueRounding: 2,
    missingValues,
    invalidPeriods,
    droppedDuplicates,
    coverage: { sourceFirstPeriod, sourceLastPeriod, latestValidPeriod },
  }

  const result: GlobalMacroSeries = {
    series: input.series,
    label: meta.label,
    source: meta.source,
    unit: meta.unit,
    asOf: latest?.period ?? null,
    fetchedAt: input.fetchedAt,
    points,
    latest,
    provenance,
    notes,
  }

  if (!latest) {
    const details = [
      `${input.observations.length} 条原始观测`,
      `${missingValues} 条空值`,
      `${invalidPeriods} 条非法时间`,
      input.representation ? `表示=${input.representation}` : '表示未知',
    ].join('，')
    return {
      ...result,
      error: `未获得有效观测值（${details}）；不做零值/估算填充`,
      notes: [...notes, '空结果按失败返回，asOf 与 latest 均为 null。'],
    }
  }
  return result
}

/** 失败结果：与成功结果同构，但 points 为空、asOf/latest 为 null、error 说明原因。 */
export function globalMacroFailure(series: GlobalMacroSeriesKey, error: string, fetchedAt: string): GlobalMacroSeries {
  const meta = GLOBAL_MACRO_SERIES_META[series]
  return {
    series,
    label: meta.label,
    source: meta.source,
    unit: meta.unit,
    asOf: null,
    fetchedAt,
    points: [],
    latest: null,
    provenance: {
      provider: meta.provider,
      endpoint: '',
      dataset: meta.dataset,
      indicator: meta.indicator,
      geography: meta.geography,
      frequency: meta.frequency,
      representation: null,
      statisticsTimeField: 'TIME_PERIOD',
      cached: false,
      pointsReturned: 0,
      pointsAvailable: 0,
      truncated: false,
      valueRounding: 2,
      missingValues: 0,
      invalidPeriods: 0,
      droppedDuplicates: 0,
      coverage: { sourceFirstPeriod: null, sourceLastPeriod: null, latestValidPeriod: null },
    },
    notes: [...meta.notes, '抓取/解析失败；不使用占位值、不补 0。'],
    error,
  }
}

/** 二次截断（缓存里存的是最多 120 期，调用方可要更少）并标注缓存命中。 */
export function applyGlobalMacroPointLimit(series: GlobalMacroSeries, limit: number, cached = false): GlobalMacroSeries {
  const meta = GLOBAL_MACRO_SERIES_META[series.series]
  const capped = clampLimit(limit, meta.defaultPoints)
  const points = series.points.slice(-capped)
  const notes = [...series.notes]
  if (series.points.length > capped) {
    notes.push(`按请求只返回最近 ${capped} 期（可用 ${series.provenance.pointsAvailable} 期）`)
  }
  if (cached && !notes.some((note) => note.includes('缓存'))) {
    notes.push('结果来自本进程缓存；fetchedAt 为首次抓取时间')
  }
  return {
    ...series,
    points,
    latest: points[points.length - 1] ?? null,
    provenance: {
      ...series.provenance,
      cached: cached || series.provenance.cached,
      pointsReturned: points.length,
      truncated: series.provenance.truncated || series.points.length > capped,
    },
    notes,
  }
}

/** 解析请求里的 series 列表：缺省=全部；未知名字保留在 unknown 里（调用方必须显式报错）。 */
export function normalizeSeriesRequest(input?: string[] | string): {
  keys: GlobalMacroSeriesKey[]
  unknown: string[]
} {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，\s]+/)
      : []
  const requested = raw.map((item) => String(item).trim()).filter(Boolean)
  if (!requested.length) return { keys: [...GLOBAL_MACRO_SERIES_KEYS], unknown: [] }
  const keys: GlobalMacroSeriesKey[] = []
  const unknown: string[] = []
  for (const name of requested) {
    if ((GLOBAL_MACRO_SERIES_KEYS as readonly string[]).includes(name)) {
      const key = name as GlobalMacroSeriesKey
      if (!keys.includes(key)) keys.push(key)
    } else if (!unknown.includes(name)) {
      unknown.push(name)
    }
  }
  return { keys, unknown }
}

/** 汇总报告：ok=全部成功；partial=部分成功；未知 series 也进 errors。 */
export function buildGlobalMacroReport(
  series: GlobalMacroSeries[],
  request: { keys: GlobalMacroSeriesKey[]; unknown: string[] },
  fetchedAt: string,
): GlobalMacroReport {
  const errors: Array<{ series: string; error: string }> = series
    .filter((item) => Boolean(item.error))
    .map((item) => ({ series: item.series, error: item.error! }))
  for (const name of request.unknown) {
    errors.push({ series: name, error: `未知的宏观序列：${name}（可选：${GLOBAL_MACRO_SERIES_KEYS.join('/')}）` })
  }
  const failed = errors.length
  return {
    ok: failed === 0,
    partial: failed > 0 && series.length > errors.filter((item) => (GLOBAL_MACRO_SERIES_KEYS as readonly string[]).includes(item.series)).length,
    fetchedAt,
    requested: request.keys,
    series,
    errors,
    notes: [
      'asOf 是最新统计期（源侧统计口径），fetchedAt 才是抓取时间，两者不同。',
      'points/latest 的数值四舍五入到 2 位小数；空值与失败序列保留 error，不补 0。',
      '所有序列来自官方统计源的结构化接口（OECD SDMX / Eurostat / World Bank / ECB data-api），不是网页摘要。',
    ],
  }
}
