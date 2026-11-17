/**
 * Diagnostic: does each enabled policy source actually yield document links?
 *
 * Fixtures prove the parser; this script proves the shipped allowlist still
 * matches the live pages/feeds. By default it only DISCOVERS links (no document
 * fetching, no writes); `--collect N` additionally pulls N documents into a temp
 * store so extraction can be eyeballed without touching the real policy library.
 *
 *   npx tsx scripts/probe_policy_sources.ts
 *   npx tsx scripts/probe_policy_sources.ts --only stats-releases --collect 3
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectSource, discoverFromSource, type CollectDeps } from '../src/policy/collect.js'
import { DEFAULT_POLICY_SOURCES, decisionHosts, mergeSources } from '../src/policy/sources.js'
import { PolicyStore } from '../src/policy/store.js'

function argOf(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const only = argOf('only')
const timeoutMs = Number(argOf('timeout') ?? '20000')
const collectLimit = Number(argOf('collect') ?? '0')

const tmp = await mkdtemp(path.join(os.tmpdir(), 'policy-probe-'))
const store = new PolicyStore(tmp)
await store.load()
const sources = mergeSources(DEFAULT_POLICY_SOURCES, [])
const deps: CollectDeps = {
  store,
  hosts: decisionHosts(sources),
  timeoutMs,
  maxBytes: 16_000_000,
  robotsCache: new Map(),
}

const targets = sources.filter((s) => (only ? s.id === only : s.enabled))
let ok = 0
let failed = 0
console.log(`probe ${targets.length} source(s), timeout ${timeoutMs}ms, collect=${collectLimit}\n`)
for (const source of targets) {
  const started = Date.now()
  try {
    const links = await discoverFromSource(deps, source)
    const elapsed = Date.now() - started
    if (links.length === 0) {
      failed++
      console.log(`x ${source.id.padEnd(18)} 0 links (${elapsed}ms) — 页面结构与 linkPattern 不匹配，或列表由脚本渲染`)
      continue
    }
    ok++
    console.log(`ok ${source.id.padEnd(18)} ${String(links.length).padStart(4)} links (${elapsed}ms)`)
    for (const link of links.slice(0, 3)) {
      console.log(`     ${link.publishedAt || 'date?'}  ${link.title.slice(0, 52)}`)
    }
    if (collectLimit > 0) {
      const run = await collectSource(deps, source, { limit: collectLimit })
      console.log(`     -> added=${run.added} updated=${run.updated} duplicate=${run.duplicate} failed=${run.failed}`)
      for (const result of run.results) {
        if (!result.ok) {
          console.log(`     !! ${result.url} — ${result.error}`)
          continue
        }
        const doc = result.doc!
        console.log(`     ++ [${result.action}] ${doc.title.slice(0, 44)} | ${doc.issuer || '机关?'} | ${doc.publishedAt || 'date?'} | ${doc.docType} | 段落 ${doc.paragraphs.length} | 状态 ${doc.parseStatus}`)
      }
    }
  } catch (err) {
    failed++
    console.log(`x ${source.id.padEnd(18)} ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`\n[policy-probe] ok=${ok} failed=${failed}`)
await rm(tmp, { recursive: true, force: true })
process.exitCode = failed > 0 ? 1 : 0
