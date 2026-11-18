# 多持仓组合策略产品竞品调研：构建、风险与再平衡

- 调研/访问日期：**2026-11-17（Asia/Shanghai）**。所有下列来源均于此日访问；价格、套餐和条款可能变化。
- 目标：研究**多持仓综合策略**如何表达资产池、目标权重、组合约束、市场变化触发、回测与人工审批；不是单只股票打分，也不是实现自动实盘。
- 范围：QuantConnect/LEAN 的组合构建与风险框架；Composer 的组合规则；Portfolio Visualizer（PV）的 tactical allocation / optimization。只使用公开官方正文和官方 GitHub，不登录账户、不读取私有持仓、不调用交易接口。
- 标记：**已核验**＝本轮读到实际正文/源码；**推导**＝据已核验事实提出的产品判断，不等于竞品自述；**未验证**＝未拿到证据，不能解释为不存在。未运行付费功能、未实测回测结果或下单。

## 1. 结论先行

1. **组合策略至少要拆成五层：资产池 → 信号 → 目标权重 → 组合风险覆盖 → 再平衡候选。** LEAN 公开源码将组合目标、风险覆盖和执行分开，Composer 用可嵌套的资产/权重/条件/过滤/分组表达组合，PV 将 tactical 信号与 optimization 目标分别建模。我们应学习这种结构，而不是把“多只单股建议”相加当组合策略。[Q1]、[Q2]、[C1]、[P1]、[P2]（访问：2026-11-17）
2. **市场/国际变化需要变成有时间戳、可验证、可失效的组合输入。** 已核验的 Composer/PV 示例主要是价格、动量、波动、估值和跨资产代理信号；它们不能证明具备“自动读国际新闻并可靠调整整个组合”的能力。对本产品应分开“外部事件证据”“可计算指标”“纸面方案”，新闻首先触发复核，不直接触发交易。前半为事实范围，后半为产品推导。[C1]、[P1]、[P4]（访问：2026-11-17）
3. **最应借鉴的是可解释规则、组合级约束、延迟执行假设和滚动验证；最不应照搬的是授权后按策略自动实盘。** Composer 正文明确投资 symphony 后自动交易，LEAN 调用链会把风险调整后目标交给执行模型；两者均不能被当作“每次人工审批”的证据。PV 本轮材料是研究模拟工具，也不能倒推出其提供交易审批系统。[C3]、[Q1]、[P7]（访问：2026-11-17）
4. **许可是产品边界，不是脚注。** LEAN 的 Apache-2.0 开源许可不覆盖 QuantConnect 云服务、数据或网站内容；QC 网站条款对竞品分析/竞品构建及数据导出有明确限制。研究发现该限制后停止继续抓取 QC 网站，技术结论以公开 LEAN GitHub 为主；采购/复用前需法务确认，不能把“能访问”解释为“能复制或集成”。[Q6]、[Q8]（访问：2026-11-17）

## 2. 中文竞品矩阵

> 每格的证据编号链接到第 6 节实际 URL；该节逐项列访问日期。审批列严格区分“用户选择策略/投入资金”“规则权限”“每次调仓审批”，三者不能混用。

