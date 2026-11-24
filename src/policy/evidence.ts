/**
 * Evidence grading for policy research.
 *
 * Prevents the classic failure mode "政策支持 = 行业上涨 = 买入": a strategic
 * statement and a funded, quantified measure must never be treated as equally
 * strong evidence. The grade is derived only from what the source text says,
 * never from market reaction.
 */
import type { PolicyDocument } from './types.js'
import { policyBodyIssue } from './body-quality.js'

export const EVIDENCE_LEVELS = ['E1', 'E2', 'E3', 'unverified'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  E1: '原文给出资金规模 / 数量目标 / 时间表',
  E2: '原文给出执行责任或配套路径，但无量化',
  E3: '仅有战略表述（鼓励、支持、大力发展）',
  unverified: '尚未做结构化提取（不能用于判断受益）',
}

const MONEY_RE = /\d[\d,.]*\s*(?:亿|万亿|万|千)?\s*元/
const QUANT_RE = /\d[\d,.]*\s*(?:%|％|GW|MW|万千瓦|亿吨|万吨|万辆|万台|个|项|家)/

/** True when a value string carries a concrete number (not a placeholder). */
export function hasQuantity(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim()
  if (!v || /^(?:无|待定|未披露|-|—|N\/A)$/i.test(v)) return false
  return /\d/.test(v)
}

/** Grade how strong this document's evidence is, from extracted fields only. */
export function policyEvidenceLevel(doc: PolicyDocument): { level: EvidenceLevel; reasons: string[] } {
  const issue = policyBodyIssue(doc)
  if (issue) return { level: 'unverified', reasons: [issue] }
  const reasons: string[] = []
  const extracted = Boolean(doc.extractionVersion) ||
    doc.policyGoals.length > 0 ||
    doc.policyMeasures.length > 0 ||
    doc.measurableTargets.length > 0
  if (!extracted) return { level: 'unverified', reasons: ['未做结构化提取'] }

  const quantifiedTargets = doc.measurableTargets.filter((t) => hasQuantity(t.value))
  if (quantifiedTargets.length > 0) {
    reasons.push(`有 ${quantifiedTargets.length} 项可量化目标：${quantifiedTargets.slice(0, 3).map((t) => `${t.metric}=${t.value ?? ''}${t.unit ?? ''}`).join('；')}`)
  }
  if (doc.fundingMechanism && MONEY_RE.test(doc.fundingMechanism)) {
    reasons.push(`资金机制含明确金额：${doc.fundingMechanism.slice(0, 80)}`)
  }
  const fundedMeasures = doc.policyMeasures.filter((m) => m.funding && MONEY_RE.test(m.funding))
  if (fundedMeasures.length > 0) reasons.push(`${fundedMeasures.length} 条措施标明资金`)
  if (reasons.length > 0) return { level: 'E1', reasons }

  if (doc.executionResponsibility || doc.policyMeasures.some((m) => m.responsible) || doc.measurableTargets.length > 0) {
    if (doc.executionResponsibility) reasons.push(`执行责任：${doc.executionResponsibility.slice(0, 80)}`)
    if (doc.policyMeasures.some((m) => m.responsible)) reasons.push('措施标注了负责机构')
    if (doc.measurableTargets.length > 0) reasons.push('有目标但无可核验数值')
    return { level: 'E2', reasons }
  }

  const quantifiedInText = doc.paragraphs.find((p) => MONEY_RE.test(p) || QUANT_RE.test(p))
  if (quantifiedInText) reasons.push('原文含数字，但尚未抽取为结构化目标')
  if (doc.policyGoals.length > 0) reasons.push('只有方向性目标')
  return { level: 'E3', reasons: reasons.length > 0 ? reasons : ['只有战略表述'] }
}

/**
 * Two policies are comparable evidence only when both are normative/in-force
 * documents; a draft must never be cited as an active rule.
 */
export function citationCaveat(doc: PolicyDocument): string {
  const parts: string[] = []
  if (doc.status === 'draft') parts.push('这是征求意见稿，内容可能被修改，不能当作已生效规则引用。')
  if (doc.status === 'announced' && doc.legalEffect === 'normative') parts.push('文件已发布，请确认生效日期后再谈「已生效」。')
  if (doc.legalEffect === 'statement') parts.push('这是讲话/通稿，只表明方向与优先级，不产生可执行义务。')
  if (doc.parseStatus === 'pdf-pending') parts.push('原文为 PDF，正文尚未抽取；引用前必须人工核对页码。')
  if (doc.parseStatus === 'failed') parts.push(`正文解析失败：${doc.parseError || '原因未知'}；只能用原始链接引用。`)
  return parts.join(' ')
}
