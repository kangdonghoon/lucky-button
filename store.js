// 저장소: DATABASE_URL이 있으면 Postgres(Neon), 없으면 메모리(로컬 개발용, 재시작 시 초기화)
'use strict';

const b = v => v === true || v === 't' || v === 'true' || v === 1;
function mapUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id), username: r.username, nick: r.nick, pwHash: r.pw_hash, salt: r.salt,
    best: Number(r.best), bestAt: Number(r.best_at), plays: Number(r.plays), picks: Number(r.picks),
    banned: b(r.banned), createdAt: Number(r.created_at), lastSeen: Number(r.last_seen),
  };
}
const boardRow = u => ({ id: u.id, nick: u.nick, best: u.best, bestAt: u.bestAt });

// ───────── Postgres ─────────
class PgStore {
  constructor(url, pgModule) {
    const pg = pgModule || require('pg');
    this.pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000 });
    // Neon은 쉬는 동안 연결을 끊는다. 처리 안 하면 프로세스가 죽는다.
    this.pool.on('error', e => console.error('[db] idle client error:', e.message));
    this.kind = 'postgres';
  }
  q(text, params) { return this.pool.query(text, params || []); }
  async init() {
    await this.q(`CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      nick       TEXT NOT NULL,
      pw_hash    TEXT NOT NULL,
      salt       TEXT NOT NULL,
      best       INTEGER NOT NULL DEFAULT 0,
      best_at    BIGINT NOT NULL DEFAULT 0,
      plays      INTEGER NOT NULL DEFAULT 0,
      picks      INTEGER NOT NULL DEFAULT 0,
      banned     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      last_seen  BIGINT NOT NULL DEFAULT 0
    )`);
    await this.q(`CREATE INDEX IF NOT EXISTS users_board_idx ON users(best DESC, best_at ASC)`);
    // 닉네임은 대소문자 구분 없이 한 사람만 (먼저 쓴 사람 것)
    try { await this.q(`CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower_idx ON users (LOWER(nick))`); }
    catch (e) { console.error('[db] 겹치는 닉네임이 있어서 닉네임 중복 방지 인덱스를 못 만들었어요:', e.message); }
    await this.q(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )`);
    await this.q(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`);
  }
  async createUser({ username, nick, pwHash, salt }) {
    try {
      const r = await this.q(
        `INSERT INTO users (username, nick, pw_hash, salt, created_at, last_seen) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
        [username, nick, pwHash, salt, Date.now()]);
      return mapUser(r.rows[0]);
    } catch (e) { if (e.code === '23505') return null; throw e; }
  }
  async userByName(username) { const r = await this.q(`SELECT * FROM users WHERE username = $1`, [username]); return mapUser(r.rows[0]); }
  async userById(id) { const r = await this.q(`SELECT * FROM users WHERE id = $1`, [id]); return mapUser(r.rows[0]); }
  async createSession(hash, userId, expiresAt) {
    await this.q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [hash, userId, expiresAt]);
  }
  async sessionUser(hash) {
    const r = await this.q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2`, [hash, Date.now()]);
    return mapUser(r.rows[0]);
  }
  async deleteSession(hash) { await this.q(`DELETE FROM sessions WHERE token_hash = $1`, [hash]); }
  async deleteUserSessions(userId) { await this.q(`DELETE FROM sessions WHERE user_id = $1`, [userId]); }
  async purgeSessions() { await this.q(`DELETE FROM sessions WHERE expires_at <= $1`, [Date.now()]); }
  // 최고 기록은 더 높을 때만 바뀐다. 바뀌었으면 true
  async raiseBest(userId, best, at) {
    const r = await this.q(`UPDATE users SET best = $2, best_at = $3 WHERE id = $1 AND best < $2 RETURNING id`, [userId, best, at]);
    return r.rows.length > 0;
  }
  async recordRun(userId, picks) {
    await this.q(`UPDATE users SET plays = plays + 1, picks = picks + $2, last_seen = $3 WHERE id = $1`, [userId, picks, Date.now()]);
  }
  async top(limit) {
    const r = await this.q(`SELECT * FROM users WHERE best > 0 AND NOT banned ORDER BY best DESC, best_at ASC, id ASC LIMIT $1`, [limit]);
    return r.rows.map(mapUser).map(boardRow);
  }
  // 리더보드 순위 (기록이 없거나 정지면 null)
  async rankOf(userId) {
    const u = await this.userById(userId);
    if (!u || u.banned || u.best <= 0) return null;
    const r = await this.q(`SELECT COUNT(*) AS n FROM users WHERE NOT banned AND best > 0 AND (best > $1 OR (best = $1 AND (best_at < $2 OR (best_at = $2 AND id < $3))))`, [u.best, u.bestAt, u.id]);
    return Number(r.rows[0].n) + 1;
  }
  // 다른 사람이 쓰는 닉네임이면 false
  async setNick(userId, nick) {
    try { await this.q(`UPDATE users SET nick = $2 WHERE id = $1`, [userId, nick]); return true; }
    catch (e) { if (e.code === '23505') return false; throw e; }
  }
  async nickTaken(nick, exceptId) {
    const r = await this.q(`SELECT 1 FROM users WHERE LOWER(nick) = LOWER($1) AND id <> $2 LIMIT 1`, [nick, exceptId || 0]);
    return r.rows.length > 0;
  }
  async setBanned(userId, banned) { await this.q(`UPDATE users SET banned = $2 WHERE id = $1`, [userId, !!banned]); }
  async resetBest(userId) { await this.q(`UPDATE users SET best = 0, best_at = 0 WHERE id = $1`, [userId]); }
  async listUsers(search) {
    const s = search ? '%' + String(search).toLowerCase() + '%' : null;
    const r = s
      ? await this.q(`SELECT * FROM users WHERE LOWER(username) LIKE $1 OR LOWER(nick) LIKE $1 ORDER BY best DESC, id ASC LIMIT 200`, [s])
      : await this.q(`SELECT * FROM users ORDER BY best DESC, id ASC LIMIT 200`);
    return r.rows.map(mapUser);
  }
}

