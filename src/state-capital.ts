/**
 * 中国国家资本公开披露内核。无网络、无文件、无用户持仓读取。
 * registry 是明确的法定主体白名单，不把含「国资/中央」的名字自动合并。
 * 公开名单有覆盖与时滞，母子公司不可直接加总；数量差不是交易记录。
 */
export type StateCapitalEntityId = 'huijin' | 'huijin-asset' | 'csf'
export interface StateCapitalEntity {
  id: StateCapitalEntityId
  name: string
  aliases: string[]
  description: string
}
export const STATE_CAPITAL_ENTITIES: StateCapitalEntity[] = [
  { id: 'huijin', name: '中央汇金投资有限责任公司', aliases: ['中央汇金', '汇金'], description: '独立主体；官网控参股机构不等于全部二级市场证券持仓。' },
  { id: 'huijin-asset', name: '中央汇金资产管理有限责任公司', aliases: ['中央汇金资产', '汇金资产'], description: '汇金全资子公司；不与母公司持股重复加总。' },
  { id: 'csf', name: '中国证券金融股份有限公司', aliases: ['中国证券金融', '证金公司', '证金'], description: '独立法定主体；不把其他国资、社保、基金产品自动算入。' },
]
export function resolveStateCapitalEntity(input: string): StateCapitalEntity | undefined {
  if (typeof input !== 'string') return undefined
  const name = input.trim()
  return STATE_CAPITAL_ENTITIES.find(e => e.id === name || e.name === name || e.aliases.includes(name))
}

export interface StateCapitalSource {
  url: string
  title: string
  /** sha256 of the exact response text, not an invented source identity. */
  hash: string
  level: 'official' | 'aggregated'
  /** Publication date, never the capture date. */
  publishedAt: string | null
  /** Only when explicitly present in this source; not inherited across pages. */
  asOf?: string | null
}
export interface StateCapitalHolding {
  key: string
  name: string
  code?: string
  assetType: 'stock' | 'fund' | 'equity'
  quantity: number | null
  unit: '股' | '份' | '元'
  rawQuantity: string
  percentage: number | null
  denominator: string
  holdingMode: 'direct' | 'indirect' | 'unknown'
  asOf: string | null
  disclosedAt: string | null
  sourceUrl: string
  sourceHash: string
  locator: string
  /** Display quantum in base units, e.g. 0.01 亿股 = 1,000,000 股. */
  quantityPrecision?: number
  /** Optional evidence locator for verified corporate actions; absent means unverified. */
  corporateActionBasis?: string
}
export interface StateCapitalDisclosure {
  entityId: string
  entityName: string
  /** Stable source/coverage identity; explicit code pool sorted into the scope. */
  scopeId: string
  /** Mixed / undated source periods remain null. Row/source dates retain their own meaning. */
  asOf: string | null
  disclosedAt: string | null
  capturedAt: string
  sources: StateCapitalSource[]
  holdings: StateCapitalHolding[]
  coverage: string
  warnings: string[]
}
export type StateCapitalDiffStatus = 'first-observation' | 'compared' | 'incomparable' | 'same-period-revision' | 'coverage-changed'
export type StateCapitalDiffRowStatus = 'first-observation' | 'quantity-increased' | 'quantity-decreased' | 'quantity-unchanged' | 'not-disclosed' | 'newly-disclosed' | 'incomparable' | 'same-period-revision'
export interface StateCapitalDiffRow {
  key: string
  name: string
  code?: string
  status: StateCapitalDiffRowStatus
  previousQuantity: number | null
  nextQuantity: number | null
  delta: number | null
  unit: StateCapitalHolding['unit']
  note: string
}
export interface StateCapitalDiff {
  status: StateCapitalDiffStatus
  rows: StateCapitalDiffRow[]
  warnings: string[]
}

const day = (s: string | null): string | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null
}
const knownQuantity = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER

/**
 * Conservative period-end quantity comparison. No value/percentage based buy/sell labels.
 * Absence never means zero or liquidation. Different entity/scope/unit/mode/period is blocked;
 * same-period content revisions are revisions, not trades. Corporate actions remain a warning.
 */
