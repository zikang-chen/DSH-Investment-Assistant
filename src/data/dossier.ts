import type { FinanceDataService } from './service.js'
import type { AssetType } from '../types.js'
import { routeCode } from './route-code.js'
import { createHash } from 'node:crypto'

/**
 * 个股深度档案（Dossier）：把一个标的在 WeStock 上的全部维度一次性并发取回。
 *
 * 之前面板只能看到「行情 / K线 / 财务 / 新闻」四块，WeStock 实际还提供
 * 一致预期、股票评分、资金流向、股东研究、分红回购、ESG、风险事件、公告、
 * 产业链等十几个维度——这里把它们聚合成一份档案，供面板「深度」页与 Agent 使用。
 *
 * 设计原则：
 *  - 并发取、单项失败不影响整体（section 级 ok/error）；
 *  - 「数据为空」是正常结果，不算失败（如个股当前无事件）；
 *  - 带时间窗的能力（回购/龙虎榜）自动补默认区间，避免必填参数缺失而报错。
 */

export interface DossierSection {
  key: string
  label: string
  group: string
  ok: boolean
  /**
   * 维度状态：ready=有数据；empty=正常空；unsupported=该资产不适用；
   * error=取数失败。「数据为空」不再与失败混同。
   */
  status: 'ready' | 'empty' | 'unsupported' | 'error'
  /** 实际命中的 provider（WeStock 优先，失败时回落 HTTP 源）。 */
  provider?: string
  /** 行数（数组长度或对象字段数）。 */
  rows: number
  /** 结构化行（已由 Markdown 表格解析为对象数组）。 */
  data?: unknown
  error?: string
  /** 数据时点（如 F10 报告期/统计截止日；不是抓取时间）。 */
  dataAsOf?: string
  missing?: string[]
  ms: number
}

export interface StockDossier {
  code: string
  type: AssetType
  at: string
  /** 内容寻址快照 id：报告引用它证明「基于哪次档案」；同数据重取得到同 id。 */
  snapshotId: string
  /** 成功的维度数 / 总维度数。 */
  ready: number
  total: number
  elapsedMs: number
  sections: DossierSection[]
}

/** 档案 section 的适用市场；基金另行判断。 */
export type DossierMarket = 'a' | 'hk' | 'us'

