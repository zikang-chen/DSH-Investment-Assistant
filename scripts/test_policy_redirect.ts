import assert from 'node:assert/strict'
import { fetchPolicyDocument } from '../src/policy/fetch.js'
const original = globalThis.fetch
const calls: string[] = []
try {
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: 'https://outside.example/private' } })
  }) as typeof fetch
  await assert.rejects(() => fetchPolicyDocument('https://official.example/report', {
    hosts: ['official.example'], timeoutMs: 1000, maxBytes: 1024, respectRobots: false,
  }), /允许清单/)
  assert.deepEqual(calls, ['https://official.example/report'], 'off-allowlist destination must never be contacted')
  console.log('PASS redirect target rejected before network request')
} finally { globalThis.fetch = original }
