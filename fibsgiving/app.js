/* Fibsgiving — a draw-and-bluff family party game.
 * Architecture: one Supabase row per room holds the game state (written only by the host's phone).
 * Players write their moves (drawings, fibs, votes…) into the `moves` table. Everyone listens via
 * Supabase Realtime. If the host's phone drops, the next online player takes over automatically. */
(() => {
'use strict';

const SB_URL = 'https://gqqgzndsbegiapechhnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxcWd6bmRzYmVnaWFwZWNoaG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2NzI2NjksImV4cCI6MjExMTI0ODY2OX0.crFFssUDHyzD3WSAJhNDfNQLXung2NmqaAYLQP9B1Q0';
const sb = window.supabase.createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 20 } }
});

const DECKS = window.DECKS;
const AVATARS = ['🦃','🥧','🌽','🍗','🍠','🥔','🍁','🧀','🍎','🦆','🐿️','🦉','🐻','🦊','🐶','🐱','🐸','🐷','🦄','🐔','🍩','🌮','👽','🤖'];
const REACTS = ['😂','😍','🤯','👏','🦃','🔥','💀'];
const ROUND_INFO = {
  fib:      { emoji:'🖼️', title:'Fib Frames', rules:['You get a secret, ridiculous prompt. Draw it!','Everyone else invents a fake title for your drawing.','Then find the REAL title among the fibs. Fooling people scores big.'] },
  portrait: { emoji:'👨‍👩‍👧‍👦', title:'Family Portraits', rules:['Your secret prompt stars someone playing tonight.','Draw it — be kind… ish 😇','Your fibs should star family members too!'] },
  monster:  { emoji:'🧟', title:'Frankenfeast', rules:['Three artists, one creature: head, body, legs.','You only see a tiny sliver of the part above yours.','Then we reveal each monster and vote on the best name.'] },
  thanks:   { emoji:'🧡', title:'The Thankful Wall', rules:['No points. All heart.','Write a note for the table — or for our Guest of Honor 👑','Then we read them together.'] }
};
const ROUND_ORDER = ['fib','portrait','monster','thanks'];
const PARTS = ['HEAD','BODY','LEGS'];

// ---------- utils ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
function rid(n) { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; for (const x of crypto.getRandomValues(new Uint8Array(n))) s += a[x % a.length]; return s; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const clone = o => JSON.parse(JSON.stringify(o));
const mkey = (kind, r, k, pid) => `${kind}|${r}|${k}|${pid}`;

let me = LS.get('fg_me', null);
if (!me || !me.id) me = { id: rid(12), name: '', avatar: pick(AVATARS.slice(0, 10)) };
LS.set('fg_me', me);

const params = new URLSearchParams(location.search);
const $app = document.getElementById('app');
const $fx = document.getElementById('fx');

let room = null, state = null, channel = null, spectator = false;
let online = new Set(), presenceReady = false, hostSeen = Date.now();
const mcache = new Map();  // move key -> payload
const keys = new Set();    // move keys known to exist
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

// ---------- sound / haptics / wake ----------
let actx = null, muted = LS.get('fg_mute', false), wl = null;
function tone(f, d = .12, type = 'sine', vol = .15, when = 0) {
  if (muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + when, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.001, t0 + d);
    o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + d + .05);
  } catch (e) {}
}
const SFX = {
  ding() { tone(880, .25, 'triangle'); tone(1320, .3, 'triangle', .1, .08); },
  tick() { tone(1250, .05, 'square', .04); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, .35, 'triangle', .14, i * .12)); },
  womp() { tone(330, .3, 'sawtooth', .07); tone(220, .55, 'sawtooth', .07, .25); },
  pop() { tone(500 + Math.random() * 500, .08, 'sine', .07); },
  send() { tone(660, .08, 'sine', .1); tone(990, .12, 'sine', .1, .07); }
};
async function wake() {
  try { if ('wakeLock' in navigator && !wl && document.visibilityState === 'visible') { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) {}
}
document.addEventListener('pointerdown', () => {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); else if (actx.state === 'suspended') actx.resume(); } catch (e) {}
  wake();
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); if (room) refresh(); } });

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function confetti(n = 80) {
  const cols = ['#f28c28','#c2264b','#f5c542','#5a8f3d','#3a7bd5','#fff7ea'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%'; c.style.background = pick(cols);
    c.style.animationDelay = Math.random() * 1.2 + 's'; c.style.animationDuration = 2.2 + Math.random() * 2 + 's';
    $fx.appendChild(c); setTimeout(() => c.remove(), 5000);
  }
}

// ---------- players helpers ----------
const P = pid => (state && state.players[pid]) || { name: '?', avatar: '❔', score: 0, stats: {} };
const nm = pid => `${P(pid).avatar} ${esc(P(pid).name)}`;
const face = pid => `<span title="${esc(P(pid).name)}">${P(pid).avatar}</span>`;
const faces = arr => `<span class="faces">${(arr || []).map(face).join('')}</span>`;
const vipPid = s => (s || state).order.find(p => (s || state).players[p]?.vip);
const amHost = () => state && state.host === me.id;
const joined = () => state && !!state.players[me.id];
function onlinePlayers(s = state) {
  if (!presenceReady) return s.order.slice();
  return s.order.filter(p => online.has(p) || p === me.id && !spectator);
}
const T = sec => Math.round(sec * 1000 * ((state && state.settings && state.settings.pace) || 1));
const drawerOf = (s, c, st) => s.mplayers[(c + st) % s.mplayers.length];

function expected(s = state) {
  const on = onlinePlayers(s), k = String(s.ii ?? 0);
  switch (s.phase) {
    case 'draw': return on.filter(p => s.prompts && s.prompts[p]).map(p => [p, 'drawing', '']);
    case 'fib': { const a = s.items[s.ii]; return on.filter(p => p !== a).map(p => [p, 'fib', k]); }
    case 'vote': { const a = s.items[s.ii]; return on.filter(p => p !== a).map(p => [p, 'vote', k]); }
    case 'mdraw': { const out = []; for (let c = 0; c < s.C; c++) { const p = drawerOf(s, c, s.stage); if (on.includes(p)) out.push([p, 'part', c + ':' + s.stage]); } return out; }
    case 'mname': return on.map(p => [p, 'mname', String(s.mc)]);
    case 'mvote': return on.map(p => [p, 'mvote', String(s.mc)]);
    case 'twrite': return on.map(p => [p, 'thanks', '']);
  }
  return [];
}
const isDone = (s, [p, kind, k]) => keys.has(mkey(kind, s.rc, k, p));
function allDone(s = state) { const ex = expected(s); return ex.length > 0 && ex.every(e => isDone(s, e)); }
const mine = (kind, k = '') => mcache.get(mkey(kind, state.rc, k, me.id));
const iSubmitted = (kind, k = '') => keys.has(mkey(kind, state.rc, k, me.id));

// ---------- data ----------
async function fetchRoom(code) {
  const { data, error } = await sb.from('rooms').select('code,state').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}
async function fetchMoves(r, kinds) {
  if (!room) return;
  let q = sb.from('moves').select('pid,kind,r,k,payload').eq('room', room).eq('r', r);
  if (kinds) q = q.in('kind', kinds);
  const { data, error } = await q;
  if (error) { console.warn(error); return; }
  for (const m of data) { const key = mkey(m.kind, m.r, m.k, m.pid); keys.add(key); mcache.set(key, m.payload); }
}
async function fetchKeys() {
  if (!room || !state) return;
  const { data, error } = await sb.from('moves').select('pid,kind,r,k').eq('room', room).eq('r', state.rc);
  if (error) return;
  for (const m of data) keys.add(mkey(m.kind, m.r, m.k, m.pid));
}
const wanted = new Map();
async function wantPayload(key) {
  const t = wanted.get(key) || 0;
  if (Date.now() - t < 3000) return;
  wanted.set(key, Date.now());
  const [kind, r, k, pid] = key.split('|');
  const { data } = await sb.from('moves').select('payload').eq('room', room).eq('kind', kind).eq('r', +r).eq('k', k).eq('pid', pid).maybeSingle();
  if (data) { keys.add(key); mcache.set(key, data.payload); patchLive(); }
}
async function submit(kind, k, payload, r = state.rc, tries = 0) {
  const key = mkey(kind, r, k, me.id);
  mcache.set(key, payload); keys.add(key);
  update();
  const { error } = await sb.from('moves').upsert({ room, pid: me.id, kind, r, k, payload }, { onConflict: 'room,pid,kind,r,k' });
  if (error) {
    console.warn(error);
    if (tries < 5) { toast('Connection hiccup — resending…'); setTimeout(() => submit(kind, k, payload, r, tries + 1), 1500); }
    else { keys.delete(key); toast('Could not send. Check your connection!'); update(true); }
  }
}

