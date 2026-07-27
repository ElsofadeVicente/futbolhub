/* =============================================
   HUB-STREAKS.JS — Rachas 🔥 de los juegos diarios
   QUIÉN COÑO FALTA

   Lee el progreso diario de cada juego en localStorage
   (que js/progress-sync.js mantiene igual en todos tus
   dispositivos) y pinta un círculo con la racha —días
   seguidos ganados— en la esquina superior izquierda de
   su tarjeta del hub.

   Claves que lee (escritas por cada juego):
     La Carrera   → carrera_day_YYYY-MM-DD  {won}
     Crucigrama   → cruc_YYYYMMDD           {completed, clean}
     En el Top    → enteltop_day_YYYY-MM-DD {score}
     En el Once   → oncediario_YYYYMMDD     {matchStats:{guessed}}
     El Estadio   → estadio_daily_YYYY-MM-DD {total}   (racha de días jugados)

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

  /* Hoy en hora local (crucigrama y el estadio guardan con fecha local) */
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

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
      today: localToday,
      stateFor(day) {
        const s = readJSON(`cruc_${day.replace(/-/g, '')}`);
        if (!s || !s.completed) return null;
        return s.clean === false ? 'loss' : 'win';   // con ayudas no cuenta como victoria
      },
      detailFor(day) {
        const s = readJSON(`cruc_${day.replace(/-/g, '')}`);
        if (!s || !s.completed) return null;
        return s.clean === false ? 'Completado con ayudas' : 'Completado sin ayudas';
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
      stateFor(day) {
        const s = readJSON(`oncediario_${day.replace(/-/g, '')}`);
        if (!s || !s.matchStats) return null;
        return s.matchStats.guessed === 11 ? 'win' : 'loss';
      },
      detailFor(day) {
        const s = readJSON(`oncediario_${day.replace(/-/g, '')}`);
        if (!s || !s.matchStats) return null;
        return `${s.matchStats.guessed} de 11`;
      },
    },
    {
      href: 'el-estadio',
      label: 'El Estadio',
      today: localToday,
      stateFor(day) {
        const s = readJSON(`estadio_daily_${day}`);
        return s ? 'win' : null;   // racha de días jugados
      },
      detailFor(day) {
        const s = readJSON(`estadio_daily_${day}`);
        if (!s) return null;
        return typeof s.total === 'number' ? `${s.total.toLocaleString('es-ES')} puntos` : 'Jugado';
      },
    },
  ];

  /* Racha: días consecutivos ganados terminando hoy.
     Si HOY aún no se ha jugado, la racha de ayer sigue "viva" y se muestra.
     Si HOY se jugó y se perdió, la racha es 0 (sin badge). */
  function computeStreak(game) {
    const today = game.today();
    const t = game.stateFor(today);
    if (t === 'loss') return 0;

    let streak = (t === 'win') ? 1 : 0;
    let day = shiftDays(today, -1);
    for (let i = 0; i < 400; i++) {
      if (game.stateFor(day) === 'win') { streak++; day = shiftDays(day, -1); }
      else break;
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
      const streak = computeStreak(game);
      let badge = card.querySelector('.hub-streak-badge');
      /* Sin racha, fuera el círculo: al bajar el progreso de la cuenta
         (js/progress-sync.js) esto se repinta, y una racha que ya no
         existe no puede quedarse pegada de la pasada anterior. */
      if (streak < 1) { if (badge) badge.remove(); continue; }
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'hub-streak-badge';
        card.appendChild(badge);
      }
      badge.title = `Racha: ${streak} día${streak !== 1 ? 's' : ''} seguido${streak !== 1 ? 's' : ''}`;
      badge.innerHTML = `<span>${streak}</span><span class="hs-fire">🔥</span>`;
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
