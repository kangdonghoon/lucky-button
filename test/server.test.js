// 서버 통합 테스트: 실제로 서버를 띄우고 가입 → 도전 → 리더보드까지 확인
'use strict';
const assert = require('assert');
const http = require('http');

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.ADMIN_KEY = 'secret-key';
process.env.PICK_GAP_MS = '0';
if (!process.env.KEEP_DB) delete process.env.DATABASE_URL;

const { server, ready } = require('../server.js');
let base;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(raw); } catch (e) {} resolve(Object.assign({ status: res.statusCode }, j)); });
    });
    req.on('error', reject); req.end(data);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw, type: res.headers['content-type'] })); }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 한 번 끝날 때까지 도전. 결과 단계 반환
async function playOnce(sess, pickFn) {
  let r = await post({ t: 'start', sess }); assert.equal(r.status, 200);
  await sleep(55); // 초당 20번 제한 아래로
  for (let k = 0; k < 200; k++) {
    r = await post({ t: 'pick', sess, i: pickFn(k) });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.ok(r.answer === 0 || r.answer === 1);
    await sleep(55);
    if (!r.ok) return r;
  }
  throw new Error('too long');
}

(async () => {
  await ready;
  base = `http://127.0.0.1:${server.address().port}`;

  // 정적 파일, 상태
  assert.equal((await get('/')).status, 200);
  assert.match((await get('/')).type, /text\/html/);
  assert.equal((await get('/admin')).status, 200);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/../server.js')).status, 404);
  assert.notEqual((await get('/%2e%2e/server.js')).status, 200);
  assert.equal(JSON.parse((await get('/healthz')).body).ok, true);

  // 닉네임만으로 시작
  assert.equal((await post({ t: 'join', nick: '' })).status, 400);
  assert.equal((await post({ t: 'join', nick: '   ' })).status, 400);
  const s1 = await post({ t: 'join', nick: '<동훈>' });
  assert.equal(s1.status, 200); assert.ok(s1.sess); assert.equal(s1.me.nick, '동훈', 'html stripped');
  assert.equal((await post({ t: 'join', nick: '동훈' })).status, 409, 'nick taken');
  const sess = s1.sess;
  assert.equal((await post({ t: 'me', sess })).me.nick, '동훈');
  assert.equal((await post({ t: 'signup', username: 'abc', password: '1234', nick: 'z' })).status, 401, 'old signup gone');
  assert.equal((await post({ t: 'me', sess: 'x'.repeat(40) })).status, 401);
  assert.equal((await post({ t: 'pick', sess, i: 0 })).status, 409, 'must start first');

  // 여러 판: 정답이 무작위인지 (50% 근처), 기록이 올라가는지
  let picks = 0, wins = 0, maxFloor = 0, lastBest = 0;
  for (let g = 0; g < 60; g++) {
    const r = await playOnce(sess, k => (g + k) % 2);
    picks += r.floor + 1; wins += r.floor;
    maxFloor = Math.max(maxFloor, r.floor);
    assert.equal(r.best, maxFloor, 'best = max floor so far');
    if (r.newBest) assert.ok(r.floor > lastBest);
    lastBest = r.best;
  }
  const rate = wins / picks;
  console.log(`  ${picks}번 눌러 통과율 ${(rate * 100).toFixed(1)}%, 최고 ${maxFloor}단계`);
  assert.ok(rate > 0.35 && rate < 0.65, 'about 50%');
  let m = await post({ t: 'me', sess });
  assert.equal(m.me.best, maxFloor); assert.equal(m.me.plays, 60);
  if (maxFloor > 0) assert.equal(m.me.rank, 1);

  // 잘못된 입력
  await sleep(1100);
  await post({ t: 'start', sess });
  assert.equal((await post({ t: 'pick', sess, i: 2 })).status, 400);
  assert.equal((await post({ t: 'pick', sess, i: '0' })).status, 400);

  // 새로고침해도 도전이 이어진다
  let floorNow = 0;
  for (let k = 0; k < 50; k++) {
    const r = await post({ t: 'pick', sess, i: 0 });
    if (r.ok) { floorNow = r.floor; break; }
    await sleep(55);
    await post({ t: 'start', sess });
    await sleep(55);
  }
  assert.ok(floorNow >= 1);
  assert.equal((await post({ t: 'start', sess })).floor, floorNow, 'resume');
  m = await post({ t: 'me', sess }); assert.equal(m.me.floor, floorNow);

  // 리더보드 + 지금 도전 중
  const s2 = await post({ t: 'join', nick: '사장님' });
  assert.equal(s2.status, 200);
  await sleep(500);
  let bd = JSON.parse((await get('/api/board')).body);
  assert.equal(bd.board[0].nick, '동훈'); assert.equal(bd.board[0].best, maxFloor);
  assert.equal(bd.board.length, 1, 'no record, not on board');

  // SSE로 리더보드가 오는지
  const sse = await new Promise((resolve, reject) => {
    const req = http.get(base + '/events', res => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let raw = '';
      res.on('data', c => { raw += c; const m = raw.match(/data: (.*)\n\n/); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  assert.equal(sse.board[0].nick, '동훈');

  // 닉네임 변경이 리더보드에 반영
  assert.equal((await post({ t: 'nick', sess, nick: '사장님' })).status, 409, 'cannot take someone else nick');
  assert.equal((await post({ t: 'nick', sess, nick: '행운의동훈' })).me.nick, '행운의동훈');
  await sleep(500);
  bd = JSON.parse((await get('/api/board')).body);
  assert.equal(bd.board[0].nick, '행운의동훈');

  // 관리자 (ADMIN_KEY)
  assert.equal((await post({ t: 'adminUsers', sess })).status, 403, 'no key');
  assert.equal((await post({ t: 'adminUsers', key: 'wrong' })).status, 403, 'wrong key');
  const K = 'secret-key';
  assert.equal((await post({ t: 'adminCheck', key: K })).status, 200);
  const au = await post({ t: 'adminUsers', key: K });
  assert.equal(au.users.length, 2);
  const dh = au.users.find(x => x.nick === '행운의동훈');
  assert.equal((await post({ t: 'adminNick', key: K, id: dh.id, nick: '사장님' })).status, 409);
  assert.equal((await post({ t: 'adminBan', key: K, id: dh.id, banned: true })).status, 200);
  assert.equal((await post({ t: 'me', sess })).status, 401, 'banned → removed');
  assert.equal((await post({ t: 'join', nick: '행운의동훈' })).status, 409, 'banned nick stays reserved');
  await sleep(500);
  bd = JSON.parse((await get('/api/board')).body);
  assert.equal(bd.board.length, 0, 'banned hidden');
  await post({ t: 'adminBan', key: K, id: dh.id, banned: false });
  await post({ t: 'adminResetBest', key: K, id: dh.id });
  assert.equal((await post({ t: 'adminUsers', key: K })).users.find(x => x.id === dh.id).best, 0);

  // 연타 제한
  const s3 = await post({ t: 'join', nick: '빠름' });
  const burst = await Promise.all(Array.from({ length: 30 }, () => post({ t: 'me', sess: s3.sess })));
  assert.ok(burst.some(r => r.status === 429), 'rate limited');

  // 로그아웃
  await sleep(1100);
  assert.equal((await post({ t: 'logout', sess: s3.sess })).status, 200);
  assert.equal((await post({ t: 'me', sess: s3.sess })).status, 401);

  console.log('server ok');
  server.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
