/** Explicit-input, browser-compatible verification. No I/O, clocks, accounts or trading. */
export interface PortfolioVerificationInput {
  asOf: string;
  baseCurrency: string;
  positions: Array<{ id: string; currency: string; quantity: number; price?: number; priceAsOf?: string; priceSource?: string; assetClass: string }>;
  cash: Array<{ currency: string; amount: number }>;
  fx: Array<{ currency: string; baseCurrency: string; rate: number; asOf: string; source: string }>;
  histories: Array<{ id: string; currency: string; points: Array<{ date: string; close: number }> }>;
  fundHoldings?: Array<{ fundId: string; asOf: string; source: string; holdings: Array<{ id: string; weight: number }> }>;
}

export interface PortfolioVerificationResult {
  asOf: string;
  baseCurrency: string;
  valid: boolean;
  errors: string[];
  gaps: string[];
  /** Sum of priced, FX-converted assets and cash only; never a total if incomplete. */
  pricedKnownValue: number;
  unknownAssets: Array<{ id: string; kind: 'position' | 'cash'; currency: string; reasons: string[] }>;
  completeValuation: boolean;
  canCreatePolicy: boolean;
  /** Absent unless every position and cash entry is valued and total value is positive. */
  weights?: Array<{ id: string; kind: 'position' | 'cash'; currency: string; value: number; weight: number }>;
  currencyExposures?: Array<{ currency: string; value: number; weight: number }>;
  /** Replaces fund parents with disclosed constituents. Direct positions retained; cash excluded. */
  knownLookthrough: Array<{ id: string; value: number; portfolioWeight: number | null; contributions: Array<{ positionId: string; value: number }> }>;
  /** Residual undisclosed fund exposure / FULL portfolio value, never a disclosed-only normalization. */
  unknownFundWeight: number | null;
  unknownFundValue: number;
  fundCoverage: Array<{ fundId: string; disclosedWeight: number; unknownWeight: number; usable: boolean; asOf?: string; source?: string }>;
  covariance: null | {
    ids: string[]; currency: string; returnDates: string[]; observations: number;
    daily: number[][]; annualized: number[][]; correlations: Array<Array<number | null>>;
    basis: 'native-currency daily simple returns; no historical FX conversion';
    annualization: 252; sampleDenominator: 'n-1';
  };
  provenance: {
    valuationCurrency: string;
    maxAgeDays: { price: 7; fx: 7; fundHoldings: 120 };
    prices: Array<{ id: string; asOf?: string; source?: string; accepted: boolean }>;
    fx: Array<{ currency: string; baseCurrency: string; rate: number; asOf: string; source: string; accepted: boolean }>;
    histories: Array<{ id: string; currency: string; priceCount: number; accepted: boolean }>;
    notes: string[];
  };
}

const DAY_MS = 86_400_000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.trim() === v;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function day(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000')) return undefined;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? t / DAY_MS : undefined;
}
function freshness(date: unknown, asOf: number, max: number): string | undefined {
  const d = day(date);
  if (d === undefined) return 'missing or invalid date';
  if (d > asOf) return 'future date';
  if (asOf - d > max) return `older than ${max} days`;
  return undefined;
}