function onRoomRow(row, live) {
  if (!row || !row.state || !row.state.v) return;
  const s = row.state;
  if (state && s.v <= state.v) return;
  if (live && s.at && s.host !== me.id) {
    const off = s.at - Date.now() + 120;
    if (Math.abs(off - clockOffset) > 700) clockOffset = off;
  }
  const prev = state; state = s;
  onStateChanged(prev);
}
function onStateChanged(prev) {
  if (!prev || prev.rc !== state.rc) fetchMoves(state.rc);
  if (prev && (prev.phase !== state.phase || prev.ii !== state.ii || prev.stage !== state.stage || prev.mc !== state.mc)) {
    if (state.phase === 'final') { SFX.fanfare(); confetti(120); }
    else if (state.phase !== 'reveal') SFX.ding();
  }
  if (prev && !prev.players[me.id] && state.players[me.id]) SFX.ding();
  else if (prev && state.order.length > prev.order.length) {
    const fresh = state.order.filter(p => !prev.order.includes(p) && p !== me.id);
    if (fresh.length) { toast(fresh.map(p => `${P(p).avatar} ${P(p).name}`).join(', ') + ' joined the table!'); SFX.pop(); }
  }
  update();
  if (amHost()) hostKick();
}
function onMoveRow(m) {
  if (!m || !m.kind) return;
  const key = mkey(m.kind, m.r, m.k, m.pid);
  keys.add(key);
  if (m.payload && Object.keys(m.payload).length) mcache.set(key, m.payload);
  if (amHost()) hostKick();
  patchLive();
}
async function refresh() {
  if (!room) return;
  try { const row = await fetchRoom(room); if (row) onRoomRow(row, false); } catch (e) {}
  await fetchKeys();
  if (amHost()) await fetchMoves(0, ['join']);
  update();
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('room:' + room, { config: { presence: { key: me.id }, broadcast: { self: true } } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'code=eq.' + room }, p => onRoomRow(p.new, true))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'moves', filter: 'room=eq.' + room }, p => onMoveRow(p.new))
    .on('broadcast', { event: 'react' }, ({ payload }) => showReact(payload))
    .on('presence', { event: 'sync' }, () => {
      online = new Set(Object.keys(channel.presenceState()));
      if (!spectator) online.add(me.id);
      presenceReady = true;
      patchLive();
      if (amHost()) hostKick();
    })
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') { await channel.track({ spectator, t: Date.now() }); refresh(); }
    });
}

// ---------- entering ----------
async function createRoom() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 8; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), x => L[x % L.length]).join('');
    const s = {
      v: 1, at: Date.now(), host: me.id, phase: 'lobby', rc: 0, ri: -1,
      players: { [me.id]: newPlayer(me) }, order: [me.id],
      settings: { pace: 1, rounds: ROUND_ORDER.slice() },
      history: [], mhistory: []
    };
    const { error } = await sb.from('rooms').insert({ code, state: s });
    if (!error) return enterRoom(code, false);
    if (error.code !== '23505') { toast('Could not create a room: ' + error.message, 4000); return; }
  }
}
function newPlayer(p) { return { name: String(p.name || 'Guest').trim().slice(0, 16) || 'Guest', avatar: p.avatar || '🦃', score: 0, vip: false, stats: {} }; }

async function enterRoom(code, asSpectator) {
  code = code.toUpperCase().trim();
  let row;
  try { row = await fetchRoom(code); } catch (e) { toast('Network trouble — try again'); return; }
  if (!row) { toast(`No game found with code ${code}`); return; }
  room = code; spectator = !!asSpectator; state = null;
  hostSeen = Date.now();
  onRoomRow(row, false);
  const q = new URLSearchParams({ room: code }); if (spectator) q.set('tv', '1');
  history.replaceState(null, '', location.pathname + '?' + q.toString());
  subscribe();
  if (!spectator && !state.players[me.id]) submit('join', '', { name: me.name, avatar: me.avatar }, 0);
  await fetchMoves(state.rc);
  update(true);
}

// ---------- HOST ENGINE ----------
let committing = false, ticking = false, tickV = null, kickTimer = null, lastJoinFetch = 0;
function hostKick() { clearTimeout(kickTimer); kickTimer = setTimeout(hostTick, 150); }
async function commit(mut) {
  if (committing || !state) return false;
  if (tickV != null && state.v !== tickV) return false; // state moved on while this tick was thinking
  committing = true;
  try {
    const base = state, next = clone(base);
    mut(next);
    next.v = base.v + 1; next.at = now();
    const { data, error } = await sb.from('rooms').update({ state: next, updated_at: new Date().toISOString() })
      .eq('code', room).eq('state->>v', String(base.v)).select('code');
    if (error) { console.warn(error); return false; }
    if (!data || !data.length) { committing = false; await refresh(); return false; }
    if (state.v === base.v) { state = next; committing = false; onStateChanged(base); }
    return true;
  } finally { committing = false; }
}

async function hostTick() {
  if (!state || !amHost() || committing || ticking) return;
  ticking = true; tickV = state.v;
  try { await hostStep(); } catch (e) { console.warn(e); } finally { ticking = false; tickV = null; }
}
async function hostStep() {
  const s = state, t = now();
  if (Date.now() - lastJoinFetch > 6000) { lastJoinFetch = Date.now(); fetchMoves(0, ['join']); }
  // admit newcomers
  const pend = [];
  for (const [key, p] of mcache) if (key.startsWith('join|')) { const pid = key.split('|')[3]; if (!s.players[pid]) pend.push([pid, p]); }
  if (pend.length) { await commit(n => { for (const [pid, p] of pend) { n.players[pid] = newPlayer(p); if (!n.order.includes(pid)) n.order.push(pid); } }); return; }

  const timeUp = s.deadline && t > s.deadline;
  const late = s.deadline && t > s.deadline + 2500;
  const ready = late || allDone(s);
  switch (s.phase) {
    case 'roundintro': if (timeUp) await beginRound(); break;
    case 'draw': if (ready) await afterDraw(); break;
    case 'fib': if (ready) await afterFib(); break;
    case 'vote': if (ready) await afterVote(); break;
    case 'reveal': if (timeUp) await nextItem(); break;
    case 'leaderboard': if (timeUp) await commit(nextRound); break;
    case 'mdraw': if (ready) await afterStage(); break;
    case 'mname': if (ready) await afterMname(); break;
    case 'mvote': if (ready) await afterMvote(); break;
    case 'mreveal': if (timeUp) await nextCreature(); break;
    case 'twrite': if (ready) await afterTwrite(); break;
    case 'tshow': if (timeUp) await commit(nextRound); break;
  }
}

function resetRoundFields(n) {
  n.prompts = {}; n.items = []; n.ii = 0; n.options = null; n.reveal = null;
  n.mplayers = []; n.C = 0; n.stage = 0; n.mc = 0; n.themes = []; n.mopts = null; n.mreveal = null; n.mtitles = [];
  n.notes = null;
}
function nextRound(n) {
  n.ri += 1; n.rc += 1;
  resetRoundFields(n);
  n.prevScores = Object.fromEntries(n.order.map(p => [p, n.players[p].score]));
  if (n.ri >= n.settings.rounds.length) {
    n.phase = 'final'; n.deadline = null; n.awards = computeAwards(n); n.phaseAt = now();
    return;
  }
  n.roundType = n.settings.rounds[n.ri];
  n.phase = 'roundintro'; n.phaseAt = now(); n.deadline = now() + 9000;
}
function toLeaderboard(n) { n.phase = 'leaderboard'; n.phaseAt = now(); n.deadline = now() + 12000; }

async function beginRound() {
  const s = state, players = onlinePlayers(s), t = now();
  const type = s.roundType;
  if (type === 'fib') {
    const used = new Set(s.usedFib || []), prompts = {};
    for (const p of players) {
      let pool = DECKS.fib.map((_, i) => i).filter(i => !used.has(i));
      if (!pool.length) { used.clear(); pool = DECKS.fib.map((_, i) => i); }
      const i = pick(pool); used.add(i); prompts[p] = DECKS.fib[i];
    }
    await commit(n => { n.prompts = prompts; n.usedFib = [...used]; n.phase = 'draw'; n.phaseAt = t; n.deadline = t + T(90); });
  } else if (type === 'portrait') {
    const sh = shuffle(players), prompts = {};
    const used = new Set(s.usedPor || []);
    sh.forEach((p, i) => {
      const A = sh.length > 1 ? sh[(i + 1) % sh.length] : p;
      const others = sh.filter(x => x !== A && x !== p);
      const B = others.length ? pick(others) : null;
      let pool = DECKS.portrait.map((_, j) => j).filter(j => !used.has(j) && (B || !DECKS.portrait[j].includes('{B}')));
      if (!pool.length) pool = DECKS.portrait.map((_, j) => j).filter(j => B || !DECKS.portrait[j].includes('{B}'));
      const j = pick(pool); used.add(j);
      prompts[p] = DECKS.portrait[j].replaceAll('{A}', s.players[A].name).replaceAll('{B}', B ? s.players[B].name : '');
    });
    await commit(n => { n.prompts = prompts; n.usedPor = [...used]; n.phase = 'draw'; n.phaseAt = t; n.deadline = t + T(90); });
  } else if (type === 'monster') {
    const mp = shuffle(players), C = Math.min(mp.length, 6);
    const themes = shuffle(DECKS.monster).slice(0, C);
    await commit(n => { n.mplayers = mp; n.C = C; n.themes = themes; n.stage = 0; n.mtitles = []; n.phase = 'mdraw'; n.phaseAt = t; n.deadline = t + T(75); });
  } else if (type === 'thanks') {
    await commit(n => { n.phase = 'twrite'; n.phaseAt = t; n.deadline = t + T(100); });
  } else {
    await commit(nextRound);
  }
}

