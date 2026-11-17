/**
 * T5 档案接入：EM 资金流/公司事件 + 港股/美股财务。
 *
 * 只做离线 fixture / 静态契约断言：不联网、不读私有数据、不写配置或账本。
 *   npx tsx scripts/test_dossier_global_sections.ts
 */
import assert from 'node:assert/strict'
import { CAPABILITIES, DEFAULT_PROVIDER_ORDER } from '../src/types.js'
import { WESTOCK_SPECS } from '../src/data/westock-capabilities.js'
import {
  PROVIDERS,
  emDetailProviderPayload,
  globalFinancialsMarket,
  globalFinancialsProviderPayload,
} from '../src/data/providers.js'
import type { EmDetailResult, FundFlowRow } from '../src/data/em-market-detail.js'
import {
  HK_SOURCE,
  US_SOURCE,
  type HkFinancialRow,
  type HkFinancialsResult,
  type UsFinancialRow,
  type UsFinancialsResult,
} from '../src/data/global-financials.js'
import {
  DOSSIER_SPECS,
  buildStockDossier,
  dossierMarketOf,
  dossierSnapshotId,
  type DossierSection,
} from '../src/data/dossier.js'
import { FinanceDataService } from '../src/data/service.js'
import { ProviderRegistry } from '../src/data/registry.js'
import { registerTools } from '../src/tools/register.js'

let checks = 0
function check(name: string, run: () => void) {
  run()
  checks++
  console.log(`PASS ${name}`)
}
async function checkAsync(name: string, run: () => Promise<void>) {
  await run()
  checks++
  console.log(`PASS ${name}`)
}

// ---------------------------------------------------------------------------
// fixtures（真实字段形状，值全部是测试夹具）
// ---------------------------------------------------------------------------

const fundFlowRows: FundFlowRow[] = [
  {
    date: '2026-11-13', mainNet: 1_234_567, smallNet: -200_000, mediumNet: 50_000,
    largeNet: 300_000, extraLargeNet: 900_000, mainPct: 1.2, smallPct: -0.2,
    mediumPct: 0.05, largePct: 0.3, extraLargePct: 0.85, close: 10.52, changePct: 1.1,
  },
  {
    date: '2026-11-12', mainNet: -321_000, smallNet: 100_000, mediumNet: -20_000,
    largeNet: null, extraLargeNet: -301_000, mainPct: -0.4, smallPct: 0.1,
    mediumPct: -0.02, largePct: null, extraLargePct: -0.48, close: 10.41, changePct: -0.6,
  },
  {
    date: '2026-11-11', mainNet: 0, smallNet: 0, mediumNet: 0,
    largeNet: 0, extraLargeNet: 0, mainPct: 0, smallPct: 0,
    mediumPct: 0, largePct: 0, extraLargePct: 0, close: 10.47, changePct: 0,
  },
]

const emMoneyFlowResult: EmDetailResult<FundFlowRow> = {
  ok: true,
  source: 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=20&secid=1.600519',
  asOf: '2026-11-13',
  unit: 'CNY',
  currency: 'CNY',
  rows: fundFlowRows,
  count: fundFlowRows.length,
  fetchedAt: '2026-11-17T03:04:05.000Z',
  warnings: ['夹具：资金流为算法统计，不是公司现金流'],
}

const hkRows: HkFinancialRow[] = [
  {
    reportDate: '2026-06-30', reportType: '2026年中报', currency: 'HKD',
    revenue: 320_000_000_000, revenueYoY: 8.5, netProfit: 90_000_000_000, netProfitYoY: 12.1,
    eps: 9.5, roe: 18.2, pe: 20.5, pb: 3.8, totalAssets: 1_600_000_000_000,
    totalLiabilities: 700_000_000_000, equity: 900_000_000_000, operatingCashFlow: 120_000_000_000,
  },
  {
    reportDate: '2025-12-31', reportType: '2025年年报', currency: 'HKD',
    revenue: 600_000_000_000, revenueYoY: 7.1, netProfit: null, netProfitYoY: null,
    eps: null, roe: null, pe: null, pb: null, totalAssets: 1_550_000_000_000,
    totalLiabilities: null, equity: null, operatingCashFlow: null,
  },
]

const hkResult: HkFinancialsResult = {
  ok: true,
  market: 'hk',
  code: '00700',
  name: '腾讯控股',
  currency: 'HKD',
  source: HK_SOURCE,
  fetchedAt: '2026-11-17T03:04:05.000Z',
  rows: hkRows,
  profile: { name: '腾讯控股', orgName: '腾讯控股有限公司', industry: '互联网', listingDate: '2004-06-16', website: 'www.tencent.com' },
  warnings: ['夹具：港股为累计口径，不是单季'],
}

