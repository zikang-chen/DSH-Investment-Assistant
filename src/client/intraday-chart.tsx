/**
 * 分时图：当日或近 5 日分钟级价格。
 *
 * 只画源侧给的三样东西：成交价线、均价线、分钟量。不重采样、不插值、不推断缺分钟。
 * 缺失点直接断开（不在两点间连一条假线）。
 */
import { createElement as h } from 'react'

export interface IntradayLikePoint {
  time: string
  price: number | null
  avgPrice: number | null
  volume: number | null
}

export interface IntradayChartProps {
  points: IntradayLikePoint[]
  /** 昨收：作为基准线与涨跌幅参照；缺失时只画价格。 */
  preClose?: number | null
  title?: string
  height?: number
}

const PAD = { top: 26, right: 52, bottom: 22, left: 10 }
const VOLUME_SHARE = 0.22

function money(v: number): string {
  return v >= 1000 ? v.toFixed(1) : v.toFixed(v >= 100 ? 2 : 3)
}

export function IntradayChart({ points, preClose = null, title = '分时', height = 300 }: IntradayChartProps) {
  const width = 640
  const priced = points.filter((p): p is IntradayLikePoint & { price: number } => typeof p.price === 'number' && Number.isFinite(p.price))
  if (!priced.length) {
    return h('div', { role: 'status', style: { padding: 12, fontSize: 12, opacity: 0.7 } }, '本次分时没有有效价格点，可能尚未开盘或源未返回数据。')
  }
  const plotH = height - PAD.top - PAD.bottom
  const priceH = plotH * (1 - VOLUME_SHARE)
  const volumeH = plotH * VOLUME_SHARE - 6

  const base = preClose !== null && Number.isFinite(preClose) ? preClose : priced[0]!.price
  // 价格与均价同轴，基准线与最高/最低一起决定纵轴范围，避免基准线跑出画布。
  const values = priced.flatMap((p) => (typeof p.avgPrice === 'number' ? [p.price, p.avgPrice] : [p.price]))
  const hi = Math.max(base, ...values)
  const lo = Math.min(base, ...values)
  const span = hi - lo || Math.max(hi * 0.002, 0.01)
  const y = (v: number) => PAD.top + ((hi - v) / span) * priceH
  const x = (i: number) => PAD.left + (priced.length === 1 ? (width - PAD.left - PAD.right) / 2 : (i / (priced.length - 1)) * (width - PAD.left - PAD.right))

  const maxVol = Math.max(1, ...priced.map((p) => (typeof p.volume === 'number' ? p.volume : 0)))
  const volTop = PAD.top + priceH + 6
  const line = priced.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
  const avgLine = priced
    .map((p, i) => (typeof p.avgPrice === 'number' ? `${x(i).toFixed(1)},${y(p.avgPrice).toFixed(1)}` : null))
    .filter((s): s is string => !!s)
  const last = priced.at(-1)!
  const changePct = preClose && preClose !== 0 ? ((last.price - preClose) / preClose) * 100 : null
  const up = changePct === null ? null : changePct >= 0
  const stroke = up === null ? 'var(--fia-brand)' : up ? 'var(--fia-up)' : 'var(--fia-down)'

  // 横轴刻度：取首、1/4、1/2、3/4、末的时间（跨日时显示日期）。
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => {
    const i = Math.min(priced.length - 1, Math.round(r * (priced.length - 1)))
    return { i, label: priced[i]!.time.replace(/^\d{4}-\d{2}-\d{2}\s+/, (m) => (r === 0 ? m.slice(5, 10) + ' ' : '')) }
  })

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 11.5 } },
      h('span', { style: { fontWeight: 600 } }, title),
      h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 650, fontSize: 13 } }, money(last.price)),
      changePct === null
        ? null
        : h('span', { style: { fontVariantNumeric: 'tabular-nums', color: stroke } }, `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`),
      preClose === null ? h('span', { style: { opacity: 0.65 } }, '昨收缺失，仅画价格') : h('span', { style: { opacity: 0.65 } }, `昨收 ${money(preClose)}`),
      h('span', { style: { marginLeft: 'auto', opacity: 0.65 } }, `${priced.length} 个分钟点 · ${priced[0]!.time.slice(0, 16)} 起`)),
    h('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': `${title}分时图` },
      preClose === null ? null : h('line', { x1: PAD.left, x2: width - PAD.right, y1: y(base), y2: y(base), stroke: 'var(--fia-border)', strokeDasharray: '3 3' }),
      avgLine.length > 1
        ? h('polyline', { points: avgLine.join(' '), fill: 'none', stroke: 'var(--fia-warning)', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.9 })
        : null,
      h('path', { d: line, fill: 'none', stroke, strokeWidth: 1.6 }),
      priced.map((p, i) => {
        const v = typeof p.volume === 'number' ? p.volume : 0
        if (!v) return null
        const barW = Math.max(1, (width - PAD.left - PAD.right) / priced.length - 0.5)
        return h('rect', {
          key: `${p.time}-${i}`, x: x(i) - barW / 2, y: volTop + (volumeH - (v / maxVol) * volumeH),
          width: barW, height: (v / maxVol) * volumeH, fill: up === false ? 'var(--fia-down-soft)' : 'var(--fia-up-soft)',
        })
      }),
      [hi, base, lo].map((v, i) => h('text', {
        key: `y-${i}`, x: width - PAD.right + 4, y: y(v) + 3, fontSize: 9.5, fill: 'var(--fia-muted)',
        style: { fontVariantNumeric: 'tabular-nums' },
      }, money(v))),
      ticks.map((t, i) => h('text', {
        key: `x-${i}`, x: x(t.i), y: height - 6, fontSize: 9.5, fill: 'var(--fia-muted)',
        textAnchor: i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle',
      }, t.label))),
    h('div', { style: { fontSize: 10.5, opacity: 0.6, lineHeight: 1.5 } },
      '分时只含交易日内的分钟价，不除权、不含盘后；均价线来自源侧，不等于你的持仓成本。'))
}
