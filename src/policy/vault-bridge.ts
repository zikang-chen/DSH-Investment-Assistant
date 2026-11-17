/**
 * Bridge from the policy library into the research vault (投研资料库).
 *
 * Collected policies are mirrored as `kind: policy` notes so they show up in the
 * panel's 资料 tab with the same editing/search/sync behaviour as every other
 * research item — one knowledge base, not two silos. Mirroring is idempotent:
 * the `kp:<policyId>` tag identifies the note, and a revision appends a
 * timestamped note instead of overwriting the previous judgement.
 */
import type { ResearchVault, ResearchItem } from '../research/store.js'
import { policyEvidenceLevel, EVIDENCE_LABEL, citationCaveat } from './evidence.js'
import { excerpt, type PolicyDocument } from './types.js'

/** Tag that ties a vault note to its policy document (also used for lookup). */
export function policyTag(docId: string): string {
  return `kp:${docId}`
}

const DOC_TYPE_LABEL: Record<string, string> = {
  'party-meeting': '中央会议通稿',
  'government-report': '政府工作报告',
  'five-year-plan': '五年规划',
  'state-council-doc': '国务院文件',
  'ministry-doc': '部委文件',
  'white-paper': '白皮书',
  'fiscal-report': '财政报告',
  'monetary-report': '货币政策报告',
  'industry-plan': '产业规划',
  'regulation-draft': '征求意见稿',
  regulation: '监管规则',
  'listed-filing': '上市公司公告',
  speech: '讲话',
  statistics: '统计数据',
  other: '其他',
}

export function docTypeLabel(docType: string): string {
  return DOC_TYPE_LABEL[docType] ?? docType
}

/** Markdown body for the vault note: metadata, citable paragraphs, open questions. */
export function renderPolicyMarkdown(doc: PolicyDocument): string {
  const grade = policyEvidenceLevel(doc)
  const lines: string[] = []
  lines.push(`> 政策库自动归档 · ${doc.issuer || '未知机关'} · ${doc.publishedAt || '发布日期未知'} · ${docTypeLabel(doc.docType)} · 证据 ${grade.level}`)
  lines.push('')
  lines.push(`- 原文：${doc.canonicalUrl}`)
  lines.push(`- 政策库 id：\`${doc.id}\`（版本 v${doc.version}）`)
  if (doc.documentNumber) lines.push(`- 文号：${doc.documentNumber}`)
  lines.push(`- 状态：${doc.status} ／ 效力：${doc.legalEffect}`)
  const caveat = citationCaveat(doc)
  if (caveat) lines.push(`- ⚠️ ${caveat}`)
  lines.push('')
  if (grade.reasons.length > 0) {
    lines.push(`**证据强度（${grade.level}）**：${EVIDENCE_LABEL[grade.level]}。`)
    for (const reason of grade.reasons.slice(0, 4)) lines.push(`- ${reason}`)
    lines.push('')
  }
  if (doc.measurableTargets.length > 0 || doc.policyGoals.length > 0) {
    lines.push('## 可量化目标')
    for (const t of [...doc.measurableTargets, ...doc.policyGoals].slice(0, 8)) {
      const value = t.value ? `${t.value}${t.unit ?? ''}` : '（未给出数值）'
      const anchor = typeof t.paragraph === 'number' ? `（原文第 ${t.paragraph + 1} 段）` : ''
      lines.push(`- ${t.metric}：${value}${t.deadline ? `，期限 ${t.deadline}` : ''}${anchor}`)
    }
    lines.push('')
  }
  if (doc.policyMeasures.length > 0) {
    lines.push('## 政策措施与传导渠道')
    for (const m of doc.policyMeasures.slice(0, 8)) {
      const anchor = typeof m.paragraph === 'number' ? `（原文第 ${m.paragraph + 1} 段）` : ''
      lines.push(`- [${m.channel}] ${m.text}${m.funding ? `，资金：${m.funding}` : ''}${anchor}`)
    }
    lines.push('')
  }
  if (doc.fundingMechanism) lines.push(`**资金机制**：${doc.fundingMechanism}`, '')
  if (doc.executionResponsibility) lines.push(`**执行责任**：${doc.executionResponsibility}`, '')
  const key = doc.paragraphs.slice(0, 6)
  if (key.length > 0) {
    lines.push('## 原文摘录（可引用）')
    for (const [i, p] of key.entries()) lines.push(`- 【第 ${i + 1} 段】${excerpt(p, 220)}`)
    lines.push('')
  }
  if (doc.implementationIndicators.length > 0) {
    lines.push('## 后续观察指标')
    for (const ind of doc.implementationIndicators) lines.push(`- ${ind}`)
    lines.push('')
  }
  lines.push('## 待补充')
  lines.push('- 政策原文全文与版本历史见政策库（面板「政策」页或 `policy_get`）。')
  if (doc.parseStatus !== 'ok') lines.push(`- 解析状态：${doc.parseStatus} — ${doc.parseError || '未抽取正文'}`)
  lines.push('- 本文仅为资料归档，不构成任何买卖建议。')
  return lines.join('\n')
}

export interface MirrorResult {
  id: string
  action: 'created' | 'updated' | 'unchanged'
}

/** Create or refresh the vault note for one policy document. */
export async function mirrorPolicyToVault(vault: ResearchVault, doc: PolicyDocument): Promise<MirrorResult> {
  const grade = policyEvidenceLevel(doc)
  const summary = `政策 · ${docTypeLabel(doc.docType)} · 证据 ${grade.level} · v${doc.version}`
  const title = `${doc.title}`.slice(0, 120)
  const tags = ['政策', docTypeLabel(doc.docType), policyTag(doc.id)]
  if (doc.documentNumber) tags.push(doc.documentNumber)
  const existing: ResearchItem | undefined = vault.list({ tag: policyTag(doc.id), limit: 1 })[0]

  if (!existing) {
    const item = await vault.create({
      title,
      kind: 'policy',
      source: doc.issuer || '官方发布',
      occurredAt: doc.publishedAt || doc.fetchedAt.slice(0, 10),
      sourceUrl: doc.canonicalUrl,
      codes: doc.relatedAssets,
      tags,
      summary,
      body: renderPolicyMarkdown(doc),
      status: 'inbox',
      origin: 'chat',
    })
    return { id: item.id, action: 'created' }
  }

  // A revision or newly extracted structure: append evidence, never rewrite history.
  const versionTag = existing.tags.find((t) => t.startsWith('kpv:'))
  const previousVersion = versionTag ? Number(versionTag.slice(4)) : 0
  if (doc.version > previousVersion || existing.summary !== summary) {
    const nextTags = [...new Set([...existing.tags.filter((t) => !t.startsWith('kpv:')), `kpv:${doc.version}`, ...tags])]
    await vault.update(existing.id, { tags: nextTags, summary, codes: [...new Set([...existing.codes, ...doc.relatedAssets])] })
    await vault.addNote(
      existing.id,
      `政策库更新（v${doc.version}）：${doc.title}｜${doc.publishedAt || '日期未知'}｜证据 ${grade.level}｜原文 ${doc.canonicalUrl}`,
      '政策库',
    )
    return { id: existing.id, action: 'updated' }
  }
  return { id: existing.id, action: 'unchanged' }
}
