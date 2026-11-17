# 个人资本账本（Personal Capital）

> 目标：用**可审计的交易流水**算真实收益，而不是拿持仓快照的涨跌当收益。
>
> 原则：整数分计算、追加式流水、外部资金流不算收益、跨币种没汇率就不给总额。

## 1. 为什么不用持仓快照

`data/portfolio.json` 是**当前快照**：它知道你现在有多少股，不知道你什么时候买的、中间加减仓多少、有没有分红。
用快照算「收益」会把追加本金算成盈利。账本是另一套数据：`data/capital/`，两者互不覆盖。

## 2. 数据模型

```
data/capital/
├── accounts.json       多账户（securities/fund/cash/bank/crypto/other）
├── events.json         全部流水（append-only，含更正事件）
└── import-batches.json 导入批次（可追溯每一行来自哪个文件）
```

事件类型：`DEPOSIT / WITHDRAWAL / BUY / SELL / DIVIDEND / INTEREST / FEE / TAX / FX_CONVERSION / INTERNAL_TRANSFER / SPLIT / CORPORATE_ACTION / ADJUSTMENT`。

金额在内存中一律用**整数分**（`toCents/fromCents`），避免浮点误差累积。

### 两条硬规则

- **只追加**：改错不是覆盖，而是新增一条 `correctionOf` 指向原事件的更正记录；原记录留在文件里，但不再计入统计。
- **幂等**：同一 `(source, sourceTransactionId)` 只入账一次；没有流水号时按内容哈希去重。重复导入同一份 CSV 不会重复记账。

## 3. 收益的定义（不许混用）

| 口径 | 含义 | 常见错误 |
| --- | --- | --- |
| 净投入 | 入金 − 出金（外部资金流） | 把入金当收益 |
| 已实现 | FIFO：卖出净收入 − 对应成本（含买入费用） | 用平均成本覆盖历史 |
| 未实现 | 当前市值 − 剩余成本；**没有行情就不算** | 把没行情的持仓当 0 |
| 分红/利息 | 现金收入（已扣税） | 重复计入总收益 |
| TWR | 时间加权，需要逐期估值 | 用总资产增长率冒充 |
| XIRR | 资金加权（MWR） | 用 TWR 代替 XIRR |

- `TWR` 没有逐期估值序列时直接返回 `unavailable`，不给近似值。
- `XIRR` 无解返回 `no-root`，多解返回 `multiple-roots` 并列出全部根，不挑一个好看的。
- 内部转账（自有账户互转）现金流为 0，不进 XIRR。

## 4. 多币种

- 每个金额都带币种；**没有汇率就不加总**，返回按币种分解 + `missingFx` 列表。
- 汇率必须显式提供（`USD>CNY:7.12:2026-11-16`），并随结果保留来源与日期。
- 外币资产的未实现收益按同一汇率折算；汇率缺失时不给单一「总收益」。

## 5. 工具

| 工具 | 作用 |
| --- | --- |
| `capital_account_list` / `capital_account_save` | 多账户管理 |
| `capital_transaction_add` | 追加流水（自动去重） |
| `capital_transaction_list` | 按账户/标的/类型/日期查 |
| `capital_correct` | 更正：生成新事件，保留历史 |
| `capital_ledger_import_preview` | CSV 解析 + 校验 + 去重预览（不写库） |
| `capital_ledger_import_confirm` | 确认写入（幂等） |
| `capital_networth_snapshot` | 现金 + 已定价持仓，按币种列示 |
| `capital_performance` | 净投入/已实现/未实现/费用/净资产/XIRR/TWR/现金占比 |

CSV 列名（可中文）：`date,type,account,asset,quantity,price,amount,fee,tax,currency,fx_rate,fx_currency,source_id,note`。

## 6. 暴露与情景（Phase 4）

`capital_exposure_analyze`：

- 权重 = 个股市值 ÷ **总资产（含现金）**；集中度用 HHI / 有效持仓数 / top1 / top3；
- **只对可定价持仓算 HHI**（现金在分母里但不进集中度），未定价资产进 `unpriced` 且权重为 `undefined`，不按 0 计；
- 缺汇率时不给单一总额（`missingFx`），币种暴露单独列示；
- 过期价格会打 `stale` 标记并警告。

`capital_scenario_simulate`：把指定资产权重调到目标值（其余等比例缩放），对比调整前后 HHI/top1/top3。
**纯纸面模拟**：不改账本、不产生交易、不考虑成本与可成交性，输出明确写「不构成任何买卖建议」。

## 7. 与政策/证据模块的连接

- 政策影响分析需要「我实际持有什么」时，读账本持仓（`capital_networth_snapshot`），不要读快照。
- 缺行情/缺汇率不是异常：结果里会写 `unpricedAssets` / `missingFx`，报告必须照写，不能补数。
- 需要外部数据（如执行报告）时走 Evidence Inbox，不要在账本里手动编价格。

## 7. 隐私

- 账本只存本机 `data/capital/`（已 gitignore）。
- 不采集账号、密码、验证码、身份证号；`provider` 只写平台名称。
- 金额默认不发送到外部 API：工具返回的是本地计算后的结构化结果，模型只看到摘要。

## 8. 测试

```bash
npm run test:capital    # 17 项离线
```

参考值在测试注释里手算：买入 10 股 @10 + 费用 5 → 成本 105；卖出 @25 + 费用 5 → 已实现 140；
10000→11000→12100 的 TWR = 21%；期中追加 10000 后期末 21000 的 TWR = 5%（而总资产增长率是 110%）。

## 9. 尚未完成

- 面板「资本」页（当前只有工具，没有 UI）。
- 期初持仓快照迁移（会明确标注「非完整历史，无法计算历史收益」）。
- 负债与现金流规划、多账户对账报表。
