/**
 * 全球市场新闻雷达 · feed 源清单（纯配置，导入本文件不会发起网络请求）。
 *
 * 探测口径（2026-11-17，本机 Windows / Node 22，UA 为
 * `Mozilla/5.0 ... finance-ds-global-radar/0.1`）：
 * - `realChecked: true` = 本机 HTTP 可达，且返回体能被
 *   `src/news/global-radar.ts` 的零依赖 RSS/Atom 解析器结构化解析（至少 1 条
 *   item/entry；空 feed 不算结构可解析）。
 * - `enabled` = 是否纳入默认抓取。默认只抓官方源（official），媒体源保留在
 *   清单里但默认关闭，必须由调用方显式把 source 传给抓取函数。
 * - 没有「看似可达」的占位源：不可达的官方源放在 `UNAVAILABLE_OFFICIAL_FEEDS`，
 *   `realChecked: false`、`enabled: false`，并保留本机探测状态与原因。
 *
 * 可达性会随网络、WAF、UA、地区变化。抓取失败必须视为运行时诊断（见
 * `fetchNewsFeeds`），不能因为配置里 `realChecked: true` 就声称本次抓到。
 */

export type NewsSourceAuthority =
  | 'official'
  | 'central-bank'
  | 'statistics'
  | 'regulator'
  | 'exchange'
  | 'media'

/** 官方一手源与媒体源在配置、输出和默认抓取上都保持分开。 */
export type NewsSourceFamily = 'official' | 'media'

export type NewsSourceRegion = 'US' | 'EU' | 'UK' | 'international' | 'global'

export type FeedFormatHint = 'rss' | 'atom' | 'rdf' | 'unknown'

export type FeedProbeStatus = 'reachable' | 'http-error' | 'not-feed' | 'timeout' | 'blocked'

export interface NewsFeedProbe {
  /** 本机实测日期（YYYY-MM-DD，Asia/Shanghai）。 */
  checkedAt: string
  status: FeedProbeStatus
  httpStatus?: number
  contentType?: string
  /** 实测细节：状态码、内容类型、item 数、结构特征或失败原因。 */
  detail: string
}

export interface GlobalNewsFeedSource {
  id: string
  name: string
  url: string
  authority: NewsSourceAuthority
  family: NewsSourceFamily
  region: NewsSourceRegion
  formatHint: FeedFormatHint
  /** 是否纳入默认抓取；仅对官方源默认为 true。 */
  enabled: boolean
  /** 本机实测可达且结构可解析。抓取时仍需重新检查本次结果。 */
  realChecked: boolean
  probe: NewsFeedProbe
  note?: string
}

export const NEWS_FEED_PROBE_DATE = '2026-11-17'

/**
 * 默认启用的官方一手 feed。
 *
 * 说明：Fed 的 `press_monetary.xml` 本机同样可达，但它是 `press_all.xml` 的
 * 子集，默认不重复启用；避免同一稿件在多路 feed 中重复进入雷达。
 */
export const OFFICIAL_NEWS_FEEDS: readonly GlobalNewsFeedSource[] = Object.freeze([
  {
    id: 'fed-press-all',
    name: '美联储（Federal Reserve）全部新闻稿',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    authority: 'central-bank',
    family: 'official',
    region: 'US',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'text/xml',
      detail: '200 text/xml；20 条 item；标题/链接/pubDate 使用 CDATA，由本模块解析。',
    },
  },
  {
    id: 'ecb-press',
    name: '欧洲央行（ECB）新闻稿',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    authority: 'central-bank',
    family: 'official',
    region: 'EU',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/rss+xml',
      detail: '200 application/rss+xml；15 条 item；pubDate 含 +0100 时区偏移。',
    },
  },
  {
    id: 'bis-press',
    name: '国际清算银行（BIS）媒体发布',
    url: 'https://www.bis.org/doclist/all_pressrels.rss',
    authority: 'official',
    family: 'official',
    region: 'international',
    formatHint: 'rdf',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/rss+xml',
      detail: '200 application/rss+xml；RSS 1.0/RDF；1 条 item；dc:date 为 ISO 8601。',
    },
    note: '低频源；条目少不代表当天没有发布，只是该 feed 当前仅 1 条。',
  },
  {
    id: 'sec-press-releases',
    name: '美国证监会（SEC）新闻稿',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    authority: 'regulator',
    family: 'official',
    region: 'US',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/rss+xml',
      detail: '200 application/rss+xml；25 条 item；pubDate 为 -0500。',
    },
  },
  {
    id: 'sec-statements',
    name: '美国证监会（SEC）公开声明',
    url: 'https://www.sec.gov/news/statements.rss',
    authority: 'regulator',
    family: 'official',
    region: 'US',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/rss+xml',
      detail: '200 application/rss+xml；25 条 item；与 press releases 是不同频道。',
    },
  },
  {
    id: 'boe-news',
    name: '英格兰银行（Bank of England）新闻',
    url: 'https://www.bankofengland.co.uk/rss/news',
    authority: 'central-bank',
    family: 'official',
    region: 'UK',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'text/xml',
      detail: '200 text/xml；50 条 item；pubDate 使用 Z（UTC）。',
    },
  },
])

