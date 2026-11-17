/**
 * Evidence Inbox — data model.
 *
 * A missing piece of data is treated as a first-class, resumable research state,
 * not an exception. Two rules are encoded here:
 * - state transitions are validated by a table (no free-form status writes);
 * - a submission's evidentiary status is decided by *how* it was checked, never
 *   by the fact that the user uploaded it. "User-provided" never implies
 *   "official".
 */

export const EVIDENCE_REQUEST_STATUSES = [
  'OPEN', // 已创建，尚未通知用户
  'WAITING_FOR_USER', // 已推给用户，等待资料
  'SUBMITTED', // 用户已提交，等待校验
  'VALIDATING', // 校验中
  'ACCEPTED', // 校验通过并已用于研究
  'REJECTED', // 校验未通过（可重新提交）
  'SKIPPED', // 用户明确跳过
  'EXPIRED', // 超过有效期
] as const
export type EvidenceRequestStatus = (typeof EVIDENCE_REQUEST_STATUSES)[number]

/**
 * Allowed transitions. Anything not listed is rejected with an explicit error —
 * including ACCEPTED → anything (an accepted request is closed; new gaps need a
 * new request so the research trail stays readable).
 */
export const EVIDENCE_TRANSITIONS: Record<EvidenceRequestStatus, EvidenceRequestStatus[]> = {
  OPEN: ['WAITING_FOR_USER', 'SKIPPED', 'EXPIRED'],
  WAITING_FOR_USER: ['SUBMITTED', 'SKIPPED', 'EXPIRED'],
  SUBMITTED: ['VALIDATING', 'WAITING_FOR_USER', 'EXPIRED'],
  VALIDATING: ['ACCEPTED', 'REJECTED', 'SUBMITTED'],
  ACCEPTED: [],
  REJECTED: ['WAITING_FOR_USER', 'SUBMITTED', 'SKIPPED'],
  SKIPPED: ['WAITING_FOR_USER'],
  EXPIRED: ['WAITING_FOR_USER'],
}

export function canTransition(from: EvidenceRequestStatus, to: EvidenceRequestStatus): boolean {
  return from === to || EVIDENCE_TRANSITIONS[from]?.includes(to) === true
}

/**
 * Shortest legal path between two states (BFS over the transition table).
 * Returns `[]` when already there, `undefined` when unreachable — callers must
 * treat that as a hard error instead of forcing the write.
 */
export function transitionPath(from: EvidenceRequestStatus, to: EvidenceRequestStatus): EvidenceRequestStatus[] | undefined {
  if (from === to) return []
  const queue: Array<{ state: EvidenceRequestStatus; path: EvidenceRequestStatus[] }> = [{ state: from, path: [] }]
  const seen = new Set<EvidenceRequestStatus>([from])
  while (queue.length > 0) {
    const { state, path } = queue.shift()!
    for (const next of EVIDENCE_TRANSITIONS[state] ?? []) {
      if (seen.has(next)) continue
      const nextPath = [...path, next]
      if (next === to) return nextPath
      seen.add(next)
      queue.push({ state: next, path: nextPath })
    }
  }
  return undefined
}

/** How much confidence the material itself carries (independent of request state). */
export const EVIDENCE_STATUSES = [
  'official-verified', // 已对照官方原始资料核验
  'source-clear-unverified', // 来源明确（官方站点/公告），尚未独立核验
  'user-provided-unconfirmed', // 用户提供，来源待确认
  'parse-questionable', // 解析有疑问（PDF/表格/截图）
  'conflicting', // 与其他证据冲突
  'stale', // 已过期或被新版本替代
] as const
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number]

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = {
  'official-verified': '官方已核验',
  'source-clear-unverified': '来源明确未核验',
  'user-provided-unconfirmed': '用户提供待确认',
  'parse-questionable': '解析存疑',
  conflicting: '证据冲突',
  stale: '已过期/被替代',
}

export const SUBMISSION_SOURCE_TYPES = [
  'official-url',
  'pdf',
  'text',
  'markdown',
  'csv',
  'excel',
  'manual-values',
  'screenshot',
] as const
export type SubmissionSourceType = (typeof SUBMISSION_SOURCE_TYPES)[number]

export const SOURCE_TYPE_LABEL: Record<SubmissionSourceType, string> = {
  'official-url': '官方网页链接',
  pdf: 'PDF 文件',
  text: '纯文本',
  markdown: 'Markdown',
  csv: 'CSV',
  excel: 'Excel',
  'manual-values': '手工输入数值',
  screenshot: '截图（需人工确认）',
}

export const IMPORTANCE_LEVELS = ['critical', 'high', 'medium', 'low'] as const
export type Importance = (typeof IMPORTANCE_LEVELS)[number]

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  critical: '关键（缺它无法结论）',
  high: '高（影响结论强度）',
  medium: '中（影响细节）',
  low: '低（锦上添花）',
}

