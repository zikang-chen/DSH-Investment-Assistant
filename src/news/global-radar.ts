/**
 * 全球市场新闻雷达（纯后端模块，不接路由 / 不接 UI）。
 *
 * 能力边界：
 * 1. 零第三方依赖解析 RSS 2.0、Atom、RSS 1.0/RDF（含 CDATA、实体、命名空间标签）。
 * 2. 发布时间统一成 ISO 8601 UTC；无时区的时间按 UTC 解释并显式标注，非法时间
 *    保留原文、标记 invalid，绝不猜一个时间。
 * 3. 来源等级 + 事件类型（关键词规则，命中词可解释）+ 可选跨资产行情幅度 +
 *    可选持仓/自选关键词相关性，做确定性评分。分数只是阅读顺序，不是因果判断，
 *    也不是收益预测，更不声称「全市场最重要」。
 * 4. 去重（URL；标题 + 分钟级发布时间），再做窗口过滤、打分与稳定排序。
 *
 * 抓取是单独的显式函数；导入本模块、解析 fixture、打分都不会联网。抓取失败只
 * 返回诊断，不因为源配置里 `realChecked: true` 就假装本次成功。
 */

import { createHash } from 'node:crypto'
import {
  getEnabledOfficialNewsFeeds,
  type GlobalNewsFeedSource,
  type NewsSourceAuthority,
  type NewsSourceFamily,
  type NewsSourceRegion,
} from './feed-sources.js'

// ---------------------------------------------------------------------------
// 事件分类
// ---------------------------------------------------------------------------

export type NewsEventType =
  | 'rate'
  | 'inflation'
  | 'employment'
  | 'growth'
  | 'regulation'
  | 'geopolitical'
  | 'earnings'
  | 'other'

export interface NewsEventRule {
  type: NewsEventType
  label: string
  keywords: readonly string[]
}

/**
 * 规则顺序就是同分时的固定优先级（也大致对应基础权重从高到低）。关键词只做
 * 字面匹配：英文按单词边界，中文按子串。它解释「为什么归到这一类」，不证明
 * 这条新闻真的会驱动市场。
 */
export const NEWS_EVENT_RULES: readonly NewsEventRule[] = Object.freeze([
  {
    type: 'rate',
    label: '利率/货币政策',
    keywords: [
      'interest rate', 'interest rates', 'policy rate', 'policy rates', 'rate cut', 'rate cuts',
      'rate hike', 'rate hikes', 'raise rates', 'raises rates', 'raised rates', 'lower rates',
      'lowers rates', 'lowered rates', 'fomc', 'federal funds', 'monetary policy', 'bank rate',
      'deposit facility rate', 'main refinancing', 'basis points', '加息', '降息', '利率', '货币政策', '联邦基金',
    ],
  },
  {
    type: 'inflation',
    label: '通胀',
    keywords: [
      'inflation', 'cpi', 'consumer price', 'consumer prices', 'pce', 'producer price',
      'producer prices', 'ppi', 'price index', 'deflation', 'disinflation', '通胀', '通货膨胀',
      '物价', '消费者价格', '生产者价格',
    ],
  },
  {
    type: 'employment',
    label: '就业',
    keywords: [
      'employment', 'unemployment', 'payroll', 'payrolls', 'nonfarm', 'non-farm', 'jobless',
      'jobs report', 'labor market', 'labour market', 'hiring', 'layoffs', 'layoff', '非农',
      '就业', '失业', '裁员', '劳动力市场',
    ],
  },
  {
    type: 'geopolitical',
    label: '地缘政治',
    keywords: [
      'geopolitical', 'war', 'conflict', 'military', 'invasion', 'ceasefire', 'election',
      'sanctions', 'sanction', 'tariff', 'tariffs', 'trade war', 'trade tensions', '地缘',
      '战争', '冲突', '选举', '制裁', '关税', '贸易战',
    ],
  },
  {
    type: 'growth',
    label: '增长/景气',
    keywords: [
      'gdp', 'economic growth', 'growth', 'recession', 'pmi', 'ism', 'retail sales',
      'industrial production', 'consumer confidence', 'output', 'soft landing', 'hard landing',
      '经济增长', '经济增速', '衰退', '制造业', '零售销售', '工业产出', '软着陆', '硬着陆',
    ],
  },
  {
    type: 'regulation',
    label: '监管/执法',
    keywords: [
      'regulation', 'regulatory', 'rule', 'rules', 'rulemaking', 'enforcement', 'lawsuit',
      'charges', 'settlement', 'supervision', 'supervisory', 'capital requirement',
      'capital requirements', 'basel', 'comment period', '监管', '处罚', '规则', '起诉', '和解',
      '资本充足', '执法',
    ],
  },
  {
    type: 'earnings',
    label: '公司业绩',
    keywords: [
      'earnings', 'revenue', 'revenues', 'profit', 'profits', 'earnings guidance',
      'revenue guidance', 'profit guidance', 'quarterly results', 'net income', 'eps',
      '财报', '业绩', '营收', '净利润', '盈利指引', '季度业绩',
    ],
  },
  { type: 'other', label: '其他', keywords: [] },
])

export const EVENT_TYPE_WEIGHTS: Readonly<Record<NewsEventType, number>> = Object.freeze({
  rate: 20,
  inflation: 18,
  employment: 16,
  geopolitical: 15,
  growth: 14,
  regulation: 12,
  earnings: 9,
  other: 3,
})

export const AUTHORITY_WEIGHTS: Readonly<Record<NewsSourceAuthority, number>> = Object.freeze({
  'central-bank': 25,
  regulator: 23,
  statistics: 22,
  official: 21,
  exchange: 12,
  media: 5,
})

