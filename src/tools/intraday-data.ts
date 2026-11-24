import type { IntradayPoint, IntradaySeries } from '../data/intraday.js'
import type { ProviderCallResult } from '../types.js'

/** Presentation only: no provider calls, aggregation, persistence or clock-derived market dates. */
export const INTRADAY_TOOL_LIMITS = { defaultLimit: 240, maxLimit: 1000 } as const
export const INTRADAY_TOOL_KINDS = ['a', 'hk', 'us', 'global'] as const
export type IntradayToolKind = typeof INTRADAY_TOOL_KINDS[number]
export interface IntradayToolRequest {
  code: string
  kind: IntradayToolKind
  days: 1 | 5
  secid?: string
  limit: number
  /** Omitted means latest window; an explicit 0 starts at the oldest point. */
  offset?: number
}

export function parseIntradayToolRequest(args: Record<string, unknown>): IntradayToolRequest {
  for (const key of ['code', 'secid'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw new Error(`${key} 必须为字符串`)
  }
  const code = (args.code as string | undefined)?.trim() ?? ''
  const secid = (args.secid as string | undefined)?.trim()
  if (args.secid !== undefined && !secid) throw new Error('secid 不能为空')
  if (!code && !secid) throw new Error('需要 code 或 secid')
  if (code.length > 80) throw new Error('code 过长')
  if (secid && !/^\d{1,3}\.[A-Za-z0-9._-]{1,24}$/.test(secid)) throw new Error('secid 格式应为市场.代码，如 100.SPX / 101.GC00Y / 105.NVDA')
  const kind = args.kind === undefined ? 'a' : args.kind
  if (!INTRADAY_TOOL_KINDS.includes(kind as IntradayToolKind)) throw new Error('kind 只能为 a / hk / us / global')
  const days = args.days === undefined ? 1 : args.days
  if (days !== 1 && days !== 5) throw new Error('days 只能为数字 1 或 5')
  const limit = args.limit === undefined ? INTRADAY_TOOL_LIMITS.defaultLimit : args.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > INTRADAY_TOOL_LIMITS.maxLimit) throw new Error('limit 必须为 1–1000 的整数')
  const offset = args.offset
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) throw new Error('offset 必须为非负安全整数')
  return { code, kind: kind as IntradayToolKind, days, ...(secid ? { secid } : {}), limit, ...(offset !== undefined ? { offset: offset as number } : {}) }
}

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const clip = (value: unknown, max = 1000): string | null => typeof value === 'string' ? value.slice(0, max) : null
function pointTime(point: IntradayPoint): number {
  const iso = point.at === null ? NaN : Date.parse(point.at)
  // Unknown-zone global series keep at=null. This wall-clock key is only for
  // ordering observed source labels, NOT a timezone conversion or a filled at.
  const wallText = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(point.time)
    ? point.time.replace(' ', 'T') + (point.time.length === 16 ? ':00' : '') : ''
  const wall = wallText ? Date.parse(`${wallText}Z`) : NaN
  const validWall = Number.isFinite(wall) && new Date(wall).toISOString().slice(0, 19) === wallText
  return Number.isFinite(iso) ? iso : validWall ? wall : NaN
}

export function intradayToolFailure(result: Partial<ProviderCallResult<IntradaySeries>>, request: IntradayToolRequest, error?: string, count: number | null = null) {
  const attempts = result.attempts ?? []
  return {
    ok: false, capability: 'intraday', provider: clip(result.provider, 120),
    request: { code: request.code, kind: request.kind, days: request.days, ...(request.secid ? { secid: request.secid } : {}) },
    error: clip(error ?? result.error ?? '分时数据不可用'), count,
    attempts: attempts.slice(0, 8).map((item) => ({ provider: clip(item.provider, 120), error: clip(item.error) })),
    attemptsTruncated: attempts.length > 8,
  }
}

