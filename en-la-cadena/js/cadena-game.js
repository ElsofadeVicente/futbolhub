/* =============================================
   CADENA-GAME.JS
   Lógica de juego, UI, turnos, vidas, Firebase
   ============================================= */

/* ── Escapa texto para insertar de forma segura en HTML (texto o atributo) ── */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Cuenta (FutbolHUB): si hay sesión, usar usuario y foto ── */
function _accName(inputId) {
  const id = window.FHAuth && FHAuth.identity && FHAuth.identity();
  if (id && id.username) return id.username;
  return (document.getElementById(inputId)?.value || '').trim();
}
function _accAvatar() {
  const id = window.FHAuth && FHAuth.identity && FHAuth.identity();
  return (id && id.avatarUrl) || null;
}
function _avatarInner(p) {
  if (window.FHAuth && FHAuth.avatarInner) return FHAuth.avatarInner(p && p.name, p && p.avatar);
  return escapeHtml(((p && p.name) || '?').charAt(0).toUpperCase());
}
function _setupAccountName() {
  if (!(window.FHAuth && FHAuth.onIdentity)) return;
  const INPUTS = ['menu-host-name', 'menu-player-name', 'join-name-inline', 'join-name'];
  FHAuth.onIdentity(id => {
    INPUTS.forEach(i => { const el = document.getElementById(i); if (el) el.style.display = id ? 'none' : ''; });
    document.querySelectorAll('.account-name-hint').forEach(h => h.remove());
    if (id) INPUTS.forEach(i => {
      const el = document.getElementById(i);
      if (!el) return;
      const hint = document.createElement('p');
      hint.className = 'account-name-hint';
      hint.style.cssText = 'margin:0 0 8px;opacity:.7;font-size:.8rem;';
      hint.textContent = 'Entras como @' + id.username;
      el.parentNode.insertBefore(hint, el);
    });
  });
}

/* ══════════════════════════════════════════════
   CADENAGAME
   La lógica real de turnos/vidas/cadena vive en el bloque
   "CADENAGAME — LÓGICA DE JUEGO" más abajo en este mismo archivo, que
   trabaja sobre CadenaGame._state (inyectado por App._startGameUI).
   Aquí solo se expone FBSync, que sí se usa tal cual.
   ══════════════════════════════════════════════ */
