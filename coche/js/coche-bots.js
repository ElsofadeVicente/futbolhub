/* =============================================
   COCHE-BOTS.JS
   Jugadores automáticos de las salas públicas.
   Corren en el cliente que sea host (igual que en
   blackjack: si el host cambia, los bots pasan con él).

   CÓMO ELIGE SU RESPUESTA

   1. Cuántas restricciones acierta. Si en la base hay
      algún futbolista que cumple las 5:

        2 restricciones ....  5 %
        3 restricciones ... 35 %
        4 restricciones ... 40 %
        5 restricciones ... 20 %

      Si no hay nadie que cumpla las 5:

        2 restricciones ... 20 %
        3 restricciones ... 60 %
        4 restricciones ... 20 %

      Si tampoco hay futbolistas para el número que ha
      salido, se reparte entre los que sí se pueden.

   2. Cuál de todos. Para no soltar un nombre absurdo,
      coge SIEMPRE del top 10 por partidos jugados entre
      los que aciertan justo ese número de restricciones,
      y de ahí uno al azar.

   3. Si otro jugador ya ha dicho a ese futbolista, cambia
      de elección: juega con la misma regla que una persona
      (no se puede repetir nombre en la ronda).

   4. Cuándo responde. En un segundo al azar de cuando
      faltan entre 20 y 40 segundos. En rondas cortas
      (menos de 60 s, y la muerte súbita de 20 s) eso no
      cabe, así que responde en el tercio central.
   ============================================= */