export interface DossierSectionSpec {
  key: string
  label: string
  group: string
  /** registry capability 名。 */
  capability: string
  args?: (ctx: { code: string; start: string; end: string }) => Record<string, unknown>
  /** 仅股票（如 F10 七维，且实际只适用 A 股）：基金/港美股直接标 unsupported，不发无效请求。 */
  onlyStock?: boolean
  /** 适用市场；缺省=不限（保留既有 WeStock/F10 行为）。 */
  markets?: readonly DossierMarket[]
  /** 数据时点提取（如全球财务取最新报告期）；优先于 data.meta.asOf。 */
  dataAsOf?: (data: unknown) => string | undefined
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** 需要时间窗的能力默认取近一年。 */
function defaultWindow(): { start: string; end: string } {
  const end = new Date()
  const start = new Date()
  start.setFullYear(start.getFullYear() - 1)
  return { start: iso(start), end: iso(end) }
}

const MARKET_LABEL: Record<DossierMarket, string> = { a: 'A股', hk: '港股', us: '美股' }

/** 按 routeCode 的同一套规则得到档案市场；基金独立返回，避免把基金当 A 股。 */
export function dossierMarketOf(code: string, type: AssetType = 'stock'): DossierMarket | 'fund' {
  const routed = routeCode(code, type)
  if (routed.market === '基金') return 'fund'
  if (routed.market === '港股') return 'hk'
  if (routed.market === '美股') return 'us'
  return 'a'
}

/**
 * 全球财务（港股/美股）的数据时点 = 最新报告期末，不是 fetchedAt。
 * 港股行字段是 reportDate，美股行字段是 end；两套都只认严格 YYYY-MM-DD。
 */
function latestGlobalReportDate(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const rows = (data as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return undefined
  const dates: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const candidate = typeof o.reportDate === 'string' ? o.reportDate : typeof o.end === 'string' ? o.end : undefined
    if (candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) dates.push(candidate)
  }
  return dates.sort().at(-1)
}

export const DOSSIER_SPECS: readonly DossierSectionSpec[] = [
  // 研究 / 预期
  { key: 'consensus', label: '一致预期（目标价 + 三年盈利预测）', group: '研究', capability: 'consensus' },
  { key: 'score', label: '股票评分（综合/基本面/技术/风险）', group: '研究', capability: 'stock_score' },
  { key: 'esg', label: 'ESG 评级', group: '研究', capability: 'esg' },
  { key: 'rating', label: '机构评级', group: '研究', capability: 'institution_rating' },
  // 资金
  // EM 逐日明细（20 日）优先由 service 路由保证；标签写明算法统计口径。
  { key: 'money_flow', label: '资金流向（逐日 20 日；算法统计，不等于公司现金流）', group: '资金', capability: 'money_flow' },
  { key: 'margin', label: '融资融券（汇总）', group: '资金', capability: 'margin_trade' },
  { key: 'block', label: '大宗交易（汇总）', group: '资金', capability: 'block_trade' },
  // ---- T5 东财公司事件明细（仅 A 股；来源与数据时点由模块返回）----
  {
    key: 'block_trade', label: '大宗交易明细（东财数据中心；逐笔，CNY）', group: '资金',
    capability: 'block_trade_detail', markets: ['a'],
  },
  {
    key: 'margin_detail', label: '融资融券明细（东财数据中心；逐日余额/净买入，CNY）', group: '资金',
    capability: 'margin_detail', markets: ['a'],
  },
  {
    key: 'lhb', label: '个股龙虎榜', group: '资金', capability: 'dragon_tiger',
    args: ({ code, start, end }) => ({ code, start, end }),
  },
  { key: 'north', label: '北向资金持仓', group: '资金', capability: 'north_holding' },
  // 股东 / 回报
  { key: 'shareholder', label: '股东研究（十大股东/变动）', group: '股东与回报', capability: 'shareholder' },
  { key: 'dividend', label: '分红记录', group: '股东与回报', capability: 'dividend' },
  {
    key: 'dividend_plan', label: '分红送配（东财：预案/实施/除权，每 10 股口径）', group: '股东与回报',
    capability: 'dividend_plan', markets: ['a'],
  },
  {
    key: 'buyback', label: '公司回购', group: '股东与回报', capability: 'buyback',
    args: ({ code, start, end }) => ({ code, start, end }),
  },
  // 风险 / 事件
  { key: 'events', label: '个股事件（42 类标签）', group: '风险与事件', capability: 'stock_events' },
  { key: 'risk', label: '风险事件监控', group: '风险与事件', capability: 'risk_events' },
  { key: 'suspension', label: '停复牌', group: '风险与事件', capability: 'suspension' },
  // 资讯 / 公告
  { key: 'notice', label: '公司公告（汇总列表）', group: '资讯', capability: 'notice_list' },
  {
    key: 'announcements', label: '公告原文索引（东财公告库；含公告详情链接）', group: '资讯',
    capability: 'announcements', markets: ['a'],
  },
  { key: 'news', label: '个股新闻', group: '资讯', capability: 'stock_news' },
  // 产业链
  {
    key: 'industry_chain', label: '所属产业链', group: '产业链',
    capability: 'industry_chain',
    args: ({ code }) => ({ view: 'stock', code }),
  },
  // ---- T4 东财 F10 七维（仅 A 股；港美/基金显式 unsupported）----
  { key: 'company_survey', label: '公司概况（F10）', group: '基本面', capability: 'company_survey', onlyStock: true },
  { key: 'business_composition', label: '主营构成（产品/地区/行业）', group: '基本面', capability: 'business_composition', onlyStock: true },
  { key: 'main_financials', label: '主要财务指标（分期）', group: '基本面', capability: 'main_financials', onlyStock: true },
  { key: 'core_concepts', label: '核心题材（概念标签）', group: '基本面', capability: 'core_concepts', onlyStock: true },
  { key: 'shareholder_count', label: '股东户数（时点统计）', group: '股东与回报', capability: 'shareholder_count', onlyStock: true },
  { key: 'valuation_analysis', label: '估值分位（PE/PB 历史）', group: '估值与同业', capability: 'valuation_analysis', onlyStock: true },
  { key: 'peer_comparison', label: '同行比较（口径见行内标注）', group: '估值与同业', capability: 'peer_comparison', onlyStock: true },
  // ---- T5 A 股业绩 + 港股/美股财务（显式来源与口径；不补 0）----
  {
    key: 'performance', label: '业绩预告/快报（东财；预告为区间，快报按报告期口径）', group: '基本面',
    capability: 'performance', markets: ['a'],
  },
  {
    key: 'hk_financials', label: '港股财务（东财 HKF10；累计口径、非单季；币种随报告）', group: '基本面',
    capability: 'global_financials',
    args: ({ code }) => ({ code, market: 'hk' }),
    markets: ['hk'],
    dataAsOf: latestGlobalReportDate,
  },
  {
    key: 'us_financials', label: '美股财务（SEC XBRL；10-K 年度 / 10-Q 单季，申报口径 USD）', group: '基本面',
    capability: 'global_financials',
    args: ({ code }) => ({ code, market: 'us' }),
    markets: ['us'],
    dataAsOf: latestGlobalReportDate,
  },
]

/** 行数：数组长度；包装型 data（{rows:[...]}）取 rows 长度；其余按字段数。 */
function rowCount(data: unknown): number {
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object') {
    const rows = (data as { rows?: unknown }).rows
    if (Array.isArray(rows)) return rows.length
    return Object.entries(data as Record<string, unknown>).filter(([key, value]) => key !== 'meta' && value !== undefined && value !== null && value !== '').length
  }
  return 0
}

