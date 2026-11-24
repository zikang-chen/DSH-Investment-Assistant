/**
 * 研究小组分工的离线测试。
 *
 * 只验证「简报与边界」：不触发任何网络、不写文件、不产生交易指令。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TEAM_ROLES, buildTeamPlan, renderTeamPrompt } from '../src/team/team-plan.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log('PASS', name) }

check('三个角色各有交回字段与边界，且都不允许执行', () => {
  assert.deepEqual(TEAM_ROLES.map((r) => r.role), ['researcher', 'trader', 'risk'])
  for (const role of TEAM_ROLES) {
    assert.ok(role.deliverables.length >= 3, `${role.role} 交回字段太少`)
    assert.ok(role.boundaries.length >= 2, `${role.role} 边界太少`)
  }
  const trader = TEAM_ROLES.find((r) => r.role === 'trader')!
  assert.match(trader.boundaries.join('；'), /不产生订单/)
  const risk = TEAM_ROLES.find((r) => r.role === 'risk')!
  assert.match(risk.boundaries.join('；'), /不改持仓/)
})

check('缺标的直接报错，不生成空简报', () => {
  assert.throws(() => buildTeamPlan({ target: '   ' }), /需要一只标的/)
})

check('默认问题与自定义问题', () => {
  const plan = buildTeamPlan({ target: '600519' })
  assert.equal(plan.target, '600519')
  assert.match(plan.question, /值得继续研究/)
  assert.equal(plan.briefs.length, 3)
  const custom = buildTeamPlan({ target: '600519', question: '现在能不能加仓？' })
  assert.equal(custom.question, '现在能不能加仓？')
  assert.ok(custom.briefs.every((b) => b.assignment.includes('现在能不能加仓')))
})

check('只给部分角色时按请求生成', () => {
  const plan = buildTeamPlan({ target: 'AAPL', roles: ['researcher', 'risk'] })
  assert.deepEqual(plan.briefs.map((b) => b.role), ['researcher', 'risk'])
})

check('持仓授权默认关闭，只有显式 true 才写进提示词', () => {
  const closed = renderTeamPrompt(buildTeamPlan({ target: '600519' }))
  assert.match(closed, /本次不读取我的持仓/)
  assert.doesNotMatch(closed, /本次允许读取我的持仓/)
  const open = renderTeamPrompt(buildTeamPlan({ target: '600519', portfolioAuthorized: true }))
  assert.match(open, /本次允许读取我的持仓/)
  assert.match(open, /只读，不写账本/)
})

check('提示词包含交接顺序、汇总规则与「不生成订单」的硬约束', () => {
  const prompt = renderTeamPrompt(buildTeamPlan({ target: '510300' }))
  assert.match(prompt, /顺序：研究员先出事实/)
  assert.match(prompt, /汇总：/)
  assert.match(prompt, /不生成订单、不改账本/)
  assert.match(prompt, /研究员/)
  assert.match(prompt, /交易员/)
  assert.match(prompt, /风控/)
})

check('不做任何 I/O：模块只导出纯函数', () => {
  const source = readFileSync('src/team/team-plan.ts', 'utf8')
  assert.doesNotMatch(source, /node:fs|fetch\(|apiPost|deliver\(|process\.env/)
  const tool = readFileSync('src/tools/team.ts', 'utf8')
  assert.doesNotMatch(tool, /apiPost|appendEvent|writeFile|upsert_holding|capital_transaction_add/)
})

check('工具与面板接线：一个工具、一个按钮，且按钮不自动执行', () => {
  const register = readFileSync('src/tools/register.ts', 'utf8')
  assert.match(register, /registerTeamTools\(ctx\)/)
  const tool = readFileSync('src/tools/team.ts', 'utf8')
  assert.match(tool, /name: 'team_brief'/)
  const page = readFileSync('src/client/index.tsx', 'utf8')
  assert.match(page, /buildTeamPlan\(\{ target:/)
  assert.match(page, /renderTeamPrompt\(plan\)/)
  assert.match(page, /onTeam:/)
  // 只在用户点击后投递：不应出现在 useEffect 里。
  assert.doesNotMatch(page, /useEffect\([^)]*renderTeamPrompt/s)
})

console.log(`\n[team-plan] ${checks} 组通过（离线；未验证宿主的子代理调度）`)
