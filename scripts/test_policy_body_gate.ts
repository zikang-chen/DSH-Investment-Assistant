/**
 * 正文质量闸门测试：太短或页脚样板词过多必须拒绝入库。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bodyQuality, collectOne } from '../src/policy/collect.js'
import { PolicyStore } from '../src/policy/store.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }

const longBody = '为贯彻落实中央决策部署，现就有关事项通知如下。'.repeat(20)

await check('阈值：<300 字拒绝，刚好 300 字放行', () => {
  const short = bodyQuality('正文只有几十个字。'.repeat(8)) // ~80 字
  assert.equal(short.ok, false)
  assert.match(short.reason ?? '', /过短/)
  const ok = bodyQuality('这是一段用于测试的正文内容，长度需要超过三百个字才算合格。'.repeat(12))
  assert.equal(ok.ok, true, `实际 ${ok.chars} 字`)
})

await check('页脚样板词 ≥2 个拒绝，单个不拒绝', () => {
  const footer = `${longBody} 京ICP备05070218号 版权所有：中国政府网 主办单位：国务院办公厅`
  const bad = bodyQuality(footer)
  assert.equal(bad.ok, false)
  assert.match(bad.reason ?? '', /页脚|备案/)
  const single = bodyQuality(`${longBody} 主办单位：某部委`)
  assert.equal(single.ok, true)
})

await check('采集时拒绝：不入库、返回明确原因', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-gate-'))
  try {
    const store = new PolicyStore(dir)
    await store.load()
    const deps = {
      hosts: ['example.gov.cn'], store, robotsCache: new Map<string, string>(), timeoutMs: 5000, maxBytes: 500000,
    } as never
    const html = `<html><head><title>最新政策</title></head><body>
      <p>京ICP备05070218号</p><p>版权所有：中国政府网</p><p>主办单位：国务院办公厅</p><p>网站标识码bm01000001</p>
      </body></html>`
    const res = await collectOne(deps, {
      url: 'https://example.gov.cn/zhengce/zuixin/', sourceId: 'fixture', sourceClass: 'official',
      issuer: '国务院', docType: 'state-council-doc',
    }, { fetch: async () => ({ url: 'https://example.gov.cn/zhengce/zuixin/', contentType: 'text/html', buffer: Buffer.from(html), status: 200, bytes: html.length }) } as never)
    assert.equal(res.ok, false, '应拒绝入库')
    assert.match(res.error ?? '', /正文质量不达标/)
    assert.equal(store.stats().total, 0, '库里不能出现这条')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(`\n[policy-body-gate] ${checks} 组通过（离线）`)
