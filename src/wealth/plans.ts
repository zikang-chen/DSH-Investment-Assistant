/**
 * Saved wealth plans (scenarios).
 *
 * A plan is just the inputs plus a snapshot of the deterministic result at save
 * time. Re-computing on read is intentional: if the engine changes, the numbers
 * in an old plan stay honest because they are labelled with the engine version.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'
import { compound, solveGoal, yuan, type CompoundInput } from './compound.js'

export const WEALTH_ENGINE_VERSION = 'compound/1'

export interface WealthPlanInput extends CompoundInput {
  name: string
  targetCents?: number
}

export interface WealthPlan {
  planId: string
  name: string
  createdAt: string
  updatedAt: string
  engineVersion: string
  input: CompoundInput
  targetCents?: number
  snapshot: {
    finalCents: number
    finalYuan: number
    contributedYuan: number
    growthYuan: number
    finalRealYuan: number
    realRate: number
    netAnnualRate: number
    years: number
  }
  notes: string
}

interface PlansFile { version: 1; updatedAt: string; plans: WealthPlan[] }

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return `wpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export class WealthPlanStore {
  readonly file: string
  private plans: WealthPlan[] = []
  private loaded = false
  private readonly log?: Logger

  constructor(dir: string, logger?: Logger) {
    this.file = path.join(dir, 'plans.json')
    this.log = logger?.child('wealth')
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as PlansFile
      this.plans = Array.isArray(parsed.plans) ? parsed.plans : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn('wealth plans unreadable', { error: String(err) })
      this.plans = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  all(): WealthPlan[] {
    return [...this.plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(planId: string): WealthPlan | undefined {
    return this.plans.find((p) => p.planId === planId)
  }

  /** Compute + persist one scenario. Inputs are validated by `compound`. */
  async save(input: CompoundInput & { name: string; targetCents?: number; notes?: string }): Promise<WealthPlan> {
    const result = compound(input)
    const plan: WealthPlan = {
      planId: shortId(),
      name: String(input.name ?? '').trim() || '未命名情景',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      engineVersion: WEALTH_ENGINE_VERSION,
      input: {
        principalCents: input.principalCents,
        contributionCents: input.contributionCents ?? 0,
        frequency: input.frequency ?? 'monthly',
        timing: input.timing ?? 'end',
        annualRate: input.annualRate,
        annualFee: input.annualFee ?? 0,
        inflation: input.inflation ?? 0,
        years: input.years,
        contributionGrowth: input.contributionGrowth ?? 0,
      },
      ...(input.targetCents ? { targetCents: input.targetCents } : {}),
      snapshot: {
        finalCents: result.finalCents,
        finalYuan: yuan(result.finalCents),
        contributedYuan: yuan(result.contributedCents),
        growthYuan: yuan(result.growthCents),
        finalRealYuan: yuan(result.finalRealCents),
        realRate: result.realRate,
        netAnnualRate: result.netAnnualRate,
        years: result.years,
      },
      notes: String(input.notes ?? ''),
    }
    this.plans = [...this.plans, plan]
    await this.persist()
    return plan
  }

  async remove(planId: string): Promise<boolean> {
    const before = this.plans.length
    this.plans = this.plans.filter((p) => p.planId !== planId)
    if (this.plans.length === before) return false
    await this.persist()
    return true
  }

  /** Side-by-side comparison of saved plans (same engine, deterministic). */
  compare(planIds: string[]): Array<{
    planId: string
    name: string
    finalYuan: number
    contributedYuan: number
    growthYuan: number
    finalRealYuan: number
    netAnnualRate: number
    years: number
    targetReached?: boolean
  }> {
    const plans = planIds.length > 0
      ? planIds.map((id) => this.get(id)).filter((p): p is WealthPlan => Boolean(p))
      : this.all()
    return plans.map((plan) => ({
      planId: plan.planId,
      name: plan.name,
      finalYuan: plan.snapshot.finalYuan,
      contributedYuan: plan.snapshot.contributedYuan,
      growthYuan: plan.snapshot.growthYuan,
      finalRealYuan: plan.snapshot.finalRealYuan,
      netAnnualRate: plan.snapshot.netAnnualRate,
      years: plan.snapshot.years,
      ...(plan.targetCents ? { targetReached: plan.snapshot.finalCents >= plan.targetCents } : {}),
    }))
  }

  /** Recompute a saved plan with the current engine (diff shows engine drift). */
  recompute(planId: string): { plan: WealthPlan; finalYuan: number; same: boolean } | undefined {
    const plan = this.get(planId)
    if (!plan) return undefined
    const result = compound(plan.input)
    return { plan, finalYuan: yuan(result.finalCents), same: result.finalCents === plan.snapshot.finalCents }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: PlansFile = { version: 1, updatedAt: nowIso(), plans: this.all() }
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

export { compound, solveGoal, yuan }
