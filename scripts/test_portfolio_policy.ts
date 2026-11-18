import assert from 'node:assert/strict';
import { evaluatePortfolioPolicy, type PortfolioPolicyInput } from '../src/strategy/portfolio-policy.js';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
function fixture(): PortfolioPolicyInput {
  return {
    asOf: '2026-11-17', baseCurrency: 'CNY',
    positions: [
      { id: 'a', assetClass: 'equity', currency: 'USD', currentWeight: 0.5, targetWeight: 0.4, priceAsOf: '2026-11-17' },
      { id: 'b', assetClass: 'bond', currency: 'CNY', currentWeight: 0.3, targetWeight: 0.4, priceAsOf: '2026-11-16', minWeight: 0.1, maxWeight: 0.5 },
    ], cashWeight: 0.2, targetCashWeight: 0.2,
    constraints: { maxAssetWeight: 0.6, maxAssetClassWeight: 0.7, minCashWeight: 0.1, maxTurnover: 0.3, driftThreshold: 0.05 },
    review: { lastReviewedAt: '2026-11-16', cadenceDays: 7 },
  };
}
const approx = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function invalid(value: unknown) { const r = evaluatePortfolioPolicy(value as PortfolioPolicyInput); assert.equal(r.ok, false); assert.equal(r.status, 'BLOCKED'); assert.ok(r.errors.length); assert.equal(r.proposed, undefined); return r; }