async function afterDraw() {
  await fetchKeys();
  const s = state, rc = s.rc;
  const items = shuffle(s.order.filter(p => s.prompts[p] && keys.has(mkey('drawing', rc, '', p))));
  await commit(n => {
    if (!items.length) return toLeaderboard(n);
    n.items = items; n.ii = 0; n.phase = 'fib'; n.phaseAt = now(); n.deadline = now() + T(45); n.options = null; n.reveal = null;
  });
}
function houseDecoys(s, count, avoid) {
  const out = [];
  for (let tries = 0; out.length < count && tries < 60; tries++) {
    let text;
    if (s.roundType === 'portrait') {
      const A = pick(s.order), others = s.order.filter(x => x !== A), B = others.length ? pick(others) : null;
      const tpl = pick(DECKS.portrait.filter(x => B || !x.includes('{B}')));
      text = tpl.replaceAll('{A}', s.players[A].name).replaceAll('{B}', B ? s.players[B].name : '');
    } else text = pick(DECKS.fib);
    if (!avoid.has(norm(text))) { avoid.add(norm(text)); out.push(text); }
  }
  return out;
}
async function afterFib() {
  await fetchMoves(state.rc, ['fib']);
  const s = state, artist = s.items[s.ii], truth = s.prompts[artist], nt = norm(truth), k = String(s.ii);
  const groups = new Map();
  for (const p of s.order) {
    if (p === artist) continue;
    const f = mcache.get(mkey('fib', s.rc, k, p));
    if (!f || !f.text) continue;
    const text = String(f.text).trim().slice(0, 80), n = norm(text);
    if (!n || n === nt) continue;
    if (groups.has(n)) groups.get(n).authors.push(p); else groups.set(n, { id: 'f_' + p, text, authors: [p] });
  }
  const options = [{ id: 'T', text: truth, authors: [artist] }, ...groups.values()];
  const avoid = new Set(options.map(o => norm(o.text)).concat(Object.values(s.prompts).map(norm)));
  houseDecoys(s, Math.max(0, 3 - options.length), avoid).forEach((text, i) => options.push({ id: 'h' + i, text, authors: [] }));
  await commit(n => { n.options = shuffle(options); n.phase = 'vote'; n.phaseAt = now(); n.deadline = now() + T(30); });
}
async function afterVote() {
  await fetchMoves(state.rc, ['vote']);
  const s = state, artist = s.items[s.ii], k = String(s.ii), vip = vipPid(s);
  const opts = s.options.map(o => ({ ...o, pickers: [], likers: [] }));
  const byId = Object.fromEntries(opts.map(o => [o.id, o]));
  const deltas = {}, st = {};
  const add = (p, v) => { deltas[p] = (deltas[p] || 0) + v; };
  const stat = (p, key) => { (st[p] = st[p] || {})[key] = (st[p][key] || 0) + 1; };
  for (const voter of s.order) {
    if (voter === artist) continue;
    const v = mcache.get(mkey('vote', s.rc, k, voter));
    if (!v) continue;
    const o = byId[v.choice];
    if (o && !o.authors.includes(voter)) {
      o.pickers.push(voter);
      if (o.id === 'T') { add(voter, 1000); add(artist, 500); stat(voter, 'correct'); stat(artist, 'seen'); }
      else for (const a of o.authors) { add(a, 500); stat(a, 'fooled'); }
    }
    for (const lid of (v.likes || [])) {
      const lo = byId[lid];
      if (!lo || lo.authors.includes(voter) || lo.likers.includes(voter)) continue;
      lo.likers.push(voter);
      for (const a of lo.authors) { add(a, voter === vip ? 300 : 100); stat(a, 'likes'); }
    }
  }
  const seq = opts.map((o, i) => i).filter(i => opts[i].id !== 'T' && opts[i].pickers.length).sort((a, b) => opts[a].pickers.length - opts[b].pickers.length);
  seq.push(opts.findIndex(o => o.id === 'T'));
  const best = opts.filter(o => o.id !== 'T' && o.authors.length).sort((a, b) => (b.pickers.length + b.likers.length) - (a.pickers.length + a.likers.length))[0];
  const dur = (seq.length * 2.8 + 6.5) * 1000;
  await commit(n => {
    for (const [p, d] of Object.entries(deltas)) if (n.players[p]) n.players[p].score += d;
    for (const [p, o] of Object.entries(st)) if (n.players[p]) for (const [kk, v] of Object.entries(o)) n.players[p].stats[kk] = (n.players[p].stats[kk] || 0) + v;
    n.reveal = { opts, seq, deltas };
    n.history.push({ r: n.rc, type: n.roundType, artist, prompt: s.prompts[artist], best: best ? best.text : null, bestBy: best ? best.authors : [] });
    n.phase = 'reveal'; n.phaseAt = now(); n.deadline = now() + dur;
  });
}
async function nextItem() {
  await commit(n => {
    if (n.ii + 1 < n.items.length) { n.ii += 1; n.phase = 'fib'; n.phaseAt = now(); n.deadline = now() + T(45); n.options = null; n.reveal = null; }
    else toLeaderboard(n);
  });
}
async function afterStage() {
  await commit(n => {
    if (n.stage < 2) { n.stage += 1; n.phaseAt = now(); n.deadline = now() + T(75); }
    else { n.phase = 'mname'; n.mc = 0; n.mopts = null; n.mreveal = null; n.phaseAt = now(); n.deadline = now() + T(40); }
  });
}
async function afterMname() {
  await fetchMoves(state.rc, ['mname']);
  const s = state, k = String(s.mc), groups = new Map();
  for (const p of s.order) {
    const f = mcache.get(mkey('mname', s.rc, k, p));
    if (!f || !f.text) continue;
    const text = String(f.text).trim().slice(0, 60), n = norm(text);
    if (!n) continue;
    if (groups.has(n)) groups.get(n).authors.push(p); else groups.set(n, { id: 'n_' + p, text, authors: [p] });
  }
  const opts = [...groups.values()];
  const avoid = new Set(opts.map(o => norm(o.text)));
  for (const nmx of shuffle(DECKS.monsterNames)) { if (opts.length >= 2) break; if (!avoid.has(norm(nmx))) opts.push({ id: 'h' + opts.length, text: nmx, authors: [] }); }
  await commit(n => { n.mopts = shuffle(opts); n.phase = 'mvote'; n.phaseAt = now(); n.deadline = now() + T(25); });
}
async function afterMvote() {
  await fetchMoves(state.rc, ['mvote']);
  const s = state, k = String(s.mc);
  const opts = s.mopts.map(o => ({ ...o, voters: [] })), byId = Object.fromEntries(opts.map(o => [o.id, o]));
  const deltas = {};
  for (const p of s.order) {
    const v = mcache.get(mkey('mvote', s.rc, k, p));
    const o = v && byId[v.choice];
    if (o && !o.authors.includes(p)) { o.voters.push(p); for (const a of o.authors) deltas[a] = (deltas[a] || 0) + 500; }
  }
  const top = Math.max(...opts.map(o => o.voters.length));
  const win = opts.find(o => o.voters.length === top) || opts[0];
  await commit(n => {
    for (const [p, d] of Object.entries(deltas)) if (n.players[p]) n.players[p].score += d;
    for (const o of opts) for (const a of o.authors) if (n.players[a] && o.voters.length) n.players[a].stats.mvotes = (n.players[a].stats.mvotes || 0) + o.voters.length;
    n.mtitles[n.mc] = win.text;
    n.mreveal = { opts, win: win.id, deltas };
    n.mhistory.push({ r: n.rc, c: n.mc, theme: n.themes[n.mc], title: win.text, drawers: [0, 1, 2].map(st => drawerOf(n, n.mc, st)) });
    n.phase = 'mreveal'; n.phaseAt = now(); n.deadline = now() + 9500;
  });
}
async function nextCreature() {
  await commit(n => {
    if (n.mc + 1 < n.C) { n.mc += 1; n.phase = 'mname'; n.mopts = null; n.mreveal = null; n.phaseAt = now(); n.deadline = now() + T(40); }
    else toLeaderboard(n);
  });
}
async function afterTwrite() {
  await fetchMoves(state.rc, ['thanks']);
  const s = state;
  const notes = s.order.map(p => ({ pid: p, text: (mcache.get(mkey('thanks', s.rc, '', p)) || {}).text })).filter(x => x.text && x.text.trim());
  await commit(n => {
    if (!notes.length) return nextRound(n);
    n.notes = notes.map(x => ({ pid: x.pid, text: String(x.text).slice(0, 280) }));
    n.phase = 'tshow'; n.phaseAt = now(); n.deadline = now() + notes.length * 7000 + 1500;
  });
}
function computeAwards(n) {
  const AW = [
    ['fooled', '🎭', 'Master Fibber', 'fooled the family {n}×'],
    ['correct', '🔍', 'Truth Detective', 'spotted the truth {n}×'],
    ['likes', '❤️', 'Crowd Favorite', 'collected {n} heart(s)'],
    ['seen', '🎨', 'Clearest Artist', '{n} people got their drawings right'],
    ['mvotes', '🧟', 'Monster Namer', 'won {n} name votes']
  ];
  const out = [];
  const vip = vipPid(n);
  if (vip) out.push({ ic: '👑', title: 'Guest of Honor', pid: vip, desc: 'the reason we’re all here tonight 🧡' });
  for (const [st, ic, title, desc] of AW) {
    let best = null, bv = 0;
    for (const p of n.order) { const v = (n.players[p].stats || {})[st] || 0; if (v > bv) { bv = v; best = p; } }
    if (best) out.push({ ic, title, pid: best, desc: desc.replace('{n}', bv).replace('(s)', bv === 1 ? '' : 's') });
  }
  return out;
}
// host controls
async function hostCommit(mut) {
  for (let i = 0; i < 8; i++) { if (!committing && !ticking && await commit(mut)) return true; await new Promise(r => setTimeout(r, 250)); }
  toast('Hmm, that didn’t go through — tap again');
  return false;
}
const hostActions = {
  start() { hostCommit(nextRound); },
  skip() { hostCommit(n => { if (n.deadline) n.deadline = now(); }); },
  more() { hostCommit(n => { if (n.deadline) n.deadline = Math.max(n.deadline, now()) + 30000; }); },
  again() { hostCommit(n => { for (const p of n.order) { n.players[p].score = 0; n.players[p].stats = {}; } n.ri = -1; n.phase = 'lobby'; n.deadline = null; resetRoundFields(n); }); },
  vip(pid) { hostCommit(n => { const was = n.players[pid].vip; for (const p of n.order) n.players[p].vip = false; n.players[pid].vip = !was; }); },
  round(r) { hostCommit(n => { const rs = n.settings.rounds; n.settings.rounds = rs.includes(r) ? rs.filter(x => x !== r) : ROUND_ORDER.filter(x => rs.includes(x) || x === r); }); },
  pace(v) { hostCommit(n => { n.settings.pace = +v; }); }
};