| 维度 | QuantConnect / 官方开源 LEAN | Composer | Portfolio Visualizer tactical / optimization |
|---|---|---|---|
| 产品工作单元 | **已核验**：UniverseSelection、Alpha/Insight、PortfolioConstruction、RiskManagement、Execution 是分立组件；组合构建先产出目标，风控返回覆盖目标，再交执行模型。[Q1] | **已核验**：Symphony 是持有什么、多少、何时持有的规则；资产、权重、条件、过滤、分组可嵌套，既可表达股债多资产组合，也可表达 risk-on/off 轮动。[C1] | **已核验**：Tactical 测试配置随信号变化的组合；Optimization 在指定历史区间求权重；Rolling Optimization 在每期起点按过去窗口重新优化。三者不是同一个工作流。[P1]、[P2]、[P3] |
| 资产池 | **已核验**：代码支持独立 universe 选择和刷新，组合构建处理仍在资产池中的活跃 Insight，每代码取最新活跃 Insight。云价格页列股票、外汇、期权、期货、加密等资产类别，但不能据此认定每市场/每数据集均有免费覆盖；A股、国内场外基金具体覆盖**未验证**。[Q1]、[Q2]、[Q7] | **已核验**：创建教程列股票、ETF、加密货币，可按名称/ticker 搜索，也有筛选器；逆波动仅支持股票/ETF，市值权重仅股票。不能把该列表扩展成全球全市场或中国基金覆盖。[C1]、[C2] | **已核验**：资产类别或 ticker 组合；文档明确基金、ETF、股票，也可导入自定义收益序列和 benchmark。免费/付费资产数上限见价格部分；A股与中国场外基金数据范围**未验证**。[P2]、[P3]、[P4]、[P5] |
| 权重生成 | **已核验**：等权模型给合格非 Flat 信号 1/N，并按方向生成多/空；均值方差模型使用收益矩阵和可替换优化器，默认最小方差优化，支持多头/空头/多空偏置。不是“所有模型默认禁止做空”。[Q3]、[Q4] | **已核验**：等权、指定百分比/分数、逆波动、市值四类；层级权重能表达“股60%/债40%，股内再等权”。逆波动是 1/收益标准差归一化，**不是**使用协方差的风险平价。[C1]、[C2] | **已核验**：静态优化含均值方差、CVaR、风险平价、跟踪误差、信息比率、Kelly、Sortino、Omega、最大回撤；tactical 相对强弱可等权，adaptive 可风险平价或最小方差，目标波动可缩放风险资产与现金。[P1]、[P2]、[P4] |
| 组合约束/风控 | **已核验**：多空偏置、优化器边界等由具体模型承担；独立组合回撤模型可相对起始净值或高水位判断，触发后取消对应 Insight、返回零目标。示例不等于保证损失封顶；通用行业/币种/穿透集中度约束 UI **未验证**。[Q4]、[Q5] | **已核验**：块类型兼容限制；条件可比较指标与指标/固定值，Any/All 可嵌套，过滤器支持排序后选数量。跨全部 symphony 的硬性行业上限、HHI 上限、穿透重叠约束或一般约束求解器**未验证**。[C1]、[C2] | **已核验**：静态优化单资产最小/最大权重、A—F 组最小/最大权重，可设收益/波动/跟踪误差/CVaR 等目标；tactical 页面含资产/组合级 stop-loss、离场资产与目标波动。不是所有约束在所有模型通用。[P1]、[P2] |
| 变化触发/再平衡 | **已核验**：组合基类支持自定义再平衡函数、时间间隔/日期规则；资产池变化、新 Insight 或过期可触发（两个变化开关默认 true）。若未设置再平衡函数，基类会直接视为到期；不能误写成“默认只按日历触发”。[Q2]、[Q3] | **已核验**：频率从 daily 到 yearly；执行时重新遍历逻辑并更新目标配置，已投资时自动卖超配/买低配。修改逻辑会在下一次计划交易时执行。漂移阈值型再平衡的具体公式、冷却期**未验证**。[C1]、[C3] | **已核验**：Tactical 可按信号、周/月/双月/季度交易，另有月/季/半年/年再平衡选项；rolling 优化频率月/季/年、回看12—60个月。文档另确认普通组合回测支持日历和偏离带，不能把普通回测所有选项自动归给每种 tactical 模型。[P1]、[P3]、[P4] |
| 行情/市场/国际变化 | **已核验**：框架允许上游模型产生 Insight 并触发重算；本轮源码不能证明内置新闻理解、宏观事件到组合的成品闭环。相关模块/数据覆盖**未验证**。[Q1]、[Q2] | **已核验**：官方示例用 BND 相对 BIL 的60交易日收益作市场风险代理，再以90日动量择资产；Any/All 支持多条件。直接使用国际新闻/政策原文/宏观修订值驱动组合的支持**未验证**。[C1] | **已核验**：均线、相对/绝对动量、Shiller PE、目标波动；可用外部资产作 regime 信号，双动量例子含美股与国际股选择。自然语言国际新闻引擎能力**未验证**。[P1]、[P4] |
| 回测与结果 | **已核验**：云价格页明确免费无限次 backtesting（仍有资源/订单等限额），源码证明同一组合/风控目标链可被引擎使用；本轮未实际跑策略，也未验证具体成交/成本默认参数。[Q1]、[Q7] | **已核验**：历史模拟、benchmark、持仓配置历史；股票/ETF 用日调整收盘价，实盘用交易窗口实时行情，可能得出不同决策。默认滑点1bp可调，订阅费默认不包含；不是实盘收益证明。[C1]、[C4] | **已核验**：组合回测采用月收益，年化波动/Sharpe/Sortino基于月收益，最大回撤基于月末组合余额；tactical 可选期末收盘或下一交易日收盘，明确后者考虑信号不可同时成交；优化页面警告样本内最优不预言样本外。[P2]、[P4] |
| 审批/人工控制 | **已核验**：框架源码自动将风控覆盖后目标送执行，所查链路没有每目标人工确认步骤。云套餐有权限管理不等于调仓审批；其他人工审批模块**未验证**。[Q1]、[Q7] | **已核验**：投资策略后自动执行；Pro 定价页有人工 override：Skip Trading / Go to Cash。该覆盖功能不等于每次调仓审批，更不能推定低套餐也有同等控制。[C3]、[C5] | **已核验范围**：公开材料描述模拟、模型保存和 forward trade signals；本轮未见券商下单/每次审批正文，均标**未验证**，不能只因为导航没有“交易”就断言完全无此能力。[P4]、[P5]、[P7] |
| 价格与套餐边界 | **已核验**：Free 与 Researcher/Team/Trading Firm/Institution 分层，节点、API、团队权限/本地平台等有不同限制；本轮价格正文没有读到可靠美元总价，**具体订阅金额未验证**，不能引用旧博客价格。[Q7] | **已核验**：Starter $0：自动1策略/200节点；Advanced $10/月：最多5策略/350节点；Pro $32/月、按年$384：最多500策略/10,000节点、API、人工覆盖；Business询价、15,000节点。另有监管等费用。此为页面标价非总交易成本。[C5] | **已核验**：Free；Basic $30/月按年计费；Pro $55/月按年计费，Pro标个人和商业，前两档个人/教育。脚注：免费回测最多15资产/有限历史且无当前月MTD；Basic/Pro最多150资产并含YTD和tactical未来交易信号。提取器无法保留功能勾叉，不能因每列出现同一文字就断言免费开放所有功能。[P5] |
| 许可/可复用边界 | **已核验**：LEAN 官方GitHub为Apache-2.0；网站/云/数据另受条款约束。条款限制竞品分析、复制/竞品构建和平台数据外传；不得用开源身份概括整个产品。[Q6]、[Q8] | **已核验范围**：价格页版权保留、券商地域注册与风险披露；Terms页面本次只有标题和公共页脚，**详细软件/API/数据再分发许可未验证**。能分享 symphony 链接不等于允许复制站点、策略代码或批量数据再分发。[C1]、[C5]、[C6] | **已核验**：条款授予有限、不可转让合法使用许可，IP归SRL；Pro商业用途不等于源代码开源或行情转售许可。回测/模拟为假设，不提供投资等建议。[P5]、[P6] |

