/* =============================================
   GAME.JS — Wordle de FutbolHUB
   FutbolHUB

   Juego 14. La palabra de cada día está CURADA a mano (como La Carrera, El
   Crucigrama y En el Top): un JSON por mes en Supabase Storage
   (game-data/wordle/AAAA-MM.json), escrita libremente con
   admin/generar_wordle.py — sin restringirla a ningún banco ni a una
   longitud fija (decisión del usuario, 2026-08-27).

   El TABLERO se adapta a la longitud de la palabra del día (sin longitud
   fija), pero los INTENTOS son siempre 5 (decisión del usuario, 2026-08-27:
   "6 es mucho"), sea cual sea esa longitud. Los intentos que escribe quien
   juega tampoco están restringidos a ningún banco: vale cualquier
   combinación de letras de la misma longitud, y el juego da el mismo
   feedback de color le pegue o no significado (igual que el Wordle real,
   que valida contra un diccionario mucho más amplio que el de respuestas
   posibles).

   Mismo patrón de racha "por intento" que el resto de diarios (ver
   js/hub-streaks.js) y misma regla que La Carrera/El Crucigrama: SOLO la
   edición de HOY se guarda y cuenta para las estadísticas; las anteriores
   (el archivo) se pueden repetir libremente para practicar, sin persistir.
   ============================================= */
