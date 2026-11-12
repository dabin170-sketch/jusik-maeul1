'use strict';
/* 서버 자동 검사 — `npm test`
   진짜 서버를 임시 폴더로 띄우고, 웹소켓 손님 여러 명으로 PART 11 필수 항목을 확인해요. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jusik-test-'));
let srv;
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? '  — ' + detail : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(){
  return new Promise((res, rej) => {
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, DATA_DIR: DATA, DATABASE_URL: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    srv.stdout.on('data', d => { const s = d.toString(); if(process.env.VERBOSE) process.stdout.write('[srv] ' + s); if(!done && s.includes('서버 시작')){ done = true; res(); } });
    srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
    setTimeout(() => { if(!done) rej(new Error('server start timeout')); }, 8000);
  });
}
function stopServer(){ return new Promise(r => { srv.once('exit', r); srv.kill('SIGTERM'); }); }

class Client {
  constructor(name){ this.name = name; this.msgs = []; this.waiters = []; this.state = null; this.room = null; }
  open(){ return new Promise((res, rej) => { this.ws = new WebSocket(`ws://localhost:${PORT}/ws`); this.ws.on('open', res); this.ws.on('error', rej);
    this.ws.on('message', d => { const m = JSON.parse(d.toString()); this.msgs.push(m);
      if(m.t === 'market:snapshot') this.state = m.state;
      if(m.t === 'room:state') this.room = m;
      if(m.t === 'room:joined'){ this.pid = m.pid; this.code = m.code; if(m.token) this.token = m.token; }
      if(m.t === 'me:update' && this.state){ Object.assign(this.state, { pf: m.pf, orders: m.orders }); }
      this.waiters = this.waiters.filter(w => { if(w.pred(m)){ w.res(m); return false; } return true; }); }); }); }
  send(o){ this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 6000){ const hit = this.msgs.find(pred); return new Promise((res, rej) => { this.waiters.push({ pred, res }); setTimeout(() => rej(new Error(this.name + ' wait timeout')), ms); }); }
  waitNew(pred, ms){ const n = this.msgs.length; return this.wait(m => this.msgs.indexOf(m) >= n && pred(m), ms); }
  close(){ this.ws.close(); }
}
const total = s => { let v = s.pf.krw + s.pf.usd * s.fx; for(const id in s.pf.hold) v += s.pf.hold[id].qty * s.cos[id].price * s.fx; return v; };

(async () => {
  await startServer();
  try{
    // 1. 방 만들기
    const A = new Client('햄찌'); await A.open();
    const joinedA = A.waitNew(m => m.t === 'room:joined');
    A.send({ t: 'room:create', nick: '햄찌', avatar: { color: '#f2b56b', scarf: '#ff8fa3' }, settings: { name: '테스트 마을', startCash: 1000000 } });
    const ja = await joinedA;
    ok('1. 첫 번째 플레이어가 방을 만들 수 있음', ja.code && /^[A-Z]{3}-[A-Z0-9]{4}$/.test(ja.code) && ja.token && ja.isHost, ja.code);
    const code = ja.code;
    // 2. 세 명 더 입장
    const names = ['냥이', '토끼', '수달'], others = [];
    for(const nm of names){ const c = new Client(nm); await c.open(); const w = c.waitNew(m => m.t === 'room:joined'); c.send({ t: 'room:join', code, nick: nm, avatar: { color: '#d9d0c1', scarf: '#7ab6e8' } }); await w; others.push(c); }
    await sleep(150);
    ok('2. 나머지 세 명이 같은 코드로 입장', A.room && A.room.players.length === 4, A.room && A.room.players.map(p => p.nick).join(', '));
    // 3. 다섯 번째는 거절
    const E = new Client('다섯째'); await E.open(); const we = E.waitNew(m => m.t === 'error'); E.send({ t: 'room:join', code, nick: '다섯째' }); const ee = await we;
    ok('3. 다섯 번째 플레이어는 입장할 수 없음', ee.code === 'full', ee.msg);
    const W = new Client('틀린코드'); await W.open(); const ww = W.waitNew(m => m.t === 'error'); W.send({ t: 'room:join', code: 'HAM-ZZZZ', nick: '누구' }); const ew = await ww;
    ok('   틀린 코드에는 분명한 오류 메시지', ew.code === 'no_room' || ew.code === 'bad_code', ew.msg); E.close(); W.close();
    // 시작
    for(const c of others) c.send({ t: 'lobby:ready', ready: true }); await sleep(100);
    const snaps = [A, ...others].map(c => c.waitNew(m => m.t === 'market:snapshot'));
    A.send({ t: 'host:start' }); await Promise.all(snaps);
    // 4·5. 서로 보이고 움직임 반영
    const posWait = others[0].waitNew(m => m.t === 'player:pos' && m.list.some(x => x[0] === A.pid && Math.abs(x[1] - (31.5 * 32 + 10)) < 2));
    const sx = A.state.player.x; A.send({ t: 'player:move', x: 31.5 * 32 + 10, y: 26.8 * 32, dir: 'right', moving: true, seq: 1, warp: 'map' }); const pm = await posWait.catch(() => null);
    ok('4·5. 같은 마을에서 서로의 위치가 실시간으로 전달됨', !!pm, pm ? `${pm.list.length}명 위치 수신` : '');
    // 6·7. 초기 자산 독립 · 같은 주가
    const cash = [A, ...others].map(c => c.state.pf.krw), prices = [A, ...others].map(c => c.state.cos.HAMV.price);
    ok('6. 네 명의 초기 자산이 독립적으로 100만 원씩', cash.every(v => v === 1000000), cash.join(','));
    ok('7. 네 명에게 동일한 주가', new Set(prices).size === 1, 'HAMV ' + prices[0]);
    ok('   클라이언트로 미래 정보(난수 상태·씨앗·숨은 국면)가 나가지 않음', A.state.rng === undefined && A.state.mkt.reg === 'hidden' && !A.state.dayData.intra);
    // 8. 한 명의 매수가 다른 사람 예수금을 바꾸지 않음 — 환전 후 HAMV 매수 (장 시작 전이라 예약 주문)
    let rid = 0; const order = (c, o) => { const reqId = c.name + '-' + (++rid); const w = c.waitNew(m => m.t === 'market:orderResult' && m.reqId === reqId); c.send(Object.assign({ reqId, day: c.state.clock.day }, o)); return w; };
    const fxs = await Promise.all([A, ...others].map((c, i) => order(c, { t: 'market:fx', dir: 'toUsd', amount: [900000, 800000, 700000, 600000][i] })));
    ok('   네 명 모두 환전 성공 (서버 처리)', fxs.every(r => r.ok), fxs.map(r => r.ok).join(','));
    await sleep(100);
    const usdBefore = others.map(c => c.state.pf.usd);
    // 9. 동시에 매수 — 같은 순간 네 명이 각자 다른 수량
    const qty = [3, 2, 2, 1];
    const buys = await Promise.all([A, ...others].map((c, i) => order(c, { t: 'market:order', cid: 'HAMV', side: 'buy', type: 'market', qty: qty[i] })));
    ok('9a. 네 명이 동시에 햄비디아 주문 → 모두 접수', buys.every(r => r.ok), buys.map(r => r.msg.slice(0, 20)).join(' / '));
    await sleep(150);
    // 같은 주문 번호 재전송 → 중복 체결 없음
    const reqId = 'A-dup-1'; const w1 = A.waitNew(m => m.t === 'market:orderResult' && m.reqId === reqId);
    A.send({ t: 'market:order', reqId, day: A.state.clock.day, cid: 'SOTR', side: 'buy', type: 'market', qty: 2 }); await w1;
    const w2 = A.waitNew(m => m.t === 'market:orderResult' && m.reqId === reqId);
    A.send({ t: 'market:order', reqId, day: A.state.clock.day, cid: 'SOTR', side: 'buy', type: 'market', qty: 2 }); const dup = await w2;
    await sleep(100);
    ok('   같은 주문 번호를 다시 보내도 한 번만 처리', dup.dup === true && A.state.orders.filter(o => o.cid === 'SOTR').length === 1);
    // 잔고 초과 주문 거절 (연속 클릭으로 같은 돈을 두 번 쓰지 못함)
    const big = await Promise.all([1, 2].map(() => order(others[2], { t: 'market:order', cid: 'APFX', side: 'buy', type: 'market', qty: 1 })));
    const resv = others[2].state.orders.filter(o => o.status === 'open').reduce((a, o) => a + (o.reserve || 0), 0);
    ok('9b. 연속 클릭해도 예수금을 넘겨 쓰지 못함', resv <= others[2].state.pf.usd + 1e-6, `예약 ${resv.toFixed(2)} ≤ 보유 ${others[2].state.pf.usd.toFixed(2)} · 결과 ${big.map(r => r.ok).join(',')}`);
    ok('8. 한 명의 매수가 다른 사람 예수금을 바꾸지 않음', others.map(c => c.state.pf.usd).every((v, i) => v === usdBefore[i]));
    // 위조 시도: 클라이언트가 돈·주가를 바꾸는 메시지를 보내도 무시
    A.send({ t: 'player:patch', d: { pf: { krw: 999999999, usd: 999999 }, cos: { HAMV: { price: 1 } }, life: { coinsDelta: 5 } } });
    A.send({ t: 'market:snapshot', state: { pf: { krw: 1e12 } } });
    await sleep(100);
    // 12·13. 준비 완료 → 다음 날 (한 번만)
    const day0 = A.state.clock.day;
    const adv = [A, ...others].map(c => c.waitNew(m => m.t === 'day:advance', 8000));
    for(const c of [A, ...others]) c.send({ t: 'player:ready', ready: true });
    A.send({ t: 'player:ready', ready: true }); A.send({ t: 'player:ready', ready: true });   // 중복 클릭
    const advs = await Promise.all(adv); await sleep(300);
    const advCount = A.msgs.filter(m => m.t === 'day:advance').length;
    ok('12. 준비 완료 투표가 정상 작동', advs.every(m => m.day === day0 + 1), `${day0} → ${advs[0].day}`);
    ok('13. 날짜 진행이 중복 실행되지 않음', advCount === 1 && A.state.clock.day === day0 + 1);
    ok('19·위조. 클라이언트가 보낸 돈·주가 위조는 무시됨', A.state.pf.krw < 1e6 && A.state.cos.HAMV.price > 10, `원화 ${Math.round(A.state.pf.krw)}`);
    const held = [A, ...others].map(c => (c.state.pf.hold.HAMV || {}).qty || 0);
    ok('   네 명 모두 장 시작 가격에 햄비디아 체결', held.join(',') === '3,2,2,1', held.join(','));
    const p2 = [A, ...others].map(c => c.state.cos.HAMV.price);
    ok('11. 네 명 모두 같은 경제를 경험 (다음 날도 같은 주가·뉴스 수)', new Set(p2).size === 1 && new Set([A, ...others].map(c => c.state.news.length)).size === 1);
    const rets = [A, ...others].map(c => total(c.state) / c.state.pf.base - 1);
    ok('   네 명의 수익률이 서로 다르게 계산됨', new Set(rets.map(r => r.toFixed(6))).size === 4, rets.map(r => (r * 100).toFixed(3) + '%').join(' / '));
    // 18. 비공개 정보
    const bw = A.waitNew(m => m.t === 'board'); A.send({ t: 'board:get' }); const board = await bw;
    const other = board.rows.find(r => r.pid === others[0].pid), me = board.rows.find(r => r.pid === A.pid);
    ok('18. 다른 플레이어의 비공개 보유·거래는 볼 수 없음 (본인 것은 보임)', other && !other.holdings && !other.trades && !other.weights && me.holdings && me.trades);
    others[0].send({ t: 'player:privacy', privacy: { holdings: true } }); await sleep(100);
    const bw2 = A.waitNew(m => m.t === 'board'); A.send({ t: 'board:get' }); const board2 = await bw2;
    ok('   본인이 동의하면 보유 종목이 공개됨', !!board2.rows.find(r => r.pid === others[0].pid).holdings);
    // 금리 예측·토론·조사판
    // 10. 금리 발표가 모두에게 동시에: 금리 결정일까지 진행
    let cbSeen = null;
    for(let i = 0; i < 25 && !cbSeen; i++){
      const ws = [A, ...others].map(c => c.waitNew(m => m.t === 'day:advance', 8000));
      await sleep(250);
      for(const c of [A, ...others]){ const pr = c.msgs.filter(m => m.t === 'shared:state').pop(); if(pr && pr.pred && !pr.pred.resolved && pr.pred.mine == null) c.send({ t: 'rate:predict', guess: 0 }); }
      await sleep(60);
      for(const c of [A, ...others]) c.send({ t: 'player:ready', ready: true });
      const r = await Promise.all(ws);
      if(r.every(m => m.events.some(e => e.kind === 'cb'))) cbSeen = r;
    }
    await sleep(200);
    const shared = A.msgs.filter(m => m.t === 'shared:state').pop();
    if(process.env.VERBOSE) console.log('PRED', JSON.stringify(shared.pred));
    ok('10. 금리 발표가 네 명에게 같은 날 함께 전달됨 (+예측 결과 공개)', !!cbSeen && shared.pred && shared.pred.resolved && shared.pred.by.length === 4, cbSeen ? cbSeen[0].events.find(e => e.kind === 'cb').title : '');
    // 14·15. 연결 종료 후 복귀 — 자산 유지
    const B = others[0], tokB = B.token, usdB = B.state.pf.usd, holdB = JSON.stringify(B.state.pf.hold); B.close(); await sleep(200);
    ok('   연결이 끊긴 사람은 접속 끊김으로 표시', A.room.players.find(p => p.pid === B.pid).online === false);
    const dayBefore = A.state.clock.day;
    const wsA = [A, ...others.slice(1)].map(c => c.waitNew(m => m.t === 'day:advance'));
    for(const c of [A, ...others.slice(1)]) c.send({ t: 'player:ready', ready: true });
    await Promise.all(wsA); await sleep(200);
    ok('   남은 세 명만 준비해도 다음 날로 진행', A.state.clock.day === dayBefore + 1);
    const B2 = new Client('냥이2'); await B2.open(); const wb = B2.waitNew(m => m.t === 'market:snapshot'); B2.send({ t: 'player:reconnect', code, token: tokB }); await wb;
    ok('14·15. 끊긴 플레이어가 복귀하고 주식·예수금이 유지됨 (그동안의 시장 변화도 반영)', B2.pid === B.pid && Math.abs(B2.state.pf.usd - usdB) < 1e-6 && JSON.stringify(B2.state.pf.hold) === holdB && B2.state.clock.day === A.state.clock.day);
    const Bad = new Client('사칭'); await Bad.open(); const wbad = Bad.waitNew(m => m.t === 'error'); Bad.send({ t: 'player:reconnect', code, token: 'not-a-real-token-1234567890' }); const eb = await wbad;
    ok('   닉네임·초대 코드만으로는 남의 계좌에 들어갈 수 없음', eb.code === 'bad_token'); Bad.close();
    // 17. 방마다 경제 독립
    const X = new Client('다른방'); await X.open(); const jx = X.waitNew(m => m.t === 'room:joined'); X.send({ t: 'room:create', nick: '다른방', settings: { name: '옆 마을' } }); await jx;
    const sx2 = X.waitNew(m => m.t === 'market:snapshot'); X.send({ t: 'host:start' }); await sx2.catch(e => { console.log('X msgs', JSON.stringify(X.msgs.slice(-4)).slice(0, 600)); throw e; });
    const xDay = X.state.clock.day, xPrice = X.state.cos.HAMV.price;
    ok('17. 방마다 경제 상태가 독립적 (다른 날짜·다른 시장)', xDay === 1 && A.state.clock.day > 1 && (X.code !== code), `옆 마을 ${xDay}일째 HAMV ${xPrice} / 우리 마을 ${A.state.clock.day}일째 ${A.state.cos.HAMV.price}`);
    // 16. 서버 재시작 후 복원
    const before = { day: A.state.clock.day, price: A.state.cos.HAMV.price, usd: A.state.pf.usd, hold: JSON.stringify(A.state.pf.hold) };
    const sv = A.waitNew(m => m.t === 'game:saved'); A.send({ t: 'game:save' }); await sv;
    for(const c of [A, B2, ...others.slice(1), X]) c.close();
    await stopServer(); await startServer();
    const A2 = new Client('햄찌-복귀'); await A2.open(); const wa = A2.waitNew(m => m.t === 'market:snapshot'); A2.send({ t: 'player:reconnect', code, token: A.token }); await wa;
    ok('16. 서버를 껐다 켜도 공유 시장과 계좌가 복원됨', A2.state.clock.day === before.day && A2.state.cos.HAMV.price === before.price && A2.state.pf.usd === before.usd && JSON.stringify(A2.state.pf.hold) === before.hold, `${before.day}일째 · HAMV ${before.price}`);
    // 재시작 뒤에도 계속 진행 (시장 일치 유지)
    const C2 = new Client('토끼-복귀'); await C2.open(); const wc = C2.waitNew(m => m.t === 'market:snapshot'); C2.send({ t: 'player:reconnect', code, token: others[1].token }); await wc;
    const wad = [A2, C2].map(c => c.waitNew(m => m.t === 'day:advance'));
    A2.send({ t: 'host:pause', paused: false }); await sleep(50);
    A2.send({ t: 'player:ready', ready: true }); C2.send({ t: 'player:ready', ready: true }); await Promise.all(wad); await sleep(100);
    ok('   복원 뒤에도 같은 시장으로 계속 진행', A2.state.cos.HAMV.price === C2.state.cos.HAMV.price && A2.state.clock.day === before.day + 1);
    // 요청 남용 제한
    const R = new Client('남용'); await R.open(); let rateHit = false; R.ws.on('message', d => { const m = JSON.parse(d); if(m.t === 'error' && m.code === 'rate') rateHit = true; });
    for(let i = 0; i < 30; i++) R.send({ t: 'room:join', code: 'HAM-' + 'ABCD', nick: 'x' }); await sleep(300);
    ok('   초대 코드 추측·요청 남용은 횟수 제한', rateHit); R.close();
    A2.close(); C2.close();
  }catch(e){ console.error(e); ok('테스트 실행 중 오류 없음', false, e.message); }
  await stopServer();
  const fail = results.filter(r => !r.ok);
  console.log(`\n${results.length - fail.length}/${results.length} 통과`);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
})();
