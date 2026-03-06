/* =============================================
   CADENA-GAME.JS
   Lógica de juego, UI, turnos, vidas, Firebase
   ============================================= */

/* ══════════════════════════════════════════════
   ESTADO GLOBAL
   ══════════════════════════════════════════════ */
const CadenaGame = (() => {

  const TURN_SECS = 15;

  let state = null;       // Estado del juego
  let timerInterval = null;
  let timerStart    = 0;
  let isMyTurn      = false;  // Para modo online

  /* ─── Estado inicial ─────────────────────────── */
  function freshState(players, lives) {
    return {
      players: players.map((name, i) => ({
        id: i, name,
        lives: lives,
        eliminated: false
      })),
      currentIndex: 0,
      chain: [],          // [{ type:'player'|'team', value, id?, data?, submittedBy }]
      chainLength: 0,
      lives,
      mode: 'local',      // 'local' | 'online'
      roomCode: null,
      isHost: false,
      myPlayerId: null,   // solo online
      phase: 'playing',   // 'playing' | 'finished'
    };
  }

  function getState()           { return state; }
  function getCurrentTurnType() {
    if (!state || !state.chain.length) return 'player';
    return state.chain[state.chain.length - 1].type === 'player' ? 'team' : 'player';
  }

  /* ─── Jugador activo ─────────────────────────── */
  function activePlayers()  { return state.players.filter(p => !p.eliminated); }
  function currentPlayer()  {
    const active = activePlayers();
    if (!active.length) return null;
    return active[state.currentIndex % active.length];
  }

  /* ─── Timer ──────────────────────────────────── */
  function startTimer() {
    clearInterval(timerInterval);
    timerStart = Date.now();
    updateTimerUI(TURN_SECS);

    timerInterval = setInterval(() => {
      const elapsed = (Date.now() - timerStart) / 1000;
      const remaining = Math.max(0, TURN_SECS - elapsed);
      updateTimerUI(remaining);
      if (remaining <= 0) {
        clearInterval(timerInterval);
        if (isMyTurn || state.mode === 'local') {
          onTimeout();
        }
      }
    }, 250);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    const bar  = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (bar)  { bar.style.width = '100%'; bar.classList.remove('warning'); }
    if (text) text.textContent = TURN_SECS;
  }

  function updateTimerUI(remaining) {
    const bar  = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (!bar || !text) return;
    const pct = (remaining / TURN_SECS) * 100;
    bar.style.width = pct + '%';
    bar.classList.toggle('warning', remaining <= 5);
    text.textContent = Math.ceil(remaining);
  }

  function onTimeout() {
    const cp = currentPlayer();
    if (!cp) return;
    App.showToast(`⏰ ¡Tiempo! ${cp.name} pierde una vida`, 'error');
    penalizeCurrentPlayer(`${cp.name} se quedó sin tiempo`);
  }

  /* ─── Penalización ───────────────────────────── */
  function penalizeCurrentPlayer(reason) {
    clearInterval(timerInterval);
    const cp = currentPlayer();
    if (!cp) return;

    cp.lives--;
    if (cp.lives <= 0) {
      cp.eliminated = true;
      showEliminated(cp, reason);
    } else {
      App.showToast(`❤️ Le quedan ${cp.lives} vida${cp.lives !== 1 ? 's' : ''}`, 'error');
      nextTurn();
    }
  }

  // Llamado desde CadenaData cuando la respuesta es incorrecta
  function penalizeWrongAnswer(value, type) {
    const cp = currentPlayer();
    if (!cp) return;
    penalizeCurrentPlayer(`"${value}" no es válido`);
  }

  /* ─── Añadir a la cadena (respuesta correcta) ── */
  function addToChain(entry) {
    clearInterval(timerInterval);

    const cp = currentPlayer();
    entry.submittedBy = cp?.name || '?';
    state.chain.push(entry);
    state.chainLength++;

    // Actualizar Firebase si online
    if (state.mode === 'online') {
      FBSync.pushChainEntry(entry);
    }

    renderChainEntry(entry);
    resetAnswerInput();
    nextTurn();
  }

  /* ─── Siguiente turno ────────────────────────── */
  function nextTurn() {
    const active = activePlayers();
    if (active.length <= 1) {
      endGame(active[0]);
      return;
    }

    // Avanzar índice (solo entre jugadores activos)
    state.currentIndex = (state.currentIndex + 1) % active.length;

    if (state.mode === 'online') {
      FBSync.pushTurnState();
    } else {
      beginTurn();
    }
  }

  function beginTurn() {
    const cp = currentPlayer();
    if (!cp) { endGame(null); return; }

    const type = getCurrentTurnType();
    isMyTurn   = (state.mode === 'local') ||
                 (state.myPlayerId !== null && cp.id === state.myPlayerId);

    updateGameUI();
    updateChainLabel();

    // Zona de respuesta
    const answerZone  = document.getElementById('answer-zone');
    const waitingMsg  = document.getElementById('waiting-msg');
    const input       = document.getElementById('answer-input');

    if (isMyTurn) {
      answerZone.classList.remove('hidden');
      waitingMsg.classList.add('hidden');
      input.disabled = false;
      input.value = '';
      CadenaData.closeSuggestions();
      startTimer();
      setTimeout(() => input.focus(), 100);
    } else {
      answerZone.classList.add('hidden');
      waitingMsg.classList.remove('hidden');
      document.getElementById('waiting-name').textContent = cp.name;
      startTimer(); // visual only
    }
  }

  /* ─── Fin de partida ─────────────────────────── */
  function endGame(winner) {
    clearInterval(timerInterval);
    state.phase = 'finished';

    setTimeout(() => {
      showScreen('screen-result');
      const wname = document.getElementById('winner-name');
      const stats = document.getElementById('chain-stats');
      wname.textContent = winner ? winner.name : '— Empate —';
      stats.innerHTML = `Cadena de <strong>${state.chainLength}</strong> eslabones<br>
        ${state.players.map(p =>
          `${p.eliminated ? '💀' : '✅'} ${p.name}`
        ).join('<br>')}`;
    }, 400);
  }

  /* ─── Eliminación ────────────────────────────── */
  function showEliminated(player, reason) {
    showScreen('screen-eliminated');
    document.getElementById('elim-title').textContent = `💀 ${player.name} ELIMINADO`;
    document.getElementById('elim-msg').textContent   =
      reason + '\n\nLa partida continúa sin él.';
  }

  /* ═══════════════════════════════════════════════
     UI RENDERING
     ═══════════════════════════════════════════════ */

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
  }

  function updateGameUI() {
    const cp    = currentPlayer();
    const type  = getCurrentTurnType();
    const lives = state.lives;

    // Turno indicator
    document.getElementById('turn-name').textContent = cp?.name || '—';

    // Badge tipo respuesta
    const badge = document.getElementById('answer-type-badge');
    badge.textContent = type === 'player' ? '⚽ JUGADOR' : '🏟️ EQUIPO';

    // Vidas de los jugadores
    const livesEl = document.getElementById('players-lives');
    livesEl.innerHTML = state.players.map(p => {
      const hearts = p.eliminated
        ? '💀'
        : Array(lives).fill(0).map((_, i) => i < p.lives ? '❤️' : '🖤').join('');
      const isActive = !p.eliminated && p.id === currentPlayer()?.id;
      return `<div class="player-life-card ${isActive ? 'active-player' : ''} ${p.eliminated ? 'eliminated' : ''}">
        <span class="plc-name">${p.name}</span>
        <span class="plc-hearts">${hearts}</span>
      </div>`;
    }).join('');
  }

  function updateChainLabel() {
    const type     = getCurrentTurnType();
    const label    = document.getElementById('chain-label');
    const prevName = state.chain.length
      ? state.chain[state.chain.length - 1].value || state.chain[state.chain.length - 1].name
      : null;

    if (!state.chain.length) {
      label.textContent = 'Di un JUGADOR de fútbol para empezar';
    } else if (type === 'team') {
      label.textContent = `¿En qué equipo jugó ${prevName}?`;
    } else {
      label.textContent = `¿Qué jugador jugó en ${prevName}?`;
    }
  }

  function renderChainEntry(entry) {
    const container = document.getElementById('chain-entries');
    const div = document.createElement('div');
    const val  = entry.name || entry.value || '?';
    const meta = entry.type === 'player'
      ? (entry.data?.nat || '') + (entry.data?.b ? ` · ${entry.data.b}` : '')
      : (entry.isOneClubMan ? '★ One-club man' : '');

    div.className = `chain-entry type-${entry.type}`;
    div.innerHTML = `
      <span class="ce-icon">${entry.type === 'player' ? '⚽' : '🏟️'}</span>
      <div class="ce-content">
        <div class="ce-value">${val}</div>
        ${meta ? `<div class="ce-meta">${meta}</div>` : ''}
      </div>
      <span class="ce-player">${entry.submittedBy || ''}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function resetAnswerInput() {
    const input = document.getElementById('answer-input');
    input.value = '';
    input.disabled = false;
    CadenaData.closeSuggestions();
  }

  /* ═══════════════════════════════════════════════
     FIREBASE ONLINE SYNC
     ═══════════════════════════════════════════════ */
  const FBSync = {
    roomRef:  null,
    unsubFns: [],

    roomPath(code) { return `rooms/${code}`; },

    /** Genera código de sala de 6 letras */
    genCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    },

    /** Host: crea sala en Firebase */
    async createRoom(players, lives) {
      const FB = window._FB;
      if (!FB?.configured) { App.showToast('Firebase no configurado', 'error'); return null; }

      const code = this.genCode();
      const { db, ref, set, serverTimestamp } = FB;
      const rRef = ref(db, this.roomPath(code));

      const roomData = {
        status: 'lobby',
        lives,
        hostId: 0,
        players: players.map((name, i) => ({ id: i, name, lives, eliminated: false })),
        turnIndex: 0,
        chain: [],
        chainLength: 0,
        createdAt: serverTimestamp()
      };

      await set(rRef, roomData);
      this.roomRef = rRef;
      return code;
    },

    /** Joiner: se une a una sala */
    async joinRoom(code, playerName) {
      const FB = window._FB;
      if (!FB?.configured) throw new Error('Firebase no configurado');
      const { db, ref, get, update, serverTimestamp } = FB;
      const rRef = ref(db, this.roomPath(code));
      const snap = await get(rRef);
      if (!snap.exists()) throw new Error('Sala no encontrada');
      const roomData = snap.val();
      if (roomData.status !== 'lobby') throw new Error('La partida ya empezó');

      const newId = roomData.players.length;
      const updPlayers = [...roomData.players, { id: newId, name: playerName, lives: roomData.lives, eliminated: false }];
      await update(rRef, { players: updPlayers });
      this.roomRef = rRef;
      return { roomData: { ...roomData, players: updPlayers }, myId: newId };
    },

    /** Host inicia la partida */
    async startGame(code) {
      const FB = window._FB;
      const { db, ref, update } = FB;
      await update(ref(db, this.roomPath(code)), { status: 'playing' });
    },

    /** Escucha cambios en la sala */
    listenRoom(code, onUpdate) {
      const FB = window._FB;
      if (!FB?.configured) return;
      const { db, ref, onValue } = FB;
      const rRef = ref(db, this.roomPath(code));
      const unsub = onValue(rRef, snap => {
        if (snap.exists()) onUpdate(snap.val());
      });
      this.unsubFns.push(unsub);
    },

    /** Empuja una entrada en la cadena */
    async pushChainEntry(entry) {
      const FB = window._FB;
      if (!FB?.configured || !this.roomRef) return;
      const { db, ref, update } = FB;
      const code = state.roomCode;

      // Construir cadena serializable
      const chainEntry = { type: entry.type, submittedBy: entry.submittedBy };
      if (entry.name)  chainEntry.name  = entry.name;
      if (entry.value) chainEntry.value = entry.value;
      if (entry.id)    chainEntry.id    = entry.id;
      if (entry.isOneClubMan) chainEntry.isOneClubMan = true;

      const newChain = [...(state.chain.map(e => ({
        type: e.type,
        name: e.name,
        value: e.value,
        id: e.id,
        isOneClubMan: e.isOneClubMan,
        submittedBy: e.submittedBy
      })))];
      newChain.push(chainEntry);

      await update(ref(FB.db, this.roomPath(code)), {
        chain: newChain,
        chainLength: newChain.length
      });
    },

    /** Empuja el estado del turno */
    async pushTurnState() {
      const FB = window._FB;
      if (!FB?.configured || !state.roomCode) return;
      const { db, ref, update, serverTimestamp } = FB;

      const playersSerial = state.players.map(p => ({
        id: p.id, name: p.name, lives: p.lives, eliminated: p.eliminated
      }));

      await update(ref(db, this.roomPath(state.roomCode)), {
        turnIndex: state.currentIndex,
        players: playersSerial,
        turnStartTime: serverTimestamp(),
        status: state.phase === 'finished' ? 'finished' : 'playing'
      });
    },

    cleanup() {
      this.unsubFns.forEach(fn => fn());
      this.unsubFns = [];
    }
  };

  /* ─── Aplicar estado remoto (online) ── */
  function applyRemoteState(remote) {
    if (!state) return;

    // Actualizar jugadores y vidas
    if (remote.players) {
      state.players = remote.players.map(rp => ({
        ...rp,
        lives: rp.lives ?? state.lives,
        eliminated: rp.eliminated ?? false
      }));
    }

    // Actualizar índice de turno
    if (typeof remote.turnIndex === 'number') {
      state.currentIndex = remote.turnIndex;
    }

    // Actualizar cadena
    if (remote.chain && remote.chain.length !== state.chain.length) {
      state.chain = remote.chain;
      state.chainLength = remote.chainLength || remote.chain.length;
      // Re-render sólo entradas nuevas
      const container = document.getElementById('chain-entries');
      container.innerHTML = '';
      state.chain.forEach(e => renderChainEntry(e));
    }

    if (remote.status === 'playing') beginTurn();
    if (remote.status === 'finished') endGame(activePlayers()[0]);
  }

  /* ═══════════════════════════════════════════════
     API PÚBLICA DE CadenaGame
     ═══════════════════════════════════════════════ */
  return { getState, getCurrentTurnType, addToChain, penalizeWrongAnswer, beginTurn, FBSync, applyRemoteState };

})();

/* ══════════════════════════════════════════════
   APP — Navegación y setup
   ══════════════════════════════════════════════ */
const App = (() => {

  let selectedLives = 1;
  let selectedTime  = 15;
  let selectedType  = 'local';

  /* ── Pantallas ── */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const t = document.getElementById(id);
    if (t) { t.classList.add('active'); }
  }

  function showMenu() {
    CadenaGame.FBSync.cleanup();
    showScreen('screen-menu');
  }
  function showCreateGame() { showScreen('screen-create'); }
  function showJoinGame()   { showScreen('screen-join'); }

  /* ── Modo de vidas ── */
  function selectMode(card) {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedLives = parseInt(card.dataset.mode);
  }

  /* ── Tiempo por turno ── */
  function selectTime(card) {
    document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedTime = parseInt(card.dataset.time);
  }

  /* ── Tipo (local / online) ── */
  function setType(type) {
    selectedType = type;
    document.getElementById('btn-local').classList.toggle('active', type === 'local');
    document.getElementById('btn-online').classList.toggle('active', type === 'online');
    document.getElementById('type-note-local').classList.toggle('hidden', type !== 'local');
    document.getElementById('type-note-online').classList.toggle('hidden', type !== 'online');
  }

  /* ── Jugadores ── */
  function addPlayer() {
    const rows = document.querySelectorAll('.player-input-row');
    if (rows.length >= 8) { showToast('Máximo 8 jugadores', 'error'); return; }
    const n = rows.length + 1;
    const div = document.createElement('div');
    div.className = 'player-input-row';
    div.innerHTML = `
      <span class="player-num">${n}</span>
      <input class="player-name-input" type="text" placeholder="Nombre del jugador ${n}" maxlength="20" />
      <button class="remove-player-btn" onclick="App.removePlayer(this)">✕</button>`;
    document.getElementById('player-inputs').appendChild(div);
    updateRemoveButtons();
  }

  function removePlayer(btn) {
    const rows = document.querySelectorAll('.player-input-row');
    if (rows.length <= 2) return;
    btn.closest('.player-input-row').remove();
    // Renumerar
    document.querySelectorAll('.player-input-row').forEach((row, i) => {
      row.querySelector('.player-num').textContent = i + 1;
      row.querySelector('input').placeholder = `Nombre del jugador ${i + 1}`;
    });
    updateRemoveButtons();
  }

  function updateRemoveButtons() {
    const rows = document.querySelectorAll('.player-input-row');
    rows.forEach((row, i) => {
      const btn = row.querySelector('.remove-player-btn');
      btn.style.visibility = rows.length > 2 ? 'visible' : 'hidden';
    });
  }

  function getPlayerNames() {
    return [...document.querySelectorAll('.player-name-input')]
      .map(i => i.value.trim())
      .filter(n => n.length > 0);
  }

  /* ── Iniciar partida ── */
  async function startGame() {
    const names = getPlayerNames();
    if (names.length < 2) { showToast('Necesitas al menos 2 jugadores', 'error'); return; }

    try {
      await CadenaData.init();
    } catch (err) {
      showToast('Error al cargar datos: ' + err.message, 'error');
      console.error('CadenaData.init error:', err);
      return;
    }

    if (selectedType === 'online') {
      if (!window._FB?.configured) {
        showToast('Firebase no configurado para modo online', 'error');
        return;
      }
      await startOnlineAsHost(names, selectedLives, selectedTime);
    } else {
      startLocalGame(names, selectedLives, selectedTime);
    }
  }

  function startLocalGame(names, lives, turnSecs) {
    _startGameUI(names, lives, 'local', null, null, turnSecs || 15);
  }

  function _startGameUI(names, lives, mode, roomCode, myId, turnSecs) {
    // Construir estado en el módulo de juego
    const state = {
      players: names.map((name, i) => ({ id: i, name, lives, eliminated: false })),
      currentIndex: 0,
      chain: [],
      chainLength: 0,
      lives,
      turnSecs: turnSecs || 15,
      mode,
      roomCode,
      isHost: true,
      myPlayerId: myId,
      phase: 'playing'
    };

    // Inyectar estado al módulo CadenaGame a través de un reset
    _injectState(state);

    // Limpiar UI del juego
    document.getElementById('chain-entries').innerHTML = '';
    showScreen('screen-game');
    CadenaGame.beginTurn();
  }

  /* Inyectar estado al módulo cerrado mediante eval temporal */
  function _injectState(newState) {
    // Re-exponer beginTurn con el estado correcto usando closure trick:
    // En lugar de closure privado, exponemos el estado mediante una función de reset
    CadenaGame._resetState(newState);
  }

  /* ── Online: host crea sala ── */
  async function startOnlineAsHost(names, lives, turnSecs) {
    showToast('Creando sala…');
    try {
      const code = await CadenaGame.FBSync.createRoom(names, lives);
      if (!code) return;

      showScreen('screen-lobby');
      document.getElementById('room-code-display').textContent = code;
      document.getElementById('lobby-mode-display').textContent =
        `${lives === 1 ? '💀 Supervivencia' : lives === 2 ? '⚽ Normal' : '🏆 Largo'} · ${names.length} jugadores`;
      document.getElementById('btn-start-online').style.display = 'block';

      renderLobbyPlayers(names, 0);

      // Escuchar sala para ver si se unen más
      CadenaGame.FBSync.listenRoom(code, remote => {
        if (remote.players) renderLobbyPlayers(remote.players.map(p => p.name), 0);
        if (remote.status === 'playing') {
          _startGameUI(remote.players.map(p => p.name), remote.lives, 'online', code, 0, turnSecs || 15);
        }
      });

      // Guardar código en estado local
      window._pendingRoomCode = code;
      window._pendingNames    = names;
      window._pendingLives    = lives;

    } catch (err) {
      showToast('Error al crear sala: ' + err.message, 'error');
    }
  }

  function startOnlineGame() {
    CadenaGame.FBSync.startGame(window._pendingRoomCode);
  }

  /* ── Online: unirse ── */
  async function joinRoom() {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!name) { showToast('Escribe tu nombre', 'error'); return; }
    if (code.length !== 6) { showToast('El código debe tener 6 caracteres', 'error'); return; }

    showToast('Conectando…');
    try {
      await CadenaData.init();
      const { roomData, myId } = await CadenaGame.FBSync.joinRoom(code, name);

      showScreen('screen-lobby');
      document.getElementById('room-code-display').textContent = code;
      document.getElementById('btn-start-online').style.display = 'none';

      renderLobbyPlayers(roomData.players.map(p => p.name), myId);

      CadenaGame.FBSync.listenRoom(code, remote => {
        if (remote.players) renderLobbyPlayers(remote.players.map(p => p.name), myId);
        if (remote.status === 'playing') {
          _startGameUI(remote.players.map(p => p.name), remote.lives, 'online', code, myId);
          // Re-aplicar cambios remotos en curso
          CadenaGame.FBSync.listenRoom(code, CadenaGame.applyRemoteState);
        }
      });

    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderLobbyPlayers(names, myId) {
    const list = document.getElementById('lobby-players-list');
    list.innerHTML = names.map((name, i) => `
      <div class="lobby-player-item">
        <div class="lobby-player-avatar">${name[0].toUpperCase()}</div>
        <span class="lobby-player-name">${name}</span>
        ${i === 0 ? '<span class="lobby-player-host">👑 Host</span>' : ''}
        ${i === myId ? '<span class="lobby-player-host">← Tú</span>' : ''}
      </div>`).join('');
  }

  /* ── Sala: copiar código ── */
  function copyRoomCode() {
    const code = document.getElementById('room-code-display').textContent;
    navigator.clipboard.writeText(code).then(() => showToast('¡Código copiado!', 'success'));
  }

  /* ── Después de eliminación ── */
  function continueAfterElim() {
    // Resetear la cadena cuando un jugador es eliminado
    const s = CadenaGame._state;
    if (s) {
      s.chain = [];
      s.chainLength = 0;
      document.getElementById('chain-entries').innerHTML = '';
    }
    // Ocultar el panel de opciones válidas si estaba visible
    const vop = document.getElementById('valid-options-panel');
    if (vop) vop.classList.add('hidden');
    showScreen('screen-game');
    CadenaGame.beginTurn();
  }

  /* ── Jugar de nuevo ── */
  function playAgain() {
    showScreen('screen-create');
    document.getElementById('chain-entries').innerHTML = '';
  }

  /* ── Toast ── */
  let toastTimer = null;
  function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent  = msg;
    el.className    = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  /* ── Firebase status ── */
  function updateFBStatus() {
    const indicator = document.getElementById('fb-indicator');
    const text      = document.getElementById('fb-text');
    if (window._FB?.configured) {
      indicator.textContent = '●';
      indicator.className = 'ok';
      text.textContent = 'Firebase conectado — modo online disponible';
    }
  }

  /* ── Init ── */
  function init() {
    updateFBStatus();
  }

  return {
    showMenu, showCreateGame, showJoinGame,
    selectMode, selectTime, setType, addPlayer, removePlayer,
    startGame, startOnlineGame, joinRoom,
    copyRoomCode, continueAfterElim, playAgain,
    showToast, init, _startGameUI
  };

})();

/* ══════════════════════════════════════════════
   RESET DE ESTADO (puente entre módulos)
   ══════════════════════════════════════════════ */

// Añadimos _resetState al módulo CadenaGame desde fuera
// (necesario porque el módulo es un IIFE con closure)
;(function patchCadenaGame() {
  let _state = null;

  // Sobreescribir getState y getCurrentTurnType con acceso al estado parchado
  const orig = CadenaGame.getState;
  CadenaGame._resetState = function(newState) {
    _state = newState;
    // Parchear todas las referencias internas que usaban state
    CadenaGame._state = _state;
  };

  // Parchear getState para devolver el estado actual
  CadenaGame.getState = function() { return CadenaGame._state; };

  CadenaGame.getCurrentTurnType = function() {
    const s = CadenaGame._state;
    if (!s || !s.chain.length) return 'player';
    return s.chain[s.chain.length - 1].type === 'player' ? 'team' : 'player';
  };

  CadenaGame.addToChain = function(entry) {
    const s = CadenaGame._state;
    if (!s) return;
    clearInterval(window._timerInterval);

    const active = s.players.filter(p => !p.eliminated);
    const cp = active[s.currentIndex % active.length];
    entry.submittedBy = cp?.name || '?';
    s.chain.push(entry);
    s.chainLength++;

    _renderEntry(entry);
    _nextTurn();
  };

  CadenaGame.penalizeWrongAnswer = function(value, type, validOptions) {
    const s = CadenaGame._state;
    if (!s) return;
    clearInterval(window._timerInterval);
    const active = s.players.filter(p => !p.eliminated);
    const cp = active[s.currentIndex % active.length];
    if (!cp) return;
    cp.lives--;
    if (cp.lives <= 0) {
      cp.eliminated = true;
      _showEliminated(cp, `"${value}" no es válido`, validOptions);
    } else {
      // Mostrar opciones válidas en el panel del juego (no-eliminación)
      _showValidOptionsPanel(validOptions);
      App.showToast(`❤️ Le quedan ${cp.lives} vida${cp.lives !== 1 ? 's' : ''}`, 'error');
      _nextTurn();
    }
  };

  CadenaGame.beginTurn = function() {
    const s = CadenaGame._state;
    if (!s) return;

    // Ocultar panel de opciones válidas al inicio de cada turno
    const vop = document.getElementById('valid-options-panel');
    if (vop) vop.classList.add('hidden');

    const active = s.players.filter(p => !p.eliminated);
    if (active.length <= 1) { _endGame(active[0]); return; }

    const cp   = active[s.currentIndex % active.length];
    const type = CadenaGame.getCurrentTurnType();

    // Actualizar UI de vidas y turno
    document.getElementById('turn-name').textContent = cp?.name || '—';
    document.getElementById('answer-type-badge').textContent = type === 'player' ? '⚽ JUGADOR' : '🏟️ EQUIPO';
    _updateLives();
    _updateLabel();

    const answerZone = document.getElementById('answer-zone');
    const waitingMsg = document.getElementById('waiting-msg');
    const input      = document.getElementById('answer-input');

    const isMyTurn = (s.mode === 'local') || (s.myPlayerId !== null && cp.id === s.myPlayerId);

    if (isMyTurn) {
      answerZone.classList.remove('hidden');
      waitingMsg.classList.add('hidden');
      input.disabled = false;
      input.value = '';
      CadenaData.closeSuggestions();
      _startTimer();
      setTimeout(() => input.focus(), 100);
    } else {
      answerZone.classList.add('hidden');
      waitingMsg.classList.remove('hidden');
      document.getElementById('waiting-name').textContent = cp.name;
      _startTimer();
    }
  };

  CadenaGame.applyRemoteState = function(remote) {
    const s = CadenaGame._state;
    if (!s) return;
    if (remote.players) s.players = remote.players;
    if (typeof remote.turnIndex === 'number') s.currentIndex = remote.turnIndex;
    if (remote.chain && remote.chain.length !== s.chain.length) {
      s.chain = remote.chain;
      s.chainLength = remote.chainLength || remote.chain.length;
      const c = document.getElementById('chain-entries');
      c.innerHTML = '';
      s.chain.forEach(e => _renderEntry(e));
    }
    if (remote.status === 'playing') CadenaGame.beginTurn();
    if (remote.status === 'finished') {
      const active = s.players.filter(p => !p.eliminated);
      _endGame(active[0]);
    }
  };

  /* ── Helpers internos del parche ── */

  function _startTimer() {
    clearInterval(window._timerInterval);
    const start = Date.now();
    const s = CadenaGame._state;
    const SECS = s?.turnSecs || 15;

    // Mostrar valor inicial inmediatamente
    const barInit  = document.getElementById('timer-bar');
    const textInit = document.getElementById('timer-text');
    if (barInit)  { barInit.style.width = '100%'; barInit.classList.remove('warning'); }
    if (textInit) textInit.textContent = SECS;

    window._timerInterval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const rem = Math.max(0, SECS - elapsed);
      const bar  = document.getElementById('timer-bar');
      const text = document.getElementById('timer-text');
      if (bar)  { bar.style.width = (rem / SECS * 100) + '%'; bar.classList.toggle('warning', rem <= 5); }
      if (text) text.textContent = Math.ceil(rem);

      if (rem <= 0) {
        clearInterval(window._timerInterval);
        const isMyTurn = s.mode === 'local' || s.myPlayerId !== null &&
          s.players.filter(p => !p.eliminated)[s.currentIndex % s.players.filter(p => !p.eliminated).length]?.id === s.myPlayerId;
        if (isMyTurn) {
          const active = s.players.filter(p => !p.eliminated);
          const cp = active[s.currentIndex % active.length];
          App.showToast(`⏰ ¡Tiempo! ${cp?.name} pierde una vida`, 'error');
          if (cp) {
            cp.lives--;
            if (cp.lives <= 0) { cp.eliminated = true; _showEliminated(cp, 'Se quedó sin tiempo', null); }
            else { App.showToast(`❤️ Le quedan ${cp.lives} vida${cp.lives !== 1 ? 's' : ''}`, 'error'); _nextTurn(); }
          }
        }
      }
    }, 250);
  }

  function _nextTurn() {
    const s = CadenaGame._state;
    const active = s.players.filter(p => !p.eliminated);
    if (active.length <= 1) { _endGame(active[0]); return; }
    s.currentIndex = (s.currentIndex + 1) % active.length;
    if (s.mode === 'online') CadenaGame.FBSync.pushTurnState();
    setTimeout(() => CadenaGame.beginTurn(), 400);
  }

  function _showEliminated(player, reason, validOptions) {
    clearInterval(window._timerInterval);
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-eliminated').classList.add('active');
    document.getElementById('elim-title').textContent = `💀 ${player.name} ELIMINADO`;
    document.getElementById('elim-msg').textContent   = reason + '\n\nLa partida continúa sin él.';

    // Mostrar opciones válidas que había en la pantalla de eliminado
    const elimOpts = document.getElementById('elim-valid-options');
    const elimList = document.getElementById('elim-options-list');
    if (elimOpts && elimList) {
      if (validOptions && validOptions.length > 0) {
        elimList.innerHTML = validOptions.slice(0, 10).map(o =>
          `<span class="valid-option-tag">${o}</span>`
        ).join('');
        elimOpts.classList.remove('hidden');
      } else {
        elimOpts.classList.add('hidden');
      }
    }
  }

  function _showValidOptionsPanel(validOptions) {
    const panel = document.getElementById('valid-options-panel');
    const list  = document.getElementById('valid-options-list');
    if (!panel || !list) return;
    if (validOptions && validOptions.length > 0) {
      list.innerHTML = validOptions.slice(0, 10).map(o =>
        `<span class="valid-option-tag">${o}</span>`
      ).join('');
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  function _endGame(winner) {
    clearInterval(window._timerInterval);
    const s = CadenaGame._state;
    if (s) s.phase = 'finished';
    setTimeout(() => {
      document.querySelectorAll('.screen').forEach(sc => sc.classList.remove('active'));
      document.getElementById('screen-result').classList.add('active');
      document.getElementById('winner-name').textContent = winner ? winner.name : '— Empate —';
      document.getElementById('chain-stats').innerHTML =
        `Cadena de <strong>${s?.chainLength || 0}</strong> eslabones<br>` +
        (s?.players || []).map(p => `${p.eliminated ? '💀' : '✅'} ${p.name}`).join('<br>');
    }, 400);
  }

  function _renderEntry(entry) {
    const container = document.getElementById('chain-entries');
    const div = document.createElement('div');
    const val  = entry.name || entry.value || '?';
    const meta = entry.type === 'player'
      ? (entry.data?.nat || '') + (entry.data?.b ? ` · ${entry.data.b}` : '')
      : (entry.isOneClubMan ? '★ One-club man' : '');
    div.className = `chain-entry type-${entry.type}`;
    div.innerHTML = `
      <span class="ce-icon">${entry.type === 'player' ? '⚽' : '🏟️'}</span>
      <div class="ce-content">
        <div class="ce-value">${val}</div>
        ${meta ? `<div class="ce-meta">${meta}</div>` : ''}
      </div>
      <span class="ce-player">${entry.submittedBy || ''}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function _updateLives() {
    const s = CadenaGame._state;
    if (!s) return;
    const active = s.players.filter(p => !p.eliminated);
    const cp = active[s.currentIndex % active.length];
    document.getElementById('players-lives').innerHTML = s.players.map(p => {
      const hearts = p.eliminated
        ? '💀'
        : Array(s.lives).fill(0).map((_, i) => i < p.lives ? '❤️' : '🖤').join('');
      const isActive = !p.eliminated && p.id === cp?.id;
      return `<div class="player-life-card ${isActive ? 'active-player' : ''} ${p.eliminated ? 'eliminated' : ''}">
        <span class="plc-name">${p.name}</span>
        <span class="plc-hearts">${hearts}</span>
      </div>`;
    }).join('');
  }

  function _updateLabel() {
    const s = CadenaGame._state;
    if (!s) return;
    const type = CadenaGame.getCurrentTurnType();
    const label = document.getElementById('chain-label');
    const prev = s.chain.length ? s.chain[s.chain.length - 1] : null;
    const prevVal = prev ? (prev.name || prev.value) : null;
    if (!s.chain.length)          label.textContent = 'Di un JUGADOR de fútbol para empezar';
    else if (type === 'team')      label.textContent = `¿En qué equipo jugó ${prevVal}?`;
    else                           label.textContent = `¿Qué jugador jugó en ${prevVal}?`;
  }

})();

/* ══════════════════════════════════════════════
   ARRANQUE
   ══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  // Precargar datos en background nada más cargar la página,
  // para que al iniciar partida ya estén listos y no haya lag en el primer turno.
  CadenaData.init().catch(() => {});
});
