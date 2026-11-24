/**
 * 回测输入构造器：从本地历史取价，生成可运行的多资产回测输入。
 *
 * 只做「把已有数据装成输入」这件事：
 * - 价格来自本地历史库（/history），区间按用户填的起止日裁剪；
 * - 税表必须由用户填（默认 0 会明确标注为「未提供税费」），公司行动默认空并标记
 *   actionsComplete=false —— 后端会据此只给部分口径，不会声称完整总回报；
 * - 汇率固定为 1 的资产必须是基准币种，跨币种会要求先补汇率。
 */
import { createElement as h, useState } from 'react'
import { Button } from './design-system/index.js'
import type { ReadApi } from './workbench-model.js'

export interface BuilderRow { code: string; kind: string; weight: string; currency: string }
export interface BuiltAsset {
  id: string; currency: string; weight: number; lotSize: number; adjustment: 'raw'
  prices: Array<{ date: string; open: number; close: number }>
  actions: never[]; actionsComplete: false
  tax: { buyFeeBps: number; sellFeeBps: number; minFee: number; sellTaxBps: number; slippageBps: number }
  taxSource: string
}

export interface BuildResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  input?: Record<string, unknown>
}

/** 纯函数：把「历史K线 + 表单」拼成输入；错误一次给全，不挤牙膏。 */
export function buildBacktestInput(form: {
  baseCurrency: string
  initialCash: string
  cashWeight: string
  start: string
  end: string
  frequency: string
  feeBps: string
  rows: BuilderRow[]
}, history: Record<string, Array<{ date: string; open: number; close: number }>>): BuildResult {
  const errors: string[] = []
  const warnings: string[] = []
  const base = form.baseCurrency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(base)) errors.push('基准币种需为 3 位代码，例如 CNY')
  const initialCash = Number(form.initialCash)
  if (!Number.isFinite(initialCash) || initialCash <= 0) errors.push('初始资金需为大于 0 的数字')
  const cashWeight = Number(form.cashWeight)
  if (!Number.isFinite(cashWeight) || cashWeight < 0 || cashWeight > 100) errors.push('现金权重需在 0–100 之间')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.start) || !/^\d{4}-\d{2}-\d{2}$/.test(form.end)) errors.push('起止日期需为 YYYY-MM-DD')
  else if (form.start > form.end) errors.push('起始日期需早于结束日期')
  if (!['monthly', 'quarterly', 'annual', 'none'].includes(form.frequency)) errors.push('再平衡频率无效')
  const feeBps = Number(form.feeBps || '0')
  if (!Number.isFinite(feeBps) || feeBps < 0) errors.push('费用需为非负数字（基点）')

  const rows = form.rows.filter((row) => row.code.trim() || row.weight.trim())
  if (rows.length < 1) errors.push('至少需要一个资产')
  let weightSum = 0
  const assets: BuiltAsset[] = []
  for (const row of rows) {
    const code = row.code.trim()
    const weight = Number(row.weight)
    const currency = (row.currency || base).trim().toUpperCase()
    if (!code) { errors.push('资产代码不能为空'); continue }
    if (!Number.isFinite(weight) || weight <= 0) { errors.push(`${code} 的权重需大于 0`); continue }
    if (currency !== base) { errors.push(`${code} 的币种 ${currency} 与基准币种不同，需要先补汇率；本构造器不自动换算`); continue }
    const bars = (history[code] ?? []).filter((bar) => bar.date >= form.start && bar.date <= form.end).sort((a, b) => a.date.localeCompare(b.date))
    if (bars.length < 2) { errors.push(`${code} 在所选区间内本地历史不足（${bars.length} 根），先同步历史`); continue }
    weightSum += weight
    assets.push({
      id: code, currency, weight: weight / 100, lotSize: 1, adjustment: 'raw',
      prices: bars.map((bar) => ({ date: bar.date, open: bar.open, close: bar.close })),
      actions: [], actionsComplete: false,
      tax: { buyFeeBps: feeBps, sellFeeBps: feeBps, minFee: 0, sellTaxBps: 0, slippageBps: 0 },
      taxSource: '用户填写（未逐项核验）',
    })
  }
  if (assets.length && Math.abs(weightSum + cashWeight - 100) > 0.01) {
    errors.push(`资产权重合计 ${weightSum.toFixed(2)}% + 现金 ${cashWeight}% 应为 100%`)
  }
  if (!errors.length) {
    warnings.push('未提供分红与拆股数据，结果只覆盖价格与费用口径，不构成完整总回报。')
    warnings.push('价格为本地历史原始收盘（不除权），跨除权日会出现跳空。')
  }
  if (errors.length) return { ok: false, errors, warnings }
  return {
    ok: true, errors, warnings,
    input: {
      baseCurrency: base,
      initialCash,
      cashTargetWeight: cashWeight / 100,
      assets,
      fx: [],
      rebalance: { frequency: form.frequency },
      start: form.start,
      end: form.end,
    },
  }
}

