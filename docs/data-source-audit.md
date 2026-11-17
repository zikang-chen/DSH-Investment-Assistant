# 数据源审计（Data Source Audit）

> 审计时点：**2026-11-17（Asia/Shanghai）** ｜ 环境：Windows + DeepSeek Harness（DSH）、Python 3、AKShare **1.20.65**、WeStock CLI **0.0.5（channel=workbuddy）**
>
> **判定口径（严格执行）**
> - **已验证可用** = 本机实际调用该 provider / 接口并拿到真实数值（下文附数值样例与抓取时间）。
> - **未测试** = 仓库有源码 / 契约 / 官网，但本轮未在本机实际跑通——**不得当作通过**。
> - **不可用** = 本机实际调用失败，并记录错误与原因。
>
> 关键红线：**禁止把源码当实测**——有源码 ≠ 实测通过。本审计**禁止把「有源码 / 官网可访问 / README 支持」写成「实测通过」**。凡是只看到源码而没跑过的，一律归入「未测试」；凡是本机调用失败的，一律归入「不可用（含原因）」。
>
> 全局健康探测（`probe_finance_sources`，2026-11-17T06:52Z）：115 项能力探测中 **105 可用 / 10 不可用**。

---

## 一、数据源矩阵表

> 列说明：「最近实测状态」只写**本轮（2026-11-17）本机实际调用的结果**；没跑过的写「未测试」，并指向第二/三节。
> 「免费额度 / 许可」为通用口径，具体字段级声明见 `provider-dataset-registry.md`。

