# 投资助手

装在 [DeepSeek Harness](https://github.com/deepseek-ai) 里的开源投研插件。

[![CI](https://github.com/zikang-chen/DSH-Investment-Assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/zikang-chen/DSH-Investment-Assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

`dsh-investment-assistant` 把行情、财务、政策原文、宏观数据、个人流水和个人判断放在同一个插件里。所有结论都要带来源和数据时点，保存下来的判断可以几周后回来复核。插件运行在 DSH 内部，数据只写本机 `data/`，不连接券商，不下单。

![面板演示（示例数据）](<docs/images/demo.gif>)

## 适合谁

- 用多个账户持有 A 股、ETF、基金，想看清真实暴露而不只看持仓列表
- 需要把政策原文、宏观数据、公司财报放在一起看传导，而不是读二手解读
- 想留下「当时为什么这么判断、什么情况说明我错了」，过一段时间回来核对
- 不想把持仓和流水交给第三方云服务

## 安装

前置：DSH（桌面版或 `dsh web`）、Node.js `^22.19` 或 `>=24.2`。WeStock CLI 可选，装了行情和研报更全，不装会自动回落到公开 HTTP 源。

```bash
git clone https://github.com/zikang-chen/DSH-Investment-Assistant.git
cd DSH-Investment-Assistant
npm install
```

在 DSH 对话里让 Agent 安装本仓库，target 填绝对路径：

```
install_bundle  target = <本仓库绝对路径>
```

重启 DSH，左侧栏出现「投资助手」。只想先看界面、不碰真实数据：

```bash
npm run demo:seed      # 生成 data-demo/：示例账户、5 笔流水、2 条建议、复利情景
```

把插件配置里的 `dataDir` 指向 `data-demo/` 再重启即可。脚本不会写 `data/`。

## 功能

- A 股 / 港股 / 美股行情、日 K、**分时（当日 / 近 5 日）**、财务、资金流、公告、股东、分红
- 基金净值、经理、规模、重仓、同类排名，多基金阶段收益与相关性对比
- 政策原文采集与入库：段落级引用、版本对比、传导链、执行进度跟踪
- 宏观数据：统计局、人民银行、财政部，以及 OECD / Eurostat / ECB 等海外序列
- 投资判断：条件性结论、支持证据、反对证据、失效条件、下次复核日
- 个人资本：交易流水账本、FIFO 已实现、未实现、TWR、XIRR、多币种净资产
- 复利规划：定投终值、不规则现金流、目标反解、通胀后购买力
- 组合策略：权重与集中度、漂移与换手、多资产纸面再平衡、版本与审批
- 证据协作：缺资料时生成待补任务，提交后校验，再恢复原研究
- 金融术语三级解释，可收藏复习

## 用法

在对话里直接问，或打开面板对应页面。下面三个是实际会跑的流程，截图均为示例数据。

**问一只股票**

> 沪深300估值处于历史中位，现在做长期配置是否合适？

Agent 先核对行情时效，再查政策、宏观和估值，并要求补足反面证据；证据不足时结论存不下来。保存的记录包含判断、依据、数据时点、反面因素、失效条件和复核日期。

![投资判断详情（示例数据）](<docs/images/advice-light.png>)

**问一份政策**

> 最近的财政政策有没有真正落实，对哪些行业有影响？

原文入库 → 判定是讲话还是规范性文件 → 与上一版比较改动 → 财政、货币、产业渠道 → 相关宏观数据 → 落到行业与公司 → 给出支持与证伪条件。

**问自己的收益**

> 我今年到底赚了多少？

前提是有流水。对话里录几笔即可：建一个 A 股账户，入金 1 万，买入 10 股贵州茅台，费用 5 元。之后可以拿到净投入（不等于收益）、FIFO 已实现、未实现、TWR、XIRR；缺行情或逐期估值时会直接说明缺什么。

**看组合**

投资判断 → 组合策略。填当前和目标权重、现金和风险预算，得到集中度、漂移、双边换手与约束检查；需要时跑多资产纸面再平衡，分红、拆股、费用与税费分开记；策略改动存新版本，批准只代表允许纸面跟踪。

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

## 边界

- 行情按需刷新，受上游缓存和交易所时间影响，不是逐笔推送
- 免费数据源会失效，失效时明确报错，不用旧值或示例值填充
- 政策文件是方向性材料，不直接等于公司盈利改善
- 组合回测是纸面模拟；缺公司行动或税表时只给部分口径，不称完整总回报
- 当前未做完整浏览器的视觉与交互验收

## 数据与隐私

- 运行数据在插件目录 `data/`，已在 `.gitignore` 排除，也可用 `dataDir` 迁移
- 仓库不包含持仓、流水、研究资料、API Key 和对话记录
- 抓取遵守 robots 与频率限制，不绕过登录、验证码和付费墙
- 抓到的网页和 PDF 按不可信输入处理：只存储、引用，不执行其中指令

数据源清单与实测状态见 [docs/data-source-audit.md](<docs/data-source-audit.md>)。

## 开发

```bash
npm run build

npm run test:policy          # 46
npm run test:investment      # 23
npm run test:capital         # 21
npm run test:wealth          # 19
npm run test:learn           # 14
npm run test:evidence        # 13
npm run test:portfolio       # 组合策略 6 套
npm run test:regressions     # 19 组
npm run test:quant           # 28
```

文档截图由 `npm run docs:images` 生成，用无头 Chrome 渲染真实组件，数据是 fixture，说明见 [tools/demo](<tools/demo/README.md>)。

Windows 下 `test:offline` 会停在 fake-CLI 用例（POSIX 脚本报 `spawn EFTYPE`），`test:personal` 停在 POSIX 权限断言（NTFS 不支持 `0o600`）。

## 文档

| 主题 | 文档 |
| --- | --- |
| 安装、研究工作流、排障 | [完整使用与维护手册](<docs/complete-guide.md>) |
| 组合策略设计 | [产品方案](<docs/portfolio-strategy-design.md>) |
| 组合回测、核验、审批 | [工作流说明](<docs/portfolio-workflows.md>) |
| K 线与事件口径 | [K 线与事件](<docs/history-kline.md>) |
| 政策与白皮书采集 | [政策采集](<docs/policy-collection.md>) |
| 数据源与实测状态 | [数据源审计](<docs/data-source-audit.md>) · [中国免费数据集](<docs/free-cn-datasets.md>) |
| 页面组织与跳转 | [页面跳转](<docs/product-navigation.md>) |
| Windows 环境 | [运行说明](<docs/windows-powershell-fix.md>) |
| 架构、贡献、安全 | [架构](<docs/architecture.md>) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) |

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

## 免责声明

投资有风险，可能损失全部本金。本插件是研究与记录工具，不构成投资建议，不承诺任何收益，不执行真实交易。内置数据来自第三方公开来源，可能存在错误、延迟或中断，使用前请自行核对。

插件作者不对因使用本软件或其中数据造成的任何损失承担责任。文中提及的公司、机构与产品名称仅用于标识，不代表任何关联或背书。