// host failover: if host vanishes, the first online player in join order takes over
async function failoverCheck() {
  if (!state || spectator || !joined() || !presenceReady || amHost()) { hostSeen = Date.now(); return; }
  if (online.has(state.host)) { hostSeen = Date.now(); return; }
  if (Date.now() - hostSeen < 9000) return;
  const cand = state.order.filter(p => online.has(p));
  if (cand[0] !== me.id) return;
  hostSeen = Date.now();
  await refresh();
  if (online.has(state.host) || amHost()) return;
  const ok = await commit(n => { n.host = me.id; });
  if (ok) { toast('📡 The host dropped — you are now hosting!', 3500); await fetchMoves(0, ['join']); await fetchMoves(state.rc); hostKick(); }
}

// ---------- reactions ----------
let lastReact = 0;
function sendReact(e) {
  if (!channel || Date.now() - lastReact < 220) return;
  lastReact = Date.now();
  channel.send({ type: 'broadcast', event: 'react', payload: { e, pid: me.id } });
}
function showReact({ e, pid }) {
  if (!REACTS.includes(e)) return;
  const el = document.createElement('div'); el.className = 'floater';
  el.style.left = (8 + Math.random() * 78) + '%'; el.style.setProperty('--dx', (Math.random() * 90 - 45) + 'px');
  const p = state && state.players[pid];
  el.innerHTML = e + (p ? `<small>${esc(p.name)}</small>` : '');
  $fx.appendChild(el); setTimeout(() => el.remove(), 3000);
  SFX.pop();
}

