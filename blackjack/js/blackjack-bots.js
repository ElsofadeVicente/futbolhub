/* =============================================
   BLACKJACK-BOTS.JS
   Jugadores automáticos de las salas públicas.

   Corren en el cliente que sea host de la sala: es el
   mismo cliente que ya genera los sets y dispara el
   reveal, así que si el host se cae y otro jugador es
   promovido, los bots pasan con él sin más (el failover
   de host ya existente hace todo el trabajo).

   CÓMO ELIGE SU JUGADA
   Con 10 cartas hay 1024 subconjuntos posibles. Repartir
   uniformemente entre ellos sería justo lo que delataría
   al bot: la mayoría de subconjuntos al azar dan totales
   absurdos, y una persona siempre orbita el objetivo.
   Por eso el sorteo es por CALIDAD del resultado, no por
   combinación: primero se sortea la banda y luego una
   combinación cualquiera dentro de esa banda.

     exacto (blackjack) ........................  3 %
     el más cercano sin pasarse ................  1 %
     el segundo más cercano sin pasarse ........  1 %
     el más cercano pasándose ..................  1 %
     el segundo más cercano pasándose ..........  1 %
     A  sin pasarse, 3º-6º más cercano .........  9,03 %
     B  sin pasarse, ≥85 % del objetivo ........  6,32 %
     C  sin pasarse, ≥65 % .....................  27,09 %
     D  sin pasarse, por debajo del 65 % .......  20,77 %
     E  pasándose por poco (hasta +10 %) .......  13,54 %
     F  pasándose claro ........................  16,25 %

   Los porcentajes de A-F salen de los pesos crudos de
   BAND_WEIGHTS (10/7/30/23/15/18), normalizados para que
   sumen el 93 % que queda libre. Se pueden cambiar los
   pesos a ojo y el reparto se reajusta solo.

   Si una banda no existe en un set concreto (p. ej. no
   hay combinación exacta), su peso se reparte solo entre
   las que sí existen.
   ============================================= */

