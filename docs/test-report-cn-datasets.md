# 验收测试报告：免费金融数据源补齐（2026-11-17）

本报告只记录**实际执行过**的验证。凡未实测的，明确写“未验证”。

## 一、环境与版本

| 项 | 实测值 |
| --- | --- |
| Python | Anaconda Python 3.12.4（`C:\Users\86153\anaconda3\python.exe`） |
| uv / uvx | 已安装（`C:\Users\86153\.local\bin\uv.exe`） |
| AKShare | 1.20.65（本地 pip 安装，实测导入成功） |
| AKTools | 0.1.13（`uvx --from aktools aktools-mcp`，MCP 握手成功） |
| BaoStock | 0.9.40（本地 pip 安装成功，但见第三节） |
| Node/tsc | 现有项目环境，`tsc --noEmit` 通过 |

## 二、AKTools MCP 兼容性（已实测）

- `initialize` 成功，`serverInfo = {"name":"AKTools","version":"0.1.13"}`。
- `tools/list` 返回 4 个工具：`search_interfaces`、`describe_interface`、`get_data`、`save_data`。
- 参数名实测纠偏：`search_interfaces` 用 `keyword`；`describe_interface` 用 `name`；`get_data` 用 `name` + `params`。
- 因此 MCP 兼容，但**本项目最终采用本地 Python 桥**（`scripts/fin_cn_datasets.py`）调用 akshare：不依赖 MCP 客户端守护进程、便于离线测试与错误归因。

## 三、BaoStock 结论（如实）

| 项 | 结果 |
| --- | --- |
| 安装 | `baostock 0.9.40` 安装成功 |
| 登录/取数 | **失败并挂起**：`www.baostock.com:10030` 在本机 TCP 不通（80/443 通，10030 不通） |
| 结论 | 本机网络无法连接 BaoStock 数据端口，**不能声称 BaoStock 已可用**；适配器未启用，需在网络放行 10030 或配置代理后重测 |

## 四、验收清单（对应任务第十三节）

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 查询一只 A 股历史行情 | ✅ | `CN_A_SHARE_DAILY` 600519，2026-11-16 收 1453.9、2026-11-17 收 1460.0（AKShare 日线）；现网实时 1457.7 |
| 2 | 获取指定公司有效财务指标 | ✅ | `CN_A_SHARE_FINANCIALS` 600519，2026-09-30 摊薄 EPS 53.3702、每股净资产 224.3226 |
| 3 | 获取最新中国 CPI | ✅ | `CN_MACRO_CPI` 最新期 2026年10月份，全国同比 0.7% |
| 4 | 区分社融增量与存量 | ✅（增量可用/存量缺失并已建证据请求） | `CN_CREDIT_TSFIN_FLOW` 最新 202604=6245 亿元，单位标注“增量，非存量”；`CN_CREDIT_TSFIN_STOCK` 标记不可用并创建 Evidence Request `evr-mwkctons-lhyx` |
| 5 | 获取一份财政部官方财政收支报告 | ⚠️ 部分 | `CN_FISCAL_REVENUE` 2026-09 当月 15659 亿元（东部财富-财政收入口径）已可用；**财政部官网原始报告未做程序化采集**，列为需人工/证据补充（见审计文档 D 类） |
| 6 | 获取 A 股公司公告并保留来源 | ✅ | 现网 `announcements`（东财）实测 600519 公告 1079 条，含 `sourceUrl`；AKShare 公告接口 SSL 失败已改为复用现有能力 |
| 7 | 多 Provider 冲突时标记差异 | ✅（机制+测试） | `compareCnSeries()` 对同期两源做逐期比对，输出 `match/mismatch/missing` 与 `difference`，不掩盖差异；`test_cn_datasets` 覆盖 |
| 8 | 免费数据源失败时正确回退 | ✅ | WeStock 探测修正后可执行；`get_dividend→dividend_plan`、`get_margin_trade→margin_detail`、`get_notice_list→announcements`、指数 `index_zh_hist_em→index_zh_daily_sina` |
| 9 | 返回数字具有时间与单位 | ✅ | 所有数据集返回 `unit`、`asOf`（最新统计期）、`fetchedAt`（抓取时间）；桥测试断言缺失为 `null` 不补 0 |
| 10 | 无法获取关键数据时生成 Evidence Request | ✅ | 已创建 `evr-mwkctons-lhyx`（社融存量） |
| 11 | 未确认授权数据不自动批量下载 | ✅ | 政策源国际条目默认 `enabled:false/manual`；BaoStock 未启用；无破解/绕过 |
| 12 | 原有插件、行情、持仓正常 | ✅ | regressions 19、quant 28、policy 46、evidence 13、capital 21、wealth 19、investment 23、learn 14 全通过；前端契约 21 套全通过 |
| 13 | 数据源 UI 显示真实健康状态 | ✅（代码+静态测试） | `CnDatasetsPanel` 显示桥接健康、每个数据集状态文字（已验证/未测试/需要配置/不可用/过期）；**真实浏览器渲染未验证** |
| 14 | 公开代码不含私人数据 | ✅ | 仓库 `.gitignore` 排除 `data/`；仅 `data/mcp-secrets.example.json` 入库 |
| 15 | 每项成功声明有实测证据 | ✅ | 本报告与 `docs/free-cn-datasets.md` 均注明实测日期与数值 |

## 五、自动化测试（本次新增）

| 测试 | 组数 | 说明 |
| --- | --- | --- |
| `test_cn_datasets` | 9 | 归一化/缺失不为 0/缓存/失败不缓存/桥注册表 19+ 数据集/冲突比对 |
| `test_cn_datasets_ui` | 21 | 状态映射、过期判定、失败不显示成功、样式作用域 |
| `test_docs_contracts` | 88 | 三份文档关键条目与 Provider 字段 |
| `test_global_quotes` | 10 | 含 WeStock `.exe` 探测修复的静态断言 |

## 六、已知缺口（不掩盖）

1. 社融**存量**、财政**支出**、国债**发行**、指数成分、行业细分、A股估值（用现有 dossier）、基金完整持仓（用 fund_dossier）——未接入，已在注册表标记 `available:false` 并写原因。
2. BaoStock 因端口 10030 不通未启用。
3. 财政部/工信部等官网原始报告未做程序化采集，属“公开网页/人工或证据补充”类别。
4. 真实浏览器视觉验收未执行（无已连接 CDP 浏览器），UI 仅静态契约验证。
5. Evidence Request `evr-mwkctons-lhyx` 的 `expectedReportingPeriod` 字段因调用格式串扰存在多余文本，以 question 与 requiredUnits 为准。
