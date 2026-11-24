import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import '@deepseek-ai/dsh-tools'
import { getPanelFocus } from '../panel-focus.js'
import type { AnalysisRefs, AnalysisStore } from '../analysis-store.js'
import { routeCode, type FinanceDataService } from '../data/service.js'
import type { PanelBus } from '../panel-bus.js'
import { buildStockDossier } from '../data/dossier.js'
import { buildFundDossier } from '../data/fund-dossier.js'
import { GLOBAL_MACRO_SERIES_KEYS } from '../data/global-macro.js'
import { fetchAndBuildGlobalNewsRadar } from '../news/global-radar.js'
import { fetchGlobalQuote, fetchGlobalKline } from '../data/global-quotes.js'
import { listCnDatasets, fetchCnDataset, checkCnBridge } from '../data/cn-datasets.js'
import { dossierToolResult } from './dossier-data.js'
import { registerIntradayTools } from './intraday.js'
import { fetchStrategyExperiment } from '../strategy/lab-service.js'
import { reviewStrategyEnvironment } from '../strategy/lab.js'
import { evaluatePortfolioPolicy, type PortfolioPolicyInput } from '../strategy/portfolio-policy.js'
import { verifyPortfolioData, type PortfolioVerificationInput } from '../strategy/portfolio-verification.js'
import { runPortfolioBacktest } from '../strategy/portfolio-backtest.js'
import {
  compareFunds,
  compareWithBenchmark,
  computeFundOverlap,
  computeFundRiskMetrics,
  isOnExchangeFundCode,
  normalizeFundHoldingRows,
  normalizeHoldingCode,
} from '../fund-analysis.js'
import { buildLookthrough, fetchFundTopHoldings, marginalLookthrough } from '../lookthrough.js'
import { simulateRebalance } from '../rebalance.js'
import type { PortfolioStore } from '../store.js'
import type { PersonalStore } from '../personal.js'
import { StrategyConfirmationRequired, type StrategyLibrary } from '../strategy/library.js'
import type { AssetType } from '../types.js'

// 'kline'、'market' 为兼容别名（K线工作区与「市场」页均已并入 quotes「行情」，
// 导航时等价 quotes；kline 另聚焦K线工作区，market 与 quotes 同页含板块热度）。
const PANEL_TABS = ['home', 'quotes', 'market', 'holdings', 'funds', 'kline', 'macro', 'news', 'research', 'dossier', 'discover', 'policy', 'sources', 'skills', 'health', 'follow', 'strategy', 'advice', 'journal', 'capital', 'wealth', 'learn', 'evidence'] as const

function text(lines: string | string[]) {
  const body = Array.isArray(lines) ? lines.join('\n') : lines
  return [{ type: 'text' as const, text: body }]
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => text(JSON.stringify(value, null, 2)),
}

