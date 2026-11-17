/**
 * 金融学习 — 内置概念库（P0）。
 *
 * 内容原则：
 * - 三级解释（小白 / 进阶 / 专业）都由人写成静态文本，不依赖模型临时编造；
 * - `interpretationRules` 明确统计口径与常见误读（例如社融增量 vs 存量、GDP 同比 vs 累计）；
 * - 只写稳定概念，不写「最新数值」；实时数字必须来自数据工具；
 * - `relatedLessons` 复用成长模块已有的微课，不重复造课程。
 */

export const CONCEPT_CATEGORIES = [
  'basics', 'macro-cn', 'fundamental', 'valuation', 'market', 'global', 'personal',
] as const
export type ConceptCategory = (typeof CONCEPT_CATEGORIES)[number]

export const CATEGORY_LABEL: Record<ConceptCategory, string> = {
  basics: '金融基础',
  'macro-cn': '中国宏观',
  fundamental: '公司基本面',
  valuation: '估值',
  market: '市场分析',
  global: '全球宏观',
  personal: '个人投资',
}

export const EXPLAIN_LEVELS = ['beginner', 'intermediate', 'advanced'] as const
export type ExplainLevel = (typeof EXPLAIN_LEVELS)[number]

export const LEVEL_LABEL: Record<ExplainLevel, string> = {
  beginner: '小白版',
  intermediate: '进阶版',
  advanced: '专业版',
}

export interface FinancialConcept {
  conceptId: string
  name: string
  aliases: string[]
  category: ConceptCategory
  beginner: string
  intermediate: string
  advanced: string
  formula?: string
  /** 口径与「怎么读这个数」的规则；也会用于解释页面上的具体数值。 */
  interpretationRules: string[]
  misconceptions: string[]
  relatedConcepts: string[]
  relatedIndicators: string[]
  referenceSources: string[]
  /** 复用成长模块的微课 id（可选）。 */
  relatedLessons?: string[]
  contentVersion: string
  lastVerifiedAt: string
}

interface ConceptSeed {
  id: string
  name: string
  aliases?: string[]
  category: ConceptCategory
  beginner: string
  intermediate: string
  advanced: string
  formula?: string
  rules: string[]
  wrong: string[]
  related?: string[]
  indicators?: string[]
  lessons?: string[]
}