/** Runtime validation is intentional: callers may receive JSON rather than typed objects. */
export function verifyPortfolioData(input: PortfolioVerificationInput): PortfolioVerificationResult {
  const out: PortfolioVerificationResult = {
    asOf: record(input) && typeof input.asOf === 'string' ? input.asOf : '',
    baseCurrency: record(input) && typeof input.baseCurrency === 'string' ? input.baseCurrency : '',
    valid: false, errors: [], gaps: [], pricedKnownValue: 0, unknownAssets: [],
    completeValuation: false, canCreatePolicy: false, knownLookthrough: [],
    unknownFundWeight: null, unknownFundValue: 0, fundCoverage: [], covariance: null,
    provenance: {
      valuationCurrency: record(input) && typeof input.baseCurrency === 'string' ? input.baseCurrency : '',
      maxAgeDays: { price: 7, fx: 7, fundHoldings: 120 }, prices: [], fx: [], histories: [],
      notes: [
        'All dates are strict UTC calendar dates relative to supplied asOf; age boundaries are inclusive.',
        'FX is baseCurrency units per one currency unit. Base currency uses identity 1 without FX data.',
        'Known value is not total value when anything is unknown; no partial-portfolio normalization.',
        'Fund disclosures are partial top-N observations, not complete holdings; no industry or underlying currency inferred.',
        'Currency exposures are denomination exposures including cash, not fund underlying FX exposures.',
        'Covariance uses common price dates then simple returns, n-1 sample covariance and 252 annualization; no filling.',
        'No historical FX input exists: covariance is native-currency only, never labelled base-currency for foreign assets.',
      ],
    },
  };
  const errors = out.errors;
  if (!record(input)) { errors.push('input must be an object'); return out; }
  const asOf = day(input.asOf);
  if (asOf === undefined) errors.push('asOf must be a real YYYY-MM-DD date');
  if (!text(input.baseCurrency)) errors.push('baseCurrency must be a nonempty trimmed string');
  for (const k of ['positions', 'cash', 'fx', 'histories'] as const) if (!Array.isArray(input[k])) errors.push(`${k} must be an array`);
  if (errors.length) return out;
  if (input.positions.length === 0 && input.cash.length === 0) errors.push('portfolio is empty');
  const ids = new Set<string>();
  input.positions.forEach((p, i) => {
    const at = `positions[${i}]`;
    if (!record(p)) { errors.push(`${at} must be an object`); return; }
    for (const k of ['id', 'currency', 'assetClass'] as const) if (!text(p[k])) errors.push(`${at}.${k} must be nonempty trimmed text`);
    if (ids.has(p.id)) errors.push(`${at}.id is duplicated`);
    ids.add(p.id);
    if (!finite(p.quantity) || p.quantity < 0) errors.push(`${at}.quantity must be finite and nonnegative`);
    if (p.price !== undefined && (!finite(p.price) || p.price <= 0)) errors.push(`${at}.price must be positive finite`);
    if (p.priceAsOf !== undefined && day(p.priceAsOf) === undefined) errors.push(`${at}.priceAsOf is invalid`);
    if (p.priceSource !== undefined && !text(p.priceSource)) errors.push(`${at}.priceSource is invalid`);
  });
  const cashCurrencies = new Set<string>();
  input.cash.forEach((c, i) => {
    if (!record(c)) { errors.push(`cash[${i}] must be an object`); return; }
    if (!text(c.currency)) errors.push(`cash[${i}].currency is invalid`);
    if (cashCurrencies.has(c.currency)) errors.push(`cash[${i}].currency is duplicated`);
    cashCurrencies.add(c.currency);
    if (!finite(c.amount) || c.amount < 0) errors.push(`cash[${i}].amount must be finite and nonnegative`);
  });
  const fxCurrencies = new Set<string>();
  input.fx.forEach((f, i) => {
    if (!record(f)) { errors.push(`fx[${i}] must be an object`); return; }
    if (!text(f.currency) || !text(f.baseCurrency)) errors.push(`fx[${i}] currencies are invalid`);
    if (f.baseCurrency !== input.baseCurrency) errors.push(`fx[${i}].baseCurrency does not match portfolio`);
    if (fxCurrencies.has(f.currency)) errors.push(`fx[${i}].currency is duplicated`);
    fxCurrencies.add(f.currency);
    if (!finite(f.rate) || f.rate <= 0) errors.push(`fx[${i}].rate must be positive finite`);
    if (f.currency === input.baseCurrency && f.rate !== 1) errors.push(`fx[${i}] base-currency rate must equal 1`);
    if (day(f.asOf) === undefined) errors.push(`fx[${i}].asOf is invalid`);
    if (!text(f.source)) errors.push(`fx[${i}].source is required`);
  });
  // Invalid history is rejected as a sequence, not quietly repaired or filled.
  const histories = new Map<string, PortfolioVerificationInput['histories'][number]>();
  const historyIds = new Set<string>();
  input.histories.forEach((h, i) => {
    if (!record(h)) { errors.push(`histories[${i}] must be an object`); return; }
    let accepted = true;
    const reject = (reason: string) => { out.gaps.push(`history ${String(h.id)}: ${reason}`); accepted = false; };
    if (!text(h.id) || !text(h.currency)) { errors.push(`histories[${i}] id/currency is invalid`); accepted = false; }
    if (historyIds.has(h.id)) { errors.push(`histories[${i}].id is duplicated`); accepted = false; }
    historyIds.add(h.id);
    const p = input.positions.find(p => record(p) && p.id === h.id);
    if (!p) reject('not a portfolio position');
    else if (p.currency !== h.currency) reject('currency disagrees with position');
    if (!Array.isArray(h.points) || h.points.length === 0) reject('empty or missing prices');
    else {
      const dates = new Set<string>();
      h.points.forEach(point => {
        if (!record(point)) { reject('invalid price point'); return; }
        if (day(point.date) === undefined) reject('invalid calendar date');
        else if (asOf !== undefined && day(point.date)! > asOf) reject('future price date');
        if (dates.has(point.date)) reject('duplicate price date');
        dates.add(point.date);
        if (!finite(point.close) || point.close <= 0) reject('close must be positive finite');
      });
    }
    out.provenance.histories.push({ id: h.id, currency: h.currency, priceCount: Array.isArray(h.points) ? h.points.length : 0, accepted });
    if (accepted) histories.set(h.id, h);
  });
  const disclosures = new Map<string, NonNullable<PortfolioVerificationInput['fundHoldings']>[number]>();
  const fundIds = new Set<string>();
  if (input.fundHoldings !== undefined && !Array.isArray(input.fundHoldings)) errors.push('fundHoldings must be an array');
  else input.fundHoldings?.forEach((f, i) => {
    if (!record(f)) { errors.push(`fundHoldings[${i}] must be an object`); return; }
    if (!text(f.fundId) || !ids.has(f.fundId)) errors.push(`fundHoldings[${i}].fundId must identify a position`);
    if (fundIds.has(f.fundId)) errors.push(`fundHoldings[${i}].fundId is duplicated`);
    fundIds.add(f.fundId);
    if (day(f.asOf) === undefined) errors.push(`fundHoldings[${i}].asOf is invalid`);
    if (!text(f.source)) errors.push(`fundHoldings[${i}].source is required`);
    if (!Array.isArray(f.holdings)) { errors.push(`fundHoldings[${i}].holdings must be an array`); return; }
    const underlyingIds = new Set<string>();
    let sum = 0;
    f.holdings.forEach((h, j) => {
      if (!record(h)) { errors.push(`fundHoldings[${i}].holdings[${j}] must be an object`); return; }
      if (!text(h.id) || underlyingIds.has(h.id) || h.id === f.fundId) errors.push(`fundHoldings[${i}] underlying id invalid, self-referential or duplicated`);
      underlyingIds.add(h.id);
      if (!finite(h.weight) || h.weight < 0 || h.weight > 1) errors.push(`fundHoldings[${i}] weight must be finite in [0,1]`);
      else sum += h.weight;
    });
    if (sum > 1) errors.push(`fundHoldings[${i}] disclosed weights exceed 1`);
    disclosures.set(f.fundId, f);
  });
  if (errors.length || asOf === undefined) return out;
  out.valid = true;
  const fx = new Map<string, number>([[input.baseCurrency, 1]]);
  input.fx.forEach(f => {
    const reason = freshness(f.asOf, asOf, 7);
    out.provenance.fx.push({ ...f, accepted: !reason });
    if (reason) out.gaps.push(`FX ${f.currency}: ${reason}`);
    else fx.set(f.currency, f.rate);
  });
  const values: Array<{ id: string; kind: 'position' | 'cash'; currency: string; value: number }> = [];
  const positionValues = new Map<string, number>();
  for (const p of input.positions) {
    const reasons: string[] = [];
    const priceAge = freshness(p.priceAsOf, asOf, 7);
    if (p.quantity > 0) {
      if (p.price === undefined) reasons.push('missing price');
      if (priceAge) reasons.push(`price ${priceAge}`);
      if (!text(p.priceSource)) reasons.push('missing price source');
      if (!fx.has(p.currency)) reasons.push('missing usable FX rate/source/date');
    }
    out.provenance.prices.push({ id: p.id, asOf: p.priceAsOf, source: p.priceSource, accepted: reasons.length === 0 && p.quantity > 0 });
    const value = p.quantity === 0 ? 0 : p.quantity * (p.price ?? NaN) * (fx.get(p.currency) ?? NaN);
    if (reasons.length === 0 && !finite(value)) reasons.push('valuation overflow');
    if (reasons.length) {
      out.unknownAssets.push({ id: p.id, kind: 'position', currency: p.currency, reasons });
      out.gaps.push(`${p.id}: ${reasons.join('; ')}`);
    } else { values.push({ id: p.id, kind: 'position', currency: p.currency, value }); positionValues.set(p.id, value); }
  }
  for (const c of input.cash) {
    const reasons = c.amount !== 0 && !fx.has(c.currency) ? ['missing usable FX rate/source/date'] : [];
    const value = c.amount === 0 ? 0 : c.amount * (fx.get(c.currency) ?? NaN);
    if (!reasons.length && !finite(value)) reasons.push('valuation overflow');
    if (reasons.length) {
      out.unknownAssets.push({ id: `cash:${c.currency}`, kind: 'cash', currency: c.currency, reasons });
      out.gaps.push(`cash ${c.currency}: ${reasons.join('; ')}`);
    } else values.push({ id: `cash:${c.currency}`, kind: 'cash', currency: c.currency, value });
  }
  const total = values.reduce((sum, v) => sum + v.value, 0);
  if (!finite(total)) { out.valid = false; errors.push('known valuation sum overflow'); return out; }
  out.pricedKnownValue = total;
  out.completeValuation = out.unknownAssets.length === 0 && total > 0;
  if (total === 0) out.gaps.push('no positive known portfolio value');
  if (out.completeValuation) {
    out.weights = values.map(v => ({ ...v, weight: v.value / total }));
    const currencies = new Map<string, number>();
    values.forEach(v => currencies.set(v.currency, (currencies.get(v.currency) ?? 0) + v.value));
    out.currencyExposures = [...currencies].map(([currency, value]) => ({ currency, value, weight: value / total }));
  }
  out.canCreatePolicy = out.completeValuation && input.positions.filter(p => p.quantity > 0).length >= 2;
  const lookthrough = new Map<string, { value: number; contributions: Array<{ positionId: string; value: number }> }>();
  const addExposure = (id: string, positionId: string, value: number) => {
    const prior = lookthrough.get(id) ?? { value: 0, contributions: [] };
    prior.value += value; prior.contributions.push({ positionId, value }); lookthrough.set(id, prior);
  };
  for (const p of input.positions) {
    const f = disclosures.get(p.id);
    const isFund = f !== undefined || /^(fund|etf|基金)$/i.test(p.assetClass);
    const value = positionValues.get(p.id);
    if (!isFund) { if (value !== undefined) addExposure(p.id, p.id, value); continue; }
    const age = f ? freshness(f.asOf, asOf, 120) : 'missing disclosure';
    const usable = f !== undefined && !age;
    const disclosedWeight = usable ? f.holdings.reduce((sum, h) => sum + h.weight, 0) : 0;
    const unknownWeight = 1 - disclosedWeight;
    out.fundCoverage.push({ fundId: p.id, asOf: f?.asOf, source: f?.source, usable, disclosedWeight, unknownWeight });
    if (age) out.gaps.push(`fund ${p.id}: ${age}; all underlying exposure unknown`);
    if (unknownWeight > 0) out.gaps.push(`fund ${p.id}: ${(unknownWeight * 100).toFixed(6)}% of fund holdings undisclosed (top-N only)`);
    if (value !== undefined) {
      out.unknownFundValue += value * unknownWeight;
      if (usable) f.holdings.forEach(h => addExposure(h.id, p.id, value * h.weight));
    }
  }
  out.knownLookthrough = [...lookthrough].map(([id, e]) => ({ id, ...e, portfolioWeight: out.completeValuation ? e.value / total : null }));
  out.unknownFundWeight = out.completeValuation ? out.unknownFundValue / total : null;

  const active = input.positions.filter(p => p.quantity > 0);
  if (active.length < 2) { out.gaps.push('covariance requires at least two positive-quantity positions'); return out; }
  if (new Set(active.map(p => p.currency)).size !== 1) {
    out.gaps.push('covariance rejected: mixed currencies and no historical FX series; spot FX cannot convert historical returns'); return out;
  }
  if (active.some(p => !histories.has(p.id))) {
    out.gaps.push('covariance unavailable: one or more required histories missing or rejected; no zero-fill'); return out;
  }
  const series = active.map(p => histories.get(p.id)!);
  const priceMaps = series.map(h => new Map(h.points.map(p => [p.date, p.close])));
  const common = [...priceMaps[0].keys()].filter(d => priceMaps.every(m => m.has(d))).sort();
  if (common.length < 31) { out.gaps.push(`covariance requires 31 common price dates / 30 returns; got ${common.length} prices`); return out; }
  // Require each pair of intersected dates to be consecutive observations in EVERY input series.
  // Otherwise an omitted date could silently turn one asset's multi-day move into a daily return.
  const nextDates = series.map(h => {
    const dates = h.points.map(p => p.date).sort();
    return new Map(dates.slice(1).map((date, i) => [dates[i], date]));
  });
  const returns: number[][] = active.map(() => []);
  const returnDates: string[] = [];
  for (let i = 1; i < common.length; i++) {
    const previous = common[i - 1], current = common[i];
    if (!nextDates.every(m => m.get(previous) === current)) continue;
    const row = priceMaps.map(m => m.get(current)! / m.get(previous)! - 1);
    if (row.some(r => !finite(r))) { out.gaps.push('covariance rejected: nonfinite return arithmetic'); return out; }
    row.forEach((r, j) => returns[j].push(r)); returnDates.push(current);
  }
  const n = returnDates.length;
  if (n < 30) { out.gaps.push(`covariance requires 30 common daily return dates without missing observations; got ${n}`); return out; }
  const means = returns.map(rs => rs.reduce((sum, r) => sum + r, 0) / n);
  const daily = returns.map((rs, i) => returns.map((other, j) => rs.reduce((sum, r, k) => sum + (r - means[i]) * (other[k] - means[j]), 0) / (n - 1)));
  const annualized = daily.map(row => row.map(v => v * 252));
  if (daily.some(row => row.some(v => !finite(v))) || annualized.some(row => row.some(v => !finite(v)))) {
    out.gaps.push('covariance rejected: numeric overflow'); return out;
  }
  const correlations = daily.map((row, i) => row.map((cov, j) => {
    if (daily[i][i] === 0 || daily[j][j] === 0) return null;
    const value = cov / Math.sqrt(daily[i][i]) / Math.sqrt(daily[j][j]);
    return finite(value) ? Math.max(-1, Math.min(1, value)) : null;
  }));
  out.covariance = { ids: active.map(p => p.id), currency: active[0].currency, returnDates, observations: n, daily, annualized, correlations,
    basis: 'native-currency daily simple returns; no historical FX conversion', annualization: 252, sampleDenominator: 'n-1' };
  return out;
}
