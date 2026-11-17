/**
 * Investment advice store.
 *
 * Save is append-only from the reader's point of view: `review` adds a dated
 * record and flips the status, but the original judgement, evidence and
 * timestamps are never rewritten — otherwise "backtest accuracy" becomes a lie.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import {
  advicePromptHash,
  normalizeEvidenceKind,
  validateAdvice,
  type AdviceInput,
  type AdviceReview,
  type InvestmentAdvice,
} from './schema.js'

interface AdvicesFile { version: 1; updatedAt: string; advices: InvestmentAdvice[] }

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return `adv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => String(v)) : [])
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
/** Normalise legacy/free-form evidence kinds in place (in memory) so lists and detail agree. */
const evidenceArray = <T extends { kind?: unknown }>(value: unknown): T[] =>
  Array.isArray(value) ? value.map((item) => ({ ...(item as T), kind: normalizeEvidenceKind((item as T)?.kind) })) : []

/**
 * Tolerate older / hand-edited records: fill missing arrays and objects so a single
 * incomplete record cannot make the whole list or detail view fail. Values are not
 * invented — missing lists become empty, missing freshness becomes "unknown".
 */
function normalizeStoredAdvice(raw: unknown): InvestmentAdvice {
  const a = (raw ?? {}) as Record<string, unknown>
  const fresh = (a.dataFreshness ?? {}) as Record<string, unknown>
  const action = a.proposedAction && typeof a.proposedAction === 'object'
    ? (a.proposedAction as Record<string, unknown>)
    : null
  return {
    ...(a as unknown as InvestmentAdvice),
    adviceId: str(a.adviceId),
    userPrompt: str(a.userPrompt),
    createdAt: str(a.createdAt),
    assets: strArray(a.assets),
    market: (str(a.market, 'other') as InvestmentAdvice['market']),
    horizon: (str(a.horizon, 'months') as InvestmentAdvice['horizon']),
    investmentGoal: str(a.investmentGoal),
    recommendationConditions: strArray(a.recommendationConditions),
    rationale: strArray(a.rationale),
    supporting: evidenceArray<InvestmentAdvice['supporting'][number]>(a.supporting),
    contradicting: evidenceArray<InvestmentAdvice['contradicting'][number]>(a.contradicting),
    invalidationConditions: strArray(a.invalidationConditions),
    marketSnapshot: Array.isArray(a.marketSnapshot) ? (a.marketSnapshot as InvestmentAdvice['marketSnapshot']) : [],
    dataFreshness: {
      status: str(fresh.status, 'unknown') as InvestmentAdvice['dataFreshness']['status'],
      asOf: str(fresh.asOf),
      note: str(fresh.note),
    },
    valuationSummary: str(a.valuationSummary),
    portfolioContextUsed: a.portfolioContextUsed === true,
    riskConstraints: strArray(a.riskConstraints),
    scenarioAssumptions: strArray(a.scenarioAssumptions),
    proposedAction: action
      ? {
        summary: str(action.summary),
        conditions: strArray(action.conditions),
        ...(action.priceZone ? { priceZone: action.priceZone as NonNullable<InvestmentAdvice['proposedAction']>['priceZone'] } : {}),
        ...(action.sizingNote ? { sizingNote: String(action.sizingNote) } : {}),
        simulated: action.simulated !== false,
      }
      : null,
    nextReviewAt: str(a.nextReviewAt),
    unresolvedQuestions: strArray(a.unresolvedQuestions),
    calculationRefs: strArray(a.calculationRefs),
    modelVersion: str(a.modelVersion, 'unknown'),
    promptVersion: str(a.promptVersion, 'unknown'),
    status: a.status === 'reviewed' ? 'reviewed' : 'open',
    reviews: Array.isArray(a.reviews) ? (a.reviews as InvestmentAdvice['reviews']) : [],
    promptHash: str(a.promptHash),
  }
}

