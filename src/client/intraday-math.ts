/** Pure intraday model. Slots are whitespace, never invented price/volume observations.
 * Inspired by TradingView's whitespace data / magnet crosshair semantics (no dependency).
 * US timestamps are source-side +08:00, NOT converted using the browser timezone.
 */
export type IntradayKind = 'a' | 'hk' | 'us'
export interface IntradayLikePoint {
  time: string
  price: number | null
  avgPrice: number | null
  volume: number | null
}
export interface IntradaySlot {
  index: number
  day: number
  session: number
  time: string
  minute: number
  price: number | null
  avgPrice: number | null
  volume: number | null
  present: boolean
  direction: 'up' | 'down' | 'flat'
}
export interface IntradayDay {
  date: string | null
  start: number
  end: number
  breaks: number[]
}
export interface IntradayModel {
  slots: IntradaySlot[]
  days: IntradayDay[]
  priceSegments: IntradaySlot[][]
  avgSegments: IntradaySlot[][]
  base: number | null
  hasPreClose: boolean
  min: number
  max: number
  maxVolume: number
  validPrices: number
  last: IntradaySlot | null
}
export const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const validVolume = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const hhmm = (minute: number) => `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
function shiftDate(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}
function parseTime(time: string): { date: string | null; minute: number } | null {
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}):(\d{2})(?::00)?(?:\+08:00)?$/.exec(time.trim())
  if (!m) return null
  const hour = Number(m[2]), minute = Number(m[3])
  if (hour > 23 || minute > 59) return null
  if (m[1]) {
    const d = new Date(`${m[1]}T00:00:00Z`)
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) return null
  }
  return { date: m[1] ?? null, minute: hour * 60 + minute }
}
function sessions(kind: IntradayKind, firstMinute?: number): [number, number][] {
  if (kind === 'a') return [[570, 690], [780, 900]]
  if (kind === 'hk') return [[570, 720], [780, 960]]
  // Detect the template from the first source point, not the viewer's local DST.
  const winter = firstMinute !== undefined && (firstMinute >= 1350 || (firstMinute > 240 && firstMinute < 720))
  const open = winter ? 1350 : 1290
  return [[open, open + 390]]
}
/** Split independently for each value: null/invalid values, absent minutes, lunch and days break lines. */
export function intradaySegments(slots: IntradaySlot[], field: 'price' | 'avgPrice'): IntradaySlot[][] {
  const result: IntradaySlot[][] = []
  let run: IntradaySlot[] = []
  for (const slot of slots) {
    const prev = run.at(-1)
    if (slot[field] === null || (prev && (prev.day !== slot.day || prev.session !== slot.session || slot.minute !== prev.minute + 1))) {
      if (run.length) result.push(run)
      run = []
    }
    if (slot[field] !== null) run.push(slot)
  }
  if (run.length) result.push(run)
  return result
}
export function buildIntradayModel(points: IntradayLikePoint[], preClose: number | null = null, kind: IntradayKind = 'a', days = 1): IntradayModel {
  const parsed = points.flatMap((point) => {
    const parsedTime = parseTime(point.time)
    if (!parsedTime) return []
    const date = kind === 'us' && parsedTime.date && parsedTime.minute < 720 ? shiftDate(parsedTime.date, -1) : parsedTime.date
    return [{ point, ...parsedTime, date }]
  })
  // Undated legacy HH:mm inputs remain usable but are never assigned an invented date.
  const dates = [...new Set(parsed.map((p) => p.date))].sort((a, b) => (a ?? '').localeCompare(b ?? ''))
  const requested = Number.isFinite(days) ? Math.min(5, Math.max(1, Math.floor(days))) : 1
  const selectedDates = dates.slice(-Math.max(requested, 1))
  // 只画真正有数据的交易日；请求 5 日但源只给了 3 日时，不补两个空面板。
  const count = selectedDates.length || requested
  const slots: IntradaySlot[] = []
  const dayModels: IntradayDay[] = []
  for (let day = 0; day < count; day++) {
    const date = selectedDates[day] ?? null
    const rows = day < selectedDates.length ? parsed.filter((p) => p.date === date) : []
    const ranges = sessions(kind, rows[0]?.minute)
    const start = slots.length
    const breaks: number[] = []
    for (let session = 0; session < ranges.length; session++) {
      const [from, to] = ranges[session]!
      if (session > 0) breaks.push(slots.length)
      for (let minute = from; minute <= to; minute++) {
        const actualDate = date && minute >= 1440 ? shiftDate(date, 1) : date
        slots.push({
          index: slots.length, day, session, minute,
          time: `${actualDate ? `${actualDate} ` : ''}${hhmm(minute)}`,
          price: null, avgPrice: null, volume: null, present: false, direction: 'flat',
        })
      }
    }
    const daySlots = slots.slice(start)
    const byMinute = new Map(daySlots.map((slot) => [slot.minute, slot]))
    for (const row of rows) {
      const minute = kind === 'us' && row.minute < 720 ? row.minute + 1440 : row.minute
      const slot = byMinute.get(minute)
      if (!slot) continue // Outside the stated regular trading session.
      slot.present = true
      slot.price = validPrice(row.point.price) ? row.point.price : null
      slot.avgPrice = validPrice(row.point.avgPrice) ? row.point.avgPrice : null
      slot.volume = validVolume(row.point.volume) ? row.point.volume : null
    }
    dayModels.push({ date, start, end: slots.length - 1, breaks })
  }
  const hasPreClose = validPrice(preClose)
  const priced = slots.filter((slot) => slot.price !== null)
  const base = hasPreClose ? preClose : priced[0]?.price ?? null
  const center = base ?? 1
  let radius = Math.max(center * 0.002, 0.01)
  let maxVolume = 0
  for (const slot of slots) {
    if (slot.price !== null) radius = Math.max(radius, Math.abs(slot.price - center))
    if (slot.avgPrice !== null) radius = Math.max(radius, Math.abs(slot.avgPrice - center))
    maxVolume = Math.max(maxVolume, slot.volume ?? 0)
    const prev = slots[slot.index - 1]
    // Unknown preceding minute => neutral. Do not compare to the final tick or bridge a gap/day.
    const reference = prev && prev.day === slot.day && prev.session === slot.session && prev.minute === slot.minute - 1
      ? prev.price : slot.index === 0 && hasPreClose ? preClose : null
    slot.direction = slot.price !== null && reference !== null ? slot.price > reference ? 'up' : slot.price < reference ? 'down' : 'flat' : 'flat'
  }
  radius *= 1.12
  return {
    slots, days: dayModels, priceSegments: intradaySegments(slots, 'price'), avgSegments: intradaySegments(slots, 'avgPrice'),
    base, hasPreClose, min: center - radius, max: center + radius, maxVolume: Math.max(1, maxVolume), validPrices: priced.length, last: priced.at(-1) ?? null,
  }
}
/** Full-session position; invariant under adding new observations. */
export function intradayX(index: number, slotCount: number, left: number, width: number): number {
  return left + (slotCount <= 1 ? 0 : index / (slotCount - 1)) * width
}
/** Snap to the exact minute slot including whitespace, never pretend a missing minute traded. */
export function intradaySlotAt(ratio: number, slotCount: number): number {
  return Math.max(0, Math.min(slotCount - 1, Math.round((Number.isFinite(ratio) ? ratio : 0) * (slotCount - 1))))
}
