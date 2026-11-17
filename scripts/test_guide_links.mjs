import fs from 'node:fs'
import path from 'node:path'
const files = ['README.md', 'docs/complete-guide.md', 'docs/history-kline.md', 'docs/policy-collection.md']
let checked = 0
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\]\(<?([^)>]+)>?\)/g)) {
    const url = match[1]
    if (/^(https?:|#)/.test(url)) continue
    const target = path.resolve(path.dirname(file), url.split('#')[0])
    if (!fs.existsSync(target)) throw new Error(`${file}: missing ${url}`)
    checked++
  }
}
console.log(`PASS documentation local links: ${checked}`)
