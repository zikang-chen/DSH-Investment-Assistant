/**
 * Collection pipeline:
 *   discover → fetch → immutable snapshot → hash → extract → dedupe/version → index
 *
 * Every step that can fail records why. A failed document keeps its snapshot and
 * an error string; it is never silently dropped, and a retry is idempotent
 * because dedupe is keyed on content, not on the run.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import {
  fetchPolicyDocument,
  sha256Hex,
  type FetchOptions,
} from './fetch.js'
import {
  cleanArticleParagraphs,
  decodeBody,
  detectPayloadKind,
  discoverLinks,
  extractHtmlMeta,
  htmlToText,
  parseFeed,
  type DiscoveredLink,
} from './extract.js'
import type { PolicyStore, UpsertAction } from './store.js'
import {
  isoDay,
  normalizeText,
  splitParagraphs,
  type PolicyDocument,
  type PolicyDocType,
  type PolicySource,
  type PolicySourceClass,
} from './types.js'

export interface CollectDeps {
  store: PolicyStore
  /** Union of allowed hosts for every fetch. */
  hosts: string[]
  timeoutMs: number
  maxBytes: number
  logger?: Logger
  robotsCache?: Map<string, string>
  signal?: AbortSignal
  /** 采集正文时是否检查 robots。默认 false（放行）；显式 true 才检查。 */
  respectRobots?: boolean
}

export interface CollectOneInput {
  url: string
  sourceId: string
  sourceClass: PolicySourceClass
  issuer: string
  docType: PolicyDocType
  titleHint?: string
  publishedHint?: string
}

export interface CollectOneResult {
  url: string
  ok: boolean
  action?: UpsertAction
  doc?: PolicyDocument
  reason?: string
  error?: string
}

export interface CollectRunResult {
  runAt: string
  added: number
  updated: number
  duplicate: number
  failed: number
  results: CollectOneResult[]
}

function fetchOptions(deps: CollectDeps): FetchOptions {
  return {
    hosts: deps.hosts,
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxBytes,
    respectRobots: deps.respectRobots === true,
    robotsCache: deps.robotsCache,
    signal: deps.signal,
  }
}

/** Fetch one URL and upsert it. The only writer of `documents/` for collected content. */
/** 标题清洗：去标签/实体/多余空白，过长截断。标题里残留标签会直接暴露在列表里。 */
function cleanTitle(raw: string | undefined, fallback: string): string {
  const text = String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  return text.length > 120 ? `${text.slice(0, 118)}…` : text
}

export async function collectOne(deps: CollectDeps, input: CollectOneInput): Promise<CollectOneResult> {
  const log = deps.logger?.child('policy.collect')
  try {
    const res = await fetchPolicyDocument(input.url, fetchOptions(deps))
    const kind = detectPayloadKind(res.contentType, res.buffer)
    const rawHash = sha256Hex(res.buffer)
    const original = await deps.store.saveOriginal(res.buffer, res.contentType, rawHash)

    let text = ''
    let paragraphs: string[] = []
    let title = input.titleHint ?? ''
    let publishedAt = isoDay(input.publishedHint)
    let documentNumber = ''
    let issuer = input.issuer
    let parseStatus: PolicyDocument['parseStatus'] = 'ok'
    let parseError = ''

    if (kind === 'pdf') {
      parseStatus = 'pdf-pending'
      parseError = 'PDF 未做文本抽取（中文字体子集无法可靠解码）；原文已保存，可用 policy_import 补充正文'
      title = title || path.basename(new URL(res.url).pathname, '.pdf')
    } else if (kind === 'html') {
      const html = decodeBody(res.buffer, res.contentType)
      const meta = extractHtmlMeta(html, input.titleHint ?? '')
      const cleaned = cleanArticleParagraphs(splitParagraphs(htmlToText(html)))
      paragraphs = cleaned.paragraphs
      // Keep `text` and `paragraphs` in sync; the untouched page lives in the snapshot.
      text = paragraphs.join('\n\n')
      title = cleanTitle(meta.title || title, new URL(res.url).pathname)
      publishedAt = isoDay(meta.publishedAt) || publishedAt
      documentNumber = meta.documentNumber
      issuer = issuer || meta.issuer
    } else if (kind === 'text') {
      text = normalizeText(decodeBody(res.buffer, res.contentType))
      paragraphs = splitParagraphs(text)
      title = cleanTitle(title, new URL(res.url).pathname)
    } else {
      parseStatus = 'failed'
      parseError = `无法识别的响应类型：${res.contentType || '未知'}`
    }

    if (!text && parseStatus === 'ok') {
      parseStatus = 'failed'
      parseError = '正文为空（页面可能依赖脚本渲染）'
    }

    const result = await deps.store.upsert({
      title: title || '未命名政策文件',
      canonicalUrl: res.url,
      sourceUrls: [input.url],
      issuer,
      documentNumber,
      docType: input.docType,
      sourceClass: input.sourceClass,
      sourceId: input.sourceId,
      publishedAt,
      text,
      paragraphs: paragraphs.length > 0 ? paragraphs : splitParagraphs(text),
      contentHash: sha256Hex(`${normalizeText(text)}|${documentNumber}`),
      originalPath: original.path,
      originalBytes: res.bytes,
      originalContentType: res.contentType,
      parseStatus,
      parseError,
    })
    log?.info('collected', { url: res.url, action: result.action, id: result.doc.id })
    return { url: input.url, ok: true, action: result.action, doc: result.doc, reason: result.reason }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log?.warn('collect failed', { url: input.url, error: message })
    return { url: input.url, ok: false, error: message }
  }
}