const CadenaGame = (() => {

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
    async createRoom(players, lives, avatars) {
      const FB = window._FB;
      if (!FB?.configured) { App.showToast('Firebase no configurado', 'error'); return null; }

      const code = this.genCode();
      const { db, ref, set, serverTimestamp } = FB;
      const rRef = ref(db, this.roomPath(code));
      /* Auth anónima — PRIMER PASO del rediseño de identidad (sin tocar
         reglas todavía). Solo el índice 0 es el cliente real que crea la
         sala; los demás nombres de este array (si algún día se pasa más de
         uno) son de pase-y-juega local, no clientes autenticados aparte. */
      const uid = await window._FBAuthReady;

      const roomData = {
        status: 'lobby',
        lives,
        hostId: 0,
        players: players.map((name, i) => ({ id: i, name, avatar: (avatars && avatars[i]) || null, lives, eliminated: false, uid: i === 0 ? uid : null })),
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
    async joinRoom(code, playerName, avatar) {
      const FB = window._FB;
      if (!FB?.configured) throw new Error('Firebase no configurado');
      const { db, ref, get, update, serverTimestamp } = FB;
      const rRef = ref(db, this.roomPath(code));
      const snap = await get(rRef);
      if (!snap.exists()) throw new Error('Sala no encontrada');
      const roomData = snap.val();
      if (roomData.status !== 'lobby') throw new Error('La partida ya empezó');

      const newId = roomData.players.length;
      const uid = await window._FBAuthReady;
      const updPlayers = [...roomData.players, { id: newId, name: playerName, avatar: avatar || null, lives: roomData.lives, eliminated: false, uid }];
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

    /** Empuja el estado del turno */
    async pushTurnState() {
      const FB = window._FB;
      const s = CadenaGame._state;
      if (!FB?.configured || !s?.roomCode) return;
      const { db, ref, update, serverTimestamp } = FB;

      const playersSerial = s.players.map(p => ({
        id: p.id, name: p.name, lives: p.lives, eliminated: p.eliminated
      }));

      await update(ref(db, this.roomPath(s.roomCode)), {
        turnIndex: s.currentIndex,
        players: playersSerial,
        turnStartTime: serverTimestamp(),
        status: s.phase === 'finished' ? 'finished' : 'playing'
      });
    },

    cleanup() {
      this.unsubFns.forEach(fn => fn());
      this.unsubFns = [];
    }
  };

  /* ═══════════════════════════════════════════════
     API PÚBLICA DE CadenaGame
     getState, getCurrentTurnType, addToChain, penalizeWrongAnswer,
     beginTurn y applyRemoteState se definen más abajo en el bloque
     "CADENAGAME — LÓGICA DE JUEGO", que sobrescribe estas propiedades
     con la implementación real (basada en CadenaGame._state).
     ═══════════════════════════════════════════════ */
  return { FBSync };

})();

/* ── Helper global: Firebase convierte arrays en objetos {0:{...},1:{...}} ── */
function toPlayersArray(players) {
  if (!players) return [];
  if (!Array.isArray(players)) players = Object.values(players);
  return players.filter(p => p && p.name);
}

/* ══════════════════════════════════════════════
   APP — Navegación y setup
   ══════════════════════════════════════════════ */
const App = (() => {

  let selectedLives = 1;
  let selectedTime  = 15;
  let selectedType  = 'local';

  /* ── Pantallas ── */
  function showScreen(id) {
    /* Se busca la pantalla PRIMERO y solo se apagan las demás si existe. Al
       revés —apagar todas y luego encender— basta con que el id no esté (un
       renombrado, una pantalla retirada) para dejar la página sin ninguna
       pantalla activa: en blanco y, en la PWA, sin forma de salir. */
    const t = document.getElementById(id);
    if (!t) { console.error('[En la Cadena] No existe la pantalla #' + id); return; }
    t.classList.add('active');
    document.querySelectorAll('.screen').forEach(s => {
      if (s !== t) s.classList.remove('active');
    });
  }

  function showMenu() {
    CadenaGame.FBSync.cleanup();
    // Limpiar el parámetro ?sala= de la URL al volver al menú
    history.pushState(null, '', window.location.pathname);
    if (window.FHRuta) FHRuta.olvidarSala('en-la-cadena');
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

    // Mostrar bloque jugadores (local) u online-host (online)
    const localBlock  = document.getElementById('local-players-block');
    const onlineBlock = document.getElementById('online-host-block');
    if (localBlock)  localBlock.classList.toggle('hidden', type !== 'local');
    if (onlineBlock) onlineBlock.classList.toggle('hidden', type !== 'online');

    // Cambiar texto del botón de inicio
    const btnStart = document.querySelector('.btn-start');
    if (btnStart) btnStart.textContent = type === 'online' ? 'CREAR SALA ▶' : 'EMPEZAR ▶';
  }

  /* ── Jugadores ── */
  function addPlayer() {
    const container = document.getElementById('menu-local-players') || document.getElementById('player-inputs');
    const rows = container.querySelectorAll('.player-input-row');
    if (rows.length >= 8) { showToast('Máximo 8 jugadores', 'error'); return; }
    const n = rows.length + 1;
    const div = document.createElement('div');
    div.className = 'player-input-row';
    div.innerHTML = `
      <span class="player-num">${n}</span>
      <input class="player-name-input" type="text" placeholder="Jugador ${n}" maxlength="20" />
      <button class="remove-player-btn" onclick="App.removePlayer(this)">✕</button>`;
    container.appendChild(div);
    updateRemoveButtons(container);
  }

  function removePlayer(btn) {
    const container = btn.closest('#menu-local-players') || btn.closest('#player-inputs') || btn.closest('.setup-container');
    const rows = container ? container.querySelectorAll('.player-input-row') : document.querySelectorAll('.player-input-row');
    if (rows.length <= 2) return;
    btn.closest('.player-input-row').remove();
    const remaining = container ? container.querySelectorAll('.player-input-row') : document.querySelectorAll('.player-input-row');
    remaining.forEach((row, i) => {
      row.querySelector('.player-num').textContent = i + 1;
      row.querySelector('input').placeholder = `Jugador ${i + 1}`;
    });
    updateRemoveButtons(container);
  }

  function updateRemoveButtons(container) {
    const rows = container ? container.querySelectorAll('.player-input-row') : document.querySelectorAll('.player-input-row');
    rows.forEach(row => {
      const btn = row.querySelector('.remove-player-btn');
      if (btn) btn.style.visibility = rows.length > 2 ? 'visible' : 'hidden';
    });
  }

  function getPlayerNames() {
    return [...document.querySelectorAll('.player-name-input')]
      .map(i => i.value.trim())
      .filter(n => n.length > 0);
  }

  /* ── Iniciar partida ── */
  async function startGame() {
    if (selectedType === 'online') {
      const hostName = document.getElementById('online-host-name')?.value.trim();
      if (!hostName) { showToast('Escribe tu nombre para crear la sala', 'error'); return; }

      try {
        await CadenaData.init();
      } catch (err) {
        showToast('Error al cargar datos: ' + err.message, 'error');
        return;
      }

      if (!window._FB?.configured) {
        showToast('Firebase no configurado para modo online', 'error');
        return;
      }
      await startOnlineAsHost([hostName], selectedLives, selectedTime);
      return;
    }

    // Modo local
    const names = getPlayerNames();
    if (names.length < 2) { showToast('Necesitas al menos 2 jugadores', 'error'); return; }

    try {
      await CadenaData.init();
    } catch (err) {
      showToast('Error al cargar datos: ' + err.message, 'error');
      console.error('CadenaData.init error:', err);
      return;
    }

    startLocalGame(names, selectedLives, selectedTime);
  }

  function startLocalGame(names, lives, turnSecs) {
    _startGameUI(names, lives, 'local', null, null, turnSecs || 15);
  }

  /* Muestra el countdown+precarga y llama onDone cuando todo listo */
  function _runCountdownThenStart(onDone) {
    const overlay = document.getElementById('countdown-overlay');
    const numEl   = document.getElementById('countdown-number');
    if (!overlay || !numEl) { onDone(); return; }
    const SECS = 10;
    let remaining = SECS, countdownDone = false, dataReady = false;
    numEl.textContent = remaining;
    overlay.classList.remove('hidden');
    // Reintentar precarga hasta que todos los chunks estén en memoria
    async function ensureAllLoaded() {
      await CadenaData.init().catch(() => {});
      let attempts = 0;
      while (attempts < 5) {
        await CadenaData.preloadAllChunks().catch(() => {});
        if (CadenaData.chunksLoaded()) break;
        attempts++;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    ensureAllLoaded().then(() => {
      dataReady = true;
      if (countdownDone) { overlay.classList.add('hidden'); onDone(); }
    });
    const iv = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(iv);
        countdownDone = true;
        if (dataReady) { overlay.classList.add('hidden'); onDone(); }
        else numEl.textContent = '⏳';
      } else {
        numEl.textContent = remaining;
      }
    }, 1000);
  }

  function _startGameUI(names, lives, mode, roomCode, myId, turnSecs) {
    // Guardar sesión completa como fallback para playAgain
    if (myId !== null && names[myId]) window._myLobbyName = names[myId];
    window._lastGameMode = mode;
    if (mode === 'online') {
      window._lastOnlineSession = {
        roomCode: roomCode,
        myId:     myId,
        myName:   myId !== null ? names[myId] : '',
        lives:    lives
      };
    }
    const state = {
      players: names.map((name, i) => ({ id: i, name, lives, eliminated: false })),
      currentIndex: 0,
      chain: [],
      chainLength: 0,
      lives,
      turnSecs: turnSecs || 15,
      mode,
      roomCode,
      isHost: myId === 0,
      myPlayerId: myId,
      phase: 'playing',
      _lastAppliedTurn: -1,  // -1 para que turnIndex 0 siempre se aplique
      _graceGiven: true   // countdown ya hace de gracia, no repetir en beginTurn
    };

    _injectState(state);
    document.getElementById('chain-entries').innerHTML = '';
    showScreen('screen-game');

    _runCountdownThenStart(() => {
      if (mode === 'online') {
        CadenaGame.FBSync.cleanup();
        CadenaGame.FBSync.listenRoom(roomCode, remote => {
          CadenaGame.applyRemoteState(remote);
        });
        if (myId === 0) {
          // Host: marcar 'playing' en Firebase y arrancar turno
          const FB = window._FB;
          if (FB?.configured && roomCode) {
            const { db, ref, update, serverTimestamp } = FB;
            update(ref(db, 'rooms/' + roomCode), {
              status: 'playing',
              turnIndex: 0,
              turnStartTime: serverTimestamp()
            });
          }
          CadenaGame.beginTurn();
        }
        // Joiners: esperan a que applyRemoteState reciba turnIndex y llame beginTurn
      } else {
        CadenaGame.beginTurn();
      }
    });
  }

  /* Inyectar estado al módulo cerrado mediante eval temporal */
  function _injectState(newState) {
    // Re-exponer beginTurn con el estado correcto usando closure trick:
    // En lugar de closure privado, exponemos el estado mediante una función de reset
    CadenaGame._resetState(newState);
  }

  /* ── Online: host crea sala ── */
  async function startOnlineAsHost(names, lives, turnSecs, avatars) {
    showToast('Creando sala…');
    try {
      const code = await CadenaGame.FBSync.createRoom(names, lives, avatars);
      if (!code) return;
      _enterLobby(code, 0, names[0], lives, names.map((name, i) => ({ id: i, name, avatar: (avatars && avatars[i]) || null, lives, eliminated: false })));
    } catch (err) {
      showToast('Error al crear sala: ' + err.message, 'error');
    }
  }

  function startOnlineGame() {
    const btn = document.getElementById('btn-start-online');
    if (btn && btn.disabled) { showToast('Necesitas al menos 2 jugadores para empezar', 'error'); return; }
    // Escribir 'countdown' para que todos arranquen la precarga a la vez
    const FB = window._FB;
    const { db, ref, update } = FB;
    update(ref(db, 'rooms/' + window._pendingRoomCode), { status: 'countdown' });
  }

  /* ── Online: unirse ── */
  async function joinRoom() {
    const codeEl = document.getElementById('join-code-inline') || document.getElementById('join-code');
    const name = _accName('join-name-inline') || _accName('join-name');
    const code = codeEl?.value.trim().toUpperCase();
    if (!name) { showToast('Escribe tu nombre', 'error'); return; }
    if (!code || code.length !== 6) { showToast('El código debe tener 6 caracteres', 'error'); return; }

    showToast('Conectando…');
    try {
      const { roomData, myId } = await CadenaGame.FBSync.joinRoom(code, name, _accAvatar());
      _enterLobby(code, myId, name, roomData.lives, roomData.players);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderLobbyPlayers(players, myId) {
    const normalized = toPlayersArray(players)
      .map(p => typeof p === 'string' ? { id: null, name: p } : p);
    const list = document.getElementById('lobby-players-list');
    list.innerHTML = normalized.map((p, i) => {
      const pid = p.id !== null ? p.id : i;
      return `<div class="lobby-player-row">
        <div class="lobby-player-avatar">${_avatarInner(p)}</div>
        <span class="lobby-player-name">${escapeHtml(p.name)}</span>
        ${pid === 0 ? '<span class="lobby-player-host">ANFITRIÓN</span>' : ''}
        ${pid === myId ? '<span class="lobby-player-you">← TÚ</span>' : ''}
      </div>`;
    }).join('');

    /* El contador de jugadores lo tenian ya las otras cinco salas; aqui no
       estaba y era la unica pantalla donde no se sabia cuantos habia sin
       contarlos a ojo. */
    const kicker = document.getElementById('lobby-count-kicker');
    if (kicker) kicker.textContent = `Jugadores (${normalized.length})`;

    const btnStart = document.getElementById('btn-start-online');
    const hintEl   = document.getElementById('lobby-hint-players');
    if (btnStart) {
      const isHost = myId === 0;
      btnStart.style.display = isHost ? 'block' : 'none';
      if (isHost) {
        const enough = normalized.length >= 2;
        btnStart.disabled = !enough;
        btnStart.style.opacity = enough ? '1' : '0.45';
        if (hintEl) hintEl.textContent = enough
          ? `${normalized.length} jugadores listos — ¡puedes empezar!`
          : `Esperando jugadores… (${normalized.length}/2 mínimo para empezar)`;
      }
    }
  }

  /* ── Sala: copiar enlace completo ── */
  function copyRoomCode() {
    const code = document.getElementById('room-code-display').textContent;
    const url  = window.location.origin + window.location.pathname + '?sala=' + code;
    navigator.clipboard.writeText(url).then(() => showToast('¡Enlace copiado!', 'success'));
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
  async function playAgain() {
    clearInterval(window._timerInterval);

    // Leer sesión online guardada al arrancar la partida (nunca se borra)
    const session = window._lastOnlineSession;

    CadenaGame.FBSync.cleanup();
    CadenaGame._resetState(null);
    document.getElementById('chain-entries').innerHTML = '';
    document.getElementById('players-lives').innerHTML = '';

    if (session?.roomCode) {
      await _rejoinLobby(session.roomCode, session.myName, session.myId, session.lives);
    } else {
      showMenu();
      menuSetMode('local');
    }
  }

  /* Vuelve al lobby con el mismo codigo.
     El host original (myPlayerId===0) resetea la sala y escribe su slot.
     El resto espera a que exista status:lobby y escribe su slot propio. */
  async function _rejoinLobby(roomCode, myName, myOriginalId, lives) {
    const FB = window._FB;
    if (!FB?.configured) { showMenu(); return; }
    try {
      const { db, ref, get, update, set } = FB;
      const roomRef = ref(db, 'rooms/' + roomCode);
      const snap = await get(roomRef);
      if (!snap.exists()) { showToast('La sala ya no existe', 'error'); showMenu(); return; }
      const room = snap.val();
      const roomLives = room.lives || lives;

      const myEntry = { id: myOriginalId, name: myName, lives: roomLives, eliminated: false };

      if (myOriginalId == 0) {
        // Host: resetear sala y escribir slot 0
        await update(roomRef, {
          status: 'lobby', chain: null, chainLength: 0, turnIndex: 0, players: null
        });
        await set(ref(db, 'rooms/' + roomCode + '/players/0'), myEntry);
      } else {
        // Joiner: ir al lobby YA con solo mi nombre, y en background esperar al host y escribir mi slot
        _enterLobby(roomCode, myOriginalId, myName, roomLives, [myEntry]);
        // Esperar en background a que el host resetee y luego escribir mi slot
        (async () => {
          let retries = 0;
          while (retries < 20) {
            const s2 = await get(roomRef);
            if (s2.val()?.status === 'lobby') break;
            await new Promise(r => setTimeout(r, 500));
            retries++;
          }
          await set(ref(db, 'rooms/' + roomCode + '/players/' + myOriginalId), myEntry);
        })();
        return; // ya llamamos _enterLobby arriba
      }

      const snapFinal = await get(roomRef);
      const finalPlayers = toPlayersArray(snapFinal.val()?.players);
      _enterLobby(roomCode, myOriginalId, myName, roomLives,
        finalPlayers.length ? finalPlayers : [myEntry]);
    } catch(e) {
      showToast('Error al volver al lobby: ' + e.message, 'error');
      showMenu();
    }
  }

  /* Volver al lobby DESPUÉS de recargar la página.
     Ojo, no vale _rejoinLobby(): esa es la de "jugar otra vez" y el anfitrión
     RESETEA la sala (players: null), que aquí borraría a todos los que están
     esperando. Y tampoco vale joinRoom(), que AÑADE un jugador al final: como
     La Cadena no borra a nadie al desconectarse, tu registro anterior sigue
     ahí y acabarías duplicado junto a tu propio fantasma (probado: salían dos
     "Vicente", uno de ellos con el ANFITRIÓN).
     Lo que toca es reocupar TU asiento, que es justo el que sigue libre. */
  async function _volverALaSala(roomCode, myName, myId) {
    const FB = window._FB;
    if (!FB?.configured || typeof myId !== 'number') return false;
    try {
      const { db, ref, get } = FB;
      const snap = await get(ref(db, 'rooms/' + roomCode));
      if (!snap.exists()) { showToast('Esa sala ya no existe', 'error'); return false; }
      const room = snap.val();
      if (room.status !== 'lobby') { showToast('La partida empezó sin ti', 'error'); return false; }
      const players = toPlayersArray(room.players);
      const mio = players.find(p => p && p.id === myId && p.name === myName);
      if (!mio) return false;              // tu sitio ya no está: que se una como uno nuevo
      _enterLobby(roomCode, myId, myName, room.lives, players);
      return true;
    } catch (e) { return false; }
  }

  /* Muestra la pantalla de lobby y registra el listener
     myName: nombre propio (pasado directamente, no derivado del array) */
  function _enterLobby(roomCode, myId, myName, lives, currentPlayers) {
    // Actualizar URL con el código de sala
    const _shareUrl = window.location.origin + window.location.pathname + '?sala=' + roomCode;
    history.pushState(null, '', window.location.pathname + '?sala=' + roomCode);
    /* La URL ya decía en qué sala estabas, pero no con qué nombre: al recargar
       tocaba escribirlo otra vez y pulsar UNIRSE. Apuntándolo aquí, la vuelta
       es sola. En localStorage y no en la URL: en la URL sería un dato personal
       a la vista y compartible sin querer. */
    if (window.FHRuta) FHRuta.recordarSala('en-la-cadena', roomCode, myName, { id: myId, lives });
    showScreen('screen-lobby');
    // Mostrar enlace compartible en el lobby
    const _shareEl = document.getElementById('lobby-share-url');
    if (_shareEl) _shareEl.textContent = _shareUrl;
    document.getElementById('room-code-display').textContent = roomCode;
    document.getElementById('lobby-mode-display').textContent =
      lives === 1 ? '💀 Supervivencia' : lives === 2 ? '⚽ Normal' : '🏆 Largo';
    window._pendingRoomCode = roomCode;
    window._pendingLives    = lives;
    window._myLobbyId       = myId;
    window._myLobbyName     = myName;

    renderLobbyPlayers(currentPlayers, myId);

    const FB = window._FB;
    const { db, ref, onValue } = FB;
    const rRef = ref(db, 'rooms/' + roomCode);
    const unsub = onValue(rRef, snap => {
      if (!snap.exists()) return;
      const remote = snap.val();
      let freshPlayers = toPlayersArray(remote.players);
      // Si la lista está vacía (reset en curso) asegurarnos de que al menos yo aparezco
      if (!freshPlayers.find(p => p.name === myName)) {
        freshPlayers = [...freshPlayers.filter(p => p.name !== myName),
          { id: myId, name: myName, lives, eliminated: false }];
        freshPlayers.sort((a, b) => a.id - b.id);
      }
      const me = freshPlayers.find(p => p.name === myName);
      const freshMyId = me ? me.id : myId;
      renderLobbyPlayers(freshPlayers, freshMyId);
      if (remote.status === 'countdown' || remote.status === 'playing') {
        unsub();
        _startGameUI(freshPlayers.map(p => p.name), remote.lives || lives, 'online', roomCode, freshMyId, 15);
      }
    });
    window._lobbyUnsub = unsub;
  }

  /* ── Salir del lobby ── */
  function leaveLobby() {
    if (window._lobbyUnsub) { window._lobbyUnsub(); window._lobbyUnsub = null; }
    // Eliminar al jugador de la sala si está en el lobby
    const FB = window._FB;
    const code = window._pendingRoomCode;
    const myId = window._myLobbyId;
    if (FB?.configured && code && typeof myId === 'number') {
      const { db, ref, get, update } = FB;
      get(ref(db, 'rooms/' + code)).then(snap => {
        if (!snap.exists()) return;
        const room = snap.val();
        if (room.status !== 'lobby') return;
        // Eliminar jugador y reasignar ids
        const remaining = (room.players || [])
          .filter(p => p.id !== myId)
          .map((p, i) => ({ ...p, id: i }));
        // Si queda alguien, actualizar; si no, dejar sala vacía
        update(ref(db, 'rooms/' + code), { players: remaining });
      }).catch(() => {});
    }
    showMenu();
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

  /* ── Menú principal nuevo ── */
  let _menuLives = 1;
  let _menuLivesLocal = 1;
  let _menuMode = 'online';

  function menuSetMode(mode) {
    _menuMode = mode;
    document.getElementById('menu-tab-online').classList.toggle('active', mode === 'online');
    document.getElementById('menu-tab-local').classList.toggle('active', mode === 'local');
    document.getElementById('menu-panel-online').classList.toggle('hidden', mode !== 'online');
    document.getElementById('menu-panel-local').classList.toggle('hidden', mode !== 'local');
  }

  function menuSelectLives(btn) {
    btn.closest('.menu-lives-row').querySelectorAll('.lives-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _menuLives = parseInt(btn.dataset.lives);
  }

  function menuSelectLivesLocal(btn) {
    btn.closest('.menu-lives-row').querySelectorAll('.lives-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _menuLivesLocal = parseInt(btn.dataset.lives);
  }

  async function menuCreateRoom() {
    const name = _accName('menu-host-name') || _accName('menu-player-name');
    if (!name) { _menuError('Escribe tu nombre en «Nueva sala»'); return; }
    if (!window._FB?.configured) { _menuError('Firebase no disponible'); return; }
    selectedLives = _menuLives;
    selectedType  = 'online';
    try {
      await CadenaData.init();
    } catch(e) { _menuError('Error al cargar datos'); return; }
    await startOnlineAsHost([name], _menuLives, 15, [_accAvatar()]);
  }

  async function menuJoinRoom() {
    const name = _accName('menu-player-name');
    const code = document.getElementById('menu-join-code')?.value.trim().toUpperCase();
    if (!name) { _menuError('Escribe tu nombre primero'); return; }
    if (!code || code.length !== 6) { _menuError('El código debe tener 6 caracteres'); return; }
    showToast('Conectando…');
    try {
      const { roomData, myId } = await CadenaGame.FBSync.joinRoom(code, name, _accAvatar());
      _enterLobby(code, myId, name, roomData.lives, roomData.players);
    } catch(err) {
      _menuError(err.message);
    }
  }

  async function menuStartLocal() {
    const rows  = document.querySelectorAll('#menu-local-players .player-name-input');
    const names = [...rows].map(i => i.value.trim()).filter(n => n.length > 0);
    if (names.length < 2) { showToast('Necesitas al menos 2 jugadores', 'error'); return; }
    try { await CadenaData.init(); } catch(e) { showToast('Error cargando datos', 'error'); return; }
    startLocalGame(names, _menuLivesLocal, 15);
  }

  function _menuError(msg) {
    const el = document.getElementById('menu-error');
    if (!el) { showToast(msg, 'error'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3500);
  }

  /* ── Firebase status ── */
  function updateFBStatus() {
    // No mostrar nada si Firebase funciona — el indicador ya no está en el nuevo menú
  }

  /* ── Init ── */
  function init() {
    updateFBStatus();
    _setupAccountName();
    // Leer ?sala= de la URL para unirse automáticamente
    const params   = new URLSearchParams(window.location.search);
    const salaCode = params.get('sala');
    if (salaCode && salaCode.length === 6) {
      // Pre-rellenar el código y poner el foco en el nombre
      const codeInput = document.getElementById('menu-join-code');
      if (codeInput) codeInput.value = salaCode.toUpperCase();

      /* Dos casos distintos:
           · Venías de esta misma sala (recargaste, volviste a la pestaña): se
             sabe con qué nombre entraste, así que se vuelve solo.
           · Te acaban de pasar el enlace: se pide el nombre, como siempre.
         Si la sala ya no existe o arrancó sin ti, menuJoinRoom lo dice con su
         propio mensaje en vez de dejarte en el menú sin explicación. */
      const rec = window.FHRuta && FHRuta.salaRecordada('en-la-cadena', salaCode);
      const nameInput = document.getElementById('menu-player-name');
      if (rec && nameInput) {
        nameInput.value = rec.nombre;
        const id = rec.datos && rec.datos.id;
        /* Primero se intenta recuperar el asiento de antes; solo si ya no está
           se entra como jugador nuevo. */
        _volverALaSala(salaCode.toUpperCase(), rec.nombre, id)
          .then(ok => { if (!ok) menuJoinRoom(); });
      } else {
        showToast(`Código ${salaCode} detectado — escribe tu nombre y pulsa UNIRSE`, 'success');
      }
    }
  }

  return {
    showMenu, showCreateGame, showJoinGame,
    selectMode, selectTime, setType, addPlayer, removePlayer,
    startGame, startOnlineGame, joinRoom, leaveLobby,
    copyRoomCode, continueAfterElim, playAgain,
    showToast, init, _startGameUI,
    menuSetMode, menuSelectLives, menuSelectLivesLocal,
    menuCreateRoom, menuJoinRoom, menuStartLocal
  };

})();

/* ══════════════════════════════════════════════
   CADENAGAME — LÓGICA DE JUEGO
   Implementación real de turnos, vidas, cadena y sync remoto. Se añade
   aquí (en vez de dentro del IIFE de CadenaGame) porque necesita que el
   estado de la partida (CadenaGame._state) se pueda re-crear por completo
   en cada partida nueva vía App._startGameUI → CadenaGame._resetState().
   ══════════════════════════════════════════════ */
;(function () {
  let _state = null;

  CadenaGame._resetState = function(newState) {
    _state = newState;
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
    // Promover nat y b al nivel raíz para que Firebase los serialice y _renderEntry los lea
    if (entry.type === 'player' && entry.data) {
      if (!entry.nat) entry.nat = entry.data.nat || null;
      if (!entry.b)   entry.b   = entry.data.b   || null;
    }
    s.chain.push(entry);
    s.chainLength++;

    _renderEntry(entry);

    if (s.mode === 'online') {
      const nextActive = s.players.filter(p => !p.eliminated);
      const nextIndex = (s.currentIndex + 1) % nextActive.length;
      s.currentIndex = nextIndex;
      const chainSerial = s.chain.map(e => ({
        type: e.type, name: e.name || null, value: e.value || null,
        id: e.id || null, isOneClubMan: e.isOneClubMan || false, submittedBy: e.submittedBy || '',
        nat: e.nat || e.data?.nat || null,
        b:   e.b   || e.data?.b   || null
      }));
      const FB = window._FB;
      if (FB?.configured && s.roomCode) {
        const { db, ref, update, serverTimestamp } = FB;
        update(ref(db, 'rooms/' + s.roomCode), {
          chain: chainSerial, chainLength: chainSerial.length,
          turnIndex: nextIndex,
          players: s.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, eliminated: p.eliminated })),
          turnStartTime: serverTimestamp(), status: 'playing'
        });
      }
    } else {
      _nextTurn();
    }
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
      if (s.mode === 'online') _pushPenaltyToFirebase(s);
      _showEliminated(cp, '"' + value + '" no es válido', validOptions);
    } else {
      s.chain = []; s.chainLength = 0;
      document.getElementById('chain-entries').innerHTML = '';
      _showValidOptionsPanel(validOptions);
      App.showToast('❤️ Le quedan ' + cp.lives + ' vida' + (cp.lives !== 1 ? 's' : ''), 'error');
      if (s.mode === 'online') _pushPenaltyToFirebase(s);
      else _nextTurn();
    }
  };

  function _pushPenaltyToFirebase(s) {
    const active = s.players.filter(p => !p.eliminated);
    const FB = window._FB;
    if (!FB?.configured || !s.roomCode) return;
    const { db, ref, update, serverTimestamp } = FB;
    if (active.length <= 1) {
      update(ref(db, 'rooms/' + s.roomCode), {
        players: s.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, eliminated: p.eliminated })),
        chain: [], chainLength: 0, status: 'finished'
      });
      return;
    }
    const nextIndex = (s.currentIndex + 1) % active.length;
    s.currentIndex = nextIndex;
    update(ref(db, 'rooms/' + s.roomCode), {
      players: s.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, eliminated: p.eliminated })),
      chain: [], chainLength: 0, turnIndex: nextIndex,
      turnStartTime: serverTimestamp(), status: 'playing'
    });
  }

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

    // Período de gracia al inicio de la partida (cadena vacía, solo una vez)
    const isFirstTurn = s.chain.length === 0 && !s._graceGiven;
    if (isFirstTurn) s._graceGiven = true;
    const graceMs = isFirstTurn ? 10000 : 0;

    if (isMyTurn) {
      answerZone.classList.remove('hidden');
      waitingMsg.classList.add('hidden');
      input.disabled = false;
      input.value = '';
      // Re-habilitar el botón de enviar: submitAnswer lo deshabilita al enviar
      // y en el camino de éxito nadie lo re-habilitaba (solo el input), por lo
      // que tras el primer acierto el botón quedaba muerto el resto de partida.
      const submitBtn = document.querySelector('.submit-btn');
      if (submitBtn) submitBtn.disabled = false;
      CadenaData.closeSuggestions();
      if (graceMs > 0) {
        _showCountdownOverlay(graceMs, () => { _startTimer(); setTimeout(() => input.focus(), 50); });
      } else {
        _startTimer();
        setTimeout(() => input.focus(), 100);
      }
    } else {
      answerZone.classList.add('hidden');
      waitingMsg.classList.remove('hidden');
      document.getElementById('waiting-name').textContent = cp.name;
      if (graceMs > 0) {
        _showCountdownOverlay(graceMs, () => _startTimer());
      } else {
        _startTimer();
      }
    }
  };

  CadenaGame.applyRemoteState = function(remote) {
    const s = CadenaGame._state;
    if (!s) return;

    let needsBeginTurn = false;

    if (remote.players) s.players = toPlayersArray(remote.players);

    // Solo reaccionar a cambio de turno si el índice cambió Y no soy yo quien acaba de actuar
    if (typeof remote.turnIndex === 'number' && remote.turnIndex !== s._lastAppliedTurn) {
      s._lastAppliedTurn = remote.turnIndex;
      s.currentIndex = remote.turnIndex;
      needsBeginTurn = true;
    }

    // Actualizar cadena si cambió. OJO: Firebase RTDB no guarda arrays vacíos
    // ([] se lee como undefined), así que un reset a cadena vacía llega aquí
    // como remote.chain === undefined — NO se puede usar la verdad de
    // remote.chain como guarda, o el reset nunca se aplicaría en los clientes
    // que no fueron quien falló/expiró (listenRoom siempre entrega la sala
    // COMPLETA, así que "ausente" aquí sí significa "vacía", no "sin cambios").
    {
      const remoteLen = Array.isArray(remote.chain) ? remote.chain.length : 0;
      if (remoteLen !== s.chain.length) {
        s.chain = Array.isArray(remote.chain) ? remote.chain : [];
        s.chainLength = remote.chainLength || s.chain.length;
        const c = document.getElementById('chain-entries');
        c.innerHTML = '';
        s.chain.forEach(e => _renderEntry(e));
      }
    }

    if (remote.status === 'finished') {
      const active = s.players.filter(p => !p.eliminated);
      _endGame(active[0]);
      return;
    }

    // Ignorar snapshots de countdown: cada cliente arranca por su cuenta
    if (remote.status === 'countdown') return;

    if (needsBeginTurn && remote.status === 'playing') {
      setTimeout(() => CadenaGame.beginTurn(), 100);
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
        const active2 = s.players.filter(p => !p.eliminated);
        const cp2 = active2[s.currentIndex % active2.length];
        const isMyTurn = s.mode === 'local' || (s.myPlayerId !== null && cp2?.id === s.myPlayerId);
        if (isMyTurn) {
          App.showToast('⏰ ¡Tiempo! ' + (cp2?.name || '') + ' pierde una vida', 'error');
          if (cp2) {
            cp2.lives--;
            if (cp2.lives <= 0) {
              cp2.eliminated = true;
              if (s.mode === 'online') _pushPenaltyToFirebase(s);
              _showEliminated(cp2, 'Se quedó sin tiempo', null);
            } else {
              s.chain = []; s.chainLength = 0;
              document.getElementById('chain-entries').innerHTML = '';
              App.showToast('❤️ Le quedan ' + cp2.lives + ' vida' + (cp2.lives !== 1 ? 's' : ''), 'error');
              if (s.mode === 'online') _pushPenaltyToFirebase(s);
              else _nextTurn();
            }
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
          `<span class="valid-option-tag">${escapeHtml(o)}</span>`
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
        `<span class="valid-option-tag">${escapeHtml(o)}</span>`
      ).join('');
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  function _showCountdownOverlay(totalMs, onDone) {
    const SECS = Math.round(totalMs / 1000);
    const overlay = document.getElementById('countdown-overlay');
    const numEl   = document.getElementById('countdown-number');
    if (!overlay || !numEl) { onDone(); return; }

    let remaining = SECS;
    let countdownDone = false;
    let dataReady = false;

    numEl.textContent = remaining;
    overlay.classList.remove('hidden');

    // Lanzar carga de índices Y todos los chunks en paralelo con la cuenta atrás
    Promise.all([
      CadenaData.init().catch(() => {}),
      CadenaData.preloadAllChunks().catch(() => {})
    ]).then(() => {
      dataReady = true;
      if (countdownDone) {
        overlay.classList.add('hidden');
        onDone();
      }
    });

    const iv = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(iv);
        countdownDone = true;
        if (dataReady) {
          overlay.classList.add('hidden');
          onDone();
        } else {
          numEl.textContent = '⏳';
        }
      } else {
        numEl.textContent = remaining;
      }
    }, 1000);
  }

  function _endGame(winner) {
    clearInterval(window._timerInterval);
    const s = CadenaGame._state;
    if (s) s.phase = 'finished';
    setTimeout(() => {
      document.querySelectorAll('.screen').forEach(sc => sc.classList.remove('active'));
      document.getElementById('screen-result').classList.add('active');

      const btns = document.getElementById('result-buttons');
      const exitLabel = s?.mode === 'online' ? '🏠 Salir de sala' : '🏠 Menú';
      btns.innerHTML = '<button class="btn-primary" onclick="App.playAgain()">🔄 Jugar de nuevo</button>' +
                       '<button class="btn-secondary" onclick="App.showMenu()">' + exitLabel + '</button>';

      document.getElementById('winner-name').textContent = winner ? winner.name : '— Empate —';
      document.getElementById('chain-stats').innerHTML =
        `Cadena de <strong>${s?.chainLength || 0}</strong> eslabones<br>` +
        (s?.players || []).map(p => `${p.eliminated ? '💀' : '✅'} ${escapeHtml(p.name)}`).join('<br>');
    }, 400);
  }

  function _renderEntry(entry) {
    const container = document.getElementById('chain-entries');
    const div = document.createElement('div');
    const val = entry.name || entry.value || '?';
    div.className = `chain-entry type-${entry.type}`;

    let meta = '';
    if (entry.type === 'team') {
      meta = entry.isOneClubMan ? '★ One-club man' : '';
    } else {
      // nat y b vienen directamente en el entry (guardados al añadir y al serializar a Firebase)
      const nat = entry.nat || entry.data?.nat || '';
      const b   = entry.b   || entry.data?.b   || '';
      meta = nat + (b ? ' · ' + b : '');
    }

    div.innerHTML = `
      <span class="ce-icon">${entry.type === 'player' ? '⚽' : '🏟️'}</span>
      <div class="ce-content">
        <div class="ce-value">${escapeHtml(val)}</div>
        ${meta ? `<div class="ce-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
      <span class="ce-player">${escapeHtml(entry.submittedBy || '')}</span>`;
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
        <span class="plc-name">${escapeHtml(p.name)}</span>
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
/* OJO con el DOMContentLoaded: este archivo NO va en un <script src> del HTML,
   lo inyecta el index dentro del onload de cadena-data.js. Para cuando llega,
   el DOMContentLoaded ya ha saltado hace rato y el listener no se ejecutaba
   NUNCA — o sea que App.init() no corría, y con él se quedaban sin hacer el
   deep link de ?sala= (el código no se rellenaba) y el _setupAccountName().
   No daba error por ningún lado: el juego arranca igual porque todo lo demás
   cuelga de los onclick del HTML. */
function _arrancar() {
  App.init();
  // Precargar índices y todos los chunks en background nada más cargar la página
  CadenaData.init().catch(() => {});
  CadenaData.preloadAllChunks().catch(() => {});
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _arrancar);
else _arrancar();
