/**
 * 全球主要指数行情（东财 push2 qt/stock/get）离线 fixture + 静态接线测试。
 *
 * 约束：不联网（globalThis.fetch 被替换为抛错）、不读私有数据、不写配置、不 commit。
 * 覆盖：区域/secid 映射、价格与百分比映射（fltt=2 已是小数，不再 /100）、空 data、
 *       缺字段 null 语义（0 保留为 0）、f86 秒/毫秒时间戳、区域过滤、未知 region、
 *       单行失败隔离、短缓存与「失败不缓存」、TTL、并发上限、service 委托与静态路由/provider 接线。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  EM_GLOBAL_INDEX_FIELDS,
  EM_GLOBAL_INDEX_URL,
  GLOBAL_INDICES_CACHE_TTL_MS,
  GLOBAL_INDICES_CONCURRENCY,
  GLOBAL_INDICES_SOURCE,
  GLOBAL_INDEX_DEFS,
  GLOBAL_REGIONS,
  GLOBAL_REGION_LABELS,
  clearGlobalIndicesCache,
  failedGlobalIndexRow,
  fetchGlobalIndices,
  globalIndicesForRegion,
  normalizeGlobalRegion,
  parseGlobalIndexNumber,
  parseGlobalIndexQuote,
  parseGlobalIndexTime,
  type GlobalIndexDef,
  type GlobalIndicesFetchJson,
  type GlobalIndicesReport,
} from '../src/data/global-indices.js'
import { FinanceDataService } from '../src/data/service.js'
import { PROVIDERS } from '../src/data/providers.js'
import { CAPABILITIES, DEFAULT_PROVIDER_ORDER } from '../src/types.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`) }

// ---------------------------------------------------------------------------
// fixtures（结构取自东财 push2 qt/stock/get：fltt=2 时 f43/f170/f169 已是小数）
// ---------------------------------------------------------------------------

/** 2026-11-17T13:30:00Z 的秒级时间戳（东财 f86 实测为秒）。 */
const TS_SECONDS = Math.floor(Date.UTC(2026, 10, 17, 13, 30, 0) / 1000)
const TS_ISO = new Date(TS_SECONDS * 1000).toISOString()
/** 抓取时钟比行情时间晚 1 分钟，用来证明 at 与 asOf 分开。 */
const CLOCK = Date.UTC(2026, 10, 17, 13, 31, 0)

function defOf(secid: string): GlobalIndexDef {
  const def = GLOBAL_INDEX_DEFS.find((item) => item.secid === secid)
  assert.ok(def, `fixture 缺少 secid ${secid}`)
  return def
}

function emPayload(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rc: 0,
    rt: 7,
    svr: 1,
    lt: 1,
    full: 1,
    data: {
      f43: 6734.12,
      f58: '标普500',
      f170: -0.42,
      f169: -28.39,
      f86: TS_SECONDS,
      ...data,
    },
  }
}

interface FetchCall {
  url: string
  params: Record<string, string | number | undefined>
  options: { timeoutMs: number; signal?: AbortSignal }
}

/** 按 secid 返回 fixture 的假 fetch；可针对某个 secid 注入 Error / 空响应 / 自定义 payload。 */
function fixtureFetch(overrides: Record<string, Error | 'EMPTY' | Record<string, unknown>> = {}) {
  const calls: FetchCall[] = []
  const fetchJson: GlobalIndicesFetchJson = async (url, params, options) => {
    calls.push({ url, params, options })
    const secid = String(params.secid ?? '')
    const def = defOf(secid)
    const override = overrides[secid]
    if (override instanceof Error) throw override
    if (override === 'EMPTY') return { rc: 0, data: null }
    if (override) return override
    return emPayload({ f43: 1000 + GLOBAL_INDEX_DEFS.indexOf(def), f58: def.name })
  }
  return { calls, fetchJson }
}

const spx = defOf('100.SPX')

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('offline test: network disabled') }) as typeof fetch

