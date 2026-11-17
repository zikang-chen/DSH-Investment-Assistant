import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { AdviceEvidence, InvestmentAdvice } from '../invest/schema.js'
import { Button, PageHeader, StatusBadge, EmptyState, MetricCard, formatNumber, formatMoney } from './design-system/index.js'
import {
  deliveryFeedback, displayDay, EVIDENCE_LABEL, FRESHNESS_LABEL, HORIZON_LABEL, isSafeSourceUrl,
  MARKET_LABEL, RECOMMENDATION_VIEW, researchPrompt, normalizeAdviceDetail, normalizeAdviceRow,
  type AdviceDetail, type AdviceList, type AdviceRow, type Deliver, type ReadApi, type UsePanelBus,
} from './workbench-model.js'

interface ReadState<T> { data?: T; pending: boolean; error?: string }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Ignore stale responses and unmounts. Each resource is independently refreshable. */
function useRead<T>(get: ReadApi, path: string) {
  const [state, setState] = useState<ReadState<T>>({ pending: true })
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++request.current
    setState(prev => ({ ...prev, pending: true, error: undefined }))
    try {
      const data = await get<T & { ok?: boolean; error?: string }>(path)
      if (data?.ok === false) throw new Error(data.error ?? '数据读取失败')
      if (request.current === id) setState({ pending: false, data })
    } catch (error) {
      if (request.current === id) setState(prev => ({ ...prev, pending: false, error: message(error) }))
    }
  }, [get, path])
  useEffect(() => { void refresh(); return () => { request.current++ } }, [refresh])
  return [state, refresh] as const
}

