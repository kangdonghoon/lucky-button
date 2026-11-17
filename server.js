// The Luckiest Person in the World — 정답 판정과 기록은 서버가 맡는다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store.js');

const PORT = process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMINS = new Set((process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const SESSION_MS = 30 * 24 * 3600 * 1000; // 로그인 유지 30일
const BOARD_SIZE = 20;
const PICK_GAP_MS = Number(process.env.PICK_GAP_MS ?? 250); // 버튼 연타·자동 클릭 방지 (서버 기준 최소 간격)
const RUN_IDLE_MS = 10 * 60 * 1000;   // 10분 동안 안 누른 도전은 정리
const MAX_FLOOR = 1000;

const store = createStore();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbErr = e => console.error('[db]', e && e.message || e);

// ───────── 계정 ─────────
const isAdmin = u => !!u && ADMINS.has(u.username);
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(String(pw), salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
}
async function verifyPw(u, pw) {
  const h = await scrypt(pw, u.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.pwHash, 'hex'));
}
async function newSession(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.createSession(sha(token), u.id, Date.now() + SESSION_MS);
  return token;
}
// 세션 → 사용자. 매 요청마다 DB를 치지 않도록 1분 캐시
const sessCache = new Map(); // sha(token) → { user, at }
async function authed(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const h = sha(token), c = sessCache.get(h);
  if (c && Date.now() - c.at < 60000) return c.user;
  const u = await store.sessionUser(h);
  if (!u || u.banned) { sessCache.delete(h); return null; }
  sessCache.set(h, { user: u, at: Date.now() });
  return u;
}
function forgetUser(uid) { for (const [h, c] of sessCache) if (c.user.id === uid) sessCache.delete(h); }
setInterval(() => { const now = Date.now(); for (const [h, c] of sessCache) if (now - c.at > 120000) sessCache.delete(h); }, 60000).unref();
setInterval(() => store.purgeSessions().catch(dbErr), 6 * 3600 * 1000).unref();

// ───────── 도전 (메모리) ─────────
// uid → { floor, last, nick, startedAt }
const runs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [uid, r] of runs) if (now - r.last > RUN_IDLE_MS) { runs.delete(uid); store.recordRun(uid, r.floor).catch(dbErr); markLive(); }
}, 30000).unref();

// ───────── 리더보드 + 실시간 방송 (SSE) ─────────
const clients = new Set();
let board = [];          // 상위 BOARD_SIZE
let boardV = 0;
let liveDirty = false, boardDirty = true;
let dbReady = false; // 테이블이 만들어지기 전에는 리더보드를 읽지 않는다 (Neon은 깨는 데 몇 초 걸림)
async function refreshBoard() {
  try { board = await store.top(BOARD_SIZE); boardV++; } catch (e) { dbErr(e); }
}
const ACTIVE_MS = 2 * 60 * 1000; // 2분 안에 누른 사람만 '도전 중'
const activeRuns = () => { const now = Date.now(); return [...runs.values()].filter(r => now - Math.max(r.last, r.startedAt) < ACTIVE_MS); };
function liveList() {
  return activeRuns().filter(r => r.floor >= 3)
    .sort((a, c) => c.floor - a.floor || a.startedAt - c.startedAt).slice(0, 5)
    .map(r => ({ nick: r.nick, floor: r.floor }));
}
function snapshot() {
  return { board, live: liveList(), playing: activeRuns().length, online: clients.size, v: boardV };
}
function sendTo(res, data) { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { /* 끊긴 연결 */ } }
function markLive() { liveDirty = true; }
function markBoard() { boardDirty = true; }
// 짧은 간격으로 모아서 한 번에 보낸다
setInterval(async () => {
  if (!dbReady || (!boardDirty && !liveDirty)) return;
  const wasBoard = boardDirty;
  boardDirty = false; liveDirty = false;
  if (wasBoard) await refreshBoard();
  const snap = snapshot();
  for (const res of clients) sendTo(res, snap);
}, 400).unref();
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } markLive(); }, 25000).unref();

// ───────── 요청 제한 ─────────
const buckets = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.at > ms) { b = { at: now, n: 0 }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 600000) buckets.delete(k); }, 60000).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ───────── API ─────────
function coin() { return crypto.randomInt(0, 2); }
async function me(u) {
  const fresh = await store.userById(u.id);
  const r = runs.get(u.id);
  return {
    id: fresh.id, username: fresh.username, nick: fresh.nick, best: fresh.best, plays: fresh.plays,
    rank: await store.rankOf(u.id), admin: isAdmin(fresh), floor: r ? r.floor : null,
  };
}

