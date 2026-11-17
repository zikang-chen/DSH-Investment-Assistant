/**
 * Append-only capital ledger.
 *
 * Nothing is ever overwritten: a mistake is corrected by a new event that points
 * at the original (`correctionOf`), and the superseded event stops contributing
 * to positions and cash. Imports are preview-first and de-duplicated by
 * `(source, sourceTransactionId)` or, when that is missing, by a canonical hash —
 * importing the same broker file twice must add nothing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Logger } from '../log.js'
import {
  EVENT_TYPES,
  toCents,
  fromCents,
  validateEventInput,
  type CapitalAccount,
  type CapitalEvent,
  type CapitalEventInput,
  type EventType,
  type ImportBatch,
} from './types.js'

interface AccountsFile { version: 1; updatedAt: string; accounts: CapitalAccount[] }
interface EventsFile { version: 1; updatedAt: string; events: CapitalEvent[] }
interface BatchesFile { version: 1; updatedAt: string; batches: ImportBatch[] }

export interface AppendResult {
  event: CapitalEvent
  duplicate: boolean
  reason: string
}

export interface LedgerPreviewRow {
  index: number
  ok: boolean
  duplicate: boolean
  issues: string[]
  event: CapitalEventInput | null
}

export interface LedgerPreview {
  previewId: string
  createdAt: string
  fileName: string
  source: string
  rows: LedgerPreviewRow[]
  valid: number
  duplicates: number
  invalid: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Canonical identity of an event for de-duplication. */
export function eventDedupeKey(input: CapitalEventInput): string {
  const source = String(input.source ?? '').trim()
  const externalId = String(input.sourceTransactionId ?? '').trim()
  if (source && externalId) return `ext:${source}|${externalId}`
  const canonical = [
    input.accountId, input.eventType, String(input.occurredAt ?? '').slice(0, 10),
    input.assetId ?? '', String(input.quantity ?? ''), String(input.price ?? ''),
    String(input.grossAmount ?? ''), String(input.netAmount ?? ''),
    String(input.fee ?? ''), String(input.tax ?? ''), String(input.currency ?? '').toUpperCase(),
    String(input.fxRate ?? ''), String(input.fxCurrency ?? '').toUpperCase(),
  ].join('|')
  return `h:${createHash('sha1').update(canonical).digest('hex').slice(0, 20)}`
}