export function BacktestBuilder(props: {
  get: ReadApi
  post: <T>(path: string, body: Record<string, unknown>) => Promise<T>
  onResult: (result: unknown, input: unknown) => void
}) {
  const [form, setForm] = useState({
    baseCurrency: 'CNY', initialCash: '100000', cashWeight: '10',
    start: '2025-01-01', end: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    frequency: 'quarterly', feeBps: '3',
  })
  const [rows, setRows] = useState<BuilderRow[]>([
    { code: '510300', kind: 'a', weight: '60', currency: 'CNY' },
    { code: '518880', kind: 'a', weight: '30', currency: 'CNY' },
  ])
  const [state, setState] = useState<{ busy?: boolean; errors?: string[]; warnings?: string[]; preview?: string }>({})
  const field = (label: string, node: React.ReactNode) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5 } }, label, node)
  const input = (props_: Record<string, unknown>) => h('input', { style: { width: 96 }, ...props_ })

  const run = async () => {
    if (state.busy) return
    setState({ busy: true })
    try {
      const history: Record<string, Array<{ date: string; open: number; close: number }>> = {}
      for (const row of rows) {
        const code = row.code.trim()
        if (!code || history[code]) continue
        const response = await props.get<{ ok?: boolean; kline?: Array<{ date: string; open: number; close: number }> }>(
          `/history?code=${encodeURIComponent(code)}&kind=${encodeURIComponent(row.kind || 'a')}`)
        history[code] = (response.kline ?? []).map((bar) => ({ date: String(bar.date).slice(0, 10), open: Number(bar.open), close: Number(bar.close) }))
      }
      const built = buildBacktestInput({ ...form, rows }, history)
      if (!built.ok || !built.input) { setState({ errors: built.errors, warnings: built.warnings }); return }
      const preview = JSON.stringify(built.input, null, 2)
      setState({ preview, warnings: built.warnings })
      const result = await props.post('/strategy/backtest', built.input)
      props.onResult(result, built.input)
      setState({ preview, warnings: built.warnings })
    } catch (error) {
      setState({ errors: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setState((old) => ({ ...old, busy: false }))
    }
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 } },
    h('p', { className: 'fia-muted', style: { margin: 0 } }, '用本地历史取价，生成纸面回测输入；失败会一次列全原因。'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('基准币种', h('input', { 'aria-label': '基准币种', style: { width: 72 }, value: form.baseCurrency, onChange: (e: any) => setForm({ ...form, baseCurrency: e.target.value.toUpperCase() }) })),
      field('初始资金', input({ 'aria-label': '初始资金', value: form.initialCash, onChange: (e: any) => setForm({ ...form, initialCash: e.target.value }) })),
      field('现金权重%', input({ 'aria-label': '现金权重', value: form.cashWeight, onChange: (e: any) => setForm({ ...form, cashWeight: e.target.value }) })),
      field('开始日期', h('input', { type: 'date', 'aria-label': '开始日期', value: form.start, onChange: (e: any) => setForm({ ...form, start: e.target.value }) })),
      field('结束日期', h('input', { type: 'date', 'aria-label': '结束日期', value: form.end, onChange: (e: any) => setForm({ ...form, end: e.target.value }) })),
      field('再平衡', h('select', { 'aria-label': '再平衡', value: form.frequency, onChange: (e: any) => setForm({ ...form, frequency: e.target.value }) },
        ['monthly', 'quarterly', 'annual', 'none'].map((option) => h('option', { key: option, value: option }, ({ monthly: '每月', quarterly: '每季', annual: '每年', none: '不再平衡' } as Record<string, string>)[option])))),
      field('费用（基点）', input({ 'aria-label': '费用基点', value: form.feeBps, onChange: (e: any) => setForm({ ...form, feeBps: e.target.value }) })),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      rows.map((row, index) => h('div', { key: index, style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        h('input', { 'aria-label': `资产${index + 1}代码`, placeholder: '代码', style: { width: 96 }, value: row.code,
          onChange: (e: any) => setRows(rows.map((r, i) => i === index ? { ...r, code: e.target.value } : r)) }),
        h('select', { 'aria-label': `资产${index + 1}市场`, value: row.kind,
          onChange: (e: any) => setRows(rows.map((r, i) => i === index ? { ...r, kind: e.target.value } : r)) },
          [['a', 'A股/场内基金'], ['hk', '港股'], ['us', '美股']].map(([value, label]) => h('option', { key: value, value }, label))),
        h('input', { 'aria-label': `资产${index + 1}权重`, placeholder: '权重%', style: { width: 72 }, value: row.weight,
          onChange: (e: any) => setRows(rows.map((r, i) => i === index ? { ...r, weight: e.target.value } : r)) }),
        h('input', { 'aria-label': `资产${index + 1}币种`, placeholder: '币种', style: { width: 64 }, value: row.currency,
          onChange: (e: any) => setRows(rows.map((r, i) => i === index ? { ...r, currency: e.target.value.toUpperCase() } : r)) }),
        h(Button, { onClick: () => setRows(rows.filter((_, i) => i !== index)), disabled: rows.length <= 1 }, '移除'))),
      h('div', null, h(Button, { onClick: () => setRows([...rows, { code: '', kind: 'a', weight: '', currency: form.baseCurrency }]) }, '添加资产'))),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h(Button, { variant: 'primary', disabled: state.busy, onClick: () => void run() }, state.busy ? '取价并回测中…' : '用本地历史运行纸面回测')),
    state.warnings?.length ? h('ul', { style: { margin: 0, paddingLeft: 16, color: 'var(--fia-warning, #8A5700)' } }, state.warnings.map((item, index) => h('li', { key: index }, item))) : null,
    state.errors?.length ? h('ul', { role: 'alert', style: { margin: 0, paddingLeft: 16, color: 'var(--fia-danger, #AF3444)' } }, state.errors.map((item, index) => h('li', { key: index }, item))) : null,
    state.preview ? h('details', null, h('summary', null, '查看生成的输入'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto', fontSize: 11 } }, state.preview)) : null,
  )
}
