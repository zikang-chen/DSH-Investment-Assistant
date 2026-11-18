import { accessError } from './api-security.js'
import { confirmations } from './confirmations.js'
import type { PersonalStore } from './personal.js'
import { weekTimeZone } from './personal.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalysisStore } from './analysis-store.js'
import type { FinanceDataService } from './data/service.js'
import type { PortfolioStore } from './store.js'
import type { McpManager } from './mcp/manager.js'
import { buildStockDossier, dossierSummary } from './data/dossier.js'
import { buildFundDossier } from './data/fund-dossier.js'
import { normalizeGlobalRegion } from './data/global-indices.js'
import { fetchGlobalQuote, fetchGlobalKline } from './data/global-quotes.js'
import { listCnDatasets, fetchCnDataset, checkCnBridge } from './data/cn-datasets.js'
import { fetchStrategyExperiment } from './strategy/lab-service.js'
import path from 'node:path'
import { PortfolioVersionStore } from './strategy/portfolio-versions.js'
import { importPortfolioSnapshot } from './strategy/portfolio-import.js'
import { verifyPortfolioData, type PortfolioVerificationInput } from './strategy/portfolio-verification.js'
import { runPortfolioBacktest } from './strategy/portfolio-backtest.js'
import { buildLookthrough } from './lookthrough.js'
import type { ReminderOptions, ReminderScanResult, ReminderStore } from './reminders.js'
import type { PanelBus } from './panel-bus.js'
import type { SkillManager } from './skills.js'
import type { HistoryStore } from './history/store.js'
import { syncHistory, type SymbolKind } from './history/sync.js'
import { buildLiveSnapshot, type SnapshotItem } from './live.js'
import type { Logger } from './log.js'
import { westockCapabilityCatalog, westockCapabilityMeta } from './data/westock-capabilities.js'

/** 数据源目录附上能力中文名/分组（面板把 50+ 扩展能力归组显示，不再一行一个裸英文 id）。 */
function withCapMeta<T extends { capability: string }>(rows: T[]): Array<T & { label?: string; group?: string }> {
  const meta = westockCapabilityMeta()
  return rows.map((r) => {
    const m = meta.get(r.capability)
    return m ? { ...r, label: m.label, group: m.group } : { ...r }
  })
}
import { collectResearch } from './research/tools.js'
import { ResearchConfirmationRequired, type ResearchKind, type ResearchStatus, type ResearchVault } from './research/store.js'
import type { GrowthStore } from './growth-store.js'
import { buildGrowthSnapshot } from './tools/growth-tools.js'
import type { FollowStore } from './follow-store.js'
import { buildFollowSnapshot } from './tools/follow-tools.js'
import { setPanelFocus } from './panel-focus.js'
import type { PolicyStore } from './policy/store.js'
import { DEFAULT_POLICY_SOURCES } from './policy/sources.js'
import { policyEvidenceLevel, EVIDENCE_LABEL, citationCaveat } from './policy/evidence.js'
import { POLICY_DOC_TYPES, POLICY_STATUSES, isoDay, type PolicyDocType, type PolicyStatus } from './policy/types.js'
import type { EvidenceRepository } from './evidence/repository.js'
import type { EvidenceWorkflow } from './evidence/workflow.js'
import { EVIDENCE_REQUEST_STATUSES } from './evidence/schema.js'
import type { AdviceStore } from './invest/store.js'
import { adviceBrief } from './invest/store.js'
import { RECOMMENDATION_LABEL } from './invest/schema.js'
import type { CapitalStore } from './capital/ledger.js'
import { deriveState } from './capital/performance.js'
import { fromCents } from './capital/types.js'
import type { WealthPlanStore } from './wealth/plans.js'
import { compound, toCentsSafe, yuan } from './wealth/compound.js'
import type { LearningStore } from './learn/explain.js'
import { CATEGORY_LABEL, LEVEL_LABEL, searchConcepts, type ConceptCategory, type ExplainLevel } from './learn/concepts.js'
import { categorySummary, explain as explainConcept, type LearnStatus } from './learn/explain.js'
import type { AssetType } from './types.js'
import { ValidationError, validateAssetType, validateCode, validateDate, validateMarketKind } from './validation.js'
import { fetchAndBuildGlobalNewsRadar } from './news/global-radar.js'

/** Keep SSE connections alive through proxies/idle timeouts. */
const SSE_HEARTBEAT_MS = 20_000

const HISTORY_KINDS: SymbolKind[] = ['a', 'hk', 'us', 'fund']

export const API_PREFIX = '/plugins/dsh-finance/api'

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

class RequestError extends Error { constructor(message: string, readonly status = 400) { super(message) } }

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) { size += Buffer.byteLength(c); if (size > 1_048_576) throw new RequestError('请求超过1MB', 413); chunks.push(Buffer.from(c)) }
  if (!chunks.length) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON正文必须为对象')
    return value as Record<string, unknown>
  } catch {
    throw new RequestError('JSON正文必须是有效对象')
  }
}

function normType(v: unknown): AssetType {
  return v === 'fund' ? 'fund' : 'stock'
}

