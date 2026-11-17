# 插件安装与排障（Plugin Install）

## 1. 前置检查

```bash
node --version     # 需要 ^22.19 或 >=24.2
npm --version
```

> Node 24.0 / 24.1 会让 dsh 的 `bin`（依赖 `import.meta.main`）静默退出，请避开。

## 2. 构建

```bash
npm install
npm run build      # tsc + scripts/build-client.mjs
```

成功标志：

- `lib/index.js` 存在
- `lib/client/wrapped-bundle.js` 存在（面板客户端 bundle）

## 3. 注册到 profile

### 方式 A：在 DSH 里安装（推荐）

对 Agent 说：

> 把这个目录作为插件安装到当前 profile：`<绝对路径>`

它应调用 `plugin_manager` 的 `install_bundle`（target = 目录绝对路径），返回 `application: applied`。

### 方式 B：命令行

```bash
npx @deepseek-ai/dsh@<与你安装的 dsh 相同版本> plugin --profile desktop add /abs/path/to/repo
```

查看 profile 是否已登记：

```bash
cat "$DSH_HOME/profiles/desktop/package.json"      # dependencies 里应有 dsh-finance: link:...
```

## 4. 重启验证

**插件是 `link:` 挂载、客户端 bundle 也在变，所以改完必须重启 DSH。**
重启后检查：

1. 左侧栏出现「投资助手」按钮；
2. 面板一级导航为：总览 / 投资判断 / 市场研究 / 我的资本 / 设置；
3. 对话里工具列表出现 `investment_advice_generate`、`capital_performance`、`financial_concept_explain` 等。

## 5. 无私人数据的演示模式

想在不动真实数据的情况下先看看面板长什么样：

```bash
npm run demo:seed                      # 生成 data-demo/（全部是标注过的教学示例）
npm run demo:seed -- --dir C:\tmp\demo --force
```

然后把插件配置的 `dataDir` 指向该目录（不要再指向 `data/`），重启 DSH。
演示数据包括：1 个示例账户 + 5 笔流水、2 条投资建议（含 1 条 `INSUFFICIENT_DATA`）、2 个复利情景。
**它不会写入 `data/`**；目录已存在时会拒绝覆盖（除非 `--force`）。

## 6. 常见问题

### 面板没有出现

- 是否**完全退出** DSH（托盘也要退）再打开？只刷新页面在部分版本不够（客户端 HMR 通道可能不可用）。
- 查 `data/logs/dsh-finance.jsonl` 是否有 `plugin apply`；没有说明插件未加载。
- 查看 profile 的 `package.json` 是否包含 `dsh-finance`。

### 工具报「未找到政策 / 未找到账户 / 未找到证据请求」

正常：说明对应数据还没建立。按工具提示先建（`policy_collect` / `capital_account_save` / `evidence_request_create`）。

### `npm install` 报 ERESOLVE

本仓库 `.npmrc` 设 `legacy-peer-deps=false`。若仍失败：

```bash
npm install --legacy-peer-deps
```

它只影响本地构建树（用于编译），不影响宿主运行时。

### Windows 上测试失败

- `test:offline` 停在 fake-CLI 用例（测试写的是 POSIX 脚本，`spawn EFTYPE`）——与本插件功能无关。
- `test:personal` 停在文件权限断言（NTFS 不支持 `0o600`）。

### 数据源全部不可用

先跑探测：

```bash
npm run probe          # 行情/宏观源探测
npm run policy:probe   # 政策源探测（会列出可发现的链接数）
```

报告写入 `data/probe-report.json`；政策探测会直接告诉你哪个来源抓不到（多数部委站点列表由脚本渲染）。

### 想改数据目录

```yaml
# 在 profile 层覆盖
- id: dsh-finance
  config:
    dataDir: /path/to/your/data
```

## 6. 卸载

```bash
npx @deepseek-ai/dsh@<version> plugin --profile desktop remove dsh-finance
```

卸载不会删除 `data/`（你的持仓、账本、资料都在那里，请自行备份）。
