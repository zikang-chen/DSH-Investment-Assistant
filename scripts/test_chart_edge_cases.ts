/** Offline chart edge contracts. No network/private data, files, settings or DOM writes.
 * Run: TSX_DISABLE_CACHE=1 node --import tsx scripts/test_chart_edge_cases.ts
 * Sizing lifecycle is a source/AST contract, not a claim of live-browser verification.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { fetchGlobalKline, fetchGlobalQuote, parseGlobalKline, parseGlobalQuote } from '../src/data/global-quotes.js'
import { klinePointerAt } from '../src/client/kline-chart.js'

let checks = 0
async function check(name: string, run: () => void | Promise<void>) {
  await run(); checks++; console.log(`PASS ${name}`)
}
const quote = (code = 'BRK.B', market = 106) => ({ data: { f57: code, f107: market, f43: 500 } })
const kline = (code = 'BRK.B', market = 106) => ({ data: { code, market, klines: ['2026-11-23,499,500,501,498,1000'] } })

await check('dot ticker: quote and K-line preserve the full code after the first separator', () => {
  assert.equal(parseGlobalQuote('106.BRK.B', quote()).ok, true)
  const result = parseGlobalKline('106.BRK.B', kline())
  assert.equal(result.ok, true)
  assert.equal(result.code, 'BRK.B')
  assert.equal(result.bars.length, 1)
})
await check('dot ticker: code, class and exchange mismatches remain rejected', () => {
  for (const code of ['BRK', 'BRK.A', 'AAPL']) {
    assert.equal(parseGlobalQuote('106.BRK.B', quote(code)).ok, false)
    assert.equal(parseGlobalKline('106.BRK.B', kline(code)).ok, false)
  }
  assert.equal(parseGlobalQuote('106.BRK.B', quote('BRK.B', 105)).ok, false)
  assert.equal(parseGlobalKline('106.BRK.B', kline('BRK.B', 105)).ok, false)
})
await check('dot ticker: validated input whitespace and response case do not lose identity', () => {
  assert.equal(parseGlobalQuote(' 106.BRK.B ', quote('brk.b')).ok, true)
  assert.equal(parseGlobalKline(' 106.BRK.B ', kline('brk.b')).ok, true)
})
await check('fetch path: dotted quote/K-line identities reach the parser intact with injected responses', async () => {
  const urls: string[] = []
  const q = await fetchGlobalQuote('106.BRK.B', { cache: new Map(), fetchJson: async url => { urls.push(url); return quote() } })
  const k = await fetchGlobalKline('106.BRK.B', 60, { fetchJson: async url => { urls.push(url); return kline() } })
  assert.equal(q.ok, true)
  assert.equal(k.ok, true)
  assert.equal(k.bars.length, 1)
  assert.equal(urls.length, 2, 'a valid source response must not fall through to a guessed symbol')
  for (const url of urls) assert.equal(new URL(url).searchParams.get('secid'), '106.BRK.B')
})

const width = 560, height = 300, left = 6, plot = width - left - 68
await check('crosshair: every candle centre maps to its own bar, not the next trading date', () => {
  for (let i = 0; i < 80; i++) {
    const x = left + (i + 0.5) * plot / 80
    const hit = klinePointerAt(x, 120, { left: 0, top: 0, width, height }, width, height, 80, { count: 80, offset: 0 })
    assert.equal(hit.index, i, `candle ${i} at x=${x}`)
    assert.equal(hit.y, 120)
  }
})
await check('crosshair: CSS-scaled canvas uses logical x/y while respecting a panned viewport', () => {
  const rect = { left: 100, top: 50, width: width * 2, height: height / 2 }
  for (let i = 0; i < 40; i++) {
    const x = left + (i + 0.5) * plot / 40
    const hit = klinePointerAt(rect.left + x * 2, rect.top + 120 / 2, rect, width, height, 100, { count: 40, offset: 20 })
    assert.equal(hit.index, 40 + i)
    assert.ok(Math.abs(hit.x - x) < 1e-9)
    assert.equal(hit.y, 120)
  }
})
await check('crosshair: padding, price-axis and out-of-canvas pointers clamp to visible bounds', () => {
  const rect = { left: 0, top: 0, width, height }
  assert.equal(klinePointerAt(0, 0, rect, width, height, 100, { count: 40, offset: 20 }).index, 40)
  assert.equal(klinePointerAt(width, height, rect, width, height, 100, { count: 40, offset: 20 }).index, 79)
  assert.equal(klinePointerAt(-100, 0, undefined, width, height, 100, { count: 40, offset: 20 }).index, 40)
  assert.equal(klinePointerAt(10, 0, { ...rect, width: 0, height: 0 }, width, height, 0, { count: 1, offset: 0 }).index, 0)
})

await check('sizing lifecycle AST: empty→populated reattaches measurement and cleans the old observer', async () => {
  const source = await readFile(new URL('../src/client/kline-chart.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('kline-chart.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let hasBars = false
  let sizing: ts.CallExpression | undefined
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'hasBars') hasBars = node.initializer?.getText(ast) === 'bars.length > 0'
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect') sizing = node
    ts.forEachChild(node, walk)
  }
  walk(ast)
  assert.equal(hasBars, true, 'dependency must track whether the empty-state container exists')
  assert.ok(sizing)
  const deps = sizing.arguments[1]
  assert.ok(deps && ts.isArrayLiteralExpression(deps))
  assert.deepEqual(deps.elements.map(node => node.getText(ast)), ['hasBars'])
  const setup = sizing.arguments[0]!.getText(ast)
  assert.match(setup, /containerRef\.current/)
  assert.match(setup, /measure\(\)/)
  assert.match(setup, /ro\?\.observe\(el\)/)
  assert.match(setup, /return \(\) => ro\?\.disconnect\(\)/)
  assert.match(setup, /typeof ResizeObserver === 'undefined'/)
  assert.doesNotMatch(source, /e\.nativeEvent\.offsetY/, 'pointer x/y must use the same canvas transform')
})
console.log(`[chart-edge-cases] ${checks} offline groups passed; sizing lifecycle is AST-checked, live browser not exercised.`)
