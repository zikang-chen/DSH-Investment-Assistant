/** Static contracts for the three portfolio workflows (no network, no private data). */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const routes = readFileSync('src/server-routes.ts', 'utf8')
const ui = readFileSync('src/client/portfolio-operations.tsx', 'utf8')
const imp = readFileSync('src/strategy/portfolio-import.ts', 'utf8')
const policy = readFileSync('src/strategy/portfolio-policy.ts', 'utf8')

// Each workflow has its own route, and none of them touch recovery/ledger writers.
for (const sub of ['/strategy/versions', '/strategy/transition', '/strategy/import', '/strategy/verify', '/strategy/backtest']) {
  assert.ok(routes.includes(`sub === '${sub}'`), `missing route ${sub}`)
}
const blockStart = routes.indexOf("sub === '/strategy/versions'")
const blockEnd = routes.indexOf("sub === '/history/sync'")
assert.ok(blockStart > 0 && blockEnd > blockStart, 'strategy routes must stay together')
const strategyBlock = routes.slice(blockStart, blockEnd)
assert.ok(!/capital|ledger|transaction/i.test(strategyBlock), 'paper workflows must not call ledger/capital writers')
assert.match(routes, /body\.userConfirmed !== true/)
assert.match(routes, /超过7天/)
assert.match(routes, /portfolio-strategy/)

// Import is gated by an explicit per-request authorization and never fabricates cash/FX.
assert.match(imp, /authorized !== true/)
assert.match(imp, /cash: \[\]/)
assert.match(imp, /gaps\.push/)
assert.match(imp, /reference, not executable FX/)
assert.ok(!/avgCost/.test(imp), 'cost price must not substitute for market price')

// UI must not pre-check consent, must warn before promoting a paper strategy, and shows paper-only wording.
assert.match(ui, /checked=\{authorized\}/)
assert.match(ui, /setAuthorized\(false\)/)
assert.match(ui, /批准仅作纸面跟踪，不执行交易/)
assert.match(ui, /window\.confirm/)
assert.match(ui, /缺公司行动覆盖声明只能输出部分口径/)

// Policy math stays pure/browser-safe.
assert.ok(!policy.includes("from 'node:"))

console.log('PASS portfolio wiring: five routes, explicit consent, no ledger writes, stale-approval guard, paper-only approval copy')
