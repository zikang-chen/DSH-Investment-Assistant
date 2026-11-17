/**
 * 历史库身份隔离测试（task-8）。
 *
 * 同一 code 的 a / fund 两种 kind 必须各回自己的序列；不带 kind 的歧义请求
 * 绝不能按 updatedAt 猜最新一份；manifest 必须绑定请求的 kind；单一身份与
 * legacy code-only 文件保持兼容；损坏文件必须明确报错而不是当空。
 *
 * 直接脚本风格（参考 scripts/test_regressions.ts），只用 tmpdir 下的真实文件
 * 系统，不读 data/history、不联网、不写仓库内数据。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HistoryStore, type MarketEvent, type SymbolHistory } from '../src/history/store.js'
import { registerHistoryTools } from '../src/history/tools.js'
import type { KlineBar } from '../src/types.js'

const root = await mkdtemp(path.join(tmpdir(), 'finance-history-identity-'))
let checks = 0

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await fn()
  checks++
  console.log(`PASS ${checks}. ${name}`)
}

function bar(date: string, close: number): KlineBar {
  return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
}

/** 与 store 的 contentHashOf 同口径：只对 kline + events 的规范 JSON 取 sha256 前 32 位。 */
function contentHashOf(raw: string): string {
  const parsed = JSON.parse(raw) as Pick<SymbolHistory, 'kline' | 'events'>
  return createHash('sha256')
    .update(JSON.stringify({ kline: parsed.kline, events: parsed.events }))
    .digest('hex')
    .slice(0, 32)
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function rewriteUpdatedAt(file: string, updatedAt: string): Promise<void> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  parsed.updatedAt = updatedAt
  await writeFile(file, JSON.stringify(parsed, null, 2) + '\n')
}