const usRows: UsFinancialRow[] = [
  {
    form: '10-Q', end: '2026-09-30', start: '2026-07-01', fy: 2026, fp: 'Q3', periodType: 'quarterly',
    durationDays: 91, currency: 'USD', unit: 'USD', epsUnit: 'USD/shares', filed: '2026-10-30',
    accession: '0000320193-26-000100', revenue: 95_000_000_000, netProfit: 24_000_000_000,
    operatingIncome: 30_000_000_000, totalAssets: null, totalLiabilities: null, equity: null,
    cashAndCashEquivalents: null, eps: 1.62, sources: {},
  },
  {
    form: '10-K', end: '2025-09-27', start: '2024-09-29', fy: 2025, fp: 'FY', periodType: 'annual',
    durationDays: 363, currency: 'USD', unit: 'USD', epsUnit: 'USD/shares', filed: '2025-11-01',
    accession: '0000320193-25-000090', revenue: 400_000_000_000, netProfit: null,
    operatingIncome: 120_000_000_000, totalAssets: 350_000_000_000, totalLiabilities: 250_000_000_000,
    equity: 100_000_000_000, cashAndCashEquivalents: 30_000_000_000, eps: null, sources: {},
  },
]

const usResult: UsFinancialsResult = {
  ok: true,
  market: 'us',
  code: 'AAPL',
  name: null,
  currency: 'USD',
  source: US_SOURCE,
  fetchedAt: '2026-11-17T03:04:05.000Z',
  rows: usRows,
  warnings: ['夹具：美股 10-Q 为单季，10-K 为年度'],
}

const emMoneyFlowPayload = emDetailProviderPayload('money_flow', emMoneyFlowResult)
const hkPayload = globalFinancialsProviderPayload(hkResult)
const usPayload = globalFinancialsProviderPayload(usResult)

const announcedFixture = {
  kind: 'announcements',
  source: 'https://np-anotice-stock.eastmoney.com/api/security/ann',
  asOf: '2026-11-15',
  unit: '条',
  rows: [{ id: 'AN202611150001', title: '夹具公告', noticeDate: '2026-11-15', categories: ['重大事项'], sourceUrl: 'https://data.eastmoney.com/notices/detail/600519/AN202611150001.html' }],
  count: 1,
  fetchedAt: '2026-11-17T03:04:05.000Z',
}

// ---------------------------------------------------------------------------
// 1) capability 注册、顺序与映射
// ---------------------------------------------------------------------------

check('EM 资金流 provider 存在且静态顺序在 WeStock 之前', () => {
  const ids = PROVIDERS.map((p) => p.id)
  const emIdx = ids.indexOf('em_market_detail_money_flow')
  const wsIdx = ids.indexOf('ws_fund_flow')
  assert.ok(emIdx >= 0, 'em_market_detail_money_flow missing')
  assert.ok(wsIdx >= 0, 'ws_fund_flow missing')
  assert.ok(emIdx < wsIdx, `EM(${emIdx}) should precede ws_fund_flow(${wsIdx})`)
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.money_flow, ['em_market_detail_money_flow', 'ws_fund_flow'])
})

check('EM 明细条目全部排在 WESTOCK_SPECS 展开之前', () => {
  const ids = PROVIDERS.map((p) => p.id)
  const firstWestockSpec = Math.min(...WESTOCK_SPECS.map((s) => ids.indexOf(s.id)).filter((i) => i >= 0))
  const emDetailIds = [
    'em_market_detail_money_flow',
    'em_market_detail_money_flow_detail',
    'em_market_detail_announcements',
    'em_market_detail_dividend_plan',
    'em_market_detail_performance',
    'em_market_detail_block_trade',
    'em_market_detail_block_trade_detail',
    'em_market_detail_margin_detail',
    'global_financials_sources',
  ]
  for (const id of emDetailIds) {
    const index = ids.indexOf(id)
    assert.ok(index >= 0, `${id} missing`)
    assert.ok(index < firstWestockSpec, `${id}(${index}) should precede first WESTOCK_SPECS(${firstWestockSpec})`)
  }
})

