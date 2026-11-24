/**
 * Agent 工具：研究小组分工。
 *
 * 只产出简报与提示词，不执行任何写操作。真正干活仍由主 Agent 调既有工具完成，
 * 需要并行时由它自己委派子代理——这里不越权替它调度。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildTeamPlan, renderTeamPrompt, type TeamRole } from '../team/team-plan.js'

export function registerTeamTools(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'team_brief',
    description: '把一个研究问题拆成「研究员 / 交易员 / 风控」三份简报（目标、交回字段、边界、交接顺序），用于分头研究后由主 Agent 汇总。只返回简报与提示词，不执行分析与交易；需要并行时请自行委派子代理。',
    parameters: {
      target: { type: 'string', required: true, description: '标的代码或名称，如 600519 / 510300 / AAPL' },
      question: { type: 'string', description: '要回答的研究问题；省略时用一个默认的条件化问题' },
      roles: { type: 'string', description: '可选：只给部分角色，逗号分隔 researcher,trader,risk' },
      portfolio_authorized: { type: 'boolean', description: '本次是否允许读取本机持仓（只读）；默认否' },
    },
    output: jsonOut,
    async execute(args: Record<string, unknown>) {
      const rolesRaw = String(args.roles ?? '').trim()
      const roles = rolesRaw
        ? rolesRaw.split(/[,，\s]+/).filter((role): role is TeamRole => role === 'researcher' || role === 'trader' || role === 'risk')
        : undefined
      if (rolesRaw && !roles?.length) return asJson({ ok: false, error: 'roles 只能是 researcher / trader / risk' })
      try {
        const plan = buildTeamPlan({
          target: String(args.target ?? ''),
          ...(args.question ? { question: String(args.question) } : {}),
          ...(roles ? { roles } : {}),
          portfolioAuthorized: args.portfolio_authorized === true,
        })
        return asJson({ ok: true, plan, prompt: renderTeamPrompt(plan) })
      } catch (error) {
        return asJson({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}

function asJson(value: unknown): import('@deepseek-ai/dsh-util-values').JsonValue {
  return JSON.parse(JSON.stringify(value)) as import('@deepseek-ai/dsh-util-values').JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}
