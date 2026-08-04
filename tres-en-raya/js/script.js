/* =============================================================================
   TRES EN RAYA — script principal
   Motor de restricciones compartido: window.FR (js/futbol-restrictions.js)
   ============================================================================= */
'use strict';

window._AppReal = (function () {

  /* Familias de restriccion permitidas en las cabeceras:
     nucleo (club, pais, trofeos, entrenador) + ligas + continentes +
     compañero-de + numeros/goles. */
  /* Solo familias con cabecera CLARA y con IMAGEN real (logo, bandera, trofeo,
     foto de entrenador/compañero). Nada de emojis (goles, internacionalidades…). */
  const ALLOWED_FAMILIES = [
    'club', 'nationality',
    'league', 'league_general',
    'continent',
    'coach', 'teammate',
    'trophy_individual', 'trophy_domestic', 'trophy_intl', 'trophy_national',
  ];
  const MIN_CELL = 2;     /* jugadores reconocibles minimos por casilla */
  const WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8],   /* filas */
    [0,3,6],[1,4,7],[2,5,8],   /* columnas */
    [0,4,8],[2,4,6],           /* diagonales */
  ];

  /* ── Estado ── */
  let currentTab = 'local';
  let dataReady  = false;
  let G = null;   /* estado de partida (grid, board, turn, players, ...) */
  let pickIdx = -1;
  let acItems = [], acIndex = -1;
  let _finishTimer = null;   /* fin online: retardo cancelable para ver la línea */
  let _roundTimer = null;    /* pausa entre rondas de la serie */
  let localTarget = 3;       /* victorias para ganar (modo local) */
  let hostTarget  = 3;       /* victorias para ganar (host online) */
  const TARGET_MIN = 1, TARGET_MAX = 9;
  const PUBLIC_TARGET = 3;   /* en partidas públicas el objetivo es fijo (rival aleatorio) */

  function adjustTarget(which, delta) {
    if (which === 'local') {
      localTarget = Math.max(TARGET_MIN, Math.min(TARGET_MAX, localTarget + delta));
      const el = $('local-target-display'); if (el) el.textContent = localTarget;
    } else {
      hostTarget = Math.max(TARGET_MIN, Math.min(TARGET_MAX, hostTarget + delta));
      const el = $('host-target-display'); if (el) el.textContent = hostTarget;
    }
  }

  /* ═══════════════ UTILIDADES ═══════════════ */
  const $  = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = $(id); if (el) el.classList.add('active');
  }
  let _toastT = null;
  function showToast(msg, kind) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg;
    /* Mismas clases que Coche: base + 'error' | 'warning' (ok = sin variante). */
    const variant = kind === 'err' ? ' error' : kind === 'ok' ? '' : (kind ? ' ' + kind : '');
    t.className = 'toast show' + variant;
    clearTimeout(_toastT);
    _toastT = setTimeout(() => { t.className = 'toast'; }, 2200);
  }

  /* Etiqueta corta para las cabeceras */
  function shortLabel(r) {
    switch (r.type) {
      case 'club':        return r.display || r.value;
      case 'nationality': return r.label;                                  // adjetivo (p.ej. "Uruguayo")
      case 'coach':       return 'DT ' + r.value.split(' ').slice(-1)[0];  // "DT Guardiola"
      case 'teammate':    return r.label;                                  // "Compañero de Reina"
      case 'league':      return r.value;
      case 'league_any':  return r.label.replace(/^Ha jugado en\s+/, '');
      case 'continent':   return r.label.replace(/^Continente\s+/, '');    // "Americano"
      default:
        return r.label
          .replace(/^Ganador\s+/, '')
          .replace(/^Ha jugado en\s+/, '')
          .replace(' en una temporada de liga', '/temporada')
          .replace(' en Champions', ' Champions')
          .replace(' con su selección', ' selección')
          .replace(' o más internacionalidades', '+ internac.')
          .replace(' o menos internacionalidades', '– internac.');
    }
  }
  /* Los entrenadores y compañeros son FOTOS (avatar circular); logos, banderas
     y trofeos van contenidos sin recortar. */
  function hdrMediaHtml(r) {
    const isAvatar = r.type === 'coach' || r.type === 'teammate';
    if (r.imgUrl) {
      return `<span class="hdr-media${isAvatar ? ' hdr-media--avatar' : ''}"><img src="${esc(r.imgUrl)}" alt="" loading="lazy" onerror="this.closest('.hdr-media').classList.add('hdr-media--broken')"></span>`;
    }
    return `<span class="hdr-emoji">${r.icon || '⚽'}</span>`;
  }

  /* ═══════════════ GENERADOR DE REJILLA ═══════════════ */
  /* Elige 3 cabeceras de fila + 3 de columna tal que las 9 intersecciones
     tengan >= min jugadores reconocibles y ninguna pareja sea redundante. */
  function buildGrid(seed, minCell) {
    const rng  = FR.rng.mulberry32(seed);
    /* Solo candidatos CON imagen real (descarta cualquiera sin imgUrl, p.ej. un
       compañero sin foto). Determinista: mismo imgUrl en ambos clientes. */
    const pool = FR.rng.shuffle(
      FR.buildCandidates(rng, { families: ALLOWED_FAMILIES }).filter(c => c.imgUrl),
      rng
    );
    const genPool = FR.genPool;
    const POS = ['r0','c0','r1','c1','r2','c2'];   /* intercalado: cruces pronto */
    const chosen = {};
    let trials = 0;
    const CAP = 60000;

    const familyOf = (r) => r.family || r.type;
    function familyTaken(cand) {
      const f = familyOf(cand);
      return Object.values(chosen).some(r => familyOf(r) === f);
    }
    function opposites(key) {
      const opp = key[0] === 'r' ? 'c' : 'r';
      return Object.keys(chosen).filter(k => k[0] === opp).map(k => chosen[k]);
    }
    function fill(idx) {
      if (idx >= POS.length) return true;
      const key = POS[idx];
      const opp = opposites(key);
      for (const cand of pool) {
        if (++trials > CAP) return false;
        if (Object.values(chosen).includes(cand)) continue;
        if (familyTaken(cand)) continue;
        let ok = true;
        for (const o of opp) {
          if (FR.isRedundant(cand, o) || FR.isRedundant(o, cand)) { ok = false; break; }
          if (FR.countMatchingPair(cand, o, genPool, minCell) < minCell) { ok = false; break; }
        }
        if (!ok) continue;
        chosen[key] = cand;
        if (fill(idx + 1)) return true;
        delete chosen[key];
      }
      return false;
    }
    if (!fill(0)) return null;
    return { rows: [chosen.r0, chosen.r1, chosen.r2], cols: [chosen.c0, chosen.c1, chosen.c2] };
  }

  /* Devuelve {grid, seed, min} — seed+min permiten reconstruir EXACTAMENTE la
     misma rejilla en el rival online (buildGrid es determinista con FR.genPool,
     igual en ambos clientes). */
  function generateGrid() {
    for (const min of [MIN_CELL, 1]) {
      for (let k = 0; k < 40; k++) {
        const seed = (Math.random() * 2 ** 31) | 0;
        const grid = buildGrid(seed, min);
        if (grid) return { grid, seed, min };
      }
    }
    return null;
  }
  function rebuildGrid(seed, min) { return buildGrid(seed, min); }

  /* ═══════════════ RENDER DEL TABLERO ═══════════════ */
  function renderBoard() {
    const board = $('board');
    let html = `<div class="cell-corner"><span class="corner-ball">⚽</span></div>`;
    /* cabeceras de columna */
    for (let c = 0; c < 3; c++) {
      const r = G.grid.cols[c];
      html += `<div class="hdr hdr-col">${hdrMediaHtml(r)}<span class="hdr-label">${esc(shortLabel(r))}</span></div>`;
    }
    /* filas */
    for (let row = 0; row < 3; row++) {
      const rr = G.grid.rows[row];
      html += `<div class="hdr hdr-row">${hdrMediaHtml(rr)}<span class="hdr-label">${esc(shortLabel(rr))}</span></div>`;
      for (let col = 0; col < 3; col++) {
        const i = row * 3 + col;
        const cell = G.board[i];
        if (cell) {
          const cls = cell.owner === 0 ? 'p1' : 'p2';
          const mk  = cell.owner === 0 ? '✕' : '◯';
          const photo = cell.img
            ? `<span class="cell-photo"><img src="${esc(cell.img)}" alt="" onerror="this.closest('.cell-photo').style.display='none'"></span>`
            : '';
          html += `<div class="cell filled ${cls}" data-i="${i}"><span class="cell-mark">${mk}</span>${photo}<span class="cell-pname">${esc(cell.name)}</span></div>`;
        } else {
          const myTurn = G.mode !== 'online' || G.turn === G.myIdx;
          const playable = (!G.over && myTurn) ? ' playable' : '';
          html += `<div class="cell${playable}" data-i="${i}" onclick="App.pickCell(${i})"></div>`;
        }
      }
    }
    board.innerHTML = html;
    highlightWin();
  }

  function highlightWin() {
    if (!G.winLine) return;
    G.winLine.forEach(i => {
      const el = document.querySelector(`.cell[data-i="${i}"]`);
      if (el) el.classList.add('win');
    });
  }

  function renderScore() {
    const series = G.series || [0, 0];
    $('name-p1').textContent = G.players[0].name;
    $('name-p2').textContent = G.players[1].name;
    $('num-p1').textContent  = series[0];   /* marcador = victorias de la SERIE */
    $('num-p2').textContent  = series[1];
    $('score-p1').classList.toggle('active', !G.over && G.turn === 0);
    $('score-p2').classList.toggle('active', !G.over && G.turn === 1);
    const badge = $('turn-badge');
    if (G.matchOver) { badge.textContent = 'FIN'; badge.style.background = 'var(--np-ink)'; }
    else if (G.over) {
      if (G.roundWinner === 0 || G.roundWinner === 1) {
        badge.textContent = 'GANA ' + G.players[G.roundWinner].name.toUpperCase();
        badge.style.background = G.roundWinner === 0 ? 'var(--np-red)' : 'var(--np-blue)';
      } else { badge.textContent = 'TABLAS'; badge.style.background = 'var(--np-ink)'; }
    } else {
      badge.textContent = 'TURNO ' + G.players[G.turn].name.toUpperCase();
      badge.style.background = G.turn === 0 ? 'var(--np-red)' : 'var(--np-blue)';
    }
    const si = $('series-info');
    if (si) {
      const t = G.targetWins || 3;
      si.textContent = `Ronda ${G.gameNum || 1} · a ${t} victoria${t > 1 ? 's' : ''}`;
    }
  }
  function countCells(owner) { return G.board.filter(c => c && c.owner === owner).length; }

  /* ═══════════════ FLUJO DE PARTIDA ═══════════════ */
  function newGame(p1, p2, target) {
    const res = generateGrid();
    if (!res) { showToast('No se pudo generar el tablero, reintenta', 'err'); return false; }
    G = {
      grid: res.grid, seed: res.seed, min: res.min,
      board: new Array(9).fill(null),
      turn: 0,
      players: [{ name: p1 || 'Jugador 1' }, { name: p2 || 'Jugador 2' }],
      usedIds: new Set(),
      over: false, matchOver: false, winner: null, roundWinner: null, winLine: null, passes: 0,
      mode: 'local',
      series: [0, 0], targetWins: target || 3, gameNum: 1,
    };
    try { window._ttt = G; } catch (e) {}   /* depuración */
    return true;
  }
  /* Siguiente ronda de la serie: nuevo tablero, se conserva el marcador. */
  function nextRound() {
    const res = generateGrid();
    if (!res) { showToast('No se pudo generar el tablero', 'err'); return; }
    G.grid = res.grid; G.seed = res.seed; G.min = res.min;
    G.board = new Array(9).fill(null); G.turn = 0; G.usedIds = new Set();
    G.over = false; G.winner = null; G.roundWinner = null; G.winLine = null; G.passes = 0;
    G.gameNum = (G.gameNum || 1) + 1;
    renderScore(); renderBoard();
    showToast('Ronda ' + G.gameNum);
  }

  function startLocalGame() {
    if (!dataReady) { showToast('Cargando datos…'); return; }
    const p1 = ($('input-p1-name').value || '').trim() || 'Jugador 1';
    const p2 = ($('input-p2-name').value || '').trim() || 'Jugador 2';
    if (!newGame(p1, p2, localTarget)) return;
    showScreen('screen-game');
    $('turn-timer').classList.add('hidden');
    $('game-hint').textContent = 'Pulsa una casilla y nombra un futbolista que cumpla ambas condiciones.';
    renderScore(); renderBoard();
  }

  function pickCell(i) {
    if (!G || G.over) return;
    if (G.board[i]) return;
    if (G.mode === 'online' && G.turn !== G.myIdx) { showToast('No es tu turno'); return; }
    pickIdx = i;
    const row = G.grid.rows[Math.floor(i / 3)];
    const col = G.grid.cols[i % 3];
    $('pick-constraints').innerHTML =
      chipHtml(row) + `<span class="pick-x">✕</span>` + chipHtml(col);
    const input = $('player-input');
    input.value = '';
    $('autocomplete-list').classList.add('hidden');
    $('pick-overlay').classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
  }
  function chipHtml(r) {
    const media = r.imgUrl
      ? `<img src="${esc(r.imgUrl)}" alt="" onerror="this.style.display='none'">`
      : `<span class="pick-emoji">${r.icon || '⚽'}</span>`;
    return `<span class="pick-chip">${media}<span>${esc(shortLabel(r))}</span></span>`;
  }
  function closePick() {
    $('pick-overlay').classList.add('hidden');
    pickIdx = -1;
  }

  async function submitAnswer() {
    if (pickIdx < 0 || !G || G.over) return;
    const input = $('player-input');
    const name = (input.value || '').trim();
    if (!name) return;
    const btn = $('submit-btn');
    btn.disabled = true;
    try {
      const player = await FR.resolvePlayer(name);
      if (!player) { showToast('No encuentro ese futbolista', 'err'); return; }
      if (G.usedIds.has(String(player.id))) { showToast(`${player.name} ya se ha usado`, 'err'); return; }

      const i = pickIdx;
      const row = G.grid.rows[Math.floor(i / 3)];
      const col = G.grid.cols[i % 3];
      const ok = FR.validate(player, row) && FR.validate(player, col);

      closePick();
      const cellData = { owner: G.turn, id: String(player.id), name: player.name, img: player.img || null };

      if (G.mode === 'online') {
        if (ok) { showToast(`✓ ${player.name}`, 'ok'); await Sync.move(i, cellData); }
        else    { showToast(`✗ ${player.name} no cumple — pierdes el turno`, 'err'); await Sync.wrongAnswer(); }
        return;
      }

      if (ok) {
        G.board[i] = cellData;
        G.usedIds.add(String(player.id));
        G.passes = 0;
        showToast(`✓ ${player.name}`, 'ok');
        if (!checkEnd()) { G.turn = 1 - G.turn; renderScore(); renderBoard(); }
      } else {
        showToast(`✗ ${player.name} no cumple — pierdes el turno`, 'err');
        G.passes = 0;
        G.turn = 1 - G.turn;
        renderScore(); renderBoard();
      }
    } catch (e) {
      console.error(e); showToast('Error al comprobar', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function skipTurn() {
    if (!G || G.over) return;
    if (G.mode === 'online') {
      if (G.turn !== G.myIdx) { showToast('No es tu turno'); return; }
      closePick(); Sync.skip(); return;
    }
    closePick();
    G.passes = (G.passes || 0) + 1;
    if (G.passes >= 2) { endRound(decideByCells()); return; }
    showToast(`${G.players[G.turn].name} pasa`);
    G.turn = 1 - G.turn;
    renderScore(); renderBoard();
  }

  function proposeDraw() {
    if (!G || G.over) return;
    if (G.mode === 'online') { Sync.offerDraw(); return; }
    /* Local: acuerdo inmediato → termina la serie en tablas. */
    endRound(null, true);
  }
  function respondDraw(accept) {
    if (G && G.mode === 'online') Sync.respondDraw(accept);
  }

  /* Devuelve el owner ganador (0/1) o null si empate por casillas */
  function decideByCells() {
    const a = countCells(0), b = countCells(1);
    if (a === b) return null;
    return a > b ? 0 : 1;
  }

  /* Comprueba 3 en raya o tablero lleno. Devuelve true si terminó la ronda. */
  function checkEnd() {
    for (const line of WIN_LINES) {
      const [x, y, z] = line;
      const a = G.board[x], b = G.board[y], c = G.board[z];
      if (a && b && c && a.owner === b.owner && b.owner === c.owner) {
        G.winLine = line;
        endRound(a.owner);
        return true;
      }
    }
    if (G.board.every(Boolean)) { endRound(decideByCells()); return true; }
    return false;
  }

  /* Fin de RONDA (un tres en raya). Suma a la serie y, si se llega al objetivo,
     termina la partida; si no, encadena la siguiente ronda. */
  function endRound(winnerOwner, forcedDraw) {
    G.over = true;
    G.roundWinner = (winnerOwner === 0 || winnerOwner === 1) ? winnerOwner : null;
    if (forcedDraw) {                 /* tablas acordadas → fin de partida */
      G.matchOver = true; G.forcedDraw = true;
      renderScore(); renderBoard();
      clearTimeout(_roundTimer);
      _roundTimer = setTimeout(() => { if (G) showMatchOver(); }, 650);
      return;
    }
    if (G.roundWinner !== null) G.series[G.roundWinner]++;
    renderScore(); renderBoard();
    const matchWon = G.roundWinner !== null && G.series[G.roundWinner] >= G.targetWins;
    clearTimeout(_roundTimer);
    _roundTimer = setTimeout(() => {
      if (!G) return;
      if (matchWon) { G.matchOver = true; showMatchOver(); }
      else nextRound();
    }, G.winLine ? 1200 : 700);
  }

  function showMatchOver() {
    if (!G) return;
    const wasActive = $('screen-finished').classList.contains('active');
    const s = G.series || [0, 0];
    const mw = s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : null;
    const isDraw = mw === null;
    $('finished-emoji').textContent = isDraw ? '🤝' : '🏆';
    $('finished-title').textContent = isDraw ? '¡EMPATE!' : '¡GANADOR!';
    $('winner-name').textContent = isDraw
      ? (G.forcedDraw ? 'Tablas acordadas' : 'Empate')
      : G.players[mw].name;
    $('final-scores').innerHTML = G.players.map((p, idx) => {
      const isWinner = !isDraw && mw === idx;
      return `<div class="final-score-item${isWinner ? ' winner-item' : ''}"><span class="final-score-name">${esc(p.name)}</span><span class="final-score-pts">${s[idx]}</span></div>`;
    }).join('');
    showScreen('screen-finished');
    /* Racha del hub una sola vez por partida (online re-renderiza el fin) */
    if (!wasActive) {
      try { window.HubStreaks && window.HubStreaks.registerPlay && window.HubStreaks.registerPlay('tres-en-raya'); } catch (e) {}
    }
  }

  function playAgain() {
    if (!G) { showMenu(); return; }
    if (G.mode === 'online') { Sync.rematch(); return; }
    if (newGame(G.players[0].name, G.players[1].name, G.targetWins)) {
      showScreen('screen-game'); renderScore(); renderBoard();
    }
  }

  function showMenu() {
    G = null; pickIdx = -1;
    clearTimeout(_finishTimer); clearTimeout(_roundTimer);
    showScreen('screen-menu');
  }

  /* ═══════════════ AUTOCOMPLETADO ═══════════════ */
  function onInput() {
    const input = $('player-input');
    const q = input.value.trim();
    const list = $('autocomplete-list');
    if (q.length < 2) { list.classList.add('hidden'); acItems = []; return; }
    acItems = FR.suggest(q, 8);
    if (!acItems.length) { list.classList.add('hidden'); return; }
    acIndex = -1;
    list.innerHTML = acItems.map((it, idx) =>
      `<div class="autocomplete-item" data-idx="${idx}" onmousedown="event.preventDefault();App.selectAndSubmit(${idx})">${esc(it.name)}</div>`
    ).join('');
    list.classList.remove('hidden');
  }
  function selectAndSubmit(idx) {
    const it = acItems[idx]; if (!it) return;
    $('player-input').value = it.name;
    $('autocomplete-list').classList.add('hidden');
    submitAnswer();
  }
  function onKeyDown(e) {
    const list = $('autocomplete-list');
    const visible = !list.classList.contains('hidden') && acItems.length;
    if (e.key === 'ArrowDown' && visible) { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); paintAc(); }
    else if (e.key === 'ArrowUp' && visible) { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); paintAc(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible && acIndex >= 0) selectAndSubmit(acIndex);
      else submitAnswer();
    } else if (e.key === 'Escape') { closePick(); }
  }
  function paintAc() {
    document.querySelectorAll('.autocomplete-item').forEach((el, idx) =>
      el.classList.toggle('active', idx === acIndex));
  }

  /* ═══════════════ ONLINE — Firebase Realtime DB ═══════════════ */
  function setTab(t) { currentTab = t; }

  /* Gana quien tenga 3 en línea; devuelve la línea o null. board = objeto {i:{owner}} */
  function winningLineObj(boardObj) {
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      const oa = boardObj[a], ob = boardObj[b], oc = boardObj[c];
      if (oa && ob && oc && oa.owner === ob.owner && ob.owner === oc.owner) return line;
    }
    return null;
  }
  function decideByCellsObj(boardObj) {
    let a = 0, b = 0;
    /* Firebase puede convertir el board en array rellenando huecos con null:
       hay que ignorarlos (v.owner de null petaría). */
    for (const k in boardObj) { const v = boardObj[k]; if (!v) continue; if (v.owner === 0) a++; else if (v.owner === 1) b++; }
    if (a === b) return null;
    return a > b ? 0 : 1;
  }
  function countFilledObj(boardObj) {
    let n = 0;
    for (const k in boardObj) { if (boardObj[k]) n++; }
    return n;
  }

  const Sync = (() => {
    const FB = () => window._FB;
    const ROOMS = 'tres-en-raya/rooms';
    const MM    = 'tres-en-raya/matchmaking';
    let code = null, myPid = null, myIdx = 0, unsub = null, room = null;
    let _nextRoundScheduled = false;   /* debounce del arranque de ronda (host) */

    function _ref(path) { const { db, ref } = FB(); return ref(db, path); }
    function _genCode() {
      const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return Array.from({ length: 6 }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
    }
    function _genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
    function available() { return !!(FB() && FB().configured); }

    function _armDisconnect() {
      try {
        if (!window._FBOnDisconnect) return;
        const { db, ref } = FB();
        const path = `${ROOMS}/${code}/players/${myPid}`;
        window._FBOnDisconnect(ref(db, path)).update({ connected: false }).catch(() => {});
      } catch (e) {}
    }

    function _connErr(e) {
      console.error('[Sync]', e);
      showToast('No se pudo conectar al servidor', 'err');
      code = null; myPid = null;
    }

    async function create(name, isPublic, targetWins) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return; }
      const { set } = FB();
      code = _genCode(); myPid = _genId(); myIdx = 0;
      try {
        await set(_ref(`${ROOMS}/${code}`), {
          status: 'waiting', isPublic: !!isPublic, createdAt: Date.now(),
          targetWins: Math.max(TARGET_MIN, Math.min(TARGET_MAX, targetWins || 3)),
          seed: 0, min: 0, turn: 0, board: {}, usedIds: {}, passes: 0,
          series: {}, roundOver: null, gameNum: 1,
          winnerIdx: null, winLine: null, drawOffer: null, rematch: {},
          players: { [myPid]: { name: name || 'Jugador 1', idx: 0, connected: true, isHost: true } },
        });
        if (isPublic) await set(_ref(`${MM}/${code}`), { status: 'waiting', createdAt: Date.now() });
      } catch (e) { _connErr(e); return; }
      _armDisconnect();
      _listen();
      enterLobby();
    }

    async function join(joinCode, name) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return; }
      const { get, update } = FB();
      let snap;
      try { snap = await get(_ref(`${ROOMS}/${joinCode}`)); } catch (e) { _connErr(e); return; }
      if (!snap.exists()) { showToast('Sala no encontrada', 'err'); return; }
      const r = snap.val();
      if (r.status !== 'waiting') { showToast('La partida ya ha empezado', 'err'); return; }
      const count = Object.keys(r.players || {}).length;
      if (count >= 2) { showToast('La sala está llena', 'err'); return; }
      code = joinCode; myPid = _genId(); myIdx = 1;
      try {
        await update(_ref(`${ROOMS}/${code}/players/${myPid}`), { name: name || 'Jugador 2', idx: 1, connected: true, isHost: false });
        await FB().remove(_ref(`${MM}/${code}`)).catch(() => {});
      } catch (e) { _connErr(e); return; }
      _armDisconnect();
      _listen();
      enterLobby();
    }

    async function findPublic(name) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return; }
      const { get } = FB();
      let snap;
      try { snap = await get(_ref(MM)); } catch (e) { _connErr(e); return; }
      if (snap.exists()) {
        const codes = Object.keys(snap.val());
        for (const c of codes) {
          const rs = await get(_ref(`${ROOMS}/${c}`));
          if (rs.exists() && rs.val().status === 'waiting' && Object.keys(rs.val().players || {}).length === 1) {
            await join(c, name); return;
          }
          await FB().remove(_ref(`${MM}/${c}`)).catch(() => {});
        }
      }
      await create(name, true, PUBLIC_TARGET);
      showToast('Esperando a un rival…');
    }

    function _listen() {
      const { onValue } = FB();
      if (unsub) unsub();
      unsub = onValue(_ref(`${ROOMS}/${code}`), (snap) => {
        room = snap.val();
        if (!room) { showToast('La sala se cerró'); leave(); return; }
        onRoom();
      });
    }

    /* Host arranca la partida cuando entran los 2 jugadores */
    async function _maybeStart() {
      if (myIdx !== 0) return;                 /* solo el host */
      if (room.status !== 'waiting') return;
      if (Object.keys(room.players || {}).length < 2) return;
      const res = generateGrid();
      if (!res) return;
      await FB().update(_ref(`${ROOMS}/${code}`), {
        status: 'playing', seed: res.seed, min: res.min, turn: 0,
        board: {}, usedIds: {}, passes: 0, series: {}, roundOver: null, gameNum: 1,
        winnerIdx: null, matchWinnerIdx: null, winLine: null,
        drawOffer: null, drawAgreed: null, rematch: {}, turnStartAt: Date.now(),
      });
      await FB().remove(_ref(`${MM}/${code}`)).catch(() => {});
    }

    /* Aplica el fin de una RONDA dentro de la transacción: suma a la serie y
       decide si es fin de PARTIDA (se llegó al objetivo) o solo fin de ronda. */
    function _endRoundTx(r, roundWinner, line) {
      const isWinner = roundWinner === 0 || roundWinner === 1;
      const series = r.series || {};
      if (isWinner) series[roundWinner] = (series[roundWinner] || 0) + 1;
      r.series = series;
      const target = r.targetWins || 3;
      if (isWinner && series[roundWinner] >= target) {
        r.status = 'finished'; r.matchWinnerIdx = roundWinner; r.winLine = line || null;
      } else {
        r.roundOver = { w: isWinner ? roundWinner : -1, line: line || null };
      }
    }

    /* El host arranca la siguiente ronda tras una pausa (deja ver la línea). */
    function _maybeNextRound() {
      if (myIdx !== 0 || _nextRoundScheduled) return;
      if (!room || room.status !== 'playing' || !room.roundOver) return;
      _nextRoundScheduled = true;
      const res = generateGrid();
      const delay = room.roundOver.line ? 1600 : 1000;
      setTimeout(async () => {
        _nextRoundScheduled = false;
        if (!room || room.status !== 'playing' || !room.roundOver || !res) return;
        try {
          await FB().update(_ref(`${ROOMS}/${code}`), {
            seed: res.seed, min: res.min, turn: 0, board: {}, usedIds: {},
            passes: 0, roundOver: null, winLine: null,
            gameNum: (room.gameNum || 1) + 1, turnStartAt: Date.now(),
          });
        } catch (e) {}
      }, delay);
    }

    function onRoom() {
      if (room.status === 'waiting') { _maybeStart(); renderLobby(); return; }
      /* Proyectar sala → estado local G */
      const players = room.players || {};
      const nameByIdx = ['Jugador 1', 'Jugador 2'];
      for (const p of Object.values(players)) nameByIdx[p.idx] = p.name;
      const boardArr = new Array(9).fill(null);
      const bo = room.board || {};
      for (const k in bo) boardArr[+k] = bo[k];
      const grid = rebuildGrid(room.seed, room.min);
      const series = [ (room.series && room.series[0]) || 0, (room.series && room.series[1]) || 0 ];
      const finished = room.status === 'finished';
      const roundOver = room.roundOver || null;
      const roundWinner = finished
        ? ((room.matchWinnerIdx === 0 || room.matchWinnerIdx === 1) ? room.matchWinnerIdx : null)
        : (roundOver ? (roundOver.w === 0 || roundOver.w === 1 ? roundOver.w : null) : null);
      G = {
        mode: 'online', myIdx, grid, seed: room.seed, min: room.min,
        board: boardArr, turn: room.turn,
        players: [{ name: nameByIdx[0] }, { name: nameByIdx[1] }],
        usedIds: new Set(Object.keys(room.usedIds || {})),
        over: finished || !!roundOver,
        matchOver: finished,
        roundWinner,
        winner: finished ? roundWinner : null,
        winLine: (finished ? room.winLine : (roundOver && roundOver.line)) || null,
        passes: room.passes || 0,
        series, targetWins: room.targetWins || 3, gameNum: room.gameNum || 1,
        forcedDraw: !!room.drawAgreed,
      };
      try { window._ttt = G; } catch (e) {}

      if (finished) {
        if (!$('screen-finished').classList.contains('active')) { showScreen('screen-game'); renderScore(); renderBoard(); }
        _handleRematch();
        /* Retardo cancelable: deja ver la línea ganadora antes del cartel de fin. */
        clearTimeout(_finishTimer);
        _finishTimer = setTimeout(() => showMatchOver(), G.winLine ? 850 : 300);
        return;
      }
      /* status playing (ronda en curso o ronda recién terminada) */
      clearTimeout(_finishTimer);
      if (!$('screen-game').classList.contains('active')) showScreen('screen-game');
      $('turn-timer').classList.add('hidden');
      renderScore(); renderBoard();
      _renderDrawOffer();

      if (roundOver) {
        /* Fin de ronda: se muestra la línea y quién ganó; el host encadena. */
        $('game-hint').textContent = (roundWinner === 0 || roundWinner === 1)
          ? `${G.players[roundWinner].name} gana la ronda`
          : 'Ronda en tablas';
        _maybeNextRound();
        return;
      }
      $('game-hint').textContent = (G.turn === myIdx)
        ? 'Tu turno: pulsa una casilla y nombra un futbolista.'
        : `Turno de ${G.players[G.turn].name}…`;
    }

    function _renderDrawOffer() {
      const banner = $('draw-offer');
      const offer = room.drawOffer;
      if (offer && offer !== myPid && room.status === 'playing') {
        banner.classList.remove('hidden');
      } else banner.classList.add('hidden');
    }

    async function _handleRematch() {
      const rm = room.rematch || {};
      const both = Object.keys(room.players || {}).every(pid => rm[pid]);
      if (both && myIdx === 0) {
        const res = generateGrid();
        if (!res) return;
        await FB().update(_ref(`${ROOMS}/${code}`), {
          status: 'playing', seed: res.seed, min: res.min, turn: 0,
          board: {}, usedIds: {}, passes: 0, series: {}, roundOver: null, gameNum: 1,
          winnerIdx: null, matchWinnerIdx: null, winLine: null,
          drawOffer: null, drawAgreed: null, rematch: {}, turnStartAt: Date.now(),
        });
      }
    }

    function _tx(fn) {
      const { runTransaction } = FB();
      return runTransaction(_ref(`${ROOMS}/${code}`), (r) => {
        if (!r || r.status !== 'playing') return r;
        return fn(r) || r;
      });
    }

    async function move(i, cellData) {
      await _tx((r) => {
        if (r.turn !== myIdx) return r;
        r.board = r.board || {};
        if (r.board[i]) return r;
        r.usedIds = r.usedIds || {};
        if (r.usedIds[cellData.id]) return r;
        r.board[i] = cellData;
        r.usedIds[cellData.id] = true;
        r.passes = 0; r.drawOffer = null;
        const line = winningLineObj(r.board);
        if (line) _endRoundTx(r, myIdx, line);
        else if (countFilledObj(r.board) >= 9) _endRoundTx(r, decideByCellsObj(r.board), null);
        else r.turn = 1 - myIdx;
        r.turnStartAt = Date.now();
        return r;
      });
    }
    async function wrongAnswer() {
      await _tx((r) => {
        if (r.turn !== myIdx) return r;
        r.passes = 0; r.drawOffer = null; r.turn = 1 - myIdx; r.turnStartAt = Date.now();
        return r;
      });
    }
    async function skip() {
      await _tx((r) => {
        if (r.turn !== myIdx) return r;
        r.passes = (r.passes || 0) + 1;
        if (r.passes >= 2) _endRoundTx(r, decideByCellsObj(r.board || {}), null);
        else { r.turn = 1 - myIdx; r.turnStartAt = Date.now(); }
        return r;
      });
    }
    async function offerDraw() {
      if (!room || room.status !== 'playing') return;
      await FB().update(_ref(`${ROOMS}/${code}`), { drawOffer: myPid });
      showToast('Propuesta de tablas enviada');
    }
    async function respondDraw(accept) {
      if (accept) {
        await _tx((r) => { r.status = 'finished'; r.matchWinnerIdx = null; r.winLine = null; r.roundOver = null; r.drawAgreed = true; r.drawOffer = null; return r; });
      } else {
        await FB().update(_ref(`${ROOMS}/${code}`), { drawOffer: null });
      }
    }
    async function rematch() {
      if (!code) { showMenu(); return; }
      await FB().update(_ref(`${ROOMS}/${code}/rematch`), { [myPid]: true });
      showToast('Esperando al rival para la revancha…');
    }

    async function leave() {
      try {
        if (unsub) unsub();
        if (code && myPid) {
          await FB().remove(_ref(`${ROOMS}/${code}/players/${myPid}`)).catch(() => {});
          await FB().remove(_ref(`${MM}/${code}`)).catch(() => {});
        }
      } catch (e) {}
      code = null; myPid = null; room = null; unsub = null;
      showMenu();
    }

    function enterLobby() {
      showScreen('screen-lobby');
      $('lobby-code-display').textContent = code;
      renderLobby();
    }
    function renderLobby() {
      if (!room) return;
      const ps = Object.values(room.players || {}).sort((a, b) => a.idx - b.idx);
      $('lobby-players').innerHTML = ps.map(p => {
        const initial = ((p.name || '?').trim().charAt(0) || '?').toUpperCase();
        return `<div class="lobby-player-row">
          <div class="lobby-player-avatar">${esc(initial)}</div>
          <span class="lobby-player-name">${esc(p.name)}</span>
          ${p.isHost ? '<span class="lobby-player-host">Host</span>' : ''}
        </div>`;
      }).join('');
      const t = room.targetWins || 3;
      const lt = $('lobby-target');
      if (lt) lt.textContent = `A ${t} victoria${t > 1 ? 's' : ''} para ganar`;
      $('lobby-hint').textContent = ps.length < 2 ? 'Esperando rival…' : 'Empezando…';
    }
    function getCode() { return code; }

    return { available, create, join, findPublic, move, wrongAnswer, skip, offerDraw, respondDraw, rematch, leave, getCode };
  })();

  function createRoom() {
    const name = ($('input-host-name').value || '').trim();
    if (!dataReady) { showToast('Cargando datos…'); return; }
    Sync.create(name, false, hostTarget);
  }
  function joinRoom() {
    const name = ($('input-join-name').value || '').trim();
    const code = ($('input-join-code').value || '').trim().toUpperCase();
    if (!code) { showToast('Escribe un código', 'err'); return; }
    if (!dataReady) { showToast('Cargando datos…'); return; }
    Sync.join(code, name);
  }
  function findPublicRoom() {
    const name = ($('input-public-name').value || '').trim();
    if (!dataReady) { showToast('Cargando datos…'); return; }
    Sync.findPublic(name);
  }
  function leaveRoom() { Sync.leave(); }
  function copyLink() {
    const code = Sync.getCode();
    if (!code) return;
    const url = `${location.origin}${location.pathname}?sala=${code}`;
    navigator.clipboard?.writeText(url).then(
      () => showToast('Enlace copiado ✓', 'ok'),
      () => showToast(url)
    );
  }

  /* ═══════════════ INIT ═══════════════ */
  async function init() {
    const input = $('player-input');
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('keydown', onKeyDown);
    }
    try {
      await FR.init();
      dataReady = true;
      console.log('✅ [TresEnRaya] datos listos');
    } catch (e) {
      console.error('Error cargando datos:', e);
      $('loading-text').textContent = 'Error al cargar. Recarga la página.';
      return;
    }
    $('loading-overlay').classList.add('hidden');

    /* Deep link ?sala=CODE → pestaña privada con el código prellenado */
    try {
      const sala = new URLSearchParams(location.search).get('sala');
      if (sala) {
        const btn = $('tab-private'); if (btn) btn.click();
        const inp = $('input-join-code'); if (inp) inp.value = sala.toUpperCase();
        showToast('Escribe tu nombre y pulsa UNIRSE');
      }
    } catch (e) {}
  }

  return {
    init, setTab, startLocalGame, adjustTarget,
    createRoom, joinRoom, findPublicRoom, leaveRoom, copyLink,
    pickCell, closePick, submitAnswer, selectAndSubmit,
    skipTurn, proposeDraw, respondDraw, playAgain, showMenu, showToast,
  };
})();