const AUTHORITY_LABELS: Readonly<Record<NewsSourceAuthority, string>> = Object.freeze({
  'central-bank': '央行/货币当局',
  regulator: '监管机构',
  statistics: '统计机构',
  official: '官方机构',
  exchange: '交易所',
  media: '媒体',
})

const EVENT_LABELS: Readonly<Record<NewsEventType, string>> = Object.freeze({
  rate: '利率/货币政策',
  inflation: '通胀',
  employment: '就业',
  growth: '增长/景气',
  regulation: '监管/执法',
  geopolitical: '地缘政治',
  earnings: '公司业绩',
  other: '其他',
})

/**
 * 评分模型（固定规则、可复现）。分项上限相加恰好 100：
 * 来源权威 25 + 事件权重 20 + 一手性 5 + 时间衰减 25 + 跨资产幅度 15 + 相关性 10。
 */
export const RADAR_SCORE_MODEL = Object.freeze({
  version: 1,
  authorityMax: 25,
  eventMax: 20,
  firstHandMax: 5,
  recencyMax: 25,
  reactionMax: 15,
  relevanceMax: 10,
  maxTotal: 100,
  halfLifeHours: 36,
  reactionPointsPerAvgAbsPct: 2.5,
  relevancePointsPerHit: 2.5,
})

export const RADAR_DISCLAIMER =
  '排序由固定规则（来源等级、事件类型、一手性、时间衰减、可选跨资产幅度、可选持仓关键词）加总，只用于决定阅读顺序；不表示因果、不预测涨跌，也不声称“全市场最重要”。缺失行情或关键词时对应分项为 0，只代表输入缺失。'

