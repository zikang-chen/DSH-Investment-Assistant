/**
 * 全球宏观（OECD SDMX / Eurostat / World Bank / ECB data-api）离线 fixture 与契约测试。
 *
 * 约束：不联网（globalThis.fetch 被替换为抛错）、不写配置/私人数据、不 commit。
 * 覆盖：JSON-stat、SDMX-JSON(1.0/2.0)、SDMX-ML genericdata XML、World Bank JSON、
 *       空值/无效时间/排序/单位/asOf 与 fetchedAt 分离、失败显式 error（不补 0）、
 *       工具与 HTTP 路由都走同一个 service 方法。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  GLOBAL_MACRO_DEFAULT_POINTS,
  GLOBAL_MACRO_SERIES_KEYS,
  applyGlobalMacroPointLimit,
  assembleGlobalMacroSeries,
  buildGlobalMacroReport,
  clampGlobalMacroLimit,
  globalMacroFailure,
  hasObservableValue,
  normalizePeriod,
  normalizeSeriesRequest,
  parseJsonStatDataset,
  parseNumeric,
  parseSdmxGenericXml,
  parseSdmxJsonDataset,
  parseWorldBankIndicator,
  pickParsedSeriesGroup,
} from '../src/data/global-macro.js'
import {
  EURO_AREA_GEO_CODES,
  ecbDfrUrl,
  eurostatUrl,
  fetchGlobalMacroReport,
  oecdCpiUrl,
  worldBankGdpUrl,
  type GlobalMacroHttp,
} from '../src/data/providers.js'
import { registerTools } from '../src/tools/register.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`) }

const FETCHED_AT = '2026-11-17T05:30:00.000Z'

// ---------------------------------------------------------------------------
// fixtures（结构取自真实响应，数值为裁剪后的样本）
// ---------------------------------------------------------------------------

const cat = (index: Record<string, number>, labels: Record<string, string> = {}) => ({ category: { index, label: labels } })

/** Eurostat prc_hicp_manr 多 geo：EA21 最后一期缺值；EA20/EA19 完整。flat = geo*4 + time。 */
const jsonStatHicp = {
  version: '2.0',
  class: 'dataset',
  label: 'HICP - monthly data (annual rate of change)',
  source: 'ESTAT',
  updated: '2026-02-06T23:00:00+0100',
  id: ['freq', 'unit', 'coicop', 'geo', 'time'],
  size: [1, 1, 1, 3, 4],
  dimension: {
    freq: cat({ M: 0 }, { M: 'Monthly' }),
    unit: cat({ RCH_A: 0 }, { RCH_A: 'Annual rate of change' }),
    coicop: cat({ CP00: 0 }, { CP00: 'All-items HICP' }),
    geo: {
      label: 'Geopolitical entity (reporting)',
      category: {
        index: { EA21: 0, EA20: 1, EA19: 2 },
        label: {
          EA21: 'Euro area – 21 countries (from 2026)',
          EA20: 'Euro area – 20 countries (2023-2025)',
          EA19: 'Euro area – 19 countries (2015-2022)',
        },
      },
    },
    time: cat({ '2026-07': 0, '2026-08': 1, '2026-09': 2, '2026-10': 3 }, {
      '2026-07': '2026-07', '2026-08': '2026-08', '2026-09': '2026-09', '2026-10': '2026-10',
    }),
  },
  value: {
    '0': 2.1, '1': 2.0, '2': 1.9, // EA21：2026-10 缺失
    '4': 2.4, '5': 2.3, '6': 2.2, '7': 2.1,
    '8': 3.0, '9': 2.9, '10': 2.8, '11': 2.7,
  },
}

/** 单 geo 且最新一期缺值（用于验证 asOf 不等于「源数据最后一期」，更不能等于 fetchedAt）。 */
const jsonStatMissingLatest = {
  version: '2.0',
  class: 'dataset',
  updated: '2026-11-05T23:00:00+0100',
  id: ['geo', 'time'],
  size: [1, 4],
  dimension: {
    geo: cat({ EA21: 0 }, { EA21: 'Euro area – 21 countries (from 2026)' }),
    time: cat({ '2026-07': 0, '2026-08': 1, '2026-09': 2, '2026-10': 3 }),
  },
  value: { '0': 6.5, '1': 6.4, '2': 6.6 },
}

/** 非法统计期 + 字面 0：0 必须保留为 0，不能当成空值。 */
const jsonStatInvalidTime = {
  version: '2.0',
  class: 'dataset',
  id: ['time'],
  size: [4],
  dimension: { time: cat({ '2024-13': 0, garbage: 1, '2025-01': 2, '2025-02': 3 }) },
  value: { '0': 1, '1': 2, '2': 0, '3': 3.456 },
}

