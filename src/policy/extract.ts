/**
 * Format-neutral extraction: HTML → text + metadata, RSS/Atom → entries,
 * index pages → candidate document links. No third-party parser, no headless
 * browser: everything here is deterministic and unit-testable against fixtures.
 *
 * PDFs are intentionally NOT text-extracted in P0: Chinese policy PDFs are
 * usually CID-keyed subsets, and a silent half-extraction would fabricate
 * "quotes". They are snapshotted byte-for-byte and marked `pdf-pending`, and the
 * operator can attach text through `policy_import`.
 */
import { normalizeText } from './types.js'

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×',
}

export function decodeEntities(input: string): string {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Strip tags/comments/scripts and turn block boundaries into paragraph breaks. */
export function htmlToText(html: string): string {
  let s = String(html ?? '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|template|svg|iframe|footer|nav)\b[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|table|header|footer|dd|dt)>/gi, '\n\n')
  s = s.replace(/<\/t[dh]>/gi, '\t')
  s = s.replace(/<[^>]+>/g, '')
  return normalizeText(decodeEntities(s))
}

export interface HtmlMeta {
  title: string
  publishedAt: string
  /** Document number found near the top of the text, e.g. `国发〔2026〕5号`. */
  documentNumber: string
  /** Issuer guessed from a leading byline line (`国务院`, `国家发展改革委` …). */
  issuer: string
}

const DOC_NUMBER_RE =
  /((?:国发|国办发|国函|国办函|发改[^\s〔\[(（]{0,6}|财[政预资税]?[^\s〔\[(（]{0,6}|银发|证监[^\s〔\[(（]{0,6}|工信部[^\s〔\[(（]{0,4}|商务部公告|统计局公告|国务院令|中华人民共和国[^\s]*令)\s*[〔\[(（]\s*(\d{4})\s*[〕\])）]\s*第?\s*(\d+)\s*号)/

const ISSUER_HINTS = [
  '中共中央', '国务院办公厅', '国务院', '国家发展改革委', '国家发展和改革委员会', '财政部', '中国人民银行',
  '国家统计局', '工业和信息化部', '商务部', '中国证监会', '上海证券交易所', '深圳证券交易所', '全国人民代表大会',
]

/** Extract title/publish date/document number/issuer from one HTML document. */
export function extractHtmlMeta(html: string, fallbackTitle = ''): HtmlMeta {
  const head = String(html ?? '')
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ''
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head)?.[1] ?? ''
  const metaTitle = /<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title|ArticleTitle)["'][^>]+content=["']([^"']+)["']/i.exec(head)?.[1] ?? ''
  const title = normalizeText(decodeEntities(metaTitle || h1 || titleTag || fallbackTitle)).replace(/\s*[-_|—]\s*(中国政府网|国家发展改革委|国家统计局).*$/, '')

  const dateCandidates = [
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|pubdate|publishdate|PubDate|firstpublishedtime|og:release_date)["'][^>]+content=["']([^"']+)["']/i.exec(head)?.[1],
    /(?:发布时间|发布日期|成文日期|发文日期|日期)[：:]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/.exec(head)?.[1],
    /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})\s*(?:来源|访问量|字体)/.exec(head)?.[1],
  ].filter((v): v is string => typeof v === 'string' && v !== '')
  const publishedAt = dateCandidates.map(toIsoDay).find(Boolean) ?? ''

  const text = htmlToText(head).slice(0, 4000)
  const documentNumber = DOC_NUMBER_RE.exec(text)?.[1]?.replace(/\s+/g, '') ?? ''
  const issuer = ISSUER_HINTS.find((hint) => text.slice(0, 400).includes(hint)) ?? ''
  return { title, publishedAt, documentNumber, issuer }
}

function toIsoDay(raw: string): string {
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(raw.trim())
  if (!m) return ''
  const [, y, mo, d] = m
  return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`
}

export interface DiscoveredLink {
  url: string
  title: string
  publishedAt: string
}

/**
 * Links on an index page that look like documents. `pattern` filters hrefs;
 * links with no usable text are dropped so navigation chrome never becomes a
 * "policy".
 */
export function discoverLinks(html: string, baseUrl: string, pattern?: string): DiscoveredLink[] {
  const filter = pattern ? new RegExp(pattern, 'i') : undefined
  const base = new URL(baseUrl)
  const out: DiscoveredLink[] = []
  const seen = new Set<string>()
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(String(html ?? ''))) !== null) {
    const attrs = m[1] ?? ''
    const inner = m[2] ?? ''
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue
    let absolute: string
    try {
      absolute = new URL(decodeEntities(href), base).toString()
    } catch {
      continue
    }
    if (filter && !filter.test(absolute)) continue
    const attrTitle = /title\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    const title = normalizeText(decodeEntities((attrTitle || inner).replace(/<[^>]+>/g, '')))
    if (title.length < 6) continue
    if (seen.has(absolute)) continue
    seen.add(absolute)
    const nearDate = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(title)
    out.push({
      url: absolute,
      title,
      publishedAt: nearDate ? `${nearDate[1]}-${nearDate[2]!.padStart(2, '0')}-${nearDate[3]!.padStart(2, '0')}` : '',
    })
  }
  return out
}

/**
 * 取 <title> 文本（去标签、解实体、压空白）。找不到就返回 undefined，
 * 由调用方决定「没有标题」是否可接受，不在这里编一个。
 */
export function pageTitleOf(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  const text = normalizeText(decodeEntities((match?.[1] ?? '').replace(/<[^>]+>/g, '')))
  return text || undefined
}

/**
 * 导航/页脚类标题：这类链接在列表页和渲染页里到处都有，不能当政策正文。
 * 只做保守匹配，宁可漏过滤也不误杀正常标题（正常标题通常远长于 6 字）。
 */
export function isNavigationTitle(title: string): boolean {
  const text = String(title ?? '').trim()
  if (!text) return true
  return /^(首页|网站地图|联系我们|关于我们|English|登录|注册|无障碍浏览|打印本页|关闭窗口|返回顶部|分享到|更多|下一页|上一页)$/i.test(text)
    || /^(?:政策文件|政策法规|政策文件库|最新政策|通知公告|信息公开|政府信息公开|政策发布|政策解读|新闻发布|新闻中心|数据发布)(?:栏目|列表)?$/.test(text)
    || /(部门网站|政府网站|友情链接|网站声明|版权声明|使用帮助|主办单位|承办单位|技术支持)/.test(text)
}

/** RSS 2.0 / Atom entries. */
export function parseFeed(xml: string): DiscoveredLink[] {
  const s = String(xml ?? '')
  const out: DiscoveredLink[] = []
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(s)) !== null) {
    const block = m[0]
    const rawTitle = tagContent(block, 'title')
    const link = tagContent(block, 'link') || /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1] || ''
    // 中文站点常用 pubTime（`YYYY-MM-DD HH:MM:SS`），标准 RSS 用 pubDate。
    const date = tagContent(block, 'pubDate') || tagContent(block, 'pubTime') || tagContent(block, 'updated') || tagContent(block, 'published') || tagContent(block, 'dc:date')
    const title = normalizeText(decodeEntities(rawTitle))
    if (!title || !link) continue
    out.push({
      url: decodeEntities(link.trim()),
      title,
      publishedAt: parseFeedDate(date),
    })
  }
  return out
}

/** Accept RFC 822, ISO 8601 and the `YYYY-MM-DD HH:MM:SS` form Chinese feeds use. */
export function parseFeedDate(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(' ', 'T') : text
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

function tagContent(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const raw = re.exec(block)?.[1] ?? ''
  return raw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
}

export type PayloadKind = 'html' | 'pdf' | 'text' | 'unknown'

export function detectPayloadKind(contentType: string, buffer: Buffer): PayloadKind {
  const ct = String(contentType ?? '').toLowerCase()
  if (ct.includes('pdf')) return 'pdf'
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (ct.includes('html') || ct.includes('xml')) return 'html'
  if (ct.startsWith('text/')) return 'text'
  const head = buffer.subarray(0, 512).toString('latin1').toLowerCase()
  if (head.includes('<html') || head.includes('<!doctype html')) return 'html'
  return 'unknown'
}

/** Site chrome that must never become a citable paragraph. */
const CHROME_LINE = /^(?:EN|首页|机构|新闻|数据|公开|服务|互动|知识|专题|搜索|登录|注册|字体|分享到|打印|关闭|扫一扫|返回顶部|更多|相关链接|上一篇|下一篇|网站地图|联系我们|版权所有|主办单位?|地址|邮编|电话|传真|ICP备|京ICP备|网站标识码|中国政府网|国家统计局)$/

/** A line that is only numbers/punctuation — typical of a table cell dump. */
const NUMERIC_LINE = /^[\d.,;:%％()（）\-–—+/\\\s]+$/

export interface CleanResult {
  paragraphs: string[]
  /** How many leading chrome paragraphs were removed. */
  trimmedHead: number
  /** How many numeric cells were folded into table blocks. */
  mergedCells: number
}

/**
 * Turn a site page's raw paragraph list into citable article paragraphs.
 *
 * Government articles embed navigation, "分享到" rows, and — on statistics
 * pages — entire data tables whose cells each become a line. Without this step a
 * single release yields ~1000 "paragraphs" and every citation index is useless.
 * The raw page text is still available through the immutable snapshot.
 */
export function cleanArticleParagraphs(raw: string[], opts: { maxParagraphs?: number } = {}): CleanResult {
  const maxParagraphs = Math.max(20, opts.maxParagraphs ?? 400)

  // 1) Drop chrome and empty/one-character noise, and collapse repeats.
  const kept: string[] = []
  for (const paragraph of raw) {
    const text = paragraph.trim()
    if (!text) continue
    if (CHROME_LINE.test(text.replace(/\s+/g, ''))) continue
    if (/^(?:字体|分享到|打印本页|关闭窗口)[：:]?/.test(text)) continue
    if (text.length < 2) continue
    if (kept.length > 0 && kept[kept.length - 1] === text) continue
    kept.push(text)
  }

  // 2) Start at the first substantial paragraph, keeping a little context above it
  //    (the date line and the issuing body usually sit right before the lede).
  let start = 0
  const firstLong = kept.findIndex((p) => p.length >= 40)
  if (firstLong > 0) start = Math.max(0, firstLong - 3)
  // Skip UI crumbs and stray table blocks at the head ("Aa", publish clock, …).
  while (start < kept.length) {
    const head = kept[start]!
    if (head.length < 12 || head.startsWith('（表格数据，原文为表格）')) { start++; continue }
    break
  }

  // 3) Fold consecutive numeric cells into one table block so they no longer
  //    occupy hundreds of citation slots.
  const paragraphs: string[] = []
  let cells: string[] = []
  let mergedCells = 0
  const flush = (): void => {
    if (cells.length === 0) return
    const sample = cells.slice(0, 24).join(' ')
    paragraphs.push(`（表格数据，原文为表格）${sample}${cells.length > 24 ? ` …共 ${cells.length} 个单元格` : ''}`)
    mergedCells += cells.length
    cells = []
  }
  for (const text of kept.slice(start)) {
    if (NUMERIC_LINE.test(text) && text.length <= 24) {
      cells.push(text)
      continue
    }
    flush()
    paragraphs.push(text)
  }
  flush()

  // 4) Head cleaning must happen after table folding: the publish clock and "Aa"
  //    row would otherwise survive as the first "paragraphs".
  let begin = 0
  while (begin < paragraphs.length) {
    const head = paragraphs[begin]!
    if (head.length < 12 || head.startsWith('（表格数据，原文为表格）')) { begin++; continue }
    break
  }

  // 5) Drop runs of 3+ very short lines: navigation lists and ministry-name
  //    footers. A lone short subheading ("一、总体要求") still survives.
  const kept2: string[] = []
  let run: string[] = []
  const flushRun = (): void => {
    if (run.length > 0 && run.length < 3) kept2.push(...run)
    run = []
  }
  for (const paragraph of paragraphs.slice(begin)) {
    if (paragraph.length < 12) { run.push(paragraph); continue }
    flushRun()
    kept2.push(paragraph)
  }
  flushRun()

  // 6) Trim trailing footer crumbs (related links, org names, copyright rows).
  const FOOTER = /^(?:相关链接|相关报道|相关新闻|网站地图|关于我们|版权声明|联系我们|主办单位|地址|邮编|上一篇|下一篇|返回顶部)/
  let end = kept2.length
  while (end > 0) {
    const tail = kept2[end - 1]!
    if (tail.length < 12 || FOOTER.test(tail)) { end--; continue }
    break
  }

  return {
    paragraphs: kept2.slice(0, Math.min(end, maxParagraphs)),
    trimmedHead: start + begin,
    mergedCells,
  }
}

export function looksNonUtf8(buffer: Buffer): boolean {
  return buffer.includes(Buffer.from([0xb9, 0xfa, 0xb6, 0xfe])) || buffer.includes(Buffer.from([0xc4, 0xe3])) // 国/你 in GBK
}

export function decodeBody(buffer: Buffer, contentType: string): string {
  const ct = String(contentType ?? '').toLowerCase()
  const declared = /charset=([\w-]+)/.exec(ct)?.[1]
  const head = buffer.subarray(0, 1024).toString('latin1')
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  const encoding = (declared || meta || '').toLowerCase()
  if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
    try {
      return new TextDecoder(encoding).decode(buffer)
    } catch {
      /* fall through to UTF-8 */
    }
  }
  return buffer.toString('utf8')
}
