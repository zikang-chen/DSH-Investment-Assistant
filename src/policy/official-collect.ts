/**
 * 官方页面程序化采集（历史回溯 + 增量更新）。
 *
 * 背景：很多部委/白皮书页面没有 API，数据以 HTML 表格或 PDF/XLS 附件形式挂在列表页上
 * （如人民银行统计数据栏目）。本模块在**允许清单 + robots.txt**约束下：
 *   1) 从列表页出发，沿「下一页」翻页（可限定页码范围/日期区间，支持找过往文件）；
 *   2) 收集文章链接并调用 collectOne 入库（真正写 documents/ 的仍是 collectOne）；
 *   3) 发现 PDF/XLS/XLSX/CSV/DOC 附件并下载保存，CSV 直接解析、XLSX 走 Python 辅助解析。
 * 不绕过登录/验证码/反爬；不在允许清单内的 host 一律拒绝。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectOne, type CollectDeps } from './collect.js'
import { fetchPolicyDocument, hostAllowed, sha256Hex, type FetchOptions } from './fetch.js'
import type { PolicyDocType } from './types.js'
import { decodeBody } from './extract.js'

export type AttachmentKind = 'pdf' | 'xls' | 'xlsx' | 'csv' | 'doc' | 'docx' | 'zip' | 'other'

export interface OfficialAnchor { url: string; label: string; date?: string }

export interface OfficialAttachment { url: string; label: string; kind: AttachmentKind }

export interface OfficialCollectResult {
  ok: boolean
  url: string
  pagesVisited: number
  documents: Array<{ id?: string; url: string; title?: string; action?: string; reason?: string }>
  attachments: Array<{ url: string; label: string; kind: AttachmentKind; bytes?: number; savedAs?: string; rows?: number; error?: string }>
  tables: number
  errors: string[]
  /** 本次实际覆盖到的最早/最晚文档日期（仅有可解析日期时给出）。 */
  coverage?: { from?: string; to?: string }
}

const ATTACHMENT_EXT: Array<[RegExp, AttachmentKind]> = [
  [/\.pdf$/i, 'pdf'], [/\.xlsx$/i, 'xlsx'], [/\.xls$/i, 'xls'], [/\.csv$/i, 'csv'],
  [/\.docx$/i, 'docx'], [/\.doc$/i, 'doc'], [/\.zip$/i, 'zip'],
]