/** ECB data-api 1.0：观测键是扁平时间索引，最后一天为 null（未发布）。 */
const ecbSdmxJson = {
  header: { prepared: '2026-11-17T05:00:00.000+00:00' },
  dataSets: [{
    action: 'Replace',
    series: { '0:0': { attributes: [0, null], observations: { '0': [2.25, 0, 0, null, null], '1': [null, 0, 0, null, null], '2': [null, 0, 0, null, null] } } },
  }],
  structure: {
    dimensions: {
      series: [{ id: 'FREQ', values: [{ id: 'D' }] }, { id: 'REF_AREA', values: [{ id: 'U2' }] }],
      observation: [{
        id: 'TIME_PERIOD',
        name: 'Time period or range',
        role: 'time',
        values: [{ id: '2026-11-13', name: '2026-11-13' }, { id: '2026-11-16' }, { id: '2026-11-17' }],
      }],
    },
  },
}

/** OECD SDMX-JSON 2.0 形态：结构在 data.structure，数据集在 data.dataSets。 */
const oecdSdmxJson2 = {
  meta: { prepared: '2026-11-17T02:50:41' },
  data: {
    structure: {
      dimensions: {
        series: [{ id: 'REF_AREA', values: [{ id: 'USA', name: 'United States' }] }, { id: 'TRANSFORMATION', values: [{ id: 'GY' }] }],
        observation: [{ id: 'TIME_PERIOD', role: 'time', values: [{ id: '2026-08' }, { id: '2026-09' }] }],
      },
    },
    dataSets: [{ series: { '0:0': { observations: { '0': [3.1], '1': [3.737685] } } } }],
  },
}

/** OECD 真实可用的 SDMX-ML genericdata：Obs 顺序不保证，且带 Series.Attributes（不得混入 key）。 */
const oecdXml = `<?xml version="1.0" encoding="utf-8"?>
<message:GenericData xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:generic="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic" xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
  <message:Header><message:Prepared>2026-11-17T05:22:54</message:Prepared></message:Header>
  <message:DataSet>
    <generic:Series>
      <generic:SeriesKey>
        <generic:Value id="REF_AREA" value="USA"/><generic:Value id="FREQ" value="M"/>
        <generic:Value id="METHODOLOGY" value="N"/><generic:Value id="MEASURE" value="CPI"/>
        <generic:Value id="UNIT_MEASURE" value="PA"/><generic:Value id="EXPENDITURE" value="_T"/>
        <generic:Value id="ADJUSTMENT" value="N"/><generic:Value id="TRANSFORMATION" value="GY"/>
      </generic:SeriesKey>
      <generic:Attributes><generic:Value id="DECIMALS" value="2"/></generic:Attributes>
      <generic:Obs><generic:ObsDimension id="TIME_PERIOD" value="2025-01"/><generic:ObsValue value="3.000483"/><generic:Attributes><generic:Value id="OBS_STATUS" value="A"/></generic:Attributes></generic:Obs>
      <generic:Obs><generic:ObsDimension id="TIME_PERIOD" value="2024-02"/><generic:ObsValue value="3.153171"/></generic:Obs>
      <generic:Obs><generic:ObsDimension id="TIME_PERIOD" value="2026-09"/><generic:ObsValue value="3.737685"/></generic:Obs>
    </generic:Series>
  </message:DataSet>
</message:GenericData>`

const worldBankJson = [{
  page: 1, pages: 9, per_page: 4, total: 66, sourceid: '2', lastupdated: '2026-11-11',
}, [
  { date: '2025', value: 2.16138195623856, country: { id: 'US' }, countryiso3code: 'USA', indicator: { id: 'NY.GDP.MKTP.KD.ZG' } },
  { date: '2024', value: 2.79318715363841, country: { id: 'US' }, countryiso3code: 'USA', indicator: { id: 'NY.GDP.MKTP.KD.ZG' } },
  { date: '2023', value: null, country: { id: 'US' }, countryiso3code: 'USA', indicator: { id: 'NY.GDP.MKTP.KD.ZG' } },
]]

function okSeries(series: 'us_cpi' = 'us_cpi') {
  return assembleGlobalMacroSeries({
    series,
    observations: [{ period: '2026-08', value: 3.1 }, { period: '2026-09', value: 3.74 }],
    representation: 'sdmx-json',
    fetchedAt: FETCHED_AT,
    provenance: { provider: 'oecd_sdmx', endpoint: 'https://example.invalid/oecd' },
  })
}

const noopHttp = async (): Promise<never> => { throw new Error('测试不应访问网络') }

/** 注入 HTTP：默认 text 一旦被调用就失败，便于证明走的是 JSON 还是 XML。 */
function fakeHttp(
  json: GlobalMacroHttp['json'],
  text: GlobalMacroHttp['text'] = noopHttp,
): GlobalMacroHttp {
  return { json, text }
}

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('离线测试禁止真实网络请求') }) as typeof fetch