check('capability 映射：单向来源 + 顺序断言', () => {
  const idsOf = (capability: string) => PROVIDERS.filter((p) => p.capability === capability).map((p) => p.id)
  assert.deepEqual(idsOf('announcements'), ['em_market_detail_announcements'])
  assert.deepEqual(idsOf('dividend_plan'), ['em_market_detail_dividend_plan'])
  assert.deepEqual(idsOf('performance'), ['em_market_detail_performance'])
  assert.deepEqual(idsOf('margin_detail'), ['em_market_detail_margin_detail'])
  assert.deepEqual(idsOf('block_trade_detail'), ['em_market_detail_block_trade_detail'])
  assert.deepEqual(idsOf('money_flow_detail'), ['em_market_detail_money_flow_detail'])
  assert.deepEqual(idsOf('global_financials'), ['global_financials_sources'])
  assert.deepEqual(idsOf('block_trade'), ['em_market_detail_block_trade', 'ws_block'])
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.block_trade, ['em_market_detail_block_trade', 'ws_block'])
  const ids = PROVIDERS.map((p) => p.id)
  assert.ok(ids.indexOf('em_market_detail_block_trade') < ids.indexOf('ws_block'))
})

check('新 capability 全部登记在 CAPABILITIES / DEFAULT_PROVIDER_ORDER', () => {
  const newCaps = [
    'announcements', 'dividend_plan', 'performance', 'margin_detail',
    'block_trade_detail', 'money_flow_detail', 'global_financials',
  ] as const
  for (const cap of newCaps) {
    assert.ok(CAPABILITIES.includes(cap), `${cap} missing in CAPABILITIES`)
    assert.ok(Array.isArray(DEFAULT_PROVIDER_ORDER[cap]) && DEFAULT_PROVIDER_ORDER[cap].length > 0, `${cap} missing default order`)
  }
  const globalProvider = PROVIDERS.find((p) => p.id === 'global_financials_sources')
  assert.ok(globalProvider)
  assert.deepEqual(globalProvider.sampleArgs, { code: '00700', market: 'hk' })
})

// ---------------------------------------------------------------------------
// 2) 资金流 data 行数 / 时点 / 不补 0
// ---------------------------------------------------------------------------

check('EM 资金流映射保留逐日 rows、source、asOf、unit', () => {
  assert.equal(emMoneyFlowPayload.rows.length, 3)
  assert.ok(emMoneyFlowPayload.rows.length > 1)
  assert.equal(emMoneyFlowPayload.data.rows.length, 3)
  assert.equal(emMoneyFlowPayload.data.kind, 'money_flow')
  assert.equal(emMoneyFlowPayload.data.unit, 'CNY')
  assert.equal(emMoneyFlowPayload.data.currency, 'CNY')
  assert.equal(emMoneyFlowPayload.data.asOf, '2026-11-13')
  assert.match(emMoneyFlowPayload.data.source, /fflow\/daykline/)
  assert.equal(emMoneyFlowPayload.data.count, 3)
  assert.deepEqual(emMoneyFlowPayload.sampleKeys.slice(0, 3), ['date', 'mainNet', 'smallNet'])
})

check('EM 失败显式 throw（交给 registry 回退），不伪造空成功', () => {
  const failed: EmDetailResult<FundFlowRow> = {
    ok: false, source: 'https://push2his.eastmoney.com/...', unit: 'CNY', currency: 'CNY',
    rows: [], count: 0, fetchedAt: '2026-11-17T03:04:05.000Z', error: '资金流：HTTP 502 Bad Gateway',
  }
  assert.throws(() => emDetailProviderPayload('money_flow', failed), /HTTP 502/)
})

check('null/0 原样保留：不把缺失值补成 0', () => {
  const nullRow = emMoneyFlowPayload.data.rows[1]!
  assert.equal(nullRow.largeNet, null)
  assert.equal(nullRow.mainNet, -321_000)
  const zeroRow = emMoneyFlowPayload.data.rows[2]!
  assert.equal(zeroRow.mainNet, 0)
  assert.deepEqual(emMoneyFlowPayload.data.rows, fundFlowRows)
})

