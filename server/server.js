'use strict';
/* =====================================================================
   🐹 주식마을 — 4인 멀티플레이어 서버
   ---------------------------------------------------------------------
   · 실행:  cd server && npm install && npm start   →  http://localhost:3000
   · 같은 서버가 게임 화면(index.html)도 보내 줘요. 친구들은 이 주소로 접속하면 돼요.
   · 서버가 모든 것을 결정해요: 방·초대 코드·날짜 진행·주가·경제 이벤트·주문 체결·계좌·저장·순위.
     브라우저는 서버가 보낸 내용을 보여 주기만 해요.
   · 한 방 = 한 경제. 방마다 엔진과 난수 씨앗이 따로 있어서 서로 영향을 주지 않아요.
   ✏️ 자주 고칠 만한 값: PORT, MAX_PLAYERS, AUTO_STEP_MS, ROOM_IDLE_UNLOAD_MS
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createEngine, splitState, joinState, clone, marketFingerprint } = require('./engine');
const { createStore } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const GAME_HTML = process.env.GAME_HTML || path.join(ROOT, 'index.html');
const MAX_PLAYERS = 4;
const AUTO_STEP_MS = { 1: 1600, 2: 900, 3: 450 };          // 자동 진행: 한 걸음(장중 10분)마다 걸리는 실제 시간
const ROOM_IDLE_UNLOAD_MS = 10 * 60 * 1000;                // 아무도 없는 방은 10분 뒤 저장하고 메모리에서 내려요
const FORCE_ADVANCE_SEC = 20;                              // 방장 「다음 날 진행 요청」 대기 시간
const SERVER_VERSION = '4.0.0';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- 방 설정에서 고를 수 있는 값 ---------- */
const OPT = {
  volatility: { calm: 0.85, normal: 1, wild: 1.2 },          // 게임 난이도 (시장 흔들림)
  crisis:     { low: 0.5, normal: 1, high: 1.7 },            // 경제위기 빈도
  startCash:  [500000, 1000000, 3000000, 10000000],          // 시작 투자금 (원)
  timeMode:   ['turn', 'auto'],                              // 시장 진행 방식
  autoSpeed:  [1, 2, 3],
  competition:['free', 'league'],                            // 경쟁 모드
  presLevel:  ['quiet', 'normal', 'busy'],
  startScen:  ['none', 'gfc', 'rate', 'war', 'bubble'],
};
const DEFAULT_SETTINGS = { name: '도토리 마을', volatility: 'normal', crisis: 'normal', startCash: 1000000, timeMode: 'turn', autoSpeed: 1, competition: 'free', showReturns: true, presLevel: 'normal', startScen: 'none' };
const EMOTES = ['joy', 'cry', 'angry', 'surprise', 'worry', 'clap', 'wave', 'sigh', 'laugh'];
const STATUSES = ['idle', 'trading', 'news', 'school', 'home', 'palace', 'company', 'board', 'map', 'away', 'lesson', 'broadcast'];
const DEBATE_CHOICES = ['매수', '매도', '보유', '분산투자', '현금 비중 확대'];
const RESEARCH_TOPICS = ['semi', 'bank', 'rate', 'value'];
const CB_GUESSES = [-0.5, -0.25, 0, 0.25, 0.5];

/* ---------- 작은 도구 ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';               // 헷갈리는 0·O·1·I 는 빼요
const CODE_PREFIX = ['HAM', 'CAT', 'RAB', 'OTT', 'FOX', 'OWL', 'BEE', 'PAN', 'SQR', 'DUK'];
function cleanText(v, max){
  if(typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if(!s) return null;
  return s.slice(0, max);
}
const isColor = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const intIn = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
const numIn = (v, a, b) => typeof v === 'number' && isFinite(v) && v >= a && v <= b;
function bucket(rate, burst){ return { t: burst, last: now(), rate, burst }; }
function take(b, n = 1){ const t = now(); b.t = Math.min(b.burst, b.t + (t - b.last) / 1000 * b.rate); b.last = t; if(b.t >= n){ b.t -= n; return true; } return false; }

const store = createStore();
const rooms = new Map();                 // code -> room (메모리에 올라온 방)
const ipBuckets = new Map();             // ip -> 방 만들기·입장 시도 제한

/* =====================================================================
   방 만들기 · 불러오기 · 저장
   ===================================================================== */
async function newCode(){
  for(let i = 0; i < 50; i++){
    let c = CODE_PREFIX[crypto.randomInt(CODE_PREFIX.length)] + '-';
    for(let k = 0; k < 4; k++) c += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
    if(!rooms.has(c) && !(await store.exists(c))) return c;                  // 겹치면 다시 뽑아요
  }
  throw new Error('초대 코드를 만들지 못했어요');
}
function makeRoom(code, settings){
  return {
    code, id: crypto.randomUUID(), createdAt: now(), settings, hostPid: null, phase: 'lobby', paused: false,
    seed: crypto.randomInt(1, 2 ** 31 - 1), pubSeed: crypto.randomInt(1, 2 ** 31 - 1),
    engine: null, players: new Map(),
    shared: { chat: [], pred: null, debates: [], research: [], league: null, events: [], scenUsedDay: -999, dayResults: [] },
    advancing: false, dirty: false, saving: false, forceAt: 0, nextStepAt: 0, emptySince: now(), lastPosSent: 0, posDirty: false,
  };
}
function newPlayer(nick, avatar){
  const token = crypto.randomBytes(24).toString('base64url');
  return { player: {
    pid: crypto.randomUUID(), nick, avatar, tokenHash: sha(token), joinedAt: now(), ready: false, status: 'idle',
    online: false, conns: new Set(), state: null, pos: null, lastMove: 0, moveSeq: -1,
    privacy: { holdings: false, trades: false, weights: false, judgment: false, home: true },
    reqCache: new Map(), statusAt: now(),
  }, token };
}
function uniqueNick(room, nick){
  const names = new Set([...room.players.values()].map(p => p.nick));
  if(!names.has(nick)) return nick;
  for(let i = 2; i < 10; i++){ const n = (nick.slice(0, 8) + i); if(!names.has(n)) return n; }
  return nick.slice(0, 6) + crypto.randomInt(100, 999);
}
function roomForStorage(room){
  const ref = refPlayer(room);
  const market = ref && ref.state ? splitState(ref.state).market : null;
  const r = { code: room.code, id: room.id, createdAt: room.createdAt, settings: room.settings, hostPid: room.hostPid, phase: room.phase,
    paused: room.paused, seed: room.seed, pubSeed: room.pubSeed, shared: room.shared, market, savedAt: now(), serverVersion: SERVER_VERSION };
  const players = [...room.players.values()].map(p => ({
    pid: p.pid, tokenHash: p.tokenHash, nick: p.nick, avatar: p.avatar, joinedAt: p.joinedAt, privacy: p.privacy,
    reqIds: [...p.reqCache.keys()].slice(-60), personal: p.state ? splitState(p.state).personal : null,
  }));
  return { r, players };
}
async function saveRoom(room){
  if(room.saving){ room.dirty = true; return; }
  room.saving = true; room.dirty = false;
  try{ const { r, players } = roomForStorage(room); await store.save(room.code, r, players); room.lastSaved = now(); }
  catch(e){ log('저장 실패', room.code, e.message); room.dirty = true; }
  finally{ room.saving = false; }
}
async function loadRoom(code){
  if(rooms.has(code)) return rooms.get(code);
  const data = await store.load(code); if(!data) return null;
  if(rooms.has(code)) return rooms.get(code);          // 기다리는 사이 다른 요청이 먼저 불러왔을 수 있어요
  const r = data.room, room = makeRoom(code, Object.assign({}, DEFAULT_SETTINGS, r.settings));
  Object.assign(room, { id: r.id, createdAt: r.createdAt, hostPid: r.hostPid, phase: r.phase, paused: !!r.paused, seed: r.seed, pubSeed: r.pubSeed,
    shared: Object.assign(room.shared, r.shared || {}) });
  if(room.phase === 'play') room.engine = createEngine({ startCash: room.settings.startCash });
  for(const d of data.players){
    const p = { pid: d.pid, nick: d.nick, avatar: d.avatar, tokenHash: d.tokenHash, joinedAt: d.joinedAt, ready: false, status: 'idle', online: false,
      conns: new Set(), state: null, pos: null, lastMove: 0, moveSeq: -1, privacy: Object.assign({ holdings: false, trades: false, weights: false, judgment: false, home: true }, d.privacy || {}),
      reqCache: new Map((d.reqIds || []).map(k => [k, { ok: true, msg: '이미 처리된 주문이에요.' }])), statusAt: now() };
    if(room.phase === 'play' && r.market && d.personal) p.state = joinState(r.market, d.personal);
    room.players.set(p.pid, p);
  }
  if(room.phase === 'play') verifyMarkets(room, '불러오기');
  rooms.set(code, room); log('방 불러옴', code, room.players.size + '명');
  return room;
}
const refPlayer = room => room.players.get(room.hostPid) || [...room.players.values()].find(p => p.state) || null;