try {
  // -------------------------------------------------------------------------
  // 基础解析
  // -------------------------------------------------------------------------
  check('period normalization accepts only real statistical periods', () => {
    assert.equal(normalizePeriod('2026-09', 'monthly'), '2026-09')
    assert.equal(normalizePeriod('2026-9', 'monthly'), '2026-09')
    assert.equal(normalizePeriod('2026-13', 'monthly'), undefined)
    assert.equal(normalizePeriod('2026-00', 'monthly'), undefined)
    assert.equal(normalizePeriod('garbage', 'monthly'), undefined)
    assert.equal(normalizePeriod('2025', 'annual'), '2025')
    assert.equal(normalizePeriod('25', 'annual'), undefined)
    assert.equal(normalizePeriod('2026-11-16', 'daily'), '2026-11-16')
    assert.equal(normalizePeriod('2026-02-30', 'daily'), undefined)
    assert.equal(normalizePeriod('2026-11-16T00:00:00', 'daily'), undefined)
  })

  check('numeric parsing keeps literal zero and never converts missing tokens to 0', () => {
    assert.equal(parseNumeric(0), 0)
    assert.equal(parseNumeric('0'), 0)
    assert.equal(parseNumeric('2.5'), 2.5)
    assert.equal(parseNumeric('  '), null)
    assert.equal(parseNumeric(null), null)
    assert.equal(parseNumeric(undefined), null)
    assert.equal(parseNumeric('NA'), null)
    assert.equal(parseNumeric('..'), null)
    assert.equal(parseNumeric('abc'), null)
  })

  // -------------------------------------------------------------------------
  // JSON-stat
  // -------------------------------------------------------------------------
  check('JSON-stat: multi-geo flat index, null latest period and group labels', () => {
    const parsed = parseJsonStatDataset(jsonStatHicp, { frequency: 'monthly', seriesDimension: 'geo' })
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.updated, '2026-02-06T23:00:00+0100')
    assert.deepEqual(parsed.groups.map((group) => group.key), ['EA21', 'EA20', 'EA19'])
    const ea21 = parsed.groups[0]!
    assert.equal(ea21.label, 'Euro area – 21 countries (from 2026)')
    assert.deepEqual(ea21.observations.map((obs) => [obs.period, obs.value]), [
      ['2026-07', 2.1], ['2026-08', 2], ['2026-09', 1.9], ['2026-10', null],
    ])
    assert.deepEqual(parsed.groups[1]!.observations.map((obs) => obs.value), [2.4, 2.3, 2.2, 2.1])
    assert.equal(hasObservableValue(parsed), true)
  })

  check('JSON-stat: pick the freshest euro-area aggregate, not just the first one', () => {
    const parsed = parseJsonStatDataset(jsonStatHicp, { frequency: 'monthly', seriesDimension: 'geo' })
    // EA21 读起来「最新」，但最后一期缺值；EA20/EA19 都有 2026-10，按首选顺序选 EA20。
    assert.equal(pickParsedSeriesGroup(parsed.groups, EURO_AREA_GEO_CODES)?.key, 'EA20')
    const stale = { groups: [{ key: 'EA21', observations: [{ period: '2026-09', value: 1 }] }], issues: [] }
    const fresh = { groups: [{ key: 'EA20', observations: [{ period: '2026-10', value: 2 }] }], issues: [] }
    assert.equal(pickParsedSeriesGroup([...stale.groups, ...fresh.groups], EURO_AREA_GEO_CODES)?.key, 'EA20')
  })

  check('JSON-stat: zero-size dimension (filter miss) is an explicit issue, not an empty success', () => {
    const parsed = parseJsonStatDataset({
      id: ['geo', 'time'],
      size: [0, 0],
      dimension: { geo: cat({}), time: cat({}) },
      value: {},
    }, { frequency: 'monthly', seriesDimension: 'geo' })
    assert.deepEqual(parsed.groups, [])
    assert.match(parsed.issues.join('；'), /类目数为 0/)
    assert.equal(hasObservableValue(parsed), false)
  })

  check('JSON-stat: complete array value representation is supported without inventing zeros', () => {
    const parsed = parseJsonStatDataset({
      id: ['time'],
      size: [3],
      dimension: { time: cat({ '2025-01': 0, '2025-02': 1, '2025-03': 2 }) },
      value: [1.5, null, 2.5],
    }, { frequency: 'monthly' })
    assert.deepEqual(parsed.issues, [])
    assert.deepEqual(parsed.groups[0]!.observations, [
      { period: '2025-01', value: 1.5 },
      { period: '2025-02', value: null },
      { period: '2025-03', value: 2.5 },
    ])
  })

  check('JSON-stat: invalid periods dropped, duplicates collapsed, literal zero preserved, rounding declared', () => {
    const parsed = parseJsonStatDataset(jsonStatInvalidTime, { frequency: 'monthly' })
    const assembled = assembleGlobalMacroSeries({
      series: 'ea_hicp',
      observations: [
        ...parsed.groups[0]!.observations,
        { period: '2025-02', value: 999 }, // 同期重复：后者覆盖
      ],
      representation: 'jsonstat',
      fetchedAt: FETCHED_AT,
      provenance: { provider: 'eurostat', endpoint: 'https://example.invalid/eurostat' },
      limit: 10,
    })
    assert.equal(assembled.provenance.invalidPeriods, 2)
    assert.equal(assembled.provenance.droppedDuplicates, 1)
    assert.deepEqual(assembled.points, [{ period: '2025-01', value: 0 }, { period: '2025-02', value: 999 }])
    assert.equal(assembled.provenance.valueRounding, 2)
    assert.equal(assembled.asOf, '2025-02')
    assert.match(assembled.notes.join('；'), /忽略 2 条无法识别的时间值/)
    assert.match(assembled.notes.join('；'), /同期重复观测 1 条/)
  })

  // -------------------------------------------------------------------------
  // SDMX-JSON（ECB 1.0 / OECD 2.0）
  // -------------------------------------------------------------------------
  check('SDMX-JSON 1.0 (ECB): observation index mapping, missing latest value, header prepared', () => {
    const parsed = parseSdmxJsonDataset(ecbSdmxJson, { frequency: 'daily' })
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.updated, '2026-11-17T05:00:00.000+00:00')
    assert.equal(parsed.groups.length, 1)
    assert.equal(parsed.groups[0]!.key, 'D:U2')
    assert.deepEqual(parsed.groups[0]!.observations.map((obs) => [obs.period, obs.value]), [
      ['2026-11-13', 2.25], ['2026-11-16', null], ['2026-11-17', null],
    ])
    const assembled = assembleGlobalMacroSeries({
      series: 'ea_policy_rate',
      observations: parsed.groups[0]!.observations,
      representation: 'sdmx-json',
      fetchedAt: FETCHED_AT,
      provenance: {
        provider: 'ecb_data_api',
        endpoint: 'https://example.invalid/ecb',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
      },
      limit: 10,
    })
    assert.equal(assembled.asOf, '2026-11-13')
    assert.notEqual(assembled.asOf, assembled.fetchedAt)
    assert.equal(assembled.provenance.missingValues, 2)
    assert.match(assembled.notes.join('；'), /最后统计期 2026-11-17 无数值/)
  })

  check('SDMX-JSON 2.0 (OECD data.structure/data.dataSets) parses and sorts on assembly', () => {
    const parsed = parseSdmxJsonDataset(oecdSdmxJson2, { frequency: 'monthly' })
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.updated, '2026-11-17T02:50:41')
    assert.equal(parsed.groups[0]!.key, 'USA:GY')
    const assembled = assembleGlobalMacroSeries({
      series: 'us_cpi',
      observations: [...parsed.groups[0]!.observations].reverse(),
      representation: 'sdmx-json',
      fetchedAt: FETCHED_AT,
      provenance: { provider: 'oecd_sdmx', endpoint: 'https://example.invalid/oecd' },
    })
    assert.deepEqual(assembled.points, [{ period: '2026-08', value: 3.1 }, { period: '2026-09', value: 3.74 }])
    assert.equal(assembled.asOf, '2026-09')
    assert.equal(assembled.latest!.value, 3.74)
  })

  check('SDMX-JSON: malformed payload returns issues instead of invented points', () => {
    assert.deepEqual(parseSdmxJsonDataset({}, { frequency: 'monthly' }).groups, [])
    const missing = parseSdmxJsonDataset({ header: {}, dataSets: [] }, { frequency: 'monthly' })
    assert.deepEqual(missing.groups, [])
    assert.match(missing.issues.join('；'), /缺少 structure\.dimensions/)
    const noObs = parseSdmxJsonDataset({
      structure: { dimensions: { series: [], observation: [{ id: 'TIME_PERIOD', values: [] }] } },
      dataSets: [{ series: { 0: { observations: { 0: [1] } } } }],
    }, { frequency: 'monthly' })
    assert.deepEqual(noObs.groups, [])
  })

  // -------------------------------------------------------------------------
  // SDMX-ML genericdata XML（OECD 实际可用表示）
  // -------------------------------------------------------------------------
  check('SDMX genericdata XML: unsorted obs, Series.Attributes excluded from key, prepared time', () => {
    const parsed = parseSdmxGenericXml(oecdXml, { frequency: 'monthly' })
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.updated, '2026-11-17T05:22:54')
    assert.equal(parsed.groups.length, 1)
    const group = parsed.groups[0]!
    assert.equal(group.dimensions!.REF_AREA, 'USA')
    assert.equal(group.dimensions!.UNIT_MEASURE, 'PA')
    assert.equal(group.dimensions!.TRANSFORMATION, 'GY')
    assert.equal(Object.hasOwn(group.dimensions!, 'DECIMALS'), false)
    const assembled = assembleGlobalMacroSeries({
      series: 'us_cpi',
      observations: group.observations,
      representation: 'sdmx-generic-xml',
      fetchedAt: FETCHED_AT,
      provenance: {
        provider: 'oecd_sdmx',
        endpoint: 'https://example.invalid/oecd',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
      },
    })
    assert.deepEqual(assembled.points.map((point) => point.period), ['2024-02', '2025-01', '2026-09'])
    assert.equal(assembled.asOf, '2026-09')
    assert.equal(assembled.provenance.upstreamTimestamp, '2026-11-17T05:22:54')
  })

  check('SDMX genericdata XML: empty/irrelevant payload is an explicit issue', () => {
    assert.deepEqual(parseSdmxGenericXml('', { frequency: 'monthly' }).groups, [])
    const parsed = parseSdmxGenericXml('<message:GenericData><message:DataSet/></message:GenericData>', { frequency: 'monthly' })
    assert.deepEqual(parsed.groups, [])
    assert.match(parsed.issues.join('；'), /没有 Series 节点/)
  })

  // -------------------------------------------------------------------------
  // World Bank
  // -------------------------------------------------------------------------
  check('World Bank: [meta, rows] parsed with null year kept missing and meta.lastupdated', () => {
    const parsed = parseWorldBankIndicator(worldBankJson)
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.updated, '2026-11-11')
    assert.equal(parsed.countryIso3, 'USA')
    assert.equal(parsed.indicatorId, 'NY.GDP.MKTP.KD.ZG')
    assert.deepEqual(parsed.groups[0]!.observations.map((obs) => [obs.period, obs.value]), [
      ['2025', 2.16138195623856], ['2024', 2.79318715363841], ['2023', null],
    ])
    const assembled = assembleGlobalMacroSeries({
      series: 'us_gdp_growth',
      observations: parsed.groups[0]!.observations,
      representation: 'worldbank-json',
      fetchedAt: FETCHED_AT,
      provenance: {
        provider: 'world_bank',
        endpoint: 'https://example.invalid/wb',
        ...(parsed.updated ? { upstreamTimestamp: parsed.updated } : {}),
      },
      limit: 10,
    })
    assert.equal(assembled.asOf, '2025')
    assert.deepEqual(assembled.points, [{ period: '2024', value: 2.79 }, { period: '2025', value: 2.16 }])
    assert.equal(assembled.provenance.missingValues, 1)
    assert.equal(assembled.provenance.frequency, 'annual')
  })

  check('World Bank: non-array payload yields issue and no points', () => {
    const parsed = parseWorldBankIndicator({ message: 'Invalid indicator' })
    assert.deepEqual(parsed.groups, [])
    assert.match(parsed.issues.join('；'), /\[meta, rows\]/)
  })

  // -------------------------------------------------------------------------
  // 装配语义
  // -------------------------------------------------------------------------
  check('assembly: empty observations produce error, null asOf/latest and never a zero placeholder', () => {
    const empty = assembleGlobalMacroSeries({
      series: 'us_cpi',
      observations: [{ period: '2026-09', value: null }, { period: 'not-a-date', value: 2 }],
      representation: 'sdmx-generic-xml',
      fetchedAt: FETCHED_AT,
      provenance: { provider: 'oecd_sdmx', endpoint: 'https://example.invalid/oecd' },
    })
    assert.deepEqual(empty.points, [])
    assert.equal(empty.latest, null)
    assert.equal(empty.asOf, null)
    assert.match(empty.error!, /未获得有效观测值/)
    assert.match(empty.error!, /不做零值/)
    assert.equal(empty.fetchedAt, FETCHED_AT)
  })

  check('assembly: limit truncates to the most recent periods with explicit provenance', () => {
    const observations = Array.from({ length: 6 }, (_, i) => ({ period: `2026-0${i + 1}`, value: i + 1 }))
    const assembled = assembleGlobalMacroSeries({
      series: 'ea_unemployment',
      observations,
      representation: 'jsonstat',
      fetchedAt: FETCHED_AT,
      provenance: { provider: 'eurostat', endpoint: 'https://example.invalid/eurostat' },
      limit: 3,
    })
    assert.equal(assembled.points.length, 3)
    assert.equal(assembled.provenance.pointsAvailable, 6)
    assert.equal(assembled.provenance.pointsReturned, 3)
    assert.equal(assembled.provenance.truncated, true)
    assert.equal(assembled.latest!.period, '2026-06')
    assert.match(assembled.notes.join('；'), /只返回最近 3 期/)
    assert.equal(clampGlobalMacroLimit(0), 1)
    assert.equal(clampGlobalMacroLimit(500), 120)
    assert.equal(clampGlobalMacroLimit('abc'), GLOBAL_MACRO_DEFAULT_POINTS)
  })

  check('failure result and report keep explicit errors and partial status', () => {
    const failed = globalMacroFailure('ea_hicp', 'HTTP 500 for ec.europa.eu', FETCHED_AT)
    assert.deepEqual(failed.points, [])
    assert.equal(failed.asOf, null)
    assert.equal(failed.error, 'HTTP 500 for ec.europa.eu')
    const ok = okSeries()
    const request = { keys: ['us_cpi', 'ea_hicp'] as const, unknown: ['nope'] }
    const report = buildGlobalMacroReport([ok, failed], { keys: [...request.keys], unknown: [...request.unknown] }, FETCHED_AT)
    assert.equal(report.ok, false)
    assert.equal(report.partial, true)
    assert.equal(report.errors.length, 2)
    assert.match(report.errors[1]!.error, /未知的宏观序列：nope/)
    assert.equal(report.requested.length, 2)
  })

  check('point limit is re-applied from cache without losing asOf or inventing values', () => {
    const series = assembleGlobalMacroSeries({
      series: 'us_cpi',
      observations: [{ period: '2026-08', value: 3.1 }, { period: '2026-09', value: 3.74 }],
      representation: 'sdmx-json',
      fetchedAt: FETCHED_AT,
      provenance: { provider: 'oecd_sdmx', endpoint: 'https://example.invalid/oecd' },
    })
    const cached = applyGlobalMacroPointLimit(series, 10, true)
    assert.equal(cached.asOf, '2026-09')
    assert.equal(cached.provenance.cached, true)
    assert.match(cached.notes.join('；'), /缓存/)
    assert.deepEqual(cached.points, series.points)
    const limited = applyGlobalMacroPointLimit(series, 1, false)
    assert.deepEqual(limited.points, [{ period: '2026-09', value: 3.74 }])
    assert.equal(limited.latest!.period, '2026-09')
  })

  check('series request normalization defaults to all six and keeps unknown names explicit', () => {
    assert.deepEqual(normalizeSeriesRequest(undefined), { keys: [...GLOBAL_MACRO_SERIES_KEYS], unknown: [] })
    assert.deepEqual(normalizeSeriesRequest('us_cpi, ea_hicp,us_cpi'), { keys: ['us_cpi', 'ea_hicp'], unknown: [] })
    assert.deepEqual(normalizeSeriesRequest(['ea_hicp', 'bad_series']), { keys: ['ea_hicp'], unknown: ['bad_series'] })
    assert.equal(GLOBAL_MACRO_SERIES_KEYS.length, 6)
  })

  // -------------------------------------------------------------------------
  // HTTP 层（注入 fixture，不联网）
  // -------------------------------------------------------------------------
  await checkAsync('us_cpi: prefers SDMX-JSON when it parses (no XML request)', async () => {
    const calls: string[] = []
    const http = fakeHttp(async (url) => { calls.push(`json:${url}`); return oecdSdmxJson2 })
    const report = await fetchGlobalMacroReport({ series: ['us_cpi'], http, limit: 5 })
    const series = report.series[0]!
    assert.equal(report.ok, true)
    assert.equal(series.provenance.representation, 'sdmx-json')
    assert.equal(series.asOf, '2026-09')
    assert.equal(series.points.length, 2)
    assert.match(series.provenance.endpoint, /^https:\/\/sdmx\.oecd\.org\/public\/rest\/data\//)
    assert.match(series.provenance.endpoint, /\?startPeriod=\d{4}-\d{2}$/)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!, /^json:https:\/\/sdmx\.oecd\.org/)
  })

  await checkAsync('us_cpi: falls back to genericdata XML when the JSON representation errors', async () => {
    const calls: string[] = []
    const http = fakeHttp(
      async (url) => { calls.push(`json:${url}`); throw new Error('HTTP 500 Internal server error') },
      async (url) => { calls.push(`xml:${url}`); return oecdXml },
    )
    const report = await fetchGlobalMacroReport({ series: ['us_cpi'], http })
    const series = report.series[0]!
    assert.equal(report.ok, true)
    assert.equal(series.provenance.representation, 'sdmx-generic-xml')
    assert.equal(series.asOf, '2026-09')
    assert.deepEqual(series.points.map((point) => point.value), [3.15, 3, 3.74])
    assert.match(series.notes.join('；'), /回退 genericdata XML/)
    assert.equal(series.provenance.upstreamTimestamp, '2026-11-17T05:22:54')
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), ['jso', 'xml'])
  })

  await checkAsync('us_cpi: JSON + XML both failing returns explicit error and no points', async () => {
    const http = fakeHttp(
      async () => { throw new Error('HTTP 500') },
      async () => { throw new Error('HTTP 503') },
    )
    const report = await fetchGlobalMacroReport({ series: ['us_cpi'], http })
    assert.equal(report.ok, false)
    const series = report.series[0]!
    assert.deepEqual(series.points, [])
    assert.equal(series.asOf, null)
    assert.match(series.error!, /OECD SDMX 获取失败/)
    assert.match(series.error!, /SDMX-JSON: HTTP 500/)
    assert.match(series.error!, /XML: HTTP 503/)
  })

  await checkAsync('ea_hicp / ea_unemployment: Eurostat JSON-stat with freshest euro-area group', async () => {
    const urls: string[] = []
    const http = fakeHttp(async (url) => { urls.push(url); return jsonStatHicp })
    const report = await fetchGlobalMacroReport({ series: ['ea_hicp', 'ea_unemployment'], http, limit: 3 })
    assert.equal(report.ok, true)
    for (const series of report.series) {
      assert.equal(series.provenance.provider, 'eurostat')
      assert.equal(series.provenance.representation, 'jsonstat')
      assert.equal(series.provenance.seriesKey, 'EA20')
      assert.match(series.provenance.geography, /EA20/)
      assert.equal(series.asOf, '2026-10')
      assert.equal(series.points.length, 3)
      assert.equal(series.provenance.upstreamTimestamp, '2026-02-06T23:00:00+0100')
    }
    assert.equal(urls.length, 2)
    assert.match(urls[0]!, /prc_hicp_manr/)
    assert.match(urls[1]!, /une_rt_m/)
  })

  await checkAsync('World Bank series use USA/EMU endpoints and keep annual asOf', async () => {
    const urls: string[] = []
    const http = fakeHttp(async (url) => { urls.push(url); return worldBankJson })
    const report = await fetchGlobalMacroReport({ series: ['us_gdp_growth', 'ea_gdp_growth'], http })
    assert.equal(report.ok, true)
    assert.match(urls[0]!, /\/country\/USA\/indicator\/NY\.GDP\.MKTP\.KD\.ZG/)
    assert.match(urls[1]!, /\/country\/EMU\/indicator\/NY\.GDP\.MKTP\.KD\.ZG/)
    assert.equal(report.series[0]!.asOf, '2025')
    assert.equal(report.series[1]!.asOf, '2025')
    assert.equal(report.series[0]!.provenance.representation, 'worldbank-json')
    assert.equal(report.series[0]!.unit, '% 同比')
    assert.equal(report.series[0]!.provenance.upstreamTimestamp, '2026-11-11')
  })

  await checkAsync('ea_policy_rate: ECB SDMX-JSON daily series with missing latest value', async () => {
    const http = fakeHttp(async () => ecbSdmxJson)
    const report = await fetchGlobalMacroReport({ series: ['ea_policy_rate'], http, limit: 10 })
    assert.equal(report.ok, true)
    const series = report.series[0]!
    assert.equal(series.provenance.provider, 'ecb_data_api')
    assert.equal(series.provenance.representation, 'sdmx-json')
    assert.equal(series.asOf, '2026-11-13')
    assert.deepEqual(series.points, [{ period: '2026-11-13', value: 2.25 }])
    assert.match(series.notes.join('；'), /最后统计期 2026-11-17 无数值/)
    assert.match(series.notes.join('；'), /跳过 2 条空值/)
  })

  await checkAsync('empty upstream payload yields error (no zero fill) and unknown series do not call HTTP', async () => {
    let calls = 0
    const http = fakeHttp(
      async () => { calls++; return {} },
      async () => { calls++; return '<message:GenericData/>' },
    )
    const report = await fetchGlobalMacroReport({ series: ['ea_hicp', 'nope'], http })
    assert.equal(report.ok, false)
    assert.equal(report.partial, false)
    const failed = report.series[0]!
    assert.deepEqual(failed.points, [])
    assert.equal(failed.asOf, null)
    assert.match(failed.error!, /无可用观测/)
    assert.equal(report.errors.length, 2)
    assert.equal(calls, 1, '只有已知序列会访问上游')
  })

  await checkAsync('fetchedAt and asOf are distinct; sources/units are always present', async () => {
    const http = fakeHttp(async () => worldBankJson)
    const report = await fetchGlobalMacroReport({ series: ['us_gdp_growth'], http })
    const series = report.series[0]!
    assert.match(series.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(series.asOf, '2025')
    assert.notEqual(series.fetchedAt.slice(0, 10), series.asOf)
    for (const item of [series]) {
      assert.ok(item.source.length > 0)
      assert.ok(item.unit.length > 0)
      assert.ok(item.label.length > 0)
      assert.ok(item.provenance.endpoint.length > 0)
      assert.equal(item.provenance.statisticsTimeField, 'date')
    }
  })

  // -------------------------------------------------------------------------
  // 工具 / 路由契约
  // -------------------------------------------------------------------------
  await checkAsync('get_macro_global tool delegates to finance.getMacroGlobal (single service method)', async () => {
    const tools: Record<string, {
      parameters: { properties: Record<string, unknown> }
      execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal }) => Promise<{
        ok: boolean
        series: Array<{ series: string; asOf: string | null }>
      }>
    }> = {}
    const calls: Array<{ series?: string[]; limit?: number }> = []
    const fixtureReport = {
      ok: true, partial: false, fetchedAt: FETCHED_AT, requested: ['us_cpi'],
      series: [okSeries()], errors: [], notes: [],
    }
    const fakeFinance = {
      getMacroGlobal: async (series?: string[], _signal?: AbortSignal, limit?: number) => {
        calls.push({ series, limit })
        return fixtureReport
      },
    }
    const ctx = { tools: { register: (tool: { name: string }) => { tools[tool.name] = tool as never } } }
    registerTools(ctx as never, fakeFinance as never, {} as never, {} as never, {} as never)
    const tool = tools.get_macro_global!
    assert.ok(tool, 'get_macro_global 必须注册')
    const seriesParam = tool.parameters.properties.series as { type: string; items?: { enum?: string[] } }
    assert.equal(seriesParam.type, 'array')
    assert.deepEqual(seriesParam.items?.enum, [...GLOBAL_MACRO_SERIES_KEYS])
    const result = await tool.execute({ series: ['us_cpi'], limit: 5 }, {})
    assert.deepEqual(calls, [{ series: ['us_cpi'], limit: 5 }])
    assert.equal(result.ok, true)
    assert.equal(result.series[0]!.series, 'us_cpi')
  })

  const [globalSource, providersSource, serviceSource, registerSource, routesSource] = await Promise.all([
    readFile(new URL('../src/data/global-macro.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/data/providers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/data/service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/register.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server-routes.ts', import.meta.url), 'utf8'),
  ])

  check('static: parsers stay pure (no HTTP) and no 403 sources (BLS/CNBC) are wired', () => {
    assert.equal(/\bfetch\s*\(/.test(globalSource), false)
    assert.equal(/httpGetJson|httpGetText|axios/.test(globalSource), false)
    assert.equal(/bls\.gov|cnbc\.com/i.test(globalSource), false)
    assert.equal(/bls\.gov|cnbc\.com/i.test(providersSource), false)
    assert.match(globalSource, /export function parseJsonStatDataset/)
    assert.match(globalSource, /export function parseSdmxJsonDataset/)
    assert.match(globalSource, /export function parseSdmxGenericXml/)
    assert.match(globalSource, /export function parseWorldBankIndicator/)
  })

  check('static: providers wire real endpoints and the four parsers', () => {
    assert.match(providersSource, /from '\.\/global-macro\.js'/)
    assert.match(providersSource, /sdmx\.oecd\.org\/public\/rest\/data/)
    assert.match(providersSource, /ec\.europa\.eu\/eurostat\/api\/dissemination/)
    assert.match(providersSource, /api\.worldbank\.org\/v2\/country/)
    assert.match(providersSource, /data-api\.ecb\.europa\.eu\/service\/data/)
    assert.match(providersSource, /parseJsonStatDataset/)
    assert.match(providersSource, /parseSdmxGenericXml/)
    assert.match(providersSource, /parseWorldBankIndicator/)
    assert.match(providersSource, /export async function fetchGlobalMacroReport/)
  })

  check('static: tool and HTTP route share finance.getMacroGlobal', () => {
    assert.match(serviceSource, /async getMacroGlobal\(/)
    assert.match(serviceSource, /fetchGlobalMacroReport/)
    assert.match(registerSource, /name: 'get_macro_global'/)
    assert.match(registerSource, /finance\.getMacroGlobal\(/)
    assert.match(routesSource, /sub === '\/macro\/global'/)
    assert.match(routesSource, /finance\.getMacroGlobal\(/)
    assert.equal([...registerSource.matchAll(/finance\.getMacroGlobal\(/g)].length, 1)
    assert.equal([...routesSource.matchAll(/finance\.getMacroGlobal\(/g)].length, 1)
  })

  check('static: emitted series schema matches the documented contract', () => {
    const keys = ['series', 'label', 'source', 'unit', 'asOf', 'fetchedAt', 'points', 'latest', 'provenance', 'notes']
    const sample = JSON.parse(JSON.stringify(okSeries())) as Record<string, unknown>
    for (const key of keys) assert.ok(Object.hasOwn(sample, key), `缺少字段 ${key}`)
    assert.equal(sample.asOf, '2026-09')
    assert.equal(sample.fetchedAt, FETCHED_AT)
    const points = sample.points as Array<{ period: string; value: number }>
    assert.deepEqual(points, [{ period: '2026-08', value: 3.1 }, { period: '2026-09', value: 3.74 }])
    assert.deepEqual(sample.latest, { period: '2026-09', value: 3.74 })
    const provenance = sample.provenance as Record<string, unknown>
    assert.equal(provenance.provider, 'oecd_sdmx')
    assert.equal(provenance.frequency, 'monthly')
    assert.equal(provenance.pointsReturned, 2)
  })
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${checks} global macro checks passed (offline fixtures + injected HTTP; no live provider verified in this test).`)
