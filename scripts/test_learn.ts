/**
 * 金融学习 — 离线测试。
 *
 *   npx tsx scripts/test_learn.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CONCEPTS, detectConcepts, findConcept, searchConcepts } from '../src/learn/concepts.js'
import { LearningStore, categorySummary, explain } from '../src/learn/explain.js'

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

console.log('== 词条与检索 ==')
await test('M2 能查到，且三级解释都存在', () => {
  const concept = findConcept('M2')
  assert.ok(concept)
  assert.equal(concept!.conceptId, 'm2')
  assert.ok(concept!.beginner.length > 10)
  assert.ok(concept!.intermediate.length > 10)
  assert.ok(concept!.advanced.length > 10)
})
await test('别名归一化：PE / P/E / 市盈率 指向同一概念', () => {
  const ids = ['PE', 'P/E', '市盈率', 'pe_ratio'].map((alias) => findConcept(alias)?.conceptId)
  assert.ok(ids.every((id) => id === 'pe'), JSON.stringify(ids))
})
await test('不同口径不合并：社融增量与存量在同一个概念里用规则区分', () => {
  const concept = findConcept('社融')
  assert.ok(concept)
  const rules = concept!.interpretationRules.join(' ')
  assert.ok(rules.includes('增量') && rules.includes('存量'), rules)
  assert.ok(concept!.misconceptions.some((m) => m.includes('存量')), '必须写明常见误读')
})
await test('搜索按分类过滤', () => {
  const macro = searchConcepts('', { category: 'macro-cn' })
  assert.ok(macro.length >= 5)
  assert.ok(macro.every((c) => c.category === 'macro-cn'))
  const hit = searchConcepts('回撤')
  assert.ok(hit.some((c) => c.conceptId === 'max-drawdown'))
})
await test('分类概览返回计数', () => {
  const summary = categorySummary()
  const total = summary.reduce((sum, item) => sum + item.count, 0)
  assert.equal(total, CONCEPTS.length)
})

console.log('== 三级解释 ==')
await test('同一概念三级文本不同，标签正确', () => {
  const beginner = explain('m2', 'beginner')
  const intermediate = explain('m2', 'intermediate')
  const advanced = explain('m2', 'advanced')
  assert.ok(beginner.ok && intermediate.ok && advanced.ok)
  assert.equal(beginner.ok && beginner.explanation.levelLabel, '小白版')
  assert.equal(intermediate.ok && intermediate.explanation.levelLabel, '进阶版')
  assert.equal(advanced.ok && advanced.explanation.levelLabel, '专业版')
  const texts = [beginner, intermediate, advanced].map((r) => (r.ok ? r.explanation.text : ''))
  assert.equal(new Set(texts).size, 3, '三级解释不能是同一段文字')
})
await test('未知概念明确报错，不编内容', () => {
  const result = explain('不存在的词')
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.error.includes('没有这个概念'))
})

console.log('== 上下文解释（不编数字） ==')
await test('带页面数值时给出「怎么读」，且声明不含实时数据', () => {
  const result = explain('social-financing', 'beginner', { page: 'macro', value: '3.2 万亿元', period: '2026年10月' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.ok(result.explanation.contextNote.includes('3.2 万亿元'))
  assert.ok(result.explanation.contextNote.includes('口径'))
  assert.ok(result.explanation.dataNote.includes('不含任何实时行情'))
})
await test('没有数值时不编造数值', () => {
  const result = explain('gdp', 'beginner', { page: 'macro' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.ok(!/\d+\.\d+%/.test(result.explanation.contextNote), `不应出现具体百分比：${result.explanation.contextNote}`)
})
await test('PE 解释包含「高 PE 不一定跌」的误区提醒', () => {
  const result = explain('pe', 'intermediate')
  assert.ok(result.ok)
  if (!result.ok) return
  assert.ok(result.explanation.concept.misconceptions.some((m) => m.includes('高') && m.includes('跌')))
})

console.log('== 术语识别（用于解释投资建议） ==')
await test('从投资判断文本中识别 PE / 估值分位 / ROE', () => {
  const text = '该企业当前 PE 高于过去五年历史分位，但 ROE 稳定在 18%。'
  const hits = detectConcepts(text).map((c) => c.conceptId)
  assert.ok(hits.includes('pe'))
  assert.ok(hits.includes('pe-percentile') || hits.includes('pe'))
  assert.ok(hits.includes('roe'), JSON.stringify(hits))
})

console.log('== 学习进度（持久化） ==')
const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-learn-'))
const store = new LearningStore(dir)
await store.load()
await test('查看记录累加，标记收藏/已理解可叠加', async () => {
  const first = await store.touch('m2')
  assert.equal(first.viewCount, 1)
  assert.ok(first.statuses.includes('seen'))
  await store.touch('m2')
  const favorited = await store.setStatus('m2', 'favorite', true)
  assert.ok(favorited.statuses.includes('favorite'))
  const understood = await store.setStatus('m2', 'understood', true)
  assert.deepEqual([...understood.statuses].sort(), ['favorite', 'seen', 'understood'])
  const unfavorited = await store.setStatus('m2', 'favorite', false)
  assert.ok(!unfavorited.statuses.includes('favorite'))
})
await test('未知概念不能记录状态', async () => {
  await assert.rejects(store.setStatus('not-a-concept', 'favorite', true), /未知概念/)
})
await test('重载后学习状态仍在', async () => {
  const reloaded = new LearningStore(dir)
  await reloaded.load()
  const state = reloaded.get('m2')!
  assert.equal(state.viewCount, 2)
  assert.ok(state.statuses.includes('understood'))
  const stats = reloaded.stats()
  assert.equal(stats.tracked, 1)
  assert.equal(stats.understood, 1)
  assert.ok(stats.mostViewed.some((x) => x.conceptId === 'm2' && x.viewCount === 2))
})
await rm(dir, { recursive: true, force: true })

console.log(`\n[learn] ${passed} passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'))
  process.exitCode = 1
} else {
  process.exitCode = 0
}
