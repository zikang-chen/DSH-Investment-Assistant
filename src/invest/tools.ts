/**
 * Investment advice tools.
 *
 * The model assembles the analysis; these tools enforce the evidence contract and
 * persist the result. When the model cannot meet the contract, it gets the exact
 * list of violations back and must fix the analysis (or answer
 * INSUFFICIENT_DATA) — it cannot save a half-supported "buy".
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Logger } from '../log.js'
import type { PolicyStore } from '../policy/store.js'
import type { ResearchVault } from '../research/store.js'
import type { EvidenceRepository } from '../evidence/repository.js'
import { AdviceStore, adviceBrief } from './store.js'
import { verifyAdvice } from './verify.js'
import {
  HORIZONS,
  MARKETS,
  RECOMMENDATIONS,
  EVIDENCE_KINDS,
  RECOMMENDATION_LABEL,
  normalizeEvidence,
  type AdviceInput,
  type Horizon,
  type Market,
  type Recommendation,
} from './schema.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

function strList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;；\n]+/) : []
  return [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))]
}

function parseJsonArray(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (!Array.isArray(parsed)) throw new Error('not array')
    return parsed
  } catch {
    throw new Error(`${field} 必须是 JSON 数组`)
  }
}

export interface InvestmentToolDeps {
  store: AdviceStore
  logger?: Logger
  /** Optional cross-checks for evidence refs. */
  policy?: PolicyStore
  vault?: ResearchVault
  evidence?: EvidenceRepository
  /** 行情服务：用于「历史建议验证」自动取收盘价（失败就报不可用，不猜）。 */
  finance?: {
    getKline: (code: string, period?: string, start?: string, end?: string) => Promise<{ ok: boolean; data?: Array<{ date: string; close: number }>; error?: string }>
    getUsKline?: (code: string, period?: string, start?: string, end?: string) => Promise<{ ok: boolean; data?: Array<{ date: string; close: number }>; error?: string }>
  }
  /** Panel refresh + due-review push (best-effort). */
  bus?: { publish: (event: { kind: 'investment'; action: 'save' | 'review'; adviceId: string; recommendation?: string; at: string }) => void }
}

