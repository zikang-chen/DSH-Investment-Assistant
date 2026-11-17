# Provider 与 Dataset 统一注册规范（Provider–Dataset Registry）

> 目的：把「一个数据源（provider）」与「一个数据集（dataset）」拆开声明，让**路由、健康、许可、时效**都可被机器读取与断言。
> 落地参考：`src/types.ts`（`Capability` / `DEFAULT_PROVIDER_ORDER`）、`src/data/providers.ts`（`PROVIDERS` 约 63 个 provider 条目）、`src/data/westock-capabilities.ts`（55 个 WeStock 能力）、`scripts/fin_cn_datasets.py`（`DATASETS`）。

---

## 一、Provider 能力声明字段

统一用一张表描述一个 provider 的**能力边界**。字段固定为下列 11 个（字段名即键名，不得改名）。

| 字段 | 类型 | 允许值 / 说明 |
|---|---|---|
| `provider_id` | string | 唯一 id，与 `providers.ts` 的 `ProviderMeta.id` 对齐，例如 `ws_quotes_batch`、`em_macro`、`em_market_detail_announcements`、`global_financials_sources`、`oecd_sdmx`。 |
| `datasets` | string[] | 该 provider 能回答的能力/数据集 id 列表，例如 `["quote","quotes_batch"]` 或 `["CN_MACRO_CPI"]`。对应 `Capability` 或桥 `dataset`。 |
| `access_type` | enum | `official-api`（官方结构化接口）/ `official-download`（官方文件下载）/ `public-web`（公开网页/JSON）/ `cli-binary`（本地 CLI 子进程）/ `manual`（人工导入）。 |
| `requires_key` | bool | 是否需要密钥/凭证。`false`=免鉴权；`true` 时须在 `notes` 写明所需变量（如 SEC 的 `DSH_SEC_EDGAR_UA`）。 |
| `cost_class` | enum | `free` / `free-with-account` / `paid`。 |
| `permissions` | string[] | 该源允许的使用方式，枚举子集：`read-only`、`research-only`、`no-automation`、`rate-limited`。 |
| `redistribution_policy` | enum | `public-domain` / `attribution-required` / `research-only-no-redistribution` / `vendor-terms` / `unknown`。描述**能否再分发原始数据**。 |
| `data_frequency` | enum | `realtime` / `intraday` / `daily` / `weekly` / `monthly` / `quarterly` / `annual` / `event` / `snapshot` / `irregular`。 |
| `expected_latency` | string | 预期时效，如 `秒级-实时`、`T+1（净值日）`、`月度发布后 1-2 日`、`季度`、`≤10s`。与 `data_frequency` 区分：频率是「多久一条」，延迟是「发布/抓取后多久能看到」。 |
| `priority` | int | 路由优先级，越小越先。必须与 `DEFAULT_PROVIDER_ORDER` 一致；注意 registry 默认会**把 `ws_*` 提权**放在 HTTP 源前（`preferWestock`），用户显式策略永远最高。 |
| `health_status` | enum | `healthy`（本轮实测通过）/ `degraded`（可用但滞后/部分失败）/ `unavailable`（实测失败）/ `untested`（本轮未跑）。直接对应 `data-source-audit.md` 的「已验证可用 / 未测试 / 不可用」。 |

**示例（字段填充示范）**

```json
{
  "provider_id": "ws_quotes_batch",
  "datasets": ["quote", "quotes_batch", "indices"],
  "access_type": "cli-binary",
  "requires_key": false,
  "cost_class": "free",
  "permissions": ["read-only", "research-only", "rate-limited"],
  "redistribution_policy": "research-only-no-redistribution",
  "data_frequency": "realtime",
  "expected_latency": "秒级-实时",
  "priority": 0,
  "health_status": "healthy"
}
```

```json
{
  "provider_id": "global_financials_sources",
  "datasets": ["global_financials"],
  "access_type": "official-api",
  "requires_key": true,
  "cost_class": "free",
  "permissions": ["read-only", "rate-limited"],
  "redistribution_policy": "public-domain",
  "data_frequency": "quarterly",
  "expected_latency": "10-K/10-Q 发布后",
  "priority": 0,
  "health_status": "unavailable",
  "notes": "美股需 DSH_SEC_EDGAR_UA（含可联系邮箱）；港股走东财 HKF10 不受影响"
}
```

