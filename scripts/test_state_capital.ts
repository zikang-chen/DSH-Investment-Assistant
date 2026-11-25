/** Pure offline tests. No real data, network, persistence or account access. */
import assert from 'node:assert/strict'
import { STATE_CAPITAL_ENTITIES, resolveStateCapitalEntity, diffStateCapital, type StateCapitalDisclosure, type StateCapitalHolding } from '../src/state-capital.js'
let checks = 0
function check(name: string, run: () => void): void { run(); console.log(`PASS ${++checks}. ${name}`) }
const baseHolding: StateCapitalHolding = { key: 'stock:601288', name: '农业银行', code: '601288', assetType: 'stock', quantity: 1000, unit: '股', rawQuantity: '1000', percentage: 1, denominator: '总股本(%)', holdingMode: 'direct', asOf: '2026-06-30', disclosedAt: null, sourceUrl: 'https://example.invalid/fixture', sourceHash: 'a', locator: 'fixture' }
function h(p: Partial<StateCapitalHolding> = {}): StateCapitalHolding { return { ...baseHolding, ...p } }
function d(p: Partial<StateCapitalDisclosure> = {}): StateCapitalDisclosure { return { entityId: 'csf', entityName: '中国证券金融股份有限公司', scopeId: 'fixture:601288', asOf: '2026-06-30', disclosedAt: null, capturedAt: '2026-11-25T09:00:00Z', sources: [{ url: baseHolding.sourceUrl, title: 'offline fixture', hash: 'a', level: 'aggregated', publishedAt: null }], holdings: [h()], coverage: 'same explicit code pool', warnings: [], ...p } }
const previous = d()
const next = (holding: Partial<StateCapitalHolding> = {}) => d({ asOf: '2026-09-30', holdings: [h({ asOf: '2026-09-30', ...holding })] })
check('Only explicit registry legal names and exact aliases resolve', () => {
  assert.equal(STATE_CAPITAL_ENTITIES.length, 3)
  assert.equal(resolveStateCapitalEntity('汇金资产')?.id, 'huijin-asset')
  assert.equal(resolveStateCapitalEntity('中国证券金融股份有限公司')?.id, 'csf')
  for (const name of ['国新', '诚通', '全国社会保障基金理事会', '中国投资有限责任公司', '中央汇金投资有限责任公司-某产品', '某某中央国资']) assert.equal(resolveStateCapitalEntity(name), undefined)
})
check('First observation is not new purchase', () => {
  const result = diffStateCapital(undefined, next())
  assert.equal(result.status, 'first-observation'); assert.equal(result.rows[0]!.delta, null)
  assert.equal(result.rows[0]!.status, 'first-observation')
})
check('Comparable period-end quantity increase with unverified-actions warning', () => {
  const result = diffStateCapital(previous, next({ quantity: 1200 }))
  assert.equal(result.status, 'compared'); assert.equal(result.rows[0]!.status, 'quantity-increased'); assert.equal(result.rows[0]!.delta, 200)
  assert.ok(result.warnings.some(w => w.includes('拆分')))
})
check('Quantity decrease remains quantity only', () => {
  const row = diffStateCapital(previous, next({ quantity: 800 })).rows[0]!
  assert.equal(row.status, 'quantity-decreased'); assert.equal(row.delta, -200); assert.match(row.note, /不能认定主动买卖/)
})
check('Percentage falls but quantity unchanged is not reduction', () => {
  const row = diffStateCapital(previous, next({ percentage: 0.1 })).rows[0]!
  assert.equal(row.status, 'quantity-unchanged'); assert.equal(row.delta, 0)
})
check('Later absence is not zero or liquidation', () => {
  const row = diffStateCapital(previous, d({ holdings: [] })).rows[0]!
  assert.equal(row.status, 'not-disclosed'); assert.equal(row.nextQuantity, null); assert.equal(row.delta, null)
})
check('Null quantity later stays unknown', () => {
  const row = diffStateCapital(previous, next({ quantity: null, holdingMode: 'unknown' })).rows[0]!
  assert.equal(row.status, 'not-disclosed'); assert.equal(row.delta, null)
})
check('Newly disclosed row does not imply newly established position', () => {
  const row = diffStateCapital(d({ holdings: [] }), next()).rows[0]!
  assert.equal(row.status, 'newly-disclosed'); assert.equal(row.delta, null)
})
check('Unknown prior quantity does not get filled with zero', () => {
  const row = diffStateCapital(d({ holdings: [h({ quantity: null })] }), next()).rows[0]!
  assert.equal(row.status, 'newly-disclosed'); assert.equal(row.previousQuantity, null)
})
check('Explicit zero can be compared, not inferred from absence', () => {
  const row = diffStateCapital(previous, next({ quantity: 0 })).rows[0]!
  assert.equal(row.status, 'quantity-decreased'); assert.equal(row.delta, -1000)
})
check('Different entity is incomparable', () => assert.equal(diffStateCapital(previous, nextWith({ entityId: 'huijin' })).status, 'incomparable'))
function nextWith(p: Partial<StateCapitalDisclosure>): StateCapitalDisclosure { return { ...next(), ...p } }
check('Different code-pool scope is coverage change', () => {
  const result = diffStateCapital(previous, nextWith({ scopeId: 'fixture:600519,601288' }))
  assert.equal(result.status, 'coverage-changed'); assert.ok(result.rows.every(r => r.delta === null))
})
check('Coverage text change is explicit and does not infer exits', () => assert.equal(diffStateCapital(previous, nextWith({ coverage: 'different scope' })).status, 'coverage-changed'))
check('Units and holding modes cannot be mixed', () => {
  for (const override of [{ unit: '份' as const }, { holdingMode: 'indirect' as const }, { holdingMode: 'unknown' as const }, { assetType: 'equity' as const }]) assert.equal(diffStateCapital(previous, next(override)).rows[0]!.status, 'incomparable')
})
check('Unknown, invalid and reverse periods cannot compare', () => {
  for (const asOf of [null, '2026-02-30', '2025-12-31', 'not-a-date']) assert.equal(diffStateCapital(previous, next({ asOf })).rows[0]!.delta, null)
})
check('Same-period numerical revision is not a trade', () => {
  const result = diffStateCapital(previous, d({ holdings: [h({ quantity: 1100 })] }))
  assert.equal(result.status, 'same-period-revision'); assert.equal(result.rows[0]!.delta, null)
})
check('Same-period source revision remains revision even if quantity unchanged', () => {
  const result = diffStateCapital(previous, d({ sources: [{ ...previous.sources[0]!, hash: 'revised' }] }))
  assert.equal(result.rows[0]!.status, 'same-period-revision')
})
check('Rounding below display precision is not a material quantity change', () => {
  const result = diffStateCapital(d({ holdings: [h({ quantityPrecision: 1_000_000 })] }), next({ quantity: 1001, quantityPrecision: 1_000_000 }))
  assert.equal(result.rows[0]!.delta, null); assert.match(result.rows[0]!.note, /舍入/)
})
check('Invalid quantities do not become zero', () => {
  for (const quantity of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(diffStateCapital(previous, next({ quantity })).rows[0]!.status, 'incomparable')
})
check('Duplicate keys are rejected instead of silently overwritten', () => {
  const result = diffStateCapital(previous, d({ holdings: [h(), h()] }))
  assert.equal(result.status, 'incomparable'); assert.equal(result.rows.length, 0)
})
check('Inputs remain untouched', () => {
  const before = JSON.stringify(previous); diffStateCapital(previous, next()); assert.equal(JSON.stringify(previous), before)
})
console.log(`state-capital: ${checks} checks passed`)