/** blocking = 研究停在这里；partial = 可以继续但要标注限制。 */
export const BLOCKING_LEVELS = ['blocking', 'partial'] as const
export type BlockingLevel = (typeof BLOCKING_LEVELS)[number]

export interface EvidenceRequest {
  requestId: string
  researchTaskId: string
  researchStepId: string
  /** Identity of the gap: same task + same gap must not create a second request. */
  dedupeKey: string
  title: string
  /** The question the evidence is supposed to answer. */
  question: string
  /** Why the system cannot get it itself. */
  reason: string
  requiredData: string[]
  acceptableFormats: string[]
  suggestedOfficialSources: string[]
  suggestedSearchKeywords: string[]
  expectedReportingPeriod: string
  requiredUnits: string
  sourcePriority: string[]
  importance: Importance
  blockingLevel: BlockingLevel
  status: EvidenceRequestStatus
  createdAt: string
  updatedAt: string
  resolvedAt: string
  userSubmissionIds: string[]
  validationResults: Array<{ submissionId: string; ok: boolean; issues: string[]; checkedAt: string }>
  /** Everything needed to continue the original research step. */
  resumeContext: {
    summary: string
    knownFacts: string[]
    pendingQuestion: string
    nextStep: string
    policyIds?: string[]
    assetIds?: string[]
  }
  resumeState: 'none' | 'ready' | 'resumed'
  resumedAt: string
  /** Notes from the user/system when closing. */
  resolutionNote: string
}

export interface ExtractedValue {
  name: string
  value: string
  unit?: string
  period?: string
  source?: string
}

export interface EvidenceSubmission {
  submissionId: string
  requestId: string
  submittedAt: string
  sourceType: SubmissionSourceType
  sourceUrl: string
  /** Date printed on the document (not the upload date). */
  documentDate: string
  reportingPeriod: string
  units: string
  note: string
  contentHash: string
  originalFileRef: string
  parsedContent: string
  extractedValues: ExtractedValue[]
  extractionConfidence: 'high' | 'medium' | 'low'
  independentlyVerified: boolean
  verificationMethod: string
  evidenceStatus: EvidenceStatus
  /** Framework-level verdict from validation. */
  verdict: 'pending' | 'accepted' | 'rejected'
  issues: string[]
  checkedAt: string
}

export interface CreateRequestInput {
  researchTaskId: string
  researchStepId?: string
  /** Stable identity of the gap; defaults to a hash of title+question. */
  gapKey?: string
  title: string
  question: string
  reason: string
  requiredData?: string[]
  acceptableFormats?: string[]
  suggestedOfficialSources?: string[]
  suggestedSearchKeywords?: string[]
  expectedReportingPeriod?: string
  requiredUnits?: string
  sourcePriority?: string[]
  importance?: Importance
  blockingLevel?: BlockingLevel
  resumeContext?: Partial<EvidenceRequest['resumeContext']>
}

export interface SubmitInput {
  requestId: string
  sourceType?: SubmissionSourceType
  /** One of url / text / filePath / values must be present. */
  url?: string
  text?: string
  filePath?: string
  values?: Array<{ name: string; value: string; unit?: string; period?: string; source?: string }>
  documentDate?: string
  reportingPeriod?: string
  units?: string
  note?: string
  /** User asserts it is an official document; still only `source-clear-unverified` until validated. */
  claimOfficial?: boolean
}

export function cleanList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，;；\n]+/) : []
  return [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))]
}

export function normalizeImportance(value: unknown): Importance {
  const v = String(value ?? '').toLowerCase()
  return (IMPORTANCE_LEVELS as readonly string[]).includes(v) ? (v as Importance) : 'medium'
}

export function normalizeBlocking(value: unknown): BlockingLevel {
  const v = String(value ?? '').toLowerCase()
  return (BLOCKING_LEVELS as readonly string[]).includes(v) ? (v as BlockingLevel) : 'partial'
}

export function normalizeSourceType(value: unknown, fallback: SubmissionSourceType = 'text'): SubmissionSourceType {
  const v = String(value ?? '').toLowerCase()
  return (SUBMISSION_SOURCE_TYPES as readonly string[]).includes(v) ? (v as SubmissionSourceType) : fallback
}

/** Stable id for a gap: same task + same gap text must map to the same key. */
export function gapDedupeKey(taskId: string, gap: string): string {
  const base = `${taskId}::${gap.replace(/\s+/g, '').toLowerCase()}`
  let h = 0x811c9dc5
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `gap-${(h >>> 0).toString(16).padStart(8, '0')}`
}

export function isIsoDay(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim())
}
