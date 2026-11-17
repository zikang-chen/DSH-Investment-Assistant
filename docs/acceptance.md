# 验收清单（Acceptance）

> 对照需求书的 Phase 0–6 与「金融学习」新增模块，逐条给出可核对的产物与验证方式。
> 本文件只记录**已实际执行并通过**的检查；未完成项在末尾「已知限制」里如实列出。

## 0. 运行环境（本机实测）

| 项目 | 值 |
| --- | --- |
| 插件形态 | DeepSeek Harness 插件（`link:` 挂载到 `desktop` profile），非独立应用 |
| 归属 | 独立项目；部分基础数据能力复用 MIT 许可第三方组件（版权与许可见 LICENSE / NOTICE） |
| 包名 | 仍为 `dsh-finance`（安装身份；改名需同步 profile，见「已知限制」） |
| Node | 24.x（要求 `^22.19` 或 `>=24.2`） |
| 分支 | `feat/investment-advisor`，69 个提交 |

## Phase 0：代码审计与插件兼容

- [x] 确认真实仓库结构、版本、许可证、测试与数据安全（`data/` 已 gitignore）
- [x] 发布前审计：`git ls-files data` 仅 `data/mcp-secrets.example.json`；无个人路径、无密钥
- [x] 备份存在：`D:\finance_ds-backup-*`（两处）

## Phase 1：重命名与统一界面

- [x] 面板标题 / 侧栏入口 / 设置卡片 → 「投资助手」
- [x] 一级导航五入口：总览 / 投资判断 / 市场研究 / 我的资本 / 设置（`src/client/index.tsx` 的 `TAB_GROUPS`）
- [x] 首页总览聚合：中国政策变化 / 研究待办 / 到期复核 / 资本概要（`OverviewAggregate`）
- [x] 深浅主题沿用宿主 design token（`V()`），窄侧栏自适应（`auto-fit` 网格）

## Phase 2：投资建议引擎（核心）

- [x] `src/invest/schema.ts`：6 类建议 + 证据结构 + **硬校验**
  - 方向性建议必须同时有支持证据、反对证据、失效条件；
  - 每条证据必须带 `source` + `asOf`；
  - `INSUFFICIENT_DATA` 必须列缺口且**不得**带行动方案；
  - 价格区间必须引用 `calculationRefs`；数据时效必填。
- [x] `src/invest/store.ts`：建议落库 + 复盘追加（append-only，不改原判断）+ `dueForReview`
- [x] `src/invest/tools.ts`：`generate / list / get / review / due / evidence_check / verify`
- [x] `src/invest/verify.ts`：历史验证（supported/contradicted/inconclusive/unverifiable）
- [x] 面板「投资判断」页：提问、列表、详情（判断/证据/反证/失效条件/缺口/复盘）、验证与复盘入口
- [x] Skill `investment-advisor`（七段式输出、中国政策优先顺序、反模式清单）
- [x] 测试 `test:investment`：**23 passed**

## Phase 3：政策与知识库整合

- [x] 政策模块复用：`policy_search / policy_get / policy_compare / policy_impact / policy_execution / global_to_china_impact`
- [x] 证据协作复用：`evidence_request_create / submit / validate / resolve / research_resume`
- [x] 建议→政策联动：证据里的 `pol-*` 可一键跳到政策页并聚焦该文档
- [x] `investment_evidence_check`：校验引用的政策/资料/证据 id 是否真实存在（不存在就 not-found）
- [x] 资料库与学习模块复用（`relatedLessons` 指向成长微课，不重复造课程）
- [x] 测试：`test:policy` **46**、`test:evidence` **13**

## Phase 4：个人资本联动

- [x] `src/capital/`：13 类事件、append-only、更正事件、CSV 预览→确认双重去重、多币种、FIFO、TWR、XIRR
- [x] `src/capital/exposure.ts`：权重/HHI/有效持仓数/top1/top3/币种暴露；未定价与缺汇率显式列出
- [x] `capital_scenario_simulate`：纸面权重情景（不改账本、标 simulated、不构成买卖建议）
- [x] 面板「我的资本 → 资本」只读快照；`capital_networth_snapshot` 需显式价格与汇率
- [x] 测试 `test:capital`：**21 passed**（含手算参考值 40% / HHI 0.2311 / 情景后 0.52）

