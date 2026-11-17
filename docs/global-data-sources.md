# 全球与深度数据源（2026-11-17）

这份文档只描述当前代码实际接入、并经过本机探测的来源与边界。它不是“全球数据全覆盖”承诺。

## 行情与公司

| 市场 | 数据 | 来源 | 边界 |
| --- | --- | --- | --- |
| A股 | 行情/K线/指数/板块 | 东财、腾讯；WeStock 回退 | 实时性依赖源；停牌/缺量为空而非 0 |
| 港股 | 行情/K线 | 东财（`hk_quote`/`hk_kline`） | 港币计价；部分财务/评级能力依赖 WeStock（本机 CLI 不可执行时会失败） |
| 美股 | 行情/K线 | 东财/Yahoo、WeStock 回退 | 美元计价；Yahoo 可能 429 |
| 基金 | 净值/排行/净值走势 | 东财 `fund_quote`/`fund_kline`/`fund_rank` | 净值 T+1；日期是净值日，不是实时价 |
| 基金档案 | 经理/规模/申赎/同类排名/重仓/风险/基准 | `fund_dossier`（东财画像 + 本地计算） | 重仓披露有滞后；场外完整持仓需定期报告 |

## 全球个股 / 指数 / 商品行情与 K 线

- 工具：`get_global_quote(secid)`、`get_global_kline(secid, limit)`、`get_global_market_snapshot()`；HTTP：`/global/quote`、`/global/kline`；面板：行点击指数展开日K，海外个股在资料页显示行情+日K。
- 先用 `search_symbol` 拿东财 `secid`：美股 `105.NVDA`、指数 `100.SPX`/`100.NDX`/`100.HSI`、黄金 `101.GC00Y`、白银 `101.SI00Y`、铜 `101.HG00Y`、美元指数 `100.UDI`、日股 `176.7203`、英股 `155.TYT`。
- 缺失字段为 `null`、不补 0；K线只丢弃无效/非正收盘行；失败行不影响其他行。日K为前复权（fqt=1）。
- `get_global_market_snapshot` 一次返回美股三大指数 + 恒生 + 黄金/白银/铜 + 美元指数，用于「美股走势对黄金影响」这类跨市场问题先取双方事实；**只给行情，不给因果或涨跌预测**。
- 覆盖边界：不是所有交易所/品种都有 secid（如本机实测 VIX、原油、美债收益率无对应 secid）；缺失时明确，不编造。

## 全球指数行情（默认美国）

- 面板「市场研究 → 行情」顶部新增「全球行情」，默认美国，可切亚太/欧洲/中国；HTTP `GET /global-indices?region=us|asia|europe|china|all`。
- 数据源：东方财富 `push2` 全球指数；美国（标普500/道琼斯/纳斯达克）、亚太（恒生/日经/韩国/印度/澳洲）、欧洲（富时/DAX/CAC）、中国（上证/深证/创业板）。
- 返回 `price / changePct / change / asOf / source`；字段缺失为 `null`，不补 0；抓取时间与行情时间分开。单指数失败只影响该行，失败不缓存。
- 指数点位以源为准，可能延迟，不是可交易报价；不声称覆盖全球所有交易所。

## 全球宏观（结构化）

工具：`get_macro_global`；面板：`/macro/global`。每个序列返回 `source / unit / asOf / fetchedAt / points / latest / provenance / notes`，失败带 `error`，不补 0。

| series | 指标 | 来源 | 频率 | 本机最新（2026-11-17 探测） |
| --- | --- | --- | --- | --- |
| `us_cpi` | 美国 CPI 同比 | OECD SDMX `DSD_PRICES`（本机 JSON 表示返回 500，已回退 genericdata XML） | 月度 | 2026-09，3.74% |
| `ea_hicp` | 欧元区 HICP 同比 | Eurostat `prc_hicp_manr` | 月度 | 数据源最新仅到 2025-12，2.00%（陈旧，已如实展示） |
| `ea_unemployment` | 欧元区失业率 | Eurostat `une_rt_m`（季调） | 月度 | 2026-09，6.50% |
| `us_gdp_growth` | 美国 GDP 增速 | World Bank `NY.GDP.MKTP.KD.ZG` | 年度 | 2025，2.16% |
| `ea_gdp_growth` | 欧元区 GDP 增速 | World Bank 同上（EMU） | 年度 | 2025，1.41% |
| `ea_policy_rate` | 欧央行存款便利利率 | ECB data-api `FM/D.U2.EUR.4F.KR.DFR.LEV` | 日频 | 2026-11-17，2.50% |

边界：BLS/CNBC 在本机 403，未接入；没有全球统一宏观库；中国结构化仍只有 `get_macro_china` 五类；不同国家/地区的季调、同比环比、年化、修订版本不可混用。

## 政策与国际官方来源

- 国内 allowlist 原有 11 个来源（统计局 RSS、gov.cn、发改委、工信部、交易所、央行、财政部、商务部、证监会、巨潮）。
- 新增 10 个**国际官方来源**（Fed、ECB、BLS、BEA、IMF、World Bank、OECD、Eurostat、BIS、US Treasury）加入允许清单，但**默认 `enabled: false`、`kind: manual`**：只允许用户用 `policy_import(url)` 手工导入具体页面，不自动抓取国际站，也不声称已核实 feed/列表结构。
- 国际官方链接不等于现有自动核验识别为“官方”；导入内容仍受可达性、robots、页面脚本渲染和 allowlist 限制。失败时保留缺口，不伪造正文。

## 全球市场新闻雷达