---

## 二、Dataset Registry 定义

`Dataset` 描述「一个可单独取数的具体数据集」，比 provider 更细。桥（`fin_cn_datasets.py`）的 `DATASETS` 就是它的一个实例化。

| 字段 | 类型 | 说明 |
|---|---|---|
| `dataset_id` | string | 唯一 id，如 `CN_MACRO_CPI`、`CN_A_SHARE_DAILY`、`us_cpi`。 |
| `provider_id` | string | 归属 provider，如 `akshare`、`oecd_sdmx`。 |
| `fetch_fn` / `akshare_fn` | string | 实际调用函数，如 `macro_china_cpi`、`stock_zh_a_hist_em`；非 AKShare 源可为空。 |
| `source_url` | string | 来源页面 / 接口地址。 |
| `unit` | string | 单位（如 `亿元`、`%`、`元/股`），必须与数值口径一致。 |
| `frequency` | enum | 同 `data_frequency`。 |
| `period_field` | string | 承载统计期的字段名（如 `月份`、`日期`、`季度`），用于计算 `as_of`。 |
| `as_of_semantics` | enum | `statistics-period`（统计期，宏观/财务）或 `trade-date`（交易日，行情）——决定 `as_of` 的语义。 |
| `nullable` | bool | 恒为 `true`：缺失即 `null`，**不补 0**。 |
| `status` | enum | `available` / `unavailable`。 |
| `reason` | string | `unavailable` 时必填原因。 |
| `alternative` | string | `unavailable` 时指向已有替代（如 `stock_dossier`、`fund_dossier`）。 |
| `notes` | string | 口径陷阱（如「增量非存量」「累计口径」）。 |

---

## 三、路由规则（固定优先级链）

路由分两层：**同能力多源回落**（`DEFAULT_PROVIDER_ORDER` + registry `preferWestock`）与**跨来源选主**（下表）。下表定义「某数据需求先走谁、谁兜底」。

| 数据需求 | 首选 | 次选 / 兜底 | 固定规则 |
|---|---|---|---|
| A股**盘中**行情 | 现有行情：`ws_quotes_batch`（WeStock CLI 优先，registry 提权） | `em_stock_get` / `em_individual_info` | 盘中用实时源，闭市后即收盘价；批量优先一次调用 |
| A股**历史**/补数 | `AKShare`（`CN_A_SHARE_DAILY`）/ `BaoStock` | 现有备用：`em_kline` / `tx_kline`（`ws_kline` 亦可） | 历史用日线接口；复权口径必须唯一（见第五节） |
| 中国宏观（CPI/PPI/PMI/GDP/M2） | **国家统计局**（政策/统计发布，`stats-releases` RSS） | `AKShare` `macro_china_*` → `em_macro`（东财） | 统计口径以官方发布为准，源端滞后须标注 |
| 货币 / 社融 | **中国人民银行** | `AKShare` 辅助（`CN_MONEY_M1_M2`；社融 `CN_CREDIT_TSFIN_FLOW` **增量非存量**） | 存量社融无稳定免费源，只用增量并注明 |
| 财政 | **财政部** | 人工 / Evidence 补充（`CN_FISCAL_REVENUE` 仅收入） | 支出、国债发行走财政部官方，非 AKShare |
| 公司公告 | **交易所 / 巨潮** | `em_market_detail_announcements`（东财 np-anotice-stock）→ `ws_notice_list`（WeStock） | 公告以交易所/巨潮为准，东财为镜像索引 |
| 基金数据 | **正式披露（定期报告）** | 实时净值 `em_fund_quote`（pingzhongdata）；排行 `em_fund_rank`；重仓 `fund_dossier` / `em_fund_holdings` | 完整持仓仅年报披露；净值 T+1 |
| 全球指数 / 商品 / 美债 | 东财 push2：`em_global_indices` / `global_quotes` | — | 一 secid 一请求；字段缺失为 null，不补 0 |
| 全球宏观 | OECD / Eurostat / World Bank / ECB data-api（`global-macro`） | — | 只解析结构化统计接口，不做网页摘要；JSON 500 时回退 XML |
| 美股财务 | **SEC EDGAR XBRL**（`global_financials_sources`，需 `DSH_SEC_EDGAR_UA`） | — | 只取 10-K/10-Q 的 us-gaap 显式 tag；缺 UA 直接阻断 |
| 港股财务 | 东财 HKF10（`RPT_HKF10_FN_MAININDICATOR`，**累计口径**） | — | 勿与美股单季直接比 |