export function registerInvestmentTools(ctx: Context, deps: InvestmentToolDeps): void {
  const ensure = async (): Promise<void> => {
    if (!deps.store.isLoaded()) await deps.store.load()
  }
  const notify = (action: 'save' | 'review', adviceId: string, recommendation?: string): void => {
    try {
      deps.bus?.publish({ kind: 'investment', action, adviceId, ...(recommendation ? { recommendation } : {}), at: new Date().toISOString() })
    } catch { /* bus is best-effort */ }
  }

  ctx.tools.register(defineTool({
    name: 'investment_advice_generate',
    description: '保存一条投资建议（结构化）。硬性要求：方向性建议必须同时给出「支持证据」「反对证据」「失效条件」，每条证据要有来源与数据日期；证据不足时用 INSUFFICIENT_DATA 并列出缺什么，且不得给行动方案。价格区间必须引用计算方法。不执行任何真实交易。',
    parameters: {
      userPrompt: { type: 'string', required: true, description: '用户的原始问题' },
      assets: { type: 'string', required: true, description: '标的/行业，逗号分隔（600519/AAPL/黄金/新能源）' },
      market: { type: 'string', required: true, enum: [...MARKETS] },
      horizon: { type: 'string', required: true, enum: [...HORIZONS] },
      recommendation: { type: 'string', required: true, enum: [...RECOMMENDATIONS] },
      dataFreshnessStatus: { type: 'string', required: true, enum: ['fresh', 'stale', 'unknown'], description: '行情/数据时效' },
      dataFreshnessAsOf: { type: 'string', required: true, description: '数据日期 YYYY-MM-DD' },
      dataFreshnessNote: { type: 'string', description: '时效说明（如「收盘价，T+0」）' },
      investmentGoal: { type: 'string' },
      recommendationConditions: { type: 'string', description: '建议成立的条件，分号分隔' },
      rationale: { type: 'string', description: '为什么（通俗中文），分号分隔' },
      supporting: { type: 'string', description: 'JSON 数组：[{kind,claim,source,asOf,ref?}]' },
      contradicting: { type: 'string', description: 'JSON 数组（必须非空）：反对证据' },
      invalidationConditions: { type: 'string', description: '判断失效条件，分号分隔' },
      marketSnapshot: { type: 'string', description: 'JSON 数组：[{asOf,note}]' },
      valuationSummary: { type: 'string', description: '估值摘要（PE/PB/股息率/历史分位）' },
      portfolioContextUsed: { type: 'boolean', description: '是否使用了用户持仓（需授权）' },
      riskConstraints: { type: 'string', description: '最大回撤/仓位上限/流动性要求，分号分隔' },
      scenarioAssumptions: { type: 'string', description: '情景假设，分号分隔' },
      proposedActionSummary: { type: 'string', description: '行动方案摘要（证据不足时必须留空）' },
      proposedActionConditions: { type: 'string' },
      priceZoneLow: { type: 'number', description: '观察区间下沿（必须配 calculationRefs）' },
      priceZoneHigh: { type: 'number' },
      priceZoneBasis: { type: 'string', description: '区间计算依据' },
      calculationRefs: { type: 'string', description: '计算方法引用（如 calculate_technical_indicators / simulate_rebalance）' },
      nextReviewAt: { type: 'string', description: '下次复核日期 YYYY-MM-DD' },
      unresolvedQuestions: { type: 'string', description: '还缺什么，分号分隔' },
      modelVersion: { type: 'string' },
      promptVersion: { type: 'string' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const supporting = normalizeEvidence(parseJsonArray(args.supporting, 'supporting'))
        const contradicting = normalizeEvidence(parseJsonArray(args.contradicting, 'contradicting'))
        const marketSnapshot = parseJsonArray(args.marketSnapshot, 'marketSnapshot').map((row) => {
          const value = (row ?? {}) as Record<string, unknown>
          return { asOf: String(value.asOf ?? '').slice(0, 10), note: String(value.note ?? '') }
        })
        const hasZone = Number(args.priceZoneLow) > 0 && Number(args.priceZoneHigh) > 0
        const input: AdviceInput = {
          userPrompt: String(args.userPrompt ?? ''),
          assets: strList(args.assets),
          market: String(args.market ?? 'cn') as Market,
          horizon: String(args.horizon ?? 'months') as Horizon,
          recommendation: String(args.recommendation ?? 'INSUFFICIENT_DATA') as Recommendation,
          ...(args.investmentGoal ? { investmentGoal: String(args.investmentGoal) } : {}),
          recommendationConditions: strList(args.recommendationConditions),
          rationale: strList(args.rationale),
          supporting,
          contradicting,
          invalidationConditions: strList(args.invalidationConditions),
          marketSnapshot,
          dataFreshness: {
            status: String(args.dataFreshnessStatus ?? 'unknown') as 'fresh' | 'stale' | 'unknown',
            asOf: String(args.dataFreshnessAsOf ?? '').slice(0, 10),
            note: args.dataFreshnessNote ? String(args.dataFreshnessNote) : '',
          },
          ...(args.valuationSummary ? { valuationSummary: String(args.valuationSummary) } : {}),
          portfolioContextUsed: args.portfolioContextUsed === true,
          riskConstraints: strList(args.riskConstraints),
          scenarioAssumptions: strList(args.scenarioAssumptions),
          proposedAction: args.proposedActionSummary
            ? {
              summary: String(args.proposedActionSummary),
              conditions: strList(args.proposedActionConditions),
              ...(hasZone ? { priceZone: { low: Number(args.priceZoneLow), high: Number(args.priceZoneHigh), basis: String(args.priceZoneBasis ?? '') } } : {}),
              simulated: true,
            }
            : null,
          ...(args.nextReviewAt ? { nextReviewAt: String(args.nextReviewAt).slice(0, 10) } : {}),
          unresolvedQuestions: strList(args.unresolvedQuestions),
          calculationRefs: strList(args.calculationRefs),
          ...(args.modelVersion ? { modelVersion: String(args.modelVersion) } : {}),
          ...(args.promptVersion ? { promptVersion: String(args.promptVersion) } : {}),
        }
        const result = await deps.store.create(input)
        if (!result.advice) {
          return asJson({
            ok: false,
            error: result.error,
            errors: result.errors,
            warnings: result.warnings,
            hint: '按 errors 补齐后重试；如果确实没有足够依据，请改用 recommendation=INSUFFICIENT_DATA 并写清 unresolvedQuestions。',
          })
        }
        notify('save', result.advice.adviceId, result.advice.recommendation)
        return asJson({
          ok: true,
          advice: result.advice,
          label: RECOMMENDATION_LABEL[result.advice.recommendation],
          warnings: result.warnings,
          note: '已保存（只读历史，后续复盘用 investment_advice_review 追加，不改原判断）。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_advice_list',
    description: '列出已保存的投资建议（可按状态/标的/市场过滤），含支持/反对证据条数与下次复核日。',
    parameters: {
      status: { type: 'string', enum: ['open', 'reviewed'] },
      asset: { type: 'string' },
      market: { type: 'string', enum: [...MARKETS] },
      limit: { type: 'number' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const items = deps.store.list({
          ...(args.status ? { status: args.status as 'open' | 'reviewed' } : {}),
          ...(args.asset ? { asset: String(args.asset) } : {}),
          ...(args.market ? { market: String(args.market) } : {}),
          limit: Number(args.limit) > 0 ? Number(args.limit) : 30,
        })
        const today = new Date().toISOString().slice(0, 10)
        const due = deps.store.all()
          .filter((item) => item.status === 'open' && item.nextReviewAt && item.nextReviewAt <= today)
          .map((item) => ({ adviceId: item.adviceId, assets: item.assets, userPrompt: item.userPrompt, nextReviewAt: item.nextReviewAt, recommendation: item.recommendation }))
        return asJson({ ok: true, stats: deps.store.stats(), dueForReview: due, count: items.length, advices: items.map(adviceBrief) })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_advice_verify',
    description: '用价格历史检验一条投资建议：给出「观点是否被走势支持」（supported/contradicted/inconclusive/unverifiable），可带基准算超额。可以用 autoFetch 自动取日线收盘价，也可以自己传 prices。不把观点验证当交易盈亏，也不给胜率。',
    parameters: {
      adviceId: { type: 'string', required: true },
      prices: { type: 'string', description: '价格序列 JSON：[{"date":"2026-01-02","close":3900}]（与 autoFetch 二选一）' },
      benchmarkPrices: { type: 'string', description: '可选：基准价格序列，同上' },
      autoFetch: { type: 'boolean', description: 'true = 用行情服务自动取日线（需要 code）' },
      code: { type: 'string', description: '自动取价代码，默认用建议里的第一个标的' },
      benchmarkCode: { type: 'string', description: '可选：基准代码（如 000300 / ^GSPC）' },
      asOf: { type: 'string', description: '验证截止日 YYYY-MM-DD，默认今天' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const advice = deps.store.get(String(args.adviceId ?? ''))
        if (!advice) return asJson({ ok: false, error: `未找到投资建议：${args.adviceId}` })
        let prices: Array<{ date: string; close: number }> = []
        if (args.prices) {
          try {
            prices = JSON.parse(String(args.prices)) as Array<{ date: string; close: number }>
          } catch {
            return asJson({ ok: false, error: 'prices 必须是 JSON 数组：[{date, close}]' })
          }
        } else if (args.autoFetch === true) {
          if (!deps.finance) return asJson({ ok: false, error: '行情服务不可用：请改用 prices 传入收盘价序列' })
          const code = String(args.code ?? advice.assets[0] ?? '')
          if (!code) return asJson({ ok: false, error: '自动取价需要 code' })
          const fetchKline = advice.market === 'us' && deps.finance.getUsKline ? deps.finance.getUsKline : deps.finance.getKline
          const kline = await fetchKline(code, 'daily')
          if (!kline.ok || !Array.isArray(kline.data) || kline.data.length < 2) {
            return asJson({ ok: false, error: `取不到 ${code} 的日线：${kline.error ?? '数据为空'}（不猜价格）` })
          }
          prices = kline.data.map((bar) => ({ date: String(bar.date).slice(0, 10), close: Number(bar.close) }))
        }
        if (!Array.isArray(prices) || prices.length < 2) return asJson({ ok: false, error: 'prices 至少需要两个不同日期（或设置 autoFetch=true）' })
        let benchmark: Array<{ date: string; close: number }> | undefined
        if (args.benchmarkPrices) {
          try {
            benchmark = JSON.parse(String(args.benchmarkPrices)) as Array<{ date: string; close: number }>
          } catch {
            return asJson({ ok: false, error: 'benchmarkPrices 必须是 JSON 数组' })
          }
        } else if (args.benchmarkCode && deps.finance && args.autoFetch === true) {
          const kline = await deps.finance.getKline(String(args.benchmarkCode), 'daily')
          if (kline.ok && Array.isArray(kline.data) && kline.data.length >= 2) {
            benchmark = kline.data.map((bar) => ({ date: String(bar.date).slice(0, 10), close: Number(bar.close) }))
          } else {
            return asJson({ ok: false, error: `取不到基准 ${args.benchmarkCode} 的日线：${kline.error ?? '数据为空'}（不编超额）` })
          }
        }
        const result = verifyAdvice({
          advice,
          prices: prices.map((p) => ({ date: String(p.date ?? '').slice(0, 10), close: Number(p.close) })),
          ...(benchmark ? { benchmark: benchmark.map((p) => ({ date: String(p.date ?? '').slice(0, 10), close: Number(p.close) })) } : {}),
          ...(args.asOf ? { asOf: String(args.asOf).slice(0, 10) } : {}),
        })
        return asJson({
          ok: true,
          ...result,
          priceSource: args.prices ? 'caller-provided' : 'market-service',
          next: '把结论用 investment_advice_review 追加（outcome=supported/contradicted/inconclusive），原始判断不会被改写。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_advice_due',
    description: '到期待复核的投资建议（按 nextReviewAt ≤ 今天、状态 open），返回逾期天数与原判断摘要。用于「今天有哪些判断该复盘」。',
    parameters: {
      includeFuture: { type: 'boolean', description: '是否把未来 7 天内到期的也列出（默认 false）' },
      limit: { type: 'number', description: '默认 20' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const today = new Date().toISOString().slice(0, 10)
        const due = deps.store.dueForReview(today, args.includeFuture === true ? 7 : 0)
        const rows = due.slice(0, Number(args.limit) > 0 ? Number(args.limit) : 20).map(({ advice, overdueDays }) => ({
          adviceId: advice.adviceId,
          assets: advice.assets,
          userPrompt: advice.userPrompt,
          recommendation: advice.recommendation,
          label: RECOMMENDATION_LABEL[advice.recommendation],
          nextReviewAt: advice.nextReviewAt,
          overdueDays,
          invalidationConditions: advice.invalidationConditions,
          dataFreshness: advice.dataFreshness.status,
        }))
        return asJson({
          ok: true,
          today,
          count: rows.length,
          overdue: rows.filter((r) => r.overdueDays > 0).length,
          items: rows,
          note: rows.length === 0
            ? '没有到期的建议。复盘节奏由每条建议的 nextReviewAt 决定，不强制每日。'
            : '复盘时用 investment_advice_review 追加结论：区分「观点是否被验证」「条件是否触发」「是否只是模拟」。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_advice_get',
    description: '读取一条投资建议的完整记录（含证据、条件、失效条件与历史复盘）。',
    parameters: { adviceId: { type: 'string', required: true } },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const advice = deps.store.get(String(args.adviceId ?? ''))
        if (!advice) return asJson({ ok: false, error: `未找到投资建议：${args.adviceId}` })
        return asJson({ ok: true, advice, label: RECOMMENDATION_LABEL[advice.recommendation] })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_advice_review',
    description: '对已保存的投资建议做复盘：追加一条带日期的结论（支持/证伪/无定论），记录条件是否触发、是否触发失效条件。不修改原始判断与原始证据。',
    parameters: {
      adviceId: { type: 'string', required: true },
      outcome: { type: 'string', required: true, enum: ['supported', 'contradicted', 'inconclusive'] },
      note: { type: 'string', required: true, description: '为什么这样判定（引用数据）' },
      dataAsOf: { type: 'string', description: '复盘依据的数据日期 YYYY-MM-DD' },
      conditionTriggered: { type: 'boolean', description: '建议的入场/减仓条件是否真的触发' },
      invalidationTriggered: { type: 'boolean', description: '是否触发了失效条件' },
      benchmarkNote: { type: 'string', description: '同期基准比较（如沪深300 涨跌幅）' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const advice = await deps.store.review(String(args.adviceId ?? ''), {
          outcome: String(args.outcome ?? 'inconclusive') as 'supported' | 'contradicted' | 'inconclusive',
          note: String(args.note ?? ''),
          dataAsOf: args.dataAsOf ? String(args.dataAsOf) : new Date().toISOString().slice(0, 10),
          ...(args.conditionTriggered === undefined ? {} : { conditionTriggered: args.conditionTriggered === true }),
          ...(args.invalidationTriggered === undefined ? {} : { invalidationTriggered: args.invalidationTriggered === true }),
          ...(args.benchmarkNote ? { benchmarkNote: String(args.benchmarkNote) } : {}),
        })
        notify('review', advice.adviceId, advice.recommendation)
        return asJson({
          ok: true,
          advice: adviceBrief(advice),
          reviews: advice.reviews,
          note: '复盘已追加；原始判断与证据未被改写。未真实成交的观点不得统计为已实现交易。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'investment_evidence_check',
    description: '校验建议里引用的证据是否真实存在于本地库（政策原文 / 研究资料 / 证据提交），并对无法核验的引用明确返回 not-found，避免引用不存在的来源。',
    parameters: {
      refs: { type: 'string', required: true, description: 'JSON 数组：[{type:"policy"|"research"|"evidence"|"url", id}]' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const refs = parseJsonArray(args.refs, 'refs').map((row) => {
          const value = (row ?? {}) as Record<string, unknown>
          return { type: String(value.type ?? ''), id: String(value.id ?? '') }
        })
        if (refs.length === 0) return asJson({ ok: false, error: 'refs 不能为空' })
        if (deps.policy && !deps.policy.isLoaded()) await deps.policy.load()
        if (deps.vault && !deps.vault.isLoaded()) await deps.vault.load()
        if (deps.evidence && !deps.evidence.isLoaded()) await deps.evidence.load()
        const results = refs.map((ref) => {
          if (ref.type === 'policy') {
            const doc = deps.policy?.get(ref.id)
            return doc
              ? { ...ref, found: true, title: doc.title, source: doc.canonicalUrl, asOf: doc.publishedAt, status: doc.status }
              : { ...ref, found: false, reason: '政策库中没有该 id' }
          }
          if (ref.type === 'research') {
            const item = deps.vault?.all().find((i) => i.id === ref.id)
            return item
              ? { ...ref, found: true, title: item.title, source: item.sourceUrl ?? item.source, asOf: item.occurredAt, status: item.status }
              : { ...ref, found: false, reason: '资料库中没有该 id' }
          }
          if (ref.type === 'evidence') {
            const request = deps.evidence?.get(ref.id)
            return request
              ? { ...ref, found: true, title: request.title, source: request.userSubmissionIds.join(','), asOf: request.updatedAt.slice(0, 10), status: request.status }
              : { ...ref, found: false, reason: '证据库中没有该 requestId' }
          }
          if (ref.type === 'url') {
            return { ...ref, found: false, reason: '外部 URL 无法离线核验：请在 claim 中写明来源与访问日期' }
          }
          return { ...ref, found: false, reason: `未知引用类型：${ref.type}` }
        })
        return asJson({
          ok: results.every((r) => r.found),
          results,
          note: 'found=false 的引用不能用于支撑结论：要么换成库内真实资料，要么在 claim 中标为「未核验」。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  // Keep the enum lists referenced so schema drift is caught at build time.
  void EVIDENCE_KINDS
}