/**
 * 媒体源：与官方源分开保存，默认不启用。
 *
 * CNBC 在 2026-11-17 复测为 200 且能解析出 30 条 item，但任务方此前记录到
 * 403/超时，稳定性存疑；即使 `realChecked: true` 也保持 `enabled: false`，
 * 由调用方决定是否显式使用。Google News 与 Yahoo Finance 在本机不可达。
 */
export const MEDIA_NEWS_FEEDS: readonly GlobalNewsFeedSource[] = Object.freeze([
  {
    id: 'cnbc-top-news',
    name: 'CNBC Top News',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    authority: 'media',
    family: 'media',
    region: 'US',
    formatHint: 'rss',
    enabled: false,
    realChecked: true,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/xml',
      detail: '200 application/xml；30 条 item；任务方此前报告 403/超时，默认不启用。',
    },
    note: '媒体源，非一手；默认不进入雷达，需显式传入抓取函数。',
  },
  {
    id: 'google-news',
    name: 'Google News 头条',
    url: 'https://news.google.com/rss',
    authority: 'media',
    family: 'media',
    region: 'global',
    formatHint: 'rss',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'http-error',
      httpStatus: 429,
      detail: '本机 429 Too Many Requests；任务方亦报告超时。未纳入抓取。',
    },
  },
  {
    id: 'yahoo-finance',
    name: 'Yahoo Finance 新闻',
    url: 'https://finance.yahoo.com/news/rssindex',
    authority: 'media',
    family: 'media',
    region: 'US',
    formatHint: 'rss',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'http-error',
      httpStatus: 404,
      detail: '本机 404；任务方此前报告 403/超时。未纳入抓取，也不猜测新端点。',
    },
  },
])

/**
 * 实测不可用的官方源：保留失败证据，默认关闭，绝不伪装成可用。
 */
export const UNAVAILABLE_OFFICIAL_FEEDS: readonly GlobalNewsFeedSource[] = Object.freeze([
  {
    id: 'imf-news',
    name: '国际货币基金组织（IMF）新闻',
    url: 'https://www.imf.org/en/News/RSS',
    authority: 'official',
    family: 'official',
    region: 'international',
    formatHint: 'unknown',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'http-error',
      httpStatus: 403,
      detail: 'en/News/RSS、en/News/rss、external/rss/news.aspx 三个候选均 403。未启用。',
    },
  },
  {
    id: 'worldbank-news',
    name: '世界银行（World Bank）新闻',
    url: 'https://www.worldbank.org/en/news/all?format=rss',
    authority: 'official',
    family: 'official',
    region: 'international',
    formatHint: 'unknown',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'not-feed',
      httpStatus: 200,
      contentType: 'text/html',
      detail: '200 但返回 HTML 页面（无 item/entry）；其他 /rss 路径为 404。不是 feed。',
    },
  },
  {
    id: 'treasury-press',
    name: '美国财政部（Treasury）新闻',
    url: 'https://home.treasury.gov/rss/press.xml',
    authority: 'official',
    family: 'official',
    region: 'US',
    formatHint: 'unknown',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'http-error',
      httpStatus: 404,
      detail: 'home.treasury.gov 下 6 个候选路径均 404；treasury.gov/rss/press.xml 重定向到 HTML 页面。未找到可用 feed。',
    },
  },
  {
    id: 'bls-latest',
    name: '美国劳工统计局（BLS）最新发布',
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    authority: 'statistics',
    family: 'official',
    region: 'US',
    formatHint: 'rss',
    enabled: false,
    realChecked: false,
    probe: {
      checkedAt: NEWS_FEED_PROBE_DATE,
      status: 'http-error',
      httpStatus: 403,
      detail: '403 Forbidden（本机 2026-11-17 复测）。未启用，不把统计发布伪装成可用。',
    },
  },
])

export const NEWS_FEEDS: readonly GlobalNewsFeedSource[] = Object.freeze([
  ...OFFICIAL_NEWS_FEEDS,
  ...MEDIA_NEWS_FEEDS,
  ...UNAVAILABLE_OFFICIAL_FEEDS,
])

/** 默认雷达使用的源：官方、启用、且本机实测可达可解析。 */
export const ENABLED_NEWS_FEEDS: readonly GlobalNewsFeedSource[] = Object.freeze(
  NEWS_FEEDS.filter(source => source.family === 'official' && source.enabled && source.realChecked),
)

/** 默认官方抓取清单（供纯模块调用方直接使用）。 */
export function getEnabledOfficialNewsFeeds(): readonly GlobalNewsFeedSource[] {
  return ENABLED_NEWS_FEEDS
}

/** 本机实测可达的媒体源；默认不启用，仅作为显式 opt-in 列表。 */
export function getVerifiedMediaNewsFeeds(): readonly GlobalNewsFeedSource[] {
  return NEWS_FEEDS.filter(source => source.family === 'media' && source.realChecked)
}

/** 按 id 找源配置（找不到返回 undefined，不自动猜测）。 */
export function getNewsFeedSource(id: string): GlobalNewsFeedSource | undefined {
  return NEWS_FEEDS.find(source => source.id === id)
}
