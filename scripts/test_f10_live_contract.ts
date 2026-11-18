/** Offline regression using synthetic fixtures with the observed live JSON shape.
 * Despite the filename this never calls HTTP or reads portfolio/private data.
 * Passing fixtures does not mark a response contractVerified.
 */
import assert from 'node:assert/strict'
import {
  normalizeCompanySurvey, normalizeBusinessComposition, normalizeCoreConcepts,
  normalizeShareholderCount, normalizePeers, normalizeMainFinancials, normalizeValuation,
} from '../src/data/eastmoney-f10.js'

let checks = 0
function check(name: string, fn: () => void) {
  fn()
  checks++
  console.log(`ok ${checks} - ${name}`)
}

check('company jbzl + listing fxxg; unrelated tables cannot overwrite company', () => {
  const out = normalizeCompanySurvey({
    jbzl: [{ SECURITY_NAME_ABBR: '合成银行', ORG_NAME: '合成银行股份有限公司', EM2016: '银行', INDUSTRYCSRC1: '货币金融服务', PROVINCE: '北京', ORG_PROFILE: '合成公司简介', BUSINESS_SCOPE: '合成经营范围', ORG_WEB: 'https://example.invalid' }],
    fxxg: [{ LISTING_DATE: '2006-07-05 00:00:00' }],
    unrelated: [{ SECURITY_NAME_ABBR: '错误公司', LISTING_DATE: '1990-01-01' }],
  })
  assert.equal(out.name, '合成银行')
  assert.equal(out.orgName, '合成银行股份有限公司')
  assert.equal(out.industry, '货币金融服务')
  assert.equal(out.region, '北京')
  assert.equal(out.listingDate, '2006-07-05')
  assert.equal(out.businessScope, '合成经营范围')
  assert.equal(out.profile, '合成公司简介')
  assert.equal(out.website, 'https://example.invalid')
  assert.equal(out.meta.contractVerified, false)
})
check('company supports flat object and envelope compatibility', () => {
  assert.equal(normalizeCompanySurvey({ SECURITY_NAME_ABBR: '扁平公司' }).name, '扁平公司')
  assert.equal(normalizeCompanySurvey({ data: { ORG_NAME: '扁平全名' } }).orgName, '扁平全名')
  assert.equal(normalizeCompanySurvey({ other: [{ ORG_NAME: '不可扫入' }] }).orgName, undefined)
})
check('business zyfw and zygcfx retain real fields, zero and missing', () => {
  const out = normalizeBusinessComposition({
    zyfw: [{ BUSINESS_SCOPE: '经营范围', ITEM_NAME: '不是构成' }],
    zygcfx: [{ REPORT_DATE: '2026-06-30', MAINOP_TYPE: '行业', ITEM_NAME: '制造', MAIN_BUSINESS_INCOME: 0, MBI_RATIO: 0, MAIN_BUSINESS_COST: null, MBC_RATIO: 0, MAIN_BUSINESS_RPOFIT: -10, MBR_RATIO: null, GROSS_RPOFIT_RATIO: 0, RANK: 0 }],
    other: [{ ITEM_NAME: '错误构成', MAIN_BUSINESS_INCOME: 123 }],
  })
  assert.equal(out.businessScope, '经营范围')
  assert.equal(out.rows.length, 1)
  assert.deepEqual(out.rows[0], { dimension: '行业', name: '制造', revenue: 0, revenuePct: 0, cost: undefined, costPct: 0, rank: 0, profit: -10, profitPct: undefined, grossMarginPct: 0, reportPeriod: '2026-06-30' })
  assert.equal(out.meta.reportPeriod, '2026-06-30')
  assert.equal(normalizeBusinessComposition({ zyfw: [{ ITEM_NAME: '不要混表' }] }).rows.length, 0)
})
check('concept board tags and narrative hxtc both map, no revenue inference', () => {
  const out = normalizeCoreConcepts({
    ssbk: [{ BOARD_CODE: 'BK0001', BOARD_NAME: '合成板块' }],
    hxtc: [{ KEYWORD: '合成关键词', MAINPOINT: '合成要点', MAINPOINT_CONTENT: '合成说明', KEY_CLASSIF: 0 }],
    other: [{ BOARD_NAME: '不要混表' }],
  })
  assert.equal(out.rows.length, 2)
  assert.equal(out.rows[0].name, '合成板块')
  assert.equal(out.rows[0].boardCode, 'BK0001')
  assert.equal(out.rows[1].name, '合成要点')
  assert.equal(out.rows[1].keyword, '合成关键词')
  assert.equal(out.rows[1].reason, '合成说明')
  assert.equal(out.rows[1].classification, '0')
  assert.equal('revenuePct' in out.rows[1], false)
  assert.equal(normalizeCoreConcepts({ ssbk: [], hxtc: [], data: [{ BOARD_NAME: '不得回退' }] }).rows.length, 0)
  assert.equal(normalizeCoreConcepts([{ BOARD_NAME: '裸数组兼容' }]).rows.length, 1)
})
check('gdrs maps household count not sdgd/sdltgd shares; preserve zero', () => {
  const out = normalizeShareholderCount({
    gdrs: [{ END_DATE: '2026-09-30', HOLDER_TOTAL_NUM: 0, TOTAL_NUM_RATIO: 0, AVG_FREE_SHARES: null }],
    sdgd: [{ END_DATE: '2026-09-30', HOLDER_NUM: 999 }],
    sdltgd: [{ END_DATE: '2026-09-30', HOLDER_NUM: 888 }],
  })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].holderCount, 0)
  assert.equal(out.rows[0].changePct, 0)
  assert.equal(out.rows[0].avgFreeShares, undefined)
  assert.equal(out.rows[0].publishedAt, undefined)
  assert.equal(out.meta.asOf, '2026-09-30')
  assert.deepEqual(normalizeShareholderCount({ sdgd: [{ END_DATE: '2026-09-30', HOLDER_NUM: 999 }] }).rows, [])
  assert.deepEqual(normalizeShareholderCount({ gdrs: [], sdgd: [{ END_DATE: '2026-09-30' }] }).rows, [])
})
check('peers prefer CORRE identity and gzbj; no company/industry table pollution', () => {
  const out = normalizePeers({
    gzbj: [{ SECURITY_CODE: '601988', CORRE_SECURITY_CODE: '600000', CORRE_SECURITY_NAME: '合成同行', PE_TTM: 0, PB: 3, PB_MRQ: 0, REPORT_DATE: '2026-09-30' }, { SECURITY_CODE: '601988', CORRE_SECURITY_CODE: '600001', CORRE_SECURITY_NAME: '缺估值同行', PE_TTM: null, PB: null }],
    czxbj: [{ CORRE_SECURITY_CODE: '600002', CORRE_SECURITY_NAME: '增长比较' }],
    gsgm: [{ SECURITY_CODE: '601988', PE_TTM: 999 }],
  })
  assert.deepEqual(out.rows.map((r) => r.code), ['600000', '600001'])
  assert.equal(out.rows[0].name, '合成同行')
  assert.equal(out.rows[0].peTtm, 0)
  assert.equal(out.rows[0].pb, 0)
  assert.equal(out.rows[1].peTtm, undefined)
  assert.equal(out.rows[1].pb, undefined)
  assert.equal(out.meta.contractVerified, false)
  assert.equal(out.method, 'upstream_unverified')
  assert.deepEqual(normalizePeers({ gsgm: [{ SECURITY_CODE: '601988' }] }).rows, [])
  assert.deepEqual(normalizePeers({ gzbj: [], gsgm: [{ SECURITY_CODE: '601988' }] }).rows, [])
  assert.equal(normalizePeers({ czxbj: [{ CORRE_SECURITY_CODE: '600002', CORRE_SECURITY_NAME: '增长比较', REPORT_DATE: '2026-09-30' }] }).rows[0].code, '600002')
})
check('financial actual aliases and BPS never use operating cash flow per share', () => {
  const out = normalizeMainFinancials({ result: { data: [{ REPORT_DATE: '2026-09-30', REPORT_DATE_NAME: '2026三季报', TOTALOPERATEREVE: 0, PARENTNETPROFIT: -10, MGJYXJJE: 9 }] }, unrelated: [{ REPORT_DATE: '1999-01-01', BPS: 999 }] })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].reportType, '2026三季报')
  assert.equal(out.rows[0].revenue, 0)
  assert.equal(out.rows[0].netProfit, -10)
  assert.equal(out.rows[0].bps, undefined)
  assert.equal(out.rows[0].ocfPerShare, 9)
  assert.equal(normalizeMainFinancials([{ REPORT_DATE: '2026-09-30', BPS: 0, MGJYXJJE: 9 }]).rows[0].bps, 0)
  assert.equal(normalizeMainFinancials([{ REPORT_DATE: '2026-09-30', NET_ASSETS_PER_SHARE: 5 }]).rows[0].bps, 5)
})
check('envelopes and empty result tables never scan unrelated arrays', () => {
  assert.equal(normalizeShareholderCount({ result: { data: { gdrs: [{ END_DATE: '2026-06-30', HOLDER_TOTAL_NUM: 123 }] } } }).rows[0].holderCount, 123)
  assert.equal(normalizeMainFinancials({ result: { data: [] }, other: [{ REPORT_DATE: '2026-09-30' }] }).rows.length, 0)
  assert.equal(normalizeValuation({ result: { data: [{ TRADE_DATE: '2026-09-30', PE_TTM: null, PB_MRQ: 0 }] } }).history[0].pb, 0)
  for (const raw of [null, undefined, {}, { data: null }]) {
    assert.deepEqual(normalizePeers(raw).rows, [])
    assert.deepEqual(normalizeCoreConcepts(raw).rows, [])
    assert.deepEqual(normalizeBusinessComposition(raw).rows, [])
  }
})
console.log(`PASS ${checks} offline observed-shape F10 contract checks (no live verification)`)
