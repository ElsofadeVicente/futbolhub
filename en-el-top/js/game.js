/* ══════════════════════════════════════════════
   EN EL TOP — game.js
   ══════════════════════════════════════════════ */
'use strict';

// ── Paths ──────────────────────────────────────
const PATH_QUESTIONS  = 'data/enteltop.json';
const PATH_NAME_INDEX = '../data/players/name-index.json';
const TIMER_TOTAL     = 60;

// ── Flag image ─────────────────────────────────
// TM codes → ISO/flagcdn remapping for subdivisions
const FLAG_REMAP = {
  en: 'gb-eng', sco: 'gb-sct', wls: 'gb-wls', nir: 'gb-nir',
};
function flagUrl(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  return `https://flagcdn.com/w40/${FLAG_REMAP[c] || c}.png`;
}

// ── Text normalization (same as other games) ───
function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Daily question selector ────────────────────
function getDailyQuestion(questions) {
  if (!questions || !questions.length) return null;
  const day = Math.floor(Date.now() / 86400000); // days since epoch (UTC)
  return questions[day % questions.length];
}

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let _questions  = [];     // all questions from enteltop.json
let _question   = null;   // today's question
let _nameIndex  = [];     // [[id, name], ...]
let _found      = new Set(); // set of r values (1–10) guessed correctly
let _timeLeft   = TIMER_TOTAL;
let _timerInterval = null;
let _ended      = false;

// Autocomplete state
let _acItems    = [];
let _acIdx      = -1;
let _acDebounce = null;

// ── Element refs (filled after DOMContentLoaded) ──
let elLoading, elGame, elEnd;
let elTimerFill, elTimerNum;
let elScore, elTitle, elRowsWrap;
let elInput, elSugBox, elGiveup;
let elEndEmoji, elEndTitle, elEndSub, elEndQ, elEndRows;

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
async function init() {
  // Grab elements
  elLoading   = document.getElementById('loading-screen');
  elGame      = document.getElementById('game-screen');
  elEnd       = document.getElementById('end-screen');
  elTimerFill = document.getElementById('timer-fill');
  elTimerNum  = document.getElementById('timer-num');
  elScore     = document.getElementById('score-badge');
  elTitle     = document.getElementById('question-title');
  elRowsWrap  = document.getElementById('rows-wrap');
  elInput     = document.getElementById('ans-input');
  elSugBox    = document.getElementById('sug-box');
  elGiveup    = document.getElementById('giveup-btn');
  elEndEmoji  = document.getElementById('end-emoji');
  elEndTitle  = document.getElementById('end-title');
  elEndSub    = document.getElementById('end-sub');
  elEndQ      = document.getElementById('end-q');
  elEndRows   = document.getElementById('end-rows');

  // Load data
  try {
    const [qs, ni] = await Promise.all([
      fetch(PATH_QUESTIONS).then(r => r.json()),
      fetch(PATH_NAME_INDEX).then(r => r.json()),
    ]);
    _questions  = qs;
    _nameIndex  = ni;
  } catch (e) {
    elLoading.innerHTML = `<p style="color:#ef4444">Error al cargar datos.<br>${e.message}</p>`;
    return;
  }

  _question = getDailyQuestion(_questions);
  if (!_question) {
    elLoading.innerHTML = '<p style="color:#ef4444">No hay preguntas disponibles.</p>';
    return;
  }

  // Build normalized lookup for the top10
  _question._normMap = buildNormMap(_question.top10);

  // Render & start
  renderGame();
  bindEvents();
  elLoading.classList.add('hidden');
  elGame.classList.remove('hidden');
  startTimer();
  elInput.focus();
}

// ── Build normalized name → top10 entry map ───
function buildNormMap(top10) {
  const map = new Map();
  for (const p of top10) {
    map.set(norm(p.n), p);
    if (p.id) map.set(String(p.id), p); // also index by TM id
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

  // rank
  const rank = document.createElement('div');
  rank.className = 'row-rank';
  rank.textContent = `${p.r}.`;

  // flag
  const flagCell = document.createElement('div');
  const url = (_question.hint === 'nat') ? flagUrl(p.nat) : null;
  if (url) {
    flagCell.className = 'row-flag';
    const img = document.createElement('img');
    img.src = url;
    img.alt = p.nat || '';
    img.onerror = () => { img.style.display = 'none'; };
    flagCell.appendChild(img);
  } else {
    flagCell.className = 'row-flag empty';
  }

  // name
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
  // state: 'found' | 'revealed'
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
  _timeLeft = TIMER_TOTAL;
  updateTimerUI(_timeLeft);
  const start = Date.now();

  _timerInterval = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    _timeLeft = Math.max(0, TIMER_TOTAL - elapsed);
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
  const pct = (t / TIMER_TOTAL) * 100;
  elTimerFill.style.width = pct + '%';
  elTimerFill.classList.toggle('low',    t <= 15 && t > 5);
  elTimerFill.classList.toggle('urgent', t <= 5);
  elTimerNum.textContent = Math.ceil(t);
  elTimerNum.classList.toggle('low', t <= 10);
}

// ══════════════════════════════════════════════
//  INPUT & AUTOCOMPLETE
// ══════════════════════════════════════════════
function bindEvents() {
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
      if (_acIdx >= 0 && _acItems[_acIdx]) {
        submitSug(_acItems[_acIdx]);
      } else if (_acItems.length === 1) {
        submitSug(_acItems[0]);
      }
    }
  });

  document.addEventListener('click', e => {
    if (!elSugBox.contains(e.target) && e.target !== elInput) closeSug();
  });

  elGiveup.addEventListener('click', () => {
    if (_ended) return;
    if (confirm('¿Rendirse y ver las respuestas?')) endGame(false);
  });
}

