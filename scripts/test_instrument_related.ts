/**
 * 标的关联与今日要点的离线测试。
 *
 * 关注点：代码匹配的容错、缺行情不被当成 0、聚合失败各自可见、
 * 以及这两块只读聚合没有写接口。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { codeMatches, researchLine } from '../src/client/instrument-related.js'
import { holdingMoves, MOVE_THRESHOLD } from '../src/client/today-brief.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log('PASS', name) }

check('代码匹配：大小写、后缀、空白都容错，但不做前缀匹配', () => {
  assert.equal(codeMatches(['600519'], '600519'), true)
  assert.equal(codeMatches(['600519.SH'], '600519'), true)
  assert.equal(codeMatches(['aapl'], 'AAPL'), true)
  assert.equal(codeMatches(['00700.HK'], '00700'), true)
  assert.equal(codeMatches(['60051'], '600519'), false, '不能用前缀把别的标的算进来')
  assert.equal(codeMatches([], '600519'), false)
  assert.equal(codeMatches(undefined, '600519'), false)
  assert.equal(codeMatches(['600519'], ''), false)
})

check('资料行格式：日期/类型/标题，缺字段不出现空分隔符', () => {
  assert.equal(researchLine({ id: 'a', title: '黄金研判', kind: 'decision', date: '2026-11-24T03:00:00Z' }), '2026-11-24 · decision · 黄金研判')
  assert.equal(researchLine({ id: 'b', title: '仅有标题' }), '仅有标题')
})

check('持仓异动：缺行情不算 0，未达阈值不报，按幅度降序', () => {
  const holdings = [
    { code: '600519', name: '贵州茅台' },
    { code: '000001' },
    { code: '510300' },
    { code: '00700', type: 'stock' },
  ]
  const quotes: Record<string, number | null | undefined> = {
    '600519': 5.2, '000001': -3.4, '510300': 0.8, // 00700 缺行情
  }
  const moves = holdingMoves(holdings, (code) => (quotes[code] === undefined ? undefined : { changePct: quotes[code] }))
  assert.deepEqual(moves.map((m) => m.code), ['600519', '000001'])
  assert.equal(moves[0]!.changePct, 5.2)
  assert.equal(moves[1]!.changePct, -3.4)
  assert.equal(holdingMoves(holdings, () => undefined).length, 0, '没有行情时不能返回 0% 异动')
  assert.equal(holdingMoves([{ code: '600519' }], () => ({ changePct: MOVE_THRESHOLD - 0.1 })).length, 0, '阈值以下不报')
  assert.equal(holdingMoves([{ code: '600519' }], () => ({ changePct: Number.NaN })).length, 0, 'NaN 不是异动')
})

check('聚合只读：两块都不调用写接口', () => {
  for (const file of ['src/client/instrument-related.tsx', 'src/client/today-brief.tsx']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /apiPost|method:\s*'POST'|capital_transaction_add|upsert_holding/, file)
  }
})

check('聚合失败各自可见：一侧报错不吞掉另一侧', () => {
  const related = readFileSync('src/client/instrument-related.tsx', 'utf8')
  assert.match(related, /research\.error/)
  assert.match(related, /advice\.error/)
  const brief = readFileSync('src/client/today-brief.tsx', 'utf8')
  assert.match(brief, /adviceError/)
  assert.match(brief, /researchError/)
})

check('今日要点接入首页，且只有一个挂载点', () => {
  const page = readFileSync('src/client/index.tsx', 'utf8')
  const mounts = page.match(/h\(TodayBrief,/g) ?? []
  assert.equal(mounts.length, 1)
  assert.match(page, /holdingMoves\(data\.holdings/)
  assert.match(page, /changePercent/) // 行情字段是 changePercent，不能读 changePct
})

console.log(`\n[instrument-related] ${checks} 组通过（离线；浏览器渲染未验证）`)