(function () {
  'use strict';

  const MAX_GUESSES = 5;

  /* ── Fecha (hora de Madrid, igual que el resto de diarios) ── */
  function madridToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  }
  const TODAY_REAL = madridToday();

  /* ── localStorage ── */
  function readJSON(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* nada */ }
  }
  const STATS_KEY = 'wordle-stats';

  function loadStats() {
    const s = readJSON(STATS_KEY);
    if (s && typeof s === 'object' && typeof s.played === 'number') {
      /* Partidas guardadas antes de la distribución de intentos no traen
         `dist`: se le añade en sitio en vez de perder el historial ya
         acumulado (played/wins/racha siguen contando desde el principio,
         solo la columna de intentos empieza a sumar desde ahora). */
      if (!Array.isArray(s.dist) || s.dist.length !== MAX_GUESSES) s.dist = new Array(MAX_GUESSES).fill(0);
      return s;
    }
    return { played: 0, wins: 0, currentStreak: 0, maxStreak: 0, dist: new Array(MAX_GUESSES).fill(0) };
  }
  function saveStats(s) { writeJSON(STATS_KEY, s); }

  /* ── Evaluación de un intento (algoritmo estándar de Wordle) ── */
  function evaluate(guess) {
    const len = answer.length;
    const result = new Array(len).fill('absent');
    const answerArr = answer.split('');
    const used = new Array(len).fill(false);
    for (let i = 0; i < len; i++) {
      if (guess[i] === answer[i]) { result[i] = 'correct'; used[i] = true; }
    }
    for (let i = 0; i < len; i++) {
      if (result[i] === 'correct') continue;
      let foundIdx = -1;
      for (let j = 0; j < len; j++) {
        if (!used[j] && answerArr[j] === guess[i]) { foundIdx = j; break; }
      }
      if (foundIdx !== -1) { result[i] = 'present'; used[foundIdx] = true; }
    }
    return result;
  }

  /* ── DOM ── */
  const $ = (id) => document.getElementById(id);
  const introScreen = $('screen-intro');
  const gameScreen = $('screen-game');
  const boardEl = $('wd-board');
  const keyboardEl = $('wd-keyboard');
  const dayLabelEls = document.querySelectorAll('.wd-day-label');
  const startBtn = $('wd-start-btn');
  const archiveTagEl = $('wd-archive-tag');
  const toastEl = $('toast');
  const elNav = $('day-nav');
  const elNavFirst = $('nav-first');
  const elNavPrev = $('nav-prev');
  const elNavNext = $('nav-next');
  const elNavLast = $('nav-last');
  const elNavLabel = $('nav-label');

  let current = '';        // letras de la fila que se está escribiendo
  let shakeTimer = null;

  /* ── Calendario: un JSON por mes, cacheado, cargado solo al navegar ── */
  const _monthCache = {};       // "AAAA-MM" -> { "AAAA-MM-DD": {word} }
  let _editions = [];            // fechas <= hoy, ASCENDENTE (edición 1 = la más antigua)
  let _idx = 0;
  let _ready = false;
  let _hoyFalta = false;
  let _loadSeq = 0;               // token: descarta una goEdition() que ya no es la última pedida

  let answer = null;
  let wordLen = 0;
  let _currentDate = null;       // fecha de la edición actualmente cargada
  let _isToday = false;
  let dayNumber = 0;             // posición en _editions, no días de calendario
  let state = { guesses: [], completed: false, won: false };

  function dayKeyFor(fecha) { return `wordle_day_${fecha}`; }

  async function loadMonth(mes) {
    if (_monthCache[mes]) return _monthCache[mes];
    const res = await fetch(sbStorageUrl('game-data', `wordle/${mes}.json`), { cache: 'no-cache' });
    if (!res.ok) throw new Error('mes no disponible');
    const j = await res.json();
    _monthCache[mes] = j.days || {};
    return _monthCache[mes];
  }

  function showScreen(name) {
    introScreen.classList.toggle('active', name === 'intro');
    gameScreen.classList.toggle('active', name === 'game');
  }

  function toast(msg, kind) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 1600);
  }

  function fatal(msg) {
    startBtn.disabled = true;
    startBtn.textContent = 'SIN CONEXIÓN';
    toast(msg);
  }

  /* ── Tablero ──
     El ancho de cada ficha se calcula en JS, no en CSS: con una palabra de
     5 letras el CSS a base de vw ya iba bien, pero una de 10-12 (hay
     apellidos y términos así) se saldría de la pantalla si no se encoge. */
  function applyCellSize() {
    if (!wordLen) return;
    const gap = 6;
    const maxRowWidth = Math.min(window.innerWidth * 0.94, 480);
    const raw = (maxRowWidth - (wordLen - 1) * gap) / wordLen;
    const size = Math.max(26, Math.min(60, Math.floor(raw)));
    boardEl.style.setProperty('--wd-cell', size + 'px');
  }
  window.addEventListener('resize', applyCellSize);

  function buildBoard() {
    applyCellSize();
    boardEl.innerHTML = '';
    for (let r = 0; r < MAX_GUESSES; r++) {
      const row = document.createElement('div');
      row.className = 'wd-row';
      row.dataset.row = String(r);
      for (let c = 0; c < wordLen; c++) {
        const cell = document.createElement('div');
        cell.className = 'wd-cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        row.appendChild(cell);
      }
      boardEl.appendChild(row);
    }
  }

  function cellAt(r, c) { return boardEl.querySelector(`.wd-cell[data-row="${r}"][data-col="${c}"]`); }
  function rowAt(r) { return boardEl.querySelector(`.wd-row[data-row="${r}"]`); }

  function paintGuessRow(rowIdx, word, result, animate) {
    for (let c = 0; c < word.length; c++) {
      const cell = cellAt(rowIdx, c);
      if (!cell) continue;
      cell.textContent = word[c];
      cell.classList.add('wd-cell--filled');
      const apply = () => cell.classList.add('wd-cell--' + result[c]);
      if (animate) {
        const delay = c * 90;
        cell.classList.add('wd-cell--flip');
        cell.style.animationDelay = delay + 'ms';
        /* setTimeout y no 'animationend': con prefers-reduced-motion la
           animación se desactiva por CSS (ver @media más abajo) y ese
           evento no llegaría a disparase nunca, dejando la ficha con la
           letra pero sin color para siempre. El color no puede depender de
           que la animación llegue a correr. */
        setTimeout(apply, delay + 250);
      } else {
        apply();
      }
    }
  }

  function paintCurrentRow() {
    const r = state.guesses.length;
    for (let c = 0; c < wordLen; c++) {
      const cell = cellAt(r, c);
      if (!cell) continue;
      cell.textContent = current[c] || '';
      cell.classList.toggle('wd-cell--filled', !!current[c]);
    }
  }

  function shakeRow(r) {
    const row = rowAt(r);
    if (!row) return;
    row.classList.remove('wd-row--shake');
    void row.offsetWidth;
    row.classList.add('wd-row--shake');
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => row.classList.remove('wd-row--shake'), 420);
  }

  /* ── Teclado ── */
  const ROWS = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ñ'],
    ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
  ];
  const keyState = {}; // letra -> 'correct' | 'present' | 'absent'

  function buildKeyboard() {
    keyboardEl.innerHTML = '';
    ROWS.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'wd-krow';
      row.forEach((k) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const wide = (k === 'ENTER' || k === '⌫');
        btn.className = 'wd-key' + (wide ? ' wd-key--wide' : '');
        btn.textContent = k === '⌫' ? '⌫' : k;
        btn.setAttribute('aria-label', k === 'ENTER' ? 'Enviar' : (k === '⌫' ? 'Borrar' : k));
        btn.dataset.key = k;
        btn.addEventListener('click', () => handleKey(k));
        rowEl.appendChild(btn);
      });
      keyboardEl.appendChild(rowEl);
    });
  }

  function refreshKeyboardColors() {
    keyboardEl.querySelectorAll('.wd-key[data-key]').forEach((btn) => {
      const k = btn.dataset.key;
      btn.classList.remove('wd-key--correct', 'wd-key--present', 'wd-key--absent');
      const st = keyState[k];
      if (st) btn.classList.add('wd-key--' + st);
    });
  }

  function updateKeyState(word, result) {
    for (let i = 0; i < word.length; i++) {
      const letter = word[i];
      const val = result[i];
      const prev = keyState[letter];
      const rank = { absent: 0, present: 1, correct: 2 };
      if (!prev || rank[val] > rank[prev]) keyState[letter] = val;
    }
  }

  /* ── Entrada ── */
  function handleKey(k) {
    if (!_ready || state.completed) return;
    if (k === 'ENTER') { submitGuess(); return; }
    if (k === '⌫') {
      current = current.slice(0, -1);
      paintCurrentRow();
      return;
    }
    if (current.length >= wordLen) return;
    current += k;
    paintCurrentRow();
  }

  function normalizeKeyEvent(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.key === 'Enter') return 'ENTER';
    if (e.key === 'Backspace') return '⌫';
    if (e.key.length === 1) {
      const up = e.key.toUpperCase();
      if (/^[A-ZÑ]$/.test(up)) return up;
    }
    return null;
  }

  document.addEventListener('keydown', (e) => {
    if (!gameScreen.classList.contains('active')) return;
    if (isOverlayOpen()) return;
    const k = normalizeKeyEvent(e);
    if (!k) return;
    e.preventDefault();
    handleKey(k);
  });

  function isOverlayOpen() {
    const r = $('wd-result-overlay');
    const ru = $('wd-rules-overlay');
    const st = $('wd-stats-overlay');
    return (r && !r.classList.contains('hidden')) ||
           (ru && !ru.classList.contains('hidden')) ||
           (st && !st.classList.contains('hidden'));
  }

  function submitGuess() {
    if (current.length < wordLen) {
      shakeRow(state.guesses.length);
      toast('Faltan letras');
      return;
    }
    const guess = current;
    const result = evaluate(guess);
    const rowIdx = state.guesses.length;
    state.guesses.push({ word: guess, result });
    updateKeyState(guess, result);

    const won = result.every((r) => r === 'correct');
    const outOfTries = state.guesses.length >= MAX_GUESSES;
    current = '';

    paintGuessRow(rowIdx, guess, result, true);

    const finishNow = won || outOfTries;
    if (finishNow) {
      state.completed = true;
      state.won = won;
      /* Solo la edición de HOY cuenta para estadísticas y racha (mismo
         criterio que La Carrera y El Crucigrama): el archivo es para
         practicar y no debe alterar un historial ya cerrado. */
      if (_isToday) finalizeStats(won);
    }
    if (_isToday) writeJSON(dayKeyFor(_currentDate), state);

    const revealMs = wordLen * 90 + 420;
    if (finishNow) {
      setTimeout(() => {
        refreshKeyboardColors();
        openResult();
      }, revealMs);
    } else {
      setTimeout(refreshKeyboardColors, revealMs);
    }
  }

  function finalizeStats(won) {
    if (state._statsCounted) return;
    state._statsCounted = true;
    const s = loadStats();
    s.played += 1;
    if (won) {
      s.wins += 1;
      s.currentStreak += 1;
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
      const idx = state.guesses.length - 1;
      if (idx >= 0 && idx < s.dist.length) s.dist[idx] += 1;
    } else {
      s.currentStreak = 0;
    }
    saveStats(s);
  }

  /* ── Restaurar la partida guardada de HOY, o partida nueva ──
     Los días de archivo NUNCA se guardan (se puede repetir el intento
     tantas veces como quieras, es para practicar): cada visita a un día
     pasado empieza en blanco. */
  function loadStateForEdition() {
    /* Sin esto, la fila que estabas escribiendo (p.ej. "BA" de una palabra
       de 5 letras) sobrevivía al cambiar de edición con el navegador de
       días y se colaba en el tablero nuevo — incluso con otra longitud de
       palabra, dejando letras sueltas en la fila 1 que no habías escrito
       para esa edición. */
    current = '';
    if (_isToday) {
      const saved = readJSON(dayKeyFor(_currentDate));
      if (saved && saved.answer === answer && Array.isArray(saved.guesses)) {
        state = saved;
        return;
      }
    }
    state = { date: _currentDate, answer, guesses: [], completed: false, won: false };
  }

  function restoreBoard() {
    buildBoard();
    state.guesses.forEach((g, i) => paintGuessRow(i, g.word, g.result, false));
    Object.keys(keyState).forEach((k) => delete keyState[k]);
    state.guesses.forEach((g) => updateKeyState(g.word, g.result));
    refreshKeyboardColors();
    if (!state.completed) paintCurrentRow();
  }

  /* ── Pantalla de resultado ── */
  function buildShareText() {
    const lines = state.guesses.map((g) => g.result.map((r) => {
      if (r === 'correct') return '🟩';
      if (r === 'present') return '🟨';
      return '⬛';
    }).join(''));
    const score = state.won ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    return `FutbolHUB · Wordle #${dayNumber} ${score}\n\n${lines.join('\n')}\n\nfutbolhub.es/wordle/`;
  }

  async function shareResult() {
    const text = buildShareText();
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch { /* cancelado, seguir al portapapeles */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado al portapapeles', 'ok');
    } catch {
      toast('No se ha podido copiar');
    }
  }

  function renderStatsInto(container) {
    const s = loadStats();
    const pct = s.played ? Math.round((s.wins / s.played) * 100) : 0;
    container.innerHTML = `
      <div class="wd-stat"><span class="wd-stat-num">${s.played}</span><span class="wd-stat-lbl">Jugadas</span></div>
      <div class="wd-stat"><span class="wd-stat-num">${pct}</span><span class="wd-stat-lbl">% victorias</span></div>
      <div class="wd-stat"><span class="wd-stat-num">${s.currentStreak}</span><span class="wd-stat-lbl">Racha actual</span></div>
      <div class="wd-stat"><span class="wd-stat-num">${s.maxStreak}</span><span class="wd-stat-lbl">Mejor racha</span></div>
    `;
    return s;
  }

  /* ── Distribución de intentos (columnas: en qué intento lo conseguiste) ──
     `today` marca la fila de la partida que se está mostrando en ESE
     momento: un número de intento (1..MAX_GUESSES) si se ganó, 'fail' si se
     perdió, o null si no aplica (p.ej. abriendo Estadísticas desde el menú
     sin haber jugado hoy). Solo resalta la fila si la partida es de HOY: el
     archivo no cuenta para el historial y no debe fingir que sí. */
  function todayDistHighlight() {
    if (!_isToday || !state.completed) return null;
    return state.won ? state.guesses.length : 'fail';
  }

  function renderDistInto(container, s, today) {
    const rows = s.dist.map((count, i) => ({ label: String(i + 1), count, isToday: today === i + 1 }));
    const fails = Math.max(0, s.played - s.wins);
    rows.push({ label: '✕', count: fails, isToday: today === 'fail' });
    const maxCount = Math.max(1, ...rows.map((r) => r.count));
    container.innerHTML = rows.map((r) => {
      const pct = Math.max(8, Math.round((r.count / maxCount) * 100));
      return `<div class="wd-dist-row">
        <span class="wd-dist-n">${r.label}</span>
        <span class="wd-dist-track"><span class="wd-dist-fill${r.isToday ? ' wd-dist-fill--today' : ''}" style="width:${pct}%"><span class="wd-dist-count${r.count === 0 ? ' wd-dist-count--out' : ''}">${r.count}</span></span></span>
      </div>`;
    }).join('');
  }

  function nextPuzzleCountdown(el) {
    function tick() {
      const now = new Date();
      const madridNowStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Madrid', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      const h = +madridNowStr.hour, m = +madridNowStr.minute, s = +madridNowStr.second;
      const remaining = (24 * 3600) - (h * 3600 + m * 60 + s);
      const hh = String(Math.floor(remaining / 3600)).padStart(2, '0');
      const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      el.textContent = `Próximo Wordle en ${hh}:${mm}:${ss}`;
    }
    tick();
    clearInterval(el._t);
    el._t = setInterval(tick, 1000);
  }

  function openResult() {
    const overlay = $('wd-result-overlay');
    const title = $('wd-result-title');
    const answerEl = $('wd-result-answer');
    const grid = $('wd-result-grid');
    const statsBox = $('wd-result-stats');
    const countdownEl = $('wd-result-countdown');

    title.textContent = state.won ? '¡Acertaste!' : 'Se acabaron los intentos';
    title.classList.toggle('wd-result-title--win', state.won);
    title.classList.toggle('wd-result-title--lose', !state.won);
    answerEl.textContent = `La palabra era ${answer}`;

    grid.innerHTML = '';
    state.guesses.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'wd-mini-row';
      g.result.forEach((r) => {
        const sq = document.createElement('span');
        sq.className = 'wd-mini wd-mini--' + r;
        row.appendChild(sq);
      });
      grid.appendChild(row);
    });

    const s = renderStatsInto(statsBox);
    renderDistInto($('wd-result-dist'), s, state.won ? state.guesses.length : 'fail');
    nextPuzzleCountdown(countdownEl);

    overlay.classList.remove('hidden');
  }
  function closeResult() { $('wd-result-overlay').classList.add('hidden'); }

  function openRules() { $('wd-rules-overlay').classList.remove('hidden'); }
  function closeRules() { $('wd-rules-overlay').classList.add('hidden'); }

  function openStats() {
    const overlay = $('wd-stats-overlay');
    const s = renderStatsInto($('wd-stats-nums'));
    renderDistInto($('wd-stats-dist'), s, todayDistHighlight());
    overlay.classList.remove('hidden');
  }
  function closeStats() { $('wd-stats-overlay').classList.add('hidden'); }

  /* ── Calendario / navegación de ediciones ── */
  function updateDayLabels() {
    dayLabelEls.forEach((el) => { el.textContent = '#' + dayNumber; });
  }

  function updateArchiveTag() {
    if (archiveTagEl) archiveTagEl.classList.toggle('hidden', _isToday);
  }

  function _fechaLarga(iso) {
    const M = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const p = String(iso).split('-');
    return p.length === 3 ? `${parseInt(p[2], 10)} de ${M[parseInt(p[1], 10) - 1]}` : iso;
  }

  function renderAvisoAtrasada(fechaMostrada) {
    const anfitrion = $('screen-intro');
    if (!anfitrion) return;
    let el = document.getElementById('wd-aviso-atrasada');
    const debeVerse = _hoyFalta && fechaMostrada === _editions[_editions.length - 1];
    if (!debeVerse) { if (el) el.classList.add('hidden'); return; }
    if (!el) {
      el = document.createElement('p');
      el.id = 'wd-aviso-atrasada';
      el.className = 'fh-atrasado';
      const wrap = document.getElementById('wd-body');
      wrap.insertBefore(el, wrap.firstChild);
    }
    el.classList.remove('hidden');
    el.textContent = `La palabra de hoy todavía no está lista. Mientras tanto, aquí tienes la del ${_fechaLarga(fechaMostrada)}.`;
  }

  function renderNav() {
    if (!elNav) return;
    elNav.classList.remove('hidden');
    const n = _editions.length;
    const atStart = _idx <= 0, atEnd = _idx >= n - 1;
    elNavFirst.disabled = atStart;
    elNavPrev.disabled = atStart;
    elNavNext.disabled = atEnd;
    elNavLast.disabled = atEnd;
    elNavLabel.textContent = `#${_idx + 1}`;
  }

  function updateStartButtonLabel() {
    if (!_ready) return;
    if (_isToday && state.completed) startBtn.textContent = 'VER RESULTADO';
    else if (_isToday && state.guesses.length > 0) startBtn.textContent = 'CONTINUAR ▶';
    else startBtn.textContent = 'JUGAR ▶';
  }

  /* Prepara la edición idx: descarga (si hace falta) el mes, monta el
     tablero y el teclado, y actualiza toda la interfaz de calendario.
     No cambia de pantalla — eso lo decide quien la llame. */
  async function goEdition(idx, desdeAtras) {
    idx = Math.max(0, Math.min(_editions.length - 1, idx));
    _idx = idx;
    const fecha = _editions[idx];
    const mes = fecha.slice(0, 7);

    /* Token de secuencia: si mientras esta llamada espera la red se pide
       OTRA edición (doble clic en el navegador de días), esta se queda
       obsoleta y no debe pisar lo que haya dejado la más reciente al
       terminar — sin esto, una respuesta que tarda más podía resolver
       DESPUÉS y sobrescribir answer/wordLen con los de una edición que ya
       no es la que se ve en pantalla: el marcador diría una cosa y el
       intento se evaluaría contra otra palabra. */
    const seq = ++_loadSeq;

    if (window.FHRuta && !desdeAtras) {
      FHRuta.set({ dia: fecha === TODAY_REAL ? null : fecha }, { push: true });
    }

    let dias;
    try {
      dias = await loadMonth(mes);
    } catch {
      if (seq === _loadSeq) fatal('No se ha podido cargar esa edición. Prueba con otra.');
      return;
    }
    if (seq !== _loadSeq) return;   // otra llamada más reciente ya está en marcha
    const entry = dias[fecha];
    const rawWord = entry && String(entry.word || '').trim().toUpperCase();
    if (!rawWord) {
      fatal('Esa edición no está donde debería. Prueba con otra.');
      return;
    }

    answer = rawWord;
    wordLen = answer.length;
    _currentDate = fecha;
    _isToday = (fecha === TODAY_REAL);
    dayNumber = idx + 1;

    loadStateForEdition();
    restoreBoard();
    updateDayLabels();
    updateArchiveTag();
    renderNav();
    renderAvisoAtrasada(fecha);
    updateStartButtonLabel();
  }

  function enterGame() {
    if (!_ready) return;
    showScreen('game');
    if (_isToday && state.completed) setTimeout(openResult, 150);
  }

  /* ── Arranque ── */
  async function start() {
    buildKeyboard();
    startBtn.textContent = 'CARGANDO…';
    startBtn.disabled = true;

    let idxJson;
    try {
      const res = await fetch(sbStorageUrl('game-data', 'wordle/index.json'), { cache: 'no-cache' });
      if (!res.ok) throw new Error('sin índice');
      idxJson = await res.json();
    } catch {
      fatal('No se ha podido cargar el calendario de Wordle. Prueba a recargar la página.');
      return;
    }

    const dias = Array.isArray(idxJson.days) ? idxJson.days : [];
    _editions = dias.filter((d) => d <= TODAY_REAL).sort();
    if (!_editions.length) {
      fatal('Todavía no hay ninguna palabra publicada.');
      return;
    }

    const i = _editions.indexOf(TODAY_REAL);
    _hoyFalta = i < 0;

    const pedido = window.FHRuta && FHRuta.fecha('dia');
    const iPedido = pedido ? _editions.indexOf(pedido) : -1;

    if (window.FHRuta) FHRuta.alVolver(() => {
      const d = FHRuta.fecha('dia') || TODAY_REAL;
      const k = _editions.indexOf(d);
      if (k >= 0 && k !== _idx) goEdition(k, true);
    });

    await goEdition(iPedido >= 0 ? iPedido : (i >= 0 ? i : _editions.length - 1), true);

    if (window.FHRuta) {
      const real = _editions[_idx];
      FHRuta.set({ dia: real === TODAY_REAL ? null : real });
    }

    _ready = true;
    startBtn.disabled = false;
    updateStartButtonLabel();
  }

  startBtn.addEventListener('click', enterGame);
  $('wd-rules-btn').addEventListener('click', openRules);
  $('wd-rules-close').addEventListener('click', closeRules);
  $('wd-rules-backdrop').addEventListener('click', closeRules);
  $('wd-stats-open-btn').addEventListener('click', openStats);
  $('wd-stats-close').addEventListener('click', closeStats);
  $('wd-stats-backdrop').addEventListener('click', closeStats);
  $('wd-result-close').addEventListener('click', closeResult);
  $('wd-result-backdrop').addEventListener('click', closeResult);
  $('wd-result-share-btn').addEventListener('click', shareResult);
  $('wd-menu-btn').addEventListener('click', () => { closeResult(); showScreen('intro'); updateStartButtonLabel(); });

  if (elNavFirst) elNavFirst.addEventListener('click', () => goEdition(0));
  if (elNavPrev)  elNavPrev.addEventListener('click', () => goEdition(_idx - 1));
  if (elNavNext)  elNavNext.addEventListener('click', () => goEdition(_idx + 1));
  if (elNavLast)  elNavLast.addEventListener('click', () => goEdition(_editions.length - 1));

  window.Wordle = { shareResult };

  start();
})();
