/**
 * Cross-asset policy brief.
 *
 * Assembled deterministically from what the stores already hold — no network, no
 * invention. Every section says what it could not see instead of leaving a blank,
 * so a quiet week reads as "no new policy" rather than "all good".
 */
import { policyEvidenceLevel } from './evidence.js'
import { executionProgress, STAGE_LABEL } from './execution.js'
import type { ExecutionStore } from './execution.js'
import type { PolicyThesisStore } from './thesis.js'
import type { PolicyStore } from './store.js'
import { excerpt, type PolicyDocument } from './types.js'
import type { PortfolioStore } from '../store.js'

export interface BriefSection {
  title: string
  items: string[]
  /** What this section could not determine. */
  missing?: string
}

export interface PolicyBrief {
  title: string
  generatedAt: string
  windowDays: number
  stats: { policies: number; newPolicies: number; thesesActive: number; thesesDue: number; tracked: number; stale: number }
  sections: BriefSection[]
  markdown: string
}

export interface BriefOptions {
  store: PolicyStore
  theses?: PolicyThesisStore
  execution?: ExecutionStore
  portfolio?: PortfolioStore
  /** Lookback window in days (default 7). */
  days?: number
  /** Current time injection for tests. */
  now?: Date
  /** Consider theses due for review after this many days without a review (default 14). */
  reviewEveryDays?: number
}

const EVIDENCE_ORDER: Record<string, number> = { E1: 0, E2: 1, E3: 2, unverified: 3 }

function dayDiff(fromIso: string, nowMs: number): number {
  const at = Date.parse(fromIso)
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.round((nowMs - at) / 86_400_000))
}

