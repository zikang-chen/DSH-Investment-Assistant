/**
 * Official policy source allowlist.
 *
 * Domestic entries were reachability-checked from the development machine on
 * 2026-11-16 (HTTP 200). `enabled` reflects whether the index page is
 * server-rendered enough to discover document links without a headless browser:
 * disabled entries stay importable by hand (`policy_import <url>`) instead of
 * being silently scraped.
 *
 * The international entries added 2026-11-17 are deliberately different: they
 * were NOT reachability-checked (no network probe was run), ship as
 * `kind:'manual'` + `enabled:false` so nothing is auto-crawled, and only widen
 * `decisionHosts` so an operator can import one specific page they opened in a
 * browser. Their notes say this explicitly; do not read them as verified feeds
 * or working scrapers.
 *
 * Nothing here bypasses access control: no login, captcha, paywall or
 * anti-bot circumvention. Sites whose terms are unclear ship disabled.
 */
import type { PolicySource } from './types.js'

const NBS_NOTE = '国家统计局数据发布；2026-11-16 实测 rss.xml 返回完整条目（含 pubDate），优先走官方 feed。'

/**
 * Shared caveat for the international entries.
 *
 * They are manual-only on purpose: this machine never probed them, and official
 * sites commonly render lists with scripts, answer non-browser clients with
 * 403, or disallow crawling in robots.txt. The note must stay honest about that.
 */
const INTL_NOTE = (detail: string): string =>
  `${detail} 该国际站点未在本机线上核实可达，也未验证 feed/列表结构；可能存在脚本渲染、403 或 robots 限制，因此默认关闭、不自动抓取。请在浏览器打开具体页面后用 policy_import(url) 手工导入，仍受站点可达性、robots.txt 与允许清单限制。`

