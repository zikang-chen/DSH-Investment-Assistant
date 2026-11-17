# 架构（Architecture）

本项目是 **DeepSeek Harness 插件**，不是独立应用。宿主（Harness）负责会话、模型、沙箱、UI 插槽；
本插件通过 Cordis 插件机制注册 Tools、Skills、HTTP 路由与面板客户端 bundle。

## 1. 运行时形态

```
Harness（Electron / dsh web）
└── profile（如 desktop）
    └── bundle: dsh-finance（本仓库，link: 到源码目录）
        ├── cordis.patch.yml     插入插件行 + 覆写 web search provider
        ├── lib/index.js         Host 半：apply(ctx, config)
        ├── lib/client/wrapped-bundle.js  Client 半：面板 UI（React，经 window.__ModuleLoader__）
        └── skills/*/SKILL.md    6 个 Skill，由宿主 skill 服务加载
```

- Host 侧只通过 `ctx.tools` / `ctx.systemPrompt` / `ctx.web` / `ctx.skills` / `ctx.webServer` 扩展。
- Client 侧只通过官方 `__ModuleLoader__` 包裹格式与官方 slot（`sidebar.footer.action`、`settings.plugins.tab`）注册。
- 面板 ↔ 对话：SSE `/api/events`（服务端事件总线）+ 面板把提问投递到当前会话。

## 2. 模块边界

| 目录 | 职责 | 依赖 |
| --- | --- | --- |
| `src/data/` | 行情/财务数据 provider 注册表、缓存、限流、熔断、WeStock CLI | 公开 HTTP、可选本地 CLI |
| `src/tools/` | 行情、宏观、基金、组合、模拟等模型工具 | `src/data`、`src/store` |
| `src/research/` | 投研资料库（Markdown + 索引 + 文件监听） | 文件系统 |
| `src/policy/` | 政策采集、原文快照、去重/版本、检索、传导、执行跟踪、简报 | 白名单 HTTP、资料库 |
| `src/evidence/` | 证据请求状态机、提交校验、恢复包 | 文件系统、政策库（校验引用） |
| `src/capital/` | 交易流水账本、多币种、FIFO、净资产、TWR/XIRR | 无网络（价格由入参提供） |
| `src/wealth/` | 确定性复利、目标反解、情景保存 | 纯函数 |
| `src/invest/` | 投资判断 Schema + 硬校验、建议库、复盘 | 政策/资料/证据库（引用校验） |
| `src/learn/` | 概念词条、三级解释、学习进度 | 纯数据 |
| `src/personal.ts` | 个人首页：投资观点、周复盘、确认流程 | 资料库、行情 |
| `src/growth*.ts` | 成长闭环：诊断、微课、家庭规划 | 本地 JSON |
| `src/follow*.ts` | 追踪：13F / 国会申报 / 名私募 | SEC/Bargo + WeStock |
| `src/server-routes.ts` | 面板 API（`/plugins/dsh-finance/api/*`）与 SSE | 各 store |
| `src/client/index.tsx` | 面板 UI（单文件组件集合） | 浏览器 fetch / SSE |

**依赖方向**：`client → routes → stores → data`。policy/evidence/capital/wealth/invest/learn 互不反向依赖；
`invest` 只读取 policy/research/evidence 做引用校验，不写它们。

## 3. 数据目录（全部 gitignore）

```
data/
├── portfolio.json          持仓/自选快照（原有）
├── personal.json           个人投资档案与观点
├── growth.json             成长记忆
├── follow.json             追踪档案
├── research/               投研资料库（Markdown + index.json）
├── history/                本地 K 线库
├── policy/                 政策：documents/ originals/ history/ theses.json execution.json
├── evidence/               requests.json submissions.json attachments/
├── capital/                accounts.json events.json import-batches.json
├── wealth/                 plans.json
├── investment/             advices.json
├── learn/                  state.json
└── logs/                   dsh-finance.jsonl
```

## 4. 关键不变量

1. **数值由代码算**：收益、复利、XIRR/TWR、仓位影响、FIFO 成本，全部在 `capital/`、`wealth/` 的纯函数里。
2. **只追加**：账本更正、政策版本、建议复盘、资料批注都不覆盖历史。
3. **证据有等级**：政策（E1/E2/E3/unverified）、证据提交（official-verified … stale）、投资建议（支持/反对/失效）。
4. **缺数据即不可用**：缺汇率不加总、缺行情不算未实现、缺估值不给 TWR、缺证据不给方向性建议。
5. **外部内容不可信**：抓取/上传的文本只存储与引用，不执行其中指令。
6. **不执行交易**：所有「行动方案」都标 `simulated`。

## 5. 扩展点

- 新增数据源：`src/data/providers.ts` 注册 provider → `registry.ts` 自动纳入缓存/熔断/面板数据源页。
- 新增政策源：`src/policy/sources.ts` 的 allowlist 加一条（含 hosts/kind/linkPattern），配置层可覆盖。
- 新增工具：在对应模块 `tools.ts` 用 `defineTool` 注册，`src/index.ts` 挂载。
- 新增面板页：`src/client/index.tsx` 加 Tab + 组件，`src/server-routes.ts` 加只读路由。

## 6. 构建

```
npm run build = tsc -p tsconfig.json  &&  node scripts/build-client.mjs
```

Client 走 esbuild 打成 CJS，再由 `build-client.mjs` 包成 `window.__ModuleLoader__.load({id, factory})`。
React / react-dom 由宿主模块表提供（external）。

## 7. 为什么不做得更「大」

- 没有引入数据库/消息队列：JSON + 原子写足够本地单用户场景，且可人工审计。
- 没有拆微服务：宿主已提供进程、沙箱、会话与 UI；再拆只会增加部署成本。
- 没有做 RAG/向量库：先用元数据 + 关键词（中文二元组）检索，等真实检索质量不够再加。
