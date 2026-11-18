/** All weights are user-supplied, already converted into baseCurrency proportions. */
export interface PortfolioPolicyInput {
  asOf: string;
  baseCurrency: string;
  positions: Array<{
    id: string; name?: string; assetClass: string; currency: string;
    currentWeight: number; targetWeight: number;
    minWeight?: number; maxWeight?: number; priceAsOf?: string;
  }>;
  cashWeight: number;
  targetCashWeight: number;
  constraints: {
    maxAssetWeight: number; maxAssetClassWeight: number; minCashWeight: number;
    maxTurnover: number; driftThreshold: number;
  };
  review: { lastReviewedAt?: string; cadenceDays: number };
  signals?: Array<{
    topic: string; claim: string; source: string; asOf: string;
    direction: 'risk' | 'support' | 'neutral';
  }>;
}

export interface PortfolioMetrics {
  /** HHI and top1 include cash as one separate bucket. */
  hhi: number;
  top1: number;
  /** Invested positions only; cash is reported separately. */
  assetClassWeights: Record<string, number>;
  /** Includes cash in baseCurrency; NOT a sum of currency prices. */
  currencyWeights: Record<string, number>;
  cash: number;
}

export interface PortfolioPolicyResult {
  ok: boolean;
  status: 'BLOCKED' | 'REVIEW_REQUIRED' | 'WITHIN_POLICY';
  errors: string[];
  gaps: string[];
  assumptions: string[];
  inputHash: string;
  policyHash: string;
  requiresApproval: true;
  autoChange: false;
  writesLedger: false;
  executesTrades: false;
  executionReady: false;
  current?: PortfolioMetrics;
  target?: PortfolioMetrics;
  drifts?: Array<{ id: string; currentWeight: number; targetWeight: number; drift: number; absoluteDrift: number }>;
  cashDrift?: number;
  turnover?: number;
  constraintChecks?: Array<{ kind: 'single' | 'assetClass' | 'cash' | 'turnover' | 'perAsset'; key: string; actual: number; min?: number; max?: number; satisfied: boolean }>;
  triggers: Array<{ kind: 'due' | 'drift' | 'evidenceRisk' | 'evidenceSupport' | 'constraintBreach'; detail: string }>;
  acceptedSignals: NonNullable<PortfolioPolicyInput['signals']>;
  excludedSignals: Array<{ index: number; reason: 'future' | 'stale' }>;
  proposed?: {
    weights: Array<{ id: string; weight: number }>;
    cashWeight: number;
    changes: Array<{ id: string; from: number; to: number; delta: number }>;
    cashChange: { from: number; to: number; delta: number };
  };
}

const EPSILON = 1e-9;
const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 30;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v === v.trim();
const weight = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Calendar dates, not local-midnight timestamps. Leap days are verified by round trip. */
function day(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return undefined;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return undefined;
  return time / DAY_MS;
}

/** Key-order independent; preserves invalid numbers rather than aliasing NaN with null. */
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `number:${String(value)}`;
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (seen.has(value)) return 'circular';
  seen.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map(v => canonical(v, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], seen)}`).join(',')}}`;
  seen.delete(value);
  return encoded;
}
/** Browser-compatible FNV-1a-64 fingerprint, NOT cryptographic authentication. */
function hash(value: unknown): string {
  let state = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical(value))) {
    state ^= BigInt(byte);
    state = BigInt.asUintN(64, state * 0x100000001b3n);
  }
  return `fnv1a64:${state.toString(16).padStart(16, '0')}`;
}

function metrics(input: PortfolioPolicyInput, target: boolean): PortfolioMetrics {
  const cash = target ? input.targetCashWeight : input.cashWeight;
  const assetClasses = new Map<string, number>();
  const currencies = new Map<string, number>([[input.baseCurrency, cash]]);
  let hhi = cash * cash;
  let top1 = cash;
  for (const p of input.positions) {
    const w = target ? p.targetWeight : p.currentWeight;
    hhi += w * w;
    top1 = Math.max(top1, w);
    assetClasses.set(p.assetClass, (assetClasses.get(p.assetClass) ?? 0) + w);
    currencies.set(p.currency, (currencies.get(p.currency) ?? 0) + w);
  }
  return { hhi, top1, assetClassWeights: Object.fromEntries([...assetClasses].sort()), currencyWeights: Object.fromEntries([...currencies].sort()), cash };
}

