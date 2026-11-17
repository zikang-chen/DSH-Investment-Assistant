/**
 * Evidence collaboration workflow.
 *
 * The state machine lives in `schema.ts`; this file only walks legal paths. A
 * missing piece of data becomes a request, a user submission is validated into a
 * verdict, and an accepted verdict produces a **resume package** that carries the
 * original research context plus the new facts — so the research step can be
 * continued in a later turn (or after a restart) without relying on chat memory.
 */
import type { Logger } from '../log.js'
import type { EvidenceRepository } from './repository.js'
import {
  transitionPath,
  type CreateRequestInput,
  type EvidenceRequest,
  type EvidenceStatus,
  type EvidenceSubmission,
  type SubmitInput,
} from './schema.js'
import { buildSubmission, validateSubmission, type ValidationResult } from './ingestion.js'

const EVIDENCE_STRENGTH: Record<EvidenceStatus, number> = {
  'official-verified': 5,
  'source-clear-unverified': 4,
  'user-provided-unconfirmed': 3,
  'parse-questionable': 2,
  conflicting: 1,
  stale: 0,
}

export type ResolveAction = 'accept' | 'reject' | 'skip'

export interface ResolveOptions {
  note?: string
  /** Explicit human confirmation for parse-questionable material. */
  humanConfirmed?: boolean
  submissionId?: string
}

export interface ResumePackage {
  requestId: string
  status: string
  researchTaskId: string
  researchStepId: string
  alreadyResumed: boolean
  evidence: Array<{
    submissionId: string
    sourceType: string
    sourceUrl: string
    documentDate: string
    reportingPeriod: string
    evidenceStatus: EvidenceStatus
    contentHash: string
    values: EvidenceSubmission['extractedValues']
    parsedExcerpt: string
  }>
  /** Concrete facts the new evidence adds (derived from the accepted submissions). */
  addedFacts: string[]
  /** What the user should re-check in the report. */
  changedConclusions: string[]
  originalContext: EvidenceRequest['resumeContext']
  nextStep: string
  instructions: string[]
  caveat: string
}

export interface WorkflowDeps {
  repo: EvidenceRepository
  logger?: Logger
  /** Panel refresh hook (best-effort). */
  publish?: (event: { kind: 'evidence'; action: string; requestId?: string; title?: string; at: string }) => void
  timeoutMs?: number
  maxBytes?: number
}

export class EvidenceWorkflow {
  private readonly repo: EvidenceRepository
  private readonly log?: Logger
  private readonly publish?: WorkflowDeps['publish']
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(deps: WorkflowDeps) {
    this.repo = deps.repo
    this.log = deps.logger?.child('evidence.workflow')
    this.publish = deps.publish
    this.timeoutMs = deps.timeoutMs ?? 20_000
    this.maxBytes = deps.maxBytes ?? 16_000_000
  }

  private notify(action: string, request?: EvidenceRequest): void {
    try {
      this.publish?.({ kind: 'evidence', action, requestId: request?.requestId, title: request?.title, at: new Date().toISOString() })
    } catch { /* bus is best-effort */ }
  }

