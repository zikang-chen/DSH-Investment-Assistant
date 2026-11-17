# 免费中国数据集（AKShare 桥）清单

> 桥接实现：`scripts/fin_cn_datasets.py`（Python，被 `src/data/cn-datasets.ts` 通过 `execFile` 调用）。
> 环境：Python 3 ｜ **AKShare 1.20.65** ｜ 实测日：**2026-11-17（Asia/Shanghai）**。
> 口径：`as_of` 是**最新统计期**（源侧），`fetched_at` 是抓取时间；缺失一律 `null`，**绝不补 0**。
>
> **条目数说明（如实）**：`DATASETS` 字典实际有 **29 个 dataset id**（19 个 `available=true` + 10 个 `available=false`）。任务书写作“22 个”，与代码不符；本清单按**代码实际内容**如实列出全部 29 项，不删减、不夸大。凡是本机真跑出数值的，标 ✅ 并附样例；未接入的 10 项单列「不可用原因」。

---

## 一、可用数据集（19 个，均本机实测 2026-11-17 返回真实数值）

| dataset id | AKShare 函数 | 来源与 URL | 单位 | 频率 | 是否可用 | 实测状态与样例（2026-11-17） |
|---|---|---|---|---|---|---|
| `CN_MACRO_GDP` | `macro_china_gdp` | 东方财富-中国GDP · https://data.eastmoney.com/cjsj/gdp.html | 亿元 / 累计同比% | 季度 | ✅ | ok；as_of=2026年第1-2季度；GDP 695704 亿、同比 4.7% |
| `CN_MACRO_CPI` | `macro_china_cpi` | 东方财富-中国CPI · https://data.eastmoney.com/cjsj/cpi.html | 指数(上年=100)/同比%/环比% | 月度 | ✅ | ok；as_of=2026年10月；**同比 0.7%**、指数 100.7、环比 0.0 |
| `CN_MACRO_PPI` | `macro_china_ppi` | 东方财富-中国PPI · https://data.eastmoney.com/cjsj/ppi.html | 指数(上年=100)/同比% | 月度 | ✅ | ok；as_of=2026年10月；当月 105.7、**同比 5.7%** |
| `CN_MACRO_PMI` | `macro_china_pmi` | 东方财富-中国PMI · https://data.eastmoney.com/cjsj/pmi.html | 指数(50=荣枯线) | 月度 | ✅ | ok；as_of=2026年10月；制造业 49.3、非制造业 49.7 |
| `CN_MONEY_M1_M2` | `macro_china_money_supply_em` | 东方财富-货币供应量 · https://data.eastmoney.com/cjsj/hbgyl.html | 亿元 / 同比%/环比% | 月度 | ✅ | ok；as_of=2026年10月；**M2 余额 3590550.61 亿（≈359.06 万亿）同比 7.1%**、M1 同比 4.4%、M0 同比 10.7% |
| `CN_CREDIT_TSFIN_FLOW` | `macro_china_social_financing` | 商务数据中心-社会融资规模增量 · https://data.eastmoney.com/cjsj/shrzgm.html | **亿元（增量，非存量）** | 月度 | ✅ | ok；as_of=**202604**；**社会融资规模增量 6245 亿元**（列名即「社会融资规模增量」= **增量非存量**口径）。注意：该序列最新统计期仅到 202604，明显滞后于 2026-10，属源端滞后，非抓取问题 |
| `CN_FISCAL_REVENUE` | `macro_china_fiscal_revenue` | 东方财富-财政收入 · https://data.eastmoney.com/cjsj/czsr.html | 亿元 / 同比%、累计 | 月度 | ✅ | ok；as_of=**2026年09月**；当月 15659 亿、累计 172292 亿、累计同比 5.1% |
| `CN_INDUSTRIAL_PRODUCTION` | `macro_china_industrial_value_added` | 东方财富-工业增加值 · https://data.eastmoney.com/cjsj/gyzjz.html | 同比% / 累计同比% | 月度 | ✅ | ok；as_of=2026年10月；当月同比 4.8%、累计 5.3% |
| `CN_REAL_ESTATE` | `macro_china_real_estate` | 东方财富-国房景气指数 · https://data.eastmoney.com/cjsj/fangjia.html | 指数 / 涨跌幅% | 月度 | ✅ | ok；as_of=**2025-12-01**（源端最新值滞后）；国房景气指数 91.45、涨跌幅 -0.48%。注意：该指数最新期滞后，不等于当前楼市热度 |
| `CN_IMPORT_EXPORT` | `macro_china_customs_trade` | 东方财富-海关进出口 · https://data.eastmoney.com/cjsj/jinchukou.html | 美元 / 同比%、累计 | 月度 | ✅ | ok；as_of=2026年10月；出口同比 35.2%、进口同比 41.6%、累计出口同比 22.7% |
| `CN_ELECTRICITY_CONSUMPTION` | `macro_china_society_electricity` | 新浪-全社会用电分类 · https://data.eastmoney.com/cjsj/gdysj.html | 万千瓦时 / 同比% | 月度 | ✅ | ok；as_of=2026.9；全社会用电量 8.0734 亿万千瓦时、同比 3.9%（部分分项为 null，不补 0） |
| `CN_A_SHARE_DAILY` | `stock_zh_a_hist_em` | 东方财富-A股日线 · https://quote.eastmoney.com/ | 元/股、手、元、% | 日频 | ✅ | ok；as_of=**2026-11-17**；600519 开盘 1458.88、**收盘 1455.12**、最高 1461.60、最低 1437.71、成交额 48.43 亿、涨跌幅 0.08%（同日 WeStock 实时 1459.99，盘中不同时刻略有差异） |
| `CN_A_SHARE_FINANCIALS` | `stock_financial_analysis_indicator` | 新浪-财务指标 · https://money.finance.sina.com.cn/ | 按列名标注（元/%/倍） | 季度 | ✅ | ok；as_of=**2026-09-30**；**摊薄每股收益 53.3702 元（EPS 53.37）**、加权 EPS 51.53、每股净资产 224.32 |
| `CN_ETF_DAILY` | `fund_etf_hist_em` | 东方财富-ETF日线 · https://quote.eastmoney.com/ | 元/份、手、元、% | 日频 | ✅ | ok；as_of=**2026-11-17**；510300 开盘 4.039、收盘 4.05、最高 4.061、最低 4.018、涨跌幅 -0.1% |
| `CN_FUND_NAV` | `fund_open_fund_info_em` | 东方财富-基金净值 · https://fund.eastmoney.com/ | 元/份、% | 日频 | ✅ | ok；as_of=**2026-11-16**；**110022 单位净值 3.008**、日增长率 0.94% |
| `CN_INDEX_DAILY` | `index_zh_hist_em` | 东方财富-指数日线 · https://quote.eastmoney.com/ | 点、手、元、% | 日频 | ✅ | ok；as_of=2026-11-17；000300 沪深300 收盘 3976.46、涨跌幅 -0.08% |
| `CN_BOND_YIELD` | `bond_china_yield` | 中国债券信息网-收益率曲线 · https://yield.chinabond.com.cn/ | % | 日频 | ✅ | ok；默认参数窗口 2026-01-01~01-10，返回 **2026-01-09** 中债国债收益率曲线：**10 年 1.8782%**、30 年 2.3024%、1 年 1.2887% |
| `CN_CORPORATE_ANNOUNCEMENTS` | `stock_individual_notice_report` | 东方财富-个股公告 · https://data.eastmoney.com/notices/ | 条 | 事件 | ✅ | ok；as_of=2026-11-03；`stock_individual_notice_report("600519")` 返回 **1079 条**公告（含标题/类型/日期/原文 URL） |
| `CN_INDUSTRY_SECTOR` | `stock_board_industry_name_em` | 东方财富-行业板块 · https://quote.eastmoney.com/center/boardlist.html | 元、%、家 | 快照 | ✅ | ok；返回行业板块排行（约 496 个板块，含最新价/涨跌幅/总市值/上涨-下跌家数/领涨股） |

