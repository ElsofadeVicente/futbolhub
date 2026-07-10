/* ══════════════════════════════════════════════
   EN EL TOP — game.js
   ══════════════════════════════════════════════ */
'use strict';

// ── Paths ──────────────────────────────────────
const PATH_QUESTIONS    = 'data/enteltop.json'; // dataset propio del juego, no viene de Supabase
const STATS_KEY         = 'enteltop_stats';
const TODAY_KEY         = 'enteltop_today';
const TIMER_TIMED       = 120;

// ── Banderas ───────────────────────────────────
const FLAG_REMAP = {
  en: 'gb-eng', sco: 'gb-sct', wls: 'gb-wls', nir: 'gb-nir',
};
function flagUrl(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  return `https://flagcdn.com/w40/${FLAG_REMAP[c] || c}.png`;
}

// ── Normalización de texto ─────────────────────
function norm(s) {
  // Mapeamos primero letras nordicas/especiales que NFD no descompone
  // (o-con-barra, ae-danesa, etc.) para que se acepte "Hojbjerg" al
  // teclear el nombre de jugadores como Hojbjerg, igual que hace Coche.
  return String(s || '').toLowerCase()
    .replace(/\u00f8/g,'o').replace(/\u00e6/g,'ae').replace(/\u00f0/g,'d').replace(/\u00fe/g,'th').replace(/\u0142/g,'l').replace(/\u0111/g,'d')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Fecha actual en Madrid ─────────────────────
function getTodayMadrid() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid'
  }).format(new Date()); // "YYYY-MM-DD"
}

// ── Ms hasta medianoche de Madrid ─────────────
function getMsUntilMadridMidnight() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(now);
  let h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const s = parseInt(parts.find(p => p.type === 'second').value);
  if (h === 24) h = 0;
  const elapsed = h * 3600 + m * 60 + s;
  return Math.max(0, (86400 - elapsed) * 1000);
}

// ── Pregunta diaria (hora española) ───────────
// Usa el mismo hash entero determinista que shared.js (getDailyMatchIndex) en
// vez de un simple "días % total": con un módulo directo, el orden de
// preguntas es una rotación 0,1,2,3... totalmente predecible con solo mirar
// el JSON; el hash mezcla el índice manteniendo el resultado 100% determinista
// para la misma fecha (igual para todos los usuarios).
function getDailyQuestion(questions) {
  if (!questions || !questions.length) return null;
  const dateStr = getTodayMadrid();
  const [y, m, d] = dateStr.split('-').map(Number);
  const seed = y * 10000 + m * 100 + d;
  let hash = seed;
  hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
  hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
  hash = (hash >>> 16) ^ hash;
  const idx = Math.abs(hash) % questions.length;
  return questions[idx];
}

// ── Formato M:SS ───────────────────────────────
function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Formato HH:MM:SS ───────────────────────────
function formatCountdown(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════
//  STATS (localStorage)
// ══════════════════════════════════════════════
function defaultStats() {
  return { played: 0, wins: 0, streak: 0, maxStreak: 0, hist: Array(11).fill(0) };
}
function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return defaultStats();
    const s = JSON.parse(raw);
    if (!s.hist || s.hist.length < 11) s.hist = Array(11).fill(0);
    return s;
  } catch { return defaultStats(); }
}
function saveStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /**/ }
}
function recordResult(found) {
  const stats = loadStats();
  stats.played++;
  stats.hist[found]++;
  if (found === 10) {
    stats.wins++;
    stats.streak++;
    if (stats.streak > stats.maxStreak) stats.maxStreak = stats.streak;
  } else {
    stats.streak = 0;
  }
  saveStats(stats);
}

// ══════════════════════════════════════════════
//  PARTIDA DIARIA (localStorage)
// ══════════════════════════════════════════════
function saveTodayResult(questionId, foundArr, score) {
  try {
    localStorage.setItem(TODAY_KEY, JSON.stringify({
      date: getTodayMadrid(),
      questionId,
      found: foundArr,
      score
    }));
    // Registro por fecha (no se sobreescribe al día siguiente) — lo usa el hub
    // para calcular la racha de días con 10/10.
    localStorage.setItem(`enteltop_day_${getTodayMadrid()}`, JSON.stringify({ score }));
  } catch { /**/ }
}

