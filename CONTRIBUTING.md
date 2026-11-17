# 贡献指南（Contributing）

## 先读这些

- [`docs/architecture.md`](docs/architecture.md)：模块边界与数据流
- [`docs/investment-advice.md`](docs/investment-advice.md)：投资建议的证据规则
- [`docs/policy-intelligence.md`](docs/policy-intelligence.md)、[`docs/evidence-inbox.md`](docs/evidence-inbox.md)、
  [`docs/personal-capital.md`](docs/personal-capital.md)、[`docs/wealth-simulator.md`](docs/wealth-simulator.md)

## 开发环境

```bash
npm install          # 需要 Node ^22.19 或 >=24.2
npm run build        # tsc + 客户端 bundle
```

把本目录注册到 DSH profile（`plugin_manager` 的 `install_bundle`，或 CLI `dsh plugin add`）后，
面板与工具才会出现在 Harness 里。

## 必须遵守的规则

1. **不伪造数据**：拿不到就返回 `unavailable` / `INSUFFICIENT_DATA`，不编数字。
2. **数值由程序计算**：收益、复利、XIRR、TWR、传导估值都不得由模型口算。
3. **证据必须可追溯**：结论要带来源与数据日期；投资建议必须同时有支持与反对证据。
4. **不改写历史**：流水、建议、复盘都是 append-only。
5. **不执行真实交易**：不下单、不转账、不改券商账户。
6. **不提交私人数据**：`data/`、`.env`、凭据、真实持仓一律不进仓库。
7. **不绕过访问控制**：不逆向登录接口、不破解验证码、不使用不稳定隐藏端点。

## 测试

```bash
npm run test:policy        # 46 项
npm run test:evidence      # 13 项
npm run test:capital       # 17 项
npm run test:wealth        # 19 项
npm run test:investment    # 15 项
npm run test:regressions   # 19 组
npm run test:quant         # 28 项
```

新增数值逻辑时，**期望值必须手算或来自独立来源**，不能调用被测函数生成期望值。

已知环境限制：`npm run test:offline` 在 Windows 上停在 fake-CLI 用例（POSIX 脚本，`spawn EFTYPE`）；
`npm run test:personal` 停在 POSIX 权限断言（NTFS 不支持 `0o600`）。

## 提交

- 一个提交做一件事，说明写清楚「为什么」。
- 涉及数据格式变更时，同步更新文档与测试。
- 不要提交构建产物（`lib/` 已忽略）。
