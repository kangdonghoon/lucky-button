// 저장소 테스트: 메모리 + (PSQL_ARGS가 있으면) 실제 Postgres
'use strict';
const assert = require('assert');
const { PgStore, MemStore } = require('../store.js');

async function run(store, label) {
  await store.init(); await store.init(); // 두 번 불러도 안전해야 함
  const a = await store.createUser({ username: 'donghun', nick: "동훈's", pwHash: 'h1', salt: 's1' });
  assert.equal(a.username, 'donghun'); assert.equal(a.best, 0); assert.equal(a.banned, false); assert.equal(a.nick, "동훈's");
  assert.equal(await store.createUser({ username: 'donghun', nick: 'x', pwHash: 'h', salt: 's' }), null, 'dup');
  assert.equal(await store.createUser({ username: 'other', nick: "동훈'S", pwHash: '', salt: '' }), null, 'dup nick (case-insensitive)');
  assert.equal(await store.nickTaken("동훈's"), true);
  assert.equal(await store.nickTaken("동훈's", a.id), false, 'own nick is fine');
  assert.equal(await store.nickTaken('없는닉'), false);
  const b = await store.createUser({ username: 'minsu', nick: '민수', pwHash: 'h2', salt: 's2' });
  const c = await store.createUser({ username: 'jiyoung', nick: '지영', pwHash: 'h3', salt: 's3' });
  assert.equal((await store.userByName('minsu')).id, b.id);
  assert.equal(await store.userByName('nobody'), null);

  // 세션
  await store.createSession('tokA', a.id, Date.now() + 60000);
  await store.createSession('tokOld', a.id, Date.now() - 1);
  assert.equal((await store.sessionUser('tokA')).id, a.id);
  assert.equal(await store.sessionUser('tokOld'), null, 'expired');
  await store.deleteSession('tokA'); assert.equal(await store.sessionUser('tokA'), null);

  // 최고 기록은 올라갈 때만
  assert.equal(await store.raiseBest(a.id, 5, 1000), true);
  assert.equal(await store.raiseBest(a.id, 3, 2000), false, 'lower does not replace');
  assert.equal(await store.raiseBest(a.id, 5, 3000), false, 'equal does not replace');
  assert.equal(await store.raiseBest(b.id, 7, 1500), true);
  assert.equal(await store.raiseBest(c.id, 5, 900), true); // 같은 5단계지만 a보다 먼저
  let u = await store.userById(a.id); assert.deepEqual([u.best, u.bestAt], [5, 1000]);

  // 리더보드: 높은 순, 같으면 먼저 달성한 순
  let top = await store.top(10);
  assert.deepEqual(top.map(r => [r.nick, r.best]), [['민수', 7], ['지영', 5], ["동훈's", 5]]);
  assert.equal(await store.rankOf(b.id), 1);
  assert.equal(await store.rankOf(c.id), 2);
  assert.equal(await store.rankOf(a.id), 3);
  assert.equal((await store.top(2)).length, 2);

  await store.recordRun(a.id, 5); await store.recordRun(a.id, 0);
  u = await store.userById(a.id); assert.deepEqual([u.plays, u.picks], [2, 5]);

  // 정지되면 리더보드에서 빠짐
  await store.setBanned(b.id, true);
  assert.equal((await store.userById(b.id)).banned, true);
  top = await store.top(10); assert.deepEqual(top.map(r => r.nick), ['지영', "동훈's"]);
  assert.equal(await store.rankOf(b.id), null);
  assert.equal(await store.rankOf(a.id), 2);
  await store.setBanned(b.id, false);

  // 기록 초기화
  await store.resetBest(b.id);
  assert.equal(await store.rankOf(b.id), null);
  assert.equal(await store.raiseBest(b.id, 1, 5000), true);

  assert.equal(await store.setNick(a.id, '새닉'), true); assert.equal((await store.userById(a.id)).nick, '새닉');
  assert.equal(await store.setNick(a.id, '민수'), false, 'taken nick'); assert.equal((await store.userById(a.id)).nick, '새닉');
  assert.equal(await store.setNick(a.id, '새닉'), true, 'same nick again');
  assert.equal((await store.listUsers('MIN')).length, 1, 'search case-insensitive');
  assert.equal((await store.listUsers()).length, 3);
  await store.createSession('tokB', a.id, Date.now() + 60000);
  await store.deleteUserSessions(a.id); assert.equal(await store.sessionUser('tokB'), null);
  await store.purgeSessions();
  console.log(label, 'ok');
}

(async () => {
  await run(new MemStore(), 'store memory');
  if (process.env.PSQL_ARGS) await run(new PgStore('x', require('./pg-shim.js')), 'store postgres');
})().catch(e => { console.error(e); process.exit(1); });