| 数据需求 | 是否已有 | Provider | 覆盖 | 更新频率 | 最近实测状态（日期 + 本机结果） | 需 Key | 免费 | 免费额度 | 许可 | 缺失 | 建议补充 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A股实时/批量行情 | 是 | `ws_quotes_batch`（主）/ `em_stock_get`、`em_individual_info`（回落） | A股全市场 | 盘中实时（秒级），收盘后为收盘价 | **2026-11-17 ✅** 600519=1459.99（+0.42%）；批量一次返回 600519/00700/AAPL | 否 | 是 | 公共接口无显式配额，建议 1–3 次/秒 | 东财/腾讯数据，个人研究，不得再分发 | — | — |
| A股K线（日/周/月） | 是 | `ws_kline`（主）/ `em_kline`、`tx_kline`（回落） | A股 | 日频（收盘更新） | **2026-11-17 ✅** 600519 日线：2026-11-17 O1458.88 C1457.70 H1461.60 L1437.71 V35116 | 否 | 是 | 同上 | 同上 | — | — |
| 港股行情 / K线 | 是 | `ws_hk_quote`、`ws_hk_kline`（主）/ `em_hk_quote`、`tx_hk_quote`、`em_hk_kline`、`tx_hk_kline` | 港股 | 实时 / 日频 | **2026-11-17 ✅** 00700=377.20（-3.38%） | 否 | 是 | 同上 | 同上 | — | — |
| 美股行情 / K线 | 是 | `ws_us_quote`、`ws_us_kline`（主）/ `yahoo_quote`、`yahoo_kline`、`em_us_quote`、`em_us_kline` | 美股 | 实时（延时）/ 日频 | **2026-11-17 ✅** AAPL=352.78（-0.98%），asOf=2026-11-16（美股收盘） | 否 | 是（延时） | Yahoo 有非公开限流（429），次选东财 | Yahoo 条款 / 东财数据 | — | 免费实时美股源可另找，现为延时 |
| 全球指数 / 商品 / 美债 / 美元指数 | 是 | `em_global_indices`、`global_quotes`（东财 push2 按 secid） | 全球主要指数 + 商品 + 美债10Y + 美元指数 | 实时（延时） | **2026-11-17 ✅** SPX 7416.59（-1.92%）、恒生 23530.6、COMEX黄金 3874.4、NYMEX原油 85.07、US10Y 5.1218%、美元指数 103.5 | 否 | 是 | 公共接口按 secid 逐只请求 | 东财数据 | **VIX 无有效 secid**（见不可用） | VIX 另找可用源（如 CBOE 官方） |
| 公募基金净值 / 画像 / K线 | 是 | `em_fund_quote`（em pingzhongdata）/ `em_fund_nav_quote`、`em_fund_nav_kline`（回落，契约未核实） | 公募基金 | T+1（净值日更新） | **2026-11-17 ✅** 110022 单位净值 3.008（em asOf=2026-11-15；AKShare 侧 2026-11-16 同为 3.008），日涨 0.94% | 否 | 是 | 公共接口 | 东财数据 | — | — |
| 基金排行 | 是 | `em_fund_rank` | 开放式基金 | 每日 | **未测试**（本轮未跑；源码用东财 rankhandler） | 否 | 是 | 公共接口 | 东财数据 | — | 需补实测 |
| 基金重仓穿透 | 是 | `em_fund_holdings`（契约未线上核实，防御式解析） | 场外基金前 N 重仓 | 定期报告（季/半年） | **未测试**（契约未核实；完整持仓仅年报披露） | 否 | 是 | 定期披露 | 东财数据 | 完整持仓仅年报 | 用 `fund_dossier`；完整持仓走定期报告 |
| ETF 概览 / 折溢价 / 估值 | 是 | `ws_etf_overview` | 场内 ETF | 实时 / 日频 | **2026-11-17 ✅** 510300 规模 1905.85 亿、折溢价 -0.15%、PE-TTM 13.481、涨跌 -0.71% | 否 | 是 | 公共接口 | 腾讯/东财数据 | — | — |
| 中国宏观（CPI/PPI/PMI/GDP/M2） | 是 | `em_macro`（东财 datacenter） | 中国月度 / 季度 | 月 / 季 | **2026-11-17 ✅** CPI 2026-10 同比 **0.7%**；M2 2026-10 余额 3590550.61 亿（≈**359.06 万亿**）同比 **7.1%**；PMI 2026-10 制造 49.3；GDP 2026 上半年 695704 亿、同比 4.7% | 否 | 是 | 公共接口 | 东财数据 | — | — |
| 中国宏观扩展（AKShare 桥，19 可用 / 29 定义） | 是 | `cn-datasets`（Python 桥 `scripts/fin_cn_datasets.py`）→ AKShare | 宏观/市场/基金/债券/公告等 | 月 / 季 / 日 / 事件 | **2026-11-17 ✅** 19 个数据集实跑通过（样例见 `free-cn-datasets.md`） | 否 | 是 | AKShare 走公开接口，建议低频 | AKShare=MIT（库）；底层数据归各自来源，研究用途 | 10 个数据集未接入（见 B） | 见 B 的「不可用项」 |
| 全球宏观（US CPI / EA HICP / EA 失业 / GDP / ECB DFR） | 是 | `global-macro`（OECD SDMX / Eurostat / World Bank / ECB data-api） | 美国 / 欧元区 | 月 / 年 / 日 | **2026-11-17 ✅** us_cpi 2026-09 **3.74%**（OECD JSON 表示 HTTP 500 → 回退 genericdata XML）；ea_hicp 2025-12 2.0%（**源端最新期滞后**）；ea_policy_rate 2026-11-17 **2.5%** | 否 | 是 | 官方统计接口，无 Key | 多可署名使用（CC BY 等） | ea_hicp 源端最新期仅到 2025-12 | 关注 Eurostat 更新节奏 |
| 资金流（逐日 20 日） | 是 | `em_market_detail_money_flow`（东财，EM 独占）/ `ws_fund_flow` | A股 | 日频 | **未测试**（本轮未跑；源码 2026-11-17 记录可用） | 否 | 是 | 公共接口 | 东财数据 | — | 需补实测 |
| 两融 / 大宗 / 龙虎榜 / 北向 | 是 | `em_market_detail_margin_detail`、`em_market_detail_block_trade_detail`、`ws_lhb_stock`、`ws_north_holding` | A股 | 日频 | **未测试**（本轮未跑；源码 2026-11-17 记录可用） | 否 | 是 | 公共接口 | 东财/腾讯数据 | — | 需补实测 |
| 公司公告 | 是 | `em_market_detail_announcements`（东财 np-anotice-stock） | A股 | 事件 / 日 | **2026-11-17 ✅** 600519 共 **1079 条**，最新 2026-11-03（含原文链接） | 否 | 是 | 公共接口 | 东财数据 | — | — |
| 分红 / 业绩预告快报 | 是 | `em_market_detail_dividend_plan`、`em_market_detail_performance` | A股 | 事件 | **未测试**（本轮未跑；源码 2026-11-17 记录可用，每 10 股口径/小数股息率已核验） | 否 | 是 | 公共接口 | 东财数据 | — | 需补实测 |
| 股东 / 评分 / 一致预期 / 评级 / ESG / 事件 / 风险 | 是 | `ws_shareholder`、`ws_score`、`ws_consensus`、`ws_rating`、`ws_esg`、`ws_events`、`ws_risk` | A股为主 | 事件 / 日 | **2026-11-17 ✅** consensus 600519：2026E EPS 66.82、2027E 70.82（其余本轮未逐项跑） | 否 | 是 | 公共接口 | 腾讯/东财数据 | — | 其余子项需补实测 |
| F10 七维（概况/主营/财务/题材/股东户数/估值/同行） | 是 | `em_f10_survey`、`em_f10_business`、`em_f10_financials`、`em_f10_concepts`、`em_f10_holders`、`em_f10_valuation`、`em_f10_peers` | A股 | 季 / 事件 | **未测试**（源码注明：上游契约在本环境 TLS 被中断，无法线上核实；同行接口为页面结构推断） | 否 | 是 | 公共接口 | 东财数据 | 契约未线上核实 | 需补 f10 契约实测 |
| 港股财务 | 是 | `global_financials`（东财 `RPT_HKF10_FN_MAININDICATOR`，累计口径） | 港股 | 定期报告 | **2026-11-17 ✅** 00700 最新 2026-06-30：营收 4012.43 亿 HKD、EPS 12.639、ROE 9.97%、PE 13.30 | 否 | 是 | 公共接口 | 东财数据 | 累计口径，勿与美股单季直接比 | — |
| 美股财务 | 是 | `global_financials_sources`（SEC EDGAR companyfacts XBRL） | 美股 | 10-K / 10-Q | **2026-11-17 ⚠ 不可用**：缺 `DSH_SEC_EDGAR_UA`（须含邮箱），请求前即阻断（见不可用段） | **是（UA 含邮箱）** | 是 | SEC：免费，限 ≤10 req/s | 美国联邦公开数据 | 20-F/40-F 外国私人发行人不适用 | 配置 `DSH_SEC_EDGAR_UA` 后重试 |
| 政策（国内官方源） | 是 | `policy_collect`（国家统计局 RSS 启用；政府网/发改委/工信部/交易所/央行/财政部/商务部/证监会/巨潮为手工） | 中国 | 发布时 | **源码记录 2026-11-16 实测**：stats.gov.cn `rss.xml` 返回 200 完整条目；其余脚本渲染页默认关闭。**本轮未复测** | 否 | 是 | 公开站点，遵守 robots | 政府公开信息 | 多数站点脚本渲染，仅手工导入 | 稳定 RSS/官方 feed 可加白名单 |
| 政策（国际官方源） | 是（手工） | `policy_import(manual)`：Fed/ECB/BLS/BEA/IMF/WorldBank/OECD/Eurostat/BIS/US Treasury | 国际 | 发布时 | **未测试**（源码注明未联网核实，全部 `kind:manual`、`enabled:false`） | 否 | 是 | 视站点条款 | 官方发布 | 可能 403/脚本渲染 | 需逐个联网核实 |
| 新闻雷达（官方一手） | 是 | `get_global_news_radar`：Fed/ECB/BIS/SEC/BoE RSS | 国际 | 实时 | **源码记录 2026-11-17 实测**各 feed 200 可解析（本地探针）；**本轮未复测** | 否 | 是 | 官方 RSS | 官方发布 | — | — |
| 新闻雷达（不可用/媒体） | 是（默认关闭） | IMF / World Bank / Treasury / BLS（403/not-feed/404）、CNBC / Google News / Yahoo Finance | 国际 | — | **不可用或默认关闭**（详见第三节与 `src/news/feed-sources.ts` 探针记录） | 否 | — | — | — | 多个官方 feed 403/非 feed | 见第三节 |
| 快讯 / 个股新闻 | 是 | `em_news_flash`、`em_stock_news`、`ws_news` | 中国 | 实时 | **未测试**（本轮未跑；源码为东财快讯/搜索 + WeStock news） | 否 | 是 | 公共接口 | 东财/腾讯数据 | — | 需补实测 |
| 券商研报 | 是 | `ws_research`（WeStock report list） | A股/港/美 | 实时 | **未测试**（本轮未跑） | 否 | 是 | 公共接口 | 各券商/腾讯聚合 | — | 需补实测 |
| 通用网页搜索 | 是 | `rss_web_search`（Bing RSS，零依赖）/ `py_web_search`（Python ddgs，可选） | 全网 | 实时 | **未测试**（本轮未跑） | 否 | 是 | Bing RSS 无显式配额 | 搜索结果版权归各站 | ddgs 需 pip 安装 | 需补实测 |
| A股市场宽度（涨跌分布/情绪） | 是 | `ws_changedist` | 沪深A股 | 日频（盘中） | **2026-11-17 ✅** 上涨 1314 / 下跌 4135、上涨占比 23%、涨停 38 / 跌停 82 | 否 | 是 | 公共接口 | 腾讯数据 | — | — |

