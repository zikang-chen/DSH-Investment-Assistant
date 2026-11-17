/** Pure/static tests only. No DOM, fetch, server, probe, real config, private data, or generated files. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  capLabel, catalogPolicy, draftSelection, healthCounts, healthView, initialSourceDraftState,
  policyPayload, samePolicy, selectionSummary, setCapabilityMode, setFamilySelection,
  sourceDraftReducer, toggleProvider, type CapCatalog,
} from '../src/client/source-policy-model.js'
import { groupBySource } from '../src/client/sources-group.js'
import { sourcesWorkspaceCss } from '../src/client/sources-workspace-styles.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
const quote: CapCatalog = {
  capability: 'quote', hasPolicy: true, selected: ['tx_quote', 'ws_quote'],
  // Intentionally NOT the effective order, and health is independent of selection.
  providers: [
    { id: 'ws_quote', source: 'WeStock', endpointRef: 'local-cli', selected: true, ok: false },
    { id: 'em_quote', source: '东财', endpointRef: 'example-ref', selected: false, ok: true },
    { id: 'tx_quote', source: '腾讯', endpointRef: 'example-ref-2', selected: true },
  ],
}
const fund: CapCatalog = {
  capability: 'fund_quote', hasPolicy: false, selected: ['em_fund'],
  providers: [{ id: 'em_fund', source: '东财', endpointRef: 'fund-ref', selected: true }],
}
const ws: CapCatalog = {
  capability: 'ws_only', label: '本地扩展能力', group: '研究', hasPolicy: true, selected: [],
  providers: [{ id: 'ws_only', source: 'WeStock', endpointRef: 'local-ref', selected: false }],
}
const empty: CapCatalog = { capability: 'missing', hasPolicy: false, selected: [], providers: [] }
const initialCatalog = [quote, fund, ws, empty]
const frozenSnapshot = JSON.stringify(initialCatalog)

check('catalog retains explicit empty selections and existing priority; defaults remain absent', () => {
  assert.deepEqual(catalogPolicy(initialCatalog), { quote: ['tx_quote', 'ws_quote'], ws_only: [] })
  assert.deepEqual(policyPayload(catalogPolicy(initialCatalog)), { policy: { quote: ['tx_quote', 'ws_quote'], ws_only: [] } })
  assert.deepEqual(draftSelection(fund, {}), { mode: 'default', ids: ['em_fund'] })
  assert.deepEqual(draftSelection(ws, { ws_only: [] }), { mode: 'custom', ids: [] })
  assert.equal(selectionSummary(ws, { ws_only: [] }), '已停用 · 0 源')
  assert.equal(selectionSummary(empty, {}), '无候选源')
})
check('default is omission, not all candidates or an empty custom array', () => {
  const defaults = setCapabilityMode(catalogPolicy(initialCatalog), quote, 'default')
  assert.deepEqual(defaults, { ws_only: [] })
  assert.equal(draftSelection(quote, defaults).ids, null, 'hidden backend default order must not be guessed')
  assert.equal(selectionSummary(quote, defaults), '待保存恢复默认')
  assert.deepEqual(policyPayload({}), { policy: {} })
  assert.equal(samePolicy({}, { quote: [] }), false)
  assert.deepEqual(toggleProvider(defaults, quote, 'em_quote'), defaults, 'cannot toggle unknown default selection')
  const custom = setCapabilityMode(defaults, quote, 'custom')
  assert.deepEqual(custom.quote, ['tx_quote', 'ws_quote'], 'switching custom starts from saved effective order')
})
check('toggles preserve priority, append additions, and can disable without mutating fixtures', () => {
  const baseline = catalogPolicy(initialCatalog)
  const added = toggleProvider(baseline, quote, 'em_quote')
  assert.deepEqual(added.quote, ['tx_quote', 'ws_quote', 'em_quote'])
  const removed = toggleProvider(added, quote, 'tx_quote')
  assert.deepEqual(removed.quote, ['ws_quote', 'em_quote'])
  const disabled = toggleProvider(toggleProvider(removed, quote, 'ws_quote'), quote, 'em_quote')
  assert.deepEqual(disabled.quote, [])
  assert.equal(selectionSummary(quote, disabled), '已停用 · 0 源')
  assert.deepEqual(baseline.quote, ['tx_quote', 'ws_quote'])
  assert.equal(toggleProvider(baseline, quote, 'invalid-id'), baseline)
  assert.equal(samePolicy({ quote: ['a', 'b'] }, { quote: ['b', 'a'] }), false)
  assert.equal(samePolicy({ z: [], a: ['a'] }, { a: ['a'], z: [] }), true)
})
check('family bulk operations are explicit choices and leave unrelated policies intact', () => {
  const off = setFamilySelection(catalogPolicy(initialCatalog), [fund, ws, empty], false)
  assert.deepEqual(off, { quote: ['tx_quote', 'ws_quote'], fund_quote: [], ws_only: [] })
  const on = setFamilySelection(off, [fund, ws, empty], true)
  assert.deepEqual(on, { quote: ['tx_quote', 'ws_quote'], fund_quote: ['em_fund'], ws_only: ['ws_only'] })
  assert.equal(Object.hasOwn(on, 'missing'), false)
  assert.deepEqual(setFamilySelection({ quote: ['tx_quote', 'ws_quote'] }, [quote], true).quote, ['tx_quote', 'ws_quote', 'em_quote'])
})
check('unknown health is neutral, not failure; checked state is not health', () => {
  assert.deepEqual(healthCounts(quote.providers), { ok: 1, failed: 1, unknown: 1 })
  assert.equal(healthView(undefined).tone, 'neutral')
  assert.equal(healthView(undefined).state, 'unknown')
  assert.match(healthView(undefined).label, /unknown/)
  assert.equal(healthView(false).state, 'failed')
  assert.equal(healthView(true).state, 'ok')
  assert.deepEqual(draftSelection(quote, catalogPolicy([quote])).ids, ['tx_quote', 'ws_quote'], 'failed checked source stays checked')
})
check('labels and existing source-family grouping retain coverage and stable groups', () => {
  assert.equal(capLabel(quote), 'A股行情')
  assert.equal(capLabel(ws), '本地扩展能力')
  assert.equal(capLabel(empty), 'missing')
  const families = groupBySource([fund, ws, empty].map((cap) => ({ capability: cap.capability, group: cap.group, source: cap.providers[0]?.source ?? '无候选源' })))
  assert.deepEqual(families.map((family) => [family.source, family.total]), [['东财', 1], ['WeStock', 1], ['无候选源', 1]])
  assert.equal(families[1]?.groups[0]?.group, '研究')
})
check('policy payload is detached from mutable draft arrays', () => {
  const draft = { quote: ['tx_quote'], ws_only: [] }
  const payload = policyPayload(draft)
  payload.policy.quote!.push('ws_quote')
  assert.deepEqual(draft, { quote: ['tx_quote'], ws_only: [] })
})
check('dirty draft survives SSE/refetch; discard explicitly adopts latest snapshot', () => {
  const loaded = sourceDraftReducer(initialSourceDraftState, { type: 'load-success', catalog: initialCatalog })
  const draft = sourceDraftReducer(loaded, { type: 'edit', policy: { ...loaded.draft, quote: [] } })
  assert.equal(draft.dirty, true)
  const remote = [{ ...quote, selected: ['em_quote'] }, fund, ws]
  const refreshing = sourceDraftReducer(draft, { type: 'load-start' })
  const received = sourceDraftReducer(refreshing, { type: 'load-success', catalog: remote })
  assert.deepEqual(received.draft.quote, [])
  assert.deepEqual(received.baseline.quote, ['tx_quote', 'ws_quote'])
  assert.equal(received.catalog, initialCatalog)
  assert.equal(received.pendingCatalog, remote)
  assert.equal(received.loading, false)
  const discarded = sourceDraftReducer(received, { type: 'discard' })
  assert.deepEqual(discarded.draft.quote, ['em_quote'])
  assert.equal(discarded.dirty, false)
  assert.equal(discarded.pendingCatalog, null)
})
check('clean refresh applies and restoring defaults remains a local draft until save', () => {
  const loaded = sourceDraftReducer(initialSourceDraftState, { type: 'load-success', catalog: initialCatalog })
  const defaults = sourceDraftReducer(loaded, { type: 'defaults' })
  assert.equal(defaults.catalog, initialCatalog)
  assert.deepEqual(defaults.baseline, catalogPolicy(initialCatalog))
  assert.deepEqual(defaults.draft, {})
  assert.equal(defaults.dirty, true)
  assert.match(defaults.notice, /才会生效/)
  const cleanCatalog = [{ ...fund, selected: [] }]
  const refreshed = sourceDraftReducer(loaded, { type: 'load-success', catalog: cleanCatalog })
  assert.equal(refreshed.catalog, cleanCatalog)
  assert.equal(refreshed.pendingCatalog, null)
  assert.equal(refreshed.dirty, false)
})
check('save shields in-flight reads/edits and reconciles only acknowledged catalog', () => {
  const loaded = sourceDraftReducer(initialSourceDraftState, { type: 'load-success', catalog: initialCatalog })
  const draft = sourceDraftReducer(loaded, { type: 'edit', policy: { quote: [] } })
  const refreshing = sourceDraftReducer(draft, { type: 'load-start' })
  const saving = sourceDraftReducer(refreshing, { type: 'save-start' })
  assert.equal(saving.saving, true)
  assert.equal(saving.loading, false, 'pre-save reads are invalidated, do not leave a stuck refresh indicator')
  assert.equal(sourceDraftReducer(saving, { type: 'defaults' }), saving)
  assert.equal(sourceDraftReducer(saving, { type: 'discard' }), saving)
  assert.equal(sourceDraftReducer(saving, { type: 'edit', policy: {} }), saving)
  const held = sourceDraftReducer(saving, { type: 'load-success', catalog: [fund] })
  assert.deepEqual(held.draft, { quote: [] })
  assert.equal(held.catalog, initialCatalog)
  const savedCatalog = [{ ...quote, selected: [] }]
  const saved = sourceDraftReducer(held, { type: 'save-success', catalog: savedCatalog })
  assert.deepEqual(saved.draft, { quote: [] })
  assert.equal(saved.dirty, false)
  assert.equal(saved.saving, false)
  assert.equal(saved.pendingCatalog, null)
})
check('failed reads or saves retain draft, distinguish errors, and permit retry', () => {
  const firstError = sourceDraftReducer(initialSourceDraftState, { type: 'load-error', message: 'offline' })
  assert.equal(firstError.catalog, null)
  assert.equal(firstError.error, 'offline')
  const loaded = sourceDraftReducer(initialSourceDraftState, { type: 'load-success', catalog: initialCatalog })
  const dirty = sourceDraftReducer(loaded, { type: 'edit', policy: { quote: [] } })
  const readError = sourceDraftReducer(dirty, { type: 'load-error', message: 'read failed' })
  assert.deepEqual(readError.draft, { quote: [] })
  const error = sourceDraftReducer(sourceDraftReducer(readError, { type: 'save-start' }), { type: 'save-error', message: 'write failed' })
  assert.equal(error.error, 'write failed')
  assert.deepEqual(error.draft, { quote: [] })
  assert.equal(error.dirty, true)
  assert.equal(error.saving, false)
  assert.equal(error.loading, false)
})
check('pure fixtures remain unchanged after all transitions', () => assert.equal(JSON.stringify(initialCatalog), frozenSnapshot))

const [view, registry, routes] = await Promise.all([
  readFile(new URL('../src/client/sources-workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/data/registry.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/server-routes.ts', import.meta.url), 'utf8'),
])
check('static: actual backend distinguishes empty [] from omission and replaces policy', () => {
  assert.match(registry, /this\.policy\[capability\] \?\? this\.providerOrder\[capability\]/)
  assert.match(registry, /if \(!sel\) continue/)
  assert.match(registry, /clean\[cap\] = sel\.filter/)
  assert.match(registry, /this\.policy = clean/)
  assert.match(registry, /selected: order/)
  assert.match(registry, /hasPolicy: !!this\.policy\[cap\]/)
  assert.match(routes, /sub === '\/providers'[\s\S]*?const policy = \(body\.policy \?\? \{\}\) as Record<string, string\[\]>/)
  assert.match(routes, /finance\.setProviderPolicy\(policy\)/)
})
check('static: one existing POST boundary, local drafts, read-only refresh and no probes', () => {
  assert.equal([...view.matchAll(/\bpost</g)].length, 1)
  assert.match(view, /post<CatalogResponse>\('\/providers', policyPayload\(state\.draft\)\)/)
  assert.equal([...view.matchAll(/\bget</g)].length, 1)
  assert.match(view, /get<CatalogResponse>\('\/providers'\)/)
  assert.match(view, /onClick=\{\(\) => void save\(\)\}/)
  assert.match(view, /onClick=\{\(\) => dispatch\(\{ type: 'defaults' \}\)\}/)
  assert.match(view, /id === request\.current/)
  assert.match(view, /request\.current\+\+ \/\/ also invalidate SSE reads/)
  assert.match(view, /saveInFlight\.current/)
  assert.doesNotMatch(view, /\bfetch\s*\(|https?:\/\/|\/health|\/probe|setInterval\(|localStorage/)
})
check('static: all optional groups use native collapsed details, children and accessible controls remain', () => {
  assert.equal([...view.matchAll(/<details\b/g)].length, 3)
  assert.doesNotMatch(view, /<details[^>]*\bopen\s*[=>]|defaultOpenFamily|aria-expanded|draggable|moveUp|moveDown/)
  assert.match(view, /import \{ groupBySource \}/)
  assert.match(view, /children\?: ReactNode/)
  assert.match(view, /\{children\}<\/div>/)
  assert.match(view, /type="checkbox"/)
  assert.match(view, /aria-label=\{`\$\{capLabel\(cap\)\}：/)
  assert.match(view, /scope="col" data-numeric="true"/)
  assert.match(view, /role="alert"/)
  assert.match(view, /未探测不等于故障/)
  assert.match(view, /此页不提供排序编辑/)
})
check('static: source styles are scoped/token-based with narrow-container table scrolling', () => {
  assert.match(sourcesWorkspaceCss, /overflow-x:auto/)
  assert.match(sourcesWorkspaceCss, /@container\(max-width:540px\)/)
  assert.doesNotMatch(sourcesWorkspaceCss, /#[\da-f]{3,8}\b|(?:^|[{}])\s*(?:body|:root|\.fia-root\s*\{)/i)
  const rules = [...sourcesWorkspaceCss.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)]
  for (const [, selector] of rules) {
    if (selector!.trim().startsWith('@container')) continue
    assert.ok(selector!.trim().startsWith('.fia-root .fia-sources'), `unscoped selector ${selector}`)
  }
})
console.log(`\n${checks} source-policy UI checks passed (pure functions + static contracts; browser verification unavailable).`)