## 3. 关键机制展开与需要避开的误读

### 3.1 LEAN：学习“组合目标与风控分离”，不把回撤阈值当收益保险

- `ProcessInsights` 的实际顺序为组合构建 `CreateTargets` → 风控 `ManageRisk` → 合并覆盖目标 → `Execution.Execute`。这为本地产品的“候选目标”“风控修改”“最终方案”分别留痕提供参考，但我们应在纸面方案之后设置人工审批，**不连接该自动执行终点**。事实见[Q1]，审批插入是本报告推导。（访问：2026-11-17）
- 再平衡不只由价格变化触发：资产池增删、信号新生/过期、日历函数都是独立事件。应记录本次为什么重算，避免“今天刷新了一次”就默默改变权重。[Q2]、[Q3]（访问：2026-11-17）
- `MaximumDrawdownPercentPortfolio` 默认阈值5%、默认相对起始值，也可 trailing；实现包含 `targets.Length != 0` 条件，触发后对传入目标取消 Insight、返回零目标。**类注释写需手工重启，但方法内又重置初始化状态并注释下期可重投，存在注释/实现语义张力**。因此只确认可核验代码行为，不声称永久停机或覆盖所有未出现在目标中的持仓；也不承诺跳空/流动性冲击时最大损失只有5%。[Q5]（访问：2026-11-17）
- `MeanVarianceOptimizationPortfolioConstructionModel` 的默认 period=63、日频、targetReturn=0.02 是引擎模型参数，不应未经口径转换就对用户宣称“目标年化2%”；优化器可替换，约束需要按具体模型核实。[Q4]（访问：2026-11-17）