const BlackjackBots = (() => {

  /* ─── Reparto fijo (en % absolutos) ─── */
  const FIXED_WEIGHTS = {
    exact: 3,   // blackjack
    near1: 1,   // más cercano sin pasarse
    near2: 1,   // segundo más cercano sin pasarse
    over1: 1,   // más cercano pasándose
    over2: 1,   // segundo más cercano pasándose
  };

  /* ─── Reparto del resto (pesos crudos, se normalizan) ─── */
  const BAND_WEIGHTS = { A: 10, B: 7, C: 30, D: 23, E: 15, F: 18 };

  const FIXED_TOTAL = Object.values(FIXED_WEIGHTS).reduce((a, b) => a + b, 0);  // 7
  const REST_TOTAL  = 100 - FIXED_TOTAL;                                        // 93

  /* Umbrales de las bandas por cercanía al objetivo */
  const B_MIN_FRACTION    = 0.85;   // banda B: del 85 % del objetivo para arriba
  const C_MIN_FRACTION    = 0.65;   // banda C: del 65 % para arriba
  const E_MAX_OVERSHOOT   = 1.10;   // banda E: pasarse como mucho un 10 %

  /* ─── Ritmo humano al pasar las cartas ───
     Una ronda de Blackjack la resuelve una persona en pocos segundos, así que
     los tiempos son cortos: el bot no debe tener al resto esperando. El techo
     es bajo a propósito (nadie mira 10 cartas durante 45s). */
  const CARD_MS_MIN       = 350;
  const CARD_MS_MAX       = 1300;
  const LONG_THINK_CHANCE = 0.10;
  const LONG_MS_MIN       = 1800;
  const LONG_MS_MAX       = 3200;
  const FIRST_CARD_MS     = [300, 1100];
  const MAX_ROUND_MS      = 16000;  // techo para no dejar colgados a los humanos
  const REPORT_RETRIES    = 3;      // reintentos del reporte para no colgar la ronda

  /* Al clavar o rozar el objetivo, ¿se planta antes de ver el resto? */
  const STAND_CHANCE_CLOSE = 0.8;   // si va por encima del 90 % del objetivo
  const STAND_CHANCE_FAR   = 0.25;

  /* ─── Estado del módulo ─── */
  const _timers      = BotCore.createTimers();
  let   _lobbyBusy   = false;   // hay un alta/baja de bot en vuelo
  let   _lastRoundKey = null;   // evita programar dos veces la misma ronda
  let   _pendingAdds  = 0;      // altas de bot programadas pero aún sin escribir
  const _pendingNames = new Set();  // nombres ya reservados por esas altas

  /* ═══════════════════════════════════════════
     PESOS NORMALIZADOS DE LAS BANDAS
     ═══════════════════════════════════════════ */
  function _normalizedBandWeights() {
    const raw   = Object.values(BAND_WEIGHTS).reduce((a, b) => a + b, 0);
    const scale = raw > 0 ? REST_TOTAL / raw : 0;
    const out   = {};
    for (const [k, w] of Object.entries(BAND_WEIGHTS)) out[k] = w * scale;
    return out;
  }

  /* ═══════════════════════════════════════════
     CLASIFICAR LAS 1024 COMBINACIONES EN BANDAS

     Se agrupa por TOTAL, no por combinación: si tres
     subconjuntos distintos suman lo mismo son "la misma
     posibilidad" y deben contar una sola vez.
     ═══════════════════════════════════════════ */
  function _buildBands(values, objective) {
    const n = values.length;
    if (!n || !objective) return null;

    /* total → lista de máscaras que lo producen */
    const byTotal = new Map();
    for (let mask = 1; mask < (1 << n); mask++) {   // mask 0 = no coger nada: descartado
      let total = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) total += values[i];
      if (!byTotal.has(total)) byTotal.set(total, []);
      byTotal.get(total).push(mask);
    }

    const totals  = [...byTotal.keys()];
    const noBust  = totals.filter(t => t <= objective).sort((a, b) => b - a);  // más cercano primero
    const busted  = totals.filter(t => t >  objective).sort((a, b) => a - b);  // pasarse menos primero

    const bands = { exact: [], near1: [], near2: [], over1: [], over2: [],
                    A: [], B: [], C: [], D: [], E: [], F: [] };

    /* ── Sin pasarse ── */
    const exactIdx = noBust.indexOf(objective);
    if (exactIdx !== -1) bands.exact.push(objective);
    const rest = noBust.filter(t => t !== objective);

    if (rest.length > 0) bands.near1.push(rest[0]);
    if (rest.length > 1) bands.near2.push(rest[1]);
    bands.A = rest.slice(2, 6);                       // 3º a 6º más cercano

    for (const t of rest.slice(6)) {
      if (t >= objective * B_MIN_FRACTION)      bands.B.push(t);
      else if (t >= objective * C_MIN_FRACTION) bands.C.push(t);
      else                                      bands.D.push(t);
    }

    /* ── Pasándose ── */
    if (busted.length > 0) bands.over1.push(busted[0]);
    if (busted.length > 1) bands.over2.push(busted[1]);
    for (const t of busted.slice(2)) {
      if (t <= objective * E_MAX_OVERSHOOT) bands.E.push(t);
      else                                  bands.F.push(t);
    }

    return { bands, byTotal };
  }

  /* ═══════════════════════════════════════════
     ELEGIR LA JUGADA DE UN BOT
     Devuelve { picked:[índices], total, bust }
     ═══════════════════════════════════════════ */
  function chooseHand(setPlayers, objective) {
    const values = setPlayers.map(p => p?._value || 0);
    const built  = _buildBands(values, objective);

    if (!built) return _fallbackHand(values, objective);

    const { bands, byTotal } = built;

    /* Solo entran en el sorteo las bandas que existen en
       este set: el peso de las vacías se reparte solo. */
    const weights   = { ...FIXED_WEIGHTS, ..._normalizedBandWeights() };
    const available = {};
    for (const [name, w] of Object.entries(weights)) {
      if (bands[name] && bands[name].length) available[name] = w;
    }

    const bandName = BotCore.pickWeighted(available);
    if (!bandName) return _fallbackHand(values, objective);

    const total = BotCore.pickOne(bands[bandName]);
    const mask  = BotCore.pickOne(byTotal.get(total));

    const picked = [];
    for (let i = 0; i < values.length; i++) if (mask & (1 << i)) picked.push(i);

    return { picked, total, bust: total > objective, band: bandName };
  }

  /* Red de seguridad: si algo falla, coger cartas al azar
     hasta acercarse al objetivo. Nunca debería usarse. */
  function _fallbackHand(values, objective) {
    const order  = BotCore.shuffle(values.map((_, i) => i));
    const picked = [];
    let total = 0;
    for (const i of order) {
      if (total + values[i] > objective) continue;
      picked.push(i);
      total += values[i];
      if (total >= objective * 0.8) break;
    }
    if (!picked.length && order.length) { picked.push(order[0]); total = values[order[0]]; }
    return { picked, total, bust: total > objective, band: 'fallback' };
  }

  /* ═══════════════════════════════════════════
     RITMO: CUÁNTO TARDA EN TERMINAR LA RONDA

     Un bot que se pasa NO puede plantarse (el juego se lo
     impide igual que a una persona), así que se traga las
     10 cartas. Uno que no se pasa puede plantarse en cuanto
     ha cogido su última carta.
     ═══════════════════════════════════════════ */
  function _planTiming(hand, cardOrder, objective) {
    const totalCards = cardOrder.length;

    /* Posición, dentro del orden personal del bot, de la
       última carta que coge */
    let lastPickPos = -1;
    hand.picked.forEach(cardIdx => {
      const pos = cardOrder.indexOf(cardIdx);
      if (pos > lastPickPos) lastPickPos = pos;
    });

    let standing = false;
    let cardsSeen = totalCards;

    if (!hand.bust && lastPickPos >= 0 && lastPickPos < totalCards - 1) {
      const close  = objective > 0 && hand.total >= objective * 0.9;
      const chance = close ? STAND_CHANCE_CLOSE : STAND_CHANCE_FAR;
      if (BotCore.rand() < chance) {
        standing  = true;
        cardsSeen = lastPickPos + 1;
      }
    }

    let ms = BotCore.randFloat(FIRST_CARD_MS[0], FIRST_CARD_MS[1]);
    for (let i = 0; i < cardsSeen; i++) {
      ms += (BotCore.rand() < LONG_THINK_CHANCE)
        ? BotCore.randFloat(LONG_MS_MIN, LONG_MS_MAX)
        : BotCore.randFloat(CARD_MS_MIN, CARD_MS_MAX);
    }

    return { standing, delayMs: Math.min(ms, MAX_ROUND_MS) };
  }

  /* ═══════════════════════════════════════════
     LOBBY — mantener el número de bots que toca
     Solo la llama el host y solo en salas públicas.
     ═══════════════════════════════════════════ */
  async function syncLobby(room, code) {
    if (!room || !code || !room.isPublic) return;
    if (room.status !== 'waiting') return;
    if (_lobbyBusy) return;

    const names = await BotNames.load();
    if (!names.length) return;   // sin nombres no hay bots

    const { humans, bots } = BotCore.split(room.players);
    const want = BotCore.desiredBotCount(humans.length);

    // Contar las altas ya programadas pero aún sin escribir, para no volver a
    // programar las mismas: syncLobby corre en cada actualización de sala y
    // sin esto dos llamadas seguidas meterían bots de más (o repetidos).
    const effective = bots.length + _pendingAdds;
    if (want === effective) return;

    _lobbyBusy = true;
    try {
      if (want > effective) {
        await _addBots(code, want - effective, room);
      } else if (want < bots.length) {
        await _removeBots(code, bots, bots.length - want);
      }
    } catch (e) {
      console.warn('[Bots] syncLobby error:', e);
    } finally {
      _lobbyBusy = false;
    }
  }

  async function _addBots(code, count, room) {
    const { db, ref, get, update } = window._FB;

    // Excluir tanto a los presentes como a los nombres ya reservados por altas
    // en vuelo, para que dos altas solapadas no elijan el mismo nombre.
    const taken = Object.values(room.players || {}).map(p => p.name).concat([..._pendingNames]);
    const picks = BotNames.pick(count, taken);
    if (!picks.length) return;

    for (let i = 0; i < picks.length; i++) {
      /* Escalonado: entran de uno en uno con unos segundos
         de diferencia, como entraría gente de verdad. */
      const delay = BotCore.randFloat(1800, 5200) + i * BotCore.randFloat(2500, 6000);

      // Reservar la plaza y el nombre hasta que el alta se resuelva
      _pendingAdds++;
      _pendingNames.add(BotNames.norm(picks[i]));

      _timers.after(delay, async () => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          _pendingAdds = Math.max(0, _pendingAdds - 1);
          _pendingNames.delete(BotNames.norm(picks[i]));
        };
        try {
          /* Releer la sala: en estos segundos puede haber entrado
             o salido gente y el cupo ya no ser el mismo. */
          const snap = await get(ref(db, `blackjack/rooms/${code}`));
          if (!snap.exists()) return;
          const fresh = snap.val();
          if (fresh.status !== 'waiting' || !fresh.isPublic) return;

          const s = BotCore.split(fresh.players);
          if (s.bots.length + (_pendingAdds - 1) >= BotCore.desiredBotCount(s.humans.length)) return;
          if (Object.keys(fresh.players || {}).length >= 6) return;

          const already = Object.values(fresh.players || {}).map(p => BotNames.norm(p.name));
          if (already.includes(BotNames.norm(picks[i]))) return;

          const botId = BotCore.genBotId();
          await update(ref(db, `blackjack/rooms/${code}/players/${botId}`), {
            name:      picks[i],
            avatar:    null,      // sin foto: se pinta la inicial, como cualquier cuenta sin avatar
            score:     0,
            connected: true,
            isHost:    false,
            isBot:     true,
          });
          console.log('[Bots] Añadido', picks[i]);
        } catch (e) {
          console.warn('[Bots] alta fallida:', e);
        } finally {
          release();
        }
      });
    }
  }

  async function _removeBots(code, bots, count) {
    const { db, ref, get, remove } = window._FB;

    /* Se van los últimos en entrar */
    const victims = bots.slice(-count);

    victims.forEach(([botId], i) => {
      const delay = BotCore.randFloat(3000, 8000) + i * BotCore.randFloat(1500, 4000);

      _timers.after(delay, async () => {
        try {
          const snap = await get(ref(db, `blackjack/rooms/${code}`));
          if (!snap.exists()) return;
          const fresh = snap.val();
          if (fresh.status !== 'waiting') return;
          if (!fresh.players?.[botId]) return;

          const s = BotCore.split(fresh.players);
          /* Solo se va si de verdad sobra Y la sala aguanta sin él:
             nunca se deja el lobby por debajo de dos jugadores. */
          if (s.bots.length <= BotCore.desiredBotCount(s.humans.length)) return;
          if (s.humans.length + s.bots.length <= 2) return;

          await remove(ref(db, `blackjack/rooms/${code}/players/${botId}`));
          console.log('[Bots] Se marcha', fresh.players[botId].name);
        } catch (e) {
          console.warn('[Bots] baja fallida:', e);
        }
      });
    });
  }

  /* ═══════════════════════════════════════════
     RONDA — programar la jugada de cada bot
     setPlayers deben venir ya con _value resuelto.
     ═══════════════════════════════════════════ */
  function onRound(code, room, setPlayers) {
    if (!code || !room || !room.isPublic) return;
    if (!Array.isArray(setPlayers) || !setPlayers.length) return;

    const roundKey = `${code}:${room.round}:${room.setSeed}`;
    if (roundKey === _lastRoundKey) return;
    _lastRoundKey = roundKey;

    _timers.clear();

    const { bots } = BotCore.split(room.players);
    if (!bots.length) return;

    const objective = room.objective || 0;
    const decisions = room.decisions || {};

    for (const [botId] of bots) {
      if (decisions[botId]) continue;   // ya jugó esta ronda

      const hand      = chooseHand(setPlayers, objective);
      const cardOrder = BlackjackSets.getPlayerOrder(room.setSeed, botId, setPlayers);
      const timing    = _planTiming(hand, cardOrder, objective);

      console.log(`[Bots] ${room.players[botId].name}: banda ${hand.band}, ` +
                  `total ${hand.total}/${objective}, responde en ${Math.round(timing.delayMs / 1000)}s`);

      _timers.after(timing.delayMs, () => {
        _reportWithRetry(code, botId, {
          picked:   hand.picked,
          bust:     hand.bust,
          standing: timing.standing,
        }, REPORT_RETRIES);
      });
    }
  }

  /* Reporta la jugada reintentando: si el reporte de un bot fallara y no
     quedara registrado, la ronda se colgaría (su plaza cuenta para el reveal
     pero nunca llega su doneCount). El watchdog del host es la última red,
     pero reintentar aquí evita llegar a ese extremo. */
  async function _reportWithRetry(code, botId, handData, attemptsLeft) {
    try {
      await BlackjackSync.reportDone(code, botId, handData);
    } catch (e) {
      console.warn(`[Bots] reportDone fallido (quedan ${attemptsLeft - 1}):`, e);
      if (attemptsLeft > 1) {
        _timers.after(BotCore.randFloat(800, 1600), () =>
          _reportWithRetry(code, botId, handData, attemptsLeft - 1));
      }
    }
  }

  /* ═══════════════════════════════════════════
     PARAR (salir de la sala, reveal, fin de partida)
     ═══════════════════════════════════════════ */
  function stop() {
    _timers.clear();
    _lobbyBusy    = false;
    _lastRoundKey = null;
    _pendingAdds  = 0;
    _pendingNames.clear();
  }

  return { syncLobby, onRound, stop, chooseHand };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlackjackBots;
}