export interface NewsEventClassification {
  type: NewsEventType
  /** 命中的关键词原文（用于解释分类）。 */
  hits: string[]
  /** 每个事件类型的命中次数，便于审计。 */
  scores: Record<NewsEventType, number>
  reason: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 英文关键词按单词边界匹配，避免 rate 命中 corporate；中文按子串。 */
function buildKeywordMatcher(keyword: string): (text: string) => boolean {
  const lower = keyword.toLowerCase()
  if (/^[\x20-\x7E]+$/.test(lower)) {
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9])${escapeRegExp(lower)}(?=$|[^A-Za-z0-9])`,
      'i',
    )
    return (text: string) => pattern.test(text)
  }
  return (text: string) => text.includes(lower)
}

const EVENT_MATCHERS: readonly {
  type: NewsEventType
  label: string
  keywords: readonly { keyword: string; matches: (text: string) => boolean }[]
}[] = NEWS_EVENT_RULES.map(rule => ({
  type: rule.type,
  label: rule.label,
  keywords: rule.keywords.map(keyword => ({ keyword, matches: buildKeywordMatcher(keyword) })),
}))

export function classifyNewsEvent(text: string): NewsEventClassification {
  const haystack = ` ${String(text ?? '').toLowerCase()} `
  const scores: Record<NewsEventType, number> = {
    rate: 0,
    inflation: 0,
    employment: 0,
    growth: 0,
    regulation: 0,
    geopolitical: 0,
    earnings: 0,
    other: 0,
  }
  const hitsByType: Record<NewsEventType, string[]> = {
    rate: [],
    inflation: [],
    employment: [],
    growth: [],
    regulation: [],
    geopolitical: [],
    earnings: [],
    other: [],
  }

  let bestType: NewsEventType = 'other'
  let bestHits = 0
  for (const rule of EVENT_MATCHERS) {
    const hits = rule.keywords.filter(entry => entry.matches(haystack)).map(entry => entry.keyword)
    hitsByType[rule.type] = hits
    scores[rule.type] = hits.length
    if (hits.length > bestHits) {
      bestHits = hits.length
      bestType = rule.type
    }
  }

  let reason: string
  if (bestHits === 0) {
    reason = '事件类型 other：未命中任何事件关键词'
  } else {
    const shown = hitsByType[bestType].slice(0, 6).join('、')
    const more = hitsByType[bestType].length > 6 ? ` 等 ${hitsByType[bestType].length} 个` : ''
    reason = `事件类型 ${bestType}：命中「${shown}」${more}`
    const tied = NEWS_EVENT_RULES.filter(rule => scores[rule.type] === bestHits).map(rule => rule.type)
    if (tied.length > 1) reason += `；${tied.length} 类同分，按规则顺序取 ${bestType}`
  }

  return { type: bestType, hits: hitsByType[bestType], scores, reason }
}

// ---------------------------------------------------------------------------
// 时间归一化
// ---------------------------------------------------------------------------

export interface NormalizedPublishedAt {
  /** UTC ISO 8601；非法时间为 null。 */
  iso: string | null
  /** 原字符串没有时区信息，按 UTC 解释（不改写原始字符串）。 */
  assumedUtc: boolean
  invalid: boolean
  raw: string
}

const NAMED_ZONE_OFFSETS: Readonly<Record<string, string>> = Object.freeze({
  GMT: '+0000',
  UTC: '+0000',
  UT: '+0000',
  Z: '+0000',
  EST: '-0500',
  EDT: '-0400',
  CST: '-0600',
  CDT: '-0500',
  MST: '-0700',
  MDT: '-0600',
  PST: '-0800',
  PDT: '-0700',
  CET: '+0100',
  CEST: '+0200',
  EET: '+0200',
  EEST: '+0300',
  BST: '+0100',
  JST: '+0900',
  KST: '+0900',
  AEST: '+1000',
  AEDT: '+1100',
})

/**
 * 解析 RSS 的 RFC 822 / 822 变体、Atom 的 ISO 8601、中文 feed 的
 * `YYYY-MM-DD HH:MM:SS`。没有显式时区时按 UTC 解释并标记 assumedUtc：
 * JavaScript 的 `Date.parse` 在无时区时会用本机时区，不能用于确定性排序。
 */
export function normalizePublishedAt(raw: string): NormalizedPublishedAt {
  const rawText = String(raw ?? '').trim()
  if (!rawText) return { iso: null, assumedUtc: false, invalid: true, raw: rawText }

  let text = rawText
  let explicitZone = false

  const named = /(?:^|\s)(GMT|UTC|UT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|EET|EEST|BST|JST|KST|AEST|AEDT)$/i.exec(text)
  if (named) {
    explicitZone = true
    const zone = named[1]!.toUpperCase()
    const zoneStart = text.length - named[1]!.length
    text = `${text.slice(0, zoneStart)}${NAMED_ZONE_OFFSETS[zone] ?? '+0000'}`
  } else if (/[+-]\d{2}:?\d{2}\s*$/.test(text) || /Z\s*$/i.test(text)) {
    explicitZone = true
  }

  if (!explicitZone) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(text)
    const isoLocal = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(text)
    if (dateOnly) text = `${text}T00:00:00Z`
    else if (isoLocal) text = `${isoLocal[1]}T${isoLocal[2]}Z`
    else text = `${text} GMT`
  }

  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) {
    return { iso: null, assumedUtc: !explicitZone, invalid: true, raw: rawText }
  }
  return {
    iso: new Date(ms).toISOString(),
    assumedUtc: !explicitZone,
    invalid: false,
    raw: rawText,
  }
}

function resolveNowMs(now: string | Date): number {
  if (now instanceof Date) {
    const ms = now.getTime()
    if (!Number.isFinite(ms)) throw new Error('now 不是有效时间')
    return ms
  }
  const normalized = normalizePublishedAt(String(now))
  if (normalized.invalid || !normalized.iso) throw new Error(`now 不是有效时间：${String(now)}`)
  return Date.parse(normalized.iso)
}

// ---------------------------------------------------------------------------
// RSS / Atom / RDF 解析（零依赖）
// ---------------------------------------------------------------------------

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedParseError'
  }
}

export interface ParsedFeedItem {
  title: string
  link: string | null
  guid: string | null
  publishedRaw: string
  summary: string
  categories: string[]
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf' | 'unknown'
  title: string | null
  items: ParsedFeedItem[]
  /** 因缺少标题被跳过的 item 数。 */
  skipped: number
  warnings: string[]
}

interface CdataMask {
  masked: string
  sections: readonly string[]
}

function maskCdataSections(xml: string): CdataMask {
  const sections: string[] = []
  const masked = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all: string, inner: string) => {
    const index = sections.push(inner) - 1
    return `@@FIA_CDATA_${index}@@`
  })
  return { masked, sections }
}

function expandCdataSections(text: string, sections: readonly string[]): string {
  return text.replace(/@@FIA_CDATA_(\d+)@@/g, (_all: string, rawIndex: string) => {
    const index = Number(rawIndex)
    return Number.isInteger(index) && index >= 0 && index < sections.length ? sections[index]! : ''
  })
}

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all: string, entity: string) => {
    const key = entity.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    if (key === 'nbsp') return ' '
    let code: number
    if (key.startsWith('#x')) code = Number.parseInt(key.slice(2), 16)
    else if (key.startsWith('#')) code = Number.parseInt(key.slice(1), 10)
    else return all
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all
    try {
      return String.fromCodePoint(code)
    } catch {
      return all
    }
  })
}

/** XML/HTML 片段 → 可读纯文本；CDATA 展开后按 HTML 处理并还原实体。 */
function cleanXmlText(raw: string, sections: readonly string[]): string {
  const expanded = expandCdataSections(raw, sections)
  const decoded = decodeXmlEntities(expanded)
  const withoutScripts = decoded
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  const stripped = withoutScripts.replace(/<[^>]+>/g, ' ')
  return decodeXmlEntities(stripped).replace(/\s+/g, ' ').trim()
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function extractTagText(block: string, names: readonly string[], sections: readonly string[]): string {
  for (const name of names) {
    const escaped = escapeRegExp(name)
    const pattern = new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`,
      'i',
    )
    const match = pattern.exec(block)
    if (!match || match[1] === undefined) continue
    const text = cleanXmlText(match[1], sections)
    if (text) return text
  }
  return ''
}

function readAttribute(attrs: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(attrs)
  if (!match) return null
  return decodeXmlEntities(match[1] ?? match[2] ?? '')
}

/** Atom `<link href>` / RSS 里偶见的空 link 的自闭合写法。 */
function extractLinkHref(block: string): string | null {
  const candidates: { href: string; rel: string; type: string }[] = []
  const pattern = /<link\b([^>]*?)\/?>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    const attrs = match[1] ?? ''
    const href = readAttribute(attrs, 'href')
    if (!href) continue
    candidates.push({
      href,
      rel: (readAttribute(attrs, 'rel') ?? '').toLowerCase(),
      type: (readAttribute(attrs, 'type') ?? '').toLowerCase(),
    })
  }
  const preferred =
    candidates.find(candidate => (candidate.rel === '' || candidate.rel === 'alternate') && (candidate.type === '' || candidate.type.includes('html'))) ??
    candidates.find(candidate => candidate.rel === '' || candidate.rel === 'alternate') ??
    candidates[0]
  return preferred?.href ?? null
}

function extractCategories(block: string, sections: readonly string[]): string[] {
  const out: string[] = []
  const pattern = /<category\b([^>]*)>([\s\S]*?)<\/category>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    const attrs = match[1] ?? ''
    const term = readAttribute(attrs, 'term')
    const text = term || cleanXmlText(match[2] ?? '', sections)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= 8) break
  }
  return out
}

