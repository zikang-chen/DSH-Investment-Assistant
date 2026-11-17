/**
 * Policy theses — durable research memory with append-only reviews.
 *
 * Rules that matter (and why the shape looks like this):
 * - the original hypothesis is never overwritten: changing it requires
 *   `reviseHypothesis`, which keeps every prior version with a reason;
 * - a new fact never flips the judgement by itself: `review` only appends a
 *   timestamped record, and `status` changes solely on an explicit call;
 * - reviews require what changed and what is still missing, so a later reader
 *   can tell "supported by evidence" from "nothing happened and we moved on".
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'

export const THESIS_STATUSES = ['active', 'validated', 'invalidated', 'dropped'] as const
export type ThesisStatus = (typeof THESIS_STATUSES)[number]

export const REVIEW_VERDICTS = ['support', 'weaken', 'invalidate', 'inconclusive'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  support: '支持原判断',
  weaken: '削弱原判断',
  invalidate: '证伪',
  inconclusive: '仍无定论',
}

export interface ThesisReview {
  at: string
  /** What new fact triggered this review (data release, new policy, price move). */
  newFacts: string
  verdict: ReviewVerdict
  /** Conditions that changed since the thesis was written. */
  changedConditions: string[]
  /** What is still unverified. */
  stillMissing: string[]
  /** Optional evidence anchors (policy ids, macro series, sources). */
  refs: string[]
}

export interface HypothesisRevision {
  at: string
  hypothesis: string
  reason: string
}

export interface PolicyThesis {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  /** The original claim. Immutable except through `reviseHypothesis`. */
  hypothesis: string
  hypothesisHistory: HypothesisRevision[]
  /** Expected transmission, written at creation. */
  mechanism: string
  policyIds: string[]
  assetIds: string[]
  industries: string[]
  horizonMonths: number
  supporting: string[]
  contradicting: string[]
  validationIndicators: string[]
  invalidationConditions: string[]
  status: ThesisStatus
  reviews: ThesisReview[]
}

export interface ThesisInput {
  title: string
  hypothesis: string
  mechanism?: string
  policyIds?: string[]
  assetIds?: string[]
  industries?: string[]
  horizonMonths?: number
  supporting?: string[]
  contradicting?: string[]
  validationIndicators?: string[]
  invalidationConditions?: string[]
}

export interface ThesisFilter {
  status?: ThesisStatus
  policyId?: string
  assetId?: string
  industry?: string
  limit?: number
}

interface ThesisFile {
  version: 1
  updatedAt: string
  theses: PolicyThesis[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function clean(list: unknown): string[] {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[,，;；\n]+/) : []
  return [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))]
}

