/**
 * 分时图：与日线 K 线同一套画法（canvas + 设计系统色板 + 右侧价格轴 + 十字光标 + 量仓）。
 *
 * 只画源侧给的分钟价、均价与分钟量：未交易时段留白，缺失分钟断线，不插值、不补 0。
 * 参考 lightweight-charts 的 whitespace/crosshair 语义（无新依赖）与 kline-chart 的视觉语言。
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { getFinanceTokens, useFinanceTheme } from './design-system/index.js'
import { financeChartPalette } from './chart-theme.js'
import { buildIntradayModel, intradaySlotAt, intradayX, type IntradayKind, type IntradayLikePoint, type IntradaySlot } from './intraday-math.js'
export type { IntradayLikePoint } from './intraday-math.js'

export interface IntradayChartProps {
  points: IntradayLikePoint[]
  preClose?: number | null
  title?: string
  height?: number
  kind?: IntradayKind
  days?: number
}

const PAD_LEFT = 6
const PAD_RIGHT = 68
const PAD_TOP = 16
const VOL_HEIGHT = 46
const PANE_GAP = 8
const AXIS_HEIGHT = 18

function formatPrice(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 10000) return v.toFixed(0)
  if (abs >= 1000) return v.toFixed(1)
  if (abs >= 100) return v.toFixed(2)
  return v.toFixed(3)
}

function formatVolume(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(Math.round(v))
}

/** 横轴刻度：单日取开盘/（午休或中点）/收盘；多日取每日中点。 */
function timeTicks(model: ReturnType<typeof buildIntradayModel>): Array<{ index: number; label: string }> {
  const clock = (slot: IntradaySlot | undefined) => slot ? slot.time.slice(-5) : ''
  const one = model.days[0]
  if (model.days.length === 1 && one) {
    const mid = one.breaks.length
      ? { index: one.breaks[0]! - 0.5, label: `${clock(model.slots[one.breaks[0]! - 1])}/${clock(model.slots[one.breaks[0]!])}` }
      : { index: Math.floor((one.start + one.end) / 2), label: clock(model.slots[Math.floor((one.start + one.end) / 2)]) }
    return [{ index: one.start, label: clock(model.slots[one.start]) }, mid, { index: one.end, label: clock(model.slots[one.end]) }]
  }
  return model.days.map((day) => ({ index: (day.start + day.end) / 2, label: day.date ? day.date.slice(5) : '日期缺失' }))
}