function loadTodayResult() {
  try {
    const raw = localStorage.getItem(TODAY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== getTodayMadrid()) return null;
    return data;
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  ÍNDICE DE EQUIPOS
// ══════════════════════════════════════════════
function buildTeamIndex(teamNames, leagueTeams) {
  const priorityMap = new Map();
  for (const [, leagueData] of Object.entries(leagueTeams)) {
    for (const teamName of leagueData.teams) {
      if (!priorityMap.has(teamName)) priorityMap.set(teamName, leagueData.priority);
    }
  }
  const result = teamNames.map(name => ({
    name,
    normName: norm(name),
    priority: priorityMap.get(name) || 999
  }));
  result.sort((a, b) => a.priority - b.priority);
  return result;
}

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let _questions     = [];
let _question      = null;
let _nameIndex     = [];
let _teamIndex     = [];
let _found         = new Set();
let _mode          = 'normal';
let _timeLeft      = 0;
let _timerInterval = null;
let _ended         = false;
let _statsSaved    = false;

let _acItems    = [];
let _acIdx      = -1;
let _acDebounce = null;
let _cdInterval = null;

// ── Refs ───────────────────────────────────────
let elLoading, elMode, elGame, elEnd;
let elModeOpts, elStartGameBtn, elStatsOpenBtn;
let elTimerTrack, elTimerFill, elTimerNum;
let elScore, elTitle, elRowsWrap;
let elInput, elSugBox, elGiveup;
let elEndEmoji, elEndTitle, elEndSub, elEndQ, elEndRows, elEndStatsBtn;
let elGiveupOverlay, elGiveupYes, elGiveupNo;
let elStatsOverlay, elStatsClose, elStatsNums, elStatsHistBars, elStatsHistLabels, elStatsCountdown;

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
async function init() {
  elLoading         = document.getElementById('loading-screen');
  elMode            = document.getElementById('mode-screen');
  elGame            = document.getElementById('game-screen');
  elEnd             = document.getElementById('end-screen');
  elModeOpts        = document.querySelectorAll('.mode-opt');
  elStartGameBtn    = document.getElementById('start-game-btn');
  elStatsOpenBtn    = document.getElementById('stats-open-btn');
  elTimerTrack      = document.getElementById('timer-track');
  elTimerFill       = document.getElementById('timer-fill');
  elTimerNum        = document.getElementById('timer-num');
  elScore           = document.getElementById('score-badge');
  elTitle           = document.getElementById('question-title');
  elRowsWrap        = document.getElementById('rows-wrap');
  elInput           = document.getElementById('ans-input');
  elSugBox          = document.getElementById('sug-box');
  elGiveup          = document.getElementById('giveup-btn');
  elEndEmoji        = document.getElementById('end-emoji');
  elEndTitle        = document.getElementById('end-title');
  elEndSub          = document.getElementById('end-sub');
  elEndQ            = document.getElementById('end-q');
  elEndRows         = document.getElementById('end-rows');
  elEndStatsBtn     = document.getElementById('end-stats-btn');
  elGiveupOverlay   = document.getElementById('giveup-overlay');
  elGiveupYes       = document.getElementById('giveup-yes-btn');
  elGiveupNo        = document.getElementById('giveup-no-btn');
  elStatsOverlay    = document.getElementById('stats-overlay');
  elStatsClose      = document.getElementById('stats-close-btn');
  elStatsNums       = document.getElementById('stats-nums');
  elStatsHistBars   = document.getElementById('stats-hist-bars');
  elStatsHistLabels = document.getElementById('stats-hist-labels');
  elStatsCountdown  = document.getElementById('stats-countdown');

  try {
    const [qs, niRows, tnRows, ltRows] = await Promise.all([
      fetch(PATH_QUESTIONS).then(r => r.json()),
      sbFetchAll('players?select=id,name:data->>n'),
      sbFetchAll('team_names_index?select=name'),
      sbFetchAll('leagues?select=name,data'),
    ]);
    _questions = qs;
    _nameIndex = niRows.map(r => [r.id, r.name]);
    const tn = tnRows.map(r => r.name);
    const lt = {};
    for (const row of ltRows) lt[row.name] = row.data;
    _teamIndex = buildTeamIndex(tn, lt);
  } catch (e) {
    elLoading.innerHTML = `<p style="color:#b5221e;font-family:'DM Mono',monospace;font-size:12px;letter-spacing:.15em;text-align:center">Error al cargar datos.<br>${e.message}</p>`;
    return;
  }

  _question = getDailyQuestion(_questions);
  if (!_question) {
    elLoading.innerHTML = '<p style="color:#b5221e;font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:.15em;text-align:center">No hay preguntas disponibles.</p>';
    return;
  }
  _question._normMap = buildNormMap(_question.top10);

  // Siempre vincular modales (necesario tanto para partida nueva como ya jugada)
  bindModalEvents();

  // ¿Ya jugaste hoy?
  const todayResult = loadTodayResult();
  if (todayResult && todayResult.questionId === _question.id) {
    _found      = new Set(todayResult.found);
    _ended      = true;
    _statsSaved = true;
    elLoading.classList.add('hidden');
    showEndScreen(todayResult.score === 10);
    return;
  }

  bindModeScreenEvents();
  elLoading.classList.add('hidden');
  elMode.classList.remove('hidden');
}

function questionType() {
  if (!_question) return 'player';
  if (_question.type) return _question.type;             // explícito gana
  return _question.hint === 'club' ? 'team' : 'player'; // infiere de hint
}

// ══════════════════════════════════════════════
//  MODE SCREEN
// ══════════════════════════════════════════════
function bindModeScreenEvents() {
  elModeOpts.forEach(btn => {
    btn.addEventListener('click', () => {
      elModeOpts.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      _mode = btn.dataset.mode;
    });
  });
  elStartGameBtn.addEventListener('click', startGame);
  elStatsOpenBtn.addEventListener('click', openStats);
}

// ══════════════════════════════════════════════
//  MODAL EVENTS
// ══════════════════════════════════════════════
function bindModalEvents() {
  elGiveupYes.addEventListener('click', () => {
    elGiveupOverlay.classList.add('hidden');
    endGame(false);
  });
  elGiveupNo.addEventListener('click', () => {
    elGiveupOverlay.classList.add('hidden');
    elInput.focus();
  });
  elGiveupOverlay.addEventListener('click', e => {
    if (e.target === elGiveupOverlay) {
      elGiveupOverlay.classList.add('hidden');
      elInput.focus();
    }
  });

  elStatsClose.addEventListener('click', closeStats);
  elStatsOverlay.addEventListener('click', e => {
    if (e.target === elStatsOverlay) closeStats();
  });

  elEndStatsBtn.addEventListener('click', openStats);
}

// ══════════════════════════════════════════════
//  START GAME
// ══════════════════════════════════════════════
function startGame() {
  _found      = new Set();
  _ended      = false;
  _statsSaved = false;
  _timeLeft   = TIMER_TIMED;

  elMode.classList.add('hidden');
  elEnd.classList.add('hidden');
  elGame.classList.remove('hidden');

  if (_mode === 'normal') {
    elTimerTrack.classList.add('hidden');
    elTimerNum.classList.add('hidden');
  } else {
    elTimerTrack.classList.remove('hidden');
    elTimerNum.classList.remove('hidden');
    updateTimerUI(_timeLeft);
  }

  elInput.placeholder = questionType() === 'team'
    ? 'Escribe el nombre del equipo…'
    : 'Escribe el nombre del futbolista…';

  renderGame();
  bindGameEvents();

  if (_mode === 'timed') startTimer();

  elInput.disabled = false;
  elGiveup.disabled = false;
  elInput.focus();
}

function buildNormMap(top10) {
  const map = new Map();
  for (const p of top10) {
    map.set(norm(p.n), p);
    if (p.id) map.set(String(p.id), p);
  }
  return map;
}

// ══════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════
function renderGame() {
  elTitle.textContent = _question.q;
  elRowsWrap.innerHTML = '';
  for (const p of _question.top10) {
    elRowsWrap.appendChild(makeRow(p));
  }
  updateScore();
}

function makeRow(p) {
  const row = document.createElement('div');
  row.className = 'row';
  row.id = `row-${p.r}`;

  const rank = document.createElement('div');
  rank.className = 'row-rank';
  rank.textContent = `${p.r}.`;

  const flagCell = document.createElement('div');
  const url = (_question.hint === 'nat') ? flagUrl(p.nat) : null;
  if (url) {
    flagCell.className = 'row-flag';
    const img = document.createElement('img');
    img.src = url; img.alt = p.nat || '';
    img.onerror = () => { img.style.display = 'none'; };
    flagCell.appendChild(img);
  } else {
    flagCell.className = 'row-flag empty';
  }

  const nameCell = document.createElement('div');
  nameCell.className = 'row-name';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name-text';
  nameCell.appendChild(nameSpan);
  const valBadge = document.createElement('span');
  valBadge.className = 'val-badge';
  valBadge.textContent = `${p.v} ${_question.unit}`;
  nameCell.appendChild(valBadge);

  row.appendChild(rank);
  row.appendChild(flagCell);
  row.appendChild(nameCell);
  return row;
}

function revealRow(p, state) {
  const row = document.getElementById(`row-${p.r}`);
  if (!row) return;
  row.classList.add(state);
  const ns = row.querySelector('.name-text');
  if (ns) ns.textContent = p.n;
  if (state === 'found') {
    row.classList.add('pop');
    row.addEventListener('animationend', () => row.classList.remove('pop'), { once: true });
  }
}

function updateScore() {
  elScore.textContent = `${_found.size}/10`;
}

// ══════════════════════════════════════════════
//  TIMER
// ══════════════════════════════════════════════
function startTimer() {
  _timeLeft = TIMER_TIMED;
  updateTimerUI(_timeLeft);
  const start = Date.now();
  _timerInterval = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    _timeLeft = Math.max(0, TIMER_TIMED - elapsed);
    updateTimerUI(_timeLeft);
    if (_timeLeft <= 0) {
      clearInterval(_timerInterval);
      if (!_ended) endGame(false);
    }
  }, 200);
}

function stopTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
}

function updateTimerUI(t) {
  if (_mode !== 'timed') return;
  const pct = (t / TIMER_TIMED) * 100;
  elTimerFill.style.width = pct + '%';
  elTimerFill.classList.toggle('urgent', t <= 10);
  elTimerNum.textContent = formatTime(t);
  elTimerNum.classList.toggle('low', t <= 20);
}

// ══════════════════════════════════════════════
//  INPUT & AUTOCOMPLETE
// ══════════════════════════════════════════════
function bindGameEvents() {
  const newInput = elInput.cloneNode(true);
  elInput.parentNode.replaceChild(newInput, elInput);
  elInput = newInput;

  elInput.addEventListener('input', () => {
    clearTimeout(_acDebounce);
    if (elInput.value.length < 2) { closeSug(); return; }
    _acDebounce = setTimeout(() => buildSug(elInput.value), 160);
  });

  elInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); moveSug(1);  return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); moveSug(-1); return; }
    if (e.key === 'Escape')     { closeSug(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_acIdx >= 0 && _acItems[_acIdx]) submitSug(_acItems[_acIdx]);
      else if (_acItems.length > 0)         submitSug(_acItems[0]);
    }
  });

  document.addEventListener('click', e => {
    if (!elSugBox.contains(e.target) && e.target !== elInput) closeSug();
  });

  const newGiveup = elGiveup.cloneNode(true);
  elGiveup.parentNode.replaceChild(newGiveup, elGiveup);
  elGiveup = newGiveup;

  elGiveup.addEventListener('click', () => {
    if (_ended) return;
    elGiveupOverlay.classList.remove('hidden');
  });
}

