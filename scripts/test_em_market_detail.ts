/**
 * 东方财富 A 股资金流 / 公司事件详情模块测试（task-13）。
 *
 * 全部离线：所有 fixture 来自 2026-11-17 实测接口响应（600519 / 300750 /
 * 000001 / 603596），测试里不发起任何网络请求，也不读写 data/ 下的私有数据。
 * 覆盖：真实样本解析、字段顺序求和验证、空数组、缺字段不补 0、负值、排序、
 * 非映射字段丢弃、URL 参数、注入 fetch/json/now、HTTP/JSON/超时失败。
 *
 *   npx tsx scripts/test_em_market_detail.ts
 */
import assert from 'node:assert/strict'
import {
  buildAnnouncementUrl,
  buildDatacenterUrl,
  buildFundFlowUrl,
  createEmMarketDetail,
  EM_DETAIL_UNITS,
  EM_MARKET_DETAIL_PAGES,
  normalizeAShareCode,
  parseAnnouncements,
  parseBlockTrades,
  parseDividends,
  parseFundFlowDaykline,
  parseMarginTrades,
  parsePerformanceExpress,
  parsePerformanceForecast,
} from '../src/data/em-market-detail.js'
import type { EmFetchInit, EmFetchLike, EmHttpResponseLike } from '../src/data/em-market-detail.js'

const NOW_ISO = '2026-11-17T04:27:16.000Z'

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

function throwsWith(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof Error && pattern.test(err.message))
}

function okResponse(value: unknown): EmHttpResponseLike {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(value) }
}

/** 构造带调用记录的注入 fetch；handler 决定 URL 返回什么。 */
function harness(handler: (url: string) => unknown): {
  detail: ReturnType<typeof createEmMarketDetail>
  calls: Array<{ url: string; init?: EmFetchInit }>
} {
  const calls: Array<{ url: string; init?: EmFetchInit }> = []
  const fetch: EmFetchLike = async (url, init) => {
    calls.push({ url, init })
    return okResponse(handler(url))
  }
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  return { detail, calls }
}