function looksLikeHtmlPage(xml: string): boolean {
  const head = xml
    .replace(/^\uFEFF/, '')
    .replace(/^<\?xml[\s\S]*?\?>/i, '')
    .trimStart()
    .slice(0, 300)
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head)
}

/**
 * 解析 RSS 2.0、Atom 1.0、RSS 1.0/RDF。只使用正则与字符串处理，不引入 XML
 * 库；CDATA 先替换成占位符，避免其中的 `</title>` 等文本破坏标签匹配。
 *
 * 空字符串、HTML 页面、没有可识别根元素、存在未闭合 item/entry 都会抛
 * `FeedParseError`，由调用方决定是单源失败还是整体失败；合法但无条目的 feed
 * 返回空数组（`items: []`）。
 */
export function parseFeedXml(xml: string): ParsedFeed {
  const source = String(xml ?? '')
  if (!source.trim()) throw new FeedParseError('空 feed：没有 XML 内容')
  const withoutComments = source.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').trim()
  if (looksLikeHtmlPage(withoutComments)) {
    throw new FeedParseError('收到 HTML 页面而不是 RSS/Atom feed；不能当作新闻 feed 解析')
  }

  const { masked, sections } = maskCdataSections(withoutComments)
  const rssRoot = /<(?:[A-Za-z_][\w.-]*:)?rss\b/i.test(masked)
  const atomRoot = /<(?:[A-Za-z_][\w.-]*:)?feed\b/i.test(masked)
  const rdfRoot = /<(?:[A-Za-z_][\w.-]*:)?RDF\b/i.test(masked)
  const format: ParsedFeed['format'] = rssRoot ? 'rss' : atomRoot ? 'atom' : rdfRoot ? 'rdf' : 'unknown'
  if (format === 'unknown') {
    throw new FeedParseError('无法识别的 feed 根元素：既不是 RSS <rss>，也不是 Atom <feed> / RDF')
  }

  const blockPattern = /<(?:[A-Za-z_][\w.-]*:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?\1\s*>/gi
  const blocks: string[] = []
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockPattern.exec(masked)) !== null) {
    blocks.push(blockMatch[2] ?? '')
  }
  const declared = (masked.match(/<(?:[A-Za-z_][\w.-]*:)?(?:item|entry)\b/gi) ?? []).length
  if (declared > blocks.length) {
    throw new FeedParseError(`feed 结构不完整：检测到 ${declared} 个 item/entry 开始标签，但只有 ${blocks.length} 个闭合块`)
  }

  const warnings: string[] = []
  let feedTitle: string | null = null
  if (format === 'atom') {
    const firstBlockIndex = masked.search(/<(?:[A-Za-z_][\w.-]*:)?(?:item|entry)\b/i)
    const prefix = firstBlockIndex >= 0 ? masked.slice(0, firstBlockIndex) : masked
    feedTitle = extractTagText(prefix, ['title'], sections) || null
  } else {
    const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(masked)
    if (channel?.[1]) {
      feedTitle = extractTagText(channel[1], ['title'], sections) || null
    } else {
      warnings.push('缺少 <channel> 元素')
    }
  }

  const items: ParsedFeedItem[] = []
  let skipped = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const title = truncateText(extractTagText(block, ['title'], sections), 300)
    if (!title) {
      skipped++
      warnings.push(`第 ${index + 1} 条 item/entry 缺少标题，已跳过`)
      continue
    }

    const linkText = extractTagText(block, ['link'], sections)
    const link = linkText || extractLinkHref(block)
    const guid = extractTagText(block, ['guid', 'id'], sections) || null

    const dateCandidates: string[] = []
    for (const name of ['pubDate', 'published', 'updated', 'date', 'pubTime']) {
      const value = extractTagText(block, [name], sections)
      if (value) dateCandidates.push(value)
    }
    let publishedRaw = dateCandidates[0] ?? ''
    for (const candidate of dateCandidates) {
      if (!normalizePublishedAt(candidate).invalid) {
        publishedRaw = candidate
        break
      }
    }

    const summary = truncateText(
      extractTagText(block, ['description', 'summary', 'content', 'encoded'], sections),
      600,
    )
    const categories = extractCategories(block, sections)

    items.push({
      title,
      link: link ? truncateText(link, 2000) : null,
      guid,
      publishedRaw,
      summary,
      categories,
    })
  }

  if (items.length === 0) warnings.push('feed 中没有可用的 item/entry（空 feed）')

  return { format, title: feedTitle, items, skipped, warnings }
}

// ---------------------------------------------------------------------------
// 去重键
// ---------------------------------------------------------------------------

export function normalizeNewsTitle(raw: string): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 只做不会改变文章身份的规范化：去 fragment、去营销参数、主机小写、去 www、
 * 合并重复斜杠、去末尾斜杠。保留 query 中可能用于定位文章的字段。
 */
