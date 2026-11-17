/**
 * P1 currency identity + P2 dossier flattening contracts. All data below is explicit fixture data,
 * never a live-market claim. Run with `npx tsx scripts/test_security_identity.ts`.
 */
import assert from 'node:assert/strict'
import { quoteCurrency, valuation } from '../src/valuation.js'
import { dossierRows, stockIdentityFromRow } from '../src/client/security-model.js'

let passed = 0
function test(name: string, run: () => void) {
  try {
    run()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

test('quoteCurrency keeps A-share / HK / US / fund behaviour unchanged', () => {
  for (const code of ['600519', 'sh600519', '600519.SH', '000001']) assert.equal(quoteCurrency(code), 'CNY')
  assert.equal(quoteCurrency('00700'), 'HKD')
  assert.equal(quoteCurrency('hk00700'), 'HKD')
  assert.equal(quoteCurrency('00700.HK'), 'HKD')
  assert.equal(quoteCurrency('AAPL'), 'USD')
  assert.equal(quoteCurrency('110022', 'fund'), 'CNY')
  // 200xxx is also used by some fund codes (e.g. 长城基金 products); fund type must stay CNY.
  assert.equal(quoteCurrency('200001', 'fund'), 'CNY')
  assert.equal(quoteCurrency('900901', 'fund'), 'CNY')
})

test('Shanghai 900 / Shenzhen 200 B-shares no longer default to CNY', () => {
  for (const code of ['900901', 'sh900901', '900901.SH', '200002', 'sz200002', '200002.SZ']) {
    assert.equal(quoteCurrency(code), undefined, `${code} must not be assumed CNY`)
  }
})

test('valuation does not merge B-shares into the CNY group and blocks consolidated', () => {
  const rows = [
    { code: '600519', quantity: 10, avgCost: 100, price: 110, currency: quoteCurrency('600519'), type: 'stock' as const },
    { code: '900901', quantity: 5, avgCost: 1, price: 1.1, currency: quoteCurrency('900901'), type: 'stock' as const },
    { code: '200002', quantity: 2, avgCost: 5, price: 4, currency: quoteCurrency('200002'), type: 'stock' as const },
  ]
  const result = valuation(rows)
  assert.deepEqual(result.groups.map(group => group.currency), ['CNY'])
  assert.equal(result.groups[0].cost, 1000)
  assert.equal(result.groups[0].value, 1100)
  assert.equal(result.groups[0].profit, 100)
  // B rows never enter the CNY totals; their codes land in the group's missing set so existing
  // completeness checks (e.g. wealth principal) refuse to treat the CNY-only value as complete.
  assert.deepEqual(result.groups[0].missing, ['900901', '200002'])
  assert.deepEqual(result.missingCurrency, ['900901', '200002'])
  assert.equal(result.consolidated, null, 'a partial CNY-only value must not be presented as complete')
  assert.ok(result.missing.some(note => note.includes('900901') && note.includes('200002') && note.includes('缺币种')))
})

test('valuation rejects legacy CNY-labelled B-shares but keeps 200xxx funds in CNY', () => {
  const legacy = valuation([{ code: '900901', quantity: 1, avgCost: 2, price: 3, currency: 'CNY', type: 'stock' }])
  assert.deepEqual(legacy.groups, [])
  assert.deepEqual(legacy.missingCurrency, ['900901'])
  assert.equal(legacy.consolidated, null)

  const fund = valuation([{ code: '200001', quantity: 2, avgCost: 1, price: 2, currency: quoteCurrency('200001', 'fund'), type: 'fund' }])
  assert.deepEqual(fund.groups.map(group => group.currency), ['CNY'])
  assert.equal(fund.consolidated?.value, 4)
  assert.deepEqual(fund.missingCurrency, [])
})

test('valuation groups, missing quotes and cross-currency notes keep their contracts', () => {
  const single = valuation([{ code: '600519', quantity: 2, avgCost: 10, price: 12, currency: 'CNY' }])
  assert.equal(single.consolidated?.currency, 'CNY')
  assert.equal(single.consolidated?.profit, 4)
  assert.deepEqual(single.missingCurrency, [])
  assert.deepEqual(single.missing, [])

  const missingPrice = valuation([{ code: '600519', quantity: 2, avgCost: 10, currency: 'CNY' }])
  assert.equal(missingPrice.groups[0].value, null)
  assert.deepEqual(missingPrice.groups[0].missing, ['600519'])
  assert.equal(missingPrice.consolidated?.value, null)

  const mixed = valuation([
    { code: 'AAPL', quantity: 1, avgCost: 10, price: 11, currency: 'USD' },
    { code: '600519', quantity: 1, avgCost: 10, price: 11, currency: 'CNY' },
  ])
  assert.equal(mixed.groups.length, 2)
  assert.equal(mixed.consolidated, null)
  assert.deepEqual(mixed.missingCurrency, [])
  assert.ok(mixed.missing.some(note => note.includes('跨币种')))

  const empty = valuation([])
  assert.deepEqual(empty.groups, [])
  assert.equal(empty.consolidated, null)
  assert.deepEqual(empty.missingCurrency, [])
  assert.deepEqual(empty.missing, [])
})

test('dossierRows expands {rows:[2 periods], meta.unit} into two rows with unit visible', () => {
  const rows = dossierRows({
    rows: [
      { 报告期: '2026-09-30', 营业总收入: '123 亿元', 净利润: 0 },
      { 报告期: '2025-12-31', 营业总收入: 45, 净利润: null },
    ],
    meta: { unit: '亿元' },
    asOf: '2026-09-30',
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].unit, '亿元')
  assert.equal(rows[1].unit, '亿元')
  assert.equal(rows[0].asOf, '2026-09-30')
  assert.equal(rows[0].营业总收入, '123 亿元')
  assert.equal(rows[0].净利润, '0', 'zero is preserved as 0')
  assert.equal(rows[1].营业总收入, '45')
  assert.equal(rows[1].净利润, '—', 'null stays missing and is never filled with 0')
  assert.equal(rows[1].报告期, '2025-12-31')
})

test('dossierRows also expands data / items / records and keeps metadata on each row', () => {
  for (const key of ['data', 'items', 'records']) {
    const rows = dossierRows({ [key]: [{ code: '600519', value: 0 }, { code: '00700', value: null }], currency: 'CNY' })
    assert.equal(rows.length, 2, `${key} should expand to two rows`)
    assert.equal(rows[0].currency, 'CNY')
    assert.equal(rows[0].value, '0')
    assert.equal(rows[1].value, '—')
  }
  // Empty nested array keeps metadata visible instead of dropping it.
  assert.deepEqual(dossierRows({ rows: [], meta: { unit: '亿元' } }), [{ unit: '亿元' }])
})

test('dossierRows keeps the plain {字段,值} contract for ordinary objects', () => {
  assert.deepEqual(dossierRows({ 规模: 0 }), [{ 字段: '规模', 值: '0' }])
  assert.deepEqual(dossierRows([{ 本期营收: '123 亿元', 缺失: null }]), [{ 本期营收: '123 亿元', 缺失: '—' }])
  assert.deepEqual(dossierRows(undefined), [])
  assert.deepEqual(dossierRows(null), [])
})

test('peer_comparison rows create links from code/name/stockCode/securityCode variants', () => {
  const rows = dossierRows({
    rows: [
      { code: '600519', name: '贵州茅台（fixture）', pe: 20 },
      { stock_code: '00700', security_name: '腾讯（fixture）', pe: 15 },
    ],
    asOf: '2026-11-17',
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(stockIdentityFromRow(rows[0], 'peer_comparison'), { code: '600519', name: '贵州茅台（fixture）', type: 'stock' })
  assert.deepEqual(stockIdentityFromRow(rows[1], 'peer_comparison'), { code: '00700', name: '腾讯（fixture）', type: 'stock' })

  assert.deepEqual(stockIdentityFromRow({ stockCode: '00700', securityName: '腾讯（fixture）' }, 'holdings'), { code: '00700', name: '腾讯（fixture）', type: 'stock' })
  assert.deepEqual(stockIdentityFromRow({ stock_code: 'AAPL', stock_name: 'Apple（fixture）' }, 'holdings'), { code: 'AAPL', name: 'Apple（fixture）', type: 'stock' })
  assert.deepEqual(stockIdentityFromRow({ SECURITY_CODE: '000001', SECURITY_NAME_ABBR: 'fixture' }, 'rows'), { code: '000001', name: 'fixture', type: 'stock' })
  assert.deepEqual(stockIdentityFromRow({ 股票代码: '00700', 股票名称: 'fixture' }, 'holdings'), { code: '00700', name: 'fixture', type: 'stock' })
})

test('stock links stay limited to holdings/peer_comparison/rows and reject loose numbers', () => {
  assert.equal(stockIdentityFromRow({ code: '00700', name: 'fixture' }, 'overview'), null)
  assert.equal(stockIdentityFromRow({ code: '00700', name: 'fixture' }, 'main_financials'), null)
  assert.equal(stockIdentityFromRow({ code: '2%', name: 'fixture' }, 'peer_comparison'), null)
  assert.equal(stockIdentityFromRow({ code: '—', name: 'fixture' }, 'holdings'), null)
  assert.equal(stockIdentityFromRow({ name: 'fixture' }, 'holdings'), null)
  const identity = stockIdentityFromRow({ code: '600519' }, 'rows')
  assert.equal(identity?.code, '600519')
  assert.equal(identity?.name, undefined)
})

console.log(`[security-identity] ${passed} pure groups passed; no live data, private files or network used.`)
