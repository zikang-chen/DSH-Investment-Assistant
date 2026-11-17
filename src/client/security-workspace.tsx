import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, PageHeader, StatusBadge, formatDate, formatNumber } from './design-system/index.js'
import { KlineChart, type KlineMarker } from './kline-chart.js'
import type { RawBar } from './kline-math.js'
import { SecuritySearch } from './security-search.js'
import { SECURITY_CSS } from './security-styles.js'
import { dossierName, dossierRows, isGlobalSecurity, requestSecurityOpen, stockIdentityFromRow, type SecurityDossier, type SecurityIdentity, type SecuritySection } from './security-model.js'
import { deliveryFeedback, type Deliver, type ReadApi } from './workbench-model.js'

export function SecurityLink({ item, children }: { item: SecurityIdentity; children?: React.ReactNode }) {
  return <button type="button" className="fia-security-link" title={`查看${item.name || item.code}的资料、K线与分析`} onClick={event => { event.stopPropagation(); requestSecurityOpen(item) }}>{children ?? item.name ?? item.code} ↗</button>
}
function FieldTable({ section }: { section: SecuritySection }) {
  const [limit, setLimit] = useState(12)
  const rows = dossierRows(section.data)
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  if (!rows.length) return null
  return <><div className="fia-security-data-scroll"><table className="fia-table"><caption>数据源返回的原始字段与单位 · 展示 {Math.min(limit, rows.length)} / {rows.length} 行</caption><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.slice(0, limit).map((row, index) => {
    const target = stockIdentityFromRow(row, section.key)
    return <tr key={index}>{columns.map(column => {
      const value = row[column] ?? '—'
      const link = target && ['代码', '股票代码', '证券代码', 'SECURITY_CODE', '名称', '股票名称', '证券名称', 'SECURITY_NAME_ABBR',
        'code', 'name', 'stockCode', 'securityCode', 'stock_code', 'security_name'].includes(column)
      return <td key={column} data-numeric={/^[+−-]?\d[\d,.]*(?:%|万|亿)?$/.test(value)}>{link ? <SecurityLink item={target}>{value}</SecurityLink> : /^https?:\/\//i.test(value) ? <a href={value} target="_blank" rel="noopener noreferrer">原始资料 ↗</a> : value}</td>
    })}</tr>
  })}</tbody></table></div>{rows.length > limit && <Button variant="ghost" onClick={() => setLimit(n => n + 30)}>展开更多原始行</Button>}</>
}
function DossierSection({ section }: { section: SecuritySection }) {
  const status = section.status ?? (section.ok ? section.rows ? 'ready' : 'empty' : 'error')
  return <details className="fia-security-disclosure" open={['overview', 'company_survey', 'main_financials', 'money_flow', 'manager', 'risk_metrics'].includes(section.key)}>
    <summary>{section.label}<StatusBadge tone={status === 'error' ? 'danger' : status === 'ready' ? 'neutral' : 'warning'}>{status === 'ready' ? `${section.rows} 条` : status === 'unsupported' ? '暂不适用' : status === 'empty' ? '暂无记录' : '取数失败'}</StatusBadge><small>{section.group}</small></summary>
    <div className="fia-security-data-meta"><span>来源：{section.provider || '未返回来源标识'}</span><span>数据时点：{section.dataAsOf || '源未注明，不能当作实时数据'}</span></div>
    {section.error && <p className={status === 'error' ? 'fia-security-data-error' : 'fia-security-data-gap'}>{section.error}</p>}
    {section.missing?.length ? <p className="fia-security-data-gap">口径与缺失：{section.missing.join('；')}</p> : null}
    <FieldTable section={section} />
  </details>
}
export function securityResearchPrompt(item: SecurityIdentity, portfolioAuthorized = false): string {
  return [
    `请综合分析${item.type === 'fund' ? '基金' : '股票'}「${item.name ?? item.code}」（代码 ${item.code}，资产类型 ${item.type}）。这不是已经成交的投资操作。`,
    '请加载 investment-advisor，并按其中完整研究流程执行。先确认标的身份、市场和最新可用数据日期；若研究期限会改变判断，先给短中长期条件分层，不编用户风险预算。',
    item.type === 'fund'
      ? '先 fund_dossier / get_fund_quote 核对净值日期（T+1），再看经理/策略/规模申赎/前十大重仓/行业集中度/历史收益回撤/费率/基准和同类比较。基金自身没有公司营收口径；涉及盈利要穿透到主要持仓公司的年报/财报，不把过期重仓当实时仓位。'
      : '先 stock_dossier、行情与K线；核查公司官方年报/季报原文、营收利润与现金流、估值、资金流入流出、融资及公告新闻。再结合相关国内外政策、全球与中国宏观市场变化解释可能传导，不把资金流与股价相关性当因果。',
    '全球数据按研究问题检索官方央行、统计机构、公司IR或交易所，不仅用国家统计局。关键来源正文未取到或PDF未解析成功时明确“未读到原文”，不得用摘要冒充已读。',
    '逐项注明来源、统计期间/数据时点、币种与单位；保留支持和反对证据、判断成立及失效条件。缺关键资料先查缓存/已配置源，确实拿不到时创建 evidence_request。',
    portfolioAuthorized
      ? '我授权为这次分析读取本机组合中的相关持仓数量与成本，以及既往判断/上次报告，用于「与我的资产关系」和变化对照；不得读取账号凭证或执行交易，缺少风险约束时先说明缺口，不猜仓位。'
      : '本次没有授权使用个人持仓、账户或家庭财务明细。请把可复用证据存入资料库，并用 investment_advice_generate 保存条件性判断；证据不足时不得生成仓位或价格行动方案。',
  ].join('\n')
}
function FundNavChart({ series, note }: { series: Array<{ date: string; nav: number | null }>; note: string }) {
  const points = series.filter(p => typeof p.nav === 'number' && Number.isFinite(p.nav)) as Array<{ date: string; nav: number }>
  if (!points.length) return <p className="fia-muted">{note || '暂无净值序列。'}</p>
  const sample = points.length > 240 ? points.filter((_, i) => i % Math.ceil(points.length / 240) === 0) : points
  const values = sample.map(p => p.nav)
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const width = 640, height = 180
  const coords = sample.map((p, i) => [i / Math.max(1, sample.length - 1) * width, height - ((p.nav - min) / span) * (height - 20) - 10] as const)
  const path = coords.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ')
  const first = points[0]!, last = points[points.length - 1]!
  return <div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`净值走势，${first.date} 至 ${last.date}，${points.length} 个有效点`} style={{ width: '100%', height: 180, display: 'block' }}>
      <path d={path} fill="none" stroke="var(--fia-brand)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="fia-security-data-meta">
      <span>{first.date} → {last.date} · {points.length} 个净值点</span>
      <span>区间 {min.toFixed(4)} ~ {max.toFixed(4)}</span>
      <span>最新 {last.nav.toFixed(4)}（{last.date}）</span>
    </div>
    <p className="fia-muted">净值按 T+1 披露，日期是净值日，不是实时成交价。{note}</p>
  </div>
}

