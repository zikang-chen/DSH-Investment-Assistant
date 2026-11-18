import type { AssetType } from '../types.js'

export interface SecurityIdentity { code: string; name?: string; type: AssetType; /** 海外标的的东财 secid（如 176.7203）；有它才能按真实市场取行情/K线 */ secid?: string; /** 原始市场标签（日股/英股/美股…），用于判断走国内档案还是海外行情 */ market?: string }
export interface SecurityMatch { code: string; name: string; market: string; type?: string; secid?: string }
export const SECURITY_OPEN_EVENT = 'dsh-finance:security-open'

/** Markets already covered by the domestic A/H/US dossier pipeline. */
const COVERED_MARKETS = /^(沪市|深市|京市|北交所|A股|港股|美股|基金|ETF|LOF)$/i

/** Overseas individual securities outside the A/H/US pipeline render the global quote/K-line view. */
export function isGlobalSecurity(item: SecurityIdentity | null | undefined): boolean {
  if (!item || item.type === 'fund') return false
  if (!item.secid) return false
  const market = (item.market ?? '').trim()
  if (!market) return false
  return !COVERED_MARKETS.test(market)
}

/** Never infer a fund from a six-digit code: A-shares and funds can share codes. */
export function identityFromMatch(match: SecurityMatch): SecurityIdentity | null {
  const label = `${match.market} ${match.type ?? ''}`
  if (/指数|index|期货|futures|债券|bond|板块|sector/i.test(label) && !/基金|ETF|LOF|fund/i.test(label)) return null
  if (!match.code.trim()) return null
  const type: AssetType = /基金|ETF|LOF|fund/i.test(label) ? 'fund' : 'stock'
  const identity: SecurityIdentity = { code: match.code.trim(), name: match.name, type }
  if (match.secid) identity.secid = match.secid
  if (match.market) identity.market = match.market
  return identity
}
export function securityKey(item: SecurityIdentity): string { return `${item.type}:${item.code}` }
export function uniqueMatches(matches: SecurityMatch[]): SecurityMatch[] {
  const seen = new Set<string>()
  return matches.filter(match => {
    if (!match || typeof match.code !== 'string' || typeof match.name !== 'string' || !match.code.trim()) return false
    const key = `${match.market}|${match.type ?? ''}|${match.code}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
export function requestSecurityOpen(item: SecurityIdentity): void {
  if (!item.code.trim() || !['stock', 'fund'].includes(item.type)) return
  window.dispatchEvent(new CustomEvent(SECURITY_OPEN_EVENT, { detail: { ...item, code: item.code.trim() } }))
}

export interface SecuritySection {
  key: string; label: string; group: string; ok: boolean; status?: 'ready' | 'empty' | 'unsupported' | 'error'
  provider?: string; rows: number; data?: unknown; error?: string; dataAsOf?: string; missing?: string[]; ms: number
}
export interface SecurityDossier { ok: boolean; code: string; at: string; snapshotId?: string; ready: number; total: number; elapsedMs: number; sections: SecuritySection[]; summary?: string }
const text = (value: unknown): string => value === undefined || value === null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const ROW_ARRAY_KEYS = ['rows', 'data', 'items', 'records'] as const
const isRowArrayKey = (key: string): boolean => (ROW_ARRAY_KEYS as readonly string[]).includes(key)
function rowRecord(row: unknown): Record<string, string> {
  return row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_section').map(([key, value]) => [key, text(value)]))
    : { 值: text(row) }
}
/** Metadata such as meta.unit becomes a column on every expanded row; row values win name collisions. */
function contextColumns(entries: Array<[string, unknown]>): Record<string, string> {
  const columns: Record<string, string> = {}
  const put = (key: string, value: unknown) => { if (!(key in columns)) columns[key] = text(value) }
  for (const [key, value] of entries) {
    if (key === 'meta' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [unitKey, unitValue] of Object.entries(value)) put(unitKey, unitValue)
    } else put(key, value)
  }
  return columns
}
/**
 * Preserve upstream units and field names. This is display normalization, not a finance calculation.
 * F10 payloads can be nested (`{rows:[...], meta:{unit}}`): expand rows/data/items/records arrays and
 * carry remaining fields (meta/unit/currency/asOf…) as extra columns instead of one giant JSON cell.
 * Numbers/null are kept exactly as upstream: 0 stays "0", null stays missing "—" (never filled with 0).
 */
export function dossierRows(data: unknown): Array<Record<string, string>> {
  if (Array.isArray(data)) return data.map(rowRecord)
  if (data && typeof data === 'object') {
    const entries = Object.entries(data)
    const expanded: unknown[] = []
    let hasRowArray = false
    for (const [key, value] of entries) {
      if (!isRowArrayKey(key) || !Array.isArray(value)) continue
      hasRowArray = true
      expanded.push(...value)
    }
    if (!hasRowArray) return entries.map(([key, value]) => ({ 字段: key, 值: text(value) }))
    const context = contextColumns(entries.filter(([key]) => !isRowArrayKey(key) && key !== '_section'))
    const rows = expanded.map(row => ({ ...context, ...rowRecord(row) }))
    if (rows.length) return rows
    // Empty nested array: keep metadata visible as its own row instead of dropping it silently.
    return Object.keys(context).length ? [context] : []
  }
  return data === undefined || data === null ? [] : [{ 值: text(data) }]
}
/** Known source keys only: unknown keys stay visible verbatim, never guessed or discarded. */
const COMPANY_FIELD_LABELS: Record<string, string> = {
  name: '证券简称', securitynameabbr: '证券简称', securityname: '证券名称', stockname: '股票名称',
  orgname: '公司名称', orgshortname: '公司简称', companyname: '公司名称',
  code: '证券代码', securitycode: '证券代码', secucode: '证券代码（含市场）',
  industry: '所属行业', industrycsrc1: '所属行业', csrcindustry: '所属行业',
  region: '所在地区', province: '所在省份', address: '地址',
  listingdate: '上市日期', listeddate: '上市日期', mainbusiness: '主营业务',
  businessscope: '经营范围', orgprofile: '公司简介', companyprofile: '公司简介', profile: '公司简介',
  website: '公司网站', orgweb: '公司网站',
  meta: '来源与口径', metadata: '来源与口径', provider: '数据提供方', source: '来源',
  endpointref: '原始接口', sourceurl: '来源链接', retrievedat: '抓取时间（非数据时点）',
  fetchedat: '抓取时间（非数据时点）', contractverified: '上游契约已核验',
  reportperiod: '报告期', publishedat: '公告时间', asof: '数据时点',
  unit: '单位', currency: '币种', missing: '缺失字段', warnings: '提示',
  rows: '记录', data: '数据', items: '条目', records: '记录', result: '返回结果',
  jbzl: '基本资料', jygk: '经营概况', gsgk: '公司概况',
}
const companyKey = (key: string): string => key.trim().replace(/[\s_-]+/g, '').toLowerCase()
const companyLabel = (key: string): string => Object.hasOwn(COMPANY_FIELD_LABELS, companyKey(key)) ? COMPANY_FIELD_LABELS[companyKey(key)]! : key
const COMPANY_META_KEYS = new Set(['meta', 'metadata', 'provider', 'source', 'endpointref', 'sourceurl', 'retrievedat', 'fetchedat', 'contractverified', 'reportperiod', 'publishedat', 'asof', 'unit', 'currency', 'missing', 'warnings'])
export interface CompanyOverviewField { key: string; label: string; value: string; metadata: boolean }
/**
 * A lossless display projection, not a provider repair: keep every leaf, row index and wrapper path.
 * Never merge multiple company records, infer units, or promote fetchedAt to the data date.
 */
export function companyOverviewFields(data: unknown): CompanyOverviewField[] {
  const fields: CompanyOverviewField[] = []
  const ancestors = new Set<object>()
  const walk = (value: unknown, path: string[], labels: string[], metadata: boolean): void => {
    const emit = (raw: unknown) => fields.push({ key: JSON.stringify(path), label: labels.join(' / ') || '值', value: text(raw), metadata })
    if (value === null || typeof value !== 'object') { emit(value); return }
    if (ancestors.has(value)) { emit('（循环引用，无法展开）'); return }
    ancestors.add(value)
    if (Array.isArray(value)) {
      if (!value.length) emit('[]')
      value.forEach((item, index) => walk(item, [...path, String(index)], [...labels, `第 ${index + 1} 项`], metadata))
    } else {
      const entries = Object.entries(value)
      // Legacy field/value rows are already named fields. Keep their extra metadata/siblings, too.
      const fieldEntry = entries.find(([key, raw]) => ['字段', '项目', 'field'].includes(key) && typeof raw === 'string')
      const valueEntry = entries.find(([key]) => ['值', '内容', 'value'].includes(key))
      if (fieldEntry && valueEntry) {
        const field = String(fieldEntry[1])
        walk(valueEntry[1], [...path, valueEntry[0]], [...labels, companyLabel(field)], metadata || COMPANY_META_KEYS.has(companyKey(field)))
      }
      for (const [key, raw] of entries) {
        if (fieldEntry && valueEntry && (key === fieldEntry[0] || key === valueEntry[0])) continue
        walk(raw, [...path, key], [...labels, companyLabel(key)], metadata || COMPANY_META_KEYS.has(companyKey(key)))
      }
      if (!entries.length) emit('{}')
    }
    ancestors.delete(value)
  }
  if (data !== undefined && data !== null) walk(data, [], [], false)
  return fields
}
export function dossierName(data: SecurityDossier, fallback?: string): string {
  for (const section of data.sections) {
    if (!['overview', 'company_survey'].includes(section.key)) continue
    const fields = companyOverviewFields(section.data)
    const name = fields.find(field => !field.metadata && /^(基金名称|证券简称|公司名称|股票名称|公司简称)$/.test(field.label.split(' / ').at(-1) ?? '') && field.value !== '—')?.value
    if (name) return name
  }
  return fallback || data.code
}
const normalField = (key: string): string => key.trim().replace(/[\s_-]+/g, '').toLowerCase()
const CODE_FIELDS = ['code', 'stockcode', 'securitycode', '股票代码', '证券代码', '代码']
const NAME_FIELDS = ['name', 'stockname', 'securityname', 'securitynameabbr', '股票名称', '证券名称', '名称']
function fieldValue(row: Record<string, string>, fields: string[]): string | undefined {
  for (const [key, raw] of Object.entries(row)) {
    if (!fields.includes(normalField(key))) continue
    const value = String(raw ?? '').trim()
    if (value && value !== '—') return value
  }
  return undefined
}
/**
 * Only explicit constituent-stock columns create links; no guessing numbers inside narrative.
 * Accepts Chinese legacy columns plus normalized code/name/stockCode/securityCode camel/snake variants.
 */
export function stockIdentityFromRow(row: Record<string, string>, sectionKey: string): SecurityIdentity | null {
  if (!['holdings', 'peer_comparison', 'rows'].includes(sectionKey)) return null
  const code = fieldValue(row, CODE_FIELDS)
  if (!code || !/^(\d{5,6}|[A-Z][A-Z0-9.-]{0,14})$/.test(code)) return null
  return { code, name: fieldValue(row, NAME_FIELDS), type: 'stock' }
}