/* =====================================================================
   엔진 다루기 — 한 방의 엔진 하나로, 플레이어마다 자기 상태를 번갈아 끼워 넣어요.
   · 시장 난수(RNG)는 시장만 쓰도록 지켜요: 개인 행동 뒤에는 난수 상태를 되돌려 놓아요.
   ===================================================================== */
function enforceRoom(room, s){
  const st = room.settings;
  s.level = 'real';
  s.lvOverride = { volK: OPT.volatility[st.volatility] || 1, crisisK: OPT.crisis[st.crisis] || 1 };
  s.settings.presLevel = st.presLevel;
  delete s.psyOff;
}
function withState(room, p, fn){           // 개인 행동: 끝나면 시장 난수 상태를 그대로 되돌려요
  const api = room.engine; api.setS(p.state); const r0 = api.rngNow();
  try{ return fn(api); } finally{ api.setRng(r0); api.syncRng(); }
}
function freshPersonal(room, p){
  const api = room.engine;
  api.newState(p.nick, p.avatar.color, p.avatar.scarf, room.seed, {});
  return splitState(api.getS()).personal;
}
function startGame(room){
  room.engine = createEngine({ startCash: room.settings.startCash });
  const api = room.engine;
  const scen = room.settings.startScen !== 'none' ? room.settings.startScen : null;
  for(const p of room.players.values()){
    api.newState(p.nick, p.avatar.color, p.avatar.scarf, room.seed, { scen });   // 같은 씨앗 → 모두 같은 시장에서 출발
    const s = api.getS(); api.syncRng(); enforceRoom(room, s); s.player.x += (Math.random() - 0.5) * 60; s.player.species = p.avatar.species; p.state = s;
  }
  room.phase = 'play'; room.paused = false;
  verifyMarkets(room, '시작');
  log('게임 시작', room.code, room.players.size + '명');
}
function lateJoinState(room, p){            // 게임 도중 들어온 사람: 지금 시장 + 새 계좌
  const ref = refPlayer(room);
  const personal = freshPersonal(room, p);
  const s = joinState(splitState(ref.state).market, personal);
  const api = room.engine; api.setS(s);
  s.pf.valHist = [{ d: s.clock.day, v: s.pf.krw, idx: api.lastIdx(), fx: s.fx }];
  s.journal = []; s.psy = null; s.pfHist = []; s.player.species = p.avatar.species;
  enforceRoom(room, s);
  return s;
}
function verifyMarkets(room, why){
  const ps = [...room.players.values()].filter(p => p.state); if(ps.length < 2) return true;
  const ref = refPlayer(room), f0 = marketFingerprint(ref.state);
  let ok = true;
  for(const p of ps){ if(p === ref) continue;
    if(marketFingerprint(p.state) !== f0){ ok = false;
      log('⚠️ 시장 상태가 어긋나서 방장 기준으로 다시 맞춰요', room.code, why, p.nick);
      p.state = joinState(splitState(ref.state).market, splitState(p.state).personal); } }
  return ok;
}

/* =====================================================================
   화면으로 보낼 상태 만들기 — 미래를 알 수 있는 정보는 지워요
   (시장 난수 상태·씨앗·오늘의 남은 가격 경로·숨은 시장 국면·예정된 후속 사건)
   ===================================================================== */
function sanitize(room, s){
  const o = clone(s);
  delete o.rng; o.seed = room.pubSeed; delete o.lvOverride;
  if(o.dayData){ const dd = o.dayData, k = dd.k;
    const cut = a => Array.isArray(a) ? a.slice(0, Math.max(0, k + 1)) : a;
    const paths = {}, vols = {};
    for(const id of Object.keys(dd.paths || {})) paths[id] = cut(dd.paths[id]);
    for(const id of Object.keys(dd.vols || {})) vols[id] = cut(dd.vols[id]);
    o.dayData = { k, paths, vols, fxPath: cut(dd.fxPath) };
  }
  if(o.mkt){ const m = o.mkt, sc = m.scen, b = m.bub || {};
    o.mkt = { reg: 'hidden', days: 0, dur: 0, anchor: 0, regLog: [], declCount: m.declCount, bkCount: m.bkCount,
      scen: sc ? { id: sc.id, done: sc.done, at: sc.at, rand: !!sc.rand, trig: (sc.trig != null && !sc.rand) ? 1 : null } : null,
      bub: { ph: b.n40 ? b.ph : 'none', lvl: 0, g: b.n40 ? b.g : [], d: 0, dur: 0, L0: 0, n40: !!b.n40, n75: !!b.n75 } };
  }
  if(o.pres) delete o.pres.follow;
  if(o.mkt && o.mkt.scandal) delete o.mkt.scandal;
  return o;
}
function personalDelta(p){
  const s = p.state;
  return { pf: s.pf, orders: s.orders.slice(-80), trades: s.trades.slice(-150), tradeCount: s.trades.length, quests: s.quests, badges: s.badges,
    life: { coins: s.life.coins }, ids: s.ids };
}

/* =====================================================================
   보내기
   ===================================================================== */
