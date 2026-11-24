import type { CapitalStore } from './capital/ledger.js'
import { EVENT_TYPES, type EventType } from './capital/types.js'
/** Read-only ledger query shared by the page and tests; never records a transaction. */
export function capitalTransactionsRead(store: CapitalStore, params: URLSearchParams) {
  const eventType = params.get('eventType') || undefined
  if (eventType && !(EVENT_TYPES as readonly string[]).includes(eventType)) throw new Error('无效的流水类型')
  const from = params.get('from') || undefined, to = params.get('to') || undefined
  for (const date of [from, to]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date)) throw new Error('日期格式须为 YYYY-MM-DD')
  }
  if (from && to && from > to) throw new Error('起始日期须早于结束日期')
  const limit = Number(params.get('limit') || 100)
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit 只支持 1–5000')
  const rows = store.listEvents({ accountId: params.get('accountId') || undefined, assetId: params.get('assetId') || undefined,
    eventType: eventType as EventType | undefined, from, to, limit })
  return { ok: true, count: rows.length, limit, events: rows }
}
