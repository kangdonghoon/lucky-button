// 세상에서 제일 운이 좋은 사람 — 브라우저 쪽. 정답은 서버가 정하고, 여기서는 보여주기만 한다.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const doors = [...document.querySelectorAll('.door')];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };

  let sess = store.get('lucky_sess');
  let me = null;
  let floor = 0, best = 0;
  let busy = false, over = false;
  let board = null;
  let sound = store.get('lucky_sound') !== 'off';

  // ───────── 서버 호출 ─────────
  async function api(body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ sess }, body)), signal: ctl.signal });
      let out = {}; try { out = await r.json(); } catch (e) {}
      return { status: r.status, ...out };
    } catch (e) {
      return { status: 0, error: '서버에 연결하지 못했어요' };
    } finally { clearTimeout(timer); }
  }

  // ───────── 효과음 (파일 없이 합성) ─────────
  let ac = null;
  function tone(freqs, dur, type, vol) {
    if (!sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const t0 = ac.currentTime;
      freqs.forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type || 'sine'; o.frequency.value = f;
        const s = t0 + i * dur * 0.6;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(vol || 0.18, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
        o.connect(g).connect(ac.destination); o.start(s); o.stop(s + dur + 0.02);
      });
    } catch (e) {}
  }
  const sfx = {
    click: () => tone([520], 0.08, 'square', 0.06),
    win: () => tone([660, 880], 0.14, 'triangle', 0.16),
    lose: () => tone([300, 180], 0.25, 'sawtooth', 0.1),
    record: () => tone([660, 880, 1100, 1320], 0.14, 'triangle', 0.16),
  };
  function renderSound() { $('soundBtn').textContent = sound ? '🔊 소리 켬' : '🔇 소리 끔'; }
  $('soundBtn').addEventListener('click', () => { sound = !sound; store.set('lucky_sound', sound ? null : 'off'); renderSound(); if (sound) sfx.click(); });

  // ───────── 화면 전환 ─────────
  function showAuth() {
    me = null; sess = null; store.set('lucky_sess', null);
    $('auth').hidden = false; $('game').hidden = true; $('topbar').hidden = true;
    renderBoard();
  }
  function showGame() {
    $('auth').hidden = true; $('game').hidden = false; $('topbar').hidden = false;
    renderMe();
    renderBoard();
  }
  function renderMe() {
    if (!me) return;
    $('whoami').replaceChildren(document.createTextNode('안녕하세요, '), Object.assign(document.createElement('b'), { textContent: me.nick }), document.createTextNode(' 님'));
    $('adminLink').hidden = !me.admin;
    best = Math.max(best, me.best || 0);
    renderStats();
    $('rank').textContent = me.rank ? `리더보드 ${me.rank}위` : '아직 기록 없음';
  }
  function probText(n) {
    if (n === 0) return '확률 100%';
    const d = Math.pow(2, n), p = 100 / d;
    const pct = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.0001 ? p.toPrecision(2) : p.toExponential(1);
    return `확률 1/${d.toLocaleString()} (${pct}%)`;
  }
  function renderStats() {
    $('floor').textContent = floor;
    $('best').textContent = best;
    $('prob').textContent = probText(floor);
  }

  // ───────── 로그인 / 가입 ─────────
  let authMode = 'login';
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    authMode = t.dataset.mode;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    $('nickRow').hidden = authMode !== 'signup';
    $('aNick').required = authMode === 'signup';
    $('aPw').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
    $('authBtn').textContent = authMode === 'signup' ? '가입하고 시작' : '로그인하고 시작';
    $('authErr').textContent = '';
  }));
  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('authBtn').disabled = true; $('authErr').textContent = '';
    const r = await api({ t: authMode, username: $('aUser').value.trim(), password: $('aPw').value, nick: $('aNick').value.trim() }, 70000);
    $('authBtn').disabled = false;
    if (!r.sess) { $('authErr').textContent = r.error || '다시 시도해 주세요'; return; }
    sess = r.sess; store.set('lucky_sess', sess); me = r.me; $('aPw').value = '';
    showGame();
    startRun();
  });
  $('logoutBtn').addEventListener('click', async () => { await api({ t: 'logout' }); showAuth(); });

  // 닉네임 변경
  $('nickBtn').addEventListener('click', () => { $('nickInput').value = me ? me.nick : ''; $('nickErr').textContent = ''; $('nickModal').hidden = false; $('nickInput').focus(); });
  $('nickCancel').addEventListener('click', () => { $('nickModal').hidden = true; });
  $('nickForm').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api({ t: 'nick', nick: $('nickInput').value.trim() });
    if (r.status === 401) return showAuth();
    if (!r.me) { $('nickErr').textContent = r.error || '다시 시도해 주세요'; return; }
    me = r.me; renderMe(); $('nickModal').hidden = true;
  });

  // ───────── 게임 ─────────
  function resetDoors() {
    doors.forEach(d => {
      d.classList.remove('win', 'lose', 'dim', 'opening');
      d.disabled = false;
      d.querySelector('.ico').textContent = '';
      d.querySelector('.txt').textContent = '';
    });
  }
  function setReveal(d, ok) {
    d.classList.add(ok ? 'win' : 'lose');
    d.querySelector('.ico').textContent = ok ? '✓' : '✗';
    d.querySelector('.txt').textContent = ok ? '통과' : '실패';
  }
  function setMsg(text, cls) { $('msg').className = 'msg' + (cls ? ' ' + cls : ''); $('msg').textContent = text; }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function startRun() {
    over = false; busy = true;
    $('over').classList.remove('show');
    resetDoors(); doors.forEach(d => d.disabled = true);
    const r = await api({ t: 'start' });
    if (r.status === 401) return showAuth();
    busy = false; resetDoors();
    if (r.status !== 200) { setMsg(r.error || '시작하지 못했어요. 새로고침해 주세요', 'warn'); return; }
    floor = r.floor || 0;
    renderStats();
    setMsg(floor > 0 ? `${floor}단계에서 이어서 도전해요` : '버튼을 눌러 1단계에 도전하세요');
  }

  async function choose(i) {
    if (busy || over || !me) return;
    busy = true;
    doors.forEach(d => d.disabled = true);
    const picked = doors[i];
    picked.classList.add('opening');
    sfx.click();
    const [r] = await Promise.all([api({ t: 'pick', i }), wait(380)]);
    picked.classList.remove('opening');

    if (r.status === 401) return showAuth();
    if (r.status === 409) { await startRun(); return; }
    if (r.status !== 200) {
      setMsg(r.status === 429 ? '천천히 눌러주세요' : (r.error || '연결이 불안정해요') + ' · 다시 눌러주세요', 'warn');
      resetDoors(); busy = false; return;
    }

    if (r.ok) {
      setReveal(picked, true);
      floor = r.floor; best = Math.max(best, r.best || 0);
      if (r.record) sfx.record(); else sfx.win();
      setMsg((r.record ? '🏆 신기록! ' : ['통과!', '살았다!', '좋아요!', '계속 가자!', '운이 좋네요!'][floor % 5] + ' ') + `→ ${floor}단계`, 'win');
      renderStats();
      $('floor').classList.remove('climb'); void $('floor').offsetWidth; $('floor').classList.add('climb');
      await wait(600);
      resetDoors(); busy = false;
    } else {
      setReveal(picked, false);
      const other = doors[1 - i];
      setReveal(other, true); other.classList.add('dim');
      sfx.lose();
      setMsg('실패…', 'lose');
      $('stage').classList.remove('shake'); void $('stage').offsetWidth; $('stage').classList.add('shake');
      best = Math.max(best, r.best || 0);
      if (me) { me.best = r.best; me.rank = r.rank; }
      await wait(900);
      gameOver(r);
    }
  }

  function gameOver(r) {
    over = true; busy = false;
    const f = r.floor;
    $('overSub').textContent = f === 0 ? '첫 버튼에서 탈락!' : '최종 기록';
    $('overScore').textContent = `${f}단계`;
    $('overProb').textContent = f > 0 ? `${probText(f)}을 뚫었어요` : '다음엔 운이 따를 거예요';
    $('badge').classList.toggle('show', !!r.newBest);
    $('overRank').textContent = r.rank ? `리더보드 ${r.rank}위 · 최고 ${r.best}단계` : '';
    renderMe();
    $('over').classList.add('show');
    $('retry').focus();
  }

  doors.forEach((d, i) => d.addEventListener('click', () => choose(i)));
  $('retry').addEventListener('click', startRun);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || $('game').hidden || !$('nickModal').hidden) return;
    if (over) { if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); startRun(); } return; }
    if (e.repeat) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') choose(0);
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') choose(1);
  });

  // ───────── 리더보드 (실시간) ─────────
  function renderBoard() {
    const list = $('lbList');
    list.replaceChildren();
    if (!board) return;
    const rows = board.board || [];
    if (!rows.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = '아직 기록이 없어요. 첫 번째 주인공이 되어보세요!';
      list.appendChild(e);
    }
    const medals = ['🥇', '🥈', '🥉'];
    rows.forEach((r, idx) => {
      const li = document.createElement('li');
      if (idx < 3) li.classList.add('top');
      if (me && r.id === me.id) li.classList.add('me');
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = medals[idx] || String(idx + 1);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.nick + (me && r.id === me.id ? ' (나)' : '');
      const sc = document.createElement('span'); sc.className = 'score'; sc.textContent = r.best;
      const small = document.createElement('small'); small.textContent = '단계'; sc.appendChild(small);
      li.append(rank, name, sc);
      list.appendChild(li);
    });
    const live = board.live || [];
    $('liveBox').hidden = !live.length;
    $('liveList').replaceChildren(...live.map(x => {
      const li = document.createElement('li');
      const n = document.createElement('b'); n.textContent = x.nick;
      const f = document.createElement('span'); f.textContent = `${x.floor}단계`;
      li.append(n, f); return li;
    }));
    $('lbStatus').textContent = `실시간 반영 · 접속 ${board.online || 0}명 · 도전 중 ${board.playing || 0}명`;
  }
  function connectEvents() {
    let es;
    try { es = new EventSource('/events'); } catch (e) { return; }
    es.onmessage = ev => {
      try { board = JSON.parse(ev.data); } catch (e) { return; }
      renderBoard();
      // 순위는 리더보드가 바뀔 때 다시 받는다
      if (me && board.v !== lastBoardV) { lastBoardV = board.v; refreshMe(); }
    };
    es.onerror = () => { $('lbStatus').textContent = '연결이 끊겼어요. 다시 연결하는 중…'; };
  }
  let lastBoardV = -1, meTimer = 0;
  function refreshMe() {
    clearTimeout(meTimer);
    meTimer = setTimeout(async () => {
      if (!me || busy) return;
      const r = await api({ t: 'me' });
      if (r.me) { me = r.me; renderMe(); renderBoard(); }
    }, 300);
  }

  // ───────── 시작 ─────────
  renderSound();
  connectEvents();
  (async () => {
    if (!sess) { showAuth(); return; }
    // 무료 서버는 잠들어 있으면 깨는 데 시간이 걸린다
    const slow = setTimeout(() => setMsg('서버를 깨우는 중이에요 (최대 1분)…', 'warn'), 3000);
    $('game').hidden = false; doors.forEach(d => d.disabled = true);
    const r = await api({ t: 'me' }, 70000);
    clearTimeout(slow);
    if (!r.me) { if (r.status === 401) return showAuth(); setMsg(r.error || '서버에 연결하지 못했어요. 새로고침해 주세요', 'warn'); return; }
    me = r.me;
    showGame();
    startRun();
  })();
})();
