/**
 * 无私人数据的演示数据种子（Phase 6）。
 *
 * 安全约束：
 * - 只写入显式指定的目录（默认 data-demo/，在 .gitignore 里），**绝不写 data/**；
 * - 目录已存在时拒绝覆盖，除非传 --force；
 * - 数据全部是标着「示例」的教学数值，不是任何真实市场数据。
 *
 *   npx tsx scripts/seed_demo.ts                # → data-demo/
 *   npx tsx scripts/seed_demo.ts --dir C:\tmp\demo --force
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CapitalStore } from '../src/capital/ledger.js'
import { AdviceStore } from '../src/invest/store.js'
import { WealthPlanStore } from '../src/wealth/plans.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const root = path.resolve(arg('dir') ?? 'data-demo')
const force = process.argv.includes('--force')

if (root.endsWith(`${path.sep}data`) || root.endsWith('/data')) {
  console.error('拒绝写入真实数据目录 data/：演示数据必须放在独立目录')
  process.exit(1)
}

const { existsSync } = await import('node:fs')
if (existsSync(root) && !force) {
  console.error(`目录已存在：${root}\n如果确认要覆盖，加 --force（只会重写演示文件）`)
  process.exit(1)
}

await mkdir(root, { recursive: true })

// 1) 资本账本：示例账户 + 5 笔流水（金额是教学示例）
const capital = new CapitalStore(path.join(root, 'capital'))
await capital.load()
await capital.upsertAccount({ accountId: 'demo-a', name: '示例A股账户', accountType: 'securities', baseCurrency: 'CNY' })
const events = [
  { accountId: 'demo-a', eventType: 'DEPOSIT' as const, occurredAt: '2026-01-05', grossAmount: 100_000, currency: 'CNY', source: 'demo', sourceTransactionId: 'demo-d1' },
  { accountId: 'demo-a', eventType: 'BUY' as const, occurredAt: '2026-01-06', assetId: '000300', quantity: 1000, price: 4.0, currency: 'CNY', fee: 5, source: 'demo', sourceTransactionId: 'demo-b1' },
  { accountId: 'demo-a', eventType: 'BUY' as const, occurredAt: '2026-02-02', assetId: '510300', quantity: 2000, price: 3.9, currency: 'CNY', fee: 5, source: 'demo', sourceTransactionId: 'demo-b2' },
  { accountId: 'demo-a', eventType: 'DIVIDEND' as const, occurredAt: '2026-03-10', assetId: '000300', grossAmount: 800, tax: 0, currency: 'CNY', source: 'demo', sourceTransactionId: 'demo-v1' },
  { accountId: 'demo-a', eventType: 'SELL' as const, occurredAt: '2026-04-08', assetId: '510300', quantity: 500, price: 4.2, currency: 'CNY', fee: 5, tax: 2, source: 'demo', sourceTransactionId: 'demo-s1' },
]
for (const event of events) {
  await capital.appendEvent(event as never)
}

// 2) 投资建议：一条可验证的判断 + 一条证据不足（演示反证强制与 INSUFFICIENT_DATA 的形态）
const advice = new AdviceStore(path.join(root, 'investment'))
await advice.load()
const created = await advice.create({
  userPrompt: '【示例】现在沪深300适不适合配置？',
  assets: ['000300'],
  market: 'cn',
  horizon: 'months',
  investmentGoal: '长期配置',
  recommendation: 'WATCH',
  recommendationConditions: ['社零与工业企业利润连续两月改善'],
  rationale: ['估值处于近五年中位数下方', '盈利预期尚未上修'],
  supporting: [{ kind: 'valuation', claim: '【示例】PE 处于近五年 35% 分位', source: '示例数据（非真实行情）', asOf: '2026-11-16' }],
  contradicting: [{ kind: 'macro', claim: '【示例】10 月社零同比仅增 1.0%，内需偏弱', source: '示例数据（非真实统计）', asOf: '2026-11-16' }],
  invalidationConditions: ['若社零与利润连续两月改善，观望理由消失'],
  marketSnapshot: [{ asOf: '2026-11-16', note: '【示例】收盘 3900 点（非真实价格）' }],
  dataFreshness: { status: 'fresh', asOf: '2026-11-16', note: '示例数据' },
  valuationSummary: '【示例】PE 分位 35%，股息率 2.4%',
  riskConstraints: ['单类资产不超过总资产 40%'],
  scenarioAssumptions: ['不假设政策强刺激'],
  nextReviewAt: '2026-12-15',
  unresolvedQuestions: ['缺少社融结构数据'],
  calculationRefs: ['示例：估值分位来自固定假设'],
})
await advice.create({
  userPrompt: '【示例】黄金未来三个月还有投资价值吗？',
  assets: ['黄金'],
  market: 'gold',
  horizon: 'months',
  recommendation: 'INSUFFICIENT_DATA',
  dataFreshness: { status: 'unknown', asOf: '2026-11-16', note: '示例：无实时数据' },
  unresolvedQuestions: ['缺少实际利率与 ETF 持仓数据'],
  proposedAction: null,
})

// 3) 复利情景：稳健 / 压力（名字只是标签，不代表概率）
const plans = new WealthPlanStore(path.join(root, 'wealth'))
await plans.load()
for (const [name, annualRate] of [['【示例】稳健', 0.05], ['【示例】压力', 0.02]] as const) {
  await plans.save({
    name,
    principalCents: 10_000_000,
    contributionCents: 200_000,
    frequency: 'monthly',
    timing: 'end',
    annualRate,
    annualFee: 0.006,
    inflation: 0.03,
    years: 10,
    contributionGrowth: 0.03,
    notes: '教学示例：数值为假设，不是收益预测',
  })
}

// 4) 说明文件：让使用者一眼知道这是示例
await writeFile(path.join(root, 'README.md'), [
  '# 演示数据（非真实数据）',
  '',
  '本目录由 `scripts/seed_demo.ts` 生成，全部金额/数值都是**教学示例**，不是真实行情、不是真实持仓。',
  '它不会写入 `data/`（真实数据目录）。',
  '',
  '启动 DSH 时把插件配置的 `dataDir` 指向本目录，即可在不接触真实数据的情况下体验面板。',
  '',
  '删除：直接删掉整个目录即可。',
].join('\n'), 'utf8')

console.log(`演示数据已生成：${root}`)
console.log(`  资本账本：1 个账户 / ${events.length} 笔流水`)
console.log(`  投资建议：${advice.all().length} 条（含 1 条 INSUFFICIENT_DATA）`)
console.log(`  复利方案：${plans.all().length} 个`)
console.log('  全部为教学示例，不含真实数据。')