export function canonicalizeNewsUrl(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    const tracking = [...url.searchParams.keys()].filter(key => /^(?:utm_|fbclid$|gclid$|mc_cid$|mc_eid$|_hsenc$|_hsmi$)/i.test(key))
    for (const key of tracking) url.searchParams.delete(key)
    url.pathname = url.pathname.replace(/\/{2,}/g, '/')
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
    return url.toString()
  } catch {
    return text.toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

export interface RadarQuoteMove {
  symbol: string
  /** 当日涨跌幅（%）；缺失用 null/undefined，绝不按 0 计入。 */
  changePct?: number | null
}

export interface RadarRelevanceProfile {
  /** 来自持仓 / 自选 / 关注行业的可读关键词，例如公司名、行业名、ticker。 */
  keywords: readonly string[]
  label?: string
}

export interface RadarScoreComponents {
  authority: number
  event: number
  firstHand: number
  recency: number
  reaction: number
  relevance: number
}

export interface RadarScoreBreakdown {
  total: number
  components: RadarScoreComponents
  reasons: string[]
}

export interface ScoreNewsItemInput {
  authority: NewsSourceAuthority
  eventType: NewsEventType
  eventHits?: readonly string[]
  publishedAt: string | null
  now: string | Date
  quotes?: readonly RadarQuoteMove[]
  relevance?: RadarRelevanceProfile
  /** 用于关键词相关性的文本（通常 title + summary）。 */
  relevanceText?: string
  halfLifeHours?: number
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function finitePct(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 确定性打分。每个分项都附带 reasons；相同输入永远得到相同 total。
 */
export function scoreNewsItem(input: ScoreNewsItemInput): RadarScoreBreakdown {
  const nowMs = resolveNowMs(input.now)
  const authority = AUTHORITY_WEIGHTS[input.authority]
  const event = EVENT_TYPE_WEIGHTS[input.eventType]
  const firstHand = input.authority === 'media' ? 0 : input.authority === 'exchange' ? 2 : 5
  const reasons: string[] = []

  reasons.push(`来源等级 ${input.authority}（${AUTHORITY_LABELS[input.authority]}）：+${authority}`)

  if (input.authority === 'media') {
    reasons.push('一手性：媒体源不是官方一手，+0')
  } else if (input.authority === 'exchange') {
    reasons.push(`一手性：交易所公开信息，+${firstHand}`)
  } else {
    reasons.push(`一手性：官方/央行/监管/统计一手，+${firstHand}`)
  }

  const hitNote = input.eventHits && input.eventHits.length > 0
    ? `；命中「${input.eventHits.slice(0, 6).join('、')}」${input.eventHits.length > 6 ? ' 等' : ''}`
    : ''
  reasons.push(`事件类型 ${input.eventType}（${EVENT_LABELS[input.eventType]}）：+${event}${hitNote}`)

  const halfLifeHours = input.halfLifeHours ?? RADAR_SCORE_MODEL.halfLifeHours
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) {
    throw new Error('halfLifeHours 必须是正数')
  }

  let recency = 0
  if (!input.publishedAt) {
    reasons.push('时间衰减：无有效发布时间，时间项记 0（不改写原始时间）')
  } else {
    const normalizedPublished = normalizePublishedAt(input.publishedAt)
    const publishedMs = normalizedPublished.iso ? Date.parse(normalizedPublished.iso) : NaN
    if (!Number.isFinite(publishedMs)) {
      reasons.push('时间衰减：发布时间无法解析，时间项记 0')
    } else if (publishedMs > nowMs) {
      reasons.push('时间衰减：发布时间晚于参考时间，时间项记 0（不改写原始时间）')
    } else {
      const ageHours = (nowMs - publishedMs) / 3_600_000
      recency = round2(
        RADAR_SCORE_MODEL.recencyMax * Math.pow(0.5, ageHours / halfLifeHours),
      )
      const ageText = ageHours < 1 ? ageHours.toFixed(2) : ageHours.toFixed(1)
      reasons.push(`时间衰减：发布 ${ageText} 小时前，半衰期 ${halfLifeHours}h → +${recency}`)
    }
  }

  const quotes = input.quotes ?? []
  const usableQuotes = quotes
    .map(quote => ({ symbol: quote.symbol, pct: finitePct(quote.changePct) }))
    .filter((quote): quote is { symbol: string; pct: number } => quote.pct !== null)
  let reaction = 0
  if (quotes.length === 0) {
    reasons.push('跨资产反应：未注入行情，反应项记 0（缺失≠无反应）')
  } else if (usableQuotes.length === 0) {
    reasons.push(`跨资产反应：提供 ${quotes.length} 条行情但均缺有效涨跌幅，反应项记 0（缺失≠无反应）`)
  } else {
    const avgAbs = usableQuotes.reduce((sum, quote) => sum + Math.abs(quote.pct), 0) / usableQuotes.length
    reaction = round2(Math.min(
      RADAR_SCORE_MODEL.reactionMax,
      avgAbs * RADAR_SCORE_MODEL.reactionPointsPerAvgAbsPct,
    ))
    const sample = usableQuotes
      .slice(0, 4)
      .map(quote => `${quote.symbol} ${quote.pct >= 0 ? '+' : ''}${quote.pct.toFixed(2)}%`)
      .join('、')
    reasons.push(
      `跨资产反应：${usableQuotes.length} 条行情平均绝对涨跌 ${avgAbs.toFixed(2)}%（只取幅度，不解释因果/方向）→ +${reaction}（${sample}${usableQuotes.length > 4 ? '…' : ''}）`,
    )
  }

  const keywordList = Array.from(new Set(
    (input.relevance?.keywords ?? []).map(keyword => String(keyword).trim()).filter(Boolean),
  ))
  let relevance = 0
  if (keywordList.length === 0) {
    reasons.push('持仓/自选相关性：未提供关键词，相关性项记 0（缺失≠不相关）')
  } else {
    const haystack = ` ${String(input.relevanceText ?? '').toLowerCase()} `
    const matched = keywordList.filter(keyword => buildKeywordMatcher(keyword)(haystack))
    relevance = round2(Math.min(
      RADAR_SCORE_MODEL.relevanceMax,
      matched.length * RADAR_SCORE_MODEL.relevancePointsPerHit,
    ))
    const profile = input.relevance?.label ? `「${input.relevance.label}」` : ''
    if (matched.length === 0) {
      reasons.push(`持仓/自选相关性：${profile}关键词均未命中（检查 ${keywordList.length} 个），+0`)
    } else {
      reasons.push(
        `持仓/自选相关性：${profile}命中 ${matched.length} 个关键词「${matched.slice(0, 8).join('、')}」→ +${relevance}`,
      )
    }
  }

  const components: RadarScoreComponents = { authority, event, firstHand, recency, reaction, relevance }
  const total = round2(Math.min(
    RADAR_SCORE_MODEL.maxTotal,
    Object.values(components).reduce((sum, value) => sum + value, 0),
  ))
  return { total, components, reasons }
}

// ---------------------------------------------------------------------------
// 构建雷达
// ---------------------------------------------------------------------------

export interface GlobalNewsFeedPayload {
  source: GlobalNewsFeedSource
  xml: string
}

export interface GlobalNewsRadarOptions {
  /** 参考时间（窗口与时间衰减的基准）。必须显式给出，保证可复现。 */
  now: string | Date
  /** 时间窗（小时）。默认 168（7 天）；传 null 关闭窗口过滤。 */
  windowHours?: number | null
  halfLifeHours?: number
  quotes?: readonly RadarQuoteMove[]
  relevance?: RadarRelevanceProfile
  /** 返回条数上限，默认 100；传 0 返回空列表但仍计算统计。 */
  maxItems?: number
  minScore?: number
}

export interface RadarNewsItem {
  id: string
  sourceId: string
  sourceName: string
  authority: NewsSourceAuthority
  family: NewsSourceFamily
  region: NewsSourceRegion
  title: string
  link: string | null
  guid: string | null
  summary: string
  /** UTC ISO；非法/缺失为 null。 */
  publishedAt: string | null
  publishedRaw: string
  /** 原时间无时区、按 UTC 解释。 */
  publishedAtAssumedUtc: boolean
  dateInvalid: boolean
  eventType: NewsEventType
  eventHits: string[]
  /** 事件分类的完整解释（命中词/同分规则），与 score.reasons 分开保存。 */
  eventReason: string
  score: RadarScoreBreakdown
}

export interface RadarFeedDiagnostic {
  sourceId: string
  sourceName: string
  ok: boolean
  format?: ParsedFeed['format']
  feedTitle?: string | null
  items?: number
  skipped?: number
  error?: string
}

export interface RadarStats {
  feeds: number
  feedsFailed: number
  parsedItems: number
  skippedItems: number
  invalidDates: number
  excludedInvalidDates: number
  excludedOutOfWindow: number
  excludedFutureDated: number
  duplicatesRemoved: number
  scoredItems: number
  excludedBelowMinScore: number
  truncatedItems: number
  returnedItems: number
}

export interface GlobalNewsRadarResult {
  generatedAt: string
  windowHours: number | null
  scoreModel: typeof RADAR_SCORE_MODEL
  items: RadarNewsItem[]
  groups: {
    official: RadarNewsItem[]
    media: RadarNewsItem[]
  }
  stats: RadarStats
  feedDiagnostics: RadarFeedDiagnostic[]
  disclaimer: string
}

interface DraftNewsItem {
  id: string
  sourceId: string
  sourceName: string
  authority: NewsSourceAuthority
  family: NewsSourceFamily
  region: NewsSourceRegion
  title: string
  link: string | null
  guid: string | null
  summary: string
  publishedAt: string | null
  publishedRaw: string
  publishedAtAssumedUtc: boolean
  dateInvalid: boolean
  eventType: NewsEventType
  eventHits: string[]
  eventReason: string
  titleTimeKey: string
  urlKey: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function createNewsId(
  sourceId: string,
  guid: string | null,
  link: string | null,
  normalizedTitle: string,
  publishedAt: string | null,
): string {
  const stable = [sourceId, guid ?? '', link ?? '', normalizedTitle, publishedAt ?? 'invalid-date'].join('\u001f')
  return `gn-${createHash('sha1').update(stable).digest('hex').slice(0, 16)}`
}

function resolveFeedLink(raw: string | null | undefined, baseUrl: string): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    return new URL(text, baseUrl).toString()
  } catch {
    return text
  }
}

/** 同一稿件的优先级：官方等级高 > 更早发布 > 有链接 > sourceId/id 字典序。 */
function compareDraftPreference(a: DraftNewsItem, b: DraftNewsItem): number {
  const authority = AUTHORITY_WEIGHTS[b.authority] - AUTHORITY_WEIGHTS[a.authority]
  if (authority !== 0) return authority
  const aTime = a.publishedAt ? Date.parse(a.publishedAt) : Number.POSITIVE_INFINITY
  const bTime = b.publishedAt ? Date.parse(b.publishedAt) : Number.POSITIVE_INFINITY
  if (aTime !== bTime) return aTime - bTime
  if (a.link && !b.link) return -1
  if (!a.link && b.link) return 1
  return compareText(a.sourceId, b.sourceId) || compareText(a.id, b.id)
}

function dedupeDrafts(drafts: readonly DraftNewsItem[]): { kept: DraftNewsItem[]; removed: number } {
  if (drafts.length < 2) return { kept: [...drafts], removed: 0 }

  const parent = drafts.map((_, index) => index)
  const find = (start: number): number => {
    let current = start
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!
      current = parent[current]!
    }
    return current
  }
  const union = (a: number, b: number): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  const seen = new Map<string, number>()
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!
    const keys = [`title-time:${draft.titleTimeKey}`]
    if (draft.urlKey) keys.push(`url:${draft.urlKey}`)
    for (const key of keys) {
      const existing = seen.get(key)
      if (existing === undefined) seen.set(key, index)
      else union(index, existing)
    }
  }

  const groups = new Map<number, DraftNewsItem[]>()
  for (let index = 0; index < drafts.length; index++) {
    const root = find(index)
    const group = groups.get(root)
    if (group) group.push(drafts[index]!)
    else groups.set(root, [drafts[index]!])
  }

  const kept: DraftNewsItem[] = []
  for (const group of groups.values()) {
    let best = group[0]!
    for (let index = 1; index < group.length; index++) {
      const candidate = group[index]!
      if (compareDraftPreference(candidate, best) < 0) best = candidate
    }
    kept.push(best)
  }
  return { kept, removed: drafts.length - kept.length }
}

