/* =============================================
   BLACKJACK-SYNC.JS
   Firebase Realtime DB — Multijugador online
   QUIÉN COÑO FALTA — Blackjack de Fútbol
   ============================================= */

const BlackjackSync = (() => {

  /* ─── Helpers Firebase (inyectados desde index.html) ─── */
  const FB = () => window._FB;

  function _ref(path) {
    const { db, ref } = FB();
    return ref(db, path);
  }

  /* ─── onDisconnect: elimina nodo cuando el cliente se desconecta ─── */
  function _onDisconnectRemove(path) {
    try {
      if (window._FBOnDisconnect) {
        const { db, ref } = FB();
        window._FBOnDisconnect(ref(db, path)).remove().catch(() => {});
      }
    } catch (e) {
      console.warn('[Sync] onDisconnect no disponible:', e);
    }
  }


  /* ═══════════════════════════════════════════
     CREAR SALA
     ═══════════════════════════════════════════ */
  async function createRoom(hostName, mode) {
    const { set, serverTimestamp } = FB();
    const code = _genCode();
    const hostId = _genId();

    const now = Date.now();
    const room = {
      status:         'waiting',
      mode,
      targetScore:    5,
      round:          0,
      createdAt:      serverTimestamp(),
      lobbyAt:        now,          // timestamp para el timer de 3 min en salas públicas
      setSeed:        0,
      objective:      0,
      players: {
        [hostId]: { name: hostName, score: 0, connected: true, isHost: true }
      },
      decisions:      {},
      doneCount:      0,
      playerActivity: {},           // qué jugadores han jugado al menos una ronda en esta partida
    };

    await set(_ref(`blackjack/rooms/${code}`), room);
    _onDisconnectRemove(`blackjack/rooms/${code}/players/${hostId}`);
    return { code, playerId: hostId };
  }

  /* ═══════════════════════════════════════════
     UNIRSE A SALA
     ═══════════════════════════════════════════ */
  async function joinRoom(code, playerName) {
    const { get, update } = FB();

    const snap = await get(_ref(`blackjack/rooms/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');

    const room = snap.val();
    if (room.status !== 'waiting') throw new Error('La partida ya ha comenzado');

    const playerCount = Object.keys(room.players || {}).length;
    if (playerCount >= 6) throw new Error('Sala llena (máx. 6 jugadores)');

    const playerId = _genId();
    await update(_ref(`blackjack/rooms/${code}/players/${playerId}`), {
      name: playerName, score: 0, connected: true, isHost: false
    });
    _onDisconnectRemove(`blackjack/rooms/${code}/players/${playerId}`);

    return { code, playerId };
  }

  /* ═══════════════════════════════════════════
     RECONEXIÓN — reusa slot existente
     Evita duplicados al volver a una sala pública.
     Devuelve true si reconectó, false si falló.
     ═══════════════════════════════════════════ */
  async function tryReconnect(code, playerId, name) {
    const { get, update } = FB();
    try {
      const roomSnap = await get(_ref(`blackjack/rooms/${code}`));
      if (!roomSnap.exists()) return false;
      const room = roomSnap.val();
      // Solo reconectar si la sala está en lobby (waiting)
      if (room.status !== 'waiting') return false;

      const playerSnap = await get(_ref(`blackjack/rooms/${code}/players/${playerId}`));
      if (!playerSnap.exists()) return false;

      await update(_ref(`blackjack/rooms/${code}/players/${playerId}`), {
        connected: true,
        name,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ═══════════════════════════════════════════
     ESCUCHAR SALA (listener principal)
     ═══════════════════════════════════════════ */
  function listenRoom(code, callbacks) {
    const { onValue } = FB();
    return onValue(_ref(`blackjack/rooms/${code}`), snap => {
      if (!snap.exists()) return;
      const room = snap.val();
      callbacks.onRoomUpdate(room);
    });
  }

  /* ═══════════════════════════════════════════
     INICIAR CUENTA ATRÁS (host avisa a todos)
     ═══════════════════════════════════════════ */
  async function startCountdown(code) {
    const { update } = FB();
    await update(_ref(`blackjack/rooms/${code}`), {
      status:         'countdown',
      countdownStart: Date.now(),
    });
  }

  /* ═══════════════════════════════════════════
     INICIAR PARTIDA (solo host)
     ═══════════════════════════════════════════ */
  async function startGame(code, setData) {
    const { update } = FB();
    const publicPlayers = setData.players.map(p => ({
      id:   p.id,
      name: p.name,
      nat:  p.nat,
      club: p.club,
      pos:  p.pos,
      img:  p.img || null,
    }));

    await update(_ref(`blackjack/rooms/${code}`), {
      status:         'playing',
      round:          1,
      setSeed:        setData.setSeed,
      objective:      setData.objective,
      setPlayers:     publicPlayers,
      decisions:      {},
      doneCount:      0,
      playerActivity: {},           // resetear actividad al arrancar partida nueva
    });
  }

  /* ═══════════════════════════════════════════
     SIGUIENTE RONDA (solo host)
     ═══════════════════════════════════════════ */
  async function nextRound(code, roundNum, setData, currentScores) {
    const { update } = FB();
    const publicPlayers = setData.players.map(p => ({
      id: p.id, name: p.name, nat: p.nat, club: p.club, pos: p.pos, img: p.img || null,
    }));

    await update(_ref(`blackjack/rooms/${code}`), {
      status:      'playing',
      round:       roundNum,
      setSeed:     setData.setSeed,
      objective:   setData.objective,
      setPlayers:  publicPlayers,
      decisions:   {},
      doneCount:   0,
      revealStarted: false,
      scores:      currentScores || {},
    });
  }

  /* ═══════════════════════════════════════════
     REPORTAR DECISIÓN COMPLETA
     FIX: playerActivity fusionado en el mismo update atómico
     para evitar la race condition con playAgain que expulsaba
     jugadores que sí habían jugado.
     ═══════════════════════════════════════════ */
  async function reportDone(code, playerId, handData) {
    const { update, runTransaction } = FB();

    // Update atómico: decisions + playerActivity en un solo roundtrip
    await update(_ref(`blackjack/rooms/${code}`), {
      [`decisions/${playerId}/picked`]:   handData.picked,
      [`decisions/${playerId}/bust`]:     handData.bust,
      [`decisions/${playerId}/standing`]: handData.standing,
      [`decisions/${playerId}/doneAt`]:   Date.now(),
      [`playerActivity/${playerId}`]:     true,   // ← antes era llamada separada sin await
    });

    const result = await runTransaction(_ref(`blackjack/rooms/${code}/doneCount`), current => {
      return (current || 0) + 1;
    });

    return result.snapshot.val();
  }

  /* ═══════════════════════════════════════════
     INICIAR REVEAL (host detecta que todos terminaron)
     ═══════════════════════════════════════════ */
  async function startReveal(code) {
    const { runTransaction, update } = FB();

    let triggered = false;
    await runTransaction(_ref(`blackjack/rooms/${code}/status`), current => {
      // FIX: resetear en cada invocación del callback (Firebase puede reintentar
      // si hay conflicto, y triggered quedaría stale-true de un intento previo)
      triggered = false;
      if (current === 'playing') { triggered = true; return 'reveal'; }
      return;
    });

    if (triggered) {
      await update(_ref(`blackjack/rooms/${code}`), { revealStart: Date.now() });
    }
  }

  /* ═══════════════════════════════════════════
     ACTUALIZAR PUNTOS (host tras reveal)
     ═══════════════════════════════════════════ */
  async function updateScores(code, scores) {
    const { update: fbUpdate } = FB();
    for (const [pid, score] of Object.entries(scores)) {
      if (pid && pid !== 'undefined') {
        await fbUpdate(_ref(`blackjack/rooms/${code}/players/${pid}`), { score });
      }
    }
  }

  /* ═══════════════════════════════════════════
     JUGAR DE NUEVO — cualquier jugador puede iniciarlo
     El primero en llamar se convierte en nuevo host.
     ═══════════════════════════════════════════ */
  async function requestPlayAgain(code, playerId) {
    const { runTransaction } = FB();
    let isInitiator = false;

    // Transacción solo sobre el subpath playAgain (más ligero que el nodo entero)
    const result = await runTransaction(_ref(`blackjack/rooms/${code}/playAgain`), current => {
      // Ya hay iniciador — no hacer nada (abortar sin cambios)
      if (current && current.initiatorId) return; // undefined = abort
      // Primer jugador que llega — marcar como iniciador
      isInitiator = true;
      return { initiatorId: playerId, initiatedAt: Date.now() };
    });

    // Si la transacción no se confirmó (otro jugador llegó antes), no es un error
    if (!result.committed) {
      isInitiator = false;
    } else if (isInitiator) {
      // Actualizar el status de la sala por separado
      const { update } = FB();
      await update(_ref(`blackjack/rooms/${code}`), { status: 'playAgain' });
    }

    return { isInitiator };
  }

  /* ═══════════════════════════════════════════
     MATCHMAKING PÚBLICO
     Soporta múltiples salas simultáneas por modo.
     Estructura: blackjack/matchmaking/{mode}/{code}
     ═══════════════════════════════════════════ */
  async function findOrCreatePublicRoom(playerName, mode) {
    const { get, set, update } = FB();

    // ── 1. Buscar salas candidatas en el nodo de matchmaking ──
    const snap = await get(_ref(`blackjack/matchmaking/${mode}`));
    const candidates = [];

    if (snap.exists()) {
      const entries = snap.val();
      for (const [code, data] of Object.entries(entries)) {
        // Filtrar solo entradas que sean objetos con status waiting
        // (descarta campos planos del formato antiguo como "code", "status", etc.)
        if (data && typeof data === 'object' && data.status === 'waiting') {
          candidates.push(code);
        }
      }
    }

    // ── 2. Intentar unirse a la primera sala disponible ──
    // Probamos cada candidata directamente con joinRoom.
    // Si el juego ya empezó o la sala está llena, la limpiamos y pasamos a la siguiente.
    for (const code of candidates) {
      try {
        // Verificar sala real antes de intentar unirse
        const roomSnap = await get(_ref(`blackjack/rooms/${code}`));
        if (!roomSnap.exists() || roomSnap.val().status !== 'waiting') {
          // Entrada huérfana — limpiar silenciosamente
          set(_ref(`blackjack/matchmaking/${mode}/${code}`), null).catch(() => {});
          continue;
        }

        // Comprobar si la sala lleva más de 3 min en lobby sin empezar → sala zombie
        const lobbyAt = roomSnap.val().lobbyAt || 0;
        const LOBBY_TIMEOUT_MS = 3 * 60 * 1000;
        if (lobbyAt > 0 && (Date.now() - lobbyAt) > LOBBY_TIMEOUT_MS) {
          console.log(`[Sync] Sala zombie detectada (${code}), limpiando...`);
          // Expirar: notificar a clientes conectados y limpiar
          update(_ref(`blackjack/rooms/${code}`), { status: 'expired' }).catch(() => {});
          setTimeout(() => {
            set(_ref(`blackjack/matchmaking/${mode}/${code}`), null).catch(() => {});
            set(_ref(`blackjack/rooms/${code}`), null).catch(() => {});
          }, 2000);
          continue;
        }

        // Intentar unirse
        const result = await joinRoom(code, playerName);
        // Éxito — actualizar contador (no crítico)
        update(_ref(`blackjack/matchmaking/${mode}/${code}`), {
          playerCount: (roomSnap.val().players
            ? Object.keys(roomSnap.val().players).length + 1
            : 2),
        }).catch(() => {});
        return { ...result, isHost: false, isPublic: true };

      } catch (e) {
        // Sala no disponible (llena, empezada, etc.) — limpiar y probar siguiente
        console.warn(`[Sync] Sala pública ${code} no disponible: ${e.message}`);
        set(_ref(`blackjack/matchmaking/${mode}/${code}`), null).catch(() => {});
      }
    }

    // ── 3. Ninguna sala disponible — crear sala nueva ──
    const myCode = _genCode();
    const myId   = _genId();

    await set(_ref(`blackjack/matchmaking/${mode}/${myCode}`), {
      code:        myCode,
      mode,
      status:      'waiting',
      playerCount: 1,
    });

    const room = {
      status:         'waiting',
      mode,
      targetScore:    5,
      round:          0,
      createdAt:      Date.now(),
      lobbyAt:        Date.now(),   // timer de 3 min para salas públicas
      setSeed:        0,
      objective:      0,
      isPublic:       true,
      players: {
        [myId]: { name: playerName, score: 0, connected: true, isHost: true }
      },
      decisions:      {},
      doneCount:      0,
      playerActivity: {},
    };

    try {
      await set(_ref(`blackjack/rooms/${myCode}`), room);
      _onDisconnectRemove(`blackjack/rooms/${myCode}/players/${myId}`);
    } catch (e) {
      set(_ref(`blackjack/matchmaking/${mode}/${myCode}`), null).catch(() => {});
      throw e;
    }

    return { code: myCode, playerId: myId, isHost: true, isPublic: true };
  }

  /* ═══════════════════════════════════════════
     COMPROBAR ESTADO DE SALA PÚBLICA
     Con múltiples salas siempre hay hueco (se crea una nueva si hace falta).
     Se mantiene por compatibilidad pero siempre devuelve disponible.
     ═══════════════════════════════════════════ */
  async function checkPublicRoomStatus(mode) {
    return { available: true };
  }

  /* ═══════════════════════════════════════════
     CERRAR SALA PÚBLICA (cuando empieza la partida)
     code  — código de la sala concreta a cerrar
     ═══════════════════════════════════════════ */
  async function closePublicRoom(mode, code) {
    const { update } = FB();
    try {
      if (code) {
        await update(_ref(`blackjack/matchmaking/${mode}/${code}`), { status: 'started' });
      }
    } catch (e) {
      console.warn('[Sync] closePublicRoom error (no crítico):', e);
    }
  }

  /* ═══════════════════════════════════════════
     VOLVER AL LOBBY (nueva partida)
     Resetea la sala a 'waiting', asigna nuevo host.
     newHostId  — playerId del nuevo host (opcional)
     roomMeta   — { isPublic, mode } para reabrir matchmaking (opcional)
     ═══════════════════════════════════════════ */
  async function resetToLobby(code, players, newHostId, roomMeta) {
    const { update } = FB();

    const resetPlayers = {};
    for (const [pid, p] of Object.entries(players)) {
      resetPlayers[pid] = {
        name:      p.name,
        score:     0,
        connected: p.connected ?? true,
        isHost:    newHostId ? (pid === newHostId) : (p.isHost ?? false),
      };
    }

    await update(_ref(`blackjack/rooms/${code}`), {
      status:         'waiting',
      round:          0,
      setSeed:        0,
      objective:      0,
      setPlayers:     null,
      decisions:      {},
      doneCount:      0,
      revealStart:    null,
      revealStarted:  false,
      scores:         null,
      playAgain:      null,
      autoStartLock:  null,   // FIX: limpiar lock del auto-arranque anterior para que
                               // funcione de nuevo si el lobby público vuelve a expirar
      resetAt:        Date.now(),
      lobbyAt:        Date.now(),
      playerActivity: {},
      players:        resetPlayers,
    });

    // Si era sala pública, reabrir nodo de matchmaking para nuevas búsquedas
    if (roomMeta?.isPublic && roomMeta?.mode) {
      try {
        const matchCode = roomMeta.code || code;
        await update(_ref(`blackjack/matchmaking/${roomMeta.mode}/${matchCode}`), {
          status:      'waiting',
          playerCount: Object.keys(resetPlayers).length,
        });
      } catch (e) {
        console.warn('[Sync] matchmaking reset error (no crítico):', e);
      }
    }
  }

  /* ═══════════════════════════════════════════
     LIMPIAR AL SALIR
     Si la sala está en lobby (waiting), elimina
     al jugador completamente para que no ocupe
     hueco ni genere confusión.
     Si la partida ya empezó, solo marca como
     desconectado (para no romper la ronda).
     ═══════════════════════════════════════════ */
  async function disconnect(code, playerId) {
    const { get, update, remove } = FB();
    try {
      const snap = await get(_ref(`blackjack/rooms/${code}`));
      if (!snap.exists()) return;

      const room = snap.val();

      if (room.status === 'waiting') {
        // Eliminar al jugador del lobby completamente
        await remove(_ref(`blackjack/rooms/${code}/players/${playerId}`));

        // Si era sala pública, decrementar el contador de matchmaking
        if (room.isPublic && room.mode) {
          const remaining = Object.keys(room.players || {}).filter(pid => pid !== playerId).length;
          if (remaining === 0) {
            // Sala vacía — limpiar nodo de matchmaking también
            remove(_ref(`blackjack/matchmaking/${room.mode}/${code}`)).catch(() => {});
            remove(_ref(`blackjack/rooms/${code}`)).catch(() => {});
          } else {
            update(_ref(`blackjack/matchmaking/${room.mode}/${code}`), {
              playerCount: remaining,
            }).catch(() => {});

            // Si era el host, promocionar al siguiente jugador como host
            if (room.players?.[playerId]?.isHost) {
              const nextPid = Object.keys(room.players).find(pid => pid !== playerId);
              if (nextPid) {
                update(_ref(`blackjack/rooms/${code}/players/${nextPid}`), { isHost: true }).catch(() => {});
              }
            }
          }
        } else {
          // Sala privada: si era el host, promocionar al siguiente
          if (room.players?.[playerId]?.isHost) {
            const nextPid = Object.keys(room.players || {}).find(pid => pid !== playerId);
            if (nextPid) {
              update(_ref(`blackjack/rooms/${code}/players/${nextPid}`), { isHost: true }).catch(() => {});
            }
          }
        }
      } else {
        // Partida en curso — solo marcar como desconectado
        await update(_ref(`blackjack/rooms/${code}/players/${playerId}`), {
          connected: false,
        });
        // Failover de host en partida: si el que se va era el host, promover a
        // otro jugador conectado para que el juego no se congele (nadie
        // dispararía el reveal ni la siguiente ronda).
        if (room.players?.[playerId]?.isHost) {
          const nextPid = Object.keys(room.players || {})
            .find(pid => pid !== playerId && room.players[pid]?.connected !== false);
          if (nextPid) {
            update(_ref(`blackjack/rooms/${code}/players/${nextPid}`), { isHost: true }).catch(() => {});
            update(_ref(`blackjack/rooms/${code}/players/${playerId}`), { isHost: false }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('[Sync] disconnect error (no crítico):', e);
    }
  }

  /* ═══════════════════════════════════════════
     MARCAR JUGADOR COMO ACTIVO EN ESTA PARTIDA
     NOTA: ahora se llama internamente desde reportDone
     (fusionado en el mismo update atómico).
     Se mantiene en la API por si se necesita externamente.
     ═══════════════════════════════════════════ */
  async function markPlayerActive(code, playerId) {
    const { update } = FB();
    await update(_ref(`blackjack/rooms/${code}/playerActivity`), {
      [playerId]: true,
    });
  }

  /* ═══════════════════════════════════════════
     EXPULSAR JUGADORES (por AFK u otras causas)
     Elimina sus entradas de room.players y actualiza
     el contador de matchmaking si es sala pública.
     ═══════════════════════════════════════════ */
  async function kickPlayers(code, playerIds, mode, isPublic) {
    const { remove, get, update } = FB();
    if (!playerIds || playerIds.length === 0) return;

    for (const pid of playerIds) {
      await remove(_ref(`blackjack/rooms/${code}/players/${pid}`)).catch(() => {});
    }

    if (isPublic && mode) {
      try {
        const snap = await get(_ref(`blackjack/rooms/${code}/players`));
        const remaining = snap.exists() ? Object.keys(snap.val()).length : 0;
        if (remaining === 0) {
          remove(_ref(`blackjack/matchmaking/${mode}/${code}`)).catch(() => {});
          remove(_ref(`blackjack/rooms/${code}`)).catch(() => {});
        } else {
          update(_ref(`blackjack/matchmaking/${mode}/${code}`), { playerCount: remaining }).catch(() => {});
        }
      } catch (e) {
        console.warn('[Sync] kickPlayers matchmaking update error (no crítico):', e);
      }
    }
  }

  /* ═══════════════════════════════════════════
     EXPIRAR SALA PÚBLICA (3 min sin empezar)
     Marca la sala como 'expired' para que los clientes
     reaccionen, y luego limpia Firebase tras 3s.
     ═══════════════════════════════════════════ */
  async function expirePublicRoom(code, mode) {
    const { update, remove } = FB();
    try {
      // Marcar como expirada — los clientes la detectan y vuelven al menú
      await update(_ref(`blackjack/rooms/${code}`), { status: 'expired' });
      // Limpiar nodos tras un pequeño delay (suficiente para que los clientes reaccionen)
      setTimeout(() => {
        remove(_ref(`blackjack/matchmaking/${mode}/${code}`)).catch(() => {});
        remove(_ref(`blackjack/rooms/${code}`)).catch(() => {});
      }, 4000);
    } catch (e) {
      console.warn('[Sync] expirePublicRoom error (no crítico):', e);
    }
  }

  /* ─── Helpers ─── */
  function _genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  function _genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /* ═════════════════════════════
  /* ═══════════════════════════════════════════
     AUTO-ARRANQUE (timer lobby público)
     Transacción atómica: solo el primer cliente
     que llame consigue el lock y arranca la partida.
     Devuelve true si este cliente ganó el lock.
     ═══════════════════════════════════════════ */
  async function claimAutoStart(code) {
    const { runTransaction } = FB();
    let claimed = false;
    const result = await runTransaction(_ref(`blackjack/rooms/${code}/autoStartLock`), current => {
      // FIX: resetear en cada invocación del callback (Firebase puede reintentar
      // si hay conflicto, y claimed quedaría stale-true de un intento previo)
      claimed = false;
      if (current) return; // ya reclamado — abortar
      claimed = true;
      return Date.now();
    });
    return result.committed && claimed;
  }

/* ═══════════════════════════════════════════
     API PÚBLICA
     ═══════════════════════════════════════════ */
  return {
    createRoom,
    joinRoom,
    tryReconnect,
    listenRoom,
    startCountdown,
    startGame,
    nextRound,
    reportDone,
    startReveal,
    updateScores,
    requestPlayAgain,
    findOrCreatePublicRoom,
    checkPublicRoomStatus,
    closePublicRoom,
    resetToLobby,
    disconnect,
    markPlayerActive,
    kickPlayers,
    expirePublicRoom,
    claimAutoStart,
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlackjackSync;
}