const SEEDS: ConceptSeed[] = [
  {
    id: 'pe', name: '市盈率（PE）', aliases: ['PE', 'P/E', '市盈率', 'pe_ratio', 'pe_ttm'],
    category: 'valuation',
    beginner: '市盈率 = 股价 ÷ 每股收益，意思是「按现在的盈利水平，多少年能赚回买入价」。它像租金回报率的倒数：你付的价格相对公司一年赚的钱有多贵。',
    intermediate: 'PE 是把价格和盈利挂钩的相对估值指标。常用两种口径：静态 PE 用上一年盈利，TTM 用最近四个季度。适用于盈利稳定的公司，用于横向同业比较和纵向历史分位比较。',
    advanced: 'PE = P/EPS。TTM 口径能更快反映盈利变化但受一次性损益影响；周期股在盈利高点 PE 反而低（分母放大），低 PE 不等于便宜。亏损或盈利接近 0 时 PE 无意义，应改用 PB、EV/EBITDA 或现金流折现。',
    formula: 'PE = 股价 ÷ 每股收益(EPS)；总市值口径 = 总市值 ÷ 归母净利润',
    rules: [
      '先确认口径：静态 / TTM / 动态（预测）不能混用比较',
      '与历史分位、同业同期比较才有意义；跨行业比较要谨慎',
      '亏损或微利时 PE 失效，不要用「负 PE」排序',
    ],
    wrong: ['PE 低就是便宜（周期股盈利高点时 PE 会很低）', 'PE 高就一定会跌（高增长可以消化高估值）'],
    related: ['pb', 'roe', 'pe-percentile'],
    indicators: ['pe_ratio', 'pe_ttm_percentile'],
    lessons: ['valuation-basics'],
  },
  {
    id: 'pe-percentile', name: '估值分位数', aliases: ['估值分位', 'PE 分位', 'pe_percentile', '历史分位'],
    category: 'valuation',
    beginner: '把今天的估值放到过去几年里排队：如果现在处于 20% 分位，意思是历史上 80% 的时间比现在贵。',
    intermediate: '估值分位 = 当前估值在给定历史窗口（如近 5 年）中的百分位。窗口长短会显著改变结论，且盈利周期变化会让「历史」不再可比。',
    advanced: '分位数是对历史分布的描述统计，前提是分布稳定。对结构性变化（盈利模式、会计准则、行业地位变化）不敏感；样本期越短越容易得出极端分位。应同时报告窗口、样本量与当前盈利所处周期位置。',
    rules: ['必须写明窗口（3 年/5 年/10 年）与样本量', '分位数不是涨跌概率：低分位≠会涨'],
    wrong: ['「历史最低分位所以必涨」', '用不同窗口比较两个标的'],
    related: ['pe', 'pb'],
    indicators: ['pe_ttm_percentile', 'pb_percentile'],
    lessons: ['valuation-basics'],
  },
  {
    id: 'pb', name: '市净率（PB）', aliases: ['PB', 'P/B', '市净率', 'pb_ratio'],
    category: 'valuation',
    beginner: '市净率 = 股价 ÷ 每股净资产，意思是「你花多少钱买公司 1 元净资产」。',
    intermediate: 'PB 适合重资产行业（银行、地产、公用事业）与盈利波动大的周期行业。PB 低可能是便宜，也可能是资产质量差（坏账、减值）。',
    advanced: 'PB 的有效性依赖净资产的可靠性：商誉、无形资产、减值准备都会扭曲账面价值。银行股 PB<1 常反映市场对资产质量的折价，而非无风险套利。可结合 ROE 用 PB-ROE 框架。',
    formula: 'PB = 股价 ÷ 每股净资产；或 总市值 ÷ 归母净资产',
    rules: ['PB 与 ROE 一起看：低 PB + 低 ROE 可能是价值陷阱', '注意商誉与减值对净资产的影响'],
    wrong: ['PB 小于 1 就是捡钱', '轻资产公司用 PB 比较'],
    related: ['pe', 'roe'],
    indicators: ['pb_ratio'],
    lessons: ['valuation-basics'],
  },
  {
    id: 'roe', name: '净资产收益率（ROE）', aliases: ['ROE', '净资产收益率', 'roe'],
    category: 'fundamental',
    beginner: 'ROE 衡量「公司用股东的钱赚钱的效率」。ROE 15% 意味着股东每 100 元净资产，一年赚 15 元。',
    intermediate: 'ROE = 净利润 ÷ 净资产。可通过杜邦分解为净利率 × 资产周转率 × 权益乘数，用来判断高 ROE 来自盈利、效率还是加杠杆。',
    advanced: '杜邦分解：ROE = 净利率 × 总资产周转率 × 权益乘数。高杠杆推高的 ROE 在利率上行或需求下滑时更脆弱。比较时应看多年稳定性、是否依赖非经常性损益，并与 ROIC 对比判断是否为「真实回报」。',
    formula: 'ROE = 归母净利润 ÷ 平均归母净资产（杜邦：净利率×周转率×权益乘数）',
    rules: ['用平均净资产而非期末值', '看 3–5 年稳定性，不只看单年'],
    wrong: ['高 ROE 一定是好公司（可能是高杠杆）', '用单季度 ROE 年化后直接比较'],
    related: ['roic', 'pe', 'pb'],
    indicators: ['roe'],
    lessons: ['reading-financials'],
  },
  {
    id: 'roic', name: '投入资本回报率（ROIC）', aliases: ['ROIC', '投入资本回报率', 'roic'],
    category: 'fundamental',
    beginner: 'ROIC 看「公司用全部投入的资本（股东+债权人的钱）赚钱的效率」，比 ROE 更接近真实经营能力。',
    intermediate: 'ROIC = NOPAT ÷ 投入资本。与加权平均资本成本（WACC）比较：ROIC > WACC 才创造价值。',
    advanced: 'NOPAT = EBIT ×(1−税率)；投入资本 = 有息负债 + 股东权益 − 超额现金。ROIC 消除了资本结构影响，适合跨公司比较；但需注意租赁、研发资本化等会计差异。',
    formula: 'ROIC = NOPAT ÷ 投入资本；创造价值条件 ROIC > WACC',
    rules: ['与 WACC 比较才有意义', '注意会计口径（租赁、资本化研发）'],
    wrong: ['把 ROIC 与 ROE 混用', '忽略资本成本直接说「回报率高」'],
    related: ['roe'],
    indicators: ['roic'],
  },
  {
    id: 'gross-margin', name: '毛利率', aliases: ['毛利率', 'gross_margin'],
    category: 'fundamental',
    beginner: '毛利率 =（收入 − 成本）÷ 收入，反映「卖一件东西能留下多少钱」再去覆盖费用。',
    intermediate: '毛利率变化能提前反映价格战、原材料成本与产品结构变化；与同行比较可判断议价能力。',
    advanced: '毛利率受会计口径（运费计入销售费用还是成本）、产品结构、渠道结构影响。分析时应拆量、价、结构三因素，并结合存货与应收账款判断收入质量。',
    formula: '毛利率 = (营业收入 − 营业成本) ÷ 营业收入',
    rules: ['注意运费等口径变化', '毛利率下滑要看是价格还是成本'],
    wrong: ['毛利率高就一定赚钱（费用可能很高）'],
    related: ['revenue', 'net-profit'],
    indicators: ['gross_margin'],
    lessons: ['reading-financials'],
  },
  {
    id: 'revenue', name: '营业收入', aliases: ['营收', '营业收入', 'revenue', 'revenue_yoy'],
    category: 'fundamental',
    beginner: '公司卖东西收到的钱（不含税），是「生意规模」的度量。',
    intermediate: '看营收要同时看同比增速与结构（哪块业务在增长），并与应收账款、存货增速对比判断是否「赊出来的增长」。',
    advanced: '收入确认受会计准则（时点/时段）、总额法/净额法影响，总额法与净额法之间不可直接比较增速。应关注合同负债、应收周转与经营现金流是否匹配。',
    rules: ['同比增速要区分单季与累计', '收入增长要与现金流、应收匹配'],
    wrong: ['营收增长就是好公司', '用总额法公司与净额法公司直接比增速'],
    related: ['net-profit', 'gross-margin'],
    indicators: ['revenue_yoy'],
    lessons: ['reading-financials'],
  },
  {
    id: 'net-profit', name: '净利润', aliases: ['净利润', '归母净利润', 'net_profit', 'net_profit_yoy'],
    category: 'fundamental',
    beginner: '扣掉所有成本和税之后剩下的钱，是「最终赚了多少」。',
    intermediate: '要区分归母净利润与含少数股东的净利润，并剔除政府补助、资产处置等非经常性损益看扣非净利润。',
    advanced: '净利润受会计政策、减值、公允价值变动影响。质量判断看「经营现金流 ÷ 净利润」长期是否接近或大于 1；持续背离通常意味着利润含金量低。',
    rules: ['优先看扣非归母净利润', '与经营现金流对照'],
    wrong: ['净利润增长就等于经营改善', '忽略少数股东损益'],
    related: ['revenue', 'roe'],
    indicators: ['net_profit_yoy', 'eps'],
    lessons: ['reading-financials'],
  },
  {
    id: 'debt-ratio', name: '资产负债率', aliases: ['资产负债率', 'debt_ratio', '负债率'],
    category: 'fundamental',
    beginner: '总负债 ÷ 总资产，衡量「公司有多少东西是借来的」。',
    intermediate: '不同行业差异很大（银行天然高负债），要同行业比较；同时看有息负债规模与到期结构、现金覆盖率。',
    advanced: '资产负债率包含经营性负债（应付、预收），并不等于偿债压力。分析偿债能力应看有息负债/EBITDA、利息保障倍数、短期债务占比与现金短债比。',
    formula: '资产负债率 = 总负债 ÷ 总资产',
    rules: ['同业比较才有意义', '区分经营性负债与有息负债'],
    wrong: ['负债率高就一定危险（看结构）'],
    related: ['roe'],
    indicators: ['debt_ratio'],
    lessons: ['reading-financials'],
  },
  {
    id: 'fcf', name: '自由现金流', aliases: ['自由现金流', 'FCF', 'free_cash_flow'],
    category: 'fundamental',
    beginner: '公司经营赚到的现金，扣掉维持和扩张必须的资本开支后，真正能自由支配的钱。',
    intermediate: '自由现金流 = 经营现金流 − 资本开支。它比净利润更难被会计手段修饰，是分红与回购的基础。',
    advanced: 'FCFF = EBIT(1−t) + 折旧摊销 − 资本开支 − 营运资本增加；FCFE 需再扣净利息与净借款。重资产扩张期自由现金流可能长期为负，需结合投资回报期判断。',
    formula: 'FCF ≈ 经营活动现金流 − 资本开支（购建固定资产等支付的现金）',
    rules: ['区分 FCFF 与 FCFE', '扩张期负 FCF 不必然是坏事，要看资本回报'],
    wrong: ['自由现金流等于净利润', '用单年 FCF 判断长期价值'],
    related: ['net-profit', 'dividend'],
    indicators: ['free_cash_flow'],
  },
  {
    id: 'dividend', name: '股息与股息率', aliases: ['股息', '股息率', '分红', 'dividend', 'dividend_ratio_ttm'],
    category: 'basics',
    beginner: '公司把利润分给股东叫分红；股息率 = 每股分红 ÷ 股价，相当于「买股票的现金回报率」。',
    intermediate: '股息率要与分红率（分红/净利润）一起看：高股息率可能是股价跌出来的，也可能是不可持续的高分红。',
    advanced: '总回报 = 股息 + 资本利得。税后股息率、分红可持续性（自由现金流覆盖度、负债水平）、分红政策稳定性都要看。除权除息会造成价格跳空，不是亏损。',
    formula: '股息率 = 每股年化分红 ÷ 股价；分红率 = 分红 ÷ 净利润',
    rules: ['区分税前/税后', '除权除息不是亏损', '看自由现金流是否覆盖分红'],
    wrong: ['股息率高就是好（可能是股价暴跌）', '把除权跳空当亏损'],
    related: ['fcf'],
    indicators: ['dividend_ratio_ttm'],
  },
  {
    id: 'nav', name: '基金净值', aliases: ['净值', '单位净值', 'nav', '基金净值'],
    category: 'basics',
    beginner: '基金净值 = 基金资产 ÷ 份额，相当于「每一份值多少钱」。买入卖出按净值成交。',
    intermediate: '开放式基金按当日收盘后计算的净值成交（T+1 确认），所以看到的净值通常是上一交易日。累计净值包含历史分红，更能反映长期表现。',
    advanced: '净值受申赎、分红、费用计提影响；ETF 还有二级市场价格与 IOPV 的折溢价。比较基金业绩应使用复权净值/累计净值，并注意分红再投资假设。',
    formula: '单位净值 = 基金净资产 ÷ 基金总份额',
    rules: ['净值是 T+1 数据，不是实时价', '比较业绩用累计净值/复权净值'],
    wrong: ['净值低就便宜（净值高低与贵贱无关）', '把净值当实时价格'],
    related: ['etf', 'cagr'],
    indicators: ['nav', 'nav_ytd'],
    lessons: ['fund-basics'],
  },
  {
    id: 'etf', name: 'ETF', aliases: ['ETF', '交易型开放式指数基金', 'etf'],
    category: 'basics',
    beginner: '在交易所像股票一样买卖的基金，通常跟踪某个指数，费率低、买卖方便。',
    intermediate: 'ETF 有两个价格：二级市场交易价与基金净值（IOPV 为盘中参考）。两者偏离形成折溢价，折溢价过大时买入相当于多付钱。',
    advanced: '关注跟踪误差、规模与流动性、折溢价、成分股调整与分红处理。跨境 ETF 还受额度和时差影响，溢价可能长期存在。',
    rules: ['看折溢价与成交额，不只看涨跌幅', '跨境 ETF 注意溢价风险'],
    wrong: ['ETF 一定比主动基金好', '把折价当无风险套利'],
    related: ['nav'],
    indicators: ['etf_overview'],
    lessons: ['fund-basics'],
  },
  {
    id: 'compound', name: '复利', aliases: ['复利', 'compound', '利滚利'],
    category: 'personal',
    beginner: '赚到的钱继续投进去，下一轮连本带利一起赚，这就是复利。时间越长，效果越明显。',
    intermediate: 'FV = PV×(1+r)^n。年化收益率 r 与期限 n 同样重要；费用与通胀会显著侵蚀长期结果。',
    advanced: '连续复利 FV = PV·e^(rt)；实际收益应用 (1+名义)/(1+通胀)−1。长期收益对尾部年份高度敏感（序列风险），定投的时点分布会改变结果。',
    formula: 'FV = PV × (1 + r)^n；实际收益率 = (1+名义)/(1+通胀) − 1',
    rules: ['区分年有效收益率与名义利率', '扣除费用与通胀后再比较'],
    wrong: ['把 8% 年化直接除以 12 当月利率', '忽略费用与通胀'],
    related: ['cagr', 'xirr'],
    indicators: ['compound_calculate'],
    lessons: ['risk-metrics'],
  },
  {
    id: 'cagr', name: '年化复合增长率（CAGR）', aliases: ['CAGR', '年化收益', '复合增长率', 'cagr'],
    category: 'personal',
    beginner: '把一段时间的总涨跌，换算成「平均每年增长多少」，方便比较不同期限的投资。',
    intermediate: 'CAGR = (期末/期初)^(1/年数) − 1。它假定中间没有资金进出，有申赎时不能用 CAGR 代表个人收益。',
    advanced: 'CAGR 只依赖首尾值，会隐藏中间波动与路径；对期初值敏感。有现金流时应使用 XIRR（资金加权）或 TWR（时间加权），并说明选择理由。',
    formula: 'CAGR = (期末价值 ÷ 期初价值)^(1/n) − 1',
    rules: ['无现金流时才可直接用', '有申赎用 XIRR/TWR'],
    wrong: ['把 CAGR 当个人账户收益', '用 CAGR 比较有定投的账户'],
    related: ['compound', 'xirr'],
    indicators: ['cagr'],
  },
  {
    id: 'xirr', name: 'XIRR（资金加权收益率）', aliases: ['XIRR', 'IRR', '内部收益率', '资金加权'],
    category: 'personal',
    beginner: '考虑你每一笔钱是什么时候投进去的，算出一个「年化收益率」，定投账户最适合用它。',
    intermediate: 'XIRR 求解使各期现金流净现值为 0 的年化利率。对定投/追加/取出的账户比 CAGR 更准确。',
    advanced: 'NPV(r)=Σ CF_i/(1+r)^(t_i/365)=0。现金流多次变号时可能存在多个解，必须检测并说明；无解时不能给唯一数字。它假设现金流按该利率再投资。',
    formula: 'Σ CF_i ÷ (1 + r)^(t_i/365) = 0，解 r',
    rules: ['先检查现金流是否只有一次变号', '多解/无解要明确说明，不硬报一个数'],
    wrong: ['把 XIRR 当成保证收益率', '多解时随便取一个'],
    related: ['twr', 'cagr'],
    indicators: ['xirr'],
  },
  {
    id: 'twr', name: 'TWR（时间加权收益率）', aliases: ['TWR', '时间加权收益率', '时间加权'],
    category: 'personal',
    beginner: '排除「什么时候加钱」的影响，只看投资本身表现好不好的收益率。',
    intermediate: 'TWR 按每个现金流节点把区间收益连乘，衡量策略表现；需要每个节点的组合市值才能算。',
    advanced: 'r_i = (V_i − CF_i)/V_{i−1} − 1，TWR = Π(1+r_i) − 1。缺少逐期估值时无法计算，不能用总资产增长率替代。与 XIRR 的差别在于是否受现金流时点影响。',
    formula: 'TWR = Π(1 + r_i) − 1，r_i = (V_i − CF_i) / V_{i−1} − 1',
    rules: ['需要逐期估值', '与 XIRR 不能互相替代'],
    wrong: ['用总资产增长率冒充 TWR', '没有估值也给 TWR'],
    related: ['xirr'],
    indicators: ['twr'],
  },
  {
    id: 'gdp', name: 'GDP（国内生产总值）', aliases: ['GDP', '国内生产总值', 'gdp'],
    category: 'macro-cn',
    beginner: '一个国家一年（或一个季度）生产的所有最终商品和服务的价值，衡量经济总量有多大、增长有多快。',
    intermediate: '中国季度 GDP 常用同比增速，也有环比与累计同比。看增速要看基数效应：两年平均增速能剔除疫情等基数扰动。',
    advanced: '支出法 GDP = 消费 + 投资 + 净出口；生产法按行业增加值加总。同比受基数影响，环比需季调。GDP 是流量指标，与资产价格之间没有稳定的一一对应关系。',
    rules: ['同比、环比、累计同比是三种口径，不能混用', '看两年平均或季调环比可减少基数干扰'],
    wrong: ['把累计同比当单季同比', 'GDP 增速高就必然股市涨'],
    related: ['cpi', 'ppi', 'pmi'],
    indicators: ['gdp'],
  },
  {
    id: 'cpi', name: 'CPI（居民消费价格指数）', aliases: ['CPI', '居民消费价格指数', 'cpi'],
    category: 'macro-cn',
    beginner: '衡量日常消费品和服务价格涨了多少，也就是「通胀」的主要指标。',
    intermediate: '中国 CPI 同比是同比涨幅；核心 CPI 剔除食品和能源，更能反映需求。CPI 与 PPI 的剪刀差影响中下游利润分配。',
    advanced: 'CPI 是一篮子商品的加权价格指数，权重调整与基期变化会影响可比性。通胀影响实际利率：实际利率 ≈ 名义利率 − 通胀预期。需求弱时 CPI 低不必然是好事。',
    rules: ['同比是涨幅，不是价格水平', '核心 CPI 剔除食品能源'],
    wrong: ['CPI 下降就是通缩（要看是否持续为负）', '用 CPI 直接判断货币政策'],
    related: ['ppi', 'gdp'],
    indicators: ['cpi'],
  },
  {
    id: 'ppi', name: 'PPI（工业生产者出厂价格指数）', aliases: ['PPI', '工业生产者出厂价格', 'ppi'],
    category: 'macro-cn',
    beginner: '工厂卖货的价格涨跌，反映上游工业品的价格压力。',
    intermediate: 'PPI 同比上行往往对应上游利润改善、中下游成本压力；PPI 与 CPI 的剪刀差决定利润在产业链中的分配。',
    advanced: 'PPI 受大宗商品价格与基数影响大，波动高于 CPI。PPI 向 CPI 传导并不完全（需求、竞争格局、管制价格都会阻断）。分析企业毛利要结合产能利用率与库存周期。',
    rules: ['同比是涨跌幅', '关注 PPI-CPI 剪刀差与传导条件'],
    wrong: ['PPI 涨就一定通胀（需看能否传导）', '把 PPI 当企业利润'],
    related: ['cpi', 'gdp'],
    indicators: ['ppi'],
  },
  {
    id: 'pmi', name: 'PMI（采购经理指数）', aliases: ['PMI', '采购经理指数', 'pmi', '制造业PMI'],
    category: 'macro-cn',
    beginner: '问企业采购经理「这个月比上月好还是差」，50 是分界线：高于 50 表示扩张，低于 50 表示收缩。',
    intermediate: 'PMI 是环比扩散指数（与上月比），不是同比。新订单、生产、库存、出厂价格等分项能提前反映需求与价格的变化。',
    advanced: '扩散指数 = 上升企业占比 + 0.5×持平占比。PMI 是环比指标，与同比经济数据不能直接对应；季调方法与样本变化会影响读数。新出口订单分项对外需更敏感。',
    rules: ['PMI 是环比扩散指数，不是同比增速', '50 是荣枯线，读数方向比绝对值更重要'],
    wrong: ['把 PMI 当同比增速', 'PMI 高于 50 就代表经济强（要看分项与基数）'],
    related: ['gdp', 'ppi'],
    indicators: ['pmi'],
  },
  {
    id: 'm1', name: 'M1（狭义货币）', aliases: ['M1', '狭义货币', 'm1'],
    category: 'macro-cn',
    beginner: '流通中的现金 + 企业活期存款，代表「随时能花的钱」，活跃度高说明企业和居民更愿意交易与投资。',
    intermediate: 'M1 增速回升常被视为经济活性改善的信号；M1 与 M2 的剪刀差反映资金是「活化」还是「沉淀」。',
    advanced: '2024 年起中国 M1 口径调整（纳入个人活期存款、非银支付机构备付金），历史序列可比性受影响，跨口径比较需谨慎。M1 受地产销售、财政投放与企业预期共同影响。',
    rules: ['注意统计口径调整导致的历史不可比', 'M1-M2 剪刀差比单看 M1 更有信息量'],
    wrong: ['M1 增速高就必然股市涨', '忽略口径调整直接对比历史'],
    related: ['m2', 'social-financing'],
    indicators: ['money_supply'],
  },
  {
    id: 'm2', name: 'M2（广义货币）', aliases: ['M2', '广义货币', 'm2'],
    category: 'macro-cn',
    beginner: 'M1 加上定期存款、储蓄存款等，代表经济中「钱的总量」的一个广义口径。',
    intermediate: 'M2 增速与名义 GDP 增速的缺口常被用来观察货币条件是宽松还是偏紧；M2 增速也受信贷与财政投放影响。',
    advanced: 'M2 = 基础货币 × 货币乘数，受信贷需求、准备金、财政存款变动影响。仅看 M2 增速不足以判断宽松程度，需结合社融结构、利率与信用利差。',
    rules: ['M2 是存量指标，看同比增速', '与社融、利率一起判断货币条件'],
    wrong: ['M2 高就是放水', '用 M2 单指标判断股市'],
    related: ['m1', 'social-financing'],
    indicators: ['money_supply'],
  },
  {
    id: 'social-financing', name: '社会融资规模（社融）', aliases: ['社融', '社会融资规模', '社融存量', '社融增量', 'social_financing'],
    category: 'macro-cn',
    beginner: '实体经济从金融体系拿到的钱的总和，包括贷款、债券、股票融资等。可以理解为「整个经济借到了多少钱」。',
    intermediate: '社融有「增量」（当月/当年新增）与「存量」（累计余额）两种口径。常见误读是用存量同比增速去解释单月新增的波动。结构上要看企业中长期贷款、政府债券与表外融资。',
    advanced: '社融存量同比是信用扩张的速度，增量是当期流量；两者不能互换。政府债券发行节奏会显著扰动单月增量。分析信用周期应看社融存量同比与结构（居民/企业/政府），并结合贷款利率与信用利差。',
    rules: ['增量（流量）≠ 存量（余额），不能混用', '看结构：居民/企业/政府，短期/中长期', '政府债发行节奏会扰动单月增量'],
    wrong: ['用社融存量增速解释单月新增', '社融好就代表经济马上好转（要看资金去向）'],
    related: ['m2', 'lpr'],
    indicators: ['social_financing'],
  },
  {
    id: 'lpr', name: 'LPR（贷款市场报价利率）', aliases: ['LPR', '贷款市场报价利率', 'lpr'],
    category: 'macro-cn',
    beginner: '银行给最优质客户的贷款利率基准，分 1 年期和 5 年期以上，房贷多参考 5 年期。',
    intermediate: 'LPR = 中期借贷便利（MLF，现为公开市场操作）利率 + 银行加点。LPR 下调通常降低实体融资成本，但传导到房贷与消费贷需要时间。',
    advanced: 'LPR 是报价行在公开市场操作利率基础上加点形成，1Y 与 5Y+ 的调整幅度差异体现对实体与地产的差异化意图。实际融资成本还取决于信用利差与贷款结构，不能只看 LPR。',
    rules: ['区分 1 年期与 5 年期以上', 'LPR 下调 ≠ 所有贷款利率同步下调'],
    wrong: ['把 LPR 当实际房贷利率', 'LPR 下调就认为股市必涨'],
    related: ['social-financing'],
    indicators: ['lpr'],
  },
  {
    id: 'special-bond', name: '专项债', aliases: ['专项债', '地方政府专项债券', 'special_bond'],
    category: 'macro-cn',
    beginner: '地方政府为特定项目（基建、产业园等）发行的债券，是稳投资的重要资金来源。',
    intermediate: '专项债需要对应有收益的项目，与一般债（公共预算）不同。发行节奏与项目落地速度决定它对基建投资的拉动何时体现。',
    advanced: '专项债不计入赤字，但计入政府性基金预算与债务限额。分析其对经济的影响要看：发行规模、投向（传统基建/新基建/化债）、用作项目资本金的比例，以及配套融资是否跟进。',
    rules: ['专项债 ≠ 一般债，用途与预算科目不同', '从发行到形成实物工作量有时滞'],
    wrong: ['专项债发行就立刻拉动 GDP', '把专项债当财政赤字'],
    related: ['fiscal-deficit', 'social-financing'],
    indicators: ['special_bond'],
  },
  {
    id: 'fiscal-deficit', name: '财政赤字', aliases: ['财政赤字', '赤字率', 'fiscal_deficit'],
    category: 'macro-cn',
    beginner: '政府一年花的钱比收的钱多出来的部分。赤字率 = 赤字 ÷ GDP，用来衡量财政扩张的力度。',
    intermediate: '中国的赤字率通常指一般公共预算口径；专项债、特别国债不完全计入赤字，所以「广义财政」力度要看更多口径。',
    advanced: '赤字率 = (一般公共预算支出 − 收入) ÷ GDP。分析财政力度应综合：赤字率、专项债额度、特别国债、政策性金融工具，以及财政存款变化与支出进度。口径不同不可直接跨国比较。',
    rules: ['明确是哪种口径（一般公共预算/广义）', '赤字率是比率，不能与赤字体量混用'],
    wrong: ['赤字率高就一定会通胀', '把专项债算进赤字率'],
    related: ['special-bond'],
    indicators: ['fiscal_deficit'],
  },
  {
    id: 'volume', name: '成交量与成交额', aliases: ['成交量', '成交额', 'volume', 'amount'],
    category: 'market',
    beginner: '一段时间内买卖成交了多少股（成交量）或多少钱（成交额）。量大通常说明关注度高。',
    intermediate: '成交量要结合价格位置看：上涨放量、下跌缩量是常见描述，但不构成稳定规律。成交额比成交量更可比（避免股价差异）。',
    advanced: '量价关系是对交易行为的描述，不是因果规律。换手率 = 成交量 ÷ 流通股本，可跨股票比较活跃度。极端放量常伴随事件驱动，需结合公告与资金流判断。',
    rules: ['成交量看股数，成交额看金额；跨股票比较用换手率', '量价关系不是稳定规律'],
    wrong: ['放量就一定会涨', '用成交量直接比较不同价格的股票'],
    related: ['turnover'],
    indicators: ['volume', 'amount'],
  },
  {
    id: 'turnover', name: '换手率', aliases: ['换手率', 'turnover_rate'],
    category: 'market',
    beginner: '一只股票在一段时间内被买卖了多少比例，反映它有多「活跃」。',
    intermediate: '换手率 = 成交量 ÷ 流通股本。小盘股换手率天然更高；持续高换手可能意味着筹码分散、波动加大。',
    advanced: '换手率需与自由流通市值、涨跌幅、资金结构结合。指数成分调整、解禁、ETF 申赎都会影响换手。高换手不等于高流动性（冲击成本仍可能很高）。',
    formula: '换手率 = 成交量 ÷ 流通股本 × 100%',
    rules: ['小盘股与大盘股不可直接比', '高换手不等于流动性好'],
    wrong: ['换手率高就是资金看好', '把换手率当估值指标'],
    related: ['volume'],
    indicators: ['turnover_rate'],
  },
  {
    id: 'max-drawdown', name: '最大回撤', aliases: ['最大回撤', '回撤', 'max_drawdown'],
    category: 'market',
    beginner: '从最高点跌到最低点的最大幅度，衡量「最难受的时候会亏多少」。',
    intermediate: '最大回撤 = max(峰值 − 谷值)/峰值。它依赖样本区间，区间越长通常回撤越大；要与波动率、恢复时间一起看。',
    advanced: '回撤是路径指标，受起止点选择影响；可配合 Calmar（年化收益/最大回撤）衡量性价比。历史最大回撤不能作为未来风险上限，需做压力情景。',
    formula: 'MaxDD = max_t (峰值_t − 净值_t) ÷ 峰值_t',
    rules: ['必须说明样本区间', '回撤是历史值，不是未来上限'],
    wrong: ['用历史最大回撤当风险保证', '只看回撤不看恢复时间'],
    related: ['volatility'],
    indicators: ['max_drawdown_1y'],
    lessons: ['risk-metrics'],
  },
  {
    id: 'volatility', name: '波动率', aliases: ['波动率', 'volatility', 'volatility_annual'],
    category: 'market',
    beginner: '价格上下起伏的剧烈程度。波动越大，短期盈亏的落差越大。',
    intermediate: '常用收益率的年化标准差表示。历史波动率不是未来波动，波动率有聚集性（大波动后往往还有大波动）。',
    advanced: '年化波动率 = 日收益率标准差 × √252。也可用 EWMA/GARCH 建模；隐含波动率来自期权价格。波动率不区分上行与下行风险，需配合偏度与回撤。',
    formula: '年化波动率 ≈ 日收益率标准差 × √252',
    rules: ['说明频率与年化方式', '波动率不等于风险的全部'],
    wrong: ['波动率低就是安全', '把历史波动率当预测'],
    related: ['max-drawdown'],
    indicators: ['volatility_annual'],
    lessons: ['risk-metrics'],
  },
  {
    id: 'nonfarm', name: '美国非农就业', aliases: ['非农', '非农就业', 'nonfarm', 'NFP'],
    category: 'global',
    beginner: '美国每月新增的非农就业人数，是判断美国经济冷热最重要的数据之一。',
    intermediate: '非农强 → 经济韧性强，但也可能推迟降息、推高美债收益率与美元；对新兴市场与黄金偏不利（需看当时主导逻辑）。',
    advanced: '非农包含企业调查（新增就业）与家庭调查（失业率），两者可能背离；前值常被大幅修正。市场反应取决于「相对预期」与「政策反应函数」，不能只看绝对值。',
    rules: ['关注相对预期的偏离与修正值', '同一数据在不同周期对资产的含义可能相反'],
    wrong: ['非农好就一定利好股市', '只看初值不看修正'],
    related: ['fed', 'real-rate'],
    indicators: ['nonfarm'],
  },
  {
    id: 'fed', name: '美联储（Fed）', aliases: ['美联储', 'Fed', 'FOMC', 'fed'],
    category: 'global',
    beginner: '美国的中央银行，通过调整利率影响全球资金成本。它一加息，全世界的钱都会更贵。',
    intermediate: '美联储通过政策利率、缩表/扩表与前瞻指引影响美债收益率、美元与全球流动性；对人民币资产的影响通过汇率与风险偏好传导。',
    advanced: 'FOMC 决议包含利率、点阵图与声明措辞。市场定价看 OIS/联邦基金期货隐含路径。传导链条：美债实际利率 → 美元 → 新兴市场资本流动 → 风险资产估值，但每一步都可能被国内政策对冲。',
    rules: ['区分「已实现」与「市场预期」', '对 A 股/港股的影响是条件性的，不是必然'],
    wrong: ['美联储降息 → A 股必涨', '把点阵图当承诺'],
    related: ['real-rate', 'usd-index', 'nonfarm'],
    indicators: ['fed'],
  },
  {
    id: 'real-rate', name: '实际利率', aliases: ['实际利率', 'real_rate', '实际收益率'],
    category: 'global',
    beginner: '名义利率扣掉通胀后剩下的「真实」回报。实际利率高，持有黄金这类不生息资产的机会成本就高。',
    intermediate: '实际利率 ≈ 名义利率 − 通胀预期。常用美国 10 年期 TIPS 收益率代表。它是黄金定价的重要锚之一，但不是唯一因素。',
    advanced: 'Fisher 方程：(1+名义) = (1+实际)(1+通胀预期)。TIPS 收益率反映市场定价的实际利率；黄金与实际利率的负相关在部分阶段会失效（央行购金、避险需求）。',
    formula: '实际利率 ≈ 名义利率 − 通胀预期',
    rules: ['区分事前（预期）与事后实际利率', '相关关系不稳定，不是因果'],
    wrong: ['实际利率跌黄金必涨', '用名义利率代替实际利率'],
    related: ['fed', 'gold'],
    indicators: ['real_rate'],
  },
  {
    id: 'usd-index', name: '美元指数', aliases: ['美元指数', 'DXY', 'dollar_index'],
    category: 'global',
    beginner: '美元相对一篮子主要货币的强弱。美元走强时，以美元计价的大宗商品通常更贵、对新兴市场资金面偏紧。',
    intermediate: 'DXY 主要由欧元、日元、英镑等权重构成，不完全代表美元对人民币的强弱；人民币汇率还受国内经济与政策影响。',
    advanced: 'DXY 权重中欧元占比较高，因此欧债/欧洲央行政策会显著影响读数。分析对人民币资产的传导应看美元兑人民币中间价、CFETS 篮子与中美利差。',
    rules: ['DXY ≠ 美元兑人民币', '传导需经汇率与资本流动'],
    wrong: ['美元涨人民币必跌', '把 DXY 当唯一汇率指标'],
    related: ['cny', 'real-rate'],
    indicators: ['usd_index'],
  },
  {
    id: 'cny', name: '人民币汇率', aliases: ['人民币汇率', '美元兑人民币', 'USDCNY', 'cny'],
    category: 'global',
    beginner: '人民币能换多少美元。数字变大表示人民币贬值（同样的人民币换更少美元）。',
    intermediate: '看中间价、在岸价（CNY）与离岸价（CNH）。汇率影响出口竞争力、外资流入与进口成本，也是货币政策的空间约束。',
    advanced: '中间价包含「收盘价 + 一篮子货币 + 逆周期因子」；CNH 与 CNY 价差反映离岸预期。汇率传导到资产价格是条件性的：贬值可能利好出口、利空外资重仓与美元债主体。',
    rules: ['区分中间价/在岸/离岸', '升贬值方向不要搞反（数字变大=贬值）'],
    wrong: ['人民币贬值一定利空股市', '把离岸价当官方价'],
    related: ['usd-index'],
    indicators: ['usdcny'],
  },
  {
    id: 'gold', name: '黄金', aliases: ['黄金', 'gold', 'XAU'],
    category: 'global',
    beginner: '不生息但抗通胀、避险的资产。它不产生现金流，所以价格主要取决于「别人愿意付多少」。',
    intermediate: '黄金定价因素：实际利率、美元、央行购金、避险需求与通胀预期。黄金适合作为组合的风险分散资产，但波动不小。',
    advanced: '黄金没有现金流，无法用 DCF 估值；常用实际利率框架与供需框架。它与其他资产的相关性随阶段变化，危机时期可能与其他风险资产同时下跌（流动性挤兑）。',
    rules: ['不用估值模型，用宏驱动与供需分析', '相关性不稳定，不宜固定配置比例'],
    wrong: ['黄金必抗通胀（短期可能跑输）', '把黄金当无风险资产'],
    related: ['real-rate', 'usd-index'],
    indicators: ['gold'],
  },
  {
    id: 'asset-allocation', name: '资产配置', aliases: ['资产配置', '配置', 'allocation'],
    category: 'personal',
    beginner: '把资金分配到不同类型的资产上（股票、债券、现金、黄金等），目标是让整体风险与目标匹配，而不是押注单一品种。',
    intermediate: '核心是风险预算：不同资产的相关性决定组合整体波动。再平衡把偏离的权重拉回目标，是一种纪律而非预测。',
    advanced: '均值方差、风险平价与 Black-Litterman 是常见框架，但都依赖输入假设（预期收益、相关性）的稳定性。相关性在危机中会上升，历史相关性不能当作稳定因果。',
    rules: ['说明风险预算与再平衡规则', '相关性是历史统计，不是保证'],
    wrong: ['分散就是买很多只（可能高度重叠）', '用历史相关性预测危机时的相关性'],
    related: ['rebalance', 'position'],
    indicators: ['allocation'],
    lessons: ['risk-metrics'],
  },
  {
    id: 'position', name: '仓位', aliases: ['仓位', 'position', '持仓比例'],
    category: 'personal',
    beginner: '你投入某个资产的资金占全部资金的比例。仓位过高，一次大跌就能伤到本金。',
    intermediate: '仓位决定风险暴露：同样的资产，仓位翻倍风险翻倍。仓位管理应与最大可承受回撤、投资期限、现金流需求匹配。',
    advanced: '可用波动率目标、Kelly 分数或风险预算确定仓位；Kelly 依赖胜率与赔率估计，实务中通常取分数 Kelly。集中度指标（HHI、前三大权重）比单看数量更能反映风险。',
    rules: ['仓位与最大回撤承受力匹配', '集中度用 HHI/前三大权重衡量'],
    wrong: ['满仓就是看多', '看数量判断分散度'],
    related: ['asset-allocation', 'rebalance'],
    indicators: ['weight'],
    lessons: ['risk-metrics'],
  },
  {
    id: 'rebalance', name: '再平衡', aliases: ['再平衡', 'rebalance'],
    category: 'personal',
    beginner: '当某类资产涨太多、占比超标时，卖掉一点、补到落后的资产，让组合回到原定比例。',
    intermediate: '再平衡有定期（按季度/年）与阈值（偏离 ±5%）两种触发方式。它会卖出涨得多的、买入跌得多的，属于纪律性操作。',
    advanced: '再平衡收益来自波动与均值回复，但在单边趋势中会拖累收益。需考虑税费、交易成本与再平衡区间宽度。任何再平衡在本插件中**只做模拟**，不执行真实交易。',
    rules: ['明确触发规则（时间/阈值）', '本插件只模拟，不执行'],
    wrong: ['把模拟再平衡当已执行交易', '频繁再平衡忽略交易成本'],
    related: ['asset-allocation', 'position'],
    indicators: ['rebalance'],
  },
]