---

## 二、未测试（有源码/契约，但本轮未在本机跑通，不得算通过）

| 项目 | Provider / 文件 | 为什么归「未测试」 |
|---|---|---|
| 沪深指数（`indices`） | `ws_indices` / `em_index_main` | 与 `ws_quotes_batch` 同源（WeStock quote），但本轮未单独调用 indices 能力，故不判「通过」。需补一条 `get_market_overview` 实测。 |
| 基金排行（`fund_rank`） | `em_fund_rank` | 本轮未跑。 |
| 基金重仓穿透（`fund_holdings`） | `em_fund_holdings` | 契约未线上核实（防御式解析，认不出就抛错）。完整持仓仅年报披露。 |
| 资金流 / 两融 / 大宗 / 龙虎榜 / 北向 | `em_market_detail_*` / `ws_*` | 源码 2026-11-17 记录可用（含列序核验），但本轮未复测。 |
| 分红送配 / 业绩预告快报 | `em_market_detail_*` | 同上。 |
| F10 七维 | `em_f10_*` | 上游契约在本环境 TLS 被中断，源码明示「无法线上核实」；同行比较为页面结构推断。 |
| 快讯 / 个股新闻 / 研报 / 网页搜索 | `em_news_flash`、`em_stock_news`、`ws_research`、`rss_web_search` | 本轮未跑。 |
| 政策国内（非统计局源） | `gov-cn-policy`、`ndrc-policy`、`miit-policy`、`sse-rules`、`szse-rules`、`pbc`、`mof`、`mofcom`、`csrc`、`cninfo` | 源码标注脚本渲染 / POST 接口，默认 `enabled:false`，只支持手工 `policy_import`。 |
| 政策国际（全部 10 条） | `src/policy/sources.ts` 国际段 | 源码明示「未联网核实」、`kind:manual`、`enabled:false`。 |
| AKShare 桥 10 个未接入数据集 | `scripts/fin_cn_datasets.py` 的 `available=false` 项 | 见 `free-cn-datasets.md`「不可用项」。 |