// ---------- drawing pad ----------
let pad = null;
const COLORS = ['#2b1a12','#ffffff','#c2264b','#f28c28','#f5c542','#5a8f3d','#3a7bd5','#8e44ad','#8b5a2b','#f7a8c4','#f1c27d','#7f8c8d'];
function makePad(canvas, w, h) {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  let strokes = [], cur = null, color = COLORS[0], size = 8, erase = false, bgc = '#ffffff';
  const fill = () => { ctx.fillStyle = bgc; ctx.fillRect(0, 0, w, h); };
  function drawStroke(s) {
    if (s.bg) { bgc = s.bg; return; }
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = s.s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const p = s.p;
    if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], s.s / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    const l = p[p.length - 1]; ctx.lineTo(l[0], l[1]); ctx.stroke();
  }
  function redraw() { bgc = '#ffffff'; strokes.filter(s => s.bg).forEach(drawStroke); fill(); strokes.filter(s => !s.bg).forEach(drawStroke); }
  fill();
  const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * w / r.width, (e.clientY - r.top) * h / r.height]; };
  // iOS Safari: touch-action alone isn't always honored, so block the native scroll/zoom gesture explicitly
  const block = e => { if (e.cancelable) e.preventDefault(); };
  ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange'].forEach(t => canvas.addEventListener(t, block, { passive: false }));
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
    cur = { c: erase ? bgc : color, s: erase ? size * 2.5 : size, p: [pos(e)] }; strokes.push(cur); drawStroke(cur);
  });
  canvas.addEventListener('pointermove', e => {
    if (!cur) return; e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const pe of (evs.length ? evs : [e])) {
      const a = cur.p[cur.p.length - 1], b = pos(pe);
      cur.p.push(b);
      ctx.strokeStyle = cur.c; ctx.lineWidth = cur.s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  });
  const end = () => { cur = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('pointerleave', end);
  return {
    setColor(c) { color = c; erase = false; }, setSize(s) { size = s; }, setErase(v) { erase = v; },
    get erase() { return erase; }, get color() { return color; }, get size() { return size; },
    bucket() { strokes.push({ bg: color }); redraw(); },
    undo() { strokes.pop(); redraw(); }, clear() { strokes = []; redraw(); },
    get empty() { return strokes.length === 0; },
    toData() { return canvas.toDataURL('image/jpeg', 0.82); },
    // test hook
    _scribble() { for (let i = 0; i < 6; i++) { const p = []; for (let j = 0; j < 12; j++) p.push([Math.random() * w, Math.random() * h]); strokes.push({ c: pick(COLORS), s: 6 + Math.random() * 12, p }); } redraw(); }
  };
}
function toolsHTML() {
  return `<div class="swatches">
    ${COLORS.map((c, i) => `<div class="sw${i === 0 ? ' sel' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
  </div>
  <div class="tools">
    ${[4, 9, 18, 32].map((s, i) => `<div class="sz${i === 1 ? ' sel' : ''}" data-size="${s}"><i style="width:${Math.min(s, 24)}px;height:${Math.min(s, 24)}px"></i></div>`).join('')}
    <button class="tool" data-tool="erase" aria-label="Eraser">🧽</button>
    <button class="tool" data-tool="bucket" aria-label="Fill background">🪣</button>
    <button class="tool" data-tool="undo" aria-label="Undo">↩️</button>
    <button class="tool" data-tool="clear" aria-label="Clear">🗑️</button>
  </div>`;
}
function wirePad(w, h) {
  const cv = document.getElementById('pad');
  if (!cv) { pad = null; return; }
  pad = makePad(cv, w, h);
  window.__pad = pad;
  $app.querySelectorAll('[data-color]').forEach(el => el.onclick = () => {
    pad.setColor(el.dataset.color);
    $app.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('sel', x === el));
    $app.querySelector('[data-tool=erase]').classList.remove('sel');
  });
  $app.querySelectorAll('[data-size]').forEach(el => el.onclick = () => {
    pad.setSize(+el.dataset.size);
    $app.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('sel', x === el));
  });
  $app.querySelector('[data-tool=erase]').onclick = e => { pad.setErase(!pad.erase); e.currentTarget.classList.toggle('sel', pad.erase); };
  $app.querySelector('[data-tool=bucket]').onclick = () => pad.bucket();
  $app.querySelector('[data-tool=undo]').onclick = () => pad.undo();
  $app.querySelector('[data-tool=clear]').onclick = () => { if (pad.empty || confirm('Clear your whole drawing?')) pad.clear(); };
}
let sendingArt = false;
async function sendArt(auto) {
  if (!pad || sendingArt) return;
  const s = state;
  let kind = 'drawing', k = '';
  if (s.phase === 'mdraw') {
    const c = myCreature(); if (c < 0) return;
    kind = 'part'; k = c + ':' + s.stage;
  } else if (s.phase !== 'draw') return;
  if (iSubmitted(kind, k)) return;
  if (!auto && pad.empty && !confirm('Your canvas is empty! Send it anyway?')) return;
  sendingArt = true;
  try { SFX.send(); await submit(kind, k, { img: pad.toData() }); if (auto) toast('⏰ Time! Your drawing was sent.'); }
  finally { sendingArt = false; }
}
function myCreature() {
  const s = state, idx = s.mplayers.indexOf(me.id), N = s.mplayers.length;
  if (idx < 0) return -1;
  const c = ((idx - s.stage) % N + N) % N;
  return c < s.C ? c : -1;
}

// ---------- rendering ----------
let lastKey = null;
function viewKey() {
  if (!room) return 'home';
  if (!state) return 'loading';
  if (!joined() && !spectator) return 'knock';
  const s = state, base = [s.phase, s.rc, s.ii, s.stage, s.mc].join('|');
  switch (s.phase) {
    case 'lobby': return base + JSON.stringify([s.order.map(p => [p, s.players[p].vip]), s.settings, amHost()]);
    case 'draw': return base + iSubmitted('drawing');
    case 'fib': return base + iSubmitted('fib', String(s.ii));
    case 'vote': return base + JSON.stringify(mine('vote', String(s.ii)) || null);
    case 'reveal': return base + revealStep();
    case 'mdraw': return base + iSubmitted('part', myCreature() + ':' + s.stage);
    case 'mname': return base + iSubmitted('mname', String(s.mc));
    case 'mvote': return base + JSON.stringify(mine('mvote', String(s.mc)) || null);
    case 'twrite': return base + iSubmitted('thanks');
    case 'tshow': return base + noteIndex();
    case 'final': return base + amHost();
  }
  return base;
}
function update(force) {
  const k = viewKey();
  if (force || k !== lastKey) { lastKey = k; render(); }
  patchLive();
}
const revealStep = () => { const s = state; if (!s.reveal) return 0; return Math.min(Math.floor((now() - s.phaseAt) / 2800) + 1, s.reveal.seq.length + 1); };
const noteIndex = () => { const s = state; if (!s.notes) return 0; return Math.min(Math.floor((now() - s.phaseAt) / 7000), s.notes.length - 1); };

function setHTML(el, html) { if (el && el.__h !== html) { el.__h = html; el.innerHTML = html; } }

function roundLabel() {
  const s = state;
  if (s.phase === 'lobby') return 'Lobby';
  if (s.phase === 'final') return 'Finale';
  const info = ROUND_INFO[s.roundType];
  return `R${s.ri + 1}/${s.settings.rounds.length} · ${info ? info.title : ''}`;
}
function shell(main, opts = {}) {
  const reacts = opts.noReact ? '' : `<div class="reactbar">${REACTS.map(e => `<button data-react="${e}">${e}</button>`).join('')}</div>`;
  return `<div class="topbar">
      <span class="chip code">${esc(room)}</span>
      <span class="chip">${esc(roundLabel())}</span>
      <span class="timer hidden" id="timer"></span>
      <button class="iconbtn" id="mute" aria-label="Sound">${muted ? '🔇' : '🔊'}</button>
    </div>
    <div id="hostctl"></div>
    <div id="main">${main}</div>${reacts}`;
}
function artHTML(pid, r = state.rc, kind = 'drawing', k = '', extra = '') {
  return `<div class="art ${extra}"><img alt="" width="600" height="${kind === 'part' ? 400 : 600}" style="height:auto" data-mv="${mkey(kind, r, k, pid)}"></div>`;
}
function creatureHTML(c, r = state.rc, s = state) {
  return `<div class="art creature">${[0, 1, 2].map(st => `<img alt="" width="600" height="400" style="height:auto" data-mv="${mkey('part', r, c + ':' + st, drawerOf(s, c, st))}">`).join('')}</div>`;
}

function render() {
  const k = lastKey;
  if (k === 'home') return renderHome();
  if (k === 'loading') { $app.innerHTML = `<div class="center-screen"><div class="big-emoji bob">🦃</div><p>Loading…</p></div>`; return; }
  if (k === 'knock') {
    $app.innerHTML = `<div class="center-screen"><div class="big-emoji bob">🚪</div><h2>Knocking on the door…</h2>
      <p>${nm(state.host)} will let you in any second.</p><p class="tiny">Room ${esc(room)}</p></div>`;
    return;
  }
  const s = state, ph = s.phase;
  let html = '', opts = {};
  const V = VIEWS[ph];
  if (V) { const r = V(s); html = r.html; opts = r; }
  $app.innerHTML = shell(html, opts);
  pad = null;
  if (opts.after) opts.after();
  wireCommon();
}
function wireCommon() {
  const m = document.getElementById('mute');
  if (m) m.onclick = () => { muted = !muted; LS.set('fg_mute', muted); m.textContent = muted ? '🔇' : '🔊'; if (!muted) SFX.ding(); };
  $app.querySelectorAll('[data-react]').forEach(b => b.onclick = () => sendReact(b.dataset.react));
  $app.querySelectorAll('[data-host]').forEach(b => b.onclick = () => hostActions[b.dataset.host](b.dataset.arg));
}

function waitingHTML() {
  const ex = expected();
  if (!ex.length) return '';
  const done = ex.filter(e => isDone(state, e)).length;
  return `<div class="center tiny mt">${done}/${ex.length} done</div><div class="waiting">${ex.map(e => `<div class="wface${isDone(state, e) ? ' done' : ''}" title="${esc(P(e[0]).name)}">${P(e[0]).avatar}</div>`).join('')}</div>`;
}

let lastTickSec = null;
function patchLive() {
  if (!state || !room) return;
  // timer
  const tm = document.getElementById('timer');
  if (tm) {
    const timed = ['draw', 'fib', 'vote', 'mdraw', 'mname', 'mvote', 'twrite'].includes(state.phase) && state.deadline;
    if (timed) {
      const left = Math.max(0, Math.ceil((state.deadline - now()) / 1000));
      tm.classList.remove('hidden');
      const txt = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : String(left);
      if (tm.textContent !== txt) tm.textContent = txt;
      tm.classList.toggle('hurry', left <= 5);
      if (left <= 5 && left > 0 && lastTickSec !== left) { lastTickSec = left; SFX.tick(); }
    } else tm.classList.add('hidden');
  }
  // host controls
  const hc = document.getElementById('hostctl');
  if (hc) {
    let h = '';
    if (amHost() && !['lobby', 'final'].includes(state.phase)) {
      h = `<div class="hostbar"><span class="chip">👑 You're hosting</span><button class="btn small ghost" data-host="more">+30s</button><button class="btn small ghost" data-host="skip">⏭ Skip</button></div>`;
    }
    if (hc.__h !== h) { setHTML(hc, h); hc.querySelectorAll('[data-host]').forEach(b => b.onclick = () => hostActions[b.dataset.host](b.dataset.arg)); }
  }
  setHTML(document.getElementById('wait'), waitingHTML());
  const pl = document.getElementById('plist');
  if (pl) {
    setHTML(pl, state.order.map(p => {
      const pp = state.players[p], off = presenceReady && !online.has(p);
      return `<div class="pl${pp.vip ? ' vip' : ''}${off ? ' off' : ''}" data-pid="${p}">${pp.vip ? '<span class="crown">👑</span>' : ''}<span class="em">${pp.avatar}</span><span class="nm">${esc(pp.name)}${p === state.host ? ' <span class="tiny">host</span>' : ''}</span><span class="dot"></span></div>`;
    }).join(''));
    if (amHost()) pl.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => hostActions.vip(el.dataset.pid));
  }
  // images
  document.querySelectorAll('img[data-mv]').forEach(img => {
    const key = img.dataset.mv, p = mcache.get(key);
    if (p && p.img) { if (img.getAttribute('src') !== p.img) img.src = p.img; }
    else wantPayload(key);
  });
  const vc = document.getElementById('lobbycount');
  if (vc) vc.textContent = state.order.length;
}

