# 投资助手

装在 DeepSeek Harness 里的开源投研插件。给它一个标的、一份政策或者一个问题，它去取真实数据、留下出处，然后给一个能被推翻的结论。

它不做选股。它做的事更窄：把「我为什么这么想」写下来，标好数据时点，几周后回来打自己的脸。

投资里难的不是找观点，是记住自己当初凭什么这么想。这一步通常没人做，因为太麻烦。这个插件把它固定成流程。

![投资助手演示：总览 → 组合策略（示例数据）](<docs/images/demo.gif>)



## 装完能用它做什么

- **看一只股票**：行情、K 线、财务、资金流、公告、股东，附来源与数据时点
- **看一份政策**：原文入库、段落级引用、版本差异、往行业和公司的传导链
- **要一个判断**：条件性结论 + 支持证据 + 反对证据 + 失效条件 + 下次复核日
- **算清真实收益**：交易流水账本，FIFO 已实现/未实现、TWR、XIRR、多币种净资产
- **做规划**：定投终值、目标反解、通胀后的购买力
- **看整个组合**：权重、集中度、漂移、换手；多资产纸面再平衡；策略版本与审批
- **缺数据时**：生成待补任务，你交材料，校验通过后接着原来的研究往下做

## 快速开始

需要 DeepSeek Harness（桌面版或 `dsh web` 都行）和 Node `^22.19` 或 `>=24.2`。装上 WeStock CLI 的话行情和研报更全，没装会自动回落到公开 HTTP 源。

```bash
git clone https://github.com/zikang-chen/DSH-Investment-Assistant.git
cd DSH-Investment-Assistant
npm install
```

在 DSH 对话里让 Agent 执行插件安装，target 填这个仓库的绝对路径：

```
install_bundle  target = <本仓库绝对路径>
```

然后重启一次 DSH，左侧栏出现「投资助手」。

不想一开始就碰真实数据，先生成一份示例：

```bash
npm run demo:seed
```

它写出 `data-demo/`（示例账户、5 笔流水、2 条建议、复利情景），把插件配置里的 `dataDir` 指过去再重启就能看效果。脚本不会写 `data/`。

## 用起来是什么样

**「现在沪深 300 适不适合配置？」**

先看行情时效，再查政策、宏观、估值，然后必须补两条反对证据 —— 补不出来，这次判断存不下来。返回的卡片是这样：

```
判断 / 依据 / 数据时点 / 反面因素
什么条件下可以做 / 什么情况说明我错了 / 下次复核日期
```

![投资判断详情页（示例数据）](<docs/images/advice-light.png>)

**「最近的财政政策有没有真正落实，对哪些行业有影响？」**

原文入库 → 判断它是讲话还是规范性文件 → 跟上一版比改了什么 → 财政、货币、产业渠道 → 相关宏观数据 → 落到行业与公司 → 支持条件和证伪条件。

**「我今年到底赚了多少？」**

前提是有流水。对话里录几笔就行：建一个 A 股账户，入金 1 万，买入 10 股贵州茅台，费用 5 元。然后它会给你净投入（这不等于收益）、FIFO 已实现、未实现（缺行情会直说）、TWR（缺逐期估值就是 unavailable）、XIRR（无解或多解都会讲清楚）。

**「我这个组合是不是太集中了？」**

投资判断 → 组合策略。填当前/目标权重和风险预算，它算集中度、漂移、双边换手，并对比约束是否被突破。需要的话跑一次多资产纸面再平衡，分红、拆股、费用和税费分开记账。策略改动存成新版本，批准只代表允许纸面跟踪。

![组合策略页（示例数据）](<docs/images/portfolio-light.png>)

## 面板

```
总览      工作台 · 证据待办
投资判断  研究判断 · 组合策略 · 档案与复盘
市场研究  行情 · 宏观 · 政策 · 新闻 · 证券档案 · 筛选发现 · 基金研究 · 机构追踪 · 资料库
我的资本  持仓与自选 · 账户与收益 · 规划与目标 · 金融学习
设置      数据源 · 技能 · 接口
```

面板和对话是通的：面板里提的问题会投递到当前会话，工具写完的东西会即时出现在面板上。

深色主题与窄屏（390px）：

![深色主题](<docs/images/overview-dark.png>)
![窄屏](<docs/images/overview-mobile.png>)

## 三条写进代码的规矩

1. 拿不到的数字就是 `unavailable`，不猜、不补零。
2. 收益、复利、XIRR、TWR、仓位影响一律由确定性计算器算，模型不口算。
3. 不接券商、不下单、不转账。

## 它做不到什么

- **不是实时行情**。日线按需刷新，受上游缓存和交易所时间影响，没有逐笔推送。
- **免费源会坏**。某个接口挂了会明确报错，不会拿旧数据或示例数字填坑。
- **政策不等于业绩**。白皮书是方向，它不会把「支持」直接翻译成「买入」。
- **组合回测是纸面的**。缺公司行动或税表时只给部分口径，不会说成完整总回报。
- **界面没做全量浏览器验收**。窄屏下的排版和个别交互还没逐个测过。

## 数据与隐私

运行数据在插件目录的 `data/`（已在 `.gitignore` 排除），也可以用 `dataDir` 搬到别处。仓库里没有真实持仓、流水、研究资料、API Key 和对话记录。

抓取遵守 robots 和频率限制，不绕登录、验证码和付费墙。抓到的网页、PDF、CSV 一律当不可信输入：只存和引用，不执行里面的指令。

依赖的公开数据源和实测状态见 [docs/data-source-audit.md](<docs/data-source-audit.md>)。

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

Windows 上 `test:offline` 会挂在 fake-CLI 用例（POSIX 脚本报 `spawn EFTYPE`），`test:personal` 挂在 POSIX 权限断言（NTFS 没有 `0o600`）。

## 文档

| 想了解 | 看 |
| --- | --- |
| 安装、研究工作流、排障 | [完整使用与维护手册](<docs/complete-guide.md>) |
| 组合策略怎么设计 | [产品方案](<docs/portfolio-strategy-design.md>) · [回测核验审批](<docs/portfolio-workflows.md>) |
| K 线与事件口径 | [K 线与事件](<docs/history-kline.md>) |
| 政策与白皮书采集 | [政策采集](<docs/policy-collection.md>) |
| 有哪些数据源、实测状态 | [数据源审计](<docs/data-source-audit.md>) · [中国免费数据集](<docs/free-cn-datasets.md>) |
| 页面为什么这样组织 | [页面跳转与内容分工](<docs/product-navigation.md>) |
| Windows 环境问题 | [Windows 运行说明](<docs/windows-powershell-fix.md>) |
| 架构、贡献、安全 | [架构](<docs/architecture.md>) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) |

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

这是一个研究与规划工具：不构成投资建议，不承诺任何收益，不执行真实交易。
