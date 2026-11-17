# 政策情报模块（Policy Intelligence）

> 目标：把「政策原文」变成**可追溯、可反驳**的投研资料，而不是把「利好」变成「买入」。
>
> 状态：P0 已完成（采集 / 原文快照 / 去重 / 版本 / 检索 / 归档 / 面板只读视图 / 定时采集）。
> 本模块是 `dsh-finance` 插件的一部分，不引入独立服务、不引入外部数据库。

## 1. 设计原则

| 原则 | 落地方式 |
| --- | --- |
| 原文永久保留 | `data/policy/originals/<sha256>.<ext>`，写入后永不覆盖 |
| 可追溯到段落 | 正文切成 `paragraphs[]`，任何结论必须带 `paragraph` 下标（写入时校验越界） |
| 多站转载不重复 | 内容哈希（正文+文号）+ 同一性指纹（机关+文号 / 标题+发布日）+ 正文重合度判定 |
| 修订不丢历史 | 同 id 升 `version`，旧版写入 `history/<id>/v<n>.json` |
| 类型与效力分离 | `status`（发布/生效/执行/废止）与 `legalEffect`（表态/指引/规范/法律）两条独立轴 |
| 证据分级 | E1 有资金/量化、E2 有责任无量化、E3 仅战略表述、`unverified` 未提取 |
| 外部内容不可信 | 工具输出标注 `untrusted`，正文仅作资料；脚本被剥离；不执行文中指令 |
| 失败不静默 | 抓取/解析失败保留原文快照 + `parseStatus`/`parseError` |
| 不绕过访问控制 | robots.txt + 主机白名单 + 体积上限 + 超时；需登录/验证码的站点走人工导入 |

## 2. 目录结构

```
data/policy/
├── index.json                     # 轻量索引（列表页用）
├── documents/<id>.json            # 结构化记录（全文 + 段落 + 提取结论）
├── originals/<sha256>.<ext>       # 不可变原文快照
└── history/<id>/v<n>.json         # 被替代的历史版本
```

政策文档同时可镜像到投研资料库：`kind=policy`、标签 `政策` / 文档类型 / `kp:<政策id>`，
正文由 `renderPolicyMarkdown` 生成（元数据 + 可引用段落 + 后续观察指标 + 免责声明）。

## 3. 数据模型

完整字段见 `src/policy/types.ts` 的 `PolicyDocument`。以下是不能省略的几组：

- 身份：`id` / `canonicalUrl` / `sourceUrls[]` / `docKey` / `version` / `previousVersions[]`
- 来源：`sourceId` / `sourceClass` / `issuer` / `documentNumber` / `docType`
- 时间：`publishedAt` / `effectiveAt` / `expiredAt` / `fetchedAt` / `lastVerifiedAt`
- 状态：`status`（生命周期）与 `legalEffect`（法律效力）**分开**
- 内容：`text` / `paragraphs[]` / `contentHash` / `originalPath` / `originalBytes`
- 提取：`policyGoals[]` / `policyMeasures[]` / `fundingMechanism` / `executionResponsibility` /
  `measurableTargets[]` / `implementationIndicators[]` / `extractionVersion` / `humanReviewStatus`

提取字段永远是「带下标的引用」，不能覆盖原文、哈希与日期。

## 4. 数据源（allowlist）

`src/policy/sources.ts` 内置注册表，默认启用的 6 个来源均在 2026-11-16 实测可访问且索引页服务端渲染：

| id | 来源 | 类型 | 默认 |
| --- | --- | --- | --- |
| `stats-releases` | 国家统计局 · 数据发布（**官方 RSS**） | 统计数据 | ✅ |
| `gov-cn-policy` | 中国政府网 · 最新政策 | 国务院文件 | ❌ 手工导入 |
| `ndrc-policy` | 国家发改委 · 政策发布 | 部委文件 | ❌ 手工导入 |
| `miit-policy` | 工信部 · 政策文件 | 产业规划 | ❌ 手工导入 |
| `sse-rules` | 上交所 · 业务规则 | 监管规则 | ❌ 手工导入 |
| `szse-rules` | 深交所 · 业务规则 | 监管规则 | ❌ 手工导入 |
| `pbc` / `mof` / `mofcom` / `csrc` / `cninfo` | 央行 / 财政部 / 商务部 / 证监会 / 巨潮 | 手工导入 | ❌ |

**为什么只默认开统计局**：2026-11-16 用 `npm run policy:probe` 实测，只有统计局的 `rss.xml`
返回完整条目（500 条，带 `pubDate`）；gov.cn / 发改委 / 工信部 / 上交所 / 深交所的列表页都由
脚本异步渲染，静态 HTML 里没有政策链接（发改委的 `rss.xml` 存在但 `<channel>` 里没有 item）。
与其假装能抓，不如默认关闭并给出明确替代路径：浏览器打开后复制链接用 `policy_import`，
或把任何官方 feed 配进 `policy.sources`（`kind: rss`）。

```bash
npm run policy:probe                      # 探测每个启用来源能否发现链接
npm run policy:probe -- --collect 3       # 顺带真抓 3 篇到临时目录，检查抽取质量
```

白皮书没有独立入口：它通常随「最新政策」发布，标题含「白皮书」时自动归为 `white-paper`；
国新办站点当前返回 521，正文请用 `policy_import` 手工导入。

启用/调整来源在插件配置里写，不需要改代码：

```yaml
policy:
  enabled: true
  sources:
    - id: csrc
      enabled: true
      url: https://www.csrc.gov.cn/...
      linkPattern: '\.htm$'
      minIntervalSec: 10
  autoCollect:
    enabled: true
    intervalHours: 24
    limitPerSource: 5
    mirrorToVault: true
    firstRunDelaySec: 120
```