## Phase 5：历史验证与持续复盘

- [x] `investment_advice_review`：追加记录，**原始判断、证据、时间不可改写**（有测试）
- [x] `investment_advice_due`：到期清单 + 逾期天数 + 失效条件
- [x] `investment_advice_verify`：autoFetch 自动取日线、可带基准算超额；取不到就报不可用
- [x] 样本 < 20 时明确「不给胜率」；观点验证 ≠ 交易盈亏
- [x] SSE `investment` 事件：保存/复盘后面板即时刷新
- [x] 测试：`test:investment` 覆盖到期清单、复盘不改原判断、验证四态

## Phase 6：开源发布准备

- [x] `README.md`（中，含定位/安装/六场景/面板/工具/隐私/测试/路线图）
- [x] `README.en.md`
- [x] `LICENSE`（MIT，含上游归属）、`NOTICE`（第三方数据与二进制说明）
- [x] `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`.env.example`
- [x] `docs/architecture.md`、`docs/plugin-install.md`、`docs/data-sources.md`、`docs/investment-advice.md`
- [x] CI：`.github/workflows/ci.yml`（Node 22 + npm ci + build + tsc + 六个离线套件 + regressions）
- [x] 演示数据：`npm run demo:seed`（拒绝写 `data/`，目录已存在无 `--force` 拒绝覆盖，全部标注示例）
- [x] 隐私隔离：`data/`、`.env`、`data-demo/` 全部 gitignore；仓库无真实数据

## 金融学习模块（新增需求）

- [x] 38 个概念词条、6 大分类、三级解释（小白/进阶/专业）
- [x] 口径规则与常见误区（社融增量≠存量、GDP 同比/环比/累计、PMI 环比扩散指数…）
- [x] 别名归一（PE / P/E / 市盈率 → `pe`），不同口径不合并
- [x] 上下文解释：带页面/数值/期间时给「怎么读这个数」，**无值时绝不生成数字**
- [x] 学习进度：seen / understood / favorite / review + viewCount，持久化
- [x] 工具 6 个；面板「市场研究 → 学习」页；投资判断页内嵌「术语解释」
- [x] Skill `financial-educator`
- [x] 测试 `test:learn`：**14 passed**

## 全量验证（最近一次真实执行）

| 检查 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 0 error |
| `npm run build` | 通过，客户端 bundle 832,552 字节 |
| `npm run test:policy` | 46 passed |
| `npm run test:evidence` | 13 passed |
| `npm run test:capital` | 21 passed |
| `npm run test:wealth` | 19 passed |
| `npm run test:investment` | 23 passed |
| `npm run test:learn` | 14 passed |
| `npm run test:regressions` | 19 组通过 |
| `npm run test:quant` | 28 passed |
| 工具注册点 | 137 处 `ctx.tools.register(defineTool…)` |
| 面板一级导航 | 5 组，与需求一致 |
| 仓库跟踪的 data 文件 | 仅 `data/mcp-secrets.example.json` |

## 已知限制（如实列出）

1. **推送远端未完成**：本机 GitHub 凭据/Token 对被推仓库只有读权限（Git 与 API 写入均 403）。
   本地仓库与 `D:\DSH-Investment-Assistant` 已同步到 72 个提交、内容一致，只差一次带写权限的 push。
2. **UI 未在浏览器逐页点击验证**：面板只验证了构建产物包含各页面与导航结构；重启宿主后需人工确认。
3. `test:offline` / `test:personal` 在当前 Windows 环境失败于既有问题（POSIX fake CLI 的 `spawn EFTYPE`、`0o600` 权限断言），与本轮功能无关。
4. 包名与仓库名尚未迁移（`dsh-finance` → `dsh-investment-assistant`）：改名会改变 profile 安装身份，需单独评估。
5. 政策来源多数为手工导入（详情见 `docs/data-sources.md`）；真实抓取能力受站点渲染方式限制。
6. 未做：历史建议批量统计面板、资本导入图形化向导、蒙特卡洛/历史分布模拟、总览首页自定义布局。