/** Items to quote: watchlist + holdings, deduped by code+type. */
function snapshotItems(store: PortfolioStore): SnapshotItem[] {
  const { holdings, watchlist } = store.get()
  const seen = new Set<string>()
  const items: SnapshotItem[] = []
  for (const w of [...watchlist, ...holdings]) {
    const key = `${w.type}:${w.code}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ code: w.code, type: w.type, name: w.name })
  }
  return items
}

/**
 * 投顾视角：把资料库里该标的的既有观点/研报喂给模型，让解读"带记忆"——
 * 新报告要对照旧观点，指出被验证/被证伪的部分，而不是每次都从零重写。
 */
export function advisorMemory(vault: ResearchVault | undefined, code: string): string {
  if (!vault) return ''
  let items: Array<{ title: string; kind: string; occurredAt: string; opinion?: string; summary?: string; notes: Array<{ at: string; text: string }> }> = []
  try {
    items = vault.list({ code, limit: 6 })
  } catch { return '' }
  if (!items.length) return ''
  const lines = items.flatMap((it) => {
    const out: string[] = []
    const kindLabel = it.kind === 'report' ? '研报' : it.kind === 'filing' ? '财报' : it.kind === 'news' ? '资讯'
      : it.kind === 'decision' ? '决策日记' : it.kind === 'learn' ? '学习笔记' : it.kind === 'review' ? '复盘' : '观点'
    const label = `${it.occurredAt}｜${kindLabel}｜${it.title}`
    if (it.opinion) out.push(`- ${label}：结论「${it.opinion}」`)
    else if (it.summary) out.push(`- ${label}：摘要「${it.summary}」`)
    for (const n of it.notes.slice(-2)) out.push(`  · 批注 ${n.at.slice(0, 10)}：${n.text}`)
    return out
  })
  if (!lines.length) return ''
  return [
    '',
    '【投顾视角 · 该标的的历史观点与研报（来自本地资料库，务必纳入推理）】',
    ...lines.slice(0, 14),
    '请在报告中新增一节「与我既有观点的对照」：逐条说明上述观点被验证、被证伪还是仍待观察，并给出需要修正的结论。',
    '如果本次数据与历史结论冲突，明确指出冲突点，不要为了保持一致而回避。',
  ].join('\n')
}

interface AnalysisPromptResult {
  prompt: string
  refs: { dossierSnapshotId: string; thesisRevision?: number; previousReportId?: string }
}

/**
 * 深度解读提示词（T5）：先档案快照、再对照原判断/上次报告/上次决定，按
 * 「原判断—新证据—验证/反证/待观察—与上次变化—待确认修订建议」组织。
 * 提示词要求检索是行为指令；保存时另做引用契约校验（不证明语义真实）。
 */
async function analysisPrompt(
  code: string,
  type: AssetType,
  holding: { name?: string; quantity: number; avgCost: number } | undefined,
  vault?: ResearchVault,
  personal?: PersonalStore,
  analyses?: AnalysisStore,
  finance?: FinanceDataService,
  portfolioAuthorized = false,
): Promise<AnalysisPromptResult> {
  const position = portfolioAuthorized && holding
    ? `这是当前持仓，数量 ${holding.quantity}，平均成本 ${holding.avgCost}${holding.name ? `，名称 ${holding.name}` : ''}。`
    : '这是独立标的研究，未授权读取或向模型发送个人持仓、成本和个人判断记录；不要编造这些信息。'
  const dataPlan = type === 'fund'
    ? [
      '先调用 fund_dossier 获取基金档案（基金经理/资产配置/规模申赎/同类排名/重仓持仓/本地风险指标/基准对比）；档案是数据不是结论，缺失维度如实写进「缺失」。',
      '再调用 get_fund_quote（asOf=净值日期，基金净值 T+1 更新，不要当实时价）；风险指标已含在 fund_dossier 里，需要重算或换基准时用 calculate_fund_metrics。',
      '多只基金对比用 compare_funds（阶段收益 + 两两相关性）；场内 ETF（51/56/15/16/18 开头）可调 get_etf_overview 看折溢价与规模、get_etf_holdings 看重仓（WeStock 未接入会失败，标注缺失即可，不要编造）。',
      '补充 get_fund_rank（同类阶段排名）、get_macro_china、get_market_news 和 web_search，说明宏观与消息环境；数据失败时明确标注。',
    ]
    : [
      '先调用 stock_dossier 获取该标的深度档案（基本面/资金/股东/风险/公告/产业链），必要时按缺口补查单个能力，不要从零逐个命令拼数据。',
      '再调用 get_realtime_quote、get_stock_kline 与 calculate_technical_indicators（至少 MA5、MA20、MA60、MACD、RSI）补行情与技术面。',
      '补充 get_stock_news、get_macro_china、get_market_overview，说明消息、宏观和行业环境；数据失败时明确标注。',
    ]

  // 档案快照：内容寻址 id，报告必须回引，证明结论基于哪一版档案。
  const refs: AnalysisPromptResult['refs'] = { dossierSnapshotId: '' }
  const dossierBlock: string[] = []
  if (finance) {
    try {
      const d = type === 'fund'
        ? await buildFundDossier(finance, code)
        : await buildStockDossier(finance, code, type)
      refs.dossierSnapshotId = d.snapshotId
      await analyses?.noteSnapshot(d.snapshotId, code, type)
      // 股票取 F10 四维；基金取基金档案关键维（基本信息/经理/风险/基准/重仓/同类分位）。
      const essentials = d.sections
        .filter((s) => (type === 'fund'
          ? ['overview', 'manager', 'risk_metrics', 'benchmark', 'holdings', 'rank_percent']
          : ['company_survey', 'main_financials', 'valuation_analysis', 'shareholder_count']).includes(s.key))
        .map((s) => `  - ${s.label}：${s.status}${s.dataAsOf ? `（数据时点 ${s.dataAsOf}）` : ''}${s.error ? `｜${s.error}` : ''}`)
      dossierBlock.push(
        '',
        `【档案快照 · snapshotId=${d.snapshotId}】已并发取回 ${d.ready}/${d.total} 个维度（${dossierSummary(d, type === 'fund' ? '基金深度档案' : '个股深度档案').split('\n')[0]}）。`,
        ...essentials,
        '档案是数据不是结论；维度为空/失败要如实写进「缺失」，不要用推测填数。',
      )
    } catch (err) {
      dossierBlock.push('', `【档案快照】获取失败：${err instanceof Error ? err.message : String(err)}；如需可再调用${type === 'fund' ? ' fund_dossier' : ' stock_dossier'}，并把缺失写进报告。`)
    }
  }

  // 原判断（版本化）+ 上次报告 + 上次人工决定，供「与上次变化」对照。
  // 只有本次请求显式授权时才把用户私人研究上下文交给模型；默认不读取。
  const context: string[] = []
  if (personal && portfolioAuthorized) {
    const state = personal.get()
    const thesis = state.theses.find((t) => t.code === code && (t.type ?? 'stock') === type)
    if (thesis) {
      refs.thesisRevision = thesis.revision
      context.push(
        '',
        `【原判断 · v${thesis.revision}${thesis.changeReason ? `（v${thesis.revision} 修正理由：${thesis.changeReason}）` : ''}】`,
        `理由：${thesis.rationale}`,
        `验证指标：${thesis.indicator}`,
        `证伪条件：${thesis.falsifier}`,
        ...(thesis.indicators?.length ? [`结构化指标：${thesis.indicators.map((i) => `${i.label}（${i.metricKey} ${i.comparator} ${i.threshold}${i.unit ?? ''}）`).join('；')}`] : []),
        '逐条对照上面的验证指标与证伪条件：被验证 / 被证伪 / 仍待观察，缺失的指标写「缺失」。',
      )
    }
    const decided = state.cards
      .filter((c) => c.thesis.code === code && (c.thesis.type ?? 'stock') === type && c.decision)
      .sort((a, b) => b.week.localeCompare(a.week))[0]
    if (decided?.decision) {
      context.push('', `【上次人工决定 · ${decided.week}】${decided.decision.action}｜${decided.decision.reason}。这是用户自己的判断，不得覆盖或替用户做新决定。`)
    }
  }
  if (analyses && portfolioAuthorized) {
    const prev = analyses.get(code, type)
    if (prev) {
      refs.previousReportId = prev.reportId
      const excerpt = prev.report.slice(0, 500).replace(/\s+/g, ' ')
      context.push('', `【上次报告 · v${prev.version}（${prev.generatedAt.slice(0, 10)}）】${excerpt}……`, '新增一节「与上次变化」：哪些结论被新证据加强/推翻/仍待观察。')
    }
  }

  return {
    refs,
    prompt: [
      `用户刚刚在 DSH Finance 面板主动点击了${type === 'fund' ? '基金' : '股票'} ${code}，请求生成一次完整中文解读。`,
      position,
      ...dataPlan,
      ...dossierBlock,
      ...context,
      portfolioAuthorized ? advisorMemory(vault, code) : '',
      '请基于工具返回的真实数据写出完整 Markdown 报告，不要编造缺失字段，区分「事实 / 推断 / 未知」，也不要把研究参考写成确定性买卖建议。',
      '报告按以下结构组织：一句话结论 → 原判断 → 新证据 → 验证/反证/待观察（逐条对指标）→ 与上次变化 → 主要风险 → 后续观察清单 → 数据时间与来源 → 待确认修订建议（只建议，不修改观点）。',
      `完成报告后必须调用 save_position_analysis，参数 code="${code}"、type="${type}"，将完整报告放入 report${refs.dossierSnapshotId ? `，并回引 dossier_snapshot_id="${refs.dossierSnapshotId}"` : ''}${refs.thesisRevision !== undefined ? `、thesis_revision=${refs.thesisRevision}` : ''}${refs.previousReportId ? `、previous_report_id="${refs.previousReportId}"` : ''}；不要只把报告留在普通回复中。`,
    ].join('\n'),
  }
}

/**
 * Register the finance panel's HTTP API on ctx.webServer. Live quotes are computed on demand
 * and returned to the client (held in React state) — never written to plugin config.
 *
 * Bidirectional channel: `GET /events` streams bus events (SSE) so panel clients react to
 * agent-side mutations instantly instead of waiting for the 60s poll; the poll stays as fallback.
 */
export function registerRoutes(
  webServer: WebServerLike,
  finance: FinanceDataService,
  store: PortfolioStore,
  mcp: McpManager | undefined,
  history: HistoryStore | undefined,
  skills: SkillManager | undefined,
  analyses: AnalysisStore,
  bus: PanelBus,
  vault?: ResearchVault,
  logger?: Logger,
  reminders?: ReminderStore,
  /** 手动触发一次提醒扫描（面板/工具调用）。 */
  scan?: (options?: ReminderOptions) => Promise<ReminderScanResult>,
  personal?: PersonalStore,
  growth?: GrowthStore,
  follow?: FollowStore,
  /** 政策库（面板「政策」页只读快照：列表、详情、来源）。 */
  policy?: PolicyStore,
  /** 证据协作（面板「研究协作」页：列表、详情、提交、校验、恢复）。 */
  evidence?: { workflow: EvidenceWorkflow; repo: EvidenceRepository },
  /** 投资建议库（面板「投资判断」页只读快照）。 */
  advice?: { current?: AdviceStore },
  /** 个人资本账本（面板「我的资本」页只读快照）。 */
  capital?: { current?: CapitalStore },
  /** 财富规划方案（面板「财富规划」页：计算 + 保存 + 对比）。 */
  wealth?: { current?: WealthPlanStore },
  /** 金融学习（面板「学习」页：概念检索、三级解释、学习进度）。 */
  learn?: { current?: LearningStore },
): () => void {
  const portfolioVersions = new PortfolioVersionStore(path.join(path.dirname(store.path), 'portfolio-strategy'))
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const sub = url.pathname.slice(API_PREFIX.length) || '/'
      try {
        const denied = accessError(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: '仅接受application/json' })
        await store.load()
        if (personal && (sub === '/personal' || sub.startsWith('/personal/'))) {
          await personal.load()
          if (vault) await vault.load()
          if (req.method === 'GET' && sub === '/personal') {
            // 成长区（只读）：诊断出的下一步 + 状态摘要；失败不拖垮主页。
            let growthPayload: Record<string, unknown> | undefined
            if (growth && personal) {
              try {
                const snap = buildGrowthSnapshot(growth, store, personal, vault)
                const { diagFacts: _diagFacts, ...rest } = snap
                growthPayload = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
              } catch { growthPayload = undefined }
            }
            return sendJson(res, 200, { ok: true, ...personal.get(), metrics: personal.metrics(), pending: confirmations.list(), holdings: store.get().holdings, research: vault?.list({ limit: 8 }) ?? [], reminders: reminders?.list() ?? [], weekTimeZone, ...(growthPayload ? { growth: growthPayload } : {}) })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (sub === '/personal/profile') await personal.profile(body)
            else if (sub === '/personal/thesis') {
              const thesis = personal.thesis(body)
              const before = personal.get().theses.find(t => t.id === thesis.id) ?? null
              return sendJson(res, 200, { ok: true, ...confirmations.propose('保存投资观点', before, thesis, () => personal.get().theses.find(t => t.id === thesis.id) ?? null, () => personal.saveThesis(thesis)) })
            } else if (sub === '/personal/confirm') await confirmations.confirm(String(body.id))
            else if (sub === '/personal/cancel') confirmations.cancel(String(body.id))
            else if (sub === '/personal/prepare') return sendJson(res, 200, { ok: true, cards: await personal.prepare(finance, vault) })
            else if (sub === '/personal/card/makeup') return sendJson(res, 200, { ok: true, ...await personal.requestMakeupCard(String(body.thesisId ?? ''), String(body.reason ?? '')) })
            else if (sub === '/personal/decision') await personal.decide(String(body.id), String(body.action), typeof body.reason === 'string' ? body.reason : '')
            else if (sub === '/personal/job') {
              const action = String(body.action ?? '')
              if (action === 'retry') await personal.retryJob(String(body.key))
              else if (action === 'cancel') await personal.cancelJob(String(body.key))
              else return sendJson(res, 400, { ok: false, error: '无效任务操作（retry/cancel）' })
            }
            else return sendJson(res, 404, { ok: false, error: 'not found' })
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }
        if (req.method === 'GET' && sub === '/follow') {
          // 追踪页只读快照：对象/新鲜度/任务/简报/复刻；失败给结构化错误（不拖垮面板）。
          if (!follow) return sendJson(res, 404, { ok: false, error: '追踪模块未启用' })
          try {
            await follow.load()
            return sendJson(res, 200, { ok: true, ...buildFollowSnapshot(follow) })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && (sub === '/policy' || sub === '/policy/sources')) {
          // 政策页只读快照：列表/筛选/详情/来源。失败给结构化错误，不拖垮面板。
          if (!policy) return sendJson(res, 404, { ok: false, error: '政策模块未启用（config.policy.enabled=false）' })
          try {
            await policy.load()
            if (sub === '/policy/sources') {
              return sendJson(res, 200, {
                ok: true,
                sources: DEFAULT_POLICY_SOURCES.map((s) => ({
                  id: s.id, label: s.label, issuer: s.issuer, kind: s.kind, url: s.url,
                  docType: s.docType, enabled: s.enabled, minIntervalSec: s.minIntervalSec, note: s.note,
                })),
              })
            }
            const id = url.searchParams.get('id')
            if (id) {
              const doc = policy.get(id)
              if (!doc) return sendJson(res, 404, { ok: false, error: '未找到政策' })
              const grade = policyEvidenceLevel(doc)
              return sendJson(res, 200, {
                ok: true,
                doc,
                evidence: { level: grade.level, label: EVIDENCE_LABEL[grade.level], reasons: grade.reasons },
                caveat: citationCaveat(doc),
                untrusted: true,
              })
            }
            const docTypeParam = url.searchParams.get('docType') ?? ''
            const statusParam = url.searchParams.get('status') ?? ''
            const hits = policy.search({
              query: url.searchParams.get('q') ?? undefined,
              issuer: url.searchParams.get('issuer') ?? undefined,
              docType: (POLICY_DOC_TYPES as readonly string[]).includes(docTypeParam) ? (docTypeParam as PolicyDocType) : undefined,
              status: (POLICY_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as PolicyStatus) : undefined,
              from: url.searchParams.get('from') ? isoDay(url.searchParams.get('from')) : undefined,
              to: url.searchParams.get('to') ? isoDay(url.searchParams.get('to')) : undefined,
              limit: Number(url.searchParams.get('limit') ?? '30') || 30,
            })
            return sendJson(res, 200, {
              ok: true,
              stats: policy.stats(),
              store: policy.dir,
              count: hits.length,
              docs: hits.map((h) => {
                const grade = policyEvidenceLevel(h.doc)
                return {
                  id: h.doc.id,
                  title: h.doc.title,
                  issuer: h.doc.issuer,
                  docType: h.doc.docType,
                  status: h.doc.status,
                  legalEffect: h.doc.legalEffect,
                  publishedAt: h.doc.publishedAt,
                  version: h.doc.version,
                  documentNumber: h.doc.documentNumber,
                  canonicalUrl: h.doc.canonicalUrl,
                  sourceId: h.doc.sourceId,
                  parseStatus: h.doc.parseStatus,
                  relatedIndustries: h.doc.relatedIndustries,
                  evidence: grade.level,
                  excerpt: (h.doc.paragraphs[0] ?? h.doc.text).slice(0, 160),
                  score: h.score,
                  matchedTokens: h.tokens.slice(0, 6),
                }
              }),
            })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'GET' && sub === '/evidence') {
          // 研究协作页只读快照 + 单条详情（含全部提交与校验结果）。
          try {
            if (!evidence.repo.isLoaded()) await evidence.repo.load()
            const id = url.searchParams.get('id')
            if (id) {
              const request = evidence.repo.get(id)
              if (!request) return sendJson(res, 404, { ok: false, error: '未找到证据请求' })
              const submissions = evidence.repo.submissionsFor(request.requestId)
              return sendJson(res, 200, { ok: true, request, submissions })
            }
            const status = url.searchParams.get('status') ?? ''
            const items = evidence.repo.list({
              status: (EVIDENCE_REQUEST_STATUSES as readonly string[]).includes(status) ? (status as never) : undefined,
              limit: Number(url.searchParams.get('limit') ?? '50') || 50,
            })
            return sendJson(res, 200, { ok: true, stats: evidence.repo.stats(), count: items.length, requests: items })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'POST' && sub === '/evidence/submit') {
          try {
            const body = await readBody(req)
            const result = await evidence.workflow.submit({
              requestId: String(body.requestId ?? ''),
              ...(body.sourceType ? { sourceType: body.sourceType as never } : {}),
              ...(body.url ? { url: String(body.url) } : {}),
              ...(body.text ? { text: String(body.text) } : {}),
              ...(body.filePath ? { filePath: String(body.filePath) } : {}),
              ...(Array.isArray(body.values) && body.values.length > 0 ? { values: body.values as never } : {}),
              ...(body.documentDate ? { documentDate: String(body.documentDate) } : {}),
              ...(body.reportingPeriod ? { reportingPeriod: String(body.reportingPeriod) } : {}),
              ...(body.units ? { units: String(body.units) } : {}),
              ...(body.note ? { note: String(body.note) } : {}),
            })
            return sendJson(res, 200, { ok: result.validation.ok, requestStatus: result.request.status, validation: result.validation, submissionId: result.submission.submissionId })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'POST' && sub === '/evidence/resolve') {
          try {
            const body = await readBody(req)
            const result = await evidence.workflow.resolve(String(body.requestId ?? ''), String(body.action ?? '') as never, {
              note: body.note ? String(body.note) : undefined,
              humanConfirmed: body.humanConfirmed === true,
            })
            return sendJson(res, 200, { ok: true, requestStatus: result.request.status, validation: result.validation })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'POST' && sub === '/evidence/validate') {
          try {
            const body = await readBody(req)
            const result = await evidence.workflow.validate(String(body.submissionId ?? ''), { humanConfirmed: body.humanConfirmed === true })
            return sendJson(res, 200, { ok: result.validation.ok, requestStatus: result.request.status, validation: result.validation })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'POST' && sub === '/evidence/expire') {
          try {
            const expired = await evidence.workflow.expire()
            return sendJson(res, 200, { ok: true, expired: expired.map((r) => r.requestId) })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (evidence && req.method === 'POST' && sub === '/evidence/resume') {
          try {
            const body = await readBody(req)
            const pkg = await evidence.workflow.resume(String(body.requestId ?? ''))
            return sendJson(res, 200, { ok: true, ...pkg })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (advice?.current && req.method === 'GET' && sub === '/advice') {
          try {
            const store = advice.current
            if (!store.isLoaded()) await store.load()
            const id = url.searchParams.get('id')
            if (id) {
              const item = store.get(id)
              if (!item) return sendJson(res, 404, { ok: false, error: '未找到投资建议' })
              return sendJson(res, 200, { ok: true, advice: item, label: RECOMMENDATION_LABEL[item.recommendation] })
            }
            const status = url.searchParams.get('status') ?? ''
            const items = store.list({
              ...(status === 'open' || status === 'reviewed' ? { status } : {}),
              limit: Number(url.searchParams.get('limit') ?? '40') || 40,
            })
            return sendJson(res, 200, {
              ok: true,
              stats: store.stats(),
              dueForReview: store.all().filter((item) => item.status === 'open' && item.nextReviewAt && item.nextReviewAt <= new Date().toISOString().slice(0, 10)).length,
              count: items.length,
              advices: items.map((item) => ({ ...adviceBrief(item), label: RECOMMENDATION_LABEL[item.recommendation] })),
            })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (capital?.current && req.method === 'GET' && sub === '/capital') {
          // 资本页只读快照：账本是流水，未提供行情/汇率时不假装有未实现收益与总资产。
          try {
            const store = capital.current
            if (!store.isLoaded()) await store.load()
            const events = store.listEvents({ limit: 5000 })
            const state = deriveState(events)
            const accounts = store.listAccounts()
            return sendJson(res, 200, {
              ok: true,
              dir: store.dir,
              accounts,
              events: events.length,
              batches: store.listBatches().slice(0, 5),
              cash: state.cash.map((c) => ({ accountId: c.accountId, currency: c.currency, amount: fromCents(c.cents) })),
              cashByCurrency: Object.fromEntries(Object.entries(state.cashByCurrency).map(([k, v]) => [k, fromCents(v)])),
              positions: state.positions.map((p) => ({
                assetId: p.assetId,
                quantity: p.quantity,
                currency: p.currency,
                cost: fromCents(p.costCents),
                averageCost: fromCents(p.averageCostCents),
              })),
              netInvested: Object.fromEntries(Object.entries(state.netInvestedByCurrency).map(([k, v]) => [k, fromCents(v)])),
              realized: Object.fromEntries(Object.entries(state.realizedByCurrency).map(([k, v]) => [k, fromCents(v)])),
              fees: Object.fromEntries(Object.entries(state.feesByCurrency).map(([k, v]) => [k, fromCents(v)])),
              income: Object.fromEntries(Object.entries(state.incomeByCurrency).map(([k, v]) => [k, fromCents(v)])),
              warnings: state.warnings,
              note: accounts.length === 0
                ? '还没有账户：先在对话里用 capital_account_save 建一个，再用 capital_transaction_add 记流水。'
                : '未提供行情与汇率：这里不显示未实现收益与总资产；需要估值时在对话里用 capital_networth_snapshot 传 prices/fx。',
            })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (wealth?.current && req.method === 'GET' && sub === '/wealth/plans') {
          try {
            const store = wealth.current
            if (!store.isLoaded()) await store.load()
            return sendJson(res, 200, { ok: true, count: store.all().length, plans: store.compare([]) })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (wealth?.current && req.method === 'POST' && (sub === '/wealth/calc' || sub === '/wealth/plans/save')) {
          try {
            const body = await readBody(req)
            const pct = (value: unknown): number => {
              const n = Number(value)
              if (!Number.isFinite(n)) return 0
              return Math.abs(n) > 1 ? n / 100 : n
            }
            const input = {
              principalCents: toCentsSafe(body.principal),
              contributionCents: toCentsSafe(body.contribution),
              frequency: (String(body.frequency ?? 'monthly') as 'monthly' | 'quarterly' | 'annual'),
              timing: (String(body.timing ?? 'end') as 'begin' | 'end'),
              annualRate: pct(body.annualRate),
              annualFee: pct(body.annualFee),
              inflation: pct(body.inflation),
              years: Number(body.years ?? 0),
              contributionGrowth: pct(body.contributionGrowth),
            }
            const result = compound(input)
            const payload = {
              ok: true,
              finalYuan: yuan(result.finalCents),
              finalRealYuan: yuan(result.finalRealCents),
              contributedYuan: yuan(result.contributedCents),
              growthYuan: yuan(result.growthCents),
              netAnnualRate: result.netAnnualRate,
              realRate: result.realRate,
              periodRate: result.periodRate,
              assumptions: result.assumptions,
              rows: result.rows.map((r) => ({
                year: r.year,
                contributedYuan: yuan(r.contributedCents),
                growthYuan: yuan(r.growthCents),
                endYuan: yuan(r.endCents),
                realYuan: yuan(r.realCents),
              })),
            }
            if (sub === '/wealth/calc') return sendJson(res, 200, payload)
            const name = String(body.name ?? '').trim()
            if (!name) return sendJson(res, 400, { ok: false, error: '保存方案需要 name' })
            const plan = await wealth.current.save({
              ...input,
              name,
              ...(body.target !== undefined ? { targetCents: toCentsSafe(body.target) } : {}),
              notes: body.notes ? String(body.notes) : '',
            })
            return sendJson(res, 200, { ...payload, plan })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/learn') {
          // 学习页：概念检索 + 分类 + 学习进度（概念文本全在本地，不依赖外部数据）。
          try {
            const q = url.searchParams.get('q') ?? ''
            const category = url.searchParams.get('category') ?? ''
            const results = searchConcepts(q, {
              ...(Object.keys(CATEGORY_LABEL).includes(category) ? { category: category as ConceptCategory } : {}),
              limit: Number(url.searchParams.get('limit') ?? '20') || 20,
            })
            let progress: unknown = undefined
            if (learn?.current) {
              if (!learn.current.isLoaded()) await learn.current.load()
              progress = learn.current.stats()
            }
            return sendJson(res, 200, {
              ok: true,
              categories: categorySummary(),
              progress,
              count: results.length,
              concepts: results.map((c) => ({
                conceptId: c.conceptId,
                name: c.name,
                category: c.category,
                categoryLabel: CATEGORY_LABEL[c.category],
                aliases: c.aliases.slice(0, 6),
                beginner: c.beginner,
              })),
            })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/learn/concept') {
          try {
            const id = url.searchParams.get('id') ?? ''
            const level = (url.searchParams.get('level') ?? 'beginner') as ExplainLevel
            const result = explainConcept(id, level, {
              page: url.searchParams.get('page') ?? undefined,
              value: url.searchParams.get('value') ?? undefined,
              period: url.searchParams.get('period') ?? undefined,
              asset: url.searchParams.get('asset') ?? undefined,
            })
            if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error })
            let state: unknown = undefined
            if (learn?.current) {
              if (!learn.current.isLoaded()) await learn.current.load()
              state = await learn.current.touch(result.explanation.concept.conceptId)
            }
            return sendJson(res, 200, { ok: true, ...result.explanation, levelLabel: LEVEL_LABEL[result.explanation.level], state })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (learn?.current && req.method === 'POST' && sub === '/learn/state') {
          try {
            const body = await readBody(req)
            if (!learn.current.isLoaded()) await learn.current.load()
            const state = await learn.current.setStatus(
              String(body.conceptId ?? ''),
              String(body.status ?? 'seen') as LearnStatus,
              body.on !== false,
            )
            return sendJson(res, 200, { ok: true, state, stats: learn.current.stats() })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write('retry: 2000\n\n')
          res.write(': connected\n\n')
          // Reconnect catch-up: the browser sends `Last-Event-ID` automatically
          // after receiving `id:` fields; `?since=` supports explicit cursors.
          const lastEventId = req.headers['last-event-id']
          const since = url.searchParams.get('since') ?? (typeof lastEventId === 'string' ? lastEventId : undefined)
          const write = <T extends { epoch: string; seq: number }>(envelope: T) => {
            try {
              res.write(`id: ${envelope.epoch}:${envelope.seq}\n`)
              res.write(`data: ${JSON.stringify(envelope)}\n\n`)
            } catch { /* client already gone; close handler cleans up */ }
          }
          const subscription = bus.subscribe((envelope) => write(envelope), {
            since,
            onGap: () => write({
              v: 1,
              epoch: bus.epoch,
              seq: 0,
              emittedAt: new Date().toISOString(),
              event: { kind: '__resync', reason: 'gap' },
            }),
          })
          const beat = setInterval(() => {
            try {
              res.write(': ping\n\n')
            } catch { /* ignore */ }
          }, SSE_HEARTBEAT_MS)
          req.on('close', () => {
            clearInterval(beat)
            subscription.close()
          })
          return
        }
        if (req.method === 'POST' && sub === '/panel-focus') {
          // 面板 → Agent：上报用户当前所看（best-effort，内存态），panel_state 工具读取。
          const body = await readBody(req)
          try {
            return sendJson(res, 200, { ok: true, focus: setPanelFocus(body) })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && (sub === '/state' || sub === '/')) {
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { holdings, watchlist, portfolioPath: store.path })
        }
        if (req.method === 'GET' && sub === '/mcp') {
          return sendJson(res, 200, { sources: mcp?.status() ?? [] })
        }
        if (req.method === 'GET' && sub === '/westock') {
          return sendJson(res, 200, await finance.getWestockStatus())
        }
        if (req.method === 'GET' && sub === '/westock/capabilities') {
          return sendJson(res, 200, { ok: true, items: westockCapabilityCatalog() })
        }
        // 通用 WeStock 调用：{ capability, args } 或 { argv } —— 目录外子命令的兜底入口。
        if (req.method === 'POST' && sub === '/westock/call') {
          const body = await readBody(req)
          if (Array.isArray(body.argv) && body.argv.length) {
            const raw = await finance.westockRaw(body.argv as string[])
            return sendJson(res, 200, raw)
          }
          const capability = String(body.capability ?? '').trim()
          if (!capability) return sendJson(res, 400, { ok: false, error: '需要 capability 或 argv' })
          const result = await finance.westock(capability, (body.args ?? {}) as Record<string, unknown>)
          return sendJson(res, 200, result)
        }
        // 市场发现：涨跌分布 + 热搜股票/板块 + 龙虎榜（任一失败不影响其他）。
        if (req.method === 'GET' && sub === '/discover') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10), 1), 50)
          type Maybe = { ok: boolean; data?: unknown; error?: string }
          const fail = (err: unknown): Maybe => ({ ok: false, error: err instanceof Error ? err.message : String(err) })
          const [breadth, hotStocks, hotSectors, lhb] = await Promise.all([
            finance.getMarketBreadth().catch(fail) as Promise<Maybe>,
            finance.getHotRank('stock', limit).catch(fail) as Promise<Maybe>,
            finance.getHotRank('sector', limit).catch(fail) as Promise<Maybe>,
            finance.westock('market_lhb', { type: 'institution' }).catch(fail) as Promise<Maybe>,
          ])
          return sendJson(res, 200, {
            ok: true,
            at: new Date().toISOString(),
            breadth: breadth.ok ? breadth.data : { error: breadth.error },
            hotStocks: hotStocks.ok ? hotStocks.data : { error: hotStocks.error },
            hotSectors: hotSectors.ok ? hotSectors.data : { error: hotSectors.error },
            lhb: lhb.ok ? ((lhb.data as unknown[]) ?? []).slice(0, limit) : { error: lhb.error },
          })
        }
        if (req.method === 'GET' && sub === '/logs') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500)
          const level = url.searchParams.get('level') ?? undefined
          const entries = (await logger?.recent(limit, level as never)) ?? []
          return sendJson(res, 200, { ok: true, file: logger?.filePath, count: entries.length, entries })
        }
        // ---- 投研资料库 (Research Vault) ----
        if (vault && req.method === 'GET' && sub === '/research') {
          const id = url.searchParams.get('id')
          if (id) {
            const item = vault.find(id)
            if (!item) return sendJson(res, 404, { ok: false, error: `资料不存在：${id}` })
            const doc = await vault.readDoc(item)
            const payload: Record<string, unknown> = {
              ok: true,
              path: `${vault.dir}/${item.file}`,
              file: item.file,
              item,
              body: doc.body,
              notes: doc.notes,
              exists: doc.exists,
              mtime: doc.mtime,
              watching: vault.isWatching(),
            }
            // `raw=1` 给面板的「原文」视图：磁盘上真实的文件内容（含 frontmatter）。
            if (url.searchParams.get('raw') === '1') payload.raw = doc.raw
            return sendJson(res, 200, payload)
          }
          const items = vault.list({
            kind: (url.searchParams.get('kind') ?? undefined) as ResearchKind | undefined,
            status: (url.searchParams.get('status') ?? undefined) as ResearchStatus | undefined,
            code: url.searchParams.get('code') ?? undefined,
            tag: url.searchParams.get('tag') ?? undefined,
            query: url.searchParams.get('query') ?? undefined,
            limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200),
          })
          return sendJson(res, 200, {
            ok: true,
            vault: vault.dir,
            count: items.length,
            stats: vault.stats(),
            watching: vault.isWatching(),
            items,
          })
        }
        if (vault && req.method === 'POST' && sub === '/research') {
          const body = await readBody(req)
          try {
            const item = await vault.create({
              title: String(body.title ?? ''),
              source: String(body.source ?? ''),
              occurredAt: String(body.date ?? ''),
              kind: (body.kind ?? 'other') as ResearchKind,
              codes: Array.isArray(body.codes) ? body.codes.map(String) : undefined,
              tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
              summary: body.summary ? String(body.summary) : undefined,
              opinion: body.opinion ? String(body.opinion) : undefined,
              body: body.body ? String(body.body) : undefined,
              sourceUrl: body.url ? String(body.url) : undefined,
              status: (body.status ?? 'inbox') as ResearchStatus,
              origin: 'panel',
            })
            bus.publish({ kind: 'research', action: 'save', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, vault: vault.dir, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        // 反向同步：把磁盘上的新增/编辑/删除合并回索引（宿主文件工具改的文件也认）。
        if (vault && req.method === 'POST' && sub === '/research/sync') {
          const result = await vault.syncFromDisk()
          if (result.added || result.updated || result.missing) bus.publish({ kind: 'research', action: 'sync', id: '', origin: 'panel' })
          return sendJson(res, 200, { ok: true, vault: vault.dir, ...result, stats: vault.stats() })
        }
        // 清理：索引里文件已被外部删除的条目。
        if (vault && req.method === 'POST' && sub === '/research/prune') {
          const removed = await vault.pruneMissing()
          if (removed) bus.publish({ kind: 'research', action: 'sync', id: '', origin: 'panel' })
          return sendJson(res, 200, { ok: true, vault: vault.dir, removed, stats: vault.stats() })
        }
        // 面板编辑正文 → 直接写回工作区 Markdown（只改正文，frontmatter/批注保留）。
        if (vault && req.method === 'POST' && sub === '/research/body') {
          const body = await readBody(req)
          try {
            const item = await vault.writeBody(String(body.id ?? ''), String(body.body ?? ''))
            bus.publish({ kind: 'research', action: 'update', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, path: `${vault.dir}/${item.file}`, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/update') {
          const body = await readBody(req)
          try {
            const item = await vault.update(String(body.id ?? ''), {
              ...(body.title ? { title: String(body.title) } : {}),
              ...(body.summary !== undefined ? { summary: String(body.summary) } : {}),
              ...(body.opinion !== undefined ? { opinion: String(body.opinion) } : {}),
              ...(body.codes !== undefined ? { codes: (body.codes as unknown[]).map(String) } : {}),
              ...(body.tags !== undefined ? { tags: (body.tags as unknown[]).map(String) } : {}),
              ...(body.status ? { status: String(body.status) as ResearchStatus } : {}),
              ...(body.kind ? { kind: String(body.kind) as ResearchKind } : {}),
            })
            bus.publish({ kind: 'research', action: 'update', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            if (err instanceof ResearchConfirmationRequired) return sendJson(res, 202, { ok: true, ...err.preview })
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/note') {
          const body = await readBody(req)
          try {
            const item = await vault.addNote(String(body.id ?? ''), String(body.note ?? ''), body.author ? String(body.author) : '我')
            bus.publish({ kind: 'research', action: 'note', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/archive') {
          const body = await readBody(req)
          try {
            const item = await vault.setStatus(String(body.id ?? ''), body.restore === true ? 'active' : 'archived')
            bus.publish({ kind: 'research', action: body.restore === true ? 'restore' : 'archive', id: item.id, title: item.title, origin: 'panel' })
            return sendJson(res, 200, { ok: true, item })
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (vault && req.method === 'POST' && sub === '/research/delete') {
          const body = await readBody(req)
          const removed = await vault.remove(String(body.id ?? ''))
          if (removed) bus.publish({ kind: 'research', action: 'archive', id: String(body.id ?? ''), origin: 'panel' })
          return sendJson(res, 200, { ok: removed })
        }
        if (vault && req.method === 'POST' && sub === '/research/collect') {
          const body = await readBody(req)
          const result = await collectResearch(finance, vault, {
            code: String(body.code ?? '').trim(),
            kind: body.kind === 'news' ? 'news' : 'report',
            size: Number(body.size ?? 5),
            withBody: body.withBody === true,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            status: (body.status ?? 'inbox') as ResearchStatus,
            origin: 'panel',
          })
          if (result.items.length) {
            bus.publish({
              kind: 'research',
              action: 'collect',
              id: result.items[0]!.id,
              title: result.items.length === 1 ? result.items[0]!.title : `${result.items.length} 条 ${result.code} 资料`,
              count: result.items.length,
              origin: 'panel',
            })
          }
          return sendJson(res, 200, result)
        }
        if (req.method === 'GET' && sub === '/providers') {
          return sendJson(res, 200, { catalog: withCapMeta(finance.getProviderCatalog()) })
        }
        if (skills && req.method === 'GET' && sub === '/skills') {
          return sendJson(res, 200, skills.catalog())
        }
        if (skills && req.method === 'POST' && sub === '/skills') {
          const body = await readBody(req)
          const local = Array.isArray(body.local) ? (body.local as string[]) : undefined
          const yingmi = Array.isArray(body.yingmi) ? (body.yingmi as string[]) : undefined
          const result = await skills.setEnabled(local, yingmi)
          bus.publish({ kind: 'skills' })
          return sendJson(res, 200, { ok: true, ...result })
        }
        if (history && req.method === 'GET' && sub === '/history/list') {
          return sendJson(res, 200, { symbols: await history.list() })
        }
        if (history && req.method === 'GET' && sub === '/history') {
          const code = validateCode(url.searchParams.get('code') ?? '')
          // 基金与个股共用 6 位 code 空间：必须按显式 kind 读取，不能按最近更新时间猜。
          const kindParam = url.searchParams.get('kind')
          try {
            const kind = kindParam === null ? undefined : validateMarketKind(kindParam) as SymbolKind
            const h = await history.read(code, kind)
            if (!h) return sendJson(res, 200, { ok: false, code, kind: kind ?? null, error: 'no local history' })
            return sendJson(res, 200, { ok: true, ...h })
          } catch (err) {
            return sendJson(res, 400, { ok: false, code, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (history && req.method === 'GET' && sub === '/history/manifest') {
          const code = validateCode(url.searchParams.get('code') ?? '')
          const kindParam = url.searchParams.get('kind')
          try {
            const kind = kindParam === null ? undefined : validateMarketKind(kindParam) as SymbolKind
            const m = await history.manifest(code, kind)
            if (!m) return sendJson(res, 404, { ok: false, code, error: 'no local history' })
            return sendJson(res, 200, { ok: true, manifest: m })
          } catch (err) {
            return sendJson(res, 400, { ok: false, code, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/strategy/versions') {
          return sendJson(res, 200, { ok: true, entries: await portfolioVersions.list() })
        }
        if (req.method === 'POST' && sub === '/strategy/versions') {
          const body = await readBody(req)
          const entry = await portfolioVersions.save(body as never)
          return sendJson(res, 200, { ok: true, entry })
        }
        if (req.method === 'POST' && sub === '/strategy/transition') {
          const body = await readBody(req)
          if (body.userConfirmed !== true) return sendJson(res, 400, {ok:false,error:'须在面板明确确认纸面策略状态变更'})
          if (body.action === 'approve') {
            const draft = await portfolioVersions.get(String(body.id ?? ''))
            if (!draft) return sendJson(res, 404, { ok: false, error: '未找到该组合版本' })
            const asOf = Date.parse(`${draft.policy.asOf}T00:00:00Z`)
            const ageDays = (Date.now() - asOf) / 86_400_000
            if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 7) {
              return sendJson(res, 400, { ok: false, error: '批准前的核验已超过7天或日期异常：请以今天的行情/证据重新保存新版本再批准。旧快照不能当当前核验。' })
            }
          }
          const entry = await portfolioVersions.transition({ ...body, actor: 'user' } as never)
          return sendJson(res, 200, {ok:true,entry})
        }
        if (req.method === 'POST' && sub === '/strategy/import') {
          const body = await readBody(req)
          return sendJson(res, 200, await importPortfolioSnapshot(store, finance, body.authorized === true))
        }
        if (req.method === 'POST' && sub === '/strategy/verify') {
          const body = await readBody(req)
          return sendJson(res, 200, verifyPortfolioData(body as unknown as PortfolioVerificationInput))
        }
        if (req.method === 'POST' && sub === '/strategy/backtest') {
          const body = await readBody(req)
          return sendJson(res, 200, runPortfolioBacktest(body as never))
        }
        if (req.method === 'POST' && sub === '/strategy/experiment') {
          const body = await readBody(req)
          return sendJson(res, 200, await fetchStrategyExperiment(String(body.code ?? ''), body.initialCash === undefined ? 100000 : Number(body.initialCash)))
        }
        if (history && req.method === 'POST' && sub === '/history/sync') {
          const body = await readBody(req)
          const code = validateCode(body.code)
          const kind = validateMarketKind(body.kind ?? 'a') as SymbolKind
          const since = typeof body.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.since) ? body.since : undefined
          const result = await syncHistory(finance, history, code, kind, undefined, { ...(since ? { since } : {}) })
          bus.publish({ kind: 'history', code, bars: result.bars, addedBars: result.addedBars })
          return sendJson(res, 200, result)
        }
        if (history && req.method === 'POST' && sub === '/history/event') {
          const body = await readBody(req)
          const code = validateCode(body.code)
          const date = validateDate(body.date, 'date')
          const kind = validateMarketKind(body.kind ?? 'a') as SymbolKind
          const added = await history.mergeEvents(code, kind, [{ date, type: String(body.type ?? '自定义'), label: String(body.label ?? ''), value: typeof body.value === 'number' ? body.value : undefined }])
          return sendJson(res, 200, { ok: true, added })
        }
        if (req.method === 'POST' && sub === '/providers') {
          const body = await readBody(req)
          const policy = (body.policy ?? {}) as Record<string, string[]>
          const catalog = await finance.setProviderPolicy(policy)
          bus.publish({ kind: 'providers' })
          return sendJson(res, 200, { ok: true, catalog: withCapMeta(catalog) })
        }
        if (req.method === 'POST' && sub === '/mcp/token') {
          if (!mcp) return sendJson(res, 400, { ok: false, error: 'mcp disabled' })
          const body = await readBody(req)
          const name = String(body.name ?? '').trim()
          if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' })
          await mcp.setToken(name, String(body.token ?? ''))
          bus.publish({ kind: 'mcp' })
          return sendJson(res, 200, { ok: true, sources: mcp.status() })
        }
        if (req.method === 'GET' && sub === '/live') {
          const snapshot = await buildLiveSnapshot(finance, snapshotItems(store))
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { ...snapshot, holdings, watchlist, portfolioPath: store.path })
        }
        // 批量行情：面板/客户端一次拿多个标的（WeStock 一次 CLI 调用）。
        if (req.method === 'GET' && sub === '/quotes') {
          const codes = (url.searchParams.get('codes') ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
          if (!codes.length) return sendJson(res, 400, { ok: false, error: 'codes is required' })
          const r = await finance.getQuotes(codes)
          return sendJson(res, 200, {
            ok: r.ok,
            provider: r.provider,
            quotes: r.ok && Array.isArray(r.data) ? r.data : [],
            error: r.ok ? undefined : r.error,
          })
        }
        // 缓存/耗时统计：慢在哪一源、命中率如何，面板「接口」页展示。
        if (req.method === 'GET' && sub === '/stats') {
          const westock = await finance.getWestockStatus().catch(() => undefined)
          return sendJson(res, 200, { ok: true, stats: finance.getStats(), westock })
        }
        if (req.method === 'GET' && sub === '/search') {
          const q = (url.searchParams.get('q') ?? '').trim()
          const rawLimit = Number(url.searchParams.get('limit') ?? 30)
          const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 30
          const r = await finance.searchSymbol(q, undefined, limit)
          const matches = r.ok && Array.isArray(r.data) ? r.data.slice(0, limit) : []
          return sendJson(res, 200, { ok: r.ok, matches, limit, count: matches.length, provider: r.provider, error: r.ok ? undefined : r.error, note: '来源匹配候选，非全市场完整清单；名称/代码/市场须由用户确认。' })
        }
        if (req.method === 'GET' && sub === '/macro') {
          const series = ['cpi', 'ppi', 'pmi', 'gdp', 'money_supply']
          const out = await Promise.all(series.map(async (s) => {
            const r = await finance.getMacro(s)
            return r.ok ? r.data : { series: s, error: r.error }
          }))
          return sendJson(res, 200, { at: new Date().toISOString(), series: out })
        }
        // 全球宏观（OECD SDMX / Eurostat / World Bank / ECB data-api）：与工具 get_macro_global
        // 共用 finance.getMacroGlobal；asOf 是统计期，fetchedAt 是抓取时间，失败序列带 error。
        if (req.method === 'GET' && sub === '/macro/global') {
          const requested = (url.searchParams.get('series') ?? '')
            .split(/[,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
          const rawLimit = url.searchParams.get('limit')
          const limit = rawLimit === null ? undefined : Number(rawLimit)
          const report = await finance.getMacroGlobal(requested.length ? requested : undefined, undefined, limit)
          return sendJson(res, 200, report)
        }
        // 全球主要指数（东财 push2）：默认美国，region=us|asia|europe|china|all。
        // at 是抓取时间，行内 asOf 是源侧行情时间；字段缺失 null、不补 0；单行失败不拖垮整体。
        if (req.method === 'GET' && sub === '/global-indices') {
          const rawRegion = (url.searchParams.get('region') ?? '').trim()
          const region = normalizeGlobalRegion(rawRegion || 'us')
          if (!region) {
            return sendJson(res, 400, {
              ok: false, at: new Date().toISOString(), region: null, rows: [], cacheHits: 0, failed: 0,
              error: `未知区域：${rawRegion}；可选 us/asia/europe/china/all`,
            })
          }
          const report = await finance.getGlobalIndices(region)
          return sendJson(res, 200, report)
        }
        // 中国免费数据集（AKShare 桥）：列表 + 健康状态，以及按数据集取数。
        if (req.method === 'GET' && sub === '/cn-datasets') {
          try {
            const datasets = await listCnDatasets()
            const health = await checkCnBridge()
            return sendJson(res, 200, { ok: true, bridge: health, datasets })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err), datasets: [] })
          }
        }
        if (req.method === 'GET' && sub === '/cn-dataset') {
          const dataset = url.searchParams.get('dataset') ?? ''
          let params: Record<string, string | number> | undefined
          const rawParams = url.searchParams.get('params')
          if (rawParams) {
            try { params = JSON.parse(rawParams) as Record<string, string | number> } catch { return sendJson(res, 400, { ok: false, error: 'params 不是合法 JSON' }) }
          }
          const limit = Number(url.searchParams.get('limit') ?? '0') || undefined
          const result = await fetchCnDataset(dataset, { params, ...(limit ? { limit } : {}) })
          return sendJson(res, result.ok ? 200 : 400, result)
        }
        // 海外个股/指数行情与K线：仅按真实 secid 请求，不按代码位数猜市场。
        if (req.method === 'GET' && sub === '/global/quote') {
          const result = await fetchGlobalQuote(url.searchParams.get('secid') ?? '')
          return sendJson(res, result.ok ? 200 : 400, result)
        }
        if (req.method === 'GET' && sub === '/global/kline') {
          const result = await fetchGlobalKline(
            url.searchParams.get('secid') ?? '',
            url.searchParams.get('limit') ?? undefined,
          )
          return sendJson(res, result.ok ? 200 : 400, result)
        }
        if (req.method === 'GET' && sub === '/fundrank') {
          const fundType = url.searchParams.get('type') ?? 'all'
          const size = Number(url.searchParams.get('size') ?? 20)
          const sort = url.searchParams.get('sort') ?? undefined
          const page = Number(url.searchParams.get('page') ?? 1)
          const r = await finance.getFundRank(fundType, size, sort, page)
          return sendJson(res, 200, { ok: r.ok, rows: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
        }
        // P2 穿透体检：直投 + 基金前N大重仓 → 真实股票暴露（面板持仓页展示）。
        if (req.method === 'GET' && sub === '/lookthrough') {
          const topN = Number(url.searchParams.get('topN') ?? 10)
          try {
            const r = await buildLookthrough(finance, { topN })
            return sendJson(res, 200, { ok: true, ...r })
          } catch (err) {
            return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'GET' && sub === '/market') {
          const [gain, lose] = await Promise.all([finance.getSectorBoard('desc'), finance.getSectorBoard('asc')])
          const snapshot = await buildLiveSnapshot(finance, [])
          const pctOf = (r: unknown): number => {
            const o = (r ?? {}) as Record<string, unknown>
            return Number(o.changePct ?? o.changePercent ?? o.zdf ?? NaN)
          }
          // 兜底：某些 provider 会忽略 order 参数（两个榜返回同一份数据），
          // 这里按涨跌幅自行排序，保证「领跌 = 真的在跌」。
          const sortByPct = (rows: unknown[], dir: 'desc' | 'asc') => [...rows]
            .sort((a, b) => (dir === 'desc' ? pctOf(b) - pctOf(a) : pctOf(a) - pctOf(b)))
          const g = gain.ok && Array.isArray(gain.data) ? gain.data as unknown[] : []
          const l = lose.ok && Array.isArray(lose.data) ? lose.data as unknown[] : []
          const gainers = sortByPct(g, 'desc').slice(0, 10)
          const losers = sortByPct(l.length ? l : g, 'asc').slice(0, 10)
          return sendJson(res, 200, {
            at: new Date().toISOString(),
            indices: snapshot.indices,
            gainers,
            losers,
          })
        }
        if (req.method === 'GET' && sub === '/news') {
          const code = url.searchParams.get('code')
          if (code) {
            const r = await finance.getStockNews(code, 10)
            return sendJson(res, 200, { ok: r.ok, code, news: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
          }
          const r = await finance.getNewsFlash(25)
          return sendJson(res, 200, { ok: r.ok, news: r.ok && Array.isArray(r.data) ? r.data : [], error: r.ok ? undefined : r.error })
        }
        // 全球市场新闻雷达：只抓已核实的官方源，重要性是覆盖范围内的相对分数，不是因果判断。
        if (req.method === 'GET' && sub === '/news/radar') {
          const rawHours = Number(url.searchParams.get('hours') ?? '168')
          const hours = Number.isFinite(rawHours) ? Math.min(720, Math.max(1, Math.trunc(rawHours))) : 168
          const rawLimit = Number(url.searchParams.get('limit') ?? '12')
          const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 12
          const keywords = (url.searchParams.get('keywords') ?? '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 20)
          try {
            const run = await fetchAndBuildGlobalNewsRadar({
              now: new Date().toISOString(),
              windowHours: hours,
              maxItems: limit,
              ...(keywords.length ? { relevance: { keywords, label: '持仓/自选' } } : {}),
            })
            return sendJson(res, 200, {
              ok: true,
              fetchedAt: run.radar.generatedAt,
              hours,
              items: run.radar.items.map(item => ({
                id: item.id,
                title: item.title,
                url: item.link ?? undefined,
                source: item.sourceName,
                sourceId: item.sourceId,
                authority: item.authority,
                eventType: item.eventType,
                publishedAt: item.publishedAt ?? undefined,
                score: item.score.total,
                scoreComponents: item.score.components,
                reasons: item.score.reasons,
                eventReason: item.eventReason,
              })),
              stats: run.radar.stats,
              feedDiagnostics: run.radar.feedDiagnostics,
              disclaimer: run.radar.disclaimer,
            })
          } catch (err) {
            return sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err), items: [] })
          }
        }
        // 基金净值走势：用于基金详情页画净值曲线（不是实时成交价，日期即净值日）。
        if (req.method === 'GET' && sub === '/fund/kline') {
          const code = validateCode(url.searchParams.get('code') ?? '')
          const r = await finance.getFundKline(code)
          const rows = r.ok && Array.isArray(r.data) ? r.data as unknown as Array<Record<string, unknown>> : []
          return sendJson(res, 200, {
            ok: r.ok,
            code,
            provider: r.provider,
            series: rows.map(row => ({ date: String(row.date ?? row.time ?? ''), nav: typeof row.nav === 'number' ? row.nav : typeof row.close === 'number' ? row.close : null })),
            error: r.ok ? undefined : r.error,
          })
        }
        // 个股深度档案：一次并发取回该标的在 WeStock 上的全部维度（研究/资金/股东/风险/资讯/产业链）。
        // type=fund 走基金专属档案（股票 18 维对基金大多 unsupported/噪音）。
        if (req.method === 'GET' && sub === '/dossier') {
          const code = validateCode(url.searchParams.get('code') ?? '')
          const type = validateAssetType(url.searchParams.get('type') ?? 'stock')
          const d = type === 'fund'
            ? await buildFundDossier(finance, code)
            : await buildStockDossier(finance, code, type)
          return sendJson(res, 200, { ok: true, summary: dossierSummary(d, type === 'fund' ? '基金深度档案' : '个股深度档案'), ...d })
        }
        if (req.method === 'GET' && sub === '/analysis') {
          const code = validateCode(url.searchParams.get('code') ?? '')
          const type = validateAssetType(url.searchParams.get('type') ?? 'stock')
          const analysis = analyses.get(code, type)
          return sendJson(res, 200, { ok: true, found: Boolean(analysis), analysis })
        }
        if (req.method === 'POST' && sub === '/analysis') {
          const body = await readBody(req)
          const code = validateCode(body.code)
          const type = validateAssetType(body.type ?? 'stock')
          const force = body.force === true
          const key = `${type}:${code}`
          const cached = analyses.get(code, type)
          if (cached && !force) return sendJson(res, 200, { ok: true, status: 'cached', analysis: cached })
          const holding = store.get().holdings.find((h) => h.code === code && h.type === type)
          // 持仓/成本与既往私人判断只在本次请求显式授权时才注入；默认按独立标的处理。
          const portfolioAuthorized = body.portfolioAuthorized === true
          const generated = await analysisPrompt(code, type, holding, vault, personal, analyses, finance, portfolioAuthorized)
          return sendJson(res, 200, { ok: true, status: 'prompt', prompt: generated.prompt, refs: generated.refs, portfolioAuthorized })
        }

        // ---- 观点触发式提醒 ----
        if (reminders && req.method === 'GET' && sub === '/reminders') {
          await reminders.load()
          return sendJson(res, 200, { ok: true, items: reminders.list(), unread: reminders.unread() })
        }
        if (reminders && req.method === 'POST' && sub === '/reminders/read') {
          const body = await readBody(req)
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined
          const n = await reminders.markRead(ids)
          bus.publish({ kind: 'reminder', count: reminders.unread(), at: new Date().toISOString() })
          return sendJson(res, 200, { ok: true, read: n, unread: reminders.unread() })
        }
        if (scan && req.method === 'POST' && sub === '/reminders/check') {
          const body = await readBody(req)
          const options: ReminderOptions = {}
          if (typeof body.movePct === 'number') options.movePct = body.movePct
          if (typeof body.opinionPct === 'number') options.opinionPct = body.opinionPct
          const result = await scan(options)
          if (result.added.length) {
            bus.publish({ kind: 'reminder', count: result.added.length, at: result.at })
          }
          return sendJson(res, 200, { ok: true, ...result, unread: reminders?.unread() ?? 0 })
        }
        if (req.method === 'POST' && sub === '/mutate') {
          const body = await readBody(req)
          const action = String(body.action ?? '')
          const p = (body.payload ?? {}) as Record<string, unknown>
          const code = String(p.code ?? '').trim()
          const type = normType(p.type)
          if (action === 'upsertHolding' && code) {
            return sendJson(res, 200, { ok: true, ...store.previewHolding({ code, name: p.name ? String(p.name) : undefined, quantity: Number(p.quantity), avgCost: Number(p.avgCost), type }) })
          } else if (action === 'removeHolding' && code) {
            return sendJson(res, 200, { ok: true, ...store.previewRemoveHolding(code, p.type ? type : undefined) })
          } else if (action === 'addWatch' && code) {
            await store.addWatch({ code, name: p.name ? String(p.name) : undefined, type })
          } else if (action === 'removeWatch' && code) {
            await store.removeWatch(code, p.type ? type : undefined)
          } else {
            return sendJson(res, 400, { ok: false, error: `bad action ${action}` })
          }
          const { holdings, watchlist } = store.get()
          return sendJson(res, 200, { ok: true, holdings, watchlist })
        }
        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        // Previously silent: a failing route left no trace anywhere.
        logger?.fail(`route ${req.method} ${sub} failed`, err)
        if (err instanceof ValidationError) {
          return sendJson(res, err.httpStatus, { ok: false, error: err.message, issues: err.issues })
        }
        return sendJson(res, err instanceof RequestError ? err.status : 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
}
