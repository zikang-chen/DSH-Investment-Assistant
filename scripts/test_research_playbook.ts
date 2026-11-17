/**
 * 只读、离线的文档/源码静态契约检查。
 * 不调用金融工具，不抓网页，不读取私人数据，不模拟端到端研究成功。
 * Run: node --import tsx scripts/test_research_playbook.ts
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const load = (relative: string) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
const [skill, playbook, userDoc, tools, westockTools, capabilities, policyTools, policyCollect, evidenceTools, ingestion, workflow, investTools, investSchema, providers, fundDossier] = await Promise.all([
  'skills/investment-advisor/SKILL.md',
  'skills/investment-advisor/references/research-playbook.md',
  'docs/conversational-research.md',
  'src/tools/register.ts',
  'src/tools/westock.ts',
  'src/data/westock-capabilities.ts',
  'src/policy/tools.ts',
  'src/policy/collect.ts',
  'src/evidence/tools.ts',
  'src/evidence/ingestion.ts',
  'src/evidence/workflow.ts',
  'src/invest/tools.ts',
  'src/invest/schema.ts',
  'src/data/providers.ts',
  'src/data/fund-dossier.ts',
].map(load))

let count = 0
const failures: string[] = []
function test(name: string, fn: () => void) {
  try {
    fn()
    count++
    console.log(`PASS ${name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${detail}`)
    console.error(`FAIL ${name}: ${detail}`)
  }
}
function includesAll(text: string, parts: string[]) {
  for (const part of parts) assert.ok(text.includes(part), `缺少静态合同内容: ${part}`)
}
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  assert.notEqual(start, -1, `缺少章节: ${heading}`)
  const end = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, end === -1 ? undefined : end)
}
function registered(source: string, name: string) {
  assert.ok(source.includes(`name: '${name}'`), `源码未声明工具: ${name}`)
}

test('入口精简并可靠链接按需加载的参考手册', () => {
  assert.match(skill, /^---\r?\nname: investment-advisor\r?\n/)
  assert.ok(skill.split(/\r?\n/).length <= 100, '细节应移到 reference，入口不要无限增长')
  assert.match(skill, /\[研究执行手册\]\(references\/research-playbook\.md\)/)
  assert.match(skill, /不把所有工具固定全跑/)
  includesAll(skill, ['身份先于取数', '持仓授权默认关闭', 'critical Evidence Request', 'INSUFFICIENT_DATA', 'investment_advice_generate'])
})

test('身份、目标、期限与歧义候选在研究前明确', () => {
  const identity = section(playbook, '## 1.')
  includesAll(identity, ['search_symbol(query)', 'matches', '目标', '期限', '实际候选', '不能默认第一项', '份额', 'yingmi_list', 'yingmi_schema', 'yingmi_call'])
  registered(tools, 'search_symbol')
  assert.match(tools, /matches: res\.data/)
  assert.match(userDoc, /名称片段[\s\S]*真实候选/)
})

test('只有按需无依赖取数可并行，依赖项和复用链不跳过', () => {
  const plan = section(playbook, '## 2.')
  includesAll(plan, ['list_research', 'get_research', 'policy_search', 'policy_get', '互不依赖', '按需并行', '具体链接', '真实 id', '基金持仓确认后', '统计/财报期间', '抽取/核验状态'])
  assert.match(skill, /深度档案不是每次必跑/)
})

test('默认不授权，隐式读取组合的工具也受保护', () => {
  const identity = section(playbook, '## 1.')
  includesAll(identity, ['持仓授权默认关闭', 'get_portfolio', 'analyze_fund_overlap', 'check_new_position', 'simulate_rebalance', 'policy_portfolio_exposure', 'capital_*', '私有文件', '未使用个人持仓'])
  assert.match(tools, /name: 'analyze_fund_overlap'[\s\S]*finance\.analyzePortfolio/)
  assert.match(tools, /name: 'simulate_rebalance'[\s\S]*finance\.analyzePortfolio/)
  includesAll(userDoc, ['只有你明确授权', '未使用个人持仓'])
})

test('公告列表到真实详情，原文与新闻摘要明确分工', () => {
  const stock = section(playbook, '## 3.')
  includesAll(stock, ['get_notice_list', 'notice_detail', '公司 IR', '官方原文', '合并范围', '不能替代官方财报原文', '仅取得摘要，未核对年报正文', '不得用摘要冒充 PDF 已读'])
  registered(westockTools, 'get_notice_list')
  assert.match(capabilities, /capability: 'notice_detail'[\s\S]*?argv: \(a\) => \['notice', 'detail', String\(a\.id/)
  registered(tools, 'get_financial_indicators')
})

test('PDF 成功存字节不是已读，关键失败走 critical 请求和受限分析', () => {
  const stock = section(playbook, '## 3.')
  includesAll(stock, ['PDF 读取闸门', "parseStatus='pdf-pending'", 'evidence_submit', '只存字节', 'importance=\'critical\'', "blockingLevel='blocking'", '受限分析', '不编造 OCR'])
  assert.match(policyCollect, /kind === 'pdf'[\s\S]*?text: ''[\s\S]*?parseStatus: 'pdf-pending'/)
  assert.match(ingestion, /PDF 只保存了原文，未抽取正文/)
  assert.match(ingestion, /verificationMethod = 'file:pdf-bytes-only'/)
  includesAll(stock, ['office_render(input,pages)', 'read_image', '未读全部页不能称读完整份年报', '人工/视觉转录', '不修改/冒用原始哈希', '不是后台自动批量 PDF 抽取', 'office_convert', '不支持 PDF 输入'])
  includesAll(userDoc, ['critical Evidence Request', '不代表 PDF 已读', '待补证据', '人工/视觉转录'])
})

test('基金经理、费用、份额、回撤和重仓企业财务分层，不伪造营收', () => {
  const fund = section(playbook, '## 4.')
  includesAll(fund, ['currentFundManager', '经理任期', 'calculate_fund_metrics', 'compare_funds', '合同基准', '单位净值、未处理分红再投资', 'T+1', '费用/规则', '招募说明书', '基金没有企业式营业收入', '前 N 大覆盖比例', '债券/货币基金'])
  includesAll(providers, ['Data_currentFundManager', 'raw: { navDate: last.date, profile: fd.profile }'])
  assert.match(fundDossier, /基准为宽基指数近似，非基金合同约定/)
  assert.match(fundDossier, /净值口径，不含分红/)
  registered(tools, 'calculate_fund_metrics')
  registered(tools, 'fund_dossier')
})

test('区分基金内部服务与已注册工具，不杜撰 get_fund_holdings', () => {
  includesAll(section(playbook, '## 4.'), ['FinanceDataService.getFundHoldings', '不是已注册的独立', '管理人官方定期报告', 'get_etf_holdings', '只读实际返回字段'])
  assert.doesNotMatch(tools + westockTools, /name: 'get_fund_holdings'/)
  registered(westockTools, 'get_etf_holdings')
})

test('全球官方网页路由不是 NBS 独占，不发明全球结构化接口', () => {
  const global = section(playbook, '## 5.')
  includesAll(global, ['cpi/ppi/pmi/gdp/money_supply', '不存在通用全球结构化宏观工具', 'web_search', 'web_fetch', 'BLS', 'BEA', 'Fed', 'ECB', 'Eurostat', 'IMF', 'World Bank', 'OECD', '中国人民银行', '财政部', '海关', 'NBS', '季调', '修订', '预测', '以实际工具 schema 为准', 'global_to_china_impact'])
  assert.match(tools, /series: \{ type: 'string', required: true, enum: \['cpi', 'ppi', 'pmi', 'gdp', 'money_supply'\]/)
  registered(policyTools, 'global_to_china_impact')
  assert.match(global, /不编造 `get_macro_global`/)
  assert.match(userDoc, /不存在通用全球结构化宏观工具/)
})

test('A 股市场范围、资金分类、全球行情和报价时效不扩大', () => {
  const stock = section(playbook, '## 3.')
  includesAll(stock, ['A 股/沪深范围', '不能称「全球市场全景」', '资金分类不是投资者意图', 'probe_finance_sources', '截至时间'])
  includesAll(section(playbook, '## 5.'), ['并非全球所有指数'])
  includesAll(section(playbook, '## 5.'), ['不是自动核实新闻或全球抓数器', 'macro_catalog', 'macro_indicator', '不编造海外 indicator id'])
})

test('国际 allowlist 拒绝后有合法资料库/授权本地材料通路', () => {
  const policy = section(playbook, '## 6.')
  includesAll(policy, ['policy_sources', 'policy_import(url)', 'allowlist', '未允许的国际来源不能伪称可直接入政策库', 'save_research', '资料库记录不等于政策库政策 id', '用户合法取得/获授权提供', '.pdf/.html/.md/.txt', '不是修改 allowlist', '不能保证新正文会自动替换或合并原 PDF 条目'])
  assert.match(policyTools, /hosts: deps\.hosts/)
  assert.match(policyTools, /需要 url \/ text \/ filePath 之一/)
  assert.match(policyTools, /docType: \{ type: 'string', enum: \[\.\.\.POLICY_DOC_TYPES\]/)
  includesAll(userDoc, ['未允许的 URL 不能宣称可直接入政策库', '不为导入擅改 host 配置'])
})

test('白皮书真实类型、效力、版本与原文定位可追溯', () => {
  const policy = section(playbook, '## 6.')
  includesAll(policy, ["docType:'white-paper'", '文号', '效力', 'version', '段落下标', 'contentHash/originalPath', 'paragraphFrom/paragraphTo', 'policy_compare', 'policy_execution', 'mirrored/mirrorFailed'])
  includesAll(policyTools, ['paragraphFrom', 'paragraphTo', 'truncated:', 'version: doc.version', 'originalPath: doc.originalPath'])
})

test('Evidence Request 使用真实字段，接受后恢复，不因上传升级官方核验', () => {
  const gap = section(playbook, '## 7.')
  includesAll(gap, ['evidence_request_list', 'evidence_request_create', 'resumeSummary', 'knownFacts', 'nextStep', 'expectedReportingPeriod', 'requiredUnits', 'evidence_submit', 'validation/issues', 'evidence_validate', 'evidence_request_resolve', 'ACCEPTED', 'evidence_research_resume', '用户提交 ≠ 官方事实，人工确认 ≠ 官方核验', '不保证被现有国内官方域名识别规则识别为官方'])
  includesAll(evidenceTools, ['researchTaskId:', 'importance:', 'blockingLevel:', 'resumeSummary:', 'knownFacts:', 'nextStep:'])
  assert.match(workflow, /request\.status !== 'ACCEPTED'/)
  assert.match(ingestion, /const OFFICIAL_SUFFIX = .*gov\\\.cn/)
  assert.match(gap, /不要传不存在的 `resumeContext` 工具参数/)
})

test('缺价格/汇率、估值和模拟不编造，反证/失效/复核完整', () => {
  const judgment = section(playbook, '## 8.')
  includesAll(judgment, ['支持与反对证据', '失效', '复核日期', '历史价位不是估值历史分位', 'calculationRefs', 'before/after', '缺价格/汇率不编、不按零', '按币种分列', '不触发交易、不修改账本'])
  includesAll(skill, ['缺价格、汇率', '不得成本代现价', '跨币种直接相加'])
})

test('资料库和 advice 双保存，失败不宣称成功，复核只追加', () => {
  const save = section(playbook, '## 8.')
  includesAll(save, ['save_research', 'source/date', 'add_research_note', 'investment_advice_generate', 'supporting/contradicting', 'JSON 数组字符串', 'invalidationConditions', 'unresolvedQuestions', '不填 `proposedActionSummary`', 'ref', 'adviceId', 'item.file', '两边部分失败则分别说明', 'investment_advice_review', '追加复核', '未获明确请求不创建定时任务'])
  includesAll(investTools, ['portfolioContextUsed:', 'dataFreshnessStatus:', 'proposedActionSummary:', 'nextReviewAt:', 'unresolvedQuestions:'])
  includesAll(investSchema, ["'fundamental'", "'research'", "'evidence-request'"])
  assert.doesNotMatch(investSchema, /'annual-report'/)
  includesAll(userDoc, ['真实成功回执', 'adviceId', '不抹掉原判断'])
})

test('明确静态测试的证明边界，真实端到端验收另行授权', () => {
  includesAll(playbook, ['不是已执行的金融结论', '仅证明文档路由', '不证明搜索命中', '真实端到端验收需另获授权'])
  includesAll(userDoc, ['不证明网站在线', '真实端到端', '未授权持仓不读取', '缺价/汇率降级', '双链保存'])
})

assert.equal(failures.length, 0, failures.join('\n'))
console.log(`[research-playbook] ${count} groups passed — 仅静态契约，非真实端到端；未联网、未运行金融工具、未读取私人数据。`)
