/**
 * 全球指数备用源（新浪）离线测试：各接口字段顺序、缺失与空行、行级容错、provider 接线。
 *
 * 约束：不联网（fixture 为实测原文）、不读私有数据。
 * 背景：东财 push2 会按 TLS 指纹重置 Node 连接，故新增新浪作为回落源。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  SINA_SYMBOL_BY_SECID,
  buildSinaGlobalRows,
  parseSinaLines,
  parseSinaQuote,
} from '../src/data/sina-global-indices.js'
import { GLOBAL_INDEX_DEFS } from '../src/data/global-indices.js'
import { PROVIDERS } from '../src/data/providers.js'
import { DEFAULT_PROVIDER_ORDER } from '../src/types.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log(`PASS ${name}`) }

// 实测原文（2026-11-23），仅保留用到的行
const TEXT = [
  'var hq_str_gb_$inx="标普500,6910.39,-3.7,2026-11-21 05:36:04,-265.44";',
  'var hq_str_int_sp500="标普指数,6643.70,38.98,0.59";',
  'var hq_str_int_dji="道琼斯,46247.29,299.97,0.65";',
  'var hq_str_znb_SPTSX="S&P/TSX综合指数,29761.28,29.30,0.10,9/26/2025,1758859200";',
  'var hq_str_znb_KOSPI="首尔综合指数,4623.1600,-246.80,-5.07,2:27 AM,1759127220,2026-11-23,11:08:00,4734.9000,4869.9600,4759.6500,4586.8000,0";',
  'var hq_str_rt_hkHSTECH="HSTECH,恒生科技指数,3443.760,3511.140,3474.750,3395.380,3431.920,-79.220,-2.260,0.000,0.000,28353322.123,1005298492,0.000,0.000,6001.020,3482.410,2026/11/23,11:08:12,,,,,,";',
  'var hq_str_sh000001="上证指数,3503.5227,3533.7929,3494.7524,3503.5227,3476.6502,0,0,277835682,388664272020,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-11-23,11:08:11,00,";',
  'var hq_str_hf_GC="3597.022,,3593.200,3593.800,3629.600,3552.300,11:07:16,3515.400,3570.500,0,1,1,2026-11-23,纽约黄金";',
  'var hq_str_DINIW="11:08:13,103.7638,103.7638,103.8404,1533,103.7980,103.8545,103.7012,103.7638,美元指数,2026-11-23";',
  'var hq_str_znb_KS11="";',
].join('\n')

await check('行解析：只取 hq_str_ 行，空值行保留为 fields=[]', () => {
  const lines = parseSinaLines(TEXT)
  assert.equal(lines.length, 10)
  const empty = lines.find((l) => l.symbol === 'znb_KS11')
  assert.deepEqual(empty?.fields, [])
})

await check('int_*：名称,现价,涨跌额,涨跌幅', () => {
  const q = parseSinaQuote('int_sp500', ['标普指数', '6643.70', '38.98', '0.59'])
  assert.deepEqual([q!.price, q!.change, q!.changePct], [6643.7, 38.98, 0.59])
  assert.equal(q!.asOf, null)
})

await check('znb_*：带日期时间的取 asOf，不带的为 null', () => {
  const kos = parseSinaQuote('znb_KOSPI', parseSinaLines(TEXT).find((l) => l.symbol === 'znb_KOSPI')!.fields)
  assert.equal(kos!.price, 4623.16)
  assert.equal(kos!.changePct, -5.07)
  assert.equal(kos!.asOf, '2026-11-23T03:08:00.000Z')
  const tsx = parseSinaQuote('znb_SPTSX', ['S&P/TSX综合指数', '29761.28', '29.30', '0.10', '9/26/2025', '1758859200'])
  assert.equal(tsx!.price, 29761.28)
  assert.equal(tsx!.asOf, new Date(1758859200 * 1000).toISOString(), '显式秒时间戳必须保留以检测过期')
})

await check('rt_hk：现价取第 7 列，日期/时间拼 ISO', () => {
  const fields = parseSinaLines(TEXT).find((l) => l.symbol === 'rt_hkHSTECH')!.fields
  const q = parseSinaQuote('rt_hkHSTECH', fields)!
  assert.equal(q.price, 3431.92)
  assert.equal(q.changePct, -2.26)
  assert.equal(q.asOf, '2026-11-23T03:08:12.000Z')
})

await check('A 股指数：price 取第 4 列，涨跌幅由昨收推导', () => {
  const fields = parseSinaLines(TEXT).find((l) => l.symbol === 'sh000001')!.fields
  const q = parseSinaQuote('sh000001', fields)!
  assert.equal(q.price, 3494.7524)
  assert.equal(q.derivedFrom, 'prevClose')
  // (3494.7524 - 3533.7929) / 3533.7929 * 100 ≈ -1.1047
  assert.ok(Math.abs((q.changePct ?? 0) - -1.1047) < 0.01)
})

await check('期货 hf_*：price/昨结推导涨跌幅并标注来源字段', () => {
  const fields = parseSinaLines(TEXT).find((l) => l.symbol === 'hf_GC')!.fields
  const q = parseSinaQuote('hf_GC', fields)!
  assert.equal(q.price, 3597.022)
  assert.equal(q.derivedFrom, 'prevSettle')
  // (3597.022 - 3515.4) / 3515.4 * 100 ≈ 2.32
  assert.ok(Math.abs((q.changePct ?? 0) - 2.32) < 0.02)
})

await check('DINIW：美元指数按 现价/昨收 推导', () => {
  const fields = parseSinaLines(TEXT).find((l) => l.symbol === 'DINIW')!.fields
  const q = parseSinaQuote('DINIW', fields)!
  assert.equal(q.price, 103.7638)
  assert.equal(q.derivedFrom, 'prevClose')
  assert.ok(Math.abs((q.changePct ?? 0) - -0.033) < 0.01)
})

await check('空行返回 null（由 build 层转成该行 error）', () => {
  assert.equal(parseSinaQuote('znb_KS11', []), null)
})

await check('build：未映射的品种（美债 10Y）显式 error，不隐藏', () => {
  const defs = GLOBAL_INDEX_DEFS.filter((d) => d.secid === '171.US10Y' || d.secid === '100.SPX')
  const { rows, failed } = buildSinaGlobalRows(TEXT, defs, '2026-11-23T03:10:00Z')
  const spx = rows.find((r) => r.secid === '100.SPX')!
  const us10y = rows.find((r) => r.secid === '171.US10Y')!
  assert.equal(spx.price, 6910.39)
  assert.equal(spx.source, 'sina')
  assert.equal(us10y.price, null)
  assert.match(us10y.error ?? '', /新浪无此品种/)
  assert.equal(failed, 1)
})

await check('build：韩国指数映射到 znb_KOSPI（不是空的 znb_KS11）', () => {
  const defs = GLOBAL_INDEX_DEFS.filter((d) => d.secid === '100.KS11')
  assert.equal(SINA_SYMBOL_BY_SECID['100.KS11'], 'znb_KOSPI')
  const { rows, failed } = buildSinaGlobalRows(TEXT, defs, '2026-11-23T03:10:00Z')
  assert.equal(rows[0]!.price, 4623.16)
  assert.equal(failed, 0)
})

await check('build：行数据为空时计入 failed 并带原因', () => {
  // 只给一条空值行，模拟源侧返回空字符串
  const emptyText = 'var hq_str_znb_KOSPI="";'
  const defs = GLOBAL_INDEX_DEFS.filter((d) => d.secid === '100.KS11')
  const { rows, failed } = buildSinaGlobalRows(emptyText, defs)
  assert.equal(rows[0]!.price, null)
  assert.match(rows[0]!.error ?? '', /未返回价格/)
  assert.equal(failed, 1)
})

await check('映射：所有非美债品种都有新浪 symbol', () => {
  const missing = GLOBAL_INDEX_DEFS.filter((d) => !['171.US10Y', '101.HG00Y'].includes(d.secid) && !SINA_SYMBOL_BY_SECID[d.secid])
  assert.deepEqual(missing.map((d) => d.secid), [])
})

await check('接线：global_indices 顺序为 东财 → 新浪，且 provider 已注册', () => {
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.global_indices, ['em_global_indices', 'sina_global_indices'])
  const provider = PROVIDERS.find((p) => p.id === 'sina_global_indices')
  assert.ok(provider, 'sina_global_indices 未注册')
  assert.equal(provider!.capability, 'global_indices')
})

await check('接线：路由/服务未把新浪写成唯一来源（仍保留东财首选）', async () => {
  const src = await readFile('src/data/providers.ts', 'utf8')
  assert.match(src, /id: 'em_global_indices'/)
  assert.match(src, /id: 'sina_global_indices'/)
})

console.log(`\n[sina-global-indices] ${checks} 组通过（离线；真实上游另测）`)
