/**
 * 政策库国际官方允许清单测试（task-10）。
 *
 * 纯静态、离线、确定性：只读 src/policy/sources.ts 的清单与纯函数，不抓取任何
 * 站点、不写文件、不读私有数据。覆盖：
 *   - 国际官方来源齐备且一律 kind:'manual' + enabled:false（不自动采集）；
 *   - 国际 hosts 全部并入 decisionHosts（手工 policy_import 的前提）；
 *   - 原有必需国内 host / 来源 / 唯一 enabled 源不被挤掉；
 *   - mergeSources 按 id 覆盖、可追加、同 id 多次覆盖不重复；
 *   - 允许清单精确匹配主机，拒绝相似钓鱼域。
 *
 *   npx tsx scripts/test_policy_intl_sources.ts
 */
import assert from 'node:assert/strict'
import { discoverFromSource, type CollectDeps } from '../src/policy/collect.js'
import { hostAllowed } from '../src/policy/fetch.js'
import { DEFAULT_POLICY_SOURCES, decisionHosts, findSource, mergeSources } from '../src/policy/sources.js'
import { POLICY_DOC_TYPES } from '../src/policy/types.js'

/** 任务点名的国际官方来源 id；缺任何一条都视为未完成。 */
const REQUIRED_INTL_IDS = [
  'fed',
  'ecb',
  'bls',
  'bea',
  'imf',
  'world-bank',
  'oecd',
  'eurostat',
] as const

/** 额外补充的国际官方来源（“等”）：同样必须 manual + 默认关闭。 */
const EXTRA_INTL_IDS = ['bis', 'us-treasury'] as const

const INTL_IDS: readonly string[] = [...REQUIRED_INTL_IDS, ...EXTRA_INTL_IDS]

/** 点名机构必须覆盖的真实官方主机（含 www 与 apex 两种常见写法）。 */
const REQUIRED_INTL_HOSTS = [
  'www.federalreserve.gov',
  'federalreserve.gov',
  'www.ecb.europa.eu',
  'ecb.europa.eu',
  'www.bls.gov',
  'bls.gov',
  'www.bea.gov',
  'bea.gov',
  'www.imf.org',
  'imf.org',
  'www.worldbank.org',
  'worldbank.org',
  'www.oecd.org',
  'oecd.org',
  'ec.europa.eu',
] as const

/** 原有国内来源 id：新增国际条目不得把任何一条挤掉。 */
const DOMESTIC_IDS = [
  'stats-releases',
  'gov-cn-policy',
  'ndrc-policy',
  'miit-policy',
  'sse-rules',
  'szse-rules',
  'pbc',
  'mof',
  'mofcom',
  'csrc',
  'cninfo',
] as const

/** 原有必需国内主机：手工导入与既有行为依赖它们仍在允许清单。 */
const DOMESTIC_HOSTS = [
  'www.stats.gov.cn',
  'stats.gov.cn',
  'www.gov.cn',
  'gov.cn',
  'www.ndrc.gov.cn',
  'ndrc.gov.cn',
  'www.miit.gov.cn',
  'miit.gov.cn',
  'www.sse.com.cn',
  'sse.com.cn',
  'www.szse.cn',
  'szse.cn',
  'www.pbc.gov.cn',
  'pbc.gov.cn',
  'www.mof.gov.cn',
  'mof.gov.cn',
  'www.mofcom.gov.cn',
  'mofcom.gov.cn',
  'www.csrc.gov.cn',
  'csrc.gov.cn',
  'www.cninfo.com.cn',
  'cninfo.com.cn',
] as const

const defaults = DEFAULT_POLICY_SOURCES
const hosts = decisionHosts(defaults)
const intlSources = INTL_IDS.map((id) => {
  const source = findSource(defaults, id)
  assert.ok(source, `缺少国际来源 ${id}`)
  return source
})

let passed = 0
const failed: string[] = []

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${String(passed).padStart(2, ' ')}. ${name}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failed.push(`${name} — ${message}`)
    console.log(`FAIL    . ${name} — ${message}`)
  }
}

