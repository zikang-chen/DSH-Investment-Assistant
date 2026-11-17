# 金融学习（Financial Learning）

> 目标：在**正在做的研究里**随手把一个词讲明白，而不是另开一门课。

## 1. 与已有模块的关系（先复用，不重建）

| 已有能力 | 本模块怎么用 |
| --- | --- |
| `src/growth-curriculum.ts`（23 节微课 + `METRIC_CONCEPT_MAP`） | 概念词条的 `relatedLessons` 直接指向微课 id，点「看相关微课」走 `lesson_get`，不重复写课程 |
| 投研资料库（Markdown + 索引） | 解释只读本地词条；需要沉淀时用 `save_research` |
| 投资建议（`investment_advice_*`） | 建议页内置「术语解释」入口；`financial_concept_detect` 可从建议文本识别术语 |
| 面板 Tab / SSE / 主题 | 学习页是一个普通 Tab（市场研究 → 学习），不新建应用 |

## 2. 概念词条（P0 内置 38 个）

字段：`conceptId / name / aliases / category / beginner / intermediate / advanced / formula /
interpretationRules / misconceptions / relatedConcepts / relatedIndicators / referenceSources /
relatedLessons / contentVersion / lastVerifiedAt`。

分类：金融基础、中国宏观、公司基本面、估值、市场分析、全球宏观、个人投资。

**内容纪律**：

- 三级解释都是人工写的静态文本，不由模型即兴生成；
- 只写稳定概念，**不写「最新数值」**；需要当前数字时走行情/宏观工具并注明日期；
- `interpretationRules` 负责口径（社融增量≠存量、GDP 同比/环比/累计、PMI 是环比扩散指数…），
  `misconceptions` 负责常见误读；
- 别名归一化（PE / P/E / 市盈率 → `pe`），但**不同口径不合并**。

## 3. 上下文解释

`financial_concept_explain` 接受 `page / value / period / market / asset`：

- 有 `value` 时生成「你在宏观页看到的值是 X（期间），读法：先确认口径…」；
- 没有 `value` 时只解释概念，**不生成任何数字**；
- 每次返回都带 `dataNote`：说明这是静态词条、不含实时数据。

## 4. 学习进度

`data/learn/state.json` 保存每个概念的：`statuses[]`（seen / understood / favorite / review）、
`viewCount`、`lastSeenAt`、`note`。

- 打开解释自动记 `seen` 并累加 `viewCount`；
- 收藏 / 已理解 / 待复习由用户手动点，可叠加；
- 不根据提问推断用户水平，不做排行榜、不做强制答题。

## 5. 工具

| 工具 | 作用 |
| --- | --- |
| `financial_concept_search` | 按名称/别名/正文搜索，可按分类过滤 |
| `financial_concept_explain` | 三级解释 + 上下文提示（默认小白版） |
| `financial_concept_related` | 相关概念、相关指标、相关微课 |
| `financial_concept_save` | 收藏/已理解/待复习 |
| `financial_learning_progress` | 进度统计与按状态列出 |
| `financial_concept_detect` | 从一段文本里识别可解释的术语 |

## 6. 面板

- 「市场研究 → 学习」：搜索、分类 chips、学习进度、概念列表、详情（三级切换、公式、口径、误区、相关概念、收藏/已理解/待复习、看微课、用真实案例解释）。
- 「投资判断」页内嵌「术语解释」小输入框：直接查词，不离开当前页面；只调本地词条。

## 7. 测试

```bash
npm run test:learn   # 14 项离线
```

覆盖：M2 三级文本存在、PE 别名归一、社融增量/存量规则、分类过滤、三级标签、未知概念报错、
带数值时不编数字、PE 误区提醒、术语识别、学习状态持久化。

## 8. 尚未完成（P1/P2）

- 真实历史案例库（教学示例与真实数据分离的独立字段）。
- 研究报告中自动标注术语（目前靠 `financial_concept_detect` 被动调用）。
- 自愿的理解小测（不强制、不影响投研流程）。