function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return <div className={`fia-notice${error ? ' fia-notice--error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>
}
function Section({ title, meta, children, className = '' }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`fia-research-section ${className}`}><header className="fia-section-heading"><h3>{title}</h3>{meta}</header>{children}</section>
}

interface PolicyList { docs?: Array<{ id: string; title: string; publishedAt?: string; issuer?: string; evidence?: { label?: string } }>; stats?: { total?: number } }
interface EvidenceList { stats?: { waiting?: number }; requests?: Array<{ requestId: string; title: string; status: string; updatedAt?: string }> }
interface CapitalOverview { accounts?: Array<{ name: string }>; events?: number; positions?: unknown[]; netInvested?: Record<string, number>; warnings?: string[] }
interface WorkbenchProps { get: ReadApi; deliver: Deliver; navigate: (tab: string) => void; useBus: UsePanelBus }

export function OverviewWorkbench(props: WorkbenchProps & { onOpenPolicy: (id: string) => void; onOpenAdvice: (id: string) => void; marketSummary?: ReactNode; portfolioSummary?: ReactNode }) {
  const [advice, reloadAdvice] = useRead<AdviceList>(props.get, '/advice?limit=3')
  const [evidence, reloadEvidence] = useRead<EvidenceList>(props.get, '/evidence?limit=5')
  const [capital, reloadCapital] = useRead<CapitalOverview>(props.get, '/capital')
  const [policy, reloadPolicy] = useRead<PolicyList>(props.get, '/policy?limit=4')
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [fetchedAt, setFetchedAt] = useState('')
  const inputId = useId()
  // Only the affected modules refresh; quote ticks do not reload the dashboard.
  props.useBus(e => {
    if (e.kind === 'investment' || e.kind === '__resync') void reloadAdvice()
    if (e.kind === 'evidence' || e.kind === '__resync') void reloadEvidence()
    if (e.kind === 'capital' || e.kind === '__resync') void reloadCapital()
    if (e.kind === 'policy' || e.kind === '__resync') void reloadPolicy()
  })
  // The ledger does not currently emit a capital bus event. Refresh only its local,
  // read-only snapshot on focus/visible intervals instead of claiming instant updates.
  useEffect(() => {
    const onFocus = () => { if (!document.hidden) void reloadCapital() }
    const timer = window.setInterval(onFocus, 30_000)
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [reloadCapital])
  const loading = advice.pending || evidence.pending || capital.pending || policy.pending
  useEffect(() => { if (!loading) setFetchedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false })) }, [loading])
  const reload = () => { void reloadAdvice(); void reloadEvidence(); void reloadCapital(); void reloadPolicy() }
  const send = async () => {
    if (!question.trim() || sending) return
    setSending(true)
    try { setFeedback(deliveryFeedback(await props.deliver(researchPrompt(question, 'quick', false)))) }
    catch (err) { setFeedback(message(err)) }
    finally { setSending(false) }
  }
  const waiting = evidence.data?.stats?.waiting
  const due = advice.data?.dueForReview
  const accountCount = capital.data?.accounts?.length
  const warnings = capital.data?.warnings ?? []
  const capitalText = capital.error ? '读取失败' : accountCount === undefined ? '读取中' : accountCount === 0 ? '尚未添加账户' : `${accountCount} 个账户`
  const resourceStatus = (resource: ReadState<unknown>, empty: string, value?: number) => resource.error ? '暂不可用' : !resource.data ? '读取中' : value ? `${formatNumber(value)} 项` : empty
  return <div className="fia-page fia-workbench" data-testid="finance-overview" aria-busy={loading}>
    <PageHeader title="今日投资工作台" eyebrow="RESEARCH WORKSPACE" description="从最新变化到可检验的判断。所有数据都保留来源与时点。" actions={<Button onClick={reload} disabled={loading}>{loading ? '读取中…' : '刷新数据'}</Button>} />
    <div className="fia-meta-line">{fetchedAt ? `本机读取于 ${fetchedAt} · 不代表报价时间` : '正在读取本地研究数据'}<span>研究与模拟 · 不执行交易</span></div>
    <form className="fia-question-bar" onSubmit={e => { e.preventDefault(); void send() }}>
      <label className="fia-sr-only" htmlFor={inputId}>向投资助手提问</label>
      <span className="fia-question-mark" aria-hidden="true">↗</span>
      <input id={inputId} value={question} onChange={e => setQuestion(e.target.value)} placeholder="今天想研究什么？例如：中国政策变化对沪深300有什么影响" />
      <Button type="submit" variant="primary" disabled={!question.trim() || sending}>{sending ? '正在投递…' : '开始分析'}</Button>
    </form>
    {feedback && <Notice>{feedback}</Notice>}
    <nav className="fia-inline-actions" aria-label="工作流程快捷入口">
      <Button variant="ghost" onClick={() => props.navigate('quotes')}>① 看行情与走势</Button>
      <Button variant="ghost" onClick={() => props.navigate('advice')}>② 发起研究</Button>
      <Button variant="ghost" onClick={() => props.navigate('research')}>③ 查资料与证据</Button>
      <Button variant="ghost" onClick={() => props.navigate('journal')}>④ 复盘与确认</Button>
    </nav>
    <div className="fia-metric-grid">
      <MetricCard label="我的资本" value={capitalText} detail={accountCount ? `已记录 ${capital.data?.events ?? '—'} 笔流水 · 净投入不等于收益` : '先建立账户或从持仓页面开始'} onClick={() => props.navigate(accountCount ? 'capital' : 'holdings')} />
      <MetricCard label="政策资料" value={policy.error ? '资料暂不可用' : !policy.data ? '读取中' : policy.data.docs?.length ? '政策资料已就绪' : '等待研究资料'} detail="查看最近入库政策 · 原文与传导分开判断" onClick={() => props.navigate('policy')} />
      <MetricCard label="研究待办" value={resourceStatus(evidence, '暂无待补证据', waiting)} detail={waiting ? '补充关键资料，恢复原研究任务' : '缺少核心证据时，在这里补齐'} onClick={() => props.navigate('evidence')} />
      <MetricCard label="投资观点" value={resourceStatus(advice, '暂无到期复核', due)} detail={due ? '已到观察期，请重新核对失效条件' : advice.data?.stats?.total ? `已保存 ${advice.data.stats.total} 条判断` : '提出问题后，形成第一条研究观点'} onClick={() => props.navigate('advice')} />
    </div>
    <div className="fia-research-grid">
      <Section title="市场速览" meta={<Button variant="ghost" onClick={() => props.navigate('quotes')}>行情与K线 →</Button>}>
        {props.marketSummary ?? <p className="fia-muted">行情未取得，不用政策入库数量代替市场走势。</p>}
      </Section>
      <Section title="我的组合" meta={<Button variant="ghost" onClick={() => props.navigate('holdings')}>持仓与自选 →</Button>}>
        {props.portfolioSummary ?? <p className="fia-muted">查看本地持仓及行情缺口。</p>}
      </Section>
    </div>
    <div className="fia-research-grid">
      <Section title="最近入库政策" meta={<Button variant="ghost" onClick={() => props.navigate('policy')}>全部政策 ↗</Button>}>
        {policy.error ? <Notice error>{policy.error}<Button onClick={() => void reloadPolicy()}>重试</Button></Notice> : !policy.data ? <p className="fia-muted" role="status">读取政策资料…</p> : !policy.data.docs?.length ? <EmptyState title="尚无政策资料" description="可通过对话采集官方文件，或导入已授权的材料。不会使用虚构的市场动态填满页面。" action={<Button onClick={() => props.navigate('policy')}>查看政策研究</Button>} /> : <div className="fia-timeline">{policy.data.docs.map(doc => <button key={doc.id} type="button" className="fia-timeline-item" onClick={() => props.onOpenPolicy(doc.id)}><span className="fia-timeline-date">{displayDay(doc.publishedAt)}<span>{doc.issuer ?? '来源待核实'}</span></span><strong>{doc.title}</strong><span className="fia-muted">查看原文与证据 →</span></button>)}</div>}
      </Section>
      <Section title="与我有关的研究" meta={<StatusBadge tone="neutral">本地记录</StatusBadge>}>
        <div className="fia-task-block"><h4>证据补充</h4>{evidence.error ? <p className="fia-error-text">{evidence.error}</p> : <p className="fia-secondary">{waiting ? `${waiting} 项等待补充` : evidence.data ? '暂无待补证据' : '读取中…'}</p>}
          {(evidence.data?.requests ?? []).filter(r => ['OPEN', 'WAITING_FOR_USER', 'SUBMITTED', 'VALIDATING'].includes(r.status)).slice(0, 2).map(r => <button type="button" className="fia-text-link" key={r.requestId} onClick={() => props.navigate('evidence')}>{r.title} →</button>)}
          <Button variant="ghost" onClick={() => props.navigate('evidence')}>打开证据待办</Button></div>
        <div className="fia-task-block"><h4>观点复核</h4><p className="fia-secondary">{advice.error ? advice.error : due ? `${due} 条建议已到复核时间` : '关注使判断成立或失效的新证据'}</p>
          {advice.data?.advices?.[0] && <p className="fia-last-question">最近：{advice.data.advices[0].userPrompt}</p>}
          <Button variant="ghost" onClick={() => advice.data?.advices?.[0] ? props.onOpenAdvice(advice.data.advices[0].adviceId) : props.navigate('advice')}>查看最近判断</Button>
          <Button variant="ghost" onClick={() => props.navigate('journal')}>档案、周复盘与待确认</Button></div>
        {warnings.length > 0 && <p className="fia-caution">资本记录存在缺口：{warnings.join('；')}</p>}
        {accountCount ? <details className="fia-source-details"><summary>资本口径说明</summary><p>以下仅为账本累计净投入，不是总资产、投资盈利或实时净值：</p>{Object.entries(capital.data?.netInvested ?? {}).map(([currency, amount]) => <div key={currency} className="fia-value-row"><span>{currency}</span><span className="fia-number">{formatMoney(amount, { currency })}</span></div>)}</details> : null}
      </Section>
    </div>
  </div>
}

interface LearningResponse { ok: boolean; error?: string; text?: string; levelLabel?: string; contextNote?: string; dataNote?: string; concept?: { name: string; formula?: string; interpretationRules: string[]; misconceptions: string[]; referenceSources: string[] } }
/** Native modal dialog provides focus containment and Esc; stays in the current themed panel. */
function ExplainDrawer({ get, term, advice, onClose }: { get: ReadApi; term: string; advice?: InvestmentAdvice; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [level, setLevel] = useState('beginner')
  const qs = new URLSearchParams({ id: term, level, page: 'advice' })
  if (advice) { qs.set('asset', advice.assets.join('、')); qs.set('period', advice.dataFreshness.asOf); qs.set('market', advice.market) }
  const [state, reload] = useRead<LearningResponse>(get, `/learn/concept?${qs}`)
  const titleId = useId()
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    const previous = document.activeElement as HTMLElement | null
    el.showModal()
    return () => { el.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return <dialog ref={dialog} className="fia-explain-drawer" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onClose() }}>
    <header className="fia-section-heading"><div><span className="fia-eyebrow">FINANCIAL LEARNING</span><h2 id={titleId}>{state.data?.concept?.name ?? term}</h2></div><Button onClick={onClose} aria-label="关闭解释并返回研究">关闭 ×</Button></header>
    <p className="fia-muted">{advice ? `研究对象：${advice.assets.join('、')} · 资料时间 ${displayDay(advice.dataFreshness.asOf)}` : '当前页面：投资判断'}。切换难度不会重新发起投资研究。</p>
    <div className="fia-segmented" role="group" aria-label="解释难度">{[['beginner', '小白版'], ['intermediate', '进阶版'], ['advanced', '专业版']].map(([id, label]) => <button type="button" key={id} aria-pressed={level === id} onClick={() => setLevel(id)}>{label}</button>)}</div>
    {state.pending && <p role="status">读取本地知识卡…</p>}{state.error && <Notice error>{state.error}<Button onClick={() => void reload()}>重试</Button></Notice>}
    {state.data && <><p className="fia-explanation-text">{state.data.text}</p>{state.data.concept?.formula && <div className="fia-formula">{state.data.concept.formula}</div>}{state.data.contextNote && <p>{state.data.contextNote}</p>}<h3>口径与读法</h3><ul>{state.data.concept?.interpretationRules.map((line, i) => <li key={i}>{line}</li>)}</ul><h3>常见误区</h3><ul>{state.data.concept?.misconceptions.map((line, i) => <li key={i}>{line}</li>)}</ul><p className="fia-muted">{state.data.dataNote}</p><details className="fia-source-details"><summary>参考口径</summary><ul>{state.data.concept?.referenceSources.map((s, i) => <li key={i}>{s}</li>)}</ul></details></>}
  </dialog>
}

const EXPLAIN_TERMS = ['PE', 'PB', 'ROE', '社融', 'M2', 'LPR', 'TWR', 'XIRR']
function EvidenceListView({ rows, onOpenPolicy }: { rows: AdviceEvidence[]; onOpenPolicy: (id: string) => void }) {
  if (!rows.length) return <p className="fia-muted">未附证据。请先补充来源，再使用此结论。</p>
  return <ul className="fia-evidence-list">{rows.map((ev, i) => <li key={i}><div><StatusBadge tone="neutral">{EVIDENCE_LABEL[ev.kind] ?? ev.kind}</StatusBadge><span className="fia-evidence-date">数据 {displayDay(ev.asOf)}</span></div><p>{ev.claim}</p><div className="fia-citation">{ev.source}{ev.ref && <> · {ev.ref.startsWith('pol-') ? <button type="button" className="fia-text-link" onClick={() => onOpenPolicy(ev.ref!)}>打开政策原文 ↗</button> : isSafeSourceUrl(ev.ref) ? <a href={ev.ref} target="_blank" rel="noopener noreferrer">查看原始材料 ↗</a> : <span>{ev.ref}</span>}</>}</div></li>)}</ul>
}

export function InvestmentWorkbench(props: WorkbenchProps & { onOpenPolicy: (id: string) => void; selectionId: string; onSelectAdvice: (id: string) => void }) {
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(40)
  const query = new URLSearchParams({ limit: String(limit) })
  if (filter !== 'all') query.set('status', filter)
  const [list, reload] = useRead<AdviceList>(props.get, `/advice?${query}`)
  const selected = props.selectionId
  const setSelected = props.onSelectAdvice
  const [detail, setDetail] = useState<ReadState<AdviceDetail>>({ pending: false })
  const [revision, setRevision] = useState(0)
  const detailSeq = useRef(0)
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<'quick' | 'deep'>('quick')
  const [portfolioAuthorized, setPortfolioAuthorized] = useState(false)
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [term, setTerm] = useState('')
  const [customTerm, setCustomTerm] = useState('')
  const questionId = useId()
  const detailHeadingId = useId()
  props.useBus(e => { if (e.kind === 'investment' || e.kind === '__resync') { void reload(); setRevision(n => n + 1) } })
  useEffect(() => {
    const seq = ++detailSeq.current
    if (!selected) { setDetail({ pending: false }); return }
    setDetail({ pending: true })
    void props.get<AdviceDetail>(`/advice?id=${encodeURIComponent(selected)}`).then(data => {
      if (!data.ok || !data.advice) throw new Error(data.error ?? '投资判断不存在')
      if (detailSeq.current === seq) setDetail({ pending: false, data })
    }).catch(err => { if (detailSeq.current === seq) setDetail({ pending: false, error: message(err) }) })
    return () => { detailSeq.current++ }
  }, [props.get, selected, revision])

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    setSending(true)
    try { setFeedback(deliveryFeedback(await props.deliver(text))) }
    catch (err) { setFeedback(`未能投递：${message(err)}`) }
    finally { setSending(false) }
  }
  const advice = detail.data?.advice ? normalizeAdviceDetail(detail.data.advice) : undefined
  const rows = (list.data?.advices ?? []).map(normalizeAdviceRow).filter(row => filter === 'all' || row.status === filter)
  const rec = advice ? RECOMMENDATION_VIEW[advice.recommendation] : undefined
  const examples = ['现在沪深300适不适合配置？', '近期中国政策如何影响新能源行业？', '美联储高利率会怎样影响港股？']
  return <div className="fia-page fia-investment" data-testid="finance-advice">
    <PageHeader title="投资判断" eyebrow="INVESTMENT RESEARCH" description="让结论有依据、有反证，也有下一次检验的条件。" actions={<Button onClick={() => { void reload(); setRevision(n => n + 1) }} disabled={list.pending}>刷新记录</Button>} />
    <form className="fia-research-composer" onSubmit={e => { e.preventDefault(); if (question.trim()) void send(researchPrompt(question, mode, portfolioAuthorized)) }}>
      <div className="fia-composer-heading"><label htmlFor={questionId}>你的投资研究问题</label><div className="fia-segmented" role="group" aria-label="研究模式"><button type="button" aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>快速</button><button type="button" aria-pressed={mode === 'deep'} onClick={() => setMode('deep')}>深度研究</button></div></div>
      <textarea id={questionId} rows={3} value={question} onChange={e => setQuestion(e.target.value)} placeholder="输入资产、关注问题和投资期限。例如：持有五年，现在的沪深300估值是否值得研究？" onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (question.trim()) void send(researchPrompt(question, mode, portfolioAuthorized)) } }} />
      <div className="fia-composer-actions"><label className="fia-consent"><input type="checkbox" checked={portfolioAuthorized} onChange={e => setPortfolioAuthorized(e.target.checked)} />本次允许使用我的组合概要</label><Button type="submit" variant="primary" disabled={!question.trim() || sending}>{sending ? '正在投递…' : '开始分析'} <span aria-hidden="true">↗</span></Button></div>
      <p className="fia-muted fia-composer-help">Ctrl / ⌘ + Enter 提交 · 不自动交易 · 默认不读取个人资本</p>
      <details className="fia-prompt-examples"><summary>不知道从何开始？试试这些问题</summary><div>{examples.map(example => <button type="button" className="fia-text-link" key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div></details>
    </form>
    {feedback && <Notice>{feedback}</Notice>}
    <div className="fia-section-heading"><h2>研究记录</h2><div className="fia-inline-actions">{list.data?.dueForReview ? <StatusBadge tone="warning">{list.data.dueForReview} 条到期复核</StatusBadge> : null}<label className="fia-filter-label">筛选<select value={filter} onChange={e => { setFilter(e.target.value); setLimit(40) }}><option value="all">全部判断</option><option value="open">待复核</option><option value="reviewed">已复盘</option></select></label></div></div>
    {list.pending && <p className="fia-muted" role="status">读取研究记录…</p>}
    {list.error && <Notice error>{list.error}<Button onClick={() => void reload()}>重新读取</Button></Notice>}
    {!list.pending && !list.error && !rows.length && <EmptyState title={filter === 'all' ? '还没有保存的投资判断' : '这个分类暂时没有记录'} description="在上方提出问题，Agent 会取证、检验反面因素，再保存为可复盘的结构化记录。不会用演示结论代替真实研究。" />}
    <div className={`fia-advice-layout${selected ? ' has-selection' : ''}`}>
      <div className="fia-advice-history">{rows.map(row => <AdviceHistoryRow key={row.adviceId} row={row} selected={selected === row.adviceId} onClick={() => setSelected(selected === row.adviceId ? '' : row.adviceId)} />)}</div>
      {selected && <article className="fia-advice-report" aria-labelledby={detailHeadingId} aria-busy={detail.pending}>
        <header className="fia-section-heading"><span className="fia-eyebrow">RESEARCH NOTE</span><Button variant="ghost" onClick={() => setSelected('')}>收起详情</Button></header>
        {detail.pending && <p role="status">读取完整判断与证据…</p>}{detail.error && <Notice error>{detail.error}<Button onClick={() => setRevision(n => n + 1)}>重试</Button></Notice>}
        {advice && <><h2 id={detailHeadingId}>{advice.userPrompt}</h2><div className="fia-report-meta"><span>{MARKET_LABEL[advice.market] ?? advice.market} · {HORIZON_LABEL[advice.horizon] ?? advice.horizon}</span><span>生成 {displayDay(advice.createdAt)}</span><StatusBadge tone={advice.dataFreshness.status === 'fresh' ? 'neutral' : 'warning'}>{FRESHNESS_LABEL[advice.dataFreshness.status] ?? '时效待核实'}</StatusBadge></div>
          <section className="fia-verdict"><span className="fia-eyebrow">当前判断</span><StatusBadge tone={rec?.tone ?? 'neutral'}>{rec?.label ?? advice.recommendation}</StatusBadge><p>{advice.investmentGoal || '适用条件见下方，不代表收益承诺。'}</p></section>
          <Section title="核心依据" meta={<span className="fia-muted">事实与推断请对照来源</span>}><ul className="fia-report-list">{advice.rationale.map((line, i) => <li key={i}>{line}</li>)}</ul><EvidenceListView rows={advice.supporting} onOpenPolicy={props.onOpenPolicy} /></Section>
          <Section title="反面因素与失效条件" className="fia-counter-evidence"><EvidenceListView rows={advice.contradicting} onOpenPolicy={props.onOpenPolicy} /><h4>什么会推翻这个判断</h4>{advice.invalidationConditions.length ? <ul className="fia-report-list">{advice.invalidationConditions.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="fia-muted">暂无可核验的失效条件，结论受限。</p>}</Section>
          <Section title="行动需要满足的条件"><ul className="fia-report-list">{advice.recommendationConditions.map((line, i) => <li key={i}>{line}</li>)}</ul>{advice.proposedAction ? <><StatusBadge tone="neutral">条件方案 · 非真实成交</StatusBadge><p>{advice.proposedAction.summary}</p><ul className="fia-report-list">{advice.proposedAction.conditions.map((line, i) => <li key={i}>{line}</li>)}</ul></> : <p className="fia-muted">没有行动方案。数据不足时不生成价格或仓位建议。</p>}</Section>
          {advice.portfolioContextUsed ? <Section title="我的资本影响"><StatusBadge tone="warning">此记录声明使用了组合上下文</StatusBadge><p className="fia-muted">此标记不等于已经完成授权或风险测算。以下仅展示原研究保存的约束，不推断净资产或适合仓位。</p><ul className="fia-report-list">{advice.riskConstraints.map((r, i) => <li key={i}>{r}</li>)}</ul></Section> : <p className="fia-local-note">本条研究未声明使用个人资本数据。</p>}
          {advice.unresolvedQuestions.length > 0 && <Section title="尚缺的证据"><ul className="fia-report-list">{advice.unresolvedQuestions.map((line, i) => <li key={i}>{line}</li>)}</ul><Button disabled={sending} onClick={() => void send(`请读取投资判断 ${advice.adviceId}，针对其 unresolvedQuestions 检查数据源和缓存；只为会影响核心结论的缺口用 evidence_request_create 创建证据请求，保留原任务上下文，不要编数据。`)}>让 Agent 检查证据缺口</Button></Section>}
          <details className="fia-source-details"><summary>资料引用、估值与数据时点</summary><dl><dt>数据日期</dt><dd>{displayDay(advice.dataFreshness.asOf)} · {advice.dataFreshness.note || '未附说明'}</dd><dt>估值摘要</dt><dd>{advice.valuationSummary || '尚无可靠估值数据'}</dd><dt>行情快照</dt><dd>{advice.marketSnapshot.length ? advice.marketSnapshot.map((snap, i) => <p key={i}>{displayDay(snap.asOf)} · {snap.note}</p>) : '未保存价格快照，不生成价格区间'}</dd><dt>计算引用</dt><dd>{advice.calculationRefs.join('；') || '未附计算引用'}</dd><dt>情景假设</dt><dd>{advice.scenarioAssumptions.join('；') || '未设置'}</dd></dl></details>
          <div className="fia-explain-shortcuts"><strong>看懂这份研究</strong>{EXPLAIN_TERMS.filter(t => `${advice.userPrompt} ${advice.rationale.join(' ')} ${advice.valuationSummary} ${advice.supporting.map(e => e.claim).join(' ')}`.toLowerCase().includes(t.toLowerCase())).map(t => <Button key={t} variant="ghost" onClick={() => setTerm(t)}>{t} ⓘ</Button>)}<Button variant="ghost" onClick={() => setTerm('PE')}>解释金融术语</Button></div>
          <Section title="下一次观察与复核" meta={<span className="fia-number">{displayDay(advice.nextReviewAt)}</span>}><p className="fia-muted">复盘追加记录，不改写原始判断。不把未触发的观点算成成功交易。</p>{advice.reviews.map((r, i) => <div className="fia-review-note" key={i}><strong>{displayDay(r.reviewedAt)} · {r.outcome === 'supported' ? '获得支持' : r.outcome === 'contradicted' ? '发现反证' : '仍无定论'}</strong><p>{r.note}</p><p className="fia-muted">数据 {displayDay(r.dataAsOf)} · 条件触发：{r.conditionTriggered === undefined ? '未核实' : r.conditionTriggered ? '是' : '否'}</p></div>)}</Section>
          {feedback && <Notice>{feedback}</Notice>}
          <div className="fia-report-actions"><Button disabled={sending} onClick={() => void send(`请复盘投资判断 ${advice.adviceId}，先读取原始依据与失效条件，再取最新可用数据，最后用 investment_advice_review 追加。区分观点验证、信号触发、纸面模拟与真实收益；不改原始判断。`)}>复盘这条判断</Button><Button disabled={sending} onClick={() => void send(`请对投资判断 ${advice.adviceId} 使用 investment_advice_verify(autoFetch=true) 检验，注明价格时点与基准。取不到数据就报告缺失，不手填价格。验证后用 investment_advice_review 追加，不当作实盘盈亏。`)}>验证历史走势</Button><Button variant="ghost" disabled={sending} onClick={() => void send(`请读取投资判断 ${advice.adviceId}，提出对立观点，主动寻找反证，保留原结论。未授权时不要读取个人资产。`)}>生成对立观点</Button></div>
        </>}
      </article>}
    </div>
    {(list.data?.advices?.length ?? 0) >= limit && <div className="fia-inline-actions"><span className="fia-muted">当前显示最近 {rows.length} 条{filter !== 'all' ? '匹配记录' : '记录'}，不是完整历史。</span>{limit < 200 ? <Button disabled={list.pending} onClick={() => setLimit(n => Math.min(200, n + 40))}>加载更多记录</Button> : <span className="fia-muted">已到本地接口 200 条上限；可在对话中按标的检索。</span>}</div>}
    <div className="fia-learning-toolbar"><span>金融术语</span><div>{EXPLAIN_TERMS.slice(0, 5).map(t => <button type="button" className="fia-term-button" key={t} onClick={() => setTerm(t)}>{t} ⓘ</button>)}</div><form onSubmit={e => { e.preventDefault(); if (customTerm.trim()) setTerm(customTerm.trim()) }}><label className="fia-sr-only" htmlFor={`${questionId}-term`}>查找金融术语</label><input id={`${questionId}-term`} placeholder="其他术语" value={customTerm} onChange={e => setCustomTerm(e.target.value)} /><Button type="submit" variant="ghost" disabled={!customTerm.trim()}>解释</Button></form></div>
    {term && <ExplainDrawer key={term} get={props.get} term={term} advice={advice} onClose={() => setTerm('')} />}
  </div>
}

function AdviceHistoryRow({ row, selected, onClick }: { row: AdviceRow; selected: boolean; onClick: () => void }) {
  const rec = RECOMMENDATION_VIEW[row.recommendation]
  return <button type="button" className={`fia-history-row${selected ? ' is-selected' : ''}`} aria-expanded={selected} onClick={onClick}><div className="fia-history-top"><StatusBadge tone={rec?.tone ?? 'neutral'}>{rec?.label ?? row.recommendation}</StatusBadge><span>{displayDay(row.createdAt)}</span></div><strong>{row.userPrompt}</strong><div className="fia-history-meta"><span>{row.assets.join('、')}</span><span>{MARKET_LABEL[row.market] ?? row.market}</span><span>{HORIZON_LABEL[row.horizon] ?? row.horizon}</span></div><div className="fia-history-footer"><span>{row.supports} 支持 / {row.contradicts} 反证</span><span>{FRESHNESS_LABEL[row.dataFreshness] ?? '时效待核实'}</span><span>{selected ? '收起 ↑' : '查看 →'}</span></div></button>
}
