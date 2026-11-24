/** Opt-in, read-only smoke test against an ALREADY RUNNING local DSH GUI. Does not start a server. */
if (!process.argv[2]) throw new Error('Usage: node scripts/check_finance_runtime.mjs <existing-local-GUI-URL>')
const base = new URL(process.argv[2])
if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Pass the existing loopback GUI URL')
const page = await fetch(base, { signal: AbortSignal.timeout(10_000) })
console.log(JSON.stringify({ check: 'existing-gui', status: page.status }))
await page.body?.cancel()
for (const path of ['/plugins/dsh-finance/api/global/kline?secid=101.GC00Y&limit=60', '/plugins/dsh-finance/api/global/gold-cfd?limit=60']) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) })
  const data = await response.json()
  console.log(JSON.stringify({ route: path, status: response.status, ok: data.ok, source: data.source, count: data.bars?.length, lastDate: data.bars?.at(-1)?.date, instrument: data.instrument, diagnostics: data.diagnostics, error: data.error }))
  if (path.includes('gold-cfd') && (!data.ok || data.instrument?.proxy !== true || data.instrument?.kind !== 'cfd')) process.exitCode = 1
}
console.log('HTTP/backend check only; browser rendering and user clicks are not verified.')