/** 按 URL 关键字路由 fixture；未命中返回失败标记（NaN JSON 会变成 null，不影响）。 */
function route(routes: Array<[string, unknown]>, fallback: unknown = {}) {
  return (url: string): unknown => {
    for (const [needle, value] of routes) if (url.includes(needle)) return value
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 实测 fixture（2026-11-17 抓取，字段原样保留；仅删除测试用不到的字段）
// ---------------------------------------------------------------------------

const FUND_FLOW_RAW = {
  rc: 0,
  data: {
    code: '600519',
    name: '贵州茅台',
    market: 1,
    // 日期,主力净额,小单净额,中单净额,大单净额,超大单净额,主力%,小单%,中单%,大单%,超大单%,收盘,涨跌幅,f64,f65
    klines: [
      '2026-11-12,-322878512.0,-238916.0,323117424.0,-328114464.0,5235952.0,-7.12,-0.01,7.12,-7.23,0.12,1410.27,0.57,0.00,0.00',
      '2026-11-13,289962976.0,-350064.0,-289612896.0,107835616.0,182127360.0,4.87,-0.01,-4.86,1.81,3.06,1435.26,1.77,0.00,0.00',
      '2026-11-16,516422832.0,-432417.0,-515990416.0,696086464.0,-179663632.0,8.95,-0.01,-8.95,12.07,-3.12,1453.90,1.30,0.00,0.00',
    ],
  },
}

const ANNOUNCEMENTS_RAW = {
  success: 1,
  error: '',
  data: {
    // 故意乱序：解析后必须按 noticeDate 倒序。
    list: [
      {
        art_code: 'AN202610301831245502',
        codes: [{ stock_code: '600519', short_name: '贵州茅台', market_code: '1', ann_type: 'A,SHA' }],
        columns: [{ column_code: '001002004013', column_name: '月度经营情况' }],
        notice_date: '2026-10-31 00:00:00',
        display_time: '2026-10-30 18:31:37:307',
        eiTime: '2026-10-30 18:32:49:000',
        source_type: '31',
        title: '贵州茅台:贵州茅台2026年第三季度主要经营数据公告',
      },
      {
        art_code: 'AN202611021831320924',
        codes: [{ stock_code: '600519', short_name: '贵州茅台', market_code: '1', ann_type: 'A,SHA' }],
        columns: [{ column_code: '001002008', column_name: '其他' }],
        notice_date: '2026-11-03 00:00:00',
        display_time: '2026-11-02 16:59:12:344',
        eiTime: '2026-11-02 17:00:13:000',
        source_type: '31',
        title: '贵州茅台:贵州茅台关于召开2026年第三季度业绩说明会的公告',
      },
    ],
    page_index: 1,
    page_size: 2,
    total_hits: 1079,
  },
}

const DIVIDEND_RAW = {
  success: true,
  code: 0,
  message: 'ok',
  result: {
    pages: 1,
    count: 2,
    data: [
      {
        SECUCODE: '600519.SH',
        SECURITY_CODE: '600519',
        BONUS_IT_RATIO: null,
        BONUS_RATIO: null,
        IT_RATIO: null,
        PRETAX_BONUS_RMB: 280.2423,
        PLAN_NOTICE_DATE: '2026-04-17 00:00:00',
        EQUITY_RECORD_DATE: '2026-06-25 00:00:00',
        EX_DIVIDEND_DATE: '2026-06-26 00:00:00',
        REPORT_DATE: '2025-12-31 00:00:00',
        ASSIGN_PROGRESS: '实施分配',
        IMPL_PLAN_PROFILE: '10派280.2423元(含税)',
        NOTICE_DATE: '2026-06-22 00:00:00',
        DIVIDENT_RATIO: 0.023120394357,
        // 非映射字段：不得出现在规范化行里。
        BASIC_EPS: 65.66,
        EX_DIVIDEND_DAYS: 144,
      },
      {
        SECUCODE: '603596.SH',
        SECURITY_CODE: '603596',
        BONUS_IT_RATIO: 4.2,
        BONUS_RATIO: null,
        IT_RATIO: 4.2,
        PRETAX_BONUS_RMB: null,
        PLAN_NOTICE_DATE: '2026-08-28 00:00:00',
        EQUITY_RECORD_DATE: '2026-11-09 00:00:00',
        EX_DIVIDEND_DATE: '2026-11-10 00:00:00',
        REPORT_DATE: '2026-06-30 00:00:00',
        ASSIGN_PROGRESS: '实施分配',
        IMPL_PLAN_PROFILE: '10转4.20股',
        NOTICE_DATE: '2026-11-04 00:00:00',
        DIVIDENT_RATIO: null,
      },
    ],
  },
}

const FORECAST_RAW = {
  success: true,
  code: 0,
  message: 'ok',
  result: {
    pages: 1,
    count: 33,
    data: [
      {
        SECURITY_CODE: '300750',
        NOTICE_DATE: '2025-01-21 00:00:00',
        REPORT_DATE: '2024-12-31 00:00:00',
        PREDICT_FINANCE: '营业收入',
        PREDICT_AMT_LOWER: 356000000000,
        PREDICT_AMT_UPPER: 366000000000,
        ADD_AMP_LOWER: -11.2,
        ADD_AMP_UPPER: -8.71,
        PREDICT_CONTENT: '预计2024年1-12月营业收入:35,600,000万元至36,600,000万元,同比上年下降:8.71%至11.2%。',
        CHANGE_REASON_EXPLAIN: '碳酸锂等原材料价格下降，公司产品价格相应调整。',
        PREDICT_TYPE: '略减',
        PREYEAR_SAME_PERIOD: 400917044900,
        IS_LATEST: 'T',
        FORECAST_STATE: 'reduction',
        // 口径不明的字段：不映射，避免把「另一个比例」当同比。
        PREDICT_RATIO_LOWER: 5.068749115105,
        PREDICT_RATIO_UPPER: 15.905578274065,
      },
      {
        SECURITY_CODE: '300750',
        NOTICE_DATE: '2025-01-21 00:00:00',
        REPORT_DATE: '2024-12-31 00:00:00',
        PREDICT_FINANCE: '归属于上市公司股东的净利润',
        PREDICT_AMT_LOWER: 49000000000,
        PREDICT_AMT_UPPER: 53000000000,
        ADD_AMP_LOWER: 11.06,
        ADD_AMP_UPPER: 20.12,
        PREDICT_TYPE: '略增',
        PREYEAR_SAME_PERIOD: 44121248300,
        IS_LATEST: 'T',
        FORECAST_STATE: 'increase',
      },
    ],
  },
}

const EXPRESS_RAW = {
  success: true,
  code: 0,
  message: 'ok',
  result: {
    pages: 1,
    count: 4,
    data: [
      {
        SECURITY_CODE: '000001',
        REPORT_DATE: '2022-12-31 00:00:00',
        NOTICE_DATE: '2023-01-17 00:00:00',
        UPDATE_DATE: '2023-01-17 00:00:00',
        TOTAL_OPERATE_INCOME: 179895000000,
        YSTZ: 6.206053736207,
        PARENT_NETPROFIT: 45516000000,
        JLRTBZCL: 25.264200792602,
        BASIC_EPS: 2.2,
        PARENT_BVPS: 18.8,
        WEIGHTAVG_ROE: 12.36,
        DATATYPE: '2022年 年报',
        QDATE: '2022Q4',
        // 非映射字段。
        DJDYSHZ: -9.975563869126,
      },
      {
        SECURITY_CODE: '000001',
        REPORT_DATE: '2020-12-31 00:00:00',
        NOTICE_DATE: '2022-01-14 00:00:00',
        UPDATE_DATE: '2022-01-14 00:00:00',
        TOTAL_OPERATE_INCOME: 153542000000,
        YSTZ: 11.296191594543,
        PARENT_NETPROFIT: 28928000000,
        JLRTBZCL: 2.59975172903,
        BASIC_EPS: 1.4,
        PARENT_BVPS: 15.16,
        WEIGHTAVG_ROE: 9.58,
        DATATYPE: '2020年 年报',
        QDATE: '2020Q4',
      },
    ],
  },
}

const BLOCK_RAW = {
  success: true,
  code: 0,
  message: 'ok',
  result: {
    pages: 1,
    count: 3,
    data: [
      {
        SECURITY_CODE: '600519',
        TRADE_DATE: '2026-11-04 00:00:00',
        DEAL_PRICE: 1446.44,
        PREMIUM_RATIO: 0,
        DEAL_VOLUME: 2000,
        DEAL_AMT: 2892900,
        BUYER_NAME: '广发证券股份有限公司慈溪浒山路证券营业部',
        SELLER_NAME: '中国国际金融股份有限公司北京建国门外大街证券营业部',
        CLOSE_PRICE: 1446.44,
        CHANGE_RATE: -2.2676,
        TURNOVER_RATE: 0.000159990662,
      },
      {
        SECURITY_CODE: '600519',
        TRADE_DATE: '2026-11-12 00:00:00',
        DEAL_PRICE: 1410.27,
        PREMIUM_RATIO: 0,
        DEAL_VOLUME: 16900,
        DEAL_AMT: 23830700,
        BUYER_NAME: '机构专用',
        SELLER_NAME: '机构专用',
        CLOSE_PRICE: 1410.27,
        CHANGE_RATE: 0.5684,
        TURNOVER_RATE: 0.001351749348,
        TRADE_UNIT: '4',
      },
      {
        SECURITY_CODE: '600519',
        TRADE_DATE: '2026-11-10 00:00:00',
        DEAL_PRICE: 1313,
        PREMIUM_RATIO: -0.087560806115,
        DEAL_VOLUME: 1600,
        DEAL_AMT: 2100800,
        BUYER_NAME: '广发证券股份有限公司佛山禅城石湾证券营业部',
        SELLER_NAME: '广发证券股份有限公司佛山禅城石湾证券营业部',
        CLOSE_PRICE: 1439,
        CHANGE_RATE: -0.4145,
        TURNOVER_RATE: 0.000116784593,
      },
    ],
  },
}

const MARGIN_RAW = {
  success: true,
  code: 0,
  message: 'ok',
  result: {
    pages: 1,
    count: 2,
    data: [
      {
        DATE: '2026-11-13 00:00:00',
        SCODE: '600519',
        RZYE: 15058351439,
        RQYL: 221350,
        RZRQYE: 15376046240,
        RQYE: 317694801,
        RQMCL: 10400,
        RZMRE: 363428328,
        RZCHE: 519622701,
        RZJME: -156194373,
        RZYEZB: 0.83928311,
        SPJ: 1435.26,
        ZDF: 1.772,
      },
      {
        DATE: '2026-11-16 00:00:00',
        SCODE: '600519',
        RZYE: 14788586340,
        RQYL: 221550,
        RZRQYE: 15110697885,
        RQYE: 322111545,
        RQMCL: 2900,
        RZMRE: 272139009,
        RZCHE: 541904108,
        RZJME: -269765099,
        RZYEZB: 0.81368023,
        SPJ: 1453.9,
        ZDF: 1.2987,
        KCB: 0,
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// 基础：代码归一、URL、单位
// ---------------------------------------------------------------------------

await check('代码归一接受 SH600519 / 600519.SH / 600519，拒绝非法格式', () => {
  assert.equal(normalizeAShareCode('600519'), '600519')
  assert.equal(normalizeAShareCode('SH600519'), '600519')
  assert.equal(normalizeAShareCode('600519.SH'), '600519')
  assert.equal(normalizeAShareCode('000001.SZ'), '000001')
  assert.equal(normalizeAShareCode(' 600519 '), '600519')
  for (const bad of ['', '60051', '6005190', 'AAPL', '6005190.SH', 'HK00700']) {
    assert.equal(normalizeAShareCode(bad), null, `应拒绝 ${bad}`)
  }
})

await check('资金流 URL 带 ut/fields/secid 且 days 被夹在 1-250', () => {
  const u = new URL(buildFundFlowUrl('600519', 5))
  assert.equal(u.origin + u.pathname, 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get')
  assert.equal(u.searchParams.get('lmt'), '5')
  assert.equal(u.searchParams.get('klt'), '101')
  assert.equal(u.searchParams.get('secid'), '1.600519')
  assert.equal(u.searchParams.get('ut'), 'b2884a393a59ad64002292a3e90d46a5')
  assert.match(u.searchParams.get('fields2') ?? '', /^f51,f52,.*f65$/)
  assert.equal(new URL(buildFundFlowUrl('000001', 0)).searchParams.get('lmt'), '1')
  assert.equal(new URL(buildFundFlowUrl('000001', 9999)).searchParams.get('lmt'), '250')
  // 深市 secid 必须是 0.000001，不能按首字符 0 当沪市。
  assert.equal(new URL(buildFundFlowUrl('000001')).searchParams.get('secid'), '0.000001')
})

await check('公告 URL 参数齐全，page/pageSize 有边界', () => {
  const u = new URL(buildAnnouncementUrl('600519', 2, 50))
  assert.equal(u.searchParams.get('sr'), '-1')
  assert.equal(u.searchParams.get('page_index'), '2')
  assert.equal(u.searchParams.get('page_size'), '50')
  assert.equal(u.searchParams.get('ann_type'), 'A')
  assert.equal(u.searchParams.get('stock_list'), '600519')
  assert.equal(new URL(buildAnnouncementUrl('600519', 0, 0)).searchParams.get('page_size'), '1')
  assert.equal(new URL(buildAnnouncementUrl('600519', 0, 9999)).searchParams.get('page_size'), '100')
})

await check('数据中心 URL 对 filter/reportName/sort 编码正确并拒绝字段注入', () => {
  const u = new URL(buildDatacenterUrl({
    reportName: 'RPT_SHAREBONUS_DET',
    code: '600519',
    sortColumns: 'NOTICE_DATE',
    page: 1,
    pageSize: 2,
  }))
  assert.equal(u.searchParams.get('reportName'), 'RPT_SHAREBONUS_DET')
  assert.equal(u.searchParams.get('filter'), '(SECURITY_CODE="600519")')
  assert.equal(u.searchParams.get('sortColumns'), 'NOTICE_DATE')
  assert.equal(u.searchParams.get('sortTypes'), '-1')
  assert.equal(u.searchParams.get('columns'), 'ALL')
  const margin = new URL(buildDatacenterUrl({
    reportName: 'RPTA_WEB_RZRQ_GGMX',
    filterField: 'SCODE',
    code: '600519',
    sortColumns: 'DATE',
  }))
  assert.equal(margin.searchParams.get('filter'), '(SCODE="600519")')
  throwsWith(() => buildDatacenterUrl({
    reportName: 'X', code: '600519', filterField: 'SCODE") OR ("1', sortColumns: 'DATE',
  }), /非法过滤字段/)
  throwsWith(() => buildDatacenterUrl({ reportName: 'X', code: 'AAPL', sortColumns: 'DATE' }), /不是合法的 6 位 A 股代码/)
})

await check('详情页 URL 只使用合法 6 位代码，不拼假地址', () => {
  assert.equal(EM_MARKET_DETAIL_PAGES.dividend('600519'), 'https://data.eastmoney.com/yjfp/detail/600519.html')
  assert.equal(EM_MARKET_DETAIL_PAGES.blockTrade('600519'), 'https://data.eastmoney.com/dzjy/detail/600519.html')
  assert.match(EM_DETAIL_UNITS.fundFlow, /CNY/)
  assert.match(EM_DETAIL_UNITS.blockTrades, /小数/)
})

// ---------------------------------------------------------------------------
// 资金流
// ---------------------------------------------------------------------------

await check('资金流真实样本：3 日升序、字段与求和关系正确', () => {
  const parsed = parseFundFlowDaykline(FUND_FLOW_RAW)
  assert.equal(parsed.rows.length, 3)
  assert.deepEqual(parsed.rows.map((r) => r.date), ['2026-11-12', '2026-11-13', '2026-11-16'])
  assert.equal(parsed.asOf, '2026-11-16')
  const latest = parsed.rows[2]!
  assert.equal(latest.mainNet, 516422832)
  assert.equal(latest.smallNet, -432417)
  assert.equal(latest.mediumNet, -515990416)
  assert.equal(latest.largeNet, 696086464)
  assert.equal(latest.extraLargeNet, -179663632)
  assert.equal(latest.mainPct, 8.95)
  assert.equal(latest.close, 1453.9)
  assert.equal(latest.changePct, 1.3)
  // 用户点名的列序验证：主力 = 大单 + 超大单。
  assert.equal(latest.mainNet, latest.largeNet! + latest.extraLargeNet!)
  assert.equal(latest.mainPct, Number((latest.largePct! + latest.extraLargePct!).toFixed(2)))
  assert.deepEqual(parsed.warnings, [])
})

await check('资金流负值原样保留，不被当缺失或改写', () => {
  const first = parseFundFlowDaykline(FUND_FLOW_RAW).rows[0]!
  assert.equal(first.mainNet, -322878512)
  assert.equal(first.largeNet, -328114464)
  assert.equal(first.changePct, 0.57)
})

await check('资金流乱序输入按日期升序，缺数值置 null 并告警（不补 0）', () => {
  const raw = {
    rc: 0,
    data: {
      klines: [
        FUND_FLOW_RAW.data.klines[2],
        '2026-11-17,,--,323117424.0,-328114464.0,5235952.0,-7.12,-0.01,7.12,-7.23,0.12,1410.27,0.57,0,0',
        FUND_FLOW_RAW.data.klines[1],
        FUND_FLOW_RAW.data.klines[0],
      ],
    },
  }
  const parsed = parseFundFlowDaykline(raw)
  assert.deepEqual(parsed.rows.map((r) => r.date), ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'])
  const missing = parsed.rows.at(-1)!
  assert.equal(missing.mainNet, null)
  assert.equal(missing.smallNet, null)
  assert.notEqual(missing.mainNet, 0)
  assert.ok(parsed.warnings.some((w) => w.includes('不补 0')))
})

await check('资金流非法日期跳过并告警，不影响有效行', () => {
  const raw = { rc: 0, data: { klines: ['2026-13-40,1,2,3,4,5,6,7,8,9,10,11,12,0,0', FUND_FLOW_RAW.data.klines[2]] } }
  const parsed = parseFundFlowDaykline(raw)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0]!.date, '2026-11-16')
  assert.ok(parsed.warnings.some((w) => w.includes('日期非法')))
})

await check('资金流重复交易日按出现顺序保留最后一条并告警', () => {
  const raw = {
    rc: 0,
    data: { klines: [FUND_FLOW_RAW.data.klines[2], FUND_FLOW_RAW.data.klines[2].replace('516422832.0', '1.0')] },
  }
  const parsed = parseFundFlowDaykline(raw)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0]!.mainNet, 1)
  assert.ok(parsed.warnings.some((w) => w.includes('重复交易日')))
})

await check('资金流忽略 f64/f65 与第 16 列等非映射字段', () => {
  const row = '2026-11-16,516422832.0,-432417.0,-515990416.0,696086464.0,-179663632.0,8.95,-0.01,-8.95,12.07,-3.12,1453.90,1.30,999,888,777'
  const parsed = parseFundFlowDaykline({ rc: 0, data: { klines: [row] } })
  const r = parsed.rows[0] as unknown as Record<string, unknown>
  assert.equal(r.f64, undefined)
  assert.equal(r.f65, undefined)
  assert.equal(Object.keys(r).length, 13)
  assert.equal(r.mainNet, 516422832)
})

await check('资金流空 klines 是空结果（ok 与失败区分由包装层做）', () => {
  const parsed = parseFundFlowDaykline({ rc: 0, data: { klines: [] } })
  assert.deepEqual(parsed.rows, [])
  assert.equal(parsed.asOf, undefined)
  assert.deepEqual(parsed.warnings, [])
})

await check('资金流上游 rc!=0 / data=null 明确抛错，不伪造空数据', () => {
  throwsWith(() => parseFundFlowDaykline({ rc: 100, dsc: '0', data: null }), /rc=100/)
  throwsWith(() => parseFundFlowDaykline({ rc: 0, data: null }), /无 data/)
  throwsWith(() => parseFundFlowDaykline({ rc: 0, data: { klines: null } }), /klines 缺失/)
  throwsWith(() => parseFundFlowDaykline({ rc: 0, data: { klines: 'x' } }), /不是数组/)
})

await check('资金流包装层：注入 now/fetch，source/asOf/unit/currency 完整', async () => {
  const { detail, calls } = harness(() => FUND_FLOW_RAW)
  const res = await detail.getFundFlow('600519', { days: 3 })
  assert.equal(res.ok, true)
  assert.equal(res.count, 3)
  assert.equal(res.asOf, '2026-11-16')
  assert.equal(res.currency, 'CNY')
  assert.match(res.unit, /CNY/)
  assert.equal(res.fetchedAt, NOW_ISO)
  assert.match(res.source, /secid=1\.600519/)
  assert.match(res.source, /lmt=3/)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.init?.headers?.['User-Agent'] ?? '', /Mozilla/)
  assert.equal(calls[0]!.init?.headers?.Referer, 'https://quote.eastmoney.com/')
})

// ---------------------------------------------------------------------------
// 公告
// ---------------------------------------------------------------------------

await check('公告真实样本：倒序、日期/展示时间分列、栏目与详情链接', () => {
  const parsed = parseAnnouncements(ANNOUNCEMENTS_RAW, { code: '600519' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0]!.id, 'AN202611021831320924')
  assert.equal(parsed.rows[1]!.id, 'AN202610301831245502')
  assert.equal(parsed.rows[0]!.noticeDate, '2026-11-03')
  assert.equal(parsed.rows[0]!.displayTime, '2026-11-02 16:59:12')
  assert.deepEqual(parsed.rows[0]!.categories, ['其他'])
  assert.equal(parsed.rows[0]!.stockCode, '600519')
  assert.equal(parsed.rows[0]!.stockName, '贵州茅台')
  assert.equal(
    parsed.rows[0]!.sourceUrl,
    'https://data.eastmoney.com/notices/detail/600519/AN202611021831320924.html',
  )
  assert.equal(parsed.asOf, '2026-11-03')
  assert.equal(parsed.total, 1079)
  assert.equal(parsed.page, 1)
  assert.equal(parsed.pageSize, 2)
  assert.deepEqual(parsed.warnings, [])
})

await check('公告缺标题/art_code 跳过并告警，缺失 stock_code 用调用参数补详情链接', () => {
  const raw = {
    success: 1,
    data: {
      list: [
        { art_code: '', title: '无编号' },
        { art_code: 'AN1', title: '' },
        { art_code: 'AN2', title: '有效公告', notice_date: '2026-11-01 00:00:00' },
      ],
      page_index: 1,
      page_size: 10,
      total_hits: 3,
    },
  }
  const parsed = parseAnnouncements(raw, { code: '600519' })
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0]!.sourceUrl, 'https://data.eastmoney.com/notices/detail/600519/AN2.html')
  assert.ok(parsed.warnings.some((w) => w.includes('跳过 2 条')))
})

await check('公告空数组是 ok-empty，不是错误；success=0 才是错误', () => {
  const empty = parseAnnouncements({ success: 1, data: { list: [], page_index: 1, page_size: 10, total_hits: 0 } })
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.asOf, undefined)
  throwsWith(() => parseAnnouncements({ success: 0, error: 'blocked', data: null }), /公告接口失败：blocked/)
})

