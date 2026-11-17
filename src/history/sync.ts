import type { FinanceDataService } from '../data/service.js'
import type { KlineBar } from '../types.js'
import type { HistoryAdjustment, HistoryStore, MarketEvent } from './store.js'

export type SymbolKind = 'a' | 'hk' | 'us' | 'fund'

export function inferSymbolKind(code: string, kind: SymbolKind): SymbolKind {
  if (kind !== 'a') return kind
  const c = code.trim().toUpperCase()
  if (/\.HK$|^HK[:.]/.test(c) || /^\d{4,5}$/.test(c)) return 'hk'
  if (/[A-Z]/.test(c)) return 'us'
  return kind
}

/**
 * 记录本次抓取实际请求的复权口径。
 * 历史长序列统一用「后复权(hfq)」：前复权(qfq)在长期分红股上会把早期价格调成 0 或负数，
 * 这些 bar 会被校验丢弃，表现为“早期大量缺口”。hfq 价格恒正、且保留总回报。
 */
export function requestedAdjustment(provider: string | undefined, kind: SymbolKind, requested: 'qfq' | 'hfq' | '' = 'hfq'): HistoryAdjustment {
  if (kind === 'fund') return 'none'
  if (provider?.startsWith('ws_')) return 'unknown'
  if (provider?.startsWith('em_') || provider?.startsWith('tx_')) {
    return requested === 'hfq' ? 'hfq' : requested === '' ? 'none' : 'qfq'
  }
  return 'unknown'
}

function numeric(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Turn a report date into a readable label (年报 / 半年报 / 一季报 / 三季报). */
function reportLabel(date: string): string {
  const md = date.slice(5, 10)
  if (md === '12-31') return `${date.slice(0, 4)}年报`
  if (md === '06-30') return `${date.slice(0, 4)}半年报`
  if (md === '03-31') return `${date.slice(0, 4)}一季报`
  if (md === '09-30') return `${date.slice(0, 4)}三季报`
  return `财报 ${date}`
}

function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** 分页拉取上限：单页满 PAGE_CAP 才继续向前翻页，最多 MAX_HISTORY_PAGES 页。 */
const MAX_HISTORY_PAGES = 5
const PAGE_CAP = 800
/**
 * 每页请求的自然日窗口。必须显著大于 60 天：东财等源按 `days` 回溯，
 * 旧实现直接沿用默认 60 天 → 永远拿不到 800 根，翻页从不发生（只有约 3 个月数据）。
 */
const PAGE_DAYS = 4000

interface KlinePage {
  ok: boolean
  data?: unknown
  provider?: string
  error?: string
}

/**
 * 分页拉取更长历史（T7-A）：单页满上限且还有更早数据时，按窗口向前翻页；
 * 不同复权口径的页绝不混入同一条序列（口径不一致即停）。
 */
export async function fetchKlinePaged(
  kind: SymbolKind,
  fetchPage: (end: string | undefined) => Promise<KlinePage>,
  maxPages = MAX_HISTORY_PAGES,
): Promise<{ bars: KlineBar[]; provider?: string; pages: number; error?: string; truncatedAt?: string }> {
  const pages: KlineBar[][] = []
  let provider: string | undefined
  let firstAdjustment: HistoryAdjustment | undefined
  let error: string | undefined
  let end: string | undefined
  let truncatedAt: string | undefined
  for (let page = 0; page < Math.max(1, Math.min(MAX_HISTORY_PAGES, maxPages)); page++) {
    const r = await fetchPage(end)
    if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
      if (!r.ok) { error = r.error ?? '历史分页请求失败'; truncatedAt = end }
      break
    }
    const pageAdjustment = requestedAdjustment(r.provider, kind)
    if (firstAdjustment === undefined) firstAdjustment = pageAdjustment
    else if (pageAdjustment !== firstAdjustment) {
      truncatedAt = end
      break // 不混口径：翻页遇到不同复权源即停
    }
    provider = r.provider ?? provider
    const bars = r.data as KlineBar[]
    const earliest = bars.map((b) => b.date).sort()[0]
    if (!earliest) break
    if (end && earliest > end) { error = '行情源未遵循分页截止日期，已停止重复分页'; truncatedAt = end; break }
    pages.push(bars)
    if (bars.length < PAGE_CAP) break
    if (page === Math.max(1, Math.min(MAX_HISTORY_PAGES, maxPages)) - 1) { truncatedAt = prevDay(earliest); break }
    end = prevDay(earliest)
  }
  // 合并各页：按日期升序拼接，同日保留较新页（先旧后新覆盖）。
  const merged = new Map<string, KlineBar>()
  for (const page of pages.slice().reverse()) {
    for (const b of page) merged.set(b.date, b)
  }
  return {
    bars: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
    provider,
    pages: pages.length,
    error,
    truncatedAt,
  }
}

export interface SyncOptions {
  /** Incremental: fetch only bars from this date (YYYY-MM-DD) — avoids re-pulling full history. */
  since?: string
  /** Cap pages for this run (default MAX_HISTORY_PAGES). */
  maxPages?: number
}

/**
 * Fetch daily K-line (by market kind) and, for equities, financial report dates,
 * then append/update them into the local history store.
 */
