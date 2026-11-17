/**
 * Personal capital tools.
 *
 * Every number returned here comes from `performance.ts` (integer cents, FIFO,
 * explicit FX). The tools never estimate a balance and never add currencies
 * without a rate — when a total is impossible they return `null` plus the reason.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Logger } from '../log.js'
import type { CapitalStore } from './ledger.js'
import { deriveState, netWorth, performanceSummary, xirr, twr, type TwrPoint } from './performance.js'
import { computeExposure, simulateWeightChange } from './exposure.js'
import { fromCents, setFx, toCents, type FxTable, type PricePoint } from './types.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

/** `600519:1450.2:CNY:2026-11-16,110022:1.53:CNY:2026-11-16` or a JSON array. */
export function parsePrices(raw: unknown): PricePoint[] {
  if (raw === undefined || raw === null || raw === '') return []
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const p = item as Record<string, unknown>
      return {
        assetId: String(p.assetId ?? p.code ?? ''),
        price: Number(p.price ?? 0),
        currency: String(p.currency ?? 'CNY').toUpperCase(),
        asOf: String(p.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
        stale: p.stale === true,
      }
    }).filter((p) => p.assetId && p.price > 0)
  }
  return String(raw).split(/[,;；]\s*/).map((chunk) => {
    const [assetId, price, currency, asOf] = chunk.split(':')
    return {
      assetId: String(assetId ?? '').trim(),
      price: Number(price ?? 0),
      currency: String(currency ?? 'CNY').trim().toUpperCase() || 'CNY',
      asOf: String(asOf ?? new Date().toISOString().slice(0, 10)).trim().slice(0, 10),
      stale: false,
    }
  }).filter((p) => p.assetId && p.price > 0)
}

/** `USD>CNY:7.12:2026-11-16,HKD>CNY:0.91:2026-11-16` or a JSON array. */
export function parseFx(raw: unknown): FxTable {
  const table: FxTable = new Map()
  if (raw === undefined || raw === null || raw === '') return table
  const items: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : String(raw).split(/[,;；]\s*/).map((chunk) => {
      const [pair, rate, asOf] = chunk.split(':')
      const [from, to] = String(pair ?? '').split('>')
      return { from, to, rate, asOf }
    })
  for (const item of items) {
    const from = String(item.from ?? '').trim().toUpperCase()
    const to = String(item.to ?? '').trim().toUpperCase()
    const rate = Number(item.rate ?? 0)
    if (!from || !to || !(rate > 0)) continue
    setFx(table, from, to, rate, String(item.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10), String(item.source ?? 'manual'))
  }
  return table
}

export interface CapitalToolDeps {  store: CapitalStore
  logger?: Logger
  /** Default reporting currency (CNY unless configured). */
  baseCurrency?: string
}

