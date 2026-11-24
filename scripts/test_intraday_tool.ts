/** Offline tool/formatter contracts only. No network, provider config, private data or file writes. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { IntradayPoint, IntradaySeries } from '../src/data/intraday.js'
import type { ProviderCallResult } from '../src/types.js'
import { INTRADAY_TOOL_LIMITS, intradayToolResult, parseIntradayToolRequest } from '../src/tools/intraday-data.js'
import { registerTools } from '../src/tools/register.js'

type Tool = {
  name: string
  description: string
  parameters: { properties: Record<string, { enum?: unknown[]; description?: string }>; required?: string[] }
  execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<any>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
}
let checks = 0
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`) }
const checkAsync = async (name: string, run: () => Promise<void>) => { await run(); checks++; console.log(`PASS ${name}`) }
function point(index: number): IntradayPoint {
  const at = new Date(Date.UTC(2026, 10, 23, 1, 30 + index)).toISOString()
  const time = new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
  return { time, at, price: index, avgPrice: index + 0.25, volume: index * 100, amount: index * 1000 }
}
function series(count = 500, extra: Partial<IntradaySeries> = {}): IntradaySeries {
  return {
    code: '600519', name: '离线夹具', kind: 'a', days: 1, preClose: 123.45,
    points: Array.from({ length: count }, (_, index) => point(index)), source: 'fixture-minute', at: '2026-11-24T02:05:00.000Z',
    timezone: 'Asia/Shanghai', secid: '1.600519', volumeUnit: 'source', amountUnit: 'source', warnings: ['离线夹具，不是线上核验'], ...extra,
  }
}
const success = (data = series()): ProviderCallResult<IntradaySeries> => ({ ok: true, capability: 'intraday', provider: 'fixture-provider', data })
function formatted(data = series(), args: Record<string, unknown> = { code: '600519' }) {
  const result = intradayToolResult(success(data), parseIntradayToolRequest(args))
  assert.equal(result.ok, true)
  return result as Extract<typeof result, { points: unknown[] }>
}
const tools: Record<string, Tool> = {}
const calls: unknown[][] = []
let response = success()
let getIntraday: (...args: unknown[]) => Promise<ProviderCallResult<IntradaySeries>> = async (...args) => { calls.push(args); return response }
registerTools({ tools: { register: (tool: Tool) => { assert.equal(tools[tool.name], undefined, `duplicate ${tool.name}`); tools[tool.name] = tool } } } as never,
  { getIntraday: (...args: unknown[]) => getIntraday(...args) } as never, {} as never, {} as never, {} as never)
const tool = tools.get_intraday_data!
assert.ok(tool)
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('network forbidden in intraday tool tests') }
try {
  check('main registration exposes unified tool, kinds and bounded parameter documentation', () => {
    assert.deepEqual(Object.keys(tool.parameters.properties), ['code', 'kind', 'secid', 'days', 'offset', 'limit'])
    assert.deepEqual(tool.parameters.properties.kind!.enum, ['a', 'hk', 'us', 'global'])
    assert.deepEqual(tool.parameters.properties.days!.enum, [1, 5])
    assert.equal(tool.parameters.required?.includes('code') ?? false, false)
    assert.match(tool.parameters.properties.limit!.description!, /1000.*240/)
    assert.match(tool.parameters.properties.offset!.description!, /nextOffset/)
    assert.match(tool.description, /来源.*时区.*总数.*分页/)
  })
  check('pure parser independently enforces strict defaults, types, ranges and identifier pairing', () => {
    assert.deepEqual(parseIntradayToolRequest({ code: ' x ' }), { code: 'x', kind: 'a', days: 1, limit: 240 })
    assert.deepEqual(parseIntradayToolRequest({ secid: ' 100.SPX ', kind: 'global', days: 5, offset: 0, limit: 1000 }), { code: '', kind: 'global', days: 5, secid: '100.SPX', offset: 0, limit: 1000 })
    for (const args of [{}, { code: 'x', kind: null }, { code: 'x', days: '1' }, { code: 'x', limit: 1001 }, { code: 'x', offset: -1 }]) assert.throws(() => parseIntradayToolRequest(args))
  })
  await checkAsync('registered call unwraps provider/data and forwards all five service arguments', async () => {
    const signal = new AbortController().signal
    const result = await tool.execute({ code: ' 600519 ' }, { signal })
    assert.deepEqual(calls.at(-1), ['600519', 'a', 1, signal, undefined])
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'fixture-provider')
    assert.equal(result.source, 'fixture-minute')
    assert.equal(result.count, 500)
    assert.equal(result.returnedCount, 240)
    assert.equal(result.points.length, 240)
    assert.equal(Object.hasOwn(result, 'data'), false, 'no wrapper or duplicate full series leaks')
    const rendered = tool.output.render({}, result)
    assert.deepEqual(JSON.parse(rendered[0]!.text), result)
  })
  check('default returns latest 240 ascending with truthful omitted ranges and older-data retrieval', () => {
    const result = formatted()
    assert.equal(result.selection, 'latest')
    assert.equal(result.order, 'ascending')
    assert.equal(result.offset, 260)
    assert.equal(result.points[0]!.price, 260)
    assert.equal(result.points.at(-1)!.price, 499)
    assert.equal(result.truncated, true)
    assert.equal(result.omittedBefore, 260)
    assert.equal(result.omittedAfter, 0)
    assert.equal(result.nextOffset, null)
    assert.equal(result.previousOffset, 20)
    assert.equal(result.followUp!.args.offset, 0)
    assert.equal(result.followUp!.tool, 'get_intraday_data')
    assert.equal(result.firstDataTime, point(0).time)
    assert.equal(result.lastDataTime, point(499).time)
    assert.equal(result.firstDataAt, point(0).at)
    assert.equal(result.returnedFirstTime, point(260).time)
    assert.notEqual(result.at, result.lastDataAt, 'fetch time is not presented as data time')
  })
  check('offset zero returns oldest points and nextOffset walks complete ascending series', () => {
    const input = series(532)
    const collected: number[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const result = formatted(input, { code: input.code, limit: 200, offset })
      collected.push(...result.points.map((p) => p.price!))
      assert.equal(result.selection, 'offset')
      assert.equal(result.count, 532)
      assert.equal(result.omittedBefore + result.returnedCount + result.omittedAfter, 532)
      offset = result.nextOffset
    }
    assert.deepEqual(collected, Array.from({ length: 532 }, (_, i) => i))
  })
  check('upper bound returns 1000 points and never serializes the unbounded source', () => {
    const result = formatted(series(1505), { code: '600519', limit: 1000, offset: 0 })
    assert.equal(result.count, 1505)
    assert.equal(result.returnedCount, INTRADAY_TOOL_LIMITS.maxLimit)
    assert.equal(result.nextOffset, 1000)
    assert.equal(result.omittedAfter, 505)
    assert.ok(JSON.stringify(result).length < 200_000)
  })
  check('short and exact-size series are not truncated; source points are copied independently', () => {
    for (const count of [1, 239, 240]) {
      const input = series(count)
      const before = JSON.stringify(input)
      const result = formatted(input)
      assert.equal(result.count, count)
      assert.equal(result.truncated, false)
      assert.equal(result.offset, 0)
      assert.equal(result.nextOffset, null)
      assert.equal(result.previousOffset, null)
      assert.equal(result.followUp, null)
      result.points[0]!.price = 99999
      assert.equal(JSON.stringify(input), before)
    }
  })
  check('unsorted provider points are sorted without mutating cached source', () => {
    const input = series(15)
    input.points.reverse()
    const before = JSON.stringify(input)
    const result = formatted(input, { code: '600519', offset: 0, limit: 7 })
    assert.deepEqual(result.points.map((p) => p.price), [0, 1, 2, 3, 4, 5, 6])
    assert.equal(result.firstDataTime, point(0).time)
    assert.equal(result.lastDataTime, point(14).time)
    assert.equal(JSON.stringify(input), before)
  })
  check('offset at/beyond end returns empty page, not fake source emptiness or clamped range', () => {
    for (const offset of [500, 999, Number.MAX_SAFE_INTEGER]) {
      const result = formatted(series(), { code: '600519', offset })
      assert.equal(result.ok, true)
      assert.equal(result.offset, offset)
      assert.equal(result.count, 500)
      assert.equal(result.returnedCount, 0)
      assert.equal(result.truncated, true)
      assert.equal(result.nextOffset, null)
      assert.equal(result.omittedBefore, 500)
      assert.equal(result.omittedAfter, 0)
      assert.equal(result.returnedFirstTime, null)
      assert.equal(result.previousOffset, 260)
    }
  })
  await checkAsync('all market kinds reach service; days=5 is preserved, not rounded or coerced', async () => {
    for (const kind of ['a', 'hk', 'us', 'global']) {
      await tool.execute({ code: 'fixture', kind, days: 5, offset: 0, limit: 2 }, {})
      assert.deepEqual(calls.at(-1), ['fixture', kind, 5, undefined, undefined])
    }
  })
  await checkAsync('secid-only and conflicting code use service-resolved identity, secid has priority', async () => {
    for (const secid of ['100.SPX', '101.GC00Y', '105.NVDA', '106.BRK.B']) {
      const code = secid.slice(secid.indexOf('.') + 1)
      response = success(series(1, { code, kind: 'global', secid, timezone: 'unknown', points: [{ ...point(0), at: null }] }))
      const result = await tool.execute({ kind: 'global', secid }, {})
      assert.deepEqual(calls.at(-1), ['', 'global', 1, undefined, secid])
      assert.equal(result.code, code)
      assert.equal(result.secid, secid)
      assert.equal(result.kind, 'global')
      const conflict = await tool.execute({ code: 'IGNORED', secid }, {})
      assert.deepEqual(calls.at(-1), ['IGNORED', 'a', 1, undefined, secid])
      assert.equal(conflict.code, code)
      assert.equal(conflict.kind, 'global')
    }
    response = success()
  })
  check('actual source days and requested days remain distinct, never relabel one-day coverage as five', () => {
    const result = formatted(series(2, { days: 1 }), { code: '600519', days: 5 })
    assert.equal(result.days, 1)
    assert.equal(result.requestedDays, 5)
  })
  check('unknown global timezone keeps original wall labels and null instants, no conversion', () => {
    const input = series(3, { kind: 'global', code: 'GC00Y', secid: '101.GC00Y', timezone: 'unknown', points: [point(2), point(0), point(1)].map((p) => ({ ...p, at: null })) })
    const result = formatted(input, { secid: '101.GC00Y', kind: 'global', offset: 0 })
    assert.equal(result.timezone.time, 'unknown')
    assert.match(result.timezone.note, /不推算.*不推断交易时段/)
    assert.deepEqual(result.points.map((p) => p.time), [point(0).time, point(1).time, point(2).time])
    assert.ok(result.points.every((p) => p.at === null))
    assert.equal(result.firstDataAt, null)
    assert.equal(result.lastDataAt, null)
    assert.equal(result.missingFields.at, 3)
  })
  check('verified metadata and source units survive, legacy absence stays unknown', () => {
    const result = formatted(series(1, { timezone: 'Asia/Shanghai', volumeUnit: 'lots', amountUnit: 'CNY' }))
    assert.equal(result.timezone.time, 'Asia/Shanghai')
    assert.equal(result.units.volume, 'lots')
    assert.equal(result.units.amount, 'CNY')
    assert.deepEqual(result.warnings, ['离线夹具，不是线上核验'])
    const legacy = series(1)
    delete legacy.timezone; delete legacy.volumeUnit; delete legacy.amountUnit; delete legacy.secid; delete legacy.warnings
    const old = formatted(legacy)
    assert.equal(old.timezone.time, 'unknown')
    assert.equal(old.units.volume, 'source')
    assert.equal(old.units.amount, 'source')
    assert.equal(old.secid, null)
  })
  check('true zeros remain zero; missing, undefined and nonfinite numbers stay null', () => {
    const input = series(2, { preClose: null, points: [
      { ...point(0), price: 0, avgPrice: 0, volume: 0, amount: 0 },
      { ...point(1), price: null, avgPrice: NaN, volume: undefined, amount: Infinity } as unknown as IntradayPoint,
    ] })
    const result = formatted(input)
    assert.deepEqual(result.points[0], { ...point(0), price: 0, avgPrice: 0, volume: 0, amount: 0 })
    assert.deepEqual(result.points[1], { ...point(1), price: null, avgPrice: null, volume: null, amount: null })
    assert.deepEqual(result.missingFields, { preClose: true, at: 0, price: 1, avgPrice: 1, volume: 1, amount: 1 })
    assert.equal(result.preClose, null)
  })
  check('warnings and errors are bounded with visible warning truncation', () => {
    const result = formatted(series(1, { warnings: Array.from({ length: 30 }, () => 'x'.repeat(3000)) }))
    assert.equal(result.warnings.length, 20)
    assert.equal(result.warningsTruncated, true)
    assert.ok(result.warnings.every((warning) => warning!.length === 1000))
    assert.equal(formatted(series(1, { warnings: ['x'.repeat(1001)] })).warningsTruncated, true, 'text truncation is visible even with fewer than 20 warnings')
  })
  await checkAsync('invalid days/kinds/identifiers/pagination fail before service, no silent rounding', async () => {
    const invalid = [
      ...[0, 2, 3, 4, 6, -1, 1.5, NaN, Infinity, '1', null, true].map((days) => ({ code: 'x', days })),
      ...['fund', '', 'GLOBAL', null, 1].map((kind) => ({ code: 'x', kind })),
      ...[0, -1, 1001, 1.5, NaN, Infinity, '240', null].map((limit) => ({ code: 'x', limit })),
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null].map((offset) => ({ code: 'x', offset })),
      {}, { code: '' }, { code: 1 }, { secid: 1 }, { secid: '' }, { secid: '100' }, { secid: '101.GC00Y?x=1' }, { code: 'x'.repeat(81) },
    ]
    const before = calls.length
    for (const args of invalid) {
      let result: any
      try { result = await tool.execute(args, {}) }
      catch (error) {
        // defineTool checks schema enum/types before our cross-field/range validation.
        assert.equal((error as { code?: string }).code, 'INVALID_ARGS', JSON.stringify(args))
        continue
      }
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.equal(result.errorType, 'invalid_arguments')
    }
    assert.equal(calls.length, before)
  })
  await checkAsync('provider failure preserves provider/errors/attempts, unknown count is not fake zero', async () => {
    response = { ok: false, capability: 'intraday', provider: 'fixture-broken', error: 'fixture unavailable', attempts: Array.from({ length: 12 }, (_, i) => ({ provider: `p${i}`, error: 'failed' })) }
    const result = await tool.execute({ code: 'x' }, {})
    assert.equal(result.ok, false)
    assert.equal(result.provider, 'fixture-broken')
    assert.equal(result.error, 'fixture unavailable')
    assert.equal(result.count, null)
    assert.equal(Object.hasOwn(result, 'points'), false)
    assert.equal(Object.hasOwn(result, 'firstDataTime'), false)
    assert.equal(result.attempts.length, 8)
    assert.equal(result.attemptsTruncated, true)
  })
  await checkAsync('missing/malformed successful wrapper is failure, known empty series reports zero explicitly', async () => {
    for (const data of [undefined, null, [], { points: null }, { points: [point(0)] }]) {
      response = { ok: true, capability: 'intraday', data: data as never }
      const result = await tool.execute({ code: 'x' }, {})
      assert.equal(result.ok, false)
      assert.equal(result.count, null)
      assert.equal(Object.hasOwn(result, 'points'), false)
    }
    response = success(series(0))
    const empty = await tool.execute({ code: 'x' }, {})
    assert.equal(empty.ok, false)
    assert.equal(empty.count, 0)
    assert.match(empty.error, /空序列/)
    response = success()
  })
  check('unorderable source timestamps fail explicitly instead of dropping points silently', () => {
    for (const time of ['not-a-date', '2026-02-30 12:00', '2026-11-23 25:00']) {
      const result = intradayToolResult(success(series(1, { points: [{ ...point(0), at: null, time }] })), parseIntradayToolRequest({ code: 'x' }))
      assert.equal(result.ok, false)
      assert.match('error' in result ? result.error! : '', /无法排序/)
    }
  })
  await checkAsync('thrown provider errors become bounded failures; abort before/during request stays cancellation', async () => {
    getIntraday = async () => { throw new Error('fixture thrown ' + 'x'.repeat(2000)) }
    const failure = await tool.execute({ code: 'x' }, {})
    assert.equal(failure.ok, false)
    assert.ok(failure.error.length <= 1000)
    assert.equal(failure.count, null)
    const before = new AbortController()
    before.abort(new Error('cancel-before'))
    await assert.rejects(tool.execute({ code: 'x' }, { signal: before.signal }), /cancel-before/)
    const during = new AbortController()
    getIntraday = async () => { during.abort(new Error('cancel-during')); return success() }
    await assert.rejects(tool.execute({ code: 'x' }, { signal: during.signal }), /cancel-during/)
  })
  const [main, module, formatter, docs] = await Promise.all([
    readFile(new URL('../src/tools/register.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/intraday.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/intraday-data.ts', import.meta.url), 'utf8'),
    readFile(new URL('../docs/agent-intraday.md', import.meta.url), 'utf8'),
  ])
  check('static wiring reuses unified service and pure formatter; docs publish pagination and limits', () => {
    assert.match(main, /registerIntradayTools\(ctx, finance\)/)
    assert.match(module, /finance\.getIntraday\(request\.code, request\.kind, request\.days, exec\.signal, request\.secid\)/)
    assert.doesNotMatch(module + formatter, /\bfetch\s*\(|httpGet|readFile\(|writeFile\(|Date\.now\(/)
    for (const text of ['get_intraday_data', '240', '1000', 'nextOffset', 'count', 'truncated', 'unknown', '100.SPX', '101.GC00Y']) assert.ok(docs.includes(text), text)
  })
} finally { globalThis.fetch = originalFetch }
console.log(`\n${checks} intraday tool checks passed (offline fixtures only; no live provider verification).`)
