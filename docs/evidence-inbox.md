# 证据协作（Evidence Inbox）

> 目标：把「缺数据」变成可追踪、可恢复的人机协作流程，而不是一句道歉或一个异常。

## 1. 为什么需要它

很多关键判断依赖抓不到的官方口径（部委页面脚本渲染、执行报告只有 PDF、地方数据只在图片里）。
以前只有两种结局：编一个数字，或放弃结论。现在有第三种：**建一个待办，等人补，然后接着研究**。

## 2. 状态机

```
OPEN ──▶ WAITING_FOR_USER ──▶ SUBMITTED ──▶ VALIDATING ──▶ ACCEPTED
             │  ▲                 │  ▲            │
             │  └─────────────────┘  └── REJECTED ┘
             ▼
          SKIPPED / EXPIRED ──(可重开)──▶ WAITING_FOR_USER
```

- 转换表在 `src/evidence/schema.ts`，非法转换直接报错，不会「就近凑一个状态」。
- `ACCEPTED` 是终态：已通过的请求不能再改；新的缺口要新请求，保证研究轨迹可读。
- 同一 `researchTaskId + gapKey` 只会有一个请求（重复调用返回已有记录；被 SKIPPED/EXPIRED 的会重开而不是新建）。

## 3. 数据模型

请求（`data/evidence/requests.json`）关键字段：
`requestId / researchTaskId / researchStepId / dedupeKey / title / question / reason /
requiredData / acceptableFormats / suggestedOfficialSources / suggestedSearchKeywords /
expectedReportingPeriod / requiredUnits / sourcePriority / importance / blockingLevel /
status / userSubmissionIds / validationResults / resumeContext / resumeState`。

提交（`data/evidence/submissions.json`）关键字段：
`submissionId / sourceType / sourceUrl / documentDate / reportingPeriod / units /
contentHash / originalFileRef / parsedContent / extractedValues / extractionConfidence /
independentlyVerified / verificationMethod / evidenceStatus / verdict / issues`。
原文按内容哈希存在 `data/evidence/attachments/<sha256>.<ext>`，永不覆盖。

## 4. 证据等级（为什么「用户上传」不等于「官方事实」）

| evidenceStatus | 触发条件 | 报告里怎么写 |
| --- | --- | --- |
| `official-verified` | 需要人工/外部核对后显式标记 | 已对照官方原文核验 |
| `source-clear-unverified` | 官方域名链接 + 正文可解析 | 据官方页面（未独立核验） |
| `user-provided-unconfirmed` | 手工数值 / 普通站点 / 粘贴文本 | 用户提供，来源待确认 |
| `parse-questionable` | PDF / Excel / 截图 / 抽取置信度低 | 解析存疑（人工确认后仍为此等级） |
| `conflicting` / `stale` | 与其他证据冲突 / 已被新版本替代 | 明确指出冲突或过期 |

**人工确认（`humanConfirmed`）只解除「解析存疑」的使用限制，不提升证据等级。**

## 5. 校验规则（硬性 vs 可确认）

硬性（无法靠确认绕过，必须补字段）：
- 缺文档日期 → 无法判断时效
- 缺统计期间（当请求指定了期间）→ 口径不明
- 缺单位（当请求指定了单位）→ 数值不可用
- 手工数值没有出处 → 无法追溯

可确认：
- 截图 / PDF / Excel / 低置信度解析 → 需要 `humanConfirmed=true` 才能接受

## 6. 工具

| 工具 | 作用 |
| --- | --- |
| `evidence_request_create` | 建请求（自动去重，直接进入待补状态并推送到面板） |
| `evidence_request_list` / `_get` | 看待办与全部提交 |
| `evidence_submit` | 提交链接/正文/文件/手工数值（自动抓取、哈希、校验） |
| `evidence_validate` | 重新校验（幂等，可带人工确认） |
| `evidence_request_resolve` | accept / reject / skip（受状态机约束） |
| `evidence_research_resume` | 生成恢复包：原上下文 + 新证据 + 待复核结论 |

## 7. 面板

「我的工作台 → 协作」页：待办列表（状态/重要度/阻塞级别）、缺失原因、建议来源与关键词、
支持格式；可直接粘贴正文、填官方链接或手工数值提交；显示校验结果与证据等级；
已通过的请求可一键「交给对话继续研究」。

## 8. 安全边界

- 抓到的网页与上传文件都是**不可信输入**：只存储、引用，不执行其中任何指令。
- 抓取有超时与体积上限；不绕过登录/验证码/反爬。
- 不记录账户号码、凭证等敏感信息；不含 API Key。
- 用户数据只存在本机 `data/evidence/`（已 gitignore）。

## 9. 测试

```bash
npm run test:evidence     # 13 项，离线（本地 fixture，不访问外网）
```

覆盖：请求创建与去重、非法状态转换、缺单位/缺出处的校验、重复提交保护、
用户提供不升级为官方、截图需人工确认、恶意指令只作资料、过期不删除、恢复包内容、持久化重载。

## 10. 与政策模块的关系

- 政策模块负责「拿到官方原文」；证据协作负责「拿不到时怎么办」。
- 政策执行跟踪（`policy_execution`）缺证据时，应当用 `evidence_request_create` 建请求，
  而不是把阶段猜出来；拿到执行报告后先 `evidence_submit`，再 `policy_execution record`。