> 补充：同能力回落顺序以 `DEFAULT_PROVIDER_ORDER` 为准（如 `quote: ['ws_quote','em_stock_get','em_individual_info']`、`kline: ['ws_kline','em_kline','tx_kline']`）。用户显式策略（数据源页）优先级最高，registry 不做二次提权。

---

## 四、四类时间（必须分开，不得混用）

| 时间 | 定义 | 代码落点 | 示例 |
|---|---|---|---|
| **统计期** | 数据本身描述的期间（哪个月/季/年/交易日） | 桥 `as_of`；`global-macro` 的 `asOf`；`global-financials` 的 `REPORT_DATE` / fact `end`；`em-market-detail` 的 `asOf`；基金 `navDate` | CPI `as_of=2026年10月份`；茅台财报 `2026-09-30` |
| **发布日** | 官方/来源对外**发布**该数据的日期 | 政策 `publishedAt`；研报 `time`；新闻 `publishedAt`；SEC `filed` | 统计局 2026-11-16 发布 10 月 CPI |
| **抓取日** | 本次**实际抓取/调用**时间 | 桥 `fetched_at`；`fetchedAt`；`global-indices` 报告级 `at` | `2026-11-17T06:55Z`（北京时间 14:55） |
| **修订日** | 数据被**修订/更新**（同期间新版本）的时间 | 桥 `revision_note`（只返回最新一版，历史修订需另存）；`global-macro` 的 `upstreamTimestamp`（header `prepared`）；SEC 同期间重复披露取最新 `filed`（附 accession） | 年度 GDP 后续修订；10-K 年度值被下一份申报重述 |

**硬规则**：`asOf`（统计期）与 `fetchedAt`（抓取日）**绝不互相顶替**。无有效统计期时 `asOf` 必须为 `null`，不能用抓取时间冒充。

---

## 五、禁止项（数据纪律红线）

1. **缺失不补 0**：`null` / `NaN` / `None` / `''` 一律转 `null`，绝不 `Number(null)=0`。
   - 代码落点：桥 `clean()`；`global-macro.parseNumeric`；`global-indices.parseGlobalIndexNumber`（真实 `0` 保留为 `0`，与缺失区分）；`em-market-detail.numOrNull`；`global-financials`（`val` 为空布尔/串则忽略该事实）。
2. **不混复权**：K 线必须显式指定复权口径并在同一序列内唯一（前复权 `qfq` / 后复权 `hfq` / 不复权），不得把不同口径拼接。
   - 代码落点：东财 `kline` 的 `fqt=1/2/0`；腾讯 `qfqday/hfqday`；`global_quotes` 的 `fqt=1`。
3. **不混币种**：金额保留源侧原始币种，**不做隐式换算**。
   - 代码落点：`global-financials` 每股/每币种逐行 `currency`（美股恒 `USD`，港股取行内 `CURRENCY`）；港股各期币种不一致时 `currency=null` 并出 warning，而非强行折算。
4. **附加红线**：
   - 不把**抓取时间**当**数据时点**（见第四节）。
   - **不猜** secid / 单位 / 字段位置：命名字段才解析，认不出就抛错回落（如 `em_fund_holdings` 契约未核实即抛错，绝不按位置猜）。
   - 不把「有源码 / 官网可访问 / README 支持」写成「实测通过」（见 `data-source-audit.md`）。
