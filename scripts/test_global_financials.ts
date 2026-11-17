/**
 * 全球财务数据模块测试（task-14）：美股 SEC EDGAR companyfacts + 港股东财 F10。
 *
 * 全部离线：网络函数通过注入的 fetchJson stub 驱动，fixture 取自 2026-11-17 本机
 * 实测响应（AAPL companyfacts / 00700 MAININDICATOR 与 ORGPROFILE 的真实字段与数值），
 * 不发起任何真实请求、不读私有数据、不写文件。
 *
 * 覆盖：ticker 大小写与 BRK.B 归一、多 tag 选择、10-K 年度 vs 10-Q 单季口径、
 * (form,end,fp,fy) 去重与 latest-filed、单位过滤（EPS 只用 USD/shares）、缺失 null、
 * maxPeriods、港股币种/空值/重复期/未知代码、公司资料单独失败不进 error、抓取时间≠报告期。
 */
import assert from 'node:assert/strict'
import {
  EM_HK_F10_URL,
  HK_F10_MAIN_INDICATOR_REPORT,
  HK_F10_ORG_PROFILE_REPORT,
  HK_SOURCE,
  SEC_TICKERS_URL,
  US_CURRENCY,
  US_EPS_UNIT,
  US_SOURCE,
  canonicalUsTicker,
  fetchHkFinancials,
  fetchUsFinancials,
  hkMainIndicatorParams,
  hkOrgProfileParams,
  normalizeHkCode,
  normalizeHkMainIndicator,
  parseHkOrgProfile,
  parseSecCompanyFacts,
  parseSecTickerMap,
  resolveSecTicker,
  secCompanyFactsUrl,
  type GlobalFinancialsFetchJson,
} from '../src/data/global-financials.js'

const FIXED_NOW = new Date('2026-11-17T04:00:00.000Z')
const FIXED_ISO = FIXED_NOW.toISOString()
const TEST_UA = 'dsh-finance-test/0.1 qa@example.com'

let checks = 0
async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await fn()
  checks++
  console.log(`PASS ${checks}. ${name}`)
}

function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error('预期抛错，但调用成功返回')
}

interface StubCall {
  url: string
  params: Record<string, string | number | undefined>
  headers?: Record<string, string>
}

function stubFetch(handler: (call: StubCall) => unknown): { fn: GlobalFinancialsFetchJson; calls: StubCall[] } {
  const calls: StubCall[] = []
  const fn: GlobalFinancialsFetchJson = async (url, params, options) => {
    const call: StubCall = { url, params, headers: options.headers }
    calls.push(call)
    return handler(call)
  }
  return { fn, calls }
}

// ---------------------------------------------------------------- SEC fixtures（模拟真实 company_tickers/companyfacts 结构）

const SEC_TICKERS_FIXTURE: Record<string, unknown> = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  '2': { cik_str: 1067983, ticker: 'BRK-A', title: 'BERKSHIRE HATHAWAY INC' },
  '3': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
}

const REV = 'RevenueFromContractWithCustomerExcludingAssessedTax'