/** 断言 Promise 必须失败，并把失败原因取回来检查；成功返回则直接判红。 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('预期拒绝，但调用成功返回') },
    (err: unknown) => err instanceof Error ? err : new Error(String(err)),
  )
}

try {
  // 1) 同一 code 的 a 与 fund 两个 kind 文件写入不同 bars，各读各的，绝不串。
  await check('同一 code 的 a / fund 各回自己的 bars，绝不串序列', async () => {
    const dir = path.join(root, 'by-kind')
    const store = new HistoryStore(dir)
    await store.mergeKline('000001', 'a', [bar('2026-11-09', 10), bar('2026-11-10', 11)], { provider: 'test-a' })
    await store.mergeKline('000001', 'fund', [bar('2026-11-09', 2), bar('2026-11-10', 2.1), bar('2026-11-11', 2.2)], { provider: 'test-fund' })

    const a = await store.read('000001', 'a')
    const fund = await store.read('000001', 'fund')
    assert.ok(a)
    assert.ok(fund)
    assert.equal(a.kind, 'a')
    assert.equal(fund.kind, 'fund')
    assert.deepEqual(a.kline.map(b => b.close), [10, 11])
    assert.deepEqual(fund.kline.map(b => b.close), [2, 2.1, 2.2])
    assert.deepEqual(a.kline.map(b => b.date), ['2026-11-09', '2026-11-10'])
    assert.deepEqual(fund.kline.map(b => b.date), ['2026-11-09', '2026-11-10', '2026-11-11'])
    // 文件键同样是 code + kind：同 code 两个文件互不覆盖，也没有残留 tmp
    assert.deepEqual(await entries(dir), ['000001-a-day.json', '000001-fund-day.json'])
  })

  // 2) 不带 kind 且两 kind 都存在：抛歧义错误，不能按 updatedAt 选最新。
  await check('不带 kind 且两个身份并存：报“多个 kind / 请显式传入 kind”，不按 updatedAt 选最新', async () => {
    const dir = path.join(root, 'ambiguous')
    const store = new HistoryStore(dir)
    await store.mergeKline('600519', 'a', [bar('2026-11-10', 100)])
    await store.mergeKline('600519', 'fund', [bar('2026-11-10', 5)])
    // 刻意把 fund 改成更新的时间戳：若实现按 updatedAt 排序，就会错误地返回 fund。
    await rewriteUpdatedAt(path.join(dir, '600519-a-day.json'), '2026-01-01T00:00:00.000Z')
    await rewriteUpdatedAt(path.join(dir, '600519-fund-day.json'), '2026-12-31T00:00:00.000Z')

    const err = await rejection(store.read('600519'))
    assert.match(err.message, /多个 kind/)
    assert.match(err.message, /请显式传入 kind/)
    assert.match(err.message, /a、fund/)
    // manifest 走同一条身份判定，也必须拒绝而不是挑一份。
    const manifestErr = await rejection(store.manifest('600519'))
    assert.match(manifestErr.message, /多个 kind/)
    // 显式 kind 仍能精确读取，说明拒绝的是“猜”，不是数据不可读。
    assert.equal((await store.read('600519', 'fund'))?.kind, 'fund')
  })

  // 3) manifest(code, kind) 的 kind / 覆盖范围 / 内容 hash 必须来自请求的那条序列。
  await check('manifest(code, kind) 返回对应序列的 kind / 覆盖 / 内容哈希', async () => {
    const dir = path.join(root, 'manifest')
    const store = new HistoryStore(dir)
    await store.mergeKline('000001', 'a', [bar('2026-11-09', 10), bar('2026-11-11', 11)])
    await store.mergeKline('000001', 'fund', [bar('2026-10-30', 1.5), bar('2026-11-02', 1.6), bar('2026-11-03', 1.7)])
    const aEvent: MarketEvent = { date: '2026-11-11', type: '分红', label: '每股派 0.5', value: 0.5 }
    const fundEvent: MarketEvent = { date: '2026-11-03', type: '分红', label: '每份派 0.01', value: 0.01 }
    await store.mergeEvents('000001', 'a', [aEvent])
    await store.mergeEvents('000001', 'fund', [fundEvent])

    const a = await store.manifest('000001', 'a')
    const fund = await store.manifest('000001', 'fund')
    assert.ok(a)
    assert.ok(fund)
    assert.equal(a.kind, 'a')
    assert.equal(fund.kind, 'fund')
    assert.deepEqual(a.coverage, { from: '2026-11-09', to: '2026-11-11' })
    assert.deepEqual(fund.coverage, { from: '2026-10-30', to: '2026-11-03' })
    assert.equal(a.bars, 2)
    assert.equal(fund.bars, 3)
    assert.equal(a.events, 1)
    assert.equal(fund.events, 1)
    // 独立复算磁盘文件的规范 hash：manifest 的哈希必须对应同 kind 文件。
    assert.equal(a.contentHash, contentHashOf(await readFile(path.join(dir, '000001-a-day.json'), 'utf8')))
    assert.equal(fund.contentHash, contentHashOf(await readFile(path.join(dir, '000001-fund-day.json'), 'utf8')))
    assert.notEqual(a.contentHash, fund.contentHash)
  })

  // 4) 只有一种 kind 时不带 kind 仍可读（兼容旧调用）。
  await check('仅单一 kind（股票 a）时不带 kind 仍可读（兼容）', async () => {
    const store = new HistoryStore(path.join(root, 'single-kind'))
    await store.mergeKline('601398', 'a', [bar('2026-11-09', 6), bar('2026-11-10', 6.1)])
    const h = await store.read('601398')
    assert.ok(h)
    // 本地库里股票的身份标识是 a（SymbolKind: a/hk/us/fund），这里即“只有股票一种身份”。
    assert.equal(h.kind, 'a')
    assert.deepEqual(h.kline.map(b => b.close), [6, 6.1])
    assert.equal((await store.manifest('601398'))?.kind, 'a')
  })

  // 5) legacy code-only 文件：仅元数据 kind 匹配时读取；不匹配 null / 缺 kind 明确报错；不写不迁移。
  await check('legacy code-only 文件按元数据 kind 匹配读取，不匹配 null / 缺 kind 报错，不写不迁移', async () => {
    const dir = path.join(root, 'legacy')
    await mkdir(dir, { recursive: true })
    const legacyFile = path.join(dir, 'LEGACY.json')
    const legacyRaw = JSON.stringify({
      code: 'LEGACY',
      kind: 'a',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kline: [bar('2026-09-30', 3.3)],
      events: [{ date: '2026-09-30', type: '分红', label: '旧文件事件', value: 0.1 }],
    }, null, 2) + '\n'
    await writeFile(legacyFile, legacyRaw)

    const store = new HistoryStore(dir)
    const matched = await store.read('LEGACY', 'a')
    assert.ok(matched)
    assert.equal(matched.kind, 'a')
    assert.equal(matched.schemaVersion, 2) // 仅内存归一化，磁盘不迁移
    assert.equal(matched.adjustment, 'unknown') // 旧数据口径未知，不猜
    assert.deepEqual(matched.kline.map(b => b.close), [3.3])
    assert.equal(await store.read('LEGACY', 'fund'), null) // 元数据 kind 不匹配 → null
    assert.equal((await store.read('LEGACY'))?.kind, 'a') // 单身份时无 kind 仍可读

    // 读路径不得写入、迁移或改写 legacy 文件。
    assert.deepEqual(await entries(dir), ['LEGACY.json'])
    assert.equal(await readFile(legacyFile, 'utf8'), legacyRaw)

    // 旧文件连 kind 都没有：身份无法确认，必须明确报错，不能猜成任一 kind。
    const dirNoKind = path.join(root, 'legacy-no-kind')
    await mkdir(dirNoKind, { recursive: true })
    const unknownFile = path.join(dirNoKind, 'LEGACY2.json')
    const unknownRaw = JSON.stringify({
      code: 'LEGACY2',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kline: [bar('2026-09-30', 3.3)],
      events: [],
    }, null, 2) + '\n'
    await writeFile(unknownFile, unknownRaw)
    const storeNoKind = new HistoryStore(dirNoKind)
    for (const kind of ['a', undefined] as const) {
      const err = await rejection(storeNoKind.read('LEGACY2', kind))
      assert.match(err.message, /缺少有效 kind/)
      assert.match(err.message, /无法确认身份/)
    }
    assert.equal(await readFile(unknownFile, 'utf8'), unknownRaw)
    assert.deepEqual(await entries(dirNoKind), ['LEGACY2.json'])
  })

  // 6) 损坏文件仍然抛“损坏”，不能静默当空，也不能被合并覆盖。
  await check('损坏文件抛“损坏”而非当空，原字节不被改写', async () => {
    const dir = path.join(root, 'corrupt')
    await mkdir(dir, { recursive: true })
    const broken = path.join(dir, 'BAD-a-day.json')
    await writeFile(broken, '{bad json')
    const store = new HistoryStore(dir)
    const probes = [
      () => store.read('BAD', 'a'),
      () => store.read('BAD'),
      () => store.manifest('BAD', 'a'),
    ]
    for (const probe of probes) {
      const err = await rejection(probe())
      assert.match(err.message, /损坏/)
    }
    // 写入路径同样拒绝覆盖损坏文件。
    await rejection(store.mergeKline('BAD', 'a', [bar('2026-11-10', 10)]))
    assert.equal(await readFile(broken, 'utf8'), '{bad json')

    // 合法 JSON 但 schemaVersion=2 缺 kline/events 属于结构损坏，也必须报“损坏”。
    await writeFile(path.join(dir, 'BAD2-a-day.json'), JSON.stringify({ code: 'BAD2', kind: 'a', schemaVersion: 2, period: 'day' }))
    const err = await rejection(store.read('BAD2', 'a'))
    assert.match(err.message, /损坏/)
  })

  // 7) 工具层：get_history 必须把 kind 透传给 store，歧义时给出明确错误。
  await check('get_history 工具转发 kind：a / fund 各回自己的 bars，缺省多身份报明确错误', async () => {
    const store = new HistoryStore(path.join(root, 'tool-get-history'))
    await store.mergeKline('000001', 'a', [bar('2026-11-09', 10), bar('2026-11-10', 11)])
    await store.mergeKline('000001', 'fund', [bar('2026-11-09', 2), bar('2026-11-10', 2.1)])

    const registered = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>()
    const ctx = {
      tools: {
        register: (tool: { name: string }) => {
          registered.set(tool.name, tool as unknown as { execute: (args: Record<string, unknown>) => Promise<unknown> })
        },
      },
    }
    registerHistoryTools(ctx as never, {} as never, store, { publish: () => {} } as never)
    const getHistory = registered.get('get_history')
    assert.ok(getHistory, 'get_history 未注册')

    type HistoryToolResult = { ok: boolean; kind: string; bars: number; kline: KlineBar[] }
    const asResult = (value: unknown) => value as HistoryToolResult
    const a = asResult(await getHistory.execute({ code: '000001', kind: 'a' }))
    const fund = asResult(await getHistory.execute({ code: '000001', kind: 'fund' }))
    assert.equal(a.ok, true)
    assert.equal(fund.ok, true)
    assert.equal(a.kind, 'a')
    assert.equal(fund.kind, 'fund')
    assert.deepEqual(a.kline.map(b => b.close), [10, 11])
    assert.deepEqual(fund.kline.map(b => b.close), [2, 2.1])

    // 工具边界不能“自动挑一份”：没传 kind 时同样拒绝，并提示显式传入 kind。
    const err = await rejection(getHistory.execute({ code: '000001' }))
    assert.match(err.message, /多个 kind/)
    assert.match(err.message, /请显式传入 kind/)
  })

  console.log(`\n${checks} history identity checks passed`)
} finally {
  await rm(root, { recursive: true, force: true })
}