console.log('== 清单结构与默认行为 ==')
await check('默认清单 id 唯一（重复 id 防护）', () => {
  const ids = defaults.map((s) => s.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.equal(new Set(ids).size, ids.length, `存在重复 id：${[...new Set(dupes)].join(', ')}`)
  assert.ok(ids.length >= DOMESTIC_IDS.length + INTL_IDS.length, `条目数异常：${ids.length}`)
})

await check('点名的国际官方来源齐备，且全部 kind:manual / enabled:false / official', () => {
  for (const source of intlSources) {
    assert.equal(source.kind, 'manual', `${source.id} 不得作为自动采集源`)
    assert.equal(source.enabled, false, `${source.id} 默认必须关闭`)
    assert.equal(source.sourceClass, 'official', `${source.id} 必须是官方来源`)
    assert.ok(source.label.trim().length > 0, `${source.id} 缺少 label`)
    assert.ok(source.issuer.trim().length > 0, `${source.id} 缺少 issuer`)
    assert.ok(source.hosts.length > 0, `${source.id} 缺少 hosts`)
    assert.ok(source.minIntervalSec > 0, `${source.id} 抓取间隔必须为正`)
    const docType = source.docType
    assert.ok(docType, `${source.id} 缺少 docType`)
    assert.ok((POLICY_DOC_TYPES as readonly string[]).includes(docType), `${source.id} docType 非法：${docType}`)
  }
})

await check('国际 hosts 全部并入 decisionHosts，点名域名一个不少', () => {
  for (const host of REQUIRED_INTL_HOSTS) {
    assert.ok(hosts.includes(host), `decisionHosts 缺少 ${host}`)
  }
  for (const source of intlSources) {
    for (const host of source.hosts) {
      assert.ok(hosts.includes(host), `decisionHosts 缺少 ${source.id} 的 ${host}`)
    }
  }
  assert.equal(new Set(hosts).size, hosts.length, 'decisionHosts 不应包含重复主机')
})

await check('hosts 只存裸主机名（无协议/路径/端口/大小写混用）', () => {
  for (const source of defaults) {
    for (const host of source.hosts) {
      assert.equal(host, host.trim().toLowerCase(), `${source.id} 主机未规范化：${host}`)
      assert.ok(!/[:/?#\s]/.test(host), `${source.id} 主机含非法字符：${host}`)
    }
    assert.equal(new Set(source.hosts).size, source.hosts.length, `${source.id} 内部 hosts 重复`)
  }
})

await check('原有必需国内来源与 host 仍在，唯一 enabled 源仍为国家统计局 RSS', () => {
  for (const id of DOMESTIC_IDS) {
    assert.ok(findSource(defaults, id), `缺少国内来源 ${id}`)
  }
  for (const host of DOMESTIC_HOSTS) {
    assert.ok(hosts.includes(host), `decisionHosts 缺少国内 host ${host}`)
  }
  const nbs = findSource(defaults, 'stats-releases')
  assert.ok(nbs)
  assert.equal(nbs.enabled, true)
  assert.equal(nbs.kind, 'rss')
  assert.match(nbs.url ?? '', /^https:\/\/www\.stats\.gov\.cn\//)

  const enabled = defaults.filter((s) => s.enabled)
  assert.deepEqual(enabled.map((s) => s.id), ['stats-releases'], '默认启用的源不应因新增国际条目而变化')
  for (const source of enabled) {
    assert.notEqual(source.kind, 'manual', `${source.id} 是 manual 却被默认启用（不会产生自动采集）`)
  }
})

await check('国际条目 note 写明手工导入、未线上核实与可达性限制', () => {
  for (const source of intlSources) {
    const note = source.note ?? ''
    assert.ok(note.includes('policy_import(url)'), `${source.id} note 未说明手工导入方式`)
    assert.ok(note.includes('未在本机线上核实'), `${source.id} note 未标注未线上核实`)
    assert.ok(note.includes('robots'), `${source.id} note 未提 robots 限制`)
    assert.ok(note.includes('允许清单'), `${source.id} note 未提允许清单限制`)
    assert.ok(note.includes('默认关闭'), `${source.id} note 未说明默认关闭`)
    assert.ok(!/已实测|已验证可达|feed 可用/.test(note), `${source.id} note 不得声称已验证 feed/可达`)
  }
})

console.log('== 手工导入 / 允许清单 ==')
await check('disabled 的国际源 host 仍可手工导入：hostAllowed 放行具体页面', () => {
  assert.equal(hostAllowed('https://www.federalreserve.gov/newsevents/pressreleases/monetary20261117a.htm', hosts), true)
  assert.equal(hostAllowed('https://federalreserve.gov/monetarypolicy.htm', hosts), true)
  assert.equal(hostAllowed('https://www.ecb.europa.eu/press/pr/date/2026/html/index.en.html', hosts), true)
  assert.equal(hostAllowed('https://ec.europa.eu/eurostat/web/products-datasets', hosts), true)
  assert.equal(hostAllowed('https://www.imf.org/en/Publications/WEO', hosts), true)
})

await check('允许清单精确匹配主机：相似钓鱼域与非法协议被拒绝', () => {
  assert.equal(hostAllowed('https://federalreserve.gov.evil.example/x', hosts), false)
  assert.equal(hostAllowed('https://www.fed-federalreserve.gov/x', hosts), false)
  assert.equal(hostAllowed('https://www.bls.gov.attacker.test/news', hosts), false)
  assert.equal(hostAllowed('javascript:alert(1)', hosts), false)
  assert.equal(hostAllowed('ftp://www.imf.org/x', hosts), false)
})

await check('manual 源即使被误开也不会自动发现条目（只走 policy_import）', async () => {
  const fed = findSource(defaults, 'fed')
  assert.ok(fed)
  const enabledFed = mergeSources(defaults, [{ id: 'fed', enabled: true }]).find((s) => s.id === 'fed')
  assert.ok(enabledFed)
  assert.equal(enabledFed.enabled, true)
  // discoverFromSource 对 kind:'manual' 必须立即返回空列表，不发起任何请求。
  const links = await discoverFromSource({} as CollectDeps, enabledFed)
  assert.deepEqual(links, [])
})

console.log('== mergeSources ==')
await check('按 id 覆盖：字段合并、数量不变、默认对象不被就地修改', () => {
  const before = findSource(defaults, 'fed')
  assert.ok(before)
  const merged = mergeSources(defaults, [{ id: 'fed', enabled: true, minIntervalSec: 30 }])
  assert.equal(merged.length, defaults.length)
  const fed = findSource(merged, 'fed')
  assert.ok(fed)
  assert.equal(fed.enabled, true)
  assert.equal(fed.minIntervalSec, 30)
  assert.equal(fed.kind, 'manual')
  assert.equal(fed.label, before.label)
  assert.deepEqual(fed.hosts, before.hosts)
  assert.equal(before.enabled, false, '默认清单对象不能被覆盖操作改动')
  assert.equal(new Set(merged.map((s) => s.id)).size, merged.length)
})

await check('未知 id 追加一次；同一 id 多次覆盖只保留一条且最后一条生效', () => {
  const added = mergeSources(defaults, [{ id: 'custom-test', label: '自定义测试源', hosts: ['policy.example.test'] }])
  assert.equal(added.length, defaults.length + 1)
  assert.equal(added.filter((s) => s.id === 'custom-test').length, 1)

  const twice = mergeSources(defaults, [
    { id: 'fed', enabled: true, minIntervalSec: 10 },
    { id: 'fed', enabled: false, minIntervalSec: 42 },
  ])
  assert.equal(twice.length, defaults.length, '同 id 覆盖不得增加条目')
  assert.equal(twice.filter((s) => s.id === 'fed').length, 1)
  const fed = findSource(twice, 'fed')
  assert.ok(fed)
  assert.equal(fed.enabled, false)
  assert.equal(fed.minIntervalSec, 42)
})

await check('空覆盖时允许清单与默认完全一致（原有行为不变）', () => {
  const merged = decisionHosts(mergeSources(defaults, []))
  assert.deepEqual([...merged].sort(), [...hosts].sort())
})

console.log(`\n[intl-policy-sources] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