export interface CreateResult {
  advice?: InvestmentAdvice
  error?: string
  errors?: string[]
  warnings?: string[]
}

export class AdviceStore {
  readonly file: string
  private advices: InvestmentAdvice[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.file = path.join(dir, 'advices.json')
    this.log = logger?.child('investment')
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as AdvicesFile
      const raw = Array.isArray(parsed.advices) ? parsed.advices : []
      this.advices = raw.map((item) => normalizeStoredAdvice(item))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('advice store unreadable', { error: String(err) })
      this.advices = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  all(): InvestmentAdvice[] {
    return [...this.advices].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(adviceId: string): InvestmentAdvice | undefined {
    return this.advices.find((a) => a.adviceId === adviceId)
  }

  list(filter: { status?: 'open' | 'reviewed'; asset?: string; market?: string; limit?: number } = {}): InvestmentAdvice[] {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    return this.all().filter((a) => {
      if (filter.status && a.status !== filter.status) return false
      if (filter.asset && !(a.assets ?? []).some((x) => String(x).toUpperCase().includes(filter.asset!.toUpperCase()))) return false
      if (filter.market && a.market !== filter.market) return false
      return true
    }).slice(0, limit)
  }

  /** Validate then persist. An inadmissible advice is never stored. */
  async create(input: AdviceInput): Promise<CreateResult> {
    const outcome = validateAdvice(input)
    if (!outcome.ok) {
      return { error: '建议不满足证据与反证要求，未保存', errors: outcome.errors, warnings: outcome.warnings }
    }
    const at = nowIso()
    const advice: InvestmentAdvice = {
      adviceId: shortId(),
      userPrompt: input.userPrompt.trim(),
      createdAt: at,
      assets: input.assets.map((a) => a.trim()),
      market: input.market,
      horizon: input.horizon,
      investmentGoal: String(input.investmentGoal ?? '').trim(),
      recommendation: input.recommendation,
      recommendationConditions: (input.recommendationConditions ?? []).map((s) => String(s).trim()).filter(Boolean),
      rationale: (input.rationale ?? []).map((s) => String(s).trim()).filter(Boolean),
      supporting: input.supporting ?? [],
      contradicting: input.contradicting ?? [],
      invalidationConditions: (input.invalidationConditions ?? []).map((s) => String(s).trim()).filter(Boolean),
      marketSnapshot: input.marketSnapshot ?? [],
      dataFreshness: input.dataFreshness,
      valuationSummary: String(input.valuationSummary ?? '').trim(),
      portfolioContextUsed: input.portfolioContextUsed === true,
      riskConstraints: (input.riskConstraints ?? []).map((s) => String(s).trim()).filter(Boolean),
      scenarioAssumptions: (input.scenarioAssumptions ?? []).map((s) => String(s).trim()).filter(Boolean),
      proposedAction: input.proposedAction ?? null,
      nextReviewAt: String(input.nextReviewAt ?? '').trim(),
      unresolvedQuestions: (input.unresolvedQuestions ?? []).map((s) => String(s).trim()).filter(Boolean),
      calculationRefs: (input.calculationRefs ?? []).map((s) => String(s).trim()).filter(Boolean),
      modelVersion: String(input.modelVersion ?? 'unknown'),
      promptVersion: String(input.promptVersion ?? 'investment-advisor/1'),
      status: 'open',
      reviews: [],
      promptHash: advicePromptHash(input.userPrompt, input.assets),
    }
    this.advices = [...this.advices, advice]
    await this.persist()
    return { advice, warnings: outcome.warnings }
  }

  /** Append a review; the original fields are untouched. */
  async review(adviceId: string, review: Omit<AdviceReview, 'reviewedAt'> & { reviewedAt?: string }): Promise<InvestmentAdvice> {
    const advice = this.get(adviceId)
    if (!advice) throw new Error(`未找到投资建议：${adviceId}`)
    if (!['supported', 'contradicted', 'inconclusive'].includes(review.outcome)) {
      throw new Error(`outcome 必须是 supported/contradicted/inconclusive：${review.outcome}`)
    }
    if (!String(review.note ?? '').trim()) throw new Error('复盘必须写说明（为什么算支持/证伪/无定论）')
    const record: AdviceReview = {
      reviewedAt: String(review.reviewedAt ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      outcome: review.outcome,
      dataAsOf: String(review.dataAsOf ?? '').slice(0, 10),
      note: String(review.note).trim(),
      ...(review.conditionTriggered === undefined ? {} : { conditionTriggered: review.conditionTriggered }),
      ...(review.invalidationTriggered === undefined ? {} : { invalidationTriggered: review.invalidationTriggered }),
      ...(review.benchmarkNote ? { benchmarkNote: String(review.benchmarkNote) } : {}),
    }
    const next: InvestmentAdvice = { ...advice, reviews: [...advice.reviews, record], status: 'reviewed' }
    this.advices = this.advices.map((a) => (a.adviceId === adviceId ? next : a))
    await this.persist()
    return next
  }

  /** Aggregate honesty: reports counts, and refuses to invent a hit rate. */
  stats(): {
    total: number
    open: number
    reviewed: number
    byRecommendation: Record<string, number>
    outcomes: Record<string, number>
    hitRateNote: string
  } {
    const byRecommendation: Record<string, number> = {}
    const outcomes: Record<string, number> = {}
    for (const advice of this.advices) {
      byRecommendation[advice.recommendation] = (byRecommendation[advice.recommendation] ?? 0) + 1
      for (const review of advice.reviews) outcomes[review.outcome] = (outcomes[review.outcome] ?? 0) + 1
    }
    const reviewed = this.advices.filter((a) => a.reviews.length > 0).length
    return {
      total: this.advices.length,
      open: this.advices.length - reviewed,
      reviewed,
      byRecommendation,
      outcomes,
      hitRateNote: reviewed < 20
        ? `已复盘 ${reviewed} 条，样本不足以计算「命中率」：不提供胜率数字`
        : '样本仍可能受选择性记录影响：胜率仅作参考，不等于策略有效性',
    }
  }

  /** 到期未复核的建议（open 且 nextReviewAt ≤ today+horizon）。 */
  dueForReview(today = new Date().toISOString().slice(0, 10), horizonDays = 0): Array<{ advice: InvestmentAdvice; overdueDays: number }> {
    const horizon = new Date(Date.parse(today) + Math.max(0, horizonDays) * 86_400_000).toISOString().slice(0, 10)
    return this.all()
      .filter((advice) => advice.status === 'open' && advice.nextReviewAt && advice.nextReviewAt <= horizon)
      .map((advice) => ({
        advice,
        overdueDays: Math.max(0, Math.round((Date.parse(today) - Date.parse(advice.nextReviewAt)) / 86_400_000)),
      }))
      .sort((a, b) => b.overdueDays - a.overdueDays)
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: AdvicesFile = { version: 1, updatedAt: nowIso(), advices: this.all() }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

/** Compact row for lists. */
export function adviceBrief(advice: InvestmentAdvice) {
  return {
    adviceId: advice.adviceId,
    userPrompt: advice.userPrompt,
    assets: Array.isArray(advice.assets) ? advice.assets : [],
    market: advice.market,
    horizon: advice.horizon,
    recommendation: advice.recommendation,
    dataFreshness: advice.dataFreshness?.status ?? 'unknown',
    supports: Array.isArray(advice.supporting) ? advice.supporting.length : 0,
    contradicts: Array.isArray(advice.contradicting) ? advice.contradicting.length : 0,
    status: advice.status,
    reviews: Array.isArray(advice.reviews) ? advice.reviews.length : 0,
    createdAt: advice.createdAt,
    nextReviewAt: advice.nextReviewAt,
  }
}
