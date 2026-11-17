/**
 * China policy intelligence — data model.
 *
 * Design rules encoded here (see docs/policy-intelligence.md):
 * - A document's *status* (announced / in-force / superseded …) and its *legal
 *   effect* (statement / normative / law …) are separate axes; never collapse
 *   them into one "importance" score.
 * - Every stored field that matters for research carries a provenance anchor
 *   (paragraph index) so a claim can be traced back to the original text.
 * - Model-extracted fields (`policy_goals`, `policy_measures`, …) are marked by
 *   `extractionVersion` and `humanReviewStatus`; they never override the source.
 */

/** Where a document came from, in descending order of evidentiary weight. */
export const POLICY_SOURCE_CLASSES = ['official', 'official-media', 'exchange', 'intermediary'] as const
export type PolicySourceClass = (typeof POLICY_SOURCE_CLASSES)[number]

/** Document genre. Deliberately granular: 讲话 ≠ 规划 ≠ 规范性文件. */
export const POLICY_DOC_TYPES = [
  'party-meeting', // 中央经济工作会议 / 政治局会议通稿
  'government-report', // 政府工作报告
  'five-year-plan', // 五年规划建议 / 纲要
  'state-council-doc', // 国务院文件（国发/国办发）
  'ministry-doc', // 部委文件
  'white-paper', // 白皮书
  'fiscal-report', // 预算 / 财政政策执行报告
  'monetary-report', // 货币政策执行报告 / 金融统计
  'industry-plan', // 产业规划 / 实施方案 / 配套细则
  'regulation-draft', // 征求意见稿
  'regulation', // 正式监管规则
  'listed-filing', // 上市公司公告 / 定期报告
  'speech', // 讲话
  'statistics', // 统计公报 / 数据发布
  'other',
] as const
export type PolicyDocType = (typeof POLICY_DOC_TYPES)[number]

/** Lifecycle status. Independent from {@link PolicyLegalEffect}. */
export const POLICY_STATUSES = [
  'announced', // 已发布
  'draft', // 征求意见中
  'in-force', // 已生效
  'executing', // 执行中（有配套/资金/项目证据）
  'implemented', // 已落地（有结果数据）
  'superseded', // 被新版替代
  'repealed', // 废止
  'expired', // 到期
  'unknown',
] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

/** Legal effect. A speech is never "normative" no matter who gave it. */
export const POLICY_LEGAL_EFFECTS = [
  'statement', // 表态/通稿
  'strategic-guidance', // 规划、纲要、白皮书
  'recommendation', // 建议
  'draft-consultation', // 征求意见稿
  'normative', // 规范性文件
  'law', // 法律/行政法规
  'result-report', // 执行结果报告
  'unknown',
] as const
export type PolicyLegalEffect = (typeof POLICY_LEGAL_EFFECTS)[number]

/** Human review state for model-extracted fields. */
export const POLICY_REVIEW_STATES = ['unreviewed', 'reviewed', 'disputed'] as const
export type PolicyReviewState = (typeof POLICY_REVIEW_STATES)[number]

/** One discovering endpoint in the official allowlist. */
export interface PolicySource {
  /** Stable id, e.g. `gov-cn-policy`. */
  id: string
  label: string
  /** Only these hosts may be fetched for this source (allowlist). */
  hosts: string[]
  sourceClass: PolicySourceClass
  issuer: string
  /** `rss` = feed, `list` = index page we scan for document links, `manual` = upload only. */
  kind: 'rss' | 'list' | 'manual'
  /** Feed or index URL. */
  url?: string
  /** Index-page link filter (regular expression source, tested against href). */
  linkPattern?: string
  /** Default document type for links found here. */
  docType?: PolicyDocType
  /** Disabled by default when the site's terms are unclear. */
  enabled: boolean
  /** Minimum seconds between two requests to this source. */
  minIntervalSec: number
  /** Why disabled / any access note shown to the user. */
  note?: string
}

/** A measurable target extracted from the document. */
export interface PolicyTarget {
  metric: string
  value?: string
  unit?: string
  deadline?: string
  /** Paragraph index in `source_paragraphs` backing this target. */
  paragraph?: number
}

/** A measure with the mechanism it is supposed to work through. */
export interface PolicyMeasure {
  text: string
  /** fiscal | monetary | investment | consumption | regulation | trade | industry | other */
  channel: string
  funding?: string
  responsible?: string
  paragraph?: number
}