// ----- views -----
const VIEWS = {
  lobby(s) {
    const link = joinLink();
    const host = amHost();
    const qr = qrSVG(link);
    const rounds = ROUND_ORDER.map(r => `<button class="${s.settings.rounds.includes(r) ? 'on' : ''}" ${host ? `data-host="round" data-arg="${r}"` : 'disabled'}>${ROUND_INFO[r].emoji} ${ROUND_INFO[r].title}</button>`).join('');
    const paces = [[0.75, '⚡ Speedy'], [1, '🙂 Normal'], [1.5, '🐢 Relaxed']].map(([v, l]) => `<button class="${s.settings.pace === v ? 'on' : ''}" ${host ? `data-host="pace" data-arg="${v}"` : 'disabled'}>${l}</button>`).join('');
    const est = Math.round(estimateMinutes(s));
    const waitCard = host
      ? `<div class="card soft center"><b>🛋️ Waiting Room</b><br>Everyone who opens your link shows up below. Start whenever the crew is here!</div>`
      : `<div class="card center"><div class="big-emoji bob">🛋️</div><h2>You're in the Waiting Room!</h2><p>${nm(s.host)} will start the game soon. Grab a plate 🍽️</p></div>`;
    const codeCard = `<div class="card center">
        <div class="tiny" style="color:var(--muted)">ROOM CODE</div>
        <div class="roomcode">${esc(room)}</div>
        <div class="mt"><span class="qr">${qr}</span></div>
        <p class="tiny" style="color:var(--muted)">Scan, or send the link to anyone joining from far away 💌</p>
        <button class="btn green" id="share">📲 Send invite link</button>
      </div>`;
    return { html: `
      <div class="center"><div class="logo">Fibsgiving</div><p class="tag">Draw it. Fib it. Find the truth.</p></div>
      ${waitCard}
      ${host || spectator ? codeCard : ''}
      <div class="card">
        <div class="row"><h3 class="grow">🛋️ In the Waiting Room (<span id="lobbycount">${s.order.length}</span>)</h3></div>
        <div id="plist" class="plist"></div>
        <p class="tiny" style="color:var(--muted)">${host ? 'Tap a player to crown them 👑 <b>Guest of Honor</b> — their hearts are worth triple.' : '👑 = Guest of Honor'}</p>
      </div>
      <div class="card stack">
        <label class="lbl">Rounds</label><div class="toggle">${rounds}</div>
        <label class="lbl">Pace</label><div class="toggle">${paces}</div>
        <p class="tiny" style="color:var(--muted)">About ${est} minutes with ${s.order.length} player${s.order.length === 1 ? '' : 's'}.</p>
      </div>
      ${host ? `<button class="btn" data-host="start" ${s.settings.rounds.length ? '' : 'disabled'}>🍽️ Start the feast!</button>
        ${s.order.length < 3 ? '<p class="center tiny">Best with 3+ players — but you can start anytime.</p>' : ''}`
      : (spectator ? '' : codeCard.replace('class="card center"', 'class="card center" style="opacity:.9"'))}
      ${spectator ? '<p class="center tiny">📺 TV mode — this screen just watches.</p>' : ''}`,
      after() { const b = document.getElementById('share'); if (b) b.onclick = () => shareLink(link); }
    };
  },
  roundintro(s) {
    const info = ROUND_INFO[s.roundType];
    return { html: `<div class="intro"><div class="big-emoji bob">${info.emoji}</div><div class="phase-title">Round ${s.ri + 1}</div><h1>${info.title}</h1>
      <ul class="rules">${info.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` };
  },
  draw(s) {
    const prompt = s.prompts[me.id];
    if (spectator || !prompt) return { html: `<div class="center-screen"><div class="big-emoji bob">🎨</div><h2>Artists at work…</h2>${!spectator ? '<p>You joined mid-round — you’ll draw next round! Cheer them on 👇</p>' : ''}<div id="wait"></div></div>` };
    if (iSubmitted('drawing')) return { html: `<div class="center-screen"><div class="big-emoji">🖼️</div><h2>Masterpiece delivered!</h2><p>Waiting for the other artists…</p><div id="wait"></div></div>` };
    return {
      noReact: true,
      html: `<div class="secret"><small>🤫 Your secret prompt — don't say it out loud!</small>${esc(prompt)}</div>
        <div class="drawzone sq"><div class="canvas-wrap"><canvas id="pad"></canvas></div></div>
        ${toolsHTML()}
        <button class="btn" id="sendArt">✅ Send my masterpiece</button>`,
      after() { wirePad(600, 600); document.getElementById('sendArt').onclick = () => sendArt(false); }
    };
  },
  fib(s) {
    const artist = s.items[s.ii], k = String(s.ii);
    let body;
    if (artist === me.id) body = `<div class="card soft center"><h3>This one's yours! 🤫</h3><p>Keep a straight face while everyone writes fake titles.</p></div><div id="wait"></div>`;
    else if (spectator) body = `<div class="card soft center">Players are writing fibs…</div><div id="wait"></div>`;
    else if (iSubmitted('fib', k)) body = `<div class="card soft center"><h3>Fib locked in 😈</h3><p>Now wait for everyone else…</p></div><div id="wait"></div>`;
    else body = `<div class="card"><label class="lbl">Write a fake title so convincing they'll pick it:</label>
        <input class="txt" id="fibIn" maxlength="70" autocomplete="off" placeholder="e.g. ${esc(pick(['Uncle Ron discovers yoga','A potato on vacation','The gravy strikes back']))}">
        <button class="btn mt" id="fibGo">😈 Lock in my fib</button></div><div id="wait"></div>`;
    return {
      html: `<div class="phase-title">Drawing ${s.ii + 1} of ${s.items.length}</div><div class="prompt"><small>What is this?</small></div>${artHTML(artist)}${body}`,
      after() {
        const go = document.getElementById('fibGo'); if (!go) return;
        const inp = document.getElementById('fibIn');
        const sendFib = () => {
          const v = inp.value.trim(); if (!v) { inp.focus(); return; }
          const truth = s.prompts[artist], nt = norm(truth), nv = norm(v);
          if (nv === nt || (nt.length > 6 && nv.includes(nt))) { toast('😱 That’s basically the REAL title! Write a different fib.', 3200); inp.select(); return; }
          SFX.send(); submit('fib', k, { text: v.slice(0, 70) });
        };
        go.onclick = sendFib; inp.onkeydown = e => { if (e.key === 'Enter') sendFib(); };
      }
    };
  },
  vote(s) {
    const artist = s.items[s.ii], k = String(s.ii);
    const cur = mine('vote', k) || { choice: null, likes: [] };
    const canVote = !spectator && artist !== me.id && joined();
    const optsHTML = s.options.map(o => {
      const isMine = o.authors.includes(me.id) && o.id !== 'T';
      const sel = cur.choice === o.id, liked = (cur.likes || []).includes(o.id);
      return `<div class="opt${sel ? ' sel' : ''}${isMine ? ' mine' : ''}">
        <div class="t" data-vote="${o.id}">${esc(o.text)}${isMine ? ' <span class="tiny">(your fib)</span>' : ''}</div>
        ${canVote && !isMine ? `<button class="heart${liked ? ' on' : ''}" data-like="${o.id}" aria-label="like">❤️</button>` : ''}
      </div>`;
    }).join('');
    const msg = artist === me.id ? '🤐 Your drawing! Watch them squirm.' : (canVote ? (cur.choice ? 'Locked in! You can change your pick until time runs out. Tap ❤️ for fibs you love.' : 'Tap the title you think is REAL. ❤️ the funny ones!') : '');
    return {
      html: `<div class="phase-title">Drawing ${s.ii + 1} of ${s.items.length}</div><div class="prompt"><small>Find the truth</small></div>
        ${artHTML(artist)}<p class="center">${msg}</p><div class="opts">${optsHTML}</div><div id="wait"></div>`,
      after() {
        if (!canVote) return;
        $app.querySelectorAll('[data-vote]').forEach(el => el.onclick = () => {
          const o = s.options.find(x => x.id === el.dataset.vote);
          if (!o || (o.authors.includes(me.id) && o.id !== 'T')) { toast("You can't vote for your own fib 😏"); return; }
          SFX.pop(); submit('vote', k, { ...cur, choice: o.id });
        });
        $app.querySelectorAll('[data-like]').forEach(el => el.onclick = () => {
          const id = el.dataset.like, likes = new Set(cur.likes || []);
          likes.has(id) ? likes.delete(id) : likes.add(id);
          SFX.pop(); submit('vote', k, { ...cur, likes: [...likes] });
        });
      }
    };
  },
  reveal(s) {
    const artist = s.items[s.ii], rv = s.reveal, step = revealStep(), vip = vipPid(s);
    if (!rv) return { html: '' };
    const cards = rv.seq.slice(0, step).map(i => {
      const o = rv.opts[i], truth = o.id === 'T';
      const likes = o.likers.length ? `<div class="meta">❤️ ${o.likers.length}${vip && o.likers.includes(vip) ? ` · 👑 ${esc(P(vip).name)} loved this!` : ''}</div>` : '';
      if (truth) return `<div class="rv truth"><span class="pts">${o.pickers.length ? '+1000 each' : ''}</span><div class="t">“${esc(o.text)}” <span class="stamp ok">THE TRUTH</span></div>
        <div class="meta">Drawn by ${nm(artist)} · ${o.pickers.length ? 'Spotted by ' + faces(o.pickers) : 'Nobody got it! 😱'}</div>${likes}</div>`;
      const by = o.authors.length ? o.authors.map(nm).join(' & ') : 'the House 🏠';
      return `<div class="rv"><span class="pts">${o.authors.length ? '+' + 500 * o.pickers.length : ''}</span><div class="t">“${esc(o.text)}” <span class="stamp">FIB</span></div>
        <div class="meta">Written by ${by} · fooled ${faces(o.pickers)}</div>${likes}</div>`;
    }).join('');
    let summary = '';
    if (step > rv.seq.length) {
      const ds = Object.entries(rv.deltas).sort((a, b) => b[1] - a[1]);
      const unpicked = rv.opts.filter(o => o.id !== 'T' && !o.pickers.length && o.authors.length);
      summary = `<div class="card"><b>Points this drawing</b><div class="mt">${ds.length ? ds.map(([p, d]) => `<div class="row"><span class="grow">${nm(p)}</span><b style="color:var(--green)">+${d}</b></div>`).join('') : 'No points this time!'}</div>
        ${unpicked.length ? `<p class="tiny">Nobody fell for: ${unpicked.map(o => `“${esc(o.text)}”`).join(', ')}</p>` : ''}</div>`;
    }
    return {
      html: `<div class="phase-title">The big reveal</div>${artHTML(artist)}${cards}${summary}`,
      after() {
        const lastIdx = rv.seq[step - 1];
        if (step <= rv.seq.length && lastIdx != null) {
          const o = rv.opts[lastIdx];
          if (o.id === 'T') { SFX.fanfare(); if (o.pickers.includes(me.id)) confetti(40); } else SFX.womp();
        }
        const cardsEl = $app.querySelectorAll('.rv'); if (cardsEl.length) cardsEl[cardsEl.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
  },
  leaderboard(s) {
    const rows = s.order.slice().sort((a, b) => s.players[b].score - s.players[a].score);
    const last = s.ri + 1 >= s.settings.rounds.length;
    return { html: `<div class="center"><div class="big-emoji">🏆</div><h2>${last ? 'Final standings coming up…' : `After round ${s.ri + 1}`}</h2></div>
      ${rows.map((p, i) => { const d = s.players[p].score - ((s.prevScores || {})[p] || 0); return `<div class="lb-row" style="animation-delay:${i * 0.08}s"><span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span><span class="em">${P(p).avatar}</span><span class="nm">${esc(P(p).name)}${P(p).vip ? ' 👑' : ''}</span><span><span class="sc">${s.players[p].score}</span>${d ? `<span class="dl">+${d}</span>` : ''}</span></div>`; }).join('')}` };
  },
  mdraw(s) {
    const c = myCreature(), st = s.stage;
    if (spectator || c < 0) return { html: `<div class="center-screen"><div class="big-emoji bob">🧟</div><h2>Monsters under construction…</h2><p>Part ${st + 1} of 3: the ${PARTS[st]}s</p>${!spectator ? '<p>You’re on a snack break this stage 🥧</p>' : ''}<div id="wait"></div></div>` };
    if (iSubmitted('part', c + ':' + st)) return { html: `<div class="center-screen"><div class="big-emoji">🧩</div><h2>${PARTS[st].toLowerCase()} delivered!</h2><p>${st < 2 ? 'Next up: you’ll continue someone else’s creature.' : 'Get ready to meet the monsters…'}</p><div id="wait"></div></div>` };
    const theme = s.themes[c];
    const guide = st < 2 ? `<div class="guide-line" style="top:85%"></div><div class="guide-label" style="top:calc(85% + 4px)">next artist only sees below this line ↓</div>` : '';
    const strip = st > 0 ? `<div class="strip-wrap" style="aspect-ratio:10/1"><img alt="" width="600" height="400" style="position:absolute;bottom:0;left:0;width:100%;height:auto" data-mv="${mkey('part', s.rc, c + ':' + (st - 1), drawerOf(s, c, st - 1))}"></div>` : '';
    const how = ['Draw the HEAD (and neck). Let the neck lines run off the bottom edge!', 'Draw the BODY. Connect to the lines peeking in at the top! Let the legs-attachment spots run off the bottom.', 'Draw the LEGS / feet / tail. Connect to the lines at the top!'][st];
    return {
      noReact: true,
      html: `<div class="secret"><small>Part ${st + 1} of 3 · secret creature</small>${PARTS[st]} of ${esc(theme)}</div>
        <p class="center tiny">${how}</p>
        <div class="drawzone wide">${strip}<div class="canvas-wrap"><canvas id="pad"></canvas>${guide}</div></div>
        ${toolsHTML()}
        <button class="btn" id="sendArt">✅ Send my ${PARTS[st].toLowerCase()}</button>`,
      after() { wirePad(600, 400); document.getElementById('sendArt').onclick = () => sendArt(false); }
    };
  },
  mname(s) {
    const k = String(s.mc);
    let body;
    if (spectator) body = '<div class="card soft center">Players are naming this beast…</div>';
    else if (iSubmitted('mname', k)) body = '<div class="card soft center"><h3>Name submitted 🏷️</h3></div>';
    else body = `<div class="card"><label class="lbl">Give this creature its official name:</label>
      <input class="txt" id="mIn" maxlength="50" autocomplete="off" placeholder="e.g. Sir Gravington the Damp"><button class="btn mt" id="mGo">🏷️ Name it!</button></div>`;
    return {
      html: `<div class="phase-title">Creature ${s.mc + 1} of ${s.C}</div><div class="prompt"><small>Meet the monster!</small></div>${creatureHTML(s.mc)}
        <p class="center tiny">Drawn by ${[0, 1, 2].map(st => nm(drawerOf(s, s.mc, st))).join(' + ')} · secretly “${esc(s.themes[s.mc])}”</p>${body}<div id="wait"></div>`,
      after() {
        const go = document.getElementById('mGo'); if (!go) return;
        const inp = document.getElementById('mIn');
        const send = () => { const v = inp.value.trim(); if (!v) return inp.focus(); SFX.send(); submit('mname', k, { text: v.slice(0, 50) }); };
        go.onclick = send; inp.onkeydown = e => { if (e.key === 'Enter') send(); };
      }
    };
  },
  mvote(s) {
    const k = String(s.mc), cur = mine('mvote', k) || {};
    const can = !spectator && joined();
    return {
      html: `<div class="phase-title">Creature ${s.mc + 1} of ${s.C}</div><div class="prompt"><small>Vote for the best name</small></div>${creatureHTML(s.mc)}
        <div class="opts">${s.mopts.map(o => { const isMine = o.authors.includes(me.id); return `<div class="opt${cur.choice === o.id ? ' sel' : ''}${isMine ? ' mine' : ''}"><div class="t" data-mvote="${o.id}">${esc(o.text)}${isMine ? ' <span class="tiny">(yours)</span>' : ''}</div></div>`; }).join('')}</div><div id="wait"></div>`,
      after() {
        if (!can) return;
        $app.querySelectorAll('[data-mvote]').forEach(el => el.onclick = () => {
          const o = s.mopts.find(x => x.id === el.dataset.mvote);
          if (o.authors.includes(me.id)) return toast("Can't vote for your own name 😏");
          SFX.pop(); submit('mvote', k, { choice: o.id });
        });
      }
    };
  },
  mreveal(s) {
    const rv = s.mreveal, win = rv && (rv.opts.find(o => o.id === rv.win) || rv.opts[0]);
    if (!win) return { html: '<div class="center-screen"><div class="big-emoji bob">🧟</div></div>' };
    const others = rv.opts.filter(o => o.id !== rv.win).sort((a, b) => b.voters.length - a.voters.length);
    return {
      html: `<div class="phase-title">Creature ${s.mc + 1} of ${s.C}</div>${creatureHTML(s.mc)}
        <div class="rv truth center"><div class="tiny">Officially named</div><div class="t" style="font-size:28px">“${esc(win.text)}”</div>
        <div class="meta">${win.authors.length ? 'by ' + win.authors.map(nm).join(' & ') : 'by the House 🏠'} · ${win.voters.length} vote${win.voters.length === 1 ? '' : 's'} ${faces(win.voters)}</div></div>
        ${others.map(o => `<div class="rv"><div class="t" style="font-size:18px">“${esc(o.text)}”</div><div class="meta">${o.authors.map(nm).join(' & ') || 'House'} · ${o.voters.length} ${faces(o.voters)}</div></div>`).join('')}`,
      after() { SFX.fanfare(); }
    };
  },
  twrite(s) {
    const vip = vipPid(s);
    let body;
    if (spectator) body = '<div class="card soft center">Everyone is writing their notes… 🧡</div>';
    else if (iSubmitted('thanks')) body = '<div class="card soft center"><h3>Note pinned to the wall 📌</h3><p>Waiting on the others…</p></div>';
    else body = `<div class="card"><label class="lbl">${vip ? `Write a note for the table — or for ${esc(P(vip).name)} 👑` : 'Write a note for the table — something you’re thankful for'}</label>
      <textarea class="txt" id="tIn" rows="4" maxlength="280" placeholder="I'm thankful for…"></textarea><button class="btn mt" id="tGo">📌 Pin it to the wall</button></div>`;
    return {
      html: `<div class="center"><div class="big-emoji">🧡</div><h2>The Thankful Wall</h2></div>${body}<div id="wait"></div>`,
      after() { const go = document.getElementById('tGo'); if (go) go.onclick = () => { const v = document.getElementById('tIn').value.trim(); if (!v) return; SFX.send(); submit('thanks', '', { text: v.slice(0, 280) }); }; }
    };
  },
  tshow(s) {
    const i = noteIndex(), n = s.notes && s.notes[i];
    if (!n) return { html: '<div class="center-screen"><div class="big-emoji bob">🧡</div></div>' };
    return { html: `<div class="center"><div class="phase-title">The Thankful Wall · ${i + 1} of ${s.notes.length}</div></div>
      <div class="note mt">${esc(n.text).replace(/\n/g, '<br>')}<div class="from">— ${nm(n.pid)}</div></div>
      <p class="center tiny mt">Send some love with the buttons below 👇</p>`, after() { SFX.ding(); } };
  },
  final(s) {
    const rows = s.order.slice().sort((a, b) => s.players[b].score - s.players[a].score);
    const top = rows.slice(0, 3), order = [top[1], top[0], top[2]];
    const hts = { 0: 90, 1: 130, 2: 65 };
    const pod = order.map(p => { if (!p) return '<div class="pod"></div>'; const i = rows.indexOf(p); return `<div class="pod p${i + 1}"><div class="em">${P(p).avatar}</div><div><b>${esc(P(p).name)}</b></div><div class="bar" style="height:${hts[i === 0 ? 1 : i === 1 ? 0 : 2]}px">${['🥇', '🥈', '🥉'][i]}<br>${s.players[p].score}</div></div>`; }).join('');
    return { html: `<div class="center"><div class="logo">What a feast!</div></div>
      <div class="podium">${pod}</div>
      <h3>🏅 Awards</h3>${(s.awards || []).map(a => `<div class="award"><span class="ic">${a.ic}</span><div><b>${esc(a.title)}</b><div>${nm(a.pid)} — ${esc(a.desc)}</div></div></div>`).join('')}
      <h3 class="mt">Full scores</h3>${rows.map((p, i) => `<div class="lb-row"><span class="rank">${i + 1}</span><span class="em">${P(p).avatar}</span><span class="nm">${esc(P(p).name)}</span><span class="sc">${s.players[p].score}</span></div>`).join('')}
      <a class="btn green mt" style="display:block;text-align:center;text-decoration:none;margin-top:16px" href="?gallery=${esc(room)}" target="_blank">🖼️ Open the Keepsake Gallery</a>
      ${amHost() ? '<button class="btn alt mt" style="margin-top:12px" data-host="again">🔁 Play again (same crew)</button>' : ''}` };
  }
};

function estimateMinutes(s) {
  const n = Math.max(2, s.order.length), p = s.settings.pace || 1;
  let m = 0;
  for (const r of s.settings.rounds) {
    if (r === 'fib' || r === 'portrait') m += (90 * p + n * (45 * p * .8 + 30 * p * .7 + 3 * n + 6)) / 60 + .5;
    else if (r === 'monster') m += (3 * 75 * p + Math.min(n, 6) * (40 * p * .8 + 25 * p * .8 + 9.5)) / 60 + .5;
    else if (r === 'thanks') m += (100 * p + n * 7) / 60;
  }
  return m;
}
function joinLink() { return location.origin + location.pathname + '?room=' + room; }
function qrSVG(text) { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { return ''; } }
async function shareLink(link) {
  const data = { title: 'Join our Fibsgiving game!', text: `🦃 Join our Thanksgiving drawing game! Room code ${room}`, url: link };
  try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(link); toast('Link copied! Paste it in a text 💌'); } catch (e) { prompt('Copy this link:', link); }
}

// ---------- home ----------
function renderHome() {
  const code = (params.get('room') || '').toUpperCase();
  $app.innerHTML = `
    <div class="center" style="padding-top:4vh"><div class="big-emoji bob">🦃</div><div class="logo">Fibsgiving</div>
      <p class="tag">The draw-it, fib-it, find-the-truth family game.<br>Everyone plays on their own phone — near or far.</p></div>
    <div class="card stack">
      <div><label class="lbl">Your name</label><input class="txt" id="nm" maxlength="16" autocomplete="nickname" placeholder="Grandma Rosa" value="${esc(me.name)}"></div>
      <div><label class="lbl">Pick your avatar</label><div class="avatars">${AVATARS.map(a => `<div class="av-opt${a === me.avatar ? ' sel' : ''}" data-av="${a}">${a}</div>`).join('')}</div></div>
    </div>
    <div class="card stack">
      <label class="lbl">Joining a game?</label>
      <input class="txt code" id="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocomplete="off" autocapitalize="characters">
      <button class="btn" id="join">🚪 Join game</button>
      ${code ? '' : `<div class="center tiny" style="color:var(--muted)">— or —</div><button class="btn alt" id="create">🍽️ Host a new game</button>`}
      <button class="btn ghost small" style="width:100%;color:var(--muted)" id="tv">📺 Watch on a TV / laptop (no playing)</button>
    </div>
    <div class="card soft">
      <b>How it works</b>
      <ol style="margin:6px 0 0;padding-left:20px;line-height:1.5">
        <li>Everyone draws a secret, silly prompt.</li>
        <li>For each drawing, the others invent fake titles.</li>
        <li>Find the real one. Fool your family to score!</li>
        <li>Plus: family portraits, a mix-and-match monster round, and a Thankful Wall finale.</li>
      </ol>
    </div>`;
  $app.querySelectorAll('[data-av]').forEach(el => el.onclick = () => { me.avatar = el.dataset.av; $app.querySelectorAll('[data-av]').forEach(x => x.classList.toggle('sel', x === el)); });
  const save = () => { const n = document.getElementById('nm').value.trim(); if (!n) { toast('Type your name first 🙂'); document.getElementById('nm').focus(); return false; } me.name = n.slice(0, 16); LS.set('fg_me', me); return true; };
  const codeVal = () => document.getElementById('code').value.trim().toUpperCase();
  document.getElementById('join').onclick = () => { if (!save()) return; if (codeVal().length !== 4) return toast('Enter the 4-letter room code'); enterRoom(codeVal(), false); };
  const cr = document.getElementById('create'); if (cr) cr.onclick = () => { if (save()) createRoom(); };
  document.getElementById('tv').onclick = () => { if (codeVal().length !== 4) return toast('Enter the room code to watch'); enterRoom(codeVal(), true); };
}

// ---------- gallery ----------
async function showGallery(code) {
  document.body.classList.add('wide');
  $app.innerHTML = `<div class="center-screen"><div class="big-emoji bob">🖼️</div><p>Hanging the paintings…</p></div>`;
  const row = await fetchRoom(code).catch(() => null);
  if (!row) { $app.innerHTML = `<div class="center-screen"><h2>No gallery for ${esc(code)}</h2></div>`; return; }
  state = row.state; room = code;
  const { data } = await sb.from('moves').select('pid,kind,r,k,payload').eq('room', code).in('kind', ['drawing', 'part', 'thanks']);
  for (const m of data || []) mcache.set(mkey(m.kind, m.r, m.k, m.pid), m.payload);
  const img = (key, w = 600, h = 600) => { const p = mcache.get(key); return p && p.img ? `<img alt="" width="${w}" height="${h}" style="height:auto" src="${p.img}">` : ''; };
  const s = state;
  const uniq = (arr, f) => { const seen = new Set(); return (arr || []).filter(x => { const k = f(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const arts = uniq(s.history, x => x.r + ':' + x.artist).map(hh => {
    const im = img(mkey('drawing', hh.r, '', hh.artist)); if (!im) return '';
    return `<div class="art">${im}<div class="cap"><b>“${esc(hh.prompt)}”</b><span>by ${nm(hh.artist)}${hh.best ? ` · best fib: “${esc(hh.best)}”` : ''}</span></div></div>`;
  }).join('');
  const mons = uniq(s.mhistory, x => x.r + ':' + x.c).map(m => `<div class="art"><div class="creature">${m.drawers.map((d, st) => img(mkey('part', m.r, m.c + ':' + st, d), 600, 400)).join('')}</div>
    <div class="cap"><b>“${esc(m.title)}”</b><span>${esc(m.theme)} · by ${m.drawers.map(nm).join(' + ')}</span></div></div>`).join('');
  const notes = [];
  for (const [key, p] of mcache) if (key.startsWith('thanks|') && p.text) notes.push([key.split('|')[3], p.text]);
  $app.innerHTML = `<div class="center"><div class="logo">Keepsake Gallery</div><p class="tag">Fibsgiving · room ${esc(code)} · ${new Date(row.state.at || Date.now()).toLocaleDateString()}</p>
      <p class="tiny">Long-press (or right-click) any picture to save it 💾</p></div>
    ${arts ? `<h2>🖼️ Masterpieces</h2><div class="gal">${arts}</div>` : ''}
    ${mons ? `<h2 class="mt">🧟 Frankenfeast Creatures</h2><div class="gal">${mons}</div>` : ''}
    ${notes.length ? `<h2 class="mt">🧡 The Thankful Wall</h2><div class="gal">${notes.map(([p, t]) => `<div class="note">${esc(t).replace(/\n/g, '<br>')}<div class="from">— ${nm(p)}</div></div>`).join('')}</div>` : ''}
    ${!arts && !mons && !notes.length ? '<div class="card soft center">Nothing here yet — go play a round!</div>' : ''}
    <p class="center mt"><a class="btn small ghost" href="?room=${esc(code)}" style="text-decoration:none">← Back to the game</a></p>`;
}

// ---------- main loop ----------
let lastFail = 0, lastKeys = 0;
setInterval(() => {
  if (!room || !state) return;
  update();
  // auto-submit right before the buzzer
  const s = state, left = s.deadline ? s.deadline - now() : Infinity;
  if (left < 1200 && joined()) {
    if ((s.phase === 'draw' || s.phase === 'mdraw') && pad) sendArt(true);
    const auto = [['fib', 'fibIn', 'fib', String(s.ii), 70], ['mname', 'mIn', 'mname', String(s.mc), 50], ['twrite', 'tIn', 'thanks', '', 280]];
    for (const [ph, id, kind, k, max] of auto) {
      if (s.phase !== ph) continue;
      const el = document.getElementById(id);
      if (el && el.value.trim() && !iSubmitted(kind, k)) {
        if (ph === 'fib') { const nt = norm(s.prompts[s.items[s.ii]]); if (norm(el.value) === nt) continue; }
        submit(kind, k, { text: el.value.trim().slice(0, max) });
      }
    }
  }
  if (Date.now() - lastKeys > 4000) { lastKeys = Date.now(); fetchKeys().then(() => patchLive()); }
  if (Date.now() - lastFail > 2000) { lastFail = Date.now(); failoverCheck(); }
  if (amHost()) hostTick();
}, 300);
// safety net in case realtime misses an update
setInterval(() => { if (room && state && document.visibilityState === 'visible') fetchRoom(room).then(r => r && onRoomRow(r, false)).catch(() => {}); }, 8000);

// ---------- boot ----------
window.__fg = { get state() { return state; }, get me() { return me; }, get pad() { return pad; }, hostActions, submit, keys, mcache, get online() { return online; } };
if (params.get('gallery')) showGallery(params.get('gallery').toUpperCase());
else {
  const code = (params.get('room') || '').toUpperCase();
  if (code && params.get('tv')) enterRoom(code, true);
  else if (code) {
    // returning player? jump straight back in
    fetchRoom(code).then(row => { if (row && row.state.players && row.state.players[me.id]) enterRoom(code, false); else renderHome(); }).catch(renderHome);
  } else renderHome();
}
})();
