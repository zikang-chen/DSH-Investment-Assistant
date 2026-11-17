/**
 * Official policy source allowlist.
 *
 * Every entry was reachability-checked from the development machine on
 * 2026-11-16 (HTTP 200). `enabled` reflects whether the index page is
 * server-rendered enough to discover document links without a headless browser:
 * disabled entries stay importable by hand (`policy_import <url>`) instead of
 * being silently scraped.
 *
 * Nothing here bypasses access control: no login, captcha, paywall or
 * anti-bot circumvention. Sites whose terms are unclear ship disabled.
 */
import type { PolicySource } from './types.js'

const NBS_NOTE = '国家统计局数据发布；2026-11-16 实测 rss.xml 返回完整条目（含 pubDate），优先走官方 feed。'

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
]

/** The allowlist that actually governs every fetch: union of enabled sources' hosts. */
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