/**
 * 包装型 data 的元数据键：来源/时点/单位/抓取时间/币种等只用于溯源，
 * 不能把空 rows 的 section 判成 ready（那会把「没数据」显示成「有数据」）。
 */
const NON_DATA_KEYS = new Set([
  'meta', 'latest', 'percentile', 'profile', 'method', 'caliber',
  'source', 'asOf', 'unit', 'currency', 'fetchedAt', 'count', 'warnings',
  'partial', 'total', 'page', 'pageSize', 'name', 'code', 'market', 'kind',
])

function warningsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const warnings = (data as { warnings?: unknown }).warnings
  return Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string' && !!w) : []
}

function metaOfData(data: unknown): { asOf?: string; reportPeriod?: string; missing?: string[] } | undefined {
  if (!data || typeof data !== 'object' || !('meta' in (data as object))) return undefined
  return (data as { meta?: { asOf?: string; reportPeriod?: string; missing?: string[] } }).meta
}

function topLevelAsOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const asOf = (data as { asOf?: unknown }).asOf
  return typeof asOf === 'string' && asOf ? asOf : undefined
}

function unsupportedSection(spec: DossierSectionSpec, market: DossierMarket | 'fund', t0: number): DossierSection {
  const wanted = (spec.markets ?? []).map((m) => MARKET_LABEL[m]).join('/')
  const current = market === 'fund' ? '基金' : MARKET_LABEL[market]
  return {
    key: spec.key, label: spec.label, group: spec.group, ok: false, status: 'unsupported', rows: 0,
    error: `${spec.label}：仅适用于 ${wanted}；当前为${current}，未发起请求`, ms: Date.now() - t0,
  }
}

