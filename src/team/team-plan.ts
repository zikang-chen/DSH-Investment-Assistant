/**
 * 研究小组：把「一只标的/一个问题」拆成三个角色能接手的简报。
 *
 * 结论先写在这里：本项目不做「多智能体下单」。可复用的编排只有研究侧——
 * 研究员查证、交易员给条件化方案、风控找反证与失效条件，最后由主 Agent 汇总。
 *
 * 参考：
 * - Anthropic 多智能体研究系统（orchestrator–worker，交接物要写清目标/格式/工具/边界）
 * - OpenAI Agents SDK handoffs（交接是一次明确的工具调用，可带结构化输入）
 * - CrewAI 的 sequential / hierarchical 流程、LangGraph 的 supervisor 模式
 * - 同生态 dsh-trading：master 统领 researcher / trader / risk-reviewer，执行默认 dry-run
 *
 * 这里只产出「可执行的简报」，不替 Agent 做决策，也不触发任何写操作。
 */

export type TeamRole = 'researcher' | 'trader' | 'risk'

export interface TeamRoleSpec {
  role: TeamRole
  title: string
  objective: string
  /** 该角色至少要交回的字段；缺了就不算完成。 */
  deliverables: readonly string[]
  /** 允许使用的信息边界，防止越权或编造。 */
  boundaries: readonly string[]
}

export const TEAM_ROLES: readonly TeamRoleSpec[] = [
  {
    role: 'researcher',
    title: '研究员',
    objective: '把「这只标的是什么、现在什么位置、有哪些可核验事实」查清楚，不做买卖结论。',
    deliverables: ['身份与市场', '关键数据（价格/估值/资金/财报，各带来源与日期）', '支持证据', '反对证据', '仍未取到的资料'],
    boundaries: ['只用可核验来源，注明统计期与数据时点', '取不到就写缺失，不用摘要冒充原文', '不给买卖建议'],
  },
  {
    role: 'trader',
    title: '交易员',
    objective: '在研究员给出的事实基础上，写条件化的情景方案（如果 A 则 B），说明触发与放弃条件。',
    deliverables: ['情景与触发条件', '若执行的动作与规模（占组合比例）', '失效/放弃条件', '复核日期'],
    boundaries: ['只写纸面方案，不产生订单', '必须引用研究员给出的事实与日期', '不承诺收益'],
  },
  {
    role: 'risk',
    title: '风控',
    objective: '主动找反证：什么情况下这个判断会错，组合层面会不会变成同一个赌注。',
    deliverables: ['主要风险与反证', '集中度/相关性影响', '失效条件是否可观测', '需要补的证据'],
    boundaries: ['只读分析，不改持仓与策略', '必须给出可观测的失效条件', '不替用户做决定'],
  },
] as const

export interface TeamPlanInput {
  /** 标的代码或名称；与 question 至少给一个。 */
  target?: string
  /** 研究问题；没有就给默认问题。 */
  question?: string
  /** 是否允许读取本机持仓（默认否）。 */
  portfolioAuthorized?: boolean
  /** 只要某几个角色，默认三个都给。 */
  roles?: TeamRole[]
}

export interface TeamBrief extends TeamRoleSpec {
  /** 交给该角色的一句话任务。 */
  assignment: string
}

export interface TeamPlan {
  target: string
  question: string
  portfolioAuthorized: boolean
  briefs: TeamBrief[]
  /** 交接顺序：研究与风控可以并行，交易员依赖研究员。 */
  order: string
  /** 汇总要求，主 Agent 收口时用。 */
  mergeRule: string
}

const DEFAULT_QUESTION = '这只标的现在值得继续研究吗？给出条件化结论与反证。'

export function buildTeamPlan(input: TeamPlanInput): TeamPlan {
  const target = String(input.target ?? '').trim()
  const question = String(input.question ?? '').trim() || DEFAULT_QUESTION
  if (!target) throw new Error('需要一只标的（代码或名称）才能分工')
  const wanted = input.roles?.length ? new Set(input.roles) : undefined
  const briefs = TEAM_ROLES
    .filter((spec) => !wanted || wanted.has(spec.role))
    .map((spec) => ({ ...spec, assignment: assign(spec.role, target, question) }))
  return {
    target,
    question,
    portfolioAuthorized: input.portfolioAuthorized === true,
    briefs,
    order: '研究员先出事实 → 风控同步找反证 → 交易员在事实+反证上写情景 → 主 Agent 汇总成一个结论',
    mergeRule: '汇总时保留三方分歧：事实以研究员为准，情景以交易员为准，失效条件以风控为准；三者冲突处直接写明冲突，不合并成一句。',
  }
}

function assign(role: TeamRole, target: string, question: string): string {
  if (role === 'researcher') return `查清「${target}」的身份、关键数据与正反证据，回答：${question}`
  if (role === 'trader') return `基于研究员给出的事实，为「${target}」写条件化情景与放弃条件，回答：${question}`
  return `对「${target}」做反证与集中度检查，指出这个判断会在什么情况下错，回答：${question}`
}

/** 渲染成可直接投递到对话的提示词；不含任何自动执行指令。 */
export function renderTeamPrompt(plan: TeamPlan): string {
  const lines = [
    `请用「研究小组」分工的方式分析 ${plan.target}，问题：${plan.question}`,
    '',
    '分工与交接物（每项都要交回，缺项要说明缺什么）：',
  ]
  for (const brief of plan.briefs) {
    lines.push(
      `- ${brief.title}：${brief.assignment}`,
      `  交回：${brief.deliverables.join('、')}`,
      `  边界：${brief.boundaries.join('；')}`,
    )
  }
  lines.push('', `顺序：${plan.order}`, `汇总：${plan.mergeRule}`)
  lines.push(plan.portfolioAuthorized
    ? '本次允许读取我的持仓数量与成本用于集中度判断，只读，不写账本。'
    : '本次不读取我的持仓；组合层面的判断只能给条件式说明。')
  lines.push('全程只做研究与纸面方案：不生成订单、不改账本、不覆盖已保存的策略，结论需我确认。')
  return lines.join('\n')
}
