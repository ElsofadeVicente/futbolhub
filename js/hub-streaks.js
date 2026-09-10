/* =============================================
   HUB-STREAKS.JS — Rachas 🔥 de los juegos diarios
   QUIÉN COÑO FALTA

   Lee el progreso diario de cada juego en localStorage
   (que js/progress-sync.js mantiene igual en todos tus
   dispositivos) y pinta un círculo con la racha —partidas
   seguidas ganadas— en la esquina superior izquierda de
   su tarjeta del hub.

   La racha va POR INTENTO: se rompe al perder o al dejar
   la partida a medias, NO por saltarse un día sin jugar.

   Claves que lee (escritas por cada juego):
     La Carrera   → carrera_day_YYYY-MM-DD  {won}
     Crucigrama   → cruc_YYYYMMDD           {completed, clean}
     En el Top    → enteltop_day_YYYY-MM-DD {score}
     En el Once   → oncediario_YYYYMMDD     {matchStats:{guessed}, completed}
     El Estadio   → estadio_daily_YYYY-MM-DD {total}   (racha de días jugados)
     Wordle       → wordle_day_YYYY-MM-DD   {completed, won}
     Bingo        → bingo_day_YYYY-MM-DD    {hits, bingo, completed}
     Tres en Raya → tresenraya_day_YYYY-MM-DD {hits, completed}

   Fuera del hub no hay tarjetas que pintar, pero el archivo
   se carga igual porque expone window.FHStreaks, que usa el
   perfil (js/profile-widget.js) para enseñar la racha y lo
   jugado hoy:
     FHStreaks.list()  → [{href, label, streak, today}]
                          today = {state:'win'|'loss', detail:'…'} | null
   ============================================= */
