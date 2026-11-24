/**
 * 正文质量闸门测试：太短或页脚样板词过多必须拒绝入库。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bodyQuality, collectOne, importFile, importText } from '../src/policy/collect.js'
import { policyEvidenceLevel } from '../src/policy/evidence.js'
import { mirrorPolicyToVault } from '../src/policy/vault-bridge.js'
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

await check('样板词按出现次数而非种类计数；300字严格边界', () => {
  assert.equal(bodyQuality('字'.repeat(299)).ok, false)
  assert.equal(bodyQuality('字'.repeat(300)).ok, true)
  assert.equal(bodyQuality(`${longBody}版权所有 版权所有`).markers, 2)
  assert.equal(bodyQuality(`${longBody}版权所有 版权所有`).ok, false)
  assert.equal(bodyQuality(`${longBody}ICP备123 ICP备456`).ok, false)
  assert.equal(bodyQuality(' \n\t').ok, false)
})

await check('网络空串/未知格式/栏目与手工空串/短文/重复样板均parse_failed且不写正文或快照', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-gate-all-'))
  try {
    const store = new PolicyStore(dir); await store.load()
    const deps = { hosts: ['example.gov.cn'], store, timeoutMs: 100, maxBytes: 500000 }
    const input = { url: 'https://example.gov.cn/policy.html', sourceId: 'fixture', sourceClass: 'official' as const, issuer: '国务院', docType: 'other' as const }
    for (const [contentType, body] of [
      ['text/html', ''], ['application/octet-stream', 'unknown binary'],
      ['text/html', `<title>政策法规</title><p>${longBody}</p>`],
      ['text/html', `<title>关于开展专项工作的通知</title><p>${longBody}版权所有 版权所有</p>`],
    ]) {
      const res = await collectOne(deps, input, { fetch: async () => ({ url: input.url, status: 200, contentType, buffer: Buffer.from(body!), bytes: Buffer.byteLength(body!) }) })
      assert.equal(res.ok, false, String(body)); assert.equal(res.parseStatus, 'parse_failed')
    }
    for (const text of ['', '短文', `${longBody}主办单位 主办单位`]) {
      const res = await importText(deps, { title: '关于开展专项工作的通知', text })
      assert.equal(res.ok, false); assert.equal(res.parseStatus, 'parse_failed')
    }
    const file = path.join(dir, 'bad.html')
    await writeFile(file, `<title>关于开展专项工作的通知</title><p>${longBody}版权所有 版权所有</p>`)
    assert.equal((await importFile(deps, file, { title: '关于开展专项工作的通知' })).ok, false)
    assert.equal(store.stats().total, 0)
    assert.deepEqual(await readdir(path.join(dir, 'documents')), [])
    assert.deepEqual(await readdir(path.join(dir, 'originals')), [])
    const valid = await importText(deps, { title: '关于开展专项工作的通知', text: longBody })
    assert.equal(valid.ok, true, valid.error)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

await check('历史failed/栏目/不合格正文不参与检索、不升级E1、不镜像资料库', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-gate-legacy-'))
  try {
    const store = new PolicyStore(dir); await store.load()
    for (const [key, title, text, parseStatus] of [
      ['failed', '关于推进新型储能工作的通知', longBody, 'failed'],
      ['nav', '政策文件', longBody, 'ok'], ['short', '关于推进新型储能工作的说明', '储能', 'ok'],
    ] as const) {
      const { doc } = await store.upsert({ title, text, parseStatus, contentHash: key, sourceId: 'fixture', sourceClass: 'official', issuer: '国务院', docType: 'other', originalPath: '', canonicalUrl: `https://example.gov.cn/${key}`, measurableTargets: [{ metric: '储能装机', value: '3000', paragraph: 0 }], extractionVersion: 'legacy/1' })
      assert.equal(policyEvidenceLevel(doc).level, 'unverified')
      assert.equal(store.search({ query: '政策 储能' }).some((hit) => hit.doc.id === doc.id), false)
      await assert.rejects(() => mirrorPolicyToVault({} as never, doc), /不可归档/)
    }
    assert.deepEqual(store.search({}), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

await check('不同待解析PDF按原始字节去重，不能因空text串成同一政策', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-pdf-identity-'))
  try {
    const store = new PolicyStore(dir); await store.load()
    const deps = { hosts: ['example.gov.cn'], store, timeoutMs: 100, maxBytes: 500000 }
    const first = await importText(deps, { title: '第一份政策白皮书', text: '', parseStatus: 'pdf-pending', originalBuffer: Buffer.from('%PDF-first') })
    const second = await importText(deps, { title: '第二份政策白皮书', text: '', parseStatus: 'pdf-pending', originalBuffer: Buffer.from('%PDF-second') })
    assert.equal(first.ok, true); assert.equal(second.ok, true)
    assert.notEqual(first.doc?.id, second.doc?.id)
    assert.notEqual(first.doc?.contentHash, second.doc?.contentHash)
    assert.deepEqual(store.search({}), [], '待解析PDF不是可检索正文')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

await check('有效正文加外层footer允许；只有页脚样板充当正文拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-policy-body-footer-'))
  try {
    const store = new PolicyStore(dir); await store.load()
    const deps = { hosts: ['example.gov.cn'], store, timeoutMs: 100, maxBytes: 500000 }
    const input = { url: 'https://example.gov.cn/report.html', sourceId: 'fixture', sourceClass: 'official' as const, issuer: '国务院', docType: 'other' as const }
    const html = `<title>关于开展专项工作的通知</title><article><p>${longBody}</p></article><footer>ICP备123 主办单位：国务院 版权所有</footer>`
    const res = await collectOne(deps, input, { fetch: async () => ({ url: input.url, status: 200, contentType: 'text/html', buffer: Buffer.from(html), bytes: Buffer.byteLength(html) }) })
    assert.equal(res.ok, true, res.error)
    assert.ok(!res.doc?.text.includes('ICP备'))
    const footer = '<title>关于网站信息的说明</title><p>网站标识码 主办单位 版权所有 ICP备123</p>'.repeat(20)
    const bad = await collectOne(deps, { ...input, url: 'https://example.gov.cn/footer.html' }, { fetch: async () => ({ url: input.url, status: 200, contentType: 'text/html', buffer: Buffer.from(footer), bytes: Buffer.byteLength(footer) }) })
    assert.equal(bad.ok, false)
    assert.equal(bad.parseStatus, 'parse_failed')
    assert.equal(store.stats().total, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

console.log(`\n[policy-body-gate] ${checks} 组通过（离线）`)