await checkAsync('registry 端到端（stub fetch，不联网）：money_flow_detail 经 EM 解析出 20 日 rows', async () => {
  const klines = [
    '2026-11-10,1000,200,200,300,700,1,0.2,0.2,0.3,0.7,10.5,1.2',
    '2026-11-11,-500,-100,-50,-200,-300,-0.5,-0.1,-0.05,-0.2,-0.3,10.4,-0.9',
    '2026-11-12,0,0,0,0,0,0,0,0,0,0,10.4,0',
  ]
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ rc: 0, data: { klines } }),
    }
  }) as unknown as typeof fetch
  try {
    const registry = new ProviderRegistry({
      cacheTtlSec: 0,
      requestGapMs: 0,
      httpTimeoutMs: 5_000,
      probeReportPath: 'unused-probe-report.json',
      packageRoot: process.cwd(),
      dataDir: process.cwd(),
    })
    const result = await registry.call('money_flow_detail', { code: '600519', days: 20 })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'em_market_detail_money_flow_detail')
    const data = result.data as { rows: unknown[]; asOf?: string; unit: string; source: string; kind: string }
    assert.ok(data.rows.length > 1)
    assert.equal(data.rows.length, 3)
    assert.equal(data.asOf, '2026-11-12')
    assert.match(data.unit, /CNY/)
    assert.equal(data.kind, 'money_flow')
    assert.match(data.source, /fflow\/daykline/)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// 3) 港股/美股财务映射：来源、币种、报告期、不补 0
// ---------------------------------------------------------------------------

check('港股财务映射：东财 HKF10 来源 + 报告币种 + 报告期', () => {
  assert.equal(hkPayload.rows.length, 2)
  assert.equal(hkPayload.data.market, 'hk')
  assert.equal(hkPayload.data.source, HK_SOURCE)
  assert.equal(hkPayload.data.currency, 'HKD')
  assert.equal(hkPayload.data.fetchedAt, '2026-11-17T03:04:05.000Z')
  assert.equal(hkPayload.data.rows[0]!.reportDate, '2026-06-30')
  assert.equal(hkPayload.data.rows[1]!.netProfit, null)
})

check('美股财务映射：SEC XBRL 来源 + 10-K/10-Q 期间 + USD', () => {
  assert.equal(usPayload.rows.length, 2)
  assert.equal(usPayload.data.market, 'us')
  assert.equal(usPayload.data.source, US_SOURCE)
  assert.equal(usPayload.data.currency, 'USD')
  assert.deepEqual(usPayload.rows.map((r) => r.form), ['10-Q', '10-K'])
  assert.equal(usPayload.rows[1]!.netProfit, null)
  assert.equal(usPayload.data.rows[0]!.revenue, 95_000_000_000)
})

check('全球财务失败显式报错（含 SEC UA 缺失），market 只认 hk/us', () => {
  assert.throws(
    () => globalFinancialsProviderPayload({
      ok: false, market: 'us', code: 'AAPL', name: null, currency: 'USD',
      source: US_SOURCE, fetchedAt: '2026-11-17T03:04:05.000Z', rows: [],
      error: 'SEC EDGAR 要求 User-Agent 含可联系邮箱',
    }),
    /User-Agent/,
  )
  assert.equal(globalFinancialsMarket('hk'), 'hk')
  assert.equal(globalFinancialsMarket('港股'), 'hk')
  assert.equal(globalFinancialsMarket('US'), 'us')
  assert.throws(() => globalFinancialsMarket('jp'), /market=hk\|us/)
  assert.throws(() => globalFinancialsMarket(undefined), /market=hk\|us/)
})

// ---------------------------------------------------------------------------
// 4) dossier 市场隔离 + 新增 section 的时点/来源/口径
// ---------------------------------------------------------------------------

