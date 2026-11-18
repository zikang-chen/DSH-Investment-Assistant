/**
 * 生成 README 演示图：用 esbuild 打包真实组件 → 无头 Chrome 截图。
 *
 * 数据是 tools/demo/entry.tsx 里的示例数据，不读本机持仓、不请求网络。
 * 因此产物一律标注「示例数据」。
 *
 * 用法：node tools/demo/render.mjs [--shots]
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, 'docs', 'images')
const TMP = path.join(ROOT, 'tools', 'demo', '.out')
const CHROME = process.env.DSH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(TMP, { recursive: true })

const bundle = await build({
  entryPoints: [path.join(ROOT, 'tools/demo/entry.tsx')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
  jsx: 'automatic', logLevel: 'warning',
  alias: {
    react: path.join(ROOT, 'tools/demo/.deps/node_modules/react'),
    'react-dom': path.join(ROOT, 'tools/demo/.deps/node_modules/react-dom'),
  },
})
const js = bundle.outputFiles[0].text
const html = (theme) => `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8">
<title>投资助手 · 示例数据</title><style>
html,body{margin:0;background:${theme === 'dark' ? '#0d1117' : '#f5f6f8'}}
#banner{position:fixed;right:12px;bottom:10px;font:11px/1.6 system-ui;color:#8a8f99;letter-spacing:.02em}
</style></head><body><div id="root"></div><div id="banner">示例数据 · 非实机持仓</div>
<script>${js}</script></body></html>`

writeFileSync(path.join(TMP, 'light.html'), html('light'))
writeFileSync(path.join(TMP, 'dark.html'), html('dark'))

/** Minimal CDP client over Node's built-in WebSocket (no puppeteer). */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise(res => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })) }) }
}

async function withPage(fn) {
  const port = 9333
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(TMP, 'profile'), 'about:blank'],
  { stdio: 'ignore', detached: false })
  let target
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const list = await r.json()
      target = list.find(t => t.type === 'page'); if (target) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  if (!target) { proc.kill(); throw new Error('Chrome 未启动，无法截图') }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  try { await fn(cdp) } finally { try { ws.close() } catch {} ; proc.kill() }
}

const shot = async (cdp, { width, height, scale, file, scrollY = 0, clickTab, fill = [] }) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 })
  if (clickTab) {
    await cdp.send('Runtime.evaluate', { expression:
      `(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>x.textContent==='${clickTab}');if(b)b.click();return !!b})()` })
    await new Promise(r => setTimeout(r, 250))
  }
  if (fill.length) {
    // 受控输入必须走原生 setter + input 事件，React 才会更新 state。
    await cdp.send('Runtime.evaluate', { expression: `(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const inputs = [...document.querySelectorAll('input')]
      const pairs = ${JSON.stringify(fill)}
      for (const [i, v] of pairs) { const el = inputs[i]; if (!el) continue
        setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
      return inputs.length })()` })
    await new Promise(r => setTimeout(r, 250))
  }
  await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0,${scrollY});document.fonts?document.fonts.ready:1` })
  await new Promise(r => setTimeout(r, 450))
  const { result } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(path.join(OUT_DIR, file), Buffer.from(result.data, 'base64'))
  console.log('wrote', path.join('docs/images', file))
}

await withPage(async cdp => {
  await cdp.send('Page.navigate', { url: 'file:///' + path.join(TMP, 'light.html').replaceAll('\\', '/') })
  await new Promise(r => setTimeout(r, 900))
  // 面板在宿主里是 520px 侧栏；另有展开态。按真实宽度截，避免把窄栏布局拉成宽屏。
  await shot(cdp, { width: 520, height: 900, scale: 2, file: 'overview-light.png' })
  // 组合页：填入示例权重，避免截图全是空输入框（仍是示例数据）。
  await shot(cdp, { width: 520, height: 980, scale: 2, file: 'portfolio-light.png', clickTab: '组合策略',
    fill: [[0, '510300'], [2, '60'], [3, '60'], [5, '511010'], [7, '30'], [8, '30'], [10, '10'], [11, '5'], [12, '70'], [13, '90']] })
  await shot(cdp, { width: 960, height: 1000, scale: 2, file: 'overview-wide.png' })

  await cdp.send('Page.navigate', { url: 'file:///' + path.join(TMP, 'dark.html').replaceAll('\\', '/') })
  await new Promise(r => setTimeout(r, 900))
  await shot(cdp, { width: 520, height: 900, scale: 2, file: 'overview-dark.png' })
  await shot(cdp, { width: 390, height: 844, scale: 2, file: 'overview-mobile.png' })
})

try { rmSync(path.join(TMP, 'profile'), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }) }
catch { console.log('（Chrome 仍未释放临时 profile，可忽略；已 gitignore）') }
console.log('done')
