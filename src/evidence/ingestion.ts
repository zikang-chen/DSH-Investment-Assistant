/**
 * Evidence ingestion + validation.
 *
 * Ingestion turns whatever the user handed over (link / text / file / typed
 * values) into one submission record with a content hash and a parse verdict.
 * Validation then decides how strong that material is — and it deliberately
 * cannot invent strength:
 *
 * - an official-domain link is `source-clear-unverified`, never `official-verified`
 *   (we can see the host, not the authenticity of what was served);
 * - a PDF / spreadsheet / screenshot is `parse-questionable` because we only keep
 *   the bytes, not a verified reading;
 * - typed numbers are `user-provided-unconfirmed` but keep units/period/source
 *   exactly as entered.
 *
 * Everything fetched or uploaded is untrusted input: it is stored and quoted, and
 * instructions inside it are never executed.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cleanArticleParagraphs, decodeBody, detectPayloadKind, htmlToText } from '../policy/extract.js'
import { splitParagraphs } from '../policy/types.js'
import type { EvidenceRepository } from './repository.js'
import {
  isIsoDay,
  normalizeSourceType,
  type EvidenceRequest,
  type EvidenceStatus,
  type EvidenceSubmission,
  type ExtractedValue,
  type SubmitInput,
  type SubmissionSourceType,
} from './schema.js'

/** Domains whose content we treat as "source clear" once the user points us at it. */
const OFFICIAL_SUFFIX = /(?:^|\.)(gov\.cn|csrc\.gov\.cn|pbc\.gov\.cn|stats\.gov\.cn|mof\.gov\.cn|mofcom\.gov\.cn|miit\.gov\.cn|ndrc\.gov\.cn|sse\.com\.cn|szse\.cn|cninfo\.com\.cn)$/i

export interface IngestOptions {
  timeoutMs?: number
  maxBytes?: number
}

export interface IngestResult {
  submission: EvidenceSubmission
  /** True when the request's expected period/units were satisfied by this material. */
  issues: string[]
}

function guessSourceType(input: SubmitInput, filePath?: string): SubmissionSourceType {
  if (input.sourceType) return normalizeSourceType(input.sourceType)
  if (input.values && input.values.length > 0) return 'manual-values'
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.pdf') return 'pdf'
    if (ext === '.csv') return 'csv'
    if (ext === '.xlsx' || ext === '.xls') return 'excel'
    if (ext === '.md') return 'markdown'
    return 'text'
  }
  if (input.url) return 'official-url'
  return 'text'
}

function isOfficialHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return OFFICIAL_SUFFIX.test(host)
  } catch {
    return false
  }
}