function makeDossierFinance(options: { failAnnouncements?: boolean } = {}) {
  const calls: Array<{ capability: string; args: Record<string, unknown> }> = []
  const finance = {
    westock: async (capability: string, args: Record<string, unknown>) => {
      calls.push({ capability, args })
      if (capability === 'announcements') {
        if (options.failAnnouncements) throw new Error('fixture announcements unavailable')
        return { ok: true, provider: 'em_market_detail_announcements', data: announcedFixture }
      }
      if (capability === 'dividend_plan') {
        return {
          ok: true, provider: 'em_market_detail_dividend_plan',
          data: { kind: 'dividend_plan', source: 'https://datacenter.eastmoney.com/...', asOf: '2026-06-20', unit: 'CNY/10股', rows: [{ reportDate: '2025-12-31', noticeDate: '2026-06-20', planText: '每10股派10元' }], count: 1, fetchedAt: '2026-11-17T03:04:05.000Z' },
        }
      }
      if (capability === 'performance') {
        return {
          ok: true, provider: 'em_market_detail_performance',
          data: { kind: 'performance', source: 'https://datacenter.eastmoney.com/...', asOf: '2026-10-28', unit: 'CNY', rows: [{ kind: 'forecast', reportDate: '2026-09-30', noticeDate: '2026-10-28' }], count: 1, fetchedAt: '2026-11-17T03:04:05.000Z' },
        }
      }
      if (capability === 'block_trade_detail') {
        return {
          ok: true, provider: 'em_market_detail_block_trade_detail',
          data: { kind: 'block_trade', source: 'https://datacenter.eastmoney.com/...', asOf: '2026-11-10', unit: 'CNY', rows: [{ tradeDate: '2026-11-10', dealPrice: 10.2, volume: 100_000 }], count: 1, fetchedAt: '2026-11-17T03:04:05.000Z' },
        }
      }
      if (capability === 'margin_detail') {
        return {
          ok: true, provider: 'em_market_detail_margin_detail',
          data: { kind: 'margin_detail', source: 'https://datacenter.eastmoney.com/...', asOf: '2026-11-14', unit: 'CNY', rows: [{ tradeDate: '2026-11-14', financingBalance: 1_000_000_000 }], count: 1, fetchedAt: '2026-11-17T03:04:05.000Z' },
        }
      }
      if (capability === 'money_flow') {
        return { ok: true, provider: 'em_market_detail_money_flow', data: emMoneyFlowPayload.data }
      }
      if (capability === 'global_financials') {
        return String(args.market) === 'hk'
          ? { ok: true, provider: 'global_financials_sources', data: hkPayload.data }
          : { ok: true, provider: 'global_financials_sources', data: usPayload.data }
      }
      return { ok: false, capability, error: `fixture-unavailable:${capability}` }
    },
  } as unknown as FinanceDataService
  return { finance, calls }
}

const sectionOf = (sections: DossierSection[], key: string) => {
  const found = sections.find((s) => s.key === key)
  assert.ok(found, `section ${key} missing`)
  return found!
}

await checkAsync('markets：A 股适用新 section，港美股财务显式 unsupported 且不发请求', async () => {
  const { finance, calls } = makeDossierFinance()
  const stock = await buildStockDossier(finance, '600519')
  for (const key of ['announcements', 'dividend_plan', 'performance', 'block_trade', 'margin_detail']) {
    assert.equal(sectionOf(stock.sections, key).status, 'ready', `${key} should be ready for A-share`)
  }
  assert.equal(calls.some((c) => c.capability === 'global_financials'), false)
  for (const key of ['hk_financials', 'us_financials']) {
    const section = sectionOf(stock.sections, key)
    assert.equal(section.status, 'unsupported')
    assert.match(section.error ?? '', /仅适用于/)
    assert.equal(section.data, undefined)
  }
  assert.match(sectionOf(stock.sections, 'hk_financials').error ?? '', /港股/)
  assert.match(sectionOf(stock.sections, 'us_financials').error ?? '', /美股/)
  assert.equal(sectionOf(stock.sections, 'us_financials').dataAsOf, undefined)
})

await checkAsync('markets：港股只请求 HK 财务，A 股专属 section 显式 unsupported', async () => {
  const { finance, calls } = makeDossierFinance()
  const stock = await buildStockDossier(finance, '00700')
  assert.equal(dossierMarketOf('00700'), 'hk')
  const hk = sectionOf(stock.sections, 'hk_financials')
  assert.equal(hk.status, 'ready')
  assert.equal(hk.provider, 'global_financials_sources')
  assert.equal((hk.data as { source: string }).source, HK_SOURCE)
  assert.match(hk.label, /东财 HKF10/)
  assert.match(hk.label, /累计口径、非单季/)
  // dataAsOf 用最新报告期末，不是抓取时间。
  assert.equal(hk.dataAsOf, '2026-06-30')
  assert.notEqual(hk.dataAsOf, hkResult.fetchedAt.slice(0, 10))
  // 美股 section 不适用。
  assert.equal(sectionOf(stock.sections, 'us_financials').status, 'unsupported')
  // A 股专属能力没有被请求。
  for (const cap of ['announcements', 'dividend_plan', 'performance', 'block_trade_detail', 'margin_detail']) {
    assert.equal(calls.some((c) => c.capability === cap), false, `${cap} must not be requested for HK`)
  }
  assert.match(sectionOf(stock.sections, 'announcements').error ?? '', /A股/)
})