export function registerTools(ctx: Context, finance: FinanceDataService, store: PortfolioStore, analyses: AnalysisStore, bus: PanelBus, personal?: PersonalStore, library?: StrategyLibrary) {
  registerIntradayTools(ctx, finance)

  // 个股深度档案：一次调用拿到该标的的行情外全部维度（研究/资金/股东/风险/资讯/产业链，
  // A 股另有东财公司事件明细与全球财务；口径/时点随 section 返回）。
  ctx.tools.register(defineTool({
    name: 'stock_dossier',
    description: '个股深度档案：并发取回一致预期、股票评分、ESG、机构评级、资金流向（A股优先东财逐日 20 日明细）、融资融券（A股含东财逐日明细）、大宗交易（A股含东财逐笔明细）、龙虎榜、北向持仓、股东研究、分红（A股含东财分红送配）、业绩预告/快报（A股）、公告（A股含东财公告原文索引）、回购、风险事件、停复牌、新闻、所属产业链，以及港股财务（东财 HKF10，累计口径非单季）与美股财务（SEC XBRL，10-K 年度/10-Q 单季）。各维度显式来源与数据时点，失败只影响该维度；基金请改用 fund_dossier。',
    parameters: {
      code: { type: 'string', description: '标的代码，如 600519 / 00700 / AAPL' },
      type: { type: 'string', description: 'stock（默认）或 fund' },
    },
    output: jsonOut,
    async execute(args) {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('code is required')
      const type = String(args.type ?? 'stock') === 'fund' ? 'fund' as const : 'stock' as const
      const d = await buildStockDossier(finance, code, type)
      // 登记快照 id：报告 save_position_analysis 可回引它（证明基于哪一版档案）。
      await analyses.noteSnapshot(d.snapshotId, code, type)
      return asJson(dossierToolResult(d))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'probe_finance_sources',
    description: '逐个探测公开行情 HTTP 端点健康状态（串行、有间隔）。公开源不稳定时应先运行本工具。',
    parameters: {
      gap_sec: { type: 'number', description: '请求间隔秒，默认 3' },
    },
    output: {
      ...jsonOut,
      render: (_a, value) => {
        const v = value as { okCount?: number; total?: number; probedAt?: string }
        return text([`探测完成 ${v.okCount}/${v.total} 可用`, `时间 ${v.probedAt}`])
      },
    },
    async execute(_args, exec) {
      const report = await finance.probe(exec.signal)
      bus.publish({ kind: 'providers' })
      return asJson({
        probedAt: report.probedAt,
        okCount: report.results.filter((r) => r.ok).length,
        total: report.results.length,
        results: report.results,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_kline',
    description: '获取 A 股 K 线（开高低收成交量）。端点对照 AkShare stock_zh_a_hist / stock_zh_a_hist_tx。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({
        ok: true,
        provider: res.provider,
        code: args.code,
        count: res.data.length,
        data: res.data.slice(-30),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_realtime_quote',
    description: '获取单票实时行情。端点对照 AkShare stock_bid_ask_em / stock_individual_info_em。',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getRealtimeQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_quotes',
    description: '批量实时行情：一次调用拿多只标的（优先 WeStock `quote a,b,c`）。要对比多只股票/持仓时用这个，别逐只调用 get_realtime_quote。',
    parameters: {
      codes: { type: 'string', required: true, description: '代码列表，逗号分隔，如 600519,00700,AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const codes = String(args.codes ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      if (!codes.length) return asJson({ ok: false, error: 'codes is required' })
      const res = await finance.getQuotes(codes, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: (res.data as unknown[])?.length ?? 0, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_us_quote',
    description: '获取美股实时行情（Yahoo Finance 免费直连）。代码如 AAPL、TSLA、NVDA。',
    parameters: {
      code: { type: 'string', required: true, description: '美股代码，如 AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getUsQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_us_kline',
    description: '获取美股 K 线（开高低收成交量，Yahoo Finance 免费直连）。',
    parameters: {
      code: { type: 'string', required: true, description: '美股代码，如 AAPL' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getUsKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-30) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_quote',
    description: '获取港股实时行情（东财免费直连）。代码如 00700、09988。',
    parameters: {
      code: { type: 'string', required: true, description: '港股代码，如 00700' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getHkQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_kline',
    description: '获取港股 K 线（开高低收成交量，东财免费直连）。端点对照 AkShare stock_hk_hist。',
    parameters: {
      code: { type: 'string', required: true, description: '港股代码，如 00700' },
      period: { type: 'string', description: 'daily|weekly|monthly', enum: ['daily', 'weekly', 'monthly'] },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getHkKline(args.code, args.period ?? 'daily', args.start_date, args.end_date, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) {
        return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      }
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-30) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_hk_list',
    description: '获取港股列表样本（东财 clist 首页，非全市场）。端点对照 AkShare stock_hk_spot_em。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getHkList(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_symbol',
    description: '按代码或名称跨市场解析证券（A股/港股/美股），返回市场与东财 secid。端点：东财 suggest。',
    parameters: {
      query: { type: 'string', required: true, description: '代码或名称，如 腾讯 / 00700 / AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.searchSymbol(args.query, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, count: res.data.length, matches: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_info',
    description: '获取个股档案（现价、涨跌、总市值/流通市值、总股本/流通股）。跨市场，代码或名称。端点对照 AkShare stock_individual_info_em。',
    parameters: {
      code: { type: 'string', required: true, description: '代码或名称，如 600519 / 00700 / AAPL' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getStockInfo(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_quote',
    description: '获取公募基金最新单位净值与日涨跌（东财 pingzhongdata，免费直连）。code 为 6 位基金代码，如 110022。返回中的 asOf/raw.navDate 是净值日期（数据时点，基金净值为 T+1 更新），不是抓取时间。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022 / 005827' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundQuote(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_kline',
    description: '获取公募基金历史单位净值走势（东财 pingzhongdata）。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundKline(args.code, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, data: res.data.slice(-60) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_fund_rank',
    description: '开放式基金排行（东财）。fundType：all/stock/hybrid/bond/index/qdii/money；sortBy 按区间排序（默认 m6=近6月；货币基金固定按近1年收益口径）；page 翻页。',
    parameters: {
      fundType: { type: 'string', enum: ['all', 'stock', 'hybrid', 'bond', 'index', 'qdii', 'money'], description: '基金分类，默认 all' },
      size: { type: 'number', description: '返回条数（1-50，默认 20）' },
      sortBy: { type: 'string', enum: ['m1', 'm3', 'm6', 'y1', 'y2', 'y3', 'ytd'], description: '排序区间：近1月/近3月/近6月/近1年/近2年/近3年/今年来，默认 m6' },
      page: { type: 'number', description: '页码（从 1 起，默认 1）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFundRank(args.fundType ?? 'all', args.size ?? 20, args.sortBy, args.page, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, rows: res.data })
    },
  }))

  // P0 基金深度指标本地化：净值序列 → 风险/收益指标（纯本地计算，样本不足输出 null）。
  ctx.tools.register(defineTool({
    name: 'calculate_fund_metrics',
    description: '基金风险指标（本地计算，确定性）：基于历史净值给出区间/近1年收益、年化、波动、最大回撤、夏普、卡玛、阶段涨幅；可与基准指数（默认 sh000300 沪深300）按共同交易日对齐，计算超额、Beta、相关系数与年化跟踪误差。数据不足的字段为 null，绝不猜测。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022' },
      benchmark: { type: 'string', description: '基准指数代码（kline 可取，如 sh000300 / sh000905 / sh000001）；传 none 跳过对比。默认 sh000300' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('code is required')
      const benchmark = String(args.benchmark ?? 'sh000300').trim() || 'sh000300'
      const kl = await finance.getFundKline(code, exec.signal)
      if (!kl.ok || !Array.isArray(kl.data)) return asJson({ ok: false, code, error: kl.error ?? 'fund kline unavailable' })
      const nav = kl.data.filter((b) => Number.isFinite(b.close) && b.close > 0).map((b) => ({ date: b.date, nav: b.close }))
      const metrics = computeFundRiskMetrics(nav)
      let comparison: unknown = null
      let benchmarkError: string | undefined
      if (benchmark.toLowerCase() !== 'none' && metrics.points >= 2) {
        try {
          const bk = await finance.getKline(benchmark, 'daily', undefined, undefined, exec.signal)
          if (bk.ok && Array.isArray(bk.data) && bk.data.length) {
            comparison = compareWithBenchmark(nav, bk.data.map((b) => ({ date: b.date, close: b.close })), benchmark)
            if (!comparison) benchmarkError = '与基准共同交易日收益样本不足 40 天，不产出对比结论'
          } else {
            benchmarkError = `基准 ${benchmark} K线不可用：${(!bk.ok && bk.error) || '空序列'}（基金指标不受影响）`
          }
        } catch (err) {
          benchmarkError = `基准 ${benchmark} 获取失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
      return asJson({ ok: true, code, provider: kl.provider, benchmark: benchmark.toLowerCase() === 'none' ? null : benchmark, metrics, comparison, benchmarkError })
    },
  }))

  // P1 多基金对比：本地相关矩阵 + 风险摘要（不依赖外部 MCP）。
  ctx.tools.register(defineTool({
    name: 'compare_funds',
    description: '多基金对比（本地计算）：一次取回 2-8 只基金的历史净值，输出每只的收益/回撤/波动摘要与两两日收益相关系数（含平均相关性），用于判断「是不是买了同一种东西」。',
    parameters: {
      codes: { type: 'array', required: true, items: { type: 'string' }, description: '2-8 只基金代码' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const raw = Array.isArray(args.codes) ? args.codes.map((c) => String(c).trim()).filter(Boolean) : []
      const codes = [...new Set(raw)]
      if (codes.length < 2) throw new Error('至少需要 2 只基金代码')
      if (codes.length > 8) throw new Error('最多同时对比 8 只基金')
      const results = await Promise.all(codes.map(async (code) => ({ code, res: await finance.getFundKline(code, exec.signal).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })) })))
      const series: Record<string, Array<{ date: string; nav: number }>> = {}
      const failed: Array<{ code: string; error: string }> = []
      for (const { code, res } of results) {
        if (res.ok && Array.isArray(res.data) && res.data.length) {
          series[code] = res.data.filter((b) => Number.isFinite(b.close) && b.close > 0).map((b) => ({ date: b.date, nav: b.close }))
        } else failed.push({ code, error: (!res.ok && res.error) || 'empty series' })
      }
      if (Object.keys(series).length < 2) return asJson({ ok: false, error: '有效净值序列不足 2 只，无法对比', failed })
      return asJson({ ok: true, comparison: compareFunds(series), failed: failed.length ? failed : undefined })
    },
  }))

  // P1 基金档案：基金维度的 stock_dossier 等价物（股票档案 18 维对基金大多 unsupported）。
  ctx.tools.register(defineTool({
    name: 'fund_dossier',
    description: '基金深度档案：一次并发取回基金经理、资产配置、持有人结构、规模与申赎、同类排名、业绩评价、重仓持仓，以及本地计算的风险指标和基准对比（默认沪深300）。深度研究/尽调基金时优先用它。',
    parameters: {
      code: { type: 'string', required: true, description: '基金代码，如 110022' },
      benchmark: { type: 'string', description: '基准指数代码，默认 sh000300；传 none 跳过基准对比' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('code is required')
      const d = await buildFundDossier(finance, code, { benchmark: args.benchmark ? String(args.benchmark) : undefined })
      await analyses.noteSnapshot(d.snapshotId, code, 'fund')
      return asJson(dossierToolResult(d, '基金深度档案'))
    },
  }))

  // P1 持仓穿透：基金重仓 × 组合个股的重叠暴露（伪分散检测）。
  ctx.tools.register(defineTool({
    name: 'analyze_fund_overlap',
    description: '基金持仓穿透：取基金重仓股（场内 ETF 回落 etf_holdings），与组合内股票持仓比对，量化「基金+个股」的重复暴露（伪分散）。不传 codes 时分析组合里的全部基金。重仓上游契约未线上核实，字段按命名模式解析，解析失败会显式报错。',
    parameters: {
      codes: { type: 'array', items: { type: 'string' }, description: '要分析的基金代码；缺省=组合内全部基金持仓' },
      topN: { type: 'number', description: '每只基金取前 N 大重仓（默认 10，上限 50）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const topN = Math.min(Math.max(Math.trunc(Number(args.topN ?? 10)) || 10, 1), 50)
      let weights: Array<{ code: string; name?: string; type?: string; weight: number }> = []
      let weightsAvailable = false
      try {
        const pf = await finance.analyzePortfolio(exec.signal)
        if (pf.ok && pf.risk) {
          weights = pf.risk.weights as Array<{ code: string; name?: string; type?: string; weight: number }>
          weightsAvailable = true
        }
      } catch { /* 权重不可用时仍输出不带权重的重叠清单 */ }
      const portfolioStocks = weights
        .filter((w) => (w.type ?? 'stock') !== 'fund')
        .map((w) => ({ code: normalizeHoldingCode(w.code), name: w.name, weightPct: w.weight }))
      const fundWeightByCode = new Map(weights.filter((w) => w.type === 'fund').map((w) => [normalizeHoldingCode(w.code), w.weight]))
      const argCodes = Array.isArray(args.codes) ? args.codes.map((c) => String(c).trim()).filter(Boolean) : []
      const fundCodes = [...new Set(argCodes.length ? argCodes.map(normalizeHoldingCode) : [...fundWeightByCode.keys()])]
      if (!fundCodes.length) return asJson({ ok: false, error: '组合里没有基金持仓，也未传入 codes' })
      if (fundCodes.length > 20) throw new Error('一次最多分析 20 只基金')

      interface FundOverlapEntry {
        code: string
        fundWeightPct: number | null
        source?: string
        topHoldings?: Array<{ code: string; name?: string; weightPct?: number }>
        overlaps?: Array<{ code: string; name?: string; fundWeightPct?: number; portfolioWeightPct?: number }>
        overlapWeightPct?: number | null
        error?: string
      }
      const funds = await Promise.all(fundCodes.map(async (code): Promise<FundOverlapEntry> => {
        const entry: FundOverlapEntry = { code, fundWeightPct: fundWeightByCode.get(code) ?? null }
        try {
          let rows: Array<{ code: string; name?: string; weightPct?: number }> = []
          let source = 'em_fund_holdings'
          const res = await finance.getFundHoldings(code, topN, exec.signal)
          if (res.ok && Array.isArray(res.data) && res.data.length) rows = res.data
          else if (isOnExchangeFundCode(code)) {
            const etf = await finance.westock<unknown[]>('etf_holdings', { code }, exec.signal)
            if (etf.ok && Array.isArray(etf.data)) {
              rows = normalizeFundHoldingRows(etf.data)
              source = etf.provider ?? 'ws_etf_holdings'
            } else throw new Error(`重仓获取失败：${res.ok ? '空持仓' : res.error ?? '无数据'}；场内回落亦不可用`)
          } else {
            throw new Error(`重仓获取失败：${res.ok ? '空持仓' : res.error ?? '无数据'}`)
          }
          const overlap = computeFundOverlap(code, rows.slice(0, topN), portfolioStocks)
          return { ...entry, source, topHoldings: overlap.topHoldings, overlaps: overlap.overlaps, overlapWeightPct: overlap.overlapWeightPct }
        } catch (err) {
          return { ...entry, error: err instanceof Error ? err.message : String(err) }
        }
      }))

      // 间接暴露：组合权重% × 重仓里该股票的比例% / 100（仅在权重可得时输出）。
      const exposureByCode = new Map<string, { code: string; name?: string; via: Array<{ fund: string; fundWeightPct: number; stockWeightInFundPct: number }>; indirectPct: number; directPct: number }>()
      if (weightsAvailable) {
        for (const f of funds) {
          const fw = f.fundWeightPct
          if (typeof fw !== 'number' || !Array.isArray(f.overlaps)) continue
          for (const ov of f.overlaps) {
            if (typeof ov.fundWeightPct !== 'number') continue
            const hit = exposureByCode.get(ov.code) ?? {
              code: ov.code, name: ov.name, via: [], indirectPct: 0,
              directPct: portfolioStocks.find((p) => p.code === ov.code)?.weightPct ?? 0,
            }
            hit.via.push({ fund: f.code, fundWeightPct: fw, stockWeightInFundPct: ov.fundWeightPct })
            hit.indirectPct += (fw * ov.fundWeightPct) / 100
            exposureByCode.set(ov.code, hit)
          }
        }
      }
      const repeatedExposure = [...exposureByCode.values()]
        .map((e) => ({ ...e, indirectPct: Math.round(e.indirectPct * 100) / 100, totalPct: Math.round((e.indirectPct + e.directPct) * 100) / 100 }))
        .filter((e) => e.via.length > 0)
        .sort((a, b) => b.totalPct - a.totalPct)
      return asJson({
        ok: true,
        weightsAvailable,
        portfolioStockCount: portfolioStocks.length,
        funds,
        repeatedExposure: weightsAvailable ? repeatedExposure : undefined,
        note: weightsAvailable
          ? '间接暴露 = 基金占组合% × 重仓里该股票占比% / 100（不含基金内非重仓持仓与衍生品，属上界近似）；总暴露=直接持仓+间接。'
          : '组合权重不可用（缺行情或多币种未折算）：仅输出重叠清单，未量化间接暴露。',
      })
    },
  }))

  // P2 全组合穿透：直投 + 全部基金重仓 → 真实股票暴露、HHI/有效个股、重复暴露排行。
  ctx.tools.register(defineTool({
    name: 'portfolio_lookthrough',
    description: '组合持仓穿透体检：把每只基金的前 N 大重仓展开成真实股票暴露，输出 HHI/有效个股数/重复暴露排行与告警（伪分散检测）。判断「买了多只基金是否真分散」先用它。前 N 穿透为上界近似（完整持仓仅年报披露），失败基金显式标注。',
    parameters: {
      topN: { type: 'number', description: '每只基金取前 N 大重仓（默认 10，1–50）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const topN = Math.min(Math.max(Math.trunc(Number(args.topN ?? 10)) || 10, 1), 50)
      const t0 = Date.now()
      const r = await buildLookthrough(finance, { topN, signal: exec.signal })
      const maxStocks = 40
      return asJson({
        ok: true,
        weightsSource: r.weightsSource,
        topN: r.topN,
        totals: r.totals,
        funds: r.funds,
        stocks: r.stocks.slice(0, maxStocks),
        stocksTruncated: r.stocks.length > maxStocks,
        repeatedTop: r.repeatedTop.slice(0, 20),
        warnings: r.warnings,
        notes: r.notes,
        elapsedMs: Date.now() - t0,
      })
    },
  }))

  // P2 买入前边际检查：先看会不会加重重复暴露，再决定加不加、加多少。
  ctx.tools.register(defineTool({
    name: 'check_new_position',
    description: '买入前检查：假设给某标的（个股或基金）X% 仓位，输出穿透集中度前后对比（HHI/有效个股数/第一大个股）、与现有持仓的重叠明细、基金重叠占比与告警。加仓/新建仓前必查——回答「这是分散还是在加大同一个赌注」。',
    parameters: {
      code: { type: 'string', required: true, description: '标的代码（个股或基金）' },
      type: { type: 'string', enum: ['stock', 'fund'], description: '标的类型，默认 stock' },
      weightPct: { type: 'number', description: '假设建仓占组合 %（默认 5）' },
      topN: { type: 'number', description: '基金穿透取前 N 大重仓（默认 10，1–50）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('code is required')
      const type = args.type === 'fund' ? 'fund' : 'stock'
      const weightPct = Number.isFinite(Number(args.weightPct)) && Number(args.weightPct) > 0 ? Number(args.weightPct) : 5
      const topN = Math.min(Math.max(Math.trunc(Number(args.topN ?? 10)) || 10, 1), 50)
      const current = await buildLookthrough(finance, { topN, signal: exec.signal })
      let proposed: Parameters<typeof marginalLookthrough>[1]
      if (type === 'fund') {
        const r = await fetchFundTopHoldings(finance, code, topN, exec.signal)
        const row = current.funds.find((f) => f.code === code)
        proposed = r.ok
          ? { code, type, weightPct, holdings: r.rows, name: row?.name }
          : { code, type, weightPct, error: r.error, name: row?.name }
      } else {
        proposed = { code, type, weightPct }
      }
      const m = marginalLookthrough(current, proposed)
      return asJson({
        ok: true,
        weightsSource: current.weightsSource,
        ...m,
        notes: m.notes,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_sector_board',
    description: '行业板块涨跌（东财，对照 AkShare stock_board_industry_name_em）。order=desc 涨幅榜 / asc 跌幅榜。用于看“今天风险在哪个板块”。',
    parameters: {
      order: { type: 'string', enum: ['desc', 'asc'], description: 'desc 涨幅榜（默认）/ asc 跌幅榜' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getSectorBoard((args.order as 'desc' | 'asc') ?? 'desc', exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, sectors: res.data.slice(0, 20) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_news',
    description: '市场快讯电报（东财全球财经快讯，单一时间线，对照 AkShare stock_info_global_em）。用于了解“正在发生什么”。',
    parameters: {
      size: { type: 'number', description: '返回条数（1-50，默认 20）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getNewsFlash(args.size ?? 20, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, news: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_news',
    description: '个股相关新闻（东财搜索，对照 AkShare stock_news_em）。按持仓/自选代码拉，与仓位相关。',
    parameters: {
      code: { type: 'string', required: true, description: '代码或名称，如 600519 / 00700 / 腾讯' },
      size: { type: 'number', description: '返回条数（1-20，默认 10）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getStockNews(args.code, args.size ?? 10, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, news: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_research_reports',
    description: '获取券商研报列表（WeStock）：标题、机构、评级、发布时间。用于投研资料收集与交叉验证。',
    parameters: {
      code: { type: 'string', required: true, description: '标的代码，如 600519 / 00700' },
      size: { type: 'number', description: '返回条数（1-20，默认 10）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getResearchReports(String(args.code ?? '').trim(), Math.min(Math.max(Number(args.size ?? 10), 1), 20), exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? '研报数据源不可用' })
      return asJson({ ok: true, provider: res.provider, code: args.code, count: res.data.length, reports: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_research_report_detail',
    description: '按研报 ID 读取研报正文（WeStock report detail）。ID 来自 get_research_reports。',
    parameters: { id: { type: 'string', required: true, description: '研报 ID，如 res843401040115' } },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getResearchReportDetail(String(args.id ?? '').trim(), exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, id: res.data.id, title: res.data.title, body: res.data.body })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_macro_china',
    description: '中国宏观经济指标（东财 datacenter，对照 AkShare macro_china_*）。series：cpi/ppi/pmi/gdp/money_supply。返回近 24 期与最新值。',
    parameters: {
      series: { type: 'string', required: true, enum: ['cpi', 'ppi', 'pmi', 'gdp', 'money_supply'], description: '指标序列' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getMacro(args.series, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, data: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_macro_global',
    description: '全球宏观结构化数据（真实统计源，不是网页摘要）：us_cpi 美国CPI同比（OECD SDMX 月度）、ea_hicp 欧元区HICP同比（Eurostat 月度）、ea_unemployment 欧元区失业率（Eurostat 月度季调）、us_gdp_growth / ea_gdp_growth 实际GDP年增速（World Bank 年度）、ea_policy_rate 欧央行存款便利利率（ECB data-api 日频）。每条序列返回 source/unit/asOf(最新统计期，不是抓取时间)/fetchedAt/points/latest/provenance/notes；抓取失败或空值明确 error，不补 0。',
    parameters: {
      series: {
        type: 'array',
        items: { type: 'string', enum: [...GLOBAL_MACRO_SERIES_KEYS] },
        description: `要取的序列；缺省=全部 ${GLOBAL_MACRO_SERIES_KEYS.length} 条`,
      },
      limit: { type: 'number', description: '每条序列返回最近多少期（1-120，默认 24）' },
    },
    output: jsonOut,
    async execute(args, exec) {
      // 模型可能给数组，也可能给逗号分隔字符串；两种都交给 normalizeSeriesRequest 处理。
      const requested = Array.isArray(args.series)
        ? args.series.map((item) => String(item))
        : typeof args.series === 'string' ? args.series : undefined
      const limit = args.limit === undefined ? undefined : Number(args.limit)
      const report = await finance.getMacroGlobal(requested, exec.signal, limit)
      return asJson(report)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_global_news_radar',
    description: '全球市场新闻雷达：抓取已核实的官方源（Fed/ECB/BIS/SEC/BoE），按来源权威、事件类型、一手性、时间衰减（可带跨资产反应与关键词相关性）做确定性排序。score 只是“覆盖源范围内的相对重要性”，不是因果、不是涨跌预测，也不声称全市场最重要。返回标题/来源/发布时间/链接/事件类型/分数分项与来源诊断；媒体源默认不启用。',
    parameters: {
      hours: { type: 'number', description: '回看小时数（1-720，默认 168）' },
      limit: { type: 'number', description: '返回条数（1-50，默认 12）' },
      keywords: { type: 'array', items: { type: 'string' }, description: '可选：与持仓/自选/关注主题相关的关键词，用于相关性加分' },
    },
    output: jsonOut,
    async execute(args) {
      const rawHours = Number(args.hours ?? 168)
      const hours = Number.isFinite(rawHours) ? Math.min(720, Math.max(1, Math.trunc(rawHours))) : 168
      const rawLimit = Number(args.limit ?? 12)
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 12
      const keywords = Array.isArray(args.keywords) ? args.keywords.map(String).filter(Boolean).slice(0, 20) : []
      const run = await fetchAndBuildGlobalNewsRadar({
        now: new Date().toISOString(),
        windowHours: hours,
        maxItems: limit,
        ...(keywords.length ? { relevance: { keywords, label: '研究主题' } } : {}),
      })
      return asJson({
        ok: true,
        fetchedAt: run.radar.generatedAt,
        hours,
        items: run.radar.items.map(item => ({
          id: item.id, title: item.title, url: item.link ?? undefined, source: item.sourceName,
          authority: item.authority, eventType: item.eventType, publishedAt: item.publishedAt ?? undefined,
          score: item.score.total, scoreComponents: item.score.components, reasons: item.score.reasons,
          eventReason: item.eventReason,
        })),
        stats: run.radar.stats,
        feedDiagnostics: run.radar.feedDiagnostics,
        disclaimer: run.radar.disclaimer,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_global_quote',
    description: '海外个股/指数/黄金等最新行情（东方财富 secid，如美股 105.NVDA、黄金 101.GC00Y、日股 176.7203）。先用 search_symbol 拿到 secid，再查；价格与涨跌幅已按源口径，缺失为 null，不补 0。只返回行情事实，不含该市场完整档案。',
    parameters: {
      secid: { type: 'string', required: true, description: '东财 secid，如 105.NVDA / 101.GC00Y / 176.7203' },
    },
    output: jsonOut,
    async execute(args) {
      return asJson(await fetchGlobalQuote(String(args.secid ?? '')))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_global_kline',
    description: '海外个股/指数/黄金等日K线（东方财富 secid）。返回 date/open/high/low/close/volume 升序，价格不除权处理（fqt=1 前复权）；缺失或空数据明确 error，不补 0。用于看英伟达、美股指数、黄金等近期走势。',
    parameters: {
      secid: { type: 'string', required: true, description: '东财 secid，如 105.NVDA / 100.SPX / 101.GC00Y' },
      limit: { type: 'number', description: '返回最近多少根日K（1-500，默认 120）' },
    },
    output: jsonOut,
    async execute(args) {
      return asJson(await fetchGlobalKline(String(args.secid ?? ''), args.limit))
    },
  }))

  // 全球跨资产快照：一次拿美股三大指数 + 恒生 + 黄金/白银/铜 + 美元指数的最新价与涨跌幅，
  // 供「美股走势对黄金影响」这类跨市场问题先取得双方事实，再做机制分析（不预测涨跌）。
  const CROSS_ASSET_BASKET = [
    { secid: '100.SPX', label: '标普500' },
    { secid: '100.DJIA', label: '道琼斯' },
    { secid: '100.NDX', label: '纳斯达克' },
    { secid: '100.HSI', label: '恒生指数' },
    { secid: '124.HSTECH', label: '恒生科技' },
    { secid: '101.GC00Y', label: 'COMEX黄金' },
    { secid: '101.SI00Y', label: 'COMEX白银' },
    { secid: '101.HG00Y', label: 'COMEX铜' },
    { secid: '102.CL00Y', label: 'NYMEX原油' },
    { secid: '171.US10Y', label: '美国10年期国债收益率' },
    { secid: '100.UDI', label: '美元指数' },
  ]
  ctx.tools.register(defineTool({
    name: 'get_global_market_snapshot',
    description: '全球跨资产快照：并发取美股三大指数、恒生、COMEX 黄金/白银/铜、美元指数的最新价与涨跌幅（东方财富 secid）。用于先取得「美股 vs 黄金」等多市场事实，再做传导分析。只给行情事实，不含因果；单行失败在该行标 error，缺失为 null 不补 0。',
    parameters: {},
    output: jsonOut,
    async execute() {
      const results = await Promise.all(CROSS_ASSET_BASKET.map(async item => {
        const res = await fetchGlobalQuote(item.secid)
        return { secid: item.secid, label: item.label, ok: res.ok, price: res.quote?.price ?? null, changePct: res.quote?.changePct ?? null, change: res.quote?.change ?? null, asOf: res.quote?.asOf, error: res.ok ? undefined : res.error }
      }))
      return asJson({ ok: true, at: new Date().toISOString(), source: 'eastmoney-push2', rows: results })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_cn_datasets',
    description: '列出中国免费数据集注册表（AKShare 桥）：dataset id、来源、单位、频率、是否可用、不可用原因、必填参数。做中国宏观/财务/基金/债券研究前先查这里，避免调用不存在的接口。',
    parameters: {},
    output: jsonOut,
    async execute() {
      try {
        const datasets = await listCnDatasets()
        const health = await checkCnBridge()
        return asJson({ ok: true, bridge: health, datasets })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err), datasets: [] })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_cn_dataset',
    description: '获取一个中国免费数据集（AKShare）。dataset 用 list_cn_datasets 返回的 id；params 按该数据集必填参数传。返回 rows/unit/as_of(最新统计期)/fetched_at/source/source_url/warnings；缺失为 null 不补 0，不可用数据集明确报错。研究用途，数据不得再分发。',
    parameters: {
      dataset: { type: 'string', required: true, description: '数据集 id，如 CN_MACRO_CPI / CN_A_SHARE_DAILY / CN_FUND_NAV' },
      params: { type: 'string', description: '可选 JSON 字符串，如 {"symbol":"600519","start_date":"2026-11-01","end_date":"2026-11-17"}' },
      limit: { type: 'number', description: '最多返回最近多少行（从最新期截取）' },
    },
    output: jsonOut,
    async execute(args) {
      let params: Record<string, string | number> | undefined
      if (typeof args.params === 'string' && args.params.trim()) {
        try { params = JSON.parse(args.params) as Record<string, string | number> } catch { return asJson({ ok: false, error: 'params 不是合法 JSON' }) }
      } else if (args.params && typeof args.params === 'object') {
        params = args.params as Record<string, string | number>
      }
      const limit = args.limit === undefined ? undefined : Number(args.limit)
      return asJson(await fetchCnDataset(String(args.dataset ?? ''), { params, ...(limit ? { limit } : {}) }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: '免费网页搜索（Python ddgs → Bing/Google/Yandex，无需 API Key）。用于查行情消息、财报、公司资讯。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.webSearch(args.query, exec.signal)
      if (!res.ok || !Array.isArray(res.data)) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, count: res.data.length, results: res.data.slice(0, 8) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'calculate_technical_indicators',
    description: '基于 K 线计算 MA/MACD/RSI/KDJ（本地计算，行情源依赖 kline 能力）。',
    parameters: {
      code: { type: 'string', required: true },
      indicators: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: ['MA5', 'MA10', 'MA20', 'MA60', 'MACD', 'RSI', 'KDJ'] },
      },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getTechnicalIndicators(args.code, args.indicators, exec.signal)
      if (!res.ok) return asJson({ ok: false, code: args.code, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, code: args.code, indicators: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_stock',
    description: '按代码或名称搜索股票（基于东财 clist 首页样本/缓存列表）。',
    parameters: {
      keyword: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.searchStock(args.keyword, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_stock_list',
    description: '获取 A 股列表样本（东财 clist 首页，非全市场）。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getStockList(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      const stocks = (res.data as object[]) ?? []
      return asJson({ ok: true, count: stocks.length, stocks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_market_overview',
    description: '获取沪深重要指数概览。端点对照 AkShare __stock_zh_main_spot_em。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      const res = await finance.getMarketOverview(exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, indices: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_financial_indicators',
    description: '获取财务主要指标。端点对照 AkShare stock_financial_analysis_indicator_em。',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: jsonOut,
    async execute(args, exec) {
      const res = await finance.getFinancials(args.code, exec.signal)
      if (!res.ok) return asJson({ ok: false, error: res.error ?? 'unavailable' })
      return asJson({ ok: true, provider: res.provider, rows: res.data })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_global_financials',
    description: '港股/美股财务数据（结构化来源，不是网页摘要）：港股=东财 HKF10 主要财务指标（累计口径、非单季，币种随报告）；美股=SEC EDGAR XBRL companyfacts（10-K 年度 / 10-Q 单季，USD）。返回 source/currency/rows；SEC 要求 User-Agent（DSH_SEC_EDGAR_UA 含联系邮箱），缺失会显式失败，不伪造、不补 0。market 省略时按代码形态推断（数字=港股，字母=美股）。',
    parameters: {
      code: { type: 'string', required: true, description: '港股如 00700，美股如 AAPL' },
      market: { type: 'string', enum: ['hk', 'us'], description: '可选；省略时按代码推断' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const code = String(args.code ?? '').trim()
      if (!code) return asJson({ ok: false, error: 'code is required' })
      const routed = routeCode(code, 'stock')
      const explicit = args.market === 'hk' || args.market === 'us' ? args.market : undefined
      const inferred = routed.market === '港股' ? 'hk' : routed.market === '美股' ? 'us' : undefined
      const market = explicit ?? inferred
      if (!market) {
        return asJson({ ok: false, code, error: '无法从代码推断市场，请显式传 market=hk|us（该工具只覆盖港股/美股）' })
      }
      const res = await finance.getGlobalFinancials(code, market, exec.signal)
      if (!res.ok || !res.data) {
        return asJson({ ok: false, market, code, error: res.error ?? 'unavailable', attempts: res.attempts })
      }
      const data = res.data
      return asJson({
        ok: true,
        market: data.market,
        code: data.code,
        name: data.name,
        currency: data.currency,
        source: data.source,
        fetchedAt: data.fetchedAt,
        count: data.rows.length,
        rows: data.rows,
        ...(data.profile ? { profile: data.profile } : {}),
        ...(data.warnings?.length ? { warnings: data.warnings } : {}),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_portfolio',
    description: '读取本地持仓；若 quote 可用则补全现价与盈亏。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      return asJson(await finance.analyzePortfolio(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'upsert_holding',
    description: '预览新增或更新本地持仓，用户在个人首页确认后写入。基金用 type:"fund"，股票用 type:"stock"。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      quantity: { type: 'number', required: true },
      avgCost: { type: 'number', required: true },
      type: { type: 'string', enum: ['stock', 'fund'], description: '资产类型，默认 stock' },
    },
    output: jsonOut,
    async execute(args) {
      await store.load()
      const preview = store.previewHolding({
        code: args.code,
        name: args.name,
        quantity: args.quantity,
        avgCost: args.avgCost,
        type: (args.type as AssetType) ?? 'stock',
      })
      return asJson({ ok: true, ...preview })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'import_holdings',
    description: '预览批量导入持仓，必须让用户在个人首页确认才会整表替换。基金 type:"fund"，股票 type:"stock"。',
    parameters: {
      holdings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            quantity: { type: 'number' },
            avgCost: { type: 'number' },
            type: { type: 'string', enum: ['stock', 'fund'] },
          },
        },
      },
    },
    output: jsonOut,
    async execute(args) {
      const input = (args.holdings as Array<Record<string, unknown>>) ?? []
      const rows = input.map((row) => ({
        code: String(row.code ?? '').trim(),
        name: row.name ? String(row.name) : undefined,
        quantity: Number(row.quantity),
        avgCost: Number(row.avgCost),
        type: (row.type === 'fund' ? 'fund' : 'stock') as AssetType,
      }))
      await store.load()
      return asJson({ ok: true, ...store.previewHoldings(rows) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_holding',
    description: '预览删除本地持仓，用户在个人首页确认差异后才会写入；未确认前持仓文件不变。',
    parameters: {
      code: { type: 'string', required: true },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      await store.load()
      return asJson({ ok: true, ...store.previewRemoveHolding(args.code, args.type as AssetType | undefined) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'add_watchlist',
    description: '添加自选（写入持仓文件）。基金 type:"fund"，股票 type:"stock"。',
    parameters: {
      code: { type: 'string', required: true },
      name: { type: 'string' },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      const file = await store.addWatch({ code: args.code, name: args.name, type: (args.type as AssetType) ?? 'stock' })
      return asJson({ ok: true, watchlist: file.watchlist })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_watchlist',
    description: '移除自选。',
    parameters: {
      code: { type: 'string', required: true },
      type: { type: 'string', enum: ['stock', 'fund'] },
    },
    output: jsonOut,
    async execute(args) {
      const file = await store.removeWatch(args.code, args.type as AssetType | undefined)
      return asJson({ ok: true, watchlist: file.watchlist })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_portfolio_file',
    description: '返回本地持仓/自选文件路径与内容（用于定位并编辑该 JSON 文件）。',
    parameters: {},
    output: jsonOut,
    async execute() {
      return asJson({ ok: true, path: store.path, ...store.get() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'analyze_portfolio',
    description: '分析本地持仓表现（总市值、盈亏等）；现价依赖 quote 能力。',
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      return asJson(await finance.analyzePortfolio(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'save_position_analysis',
    description: '保存主动解读请求生成的股票/基金分析报告。只有在完成数据收集并写出完整中文报告后调用；报告会缓存到本地。若提示词给出档案快照/原判断版本/上次报告 id 必须原样回引（只校验存在性，不证明语义真实）。',
    parameters: {
      code: { type: 'string', required: true, description: '股票或基金代码' },
      type: { type: 'string', required: true, enum: ['stock', 'fund'], description: '资产类型' },
      report: { type: 'string', required: true, description: '完整中文 Markdown 解读报告' },
      dataAsOf: { type: 'string', description: '报告使用的最新数据时间' },
      dossierSnapshotId: { type: 'string', description: '报告引用的档案快照 id（来自分析提示词）' },
      thesisRevision: { type: 'number', description: '对照的原判断版本号（来自分析提示词）' },
      previousReportId: { type: 'string', description: '对照的上次报告 id（来自分析提示词）' },
    },
    output: jsonOut,
    async execute(args) {
      const code = String(args.code ?? '').trim()
      const report = String(args.report ?? '').trim()
      if (!code || !report) return asJson({ ok: false, error: 'code and report are required' })
      const type = (args.type === 'fund' ? 'fund' : 'stock') as AssetType
      // 契约校验：只证明引用存在（快照已登记 / 版本是当前或上一版 / 报告在历史里），不证明语义真实。
      // 校验不通过则拒绝保存，报告内容不落盘。
      const refs: AnalysisRefs = {}
      const problems: string[] = []
      if (args.dossierSnapshotId !== undefined) {
        const id = String(args.dossierSnapshotId)
        if (!analyses.hasSnapshot(id, code, type)) {
          problems.push(`档案快照 ${id} 不存在或未登记（应来自 stock_dossier / 分析提示词）`)
        } else {
          refs.dossierSnapshotId = id
        }
      }
      if (args.thesisRevision !== undefined) {
        const rev = Number(args.thesisRevision)
        if (!Number.isInteger(rev) || rev < 1) {
          problems.push(`thesisRevision=${String(args.thesisRevision)} 不是正整数`)
        } else if (personal) {
          const thesis = personal.get().theses.find((t) => t.code === code && (t.type ?? 'stock') === type)
          if (!thesis) {
            problems.push('无该标的原判断，thesisRevision 不应提供')
          } else if (rev !== thesis.revision && rev !== thesis.revision - 1) {
            problems.push(`thesisRevision=${rev} 既不是当前版本（v${thesis.revision}）也不是上一版本（v${Math.max(1, thesis.revision - 1)}）`)
          } else {
            refs.thesisRevision = rev
          }
        } else {
          refs.thesisRevision = rev
        }
      }
      if (args.previousReportId !== undefined) {
        const id = String(args.previousReportId)
        if (!analyses.hasReportId(id)) {
          problems.push(`previousReportId=${id} 不在研究历史中`)
        } else {
          refs.previousReportId = id
        }
      }
      if (problems.length > 0) {
        return asJson({ ok: false, error: `引用契约校验未通过，报告未保存：${problems.join('；')}`, problems })
      }
      const analysis = await analyses.set({
        code,
        type,
        report,
        dataAsOf: args.dataAsOf ? String(args.dataAsOf) : undefined,
        refs,
      })
      return asJson({
        ok: true,
        code: analysis.code,
        type: analysis.type,
        generatedAt: analysis.generatedAt,
        version: analysis.version,
        reportId: analysis.reportId,
        refs: analysis.refs,
        note: '引用有效≠语义真实，结论需用户审阅。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'portfolio_strategy_review',
    description: '多持仓组合策略检查：用户显式提供当前/目标权重、现金、单资产/类别/换手约束和市场国际事件证据；计算暴露/漂移/复核触发，生成受约束的权重预览。不自动改目标、不读取真实持仓、不交易。',
    parameters: { input: { type: 'string', required: true, description: 'JSON组合政策输入：asOf/baseCurrency/positions/cashWeight/targetCashWeight/constraints/review/signals；权重0-1且含现金合计1' } },
    output: jsonOut,
    async execute(args) { try { return asJson(evaluatePortfolioPolicy(JSON.parse(String(args.input)) as PortfolioPolicyInput)) } catch(error) { return asJson({ok:false,error:error instanceof Error?error.message:String(error)}) } },
  }))

  ctx.tools.register(defineTool({
    name: 'portfolio_backtest_run',
    description: '多资产纸面再平衡回测（离线确定性）：输入含来源的raw价格、权重、整手、费用/税表、分红/拆股公司行动与逐期汇率；输出逐日权益、模拟流水、收益/回撤/费用税费。缺税表或公司行动覆盖声明时只输出部分口径，不能称完整总回报。不写账本、不下单。',
    parameters: { input: { type: 'string', required: true, description: 'JSON：baseCurrency/initialCash/cashTargetWeight/assets/fx/rebalance/start/end；每资产需adjustment=raw、tax、prices、actions' } },
    output: jsonOut,
    async execute(args) {
      try { return asJson(runPortfolioBacktest(JSON.parse(String(args.input)))) }
      catch (error) { return asJson({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'portfolio_data_verify',
    description: '组合数据核验（确定性）：用显式数量、价格与日期、FX、历史序列、基金披露权重，计算估值覆盖、含现金权重、币种与类别暴露、基金穿透已知/未知部分、同币种日收益协方差与相关系数。缺价格/汇率/披露时保留未知，不按0、不把已知部分归一化成全组合。不读真实资产、不联网。',
    parameters: { input: { type: 'string', required: true, description: 'JSON：asOf/baseCurrency/positions/cash/fx/histories/fundHoldings；价格与汇率需带来源和日期' } },
    output: jsonOut,
    async execute(args) {
      try { return asJson(verifyPortfolioData(JSON.parse(String(args.input)) as PortfolioVerificationInput)) }
      catch (error) { return asJson({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'strategy_experiment',
    description: '策略实验室：读取普通A股主板未复权日线，校验数据后比较固定模板与留出段、双倍成本。仅价格纸面实验，不改账本/策略库、不交易；数据不足明确拒绝。',
    parameters: { code: { type: 'string', required: true, description: '普通主板六位A股代码，首版不支持ST、基金或海外' }, initialCash: { type: 'number', description: '模拟本金CNY，默认100000，不是真实资金' } },
    output: jsonOut,
    async execute(args) { return asJson(await fetchStrategyExperiment(String(args.code ?? ''), args.initialCash === undefined ? 100000 : Number(args.initialCash))) },
  }))

  ctx.tools.register(defineTool({
    name: 'strategy_environment_review',
    description: '按市场/国际形势证据复核策略适用条件：每条含topic/claim/source/asOf/direction(risk/support/neutral)。只输出复核与缺口，不自动改规则、不把当前新闻回填历史回测。',
    parameters: { signals: { type: 'string', required: true, description: 'JSON证据数组，每条topic/claim/source/asOf/direction，须真实来源与日期' }, asOf: { type: 'string', required: true, description: '复核日期YYYY-MM-DD' } },
    output: jsonOut,
    async execute(args) {
      try { const signals = JSON.parse(String(args.signals)); if (!Array.isArray(signals) || signals.length > 30) return asJson({ ok: false, error: '证据必须是最多30条的数组' }); return asJson(reviewStrategyEnvironment(signals, String(args.asOf))) }
      catch (error) { return asJson({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_strategy',
    description: '提交一个受限策略 DSL 草案到策略库（status=proposed）。DSL 只允许价格序列信号与显式交易规则；提交只校验与保存，绝不执行/不回测/不下单。升级为生效跟踪策略需要用户在面板显式批准。',
    parameters: {
      spec: { type: 'object', additionalProperties: true, description: '策略 DSL 对象（dslVersion/name/codes/signal/allocation/trading）' },
      reason: { type: 'string', description: '提出该草案的理由' },
    },
    output: jsonOut,
    async execute(args) {
      if (!library) return asJson({ ok: false, error: '策略库未挂载' })
      try {
        const entry = await library.propose(args.spec, String(args.reason ?? ''))
        return asJson({
          ok: true,
          entry: { id: entry.id, name: entry.spec.name, specHash: entry.specHash, status: entry.status, version: entry.version },
          note: '已保存为 proposed 草案；未执行任何回测或交易。生效跟踪需用户批准。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_strategy_library',
    description: '读取策略库（proposed/tested/watchlisted/retired 与理由、前向记录）。只读，不改状态；激活/退役等变更需用户确认。',
    parameters: {
      status: { type: 'string', enum: ['proposed', 'tested', 'watchlisted', 'retired'], description: '按状态过滤（可选）' },
    },
    output: jsonOut,
    async execute(args) {
      if (!library) return asJson({ ok: false, error: '策略库未挂载' })
      const status = args.status as 'proposed' | 'tested' | 'watchlisted' | 'retired' | undefined
      return asJson({
        ok: true,
        entries: library.list(status).map((e) => ({
          id: e.id,
          name: e.spec.name,
          specHash: e.specHash,
          status: e.status,
          version: e.version,
          reason: e.reason,
          forwardRecords: e.forwardRecords.length,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'panel_navigate',
    description: '把金融面板切换到指定标签页，并可聚焦某只股票/基金（K线页直接打开、可选同时打开 AI 解读）。note 在面板顶部显示一句话解释（告诉用户你为什么让他看这里），anchor 在页内滚动到指定区块。用于对话中引导用户看面板。',
    parameters: {
      tab: {
        type: 'string',
        required: true,
        enum: [...PANEL_TABS],
        description: '目标标签页：home 首页 / quotes 行情（含K线工作区与领涨/领跌板块） / holdings 持仓 / funds 基金 / kline K线（兼容别名，等价 quotes 并聚焦K线） / market 市场（兼容别名，等价 quotes） / macro 宏观 / news 快讯 / research 资料 / policy 政策（政策原文与传导） / dossier 深度 / discover 发现 / follow 追踪 / sources 数据源 / skills 技能 / health 接口',
      },
      code: { type: 'string', description: '可选，聚焦的代码（如 600519 / 00700 / AAPL / 110022）' },
      type: { type: 'string', enum: ['stock', 'fund'], description: '资产类型，默认 stock' },
      kind: { type: 'string', enum: ['a', 'hk', 'us', 'fund'], description: 'K线工作区市场类型（tab=quotes/kline 生效），默认按 type/code 推断' },
      open_analysis: { type: 'boolean', description: '同时打开该代码的 AI 解读视图，默认 false' },
      note: { type: 'string', description: '显示在面板顶部的一句话（≤120字），解释这次导航的意图，如「你的 510300 折溢价在这里」' },
      anchor: { type: 'string', description: '页内锚点：home → overview|growth|journal|reviews|approvals；holdings → lookthrough（穿透体检）；follow → targets|jobs|briefs|shadow' },
    },
    output: jsonOut,
    async execute(args) {
      const tab = String(args.tab ?? '')
      if (!(PANEL_TABS as readonly string[]).includes(tab)) {
        return asJson({ ok: false, error: `unknown tab ${tab}; valid: ${PANEL_TABS.join('/')}` })
      }
      const code = args.code ? String(args.code).trim() : undefined
      const type: AssetType = args.type === 'fund' ? 'fund' : 'stock'
      const kind = args.kind === 'hk' || args.kind === 'us' || args.kind === 'fund' || args.kind === 'a'
        ? (args.kind as 'a' | 'hk' | 'us' | 'fund')
        : (type === 'fund' ? 'fund' : 'a')
      const note = args.note ? String(args.note).trim().slice(0, 120) : undefined
      const anchor = args.anchor ? String(args.anchor).trim().slice(0, 64) : undefined
      bus.publish({
        kind: 'panel',
        command: { action: 'navigate', tab, code, type, kind, openAnalysis: args.open_analysis === true && !!code, note, anchor },
      })
      return asJson({ ok: true, tab, code, kind, openAnalysis: args.open_analysis === true && !!code, note, anchor })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'panel_state',
    description: '读取用户当前在金融面板看什么（标签页 + 聚焦代码，best-effort、随面板切换实时上报）。回答「我该看哪 / 你刚才说的那个」或准备 panel_navigate 前先读它，避免把用户已看到的内容再讲一遍。',
    parameters: {},
    output: jsonOut,
    async execute() {
      const focus = getPanelFocus()
      if (!focus) return asJson({ ok: true, focus: null, note: '面板尚未上报过焦点（用户可能刚打开面板）；直接 panel_navigate 即可。' })
      const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(focus.at)) / 1000))
      return asJson({ ok: true, focus, ageSeconds: ageSec, note: '焦点是瞬时上下文：若与当前话题不符，以对话为准。' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'simulate_rebalance',
    description: 'What-if 再平衡模拟：基于本地持仓推演交易列表或目标权重执行后的组合变化（权重/HHI/集中度/分币种敞口）。纯模拟，不修改持仓、不下单。两种模式二选一：trades（买卖列表）或 targets（目标权重%）。',
    parameters: {
      trades: {
        type: 'array',
        description: '交易列表（与 targets 二选一）：按最新价成交，先卖后买',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['stock', 'fund'] },
            side: { type: 'string', enum: ['buy', 'sell'] },
            quantity: { type: 'number' },
            price: { type: 'number', description: '可选，成交价覆盖；缺省用最新价（持仓外标的必填）' },
          },
        },
      },
      targets: {
        type: 'array',
        description: '目标权重（与 trades 二选一）：占「持仓市值+可用现金」的百分比',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['stock', 'fund'] },
            weight: { type: 'number', description: '目标权重（%）' },
          },
        },
      },
      cash: { type: 'number', description: '可用现金（持仓之外），默认 0；目标权重模式下参与基数与买入' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const pf = await finance.analyzePortfolio(exec.signal)
      const trades = Array.isArray(args.trades)
        ? (args.trades as Array<Record<string, unknown>>).map((t) => ({
          code: String(t.code ?? '').trim(),
          name: t.name ? String(t.name) : undefined,
          type: (t.type === 'fund' ? 'fund' : 'stock') as AssetType,
          side: (t.side === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
          quantity: Number(t.quantity) || 0,
          price: typeof t.price === 'number' ? t.price : undefined,
        })).filter((t) => t.code && t.quantity > 0)
        : undefined
      const targets = Array.isArray(args.targets)
        ? (args.targets as Array<Record<string, unknown>>).map((t) => ({
          code: String(t.code ?? '').trim(),
          name: t.name ? String(t.name) : undefined,
          type: (t.type === 'fund' ? 'fund' : 'stock') as AssetType,
          weight: Number(t.weight) || 0,
        })).filter((t) => t.code)
        : undefined
      return asJson(simulateRebalance({
        holdings: pf.holdings,
        trades,
        targets,
        cash: typeof args.cash === 'number' ? args.cash : 0,
      }))
    },
  }))
}