async function fetchEvidenceUrl(url: string, opts: IngestOptions): Promise<{ buffer: Buffer; contentType: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https 链接')
  const timeoutMs = Math.max(1000, Math.min(60_000, opts.timeoutMs ?? 20_000))
  const maxBytes = Math.max(64 * 1024, Math.min(32_000_000, opts.maxBytes ?? 16_000_000))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dsh-finance-evidence/0.1', Accept: 'text/html,application/pdf,text/plain,*/*' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > maxBytes) throw new Error(`文件过大（${declared} 字节）`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new Error(`文件过大（${buffer.byteLength} 字节）`)
    return { buffer, contentType: (res.headers.get('content-type') ?? '').toLowerCase() }
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') throw new Error(`抓取超时（${timeoutMs}ms）`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function normalizeValues(input: SubmitInput['values']): ExtractedValue[] {
  return (input ?? []).map((item) => ({
    name: String(item.name ?? '').trim(),
    value: String(item.value ?? '').trim(),
    ...(item.unit ? { unit: String(item.unit).trim() } : {}),
    ...(item.period ? { period: String(item.period).trim() } : {}),
    ...(item.source ? { source: String(item.source).trim() } : {}),
  })).filter((v) => v.name && v.value)
}

/**
 * Build a submission. Throws only for unusable input (nothing to store);
 * everything else becomes a stored submission with issues, so the research trail
 * shows what was handed over even when it cannot be used.
 */
export async function buildSubmission(
  repo: EvidenceRepository,
  request: EvidenceRequest,
  input: SubmitInput,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const issues: string[] = []
  const filePath = input.filePath ? String(input.filePath) : undefined
  const sourceType = guessSourceType(input, filePath)
  const sourceUrl = String(input.url ?? '').trim()
  const note = String(input.note ?? '').trim()
  let documentDate = String(input.documentDate ?? '').trim()
  const reportingPeriod = String(input.reportingPeriod ?? '').trim()
  const units = String(input.units ?? '').trim()

  let buffer: Buffer
  let contentType = ''
  let parsedContent = ''
  let extractionConfidence: EvidenceSubmission['extractionConfidence'] = 'high'
  let verificationMethod = ''
  let originalFileRef = ''
  let values = normalizeValues(input.values)

  if (sourceUrl) {
    const fetched = await fetchEvidenceUrl(sourceUrl, opts)
    buffer = fetched.buffer
    contentType = fetched.contentType
    const kind = detectPayloadKind(contentType, buffer)
    if (kind === 'html') {
      const html = decodeBody(buffer, contentType)
      const cleaned = cleanArticleParagraphs(splitParagraphs(htmlToText(html)))
      parsedContent = cleaned.paragraphs.join('\n\n').slice(0, 20_000)
      if (!parsedContent) issues.push('网页正文为空（可能依赖脚本渲染）')
      verificationMethod = 'url-fetch:html'
    } else if (kind === 'pdf') {
      parsedContent = ''
      issues.push('PDF 只保存了原文，未抽取正文：引用前必须人工核对页码')
      extractionConfidence = 'low'
      verificationMethod = 'url-fetch:pdf-bytes-only'
    } else {
      parsedContent = decodeBody(buffer, contentType).slice(0, 20_000)
      verificationMethod = 'url-fetch:text'
    }
    originalFileRef = await repo.saveAttachment(buffer, kind === 'pdf' ? 'pdf' : 'html', repo.hashBytes(buffer))
    if (!documentDate) {
      const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(parsedContent.slice(0, 800))
      if (m) documentDate = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
    }
  } else if (filePath) {
    buffer = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.pdf') {
      parsedContent = ''
      issues.push('PDF 只保存了原文，未抽取正文：引用前必须人工核对页码')
      extractionConfidence = 'low'
      verificationMethod = 'file:pdf-bytes-only'
    } else if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
      parsedContent = ext === '.csv' ? buffer.toString('utf8').slice(0, 20_000) : ''
      if (ext !== '.csv') issues.push('Excel 未解析单元格：请改用 CSV 或手工输入关键数值')
      extractionConfidence = ext === '.csv' ? 'medium' : 'low'
      verificationMethod = `file:${ext.slice(1)}`
    } else {
      parsedContent = buffer.toString('utf8').slice(0, 20_000)
      verificationMethod = `file:${ext.replace('.', '') || 'text'}`
    }
    originalFileRef = await repo.saveAttachment(buffer, ext.replace('.', '') || 'txt', repo.hashBytes(buffer))
  } else if (input.text) {
    buffer = Buffer.from(String(input.text), 'utf8')
    parsedContent = String(input.text).slice(0, 20_000)
    verificationMethod = 'user-text'
  } else if (values.length > 0) {
    buffer = Buffer.from(JSON.stringify(values), 'utf8')
    verificationMethod = 'user-values'
  } else {
    throw new Error('需要 url / text / filePath / values 之一')
  }

  const contentHash = repo.hashBytes(buffer)

  // Duplicate submission for the same request: return the existing record's facts.
  const duplicate = repo.submissionsFor(request.requestId).find((s) => s.contentHash === contentHash)
  if (duplicate) {
    return { submission: duplicate, issues: ['相同内容已提交过（内容哈希一致），未重复保存'] }
  }

  if (!isIsoDay(documentDate)) {
    issues.push('缺少文档日期（YYYY-MM-DD）：无法判断证据时效')
  }
  if (request.expectedReportingPeriod && !reportingPeriod) {
    issues.push(`缺少统计期间（期望：${request.expectedReportingPeriod}）`)
  }
  if (request.requiredUnits && !units) {
    issues.push(`缺少单位（期望：${request.requiredUnits}）`)
  }
  for (const value of values) {
    if (/\d/.test(value.value) && !value.unit) issues.push(`数值「${value.name}」没有单位`)
    if (!value.source && !note && !sourceUrl) issues.push(`数值「${value.name}」没有出处`)
  }
  if (sourceType === 'screenshot') {
    issues.push('截图内容需人工确认后才能作为证据使用')
    extractionConfidence = 'low'
  }

  let evidenceStatus: EvidenceStatus
  if (sourceType === 'official-url' && isOfficialHost(sourceUrl) && extractionConfidence !== 'low') {
    evidenceStatus = 'source-clear-unverified'
  } else if (extractionConfidence === 'low') {
    evidenceStatus = 'parse-questionable'
  } else if (values.length > 0) {
    evidenceStatus = 'user-provided-unconfirmed'
  } else {
    evidenceStatus = 'user-provided-unconfirmed'
  }

  const submission: EvidenceSubmission = {
    submissionId: repo.newSubmissionId(),
    requestId: request.requestId,
    submittedAt: new Date().toISOString(),
    sourceType,
    sourceUrl,
    documentDate,
    reportingPeriod,
    units,
    note,
    contentHash,
    originalFileRef,
    parsedContent,
    extractedValues: values,
    extractionConfidence,
    independentlyVerified: false,
    verificationMethod,
    evidenceStatus,
    verdict: 'pending',
    issues: [...new Set(issues)],
    checkedAt: '',
  }
  await repo.saveSubmission(submission)
  return { submission, issues: submission.issues }
}