await checkAsync('markets：美股财务 10-Q 单季口径 + dataAsOf 取报告期末', async () => {
  const { finance, calls } = makeDossierFinance()
  const stock = await buildStockDossier(finance, 'AAPL')
  assert.equal(dossierMarketOf('AAPL'), 'us')
  const us = sectionOf(stock.sections, 'us_financials')
  assert.equal(us.status, 'ready')
  assert.equal((us.data as { source: string }).source, US_SOURCE)
  assert.match(us.label, /SEC XBRL/)
  assert.match(us.label, /10-Q/)
  assert.match(us.label, /单季/)
  assert.equal(us.dataAsOf, '2026-09-30')
  assert.notEqual(us.dataAsOf, usResult.fetchedAt.slice(0, 10))
  const globalCall = calls.find((c) => c.capability === 'global_financials')
  assert.deepEqual(globalCall?.args, { code: 'AAPL', market: 'us' })
})

await checkAsync('money_flow section 使用 EM 逐日 rows，时点/来源/口径标注齐全', async () => {
  const { finance } = makeDossierFinance()
  const stock = await buildStockDossier(finance, '600519')
  const flow = sectionOf(stock.sections, 'money_flow')
  assert.equal(flow.status, 'ready')
  assert.equal(flow.provider, 'em_market_detail_money_flow')
  assert.equal(flow.rows, 3)
  assert.equal((flow.data as { rows: unknown[] }).rows.length, 3)
  assert.equal(flow.dataAsOf, '2026-11-13')
  assert.match(flow.label, /逐日 20 日/)
  assert.match(flow.label, /算法统计/)
  assert.match(flow.label, /不等于公司现金流/)
})

await checkAsync('港股 null 值不被补 0；美股字段原样保留', async () => {
  const { finance } = makeDossierFinance()
  const hkStock = await buildStockDossier(finance, '00700')
  const hkRowsOut = (sectionOf(hkStock.sections, 'hk_financials').data as { rows: HkFinancialRow[] }).rows
  assert.equal(hkRowsOut.find((r) => r.reportDate === '2025-12-31')?.netProfit, null)
  const usStock = await buildStockDossier(finance, 'AAPL')
  const usRowsOut = (sectionOf(usStock.sections, 'us_financials').data as { rows: UsFinancialRow[] }).rows
  assert.equal(usRowsOut.find((r) => r.form === '10-K')?.netProfit, null)
  assert.equal(usRowsOut.find((r) => r.form === '10-Q')?.revenue, 95_000_000_000)
})

await checkAsync('单项失败只影响该 section（公告失败，其它维度不受影响）', async () => {
  const { finance } = makeDossierFinance({ failAnnouncements: true })
  const stock = await buildStockDossier(finance, '600519')
  const announcement = sectionOf(stock.sections, 'announcements')
  assert.equal(announcement.status, 'error')
  assert.match(announcement.error ?? '', /fixture announcements unavailable/)
  assert.equal(sectionOf(stock.sections, 'dividend_plan').status, 'ready')
  assert.equal(sectionOf(stock.sections, 'money_flow').status, 'ready')
  assert.equal(sectionOf(stock.sections, 'hk_financials').status, 'unsupported')
})

await checkAsync('基金：市场专属 section 全部 unsupported，F10 仍显式拒绝', async () => {
  const { finance, calls } = makeDossierFinance()
  const fund = await buildStockDossier(finance, '110022', 'fund')
  for (const key of ['announcements', 'block_trade', 'margin_detail', 'hk_financials', 'us_financials']) {
    assert.equal(sectionOf(fund.sections, key).status, 'unsupported', key)
  }
  assert.match(sectionOf(fund.sections, 'company_survey').error ?? '', /仅支持 A 股/)
  assert.equal(calls.some((c) => c.capability === 'global_financials'), false)
})

check('快照剔除 fetchedAt：同数据重取 snapshotId 稳定', () => {
  const section = (fetchedAt: string): DossierSection => ({
    key: 'money_flow', label: '资金流向', group: '资金', ok: true, status: 'ready', rows: 1,
    data: { ...emMoneyFlowPayload.data, fetchedAt }, ms: 1,
  })
  const a = dossierSnapshotId({ code: '600519', type: 'stock', sections: [section('2026-11-17T01:00:00.000Z')] })
  const b = dossierSnapshotId({ code: '600519', type: 'stock', sections: [section('2026-11-17T09:59:00.000Z')] })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{32}$/)
})

// ---------------------------------------------------------------------------
// 5) dossier spec 静态契约
// ---------------------------------------------------------------------------

