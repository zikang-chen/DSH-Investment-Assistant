# 综合投研执行手册

本手册是 `investment-advisor` 的按需参考，不是要把所有工具跑完的清单。只使用当前会话实际暴露的工具；下面路由依据项目真实合同整理，不新增 API，不保证某上游在线。

## 策略实验与环境调整（可选）

用户要求综合/多持仓策略时，先用`portfolio_strategy_review`按显式当前权重、战略目标、现金、风险约束、复核周期和环境证据检查整个组合。行情/国际新闻只能触发复核；比较原战略与战术候选的暴露、换手及失效条件，不自动写目标。不经授权读取真实资产；页面草案不等于已保存/批准。组合历史再平衡回测、穿透相关性与FX自动取数仍需单独证据，不能声称已完成。

只有用户明确要求单标的价格规则实验时，才使用`strategy_experiment`比较冻结模板；普通主板以外或数据门禁失败如实拒绝。不可将hfq图表数据当真实整手成交价格。结果为价格纸面模拟，不含完整分红/公司行动，不称总回报或预测。

结合市场与国际形势时先取得可核验行情、资金、官方宏观/政策/新闻，再以topic/claim/source/asOf/direction调用`strategy_environment_review`。至少支持与风险证据；超过30天或日期异常列缺口。来源字段存在不代表已核验，必须查原始材料。

环境复核只输出条件变化与候选调整；不能自动改变冻结规则或将当前新闻回填历史。新规则用已有`submit_strategy`存proposed草案，注明旧hash、变更原因和证伪条件，重新测试后等用户批准。用`save_research`记录数据hash、成本、留出结果与环境依据，不混入个人真实收益。

## 1. 先确认身份、问题和授权

- 从一句话提取：完整名称/代码、上市市场、股票/基金/ETF、基金份额类别、报价币种、目标（了解/风险/条件性配置）、期限、用户给定约束。用户没提到持仓，不等于授权读持仓。
- 股票名称或代码用 `search_symbol(query)` 核对；返回 `matches`。名称片段、同名、多市场、股票与基金可能混淆时，给出实际候选的名称/代码/市场让用户选择，不能默认第一项。`search_stock` 是列表样本搜索，不是全市场验证。
- 基金名不能假定由股票搜索完整覆盖：可用 `web_search` 找管理人官网基金页，核对代码及 A/C 等份额；盈米可用时先 `yingmi_list` → `yingmi_schema` → `yingmi_call` 发现能力，不能杜撰基金搜索工具名或入参。仍不唯一则请用户给代码/选择候选。
- 目标/期限会改变结论而尚不明确时先问；不为普通资料问答强行收集个人财务。未定期限可以先做不含行动方案的资料整理，不把默认期限当用户意愿。
- **持仓授权默认关闭**。`get_portfolio`、`analyze_portfolio`、`analyze_fund_overlap`（即使传 codes）、`portfolio_lookthrough`、`check_new_position`、`simulate_rebalance`、`policy_portfolio_exposure`、`capital_*` 查询/分析及直接读私有文件均可能涉及个人资产。只有明确授权后按本次问题的范围使用；未授权时做公开资料研究并写「未使用个人持仓」。不通过另一个工具绕过授权。

## 2. 证据计划：先复用，再按依赖并行

先 `list_research(code/query)` → `get_research(id)`，政策另查 `policy_search` → `policy_get`。索引摘要只用于选资料，结论前读正文，检查是否过时/截断。发现相同标题+日期已有记录时优先追加批注，不重复建条目。

按问题选择最小证据集，例如：

| 用户问题 | 必要分支 | 不是默认必跑 |
| --- | --- | --- |
| 腾讯年报与未来一年风险 | 官方年报/最新财报、业务与估值；相关新闻/相关国内国际政策、行情按问题需要补 | 用户账本、无关全球指标、全行业选股 |
| 某基金的经理和历史回撤 | 身份/份额、经理任期、净值及风险、费用与披露期 | 所有重仓企业逐一尽调 |
| 基金是否受重仓企业营收恶化拖累 | 已核对的持仓及权重 → 相关企业财报；同期间净值作对照 | 把所有持仓公司营业收入相加当基金营收 |
| 海外利率事件对中国行业的影响 | 海外官方事实、中国相关渠道/行业业务证据、反证 | 所有 NBS 序列、未经授权的组合穿透 |

