/**
 * 录制 README 演示 GIF：脚本驱动真实组件（示例数据），逐帧截图后自行编码。
 * 产物：docs/images/demo.gif
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readPNG, buildPalette, quantize, encodeGIF } from './gif.mjs'

const ROOT = process.cwd()
const OUT = path.join(ROOT, 'docs', 'images', 'demo.gif')
const TMP = path.join(ROOT, 'tools', 'demo', '.out')
const CHROME = process.env.DSH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const W = 460, H = 760

mkdirSync(path.dirname(OUT), { recursive: true })
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
writeFileSync(path.join(TMP, 'reel.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;background:#f5f6f8}</style>
</head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise(res => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })) }) }
}

const port = 9334
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(TMP, 'profile-gif'), 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 60; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find(t => t.type === 'page'); if (target) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}
if (!target) { proc.kill(); throw new Error('Chrome 未启动') }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new CDP(ws)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
// 无头 Chrome 默认偏好深色；演示 GIF 固定浅色，避免首帧变深色。
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await cdp.send('Page.navigate', { url: 'file:///' + path.join(TMP, 'reel.html').replaceAll('\\', '/') })
await new Promise(r => setTimeout(r, 1200))

const frames = []
const grab = async () => {
  const { result } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const png = readPNG(Buffer.from(result.data, 'base64'))
  png.encoded = result.data
  frames.push(png)
}
const run = async (expression, wait = 320) => { await cdp.send('Runtime.evaluate', { expression }); await new Promise(r => setTimeout(r, wait)) }
const clickTab = (label) => run(`(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>x.textContent==='${label}');b&&b.click();return !!b})()`)
const scrollTo = (y) => run(`window.scrollTo({top:${y},behavior:'smooth'});1`, 420)
const fill = () => run(`(()=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
  const i=[...document.querySelectorAll('input')]
  for(const [n,v] of [[0,'510300'],[2,'60'],[3,'60'],[5,'511010'],[7,'30'],[8,'30'],[10,'10'],[11,'5'],[12,'70'],[13,'90']]){if(i[n]){s.call(i[n],v);i[n].dispatchEvent(new Event('input',{bubbles:true}))}}
  return i.length})()`, 320)

// 1) 总览，向下滚两屏
await grab()
await scrollTo(520); await grab(); await grab()
await scrollTo(1000); await grab(); await grab()
// 2) 回顶部，切到组合策略
await scrollTo(0)
await clickTab('组合策略'); await grab(); await grab()
await fill(); await grab(); await grab(); await grab()
await scrollTo(560); await grab(); await grab()
await scrollTo(980); await grab()

ws.close(); proc.kill()

const palette = buildPalette()
const indexed = frames.map(f => ({ width: f.width, height: f.height, indices: quantize(f.rgba, palette) }))
const gif = encodeGIF(indexed, palette, 45)
writeFileSync(OUT, gif)
writeFileSync(path.join(TMP, 'last-frame.png'), Buffer.from(frames.at(-1).encoded, 'base64'))
console.log(`wrote ${path.relative(ROOT, OUT)}: ${frames.length} frames, ${(gif.length / 1024).toFixed(0)} KB, ${W}x${H}`)