function send(ws, msg){ if(ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendTo(p, msg){ const j = JSON.stringify(msg); for(const ws of p.conns) if(ws.readyState === 1) ws.send(j); }
function broadcast(room, msg, except){ const j = JSON.stringify(msg); for(const p of room.players.values()) if(p !== except) for(const ws of p.conns) if(ws.readyState === 1) ws.send(j); }
function publicPlayers(room){
  return [...room.players.values()].map(p => ({ pid: p.pid, nick: p.nick, avatar: p.avatar, ready: p.ready, online: p.online, host: p.pid === room.hostPid,
    status: p.status, pos: p.pos, privacy: { holdings: p.privacy.holdings, trades: p.privacy.trades, weights: p.privacy.weights, judgment: p.privacy.judgment, home: p.privacy.home } }));
}
function roomState(room){
  const ref = refPlayer(room);
  const online = [...room.players.values()].filter(p => p.online);
  return { t: 'room:state', code: room.code, settings: room.settings, phase: room.phase, hostPid: room.hostPid, paused: room.paused,
    day: ref && ref.state ? ref.state.clock.day : 0, min: ref && ref.state ? ref.state.clock.min : 0, players: publicPlayers(room),
    ready: { need: online.length, done: online.filter(p => p.ready).length }, forceAt: room.forceAt || 0, maxPlayers: MAX_PLAYERS, serverVersion: SERVER_VERSION };
}
function pushRoomState(room){ broadcast(room, roomState(room)); }
function sendSnapshot(room, p, reason){ if(p.state) sendTo(p, { t: 'market:snapshot', reason, state: sanitize(room, p.state) }); }
function sharedFor(room, viewer){
  const sh = room.shared;
  const debates = sh.debates.slice(-8).map(d => { const mine = d.answers[viewer.pid]; const showAll = !!mine || d.closed;
    return { id: d.id, day: d.day, title: d.title, kind: d.kind, closed: !!d.closed, mine: mine || null, count: Object.keys(d.answers).length,
      answers: showAll ? Object.entries(d.answers).map(([pid, a]) => ({ pid, nick: (room.players.get(pid) || {}).nick || '떠난 주민', choice: a.choice, reason: a.reason })) : [] }; });
  const pred = sh.pred ? { cbDay: sh.pred.cbDay, expMove: sh.pred.expMove, prevRate: sh.pred.prevRate, mine: sh.pred.by[viewer.pid] ?? null,
    count: Object.keys(sh.pred.by).length, resolved: sh.pred.resolved || null,
    by: sh.pred.resolved ? Object.entries(sh.pred.by).map(([pid, g]) => ({ pid, nick: (room.players.get(pid) || {}).nick || '?', guess: g })) : [] } : null;
  const sharedDiary = [];
  for(const p of room.players.values()) if(p.state) for(const e of p.state.journal || []) if(e.shared) sharedDiary.push({ pid: p.pid, nick: p.nick, e: { id: e.id, day: e.day, mood: e.mood, act: e.act, cid: e.cid, why: e.why, exp: e.exp, expT: e.expT, note: e.note, rev: e.rev ? { day: e.rev.day } : null } });
  return { t: 'shared:state', chat: sh.chat.slice(-40), debates, pred, research: sh.research.slice(-60), league: sh.league, events: sh.events.slice(-30),
    sharedDiary: sharedDiary.sort((a, b) => b.e.day - a.e.day).slice(0, 40), dayResults: sh.dayResults.slice(-10).map(r => filterResults(room, r, viewer)) };
}
function pushShared(room){ for(const p of room.players.values()) if(p.conns.size) sendTo(p, sharedFor(room, p)); }

/* =====================================================================
   성적표 — 서버가 계산하고, 공개 설정에 따라 보여 줄 칸만 보내요
   ===================================================================== */
function metrics(room, p){
  if(!p.state) return null;
  return withState(room, p, api => {
    const s = p.state, tot = api.totalAssets(), vh = s.pf.valHist;
    const arr = vh.map(v => ({ d: v.d, v: v.v }));
    const mdd = api.mddArr(arr).m;
    const rs = []; for(let i = 1; i < arr.length; i++) rs.push(Math.log(arr[i].v / arr[i - 1].v));
    const mean = rs.reduce((a, b) => a + b, 0) / Math.max(1, rs.length);
    const vol = rs.length > 2 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) * Math.sqrt(250) : null;
    const w = {}; let hhi = 0, topW = 0, topId = null;
    for(const id in s.pf.hold){ const x = s.pf.hold[id].qty * api.co(id).price * s.fx / tot; w[id] = Math.round(x * 1000) / 1000; hhi += x * x; if(x > topW){ topW = x; topId = id; } }
    const v0 = vh[0] || { idx: api.lastIdx(), fx: s.fx };
    const idxRet = (api.lastIdx() * s.fx) / (v0.idx * (v0.fx || s.fx)) - 1, ret = tot / s.pf.base - 1;
    const tags = {}; for(const t of s.trades) if(t.why && t.why.tag) tags[t.why.tag] = (tags[t.why.tag] || 0) + 1;
    const style = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
    const evDays = room.shared.events.filter(e => e.major).slice(-6);
    const responses = evDays.map(e => { const ts = s.trades.filter(t => t.day === e.day && (t.side === 'buy' || t.side === 'sell'));
      return { day: e.day, title: e.title, buys: ts.filter(t => t.side === 'buy').length, sells: ts.filter(t => t.side === 'sell').length }; });
    return { pid: p.pid, nick: p.nick, avatar: p.avatar, online: p.online, total: tot, ret, realized: s.pf.realizedKrw || 0, div: s.pf.divKrw || 0,
      mdd, vol, topW, topId, hhi, excess: ret - idxRet, weights: w, style, responses,
      trades: s.trades.filter(t => t.side === 'buy' || t.side === 'sell').slice(-20).map(t => ({ day: t.day, cid: t.cid, side: t.side, qty: t.qty, price: t.price, why: t.why })),
      holdings: Object.keys(s.pf.hold).map(id => ({ id, qty: s.pf.hold[id].qty })) };
  });
}
function filterMetrics(room, m, viewer){
  if(!m) return null;
  const owner = room.players.get(m.pid), self = viewer.pid === m.pid, pv = owner ? owner.privacy : {};
  const showRet = self || room.settings.showReturns;
  const o = { pid: m.pid, nick: m.nick, avatar: m.avatar, online: m.online, self };
  if(showRet) Object.assign(o, { total: m.total, ret: m.ret, realized: m.realized, div: m.div, mdd: m.mdd, vol: m.vol, excess: m.excess, topW: m.topW, hhi: m.hhi });
  else Object.assign(o, { hidden: true, mdd: null });
  if(self || pv.weights) o.weights = m.weights;
  if(self || pv.holdings) o.holdings = m.holdings;
  if(self || pv.trades) { o.trades = m.trades; o.responses = m.responses; }
  if(self || pv.judgment) o.style = m.style;
  return o;
}
function boardFor(room, viewer){
  const rows = [...room.players.values()].map(p => filterMetrics(room, metrics(room, p), viewer)).filter(Boolean);
  const lg = room.shared.league;
  let league = null;
  if(lg){ league = { ...lg, standings: lg.startVals ? Object.entries(lg.startVals).map(([pid, v0]) => { const p = room.players.get(pid); if(!p || !p.state) return null;
    const show = room.settings.showReturns || pid === viewer.pid;
    const tot = withState(room, p, api => api.totalAssets());
    return { pid, nick: p.nick, ret: show ? tot / v0 - 1 : null }; }).filter(Boolean).sort((a, b) => (b.ret ?? -9) - (a.ret ?? -9)) : [] }; }
  return { t: 'board', rows, league, showReturns: room.settings.showReturns };
}
function filterResults(room, r, viewer){
  return { ...r, rows: r.rows.map(x => (room.settings.showReturns || x.pid === viewer.pid) ? x : { pid: x.pid, nick: x.nick, hidden: true }) };
}

/* =====================================================================
   하루 진행 — 서버만 시간을 움직여요
   ===================================================================== */
function totalsOf(room){ const m = {}; for(const p of room.players.values()) if(p.state) m[p.pid] = withState(room, p, api => api.totalAssets()); return m; }
function advanceDay(room, why){
  if(room.advancing || room.phase !== 'play') return false;
  room.advancing = true;
  try{
    const api = room.engine, before = totalsOf(room), ref = refPlayer(room), fromDay = ref.state.clock.day;
    for(const p of room.players.values()){ if(!p.state) continue;
      enforceRoom(room, p.state); api.setS(p.state); api.sleepToMorning(); api.syncRng(); }        // 접속하지 않은 사람의 계좌도 같은 시장으로 함께 진행돼요
    verifyMarkets(room, '하루 진행');
    afterDayChange(room, fromDay, before, why);
    return true;
  } finally { room.advancing = false; }
}
function afterDayChange(room, fromDay, before, why){
  const after = totalsOf(room), ref = refPlayer(room), s = ref.state, day = s.clock.day;
  for(const p of room.players.values()) p.ready = false;
  room.forceAt = 0;
  // 하루 결과(각자 수익률)
  const cbPrev = room.shared.pred && room.shared.pred.cbDay === fromDay;
  const rows = [...room.players.values()].filter(p => p.state).map(p => ({ pid: p.pid, nick: p.nick, dayRet: before[p.pid] ? after[p.pid] / before[p.pid] - 1 : 0, total: after[p.pid], ret: after[p.pid] / p.state.pf.base - 1 }));
  const hD = s.ix.D500.hist, idxRet = hD.length > 1 ? hD[hD.length - 1].v / hD[hD.length - 2].v - 1 : 0;
  const result = { day: fromDay, idxRet, rows, cbDay: cbPrev, title: cbPrev ? '🏦 금리 발표 날, 우리 넷의 결과' : `📅 ${fromDay}일째 장 마감 결과` };
  room.shared.dayResults.push(result); if(room.shared.dayResults.length > 30) room.shared.dayResults.shift();
  const events = detectEvents(room, s, fromDay, idxRet);
  room.shared.events.push(...events); if(room.shared.events.length > 80) room.shared.events.splice(0, room.shared.events.length - 80);
  // 금리 예측: 발표 결과 확인
  const pr = room.shared.pred;
  if(pr && !pr.resolved && pr.cbDay === day){
    const act = Math.round((s.eco.rate - pr.prevRate) / 0.25) * 0.25;
    pr.resolved = { act, rate: s.eco.rate, exp: pr.expMove };
  }
  if(pr && pr.resolved && day > pr.cbDay + 1) room.shared.pred = null;
  // 금리 발표 일정 공지 (곰곰 기자) — 발표 전날 아침
  if(s.eco.nextCB === day + 1 && (!room.shared.pred || room.shared.pred.cbDay !== day + 1)){
    const expMove = Math.max(-0.5, Math.min(0.5, Math.round((s.eco.rateExp - s.eco.rate) / 0.25) * 0.25));
    room.shared.pred = { cbDay: day + 1, prevRate: s.eco.rate, expMove, by: {}, resolved: null };
    events.push({ day, kind: 'cbNotice', title: `📣 곰곰 기자: 내일 아침 숲속 중앙은행 금리 발표! (시장 예상: ${moveTxt(expMove)})`, major: false });
  }
  // 토론: 큰 사건이 있으면 질문을 열어요 (하루에 하나)
  const big = events.filter(e => e.major).sort((a, b) => b.pri - a.pri)[0];
  for(const d of room.shared.debates) if(!d.closed && d.day < day) d.closed = true;
  if(big){ room.shared.debates.push({ id: crypto.randomUUID().slice(0, 8), day, title: big.title, kind: big.kind, answers: {}, closed: false }); if(room.shared.debates.length > 30) room.shared.debates.shift(); }
  // 투자왕 리그 끝났는지
  const lg = room.shared.league;
  if(lg && lg.status === 'running' && day >= lg.endDay){
    const res = Object.entries(lg.startVals).map(([pid, v0]) => { const p = room.players.get(pid); return p && p.state ? { pid, nick: p.nick, ret: after[pid] / v0 - 1, mdd: leagueMdd(p, lg.startDay) } : null; }).filter(Boolean).sort((a, b) => b.ret - a.ret);
    lg.status = 'done'; lg.result = res; lg.doneDay = day;
    events.push({ day, kind: 'league', title: `🏆 투자왕 리그 종료! 1위 ${res[0] ? res[0].nick : '-'}`, major: false });
  }
  room.dirty = true;
  for(const p of room.players.values()) if(p.conns.size){
    sendTo(p, { t: 'day:advance', fromDay, day, why, events, result: filterResults(room, result, p) });
    sendSnapshot(room, p, 'day');
    sendTo(p, sharedFor(room, p));
  }
  pushRoomState(room);
  for(const e of events) if(e.npc) broadcast(room, { t: 'npc:event', npc: e.npc, line: e.npcLine, day });
  saveRoom(room);
}
function leagueMdd(p, startDay){ const vh = p.state.pf.valHist.filter(v => v.d >= startDay - 1); let pk = -Infinity, m = 0; for(const v of vh){ pk = Math.max(pk, v.v); m = Math.min(m, v.v / pk - 1); } return m; }
const moveTxt = x => x > 0 ? `${x.toFixed(2)}%p 인상` : x < 0 ? `${(-x).toFixed(2)}%p 인하` : '동결';
/* 모두가 함께 겪는 경제 사건 찾기 (시장 상태를 읽기만 해요) */
function detectEvents(room, s, fromDay, idxRet){
  const day = s.clock.day, ev = [];
  const add = (kind, title, pri, extra = {}) => ev.push(Object.assign({ day, kind, title, pri, major: pri >= 5 }, extra));
  for(const n of s.news){ if(n.day !== day && !(n.day === fromDay && n.min > 9 * 60 && n.min < 15.5 * 60 && n.type === '대통령')) continue;
    if(n.type === '금리') add('cb', '🏦 ' + n.title, 9, { newsId: n.id });
    else if(n.type === '대통령') add('pres', '🐿️ ' + n.title, n.tier === 'crisis' ? 9 : n.tier === 'strong' ? 7 : n.tier === 'mid' ? 5 : 3, { newsId: n.id, npc: 'rooster', npcLine: '🐓 크레이머닭 긴급 방송! 「대통령 발표 나왔다! 무조건 대박 아니면 쪽박이야!!」' });
    else if(n.type === '실적' && (n.cids || []).includes('HAMV')) add('earn', '📊 ' + n.title, 6, { newsId: n.id });
    else if((n.cids || []).includes('RKCT') && /발사/.test(n.title)) add('launch', '🚀 ' + n.title, 5, { newsId: n.id });
    else if(n.sev >= 3 && (n.type === '금융')) add('fin', '🏦 ' + n.title, 8, { newsId: n.id });
    else if(n.sev >= 3 && n.type === '국제정세') add('geo', '⚔️ ' + n.title, 8, { newsId: n.id });
    else if(n.sev >= 3 && n.type === '거시경제') add('macro', '📈 ' + n.title, 7, { newsId: n.id });
    else if(n.sev >= 3 && n.type === '기업') add('corp', '🏢 ' + n.title, 6, { newsId: n.id });
    else if(n.sev >= 2 && n.type === '산업') add('sector', '🏭 ' + n.title, 5, { newsId: n.id });
  }
  if(idxRet <= -0.03) add('crash', `📉 증시 대폭락 — 도토리 500 ${(idxRet * 100).toFixed(1)}%`, 8);
  const nq = s.ix.NQ100 && s.ix.NQ100.hist, nqRet = nq && nq.length > 1 ? nq[nq.length - 1].v / nq[nq.length - 2].v - 1 : 0;
  if(nqRet >= 0.03) add('rally', `🚀 성장주 급등 — 너스닥 100 +${(nqRet * 100).toFixed(1)}%`, 5);
  if(s.eco.growth < 0.5 && !room.shared.recessionNoted){ room.shared.recessionNoted = true; add('recession', '🌧️ 경기침체 우려 — 성장률 전망이 크게 낮아졌어요', 6); }
  if(s.eco.growth > 1.2) room.shared.recessionNoted = false;
  const bu = s.rivals && s.rivals.list.burry.st, w = bu && bu.warns && bu.warns[bu.warns.length - 1];
  if(w && w.d === fromDay) add('burry', `🦝 버리굴의 고독한 경고 — 「시장이 기초가치보다 ${Math.round((w.vr - 1) * 100)}% 비싸요」`, 6, { npc: 'burry', npcLine: '🦝 버리굴: 「지금은 과열이에요. …언제 꺼질지는 저도 몰라요. 각자 판단하세요.」' });
  return ev;
}

/* =====================================================================
   자동 시간 진행 모드 (서버 시계로 계속 흘러가요)
   ===================================================================== */
function stepAuto(room){
  if(room.advancing || room.phase !== 'play') return;
  room.advancing = true;
  try{
    const api = room.engine, ref = refPlayer(room), fromDay = ref.state.clock.day;
    const inMarket = ref.state.clock.min >= api.C.OPEN_MIN && ref.state.clock.min < api.C.CLOSE_MIN;
    const mins = inMarket ? api.C.TICK_MIN : 30;
    const before = totalsOf(room);
    const sig = p => p.state.trades.length + ':' + p.state.orders.filter(o => o.status === 'open').length;
    const sigs = new Map([...room.players.values()].filter(p => p.state).map(p => [p.pid, sig(p)]));
    const newsLen = ref.state.news.length;
    for(const p of room.players.values()){ if(!p.state) continue; enforceRoom(room, p.state); api.setS(p.state); api.advanceClock(mins); api.syncRng(); }
    if(ref.state.clock.day !== fromDay){ verifyMarkets(room, '자동 진행'); room.advancing = false; afterDayChange(room, fromDay, before, 'auto'); return; }
    const s = ref.state, dd = s.dayData, px = {};
    for(const id of api.C.TRADE_IDS){ const c = s.cos[id]; px[id] = [c.price, c.open, c.high, c.low, c.vol]; }
    const upd = { t: 'market:update', clock: s.clock, k: dd.k, fx: s.fx, px, news: s.news.slice(newsLen).map(n => n) };
    for(const p of room.players.values()){ if(!p.conns.size || !p.state) continue;
      sendTo(p, upd);
      if(sigs.get(p.pid) !== sig(p)) sendTo(p, Object.assign({ t: 'me:update' }, personalDelta(p))); }
    if(upd.news.length) for(const n of upd.news) if(n.type === '대통령') broadcast(room, { t: 'economy:event', events: [{ day: s.clock.day, kind: 'pres', title: '📢 장중 긴급 발표: ' + n.title, newsId: n.id }] });
  } finally { room.advancing = false; }
}

/* =====================================================================
   메시지 처리
   ===================================================================== */
function err(ws, code, msg, reqId){ send(ws, { t: 'error', code, msg, reqId }); }
function ipOk(ip, cost = 1){ let b = ipBuckets.get(ip); if(!b){ b = bucket(0.5, 25); ipBuckets.set(ip, b); } return take(b, cost); }
function attach(conn, room, p){
  if(conn.player && conn.player !== p) detach(conn);
  conn.room = room; conn.player = p; p.conns.add(conn.ws);
  const wasOnline = p.online; p.online = true; room.emptySince = 0;
  if(!wasOnline && room.phase === 'play') broadcast(room, { t: 'player:chat', sys: true, text: `🔌 ${p.nick} 님이 마을에 들어왔어요.`, t2: now() }, p);
}
function detach(conn){
  const room = conn.room, p = conn.player; if(!room || !p) return;
  p.conns.delete(conn.ws); conn.room = null; conn.player = null;
  if(p.conns.size === 0){ p.online = false; p.ready = false;
    if(room.phase === 'lobby'){ /* 대기실에서는 자리를 비워 두고 다시 들어올 수 있게 해요 */ }
    else broadcast(room, { t: 'player:chat', sys: true, text: `📴 ${p.nick} 님의 연결이 끊겼어요. 계좌는 서버에 그대로 남아 있어요. 남은 사람끼리 계속할 수 있어요${p.pid === room.hostPid ? ' (방장이 돌아올 때까지 방장 기능은 잠시 쉬어요)' : ''}.`, t2: now() });
    if([...room.players.values()].every(x => !x.online)) room.emptySince = now();
    room.dirty = true; pushRoomState(room); checkReady(room); }
}
function joinedMsg(room, p, token){ return { t: 'room:joined', code: room.code, pid: p.pid, token: token || undefined, isHost: p.pid === room.hostPid, privacy: p.privacy }; }
function checkReady(room){
  if(room.phase !== 'play' || room.paused || room.settings.timeMode !== 'turn' || room.advancing) return;
  const online = [...room.players.values()].filter(p => p.online);
  if(online.length && online.every(p => p.ready)) advanceDay(room, 'ready');
}
function requireHost(conn, ws){ const ok = conn.room && conn.player && conn.player.pid === conn.room.hostPid; if(!ok) err(ws, 'not_host', '방장만 할 수 있어요.'); return ok; }
function readSettings(src, base){
  const s = Object.assign({}, base);
  if(!src || typeof src !== 'object') return s;
  const nm = cleanText(src.name, 16); if(nm) s.name = nm;
  if(src.volatility in OPT.volatility) s.volatility = src.volatility;
  if(src.crisis in OPT.crisis) s.crisis = src.crisis;
  if(OPT.startCash.includes(src.startCash)) s.startCash = src.startCash;
  if(OPT.timeMode.includes(src.timeMode)) s.timeMode = src.timeMode;
  if(OPT.autoSpeed.includes(src.autoSpeed)) s.autoSpeed = src.autoSpeed;
  if(OPT.competition.includes(src.competition)) s.competition = src.competition;
  if(typeof src.showReturns === 'boolean') s.showReturns = src.showReturns;
  if(OPT.presLevel.includes(src.presLevel)) s.presLevel = src.presLevel;
  if(OPT.startScen.includes(src.startScen)) s.startScen = src.startScen;
  return s;
}
const SPECIES = ['hamster', 'cat', 'rabbit', 'otter', 'fox', 'squirrel', 'panda', 'penguin'];
function readAvatar(a){ return { species: a && SPECIES.includes(a.species) ? a.species : 'hamster', color: a && isColor(a.color) ? a.color : '#f2b56b', scarf: a && isColor(a.scarf) ? a.scarf : '#ff8fa3' }; }

/* 개인 기록(학습·퀘스트·집·일기 등) 맞추기 — 돈과 주식은 절대 여기서 바꿀 수 없어요 */
function applyPatch(room, p, d){
  const s = p.state; if(!s || !d || typeof d !== 'object') return;
  const unionNums = (dst, src, maxKeys) => { if(!src || typeof src !== 'object') return; for(const [k, v] of Object.entries(src)){ if(Object.keys(dst).length >= maxKeys) break; if(typeof k === 'string' && k.length <= 24 && dst[k] == null && typeof v === 'number' && isFinite(v)) dst[k] = Math.round(v); } };
  unionNums(s.lessons, d.lessons, 60); unionNums(s.quests, d.quests, 80); unionNums(s.badges, d.badges, 80);
  if(d.flags && typeof d.flags === 'object') for(const [k, v] of Object.entries(d.flags)){ if(Object.keys(s.flags).length > 200) break; if(k.length <= 32 && s.flags[k] == null && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 40))) s.flags[k] = v; }
  if(typeof d.diary === 'string') s.diary = d.diary.slice(0, 4000);
  if(d.settings && typeof d.settings === 'object'){ if(typeof d.settings.sound === 'boolean') s.settings.sound = d.settings.sound; if(typeof d.settings.psyPop === 'boolean') s.settings.psyPop = d.settings.psyPop; if(numIn(d.settings.ui, 0.8, 1.4)) s.settings.ui = d.settings.ui; }
  if(d.home && typeof d.home === 'object'){ const h = d.home;
    if(Array.isArray(h.items) && h.items.length <= 120 && h.items.every(it => it && typeof it.id === 'string' && it.id.length < 30 && intIn(it.x, 0, 20) && intIn(it.y, 0, 20) && intIn(it.uid, 0, 1e6))
      && h.inv && typeof h.inv === 'object' && Object.values(h.inv).every(v => intIn(v, 0, 999)) && typeof h.wall === 'string' && typeof h.floor === 'string'
      && Array.isArray(h.walls) && Array.isArray(h.floors) && h.walls.length < 20 && h.floors.length < 20)
      s.home = { items: h.items.map(it => ({ uid: it.uid, id: it.id, x: it.x, y: it.y, rot: it.rot ? 1 : 0 })), inv: h.inv, wall: h.wall.slice(0, 20), floor: h.floor.slice(0, 20),
        walls: h.walls.map(x => String(x).slice(0, 20)), floors: h.floors.map(x => String(x).slice(0, 20)), uid: intIn(h.uid, 0, 1e6) ? h.uid : s.home.uid };
  }
  if(d.life && typeof d.life === 'object'){ const L = d.life, S0 = s.life;
    if(numIn(L.coinsDelta, -2000, 400)) S0.coins = Math.max(0, Math.round(S0.coins + L.coinsDelta));   // 도토리 코인은 꾸미기용 생활 화폐 (투자 계좌와 별개)
    for(const k of ['fr', 'talked', 'gifted', 'gifts']) if(L[k] && typeof L[k] === 'object' && Object.keys(L[k]).length < 30 && Object.values(L[k]).every(v => numIn(v, -1e6, 1e6))) S0[k] = L[k];
    if(L.fest && typeof L.fest === 'object' && JSON.stringify(L.fest).length < 600) S0.fest = L.fest;
    if(Array.isArray(L.festLog) && L.festLog.length < 100) S0.festLog = L.festLog.slice(-100);
    for(const k of ['walkDay', 'walkDist']) if(numIn(L[k], 0, 1e7)) S0[k] = L[k];
    if(typeof L.walkPaid === 'boolean') S0.walkPaid = L.walkPaid;
  }
  if(Array.isArray(d.journal) && d.journal.length <= 400){
    for(const e of d.journal){ if(!e || !intIn(e.id, 1, 1e6)) continue;
      const cur = s.journal.find(x => x.id === e.id);
      const txt = (v, m) => typeof v === 'string' ? v.slice(0, m) : '';
      if(cur){ cur.note = txt(e.note, 600); cur.shared = !!e.shared; }
      else if(s.journal.length < 400 && intIn(e.day, 0, 1e5) && intIn(e.hz, 1, 400)){
        s.journal.push({ id: e.id, day: Math.min(e.day, s.clock.day), min: intIn(e.min, 0, 1440) ? e.min : 360, mood: txt(e.mood, 12) || null, act: txt(e.act, 30), cid: (e.cid && room.engine.DEF[e.cid]) ? e.cid : null,
          why: txt(e.why, 600), exp: ['up', 'down', 'flat', 'unknown'].includes(e.exp) ? e.exp : 'unknown', expT: txt(e.expT, 200), hz: e.hz, q: Array.isArray(e.q) ? e.q.slice(0, 4).map(Boolean) : [false, false, false, false],
          evId: intIn(e.evId, 1, 1e7) ? e.evId : null, snap: e.snap && typeof e.snap === 'object' ? JSON.parse(JSON.stringify(e.snap).slice(0, 2000) || '{}') : {}, rev: null, note: txt(e.note, 600), shared: !!e.shared });
      }
    }
  }
}

