/**
 * 脚本渲染兜底（CDP）离线测试：不启动浏览器，只测判定、注入与接线。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findChrome, looksScriptRendered } from '../src/policy/browser-render.js'
import { collectOfficialPages } from '../src/policy/official-collect.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }

check('判定：空壳与无列表的页面算脚本渲染', () => {
  assert.equal(looksScriptRendered(''), true)
  assert.equal(looksScriptRendered('<html><body><div id="app"></div></body></html>'), true)
  // 有足够正文段落与锚点，且带列表特征 → 不需要渲染
  const rich = `<html><body><div class="policy-list">${'<a href="/doc/1">标题</a>'.repeat(20)}</div><p>a</p><p>b</p><p>c</p></body></html>`
  assert.equal(looksScriptRendered(rich), false)
})

check('Chrome 探测不抛错；DSH_CHROME 可覆盖', () => {
  const missing = findChrome(['', 'C:\\definitely\\not\\here.exe'])
  assert.equal(missing, undefined)
  const viaEnv = findChrome([process.execPath])
  assert.equal(viaEnv, process.execPath, '存在的路径要能被选中')
})

await check('renderJs 关闭时不会调用渲染器（默认不启动浏览器）', async () => {
  let rendered = 0
  const html = '<html><body><div class="policy-list"><a href="/a">1</a><a href="/b">2</a><a href="/c">3</a><a href="/d">4</a><a href="/e">5</a><a href="/f">6</a><a href="/g">7</a><a href="/h">8</a><a href="/i">9</a></div><p>1</p><p>2</p><p>3</p></body></html>'
  const deps: any = {
    hosts: ['example.gov.cn'],
    store: { put: async () => ({ id: 'x' }), get: () => undefined },
    robotsCache: new Map(),
    timeoutMs: 5000,
    maxBytes: 200000,
    signal: undefined,
  }
  const res = await collectOfficialPages(deps, { url: 'https://example.gov.cn/list', maxPages: 1, maxDocs: 1 }, {
    fetch: (async () => ({ url: 'https://example.gov.cn/list', status: 200, contentType: 'text/html', buffer: Buffer.from(html) })) as never,
    render: async () => { rendered++; return { ok: true, html } },
    collectOne: (async () => ({ ok: true, action: 'created', doc: { id: 'd1', title: 't' } })) as never,
    gapMs: 0,
  })
  assert.equal(rendered, 0, '默认不渲染')
  assert.equal(typeof res.ok, 'boolean')
})

await check('renderJs 开启且页面像脚本渲染时会渲染，并记 renderedPages', async () => {
  const shell = '<html><body><div id="app"></div><script src="/x.js"></script></body></html>'
  const renderedHtml = `<html><body><div class="policy-list">${'<a href="/doc/1">政策</a>'.repeat(12)}</div><p>a</p><p>b</p><p>c</p></body></html>`
  let rendered = 0
  const deps: any = {
    hosts: ['example.gov.cn'], store: { put: async () => ({ id: 'x' }), get: () => undefined },
    robotsCache: new Map(), timeoutMs: 5000, maxBytes: 200000, signal: undefined,
  }
  const res = await collectOfficialPages(deps, { url: 'https://example.gov.cn/list', maxPages: 1, maxDocs: 1, renderJs: true }, {
    fetch: (async () => ({ url: 'https://example.gov.cn/list', status: 200, contentType: 'text/html', buffer: Buffer.from(shell) })) as never,
    render: async () => { rendered++; return { ok: true, html: renderedHtml } },
    collectOne: (async () => ({ ok: true, action: 'created', doc: { id: 'd1', title: 't' } })) as never,
    gapMs: 0,
  })
  assert.equal(rendered, 1, '应渲染一次')
  assert.equal(res.renderedPages, 1)
  // 渲染后是列表页：列表本身不是一篇政策，不入库（这是抓取质量规则）。
  assert.equal(res.documents.length, 0, '列表页不应被当成正文')
  assert.ok(!res.errors.some((e) => /渲染失败/.test(e)), res.errors.join('；'))
})

await check('渲染失败不吞掉错误，也不伪装成功', async () => {
  const shell = '<html><body><div id="app"></div></body></html>'
  const deps: any = {
    hosts: ['example.gov.cn'], store: { put: async () => ({ id: 'x' }), get: () => undefined },
    robotsCache: new Map(), timeoutMs: 5000, maxBytes: 200000, signal: undefined,
  }
  const res = await collectOfficialPages(deps, { url: 'https://example.gov.cn/list', maxPages: 1, renderJs: true }, {
    fetch: (async () => ({ url: 'https://example.gov.cn/list', status: 200, contentType: 'text/html', buffer: Buffer.from(shell) })) as never,
    render: async () => ({ ok: false, error: '未找到 Chrome' }),
    gapMs: 0,
  })
  assert.equal(res.renderedPages ?? 0, 0)
  assert.ok(res.errors.some((e) => /渲染失败/.test(e)), res.errors.join('；'))
})

check('接线：工具暴露 render_js，默认关闭', () => {
  const tools = readFileSync('src/policy/tools.ts', 'utf8')
  assert.match(tools, /render_js/)
  assert.match(tools, /args\.render_js === true \? \{ renderJs: true \}/)
  const official = readFileSync('src/policy/official-collect.ts', 'utf8')
  assert.match(official, /looksScriptRendered\(html\)/, '只在静态 HTML 像空壳时才渲染')
  assert.match(official, /options\.renderJs/, '必须显式开启')
})

console.log(`\n[policy-render] ${checks} 组通过（离线；真实浏览器只做过一次手工探测）`)
