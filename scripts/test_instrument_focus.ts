/**
 * 标的上下文（InstrumentFocus）离线测试。
 *
 * 目标：无论标的来自行情、档案还是外部命令，面板只维护「当前一只」，并且：
 * - 身份来自 chartInstrument，不在这一层按代码位数猜基金；
 * - 持久化失败（隐私模式/配额满）不影响使用；
 * - 存量脏数据不会被当作有效标的恢复。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  FOCUS_STORAGE_KEY, focusQuoteKey, focusTitle, loadFocus, normalizeFocus, saveFocus,
  type InstrumentFocus,
} from '../src/client/instrument-focus.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.get(key) ?? null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, value) }
}

await check('统一身份：股票/基金/港股/美股/A股', async () => {
  assert.deepEqual(
    { ...normalizeFocus({ code: ' 600519 ', type: 'stock' })!, at: 0 },
    { code: '600519', kind: 'a', at: 0 },
  )
  assert.equal(normalizeFocus({ code: '110022', type: 'fund' })!.kind, 'fund')
  assert.equal(normalizeFocus({ code: '00700', type: 'stock' })!.kind, 'hk')
  assert.equal(normalizeFocus({ code: 'AAPL', type: 'stock' })!.kind, 'us')
  assert.equal(normalizeFocus({ code: '510300', type: 'fund' })!.kind, 'a', '场内 ETF 走成交价身份')
})

await check('显式 secid 优先于代码形态，且保留原 secid', async () => {
  const global = normalizeFocus({ code: 'SPX', secid: '100.SPX' })!
  assert.equal(global.kind, 'global')
  assert.equal(global.secid, '100.SPX')
  const us = normalizeFocus({ code: 'BRK.B', secid: '106.BRK.B' })!
  assert.equal(us.kind, 'us')
  assert.equal(us.secid, '106.BRK.B')
})

await check('空代码不产生标的；时间戳非法时用调用时间而不是 NaN', async () => {
  assert.equal(normalizeFocus({ code: '   ' }), undefined)
  assert.equal(normalizeFocus({}), undefined)
  const focus = normalizeFocus({ code: '600519', at: Number.NaN })!
  assert.ok(Number.isFinite(focus.at) && focus.at > 0)
  assert.equal(normalizeFocus({ code: '600519', at: 1730000000000 })!.at, 1730000000000)
})

await check('行情键与标题', async () => {
  const stock = normalizeFocus({ code: '600519', type: 'stock' })!
  const fund = normalizeFocus({ code: '110022', type: 'fund' })!
  assert.equal(focusQuoteKey(stock), 'stock:600519')
  assert.equal(focusQuoteKey(fund), 'fund:110022')
  assert.equal(focusTitle({ ...stock, name: '贵州茅台' }), '贵州茅台 · 600519')
  assert.equal(focusTitle(stock), '600519', '名称等于代码时不重复显示')
})

await check('持久化：写入→读取→清除；脏数据视为无效', async () => {
  const storage = new MemoryStorage()
  const focus = normalizeFocus({ code: '600519', name: '贵州茅台', at: 1730000000000 })!
  saveFocus(focus, storage)
  assert.deepEqual(loadFocus(storage)!.code, '600519')
  assert.equal(storage.getItem(FOCUS_STORAGE_KEY)?.includes('贵州茅台'), true)
  saveFocus(undefined, storage)
  assert.equal(loadFocus(storage), undefined)
  storage.setItem(FOCUS_STORAGE_KEY, '{"code":""}')
  assert.equal(loadFocus(storage), undefined, '空代码不能恢复成一只标的')
  storage.setItem(FOCUS_STORAGE_KEY, 'not-json')
  assert.equal(loadFocus(storage), undefined, '坏 JSON 不应抛错')
})

await check('存储不可用时静默降级（无 localStorage 的宿主）', async () => {
  assert.equal(loadFocus(undefined), undefined)
  saveFocus(undefined, undefined)
  const throwing: Storage = {
    ...new MemoryStorage(),
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
    clear() {}, key() { return null }, length: 0,
  }
  assert.equal(loadFocus(throwing), undefined)
  saveFocus(normalizeFocus({ code: '600519' })! as InstrumentFocus, throwing)
})

await check('接线：面板只有一个当前标的来源，且四个动作都在', async () => {
  const page = readFileSync('src/client/index.tsx', 'utf8')
  assert.match(page, /const \[focus, setFocusState\] = useState<InstrumentFocus \| undefined>\(\(\) => loadFocus\(\)\)/)
  assert.match(page, /saveFocus\(next\)/)
  assert.match(page, /<InstrumentBar|h\(InstrumentBar/)
  const bar = readFileSync('src/client/instrument-focus.tsx', 'utf8')
  for (const label of ['K线', '分时', '档案', '问 Agent']) assert.ok(bar.includes(label), label)
  const ast = ts.createSourceFile('index.tsx', page, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  let renders = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'h' && node.arguments[0]?.getText(ast) === 'InstrumentBar') renders++
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(renders, 1, '上下文条只挂一处，避免重复指示')
})

console.log(`\n[instrument-focus] ${checks} 组通过（离线；浏览器渲染未验证）`)