(function () {
  'use strict';

  /* ── Fechas ── */
  function pad(n) { return String(n).padStart(2, '0'); }

  /* Hoy en hora de Madrid (los diarios usan Europe/Madrid) → "YYYY-MM-DD" */
  function madridToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  }

  /* Antes había un localToday() aparte porque el Crucigrama y El Estadio
     guardaban con la fecha del dispositivo. Ya no: los seis diarios usan
     hora de Madrid, así que el día cambia a la vez en todos y la racha no
     se rompe por jugar desde otro huso. */

  /* Resta días a un "YYYY-MM-DD" (aritmética de calendario, sin husos) */
  function shiftDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /* ── Estado de un día por juego: 'win' | 'loss' | null (no jugado) ── */
  const GAMES = [
    {
      href: 'la-carrera',
      label: 'La Carrera',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`carrera_day_${day}`);
        if (!s || typeof s.won !== 'boolean') return null;
        return s.won ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`carrera_day_${day}`);
        if (!s || typeof s.won !== 'boolean') return null;
        return s.won ? 'Acertado' : 'Fallado';
      },
    },
    {
      href: 'crucigrama',
      label: 'Crucigrama',
      /* Dejó de ser diario el 2026-09-09: ahora son 190 niveles, así que no
         hay racha que contar. En su sitio va el total de estrellas, que es el
         número que sube y que da pena dejar parado — la misma función que
         cumplía la racha, con el mismo círculo y en el mismo sitio. */
      contador() {
        let t = 0;
        for (let n = 1; n <= 190; n++) {
          const v = parseInt(localStorage.getItem('crucniv_' + n), 10);
          if (Number.isFinite(v)) t += Math.max(0, Math.min(3, v));
        }
        if (!t) return null;
        return { valor: t, icono: '⭐',
                 titulo: t + ' estrella' + (t !== 1 ? 's' : '') + ' de 570' };
      },
    },
    {
      href: 'en-el-top',
      label: 'En el Top',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`enteltop_day_${day}`);
        if (!s || typeof s.score !== 'number') return null;
        return s.score === 10 ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`enteltop_day_${day}`);
        if (!s || typeof s.score !== 'number') return null;
        return `${s.score} de 10`;
      },
    },
    {
      href: 'en-el-once',
      label: 'En el Once',
      today: madridToday,
      /* completed:false = partida en curso (o dejada a medias, que en la
         práctica es lo mismo hasta que se retoma). Antes esto se leía como
         "no jugado" y no rompía la racha; ahora un intento real la rompe ya,
         y solo se recupera completando el once entero. */
      stateFor(day) {
        const s = readJSON(`oncediario_${day.replace(/-/g, '')}`);
        if (!s || !s.matchStats) return null;
        return (s.completed !== false && s.matchStats.guessed === 11) ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`oncediario_${day.replace(/-/g, '')}`);
        if (!s || !s.matchStats) return null;
        if (s.completed === false) return `${s.matchStats.guessed} de 11 (en curso)`;
        return `${s.matchStats.guessed} de 11`;
      },
    },
    {
      href: 'el-estadio',
      label: 'El Estadio',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`estadio_daily_${day}`);
        // Una partida a medias (completed:false) aún no cuenta como día
        // jugado — mismo criterio que En el Once.
        return (s && s.completed !== false) ? 'win' : null;   // racha de días jugados
      },
      detailFor(day) {
        const s = readJSON(`estadio_daily_${day}`);
        if (!s) return null;
        if (s.completed === false) {
          const n = Array.isArray(s.scores) ? s.scores.length : 0;
          /* El total sale del propio guardado, no de un 5 escrito a mano:
             El Estadio paso de 5 rondas a 4 el 2026-09-06 y las partidas
             viejas siguen teniendo 5. */
          const tot = Array.isArray(s.rondas) ? s.rondas.length : 4;
          return `${n} de ${tot} rondas (en curso)`;
        }
        return typeof s.total === 'number' ? `${s.total.toLocaleString('es-ES')} puntos` : 'Jugado';
      },
    },
    {
      /* Superdraft no se gana ni se pierde: se saca una puntuación contra un
         objetivo del día. Como El Estadio, la racha es de días jugados. */
      href: 'superdraft',
      label: 'Superdraft',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`superdraft_day_${day}`);
        return s ? 'win' : null;
      },
      detailFor(day) {
        const s = readJSON(`superdraft_day_${day}`);
        if (!s) return null;
        if (typeof s.total !== 'number') return 'Jugado';
        return `${s.total.toLocaleString('es-ES')} ${s.unit || ''}`.trim();
      },
    },
    {
      /* Bingo: el carton del dia. «Ganar» no es el bingo entero (16/16, que
         casi no lo hace nadie) sino cerrar UMBRAL de las 16 — el mismo
         criterio que usa el propio juego. El BINGO sigue siendo el 16/16 y
         se cuenta aparte, en el record. */
      href: 'bingo',
      label: 'Bingo',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`bingo_day_${day}`);
        if (!s || typeof s.hits !== 'number') return null;
        return (s.completed !== false && s.hits >= 12) ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`bingo_day_${day}`);
        if (!s || typeof s.hits !== 'number') return null;
        return s.bingo ? '¡BINGO! 16 de 16' : `${s.hits} de 16`;
      },
    },
    {
      href: 'tres-en-raya',
      label: 'Tres en Raya',
      today: madridToday,
      stateFor(day) {
        const s = readJSON(`tresenraya_day_${day}`);
        if (!s || typeof s.hits !== 'number') return null;
        return (s.completed !== false && s.hits >= 6) ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`tresenraya_day_${day}`);
        if (!s || typeof s.hits !== 'number') return null;
        return `${s.hits} de 9`;
      },
    },
    {
      href: 'wordle',
      label: 'Wordle',
      today: madridToday,
      /* Se guarda tras CADA intento (writeJSON en submitGuess), completed
         solo al final. Un intento sin acabar la palabra ya rompe la racha. */
      stateFor(day) {
        const s = readJSON(`wordle_day_${day}`);
        if (!s || !Array.isArray(s.guesses) || !s.guesses.length) return null;
        return (s.completed && s.won) ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`wordle_day_${day}`);
        if (!s || !Array.isArray(s.guesses) || !s.guesses.length) return null;
        if (!s.completed) return `${s.guesses.length}/6 (en curso)`;
        return s.won ? `Acertado en ${s.guesses.length}/6` : 'Fallado';
      },
    },
  ];

  /* Racha POR INTENTO, no por días de calendario (decisión del usuario,
     2026-08-25). La racha cuenta las partidas seguidas ganadas: un día que
     NO se juega no la rompe —te vas de fin de semana y sigue viva—, y solo
     la corta perder o dejar la partida sin completar.

     O sea que al retroceder por el calendario los días sin jugar se SALTAN
     (state === null) en vez de cortar el bucle, que es lo que hacía antes.
     Se miran 400 días hacia atrás, que es lo que conserva progress-sync. */
  function computeStreak(game) {
    const today = game.today();
    const t = game.stateFor(today);
    if (t === 'loss') return 0;

    let streak = (t === 'win') ? 1 : 0;
    let day = shiftDays(today, -1);
    for (let i = 0; i < 400; i++) {
      const st = game.stateFor(day);
      if (st === 'loss') break;      // fallar SÍ rompe la racha
      if (st === 'win') streak++;    // ganar la alarga
      day = shiftDays(day, -1);      // no jugar no cuenta ni para bien ni para mal
    }
    return streak;
  }

  /* ── Render ── */
  function injectStyles() {
    if (document.getElementById('hub-streak-style')) return;
    const st = document.createElement('style');
    st.id = 'hub-streak-style';
    st.textContent = `
      .np-card { position: relative; }
      .hub-streak-badge {
        position: absolute;
        top: 8px; left: 8px;
        z-index: 5;
        display: flex; align-items: center; justify-content: center;
        gap: 1px;
        min-width: 34px; height: 34px;
        padding: 0 7px;
        border-radius: 999px;
        background: #16181d;
        border: 2px solid #e8c96a;
        color: #ffce54;
        font-family: 'Bebas Neue','Rajdhani',sans-serif;
        font-size: 0.95rem;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 6px rgba(0,0,0,.45);
        pointer-events: none;
      }
      .hub-streak-badge .hs-fire { font-size: 0.85rem; }
    `;
    document.head.appendChild(st);
  }

  function render() {
    injectStyles();
    for (const game of GAMES) {
      const card = document.querySelector(`a.np-card[href*="${game.href}"]`);
      if (!card) continue;
      /* Dos tipos de insignia en el mismo círculo: la racha de los diarios y
         el contador de los que van por niveles. */
      const dato = game.contador
        ? game.contador()
        : (() => {
            const n = computeStreak(game);
            return n < 1 ? null : {
              valor: n, icono: '🔥',
              titulo: 'Racha: ' + n + ' partida' + (n !== 1 ? 's' : '')
                    + ' seguida' + (n !== 1 ? 's' : '') + ' sin fallar'
                    + ' (no jugar un día no la rompe)' };
          })();
      let badge = card.querySelector('.hub-streak-badge');
      /* Sin nada que enseñar, fuera el círculo: al bajar el progreso de la
         cuenta (js/progress-sync.js) esto se repinta, y una racha que ya no
         existe no puede quedarse pegada de la pasada anterior. */
      if (!dato) { if (badge) badge.remove(); continue; }
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'hub-streak-badge';
        card.appendChild(badge);
      }
      badge.title = dato.titulo;
      badge.innerHTML = '<span>' + dato.valor + '</span><span class="hs-fire">' + dato.icono + '</span>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }

  /* El progreso de la cuenta llega por red, después de pintar: cuando
     baja (o cambia al entrar/salir de la sesión) hay que repintar. */
  window.addEventListener('fh-progress', render);

  /* ── API para el resto de la web (el perfil la usa) ── */
  window.FHStreaks = {
    list() {
      return GAMES.map(game => {
        const day    = game.today();
        const state  = game.stateFor(day);
        const detail = state ? (game.detailFor ? game.detailFor(day) : null) : null;
        return {
          href:   game.href,
          label:  game.label,
          streak: computeStreak(game),
          today:  state ? { state, detail } : null,
        };
      });
    },
  };
})();
