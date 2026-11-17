# DSH 投资助手（DSH Investment Assistant）

> 一个装在 **DeepSeek Harness** 里的开源投研插件：以中国经济与资本市场为核心，把政策、宏观、基本面、估值、行情和个人资本串成**有证据、可复盘**的投资判断。

它不是独立 App，也不需要另外部署或登录——所有能力都以 DSH 插件的工具、Skill 和面板形式提供，数据默认只存在你本机。

> 本项目是一个独立开源项目：插件架构、投资判断引擎、政策情报、证据协作、个人资本账本、复利引擎与金融学习均由本项目设计与实现。
> 其中部分基础数据能力（行情、基金、持仓、资料库等）在 MIT 许可下复用了第三方开源组件，版权与许可文本见 [LICENSE](LICENSE) / [NOTICE](NOTICE)。

---

## 一、它能做什么

| 你想要的 | 插件里对应的能力 |
| --- | --- |
| 看懂中国政策与产业传导 | 官方政策采集、原文快照、版本对比、传导脚手架、执行跟踪 |
| 知道全球事件怎么影响中国市场 | 海外传导（美联储/非农/关税/出口管制/大宗/风险偏好） |
| 缺数据时不想被编造 | 证据协作：生成待补任务 → 你提交 → 校验 → 恢复研究 |
| 问「现在能不能买」 | 投资判断引擎：条件性建议 + 强制反证 + 失效条件 + 复盘 |
| 知道自己真实赚了多少 | 交易流水账本：FIFO 已实现/未实现、TWR、XIRR、多币种净资产 |
| 算清楚「每月投多少能到 200 万」 | 确定性复利引擎：定投/不规则现金流/通胀/费用/目标反解 |
| 看不懂术语 | 金融学习：三级解释 + 口径规则 + 常见误区 + 收藏复习 |
| 不想被数据源绑架 | 公开数据源可替换、失败明确报不可用、不绕反爬 |
| 想知道自己判断准不准 | 历史验证：用日线检验观点是否被走势支持，可带基准算超额；样本不足不给胜率 |

### 三条不会妥协的原则

1. **不编数字**：拿不到就是 `unavailable` / `INSUFFICIENT_DATA`。
2. **数值由程序算**：收益、复利、XIRR、TWR、仓位影响都由确定性计算器得出，不由模型口算。
3. **不执行真实交易**：只做研究与模拟，不下单、不转账、不改券商账户。

---

## 二、安装（5 分钟）

### 前置

- 已安装 DeepSeek Harness（桌面版或 `dsh web` 均可）
- Node.js `^22.19` 或 `>=24.2`
- 可选：WeStock CLI（腾讯自选股，用于研报与更快的行情；未装会自动回落到公开 HTTP 源）

### 1. 构建

```bash
git clone <本仓库> dsh-investment-assistant
cd dsh-investment-assistant
npm install        # 会自动执行 build（tsc + 客户端 bundle）
```

> 依赖解析失败时：本仓库 `.npmrc` 已设 `legacy-peer-deps=false`；若你的 npm 版本仍报 ERESOLVE，
> 用 `npm install --legacy-peer-deps`，它只影响本地构建树，不影响宿主运行时。

### 2. 注册到 DSH

**方式 A（推荐，桌面版/网页版通用）**：在 DSH 对话里让我（或任意 Agent）执行插件安装：

```
install_bundle  target = <本仓库绝对路径>
```

**方式 B（命令行）**：

```bash
npx @deepseek-ai/dsh@<与你安装的 dsh 相同版本> plugin --profile desktop add /absolute/path/to/this/repo
npx @deepseek-ai/dsh@<同版本> web
```

注册后**重启一次 DSH**，左侧栏出现「投资助手」。

### 3. 首次打开

