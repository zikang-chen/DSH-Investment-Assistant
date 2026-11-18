// Manual read-only live probe: normalized counts/missing fields, no raw response persisted.
import { normalizeCompanySurvey, normalizeBusinessComposition, normalizeCoreConcepts, normalizeShareholderCount, normalizePeers } from '../src/data/eastmoney-f10.js'
const cases = [
  ['CompanySurvey', normalizeCompanySurvey], ['BusinessAnalysis', normalizeBusinessComposition],
  ['CoreConception', normalizeCoreConcepts], ['ShareholderResearch', normalizeShareholderCount], ['IndustryAnalysis', normalizePeers],
] as const
for (const [module, normalize] of cases) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/${module}/PageAjax?code=SH601988`
  try {
    const response = await fetch(url, { headers: { Referer: 'https://emweb.securities.eastmoney.com/' }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = normalize(await response.json()) as unknown as Record<string, any>
    console.log(JSON.stringify({ module, at: new Date().toISOString(), fields: Object.keys(data).filter(k => k !== 'meta'), rows: data.rows?.length, missing: data.meta?.missing, asOf: data.meta?.asOf, name: data.name, firstRowFields: data.rows?.[0] ? Object.keys(data.rows[0]).filter(k => data.rows[0][k] !== undefined) : undefined }))
  } catch (error) { console.log(JSON.stringify({ module, error: String(error) })) }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