await check('公告包装层：page/pageSize 传入 URL，空结果 ok=true 且无 error', async () => {
  const emptyRaw = { success: 1, data: { list: [], page_index: 2, page_size: 5, total_hits: 0 } }
  const { detail, calls } = harness(() => emptyRaw)
  const res = await detail.getAnnouncements('600519', { page: 2, pageSize: 5 })
  assert.equal(res.ok, true)
  assert.equal(res.rows.length, 0)
  assert.equal(res.error, undefined)
  assert.match(res.source, /page_index=2/)
  assert.match(res.source, /page_size=5/)
  assert.match(calls[0]!.url, /stock_list=600519/)
})

// ---------------------------------------------------------------------------
// 分红送配
// ---------------------------------------------------------------------------

await check('分红真实样本：每 10 股派息/进度/股息率/除权日与 sourceUrl', () => {
  const parsed = parseDividends(DIVIDEND_RAW, { code: '600519' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.asOf, '2026-11-04')
  // 2026-11-04 的伯特利排在 2026-06-22 的茅台之前。
  assert.equal(parsed.rows[0]!.reportDate, '2026-06-30')
  assert.equal(parsed.rows[0]!.conversionSharesPer10, 4.2)
  assert.equal(parsed.rows[0]!.totalBonusConversionPer10, 4.2)
  assert.equal(parsed.rows[0]!.bonusPer10SharesPretax, undefined)
  assert.equal(parsed.rows[0]!.sourceUrl, 'https://data.eastmoney.com/yjfp/detail/603596.html')
  const moutai = parsed.rows[1]!
  assert.equal(moutai.noticeDate, '2026-06-22')
  assert.equal(moutai.planNoticeDate, '2026-04-17')
  assert.equal(moutai.exDividendDate, '2026-06-26')
  assert.equal(moutai.equityRecordDate, '2026-06-25')
  assert.equal(moutai.progress, '实施分配')
  assert.equal(moutai.bonusPer10SharesPretax, 280.2423)
  assert.equal(moutai.dividendYieldRatio, 0.023120394357)
  assert.equal(moutai.sourceUrl, 'https://data.eastmoney.com/yjfp/detail/600519.html')
  assert.equal((moutai as unknown as Record<string, unknown>).BASIC_EPS, undefined)
  assert.equal(parsed.total, 2)
})

await check('分红缺派息字段保持 undefined，不补 0；非法报告期行跳过', () => {
  const parsed = parseDividends({
    success: true,
    result: {
      count: 2,
      data: [
        { SECURITY_CODE: '600519', REPORT_DATE: '2026-06-30', NOTICE_DATE: '2026-07-01', IMPL_PLAN_PROFILE: '不分配' },
        { SECURITY_CODE: '600519', REPORT_DATE: '2026-02-31', NOTICE_DATE: '2026-02-31 00:00:00' },
      ],
    },
  }, { code: '600519' })
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0]!.bonusPer10SharesPretax, undefined)
  assert.equal(parsed.rows[0]!.dividendYieldRatio, undefined)
  assert.ok(parsed.warnings.some((w) => w.includes('跳过 1 条')))
})

