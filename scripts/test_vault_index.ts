/** External-index recovery must preserve notes, documents and preview safeguards. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ResearchVault, type ResearchItem } from '../src/research/store.js'

let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }
async function fixture(run: (vault: ResearchVault, item: ResearchItem) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-vault-index-'))
  const vault = new ResearchVault(dir)
  try {
    const item = await vault.create({ title: '索引恢复测试', source: '离线测试', occurredAt: '2026-11-24', body: '原始正文，不得被覆盖。' })
    await run(vault, item)
  } finally { vault.stopWatching(); await rm(dir, { recursive: true, force: true }) }
}
const readIndex = async (vault: ResearchVault) => JSON.parse(await readFile(vault.indexPath, 'utf8')) as { items: ResearchItem[]; updatedAt: string }

await check('索引仅格式改变后追加批注，无需重载', () => fixture(async (vault, item) => {
  await writeFile(vault.indexPath, JSON.stringify(await readIndex(vault)))
  await vault.addNote(item.id, '恢复后的批注', '我')
  const saved = await vault.readDoc(item)
  assert.equal(saved.body, '原始正文，不得被覆盖。')
  assert.deepEqual(saved.notes.map(note => note.text), ['恢复后的批注'])
  const again = new ResearchVault(vault.dir); await again.load()
  assert.deepEqual(again.find(item.id)?.notes.map(note => note.text), ['恢复后的批注'])
}))

await check('采纳另一个实例的新增资料，不丢条目及已有批注', () => fixture(async (vault, item) => {
  const other = new ResearchVault(vault.dir); await other.load()
  const external = await other.create({ title: '外部新增', source: '测试', occurredAt: '2026-11-24', body: '外部正文。' })
  await other.addNote(item.id, '外部批注')
  await vault.addNote(item.id, '当前批注')
  assert.ok(vault.find(external.id))
  assert.deepEqual(vault.find(item.id)?.notes.map(note => note.text), ['外部批注', '当前批注'])
  assert.equal((await vault.readDoc(external)).body, '外部正文。')
}))

await check('采纳外部删除，不把旧缓存条目重新写回', () => fixture(async (vault, item) => {
  const removed = await vault.create({ title: '应被删除', source: '测试', occurredAt: '2026-11-24' })
  const other = new ResearchVault(vault.dir); await other.load(); await other.remove(removed.id)
  await vault.addNote(item.id, '保留资料的批注')
  assert.equal(vault.find(removed.id), undefined)
  await vault.syncFromDisk()
  assert.equal(vault.find(removed.id), undefined)
  assert.equal((await vault.readDoc(removed)).exists, false)
}))

await check('非法JSON连续失败不覆盖，修好后同一实例可继续写', () => fixture(async (vault, item) => {
  const valid = await readFile(vault.indexPath, 'utf8'), body = await readFile(path.join(vault.dir, item.file), 'utf8')
  await writeFile(vault.indexPath, '{ invalid json')
  for (let i = 0; i < 2; i++) await assert.rejects(vault.addNote(item.id, '不应保存'), /不是合法 JSON/)
  assert.equal(await readFile(vault.indexPath, 'utf8'), '{ invalid json')
  assert.equal(await readFile(path.join(vault.dir, item.file), 'utf8'), body)
  await writeFile(vault.indexPath, valid)
  await vault.addNote(item.id, '修复后保存')
  assert.equal(vault.find(item.id)?.notes.length, 1)
}))

await check('索引结构损坏/重复/路径越界不采纳也不覆盖', () => fixture(async (vault, item) => {
  const valid = await readFile(vault.indexPath, 'utf8'), original = vault.all()
  for (const payload of [null, {}, { items: [null] }, { items: [item, item] }, { items: [{ ...item, file: '../escape.md' }] }]) {
    const raw = JSON.stringify(payload)
    await writeFile(vault.indexPath, raw)
    await assert.rejects(vault.addNote(item.id, '不应保存'), /结构无效|路径越界/)
    assert.equal(await readFile(vault.indexPath, 'utf8'), raw)
    assert.deepEqual(vault.all(), original)
  }
  await writeFile(vault.indexPath, valid)
}))

await check('索引删除后sync可重建，Markdown及批注保持完整', () => fixture(async (vault, item) => {
  await vault.addNote(item.id, '原有批注')
  await unlink(vault.indexPath)
  await vault.syncFromDisk()
  await vault.addNote(item.id, '重建后的批注')
  assert.deepEqual((await readIndex(vault)).items[0]?.notes.map(note => note.text), ['原有批注', '重建后的批注'])
}))

await check('事务中索引被更改时有界重试，批注只追加一次', () => fixture(async (vault, item) => {
  const originalRead = vault.readDoc.bind(vault)
  let changed = false
  vault.readDoc = async current => {
    const doc = await originalRead(current)
    if (!changed) { changed = true; await writeFile(vault.indexPath, (await readFile(vault.indexPath, 'utf8')) + '\n') }
    return doc
  }
  await vault.addNote(item.id, '只追加一次')
  assert.deepEqual((await originalRead(item)).notes.map(note => note.text), ['只追加一次'])
}))

await check('持续索引竞争最多3次后失败，稍后可重试且不遗留批注', () => fixture(async (vault, item) => {
  const originalRead = vault.readDoc.bind(vault)
  let attempts = 0
  vault.readDoc = async current => {
    const doc = await originalRead(current); attempts++
    await writeFile(vault.indexPath, (await readFile(vault.indexPath, 'utf8')) + '\n')
    return doc
  }
  await assert.rejects(vault.addNote(item.id, '不应遗留'), /持续被其他进程修改/)
  assert.equal(attempts, 3)
  assert.deepEqual((await originalRead(item)).notes, [])
  vault.readDoc = originalRead
  await vault.addNote(item.id, '稍后成功')
  assert.deepEqual((await originalRead(item)).notes.map(note => note.text), ['稍后成功'])
}))

await check('外部Markdown修改仍需同步，不能用索引恢复绕过保护', () => fixture(async (vault, item) => {
  const file = path.join(vault.dir, item.file), before = await readFile(file, 'utf8')
  const external = before.replace('title: 索引恢复测试', 'title: 外部改名')
  assert.notEqual(external, before)
  await writeFile(file, external)
  await writeFile(vault.indexPath, (await readFile(vault.indexPath, 'utf8')) + '\n')
  await assert.rejects(vault.addNote(item.id, '不应覆盖'), /同步|变化/)
  assert.equal(await readFile(file, 'utf8'), external)
  await vault.syncFromDisk(); await vault.addNote(item.id, '同步后保存')
  assert.equal(vault.find(item.id)?.title, '外部改名')
}))

await check('目录监听也采纳外部index.json变化，不必等待下一次写入', () => fixture(async (vault, item) => {
  const targetStamp = '2026-11-24T11:00:00.000Z'
  let resolveChange!: () => void
  const changed = new Promise<void>(resolve => { resolveChange = resolve })
  const off = vault.onChange(() => { if (vault.stats().lastUpdatedAt === targetStamp) resolveChange() })
  vault.watch(undefined, 10)
  const index = await readIndex(vault); index.updatedAt = targetStamp
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(vault.indexPath, JSON.stringify(index))
    await Promise.race([changed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('index watcher did not adopt update')), 5000) })])
    await vault.syncFromDisk()
    await vault.addNote(item.id, '监听后追加')
    assert.equal(vault.find(item.id)?.notes.length, 1)
  } finally { if (timer) clearTimeout(timer); off(); vault.stopWatching() }
}))

console.log(`[vault-index] ${checks} offline groups passed`)
