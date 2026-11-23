/** 渲染 tools/demo/intraday-entry.tsx 的分时图示例，产物只写到 tools/demo/.out/。 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const TMP = path.join(ROOT, 'tools', 'demo', '.out')
const CHROME = process.env.DSH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
mkdirSync(TMP, { recursive: true })

const bundle = await build({
  entryPoints: [path.join(ROOT, 'tools/demo/intraday-entry.tsx')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
  jsx: 'automatic', logLevel: 'warning',
  alias: {
    react: path.join(ROOT, 'tools/demo/.deps/node_modules/react'),
    'react-dom': path.join(ROOT, 'tools/demo/.deps/node_modules/react-dom'),
  },
})
// 真实面板由设计系统注入这些变量；独立页面必须自己给，否则 stroke/fill 的 var() 无效值会被当成 none。
const TOKENS = `:root{--fia-up:#AF3444;--fia-down:#176B4B;--fia-brand:#1D4D7D;--fia-warning:#8A5700;--fia-border:#D5DEE6;--fia-muted:#5E6D7B;--fia-text:#182B3A;--fia-surface:#FFFFFF}`
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#f3f5f7;color:#182B3A}${TOKENS}</style></head>
<body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`
const page = path.join(TMP, 'intraday.html')
writeFileSync(page, html)

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })) }) }
}

const port = 9334
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(TMP, 'profile-intraday'), 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 60; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target) break } catch {}
  await new Promise((r) => setTimeout(r, 250))
}
if (!target) { proc.kill(); throw new Error('Chrome 未启动') }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new CDP(ws)
await cdp.send('Page.enable')
try {
  // 与面板一致：跟随浅色主题渲染（无头 Chrome 默认可能给暗色）。
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  // 十字光标：hover 到港股面板约 62% 处，截该图区域，确认竖线/横线/价签/浮层都出现。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 1500, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Page.navigate', { url: 'file:///' + page.replaceAll('\\', '/') })
  await new Promise((r) => setTimeout(r, 1400))
  const box = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {    const el = document.querySelector('[data-shot="hk-full"] canvas')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.x + r.width * 0.62, clientY: r.y + r.height * 0.3, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    return { x: r.x, y: r.y, width: r.width, height: r.height + 26 }
  })()` })
  await new Promise((r) => setTimeout(r, 350))
  if (box.result?.exceptionDetails) throw new Error('指针派发失败：' + JSON.stringify(box.result.exceptionDetails.exception?.description ?? box.result.exceptionDetails))
  const clip = box.result.result.value
  if (!clip) throw new Error('未取到画布位置')
  const { result: crossShot } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: Math.max(0, clip.x - 6), y: Math.max(0, clip.y - 26), width: clip.width + 12, height: clip.height, scale: 2 },
  })
  writeFileSync(path.join(TMP, 'intraday-crosshair.png'), Buffer.from(crossShot.data, 'base64'))
  console.log('wrote', path.join('tools/demo/.out', 'intraday-crosshair.png'))

  for (const [width, name] of [[680, 'intraday-wide.png'], [390, 'intraday-narrow.png']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1500, deviceScaleFactor: 2, mobile: width < 600 })
    await cdp.send('Page.navigate', { url: 'file:///' + page.replaceAll('\\', '/') })
    await new Promise((r) => setTimeout(r, 1400))
    const { result } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(path.join(TMP, name), Buffer.from(result.data, 'base64'))
    console.log('wrote', path.join('tools/demo/.out', name))
  }
} finally { try { ws.close() } catch {} ; proc.kill() }