export function compareRadarItems(a: RadarNewsItem, b: RadarNewsItem): number {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total
  const aTime = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY
  const bTime = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY
  if (aTime !== bTime) return bTime - aTime
  return compareText(a.sourceId, b.sourceId) || compareText(a.id, b.id) || compareText(a.title, b.title)
}

export function groupRadarItemsByFamily(items: readonly RadarNewsItem[]): {
  official: RadarNewsItem[]
  media: RadarNewsItem[]
} {
  const official: RadarNewsItem[] = []
  const media: RadarNewsItem[] = []
  for (const item of items) {
    if (item.family === 'media') media.push(item)
    else official.push(item)
  }
  return { official, media }
}

/**
 * 纯函数：接收已经取回的 feed XML（fixture 或线上响应），完成解析、归一化、
 * 窗口过滤、去重、打分和稳定排序。不发起网络请求、不读写文件。
 */
export function buildGlobalNewsRadar(
  payloads: readonly GlobalNewsFeedPayload[],
  options: GlobalNewsRadarOptions,
): GlobalNewsRadarResult {
  const nowMs = resolveNowMs(options.now)
  const windowHours = options.windowHours === undefined ? 168 : options.windowHours
  if (windowHours !== null && (!Number.isFinite(windowHours) || windowHours <= 0)) {
    throw new Error('windowHours 必须是正数或 null')
  }
  const halfLifeHours = options.halfLifeHours ?? RADAR_SCORE_MODEL.halfLifeHours
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) {
    throw new Error('halfLifeHours 必须是正数')
  }
  const maxItems = options.maxItems ?? 100
  if (!Number.isInteger(maxItems) || maxItems < 0) throw new Error('maxItems 必须是非负整数')
  const minScore = options.minScore ?? 0
  if (!Number.isFinite(minScore)) throw new Error('minScore 必须是有限数字')

  const windowMs = windowHours === null ? null : windowHours * 3_600_000
  const stats: RadarStats = {
    feeds: payloads.length,
    feedsFailed: 0,
    parsedItems: 0,
    skippedItems: 0,
    invalidDates: 0,
    excludedInvalidDates: 0,
    excludedOutOfWindow: 0,
    excludedFutureDated: 0,
    duplicatesRemoved: 0,
    scoredItems: 0,
    excludedBelowMinScore: 0,
    truncatedItems: 0,
    returnedItems: 0,
  }
  const feedDiagnostics: RadarFeedDiagnostic[] = []
  const drafts: DraftNewsItem[] = []

  for (const payload of payloads) {
    let parsed: ParsedFeed
    try {
      parsed = parseFeedXml(payload.xml)
    } catch (error) {
      stats.feedsFailed++
      feedDiagnostics.push({
        sourceId: payload.source.id,
        sourceName: payload.source.name,
        ok: false,
        error: errorMessage(error),
      })
      continue
    }

    stats.skippedItems += parsed.skipped
    feedDiagnostics.push({
      sourceId: payload.source.id,
      sourceName: payload.source.name,
      ok: true,
      format: parsed.format,
      feedTitle: parsed.title,
      items: parsed.items.length,
      skipped: parsed.skipped,
    })

    for (const item of parsed.items) {
      stats.parsedItems++
      const published = normalizePublishedAt(item.publishedRaw)
      if (published.invalid) stats.invalidDates++

      if (windowMs !== null) {
        if (!published.iso) {
          stats.excludedInvalidDates++
          continue
        }
        const publishedMs = Date.parse(published.iso)
        if (publishedMs > nowMs) {
          stats.excludedFutureDated++
          continue
        }
        if (nowMs - publishedMs > windowMs) {
          stats.excludedOutOfWindow++
          continue
        }
      }

      const normalizedTitle = normalizeNewsTitle(item.title)
      if (!normalizedTitle) {
        stats.skippedItems++
        continue
      }

      const link = resolveFeedLink(item.link, payload.source.url) ??
        resolveFeedLink(item.guid, payload.source.url)
      const urlKey = canonicalizeNewsUrl(link)
      const titleTimeKey = `${normalizedTitle}|${published.iso ? published.iso.slice(0, 16) : 'invalid-date'}`
      const classification = classifyNewsEvent(`${item.title} ${item.summary}`)
      const family: NewsSourceFamily = payload.source.authority === 'media' ? 'media' : 'official'

      drafts.push({
        id: createNewsId(payload.source.id, item.guid, link, normalizedTitle, published.iso),
        sourceId: payload.source.id,
        sourceName: payload.source.name,
        authority: payload.source.authority,
        family,
        region: payload.source.region,
        title: item.title,
        link,
        guid: item.guid,
        summary: item.summary,
        publishedAt: published.iso,
        publishedRaw: item.publishedRaw,
        publishedAtAssumedUtc: published.assumedUtc && !published.invalid,
        dateInvalid: published.invalid,
        eventType: classification.type,
        eventHits: classification.hits,
        eventReason: classification.reason,
        titleTimeKey,
        urlKey,
      })
    }
  }

  const deduped = dedupeDrafts(drafts)
  stats.duplicatesRemoved = deduped.removed
  stats.scoredItems = deduped.kept.length

  const scored: RadarNewsItem[] = deduped.kept.map(draft => ({
    id: draft.id,
    sourceId: draft.sourceId,
    sourceName: draft.sourceName,
    authority: draft.authority,
    family: draft.family,
    region: draft.region,
    title: draft.title,
    link: draft.link,
    guid: draft.guid,
    summary: draft.summary,
    publishedAt: draft.publishedAt,
    publishedRaw: draft.publishedRaw,
    publishedAtAssumedUtc: draft.publishedAtAssumedUtc,
    dateInvalid: draft.dateInvalid,
    eventType: draft.eventType,
    eventHits: draft.eventHits,
    eventReason: draft.eventReason,
    score: scoreNewsItem({
      authority: draft.authority,
      eventType: draft.eventType,
      eventHits: draft.eventHits,
      publishedAt: draft.publishedAt,
      now: new Date(nowMs),
      quotes: options.quotes,
      relevance: options.relevance,
      relevanceText: `${draft.title} ${draft.summary}`,
      halfLifeHours,
    }),
  }))

  scored.sort(compareRadarItems)
  const aboveMinScore = scored.filter(item => item.score.total >= minScore)
  stats.excludedBelowMinScore = scored.length - aboveMinScore.length
  const returned = aboveMinScore.slice(0, maxItems)
  stats.truncatedItems = aboveMinScore.length - returned.length
  stats.returnedItems = returned.length

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours,
    scoreModel: RADAR_SCORE_MODEL,
    items: returned,
    groups: groupRadarItemsByFamily(returned),
    stats,
    feedDiagnostics,
    disclaimer: RADAR_DISCLAIMER,
  }
}

