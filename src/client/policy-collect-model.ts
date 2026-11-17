/** Pure helpers for the policy official-page collection UI (no DOM, no network). */

export interface OfficialCollectForm {
  url: string
  from?: string
  to?: string
  pages?: number
  maxDocs?: number
  attachments?: boolean
}

/** Build the natural-language instruction the panel sends to the agent. */
export function officialCollectPrompt(form: OfficialCollectForm): string {
  const url = form.url.trim()
  const pages = Math.max(1, Math.min(30, Math.floor(form.pages ?? 1) || 1))
  const maxDocs = Math.max(1, Math.min(50, Math.floor(form.maxDocs ?? 20) || 20))
  const lines = [
    '请使用 policy_collect_official 程序化采集这个官方页面：',
    `URL：${url}`,
    `最多翻 ${pages} 页；最多入库 ${maxDocs} 篇正文；附件下载：${form.attachments === false ? '否' : '是'}。`,
  ]
  if (form.from) lines.push(`只看 ${form.from} 之后发布的文件（历史回溯从这个日期起）。`)
  if (form.to) lines.push(`只看 ${form.to} 之前发布的文件。`)
  lines.push('要求：遵守 robots.txt 与允许清单；如遇到需要登录/验证码的页面，不要绕过，改为提示我用 policy_import 粘贴正文；完成后报告新增/更新/重复/失败、附件数量与覆盖日期区间。')
  return lines.join('\n')
}

/** Validate the URL is http(s) before enabling the button. */
export function isCollectableUrl(value: string): boolean {
  try {
    const u = new URL(value.trim())
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname)
  } catch {
    return false
  }
}
