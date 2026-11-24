import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Unit-test the real callback bodies with controlled requests. No DOM, server or private data.
const text = readFileSync('src/client/index.tsx', 'utf8')
const source = ts.createSourceFile('index.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function component(name: string): ts.FunctionDeclaration {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(node && ts.isFunctionDeclaration(node), `missing component ${name}`)
  return node
}
function visit(node: ts.Node, collect: (node: ts.Node) => void) {
  collect(node)
  ts.forEachChild(node, child => visit(child, collect))
}
function callback(scope: string, name: string): ts.Expression {
  let result: ts.Expression | undefined
  visit(component(scope), node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      result = ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback'
        ? node.initializer.arguments[0] : node.initializer
    }
  })
  assert.ok(result, `missing callback ${scope}.${name}`)
  return result
}
function handlerContaining(marker: string): ts.ArrowFunction {
  const matches: ts.ArrowFunction[] = []
  visit(component('ResearchView'), node => {
    if (ts.isArrowFunction(node) && node.body.getText(source).includes(marker)) matches.push(node)
  })
  matches.sort((a, b) => a.getWidth(source) - b.getWidth(source))
  assert.ok(matches[0], `missing research handler ${marker}`)
  return matches[0]
}
function bind(node: ts.Expression, environment: Record<string, unknown>): (...args: any[]) => any {
  const code = ts.transpileModule(`const callback = ${node.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(environment), `${code}\nreturn callback;`)(...Object.values(environment))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() { for (let n = 0; n < 8; n++) await Promise.resolve() }
const row = (requestId: string) => ({ ok: true, request: { requestId }, submissions: [] })
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

async function main() {
  const selectedRef = { current: 'A' }, detailRequest = { current: 0 }, mounted = { current: true }
  let detail: any = null
  const requests: Array<ReturnType<typeof deferred<any>>> = []
  const loadDetail = bind(callback('EvidenceInbox', 'loadDetail'), {
    selectedRef, detailRequest, mounted, encodeURIComponent, errText: errorText,
    setDetail: (value: unknown) => { detail = value },
    apiGet: () => { const request = deferred<any>(); requests.push(request); return request.promise },
  })
  loadDetail('A')
  selectedRef.current = 'B'; detailRequest.current++
  loadDetail('B')
  requests[1]!.resolve(row('B')); await settle()
  requests[0]!.resolve(row('A')); await settle()
  assert.equal(detail.request.requestId, 'B', 'late A must not replace B')
  loadDetail('B'); loadDetail('B')
  requests[3]!.resolve(row('B')); await settle()
  requests[2]!.reject(new Error('old request failed')); await settle()
  assert.equal(detail.request.requestId, 'B', 'old error must not replace a newer successful detail')
  loadDetail('B'); requests[4]!.resolve(row('A')); await settle()
  assert.equal(detail.ok, false, 'a mismatched response cannot expose an actionable request')
  assert.match(detail.error, /身份不一致/)
  loadDetail('B'); mounted.current = false; requests[5]!.resolve(row('B')); await settle()
  assert.equal(detail, null, 'unmounted detail callback must not commit data')

  const emptyForm = { text: '', url: '', value: '' }
  let selected = 'A', form: unknown = { text: 'A material' }, mode = 'values', hint = 'old'
  detail = row('A'); mounted.current = true
  bind(callback('EvidenceInbox', 'selectRequest'), {
    selectedRef, detailRequest, emptyForm,
    setSelected: (value: string) => { selected = value }, setDetail: (value: unknown) => { detail = value },
    setForm: (value: unknown) => { form = value }, setMode: (value: string) => { mode = value }, setHint: (value: string) => { hint = value },
  })('C')
  assert.equal(selectedRef.current, 'C'); assert.equal(selected, 'C'); assert.equal(detail, null)
  assert.deepEqual(form, emptyForm); assert.notEqual(form, emptyForm); assert.equal(mode, 'text'); assert.equal(hint, '')

  const sent: Array<{ path: string; payload: any }> = []
  const submit = (active: any, selected: string) => bind(callback('EvidenceInbox', 'submitMaterial'), {
    active, selected, selectedRef, form: { text: 'C material' }, mode: 'text',
    setHint: (value: string) => { hint = value }, post: (payload: unknown, path: string) => sent.push({ path, payload }),
  })()
  submit({ requestId: 'A' }, 'C'); assert.equal(sent.length, 0)
  submit({ requestId: 'C' }, 'C'); assert.equal(sent[0]!.payload.requestId, 'C')
  assert.equal(sent[0]!.payload.text, 'C material')

  const posting = { current: false }
  const posted = deferred<any>()
  let posts = 0, reloads = 0, detailReloads = 0
  const busyValues: boolean[] = []
  hint = 'new selection feedback'
  const post = bind(callback('EvidenceInbox', 'post'), {
    posting, selectedRef, mounted, active: { requestId: 'C' }, errText: errorText,
    setBusy: (value: boolean) => busyValues.push(value), setHint: (value: string) => { hint = value },
    apiPost: () => { posts++; return posted.promise }, load: () => { reloads++ }, loadDetail: () => { detailReloads++ },
  })
  post({ requestId: 'A' }, '/evidence/submit'); assert.equal(posts, 0)
  post({ requestId: 'C' }, '/evidence/submit'); post({ requestId: 'C' }, '/evidence/submit')
  assert.equal(posts, 1, 'duplicate clicks before render must not submit twice')
  selectedRef.current = 'D'; posted.resolve({ ok: true }); await settle()
  assert.equal(hint, 'new selection feedback'); assert.equal(detailReloads, 0)
  assert.equal(reloads, 1); assert.deepEqual(busyValues, [true, false])

  const deleteNode = handlerContaining("await act('/research/delete'")
  const confirmations: string[] = [], deleted: unknown[] = [], changes: string[] = []
  const dismissedRef = { current: undefined as string | undefined }
  let answer = false, removeOk = true
  const remove = bind(deleteNode, {
    it: { id: 'research-1', title: 'Important study' }, editing: true, editor: 'draft', editorBase: 'saved', dismissedRef,
    window: { confirm: (prompt: string) => { confirmations.push(prompt); return answer } },
    act: async (path: string, body: unknown) => { deleted.push({ path, body }); return removeOk },
    setDetail: () => changes.push('detail'), setEditing: () => changes.push('editing'), setRaw: () => changes.push('raw'),
    setHint: () => changes.push('hint'), load: async () => changes.push('load'),
  })
  await remove(); assert.equal(deleted.length, 0); assert.equal(changes.length, 0)
  for (const value of ['Important study', '永久删除', '正文', '批注', '未保存', '归档']) assert.ok(confirmations[0]!.includes(value))
  answer = true; removeOk = false
  await remove(); assert.equal(dismissedRef.current, undefined); assert.equal(changes.length, 0, 'failed delete must preserve the open draft')
  removeOk = true
  await remove(); assert.equal(dismissedRef.current, 'research-1'); assert.ok(changes.includes('detail')); assert.ok(changes.includes('load'))

  const cancel = bind(handlerContaining('确认放弃修改并取消编辑'), {
    editing: true, editor: 'draft', editorBase: 'saved', window: { confirm: () => false },
    setEditing: () => assert.fail('declining discard must retain editing'), setEditPreview: () => assert.fail('declining discard must retain preview'),
  })
  cancel()

  const inbox = component('EvidenceInbox').getText(source)
  assert.ok(inbox.includes('detail.request?.requestId === selected'), 'rendered active request must match selection')
  assert.ok(inbox.includes('selectRequest(isActive'), 'row changes must invalidate and clear old details synchronously')
  console.log('PASS review safety: detail ordering/identity, selection reset, submission binding, stale receipts, delete confirmation/cancel/failure, dirty discard (callback unit tests; no browser acceptance)')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