// ── Word-boundary search ──────────────────────
function wordBoundaryMatch(n, q) {
  const words = n.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words.slice(i).join(' ').startsWith(q)) return true;
  }
  return false;
}

// ── Build suggestions from name-index ─────────
function buildSug(query) {
  const q = norm(query);
  let exact = [], starts = [], wordBound = [], contains = [];

  for (const [id, name] of _nameIndex) {
    const n = norm(name);
    if      (n === q)                 exact.push([id, name]);
    else if (n.startsWith(q))         starts.push([id, name]);
    else if (wordBoundaryMatch(n, q)) wordBound.push([id, name]);
    else if (n.includes(q))           contains.push([id, name]);
    // Early exit once we have enough
    if (exact.length + starts.length + wordBound.length >= 10 && contains.length >= 4) break;
  }

  const combined = [
    ...exact.map(([id, name]) => ({ id, name, cat: 0 })),
    ...starts.map(([id, name]) => ({ id, name, cat: 1 })),
    ...wordBound.map(([id, name]) => ({ id, name, cat: 2 })),
    ...contains.map(([id, name]) => ({ id, name, cat: 3 })),
  ].slice(0, 8);

  renderSug(combined, query);
}

// ── Render suggestions ────────────────────────
function renderSug(items, query) {
  _acItems = items;
  _acIdx   = -1;

  if (!items.length) { closeSug(); return; }

  elSugBox.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'sug-item';
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
  const newIdx = Math.max(-1, Math.min(_acItems.length - 1, _acIdx + dir));
  setAcIdx(newIdx);
}

function setAcIdx(i) {
  _acIdx = i;
  const els = elSugBox.querySelectorAll('.sug-item');
  els.forEach((el, j) => el.classList.toggle('active', j === i));
}

function closeSug() {
  elSugBox.classList.remove('open');
  elSugBox.innerHTML = '';
  _acItems = [];
  _acIdx   = -1;
}

// ── Submit suggestion ─────────────────────────
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

  // Try by normalized name
  let hit = map.get(norm(name));

  // Try by TM id if not found by name
  if (!hit && id) hit = map.get(String(id));

  if (hit) {
    if (_found.has(hit.r)) {
      // Already guessed
      shakeInput();
      return;
    }
    _found.add(hit.r);
    revealRow(hit, 'found');
    updateScore();

    if (_found.size === 10) {
      stopTimer();
      setTimeout(() => endGame(true), 600);
    }
  } else {
    shakeInput();
  }
}

function shakeInput() {
  elInput.classList.remove('shake');
  void elInput.offsetWidth; // reflow to restart animation
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
  elInput.disabled = true;
  elGiveup.disabled = true;

  // Reveal all unfound rows
  for (const p of _question.top10) {
    if (!_found.has(p.r)) {
      revealRow(p, 'revealed');
    }
  }

  // Transition to end screen after a brief pause
  setTimeout(() => showEndScreen(won), 900);
}

function showEndScreen(won) {
  elGame.classList.add('hidden');

  // Emoji + title
  const n = _found.size;
  if (n === 10) {
    elEndEmoji.textContent = '🏆';
    elEndTitle.textContent  = '¡Top perfecto!';
  } else if (n >= 7) {
    elEndEmoji.textContent = '🥇';
    elEndTitle.textContent  = '¡Muy bien!';
  } else if (n >= 4) {
    elEndEmoji.textContent = '🥈';
    elEndTitle.textContent  = 'Bien, pero podías más';
  } else if (n >= 1) {
    elEndEmoji.textContent = '🥉';
    elEndTitle.textContent  = 'Malo el día…';
  } else {
    elEndEmoji.textContent = '😬';
    elEndTitle.textContent  = '¡Sin ninguno!';
  }

  elEndSub.textContent  = `${n}/10 adivinados`;
  elEndQ.textContent    = _question.q;

  // Render full top 10 in end screen
  elEndRows.innerHTML = '';
  for (const p of _question.top10) {
    const iFound = _found.has(p.r);
    const row = makeRow(p);
    row.classList.add(iFound ? 'found' : 'revealed');
    row.querySelector('.name-text').textContent = p.n;
    elEndRows.appendChild(row);
  }

  elEnd.classList.remove('hidden');
}

// ══════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);
