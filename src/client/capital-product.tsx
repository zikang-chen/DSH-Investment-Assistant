import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, EmptyState, MetricCard, PageHeader, StatusBadge, formatDate, formatMoney, formatNumber } from './design-system/index.js'
import { ACCOUNT_TYPE_LABEL, CAPITAL_NETWORTH_REQUEST, capitalCurrencyRows, portfolioPrincipal, type CapitalPayload, type PortfolioSnapshot } from './capital-ui-model.js'
import type { Deliver, DeliveryOutcome, ReadApi } from './workbench-model.js'

export const CAPITAL_TRANSACTION_TYPES = {
  DEPOSIT: '入金', WITHDRAWAL: '出金', BUY: '买入', SELL: '卖出',
  DIVIDEND: '分红', INTEREST: '利息', FEE: '费用', TAX: '税费',
} as const
export type CapitalTransactionType = keyof typeof CAPITAL_TRANSACTION_TYPES
export type CapitalAccounts = NonNullable<CapitalPayload['accounts']>
export interface CapitalDraft {
  accountId: string; eventType: CapitalTransactionType; occurredAt: string; currency: string
  assetId: string; quantity: string; unit: string; price: string; grossAmount: string; fee: string; tax: string; note: string
}
export interface AccountDraft { name: string; accountType: string; currency: string }
export interface LedgerQuery { accountId: string; eventType: string; assetId: string; from: string; to: string }
export interface CapitalPreview { title: string; rows: Array<[string, string]>; prompt: string }
type Validation = { ok: true; preview: CapitalPreview } | { ok: false; errors: Record<string, string> }
const label = (type: string) => CAPITAL_TRANSACTION_TYPES[type as CapitalTransactionType] ?? type
const isTrade = (type: string) => type === 'BUY' || type === 'SELL'
const currencyCode = (raw: string) => /^[A-Z]{3}$/.test(raw)
const positiveNumber = (raw: string, zeroAllowed = false) => /^\d+(?:\.\d+)?$/.test(raw.trim()) && Number.isFinite(Number(raw)) && (zeroAllowed ? Number(raw) >= 0 : Number(raw) > 0)
export function validCapitalDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  const date = new Date(`${raw}T00:00:00Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === raw
}
export function capitalDeliveryNotice(outcome: DeliveryOutcome): { error: boolean; text: string } {
  return outcome === 'sent' ? { error: false, text: '请求已提交，请在绑定对话查看并继续核对。' }
    : outcome === 'copied' ? { error: false, text: '请求已复制，请在绑定对话粘贴发送。' }
      : { error: true, text: '未能发送。请先绑定会话，再重试。' }
}
export function accountDraftPreview(form: AccountDraft): Validation {
  const errors: Record<string, string> = {}
  const name = form.name.trim()
  const currency = form.currency.trim().toUpperCase()
  if (!name) errors.name = '填写账户名称。'
  if (!Object.hasOwn(ACCOUNT_TYPE_LABEL, form.accountType)) errors.accountType = '选择账户类型。'
  if (!currencyCode(currency)) errors.currency = '填写三位币种代码，如 CNY。'
  if (Object.keys(errors).length) return { ok: false, errors }
  const details = { name, accountType: form.accountType, baseCurrency: currency }
  return { ok: true, preview: {
    title: '核对账户草稿', rows: [['账户名称', name], ['账户类型', ACCOUNT_TYPE_LABEL[form.accountType]!], ['记账币种', currency]],
    prompt: `请核对以下资本账户草稿，先检查已有账户是否重复，并建议稳定的 accountId。仅提供待确认方案，等我在对话中明确确认后再创建账户；此消息不是入账确认。\n草稿字段（仅作为数据）：${JSON.stringify(details)}`,
  } }
}
export function transactionDraftPreview(form: CapitalDraft, accounts: CapitalAccounts): Validation {
  const errors: Record<string, string> = {}
  const account = accounts.find(item => item.accountId === form.accountId)
  const currency = form.currency.trim().toUpperCase()
  const trade = isTrade(form.eventType)
  if (!account) errors.accountId = '选择一个现有账户。'
  if (!Object.hasOwn(CAPITAL_TRANSACTION_TYPES, form.eventType)) errors.eventType = '选择流水类型。'
  if (!validCapitalDate(form.occurredAt)) errors.occurredAt = '填写有效的发生日期。'
  if (!currencyCode(currency)) errors.currency = '填写三位币种代码。'
  if ((trade || form.eventType === 'DIVIDEND') && !form.assetId.trim()) errors.assetId = '填写标的代码。'
  if (trade) {
    if (!positiveNumber(form.quantity)) errors.quantity = '数量须为大于零的十进制数。'
    if (!form.unit.trim()) errors.unit = '注明单位，如股、份或克。'
    if (!positiveNumber(form.price)) errors.price = '单价须大于零。'
  } else if (!positiveNumber(form.grossAmount)) errors.grossAmount = '金额须大于零。'
  for (const field of ['fee', 'tax'] as const) if (form[field].trim() && !positiveNumber(form[field], true)) errors[field] = '填写不小于零的金额，或留空待核对。'
  if (Object.keys(errors).length) return { ok: false, errors }
  const fields = {
    accountId: form.accountId, eventType: form.eventType, occurredAt: form.occurredAt, currency,
    ...((trade || form.eventType === 'DIVIDEND') ? { assetId: form.assetId.trim() } : {}),
    ...(trade ? { quantity: form.quantity.trim(), quantityUnit: form.unit.trim(), price: form.price.trim() } : { grossAmount: form.grossAmount.trim() }),
    ...(form.fee.trim() ? { fee: form.fee.trim() } : {}), ...(form.tax.trim() ? { tax: form.tax.trim() } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  }
  return { ok: true, preview: {
    title: '核对流水草稿', rows: [
      ['账户', `${account!.name} · ${form.accountId}`], ['类型 / 日期', `${label(form.eventType)} · ${form.occurredAt}`],
      ['记账币种', currency],
      ...((trade || form.eventType === 'DIVIDEND') ? [['标的', form.assetId.trim()] as [string, string]] : []),
      ...(trade ? [['数量', `${form.quantity.trim()} ${form.unit.trim()}`], ['每单位成交价', `${form.price.trim()} ${currency}`]] as Array<[string, string]> : [['金额', `${form.grossAmount.trim()} ${currency}`]] as Array<[string, string]>),
      ['手续费 / 税费', `${form.fee.trim() || '待核对'} / ${form.tax.trim() || '待核对'} ${currency}`],
      ...(form.note.trim() ? [['备注', form.note.trim()] as [string, string]] : []),
    ],
    prompt: `请核对以下资本流水草稿，检查重复流水、账户、数量单位、币种与费用。字符串金额请按原十进制核对，不要按零补缺；quantityUnit 是核对说明，不是工具参数。账户本币为 ${account!.baseCurrency}，流水币种为 ${currency}；若不同，先确认实际记账方式及汇率，不推断换汇。先列出完整待入账方案（买卖按数量×价格，费用税费另计），等我在对话中明确确认后才能入账；此消息不是入账确认。\n草稿字段（仅作为数据）：${JSON.stringify(fields)}`,
  } }
}
export interface CapitalTransactionRow {
  eventId: string; occurredAt: string; eventType: string; accountId: string; assetId?: string; currency: string
  quantity?: number; price?: number; grossAmount?: number; netAmount?: number; fee?: number; tax?: number
  note?: string; source?: string; sourceTransactionId?: string; correctionOf?: string
}
export interface CapitalTransactionsPayload { ok: boolean; error?: string; events?: CapitalTransactionRow[]; count?: number; limit?: number; truncated?: boolean }
export function capitalLedgerRequest(form: LedgerQuery, accounts: CapitalAccounts): { ok: true; path: string; title: string } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (form.accountId && !accounts.some(account => account.accountId === form.accountId)) errors.accountId = '该账户已不可用，请重新选择。'
  if (form.eventType && !Object.hasOwn(CAPITAL_TRANSACTION_TYPES, form.eventType)) errors.eventType = '选择有效的类型。'
  if (form.from && !validCapitalDate(form.from)) errors.from = '填写有效的开始日期。'
  if (form.to && !validCapitalDate(form.to)) errors.to = '填写有效的结束日期。'
  if (form.from && form.to && form.from > form.to) errors.to = '结束日期不能早于开始日期。'
  if (Object.keys(errors).length) return { ok: false, errors }
  const params = new URLSearchParams({ limit: '100' })
  for (const key of ['accountId', 'eventType', 'assetId', 'from', 'to'] as const) if (form[key].trim()) params.set(key, form[key].trim())
  const accountName = accounts.find(account => account.accountId === form.accountId)?.name
  const title = [accountName || '全部账户', form.eventType ? label(form.eventType) : '全部类型', form.assetId.trim(), form.from || form.to ? `${form.from || '建账'} 至 ${form.to || '至今'}` : '全部日期'].filter(Boolean).join(' · ')
  return { ok: true, path: `/capital/transactions?${params}`, title }
}
function useCapitalTransactions(get: ReadApi, active: boolean, request: { path: string; title: string }, nonce = 0) {
  const [state, setState] = useState<{ data?: CapitalTransactionsPayload; pending: boolean; error?: string; title?: string; path?: string }>({ pending: false })
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++sequence.current
    setState(previous => ({ ...previous, pending: true, error: undefined }))
    try {
      const response = await get<CapitalTransactionsPayload>(request.path)
      if (!response.ok) throw new Error(response.error || '流水读取失败')
      if (!Array.isArray(response.events)) throw new Error('流水响应缺少记录列表')
      if (sequence.current === token) setState({ data: response, pending: false, title: request.title, path: request.path })
    } catch (cause) {
      if (sequence.current === token) setState(previous => ({ ...previous, pending: false, error: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [get, request.path, request.title])
  useEffect(() => {
    if (active) void refresh()
    return () => { sequence.current++ }
  }, [active, refresh, nonce])
  return [state, refresh] as const
}

export const capitalProductCss = `
.fia-root .fia-cap-product{display:grid;gap:var(--fia-space-4);min-width:0}
.fia-root .fia-cap-nav{display:flex;gap:var(--fia-space-2);flex-wrap:wrap;border-bottom:1px solid var(--fia-border);padding-bottom:var(--fia-space-3)}
.fia-root .fia-cap-toolbar{display:flex;align-items:center;justify-content:space-between;gap:var(--fia-space-3);flex-wrap:wrap}
.fia-root .fia-cap-toolbar select{min-width:100px}
.fia-root .fia-cap-caption{font-size:var(--fia-font-xs);color:var(--fia-muted);margin:0;overflow-wrap:anywhere}
.fia-root .fia-cap-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--fia-space-3)}
.fia-root .fia-cap-summary .fia-metric__value{font-size:var(--fia-font-xl)}
.fia-root .fia-cap-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fia-space-3)}
.fia-root .fia-cap-account{display:grid;gap:var(--fia-space-3);padding:var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface)}
.fia-root .fia-cap-account h3{margin:0;font-size:var(--fia-font-base)}
.fia-root .fia-cap-balance{display:flex;justify-content:space-between;gap:var(--fia-space-3);font-variant-numeric:tabular-nums}
.fia-root .fia-cap-form{display:grid;gap:var(--fia-space-4)}
.fia-root .fia-cap-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fia-space-3)}
.fia-root .fia-cap-form fieldset{min-width:0;border:0;margin:0;padding:0;display:grid;gap:var(--fia-space-3)}
.fia-root .fia-cap-form legend{font-size:var(--fia-font-sm);font-weight:650;padding:0 0 var(--fia-space-3)}
.fia-root .fia-cap-form textarea{width:100%;min-height:78px;resize:vertical;font:inherit}
.fia-root .fia-cap-details{border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);padding:var(--fia-space-3);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-cap-details summary{cursor:pointer;font-weight:600}
.fia-root .fia-cap-details[open]>summary{margin-bottom:var(--fia-space-3)}
.fia-root .fia-cap-preview{display:grid;gap:var(--fia-space-3);border:1px solid var(--fia-info);background:var(--fia-info-soft);border-radius:var(--fia-radius-md);padding:var(--fia-space-4)}
.fia-root .fia-cap-preview h3{margin:0;font-size:var(--fia-font-base)}
.fia-root .fia-cap-preview dl{display:grid;gap:var(--fia-space-2);margin:0}
.fia-root .fia-cap-preview dl>div{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,2fr);gap:var(--fia-space-3)}
.fia-root .fia-cap-preview dt{color:var(--fia-secondary)}
.fia-root .fia-cap-preview dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.fia-root .fia-cap-consent{display:flex;align-items:flex-start;gap:var(--fia-space-2);font-size:var(--fia-font-sm)}
.fia-root .fia-cap-consent input{width:auto;margin-top:3px}
.fia-root .fia-cap-action-row{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-2)}
.fia-root .fia-cap-status{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-3);padding:var(--fia-space-3);border-radius:var(--fia-radius-sm);background:var(--fia-info-soft);color:var(--fia-info);font-size:var(--fia-font-sm)}
.fia-root .fia-cap-status[data-error=true]{background:var(--fia-danger-soft);color:var(--fia-danger)}
.fia-root .fia-cap-form-error{margin:0;color:var(--fia-danger);font-size:var(--fia-font-sm)}
@container fia-capital (max-width:760px){.fia-root .fia-cap-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container fia-capital (max-width:480px){.fia-root .fia-cap-summary,.fia-root .fia-cap-card-grid,.fia-root .fia-cap-fields{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cap-preview dl>div{grid-template-columns:minmax(0,1fr);gap:var(--fia-space-1)}}
@media(max-width:540px){.fia-root .fia-cap-summary,.fia-root .fia-cap-card-grid,.fia-root .fia-cap-fields{grid-template-columns:minmax(0,1fr)}}
`
function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="fia-cw-section"><header className="fia-cw-heading"><h2>{title}</h2>{meta && <span className="fia-cw-heading__meta">{meta}</span>}</header>{children}</section>
}
function Table({ label: name, children }: { label: string; children: ReactNode }) {
  return <div className="fia-cw-scroll" role="region" aria-label={name} tabIndex={0}>{children}</div>
}
function Field({ name, title, errors, children }: { name: string; title: string; errors: Record<string, string>; children: (id: string, errorId?: string) => ReactNode }) {
  const id = useId()
  return <label className="fia-cw-field" htmlFor={id}><span>{title}</span>{children(id, errors[name] ? `${id}-error` : undefined)}{errors[name] && <span id={`${id}-error`} className="fia-cw-field__error">{errors[name]}</span>}</label>
}
interface CapitalProductProps {
  get: ReadApi; data?: CapitalPayload; pending: boolean; error?: string; refresh: () => Promise<void>; deliver: Deliver; portfolio?: PortfolioSnapshot
}
/** Guided drafts are delivered only after review. No write API or local financial engine. */
export function CapitalProduct({ get, data, pending, error, refresh, deliver, portfolio }: CapitalProductProps) {
  const [tab, setTab] = useState<'overview' | 'accounts' | 'ledger'>('overview')
  const [editor, setEditor] = useState<'account' | 'transaction'>()
  const [currencyChoice, setCurrencyChoice] = useState('')
  const [accountForm, setAccountForm] = useState<AccountDraft>({ name: '', accountType: 'securities', currency: 'CNY' })
  const [draft, setDraft] = useState<CapitalDraft>({ accountId: '', eventType: 'DEPOSIT', occurredAt: '', currency: '', assetId: '', quantity: '', unit: '', price: '', grossAmount: '', fee: '', tax: '', note: '' })
  const [query, setQuery] = useState<LedgerQuery>({ accountId: '', eventType: '', assetId: '', from: '', to: '' })
  const [submittedQuery, setSubmittedQuery] = useState<LedgerQuery>()
  const [ledgerNonce, setLedgerNonce] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [queryErrors, setQueryErrors] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<CapitalPreview>()
  const [consent, setConsent] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string; prompt: string; outcome?: DeliveryOutcome }>()
  const delivery = useRef(0)
  const running = useRef(false)
  const noticeRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  useEffect(() => () => { delivery.current++ }, [])
  useEffect(() => { if (editor) editorRef.current?.focus() }, [editor])
  useEffect(() => { if (notice) noticeRef.current?.focus() }, [notice])
  const accounts = data?.accounts ?? []
  const ledgerRequest = useMemo(() => {
    if (!submittedQuery) return { path: '', title: '' }
    const built = capitalLedgerRequest(submittedQuery, accounts)
    return built.ok ? { path: built.path, title: built.title } : { path: '', title: '' }
  }, [submittedQuery, accounts])
  const [ledger, refreshLedger] = useCapitalTransactions(get, tab === 'ledger' && !!ledgerRequest.path, ledgerRequest, ledgerNonce)
  const currencyRows = data ? capitalCurrencyRows(data) : []
  const currencies = [...new Set([...currencyRows.map(row => row.currency), ...accounts.map(account => account.baseCurrency)])].sort()
  const currency = currencies.includes(currencyChoice) ? currencyChoice : currencies[0]
  const row = currencyRows.find(item => item.currency === currency)
  const openEditor = (kind: 'account' | 'transaction', accountId?: string) => {
    setEditor(kind); setPreview(undefined); setConsent(false); setErrors({})
    if (kind === 'transaction') {
      const account = accounts.find(item => item.accountId === accountId) ?? accounts[0]
      setDraft(previous => ({ ...previous, accountId: account?.accountId ?? '', currency: account?.baseCurrency ?? '' }))
    }
  }
  const submit = async (prompt: string) => {
    if (running.current) return
    running.current = true
    const token = ++delivery.current
    setSending(true); setNotice(undefined)
    try {
      const outcome = await deliver(prompt)
      if (delivery.current === token) setNotice({ ...capitalDeliveryNotice(outcome), outcome, prompt })
    } catch (cause) {
      if (delivery.current === token) setNotice({ error: true, text: `发送失败：${cause instanceof Error ? cause.message : String(cause)}`, prompt })
    } finally { if (delivery.current === token) { running.current = false; setSending(false) } }
  }
  const makePreview = () => {
    const result = editor === 'account' ? accountDraftPreview(accountForm) : transactionDraftPreview(draft, accounts)
    if (!result.ok) { setErrors(result.errors); return }
    setErrors({}); setPreview(result.preview); setConsent(false); setNotice(undefined)
  }
  const setDraftField = (key: keyof CapitalDraft, value: string) => {
    setDraft(previous => ({ ...previous, [key]: value })); setErrors(previous => ({ ...previous, [key]: '' })); setPreview(undefined); setConsent(false)
  }
  const queryLedger = () => {
    const result = capitalLedgerRequest(query, accounts)
    if (!result.ok) { setQueryErrors(result.errors); return }
    setQueryErrors({}); setSubmittedQuery(query); setLedgerNonce(value => value + 1)
  }
  const viewAccountLedger = (accountId: string) => { setTab('ledger'); setQuery(previous => ({ ...previous, accountId })); setQueryErrors({}); setEditor(undefined) }
  const money = (value: number | null | undefined, code = currency) => code ? formatMoney(value, { currency: code, symbol: false }) : '—'
  const trade = isTrade(draft.eventType)
  const unavailable = pending || !data || !!error
  return <div className="fia-cap-product">
    <style>{capitalProductCss}</style>
    <PageHeader title="我的资本" description="查看资产与收益，核对每一笔资金往来。" actions={<>
      <Button onClick={() => void refresh()} disabled={pending}>{pending ? '读取中…' : '刷新'}</Button>
      <Button variant="primary" disabled={unavailable || sending} onClick={() => openEditor(accounts.length ? 'transaction' : 'account')}>{accounts.length ? '准备流水' : '添加账户'}</Button>
    </>} />
    <nav className="fia-cap-nav" aria-label="资本工作区">
      {([['overview', '资产与收益'], ['accounts', `账户${data ? ` · ${accounts.length}` : ''}`], ['ledger', `流水${data?.events !== undefined ? ` · ${formatNumber(data.events, 0)}` : ''}`]] as const).map(([key, title]) => <Button key={key} variant={tab === key ? 'primary' : 'ghost'} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{title}</Button>)}
    </nav>
    {error && <div className="fia-cap-status" data-error="true" role="alert"><span>账本读取失败：{error}{data ? ' · 当前展示上次快照' : ''}</span><Button disabled={pending} onClick={() => void refresh()}>重试读取</Button></div>}
    {!data && pending && <div className="fia-cw-message" role="status">正在读取本机账本…</div>}
    {notice && <div className="fia-cap-status" data-error={notice.error} role={notice.error ? 'alert' : 'status'} tabIndex={-1} ref={noticeRef}><span>{notice.text}</span>{notice.error && <Button disabled={sending} onClick={() => void submit(notice.prompt)}>重试发送</Button>}</div>}
    {sending && <div className="fia-cw-message" role="status">正在发送到绑定对话…</div>}
    {data && tab === 'overview' && <>
      {!accounts.length ? <EmptyState title="还没有资本账户" description="先添加一个账户，再核对入金、买卖或分红。" action={<Button variant="primary" disabled={unavailable || sending} onClick={() => openEditor('account')}>添加第一个账户</Button>} /> : <>
        <div className="fia-cap-toolbar"><h2 className="fia-cw-note">账本概览 · 自建账以来</h2><label className="fia-cw-field"><span>金额币种</span><select value={currency ?? ''} onChange={event => setCurrencyChoice(event.target.value)}>{!currencies.length && <option value="">待记录</option>}{currencies.map(code => <option key={code}>{code}</option>)}</select></label></div>
        <div className="fia-cap-summary">
          <MetricCard label={`现金余额${currency ? ` · ${currency}` : ''}`} value={money(row?.cash)} detail="账本现金" />
          <MetricCard label={`净投入${currency ? ` · ${currency}` : ''}`} value={money(row?.netInvested)} detail="外部入金减出金" />
          <MetricCard label={`已实现收益${currency ? ` · ${currency}` : ''}`} value={money(row?.realized)} detail="交易已实现项目" />
          <MetricCard label={`分红 / 利息${currency ? ` · ${currency}` : ''}`} value={money(row?.income)} detail="账本收入" />
        </div>
        <div className="fia-cap-toolbar"><p className="fia-cap-caption">原币金额 · — 待提供 · 净投入不是收益</p><div className="fia-cap-action-row"><Button disabled={sending} onClick={() => void submit(CAPITAL_NETWORTH_REQUEST)}>请 Agent 计算净资产</Button><Button disabled={sending} onClick={() => void submit('请使用 capital_performance 分析我的账本真实收益，分别列示净投入、已实现、未实现、分红利息、费用、XIRR 和 TWR。先核对价格与汇率的数据日期和来源；缺失项保留未知，追加本金不计为收益。只读分析，不记录交易。')}>请 Agent 分析真实收益</Button></div></div>
        <details className="fia-cap-details"><summary>分币种账本明细</summary>
          {!currencyRows.length ? <p className="fia-cw-note">暂无资金项目，核对首笔流水后查看。</p> : <Table label="分币种账本明细"><table className="fia-table fia-cw-table fia-cw-table--wide"><caption>原币金额 · 费用与税费单列 · 不跨币种求和</caption><thead><tr><th scope="col">币种</th>{['现金', '净投入', '已实现收益', '费用 / 税费', '分红 / 利息'].map(title => <th scope="col" data-numeric="true" key={title}>{title}</th>)}</tr></thead><tbody>{currencyRows.map(item => <tr key={item.currency}><td>{item.currency}</td>{[item.cash, item.netInvested, item.realized, item.fees, item.income].map((value, index) => <td key={index} data-numeric="true">{money(value, item.currency)}</td>)}</tr>)}</tbody></table></Table>}
        </details>
      </>}
      <Section title="当前持仓快照" meta={portfolio?.at ? formatDate(portfolio.at, { includeTime: true }) : '时间未注明'}>
        {!portfolio?.groups.length ? <div className="fia-cw-body"><p className="fia-cw-note">暂无持仓估值。可先维护账户与流水。</p></div> : <Table label="独立持仓估值快照"><table className="fia-table fia-cw-table"><caption>来自持仓页 · 与账本分开查看</caption><thead><tr><th scope="col">币种</th><th scope="col" data-numeric="true">持仓成本</th><th scope="col" data-numeric="true">现值</th><th scope="col" data-numeric="true">浮动盈亏</th><th scope="col">估值状态</th></tr></thead><tbody>{portfolio.groups.map(group => <tr key={group.currency}><td>{group.currency}</td><td data-numeric="true">{money(group.cost, group.currency)}</td><td data-numeric="true">{money(group.value, group.currency)}{group.missing.length > 0 && group.value !== null && <span className="fia-cw-id">已定价部分</span>}</td><td data-numeric="true">{money(group.missing.length ? undefined : group.profit, group.currency)}</td><td>{portfolioPrincipal(portfolio, group.currency).ok ? <StatusBadge>完整</StatusBadge> : <><StatusBadge tone="warning">待补行情</StatusBadge><span className="fia-cw-id">{group.missing.join('、') || '现值缺失'}</span></>}</td></tr>)}</tbody></table></Table>}
      </Section>
      <details className="fia-cap-details"><summary>估值范围与口径</summary><p className="fia-cw-note">账本展示现金、成本与已实现项目，净资产估值需补齐价格和汇率。持仓快照单独列示，不与账本相加；贵金属、现金及其他资产按已登记范围查看。</p>{portfolio?.basis && <p className="fia-cap-caption">持仓来源：{portfolio.basis}</p>}</details>
    </>}
    {data && tab === 'accounts' && <>
      <div className="fia-cap-toolbar"><p className="fia-cw-note">按账户核对币种与现金余额</p><Button disabled={unavailable || sending} onClick={() => openEditor('account')}>添加账户</Button></div>
      {!accounts.length ? <EmptyState title="先建立一个账户" description="只需账户名称、类型和记账币种。" action={<Button disabled={unavailable || sending} onClick={() => openEditor('account')}>准备账户草稿</Button>} /> : <div className="fia-cap-card-grid">{accounts.map(account => {
        const cash = data.cash?.filter(item => item.accountId === account.accountId) ?? []
        return <article key={account.accountId} className="fia-cap-account"><div className="fia-cap-toolbar"><h3>{account.name}</h3><StatusBadge>{ACCOUNT_TYPE_LABEL[account.accountType] ?? account.accountType}</StatusBadge></div><p className="fia-cap-caption">记账币种 {account.baseCurrency} · {account.accountId}</p>
          {!cash.length ? <p className="fia-cw-note">暂无现金余额记录</p> : cash.map((item, index) => <div className="fia-cap-balance" key={`${item.currency}-${index}`}><span>{item.currency} 现金</span><strong>{money(item.amount, item.currency)}</strong></div>)}
          <div className="fia-cap-action-row"><Button onClick={() => viewAccountLedger(account.accountId)}>查询流水</Button><Button disabled={unavailable || sending} onClick={() => openEditor('transaction', account.accountId)}>准备流水</Button></div>
        </article>
      })}</div>}
    </>}
    {data && tab === 'ledger' && <>
      <Section title="交易流水" meta={ledger.data ? `${ledger.data.count ?? ledger.data.events?.length ?? 0} 笔` : undefined}><form className="fia-cw-body fia-cap-form" noValidate onSubmit={event => { event.preventDefault(); queryLedger() }}>
        <div className="fia-cap-fields">
          <Field name="accountId" title="账户" errors={queryErrors}>{(id, errorId) => <select id={id} value={query.accountId} aria-invalid={!!queryErrors.accountId} aria-describedby={errorId} onChange={event => setQuery(previous => ({ ...previous, accountId: event.target.value }))}><option value="">全部账户</option>{accounts.map(account => <option value={account.accountId} key={account.accountId}>{account.name} · {account.accountId}</option>)}</select>}</Field>
          <Field name="eventType" title="类型" errors={queryErrors}>{(id, errorId) => <select id={id} value={query.eventType} aria-invalid={!!queryErrors.eventType} aria-describedby={errorId} onChange={event => setQuery(previous => ({ ...previous, eventType: event.target.value }))}><option value="">全部类型</option>{Object.entries(CAPITAL_TRANSACTION_TYPES).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select>}</Field>
          {(['from', 'to'] as const).map(key => <Field key={key} name={key} title={key === 'from' ? '开始日期（可选）' : '结束日期（可选）'} errors={queryErrors}>{(id, errorId) => <input id={id} type="date" value={query[key]} aria-invalid={!!queryErrors[key]} aria-describedby={errorId} onChange={event => setQuery(previous => ({ ...previous, [key]: event.target.value }))} />}</Field>)}
          <Field name="assetId" title="标的代码（可选）" errors={queryErrors}>{id => <input id={id} value={query.assetId} placeholder="如 600519 / AAPL" onChange={event => setQuery(previous => ({ ...previous, assetId: event.target.value }))} />}</Field>
        </div>
        <div className="fia-cap-action-row"><Button type="submit" variant="primary" disabled={!data}>查询</Button><Button disabled={unavailable || sending || !accounts.length} onClick={() => openEditor('transaction')}>准备新流水</Button><Button disabled={sending} onClick={() => void submit('请引导我提供券商交易 CSV，使用 capital_ledger_import_preview 预览并列出校验、重复项和入账差异。收到文件后先做预览，等我明确确认批次再执行 capital_ledger_import_confirm；现在不要写入账本。')}>请 Agent 协助导入 CSV</Button></div>
        {Object.keys(queryErrors).length > 0 && <p className="fia-cap-form-error" role="alert">请修正标出的筛选条件。</p>}
      </form>
      <div className="fia-cw-body">
        {!ledger.data && ledger.pending ? <p className="fia-cw-note" role="status">正在读取流水…</p> : null}
        {ledger.error ? <div className="fia-cap-status" data-error="true" role="alert"><span>流水读取失败：{ledger.error}</span><Button onClick={() => void refreshLedger()}>重试</Button></div> : null}
        {ledger.data ? <>
          <p className="fia-cap-caption">{ledger.title ?? ''} · {ledger.data.count ?? 0} 笔{(ledger.data.count ?? 0) >= (ledger.data.limit ?? 100) ? ` · 仅显示最近 ${ledger.data.limit} 笔，缩小日期范围可查更早` : ''}</p>
          {!ledger.data.events?.length ? <EmptyState title="没有符合条件的流水" description="调整账户、类型或日期后重新查询。" /> : <Table label="交易流水"><table className="fia-table fia-cw-table fia-cw-table--wide"><thead><tr>{['日期', '类型', '账户', '标的', '数量', '价格', '金额', '费用/税费', '备注'].map(title => <th key={title} scope="col" data-numeric={['数量', '价格', '金额', '费用/税费'].includes(title) ? 'true' : undefined}>{title}</th>)}</tr></thead><tbody>
            {ledger.data.events.map(event => <tr key={event.eventId}>
              <td>{event.occurredAt}</td><td>{CAPITAL_TRANSACTION_TYPES[event.eventType as CapitalTransactionType] ?? event.eventType}{event.correctionOf ? ' · 更正' : ''}</td>
              <td>{accounts.find(account => account.accountId === event.accountId)?.name ?? event.accountId}</td><td>{event.assetId || '—'}</td>
              <td data-numeric="true">{event.quantity ? formatNumber(event.quantity, { maximumFractionDigits: 6 }) : '—'}</td>
              <td data-numeric="true">{event.price ? formatMoney(event.price, { currency: event.currency, symbol: false }) : '—'}</td>
              <td data-numeric="true">{formatMoney(event.grossAmount, { currency: event.currency, symbol: false })}</td>
              <td data-numeric="true">{[event.fee, event.tax].filter(value => typeof value === 'number').length ? formatMoney((event.fee ?? 0) + (event.tax ?? 0), { currency: event.currency, symbol: false }) : '—'}</td>
              <td>{event.note || '—'}</td>
            </tr>)}
          </tbody></table></Table>}
        </> : null}
      </div></Section>
      <Section title="账本持仓成本" meta="原币成本"><Table label="账本持仓数量与成本"><table className="fia-table fia-cw-table"><caption>数量沿用账本原始单位 · 成本不是市值</caption><thead><tr><th scope="col">标的</th><th scope="col">币种</th><th scope="col" data-numeric="true">数量（原始单位）</th><th scope="col" data-numeric="true">总成本</th><th scope="col" data-numeric="true">平均成本 / 单位</th></tr></thead><tbody>{data.positions?.map(position => <tr key={`${position.assetId}-${position.currency}`}><td>{position.assetId}</td><td>{position.currency}</td><td data-numeric="true">{formatNumber(position.quantity, { maximumFractionDigits: 6 })}</td><td data-numeric="true">{money(position.cost, position.currency)}</td><td data-numeric="true">{formatMoney(position.averageCost, { currency: position.currency, symbol: false, maximumFractionDigits: 4 })}</td></tr>)}{!data.positions?.length && <tr><td colSpan={5}>暂无持仓成本记录</td></tr>}</tbody></table></Table></Section>
    </>}
    {editor && <div ref={editorRef} tabIndex={-1}><Section title={editor === 'account' ? '准备账户' : '准备流水'} meta={<Button disabled={sending} onClick={() => { setEditor(undefined); setPreview(undefined); setErrors({}) }}>关闭</Button>}>
      <div className="fia-cw-body">
        {preview ? <div className="fia-cap-preview"><h3>{preview.title}</h3><dl>{preview.rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl><p className="fia-cap-caption">下一步发送给 Agent 核对，再在对话确认入账。</p><label className="fia-cap-consent"><input type="checkbox" checked={consent} disabled={sending} onChange={event => setConsent(event.target.checked)} /><span>将以上字段发送到绑定对话</span></label><div className="fia-cap-action-row"><Button disabled={sending} onClick={() => { setPreview(undefined); setConsent(false) }}>返回修改</Button><Button variant="primary" disabled={!consent || sending || unavailable || (notice?.outcome === 'sent' && notice.prompt === preview.prompt)} onClick={() => void submit(preview.prompt)}>{sending ? '发送中…' : notice?.outcome === 'sent' && notice.prompt === preview.prompt ? '已提交核对' : '发送给 Agent 核对'}</Button></div></div> : <form className="fia-cap-form" noValidate onSubmit={event => { event.preventDefault(); makePreview() }}>
          <p className="fia-cap-caption">{editor === 'account' ? '填写名称、类型和币种，先查看草稿。' : '填写真实发生的流水，再核对字段。'}</p>
          {editor === 'account' ? <div className="fia-cap-fields">
            <Field name="name" title="账户名称" errors={errors}>{(id, errorId) => <input id={id} value={accountForm.name} placeholder="如 日常证券账户" aria-invalid={!!errors.name} aria-describedby={errorId} onChange={event => setAccountForm(previous => ({ ...previous, name: event.target.value }))} />}</Field>
            <Field name="accountType" title="账户类型" errors={errors}>{(id, errorId) => <select id={id} value={accountForm.accountType} aria-invalid={!!errors.accountType} aria-describedby={errorId} onChange={event => setAccountForm(previous => ({ ...previous, accountType: event.target.value }))}>{Object.entries(ACCOUNT_TYPE_LABEL).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select>}</Field>
            <Field name="currency" title="记账币种" errors={errors}>{(id, errorId) => <input id={id} value={accountForm.currency} placeholder="CNY / USD / HKD" aria-invalid={!!errors.currency} aria-describedby={errorId} onChange={event => setAccountForm(previous => ({ ...previous, currency: event.target.value }))} />}</Field>
          </div> : <>
            <fieldset><legend>1. 选择账户与流水类型</legend><div className="fia-cap-fields">
              <Field name="accountId" title="账户" errors={errors}>{(id, errorId) => <select id={id} value={draft.accountId} aria-invalid={!!errors.accountId} aria-describedby={errorId} onChange={event => { const account = accounts.find(item => item.accountId === event.target.value); setDraft(previous => ({ ...previous, accountId: event.target.value, currency: account?.baseCurrency ?? '' })) }}><option value="">选择账户</option>{accounts.map(account => <option value={account.accountId} key={account.accountId}>{account.name} · {account.baseCurrency}</option>)}</select>}</Field>
              <Field name="eventType" title="流水类型" errors={errors}>{(id, errorId) => <select id={id} value={draft.eventType} aria-invalid={!!errors.eventType} aria-describedby={errorId} onChange={event => setDraftField('eventType', event.target.value)}>{Object.entries(CAPITAL_TRANSACTION_TYPES).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select>}</Field>
            </div></fieldset>
            <fieldset><legend>2. 填写发生信息</legend><div className="fia-cap-fields">
              <Field name="occurredAt" title="发生日期" errors={errors}>{(id, errorId) => <input id={id} type="date" value={draft.occurredAt} aria-invalid={!!errors.occurredAt} aria-describedby={errorId} onChange={event => setDraftField('occurredAt', event.target.value)} />}</Field>
              <Field name="currency" title="流水币种" errors={errors}>{(id, errorId) => <input id={id} value={draft.currency} aria-invalid={!!errors.currency} aria-describedby={errorId} onChange={event => setDraftField('currency', event.target.value)} />}</Field>
              {(trade || draft.eventType === 'DIVIDEND') && <Field name="assetId" title="标的代码" errors={errors}>{(id, errorId) => <input id={id} value={draft.assetId} placeholder="如 600519 / AAPL" aria-invalid={!!errors.assetId} aria-describedby={errorId} onChange={event => setDraftField('assetId', event.target.value)} />}</Field>}
              {(trade ? (['quantity', 'unit', 'price'] as const) : (['grossAmount'] as const)).map(key => <Field key={key} name={key} title={({ quantity: '数量', unit: '数量单位（股 / 份 / 克等）', price: `成交单价 · ${draft.currency || '流水币种'}`, grossAmount: `金额 · ${draft.currency || '流水币种'}` })[key]} errors={errors}>{(id, errorId) => <input id={id} value={draft[key]} inputMode={key === 'unit' ? 'text' : 'decimal'} aria-invalid={!!errors[key]} aria-describedby={errorId} onChange={event => setDraftField(key, event.target.value)} />}</Field>)}
            </div></fieldset>
            <details className="fia-cap-details"><summary>费用、税费与备注（可选）</summary><div className="fia-cap-fields">{(['fee', 'tax'] as const).map(key => <Field key={key} name={key} title={`${key === 'fee' ? '手续费' : '税费'} · ${draft.currency || '流水币种'}`} errors={errors}>{(id, errorId) => <input id={id} inputMode="decimal" value={draft[key]} placeholder="留空待核对" aria-invalid={!!errors[key]} aria-describedby={errorId} onChange={event => setDraftField(key, event.target.value)} />}</Field>)}</div><Field name="note" title="备注" errors={errors}>{id => <textarea id={id} value={draft.note} onChange={event => setDraftField('note', event.target.value)} />}</Field></details>
            <p className="fia-cap-caption">换汇、内部转账与公司行为请在对话逐项核对。</p>
          </>}
          {Object.values(errors).some(Boolean) && <div role="alert"><p className="fia-cap-form-error">请修正标出的字段。{errors.fee || errors.tax ? '检查「费用、税费与备注」中的金额。' : ''}</p></div>}
          <div className="fia-cap-action-row"><Button variant="primary" type="submit" disabled={sending || unavailable}>核对草稿</Button><span className="fia-cap-caption">草稿仅保留在当前页面</span></div>
        </form>}
      </div>
    </Section></div>}
    {!!data?.warnings?.length && <details className="fia-cap-details"><summary>需要核对 · {data.warnings.length} 项</summary><ul className="fia-cw-list">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
  </div>
}