try {
  // -------------------------------------------------------------------------
  // 1) 区域枚举 / secid 清单
  // -------------------------------------------------------------------------
  check('区域枚举 us/asia/europe/china/commodities，默认 us，all 表示全部', () => {
    assert.deepEqual([...GLOBAL_REGIONS], ['us', 'asia', 'europe', 'china', 'commodities'])
    assert.equal(GLOBAL_REGION_LABELS.us, '美国')
    assert.equal(GLOBAL_REGION_LABELS.asia, '亚太')
    assert.equal(normalizeGlobalRegion(undefined), 'us')
    assert.equal(normalizeGlobalRegion(''), 'us')
    assert.equal(normalizeGlobalRegion('  US '), 'us')
    assert.equal(normalizeGlobalRegion('all'), 'all')
    assert.equal(normalizeGlobalRegion('asia'), 'asia')
    assert.equal(normalizeGlobalRegion('mars'), null)
    assert.equal(normalizeGlobalRegion(null), 'us')
  })

  check('指数 secid 按区域映射齐全且不重复', () => {
    assert.equal(GLOBAL_INDEX_DEFS.length, 24)
    const expected: Record<string, string[]> = {
      us: ['100.SPX', '100.DJIA', '100.NDX', '100.TSX'],
      asia: ['100.HSI', '124.HSTECH', '100.N225', '100.KS11', '100.SENSEX', '100.AS51'],
      europe: ['100.SX5E', '100.FTSE', '100.GDAXI', '100.FCHI'],
      china: ['1.000001', '0.399001', '0.399006'],
      commodities: ['101.GC00Y', '101.SI00Y', '101.HG00Y', '102.CL00Y', '112.B00Y', '171.US10Y', '100.UDI'],
    }
    for (const region of GLOBAL_REGIONS) {
      assert.deepEqual(globalIndicesForRegion(region).map((d) => d.secid), expected[region])
    }
    assert.equal(new Set(GLOBAL_INDEX_DEFS.map((d) => d.secid)).size, 24)
    assert.equal(globalIndicesForRegion('all').length, 24)
    // 常用名/短代码映射（允许源侧 f58 覆盖 name，但清单本身要稳定可读）
    assert.equal(defOf('100.SPX').name, '标普500')
    assert.equal(defOf('100.HSI').region, 'asia')
    assert.equal(defOf('100.AS51').region, 'asia')
    assert.equal(defOf('1.000001').code, '000001')
    assert.equal(defOf('0.399006').name, '创业板指')
  })

  // -------------------------------------------------------------------------
  // 2) 纯解析：价格/百分比映射、时间、null 语义、空 data
  // -------------------------------------------------------------------------
  check('解析价格/涨跌幅/涨跌额：fltt=2 已是小数，不再除以 100', () => {
    const row = parseGlobalIndexQuote(spx, emPayload())
    assert.deepEqual(row, {
      secid: '100.SPX',
      code: 'SPX',
      name: '标普500',
      region: 'us',
      price: 6734.12,
      changePct: -0.42,
      change: -28.39,
      asOf: TS_ISO,
      source: GLOBAL_INDICES_SOURCE,
    })
    const strings = parseGlobalIndexQuote(spx, emPayload({ f43: '4123.45', f170: '1.25', f169: '52.10' }))
    assert.equal(strings.price, 4123.45)
    assert.equal(strings.changePct, 1.25)
    assert.equal(strings.change, 52.1)
    // 若误按「源已放大 100 倍」处理，会得到 41.2345 / 0.0125；这里锁死原值。
    assert.notEqual(strings.price, 41.2345)
  })

  check('f86 秒/毫秒时间戳都转 ISO；0/负数/非法为 null（不变成 1970）', () => {
    assert.equal(parseGlobalIndexTime(TS_SECONDS), TS_ISO)
    assert.equal(parseGlobalIndexTime(TS_SECONDS * 1000), TS_ISO)
    assert.equal(parseGlobalIndexTime(String(TS_SECONDS)), TS_ISO)
    assert.equal(parseGlobalIndexTime(0), null)
    assert.equal(parseGlobalIndexTime(-1), null)
    assert.equal(parseGlobalIndexTime('-'), null)
    assert.equal(parseGlobalIndexTime(undefined), null)
  })

  check('缺字段为 null 不补 0；真实的 0 必须保留为 0', () => {
    const missing = parseGlobalIndexQuote(spx, emPayload({ f43: '-', f170: '—', f169: '', f86: '-' }))
    assert.equal(missing.price, null)
    assert.equal(missing.changePct, null)
    assert.equal(missing.change, null)
    assert.equal(missing.asOf, null)
    const zero = parseGlobalIndexQuote(spx, emPayload({ f43: 0, f170: 0, f169: 0, f86: 0 }))
    assert.equal(zero.price, 0)
    assert.equal(zero.changePct, 0)
    assert.equal(zero.change, 0)
    assert.equal(zero.asOf, null)
    assert.equal(parseGlobalIndexNumber(0), 0)
    assert.equal(parseGlobalIndexNumber('-'), null)
    assert.equal(parseGlobalIndexNumber(''), null)
    assert.equal(parseGlobalIndexNumber('abc'), null)
    assert.equal(parseGlobalIndexNumber(Number.NaN), null)
    assert.equal(parseGlobalIndexNumber(Number.POSITIVE_INFINITY), null)
  })

  check('源侧 f58 名称优先，缺失时回落到清单名', () => {
    assert.equal(parseGlobalIndexQuote(spx, emPayload({ f58: '  标普500指数  ' })).name, '标普500指数')
    assert.equal(parseGlobalIndexQuote(spx, emPayload({ f58: '' })).name, '标普500')
    assert.equal(parseGlobalIndexQuote(spx, emPayload({ f58: 123 })).name, '标普500')
  })

  check('空 data / 结构不符显式抛错（由 fetch 层转成该行 error）', () => {
    const bad: unknown[] = [undefined, null, {}, { data: null }, { data: {} }, { data: [] }, 'oops', 42]
    for (const payload of bad) {
      assert.throws(() => parseGlobalIndexQuote(spx, payload), /空 data/, `payload=${JSON.stringify(payload)}`)
    }
    const failed = failedGlobalIndexRow(spx, 'boom')
    assert.equal(failed.price, null)
    assert.equal(failed.changePct, null)
    assert.equal(failed.change, null)
    assert.equal(failed.asOf, null)
    assert.equal(failed.error, 'boom')
    assert.equal(failed.source, GLOBAL_INDICES_SOURCE)
  })

  // -------------------------------------------------------------------------
  // 3) 抓取：区域过滤、参数、at 与 asOf 分离、all、未知 region
  // -------------------------------------------------------------------------
  await checkAsync('按区域只取该区 secid；请求参数与抓取/行情时间分离', async () => {
    clearGlobalIndicesCache()
    const fake = fixtureFetch()
    const report = await fetchGlobalIndices({ region: 'europe', fetchJson: fake.fetchJson, now: () => CLOCK, cache: false })
    assert.equal(report.ok, true)
    assert.equal(report.region, 'europe')
    assert.equal(report.failed, 0)
    assert.equal(report.cacheHits, 0)
    assert.deepEqual(report.rows.map((r) => r.secid), ['100.SX5E', '100.FTSE', '100.GDAXI', '100.FCHI'])
    assert.equal(report.at, new Date(CLOCK).toISOString())
    assert.equal(report.rows[0]!.asOf, TS_ISO)
    assert.notEqual(report.at, report.rows[0]!.asOf, '抓取时间不能等于行情时间')
    assert.equal(fake.calls.length, 4)
    for (const call of fake.calls) {
      assert.equal(call.url, EM_GLOBAL_INDEX_URL)
      assert.equal(call.params.fltt, 2)
      assert.equal(call.params.invt, 2)
      assert.equal(call.params.fields, EM_GLOBAL_INDEX_FIELDS)
      assert.equal(call.options.timeoutMs, 10_000)
    }
  })

  await checkAsync('region=all 返回全部 24 行；空 region 默认美国', async () => {
    clearGlobalIndicesCache()
    const all = fixtureFetch()
    const report = await fetchGlobalIndices({ region: 'all', fetchJson: all.fetchJson, now: () => CLOCK, cache: false })
    assert.equal(report.rows.length, 24)
    assert.deepEqual(report.rows.map((r) => r.secid), GLOBAL_INDEX_DEFS.map((d) => d.secid))
    assert.equal(new Set(report.rows.map((r) => r.region)).size, 5)
    clearGlobalIndicesCache()
    const us = fixtureFetch()
    const defaulted = await fetchGlobalIndices({ fetchJson: us.fetchJson, now: () => CLOCK, cache: false })
    assert.equal(defaulted.region, 'us')
    assert.equal(defaulted.rows.length, 4)
  })

  await checkAsync('未知 region 返回 ok:false + region:null，且不发任何请求', async () => {
    let calls = 0
    const report = await fetchGlobalIndices({
      region: 'mars',
      fetchJson: async () => { calls += 1; return emPayload() },
      now: () => CLOCK,
    })
    assert.equal(report.ok, false)
    assert.equal(report.region, null)
    assert.deepEqual(report.rows, [])
    assert.match(report.error!, /未知区域/)
    assert.equal(calls, 0)
  })

  // -------------------------------------------------------------------------
  // 4) 行级失败隔离 / 缓存 / TTL / 失败不缓存 / 并发
  // -------------------------------------------------------------------------
  await checkAsync('单行失败只影响该行，其余行照常返回', async () => {
    clearGlobalIndicesCache()
    const fake = fixtureFetch({ '100.NDX': new Error('NDX upstream down') })
    const report = await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => CLOCK, cache: false })
    assert.equal(report.ok, true)
    assert.equal(report.failed, 1)
    assert.equal(report.rows.length, 4)
    const ndx = report.rows.find((r) => r.secid === '100.NDX')!
    assert.equal(ndx.price, null)
    assert.equal(ndx.changePct, null)
    assert.equal(ndx.asOf, null)
    assert.match(ndx.error!, /NDX upstream down/)
    const spxRow = report.rows.find((r) => r.secid === '100.SPX')!
    assert.equal(typeof spxRow.price, 'number')
    assert.equal(spxRow.error, undefined)
    assert.equal(report.at, new Date(CLOCK).toISOString(), '部分失败仍有抓取时间')
  })

  await checkAsync('短缓存：TTL 内命中且不重复请求，at 保留原抓取时间', async () => {
    clearGlobalIndicesCache()
    const fake = fixtureFetch()
    let clock = CLOCK
    const first = await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => clock })
    assert.equal(first.cacheHits, 0)
    assert.equal(fake.calls.length, 4)
    clock += GLOBAL_INDICES_CACHE_TTL_MS - 1
    const second = await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => clock })
    assert.equal(fake.calls.length, 4, 'TTL 内不应再打上游')
    assert.equal(second.cacheHits, 4)
    assert.deepEqual(second.rows.map((r) => r.price), first.rows.map((r) => r.price))
    assert.equal(second.at, first.at, '全部命中缓存时 at 不能假装是刚刚抓的')
  })

  await checkAsync('TTL 过期后重新抓取', async () => {
    clearGlobalIndicesCache()
    const fake = fixtureFetch()
    let clock = CLOCK
    await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => clock })
    clock += GLOBAL_INDICES_CACHE_TTL_MS
    const report = await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => clock })
    assert.equal(fake.calls.length, 8)
    assert.equal(report.cacheHits, 0)
    assert.equal(report.at, new Date(clock).toISOString())
  })

  await checkAsync('整体失败不缓存：下一次会重试，不会把失败冻结在 TTL 里', async () => {
    clearGlobalIndicesCache()
    let calls = 0
    const failing: GlobalIndicesFetchJson = async () => { calls += 1; throw new Error('all upstream down') }
    const first = await fetchGlobalIndices({ region: 'us', fetchJson: failing, now: () => CLOCK })
    assert.equal(first.ok, false)
    assert.equal(first.failed, 4)
    assert.deepEqual(first.rows.map((r) => r.price), [null, null, null, null])
    assert.match(first.error!, /不可用/)
    assert.equal(calls, 4)
    const second = await fetchGlobalIndices({ region: 'us', fetchJson: failing, now: () => CLOCK + 1_000 })
    assert.equal(calls, 8, '失败行不缓存，必须重试')
    assert.equal(second.cacheHits, 0)
    // 源恢复后立刻能拿到数据（没有残留的失败缓存）
    const recovered = fixtureFetch()
    const third = await fetchGlobalIndices({ region: 'us', fetchJson: recovered.fetchJson, now: () => CLOCK + 2_000 })
    assert.equal(third.ok, true)
    assert.equal(third.failed, 0)
  })

  await checkAsync('单行失败不缓存：下次只重试失败的那只', async () => {
    clearGlobalIndicesCache()
    let calls = 0
    const flaky: GlobalIndicesFetchJson = async (_url, params) => {
      calls += 1
      const secid = String(params.secid)
      if (secid === '100.NDX') throw new Error('NDX down')
      return emPayload({ f43: 100 })
    }
    const first = await fetchGlobalIndices({ region: 'us', fetchJson: flaky, now: () => CLOCK })
    assert.equal(first.failed, 1)
    calls = 0
    const second = await fetchGlobalIndices({ region: 'us', fetchJson: flaky, now: () => CLOCK + 1_000 })
    assert.equal(calls, 1, '只重试失败行')
    assert.equal(second.cacheHits, 3, '成功行命中缓存')
    assert.equal(second.failed, 1)
  })

  await checkAsync('小并发有上限（不超过 3 路同时抓取）', async () => {
    clearGlobalIndicesCache()
    let active = 0
    let maxActive = 0
    const fetchJson: GlobalIndicesFetchJson = async (_url, params) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const def = defOf(String(params.secid))
      return emPayload({ f43: 1000 + GLOBAL_INDEX_DEFS.indexOf(def) })
    }
    const report = await fetchGlobalIndices({ region: 'all', fetchJson, now: () => CLOCK, cache: false })
    assert.equal(report.rows.length, 24)
    assert.ok(maxActive <= GLOBAL_INDICES_CONCURRENCY, `maxActive=${maxActive}`)
    assert.ok(maxActive >= 2, `应至少有 2 路并发，实际 ${maxActive}`)
  })

  await checkAsync('报告/行字段契约：rows 带 secid/name/price/changePct/asOf/source，缺字段为 null', async () => {
    clearGlobalIndicesCache()
    const fake = fixtureFetch({ '100.DJIA': { data: { f58: '道琼斯', f43: '-', f170: null, f169: undefined, f86: '-' } } })
    const report = await fetchGlobalIndices({ region: 'us', fetchJson: fake.fetchJson, now: () => CLOCK, cache: false })
    for (const key of ['ok', 'at', 'region', 'rows', 'cacheHits', 'failed']) {
      assert.ok(Object.hasOwn(report, key), `报告缺少字段 ${key}`)
    }
    for (const key of ['secid', 'code', 'name', 'region', 'price', 'changePct', 'change', 'asOf', 'source']) {
      assert.ok(Object.hasOwn(report.rows[0]!, key), `行缺少字段 ${key}`)
    }
    const djia = report.rows.find((r) => r.secid === '100.DJIA')!
    assert.equal(djia.price, null)
    assert.equal(djia.changePct, null)
    assert.equal(djia.change, null)
    assert.equal(djia.asOf, null)
    assert.equal(djia.name, '道琼斯')
    assert.equal(report.ok, true, '部分行无价但整体仍可用')
  })

  // -------------------------------------------------------------------------
  // 5) service 委托（不联网，fake registry 断言参数与返回）
  // -------------------------------------------------------------------------
  const fixtureReport: GlobalIndicesReport = {
    ok: true,
    at: '2026-11-17T05:31:00.000Z',
    region: 'asia',
    rows: [{
      secid: '100.HSI', code: 'HSI', name: '恒生指数', region: 'asia',
      price: 26500.5, changePct: 0.88, change: 231.2, asOf: '2026-11-17T08:00:00.000Z', source: GLOBAL_INDICES_SOURCE,
    }],
    cacheHits: 0,
    failed: 0,
  }

  await checkAsync('service.getGlobalIndices 经 registry 能力 global_indices 调用并透传 region', async () => {
    const calls: Array<{ capability: string; args: Record<string, unknown> }> = []
    const registry = {
      call: async (capability: string, args: Record<string, unknown>) => {
        calls.push({ capability, args })
        return { ok: true, capability, provider: 'em_global_indices', data: fixtureReport }
      },
    }
    const service = new FinanceDataService(registry as never, () => [], async () => {})
    const report = await service.getGlobalIndices('asia')
    assert.deepEqual(calls, [{ capability: 'global_indices', args: { region: 'asia' } }])
    assert.equal(report.ok, true)
    assert.equal(report.provider, 'em_global_indices')
    assert.deepEqual(report.rows, fixtureReport.rows)
    calls.length = 0
    await service.getGlobalIndices()
    assert.deepEqual(calls, [{ capability: 'global_indices', args: { region: 'us' } }], '默认区域必须是 us')
  })

  await checkAsync('service 未知 region 不调用 registry；registry 失败显式返回 ok:false', async () => {
    const calls: string[] = []
    const service = new FinanceDataService({
      call: async (capability: string) => { calls.push(capability); return { ok: true, capability, data: fixtureReport } },
    } as never, () => [], async () => {})
    const invalid = await service.getGlobalIndices('mars')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.region, null)
    assert.match(invalid.error!, /未知区域/)
    assert.equal(calls.length, 0)

    const failing = new FinanceDataService({
      call: async (capability: string) => ({
        ok: false, capability, error: 'all providers failed',
        attempts: [{ provider: 'em_global_indices', error: 'EM down' }],
      }),
    } as never, () => [], async () => {})
    const failed = await failing.getGlobalIndices('china')
    assert.equal(failed.ok, false)
    assert.equal(failed.region, 'china')
    assert.deepEqual(failed.rows, [])
    assert.match(failed.error!, /all providers failed/)
    assert.equal(failed.attempts?.[0]?.provider, 'em_global_indices')
  })

  // -------------------------------------------------------------------------
  // 6) 静态接线：types / providers / service / route / 客户端入口
  // -------------------------------------------------------------------------
  const [moduleSource, typesSource, providersSource, serviceSource, routesSource, clientSource] = await Promise.all([
    readFile(new URL('../src/data/global-indices.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/data/providers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/data/service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server-routes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8'),
  ])

  check('静态：provider 能力 global_indices 已登记且默认顺序唯一', () => {
    assert.ok(CAPABILITIES.includes('global_indices'))
    assert.deepEqual(DEFAULT_PROVIDER_ORDER.global_indices, ['em_global_indices', 'sina_global_indices'])
    const provider = PROVIDERS.find((p) => p.id === 'em_global_indices')
    assert.ok(provider, '缺少 em_global_indices provider')
    assert.equal(provider.capability, 'global_indices')
    assert.deepEqual(provider.sampleArgs, { region: 'us' })
    assert.match(provider.endpointRef, /push2 qt\/stock\/get/)
    assert.match(providersSource, /from '\.\/global-indices\.js'/)
    assert.match(providersSource, /capability: 'global_indices'/)
    assert.match(providersSource, /fetchGlobalIndices\(/)
    // 东财 push2 会按 TLS 指纹重置 Node 连接，新浪作为第二来源兜底。
    const fallback = PROVIDERS.find((p) => p.id === 'sina_global_indices')
    assert.ok(fallback, '缺少 sina_global_indices 兜底源')
    assert.equal(fallback!.capability, 'global_indices')
    assert.match(providersSource, /fetchSinaGlobalIndices\(/)
  })

  check('静态：service 走 registry，HTTP 路由复用同一个 service 方法', () => {
    assert.match(serviceSource, /async getGlobalIndices\(/)
    assert.match(serviceSource, /registry\.call<GlobalIndicesReport>\('global_indices'/)
    assert.match(routesSource, /sub === '\/global-indices'/)
    assert.match(routesSource, /normalizeGlobalRegion\(/)
    assert.match(routesSource, /finance\.getGlobalIndices\(/)
    // 默认 us 由路由与服务两处都把空值归一；不把未知 region 静默当美国
    assert.match(routesSource, /rawRegion \|\| 'us'/)
    assert.equal([...routesSource.matchAll(/finance\.getGlobalIndices\(/g)].length, 1)
    assert.equal([...serviceSource.matchAll(/registry\.call<GlobalIndicesReport>\('global_indices'/g)].length, 1)
  })

  check('静态：模块纯解析可注入 fetch，不直接用全局 fetch；客户端入口已按区域请求', () => {
    assert.match(moduleSource, /export async function fetchGlobalIndices/)
    assert.match(moduleSource, /export function parseGlobalIndexQuote/)
    assert.match(moduleSource, /export type GlobalIndicesFetchJson/)
    assert.equal(/\bfetch\s*\(/.test(moduleSource), false, '网络必须走可注入的 httpGetJson')
    assert.match(moduleSource, /from '\.\/http\.js'/)
    assert.match(clientSource, /const GLOBAL_REGIONS/)
    assert.match(clientSource, /\/global-indices\?region=\$\{encodeURIComponent\(target\)\}/)
  })
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${checks} global indices checks passed (offline fixtures + static wiring; no live provider or network used).`)
