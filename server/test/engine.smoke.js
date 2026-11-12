const { createEngine, marketFingerprint, clone } = require('../engine');
const t0=Date.now(); const api = createEngine({ startCash: 1000000 }); console.log('engine boot ms', Date.now()-t0, 'world', api.worldReady);
const seed = 12345;
api.newState('A','#f2b56b','#ff8fa3',seed); api.syncRng(); const A = api.getS();
api.newState('B','#d9d0c1','#7ab6e8',seed); api.syncRng(); const B = api.getS();
console.log('fp day1', marketFingerprint(A)===marketFingerprint(B));
// A trades
api.setS(A); const r0=api.rngNow();
console.log(api.doExchange('toUsd', 800000));
console.log(api.placeOrder('HAMV','buy','market',20,0,{tag:'test',text:''}));
console.log(api.placeOrder('SOTR','buy','limit',30,api.co('SOTR').price*0.98,null));
api.setRng(r0); api.syncRng();
const t1=Date.now();
for(let d=0; d<40; d++){
  for(const S of [A,B]){ api.setS(S); api.sleepToMorning(); api.syncRng(); }
  if(d===20){ api.setS(A); const r=api.rngNow(); const h=A.pf.hold.HAMV; if(h) console.log('sell', api.placeOrder('HAMV','sell','market',h.qty,0,null).msg); api.setRng(r); api.syncRng(); }
  if(marketFingerprint(A)!==marketFingerprint(B)){ console.log('DIVERGED at', d); break; }
}
console.log('40 days ms', Date.now()-t1, 'same', marketFingerprint(A)===marketFingerprint(B), 'day', A.clock.day);
api.setS(A); const ta=api.totalAssets(); api.setS(B); const tb=api.totalAssets();
console.log('A total', Math.round(ta), 'B total', Math.round(tb), 'A trades', A.trades.length, 'psy', A.psy&&A.psy.ev.length);
console.log('size KB', Math.round(JSON.stringify(A).length/1024));
const api2 = createEngine({ startCash: 2000000 }); api2.newState('C','#fff','#fff',999); console.log('room2 cash', api2.getS().pf.krw, 'collides test', api.collides(0,0), api.collides(31.5*32, 26.8*32));
