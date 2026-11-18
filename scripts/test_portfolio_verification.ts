import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyPortfolioData, type PortfolioVerificationInput } from '../src/strategy/portfolio-verification.js';

let count = 0;
function test(name: string, body: () => void) { body(); count++; console.log(`PASS ${name}`); }
const near = (a: number, b: number, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function fixture(): PortfolioVerificationInput {
  return {
    asOf: '2026-11-18', baseCurrency: 'CNY',
    positions: [
      { id: 'A', currency: 'CNY', quantity: 10, price: 100, priceAsOf: '2026-11-18', priceSource: 'explicit A', assetClass: 'equity' },
      { id: 'B', currency: 'USD', quantity: 2, price: 50, priceAsOf: '2026-11-11', priceSource: 'explicit B', assetClass: 'equity' },
    ],
    cash: [{ currency: 'USD', amount: 100 }, { currency: 'CNY', amount: 600 }],
    fx: [{ currency: 'USD', baseCurrency: 'CNY', rate: 7, asOf: '2026-11-11', source: 'explicit FX' }], histories: [],
  };
}
function history(id: string, values: number[], currency = 'CNY') {
  return { id, currency, points: values.map((close, i) => ({ date: new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10), close })) };
}
function sameCurrency(): PortfolioVerificationInput {
  const i = fixture(); i.positions[1].currency = 'CNY'; i.cash = []; i.fx = [];
  return i;
}

