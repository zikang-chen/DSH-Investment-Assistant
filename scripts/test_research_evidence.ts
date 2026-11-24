/** Local evidence contracts: no fabricated dates, missing files or summaries claimed as full text. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectResearch, registerResearchTools } from '../src/research/tools.js'
import { ResearchVault } from '../src/research/store.js'

let checks = 0
async function check(name: string, run: () => Promise<void>) { await run(); checks++; console.log('PASS', name) }
type TestTool = { name: string; execute: (args: Record<string, unknown>) => Promise<any> }
async function fixture(run: (vault: ResearchVault, tools: Record<string, TestTool>) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-research-evidence-'))
  const vault = new ResearchVault(dir); await vault.load()
  const tools: Record<string, TestTool> = {}
  registerResearchTools({ tools: { register: (tool: TestTool) => { tools[tool.name] = tool } } } as never, {} as never, vault, { publish() {} } as never)
  try { await run(vault, tools) } finally { vault.stopWatching(); await rm(dir, { recursive: true, force: true }) }
}

await check('缺失/无效日期跳过，不把采集日填成资料日', () => fixture(async vault => {
  const finance = { getStockNews: async () => ({ ok: true, data: [
    { title: '缺日期', source: 'fixture' },
    { title: '坏日期', date: '2026-02-30', source: 'fixture' },
    { title: '真实资料日期', date: '2026-11-23T22:30:00+08:00', source: 'fixture' },
  ] }) }
  const result = await collectResearch(finance as never, vault, { code: '600000', kind: 'news' })
  assert.equal(result.saved, 1); assert.equal(result.skipped, 2)
  assert.equal(result.items[0]?.occurredAt, '2026-11-23')
  assert.ok(result.skippedList?.every(row => /发布日期/.test(row.reason)))
}))

await check('未取得研报原文时，Agent明确读到summary-only', () => fixture(async (vault, tools) => {
  const finance = {
    getResearchReports: async () => ({ ok: true, data: [
      { id: 'report-1', title: '只取得摘要的研报', time: '2026-11-23', org: '离线测试机构', summary: '摘要不是原文。' },
    ] }),
    getResearchReportDetail: async () => ({ ok: true, data: { body: '' } }),
  }
  const result = await collectResearch(finance as never, vault, { code: '600000', kind: 'report', withBody: true })
  assert.equal(result.saved, 1); assert.equal(result.errors?.length, 1)
  const read = await tools.get_research!.execute({ id: result.items[0]!.id })
  assert.equal(read.ok, true); assert.equal(read.contentStatus, 'summary-only')
  assert.match(read.body, /未取得原文正文/)
}))

await check('取得研报原文时保留body口径，资料日不取抓取时间', () => fixture(async (vault, tools) => {
  const finance = {
    getResearchReports: async () => ({ ok: true, data: [{ id: 'full-1', title: '完整研报', time: '2026/11/22', org: '离线测试机构' }] }),
    getResearchReportDetail: async () => ({ ok: true, data: { body: '实际获取的原文（测试夹具）。' } }),
  }
  const result = await collectResearch(finance as never, vault, { code: '600000', kind: 'report', withBody: true })
  const read = await tools.get_research!.execute({ id: result.items[0]!.id })
  assert.equal(read.contentStatus, 'body'); assert.equal(read.body, '实际获取的原文（测试夹具）。')
  assert.equal(read.item.occurredAt, '2026-11-22')
}))

await check('正文文件已删除时，get_research不返回ok:true空正文', () => fixture(async (vault, tools) => {
  const item = await vault.create({ title: '测试缺失正文', source: 'fixture', occurredAt: '2026-11-23', body: '不能伪造已读。' })
  await unlink(path.join(vault.dir, item.file))
  const read = await tools.get_research!.execute({ id: item.id })
  assert.equal(read.ok, false); assert.equal(read.missing, true)
  assert.match(read.error, /缺失或不可读/)
  const list = await tools.list_research!.execute({})
  assert.equal(list.items[0].missing, true)
}))

await check('get_research先同步外部批注/元数据，不返回启动时旧快照', () => fixture(async (vault, tools) => {
  const item = await vault.create({ title: '原始标题', source: 'fixture', occurredAt: '2026-11-23', body: '正文' })
  const file = path.join(vault.dir, item.file)
  await writeFile(file, (await readFile(file, 'utf8')).replace('title: 原始标题', 'title: 外部新标题'))
  const read = await tools.get_research!.execute({ id: item.id })
  assert.equal(read.item.title, '外部新标题'); assert.equal(read.contentStatus, 'body')
}))

console.log(`[research-evidence] ${checks} offline groups passed`)