export async function buildStockDossier(
  finance: FinanceDataService,
  code: string,
  type: AssetType = 'stock',
): Promise<StockDossier> {
  const started = Date.now()
  const { start, end } = defaultWindow()
  const ctx = { code, start, end }
  const market = dossierMarketOf(code, type)

  const sections = await Promise.all(DOSSIER_SPECS.map(async (spec): Promise<DossierSection> => {
    const t0 = Date.now()
    if (spec.onlyStock && market !== 'a') {
      const current = market === 'fund' ? '基金' : MARKET_LABEL[market]
      return {
        key: spec.key, label: spec.label, group: spec.group, ok: false, status: 'unsupported', rows: 0,
        error: `F10 七维仅支持 A 股股票，${current}不适用`, ms: Date.now() - t0,
      }
    }
    if (spec.markets && (market === 'fund' || !spec.markets.includes(market))) {
      return unsupportedSection(spec, market, t0)
    }
    try {
      const args = spec.args?.(ctx) ?? { code }
      const r = await finance.westock<unknown>(spec.capability, args)
      // 空数据是正常结果（如当前无事件），只标记行数 0，不算失败。
      const rows = r.ok ? rowCount(r.data) : 0
      const meta = metaOfData(r.data)
      const missingNotes = [...(meta?.missing ?? []), ...warningsOf(r.data)]
      const missing = missingNotes.length ? [...new Set(missingNotes)] : undefined
      // 空判定看「有意义字段」：meta/latest/percentile 等壳与来源元数据不算数据；
      // rows/history 看数组长度；空数组/空对象算空。
      const meaningful = (() => {
        const d = r.data as unknown
        if (d === undefined || d === null) return 0
        if (Array.isArray(d)) return d.length
        if (typeof d !== 'object') return 1
        let n = 0
        for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
          if (NON_DATA_KEYS.has(k) && !(['company_survey', 'overview'].includes(spec.key) && ['name', 'profile'].includes(k))) continue
          if (k === 'history' || k === 'rows') {
            if (Array.isArray(v)) n += v.length
            continue
          }
          if (Array.isArray(v)) n += v.length
          else if (v && typeof v === 'object') n += Object.keys(v).length
          else if (v !== undefined && v !== null && v !== '') n++
        }
        return n
      })()
      const empty = r.ok && meaningful === 0
      // 数据时点：优先 spec 提取（全球财务取最新报告期），再看 meta/asOf，
      // 绝不使用 fetchedAt/抓取时间。
      const dataAsOf = spec.dataAsOf?.(r.data) ?? meta?.asOf ?? meta?.reportPeriod ?? topLevelAsOf(r.data)
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        ok: r.ok,
        status: r.ok ? (empty ? 'empty' : 'ready') : 'error',
        provider: r.provider,
        rows,
        data: r.ok ? r.data : undefined,
        error: r.ok ? undefined : r.error,
        ...(dataAsOf ? { dataAsOf } : {}),
        ...(missing ? { missing } : {}),
        ms: Date.now() - t0,
      }
    } catch (err) {
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        ok: false,
        status: 'error',
        rows: 0,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      }
    }
  }))

  return {
    code,
    type,
    at: new Date().toISOString(),
    snapshotId: dossierSnapshotId({ code, type, sections }),
    ready: sections.filter((s) => s.status === 'ready').length,
    total: sections.length,
    elapsedMs: Date.now() - started,
    sections,
  }
}

/** 快照哈希剔除抓取时间/耗时等易变字段：同数据重取得到同 id，报告引用才可校验。 */
export function dossierSnapshotId(d: { code: string; type: AssetType; sections: DossierSection[] }): string {
  const stripVolatile = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stripVolatile)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // fetchedAt/retrievedAt 是抓取时间，不是数据；剔除后同数据重取得到同 snapshotId。
        if (k === 'retrievedAt' || k === 'fetchedAt' || k === 'ms') continue
        out[k] = stripVolatile(x)
      }
      return out
    }
    return v
  }
  const canonical = JSON.stringify(stripVolatile({
    code: d.code,
    type: d.type,
    sections: d.sections.map((s) => ({ key: s.key, status: s.status, rows: s.rows, data: s.data })),
  }))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** 面板/工具用：把档案压成一段可读摘要（喂给模型或展示概览）。 */
export function dossierSummary(d: StockDossier, noun = '个股深度档案'): string {
  const ok = d.sections.filter((s) => s.ok && s.rows > 0)
  const lines = ok.map((s) => `- ${s.label}：${s.rows} 条（${s.provider ?? '—'}，${s.ms}ms）`)
  const failed = d.sections.filter((s) => !s.ok)
  return [
    `${d.code} ${noun}：${d.ready}/${d.total} 个维度有数据，用时 ${d.elapsedMs}ms`,
    ...lines,
    ...(failed.length ? ['- 暂不可用：' + failed.map((s) => `${s.label}（${s.error ?? '无数据'}）`).join('、')] : []),
  ].join('\n')
}
