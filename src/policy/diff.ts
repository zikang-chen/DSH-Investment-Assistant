/**
 * Paragraph-level diff for policy revisions.
 *
 * Deterministic, dependency-free, and citation-friendly: a change is reported
 * with the paragraph index on both sides so the report can quote "第 3 段
 * 原来写 500 亿元，现在写 600 亿元" instead of a vague "内容有调整".
 *
 * Algorithm: LCS over normalized paragraphs for the stable core, then pair the
 * unmatched leftovers by token overlap so an edit reads as `changed` rather than
 * one removal plus one addition.
 */
import { tokenize } from './store.js'

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface ParagraphChange {
  kind: ChangeKind
  /** Index in the new document (`added` / `changed`). */
  index?: number
  /** Index in the old document (`removed` / `changed`). */
  oldIndex?: number
  text?: string
  oldText?: string
}

export interface ParagraphDiff {
  added: ParagraphChange[]
  removed: ParagraphChange[]
  changed: ParagraphChange[]
  unchanged: number
  /** Share of old paragraphs that survived verbatim (0–1). */
  retained: number
  summary: string
}

const normalize = (s: string): string => s.replace(/\s+/g, '')

/** Token-overlap similarity in [0,1] (CJK bigrams + ASCII words). */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / Math.max(left.size, right.size)
}

/** Longest-common-subsequence matching over normalized paragraph arrays. */
function lcsMatches(oldN: string[], newN: string[]): Array<[number, number]> {
  const rows = oldN.length
  const cols = newN.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j] = oldN[i] === newN[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (oldN[i] === newN[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

/** Diff two paragraph arrays. */
export function diffParagraphs(oldParas: string[], newParas: string[]): ParagraphDiff {
  const oldN = oldParas.map(normalize)
  const newN = newParas.map(normalize)
  const pairs = lcsMatches(oldN, newN)
  const matchedOld = new Set(pairs.map(([i]) => i))
  const matchedNew = new Set(pairs.map(([, j]) => j))
  const leftoverOld: number[] = []
  const leftoverNew: number[] = []
  for (let i = 0; i < oldParas.length; i++) if (!matchedOld.has(i)) leftoverOld.push(i)
  for (let j = 0; j < newParas.length; j++) if (!matchedNew.has(j)) leftoverNew.push(j)

  const changed: ParagraphChange[] = []
  const removed: ParagraphChange[] = []
  const usedNew = new Set<number>()
  for (const oi of leftoverOld) {
    let best: { nj: number; score: number } | undefined
    for (const nj of leftoverNew) {
      if (usedNew.has(nj)) continue
      const score = similarity(oldParas[oi] ?? '', newParas[nj] ?? '')
      if (score >= 0.35 && (!best || score > best.score)) best = { nj, score }
    }
    if (best) {
      usedNew.add(best.nj)
      changed.push({ kind: 'changed', oldIndex: oi, index: best.nj, oldText: oldParas[oi], text: newParas[best.nj] })
    } else {
      removed.push({ kind: 'removed', oldIndex: oi, oldText: oldParas[oi] })
    }
  }
  const added: ParagraphChange[] = leftoverNew
    .filter((nj) => !usedNew.has(nj))
    .map((nj) => ({ kind: 'added' as const, index: nj, text: newParas[nj] }))

  changed.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  added.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  removed.sort((a, b) => (a.oldIndex ?? 0) - (b.oldIndex ?? 0))

  const retained = oldParas.length === 0 ? 1 : pairs.length / oldParas.length
  const parts: string[] = []
  if (changed.length > 0) parts.push(`改写 ${changed.length} 段`)
  if (added.length > 0) parts.push(`新增 ${added.length} 段`)
  if (removed.length > 0) parts.push(`删除 ${removed.length} 段`)
  return {
    added,
    removed,
    changed,
    unchanged: pairs.length,
    retained,
    summary: parts.length > 0 ? `${parts.join('，')}；保留 ${pairs.length} 段原文` : '正文完全一致',
  }
}

/** Extract the numeric tokens from a paragraph — used to flag real value changes. */
export function numbersIn(text: string): string[] {
  return [...String(text ?? '').matchAll(/-?\d+(?:\.\d+)?\s*(?:%|％|亿元|万元|元|GW|MW|万千瓦|亿吨|万吨|万辆|万台|个|项|家)?/g)]
    .map((m) => m[0].replace(/\s+/g, ''))
}

/** True when a `changed` pair actually moved numbers (金额/目标/期限). */
export function hasNumericChange(change: ParagraphChange): boolean {
  if (change.kind !== 'changed') return false
  const before = numbersIn(change.oldText ?? '').join('|')
  const after = numbersIn(change.text ?? '').join('|')
  return before !== after
}
