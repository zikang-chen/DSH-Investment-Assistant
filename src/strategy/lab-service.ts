import { runStrategyExperiment } from './lab.js'
import { httpGetJson } from '../data/http.js'
import type { KlineBar } from '../types.js'

/** Dedicated raw-price path: never read hfq chart caches as executable prices. */
export async function fetchStrategyExperiment(codeInput: string, initialCash = 100000) {
  const code = codeInput.trim()
  if (!/^(600|601|603|605|000|001|002)\d{3}$/.test(code)) return { ok: false, reason: '当前仅支持普通A股主板价格实验；不支持基金、海外、科创/创业/北交所。' }
  if (!Number.isFinite(initialCash) || initialCash <= 0 || initialCash > 1e9) return { ok: false, reason: '模拟本金必须为0至10亿元间的有限正数' }
  const base = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
  const params = { secid: `${code.startsWith('6') ? '1' : '0'}.${code}`, ut: 'b2884a393a59ad64002292a3e90d46a5', klt: '101', fqt: '0', beg: '19900101', end: '20500101', lmt: '1200', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56' }
  try {
    const raw = await httpGetJson<{ data?: { name?: string; klines?: string[] } }>(base, params, { timeoutMs: 30000, referer: 'https://quote.eastmoney.com/' })
    if (/ST|退/.test(raw.data?.name ?? '') || !raw.data?.name) return { ok: false, reason: '名称缺失或为ST/退市风险标的，现有涨跌停假设不适用' }
    const bars: KlineBar[] = (raw.data?.klines ?? []).slice(-1200).map(line => {
      const [date, open, close, high, low, volume] = line.split(',')
      return { date: date!, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume) }
    })
    return runStrategyExperiment({ code, currency: 'CNY', adjustment: 'none', bars, initialCash, source: `${base}?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString()}`, fetchedAt: new Date().toISOString() })
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
}