function wordBoundaryMatch(n, q) {
  const words = n.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words.slice(i).join(' ').startsWith(q)) return true;
  }
  return false;
}

function buildSug(query) {
  if (questionType() === 'team') buildTeamSug(query);
  else                           buildPlayerSug(query);
}

function buildPlayerSug(query) {
  const q = norm(query);
  let exact = [], starts = [], wordBound = [], contains = [];
  for (const [id, name] of _nameIndex) {
    const n = norm(name);
    if      (n === q)                 exact.push([id, name]);
    else if (n.startsWith(q))         starts.push([id, name]);
    else if (wordBoundaryMatch(n, q)) wordBound.push([id, name]);
    else if (n.includes(q))           contains.push([id, name]);
    if (exact.length + starts.length + wordBound.length >= 10 && contains.length >= 4) break;
  }
  const combined = [
    ...exact.map(([id, name]) => ({ id, name })),
    ...starts.map(([id, name]) => ({ id, name })),
    ...wordBound.map(([id, name]) => ({ id, name })),
    ...contains.map(([id, name]) => ({ id, name })),
  ].slice(0, 8);
  renderSug(combined, query);
}

function buildTeamSug(query) {
  const q = norm(query);
  let exact = [], starts = [], wordBound = [], contains = [];
  for (const team of _teamIndex) {
    const n = team.normName;
    if      (n === q)                 exact.push(team);
    else if (n.startsWith(q))         starts.push(team);
    else if (wordBoundaryMatch(n, q)) wordBound.push(team);
    else if (n.includes(q))           contains.push(team);
    if (exact.length + starts.length + wordBound.length >= 10 && contains.length >= 4) break;
  }
  const combined = [...exact, ...starts, ...wordBound, ...contains].slice(0, 8);
  renderSug(combined.map(t => ({ id: null, name: t.name })), query);
}

