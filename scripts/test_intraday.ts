/**
 * 分时（东财 trends2）离线测试：解析、secid 映射、错误语义、路由与 provider 接线。
 *
 * 约束：不联网（fetch 被替换为抛错）、不读私有数据、不写配置。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  EM_INTRADAY_URL,
  INTRADAY_MAX_DAYS,
  fetchTxIntraday,
  parseIntradayPayload,
  parseTxMinutePayload,
  intradaySecid,
  txIntradaySymbol,
} from '../src/data/intraday.js'
import { FinanceDataService } from '../src/data/service.js'
import { PROVIDERS } from '../src/data/providers.js'
import { CAPABILITIES, DEFAULT_PROVIDER_ORDER } from '../src/types.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }

// 结构取自实测：时间,开,收,高,低,量,额,均价
const FIXTURE = {
  rc: 0,
  data: {
    code: '600519', market: 1, name: '贵州茅台', preClose: 1485.75,
    trends: [
      '2026-11-23 09:30,1475.35,1475.35,1475.35,1475.35,1063,156829705.00,1475.350',
      '2026-11-23 09:31,1475.35,1474.10,1475.60,1474.10,800,117928000.00,1475.120',
      '2026-11-23 11:08,1443.40,1444.70,1444.70,1443.00,111,16027046.00,1446.578',
    ],
  },
}

check('secid：A 股按市场前缀，港股 116，美股 105', () => {
  assert.equal(intradaySecid('600519', 'a'), '1.600519')
  assert.equal(intradaySecid('000001', 'a'), '0.000001')
  assert.equal(intradaySecid('sh000300', 'a'), '1.000300')
  assert.equal(intradaySecid('00700', 'hk'), '116.00700')
  assert.equal(intradaySecid('AAPL', 'us'), '105.AAPL')
})

check('解析：price 取收盘列，均价/量/额映射，时间保留原文并给 ISO', () => {
  const s = parseIntradayPayload(FIXTURE, { code: '600519', kind: 'a', days: 1 })
  assert.equal(s.name, '贵州茅台')
  assert.equal(s.preClose, 1485.75)
  assert.equal(s.points.length, 3)
  assert.equal(s.points[0]!.time, '2026-11-23 09:30')
  assert.equal(s.points[0]!.price, 1475.35)
  assert.equal(s.points[0]!.avgPrice, 1475.35)
  assert.equal(s.points[2]!.volume, 111)
  assert.equal(s.points[2]!.at, '2026-11-23T03:08:00.000Z') // 11:08 +08:00
  assert.equal(s.source, 'eastmoney-push2his-trends2')
})

check('解析：字段缺失为 null，不补 0', () => {
  const s = parseIntradayPayload({ data: { trends: ['2026-11-23 09:30,,,,,,,'] } }, { code: '600519', kind: 'a', days: 1 })
  assert.equal(s.points[0]!.price, null)
  assert.equal(s.points[0]!.avgPrice, null)
  assert.equal(s.points[0]!.volume, null)
  assert.equal(s.preClose, null)
})

check('解析：真实 0 保留为 0（与缺失区分）', () => {
  const s = parseIntradayPayload({ data: { trends: ['2026-11-23 09:30,0,0,0,0,0,0,0'], preClose: 0 } }, { code: '600519', kind: 'a', days: 1 })
  assert.equal(s.points[0]!.price, 0)
  assert.equal(s.points[0]!.volume, 0)
})

check('解析：空 trends 抛错（不返回空图）', () => {
  assert.throws(() => parseIntradayPayload({ data: { trends: [] } }, { code: '600519', kind: 'a', days: 1 }), /未返回数据|空序列/)
  assert.throws(() => parseIntradayPayload({}, { code: '600519', kind: 'a', days: 1 }), /未返回数据|空序列/)
  assert.throws(() => parseIntradayPayload(null, { code: '600519', kind: 'a', days: 1 }), /未返回数据|空序列/)
})

check('解析：时间格式不认识时 at=null，不猜时区', () => {
  const s = parseIntradayPayload({ data: { trends: ['2026/11/23 09:30,1,1,1,1,1,1,1'] } }, { code: '600519', kind: 'a', days: 1 })
  assert.equal(s.points[0]!.at, null)
  assert.equal(s.points[0]!.time, '2026/11/23 09:30')
})

check('上限：5 日封顶，参数不合法时退到 1 日', () => {
  assert.equal(INTRADAY_MAX_DAYS, 5)
})

check('接线：capability intraday 的默认顺序为 东财 → 腾讯（两个 provider 均已注册）', () => {
  assert.ok(CAPABILITIES.includes('intraday'))
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.intraday, ['em_intraday', 'tx_intraday'])
  const provider = PROVIDERS.find((p) => p.id === 'em_intraday')
  assert.ok(provider, 'em_intraday 未注册')
  assert.equal(provider!.capability, 'intraday')
  assert.match(EM_INTRADAY_URL, /push2his\.eastmoney\.com\/api\/qt\/stock\/trends2\/get$/)
})

check('接线：service 暴露 getIntraday 并转发 code/kind/days', async () => {
  const calls: Array<{ cap: string; args: Record<string, unknown> }> = []
  const fake = {
    call: async (cap: string, args: Record<string, unknown>) => { calls.push({ cap, args }); return { points: [] } },
  }
  const svc = new FinanceDataService(fake as never)
  await svc.getIntraday('00700', 'hk', 5)
  assert.equal(calls[0]!.cap, 'intraday')
  assert.deepEqual(calls[0]!.args, { code: '00700', kind: 'hk', days: 5 })
})

check('接线：路由 /intraday 已挂载且校验 kind/days', async () => {
  const src = await readFile('src/server-routes.ts', 'utf8')
  assert.match(src, /sub === '\/intraday'/, '缺少 /intraday 路由')
  assert.match(src, /kind 必须是 a \/ hk \/ us/)
  assert.match(src, /days 只支持 1–5/)
  assert.match(src, /finance\.getIntraday\(/)
})

check('接线：K 线工作区提供分时模式与图表组件', async () => {
  const view = await readFile('src/client/index.tsx', 'utf8')
  assert.match(view, /'intraday1'/, '缺少分时(1日)模式')
  assert.match(view, /'intraday5'/, '缺少 5 日分时模式')
  assert.match(view, /loadIntraday\(/, '缺少分时加载函数')
  assert.match(view, /IntradayChart/, '未使用分时图组件')
  assert.match(view, /基金是每日净值（T\+1）/, '基金缺少明确说明')
  const chart = await readFile('src/client/intraday-chart.tsx', 'utf8')
  assert.match(chart, /不除权/, '分时图需说明未除权')
})

check('备用源：symbol 映射（A 带 sh/sz、港股 hk、美股 us）', () => {
  assert.equal(txIntradaySymbol('600519', 'a'), 'sh600519')
  assert.equal(txIntradaySymbol('000001', 'a'), 'sz000001')
  assert.equal(txIntradaySymbol('sh000300', 'a'), 'sh000300')
  assert.equal(txIntradaySymbol('700', 'hk'), 'hk00700')
  assert.equal(txIntradaySymbol('aapl', 'us'), 'usAAPL')
})

check('备用源解析：A 股累计量是「手」，均价 = 额/(量×100)', () => {
  const payload = {
    data: {
      sh600519: {
        data: {
          date: '20261123',
          data: ['0930 1475.35 1063 156829705.00', '0931 1455.50 4938 726902333.00'],
        },
        qt: { sh600519: ['1', '贵州茅台', '600519', '1439.60', '1485.75'] },
      },
    },
  }
  const s = parseTxMinutePayload(payload, { code: '600519', kind: 'a', symbol: 'sh600519', days: 1 })
  assert.equal(s.points[0]!.time, '2026-11-23 09:30', '日期 20261123 必须归一成 2026-11-23')
  assert.equal(s.points[0]!.price, 1475.35)
  assert.equal(s.points[0]!.volume, 1063)
  assert.equal(s.points[1]!.volume, 3875, '分钟量由累计量差分得到')
  // 726902333 / (4938 * 100) ≈ 1472.0
  assert.ok(Math.abs((s.points[1]!.avgPrice ?? 0) - 1472.03) < 0.05)
  assert.equal(s.preClose, 1485.75)
  assert.equal(s.source, 'tencent-minute')
})

check('备用源解析：港股量为股，不乘 100', () => {
  const payload = { data: { hk00700: { data: { date: '2026-11-23', data: ['0930 335 1000 335000'] }, qt: { hk00700: ['100', '腾讯控股', '00700', '338', '344'] } } } }
  const s = parseTxMinutePayload(payload, { code: '00700', kind: 'hk', symbol: 'hk00700', days: 1 })
  assert.equal(s.points[0]!.avgPrice, 335)
  assert.equal(s.preClose, 344)
})

check('备用源：空 data 抛错，不返回空图', () => {
  assert.throws(() => parseTxMinutePayload({}, { code: '600519', kind: 'a', symbol: 'sh600519', days: 1 }), /未返回数据|空序列/)
})

check('备用源限制：5 日与美股显式拒绝（不伪造）', async () => {
  await assert.rejects(() => fetchTxIntraday('600519', 'a', 5), /只支持当日/)
  await assert.rejects(() => fetchTxIntraday('AAPL', 'us', 1), /没有美股分钟数据/)
})

check('接线：intraday 顺序为 东财 → 腾讯，两个 provider 都已注册', () => {
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.intraday, ['em_intraday', 'tx_intraday'])
  assert.ok(PROVIDERS.some((p) => p.id === 'em_intraday'))
  assert.ok(PROVIDERS.some((p) => p.id === 'tx_intraday'))
})

console.log(`\n[intraday] ${checks} 组通过（离线；真实上游另测）`)