身份确认后，互不依赖的官方财报检索、相关新闻、政策/宏观、行情/资金可以按需并行。搜索返回具体链接后才能抓正文；公告列表返回真实 id 后才能取详情；基金持仓确认后才选企业查财报；Evidence Request 接受后才恢复研究。遵守工具本身限流，不为了并行绕过失败。

每个关键主张记录：来源机构/链接或库 id、文件标题、发布日期、统计/财报期间、数据截至日、单位/币种、页码/章节/段落、抽取/核验状态、是否截断。不要把抓取时间当数据时间。引用必须能定位到实际读到的内容。

## 3. 股票：年报原文、新闻、资金和走势分工

### 官方年报/财报

1. `get_notice_list(code,limit,offset)` 只是公告列表。用其真实公告 id 再调用 `westock_call` 的 `notice_detail` 能力，或通过公司 IR、交易所、监管披露页检索官方原文。
2. 已确认公告 id 的合同示例：`westock_call({capability:"notice_detail", args: JSON.stringify({id: 已取得的公告id})})`。这是路由示意，不是可填假的 id；先 `westock_capabilities` 核对当前能力。返回的文本也可能截断，读不到相关表格不得声称已读整份。
3. 公开原文用当前可用的 `web_search` 定位，再 `web_fetch` 读取具体官方 URL。港股优先公司 IR/港交所披露，美股优先公司 IR/SEC，A 股优先交易所/巨潮及公司官网。确认公司、财年、合并范围、审计意见、版本；公告新闻转载只作线索。
4. 真正取到原文后再提取营收/分部、利润（IFRS/GAAP 与 non-IFRS/non-GAAP 分开）、经营现金流、资产负债、资本开支、回购分红、风险因素等与问题相关项。单季/累计/全年及报告币种不混用；非每份年报都包含同样字段。
5. `get_financial_indicators` 可以提供已有市场覆盖内的结构化财务指标，核对返回期间/单位；没有承诺港美所有字段都可用。结构化摘要和券商预测不能替代官方财报原文核验。

### PDF 读取闸门

- `web_fetch` 返回文本不等于通用 PDF 解析器；HTTP 成功、拿到 PDF URL、下载字节、文件名识别都不等于已读内容。
- 用户合法提供并授权读取的本地 PDF 有实际通路：先加载当前可用的 `office` 技能，用 `office_render(input,pages)` 渲染所需页，再 `read_image` 逐页读取并核对页码/表头/金额单位、负号和列对齐，整理本次研究所需正文/表格。说明实际核对范围，未读全部页不能称读完整份年报。核对成功后将整理的正文用 `policy_import(text,...)` 导入政策库，或用 `save_research(body,...)` 存财报/其他资料，明示「人工/视觉转录」、范围/页码、原文件出处；数字存疑则标待核，不升级为官方核验。转录文本与原文件是不同证据，不修改/冒用原始哈希，也不是后台自动批量 PDF 抽取。`office_convert` 不支持 PDF 输入，不能编造 PDF→txt 功能；另有真实可用的文字解析器才按其合同抽取。这是 Agent 的文档读取路径，不是 policy/evidence 内置解析。扫描件看不清、抽取乱码、表格错列或无可用读取工具时如实停止这条分支，不编造 OCR/下载/分页 API。
- **现有 `policy_import` 的 PDF 是原文快照：`parseStatus='pdf-pending'`，不抽取正文。`evidence_submit` 的 PDF 也只存字节，可能返回 `parse-questionable`。不能把任一成功回执写成「PDF 已读」。**
- 仅有新闻/研报摘要时明确「仅取得摘要，未核对年报正文」，不得用摘要冒充 PDF 已读。若用户指定的年报或影响判断方向的关键 PDF 解析失败，按第 7 节建立 `importance='critical'` 的 Evidence Request；核心判断受阻时 `blockingLevel='blocking'`，只出受限分析，不给动作。非关键补充材料可标缺失，不机械升级所有 PDF。

### 其他分支