/** Structured record persisted for every policy document. */
export interface PolicyDocument {
  id: string
  /** Canonical URL used as identity for reposts. */
  canonicalUrl: string
  /** Every URL this document was seen at (reposts, mirrors). */
  sourceUrls: string[]
  title: string
  issuer: string
  documentNumber: string
  docType: PolicyDocType
  sourceClass: PolicySourceClass
  sourceId: string
  publishedAt: string
  effectiveAt: string
  expiredAt: string
  fetchedAt: string
  lastVerifiedAt: string
  status: PolicyStatus
  legalEffect: PolicyLegalEffect
  geographicScope: string
  relatedIndustries: string[]
  relatedAssets: string[]
  contentHash: string
  /** Stable identity across revisions: issuer + document number, else title + publish day. */
  docKey: string
  version: number
  /** Prior revisions, newest first. Full text of old revisions lives in `history/`. */
  previousVersions: Array<{ version: number; contentHash: string; fetchedAt: string; originalPath: string; documentPath: string }>
  /** Full text (normalized, line-broken). */
  text: string
  /** Paragraph slices so every extracted field can point back to the source. */
  paragraphs: string[]
  /** Immutable raw snapshot on disk (never rewritten). */
  originalPath: string
  originalBytes: number
  originalContentType: string
  pageReferences: Array<{ page?: number; section?: string; paragraph?: number }>
  relatedPolicyIds: string[]
  supersededBy: string
  /** Model/agent extraction — always anchored, never authoritative. */
  policyGoals: PolicyTarget[]
  policyMeasures: PolicyMeasure[]
  fundingMechanism: string
  executionResponsibility: string
  measurableTargets: PolicyTarget[]
  implementationIndicators: string[]
  extractionVersion: string
  humanReviewStatus: PolicyReviewState
  parseStatus: 'ok' | 'pdf-pending' | 'failed'
  parseError: string
  tags: string[]
}

/** What a collector hands to the store (identity/derived fields filled by the store). */
export type PolicyDocumentInput = Partial<PolicyDocument> &
  Pick<PolicyDocument, 'title' | 'canonicalUrl'> & {
    sourceId: string
    sourceClass: PolicySourceClass
    issuer: string
    docType: PolicyDocType
    text: string
    contentHash: string
    originalPath: string
  }

/** Search filter accepted by `policy_search` and the panel. */
export interface PolicyQuery {
  query?: string
  issuer?: string
  docType?: PolicyDocType
  status?: PolicyStatus
  legalEffect?: PolicyLegalEffect
  sourceId?: string
  industry?: string
  tag?: string
  /** Inclusive ISO day lower bound on `publishedAt`. */
  from?: string
  /** Inclusive ISO day upper bound on `publishedAt`. */
  to?: string
  limit?: number
  /** Include full text in results (default false — list rows stay cheap). */
  withText?: boolean
}

export interface PolicySearchHit {
  score: number
  /** Why it matched: matched query tokens, for auditability. */
  tokens: string[]
  doc: PolicyDocument
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/

/** Normalize any date-ish value to `YYYY-MM-DD` (empty string when unknown). */
export function isoDay(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  // 2026-03-05 / 2026/3/5 / 2026年3月5日 / 2026.3.5
  const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(raw)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** Full ISO timestamp (defaults to now) — used for fetched/verified stamps. */
export function isoStamp(value?: unknown): string {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

/** Collapse whitespace runs, keep paragraph breaks, drop control characters. */
export function normalizeText(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Title normalization used for repost fingerprints (punctuation/space insensitive). */
export function normalizeTitle(raw: string): string {
  return String(raw ?? '')
    .replace(/[《》〈〉「」『』【】\[\]()（）:：\-—_,，。.!！?？"'“”‘’\s]/g, '')
    .toLowerCase()
}

/** Split normalized text into paragraph slices for citation anchors. */
export function splitParagraphs(text: string): string[] {
  return normalizeText(text)
    .split(/\n{2,}|\n(?=\s*(?:第[一二三四五六七八九十百]+[章节条]|[一二三四五六七八九十]+、|\d+[.、]))/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Trim a paragraph slice to a citation-friendly excerpt. */
export function excerpt(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** True when the string looks like a Chinese government document number. */
export function looksLikeDocumentNumber(value: string): boolean {
  return /(?:国发|国办发|国函|发改|财[政预]?|央行|银发|证监|工信部|商务部|统计局|公告|令)\s*[〔\[(（]?\s*\d{4}\s*[〕\])）]?\s*第?\s*\d+\s*号/.test(value) ||
    /^第?\s*\d+\s*号$/.test(value.trim()) ||
    /^[〔\[(（]\s*\d{4}\s*[〕\])）]\s*\d+\s*号$/.test(value.trim())
}
