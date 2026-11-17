/**
 * Policy collection tick — one unit of "go fetch what is new and file it".
 *
 * Kept as a plain async function (not a timer) so it can be unit-tested,
 * triggered by the panel, or driven by an interval. Every source is isolated:
 * one failing site never aborts the others, and a repeat tick is a no-op because
 * the store dedupes by content and identity.
 */
import type { Logger } from '../log.js'
import type { ResearchVault } from '../research/store.js'
import { collectSource, type CollectDeps } from './collect.js'
import type { PolicyDocument, PolicySource } from './types.js'
import { mirrorPolicyToVault } from './vault-bridge.js'

/** Default cadence: once a day. Official sites do not publish faster than that. */
export const DEFAULT_POLICY_INTERVAL_HOURS = 24

export interface PolicyTickOptions {
  /** Sources to scan (caller has already filtered by `enabled`). */
  sources: PolicySource[]
  /** Documents per source per tick. */
  limitPerSource: number
  /** Mirror new/updated documents into the research vault. */
  vault?: ResearchVault
  mirror?: boolean
  logger?: Logger
  signal?: AbortSignal
}

export interface PolicyTickSourceResult {
  sourceId: string
  label: string
  added: number
  updated: number
  duplicate: number
  failed: number
  errors: string[]
}

export interface PolicyTickResult {
  runAt: string
  added: number
  updated: number
  duplicate: number
  failed: number
  mirrored: number
  sources: PolicyTickSourceResult[]
}

/** Run one collection pass over every enabled source. Never throws. */
export async function runPolicyTick(deps: CollectDeps, opts: PolicyTickOptions): Promise<PolicyTickResult> {
  const log = opts.logger?.child('policy.tick')
  const runAt = new Date().toISOString()
  const result: PolicyTickResult = { runAt, added: 0, updated: 0, duplicate: 0, failed: 0, mirrored: 0, sources: [] }
  const toMirror: PolicyDocument[] = []

  for (const source of opts.sources) {
    if (opts.signal?.aborted) break
    try {
      const res = await collectSource(deps, source, { limit: opts.limitPerSource })
      result.added += res.added
      result.updated += res.updated
      result.duplicate += res.duplicate
      result.failed += res.failed
      for (const one of res.results) {
        if (one.ok && one.doc && (one.action === 'added' || one.action === 'updated')) toMirror.push(one.doc)
      }
      result.sources.push({
        sourceId: source.id,
        label: source.label,
        added: res.added,
        updated: res.updated,
        duplicate: res.duplicate,
        failed: res.failed,
        errors: res.results.filter((r) => !r.ok).map((r) => `${r.url}: ${r.error ?? 'unknown'}`).slice(0, 5),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed++
      result.sources.push({ sourceId: source.id, label: source.label, added: 0, updated: 0, duplicate: 0, failed: 1, errors: [message] })
      log?.warn('source tick failed', { sourceId: source.id, error: message })
    }
  }

  if (opts.vault && opts.mirror !== false) {
    for (const doc of toMirror) {
      try {
        await mirrorPolicyToVault(opts.vault, doc)
        result.mirrored++
      } catch (err) {
        log?.warn('mirror failed', { id: doc.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  log?.info('tick done', { added: result.added, updated: result.updated, duplicate: result.duplicate, failed: result.failed, mirrored: result.mirrored })
  return result
}
