/** Pure, offline strategy experiments. No ledger, execution, network or clock access. */
import type { KlineBar } from '../types.js'
import { runBacktest, ENGINE_VERSION, type BacktestResult, type EquityPoint } from './backtest.js'
import { contentHash, type DatasetSlice, type SignalRule, type StrategySpec, type TradingRules } from './dsl.js'

export interface StrategyExperimentInput {
  code: string
  currency: string
  adjustment: string
  bars: KlineBar[]
  initialCash?: number
  source: string
  fetchedAt: string
  from?: string
  to?: string
}

const LAB_VERSION = '1.0.0'
const RULES: Readonly<TradingRules> = Object.freeze({
  lotSize: 100, feeRateBps: 3, minFee: 5, stampDutyBps: 5,
  slippageBps: 5, limitPct: 10, tPlus1: true,
})
const TEMPLATES: ReadonlyArray<{ id: string; name: string; signal: SignalRule }> = [
  { id: 'hold-proxy-v1', name: '买入持有近似基准', signal: { kind: 'momentum', lookback: 1, thresholdPct: -100 } },
  { id: 'ma-20-60-v1', name: '均线20/60冻结规则', signal: { kind: 'ma_cross', fast: 20, slow: 60 } },
  { id: 'momentum-20-v1', name: '动量20日冻结规则', signal: { kind: 'momentum', lookback: 20, thresholdPct: 0 } },
]

function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && realDate(value.slice(0, 10)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
}

/** Deterministic, bounded chart samples; always retain both endpoints. Metrics use all bars. */
function chart(points: EquityPoint[]): EquityPoint[] {
  if (points.length <= 200) return points
  return Array.from({ length: 200 }, (_, i) => points[Math.floor(i * (points.length - 1) / 199)]!)
}

function summarize(result: BacktestResult) {
  return {
    metrics: result.metrics, equity: chart(result.equity),
    hashes: { strategy: result.strategyHash, data: result.dataHash, config: result.configHash },
    simplified: result.simplified, notices: result.notices,
    // Trades are audit evidence for next-open execution, not instructions or orders.
    trades: result.trades,
  }
}

function refused(reason: string, gaps: string[]) {
  return { ok: false as const, reason, gaps, recommendation: 'REVIEW_ONLY' as const, autoChange: false as const, writesLedger: false as const, executesTrades: false as const }
}

