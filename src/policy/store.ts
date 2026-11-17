/**
 * Policy document store.
 *
 * Layout under `<dataDir>/policy/`:
 *   index.json                 lightweight rows for listing
 *   documents/<id>.json        full structured record (one per document)
 *   originals/<sha256>.<ext>   immutable raw snapshot, never rewritten
 *   history/<id>/v<n>.json     superseded revisions (old text preserved)
 *
 * Guarantees:
 * - a repost of identical content never becomes a second policy;
 * - a revised document keeps its id, bumps `version`, and the previous revision
 *   is written to `history/` before the record is replaced;
 * - parse/extraction failures keep the original snapshot and the error text.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import {
  normalizeText,
  normalizeTitle,
  isoDay,
  isoStamp,
  excerpt,
  splitParagraphs,
  type PolicyDocument,
  type PolicyDocumentInput,
  type PolicyQuery,
  type PolicySearchHit,
} from './types.js'

export type UpsertAction = 'added' | 'updated' | 'duplicate'

export interface UpsertResult {
  action: UpsertAction
  doc: PolicyDocument
  /** Set when the write changed something (version bump or new alias). */
  reason: string
}

export interface PolicySummary {
  id: string
  title: string
  issuer: string
  docType: string
  status: string
  legalEffect: string
  publishedAt: string
  version: number
  sourceId: string
  sourceClass: string
  contentHash: string
  excerpt: string
}

interface IndexFile {
  version: 1
  updatedAt: string
  docs: PolicySummary[]
}

/** Chinese-aware tokenizer: ASCII words plus CJK bigrams (deterministic, dependency-free). */
export function tokenize(input: string): string[] {
  const text = String(input ?? '').toLowerCase()
  const tokens = new Set<string>()
  for (const m of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) tokens.add(m[0])
  for (const run of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    if (chars.length === 1) tokens.add(chars[0]!)
    for (let i = 0; i + 1 < chars.length; i++) tokens.add(`${chars[i]}${chars[i + 1]}`)
  }
  return [...tokens]
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1 && count < 20) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * Substantive-paragraph overlap between two documents.
 *
 * Reposts add navigation/bylines, revisions change or add substantive
 * paragraphs. Short lines (chrome, bylines, footers) are ignored, and both
 * containment directions must be high before two documents with the same
 * identity are called "the same text".
 */
export function bodyOverlap(a: string, b: string): { ofA: number; ofB: number } {
  const setOf = (text: string): Set<string> => new Set(
    splitParagraphs(text)
      .map((p) => p.replace(/\s+/g, ''))
      .filter((p) => p.length >= 40)
      .map((p) => p.slice(0, 240)),
  )
  const left = setOf(a)
  const right = setOf(b)
  if (left.size === 0 || right.size === 0) return { ofA: 0, ofB: 0 }
  let shared = 0
  for (const p of left) if (right.has(p)) shared++
  return { ofA: shared / left.size, ofB: shared / right.size }
}

/** True when the same identity carries the same text (a repost, not a revision). */
export function looksLikeRepost(a: string, b: string): boolean {
  const { ofA, ofB } = bodyOverlap(a, b)
  return ofA >= 0.95 && ofB >= 0.95
}

/** Stable identity across revisions: issuer + document number, else title + publish day. */
export function policyDocKey(input: { issuer: string; documentNumber: string; title: string; publishedAt: string }): string {
  const number = input.documentNumber.replace(/\s+/g, '')
  if (number) return `no:${input.issuer.trim()}|${number}`
  const day = isoDay(input.publishedAt)
  return `title:${normalizeTitle(input.title)}|${day}`
}

function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function newPolicyId(docKey: string, publishedAt: string): string {
  const day = (isoDay(publishedAt) || isoStamp().slice(0, 10)).replace(/-/g, '')
  return `pol-${day}-${shortHash(docKey).slice(0, 6)}`
}

export function toSummary(doc: PolicyDocument): PolicySummary {
  return {
    id: doc.id,
    title: doc.title,
    issuer: doc.issuer,
    docType: doc.docType,
    status: doc.status,
    legalEffect: doc.legalEffect,
    publishedAt: doc.publishedAt,
    version: doc.version,
    sourceId: doc.sourceId,
    sourceClass: doc.sourceClass,
    contentHash: doc.contentHash,
    excerpt: excerpt(doc.paragraphs[0] ?? doc.text, 140),
  }
}