/** Split CSV text into rows honouring simple quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const TYPE_ALIAS: Record<string, EventType> = {
  入金: 'DEPOSIT', 出金: 'WITHDRAWAL', 买入: 'BUY', 卖出: 'SELL', 分红: 'DIVIDEND', 红利: 'DIVIDEND',
  利息: 'INTEREST', 费用: 'FEE', 手续费: 'FEE', 税费: 'TAX', 换汇: 'FX_CONVERSION', 内部转账: 'INTERNAL_TRANSFER',
  拆分: 'SPLIT', 送股: 'CORPORATE_ACTION', 配股: 'CORPORATE_ACTION', 调整: 'ADJUSTMENT',
}

export function normalizeEventType(value: unknown): EventType | undefined {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const upper = raw.toUpperCase() as EventType
  if ((EVENT_TYPES as readonly string[]).includes(upper)) return upper
  return TYPE_ALIAS[raw]
}

export class CapitalStore {
  readonly dir: string
  private readonly accountsPath: string
  private readonly eventsPath: string
  private readonly batchesPath: string
  private accounts: CapitalAccount[] = []
  private events: CapitalEvent[] = []
  private batches: ImportBatch[] = []
  private previews = new Map<string, { preview: LedgerPreview; rows: CapitalEventInput[]; fileName: string; source: string }>()
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.dir = dir
    this.accountsPath = path.join(dir, 'accounts.json')
    this.eventsPath = path.join(dir, 'events.json')
    this.batchesPath = path.join(dir, 'import-batches.json')
    this.log = logger?.child('capital')
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.accounts = await this.readJson<CapitalAccount[]>(this.accountsPath, [])
    this.events = await this.readJson<CapitalEvent[]>(this.eventsPath, [])
    this.batches = await this.readJson<ImportBatch[]>(this.batchesPath, [])
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { data?: T }
      return (parsed.data ?? fallback) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('capital file unreadable', { file, error: String(err) })
      return fallback
    }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, updatedAt: nowIso(), data }, null, 2), 'utf8')
    await rename(tmp, file)
  }

  // ---------------------------------------------------------------- accounts

  listAccounts(): CapitalAccount[] {
    return [...this.accounts]
  }

  getAccount(accountId: string): CapitalAccount | undefined {
    return this.accounts.find((a) => a.accountId === accountId)
  }

  async upsertAccount(input: Partial<CapitalAccount> & { accountId: string; name: string }): Promise<CapitalAccount> {
    const existing = this.getAccount(input.accountId)
    const account: CapitalAccount = {
      accountId: input.accountId,
      name: input.name,
      accountType: (input.accountType ?? existing?.accountType ?? 'other') as CapitalAccount['accountType'],
      provider: input.provider ?? existing?.provider ?? '',
      baseCurrency: (input.baseCurrency ?? existing?.baseCurrency ?? 'CNY').toUpperCase(),
      valuationCurrency: (input.valuationCurrency ?? existing?.valuationCurrency ?? input.baseCurrency ?? existing?.baseCurrency ?? 'CNY').toUpperCase(),
      createdAt: existing?.createdAt ?? nowIso(),
      ownershipScope: input.ownershipScope ?? existing?.ownershipScope ?? 'personal',
    }
    this.accounts = existing
      ? this.accounts.map((a) => (a.accountId === account.accountId ? account : a))
      : [...this.accounts, account]
    await this.writeJson(this.accountsPath, this.accounts)
    return account
  }

  // ------------------------------------------------------------------ events

  /** All events in occurrence order, excluding ones superseded by a correction. */
  listEvents(filter: { accountId?: string; assetId?: string; from?: string; to?: string; eventType?: EventType; limit?: number } = {}): CapitalEvent[] {
    const superseded = new Set(this.events.map((e) => e.correctionOf).filter(Boolean))
    const limit = Math.max(1, Math.min(5000, filter.limit ?? 500))
    return this.events
      .filter((e) => !superseded.has(e.eventId))
      .filter((e) => {
        if (filter.accountId && e.accountId !== filter.accountId) return false
        if (filter.assetId && e.assetId !== filter.assetId) return false
        if (filter.eventType && e.eventType !== filter.eventType) return false
        if (filter.from && e.occurredAt < filter.from) return false
        if (filter.to && e.occurredAt > filter.to) return false
        return true
      })
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
  }

  /** Append one event; identical events are returned instead of duplicated. */
  async appendEvent(input: CapitalEventInput): Promise<AppendResult> {
    const key = eventDedupeKey(input)
    const existing = this.events.find((e) => eventDedupeKey(e) === key)
    if (existing) return { event: existing, duplicate: true, reason: '同一交易已入账（去重键一致）' }

    const { normalized, issues } = validateEventInput(input)
    if (!this.getAccount(normalized.accountId)) throw new Error(`未找到账户：${normalized.accountId}`)
    const type = normalized.eventType
    const occurredAt = normalized.occurredAt.slice(0, 10)
    const quantity = Number(normalized.quantity ?? 0)
    const price = Number(normalized.price ?? 0)
    const feeCents = toCents(normalized.fee ?? 0)
    const taxCents = toCents(normalized.tax ?? 0)
    const grossCents = normalized.grossAmount !== undefined
      ? toCents(normalized.grossAmount)
      : type === 'BUY' || type === 'SELL'
        ? toCents(quantity * price) + (type === 'BUY' ? feeCents + taxCents : 0)
        : type === 'DIVIDEND' || type === 'INTEREST'
          ? toCents(quantity * price)
          : 0
    // Defaults keep the cash effect honest: a sale nets out fees/taxes, a
    // dividend nets out tax, everything else is gross.
    const netCents = normalized.netAmount !== undefined
      ? toCents(normalized.netAmount)
      : type === 'SELL'
        ? grossCents - feeCents - taxCents
        : type === 'DIVIDEND' || type === 'INTEREST'
          ? grossCents - taxCents
          : grossCents

    const event: CapitalEvent = {
      eventId: shortId('cev'),
      accountId: normalized.accountId,
      assetId: String(normalized.assetId ?? '').trim(),
      eventType: type,
      occurredAt,
      settledAt: String(normalized.settledAt ?? occurredAt).slice(0, 10),
      quantity,
      price,
      grossAmount: fromCents(grossCents),
      netAmount: fromCents(netCents),
      fee: fromCents(feeCents),
      tax: fromCents(taxCents),
      currency: String(normalized.currency ?? this.getAccount(normalized.accountId)?.baseCurrency ?? 'CNY').toUpperCase(),
      fxRate: Number(normalized.fxRate ?? 0),
      fxCurrency: String(normalized.fxCurrency ?? '').toUpperCase(),
      source: String(normalized.source ?? 'manual'),
      sourceTransactionId: String(normalized.sourceTransactionId ?? ''),
      importBatchId: String(normalized.importBatchId ?? ''),
      createdAt: nowIso(),
      correctionOf: String(normalized.correctionOf ?? ''),
      note: String(normalized.note ?? (issues.length > 0 ? issues.join('；') : '')),
    }
    this.events = [...this.events, event]
    await this.writeJson(this.eventsPath, this.events)
    return { event, duplicate: false, reason: '已入账' }
  }

  /** Append a correction event; the original keeps existing but stops counting. */
  async correctEvent(eventId: string, patch: Partial<CapitalEventInput>, reason: string): Promise<CapitalEvent> {
    const original = this.events.find((e) => e.eventId === eventId)
    if (!original) throw new Error(`未找到流水：${eventId}`)
    if (!reason.trim()) throw new Error('更正必须写理由')
    const { event } = await this.appendEvent({
      accountId: patch.accountId ?? original.accountId,
      eventType: patch.eventType ?? original.eventType,
      occurredAt: patch.occurredAt ?? original.occurredAt,
      assetId: patch.assetId ?? original.assetId,
      quantity: patch.quantity ?? original.quantity,
      price: patch.price ?? original.price,
      grossAmount: patch.grossAmount ?? original.grossAmount,
      netAmount: patch.netAmount ?? original.netAmount,
      fee: patch.fee ?? original.fee,
      tax: patch.tax ?? original.tax,
      currency: patch.currency ?? original.currency,
      fxRate: patch.fxRate ?? original.fxRate,
      fxCurrency: patch.fxCurrency ?? original.fxCurrency,
      source: 'correction',
      sourceTransactionId: `fix-${eventId}`,
      correctionOf: eventId,
      note: reason,
    })
    return event
  }

  // ------------------------------------------------------------------ import

  /**
   * Parse a CSV and return a preview. Nothing is written until `confirmImport`.
   * Expected headers (case-insensitive, 中文别名可用): date,type,account,asset,
   * quantity,price,amount,fee,tax,currency,fx_rate,fx_currency,source_id,note.
   */
  previewCsv(text: string, opts: { fileName?: string; source?: string } = {}): LedgerPreview {
    const rows = parseCsv(text)
    if (rows.length === 0) throw new Error('CSV 为空')
    const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
    const idx = (...names: string[]): number => {
      for (const name of names) {
        const i = header.indexOf(name)
        if (i >= 0) return i
      }
      return -1
    }
    const col = {
      date: idx('date', 'occurred_at', '日期', '成交日期'),
      type: idx('type', 'event_type', '类型', '业务'),
      account: idx('account', 'account_id', '账户'),
      asset: idx('asset', 'asset_id', 'code', '代码'),
      quantity: idx('quantity', 'qty', '数量'),
      price: idx('price', '价格', '成交价'),
      amount: idx('amount', 'gross_amount', '金额'),
      fee: idx('fee', '费用', '佣金'),
      tax: idx('tax', '税费', '印花税'),
      currency: idx('currency', '币种'),
      fxRate: idx('fx_rate', '汇率'),
      fxCurrency: idx('fx_currency', '换入币种'),
      sourceId: idx('source_id', 'transaction_id', '流水号', '成交编号'),
      note: idx('note', '备注'),
    }
    if (col.date < 0 || col.type < 0) throw new Error('CSV 缺少必要列：date / type')

    const previewRows: LedgerPreviewRow[] = []
    const accepted: CapitalEventInput[] = []
    const batchKeys = new Set<string>()
    let valid = 0
    let duplicates = 0
    let invalid = 0

    for (let r = 1; r < rows.length; r++) {
      const raw = rows[r]!
      const issues: string[] = []
      const eventType = normalizeEventType(raw[col.type])
      const accountId = (col.account >= 0 ? raw[col.account]?.trim() : '') || (this.accounts[0]?.accountId ?? '')
      const assetId = (col.asset >= 0 ? raw[col.asset]?.trim() : '') ?? ''
      const date = (raw[col.date] ?? '').trim().slice(0, 10)
      if (!eventType) issues.push(`无法识别类型「${raw[col.type] ?? ''}」`)
      if (!accountId) issues.push('缺少账户（CSV 无 account 列且账本没有账户）')
      else if (!this.getAccount(accountId)) issues.push(`未找到账户 ${accountId}`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) issues.push(`日期格式错误「${raw[col.date] ?? ''}」`)
      const num = (i: number): number | undefined => {
        if (i < 0) return undefined
        const cell = (raw[i] ?? '').trim().replace(/,/g, '')
        if (cell === '') return undefined
        const n = Number(cell)
        return Number.isFinite(n) ? n : undefined
      }
      const candidate: CapitalEventInput = {
        accountId,
        eventType: (eventType ?? 'DEPOSIT') as EventType,
        occurredAt: date,
        assetId,
        quantity: num(col.quantity) ?? 0,
        price: num(col.price) ?? 0,
        ...(num(col.amount) !== undefined ? { grossAmount: num(col.amount) } : {}),
        fee: num(col.fee) ?? 0,
        tax: num(col.tax) ?? 0,
        currency: (col.currency >= 0 ? (raw[col.currency] ?? '').trim().toUpperCase() : '') || (this.getAccount(accountId)?.baseCurrency ?? 'CNY'),
        ...(num(col.fxRate) !== undefined ? { fxRate: num(col.fxRate) } : {}),
        ...(col.fxCurrency >= 0 && (raw[col.fxCurrency] ?? '').trim() ? { fxCurrency: (raw[col.fxCurrency] ?? '').trim().toUpperCase() } : {}),
        source: String(opts.source ?? 'csv'),
        sourceTransactionId: col.sourceId >= 0 ? (raw[col.sourceId] ?? '').trim() : '',
        note: col.note >= 0 ? (raw[col.note] ?? '').trim() : '',
      }
      if (eventType) {
        try {
          validateEventInput(candidate)
        } catch (err) {
          issues.push(err instanceof Error ? err.message : String(err))
        }
      }
      const key = eventDedupeKey(candidate)
      const duplicate = batchKeys.has(key) || this.events.some((e) => eventDedupeKey(e) === key)
      if (duplicate) { duplicates++; batchKeys.add(key) }
      const ok = issues.length === 0 && !duplicate
      if (ok) { valid++; accepted.push(candidate) } else if (!duplicate) invalid++
      previewRows.push({ index: r, ok, duplicate, issues, event: ok ? candidate : candidate })
    }

    const preview: LedgerPreview = {
      previewId: shortId('prep'),
      createdAt: nowIso(),
      fileName: String(opts.fileName ?? 'import.csv'),
      source: String(opts.source ?? 'csv'),
      rows: previewRows,
      valid,
      duplicates,
      invalid,
    }
    this.previews.set(preview.previewId, { preview, rows: accepted, fileName: preview.fileName, source: preview.source })
    return preview
  }

  getPreview(previewId: string): LedgerPreview | undefined {
    return this.previews.get(previewId)?.preview
  }

  /** Write a previewed batch. Idempotent per row via the dedupe key. */
  async confirmImport(previewId: string): Promise<ImportBatch> {
    const entry = this.previews.get(previewId)
    if (!entry) throw new Error(`预览不存在或已过期：${previewId}`)
    const batch: ImportBatch = {
      batchId: shortId('batch'),
      createdAt: nowIso(),
      source: entry.source,
      fileName: entry.fileName,
      rows: entry.preview.rows.length,
      imported: 0,
      duplicates: entry.preview.duplicates,
      invalid: entry.preview.invalid,
      issues: [],
    }
    for (const candidate of entry.rows) {
      const result = await this.appendEvent({ ...candidate, importBatchId: batch.batchId })
      if (result.duplicate) batch.duplicates++
      else batch.imported++
    }
    this.batches = [...this.batches, batch]
    await this.writeJson(this.batchesPath, this.batches)
    this.previews.delete(previewId)
    return batch
  }

  listBatches(): ImportBatch[] {
    return [...this.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}
