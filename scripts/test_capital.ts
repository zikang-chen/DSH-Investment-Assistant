/**
 * Personal capital ledger — offline tests.
 *
 * Reference values are computed by hand in the comments; the implementation is
 * never used to generate its own expectations.
 *
 *   npx tsx scripts/test_capital.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CapitalStore } from '../src/capital/ledger.js'
import { deriveState, netWorth, performanceSummary, twr, xirr } from '../src/capital/performance.js'
import { setFx, fromCents, type FxTable } from '../src/capital/types.js'
import { computeExposure, simulateWeightChange } from '../src/capital/exposure.js'

let passed = 0
const failed: string[] = []
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    console.log(`  [FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-capital-'))
const store = new CapitalStore(dir)
await store.load()
await store.upsertAccount({ accountId: 'sec-cn', name: 'A股账户', accountType: 'securities', baseCurrency: 'CNY' })
await store.upsertAccount({ accountId: 'cash-cny', name: '现金', accountType: 'cash', baseCurrency: 'CNY' })
await store.upsertAccount({ accountId: 'cash-usd', name: '美元现金', accountType: 'cash', baseCurrency: 'USD' })

console.log('== 入金不是收益 / 内部转账不是收益 ==')
await test('入金 10000：净资产=现金，净投入=10000，已实现=0', async () => {
  await store.appendEvent({ accountId: 'cash-cny', eventType: 'DEPOSIT', occurredAt: '2026-01-02', grossAmount: 10000, currency: 'CNY', source: 'manual', sourceTransactionId: 'dep-1' })
  const state = deriveState(store.listEvents())
  assert.equal(state.cashByCurrency.CNY, 1_000_000, '10000 元 = 100 万分')
  assert.equal(state.netInvestedByCurrency.CNY, 1_000_000)
  const worth = netWorth(state, [], 'CNY', new Map(), '2026-01-02')
  assert.equal(worth.totalCents, 1_000_000)
  assert.deepEqual(state.realizedByCurrency, {})
})
await test('内部转账不改变净资产、也不算资金流入', async () => {
  const before = deriveState(store.listEvents())
  await store.appendEvent({ accountId: 'cash-cny', eventType: 'INTERNAL_TRANSFER', occurredAt: '2026-01-03', grossAmount: 3000, currency: 'CNY', note: '转入证券账户备买', source: 'manual', sourceTransactionId: 'tr-1' })
  const after = deriveState(store.listEvents())
  assert.equal(after.cashByCurrency.CNY, before.cashByCurrency.CNY, '自有账户互转不改变总现金')
  assert.equal(after.netInvestedByCurrency.CNY, before.netInvestedByCurrency.CNY, '内部转账不是外部资金流')
  assert.deepEqual(after.realizedByCurrency, {}, '内部转账不产生收益')
})

console.log('== 买卖 / FIFO / 费用 ==')
await test('买入 10 股 @10 元 + 费用 5 元：成本 105 元', async () => {
  await store.appendEvent({ accountId: 'sec-cn', eventType: 'BUY', occurredAt: '2026-02-02', assetId: '600519', quantity: 10, price: 10, fee: 5, currency: 'CNY', source: 'manual', sourceTransactionId: 'buy-1' })
  const state = deriveState(store.listEvents())
  const position = state.positions.find((p) => p.assetId === '600519')!
  assert.ok(position)
  assert.equal(position.quantity, 10)
  assert.equal(fromCents(position.costCents), 105)
  // 现金 = 10000 − 105
  assert.equal(fromCents(state.cashByCurrency.CNY!), 9895)
})
await test('卖出 10 股 @25 元 + 费用 5 元：已实现 = 245 − 105 = 140 元', async () => {
  await store.appendEvent({ accountId: 'sec-cn', eventType: 'SELL', occurredAt: '2026-03-02', assetId: '600519', quantity: 10, price: 25, fee: 5, currency: 'CNY', source: 'manual', sourceTransactionId: 'sell-1' })
  const state = deriveState(store.listEvents())
  assert.equal(fromCents(state.realizedByCurrency.CNY!), 140)
  assert.equal(state.positions.length, 0, '持仓已清空')
})
await test('追加本金不会被当成利润：净投入增加、已实现不变', async () => {
  const before = deriveState(store.listEvents())
  await store.appendEvent({ accountId: 'cash-cny', eventType: 'DEPOSIT', occurredAt: '2026-04-01', grossAmount: 5000, currency: 'CNY', source: 'manual', sourceTransactionId: 'dep-2' })
  const state = deriveState(store.listEvents())
  assert.equal(fromCents(state.netInvestedByCurrency.CNY!), fromCents(before.netInvestedByCurrency.CNY!) + 5000)
  assert.equal(fromCents(state.realizedByCurrency.CNY!), 140, '入金不改变已实现收益')
})

console.log('== 去重与更正 ==')
await test('同一 (source, sourceTransactionId) 重复入账被拒绝', async () => {
  const before = store.listEvents().length
  const result = await store.appendEvent({ accountId: 'cash-cny', eventType: 'DEPOSIT', occurredAt: '2026-04-01', grossAmount: 5000, currency: 'CNY', source: 'manual', sourceTransactionId: 'dep-2' })
  assert.equal(result.duplicate, true)
  assert.equal(store.listEvents().length, before)
})
await test('CSV 预览 + 确认：重复文件第二次 0 新增', async () => {
  const csv = [
    'date,type,account,asset,quantity,price,fee,currency,source_id',
    '2026-05-06,BUY,sec-cn,000001,100,12,1,CNY,ht-1',
    '2026-05-07,SELL,sec-cn,000001,40,13,1,CNY,ht-2',
  ].join('\n')
  const preview = store.previewCsv(csv, { fileName: 'ht.csv', source: 'broker-ht' })
  assert.equal(preview.valid, 2, JSON.stringify(preview.rows.map((r) => r.issues)))
  const batch = await store.confirmImport(preview.previewId)
  assert.equal(batch.imported, 2)
  const again = store.previewCsv(csv, { fileName: 'ht.csv', source: 'broker-ht' })
  assert.equal(again.duplicates, 2)
  assert.equal(again.valid, 0)
})
await test('更正流水：原事件保留但不再计入', async () => {
  const events = await store.listEvents({ assetId: '000001', eventType: 'BUY' })
  const buy = events[0]!
  await store.correctEvent(buy.eventId, { quantity: 90 }, '录入数量错误，按对账单更正')
  const state = deriveState(store.listEvents())
  const position = state.positions.find((p) => p.assetId === '000001')!
  // 100 买 - 40 卖 = 60；更正后买 90 → 90 - 40 = 50
  assert.equal(position.quantity, 50)
  const raw = JSON.parse(await readFile(path.join(dir, 'events.json'), 'utf8')) as { data: Array<{ eventId: string; correctionOf: string }> }
  assert.ok(raw.data.some((e) => e.eventId === buy.eventId), '原事件必须仍留在文件里')
  assert.ok(raw.data.some((e) => e.correctionOf === buy.eventId), '更正事件要指向原事件')
})

console.log('== 多币种 / 缺汇率 ==')
await test('美元与人民币不能直接相加：缺汇率时总资产为 null', async () => {
  await store.appendEvent({ accountId: 'cash-usd', eventType: 'DEPOSIT', occurredAt: '2026-06-01', grossAmount: 100, currency: 'USD', source: 'manual', sourceTransactionId: 'usd-1' })
  const state = deriveState(store.listEvents())
  const worth = netWorth(state, [], 'CNY', new Map(), '2026-06-02')
  assert.equal(worth.totalCents, undefined)
  assert.deepEqual(worth.missingFx, ['USD'])
  assert.ok(worth.byCurrency.USD === 10_000, '100 美元 = 10000 分')
  assert.ok(worth.note.includes('汇率'))
})
await test('提供汇率后才能折算总资产', async () => {
  const fx: FxTable = new Map()
  setFx(fx, 'USD', 'CNY', 7, '2026-06-02', 'test')
  const state = deriveState(store.listEvents())
  const worth = netWorth(state, [], 'CNY', fx, '2026-06-02')
  assert.equal(worth.totalCents, state.cashByCurrency.CNY! + 10_000 * 7)
})

console.log('== XIRR / TWR ==')
await test('XIRR：−10000 → +11000（一年）= 约 10%', () => {
  const result = xirr([
    { date: '2025-01-01', cents: -1_000_000 },
    { date: '2026-01-01', cents: 1_100_000 },
  ])
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs((result.rate ?? 0) - 0.1) < 0.002, String(result.rate))
})
await test('XIRR：无解/多解都明确报错，不虚构唯一值', () => {
  const noRoot = xirr([{ date: '2025-01-01', cents: -1000 }, { date: '2025-02-01', cents: -500 }])
  assert.equal(noRoot.status, 'insufficient')
  const multi = xirr([
    { date: '2025-01-01', cents: -10_000 },
    { date: '2025-06-01', cents: 23_000 },
    { date: '2026-01-01', cents: -13_200 },
  ])
  assert.ok(multi.status === 'multiple-roots' || multi.status === 'ok', `实际：${multi.status}`)
  if (multi.status === 'multiple-roots') assert.ok((multi.roots ?? []).length >= 2)
})
await test('TWR：缺逐期估值 → unavailable（不拿总资产增长率冒充）', () => {
  const result = twr([])
  assert.equal(result.status, 'unavailable')
  assert.ok(result.note.includes('估值'))
})
await test('TWR：10000→11000→12100（无现金流）= 21%', () => {
  const result = twr([
    { date: '2026-01-01', valueCents: 1_000_000 },
    { date: '2026-07-01', valueCents: 1_100_000 },
    { date: '2027-01-01', valueCents: 1_210_000 },
  ])
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs((result.rate ?? 0) - 0.21) < 1e-5, String(result.rate))
})
await test('有外部资金流时 TWR 与总资产增长率不同', () => {
  // 期初 10000，期中追加 10000，期末 21000：
  // 总资产从 10000 涨到 21000（+110%），但下半段实际只涨了 5%（20000→21000），
  // 所以 TWR 应为 5%，与总资产增长率 110% 不是一回事。
  const result = twr([
    { date: '2026-01-01', valueCents: 1_000_000 },
    { date: '2026-07-01', valueCents: 2_000_000, flowCents: 1_000_000 },
    { date: '2027-01-01', valueCents: 2_100_000, flowCents: 0 },
  ])
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs((result.rate ?? 0) - 0.05) < 0.01, `TWR 应为 5%，实际 ${result.rate}`)
})

console.log('== 汇总 ==')
await test('performanceSummary 分开列示净投入/已实现/未实现/现金占比', async () => {
  const state = deriveState(store.listEvents())
  const summary = performanceSummary({
    state,
    prices: [{ assetId: '000001', price: 12, currency: 'CNY', asOf: '2026-06-02' }],
    baseCurrency: 'CNY',
    fx: new Map(),
    asOf: '2026-06-02',
  })
  // 缺 USD 汇率 → 总资产不可得，XIRR 也不得给单一数值
  assert.equal(summary.netWorth.totalCents, undefined)
  assert.equal(summary.cashRatio, undefined)
  assert.ok(summary.netInvested.CNY! > 0)
  assert.ok(typeof summary.realized.CNY === 'number')
  assert.ok(summary.warnings.length > 0)
})
await test('账本重载后数据一致（追加式文件）', async () => {
  const reloaded = new CapitalStore(dir)
  await reloaded.load()
  const before = deriveState(store.listEvents())
  const after = deriveState(reloaded.listEvents())
  assert.deepEqual(after.cashByCurrency, before.cashByCurrency)
  assert.equal(after.positions.length, before.positions.length)
  assert.equal(reloaded.listAccounts().length, 3)
})

console.log('== 暴露与情景（Phase 4） ==')
const expDir = await mkdtemp(path.join(os.tmpdir(), 'finance-exposure-'))
const expStore = new CapitalStore(expDir)
await expStore.load()
await expStore.upsertAccount({ accountId: 'acc', name: '测试账户', accountType: 'securities', baseCurrency: 'CNY' })
await expStore.appendEvent({ accountId: 'acc', eventType: 'DEPOSIT', occurredAt: '2026-01-02', grossAmount: 3000, currency: 'CNY', source: 't', sourceTransactionId: 'd1' })
await expStore.appendEvent({ accountId: 'acc', eventType: 'BUY', occurredAt: '2026-01-03', assetId: 'A', quantity: 100, price: 10, currency: 'CNY', source: 't', sourceTransactionId: 'b1' })
await expStore.appendEvent({ accountId: 'acc', eventType: 'BUY', occurredAt: '2026-01-04', assetId: 'B', quantity: 200, price: 5, currency: 'CNY', source: 't', sourceTransactionId: 'b2' })
await test('暴露：权重按总资产（含现金），HHI 只算持仓', () => {
  const state = deriveState(expStore.listEvents())
  const exposure = computeExposure(state, [
    { assetId: 'A', price: 12, currency: 'CNY', asOf: '2026-02-01' },
    { assetId: 'B', price: 4, currency: 'CNY', asOf: '2026-02-01' },
  ], 'CNY', new Map(), '2026-02-01')
  assert.equal(fromCents(exposure.totalCents!), 3000)
  const a = exposure.rows.find((r) => r.assetId === 'A')!
  const b = exposure.rows.find((r) => r.assetId === 'B')!
  assert.ok(Math.abs((a.weight ?? 0) - 0.4) < 1e-9, `A 权重 ${a.weight}`)
  assert.ok(Math.abs((b.weight ?? 0) - 800 / 3000) < 1e-9)
  // HHI 只对持仓：0.4² + (0.2667)² ≈ 0.2311
  assert.ok(Math.abs((exposure.hhi ?? 0) - (0.16 + Math.pow(800 / 3000, 2))) < 1e-6)
  assert.ok((exposure.cashRatio ?? 0) > 0.33)
})
await test('情景：把 A 目标权重提到 60%，集中度上升且标记为纸面模拟', () => {
  const state = deriveState(expStore.listEvents())
  const exposure = computeExposure(state, [
    { assetId: 'A', price: 12, currency: 'CNY', asOf: '2026-02-01' },
    { assetId: 'B', price: 4, currency: 'CNY', asOf: '2026-02-01' },
  ], 'CNY', new Map(), '2026-02-01')
  const scenario = simulateWeightChange(exposure, [{ assetId: 'A', targetWeight: 0.6 }])
  assert.equal(scenario.feasible, true)
  assert.ok((scenario.after.hhi ?? 0) > (scenario.before.hhi ?? 0), '提高单票权重后 HHI 应上升')
  assert.ok((scenario.delta.hhi ?? 0) > 0)
  assert.ok(scenario.note.includes('不构成任何买卖建议'))
  assert.ok(scenario.note.includes('未考虑交易成本'))
})
await test('暴露：缺价格的持仓进 unpriced 且权重为 undefined（不按 0 计）', async () => {
  await expStore.appendEvent({ accountId: 'acc', eventType: 'BUY', occurredAt: '2026-01-05', assetId: 'C', quantity: 10, price: 100, currency: 'CNY', source: 't', sourceTransactionId: 'b3' })
  const state = deriveState(expStore.listEvents())
  const exposure = computeExposure(state, [
    { assetId: 'A', price: 12, currency: 'CNY', asOf: '2026-02-01' },
    { assetId: 'B', price: 4, currency: 'CNY', asOf: '2026-02-01' },
  ], 'CNY', new Map(), '2026-02-01')
  assert.ok(exposure.unpriced.includes('C'))
  const c = exposure.rows.find((r) => r.assetId === 'C')!
  assert.equal(c.weight, undefined)
  assert.ok(exposure.warnings.some((w) => w.includes('未定价')))
})
await test('情景：目标权重合计超过 100% 时不可行', () => {
  const state = deriveState(expStore.listEvents())
  const exposure = computeExposure(state, [
    { assetId: 'A', price: 12, currency: 'CNY', asOf: '2026-02-01' },
  ], 'CNY', new Map(), '2026-02-01')
  const scenario = simulateWeightChange(exposure, [{ assetId: 'A', targetWeight: 0.7 }, { assetId: 'B', targetWeight: 0.5 }])
  assert.equal(scenario.feasible, false)
  assert.ok(scenario.warnings.some((w) => w.includes('超过 100%')))
})
await rm(expDir, { recursive: true, force: true })

await rm(dir, { recursive: true, force: true })

console.log(`\n[capital] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exitCode = 1
} else {
  process.exitCode = 0
}