test('portfolio concentration, currencies, drift and bilateral turnover', () => {
  const r = evaluatePortfolioPolicy(fixture());
  assert.equal(r.ok, true); assert.equal(r.status, 'REVIEW_REQUIRED');
  approx(r.current?.hhi, 0.38); approx(r.target?.hhi, 0.36);
  approx(r.current?.top1, 0.5); approx(r.target?.top1, 0.4);
  approx(r.current?.currencyWeights.CNY, 0.5); approx(r.current?.currencyWeights.USD, 0.5);
  approx(r.target?.assetClassWeights.equity, 0.4); approx(r.turnover, 0.1);
  approx(r.drifts?.[0].drift, 0.1); assert.ok(r.proposed);
});
test('cash counted in turnover and concentration', () => {
  const f = fixture(); f.positions[0].targetWeight = 0.3; f.targetCashWeight = 0.3;
  const r = evaluatePortfolioPolicy(f); approx(r.turnover, 0.2); approx(r.target?.cash, 0.3); approx(r.cashDrift, -0.1);
});
test('within policy no drift, not due, no evidence', () => {
  const f = fixture(); f.positions.forEach(p => p.currentWeight = p.targetWeight);
  const r = evaluatePortfolioPolicy(f); assert.equal(r.status, 'WITHIN_POLICY'); assert.equal(r.triggers.length, 0);
});
test('due cadence exact boundary, missing review and leap day', () => {
  const f = fixture(); f.review.lastReviewedAt = '2026-11-10';
  assert.ok(evaluatePortfolioPolicy(f).triggers.some(t => t.kind === 'due'));
  delete f.review.lastReviewedAt; assert.ok(evaluatePortfolioPolicy(f).triggers.some(t => t.kind === 'due'));
  f.asOf = '2024-03-01'; f.review = { lastReviewedAt: '2024-02-29', cadenceDays: 1 };
  assert.equal(evaluatePortfolioPolicy(f).ok, true);
});
test('empty and malformed structures fail without throwing', () => {
  for (const x of [null, undefined, '', [], {}, { positions: [null] }]) invalid(x);
  for (const n of [0, 1, 21]) { const f = fixture(); f.positions = Array.from({ length: n }, (_, i) => ({ ...fixture().positions[0], id: `a${i}` })); invalid(f); }
});
test('finite weights, strings, duplicate ids and no normalization', () => {
  for (const n of [NaN, Infinity, -Infinity, -0.1, 1.1, '0.5', null]) { const f = fixture(); (f.positions[0] as any).currentWeight = n; invalid(f); }
  const duplicate = fixture(); duplicate.positions[1].id = 'a'; invalid(duplicate);
  const total = fixture(); total.cashWeight = 0.19; invalid(total);
  const target = fixture(); target.targetCashWeight = 0.19; invalid(target);
  for (const key of ['id', 'currency', 'assetClass'] as const) { const f = fixture(); f.positions[0][key] = ' '; invalid(f); }
  const noTarget = fixture(); delete (noTarget.positions[0] as any).targetWeight; invalid(noTarget);
});
test('real strict calendar dates, cadence, and last review future', () => {
  for (const s of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-11-00', '2026-1-01', '2026-11-17T00:00:00Z', '0000-01-01', 'garbage']) { const f = fixture(); f.asOf = s; invalid(f); }
  for (const n of [0, -1, 1.5, Infinity, NaN]) { const f = fixture(); f.review.cadenceDays = n; invalid(f); }
  const f = fixture(); f.review.lastReviewedAt = '2026-11-18'; invalid(f);
  f.review.lastReviewedAt = '2026-02-30'; invalid(f);
  const p = fixture(); p.positions[0].priceAsOf = '2026-02-30'; invalid(p);
});
test('target constraints single / class / cash / turnover / per-asset', () => {
  const cases: Array<[string, (f: PortfolioPolicyInput) => void]> = [
    ['single', f => { f.constraints.maxAssetWeight = 0.35; }],
    ['assetClass', f => { f.positions[1].assetClass = 'equity'; }],
    ['cash', f => { f.constraints.minCashWeight = 0.3; }],
    ['turnover', f => { f.constraints.maxTurnover = 0.05; }],
    ['perAsset', f => { f.positions[0].minWeight = 0.45; }],
    ['perAsset', f => { f.positions[0].maxWeight = 0.35; }],
  ];
  for (const [kind, alter] of cases) {
    const f = fixture(); alter(f); const r = evaluatePortfolioPolicy(f);
    assert.equal(r.ok, true); assert.equal(r.status, 'BLOCKED'); assert.equal(r.proposed, undefined);
    assert.ok(r.constraintChecks?.some(c => c.kind === kind && !c.satisfied));
    assert.ok(r.triggers.some(t => t.kind === 'constraintBreach'));
  }
});
test('inverted bounds invalid; invalid global constraints rejected', () => {
  const f = fixture(); f.positions[0].minWeight = 0.7; f.positions[0].maxWeight = 0.2; invalid(f);
  for (const k of Object.keys(f.constraints) as Array<keyof typeof f.constraints>) { const x = fixture(); x.constraints[k] = NaN; invalid(x); }
});
test('current breach can be corrected by compliant target', () => {
  const f = fixture(); f.positions[0].currentWeight = 0.65; f.positions[1].currentWeight = 0.15;
  const r = evaluatePortfolioPolicy(f); assert.equal(r.status, 'REVIEW_REQUIRED'); assert.ok(r.proposed);
});
test('market and international topics do not change targets; 30-day inclusion', () => {
  const f = fixture(); f.signals = [
    { topic: 'market breadth', claim: 'Supplied market observation', source: 'fixture source', asOf: '2026-11-17', direction: 'risk' },
    { topic: 'international monetary policy', claim: 'Supplied international observation', source: 'fixture source 2', asOf: '2026-10-18', direction: 'support' },
    { topic: 'arbitrary topic', claim: 'Neutral observation', source: 'fixture source 3', asOf: '2026-11-17', direction: 'neutral' },
  ];
  const r = evaluatePortfolioPolicy(f); assert.equal(r.acceptedSignals.length, 3);
  assert.ok(r.triggers.some(t => t.kind === 'evidenceRisk')); assert.ok(r.triggers.some(t => t.kind === 'evidenceSupport'));
  assert.deepEqual(r.proposed?.weights, [{ id: 'a', weight: 0.4 }, { id: 'b', weight: 0.4 }]);
  assert.equal(r.policyHash, evaluatePortfolioPolicy(fixture()).policyHash);
});
test('future and >30-day evidence excluded with gaps; no evidence trigger', () => {
  const f = fixture(); f.signals = ['2026-11-18', '2026-10-17'].map(asOf => ({ topic: 'anything', claim: 'unusable', source: 'fixture', asOf, direction: 'risk' }));
  const r = evaluatePortfolioPolicy(f); assert.equal(r.acceptedSignals.length, 0); assert.equal(r.excludedSignals.length, 2);
  assert.ok(r.gaps.some(g => g.includes('future evidence'))); assert.ok(r.gaps.some(g => g.includes('stale evidence')));
  assert.ok(!r.triggers.some(t => t.kind === 'evidenceRisk')); assert.ok(r.proposed);
});
test('every evidence source and field required, invalid dates rejected', () => {
  const signal = { topic: 'market', claim: 'test', source: 'fixture', asOf: '2026-11-17', direction: 'risk' as const };
  for (const key of Object.keys(signal)) { const f = fixture(); const s = { ...signal }; delete (s as any)[key]; f.signals = [s]; invalid(f); }
  const f = fixture(); f.signals = [{ ...signal, source: ' ' }]; invalid(f);
  f.signals = [{ ...signal, asOf: '2026-02-30' }]; invalid(f);
});
test('missing/future/stale prices retain mathematics but no proposal', () => {
  for (const price of [undefined, '2026-11-18', '2026-10-17']) {
    const f = fixture(); f.positions[0].priceAsOf = price; const r = evaluatePortfolioPolicy(f);
    assert.equal(r.ok, true); assert.ok(r.current); assert.equal(r.proposed, undefined); assert.equal(r.executionReady, false); assert.ok(r.gaps.some(g => g.startsWith('a:')));
  }
  const f = fixture(); f.positions[0].priceAsOf = '2026-10-18'; assert.ok(evaluatePortfolioPolicy(f).proposed);
});
test('frozen input immutability, no output aliasing, deterministic hashes', () => {
  const f = fixture(); f.signals = [{ topic: 'market', claim: 'test', source: 'fixture', asOf: '2026-11-17', direction: 'neutral' }];
  const before = JSON.stringify(f);
  function freeze(x: any): void { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } }
  freeze(f); const r = evaluatePortfolioPolicy(f); const again = evaluatePortfolioPolicy(f);
  assert.deepEqual(r, again); assert.equal(JSON.stringify(f), before); assert.match(r.policyHash, /^fnv1a64:[a-f0-9]{16}$/);
  r.acceptedSignals[0].claim = 'mutated output'; assert.equal(f.signals[0].claim, 'test');
  const reordered = { review: f.review, constraints: f.constraints, targetCashWeight: f.targetCashWeight, cashWeight: f.cashWeight, positions: f.positions, baseCurrency: f.baseCurrency, asOf: f.asOf, signals: f.signals };
  assert.equal(evaluatePortfolioPolicy(reordered).inputHash, again.inputHash);
  const changed = fixture(); changed.positions[0].currentWeight -= 0.01; changed.cashWeight += 0.01;
  assert.equal(evaluatePortfolioPolicy(changed).policyHash, evaluatePortfolioPolicy(fixture()).policyHash);
  assert.notEqual(evaluatePortfolioPolicy(changed).inputHash, evaluatePortfolioPolicy(fixture()).inputHash);
  changed.positions[0].targetWeight -= 0.01; changed.targetCashWeight += 0.01;
  assert.notEqual(evaluatePortfolioPolicy(changed).policyHash, evaluatePortfolioPolicy(fixture()).policyHash);
});
test('safety flags always conservative including invalid input', () => {
  for (const r of [evaluatePortfolioPolicy(fixture()), evaluatePortfolioPolicy(null as any)]) {
    assert.equal(r.requiresApproval, true); assert.equal(r.autoChange, false); assert.equal(r.writesLedger, false);
    assert.equal(r.executesTrades, false); assert.equal(r.executionReady, false);
    assert.ok(r.assumptions.some(a => a.includes('FX rates')));
  }
});
test('cash dominant and hostile dictionary keys are safe', () => {
  const f = fixture(); f.positions[0].currentWeight = 0.1; f.positions[1].currentWeight = 0.1; f.cashWeight = 0.8;
  f.positions[0].assetClass = '__proto__'; f.positions[1].currency = 'constructor';
  const r = evaluatePortfolioPolicy(f); approx(r.current?.top1, 0.8); approx(r.current?.hhi, 0.66);
  approx(r.current?.assetClassWeights['__proto__'], 0.1); approx(r.current?.currencyWeights.constructor as unknown as number, 0.1);
});
console.log(`Portfolio policy: ${passed} tests passed (offline, no asset access or trades).`);