const CocheBots = (() => {

  /* ─── Reparto por número de restricciones acertadas ─── */
  const WEIGHTS_WITH_5    = { 2:  5, 3: 35, 4: 40, 5: 20 };
  const WEIGHTS_WITHOUT_5 = { 2: 20, 3: 60, 4: 20 };

  /* ─── Cuántos candidatos por nivel: el top 10 por partidos ─── */
  const TOP_N = 10;

  /* ─── Ventana de respuesta ─── */
  const ANSWER_WINDOW = [20, 40];   // segundos que deben faltar para el final
  const SHORT_ROUND_SECS = 60;      // por debajo de esto, tercio central

  /* ─── Barrido de la base de datos ─── */
  const SCAN_CHUNK = 250;           // jugadores por tick (no bloquear la UI)

  /* ─── Estado ─── */
  const _timers = BotCore.createTimers();
  let _lobbyBusy    = false;
  let _lastRoundKey = null;
  let _scanToken    = 0;
  let _pendingAdds  = 0;            // altas de bot programadas pero aún sin escribir
  const _pendingNames = new Set();  // nombres ya reservados por esas altas

  /* ═══════════════════════════════════════════
     LOBBY — mantener el número de bots que toca
     ═══════════════════════════════════════════ */
  async function syncLobby(room, code) {
    if (!room || !code || !room.isPublic) return;
    if (room.status !== 'waiting') return;
    if (_lobbyBusy) return;

    const names = await BotNames.load();
    if (!names.length) return;

    const { humans, bots } = BotCore.split(room.players);
    const want = BotCore.desiredBotCount(humans.length);

    // Contar las altas ya programadas pero aún sin escribir, para no repetirlas:
    // syncLobby corre en cada actualización de sala.
    const effective = bots.length + _pendingAdds;
    if (want === effective) return;

    _lobbyBusy = true;
    try {
      if (want > effective)        await _addBots(code, want - effective, room);
      else if (want < bots.length) await _removeBots(code, bots, bots.length - want);
    } catch (e) {
      console.warn('[Bots] syncLobby error:', e);
    } finally {
      _lobbyBusy = false;
    }
  }

  const _roomPath = (code) => `restricciones/rooms/${code}`;

  async function _addBots(code, count, room) {
    const { db, ref, get, update } = window._FB;

    // Excluir presentes y nombres ya reservados por altas en vuelo.
    const taken = Object.values(room.players || {}).map(p => p.name).concat([..._pendingNames]);
    const picks = BotNames.pick(count, taken);
    if (!picks.length) return;

    picks.forEach((name, i) => {
      const delay = BotCore.randFloat(1800, 5200) + i * BotCore.randFloat(2500, 6000);

      _pendingAdds++;
      _pendingNames.add(BotNames.norm(name));

      _timers.after(delay, async () => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          _pendingAdds = Math.max(0, _pendingAdds - 1);
          _pendingNames.delete(BotNames.norm(name));
        };
        try {
          const snap = await get(ref(db, _roomPath(code)));
          if (!snap.exists()) return;
          const fresh = snap.val();
          if (fresh.status !== 'waiting' || !fresh.isPublic) return;

          const s = BotCore.split(fresh.players);
          if (s.bots.length + (_pendingAdds - 1) >= BotCore.desiredBotCount(s.humans.length)) return;
          if (Object.keys(fresh.players || {}).length >= 5) return;   // tope de la sala

          const already = Object.values(fresh.players || {}).map(p => BotNames.norm(p.name));
          if (already.includes(BotNames.norm(name))) return;

          const botId = BotCore.genBotId();
          await update(ref(db, `${_roomPath(code)}/players/${botId}`), {
            name, avatar: null, score: 0, connected: true, isHost: false, isBot: true,
          });
          console.log('[Bots] Añadido', name);
        } catch (e) {
          console.warn('[Bots] alta fallida:', e);
        } finally {
          release();
        }
      });
    });
  }

  async function _removeBots(code, bots, count) {
    const { db, ref, get, remove } = window._FB;
    const victims = bots.slice(-count);

    victims.forEach(([botId], i) => {
      const delay = BotCore.randFloat(3000, 8000) + i * BotCore.randFloat(1500, 4000);

      _timers.after(delay, async () => {
        try {
          const snap = await get(ref(db, _roomPath(code)));
          if (!snap.exists()) return;
          const fresh = snap.val();
          if (fresh.status !== 'waiting') return;
          if (!fresh.players?.[botId]) return;

          const s = BotCore.split(fresh.players);
          if (s.bots.length <= BotCore.desiredBotCount(s.humans.length)) return;
          if (s.humans.length + s.bots.length <= 2) return;   // la sala no baja de 2

          await remove(ref(db, `${_roomPath(code)}/players/${botId}`));
          console.log('[Bots] Se marcha', fresh.players[botId].name);
        } catch (e) {
          console.warn('[Bots] baja fallida:', e);
        }
      });
    });
  }

  /* ═══════════════════════════════════════════
     BUSCAR CANDIDATOS

     Recorre la base ordenada por partidos jugados de
     mayor a menor y se queda con los primeros TOP_N de
     cada nivel (2, 3, 4 y 5 restricciones acertadas).
     Como el recorrido va en orden descendente, esos
     primeros SON el top 10 por partidos.

     Va por tandas para no congelar la pantalla, y corta
     en cuanto tiene los cuatro niveles completos.
     ═══════════════════════════════════════════ */
  let _sortedDb = null;
  let _sortedDbSize = 0;

  function _sortedByApps() {
    const db = (typeof PLAYERS_DB !== 'undefined' && PLAYERS_DB) || [];
    if (_sortedDb && _sortedDbSize === db.length) return _sortedDb;
    _sortedDb     = [...db].sort((a, b) => (b.apps || 0) - (a.apps || 0));
    _sortedDbSize = db.length;
    return _sortedDb;
  }

  async function _findCandidates(restrictions, token) {
    const db = _sortedByApps();
    const buckets = { 2: [], 3: [], 4: [], 5: [] };
    if (!db.length || !restrictions.length) return buckets;

    const complete = () => [2, 3, 4, 5].every(k => buckets[k].length >= TOP_N);

    for (let i = 0; i < db.length; i += SCAN_CHUNK) {
      if (token !== _scanToken) return buckets;   // ronda cambiada o salimos

      const end = Math.min(i + SCAN_CHUNK, db.length);
      for (let j = i; j < end; j++) {
        const player = db[j];
        if (!player) continue;
        let count = 0;
        for (const r of restrictions) {
          if (Restrictions.validate(player, r)) count++;
        }
        if (count >= 2 && buckets[count] && buckets[count].length < TOP_N) {
          buckets[count].push(player);
        }
      }

      if (complete()) break;
      await new Promise(res => setTimeout(res, 0));   // ceder el hilo
    }

    console.log('[Bots] Candidatos por restricciones acertadas:',
      Object.entries(buckets).map(([k, v]) => `${k}→${v.length}`).join(' '));
    return buckets;
  }

  /* ═══════════════════════════════════════════
     CUÁNDO RESPONDE
     ═══════════════════════════════════════════ */
  function _answerDelayMs(roundSecs) {
    const secs = roundSecs || 60;

    if (secs >= SHORT_ROUND_SECS) {
      // Faltando entre 20 y 40 segundos para el final
      const remaining = BotCore.randInt(ANSWER_WINDOW[0], ANSWER_WINDOW[1]);
      return Math.max(1000, (secs - remaining) * 1000);
    }

    // Ronda corta (incluida la muerte súbita): tercio central
    return BotCore.randFloat(secs / 3, (secs * 2) / 3) * 1000;
  }

  /* ═══════════════════════════════════════════
     RONDA — programar la respuesta de cada bot

     ctx = { code, room, restrictions, roundSecs,
             isSuddenDeath, suddenDeathPlayers }
     ═══════════════════════════════════════════ */
  function onRound(ctx) {
    const { code, room, restrictions, roundSecs } = ctx || {};
    if (!code || !room || !room.isPublic) return;
    if (!Array.isArray(restrictions) || !restrictions.length) return;

    const roundKey = `${code}:${room.round}:${room.roundSeed}`;
    if (roundKey === _lastRoundKey) return;
    _lastRoundKey = roundKey;

    _timers.clear();
    const token = ++_scanToken;

    /* Los que ya han respondido esta ronda quedan fuera: si el host cambia
       a mitad, el nuevo reprograma solo a los que faltan. */
    const submissions = room.submissions || {};
    let bots = BotCore.split(room.players).bots.filter(([id]) => !submissions[id]);

    /* En muerte súbita solo juegan los empatados: si un bot
       responde sin estar convocado, descuadra el recuento de
       respuestas y el reveal saltaría antes de tiempo. */
    if (ctx.isSuddenDeath) {
      const allowed = ctx.suddenDeathPlayers || [];
      bots = bots.filter(([id]) => allowed.includes(id));
    }
    if (!bots.length) return;

    /* La búsqueda arranca ya y va en paralelo al reloj:
       cuando toque responder normalmente ya está lista. */
    const search = _findCandidates(restrictions, token)
      .catch(e => { console.warn('[Bots] búsqueda fallida:', e); return null; });

    const usedIds = new Set();   // para que dos bots no vayan al mismo

    for (const [botId, bot] of bots) {
      const delay = _answerDelayMs(roundSecs);
      console.log(`[Bots] ${bot.name} responde a los ${Math.round(delay / 1000)}s`);

      _timers.after(delay, async () => {
        if (token !== _scanToken) return;
        const buckets = await search;
        if (!buckets || token !== _scanToken) return;
        await _submit(code, botId, bot.name, buckets, usedIds);
      });
    }
  }

  /* ─── Elegir y enviar, esquivando los ya dichos ─── */
  async function _submit(code, botId, botName, buckets, usedIds) {
    const taken = new Set(usedIds);

    /* Nombres que ya han dicho los demás en esta ronda */
    try {
      const { db, ref, get } = window._FB;
      const snap = await get(ref(db, `${_roomPath(code)}/submissions`));
      if (snap.exists()) {
        for (const sub of Object.values(snap.val() || {})) {
          if (sub?.footballerId) taken.add(String(sub.footballerId));
          if (sub?.playerName)   taken.add(BotNames.norm(sub.playerName));
        }
      }
    } catch (e) { /* si falla la lectura, el candado de Firebase nos frena igual */ }

    const has5    = (buckets[5] || []).length > 0;
    const weights = has5 ? { ...WEIGHTS_WITH_5 } : { ...WEIGHTS_WITHOUT_5 };

    /* Solo entran en el sorteo los niveles con candidatos libres.
       pickWeighted normaliza, así que el reparto se reajusta solo
       ("lo que se pueda" cuando no hay de todo). */
    const free    = {};
    const freeList = {};
    for (const k of Object.keys(weights)) {
      const list = (buckets[k] || []).filter(
        p => !taken.has(String(p.id)) && !taken.has(BotNames.norm(p.name))
      );
      if (list.length) { free[k] = weights[k]; freeList[k] = list; }
    }

    const order = [];
    let level = BotCore.pickWeighted(free);
    while (level) {
      order.push(level);
      delete free[level];
      level = BotCore.pickWeighted(free);
    }

    /* Se intenta el nivel que ha salido; si el candado de Firebase
       dice que ese futbolista ya está cogido, se prueba otro del
       mismo nivel y, si se agota, se baja al siguiente nivel. */
    for (const k of order) {
      const candidates = BotCore.shuffle(freeList[k] || []);
      for (const player of candidates) {
        try {
          await Sync.submitAnswer(code, botId, player.name, player.id || null);
          usedIds.add(String(player.id));
          usedIds.add(BotNames.norm(player.name));
          console.log(`[Bots] ${botName} responde ${player.name} (${k} restricciones)`);
          return;
        } catch (e) {
          // Ya cogido por otro: probar con el siguiente
          taken.add(String(player.id));
        }
      }
    }

    console.warn(`[Bots] ${botName} se queda sin respuesta posible`);
  }

  /* ═══════════════════════════════════════════
     PARAR
     ═══════════════════════════════════════════ */
  function stop() {
    _timers.clear();
    _scanToken++;
    _lobbyBusy    = false;
    _lastRoundKey = null;
    _pendingAdds  = 0;
    _pendingNames.clear();
  }

  return { syncLobby, onRound, stop };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CocheBots;
}