await check('分红包装层：reportName/filter/sort 正确，空 data 时 ok=true 且 rows=[]', async () => {
  const emptyRaw = { success: true, code: 0, result: { pages: 0, count: 0, data: [] } }
  const { detail, calls } = harness(() => emptyRaw)
  const res = await detail.getDividends('600519', { page: 1, pageSize: 3 })
  assert.equal(res.ok, true)
  assert.equal(res.count, 0)
  assert.equal(res.error, undefined)
  const u = new URL(calls[0]!.url)
  assert.equal(u.searchParams.get('reportName'), 'RPT_SHAREBONUS_DET')
  assert.equal(u.searchParams.get('filter'), '(SECURITY_CODE="600519")')
  assert.equal(u.searchParams.get('sortColumns'), 'NOTICE_DATE')
  assert.equal(u.searchParams.get('pageSize'), '3')
})

await check('数据中心 success=false 原样带出上游 message，不返回空成功', async () => {
  const { detail } = harness(() => ({ success: false, code: 9501, message: 'NOTICE_DATE排序列不存在', result: null }))
  const res = await detail.getDividends('600519')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /NOTICE_DATE排序列不存在/)
  assert.match(res.error ?? '', /code=9501/)
  assert.deepEqual(res.rows, [])
})

// ---------------------------------------------------------------------------
// 业绩预告 / 快报
// ---------------------------------------------------------------------------