function renderSug(items, query) {
  _acItems = items;
  _acIdx   = items.length > 0 ? 0 : -1;
  if (!items.length) { closeSug(); return; }
  elSugBox.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'sug-item' + (i === 0 ? ' active' : '');
    div.innerHTML = `<span class="sug-name">${highlight(item.name, query)}</span>`;
    div.addEventListener('mousedown', e => { e.preventDefault(); submitSug(item); });
    div.addEventListener('mousemove', () => setAcIdx(i));
    elSugBox.appendChild(div);
  });
  elSugBox.classList.add('open');
}

function highlight(name, query) {
  const q = norm(query);
  const n = norm(name);
  const idx = n.indexOf(q);
  if (idx === -1) return escHtml(name);
  return escHtml(name.slice(0, idx))
    + `<span class="sug-highlight">${escHtml(name.slice(idx, idx + query.length))}</span>`
    + escHtml(name.slice(idx + query.length));
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function moveSug(dir) {
  setAcIdx(Math.max(0, Math.min(_acItems.length - 1, _acIdx + dir)));
}

function setAcIdx(i) {
  _acIdx = i;
  elSugBox.querySelectorAll('.sug-item').forEach((el, j) =>
    el.classList.toggle('active', j === i)
  );
}

function closeSug() {
  elSugBox.classList.remove('open');
  elSugBox.innerHTML = '';
  _acItems = [];
  _acIdx   = -1;
}

function submitSug(item) {
  closeSug();
  elInput.value = '';
  if (_ended) return;
  validate(item.name, item.id);
}

// ══════════════════════════════════════════════
//  VALIDATION
// ══════════════════════════════════════════════
function validate(name, id) {
  const map = _question._normMap;
  let hit = map.get(norm(name));
  if (!hit && id) hit = map.get(String(id));

  if (hit) {
    if (_found.has(hit.r)) { shakeInput(); return; }
    _found.add(hit.r);
    revealRow(hit, 'found');
    updateScore();
    if (_found.size === 10) { stopTimer(); setTimeout(() => endGame(true), 600); }
  } else {
    shakeInput();
  }
}

function shakeInput() {
  elInput.classList.remove('shake');
  void elInput.offsetWidth;
  elInput.classList.add('shake');
  elInput.addEventListener('animationend', () => elInput.classList.remove('shake'), { once: true });
}

// ══════════════════════════════════════════════
//  GAME END
// ══════════════════════════════════════════════
function endGame(won) {
  _ended = true;
  stopTimer();
  closeSug();
  elGiveupOverlay.classList.add('hidden');
  elInput.disabled = true;
  elGiveup.disabled = true;

  if (!_statsSaved) {
    _statsSaved = true;
    recordResult(_found.size);
    saveTodayResult(_question.id, [..._found], _found.size);
  }

  for (const p of _question.top10) {
    if (!_found.has(p.r)) revealRow(p, 'revealed');
  }

  setTimeout(() => showEndScreen(won), 900);
}

function showEndScreen(won) {
  elGame.classList.add('hidden');

  const n = _found.size;
  if (n === 10)    { elEndEmoji.textContent = '🏆'; elEndTitle.textContent = '¡Top perfecto!'; }
  else if (n >= 7) { elEndEmoji.textContent = '🥇'; elEndTitle.textContent = '¡Muy bien!'; }
  else if (n >= 4) { elEndEmoji.textContent = '🥈'; elEndTitle.textContent = 'Bien, pero podías más'; }
  else if (n >= 1) { elEndEmoji.textContent = '🥉'; elEndTitle.textContent = 'Malo el día…'; }
  else             { elEndEmoji.textContent = '😬'; elEndTitle.textContent = '¡Sin ninguno!'; }

  elEndSub.textContent = `${n} / 10 adivinados`;
  elEndQ.textContent   = _question.q;

  elEndRows.innerHTML = '';
  for (const p of _question.top10) {
    const iFound = _found.has(p.r);
    const row = makeRow(p);
    row.classList.add(iFound ? 'found' : 'revealed');
    row.querySelector('.name-text').textContent = p.n;
    elEndRows.appendChild(row);
  }

  elEnd.classList.remove('hidden');

  // Abrir estadísticas automáticamente siempre que termine la partida
  // (ganada o perdida), tras un breve delay para que se vea primero el
  // resultado antes de que aparezca el modal encima.
  setTimeout(openStats, 700);
}

// ══════════════════════════════════════════════
//  COMPARTIR RESULTADO (estilo Wordle)
// ══════════════════════════════════════════════
function topShare() {
  const n = _found.size;
  const squares = '🟩'.repeat(n) + '⬛'.repeat(Math.max(0, 10 - n));
  const text =
    `En el Top FutbolHUB · ${getTodayMadrid()}\n` +
    `${_question ? _question.q + '\n' : ''}` +
    `${n}/10\n${squares}\n` +
    window.location.origin + window.location.pathname;
  topDoShare(text, document.getElementById('top-share-btn'));
}

function topDoShare(text, btn) {
  const feedback = () => {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ ¡Copiado!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  };
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(feedback).catch(() => {});
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      feedback();
    } catch { /**/ }
  }
}

