/** Shared ingestion and retrieval gate. Rejected text must not become policy evidence. */
import { isNavigationTitle } from './extract.js'
import type { PolicyDocument } from './types.js'

export function bodyQuality(text: string): { ok: boolean; chars: number; markers: number; reason?: string } {
  const body = String(text ?? '').replace(/\s+/g, '')
  const chars = body.length
  // Count occurrences, not distinct marker kinds (two copyright rows also fail).
  const markers = (body.match(/ICP备|网站标识码|版权所有|主办单位/g) ?? []).length
  if (chars < 300) return { ok: false, chars, markers, reason: `正文过短（${chars} 字 < 300）` }
  if (markers >= 2) return { ok: false, chars, markers, reason: `正文疑似页脚/备案信息（命中 ${markers} 次样板词）` }
  return { ok: true, chars, markers }
}

export function policyBodyIssue(doc: Pick<PolicyDocument, 'title' | 'text' | 'parseStatus' | 'parseError'>): string | undefined {
  if (doc.parseStatus !== 'ok') return `正文解析状态 ${doc.parseStatus || '未知'}：${doc.parseError || '未取得可引用正文'}`
  if (isNavigationTitle(doc.title)) return '栏目/导航页面不是政策正文'
  const quality = bodyQuality(doc.text)
  return quality.ok ? undefined : quality.reason
}