function onMessage(conn, raw){
  const ws = conn.ws;
  if(!take(conn.bucket)){ if(!conn.warned){ conn.warned = true; err(ws, 'rate', '요청이 너무 많아요. 잠시 뒤 다시 해 주세요.'); } return; }
  conn.warned = false;
  let m; try{ m = JSON.parse(raw); }catch(e){ return err(ws, 'bad_json', '잘못된 메시지예요.'); }
  if(!m || typeof m.t !== 'string') return;
  const room = conn.room, p = conn.player;
  switch(m.t){
    case 'room:create': {
      if(!ipOk(conn.ip, 2)) return err(ws, 'rate', '방을 너무 자주 만들었어요. 잠시 뒤 다시 해 주세요.');
      const nick = cleanText(m.nick, 10); if(!nick) return err(ws, 'bad_nick', '닉네임을 1~10글자로 정해 주세요.');
      const settings = readSettings(m.settings, DEFAULT_SETTINGS);
      newCode().then(code => {
        const r = makeRoom(code, settings); rooms.set(code, r);
        const { player: np, token } = newPlayer(nick, readAvatar(m.avatar));
        r.players.set(np.pid, np); r.hostPid = np.pid; attach(conn, r, np);
        send(ws, joinedMsg(r, np, token)); pushRoomState(r); send(ws, sharedFor(r, np)); r.dirty = true; saveRoom(r);
        log('방 생성', code, nick);
      }).catch(e => err(ws, 'server', e.message));
      return;
    }
    case 'room:join': {
      if(!ipOk(conn.ip)) return err(ws, 'rate', '입장 시도가 너무 많아요. 1분쯤 뒤 다시 해 주세요.');
      const code = cleanText(m.code, 12), nick = cleanText(m.nick, 10);
      if(!code || !/^[A-Z]{3}-[A-Z0-9]{4}$/.test(code.toUpperCase())){ ipOk(conn.ip, 2); return err(ws, 'bad_code', '초대 코드 형식이 달라요. (예: HAM-7K2P)'); }
      if(!nick) return err(ws, 'bad_nick', '닉네임을 1~10글자로 정해 주세요.');
      loadRoom(code.toUpperCase()).then(r => {
        if(!r){ ipOk(conn.ip, 3); return err(ws, 'no_room', '그 초대 코드의 마을을 찾지 못했어요. 코드를 다시 확인해 주세요.'); }
        if(r.players.size >= MAX_PLAYERS) return err(ws, 'full', `이 마을은 이미 ${MAX_PLAYERS}명이 꽉 찼어요.`);
        const { player: np, token } = newPlayer(uniqueNick(r, nick), readAvatar(m.avatar));
        if(r.phase === 'play') np.state = lateJoinState(r, np);
        r.players.set(np.pid, np); if(!r.hostPid) r.hostPid = np.pid;
        attach(conn, r, np);
        send(ws, joinedMsg(r, np, token)); pushRoomState(r); send(ws, sharedFor(r, np));
        if(r.phase === 'play') sendSnapshot(r, np, 'join');
        broadcast(r, { t: 'player:chat', sys: true, text: `👋 ${np.nick} 님이 마을에 이사 왔어요!`, t2: now() }, np);
        r.dirty = true; saveRoom(r); log('입장', r.code, np.nick);
      }).catch(e => err(ws, 'server', e.message));
      return;
    }
    case 'player:reconnect': {
      if(!ipOk(conn.ip)) return err(ws, 'rate', '재접속 시도가 너무 많아요. 잠시 뒤 다시 해 주세요.');
      const code = cleanText(m.code, 12), token = typeof m.token === 'string' && m.token.length <= 80 ? m.token : null;
      if(!code || !token){ ipOk(conn.ip, 2); return err(ws, 'bad_token', '복구 정보가 올바르지 않아요.'); }
      loadRoom(code.toUpperCase()).then(r => {
        if(!r){ ipOk(conn.ip, 3); return err(ws, 'no_room', '그 마을을 찾지 못했어요.'); }
        const h = sha(token);
        const np = [...r.players.values()].find(x => x.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
        if(!np){ ipOk(conn.ip, 3); return err(ws, 'bad_token', '이 기기에 저장된 복구 코드가 이 마을의 계좌와 맞지 않아요.'); }
        attach(conn, r, np);
        send(ws, joinedMsg(r, np)); pushRoomState(r);
        if(r.phase === 'play') sendSnapshot(r, np, 'reconnect');                 // 최신 전체 상태를 먼저 보내고
        send(ws, sharedFor(r, np));                                             // 그다음 실시간 업데이트가 이어져요
        log('재접속', r.code, np.nick);
      }).catch(e => err(ws, 'server', e.message));
      return;
    }
  }
  if(!room || !p) return err(ws, 'no_room', '먼저 마을에 들어가 주세요.');
  if(!room.players.has(p.pid)) return err(ws, 'kicked', '이 마을의 주민이 아니에요.');
  switch(m.t){
    case 'room:leave': {
      if(room.phase === 'lobby'){ room.players.delete(p.pid); detach(conn); if(room.hostPid === p.pid){ const nx = [...room.players.values()][0]; room.hostPid = nx ? nx.pid : null; }
        send(ws, { t: 'room:left' }); pushRoomState(room); room.dirty = true; saveRoom(room); }
      else { detach(conn); send(ws, { t: 'room:left' }); }
      return;
    }
    case 'player:move': {
      if(!take(conn.moveBucket)) return;
      if(!(numIn(m.x, 0, 64 * 32) && numIn(m.y, 0, 46 * 32) && intIn(m.seq, 0, 1e9))) return;
      if(m.seq <= p.moveSeq) return;                                             // 늦게 도착한 옛 위치는 버려요
      const t = now(), prev = p.pos;
      if(prev){ const dt = Math.max(0.05, (t - p.lastMove) / 1000), dist = Math.hypot(m.x - prev.x, m.y - prev.y);
        if(dist > 200 * dt + 48 && !m.warp){ return sendTo(p, { t: 'player:pos:fix', x: prev.x, y: prev.y }); } }   // 너무 빠른 이동은 거절
      if(room.engine && room.engine.worldReady && room.engine.collides(m.x, m.y) && !m.warp && prev) return sendTo(p, { t: 'player:pos:fix', x: prev.x, y: prev.y });
      if(m.warp && !['home', 'door', 'map'].includes(m.warp)) return;
      p.moveSeq = m.seq; p.lastMove = t;
      p.pos = { x: Math.round(m.x), y: Math.round(m.y), dir: ['up', 'down', 'left', 'right'].includes(m.dir) ? m.dir : 'down', moving: !!m.moving };
      if(p.state){ p.state.player.x = p.pos.x; p.state.player.y = p.pos.y; p.state.player.dir = p.pos.dir; }
      room.posDirty = true;
      return;
    }
    case 'player:emote': { if(!take(conn.chatBucket)) return; if(!EMOTES.includes(m.e)) return; broadcast(room, { t: 'player:emote', pid: p.pid, e: m.e }); return; }
    case 'player:chat': {
      if(!take(conn.chatBucket)) return err(ws, 'rate', '채팅이 너무 빨라요.');
      const text = cleanText(m.text, 120); if(!text) return;
      const msg = { pid: p.pid, nick: p.nick, text, t2: now() };
      room.shared.chat.push(msg); if(room.shared.chat.length > 60) room.shared.chat.shift();
      broadcast(room, Object.assign({ t: 'player:chat' }, msg)); room.dirty = true; return;
    }
    case 'player:status': { if(!STATUSES.includes(m.s)) return; if(p.status !== m.s){ p.status = m.s; pushRoomState(room); } return; }
    case 'player:ready': {
      if(room.phase !== 'play') return;
      p.ready = !!m.ready; pushRoomState(room);
      if(p.ready) checkReady(room);
      return;
    }
    case 'player:privacy': {
      for(const k of ['holdings', 'trades', 'weights', 'judgment', 'home']) if(typeof (m.privacy || {})[k] === 'boolean') p.privacy[k] = m.privacy[k];
      room.dirty = true; pushRoomState(room); send(ws, { t: 'privacy', privacy: p.privacy }); return;
    }
    case 'player:patch': { if(room.phase !== 'play' || room.advancing) return; applyPatch(room, p, m.d); room.dirty = true; if(m.d && Array.isArray(m.d.journal)) pushShared(room); return; }
    case 'player:visit': {
      const f = room.players.get(m.pid); if(!f || !f.state) return err(ws, 'no_player', '그 친구를 찾지 못했어요.');
      if(f !== p && !f.privacy.home) return err(ws, 'private', `${f.nick} 님은 지금 집 방문을 받지 않아요.`);
      send(ws, { t: 'visit:home', pid: f.pid, nick: f.nick, avatar: f.avatar, home: f.state.home }); return;
    }
    case 'board:get': { if(room.phase !== 'play') return; send(ws, boardFor(room, p)); return; }
    case 'shared:get': { send(ws, sharedFor(room, p)); return; }
    case 'market:order': case 'market:cancel': case 'market:fx': {
      // ① 플레이어 확인 ② 방 참여 확인은 위에서 끝났어요
      const reqId = typeof m.reqId === 'string' && m.reqId.length <= 48 ? m.reqId : null;
      if(!reqId) return err(ws, 'bad_req', '주문 번호가 없어요.');
      if(p.reqCache.has(reqId)) return send(ws, Object.assign({ t: 'market:orderResult', reqId, dup: true }, p.reqCache.get(reqId)));   // 같은 주문을 두 번 처리하지 않아요
      const finish = r => { p.reqCache.set(reqId, r); if(p.reqCache.size > 120) p.reqCache.delete(p.reqCache.keys().next().value);
        send(ws, Object.assign({ t: 'market:orderResult', reqId }, r)); if(r.ok) sendTo(p, Object.assign({ t: 'me:update' }, personalDelta(p))); room.dirty = true; };
      if(room.phase !== 'play' || !p.state) return finish({ ok: false, msg: '아직 게임이 시작되지 않았어요.' });
      if(room.advancing) return finish({ ok: false, msg: '지금은 날짜가 바뀌는 중이에요. 잠시 뒤 다시 주문해 주세요.' });
      if(m.day != null && m.day !== p.state.clock.day) return finish({ ok: false, msg: '그사이 날짜가 바뀌었어요. 새 가격을 확인하고 다시 주문해 주세요.', stale: true });
      const api = room.engine;
      if(m.t === 'market:order'){
        if(!api.C.TRADE_IDS.includes(m.cid)) return finish({ ok: false, msg: '없는 종목이에요.' });                    // ③ 종목 확인
        if(!['buy', 'sell'].includes(m.side) || !['market', 'limit'].includes(m.type)) return finish({ ok: false, msg: '주문 종류가 올바르지 않아요.' });
        if(!intIn(m.qty, 1, 1000000)) return finish({ ok: false, msg: '수량은 1주 이상 정수로 입력해 주세요.' });
        if(m.type === 'limit' && !numIn(m.limit, 0.01, 1e7)) return finish({ ok: false, msg: '지정가를 확인해 주세요.' });
        const why = m.why && typeof m.why === 'object' ? { tag: cleanText(m.why.tag, 30) || '', text: cleanText(m.why.text, 80) || '' } : null;
        // ④~⑩ 주문 가능 상태·잔고·조건 확인 → 체결 결정 → 계좌 변경 → 거래 기록은 게임 엔진의 placeOrder가 처리해요
        const r = withState(room, p, a => a.placeOrder(m.cid, m.side, m.type, m.qty, m.type === 'limit' ? m.limit : 0, (why && (why.tag || why.text)) ? why : null));
        return finish({ ok: !!r.ok, msg: String(r.msg || '') });
      }
      if(m.t === 'market:cancel'){
        if(!intIn(m.oid, 1, 1e9)) return finish({ ok: false, msg: '주문 번호가 올바르지 않아요.' });
        const o = p.state.orders.find(x => x.id === m.oid);
        if(!o || o.status !== 'open') return finish({ ok: false, msg: '취소할 수 있는 주문이 아니에요.' });
        withState(room, p, a => a.cancelOrder(m.oid)); return finish({ ok: true, msg: '주문을 취소했어요.' });
      }
      if(m.t === 'market:fx'){
        if(!['toUsd', 'toKrw'].includes(m.dir) || !numIn(m.amount, 0.01, 1e12)) return finish({ ok: false, msg: '환전 금액을 확인해 주세요.' });
        const r = withState(room, p, a => a.doExchange(m.dir, m.amount));
        return finish({ ok: !!r.ok, msg: String(r.msg || '') });
      }
      return;
    }
    case 'rate:predict': {
      const pr = room.shared.pred; const day = p.state ? p.state.clock.day : 0;
      if(!pr || pr.resolved || pr.cbDay !== day + 1) return err(ws, 'closed', '지금은 금리 예측을 받지 않아요.');
      if(!CB_GUESSES.includes(m.guess)) return err(ws, 'bad', '예측 값을 다시 골라 주세요.');
      pr.by[p.pid] = m.guess; room.dirty = true; pushShared(room); return;
    }
    case 'debate:answer': {
      const d = room.shared.debates.find(x => x.id === m.id); if(!d || d.closed) return err(ws, 'closed', '이 토론은 끝났어요.');
      if(!DEBATE_CHOICES.includes(m.choice)) return err(ws, 'bad', '선택지를 다시 골라 주세요.');
      d.answers[p.pid] = { choice: m.choice, reason: cleanText(m.reason, 300) || '', at: now() }; room.dirty = true; pushShared(room); return;
    }
    case 'research:post': {
      if(!RESEARCH_TOPICS.includes(m.topic)) return err(ws, 'bad', '조사 주제를 골라 주세요.');
      const text = cleanText(m.text, 600), data = cleanText(m.data, 900); if(!text && !data) return err(ws, 'bad', '조사 내용을 적어 주세요.');
      if(room.shared.research.filter(x => x.pid === p.pid && x.day === (p.state ? p.state.clock.day : 0)).length >= 6) return err(ws, 'rate', '오늘은 조사 기록을 충분히 남겼어요.');
      room.shared.research.push({ id: crypto.randomUUID().slice(0, 8), pid: p.pid, nick: p.nick, topic: m.topic, text: text || '', data: data || '', day: p.state ? p.state.clock.day : 0, t2: now() });
      if(room.shared.research.length > 100) room.shared.research.shift();
      room.dirty = true; pushShared(room); return;
    }
    /* ---------- 방장 기능 ---------- */
    case 'host:settings': {
      if(!requireHost(conn, ws)) return;
      if(room.phase === 'lobby') room.settings = readSettings(m.settings, room.settings);
      else { const s2 = readSettings(m.settings, room.settings);                // 게임 중에는 경제 규칙은 못 바꾸고 진행 방식·공개 설정만 바꿔요
        room.settings.timeMode = s2.timeMode; room.settings.autoSpeed = s2.autoSpeed; room.settings.showReturns = s2.showReturns; room.settings.name = s2.name; }
      room.dirty = true; pushRoomState(room); return;
    }
    case 'host:start': {
      if(!requireHost(conn, ws)) return;
      if(room.phase !== 'lobby') return err(ws, 'started', '이미 시작했어요.');
      const online = [...room.players.values()].filter(x => x.online);
      const notReady = online.filter(x => !x.ready && x.pid !== room.hostPid);
      if(notReady.length && !m.force) return err(ws, 'not_ready', `아직 준비하지 않은 주민이 있어요: ${notReady.map(x => x.nick).join(', ')}`);
      for(const x of [...room.players.values()]) if(!x.online) room.players.delete(x.pid);   // 대기실을 떠난 사람은 정리
      startGame(room); for(const x of room.players.values()) x.ready = false;
      pushRoomState(room); for(const x of room.players.values()){ sendSnapshot(room, x, 'start'); sendTo(x, sharedFor(room, x)); }
      room.dirty = true; saveRoom(room); return;
    }
    case 'lobby:ready': { if(room.phase !== 'lobby') return; p.ready = !!m.ready; pushRoomState(room); return; }
    case 'lobby:profile': {
      if(room.phase !== 'lobby') return;
      const nick = cleanText(m.nick, 10); if(nick && nick !== p.nick) p.nick = uniqueNick(room, nick);
      if(m.avatar) p.avatar = readAvatar(m.avatar); pushRoomState(room); return;
    }
    case 'host:kick': {
      if(!requireHost(conn, ws)) return;
      const t = room.players.get(m.pid); if(!t || t === p) return err(ws, 'bad', '추방할 수 없어요.');
      room.players.delete(t.pid); for(const w of t.conns){ send(w, { t: 'kicked', msg: '방장이 마을에서 내보냈어요.' }); const c = w._conn; if(c){ c.room = null; c.player = null; } }
      t.conns.clear(); broadcast(room, { t: 'player:chat', sys: true, text: `🚪 ${t.nick} 님이 마을을 떠났어요.`, t2: now() });
      room.dirty = true; pushRoomState(room); checkReady(room); saveRoom(room); return;
    }
    case 'host:transfer': {
      if(!requireHost(conn, ws)) return;
      const t = room.players.get(m.pid); if(!t || t === p) return err(ws, 'bad', '그 주민에게 넘길 수 없어요.');
      room.hostPid = t.pid; broadcast(room, { t: 'player:chat', sys: true, text: `👑 이제 ${t.nick} 님이 방장이에요.`, t2: now() });
      room.dirty = true; pushRoomState(room); return;
    }
    case 'host:pause': { if(!requireHost(conn, ws)) return; room.paused = !!m.paused; room.forceAt = 0; pushRoomState(room);
      broadcast(room, { t: 'player:chat', sys: true, text: room.paused ? '⏸ 방장이 시간 진행을 멈췄어요.' : '▶ 시간 진행을 다시 시작해요.', t2: now() }); if(!room.paused) checkReady(room); return; }
    case 'host:advance': {
      if(!requireHost(conn, ws)) return;
      if(room.phase !== 'play' || room.settings.timeMode !== 'turn') return;
      if(m.cancel){ room.forceAt = 0; pushRoomState(room); return; }
      room.forceAt = now() + FORCE_ADVANCE_SEC * 1000; pushRoomState(room);
      broadcast(room, { t: 'player:chat', sys: true, text: `⏩ 방장이 다음 거래일 진행을 요청했어요. ${FORCE_ADVANCE_SEC}초 뒤 넘어가요. 준비를 마쳐 주세요!`, t2: now() });
      return;
    }
    case 'host:scenario': {
      if(!requireHost(conn, ws)) return;
      if(room.phase !== 'play' || !['gfc', 'rate', 'war'].includes(m.id)) return err(ws, 'bad', '고를 수 없는 시나리오예요.');
      const day = refPlayer(room).state.clock.day;
      if(day - room.shared.scenUsedDay < 60) return err(ws, 'cooldown', '공동 시나리오는 60거래일에 한 번만 시작할 수 있어요.');
      const sc = refPlayer(room).state.mkt.scen; if(sc && !sc.done) return err(ws, 'busy', '이미 위기가 다가오고 있어요.');
      for(const x of room.players.values()) if(x.state) x.state.mkt.forceCrisis = m.id;   // 모든 사람의 시장에 똑같이 적용돼요
      room.shared.scenUsedDay = day; room.dirty = true;
      broadcast(room, { t: 'player:chat', sys: true, text: `🎬 방장이 공동 시나리오를 시작했어요. 언제, 얼마나 큰 위기가 될지는 아무도 몰라요.`, t2: now() });
      return;
    }
    case 'league:start': {
      if(!requireHost(conn, ws)) return;
      if(room.phase !== 'play') return;
      if(![30, 90, 250].includes(m.days)) return err(ws, 'bad', '기간을 골라 주세요.');
      if(room.shared.league && room.shared.league.status === 'running') return err(ws, 'busy', '이미 리그가 진행 중이에요.');
      const day = refPlayer(room).state.clock.day, startVals = totalsOf(room);
      room.shared.league = { status: 'running', days: m.days, startDay: day, endDay: day + m.days, startVals, result: null };
      broadcast(room, { t: 'player:chat', sys: true, text: `🏆 투자왕 리그 시작! ${m.days}거래일 동안의 수익률로 겨뤄요. (시작 자산 대비 %로 계산해서 모두 같은 출발선이에요)`, t2: now() });
      room.dirty = true; pushShared(room); return;
    }
    case 'game:save': {
      if(!requireHost(conn, ws)) return;
      saveRoom(room).then(() => broadcast(room, { t: 'game:saved', at: now() })); return;
    }
    default: return err(ws, 'unknown', '알 수 없는 요청이에요.');
  }
}

/* =====================================================================
   HTTP + WebSocket 서버
   ===================================================================== */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if(url === '/healthz'){ res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, store: store.kind, version: SERVER_VERSION })); }
  if(url === '/' || url === '/index.html'){
    fs.readFile(GAME_HTML, (e, buf) => {
      if(e){ res.writeHead(500); return res.end('index.html 을 찾지 못했어요'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('없는 주소예요');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024, perMessageDeflate: { threshold: 2048 } });
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const conn = { ws, ip, room: null, player: null, bucket: bucket(30, 60), moveBucket: bucket(25, 40), chatBucket: bucket(1.5, 6), alive: true };
  ws._conn = conn;
  send(ws, { t: 'hello', server: SERVER_VERSION });
  ws.on('message', (data, isBinary) => { if(isBinary) return; try{ onMessage(conn, data.toString()); }catch(e){ log('처리 오류', e.stack); err(ws, 'server', '서버에서 문제가 생겼어요.'); } });
  ws.on('pong', () => { conn.alive = true; });
  ws.on('close', () => detach(conn));
  ws.on('error', () => {});
});

/* 주기적인 일: 위치 방송 · 자동 진행 · 강제 진행 · 저장 · 빈 방 정리 · 연결 확인 */
setInterval(() => {
  const t = now();
  for(const room of rooms.values()){
    if(room.posDirty && t - room.lastPosSent >= 100){ room.posDirty = false; room.lastPosSent = t;
      broadcast(room, { t: 'player:pos', list: [...room.players.values()].filter(p => p.pos).map(p => [p.pid, p.pos.x, p.pos.y, p.pos.dir, p.pos.moving ? 1 : 0, p.online ? 1 : 0]) }); }
    if(room.phase === 'play' && !room.paused){
      if(room.settings.timeMode === 'auto' && [...room.players.values()].some(p => p.online) && t >= room.nextStepAt){ room.nextStepAt = t + (AUTO_STEP_MS[room.settings.autoSpeed] || 1600); stepAuto(room); }
      if(room.settings.timeMode === 'turn' && room.forceAt && t >= room.forceAt) advanceDay(room, 'host');
    }
  }
}, 50);
setInterval(() => {
  const t = now();
  for(const [code, room] of rooms){
    if(room.dirty && !room.saving) saveRoom(room);
    if(room.emptySince && t - room.emptySince > ROOM_IDLE_UNLOAD_MS && !room.saving && !room.dirty){ rooms.delete(code); log('빈 방 내려놓음', code); }
  }
  for(const [ip, b] of ipBuckets) if(t - b.last > 10 * 60 * 1000) ipBuckets.delete(ip);
}, 5000);
setInterval(() => { for(const ws of wss.clients){ const c = ws._conn; if(!c) continue; if(!c.alive){ ws.terminate(); continue; } c.alive = false; try{ ws.ping(); }catch(e){} } }, 20000);

async function shutdown(){
  log('서버를 끄기 전에 모든 방을 저장해요…');
  await Promise.all([...rooms.values()].map(r => saveRoom(r)));
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

store.init().then(() => {
  server.listen(PORT, () => log(`🐹 주식마을 서버 시작 — http://localhost:${PORT}  (저장소: ${store.kind})`));
}).catch(e => { console.error('저장소 준비 실패:', e); process.exit(1); });

module.exports = { server, rooms };
