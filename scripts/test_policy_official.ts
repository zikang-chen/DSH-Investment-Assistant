/** Offline tests for official-page collection extractors and the panel prompt builder. */
import assert from 'node:assert/strict'
import {
  classifyAttachment, extractArticleLinks, extractAttachmentLinks, extractDate, extractNextPageUrls, extractTables, inWindow,
} from '../src/policy/official-collect.js'
import { officialCollectPrompt, isCollectableUrl } from '../src/client/policy-collect-model.js'

let passed = 0
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`) }

test('classifyAttachment recognises official file types', () => {
  assert.equal(classifyAttachment('https://www.pbc.gov.cn/a/b/shrzgm.xlsx'), 'xlsx')
  assert.equal(classifyAttachment('https://x.gov.cn/a/whitepaper.pdf'), 'pdf')
  assert.equal(classifyAttachment('https://x.gov.cn/a/data.csv'), 'csv')
  assert.equal(classifyAttachment('https://x.gov.cn/a/old.xls'), 'xls')
  assert.equal(classifyAttachment('https://x.gov.cn/a/page.html'), null)
})

test('extractDate handles Chinese and numeric dates', () => {
  assert.equal(extractDate('2026年3月5日 发布'), '2026-03-05')
  assert.equal(extractDate('2024-12'), undefined, '月份不是可信的发布日期')
  assert.equal(extractDate('t20260315_123.html'), '2026-03-15')
  assert.equal(extractDate('没有日期'), undefined)
})

test('extractAttachmentLinks finds only file links and dedupes', () => {
  const html = `
    <a href="/upload/2026/shrzgm.xlsx">2026年社会融资规模存量统计表</a>
    <a href="/upload/2026/shrzgm.xlsx">重复链接</a>
    <a href="/upload/whitepaper.pdf">白皮书全文</a>
    <a href="/news/index.html">新闻</a>`
  const atts = extractAttachmentLinks(html, 'https://www.pbc.gov.cn/diaochatongjisi/')
  assert.equal(atts.length, 2)
  assert.equal(atts[0]!.url, 'https://www.pbc.gov.cn/upload/2026/shrzgm.xlsx')
  assert.equal(atts[1]!.kind, 'pdf')
})

test('extractArticleLinks skips nav chrome by label length', () => {
  const html = `
    <a href="/rmyh/109339/index.html">术语表</a>
    <a href="/diaochatongjisi/116219/116319/t20260315_123.html">2026年2月社会融资规模存量统计数据</a>`
  const arts = extractArticleLinks(html, 'https://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html')
  assert.equal(arts.length, 1)
  assert.match(arts[0]!.label, /社会融资/)
  // 统计月份不能冒充发布日期，URL完整日期优先。
  assert.equal(arts[0]!.date, '2026-03-15')
})

test('extractNextPageUrls finds 下一页/Next', () => {
  const html = `<a href="/list_2.html">下一页</a><a href="/list_3.html">末页</a><a href="/x">Next</a>`
  const next = extractNextPageUrls(html, 'https://x.gov.cn/list_1.html')
  assert.deepEqual(next.sort(), ['https://x.gov.cn/list_2.html', 'https://x.gov.cn/x'].sort())
})

test('extractTables returns rows of cell text', () => {
  const html = `<table><tr><th>月份</th><th>存量</th></tr><tr><td>2026-02</td><td>420.1</td></tr></table>`
  const tables = extractTables(html)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0]!.rows[1], ['2026-02', '420.1'])
})

test('inWindow allows unknown dates and filters by range', () => {
  assert.equal(inWindow(undefined, '2020-01-01', '2020-12-31'), true, '未知日期不应被静默丢弃')
  assert.equal(inWindow('2026-03-05', '2026-01-01', '2026-12-31'), true)
  assert.equal(inWindow('2019-03', '2026-01-01'), true, '不可靠的月份不能作为发布日期筛掉文件')
  assert.equal(inWindow('2027-01-01', undefined, '2026-12-31'), false)
})

test('panel prompt encodes URL, page count, date range, and robots/no-bypass rule', () => {
  const prompt = officialCollectPrompt({ url: 'https://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html', from: '2024-01-01', pages: 5 })
  assert.match(prompt, /policy_collect_official/)
  assert.match(prompt, /最多翻 5 页/)
  assert.match(prompt, /2024-01-01/)
  assert.match(prompt, /robots\.txt/)
  assert.match(prompt, /不要绕过/)
  assert.equal(officialCollectPrompt({ url: 'u', pages: 999 }), officialCollectPrompt({ url: 'u', pages: 30 }), '页数上限 30')
  assert.equal(isCollectableUrl('https://www.pbc.gov.cn/x'), true)
  assert.equal(isCollectableUrl('javascript:alert(1)'), false)
  assert.equal(isCollectableUrl('not a url'), false)
})
console.log(`[policy-official] ${passed} groups passed (offline).`)