/** 与实测 AAPL companyfacts 同构：每年 10-K 年度事实 + 10-Q 的 YTD/单季/比较期快照 + 重复申报。 */
const SEC_FACTS_FIXTURE: Record<string, unknown> = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    'us-gaap': {
      [REV]: {
        units: {
          USD: [
            // FY2024 原始 10-K
            { start: '2023-10-01', end: '2024-09-28', val: 391035, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            // FY2024 作为 FY2025 10-K 比较期（fy=2025）→ 主期间过滤后不单独成行
            { start: '2023-10-01', end: '2024-09-28', val: 391035, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            // FY2025 10-K：年度事实 + 同 group 的 Q4 单季事实（单季必须被年度窗口拒绝）
            { start: '2024-09-29', end: '2025-09-27', val: 416161, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { start: '2025-06-29', end: '2025-09-27', val: 102466, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            // 2025 Q3 10-Q：YTD + 单季 + 同 (form,end,fp,fy) 的旧申报（应保留最新 filed）
            { start: '2024-09-29', end: '2025-06-28', val: 313695, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-03-30', end: '2025-06-28', val: 94036, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-03-30', end: '2025-06-28', val: 90000, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-04-01', accn: '0000320193-25-000001' },
            // FY2026 Q1
            { start: '2025-09-28', end: '2025-12-27', val: 143756, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
            // 非 10-K/10-Q 表单：忽略
            { start: '2025-09-28', end: '2025-12-20', val: 1, fy: 2026, fp: 'Q1', form: '8-K', filed: '2026-01-02', accn: '0000320193-26-999999' },
          ],
        },
      },
      // 旧 tag：只覆盖 FY2023，用来验证多 tag 回退
      Revenues: {
        units: {
          USD: [
            { start: '2022-09-25', end: '2023-09-30', val: 383285, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            { start: '2022-09-25', end: '2023-09-30', val: 96995, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { start: '2023-10-01', end: '2024-09-28', val: 93736, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            { start: '2024-09-29', end: '2025-09-27', val: 112010, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { start: '2024-09-29', end: '2025-06-28', val: 84544, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-03-30', end: '2025-06-28', val: 23434, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-09-28', end: '2025-12-27', val: 42097, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
          ],
        },
      },
      OperatingIncomeLoss: {
        units: {
          USD: [
            { start: '2023-10-01', end: '2024-09-28', val: 123216, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            { start: '2024-09-29', end: '2025-09-27', val: 133050, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { start: '2025-03-30', end: '2025-06-28', val: 25352, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-09-28', end: '2025-12-27', val: 50800, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
          ],
        },
      },
      Assets: {
        units: {
          USD: [
            { end: '2023-09-30', val: 352583, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { end: '2024-09-28', val: 364980, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            // 比较期快照：FY2025 10-K 里的上年末（fy=2025）→ 不单独成行
            { end: '2024-09-28', val: 364980, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { end: '2025-09-27', val: 359241, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            // 2025 Q3 申报：本期 + 比较期（同 form/fy/fp，主期间过滤只留 end 最大）
            { end: '2025-06-28', val: 331495, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { end: '2024-09-28', val: 364980, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { end: '2025-12-27', val: 379297, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
          ],
        },
      },
      Liabilities: {
        units: {
          USD: [
            { end: '2023-09-30', val: 290437, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { end: '2024-09-28', val: 308030, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            { end: '2025-09-27', val: 285508, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { end: '2025-12-27', val: 285508, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
          ],
        },
      },
      StockholdersEquity: {
        units: {
          USD: [
            { end: '2023-09-30', val: 62146, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { end: '2024-09-28', val: 56950, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            { end: '2025-09-27', val: 73733, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
          ],
        },
      },
      CashAndCashEquivalentsAtCarryingValue: {
        units: {
          // 只到 FY2024：FY2025/FY2026 必须缺失为 null，而不是 0
          USD: [
            { end: '2023-09-30', val: 29965, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { end: '2024-09-28', val: 29943, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
          ],
        },
      },
      EarningsPerShareDiluted: {
        units: {
          'USD/shares': [
            { start: '2022-09-25', end: '2023-09-30', val: 6.13, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-03', accn: '0000320193-23-000106' },
            { start: '2023-10-01', end: '2024-09-28', val: 6.08, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01', accn: '0000320193-24-000123' },
            { start: '2024-09-29', end: '2025-09-27', val: 7.46, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31', accn: '0000320193-25-000079' },
            { start: '2025-03-30', end: '2025-06-28', val: 1.57, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
            { start: '2025-09-28', end: '2025-12-27', val: 2.84, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30', accn: '0000320193-26-000006' },
          ],
          // 错误单位：金额事实绝不能被当成 EPS
          USD: [
            { start: '2025-03-30', end: '2025-06-28', val: 613000000000, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
          ],
          shares: [
            { start: '2025-03-30', end: '2025-06-28', val: 15000000000, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
          ],
        },
      },
      FooBarIgnoredTag: {
        units: {
          USD: [
            { start: '2025-03-30', end: '2025-06-28', val: 1, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01', accn: '0000320193-25-000073' },
          ],
        },
      },
    },
  },
}

// ---------------------------------------------------------------- HK fixtures（取自 00700 实测响应字段）

function hkRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SECUCODE: '00700.HK',
    SECURITY_NAME_ABBR: '腾讯控股',
    REPORT_DATE: '2026-06-30 00:00:00',
    REPORT_TYPE: '2026年中报',
    CURRENCY: 'HKD',
    OPERATE_INCOME: 401243000000,
    OPERATE_INCOME_YOY: 10.0725325491,
    HOLDER_PROFIT: 114115000000,
    HOLDER_PROFIT_YOY: 10.3103944939,
    BASIC_EPS: 12.639,
    ROE_AVG: 9.966353785254,
    PE_TTM: 13.300875755166,
    PB_TTM: 2.714393030168,
    TOTAL_ASSETS: 2159394000000,
    TOTAL_LIABILITIES: 936881000000,
    TOTAL_PARENT_EQUITY: 1135853000000,
    NETCASH_OPERATE: 154061000000,
    ...overrides,
  }
}

function hkMainFixture(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return { version: 'test', success: true, result: { pages: 1, count: rows.length, data: rows } }
}

const HK_MAIN_FIXTURE = hkMainFixture([
  hkRawRow(),
  // 空值期：每字段都缺失 → 全部 null，不补 0
  hkRawRow({
    REPORT_DATE: '2026-03-31 00:00:00',
    REPORT_TYPE: '2026年一季报',
    OPERATE_INCOME: null,
    OPERATE_INCOME_YOY: null,
    HOLDER_PROFIT: null,
    HOLDER_PROFIT_YOY: null,
    BASIC_EPS: null,
    ROE_AVG: null,
    PE_TTM: null,
    PB_TTM: null,
    TOTAL_ASSETS: null,
    TOTAL_LIABILITIES: null,
    TOTAL_PARENT_EQUITY: null,
    NETCASH_OPERATE: null,
  }),
  hkRawRow({
    REPORT_DATE: '2025-12-31 00:00:00',
    REPORT_TYPE: '2025年年报',
    OPERATE_INCOME: 751766000000,
    OPERATE_INCOME_YOY: 13.8596031545,
    HOLDER_PROFIT: 224842000000,
    HOLDER_PROFIT_YOY: 15.8543434687,
    BASIC_EPS: 24.749,
    ROE_AVG: 21.134746439818,
    TOTAL_ASSETS: 2038986000000,
    TOTAL_LIABILITIES: 797921000000,
    TOTAL_PARENT_EQUITY: 1154152000000,
    NETCASH_OPERATE: 303052000000,
  }),
  // 重复报告期：保留先出现的一行（401243...），不被覆盖
  hkRawRow({ OPERATE_INCOME: 999 }),
])

const HK_UNKNOWN_FIXTURE = { version: null, result: null, success: false, message: '返回数据为空', code: 9201 }

const HK_PROFILE_FIXTURE = {
  version: 'test',
  success: true,
  result: {
    pages: 1,
    data: [{
      SECUCODE: '00700.HK',
      SECURITY_CODE: '00700',
      SECURITY_NAME_ABBR: '腾讯控股',
      ORG_NAME: '腾讯控股有限公司',
      BELONG_INDUSTRY: '软件服务',
      LISTING_DATE: '2004-06-16 00:00:00',
      ORG_WEB: 'www.tencent.com',
    }],
  },
}

function hkStubHandler(main: unknown, profile: unknown | Error): (call: StubCall) => unknown {
  return (call) => {
    if (call.params.reportName === HK_F10_MAIN_INDICATOR_REPORT) return main
    if (call.params.reportName === HK_F10_ORG_PROFILE_REPORT) {
      if (profile instanceof Error) throw profile
      return profile
    }
    throw new Error(`未预期的 reportName：${String(call.params.reportName)}`)
  }
}

// ---------------------------------------------------------------- 测试

try {
  // 1. ticker 归一
  await check('canonicalUsTicker：大小写 / BRK.B / AAPL.US 归一', () => {
    assert.equal(canonicalUsTicker('aapl'), 'AAPL')
    assert.equal(canonicalUsTicker('  aapl '), 'AAPL')
    assert.equal(canonicalUsTicker('BRK.B'), 'BRK-B')
    assert.equal(canonicalUsTicker('brk.b'), 'BRK-B')
    assert.equal(canonicalUsTicker('BRK/B'), 'BRK-B')
    assert.equal(canonicalUsTicker('brk-b'), 'BRK-B')
    assert.equal(canonicalUsTicker('AAPL.US'), 'AAPL')
    assert.equal(canonicalUsTicker(''), '')
    assert.equal(canonicalUsTicker('   '), '')
  })

  // 2. ticker→CIK 映射（含 BRK.B 与 CIK 补零）
  await check('parseSecTickerMap + resolveSecTicker：BRK.B 命中 BRK-B，CIK 补零到 10 位', () => {
    const index = parseSecTickerMap(SEC_TICKERS_FIXTURE)
    const brk = resolveSecTicker('BRK.B', index)
    assert.equal(brk.ok, true)
    assert.equal(brk.ticker, 'BRK-B')
    assert.equal(brk.cik, '1067983')
    assert.equal(brk.cik10, '0001067983')
    assert.equal(brk.name, 'BERKSHIRE HATHAWAY INC')
    assert.equal(resolveSecTicker('brk.b', index).ticker, 'BRK-B')

    const aapl = resolveSecTicker('aapl', index)
    assert.equal(aapl.ok, true)
    assert.equal(aapl.ticker, 'AAPL')
    assert.equal(aapl.cik10, '0000320193')

    // 两条不同 ticker 可以指向同一个 CIK（BRK-A / BRK-B）
    assert.equal(resolveSecTicker('BRK-A', index).cik, '1067983')
  })

  // 3. 未知 / 空 ticker 的明确错误
  await check('resolveSecTicker：未知 ticker 返回 error + 相近候选，空值返回 error', () => {
    const index = parseSecTickerMap(SEC_TICKERS_FIXTURE)
    const unknown = resolveSecTicker('ZZZZ', index)
    assert.equal(unknown.ok, false)
    assert.match(unknown.error ?? '', /未找到 ticker「ZZZZ」/)
    assert.equal(unknown.candidates, undefined, '无前缀候选时不伪造候选列表')

    const near = resolveSecTicker('MS', index)
    assert.equal(near.ok, false)
    assert.deepEqual(near.candidates, ['MSFT'])

    const empty = resolveSecTicker('   ', index)
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /为空/)
  })

  // 4. ticker 映射结构校验
  await check('parseSecTickerMap：空/错结构抛错，不把空映射当成功', () => {
    assert.match(thrown(() => parseSecTickerMap({})).message, /没有有效的 ticker\/CIK/)
    assert.match(thrown(() => parseSecTickerMap(null)).message, /没有有效的 ticker\/CIK/)
    assert.match(thrown(() => parseSecTickerMap([{ ticker: 'AAPL', cik_str: 320193 }])).message, /没有有效的 ticker\/CIK/)
  })

  // 5. companyfacts URL
  await check('secCompanyFactsUrl：CIK 补齐 10 位', () => {
    assert.equal(secCompanyFactsUrl('320193'), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json')
    assert.equal(secCompanyFactsUrl(1067983), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001067983.json')
    assert.equal(secCompanyFactsUrl('CIK0000320193'), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json')
    assert.match(thrown(() => secCompanyFactsUrl('abc')).message, /有效 CIK/)
  })

  // 6. 年度 / 季度 / 主期间过滤
  await check('parseSecCompanyFacts：按 10-K 年度 / 10-Q 单季度取值，比较期快照不单独成行', () => {
    const parsed = parseSecCompanyFacts(SEC_FACTS_FIXTURE)
    assert.equal(parsed.entityName, 'Apple Inc.')
    assert.equal(parsed.cik, '320193')
    assert.deepEqual(parsed.rows.map((r) => r.end), ['2025-12-27', '2025-09-27', '2025-06-28', '2024-09-28', '2023-09-30'])
    assert.deepEqual(parsed.rows.map((r) => r.form), ['10-Q', '10-K', '10-Q', '10-K', '10-K'])
    assert.deepEqual(parsed.rows.map((r) => r.periodType), ['quarterly', 'annual', 'quarterly', 'annual', 'annual'])

    const fy2025 = parsed.rows.find((r) => r.end === '2025-09-27')!
    assert.equal(fy2025.revenue, 416161, '10-K 应取年度营收，不是 Q4 单季 102466')
    assert.equal(fy2025.start, '2024-09-29')
    assert.equal(fy2025.durationDays, 363)
    assert.equal(fy2025.fy, 2025)
    assert.equal(fy2025.fp, 'FY')

    const q3 = parsed.rows.find((r) => r.end === '2025-06-28')!
    assert.equal(q3.revenue, 94036, '10-Q 应取单季度营收，不是 YTD 313695')
    assert.equal(q3.netProfit, 23434, '10-Q 净利润同样取单季度')
    assert.equal(q3.start, '2025-03-30')
    assert.equal(q3.durationDays, 90)

    // 比较期快照（同 end 但 fy=2025 的 10-K、10-Q 旧 end）没有生成重复行
    assert.equal(parsed.rows.filter((r) => r.end === '2024-09-28').length, 1)
  })

  // 7. 多 tag 优先级与回退
  await check('parseSecCompanyFacts：营收多 tag 优先级 + 旧 tag Revenues 回退', () => {
    const parsed = parseSecCompanyFacts(SEC_FACTS_FIXTURE)
    const fy2024 = parsed.rows.find((r) => r.end === '2024-09-28')!
    assert.equal(fy2024.revenue, 391035)
    assert.equal(fy2024.sources.revenue?.tag, REV)
    const fy2023 = parsed.rows.find((r) => r.end === '2023-09-30')!
    assert.equal(fy2023.revenue, 383285)
    assert.equal(fy2023.sources.revenue?.tag, 'Revenues')
  })

  // 8. 去重 + 单位过滤
  await check('parseSecCompanyFacts：(form,end,fp,fy) 去重保留最新 filed，EPS 只取 USD/shares', () => {
    const parsed = parseSecCompanyFacts(SEC_FACTS_FIXTURE)
    const q3 = parsed.rows.find((r) => r.end === '2025-06-28')!
    assert.equal(q3.revenue, 94036, '同 key 旧申报（90000）应被最新 filed 覆盖')
    assert.equal(q3.sources.revenue?.accession, '0000320193-25-000073')
    assert.equal(q3.sources.revenue?.filed, '2025-08-01')
    assert.equal(q3.filed, '2025-08-01')
    assert.equal(q3.accession, '0000320193-25-000073')
    assert.equal(q3.eps, 1.57, 'EPS 不能取 USD 单位的 613000000000')
    assert.equal(q3.sources.eps?.unit, US_EPS_UNIT)
    assert.equal(q3.epsUnit, US_EPS_UNIT)
    assert.equal(q3.unit, 'USD')
    assert.equal(q3.currency, US_CURRENCY)
    assert.equal(parsed.rows.filter((r) => r.end === '2025-06-28' && r.form === '10-Q').length, 1)
  })

  // 9. 缺失 null / 忽略未知 tag 与非 10-K/10-Q
  await check('parseSecCompanyFacts：缺失指标为 null（不补 0），忽略未知 tag 与非 10-K/10-Q', () => {
    const parsed = parseSecCompanyFacts(SEC_FACTS_FIXTURE)
    const fy2025 = parsed.rows.find((r) => r.end === '2025-09-27')!
    assert.equal(fy2025.cashAndCashEquivalents, null)
    assert.equal(parsed.rows.every((r) => r.form === '10-K' || r.form === '10-Q'), true)
    assert.equal(parsed.rows.some((r) => r.end === '2025-12-20'), false, '8-K 事实不应成行')
    const q1 = parsed.rows.find((r) => r.end === '2025-12-27')!
    assert.equal(q1.equity, null)
    assert.equal(q1.cashAndCashEquivalents, null)
    assert.equal(q1.sources.equity, undefined)
    assert.equal((q1.sources as Record<string, unknown>).FooBarIgnoredTag, undefined)
    // val=null 的事实不能因 Number(null)=0 被当成 0：应整条忽略，不生成 0 值行
    const nullVal = parseSecCompanyFacts({
      cik: 1,
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            units: {
              USD: [{ start: '2025-01-01', end: '2025-12-31', val: null, fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-01', accn: 'null-val' }],
            },
          },
        },
      },
    })
    assert.deepEqual(nullVal.rows, [])
  })

  // 10. maxPeriods
  await check('parseSecCompanyFacts：maxPeriods 按 end 倒序截断', () => {
    const two = parseSecCompanyFacts(SEC_FACTS_FIXTURE, { maxPeriods: 2 })
    assert.deepEqual(two.rows.map((r) => r.end), ['2025-12-27', '2025-09-27'])
    const clamped = parseSecCompanyFacts(SEC_FACTS_FIXTURE, { maxPeriods: 0 })
    assert.equal(clamped.rows.length, 1, 'maxPeriods<1 应夹到 1')
  })

  // 11. 空与结构错误
  await check('parseSecCompanyFacts：无目标 tag → rows []；非 companyfacts 结构 → 抛错', () => {
    const empty = parseSecCompanyFacts({ cik: 1, entityName: 'Empty Co', facts: { 'us-gaap': { UnknownTag: { units: { USD: [] } } } } })
    assert.deepEqual(empty.rows, [])
    assert.equal(empty.entityName, 'Empty Co')
    assert.match(thrown(() => parseSecCompanyFacts(null)).message, /不是 JSON 对象/)
    assert.match(thrown(() => parseSecCompanyFacts({ facts: {} })).message, /us-gaap/)
  })

  // 12. fetchUsFinancials 成功
  await check('fetchUsFinancials：2 次请求 + UA + 统一结构，fetchedAt 与报告期分离', async () => {
    const stub = stubFetch((call) => {
      if (call.url === SEC_TICKERS_URL) return SEC_TICKERS_FIXTURE
      if (call.url === secCompanyFactsUrl('320193')) return SEC_FACTS_FIXTURE
      throw new Error(`未预期 URL：${call.url}`)
    })
    const res = await fetchUsFinancials('aapl', { fetchJson: stub.fn, userAgent: TEST_UA, maxPeriods: 3, now: () => FIXED_NOW })
    assert.equal(res.ok, true)
    assert.equal(res.market, 'us')
    assert.equal(res.code, 'AAPL')
    assert.equal(res.name, 'Apple Inc.')
    assert.equal(res.currency, US_CURRENCY)
    assert.equal(res.source, US_SOURCE)
    assert.equal(res.fetchedAt, FIXED_ISO)
    assert.equal(res.error, undefined)
    assert.equal(res.rows.length, 3)
    assert.equal(res.rows[0]!.end, '2025-12-27')
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0]!.url, SEC_TICKERS_URL)
    assert.equal(stub.calls[1]!.url, secCompanyFactsUrl('320193'))
    assert.equal(stub.calls[0]!.headers?.['User-Agent'], TEST_UA)
    assert.equal(stub.calls[1]!.headers?.['User-Agent'], TEST_UA)
    // 抓取时间不是任何报告期
    assert.ok(res.rows.every((r) => r.end !== res.fetchedAt.slice(0, 10)))
  })

  // 13. BRK.B 大小写与 CIK 路径
  await check('fetchUsFinancials：brk.b → BRK-B，并请求 0001067983 的 companyfacts', async () => {
    const stub = stubFetch((call) => {
      if (call.url === SEC_TICKERS_URL) return SEC_TICKERS_FIXTURE
      if (call.url === secCompanyFactsUrl('1067983')) return { ...SEC_FACTS_FIXTURE, cik: 1067983, entityName: 'BERKSHIRE HATHAWAY INC' }
      throw new Error(`未预期 URL：${call.url}`)
    })
    const res = await fetchUsFinancials('brk.b', { fetchJson: stub.fn, userAgent: TEST_UA, maxPeriods: 1, now: () => FIXED_NOW })
    assert.equal(res.ok, true)
    assert.equal(res.code, 'BRK-B')
    assert.equal(res.name, 'BERKSHIRE HATHAWAY INC')
    assert.equal(stub.calls[1]!.url, 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001067983.json')
  })

  // 14. 未知 ticker 只请求一次
  await check('fetchUsFinancials：未知 ticker 只取映射表，ok:false 且错误含 ticker', async () => {
    const stub = stubFetch(() => SEC_TICKERS_FIXTURE)
    const res = await fetchUsFinancials('ZZZZ', { fetchJson: stub.fn, userAgent: TEST_UA, now: () => FIXED_NOW })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'ZZZZ')
    assert.match(res.error ?? '', /未找到 ticker「ZZZZ」/)
    assert.equal(stub.calls.length, 1)
    assert.equal(res.rows.length, 0)
  })

  // 15. 缺 UA：不请求
  await check('fetchUsFinancials：缺含邮箱的 User-Agent 时不发请求，错误指明 DSH_SEC_EDGAR_UA', async () => {
    const saved = process.env.DSH_SEC_EDGAR_UA
    delete process.env.DSH_SEC_EDGAR_UA
    try {
      const stub = stubFetch(() => {
        throw new Error('不应发起请求')
      })
      const res = await fetchUsFinancials('AAPL', { fetchJson: stub.fn, now: () => FIXED_NOW })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /User-Agent/)
      assert.match(res.error ?? '', /DSH_SEC_EDGAR_UA/)
      assert.equal(stub.calls.length, 0)
      // 显式 UA 优先于环境变量：请求放行（用正常 stub 验证能走完两次请求）
      const okStub = stubFetch((call) => {
        if (call.url === SEC_TICKERS_URL) return SEC_TICKERS_FIXTURE
        return SEC_FACTS_FIXTURE
      })
      const withUa = await fetchUsFinancials('AAPL', { fetchJson: okStub.fn, userAgent: TEST_UA, now: () => FIXED_NOW })
      assert.equal(withUa.ok, true)
      assert.equal(okStub.calls.length, 2)
    } finally {
      if (saved === undefined) delete process.env.DSH_SEC_EDGAR_UA
      else process.env.DSH_SEC_EDGAR_UA = saved
    }
  })

  // 16. companyfacts 失败 / 无目标指标
  await check('fetchUsFinancials：companyfacts 请求失败与空指标都返回 ok:false', async () => {
    const failStub = stubFetch((call) => {
      if (call.url === SEC_TICKERS_URL) return SEC_TICKERS_FIXTURE
      throw new Error('HTTP 404 Not Found')
    })
    const failed = await fetchUsFinancials('AAPL', { fetchJson: failStub.fn, userAgent: TEST_UA, now: () => FIXED_NOW })
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /companyfacts 请求失败/)
    assert.match(failed.error ?? '', /404/)

    const emptyStub = stubFetch((call) => {
      if (call.url === SEC_TICKERS_URL) return SEC_TICKERS_FIXTURE
      return { cik: 320193, entityName: 'Apple Inc.', facts: { 'us-gaap': {} } }
    })
    const empty = await fetchUsFinancials('AAPL', { fetchJson: emptyStub.fn, userAgent: TEST_UA, now: () => FIXED_NOW })
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /没有解析出/)
    assert.equal(empty.name, 'Apple Inc.')
  })

  // 17. 港股代码归一
  await check('normalizeHkCode：5 位补零 / HK 前后缀 / 非法输入', () => {
    assert.equal(normalizeHkCode('00700'), '00700')
    assert.equal(normalizeHkCode('700'), '00700')
    assert.equal(normalizeHkCode('00700.HK'), '00700')
    assert.equal(normalizeHkCode('hk00700'), '00700')
    assert.equal(normalizeHkCode(' HK:700 '), '00700')
    assert.equal(normalizeHkCode('ABC'), null)
    assert.equal(normalizeHkCode(''), null)
    assert.equal(normalizeHkCode('123456'), null)
  })

  // 18. 请求参数契约
  await check('hkMainIndicatorParams / hkOrgProfileParams：filter、排序与 pageSize 契约', () => {
    const main = hkMainIndicatorParams('00700.HK', 6)
    assert.equal(main.reportName, HK_F10_MAIN_INDICATOR_REPORT)
    assert.equal(main.filter, '(SECUCODE="00700.HK")')
    assert.equal(main.sortColumns, 'REPORT_DATE')
    assert.equal(main.sortTypes, -1)
    assert.equal(main.pageSize, 6)
    assert.equal(main.pageNumber, 1)
    assert.equal(hkMainIndicatorParams('00700.HK').pageSize, 8, '默认 pageSize 8')
    assert.equal(hkMainIndicatorParams('00700.HK', 999).pageSize, 50, 'pageSize 上限 50')
    assert.equal(hkMainIndicatorParams('00700.HK', 0).pageSize, 1, 'pageSize 下限 1')

    const profile = hkOrgProfileParams('00700.HK')
    assert.equal(profile.reportName, HK_F10_ORG_PROFILE_REPORT)
    assert.equal(profile.filter, '(SECUCODE="00700.HK")')
    assert.equal(profile.pageSize, 1)
  })

  // 19. 港股规范化：多期 / 币种 / 空值 / 重复期 / 倒序
  await check('normalizeHkMainIndicator：多期倒序、HKD、空值 null、重复期保留首行', () => {
    const parsed = normalizeHkMainIndicator(HK_MAIN_FIXTURE)
    assert.equal(parsed.name, '腾讯控股')
    assert.deepEqual(parsed.currencies, ['HKD'])
    assert.deepEqual(parsed.rows.map((r) => r.reportDate), ['2026-06-30', '2026-03-31', '2025-12-31'])
    const full = parsed.rows[0]!
    assert.equal(full.reportType, '2026年中报')
    assert.equal(full.currency, 'HKD')
    assert.equal(full.revenue, 401243000000)
    assert.equal(full.revenueYoY, 10.0725325491)
    assert.equal(full.netProfit, 114115000000)
    assert.equal(full.netProfitYoY, 10.3103944939)
    assert.equal(full.eps, 12.639)
    assert.equal(full.roe, 9.966353785254)
    assert.equal(full.pe, 13.300875755166)
    assert.equal(full.pb, 2.714393030168)
    assert.equal(full.totalAssets, 2159394000000)
    assert.equal(full.totalLiabilities, 936881000000)
    assert.equal(full.equity, 1135853000000)
    assert.equal(full.operatingCashFlow, 154061000000)
    const emptyRow = parsed.rows[1]!
    for (const key of ['revenue', 'revenueYoY', 'netProfit', 'netProfitYoY', 'eps', 'roe', 'pe', 'pb', 'totalAssets', 'totalLiabilities', 'equity', 'operatingCashFlow'] as const) {
      assert.equal(emptyRow[key], null, `${key} 缺失应为 null，不能是 0`)
    }
    assert.equal(parsed.rows.length, 3, '同一报告期的重复行应去重')
  })

  // 20. 港股上游失败 / 空 data
  await check('normalizeHkMainIndicator：success=false 抛上游 message；空 data → rows []', () => {
    assert.match(thrown(() => normalizeHkMainIndicator(HK_UNKNOWN_FIXTURE)).message, /返回数据为空/)
    assert.match(thrown(() => normalizeHkMainIndicator(null)).message, /不是 JSON 对象/)
    const empty = normalizeHkMainIndicator({ success: true, result: { data: [] } })
    assert.deepEqual(empty.rows, [])
    assert.equal(empty.name, null)
  })

  // 21. 公司资料
  await check('parseHkOrgProfile：公司名/行业/上市日/网址；无资料或同资料全空返回 null', () => {
    const profile = parseHkOrgProfile(HK_PROFILE_FIXTURE)
    assert.ok(profile)
    assert.equal(profile.name, '腾讯控股')
    assert.equal(profile.orgName, '腾讯控股有限公司')
    assert.equal(profile.industry, '软件服务')
    assert.equal(profile.listingDate, '2004-06-16')
    assert.equal(profile.website, 'www.tencent.com')

    const partial = parseHkOrgProfile({ success: true, result: { data: [{ SECURITY_NAME_ABBR: '某公司', BELONG_INDUSTRY: null }] } })
    assert.ok(partial)
    assert.equal(partial.name, '某公司')
    assert.equal(partial.industry, null)
    assert.equal(partial.listingDate, null)
    assert.equal(partial.website, null)

    assert.equal(parseHkOrgProfile({ success: false, result: null, message: '返回数据为空' }), null)
    assert.equal(parseHkOrgProfile({ success: true, result: { data: [] } }), null)
    assert.equal(parseHkOrgProfile({ success: true, result: { data: [{ SECURITY_NAME_ABBR: '', ORG_NAME: '  ' }] } }), null)
  })

  // 22. fetchHkFinancials 成功
  await check('fetchHkFinancials：700.HK → 00700，2 次请求，profile 与 rows 齐全', async () => {
    const stub = stubFetch(hkStubHandler(HK_MAIN_FIXTURE, HK_PROFILE_FIXTURE))
    const res = await fetchHkFinancials('700.HK', { fetchJson: stub.fn, now: () => FIXED_NOW })
    assert.equal(res.ok, true)
    assert.equal(res.market, 'hk')
    assert.equal(res.code, '00700')
    assert.equal(res.name, '腾讯控股')
    assert.equal(res.currency, 'HKD')
    assert.equal(res.source, HK_SOURCE)
    assert.equal(res.fetchedAt, FIXED_ISO)
    assert.equal(res.error, undefined)
    assert.equal(res.rows.length, 3)
    assert.equal(res.rows[0]!.reportDate, '2026-06-30')
    assert.ok(res.profile)
    assert.equal(res.profile.industry, '软件服务')
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0]!.url, EM_HK_F10_URL)
    assert.equal(stub.calls[0]!.params.reportName, HK_F10_MAIN_INDICATOR_REPORT)
    assert.equal(stub.calls[0]!.params.filter, '(SECUCODE="00700.HK")')
    assert.equal(stub.calls[0]!.params.pageSize, 8)
    assert.equal(stub.calls[1]!.params.reportName, HK_F10_ORG_PROFILE_REPORT)
    // 抓取时间不是报告期
    assert.ok(res.rows.every((r) => r.reportDate !== res.fetchedAt.slice(0, 10)))
  })

  // 23. 港股币种不一致
  await check('fetchHkFinancials：各期币种不一致 → currency null + warning，逐行保留原币种', async () => {
    const mixed = JSON.parse(JSON.stringify(HK_MAIN_FIXTURE)) as { result: { data: Array<Record<string, unknown>> } }
    mixed.result.data[2]!.CURRENCY = 'CNY'
    const stub = stubFetch(hkStubHandler(mixed, HK_PROFILE_FIXTURE))
    const res = await fetchHkFinancials('00700', { fetchJson: stub.fn, now: () => FIXED_NOW })
    assert.equal(res.ok, true)
    assert.equal(res.currency, null, '各期币种不一致时不能选一个充当整体币种')
    assert.equal(res.rows[0]!.currency, 'HKD')
    assert.equal(res.rows[2]!.currency, 'CNY')
    assert.equal(res.warnings?.length, 1)
    assert.match(res.warnings?.[0] ?? '', /币种不一致/)
  })

  // 24. 公司资料失败不影响 rows
  await check('fetchHkFinancials：profile 失败 → 仍 ok:true，profile 缺失只进 warnings', async () => {
    const stub = stubFetch(hkStubHandler(HK_MAIN_FIXTURE, new Error('HTTP 500 Internal Server Error')))
    const res = await fetchHkFinancials('00700', { fetchJson: stub.fn, now: () => FIXED_NOW })
    assert.equal(res.ok, true)
    assert.equal(res.rows.length, 3)
    assert.equal(res.profile, undefined)
    assert.equal(res.warnings?.length, 1)
    assert.match(res.warnings?.[0] ?? '', /公司资料请求失败/)
    assert.equal(stub.calls.length, 2)
  })

  // 25. 港股未知 / 空 / 网络失败 / 非法代码 / 不取资料
  await check('fetchHkFinancials：未知代码、空 rows、网络失败、非法代码与 includeProfile=false', async () => {
    const unknownStub = stubFetch(hkStubHandler(HK_UNKNOWN_FIXTURE, HK_PROFILE_FIXTURE))
    const unknown = await fetchHkFinancials('99999', { fetchJson: unknownStub.fn, now: () => FIXED_NOW })
    assert.equal(unknown.ok, false)
    assert.match(unknown.error ?? '', /返回数据为空/)
    assert.equal(unknownStub.calls.length, 1, '上行失败时不应再请求公司资料')

    const emptyStub = stubFetch(hkStubHandler({ success: true, result: { data: [] } }, HK_PROFILE_FIXTURE))
    const empty = await fetchHkFinancials('00700', { fetchJson: emptyStub.fn, now: () => FIXED_NOW })
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /未返回财务期间行/)
    assert.equal(emptyStub.calls.length, 1)

    const netStub = stubFetch(() => {
      throw new Error('ECONNRESET')
    })
    const net = await fetchHkFinancials('00700', { fetchJson: netStub.fn, now: () => FIXED_NOW })
    assert.equal(net.ok, false)
    assert.match(net.error ?? '', /东财港股财务请求失败/)
    assert.match(net.error ?? '', /ECONNRESET/)

    const noFetch = stubFetch(() => {
      throw new Error('不应请求')
    })
    const badCode = await fetchHkFinancials('ABC', { fetchJson: noFetch.fn, now: () => FIXED_NOW })
    assert.equal(badCode.ok, false)
    assert.match(badCode.error ?? '', /代码无效/)
    assert.equal(noFetch.calls.length, 0)

    const onlyMain = stubFetch(hkStubHandler(HK_MAIN_FIXTURE, HK_PROFILE_FIXTURE))
    const noProfile = await fetchHkFinancials('00700', { fetchJson: onlyMain.fn, now: () => FIXED_NOW, includeProfile: false })
    assert.equal(noProfile.ok, true)
    assert.equal(noProfile.profile, undefined)
    assert.equal(onlyMain.calls.length, 1)
  })

  console.log(`\n${checks} global financials checks passed`)
} catch (err) {
  console.error('FAILED', err)
  process.exitCode = 1
}