await check('业绩预告真实样本：指标/金额区间/同比/最新标记与口径不明字段丢弃', () => {
  const parsed = parsePerformanceForecast(FORECAST_RAW, { code: '300750' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.asOf, '2025-01-21')
  const revenue = parsed.rows[0]!
  assert.equal(revenue.kind, 'forecast')
  assert.equal(revenue.reportDate, '2024-12-31')
  assert.equal(revenue.noticeDate, '2025-01-21')
  assert.equal(revenue.indicator, '营业收入')
  assert.equal(revenue.forecastType, '略减')
  assert.equal(revenue.amountLower, 356000000000)
  assert.equal(revenue.amountUpper, 366000000000)
  assert.equal(revenue.yoyLowerPct, -11.2)
  assert.equal(revenue.yoyUpperPct, -8.71)
  assert.equal(revenue.isLatest, true)
  assert.equal(revenue.state, 'reduction')
  assert.equal(revenue.sourceUrl, 'https://data.eastmoney.com/bbsj/yjyg/300750.html')
  assert.equal((revenue as unknown as Record<string, unknown>).PREDICT_RATIO_LOWER, undefined)
  assert.equal(parsed.total, 33)
})

await check('业绩预告无报告期行跳过；空 data 返回空', () => {
  const parsed = parsePerformanceForecast({
    success: true,
    result: { data: [{ SECURITY_CODE: '300750', NOTICE_DATE: '2025-01-01' }] },
  }, { code: '300750' })
  assert.equal(parsed.rows.length, 0)
  assert.ok(parsed.warnings.some((w) => w.includes('跳过 1 条')))
  const empty = parsePerformanceForecast({ success: true, result: { data: [] } })
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.asOf, undefined)
})

