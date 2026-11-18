import assert from 'node:assert/strict'
import { fetchStrategyExperiment } from '../src/strategy/lab-service.js'
import { readFileSync } from 'node:fs'
const original = globalThis.fetch
let calls = 0
try {
  globalThis.fetch = (async (url: unknown) => {
    calls++
    const u = new URL(String(url)); assert.equal(u.searchParams.get('fqt'),'0')
    return new Response(JSON.stringify({data:{name:'ST合成证券',klines:[]}}),{headers:{'content-type':'application/json'}})
  }) as typeof fetch
  const result = await fetchStrategyExperiment('600519')
  assert.equal(result.ok,false)
  assert.equal(calls,1)
  const bad = await fetchStrategyExperiment('300750')
  assert.equal(bad.ok,false);assert.equal(calls,1)
  const invalid = await fetchStrategyExperiment('600519',Infinity)
  assert.equal(invalid.ok,false);assert.equal(calls,1)
} finally { globalThis.fetch=original }
const entry=readFileSync('src/client/index.tsx','utf8')
assert.match(entry,/id: 'strategy', label: '组合策略'/)
assert.match(entry,/高级：单标的规则实验（不是组合策略）/)
const ui=readFileSync('src/client/strategy-lab.tsx','utf8')
assert.match(ui,/strategy_environment_review/); assert.match(ui,/submit_strategy/)
assert.match(ui,/等待我批准/); assert.match(ui,/\/strategy\/experiment/)
console.log('PASS strategy service: raw-only request, ST rejection, invalid params no network, UI environment review boundaries')