/** Pure paper policy review: no clocks, data fetching, account access, ledger writes or trading. */
export function evaluatePortfolioPolicy(input: PortfolioPolicyInput): PortfolioPolicyResult {
  const result: PortfolioPolicyResult = {
    ok: false, status: 'BLOCKED', errors: [], gaps: [],
    assumptions: [
      'Strategic target weights must be explicitly supplied by the user; evidence never changes them.',
      'inputHash/policyHash are deterministic FNV-1a-64 fingerprints, not cryptographic integrity or authenticity guarantees.',
      'Weights are already converted to baseCurrency by the user. FX rates and asset values are not verified; currency weights are exposure proportions, not sums of prices.',
      'Dates are strict YYYY-MM-DD calendar days; age is measured in whole UTC calendar days relative to the supplied asOf, not the system clock.',
      'HHI/top1 include cash as a separate bucket; assetClassWeights and class caps cover invested positions only. Currency weights include baseCurrency cash.',
      'Turnover = half of the sum of absolute position and cash weight changes. No normalization, quantity calculation, transaction costs or feasibility verification.',
      'Missing/future/older-than-30-day prices do not prevent weight mathematics but suppress the paper proposal. Approval is always required and executionReady is always false.',
    ],
    inputHash: hash(input), policyHash: hash({ version: 1, invalidInput: true }),
    requiresApproval: true, autoChange: false, writesLedger: false, executesTrades: false,
    executionReady: false, triggers: [], acceptedSignals: [], excludedSignals: [],
  };
  const errors = result.errors;
  if (!isRecord(input)) { errors.push('input must be an object'); return result; }
  const asOfDay = day(input.asOf);
  if (asOfDay === undefined) errors.push('asOf must be a real YYYY-MM-DD calendar date');
  if (!text(input.baseCurrency)) errors.push('baseCurrency must be a nonempty trimmed string');
  for (const k of ['cashWeight', 'targetCashWeight'] as const) if (!weight(input[k])) errors.push(`${k} must be a finite weight in [0,1]`);
  const validPositions = Array.isArray(input.positions) && input.positions.length >= 2 && input.positions.length <= 20;
  if (!validPositions) errors.push('positions must contain 2-20 entries');
  const ids = new Set<string>();
  if (Array.isArray(input.positions)) input.positions.forEach((p, i) => {
    const prefix = `positions[${i}]`;
    if (!isRecord(p)) { errors.push(`${prefix} must be an object`); return; }
    for (const k of ['id', 'assetClass', 'currency'] as const) if (!text(p[k])) errors.push(`${prefix}.${k} must be a nonempty trimmed string`);
    if (text(p.id)) { if (ids.has(p.id)) errors.push(`${prefix}.id is duplicated`); ids.add(p.id); }
    if (p.name !== undefined && !text(p.name)) errors.push(`${prefix}.name must be a nonempty trimmed string`);
    for (const k of ['currentWeight', 'targetWeight'] as const) if (!weight(p[k])) errors.push(`${prefix}.${k} must be a finite weight in [0,1]`);
    for (const k of ['minWeight', 'maxWeight'] as const) if (p[k] !== undefined && !weight(p[k])) errors.push(`${prefix}.${k} must be a finite weight in [0,1]`);
    if (weight(p.minWeight) && weight(p.maxWeight) && p.minWeight > p.maxWeight) errors.push(`${prefix}.minWeight exceeds maxWeight`);
    if (p.priceAsOf !== undefined && day(p.priceAsOf) === undefined) errors.push(`${prefix}.priceAsOf must be a real YYYY-MM-DD calendar date`);
  });
  if (!isRecord(input.constraints)) errors.push('constraints must be an object');
  else for (const k of ['maxAssetWeight', 'maxAssetClassWeight', 'minCashWeight', 'maxTurnover', 'driftThreshold'] as const)
    if (!weight(input.constraints[k])) errors.push(`constraints.${k} must be a finite weight in [0,1]`);
  if (!isRecord(input.review)) errors.push('review must be an object');
  else {
    if (!Number.isSafeInteger(input.review.cadenceDays) || input.review.cadenceDays <= 0) errors.push('review.cadenceDays must be a positive safe integer');
    if (input.review.lastReviewedAt !== undefined) {
      const last = day(input.review.lastReviewedAt);
      if (last === undefined) errors.push('review.lastReviewedAt must be a real YYYY-MM-DD calendar date');
      else if (asOfDay !== undefined && last > asOfDay) errors.push('review.lastReviewedAt must not be in the future');
    }
  }
  if (input.signals !== undefined && !Array.isArray(input.signals)) errors.push('signals must be an array');
  else input.signals?.forEach((s, i) => {
    if (!isRecord(s)) { errors.push(`signals[${i}] must be an object`); return; }
    for (const k of ['topic', 'claim', 'source'] as const) if (!text(s[k])) errors.push(`signals[${i}].${k} must be a nonempty trimmed string`);
    if (day(s.asOf) === undefined) errors.push(`signals[${i}].asOf must be a real YYYY-MM-DD calendar date`);
    if (!['risk', 'support', 'neutral'].includes(s.direction)) errors.push(`signals[${i}].direction is invalid`);
  });
  if (errors.length) return result;
  const currentTotal = input.positions.reduce((s, p) => s + p.currentWeight, input.cashWeight);
  const targetTotal = input.positions.reduce((s, p) => s + p.targetWeight, input.targetCashWeight);
  if (Math.abs(currentTotal - 1) > EPSILON) errors.push('current weights plus cashWeight must sum to 1 (no normalization)');
  if (Math.abs(targetTotal - 1) > EPSILON) errors.push('target weights plus targetCashWeight must sum to 1 (no normalization)');
  if (errors.length) return result;

  result.ok = true;
  result.policyHash = hash({ version: 1, baseCurrency: input.baseCurrency,
    positions: input.positions.map(p => ({ id: p.id, assetClass: p.assetClass, currency: p.currency,
      targetWeight: p.targetWeight, minWeight: p.minWeight, maxWeight: p.maxWeight })),
    targetCashWeight: input.targetCashWeight, constraints: input.constraints, cadenceDays: input.review.cadenceDays });
  result.current = metrics(input, false);
  result.target = metrics(input, true);
  result.drifts = input.positions.map(p => ({ id: p.id, currentWeight: p.currentWeight, targetWeight: p.targetWeight,
    drift: p.currentWeight - p.targetWeight, absoluteDrift: Math.abs(p.currentWeight - p.targetWeight) }));
  result.cashDrift = input.cashWeight - input.targetCashWeight;
  result.turnover = (result.drifts.reduce((s, p) => s + p.absoluteDrift, 0) + Math.abs(result.cashDrift)) / 2;
  const checks: NonNullable<PortfolioPolicyResult['constraintChecks']> = [];
  const cap = (kind: typeof checks[number]['kind'], key: string, actual: number, min?: number, max?: number) => {
    checks.push({ kind, key, actual, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
      satisfied: (min === undefined || actual >= min - EPSILON) && (max === undefined || actual <= max + EPSILON) });
  };
  for (const p of input.positions) {
    cap('single', p.id, p.targetWeight, undefined, input.constraints.maxAssetWeight);
    if (p.minWeight !== undefined || p.maxWeight !== undefined) cap('perAsset', p.id, p.targetWeight, p.minWeight, p.maxWeight);
  }
  for (const [cls, w] of Object.entries(result.target.assetClassWeights)) cap('assetClass', cls, w, undefined, input.constraints.maxAssetClassWeight);
  cap('cash', 'cash', input.targetCashWeight, input.constraints.minCashWeight);
  cap('turnover', 'turnover', result.turnover, undefined, input.constraints.maxTurnover);
  result.constraintChecks = checks;
  for (const c of checks) if (!c.satisfied) result.triggers.push({ kind: 'constraintBreach', detail: `${c.kind}:${c.key}` });
  if (input.review.lastReviewedAt === undefined || asOfDay! - day(input.review.lastReviewedAt)! >= input.review.cadenceDays)
    result.triggers.push({ kind: 'due', detail: input.review.lastReviewedAt === undefined ? 'No previous review date supplied' : 'Review cadence reached' });
  for (const d of result.drifts) if (d.absoluteDrift > EPSILON && d.absoluteDrift + EPSILON >= input.constraints.driftThreshold)
    result.triggers.push({ kind: 'drift', detail: d.id });
  if (Math.abs(result.cashDrift) > EPSILON && Math.abs(result.cashDrift) + EPSILON >= input.constraints.driftThreshold)
    result.triggers.push({ kind: 'drift', detail: 'cash' });
  for (const [index, signal] of (input.signals ?? []).entries()) {
    const age = asOfDay! - day(signal.asOf)!;
    if (age < 0 || age > MAX_AGE_DAYS) {
      const reason = age < 0 ? 'future' : 'stale';
      result.excludedSignals.push({ index, reason });
      result.gaps.push(`signals[${index}] excluded: ${reason} evidence (${signal.asOf})`);
    } else {
      result.acceptedSignals.push({ ...signal });
      if (signal.direction !== 'neutral') result.triggers.push({ kind: signal.direction === 'risk' ? 'evidenceRisk' : 'evidenceSupport', detail: `${signal.topic}: ${signal.claim} [${signal.source}; ${signal.asOf}]` });
    }
  }
  let pricesFresh = true;
  for (const p of input.positions) {
    const age = p.priceAsOf === undefined ? undefined : asOfDay! - day(p.priceAsOf)!;
    if (age === undefined || age < 0 || age > MAX_AGE_DAYS) {
      pricesFresh = false;
      result.gaps.push(`${p.id}: ${age === undefined ? 'missing' : age < 0 ? 'future' : 'stale'} priceAsOf`);
    }
  }
  result.gaps.push('FX rates, asset values, liquidity, transaction costs and execution feasibility are not verified.');
  result.status = checks.some(c => !c.satisfied) ? 'BLOCKED' : result.triggers.length ? 'REVIEW_REQUIRED' : 'WITHIN_POLICY';
  if (result.status !== 'BLOCKED' && pricesFresh) result.proposed = {
    weights: input.positions.map(p => ({ id: p.id, weight: p.targetWeight })), cashWeight: input.targetCashWeight,
    changes: input.positions.filter(p => p.currentWeight !== p.targetWeight).map(p => ({ id: p.id, from: p.currentWeight, to: p.targetWeight, delta: p.targetWeight - p.currentWeight })),
    cashChange: { from: input.cashWeight, to: input.targetCashWeight, delta: input.targetCashWeight - input.cashWeight },
  };
  return result;
}
