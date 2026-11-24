/**
 * 脚本渲染兜底（CDP）离线测试：不启动浏览器，只测判定、注入与接线。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findChrome, isAccessControlPage, looksScriptRendered, renderCdpPage, type CdpSession } from '../src/policy/browser-render.js'
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

function cdpFixture(payload: { html?: string; url?: string; error?: string }, event?: (emit: (method: string, params: Record<string, any>) => void) => void) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  let emit = (_method: string, _params: Record<string, any>) => {}
  const session: CdpSession = {
    send: async (method, params) => {
      calls.push({ method, params })
      if (method === 'Page.navigate') event?.(emit)
      return method === 'Runtime.evaluate' ? { result: { value: JSON.stringify(payload) } } : {}
    },
    onEvent: (listener) => { emit = listener; return () => { emit = () => {} } }, close: () => {},
  }
  return { calls, session }
}
const cdpOptions = { hosts: ['example.gov.cn'], maxBytes: 2000, settleMs: 0, scrollToBottom: false }
const allowedUrl = 'https://example.gov.cn/zhengce/list.html'

await check('CDP先启用请求拦截，跨域资源在发送前被阻断；身份不伪装浏览器', async () => {
  const fixture = cdpFixture({ html: '<html>政策列表</html>', url: allowedUrl }, (emit) => {
    emit('Fetch.requestPaused', { requestId: 'outside', resourceType: 'Script', request: { url: 'https://evil.example/a.js' } })
    emit('Fetch.requestPaused', { requestId: 'script', resourceType: 'Script', request: { url: 'https://example.gov.cn/static/app.js' } })
    emit('Fetch.requestPaused', { requestId: 'api', resourceType: 'XHR', request: { url: 'https://example.gov.cn/api/list' } })
  })
  const res = await renderCdpPage(fixture.session, allowedUrl, { ...cdpOptions, isUrlAllowed: (target) => target.startsWith('https://example.gov.cn/zhengce/') }, new AbortController().signal)
  assert.equal(res.ok, true)
  assert.ok(fixture.calls.findIndex((c) => c.method === 'Fetch.enable') < fixture.calls.findIndex((c) => c.method === 'Page.navigate'))
  assert.ok(fixture.calls.some((c) => c.method === 'Fetch.failRequest' && c.params?.requestId === 'outside'))
  assert.ok(fixture.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'script'))
  assert.ok(fixture.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'api'))
  assert.match(String(fixture.calls.find((c) => c.method === 'Network.setUserAgentOverride')?.params?.userAgent), /dsh-investment-assistant-policy/)
})

await check('CDP与注入渲染器都拒绝越界最终URL、超大DOM及访问控制页面', async () => {
  for (const payload of [
    { html: '<html>资料</html>', url: 'https://other.gov.cn/zhengce/list.html' },
    { html: '字'.repeat(2000), url: allowedUrl },
    { html: '<title>Access Denied</title>', url: allowedUrl },
  ]) {
    const fixture = cdpFixture(payload)
    const res = await renderCdpPage(fixture.session, allowedUrl, cdpOptions, new AbortController().signal)
    assert.equal(res.ok, false)
  }
  assert.equal(isAccessControlPage('<input type="password">'), true)
  for (const rendered of [{ ok: true, html: '<div>x</div>', url: 'https://other.gov.cn/list' }, { ok: true, html: '字'.repeat(2000), url: allowedUrl }]) {
    const res = await collectOfficialPages({ hosts: ['example.gov.cn', 'other.gov.cn'], timeoutMs: 100, maxBytes: 1000, store: {} } as never,
      { url: allowedUrl, dryRun: true, renderJs: true }, {
        gapMs: 0, fetch: (async (url: string) => ({ url, contentType: 'text/html', buffer: Buffer.from('<div id="app"></div>') })) as never,
        render: async () => rendered,
      })
    assert.equal(res.ok, false)
    assert.equal(res.renderedPages ?? 0, 0)
  }
})

await check('CDP导航越界/HTTP403/网络体积/身份验证一律失败，不尝试绕过', async () => {
  for (const [method, params] of [
    ['Fetch.requestPaused', { requestId: 'nav', resourceType: 'Document', request: { url: 'https://evil.example/private' } }],
    ['Network.responseReceived', { type: 'Document', response: { url: allowedUrl, status: 403 } }],
    ['Network.dataReceived', { dataLength: 9000 }],
    ['Fetch.authRequired', { requestId: 'auth' }],
  ] as Array<[string, Record<string, any>]>) {
    const fixture = cdpFixture({ html: '<html>内容</html>', url: allowedUrl }, (emit) => emit(method, params))
    const res = await renderCdpPage(fixture.session, allowedUrl, cdpOptions, new AbortController().signal)
    assert.equal(res.ok, false, method)
  }
})

await check('静态访问控制页面不开浏览器；渲染页预算为硬上限', async () => {
  let renders = 0
  const d = { hosts: ['example.gov.cn'], timeoutMs: 100, maxBytes: 2000, store: {} } as never
  const denied = await collectOfficialPages(d, { url: allowedUrl, renderJs: true }, {
    gapMs: 0, fetch: (async (url: string) => ({ url, contentType: 'text/html', buffer: Buffer.from('<title>登录验证</title>') })) as never,
    render: async () => { renders++; return { ok: true, html: '不应渲染' } },
  })
  assert.equal(denied.ok, false); assert.equal(renders, 0)
  const bounded = await collectOfficialPages(d, { url: allowedUrl, renderJs: true, renderMaxPages: 1, maxPages: 2, dryRun: true }, {
    gapMs: 0, fetch: (async (url: string) => ({ url, contentType: 'text/html', buffer: Buffer.from('<a href="/zhengce/next.html">下一页</a>') })) as never,
    render: async () => { renders++; return { ok: true, html: '<a href="/zhengce/next.html">下一页</a>' } },
  })
  assert.equal(renders, 1); assert.equal(bounded.skipped?.overRenderBudget, 1)
})

await check('CDP同源依赖仍受80次资源请求硬预算', async () => {
  const fixture = cdpFixture({ html: '<html>内容</html>', url: allowedUrl }, (emit) => {
    for (let i = 0; i < 81; i++) emit('Fetch.requestPaused', { requestId: String(i), resourceType: 'Script', request: { url: `https://example.gov.cn/static/${i}.js` } })
  })
  const res = await renderCdpPage(fixture.session, allowedUrl, cdpOptions, new AbortController().signal)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /80/)
  assert.ok(fixture.calls.some((c) => c.method === 'Fetch.failRequest' && c.params?.requestId === '80'))
})

console.log(`\n[policy-render] ${checks} 组通过（离线协议测试；本轮未启动真实Chrome）`)
