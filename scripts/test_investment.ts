/**
 * Investment advice engine — offline tests.
 *
 * The point of these tests is the guardrails: a directional recommendation
 * without contradicting evidence or invalidation conditions must be refused, and
 * "evidence insufficient" must never carry an action.
 *
 *   npx tsx scripts/test_investment.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AdviceStore } from '../src/invest/store.js'
import { advicePromptHash, validateAdvice, type AdviceInput } from '../src/invest/schema.js'
import { summarizeVerification, verifyAdvice } from '../src/invest/verify.js'

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

const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-invest-'))
const store = new AdviceStore(dir)
await store.load()

const evidence = (claim: string, source = '国家统计局', asOf = '2026-11-16') => ({ kind: 'macro' as const, claim, source, asOf })

const baseInput = (patch: Partial<AdviceInput> = {}): AdviceInput => ({
  userPrompt: '现在沪深300适不适合配置？',
  assets: ['000300'],
  market: 'cn',
  horizon: 'months',
  recommendation: 'WATCH',
  supporting: [evidence('沪深300市盈率分位处于近五年 35% 分位')],
  contradicting: [evidence('10月社零同比仅增 1.0%，内需仍弱')],
  invalidationConditions: ['若社零连续两月回升且盈利预期上修，则观望理由消失'],
  riskConstraints: ['最大回撤不超过 15%'],
  dataFreshness: { status: 'fresh', asOf: '2026-11-16', note: '收盘数据' },
  valuationSummary: 'PE 分位 35%，股息率 2.4%',
  nextReviewAt: '2026-12-15',
  ...patch,
})

console.log('== 反证与证据强制 ==')
await test('方向性建议缺少反对证据 → 拒绝保存', async () => {
  const result = await store.create(baseInput({ contradicting: [] }))
  assert.equal(result.advice, undefined)
  assert.ok(result.errors?.some((e) => e.includes('反对证据')), result.errors?.join(' | '))
})
await test('方向性建议缺少失效条件 → 拒绝保存', async () => {
  const result = await store.create(baseInput({ invalidationConditions: [] }))
  assert.ok(result.errors?.some((e) => e.includes('失效条件')))
})
await test('证据没有来源/日期 → 拒绝保存', async () => {
  const result = await store.create(baseInput({
    supporting: [{ kind: 'macro', claim: '市场情绪转暖', source: '', asOf: '' }],
  }))
  assert.equal(result.advice, undefined)
  assert.ok(result.errors?.some((e) => e.includes('缺少 source')))
  assert.ok(result.errors?.some((e) => e.includes('缺少有效 asOf')))
})
await test('完整建议（支持+反对+失效）可以保存', async () => {
  const result = await store.create(baseInput({ recommendation: 'WATCH', rationale: ['估值不贵但盈利未验证'] }))
  assert.ok(result.advice, result.errors?.join(' | '))
  assert.equal(result.advice!.recommendation, 'WATCH')
  assert.equal(result.advice!.supporting.length, 1)
  assert.equal(result.advice!.contradicting.length, 1)
  assert.equal(result.advice!.status, 'open')
  assert.equal(result.advice!.promptHash, advicePromptHash('现在沪深300适不适合配置？', ['000300']))
})

console.log('== 证据不足路径 ==')
await test('INSUFFICIENT_DATA 必须列出缺什么', async () => {
  const result = await store.create(baseInput({ recommendation: 'INSUFFICIENT_DATA', supporting: [], contradicting: [], invalidationConditions: [], proposedAction: null }))
  assert.equal(result.advice, undefined)
  assert.ok(result.errors?.some((e) => e.includes('unresolvedQuestions')))
})
await test('INSUFFICIENT_DATA 不得带行动方案', async () => {
  const result = await store.create(baseInput({
    recommendation: 'INSUFFICIENT_DATA',
    supporting: [],
    contradicting: [],
    invalidationConditions: [],
    unresolvedQuestions: ['缺少 2026 年 10 月社融数据'],
    proposedAction: { summary: '先买三成', conditions: [], simulated: true },
  }))
  assert.equal(result.advice, undefined)
  assert.ok(result.errors?.some((e) => e.includes('不得给出行动方案')))
})
await test('INSUFFICIENT_DATA 补齐缺项后可以保存（且无行动）', async () => {
  const result = await store.create(baseInput({
    recommendation: 'INSUFFICIENT_DATA',
    userPrompt: '黄金未来三个月还有投资价值吗？',
    assets: ['黄金'],
    market: 'gold',
    supporting: [],
    contradicting: [],
    invalidationConditions: [],
    unresolvedQuestions: ['缺少实际利率与 ETF 持仓数据'],
    proposedAction: null,
  }))
  assert.ok(result.advice, result.errors?.join(' | '))
  assert.equal(result.advice!.proposedAction, null)
})

console.log('== 价格区间必须有计算依据 ==')
await test('给价格区间但不给 calculationRefs → 拒绝', async () => {
  const result = await store.create(baseInput({
    proposedAction: { summary: '回落到区间下沿分批', conditions: ['站稳年线'], priceZone: { low: 3600, high: 3800, basis: '经验' }, simulated: true },
  }))
  assert.equal(result.advice, undefined)
  assert.ok(result.errors?.some((e) => e.includes('calculationRefs')))
})
await test('有计算依据时可以保存（并标 simulated）', async () => {
  const result = await store.create(baseInput({
    proposedAction: { summary: '回落到区间下沿分批', conditions: ['站稳年线'], priceZone: { low: 3600, high: 3800, basis: '近三年 PE 分位对应点位' }, simulated: true },
    calculationRefs: ['get_stock_kline:000300 近三年分位', 'calculate_technical_indicators:MA60'],
  }))
  assert.ok(result.advice, result.errors?.join(' | '))
  assert.equal(result.advice!.proposedAction?.simulated, true)
})

console.log('== 到期复核（Phase 5） ==')
await test('dueForReview 只列出到期且未复盘的建议', async () => {
  await store.create(baseInput({
    userPrompt: '黄金未来三个月还有投资价值吗？',
    assets: ['黄金'],
    market: 'gold',
    nextReviewAt: '2026-01-10',
    recommendation: 'WATCH',
  }))
  const due = store.dueForReview('2026-02-01')
  assert.ok(due.length >= 1, JSON.stringify(due.map((d) => d.advice.userPrompt)))
  const hit = due.find((d) => d.advice.assets.includes('黄金'))!
  assert.ok(hit.overdueDays >= 20, `逾期天数：${hit.overdueDays}`)
  const future = store.dueForReview('2026-02-01', 7)
  assert.ok(future.length >= due.length)
  assert.ok(future.every((d) => d.advice.status === 'open'))
})
await test('复盘后不再出现在到期清单里', async () => {
  const due = store.dueForReview('2026-02-01')
  const target = due.find((d) => d.advice.assets.includes('黄金'))!
  await store.review(target.advice.adviceId, { outcome: 'inconclusive', note: '数据仍不足', dataAsOf: '2026-02-01' })
  const after = store.dueForReview('2026-02-01')
  assert.ok(!after.some((d) => d.advice.adviceId === target.advice.adviceId))
})

console.log('== 历史验证（Phase 5） ==')
await test('看多且上涨 → supported；看多却下跌 → contradicted', async () => {
  const bullish = await store.create(baseInput({
    userPrompt: '测试：看多 000300',
    assets: ['000300'],
    recommendation: 'CONSIDER_BUY',
    supporting: [evidence('估值分位 30%')],
    contradicting: [evidence('盈利未验证')],
    invalidationConditions: ['跌破年线'],
  }))
  const prices = [
    { date: '2026-11-01', close: 3900 },
    { date: '2026-12-01', close: 4100 },
  ]
  const up = verifyAdvice({ advice: bullish.advice!, prices, asOf: '2026-12-01' })
  assert.equal(up.status, 'supported')
  assert.ok(Math.abs((up.changePct ?? 0) - 5.13) < 0.05, String(up.changePct))
  const down = verifyAdvice({ advice: bullish.advice!, prices: [{ date: '2026-11-01', close: 3900 }, { date: '2026-12-01', close: 3700 }], asOf: '2026-12-01' })
  assert.equal(down.status, 'contradicted')
})
await test('WATCH 类不能用涨跌判定：返回 inconclusive 并说明', async () => {
  const watch = await store.create(baseInput({ userPrompt: '测试：观望', assets: ['510300'], recommendation: 'WATCH' }))
  const result = verifyAdvice({
    advice: watch.advice!,
    prices: [{ date: '2026-11-01', close: 4 }, { date: '2026-12-01', close: 4.4 }],
    asOf: '2026-12-01',
  })
  assert.equal(result.status, 'inconclusive')
  assert.ok(result.notes.some((n) => n.includes('不能用涨跌判定')))
})
await test('幅度小于阈值 → inconclusive（没有方向信号）', async () => {
  const advice = await store.create(baseInput({ userPrompt: '测试：小幅', assets: ['000001'], recommendation: 'CONSIDER_BUY' }))
  const result = verifyAdvice({
    advice: advice.advice!,
    prices: [{ date: '2026-11-01', close: 100 }, { date: '2026-12-01', close: 100.5 }],
    asOf: '2026-12-01',
  })
  assert.equal(result.status, 'inconclusive')
})
await test('价格序列不足 → unverifiable，不猜', async () => {
  const advice = await store.create(baseInput({ userPrompt: '测试：缺价格', assets: ['000002'], recommendation: 'CONSIDER_BUY' }))
  const result = verifyAdvice({ advice: advice.advice!, prices: [{ date: '2026-12-01', close: 10 }], asOf: '2026-12-01' })
  assert.equal(result.status, 'unverifiable')
  assert.ok(result.notes.some((n) => n.includes('不足以覆盖')))
})
await test('带基准时给超额；未成交不统计为盈利', async () => {
  const advice = await store.create(baseInput({ userPrompt: '测试：基准比较', assets: ['000003'], recommendation: 'CONSIDER_BUY' }))
  const result = verifyAdvice({
    advice: advice.advice!,
    prices: [{ date: '2026-11-01', close: 100 }, { date: '2026-12-01', close: 110 }],
    benchmark: [{ date: '2026-11-01', close: 4000 }, { date: '2026-12-01', close: 4080 }],
    asOf: '2026-12-01',
  })
  assert.equal(result.status, 'supported')
  assert.ok(Math.abs((result.excessPct ?? 0) - 8) < 0.05, String(result.excessPct))
  assert.ok(result.caveat.includes('不是交易结果'))
})
await test('样本不足时汇总不给胜率', () => {
  const summary = summarizeVerification([
    { adviceId: 'a', recommendation: 'CONSIDER_BUY', status: 'supported', notes: [], caveat: '' },
    { adviceId: 'b', recommendation: 'WATCH', status: 'inconclusive', notes: [], caveat: '' },
  ])
  assert.equal(summary.total, 2)
  assert.equal(summary.verifiable, 1)
  assert.ok(summary.note.includes('不给胜率'))
})

console.log('== 复盘不改原判断 ==')
await test('复盘追加记录，原始判断与证据不变', async () => {
  const created = await store.create(baseInput({
    userPrompt: '现在沪深300适不适合配置？',
    rationale: ['估值不贵'],
  }))
  const advice = created.advice!
  const before = JSON.stringify({ rec: advice.recommendation, sup: advice.supporting, created: advice.createdAt, inv: advice.invalidationConditions })
  const reviewed = await store.review(advice.adviceId, {
    outcome: 'contradicted',
    note: '11 月社零继续走弱，观望理由仍在，但原先“盈利改善”假设被证伪',
    dataAsOf: '2026-12-15',
    conditionTriggered: false,
    invalidationTriggered: false,
  })
  assert.equal(reviewed.status, 'reviewed')
  assert.equal(reviewed.reviews.length, 1)
  assert.equal(reviewed.reviews[0]!.outcome, 'contradicted')
  const after = JSON.stringify({ rec: reviewed.recommendation, sup: reviewed.supporting, created: reviewed.createdAt, inv: reviewed.invalidationConditions })
  assert.equal(after, before, '复盘不得改写原始判断/证据/时间')
})
await test('复盘必须写说明', async () => {
  const advice = store.all()[0]!
  await assert.rejects(store.review(advice.adviceId, { outcome: 'supported', note: '', dataAsOf: '2026-12-16' }), /说明/)
})
await test('样本不足时不给“命中率”', () => {
  const stats = store.stats()
  assert.ok(stats.reviewed < 20)
  assert.ok(stats.hitRateNote.includes('样本不足'))
  assert.equal(stats.total, store.all().length)
})

console.log('== 参数校验与持久化 ==')
await test('validateAdvice 直接校验：缺 dataFreshness 报错', () => {
  const outcome = validateAdvice(baseInput({ dataFreshness: undefined as never }))
  assert.equal(outcome.ok, false)
  assert.ok(outcome.errors.some((e) => e.includes('dataFreshness')))
})
await test('promptHash 与资产顺序无关', () => {
  assert.equal(advicePromptHash('问题', ['600519', '000300']), advicePromptHash('问题', ['000300', '600519']))
})
await test('重载后建议仍在，且原始记录可读', async () => {
  const reloaded = new AdviceStore(dir)
  await reloaded.load()
  assert.equal(reloaded.all().length, store.all().length)
  const first = reloaded.all()[0]!
  const got = reloaded.get(first.adviceId)!
  assert.equal(got.recommendation, first.recommendation)
  assert.ok(Array.isArray(got.contradicting))
})
await rm(dir, { recursive: true, force: true })

console.log(`\n[investment] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exitCode = 1
} else {
  process.exitCode = 0
}