- 工具：`get_global_news_radar(hours, limit, keywords)`；HTTP：`/news/radar`；面板：「快讯」页 → 全球市场雷达。默认只抓**已核实可解析的官方源**：Fed、ECB、BIS、SEC（press/statements）、Bank of England。
- 默认不启用媒体源；CNBC 虽在复测时 200，但未默认进入。不可用源（IMF/World Bank/Treasury/BLS 等）保留失败记录与 `enabled:false`。
- 评分是确定性规则：来源权威 + 事件类型 + 一手性 + 时间衰减 + 可选跨资产反应/关键词；输出分项 `reasons`。**不代表因果，不预测涨跌，也不声称“全市场最重要”**；仅表示“在已覆盖源范围内的相对重要性”。
- 解析支持 RSS 2.0 / Atom / RDF，缺失时区按 UTC 标注；非法日期不参与评分。抓取失败会进入 `feedDiagnostics`，不会伪造条目。

## 财务与公司事件

| 数据 | 市场 | 来源 | 口径 |
| --- | --- | --- | --- |
| F10 七维（概况/主营/财务/概念/股东户数/估值分位/同业） | A股 | 东财 F10 | 报告期；港美不适用 |
| 财务 | 港股 | 东财 HKF10 `RPT_HKF10_FN_MAININDICATOR` + 公司概况 | 中报/季报为**年初至今累计**，币种 HKD；不能按单季解读 |
| 财务 | 美股 | SEC EDGAR `companyfacts`（10-K/10-Q，us-gaap XBRL） | 10-Q 为单季；需 User-Agent；20-F 等非 10-K/10-Q 会明确失败 |
| 资金流 | A股 | 东财 push2his 逐日 `fflow/daykline`（20 日） | 主力=大单+超大单；算法统计，不是公司现金流；单位 CNY |
| 公司公告 | A股 | 东财公告接口 | 标题/日期/分类/原文链接 |
| 分红送配 | A股 | 东财 `RPT_SHAREBONUS_DET` | 每 10 股税前派息、送转、进度；不擅自换算 |
| 业绩预告/快报 | A股 | 东财 `RPT_PUBLIC_OP_NEWPREDICT` / `RPT_FCI_PERFORMANCEE` | 预告区间与快报实际值分开 |
| 大宗交易 | A股 | 东财 `RPT_DATA_BLOCKTRADE` | 折溢价字段原样保留（小数/百分数差异已标注） |
| 融资融券 | A股 | 东财 `RPTA_WEB_RZRQ_GGMX` | 余额与净买入；单位亿元/元以源为准 |
| 事件/风险/股东 | A股 | WeStock 能力（本机 CLI 不可执行时失败） | 失败只影响该 section，不补数据 |

说明：WeStock CLI 在本机是 Linux 二进制，当前 Windows/WSL 环境不可执行；因此新增的 A 股资金流/公司事件/港美财务都走可用的 HTTP 官方/东财接口，并在失败时明确标注，而不是假装 WeStock 成功。

美股 SEC 访问要求可联系的 User-Agent：设置环境变量 `DSH_SEC_EDGAR_UA="dsh-finance/0.1.0 (your-contact@example.com)"` 后重启宿主（或按实际部署注入）。未配置时 `get_global_financials` 会明确失败，不会匿名硬闯或伪造数据。

## 基金体验

- 基金页支持名称/代码检索、类型/周期筛选、分页、整行打开资料；净值日期显式标 T+1。
- 基金资料包含经理/规模/申赎/同类排名/重仓/风险/基准/净值曲线；重仓股可继续点开个股资料。
- 基金没有“公司营收”口径；需要企业财务时穿透其重仓公司，不能把基金净值当营收。

## 验证范围（2026-11-17）

- `npm run build` 通过；客户端 bundle 含基金页、全球宏观/雷达、基金净值图。
- 离线契约：全球宏观 32、全球财务 25、A 股资金流/事件 42、新闻雷达 20、基金 UI 13、国际政策源 12、档案全球 section 27、档案工具数据 17、证券研究 15、研究手册 16、资本 14、持仓录入 11、数据源 16、设计系统 12、UI 契约 14 —— 全通过。
- 原有金融回归：regressions 19、quant 28、policy 46、evidence 13、capital 21、wealth 19、investment 23、learn 14 —— 全通过。
- 真实联网 smoke（仅手工，不属离线测试）：新闻雷达 6/6 官方源解析并返回排序；港股 00700 财务（2026 中报）；美股 AAPL SEC 10-K；A 股 600519 资金流（2026-11-16 主力 5.16 亿、大单 6.96 亿、超大单 -1.80 亿）。
- 未做真实浏览器视觉/键盘验收：本机没有已连接的 CDP 浏览器；未启动替代浏览器、未做 DOM 模拟或截图。`npm run test:ui` 会明确 SKIPPED。

**边界**：这些是覆盖范围内可复核的数据与排序，不是全球全量、不是因果、不构成买卖建议。

## 失败与缺口（必须如实说明）

1. 全球宏观只有 6 条序列；没有全球指数/外汇/商品实时结构化行情（东财全球指数可作反应参考，但不是完整市场库）。
2. BLS、IMF、World Bank 新闻、Treasury 等在本机不可用/无结构化 feed；不伪造。
3. 媒体新闻源默认关闭；官方源覆盖不等于全市场新闻。
4. HKF10 与 SEC 的披露滞后、口径差异（累计 vs 单季、币种）必须逐项标注。
5. 所有评分/资金流/事件摘要都只是研究辅助，不是买卖建议或因果结论。
