# 数据源与边界（Data Sources）

> 原则：公开、可追溯、可失败。拿不到就明确报不可用，**不编接口、不绕反爬、不用不稳定隐藏端点**。

## 1. 行情与宏观（默认启用）

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| A 股/港股/美股报价、K 线 | 东方财富、腾讯；美股优先 Yahoo、东财兜底 | 公开 HTTP，串行限流 + 缓存 + 熔断 |
| 指数、板块、资金流、两融、龙虎榜 | 东方财富 / WeStock CLI | WeStock 优先，失败回落 HTTP |
| 基金净值/排行/持仓 | 东方财富 | 净值是 T+1，勿当实时价 |
| 中国宏观（CPI/PPI/PMI/GDP/M2） | 东方财富 datacenter | 注意统计期与发布日不同 |
| 研报与公司简况 | WeStock CLI（可选） | 未安装时研报不可用，其余自动回落 |

探测：`npm run probe` → `data/probe-report.json`。

## 2. 政策官方来源（2026-11-16 实测）

| 来源 | 状态 | 备注 |
| --- | --- | --- |
| 国家统计局 · 数据发布（RSS） | ✅ 默认启用 | `sj/zxfb/rss.xml` 返回完整条目（约 500 条，带 pubDate） |
| 中国政府网 · 最新政策 | ❌ 手工导入 | 列表由脚本渲染，静态 HTML 无政策链接 |
| 国家发改委 · 政策发布 | ❌ 手工导入 | `rss.xml` 存在但为空；列表页脚本渲染 |
| 工信部 · 政策文件 | ❌ 手工导入 | 返回脚本外壳（约 2KB） |
| 上交所 / 深交所 · 业务规则 | ❌ 手工导入 | 规则列表由脚本加载 |
| 央行 / 财政部 / 商务部 / 证监会 / 巨潮 | ❌ 手工导入 | 结构不稳或依赖脚本/接口 |

探测：`npm run policy:probe`（`--collect 3` 可顺带真抓 3 篇验证抽取质量）。

需要登录、验证码或授权的站点：**只走手工导入**（`policy_import` / 取证提交），不绕过访问控制。

## 3. 海外数据

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 机构 13F / 13D / 13G | SEC EDGAR 官方 | 需要合规 User-Agent（`DSH_SEC_EDGAR_UA`，含联系邮箱）；未配置会在请求前阻止 |
| 美国国会交易 | Bargo 免费档 + Disclosed Capitol 备用 | 备用源需 `DISCLOSED_CAPITOL_API_KEY`，未配置则明确报不可用 |
| 美债/美元/黄金/非农 | 通过 `global_to_china_impact` 的机制链 + 行情工具 | 只给传导机制与验证指标，不预测 |

## 4. MCP 外部源（可选，需自备 token）

| 名称 | kind | 说明 |
| --- | --- | --- |
| 妙想（东方财富） | `mcp-http` | `EM_API_KEY` |
| 盈米 | `cli` | 需全局安装 `yingmi-skill-cli`；Windows 上 spawn `.cmd` 会受限，属已知限制 |

Token 解析顺序：环境变量 → `data/mcp-secrets.json`（gitignore）→ 配置内联。

## 5. 数据使用纪律

- **不编数字**：源失败就 `unavailable`，并用 `probe_finance_sources` / `policy:probe` 定位。
- **标注时间**：行情有 `asOf`，政策有 `publishedAt`，统计有期间与发布日。
- **区分口径**：社融增量/存量、GDP 同比/环比/累计、基金净值 T+1。
- **不把历史相关性当因果**：相关性分析要写样本期、频率、样本量。
- **不绕过限制**：robots、频率、体积上限、登录/验证码一律遵守。
- **用户提供的数据不等于官方事实**：证据等级见 `docs/evidence-inbox.md`。

## 6. 失效时的表现

| 情况 | 表现 |
| --- | --- |
| 行情源全部失败 | 工具返回 `ok:false` + 错误原因；持仓 CRUD 仍可用 |
| 缺汇率 | 净资产不给单一总额，按币种列示并给 `missingFx` |
| 缺持仓行情 | 未实现收益标缺失，不按 0 计 |
| 缺逐期估值 | TWR 返回 `unavailable` |
| 政策源抓不到 | `policy_probe` 显示 0 links；改用 `policy_import` |
| 缺执行数据 | 建 `evidence_request`，不猜 |