export function SecurityWorkspace(props: {
  get: ReadApi; deliver: Deliver; requested?: SecurityIdentity & { at: number }
  initial?: string; initialType?: 'stock' | 'fund'; onBack?: () => void
  onChart: (item: SecurityIdentity) => void; onSelect?: (item: SecurityIdentity) => void
  /** 由上层用与行情页一致的市场分类提供，避免股票/基金同码读错本地历史。 */
  historyKind?: (item: SecurityIdentity) => string
}) {
  const [identity, setIdentity] = useState<SecurityIdentity | undefined>()
  const [data, setData] = useState<SecurityDossier>()
  const [history, setHistory] = useState<{ bars: RawBar[]; events: KlineMarker[] }>({ bars: [], events: [] })
  const [historyNote, setHistoryNote] = useState('')
  const [navSeries, setNavSeries] = useState<Array<{ date: string; nav: number | null }>>([])
  const [navNote, setNavNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [includePortfolio, setIncludePortfolio] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [globalQuote, setGlobalQuote] = useState<{ price?: number | null; change?: number | null; changePct?: number | null; asOf?: string; name?: string; source?: string } | undefined>()
  const sequence = useRef(0)
  // Function identity from the shell must not retrigger dossier reads on unrelated renders.
  const historyKindRef = useRef(props.historyKind)
  historyKindRef.current = props.historyKind
  const load = useCallback(async (item: SecurityIdentity) => {
    const id = ++sequence.current
    // A consent tick is for one analysis of this exact identity only.
    setIncludePortfolio(false)
    setIdentity(item); setData(undefined); setHistory({ bars: [], events: [] }); setHistoryNote(''); setNavSeries([]); setNavNote(''); setGlobalQuote(undefined); setError(''); setFeedback(''); setBusy(true)
    // 海外个股（日股/英股/欧股等）：走按 secid 的全球行情与K线，不套国内档案。
    if (isGlobalSecurity(item)) {
      try {
        const [q, k] = await Promise.all([
          props.get<{ ok?: boolean; quote?: { price?: number | null; change?: number | null; changePct?: number | null; asOf?: string; name?: string; source?: string }; error?: string }>(`/global/quote?secid=${encodeURIComponent(item.secid!)}`),
          props.get<{ ok?: boolean; bars?: RawBar[]; error?: string }>(`/global/kline?secid=${encodeURIComponent(item.secid!)}&limit=180`),
        ])
        if (sequence.current !== id) return
        if (q.ok === false) setError(q.error || '行情读取失败')
        else setGlobalQuote(q.quote)
        if (k.ok === false) setHistoryNote(k.error || 'K线读取失败')
        else setHistory({ bars: k.bars ?? [], events: [] })
      } catch (err) { if (sequence.current === id) setError(err instanceof Error ? err.message : String(err)) }
      finally { if (sequence.current === id) setBusy(false) }
      return
    }
    try {
      const result = await props.get<SecurityDossier>(`/dossier?code=${encodeURIComponent(item.code)}&type=${item.type}`)
      if (!result.ok) throw new Error('档案数据源返回失败')
      if (sequence.current === id) setData(result)
    } catch (err) { if (sequence.current === id) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (sequence.current === id) setBusy(false) }
    if (sequence.current !== id) return
    if (item.type === 'fund') {
      try {
        const result = await props.get<{ ok?: boolean; series?: Array<{ date: string; nav: number | null }>; error?: string }>('/fund/kline?code=' + encodeURIComponent(item.code))
        if (sequence.current !== id) return
        if (result.ok === false) setNavNote(result.error || '净值序列读取失败')
        else setNavSeries(result.series ?? [])
      } catch (err) { if (sequence.current === id) setNavNote(err instanceof Error ? err.message : String(err)) }
      return
    }
    const historyKind = historyKindRef.current?.(item) ?? 'a'
    try {
      const result = await props.get<{ kline?: RawBar[]; events?: KlineMarker[] }>(`/history?code=${encodeURIComponent(item.code)}&kind=${encodeURIComponent(historyKind)}`)
      if (sequence.current === id) setHistory({ bars: result.kline ?? [], events: result.events ?? [] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // "no local history" is a normal empty state; an identity conflict or a damaged file is an error.
      if (sequence.current === id && !/no local history/i.test(message)) setHistoryNote(message)
    }
  }, [props.get])
  useEffect(() => {
    if (props.requested) void load(props.requested)
    else if (props.initial) void load({ code: props.initial, type: props.initialType ?? 'stock' })
  }, [props.requested?.at, props.initial, props.initialType, load])
  useEffect(() => () => { sequence.current++ }, [])
  const send = async () => {
    if (!identity || sending) return
    setSending(true)
    try { setFeedback(deliveryFeedback(await props.deliver(securityResearchPrompt(identity, includePortfolio)))) }
    catch (err) { setFeedback(err instanceof Error ? err.message : String(err)) }
    finally { setSending(false) }
  }
  const displayName = data ? dossierName(data, identity?.name) : identity?.name || identity?.code
  return <div className="fia-page fia-security-page" data-testid="finance-security-detail">
    <style>{SECURITY_CSS}</style>
    <PageHeader title="证券资料与综合研究" eyebrow="SECURITY DOSSIER" description="先选对股票或基金，再查看原始资料、K线与证据。AI判断和事实资料分开呈现。" actions={props.onBack && <Button onClick={props.onBack}>← 返回上一页</Button>} />
    <SecuritySearch get={props.get} onSelect={item => { if (props.onSelect) props.onSelect(item); else void load(item) }} />
    {identity && <section className="fia-research-section"><div className="fia-security-header"><div><StatusBadge tone="neutral">{identity.type === 'fund' ? '基金' : '股票'}</StatusBadge><h2>{displayName}</h2><p>{identity.code} · {identity.type === 'fund' ? '净值日期以来源标注为准，非实时成交价' : isGlobalSecurity(identity) ? `${identity.market ?? '海外市场'} · 行情与K线按 secid 读取，可能延迟` : '公司财务与资金等数据按各自报告期展示'}</p><div className="fia-security-header-meta">{data ? <><span>档案抓取：{formatDate(data.at, { includeTime: true })}</span><span>可用 {data.ready} / {data.total} 个维度</span></> : isGlobalSecurity(identity) && globalQuote ? <><span>最新 {formatNumber(globalQuote.price ?? null, { decimals: 2 })}</span><span>{typeof globalQuote.changePct === 'number' ? `${globalQuote.changePct >= 0 ? '+' : ''}${globalQuote.changePct.toFixed(2)}%` : '涨跌幅缺失'}</span><span>{globalQuote.asOf ? `行情时间 ${globalQuote.asOf.slice(0, 16).replace('T', ' ')}` : '行情时间未知'}</span></> : <span>{busy ? '读取中…' : '未成功'}</span>}</div></div><div className="fia-security-actions">{!isGlobalSecurity(identity) && <Button onClick={() => props.onChart(identity)}>查看K线／净值走势</Button>}<Button variant="primary" disabled={sending} onClick={() => void send()}>{sending ? '正在投递…' : '让 Agent 综合分析'}</Button><Button variant="ghost" disabled={busy} onClick={() => void load(identity)}>刷新资料</Button></div></div><p className="fia-muted">分析会按需核查财报、新闻、国内外政策、资金与市场环境；默认不读取个人资产，不执行交易。</p><label className="fia-consent" style={{ marginTop: 8 }}><input type="checkbox" checked={includePortfolio} onChange={event => setIncludePortfolio(event.target.checked)} />本次分析允许使用我的相关持仓、成本与既往判断（默认关闭）</label>{feedback && <div className="fia-notice" role="status">{feedback}</div>}</section>}
    {busy && <p role="status" className="fia-muted">正在并发读取各维度，失败项将单独标注，不会用演示数据填充。</p>}
    {error && <div role="alert" className="fia-notice fia-notice--error">{error}{identity && <Button onClick={() => void load(identity)}>重试</Button>}</div>}
    {!identity && <EmptyState title="用名称片段或代码查找" description="例如输入“中国”，从数据源返回的多个候选中选择准确的市场与代码。也可以从持仓、基金排行和自选名称点击进入。" />}
    {identity && isGlobalSecurity(identity) && <div className="fia-research-section"><h3>行情走势（{identity.market ?? '海外市场'}）</h3>
      {historyNote ? <div className="fia-notice fia-notice--error" role="alert">{historyNote}</div> : history.bars.length ? <KlineChart bars={history.bars} markers={history.events} title={`${displayName} · ${identity.market ?? '海外'}日K`} height={300} /> : <p className="fia-muted">{busy ? '正在读取行情…' : '暂无K线数据，可能该市场历史不可用或代码不存在。'}</p>}
      <div className="fia-security-data-meta">
        {globalQuote ? <><span>最新 {formatNumber(globalQuote.price ?? null, { decimals: 2 })}</span><span>{typeof globalQuote.change === 'number' ? `涨跌 ${globalQuote.change >= 0 ? '+' : ''}${formatNumber(globalQuote.change, { decimals: 2 })}` : '涨跌额缺失'}</span><span>{(globalQuote.source ?? 'eastmoney')}</span></> : <span>行情读取中或不可用</span>}
      </div>
      <p className="fia-muted">海外个股来自东方财富按 secid 的行情与日K，可能延迟；不含该市场的本地档案维度（财报/资金流等以该市场实际可得为准，缺失不补）。涨跌不构成买卖建议。</p>
    </div>}
    {data && <><div className="fia-research-section"><h3>{identity?.type === 'fund' ? '净值走势' : '行情走势'}</h3>{identity?.type === 'fund' ? <FundNavChart series={navSeries} note={navNote} /> : historyNote ? <div className="fia-notice fia-notice--error" role="alert">本地历史读取失败：{historyNote}。这不等于“没有数据”，请检查代码与市场类型后重试。</div> : history.bars.length ? <KlineChart bars={history.bars} markers={history.events} title={`${displayName} · 本地历史K线`} height={280} /> : <p className="fia-muted">本地尚无已缓存的历史K线，不代表没有交易数据。点击“查看K线／净值走势”可进入完整行情工作区并同步。</p>}</div>{data.sections.map(section => <DossierSection section={section} key={`${data.snapshotId ?? data.at}-${section.key}`} />)}<p className="fia-muted">抓取时间不等于数据时点。资金流按数据源算法统计，不等于公司现金流；机构预期不等于公司承诺。年报PDF若尚未解析，需由Agent取得可核验原文后再引用。</p></>}
  </div>
}