export const DEFAULT_POLICY_SOURCES: PolicySource[] = [
  {
    id: 'stats-releases',
    label: '国家统计局 · 数据发布（官方 RSS）',
    hosts: ['www.stats.gov.cn', 'stats.gov.cn'],
    sourceClass: 'official',
    issuer: '国家统计局',
    // 2026-11-16 实测：rss.xml 返回完整条目（含 pubDate/pubTime），比抓列表页稳定得多。
    kind: 'rss',
    url: 'https://www.stats.gov.cn/sj/zxfb/rss.xml',
    docType: 'statistics',
    enabled: true,
    minIntervalSec: 3,
    note: NBS_NOTE,
  },
  {
    id: 'gov-cn-policy',
    label: '中国政府网 · 最新政策',
    hosts: ['www.gov.cn', 'gov.cn'],
    sourceClass: 'official',
    issuer: '国务院',
    // 实测：政策列表由脚本异步加载，HTML 里只有页脚链接；静态抓取拿不到条目。
    kind: 'manual',
    url: 'https://www.gov.cn/zhengce/zuixin/',
    docType: 'state-council-doc',
    enabled: false,
    minIntervalSec: 5,
    note: '列表由脚本渲染（HTML 中无政策链接）。请在浏览器打开该页，复制具体政策链接用 policy_import 导入；若有官方 feed 可在 policy.sources 里配 kind: rss。',
  },
  {
    id: 'ndrc-policy',
    label: '国家发展改革委 · 政策发布',
    hosts: ['www.ndrc.gov.cn', 'ndrc.gov.cn'],
    sourceClass: 'official',
    issuer: '国家发展改革委',
    kind: 'manual',
    url: 'https://www.ndrc.gov.cn/xxgk/zcfb/',
    docType: 'ministry-doc',
    enabled: false,
    minIntervalSec: 5,
    note: '站点的 rss.xml 存在但为空（仅 channel 无 item），列表页由脚本渲染；改用 policy_import 导入链接。',
  },
  {
    id: 'miit-policy',
    label: '工业和信息化部 · 政策文件',
    hosts: ['www.miit.gov.cn', 'miit.gov.cn'],
    sourceClass: 'official',
    issuer: '工业和信息化部',
    kind: 'manual',
    url: 'https://www.miit.gov.cn/zwgk/zcwj/index.html',
    docType: 'industry-plan',
    enabled: false,
    minIntervalSec: 5,
    note: '返回的是脚本外壳（约 2KB），没有可解析的条目列表；改用 policy_import。',
  },
  {
    id: 'sse-rules',
    label: '上海证券交易所 · 业务规则',
    hosts: ['www.sse.com.cn', 'sse.com.cn'],
    sourceClass: 'exchange',
    issuer: '上海证券交易所',
    kind: 'manual',
    url: 'https://www.sse.com.cn/lawandrules/sselawsrules/',
    docType: 'regulation',
    enabled: false,
    minIntervalSec: 5,
    note: '规则列表由脚本加载；静态页面只有导航。改用 policy_import 导入具体规则链接。',
  },
  {
    id: 'szse-rules',
    label: '深圳证券交易所 · 业务规则',
    hosts: ['www.szse.cn', 'szse.cn'],
    sourceClass: 'exchange',
    issuer: '深圳证券交易所',
    kind: 'manual',
    url: 'https://www.szse.cn/lawrules/rule/',
    docType: 'regulation',
    enabled: false,
    minIntervalSec: 5,
    note: '静态页面只有子目录入口，条目由脚本渲染；改用 policy_import。',
  },
  {
    id: 'pbc',
    label: '中国人民银行',
    hosts: ['www.pbc.gov.cn', 'pbc.gov.cn'],
    sourceClass: 'official',
    issuer: '中国人民银行',
    kind: 'manual',
    url: 'https://www.pbc.gov.cn/',
    docType: 'monetary-report',
    enabled: false,
    minIntervalSec: 5,
    note: '栏目层级较深且大量页面依赖脚本渲染；默认关闭，用 policy_import 手工导入具体链接。',
  },
  {
    id: 'mof',
    label: '财政部',
    hosts: ['www.mof.gov.cn', 'mof.gov.cn'],
    sourceClass: 'official',
    issuer: '财政部',
    kind: 'manual',
    url: 'http://www.mof.gov.cn/index.htm',
    docType: 'fiscal-report',
    enabled: false,
    minIntervalSec: 5,
    note: '首页可用但栏目多在 iframe/脚本中；默认关闭，避免把导航链接当成政策。',
  },
  {
    id: 'mofcom',
    label: '商务部',
    hosts: ['www.mofcom.gov.cn', 'mofcom.gov.cn'],
    sourceClass: 'official',
    issuer: '商务部',
    kind: 'manual',
    url: 'http://www.mofcom.gov.cn/',
    docType: 'ministry-doc',
    enabled: false,
    minIntervalSec: 5,
    note: '栏目结构变动频繁；默认关闭，手工导入更稳。',
  },
  {
    id: 'csrc',
    label: '中国证监会',
    hosts: ['www.csrc.gov.cn', 'csrc.gov.cn'],
    sourceClass: 'official',
    issuer: '中国证监会',
    kind: 'manual',
    url: 'https://www.csrc.gov.cn/',
    docType: 'regulation',
    enabled: false,
    minIntervalSec: 5,
    note: '页面为脚本渲染，静态抓取拿不到列表；默认关闭，手工导入链接。',
  },
  {
    id: 'cninfo',
    label: '巨潮资讯网 · 上市公司公告',
    hosts: ['www.cninfo.com.cn', 'cninfo.com.cn'],
    sourceClass: 'exchange',
    issuer: '巨潮资讯',
    kind: 'manual',
    url: 'http://www.cninfo.com.cn/new/index',
    docType: 'listed-filing',
    enabled: false,
    minIntervalSec: 5,
    note: '公告检索依赖 POST 接口与动态参数；P0 不实现，公告类暂用手工导入。',
  },

  // ------------------------------------------------------------ international
  // 2026-11-17 新增：国际官方来源，用于全球政策/数据研究。全部 kind:'manual'
  // 且 enabled:false——没有联网核实这些域名，自动采集也不可靠（脚本渲染/403/
  // robots）。这些 hosts 会并入 decisionHosts，因此手工 policy_import(url)
  // 具体页面可用；允许清单只放行主机，不代表任意页面都可抓取或已验证 feed。
  {
    id: 'fed',
    label: '美联储（Federal Reserve Board）· 货币政策与讲话',
    hosts: ['www.federalreserve.gov', 'federalreserve.gov'],
    sourceClass: 'official',
    issuer: '美国联邦储备委员会（Federal Reserve Board）',
    kind: 'manual',
    url: 'https://www.federalreserve.gov/monetarypolicy.htm',
    docType: 'monetary-report',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('入口指向 FOMC 声明、会议纪要、货币政策报告与主席讲话；入口 URL 仅作提示，具体文档请从页面复制链接导入。'),
  },
  {
    id: 'ecb',
    label: '欧洲中央银行（ECB）· 货币政策决议与报告',
    hosts: ['www.ecb.europa.eu', 'ecb.europa.eu'],
    sourceClass: 'official',
    issuer: '欧洲中央银行（European Central Bank）',
    kind: 'manual',
    url: 'https://www.ecb.europa.eu/press/html/index.en.html',
    docType: 'monetary-report',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('入口指向货币政策决议、会议纪要（accounts）、经济公报与讲话；具体文档请从页面复制链接导入。'),
  },
  {
    id: 'bls',
    label: '美国劳工统计局（BLS）· 就业与物价数据发布',
    hosts: ['www.bls.gov', 'bls.gov'],
    sourceClass: 'official',
    issuer: '美国劳工统计局（U.S. Bureau of Labor Statistics）',
    kind: 'manual',
    url: 'https://www.bls.gov/news.release/',
    docType: 'statistics',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('CPI、PPI、就业形势（Employment Situation）等数据发布与新闻稿；发布页通常能定位到当月文件。'),
  },
  {
    id: 'bea',
    label: '美国经济分析局（BEA）· 国民经济核算数据',
    hosts: ['www.bea.gov', 'bea.gov'],
    sourceClass: 'official',
    issuer: '美国经济分析局（U.S. Bureau of Economic Analysis）',
    kind: 'manual',
    url: 'https://www.bea.gov/data',
    docType: 'statistics',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('GDP、个人收入与支出、PCE 物价指数等国民经济核算发布；数据页与新闻稿按发布日组织。'),
  },
  {
    id: 'imf',
    label: '国际货币基金组织（IMF）· 世界经济展望与国别报告',
    hosts: ['www.imf.org', 'imf.org'],
    sourceClass: 'official',
    issuer: '国际货币基金组织（International Monetary Fund）',
    kind: 'manual',
    url: 'https://www.imf.org/en/Publications',
    docType: 'other',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('《世界经济展望》《全球金融稳定报告》、Article IV 国别磋商与工作论文；体裁横跨报告/表态，默认 docType=other，导入时请按实际文件覆盖。'),
  },
  {
    id: 'world-bank',
    label: '世界银行（World Bank）· 发展报告与国别研究',
    hosts: ['www.worldbank.org', 'worldbank.org'],
    sourceClass: 'official',
    issuer: '世界银行集团（World Bank Group）',
    kind: 'manual',
    url: 'https://www.worldbank.org/en/research',
    docType: 'other',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('《世界发展报告》、国别经济备忘录（CEM）与发展数据出版物；默认 docType=other，导入时请按实际文件覆盖。'),
  },
  {
    id: 'oecd',
    label: '经济合作与发展组织（OECD）· 经济展望与政策研究',
    hosts: ['www.oecd.org', 'oecd.org'],
    sourceClass: 'official',
    issuer: '经济合作与发展组织（OECD）',
    kind: 'manual',
    url: 'https://www.oecd.org/',
    docType: 'other',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('《经济展望》、Going for Growth、国别经济调查与政策工作论文；默认 docType=other，导入时请按实际文件覆盖。'),
  },
  {
    id: 'eurostat',
    label: '欧盟统计局（Eurostat）· 欧盟统计数据',
    hosts: ['ec.europa.eu'],
    sourceClass: 'official',
    issuer: '欧盟统计局（Eurostat）',
    kind: 'manual',
    url: 'https://ec.europa.eu/eurostat',
    docType: 'statistics',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('HICP、失业率、GDP 等欧盟统计口径数据与统计说明。注意 ec.europa.eu 同时承载欧盟委员会其他页面：允许清单只放行主机，不代表任意页面都可抓取。'),
  },
  {
    id: 'bis',
    label: '国际清算银行（BIS）· 央行研究与统计',
    hosts: ['www.bis.org', 'bis.org'],
    sourceClass: 'official',
    issuer: '国际清算银行（Bank for International Settlements）',
    kind: 'manual',
    url: 'https://www.bis.org/',
    docType: 'other',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('年度/季度报告、央行统计与工作论文；默认 docType=other，导入时请按实际文件覆盖。'),
  },
  {
    id: 'us-treasury',
    label: '美国财政部（U.S. Treasury）· 财政、债务与制裁信息',
    hosts: ['home.treasury.gov', 'treasury.gov'],
    sourceClass: 'official',
    issuer: '美国财政部（U.S. Department of the Treasury）',
    kind: 'manual',
    url: 'https://home.treasury.gov/',
    docType: 'fiscal-report',
    enabled: false,
    minIntervalSec: 5,
    note: INTL_NOTE('财政与债务数据、政策新闻稿、OFAC 制裁行动公告；制裁类文件导入时请把 docType 改为 other。'),
  },
]

/**
 * The allowlist that actually governs every fetch: union of ALL sources' hosts
 * (enabled or not), so a disabled / manual-only source can still be imported by
 * handing `policy_import` one specific URL. Enabling a source does not widen this
 * list by itself, and robots.txt is still enforced per fetch.
 */
export function decisionHosts(sources: PolicySource[]): string[] {
  const hosts = new Set<string>()
  for (const s of sources) for (const h of s.hosts) hosts.add(h)
  return [...hosts]
}

export function findSource(sources: PolicySource[], id: string): PolicySource | undefined {
  return sources.find((s) => s.id === id)
}

/** Merge user config over the shipped defaults, keyed by id. */
export function mergeSources(defaults: PolicySource[], overrides: Array<Partial<PolicySource> & { id: string }>): PolicySource[] {
  const byId = new Map(defaults.map((s) => [s.id, { ...s }]))
  for (const override of overrides) {
    const base = byId.get(override.id)
    byId.set(override.id, base ? { ...base, ...override } : { ...(override as PolicySource) })
  }
  return [...byId.values()]
}