export const CONCEPTS: FinancialConcept[] = SEEDS.map((seed) => ({
  conceptId: seed.id,
  name: seed.name,
  aliases: seed.aliases ?? [],
  category: seed.category,
  beginner: seed.beginner,
  intermediate: seed.intermediate,
  advanced: seed.advanced,
  ...(seed.formula ? { formula: seed.formula } : {}),
  interpretationRules: seed.rules,
  misconceptions: seed.wrong,
  relatedConcepts: seed.related ?? [],
  relatedIndicators: seed.indicators ?? [],
  referenceSources: ['国家统计局统计口径说明', '中国人民银行公开报告', '金融机构公开披露与会计准则'],
  ...(seed.lessons ? { relatedLessons: seed.lessons } : {}),
  contentVersion: 'concepts/1',
  lastVerifiedAt: '2026-11-16',
}))

const byId = new Map(CONCEPTS.map((c) => [c.conceptId, c]))
const normalized = new Map<string, string>()
for (const concept of CONCEPTS) {
  normalized.set(concept.name.toLowerCase(), concept.conceptId)
  normalized.set(concept.name.replace(/[（）()]/g, '').toLowerCase(), concept.conceptId)
  for (const alias of concept.aliases) normalized.set(alias.toLowerCase(), concept.conceptId)
}

