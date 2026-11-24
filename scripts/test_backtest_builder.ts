/**
 * 回测输入构造器的离线测试：只测「装配逻辑」，不跑回测、不发请求。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildBacktestInput } from '../src/client/backtest-builder.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log('PASS', name) }

const base = {
  baseCurrency: 'CNY', initialCash: '100000', cashWeight: '10',
  start: '2026-01-01', end: '2026-06-30', frequency: 'quarterly', feeBps: '3',
}
const bars = [
  { date: '2025-12-31', open: 3.9, close: 4.0 },
  { date: '2026-01-05', open: 4.0, close: 4.1 },
  { date: '2026-03-02', open: 4.2, close: 4.3 },
  { date: '2026-07-01', open: 4.5, close: 4.6 },
]

check('正常装配：权重换算、区间裁剪、税表与来源标注', () => {
  const result = buildBacktestInput({ ...base, rows: [{ code: '510300', kind: 'a', weight: '90', currency: 'CNY' }] }, { '510300': bars })
  assert.equal(result.ok, true, result.errors.join('；'))
  const input = result.input as any
  assert.equal(input.baseCurrency, 'CNY')
  assert.equal(input.cashTargetWeight, 0.1)
  const asset = input.assets[0]
  assert.equal(asset.id, '510300')
  assert.equal(asset.weight, 0.9)
  assert.deepEqual(asset.prices.map((p: any) => p.date), ['2026-01-05', '2026-03-02'], '区间外的价格必须裁掉')
  assert.equal(asset.adjustment, 'raw')
  assert.equal(asset.actionsComplete, false, '没有公司行动就明确标 false')
  assert.equal(asset.tax.buyFeeBps, 3)
  assert.match(asset.taxSource, /未逐项核验/)
  assert.ok(result.warnings.some((w) => /不构成完整总回报/.test(w)))
})

check('权重合计必须含现金为 100%，否则一次说清', () => {
  const result = buildBacktestInput({ ...base, cashWeight: '10', rows: [{ code: '510300', kind: 'a', weight: '60', currency: 'CNY' }] }, { '510300': bars })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /应为 100%/.test(e)))
})

check('跨币种不自动换算，直接拒绝并说明', () => {
  const result = buildBacktestInput({ ...base, rows: [{ code: 'AAPL', kind: 'us', weight: '60', currency: 'USD' }] }, { AAPL: bars })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /需要先补汇率/.test(e)))
})

check('本地历史不足两个点就拒绝，不生成空资产', () => {
  const result = buildBacktestInput({ ...base, rows: [{ code: '600519', kind: 'a', weight: '90', currency: 'CNY' }] }, { '600519': [{ date: '2026-02-02', open: 1, close: 1 }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /本地历史不足/.test(e)))
})

check('资金/日期/频率非法时逐项报错', () => {
  const result = buildBacktestInput({ ...base, initialCash: '0', start: '2026/01/01', frequency: 'weekly', rows: [{ code: '510300', kind: 'a', weight: '90', currency: 'CNY' }] }, { '510300': bars })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /初始资金/.test(e)))
  assert.ok(result.errors.some((e) => /YYYY-MM-DD/.test(e)))
  assert.ok(result.errors.some((e) => /再平衡频率无效/.test(e)))
})

check('只读装配：模块不发起请求、不写文件', () => {
  const source = readFileSync('src/client/backtest-builder.tsx', 'utf8')
  assert.doesNotMatch(source, /apiPost|fetch\(|writeFile/)
  // 组件里的取价/提交都通过 props 注入，模块本身不直接打后端。
  assert.match(source, /props\.get/)
  assert.match(source, /props\.post/)
})

check('接线：组合策略页用构造器，JSON 降为高级项', () => {
  const operations = readFileSync('src/client/portfolio-operations.tsx', 'utf8')
  assert.match(operations, /<BacktestBuilder/)
  assert.match(operations, /高级：直接编辑输入 JSON/)
})

console.log(`\n[backtest-builder] ${checks} 组通过（离线；真实回测未运行）`)