## 5. 工具

| 工具 | 作用 | 关键约束 |
| --- | --- | --- |
| `policy_sources` | 列出 allowlist 与状态 | 只读 |
| `policy_collect` | 采集（来源或显式链接）并归档 | 只抓白名单主机；robots |
| `policy_search` | 关键词 + 元数据检索 | 返回命中词，便于判断相关性 |
| `policy_get` | 读结构化记录与正文（可按段落区间） | 输出标 `untrusted` |
| `policy_import` | 手工导入 URL / 正文 / 本地文件 | 不绕过登录与验证码；PDF 仅存原文 |
| `policy_annotate` | 写回目标/措施/资金/责任/指标 | 段落下标越界即拒绝 |
| `policy_to_vault` | 归档进资料库 | 幂等，修订追加批注 |
| `policy_compare` | 同一政策新旧版本 / 两份政策对比 | 段落级 diff，标注数字是否真的变了 |
| `policy_impact` | 传导脚手架（渠道/指标/时滞/支持/证伪/缺口） | 不预测涨跌、不给买卖建议；宏观不可用时不引用数字 |
| `policy_portfolio_exposure` | 政策 × 持仓/自选匹配 | 只分「代码直接命中」「行业可能相关」「证据不足」 |
| `policy_thesis` | 研究假设的持久化记忆 | 复核只追加记录、不自动改判断；改原判断必须给理由并留历史 |
| `global_to_china_impact` | 海外事件 → 中国传导 | 只给机制链与验证清单；链条一律标 `conditional`，事实必须由调用方带来源 |
| `policy_execution` | 执行进度跟踪 | 按文件类型给应走路径；缺证据的阶段与停滞天数显式列出 |
| `policy_brief` | 跨资产政策简报 | 政策/执行/假设/持仓四段 + 每节缺口；空库时说「没有」，不编内容 |

## 5.1 研究假设与复核（`policy_thesis`）

`data/policy/theses.json` 保存政策相关的研究假设：

- `hypothesis` 是对外可证伪的一句话判断，**不可直接覆盖**；改写走 `revise`，原判断进 `hypothesisHistory` 并必须带理由；
- `review` 只追加带时间戳的记录（新增事实 / 结论 / 变了什么 / 仍缺什么 / 证据锚点），**不自动改变状态**；
- `status` 只有显式调用才会变（active / validated / invalidated / dropped）；
- 与个人首页的持仓观点（`PersonalStore`）分工：这里绑定**政策**，那里绑定**持仓与周复盘**，两者互不覆盖。

## 6. 面板

「市场研究 → 政策」页（只读）：检索、类型/状态筛选、证据分级徽标、原文段落与「引用」按钮、
「问 Agent 解读」（把政策元数据与要求拼成提问投递到当前会话）、复制/打开原文。
数据不可用时显示明确错误或空状态，不填假值。

## 7. 定时任务

`runPolicyTick()` 是纯函数，便于测试；`src/index.ts` 用 `ctx.effect` 挂 `setInterval`：

- 默认 24h 一次，启动后 120s 先跑一次；
- 每个来源隔离失败，单站报错不影响其它来源；
- 重复执行幂等（去重靠内容哈希与同一性指纹，不靠「跑过了」标记）；
- 采集与归档解耦：先入库，再按需镜像到资料库。

Harness 关闭时定时器随之停止；需要常驻可把同一 `runPolicyTick` 包进独立进程（未提供）。

## 8. 测试

```bash
npm run test:policy     # 28 项，离线；本地 HTTP fixture，不访问任何政府站点
npm run test:regressions
npm run test:quant
```

覆盖：白名单/robots、HTML/RSS 解析、原文快照、转载去重、修订历史、失败留痕、
提示注入只作资料、手工导入、段落引用校验、证据分级、资料库归档幂等、定时采集幂等。

已知与环境相关的失败（与本次改动无关）：
- `npm run test:offline` 在 Windows 上停在「fake CLI」用例（测试用 bash 脚本，`spawn EFTYPE`）；
- `npm run test:personal` 在 Windows 上停在文件权限断言（POSIX `0o600` 在 NTFS 不成立）。

## 9. 路线图

- **P0 ✅**：采集 / 原文快照 / 去重 / 版本 / 检索 / 证据分级 / 资料库归档 / 面板只读视图 / 定时采集。
- **P1 ✅**：政策新旧对比（`policy_compare`，段落级 diff + 数字变化标注）、
  传导脚手架（`policy_impact`，渠道/指标/时滞/支持与证伪条件/信息缺口）、
  持仓暴露匹配（`policy_portfolio_exposure`）、研究假设与 append-only 复核（`policy_thesis`）、
  面板按月时间线。
- **P2 ✅**：海外事件传导（`global_to_china_impact`，事实/条件推断/叙事三档分离）、
  执行进度跟踪（`policy_execution`，阶段证据 + 停滞判定）、跨资产简报（`policy_brief`，可存资料库）。
- **仍可选**：把简报生成接进后台定时任务（采集与报告已解耦，当前简报按需生成）、
  独立 Worker 部署（Harness 关闭时定时器随之停止）。

## 10. 不做的事

- 不预测涨跌、不给买卖建议、不给目标价；
- 不编造数字：拿不到就是 `unavailable`；
- 不绕过登录、验证码、付费墙；
- 不把演示数据当真实数据；
- 不自动下单、不修改真实券商持仓。