export interface ValidationResult {
  submissionId: string
  ok: boolean
  issues: string[]
  evidenceStatus: EvidenceStatus
  /** Values that are usable for the research step. */
  usableValues: ExtractedValue[]
  note: string
}

/**
 * Decide whether a submission can be used. `humanConfirmed` is the explicit
 * override the resolve tool passes for parse-questionable material — it never
 * upgrades the evidence level to "official".
 */
export function validateSubmission(submission: EvidenceSubmission, opts: { humanConfirmed?: boolean } = {}): ValidationResult {
  const issues = [...submission.issues]
  const blocking = (pattern: RegExp): boolean => issues.some((i) => pattern.test(i))

  if (!submission.parsedContent && submission.extractedValues.length === 0 && !submission.originalFileRef) {
    issues.push('没有任何可读内容')
  }
  if (blocking(/缺少文档日期/)) issues.push('时效无法确认：文档日期缺失')
  if (blocking(/缺少统计期间/)) issues.push('统计口径无法确认：统计期间缺失')
  if (blocking(/缺少单位/)) issues.push('数值口径无法确认：单位缺失')
  if (blocking(/没有出处/)) issues.push('无法追溯出处')

  const needsHuman = submission.evidenceStatus === 'parse-questionable'
    || (submission.extractionConfidence === 'low' && submission.extractedValues.length === 0)
  const humanConfirmed = opts.humanConfirmed === true

  // Hard blockers: these cannot be overridden by a confirmation flag.
  const hardBlocked = blocking(/缺少文档日期/) || blocking(/缺少统计期间/) || blocking(/缺少单位/) || blocking(/没有出处/)
  const ok = !hardBlocked && (!needsHuman || humanConfirmed)

  const note = ok
    ? needsHuman
      ? '已由人工确认解析结果，仍属于「解析存疑后人工确认」，不等于官方核验'
      : '校验通过：证据可用于研究，但来源等级见 evidenceStatus'
    : needsHuman && !humanConfirmed
      ? '解析存疑，需要人工确认（在 resolve 时传 humanConfirmed=true）'
      : '校验未通过：请补齐上述缺失字段后重新提交'

  return {
    submissionId: submission.submissionId,
    ok,
    issues: [...new Set(issues)],
    evidenceStatus: submission.evidenceStatus,
    usableValues: ok ? submission.extractedValues : [],
    note,
  }
}
