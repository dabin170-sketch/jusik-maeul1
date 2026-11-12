'use strict';
/* =====================================================================
   🧠 게임 엔진을 서버에서 돌리는 장치
   ---------------------------------------------------------------------
   · 브라우저용 index.html 안의 게임 코드를 「그대로」 읽어서 서버에서 실행해요.
     그래서 혼자 플레이와 함께 플레이의 시장 규칙이 항상 똑같아요.
   · 화면(document, canvas 등)이 없는 서버에서도 돌아가도록, 화면 관련 기능은
     아무 일도 하지 않는 가짜 물건(스텁)으로 바꿔 끼워요.
   · 방마다 엔진을 하나씩 만들어요. 방끼리 상태가 섞이지 않아요.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_HTML = process.env.GAME_HTML || path.join(__dirname, '..', 'index.html');
const BOOT_LINE = 'resize(); buildWorld(); showTitle(); requestAnimationFrame(frame);';

/* 게임 상태 중 「한 사람의 것」인 칸들. 나머지는 모두 같은 방이 함께 쓰는 시장·경제 칸이에요. */
const PERSONAL_KEYS = ['player','pf','orders','trades','lessons','quests','badges','flags','diary','diaryLog','walked','settings','home','life','psy','journal','pfHist','savedAt','createdAt'];

function extractScript(html){
  const a = html.indexOf('<script>'), b = html.lastIndexOf('</script>');
  if(a < 0 || b < 0) throw new Error('index.html 에서 게임 코드를 찾지 못했어요');
  return html.slice(a + 8, b);
}
/* 무엇을 해도 조용히 받아 주는 가짜 화면 물건 */
function makeStub(){
  const target = function(){};
  let p;
  p = new Proxy(target, {
    get(t, k){
      if(k === Symbol.toPrimitive) return () => 0;
      if(k === 'valueOf') return () => 0;
      if(k === 'toString') return () => '';
      if(k === Symbol.iterator) return function*(){};
      if(k === 'length') return 0;
      if(k === 'then') return undefined;
      return p;
    },
    set(){ return true; }, apply(){ return p; }, construct(){ return p; }, has(){ return true; }, deleteProperty(){ return true; }
  });
  return p;
}
const API_SUFFIX = `
;globalThis.__api = {
  getS:()=>S, setS:(v)=>{ S=v; if(v && v.rng!=null) RNG.s=v.rng; }, syncRng:()=>{ if(S) S.rng=RNG.s; }, rngNow:()=>RNG.s, setRng:(r)=>{ RNG.s=r; },
  setSilent:(v)=>{ SILENT=!!v; },
  newState, startDay, sleepToMorning, advanceClock, placeOrder, cancelOrder, doExchange, migrateSave, validateState,
  totalAssets, lastIdx, isOpen, co, mddArr, fairPrice,
  collides:(x,y)=>collides(x,y),
  buildWorld:()=>{ try{ buildWorld(); return true; }catch(e){ return String(e); } },
  C:{ VERSION, START_CASH, FX_SPREAD, OPEN_MIN, CLOSE_MIN, TICKS, TICK_MIN, DAY_START, DAY_END, T, WORLD_W, WORLD_H,
      TRADE_IDS, IDS, ETF_IDS, SCENARIOS, PRES_TIERS },
  DEF, RIVAL_DEFS, GROUP_NAME
};`;

const scriptCache = new Map();
function getScript(startCash){
  const key = String(startCash);
  if(scriptCache.has(key)) return scriptCache.get(key);
  const html = fs.readFileSync(GAME_HTML, 'utf8');
  let src = extractScript(html);
  if(!src.includes(BOOT_LINE)) throw new Error('게임 시작 줄을 찾지 못했어요 (index.html 이 바뀌었나요?)');
  src = src.replace(BOOT_LINE, '').replace('if(document.fonts) document.fonts.ready.then(()=>{ GROUND=buildGround(); });','');
  const cashLine = 'const START_CASH = 1000000;';
  if(!src.includes(cashLine)) throw new Error('START_CASH 줄을 찾지 못했어요');
  src = src.replace(cashLine, `const START_CASH = ${Math.round(startCash)};`);
  src += API_SUFFIX;
  const script = new vm.Script(src, { filename: 'jusik-maeul-engine.js' });
  scriptCache.set(key, script);
  return script;
}
function memoryStorage(){ const m = new Map(); return { getItem:k=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), clear:()=>m.clear(), key:()=>null, length:0 }; }

/* 방 하나를 위한 엔진 만들기 */
function createEngine({ startCash = 1000000 } = {}){
  const stub = makeStub();
  const noop = () => 0;
  const ctx = {
    console, Math, Date, JSON, Intl, Number, String, Array, Object, Set, Map, Symbol, Promise, Error, RegExp, isFinite, isNaN, parseInt, parseFloat,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop, queueMicrotask: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    performance: { now: () => Date.now() },
    document: stub, window: stub, navigator: stub, screen: stub, history: stub,
    location: { search: '', hash: '', protocol: 'http:', host: 'server', href: 'http://server/' },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    Image: stub, Audio: stub, AudioContext: stub, webkitAudioContext: stub, Blob: stub, URL: stub, FileReader: stub,
    alert: noop, confirm: () => false, prompt: () => null,
    getComputedStyle: () => stub, matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    fetch: () => Promise.reject(new Error('no fetch on server')), URLSearchParams, TextEncoder, TextDecoder,
  };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  getScript(startCash).runInContext(ctx, { timeout: 20000 });
  const api = ctx.__api;
  api.setSilent(true);
  api.worldReady = api.buildWorld() === true;
  return api;
}

/* ---------- 상태 다루기 도구 ---------- */
const clone = o => JSON.parse(JSON.stringify(o));
function splitState(s){
  const personal = {}, market = {};
  for(const k of Object.keys(s)) (PERSONAL_KEYS.includes(k) ? personal : market)[k] = s[k];
  return { personal, market };
}
function joinState(market, personal){ return Object.assign(clone(market), clone(personal)); }
/* 시장 상태가 플레이어마다 똑같은지 확인하는 지문 */
function marketFingerprint(s){
  let h = 2166136261 >>> 0;
  const add = str => { for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  add(String(s.rng)); add(String(s.clock.day) + ':' + Math.round(s.clock.min)); add(String(s.fx));
  for(const id of Object.keys(s.cos)) add(id + s.cos[id].price.toFixed(4));
  add(String(s.news.length));
  return h.toString(16);
}

module.exports = { createEngine, PERSONAL_KEYS, splitState, joinState, clone, marketFingerprint };