/** Unwrap ProviderCallResult.data once and paginate the actual points, not the wrapper. */
export function intradayToolResult(result: ProviderCallResult<IntradaySeries>, request: IntradayToolRequest) {
  if (!result.ok) return intradayToolFailure(result, request)
  const series = result.data
  if (!series || !Array.isArray(series.points)) return intradayToolFailure(result, request, '分时响应缺少有效 data.points')
  if (!series.points.length) return intradayToolFailure(result, request, '分时源返回空序列，不能确认行情覆盖', 0)
  if (typeof series.code !== 'string' || !series.code.trim() || typeof series.source !== 'string' || !series.source.trim()
    || !INTRADAY_TOOL_KINDS.includes(series.kind as IntradayToolKind)) return intradayToolFailure(result, request, '分时响应缺少可验证的代码/市场/来源')
  if (series.points.some((point) => !point || typeof point.time !== 'string' || !Number.isFinite(pointTime(point)))) {
    return intradayToolFailure(result, request, '分时响应含无法排序的日期时间，未返回不完整行情')
  }
  // Sort a new array; never mutate the registry's cached series or point objects.
  const ordered = [...series.points].sort((a, b) => pointTime(a) - pointTime(b))
  const count = ordered.length
  const offset = request.offset ?? Math.max(0, count - request.limit)
  const selected = ordered.slice(offset, offset + request.limit)
  const points = selected.map((point) => ({
    time: point.time, at: point.at ?? null,
    price: finite(point.price), avgPrice: finite(point.avgPrice), volume: finite(point.volume), amount: finite(point.amount),
  }))
  const omittedBefore = Math.min(offset, count)
  const omittedAfter = Math.max(0, count - offset - points.length)
  const nextOffset = omittedAfter > 0 ? offset + points.length : null
  const previousOffset = offset > 0 && count > 0 ? Math.max(0, Math.min(offset, count) - request.limit) : null
  const first = ordered[0]!, last = ordered[count - 1]!
  const pageFirst = points[0], pageLast = points[points.length - 1]
  const missingFields = {
    preClose: series.preClose == null || !Number.isFinite(series.preClose),
    // Counts refer to the returned page, not the omitted portion of the series.
    at: points.filter((p) => p.at === null).length,
    price: points.filter((p) => p.price === null).length,
    avgPrice: points.filter((p) => p.avgPrice === null).length,
    volume: points.filter((p) => p.volume === null).length,
    amount: points.filter((p) => p.amount === null).length,
  }
  return {
    ok: true, capability: 'intraday', provider: clip(result.provider, 120),
    code: series.code, name: series.name ?? null, kind: series.kind, days: series.days, requestedDays: request.days,
    secid: series.secid ?? request.secid ?? null,
    source: series.source, at: series.at ?? null, preClose: finite(series.preClose),
    timezone: {
      time: series.timezone ?? 'unknown', at: 'ISO-8601 instant when verified; otherwise null',
      note: series.timezone === 'Asia/Shanghai'
        ? '源已验证 time 为北京时间（美股也不等于交易所当地时间）；point.at 是同一行情时刻的 ISO 表示；顶层 at 为抓取时刻。'
        : '源未验证 time 的时区，保留原文；at=null 不推算为北京时间或交易所时间。仅按已观测标签排序，不推断交易时段；顶层 at 为抓取时刻。',
    },
    units: {
      price: '源口径，币种/指数点值由品种决定', avgPrice: '源口径均价，可能缺失',
      volume: series.volumeUnit ?? 'source', amount: series.amountUnit ?? 'source',
      note: 'volume/amount 为分钟量额；source 表示单位未核实，不默认当股数/本币，不跨源直接比较。',
    },
    warnings: (series.warnings ?? []).slice(0, 20).map((warning) => clip(warning)),
    warningsTruncated: (series.warnings?.length ?? 0) > 20 || (series.warnings ?? []).some((warning) => warning.length > 1000),
    firstDataTime: first.time, lastDataTime: last.time, firstDataAt: first.at ?? null, lastDataAt: last.at ?? null,
    returnedFirstTime: pageFirst?.time ?? null, returnedLastTime: pageLast?.time ?? null,
    count, returnedCount: points.length, offset, limit: request.limit,
    order: 'ascending', selection: request.offset === undefined ? 'latest' : 'offset',
    truncated: points.length < count, omittedBefore, omittedAfter, nextOffset, previousOffset,
    followUp: points.length < count ? {
      tool: 'get_intraday_data',
      args: { code: request.code, kind: request.kind, days: request.days, ...(request.secid ? { secid: request.secid } : {}), offset: nextOffset ?? 0, limit: request.limit },
      note: 'offset 为全序列升序的零基位置；默认尾页若有更早数据，从 offset=0 正向翻页。每次重新取源数据，盘中分页不保证固定快照。',
    } : null,
    missingFields, points,
    note: 'count 仅为本次源返回的完整点数，不保证所请求交易日全部覆盖；truncated 仅描述工具分页。缺失保持 null，真实 0 保留，不插值、不补造交易分钟。',
  }
}