check('DOSSIER_SPECS 市场标注与标签口径', () => {
  const byKey = new Map(DOSSIER_SPECS.map((s) => [s.key, s]))
  assert.deepEqual(byKey.get('announcements')?.markets, ['a'])
  assert.deepEqual(byKey.get('dividend_plan')?.markets, ['a'])
  assert.deepEqual(byKey.get('performance')?.markets, ['a'])
  assert.deepEqual(byKey.get('block_trade')?.markets, ['a'])
  assert.deepEqual(byKey.get('margin_detail')?.markets, ['a'])
  assert.deepEqual(byKey.get('hk_financials')?.markets, ['hk'])
  assert.deepEqual(byKey.get('us_financials')?.markets, ['us'])
  assert.equal(byKey.get('money_flow')?.markets, undefined)
  assert.match(byKey.get('margin_detail')?.label ?? '', /逐日/)
  assert.match(byKey.get('block_trade')?.label ?? '', /逐笔/)
  assert.match(byKey.get('us_financials')?.label ?? '', /SEC XBRL/)
  assert.match(byKey.get('hk_financials')?.label ?? '', /累计口径、非单季/)
  const keys = DOSSIER_SPECS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, 'duplicate section keys')
})

// ---------------------------------------------------------------------------
// 6) service：EM 优先 + WeStock 回退
// ---------------------------------------------------------------------------

function makeServiceRegistry(behavior: (capability: string, args: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ capability: string; args: Record<string, unknown> }> = []
  const registry = {
    call: async (capability: string, args: Record<string, unknown>) => {
      calls.push({ capability, args })
      return behavior(capability, args)
    },
  }
  const service = new FinanceDataService(registry as never, () => [], async () => {})
  return { service, calls }
}

await checkAsync('service.getMoneyFlow：EM 独占能力优先，成功即返回逐日 data', async () => {
  const { service, calls } = makeServiceRegistry(async (capability) => capability === 'money_flow_detail'
    ? { ok: true, capability, provider: 'em_market_detail_money_flow_detail', data: emMoneyFlowPayload.data }
    : { ok: true, capability, provider: 'ws_fund_flow', data: [{ EndDate: '2026-11-13', MainNetFlow: 1 }] })
  const result = await service.getMoneyFlow('600519')
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'em_market_detail_money_flow_detail')
  assert.equal((result.data as { rows: unknown[] }).rows.length, 3)
  assert.deepEqual(calls.map((c) => c.capability), ['money_flow_detail'])
  assert.deepEqual(calls[0]!.args, { code: '600519', days: 20 })
})

await checkAsync('service.getMoneyFlow：EM 失败回退 WeStock，并保留具体错误', async () => {
  const { service, calls } = makeServiceRegistry(async (capability) => capability === 'money_flow_detail'
    ? { ok: false, capability, error: 'EM 502', attempts: [{ provider: 'em_market_detail_money_flow_detail', error: 'EM 502' }] }
    : { ok: true, capability, provider: 'ws_fund_flow', data: [{ EndDate: '2026-11-13' }] })
  const result = await service.getMoneyFlow('600519')
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'ws_fund_flow')
  assert.deepEqual(calls.map((c) => c.capability), ['money_flow_detail', 'money_flow'])

  const bothFail = makeServiceRegistry(async (capability) => capability === 'money_flow_detail'
    ? { ok: false, capability, error: 'EM 502' }
    : { ok: false, capability, error: 'WS timeout' })
  const failed = await bothFail.service.getMoneyFlow('600519')
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /EM 逐日资金流不可用：EM 502/)
  assert.match(failed.error ?? '', /回退源失败：WS timeout/)
  assert.deepEqual(failed.attempts, [])
})

await checkAsync('service.getMoneyFlow：港美股不走 EM 明细，直接走既有链', async () => {
  const { service, calls } = makeServiceRegistry(async (capability) => ({ ok: true, capability, provider: 'ws_fund_flow', data: [] }))
  await service.getMoneyFlow('00700')
  assert.deepEqual(calls.map((c) => c.capability), ['money_flow'])
  assert.deepEqual(calls[0]!.args, { code: '00700' })
})