export function runStrategyExperiment(input: StrategyExperimentInput) {
  if (!input || typeof input !== 'object') return refused('invalid_input', ['必须提供实验输入对象。'])
  if (typeof input.code !== 'string' || !/^(600|601|603|605|000|001|002)\d{3}$/.test(input.code) || input.currency !== 'CNY') {
    return refused('unsupported', ['仅支持单标的CNY普通非ST主板，代码前缀600/601/603/605/000/001/002；不支持ST、创业板、科创板、ETF、港美股及混合币种。'])
  }
  if (input.adjustment !== 'none' && input.adjustment !== 'raw') {
    return refused('adjustment_unsupported', ['仅接受明确none/raw未复权行情；qfq/hfq/forward/reconstructed/unknown等拒绝，不用调整价模拟整手成交。'])
  }
  if (typeof input.source !== 'string' || !input.source.trim() || !timestamp(input.fetchedAt)) {
    return refused('invalid_provenance', ['source必须非空；fetchedAt必须是真实日期的ISO时间戳并带时区。'])
  }
  if ((input.from !== undefined && !realDate(input.from)) || (input.to !== undefined && !realDate(input.to)) ||
      (input.from !== undefined && input.to !== undefined && input.from > input.to)) {
    return refused('invalid_range', ['from/to必须是真实YYYY-MM-DD日期且from≤to。'])
  }
  const cash = input.initialCash ?? 100_000
  if (!Number.isFinite(cash) || cash <= 0) return refused('invalid_cash', ['initialCash必须为正有限数。'])
  if (!Array.isArray(input.bars)) return refused('invalid_bars', ['bars必须为数组。'])
  let previous = ''
  const dates = new Set<string>()
  for (const bar of input.bars) {
    if (!bar || !realDate(bar.date)) return refused('invalid_date', ['K线必须使用真实YYYY-MM-DD日期（不接受不存在的日历日期）。'])
    if (dates.has(bar.date)) return refused('duplicate_date', [`日期重复：${bar.date}；不去重。`])
    if (previous && bar.date < previous) return refused('invalid_order', ['日期必须严格升序；不会默默排序。'])
    dates.add(bar.date)
    previous = bar.date
    if (![bar.open, bar.high, bar.low, bar.close].every((n) => Number.isFinite(n) && n > 0) ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) {
      return refused('invalid_ohlc', [`${bar.date} OHLC必须为正有限数且满足高低价关系。`])
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0 || bar.volumeMissing === true ||
        (bar.volumeMissing !== undefined && typeof bar.volumeMissing !== 'boolean')) {
      return refused('invalid_volume', [`${bar.date} volume必须为已知非负有限数；缺量不伪装为真实零量。`])
    }
  }
  const bars = input.bars.filter((b) => (!input.from || b.date >= input.from) && (!input.to || b.date <= input.to))
    .map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, volumeMissing: false }))
  if (bars.length < 180) return refused('insufficient_bars', [`区间内至少需要180根有效K线，实际${bars.length}根。`])
  const split = Math.floor(bars.length * 0.7)
  const trainEnd = bars[split - 1]!.date
  const testStart = bars[split]!.date
  const lastDate = bars[bars.length - 1]!.date
  const ds: DatasetSlice = { code: input.code, currency: 'CNY', adjustment: 'raw', bars }
  const doubled: TradingRules = { ...RULES, feeRateBps: 6, minFee: 10, stampDutyBps: 10, slippageBps: 10 }
  const config = { initialCash: cash }
  const holdoutConfig = { initialCash: cash, startDate: testStart, endDate: lastDate }
  try {
    const templates = TEMPLATES.map((template) => {
      const spec: StrategySpec = { dslVersion: 1, name: template.name, codes: [input.code], signal: { ...template.signal }, allocation: 'equal_weight', trading: { ...RULES } }
      const expensiveSpec: StrategySpec = { ...spec, trading: { ...doubled } }
      const full = runBacktest(spec, [ds], config)
      const train = runBacktest(spec, [ds], { initialCash: cash, endDate: trainEnd })
      const holdout = runBacktest(spec, [ds], holdoutConfig)
      const fullCost = runBacktest(expensiveSpec, [ds], config)
      const testCost = runBacktest(expensiveSpec, [ds], holdoutConfig)
      return {
        id: template.id, name: template.name, spec,
        result: summarize(full), train: summarize(train), holdout: summarize(holdout),
        costSensitivity: { multiplier: 2, trading: { ...doubled }, metrics: fullCost.metrics, holdoutMetrics: testCost.metrics,
          hashes: { full: fullCost.configHash, holdout: testCost.configHash } },
      }
    })
    // Even finite prices can overflow portfolio arithmetic; never return JSON-corrupt NaN/Infinity.
    if (JSON.stringify(templates, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non_finite_result')
      return value
    }) === undefined) return refused('non_finite_result', ['结果无法JSON序列化。'])
    return {
      ok: true as const, labVersion: LAB_VERSION, engineVersion: ENGINE_VERSION,
      code: input.code, currency: input.currency, adjustment: 'raw' as const, inputAdjustment: input.adjustment,
      source: input.source, fetchedAt: input.fetchedAt,
      coverage: { from: bars[0]!.date, to: lastDate, bars: bars.length, suppliedBars: input.bars.length, requestedFrom: input.from ?? null, requestedTo: input.to ?? null },
      configuration: { initialCash: cash, allocation: 'equal_weight' as const, trading: { ...RULES }, costLabel: 'A股普通主板示例费用，非经核实的个人券商费率。' },
      boundary: { trainBars: split, testBars: bars.length - split, trainEnd, testStart, testEnd: lastDate, holdoutFraction: 0.3,
        explanation: '前70%仅供描述，后30%按相同冻结规则独立现金重置holdout；不优化、不择优、不继承训练持仓。训练历史仅用于因果指标预热；测试首日收盘形成信号，最早下一交易日开盘执行。' },
      hashes: { experiment: contentHash({ labVersion: LAB_VERSION, engineVersion: ENGINE_VERSION, ds, config, holdoutConfig, templates: templates.map((t) => t.spec) }),
        data: templates[0]!.result.hashes.data, provenance: contentHash({ source: input.source, fetchedAt: input.fetchedAt, inputAdjustment: input.adjustment }) },
      templates,
      gaps: ['代码白名单不能独立证明历史非ST/退市风险状态，输入须为普通非ST主板；未提供逐日ST、上市初期无涨跌停及公司行动元数据。',
        '未建模分红送转、拆股及再投资；未复权价格在除权日可能产生非经济跳变，不代表总回报。',
        '未核验交易所日历/数据源真实性；只校验真实日历日期、字段与因果顺序，零成交量视为不可成交。'],
      notices: ['仅离线研究模拟，不写账本、不交易、永不自动变更策略。',
        '基准momentum(1,-100)在正价格下接近always-long，仅买入持有近似；有预热和次日开盘延迟、费用、停牌/涨跌停跳过与整手现金残留。',
        '固定冻结规则，无参数搜索、无统计显著性声明、不证明策略有效；短holdout与单标的结果不可外推。',
        't收盘信号→t+1开盘，整手100股、T+1与10%涨跌停为保守日频近似，不保证真实盘口成交；期末按收盘估值不强制清仓。',
        '双倍成本只将佣金/最低佣金/卖出税/滑点加倍，不改变信号、整手、T+1或涨跌停；不保证结果单调。'],
      recommendation: 'REVIEW_ONLY' as const, autoChange: false as const, writesLedger: false as const, executesTrades: false as const,
    }
  } catch (error) {
    return refused('backtest_refused', [error instanceof Error ? error.message : '引擎拒绝运行。'])
  }
}

