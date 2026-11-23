/**
 * 全球指数日K备源（腾讯）离线测试：映射、解析、失败语义、与东财的先后顺序。
 *
 * 背景：东财 push2his 会间歇性重置连接（面板表现为「标普500 · 日K fetch failed」），
 * 因此日K在东财失败后回落腾讯；腾讯没有同日线的品种必须如实报错，不能空图当成功。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  TX_GLOBAL_KLINE_SYMBOL,
  fetchGlobalKline,
  parseTencentGlobalKline,
  tencentKlineUrl,
} from '../src/data/global-quotes.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`) }

// 实测结构：data[<key>].day = [[date, open, close, high, low, volume], ...]
const TX_FIXTURE = {
  code: 0,
  data: {
    'us.INX': {
      day: [
        ['2026-08-28', '6477.38', '6449.80', '6481.34', '6441.85', '3147834712.00'],
        ['2026-11-20', '7150.39', '6910.39', '7198.67', '6882.66', '4727416323'],
      ],
      qt: { 'us.INX': ['200', '标普500', '.INX', '6910.39'] },
    },
  },
}

check('映射：只覆盖腾讯确有连续日线的品种', () => {
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['100.SPX'], 'usINX')
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['100.HSI'], 'hkHSI')
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['1.000001'], 'sh000001')
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['124.HSTECH'], 'hkHSTECH')
  // 日经/欧洲/商品没有同日线，不能被映射到别的品种
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['100.N225'], undefined)
  assert.equal(TX_GLOBAL_KLINE_SYMBOL['101.GC00Y'], undefined)
})

check('解析：按对象里的实际 key 取（us.INX 带前缀），字段顺序 date/open/close/high/low/volume', () => {
  const r = parseTencentGlobalKline('100.SPX', TX_FIXTURE)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'tencent-kline')
  assert.equal(r.bars.length, 2)
  assert.deepEqual(
    { date: r.bars[0]!.date, open: r.bars[0]!.open, close: r.bars[0]!.close, high: r.bars[0]!.high, low: r.bars[0]!.low },
    { date: '2026-08-28', open: 6477.38, close: 6449.8, high: 6481.34, low: 6441.85 },
  )
  assert.equal(r.name, '标普500')
})

check('解析：收盘价非正/非有限的行跳过，不补 0', () => {
  const r = parseTencentGlobalKline('100.SPX', {
    data: { 'us.INX': { day: [['2026-11-20', '1', '0', '1', '1', '1'], ['2026-11-19', '1', '-', '1', '1', '1'], ['2026-11-18', '10', '10', '11', '9', '5']] } },
  })
  assert.equal(r.bars.length, 1)
  assert.equal(r.bars[0]!.close, 10)
})

check('解析：空 day / 无 data 返回 ok:false，不返回空图当成功', () => {
  assert.equal(parseTencentGlobalKline('100.SPX', {}).ok, false)
  assert.equal(parseTencentGlobalKline('100.SPX', { data: { 'us.INX': { day: [] } } }).ok, false)
})

check('URL：带上品种与根数', () => {
  const url = tencentKlineUrl('usINX', 60)
  assert.match(url, /web\.ifzq\.gtimg\.cn\/appstock\/app\/kline\/kline/)
  assert.match(url, /param=usINX,day,,,60/)
})

await checkAsync('回退：东财抛错时用腾讯，并标注 source', async () => {
  const calls: string[] = []
  const fakeFetch = async (url: string) => {
    calls.push(url)
    if (url.includes('push2his')) throw new Error('fetch failed')
    return TX_FIXTURE
  }
  const r = await fetchGlobalKline('100.SPX', 60, { fetchJson: fakeFetch as never })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'tencent-kline')
  assert.equal(r.bars.length, 2)
  assert.equal(calls.length, 2, '应先试东财再回落腾讯')
})

await checkAsync('回退：东财返回空 bars 时同样回落', async () => {
  const fakeFetch = async (url: string) => url.includes('push2his')
    ? { data: { klines: [] } }
    : TX_FIXTURE
  const r = await fetchGlobalKline('100.SPX', 60, { fetchJson: fakeFetch as never })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'tencent-kline')
})

await checkAsync('无备源品种：如实返回东财失败原因，不静默', async () => {
  const fakeFetch = async () => { throw new Error('fetch failed') }
  const r = await fetchGlobalKline('100.N225', 60, { fetchJson: fakeFetch as never })
  assert.equal(r.ok, false)
  assert.equal(r.bars.length, 0)
  assert.match(r.error ?? '', /没有备用源/)
})

await checkAsync('两个源都失败：错误里同时给出两边原因', async () => {
  const fakeFetch = async (url: string) => { throw new Error(url.includes('push2his') ? 'em down' : 'tx down') }
  const r = await fetchGlobalKline('100.SPX', 60, { fetchJson: fakeFetch as never })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /em down/)
  assert.match(r.error ?? '', /tx down/)
})

await checkAsync('东财成功时不打腾讯', async () => {
  const calls: string[] = []
  const fakeFetch = async (url: string) => {
    calls.push(url)
    return { data: { klines: ['2026-11-20,7145.00,6910.39,7198.67,6882.66,4727416323'] } }
  }
  const r = await fetchGlobalKline('100.SPX', 60, { fetchJson: fakeFetch as never })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'eastmoney-push2')
  assert.equal(calls.length, 1)
})

check('接线：客户端展示兜底来源，不再固定写「来源：东方财富」', async () => {
  const src = await readFile('src/client/index.tsx', 'utf8')
  assert.match(src, /腾讯兜底/)
  assert.match(src, /日K回落腾讯/)
})

console.log(`\n[global-kline] ${checks} 组通过（离线；真实上游另测）`)
