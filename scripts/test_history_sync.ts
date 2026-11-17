/** History sync paging regression: must request far more than 60 bars, and page safely. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fetchKlinePaged, syncHistory, requestedAdjustment } from '../src/history/sync.js'
import { HistoryStore, detectGaps } from '../src/history/store.js'

let passed = 0
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`) }

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 100 })

await test('fetchKlinePaged passes an explicit wide window and merges pages', async () => {
  const calls: Array<{ end?: string }> = []
  // First page returns 900 bars (>= PAGE_CAP), second page returns the older 100.
  let page = 0
  const fake = async (_kind: never, fetchPage: (end?: string) => Promise<{ ok: boolean; data?: unknown[]; provider?: string }>) => {
    return fetchPage
  }
  void fake
  const result = await fetchKlinePaged('a', async (end) => {
    calls.push({ end })
    page += 1
    if (page === 1) {
      return { ok: true, provider: 'em_kline', data: Array.from({ length: 900 }, (_, i) => bar(`2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 10 + i)) }
    }
    if (page === 2) {
      return { ok: true, provider: 'em_kline', data: [bar('2006-07-05', 5), bar('2006-07-06', 5.1)] }
    }
    return { ok: true, provider: 'em_kline', data: [] }
  })
  assert.equal(calls.length, 2, '第二页不足 PAGE_CAP 应停止翻页')
  assert.ok(result.bars.length >= 902, `应合并两页，实际 ${result.bars.length}`)
  assert.equal(result.bars[0]!.date, '2006-07-05')
})

await test('A-share sync asks for history from 1990 instead of the default ~60 days', async () => {
  let capturedStart: string | undefined
  let capturedDays: number | undefined
  const finance = {
    getKline: async (_c: string, _p: string, start?: string, _e?: string, _s?: unknown, days?: number) => {
      capturedStart = start
      capturedDays = days
      return { ok: true, provider: 'em_kline', data: [bar('2006-07-05', 5), bar('2026-11-17', 20)] }
    },
    getFinancials: async () => ({ ok: true, data: [] }),
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-page-'))
  try {
    const store = new HistoryStore(dir)
    const res = await syncHistory(finance as never, store, '601988', 'a')
    assert.equal(capturedStart, '1990-01-01')
    assert.ok((capturedDays ?? 0) >= 4000, `days 必须远大于 60，实际 ${capturedDays}`)
    assert.equal(res.ok, true)
    assert.equal(res.bars, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('HK/US sync also requests a wide window rather than the default', async () => {
  const seen: Array<{ kind: string; days?: number }> = []
  const finance = {
    getHkKline: async (_c: string, _p: string, _s?: string, _e?: string, _sig?: unknown, days?: number) => {
      seen.push({ kind: 'hk', days }); return { ok: true, provider: 'em_hk', data: [bar('2026-11-17', 300)] }
    },
    getUsKline: async (_c: string, _p: string, _s?: string, _e?: string, _sig?: unknown, days?: number) => {
      seen.push({ kind: 'us', days }); return { ok: true, provider: 'us_quote', data: [bar('2026-11-17', 200)] }
    },
    getFinancials: async () => ({ ok: true, data: [] }),
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-page2-'))
  try {
    const store = new HistoryStore(dir)
    await syncHistory(finance as never, store, '00700', 'hk')
    await syncHistory(finance as never, store, 'AAPL', 'us')
    for (const s of seen) assert.ok((s.days ?? 0) >= 4000, `${s.kind} days=${s.days}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
await test('incremental sync only asks from the given date and stops after one page', async () => {
  let capturedStart: string | undefined
  let pages = 0
  const finance = {
    getKline: async (_c: string, _p: string, start?: string) => {
      capturedStart = start; pages += 1
      return { ok: true, provider: 'em_kline', data: [bar('2026-11-17', 20)] }
    },
    getFinancials: async () => ({ ok: true, data: [] }),
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-since-'))
  try {
    const store = new HistoryStore(dir)
    const res = await syncHistory(finance as never, store, '601988', 'a', undefined, { since: '2026-11-10' })
    assert.equal(capturedStart, '2026-11-10', '增量同步必须传 since，而不是 1990 全量')
    assert.equal(pages, 1)
    assert.equal(res.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
await test('long history uses hfq so early adjusted prices are not dropped', async () => {
  assert.equal(requestedAdjustment('em_kline', 'a', 'hfq'), 'hfq')
  assert.equal(requestedAdjustment('em_kline', 'a', 'qfq'), 'qfq')
  assert.equal(requestedAdjustment('em_kline', 'a', ''), 'none')
  assert.equal(requestedAdjustment('ws_quotes', 'a', 'hfq'), 'unknown')
  assert.equal(requestedAdjustment('em_kline', 'fund', 'hfq'), 'none')
  let capturedAdjust: string | undefined
  const finance = {
    getKline: async (_c: string, _p: string, _s?: string, _e?: string, _sig?: unknown, _days?: number, adjust?: string) => {
      capturedAdjust = adjust
      return { ok: true, provider: 'em_kline', data: [bar('2026-11-17', 5)] }
    },
    getFinancials: async () => ({ ok: true, data: [] }),
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-hfq-'))
  try {
    const store = new HistoryStore(dir)
    await syncHistory(finance as never, store, '601988', 'a')
    assert.equal(capturedAdjust, 'hfq', '全量同步必须请求后复权，避免早期 qfq 变成 0/负价被丢弃')
    const series = await store.read('601988', 'a')
    assert.equal(series?.adjustment, 'hfq')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('replaceKline upgrades a sparse qfq series and keeps events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'replace-'))
  try {
    const store = new HistoryStore(dir)
    await store.mergeKline('601988', 'a', [bar('2026-11-17', 10), { date: '2026-11-16', open: 0, high: 0, low: 0, close: 0, volume: 1 }], { provider: 'em_kline', adjustment: 'qfq' })
    await store.mergeEvents('601988', 'a', [{ date: '2026-09-30', type: '财报', label: '2026三季报' }])
    const full = Array.from({ length: 50 }, (_, i) => bar(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), 5 + i))
    const res = await store.replaceKline('601988', 'a', full, { provider: 'em_kline', adjustment: 'hfq' })
    const series = await store.read('601988', 'a')
    assert.equal(series?.adjustment, 'hfq')
    assert.equal(series?.kline.length, 50)
    assert.equal(series?.events.length, 1, '替换K线不得丢掉事件')
    assert.equal(res.rejected, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('detectGaps ignores holiday-sized breaks and caps the list', () => {
  const mk = (dates: string[]) => dates.map((d) => bar(d, 10))
  // 间隔 4 个工作日（春节级）不应报；间隔 40 个工作日应报。
  const bars = mk(['2026-01-05', '2026-01-09', '2026-03-02'])
  const gaps = detectGaps(bars)
  assert.equal(gaps.length, 1)
  assert.ok(gaps[0]!.weekdays >= 15)
})
console.log(`[history-sync] ${passed} groups passed (offline).`)
