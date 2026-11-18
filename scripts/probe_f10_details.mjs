// Small, read-only live contract probe. Prints response structure only; no raw data saved.
const base = 'https://emweb.securities.eastmoney.com/PC_HSF10/'
for (const module of ['CompanySurvey', 'BusinessAnalysis', 'CoreConception', 'ShareholderResearch', 'IndustryAnalysis']) {
  const url = `${base}${module}/PageAjax?code=SH601988`
  try {
    const response = await fetch(url, { headers: { Referer: base, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) })
    const json = await response.json()
    console.log(JSON.stringify({ at: new Date().toISOString(), module, status: response.status, url,
      tables: Object.entries(json).map(([key, rows]) => ({ key, count: Array.isArray(rows) ? rows.length : null, fields: Array.isArray(rows) && rows[0] ? Object.keys(rows[0]) : [] })) }))
  } catch (error) { console.log(JSON.stringify({ module, url, error: String(error) })) }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
