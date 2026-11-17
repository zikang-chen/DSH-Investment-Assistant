import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, StatusBadge } from './design-system/index.js'
import { SecuritySearch } from './security-search.js'
import { requestSecurityOpen, type SecurityIdentity } from './security-model.js'
import type { ReadApi } from './workbench-model.js'
import {
  changeHoldingQuery, emptyHoldingDraft, holdingPreviewFeedback, holdingPreviewKey,
  holdingQuantityUnit, selectHoldingSecurity, validateHoldingDraft,
  type HoldingEntryDraft,
  type HoldingPreviewFeedback, type HoldingPreviewPayload, type HoldingPreviewReply,
} from './holding-entry-model.js'

export interface HoldingEntryProps {
  get?: ReadApi
  onPreview: (payload: HoldingPreviewPayload) => Promise<HoldingPreviewReply>
  onReview: () => void
  /** Parent-owned draft keeps in-progress input when the user opens a dossier and comes back. */
  draft?: HoldingEntryDraft
  onDraftChange?: (draft: HoldingEntryDraft) => void
}

const holdingEntryCss = `
.fia-root .fia-holding-entry{min-width:0;container-type:inline-size;color:var(--fia-text)}
.fia-root .fia-holding-entry__form{min-width:0;margin:0}
.fia-root .fia-holding-entry__fieldset{min-width:0;margin:0;padding:0;border:0;display:grid;grid-template-columns:minmax(0,1fr);gap:var(--fia-space-3)}
.fia-root .fia-holding-entry__full{grid-column:1/-1;min-width:0}
.fia-root .fia-holding-entry__field{display:flex;flex-direction:column;gap:var(--fia-space-1);min-width:0}
.fia-root .fia-holding-entry__field>label{color:var(--fia-secondary);font-size:var(--fia-font-sm);font-weight:600}
.fia-root .fia-holding-entry :is(input,select){min-width:0;width:100%;height:var(--fia-control-height);min-height:32px}
.fia-root .fia-holding-entry__number{text-align:right;font-variant-numeric:tabular-nums}
.fia-root .fia-holding-entry__hint{margin:0;color:var(--fia-muted);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-holding-entry__error{margin:0;color:var(--fia-danger);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-holding-entry__selection{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-2);min-width:0;margin-top:var(--fia-space-2)}
.fia-root .fia-holding-entry__name{max-width:100%;height:auto;min-height:32px;white-space:normal;text-align:left;overflow-wrap:anywhere;padding-inline:0}
.fia-root .fia-holding-entry__code{font-family:var(--fia-font-mono);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-holding-entry__actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-2);margin-top:var(--fia-space-3)}
.fia-root .fia-holding-entry__feedback{display:flex;flex-direction:column;align-items:flex-start;gap:var(--fia-space-2);margin-top:var(--fia-space-3);padding:var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);overflow-wrap:anywhere}
.fia-root .fia-holding-entry__feedback p{margin:0;font-size:var(--fia-font-sm)}
@container (min-width:520px){.fia-root .fia-holding-entry__fieldset{grid-template-columns:repeat(2,minmax(0,1fr))}}
`