- `stock_dossier` / `fund_dossier` 保留 summary、snapshotId、状态/条数，并返回 **`sections[].data` 的真实有界预览**。研究必须读实际 `data`、provider/dataAsOf/missing，不能把「有若干条」当具体内容已读。若运行中的旧版本仍只返回状态/条数，按缺内容处理，用专用工具/原文补查，不假定新合同已部署。
- **档案截断合同**：每节 `dataPresentation` 给 `sourceKind/sourceCount/returnedCount/countUnit/selection/truncated/events/omittedEventCount/followUp`，必要时有 `omittedReason`；根 `dataPresentation` 给 limits、section 范围/遗漏数和整体截断状态。数组为原顺序前缀，对象优先来源/单位等元数据再按原顺序，不能当精选全量。`rows` 是上游统计，**不等于本次返回条数**。当前预算为最多32节、数组6项/对象30字段/文本1200字符/深度5、每节 data 6000字符/总 data 24000字符、最终缩进 JSON 64000字符；以回执 limits 为准。
- `at` 是抓取时间，`dataAsOf` 才是数据时点；缺 data/dataAsOf 仍未知，不造零值或用 at 代替。`followUp` 只是已有工具的补查提示，不自动调用，也不保证取到全量；相关内容被截断时才按需用其真实 tool/args 补查并核对范围/时期。档案预览不是完整年报/PDF或全持仓，原文闸门仍适用。
- 新闻：`get_stock_news` / `get_market_news`，研报：`get_research_reports` → `get_research_report_detail`，或 `collect_research(withBody=true)`；引用前分清机构观点、消息事实与原始公告。正文获取失败时收集到的可能仍只是摘要。
- 行情：多标的优先 `get_quotes`；按市场用 `get_stock_kline` / `get_hk_kline` / `get_us_kline`，技术指标用 `calculate_technical_indicators`。报价/收盘/复权范围和截至时间要注明，技术信号不等于盈利证据。
- 资金/市场：按需 `get_money_flow`、`get_north_holding`、`get_market_breadth`、`get_market_overview`。后两者是 A 股/沪深范围，不能称「全球市场全景」。资金分类不是投资者意图的证明；北向或港美数据实际不覆盖/延迟时明确说明。
- 行情工具失败先 `probe_finance_sources`，再用已有可用源/缓存并标旧数据；不要因一次失败全量重跑或伪装实时。

## 4. 基金：经理、持仓、表现、费用与企业财务

- 确认基金名称、代码、份额类别、主动/指数/ETF/债券/QDII 等类型；不能仅凭六码或前缀把股票、场内基金和场外份额混同。基金工具/存档用 `type:'fund'`。
- 深度盘点优先 `fund_dossier(code,benchmark)`。工具回执现含各 section 的真实有界 `data` 预览与 `dataPresentation` 截断信息，但**不是完整持仓或全部画像**；不要停在「状态/条数」，也不要读过预览就声称读完定期报告。超出范围按 `followUp` 用单项工具/管理人原文补查，并保留披露期与缺失。
- 经理：`get_fund_quote` 的实际 `data.raw.profile` 可能有 `currentFundManager`、`assetAllocation`、`fluctuationScale` 等；只读实际返回字段，不保证齐全。经理任期/变更/管理规模用管理人官网和基金定期报告核对，不把产品成立以来业绩全部归给现任经理。
- 表现：`calculate_fund_metrics` 输出确定性收益/回撤/波动及基准对比，缺样本为 null。默认基准是沪深300近似，不是每只基金合同基准；选适合且工具支持的基准或 `benchmark:'none'`，无法取得合同基准时明示。多基金可用 `compare_funds`，不要因短期排行推导未来收益。
- 净值为 T+1，`asOf/raw.navDate` 是净值日不是实时行情。当前本地风险计算使用单位净值、未处理分红再投资，不能写成总回报。基金 K 线无真实成交量，占位值不等于零成交。
- 持仓：必须拿到实际名单/权重/披露期。ETF 可按需 `get_etf_holdings`；场外基金使用管理人官方定期报告，或先发现并核对 schema 的盈米能力。内部 `FinanceDataService.getFundHoldings` 不是已注册的独立 `get_fund_holdings` Agent 工具，不能伪造调用。档案提示字段模式未线上核实时保留该警告，日期不明不能称最新。
- 费用/规则：`fund_dossier` 不承诺费率字段。管理人官网、招募说明书/产品资料概要核对管理费、托管费、销售服务费、申赎费、持有期和暂停申赎；A/C 份额不能互用，不能填一个行业常见费率代替缺失。ETF 决策另看 `get_etf_overview` 的折溢价/规模及实际交易规则。
- 企业财务：用户要求或集中度风险需要时，从已核对的持仓中选重要企业，按第 3 节核验各自营收、利润、现金流和业务风险。按持仓权重讨论暴露，注明前 N 大覆盖比例、非全量、披露滞后。**基金没有企业式营业收入；持仓企业营收不能直接相加/加权后冒充基金营收或净值预测。** 债券/货币基金改看信用、久期/利率与流动性，不强跑股票营收路径。
- `analyze_fund_overlap` / `portfolio_lookthrough` 会读个人组合，须授权；前 N 持仓不是完整穿透。未授权仍可对用户指定基金的公开持仓做研究。