// ══════════════════════════════════════════════
//  STATS MODAL + COUNTDOWN
// ══════════════════════════════════════════════
function openStats() {
  renderStatsModal(loadStats());
  elStatsOverlay.classList.remove('hidden');
  startCountdown();
}

function closeStats() {
  elStatsOverlay.classList.add('hidden');
  stopCountdown();
}

function startCountdown() {
  stopCountdown();
  if (!elStatsCountdown) return;
  function tick() {
    const ms = getMsUntilMadridMidnight();
    elStatsCountdown.innerHTML =
      `Nuevo Top en <strong>${formatCountdown(ms)}</strong>`;
  }
  tick();
  _cdInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(_cdInterval);
  _cdInterval = null;
}

function renderStatsModal(stats) {
  const pct = stats.played > 0
    ? Math.round((stats.wins / stats.played) * 100)
    : 0;

  elStatsNums.innerHTML = '';
  [
    { val: stats.played,    label: 'Jugadas' },
    { val: stats.wins,      label: 'Victorias' },
    { val: pct + '%',       label: '%' },
    { val: stats.streak,    label: 'Racha' },
    { val: stats.maxStreak, label: 'Racha\nmáxima' },
  ].forEach(({ val, label }) => {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="stat-val">${val}</div><div class="stat-label">${label}</div>`;
    elStatsNums.appendChild(cell);
  });

  renderHistogram(stats.hist);
}

function renderHistogram(hist) {
  elStatsHistBars.innerHTML   = '';
  elStatsHistLabels.innerHTML = '';
  const maxCount     = Math.max(...hist, 1);
  const currentScore = _ended ? _found.size : null;

  hist.forEach((count, i) => {
    const isCurrent = currentScore !== null && i === currentScore;

    const col = document.createElement('div');
    col.className = 'hist-col';

    const bar = document.createElement('div');
    bar.className = 'hist-bar' + (isCurrent ? ' current' : '');
    bar.style.height = Math.max((count / maxCount) * 100, 4) + '%';

    const cnt = document.createElement('span');
    cnt.className = 'hist-count';
    cnt.textContent = count > 0 ? count : '';
    bar.appendChild(cnt);
    col.appendChild(bar);
    elStatsHistBars.appendChild(col);

    const lbl = document.createElement('div');
    lbl.className = 'hist-label' + (isCurrent ? ' current' : '');
    lbl.textContent = i;
    elStatsHistLabels.appendChild(lbl);
  });
}

// ══════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);