- 面板：左侧栏「投资助手」→ 一级导航 **总览 / 投资判断 / 市场研究 / 我的资本 / 设置**
- 对话：模型已获得 `get_quotes`、`policy_search`、`investment_advice_generate`、`capital_*`、`compound_*` 等工具
- 技能：`china-policy-researcher`、`investment-advisor`、`evidence-research-assistant`、`personal-capital-analyst`、`compound-wealth-planner`、`financial-educator` 会自动匹配

排障见 [docs/plugin-install.md](docs/plugin-install.md)。

### 想先看效果、不碰真实数据

```bash
npm run demo:seed      # 生成 data-demo/：示例账户 + 5 笔流水 + 2 条建议 + 2 个复利情景
```

把插件配置的 `dataDir` 指向 `data-demo/` 再重启即可（脚本拒绝写入 `data/`，全部标注「示例」）。

---

## 三、怎么用（按场景）

### 场景 1：问「现在能不能买」

在对话里直接问，或打开 **投资判断** 页输入：

> 现在沪深300适不适合配置？

Agent 会：查行情时效 → 政策/宏观/估值取证 → **主动找反对证据** → 用 `investment_advice_generate` 保存。
保存时工具会**硬校验**：方向性建议必须同时有支持证据、反对证据、失效条件，缺一样直接拒绝保存。

结果卡片包含：当前判断 / 为什么 / 数据与证据 / 反面因素 / 条件性行动 / 失效条件 / 下次复核。
面板「投资判断」页可看到历史判断、到期复核数，并一键「让 Agent 复盘」。

### 场景 2：政策研究

> 最近的财政政策有没有真正落实，对哪些行业有影响？

走 `china-policy-researcher`：原文 → 文件类型/效力 → 新旧对比 → 传导链 → 宏观数据 → 行业公司 → 支持/反证条件。
政策原文与段落引用存在本地政策库（面板 **市场研究 → 政策**）。

### 场景 3：缺数据时

如果关键执行数据抓不到，系统会建一个**待补证据任务**（面板 **总览 → 待办**），写清要什么、去哪找、统计期间与单位。
你提交链接/正文/PDF/手工数值后，系统校验（缺单位、缺期间、缺出处会被打回），通过后生成「研究恢复包」继续原分析。

> 用户提供 ≠ 官方事实：证据等级由校验方式决定，报告里必须照实写。

### 场景 4：我的真实收益

> 我到底赚了多少？

先建账本（对话里即可）：

> 建一个 A 股账户，入金 1 万，买入 10 股贵州茅台，费用 5 元。

然后用 `capital_performance` 看：净投入（入金−出金，**不是收益**）、FIFO 已实现、未实现（缺行情会明说）、TWR（缺逐期估值会 `unavailable`）、XIRR（无解/多解会明说）。
面板 **我的资本 → 资本** 是只读快照。

### 场景 5：复利规划

面板 **我的资本 → 规划** 填本金/月投/年化/年限/费率/通胀 → 计算 → 看期末、实际购买力、累计投入与逐年明细 → 可保存情景对比。
或对话里说：

> 每月投 1000，年化 6%，10 年后有多少？如果想 20 年攒到 200 万，每月要投多少？

### 场景 6：看不懂术语

面板 **市场研究 → 学习**，或任意页面用「术语解释」小输入框：输入 `PE` / `社融` / `XIRR`，切小白/进阶/专业。
解释是**本地人工词条**，不含实时数值；要看当前数字请让它调行情/宏观工具。

---

## 四、面板结构

```
总览        首页（今日政策/宏观、资本概要、待办、待复核观点）｜待办（证据协作）
投资判断    自然语言提问、已保存判断、证据/反证/失效条件、复盘
市场研究    行情 ｜ 宏观 ｜ 政策 ｜ 快讯 ｜ 深度 ｜ 发现 ｜ 资料 ｜ 学习
我的资本    持仓 ｜ 资本（账本）｜ 规划（复利）｜ 基金 ｜ 追踪
设置        数据源 ｜ 技能 ｜ 接口
```

