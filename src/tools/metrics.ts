/**
 * 带元信息的市场工具：
 * - get_market_session：交易所时段/半日市标记（P1-8）
 * - check_etf_premium：ETF 溢价一致性检查（T+1 净值 vs 盘中价不得直接相除）
 * 历史库覆盖度在 history/tools.ts（那里才有 store）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { conflictOf, isEarlyClose, metric, sessionOf, staleness, type Market } from '../data/metric.js'

function asJson(value: unknown): import('@deepseek-ai/dsh-util-values').JsonValue {
  return JSON.parse(JSON.stringify(value)) as import('@deepseek-ai/dsh-util-values').JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

export function registerMetricTools(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'get_market_session',
    description: '交易所交易时段标记：给定市场（a/hk/us）与时间，返回 pre/am/lunch/pm/closed、是否完整交易日、是否为已知提前收市日。用来判断「今天这份数据是不是完整交易日」，避免把半日盘当全天。注意：未接交易所节假日日历，工作日休市不会在这里被识别为 holiday。',
    parameters: {
      market: { type: 'string', enum: ['a', 'hk', 'us'], description: '市场，默认 a' },
      at: { type: 'string', description: '可选 ISO 时间，默认现在' },
    },
    output: jsonOut,
    async execute(args) {
      const market = (['a', 'hk', 'us'].includes(String(args.market)) ? String(args.market) : 'a') as Market
      const at = typeof args.at === 'string' && args.at.trim() ? new Date(args.at) : new Date()
      if (!Number.isFinite(at.getTime())) return asJson({ ok: false, error: 'at 不是合法时间' })
      const state = sessionOf(market, at)
      const date = at.toISOString().slice(0, 10)
      const early = isEarlyClose(market, date)
      return asJson({
        ok: true,
        at: at.toISOString(),
        ...state,
        fullSession: state.fullSession && !early,
        ...(early ? { note: `${state.note} · 已知提前收市日` } : {}),
        caveat: '未接交易所节假日日历；holiday 需由「工作日但无当日数据」另行判断。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'check_etf_premium',
    description: 'ETF 溢价一致性检查：把「来源给的溢价率」与「你手算的溢价」放在一起对照，并判定口径是否可比。QDII/跨境 ETF 的净值是 T+1、价格是盘中，两者直接相除会算出假溢价——这种情况下本工具返回 comparable=false，不给单一结论。用于回答「这个溢价能不能直接引用」。',
    parameters: {
      sourcePremium: { type: 'number', required: true, description: '来源给的溢价率（%），如 22.56' },
      price: { type: 'number', description: '盘中价格' },
      nav: { type: 'number', description: '单位净值（若为 T+1 净值请同时给 navAsOf）' },
      navAsOf: { type: 'string', description: '净值日期 YYYY-MM-DD；与价格日期不同则不可直接相除' },
      priceAsOf: { type: 'string', description: '价格日期 YYYY-MM-DD' },
      tolerancePct: { type: 'number', description: '允许的差异（百分点），默认 1' },
    },
    output: jsonOut,
    async execute(args) {
      const sourcePremium = Number(args.sourcePremium)
      if (!Number.isFinite(sourcePremium)) return asJson({ ok: false, error: 'sourcePremium 必须是数字（百分数）' })
      const price = Number(args.price)
      const nav = Number(args.nav)
      const tolerance = Number.isFinite(Number(args.tolerancePct)) ? Number(args.tolerancePct) : 1
      const navAsOf = typeof args.navAsOf === 'string' && args.navAsOf.trim() ? args.navAsOf.trim() : null
      const priceAsOf = typeof args.priceAsOf === 'string' && args.priceAsOf.trim() ? args.priceAsOf.trim() : null
      const comparable = Boolean(navAsOf && priceAsOf && navAsOf === priceAsOf && Number.isFinite(nav) && nav > 0 && Number.isFinite(price) && price > 0)
      const computed = comparable ? Math.round((price / nav - 1) * 1000000) / 10000 : null
      const { conflict, diff } = conflictOf(sourcePremium, computed, tolerance)
      const reasons: string[] = []
      if (!comparable) {
        reasons.push(navAsOf && priceAsOf && navAsOf !== priceAsOf
          ? `净值日期 ${navAsOf} 与价格日期 ${priceAsOf} 不同（T+1 净值），不能直接相除`
          : '缺净值或净值日期，无法独立反算溢价')
      }
      if (Math.abs(sourcePremium) >= 15) reasons.push(`来源溢价 ${sourcePremium}% 幅度异常，必须与 IOPV 交叉验证后再引用`)
      return asJson({
        ok: true,
        source: metric(sourcePremium, {
          unit: '%', asOf: priceAsOf, window: '当日', source: '来源字段（口径未核准）',
          stale: staleness(priceAsOf, 'intraday'), conflict,
          ...(conflict && diff !== undefined ? { note: `与反算值相差 ${diff} 个百分点` } : {}),
        }),
        computed: computed === null ? null : metric(computed, {
          unit: '%', asOf: priceAsOf, window: '当日', source: 'price/nav 反算',
          stale: staleness(navAsOf, 't1'), conflict,
        }),
        comparable,
        conflict,
        ...(diff !== undefined ? { diffPct: diff } : {}),
        verdict: !comparable ? 'not-comparable'
          : conflict ? 'conflict' : 'consistent',
        reasons,
        guidance: conflict || !comparable
          ? '不要单独引用任一溢价数字；先取当日 IOPV 或券商页面核对，并在结论里写明口径。'
          : '两者一致，可引用，并注明净值日期与价格时点。',
      })
    },
  }))
}
