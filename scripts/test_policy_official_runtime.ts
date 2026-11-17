import assert from 'node:assert/strict'
import { collectOfficialPages, extractAnchors, extractDate, inWindow, type OfficialCollectRuntime } from '../src/policy/official-collect.js'
import type { CollectDeps, CollectOneInput } from '../src/policy/collect.js'
import type { RawResponse } from '../src/policy/fetch.js'

// All I/O is injected: no HTTP, persistent store, private data, or Python needed.
const base = 'https://policy.example.gov'
const deps = {
  hosts: ['policy.example.gov'], timeoutMs: 100, maxBytes: 100_000,
  robotsCache: new Map<string, string>(),
  store: { saveOriginal: async () => ({ path: 'memory://attachment', bytes: 4 }) },
} as unknown as CollectDeps
const paragraphs = '<p>第一段正文</p><p>第二段正文</p><p>第三段正文</p>'
function fixture(pages: Record<string, string | Error>, action: 'added' | 'duplicate' | 'failed' = 'added') {
  const fetched: string[] = []
  const collected: CollectOneInput[] = []
  const waits: number[] = []
  let active = 0
  const runtime: OfficialCollectRuntime = {
    fetch: async (url, opts): Promise<RawResponse> => {
      assert.equal(opts.respectRobots, true)
      assert.deepEqual(opts.hosts, deps.hosts)
      assert.equal(active++, 0, 'fetches must remain serial')
      try {
        fetched.push(url)
        const value = pages[url]
        if (value instanceof Error) throw value
        assert.notEqual(value, undefined, `unexpected network request: ${url}`)
        const buffer = Buffer.from(value!)
        return { url, status: 200, contentType: url.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/html; charset=utf-8', buffer, bytes: buffer.length }
      } finally { active-- }
    },
    collectOne: async (_deps, input) => {
      collected.push(input)
      return action === 'failed' ? { url: input.url, ok: false, error: 'offline collect failure' }
        : { url: input.url, ok: true, action }
    },
    sleep: async (ms) => { waits.push(ms) },
    countExcelRows: async () => 7,
  }
  return { fetched, collected, waits, runtime }
}

async function main() {
  const list = `${base}/index.html`
  const article = `${base}/2026/11/16/report.html`
  const sheet = `${base}/files/report.xlsx`
  const child = fixture({
    [list]: `<a href="${article}">2026年10月份统计报告</a>`,
    [article]: `<h1>2026年10月份统计报告</h1>${paragraphs}<a href="/files/report.xlsx">统计数据附件</a>`,
    [sheet]: 'fake workbook',
  })
  const found = await collectOfficialPages(deps, { url: list, includeAttachments: true, from: '2026-11-01', to: '2026-11-30' }, child.runtime)
  assert.equal(found.ok, true)
  assert.equal(found.attachments[0]?.url, sheet)
  assert.equal(found.attachments[0]?.rows, 7)
  assert.equal(child.collected[0]?.publishedHint, '2026-11-16')
  assert.deepEqual(found.coverage, { from: '2026-11-16', to: '2026-11-16' })
  assert.ok(child.waits.length >= 3)
  assert.ok(child.waits.every((ms) => ms === 1000), 'default throttle must be retained')

  const fetchFailure = fixture({ [list]: new Error('offline fetch failure') })
  const failed = await collectOfficialPages(deps, { url: list }, fetchFailure.runtime)
  assert.equal(failed.ok, false)
  assert.match(failed.errors.join(' '), /offline fetch failure/)
  const collectFailure = fixture({ [list]: paragraphs }, 'failed')
  assert.equal((await collectOfficialPages(deps, { url: list }, collectFailure.runtime)).ok, false)

  // Direct article pages and linked articles share one attempt budget.
  for (const action of ['added', 'duplicate', 'failed'] as const) {
    const bounded = fixture({ [list]: `${paragraphs}<a href="/second.html">另一篇详细统计报告</a><a href="/next.html">下一页</a>`, [`${base}/next.html`]: paragraphs }, action)
    const result = await collectOfficialPages(deps, { url: list, maxDocs: 1, maxPages: 2 }, bounded.runtime)
    assert.equal(bounded.collected.length, 1, `direct-page budget (${action})`)
    assert.equal(result.documents.length, 1)
    assert.equal(bounded.fetched.includes(`${base}/second.html`), false)
  }
  for (const action of ['duplicate', 'failed'] as const) {
    const bounded = fixture({ [list]: '<a href="/first.html">第一篇详细统计报告</a><a href="/second.html">第二篇详细统计报告</a>', [`${base}/first.html`]: paragraphs }, action)
    await collectOfficialPages(deps, { url: list, maxDocs: 1 }, bounded.runtime)
    assert.equal(bounded.collected.length, 1, `linked article budget (${action})`)
    assert.equal(bounded.fetched.includes(`${base}/second.html`), false)
  }
  const detailFailure = fixture({ [list]: '<a href="/first.html">第一篇详细统计报告</a><a href="/second.html">第二篇详细统计报告</a>', [`${base}/first.html`]: new Error('detail failed') })
  assert.equal((await collectOfficialPages(deps, { url: list, maxDocs: 1 }, detailFailure.runtime)).ok, false)
  assert.equal(detailFailure.fetched.length, 2, 'failed detail fetch also consumes budget')

  assert.equal(extractAnchors(`<a href="${article}">2026年10月份统计报告</a>`, list)[0]?.date, '2026-11-16')
  assert.equal(extractAnchors('<a href="/report.html">2026年10月份统计报告</a>', list)[0]?.date, undefined)
  assert.equal(extractDate('2026年10月'), undefined)
  assert.equal(extractDate('2026-02-30'), undefined)
  assert.equal(inWindow(undefined, '2026-11-01', '2026-11-30'), true)
  assert.equal(inWindow('2026-11-30', undefined, '2026-11-29'), false)
  const unknown = fixture({ [list]: `<h1>2026年10月份统计报告</h1>${paragraphs}` })
  await collectOfficialPages(deps, { url: list, from: '2026-11-01' }, unknown.runtime)
  assert.equal(unknown.collected.length, 1, 'unknown publication dates must not be excluded')
  assert.equal(unknown.collected[0]?.publishedHint, undefined)
  const meta = fixture({ [list]: `<meta content="2026-11-16" name="publishdate"><h1>2026年10月份统计报告</h1>${paragraphs}` })
  await collectOfficialPages(deps, { url: list, from: '2026-11-01' }, meta.runtime)
  assert.equal(meta.collected[0]?.publishedHint, '2026-11-16')
  const priority = fixture({ [article]: `<meta name="publishdate" content="2026-10-01">${paragraphs}` })
  await collectOfficialPages(deps, { url: article }, priority.runtime)
  assert.equal(priority.collected[0]?.publishedHint, '2026-11-16')

  const forbidden = fixture({})
  const denied = await collectOfficialPages(deps, { url: 'https://unlisted.example/index.html' }, forbidden.runtime)
  assert.equal(denied.ok, false)
  assert.equal(forbidden.fetched.length, 0)
  assert.equal((await collectOfficialPages(deps, { url: 'not-a-url' }, forbidden.runtime)).ok, false)
  console.log('PASS: child XLSX discovery; truthful failure status; shared attempt budget; publication dates; serial throttle; allowlist/robots contract (offline).')
}
main().catch((err) => { console.error(err); process.exitCode = 1 })