export function diffStateCapital(prev: StateCapitalDisclosure | undefined, next: StateCapitalDisclosure): StateCapitalDiff {
  const warnings = ['仅比较披露期末数量；不是实时买卖记录，不代表政策承诺或本金保障。', '未核实送转、拆分、合并等公司行动；即使数量变化也不能据此认定主动交易。', '中投、汇金、汇金资产、证金等主体可能存在控制与重复暴露，不能直接加总。']
  const rows: StateCapitalDiffRow[] = []
  const pmap = new Map((prev?.holdings ?? []).map(h => [h.key, h]))
  const nmap = new Map(next.holdings.map(h => [h.key, h]))
  if (pmap.size !== (prev?.holdings.length ?? 0) || nmap.size !== next.holdings.length) {
    return { status: 'incomparable', rows: [], warnings: [...warnings, '披露包含重复key，拒绝静默覆盖或合并。'] }
  }
  const identityChanged = !!prev && (prev.entityId !== next.entityId || prev.scopeId !== next.scopeId)
  const coverageChanged = !!prev && (prev.scopeId !== next.scopeId || prev.coverage !== next.coverage)
  const sourceChanged = !!prev && prev.sources.map(s => `${s.url}:${s.hash}`).sort().join('|') !== next.sources.map(s => `${s.url}:${s.hash}`).sort().join('|')
  for (const key of new Set([...nmap.keys(), ...pmap.keys()])) {
    const p = pmap.get(key), n = nmap.get(key), h = n ?? p!
    const row: StateCapitalDiffRow = { key, name: h.name, ...(h.code ? { code: h.code } : {}), status: 'incomparable', previousQuantity: p?.quantity ?? null, nextQuantity: n?.quantity ?? null, delta: null, unit: h.unit, note: '' }
    if (!prev) {
      row.status = 'first-observation'; row.note = '首次观察，只建立基线，不能称新买入。'
    } else if (identityChanged || coverageChanged) {
      row.note = '主体、来源scope或覆盖范围改变，不作跨口径数量推断。'
    } else if (!n || n.quantity === null) {
      row.status = 'not-disclosed'; row.note = '后期未披露或未见精确法定户名，数量未知，不是零也不是清仓。'
    } else if (!p || p.quantity === null) {
      row.status = 'newly-disclosed'; row.note = '本次才观察到数量；前期未知，不能认定新建仓。'
    } else if (p.unit !== n.unit || p.holdingMode !== n.holdingMode || p.assetType !== n.assetType || p.holdingMode === 'unknown' || n.holdingMode === 'unknown') {
      row.note = '单位、资产类型或直接/间接持股口径不同或未知，不可比较。'
    } else if (!knownQuantity(p.quantity) || !knownQuantity(n.quantity)) {
      row.note = '数量不是有效非负有限数，拒绝推断。'
    } else {
      const pd = day(p.asOf), nd = day(n.asOf)
      if (!pd || !nd || nd < pd) {
        row.note = '期间未知或新期早于旧期，不可比较；不把抓取日当期末。'
      } else if (pd === nd && (p.quantity !== n.quantity || sourceChanged)) {
        row.status = 'same-period-revision'; row.note = '同一期的来源内容修订，不是跨期增减。'
      } else {
        const delta = n.quantity - p.quantity
        const quantum = Math.max(p.quantityPrecision ?? 0, n.quantityPrecision ?? 0)
        if (delta !== 0 && Math.abs(delta) < quantum) {
          row.note = '数量差小于来源显示精度，可能由舍入造成，不作增减判断。'
        } else {
          row.delta = delta
          row.status = delta > 0 ? 'quantity-increased' : delta < 0 ? 'quantity-decreased' : 'quantity-unchanged'
          row.note = delta === 0 ? '披露数量相同；比例变化不认定为数量减持/增持。' : '仅期末披露数量变化；送转/拆分/合并等未核，不能认定主动买卖。'
          if (quantum > 1) row.note += ' 来源为舍入后的数量，不是精确到个位。'
        }
      }
    }
    rows.push(row)
  }
  const status: StateCapitalDiffStatus = !prev ? 'first-observation' : coverageChanged ? 'coverage-changed' : identityChanged ? 'incomparable' : rows.some(r => r.status === 'same-period-revision') ? 'same-period-revision' : rows.some(r => r.delta !== null) ? 'compared' : 'incomparable'
  if (coverageChanged) warnings.push('覆盖发生变化；保留旧范围，未出现的名单不能视为退出。')
  return { status, rows, warnings }
}
