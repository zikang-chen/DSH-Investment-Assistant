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
  for (const target of ['https://official.example/outside/report', 'https://another.example/scoped/report']) {
    calls.length = 0
    globalThis.fetch = (async (url: unknown) => { calls.push(String(url)); return new Response(null, { status: 302, headers: { location: target } }) }) as typeof fetch
    await assert.rejects(() => fetchPolicyDocument('https://official.example/scoped/list', {
      hosts: ['official.example', 'another.example'], timeoutMs: 1000, maxBytes: 1024, respectRobots: false,
      validateUrl: (url) => new URL(url).origin === 'https://official.example' && new URL(url).pathname.startsWith('/scoped/'),
    }), /抓取范围/)
    assert.deepEqual(calls, ['https://official.example/scoped/list'])
  }
  calls.length = 0
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => fetchPolicyDocument('https://official.example/report', { hosts: ['official.example'], timeoutMs: 1000, maxBytes: 1024, signal: controller.signal, respectRobots: true }), /取消/)
  assert.deepEqual(calls, [], 'pre-cancelled request must not load robots either')
  console.log('PASS same-allowlist cross-origin/path redirects and pre-cancelled robots blocked before request')
} finally { globalThis.fetch = original }
