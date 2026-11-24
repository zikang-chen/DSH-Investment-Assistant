/**
 * 抓取预算与范围的离线测试：不联网，只验证「可控性」。
 */
import assert from 'node:assert/strict'
import { collectOfficialPages } from '../src/policy/official-collect.js'
import { isNavigationTitle, pageTitleOf } from '../src/policy/extract.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }

const deps: any = () => ({
  hosts: ['example.gov.cn'], store: { put: async () => ({ id: 'x' }), get: () => undefined },
  robotsCache: new Map(), timeoutMs: 5000, maxBytes: 500000, signal: undefined,
})

const listHtml = (count: number, prefix = '/zhengce/') => `<html><head><title>政策文件</title></head><body>
  ${Array.from({ length: count }, (_, i) => `<a href="${prefix}content_${i}.htm">关于做好第${i}项工作的通知</a>`).join('\n')}
  <a href="/about/index.html">国务院部门网站导航</a>
  <p>a</p><p>b</p><p>c</p></body></html>`

const articleHtml = '<html><head><title>关于做好第1项工作的通知</title></head><body><p>正文一</p><p>正文二</p><p>正文三</p></body></html>'

const run = async (options: Record<string, unknown>, pages: Record<string, string>, runtime: Record<string, unknown> = {}) => {
  const imported: string[] = []
  const res = await collectOfficialPages(deps(), { url: 'https://example.gov.cn/zhengce/index.html', ...options } as never, {
    fetch: (async (url: string) => ({
      url,
      status: 200,
      contentType: 'text/html',
      buffer: Buffer.from(pages[new URL(url).pathname] ?? articleHtml),
    })) as never,
    collectOne: (async (_d: unknown, input: { url: string }) => { imported.push(input.url); return { ok: true, action: 'created', doc: { id: `doc-${imported.length}`, title: 't' } } }) as never,
    gapMs: 0,
    ...runtime,
  } as never)
  return { res, imported }
}

await check('dryRun 只给计划：不入库、不改 attachments', async () => {
  const { res, imported } = await run({ dryRun: true, maxPages: 2, maxDocs: 10 }, { '/zhengce/index.html': listHtml(6) })
  assert.equal(imported.length, 0, 'dryRun 不能入库')
  assert.ok((res.plan ?? []).length >= 6, '计划里应有发现的文章链接')
  assert.equal(res.documents.length, 0)
})

await check('路径前缀：越界的页脚链接被排除', async () => {
  const { res } = await run({ dryRun: true }, { '/zhengce/index.html': listHtml(5) })
  const urls = (res.plan ?? []).map((p) => p.url)
  assert.ok(urls.every((u) => u.includes('/zhengce/')), '不应出现 /about/ 之类越界链接')
  assert.ok((res.skipped?.linksOutOfScope ?? 0) >= 1, '越界链接要计数')
})

await check('URL 正则：只跟随匹配的链接', async () => {
  const html = `<html><body>
    <a href="/zhengce/content_1.htm">关于第一项工作的通知</a>
    <a href="/zhengce/other_1.htm">其他栏目入口页面</a>
    <p>a</p><p>b</p><p>c</p></body></html>`
  const { res } = await run({ dryRun: true, urlPattern: 'content_' }, { '/zhengce/index.html': html })
  const urls = (res.plan ?? []).map((p) => p.url)
  assert.ok(urls.some((u) => u.includes('content_1')), '匹配的应保留')
  assert.ok(!urls.some((u) => u.includes('other_1')), '不匹配的应排除')
})

await check('链接预算：超过上限就不再跟随，并计数', async () => {
  const { res } = await run({ dryRun: true, maxLinks: 3 }, { '/zhengce/index.html': listHtml(12) })
  assert.ok((res.plan ?? []).length <= 3, `计划不应超过预算，实际 ${(res.plan ?? []).length}`)
  assert.ok((res.skipped?.overLinkBudget ?? 0) >= 1, '超预算要计数')
})

await check('非法正则直接报错，不静默放行', async () => {
  const { res } = await run({ dryRun: true, urlPattern: '([' }, { '/zhengce/index.html': listHtml(3) })
  assert.equal(res.ok, false)
  assert.match(res.errors.join('；'), /正则/)
})

await check('列表页本身不被当成一篇政策', async () => {
  const { imported } = await run({ maxPages: 1, maxDocs: 5 }, { '/zhengce/index.html': listHtml(6) })
  assert.ok(!imported.includes('https://example.gov.cn/zhengce/index.html'), '索引页不应入库')
})

await check('导航标题被过滤，正文标题保留', async () => {
  assert.equal(isNavigationTitle('国务院部门网站'), true)
  assert.equal(isNavigationTitle('首页'), true)
  assert.equal(isNavigationTitle('关于2027年部分节假日安排的通知'), false)
  assert.equal(pageTitleOf('<html><head><title> 某某通知 </title></head></html>'), '某某通知')
  assert.equal(pageTitleOf('<html></html>'), undefined)
})

await check('remove 必须真正落盘：重新加载不会复活', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { PolicyStore } = await import('../src/policy/store.js')
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-'))
  try {
    await mkdir(path.join(dir, 'documents'), { recursive: true })
    await mkdir(path.join(dir, 'history', 'pol-x'), { recursive: true })
    await writeFile(path.join(dir, 'documents', 'pol-x.json'), JSON.stringify({
      id: 'pol-x', title: '测试文档', url: 'https://example.gov.cn/a.htm', sourceId: 's', sourceClass: 'official',
      docType: 'other', issuer: '测试机关', publishedAt: '2026-01-01', legalEffect: 'unknown', status: 'unknown',
      paragraphs: ['第一段'], text: '第一段', tags: [], relatedIndustries: [], relatedAssets: [], documentNumber: '',
      contentHash: 'abc', originalFile: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      version: 1, parseStatus: 'ok',
    }))
    const store = new PolicyStore(dir); await store.load()
    assert.equal(store.get('pol-x')?.title, '测试文档')
    assert.equal(await store.remove('pol-x'), true)
    const again = new PolicyStore(dir); await again.load()
    assert.equal(again.get('pol-x'), undefined, '重新加载后不应复活')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

console.log(`\n[policy-bounds] ${checks} 组通过（离线；真实站点未跑）`)
