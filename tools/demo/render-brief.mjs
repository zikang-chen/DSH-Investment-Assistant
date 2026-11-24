import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const ROOT = process.cwd(), TMP = path.join(ROOT, 'tools', 'demo', '.out')
const CHROME = process.env.DSH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
mkdirSync(TMP, { recursive: true })
const bundle = await build({ entryPoints: [path.join(ROOT, 'tools/demo/brief-entry.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', logLevel: 'warning',
  alias: { react: path.join(ROOT, 'tools/demo/.deps/node_modules/react'), 'react-dom': path.join(ROOT, 'tools/demo/.deps/node_modules/react-dom') } })
const TOKENS = ':root{--fia-up:#AF3444;--fia-down:#176B4B;--fia-border:#D5DEE6;--fia-muted:#5E6D7B;--fia-surface:#FFFFFF;--fia-surface-muted:#F6F8FA;--fia-secondary:#4A5C6C;--fia-text:#182B3A;--fia-danger:#AF3444;--fia-warning:#8A5700;--fia-selected:#E6EFF8}'
const page = path.join(TMP, 'brief.html')
writeFileSync(page, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#f3f5f7}${TOKENS}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
class CDP { constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);p(m)}})} send(method,params={}){const id=++this.id;return new Promise(res=>{this.pending.set(id,res);this.ws.send(JSON.stringify({id,method,params}))})} }
const port = 9337
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--user-data-dir=' + path.join(TMP, 'profile-brief'), 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find(t => t.type === 'page'); if (target) break } catch {} await new Promise(r => setTimeout(r, 250)) }
if (!target) { proc.kill(); throw new Error('Chrome 未启动') }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new CDP(ws); await cdp.send('Page.enable')
try {
  for (const [width, name] of [[720, 'brief-wide.png'], [390, 'brief-narrow.png']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 2, mobile: width < 600 })
    await cdp.send('Page.navigate', { url: 'file:///' + page.replaceAll('\\', '/') })
    await new Promise(r => setTimeout(r, 1500))
    const { result } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(path.join(TMP, name), Buffer.from(result.data, 'base64'))
    console.log('wrote', path.join('tools/demo/.out', name))
  }
} finally { try { ws.close() } catch {} ; proc.kill() }
