/**
 * Fund UI: pure model + static contracts only.
 * No DOM, browser, network, private data, write APIs or real /fundrank request.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_FUND_SORT, DEFAULT_FUND_TYPE, FUND_NAV_T1_NOTE, FUND_NAV_T1_TAG, FUND_RANK_PAGE_SIZE,
  FUND_SEARCH_ONLY_NOTE, FUND_SORTS, FUND_TYPES,
  formatFundNav, formatFundReturn, fundNavDate, fundNavDateText, fundPageState, fundPeriodReturn,
  fundRankPath, fundRankQuery, fundReturnDirection, fundRowView, fundRowViews, fundSortLabel,
  normalizeFundPage, normalizeFundSize, normalizeFundSort, normalizeFundType,
  type FundRankRow,
} from '../src/client/fund-ui-model.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }
const root = new URL('../', import.meta.url)
const [view, model, routes] = await Promise.all([
  'src/client/fund-workspace.tsx', 'src/client/fund-ui-model.ts', 'src/server-routes.ts',
].map(path => readFile(new URL(path, root), 'utf8')))
const cssMatch = view!.match(/const fundWorkspaceCss = `([\s\S]*?)`\r?\n/)
assert.ok(cssMatch, 'component must own its scoped CSS constant')
const workspaceCss = cssMatch[1]!

check('rank query builds the existing /fundrank route and normalizes every parameter', () => {
  assert.equal(fundRankPath(), '/fundrank?type=all&size=20&sort=m6&page=1')
  assert.equal(fundRankPath({ type: 'stock', sort: 'y3', page: 2 }), '/fundrank?type=stock&size=20&sort=y3&page=2')
  assert.equal(fundRankPath({ type: 'bogus', sort: 'bogus', page: -3, size: 999 }), '/fundrank?type=all&size=50&sort=m6&page=1')
  assert.equal(fundRankPath({ type: 'hybrid', sort: 'ytd', page: '2.9', size: '5' }), '/fundrank?type=hybrid&size=5&sort=ytd&page=2')
  assert.deepEqual(fundRankQuery({ type: ' STOCK ', sort: ' YTD ', page: '3', size: '5' }), { type: 'stock', sort: 'ytd', page: 3, size: 5 })
  assert.equal(fundRankQuery().size, FUND_RANK_PAGE_SIZE)
  assert.doesNotMatch(fundRankPath({ page: 2 }), /total|pageSize|offset/i)
  // The route contract this UI targets must actually exist and forward page/sort.
  assert.match(routes!, /sub === '\/fundrank'/)
  assert.match(routes!, /url\.searchParams\.get\('page'\)/)
  assert.match(routes!, /url\.searchParams\.get\('sort'\)/)
  assert.match(routes!, /getFundRank\(fundType, size, sort, page\)/)
})

check('type and period options preserve the existing filters', () => {
  assert.deepEqual(FUND_TYPES.map(option => option.value), ['all', 'stock', 'hybrid', 'bond', 'index', 'qdii'])
  assert.deepEqual(FUND_SORTS.map(option => option.value), ['m1', 'm3', 'm6', 'y1', 'y3', 'ytd'])
  assert.equal(DEFAULT_FUND_TYPE, 'all')
  assert.equal(DEFAULT_FUND_SORT, 'm6')
  assert.equal(fundSortLabel('m6'), '近6月')
  assert.equal(fundSortLabel('NOPE'), '近6月')
  assert.equal(normalizeFundType('BOND'), 'bond')
  assert.equal(normalizeFundType('money'), 'all', 'unsupported types fall back instead of leaking to the URL')
})

check('invalid pages normalize to page 1; fractions truncate; positives stay 1-based', () => {
  for (const value of [0, -1, -99, NaN, Infinity, -Infinity, '', 'abc', null, undefined, {}, []]) {
    assert.equal(normalizeFundPage(value), 1, String(value))
  }
  assert.equal(normalizeFundPage(2.9), 2)
  assert.equal(normalizeFundPage('3.9'), 3)
  assert.equal(normalizeFundPage(7), 7)
  assert.equal(normalizeFundSize(undefined), FUND_RANK_PAGE_SIZE)
  assert.equal(normalizeFundSize(null), FUND_RANK_PAGE_SIZE)
  assert.equal(normalizeFundSize(''), FUND_RANK_PAGE_SIZE)
  assert.equal(normalizeFundSize('abc'), FUND_RANK_PAGE_SIZE)
  assert.equal(normalizeFundSize(0), 1)
  assert.equal(normalizeFundSize(-5), 1)
  assert.equal(normalizeFundSize(999), 50)
  assert.equal(normalizeFundSize(25.9), 25)
})

check('pagination infers next/previous only from returned row count, never a total', () => {
  const full = fundPageState(1, FUND_RANK_PAGE_SIZE, FUND_RANK_PAGE_SIZE)
  assert.equal(full.hasNext, true)
  assert.equal(full.hasPrevious, false)
  assert.equal(full.offset, 0)
  assert.equal(full.emptyPage, false)
  assert.match(full.status, /可能还有下一页/)
  assert.doesNotMatch(full.status, /总量|总数|总页数|共\s*\d+/)

  const second = fundPageState('2', FUND_RANK_PAGE_SIZE, FUND_RANK_PAGE_SIZE)
  assert.equal(second.page, 2)
  assert.equal(second.offset, 20)
  assert.equal(second.hasPrevious, true)
  assert.equal(second.hasNext, true)

  const short = fundPageState(3, FUND_RANK_PAGE_SIZE - 1, FUND_RANK_PAGE_SIZE)
  assert.equal(short.hasNext, false, 'a short page means the end')
  assert.match(short.status, /不足 20 条，已到末页/)
  assert.doesNotMatch(short.status, /总页数/)

  const emptyFirst = fundPageState(1, 0, FUND_RANK_PAGE_SIZE)
  assert.equal(emptyFirst.isEmpty, true)
  assert.equal(emptyFirst.hasNext, false)
  assert.equal(emptyFirst.emptyPage, false)
  assert.equal(emptyFirst.status, '暂无基金排行数据')

  const emptyLater = fundPageState(4, 0, FUND_RANK_PAGE_SIZE)
  assert.equal(emptyLater.emptyPage, true)
  assert.equal(emptyLater.hasNext, false)
  assert.match(emptyLater.status, /第 4 页没有数据/)
  assert.doesNotMatch(emptyLater.status, /共|总/)

  assert.equal(fundPageState(1, NaN).count, 0)
  assert.equal(fundPageState(0, 20).page, 1)
})

check('unknown sort falls back to near-6-month, matching the provider fallback', () => {
  assert.equal(normalizeFundSort('bogus'), 'm6')
  assert.equal(normalizeFundSort('M3'), 'm3')
  assert.equal(fundSortLabel('bogus'), '近6月')
  const row: FundRankRow = { code: '005827', name: '示例', m6: -3.2 }
  assert.equal(fundPeriodReturn(row, 'bogus'), -3.2)
  assert.equal(fundPeriodReturn(row, 'm1'), undefined, 'missing period stays undefined, not 0')
  assert.equal(fundPeriodReturn(undefined, 'm6'), undefined)
})

check('returns keep signs and negatives; missing returns are unknown, never 0.00%', () => {
  assert.equal(formatFundReturn(-1.236), '−1.24%')
  assert.equal(fundReturnDirection(-1.236), 'down')
  assert.equal(formatFundReturn(2.5), '+2.50%')
  assert.equal(fundReturnDirection(2.5), 'up')
  assert.equal(formatFundReturn(0), '0.00%')
  assert.equal(fundReturnDirection(0), 'flat')
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(formatFundReturn(value), '—', String(value))
    assert.equal(fundReturnDirection(value), 'missing', String(value))
  }
})

check('NAV and NAV date stay missing when absent; zero NAV and T+1 labels are explicit', () => {
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(formatFundNav(value), '—', String(value))
  assert.equal(formatFundNav(0), '0.0000', 'a real zero NAV is preserved')
  assert.equal(formatFundNav(1.23456), '1.2346')
  assert.equal(formatFundNav(1.2), '1.2000')
  assert.equal(fundNavDate('2026-11-14'), '2026-11-14')
  assert.equal(fundNavDate('2026-11-14T23:00:00Z'), '2026-11-14', 'date part must not shift through UTC')
  for (const value of ['', '  ', 'not-a-date', '11/14/2026', '2026-13-40', null, undefined]) {
    assert.equal(fundNavDate(value), '未注明', String(value))
  }
  assert.match(fundNavDateText('2026-11-14'), /^净值日期 2026-11-14$/)
  assert.match(FUND_NAV_T1_NOTE, /T\+1/)
  assert.match(FUND_NAV_T1_NOTE, /不是实时/)
  assert.match(FUND_NAV_T1_TAG, /T\+1/)
})

check('row view maps code/name/nav/period/date and full accessible label', () => {
  const row: FundRankRow = { code: '005827', name: '易方达蓝筹精选混合', date: '2026-11-14', nav: null, m6: -3.456, y3: null }
  const mapped = fundRowView(row, 'm6', 7)
  assert.equal(mapped.rank, 7)
  assert.equal(mapped.code, '005827')
  assert.equal(mapped.name, '易方达蓝筹精选混合')
  assert.equal(mapped.navText, '—')
  assert.equal(mapped.navKnown, false)
  assert.equal(mapped.returnText, '−3.46%')
  assert.equal(mapped.returnDirection, 'down')
  assert.equal(mapped.periodLabel, '近6月')
  assert.equal(mapped.dateText, '2026-11-14')
  assert.equal(mapped.dateKnown, true)
  assert.equal(mapped.t1, FUND_NAV_T1_TAG)
  assert.equal(mapped.openable, true)
  for (const fragment of ['005827', '易方达蓝筹精选混合', '单位净值 —', '近6月收益 −3.46%', 'T+1']) {
    assert.ok(mapped.ariaLabel.includes(fragment), fragment)
  }

  const leadingZero = fundRowView({ code: '000001', name: '', date: '', nav: 0, m6: 0 }, 'm6', 1)
  assert.equal(leadingZero.code, '000001', 'fund code keeps a leading zero')
  assert.equal(leadingZero.name, '000001', 'missing name falls back to the code, not a fabricated name')
  assert.equal(leadingZero.navText, '0.0000')
  assert.equal(leadingZero.returnText, '0.00%')
  assert.equal(leadingZero.dateText, '未注明')

  const noCode = fundRowView({ code: '   ', name: '无代码' }, 'm6', 1)
  assert.equal(noCode.openable, false)
  assert.equal(noCode.name, '无代码')
})

check('row views apply page-relative ranks and drop non-object rows', () => {
  const rows: FundRankRow[] = [
    { code: '110022', name: 'A', m6: 1 },
    { code: '000001', name: 'B', m6: -1 },
  ]
  assert.deepEqual(fundRowViews(rows, 'm6', 2, 20).map(row => row.rank), [21, 22])
  assert.deepEqual(fundRowViews(rows, 'm6', 1, 20).map(row => row.rank), [1, 2])
  assert.deepEqual(fundRowViews(null, 'm6', 1), [])
  assert.deepEqual(fundRowViews([null, { code: 'x', name: 'y' }] as unknown as FundRankRow[], 'm6', 1).map(row => row.code), ['x'])
  assert.equal(fundRowViews(rows, 'm6', '2.9', 20)[0]!.rank, 21, 'fractional page truncates')
})

check('all workspace CSS is finance-root scoped, token-based, numeric-right and single-column narrow', () => {
  let rules = 0
  for (const match of workspaceCss.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
    const selector = match[1]!.trim()
    if (selector.startsWith('@container') || selector.startsWith('@media')) continue
    rules++
    assert.ok(selector.startsWith('.fia-root'), selector)
    let depth = 0
    for (let index = 0; index < selector.length; index++) {
      if ('(['.includes(selector[index]!)) depth++
      if (')]'.includes(selector[index]!)) depth--
      if (selector[index] === ',' && depth === 0) assert.ok(selector.slice(index + 1).trim().startsWith('.fia-root'), selector)
    }
  }
  assert.ok(rules > 30)
  assert.doesNotMatch(workspaceCss, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  assert.match(workspaceCss, /container-name:fia-fund/)
  assert.match(workspaceCss, /@container fia-fund \(max-width:560px\)/)
  assert.match(workspaceCss, /\.fia-root \.fia-fund-row\{grid-template-columns:minmax\(0,1fr\)/)
  assert.match(workspaceCss, /\.fia-root \.fia-fund-head,\.fia-root \.fia-fund-row\{display:grid;grid-template-columns:/)
  assert.match(workspaceCss, /\.fia-root \.fia-fund-row__metric\[data-numeric=true\]\{text-align:right\}/)
  assert.match(workspaceCss, /\.fia-root \.fia-fund-row__value\{[^}]*font-variant-numeric:tabular-nums/)
})

check('component keeps the requested props, fund-only search, active gate and row semantics', () => {
  assert.match(view!, /export interface FundWorkspaceProps \{/)
  assert.match(view!, /get: ReadApi/)
  assert.match(view!, /onOpenFund: \(item: SecurityIdentity\) => void/)
  assert.match(view!, /active\?: boolean/)
  assert.match(view!, /export function FundWorkspace\(\{ get, onOpenFund, active \}: FundWorkspaceProps\)/)
  assert.match(view!, /const enabled = active !== false/)
  const propsBlock = view!.slice(view!.indexOf('export interface FundWorkspaceProps'), view!.indexOf('}', view!.indexOf('export interface FundWorkspaceProps')))
  assert.doesNotMatch(propsBlock, /mutate|deliver|post:/, 'parent owns write actions; FundWorkspace must not receive them')

  assert.match(view!, /<SecuritySearch/)
  const handler = view!.slice(view!.indexOf('onSelect={item =>'), view!.indexOf('onSelect={item =>') + 700)
  assert.match(handler, /if \(item\.type !== 'fund'\)/)
  assert.match(handler, /onOpenFund\(item\)/)
  assert.ok(handler.indexOf("item.type !== 'fund'") < handler.indexOf('onOpenFund(item)'), 'fund check must guard onOpenFund')

  // Every row is a real button, so the whole row is keyboard reachable and has button semantics.
  assert.match(view!, /<button\s+type="button"\s+className="fia-fund-row"/)
  assert.match(view!, /aria-label=\{view\.ariaLabel\}/)
  assert.match(view!, /disabled=\{!view\.openable\}/)
  assert.match(view!, /openRow\(view\)/)
  assert.match(view!, /onOpenFund\(\{ code: view\.code, name: view\.name, type: 'fund' \}\)/)
})

check('loading, error/retry, empty, out-of-range page and search rejection are distinct states', () => {
  for (const copy of [
    '正在读取基金排行', '基金排行读取失败', '暂无基金排行数据', '页没有数据', '回到第一页',
    'T+1', '不是实时价格', 'FUND_SEARCH_ONLY_NOTE', '不显示总数或总页数',
  ]) assert.ok(view!.includes(copy), copy)
  assert.match(FUND_SEARCH_ONLY_NOTE, /只接受基金候选/)
  assert.match(view!, /role="status" aria-live="polite"/)
  assert.match(view!, /role="alert"/)
  assert.match(view!, /onClick=\{reload\}>重试/)
  assert.match(view!, /disabled=\{loading \|\| !pageState\.hasPrevious\}/)
  assert.match(view!, /disabled=\{loading \|\| !pageState\.hasNext\}/)
  assert.match(view!, /const pageState = fundPageState\(page, rows\.length, FUND_RANK_PAGE_SIZE\)/)
  assert.match(view!, /fundRankPath\(\{ type, sort, page, size: FUND_RANK_PAGE_SIZE \}\)/)
})

check('read-only and centralized formatting: no writes, network, storage, totals or fake zeros', () => {
  assert.doesNotMatch(view!, /\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|apiPost|addWatch|\bmutate\b/)
  assert.doesNotMatch(view!, /toFixed\(|Math\.pow/)
  assert.doesNotMatch(model!, /\?\?\s*0|\)\s*\|\|\s*0/)
  assert.match(view!, /from '\.\/fund-ui-model\.js'/)
  assert.match(view + model, /净值日期是数据日期，不是实时成交价/)
  // The page never asks for a total and the model never renders one.
  assert.doesNotMatch(view!, /totalCount|totalPages|\btotal:\s/)
  assert.match(FUND_SEARCH_ONLY_NOTE, /只接受基金候选/)
})

console.log(`\nFund UI: ${checks} pure/static checks passed. Browser appearance and live provider requests are not verified.`)
