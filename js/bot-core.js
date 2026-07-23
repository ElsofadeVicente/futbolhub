/* =============================================
   BOT-CORE.JS
   Piezas comunes a los bots de todos los juegos.
   Lo específico de cada juego (cómo decide su jugada)
   vive en el archivo de bots de ese juego.

   Reglas de la casa:
     · Solo en salas públicas.
     · 1 humano  → 2 bots
       2-3 humanos → 1 bot
       4+ humanos → 0 bots
     · El número se recalcula en el lobby y se congela
       al empezar la partida: no se añaden ni se quitan
       bots con la partida en marcha.
     · Los bots nunca son host.
   ============================================= */

const BotCore = (() => {

  /* ═══════════════════════════════════════════
     CUÁNTOS BOTS TOCAN
     ═══════════════════════════════════════════ */
  function desiredBotCount(humanCount) {
    if (humanCount <= 0) return 0;   // sala sin humanos: que se muera sola
    if (humanCount === 1) return 2;
    if (humanCount <= 3) return 1;
    return 0;
  }

  /* ═══════════════════════════════════════════
     IDENTIFICACIÓN
     ═══════════════════════════════════════════ */
  const isBot = (p) => !!(p && p.isBot);

  /* Separa el objeto players de la sala en humanos y bots.
     Los desconectados no cuentan como humanos presentes. */
  function split(players) {
    const humans = [];
    const bots   = [];
    for (const [id, p] of Object.entries(players || {})) {
      if (!p) continue;
      if (isBot(p)) bots.push([id, p]);
      else if (p.connected !== false) humans.push([id, p]);
    }
    return { humans, bots };
  }

  /* Id con la misma pinta que el de un jugador normal
     (mismo formato que los _genId de los juegos). */
  function genBotId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /* ═══════════════════════════════════════════
     AZAR
     ═══════════════════════════════════════════ */
  const rand      = () => Math.random();
  const randFloat = (min, max) => min + Math.random() * (max - min);
  const randInt   = (min, max) => Math.floor(randFloat(min, max + 1));

  function pickOne(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* Elige una clave de un objeto {clave: peso}.
     Los pesos se normalizan solos, así que se pueden pasar
     únicamente las opciones que de verdad existen y el
     reparto se reajusta entre ellas sin tocar nada más. */
  function pickWeighted(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    if (!entries.length) return null;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [key, w] of entries) {
      r -= w;
      if (r <= 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  /* ═══════════════════════════════════════════
     TEMPORIZADORES
     Registro central para poder cancelarlos todos
     de golpe al salir de la sala o cambiar de ronda.
     ═══════════════════════════════════════════ */
  function createTimers() {
    let ids = [];
    return {
      after(ms, fn) {
        const id = setTimeout(() => {
          ids = ids.filter(x => x !== id);
          fn();
        }, Math.max(0, ms));
        ids.push(id);
        return id;
      },
      clear() {
        ids.forEach(clearTimeout);
        ids = [];
      },
    };
  }

  return {
    desiredBotCount,
    isBot,
    split,
    genBotId,
    rand,
    randFloat,
    randInt,
    pickOne,
    shuffle,
    pickWeighted,
    createTimers,
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BotCore;
}
