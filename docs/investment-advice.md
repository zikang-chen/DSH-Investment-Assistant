# 投资判断引擎（Investment Decision Engine）

> 目标：让「该不该买」变成一个**有证据、有反证、能复盘**的结论，而不是免责声明或喊单。

## 1. 它做什么、不做什么

**做**：把用户问题结构化为标的/市场/期限/目标，按需取证，形成条件性建议，强制附带反对证据与失效条件，保存成可复盘的记录。

**不做**：不下单、不改持仓、不转账、不保证收益、不给「胜率 95%」这类数字、不预测精确点位。

## 2. 为什么需要「引擎」而不是只靠 prompt

只靠 prompt 时，模型很容易给出「只列利好」的建议。`src/invest/schema.ts` 把几条规则做成**硬校验**，不满足就不让保存：

| 规则 | 违反后果 |
| --- | --- |
| 方向性建议必须至少 1 条支持证据 | 拒绝保存 |
| 必须至少 1 条反对证据 | 拒绝保存（只列支持面=没做反证） |
| 每个证据必须有 `source` + `asOf` | 拒绝保存 |
| 必须至少 1 条失效条件 | 拒绝保存 |
| `INSUFFICIENT_DATA` 必须写清缺什么 | 拒绝保存 |
| `INSUFFICIENT_DATA` 不得带行动方案 | 拒绝保存 |
| 价格区间必须引用 `calculationRefs` | 拒绝保存 |
| 数据时效（fresh/stale/unknown）必须给出 | 拒绝保存 |

工具的返回里会逐条列出 `errors`，模型必须补齐或改用「证据不足」。

## 3. 建议类型

`CONSIDER_BUY` / `HOLD` / `CONSIDER_REDUCE` / `CONSIDER_EXIT` / `WATCH` / `INSUFFICIENT_DATA`。

每条都带：适用条件、期限、主要风险、失效条件、下次复核日期。

## 4. 数据模型（要点）

`InvestmentAdvice` 关键字段：`adviceId / userPrompt / assets / market / horizon / recommendation /
recommendationConditions / rationale / supporting[] / contradicting[] / invalidationConditions[] /
marketSnapshot[] / dataFreshness / valuationSummary / portfolioContextUsed / riskConstraints[] /
scenarioAssumptions[] / proposedAction / nextReviewAt / unresolvedQuestions[] / calculationRefs[] /
modelVersion / promptVersion / status / reviews[] / promptHash`。

价格、仓位字段允许为空；**不允许为了填满 Schema 编数值**。

## 5. 复盘（InvestmentAdviceReview）

`investment_advice_review` 追加一条记录：`outcome`（支持/证伪/无定论）、依据数据日期、条件是否触发、是否触发失效条件、基准比较说明。

- **原始判断、原始证据、生成时间都不允许改写**（有测试保证）。
- 复盘不会把「没触发买入条件」的建议算成成功交易。
- 样本 < 20 条时，`stats()` 直接说明「样本不足以计算命中率」，不给胜率数字。

## 6. 历史验证（InvestmentAdviceVerify）

`investment_advice_verify` 用价格历史检验「当初的方向性观点是否被走势支持」：

| 输出 | 含义 |
| --- | --- |
| `supported` | 方向一致且幅度超过 1% 噪声阈值 |
| `contradicted` | 方向相反 |
| `inconclusive` | 幅度 < 1%（无信号），或 WATCH/HOLD 这类不能用涨跌判定的建议 |
| `unverifiable` | 当时就是 `INSUFFICIENT_DATA`，或价格序列覆盖不足 |

- 可以用 `autoFetch=true` 自动取日线（A 股走 `getKline`，美股走 `getUsKline`）；取不到就报不可用，**不手填价格**。
- 可选 `benchmarkCode` 算超额（百分点）；没给基准就不说「跑赢/跑输」。
- **四条克制**：观点验证 ≠ 交易盈亏；WATCH/HOLD 不用涨跌判；幅度过小不下结论；可验证样本 < 20 时 `summarizeVerification` 明确「不给胜率」。
- 验证结论通过 `investment_advice_review` 追加，**原始判断与证据不会被改写**。

## 7. 与其它模块的关系

- **政策**：`policy_search` / `policy_impact` 提供原文与传导链；`investment_evidence_check` 可校验建议里引用的政策 id 是否真实存在。
- **证据协作**：缺关键数据时先建 `evidence_request`，补齐后 `evidence_research_resume` 再出结论。
- **个人资本**：`capital_performance` / `portfolio_lookthrough` 提供真实持仓与风险；`portfolioContextUsed=true` 时必须写风险约束。
- **模拟**：`simulate_rebalance` 只做纸面推演，输出必须标 `simulated`。

## 8. 面板

「投资判断」页：自然语言输入 + 示例问题 + 已保存建议列表（判断类型、数据时效、支持/反对条数、下次复核）+ 详情（为什么、支持证据、反对证据、失效条件、条件性行动、还缺什么、复盘记录）+ 「让 Agent 复盘」「生成对立观点」。

页面本身不生成结论：结论必须经过工具校验后落库，避免出现「面板里显示但不可追溯」的判断。

## 9. 测试

```bash
npm run test:investment   # 15 项离线
```

覆盖：缺反对证据拒绝、缺失效条件拒绝、证据缺来源拒绝、`INSUFFICIENT_DATA` 必须列缺口且不得带行动、价格区间必须有计算依据、复盘不改原判断、样本不足不给胜率、重载后仍可读。

## 10. 尚未完成

- 面板内直接生成（当前通过对话调用工具生成，面板只读展示）。
- 自动观察提醒（到 `nextReviewAt` 推送）。
- 历史建议的批量统计与基准对比（有样本后再做）。
