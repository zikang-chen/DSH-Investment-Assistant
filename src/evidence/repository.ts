/**
 * Evidence Inbox persistence.
 *
 * Two append-oriented JSON files under `<dataDir>/evidence/`:
 *   requests.json     — the collaboration workflow state
 *   submissions.json  — what the user handed over, with hashes and verdicts
 * plus `attachments/<hash>.<ext>` for the original bytes.
 *
 * JSON (not SQLite) on purpose: the volume is small, the file is human-auditable,
 * and the plugin already uses atomic JSON writes everywhere else.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Logger } from '../log.js'
import {
  EVIDENCE_REQUEST_STATUSES,
  EVIDENCE_TRANSITIONS,
  canTransition,
  gapDedupeKey,
  cleanList,
  normalizeBlocking,
  normalizeImportance,
  type CreateRequestInput,
  type EvidenceRequest,
  type EvidenceRequestStatus,
  type EvidenceSubmission,
} from './schema.js'

interface RequestsFile {
  version: 1
  updatedAt: string
  requests: EvidenceRequest[]
}

interface SubmissionsFile {
  version: 1
  updatedAt: string
  submissions: EvidenceSubmission[]
}

export interface ListFilter {
  status?: EvidenceRequestStatus | EvidenceRequestStatus[]
  researchTaskId?: string
  importance?: string
  limit?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export class EvidenceRepository {
  readonly dir: string
  private readonly requestsPath: string
  private readonly submissionsPath: string
  private readonly attachmentsDir: string
  private requests: EvidenceRequest[] = []
  private submissions: EvidenceSubmission[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.dir = dir
    this.requestsPath = path.join(dir, 'requests.json')
    this.submissionsPath = path.join(dir, 'submissions.json')
    this.attachmentsDir = path.join(dir, 'attachments')
    this.log = logger?.child('evidence')
  }

  async load(): Promise<void> {
    await mkdir(this.attachmentsDir, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.requestsPath, 'utf8')) as RequestsFile
      this.requests = Array.isArray(parsed.requests) ? parsed.requests : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('evidence requests unreadable', { error: String(err) })
      this.requests = []
    }
    try {
      const parsed = JSON.parse(await readFile(this.submissionsPath, 'utf8')) as SubmissionsFile
      this.submissions = Array.isArray(parsed.submissions) ? parsed.submissions : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('evidence submissions unreadable', { error: String(err) })
      this.submissions = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  // ---------------------------------------------------------------- requests

  all(): EvidenceRequest[] {
    return [...this.requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(requestId: string): EvidenceRequest | undefined {
    return this.requests.find((r) => r.requestId === requestId)
  }

  findByDedupeKey(dedupeKey: string): EvidenceRequest | undefined {
    return this.requests.find((r) => r.dedupeKey === dedupeKey)
  }

  list(filter: ListFilter = {}): EvidenceRequest[] {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    const statuses = filter.status === undefined
      ? undefined
      : Array.isArray(filter.status) ? filter.status : [filter.status]
    return this.all().filter((r) => {
      if (statuses && !statuses.includes(r.status)) return false
      if (filter.researchTaskId && r.researchTaskId !== filter.researchTaskId) return false
      if (filter.importance && r.importance !== filter.importance) return false
      return true
    }).slice(0, limit)
  }

  /**
   * Create or return the existing request for the same (task, gap).
   * A skipped/expired request is reopened instead of duplicated.
   */
  async createRequest(input: CreateRequestInput): Promise<{ request: EvidenceRequest; created: boolean }> {
    const title = String(input.title ?? '').trim()
    const question = String(input.question ?? '').trim()
    if (!title) throw new Error('缺少 title')
    if (!question) throw new Error('缺少 question（这项证据要回答什么）')
    const researchTaskId = String(input.researchTaskId ?? '').trim()
    if (!researchTaskId) throw new Error('缺少 researchTaskId（研究任务必须先持久化）')
    const dedupeKey = String(input.gapKey ?? '').trim() || gapDedupeKey(researchTaskId, `${title}|${question}`)
    const existing = this.findByDedupeKey(dedupeKey)
    if (existing) {
      if (existing.status === 'SKIPPED' || existing.status === 'EXPIRED') {
        const reopened = await this.transition(existing.requestId, 'WAITING_FOR_USER', { resolutionNote: '重新打开' })
        return { request: reopened, created: false }
      }
      return { request: existing, created: false }
    }
    const at = nowIso()
    const request: EvidenceRequest = {
      requestId: shortId('evr'),
      researchTaskId,
      researchStepId: String(input.researchStepId ?? '').trim(),
      dedupeKey,
      title,
      question,
      reason: String(input.reason ?? '').trim(),
      requiredData: cleanList(input.requiredData),
      acceptableFormats: cleanList(input.acceptableFormats),
      suggestedOfficialSources: cleanList(input.suggestedOfficialSources),
      suggestedSearchKeywords: cleanList(input.suggestedSearchKeywords),
      expectedReportingPeriod: String(input.expectedReportingPeriod ?? '').trim(),
      requiredUnits: String(input.requiredUnits ?? '').trim(),
      sourcePriority: cleanList(input.sourcePriority),
      importance: normalizeImportance(input.importance),
      blockingLevel: normalizeBlocking(input.blockingLevel),
      status: 'OPEN',
      createdAt: at,
      updatedAt: at,
      resolvedAt: '',
      userSubmissionIds: [],
      validationResults: [],
      resumeContext: {
        summary: String(input.resumeContext?.summary ?? ''),
        knownFacts: cleanList(input.resumeContext?.knownFacts),
        pendingQuestion: String(input.resumeContext?.pendingQuestion ?? question),
        nextStep: String(input.resumeContext?.nextStep ?? ''),
        ...(input.resumeContext?.policyIds ? { policyIds: cleanList(input.resumeContext.policyIds) } : {}),
        ...(input.resumeContext?.assetIds ? { assetIds: cleanList(input.resumeContext.assetIds) } : {}),
      },
      resumeState: 'none',
      resumedAt: '',
      resolutionNote: '',
    }
    this.requests = [...this.requests, request]
    await this.persistRequests()
    return { request, created: true }
  }

  /** Apply a validated transition. Unknown transitions are rejected, never coerced. */
  async transition(
    requestId: string,
    to: EvidenceRequestStatus,
    patch: Partial<Pick<EvidenceRequest, 'resolutionNote' | 'resumeState' | 'resumedAt' | 'validationResults' | 'userSubmissionIds'>> = {},
  ): Promise<EvidenceRequest> {
    if (!(EVIDENCE_REQUEST_STATUSES as readonly string[]).includes(to)) throw new Error(`无效状态：${to}`)
    const current = this.get(requestId)
    if (!current) throw new Error(`未找到证据请求：${requestId}`)
    if (!canTransition(current.status, to)) {
      const allowed = EVIDENCE_TRANSITIONS[current.status] ?? []
      throw new Error(`非法状态转换：${current.status} → ${to}（允许：${allowed.length > 0 ? allowed.join('/') : '无，已是终态'}）`)
    }
    const at = nowIso()
    const terminal = to === 'ACCEPTED' || to === 'SKIPPED' || to === 'EXPIRED'
    const next: EvidenceRequest = {
      ...current,
      ...patch,
      status: to,
      updatedAt: at,
      ...(terminal ? { resolvedAt: at } : {}),
    }
    this.requests = this.requests.map((r) => (r.requestId === requestId ? next : r))
    await this.persistRequests()
    return next
  }

  async updateRequest(requestId: string, patch: Partial<EvidenceRequest>): Promise<EvidenceRequest> {
    const current = this.get(requestId)
    if (!current) throw new Error(`未找到证据请求：${requestId}`)
    const next: EvidenceRequest = { ...current, ...patch, requestId: current.requestId, updatedAt: nowIso() }
    this.requests = this.requests.map((r) => (r.requestId === requestId ? next : r))
    await this.persistRequests()
    return next
  }

  /** Expire requests that have been waiting too long (never touches ACCEPTED). */
  async expireStale(maxAgeDays = 30, nowMs = Date.now()): Promise<EvidenceRequest[]> {
    const expired: EvidenceRequest[] = []
    for (const request of this.requests) {
      if (request.status !== 'WAITING_FOR_USER' && request.status !== 'OPEN') continue
      const age = (nowMs - Date.parse(request.updatedAt)) / 86_400_000
      if (!Number.isFinite(age) || age <= maxAgeDays) continue
      expired.push(await this.transition(request.requestId, 'EXPIRED', { resolutionNote: `超过 ${maxAgeDays} 天未补充` }))
    }
    return expired
  }

  // ------------------------------------------------------------- submissions

  submissionsFor(requestId: string): EvidenceSubmission[] {
    return this.submissions.filter((s) => s.requestId === requestId).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
  }

  getSubmission(submissionId: string): EvidenceSubmission | undefined {
    return this.submissions.find((s) => s.submissionId === submissionId)
  }

  async saveSubmission(submission: EvidenceSubmission): Promise<EvidenceSubmission> {
    const existing = this.submissions.find((s) => s.submissionId === submission.submissionId)
    this.submissions = existing
      ? this.submissions.map((s) => (s.submissionId === submission.submissionId ? submission : s))
      : [...this.submissions, submission]
    await this.persistSubmissions()
    return submission
  }

  newSubmissionId(): string {
    return shortId('evs')
  }

  /** Persist original bytes content-addressed; returns the relative reference. */
  async saveAttachment(buffer: Buffer, ext: string, contentHash: string): Promise<string> {
    await mkdir(this.attachmentsDir, { recursive: true })
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
    const file = path.join(this.attachmentsDir, `${contentHash.slice(0, 32)}.${safeExt}`)
    try {
      await readFile(file)
    } catch {
      await writeFile(file, buffer)
    }
    return path.relative(this.dir, file).split(path.sep).join('/')
  }

  stats(): { total: number; byStatus: Record<string, number>; submissions: number; waiting: number } {
    const byStatus: Record<string, number> = {}
    for (const r of this.requests) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    return {
      total: this.requests.length,
      byStatus,
      submissions: this.submissions.length,
      waiting: this.requests.filter((r) => r.status === 'WAITING_FOR_USER' || r.status === 'SUBMITTED' || r.status === 'VALIDATING').length,
    }
  }

  hashBytes(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
  }

  // ---------------------------------------------------------------- internals

  private async persistRequests(): Promise<void> {
    const payload: RequestsFile = { version: 1, updatedAt: nowIso(), requests: this.all() }
    await this.atomic(this.requestsPath, JSON.stringify(payload, null, 2))
  }

  private async persistSubmissions(): Promise<void> {
    const payload: SubmissionsFile = { version: 1, updatedAt: nowIso(), submissions: this.submissions }
    await this.atomic(this.submissionsPath, JSON.stringify(payload, null, 2))
  }

  private async atomic(file: string, raw: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, raw, 'utf8')
    await rename(tmp, file)
  }
}