test('real FX arithmetic, cash weights, native denomination exposure, immutable', () => {
  const i = fixture(), snapshot = JSON.stringify(i), r = verifyPortfolioData(i);
  assert.equal(r.valid, true); assert.equal(r.completeValuation, true); assert.equal(r.canCreatePolicy, true);
  assert.equal(r.pricedKnownValue, 3000);
  near(r.weights!.find(w => w.id === 'B')!.weight, 700 / 3000);
  near(r.weights!.filter(w => w.kind === 'cash').reduce((s, w) => s + w.weight, 0), 1300 / 3000);
  near(r.currencyExposures!.find(c => c.currency === 'USD')!.weight, 1400 / 3000);
  assert.equal(JSON.stringify(i), snapshot);
});
test('unknown FX never turns into zero or known-only total weights', () => {
  const i = fixture(); i.fx = []; const r = verifyPortfolioData(i);
  assert.equal(r.pricedKnownValue, 1600); assert.equal(r.unknownAssets.length, 2);
  assert.equal(r.completeValuation, false); assert.equal(r.canCreatePolicy, false);
  assert.equal('weights' in r, false); assert.equal('currencyExposures' in r, false);
  assert.equal(r.unknownFundWeight, null);
});
test('missing source/date, future and stale prices are unvalued', () => {
  for (const patch of [{ priceAsOf: '2026-11-19' }, { priceAsOf: '2026-11-10' }, { priceSource: undefined }, { priceAsOf: undefined }, { price: undefined }]) {
    const i = fixture(); Object.assign(i.positions[0], patch); const r = verifyPortfolioData(i);
    assert.equal(r.completeValuation, false); assert.equal(r.weights, undefined);
    assert.ok(r.unknownAssets.some(a => a.id === 'A'));
  }
});
test('FX future/stale/missing source and invalid finite inputs rejected', () => {
  for (const date of ['2026-11-19', '2026-11-10']) {
    const i = fixture(); i.fx[0].asOf = date; assert.equal(verifyPortfolioData(i).completeValuation, false);
  }
  for (const rate of [0, -1, Infinity, NaN]) {
    const i = fixture(); i.fx[0].rate = rate; assert.equal(verifyPortfolioData(i).valid, false);
  }
  const i = fixture(); i.fx[0].source = ''; assert.equal(verifyPortfolioData(i).valid, false);
});
test('strict IDs, calendar dates, finite and nonnegative quantities, empty/zero', () => {
  for (const quantity of [-1, Infinity, NaN]) {
    const i = fixture(); i.positions[0].quantity = quantity; assert.equal(verifyPortfolioData(i).valid, false);
  }
  for (const price of [0, -1, Infinity, NaN]) {
    const i = fixture(); i.positions[0].price = price; assert.equal(verifyPortfolioData(i).valid, false);
  }
  const dup = fixture(); dup.positions[1].id = 'A'; assert.equal(verifyPortfolioData(dup).valid, false);
  for (const asOf of ['2026-02-30', '2026-2-01', '0000-01-01', 'garbage']) {
    const i = fixture(); i.asOf = asOf; assert.equal(verifyPortfolioData(i).valid, false);
  }
  const empty = fixture(); empty.positions = []; empty.cash = []; assert.equal(verifyPortfolioData(empty).valid, false);
  const zero = fixture(); zero.positions.forEach(p => p.quantity = 0); zero.cash = [];
  assert.equal(verifyPortfolioData(zero).completeValuation, false);
  assert.equal(verifyPortfolioData(null as unknown as PortfolioVerificationInput).valid, false);
});
test('top-N fund residual, no double counting fund parent, direct overlap aggregation', () => {
  const i = sameCurrency(); i.positions[0].assetClass = 'fund';
  i.fundHoldings = [{ fundId: 'A', asOf: '2026-07-21', source: 'filing', holdings: [{ id: 'B', weight: 0.3 }, { id: 'X', weight: 0.2 }] }];
  const r = verifyPortfolioData(i);
  assert.equal(r.fundCoverage[0].usable, true); assert.equal(r.unknownFundValue, 500);
  near(r.unknownFundWeight!, 500 / 1100);
  assert.equal(r.knownLookthrough.some(h => h.id === 'A'), false);
  assert.equal(r.knownLookthrough.find(h => h.id === 'B')!.value, 400);
  near(r.knownLookthrough.reduce((s, h) => s + h.value, 0) + r.unknownFundValue, 1100);
  assert.ok(r.gaps.some(g => g.includes('top-N')));
  i.fundHoldings[0].asOf = '2026-07-20';
  const stale = verifyPortfolioData(i); assert.equal(stale.unknownFundValue, 1000); assert.equal(stale.fundCoverage[0].usable, false);
});
test('missing fund disclosure all unknown; invalid disclosed totals/duplicates rejected', () => {
  const i = sameCurrency(); i.positions[0].assetClass = 'etf';
  assert.equal(verifyPortfolioData(i).unknownFundValue, 1000);
  i.fundHoldings = [{ fundId: 'A', asOf: i.asOf, source: 'filing', holdings: [{ id: 'X', weight: 0.6 }, { id: 'Y', weight: 0.5 }] }];
  assert.equal(verifyPortfolioData(i).valid, false);
  i.fundHoldings[0].holdings = [{ id: 'X', weight: 0.2 }, { id: 'X', weight: 0.2 }];
  assert.equal(verifyPortfolioData(i).valid, false);
});
test('sample covariance n-1, 252 annualization and correlation true arithmetic', () => {
  const i = sameCurrency(); const a = [100], b = [200];
  const returns = Array.from({ length: 30 }, (_, n) => n % 2 ? -0.01 : 0.02);
  returns.forEach(r => { a.push(a[a.length - 1] * (1 + r)); b.push(b[b.length - 1] * (1 + 2 * r)); });
  i.histories = [history('A', a), history('B', b)];
  const c = verifyPortfolioData(i).covariance!; assert.ok(c); assert.equal(c.observations, 30);
  const expectedVar = (15 * 0.015 ** 2 + 15 * 0.015 ** 2) / 29;
  near(c.daily[0][0], expectedVar); near(c.daily[0][1], expectedVar * 2);
  near(c.annualized[0][0], expectedVar * 252); near(c.correlations[0][1]!, 1);
  assert.equal(c.currency, 'CNY');
});
test('constant series yields null correlations, insufficient/missing dates never fill', () => {
  const i = sameCurrency(); i.histories = [history('A', Array(31).fill(100)), history('B', Array(31).fill(50))];
  const c = verifyPortfolioData(i).covariance!; assert.equal(c.daily[0][0], 0); assert.equal(c.correlations[0][1], null);
  i.histories[1].points.pop(); assert.equal(verifyPortfolioData(i).covariance, null);
  i.histories = []; assert.equal(verifyPortfolioData(i).covariance, null);
});
test('history duplicates, invalid calendar/price/future reject entire sequence', () => {
  for (const patch of [{ date: '2026-02-30' }, { date: '2027-01-01' }, { close: 0 }, { close: Infinity }, { date: '2026-10-02' }]) {
    const i = sameCurrency(); i.histories = [history('A', Array(31).fill(100)), history('B', Array(31).fill(50))];
    Object.assign(i.histories[0].points[0], patch); const r = verifyPortfolioData(i);
    assert.equal(r.covariance, null); assert.equal(r.provenance.histories[0].accepted, false);
  }
});
test('mixed currency covariance rejected despite current FX; same foreign currency never claims base returns', () => {
  const i = fixture(); i.histories = [history('A', Array(31).fill(100)), history('B', Array(31).fill(50), 'USD')];
  const r = verifyPortfolioData(i); assert.equal(r.covariance, null); assert.ok(r.gaps.some(g => g.includes('mixed currencies')));
  i.positions[0].currency = 'USD'; i.histories[0].currency = 'USD';
  assert.equal(verifyPortfolioData(i).covariance!.currency, 'USD');
  assert.ok(verifyPortfolioData(i).covariance!.basis.includes('no historical FX'));
});
test('interior history gaps never substitute multi-day returns; future fund disclosure unusable', () => {
  const i = sameCurrency();
  i.histories = [history('A', Array.from({ length: 32 }, (_, n) => 100 + n)), history('B', Array.from({ length: 32 }, (_, n) => 50 + n))];
  i.histories[1].points.splice(15, 1);
  const r = verifyPortfolioData(i);
  assert.equal(r.covariance, null); // 31 common prices, but only 29 genuine common daily returns.
  i.positions[0].assetClass = 'fund';
  i.fundHoldings = [{ fundId: 'A', asOf: '2026-11-19', source: 'filing', holdings: [{ id: 'X', weight: 1 }] }];
  const future = verifyPortfolioData(i);
  assert.equal(future.fundCoverage[0].usable, false); assert.equal(future.unknownFundValue, 1000);
});
test('cash-only/one-position cannot create policy', () => {
  const i = fixture(); i.positions = []; assert.equal(verifyPortfolioData(i).completeValuation, true); assert.equal(verifyPortfolioData(i).canCreatePolicy, false);
  i.positions = fixture().positions.slice(0, 1); assert.equal(verifyPortfolioData(i).canCreatePolicy, false);
});
test('browser core has no imports, Node, real account, network or trading access', () => {
  const source = readFileSync(new URL('../src/strategy/portfolio-verification.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s|node:|\brequire\s*\(|\bprocess\.|\bfetch\s*\(|XMLHttpRequest|readFile|portfolio\.json/);
});
console.log(`${count} portfolio verification tests passed`);