/** Build the brief; pure apart from reading the passed-in stores. */
export function buildPolicyBrief(opts: BriefOptions): PolicyBrief {
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()
  const days = Math.max(1, Math.min(90, opts.days ?? 7))
  const reviewEvery = Math.max(1, opts.reviewEveryDays ?? 14)
  const generatedAt = now.toISOString()

  const all = opts.store.all()
  const recent = all
    .filter((doc) => {
      const stamp = doc.publishedAt || doc.fetchedAt
      return stamp ? dayDiff(stamp, nowMs) <= days : false
    })
    .sort((a, b) => (EVIDENCE_ORDER[policyEvidenceLevel(a).level] ?? 9) - (EVIDENCE_ORDER[policyEvidenceLevel(b).level] ?? 9)
      || (b.publishedAt || '').localeCompare(a.publishedAt || ''))

  const sections: BriefSection[] = []

  sections.push({
    title: `近 ${days} 天政策`,
    items: recent.length === 0
      ? ['本期没有新入库政策文件。']
      : recent.slice(0, 8).map((doc) => {
        const grade = policyEvidenceLevel(doc)
        return `- [${grade.level}] ${doc.title}（${doc.issuer || '机关未知'}，${doc.publishedAt || '日期未知'}）${doc.fundingMechanism ? `；资金：${excerpt(doc.fundingMechanism, 60)}` : ''}`
      }),
    ...(recent.length === 0 ? { missing: '若预期有政策发布，检查来源是否启用（面板「数据源」/ config.policy.sources）。' } : {}),
  })

  // Execution: stalled policies first.
  const execRecords = opts.execution?.all() ?? []
  const execRows = execRecords.map((record) => {
    const doc = opts.store.get(record.policyId)
    return { record, doc, progress: executionProgress(record, doc?.docType ?? 'other', nowMs) }
  })
  const stalled = execRows.filter((row) => row.progress.stale)
  sections.push({
    title: '执行进展',
    items: execRecords.length === 0
      ? ['尚无执行阶段的证据记录（用 policy_execution record 登记）。']
      : execRows.slice(0, 8).map((row) => `- ${row.doc?.title ?? row.record.policyId}：已到「${STAGE_LABEL[row.progress.stage === 'none' ? 'announced' : row.progress.stage]}」，下一步「${row.progress.nextExpected ? STAGE_LABEL[row.progress.nextExpected] : '—'}」${row.progress.stale ? '（停滞，需复核）' : ''}`),
    ...(execRecords.length === 0 ? { missing: '没有登记配套细则/预算/拨付证据，因此无法判断政策是否真在执行。' } : {}),
  })
  if (stalled.length > 0) {
    sections.push({
      title: '停滞预警',
      items: stalled.map((row) => `- ${row.doc?.title ?? row.record.policyId}：${row.progress.note}`),
    })
  }

  // Theses due for review.
  const theses = opts.theses?.all() ?? []
  const active = theses.filter((t) => t.status === 'active')
  const due = active.filter((t) => {
    const last = t.reviews[t.reviews.length - 1]?.at ?? t.createdAt
    return dayDiff(last, nowMs) >= reviewEvery
  })
  sections.push({
    title: '待复核假设',
    items: due.length === 0
      ? ['没有到期未复核的假设。']
      : due.slice(0, 8).map((t) => `- ${t.title}：距上次复核 ${dayDiff(t.reviews[t.reviews.length - 1]?.at ?? t.createdAt, nowMs)} 天｜原判断：${excerpt(t.hypothesis, 70)}`),
    ...(theses.length === 0 ? { missing: '还没有保存任何研究假设（用 policy_thesis create）。' } : {}),
  })

  // Portfolio exposure to the recent policies (code-level only, deliberately).
  const holdings = opts.portfolio?.get().holdings ?? []
  const watchlist = opts.portfolio?.get().watchlist ?? []
  const codes = new Set([...holdings, ...watchlist].map((item) => item.code))
  const exposed: string[] = []
  for (const doc of recent) {
    const hit = doc.relatedAssets.filter((code) => codes.has(code))
    if (hit.length > 0) exposed.push(`- ${doc.title}：持仓/自选命中 ${hit.join('、')}`)
  }
  sections.push({
    title: '组合暴露（仅代码级）',
    items: exposed.length === 0
      ? ['本期政策尚未标注与持仓/自选重合的标的。']
      : exposed,
    missing: '行业级暴露需要公司业务证据（年报/订单），代码命中不等于受益。',
  })

  const stats = {
    policies: all.length,
    newPolicies: recent.length,
    thesesActive: active.length,
    thesesDue: due.length,
    tracked: execRecords.length,
    stale: stalled.length,
  }

  const markdown = renderBriefMarkdown({ generatedAt, days, sections, stats })

  return {
    title: `政策研究简报（${now.toISOString().slice(0, 10)}）`,
    generatedAt,
    windowDays: days,
    stats,
    sections,
    markdown,
  }
}

function renderBriefMarkdown(input: {
  generatedAt: string
  days: number
  sections: BriefSection[]
  stats: PolicyBrief['stats']
}): string {
  const lines: string[] = []
  lines.push(`# 政策研究简报（${input.generatedAt.slice(0, 10)}）`)
  lines.push('')
  lines.push(`> 窗口 ${input.days} 天｜政策库 ${input.stats.policies} 篇（本期新增 ${input.stats.newPolicies}）｜活跃假设 ${input.stats.thesesActive}（到期 ${input.stats.thesesDue}）｜执行跟踪 ${input.stats.tracked}（停滞 ${input.stats.stale}）`)
  lines.push('')
  for (const section of input.sections) {
    lines.push(`## ${section.title}`)
    for (const item of section.items) lines.push(item)
    if (section.missing) lines.push(`> 缺口：${section.missing}`)
    lines.push('')
  }
  lines.push('---')
  lines.push('本简报由本地政策库与持仓数据自动合成，不构成投资建议；缺失项已显式标注，未用推测填补。')
  return lines.join('\n')
}

/** Compact row list for tools that need doc summaries. */
export function briefPolicyRow(doc: PolicyDocument) {
  const grade = policyEvidenceLevel(doc)
  return {
    id: doc.id,
    title: doc.title,
    issuer: doc.issuer,
    publishedAt: doc.publishedAt,
    docType: doc.docType,
    status: doc.status,
    evidence: grade.level,
  }
}
