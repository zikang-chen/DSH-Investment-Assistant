# 投资助手

装在 [DeepSeek Harness](https://github.com/deepseek-ai) 里的开源投研插件。

[![CI](https://github.com/zikang-chen/DSH-Investment-Assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/zikang-chen/DSH-Investment-Assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

把行情、财务、政策原文、宏观数据、个人流水和个人判断放进同一个插件。每个结论带来源与数据时点，存下来的判断会在设定的日期回到你面前重新核对。数据只写本机 `data/`，不接券商、不下单。

![面板演示（示例数据）](<docs/images/demo.gif>)

## 适合谁

- 用多个账户持有 A 股、ETF、基金，想看清真实暴露而不只是持仓列表
- 把政策原文、宏观数据、公司财报放在一起看传导，而不是读二手解读
- 想留下「当时为什么这么判断、什么情况说明我错了」，隔一段时间回来对账
- 不想把持仓和流水交给第三方云服务

## 安装

前置：DSH（桌面版或 `dsh web`）、Node.js `^22.19` 或 `>=24.2`。WeStock CLI 可选，用于扩展行情与研报覆盖。

```bash
git clone https://github.com/zikang-chen/DSH-Investment-Assistant.git
cd DSH-Investment-Assistant
npm install
```

在 DSH 对话里让 Agent 安装本仓库，target 填绝对路径：

```
install_bundle  target = <本仓库绝对路径>
```

重启 DSH，左侧栏出现「投资助手」。想先看界面，生成一份示例数据：

```bash
npm run demo:seed      # data-demo/：示例账户、5 笔流水、2 条建议、复利情景
```

把插件配置里的 `dataDir` 指向 `data-demo/` 再重启即可。

## 功能

- A 股 / 港股 / 美股 / 全球指数：日 K、分时与 5 日分时（四个看盘入口同一套切换与画法）、财务、资金流、公告、股东、分红
- 基金净值、经理、规模、重仓、同类排名，多基金阶段收益与相关性对比；场内 ETF 另有成交价走势
- Agent 可直接取分钟数据：`get_intraday_data`（A/H/美/全球 secid，1 或 5 日，带来源与时区分页）
- 政策原文采集与入库：段落级引用、版本对比、传导链、执行进度跟踪
- 宏观数据：统计局、人民银行、财政部，以及 OECD / Eurostat / ECB 等海外序列
- 投资判断：条件性结论、支持证据、反对证据、失效条件、下次复核日
- 个人资本：账户、交易流水、FIFO 已实现、未实现、TWR、XIRR、多币种净资产；流水可在页面直接查询
- 复利规划：定投终值、不规则现金流、目标反解、通胀后购买力
- 组合策略：当前组合 → 目标与预算 → 漂移与换手 → 保存与审批；多资产纸面再平衡与版本管理
- 证据协作：缺资料时生成待补任务，提交后校验，再接着原来的研究
- 数值带元信息：单位/时点/窗口/来源/新鲜度/冲突标记，缺数据就写缺失
- 金融术语三级解释，可收藏复习

## 用法

在对话里直接问，或打开面板对应页面。下面是三个实际会跑的流程，截图均为示例数据。

**问一只股票**

> 沪深300估值处于历史中位，现在做长期配置是否合适？

Agent 核对行情时效，查政策、宏观和估值，补足反面证据后给出条件性结论。保存的记录包含判断、依据、数据时点、反面因素、失效条件和复核日期。

![投资判断详情（示例数据）](<docs/images/advice-light.png>)

**问一份政策**

> 最近的财政政策有没有真正落实，对哪些行业有影响？

原文入库 → 判定是讲话还是规范性文件 → 与上一版比较改动 → 财政、货币、产业渠道 → 相关宏观数据 → 落到行业与公司 → 给出支持与证伪条件。

**问自己的收益**

> 我今年到底赚了多少？

先录几笔流水：建一个 A 股账户，入金 1 万，买入 10 股贵州茅台，费用 5 元。之后可以拿到净投入（不等于收益）、FIFO 已实现、未实现、TWR、XIRR。

**看组合**

投资判断 → 组合策略。填当前和目标权重、现金和风险预算，得到集中度、漂移、双边换手与约束检查；跑多资产纸面再平衡，分红、拆股、费用与税费分开记账；策略改动存新版本，批准后按版本跟踪。

![组合策略页（示例数据）](<docs/images/portfolio-light.png>)

## 面板

```
总览      工作台 · 证据待办
投资判断  研究判断 · 组合策略 · 档案与复盘
市场研究  行情 · 宏观 · 政策 · 新闻 · 证券档案 · 筛选发现 · 基金研究 · 机构追踪 · 资料库
我的资本  持仓与自选 · 账户与收益 · 规划与目标 · 金融学习
设置      数据源 · 技能 · 接口
```

面板与对话互通：面板提交的问题会投递到当前会话，工具写入的结果会即时出现在面板。深色主题与窄屏：

![深色主题](<docs/images/overview-dark.png>)
![窄屏 390px](<docs/images/overview-mobile.png>)

## 数据源

行情与 K 线优先东方财富，失败回落到腾讯与新浪，每个来源都在面板「数据源」页可见并可调整顺序。政策采集默认放行（不检查 robots），可用 `respect_robots=true` 恢复检查；抓取有硬预算（链接数、路径前缀、URL 正则、整轮时限、渲染页数），支持 `dry_run` 先看计划。不绕过登录、验证码和付费墙；抓到的网页与 PDF 作为资料引用，不执行其中指令。脚本渲染的列表页可用 `render_js` 走本机 Chrome 的 CDP 取渲染后 DOM。

运行数据在插件目录 `data/`（已排除在版本控制外），可用 `dataDir` 迁移。仓库不含持仓、流水、研究资料、API Key 与对话记录。

数据源清单与实测状态见 [docs/data-source-audit.md](<docs/data-source-audit.md>)。

## 开发

```bash
npm run build

npm run test:intraday        # 分时：解析/完整性/图形/Agent 工具/备用源
npm run test:market-integrity # 行情身份、时效、超时与取消、图表边界
npm run test:metric          # 数值元信息/时段/财政部曲线解析
npm run test:portfolio       # 组合策略与回测装配
npm run test:capital         # 账本、绩效、页面契约
npm run test:policy          # 政策采集、解析与执行进度
npm run test:instrument-focus # 当前标的身份/持久化/降级
npm run test:instrument-related # 标的关联与今日要点
npm run test:team-plan       # 研究小组分工简报与边界
npm run test:review-safety   # 研究正文与证据请求的竞态/丢稿
npm run test:product-copy    # 可见文案只查界面文本
npm run test:regressions     # 跨模块回归
npm run test:ui-contracts    # 面板交互契约
```

文档截图由 `npm run docs:images` 生成：无头 Chrome 渲染真实组件，数据是 fixture，说明见 [tools/demo](<tools/demo/README.md>)。

Windows 上 `test:offline` 与 `test:personal` 依赖 POSIX 脚本语义，会在对应断言处停下。

## 文档

| 主题 | 文档 |
| --- | --- |
| 安装、研究工作流、排障 | [完整使用与维护手册](<docs/complete-guide.md>) |
| 组合策略设计 | [产品方案](<docs/portfolio-strategy-design.md>) |
| 组合回测、核验、审批 | [工作流说明](<docs/portfolio-workflows.md>) |
| K 线、分时与事件口径 | [K 线与事件](<docs/history-kline.md>) · [Agent 分时取数](<docs/agent-intraday.md>) |
| 研究小组分工 | [分工与边界](<docs/multi-agent-orchestration.md>) |
| 数值口径与数据缺口 | [数值元信息](<docs/data-metrics.md>) |
| 政策与白皮书采集 | [政策采集](<docs/policy-collection.md>) |
| 数据源与实测状态 | [数据源审计](<docs/data-source-audit.md>) · [中国免费数据集](<docs/free-cn-datasets.md>) |
| 页面组织与跳转 | [页面跳转](<docs/product-navigation.md>) |
| Windows 环境 | [运行说明](<docs/windows-powershell-fix.md>) |
| 架构、贡献、安全 | [架构](<docs/architecture.md>) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) |

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

研究与规划工具，不构成投资建议。
