import { Button, EmptyState, StatusBadge, formatNumber, formatPercent } from './design-system/index.js'
import type { StateCapitalDisclosure } from '../state-capital.js'

/** Follow overview contract. No backend implementation is imported into the client bundle. */
export interface StateCapitalDiffView {
  status: string
  rows: Array<{
    key: string; name: string; code?: string; status: string
    previousQuantity: number | null; nextQuantity: number | null; delta: number | null
    unit: string; note: string
  }>
  warnings: string[]
}

export interface StateCapitalTargetView {
  id: string
  name: string
  kind: string
  stateEntityId?: string
  stateCodes?: string[]
  autoCheck?: boolean
  lastCheckedAt?: string
  stateCapital?: { latest?: StateCapitalDisclosure; diff?: StateCapitalDiffView }
}

export interface StateCapitalCatalogEntry {
  id: string
  name: string
  aliases: string[]
  recommendedCodes?: string[]
}

export interface StateCapitalPanelProps {
  targets: StateCapitalTargetView[]
  catalog?: StateCapitalCatalogEntry[]
  onRequest: (text: string) => void
}

// Static subject labels, not sample holdings. These entities must never become one account.
const DEFAULT_CATALOG: StateCapitalCatalogEntry[] = [
  { id: 'huijin', name: '中央汇金投资有限责任公司', aliases: ['汇金本体'] },
  { id: 'huijin-asset', name: '中央汇金资产管理有限责任公司', aliases: ['汇金资产'] },
  { id: 'csf', name: '中国证券金融股份有限公司', aliases: ['证金'] },
]
const ENTITY_LABELS: Record<string, string> = { huijin: '汇金本体', 'huijin-asset': '汇金资产', csf: '证金' }
const ASSET_LABELS: Record<string, string> = { stock: '股票', fund: '基金', equity: '股权' }
const MODE_LABELS: Record<string, string> = { direct: '直接持有', indirect: '间接持有', unknown: '持有方式未知' }
const DIFF_LABELS: Record<string, string> = {
  'first-observation': '首次观察', first: '首次观察', baseline: '首次观察',
  compared: '已对照', incomparable: '不可直接比较', 'coverage-changed': '覆盖范围变化',
  'same-period-revision': '同报告期修订',
  'quantity-increased': '期末数量增加', 'quantity-decreased': '期末数量减少',
  'quantity-unchanged': '期末数量不变', 'not-disclosed': '本期未披露',
  'newly-disclosed': '本期观察', newly: '本期观察',
}

export function stateCapitalDiffLabel(status: string): string { return DIFF_LABELS[status] ?? '待核对' }

export function formatStateCapitalQuantity(value: number | null | undefined, unit: string, signed = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知'
  return `${formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 20, signed })} ${unit}`
}

/** Preserve source timezone, and never substitute capture time for an unknown report/disclosure date. */
export function formatStateCapitalDate(value: string | null | undefined): string {
  if (!value?.trim()) return '未知'
  return value.trim().replace('T', ' ').replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '').replace(/Z$/, ' UTC')
}

export function formatStateCapitalPercentage(value: number | null | undefined, denominator: string): string {
  const amount = typeof value === 'number' && Number.isFinite(value)
    ? formatPercent(value, { minimumFractionDigits: 0, maximumFractionDigits: 12 }) : '未知'
  return `${amount} · 分母：${denominator.trim() || '未知'}`
}

/** External evidence links are absolute http(s) only; invalid values remain non-clickable text. */
export function stateCapitalSourceUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value.trim())) return undefined
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

export function stateCapitalCheckRequest(target: StateCapitalTargetView): string {
  const id = JSON.stringify(target.id)
  return `请检查国家资本公开披露对象「${target.name}」（主体 ${target.stateEntityId ?? '未标注'}）：先 follow_fetch({id:${id}}) 拉取，再 follow_diff({id:${id}}) 对照，引用具体期末数量、报告期、披露日期与来源，完成后 follow_note({id:${id},...}) 落简报。区分主体与直接/间接持有；期末数量变化不等于期间买卖，未披露不等于清仓。只检查这一对象，不新建后台任务。`
}

