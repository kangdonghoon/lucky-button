// The Luckiest Person in the World — 브라우저 쪽. 정답은 서버가 정하고, 여기서는 보여주기만 한다.
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
      return { status: 0, error: "Couldn't reach the server" };
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
  function renderSound() { $('soundBtn').textContent = sound ? '🔊 Sound on' : '🔇 Sound off'; }
  $('soundBtn').addEventListener('click', () => { sound = !sound; store.set('lucky_sound', sound ? null : 'off'); renderSound(); if (sound) sfx.click(); });

  // ───────── 화면 전환 ─────────
  function showAuth() {
    me = null; sess = null; store.set('lucky_sess', null);
    $('auth').hidden = false; $('game').hidden = true; $('topbar').hidden = true;
    setTimeout(() => $('aNick').focus(), 0);
    renderBoard();
  }
  function showGame() {
    $('auth').hidden = true; $('game').hidden = false; $('topbar').hidden = false;
    renderMe();
    renderBoard();
  }
  function renderMe() {
    if (!me) return;
    $('whoami').replaceChildren(document.createTextNode('Hi, '), Object.assign(document.createElement('b'), { textContent: me.nick }));
    best = Math.max(best, me.best || 0);
    renderStats();
    $('rank').textContent = me.rank ? `Leaderboard #${me.rank}` : 'No record yet';
  }
  function probText(n) {
    if (n === 0) return 'Odds 100%';
    const d = Math.pow(2, n), p = 100 / d;
    const pct = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.0001 ? p.toPrecision(2) : p.toExponential(1);
    return `Odds 1 in ${d.toLocaleString('en-US')} (${pct}%)`;
  }
  function renderStats() {
    $('floor').textContent = floor;
    $('best').textContent = best;
    $('prob').textContent = probText(floor);
  }

  // ───────── 닉네임만 정하고 시작 ─────────
  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('authBtn').disabled = true; $('authErr').textContent = '';
    const r = await api({ t: 'join', nick: $('aNick').value.trim() }, 70000);
    $('authBtn').disabled = false;
    if (!r.sess) { $('authErr').textContent = r.error || 'Please try again'; return; }
    sess = r.sess; store.set('lucky_sess', sess); me = r.me;
    showGame();
    startRun();
  });

  // 닉네임 변경
  $('nickBtn').addEventListener('click', () => { $('nickInput').value = me ? me.nick : ''; $('nickErr').textContent = ''; $('nickModal').hidden = false; $('nickInput').focus(); });
  $('nickCancel').addEventListener('click', () => { $('nickModal').hidden = true; });
  $('nickForm').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api({ t: 'nick', nick: $('nickInput').value.trim() });
    if (r.status === 401) return showAuth();
    if (!r.me) { $('nickErr').textContent = r.error || 'Please try again'; return; }
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
    d.querySelector('.txt').textContent = ok ? 'PASS' : 'FAIL';
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
    if (r.status !== 200) { setMsg(r.error || "Couldn't start. Please refresh the page", 'warn'); return; }
    floor = r.floor || 0;
    renderStats();
    setMsg(floor > 0 ? `Picking up where you left off: level ${floor}` : 'Press a button to take on level 1');
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
      setMsg(r.status === 429 ? 'Slow down a little' : (r.error || 'Connection hiccup') + ' · Press again', 'warn');
      resetDoors(); busy = false; return;
    }

    if (r.ok) {
      setReveal(picked, true);
      floor = r.floor; best = Math.max(best, r.best || 0);
      if (r.record) sfx.record(); else sfx.win();
      setMsg((r.record ? '🏆 New record! ' : ['Pass!', 'Phew!', 'Nice!', 'Keep going!', 'Lucky you!'][floor % 5] + ' ') + `→ Level ${floor}`, 'win');
      renderStats();
      $('floor').classList.remove('climb'); void $('floor').offsetWidth; $('floor').classList.add('climb');
      await wait(600);
      resetDoors(); busy = false;
    } else {
      setReveal(picked, false);
      const other = doors[1 - i];
      setReveal(other, true); other.classList.add('dim');
      sfx.lose();
      setMsg('Fail…', 'lose');
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
    $('overSub').textContent = f === 0 ? 'Out on the very first button!' : 'Final score';
    $('overScore').textContent = `Level ${f}`;
    $('overProb').textContent = f > 0 ? `You beat ${probText(f).replace('Odds ', 'odds of ')}` : 'Luck will be on your side next time';
    $('badge').classList.toggle('show', !!r.newBest);
    $('overRank').textContent = r.rank ? `Leaderboard #${r.rank} · Best: level ${r.best}` : '';
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
      e.textContent = 'No records yet. Be the first!';
      list.appendChild(e);
    }
    const medals = ['🥇', '🥈', '🥉'];
    rows.forEach((r, idx) => {
      const li = document.createElement('li');
      if (idx < 3) li.classList.add('top');
      if (me && r.id === me.id) li.classList.add('me');
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = medals[idx] || String(idx + 1);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.nick + (me && r.id === me.id ? ' (you)' : '');
      const sc = document.createElement('span'); sc.className = 'score'; sc.textContent = r.best;
      const small = document.createElement('small'); small.textContent = 'lv'; sc.appendChild(small);
      li.append(rank, name, sc);
      list.appendChild(li);
    });
    const live = board.live || [];
    $('liveBox').hidden = !live.length;
    $('liveList').replaceChildren(...live.map(x => {
      const li = document.createElement('li');
      const n = document.createElement('b'); n.textContent = x.nick;
      const f = document.createElement('span'); f.textContent = `Level ${x.floor}`;
      li.append(n, f); return li;
    }));
    $('lbStatus').textContent = `Live · ${board.online || 0} online · ${board.playing || 0} playing`;
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
    es.onerror = () => { $('lbStatus').textContent = 'Connection lost. Reconnecting…'; };
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
    const slow = setTimeout(() => setMsg('Waking up the server (up to a minute)…', 'warn'), 3000);
    $('game').hidden = false; doors.forEach(d => d.disabled = true);
    const r = await api({ t: 'me' }, 70000);
    clearTimeout(slow);
    if (!r.me) { if (r.status === 401) return showAuth(); setMsg(r.error || "Couldn't reach the server. Please refresh the page", 'warn'); return; }
    me = r.me;
    showGame();
    startRun();
  })();
})();
