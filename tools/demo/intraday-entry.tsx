/**
 * 只用固定示例数据渲染分时图（不发请求、不读持仓），用于本地视觉核对。
 * 产物写入 tools/demo/.out/（gitignored），不进入 docs/images。
 */
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { IntradayChart } from '../../src/client/intraday-chart.js'

type P = { time: string; price: number | null; avgPrice: number | null; volume: number | null }

const day = (date: string, from: number, to: number, start: number, step: number, gap = 0, volBase = 3000): P[] => {
  const points: P[] = []
  let price = start
  let total = 0
  for (let m = from; m <= to; m++) {
    if (gap && m > gap.from && m < gap.to) continue
    price += Math.sin(m / 7) * step + step / 3
    const volume = Math.round(volBase * (0.6 + Math.abs(Math.cos(m / 5))))
    total += volume
    points.push({
      time: `${date} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
      price: Number(price.toFixed(2)),
      avgPrice: Number((start + (price - start) * 0.55).toFixed(2)),
      volume,
    })
  }
  void total
  return points
}

const aHalf = day('2026-11-23', 570, 690, 1485.75, 0.9)
const hkFull = [...day('2026-11-23', 570, 720, 344, 0.12, 0, 8000), ...day('2026-11-23', 780, 960, 344.4, 0.12, 0, 8000)]
const usOvernight = [
  ...day('2026-11-20', 1290, 1439, 349.21, 0.04, 0, 41000),
  ...day('2026-11-21', 0, 300, 350.1, 0.04, 0, 41000),
]
// 人为挖掉一段，验证「缺失分钟留白、不连假线」。
const aWithGap = aHalf.map((p) => (p.time >= '2026-11-23 10:30' && p.time <= '2026-11-23 10:44' ? { ...p, price: null, avgPrice: null } : p))

createRoot(document.getElementById('root')!).render(
  h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'system-ui, sans-serif', background: '#f5f6f8' } },
    h('div', { style: { fontSize: 12, opacity: 0.7 } }, '示例数据 · 分时图视觉核对（无真实持仓、无网络请求）'),
    h('div', { 'data-shot': 'a-half' }, h(IntradayChart, { points: aHalf, preClose: 1485.75, kind: 'a', days: 1, title: '上午 11:30 · A股半天', height: 300 })),
    h('div', { 'data-shot': 'a-gap' }, h(IntradayChart, { points: aWithGap, preClose: 1485.75, kind: 'a', days: 1, title: '缺口 10:30–10:44', height: 260 })),
    h('div', { 'data-shot': 'hk-full' }, h(IntradayChart, { points: hkFull, preClose: 344, kind: 'hk', days: 1, title: '港股全天', height: 260 })),
    h('div', { 'data-shot': 'us-night' }, h(IntradayChart, { points: usOvernight, preClose: 349.21, kind: 'us', days: 1, title: '美股跨午夜', height: 260 })),
    h('div', { 'data-shot': 'a-5day' }, h(IntradayChart, { points: [...aHalf, ...day('2026-11-20', 570, 900, 1470, 0.6, 690, 5000), ...day('2026-11-19', 570, 900, 1478, 0.6, 690, 5000)], preClose: 1478, kind: 'a', days: 3, title: '多日', height: 260 })),
  ),
)
