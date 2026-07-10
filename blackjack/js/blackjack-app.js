/* =============================================
   BLACKJACK-APP.JS
   Coordinador principal — Blackjack de Fútbol
   QUIÉN COÑO FALTA
   ============================================= */

const App = (() => {

  /* ── Escapa texto para insertar de forma segura en HTML (texto o atributo) ── */
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ─── Estado de la app ─── */
  let _mode      = 'mv';
  let _tab       = 'private';
  let _roomCode  = null;
  let _playerId  = null;
  let _isHost    = false;
  let _unsubRoom = null;
  let _localScores = {};
  let _lastRoomPlayers = {};
  let _lastRoomData    = null;  // snapshot completo para roomMeta en play-again

  /* ─── Modo local (sin Firebase) ─── */
  let _isLocal        = false;
  let _localPlayerName = '';
  let _localRound     = 0;

  /* ─── Play-again countdown ─── */
  let _playAgainCountdownActive   = false;
  let _playAgainCountdownInterval = null;
  let _startCooldownInterval      = null;  // cooldown en el botón de empezar del lobby

  /* ─── Timer sala pública (3 min sin empezar → expulsión) ─── */
  let _publicLobbyTimer       = null;
  let _publicLobbyWarnTimer   = null;
  const PUBLIC_LOBBY_TIMEOUT  = 3 * 60 * 1000;  // 3 minutos
  const PUBLIC_LOBBY_WARN     = 30 * 1000;       // aviso a 30s del límite

  /* ─── Espera sala pública ─── */
  let _waitingForPublic    = false;
  let _waitPublicUnsubscribe = null;

  /* ─── Promesa de carga de logos y banderas ─── */
  let _assetsPromise = null;

  /* ─── Tracking de resetAt para detectar nueva partida en clientes no-host ─── */
  let _lastResetAt = 0;

  /* ─── Mapa de textos de modo ─── */
  const MODE_LABELS = {
    mv:       '💰 Valor de mercado',
    national: '🌍 Internacionales',
    age:      '🎂 Edad actual',
  };

  /* ══════════════════════════════════════════
     INIT
     ══════════════════════════════════════════ */
  function init() {
    _showScreen('screen-menu');
    loadStats?.();
    loadSettings?.();

    // Cargar escudos y banderas — guardar promesa para poder esperarla antes de jugar
    _assetsPromise = Promise.all([
      fetch('../data/teams/team-logos.json').then(r => r.json()).catch(() => ({})),
      fetch('../data/teams/country-flags.json').then(r => r.json()).catch(() => ({})),
    ]).then(([logos, flags]) => {
      window._TEAM_LOGOS    = logos;
      window._COUNTRY_FLAGS = flags;
    });

    // Auto-rellenar código si la URL trae ?sala=XXXXXX
    const urlParams = new URLSearchParams(window.location.search);
    const salaCode  = urlParams.get('sala');
    if (salaCode) {
      const input = document.getElementById('input-join-code');
      if (input) input.value = salaCode.toUpperCase();
      setTab('private');
    }

    console.log('✅ Blackjack App iniciado');
  }

  /* ══════════════════════════════════════════
     MENÚ — SELECCIÓN DE MODO Y TAB
     ══════════════════════════════════════════ */
  function selectMode(btn) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _mode = btn.dataset.mode;
  }

  function setTab(tab) {
    _tab = tab;
    document.querySelectorAll('.menu-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.querySelectorAll('.menu-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${tab}`)?.classList.add('active');
  }

  /* ══════════════════════════════════════════
     MODO LOCAL — juego sin Firebase
     ══════════════════════════════════════════ */
  async function startLocalGame() {
    const name = document.getElementById('input-local-name')?.value.trim();
    if (!name) { _showError('error-local', 'Escribe tu nombre'); return; }

    _clearError('error-local');

    const btn = document.querySelector('#panel-local .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'CARGANDO…'; }

    try {
      _isLocal         = true;
      _isHost          = true;
      _localPlayerName = name;
      _playerId        = 'local-p1';
      _roomCode        = null;
      _localRound      = 0;

      BlackjackGame.resetScores?.();
      _localScores = {};

      await Promise.all([_loadPool(), _assetsPromise]);  // esperar pool Y logos/banderas
      await _startNextLocalRound();
    } catch (e) {
      console.error('[App] startLocalGame error:', e);
      _showError('error-local', e.message || 'Error al generar partida');
      showToast(e.message || 'Error al generar partida', 'error');
      _isLocal  = false;
      _isHost   = false;
      _playerId = null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'JUGAR SOLO ▶'; }
    }
  }

  async function _startNextLocalRound() {
    _localRound++;

    // Generar set (mismo camino que el juego online)
    const roundData = await _generateRoundSet(_localRound);

    // Enriquecer con _value real desde el pool (igual que _startRoundNow online)
    const enriched = await _enrichSetValues(roundData.players, _mode);

    const myScore = _localScores[_playerId] || 0;

    BlackjackGame.startRound({
      round:      _localRound,
      objective:  roundData.objective,
      setPlayers: enriched,
      setSeed:    roundData.setSeed,
      players:    [{ id: _playerId, name: _localPlayerName, score: myScore }],
      mode:       _mode,
      roomCode:   null,
      isHost:     true,
      myPlayerId: _playerId,
    });

    document.getElementById('game-topbar')?.classList.remove('hidden');
  }
  /* ══════════════════════════════════════════
     CREAR SALA
     ══════════════════════════════════════════ */
  async function createRoom() {
    const name = document.getElementById('input-host-name')?.value.trim();
    if (!name) { _showError('error-private', 'Escribe tu nombre'); return; }

    try {
      _clearError('error-private');
      const { code, playerId } = await BlackjackSync.createRoom(name, _mode);
      _roomCode = code;
      _playerId = playerId;
      _isHost   = true;
      _saveSession();
      _listenRoom();
      _showLobby();
    } catch (e) {
      _showError('error-private', e.message || 'Error al crear sala');
    }
  }

  /* ══════════════════════════════════════════
     UNIRSE A SALA
     ══════════════════════════════════════════ */
  async function joinRoom() {
    const name = document.getElementById('input-join-name')?.value.trim();
    const code = document.getElementById('input-join-code')?.value.trim().toUpperCase();
    if (!name) { _showError('error-private', 'Escribe tu nombre'); return; }
    if (!code || code.length !== 6) { _showError('error-private', 'Introduce el código (6 caracteres)'); return; }

    if (_roomCode && _playerId) { _showLobby(); return; }

    const btn = document.querySelector('#panel-private .btn-secondary');
    if (btn) { btn.disabled = true; btn.textContent = 'UNIÉNDOSE…'; }

    try {
      _clearError('error-private');
      const result = await BlackjackSync.joinRoom(code, name);
      _roomCode = result.code;
      _playerId = result.playerId;
      _isHost   = false;
      _saveSession();
      _listenRoom();
      _showLobby();
    } catch (e) {
      _showError('error-private', e.message || 'Error al unirse');
      if (btn) { btn.disabled = false; btn.textContent = 'UNIRSE A SALA ▶'; }
    }
  }

  /* ══════════════════════════════════════════
     SALA PÚBLICA
     ══════════════════════════════════════════ */
  async function findPublicRoom() {
    const name = document.getElementById('input-public-name')?.value.trim();
    if (!name) { _showError('error-public', 'Escribe tu nombre'); return; }

    _cancelWaitPublicInternal();
    document.getElementById('public-options-panel')?.remove();

    if (_roomCode && _playerId) { _showLobby(); return; }

    const btn = document.querySelector('#panel-public .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'BUSCANDO…'; }

    try {
      _clearError('error-public');

      // Intentar reconectar a sesión guardada (evita duplicados)
      const session = _loadSession();
      if (session && session.mode === _mode) {
        try {
          const ok = await BlackjackSync.tryReconnect(session.code, session.playerId, name);
          if (ok) {
            _roomCode = session.code;
            _playerId = session.playerId;
            _isHost   = session.isHost;
            _listenRoom();
            _showLobby();
            if (btn) { btn.disabled = false; btn.textContent = 'BUSCAR PARTIDA ▶'; }
            return;
          }
        } catch (e) {
          console.warn('[App] Reconexión fallida:', e);
        }
      }

      // Buscar o crear sala (findOrCreatePublicRoom maneja internamente todo caso)
      await _doFindPublicRoom(name);

    } catch (e) {
      _showError('error-public', e.message || 'Error al buscar partida');
      if (btn) { btn.disabled = false; btn.textContent = 'BUSCAR PARTIDA ▶'; }
    }
  }

  /* ─── Buscar/crear sala (flujo normal tras checks) ─── */
  async function _doFindPublicRoom(name) {
    const btn = document.querySelector('#panel-public .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'BUSCANDO…'; }

    try {
      const result = await BlackjackSync.findOrCreatePublicRoom(name, _mode);
      _roomCode = result.code;
      _playerId = result.playerId;
      _isHost   = result.isHost;
      _saveSession();
      _listenRoom();
      _showLobby();
    } catch (e) {
      _showError('error-public', e.message || 'Error al buscar partida');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'BUSCAR PARTIDA ▶'; }
    }
  }

  /* ─── Mostrar opciones cuando hay partida en curso ─── */
  function _showPublicRoomOptions(playerName) {
    const panel = document.getElementById('panel-public');
    if (!panel) return;

    document.getElementById('public-options-panel')?.remove();

    // Construido vía DOM (sin interpolar el nombre en HTML/onclick) para evitar
    // cualquier problema de escapado, tanto en HTML como en atributos.
    const div = document.createElement('div');
    div.id = 'public-options-panel';
    div.style.cssText = 'background:rgba(200,168,75,0.08);border:1px solid rgba(200,168,75,0.2);border-radius:10px;padding:14px;margin-top:10px;';

    const label = document.createElement('p');
    label.style.cssText = "font-family:'Rajdhani',sans-serif;font-size:0.75rem;letter-spacing:2px;color:var(--neon-green);opacity:0.7;text-transform:uppercase;margin-bottom:10px;";
    label.textContent = 'Partida en curso';

    const btnCreate = document.createElement('button');
    btnCreate.className = 'btn-primary';
    btnCreate.style.marginBottom = '8px';
    btnCreate.textContent = '🆕 Crear nueva sala';
    btnCreate.addEventListener('click', () => doCreatePublicRoom(playerName));

    const btnWait = document.createElement('button');
    btnWait.className = 'btn-secondary';
    btnWait.textContent = '⏳ Esperar que terminen';
    btnWait.addEventListener('click', () => doWaitPublicRoom(playerName));

    div.appendChild(label);
    div.appendChild(btnCreate);
    div.appendChild(btnWait);
    panel.appendChild(div);
  }

  /* ─── Crear nueva sala pública (desde el panel de opciones) ─── */
  async function doCreatePublicRoom(name) {
    document.getElementById('public-options-panel')?.remove();
    await _doFindPublicRoom(name);
  }

  /* ─── Esperar a que termine la partida actual ─── */
  function doWaitPublicRoom(name) {
    document.getElementById('public-options-panel')?.remove();
    if (_waitingForPublic) return;
    _waitingForPublic = true;

    const panel = document.getElementById('panel-public');
    const statusDiv = document.createElement('div');
    statusDiv.id = 'public-wait-status';
    statusDiv.innerHTML = `
      <p style="font-family:'Rajdhani',sans-serif;font-size:0.85rem;color:var(--neon-green);
                opacity:0.7;text-align:center;margin-top:12px;letter-spacing:1px;">
        ⏳ Esperando que termine la partida…
      </p>
      <button onclick="App.cancelWaitPublic()"
              style="display:block;margin:8px auto 0;background:none;
                     border:1px solid rgba(200,168,75,0.3);color:rgba(255,255,255,0.5);
                     padding:4px 14px;border-radius:6px;font-family:'Rajdhani',sans-serif;
                     cursor:pointer;font-size:0.8rem;">
        Cancelar
      </button>
    `;
    panel?.appendChild(statusDiv);

    // Obtener el código de sala del nodo de matchmaking y escuchar su status
    const { onValue, ref, db, get } = window._FB;
    get(ref(db, `blackjack/matchmaking/${_mode}`)).then(snap => {
      if (!snap.exists()) {
        // No hay sala activa — crear directamente
        _cancelWaitPublicInternal();
        document.getElementById('public-wait-status')?.remove();
        _doFindPublicRoom(name);
        return;
      }

      const matchData = snap.val();
      const roomCode  = matchData.code;

      // Escuchar el status de la sala concreta
      _waitPublicUnsubscribe = onValue(ref(db, `blackjack/rooms/${roomCode}/status`), async (statusSnap) => {
        const roomStatus = statusSnap.val();
        // Disponible si status es 'waiting' o la sala ya no existe
        if (!roomStatus || roomStatus === 'waiting') {
          _cancelWaitPublicInternal();
          document.getElementById('public-wait-status')?.remove();
          showToast('¡Partida disponible!', 'success');
          setTimeout(() => _doFindPublicRoom(name), 600);
        }
      });
    }).catch(e => {
      _cancelWaitPublicInternal();
      document.getElementById('public-wait-status')?.remove();
      showToast('Error al esperar: ' + e.message, 'error');
    });
  }

  /* ─── Cancelar espera (botón) ─── */
  function cancelWaitPublic() {
    _cancelWaitPublicInternal();
    document.getElementById('public-wait-status')?.remove();
  }

  function _cancelWaitPublicInternal() {
    if (_waitPublicUnsubscribe) { _waitPublicUnsubscribe(); _waitPublicUnsubscribe = null; }
    _waitingForPublic = false;
  }

  /* ══════════════════════════════════════════
     LOBBY
     ══════════════════════════════════════════ */
  function _showLobby() {
    _showScreen('screen-lobby');
    document.getElementById('lobby-code-display').textContent = _roomCode;
    document.getElementById('lobby-mode-display').textContent = MODE_LABELS[_mode] || _mode;
    document.getElementById('game-topbar')?.classList.add('hidden');

    // Actualizar URL con el código de sala (permite compartir y evita bugs al recargar)
    if (_roomCode) {
      const newUrl = window.location.pathname + '?sala=' + _roomCode;
      history.pushState({ sala: _roomCode }, '', newUrl);
    }

    // Mostrar enlace completo a la sala
    const linkEl = document.getElementById('lobby-code-link-display');
    if (linkEl) {
      const base = window.location.origin + window.location.pathname;
      linkEl.textContent = `${base}?sala=${_roomCode}`;
    }

    _loadPool().catch(e => console.warn('[App] Precarga pool falló:', e));
  }

  function _listenRoom() {
    if (_unsubRoom) _unsubRoom();
    _unsubRoom = BlackjackSync.listenRoom(_roomCode, {
      onRoomUpdate: _onRoomUpdate,
    });
  }

  function _onRoomUpdate(room) {
    if (!room) return;

    // ── Sala expirada (timeout 3 min en sala pública) ──
    if (room.status === 'expired') {
      _handleKicked('La sala pública expiró por inactividad ⏱️');
      return;
    }

    // ── Detección de expulsión: nuestro playerId ya no está en room.players ──
    if (!_isLocal && _playerId && room.players && !room.players[_playerId]) {
      _handleKicked('Has sido expulsado por no participar en la partida 💤');
      return;
    }

    if (room.players) _lastRoomPlayers = room.players;
    _lastRoomData = room;
    _mode = room.mode || _mode;

    // ── Failover de host ──────────────────────────────────────────
    // Mantener _isHost sincronizado SIEMPRE (no solo en el lobby): permite
    // que el juego siga si el host original se cae a mitad de partida.
    if (!_isLocal && _playerId) {
      const wasHost = _isHost;
      const meP = room.players?.[_playerId];
      if (meP !== undefined) _isHost = meP.isHost === true;

      // Si el host cerró la pestaña (onDisconnect borra su nodo) o quedó
      // desconectado y NO hay ningún host conectado, el primer jugador
      // conectado (orden determinista por id) se autopromociona.
      if ((room.status === 'playing' || room.status === 'reveal' || room.status === 'countdown')) {
        const connectedP = Object.entries(room.players || {}).filter(([, p]) => p.connected !== false);
        const hasHost = connectedP.some(([, p]) => p.isHost === true);
        if (!hasHost && connectedP.length > 0) {
          const candidate = connectedP.map(([pid]) => pid).sort()[0];
          if (candidate === _playerId && !_isHost) {
            _isHost = true;
            try {
              const { db, ref, update } = window._FB;
              update(ref(db, `blackjack/rooms/${_roomCode}/players/${_playerId}`), { isHost: true }).catch(() => {});
            } catch (e) {}
          }
        }
      }

      // Nos acaban de promover: actualizar el estado del juego para que el
      // botón "Siguiente ronda" y los triggers de host funcionen ya.
      if (_isHost && !wasHost) {
        const st = BlackjackGame.getState?.();
        if (st) st.isHost = true;
        if (room.status === 'reveal') {
          const nxt = document.getElementById('btn-next-round');
          if (nxt) nxt.classList.remove('hidden');
        }
      }
    }

    switch (room.status) {
      case 'waiting':
        _updateLobbyUI(room);
        break;
      case 'countdown':
        _onCountdown(room);
        break;
      case 'playing':
        _onRoundStart(room);
        break;
      case 'reveal':
        _onRevealStart(room);
        break;
      case 'playAgain':
        _onPlayAgainStatus(room);
        break;
      case 'finished':
        _onGameFinished(room);
        break;
    }

    if (room.status === 'playing') {
      _updateOpponentsFromDecisions(room.decisions || {});

      if (_isHost) {
        // FIX: contar solo jugadores conectados. Si un jugador se cae mid-round
        // (connected: false), nunca reporta done y el reveal quedaba bloqueado.
        const totalPlayers = Object.values(room.players || {}).filter(p => p.connected !== false).length;
        const doneCount    = room.doneCount || 0;
        console.log(`[App] doneCount: ${doneCount} / ${totalPlayers}`);
        if (totalPlayers >= 2 && doneCount >= totalPlayers) {
          BlackjackSync.startReveal(_roomCode).catch(e => console.error('[App] startReveal error:', e));
        }
      }
    }
  }

  function _updateLobbyUI(room) {
    // Limpiar estado play-again (ya estamos en lobby)
    _playAgainCountdownActive = false;
    clearInterval(_playAgainCountdownInterval);

    // ── Detectar reset de partida (funciona para host Y no-host) ──
    // Si resetAt cambió, significa que se inició una nueva partida desde "jugar de nuevo".
    // Limpiar scores locales aquí garantiza que el marcador arranque desde 0 para todos,
    // independientemente de si el cliente recibió el evento 'playAgain' o no.
    const resetAt = room.resetAt || 0;
    if (resetAt > 0 && resetAt !== _lastResetAt) {
      _lastResetAt = resetAt;
      _localScores = {};
      BlackjackGame.resetScores?.();
      // Resetear timer de auto-arranque para que empiece desde 0 con el nuevo lobbyAt
      _clearPublicLobbyTimer();
    }

    // Restaurar botón de "jugar de nuevo" por si quedó deshabilitado
    const playAgainBtn = document.querySelector('#screen-finished .btn-primary');
    if (playAgainBtn) {
      playAgainBtn.disabled    = false;
      playAgainBtn.textContent = '🔄 Jugar de nuevo';
    }

    const activeScreen = document.querySelector('.screen.active');
    if (!activeScreen || activeScreen.id !== 'screen-lobby') {
      _showScreen('screen-lobby');
      document.getElementById('lobby-code-display').textContent = _roomCode;
      const linkEl = document.getElementById('lobby-code-link-display');
      if (linkEl) {
        const base = window.location.origin + window.location.pathname;
        linkEl.textContent = `${base}?sala=${_roomCode}`;
      }
      document.getElementById('lobby-mode-display').textContent = MODE_LABELS[_mode] || _mode;
      document.getElementById('game-topbar')?.classList.add('hidden');
      // Asegurar que la URL refleje la sala actual
      if (_roomCode && !window.location.search.includes(_roomCode)) {
        history.replaceState({ sala: _roomCode }, '', window.location.pathname + '?sala=' + _roomCode);
      }
    }

    // Actualizar _isHost desde Firebase (puede haber cambiado tras play-again)
    const myPlayer = room.players?.[_playerId];
    if (myPlayer !== undefined) {
      _isHost = myPlayer.isHost === true;
    }

    _countdownActive = false;
    _pendingRoomRef  = null;

    const players  = Object.entries(room.players || {}).filter(([, p]) => p.connected !== false);
    const listEl   = document.getElementById('lobby-players-list');
    const startBtn = document.getElementById('btn-start-game');
    const hintEl   = document.getElementById('lobby-hint');

    if (listEl) {
      listEl.innerHTML = players.map(([pid, p]) => `
        <div class="lobby-player-row">
          <div class="lobby-player-avatar">${escapeHtml((p.name || '?').charAt(0).toUpperCase())}</div>
          <span class="lobby-player-name">${escapeHtml(p.name)}</span>
          ${p.isHost ? '<span class="lobby-player-host">HOST</span>' : ''}
          ${pid === _playerId ? '<span style="margin-left:auto;font-family:\'Rajdhani\',sans-serif;font-size:0.7rem;opacity:0.4;letter-spacing:1px;">← TÚ</span>' : ''}
        </div>
      `).join('');
    }

    // ── Timer auto-arranque: corre en TODOS los clientes de sala pública ──
    if (room?.isPublic && room.lobbyAt) {
      _startPublicLobbyTimer(room);
    }

    if (_isHost && startBtn) {
      if (players.length >= 2) {
        startBtn.style.display = 'block';

        // ── Cooldown de 10s tras play-again para que lleguen todos ──
        const resetAt   = room.resetAt || 0;
        const elapsed   = Date.now() - resetAt;
        const COOLDOWN  = 10000; // 10 segundos
        const remaining = Math.max(0, Math.ceil((COOLDOWN - elapsed) / 1000));

        if (remaining > 0) {
          startBtn.disabled    = true;
          startBtn.textContent = `EMPEZAR EN ${remaining}s ▶`;

          // Limpiar cualquier cooldown previo antes de arrancar uno nuevo
          clearInterval(_startCooldownInterval);
          let secs = remaining;
          _startCooldownInterval = setInterval(() => {
            secs--;
            if (secs <= 0) {
              clearInterval(_startCooldownInterval);
              if (startBtn) {
                startBtn.disabled    = false;
                startBtn.textContent = 'EMPEZAR ▶';
              }
            } else {
              if (startBtn) startBtn.textContent = `EMPEZAR EN ${secs}s ▶`;
            }
          }, 1000);
        } else {
          startBtn.disabled    = false;
          startBtn.textContent = 'EMPEZAR ▶';
        }

        if (hintEl) hintEl.style.display = 'none';
      } else {
        startBtn.style.display = 'none';
        if (hintEl) hintEl.style.display = '';
      }
    } else if (!_isHost && startBtn) {
      startBtn.style.display = 'none';
      if (hintEl) hintEl.style.display = '';
    }
  }

  /* ══════════════════════════════════════════
     EMPEZAR PARTIDA (solo host)
     ══════════════════════════════════════════ */
  async function startGame() {
    if (!_isHost) return;

    const btn = document.getElementById('btn-start-game');
    if (btn) { btn.disabled = true; btn.textContent = 'INICIANDO…'; }

    try {
      await BlackjackSync.startCountdown(_roomCode);
      const setData = await _generateRoundSet(1);
      await BlackjackSync.startGame(_roomCode, setData);
      // Cerrar el slot de matchmaking para que nuevos jugadores creen una sala nueva
      if (_lastRoomData?.isPublic) {
        BlackjackSync.closePublicRoom(_mode, _roomCode).catch(() => {});
      }
    } catch (e) {
      console.error('[App] Error al iniciar partida:', e);
      showToast('Error al iniciar — ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'EMPEZAR ▶'; }
    }
  }

  /* ══════════════════════════════════════════
     SIGUIENTE RONDA (solo host)
     ══════════════════════════════════════════ */
  async function nextRound() {
    if (!_isHost) return;

    // ── Modo local: generar la siguiente ronda sin Firebase ──
    if (_isLocal) {
      const state = BlackjackGame.getState();
      if (state) {
        state.players.forEach(p => { _localScores[p.id] = p.score; });
      }
      try {
        await _startNextLocalRound();
      } catch (e) {
        console.error('[App] nextRound local error:', e);
        showToast('Error — ' + e.message, 'error');
      }
      return;
    }

    const state = BlackjackGame.getState();
    const nextRoundNum = (state?.round || 0) + 1;

    try {
      if (state) {
        state.players.forEach(p => { _localScores[p.id] = p.score; });
      }
      console.log('[App] Scores guardados localmente:', _localScores);

      const setData = await _generateRoundSet(nextRoundNum);
      await BlackjackSync.nextRound(_roomCode, nextRoundNum, setData, _localScores);
    } catch (e) {
      console.error('[App] Error al iniciar siguiente ronda:', e);
      showToast('Error — ' + e.message, 'error');
    }
  }

  /* ══════════════════════════════════════════
     JUGAR DE NUEVO — cualquier jugador puede iniciar
     El primero en pulsar se convierte en nuevo host.
     Vuelven al lobby inmediatamente; el botón de
     empezar queda bloqueado 10s en el lobby.
     ══════════════════════════════════════════ */
  async function playAgain() {
    // ── Modo local: reiniciar sin Firebase ──
    if (_isLocal) {
      BlackjackGame.resetScores?.();
      _localScores = {};
      _localRound  = 0;
      const finBtn = document.querySelector('#screen-finished .btn-primary');
      if (finBtn) { finBtn.disabled = true; finBtn.textContent = 'CARGANDO…'; }
      _startNextLocalRound()
        .catch(e => showToast('Error: ' + e.message, 'error'))
        .finally(() => {
          if (finBtn) { finBtn.disabled = false; finBtn.textContent = '🔄 Jugar de nuevo'; }
        });
      return;
    }

    if (!_roomCode || !_playerId) return;

    const btn = document.querySelector('#screen-finished .btn-primary');
    if (btn) { btn.disabled = true; }

    try {
      await BlackjackSync.requestPlayAgain(_roomCode, _playerId);
      // _onPlayAgainStatus hará el reset inmediato para todos
    } catch (e) {
      console.error('[App] playAgain error:', e);
      // Si el listener ya procesó el play-again, el error es irrelevante — no mostrar toast
      if (!_playAgainCountdownActive) {
        showToast('Error al reiniciar partida', 'error');
      }
      if (btn) { btn.disabled = false; }
    }
  }

  /* ─── Recibir evento play-again desde Firebase ─── */
  async function _onPlayAgainStatus(room) {
    if (_playAgainCountdownActive) return;
    _playAgainCountdownActive = true;

    const initiatorId = room.playAgain?.initiatorId;

    // ¿Somos el nuevo host?
    if (initiatorId === _playerId) {
      _isHost = true;
    }

    // Resetear scores para la nueva partida
    _localScores = {};
    BlackjackGame.resetScores?.();

    // Solo el nuevo host resetea la sala en Firebase (resto simplemente espera 'waiting')
    if (initiatorId === _playerId) {
      const currentPlayers  = room.players || _lastRoomPlayers;
      const playerActivity  = room.playerActivity || {};

      // ── Detectar y expulsar jugadores AFK (no jugaron ni una ronda en toda la partida) ──
      // El iniciador está exento (ha demostrado interés al pulsar "Jugar de nuevo").
      const afkIds = Object.keys(currentPlayers).filter(
        pid => pid !== initiatorId && !playerActivity[pid]
      );

      let remainingPlayers = currentPlayers;

      if (afkIds.length > 0) {
        console.log('[App] Expulsando jugadores AFK:', afkIds);
        // Kick en Firebase (los clientes afectados recibirán la detección de expulsión)
        await BlackjackSync.kickPlayers(
          _roomCode, afkIds, room.mode || _mode, room.isPublic
        ).catch(e => console.warn('[App] kickPlayers error:', e));

        // Reducir la lista local de jugadores para el resetToLobby
        remainingPlayers = {};
        for (const [pid, p] of Object.entries(currentPlayers)) {
          if (!afkIds.includes(pid)) remainingPlayers[pid] = p;
        }
      }

      const roomMeta = room.isPublic
        ? { isPublic: true, mode: room.mode || _mode, code: _roomCode }
        : null;
      BlackjackSync.resetToLobby(_roomCode, remainingPlayers, _playerId, roomMeta)
        .catch(e => console.error('[App] resetToLobby error:', e));
    }
    // Todos verán status='waiting' → _updateLobbyUI → lobby con cooldown
  }

  /* ══════════════════════════════════════════
     POOL — carga de data/blackjack/*.json
     ══════════════════════════════════════════ */
  const POOL_FILES = [
    'bundesliga',
    'eredivisie',
    'laliga',
    'liga-portugal',
    'ligue-1',
    'premier-league',
    'resto-del-mundo',
    'serie-a',
  ];

  let _poolData    = null;
  let _poolPromise = null;

  async function _loadPool() {
    if (_poolData) return _poolData;
    if (_poolPromise) return _poolPromise;

    _poolPromise = Promise.all(
      POOL_FILES.map(name =>
        fetch(`data/blackjack/${name}.json`)
          .then(r => {
            if (!r.ok) {
              console.log(`ℹ️ ${name}.json no disponible (${r.status}) — se omite`);
              return {};
            }
            return r.json();
          })
          .catch(() => {
            console.log(`ℹ️ ${name}.json no encontrado — se omite`);
            return {};
          })
      )
    ).then(results => {
      _poolData = Object.assign({}, ...results);
      const total = Object.keys(_poolData).length;
      if (total === 0) throw new Error('No se encontró ningún archivo de pool en data/blackjack/. Asegúrate de tener al menos uno de: ' + POOL_FILES.join(', '));
      console.log(`✅ Blackjack pool cargado: ${total} jugadores`);
      return _poolData;
    });

    return _poolPromise;
  }

  /* ══════════════════════════════════════════
     GENERAR SET DE JUGADORES
     ══════════════════════════════════════════ */
  async function _generateRoundSet(roundNum) {
    const raw = await _loadPool();
    const totalPlayers = Object.keys(raw).length;
    console.log(`[Sets] Pool total: ${totalPlayers} jugadores, modo: ${_mode}`);

    const seed = Date.now() ^ (roundNum * 0xDEADBEEF);

    const pool = Object.entries(raw)
      .map(([id, data]) => ({ id, data }))
      .filter(p => BlackjackSets.getStatValue(p.data, _mode) > 0);

    console.log(`[Sets] Jugadores con valor en modo "${_mode}": ${pool.length}`);

    if (pool.length < 10) throw new Error(`Pool insuficiente (${pool.length} jugadores con ${_mode} > 0)`);

    const setResult = BlackjackSets.generateSet(pool, _mode, seed);
    if (!setResult) throw new Error('No se pudo generar un set válido tras 30 intentos');

    console.log(`[Sets] Set generado OK. Objetivo: ${setResult.objective}, exactCombos: ${setResult.exactCombinations}`);

    return {
      setSeed:   seed,
      objective: setResult.objective,
      players:   setResult.players,
    };
  }

  /* ══════════════════════════════════════════
     CUENTA ATRÁS — overlay encima de todo
     ══════════════════════════════════════════ */
  let _countdownActive = false;

  function _onCountdown(room) {
    if (_countdownActive) return;
    _countdownActive = true;
    _clearPublicLobbyTimer();  // el juego arrancó, cancelar timer de sala pública

    const overlay = document.getElementById('countdown-overlay');
    const numEl   = document.getElementById('countdown-number');
    if (!overlay || !numEl) return;

    const SECS = 10;
    overlay.classList.remove('hidden');
    numEl.textContent = SECS;

    let remaining    = SECS;
    let countdownDone = false;
    let dataReady    = false;
    let pendingRoom  = null;

    _loadPool()
      .then(() => {
        dataReady = true;
        if (countdownDone && pendingRoom) {
          overlay.classList.add('hidden');
          _startRoundNow(pendingRoom);
        }
      })
      .catch(e => {
        dataReady = true;
        console.warn('[App] Pool load error:', e);
        if (countdownDone && pendingRoom) {
          overlay.classList.add('hidden');
          _startRoundNow(pendingRoom);
        }
      });

    const iv = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(iv);
        countdownDone = true;
        if (dataReady && pendingRoom) {
          overlay.classList.add('hidden');
          _startRoundNow(pendingRoom);
        } else if (!dataReady) {
          numEl.textContent = '⏳';
        }
      } else {
        numEl.textContent = remaining;
      }
    }, 1000);

    _pendingRoomRef = (r) => {
      pendingRoom = r;
      if (countdownDone && dataReady) {
        overlay.classList.add('hidden');
        _startRoundNow(r);
      }
    };
  }

  let _pendingRoomRef = null;

  /* ══════════════════════════════════════════
     RONDA INICIADA (listener Firebase)
     ══════════════════════════════════════════ */
  function _onRoundStart(room) {
    const state = BlackjackGame.getState();
    // FIX: cubrir todas las fases activas, no solo 'selecting'.
    // Si el jugador está en waiting-reveal o reveal, los updates de Firebase
    // (ej. doneCount de otro jugador) no deben reinicializar la ronda desde cero,
    // lo que causaba que el jugador volviera a la carta 0 repetidamente.
    if (state && state.round === room.round && state.phase !== 'waiting') return;

    if (_pendingRoomRef) {
      _pendingRoomRef(room);
      _pendingRoomRef = null;
      return;
    }

    _startRoundNow(room);
  }

  function _startRoundNow(room) {
    _countdownActive = false;

    const roomScores = room.scores || {};

    const players = Object.entries(room.players || {}).map(([id, p]) => ({
      id,
      name:  p.name,
      score: (roomScores[id] !== undefined) ? roomScores[id]
           : (_localScores[id] !== undefined) ? _localScores[id]
           : 0,
    }));

    console.log('[App] _startRoundNow scores:', players.map(p => `${p.name}:${p.score}`).join(', '));

    _enrichSetValues(room.setPlayers || [], room.mode).then(async enrichedWithValues => {
      await _assetsPromise;  // garantizar que logos y banderas estén listos
      BlackjackGame.startRound({
        round:      room.round,
        objective:  room.objective,
        setPlayers: enrichedWithValues,
        setSeed:    room.setSeed,
        players,
        mode:       room.mode,
        roomCode:   _roomCode,
        isHost:     _isHost,
        myPlayerId: _playerId,
      });

      const topbar = document.getElementById('game-topbar');
      if (topbar) topbar.classList.remove('hidden');
    });
  }

  /* ─── Enriquecer setPlayers con _value, img, logoUrl y flagUrl ─── */
  async function _enrichSetValues(rawPlayers, mode) {
    // Esperar AMBAS promesas: pool de jugadores Y assets (logos/banderas)
    const [, [logos, flags]] = await Promise.all([
      _loadPool(),
      _assetsPromise
        ? _assetsPromise.then(() => [window._TEAM_LOGOS || {}, window._COUNTRY_FLAGS || {}])
        : Promise.resolve([window._TEAM_LOGOS || {}, window._COUNTRY_FLAGS || {}]),
    ]);

    const pool = _poolData || {};

    return rawPlayers.map(p => {
      const poolData = pool[p.id];
      const club = (poolData && poolData.club) ? poolData.club : (p.club || '');
      const nat  = (poolData && poolData.nat)  ? poolData.nat  : (p.nat  || '');
      return {
        ...p,
        club,
        nat,
        _value:  poolData ? BlackjackSets.getStatValue(poolData, mode) : (p._value || 0),
        img:     (poolData && poolData.img) ? poolData.img : (p.img || null),
        logoUrl: logos[club] || null,
        flagUrl: flags[nat]  || null,
      };
    });
  }

  /* ══════════════════════════════════════════
     REVEAL INICIADO (listener Firebase)
     ══════════════════════════════════════════ */
  function _onRevealStart(room) {
    _triggerRevealForAll(room);
  }

  /* ══════════════════════════════════════════
     FIN DE PARTIDA (listener Firebase)
     ══════════════════════════════════════════ */
  function _onGameFinished(room) {
    // Se gestiona desde BlackjackGame._endGame
  }

  /* ══════════════════════════════════════════
     CUANDO EL JUGADOR TERMINA SUS CARTAS
     ══════════════════════════════════════════ */
  async function onPlayerDone(handData) {
    // ── Modo local: ir directamente al reveal ──
    if (_isLocal) {
      BlackjackGame.startReveal();
      return;
    }

    try {
      await BlackjackSync.reportDone(_roomCode, _playerId, handData);
      // playerActivity ya se actualiza dentro de reportDone (update atómico)
      console.log('[App] reportDone OK, esperando reveal...');

      if (_isHost) {
        setTimeout(async () => {
          const state = BlackjackGame.getState();
          if (!state || state.phase !== 'selecting' && state.phase !== 'waiting-reveal') return;
          try {
            const snap = await window._FB.get(window._FB.ref(window._FB.db, `blackjack/rooms/${_roomCode}`));
            if (!snap.exists()) return;
            const room = snap.val();
            if (room.status === 'playing') {
              // FIX: misma corrección que en _onRoomUpdate — no contar jugadores
              // con connected: false (se caerían sin reportar done)
              const totalPlayers = Object.values(room.players || {}).filter(p => p.connected !== false).length;
              const doneCount = room.doneCount || 0;
              console.log(`[App] Fallback check: ${doneCount}/${totalPlayers}`);
              if (doneCount >= totalPlayers) {
                await BlackjackSync.startReveal(_roomCode);
              }
            }
          } catch (e2) { console.error('[App] fallback error:', e2); }
        }, 4000);
      }
    } catch (e) {
      console.error('[App] Error reportando done:', e);
    }
  }

  function _triggerRevealForAll(room) {
    const state = BlackjackGame.getState();
    if (!state || state.phase === 'reveal') return;

    const decisions = room.decisions || {};
    for (const [pid, decision] of Object.entries(decisions)) {
      const hand = state.hands[pid];
      if (hand) {
        hand.picked   = decision.picked   || [];
        hand.standing = decision.standing || false;
        hand.doneAt   = decision.doneAt   || Date.now();
        hand.total    = hand.picked.reduce((sum, idx) => {
          const p = state.setPlayers[idx];
          return sum + (p?._value || 0);
        }, 0);
      }
    }

    const revObjEl = document.getElementById('reveal-objective-val');
    if (revObjEl) revObjEl.textContent = BlackjackSets.formatObjective(state.objective, state.mode);

    const revealEl = document.getElementById('reveal-players');
    if (revealEl) revealEl.className = `reveal-players players-${state.players.length}`;

    BlackjackGame.startReveal();
  }

  /* ══════════════════════════════════════════
     ACTUALIZAR ACTIVIDAD DE RIVALES
     ══════════════════════════════════════════ */
  function _updateOpponentsFromDecisions(decisions) {
    const state = BlackjackGame.getState();
    if (!state) return;

    for (const p of state.players) {
      const h = state.hands[p.id];
      if (h && decisions[p.id]) {
        h.doneAt = decisions[p.id].doneAt || Date.now();
      }
    }

    BlackjackGame.updateOpponentActivity?.();
  }

  /* ══════════════════════════════════════════
     SALA / VOLVER
     ══════════════════════════════════════════ */
  async function leaveRoom() {
    _cancelWaitPublicInternal();
    clearInterval(_playAgainCountdownInterval);
    clearInterval(_startCooldownInterval);
    _clearPublicLobbyTimer();
    _playAgainCountdownActive = false;

    // ── Modo local: no hay Firebase que limpiar ──
    if (_isLocal) {
      _isLocal        = false;
      _localPlayerName = '';
      _localRound     = 0;
      _playerId       = null;
      _isHost         = false;
      BlackjackGame.resetScores?.();
      _localScores    = {};
      showMenu();
      return;
    }

    if (_roomCode && _playerId) {
      BlackjackSync.disconnect(_roomCode, _playerId).catch(() => {});
    }
    if (_unsubRoom) { _unsubRoom(); _unsubRoom = null; }

    _clearSession();
    _roomCode = null;
    _playerId = null;
    _isHost   = false;
    showMenu();
  }

  /* ── Copiar enlace a la sala ── */
  function copyLink() {
    if (!_roomCode) return;
    const base = window.location.origin + window.location.pathname;
    const url  = `${base}?sala=${_roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Enlace copiado 🔗', 'success');
    }).catch(() => {
      showToast(url, 'success');
    });
  }

  /* ══════════════════════════════════════════
     MENÚ
     ══════════════════════════════════════════ */
  function showMenu() {
    _cancelWaitPublicInternal();
    _clearPublicLobbyTimer();
    document.getElementById('public-options-panel')?.remove();
    document.getElementById('public-wait-status')?.remove();

    // Limpiar estado local si venía de una partida solo
    if (_isLocal) {
      _isLocal         = false;
      _localPlayerName = '';
      _localRound      = 0;
      _playerId        = null;
      _isHost          = false;
      BlackjackGame.resetScores?.();
      _localScores     = {};
    }

    // Limpiar ?sala= de la URL al volver al menú
    history.replaceState({}, '', window.location.pathname);

    _showScreen('screen-menu');
    document.getElementById('game-topbar')?.classList.add('hidden');

    const publicBtn = document.querySelector('#panel-public .btn-primary');
    if (publicBtn) { publicBtn.disabled = false; publicBtn.textContent = 'BUSCAR PARTIDA ▶'; }
    const joinBtn = document.querySelector('#panel-private .btn-secondary');
    if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'UNIRSE A SALA ▶'; }
  }

  /* ══════════════════════════════════════════
     TOAST
     ══════════════════════════════════════════ */
  let _toastTimeout = null;

  function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(_toastTimeout);
    _toastTimeout = setTimeout(() => {
      el.classList.remove('show');
    }, 2800);
  }

  /* ══════════════════════════════════════════
     EXPULSIÓN DE JUGADOR
     Redirige al menú con un mensaje de aviso.
     ══════════════════════════════════════════ */
  function _handleKicked(msg = 'Has sido expulsado de la sala') {
    _clearPublicLobbyTimer();
    clearInterval(_playAgainCountdownInterval);
    clearInterval(_startCooldownInterval);
    _cancelWaitPublicInternal();
    _playAgainCountdownActive = false;

    if (_unsubRoom) { _unsubRoom(); _unsubRoom = null; }
    _clearSession();

    _roomCode = null;
    _playerId = null;
    _isHost   = false;

    // Asegurarse de salir del juego limpiamente
    document.getElementById('game-topbar')?.classList.add('hidden');
    history.replaceState({}, '', window.location.pathname);

    _showScreen('screen-menu');
    setTimeout(() => showToast(msg, 'error'), 300);
  }

  /* ══════════════════════════════════════════
     TIMER AUTO-ARRANQUE SALA PÚBLICA (3 min)
     Corre en TODOS los clientes del lobby.
     Al llegar a 0:
       - ≥2 jugadores → el primer cliente que gane
         el lock arranca la partida automáticamente.
       - <2 jugadores → expira la sala.
     ══════════════════════════════════════════ */
  let _autoTimerInterval = null;  // tick cada segundo (UI + lógica)

  function _startPublicLobbyTimer(room) {
    // FIX: comprobar _autoTimerInterval además de _publicLobbyTimer.
    // _publicLobbyTimer se auto-anula tras su setTimeout, por lo que un update
    // de Firebase posterior podía lanzar un segundo _autoTimerInterval en paralelo.
    if (_autoTimerInterval || _publicLobbyTimer) return;

    const lobbyAt = room.lobbyAt || 0;
    if (!lobbyAt) return;

    const elapsed   = Date.now() - lobbyAt;
    const remaining = PUBLIC_LOBBY_TIMEOUT - elapsed;

    // Mostrar widget del contador
    _showAutoTimerWidget(remaining);

    if (remaining <= 0) {
      _handlePublicLobbyTimeout();
      return;
    }

    // Tick cada segundo: actualizar UI y comprobar expiración
    _autoTimerInterval = setInterval(() => {
      const rem = PUBLIC_LOBBY_TIMEOUT - (Date.now() - lobbyAt);
      if (rem <= 0) {
        _clearPublicLobbyTimer();
        _handlePublicLobbyTimeout();
      } else {
        _updateAutoTimerWidget(rem);
      }
    }, 1000);

    // Guardar referencia al timeout principal (para poder cancelarlo)
    _publicLobbyTimer = setTimeout(() => {
      _publicLobbyTimer = null;
    }, remaining + 1500);

    console.log(`[App] Timer auto-arranque activo: arranca en ${Math.round(remaining / 1000)}s`);
  }

  function _clearPublicLobbyTimer() {
    if (_publicLobbyTimer)     { clearTimeout(_publicLobbyTimer);     _publicLobbyTimer     = null; }
    if (_publicLobbyWarnTimer) { clearTimeout(_publicLobbyWarnTimer); _publicLobbyWarnTimer = null; }
    if (_autoTimerInterval)    { clearInterval(_autoTimerInterval);   _autoTimerInterval    = null; }
    _hideAutoTimerWidget();
  }

  /* ─── Lógica al llegar a 0 (todos los clientes) ─── */
  async function _handlePublicLobbyTimeout() {
    if (!_roomCode) return;

    // Obtener estado actual de la sala
    let room;
    try {
      const snap = await window._FB.get(window._FB.ref(window._FB.db, `blackjack/rooms/${_roomCode}`));
      if (!snap.exists()) return;
      room = snap.val();
    } catch (e) {
      console.warn('[App] _handlePublicLobbyTimeout get error:', e);
      return;
    }

    // Si la sala ya no está en waiting (alguien empezó o ya expiró), ignorar
    if (room.status !== 'waiting') return;

    const players = Object.entries(room.players || {});

    if (players.length >= 2) {
      // ── Intentar ganar el lock para ser quien arranca la partida ──
      try {
        const claimed = await BlackjackSync.claimAutoStart(_roomCode);
        if (!claimed) return;  // otro cliente se adelantó

        console.log('[App] Auto-arranque: ganamos el lock, iniciando partida…');
        showToast('⏱ ¡Tiempo! Arrancando partida automáticamente…', 'success');

        // Convertirnos en host si no lo éramos
        if (!_isHost) {
          _isHost = true;
          await window._FB.update(
            window._FB.ref(window._FB.db, `blackjack/rooms/${_roomCode}/players/${_playerId}`),
            { isHost: true }
          );
        }

        // Arrancar igual que si el host hubiera pulsado EMPEZAR
        await BlackjackSync.startCountdown(_roomCode);
        const setData = await _generateRoundSet(1);
        await BlackjackSync.startGame(_roomCode, setData);
        if (room.isPublic) {
          BlackjackSync.closePublicRoom(_mode, _roomCode).catch(() => {});
        }
      } catch (e) {
        console.error('[App] Auto-arranque error:', e);
      }
    } else {
      // <2 jugadores — expirar sala
      console.log('[App] Auto-arranque: <2 jugadores, expirando sala');
      try {
        const claimed = await BlackjackSync.claimAutoStart(_roomCode);
        if (!claimed) return;
        showToast('⏱ Sala cerrada por inactividad', 'error');
        await BlackjackSync.expirePublicRoom(_roomCode, _mode);
        _handleKicked('La sala cerró por falta de jugadores ⏱️');
      } catch (e) {
        console.warn('[App] expire error:', e);
      }
    }
  }

  /* ─── Compatibilidad: _handlePublicRoomExpired ahora delega ─── */
  async function _handlePublicRoomExpired() {
    await _handlePublicLobbyTimeout();
  }

  /* ─── Widget visual del contador ─── */
  function _showAutoTimerWidget(remainingMs) {
    const el = document.getElementById('lobby-autotimer');
    if (!el) return;
    el.classList.remove('hidden');
    _updateAutoTimerWidget(remainingMs);
  }

  function _hideAutoTimerWidget() {
    const el = document.getElementById('lobby-autotimer');
    if (el) el.classList.add('hidden');
  }

  function _updateAutoTimerWidget(remainingMs) {
    const totalMs  = PUBLIC_LOBBY_TIMEOUT;
    const secs     = Math.max(0, Math.ceil(remainingMs / 1000));
    const mins     = Math.floor(secs / 60);
    const s        = secs % 60;
    const pct      = Math.max(0, remainingMs / totalMs) * 100;
    const urgent   = secs <= 30;

    const countEl = document.getElementById('lobby-autotimer-count');
    const barEl   = document.getElementById('lobby-autotimer-bar');
    const labelEl = document.getElementById('lobby-autotimer-label');

    if (countEl) {
      countEl.textContent = `${mins}:${String(s).padStart(2, '0')}`;
      countEl.classList.toggle('urgent', urgent);
    }
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.classList.toggle('urgent', urgent);
    }
    if (labelEl) {
      labelEl.textContent = urgent ? '⚠️ Arrancando en' : '⏱ La partida arranca en';
    }
  }

  /* ══════════════════════════════════════════
     SESIÓN — evita duplicados al volver a entrar
     ══════════════════════════════════════════ */
  function _saveSession() {
    if (!_roomCode || !_playerId) return;
    try {
      sessionStorage.setItem('bj_session', JSON.stringify({
        code:     _roomCode,
        playerId: _playerId,
        isHost:   _isHost,
        mode:     _mode,
      }));
    } catch (e) {}
  }

  function _loadSession() {
    try {
      const s = sessionStorage.getItem('bj_session');
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  function _clearSession() {
    try { sessionStorage.removeItem('bj_session'); } catch (e) {}
  }

  /* ══════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════ */
  function _showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
    // Defensa extra: el menú nunca debe arrastrar la barra "Objetivo" de una partida
    // anterior (bug: al salir a mitad de partida podía quedar visible al hacer scroll).
    if (id === 'screen-menu') {
      document.getElementById('game-topbar')?.classList.add('hidden');
      window.scrollTo(0, 0);
    }
  }

  function _showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  function _clearError(id) {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  }

  function _mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function _shuffleArr(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ═══════════════════════════════════════════
     API PÚBLICA
     ═══════════════════════════════════════════ */
  async function syncScores(players) {
    if (!_isHost || !_roomCode) return;
    try {
      const scores = {};
      players.forEach(p => { scores[p.id] = p.score; });
      await BlackjackSync.updateScores(_roomCode, scores);
    } catch (e) {
      console.error('[App] syncScores error:', e);
    }
  }

  function onRoundScoresReady(players) {
    players.forEach(p => { _localScores[p.id] = p.score; });
    console.log('[App] Scores tras ronda:', players.map(p => `${p.name}:${p.score}`).join(', '));
    if (_isHost && !_isLocal) syncScores(players);
  }

  return {
    init,
    selectMode,
    setTab,
    createRoom,
    joinRoom,
    findPublicRoom,
    doCreatePublicRoom,
    doWaitPublicRoom,
    cancelWaitPublic,
    startGame,
    startLocalGame,
    nextRound,
    onPlayerDone,
    syncScores,
    onRoundScoresReady,
    leaveRoom,
    copyLink,
    playAgain,
    showMenu,
    showToast,
  };

})();
