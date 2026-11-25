/**
 * Limited, real public sources for state-capital research. No storage / portfolio access.
 * Live contract verified 2026-11-25: Huijin two official pages; Eastmoney
 * RPT_F10_EH_HOLDERS (END_DATE, HOLDER_NAME, HOLD_NUM, HOLD_NUM_RATIO, etc.).
 * The aggregate response does NOT supply a verified announcement date or official filing.
 * Fixed URLs only, no redirects/retries, <=5 explicitly supplied A-share codes per call.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_UA } from './http.js'
import { resolveStateCapitalEntity, type StateCapitalDisclosure, type StateCapitalHolding, type StateCapitalSource } from '../state-capital.js'

export const HUIJIN_OVERVIEW_URL = 'https://www.huijin-inv.cn/huijin-inv/Investments/Overview.shtml'
export const HUIJIN_SHAREHOLDING_URL = 'https://www.huijin-inv.cn/huijin-inv/Investments/Shareholding.shtml'
export const STATE_CAPITAL_EM_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
export const STATE_CAPITAL_EM_REPORT = 'RPT_F10_EH_HOLDERS'
export const STATE_CAPITAL_MAX_CODES = 5
export const STATE_CAPITAL_MAX_BYTES = 1_000_000

export interface StateCapitalFetchOptions {
  codes?: string[]
  signal?: AbortSignal
  /** Offline tests only need to inject the standard fetch interface. No arbitrary URLs. */
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
  capturedAt?: string
}
const hashText = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
function plain(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()
}
function validDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|\b)/.exec(value.trim())
  if (!m) return null
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null
}
function source(url: string, title: string, text: string, level: StateCapitalSource['level'], asOf: string | null = null): StateCapitalSource {
  return { url, title, hash: hashText(text), level, publishedAt: null, asOf }
}
function finiteNumber(v: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number | null {
  if (v === null || v === undefined || v === '' || v === '--' || v === '-') return null
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v))) throw new Error(`${label}不是有效数值`)
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}超出有效非负范围`)
  return n
}
export function parseStateCapitalQuantity(raw: string): { quantity: number; unit: StateCapitalHolding['unit']; precision: number } {
  const m = /^(\d+(?:\.\d+)?)\s*(亿|万)?\s*(股|份|元)$/.exec(raw.trim())
  if (!m) throw new Error(`持股/出资额单位不明：${raw}`)
  const multiplier = m[2] === '亿' ? 100_000_000 : m[2] === '万' ? 10_000 : 1
  const decimals = m[1]!.split('.')[1]?.length ?? 0
  const precision = multiplier / 10 ** decimals
  const quantity = Number(m[1]) * multiplier
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number.MAX_SAFE_INTEGER) throw new Error('持股/出资额超出安全数值范围')
  return { quantity: precision >= 1 ? Math.round(quantity) : quantity, unit: m[3] as StateCapitalHolding['unit'], precision }
}

/** Parse the two official pages independently; never borrow Overview's date for Detail rows. */
export function parseHuijinOfficialPages(overviewHtml: string, shareholdingHtml: string, capturedAt = new Date().toISOString()): StateCapitalDisclosure {
  const overview = plain(overviewHtml)
  const intro = /截至\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*[，,]\s*中央汇金公司直接持有\s*(\d+)\s*家金融机构股权/.exec(overview)
  const overviewDate = validDate(intro?.[1])
  const count = Number(intro?.[2])
  if (!overviewDate || !Number.isSafeInteger(count) || count < 1 || count > 60) throw new Error('汇金总体页结构变化：缺明确期别/直接机构数量，拒绝空快照')
  if (!/全资持有子公司中央汇金资产管理有限责任公司/.test(overview) || !/注册资本\s*50亿元/.test(overview)) throw new Error('汇金总体页全资子公司原文未核实，拒绝推测')
  const sources = [source(HUIJIN_OVERVIEW_URL, '中央汇金：控参股机构总体情况', overviewHtml, 'official', overviewDate), source(HUIJIN_SHAREHOLDING_URL, '中央汇金：持股详情', shareholdingHtml, 'official')]
  const cleaned = shareholdingHtml.replace(/<!--[\s\S]*?-->/g, '')
  const blocks = cleaned.split(/<div\b[^>]*class=["']details-sheet-item(?:\s[^"']*)?["'][^>]*>/i).slice(1)
  if (!blocks.length || blocks.length > 60) throw new Error('汇金持股详情页未找到有界持股条目')
  // Only use a date stated on this page. The live page has none.
  const detailDate = validDate(/截至\s*(\d{4}年\d{1,2}月\d{1,2}日)/.exec(plain(cleaned))?.[1])
  sources[1]!.asOf = detailDate
  const holdings: StateCapitalHolding[] = blocks.map((block, i) => {
    const name = plain(/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '')
    const amounts = [...block.matchAll(/<span\b[^>]*class=["']sz["'][^>]*>([\s\S]*?)<\/span>/gi)].map(m => plain(m[1]!))
    const percentRaw = /data-value\s*=\s*["'](\d+(?:\.\d+)?)["']/i.exec(block)?.[1]
    if (!name || amounts.length !== 2 || percentRaw === undefined) throw new Error(`汇金持股详情第${i + 1}条缺名称/数量/比例`)
    const parsed = parseStateCapitalQuantity(amounts[1]!)
    const total = parseStateCapitalQuantity(amounts[0]!)
    if (total.unit !== parsed.unit || parsed.quantity > total.quantity) throw new Error(`汇金持股详情第${i + 1}条股本/出资单位或数量不一致`)
    const percentage = finiteNumber(percentRaw, '持股比例', 100)
    const indirect = /中央汇金公司不直接持股该公司/.test(plain(block))
    const intermediary = /以上显示为\s*(.*?)\s*对该公司持股情况/.exec(plain(block))?.[1]
    return { key: `equity:${name}`, name, assetType: 'equity', quantity: parsed.quantity, unit: parsed.unit, rawQuantity: amounts[1]!, percentage, denominator: `${parsed.unit === '元' ? '注册资本' : '股本'}：${amounts[0]}；比例单位%${indirect ? `；原文为${intermediary ?? '其他主体'}持股，不是汇金直接持股` : ''}`, holdingMode: indirect ? 'indirect' : 'direct', asOf: detailDate, disclosedAt: null, sourceUrl: HUIJIN_SHAREHOLDING_URL, sourceHash: sources[1]!.hash, locator: `details-sheet-item[${i + 1}] / ${name}${indirect ? ' / 不直接持股注' : ''}`, quantityPrecision: parsed.precision }
  })
  if (new Set(holdings.map(h => h.key)).size !== holdings.length) throw new Error('汇金持股详情存在重复名称，拒绝静默合并')
  if (holdings.filter(h => h.holdingMode === 'direct').length !== count) throw new Error('汇金两页直接机构数量不一致；可能异步改版，保留旧基线待核')
  holdings.push({ key: 'equity:中央汇金资产管理有限责任公司', name: '中央汇金资产管理有限责任公司', assetType: 'equity', quantity: null, unit: '元', rawQuantity: '全资持有；注册资本50亿元（非已核实出资额）', percentage: 100, denominator: '全资子公司权益；注册资本50亿元不等于实缴出资或二级市场持仓', holdingMode: 'direct', asOf: overviewDate, disclosedAt: null, sourceUrl: HUIJIN_OVERVIEW_URL, sourceHash: sources[0]!.hash, locator: '总体情况正文末注：全资持有子公司中央汇金资产管理有限责任公司' })
  const dates = new Set(holdings.map(h => h.asOf))
  return { entityId: 'huijin', entityName: '中央汇金投资有限责任公司', scopeId: 'huijin:official-institutions', asOf: dates.size === 1 ? holdings[0]!.asOf : null, disclosedAt: null, capturedAt, sources, holdings, coverage: `官网总体${count}家直接金融机构及全资子公司注；持股详情含直接与明确标注的间接机构；非全部证券持仓`, warnings: [`总体页明确截至${overviewDate}、直接${count}家；不能据此给另一个页面的数字强配期别。`, ...(detailDate ? [] : ['持股详情页未注明期别，详情行asOf为null；不是当前实时持仓。']), '详情页银河证券、申万宏源证券为中间机构持股，已与汇金直接持股分离。', '亿股/亿元按原单位换算，原文与显示精度保留；金额是出资口径，不是市场市值。', '图片形式的总体机构名称未OCR，不靠行序跨页拼接身份/期别；命名条目来自详情页同条链接。', '全资子公司注册资本不是已核实实缴出资额，数量留null，不与母子公司投资简单加总。', '未披露发布日；capturedAt仅为抓取时间。'] }
}

/** Strict six-digit listed A-share pool; no ETF / HK / permissive slicing or padding. */
export function normalizeStateCapitalCodes(codes: string[] | undefined): string[] {
  if (!Array.isArray(codes) || !codes.length) throw new Error('此主体需显式A股代码池codes（1—5只）；默认不读用户持仓、不扫描全市场')
  if (codes.length > STATE_CAPITAL_MAX_CODES) throw new Error('codes最多5只股票，不提供自动全市场扫描')
  const out = codes.map(c => {
    if (typeof c !== 'string' || !/^(?:60\d{4}|68\d{4}|00\d{4}|30\d{4}|[48]\d{5}|92\d{4})$/.test(c.trim())) throw new Error(`无效或非A股股票代码：${String(c)}；仅接受六位裸股票代码，不支持ETF`)
    return c.trim()
  })
  return [...new Set(out)].sort()
}
export function stateCapitalEastmoneyUrl(code: string): string {
  const c = normalizeStateCapitalCodes([code])[0]!
  const suffix = /^(?:60|68)/.test(c) ? 'SH' : /^(?:4|8|92)/.test(c) ? 'BJ' : 'SZ'
  const u = new URL(STATE_CAPITAL_EM_URL)
  const params: Record<string, string> = { reportName: STATE_CAPITAL_EM_REPORT, columns: 'ALL', filter: `(SECUCODE="${c}.${suffix}")`, pageNumber: '1', pageSize: '10', sortColumns: 'END_DATE,HOLDER_RANK', sortTypes: '-1,1', source: 'WEB', client: 'WEB' }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.href
}

/** Latest-ten response normalization; absence stays unknown, exact legal name only. */
export function parseStateCapitalEastmoneyResponse(text: string, code: string, entityId: string): { source: StateCapitalSource; holding: StateCapitalHolding; warnings: string[] } {
  const entity = resolveStateCapitalEntity(entityId)
  if (!entity) throw new Error('未知国家资本主体')
  const normalized = normalizeStateCapitalCodes([code])[0]!
  const url = stateCapitalEastmoneyUrl(normalized)
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error('东财十大股东响应不是JSON') }
  const root = json as { success?: unknown; code?: unknown; result?: { data?: unknown; count?: unknown; pages?: unknown } }
  if (root?.success !== true || root.code !== 0 || !root.result || !Array.isArray(root.result.data)) throw new Error('东财十大股东响应失败或缺data，拒绝覆盖旧基线')
  const rows = root.result.data as Record<string, unknown>[]
  const count = finiteNumber(root.result.count, '返回记录总数')
  const pages = finiteNumber(root.result.pages, '分页数')
  if (count === null || pages === null || !Number.isInteger(count) || !Number.isInteger(pages) || rows.length > 10 || count < rows.length || (rows.length && pages < 1) || (count > 0 && !rows.length)) throw new Error('东财十大股东数量/分页契约异常')
  const warnings = ['东财聚合披露，未核公司正式公告原文，不能标为官方事实。', '十大股东仅有限披露；名单未命中=未知，不是0，不代表无持仓或清仓。', '来源没有可核验的公告发布日期，disclosedAt为null；期末日不是公告日。', '仅核显式代码池，不含基金份额、场外账户或全市场。']
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.SECURITY_CODE !== normalized || typeof r.HOLDER_NAME !== 'string' || !r.HOLDER_NAME.trim() || !validDate(r.END_DATE) || typeof r.SECURITY_NAME_ABBR !== 'string' || !r.SECURITY_NAME_ABBR.trim()) throw new Error('东财十大股东行缺已核实字段或串入其他股票')
    const rank = finiteNumber(r.HOLDER_RANK, '股东排名', 10)
    if (rank === null || !Number.isInteger(rank) || rank < 1) throw new Error('东财十大股东排名异常')
    const num = finiteNumber(r.HOLD_NUM, '股东持股数')
    if (num !== null && !Number.isSafeInteger(num)) throw new Error('东财持股数不是安全整数股数')
    finiteNumber(r.HOLD_NUM_RATIO, '持股比例', 100)
  }
  const latest = rows.length ? rows.map(r => validDate(r.END_DATE)!).sort().at(-1)! : null
  const latestRows = rows.filter(r => validDate(r.END_DATE) === latest)
  if (new Set(latestRows.map(r => r.HOLDER_RANK)).size !== latestRows.length) throw new Error('东财同一期十大股东排名重复')
  const matches = latestRows.filter(r => String(r.HOLDER_NAME).trim() === entity.name)
  if (matches.length > 1) throw new Error('东财同一期同法定户名重复，拒绝静默加总')
  const match = matches[0]
  const src = source(url, `东方财富十大股东聚合 ${normalized}`, text, 'aggregated', latest)
  const quantity = match ? finiteNumber(match.HOLD_NUM, '目标持股数') : null
  const percentage = match ? finiteNumber(match.HOLD_NUM_RATIO, '目标持股比例', 100) : null
  const total = match ? finiteNumber(match.TOTAL_SHARES_NUM, '总股本') : null
  const holding: StateCapitalHolding = { key: `stock:${normalized}`, name: String((match ?? latestRows[0])?.SECURITY_NAME_ABBR ?? normalized), code: normalized, assetType: 'stock', quantity, unit: '股', rawQuantity: quantity === null ? '最新返回名单未披露该法定户名的可用数量（未知，非0）' : String(match!.HOLD_NUM), percentage, denominator: `总股本口径HOLD_NUM_RATIO(%)；总股本${total === null ? '未核' : `${total}股`}；${match ? String(match.SHARES_TYPE ?? '股份类型未披露') : '未命中目标法定户名'}`, holdingMode: match ? 'direct' : 'unknown', asOf: latest, disclosedAt: null, sourceUrl: url, sourceHash: src.hash, locator: match ? `result.data / END_DATE=${latest} / HOLDER_RANK=${String(match.HOLDER_RANK)} / HOLDER_NAME=${entity.name}` : `result.data / latest END_DATE=${latest ?? 'unknown'} / 精确法定户名未命中`, quantityPrecision: 1 }
  if (!rows.length) warnings.push(`${normalized}未返回任何股东名单，期别及持股均未知。`)
  else if (latestRows.length < 10) warnings.push(`${normalized}最新一期只返回${latestRows.length}条，覆盖可能不完整。`)
  if (!match) warnings.push(`${normalized}最新返回名单未见${entity.name}，不能解释为零。`)
  return { source: src, holding, warnings }
}

function allowedUrl(url: string): void {
  const u = new URL(url)
  const isHuijin = url === HUIJIN_OVERVIEW_URL || url === HUIJIN_SHAREHOLDING_URL
  const isEm = u.origin === 'https://datacenter-web.eastmoney.com' && u.pathname === '/api/data/v1/get' && u.searchParams.get('reportName') === STATE_CAPITAL_EM_REPORT
  if (u.username || u.password || u.hash || u.protocol !== 'https:' || (!isHuijin && !isEm)) throw new Error('国家资本来源URL不在固定允许范围内')
}
async function boundedText(url: string, options: StateCapitalFetchOptions, signal: AbortSignal): Promise<string> {
  allowedUrl(url)
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
  const timeout = options.timeoutMs ?? 12_000
  const max = options.maxResponseBytes ?? STATE_CAPITAL_MAX_BYTES
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000 || !Number.isSafeInteger(max) || max < 1 || max > STATE_CAPITAL_MAX_BYTES) throw new Error('网络超时/响应字节预算无效')
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason ?? new Error('aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`国家资本来源超时 ${timeout}ms`)), timeout)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/json,text/plain,*/*' } })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`国家资本来源 HTTP ${response.status}；旧基线不得被覆盖`) }
    if (response.url && response.url !== url) { await response.body?.cancel(); throw new Error('来源发生重定向，拒绝离开固定URL') }
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > max)) { await response.body?.cancel(); throw new Error('国家资本来源响应字节超预算') }
    if (!response.body) throw new Error('国家资本来源没有响应体')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0, text = ''
    try {
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('aborted')
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > max) throw new Error('国家资本来源响应字节超预算')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('aborted')
      return text
    } catch (err) {
      await reader.cancel().catch(() => {})
      throw err
    } finally { reader.releaseLock() }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Huijin without codes -> the official institutional-equity pages.
 * Any entity with codes -> latest aggregate top-ten in that explicit stock pool.
 * Huijin Asset / CSF without codes -> configuration error, never a fake empty snapshot.
 * A failed source rejects the entire call; persistence must retain the prior baseline.
 */
export async function fetchStateCapitalDisclosure(entityId: string, options: StateCapitalFetchOptions = {}): Promise<StateCapitalDisclosure> {
  const entity = resolveStateCapitalEntity(entityId)
  if (!entity) throw new Error(`未知国家资本主体：${entityId}`)
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('capturedAt必须是有效抓取时间')
  const codes = options.codes === undefined && entity.id === 'huijin' ? null : normalizeStateCapitalCodes(options.codes)
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('aborted'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('国家资本抓取整轮超时45秒')), 45_000)
  try {
    if (!codes) {
      const overview = await boundedText(HUIJIN_OVERVIEW_URL, options, controller.signal)
      const detail = await boundedText(HUIJIN_SHAREHOLDING_URL, options, controller.signal)
      return parseHuijinOfficialPages(overview, detail, capturedAt)
    }
    const sources: StateCapitalSource[] = [], holdings: StateCapitalHolding[] = [], warnings: string[] = []
    // Sequential, one request/code, no hidden historical pagination / automatic retries.
    for (const code of codes) {
      const text = await boundedText(stateCapitalEastmoneyUrl(code), options, controller.signal)
      const parsed = parseStateCapitalEastmoneyResponse(text, code, entity.id)
      sources.push(parsed.source); holdings.push(parsed.holding); warnings.push(...parsed.warnings)
    }
    const dates = new Set(holdings.map(h => h.asOf))
    if (dates.size > 1) warnings.push('代码池内最新披露期并不一致，不能视为同一期完整横截面；逐行保留各自期末。')
    return { entityId: entity.id, entityName: entity.name, scopeId: `eastmoney:top10:${codes.join(',')}`, asOf: dates.size === 1 ? holdings[0]!.asOf : null, disclosedAt: null, capturedAt, sources, holdings, coverage: `显式A股代码池[${codes.join(',')}]最新返回十大股东精确法定户名匹配；非全部持仓`, warnings: [...new Set([...warnings, '期末数量不等于当日买卖；公司行动未核，不把上游HOLDER_STATE增减标签当交易证据。', '与汇金母子公司及其他国家资本主体不能简单加总。'])] }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