### 3.2 Composer：学习可读的组合规则树，不学习“点投入后自动交易”的默认闭环

- 嵌套规则能把“60%股/40%债 → 股内等权 → 条件下切换资产/择Top N”展示出来，便于向用户解释组合权重来自哪里；但任意多层嵌套会扩大过拟合空间，产品应限制深度并展开最终有效权重。前者是事实，限制深度是设计建议。[C1]、[C2]（访问：2026-11-17）
- 官方 trading 正文明确先卖后买、资金不足会拒单/按资金比例缩减，熔断可能延迟；not-held 指令赋予时间与价格裁量。**目标配置不等于可保证成交配置**。我们的纸面方案应列现金缺口、市场交易时段和未定价资产，而不是仅展示漂亮的目标饼图。[C3]（访问：2026-11-17）
- 证据冲突必须保留：2026-09-02更新的 Backtest Basics 仍举“$40 monthly”订阅费估算，当前价格页已展示$0/$10/$32（按年）。因此现价用价格页，回测费估算的旧例只证明成本假设可能陈旧，不能将其当现行订阅金额。[C4]、[C5]（访问：2026-11-17）

### 3.3 PV：学习“信号何时可知”与“样本外”，不把优化权重当预测

- Tactical 的风险信号与实际持有资产可以分离；例如用外部市场代理决定risk-on/off，再在候选池按动量选资产。这适合表达“国际利率/美元/风险偏好变化 → 组合情景复核”，但代理相关性不等于国际事件的因果证明。[P1]、[P4]（访问：2026-11-17）
- 静态 optimizer 基于指定区间月收益统计；官方直接警告不能据此预测区间外最佳配置。Rolling Optimization 则按过去窗口逐期重算，适合作为避免整段未来信息泄漏的研究方式；仍需要独立留出段、参数敏感性和成本压力测试，不能声称滚动优化自动消除过拟合。[P2]、[P3]、[P4]（访问：2026-11-17）
- 普通组合回测的偏离带默认例子为5个百分点绝对偏离或25%相对偏离：60%目标触及65%/55%，10%目标触及12.5%/7.5%。这比“跌了就补仓”更可解释，但这是普通组合回测方法论，不得无证据套到所有 tactical/rolling 模型。[P4]（访问：2026-11-17）
- 目标波动依据历史实现波动调整风险资产比例；文档也提醒急跌后减仓可能错过早期反弹。月末净值计算的最大回撤不能代表完整日内/逐日最大回撤。报告应展示口径而非混用单一“回撤”标签。[P4]（访问：2026-11-17）

## 4. 面向本产品的启示（均为研究推导，不是竞品已具备功能）

### 4.1 应围绕“整个组合”组织输入和输出

