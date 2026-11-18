import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortfolioVersionStore } from '../src/strategy/portfolio-versions.js';
import type { PortfolioPolicyInput } from '../src/strategy/portfolio-policy.js';

const policy = (): PortfolioPolicyInput => ({
  asOf: '2026-11-17', baseCurrency: 'CNY',
  positions: [
    { id: 'a', assetClass: 'equity', currency: 'CNY', currentWeight: .4, targetWeight: .35, priceAsOf: '2026-11-17' },
    { id: 'b', assetClass: 'bond', currency: 'CNY', currentWeight: .4, targetWeight: .4, priceAsOf: '2026-11-17' },
  ], cashWeight: .2, targetCashWeight: .25,
  constraints: { maxAssetWeight: .5, maxAssetClassWeight: .6, minCashWeight: .1, maxTurnover: .2, driftThreshold: .03 },
  review: { cadenceDays: 30 },
});
const dir = await mkdtemp(path.join(os.tmpdir(), 'portfolio-versions-'));
let assertions = 0;
function check(condition: unknown): void { assert.ok(condition); assertions++; }
async function rejects(work: () => Promise<unknown>, expected?: RegExp): Promise<void> {
  await assert.rejects(work, expected); assertions++;
}
try {
  const store = new PortfolioVersionStore(dir);
  check((await store.list()).length === 0);
  const original = policy();
  const pending = store.save({ policy: original, name: 'Paper allocation', reason: 'Initial explicit weights' });
  original.positions[0].targetWeight = .9;
  const saved = await pending;
  check(saved.policy.positions[0].targetWeight === .35 && saved.revision === 1 && saved.version === 1);
  saved.policy.positions[0].targetWeight = .99;
  const reload = new PortfolioVersionStore(dir);
  const root = (await reload.get(saved.id))!;
  check(root.policy.positions[0].targetWeight === .35);
  const listing = await reload.list(); listing[0].history[0].reason = 'MUTATED';
  check((await store.get(saved.id))!.history[0].reason !== 'MUTATED');
  const childPolicy = policy(); childPolicy.review.cadenceDays = 45;
  const child = await store.save({ policy: childPolicy, name: 'v2', parentId: saved.id, expectedParentRevision: 1, reason: 'Different cadence' });
  check(child.id !== saved.id && child.version === 2 && child.parentId === saved.id && child.policyHash !== root.policyHash);
  check((await store.get(saved.id))!.policy.review.cadenceDays === 30);
  await rejects(() => store.save({ policy: policy(), name: 'bad parent', parentId: 'missing', reason: 'test' }), /parent/);
  await rejects(() => store.save({ policy: policy(), name: 'CAS', parentId: saved.id, expectedParentRevision: 2, reason: 'test' }), /revision conflict/);
  await rejects(() => store.save({ policy: policy(), name: 'CAS without parent', expectedParentRevision: 1, reason: 'test' }), /revision conflict/);
  const invalid = policy(); invalid.cashWeight = .9;
  await rejects(() => store.save({ policy: invalid, name: 'invalid', reason: 'test' }), /invalid policy/);
  await rejects(() => store.save({ policy: policy(), name: 'valid', reason: ' ' }), /reason/);
  await rejects(() => store.transition({ id: saved.id, action: 'approve', expectedRevision: 1, reason: 'illegal', actor: 'user' }), /illegal/);
  const review = await store.transition({ id: saved.id, action: 'submit', expectedRevision: 1, reason: 'Request review' });
  check(review.state === 'review' && review.reviewSnapshot?.inputHash === root.inputHash && review.reviewSnapshot?.asOf === root.policy.asOf);
  await rejects(() => store.transition({ id: saved.id, action: 'reject', expectedRevision: 1, reason: 'stale' }), /revision conflict/);
  await rejects(() => store.transition({ id: saved.id, action: 'approve', expectedRevision: 2, reason: 'agent attempt', actor: 'agent' }), /actor=user/);
  await rejects(() => store.transition({ id: saved.id, action: 'approve', expectedRevision: 2, reason: 'implicit actor' }), /actor=user/);
  await rejects(() => store.save({ policy: policy(), name: 'parent changed', parentId: saved.id, expectedParentRevision: 1, reason: 'test' }), /revision conflict/);
  const approved = await store.transition({ id: saved.id, action: 'approve', expectedRevision: 2, reason: 'Paper tracking consent', actor: 'user' });
  check(approved.state === 'approved' && approved.revision === 3 && approved.version === 1);
  check(approved.evaluation.executesTrades === false && approved.evaluation.writesLedger === false && approved.evaluation.executionReady === false);
  await rejects(() => store.transition({ id: saved.id, action: 'reject', expectedRevision: 3, reason: 'illegal' }), /illegal/);
  const retired = await store.transition({ id: saved.id, action: 'retire', expectedRevision: 3, reason: 'Retire paper version' });
  check(retired.history.map(h => h.action).join(',') === 'save,submit,approve,retire');
  check(retired.history.every(h => h.policyHash === root.policyHash && h.inputHash === root.inputHash));
  await rejects(() => store.transition({ id: saved.id, action: 'submit', expectedRevision: 4, reason: 'terminal' }), /illegal/);
  await store.transition({ id: child.id, action: 'submit', expectedRevision: 1, reason: 'submit' });
  await store.transition({ id: child.id, action: 'reject', expectedRevision: 2, reason: 'reject' });
  await rejects(() => store.transition({ id: child.id, action: 'submit', expectedRevision: 3, reason: 'terminal' }), /illegal/);
  const afterRejection = await store.save({ policy: policy(), parentId: child.id, expectedParentRevision: 3, name: 'v3', reason: 'New version required' });
  check(afterRejection.state === 'draft' && afterRejection.version === 3);
  for (const kind of ['missing', 'stale', 'future', 'blocked'] as const) {
    const p = policy();
    if (kind === 'missing') delete p.positions[0].priceAsOf;
    if (kind === 'stale') p.positions[0].priceAsOf = '2026-01-01';
    if (kind === 'future') p.positions[0].priceAsOf = '2026-12-01';
    if (kind === 'blocked') p.constraints.maxAssetWeight = .1;
    const e = await store.save({ policy: p, name: kind, reason: 'Allowed draft' });
    check(e.state === 'draft' && e.evaluation.ok && !e.evaluation.proposed);
    await store.transition({ id: e.id, action: 'submit', expectedRevision: 1, reason: 'review' });
    await rejects(() => store.transition({ id: e.id, action: 'approve', expectedRevision: 2, reason: 'reject unsafe approval', actor: 'user' }), /BLOCKED|prices|proposal/);
    check((await store.get(e.id))!.state === 'review');
  }
  const before = (await store.list()).length;
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => new PortfolioVersionStore(dir).save({ policy: policy(), name: `Concurrent ${i}`, reason: 'Concurrent append' })));
  check(new Set(results.map(e => e.id)).size === 24 && (await store.list()).length === before + 24);
  const casEntry = results[0];
  const casResults = await Promise.allSettled(['one', 'two'].map(reason => new PortfolioVersionStore(dir).transition({ id: casEntry.id, action: 'submit', expectedRevision: 1, reason })));
  check(casResults.filter(r => r.status === 'fulfilled').length === 1);
  check((await store.get(casEntry.id))!.history.length === 2);
  const bytes = await readFile(store.path, 'utf8');
  for (const corrupt of ['{invalid', '{}', JSON.stringify({ schemaVersion: 1, entries: [], updatedAt: 'bad' }), bytes.replace('"state": "retired"', '"state": "draft"'), bytes.replace('"revision": 4', '"revision": 99'), bytes.replace('"targetWeight": 0.35', '"targetWeight": 0.3')]) {
    await writeFile(store.path, corrupt);
    await rejects(() => store.list());
    await rejects(() => store.save({ policy: policy(), name: 'No overwrite', reason: 'No silent reset' }));
    check(await readFile(store.path, 'utf8') === corrupt);
  }
  await writeFile(store.path, '{invalid');
  await assert.rejects(() => store.get(saved.id), SyntaxError); assertions++;
  await writeFile(store.path, bytes);
  check((await store.list()).length === before + 24);
  // A directory in place of the file must propagate the native EISDIR error, not reset.
  const ioDir = path.join(dir, 'io-error'); await mkdir(path.join(ioDir, 'portfolio-strategies.json'), { recursive: true });
  await rejects(() => new PortfolioVersionStore(ioDir).save({ policy: policy(), name: 'IO', reason: 'error' }), /EISDIR|illegal operation|directory/i);
  console.log(`PASS portfolio versions: ${assertions} assertions; immutable versions, reload, CAS, transitions, paper-only user approval, missing prices, corruption, native IO errors, concurrent writers`);
} finally {
  // dir is the exact mkdtemp directory created above; never touches real portfolio data.
  await rm(dir, { recursive: true, force: true });
}
