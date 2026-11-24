import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { FinanceDataService } from '../data/service.js'
import type { PanelBus } from '../panel-bus.js'
import type { HistoryStore } from './store.js'
import { syncHistory, type SymbolKind } from './sync.js'
import { metric, staleness } from '../data/metric.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}
const KINDS: SymbolKind[] = ['a', 'hk', 'us', 'fund']

/** Register local-history tools: sync (append/update), read, add event, list. */
export function registerHistoryTools(ctx: Context, finance: FinanceDataService, store: HistoryStore, bus: PanelBus) {
  ctx.tools.register(defineTool({
    name: 'sync_history',
    description: '抓取日K线（及股票财报日期）并追加/更新到本地历史库（data/history）。kind：a=A股 hk=港股 us=美股 fund=基金。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 600519 / 00700 / AAPL / 110022' },
      kind: { type: 'string', enum: KINDS, description: '市场类型，默认 a' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const kind = (KINDS.includes(args.kind as SymbolKind) ? args.kind : 'a') as SymbolKind
      const code = String(args.code)
      const result = await syncHistory(finance, store, code, kind, exec.signal)
      bus.publish({ kind: 'history', code, bars: result.bars, addedBars: result.addedBars })
      return asJson(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_history',
    description: '读取本地历史库中某代码的 K 线与事件（财报/分红等时间标记）。同代码存在股票/基金等多种身份时必须指定 kind，不会自动选最近一份。',
    parameters: {
      code: { type: 'string', required: true },
      kind: { type: 'string', enum: KINDS, description: '可选市场类型 a/hk/us/fund；同代码多种身份时必填，基金请传 fund' },
      limit: { type: 'number', description: '返回最近多少根K线，默认全部' },
    },
    output: jsonOut,
    async execute(args) {
      const h = await store.read(String(args.code), args.kind as SymbolKind | undefined)
      if (!h) return asJson({ ok: false, error: '本地无历史，请先 sync_history' })
      const kline = args.limit ? h.kline.slice(-Number(args.limit)) : h.kline
      return asJson({
        ok: true, code: h.code, kind: h.kind, updatedAt: h.updatedAt, period: h.period,
        adjustment: h.adjustment, provider: h.provider, fetchedAt: h.fetchedAt,
        bars: kline.length, kline, events: h.events,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'add_market_event',
    description: '给本地历史库某代码追加一个时间事件（如分红、拆分、公告），用于在 K 线上标注。',
    parameters: {
      code: { type: 'string', required: true },
      date: { type: 'string', required: true, description: 'YYYY-MM-DD' },
      type: { type: 'string', required: true, description: '事件类型，如 分红/拆分/公告' },
      label: { type: 'string', required: true, description: '标注文本' },
      value: { type: 'number', description: '可选数值，如每股分红' },
      kind: { type: 'string', enum: KINDS, description: '市场类型，默认 a；基金请传 fund，避免与同代码股票混库' },
    },
    output: jsonOut,
    async execute(args) {
      const added = await store.mergeEvents(String(args.code), (KINDS.includes(args.kind as SymbolKind) ? args.kind : 'a') as SymbolKind, [{ date: String(args.date), type: String(args.type), label: String(args.label), value: typeof args.value === 'number' ? args.value : undefined }])
      return asJson({ ok: true, added })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_history',
    description: '列出本地历史库已保存的代码及其 K 线/事件数量。',
    parameters: {},
    output: jsonOut,
    async execute() { return asJson({ ok: true, symbols: await store.list() }) },
  }))

  // P2-5：覆盖度报告。回答「这只票够不够做回测」，缺口按工作日估算，不冒充确定缺失。
  ctx.tools.register(defineTool({
    name: 'get_history_coverage',
    description: '本地历史覆盖度：缓存了多少根 K 线、覆盖区间、疑似长缺口（≥15 个工作日）、事件数、内容哈希。用来判断「够不够算指标/做回测」，不要靠猜。缺口按工作日估算，未扣法定休市与停牌。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 600519 / 00700 / AAPL' },
      kind: { type: 'string', enum: ['a', 'hk', 'us', 'fund'], description: '市场类型，默认 a' },
    },
    output: jsonOut,
    async execute(args) {
      const code = String(args.code ?? '').trim()
      if (!code) return asJson({ ok: false, error: 'code is required' })
      const kind = ['a', 'hk', 'us', 'fund'].includes(String(args.kind)) ? String(args.kind) as 'a' | 'hk' | 'us' | 'fund' : 'a'
      try {
        const manifest = await store.manifest(code, kind)
        if (!manifest) return asJson({ ok: false, code, kind, error: '本地没有该标的的历史' })
        const bars = manifest.bars ?? 0
        return asJson({
          ok: true,
          code, kind, bars,
          coverage: manifest.coverage ?? null,
          gaps: manifest.gaps ?? [],
          events: manifest.events ?? 0,
          eventsMissingAvailableAt: manifest.eventsMissingAvailableAt ?? 0,
          contentHash: manifest.contentHash ?? null,
          barCount: metric(bars, {
            unit: '根',
            asOf: manifest.coverage?.to ?? null,
            window: '全库',
            source: '本地历史库（sync_history 写入）',
            stale: staleness(manifest.coverage?.to ?? null, 'daily'),
            conflict: false,
          }),
          notes: [
            '缺口按工作日估算，未扣法定休市/停牌，不是确定缺失。',
            ...(bars < 60 ? ['少于 60 根，算均线或做回测前先补历史。'] : []),
            ...(manifest.eventsMissingAvailableAt ? [`${manifest.eventsMissingAvailableAt} 个事件缺可得日，不能当回测已知信息。`] : []),
          ],
        })
      } catch (error) {
        return asJson({ ok: false, code, kind, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