export function classifyAttachment(url: string): AttachmentKind | null {
  let pathname = url
  try { pathname = new URL(url).pathname } catch { /* keep raw */ }
  for (const [re, kind] of ATTACHMENT_EXT) if (re.test(pathname)) return kind
  return null
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

/** Only complete, valid calendar dates are publication-date candidates. */
export function extractDate(text: string): string | undefined {
  const match = /(?:^|\D)((?:19|20)\d{2})[-/年](\d{1,2})[-/月](\d{1,2})(?!\d)/.exec(text)
    ?? /(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(text)
  if (!match) return undefined
  const day = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`
  const parsed = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : undefined
}

/** Do not infer publication dates from titles, article text or reporting periods. */
function publicationDate(html: string, url: string): string | undefined {
  const urlDate = extractDate(new URL(url).pathname)
  if (urlDate) return urlDate
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>()
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs.set(m[1]!.toLowerCase(), m[2]!)
    const name = attrs.get('name') ?? attrs.get('property') ?? ''
    if (/^(?:article:published_time|datepublished|pubdate|publishdate|publicationdate|firstpublishedtime)$/i.test(name)) {
      const date = extractDate(attrs.get('content') ?? '')
      if (date) return date
    }
  }
  const labeled = /(?:发布时间|发布日期)[：:]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/.exec(stripTags(html))
  return labeled ? extractDate(labeled[1]!) : undefined
}

export function extractAnchors(html: string, baseUrl: string): OfficialAnchor[] {
  const out: OfficialAnchor[] = []
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1]!.trim()
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue
    let abs: string
    try { abs = new URL(href, baseUrl).toString() } catch { continue }
    const label = stripTags(m[2] ?? '')
    out.push({ url: abs, label, date: extractDate(new URL(abs).pathname) })
  }
  return out
}

export function extractAttachmentLinks(html: string, baseUrl: string): OfficialAttachment[] {
  const seen = new Set<string>()
  const out: OfficialAttachment[] = []
  for (const a of extractAnchors(html, baseUrl)) {
    const kind = classifyAttachment(a.url)
    if (!kind || seen.has(a.url)) continue
    seen.add(a.url)
    out.push({ url: a.url, label: a.label || a.url.split('/').pop() || a.url, kind })
  }
  return out
}

/** Article-like links (HTML docs), excluding chrome/nav by requiring a meaningful label. */
export function extractArticleLinks(html: string, baseUrl: string, opts: { minLabel?: number; include?: RegExp } = {}): OfficialAnchor[] {
  const minLabel = opts.minLabel ?? 6
  const seen = new Set<string>()
  const out: OfficialAnchor[] = []
  for (const a of extractAnchors(html, baseUrl)) {
    if (classifyAttachment(a.url)) continue
    if (!/\.(html?|shtml|jsp|aspx)$/i.test(new URL(a.url).pathname) && !/\/\d{6,}\//.test(a.url)) continue
    if (a.label.replace(/[\s·]/g, '').length < minLabel) continue
    if (opts.include && !opts.include.test(a.label)) continue
    if (seen.has(a.url)) continue
    seen.add(a.url)
    out.push(a)
  }
  return out
}

/** Next-page links (下一页/下页/Next, or explicit page numbers). */
export function extractNextPageUrls(html: string, baseUrl: string): string[] {
  const out: string[] = []
  for (const a of extractAnchors(html, baseUrl)) {
    if (/下一页|下页|下一頁|next/i.test(a.label)) out.push(a.url)
  }
  return [...new Set(out)]
}

/** Minimal HTML table extractor (rows of cell text). Good enough for 部委统计表。 */
export function extractTables(html: string): Array<{ rows: string[][] }> {
  const tables: Array<{ rows: string[][] }> = []
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  let t: RegExpExecArray | null
  while ((t = tableRe.exec(html))) {
    const rows: string[][] = []
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let r: RegExpExecArray | null
    while ((r = rowRe.exec(t[1]!))) {
      const cells: string[] = []
      const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
      let c: RegExpExecArray | null
      while ((c = cellRe.exec(r[1]!))) cells.push(stripTags(c[1] ?? ''))
      if (cells.length) rows.push(cells)
    }
    if (rows.length) tables.push({ rows })
  }
  return tables
}

export interface OfficialCollectOptions {
  url: string
  /** How many list pages to walk (default 1; pagination follows 下一页). */
  maxPages?: number
  /** Maximum document attempts across every phase; duplicates/failures count (default 20). */
  maxDocs?: number
  /** Inclusive publish-date window, e.g. from '2024-01-01'. */
  from?: string
  to?: string
  /** Download attachments (pdf/xlsx/...) in addition to article pages. */
  includeAttachments?: boolean
  maxAttachments?: number
  sourceId?: string
  issuer?: string
  docType?: PolicyDocType
}

export function inWindow(date: string | undefined, from?: string, to?: string): boolean {
  if (!date) return true // unknown date: keep (so historical items are not silently dropped)
  // A partial/invalid date is not reliable enough to exclude a document.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || extractDate(date) !== date) return true
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

/**
 * Crawl an official list/article page: walk pagination, import article documents,
 * and optionally save attachments. Everything is bounded by allowlist + robots.
 */
export interface OfficialCollectRuntime {
  fetch?: typeof fetchPolicyDocument
  collectOne?: typeof collectOne
  countExcelRows?: (buffer: Buffer, kind: AttachmentKind) => Promise<number | undefined>
  /** Delay between sequential fetch/collect operations (default 1000ms). */
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}

export async function collectOfficialPages(deps: CollectDeps, options: OfficialCollectOptions, runtime: OfficialCollectRuntime = {}): Promise<OfficialCollectResult> {
  const maxPages = Math.max(1, Math.min(30, options.maxPages ?? 1))
  const maxDocs = Math.max(1, Math.min(50, options.maxDocs ?? 20))
  const maxAttachments = Math.max(0, Math.min(30, options.maxAttachments ?? 20))
  const result: OfficialCollectResult = { ok: true, url: options.url, pagesVisited: 0, documents: [], attachments: [], tables: 0, errors: [] }
  if (!hostAllowed(options.url, deps.hosts)) {
    return { ...result, ok: false, errors: [`链接无效或不在允许清单内：${options.url}`] }
  }
  const fetchOpts: FetchOptions = {
    hosts: deps.hosts, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes,
    respectRobots: true, robotsCache: deps.robotsCache, signal: deps.signal,
  }
  const fetchDocument = runtime.fetch ?? fetchPolicyDocument
  const importDocument = runtime.collectOne ?? collectOne
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const gapMs = Math.max(0, runtime.gapMs ?? 1000)
  let operations = 0
  const pace = async (): Promise<void> => { if (operations++ > 0 && gapMs > 0) await sleep(gapMs) }
  const fetchPage = async (url: string) => {
    if (!hostAllowed(url, deps.hosts)) throw new Error(`链接不在允许清单内：${url}`)
    await pace()
    const res = await fetchDocument(url, fetchOpts)
    if (!hostAllowed(res.url, deps.hosts)) throw new Error(`重定向不在允许清单内：${res.url}`)
    return res
  }
  const visited = new Set<string>()
  const seenDoc = new Set<string>()
  const queue = [options.url]
  const articles: OfficialAnchor[] = []
  const attachments: OfficialAttachment[] = []
  const dates: string[] = []
  let attempts = 0
  const importOne = async (url: string, title?: string, date?: string): Promise<void> => {
    await pace()
    const one = await importDocument(deps, {
      url, sourceId: options.sourceId ?? 'official-page', sourceClass: 'official',
      issuer: options.issuer ?? '', docType: options.docType ?? 'other',
      titleHint: title, publishedHint: date,
    })
    result.documents.push({ id: one.doc?.id, url, title: one.doc?.title ?? title, action: one.action, reason: one.reason ?? one.error })
    if (!one.ok) result.errors.push(`${url}: ${one.error ?? one.reason ?? '采集失败'}`)
    if (date) dates.push(date)
  }

  while (queue.length && result.pagesVisited < maxPages) {
    const pageUrl = queue.shift()!
    if (visited.has(pageUrl)) continue
    visited.add(pageUrl)
    result.pagesVisited += 1
    try {
      const res = await fetchPage(pageUrl)
      if (!/html|xml|text\/plain/i.test(res.contentType) && !/\.html?$/i.test(new URL(pageUrl).pathname)) {
        result.errors.push(`跳过非 HTML 页面（${res.contentType}）：${pageUrl}`)
        continue
      }
      const html = decodeBody(res.buffer, res.contentType)
      result.tables += extractTables(html).length
      for (const a of extractArticleLinks(html, res.url)) {
        if (a.url === pageUrl || !hostAllowed(a.url, deps.hosts)) continue
        if (!inWindow(a.date, options.from, options.to)) continue
        articles.push(a)
      }
      for (const att of extractAttachmentLinks(html, res.url)) attachments.push(att)
      for (const next of extractNextPageUrls(html, res.url)) {
        if (!visited.has(next) && hostAllowed(next, deps.hosts)) queue.push(next)
      }
      const date = publicationDate(html, res.url)
      // One shared attempt budget, including direct pages, duplicates and failures.
      if ((html.match(/<p\b/gi) ?? []).length >= 3 && attempts < maxDocs
        && !seenDoc.has(res.url) && inWindow(date, options.from, options.to)) {
        seenDoc.add(res.url)
        attempts += 1
        await importOne(res.url, undefined, date)
      }
    } catch (err) {
      result.errors.push(`${pageUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const a of articles) {
    if (attempts >= maxDocs) break
    if (seenDoc.has(a.url)) continue
    seenDoc.add(a.url)
    attempts += 1
    try {
      // Inspect each selected article too: many official lists only link to a
      // detail page, and that page contains the actual XLSX/PDF download.
      const res = await fetchPage(a.url)
      const html = decodeBody(res.buffer, res.contentType)
      const date = publicationDate(html, res.url)
      if (!inWindow(date, options.from, options.to)) continue
      if (options.includeAttachments) attachments.push(...extractAttachmentLinks(html, res.url))
      await importOne(a.url, a.label, date)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.documents.push({ url: a.url, title: a.label, reason })
      result.errors.push(`${a.url}: ${reason}`)
    }
  }

  // Attachments: download & save, parse CSV/XLSX preview rows.
  if (options.includeAttachments) {
    const uniq = new Map<string, OfficialAttachment>()
    for (const att of attachments) if (!uniq.has(att.url)) uniq.set(att.url, att)
    for (const att of [...uniq.values()].slice(0, maxAttachments)) {
      try {
        const res = await fetchPage(att.url)
        // Save via the same original-store used by policy docs (content-addressed, dedup).
        const saved = await deps.store.saveOriginal(res.buffer, res.contentType || 'application/octet-stream', sha256Hex(res.buffer))
        const rowEntry: OfficialCollectResult['attachments'][number] = { url: att.url, label: att.label, kind: att.kind, bytes: res.bytes, savedAs: saved.path }
        if (att.kind === 'csv') {
          rowEntry.rows = res.buffer.toString('utf8').split(/\r?\n/).filter(Boolean).length
        } else if (att.kind === 'xlsx' || att.kind === 'xls') {
          rowEntry.rows = await (runtime.countExcelRows ?? countExcelRows)(res.buffer, att.kind)
        }
        result.attachments.push(rowEntry)
      } catch (err) {
        result.attachments.push({ url: att.url, label: att.label, kind: att.kind, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  if (dates.length) {
    const sorted = dates.slice().sort()
    result.coverage = { from: sorted[0], to: sorted[sorted.length - 1] }
  }
  // Partial failures remain visible rather than reporting unconditional success.
  result.ok = result.errors.length === 0 && result.attachments.every((att) => !att.error)
  return result
}

/** Use local Python (pandas) to count data rows in an Excel attachment, best-effort. */
async function countExcelRows(buffer: Buffer, kind: AttachmentKind): Promise<number | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'policy-xls-'))
  try {
    const file = path.join(dir, kind === 'xls' ? 'a.xls' : 'a.xlsx')
    await writeFile(file, buffer)
    const { execFile } = await import('node:child_process')
    const py = process.env.DSH_PYTHON_BIN || process.env.PYTHON || 'python'
    const script = 'import sys,pandas as pd;df=pd.read_excel(sys.argv[1]);print(len(df))'
    return await new Promise<number | undefined>((resolve) => {
      execFile(py, ['-c', script, file], { timeout: 60_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout) => {
        if (err) return resolve(undefined)
        const n = Number(String(stdout).trim())
        resolve(Number.isFinite(n) ? n : undefined)
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