| 层级 | 建议的产品表达 | 启示依据与边界 |
|---|---|---|
| 资产池/账户范围 | 显式选择参与策略的多持仓与现金；按市场、资产类型、币种分组；未授权账户不纳入。 | universe与组合分层、分组权重、资产类别/ticker两种模型；不应把三家资产覆盖直接搬到本地。[Q1]、[C1]、[P2]（访问：2026-11-17） |
| 目标与约束 | 先问目标风险与流动性，再给权重；持仓上限、行业/币种/穿透暴露、现金下限、禁止杠杆、最大换手均显式表达；不可行则说明约束冲突，不静默放松。 | PV明确单资产/组约束、LEAN独立风险覆盖；穿透/现金/换手等是我们的建议，非声称竞品全有。[P2]、[Q1]（访问：2026-11-17） |
| 市场/国际变化 | 单独保存事件来源、发布日期、统计期、指标单位、适用市场、支持/反对证据、失效条件；将“利率升高”等叙事拆成可核验事实和条件假设。 | 已核验规则主要依赖可计算信号/代理，未证明三家有全自动国际新闻闭环。[C1]、[P1]、[P4]（访问：2026-11-17） |
| 触发治理 | 区分日历到期、权重漂移、波动/相关性变化、资产池变化、观点失效；记录为何触发、何时可知、数据是否过期、冷却期是否到期。新闻默认只触发复核。 | LEAN事件触发、PV偏离带及滞后成交；冷却/新闻复核为建议。[Q2]、[P4]（访问：2026-11-17） |
| 组合方案比较 | 同时显示“维持现状/原规则/候选方案”；列before/after权重、集中度、重叠、币种、现金、换手、成本、缺行情资产；允许结论为“不变”。 | 分离目标与执行、对照benchmark及静态/滚动比较；HHI和穿透是我们的延伸建议。[Q1]、[C1]、[P2]、[P3]（访问：2026-11-17） |
| 回测证据 | 冻结规则版本、数据截止日和数据可获知时间；区分训练/验证/留出；展示费用、滑点、再平衡频率、下一交易日执行、不同窗口敏感性和缺失。 | Composer实盘/回测价不同，PV明确延迟与样本内限制。[C4]、[P2]、[P4]（访问：2026-11-17） |
| 审批/复核 | 草案 → 纸面模拟 → 风险/数据缺口 → 用户确认观察版本 → 定期复核；策略批准只允许跟踪，不授予真实下单能力。 | 竞品自动执行链是应主动断开的边界；不是复制所谓“竞品审批功能”。[Q1]、[C3]、[P6]（访问：2026-11-17） |

### 4.2 一个符合需求的非实盘示例

**示例仅说明产品结构，不是投资建议，也未使用任何用户持仓。**

1. 用户选择若干股票/基金/ETF与现金作为研究池，给定股票类/单资产/币种上限。
2. 国际事件进入证据层：如某央行决议或通胀发布；未拿到可核验数据时显示“待补证据”，不推导仓位变化。
3. 计算层检查价格趋势、组合实现波动、相关性与当前权重偏离；研究者指定哪些指标只是风险提示、哪些进入预先批准的纸面规则。
4. 若满足复核条件，同时计算“保持原配”“降低组合风险预算”“仅用新增现金再平衡”三个假设；说明约束是否满足与换手代价。
5. 展示新证据支持/削弱什么、方案对整体组合而非单只资产的影响；用户可拒绝/延后/只加入观察。**不自动改持仓、不写真实流水、不发送券商委托。**

此示例由组合目标与风险分层、条件树、tactical/rolling验证机制推导，不声称任何竞品已原样实现。[Q1]、[C1]、[P1]、[P3]（访问：2026-11-17）

### 4.3 明确不该学的东西

- 不把 Composer 的“投入后自动交易”或 LEAN 执行模型接入当作本产品目标；更不因用户批准一版研究规则就获取永久交易授权。[C3]、[Q1]（访问：2026-11-17）
- 不把自然语言新闻情绪映射为立即买卖；本轮没有证据证明这种闭环能可靠解释国际变化。[C1]、[P4]（访问：2026-11-17）
- 不将样本内最优、优化后的高Sharpe或风险阈值说成收益/损失承诺。[P2]、[P4]、[Q5]（访问：2026-11-17）
- 不将逆波动权重冒充风险平价，不将分组命名冒充硬性组约束，不将云权限控制冒充逐笔审批。[C2]、[P2]、[Q7]（访问：2026-11-17）
- 不复制付费策略、站点界面、专有数据或将API可访问等同于有再分发许可；特别区分Apache许可的LEAN源码与QC云站点条款。[Q6]、[Q8]、[C6]、[P6]（访问：2026-11-17）