await check('业绩快报真实样本：营收/净利/同比/EPS/ROE 规范化', () => {
  const parsed = parsePerformanceExpress(EXPRESS_RAW, { code: '000001' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.asOf, '2023-01-17')
  const latest = parsed.rows[0]!
  assert.equal(latest.kind, 'express')
  assert.equal(latest.reportDate, '2022-12-31')
  assert.equal(latest.noticeDate, '2023-01-17')
  assert.equal(latest.updateDate, '2023-01-17')
  assert.equal(latest.periodLabel, '2022年 年报')
  assert.equal(latest.revenue, 179895000000)
  assert.equal(latest.revenueYoY, 6.206053736207)
  assert.equal(latest.netProfit, 45516000000)
  assert.equal(latest.netProfitYoY, 25.264200792602)
  assert.equal(latest.eps, 2.2)
  assert.equal(latest.bps, 18.8)
  assert.equal(latest.roeWeighted, 12.36)
  assert.equal(latest.sourceUrl, 'https://data.eastmoney.com/bbsj/yjkb/000001.html')
})

await check('业绩合并（all）：预告+快报按公告日倒序，partial=false', async () => {
  const { detail, calls } = harness(route([
    ['RPT_PUBLIC_OP_NEWPREDICT', FORECAST_RAW],
    ['RPT_FCI_PERFORMANCEE', EXPRESS_RAW],
  ]))
  const res = await detail.getPerformance('600519')
  assert.equal(res.ok, true)
  assert.equal(res.count, 4)
  assert.equal(res.partial, undefined)
  assert.match(res.source, /RPT_PUBLIC_OP_NEWPREDICT/)
  assert.match(res.source, /RPT_FCI_PERFORMANCEE/)
  assert.equal(res.total, 37)
  assert.equal(calls.length, 2)
  assert.deepEqual(res.rows.map((r) => r.kind), ['forecast', 'forecast', 'express', 'express'])
  assert.equal(res.rows[0]!.noticeDate, '2025-01-21')
})

await check('业绩单边失败：保留可用来源，ok=true + partial=true + 告警', async () => {
  const fetch: EmFetchLike = async (url, init) => {
    if (url.includes('RPT_PUBLIC_OP_NEWPREDICT')) throw new Error('预告源 503')
    return okResponse(EXPRESS_RAW)
  }
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  const res = await detail.getPerformance('600519')
  assert.equal(res.ok, true)
  assert.equal(res.count, 2)
  assert.equal(res.partial, true)
  assert.ok(res.warnings?.some((w) => w.includes('业绩预告抓取失败')))
  assert.equal(res.rows.every((r) => r.kind === 'express'), true)
})

await check('业绩双边失败：ok=false + 两个来源错误都带出', async () => {
  const fetch: EmFetchLike = async () => { throw new Error('网络不可用') }
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  const res = await detail.getPerformance('600519')
  assert.equal(res.ok, false)
  assert.equal(res.count, 0)
  assert.match(res.error ?? '', /预告与快报均失败/)
  assert.match(res.error ?? '', /网络不可用/)
})

await check('业绩 kind=forecast 只请求预告接口', async () => {
  const { detail, calls } = harness(route([['RPT_PUBLIC_OP_NEWPREDICT', FORECAST_RAW]]))
  const res = await detail.getPerformance('300750', { kind: 'forecast' })
  assert.equal(res.ok, true)
  assert.equal(res.count, 2)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.url, /RPT_PUBLIC_OP_NEWPREDICT/)
})

