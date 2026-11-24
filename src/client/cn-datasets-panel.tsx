import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState, PageHeader, StatusBadge } from './design-system/index.js'
import type { ReadApi } from './workbench-model.js'
import type { CnDatasetMeta, CnDatasetResult } from '../data/cn-datasets.js'
import {
  bridgeView, buildDatasetQuery, cnDatasetsCss, deriveStatus, firstRowPreview, formatAsOf,
  formatDuration, frequencyLabel, groupByProvider, outcomeFromResult, outcomeView,
  statusReason, statusView,
  type BridgeHealth, type TestOutcome,
} from './cn-datasets-model.js'

export interface CnDatasetsPanelProps {
  get: ReadApi
  /** When explicitly false the panel is hidden; skip loading to avoid a pointless bridge call. */
  active?: boolean
}

interface CnDatasetsResponse {
  ok?: boolean
  error?: string
  bridge?: BridgeHealth
  datasets?: CnDatasetMeta[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

/**
 * Read-only viewer for the CN free datasets. Lists metadata + bridge health, and lets the
 * user fire ONE real fetch per available dataset. No writes, no automatic probing, no
 * fabricated success: an unavailable dataset disables its button, and a failed fetch
 * surfaces the real error instead of a green result.
 */
export function CnDatasetsPanel({ get, active }: CnDatasetsPanelProps) {
  const [datasets, setDatasets] = useState<CnDatasetMeta[] | null>(null)
  const [bridge, setBridge] = useState<BridgeHealth | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [outcomes, setOutcomes] = useState<Record<string, TestOutcome>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const request = useRef(0)
  const mounted = useRef(false)
  const inFlight = useRef<Record<string, boolean>>({})

  const load = useCallback(async () => {
    const token = ++request.current
    setLoading(true)
    setError('')
    try {
      const response = await get<CnDatasetsResponse>('/cn-datasets')
      if (!mounted.current || token !== request.current) return
      if (response.ok === false) throw new Error(response.error || '数据集目录读取失败')
      setDatasets(Array.isArray(response.datasets) ? response.datasets : [])
      setBridge(response.bridge)
    } catch (error) {
      if (mounted.current && token === request.current) {
        setError(`读取数据集目录失败：${errorText(error)}`)
        setDatasets(previous => previous ?? [])
      }
    } finally {
      if (mounted.current && token === request.current) setLoading(false)
    }
  }, [get])

  useEffect(() => {
    mounted.current = true
    if (active !== false) void load()
    return () => { mounted.current = false; request.current++ }
  }, [load, active])

  const runTest = useCallback(async (dataset: string) => {
    if (inFlight.current[dataset]) return
    inFlight.current[dataset] = true
    setTesting(previous => ({ ...previous, [dataset]: true }))
    const started = nowMs()
    try {
      const result = await get<CnDatasetResult>(buildDatasetQuery(dataset, 1))
      if (!mounted.current) return
      setOutcomes(previous => ({ ...previous, [dataset]: outcomeFromResult(result, nowMs() - started) }))
    } catch (error) {
      if (!mounted.current) return
      setOutcomes(previous => ({
        ...previous,
        [dataset]: {
          ok: false, asOf: null, rowCount: null, fields: [], firstRow: null,
          error: errorText(error), elapsedMs: nowMs() - started, warnings: [],
        },
      }))
    } finally {
      inFlight.current[dataset] = false
      if (mounted.current) setTesting(previous => ({ ...previous, [dataset]: false }))
    }
  }, [get])

  const renderOutcome = (outcome: TestOutcome) => {
    const view = outcomeView(outcome)
    const preview = firstRowPreview(outcome.firstRow, 3)
    return (
      <div className="fia-cn-datasets__outcome" data-tone={view.tone} role={outcome.ok ? 'status' : 'alert'}>
        <div className="fia-cn-datasets__outcome-row">
          <span className="fia-cn-datasets__outcome-label">{view.label}</span>
          <span>取数成功：{outcome.ok ? '是' : '否'}</span>
        </div>
        <div className="fia-cn-datasets__outcome-row">
          <span>数据时点：{formatAsOf(outcome.asOf)}</span>
          <span>数据行数：{outcome.rowCount == null ? '—' : String(outcome.rowCount)}</span>
          <span>耗时：{formatDuration(outcome.elapsedMs)}</span>
        </div>
        {preview.length
          ? <ul className="fia-cn-datasets__preview">{preview.map(field => <li key={field.key}>{field.key}：{field.value}</li>)}</ul>
          : <span className="fia-cn-datasets__outcome-row">首行字段：—</span>}
        {!outcome.ok && outcome.error
          ? <div className="fia-cn-datasets__outcome-row"><span>错误：{outcome.error}</span></div>
          : null}
      </div>
    )
  }

  const renderCard = (meta: CnDatasetMeta) => {
    const outcome = outcomes[meta.dataset]
    const status = deriveStatus(meta, bridge, outcome)
    const view = statusView(status)
    const reason = statusReason(meta, bridge, outcome)
    const available = meta.available !== false
    const busy = !!testing[meta.dataset]
    return (
      <article key={meta.dataset} className="fia-cn-datasets__card" data-status={status}>
        <div className="fia-cn-datasets__card-main">
          <div className="fia-cn-datasets__card-head">
            <code className="fia-cn-datasets__id">{meta.dataset}</code>
            <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
          </div>
          <dl className="fia-cn-datasets__facts">
            <div><dt>来源</dt><dd>{meta.source ?? '—'}</dd></div>
            <div><dt>频率</dt><dd>{frequencyLabel(meta.frequency)}</dd></div>
            <div><dt>单位</dt><dd>{meta.unit ?? '—'}</dd></div>
          </dl>
          {reason ? <p className="fia-cn-datasets__reason">{reason}</p> : null}
          {meta.sourceUrl
            ? <a className="fia-cn-datasets__source-link" href={meta.sourceUrl} target="_blank" rel="noreferrer">来源页面</a>
            : null}
        </div>
        <div className="fia-cn-datasets__card-test">
          {available
            ? <Button variant="secondary" disabled={busy} onClick={() => void runTest(meta.dataset)}>{busy ? '测试中…' : '测试'}</Button>
            : <><Button variant="secondary" disabled title="不可用数据集不发起抓取">测试</Button><span className="fia-cn-datasets__test-disabled">不可用，已禁用</span></>}
          {outcome ? renderOutcome(outcome) : null}
        </div>
      </article>
    )
  }

  const groups = groupByProvider(datasets ?? [])
  const availableCount = (datasets ?? []).filter(dataset => dataset.available !== false).length
  const unavailableCount = (datasets ?? []).length - availableCount
  const health = bridgeView(bridge)

  return (
    <section className="fia-cn-datasets" aria-label="中国免费数据集">
      <style data-fia-cn-datasets-styles="panel">{cnDatasetsCss}</style>
      <PageHeader
        title="中国免费数据集"
        eyebrow="CN DATASETS"
        description="浏览 AKShare 数据集与连接状态，点击「测试」获取一条数据。"
        actions={<Button disabled={loading} onClick={() => void load()}>{loading ? '刷新中…' : '刷新目录'}</Button>}
      />

      <div className="fia-cn-datasets__bridge" data-tone={health.tone} role="status" aria-label="桥接健康">
        <StatusBadge tone={health.tone}>桥接健康 · {health.label}</StatusBadge>
        <span className="fia-cn-datasets__bridge-detail">{health.detail}</span>
      </div>

      {datasets && datasets.length > 0
        ? <div className="fia-cn-datasets__meta">
            <span>共 {datasets.length} 个数据集</span>
            <span>可用 {availableCount}</span>
            <span>不可用 {unavailableCount}</span>
          </div>
        : null}

      {error
        ? <div className="fia-cn-datasets__feedback" data-tone="error" role="alert">
            {error} {datasets && datasets.length > 0 ? '当前已读到的目录仍保留。' : '请重试刷新目录。'}
          </div>
        : null}

      {loading && datasets === null
        ? <div className="fia-cn-datasets__feedback" role="status">正在读取数据集目录…</div>
        : null}

      {!error && datasets !== null && datasets.length === 0
        ? <EmptyState title="暂无数据集" description="未取得数据集目录，请刷新重试。" />
        : null}

      {groups.map(group => (
        <section key={group.provider ?? '__none__'} className="fia-cn-datasets__group" aria-label={`来源 ${group.label}`}>
          <h2 className="fia-cn-datasets__group-title">{group.label} <span>· {group.items.length} 个数据集</span></h2>
          {group.items.map(renderCard)}
        </section>
      ))}
    </section>
  )
}