## 5. 价格、许可与待验证清单

| 项目 | 本轮结论 | 下一步（不是本轮已完成） |
|---|---|---|
| QC云定价精确金额 | **未验证**。只确认分层/节点/功能限制，不能用旧文章补金额。[Q7] | 合规授权后人工向官方确认席位+节点+数据+税费总价，记录计费周期。 |
| QC竞品研究/复用许可 | **高优先边界**。条款2.2、3.3(b)(xiv)含竞品相关限制；2.6限制平台数据离站。发现后停止进一步站点抓取；公开LEAN仓库另有Apache-2.0。[Q8]、[Q6] | 任何集成/代码复用先核实开源文件许可与NOTICE；涉及云、网站或数据单独取得适当授权/法务意见。本报告不是法律意见。 |
| Composer详细ToS/API/数据许可 | **未验证**。该ToS URL本轮只返回标题/页脚，不当作完整许可正文；API付费可用≠准许转售。[C6]、[C5] | 获取公开可读正式协议或官方书面说明；不绕登录、验证码或私有接口。 |
| Composer宏观/新闻输入、全账户硬约束、漂移带 | **未验证**；已验证的是价格/收益/波动条件和层级规则。[C1]、[C2]、[C3] | 取得具体功能正文或公开示例；缺证据时不补“有/没有”。 |
| PV套餐功能勾叉 | 价格与脚注可读，但提取器丢失勾叉样式；只按明确正文/脚注认定，不能把所有列重复文本当权限证据。[P5] | 合规人工查看官方套餐表截图或文字确认具体tactical/optimization/export权限。 |
| PV交易与审批 | **未验证**。资料支持研究模拟/信号，未证明券商执行及审批；不推断绝对不存在。[P4]、[P5]、[P7] | 若需要再询问官方，当前产品不依赖此项。 |
| 国内市场适用性 | 三家对A股、国内公募、T+1、涨跌停、港美股币种及结算的完整覆盖均**未验证**。[Q7]、[C1]、[P4] | 未来用公开数据范围/交易规则文件逐项验收，不能只验证ticker能搜索到。 |

## 6. 官方来源账本（实际正文与访问日期）

> 本文引用编号为下列链接别名。所有访问日期均为**2026-11-17**。GitHub `master` 是浮动引用；以下为访问当时观察，不保证未来实现相同。未保存大段第三方全文，不读取或导出平台市场数据。

### QuantConnect / LEAN

