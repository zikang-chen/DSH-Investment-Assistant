/**
 * 金融学习工具。
 *
 * 解释来自本地概念库（三级文本 + 口径规则 + 误区），实时数值永远来自其他工具；
 * 本工具不会编造任何「最新数据」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Logger } from '../log.js'
import { CATEGORY_LABEL, CONCEPTS, detectConcepts, findConcept, searchConcepts, type ConceptCategory } from './concepts.js'
import { LearningStore, categorySummary, explain, type ExplainContext, type LearnStatus } from './explain.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

const CATEGORIES = Object.keys(CATEGORY_LABEL) as ConceptCategory[]

function brief(concept: { conceptId: string; name: string; category: ConceptCategory; aliases: string[] }) {
  return { conceptId: concept.conceptId, name: concept.name, category: concept.category, categoryLabel: CATEGORY_LABEL[concept.category], aliases: concept.aliases.slice(0, 6) }
}

export interface LearnToolDeps {
  store: LearningStore
  logger?: Logger
}

export function registerLearnTools(ctx: Context, deps: LearnToolDeps): void {
  const ensure = async (): Promise<void> => {
    if (!deps.store.isLoaded()) await deps.store.load()
  }

  ctx.tools.register(defineTool({
    name: 'financial_concept_search',
    description: '搜索金融概念（本地词条库）：按名称/别名/正文关键词，可按分类过滤。返回命中的概念与分类，用于「这是什么意思」「有没有关于 X 的解释」。',
    parameters: {
      query: { type: 'string', description: '关键词，如 社融 / PE / 回撤' },
      category: { type: 'string', enum: CATEGORIES },
      limit: { type: 'number', description: '默认 12' },
    },
    output: jsonOut,
    async execute(args) {
      const results = searchConcepts(String(args.query ?? ''), {
        ...(args.category ? { category: String(args.category) as ConceptCategory } : {}),
        limit: Number(args.limit) > 0 ? Number(args.limit) : 12,
      })
      return asJson({
        ok: true,
        count: results.length,
        categories: categorySummary(),
        results: results.map(brief),
        note: results.length === 0 ? '本地词条没有命中：可以换别名（如 P/E、市净率），或说明需要新增词条。' : undefined,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'financial_concept_explain',
    description: '用三级难度（小白/进阶/专业）解释一个金融概念，并可结合当前页面上下文（页面、数值、期间、标的）提示「这个数怎么读」。只使用本地词条，不编造实时数据；需要当前数值请先用行情/宏观工具。',
    parameters: {
      concept: { type: 'string', required: true, description: '概念名/别名/id，如 社融 / M2 / pe' },
      level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: '默认 beginner（小白版）' },
      page: { type: 'string', description: '当前页面：advice/policy/macro/quotes/dossier/capital/wealth/research' },
      value: { type: 'string', description: '页面上看到的具体数值（用户提供，不要猜）' },
      period: { type: 'string', description: '统计期间，如 2026年1-10月' },
      market: { type: 'string', description: '市场，如 cn/hk/us' },
      asset: { type: 'string', description: '相关标的或行业' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const context: ExplainContext = {
          ...(args.page ? { page: String(args.page) } : {}),
          ...(args.value ? { value: String(args.value) } : {}),
          ...(args.period ? { period: String(args.period) } : {}),
          ...(args.market ? { market: String(args.market) } : {}),
          ...(args.asset ? { asset: String(args.asset) } : {}),
        }
        const result = explain(String(args.concept ?? ''), String(args.level ?? 'beginner') as never, context)
        if (!result.ok) return asJson({ ok: false, error: result.error })
        const concept = findConcept(String(args.concept))
        if (concept) await deps.store.touch(concept.conceptId)
        return asJson({ ok: true, ...result.explanation })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'financial_concept_related',
    description: '查看一个概念的相关概念、相关指标与可复用的成长微课。',
    parameters: { concept: { type: 'string', required: true } },
    output: jsonOut,
    async execute(args) {
      const concept = findConcept(String(args.concept ?? ''))
      if (!concept) return asJson({ ok: false, error: `没有这个概念的本地词条：${args.concept}` })
      return asJson({
        ok: true,
        concept: brief(concept),
        related: concept.relatedConcepts.map((id) => findConcept(id)).filter(Boolean).map((c) => brief(c!)),
        indicators: concept.relatedIndicators,
        lessons: concept.relatedLessons ?? [],
        sources: concept.referenceSources,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'financial_concept_save',
    description: '把概念加入学习记录：标记已看过/已理解/收藏/待复习（可叠加），用于个人知识卡片库。',
    parameters: {
      concept: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['seen', 'understood', 'favorite', 'review'] },
      on: { type: 'boolean', description: 'true 添加（默认），false 取消' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const concept = findConcept(String(args.concept ?? ''))
        if (!concept) return asJson({ ok: false, error: `没有这个概念的本地词条：${args.concept}` })
        const state = await deps.store.setStatus(concept.conceptId, String(args.status) as LearnStatus, args.on !== false)
        return asJson({ ok: true, concept: brief(concept), state, stats: deps.store.stats() })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'financial_learning_progress',
    description: '查看学习进度：已看过/已理解/收藏/待复习的数量，最近与最常查看的概念。也可以按状态列出概念。',
    parameters: {
      status: { type: 'string', enum: ['seen', 'understood', 'favorite', 'review'], description: '可选：按状态列出' },
      limit: { type: 'number' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const rows = deps.store.filtered({
          ...(args.status ? { status: String(args.status) as LearnStatus } : {}),
          limit: Number(args.limit) > 0 ? Number(args.limit) : 30,
        })
        return asJson({
          ok: true,
          stats: deps.store.stats(),
          count: rows.length,
          items: rows.map((state) => {
            const concept = findConcept(state.conceptId)
            return { ...state, name: concept?.name ?? state.conceptId, category: concept?.category ?? 'basics' }
          }),
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'financial_concept_detect',
    description: '从一段文本（如一条投资判断或政策摘要）里识别出可以解释的金融术语，返回概念列表，用于「解释这段里的术语」。',
    parameters: {
      text: { type: 'string', required: true },
      limit: { type: 'number', description: '默认 5' },
    },
    output: jsonOut,
    async execute(args) {
      const hits = detectConcepts(String(args.text ?? ''), Number(args.limit) > 0 ? Number(args.limit) : 5)
      return asJson({ ok: true, count: hits.length, concepts: hits.map(brief), totalKnown: CONCEPTS.length })
    },
  }))
}