---

## 三、不可用原因（本机实测失败，逐项原因）

| 数据/能力 | 现象（本机实测） | 原因 | 处理 / 替代 |
|---|---|---|---|
| VIX 波动率指数 | `get_global_quote("100.VIX")` → `ok:false`，「行情源返回空数据（可能是暂停交易或代码不存在）」 | 东财 push2 **无有效 VIX secid**（`100.VIX` 空 data） | 另接 CBOE 官方 VIX 源；暂不出该指标 |
| 美股财务（SEC XBRL） | `get_global_financials("AAPL","us")` → `ok:false`，「SEC EDGAR 要求 User-Agent 含可联系邮箱……本次未发送请求」 | 本会话 `DSH_SEC_EDGAR_UA` **未配置**（`env` 为空） | 设 `DSH_SEC_EDGAR_UA="应用名 邮箱"` 后重试；港股财务不受影响 |
| BLS 最新发布 feed | `bls_latest.rss` 记录 **403 Forbidden**（源码 2026-11-17 复测） | 站点对非浏览器 UA/爬虫返回 403 | 手工 `policy_import` 或换官方 API（BLS 有公开 JSON API） |
| IMF 新闻 feed | `en/News/RSS` 等三个候选均 **403** | 站点封锁 | 手工导入链接 |
| 世界银行新闻 feed | `/en/news/all?format=rss` 返回 **200 但为 HTML**（无 item/entry） | 该路径不是 feed | 用 World Bank 官方 API（GDP 已在 global_macro 使用） |
| 美国财政部新闻 feed | `home.treasury.gov` 下 6 个候选 **404**，`treasury.gov/rss` 重定向 HTML | 未找到可用 feed | 手工导入具体页面 |
| Google News 头条 | **429 Too Many Requests** | 限流 | 不纳入；默认关闭 |
| Yahoo Finance 新闻 | **404** | 端点失效 | 不纳入；默认关闭 |
| CNBC Top News | 本轮 2026-11-17 复测 **200（30 条 item）**，但此前记录 403/超时 | 稳定性存疑 | 保持 `enabled:false`，需显式 opt-in |
| 政策国际源（Fed/ECB/BLS/…） | 未联网核实；可能 403 / 脚本渲染 / robots 限制 | 官方站反爬 | 仅 `policy_import(url)` 手工导入 |