## 5. 全球与中国：官方网页也是证据，但不是新结构化工具

`get_macro_china(series)` 只有 `cpi/ppi/pmi/gdp/money_supply`，由东财提供中国序列，不等于全球数据或全部中国官方统计。中国可按问题补人民银行、财政部、海关等官方原文，不仅国家统计局（NBS）。

**已接入的全球结构化宏观**：`get_macro_global(series)` 返回 6 条真实序列——`us_cpi`（OECD 月度同比）、`ea_hicp` / `ea_unemployment`（Eurostat 月度）、`us_gdp_growth` / `ea_gdp_growth`（World Bank 年度）、`ea_policy_rate`（ECB 日频）。每条带 `source/asOf/unit/fetchedAt/points/latest/provenance/notes`；失败或空值给 `error`，不补 0。口径与缺口：BLS/CNBC 在本机 403 未接入；Eurostat HICP 可能滞后；OECD 的数据查询 JSON 在本机 500，已回退 genericdata XML；不同国家/地区的季调、同比环比、年化与修订版不可混用。全球官方网页仍可 `web_search` / `web_fetch` 补充，但不能把网页检索说成结构化接口。

| 官方来源入口（检索/核对入口） | 常见问题与核对项 |
| --- | --- |
| [BLS](https://www.bls.gov/) | 美国 CPI/就业；季调、同比/环比、初值修订 |
| [BEA](https://www.bea.gov/) | 美国 GDP/PCE；年化季率、价格/数量口径、修订批次 |
| [Fed](https://www.federalreserve.gov/) | FOMC 声明、政策区间、纪要；声明不等于实际融资成本 |
| [ECB](https://www.ecb.europa.eu/) / [Eurostat](https://ec.europa.eu/eurostat/) | 欧元区政策、通胀/增长；国家范围、基期、频率 |
| [IMF](https://www.imf.org/) / [World Bank](https://www.worldbank.org/) / [OECD](https://www.oecd.org/) | 全球/国家比较；预测还是实绩、报告版次、可比口径 |
| [中国人民银行](https://www.pbc.gov.cn/) / [财政部](https://www.mof.gov.cn/) / [海关总署](http://www.customs.gov.cn/) / [NBS](https://www.stats.gov.cn/) | 信贷货币、财政、贸易、实体数据；存量/增量、累计/单月 |

**全球市场新闻雷达**：`get_global_news_radar(hours,limit,keywords)` 只默认抓已核实的官方源（Fed/ECB/BIS/SEC/BoE）。分数是“已覆盖源范围内的相对重要性”（来源权威 + 事件类型 + 一手性 + 时间衰减 + 可选跨资产反应/关键词），**不代表因果或涨跌预测，也不能说全市场最重要**；媒体源默认关闭。使用时引用来源、发布时间、事件类型和分数分项，说明窗口与覆盖源。

**美/港财务**：`get_global_financials(code,market)`；美股来自 SEC XBRL（10-K 年度、10-Q 单季，20-F 等非目标表单会明确失败），需 `DSH_SEC_EDGAR_UA` 含可联系邮箱，缺失时不得伪造；港股来自东财 HKF10 主要指标，中报/季报是**年初至今累计**，币种以返回为准。两者文本/披露均可能滞后，不能把 HK 累计当单季、也不能把 SEC 抓取时间当报告期。

**全球个股/指数/商品行情与K线**：先用 `search_symbol`（或面板搜索）拿东财 `secid`，再用 `get_global_quote(secid)` / `get_global_kline(secid,limit)`。常见 secid：美股 `105.NVDA`/`105.AAPL`、指数 `100.SPX`/`100.NDX`/`100.HSI`、黄金 `101.GC00Y`、白银 `101.SI00Y`、铜 `101.HG00Y`、美元指数 `100.UDI`、日股 `176.7203`。价格与涨跌幅按源口径，缺失为 null 不补 0；这是行情事实，不含该市场完整财报档案（能用 SEC/HKF10 的另查）。海外个股在面板资料页直接显示行情与日K，不再套国内档案。

**跨市场问题（如「英伟达最近走势 + 美股走势对黄金的影响」）的建议取证顺序**：
1. `search_symbol` 确认标的与 secid；`get_global_kline` 看英伟达/纳指近期走势（给区间涨跌、波动，不给“必涨”）。
2. `get_global_market_snapshot` 一次取美股三大指数 + 恒生 + 黄金/白银/铜 + 美元指数的当期涨跌，建立“双方事实”。
3. 需要时 `get_global_news_radar`（官方源重大事件）、`get_macro_global`（美 CPI/利率）、`get_macro_china`（若涉及中国资产）。
4. 传导只写机制与条件：美股/美元/实际利率 → 黄金通常的反向或避险关系是**条件性经验**，必须用当期数据检验，不得写成因果或必涨必跌；明确“本轮数据支持/不支持/无定论”，列失效条件。
5. 保存：资料 `save_research`，判断 `investment_advice_generate`（缺关键数据则 `INSUFFICIENT_DATA`，不给仓位）。

A 股资金流/公司事件：`stock_dossier` 的 `money_flow`（20 日逐日主力/大单/超大单/中单/小单净额与占比）、`announcements`、`dividend_plan`、`performance`（预告与快报）、`block_trade`、`margin_detail`。资金流是算法统计，不是公司现金流；分红每 10 股口径、预告区间与快报实际值、大宗折溢价字段都要按原单位读，不擅自换算。

市场数据同理：项目已有 A/H/美股行情与 K 线，并非全球所有指数、外汇、债券、商品实时行情；只有在实际检索到并核对的来源上才能比较。全球指数/黄金/美元指数可作为跨资产反应参考，但不是完整行情库。WeStock 如需扩展，先 `westock_capabilities` 发现；本机 WeStock CLI（`westock.exe` 0.0.5）实测可用，若某能力失败如实标注并改用可用 HTTP 源，不伪造成功。

跨境传导可用 `global_to_china_impact`：输入只含已核验的事件事实及来源，输出是机制脚手架，不是自动核实新闻或全球抓数器。按「海外事实 → 利率/汇率/需求/成本/风险偏好 → 中国行业 → 公司业务/盈利 → 估值」逐环验证；区分事实、条件推断、未验证叙事，不从海外事件直接跳到买卖。

## 6. 政策、白皮书和政策书导入

1. 先 `policy_sources` 查看来源；`policy_search` 查已有记录。`policy_collect` / `policy_import(url)` 的远程 URL 抓取受实际 allowlist、robots、大小/超时和重定向校验约束。官方来源并不自动等于 allowlist 已允许。当前允许清单已加入 10 个国际官方来源（Fed/ECB/BLS/BEA/IMF/World Bank/OECD/Eurostat/BIS/US Treasury），但默认 `enabled:false / kind:manual`：只表示可用 `policy_import(url)` 手工导入具体页面，**不表示已核实其 feed 或列表可自动采集**。
2. **允许清单内的国际来源也不保证页面可静态抓取**：脚本渲染、403、robots 或结构变化都可能失败。合法可用的公开网页可经 `web_search` / `web_fetch` 阅读，将允许引用的原文摘录和链接用 `save_research(kind:'policy'/'other')` 保存到资料库；资料库记录不等于政策库政策 id 或原文快照。
3. 用户合法取得/获授权提供的本地 `.pdf/.html/.md/.txt` 或粘贴正文，可以分别 `policy_import(filePath)` / `policy_import(text, title, issuer, docType, publishedAt, documentNumber)`。这不是让 Agent 自动抓取被拒 URL，也不是修改 allowlist；不替用户绕过访问控制。外部材料保持来源待核验，不因入库的 `sourceClass` 就称官方核验。
4. 白皮书用实际 `docType:'white-paper'`；政策书按实际内容选 `industry-plan` / `regulation` / `other` 等，不把研究报告变成有法律约束力的政策。说明发布机关、文号、效力、发布日期/生效日；缺失则留缺，不猜。
5. PDF 导入仅存快照，走第 3、7 节解析闸门。可提交合法提取的纯文本补充；**不能保证新正文会自动替换或合并原 PDF 条目**。核对返回 id/version/parseStatus，再明确关联原 PDF/提取正文，不能宣称已自动修复。
6. 用 `policy_get(id)` 读实际正文及 `truncated`，需要时按 `paragraphFrom/paragraphTo` 继续。引用政策 id + version + 段落下标/原文摘录；如返回 contentHash/originalPath 一并留证。只取到局部就明示范围。
7. 修订对比用 `policy_compare` 的真实 id/版本；不要自己编旧版。`policy_annotate` 的目标/措施必须给实际段落；`policy_impact` 是分析脚手架，`policy_execution` 用执行证据分开发布/细则/预算/拨付/订单/财报/定价。政策目标不能直接当已经兑现的业绩。
8. 自动镜像资料库以回执的 `mirrored/mirrorFailed` 为准；必要时 `policy_to_vault`，失败不能宣称资料 tab 已可见。

## 7. 缺证据 → 请求 → 校验 → 恢复

先确认缺口是否会实质改变结论，检查缓存/已有资料库/已配置的合法数据源，不机械穷举所有接口。`evidence_request_list(researchTaskId)` 复用同一缺口。关键年报/PDF未解析、财报表格缺币种或核心全球指标拿不到时，不用新闻或相邻期间冒充。

`evidence_request_create` 的实际字段（均用当前事实填写，不编示例数值）：

- `researchTaskId` / `researchStepId` / `gapKey`：稳定任务与缺口标识。
- `title` / `question` / `reason`：缺什么、回答哪个判断、具体失败（例如 PDF 仅保存字节未抽取正文）。
- `requiredData` / `acceptableFormats` / `suggestedOfficialSources` / `suggestedSearchKeywords` / `sourcePriority`：要哪张表/页码，合法原文或可核对的提取文本，去哪里找。
- `expectedReportingPeriod` / `requiredUnits`：实际财年/月份、币种/元或百万元/百分比，不写「最新」代替期间。
- `importance:'critical'`：用户指定且影响核心结论的 PDF 无法解析时必须设置；`blockingLevel:'blocking'` 表示该结论无法继续。其他次要缺口按实际影响用 high/medium/low 或 partial。
- 恢复上下文用 **`resumeSummary`、`knownFacts`、`nextStep`**，以及真实 `assetIds/policyIds`；不要传不存在的 `resumeContext` 工具参数。

此时可以继续整理已确认事实，但受阻部分为 `INSUFFICIENT_DATA`，不得行动方案/价格区间/仓位。告诉用户 requestId、需补材料、推荐官方栏目与尚不能作出的结论。

用户补链接/文件/正文/手工值 → `evidence_submit`（四选一）→ 看 `validation/issues`、证据状态及 requestStatus。PDF/Excel/截图并不自动解析成功；国际官网 URL 也不保证被现有国内官方域名识别规则识别为官方。**用户提交 ≠ 官方事实，人工确认 ≠ 官方核验**。

解析需用户核对时，只有用户真正确认后才 `evidence_validate(humanConfirmed:true)` 或 `evidence_request_resolve(action:'accept',humanConfirmed:true)`，仍按返回的 evidenceStatus 表述，不人为升级。只有 `ACCEPTED` 才 `evidence_research_resume(requestId)`；从恢复包原上下文继续，比较新增事实、结论改变、仍缺什么，不重新盲跑全部分支。用户暂时找不到可明确 skip，不能把跳过当已取得证据。

## 8. 综合判断、授权模拟与持久化

### 判断门槛

- 区分：直接核对的事实、基于事实的条件推断、尚无证据的叙事。数据冲突时列出口径/时间差，不择取最利好的一个。
- 支持与反对证据都写实际来源、数据日期；无法取得反对证据不能编一个风险事实充数。列出可验证的失效/证伪条件、风险边界、下次复核日期及触发事件。
- 估值使用实际指标/预测，预测标明机构与期间。历史价位不是估值历史分位；K 线本身不能推出历史 PE 分位。价格区间必须有原始输入、算法/假设、窗口和 `calculationRefs`，否则不报区间。
- 用户授权个人资产分析后才取组合；买入/加仓方案前用 `check_new_position` 看边际集中度并引用 before/after。缺价格/汇率不编、不按零；账本 `capital_*` 与持仓快照不是同一口径，不自动相加。跨币种没有已核对的带日期汇率就按币种分列，不给虚假的统一净值或仓位比例。现有模拟不触发交易、不修改账本。

### 两条保存链都需确认回执

1. **资料与报告**：用 `save_research`（`source/date` 必填，已知代码放 `codes`，正文/可引用摘录放 `body`，原始链接放 `url`），或 `collect_research` 收集新闻/研报。已有同资料先 `add_research_note` 补充。未知原文日期不能用今天假冒发布日期；可把今天作为「本次研究笔记」日期，并在正文明确原文日期未知。报告应包含未完成分支与证据状态。
2. **投资判断**：`investment_advice_generate` 不是取数器，而是结构化校验与落盘。填写真实 `userPrompt/assets/market/horizon`、`dataFreshnessStatus/AsOf/Note`、`portfolioContextUsed`、条件和复核日。`supporting/contradicting` 是 JSON 数组字符串 `[{kind,claim,source,asOf,ref?}]`；`kind` 用真实枚举（如 fundamental/macro/policy/market/research），不能编 `annual-report` 类型。`ref` 指向实际存在的资料/政策/URL。
3. 正常建议必须有支持/反对证据与 `invalidationConditions`；无核心依据用 `INSUFFICIENT_DATA` 并列 `unresolvedQuestions`，不填 `proposedActionSummary`、价格区间或仓位指令。不明数据日时保持 `dataFreshnessStatus:'unknown'`，在 note 写清范围；工具要求的日期字段不得伪装成未知行情日期，不能诚实填写时报告保存失败/待补，不造日期。
4. 本地引用可用 `investment_evidence_check` 核对存在性，但存在不证明语义或数值真实。校验错误按 errors 修正，不编造来源来通过校验。
5. 成功才给 adviceId 和「已存入资料库（资料 tab / 文件 <vault 与 item.file 拼成的实际路径，或 get_research.path>）」。两边部分失败则分别说明，不能只发正文就称已落库；需要引导时先 `panel_state` 再 `panel_navigate(tab:'research',note:...)`。
6. 到期用 `investment_advice_due` / `investment_advice_get` 读取原判断，`investment_advice_review` 追加复核；`investment_advice_verify` 只能检验走势，不把观点验证说成交易盈亏。未获明确请求不创建定时任务。

## 9. 自然语言验收案例（不是已执行的金融结论）

- 「研究腾讯未来一年，结合年报、新闻、国内国际政策、全球市场、资金与走势；不读我的账户。」→ 先确认市场身份及目标；按需并行公开分支；年报必须原文核对；未授权的工具不调用；给支持/反证/失效/复核并双链落库。
- 「帮我看看易方达/中证红利。」→ 名称片段不唯一，展示真实候选及份额/市场先让选，不能直接研究第一项。
- 「这只基金经理如何？重仓公司的营收能支持它吗？」→ 确认基金与披露期，基金经理/业绩/费用和持仓企业财报分层；不编基金营收，不默认读取用户组合。
- 「结合美国 CPI、欧元区政策、中国信贷看行业。」→ 全球官方网页 + 国内相关官方证据；说明五类结构化工具边界，不能只贴 NBS 或假称有全球宏观 API。
- 「导入这份国际白皮书/PDF 政策书。」→ 先看允许来源及合法本地材料；国际 URL 不在 allowlist 时走资料库或用户授权文件/正文；PDF 存档 bytes-only 后，能读取则先用真实文档能力核对相关页，关键内容读取失败才走 critical 缺证据分支，不能凭存档成功就给政策段落结论。

`scripts/test_research_playbook.ts` 仅证明文档路由与当前源码合同静态一致，不证明搜索命中、网站在线、PDF可读、财务数据正确、工具调用成功或完整端到端研究已经通过。真实端到端验收需另获授权，使用真实回执逐项检查上述正向和失败路径。