// ---------------------------------------------------------------------------
// 大宗交易
// ---------------------------------------------------------------------------

await check('大宗交易真实样本：溢价率小数、折价负值、买卖席位与排序', () => {
  const parsed = parseBlockTrades(BLOCK_RAW, { code: '600519' })
  assert.equal(parsed.rows.length, 3)
  assert.equal(parsed.asOf, '2026-11-12')
  assert.deepEqual(parsed.rows.map((r) => r.tradeDate), ['2026-11-12', '2026-11-10', '2026-11-04'])
  const latest = parsed.rows[0]!
  assert.equal(latest.dealPrice, 1410.27)
  assert.equal(latest.premiumRatio, 0)
  assert.equal(latest.dealVolume, 16900)
  assert.equal(latest.dealAmount, 23830700)
  assert.equal(latest.buyer, '机构专用')
  assert.equal(latest.seller, '机构专用')
  assert.equal(latest.closePrice, 1410.27)
  assert.equal(latest.changePct, 0.5684)
  assert.equal(latest.turnoverPct, 0.001351749348)
  assert.equal(latest.sourceUrl, 'https://data.eastmoney.com/dzjy/detail/600519.html')
  // 2026-11-10 折价 8.76%：上游 -0.08756 是小数比率，必须原样保留，不能当 -0.09%。
  assert.equal(parsed.rows[1]!.premiumRatio, -0.087560806115)
  assert.equal((latest as unknown as Record<string, unknown>).TRADE_UNIT, undefined)
})

await check('大宗交易无交易日行跳过并告警；空 data 为空结果', () => {
  const parsed = parseBlockTrades({
    success: true,
    result: { data: [{ SECURITY_CODE: '600519', DEAL_PRICE: 1400 }] },
  }, { code: '600519' })
  assert.equal(parsed.rows.length, 0)
  assert.ok(parsed.warnings.some((w) => w.includes('跳过 1 条')))
  assert.deepEqual(parseBlockTrades({ success: true, result: { data: [] } }).rows, [])
})

await check('大宗交易包装层：sortColumns=TRADE_DATE 且 source/asOf 正确', async () => {
  const { detail, calls } = harness(() => BLOCK_RAW)
  const res = await detail.getBlockTrades('600519', { page: 1, pageSize: 20 })
  assert.equal(res.ok, true)
  assert.equal(res.asOf, '2026-11-12')
  assert.equal(new URL(calls[0]!.url).searchParams.get('sortColumns'), 'TRADE_DATE')
  assert.equal(new URL(calls[0]!.url).searchParams.get('reportName'), 'RPT_DATA_BLOCKTRADE')
})

// ---------------------------------------------------------------------------
// 融资融券
// ---------------------------------------------------------------------------