export class PolicyStore {
  readonly dir: string
  private readonly documentsDir: string
  private readonly originalsDir: string
  private readonly historyDir: string
  private readonly indexPath: string
  private docs = new Map<string, PolicyDocument>()
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.dir = dir
    this.documentsDir = path.join(dir, 'documents')
    this.originalsDir = path.join(dir, 'originals')
    this.historyDir = path.join(dir, 'history')
    this.indexPath = path.join(dir, 'index.json')
    this.log = logger?.child('policy')
  }

  async load(): Promise<void> {
    await mkdir(this.documentsDir, { recursive: true })
    await mkdir(this.originalsDir, { recursive: true })
    await mkdir(this.historyDir, { recursive: true })
    this.docs.clear()
    let names: string[] = []
    try {
      names = await readdir(this.documentsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await readFile(path.join(this.documentsDir, name), 'utf8')
        const doc = JSON.parse(raw) as PolicyDocument
        if (doc && typeof doc.id === 'string') this.docs.set(doc.id, doc)
      } catch (err) {
        this.log?.warn('policy doc unreadable', { file: name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  stats(): { total: number; byType: Record<string, number>; byStatus: Record<string, number>; byIssuer: Record<string, number> } {
    const byType: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    const byIssuer: Record<string, number> = {}
    for (const doc of this.docs.values()) {
      byType[doc.docType] = (byType[doc.docType] ?? 0) + 1
      byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1
      byIssuer[doc.issuer || '未知'] = (byIssuer[doc.issuer || '未知'] ?? 0) + 1
    }
    return { total: this.docs.size, byType, byStatus, byIssuer }
  }

  all(): PolicyDocument[] {
    return [...this.docs.values()].sort((a, b) => (b.publishedAt || b.fetchedAt).localeCompare(a.publishedAt || a.fetchedAt))
  }

  get(id: string): PolicyDocument | undefined {
    return this.docs.get(id)
  }

  findByHash(contentHash: string): PolicyDocument | undefined {
    for (const doc of this.docs.values()) {
      if (doc.contentHash === contentHash) return doc
      if (doc.previousVersions.some((v) => v.contentHash === contentHash)) return doc
    }
    return undefined
  }

  findByUrl(url: string): PolicyDocument | undefined {
    const target = url.trim()
    for (const doc of this.docs.values()) {
      if (doc.canonicalUrl === target) return doc
      if (doc.sourceUrls.includes(target)) return doc
    }
    return undefined
  }

  findByDocKey(docKey: string): PolicyDocument | undefined {
    for (const doc of this.docs.values()) if (doc.docKey === docKey) return doc
    return undefined
  }

  /** Read one archived revision (used by `policy_compare`). */
  async readRevision(id: string, version: number): Promise<{ version: number; text: string; paragraphs: string[]; contentHash: string } | undefined> {
    try {
      const raw = await readFile(path.join(this.historyDir, id, `v${version}.json`), 'utf8')
      const doc = JSON.parse(raw) as PolicyDocument
      return {
        version: typeof doc.version === 'number' ? doc.version : version,
        text: doc.text ?? '',
        paragraphs: doc.paragraphs ?? [],
        contentHash: doc.contentHash ?? '',
      }
    } catch {
      return undefined
    }
  }

  /** Versions present in history (oldest first). */
  revisions(id: string): number[] {
    const doc = this.docs.get(id)
    if (!doc) return []
    return doc.previousVersions.map((v) => v.version).sort((a, b) => a - b)
  }

  /** Store raw bytes once, content-addressed; returns the relative path. */
  async saveOriginal(buffer: Buffer, contentType: string, contentHash: string): Promise<{ path: string; bytes: number }> {
    const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('html') ? 'html' : contentType.includes('json') ? 'json' : 'txt'
    const file = path.join(this.originalsDir, `${contentHash.slice(0, 32)}.${ext}`)
    try {
      await readFile(file)
      return { path: this.rel(file), bytes: buffer.byteLength }
    } catch {
      await writeFile(file, buffer)
      return { path: this.rel(file), bytes: buffer.byteLength }
    }
  }

  async upsert(input: PolicyDocumentInput): Promise<UpsertResult> {
    const now = isoStamp()
    const text = normalizeText(input.text)
    const contentHash = input.contentHash
    const publishedAt = isoDay(input.publishedAt)
    const docKey = policyDocKey({
      issuer: input.issuer ?? '',
      documentNumber: input.documentNumber ?? '',
      title: input.title,
      publishedAt,
    })

    // 1) Identical content anywhere in the store: a repost, not a new policy.
    const sameContent = this.findByHash(contentHash)
    if (sameContent) {
      const alias = input.canonicalUrl
      let changed = false
      if (!sameContent.sourceUrls.includes(alias)) {
        sameContent.sourceUrls.push(alias)
        changed = true
      }
      if (alias !== sameContent.canonicalUrl && !sameContent.sourceUrls.includes(sameContent.canonicalUrl)) {
        sameContent.sourceUrls.push(sameContent.canonicalUrl)
      }
      sameContent.lastVerifiedAt = now
      if (changed) await this.persist(sameContent)
      return { action: 'duplicate', doc: sameContent, reason: changed ? '转载：已并入同一政策（新增来源 URL）' : '转载：内容哈希一致，未新建政策' }
    }

    // 2) Same identity, same body: a repost on another site.
    const existing = this.findByDocKey(docKey)
    if (existing && looksLikeRepost(existing.text, text)) {
      if (!existing.sourceUrls.includes(input.canonicalUrl)) existing.sourceUrls.push(input.canonicalUrl)
      existing.lastVerifiedAt = now
      await this.persist(existing)
      return { action: 'duplicate', doc: existing, reason: '同一文件的转载（正文重合≥90%），未新建版本' }
    }

    // 3) Same identity, changed body: a revision.
    if (existing) {
      const previous = {
        version: existing.version,
        contentHash: existing.contentHash,
        fetchedAt: existing.fetchedAt,
        originalPath: existing.originalPath,
        documentPath: this.rel(path.join(this.documentsDir, `${existing.id}.json`)),
      }
      await this.archiveRevision(existing, previous)
      const updated: PolicyDocument = {
        ...existing,
        title: input.title || existing.title,
        text,
        paragraphs: input.paragraphs ?? existing.paragraphs,
        contentHash,
        originalPath: input.originalPath,
        originalBytes: input.originalBytes ?? existing.originalBytes,
        originalContentType: input.originalContentType ?? existing.originalContentType,
        fetchedAt: now,
        lastVerifiedAt: now,
        publishedAt: publishedAt || existing.publishedAt,
        version: existing.version + 1,
        previousVersions: [previous, ...existing.previousVersions].slice(0, 20),
        sourceUrls: [...new Set([...existing.sourceUrls, input.canonicalUrl])],
        parseStatus: input.parseStatus ?? existing.parseStatus,
        parseError: input.parseError ?? '',
      }
      this.docs.set(updated.id, updated)
      await this.persist(updated)
      return { action: 'updated', doc: updated, reason: `同一文件的新版本（v${previous.version} → v${updated.version}），旧版已归档` }
    }

    // 4) New document.
    const id = input.id && !this.docs.has(input.id) ? input.id : newPolicyId(docKey, publishedAt)
    const doc: PolicyDocument = {
      id,
      canonicalUrl: input.canonicalUrl,
      sourceUrls: [...new Set([input.canonicalUrl, ...(input.sourceUrls ?? [])])],
      title: input.title,
      issuer: input.issuer ?? '',
      documentNumber: input.documentNumber ?? '',
      docType: input.docType,
      sourceClass: input.sourceClass,
      sourceId: input.sourceId,
      publishedAt,
      effectiveAt: isoDay(input.effectiveAt),
      expiredAt: isoDay(input.expiredAt),
      fetchedAt: now,
      lastVerifiedAt: now,
      status: input.status ?? 'unknown',
      legalEffect: input.legalEffect ?? 'unknown',
      geographicScope: input.geographicScope ?? 'china',
      relatedIndustries: input.relatedIndustries ?? [],
      relatedAssets: input.relatedAssets ?? [],
      contentHash,
      docKey,
      version: 1,
      previousVersions: [],
      text,
      paragraphs: input.paragraphs ?? [],
      originalPath: input.originalPath,
      originalBytes: input.originalBytes ?? 0,
      originalContentType: input.originalContentType ?? '',
      pageReferences: input.pageReferences ?? [],
      relatedPolicyIds: input.relatedPolicyIds ?? [],
      supersededBy: input.supersededBy ?? '',
      policyGoals: input.policyGoals ?? [],
      policyMeasures: input.policyMeasures ?? [],
      fundingMechanism: input.fundingMechanism ?? '',
      executionResponsibility: input.executionResponsibility ?? '',
      measurableTargets: input.measurableTargets ?? [],
      implementationIndicators: input.implementationIndicators ?? [],
      extractionVersion: input.extractionVersion ?? '',
      humanReviewStatus: input.humanReviewStatus ?? 'unreviewed',
      parseStatus: input.parseStatus ?? 'ok',
      parseError: input.parseError ?? '',
      tags: input.tags ?? [],
    }
    this.docs.set(doc.id, doc)
    await this.persist(doc)
    return { action: 'added', doc, reason: '新政策' }
  }

  /**
   * Agent/model extraction. Only structured fields are writable: full text,
   * hash, identity and dates stay exactly as fetched.
   */
  async annotate(id: string, patch: Partial<Pick<PolicyDocument,
    | 'policyGoals' | 'policyMeasures' | 'fundingMechanism' | 'executionResponsibility'
    | 'measurableTargets' | 'implementationIndicators' | 'relatedIndustries' | 'relatedAssets'
    | 'tags' | 'status' | 'legalEffect' | 'effectiveAt' | 'documentNumber' | 'issuer' | 'title'
  >> & { extractionVersion?: string; humanReviewStatus?: PolicyDocument['humanReviewStatus'] }): Promise<PolicyDocument> {
    const doc = this.docs.get(id)
    if (!doc) throw new Error(`未找到政策：${id}`)
    // Citation integrity is enforced here, not only in the tool layer: any
    // extracted claim must point at a paragraph that actually exists.
    const anchors = [
      ...(patch.policyGoals ?? []).map((g) => g.paragraph),
      ...(patch.policyMeasures ?? []).map((m) => m.paragraph),
      ...(patch.measurableTargets ?? []).map((t) => t.paragraph),
    ].filter((p): p is number => typeof p === 'number' && p >= 0)
    const outOfRange = anchors.filter((p) => p >= doc.paragraphs.length)
    if (outOfRange.length > 0) {
      throw new Error(`段落下标越界：${outOfRange.join(', ')}（该文档共 ${doc.paragraphs.length} 段）`)
    }
    const next: PolicyDocument = {
      ...doc,
      ...('policyGoals' in patch ? { policyGoals: patch.policyGoals ?? doc.policyGoals } : {}),
      ...('policyMeasures' in patch ? { policyMeasures: patch.policyMeasures ?? doc.policyMeasures } : {}),
      ...('fundingMechanism' in patch ? { fundingMechanism: patch.fundingMechanism ?? doc.fundingMechanism } : {}),
      ...('executionResponsibility' in patch ? { executionResponsibility: patch.executionResponsibility ?? doc.executionResponsibility } : {}),
      ...('measurableTargets' in patch ? { measurableTargets: patch.measurableTargets ?? doc.measurableTargets } : {}),
      ...('implementationIndicators' in patch ? { implementationIndicators: patch.implementationIndicators ?? doc.implementationIndicators } : {}),
      ...('relatedIndustries' in patch ? { relatedIndustries: patch.relatedIndustries ?? doc.relatedIndustries } : {}),
      ...('relatedAssets' in patch ? { relatedAssets: patch.relatedAssets ?? doc.relatedAssets } : {}),
      ...('tags' in patch ? { tags: patch.tags ?? doc.tags } : {}),
      ...('status' in patch ? { status: patch.status ?? doc.status } : {}),
      ...('legalEffect' in patch ? { legalEffect: patch.legalEffect ?? doc.legalEffect } : {}),
      ...('effectiveAt' in patch ? { effectiveAt: isoDay(patch.effectiveAt) || doc.effectiveAt } : {}),
      ...('documentNumber' in patch ? { documentNumber: patch.documentNumber ?? doc.documentNumber } : {}),
      ...('issuer' in patch ? { issuer: patch.issuer ?? doc.issuer } : {}),
      ...('title' in patch ? { title: patch.title ?? doc.title } : {}),
      extractionVersion: patch.extractionVersion ?? doc.extractionVersion ?? '',
      humanReviewStatus: patch.humanReviewStatus ?? doc.humanReviewStatus,
      lastVerifiedAt: isoStamp(),
    }
    this.docs.set(id, next)
    await this.persist(next)
    return next
  }

  async remove(id: string): Promise<boolean> {
    if (!this.docs.delete(id)) return false
    await this.persistIndex()
    return true
  }

  /** Keyword search with metadata filters; ranks by field-weighted token hits. */
  search(query: PolicyQuery): PolicySearchHit[] {
    const limit = Math.max(1, Math.min(200, query.limit ?? 20))
    const tokens = query.query ? tokenize(query.query) : []
    const hits: PolicySearchHit[] = []
    for (const doc of this.docs.values()) {
      if (query.issuer && !doc.issuer.includes(query.issuer)) continue
      if (query.docType && doc.docType !== query.docType) continue
      if (query.status && doc.status !== query.status) continue
      if (query.legalEffect && doc.legalEffect !== query.legalEffect) continue
      if (query.sourceId && doc.sourceId !== query.sourceId) continue
      if (query.tag && !doc.tags.includes(query.tag)) continue
      if (query.industry && !doc.relatedIndustries.some((i) => i.includes(query.industry!))) continue
      if (query.from && doc.publishedAt && doc.publishedAt < isoDay(query.from)) continue
      if (query.to && doc.publishedAt && doc.publishedAt > isoDay(query.to)) continue
      if (tokens.length === 0) {
        hits.push({ score: 0, tokens: [], doc })
        continue
      }
      const title = doc.title.toLowerCase()
      const summary = `${doc.issuer} ${doc.documentNumber} ${doc.relatedIndustries.join(' ')} ${doc.tags.join(' ')}`.toLowerCase()
      const body = doc.text.toLowerCase()
      let score = 0
      const matched: string[] = []
      for (const token of tokens) {
        const t = countOccurrences(title, token) * 6
        const s = countOccurrences(summary, token) * 3
        const b = countOccurrences(body, token)
        const total = t + s + b
        if (total > 0) matched.push(token)
        score += total
      }
      if (matched.length === 0) continue
      // Reward coverage of distinct query tokens over sheer repetition.
      if (matched.length === tokens.length) score += 8
      hits.push({ score, tokens: matched, doc })
    }
    hits.sort((a, b) => b.score - a.score || (b.doc.publishedAt || '').localeCompare(a.doc.publishedAt || ''))
    return hits.slice(0, limit)
  }

  private async archiveRevision(doc: PolicyDocument, previous: PolicyDocument['previousVersions'][number]): Promise<void> {
    const dir = path.join(this.historyDir, doc.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `v${previous.version}.json`)
    await this.atomic(file, JSON.stringify({ ...doc, version: previous.version, contentHash: previous.contentHash }, null, 2))
  }

  private async persist(doc: PolicyDocument): Promise<void> {
    await this.atomic(path.join(this.documentsDir, `${doc.id}.json`), JSON.stringify(doc, null, 2))
    await this.persistIndex()
  }

  private async persistIndex(): Promise<void> {
    const index: IndexFile = {
      version: 1,
      updatedAt: isoStamp(),
      docs: this.all().map(toSummary),
    }
    await this.atomic(this.indexPath, JSON.stringify(index, null, 2))
  }

  private async atomic(file: string, raw: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, raw, 'utf8')
    await rename(tmp, file)
  }

  private rel(file: string): string {
    return path.relative(this.dir, file).split(path.sep).join('/')
  }
}
