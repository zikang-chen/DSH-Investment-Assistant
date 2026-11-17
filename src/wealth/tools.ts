/**
 * Wealth simulator tools.
 *
 * The model passes numbers in and gets deterministic results back; it never does
 * the compounding itself. Inputs are in 元 for readability and converted to cents
 * once, inside the tool.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Logger } from '../log.js'
import {
  CONTRIBUTION_FREQUENCIES,
  CONTRIBUTION_TIMING,
  compound,
  futureValueOfFlows,
  solveGoal,
  toCentsSafe,
  yuan,
  type CashFlowPoint,
  type ContributionFrequency,
  type ContributionTiming,
} from './compound.js'
import type { WealthPlanStore } from './plans.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

function normFrequency(value: unknown): ContributionFrequency {
  const v = String(value ?? '').toLowerCase()
  return (CONTRIBUTION_FREQUENCIES as readonly string[]).includes(v) ? (v as ContributionFrequency) : 'monthly'
}

function normTiming(value: unknown): ContributionTiming {
  const v = String(value ?? '').toLowerCase()
  return (CONTRIBUTION_TIMING as readonly string[]).includes(v) ? (v as ContributionTiming) : 'end'
}

function pct(value: unknown, fallback = 0): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  // 允许 10 表示 10%，也允许 0.1
  return Math.abs(n) > 1 ? n / 100 : n
}

export interface WealthToolDeps {
  plans?: WealthPlanStore
  logger?: Logger
}

export function registerWealthTools(ctx: Context, deps: WealthToolDeps): void {
  const ensure = async (): Promise<void> => {
    if (deps.plans && !deps.plans.isLoaded()) await deps.plans.load()
  }

  ctx.tools.register(defineTool({
    name: 'compound_calculate',
    description: '确定性复利计算：一次性本金 + 定期定投（月/季/年，期初或期末）+ 年费 + 通胀 + 逐年明细。收益率用年有效利率换算（(1+r)^(1/12)-1），不用 r/12；零利率走极限式。',
    parameters: {
      principal: { type: 'number', description: '一次性本金（元）' },
      contribution: { type: 'number', description: '每期追加（元），默认 0' },
      frequency: { type: 'string', enum: [...CONTRIBUTION_FREQUENCIES], description: '默认 monthly' },
      timing: { type: 'string', enum: [...CONTRIBUTION_TIMING], description: '期初 begin / 期末 end，默认 end' },
      annualRate: { type: 'number', description: '年有效收益率，如 0.08 或 8' },
      annualFee: { type: 'number', description: '年化费率，如 0.01' },
      inflation: { type: 'number', description: '年通胀率，如 0.03' },
      years: { type: 'number', description: '投资年限' },
      contributionGrowth: { type: 'number', description: '每年追加金额增幅，如 0.03' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const result = compound({
          principalCents: toCentsSafe(args.principal),
          contributionCents: toCentsSafe(args.contribution),
          frequency: normFrequency(args.frequency),
          timing: normTiming(args.timing),
          annualRate: pct(args.annualRate),
          annualFee: pct(args.annualFee),
          inflation: pct(args.inflation),
          years: Number(args.years ?? 0),
          contributionGrowth: pct(args.contributionGrowth),
        })
        return asJson({
          ok: true,
          finalYuan: yuan(result.finalCents),
          finalRealYuan: yuan(result.finalRealCents),
          contributedYuan: yuan(result.contributedCents),
          growthYuan: yuan(result.growthCents),
          netAnnualRate: result.netAnnualRate,
          realRate: result.realRate,
          periodRate: result.periodRate,
          assumptions: result.assumptions,
          rows: result.rows.map((r) => ({
            year: r.year,
            contributedYuan: yuan(r.contributedCents),
            growthYuan: yuan(r.growthCents),
            endYuan: yuan(r.endCents),
            realYuan: yuan(r.realCents),
            cumulativeContributedYuan: yuan(r.cumulativeContributedCents),
          })),
          caveat: '这是确定性情景，不是收益预测；实际收益波动，历史与未来不同。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wealth_goal_solve',
    description: '目标反解：给定目标金额，求「每期需投多少」「需要多少年」或「需要多少年化收益率」。不可达时返回 undefined 并说明，不给近似猜测。',
    parameters: {
      target: { type: 'number', required: true, description: '目标金额（元）' },
      principal: { type: 'number', description: '现有本金（元），默认 0' },
      monthlyContribution: { type: 'number', description: '每月投入（元），默认 0' },
      annualRate: { type: 'number', description: '年有效收益率，默认 0' },
      years: { type: 'number', description: '期限（年），默认 10' },
      annualFee: { type: 'number' },
      inflation: { type: 'number' },
      mode: { type: 'string', enum: ['contribution', 'years', 'rate', 'all'], description: '默认 all' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const solution = solveGoal({
          targetCents: toCentsSafe(args.target),
          principalCents: toCentsSafe(args.principal),
          monthlyContributionCents: toCentsSafe(args.monthlyContribution),
          annualRate: pct(args.annualRate),
          annualFee: pct(args.annualFee),
          inflation: pct(args.inflation),
          years: Number(args.years ?? 10),
          mode: (args.mode ? String(args.mode) : 'all') as never,
        })
        return asJson({
          ok: true,
          requiredMonthlyYuan: yuan(solution.requiredContributionCents),
          ...(solution.requiredYears === undefined ? { requiredYears: null } : { requiredYears: solution.requiredYears }),
          ...(solution.requiredAnnualRate === undefined ? { requiredAnnualRate: null } : { requiredAnnualRate: solution.requiredAnnualRate }),
          achievedYuan: yuan(solution.achievedCents),
          gapYuan: yuan(solution.gapCents),
          note: solution.note,
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wealth_cashflow_calculate',
    description: '不规则现金流的终值：给定若干日期与金额（负数=取出），按年有效收益率复利到指定估值日（按实际天数/365）。用于年终奖、非固定追加、中途取款等场景。',
    parameters: {
      flows: { type: 'string', required: true, description: 'JSON 数组：[{"date":"2026-01-01","amount":10000}]，amount 单位元，负数表示取出' },
      annualRate: { type: 'number', description: '年有效收益率' },
      annualFee: { type: 'number' },
      valuationDate: { type: 'string', description: '估值日 YYYY-MM-DD，默认今天' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        let parsed: Array<{ date?: string; amount?: number }>
        try {
          parsed = JSON.parse(String(args.flows ?? '[]')) as Array<{ date?: string; amount?: number }>
        } catch {
          return asJson({ ok: false, error: 'flows 必须是 JSON 数组' })
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return asJson({ ok: false, error: 'flows 不能为空' })
        const flows: CashFlowPoint[] = parsed.map((f) => ({
          date: String(f.date ?? '').slice(0, 10),
          cents: toCentsSafe(f.amount),
        }))
        const result = futureValueOfFlows(flows, pct(args.annualRate), String(args.valuationDate ?? new Date().toISOString().slice(0, 10)), {
          annualFee: pct(args.annualFee),
        })
        return asJson({
          ok: true,
          valueYuan: yuan(result.valueCents),
          investedYuan: yuan(result.investedCents),
          growthYuan: yuan(result.growthCents),
          skippedFlows: result.skipped,
          note: result.skipped > 0 ? '有现金流日期晚于估值日或格式错误，已跳过' : '按实际天数复利（act/365）',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wealth_plan_create',
    description: '保存一个财富情景（稳健/基准/压力由你自己命名，名称不代表概率）。保存的是输入 + 当时的确定性结果快照，并带引擎版本。',
    parameters: {
      name: { type: 'string', required: true },
      principal: { type: 'number' },
      contribution: { type: 'number' },
      frequency: { type: 'string', enum: [...CONTRIBUTION_FREQUENCIES] },
      timing: { type: 'string', enum: [...CONTRIBUTION_TIMING] },
      annualRate: { type: 'number', required: true },
      annualFee: { type: 'number' },
      inflation: { type: 'number' },
      years: { type: 'number', required: true },
      contributionGrowth: { type: 'number' },
      target: { type: 'number', description: '目标金额（元，可选）' },
      notes: { type: 'string' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        if (!deps.plans) return asJson({ ok: false, error: '方案存储未启用' })
        await ensure()
        const plan = await deps.plans.save({
          name: String(args.name ?? ''),
          principalCents: toCentsSafe(args.principal),
          contributionCents: toCentsSafe(args.contribution),
          frequency: normFrequency(args.frequency),
          timing: normTiming(args.timing),
          annualRate: pct(args.annualRate),
          annualFee: pct(args.annualFee),
          inflation: pct(args.inflation),
          years: Number(args.years ?? 0),
          contributionGrowth: pct(args.contributionGrowth),
          ...(args.target !== undefined ? { targetCents: toCentsSafe(args.target) } : {}),
          notes: args.notes ? String(args.notes) : '',
        })
        return asJson({ ok: true, plan, note: '已保存；重新计算时用 wealth_plan_compare 对齐口径。' })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wealth_plan_compare',
    description: '对比已保存的情景（可指定 planIds，否则取最近的全部），列出期末金额、累计投入、收益、实际购买力与是否达标。',
    parameters: {
      planIds: { type: 'string', description: '逗号分隔的 planId；省略则对比全部' },
      recompute: { type: 'boolean', description: '是否用当前引擎重算并报告与快照的差异' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        if (!deps.plans) return asJson({ ok: false, error: '方案存储未启用' })
        await ensure()
        const ids = String(args.planIds ?? '').split(/[,，\s]+/).filter(Boolean)
        const rows = deps.plans.compare(ids)
        const drift = args.recompute === true
          ? rows.map((row) => {
            const recomputed = deps.plans!.recompute(row.planId)
            return { planId: row.planId, name: row.name, snapshotYuan: row.finalYuan, recomputedYuan: recomputed?.finalYuan ?? null, same: recomputed?.same ?? null }
          })
          : undefined
        return asJson({ ok: true, count: rows.length, plans: rows, ...(drift ? { drift } : {}), note: '名称（稳健/基准/压力）只是标签，不代表收益概率。' })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))
}