---

## 四、实测纠偏（重要：任务预设与实测不符的，以实测为准）

> 「必须如实、不夸大」要求把工程里流传的待核实结论与本轮实测逐条对齐。以下两条**在本机实测中不成立**，据此更正。

| 预设原因（工程待核实） | 本轮实测结论 | 证据（2026-11-17） |
|---|---|---|
| WeStock CLI 是 Linux 二进制、Windows 不可执行 | **❌ 不成立（本机可执行）** | 本机存在 `C:\Users\86153\.westock\bin\westock.exe`、`D:\finance_ds\.dsh-home\bin\westock.exe`；`westock -v` 返回 `westock 0.0.5 channel=workbuddy`；`get_quotes`（provider=`ws_quotes_batch`）返回 600519=1459.99、00700=377.20、AAPL=352.78。**注意**：源码 `scripts/install_westock.sh` 的 `case` 只支持 `darwin`/`linux`，**没有 Windows 分支**——所以「不能用该脚本安装」成立，但「Windows 不能执行」不成立（二进制已就位、可运行）。 |
| 原油无 secid | **❌ 不成立（有 secid 且可用）** | `102.CL00Y` NYMEX原油 = **85.07**（-0.76%）；`get_global_market_snapshot` 同批返回。清单内还有 `112.B00Y` 布伦特（未单独复测）。 |
| BaoStock TCP 10030 被阻断 | **⚠ 未复测**（不肯定） | 本仓库未接入 BaoStock（`scripts/fin_cn_datasets.py` 仅用 AKShare）；「TCP 10030 阻断」为工程记录，本轮**未验证**，故不写入「已验证不可用」。 |

> 结论：判断某源是否可用，必须看**本轮本机真实返回值**，而不是源码注释或历史传闻。上表中被证伪的两条，已从「不可用」改判为「可用」。

---

## 五、审计小结

- **核心行情链路健康**：A股 / 港股 / 美股 / 全球指数商品 / 基金 / ETF / 中国宏观 / 全球宏观 / 公告 / 港股财务 / 市场宽度均有本轮实测数值（见第一节 ✅ 行）。
- **两个真实不可用点**：VIX（无 secid）、美股 SEC 财务（缺 UA）。前者需换源，后者只需配置环境变量。
- **大量「只是没跑过」**：F10 七维、资金流/两融/大宗、快讯/研报/搜索、政策国内非统计局源、政策国际源、新闻媒体源——这些属于「未测试」，不能计入通过。
- **纠偏**：WeStock CLI 在 Windows 本机**可执行**、原油 secid **可用**，两者不应被列为不可用。