export function stateCapitalAddRequest(entity: StateCapitalCatalogEntry): string {
  const input = JSON.stringify({ kind: 'cn-state', stateEntityId: entity.id, name: entity.name, stateCodes: entity.recommendedCodes ?? [], autoCheck: false })
  return `请添加国家资本公开披露对象「${entity.name}」（主体 ${entity.id}）：先 follow_list 防重复并说明披露延迟与有限覆盖，再 follow_add(${input})，随后 follow_fetch → follow_diff → follow_note 建立首次观察。stateCodes 只是有限观察池，不是我的私人持仓或全量账户；不要合并汇金本体、汇金资产和证金。默认手动检查，不开启新的后台任务。`
}

export function stateCapitalConfigureRequest(target: StateCapitalTargetView): string {
  return `请修改国家资本对象「${target.name}」的检查范围（对象 id ${JSON.stringify(target.id)}，主体 ${target.stateEntityId ?? '未标注'}，当前 stateCodes=${JSON.stringify(target.stateCodes ?? [])}）。先向我确认新的有限观察池，再使用 follow_state_configure({id:${JSON.stringify(target.id)},stateCodes:[确认后的代码],autoCheck:${target.autoCheck === true}})。不要把我的私人持仓自动当作观察池，也不要未经我明确同意开启后台检查；修改范围后的快照不可假定与原范围可比。`
}

function EvidenceLink({ url, title }: { url: string; title: string }) {
  const href = stateCapitalSourceUrl(url)
  return href ? <a className="fia-link" href={href} target="_blank" rel="noopener noreferrer">{title}</a>
    : <span className="fia-state-capital__muted">{title}（链接不可用）</span>
}

