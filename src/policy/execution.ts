/**
 * Policy execution tracking.
 *
 * A policy is not "done" when it is published. This module records the evidence
 * for each implementation stage — and, more importantly, what is still missing
 * and how long it has been missing. Stage paths depend on the policy type: a
 * 会议通稿 has no funding step, a 监管规则 has no disbursement step, so a single
 * linear checklist would be wrong.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'

export const EXECUTION_STAGES = ['announced', 'supporting-rules', 'budgeted', 'disbursed', 'contracted', 'financials', 'priced'] as const
export type ExecutionStage = (typeof EXECUTION_STAGES)[number]

export const STAGE_LABEL: Record<ExecutionStage, string> = {
  announced: '已发布',
  'supporting-rules': '配套细则',
  budgeted: '预算安排',
  disbursed: '资金拨付',
  contracted: '项目/订单落地',
  financials: '企业财报体现',
  priced: '市场定价',
}

/** Typical wait (days) before the next stage should be visible. */
const GAP_DAYS: Record<ExecutionStage, number> = {
  announced: 90,
  'supporting-rules': 120,
  budgeted: 180,
  disbursed: 180,
  contracted: 90,
  financials: 30,
  priced: 30,
}

export interface StageEvidence {
  stage: ExecutionStage
  /** ISO day of the evidence. */
  at: string
  source: string
  note?: string
  /** Money/scale mentioned by the source, kept verbatim. */
  amount?: string
}

export interface ExecutionRecord {
  policyId: string
  createdAt: string
  updatedAt: string
  evidence: StageEvidence[]
}

export interface ExecutionProgress {
  /** Furthest confirmed stage by path order. */
  stage: ExecutionStage | 'none'
  confirmed: ExecutionStage[]
  /** Stages on the expected path that have no evidence yet. */
  missing: ExecutionStage[]
  nextExpected?: ExecutionStage
  daysSinceLast?: number
  /** Wait threshold for the next stage (days). */
  staleDays: number
  stale: boolean
  note: string
}

/** Which stages make sense for this document type. */
export function expectedPath(docType: string): ExecutionStage[] {
  switch (docType) {
    case 'state-council-doc':
    case 'ministry-doc':
    case 'industry-plan':
    case 'five-year-plan':
      return ['announced', 'supporting-rules', 'budgeted', 'disbursed', 'contracted', 'financials']
    case 'fiscal-report':
      return ['announced', 'budgeted', 'disbursed', 'contracted', 'financials']
    case 'monetary-report':
      return ['announced', 'supporting-rules', 'financials']
    case 'regulation':
    case 'regulation-draft':
      return ['announced', 'supporting-rules', 'priced']
    case 'statistics':
      return ['announced']
    // 讲话/通稿/白皮书：只有方向意义，没有执行义务。
    case 'party-meeting':
    case 'speech':
    case 'white-paper':
      return ['announced']
    default:
      return ['announced', 'supporting-rules', 'contracted', 'financials']
  }
}

function dayDiff(fromIso: string, nowMs: number): number {
  const at = Date.parse(fromIso)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.round((nowMs - at) / 86_400_000))
}

/** Compute how far a policy actually got, and whether it looks stalled. */
export function executionProgress(record: ExecutionRecord | undefined, docType: string, nowMs = Date.now()): ExecutionProgress {
  const path = expectedPath(docType)
  const confirmedSet = new Set((record?.evidence ?? []).map((e) => e.stage))
  const confirmed = path.filter((stage) => confirmedSet.has(stage))
  const missing = path.filter((stage) => !confirmedSet.has(stage))
  const furthest = confirmed.length > 0 ? confirmed[confirmed.length - 1]! : 'none'
  const nextExpected = missing[0]
  const evidenceDates = (record?.evidence ?? []).map((e) => e.at).filter(Boolean).sort()
  const lastAt = evidenceDates[evidenceDates.length - 1]
  const daysSinceLast = lastAt ? dayDiff(lastAt, nowMs) : undefined
  const staleDays = nextExpected ? GAP_DAYS[nextExpected] : 0
  const stale = Boolean(nextExpected && daysSinceLast !== undefined && daysSinceLast > staleDays)
  const note = nextExpected
    ? stale
      ? `已 ${daysSinceLast} 天没有新证据，超过「${STAGE_LABEL[nextExpected]}」的常见等待期（${staleDays} 天）：可能停在 ${STAGE_LABEL[furthest === 'none' ? 'announced' : furthest]} 阶段`
      : `下一步观察「${STAGE_LABEL[nextExpected]}」`
    : '该文件类型没有后续执行环节（或已走完全部环节）'
  return {
    stage: furthest,
    confirmed,
    missing,
    ...(nextExpected ? { nextExpected } : {}),
    ...(daysSinceLast === undefined ? {} : { daysSinceLast }),
    staleDays,
    stale,
    note,
  }
}

interface ExecutionFile {
  version: 1
  updatedAt: string
  records: ExecutionRecord[]
}

export class ExecutionStore {
  readonly file: string
  private records: ExecutionRecord[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.file = path.join(dir, 'execution.json')
    this.log = logger?.child('policy.execution')
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ExecutionFile
      this.records = Array.isArray(parsed.records) ? parsed.records : []
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log?.warn('execution file unreadable', { file: this.file, error: String(err) })
      this.records = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  all(): ExecutionRecord[] {
    return [...this.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(policyId: string): ExecutionRecord | undefined {
    return this.records.find((r) => r.policyId === policyId)
  }

  /** Append evidence for one stage. Repeating a stage keeps both records (timeline). */
  async record(policyId: string, evidence: Omit<StageEvidence, 'at'> & { at?: string }): Promise<ExecutionRecord> {
    if (!policyId) throw new Error('需要 policyId')
    if (!EXECUTION_STAGES.includes(evidence.stage)) throw new Error(`无效阶段：${evidence.stage}`)
    const source = String(evidence.source ?? '').trim()
    if (!source) throw new Error('执行证据必须给出来源（文件/公告/数据）')
    const at = String(evidence.at ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) throw new Error(`日期格式应为 YYYY-MM-DD：${at}`)
    const existing = this.get(policyId)
    const entry: StageEvidence = {
      stage: evidence.stage,
      at,
      source,
      ...(evidence.note ? { note: String(evidence.note) } : {}),
      ...(evidence.amount ? { amount: String(evidence.amount) } : {}),
    }
    const now = new Date().toISOString()
    const next: ExecutionRecord = existing
      ? { ...existing, evidence: [...existing.evidence, entry], updatedAt: now }
      : { policyId, createdAt: now, updatedAt: now, evidence: [entry] }
    this.records = existing
      ? this.records.map((r) => (r.policyId === policyId ? next : r))
      : [...this.records, next]
    await this.persist()
    return next
  }

  async remove(policyId: string): Promise<boolean> {
    const before = this.records.length
    this.records = this.records.filter((r) => r.policyId !== policyId)
    if (this.records.length === before) return false
    await this.persist()
    return true
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: ExecutionFile = { version: 1, updatedAt: new Date().toISOString(), records: this.all() }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
