/** Offline persistence + registered Agent tools. No network/private portfolio access. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FollowStore, normalizeTarget } from '../src/follow-store.js'
import { defaultFollowState } from '../src/follow.js'
import type { StateCapitalDisclosure } from '../src/state-capital.js'
import { fetchStateCapitalTarget, stateCapitalFilingKey, stateCapitalHistory } from '../src/follow-state-capital.js'
import { buildFollowSnapshot, registerFollowTools } from '../src/tools/follow-tools.js'
import { ResearchVault } from '../src/research/store.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }
function disclosure(extra: Partial<StateCapitalDisclosure> = {}): StateCapitalDisclosure {
  return {
    entityId: 'csf', entityName: '中国证券金融股份有限公司', scopeId: 'test:601288', asOf: '2026-06-30', disclosedAt: null,
    capturedAt: '2026-08-20T00:00:00Z', sources: [{ url: 'https://example.invalid/report', title: '离线披露夹具', hash: 'a'.repeat(64), level: 'aggregated', publishedAt: null }],
    holdings: [{ key: 'stock:601288', name: '农业银行（夹具）', code: '601288', assetType: 'stock', quantity: 100, unit: '股', rawQuantity: '100', percentage: 1, denominator: '总股本', holdingMode: 'direct', asOf: '2026-06-30', disclosedAt: null, sourceUrl: 'https://example.invalid/report', sourceHash: 'a'.repeat(64), locator: 'row1' }],
    coverage: '仅一只股票的测试披露，不是完整账户', warnings: ['离线夹具非真实持股'], ...extra,
  }
}
async function fixture(run: (follow: FollowStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-state-follow-'))
  const follow = new FollowStore(path.join(dir, 'follow.json')); await follow.load()
  try { await run(follow, dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const stateTarget = (follow: FollowStore) => follow.addTarget({ kind: 'cn-state', name: '证金', stateEntityId: 'csf', stateCodes: ['601288'] })

await check('主体精确识别、默认手动、范围上限与ETF拒绝', () => {
  const target = normalizeTarget({ kind: 'cn-state', name: '证金', stateCodes: ['601288'] })
  assert.equal(target.name, '中国证券金融股份有限公司'); assert.equal(target.autoCheck, false)
  assert.throws(() => normalizeTarget({ kind: 'cn-state', name: '所有国资' }), /无法识别/)
  assert.throws(() => normalizeTarget({ kind: 'cn-state', name: '证金' }), /显式stateCodes/)
  assert.throws(() => normalizeTarget({ kind: 'cn-state', name: '证金', stateCodes: ['510300'] }), /ETF/)
  assert.throws(() => normalizeTarget({ kind: 'cn-state', name: '证金', stateCodes: ['600001','600002','600003','600004','600005','600006'] }), /最多/)
})
await check('旧默认对象不被新增监测强行扩充或重复灌入', () => fixture(async follow => {
  assert.equal((await follow.seedDefaults()).seeded, 3)
  assert.ok(follow.get().targets.every(target => target.kind !== 'cn-state'))
  assert.equal((await follow.seedDefaults()).seeded, 0)
}))
await check('新对象同主体防重复；配置保留快照且不改法定主体', () => fixture(async follow => {
  const target = await stateTarget(follow)
  await assert.rejects(stateTarget(follow), /已存在/)
  const snap = disclosure()
  await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => snap })
  await follow.configureStateTarget(target.id, { stateCodes: ['601398'] })
  assert.equal(follow.get().snapshots.length, 1)
  assert.equal(follow.get().targets[0]?.stateEntityId, 'csf')
  assert.equal(follow.get().targets[0]?.autoCheck, false)
}))
await check('首次基线入队幂等，抓取日变化不是新披露，未知披露日不伪造', () => fixture(async follow => {
  const target = await stateTarget(follow), snap = disclosure()
  const first = await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => snap })
  assert.equal(first.newObservation, true); assert.equal(first.newFiling, false); assert.equal(first.stateCapital.diff?.status, 'first-observation')
  const second = await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => ({ ...snap, capturedAt: '2026-11-25T00:00:00Z' }) })
  assert.equal(second.newObservation, false); assert.equal(second.newFiling, false)
  assert.equal(follow.get().snapshots.length, 1); assert.equal(follow.get().jobs.length, 1)
  assert.equal(follow.get().snapshots[0]?.filedAt, '')
  assert.equal(second.stateCapital.latest?.disclosedAt, null)
}))
await check('源失败、预取消、错误主体不替换已有基线', () => fixture(async follow => {
  const target = await stateTarget(follow)
  await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure() })
  const before = follow.get()
  await assert.rejects(fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => { throw new Error('源失败') } }), /源失败/)
  await assert.rejects(fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure({ entityId: 'huijin' }) }), /主体与请求/)
  const abort = new AbortController(); abort.abort(new Error('已取消'))
  let calls = 0
  await assert.rejects(fetchStateCapitalTarget(follow, target, abort.signal, { fetch: async () => { calls++; return disclosure() } }), /已取消/)
  assert.equal(calls, 0); assert.deepEqual(follow.get(), before)
}))
await check('检查过程中对象被移除/范围改变，不写孤儿或错范围快照', () => fixture(async follow => {
  const target = await stateTarget(follow)
  await assert.rejects(fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => { await follow.configureStateTarget(target.id, { stateCodes: ['601398'] }); return disclosure() } }), /范围已变化/)
  assert.equal(follow.get().snapshots.length, 0)
  const current = follow.get().targets[0]!
  await assert.rejects(fetchStateCapitalTarget(follow, current, undefined, { fetch: async () => { await follow.removeTarget(current.id); return disclosure() } }), /已移除/)
  assert.equal(follow.get().snapshots.length, 0)
}))
await check('旧期不能覆盖已有新期；历史差分不能拿未来快照作上期', () => fixture(async follow => {
  const target = await stateTarget(follow), first = disclosure()
  const key1 = (await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => first })).filingKey
  const next = disclosure({ asOf: '2026-09-30', capturedAt: '2026-10-20T00:00:00Z', holdings: [{ ...first.holdings[0]!, asOf: '2026-09-30', quantity: 150, rawQuantity: '150' }] })
  await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => next })
  assert.equal(stateCapitalHistory(follow.get(), target.id, key1).previous, undefined)
  assert.equal(stateCapitalHistory(follow.get(), target.id).latest?.data.stateCapital?.asOf, '2026-09-30')
  await assert.rejects(fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => first }), /早于已有/)
}))
await check('未来报告期与无效抓取时间被拒绝，旧基线保留', () => fixture(async follow => {
  const target = await stateTarget(follow)
  const good = disclosure()
  await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => good })
  const before = follow.get()
  await assert.rejects(
    fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure({ asOf: '2099-09-30', capturedAt: '2026-11-25T00:00:00Z' }) }),
    /未来数据/)
  await assert.rejects(
    fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure({ asOf: '2026-06-30', capturedAt: 'not-a-date' }) }),
    /抓取时间/)
  await assert.rejects(
    fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure({ asOf: '2026-06-30', capturedAt: '2026-11-25T00:00:00Z', holdings: [{ ...good.holdings[0]!, asOf: '2099-12-31' }] }) }),
    /未来数据/)
  assert.deepEqual(follow.get().snapshots, before.snapshots)
}))
await check('当前概览按捕获顺序展示cn-state，不把未知日期/市值模型套成13F', () => fixture(async follow => {
  const target = await stateTarget(follow)
  await fetchStateCapitalTarget(follow, target, undefined, { fetch: async () => disclosure() })
  const view = buildFollowSnapshot(follow)
  assert.equal(view.targets[0]?.diff, null)
  assert.equal(view.targets[0]?.stateCapital?.latest?.entityId, 'csf')
  assert.equal(view.targets[0]?.autoCheck, false)
  assert.equal(view.stateCapitalCatalog.length, 3)
  assert.equal(view.targets[0]?.lastFilingAt, '')
}))
await check('Agent工具全链路不读个人持仓，拒绝国家资本伪复刻/重叠', () => fixture(async (follow, dir) => {
  type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<any> }
  const tools: Record<string, Tool> = {}
  const vault = new ResearchVault(path.join(dir, 'vault')); await vault.load()
  let portfolioReads = 0
  registerFollowTools({ tools: { register: (tool: Tool) => { tools[tool.name] = tool } } } as never,
    { follow, portfolio: { get() { portfolioReads++; throw new Error('private portfolio must not be read') } } as never, finance: {} as never, vault },
    { tick: false, stateCapitalRuntime: { fetch: async () => disclosure() } })
  const added = await tools.follow_add!.execute({ kind: 'cn-state', name: '证金', stateEntityId: 'csf', stateCodes: ['601288'] }, {})
  assert.equal(added.target.autoCheck, false)
  const id = added.target.id
  const fetched = await tools.follow_fetch!.execute({ id }, {})
  assert.equal(fetched.mode, 'public-disclosure'); assert.equal(fetched.stateCapital.latest.disclosedAt, null)
  const compared = await tools.follow_diff!.execute({ id }, {})
  assert.equal(compared.diff.status, 'first-observation')
  assert.equal((await tools.follow_replicate!.execute({ id }, {})).ok, false)
  assert.equal((await tools.follow_vs_holdings!.execute({ id }, {})).ok, false)
  assert.equal(portfolioReads, 0)
  const note = await tools.follow_note!.execute({ id, title: '有限披露基线', points: ['仅离线夹具，不是真实持股。'] }, {})
  assert.equal(note.vaultSaved, true)
  const saved = vault.find(note.vaultId)!
  const body = await vault.readBody(saved)
  assert.match(body, /报告期：2026-06-30/); assert.match(body, /披露日：未知/); assert.match(body, /SHA256/)
  assert.equal(follow.get().jobs[0]?.state, 'done')
  await tools.follow_state_configure!.execute({ id, stateCodes: ['601398'] }, {})
  assert.deepEqual(follow.get().targets[0]?.stateCodes, ['601398'])
  assert.ok(Object.keys(tools.follow_add!.parameters.properties).includes('stateEntityId'))
  const reloaded = new FollowStore(path.join(dir, 'follow.json')); await reloaded.load()
  assert.equal(reloaded.get().snapshots.length, 1)
  assert.equal(reloaded.get().targets[0]?.kind, 'cn-state')
}))
await check('空状态、语义签名与面板接线保持有限范围', async () => {
  assert.equal(defaultFollowState().targets.length, 0)
  assert.equal(stateCapitalFilingKey(disclosure()), stateCapitalFilingKey(disclosure({ capturedAt: '2026-11-25T00:00:00Z' })))
  const entry = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(entry, /<StateCapitalPanel targets=/)
  assert.match(entry, /target\.kind !== 'cn-state'/)
})
console.log(`[state-capital-follow] ${checks} offline integration groups passed`)