/** A proposal-only form. The parent owns the existing preview API; only Home confirms it. */
export function HoldingEntry(props: HoldingEntryProps) {
  const id = useId()
  const [draft, setDraft] = useState<HoldingEntryDraft>(() => props.draft ?? emptyHoldingDraft())
  // Notify the parent only when the draft actually changes; it survives tab switches.
  useEffect(() => { props.onDraftChange?.(draft) }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<(HoldingPreviewFeedback & { security: string; key: string }) | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const validation = validateHoldingDraft(draft)
  const errors = attempted ? validation.errors : {}
  const unit = holdingQuantityUnit(draft.selected)
  const unchangedPending = feedback?.kind === 'confirmation' && validation.ok && feedback.key === holdingPreviewKey(validation.payload)

  function queryChanged(query: string) {
    // SecuritySearch calls this synchronously BEFORE any debounced read.
    setDraft(current => changeHoldingQuery(current, query))
    setAttempted(false)
  }
  function securitySelected(item: SecurityIdentity) {
    setDraft(current => selectHoldingSecurity(current, item))
    setAttempted(false)
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || !props.get || unchangedPending) return
    setAttempted(true)
    const result = validateHoldingDraft(draft)
    if (!result.ok) return
    // Ref guard covers duplicate submits before React can render disabled controls.
    busy.current = true
    setSubmitting(true)
    setFeedback(null)
    const security = `${draft.selected?.name || result.payload.code} · ${result.payload.code}`
    const key = holdingPreviewKey(result.payload)
    try {
      const reply = await props.onPreview(result.payload)
      if (mounted.current) setFeedback({ ...holdingPreviewFeedback(reply), security, key })
    } catch (error) {
      if (mounted.current) setFeedback({
        ...holdingPreviewFeedback({ ok: false, error: error instanceof Error ? error.message : String(error) }), security, key,
      })
    } finally {
      busy.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  return <section className="fia-holding-entry" aria-label="持仓录入">
    <style>{holdingEntryCss}</style>
    <form className="fia-holding-entry__form" onSubmit={event => void submit(event)} noValidate aria-busy={submitting}>
      <fieldset className="fia-holding-entry__fieldset" disabled={submitting}>
        <legend className="fia-sr-only">新增或更新持仓预览</legend>
        <div className="fia-holding-entry__full">
          {props.get
            ? <SecuritySearch get={props.get} onSelect={securitySelected} onQueryChange={queryChanged}
              label="证券代码 / 名称" placeholder="输入代码或名称片段，选择真实匹配候选" compact />
            : <div className="fia-holding-entry__field">
              <label htmlFor={`${id}-search-unavailable`}>证券代码 / 名称</label>
              <input id={`${id}-search-unavailable`} disabled value="" placeholder="搜索服务未连接" />
            </div>}
          <p className="fia-holding-entry__hint">代码或名称片段均可搜索；必须选择候选。修改输入后须重新选择，不能沿用旧代码。</p>
          {!props.get && <p className="fia-holding-entry__error" role="alert">搜索服务未连接，无法核验证券；暂不能生成持仓预览。</p>}
          {errors.security && <p className="fia-holding-entry__error" role="alert">{errors.security}</p>}
          {draft.selected && <div className="fia-holding-entry__selection">
            <StatusBadge tone="info">已选择{draft.selected.type === 'fund' ? '基金' : '股票'}</StatusBadge>
            <Button variant="ghost" className="fia-holding-entry__name" onClick={() => requestSecurityOpen(draft.selected!)}
              title="打开证券详细档案，可查看 K 线或问 Agent" aria-label={`查看 ${draft.selected.name || draft.selected.code} 的详细档案、K 线或 Agent`}>
              {draft.selected.name || draft.selected.code}
            </Button>
            <code className="fia-holding-entry__code">{draft.selected.code}</code>
            <span className="fia-holding-entry__hint">点击名称查看档案 / K 线 / Agent</span>
          </div>}
        </div>
        <div className="fia-holding-entry__field">
          <label htmlFor={`${id}-type`}>资产类型</label>
          <select id={`${id}-type`} name="type" value={draft.selected?.type ?? ''} disabled aria-describedby={`${id}-type-help`}>
            <option value="">选择候选后识别</option><option value="stock">股票</option><option value="fund">基金</option>
          </select>
          <p id={`${id}-type-help`} className="fia-holding-entry__hint">由候选的市场 / 类型识别；不按代码位数猜测基金。</p>
        </div>
        <div className="fia-holding-entry__field">
          <label htmlFor={`${id}-quantity`}>数量（{unit}）</label>
          <input id={`${id}-quantity`} name="quantity" className="fia-holding-entry__number" type="number" inputMode="decimal" min="0" step="any" required
            value={draft.quantity} placeholder="填写持有数量" aria-invalid={!!errors.quantity} aria-describedby={errors.quantity ? `${id}-quantity-error` : undefined}
            onChange={event => setDraft(current => ({ ...current, quantity: event.target.value }))} />
          {errors.quantity && <p id={`${id}-quantity-error`} className="fia-holding-entry__error" role="alert">{errors.quantity}</p>}
        </div>
        <div className="fia-holding-entry__field">
          <label htmlFor={`${id}-cost`}>平均成本（报价币种）</label>
          <input id={`${id}-cost`} name="avgCost" className="fia-holding-entry__number" type="number" inputMode="decimal" min="0" step="any" required
            value={draft.avgCost} placeholder="填写每股 / 每份成本" aria-invalid={!!errors.avgCost} aria-describedby={`${id}-cost-help${errors.avgCost ? ` ${id}-cost-error` : ''}`}
            onChange={event => setDraft(current => ({ ...current, avgCost: event.target.value }))} />
          <p id={`${id}-cost-help`} className="fia-holding-entry__hint">每股 / 每份成本，与证券报价同币种；不自动换算汇率。</p>
          {errors.avgCost && <p id={`${id}-cost-error`} className="fia-holding-entry__error" role="alert">{errors.avgCost}</p>}
        </div>
        <p className="fia-holding-entry__hint fia-holding-entry__full">数量与成本允许显式填写 0，空白不会按 0 处理。此表单只生成变更预览，不直接写入持仓。</p>
      </fieldset>
      <div className="fia-holding-entry__actions">
        <Button type="submit" variant="primary" disabled={submitting || !props.get || unchangedPending}>
          {submitting ? '正在生成预览…' : unchangedPending ? '已生成待确认预览' : '生成持仓预览'}
        </Button>
        <Button onClick={props.onReview}>去首页人工确认</Button>
      </div>
    </form>
    {submitting && <p className="fia-holding-entry__hint" role="status" aria-live="polite">正在等待预览回执，尚未写入持仓；请勿重复提交。</p>}
    {feedback && <div className="fia-holding-entry__feedback" role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      <StatusBadge tone={feedback.kind === 'confirmation' ? 'warning' : 'danger'}>{feedback.kind === 'confirmation' ? '待人工确认 · 未写入' : '预览未完成'}</StatusBadge>
      <p>{feedback.security}</p>
      <p>{feedback.message}</p>
      <Button onClick={props.onReview}>前往个人首页核对</Button>
    </div>}
  </section>
}