  async create(input: CreateRequestInput): Promise<{ request: EvidenceRequest; created: boolean }> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const { request, created } = await this.repo.createRequest(input)
    // OPEN is internal: hand it to the user immediately so it shows up in the inbox.
    const visible = request.status === 'OPEN'
      ? await this.repo.transition(request.requestId, 'WAITING_FOR_USER')
      : request
    if (created) this.notify('request-created', visible)
    return { request: visible, created }
  }

  /** Walk legal transitions to `target`; unreachable targets throw. */
  private async walk(requestId: string, target: EvidenceRequest['status'], patch?: Parameters<EvidenceRepository['transition']>[2]): Promise<EvidenceRequest> {
    let current = this.repo.get(requestId)
    if (!current) throw new Error(`未找到证据请求：${requestId}`)
    const path = transitionPath(current.status, target)
    if (path === undefined) throw new Error(`无法从 ${current.status} 走到 ${target}`)
    for (const [index, step] of path.entries()) {
      current = await this.repo.transition(requestId, step, index === path.length - 1 ? patch : undefined)
    }
    return current!
  }

  async submit(input: SubmitInput): Promise<{ request: EvidenceRequest; submission: EvidenceSubmission; validation: ValidationResult }> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const request = this.repo.get(String(input.requestId ?? ''))
    if (!request) throw new Error(`未找到证据请求：${input.requestId}`)
    if (request.status === 'ACCEPTED' || request.status === 'SKIPPED' || request.status === 'EXPIRED') {
      throw new Error(`该请求已关闭（${request.status}），如需新证据请新建请求`)
    }
    const { submission, issues } = await buildSubmission(this.repo, request, input, {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
    })
    const validating = await this.walk(request.requestId, 'VALIDATING')
    const validation = validateSubmission(submission, { humanConfirmed: false })
    const stored = await this.repo.saveSubmission({
      ...submission,
      verdict: validation.ok ? 'accepted' : 'rejected',
      issues: [...new Set([...(submission.issues ?? []), ...validation.issues])],
      checkedAt: new Date().toISOString(),
    })
    const nextRequest = await this.applyVerdict(validating.requestId, stored, validation)
    this.notify(validation.ok ? 'submission-accepted' : 'submission-rejected', nextRequest)
    this.log?.info('evidence submitted', { requestId: request.requestId, ok: validation.ok, issues: issues.length })
    return { request: nextRequest, submission: stored, validation }
  }

  /** Re-run validation (idempotent) — the explicit path after a human confirmation. */
  async validate(submissionId: string, opts: { humanConfirmed?: boolean } = {}): Promise<{ request: EvidenceRequest; validation: ValidationResult }> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const submission = this.repo.getSubmission(submissionId)
    if (!submission) throw new Error(`未找到提交：${submissionId}`)
    const request = this.repo.get(submission.requestId)
    if (!request) throw new Error(`未找到证据请求：${submission.requestId}`)
    const validation = validateSubmission(submission, { humanConfirmed: opts.humanConfirmed === true })
    const stored = await this.repo.saveSubmission({
      ...submission,
      verdict: validation.ok ? 'accepted' : 'rejected',
      issues: validation.issues,
      checkedAt: new Date().toISOString(),
    })
    const nextRequest = await this.applyVerdict(request.requestId, stored, validation)
    this.notify(validation.ok ? 'submission-accepted' : 'submission-rejected', nextRequest)
    return { request: nextRequest, validation }
  }

  private async applyVerdict(requestId: string, submission: EvidenceSubmission, validation: ValidationResult): Promise<EvidenceRequest> {
    const request = this.repo.get(requestId)
    if (!request) throw new Error(`未找到证据请求：${requestId}`)
    const submissionIds = [...new Set([...request.userSubmissionIds, submission.submissionId])]
    const validationResults = [
      ...request.validationResults.filter((v) => v.submissionId !== submission.submissionId),
      { submissionId: submission.submissionId, ok: validation.ok, issues: validation.issues, checkedAt: new Date().toISOString() },
    ]
    const target = validation.ok ? 'ACCEPTED' : 'REJECTED'
    return this.walk(requestId, target, { userSubmissionIds: submissionIds, validationResults })
  }

  /** Manual decision: accept (with optional human confirmation), reject, or skip. */
  async resolve(requestId: string, action: ResolveAction, opts: ResolveOptions = {}): Promise<{ request: EvidenceRequest; validation?: ValidationResult }> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const request = this.repo.get(requestId)
    if (!request) throw new Error(`未找到证据请求：${requestId}`)
    const note = String(opts.note ?? '').trim()

    if (action === 'skip') {
      if (request.status === 'ACCEPTED') throw new Error('该请求已通过，不能改为跳过')
      const skipped = await this.walk(requestId, 'SKIPPED', { resolutionNote: note || '用户暂时找不到资料' })
      this.notify('request-skipped', skipped)
      return { request: skipped }
    }

    if (action === 'reject') {
      if (!note) throw new Error('驳回必须给出理由')
      const rejected = await this.walk(requestId, 'REJECTED', { resolutionNote: note })
      this.notify('request-rejected', rejected)
      return { request: rejected }
    }

    // accept
    const submissionId = String(opts.submissionId ?? request.userSubmissionIds[request.userSubmissionIds.length - 1] ?? '')
    if (!submissionId) throw new Error('没有可接受的提交（用户还没提交资料）')
    const submission = this.repo.getSubmission(submissionId)
    if (!submission) throw new Error(`未找到提交：${submissionId}`)
    const validation = validateSubmission(submission, { humanConfirmed: opts.humanConfirmed === true })
    if (!validation.ok) {
      return { request: await this.applyVerdict(requestId, submission, validation), validation }
    }
    const stored = await this.repo.saveSubmission({
      ...submission,
      verdict: 'accepted',
      issues: validation.issues,
      checkedAt: new Date().toISOString(),
      ...(opts.humanConfirmed === true ? { verificationMethod: `${submission.verificationMethod}+human-confirm` } : {}),
    })
    const accepted = await this.applyVerdict(requestId, stored, validation)
    const withNote = note || accepted.resolutionNote
      ? await this.repo.updateRequest(requestId, { resolutionNote: note || accepted.resolutionNote })
      : accepted
    this.notify('request-accepted', withNote)
    return { request: withNote, validation }
  }

  /** Build the continuation package for an accepted request. */
  async resume(requestId: string): Promise<ResumePackage> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const request = this.repo.get(requestId)
    if (!request) throw new Error(`未找到证据请求：${requestId}`)
    if (request.status !== 'ACCEPTED') {
      throw new Error(`只有 ACCEPTED 的请求可以恢复研究（当前 ${request.status}）`)
    }
    const accepted = this.repo.submissionsFor(requestId).filter((s) => s.verdict === 'accepted')
    if (accepted.length === 0) throw new Error('没有已接受的提交')

    const alreadyResumed = request.resumeState === 'resumed'
    if (!alreadyResumed) {
      await this.repo.updateRequest(requestId, { resumeState: 'resumed', resumedAt: new Date().toISOString() })
    }

    const evidence = accepted.map((s) => ({
      submissionId: s.submissionId,
      sourceType: s.sourceType,
      sourceUrl: s.sourceUrl,
      documentDate: s.documentDate,
      reportingPeriod: s.reportingPeriod,
      evidenceStatus: s.evidenceStatus,
      contentHash: s.contentHash.slice(0, 16),
      values: s.extractedValues,
      parsedExcerpt: s.parsedContent.slice(0, 400),
    }))

    const addedFacts: string[] = []
    for (const sub of accepted) {
      for (const value of sub.extractedValues) {
        addedFacts.push(`${value.name}=${value.value}${value.unit ?? ''}${value.period ? `（${value.period}）` : ''}｜来源：${value.source ?? (sub.sourceUrl || '用户提供')}`)
      }
      if (sub.extractedValues.length === 0 && sub.parsedContent) {
        addedFacts.push(`资料正文 ${sub.parsedContent.length} 字（${sub.sourceType}），关键数值需在正文中人工定位`)
      }
    }

    const best = accepted.reduce<EvidenceStatus>((acc, s) => (EVIDENCE_STRENGTH[s.evidenceStatus] > EVIDENCE_STRENGTH[acc] ? s.evidenceStatus : acc), 'stale')

    return {
      requestId,
      status: request.status,
      researchTaskId: request.researchTaskId,
      researchStepId: request.researchStepId,
      alreadyResumed,
      evidence,
      addedFacts,
      changedConclusions: [
        `原来「${request.question}」无法确认，现已补充 ${accepted.length} 份材料`,
        best === 'official-verified'
          ? '证据等级：官方已核验'
          : best === 'source-clear-unverified'
            ? '证据等级：来源明确（官方域名），但未经独立核验——结论应写「据官方页面」而不是「已核实」'
            : '证据等级：用户提供，来源待确认——结论必须标注这一点',
        '请重新检查原判断的支持条件与证伪条件，列出哪些结论因此改变、哪些仍不确定',
        ...(request.blockingLevel === 'blocking' ? ['该缺口原先阻塞研究，现在可以继续原研究步骤'] : ['该缺口不阻塞研究，但会改变结论强度']),
      ],
      originalContext: request.resumeContext,
      nextStep: request.resumeContext.nextStep || '回到原研究步骤，用新证据复核结论',
      instructions: [
        '先读 evidence 中的原文摘要，再引用其中的数值；引用时必须带上提交日期与来源等级',
        '不要把「用户提供」写成「官方确认」',
        '明确列出：新增了哪些事实、哪些结论改变、哪些仍然缺失',
        '如仍需新证据，创建新的 evidence_request（不要重复用同一个 requestId）',
      ],
      caveat: '恢复包只是把材料与上下文重新交回研究流程，不自动修改已有报告；结论变更需要重新生成并留痕。',
    }
  }

  async expire(maxAgeDays = 30): Promise<EvidenceRequest[]> {
    if (!this.repo.isLoaded()) await this.repo.load()
    const expired = await this.repo.expireStale(maxAgeDays)
    for (const request of expired) this.notify('request-expired', request)
    return expired
  }
}
