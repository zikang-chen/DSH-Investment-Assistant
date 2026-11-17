/**
 * Wealth simulator — offline tests with hand-computed reference values.
 *
 *   npx tsx scripts/test_wealth.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compound, futureValueOfFlows, netOfFees, periodRate, realReturn, solveGoal, yuan } from '../src/wealth/compound.js'
import { WealthPlanStore } from '../src/wealth/plans.js'

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

const near = (actual: number, expected: number, tolerance: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: 实际 ${actual}，期望 ${expected}（容差 ${tolerance}）`)
}
const cents = (yuanValue: number): number => Math.round(yuanValue * 100)

console.log('== 利率换算 ==')
await test('年有效 10% → 月利率 (1.1)^(1/12)-1 ≈ 0.7974%，不是 0.8333%', () => {
  const monthly = periodRate(0.1, 'monthly')
  near(monthly, 0.00797414, 1e-7, '月利率')
  assert.ok(Math.abs(monthly - 0.1 / 12) > 0.0002, '不能直接用 r/12')
})
await test('实际收益率 (1+10%)/(1+3%)-1 ≈ 6.796%', () => {
  near(realReturn(0.1, 0.03), 0.0679612, 1e-6, '实际收益率')
})
await test('费后收益率 (1+10%)×(1-1%)-1 = 8.9%', () => {
  near(netOfFees(0.1, 0.01), 0.089, 1e-9, '费后收益率')
})

console.log('== 复利参考值 ==')
await test('10000 @10% 两年 = 12100（月复利，误差 ≤ 1 分）', () => {
  const result = compound({ principalCents: cents(10000), annualRate: 0.1, years: 2 })
  near(result.finalCents, cents(12100), 1, '两年终值')
  assert.equal(result.contributedCents, 0)
  near(yuan(result.growthCents), 2100, 0.01, '收益')
})
await test('月投 1000、零收益率、12 个月 = 累计投入 12000', () => {
  const result = compound({ principalCents: 0, contributionCents: cents(1000), annualRate: 0, years: 1 })
  assert.equal(result.finalCents, cents(12000))
  assert.equal(result.contributedCents, cents(12000))
  assert.equal(result.growthCents, 0)
})
await test('零收益率极限式：不出现除以 0', () => {
  const result = compound({ principalCents: cents(5000), contributionCents: cents(500), annualRate: 0, years: 3 })
  assert.equal(result.finalCents, cents(5000 + 500 * 36))
})
await test('负收益情景：−10% 两年 = 8100', () => {
  const result = compound({ principalCents: cents(10000), annualRate: -0.1, years: 2 })
  near(result.finalCents, cents(8100), 1, '负收益终值')
  assert.ok(result.growthCents < 0)
})
await test('通胀调整：名义 12100，通胀 3% 两年 → 实际购买力 ≈ 11405.5', () => {
  const result = compound({ principalCents: cents(10000), annualRate: 0.1, inflation: 0.03, years: 2 })
  near(yuan(result.finalRealCents), 12100 / (1.03 * 1.03), 0.02, '实际购买力')
})
await test('年费 1%：净收益 8.9%，两年 ≈ 11892.1', () => {
  const result = compound({ principalCents: cents(10000), annualRate: 0.1, annualFee: 0.01, years: 2 })
  near(yuan(result.finalCents), 10000 * 1.089 * 1.089, 0.05, '费后终值')
  near(result.netAnnualRate, 0.089, 1e-9, '净年化')
})
await test('期初 vs 期末投入：期初结果更高', () => {
  const end = compound({ principalCents: 0, contributionCents: cents(1000), annualRate: 0.1, years: 1, timing: 'end' })
  const begin = compound({ principalCents: 0, contributionCents: cents(1000), annualRate: 0.1, years: 1, timing: 'begin' })
  assert.ok(begin.finalCents > end.finalCents)
})
await test('追加金额每年增长 3%：第 2 年投入大于第 1 年', () => {
  const result = compound({ principalCents: 0, contributionCents: cents(1000), annualRate: 0.05, years: 3, contributionGrowth: 0.03 })
  assert.ok(result.rows[1]!.contributedCents > result.rows[0]!.contributedCents)
})

console.log('== 不规则现金流 ==')
await test('两笔 1000：一笔在估值日、一笔在一年前 @10% → 2100', () => {
  const result = futureValueOfFlows([
    { date: '2026-01-01', cents: cents(1000) },
    { date: '2027-01-01', cents: cents(1000) },
  ], 0.1, '2027-01-01')
  assert.equal(result.valueCents, cents(2100))
  assert.equal(result.investedCents, cents(2000))
  assert.equal(result.growthCents, cents(100))
})
await test('晚于估值日的现金流被跳过并计数', () => {
  const result = futureValueOfFlows([
    { date: '2027-06-01', cents: cents(1000) },
  ], 0.1, '2027-01-01')
  assert.equal(result.skipped, 1)
  assert.equal(result.valueCents, 0)
})

console.log('== 目标反解 ==')
await test('目标 12100、本金 10000、两年 @10%：所需月投 ≈ 0', () => {
  const solution = solveGoal({ targetCents: cents(12100), principalCents: cents(10000), annualRate: 0.1, years: 2 })
  assert.ok(solution.requiredContributionCents <= 2, `实际 ${solution.requiredContributionCents}`)
  assert.equal(solution.gapCents, 0)
})
await test('零收益率、零本金、目标 12000、月投 1000 → 需要 1 年（12 个月 × 1000）', () => {
  const solution = solveGoal({ targetCents: cents(12000), principalCents: 0, monthlyContributionCents: cents(1000), annualRate: 0, years: 10 })
  assert.ok(solution.requiredYears !== undefined)
  near(solution.requiredYears!, 1, 0.05, '所需年限')
})
await test('不可达时返回 undefined，不给近似值', () => {
  const solution = solveGoal({ targetCents: cents(12000), principalCents: 0, monthlyContributionCents: 0, annualRate: 0, years: 10 })
  assert.equal(solution.requiredYears, undefined)
  assert.ok(solution.gapCents > 0)
})

console.log('== 方案保存与对比 ==')
const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-wealth-'))
const plans = new WealthPlanStore(dir)
await plans.load()
await test('保存三个情景并可对比（名称不代表概率）', async () => {
  const base = { principalCents: cents(10000), contributionCents: cents(1000), years: 10, frequency: 'monthly' as const, timing: 'end' as const, annualFee: 0.005, inflation: 0.03 }
  const steady = await plans.save({ ...base, name: '稳健', annualRate: 0.03 })
  const normal = await plans.save({ ...base, name: '基准', annualRate: 0.06 })
  const stress = await plans.save({ ...base, name: '压力', annualRate: -0.02 })
  assert.ok(steady.snapshot.finalYuan > 0)
  assert.ok(stress.snapshot.finalYuan < normal.snapshot.finalYuan)
  const rows = plans.compare([steady.planId, normal.planId, stress.planId])
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.contributedYuan > 0))
  assert.ok(rows.every((r) => r.finalRealYuan > 0))
})
await test('重算一致：同一引擎下快照与重算相同', async () => {
  const plan = plans.all()[0]!
  const recomputed = plans.recompute(plan.planId)!
  assert.equal(recomputed.same, true)
  assert.equal(recomputed.finalYuan, plan.snapshot.finalYuan)
})
await test('重载后方案仍在', async () => {
  const reloaded = new WealthPlanStore(dir)
  await reloaded.load()
  assert.equal(reloaded.all().length, 3)
})
await rm(dir, { recursive: true, force: true })

console.log(`\n[wealth] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exitCode = 1
} else {
  process.exitCode = 0
}