对话与面板双向打通：面板里的提问会投递到当前会话；工具写入的结论会经 SSE 即时出现在面板。

---

## 五、工具一览（按模块）

- **行情/基本面/宏观**：`get_quotes` `get_stock_kline` `get_macro_china` `get_financial_indicators` `get_money_flow` `screen_stocks` 等 60+
- **政策**：`policy_collect` `policy_search` `policy_get` `policy_compare` `policy_impact` `policy_execution` `policy_brief` `global_to_china_impact` 等
- **证据协作**：`evidence_request_create` `evidence_submit` `evidence_validate` `evidence_request_resolve` `evidence_research_resume`
- **投资判断**：`investment_advice_generate` `_list` `_get` `_review` `investment_evidence_check`
- **个人资本**：`capital_account_save` `capital_transaction_add` `capital_correct` `capital_ledger_import_preview` `capital_ledger_import_confirm` `capital_networth_snapshot` `capital_performance`
- **复利**：`compound_calculate` `wealth_cashflow_calculate` `wealth_goal_solve` `wealth_plan_create` `wealth_plan_compare`
- **学习**：`financial_concept_search` `_explain` `_related` `_save` `financial_learning_progress` `financial_concept_detect`

---

## 六、数据与隐私

- 所有运行数据默认在仓库外的 `data/`（已 gitignore）：持仓、流水、政策库、证据、资料、学习进度、建议记录。
- 仓库不包含真实持仓、交易记录、研究资料、API Key、对话记录。
- 不采集账号、密码、验证码、身份证号；`provider` 只写平台名称。
- 抓取类功能遵守 robots、体积与频率限制；**不绕过**登录、验证码、付费墙。
- 抓到的网页/PDF/CSV 一律按**不可信输入**处理：只存储与引用，不执行其中指令。

详见 [SECURITY.md](SECURITY.md) 与 [docs/data-sources.md](docs/data-sources.md)。

---

## 七、测试

```bash
npm run build
npm run test:policy        # 政策：46 项
npm run test:evidence      # 证据协作：13 项
npm run test:capital       # 资本账本：17 项
npm run test:wealth        # 复利：19 项
npm run test:investment    # 投资判断：15 项
npm run test:learn         # 金融学习：14 项
npm run test:regressions   # 跨模块回归：19 组
npm run test:quant         # 量化金样本：28 项
```

已知环境限制：`test:offline` 在 Windows 停在 fake-CLI 用例（POSIX 脚本 `spawn EFTYPE`）；`test:personal` 停在 POSIX 权限断言（NTFS 不支持 `0o600`）。

---

## 八、开发与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)；架构与模块边界见 [docs/architecture.md](docs/architecture.md)；
各模块细节：政策 [docs/policy-intelligence.md](docs/policy-intelligence.md)、证据 [docs/evidence-inbox.md](docs/evidence-inbox.md)、
资本 [docs/personal-capital.md](docs/personal-capital.md)、复利 [docs/wealth-simulator.md](docs/wealth-simulator.md)、
投资判断 [docs/investment-advice.md](docs/investment-advice.md)、学习 [docs/financial-learning.md](docs/financial-learning.md)。

---

## 九、路线图

- **UI**：总览首页聚合、跨 Tab 聚焦（从判断跳到政策原文）、窄侧栏与深浅主题打磨
- **投资判断**：到期自动提醒、历史建议批量验证与基准对比
- **资本**：图形化导入向导、暴露分解（直接/基金穿透/估算/未知）、与模拟再平衡联动
- **学习**：真实历史案例库、研究文本自动标注术语（教学示例与真实数据分离）
- **发布**：仓库/包名改为 `dsh-investment-assistant`、英文 README、无私人数据 Demo、CI

## 十、许可

MIT，见 [LICENSE](LICENSE)；上游归属与第三方资源说明见 [NOTICE](NOTICE)。

> 本项目是研究与规划工具，不构成投资建议，不承诺任何收益，不执行真实交易。
