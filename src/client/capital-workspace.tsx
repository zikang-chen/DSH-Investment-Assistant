import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, EmptyState, MetricCard, PageHeader, StatusBadge,
  formatDate, formatMoney, formatNumber, formatPercent,
} from './design-system/index.js'
import { deliveryFeedback, type Deliver, type ReadApi, type UsePanelBus } from './workbench-model.js'
import {
  ACCOUNT_TYPE_LABEL, CAPITAL_NETWORTH_REQUEST, INITIAL_WEALTH_FORM, WEALTH_FIELDS,
  capitalCurrencyRows, parseWealthNumber, portfolioPrincipal, wealthInputKey, wealthRequest,
  type CapitalPayload, type PortfolioSnapshot, type PrincipalSource, type WealthContext,
  type WealthFieldErrors, type WealthForm, type WealthPlansPayload, type WealthResult,
} from './capital-ui-model.js'
import { capitalWorkspaceCss } from './capital-workspace-styles.js'

export type WealthPostApi = <T>(path: string, body: unknown) => Promise<T>
export interface CapitalWorkspaceProps { get: ReadApi; deliver: Deliver; useBus?: UsePanelBus; portfolio?: PortfolioSnapshot }
export interface WealthWorkspaceProps { get: ReadApi; post: WealthPostApi; portfolio?: PortfolioSnapshot }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
interface ReadState<T> { data?: T; pending: boolean; error?: string }
/** Keep a previous successful snapshot visible on refresh failure; ignore outdated responses. */
function useLocalRead<T extends { ok: boolean; error?: string }>(get: ReadApi, path: string) {
  const [state, setState] = useState<ReadState<T>>({ pending: true })
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setState(previous => ({ ...previous, pending: true, error: undefined }))
    try {
      const data = await get<T>(path)
      if (!data.ok) throw new Error(data.error || '本机资料读取失败')
      if (sequence.current === request) setState({ data, pending: false })
    } catch (error) {
      if (sequence.current === request) setState(previous => ({ ...previous, pending: false, error: errorText(error) }))
    }
  }, [get, path])
  useEffect(() => { void refresh(); return () => { sequence.current++ } }, [refresh])
  return [state, refresh] as const
}
function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="fia-cw-section">
    <header className="fia-cw-heading"><h2>{title}</h2>{meta != null && <span className="fia-cw-heading__meta">{meta}</span>}</header>
    {children}
  </section>
}
function Message({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'error' | 'warning' | 'info' }) {
  return <div className={`fia-cw-message fia-cw-message--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}
function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return <div className="fia-cw-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>
}
function CapitalBusSubscriber({ useBus, refresh }: { useBus: UsePanelBus; refresh: () => Promise<void> }) {
  useBus(event => { if (event.kind === 'capital' || event.kind === '__resync') void refresh() })
  return null
}

/** Local ledger is display-only. Model delivery is exclusively the explicit net-worth button. */
export function CapitalWorkspace(props: CapitalWorkspaceProps) {
  const [state, refresh] = useLocalRead<CapitalPayload>(props.get, '/capital')
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const delivery = useRef(0)
  useEffect(() => () => { delivery.current++ }, [])
  const requestNetworth = async () => {
    if (sending) return
    const id = ++delivery.current
    setSending(true)
    setFeedback('')
    try {
      const outcome = await props.deliver(CAPITAL_NETWORTH_REQUEST)
      if (delivery.current === id) setFeedback(deliveryFeedback(outcome))
    } catch (error) {
      if (delivery.current === id) setFeedback(`请求未发送：${errorText(error)}`)
    } finally { if (delivery.current === id) setSending(false) }
  }
  const data = state.data
  const accounts = data?.accounts ?? []
  const accountNames = new Map(accounts.map(account => [account.accountId, account.name]))
  const currencyRows = data ? capitalCurrencyRows(data) : []
  return <div className="fia-capital-workspace">
    <style>{capitalWorkspaceCss}</style>
    {props.useBus && <CapitalBusSubscriber useBus={props.useBus} refresh={refresh} />}
    <PageHeader title="我的资本" description="持仓估值与交易账本分开展示 · 不重复计入整体资产。" actions={<>
      <Button onClick={() => void refresh()} disabled={state.pending}>{state.pending ? '读取中…' : '刷新账本'}</Button>
      <Button variant="primary" onClick={() => void requestNetworth()} disabled={sending}>{sending ? '提交请求中…' : '让 Agent 算净资产'}</Button>
    </>} />
    <div className="fia-cw-meta">
      <StatusBadge>只读账本</StatusBadge>
      {data && <><span>账户 {formatNumber(data.accounts?.length, 0)}</span><span>流水 {formatNumber(data.events, 0)} 笔</span></>}
      <span>本页不会自动向模型发送账本；点击净资产按钮才提交原有计算请求。</span>
    </div>
    <div className="fia-cw-stack">
      {feedback && <Message tone="info">{feedback}</Message>}
      {state.error && <Message tone="error">账本读取失败：{state.error}{data ? '。下方保留上次成功快照，不代表最新账本。' : '。请点击刷新账本重试。'}</Message>}
      {!data && state.pending && <Message>正在读取本机账本…</Message>}
      <Section title="当前持仓估值快照" meta="与交易账本分开列示">
        <div className="fia-cw-body"><p className="fia-cw-note">持仓快照和下方交易账本是不同账源，可能重复记录同一资产；本页不会相加或重复计入净资产。</p>
          <p className="fia-cw-note">快照时间：{props.portfolio?.at ? formatDate(props.portfolio.at, { includeTime: true }) : '未注明'}{props.portfolio?.basis ? ` · ${props.portfolio.basis}` : ''}</p></div>
        {!props.portfolio?.groups.length ? <div className="fia-cw-body"><p className="fia-cw-note">当前未提供持仓估值。下方账本仍可单独查看；无估值不等于资产为零。</p></div> :
          <ScrollTable label="与账本独立的分币种持仓估值"><table className="fia-table fia-cw-table fia-cw-table--wide">
            <caption>按各币种的元分别列示，不换汇、不合计。缺价时不能把已定价部分或成本视为完整市值。</caption>
            <thead><tr><th scope="col">币种</th><th scope="col" data-numeric="true">持仓成本</th><th scope="col" data-numeric="true">持仓现值</th><th scope="col" data-numeric="true">持仓浮动盈亏</th><th scope="col">估值完整性</th></tr></thead>
            <tbody>{props.portfolio.groups.map(group => <tr key={group.currency}><td>{group.currency}</td>
              <td data-numeric="true">{formatMoney(group.cost, { currency: group.currency, symbol: false })}</td>
              <td data-numeric="true">{formatMoney(group.value, { currency: group.currency, symbol: false })}{!!group.missing.length && group.value !== null && <span className="fia-cw-id">仅已定价部分</span>}</td>
              <td data-numeric="true">{formatMoney(group.missing.length ? undefined : group.profit, { currency: group.currency, symbol: false })}</td>
              <td>{portfolioPrincipal(props.portfolio, group.currency).ok ? <StatusBadge>估值完整</StatusBadge> : <><StatusBadge tone="warning">估值不完整</StatusBadge><span className="fia-cw-id">{group.missing.length ? `待补行情：${group.missing.join('、')}` : '未提供完整现值'}</span></>}</td>
            </tr>)}</tbody>
          </table></ScrollTable>}
        <div className="fia-cw-body"><p className="fia-cw-note">整体资产覆盖：贵金属、现金及其他资产需有真实记录、持有单位、价格与必要汇率。未登记或未定价的部分不能视为零，也不能据本页推定总净资产。</p></div>
      </Section>
      {data && <>
        {accounts.length === 0 ? <EmptyState title="还没有资本账户" description="账本记录入金、买卖、分红、费用和换汇，不等于持仓快照。在对话里说明要建立的账户及真实流水，再由 Agent 记账；本页不自动创建或修改账户。" /> :
          <div className="fia-cw-split">
            <Section title="账户" meta={`${accounts.length} 个账户`}>
              <ScrollTable label="资本账户列表"><table className="fia-table fia-cw-table">
                <thead><tr><th scope="col">账户名称 / 标识</th><th scope="col">类型</th><th scope="col">记账币种</th></tr></thead>
                <tbody>{accounts.map(account => <tr key={account.accountId}>
                  <td>{account.name}<span className="fia-cw-id">{account.accountId}</span></td>
                  <td>{ACCOUNT_TYPE_LABEL[account.accountType] ?? account.accountType}</td><td>{account.baseCurrency}</td>
                </tr>)}</tbody>
              </table></ScrollTable>
            </Section>
            <Section title="现金余额" meta="原币种 · 未换算">
              {!data.cash?.length ? <div className="fia-cw-body"><p className="fia-cw-note">当前无现金余额记录。</p></div> :
                <ScrollTable label="按账户与币种的现金余额"><table className="fia-table fia-cw-table">
                  <thead><tr><th scope="col">账户</th><th scope="col">币种</th><th scope="col" data-numeric="true">余额（原币元）</th></tr></thead>
                  <tbody>{data.cash.map((cash, index) => <tr key={`${cash.accountId}-${cash.currency}-${index}`}>
                    <td>{accountNames.get(cash.accountId) ?? cash.accountId}</td><td>{cash.currency}</td>
                    <td data-numeric="true">{formatMoney(cash.amount, { currency: cash.currency, symbol: false })}</td>
                  </tr>)}</tbody>
                </table></ScrollTable>}
            </Section>
          </div>}
        <Section title="账本持仓成本" meta="数量单位未回传 · 成本不是市值">
          {!data.positions?.length ? <div className="fia-cw-body"><p className="fia-cw-note">当前无持仓成本记录；未展示的市值和未实现收益不等于零。</p></div> :
            <ScrollTable label="持仓数量与原币成本"><table className="fia-table fia-cw-table fia-cw-table--wide">
              <caption>数量按账本原值显示，接口未提供持有单位；不能把贵金属等资产默认解释为股 / 份或克。平均成本按每账本原始单位列示。</caption>
              <thead><tr><th scope="col">标的代码</th><th scope="col">币种</th><th scope="col" data-numeric="true">数量（账本原始单位）</th><th scope="col" data-numeric="true">总成本（原币元）</th><th scope="col" data-numeric="true">平均成本（原币元 / 原始单位）</th></tr></thead>
              <tbody>{data.positions.map(position => <tr key={`${position.assetId}-${position.currency}`}>
                <td>{position.assetId}</td><td>{position.currency}</td>
                <td data-numeric="true">{formatNumber(position.quantity, { minimumFractionDigits: 0, maximumFractionDigits: 6 })}</td>
                <td data-numeric="true">{formatMoney(position.cost, { currency: position.currency, symbol: false })}</td>
                <td data-numeric="true">{formatMoney(position.averageCost, { currency: position.currency, symbol: false, maximumFractionDigits: 4 })}</td>
              </tr>)}</tbody>
            </table></ScrollTable>}
        </Section>
        <Section title="资金与已实现项目" meta="各币种分别列示 · 不跨币种求和">
          {currencyRows.length === 0 ? <div className="fia-cw-body"><p className="fia-cw-note">暂无可列示的分币种金额。</p></div> :
            <ScrollTable label="各币种现金、投入和已实现项目"><table className="fia-table fia-cw-table fia-cw-table--wide">
              <caption>金额单位为各币种的元；“—”表示该项未提供，不按零计入。本表不计算净资产。</caption>
              <thead><tr><th scope="col">币种</th><th scope="col" data-numeric="true">现金</th><th scope="col" data-numeric="true">外部净投入</th><th scope="col" data-numeric="true">已实现收益</th><th scope="col" data-numeric="true">费用 / 税费</th><th scope="col" data-numeric="true">分红 / 利息</th></tr></thead>
              <tbody>{currencyRows.map(row => <tr key={row.currency}>
                <td>{row.currency}</td>{([row.cash, row.netInvested, row.realized, row.fees, row.income]).map((value, index) =>
                  <td data-numeric="true" key={index}>{formatMoney(value, { currency: row.currency, symbol: false })}</td>)}
              </tr>)}</tbody>
            </table></ScrollTable>}
        </Section>
        <Message>本交易账本未接入行情与汇率：不显示账本估值或未实现收益，也不会将不同币种直接合计。上方独立持仓快照不并入本账本。{data.note && <p className="fia-cw-note">账本接口说明：{data.note}</p>}</Message>
        {!!data.warnings?.length && <Message tone="warning"><strong>账本注意事项</strong><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Message>}
      </>}
    </div>
  </div>
}

interface ResultSnapshot { data: WealthResult; form: WealthForm; context: WealthContext; inputKey: string }
/** All money/return calculations and scenario persistence use the unchanged server routes. */
export function WealthWorkspace(props: WealthWorkspaceProps) {
  const [form, setForm] = useState<WealthForm>({ ...INITIAL_WEALTH_FORM })
  const [sourceChoice, setSourceChoice] = useState<PrincipalSource>()
  const [currencyChoice, setCurrencyChoice] = useState<string>()
  const source = sourceChoice ?? (props.portfolio?.groups.length ? 'portfolio' : 'manual')
  const currency = currencyChoice ?? props.portfolio?.groups[0]?.currency ?? 'CNY'
  const currencies = [...new Set(['CNY', 'HKD', 'USD', ...(props.portfolio?.groups.map(group => group.currency) ?? []), currency])]
  const linkedPrincipal = portfolioPrincipal(props.portfolio, currency)
  const effectiveForm: WealthForm = source === 'portfolio' ? { ...form, principal: linkedPrincipal.ok ? String(linkedPrincipal.value) : '' } : form
  const context: WealthContext = { currency, principalSource: source, ...(source === 'portfolio' ? { portfolioAt: props.portfolio?.at, portfolioBasis: props.portfolio?.basis } : {}) }
  const principalUnavailable = source === 'portfolio' && !linkedPrincipal.ok
  const [result, setResult] = useState<ResultSnapshot>()
  const [errors, setErrors] = useState<WealthFieldErrors>({})
  const [operation, setOperation] = useState<'calculate' | 'save'>()
  const [notice, setNotice] = useState<{ error: boolean; text: string }>()
  const [plans, refreshPlans] = useLocalRead<WealthPlansPayload>(props.get, '/wealth/plans')
  const request = useRef(0)
  const running = useRef(false)
  const id = useId()
  useEffect(() => () => { request.current++ }, [])
  const currentInput = wealthRequest(effectiveForm)
  const resultChanged = !!result && (principalUnavailable || !currentInput.ok || wealthInputKey(currentInput.body, context) !== result.inputKey)
  const setField = (key: keyof WealthForm, value: string) => {
    setForm(previous => ({ ...previous, [key]: value }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
  }
  const calculate = async (save: boolean) => {
    if (running.current) return
    if (principalUnavailable && !linkedPrincipal.ok) { setNotice({ error: true, text: linkedPrincipal.reason }); return }
    const validation = wealthRequest(effectiveForm)
    if (!validation.ok) { setErrors(validation.errors); setNotice({ error: true, text: '请补齐下方标出的有效数值。没有将缺失值或不可解析值当作零。' }); return }
    if (save && !form.name.trim()) { setErrors({ name: '保存情景需要名称。' }); return }
    setErrors({})
    setNotice(undefined)
    const submittedForm = { ...effectiveForm }
    const submittedContext = { ...context }
    const notes = `金额币种：${currency}；本金来源：${source === 'portfolio' ? '选中币种的完整持仓现值' : '手动本金'}；持仓快照时间：${source === 'portfolio' ? props.portfolio?.at ?? '未注明' : '不适用'}；估值口径：${source === 'portfolio' ? props.portfolio?.basis ?? '未注明' : '手动假设'}。不执行换汇。`
    const body = save ? { ...validation.body, name: form.name.trim(), notes } : validation.body
    const token = ++request.current
    running.current = true
    setOperation(save ? 'save' : 'calculate')
    try {
      const response = await props.post<WealthResult>(save ? '/wealth/plans/save' : '/wealth/calc', body)
      if (request.current !== token) return
      if (!response.ok) throw new Error(response.error || (save ? '保存失败' : '计算失败'))
      setResult({ data: response, form: submittedForm, context: submittedContext, inputKey: wealthInputKey(validation.body, submittedContext) })
      setNotice({ error: false, text: save ? `已保存情景「${submittedForm.name.trim()}」。币种与本金来源已记入现有情景备注；历史列表接口不回传这些字段。` : '情景计算完成；结果仅对应下方已提交假设，不是收益预测。' })
      if (save) void refreshPlans()
    } catch (error) {
      if (request.current === token) setNotice({ error: true, text: `${save ? '保存' : '计算'}失败：${errorText(error)}${result ? '。下方仍为上次成功结果。' : ''}` })
    } finally {
      if (request.current === token) { running.current = false; setOperation(undefined) }
    }
  }
  const data = result?.data
  return <div className="fia-wealth-workspace">
    <style>{capitalWorkspaceCss}</style>
    <PageHeader title="复利与财富规划" description="先声明假设，再查看确定性情景。由原服务端引擎计算，不构成收益预测。" />
    <div className="fia-cw-stack">
      <Section title="情景假设" meta={`${currency} · 每月月末投入 · 非真实收益`}>
        <form className="fia-cw-body" onSubmit={event => { event.preventDefault(); void calculate(false) }} noValidate>
          <div className="fia-cw-source">
            <label className="fia-cw-field" htmlFor={`${id}-source`}><span>本金来源</span>
              <select id={`${id}-source`} value={source} onChange={event => { setSourceChoice(event.target.value as PrincipalSource); setErrors({}); setNotice(undefined) }}>
                <option value="portfolio">跟随当前持仓</option><option value="manual">手动本金</option>
              </select>
            </label>
            <label className="fia-cw-field" htmlFor={`${id}-currency`}><span>本次金额币种</span>
              <select id={`${id}-currency`} value={currency} onChange={event => { setCurrencyChoice(event.target.value); setErrors({}); setNotice(undefined) }}>
                {currencies.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          {source === 'portfolio' ? <div className="fia-cw-source-note">
            {linkedPrincipal.ok ? <Message>本金跟随 {currency} 持仓完整现值：{formatMoney(linkedPrincipal.value, { currency })}。持仓变化只更新本金并标记旧结果；需再次点击计算，不会自动计算或保存。</Message> :
              <Message tone="warning">{linkedPrincipal.reason}{!!linkedPrincipal.missing.length && <span> 待补行情：{linkedPrincipal.missing.join('、')}。</span>}不以成本补缺，也不合计其他币种；可补行情或切换手动本金。</Message>}
            <p className="fia-cw-note">持仓数据时间：{props.portfolio?.at ? formatDate(props.portfolio.at, { includeTime: true }) : '未注明'}{props.portfolio?.basis ? ` · ${props.portfolio.basis}` : ''}</p>
          </div> : <p className="fia-cw-note">手动本金是独立假设，不代表已绑定任何持仓。计算接口仅处理金额数值，不执行换汇。</p>}
          <div className="fia-cw-form">{WEALTH_FIELDS.map(field => <label key={field.key} className="fia-cw-field" htmlFor={`${id}-${field.key}`}>
            <span className="fia-cw-field__label"><span>{field.key === 'principal' && source === 'portfolio' ? '跟随持仓的本金' : field.label}</span><span className="fia-cw-field__unit">{field.unit === '元' ? currency : field.unit === '元 / 月' ? `${currency} / 月` : field.unit}</span></span>
            <input id={`${id}-${field.key}`} type="text" inputMode="decimal" autoComplete="off" value={effectiveForm[field.key]} readOnly={field.key === 'principal' && source === 'portfolio'}
              placeholder={field.key === 'principal' && principalUnavailable ? '待补完整估值' : undefined}
              aria-invalid={!!errors[field.key]} aria-describedby={errors[field.key] ? `${id}-${field.key}-error` : `${id}-rate-help`}
              onChange={event => setField(field.key, event.target.value)} />
            {errors[field.key] && <span id={`${id}-${field.key}-error`} className="fia-cw-field__error">{errors[field.key]}</span>}
          </label>)}</div>
          <p id={`${id}-rate-help`} className="fia-cw-note">收益率、费率、通胀率统一输入百分数：填 6 表示 6%，填 0.5 表示 0.5%。具体可用范围由服务端校验。</p>
          <div className="fia-cw-form-actions">
            <Button type="submit" variant="primary" disabled={!!operation || principalUnavailable}>{operation === 'calculate' ? '计算中…' : '计算情景'}</Button>
            <label className="fia-cw-field" htmlFor={`${id}-name`}><span>情景名称</span>
              <input id={`${id}-name`} value={form.name} placeholder="仅保存时需要" aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} onChange={event => setField('name', event.target.value)} />
              {errors.name && <span id={`${id}-name-error`} className="fia-cw-field__error">{errors.name}</span>}
            </label>
            <Button onClick={() => void calculate(true)} disabled={!!operation || principalUnavailable || !form.name.trim()}>{operation === 'save' ? '保存中…' : '计算并保存情景'}</Button>
          </div>
        </form>
      </Section>
      {notice && <Message tone={notice.error ? 'error' : 'info'}>{notice.text}</Message>}
      {operation && <Message>{operation === 'save' ? '正在计算并保存本次情景…' : '正在请求服务端计算本次情景…'}原有结果不会被当作本次计算结果。</Message>}
      {!result && !operation && <EmptyState title="尚未计算情景" description="完成上方具名假设后点击计算。此处不预填、模拟或推断任何结果。" />}
      {result && data && <Section title="确定性情景结果" meta={<StatusBadge tone={resultChanged ? 'warning' : 'neutral'}>{resultChanged ? '持仓或输入已变更 · 旧结果待更新' : '仅对应已提交假设'}</StatusBadge>}>
        <div className="fia-cw-body">
          <Message tone="warning">这是确定性情景，不是收益预测。假设收益率恒定，不能据此判断市场未来表现或承诺回报。</Message>
          <p className="fia-cw-note">结果金额币种：{result.context.currency} · 本金来源：{result.context.principalSource === 'portfolio' ? '选中币种的完整持仓现值' : '手动本金'} · 持仓数据时间：{result.context.principalSource === 'portfolio' ? result.context.portfolioAt ? formatDate(result.context.portfolioAt, { includeTime: true }) : '未注明' : '不适用'}。不执行换汇。</p>
          <dl className="fia-cw-assumptions">{WEALTH_FIELDS.map(field => <div key={field.key}>
            <dt>已提交 · {field.label}</dt><dd>{field.unit === '%' ? formatPercent(parseWealthNumber(result.form[field.key])) : `${formatNumber(parseWealthNumber(result.form[field.key]), { maximumFractionDigits: 2 })} ${field.unit === '元' ? result.context.currency : field.unit === '元 / 月' ? `${result.context.currency} / 月` : field.unit}`}</dd>
          </div>)}</dl>
          <div className="fia-cw-rates"><span>费后年有效收益率 {formatPercent(data.netAnnualRate, { input: 'ratio' })}</span><span>费后实际年有效收益率 {formatPercent(data.realRate, { input: 'ratio' })}</span></div>
          <div className="fia-cw-metrics">
            <MetricCard label={`期末名义金额（${result.context.currency}）`} value={formatMoney(data.finalYuan, { currency: result.context.currency })} detail="服务端情景结果" />
            <MetricCard label={`期末实际购买力（${result.context.currency}）`} value={formatMoney(data.finalRealYuan, { currency: result.context.currency })} detail="按假设通胀折算" />
            <MetricCard label={`累计后续投入（${result.context.currency}）`} value={formatMoney(data.contributedYuan, { currency: result.context.currency })} detail="不含一次性本金" />
            <MetricCard label={`假设累计收益（${result.context.currency}）`} value={formatMoney(data.growthYuan, { currency: result.context.currency })} detail="非真实收益记录" />
          </div>
          {!!data.assumptions?.length && <ul className="fia-cw-list">{data.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>}
        </div>
        {!data.rows?.length ? <div className="fia-cw-body"><p className="fia-cw-note">服务端未返回逐年明细。</p></div> :
          <ScrollTable label="确定性情景逐年明细"><table className="fia-table fia-cw-table fia-cw-table--wide">
            <caption>全部金额币种：{result.context.currency}。本年投入不含一次性本金；逐年字段直接使用服务端返回值，不执行换汇。</caption>
            <thead><tr><th scope="col">年度</th><th scope="col" data-numeric="true">本年后续投入</th><th scope="col" data-numeric="true">本年假设收益</th><th scope="col" data-numeric="true">年末名义金额</th><th scope="col" data-numeric="true">年末实际购买力</th></tr></thead>
            <tbody>{data.rows.map(row => <tr key={row.year}><td>第 {formatNumber(row.year, 0)} 年</td>
              <td data-numeric="true">{formatMoney(row.contributedYuan, { symbol: false })}</td><td data-numeric="true">{formatMoney(row.growthYuan, { symbol: false })}</td>
              <td data-numeric="true">{formatMoney(row.endYuan, { symbol: false })}</td><td data-numeric="true">{formatMoney(row.realYuan, { symbol: false })}</td>
            </tr>)}</tbody>
          </table></ScrollTable>}
      </Section>}
      <Section title="已保存情景" meta={<Button variant="ghost" disabled={plans.pending} onClick={() => void refreshPlans()}>{plans.pending ? '读取中…' : '刷新情景'}</Button>}>
        <div className="fia-cw-body"><p className="fia-cw-note">仅展示本机保存时的服务端快照，不代表概率、实际收益或当前预测；不会自动发给模型。历史列表接口未回传币种及来源备注，以下金额币种未知，不可跨情景合计；本次保存会将币种与本金来源写入现有备注。</p></div>
        {plans.error && <div className="fia-cw-body"><Message tone="error">情景读取失败：{plans.error}{plans.data ? '。下方保留上次成功列表。' : '。可单独刷新重试，不影响上方计算。'}</Message></div>}
        {!plans.data && plans.pending && <div className="fia-cw-body"><Message>正在读取已保存情景…</Message></div>}
        {plans.data && (!plans.data.plans?.length ? <div className="fia-cw-body"><p className="fia-cw-note">还没有保存的情景。计算后填写名称即可保存。</p></div> :
          <ScrollTable label="已保存的财富情景快照"><table className="fia-table fia-cw-table fia-cw-table--wide">
            <caption>金额币种：列表接口未提供。费后收益率使用保存时快照，不在前端重新计算；不可跨币种比较或合计金额。</caption>
            <thead><tr><th scope="col">情景名称</th><th scope="col" data-numeric="true">期限（年）</th><th scope="col" data-numeric="true">费后年有效收益率</th><th scope="col" data-numeric="true">期末名义金额</th><th scope="col" data-numeric="true">实际购买力</th><th scope="col" data-numeric="true">累计后续投入</th><th scope="col" data-numeric="true">假设累计收益</th></tr></thead>
            <tbody>{plans.data.plans.map(plan => <tr key={plan.planId}>
              <td>{plan.name}</td><td data-numeric="true">{formatNumber(plan.years, { maximumFractionDigits: 2 })}</td><td data-numeric="true">{formatPercent(plan.netAnnualRate, { input: 'ratio' })}</td>
              <td data-numeric="true">{formatMoney(plan.finalYuan, { symbol: false })}</td><td data-numeric="true">{formatMoney(plan.finalRealYuan, { symbol: false })}</td>
              <td data-numeric="true">{formatMoney(plan.contributedYuan, { symbol: false })}</td><td data-numeric="true">{formatMoney(plan.growthYuan, { symbol: false })}</td>
            </tr>)}</tbody>
          </table></ScrollTable>)}
      </Section>
    </div>
  </div>
}