export function findConcept(idOrAlias: string): FinancialConcept | undefined {
  const key = String(idOrAlias ?? '').trim().toLowerCase()
  if (!key) return undefined
  const direct = byId.get(idOrAlias)
  if (direct) return direct
  const mapped = normalized.get(key)
  if (mapped) return byId.get(mapped)
  const loose = CONCEPTS.find((c) => c.name.toLowerCase().includes(key) || c.aliases.some((a) => a.toLowerCase() === key))
  return loose
}

export function searchConcepts(query: string, opts: { category?: ConceptCategory; limit?: number } = {}): FinancialConcept[] {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 12))
  const q = String(query ?? '').trim().toLowerCase()
  const pool = opts.category ? CONCEPTS.filter((c) => c.category === opts.category) : CONCEPTS
  if (!q) return pool.slice(0, limit)
  return pool.filter((c) =>
    c.name.toLowerCase().includes(q)
    || c.aliases.some((a) => a.toLowerCase().includes(q))
    || c.beginner.includes(q)
    || c.intermediate.includes(q)
    || c.advanced.includes(q),
  ).slice(0, limit)
}

/** 从自由文本里挑出已知概念（用于「自动识别术语」与面板解释入口）。 */
export function detectConcepts(text: string, limit = 5): FinancialConcept[] {
  const haystack = String(text ?? '')
  const hits: Array<{ concept: FinancialConcept; at: number }> = []
  for (const concept of CONCEPTS) {
    const needles = [concept.name, ...concept.aliases]
    let best = -1
    for (const needle of needles) {
      const at = haystack.indexOf(needle)
      if (at >= 0 && (best < 0 || at < best)) best = at
    }
    if (best >= 0) hits.push({ concept, at: best })
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, limit).map((h) => h.concept)
}
