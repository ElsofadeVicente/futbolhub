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
  /* Id del futbolista ELEGIDO en la lista. Sin esto la respuesta se
     resolvia por nombre y elegir entre dos homonimos no servia de nada:
     FR.resolvePlayer devuelve siempre el mismo de los dos. Se borra en
     cuanto se vuelve a escribir. */
  let acChosenId = null;
  let _finishTimer = null;   /* fin online: retardo cancelable para ver la línea */
  let _roundTimer = null;    /* pausa entre rondas de la serie */
  let localTarget = 3;       /* victorias para ganar (modo local) */
  let hostTarget  = 3;       /* victorias para ganar (host online) */
  const TARGET_MIN = 1, TARGET_MAX = 9;
  const PUBLIC_TARGET = 3;   /* en partidas públicas el objetivo es fijo (rival aleatorio) */

  /* ── Online: tiempos y tolerancias ── */
  const TURN_MS       = 30000;              /* tiempo por turno */
  const TURN_GRACE_MS = 5000;               /* margen antes de que el rival fuerce el corte */
  const AFK_STRIKES   = 3;                  /* turnos agotados seguidos = abandono */
  const GONE_GRACE_MS = 25000;              /* margen tras caerse el rival */
  const MM_TTL_MS     = 60 * 60 * 1000;     /* sala pública sin emparejar = basura */

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
  /* Prefijo que separa "haber jugado ahí" de "haberlo ganado". Sin él, la
     cabecera del trofeo de la Libertadores y la de una liga se leían igual
     ("Copa Libertadores" / "La Liga") y no había forma de saber si pedían
     jugar o ganar. */
  function qualifier(r) {
    if (r.type === 'trophy' || r.type === 'trophy_any') {
      return r.family === 'trophy_individual' ? 'Ganador' : 'Campeón';
    }
    if (r.type === 'league' || r.type === 'league_any' || r.type === 'club') return 'Jugó en';
    return null;
  }
  function hdrTextHtml(r) {
    const q = qualifier(r);
    return (q ? `<span class="hdr-kicker">${esc(q)}</span>` : '') +
           `<span class="hdr-label">${esc(shortLabel(r))}</span>`;
  }

  /* Los entrenadores y compañeros son FOTOS (avatar circular); logos, banderas
     y trofeos van contenidos sin recortar. */
  function hdrMediaHtml(r) {
    const isAvatar = r.type === 'coach' || r.type === 'teammate';
    if (r.imgUrl) {
      return `<span class="hdr-media${isAvatar ? ' hdr-media--avatar' : ''}"><img src="${esc(fhImgUrl(r.imgUrl))}" alt="" loading="lazy" onerror="this.closest('.hdr-media').classList.add('hdr-media--broken')"></span>`;
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
    if (!board || !G || !G.grid) return;
    let html = `<div class="cell-corner"><span class="corner-ball">⚽</span></div>`;
    /* cabeceras de columna */
    for (let c = 0; c < 3; c++) {
      const r = G.grid.cols[c];
      html += `<div class="hdr hdr-col">${hdrMediaHtml(r)}${hdrTextHtml(r)}</div>`;
    }
    /* filas */
    for (let row = 0; row < 3; row++) {
      const rr = G.grid.rows[row];
      html += `<div class="hdr hdr-row">${hdrMediaHtml(rr)}${hdrTextHtml(rr)}</div>`;
      for (let col = 0; col < 3; col++) {
        const i = row * 3 + col;
        const cell = G.board[i];
        if (cell) {
          const cls = cell.owner === 0 ? 'p1' : 'p2';
          const mk  = cell.owner === 0 ? '✕' : '◯';
          const photo = cell.img
            ? `<span class="cell-photo"><img src="${esc(fhImgUrl(cell.img))}" alt="" onerror="this.closest('.cell-photo').style.display='none'"></span>`
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
      turn: 0, startedBy: 0,
      players: [{ name: p1 || 'Jugador 1' }, { name: p2 || 'Jugador 2' }],
      usedIds: new Set(),
      over: false, matchOver: false, winner: null, roundWinner: null, winLine: null, passes: 0,
      mode: 'local',
      series: [0, 0], targetWins: target || 3, gameNum: 1,
    };
    try { window._ttt = G; } catch (e) {}   /* depuración */
    return true;
  }
  /* Quién sale en la ronda siguiente: nunca el que acaba de ganarla (empezar
     es ventaja); si la ronda quedó en tablas, se alterna respecto a quien
     salió en ella. */
  function nextStarter(prevStarter, roundWinner) {
    if (roundWinner === 0 || roundWinner === 1) return 1 - roundWinner;
    return 1 - (prevStarter || 0);
  }

  /* Siguiente ronda de la serie: nuevo tablero, se conserva el marcador. */
  function nextRound() {
    const res = generateGrid();
    if (!res) { showToast('No se pudo generar el tablero', 'err'); return; }
    const starter = nextStarter(G.startedBy, G.roundWinner);
    G.grid = res.grid; G.seed = res.seed; G.min = res.min;
    G.board = new Array(9).fill(null); G.usedIds = new Set();
    G.turn = starter; G.startedBy = starter;
    G.over = false; G.winner = null; G.roundWinner = null; G.winLine = null; G.passes = 0;
    G.gameNum = (G.gameNum || 1) + 1;
    renderScore(); renderBoard();
    showToast(`Ronda ${G.gameNum} · empieza ${G.players[starter].name}`);
  }

  function startLocalGame() {
    if (!dataReady) { showToast('Cargando datos…'); return; }
    const p1 = ($('input-p1-name').value || '').trim() || 'Jugador 1';
    const p2 = ($('input-p2-name').value || '').trim() || 'Jugador 2';
    if (!newGame(p1, p2, localTarget)) return;
    showScreen('screen-game');
    stopTurnTimer();
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
      ? `<img src="${esc(fhImgUrl(r.imgUrl))}" alt="" onerror="this.style.display='none'">`
      : `<span class="pick-emoji">${r.icon || '⚽'}</span>`;
    const q = qualifier(r);
    return `<span class="pick-chip">${media}<span>${q ? esc(q) + ' ' : ''}${esc(shortLabel(r))}</span></span>`;
  }
  function closePick() {
    $('pick-overlay').classList.add('hidden');
    pickIdx = -1;
  }

  async function submitAnswer() {
    if (pickIdx < 0 || !G || G.over) return;
    if (G.mode === 'online' && G.turn !== G.myIdx) { closePick(); showToast('Ya no es tu turno', 'err'); return; }
    const input = $('player-input');
    const name = (input.value || '').trim();
    if (!name) return;
    const btn = $('submit-btn');
    btn.disabled = true;
    try {
      /* Si viene de la lista se resuelve por ID (es el unico modo de
         distinguir dos futbolistas con el mismo nombre); si lo ha escrito
         a mano, por nombre como siempre. */
      const elegido = acChosenId;
      acChosenId = null;
      let player = elegido ? await FR.resolvePlayerById(elegido) : null;
      if (!player) player = await FR.resolvePlayer(name);
      /* Nombre que no existe = fallo, y el fallo cuesta el turno. Lo único que
         NO penaliza es repetir un futbolista ya usado (eso es un despiste,
         no un intento). */
      if (!player) {
        closePick();
        showToast('No encuentro ese futbolista — pierdes el turno', 'err');
        if (G.mode === 'online') { await Sync.wrongAnswer(); return; }
        G.passes = 0; G.turn = 1 - G.turn;
        renderScore(); renderBoard();
        return;
      }
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
    /* Local: acuerdo inmediato. Las tablas cierran la RONDA (sin punto para
       nadie) y se pasa a la siguiente, no terminan la partida. */
    closePick();
    showToast('Ronda en tablas');
    endRound(null);
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
  function endRound(winnerOwner) {
    G.over = true;
    G.roundWinner = (winnerOwner === 0 || winnerOwner === 1) ? winnerOwner : null;
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
    $('winner-name').textContent = isDraw ? 'Empate' : G.players[mw].name;

    /* Abandono: el marcador puede ir 0-0, así que el cartel lo explica. */
    if (G.mode === 'online' && G.abandoned) {
      const rival = G.abandoned === 'rival';
      $('finished-emoji').textContent = rival ? '🏆' : '🚪';
      $('finished-title').textContent = rival ? '¡VICTORIA!' : 'PARTIDA TERMINADA';
      $('winner-name').textContent = rival
        ? 'El rival abandonó la partida'
        : 'Te quedaste sin tiempo demasiadas veces';
    }
    /* Sin rival al otro lado no hay revancha posible. */
    const again = $('btn-play-again');
    if (again) again.classList.toggle('hidden', G.mode === 'online' && (G.abandoned || G.oppGone));
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
    /* Volver al menú desde una partida online es SALIR de la sala. Sin esto,
       el botón "🏠 Menú" del final dejaba tu jugador dentro para siempre: la
       sala no se borraba nunca y seguías escuchándola de fondo. leave() borra
       el código y vuelve a llamar aquí, así que no hay recursión. */
    if (Sync.getCode()) { desmarcarSala(); Sync.leave(); return; }
    desmarcarSala();
    G = null; pickIdx = -1;
    clearTimeout(_finishTimer); clearTimeout(_roundTimer);
    stopTurnTimer();
    closePick();
    const again = $('btn-play-again'); if (again) again.classList.remove('hidden');
    showScreen('screen-menu');
  }

  /* ═══════════════ AUTOCOMPLETADO ═══════════════ */
  const POS_LABEL = { GK:'Portero', DEF:'Defensa', MID:'Centrocampista', FWD:'Delantero' };
  const acNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d').replace(/ı/g,'i').replace(/İ/g,'i').replace(/ß/g,'b').replace(/œ/g,'oe').replace(/[\u200b-\u200f]/g,'').trim();

  /**
   * Etiqueta de la derecha de cada sugerencia (misma regla que Coche y La
   * Cadena). Siempre sale la posicion, y SOLO cuando hay dos jugadores con
   * el mismo nombre se va anadiendo lo siguiente que los separa:
   * nacionalidad y, si tambien coincide, ano de nacimiento. Sin esto, dos
   * "Danilo" o dos "Rodrigo" salian identicos y elegias a ciegas.
   */
  function acEtiquetar(lista) {
    return lista.map((it, _, arr) => {
      const iguales = arr.filter(o => acNorm(o.name) === acNorm(it.name));
      const tags = [];
      const pos = POS_LABEL[it.position] || it.position || '';
      if (pos) tags.push(pos);
      if (iguales.length > 1) {
        const mismaPos = iguales.filter(o => o.position === it.position);
        if (mismaPos.length > 1 && it.nationalTeam) {
          tags.push(it.nationalTeam);
          const mismaNat = mismaPos.filter(o => o.nationalTeam === it.nationalTeam);
          if (mismaNat.length > 1 && it.birthYear) tags.push('n. ' + it.birthYear);
        }
      }
      return { ...it, disambig: tags.join(' · ') };
    });
  }

  /* El mismo jugador puede estar indexado dos veces con IDs distintos. Se
     quedan fuera los que repiten huella (nombre + ano + seleccion + club):
     si algun dato difiere es que son personas distintas y pasan los dos. */
  function acDeduplicar(lista, limite) {
    const vistas = new Set();
    const out = [];
    for (const it of lista) {
      const huella = `${acNorm(it.name)}|${it.birthYear || ''}|${it.nationalTeam || ''}|${it.club || ''}`;
      if (vistas.has(huella)) continue;
      vistas.add(huella);
      out.push(it);
      if (out.length >= limite) break;
    }
    return out;
  }

  function onInput() {
    const input = $('player-input');
    const q = input.value.trim();
    const list = $('autocomplete-list');
    acChosenId = null;
    if (q.length < 2) { list.classList.add('hidden'); acItems = []; return; }
    /* Se piden mas de las 8 que se ensenan: al deduplicar homonimos falsos
       se cae alguna por el camino y si no la lista se queda corta. */
    acItems = acEtiquetar(acDeduplicar(FR.suggest(q, 24), 8));
    if (!acItems.length) { list.classList.add('hidden'); return; }
    /* El primero viene marcado, como en Coche: escribes y con Enter directo
       envías la sugerencia de arriba sin tener que bajar con la flecha. */
    acIndex = 0;
    list.innerHTML = acItems.map((it, idx) => {
      const meta = it.disambig ? `<span class="autocomplete-nat">${esc(it.disambig)}</span>` : '';
      return `<div class="autocomplete-item" data-idx="${idx}" onmousedown="event.preventDefault();App.selectAndSubmit(${idx})"><span>${esc(it.name)}</span>${meta}</div>`;
    }).join('');
    list.classList.remove('hidden');
    paintAc();
  }
  function selectAndSubmit(idx) {
    const it = acItems[idx]; if (!it) return;
    acChosenId = it.id;
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
    /* La clase es 'selected', que es la que estiliza el diseño compartido
       (igual que Coche y Superdraft). Con 'active' la marca era invisible: ni
       la preselección ni el movimiento con las flechas se veían. */
    document.querySelectorAll('.autocomplete-item').forEach((el, idx) =>
      el.classList.toggle('selected', idx === acIndex));
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

  /* ── Cronómetro de turno (solo online) ──
     El reloj NO se calcula con la marca de tiempo que va en la sala: los
     relojes de dos dispositivos pueden ir minutos desfasados. Cada cliente
     cuenta desde que VE cambiar el turno, y el corte se aplica con una
     transacción atada al token del turno, así que da igual quién lo dispare:
     solo se aplica la primera vez. */
  let _turnKey = '', _turnSeenAt = 0, _turnInt = null;
  function stopTurnTimer() {
    clearInterval(_turnInt); _turnInt = null;
    const el = $('turn-timer');
    if (el) { el.classList.add('hidden'); el.classList.remove('urgent'); }
  }
  function startTurnTimer() {
    const el = $('turn-timer'); if (!el) return;
    clearInterval(_turnInt);
    el.classList.remove('hidden');
    const tick = () => {
      if (!G || G.mode !== 'online' || G.over) { stopTurnTimer(); return; }
      const gone = Date.now() - _turnSeenAt;
      const left = Math.ceil((TURN_MS - gone) / 1000);
      el.textContent = Math.max(0, left);
      el.classList.toggle('urgent', left <= 10);
      /* Al que le toca corta su propio turno; el rival espera un margen, así
         las dos transacciones no se pisan (aunque sería inofensivo). */
      const limit = TURN_MS + (G.turn === G.myIdx ? 0 : TURN_GRACE_MS);
      if (gone >= limit) { clearInterval(_turnInt); _turnInt = null; Sync.timeout(); }
    };
    tick();
    _turnInt = setInterval(tick, 250);
  }

  const Sync = (() => {
    const FB = () => window._FB;
    const ROOMS = 'tres-en-raya/rooms';
    const MM    = 'tres-en-raya/matchmaking';
    let code = null, myPid = null, myIdx = 0, unsub = null, room = null;
    let isPublicRoom = false;
    let _nextRoundScheduled = false;   /* debounce del arranque de ronda */
    let _startBusy   = false;          /* debounce del arranque de partida */
    let _armedFor    = null;           /* estado para el que está armado onDisconnect */
    let _goneTimer   = null;           /* margen antes de dar la partida por abandono */
    let _abandonBusy = false;

    function _ref(path) { const { db, ref } = FB(); return ref(db, path); }
    function _genCode() {
      const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return Array.from({ length: 6 }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
    }
    function _genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
    function _stamp() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function available() { return !!(FB() && FB().configured); }

    /* Jugadores realmente presentes, ordenados por idx. */
    function _liveEntries(r) {
      const ps = ((r || room) || {}).players || {};
      return Object.entries(ps)
        .filter(([, p]) => p && p.connected !== false)
        .sort((a, b) => (a[1].idx || 0) - (b[1].idx || 0));
    }
    /* Quién manda (arrancar partida, encadenar ronda, revancha): el jugador
       conectado con el idx más bajo. Antes era siempre "el idx 0"; si ese se
       caía, nadie arrancaba nada y la sala se quedaba colgada en
       "Empezando…" para siempre. */
    function _amDirector() {
      const live = _liveEntries();
      return !!live.length && live[0][0] === myPid;
    }

    /* onDisconnect es un hook de SERVIDOR: se registra una vez y lo ejecuta
       Firebase cuando el socket se cae. En el lobby hay que BORRAR el jugador
       (si no, quien cierra la pestaña deja un fantasma que ocupa sitio y, si
       era el anfitrión, nadie vuelve a arrancar la partida). En partida solo
       se marca connected:false, para poder volver tras un corte. */
    async function _armDisconnect(status) {
      if (!window._FBOnDisconnect || !code || !myPid) return;
      const key = (status === 'waiting') ? 'waiting' : 'playing';
      if (_armedFor === key) return;
      _armedFor = key;
      try {
        const { db, ref } = FB();
        const pRef  = ref(db, `${ROOMS}/${code}/players/${myPid}`);
        const mmRef = ref(db, `${MM}/${code}`);
        await window._FBOnDisconnect(pRef).cancel().catch(() => {});
        if (key === 'waiting') {
          window._FBOnDisconnect(pRef).remove().catch(() => {});
          /* Si se cae el anfitrión, la sala deja de anunciarse. */
          if (myIdx === 0) window._FBOnDisconnect(mmRef).remove().catch(() => {});
        } else {
          window._FBOnDisconnect(pRef).update({ connected: false }).catch(() => {});
        }
      } catch (e) { _armedFor = null; }
    }

    function _connErr(e) {
      console.error('[Sync]', e);
      showToast('No se pudo conectar al servidor', 'err');
      code = null; myPid = null;
    }
    function _resetSession() {
      isPublicRoom = false; _armedFor = null; _startBusy = false;
      _nextRoundScheduled = false; _abandonBusy = false;
      _turnKey = ''; clearTimeout(_goneTimer);
    }

    async function create(name, isPublic, targetWins) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return; }
      const { set } = FB();
      code = _genCode(); myPid = _genId(); myIdx = 0;
      _resetSession(); isPublicRoom = !!isPublic;
      try {
        await set(_ref(`${ROOMS}/${code}`), {
          status: 'waiting', isPublic: !!isPublic, createdAt: Date.now(),
          targetWins: Math.max(TARGET_MIN, Math.min(TARGET_MAX, targetWins || 3)),
          seed: 0, min: 0, turn: 0, board: {}, usedIds: {}, passes: 0,
          series: {}, roundOver: null, gameNum: 1,
          winnerIdx: null, winLine: null, drawOffer: null, rematch: {},
          abandonedBy: null, afk: null,
          players: { [myPid]: { name: name || 'Jugador 1', idx: 0, connected: true, isHost: true } },
        });
        if (isPublic) await set(_ref(`${MM}/${code}`), { status: 'waiting', createdAt: Date.now() });
      } catch (e) { _connErr(e); return; }
      _armDisconnect('waiting');
      _listen();
      enterWait();
    }

    /* Reserva sitio con una transacción. Sin esto, dos personas entrando a la
       vez en la misma sala se quedaban las dos con idx 1 (el lector de la
       comprobación "¿está llena?" y el escritor eran pasos separados), y una
       sala podía acabar con tres dentro. De paso barre a los desconectados
       que quedaron ocupando hueco. */
    /* Firebase llama al callback de una transacción con null cuando no hay una
       escucha VIVA en ese nodo (un get() previo no calienta esa caché), y al
       abortar no lo reintenta. Sin esto, entrar en una sala fallaba siempre.
       Durante la partida no se nota porque _listen() ya mantiene la escucha. */
    async function _withRoomListener(path, fn) {
      const { onValue } = FB();
      let off = null, settled = false;
      await new Promise((resolve) => {
        const done = () => { if (!settled) { settled = true; resolve(); } };
        off = onValue(_ref(path), done, done);
      });
      try { return await fn(); }
      finally { try { if (off) off(); } catch (e) {} }
    }

    async function _claimSeat(joinCode, name) {
      const { runTransaction } = FB();
      const pid = _genId();
      const path = `${ROOMS}/${joinCode}`;
      return _withRoomListener(path, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          let reason = null, res = null;
          try {
            res = await runTransaction(_ref(path), (r) => {
              if (!r) { reason = 'cold'; return; }
              if (r.status !== 'waiting') { reason = 'started'; return; }
              const ps = r.players || {};
              for (const id in ps) { if (!ps[id] || ps[id].connected === false) delete ps[id]; }
              const live = Object.values(ps);
              if (live.length >= 2) { reason = 'full'; return; }
              const idx = live.some(p => p.idx === 0) ? 1 : 0;
              ps[pid] = {
                name: name || (idx === 0 ? 'Jugador 1' : 'Jugador 2'),
                idx, connected: true, isHost: idx === 0,
              };
              r.players = ps;
              return r;
            });
          } catch (e) { return { error: 'conn' }; }
          const val = res && res.snapshot && res.snapshot.val();
          const me  = val && val.players && val.players[pid];
          if (me) return { pid, idx: me.idx, room: val };
          if (reason === 'cold' && attempt < 2) { await new Promise(r => setTimeout(r, 120)); continue; }
          return { error: reason === 'cold' ? 'missing' : (reason || (val ? 'full' : 'missing')) };
        }
        return { error: 'missing' };
      });
    }

    async function join(joinCode, name, opts) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return false; }
      const seat = await _claimSeat(joinCode, name);
      if (seat.error) {
        if (!(opts && opts.quiet)) {
          showToast({
            started: 'La partida ya ha empezado',
            full:    'La sala está llena',
            missing: 'Sala no encontrada',
            conn:    'No se pudo conectar al servidor',
          }[seat.error] || 'No se pudo entrar en la sala', 'err');
        }
        return false;
      }
      code = joinCode; myPid = seat.pid; myIdx = seat.idx;
      _resetSession();
      isPublicRoom = !!(seat.room && seat.room.isPublic);
      await FB().remove(_ref(`${MM}/${code}`)).catch(() => {});
      _armDisconnect('waiting');
      _listen();
      enterWait();
      return true;
    }

    async function findPublic(name) {
      if (!available()) { showToast('Sin conexión al servidor', 'err'); return; }
      const { get } = FB();
      let snap;
      try { snap = await get(_ref(MM)); } catch (e) { _connErr(e); return; }
      const index = (snap && snap.exists()) ? (snap.val() || {}) : {};
      const now = Date.now();
      const entries = Object.entries(index).filter(([, v]) => v && v.status === 'waiting');

      /* Barrido oportunista: el que pasa por aquí limpia lo que encuentra. Sin
         esto el índice solo crece y cada jugador nuevo prueba una a una todas
         las salas muertas antes de emparejar. */
      entries.filter(([, v]) => now - (v.createdAt || 0) > MM_TTL_MS).forEach(([c]) => {
        FB().remove(_ref(`${MM}/${c}`)).catch(() => {});
        FB().remove(_ref(`${ROOMS}/${c}`)).catch(() => {});
      });

      const fresh = entries
        .filter(([, v]) => now - (v.createdAt || 0) <= MM_TTL_MS)
        .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));   /* la que lleva más esperando, primero */

      for (const [c] of fresh) {
        let rs = null;
        try { rs = await get(_ref(`${ROOMS}/${c}`)); } catch (e) { continue; }
        const r = rs && rs.exists() ? rs.val() : null;
        const live = r ? Object.values(r.players || {}).filter(p => p && p.connected !== false) : [];
        /* Sala fantasma: sigue anunciada pero dentro no queda nadie vivo. */
        if (!r || r.status !== 'waiting' || live.length !== 1) {
          FB().remove(_ref(`${MM}/${c}`)).catch(() => {});
          if (r && !live.length) FB().remove(_ref(`${ROOMS}/${c}`)).catch(() => {});
          continue;
        }
        if (await join(c, name, { quiet: true })) return;
      }
      await create(name, true, PUBLIC_TARGET);
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

    /* Arranca la partida cuando hay 2 jugadores presentes. */
    async function _maybeStart() {
      if (_startBusy || !room || room.status !== 'waiting') return;
      if (_liveEntries().length < 2 || !_amDirector()) return;
      _startBusy = true;
      const res = generateGrid();
      /* Antes, si el generador fallaba se hacía "return" a secas: la sala se
         quedaba en "Empezando…" para siempre, sin aviso ni reintento. */
      if (!res) {
        showToast('Generando tablero…');
        setTimeout(() => { _startBusy = false; _maybeStart(); }, 900);
        return;
      }
      try {
        await FB().update(_ref(`${ROOMS}/${code}`), {
          status: 'playing', seed: res.seed, min: res.min, turn: 0, startedBy: 0,
          board: {}, usedIds: {}, passes: 0, series: {}, roundOver: null, gameNum: 1,
          winnerIdx: null, matchWinnerIdx: null, winLine: null,
          abandonedBy: null, afk: null,
          drawOffer: null, rematch: {}, turnStartAt: _stamp(),
        });
        await FB().remove(_ref(`${MM}/${code}`)).catch(() => {});
      } catch (e) { console.error('[Sync] start', e); }
      _startBusy = false;
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

    /* El director arranca la siguiente ronda tras una pausa (deja ver la línea). */
    function _maybeNextRound() {
      if (_nextRoundScheduled || !_amDirector()) return;
      if (!room || room.status !== 'playing' || !room.roundOver) return;
      _nextRoundScheduled = true;
      const res = generateGrid();
      const delay = room.roundOver.line ? 1600 : 1000;
      setTimeout(async () => {
        _nextRoundScheduled = false;
        if (!room || room.status !== 'playing' || !room.roundOver) return;
        if (!res) { _maybeNextRound(); return; }   /* reintenta con otra semilla */
        const w = room.roundOver.w;
        const starter = nextStarter(room.startedBy, (w === 0 || w === 1) ? w : null);
        try {
          await FB().update(_ref(`${ROOMS}/${code}`), {
            seed: res.seed, min: res.min, turn: starter, startedBy: starter,
            board: {}, usedIds: {}, afk: null,
            passes: 0, roundOver: null, winLine: null,
            gameNum: (room.gameNum || 1) + 1, turnStartAt: _stamp(),
          });
        } catch (e) {}
      }, delay);
    }

    /* El rival se fue: si borró su nodo (salió por el botón) se resuelve ya;
       si solo perdió la conexión se le da un margen por si vuelve. Sin esto,
       quien cerraba la pestaña dejaba al otro esperando un turno eterno. */
    function _watchOpponent() {
      clearTimeout(_goneTimer);
      if (!room || room.status !== 'playing') return;
      const others = Object.entries(room.players || {}).filter(([pid]) => pid !== myPid);
      if (others.some(([, p]) => p && p.connected !== false)) return;
      if (!others.length) { _declareAbandon(); return; }
      _goneTimer = setTimeout(_declareAbandon, GONE_GRACE_MS);
    }
    async function _declareAbandon() {
      if (_abandonBusy) return;
      _abandonBusy = true;
      try {
        await _tx((r) => {
          const others = Object.entries(r.players || {})
            .filter(([pid, p]) => pid !== myPid && p && p.connected !== false);
          if (others.length) return r;                  /* volvió justo a tiempo */
          r.status = 'finished'; r.matchWinnerIdx = myIdx; r.abandonedBy = 1 - myIdx;
          r.roundOver = null; r.winLine = null; r.drawOffer = null;
          return r;
        });
      } catch (e) {}
      _abandonBusy = false;
    }

    function onRoom() {
      const mine = (room.players || {})[myPid];
      if (!mine && room.status === 'waiting') {
        /* Nos barrieron de la sala (fantasma limpiado, sala reiniciada…). */
        showToast('Te has salido de la sala'); leave(); return;
      }
      if (mine) {
        /* Volver de segundo plano (móvil): Firebase reconecta solo, pero el
           onDisconnect ya saltó y nadie vuelve a poner connected:true — el
           rival te daría por ido y perderías la partida sentado delante. */
        if (mine.connected === false) {
          _armedFor = null;
          FB().update(_ref(`${ROOMS}/${code}/players/${myPid}`), { connected: true }).catch(() => {});
        }
        if (mine.idx !== myIdx) myIdx = mine.idx;
        _armDisconnect(room.status);
      }
      _watchOpponent();

      if (room.status === 'waiting') { stopTurnTimer(); _maybeStart(); renderWait(); return; }
      /* Proyectar sala → estado local G */
      const players = room.players || {};
      const nameByIdx = ['Jugador 1', 'Jugador 2'];
      for (const p of Object.values(players)) nameByIdx[p.idx] = p.name;
      const boardArr = new Array(9).fill(null);
      const bo = room.board || {};
      for (const k in bo) boardArr[+k] = bo[k];
      const grid = rebuildGrid(room.seed, room.min);
      if (!grid) {
        /* Los dos clientes reconstruyen la rejilla desde la semilla; si uno
           tiene datos distintos (caché vieja) saldría null y el render
           reventaba dejando la pantalla en blanco. */
        stopTurnTimer();
        showToast('No se pudo cargar el tablero. Recarga la página.', 'err');
        return;
      }
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
        abandoned: room.abandonedBy === (1 - myIdx) ? 'rival'
                 : room.abandonedBy === myIdx       ? 'yo' : null,
        oppGone: _liveEntries().length < 2,
      };
      try { window._ttt = G; } catch (e) {}

      if (finished) {
        stopTurnTimer();
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
      renderScore(); renderBoard();
      _renderDrawOffer();

      if (roundOver) {
        /* Fin de ronda: se muestra la línea y quién ganó; el director encadena. */
        stopTurnTimer();
        $('game-hint').textContent = (roundWinner === 0 || roundWinner === 1)
          ? `${G.players[roundWinner].name} gana la ronda`
          : 'Ronda en tablas';
        _maybeNextRound();
        return;
      }
      /* Reloj del turno: se reinicia solo cuando cambia de verdad (misma ronda,
         mismo turno y mismo token = la misma cuenta atrás sigue corriendo, no
         se reinicia porque llegue otra actualización de la sala). */
      const key = `${room.gameNum || 1}|${room.turn}|${room.turnStartAt || ''}`;
      if (key !== _turnKey) { _turnKey = key; _turnSeenAt = Date.now(); }
      startTurnTimer();

      /* Si el turno ha pasado al rival con la ventana de respuesta abierta
         (se agotó el tiempo mientras escribías), hay que cerrarla: si no, al
         enviar la jugada la transacción la descarta en silencio y el juego te
         dice "✓ correcto" sin haber puesto nada en el tablero. */
      if (pickIdx >= 0 && (G.turn !== myIdx || G.board[pickIdx])) {
        closePick();
        showToast('Ya no es tu turno', 'err');
      }

      $('game-hint').textContent = G.oppGone
        ? 'El rival ha perdido la conexión…'
        : (G.turn === myIdx)
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
      const live = _liveEntries();
      /* Antes bastaba con que "todos" hubieran pedido revancha; si el rival ya
         se había ido, "todos" era una sola persona y la partida se reiniciaba
         sola contra nadie. */
      if (live.length < 2 || !_amDirector()) return;
      if (!live.every(([pid]) => rm[pid])) return;
      const res = generateGrid();
      if (!res) return;
      await FB().update(_ref(`${ROOMS}/${code}`), {
        status: 'playing', seed: res.seed, min: res.min, turn: 0, startedBy: 0,
        board: {}, usedIds: {}, passes: 0, series: {}, roundOver: null, gameNum: 1,
        winnerIdx: null, matchWinnerIdx: null, winLine: null,
        abandonedBy: null, afk: null,
        drawOffer: null, rematch: {}, turnStartAt: _stamp(),
      });
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
        r.passes = 0; r.drawOffer = null; r.afk = null;
        const line = winningLineObj(r.board);
        if (line) _endRoundTx(r, myIdx, line);
        else if (countFilledObj(r.board) >= 9) _endRoundTx(r, decideByCellsObj(r.board), null);
        else r.turn = 1 - myIdx;
        r.turnStartAt = _stamp();
        return r;
      });
    }
    async function wrongAnswer() {
      await _tx((r) => {
        if (r.turn !== myIdx) return r;
        r.passes = 0; r.drawOffer = null; r.afk = null;
        r.turn = 1 - myIdx; r.turnStartAt = _stamp();
        return r;
      });
    }
    async function skip() {
      await _tx((r) => {
        if (r.turn !== myIdx) return r;
        r.passes = (r.passes || 0) + 1; r.afk = null;
        if (r.passes >= 2) _endRoundTx(r, decideByCellsObj(r.board || {}), null);
        else r.turn = 1 - myIdx;
        r.turnStartAt = _stamp();
        return r;
      });
    }

    /* Se agotó el turno. Lo dispara cualquiera de los dos (el rival con un
       margen), pero va atada al token del turno: solo se aplica una vez.
       Tres turnos agotados seguidos por la misma persona = abandono, y así el
       que sigue delante no se queda enganchado a un AFK ronda tras ronda. */
    async function timeout() {
      if (!room || room.status !== 'playing' || room.roundOver) return;
      const token = room.turnStartAt;
      await _tx((r) => {
        if (r.turnStartAt !== token || r.roundOver) return r;
        const slow = r.turn;
        const n = (r.afk && r.afk.i === slow) ? (r.afk.n || 0) + 1 : 1;
        r.afk = { i: slow, n };
        r.drawOffer = null;
        if (n >= AFK_STRIKES) {
          r.status = 'finished'; r.matchWinnerIdx = 1 - slow; r.abandonedBy = slow;
          r.roundOver = null; r.winLine = null;
          return r;
        }
        r.passes = (r.passes || 0) + 1;
        if (r.passes >= 2) _endRoundTx(r, decideByCellsObj(r.board || {}), null);
        else r.turn = 1 - slow;
        r.turnStartAt = _stamp();
        return r;
      });
      if (G && G.turn === myIdx) showToast('Se te acabó el tiempo', 'err');
    }
    async function offerDraw() {
      if (!room || room.status !== 'playing') return;
      await FB().update(_ref(`${ROOMS}/${code}`), { drawOffer: myPid });
      showToast('Propuesta de tablas enviada');
    }
    /* Aceptar tablas cierra la RONDA sin punto para nadie y encadena la
       siguiente; no termina la partida. */
    async function respondDraw(accept) {
      if (accept) {
        await _tx((r) => {
          r.drawOffer = null; r.afk = null;
          _endRoundTx(r, null, null);
          return r;
        });
        showToast('Ronda en tablas');
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
      const c = code, pid = myPid;
      stopTurnTimer();
      try { if (unsub) unsub(); } catch (e) {}
      unsub = null; code = null; myPid = null; room = null;
      _resetSession();
      showMenu();
      if (!c || !pid) return;
      try {
        const { get, remove, set } = FB();
        await remove(_ref(`${ROOMS}/${c}/players/${pid}`)).catch(() => {});
        const snap = await get(_ref(`${ROOMS}/${c}`));
        const r = snap && snap.exists() ? snap.val() : null;
        const rest = r ? Object.values(r.players || {}).filter(p => p && p.connected !== false) : [];
        if (!r || !rest.length) {
          /* Último en salir: apaga la luz. Antes las salas vacías se quedaban
             en la base de datos para siempre. */
          await remove(_ref(`${ROOMS}/${c}`)).catch(() => {});
          await remove(_ref(`${MM}/${c}`)).catch(() => {});
        } else if (r.isPublic && r.status === 'waiting') {
          /* Queda alguien esperando: que se le pueda seguir encontrando. */
          await set(_ref(`${MM}/${c}`), { status: 'waiting', createdAt: Date.now() }).catch(() => {});
        } else {
          await remove(_ref(`${MM}/${c}`)).catch(() => {});
        }
      } catch (e) {}
    }

    /* Las partidas públicas son 1vs1 y no hay nada que configurar: no pasan por
       el lobby, solo una pantalla de espera; en cuanto entra el segundo, la
       partida arranca sola. */
    function enterWait() {
      if (isPublicRoom) { showScreen('screen-searching'); renderWait(); return; }
      showScreen('screen-lobby');
      $('lobby-code-display').textContent = code;
      renderWait();
    }
    function renderWait() {
      if (!room) return;
      const ps = _liveEntries().map(([, p]) => p);
      if (isPublicRoom) {
        const t = $('searching-title'), h = $('searching-hint');
        if (t) t.textContent = ps.length < 2 ? 'Buscando rival…' : '¡Rival encontrado!';
        if (h) h.textContent = ps.length < 2
          ? 'Te emparejamos con la primera persona que entre.'
          : 'Empezando la partida…';
        return;
      }
      $('lobby-players').innerHTML = ps.map(p => {
        const initial = ((p.name || '?').trim().charAt(0) || '?').toUpperCase();
        return `<div class="lobby-player-row">
          <div class="lobby-player-avatar">${esc(initial)}</div>
          <span class="lobby-player-name">${esc(p.name)}</span>
          ${p.idx === 0 ? '<span class="lobby-player-host">ANFITRIÓN</span>' : ''}
          ${p.idx === myIdx ? '<span class="lobby-player-you">← TÚ</span>' : ''}
        </div>`;
      }).join('');
      const kicker = $('lobby-count');
      if (kicker) kicker.textContent = `Jugadores (${ps.length}/2)`;
      const t = room.targetWins || 3;
      const lt = $('lobby-target');
      if (lt) lt.textContent = `A ${t} victoria${t > 1 ? 's' : ''} para ganar`;
      $('lobby-hint').textContent = ps.length < 2 ? 'Esperando rival…' : 'Empezando…';
    }
    function getCode() { return code; }
    function opponentGone() { return _liveEntries().length < 2; }

    return {
      available, create, join, findPublic, move, wrongAnswer, skip, timeout,
      offerDraw, respondDraw, rematch, leave, getCode, opponentGone,
    };
  })();

  /* Estar en una sala se nota en la URL, y con quién eres apuntado al lado:
     así una recarga te devuelve a la sala en vez de al menú. El nombre va en
     localStorage y no en la URL — ahí sería un dato personal a la vista. */
  function marcarSala(name) {
    const code = Sync.getCode();
    if (!window.FHRuta || !code) return;
    FHRuta.set({ sala: code });
    FHRuta.recordarSala('tres-en-raya', code, name);
  }
  function desmarcarSala() {
    if (!window.FHRuta) return;
    FHRuta.borrar('sala');
    FHRuta.olvidarSala('tres-en-raya');
  }

  async function createRoom() {
    const name = ($('input-host-name').value || '').trim();
    if (!dataReady) { showToast('Cargando datos…'); return; }
    await Sync.create(name, false, hostTarget);
    marcarSala(name || 'Jugador 1');
  }
  async function joinRoom() {
    const name = ($('input-join-name').value || '').trim();
    const code = ($('input-join-code').value || '').trim().toUpperCase();
    if (!code) { showToast('Escribe un código', 'err'); return; }
    if (!dataReady) { showToast('Cargando datos…'); return; }
    if (await Sync.join(code, name)) marcarSala(name || 'Jugador 2');
  }
  async function findPublicRoom() {
    const name = ($('input-public-name').value || '').trim();
    if (!dataReady) { showToast('Cargando datos…'); return; }
    await Sync.findPublic(name);
    marcarSala(name || 'Jugador');
  }
  function leaveRoom() { desmarcarSala(); Sync.leave(); }
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

    /* Deep link ?sala=CODE. Dos casos distintos:
         · Venías de esta misma sala (recargaste, volviste a la pestaña): se
           sabe con qué nombre entraste, así que se vuelve solo.
         · Te acaban de pasar el enlace: se rellena el código y se pide nombre.
       Si la vuelta no sale, Sync.join() ya lo dice con su propio aviso
       ("La partida ya ha empezado", "Sala no encontrada"…). */
    try {
      const sala = window.FHRuta ? FHRuta.sala()
                                 : new URLSearchParams(location.search).get('sala');
      if (sala) {
        const btn = $('tab-private'); if (btn) btn.click();
        const inp = $('input-join-code'); if (inp) inp.value = sala.toUpperCase();

        const rec = window.FHRuta && FHRuta.salaRecordada('tres-en-raya', sala);
        if (rec) {
          const inp2 = $('input-join-name'); if (inp2) inp2.value = rec.nombre;
          if (await Sync.join(sala, rec.nombre)) marcarSala(rec.nombre);
          else desmarcarSala();
        } else {
          showToast('Escribe tu nombre y pulsa UNIRSE');
        }
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