/** Discover candidate documents on one index page / feed. */
export async function discoverFromSource(deps: CollectDeps, source: PolicySource): Promise<DiscoveredLink[]> {
  if (!source.url || source.kind === 'manual') return []
  const res = await fetchPolicyDocument(source.url, fetchOptions(deps))
  const body = decodeBody(res.buffer, res.contentType)
  if (source.kind === 'rss') return parseFeed(body)
  return discoverLinks(body, res.url, source.linkPattern)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export interface CollectSourceOptions {
  /** Max documents to pull from this source in one run (default 8). */
  limit?: number
  /** Override the per-source request gap. */
  gapMs?: number
  /** Cap on total waiting inside one run (default 12s) so a tool call stays responsive. */
  maxWaitMs?: number
  /** Skip items older than this many days (default 45; 0 disables the filter). */
  maxAgeDays?: number
}

/** Collect every new document listed by one source, newest first. */
export async function collectSource(deps: CollectDeps, source: PolicySource, opts: CollectSourceOptions = {}): Promise<CollectRunResult> {
  const runAt = new Date().toISOString()
  const limit = Math.max(1, Math.min(30, opts.limit ?? 8))
  const gapMs = opts.gapMs ?? source.minIntervalSec * 1000
  const maxWaitMs = opts.maxWaitMs ?? 12_000
  const maxAgeDays = opts.maxAgeDays ?? 45
  const results: CollectOneResult[] = []
  let links: DiscoveredLink[]
  try {
    links = await discoverFromSource(deps, source)
  } catch (err) {
    return {
      runAt,
      added: 0,
      updated: 0,
      duplicate: 0,
      failed: 1,
      results: [{ url: source.url ?? source.id, ok: false, error: err instanceof Error ? err.message : String(err) }],
    }
  }

  // Newest first: feeds are not always ordered, and a 2 MB feed must not make
  // us re-check last year's documents.
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0
  const fresh = links
    .filter((link) => {
      if (deps.store.findByUrl(link.url)) return false
      if (cutoff > 0 && link.publishedAt) {
        const at = Date.parse(link.publishedAt)
        if (Number.isFinite(at) && at < cutoff) return false
      }
      return true
    })
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
    .slice(0, limit)
  let waited = 0
  for (const [index, link] of fresh.entries()) {
    if (index > 0 && waited < maxWaitMs) {
      const wait = Math.min(gapMs, maxWaitMs - waited)
      waited += wait
      await sleep(wait)
    }
    results.push(await collectOne(deps, {
      url: link.url,
      sourceId: source.id,
      sourceClass: source.sourceClass,
      issuer: source.issuer,
      docType: source.docType ?? 'other',
      titleHint: link.title,
      publishedHint: link.publishedAt,
    }))
  }
  return summarize(runAt, results)
}

/** Collect explicit URLs (must still pass the allowlist). */
export async function collectUrls(deps: CollectDeps, urls: string[], opts: {
  sourceId: string
  sourceClass: PolicySourceClass
  issuer: string
  docType: PolicyDocType
}): Promise<CollectRunResult> {
  const runAt = new Date().toISOString()
  const results: CollectOneResult[] = []
  for (const url of urls) {
    results.push(await collectOne(deps, {
      url,
      sourceId: opts.sourceId,
      sourceClass: opts.sourceClass,
      issuer: opts.issuer,
      docType: opts.docType,
    }))
  }
  return summarize(runAt, results)
}

/** Import operator-supplied text (manual upload path for PDFs and paywalled pages). */
export async function importText(deps: CollectDeps, input: {
  title: string
  text: string
  sourceUrl?: string
  issuer?: string
  docType?: PolicyDocType
  publishedAt?: string
  documentNumber?: string
  sourceId?: string
  sourceClass?: PolicySourceClass
  originalBuffer?: Buffer
  originalContentType?: string
  parseStatus?: PolicyDocument['parseStatus']
  parseError?: string
}): Promise<CollectOneResult> {
  const text = normalizeText(input.text)
  const buffer = input.originalBuffer ?? Buffer.from(text, 'utf8')
  const rawHash = sha256Hex(buffer)
  const original = await deps.store.saveOriginal(buffer, input.originalContentType ?? 'text/plain; charset=utf-8', rawHash)
  const result = await deps.store.upsert({
    title: input.title,
    canonicalUrl: input.sourceUrl ?? `manual:${rawHash.slice(0, 16)}`,
    sourceUrls: input.sourceUrl ? [input.sourceUrl] : [],
    issuer: input.issuer ?? '手工导入',
    documentNumber: input.documentNumber ?? '',
    docType: input.docType ?? 'other',
    sourceClass: input.sourceClass ?? 'intermediary',
    sourceId: input.sourceId ?? 'manual',
    publishedAt: input.publishedAt ?? '',
    text,
    paragraphs: splitParagraphs(text),
    contentHash: sha256Hex(`${text}|${input.documentNumber ?? ''}`),
    originalPath: original.path,
    originalBytes: original.bytes,
    originalContentType: input.originalContentType ?? 'text/plain; charset=utf-8',
    parseStatus: input.parseStatus ?? 'ok',
    parseError: input.parseError ?? '',
    humanReviewStatus: 'unreviewed',
  })
  return { url: input.sourceUrl ?? result.doc.canonicalUrl, ok: true, action: result.action, doc: result.doc, reason: result.reason }
}

/** Import a local file (PDF/HTML/Markdown/txt) — text files are parsed, PDFs snapshotted only. */
export async function importFile(deps: CollectDeps, filePath: string, meta: {
  title?: string
  issuer?: string
  docType?: PolicyDocType
  publishedAt?: string
}): Promise<CollectOneResult> {
  const buffer = await readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const contentType = ext === '.pdf' ? 'application/pdf' : ext === '.html' || ext === '.htm' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
  const kind = detectPayloadKind(contentType, buffer)
  if (kind === 'pdf') {
    const title = meta.title ?? path.basename(filePath)
    return importText(deps, {
      title,
      text: '',
      sourceUrl: `file:${path.basename(filePath)}`,
      issuer: meta.issuer,
      docType: meta.docType,
      publishedAt: meta.publishedAt,
      originalBuffer: buffer,
      originalContentType: contentType,
      parseStatus: 'pdf-pending',
      parseError: 'PDF 已保存原文，但未抽取正文；请用 policy_import 提交纯文本正文后再检索',
    })
  }
  const body = kind === 'html' ? htmlToText(decodeBody(buffer, contentType)) : decodeBody(buffer, contentType)
  return importText(deps, {
    title: meta.title ?? path.basename(filePath),
    text: body,
    sourceUrl: `file:${path.basename(filePath)}`,
    issuer: meta.issuer,
    docType: meta.docType,
    publishedAt: meta.publishedAt,
    originalBuffer: buffer,
    originalContentType: contentType,
  })
}

function summarize(runAt: string, results: CollectOneResult[]): CollectRunResult {
  return {
    runAt,
    added: results.filter((r) => r.action === 'added').length,
    updated: results.filter((r) => r.action === 'updated').length,
    duplicate: results.filter((r) => r.action === 'duplicate').length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
}