async function handle(body, ip) {
  const t = body.t;
  // 가입·로그인
  if (t === 'signup' || t === 'login') {
    if (limited('auth:' + ip, 30, 60000)) return [429, { error: 'Too many attempts. Try again in a minute.' }];
    const username = clean(body.username, 20).toLowerCase();
    const pw = String(body.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return [400, { error: 'Username must be 3–20 lowercase letters, numbers or _' }];
    if (pw.length < 4 || pw.length > 100) return [400, { error: 'Password must be at least 4 characters' }];
    let u;
    if (t === 'signup') {
      const nick = clean(body.nick, 12);
      if (nick.length < 1) return [400, { error: 'Please enter a nickname' }];
      const salt = crypto.randomBytes(16).toString('hex');
      u = await store.createUser({ username, nick, pwHash: await scrypt(pw, salt), salt });
      if (!u) return [409, { error: 'That username is taken' }];
      log('가입', username);
    } else {
      u = await store.userByName(username);
      if (!u || !(await verifyPw(u, pw))) return [401, { error: 'Wrong username or password' }];
      if (u.banned) return [403, { error: 'This account has been suspended' }];
    }
    return [200, { sess: await newSession(u), me: await me(u) }];
  }

  const u = await authed(body.sess);
  if (!u) return [401, { error: 'auth' }];

  if (t === 'me') return [200, { me: await me(u) }];
  if (t === 'logout') { await store.deleteSession(sha(body.sess)); sessCache.delete(sha(body.sess)); return [200, { ok: true }]; }
  if (t === 'nick') {
    const nick = clean(body.nick, 12);
    if (nick.length < 1) return [400, { error: 'Please enter a nickname' }];
    await store.setNick(u.id, nick); forgetUser(u.id);
    const r = runs.get(u.id); if (r) r.nick = nick;
    markBoard(); markLive();
    return [200, { me: await me(u) }];
  }

  // 도전 시작: 진행 중인 도전이 있으면 그대로 이어간다 (새로고침 대비)
  if (t === 'start') {
    let r = runs.get(u.id);
    if (!r) { r = { floor: 0, last: 0, nick: u.nick, startedAt: Date.now() }; runs.set(u.id, r); markLive(); }
    return [200, { floor: r.floor }];
  }

  // 버튼 고르기: 정답은 누를 때마다 서버가 새로 정한다
  if (t === 'pick') {
    const r = runs.get(u.id);
    if (!r) return [409, { error: 'Start a run first' }];
    const i = body.i === 1 ? 1 : body.i === 0 ? 0 : null;
    if (i == null) return [400, { error: 'bad pick' }];
    const now = Date.now();
    if (now - r.last < PICK_GAP_MS) return [429, { error: 'Too fast' }];
    r.last = now;
    const answer = coin();
    if (answer === i && r.floor < MAX_FLOOR) {
      r.floor++;
      let record = false;
      if (r.floor > u.best) {
        record = await store.raiseBest(u.id, r.floor, now);
        if (record) { u.best = r.floor; markBoard(); }
      }
      if (r.floor >= 3) markLive();
      return [200, { ok: true, answer, floor: r.floor, best: Math.max(u.best, r.floor), record }];
    }
    runs.delete(u.id);
    markLive();
    store.recordRun(u.id, r.floor).catch(dbErr);
    const fresh = await store.userById(u.id);
    return [200, { ok: false, answer, floor: r.floor, best: fresh.best, newBest: r.floor > 0 && r.floor === fresh.best && fresh.bestAt >= r.startedAt, rank: await store.rankOf(u.id) }];
  }

  // ───── 관리자 ─────
  if (t && t.startsWith('admin')) {
    if (!isAdmin(u)) return [403, { error: 'Admins only' }];
    if (t === 'adminUsers') return [200, { users: (await store.listUsers(clean(body.q, 30))).map(x => ({ id: x.id, username: x.username, nick: x.nick, best: x.best, plays: x.plays, picks: x.picks, banned: x.banned, createdAt: x.createdAt, lastSeen: x.lastSeen })) }];
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return [400, { error: 'bad id' }];
    if (t === 'adminBan') {
      await store.setBanned(id, !!body.banned);
      if (body.banned) { await store.deleteUserSessions(id); runs.delete(id); markLive(); }
      forgetUser(id); markBoard();
      return [200, { ok: true }];
    }
    if (t === 'adminResetBest') { await store.resetBest(id); forgetUser(id); markBoard(); return [200, { ok: true }]; }
    if (t === 'adminNick') {
      const nick = clean(body.nick, 12); if (!nick) return [400, { error: 'Please enter a nickname' }];
      await store.setNick(id, nick); forgetUser(id); markBoard(); return [200, { ok: true }];
    }
  }
  return [400, { error: 'unknown' }];
}

// ───────── HTTP ─────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(urlPath)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      if (clients.size >= 2000) return json(res, 503, { error: 'busy' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      sendTo(res, snapshot());
      markLive(); // 접속자 수 갱신
      req.on('close', () => { clients.delete(res); markLive(); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/board') return json(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, db: store.kind, playing: runs.size, online: clients.size });
    if (req.method === 'POST' && url.pathname === '/api') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let body; try { body = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad body' });
        const ip = clientIp(req);
        if (limited('rq:' + String(body.sess || ip).slice(0, 60), 20, 1000)) return json(res, 429, { error: 'Too fast' });
        try { const [code, out] = await handle(body, ip); json(res, code, out); }
        catch (e) { console.error(e); json(res, 500, { error: 'Server error. Please try again shortly.' }); }
      });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

const ready = store.init()
  .then(() => { dbReady = true; return refreshBoard(); })
  .then(() => new Promise(r => server.listen(PORT, HOST, () => {
    log(`The Luckiest Person in the World 서버 실행 중: http://localhost:${server.address().port} (저장소: ${store.kind}, 관리자: ${[...ADMINS].join(', ') || '없음'})`);
    r();
  })))
  .catch(e => { console.error('DB 연결 실패:', e.message); process.exit(1); });

module.exports = { server, store, ready }; // 테스트용
