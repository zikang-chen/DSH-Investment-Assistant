/**
 * 全球市场新闻雷达 · 离线测试（task-11）。
 *
 * 全部输入都是内联 fixture：不发起真实网络请求、不读 data/ 或任何私有数据、
 * 不写仓库文件。抓取层通过注入的 fetch 假实现测试，真实可达性由脚本外的
 * 手工探测负责，不能把测试通过当成线上可达。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildGlobalNewsRadar,
  canonicalizeNewsUrl,
  classifyNewsEvent,
  fetchAndBuildGlobalNewsRadar,
  fetchNewsFeed,
  normalizeNewsTitle,
  normalizePublishedAt,
  parseFeedXml,
  RADAR_DISCLAIMER,
  RADAR_SCORE_MODEL,
  scoreNewsItem,
  type GlobalNewsFeedPayload,
  type GlobalNewsRadarOptions,
  type ScoreNewsItemInput,
} from '../src/news/global-radar.js'
import {
  ENABLED_NEWS_FEEDS,
  getEnabledOfficialNewsFeeds,
  getNewsFeedSource,
  getVerifiedMediaNewsFeeds,
  MEDIA_NEWS_FEEDS,
  NEWS_FEEDS,
  OFFICIAL_NEWS_FEEDS,
  UNAVAILABLE_OFFICIAL_FEEDS,
  type GlobalNewsFeedSource,
} from '../src/news/feed-sources.js'

const NOW = '2026-11-17T12:00:00Z'
let checks = 0

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await fn()
  checks++
  console.log(`PASS ${checks}. ${name}`)
}

function fixtureSource(overrides: Partial<GlobalNewsFeedSource> = {}): GlobalNewsFeedSource {
  return {
    id: 'fixture-source',
    name: 'Fixture Source',
    url: 'https://fixture.test/feed.xml',
    authority: 'official',
    family: 'official',
    region: 'global',
    formatHint: 'rss',
    enabled: true,
    realChecked: true,
    probe: {
      checkedAt: '2026-11-17',
      status: 'reachable',
      httpStatus: 200,
      contentType: 'application/xml',
      detail: 'fixture only',
    },
    ...overrides,
  }
}

interface FixtureItem {
  title?: string | null
  link?: string | null
  guid?: string | null
  date?: string | null
  summary?: string | null
  extra?: string
}

function rssItem(item: FixtureItem): string {
  const fields: string[] = []
  if (item.title !== null && item.title !== undefined) fields.push(`<title><![CDATA[${item.title}]]></title>`)
  if (item.link !== null && item.link !== undefined) fields.push(`<link><![CDATA[${item.link}]]></link>`)
  if (item.guid !== null && item.guid !== undefined) fields.push(`<guid><![CDATA[${item.guid}]]></guid>`)
  if (item.date !== null && item.date !== undefined) fields.push(`<pubDate><![CDATA[${item.date}]]></pubDate>`)
  if (item.summary !== null && item.summary !== undefined) fields.push(`<description><![CDATA[${item.summary}]]></description>`)
  if (item.extra) fields.push(item.extra)
  return `<item>${fields.join('')}</item>`
}

function makeRss(items: readonly string[], channelTitle = 'Fixture Feed'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title><![CDATA[${channelTitle}]]></title>${items.join('')}</channel></rss>`
}

function payload(xml: string, source: GlobalNewsFeedSource = fixtureSource()): GlobalNewsFeedPayload {
  return { source, xml }
}

function buildOne(
  xml: string,
  options: Partial<GlobalNewsRadarOptions> = {},
  source: GlobalNewsFeedSource = fixtureSource(),
) {
  return buildGlobalNewsRadar([payload(xml, source)], { now: NOW, ...options })
}

function score(overrides: Partial<ScoreNewsItemInput>) {
  return scoreNewsItem({
    authority: 'official',
    eventType: 'other',
    publishedAt: NOW,
    now: NOW,
    ...overrides,
  })
}

const simpleRss = makeRss([
  rssItem({
    title: 'Fed signals possible rate cut and slower inflation',
    link: 'https://fixture.test/fed-rate-cut?utm_source=rss#top',
    guid: 'fixture-guid-1',
    date: 'Tue, 17 Nov 2026 10:00:00 GMT',
    summary: 'FOMC members see cooling prices.',
    extra: '<category>Monetary Policy</category>',
  }),
])

try {
  // 1) RSS 2.0：BOM、CDATA、实体、类别、+0100 时区、链接/摘要清洗。
  await check('RSS 2.0 解析：BOM/CDATA/实体/类别/时区/链接', () => {
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title><![CDATA[Fixture &amp; News]]></title>${rssItem({
      title: 'Fed signals possible rate cut &amp; slower inflation',
      link: 'https://fixture.test/fed-rate-cut?utm_source=rss#frag',
      guid: 'guid-1',
      date: 'Mon, 16 Nov 2026 14:00:00 +0100',
      summary: '<p>FOMC &amp; staff see <b>cooling</b> prices.</p>',
      extra: '<category>Monetary Policy</category>',
    })}</channel></rss>`
    const parsed = parseFeedXml(xml)
    assert.equal(parsed.format, 'rss')
    assert.equal(parsed.title, 'Fixture & News')
    assert.equal(parsed.skipped, 0)
    assert.equal(parsed.items.length, 1)
    const item = parsed.items[0]
    assert.ok(item)
    assert.equal(item.title, 'Fed signals possible rate cut & slower inflation')
    assert.equal(item.link, 'https://fixture.test/fed-rate-cut?utm_source=rss#frag')
    assert.equal(item.guid, 'guid-1')
    assert.equal(item.publishedRaw, 'Mon, 16 Nov 2026 14:00:00 +0100')
    assert.equal(normalizePublishedAt(item.publishedRaw).iso, '2026-11-16T13:00:00.000Z')
    assert.equal(item.summary, 'FOMC & staff see cooling prices.')
    assert.deepEqual(item.categories, ['Monetary Policy'])
  })

  // 2) Atom：自闭合 link href、published/updated、CDATA 标题、GMT 子串不能误判。
  await check('Atom 解析：link href、published 优先、CDATA、ISO 时区', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Fixture</title><updated>2026-11-16T10:00:00Z</updated><entry><title type="html"><![CDATA[Unemployment &amp; payrolls fall]]></title><link rel="alternate" type="text/html" href="https://fixture.test/atom/employment"/><id>tag:fixture.test,2026:1</id><published>2026-11-16T02:30:00+02:00</published><updated>2026-11-16T03:00:00Z</updated><summary type="html"><![CDATA[<p>Jobs report shows hiring cooling.</p>]]></summary></entry></feed>`
    const parsed = parseFeedXml(xml)
    assert.equal(parsed.format, 'atom')
    assert.equal(parsed.title, 'Atom Fixture')
    assert.equal(parsed.items.length, 1)
    const item = parsed.items[0]
    assert.ok(item)
    assert.equal(item.title, 'Unemployment & payrolls fall')
    assert.equal(item.link, 'https://fixture.test/atom/employment')
    assert.equal(item.guid, 'tag:fixture.test,2026:1')
    assert.equal(item.publishedRaw, '2026-11-16T02:30:00+02:00')
    assert.equal(normalizePublishedAt(item.publishedRaw).iso, '2026-11-16T00:30:00.000Z')
    assert.equal(item.summary, 'Jobs report shows hiring cooling.')
  })

  // 3) RSS 1.0/RDF：dc:date、rdf:about item、channel title。
  await check('RDF/RSS 1.0 解析：dc:date 与 rdf:about item', () => {
    const xml = `<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://fixture.test/rdf"><title>RDF Fixture</title><link>https://fixture.test/rdf</link></channel><item rdf:about="https://fixture.test/rdf/1"><title>BIS publishes annual report</title><link>https://fixture.test/rdf/1</link><dc:date>2026-11-10T00:00:00Z</dc:date><description>Central bank governors meet.</description></item></rdf:RDF>`
    const parsed = parseFeedXml(xml)
    assert.equal(parsed.format, 'rdf')
    assert.equal(parsed.title, 'RDF Fixture')
    assert.equal(parsed.items.length, 1)
    assert.equal(parsed.items[0]?.publishedRaw, '2026-11-10T00:00:00Z')
    assert.equal(normalizePublishedAt(parsed.items[0]?.publishedRaw ?? '').iso, '2026-11-10T00:00:00.000Z')
    assert.equal(parsed.items[0]?.title, 'BIS publishes annual report')
  })

  // 4) 非法日期不能被猜成有效；pubDate 非法时退回可解析的 dc:date。
  await check('非法时间保留 invalid；非法 pubDate 回退到可解析日期', () => {
    const invalid = normalizePublishedAt('Fri, 32 Nov 2026 10:00:00 GMT')
    assert.equal(invalid.invalid, true)
    assert.equal(invalid.iso, null)
    assert.equal(invalid.raw, 'Fri, 32 Nov 2026 10:00:00 GMT')
    assert.equal(normalizePublishedAt('not-a-date').iso, null)

    const xml = makeRss([
      rssItem({
        title: 'Fallback date item',
        link: 'https://fixture.test/fallback',
        date: 'Fri, 32 Nov 2026 10:00:00 GMT',
        extra: '<dc:date>2026-11-15T09:00:00Z</dc:date>',
      }),
    ])
    const parsed = parseFeedXml(xml)
    assert.equal(parsed.items[0]?.publishedRaw, '2026-11-15T09:00:00Z')
    assert.equal(normalizePublishedAt(parsed.items[0]?.publishedRaw ?? '').iso, '2026-11-15T09:00:00.000Z')
  })

  // 5) 时间归一化矩阵：显式时区、命名时区、无时区按 UTC、非法时间。
  await check('时间归一化：偏移/命名时区/无时区/非法', () => {
    const cases: { raw: string; iso: string | null; assumedUtc: boolean }[] = [
      { raw: 'Fri, 13 Nov 2026 21:15:00 GMT', iso: '2026-11-13T21:15:00.000Z', assumedUtc: false },
      { raw: 'Fri, 13 Nov 2026 11:57:00 -0500', iso: '2026-11-13T16:57:00.000Z', assumedUtc: false },
      { raw: 'Mon, 16 Nov 2026 10:00:00 EST', iso: '2026-11-16T15:00:00.000Z', assumedUtc: false },
      { raw: '2026-11-16T02:30:00+02:00', iso: '2026-11-16T00:30:00.000Z', assumedUtc: false },
      { raw: '2026-11-16 10:00:00', iso: '2026-11-16T10:00:00.000Z', assumedUtc: true },
      { raw: '2026-11-16', iso: '2026-11-16T00:00:00.000Z', assumedUtc: true },
      { raw: 'Mon, 16 Nov 2026 10:00:00', iso: '2026-11-16T10:00:00.000Z', assumedUtc: true },
      { raw: 'not-a-date', iso: null, assumedUtc: false },
    ]
    for (const testCase of cases) {
      const normalized = normalizePublishedAt(testCase.raw)
      assert.equal(normalized.iso, testCase.iso, testCase.raw)
      assert.equal(normalized.invalid, testCase.iso === null, testCase.raw)
      if (testCase.iso !== null) assert.equal(normalized.assumedUtc, testCase.assumedUtc, testCase.raw)
    }
  })

  // 6) 事件类型关键词规则与命中解释。
  await check('事件分类：8 类关键词 + 命中词 + 同分固定顺序', () => {
    const cases: { text: string; type: string }[] = [
      { text: 'Federal Reserve issues FOMC statement on interest rates', type: 'rate' },
      { text: 'CPI inflation eases as consumer prices rise', type: 'inflation' },
      { text: 'Nonfarm payrolls and unemployment rate', type: 'employment' },
      { text: 'GDP growth slows, PMI signals recession', type: 'growth' },
      { text: 'SEC charges firm over disclosure rules', type: 'regulation' },
      { text: 'Agencies extend comment period for proposed third-party risk management guidance', type: 'regulation' },
      { text: 'New tariffs raise trade war fears before election', type: 'geopolitical' },
      { text: 'Company earnings beat guidance with strong revenue', type: 'earnings' },
      { text: 'Board announces new appointments', type: 'other' },
    ]
    for (const testCase of cases) {
      assert.equal(classifyNewsEvent(testCase.text).type, testCase.type, testCase.text)
    }
    const rate = classifyNewsEvent('Federal Reserve issues FOMC statement on interest rates')
    assert.ok(rate.hits.includes('fomc'))
    assert.match(rate.reason, /命中/)
    const tie = classifyNewsEvent('rate cut inflation')
    assert.equal(tie.type, 'rate')
    assert.match(tie.reason, /同分/)
    assert.equal(classifyNewsEvent('央行降息，利率下调，通胀回落').type, 'rate')
    assert.equal(classifyNewsEvent('美国CPI与通胀数据').type, 'inflation')
  })

  // 7) 空 feed / HTML / 未知根 / 未闭合 / 缺标题。
  await check('空 feed 返回空数组；空串/HTML/未知根/未闭合明确报错', () => {
    const emptyRss = parseFeedXml('<rss version="2.0"><channel><title>Empty</title></channel></rss>')
    assert.equal(emptyRss.format, 'rss')
    assert.deepEqual(emptyRss.items, [])
    assert.ok(emptyRss.warnings.some(warning => warning.includes('空 feed')))
    const emptyAtom = parseFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>')
    assert.deepEqual(emptyAtom.items, [])

    assert.throws(() => parseFeedXml(''), /空 feed/)
    assert.throws(() => parseFeedXml('<!doctype html><html><body>not a feed</body></html>'), /HTML/)
    assert.throws(() => parseFeedXml('<root><item><title>x</title></item></root>'), /无法识别/)
    assert.throws(
      () => parseFeedXml('<rss version="2.0"><channel><title>Broken</title><item><title>Unclosed</title></channel></rss>'),
      /结构不完整/,
    )
    const missingTitle = parseFeedXml(makeRss([
      rssItem({ title: null, link: 'https://fixture.test/no-title', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
    ]))
    assert.equal(missingTitle.items.length, 0)
    assert.equal(missingTitle.skipped, 1)
  })

  // 8) 来源清单：官方/媒体分开，已实测与不可用不混淆。
  await check('来源清单：官方/媒体分开、realChecked 与 enabled 语义一致', () => {
    assert.ok(ENABLED_NEWS_FEEDS.length >= 5)
    assert.ok(ENABLED_NEWS_FEEDS.every(source => source.family === 'official' && source.enabled && source.realChecked))
    assert.ok(OFFICIAL_NEWS_FEEDS.every(source => source.family === 'official' && source.enabled && source.realChecked))
    assert.ok(MEDIA_NEWS_FEEDS.every(source => source.family === 'media' && source.authority === 'media' && !source.enabled))
    assert.ok(UNAVAILABLE_OFFICIAL_FEEDS.every(source => source.family === 'official' && !source.enabled && !source.realChecked))
    assert.equal(new Set(NEWS_FEEDS.map(source => source.id)).size, NEWS_FEEDS.length)
    assert.ok(NEWS_FEEDS.every(source => source.url.startsWith('https://')))
    assert.ok(NEWS_FEEDS.every(source => source.probe.checkedAt === '2026-11-17'))
    assert.deepEqual(getEnabledOfficialNewsFeeds().map(source => source.id), ENABLED_NEWS_FEEDS.map(source => source.id))
    assert.ok(getVerifiedMediaNewsFeeds().some(source => source.id === 'cnbc-top-news'))
    assert.equal(getNewsFeedSource('fed-press-all')?.url, 'https://www.federalreserve.gov/feeds/press_all.xml')
    assert.equal(getNewsFeedSource('does-not-exist'), undefined)

    const cnbc = getNewsFeedSource('cnbc-top-news')
    assert.ok(cnbc)
    assert.equal(cnbc.realChecked, true)
    assert.equal(cnbc.enabled, false)
    assert.match(cnbc.probe.detail, /403/)
  })

  // 9) URL / 标题规范化。
  await check('URL 规范化：utm/fragment/www/重复斜杠；文章 id 不被合并', () => {
    assert.equal(
      canonicalizeNewsUrl('https://www.Example.com/a//b/?utm_source=x&utm_medium=y#frag'),
      'https://example.com/a/b',
    )
    assert.equal(canonicalizeNewsUrl('https://example.com/'), 'https://example.com/')
    assert.equal(canonicalizeNewsUrl(''), null)
    assert.notEqual(
      canonicalizeNewsUrl('https://example.com/a?id=1'),
      canonicalizeNewsUrl('https://example.com/a?id=2'),
    )
    assert.equal(normalizeNewsTitle('  Fed  &  Rates! '), 'fed rates')
    assert.equal(normalizeNewsTitle('  '), '')
  })

  // 10) 去重：标题+分钟、URL；不同分钟的同标题保留。
  await check('去重：标题+同分钟/同 URL，跨分钟同标题保留', () => {
    const xml = makeRss([
      rssItem({ title: 'Shared headline', link: 'https://dedupe.test/story?utm_source=rss#top', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Shared headline', link: 'https://dedupe.test/story-other', date: 'Tue, 17 Nov 2026 10:00:30 GMT' }),
      rssItem({ title: 'Shared headline', link: 'https://dedupe.test/story-later', date: 'Tue, 17 Nov 2026 11:00:00 GMT' }),
      rssItem({ title: 'Different headline', link: 'https://dedupe.test/story#frag', date: 'Tue, 17 Nov 2026 09:00:00 GMT' }),
    ])
    const result = buildOne(xml, { windowHours: null })
    assert.equal(result.items.length, 2)
    assert.equal(result.stats.duplicatesRemoved, 2)
    assert.equal(result.stats.scoredItems, 2)
    assert.ok(result.items.some(item => item.title === 'Shared headline'))
  })

  // 11) 去重优先级：同一稿件优先官方一手源。
  await check('去重优先级：同一标题+时间，保留官方源而非媒体源', () => {
    const official = fixtureSource({ id: 'official-fixture', name: 'Official Fixture' })
    const media = fixtureSource({ id: 'media-fixture', name: 'Media Fixture', authority: 'media', family: 'media', enabled: false })
    const result = buildGlobalNewsRadar([
      payload(makeRss([rssItem({ title: 'Same story', link: 'https://official.test/story', date: 'Tue, 17 Nov 2026 10:00:00 GMT' })]), official),
      payload(makeRss([rssItem({ title: 'Same story', link: 'https://media.test/story', date: 'Tue, 17 Nov 2026 10:00:00 GMT' })]), media),
    ], { now: NOW, windowHours: null })
    assert.equal(result.items.length, 1)
    assert.equal(result.stats.duplicatesRemoved, 1)
    assert.equal(result.items[0]?.sourceId, 'official-fixture')
    assert.equal(result.items[0]?.authority, 'official')
  })

  // 12) 时间窗：旧、未来、非法时间；关闭窗口时全部保留并显式标记。
  await check('时间窗过滤：旧/未来/非法时间；无窗口时保留并标记', () => {
    const xml = makeRss([
      rssItem({ title: 'Recent item', link: 'https://window.test/recent', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Old item', link: 'https://window.test/old', date: 'Mon, 09 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Future item', link: 'https://window.test/future', date: 'Wed, 18 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Invalid date item', link: 'https://window.test/invalid', date: 'not-a-date' }),
    ])
    const windowed = buildOne(xml, { windowHours: 24 })
    assert.equal(windowed.items.length, 1)
    assert.equal(windowed.items[0]?.title, 'Recent item')
    assert.match(windowed.items[0]?.eventReason ?? '', /事件类型/)
    assert.equal(windowed.stats.parsedItems, 4)
    assert.equal(windowed.stats.invalidDates, 1)
    assert.equal(windowed.stats.excludedInvalidDates, 1)
    assert.equal(windowed.stats.excludedOutOfWindow, 1)
    assert.equal(windowed.stats.excludedFutureDated, 1)

    const open = buildOne(xml, { windowHours: null })
    assert.equal(open.items.length, 4)
    const invalid = open.items.find(item => item.title === 'Invalid date item')
    assert.ok(invalid)
    assert.equal(invalid.publishedAt, null)
    assert.equal(invalid.dateInvalid, true)
    assert.equal(invalid.score.components.recency, 0)
    const future = open.items.find(item => item.title === 'Future item')
    assert.ok(future)
    assert.equal(future.score.components.recency, 0)
    assert.ok(future.score.reasons.some(reason => reason.includes('晚于参考时间')))

    const defaultWindow = buildOne(xml)
    assert.equal(defaultWindow.windowHours, 168)
    assert.equal(defaultWindow.items.length, 1)
    assert.equal(defaultWindow.items[0]?.title, 'Recent item')
  })

  // 13) 评分分项：权威、事件、时间衰减、行情缺失、相关性。
  await check('确定性评分：权威/事件/时间衰减/缺失行情/相关性', () => {
    const official = score({})
    const media = score({ authority: 'media' })
    assert.ok(official.total > media.total)

    const rate = score({ eventType: 'rate' })
    const other = score({ eventType: 'other' })
    assert.ok(rate.total > other.total)

    const fresh = score({ publishedAt: NOW })
    const old = score({ publishedAt: '2026-11-15T12:00:00Z' })
    assert.ok(fresh.total > old.total)
    assert.equal(score({ publishedAt: '2026-11-16T00:00:00Z' }).components.recency, 12.5)
    // 无时区字符串也按 UTC 解释，结果不随本机 TZ 变化。
    assert.equal(score({ publishedAt: '2026-11-16 12:00:00' }).components.recency, 15.75)

    const noQuotes = score({})
    assert.equal(noQuotes.components.reaction, 0)
    assert.ok(noQuotes.reasons.some(reason => reason.includes('未注入行情')))
    const missingQuotes = score({ quotes: [{ symbol: 'SPY', changePct: null }] })
    assert.equal(missingQuotes.components.reaction, 0)
    assert.ok(missingQuotes.reasons.some(reason => reason.includes('均缺有效涨跌幅')))
    const smallMove = score({ quotes: [{ symbol: 'SPY', changePct: 2 }, { symbol: 'TLT', changePct: -1 }] })
    assert.equal(smallMove.components.reaction, 3.75)
    const cappedMove = score({ quotes: [{ symbol: 'SPY', changePct: 10 }, { symbol: 'TLT', changePct: -10 }] })
    assert.equal(cappedMove.components.reaction, 15)

    const relevant = score({ relevance: { keywords: ['NVIDIA', 'Fed', '半导体'] }, relevanceText: 'NVIDIA and Fed' })
    assert.equal(relevant.components.relevance, 5)
    assert.ok(relevant.reasons.some(reason => reason.includes('NVIDIA')))
    const noKeyword = score({})
    assert.equal(noKeyword.components.relevance, 0)
    const noMatch = score({ relevance: { keywords: ['NVIDIA'] }, relevanceText: 'unrelated' })
    assert.equal(noMatch.components.relevance, 0)
    assert.ok(noMatch.reasons.some(reason => reason.includes('均未命中')))

    const maxed = score({
      authority: 'central-bank',
      eventType: 'rate',
      eventHits: ['fomc'],
      quotes: [{ symbol: 'SPY', changePct: 10 }],
      relevance: { keywords: ['Fed', 'FOMC', 'rates', 'statement'], label: '持仓' },
      relevanceText: 'Fed FOMC rates statement',
    })
    assert.equal(maxed.total, 100)
    assert.equal(
      maxed.components.authority + maxed.components.event + maxed.components.firstHand +
        maxed.components.recency + maxed.components.reaction + maxed.components.relevance,
      maxed.total,
    )
    const reasons = maxed.reasons.join('\n')
    for (const label of ['来源等级', '事件类型', '时间衰减', '跨资产反应', '相关性']) {
      assert.ok(reasons.includes(label), label)
    }
    assert.ok(maxed.reasons.every(reason => !reason.includes('全市场最重要')))
    assert.match(RADAR_DISCLAIMER, /不表示因果/)
    assert.match(RADAR_DISCLAIMER, /全市场最重要/)
    assert.equal(
      RADAR_SCORE_MODEL.authorityMax + RADAR_SCORE_MODEL.eventMax + RADAR_SCORE_MODEL.firstHandMax +
        RADAR_SCORE_MODEL.recencyMax + RADAR_SCORE_MODEL.reactionMax + RADAR_SCORE_MODEL.relevanceMax,
      100,
    )
  })

  // 14) 排序确定性：反转输入顺序仍得到相同顺序；分数非递增。
  await check('稳定排序：反转输入顺序结果一致、总分非递增', () => {
    const entries = [
      rssItem({ title: 'Newer item', link: 'https://sort.test/newer', date: 'Tue, 17 Nov 2026 11:00:00 GMT' }),
      rssItem({ title: 'Tie A', link: 'https://sort.test/tie-a', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Tie B', link: 'https://sort.test/tie-b', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Older item', link: 'https://sort.test/older', date: 'Tue, 17 Nov 2026 09:00:00 GMT' }),
    ]
    const forward = buildOne(makeRss(entries), { windowHours: null })
    const reverse = buildOne(makeRss([...entries].reverse()), { windowHours: null })
    assert.deepEqual(forward.items.map(item => item.id), reverse.items.map(item => item.id))
    assert.equal(forward.items[0]?.title, 'Newer item')
    for (let index = 1; index < forward.items.length; index++) {
      assert.ok(forward.items[index - 1]!.score.total >= forward.items[index]!.score.total)
    }
  })

  // 15) 媒体与官方分开输出；同条件下官方分更高。
  await check('输出分组：official/media 分开，官方同条件得分更高', () => {
    const official = fixtureSource({ id: 'official-group', name: 'Official Group' })
    const media = MEDIA_NEWS_FEEDS.find(source => source.id === 'cnbc-top-news')
    assert.ok(media)
    const result = buildGlobalNewsRadar([
      payload(makeRss([rssItem({ title: 'Official market update', link: 'https://group.test/official', date: 'Tue, 17 Nov 2026 10:00:00 GMT' })]), official),
      payload(makeRss([rssItem({ title: 'Media market update', link: 'https://group.test/media', date: 'Tue, 17 Nov 2026 10:00:00 GMT' })]), media),
    ], { now: NOW, windowHours: null })
    assert.equal(result.items.length, 2)
    assert.equal(result.groups.official.length, 1)
    assert.equal(result.groups.media.length, 1)
    assert.equal(result.groups.media[0]?.authority, 'media')
    assert.ok(result.groups.official[0]!.score.total > result.groups.media[0]!.score.total)
  })

  // 16) 抓取层用注入 fetch：成功/HTTP 错误/HTML/中止，均不联网。
  await check('抓取层（注入 fetch）：成功/HTTP 错误/非 feed/超时诊断', async () => {
    const source = fixtureSource()
    const okFetch: typeof fetch = async () => new Response(simpleRss, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    })
    const ok = await fetchNewsFeed(source, { fetchImpl: okFetch, fetchedAt: NOW })
    assert.equal(ok.status, 'ok')
    assert.equal(ok.ok, true)
    assert.equal(ok.itemCount, 1)
    assert.equal(ok.feedFormat, 'rss')

    const http = await fetchNewsFeed(source, {
      fetchImpl: async () => new Response('denied', { status: 403 }),
      fetchedAt: NOW,
    })
    assert.equal(http.status, 'http-error')
    assert.equal(http.ok, false)
    assert.equal(http.httpStatus, 403)

    const html = await fetchNewsFeed(source, {
      fetchImpl: async () => new Response('<!doctype html><html><body>blocked</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      fetchedAt: NOW,
    })
    assert.equal(html.status, 'parse-error')
    assert.equal(html.ok, false)
    assert.match(html.error ?? '', /HTML/)

    const timeout = await fetchNewsFeed(source, {
      fetchImpl: async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      },
      fetchedAt: NOW,
    })
    assert.equal(timeout.status, 'timeout')
    assert.equal(timeout.ok, false)
  })

  // 17) 抓取 → 构建的集成路径（仍用注入 fetch）。
  await check('fetchAndBuild：抓取结果进入评分，失败不伪造条目', async () => {
    const source = fixtureSource({ id: 'fetch-build-fixture' })
    const run = await fetchAndBuildGlobalNewsRadar({
      now: NOW,
      windowHours: 24,
      sources: [source],
      fetchOptions: {
        fetchImpl: async () => new Response(simpleRss, { status: 200 }),
        fetchedAt: NOW,
      },
    })
    assert.equal(run.fetches.length, 1)
    assert.equal(run.fetches[0]?.status, 'ok')
    assert.equal(run.radar.items.length, 1)
    assert.equal(run.radar.items[0]?.sourceId, 'fetch-build-fixture')
  })

  // 18) 构建容错：空 feed + HTML 坏源 + 正常源，坏源只进诊断。
  await check('构建容错：坏 feed 不拖垮其它源，诊断保留错误', () => {
    const good = makeRss([rssItem({ title: 'Good item', link: 'https://build.test/good', date: 'Tue, 17 Nov 2026 10:00:00 GMT' })])
    const empty = '<rss version="2.0"><channel><title>Empty</title></channel></rss>'
    const result = buildGlobalNewsRadar([
      payload(good, fixtureSource({ id: 'good-source' })),
      payload(empty, fixtureSource({ id: 'empty-source' })),
      payload('<!doctype html><html><body>no</body></html>', fixtureSource({ id: 'bad-source' })),
    ], { now: NOW, windowHours: null })
    assert.equal(result.stats.feeds, 3)
    assert.equal(result.stats.feedsFailed, 1)
    assert.equal(result.items.length, 1)
    assert.equal(result.feedDiagnostics.length, 3)
    const bad = result.feedDiagnostics.find(diagnostic => diagnostic.sourceId === 'bad-source')
    assert.ok(bad)
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /HTML/)
  })

  // 19) 截断/最低分/空输入与非法参数。
  await check('maxItems/minScore/空输入/非法参数', () => {
    const xml = makeRss([
      rssItem({ title: 'One', link: 'https://limit.test/1', date: 'Tue, 17 Nov 2026 11:00:00 GMT' }),
      rssItem({ title: 'Two', link: 'https://limit.test/2', date: 'Tue, 17 Nov 2026 10:00:00 GMT' }),
      rssItem({ title: 'Three', link: 'https://limit.test/3', date: 'Tue, 17 Nov 2026 09:00:00 GMT' }),
    ])
    const limited = buildOne(xml, { windowHours: null, maxItems: 1 })
    assert.equal(limited.items.length, 1)
    assert.ok(limited.stats.truncatedItems > 0)
    const zero = buildOne(xml, { windowHours: null, maxItems: 0 })
    assert.equal(zero.items.length, 0)
    assert.equal(zero.stats.truncatedItems, zero.stats.scoredItems)
    const nonePass = buildOne(xml, { windowHours: null, minScore: 101 })
    assert.equal(nonePass.items.length, 0)
    assert.equal(nonePass.stats.excludedBelowMinScore, nonePass.stats.scoredItems)

    const empty = buildGlobalNewsRadar([], { now: NOW })
    assert.equal(empty.items.length, 0)
    assert.equal(empty.stats.feeds, 0)
    assert.equal(empty.stats.returnedItems, 0)
    assert.match(empty.disclaimer, /阅读顺序/)

    assert.throws(() => buildGlobalNewsRadar([], { now: 'not-a-date' }), /now/)
    assert.throws(() => buildGlobalNewsRadar([], { now: NOW, windowHours: 0 }), /windowHours/)
    assert.throws(() => buildGlobalNewsRadar([], { now: NOW, halfLifeHours: 0 }), /halfLifeHours/)
    assert.throws(() => buildGlobalNewsRadar([], { now: NOW, maxItems: -1 }), /maxItems/)
  })

  // 静态接线：工具与 HTTP 路由都调用同一个抓取/评分模块，不另写一套“假雷达”。
  const register = readFileSync(new URL('../src/tools/register.ts', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../src/server-routes.ts', import.meta.url), 'utf8')
  assert.match(register, /name: 'get_global_news_radar'/)
  assert.match(register, /fetchAndBuildGlobalNewsRadar\(/)
  assert.match(routes, /sub === '\/news\/radar'/)
  assert.match(routes, /fetchAndBuildGlobalNewsRadar\(/)
  checks++
  console.log('PASS static: 工具与 /news/radar 共用同一官方源抓取与评分模块')

  console.log(`\n${checks} global news radar checks passed`)
} catch (error) {
  console.error('\nFAIL global news radar checks')
  console.error(error)
  process.exit(1)
}
