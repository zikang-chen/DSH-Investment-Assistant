/** Offline paper accounting only. No IO, provider, broker, or real-ledger dependencies.
 * Prices and FX are caller assumptions, never externally verified. All cash is held in
 * baseCurrency; trades/dividend payments convert immediately at supplied past FX.
 */
export interface PortfolioBacktestTax {
  buyFeeBps: number; sellFeeBps: number; minFee: number; sellTaxBps: number;
  slippageBps: number; dividendTaxRate?: number;
}
export interface PortfolioBacktestAction {
  id: string; type: 'dividend' | 'split'; exDate: string; payDate?: string;
  cashPerShare?: number; ratio?: number; withholdingRate?: number; source: string;
}
export interface PortfolioBacktestAsset {
  id: string; currency: string; weight: number; lotSize: number; adjustment: 'raw';
  prices: Array<{ date: string; open: number; close: number }>;
  actions: PortfolioBacktestAction[]; actionsComplete?: boolean;
  tax: PortfolioBacktestTax; taxSource?: string;
}
export interface PortfolioBacktestInput {
  baseCurrency: string; initialCash: number; cashTargetWeight: number;
  assets: PortfolioBacktestAsset[];
  /** Base-currency units per ONE foreign-currency unit; no future filling. */
  fx: Array<{ date: string; currency: string; rate: number; source: string }>;
  rebalance: { frequency: 'monthly' | 'quarterly' | 'annual' | 'none'; driftThreshold?: number };
  start: string; end: string;
}
export interface PortfolioBacktestLedgerEvent {
  date: string; type: 'buy' | 'sell' | 'dividendReceivable' | 'dividend' | 'split' | 'tax' | 'fee';
  assetId: string; currency: string; quantity: number; amount: number; baseAmount: number;
  cashDelta: number; fxRate: number; source: string; actionId?: string;
  price?: number; signalDate?: string;
}
export interface PortfolioBacktestEquity {
  date: string; cash: number; holdingsValue: number; receivables: number; equity: number; profit: number;
  positions: Array<{ assetId: string; quantity: number; close: number; fxRate: number; value: number }>;
}
export interface PortfolioBacktestResult {
  ok: boolean; errors: string[]; inputHash: string;
  paperOnly: true; writesLedger: false; executesTrades: false; executionReady: false;
  completeAccounting: boolean;
  coverage: { externalVerified: false; totalReturnClaim: false; inputDeclaredComplete: boolean; commonBars: number; actualStart?: string; actualEnd?: string };
  assumptions: string[]; gaps: string[];
  metrics?: { initialCash: number; finalEquity: number; profit: number; returnRate: number;
    maxDrawdown: number; fees: number; taxes: number; tradeCount: number };
  ledger: PortfolioBacktestLedgerEvent[]; equity: PortfolioBacktestEquity[];
}
const DAY = 86400000;
function fail(message: string): never { throw new Error(message); }
function record(v: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(`${name}: expected plain object`);
  const ds = Object.getOwnPropertyDescriptors(v);
  for (const k of Reflect.ownKeys(ds)) {
    if (typeof k !== 'string' || !keys.includes(k) || !('value' in ds[k]!)) fail(`${name}: unknown/accessor field ${String(k)}`);
  }
  return v as Record<string, unknown>;
}
function num(v: unknown, name: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name}: invalid finite number`);
  return v;
}
function text(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length > 500) fail(`${name}: required text`);
  return v;
}
function day(v: unknown): number {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000')) fail('invalid date');
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) fail('invalid calendar date');
  return t / DAY;
}
function array(v: unknown, max: number, name: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(`${name}: expected bounded array <= ${max}`);
  return v;
}
/** Canonical, bounded validated input; FNV-1a is a reproducibility fingerprint, not authentication. */
function fingerprint(v: unknown): string {
  const canonical = (x: unknown): string => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` :
    x !== null && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(x) ?? 'undefined';
  let h = 2166136261;
  for (const c of canonical(v)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
function validate(raw: unknown): PortfolioBacktestInput {
  const x = record(raw, ['baseCurrency','initialCash','cashTargetWeight','assets','fx','rebalance','start','end'], 'input');
  text(x.baseCurrency, 'baseCurrency'); num(x.initialCash, 'initialCash', Number.MIN_VALUE, 1e15);
  num(x.cashTargetWeight, 'cashTargetWeight', 0, 1);
  if (day(x.end) < day(x.start) || day(x.end) - day(x.start) > 20000) fail('invalid/bounded date range');
  const assets = array(x.assets, 20, 'assets'); if (assets.length < 2) fail('2-20 assets required');
  const ids = new Set<string>(); let sum = x.cashTargetWeight as number, totalActions = 0;
  for (const rawAsset of assets) {
    const a = record(rawAsset, ['id','currency','weight','lotSize','adjustment','prices','actions','actionsComplete','tax','taxSource'], 'asset');
    const id = text(a.id, 'asset.id'); if (ids.has(id)) fail('duplicate asset'); ids.add(id);
    text(a.currency, 'currency'); sum += num(a.weight, 'weight', 0, 1); num(a.lotSize, 'lotSize', 1e-8, 1e12);
    if (a.adjustment !== 'raw') fail('explicit adjustment: raw required');
    if (a.actionsComplete !== undefined && typeof a.actionsComplete !== 'boolean') fail('actionsComplete must be boolean');
    if (a.taxSource !== undefined) text(a.taxSource, 'taxSource');
    {
      const t = record(a.tax, ['buyFeeBps','sellFeeBps','minFee','sellTaxBps','slippageBps','dividendTaxRate'], 'tax');
      for (const k of ['buyFeeBps','sellFeeBps','sellTaxBps','slippageBps']) num(t[k], k, 0, k === 'slippageBps' ? 9999 : 10000);
      num(t.minFee, 'minFee', 0, 1e12);
      if (t.dividendTaxRate !== undefined) num(t.dividendTaxRate, 'dividendTaxRate', 0, 1);
    }
    let prev = -Infinity;
    const prices = array(a.prices, 5000, 'prices'); if (prices.length < 3) fail('at least 3 raw bars per asset');
    for (const p0 of prices) {
      const p = record(p0, ['date','open','close'], 'price'); const d = day(p.date);
      if (d <= prev) fail('prices must be strictly increasing and unique'); prev = d;
      num(p.open, 'open', 1e-12, 1e12); num(p.close, 'close', 1e-12, 1e12);
    }
    const actionIds = new Set<string>(); const signatures = new Set<string>(); const exTypes = new Set<string>();
    const actions = array(a.actions, 5000, 'actions'); totalActions += actions.length;
    if (totalActions > 5000) fail('at most 5000 corporate actions in aggregate');
    for (const c0 of actions) {
      const c = record(c0, ['id','type','exDate','payDate','cashPerShare','ratio','withholdingRate','source'], 'action');
      const cid = text(c.id, 'action.id'); text(c.source, 'action.source'); const ex = day(c.exDate);
      if (actionIds.has(cid)) fail('duplicate action id'); actionIds.add(cid);
      if (c.type !== 'split' && c.type !== 'dividend') fail('unsupported corporate action');
      const signature = `${c.type}:${c.exDate}:${c.payDate}:${c.cashPerShare}:${c.ratio}`;
      if (signatures.has(signature)) fail('duplicate corporate action'); signatures.add(signature);
      if (c.type === 'split' && exTypes.has(`${c.exDate}:split`)) fail('multiple same-day splits unsupported');
      // Same-day mixed split/dividend requires an entitlement ordering not represented by this schema.
      if (exTypes.has(`${c.exDate}:${c.type === 'split' ? 'dividend' : 'split'}`)) fail('ambiguous same-day split/dividend');
      exTypes.add(`${c.exDate}:${c.type}`);
      if (c.type === 'split') {
        num(c.ratio, 'split ratio', 1e-6, 1e6);
        if (c.payDate !== undefined || c.cashPerShare !== undefined || c.withholdingRate !== undefined) fail('unsupported split fields');
      } else {
        if (day(c.payDate) < ex) fail('payDate precedes exDate');
        num(c.cashPerShare, 'cashPerShare', 0, 1e12);
        if (c.ratio !== undefined) fail('unsupported dividend ratio');
        num(c.withholdingRate ?? (a.tax as PortfolioBacktestTax | undefined)?.dividendTaxRate, 'explicit dividend tax rate', 0, 1);
      }
    }
  }
  if (Math.abs(sum - 1) > 1e-9) fail('asset weights + cashTargetWeight must equal 1');
  const r = record(x.rebalance, ['frequency','driftThreshold'], 'rebalance');
  if (!['monthly','quarterly','annual','none'].includes(r.frequency as string)) fail('invalid frequency');
  if (r.driftThreshold !== undefined) num(r.driftThreshold, 'driftThreshold', 0, 1);
  const prevFx = new Map<string, number>();
  for (const f0 of array(x.fx, 100000, 'fx')) {
    const f = record(f0, ['date','currency','rate','source'], 'fx'); const currency = text(f.currency, 'fx.currency');
    const d = day(f.date); if (d <= (prevFx.get(currency) ?? -Infinity)) fail('FX must be increasing/unique per currency'); prevFx.set(currency, d);
    num(f.rate, 'fx.rate', 1e-12, 1e12); text(f.source, 'fx.source');
    if (currency === x.baseCurrency && f.rate !== 1) fail('base FX must equal 1');
  }
  return raw as PortfolioBacktestInput;
}

/** Strict unknown boundary: invalid/unsupported inputs produce a blocked result, never partial trades.
 * Initial allocation executes on first common open. Subsequent target quantities use
 * previous common close ONLY, then execute on next common open (including gap risk).
 * Calendar cadence is observed at the first common close in a new period. Drift is
 * an independent OR trigger. Shares are not borrowed; cash may not be negative.
 */
export function runPortfolioBacktest(raw: unknown): PortfolioBacktestResult {
  const result: PortfolioBacktestResult = {
    ok: false, errors: [], inputHash: 'invalid', paperOnly: true, writesLedger: false, executesTrades: false, executionReady: false,
    completeAccounting: false, coverage: { externalVerified: false, totalReturnClaim: false, inputDeclaredComplete: false, commonBars: 0 },
    assumptions: [
      'Paper simulation only; input prices, FX, actions and tax sources are caller assumptions, not externally verified.',
      'Raw prices only; common-date intersection is not a verified exchange calendar. Liquidity, halts and actual fills are unverified.',
      'Base-currency cash; immediate FX conversion without FX spread. Fees/minFee are asset-currency amounts per order.',
      'Ex-date entitlement uses holdings before that day open; net receivables count in equity, cash arrives only on payDate; tax booked on payment.',
      'Split preserves fractional shares with zero fee; only subsequent orders must be lot multiples. No cash-in-lieu, complex actions, borrow or leverage.',
      'Targets use previous common close; next common open fills are sell-first, buy-budget-capped in input asset order; unspent residual stays cash.',
    ], gaps: [], ledger: [], equity: [],
  };
  try {
    const x = validate(raw); result.inputHash = fingerprint(x);
    const complete = x.assets.every(a => a.actionsComplete === true && a.tax !== undefined && !!a.taxSource);
    result.completeAccounting = complete; result.coverage.inputDeclaredComplete = complete;
    for (const a of x.assets) {
      if (a.actionsComplete !== true) result.gaps.push(`${a.id}: corporate-action coverage not declared complete`);
      if (!a.taxSource) result.gaps.push(`${a.id}: tax source missing; supplied numerical tax assumptions are partial unverified coverage`);
    }
    result.gaps.push('No external verification of action completeness, tax applicability, calendars or liquidity; no verified total-return claim.');
    const maps = x.assets.map(a => new Map(a.prices.map(p => [p.date, p])));
    const dates = x.assets[0]!.prices.map(p => p.date).filter(d => d >= x.start && d <= x.end && maps.every(m => m.has(d)));
    if (dates.length < 3) fail('at least 3 common trading dates required'); result.coverage.commonBars = dates.length;
    result.coverage.actualStart = dates[0]!; result.coverage.actualEnd = dates[dates.length-1]!;
    if (dates[0] !== x.start || dates[dates.length-1] !== x.end) result.gaps.push('Requested endpoints differ from common-bar valuation horizon; only actualStart through actualEnd are valued.');
    const fxTables = new Map<string, PortfolioBacktestInput['fx']>();
    for (const f of x.fx) { const list = fxTables.get(f.currency) ?? []; list.push(f); fxTables.set(f.currency, list); }
    const fx = (currency: string, date: string): number => {
      if (currency === x.baseCurrency) return 1;
      const rows = fxTables.get(currency) ?? []; let lo = 0, hi = rows.length - 1, found = -1;
      while (lo <= hi) { const mid = (lo + hi) >>> 1; if (rows[mid]!.date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1; }
      if (found < 0 || day(date) - day(rows[found]!.date) > 7) fail(`missing/stale past FX ${currency} on ${date}`);
      return rows[found]!.rate;
    };
    // Validate every required valuation FX before simulation. Corporate events validate on their own calendar dates.
    for (const date of dates) for (const a of x.assets) fx(a.currency, date);
    let cash = x.initialCash, fees = 0, taxes = 0, tradeCount = 0;
    const qty = x.assets.map(() => 0);
    const receivables: Array<{ index: number; action: PortfolioBacktestAction; gross: number; tax: number; paid: boolean }> = [];
    const emit = (date: string, index: number, type: PortfolioBacktestLedgerEvent['type'], quantity: number, amount: number, cashDelta: number, source: string, extra: Partial<PortfolioBacktestLedgerEvent> = {}) => {
      const a = x.assets[index]!; const rate = fx(a.currency, date);
      result.ledger.push({ date, type, assetId: a.id, currency: a.currency, quantity, amount, baseAmount: amount * rate, cashDelta, fxRate: rate, source, ...extra });
    };
    const events = x.assets.flatMap((a, index) => a.actions.flatMap(action => [
      { date: action.exDate, kind: 'ex' as const, index, action },
      ...(action.type === 'dividend' ? [{ date: action.payDate!, kind: 'pay' as const, index, action }] : []),
    ])).filter(e => e.date >= dates[0]! && e.date <= x.end)
      .sort((a,b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.index - b.index : a.kind === 'ex' ? -1 : 1));
    let eventIndex = 0;
    const processEvents = (until: string) => {
      while (eventIndex < events.length && events[eventIndex]!.date <= until) {
        const e = events[eventIndex++]!, a = x.assets[e.index]!, c = e.action;
        if (e.kind === 'ex' && c.type === 'split') {
          const before = qty[e.index]!; qty[e.index] = before * c.ratio!;
          emit(e.date, e.index, 'split', qty[e.index]! - before, 0, 0, c.source, { actionId: c.id });
        } else if (e.kind === 'ex') {
          const gross = qty[e.index]! * c.cashPerShare!;
          const tax = gross * (c.withholdingRate ?? a.tax!.dividendTaxRate!);
          receivables.push({ index: e.index, action: c, gross, tax, paid: false });
          emit(e.date, e.index, 'dividendReceivable', qty[e.index]!, gross, 0, c.source, { actionId: c.id });
        } else {
          const r = receivables.find(r => r.index === e.index && r.action.id === c.id && !r.paid);
          if (!r) continue; r.paid = true; const rate = fx(a.currency, e.date);
          cash += (r.gross - r.tax) * rate; taxes += r.tax * rate;
          emit(e.date, e.index, 'dividend', 0, r.gross, r.gross * rate, c.source, { actionId: c.id });
          if (r.tax > 0) emit(e.date, e.index, 'tax', 0, r.tax, -r.tax * rate, c.source, { actionId: c.id });
        }
      }
    };
    const period = (d: string) => x.rebalance.frequency === 'monthly' ? d.slice(0,7) : x.rebalance.frequency === 'quarterly' ? `${d.slice(0,4)}-${Math.floor((Number(d.slice(5,7))-1)/3)}` : d.slice(0,4);
    let pending: { quantities: number[]; signalDate: string } | undefined;
    for (let di = 0; di < dates.length; di++) {
      const date = dates[di]!; processEvents(date);
      if (di === 0) pending = { quantities: x.assets.map((a,i) => Math.floor((cash * a.weight / (maps[i]!.get(date)!.open * fx(a.currency,date))) / a.lotSize) * a.lotSize), signalDate: date };
      if (pending) {
        // Orders signaled before a split must be split-adjusted too.
        const desired = pending.quantities.map((q,i) => q * x.assets[i]!.actions.filter(c => c.type === 'split' && c.exDate > pending!.signalDate && c.exDate <= date).reduce((v,c) => v*c.ratio!,1));
        for (const side of ['sell','buy'] as const) for (let i = 0; i < x.assets.length; i++) {
          const a = x.assets[i]!, t = a.tax, rate = fx(a.currency,date);
          const delta = desired[i]! - qty[i]!; if (side === 'buy' ? delta <= 0 : delta >= 0) continue;
          const price = maps[i]!.get(date)!.open * (1 + (side === 'buy' ? 1 : -1) * t.slippageBps / 10000);
          let lots = Math.floor(Math.abs(delta) / a.lotSize);
          if (!Number.isSafeInteger(lots)) fail('order exceeds safe lot-count bound');
          const cost = (n: number) => { const gross = n * a.lotSize * price; return (gross + Math.max(t.minFee, gross*t.buyFeeBps/10000))*rate; };
          if (side === 'buy') { let low = 0, high = lots; while (low < high) { const mid = low + Math.ceil((high-low)/2); if (cost(mid) <= cash) low = mid; else high = mid-1; } lots = low; }
          const quantity = lots * a.lotSize; if (quantity <= 0) continue;
          const gross = quantity * price, fee = Math.max(t.minFee,gross*(side === 'buy' ? t.buyFeeBps : t.sellFeeBps)/10000), tax = side === 'sell' ? gross*t.sellTaxBps/10000 : 0;
          if (side === 'sell' && (gross-fee-tax)*rate + cash < 0) continue;
          const sign = side === 'buy' ? -1 : 1;
          cash += (sign*gross-fee-tax)*rate; qty[i] = qty[i]! - sign*quantity; fees += fee*rate; taxes += tax*rate; tradeCount++;
          const source = a.taxSource ?? 'Caller-provided tax numbers; source missing';
          emit(date,i,side,quantity,gross,sign*gross*rate,source,{price,signalDate:pending.signalDate});
          if (fee > 0) emit(date,i,'fee',0,fee,-fee*rate,source);
          if (tax > 0) emit(date,i,'tax',0,tax,-tax*rate,source);
        }
        pending = undefined;
      }
      const positions = x.assets.map((a,i) => { const close = maps[i]!.get(date)!.close, rate = fx(a.currency,date); return { assetId:a.id,quantity:qty[i]!,close,fxRate:rate,value:qty[i]!*close*rate }; });
      const holdingsValue = positions.reduce((s,p) => s+p.value,0);
      const receivableValue = receivables.filter(r => !r.paid).reduce((s,r) => s+(r.gross-r.tax)*fx(x.assets[r.index]!.currency,date),0);
      const equity = cash+holdingsValue+receivableValue;
      if (cash < -1e-8 || qty.some(q => q < -1e-8)) fail('accounting invariant: negative cash/shares');
      result.equity.push({date,cash,holdingsValue,receivables:receivableValue,equity,profit:equity-x.initialCash,positions});
      if (di < dates.length-1 && equity > 0) {
        const cadence = x.rebalance.frequency !== 'none' && di > 0 && period(date) !== period(dates[di-1]!);
        const drift = x.rebalance.driftThreshold !== undefined && Math.max(Math.abs(cash/equity-x.cashTargetWeight),...positions.map((p,i) => Math.abs(p.value/equity-x.assets[i]!.weight))) > x.rebalance.driftThreshold;
        if (cadence || drift) pending = { signalDate:date, quantities:x.assets.map((a,i) => Math.floor((equity*a.weight/(positions[i]!.close*positions[i]!.fxRate))/a.lotSize)*a.lotSize) };
      }
    }
    // Events after the last common bar are deliberately outside the reported valuation horizon.
    const final = result.equity[result.equity.length-1]!; let peak = x.initialCash, maxDrawdown = 0;
    for (const e of result.equity) { peak = Math.max(peak,e.equity); maxDrawdown = Math.max(maxDrawdown,(peak-e.equity)/peak); }
    result.metrics = { initialCash:x.initialCash,finalEquity:final.equity,profit:final.profit,returnRate:final.profit/x.initialCash,maxDrawdown,fees,taxes,tradeCount };
    const checkFinite = (v: unknown): void => { if (typeof v === 'number' && !Number.isFinite(v)) fail('numeric overflow'); if (v && typeof v === 'object') for (const n of Object.values(v)) checkFinite(n); };
    checkFinite(result); result.ok = true; return result;
  } catch (error) {
    result.ok = false; result.errors = [error instanceof Error ? error.message : 'invalid input'];
    result.completeAccounting = false; result.coverage.inputDeclaredComplete = false;
    result.ledger = []; result.equity = []; delete result.metrics; return result;
  }
}