export async function syncHistory(
  finance: FinanceDataService,
  store: HistoryStore,
  code: string,
  kind: SymbolKind,
  signal?: AbortSignal,
  options: SyncOptions = {},
) {
  const resolvedKind = inferSymbolKind(code, kind)
  let bars: KlineBar[] = []
  let klineProvider: string | undefined
  let pages = 1
  let klineError: string | undefined
  let truncatedAt: string | undefined
  if (resolvedKind === 'fund') {
    const klineRes = await finance.getFundKline(code, signal)
    bars = klineRes.ok && Array.isArray(klineRes.data) ? klineRes.data as KlineBar[] : []
    klineProvider = klineRes.provider
    klineError = klineRes.ok ? undefined : klineRes.error
  } else {
    const ADJUST: 'qfq' | 'hfq' | '' = 'hfq'
    const fetchPage = (end: string | undefined): Promise<KlinePage> => {
      if (options.since) {
        // 增量更新：只从「本地最后一根前 5 天」往后取，避免每次刷新都拉全部历史。
        return resolvedKind === 'hk' ? finance.getHkKline(code, 'daily', options.since, end, signal, PAGE_DAYS, ADJUST)
          : resolvedKind === 'us' ? finance.getUsKline(code, 'daily', options.since, end, signal, PAGE_DAYS, ADJUST)
            : finance.getKline(code, 'daily', options.since, end, signal, PAGE_DAYS, ADJUST) as Promise<KlinePage>
      }
      return resolvedKind === 'hk' ? finance.getHkKline(code, 'daily', undefined, end, signal, PAGE_DAYS, ADJUST)
        : resolvedKind === 'us' ? finance.getUsKline(code, 'daily', undefined, end, signal, PAGE_DAYS, ADJUST)
          // A 股：显式从 1990 年起取，才能覆盖到上市首日（此前用 days=60 只落 3 个月）
          : finance.getKline(code, 'daily', '1990-01-01', end, signal, PAGE_DAYS, ADJUST) as Promise<KlinePage>
    }
    const paged = await fetchKlinePaged(resolvedKind, fetchPage, options.maxPages ?? (options.since ? 1 : undefined))
    bars = paged.bars
    klineProvider = paged.provider
    pages = paged.pages
    klineError = paged.error
    truncatedAt = paged.truncatedAt
  }
  const adjustment = requestedAdjustment(klineProvider, resolvedKind, 'hfq')
  let merged: { added: number; rejected: number } = { added: 0, rejected: 0 }
  if (bars.length) {
    const existing = await store.read(code, resolvedKind)
    const conflict = existing && existing.adjustment !== 'unknown' && adjustment !== 'unknown' && existing.adjustment !== adjustment
    if (conflict) {
      // NEVER replace years of history with a short incremental response. A basis
      // migration is allowed only when a full, successful response covers the old range.
      const dates = bars.map(b => b.date).sort()
      const old = existing.kline
      const coversExisting = !options.since && !klineError && !truncatedAt && dates[0] &&
        (!old.length || (dates[0] <= old[0]!.date && dates[dates.length - 1]! >= old[old.length - 1]!.date))
      if (coversExisting) {
        merged = await store.replaceKline(code, resolvedKind, bars, { provider: klineProvider, adjustment })
      } else {
        return { ok: false, kind: resolvedKind, provider: klineProvider, bars: bars.length, addedBars: 0,
          rejectedBars: 0, adjustment, pages, truncatedAt, events: 0, addedEvents: 0,
          klineError: `复权口径不一致（${existing.adjustment} vs ${adjustment}）；保留原历史，需完整同步后迁移，不能用局部数据覆盖。` }
      }
    } else {
      // A provider may return only a recent window or fail on older pages. Merge
      // rather than replace so partial availability never truncates cached history.
      merged = await store.mergeKline(code, resolvedKind, bars, { provider: klineProvider, adjustment })
    }
  }

  const events: MarketEvent[] = []
  if (resolvedKind !== 'fund') {
    const fin = await finance.getFinancials(code, signal)
    if (fin.ok && Array.isArray(fin.data)) {
      for (const row of fin.data as Array<Record<string, unknown>>) {
        // 字段随 provider 不同：东财 REPORT_DATE / WeStock EndDate。
        const rd = String(row.REPORT_DATE ?? row.REPORTDATE ?? row.EndDate ?? row.END_DATE ?? '').slice(0, 10)
        // 公告/可得日（≠报告期）：缺省不猜，标记「公告日缺失」。
        const ad = String(row.NOTICE_DATE ?? row.ANN_DATE ?? row.PUBLISH_DATE ?? row.UPDATE_DATE ?? row.publishDate ?? row.announceDate ?? '').slice(0, 10)
        const hasReportDate = /^\d{4}-\d{2}-\d{2}$/.test(rd)
        const hasAvailable = /^\d{4}-\d{2}-\d{2}$/.test(ad)
        if (hasReportDate) {
          events.push({
            date: rd,
            type: '财报',
            label: reportLabel(rd) + (hasAvailable ? `（公告 ${ad}）` : '（公告日缺失，报告期≠可得日）'),
            value: numeric(row.EPSJB ?? row.BASIC_EPS ?? row.BasicEPS ?? row.EPSTTM),
            availableAt: hasAvailable ? ad : undefined,
            dateKind: 'period',
          })
        } else if (hasAvailable) {
          events.push({ date: ad, type: '财报', label: `财报公告 ${ad}`, dateKind: 'available', availableAt: ad })
        }
      }
    }
  }
  const addedEvents = events.length ? await store.mergeEvents(code, resolvedKind, events) : 0

  return {
    ok: bars.length > 0,
    kind: resolvedKind,
    provider: klineProvider,
    bars: bars.length,
    addedBars: merged.added,
    rejectedBars: merged.rejected,
    adjustment,
    pages,
    truncatedAt,
    events: events.length,
    addedEvents,
    klineError,
  }
}