/** Discriminated JSON-friendly public result types for service/UI consumers. */
export type StrategyExperimentResult = ReturnType<typeof runStrategyExperiment>
export type StrategyExperimentSuccess = Extract<StrategyExperimentResult, { ok: true }>
export type StrategyExperimentFailure = Extract<StrategyExperimentResult, { ok: false }>

export interface EnvironmentSignal {
  topic: string
  claim: string
  source: string
  asOf: string
  direction: 'risk' | 'support' | 'neutral'
}

/** Caller-supplied evidence is observations, never a price signal or a rule mutation. */
export function reviewStrategyEnvironment(signals: EnvironmentSignal[], asOf: string) {
  const gaps: string[] = []
  const observations: (EnvironmentSignal & { ageDays: number })[] = []
  const day = realDate(asOf) ? Date.parse(`${asOf}T00:00:00Z`) : timestamp(asOf) ? Date.parse(asOf) : NaN
  if (!Number.isFinite(day)) gaps.push('复核asOf必须为真实日期或带时区ISO时间戳。')
  if (!Array.isArray(signals)) gaps.push('signals必须为数组。')
  else signals.forEach((signal, index) => {
    if (!signal || !['topic', 'claim', 'source'].every((k) => typeof signal[k as keyof EnvironmentSignal] === 'string' && String(signal[k as keyof EnvironmentSignal]).trim()) ||
        !['risk', 'support', 'neutral'].includes(signal.direction)) {
      gaps.push(`signals[${index}]缺少有效主题/断言/来源/方向，拒绝。`)
      return
    }
    const time = realDate(signal.asOf) ? Date.parse(`${signal.asOf}T00:00:00Z`) : timestamp(signal.asOf) ? Date.parse(signal.asOf) : NaN
    const ageDays = (day - time) / 86_400_000
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 30) {
      gaps.push(`signals[${index}]日期非法、未来或过期超过30天，拒绝。`)
      return
    }
    observations.push({ topic: signal.topic, claim: signal.claim, source: signal.source, asOf: signal.asOf, direction: signal.direction, ageDays })
  })
  if (!observations.some((s) => s.direction === 'support')) gaps.push('缺少30天内有效支持证据。')
  if (!observations.some((s) => s.direction === 'risk')) gaps.push('缺少30天内有效风险证据。')
  return { ok: gaps.length === 0, asOf, observations, gaps, recommendation: 'REVIEW_ONLY' as const,
    autoChange: false as const, writesLedger: false as const, executesTrades: false as const,
    notice: '仅供人工环境复核；来源与断言未自动核验，不转换为回测信号、不选择策略、不自动改规则。' }
}
