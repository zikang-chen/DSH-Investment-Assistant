import assert from 'node:assert/strict';
import { runPortfolioBacktest, type PortfolioBacktestInput } from '../src/strategy/portfolio-backtest.js';
const fixture = (): PortfolioBacktestInput => ({
  baseCurrency:'CNY',initialCash:1000,cashTargetWeight:0,
  assets:['A','B'].map(id => ({id,currency:'CNY',weight:0.5,lotSize:1,adjustment:'raw',
    prices:['2026-01-30','2026-02-02','2026-02-03','2026-02-04'].map(date => ({date,open:10,close:10})),
    actions:[],actionsComplete:true,tax:{buyFeeBps:0,sellFeeBps:0,minFee:0,sellTaxBps:0,slippageBps:0,dividendTaxRate:0.2},taxSource:'fixture explicit tax assumptions'})),
  fx:[],rebalance:{frequency:'none'},start:'2026-01-30',end:'2026-02-04',
});
let count=0;
function test(name:string,fn:()=>void) {fn();count++;console.log(`PASS ${name}`);}
function near(a:number,b:number) {assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);}
test('flat paper portfolio, stable key-order hash and no execution flags',()=>{
  const x=fixture(), r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.metrics!.profit,0);
  assert.equal(r.completeAccounting,true);assert.equal(r.coverage.externalVerified,false);assert.equal(r.coverage.totalReturnClaim,false);
  assert.equal(r.writesLedger,false);assert.equal(r.executesTrades,false);assert.equal(r.executionReady,false);assert.equal(r.paperOnly,true);
  const reversed=Object.fromEntries(Object.entries(x).reverse());assert.equal(runPortfolioBacktest(reversed).inputHash,r.inputHash);
  assert.equal(JSON.stringify(x),JSON.stringify(fixture()));
});
test('dividend entitlement, net receivable, pay-date cash, no double profit',()=>{
  const x=fixture();x.assets[0]!.actions=[{id:'d',type:'dividend',exDate:'2026-02-02',payDate:'2026-02-04',cashPerShare:1,source:'fixture declaration'}];
  for(const p of x.assets[0]!.prices.slice(1))p.open=p.close=9;
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.equity[1]!.receivables,40);near(r.equity[1]!.cash,0);
  near(r.equity[1]!.equity,990);near(r.equity[3]!.cash,40);near(r.equity[3]!.receivables,0);near(r.metrics!.profit,-10);near(r.metrics!.taxes,10);
  assert.equal(r.ledger.filter(e=>e.type==='dividend').length,1);near(r.ledger.reduce((s,e)=>s+e.cashDelta,1000),r.equity[3]!.cash);
});
test('ex-date pre-open holdings exclude new first-day buys',()=>{
  const x=fixture();x.assets[0]!.actions=[{id:'d',type:'dividend',exDate:x.start,payDate:x.start,cashPerShare:2,withholdingRate:0,source:'fixture'}];
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.metrics!.profit,0);near(r.ledger.find(e=>e.type==='dividend')!.amount,0);
});
test('split value conservation and zero fees',()=>{
  const x=fixture();x.assets[0]!.actions=[{id:'s',type:'split',exDate:'2026-02-02',ratio:2,source:'fixture split'}];
  for(const p of x.assets[0]!.prices.slice(1))p.open=p.close=5;
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.equity[1]!.positions[0]!.quantity,100);near(r.metrics!.profit,0);near(r.metrics!.fees,0);
  assert.equal(r.ledger.filter(e=>e.type==='split').length,1);
});
test('fees/minimum and slippage reduce affordability without negative cash',()=>{
  const x=fixture();for(const a of x.assets)a.tax={buyFeeBps:10,sellFeeBps:20,minFee:5,sellTaxBps:10,slippageBps:100};
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.metrics!.fees,10);assert.ok(r.metrics!.profit<0);
  for(const e of r.equity)assert.ok(e.cash>=0);for(const e of r.ledger.filter(e=>e.type==='buy'))near(e.price!,10.1);
  near(r.ledger.reduce((s,e)=>s+e.cashDelta,1000),r.equity[3]!.cash);
});
test('next-open execution never uses that open to determine target quantities',()=>{
  const x=fixture();x.rebalance={frequency:'monthly'};
  // February first close signals a lower A quantity; next open gaps down.
  x.assets[0]!.prices[1]!.close=20;
  const baseline=runPortfolioBacktest(x);assert.equal(baseline.ok,true);
  const changed=structuredClone(x);changed.assets[0]!.prices[2]!.open=5;changed.assets[0]!.prices[3]!.close=100;
  const other=runPortfolioBacktest(changed);assert.equal(other.ok,true);
  const sell=(r:ReturnType<typeof runPortfolioBacktest>)=>r.ledger.find(e=>e.type==='sell'&&e.assetId==='A')!;
  assert.equal(sell(baseline).date,'2026-02-03');assert.equal(sell(baseline).signalDate,'2026-02-02');
  assert.equal(sell(baseline).quantity,sell(other).quantity);assert.notEqual(sell(baseline).price,sell(other).price);
  assert.deepEqual(baseline.equity.slice(0,2),other.equity.slice(0,2));
});
test('FX valuation uses only latest past rate; missing/stale/future rejected',()=>{
  const x=fixture();x.assets[0]!.currency='USD';x.fx=[{date:'2026-01-30',currency:'USD',rate:2,source:'fixture'},{date:'2026-02-03',currency:'USD',rate:3,source:'fixture'}];
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.equity[0]!.positions[0]!.quantity,25);near(r.equity[2]!.equity,1250);
  x.fx[0]!.date='2026-02-01';assert.equal(runPortfolioBacktest(x).ok,false);
  x.fx=[{date:'2026-01-01',currency:'USD',rate:2,source:'fixture'}];assert.equal(runPortfolioBacktest(x).ok,false);
  x.fx=[];assert.equal(runPortfolioBacktest(x).ok,false);
});
test('foreign dividend receivable revalues and payment converts at pay-date FX',()=>{
  const x=fixture();x.assets[0]!.currency='USD';x.fx=[{date:x.start,currency:'USD',rate:2,source:'fixture'},{date:x.end,currency:'USD',rate:3,source:'fixture'}];
  x.assets[0]!.actions=[{id:'d',type:'dividend',exDate:'2026-02-02',payDate:x.end,cashPerShare:1,withholdingRate:0.2,source:'fixture'}];
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.equity[1]!.receivables,40);near(r.equity[3]!.cash,60);near(r.metrics!.taxes,15);
});
test('sell-before-buy rebalance respects lots, budget, fees and tax',()=>{
  const x=fixture();x.rebalance={frequency:'monthly',driftThreshold:0.15};
  x.assets[0]!.prices[1]!.close=30;x.assets[0]!.prices[2]!.open=3;
  for(const a of x.assets)a.tax={buyFeeBps:10,sellFeeBps:10,minFee:2,sellTaxBps:20,slippageBps:10};
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);for(const e of r.equity)assert.ok(e.cash>=0);
  for(const e of r.ledger.filter(e=>e.type==='buy'||e.type==='sell'))assert.equal(e.quantity%1,0);
  const trades=r.ledger.filter(e=>e.date==='2026-02-03'&&(e.type==='buy'||e.type==='sell'));assert.equal(trades[0]!.type,'sell');
  assert.ok(r.metrics!.taxes>0);near(r.ledger.reduce((s,e)=>s+e.cashDelta,1000),r.equity.at(-1)!.cash);
});
test('partial action/tax coverage never claims total return',()=>{
  const x=fixture();delete x.assets[0]!.actionsComplete;delete x.assets[1]!.taxSource;
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);assert.equal(r.completeAccounting,false);assert.equal(r.coverage.totalReturnClaim,false);assert.ok(r.gaps.length>=3);
});
test('reject bad callers, adjusted prices, dates, duplicates, missing tax-rate/source, unsupported actions',()=>{
  const mutations:Array<(x:any)=>void>=[
    x=>x.assets[0].adjustment='forward',x=>delete x.assets[0].adjustment,x=>x.assets[0].prices.reverse(),
    x=>x.assets[0].prices[0].date='2026-02-30',x=>x.initialCash=NaN,x=>x.assets[0].prices[0].close=Infinity,
    x=>x.cashTargetWeight=0.1,x=>x.assets[0].prices.push({...x.assets[0].prices[3]}),x=>x.assets[1].id='A',
    x=>x.assets[0].actions=[{id:'x',type:'merger',exDate:x.start,source:'fixture'}],
    x=>x.assets[0].actions=[{id:'d',type:'dividend',exDate:x.start,payDate:x.end,cashPerShare:1,source:''}],
    x=>{delete x.assets[0].tax.dividendTaxRate;x.assets[0].actions=[{id:'d',type:'dividend',exDate:x.start,payDate:x.end,cashPerShare:1,source:'fixture'}];},
    x=>{const c={id:'s',type:'split',exDate:x.start,ratio:2,source:'fixture'};x.assets[0].actions=[c,{...c}];},
    x=>{const c={id:'s',type:'split',exDate:x.start,ratio:2,source:'fixture'};x.assets[0].actions=[c,{...c,id:'s2'}];},
    x=>x.rebalance.extra=true,x=>x.assets[0].actions=[{id:'d',type:'dividend',exDate:x.end,payDate:x.start,cashPerShare:1,source:'fixture'}],
    x=>delete x.assets[0].tax,x=>x.assets[0].actionsComplete='yes',x=>x.assets[0].prices.splice(2),x=>x.assets[0].prices[1].date='2026-01-29',
    x=>{x.assets[0].actions=[{id:'s',type:'split',exDate:x.start,ratio:2,source:'fixture'},{id:'d',type:'dividend',exDate:x.start,payDate:x.end,cashPerShare:1,source:'fixture'}];},
  ];
  for(const mutate of mutations){const x=fixture();mutate(x);const r=runPortfolioBacktest(x);assert.equal(r.ok,false,JSON.stringify(x));assert.equal(r.ledger.length,0);assert.equal(r.equity.length,0);}
  for(const raw of [null,undefined,1,'x',[],new Date(),{...fixture(),unexpected:1}])assert.equal(runPortfolioBacktest(raw).ok,false);
  const getter=fixture();Object.defineProperty(getter,'start',{get(){throw Error('must not execute');}});assert.equal(runPortfolioBacktest(getter).ok,false);
});
test('common-date intersection and bounded input',()=>{
  const x=fixture();x.assets[0]!.prices.splice(1,1);assert.equal(runPortfolioBacktest(x).coverage.commonBars,3);
  x.assets[0]!.prices.splice(1,1);assert.equal(runPortfolioBacktest(x).ok,false);
  const huge=fixture();huge.assets=Array.from({length:21},(_,i)=>({...huge.assets[0]!,id:String(i)}));assert.equal(runPortfolioBacktest(huge).ok,false);
});
test('split adjusts pending close-derived targets without artificial sell signal',()=>{
  const x=fixture();x.rebalance={frequency:'monthly'};
  x.assets[0]!.actions=[{id:'s',type:'split',exDate:'2026-02-03',ratio:2,source:'fixture'}];
  for(const p of x.assets[0]!.prices.slice(2))p.open=p.close=5;
  const r=runPortfolioBacktest(x);assert.equal(r.ok,true);near(r.metrics!.profit,0);assert.equal(r.metrics!.tradeCount,2);
});
test('every output numeric field finite; deterministic repeated runs',()=>{
  const x=fixture(),r=runPortfolioBacktest(x);
  const check=(v:unknown):void=>{if(typeof v==='number')assert.ok(Number.isFinite(v));else if(v&&typeof v==='object')Object.values(v).forEach(check);};check(r);
  assert.deepEqual(runPortfolioBacktest(x),r);
});
console.log(`Portfolio backtest: ${count} offline fixture groups passed`);