- **[Q1]** [官方LEAN：QCAlgorithm.Framework.cs](https://github.com/QuantConnect/Lean/blob/master/Algorithm/QCAlgorithm.Framework.cs)；读取通道：[官方GitHub Contents API](https://api.github.com/repos/QuantConnect/Lean/contents/Algorithm/QCAlgorithm.Framework.cs)。实际解码正文：`ProcessInsights` 依次调用 `CreateTargets`、`ManageRisk`、`Execution.Execute`；含 universe 创建/刷新逻辑。访问：2026-11-17。
- **[Q2]** [官方LEAN：PortfolioConstructionModel.cs](https://github.com/QuantConnect/Lean/blob/master/Algorithm/Portfolio/PortfolioConstructionModel.cs)；[API正文](https://api.github.com/repos/QuantConnect/Lean/contents/Algorithm/Portfolio/PortfolioConstructionModel.cs)。实际解码类、`GetTargetInsights`、`IsRebalanceDue`；SHA `47d5257c62298b96f066447f93fb9b1bac1cb301`（API返回）。访问：2026-11-17。
- **[Q3]** [官方LEAN：EqualWeightingPortfolioConstructionModel.cs](https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Portfolio/EqualWeightingPortfolioConstructionModel.cs)；[API正文](https://api.github.com/repos/QuantConnect/Lean/contents/Algorithm.Framework/Portfolio/EqualWeightingPortfolioConstructionModel.cs)。实际解码构造参数与 `DetermineTargetPercent`，确认1/N、方向与多空偏置。访问：2026-11-17。
- **[Q4]** [官方LEAN：MeanVarianceOptimizationPortfolioConstructionModel.cs](https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Portfolio/MeanVarianceOptimizationPortfolioConstructionModel.cs)；[API正文](https://api.github.com/repos/QuantConnect/Lean/contents/Algorithm.Framework/Portfolio/MeanVarianceOptimizationPortfolioConstructionModel.cs)。实际解码优化器、边界、历史窗口和参数。访问：2026-11-17。
- **[Q5]** [官方LEAN：MaximumDrawdownPercentPortfolio.cs](https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Risk/MaximumDrawdownPercentPortfolio.cs)；[API正文](https://api.github.com/repos/QuantConnect/Lean/contents/Algorithm.Framework/Risk/MaximumDrawdownPercentPortfolio.cs)。实际解码 `ManageRisk`；注释与初始化重置行为差异已在正文保留。访问：2026-11-17。
- **[Q6]** [LEAN LICENSE](https://github.com/QuantConnect/Lean/blob/master/LICENSE)；[官方License API](https://api.github.com/repos/QuantConnect/Lean/license)。API明确 SPDX `Apache-2.0` 并返回许可全文base64；软件许可不等于数据许可。访问：2026-11-17。
- **[Q7]** [QuantConnect Pricing](https://www.quantconnect.com/pricing)。实际正文包含 Free/Researcher/Team/Firm/Institution 与功能比较、资源上限；未获得可信美元总价。此页面在发现[Q8]限制之前访问，之后不继续站点抓取。访问：2026-11-17。
- **[Q8]** [QuantConnect Terms and Conditions](https://www.quantconnect.com/terms)。实际正文版本1.5、更新2026-10-08：2.2网站使用限制，2.6数据离站限制，3.3(b)(xiv)竞品分析限制；发现后停止继续抓该站。访问：2026-11-17。

### Composer

- **[C1]** [Create a Symphony](https://help.composer.trade/article/54-create-tutorial)。实际正文有 Components、Assets、Weights、Conditionals、Any/All、Filters、Groups、Trading frequency、完整股债组合与Risk On/Risk Off例子；页面更新2026-03-26。访问：2026-11-17。
- **[C2]** [Assigning weights to blocks in a symphony](https://help.composer.trade/article/18-symphony-editor-assign-weights)。实际正文四类权重、逆波动公式、可适用块/资产限制；更新2025-06-27。访问：2026-11-17。
- **[C3]** [How Symphony Trading Works](https://help.composer.trade/article/65-how-does-composer-trade)。实际正文自动交易、目标配置、编辑生效、熔断、not-held、资金和成交限制；更新2025-06-27。访问：2026-11-17。
- **[C4]** [Backtest Basics](https://help.composer.trade/article/67-backtest-basics)。实际正文回测与实时决策差异、日调整收盘、默认1bp滑点、订阅费用假设；更新2026-09-02，旧$40例子与当前标价冲突已揭示。访问：2026-11-17。
- **[C5]** [Pricing](https://www.composer.trade/pricing)。实际套餐正文$0/$10/$32按年$384、策略/节点/API/人工覆盖与费用/地域/风险披露；不是导航条价格猜测。访问：2026-11-17。
- **[C6]** [Terms of Service](https://www.composer.trade/terms-of-service)。本轮只获取标题与公共法律页脚，详细协议不可读；**不能据此认定获得软件或数据使用许可**。访问：2026-11-17。

### Portfolio Visualizer

- **[P1]** [Test Tactical Allocation Models](https://www.portfoliovisualizer.com/tactical-asset-allocation-model)。实际 Tactical Allocation Overview、各模型解释和表单字段；已读到trading frequency/rebalancing/trade execution，不用菜单当证据。访问：2026-11-17。
- **[P2]** [Portfolio Optimization](https://www.portfoliovisualizer.com/optimize-portfolio)。实际9类优化解释、月收益/样本外警告、单资产与分组上下限表单。访问：2026-11-17。
- **[P3]** [Rolling Portfolio Optimization](https://www.portfoliovisualizer.com/rolling-optimization)。实际滚动窗口说明、目标、优化频率月/季/年、12—60月回看、权重范围。访问：2026-11-17。
- **[P4]** [Documentation](https://www.portfoliovisualizer.com/faq)。实际保存/导入、自定义收益、成本、回测方法、再平衡偏离带、优化局限、tactical信号与延迟执行、目标波动局限；不是目录标题推断。访问：2026-11-17。
- **[P5]** [Subscription Plans and Pricing](https://www.portfoliovisualizer.com/pricing)。实际Free/Basic/Pro价格、用途与6条限制脚注；功能勾叉丢失限制见正文。访问：2026-11-17。
- **[P6]** [Terms of Service](https://www.portfoliovisualizer.com/terms-of-service)。实际教育用途、假设业绩、有限不可转让许可/IP归属、责任条款；最后修改2025-09-25。访问：2026-11-17。
- **[P7]** [Backtest Portfolio](https://www.portfoliovisualizer.com/backtest-portfolio)。同组研究提供已读取的官方实际正文：股票/ETF/基金、多组合比较、现金流与再平衡设置；本文件的具体月收益、偏离带算法以独立读取的[P4]交叉核验。访问：2026-11-17。

## 7. 取证质量与限制

1. QuantConnect Docs 的 `portfolio-construction/key-concepts` 在 `web_fetch` 中只返回导航后截断，**明确弃作功能证据**。GitHub网页超时、raw域名失败后，使用官方GitHub Contents API公开读取并在内存base64解码实际源码；未绕过身份认证、未请求私有仓库。
2. Composer 猜测的`/article/25-weighting`返回404，未引用；通过官方分类页发现真实文章路径，再读正文。分类页只用于发现链接，不承担功能证明。
3. PV `/plans`返回404，未引用；实际`/pricing`有正文。Tactical/Optimize虽在长表单后截断，本文只使用已经读到的具体解释/字段，方法论用`/faq`交叉核对；不从未读到的尾部推论。
4. 未将导航中的工具名称等同于已验证功能；未将公开功能存在等同于免费权限；未将“未找到”写成“产品没有”。
5. 未创建账户、未读取私有数据、未实施代码、未执行回测或自动实盘、未commit。本轮仅交付此研究文档；所有产品建议均需后续独立评估。

[Q1]: https://github.com/QuantConnect/Lean/blob/master/Algorithm/QCAlgorithm.Framework.cs
[Q2]: https://github.com/QuantConnect/Lean/blob/master/Algorithm/Portfolio/PortfolioConstructionModel.cs
[Q3]: https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Portfolio/EqualWeightingPortfolioConstructionModel.cs
[Q4]: https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Portfolio/MeanVarianceOptimizationPortfolioConstructionModel.cs
[Q5]: https://github.com/QuantConnect/Lean/blob/master/Algorithm.Framework/Risk/MaximumDrawdownPercentPortfolio.cs
[Q6]: https://api.github.com/repos/QuantConnect/Lean/license
[Q7]: https://www.quantconnect.com/pricing
[Q8]: https://www.quantconnect.com/terms
[C1]: https://help.composer.trade/article/54-create-tutorial
[C2]: https://help.composer.trade/article/18-symphony-editor-assign-weights
[C3]: https://help.composer.trade/article/65-how-does-composer-trade
[C4]: https://help.composer.trade/article/67-backtest-basics
[C5]: https://www.composer.trade/pricing
[C6]: https://www.composer.trade/terms-of-service
[P1]: https://www.portfoliovisualizer.com/tactical-asset-allocation-model
[P2]: https://www.portfoliovisualizer.com/optimize-portfolio
[P3]: https://www.portfoliovisualizer.com/rolling-optimization
[P4]: https://www.portfoliovisualizer.com/faq
[P5]: https://www.portfoliovisualizer.com/pricing
[P6]: https://www.portfoliovisualizer.com/terms-of-service
[P7]: https://www.portfoliovisualizer.com/backtest-portfolio
