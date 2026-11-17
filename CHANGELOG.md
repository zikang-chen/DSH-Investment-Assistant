# 变更记录（CHANGELOG）

本项目沿用 [Semantic Versioning](https://semver.org/)；每个阶段的改动都以「可复现的测试」为验收条件。

## [Unreleased]

### Added — 到期复核与实时刷新（Phase 5）
- `AdviceStore.dueForReview(today, horizonDays)`：到期未复核清单（含逾期天数）。
- 工具 `investment_advice_due`：按 `nextReviewAt` 列出到期/即将到期建议及失效条件。
- 建议保存/复盘时经 SSE 推送 `investment` 事件，面板「投资判断」页即时刷新。
- 测试：`test:investment` 增至 17 项（到期清单、复盘后移出清单）。

### Added — 资本暴露与情景（Phase 4）
- `capital_exposure_analyze`：权重（总资产含现金为分母）、HHI/有效持仓数/top1/top3、币种暴露；
  未定价资产进 `unpriced` 且权重为 `undefined`，缺汇率不给单一总额。
- `capital_scenario_simulate`：目标权重调整后的集中度对比（纯纸面，标 simulated）。
- 测试：`test:capital` 增至 21 项。

### Added — 投资建议引擎（Phase 2）
- `src/invest/`：`InvestmentAdvice` 模型与硬校验（方向性建议必须有支持证据 + 反对证据 + 失效条件；
  证据必须带来源与日期；`INSUFFICIENT_DATA` 必须列缺口且不得带行动方案；价格区间必须引用计算方法）。
- 工具：`investment_advice_generate` / `_list` / `_get` / `_review` / `investment_evidence_check`。
- 面板「投资判断」页：自然语言提问、已保存建议、证据/反证/失效条件展示、到期复核提示、复盘入口。
- Skill：`investment-advisor`；文档：`docs/investment-advice.md`。
- 测试：`scripts/test_investment.ts`（15 项）。

### Changed — 界面重命名（Phase 1）
- 面板标题与侧栏入口改为「投资助手」。
- 一级导航改为五个：总览 / 投资判断 / 市场研究 / 我的资本 / 设置。
- 新增「我的资本 → 资本 / 规划」页：账本只读快照、确定性复利计算与情景保存。

### Added — 个人资本账本（P1）
- `src/capital/`：13 类事件的 append-only 流水、更正事件、CSV 预览→确认（双重去重）、
  多币种（缺汇率拒绝加总）、FIFO 已实现/未实现、净投入、XIRR（无解/多解显式）、TWR（缺估值不可用）。
- 工具 9 个；测试 17 项（参考值手算）。

### Added — 复利与财富模拟（P2）
- `src/wealth/`：年有效利率换算、零利率极限式、期初/期末定投、追加金额增长、通胀实际值、
  费后收益、不规则现金流、目标反解、情景保存与对比。
- 工具 5 个；测试 19 项。

### Added — 证据协作（P0）
- `src/evidence/`：状态机 + 去重 + 七类提交 + 硬性校验 + 恢复包；工具 7 个；面板「待办」页；测试 13 项。

### Added — 中国政策情报
- `src/policy/`：官方 allowlist（统计局 RSS 实测可用）、原文快照、去重与版本、中文检索、
  证据分级、资料库归档、对比/传导/执行跟踪/海外传导/简报；工具 17 个；测试 46 项。

## 已知限制

- 面板「资本」「规划」页只读/计算，尚无图形化编辑与导入向导。
- 历史建议的批量验证与自动复核提醒尚未实现。
- 仓库与插件包名仍为 `dsh-finance`（改名需同步 profile 与许可证归属，另行处理）。
