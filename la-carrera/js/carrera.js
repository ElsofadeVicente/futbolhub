/* ══════════════════════════════════════════════
   LA CARRERA — carrera.js
   Juego diario y offline: adivina el futbolista por
   su carrera club a club. Todo se monta en el
   navegador desde datos locales (offline).
   ══════════════════════════════════════════════ */
'use strict';

// ── Rutas locales (mismo origen → cacheable offline) ──
// Los datos pesados (players/transfers/performances) viven en Supabase Storage
// (bucket player-db), igual que el resto de juegos; los meses de La Carrera en
// game-data/la-carrera. Se leen con sbStorageUrl (js/supabase-config.js).
const CREST_BASE  = 'https://tmssl.akamaized.net/images/wappen/head/';

const STATS_KEY   = 'carrera_stats';
const TODAY_KEY   = 'carrera_today';

// ── Normalización (igual que En el Top / Coche) ──
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Fecha en Madrid ──
function getTodayMadrid() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
}
function getMsUntilMadridMidnight() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(new Date());
  let h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const s = parseInt(parts.find(p => p.type === 'second').value);
  if (h === 24) h = 0;
  const elapsed = h * 3600 + m * 60 + s;
  return Math.max(0, (86400 - elapsed) * 1000);
}
function formatCountdown(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Temporadas → año ──
function seasonStartYear(s) {
  s = String(s || '');
  if (/^\d{4}$/.test(s)) return +s;
  const m = s.match(/(\d{2})\/(\d{2})/);
  if (m) { const yy = +m[1]; return yy >= 50 ? 1900 + yy : 2000 + yy; }
  const y = s.match(/\d{4}/); return y ? +y[0] : 0;
}
function seasonEndYear(s) {
  s = String(s || '');
  if (/^\d{4}$/.test(s)) return +s;
  const m = s.match(/(\d{2})\/(\d{2})/);
  if (m) { const zz = +m[2]; return zz >= 50 ? 1900 + zz : 2000 + zz; }
  const y = s.match(/\d{4}/); return y ? +y[0] : 0;
}

// ══════════════════════════════════════════════
//  CARGA DE DATOS (Supabase Storage)
// ══════════════════════════════════════════════
function uniformChunkFile(id) {
  const lo = Math.floor(id / 100000) * 100000;
  return `${lo}-${lo + 99999}.json`;
}
async function fetchJson(url, cache = 'no-cache') {
  const r = await fetch(url, { cache });
  if (!r.ok) throw new Error(`HTTP ${r.status} → ${url}`);
  return r.json();
}
// players / transfers: chunks uniformes de 100k → el archivo se calcula del ID.
async function loadFromUniform(kind, id) {
  try {
    const d = await fetchJson(sbStorageUrl('player-db', `${kind}/chunks/${uniformChunkFile(id)}`));
    return d[String(id)] || null;
  } catch { return null; }
}
// performances: rangos irregulares → se localiza el chunk con el manifest.
async function loadPerformances(id, manifest) {
  const range = (manifest.ranges || []).find(r => id >= r.min && id <= r.max);
  if (!range) return null;
  try {
    const d = await fetchJson(sbStorageUrl('player-db', `performances/chunks/${range.file}`));
    return d[String(id)] || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  CONSTRUIR LA CARRERA (runtime)
//  Une performances (partidos/goles por equipo) con
//  transfers (id de club + cesión) por solape de
//  temporadas. Escudo = id del club.
// ══════════════════════════════════════════════
function careerTokens(s) {
  return norm(s).split(' ').filter(t => t.length >= 2);
}

// ── Reglas de filiales y juveniles ──
// Juveniles / sub-19 / U18 / academias: NUNCA entran.
const _YOUTH_RE = /\b(u-?\s?(1[3-9]|2[0-3])|sub-?\s?\d{1,2}|under\s?\d{2}|youth|yth|jugend|juvenil(es)?|primavera|nachwuchs|cantera|academy)\b/;
function isYouth(name) { return _YOUTH_RE.test(norm(name)); }

// Filial / equipo B / II / Castilla / Atlètic / reservas / amateurs.
function isReserve(name) {
  const n = norm(name);
  if (/\bii\b/.test(n) || / b$/.test(n) || / c$/.test(n)) return true;
  if (/\b(castilla|atletic|reserves?|amateure?|bis)\b/.test(n)) return true;
  return false;
}
// Tokens "distintivos" del club (fuera palabras genéricas y marcas de filial).
const _CLUB_STOP = new Set(['fc','cf','ac','as','sc','sv','ss','us','ud','cd','rc','afc','sd','cp','ca',
  'de','la','el','real','club','calcio','the','ii','b','c','castilla','atletic','reserves','reserve','amateure','amateur','bis']);
function distinctiveTokens(name) {
  return careerTokens(name).filter(t => !_CLUB_STOP.has(t) && t.length >= 4);
}
// ¿el filial y el club siguiente son el mismo club (promoción al primer equipo)?
function samesClub(reserveName, otherName) {
  const a = new Set(distinctiveTokens(reserveName));
  for (const t of distinctiveTokens(otherName)) if (a.has(t)) return true;
  return false;
}

// ── Método nuevo: usa el ID de club de performances (tid) + mainClubId (m) ──
// Etapas desde transfers (orden/límites), partidos/goles/escudo/nombre desde
// performances. Separa etapas distintas en el mismo club (Kaká, Ronaldo) y da
// el escudo correcto siempre. Si los datos aún no traen tid, usa el respaldo.
function buildCareer(transfersArr, perfArr) {
  if (!perfArr || !perfArr.length) return [];
  if (!perfArr.some(r => r.tid)) return buildCareerLegacy(transfersArr, perfArr);

  // 1) Etapas desde transfers (Transfer/Loan), de la más antigua a la más nueva
  const stints = [];
  const tr = transfersArr || [];
  for (let i = tr.length - 1; i >= 0; i--) {
    const m = tr[i];
    if (m.type !== 'Transfer' && m.type !== 'Loan') continue;
    const tid = String(m.tid);
    if (tid === '123' || tid === '515' || !m.tid) continue;   // Retirado / Sin club
    stints.push({ tid, start: seasonStartYear(m.s) || (m.d ? +String(m.d).slice(0, 4) : 0),
                  loan: m.type === 'Loan', app: 0, g: 0, seasons: new Set() });
  }

  // 2) Agregar performances por (temporada, tid); nombre y parent(m) por tid
  const byKey = new Map();
  const tidInfo = new Map();
  for (const r of perfArr) {
    if (!r.tid) continue;
    const tid = String(r.tid);
    const season = seasonStartYear(r.s);
    const k = season + '|' + tid;
    if (!byKey.has(k)) byKey.set(k, { season, tid, app: 0, g: 0 });
    const o = byKey.get(k); o.app += (r.app || 0); o.g += (r.g || 0);
    if (!tidInfo.has(tid)) tidInfo.set(tid, { name: r.tn || ('#' + tid), m: r.m ? String(r.m) : null });
  }

  // 3) Asignar cada (temporada,tid) a su etapa; lo que no case → sintéticas
  const unmatched = new Map();
  for (const { season, tid, app, g } of byKey.values()) {
    const cands = stints.filter(s => s.tid === tid && s.start <= season + 1);
    if (cands.length) {
      const st = cands.reduce((a, b) => (a.start >= b.start ? a : b));
      st.app += app; st.g += g; st.seasons.add(season);
    } else {
      if (!unmatched.has(tid)) unmatched.set(tid, { app: 0, g: 0, seasons: new Set() });
      const u = unmatched.get(tid); u.app += app; u.g += g; u.seasons.add(season);
    }
  }
  for (const [tid, u] of unmatched) {
    if (u.app >= 2) stints.push({ tid, start: Math.min(...u.seasons), loan: false, app: u.app, g: u.g, seasons: u.seasons });
  }

  // 4) Quedarse con etapas reales (≥2 partidos); nombre/parent/años/escudo
  let rows = stints.filter(s => s.app >= 2 && s.seasons.size);
  rows.forEach(s => {
    const info = tidInfo.get(s.tid) || {};
    s.name = info.name || ('#' + s.tid);
    s.parent = info.m || null;
    s.startY = Math.min(...s.seasons); s.endY = Math.max(...s.seasons);
  });
  rows.sort((a, b) => a.startY - b.startY || a.endY - b.endY);

  // 5) Fusionar etapas consecutivas del mismo club (Messi: una sola Barcelona)
  const merged = [];
  for (const s of rows) {
    const prev = merged[merged.length - 1];
    // Solo fusionar si es el mismo club Y contiguo (sin hueco de años): así dos
    // etapas separadas en el mismo club (Santi Mina en el Celta) NO se funden.
    if (prev && prev.tid === s.tid && s.startY - prev.endY <= 1) {
      prev.app += s.app; prev.g += s.g; s.seasons.forEach(x => prev.seasons.add(x));
      prev.endY = Math.max(prev.endY, s.endY); prev.loan = prev.loan && s.loan;
    } else merged.push(s);
  }
  rows = merged;
  rows.forEach(s => {
    s.clubId = /^\d+$/.test(s.tid) ? +s.tid : s.tid;
    s.years = s.startY === s.endY ? `${s.startY}` : `${s.startY}-${s.endY}`;
  });

  // 6) Juveniles fuera; filiales fuera si el jugador jugó en el primer equipo
  //    (enlace fiable por mainClubId; respaldo por nombre).
  rows = rows.filter(s => !isYouth(s.name));
  const present = new Set(rows.map(s => s.tid));
  rows = rows.filter(s => {
    if (s.parent && present.has(String(s.parent))) return false;            // filial + primer equipo presente
    if (isReserve(s.name) && rows.some(o => o !== s && !isReserve(o.name) && samesClub(s.name, o.name))) return false;
    return true;
  });

  // Normalizar nombres de campo al mismo formato que espera renderTable/legacy.
  return rows.map(s => ({ name: s.name, apps: s.app, goals: s.g, years: s.years, clubId: s.clubId, loan: s.loan }));
}

function buildCareerLegacy(transfersArr, perfArr) {
  if (!perfArr || !perfArr.length) return [];

  // Llegadas desde transfers → dan id de club (escudo) + marca de cesión
  const arrivals = [];
  (transfersArr || []).forEach(m => {
    if (m.tid) arrivals.push({
      key: seasonStartYear(m.s) || (m.d ? +String(m.d).slice(0, 4) : 0),
      clubId: m.tid, clubName: m.tn, loan: (m.type === 'Loan')
    });
  });
  if (transfersArr && transfersArr.length) {
    const o = transfersArr[transfersArr.length - 1];
    if (o.fid) arrivals.push({ key: (seasonStartYear(o.s) || 9999) - 1, clubId: o.fid, clubName: o.fn, loan: false });
  }

  // 1) Agregar performances por NOMBRE de equipo (separa bien 1er equipo vs filial)
  const byName = new Map();
  for (const r of perfArr) {
    const apps = r.app || 0, g = r.g || 0;
    if (apps <= 0 && g <= 0) continue;
    const key = norm(r.tn);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { name: r.tn, apps: 0, goals: 0, startY: 9999, endY: 0 });
    const o = byName.get(key);
    o.apps += apps; o.goals += g;
    o.startY = Math.min(o.startY, seasonStartYear(r.s) || o.startY);
    o.endY   = Math.max(o.endY,   seasonEndYear(r.s));
  }

  // 2) A cada club, el escudo/cesión de la llegada de transfers que mejor casa
  //    (más tokens de nombre en común; a igualdad, temporada más cercana)
  function bestArrival(o) {
    const pt = new Set(careerTokens(o.name));
    let best = null, bestScore = -1, bestDist = 1e9;
    for (const a of arrivals) {
      let sc = 0; for (const t of careerTokens(a.clubName)) if (pt.has(t)) sc++;
      const dist = Math.abs(a.key - o.startY);
      if (sc > bestScore || (sc === bestScore && dist < bestDist)) { best = a; bestScore = sc; bestDist = dist; }
    }
    return bestScore >= 1 ? best : null;
  }

  const rows = [...byName.values()].filter(o => o.apps > 0 || o.goals > 0);
  rows.forEach(o => {
    const a = bestArrival(o);
    o.clubId = a ? a.clubId : null;
    o.loan   = a ? a.loan : false;
    // Cesión que se convirtió en fichaje permanente → ya no es "cedido".
    if (o.loan && a && arrivals.some(x => x.clubId === a.clubId && !x.loan)) o.loan = false;
    o.years  = (o.startY && o.endY)
      ? (o.startY === o.endY ? `${o.startY}` : `${o.startY}-${o.endY}`)
      : '—';
  });
  rows.sort((a, b) => a.startY - b.startY || a.endY - b.endY);

  // Juveniles / sub-19 fuera. Filiales (B/II/Castilla…) solo si DESPUÉS el
  // jugador se fue a OTRO club. Si tras el filial jugó en el PRIMER equipo del
  // mismo club (aunque sean pocos partidos), se quita el filial y se deja el
  // primer equipo (Messi: Barça B fuera; Fabinho: Castilla fuera → Real Madrid).
  const noYouth = rows.filter(o => !isYouth(o.name));
  const kept = [];
  for (let i = 0; i < noYouth.length; i++) {
    const o = noYouth[i];
    if (isReserve(o.name)) {
      const next = noYouth[i + 1];
      if (!next) continue;                         // filial y no fue a otro club → fuera
      if (samesClub(o.name, next.name)) continue;  // jugó en el 1er equipo del mismo club → fuera
    }
    kept.push(o);
  }
  return kept;
}

// ══════════════════════════════════════════════
//  ESTADÍSTICAS (localStorage) — solo el día de hoy
// ══════════════════════════════════════════════
function defaultStats() { return { played: 0, wins: 0, streak: 0, maxStreak: 0, losses: 0, hist: Array(41).fill(0) }; }
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY));
    if (!s) return defaultStats();
    if (!Array.isArray(s.hist) || s.hist.length < 41) s.hist = Array(41).fill(0);
    if (typeof s.losses !== 'number') s.losses = 0;
    return s;
  } catch { return defaultStats(); }
}
function saveStats(s) { try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch {} }
function recordResult(won, attempts) {
  const s = loadStats();
  s.played++;
  if (won) {
    s.wins++; s.streak++;
    if (s.streak > s.maxStreak) s.maxStreak = s.streak;
    if (attempts >= 1 && attempts < s.hist.length) s.hist[attempts]++;
  } else {
    s.streak = 0; s.losses++;
  }
  saveStats(s);
}
function saveTodayResult() {
  try {
    const day = getTodayMadrid();
    localStorage.setItem(TODAY_KEY, JSON.stringify({ date: day, id: _target.id, attempts: _attempt, won: _won }));
    // Registro por fecha (no se sobreescribe) — lo usa el hub para la racha.
    localStorage.setItem(`carrera_day_${day}`, JSON.stringify({ won: _won }));
  } catch {}
}
function loadTodayResult() {
  try {
    const d = JSON.parse(localStorage.getItem(TODAY_KEY));
    if (!d || d.date !== getTodayMadrid()) return null;
    return d;
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let _nameIndex = [];
let _perfManifest = { ranges: [] };
let _days = {};           // { "AAAA-MM-DD": {id, name} } de todos los meses
let _editions = [];       // fechas jugables (<= hoy), ASCENDENTE (edición 1 = la más antigua)
let _idx = 0;             // índice de la edición actual dentro de _editions

let _target = null;       // { id, name, img, career:[] }
let _total = 0, _attempt = 1, _visible = 1;
let _ended = false, _won = false, _isToday = false, _statsSaved = false;

let _acItems = [], _acIdx = -1, _acDebounce = null, _cdInterval = null;

// ── Refs ──
let elLoading, elIntro, elGame, elEnd;
let elStartBtn, elStatsOpen;
let elNav, elNavFirst, elNavPrev, elNavNext, elNavLast, elNavLabel;
let elAttempt, elArchiveTag, elCareer, elInput, elSug, elSkip;
let elEndEmoji, elEndTitle, elEndSub, elRevealImg, elRevealName, elEndCareer, elEndStats, elShare;
let elStatsOverlay, elStatsClose, elStatsNums, elHistBars, elHistLabels, elCountdown;

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
async function init() {
  elLoading    = document.getElementById('loading-screen');
  elIntro      = document.getElementById('intro-screen');
  elGame       = document.getElementById('game-screen');
  elEnd        = document.getElementById('end-screen');
  elStartBtn   = document.getElementById('start-game-btn');
  elStatsOpen  = document.getElementById('stats-open-btn');
  elNav        = document.getElementById('day-nav');
  elNavFirst   = document.getElementById('nav-first');
  elNavPrev    = document.getElementById('nav-prev');
  elNavNext    = document.getElementById('nav-next');
  elNavLast    = document.getElementById('nav-last');
  elNavLabel   = document.getElementById('nav-label');
  elAttempt    = document.getElementById('attempt-badge');
  elArchiveTag = document.getElementById('archive-tag');
  elCareer     = document.getElementById('career-wrap');
  elInput      = document.getElementById('ans-input');
  elSug        = document.getElementById('sug-box');
  elSkip       = document.getElementById('skip-btn');
  elEndEmoji   = document.getElementById('end-emoji');
  elEndTitle   = document.getElementById('end-title');
  elEndSub     = document.getElementById('end-sub');
  elRevealImg  = document.getElementById('reveal-img');
  elRevealName = document.getElementById('reveal-name');
  elEndCareer  = document.getElementById('end-career');
  elEndStats   = document.getElementById('end-stats-btn');
  elShare      = document.getElementById('share-btn');
  elStatsOverlay = document.getElementById('stats-overlay');
  elStatsClose = document.getElementById('stats-close-btn');
  elStatsNums  = document.getElementById('stats-nums');
  elHistBars   = document.getElementById('stats-hist-bars');
  elHistLabels = document.getElementById('stats-hist-labels');
  elCountdown  = document.getElementById('stats-countdown');

  bindModalEvents();

  const today = getTodayMadrid();
  try {
    _nameIndex    = await fetchJson(sbStorageUrl('player-db', 'players/name-index.json'));
    _perfManifest = await fetchJson(sbStorageUrl('player-db', 'performances/chunks/manifest.json'));
    await loadAllMonths(today);
  } catch (e) {
    return fail(`No se pudieron cargar los datos.<br><small>${e.message}</small>`);
  }

  _editions = Object.keys(_days)
    .filter(d => d <= today && _days[d] && _days[d].id)
    .sort();   // ascendente: edición 1 = la más antigua

  if (!_editions.length) return fail('No hay carrera disponible todavía.');

  // Al entrar, la de HOY (o la más reciente disponible).
  _idx = _editions.indexOf(today);
  if (_idx < 0) _idx = _editions.length - 1;

  elStartBtn.addEventListener('click', () => playCurrent());
  elStatsOpen.addEventListener('click', openStats);
  elNavFirst.addEventListener('click', () => goEdition(0));
  elNavPrev .addEventListener('click', () => goEdition(_idx - 1));
  elNavNext .addEventListener('click', () => goEdition(_idx + 1));
  elNavLast .addEventListener('click', () => goEdition(_editions.length - 1));

  // ¿Ya jugaste hoy?
  const saved = loadTodayResult();
  if (_editions[_idx] === today && saved) {
    elLoading.classList.add('hidden');
    await prepareAndPlay(today, saved);
    return;
  }

  elLoading.classList.add('hidden');
  elIntro.classList.remove('hidden');
}

/* Carga el mes actual y los anteriores (hasta 3 fallos seguidos), para poder
   navegar "muy para atrás" a través de meses. */
async function loadAllMonths(today) {
  let [y, m] = today.slice(0, 7).split('-').map(Number);
  let misses = 0;
  for (let k = 0; k < 36 && misses < 3; k++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    try {
      const res = await fetch(sbStorageUrl('game-data', `la-carrera/${key}.json`), { cache: 'no-cache' });
      if (res.ok) { const j = await res.json(); Object.assign(_days, j.days || j); misses = 0; }
      else misses++;
    } catch { misses++; }
    m--; if (m < 1) { m = 12; y--; }
  }
}

function fail(html) {
  elLoading.innerHTML = `<p style="color:#b5221e;font-family:'DM Mono',monospace;font-size:12px;letter-spacing:.15em;text-align:center;padding:0 20px">${html}</p>`;
}

function playCurrent() {
  const date = _editions[_idx];
  const saved = (date === getTodayMadrid()) ? loadTodayResult() : null;
  prepareAndPlay(date, saved);
}

/* Navega a otra edición (desde el juego o el final) y la carga de cero. */
function goEdition(idx) {
  idx = Math.max(0, Math.min(_editions.length - 1, idx));
  if (idx === _idx && _ended === false && elGame && !elGame.classList.contains('hidden')) {
    // ya estás en esa edición jugando
  }
  _idx = idx;
  playCurrent();
}

function renderNav() {
  if (!elNav) return;
  const n = _editions.length;
  const atStart = _idx <= 0, atEnd = _idx >= n - 1;
  elNavFirst.disabled = atStart;
  elNavPrev.disabled  = atStart;
  elNavNext.disabled  = atEnd;
  elNavLast.disabled  = atEnd;
  const date = _editions[_idx];
  const [, mo, da] = date.split('-');
  const hoy = date === getTodayMadrid();
  elNavLabel.textContent = `#${_idx + 1}` + (hoy ? ' · Hoy' : ` · ${da}/${mo}`);
}

// ══════════════════════════════════════════════
//  PREPARAR JUGADOR Y EMPEZAR
// ══════════════════════════════════════════════
async function prepareAndPlay(date, saved) {
  const entry = _days[date];
  if (!entry || !entry.id) return fail('No hay jugador para ese día.');
  _idx = Math.max(0, _editions.indexOf(date));

  elIntro.classList.add('hidden');
  elLoading.classList.remove('hidden');

  const id = entry.id;
  const [transfers, perf, playerRec] = await Promise.all([
    loadFromUniform('transfers', id),
    loadPerformances(id, _perfManifest),
    loadFromUniform('players', id),
  ]);

  const career = buildCareer(transfers, perf);
  if (!career.length) { elLoading.classList.add('hidden'); return fail('No se pudo montar la carrera de este jugador.'); }

  _target = {
    id,
    name: entry.name || (playerRec && playerRec.n) || '',
    img: playerRec && playerRec.img ? playerRec.img : '',
    career
  };
  _total   = career.length;
  _isToday = (date === getTodayMadrid());

  elLoading.classList.add('hidden');

  if (saved) {   // partida de hoy ya jugada → mostrar resultado
    _attempt = saved.attempts; _won = saved.won; _ended = true; _statsSaved = true;
    _visible = _total;
    showEnd();
    return;
  }
  startGame();
}

function startGame() {
  _attempt = 1; _visible = 1; _ended = false; _won = false; _statsSaved = false;
  elEnd.classList.add('hidden');
  elIntro.classList.add('hidden');
  elGame.classList.remove('hidden');
  elNav.classList.remove('hidden');
  renderNav();
  elArchiveTag.classList.toggle('hidden', _isToday);
  elInput.disabled = false; elSkip.disabled = false; elInput.value = '';
  renderTable(elCareer, false);
  updateBadge();
  bindGameEvents();
  elInput.focus();
}

function updateBadge() { elAttempt.textContent = `Intento ${_attempt} / ${_total}`; }

// ══════════════════════════════════════════════
//  RENDER TABLA
// ══════════════════════════════════════════════
function crestImg(clubId) {
  if (!clubId) return '<span style="width:20px;height:20px;flex-shrink:0;"></span>';
  return `<img src="${CREST_BASE}${clubId}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

function renderTable(container, revealAll) {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'career-title';
  title.textContent = 'Carrera';
  container.appendChild(title);

  const head = document.createElement('div');
  head.className = 'crow head';
  head.innerHTML = `<div class="c-years">Años</div><div class="c-team">Equipo</div><div class="c-apps">Part.</div><div class="c-goals">Goles</div>`;
  container.appendChild(head);

  _target.career.forEach((row, i) => {
    const visible = revealAll || i < _visible;
    const div = document.createElement('div');
    div.className = 'crow' + (visible ? '' : ' locked');
    if (visible) {
      const loanTxt = row.loan ? ' <span class="c-loan">(cedido)</span>' : '';
      div.innerHTML =
        `<div class="c-years">${row.years}</div>` +
        `<div class="c-team">${crestImg(row.clubId)}<span class="c-team-name">${escHtml(row.name)}${loanTxt}</span></div>` +
        `<div class="c-apps">${row.apps}</div>` +
        `<div class="c-goals">(${row.goals})</div>`;
    } else {
      div.innerHTML =
        `<div class="c-years">— — —</div>` +
        `<div class="c-team"><span style="width:20px;height:20px;flex-shrink:0"></span><span class="c-dash"></span></div>` +
        `<div class="c-apps">--</div>` +
        `<div class="c-goals">(--)</div>`;
    }
    container.appendChild(div);
  });
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ══════════════════════════════════════════════
//  INPUT & AUTOCOMPLETE
// ══════════════════════════════════════════════
function bindGameEvents() {
  const ni = elInput.cloneNode(true); elInput.parentNode.replaceChild(ni, elInput); elInput = ni;
  elInput.addEventListener('input', () => {
    clearTimeout(_acDebounce);
    if (elInput.value.length < 2) { closeSug(); return; }
    _acDebounce = setTimeout(() => buildSug(elInput.value), 150);
  });
  elInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSug(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSug(-1); return; }
    if (e.key === 'Escape')    { closeSug(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(_acDebounce);
      // Si el debounce aún no había generado sugerencias, las construimos ya
      // mismo para que Enter siempre funcione (aunque se pulse muy rápido).
      if (!_acItems.length && elInput.value.trim().length >= 2) buildSug(elInput.value);
      if (_acIdx >= 0 && _acItems[_acIdx]) submitSug(_acItems[_acIdx]);
      else if (_acItems.length)            submitSug(_acItems[0]);
    }
  });
  document.addEventListener('click', e => { if (!elSug.contains(e.target) && e.target !== elInput) closeSug(); });

  const ns = elSkip.cloneNode(true); elSkip.parentNode.replaceChild(ns, elSkip); elSkip = ns;
  elSkip.addEventListener('click', () => { if (!_ended) onWrong(); });
}

function wordBoundaryMatch(n, q) {
  const w = n.split(' ');
  for (let i = 0; i < w.length; i++) if (w.slice(i).join(' ').startsWith(q)) return true;
  return false;
}
function buildSug(query) {
  const q = norm(query);
  let exact = [], starts = [], word = [], contains = [];
  for (const [id, name] of _nameIndex) {
    const n = norm(name);
    if (n === q) exact.push([id, name]);
    else if (n.startsWith(q)) starts.push([id, name]);
    else if (wordBoundaryMatch(n, q)) word.push([id, name]);
    else if (n.includes(q)) contains.push([id, name]);
    if (exact.length + starts.length + word.length >= 10 && contains.length >= 4) break;
  }
  const items = [...exact, ...starts, ...word, ...contains].slice(0, 8).map(([id, name]) => ({ id, name }));
  renderSug(items, query);
}
function renderSug(items, query) {
  _acItems = items; _acIdx = items.length ? 0 : -1;
  if (!items.length) { closeSug(); return; }
  elSug.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'sug-item' + (i === 0 ? ' active' : '');
    div.innerHTML = `<span class="sug-name">${highlight(item.name, query)}</span>`;
    div.addEventListener('mousedown', e => { e.preventDefault(); submitSug(item); });
    div.addEventListener('mousemove', () => setAcIdx(i));
    elSug.appendChild(div);
  });
  elSug.classList.add('open');
}
function highlight(name, query) {
  const q = norm(query), n = norm(name), idx = n.indexOf(q);
  if (idx === -1) return escHtml(name);
  return escHtml(name.slice(0, idx)) + `<span class="sug-highlight">${escHtml(name.slice(idx, idx + query.length))}</span>` + escHtml(name.slice(idx + query.length));
}
function moveSug(dir) { setAcIdx(Math.max(0, Math.min(_acItems.length - 1, _acIdx + dir))); }
function setAcIdx(i) { _acIdx = i; elSug.querySelectorAll('.sug-item').forEach((el, j) => el.classList.toggle('active', j === i)); }
function closeSug() { elSug.classList.remove('open'); elSug.innerHTML = ''; _acItems = []; _acIdx = -1; }
function submitSug(item) { closeSug(); elInput.value = ''; if (!_ended) guess(item.name, item.id); }

// ══════════════════════════════════════════════
//  LÓGICA DE ADIVINAR
// ══════════════════════════════════════════════
function guess(name, id) {
  const correct = (id && String(id) === String(_target.id)) || norm(name) === norm(_target.name);
  if (correct) { _won = true; endGame(); }
  else onWrong();
}
function onWrong() {
  if (_ended) return;
  if (_attempt >= _total) { _won = false; endGame(); return; }
  _attempt++; _visible++;
  renderTable(elCareer, false);
  const last = elCareer.querySelectorAll('.crow:not(.head)')[_visible - 1];
  if (last) last.classList.add('reveal-in');
  updateBadge();
  shakeInput();
}
function shakeInput() {
  elInput.classList.remove('shake'); void elInput.offsetWidth; elInput.classList.add('shake');
  elInput.addEventListener('animationend', () => elInput.classList.remove('shake'), { once: true });
}

// ══════════════════════════════════════════════
//  FIN
// ══════════════════════════════════════════════
function endGame() {
  _ended = true; _visible = _total; closeSug();
  elInput.disabled = true; elSkip.disabled = true;
  if (_isToday && !_statsSaved) {
    _statsSaved = true;
    recordResult(_won, _attempt);
    saveTodayResult();
  }
  setTimeout(showEnd, 500);
}
function showEnd() {
  elGame.classList.add('hidden');
  if (_won) {
    elEndEmoji.textContent = _attempt === 1 ? '🏆' : (_attempt <= 3 ? '🥇' : '✅');
    elEndTitle.textContent = _attempt === 1 ? '¡A la primera!' : '¡Acertado!';
    elEndSub.textContent   = `Adivinado en el intento ${_attempt} de ${_total}`;
  } else {
    elEndEmoji.textContent = '😬';
    elEndTitle.textContent = 'No esta vez…';
    elEndSub.textContent   = `Se agotaron los ${_total} intentos`;
  }
  if (_target.img) { elRevealImg.src = _target.img; elRevealImg.alt = _target.name; }
  else elRevealImg.parentElement.style.display = 'none';
  elRevealName.textContent = _target.name;

  renderTable(elEndCareer, true);
  elEnd.classList.remove('hidden');
  elNav.classList.remove('hidden');
  renderNav();
  setTimeout(openStats, 650);
}

// ══════════════════════════════════════════════
//  COMPARTIR
// ══════════════════════════════════════════════
function doShare() {
  let squares;
  if (_won) squares = '⬛'.repeat(_attempt - 1) + '🟩';
  else      squares = '⬛'.repeat(Math.max(0, _total - 1)) + '🟥';
  const line = _won ? `Acerté en el intento ${_attempt}/${_total}` : `No acerté (${_total} intentos)`;
  const text = `La Carrera · FutbolHUB · ${getTodayMadrid()}\n${line}\n${squares}\n` +
    window.location.origin + window.location.pathname;
  const btn = elShare;
  const feedback = () => { const o = btn.innerHTML; btn.innerHTML = '✓ ¡Copiado!'; setTimeout(() => btn.innerHTML = o, 2000); };
  if (navigator.share) navigator.share({ text }).catch(() => {});
  else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(feedback).catch(() => {});
  else {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); feedback(); } catch {}
  }
}

// ══════════════════════════════════════════════
//  ESTADÍSTICAS (modal + countdown)
// ══════════════════════════════════════════════
function bindModalEvents() {
  document.getElementById('stats-close-btn').addEventListener('click', closeStats);
  document.getElementById('stats-overlay').addEventListener('click', e => { if (e.target.id === 'stats-overlay') closeStats(); });
  document.getElementById('end-stats-btn').addEventListener('click', openStats);
  document.getElementById('share-btn').addEventListener('click', doShare);
}
function openStats() { renderStatsModal(loadStats()); elStatsOverlay.classList.remove('hidden'); startCountdown(); }
function closeStats() { elStatsOverlay.classList.add('hidden'); stopCountdown(); }
function startCountdown() {
  stopCountdown();
  const tick = () => { elCountdown.innerHTML = `Nueva carrera en <strong>${formatCountdown(getMsUntilMadridMidnight())}</strong>`; };
  tick(); _cdInterval = setInterval(tick, 1000);
}
function stopCountdown() { clearInterval(_cdInterval); _cdInterval = null; }

function renderStatsModal(stats) {
  const pct = stats.played > 0 ? Math.round((stats.wins / stats.played) * 100) : 0;
  elStatsNums.innerHTML = '';
  [
    { val: stats.played,    label: 'Jugadas' },
    { val: stats.wins,      label: 'Aciertos' },
    { val: pct + '%',       label: '%' },
    { val: stats.streak,    label: 'Racha' },
    { val: stats.maxStreak, label: 'Racha\nmáxima' },
  ].forEach(({ val, label }) => {
    const c = document.createElement('div');
    c.className = 'stat-cell';
    c.innerHTML = `<div class="stat-val">${val}</div><div class="stat-label">${label}</div>`;
    elStatsNums.appendChild(c);
  });
  renderHistogram(stats);
}
function renderHistogram(stats) {
  elHistBars.innerHTML = ''; elHistLabels.innerHTML = '';
  let maxK = 6;
  for (let k = 1; k < stats.hist.length; k++) if (stats.hist[k] > 0) maxK = Math.max(maxK, k);
  if (_ended && _won) maxK = Math.max(maxK, _attempt);
  const bins = [];
  for (let k = 1; k <= maxK; k++) bins.push({ label: String(k), count: stats.hist[k] || 0, current: _ended && _won && _attempt === k });
  bins.push({ label: '✗', count: stats.losses || 0, current: _ended && !_won });
  const maxCount = Math.max(...bins.map(b => b.count), 1);
  bins.forEach(b => {
    const col = document.createElement('div'); col.className = 'hist-col';
    const bar = document.createElement('div'); bar.className = 'hist-bar' + (b.current ? ' current' : '');
    bar.style.height = Math.max((b.count / maxCount) * 100, 4) + '%';
    const cnt = document.createElement('span'); cnt.className = 'hist-count'; cnt.textContent = b.count > 0 ? b.count : '';
    bar.appendChild(cnt); col.appendChild(bar); elHistBars.appendChild(col);
    const lbl = document.createElement('div'); lbl.className = 'hist-label' + (b.current ? ' current' : ''); lbl.textContent = b.label;
    elHistLabels.appendChild(lbl);
  });
}

document.addEventListener('DOMContentLoaded', init);
