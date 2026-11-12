'use strict';
/* =====================================================================
   💾 저장소
   ---------------------------------------------------------------------
   · DATABASE_URL 환경 변수가 있으면 PostgreSQL에 저장해요 (배포용).
   · 없으면 server/data/ 폴더에 JSON 파일로 저장해요 (내 컴퓨터에서 연습할 때).
   · 방 데이터(시장·경제·설정)와 개인 데이터(계좌·일기·학습)를 따로 저장해요.
   · 복구 토큰은 원문이 아니라 해시(지문)만 저장해요.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(dir){ this.dir = dir; fs.mkdirSync(dir, { recursive: true }); this.kind = 'file'; }
  async init(){}
  file(code){ return path.join(this.dir, code.replace(/[^A-Z0-9-]/g, '') + '.json'); }
  async exists(code){ return fs.existsSync(this.file(code)); }
  async load(code){
    const f = this.file(code); if(!fs.existsSync(f)) return null;
    const o = JSON.parse(await fs.promises.readFile(f, 'utf8'));
    return { room: o.room, players: o.players };
  }
  async save(code, room, players){
    const f = this.file(code), tmp = f + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ room, players }));
    await fs.promises.rename(tmp, f);   // 다 쓴 뒤에 이름을 바꿔서, 저장 도중 꺼져도 파일이 깨지지 않게
  }
  async remove(code){ try{ await fs.promises.unlink(this.file(code)); }catch(e){} }
}

class PgStore {
  constructor(url){
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: url, ssl, max: 5 });
    this.kind = 'postgres';
  }
  async init(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rooms(
        code TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS players(
        pid TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        token_hash TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS players_room ON players(room_code);`);
  }
  async exists(code){ const r = await this.pool.query('SELECT 1 FROM rooms WHERE code=$1', [code]); return r.rowCount > 0; }
  async load(code){
    const r = await this.pool.query('SELECT data FROM rooms WHERE code=$1', [code]);
    if(!r.rowCount) return null;
    const p = await this.pool.query('SELECT pid, token_hash, data FROM players WHERE room_code=$1', [code]);
    return { room: r.rows[0].data, players: p.rows.map(x => Object.assign({}, x.data, { pid: x.pid, tokenHash: x.token_hash })) };
  }
  async save(code, room, players){
    const c = await this.pool.connect();
    try{
      await c.query('BEGIN');   // 방과 플레이어를 한 번에(트랜잭션) 저장해요
      await c.query(`INSERT INTO rooms(code,data,updated_at) VALUES($1,$2,now())
                     ON CONFLICT(code) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [code, room]);
      const keep = players.map(p => p.pid);
      await c.query('DELETE FROM players WHERE room_code=$1 AND NOT (pid = ANY($2))', [code, keep]);
      for(const p of players){
        const { pid, tokenHash, ...data } = p;
        await c.query(`INSERT INTO players(pid,room_code,token_hash,data,updated_at) VALUES($1,$2,$3,$4,now())
                       ON CONFLICT(pid) DO UPDATE SET token_hash=EXCLUDED.token_hash, data=EXCLUDED.data, updated_at=now()`, [pid, code, tokenHash, data]);
      }
      await c.query('COMMIT');
    }catch(e){ await c.query('ROLLBACK').catch(()=>{}); throw e; }
    finally{ c.release(); }
  }
  async remove(code){ await this.pool.query('DELETE FROM rooms WHERE code=$1', [code]); }
}

function createStore(){
  if(process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}
module.exports = { createStore, FileStore, PgStore };