await checkAsync('service.westock(money_flow) 与 get_money_flow 委托同一条 EM 优先路径', async () => {
  const { service, calls } = makeServiceRegistry(async (capability) => capability === 'money_flow_detail'
    ? { ok: true, capability, provider: 'em_market_detail_money_flow_detail', data: emMoneyFlowPayload.data }
    : { ok: false, capability, error: 'should not fall back' })
  const result = await service.westock('money_flow', { code: '600519' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((c) => c.capability), ['money_flow_detail'])
})

await checkAsync('service.westock(money_flow)：显式 start/end 区间保持既有 WeStock 语义', async () => {
  const { service, calls } = makeServiceRegistry(async (capability) => ({
    ok: true, capability, provider: 'ws_fund_flow', data: [{ EndDate: '2026-09-10' }],
  }))
  const result = await service.westock('money_flow', { code: '600519', start: '2026-09-01', end: '2026-09-10' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((c) => c.capability), ['money_flow'])
  assert.deepEqual(calls[0]!.args, { code: '600519', start: '2026-09-01', end: '2026-09-10' })
})

await checkAsync('service.getGlobalFinancials：market 映射与非法值拒绝', async () => {
  const { service, calls } = makeServiceRegistry(async (capability, args) => ({
    ok: true, capability, provider: 'global_financials_sources',
    data: String(args.market) === 'hk' ? hkPayload.data : usPayload.data,
  }))
  const hk = await service.getGlobalFinancials('00700', '港股')
  assert.equal(hk.ok, true)
  assert.deepEqual(calls[0], { capability: 'global_financials', args: { code: '00700', market: 'hk' } })
  const us = await service.getGlobalFinancials('AAPL', 'us')
  assert.equal(us.ok, true)
  assert.deepEqual(calls[1], { capability: 'global_financials', args: { code: 'AAPL', market: 'us' } })
  const bad = await service.getGlobalFinancials('7203', 'jp')
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /market 必须是 hk 或 us/)
  assert.equal(calls.length, 2)
})

// ---------------------------------------------------------------------------
// 7) tool 委托
// ---------------------------------------------------------------------------

await checkAsync('tool：get_global_financials 推断市场并委托 service；stock_dossier 委托档案构建', async () => {
  const tools: Record<string, { name: string; description: string; execute: (args: Record<string, unknown>, context?: unknown) => Promise<Record<string, unknown>> }> = {}
  const globalCalls: Array<{ code: string; market: string }> = []
  const dossierCalls: Array<{ capability: string; args: Record<string, unknown> }> = []
  const fakeFinance = {
    westock: async (capability: string, args: Record<string, unknown>) => {
      dossierCalls.push({ capability, args })
      if (capability === 'global_financials') {
        return String(args.market) === 'hk'
          ? { ok: true, provider: 'global_financials_sources', data: hkPayload.data }
          : { ok: true, provider: 'global_financials_sources', data: usPayload.data }
      }
      return { ok: false, capability, error: `fixture-unavailable:${capability}` }
    },
    getGlobalFinancials: async (code: string, market: string) => {
      globalCalls.push({ code, market })
      return { ok: true, provider: 'global_financials_sources', data: market === 'hk' ? hkPayload.data : usPayload.data }
    },
  }
  const ctx = { tools: { register: (tool: (typeof tools)[string]) => { tools[tool.name] = tool } } }
  registerTools(
    ctx as never,
    fakeFinance as never,
    {} as never,
    { noteSnapshot: async () => {} } as never,
    {} as never,
  )
  const tool = tools.get_global_financials!
  assert.ok(tool, 'get_global_financials not registered')
  assert.match(tool.description, /SEC/)
  assert.match(tool.description, /累计口径/)

  const hk = await tool.execute({ code: '00700' }, { signal: undefined })
  assert.equal(hk.ok, true)
  assert.equal(hk.market, 'hk')
  assert.equal(hk.currency, 'HKD')
  assert.equal(hk.source, HK_SOURCE)
  assert.equal(hk.count, 2)
  assert.deepEqual(globalCalls[0], { code: '00700', market: 'hk' })

  const us = await tool.execute({ code: 'AAPL', market: 'us' }, { signal: undefined })
  assert.equal(us.market, 'us')
  assert.equal(us.source, US_SOURCE)
  assert.deepEqual(globalCalls[1], { code: 'AAPL', market: 'us' })

  const unsupported = await tool.execute({ code: '600519' }, { signal: undefined })
  assert.equal(unsupported.ok, false)
  assert.match(String(unsupported.error), /无法从代码推断市场/)
  assert.equal(globalCalls.length, 2)

  // stock_dossier 工具委托 buildStockDossier：港股代码会请求 global_financials(hk)。
  const dossierTool = tools.stock_dossier!
  assert.match(dossierTool.description, /港股财务/)
  await dossierTool.execute({ code: '00700' }, { signal: undefined })
  assert.equal(
    dossierCalls.some((c) => c.capability === 'global_financials' && c.args.market === 'hk'),
    true,
  )
})

console.log(`\n${checks} dossier global section checks passed (offline fixtures + static contracts; no network/private data).`)