> **`asOf` 纪律**：上表 `as_of` 均为「统计期」，不是抓取时间。抓取时间统一为 `2026-11-17T06:5xZ`（对应北京时间 14:5x）。`CN_REAL_ESTATE`（2025-12）、`CN_CREDIT_TSFIN_FLOW`（202604）源端最新统计期滞后，已在样例注明，**不拿它当最新宏观读数**。

---

## 二、不可用原因（10 个 `available=false`，逐项写原因并指向已有替代）

| dataset id | 含义 | 不可用原因 | 已有替代 |
|---|---|---|---|
| `CN_CREDIT_TSFIN_STOCK` | 社融**存量** | AKShare 仅提供社融**增量**，存量口径未找到稳定免费接口 | 用 `CN_CREDIT_TSFIN_FLOW`（增量，明确非存量）+ 央行社融存量公报（人工/Evidence 补充） |
| `CN_FISCAL_EXPENDITURE` | 财政**支出** | AKShare 仅提供财政收入；支出无稳定免费接口 | 财政部公开报告人工/Evidence 补充 |
| `CN_GOVERNMENT_BONDS` | 国债发行 | 尚未核实稳定的免费国债发行接口 | 财政部/中债公告人工导入 |
| `CN_A_SHARE_VALUATION` | A股估值 | 未在 AKShare 桥实现 | 已有 **`stock_dossier`** 的估值分位（东财 F10）/ 能力 `valuation_analysis` |
| `CN_FUND_HOLDINGS` | 基金重仓 | 场外完整持仓需定期报告，AKShare 无稳定全量接口 | 已有 **`fund_dossier`**；`em_fund_holdings` 取前 N 重仓 |
| `CN_INDEX_COMPONENTS` | 指数成分股 | 尚未核实稳定成分股接口 | 能力 `ws_index_constituent`（WeStock `index constituent`） |
| `CN_MARKET_TURNOVER` | 两市成交额 | 可由现有行情/板块数据派生，尚未实现 | `get_market_breadth`（含成交额）/ `get_quotes` 汇总 |
| `CN_INDUSTRY_ELECTRONICS` | 电子行业细分 | 需东财板块成分 + 财务聚合，待实现 | `CN_INDUSTRY_SECTOR`（板块行情）+ 个股财务 |
| `CN_INDUSTRY_AUTOMOTIVE` | 汽车行业细分 | 同上 | 同上 |
| `CN_INDUSTRY_SOFTWARE` | 软件行业细分 | 同上 | 同上 |

---

## 三、桥接健康检查

- `checkCnBridge()` 用 `CN_MACRO_CPI`（limit=1）做健康探针；本轮 19 个可用数据集全部 `ok:true`。
- 桥接只用公开接口，**研究用途**；AKShare 库本身 MIT，底层数据版权归各来源（东财/新浪/中债/巨潮等），**不得再分发原始数据**。
- 失败时返回 `ok:false + error`，绝不产出假行；空表返回 `rows:[]` 并附 `warnings`。
