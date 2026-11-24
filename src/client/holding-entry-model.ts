import type { SecurityIdentity } from './security-model.js'

/** This is a UI draft, not a portfolio row. An unselected query is never a code. */
export interface HoldingEntryDraft {
  query: string
  selected: SecurityIdentity | null
  quantity: string
  avgCost: string
}
export interface HoldingPreviewPayload {
  code: string
  quantity: number
  avgCost: number
  type: 'stock' | 'fund'
}
export interface HoldingPreviewReply { ok: boolean; confirmationRequired?: boolean; error?: string }
export type HoldingEntryErrors = Partial<Record<'security' | 'quantity' | 'avgCost', string>>
export type HoldingEntryValidation =
  | { ok: true; payload: HoldingPreviewPayload; errors: HoldingEntryErrors }
  | { ok: false; errors: HoldingEntryErrors }
export interface HoldingPreviewFeedback { kind: 'confirmation' | 'error'; message: string }

export function emptyHoldingDraft(): HoldingEntryDraft {
  return { query: '', selected: null, quantity: '', avgCost: '' }
}

/** Invalidate synchronously on EVERY edit, even if only whitespace was changed. */
export function changeHoldingQuery(draft: HoldingEntryDraft, query: string): HoldingEntryDraft {
  return { ...draft, query, selected: null }
}

/** Only the real search component's candidate-selection callback calls this. */
export function selectHoldingSecurity(draft: HoldingEntryDraft, item: SecurityIdentity): HoldingEntryDraft {
  return {
    ...draft,
    query: item.name || item.code,
    selected: { code: item.code.trim(), name: item.name, type: item.type },
  }
}

/** Match a decimal number input; do not turn empty strings, hex or non-finite input into zero. */
export function parseHoldingNumber(raw: string): number | undefined {
  const value = raw.trim()
  if (!value || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function holdingQuantityUnit(item: SecurityIdentity | null): string {
  return item ? (item.type === 'fund' ? '份' : '股') : '股 / 份'
}

export function validateHoldingDraft(draft: HoldingEntryDraft): HoldingEntryValidation {
  const errors: HoldingEntryErrors = {}
  const item = draft.selected
  // Same code syntax and nonnegative constraints as PortfolioStore; no fund inference by code length.
  if (!item || !['stock', 'fund'].includes(item.type) || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,31}$/.test(item.code.trim())) {
    errors.security = '请从搜索结果中选择证券。'
  }
  const quantity = parseHoldingNumber(draft.quantity)
  const avgCost = parseHoldingNumber(draft.avgCost)
  if (quantity === undefined) errors.quantity = `请填写有效数量（${holdingQuantityUnit(item)}，可为 0）。`
  if (avgCost === undefined) errors.avgCost = '请填写有效平均成本（报价币种，可为 0）。'
  if (Object.keys(errors).length || !item || quantity === undefined || avgCost === undefined) return { ok: false, errors }
  return { ok: true, errors, payload: { code: item.code.trim(), quantity, avgCost, type: item.type } }
}

/** Do not interpret ok alone as a confirmed write, or even as a valid pending preview. */
export function holdingPreviewFeedback(reply: HoldingPreviewReply): HoldingPreviewFeedback {
  if (reply.ok && reply.confirmationRequired === true) {
    return { kind: 'confirmation', message: '请到个人首页核对并确认变更。' }
  }
  return {
    kind: 'error',
    message: reply.ok
      ? '预览状态未确认。请先到个人首页查看待确认项，再重试。'
      : `预览失败：${reply.error || '服务未返回有效结果'}。输入已保留，可重试或到个人首页查看。`,
  }
}

export function holdingPreviewKey(payload: HoldingPreviewPayload): string {
  return JSON.stringify([payload.type, payload.code, payload.quantity, payload.avgCost])
}