export function registerCapitalTools(ctx: Context, deps: CapitalToolDeps): void {
  const ensure = async (): Promise<void> => {
    if (!deps.store.isLoaded()) await deps.store.load()
  }
  const base = (deps.baseCurrency ?? 'CNY').toUpperCase()

  ctx.tools.register(defineTool({
    name: 'capital_account_list',
    description: '列出个人资本账户（证券/基金/现金/银行等）与账本规模。账本与持仓快照分离：这里才是交易流水。',
    parameters: {},
    output: jsonOut,
    async execute() {
      try {
        await ensure()
        const accounts = deps.store.listAccounts()
        return asJson({
          ok: true,
          dir: deps.store.dir,
          baseCurrency: base,
          count: accounts.length,
          accounts,
          events: deps.store.listEvents({ limit: 5000 }).length,
          batches: deps.store.listBatches().slice(0, 5),
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_account_save',
    description: '新建/更新一个资本账户（多账户、多币种）。不收集账号、凭证等敏感信息。',
    parameters: {
      accountId: { type: 'string', required: true, description: '稳定 id，如 sec-cn-1' },
      name: { type: 'string', required: true, description: '账户名（自己看得懂即可）' },
      accountType: { type: 'string', enum: ['securities', 'fund', 'cash', 'bank', 'crypto', 'other'] },
      provider: { type: 'string', description: '券商/基金平台/银行名称' },
      baseCurrency: { type: 'string', description: '账户计价币种，默认 CNY' },
      valuationCurrency: { type: 'string', description: '展示币种，默认同 baseCurrency' },
      ownershipScope: { type: 'string', description: 'personal/joint/other，默认 personal' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const account = await deps.store.upsertAccount({
          accountId: String(args.accountId ?? ''),
          name: String(args.name ?? ''),
          ...(args.accountType ? { accountType: args.accountType as never } : {}),
          ...(args.provider ? { provider: String(args.provider) } : {}),
          ...(args.baseCurrency ? { baseCurrency: String(args.baseCurrency).toUpperCase() } : {}),
          ...(args.valuationCurrency ? { valuationCurrency: String(args.valuationCurrency).toUpperCase() } : {}),
          ...(args.ownershipScope ? { ownershipScope: String(args.ownershipScope) } : {}),
        })
        return asJson({ ok: true, account })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_transaction_add',
    description: '追加一条资金/交易流水（只追加，不覆盖）。金额以原币种记录；买入卖出按数量×价格，费用税费另计。同一 (source, sourceTransactionId) 不会重复入账。',
    parameters: {
      accountId: { type: 'string', required: true },
      eventType: {
        type: 'string', required: true,
        enum: ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'FX_CONVERSION', 'INTERNAL_TRANSFER', 'SPLIT', 'CORPORATE_ACTION', 'ADJUSTMENT'],
      },
      occurredAt: { type: 'string', required: true, description: 'YYYY-MM-DD' },
      assetId: { type: 'string', description: '标的代码（买卖/分红/拆分需要）' },
      quantity: { type: 'number' },
      price: { type: 'number' },
      grossAmount: { type: 'number', description: '金额（入金/出金/费用/税费/换汇必填或自动算）' },
      netAmount: { type: 'number', description: '净额（卖出净收入、换汇换入金额）' },
      fee: { type: 'number' },
      tax: { type: 'number' },
      currency: { type: 'string', description: '原币种，默认账户币种' },
      fxRate: { type: 'number', description: '换汇汇率' },
      fxCurrency: { type: 'string', description: '换入币种' },
      source: { type: 'string', description: 'manual/broker/csv…' },
      sourceTransactionId: { type: 'string', description: '券商流水号（强烈建议填，用于去重）' },
      note: { type: 'string' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const result = await deps.store.appendEvent({
          accountId: String(args.accountId ?? ''),
          eventType: String(args.eventType ?? '') as never,
          occurredAt: String(args.occurredAt ?? ''),
          ...(args.assetId ? { assetId: String(args.assetId) } : {}),
          ...(args.quantity !== undefined ? { quantity: Number(args.quantity) } : {}),
          ...(args.price !== undefined ? { price: Number(args.price) } : {}),
          ...(args.grossAmount !== undefined ? { grossAmount: Number(args.grossAmount) } : {}),
          ...(args.netAmount !== undefined ? { netAmount: Number(args.netAmount) } : {}),
          ...(args.fee !== undefined ? { fee: Number(args.fee) } : {}),
          ...(args.tax !== undefined ? { tax: Number(args.tax) } : {}),
          ...(args.currency ? { currency: String(args.currency).toUpperCase() } : {}),
          ...(args.fxRate !== undefined ? { fxRate: Number(args.fxRate) } : {}),
          ...(args.fxCurrency ? { fxCurrency: String(args.fxCurrency).toUpperCase() } : {}),
          ...(args.source ? { source: String(args.source) } : {}),
          ...(args.sourceTransactionId ? { sourceTransactionId: String(args.sourceTransactionId) } : {}),
          ...(args.note ? { note: String(args.note) } : {}),
        })
        return asJson({ ok: true, duplicate: result.duplicate, reason: result.reason, event: result.event })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_transaction_list',
    description: '查询流水（按账户/标的/类型/日期区间）。返回的是账本事实，不是模型推断。',
    parameters: {
      accountId: { type: 'string' },
      assetId: { type: 'string' },
      eventType: { type: 'string', enum: ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'FX_CONVERSION', 'INTERNAL_TRANSFER', 'SPLIT', 'CORPORATE_ACTION', 'ADJUSTMENT'] },
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      limit: { type: 'number', description: '默认 100' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const events = deps.store.listEvents({
          ...(args.accountId ? { accountId: String(args.accountId) } : {}),
          ...(args.assetId ? { assetId: String(args.assetId) } : {}),
          ...(args.eventType ? { eventType: args.eventType as never } : {}),
          ...(args.from ? { from: String(args.from) } : {}),
          ...(args.to ? { to: String(args.to) } : {}),
          limit: Number(args.limit) > 0 ? Number(args.limit) : 100,
        })
        return asJson({ ok: true, count: events.length, events })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_correct',
    description: '更正一条流水：生成一条指向原记录的更正事件（原记录停止计入统计），必须写理由。历史不会被删除。',
    parameters: {
      eventId: { type: 'string', required: true },
      reason: { type: 'string', required: true },
      quantity: { type: 'number' },
      price: { type: 'number' },
      grossAmount: { type: 'number' },
      netAmount: { type: 'number' },
      fee: { type: 'number' },
      tax: { type: 'number' },
      note: { type: 'string' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const event = await deps.store.correctEvent(String(args.eventId ?? ''), {
          ...(args.quantity !== undefined ? { quantity: Number(args.quantity) } : {}),
          ...(args.price !== undefined ? { price: Number(args.price) } : {}),
          ...(args.grossAmount !== undefined ? { grossAmount: Number(args.grossAmount) } : {}),
          ...(args.netAmount !== undefined ? { netAmount: Number(args.netAmount) } : {}),
          ...(args.fee !== undefined ? { fee: Number(args.fee) } : {}),
          ...(args.tax !== undefined ? { tax: Number(args.tax) } : {}),
        }, String(args.reason ?? ''))
        return asJson({ ok: true, event, note: '已生成更正事件；原事件保留但不再计入统计' })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_ledger_import_preview',
    description: '预览 CSV 导入：解析、字段校验、去重（与账本和批内），不写库。列名支持 date/type/account/asset/quantity/price/amount/fee/tax/currency/fx_rate/fx_currency/source_id/note（含中文别名）。',
    parameters: {
      csv: { type: 'string', description: 'CSV 全文' },
      filePath: { type: 'string', description: '或给本地 CSV 绝对路径' },
      fileName: { type: 'string' },
      source: { type: 'string', description: '来源标识，如 broker-ht', },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        let text = args.csv ? String(args.csv) : ''
        if (!text && args.filePath) {
          const { readFile } = await import('node:fs/promises')
          text = await readFile(String(args.filePath), 'utf8')
        }
        if (!text) return asJson({ ok: false, error: '需要 csv 或 filePath' })
        const preview = deps.store.previewCsv(text, {
          fileName: args.fileName ? String(args.fileName) : (args.filePath ? String(args.filePath).split(/[\\/]/).pop() ?? 'import.csv' : 'import.csv'),
          source: args.source ? String(args.source) : 'csv',
        })
        return asJson({
          ok: true,
          previewId: preview.previewId,
          valid: preview.valid,
          duplicates: preview.duplicates,
          invalid: preview.invalid,
          rows: preview.rows.slice(0, 50),
          note: '确认写入请调用 capital_ledger_import_confirm(previewId)。预览不会写库。',
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_ledger_import_confirm',
    description: '把预览通过的 CSV 批次写入账本（幂等：重复确认或重复文件不会重复入账）。',
    parameters: { previewId: { type: 'string', required: true } },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const batch = await deps.store.confirmImport(String(args.previewId ?? ''))
        return asJson({ ok: true, batch })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_exposure_analyze',
    description: '个人资本暴露分析：按显式价格/汇率计算持仓权重、集中度（HHI/有效持仓数/top1/top3）、现金占比与币种暴露。缺价格或汇率的资产会标为 unknown 并排除在权重外，不按 0 计入。',
    parameters: {
      prices: { type: 'string', description: '价格："600519:1450.2:CNY:2026-11-16,..." 或 JSON 数组' },
      fx: { type: 'string', description: '汇率："USD>CNY:7.12:2026-11-16"' },
      baseCurrency: { type: 'string', description: '展示币种，默认 CNY' },
      asOf: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const state = deriveState(deps.store.listEvents({ limit: 5000 }))
        const exposure = computeExposure(
          state,
          parsePrices(args.prices),
          String(args.baseCurrency ?? base).toUpperCase(),
          parseFx(args.fx),
          String(args.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
        )
        return asJson({
          ok: true,
          ...exposure,
          totalYuan: exposure.totalCents === undefined ? null : fromCents(exposure.totalCents),
          cashYuan: exposure.cashCents === undefined ? null : fromCents(exposure.cashCents),
          rows: exposure.rows.map((r) => ({ ...r, valueYuan: fromCents(r.valueCents), weightPct: r.weight === undefined ? null : Math.round(r.weight * 10000) / 100 })),
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_scenario_simulate',
    description: '纯纸面情景：把指定资产的权重调到目标值（其余等比例缩放），对比调整前后的集中度（HHI/top1/top3）。不修改账本、不产生交易、不考虑成本与可成交性。',
    parameters: {
      prices: { type: 'string', description: '价格，同上（没有价格无法计算权重）' },
      fx: { type: 'string', description: '汇率，同上' },
      baseCurrency: { type: 'string' },
      changes: { type: 'string', required: true, description: 'JSON 数组：[{"assetId":"600519","targetWeight":0.2}]（0–1）' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const parsed = JSON.parse(String(args.changes ?? '[]')) as Array<{ assetId?: string; targetWeight?: number }>
        if (!Array.isArray(parsed) || parsed.length === 0) return asJson({ ok: false, error: 'changes 不能为空' })
        const changes = parsed.map((c) => ({ assetId: String(c.assetId ?? ''), targetWeight: Number(c.targetWeight ?? 0) }))
        const state = deriveState(deps.store.listEvents({ limit: 5000 }))
        const exposure = computeExposure(state, parsePrices(args.prices), String(args.baseCurrency ?? base).toUpperCase(), parseFx(args.fx), new Date().toISOString().slice(0, 10))
        const scenario = simulateWeightChange(exposure, changes)
        return asJson({ ok: true, ...scenario, exposureNote: exposure.note })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_networth_snapshot',
    description: '净资产快照：现金 + 已定价持仓，按币种列示；缺汇率/缺行情时明确写出，不给虚假总额。价格可用 prices 传入（"600519:1450.2:CNY:2026-11-16"）。',
    parameters: {
      prices: { type: 'string', description: '价格列表或 JSON 数组' },
      fx: { type: 'string', description: '汇率 "USD>CNY:7.12:2026-11-16"' },
      baseCurrency: { type: 'string', description: '展示币种，默认 CNY' },
      asOf: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const state = deriveState(deps.store.listEvents({ limit: 5000 }))
        const worth = netWorth(
          state,
          parsePrices(args.prices),
          String(args.baseCurrency ?? base).toUpperCase(),
          parseFx(args.fx),
          String(args.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
        )
        return asJson({
          ok: true,
          netWorth: worth,
          cash: state.cash.map((c) => ({ ...c, amount: fromCents(c.cents) })),
          positions: state.positions.map((p) => ({ assetId: p.assetId, quantity: p.quantity, currency: p.currency, cost: fromCents(p.costCents), averageCost: fromCents(p.averageCostCents) })),
          warnings: state.warnings,
        })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capital_performance',
    description: '真实收益：净投入（入金-出金）、已实现（FIFO）、未实现、分红利息、费用、净资产、XIRR（无解/多解会明说）、TWR（缺逐期估值则 unavailable）。追加本金不会被算成收益。',
    parameters: {
      prices: { type: 'string', description: '价格列表或 JSON 数组' },
      fx: { type: 'string', description: '汇率，如 "USD>CNY:7.12:2026-11-16"' },
      baseCurrency: { type: 'string' },
      asOf: { type: 'string', description: 'YYYY-MM-DD' },
      valuations: { type: 'string', description: 'TWR 用的逐期估值 JSON：[{date,valueCents,flowCents}]' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        await ensure()
        const state = deriveState(deps.store.listEvents({ limit: 5000 }))
        let valuations: TwrPoint[] | undefined
        if (args.valuations) {
          try {
            const parsed = JSON.parse(String(args.valuations)) as TwrPoint[]
            if (Array.isArray(parsed)) valuations = parsed
          } catch {
            return asJson({ ok: false, error: 'valuations 必须是 JSON 数组' })
          }
        }
        const summary = performanceSummary({
          state,
          prices: parsePrices(args.prices),
          baseCurrency: String(args.baseCurrency ?? base).toUpperCase(),
          fx: parseFx(args.fx),
          asOf: String(args.asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
          ...(valuations ? { valuations } : {}),
        })
        return asJson({ ok: true, ...summary })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  // Expose the primitives so tests and future tools reuse one implementation.
  void xirr
  void twr
  void toCents
}