// ───────── 메모리 (DATABASE_URL 없을 때) ─────────
class MemStore {
  constructor() { this.users = new Map(); this.sessions = new Map(); this.seq = 0; this.kind = 'memory'; }
  async init() {}
  async createUser({ username, nick, pwHash, salt }) {
    for (const u of this.users.values()) if (u.username === username || u.nick.toLowerCase() === String(nick).toLowerCase()) return null;
    const now = Date.now();
    const u = { id: ++this.seq, username, nick, pwHash, salt, best: 0, bestAt: 0, plays: 0, picks: 0, banned: false, createdAt: now, lastSeen: now };
    this.users.set(u.id, u);
    return Object.assign({}, u);
  }
  async userByName(username) { for (const u of this.users.values()) if (u.username === username) return Object.assign({}, u); return null; }
  async userById(id) { const u = this.users.get(id); return u ? Object.assign({}, u) : null; }
  async createSession(hash, userId, expiresAt) { this.sessions.set(hash, { userId, expiresAt }); }
  async sessionUser(hash) {
    const s = this.sessions.get(hash);
    if (!s || s.expiresAt <= Date.now()) return null;
    return this.userById(s.userId);
  }
  async deleteSession(hash) { this.sessions.delete(hash); }
  async deleteUserSessions(userId) { for (const [h, s] of this.sessions) if (s.userId === userId) this.sessions.delete(h); }
  async purgeSessions() { const now = Date.now(); for (const [h, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(h); }
  async raiseBest(userId, best, at) {
    const u = this.users.get(userId);
    if (!u || u.best >= best) return false;
    u.best = best; u.bestAt = at; return true;
  }
  async recordRun(userId, picks) { const u = this.users.get(userId); if (u) { u.plays++; u.picks += picks; u.lastSeen = Date.now(); } }
  _sorted() {
    return [...this.users.values()].filter(u => u.best > 0 && !u.banned)
      .sort((a, c) => c.best - a.best || a.bestAt - c.bestAt || a.id - c.id);
  }
  async top(limit) { return this._sorted().slice(0, limit).map(boardRow); }
  async rankOf(userId) { const i = this._sorted().findIndex(u => u.id === userId); return i < 0 ? null : i + 1; }
  async setNick(userId, nick) {
    if (await this.nickTaken(nick, userId)) return false;
    const u = this.users.get(userId); if (u) u.nick = nick; return true;
  }
  async nickTaken(nick, exceptId) {
    const n = String(nick).toLowerCase();
    for (const u of this.users.values()) if (u.id !== exceptId && u.nick.toLowerCase() === n) return true;
    return false;
  }
  async setBanned(userId, banned) { const u = this.users.get(userId); if (u) u.banned = !!banned; }
  async resetBest(userId) { const u = this.users.get(userId); if (u) { u.best = 0; u.bestAt = 0; } }
  async listUsers(search) {
    const s = search ? String(search).toLowerCase() : '';
    return [...this.users.values()]
      .filter(u => !s || u.username.toLowerCase().includes(s) || u.nick.toLowerCase().includes(s))
      .sort((a, c) => c.best - a.best || a.id - c.id).slice(0, 200).map(u => Object.assign({}, u));
  }
}

function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) return new PgStore(url, process.env.PG_MODULE ? require(process.env.PG_MODULE) : undefined);
  console.warn('[db] DATABASE_URL이 없어서 메모리 저장소를 써요. 서버를 다시 켜면 기록이 사라져요.');
  return new MemStore();
}

module.exports = { createStore, PgStore, MemStore };
