/** One state-capital operation shared by Agent tools, existing follow tick and the read-only panel view. */
import { createHash } from 'node:crypto'
import { diffStateCapital, STATE_CAPITAL_ENTITIES, type StateCapitalDisclosure } from './state-capital.js'
import { fetchStateCapitalDisclosure } from './data/state-capital-sources.js'
import type { FollowStore } from './follow-store.js'
import { shouldEnqueue, type FollowSnapshot, type FollowState, type FollowTarget } from './follow.js'

/** A bounded PUBLIC sample, not the user's portfolio or an exhaustive state-capital universe. */
export const STATE_CAPITAL_SAMPLE_CODES = ['601288', '601398', '601939', '601988']
export const STATE_CAPITAL_CAVEATS = [
  '仅监测具名公开披露；报告期、披露日与抓取日不同，不能识别当日买卖或国家队成本。',
  '未列入前十、未披露具名名单或源失败均不等于零持仓/清仓；聚合来源不是已核官方原文。',
  '汇金本体、汇金资产、证金分开记录，不加总为一个账户；ETF份额变动不用于识别持有人。',
  '新增国家资本对象默认手动检查，不创建后台任务或修改个人持仓。',
]
export const stateCapitalCatalog = () => STATE_CAPITAL_ENTITIES.map(entity => ({
  ...entity,
  recommendedCodes: entity.id === 'huijin' ? [] : [...STATE_CAPITAL_SAMPLE_CODES],
}))

export function stateCapitalHistory(state: FollowState, targetId: string, filingKey?: string) {
  const history = state.snapshots.filter(snapshot => snapshot.targetId === targetId && snapshot.data.stateCapital)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  const index = filingKey ? history.findIndex(snapshot => snapshot.filingKey === filingKey) : 0
  const latest = index >= 0 ? history[index] : undefined
  const previous = index >= 0 ? history[index + 1] : undefined
  return { latest, previous }
}

/** Capture time never creates a new disclosure; changed source versions remain auditable. */
export function stateCapitalFilingKey(disclosure: StateCapitalDisclosure): string {
  const content = {
    entityId: disclosure.entityId, scopeId: disclosure.scopeId, asOf: disclosure.asOf, disclosedAt: disclosure.disclosedAt,
    sources: [...disclosure.sources].sort((a, b) => a.url.localeCompare(b.url)),
    holdings: [...disclosure.holdings].sort((a, b) => a.key.localeCompare(b.key)), coverage: disclosure.coverage,
  }
  return `cn-state:${disclosure.entityId}:${createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 24)}`
}

export function stateCapitalTargetView(state: FollowState, target: FollowTarget) {
  const { latest, previous } = stateCapitalHistory(state, target.id)
  const disclosure = latest?.data.stateCapital
  return {
    latest: disclosure,
    diff: disclosure ? diffStateCapital(previous?.data.stateCapital, disclosure) : undefined,
    filingKey: latest?.filingKey,
  }
}

export async function fetchStateCapitalTarget(
  follow: FollowStore,
  target: FollowTarget,
  signal?: AbortSignal,
  runtime: { fetch?: typeof fetchStateCapitalDisclosure } = {},
) {
  if (target.kind !== 'cn-state' || !target.stateEntityId) throw new Error('国家资本对象缺少法定主体标识')
  signal?.throwIfAborted()
  const disclosure = await (runtime.fetch ?? fetchStateCapitalDisclosure)(target.stateEntityId, {
    ...(target.stateCodes?.length ? { codes: target.stateCodes } : {}), ...(signal ? { signal } : {}),
  })
  signal?.throwIfAborted()
  if (disclosure.entityId !== target.stateEntityId) throw new Error('返回主体与请求不一致，拒绝保存')
  const currentTarget = follow.get().targets.find(row => row.id === target.id)
  const codesKey = (row: FollowTarget) => [...(row.stateCodes ?? [])].sort().join(',')
  if (!currentTarget || currentTarget.kind !== 'cn-state' || currentTarget.stateEntityId !== target.stateEntityId || codesKey(currentTarget) !== codesKey(target)) {
    throw new Error('检查期间主体已移除或观察范围已变化，本次不保存，请重新检查')
  }
  const capturedMs = Date.parse(disclosure.capturedAt)
  if (!Number.isFinite(capturedMs)) throw new Error('来源没有有效抓取时间，拒绝保存')
  const capturedDay = new Date(capturedMs + 8 * 3_600_000).toISOString().slice(0, 10)
  const sourceDates = [disclosure.asOf, disclosure.disclosedAt, ...disclosure.sources.flatMap(source => [source.asOf, source.publishedAt]), ...disclosure.holdings.flatMap(row => [row.asOf, row.disclosedAt])]
  if (sourceDates.some(day => day && day.slice(0, 10) > capturedDay)) throw new Error('来源含晚于本次抓取日期的报告期/披露日，拒绝未来数据')
  const before = stateCapitalHistory(follow.get(), target.id).latest?.data.stateCapital
  if (before?.scopeId === disclosure.scopeId) {
    const previousRows = new Map(before.holdings.map(row => [row.key, row]))
    if ((before.asOf && disclosure.asOf && disclosure.asOf < before.asOf) || disclosure.holdings.some(row => {
      const previousDate = previousRows.get(row.key)?.asOf
      return row.asOf && previousDate && row.asOf < previousDate
    })) throw new Error('来源报告期早于已有基线，拒绝用旧期覆盖；请核查源数据')
  }
  const filingKey = stateCapitalFilingKey(disclosure)
  const existing = stateCapitalHistory(follow.get(), target.id, filingKey).latest
  if (!existing) {
    const snapshot: FollowSnapshot = {
      targetId: target.id, filingKey, form: 'CN-PUBLIC-DISCLOSURE',
      filedAt: disclosure.disclosedAt ?? '',
      ...(disclosure.asOf ? { period: disclosure.asOf } : {}),
      capturedAt: disclosure.capturedAt, data: { stateCapital: disclosure },
    }
    // Neither a failed source nor an empty HTTP shell reaches this point.
    await follow.recordSnapshot(snapshot)
    const label = before ? '公开记录观察更新' : '公开记录观察基线'
    const job = shouldEnqueue(follow.get().jobs, target, 'cn-state', filingKey, `${target.name} ${label}（报告期${disclosure.asOf ?? '逐条/未知'}，待核查）`)
    if (job) await follow.enqueueJob(job)
  }
  await follow.touchTarget(target.id, { lastCheckedAt: new Date().toISOString(), lastKeys: { 'cn-state': filingKey } })
  const view = stateCapitalTargetView(follow.get(), target)
  return { newObservation: !existing, newFiling: !existing && disclosure.disclosedAt !== null, filingKey, stateCapital: view,
    publicationDateKnown: disclosure.disclosedAt !== null, caveats: STATE_CAPITAL_CAVEATS }
}