export class PolicyThesisStore {
  readonly file: string
  private theses: PolicyThesis[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.file = path.join(dir, 'theses.json')
    this.log = logger?.child('policy.thesis')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as ThesisFile
      this.theses = Array.isArray(parsed.theses) ? parsed.theses : []
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log?.warn('thesis file unreadable', { file: this.file, error: String(err) })
      this.theses = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  all(): PolicyThesis[] {
    return [...this.theses].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): PolicyThesis | undefined {
    return this.theses.find((t) => t.id === id)
  }

  list(filter: ThesisFilter = {}): PolicyThesis[] {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    return this.all().filter((t) => {
      if (filter.status && t.status !== filter.status) return false
      if (filter.policyId && !t.policyIds.includes(filter.policyId)) return false
      if (filter.assetId && !t.assetIds.includes(filter.assetId)) return false
      if (filter.industry && !t.industries.some((i) => i.includes(filter.industry!))) return false
      return true
    }).slice(0, limit)
  }

  async create(input: ThesisInput): Promise<PolicyThesis> {
    const title = String(input.title ?? '').trim()
    const hypothesis = String(input.hypothesis ?? '').trim()
    if (!title) throw new Error('缺少标题')
    if (!hypothesis) throw new Error('缺少假设（要能被证伪的一句话判断）')
    const at = nowIso()
    const thesis: PolicyThesis = {
      id: shortId(),
      createdAt: at,
      updatedAt: at,
      title,
      hypothesis,
      hypothesisHistory: [],
      mechanism: String(input.mechanism ?? '').trim(),
      policyIds: clean(input.policyIds),
      assetIds: clean(input.assetIds),
      industries: clean(input.industries),
      horizonMonths: Number(input.horizonMonths) > 0 ? Math.min(120, Number(input.horizonMonths)) : 12,
      supporting: clean(input.supporting),
      contradicting: clean(input.contradicting),
      validationIndicators: clean(input.validationIndicators),
      invalidationConditions: clean(input.invalidationConditions),
      status: 'active',
      reviews: [],
    }
    this.theses.push(thesis)
    await this.persist()
    return thesis
  }

  /** Update mutable fields; `hypothesis` is intentionally not accepted here. */
  async update(id: string, patch: Partial<Omit<ThesisInput, 'title' | 'hypothesis'>> & { title?: string }): Promise<PolicyThesis> {
    const thesis = this.get(id)
    if (!thesis) throw new Error(`未找到假设：${id}`)
    const next: PolicyThesis = {
      ...thesis,
      ...(patch.title ? { title: String(patch.title).trim() } : {}),
      ...(patch.mechanism !== undefined ? { mechanism: String(patch.mechanism) } : {}),
      ...(patch.policyIds !== undefined ? { policyIds: clean(patch.policyIds) } : {}),
      ...(patch.assetIds !== undefined ? { assetIds: clean(patch.assetIds) } : {}),
      ...(patch.industries !== undefined ? { industries: clean(patch.industries) } : {}),
      ...(patch.horizonMonths !== undefined && Number(patch.horizonMonths) > 0 ? { horizonMonths: Math.min(120, Number(patch.horizonMonths)) } : {}),
      ...(patch.supporting !== undefined ? { supporting: clean(patch.supporting) } : {}),
      ...(patch.contradicting !== undefined ? { contradicting: clean(patch.contradicting) } : {}),
      ...(patch.validationIndicators !== undefined ? { validationIndicators: clean(patch.validationIndicators) } : {}),
      ...(patch.invalidationConditions !== undefined ? { invalidationConditions: clean(patch.invalidationConditions) } : {}),
      updatedAt: nowIso(),
    }
    this.replace(next)
    await this.persist()
    return next
  }

  /** Replace the hypothesis while keeping every prior version. */
  async reviseHypothesis(id: string, hypothesis: string, reason: string): Promise<PolicyThesis> {
    const thesis = this.get(id)
    if (!thesis) throw new Error(`未找到假设：${id}`)
    const nextText = String(hypothesis ?? '').trim()
    if (!nextText) throw new Error('新假设不能为空')
    if (!String(reason ?? '').trim()) throw new Error('修改原判断必须给出理由（事后覆盖会让历史判断看起来总是对的）')
    const at = nowIso()
    const next: PolicyThesis = {
      ...thesis,
      hypothesisHistory: [...thesis.hypothesisHistory, { at, hypothesis: thesis.hypothesis, reason: String(reason).trim() }],
      hypothesis: nextText,
      updatedAt: at,
    }
    this.replace(next)
    await this.persist()
    return next
  }

  /** Append a review record. Never changes `status` — that needs an explicit call. */
  async review(id: string, review: Omit<ThesisReview, 'at'>): Promise<PolicyThesis> {
    const thesis = this.get(id)
    if (!thesis) throw new Error(`未找到假设：${id}`)
    if (!REVIEW_VERDICTS.includes(review.verdict)) throw new Error(`无效结论：${review.verdict}`)
    const newFacts = String(review.newFacts ?? '').trim()
    if (!newFacts) throw new Error('复核必须写明「新增事实是什么」')
    const record: ThesisReview = {
      at: nowIso(),
      newFacts,
      verdict: review.verdict,
      changedConditions: clean(review.changedConditions),
      stillMissing: clean(review.stillMissing),
      refs: clean(review.refs),
    }
    const next: PolicyThesis = { ...thesis, reviews: [...thesis.reviews, record], updatedAt: record.at }
    this.replace(next)
    await this.persist()
    return next
  }

  /** Explicit judgement change — the only path that moves `status`. */
  async setStatus(id: string, status: ThesisStatus): Promise<PolicyThesis> {
    if (!THESIS_STATUSES.includes(status)) throw new Error(`无效状态：${status}`)
    const thesis = this.get(id)
    if (!thesis) throw new Error(`未找到假设：${id}`)
    const next: PolicyThesis = { ...thesis, status, updatedAt: nowIso() }
    this.replace(next)
    await this.persist()
    return next
  }

  async remove(id: string): Promise<boolean> {
    const before = this.theses.length
    this.theses = this.theses.filter((t) => t.id !== id)
    if (this.theses.length === before) return false
    await this.persist()
    return true
  }

  stats(): { total: number; active: number; validated: number; invalidated: number; reviews: number } {
    return {
      total: this.theses.length,
      active: this.theses.filter((t) => t.status === 'active').length,
      validated: this.theses.filter((t) => t.status === 'validated').length,
      invalidated: this.theses.filter((t) => t.status === 'invalidated').length,
      reviews: this.theses.reduce((sum, t) => sum + t.reviews.length, 0),
    }
  }

  private replace(next: PolicyThesis): void {
    this.theses = this.theses.map((t) => (t.id === next.id ? next : t))
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: ThesisFile = { version: 1, updatedAt: nowIso(), theses: this.all() }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
