/**
 * 金融学习 — 解释器与学习进度。
 *
 * 解释由本地概念库生成（三级文本 + 口径规则 + 误区），不依赖模型即兴发挥；
 * 需要「结合当前页面的数值」时，只把用户提供的数值与期间拼进解释，绝不编造最新数字。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import {
  CATEGORY_LABEL,
  CONCEPTS,
  LEVEL_LABEL,
  findConcept,
  type ConceptCategory,
  type ExplainLevel,
  type FinancialConcept,
} from './concepts.js'

export const LEARN_STATUSES = ['seen', 'understood', 'favorite', 'review'] as const
export type LearnStatus = (typeof LEARN_STATUSES)[number]

export const STATUS_LABEL: Record<LearnStatus, string> = {
  seen: '已看过',
  understood: '已理解',
  favorite: '已收藏',
  review: '待复习',
}

export interface ConceptState {
  conceptId: string
  statuses: LearnStatus[]
  viewCount: number
  lastSeenAt: string
  updatedAt: string
  note: string
}

interface LearnFile { version: 1; updatedAt: string; states: ConceptState[] }

function nowIso(): string {
  return new Date().toISOString()
}

export class LearningStore {
  readonly file: string
  private states: ConceptState[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.file = path.join(dir, 'state.json')
    this.log = logger?.child('learn')
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as LearnFile
      this.states = Array.isArray(parsed.states) ? parsed.states : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('learn state unreadable', { error: String(err) })
      this.states = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  get(conceptId: string): ConceptState | undefined {
    return this.states.find((s) => s.conceptId === conceptId)
  }

  all(): ConceptState[] {
    return [...this.states].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 记录一次查看（幂等累加），不改用户手动设置的状态。 */
  async touch(conceptId: string): Promise<ConceptState> {
    const at = nowIso()
    const existing = this.get(conceptId)
    const next: ConceptState = existing
      ? { ...existing, viewCount: existing.viewCount + 1, lastSeenAt: at, updatedAt: at, statuses: [...new Set([...existing.statuses, 'seen' as LearnStatus])] }
      : { conceptId, statuses: ['seen'], viewCount: 1, lastSeenAt: at, updatedAt: at, note: '' }
    await this.put(next)
    return next
  }

  /** 用户手动设置状态（可叠加：收藏 + 已理解）。 */
  async setStatus(conceptId: string, status: LearnStatus, on: boolean): Promise<ConceptState> {
    if (!findConcept(conceptId)) throw new Error(`未知概念：${conceptId}`)
    if (!LEARN_STATUSES.includes(status)) throw new Error(`未知状态：${status}`)
    const at = nowIso()
    const existing = this.get(conceptId)
    const current = new Set(existing?.statuses ?? [])
    if (on) current.add(status)
    else current.delete(status)
    const next: ConceptState = {
      conceptId,
      statuses: [...current],
      viewCount: existing?.viewCount ?? 0,
      lastSeenAt: existing?.lastSeenAt ?? at,
      updatedAt: at,
      note: existing?.note ?? '',
    }
    await this.put(next)
    return next
  }

  filtered(filter: { status?: LearnStatus; limit?: number } = {}): ConceptState[] {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    return this.all().filter((s) => (filter.status ? s.statuses.includes(filter.status) : true)).slice(0, limit)
  }

  stats(): { tracked: number; favorite: number; understood: number; review: number; mostViewed: Array<{ conceptId: string; viewCount: number }> } {
    return {
      tracked: this.states.length,
      favorite: this.states.filter((s) => s.statuses.includes('favorite')).length,
      understood: this.states.filter((s) => s.statuses.includes('understood')).length,
      review: this.states.filter((s) => s.statuses.includes('review')).length,
      mostViewed: [...this.states].sort((a, b) => b.viewCount - a.viewCount).slice(0, 5).map((s) => ({ conceptId: s.conceptId, viewCount: s.viewCount })),
    }
  }

  private async put(state: ConceptState): Promise<void> {
    const existing = this.states.some((s) => s.conceptId === state.conceptId)
    this.states = existing
      ? this.states.map((s) => (s.conceptId === state.conceptId ? state : s))
      : [...this.states, state]
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: LearnFile = { version: 1, updatedAt: nowIso(), states: this.states }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

export interface ExplainContext {
  /** 当前页面（advice/policy/macro/quotes/dossier/capital/wealth/research）。 */
  page?: string
  /** 页面上的具体数值（用户提供，不得编造）。 */
  value?: string
  period?: string
  market?: string
  asset?: string
}

export interface Explanation {
  concept: Pick<FinancialConcept, 'conceptId' | 'name' | 'category' | 'formula' | 'interpretationRules' | 'misconceptions' | 'relatedConcepts' | 'relatedIndicators' | 'referenceSources' | 'relatedLessons' | 'lastVerifiedAt'>
  level: ExplainLevel
  levelLabel: string
  text: string
  /** 结合页面上下文生成的「怎么读这个数」提示；没有上下文时为空。 */
  contextNote: string
  /** 本解释没有使用任何实时数据。 */
  dataNote: string
  related: Array<{ conceptId: string; name: string }>
}

const CONTEXT_LABEL: Record<string, string> = {
  advice: '投资判断', policy: '政策', macro: '宏观', quotes: '行情', dossier: '深度',
  capital: '资本', wealth: '规划', research: '资料', general: '通用',
}

/** 生成三级解释；上下文只用来提醒「怎么读这个数」，不产出任何新数字。 */
export function explain(
  idOrAlias: string,
  level: ExplainLevel = 'beginner',
  context: ExplainContext = {},
): { ok: true; explanation: Explanation } | { ok: false; error: string } {
  const concept = findConcept(idOrAlias)
  if (!concept) return { ok: false, error: `没有这个概念的本地词条：${idOrAlias}（可以用 financial_concept_search 搜一下别名）` }
  const lvl: ExplainLevel = (['beginner', 'intermediate', 'advanced'] as const).includes(level) ? level : 'beginner'
  const text = lvl === 'beginner' ? concept.beginner : lvl === 'intermediate' ? concept.intermediate : concept.advanced

  const contextParts: string[] = []
  if (context.value) {
    contextParts.push(`你在${CONTEXT_LABEL[context.page ?? 'general'] ?? context.page ?? '当前页面'}看到的值是 ${context.value}${context.period ? `（${context.period}）` : ''}`)
    contextParts.push(`读法：先确认口径（${concept.interpretationRules[0] ?? '口径'}），再与同期/同业/历史比较`)
  } else if (context.page) {
    contextParts.push(`当前在「${CONTEXT_LABEL[context.page] ?? context.page}」页：解释只用到本地词条，没有读取你的实时数据`)
  }
  if (context.asset) contextParts.push(`相关标的：${context.asset}${context.market ? `（${context.market}）` : ''}`)

  return {
    ok: true,
    explanation: {
      concept: {
        conceptId: concept.conceptId,
        name: concept.name,
        category: concept.category,
        ...(concept.formula ? { formula: concept.formula } : {}),
        interpretationRules: concept.interpretationRules,
        misconceptions: concept.misconceptions,
        relatedConcepts: concept.relatedConcepts,
        relatedIndicators: concept.relatedIndicators,
        referenceSources: concept.referenceSources,
        ...(concept.relatedLessons ? { relatedLessons: concept.relatedLessons } : {}),
        lastVerifiedAt: concept.lastVerifiedAt,
      },
      level: lvl,
      levelLabel: LEVEL_LABEL[lvl],
      text,
      contextNote: contextParts.join('；'),
      dataNote: '本解释为静态词条，不含任何实时行情或最新统计数值；需要当前数值请用行情/宏观工具，并注明数据日期。',
      related: concept.relatedConcepts
        .map((id) => findConcept(id))
        .filter((c): c is FinancialConcept => Boolean(c))
        .map((c) => ({ conceptId: c.conceptId, name: c.name })),
    },
  }
}

/** 分类概览（面板首页用）。 */
export function categorySummary(): Array<{ category: ConceptCategory; label: string; count: number }> {
  const counts = new Map<ConceptCategory, number>()
  for (const concept of CONCEPTS) counts.set(concept.category, (counts.get(concept.category) ?? 0) + 1)
  return [...counts.entries()].map(([category, count]) => ({ category, label: CATEGORY_LABEL[category], count }))
}
