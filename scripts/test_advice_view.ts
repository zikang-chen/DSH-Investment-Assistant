/** Regression tests for 研究记录 robustness (schema + store + client view model). Offline. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeEvidence, normalizeEvidenceKind } from '../src/invest/schema.js'
import { AdviceStore, adviceBrief } from '../src/invest/store.js'
import { EVIDENCE_LABEL, normalizeAdviceDetail, normalizeAdviceRow } from '../src/client/workbench-model.js'

let passed = 0
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`) }

test('evidence kind aliases map agent free-form kinds onto the schema enum', () => {
  assert.equal(normalizeEvidenceKind('technical'), 'market')
  assert.equal(normalizeEvidenceKind('rate'), 'macro')
  assert.equal(normalizeEvidenceKind('currency'), 'macro')
  assert.equal(normalizeEvidenceKind('regime'), 'macro')
  assert.equal(normalizeEvidenceKind('positioning'), 'market')
  assert.equal(normalizeEvidenceKind('POLICY'), 'policy')
  assert.equal(normalizeEvidenceKind('something-weird'), 'research')
  assert.equal(normalizeEvidenceKind(undefined), 'research')
  const rows = normalizeEvidence([{ kind: 'technical', claim: 'c', source: 's', asOf: '2026-11-17' }, { claim: 'x' }])
  assert.equal(rows[0].kind, 'market')
  assert.equal(rows[1].kind, 'research')
  assert.equal(rows[1].claim, 'x')
})

test('every legacy evidence kind has a Chinese label (no raw English in UI)', () => {
  for (const kind of ['technical', 'rate', 'currency', 'regime', 'positioning', 'sentiment', 'flow', 'earnings']) {
    assert.equal(typeof EVIDENCE_LABEL[kind], 'string', `${kind} 缺少中文标签`)
    assert.match(EVIDENCE_LABEL[kind], /[\u4e00-\u9fa5]/, `${kind} 标签应为中文`)
  }
})

test('normalizeAdviceDetail fills missing arrays/objects instead of crashing', () => {
  const legacy = {
    adviceId: 'adv-1', userPrompt: 'q', createdAt: '2026-11-01',
    assets: undefined, market: 'gold', horizon: 'months',
    recommendation: 'WATCH',
    dataFreshness: 'fresh', // legacy string instead of object
    proposedAction: { summary: 's' }, // missing conditions
  }
  const view = normalizeAdviceDetail(legacy)
  assert.deepEqual(view.assets, [])
  assert.deepEqual(view.rationale, [])
  assert.deepEqual(view.calculationRefs, [])
  assert.deepEqual(view.scenarioAssumptions, [])
  assert.deepEqual(view.marketSnapshot, [])
  assert.deepEqual(view.reviews, [])
  assert.deepEqual(view.proposedAction!.conditions, [])
  assert.equal(view.dataFreshness.status, 'unknown')
  // Rendering-critical calls must not throw.
  assert.equal(view.rationale.map(x => x).length, 0)
  assert.equal(view.calculationRefs.join('；'), '')
})

test('normalizeAdviceRow tolerates missing list fields', () => {
  const row = normalizeAdviceRow({ adviceId: 'a', userPrompt: 'q' })
  assert.deepEqual(row.assets, [])
  assert.equal(row.supports, 0)
  assert.equal(row.contradicts, 0)
  assert.equal(row.dataFreshness, 'unknown')
  assert.equal(row.status, 'open')
})

test('AdviceStore.load normalizes partial records so list/brief never throw', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'advice-reg-'))
  try {
    await writeFile(path.join(dir, 'advices.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-11-17T00:00:00.000Z',
      advices: [
        { adviceId: 'ok', userPrompt: '完整', createdAt: '2026-11-17', assets: ['600519'], market: 'cn', horizon: 'months', recommendation: 'WATCH', supporting: [], contradicting: [], reviews: [], dataFreshness: { status: 'fresh', asOf: '2026-11-17', note: '' }, status: 'open', nextReviewAt: '2026-12-01' },
        { adviceId: 'partial', userPrompt: '缺数组', createdAt: '2026-11-16' }, // legacy / hand-edited
      ],
    }), 'utf8')
    const store = new AdviceStore(dir)
    await store.load()
    const rows = store.list({ limit: 10 })
    assert.equal(rows.length, 2)
    for (const r of rows) {
      const brief = adviceBrief(r)
      assert.equal(typeof brief.supports, 'number')
      assert.equal(Array.isArray(brief.assets), true)
      assert.equal(typeof brief.dataFreshness, 'string')
    }
    const partial = rows.find(r => r.adviceId === 'partial')!
    assert.deepEqual(partial.recommendationConditions, [])
    assert.deepEqual(partial.calculationRefs, [])
    assert.equal(partial.dataFreshness.status, 'unknown')
    assert.equal(partial.status, 'open')
    // A partial record must also survive the client view normalizer.
    assert.doesNotThrow(() => normalizeAdviceDetail(partial))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store.list asset filter tolerates records without assets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'advice-filter-'))
  try {
    await writeFile(path.join(dir, 'advices.json'), JSON.stringify({ version: 1, advices: [{ adviceId: 'x' }] }), 'utf8')
    const store = new AdviceStore(dir)
    await store.load()
    assert.equal(store.list({ asset: '600519' }).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
console.log(`[advice-view] ${passed} groups passed (offline).`)