export function IntradayChart({ points, preClose = null, title = '分时', height = 300, kind = 'a', days = 1 }: IntradayChartProps) {
  const { resolved, marketMode } = useFinanceTheme()
  const paint = useMemo(() => getFinanceTokens(resolved, marketMode), [resolved, marketMode])
  const pal = useMemo(() => financeChartPalette(resolved, marketMode), [resolved, marketMode])
  const model = useMemo(() => buildIntradayModel(points, preClose, kind, days), [points, preClose, kind, days])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [width, setWidth] = useState(560)
  const [cross, setCross] = useState<{ x: number; y: number; index: number } | null>(null)
  const [focused, setFocused] = useState(false)

  const total = model.slots.length
  // 同一标的刷新时槽位布局不变，保留十字光标；换周期/换标的才复位。
  const layout = `${kind}:${days}:${total}`
  const layoutRef = useRef(layout)
  useEffect(() => {
    if (layoutRef.current === layout) return
    layoutRef.current = layout
    setCross(null)
  }, [layout])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(Math.max(160, el.clientWidth))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  const chartHeight = Number.isFinite(height) ? Math.max(160, height) : 300
  const priceH = chartHeight - PAD_TOP - VOL_HEIGHT - PANE_GAP - AXIS_HEIGHT
  const volTop = PAD_TOP + priceH + PANE_GAP
  const plotW = Math.max(20, width - PAD_LEFT - PAD_RIGHT)
  const xAt = (index: number) => intradayX(index, total, PAD_LEFT, plotW)
  const yAt = (value: number) => PAD_TOP + (1 - (value - model.min) / (model.max - model.min || 1)) * priceH
  const priceAtY = (y: number) => model.min + (1 - (y - PAD_TOP) / priceH) * (model.max - model.min)

  const lastChange = model.last && model.hasPreClose && model.base !== null ? model.last.price! - model.base : null
  const lineColor = lastChange === null ? pal.cross : lastChange >= 0 ? pal.up : pal.down

  // ---- 绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(chartHeight * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, chartHeight)
    if (total === 0) return

    const slotW = plotW / Math.max(1, total)
    const bodyW = Math.max(1, Math.min(6, slotW * 0.7))

    // 网格 + 右侧价格轴（与日线同一节奏：5 条水平线）
    ctx.font = '10px system-ui, sans-serif'
    ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const v = model.max - ((model.max - model.min) * g) / 4
      const yy = Math.round(yAt(v)) + 0.5
      ctx.strokeStyle = pal.grid
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(PAD_LEFT, yy)
      ctx.lineTo(width - PAD_RIGHT, yy)
      ctx.stroke()
      ctx.fillStyle = pal.text
      ctx.textAlign = 'right'
      ctx.fillText(formatPrice(v), width - 6, yy + 3)
    }

    // 昨收基准线：与十字光标区分开（细点线 + 中性色），避免两条虚线混淆
    if (model.hasPreClose && model.base !== null) {
      const by = Math.round(yAt(model.base)) + 0.5
      ctx.strokeStyle = pal.text
      ctx.setLineDash([2, 4])
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.moveTo(PAD_LEFT, by)
      ctx.lineTo(width - PAD_RIGHT, by)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
    }

    // 交易日分隔 + 午休分隔
    ctx.strokeStyle = pal.grid
    model.days.slice(1).forEach((day) => {
      const x = Math.round(xAt(day.start - 0.5)) + 0.5
      ctx.setLineDash([4, 2])
      ctx.beginPath()
      ctx.moveTo(x, PAD_TOP)
      ctx.lineTo(x, volTop + VOL_HEIGHT)
      ctx.stroke()
    })
    ctx.globalAlpha = 0.7
    model.days.forEach((day) => day.breaks.forEach((index) => {
      const x = Math.round(xAt(index - 0.5)) + 0.5
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(x, PAD_TOP)
      ctx.lineTo(x, volTop + VOL_HEIGHT)
      ctx.stroke()
    }))
    ctx.globalAlpha = 1
    ctx.setLineDash([])

    // 量仓基线
    ctx.strokeStyle = pal.grid
    ctx.beginPath()
    ctx.moveTo(PAD_LEFT, Math.round(volTop + VOL_HEIGHT) + 0.5)
    ctx.lineTo(width - PAD_RIGHT, Math.round(volTop + VOL_HEIGHT) + 0.5)
    ctx.stroke()

    // 分钟量（涨跌染色，与日线量柱同一透明度）
    model.slots.forEach((slot) => {
      if (slot.volume === null || slot.volume <= 0) return
      const hgt = Math.max(0.6, (slot.volume / model.maxVolume) * VOL_HEIGHT)
      ctx.fillStyle = slot.direction === 'down' ? pal.down : slot.direction === 'up' ? pal.up : pal.text
      ctx.globalAlpha = 0.5
      ctx.fillRect(xAt(slot.index) - bodyW / 2, volTop + VOL_HEIGHT - hgt, bodyW, hgt)
      ctx.globalAlpha = 1
    })

    // 价格线与均价线：按段绘制，缺口/跨日/午休不连线
    const drawSegments = (segments: IntradaySlot[][], field: 'price' | 'avgPrice', color: string, dash: number[], lineWidth: number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      ctx.setLineDash(dash)
      segments.forEach((segment) => {
        if (segment.length === 1) {
          const slot = segment[0]!
          ctx.beginPath()
          ctx.arc(xAt(slot.index), yAt(slot[field]!), 1.4, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          return
        }
        ctx.beginPath()
        segment.forEach((slot, i) => {
          const x = xAt(slot.index)
          const y = yAt(slot[field]!)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()
      })
      ctx.setLineDash([])
      ctx.lineWidth = 1
    }
    drawSegments(model.avgSegments, 'avgPrice', paint.warning, [4, 3], 1)
    drawSegments(model.priceSegments, 'price', lineColor, [], 1.6)

    // 时间轴
    ctx.fillStyle = pal.text
    ctx.textAlign = 'center'
    const ticks = timeTicks(model)
    ticks.forEach((tick, i) => {
      const x = xAt(tick.index)
      ctx.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
      ctx.fillText(tick.label, i === 0 ? Math.max(PAD_LEFT, x) : Math.min(width - PAD_RIGHT, x), chartHeight - AXIS_HEIGHT / 2 + 2)
    })

    // 十字光标：竖线贯穿两仓，横线只落在价格仓并带右侧价签
    if (cross) {
      const snapped = Math.max(0, Math.min(total - 1, cross.index))
      const slot = model.slots[snapped]
      const cx = Math.round(xAt(snapped)) + 0.5
      ctx.strokeStyle = pal.cross
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(cx, PAD_TOP)
      ctx.lineTo(cx, volTop + VOL_HEIGHT)
      if (cross.y >= PAD_TOP && cross.y <= PAD_TOP + priceH) {
        const cy = Math.round(cross.y) + 0.5
        ctx.moveTo(PAD_LEFT, cy)
        ctx.lineTo(width - PAD_RIGHT, cy)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = pal.cross
        ctx.fillRect(width - PAD_RIGHT + 2, cy - 8, PAD_RIGHT - 4, 16)
        ctx.fillStyle = paint['on-primary']
        ctx.textAlign = 'left'
        ctx.fillText(formatPrice(priceAtY(cross.y)), width - PAD_RIGHT + 6, cy + 3)
      } else {
        ctx.stroke()
      }
      ctx.setLineDash([])
      if (slot?.price !== null && slot?.price !== undefined) {
        ctx.fillStyle = pal.cross
        ctx.beginPath()
        ctx.arc(cx, yAt(slot.price), 2.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [model, width, chartHeight, priceH, volTop, plotW, total, pal, paint, cross, lineColor, xAt, yAt])

  // ---- 交互 ----
  const indexAt = (clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const x = rect ? clientX - rect.left : clientX
    // 按屏幕像素实际比例换算回画布坐标，窄面板也不会错位。
    const local = rect && rect.width > 0 ? (x * width) / rect.width : x
    return intradaySlotAt((local - PAD_LEFT) / plotW, total)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setCross({ x: e.clientX - rect.left, y: e.clientY - rect.top, index: indexAt(e.clientX) })
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.focus()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成事件或已释放的指针 */ }
    onPointerMove(e)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return
    e.preventDefault()
    if (e.key === 'Escape') { setCross(null); return }
    const current = cross ? cross.index : total - 1
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? total - 1 : Math.max(0, Math.min(total - 1, current + (e.key === 'ArrowRight' ? 1 : -1)))
    setCross({ x: xAt(next), y: PAD_TOP + priceH / 2, index: next })
  }

  if (!model.validPrices) {
    return h('div', {
      style: { height: chartHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: paint.secondary, fontSize: 12 },
    }, '暂无分时数据（未开盘或源未返回分钟行情）')
  }

  const hovered = cross ? model.slots[Math.max(0, Math.min(total - 1, cross.index))] ?? null : null
  const shown = hovered ?? model.last
  const shownChange = shown?.price != null && model.hasPreClose && model.base ? (shown.price / model.base - 1) * 100 : null
  const lineStyle = (color: string, dash: boolean) => ({ width: 14, height: 0, borderTop: `2px ${dash ? 'dashed' : 'solid'} ${color}` })
  // 浮层不压住右侧价格轴上的价签
  const tooltipLeft = cross ? Math.max(8, Math.min(cross.x + 14, width - PAD_RIGHT - 204)) : 0

  return h('div', { ref: containerRef, style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0, overflow: 'hidden' } },
    // 图例：与日线一致的行内样本 + 当前读数
    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 10.5, color: paint.secondary } },
      h('span', { style: { fontWeight: 600, color: paint.text } }, title),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('span', { style: lineStyle(lineColor, false) }), `价格 ${shown?.price == null ? '—' : formatPrice(shown.price)}`),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('span', { style: lineStyle(paint.warning, true) }), `均价 ${shown?.avgPrice == null ? '—' : formatPrice(shown.avgPrice)}`),
      model.hasPreClose ? h('span', { style: { color: paint.secondary } }, `昨收 ${formatPrice(model.base!)}`) : h('span', { style: { color: paint.warning } }, '昨收缺失'),
      shownChange === null ? null : h('span', {
        style: { fontWeight: 600, color: shownChange >= 0 ? pal.up : pal.down, fontVariantNumeric: 'tabular-nums' },
      }, `${shownChange >= 0 ? '+' : ''}${shownChange.toFixed(2)}%`),
      h('span', { style: { marginLeft: 'auto', color: paint.muted } }, `${model.validPrices} 个分钟点`)),
    // 画布 + 提示框（与 K 线同一套浮层样式）
    h('div', { style: { position: 'relative', height: chartHeight } },
      h('canvas', {
        ref: canvasRef, tabIndex: 0, role: 'application',
        'aria-label': `${title}分时图。方向键逐分钟读值，Home/End 到首尾，Esc 退出。缺失与未交易留白，不插值。`,
        style: {
          width: '100%', height: '100%', display: 'block', cursor: 'crosshair', touchAction: 'pan-y',
          borderRadius: 8, outline: focused ? `2px solid ${paint.focus}` : 'none',
        },
        onPointerDown, onPointerMove,
        onPointerCancel: () => setCross(null),
        onPointerLeave: () => setCross(null),
        onFocus: () => setFocused(true),
        onBlur: () => { setFocused(false); setCross(null) },
        onKeyDown,
      }),
      hovered ? h('div', {
        style: {
          position: 'absolute', top: 6, left: tooltipLeft, minWidth: 168, maxWidth: 210,
          background: paint.surface, color: paint.text, border: `1px solid ${paint.border}`, borderRadius: 8, padding: '8px 10px',
          fontSize: 11, lineHeight: 1.7, pointerEvents: 'none', zIndex: 2,
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, hovered.time),
        h('div', null, `价格 ${hovered.price == null ? '—' : formatPrice(hovered.price)}　均价 ${hovered.avgPrice == null ? '—' : formatPrice(hovered.avgPrice)}`),
        h('div', null, `分钟量 ${hovered.volume == null ? '—' : formatVolume(hovered.volume)}`),
        hovered.present ? null : h('div', { style: { opacity: 0.8 } }, '无数据（未交易或源缺失）')) : null),
    // 读数行（供读屏，也方便复制）
    h('div', {
      'aria-live': 'polite', 'aria-atomic': 'true',
      style: { fontSize: 10, color: paint.muted, fontVariantNumeric: 'tabular-nums' },
    }, hovered
      ? `${hovered.time} · 价格 ${hovered.price == null ? '—' : formatPrice(hovered.price)} · 均价 ${hovered.avgPrice == null ? '—' : formatPrice(hovered.avgPrice)} · 分钟量 ${hovered.volume == null ? '—' : formatVolume(hovered.volume)}${hovered.present ? '' : ' · 无数据'}`
      : '滚轮/触摸悬停查看分钟读数 · 方向键逐分钟 · Home/End 首尾 · Esc 退出'),
    h('div', { style: { fontSize: 10, color: paint.muted } },
      '价格线不除权、不含盘后；均价为源侧均值（不是持仓成本）。缺失分钟与未交易时段留白，不插值；量柱按前一分钟涨跌着色。',
      kind === 'us' ? ' 美股时间按源侧 +08:00，跨午夜仍属同一交易日。' : ' 午休与日期间断线。'))
}