function Snapshot({ disclosure }: { disclosure: StateCapitalDisclosure }) {
  const levels = [...new Set(disclosure.sources.map(source => source.level))]
  return <>
    <dl className="fia-state-capital__dates">
      <div><dt>报告期</dt><dd>{formatStateCapitalDate(disclosure.asOf)}</dd></div>
      <div><dt>披露日期</dt><dd>{formatStateCapitalDate(disclosure.disclosedAt)}</dd></div>
      <div><dt>抓取时间</dt><dd>{formatStateCapitalDate(disclosure.capturedAt)}</dd></div>
    </dl>
    <p className="fia-state-capital__coverage">覆盖范围：{disclosure.coverage || '未知'}</p>
    <div className="fia-state-capital__levels" aria-label="证据等级">
      {levels.length ? levels.map(level => <StatusBadge key={level} tone={level === 'official' ? 'info' : 'warning'}>
        {level === 'official' ? '官方一手 · official' : '聚合转述 · aggregated'}
      </StatusBadge>) : <StatusBadge>证据等级未知</StatusBadge>}
    </div>
    {disclosure.holdings.length ? <div className="fia-state-capital__scroll" role="region" aria-label={`${disclosure.entityName}具名持有记录，可横向滚动`} tabIndex={0}>
      <table className="fia-table fia-state-capital__holdings">
        <caption>具名持股或份额 · 仅限已披露记录</caption>
        <thead><tr><th scope="col">标的</th><th scope="col" data-numeric="true">期末数量</th><th scope="col">比例与分母</th><th scope="col">持有方式</th><th scope="col">记录时点</th><th scope="col">证据</th></tr></thead>
        <tbody>{disclosure.holdings.map((holding, index) => {
          const source = disclosure.sources.find(item => item.hash === holding.sourceHash && item.url === holding.sourceUrl)
          return <tr key={`${holding.key}:${index}`}>
            <th scope="row"><strong>{holding.name}</strong><small>{holding.code ? `${holding.code} · ` : ''}{ASSET_LABELS[holding.assetType] ?? '类型未知'}</small></th>
            <td data-numeric="true">{formatStateCapitalQuantity(holding.quantity, holding.unit)}<small>原文：{holding.rawQuantity || '未披露数量'}</small></td>
            <td>{formatStateCapitalPercentage(holding.percentage, holding.denominator)}</td>
            <td>{MODE_LABELS[holding.holdingMode] ?? MODE_LABELS.unknown}</td>
            <td><span>报告期 {formatStateCapitalDate(holding.asOf)}</span><small>披露 {formatStateCapitalDate(holding.disclosedAt)}</small></td>
            <td><EvidenceLink url={holding.sourceUrl} title="来源原文" /><small>{source?.level === 'official' ? 'official' : source?.level === 'aggregated' ? 'aggregated' : '等级未知'}</small></td>
          </tr>
        })}</tbody>
      </table>
    </div> : <p className="fia-state-capital__muted" role="status">当前覆盖范围内没有可展示的具名持有记录；不代表未持有。</p>}
    <details className="fia-state-capital__details">
      <summary>来源与校验{disclosure.warnings.length ? ` · ${disclosure.warnings.length} 项口径提示` : ''}</summary>
      <p>主体：{disclosure.entityName}（{disclosure.entityId}） · 范围标识：{disclosure.scopeId}</p>
      {disclosure.warnings.length ? <ul>{disclosure.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      {disclosure.sources.length ? <ul>{disclosure.sources.map((source, index) => <li key={`${source.hash}:${index}`}>
        <EvidenceLink url={source.url} title={source.title || '来源原文'} /> · {source.level} · 来源发布日期 {formatStateCapitalDate(source.publishedAt)}
        <code>hash：{source.hash || '未知'}</code>
      </li>)}</ul> : <p>未提供来源索引。</p>}
      {disclosure.holdings.length ? <details>
        <summary>逐项原文定位（{disclosure.holdings.length} 条）</summary>
        <ul>{disclosure.holdings.map((holding, index) => <li key={`${holding.key}:${index}`}>
          <strong>{holding.name}</strong> · {holding.locator || '定位未知'}<code>hash：{holding.sourceHash || '未知'}</code>
        </li>)}</ul>
      </details> : null}
    </details>
  </>
}

function QuantityDiff({ diff }: { diff: StateCapitalDiffView }) {
  const failed = diff.status === 'error' || diff.status === 'failed'
  return <section className="fia-state-capital__diff" aria-label="期末数量对照">
    <div className="fia-state-capital__diff-heading"><strong>期末数量对照</strong><span role={failed ? 'alert' : 'status'}><StatusBadge tone={failed ? 'danger' : diff.status === 'compared' ? 'neutral' : 'warning'}>{failed ? '对照失败' : stateCapitalDiffLabel(diff.status)}</StatusBadge></span></div>
    {diff.rows.length ? <div className="fia-state-capital__scroll" role="region" aria-label="期末数量差异，可横向滚动" tabIndex={0}>
      <table className="fia-table">
        <caption>仅比较披露期末数量，不推断期间交易</caption>
        <thead><tr><th scope="col">标的 / 状态</th><th scope="col" data-numeric="true">上期数量</th><th scope="col" data-numeric="true">本期数量</th><th scope="col" data-numeric="true">期末差额</th><th scope="col">说明</th></tr></thead>
        <tbody>{diff.rows.map((row, index) => {
          const comparable = diff.status === 'compared' && ['quantity-increased', 'quantity-decreased', 'quantity-unchanged'].includes(row.status)
          return <tr key={`${row.key}:${index}`}>
            <th scope="row">{row.name}{row.code ? ` · ${row.code}` : ''}<small>{stateCapitalDiffLabel(row.status)}</small></th>
            <td data-numeric="true">{formatStateCapitalQuantity(row.previousQuantity, row.unit)}</td>
            <td data-numeric="true">{formatStateCapitalQuantity(row.nextQuantity, row.unit)}</td>
            <td data-numeric="true">{comparable ? formatStateCapitalQuantity(row.delta, row.unit, true) : '不可比'}</td>
            <td>{row.note || '—'}</td>
          </tr>
        })}</tbody>
      </table>
    </div> : <p className="fia-state-capital__muted" role="status">{failed ? '未取得可用对照结果，可重新检查。' : '暂无可展示的数量对照。'}</p>}
    {diff.warnings.length ? <details className="fia-state-capital__details"><summary>对照口径提示（{diff.warnings.length}）</summary><ul>{diff.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
  </section>
}

interface EntityCard { entity: StateCapitalCatalogEntry; target?: StateCapitalTargetView }
function entityCards(targets: StateCapitalTargetView[], catalog: StateCapitalCatalogEntry[]): EntityCard[] {
  const tracked = targets.filter(target => target.kind === 'cn-state')
  const entityId = (target: StateCapitalTargetView) => target.stateEntityId ?? target.stateCapital?.latest?.entityId ?? target.id
  const cards: EntityCard[] = catalog.flatMap<EntityCard>(entity => {
    const matches = tracked.filter(target => entityId(target) === entity.id)
    return matches.length ? matches.map(target => ({ entity, target })) : [{ entity }]
  })
  for (const target of tracked) {
    if (!catalog.some(entity => entity.id === entityId(target))) cards.push({ entity: { id: entityId(target), name: target.name, aliases: [] }, target })
  }
  return cards
}

/** Read-only presentational component: explicit buttons hand work back to the existing conversation. */
export function StateCapitalPanel({ targets, catalog, onRequest }: StateCapitalPanelProps) {
  const cards = entityCards(targets, catalog ?? DEFAULT_CATALOG)
  return <section className="fia-state-capital fia-card" aria-label="国家资本公开披露" data-panel-anchor="state-capital">
    <style data-fia-state-capital-styles="panel">{stateCapitalPanelCss}</style>
    <header className="fia-state-capital__header"><h2>国家资本公开披露</h2><StatusBadge>有限公开记录</StatusBadge></header>
    <p className="fia-state-capital__intro">汇金本体、汇金资产和证金分别展示，不合并为一个账户；非实时、非全量。期末数量变化不等于期间买卖，未披露不等于清仓。</p>
    <p className="fia-state-capital__muted" role="status">默认手动检查，未开启新的后台任务。操作会投递到对话。</p>
    {!cards.length ? <EmptyState title="暂无国家资本主体" description="尚未提供主体目录或追踪对象。可在对话中指定要观察的主体。" /> : null}
    {cards.map(({ entity, target }, index) => {
      const snapshot = target?.stateCapital?.latest
      const mismatched = !!snapshot && snapshot.entityId !== entity.id
      return <article key={`${entity.id}:${target?.id ?? index}`} className="fia-state-capital__entity" data-state-entity={entity.id} aria-label={`${ENTITY_LABELS[entity.id] ?? entity.name}公开披露`}>
        <div className="fia-state-capital__entity-heading">
          <div><h3>{entity.name}</h3><span className="fia-state-capital__subject">{ENTITY_LABELS[entity.id] ?? '独立主体'} · {entity.id}</span></div>
          <div className="fia-state-capital__actions">
            {target ? <><Button onClick={() => onRequest(stateCapitalCheckRequest(target))}>检查披露</Button><Button variant="ghost" onClick={() => onRequest(stateCapitalConfigureRequest(target))}>修改范围</Button></>
              : <Button onClick={() => onRequest(stateCapitalAddRequest(entity))}>添加并检查</Button>}
          </div>
        </div>
        {target ? <p className="fia-state-capital__muted">{target.autoCheck === true ? '已有配置：自动检查已开启' : '手动检查'} · 上次检查 {formatStateCapitalDate(target.lastCheckedAt)}
          {target.stateCodes?.length ? ` · 有限观察池：${target.stateCodes.join('、')}` : entity.id !== 'huijin' ? ' · 有限观察池未设置' : ''}</p> : null}
        {mismatched ? <p className="fia-state-capital__error" role="alert">快照主体与追踪主体不匹配，暂不展示；请检查对象配置。</p> : null}
        {snapshot && !mismatched ? <Snapshot disclosure={snapshot} /> : <p className="fia-state-capital__empty" role="status">尚无可用快照</p>}
        {!target && entity.recommendedCodes?.length ? <details className="fia-state-capital__details"><summary>建议的有限观察池</summary><p>{entity.recommendedCodes.join('、')} · 仅为公开披露样例范围，不是私人持仓或完整账户。</p></details> : null}
        {target?.stateCapital?.diff && !mismatched ? <QuantityDiff diff={target.stateCapital.diff} /> : null}
      </article>
    })}
  </section>
}

export const stateCapitalPanelCss = `
.fia-root .fia-state-capital{display:grid;gap:var(--fia-space-3);min-width:0}
.fia-root .fia-state-capital__header,.fia-root .fia-state-capital__entity-heading,.fia-root .fia-state-capital__diff-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--fia-space-2);flex-wrap:wrap}
.fia-root .fia-state-capital h2{margin:0;font-size:var(--fia-font-lg);font-weight:650}
.fia-root .fia-state-capital h3{margin:0;font-size:var(--fia-font-base);font-weight:650;overflow-wrap:anywhere}
.fia-root .fia-state-capital p{margin:0;overflow-wrap:anywhere}
.fia-root .fia-state-capital__intro{font-size:var(--fia-font-sm);color:var(--fia-secondary)}
.fia-root .fia-state-capital__muted,.fia-root .fia-state-capital__subject{color:var(--fia-muted);font-size:var(--fia-font-sm)}
.fia-root .fia-state-capital__entity{display:grid;gap:var(--fia-space-3);min-width:0;border-top:1px solid var(--fia-border);padding-top:var(--fia-space-4)}
.fia-root .fia-state-capital__entity-heading>div:first-child{min-width:0;flex:1 1 190px}
.fia-root .fia-state-capital__actions,.fia-root .fia-state-capital__levels{display:flex;gap:var(--fia-space-2);flex-wrap:wrap}
.fia-root .fia-state-capital__dates{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:var(--fia-space-2);margin:0;padding:var(--fia-space-3);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);font-size:var(--fia-font-sm)}
.fia-root .fia-state-capital__dates dt{color:var(--fia-muted)}
.fia-root .fia-state-capital__dates dd{margin:2px 0 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fia-root .fia-state-capital__coverage{font-size:var(--fia-font-sm);color:var(--fia-secondary)}
.fia-root .fia-state-capital__scroll{max-width:100%;min-width:0;overflow-x:auto;border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm)}
.fia-root .fia-state-capital table{min-width:680px}
.fia-root .fia-state-capital table caption{text-align:start;padding:var(--fia-space-2) var(--fia-space-3);color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-state-capital .fia-table tbody th{background:transparent;min-width:145px;font-weight:500}
.fia-root .fia-state-capital .fia-table :is(td,th){vertical-align:top;padding:var(--fia-space-2) var(--fia-space-3)}
.fia-root .fia-state-capital .fia-table td:not([data-numeric=true]){min-width:125px;overflow-wrap:anywhere}
.fia-root .fia-state-capital .fia-table small{display:block;font-size:var(--fia-font-xs);color:var(--fia-muted);font-weight:400;margin-top:var(--fia-space-1);white-space:normal}
.fia-root .fia-state-capital__details{color:var(--fia-secondary);font-size:var(--fia-font-sm);min-width:0}
.fia-root .fia-state-capital__details summary{cursor:pointer;color:var(--fia-brand);padding:var(--fia-space-1) 0}
.fia-root .fia-state-capital__details :is(p,ul){margin-top:var(--fia-space-2)}
.fia-root .fia-state-capital__details ul{padding-left:var(--fia-space-5);margin-bottom:0}
.fia-root .fia-state-capital__details li{margin-bottom:var(--fia-space-2);overflow-wrap:anywhere}
.fia-root .fia-state-capital__details code{display:block;font-family:var(--fia-font-mono);font-size:var(--fia-font-xs);overflow-wrap:anywhere}
.fia-root .fia-state-capital__diff{display:grid;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-state-capital__diff-heading{font-size:var(--fia-font-sm);justify-content:flex-start}
.fia-root .fia-state-capital__empty{padding:var(--fia-space-3);background:var(--fia-surface-muted);border-radius:var(--fia-radius-sm);color:var(--fia-muted);font-size:var(--fia-font-sm)}
.fia-root .fia-state-capital__error{color:var(--fia-danger);font-size:var(--fia-font-sm)}
@media(max-width:480px){.fia-root .fia-state-capital__actions{width:100%}.fia-root .fia-state-capital__entity-heading{align-items:flex-start}}
`
