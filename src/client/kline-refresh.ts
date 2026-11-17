/** Refresh cadence is based on fetch time, not whether a daily candle already says today. */
export function shouldRefreshKline(now: number, lastAttempt?: number, intervalMs = 90_000): boolean {
  return lastAttempt === undefined || now - lastAttempt >= intervalMs
}

/** Only an overlap window is needed to update the current, still-forming daily candle. */
export function klineRefreshSince(newest: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newest)) return undefined
  const day = new Date(`${newest}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== newest) return undefined
  return new Date(day.getTime() - 5 * 86_400_000).toISOString().slice(0, 10)
}