// ---------------------------------------------------------------------------
// 抓取（显式调用才联网）
// ---------------------------------------------------------------------------

export type NewsFeedFetchStatus = 'ok' | 'http-error' | 'timeout' | 'network-error' | 'parse-error'

export interface NewsFeedFetchOutcome {
  source: GlobalNewsFeedSource
  status: NewsFeedFetchStatus
  ok: boolean
  httpStatus?: number
  contentType?: string
  /** 仅 ok 时保留 XML 原文，供 build 或调试；parse-error 不回落成“可用”。 */
  xml?: string
  itemCount?: number
  feedFormat?: ParsedFeed['format']
  error?: string
  fetchedAt: string
}

export interface FetchNewsFeedsOptions {
  /** 测试注入点；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 固定抓取时间（测试）；默认当前时间。 */
  fetchedAt?: string
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) finance-ds-global-news-radar/0.1'

export async function fetchNewsFeed(
  source: GlobalNewsFeedSource,
  options: FetchNewsFeedsOptions = {},
): Promise<NewsFeedFetchOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1, options.timeoutMs ?? 12_000)
  const fetchedAt = options.fetchedAt ?? new Date().toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(source.url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? undefined
    if (!response.ok) {
      return {
        source,
        status: 'http-error',
        ok: false,
        httpStatus: response.status,
        contentType,
        error: `HTTP ${response.status}`,
        fetchedAt,
      }
    }
    const xml = await response.text()
    try {
      const parsed = parseFeedXml(xml)
      return {
        source,
        status: 'ok',
        ok: true,
        httpStatus: response.status,
        contentType,
        xml,
        itemCount: parsed.items.length,
        feedFormat: parsed.format,
        fetchedAt,
      }
    } catch (error) {
      return {
        source,
        status: 'parse-error',
        ok: false,
        httpStatus: response.status,
        contentType,
        error: errorMessage(error),
        fetchedAt,
      }
    }
  } catch (error) {
    const message = errorMessage(error)
    const aborted = (error as { name?: string } | null)?.name === 'AbortError' || /abort/i.test(message)
    return {
      source,
      status: aborted ? 'timeout' : 'network-error',
      ok: false,
      error: message,
      fetchedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 串行抓取（对公共源更克制）；单个源失败不会中断其它源。 */
export async function fetchNewsFeeds(
  sources: readonly GlobalNewsFeedSource[] = getEnabledOfficialNewsFeeds(),
  options: FetchNewsFeedsOptions = {},
): Promise<NewsFeedFetchOutcome[]> {
  const outcomes: NewsFeedFetchOutcome[] = []
  for (const source of sources) {
    outcomes.push(await fetchNewsFeed(source, options))
  }
  return outcomes
}

export interface GlobalNewsRadarFetchOptions extends GlobalNewsRadarOptions {
  /** 显式给定源列表；默认只用启用的官方源。仍会过滤未 realChecked 的源。 */
  sources?: readonly GlobalNewsFeedSource[]
  fetchOptions?: FetchNewsFeedsOptions
}

export interface GlobalNewsRadarRun {
  radar: GlobalNewsRadarResult
  fetches: NewsFeedFetchOutcome[]
}

/**
 * 抓取启用源并构建雷达。默认只抓官方源；媒体源需要调用方显式传入
 * `sources`。所有抓取失败都会出现在 `fetches` 里，不会静默补 0 条。
 */
export async function fetchAndBuildGlobalNewsRadar(
  options: GlobalNewsRadarFetchOptions,
): Promise<GlobalNewsRadarRun> {
  const selected = (options.sources ?? getEnabledOfficialNewsFeeds())
    .filter(source => source.realChecked)
  const fetches = await fetchNewsFeeds(selected, options.fetchOptions ?? {})
  const payloads: GlobalNewsFeedPayload[] = []
  for (const outcome of fetches) {
    if (outcome.ok && outcome.xml) payloads.push({ source: outcome.source, xml: outcome.xml })
  }
  return { radar: buildGlobalNewsRadar(payloads, options), fetches }
}