await check('融资融券真实样本：两融合计/融资净买入闭合，字段规范化', () => {
  const parsed = parseMarginTrades(MARGIN_RAW, { code: '600519' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.asOf, '2026-11-16')
  const latest = parsed.rows[0]!
  assert.equal(latest.tradeDate, '2026-11-16')
  assert.equal(latest.financingBalance, 14788586340)
  assert.equal(latest.securitiesBalance, 322111545)
  assert.equal(latest.totalBalance, 15110697885)
  assert.equal(latest.totalBalance, latest.financingBalance! + latest.securitiesBalance!)
  assert.equal(latest.financingBuy, 272139009)
  assert.equal(latest.financingRepay, 541904108)
  assert.equal(latest.financingNetBuy, -269765099)
  assert.equal(latest.financingNetBuy, latest.financingBuy! - latest.financingRepay!)
  assert.equal(latest.financingBalanceToFloatCapPct, 0.81368023)
  assert.equal(latest.securitiesVolume, 221550)
  assert.equal(latest.securitiesSellVolume, 2900)
  assert.equal(latest.closePrice, 1453.9)
  assert.equal(latest.changePct, 1.2987)
  assert.equal(latest.sourceUrl, 'https://data.eastmoney.com/rzrq/detail/600519.html')
  assert.equal((latest as unknown as Record<string, unknown>).KCB, undefined)
})

await check('融资融券无日期行跳过并告警；空 data 为空结果', () => {
  const parsed = parseMarginTrades({
    success: true,
    result: { data: [{ SCODE: '600519', RZYE: 1 }] },
  }, { code: '600519' })
  assert.equal(parsed.rows.length, 0)
  assert.ok(parsed.warnings.some((w) => w.includes('跳过 1 条')))
  assert.deepEqual(parseMarginTrades({ success: true, result: { data: [] } }).rows, [])
})

await check('融资融券包装层：filter 用 SCODE、sort=DATE', async () => {
  const { detail, calls } = harness(() => MARGIN_RAW)
  const res = await detail.getMarginTrades('600519')
  assert.equal(res.ok, true)
  assert.equal(res.count, 2)
  const u = new URL(calls[0]!.url)
  assert.equal(u.searchParams.get('reportName'), 'RPTA_WEB_RZRQ_GGMX')
  assert.equal(u.searchParams.get('filter'), '(SCODE="600519")')
  assert.equal(u.searchParams.get('sortColumns'), 'DATE')
})

// ---------------------------------------------------------------------------
// 包装层失败与空值语义
// ---------------------------------------------------------------------------

await check('HTTP 非 2xx：ok=false、error 带状态码、rows=[]', async () => {
  const fetch: EmFetchLike = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => '',
  })
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  const res = await detail.getFundFlow('600519')
  assert.equal(res.ok, false)
  assert.deepEqual(res.rows, [])
  assert.equal(res.count, 0)
  assert.match(res.error ?? '', /HTTP 503 Service Unavailable/)
})

await check('非法 JSON：ok=false 且错误说明 JSON 解析失败', async () => {
  const fetch: EmFetchLike = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '<html>not json</html>',
  })
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  const res = await detail.getAnnouncements('600519')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /JSON 解析失败/)
})

await check('可注入 json 解析器（离线测试不依赖全局 JSON.parse 行为）', async () => {
  let jsonCalls = 0
  const fetch: EmFetchLike = async () => okResponse(FUND_FLOW_RAW)
  const detail = createEmMarketDetail({
    fetch,
    json: (text) => { jsonCalls++; return JSON.parse(text) as unknown },
    now: () => new Date(NOW_ISO),
  })
  const res = await detail.getFundFlow('600519')
  assert.equal(res.ok, true)
  assert.equal(jsonCalls, 1)
})

await check('请求超时：注入 fetch 的 signal 被 abort，错误明确', async () => {
  const fetch: EmFetchLike = (url, init) => new Promise<EmHttpResponseLike>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO), timeoutMs: 20 })
  const res = await detail.getFundFlow('600519')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /超时/)
})

await check('非法代码在发请求前返回 ok=false，不拼 secid 也不抓取', async () => {
  let called = 0
  const fetch: EmFetchLike = async () => {
    called++
    return okResponse(FUND_FLOW_RAW)
  }
  const detail = createEmMarketDetail({ fetch, now: () => new Date(NOW_ISO) })
  const res = await detail.getFundFlow('AAPL')
  assert.equal(res.ok, false)
  assert.equal(called, 0)
  assert.match(res.error ?? '', /不是合法的 6 位 A 股代码/)
  assert.equal(res.source, 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get')
})

await check('空结果（ok=true,error=undefined）与失败（ok=false,error）严格区分', async () => {
  const emptyRaw = { rc: 0, data: { klines: [] } }
  const empty = harness(() => emptyRaw)
  const emptyRes = await empty.detail.getFundFlow('600519')
  assert.equal(emptyRes.ok, true)
  assert.equal(emptyRes.count, 0)
  assert.equal(emptyRes.asOf, undefined)
  assert.equal(emptyRes.error, undefined)

  const bad = harness(() => ({ rc: 100, data: null }))
  const badRes = await bad.detail.getFundFlow('600519')
  assert.equal(badRes.ok, false)
  assert.equal(badRes.count, 0)
  assert.equal(typeof badRes.error, 'string')
})

await check('每类包装结果都保留 source/fetchedAt/unit，不把抓取时间当数据日', async () => {
  const { detail } = harness(route([
    ['fflow/daykline', FUND_FLOW_RAW],
    ['np-anotice-stock', ANNOUNCEMENTS_RAW],
    ['RPT_SHAREBONUS_DET', DIVIDEND_RAW],
    ['RPT_DATA_BLOCKTRADE', BLOCK_RAW],
    ['RPTA_WEB_RZRQ_GGMX', MARGIN_RAW],
  ]))
  const results = [
    await detail.getFundFlow('600519'),
    await detail.getAnnouncements('600519'),
    await detail.getDividends('600519'),
    await detail.getBlockTrades('600519'),
    await detail.getMarginTrades('600519'),
  ]
  for (const res of results) {
    assert.equal(res.ok, true)
    assert.match(res.source, /^https:\/\/(push2his|np-anotice-stock|datacenter-web)\.eastmoney\.com\//)
    assert.equal(res.fetchedAt, NOW_ISO)
    assert.ok(res.unit.length > 0)
    assert.match(res.asOf ?? '', /^\d{4}-\d{2}-\d{2}$/)
  }
  assert.equal(results[0]!.asOf, '2026-11-16')
  assert.equal(results[1]!.asOf, '2026-11-03')
  assert.equal(results[2]!.asOf, '2026-11-04')
  assert.equal(results[3]!.asOf, '2026-11-12')
  assert.equal(results[4]!.asOf, '2026-11-16')
  assert.equal(results[1]!.currency, undefined)
  assert.equal(results[0]!.currency, 'CNY')
})

console.log(`\n[em-market-detail] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
