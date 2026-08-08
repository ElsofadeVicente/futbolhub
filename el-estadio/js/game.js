/* =============================================
   EL ESTADIO — game.js
   FutbolHUB
   ============================================= */

'use strict';

/* ── Firebase config ── */
const FB_URL = 'https://futbolhub-9d0a4-default-rtdb.europe-west1.firebasedatabase.app';

/* ── Constantes ── */
const TOTAL_RONDAS   = 5;
const MAX_SCORE      = 5000;
const DECAY_KM       = 500;   // puntuación cae 63% cada 500 km
const PERFECT_M      = 100;   // metros para puntuación perfecta

/* ══════════════════════════════════════════════
   ESTADO
   ══════════════════════════════════════════════ */
let state = {
  estadios:    [],   // todos los estadios cargados
  rondas:      [],   // los 5 del día [{ id, name, coord }]
  rondaActual: 0,    // índice 0-4
  scores:      [],   // puntuaciones por ronda
  guesses:     [],   // { lat, lng } por ronda
  guess:       null, // guess de la ronda actual { lat, lng }
  uid:         null,
};

/* ══════════════════════════════════════════════
   UTILIDADES
   ══════════════════════════════════════════════ */

/* Seed determinístico por fecha */
function dateToSeed(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  return dateStr.split('-').reduce((acc, n) => acc * 100 + parseInt(n), 0);
}

function seededRandom(seed) {
  // xorshift32
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296);
  };
}

function shuffleSeeded(arr, seed) {
  const rand = seededRandom(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Hoy en hora de MADRID, no en la del dispositivo.
   Antes esto usaba la fecha local: para quien juega desde México o desde
   Japón el día "cambiaba" a una hora distinta que en La Carrera, En el Top
   o En el Once (que sí van por Madrid), así que el estadio del día no
   coincidía con el resto de diarios y la racha del hub se partía sola. */
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid'
  }).format(new Date()); // "YYYY-MM-DD"
}

/* Distancia Haversine en km */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* Puntuación: 5000 si < 100m, decay exponencial a partir de ahí */
function calcScore(distKm) {
  if (distKm * 1000 < PERFECT_M) return MAX_SCORE;
  return Math.max(0, Math.round(MAX_SCORE * Math.exp(-distKm / DECAY_KM)));
}

/* Formatear distancia legible */
function fmtDist(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/* Grade según total */
function grade(total) {
  const pct = total / (MAX_SCORE * TOTAL_RONDAS);
  if (pct >= 0.96) return '🔥 PERFECTO';
  if (pct >= 0.80) return '⭐ EXCELENTE';
  if (pct >= 0.60) return '👏 MUY BIEN';
  if (pct >= 0.40) return '👍 BIEN';
  if (pct >= 0.20) return '😅 REGULAR';
  return '📰 A PRACTICAR';
}

/* URL de Street View embed desde coordenadas (sin API key) */
function svEmbedUrlFree(lat, lng) {
  // Formato de embed gratuito vía URL de Google Maps normal
  // Construye la URL de Street View panorámica sin API key
  return `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}&cbp=12,0,,0,0&output=svembed`;
}

/* Carga el Street View de la ronda vía la URL de embed gratuita
   (sin API key — la API JS de Google ya no se usa en este juego). */
function loadStreetView(lat, lng) {
  const frame = document.getElementById('sv-frame');
  if (!frame) return;
  frame.src = svEmbedUrlFree(lat, lng);
}

/* ── UID anónimo ── */
function getUid() {
  let uid = localStorage.getItem('estadio-uid');
  if (!uid) {
    uid = 'u_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('estadio-uid', uid);
  }
  return uid;
}

/* ── Stats locales ── */
function loadStats() {
  try { return JSON.parse(localStorage.getItem('estadio-stats') || '{}'); }
  catch { return {}; }
}
function saveStats(stats) {
  localStorage.setItem('estadio-stats', JSON.stringify(stats));
}
function updateStats(total) {
  const s = loadStats();
  s.partidas  = (s.partidas  || 0) + 1;
  s.acum      = (s.acum      || 0) + total;
  s.mejor     = Math.max(s.mejor || 0, total);
  saveStats(s);
}

/* ══════════════════════════════════════════════
   PANTALLAS
   ══════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ══════════════════════════════════════════════
   MENÚ
   ══════════════════════════════════════════════ */
function initMenu() {
  const s = loadStats();
  document.getElementById('stat-partidas').textContent = s.partidas || 0;
  document.getElementById('stat-mejor').textContent =
    s.mejor ? s.mejor.toLocaleString('es-ES') : '—';
  document.getElementById('stat-media').textContent =
    (s.partidas && s.acum)
      ? Math.round(s.acum / s.partidas).toLocaleString('es-ES')
      : '—';
}

/* ══════════════════════════════════════════════
   MODO DIARIO — una partida por día
   ══════════════════════════════════════════════ */
function estadioDailyKey() { return `estadio_daily_${todayStr()}`; }

function loadDailyPlayed() {
  try {
    const raw = localStorage.getItem(estadioDailyKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveDailyPlayed(total) {
  try {
    localStorage.setItem(estadioDailyKey(), JSON.stringify({
      total,
      scores:  state.scores,
      guesses: state.guesses,
      // Guardamos también qué estadios fueron las rondas reales: si
      // estadios.json cambia de contenido/orden más tarde el mismo día
      // (el dataset se puede editar en caliente), volver a barajar con la
      // semilla del día ya no reproduciría las mismas rondas y el resultado
      // se mostraría emparejado con estadios equivocados.
      rondas:  state.rondas,
      ts: Date.now(),
    }));
  } catch {}
}

/* ══════════════════════════════════════════════
   INICIO DE PARTIDA
   ══════════════════════════════════════════════ */
function startGame() {
  const seed  = dateToSeed(todayStr());
  const pool  = shuffleSeeded(state.estadios, seed);
  state.rondas      = pool.slice(0, TOTAL_RONDAS);
  state.rondaActual = 0;
  state.scores      = [];
  state.guesses     = [];
  state.guess       = null;

  /* Modo diario: si ya jugaste hoy, restaurar y mostrar el resultado */
  const played = loadDailyPlayed();
  if (played && Array.isArray(played.scores) && Array.isArray(played.guesses)
      && played.scores.length === TOTAL_RONDAS && played.guesses.length === TOTAL_RONDAS) {
    state.scores      = played.scores;
    state.guesses     = played.guesses;
    // Preferir los estadios realmente jugados (guardados junto al resultado)
    // sobre el pool recién barajado: si el dataset se editó entre medias,
    // recalcular con la semilla de hoy ya no da las mismas rondas.
    if (Array.isArray(played.rondas) && played.rondas.length === TOTAL_RONDAS) {
      state.rondas = played.rondas;
    }
    state.rondaActual = TOTAL_RONDAS;
    mostrarFin(true);
    return;
  }

  showScreen('screen-game');
  loadRonda(0);
  // El mapa se creó con la pantalla oculta (tamaño 0) — recalcular ahora
  refreshGameMapSize();
}

/* ══════════════════════════════════════════════
   MAPA DE GUESS — Leaflet + OpenStreetMap (sin API key)
   ══════════════════════════════════════════════ */
let gameMap    = null;
let gameMarker = null;

/* Chincheta roja bien visible (misma que la de los mapas de resultados) */
const GUESS_PIN_ICON = () => L.divIcon({
  className: '',
  html: `<svg width="30" height="42" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(1px 2px 2px rgba(0,0,0,.4))">
    <path d="M14,2 C8.48,2 4,6.48 4,12 C4,19 14,36 14,36 C14,36 24,19 24,12 C24,6.48 19.52,2 14,2 Z" fill="#b5221e" stroke="#0f120e" stroke-width="2"/>
    <circle cx="14" cy="12" r="4" fill="#0f120e"/>
  </svg>`,
  iconSize:   [30, 42],
  iconAnchor: [15, 40],   // la punta del pin marca la coordenada exacta
});

function initGameMap() {
  if (gameMap) return;

  gameMap = L.map('map-leaflet', {
    center: [20, 0],
    zoom: 2,
    minZoom: 1,
    maxZoom: 18,
    worldCopyJump: true,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18,
  }).addTo(gameMap);

  gameMap.on('click', (e) => {
    const { lat, lng } = e.latlng;
    state.guess = { lat, lng };

    if (gameMarker) {
      gameMarker.setLatLng(e.latlng);
    } else {
      gameMarker = L.marker(e.latlng, { icon: GUESS_PIN_ICON(), title: 'Tu pin' }).addTo(gameMap);
    }

    document.getElementById('map-hint').textContent = 'Confirma tu ubicación';
    document.getElementById('btn-confirmar').disabled = false;
  });
}

/* Leaflet necesita recalcular su tamaño cuando el contenedor cambia
   (mostrar la pantalla de juego, expandir/colapsar el panel, hover…) */
function refreshGameMapSize() {
  if (gameMap) setTimeout(() => gameMap.invalidateSize(), 280);
}

/* ══════════════════════════════════════════════
   CARGAR RONDA
   ══════════════════════════════════════════════ */
function loadRonda(idx) {
  const estadio = state.rondas[idx];
  state.guess   = null;

  // HUD
  document.getElementById('hud-ronda-num').textContent = idx + 1;
  document.getElementById('hud-score').textContent =
    state.scores.reduce((a, b) => a + b, 0).toLocaleString('es-ES');

  // Street View iframe
  const [lat, lng] = estadio.coord;
  loadStreetView(lat, lng);

  // Reset mapa
  document.getElementById('map-hint').textContent = 'Haz clic en el mapa para colocar tu pin';
  document.getElementById('btn-confirmar').disabled = true;
  document.getElementById('map-panel').classList.remove('map-expanded');
  document.getElementById('map-panel').classList.add('map-collapsed');

  if (gameMarker) { gameMarker.remove(); gameMarker = null; }
  if (gameMap) gameMap.setView([20, 0], 2);
  refreshGameMapSize();
}

/* ══════════════════════════════════════════════
   CONFIRMAR GUESS
   ══════════════════════════════════════════════ */
function confirmarGuess() {
  if (!state.guess) return;

  const estadio = state.rondas[state.rondaActual];
  const [lat, lng] = estadio.coord;
  const distKm  = haversineKm(state.guess.lat, state.guess.lng, lat, lng);
  const puntos  = calcScore(distKm);

  state.scores.push(puntos);
  state.guesses.push({ ...state.guess });

  showResult(estadio, distKm, puntos);
}

/* ══════════════════════════════════════════════
   PANTALLA RESULTADO RONDA
   ══════════════════════════════════════════════ */
let resMap = null;

function showResult(estadio, distKm, puntos) {
  const idx = state.rondaActual;

  document.getElementById('res-ronda').textContent   = idx + 1;
  document.getElementById('res-stadium').textContent = estadio.name;
  document.getElementById('res-score').textContent   = puntos.toLocaleString('es-ES');
  document.getElementById('res-dist').textContent    = fmtDist(distKm);

  const [lat, lng] = estadio.coord;
  showScreen('screen-result');

  if (resMap) { resMap.remove(); resMap = null; }

  resMap = L.map('res-map', { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18,
  }).addTo(resMap);

  const pinIcon = L.divIcon({
    className: '',
    html: `<svg width="24" height="35" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(1px 1px 2px rgba(0,0,0,.3))">
      <path d="M14,2C8.48,2,4,6.48,4,12C4,19,14,36,14,36S24,19,24,12C24,6.48,19.52,2,14,2Z" fill="#b5221e" stroke="#0f120e" stroke-width="2"/>
      <circle cx="14" cy="12" r="4" fill="#0f120e"/>
    </svg>`,
    iconSize: [24, 35], iconAnchor: [12, 35],
  });

  const estadioIcon = L.divIcon({
    className: '',
    html: `<svg width="26" height="38" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(1px 1px 2px rgba(0,0,0,.3))">
      <path d="M14,2C8.48,2,4,6.48,4,12C4,19,14,36,14,36S24,19,24,12C24,6.48,19.52,2,14,2Z" fill="#0f120e" stroke="#b5221e" stroke-width="2"/>
      <text x="14" y="16" font-size="14" text-anchor="middle" dominant-baseline="middle" fill="#b5221e">🏟</text>
    </svg>`,
    iconSize: [26, 38], iconAnchor: [13, 38],
  });

  const guessLL = L.latLng(state.guess.lat, state.guess.lng);
  const realLL  = L.latLng(lat, lng);

  L.marker(guessLL, { icon: pinIcon }).addTo(resMap).bindPopup('Tu pin').openPopup();
  L.marker(realLL,  { icon: estadioIcon }).addTo(resMap).bindPopup(estadio.name);
  L.polyline([guessLL, realLL], { color: '#b5221e', weight: 2, dashArray: '6,4', opacity: 0.85 }).addTo(resMap);
  resMap.fitBounds(L.latLngBounds([guessLL, realLL]), { padding: [30, 30] });

  const btnLabel = document.getElementById('btn-siguiente-label');
  btnLabel.textContent = (idx + 1 < TOTAL_RONDAS) ? 'Siguiente ronda →' : 'Ver resultado final →';
}

/* ══════════════════════════════════════════════
   SIGUIENTE RONDA / FIN
   ══════════════════════════════════════════════ */
function siguienteRonda() {
  state.rondaActual++;
  if (state.rondaActual < TOTAL_RONDAS) {
    showScreen('screen-game');
    loadRonda(state.rondaActual);
  } else {
    mostrarFin();
  }
}

/* ══════════════════════════════════════════════
   PANTALLA FIN
   ══════════════════════════════════════════════ */
let endMap = null;

function mostrarFin(alreadyPlayed = false) {
  const total = state.scores.reduce((a, b) => a + b, 0);

  document.getElementById('end-score-total').textContent = total.toLocaleString('es-ES');
  document.getElementById('end-grade').textContent       = grade(total);
  document.getElementById('end-title').textContent       = gradeTitle(total);

  // Tabla de rondas
  const container = document.getElementById('end-rounds');
  container.innerHTML = '';
  state.rondas.forEach((est, i) => {
    const [lat, lng] = est.coord;
    const g    = state.guesses[i];
    const dist = haversineKm(g.lat, g.lng, lat, lng);
    const sc   = state.scores[i];

    const row = document.createElement('div');
    row.className = 'end-round-row';
    row.innerHTML = `
      <span class="end-round-num">Ronda ${i + 1}</span>
      <span class="end-round-name">${est.name}</span>
      <span class="end-round-dist">${fmtDist(dist)}</span>
      <span class="end-round-score">${sc.toLocaleString('es-ES')}</span>
    `;
    container.appendChild(row);
  });

  showScreen('screen-end');

  /* Modo diario: stats/Firebase/guardado solo la primera vez del día */
  if (!alreadyPlayed) {
    updateStats(total);
    saveScoreFirebase(total);
    saveDailyPlayed(total);
    // Subir ya el progreso al perfil (racha + stats), sin esperar al sondeo
    // periódico: si cierras sesión justo después, no se pierde.
    if (window.FHProgress) { try { FHProgress.push(); } catch { /* nada */ } }
  }

  /* Liga competitiva: si hay sesión, subir el resultado al ranking (solo la
     primera vez del día). La animación de "cómo subes" se ve luego en la
     propia clasificación (las filas se reordenan). Sin sesión, botón oculto. */
  const ligaFinBtn = document.getElementById('btn-liga-fin');
  if (ligaLoggedIn()) {
    if (ligaFinBtn) ligaFinBtn.hidden = false;
    if (!alreadyPlayed) submitLigaDaily(total);
  } else {
    if (ligaFinBtn) ligaFinBtn.hidden = true;
  }

  /* Bloquear "Jugar de nuevo" hasta mañana */
  const againBtn = document.getElementById('btn-jugar-de-nuevo');
  if (againBtn) {
    againBtn.disabled    = true;
    againBtn.textContent = '⏱ Ya jugaste hoy · vuelve mañana';
    againBtn.style.opacity = '0.55';
    againBtn.style.cursor  = 'default';
  }
  const endTitle = document.getElementById('end-title');
  if (alreadyPlayed && endTitle) endTitle.textContent = '📅 Tu resultado de hoy';

  if (endMap) { endMap.remove(); endMap = null; }

  endMap = L.map('end-map', { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18,
  }).addTo(endMap);

  const allPoints = [];

  const pinIconSm = L.divIcon({
    className: '',
    html: `<svg width="18" height="26" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(1px 1px 1px rgba(0,0,0,.3))">
      <path d="M14,2C8.48,2,4,6.48,4,12C4,19,14,36,14,36S24,19,24,12C24,6.48,19.52,2,14,2Z" fill="#b5221e" stroke="#0f120e" stroke-width="2"/>
      <circle cx="14" cy="12" r="3" fill="#0f120e"/>
    </svg>`,
    iconSize: [18, 26], iconAnchor: [9, 26],
  });

  const estIconSm = L.divIcon({
    className: '',
    html: `<svg width="20" height="28" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(1px 1px 1px rgba(0,0,0,.3))">
      <path d="M14,2C8.48,2,4,6.48,4,12C4,19,14,36,14,36S24,19,24,12C24,6.48,19.52,2,14,2Z" fill="#0f120e" stroke="#b5221e" stroke-width="2"/>
      <text x="14" y="15" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="#b5221e">🏟</text>
    </svg>`,
    iconSize: [20, 28], iconAnchor: [10, 28],
  });

  state.rondas.forEach((est, i) => {
    const [lat, lng] = est.coord;
    const g = state.guesses[i];
    const guessLL = L.latLng(g.lat, g.lng);
    const realLL  = L.latLng(lat, lng);
    allPoints.push(guessLL, realLL);
    L.marker(guessLL, { icon: pinIconSm }).addTo(endMap).bindPopup(`Tu pin · Ronda ${i+1}`);
    L.marker(realLL,  { icon: estIconSm  }).addTo(endMap).bindPopup(est.name);
    L.polyline([guessLL, realLL], { color: '#b5221e', weight: 1.5, dashArray: '5,4', opacity: 0.7 }).addTo(endMap);
  });

  if (allPoints.length) {
    endMap.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
  }
}

/* ══════════════════════════════════════════════
   COMPARTIR RESULTADO (estilo Wordle)
   ══════════════════════════════════════════════ */
function estadioShare() {
  const total = state.scores.reduce((a, b) => a + b, 0);
  const squares = state.scores.map(s => (s >= 4000 ? '🟩' : s >= 1500 ? '🟨' : '🟥')).join('');
  const text =
    `El Estadio FutbolHUB · ${todayStr()}\n` +
    `🏟️ ${total.toLocaleString('es-ES')} / 25.000 puntos\n` +
    `${squares}\n` +
    window.location.origin + window.location.pathname;
  estadioDoShare(text, document.getElementById('btn-compartir'));
}

function estadioDoShare(text, btn) {
  const feedback = () => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓ ¡Copiado!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  };
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(feedback).catch(() => {});
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      feedback();
    } catch {}
  }
}

function gradeTitle(total) {
  const pct = total / (MAX_SCORE * TOTAL_RONDAS);
  if (pct >= 0.96) return 'Edición especial: conocedor total';
  if (pct >= 0.80) return 'Gran actuación de hoy';
  if (pct >= 0.60) return 'Buen resultado';
  if (pct >= 0.40) return 'Hay margen de mejora';
  return 'El estadio te ha engañado';
}

/* ══════════════════════════════════════════════
   FIREBASE — guardar score diario
   ══════════════════════════════════════════════ */
async function saveScoreFirebase(total) {
  try {
    const fecha = todayStr();
    const uid   = state.uid;
    const url   = `${FB_URL}/el-estadio/scores/${fecha}/${uid}.json`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total, ts: Date.now() }),
    });
  } catch (e) {
    console.warn('Firebase save failed', e);
  }
}

/* ══════════════════════════════════════════════
   LIGA COMPETITIVA — divisiones semanales + Top 100 Mundial
   Datos en js/liga.js (window.FHLiga). Aquí solo: subir el resultado del
   día al ranking y pintar el panel (clasificación con fotos, Top 100 y la
   versión borrosa con "inicia sesión" para quien no ha entrado).
   ══════════════════════════════════════════════ */
const JUEGO_LIGA = 'el-estadio';
let ligaTab = 'division';

function ligaLoggedIn() {
  return !!(window.FHAuth && FHAuth.identity && FHAuth.identity());
}

function ligaEsc(s) {
  return (window.FHAuth && FHAuth.escHtml)
    ? FHAuth.escHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* Avatar redondo: foto de perfil si la hay, o inicial sobre color fijo
   (misma lógica que el hub, reutilizando los helpers de auth.js). */
function ligaAvatar(username, avatarUrl) {
  const d = (FHAuth.defaultAvatar ? FHAuth.defaultAvatar(username) : { color: '#7f8c8d' });
  const inner = FHAuth.avatarInner
    ? FHAuth.avatarInner(username, avatarUrl)
    : ligaEsc((username || '?').charAt(0).toUpperCase());
  return `<span class="liga-av" style="background:${d.color}">${inner}</span>`;
}

/* Días que quedan hasta el cierre (lunes de la semana + 7). */
function ligaDiasRestantes(semanaStr) {
  try {
    const [y, m, d] = String(semanaStr).split('-').map(Number);
    const cierre = new Date(y, m - 1, d + 7);   // lunes siguiente 00:00 local
    return Math.max(0, Math.ceil((cierre - new Date()) / 86400000));
  } catch { return null; }
}

function setLigaTab(tab) {
  ligaTab = tab;
  document.querySelectorAll('.liga-tab').forEach(b =>
    b.classList.toggle('liga-tab--on', b.dataset.tab === tab));
  renderLigaInline();
}

/* Pinta el panel de liga que vive DENTRO del menú (debajo de "Jugar" y
   "Volver al Hub"): se ve entera con scroll, no hace falta abrir nada. */
async function renderLigaInline() {
  const body = document.getElementById('liga-body');
  if (!body) return;

  if (!ligaLoggedIn() || !window.FHLiga) { body.innerHTML = ligaBloqueadoHTML(); return; }
  body.innerHTML = `<p class="liga-loading">Cargando…</p>`;

  if (ligaTab === 'top100') {
    body.innerHTML = ligaTop100HTML(await FHLiga.top100(JUEGO_LIGA));
    return;
  }

  /* Si acabas de jugar y el menú está a la vista, pinta la clasificación con
     la foto de "después" y anima el reordenamiento desde la de "antes". La
     animación se consume aquí para que no se repita al volver a entrar. */
  const menuVisible = document.getElementById('screen-menu')?.classList.contains('active');
  if (pendingLigaClimb && menuVisible) {
    const climb = pendingLigaClimb;
    pendingLigaClimb = null;
    if (climb.after && Array.isArray(climb.after.clasificacion) && climb.after.clasificacion.length) {
      body.innerHTML = ligaClimbBannerHTML(climb.before, climb.after) + ligaDivisionHTML(climb.after);
      ligaAnimateReorder(body, climb.before, climb.after);
      return;
    }
  }

  const data = await FHLiga.panel(JUEGO_LIGA);
  if (!data || data.auth === false) { body.innerHTML = ligaBloqueadoHTML(); return; }
  body.innerHTML = ligaDivisionHTML(data);
}

/* Botón "Ver clasificación completa" en la pantalla de fin: vuelve al
   menú (donde vive la liga) y baja el scroll hasta ella. Muestra primero el
   menú para que renderLigaInline pueda medir y animar el reordenamiento. */
function goToLigaInline() {
  ligaTab = 'division';
  document.querySelectorAll('.liga-tab').forEach(b =>
    b.classList.toggle('liga-tab--on', b.dataset.tab === 'division'));
  showScreen('screen-menu');
  renderLigaInline();
  requestAnimationFrame(() => {
    document.getElementById('liga-inline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* Sin sesión: lista de ejemplo borrosa + tarjeta para iniciar sesión.
   El botón data-action="open-login" lo captura el profile-widget. */
function ligaBloqueadoHTML() {
  const demo = [
    ['Cristiano', '44.980'], ['Messi', '43.100'], ['Iniesta', '41.250'],
    ['Xavi', '39.800'], ['Casillas', '38.400'], ['Puyol', '36.900'],
  ].map((r, i) => `
    <div class="liga-row">
      <span class="liga-pos">${i + 1}</span>
      <span class="liga-av" style="background:#7f8c8d">${ligaEsc(r[0].charAt(0))}</span>
      <span class="liga-name">${ligaEsc(r[0])}</span>
      <span class="liga-pts">${r[1]}</span>
    </div>`).join('');
  return `
    <div class="liga-locked">
      <div class="liga-blur" aria-hidden="true">${demo}</div>
      <div class="liga-lock-overlay">
        <div class="liga-lock-card">
          <span class="liga-lock-icon">🔒</span>
          <p class="liga-lock-title">Ranking semanal</p>
          <p class="liga-lock-text">Inicia sesión para entrar al ranking semanal, competir por ascender de división y aspirar al Top 100 mundial.</p>
          <button class="btn-primary" type="button" data-action="open-login">Iniciar sesión</button>
        </div>
      </div>
    </div>`;
}

/* Insignia de tramo: escudo real de la categoría (Transfermarkt para las
   españolas, los trofeos que ya usa La Carrera para las europeas/Mundial)
   + nombre. Si la imagen no carga, cae en el emoji para no dejar un hueco roto. */
function ligaTramoBadgeHTML(info) {
  return `
    <div class="liga-tramo-badge">
      <img class="liga-tramo-logo" src="${ligaEsc(info.logo)}" alt=""
           onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${info.emoji}',className:'liga-tramo-emoji-fallback'}))">
      <span>${ligaEsc(info.nombre)}</span>
    </div>`;
}

/* Leyenda de zonas — cuadraditos de color a juego con el borde de cada fila
   (verde ascenso / negro permanencia / rojo descenso), debajo de la tabla.
   En Mundial (tramo 7) solo se muestra descenso; en Tercera (tramo 0) solo ascenso. */
function ligaLeyendaHTML(tramo, sube, baja) {
  const partes = [];
  if (tramo === 7) {
    // Mundial: solo se baja
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--baja"></i>Descienden ${baja}</span>`);
  } else if (tramo === 0) {
    // Tercera: solo se sube
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--sube"></i>Ascienden ${sube}</span>`);
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--queda"></i>Permanencia</span>`);
  } else {
    // Resto: subida, permanencia y bajada
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--sube"></i>Ascienden ${sube}</span>`);
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--queda"></i>Permanencia</span>`);
    partes.push(`<span class="liga-leg"><i class="liga-sq liga-sq--baja"></i>Descienden ${baja}</span>`);
  }
  return `<div class="liga-leyenda">${partes.join('')}</div>`;
}

function ligaDivisionHTML(data) {
  const info = FHLiga.tramoInfo(data.tramo);
  const dias = ligaDiasRestantes(data.semana);
  const lista = Array.isArray(data.clasificacion) ? data.clasificacion : [];
  const n = lista.length;
  const sube = data.sube || 10, baja = data.baja || 10;

  const sub = document.getElementById('liga-subtitle');
  if (sub) {
    sub.textContent = `${info.emoji} ${info.nombre}` +
      (dias != null ? ` · ${dias} día${dias === 1 ? '' : 's'} para el cierre` : '');
  }

  if (!n) {
    return `
      ${ligaTramoBadgeHTML(info)}
      <p class="liga-empty">Aún no has jugado esta semana.<br>Juega la partida diaria para entrar en tu división y empezar a sumar.</p>`;
  }

  const rows = lista.map(p => {
    const yo   = p.user_id === data.yo;
    const zona = (p.pos <= sube && data.tramo < 7) ? 'sube'
               : (p.pos > n - baja && data.tramo > 0) ? 'baja' : '';
    return `
      <div class="liga-row ${zona ? 'liga-row--' + zona : ''} ${yo ? 'liga-row--yo' : ''}" data-uid="${ligaEsc(p.user_id)}">
        <span class="liga-pos">${p.pos}</span>
        ${ligaAvatar(p.username, p.avatar_url)}
        <span class="liga-name">${ligaEsc(p.username || 'jugador')}${yo ? ' <em>(tú)</em>' : ''}</span>
        <span class="liga-pts">${Number(p.puntos).toLocaleString('es-ES')}</span>
      </div>`;
  }).join('');

  return `
    ${ligaTramoBadgeHTML(info)}
    <div class="liga-list">${rows}</div>
    ${ligaLeyendaHTML(data.tramo, sube, baja)}`;
}

function ligaTop100HTML(data) {
  const lista = (data && Array.isArray(data.top100)) ? data.top100 : [];
  const info = FHLiga.tramoInfo(7);
  const head = `${ligaTramoBadgeHTML({ ...info, nombre: 'Top 100 · Mundial' })}`;
  if (!lista.length) {
    return head + `<p class="liga-empty">Todavía no hay nadie en el Top 100 este mes.<br>Llega al tramo Mundial y compite por entrar.</p>`;
  }
  const rows = lista.map(p => `
      <div class="liga-row ${p.puesto <= 3 ? 'liga-row--podio' : ''}">
        <span class="liga-pos">${p.puesto}</span>
        ${ligaAvatar(p.username, p.avatar_url)}
        <span class="liga-name">${ligaEsc(p.username || 'jugador')}</span>
        <span class="liga-pts">${Number(p.puntos).toLocaleString('es-ES')}</span>
      </div>`).join('');
  return head + `<div class="liga-list">${rows}</div>`;
}

/* ── Envío del diario + animación de reordenamiento ──
   Al terminar se lee la clasificación ANTES de enviar, se envía el resultado
   y se lee DESPUÉS. Ambas fotos se guardan en pendingLigaClimb; la animación
   NO se ve aquí (pantalla de fin) sino cuando abres la clasificación: las
   filas arrancan en su puesto de antes y se deslizan al de después (tu casilla
   sube y las que adelantas bajan). Se reproduce una sola vez. */
let pendingLigaClimb = null;   // { before, after } | null

async function submitLigaDaily(total) {
  if (!window.FHLiga || !ligaLoggedIn()) return;
  try {
    // No mandamos el total: mandamos las PISTAS (qué estadio tocó cada ronda
    // y dónde pusimos el pin) y el servidor recalcula la puntuación con las
    // coords reales. Así el número no se puede falsear desde la consola.
    const pistas = state.rondas.map((est, i) => {
      const g = state.guesses[i] || {};
      return { id: est.id, lat: g.lat, lng: g.lng };
    });
    if (pistas.length !== TOTAL_RONDAS || pistas.some(p => !p.id || p.lat == null || p.lng == null)) {
      console.warn('[liga] Partida incompleta, no se sube a la liga.');
      return;
    }
    const before = await FHLiga.panel(JUEGO_LIGA);
    await FHLiga.enviarDiario(JUEGO_LIGA, { pistas });
    const after = await FHLiga.panel(JUEGO_LIGA);
    if (after && after.auth !== false) {
      pendingLigaClimb = { before, after };
    }
    // No se repinta el menú aquí (estás en la pantalla de fin): la animación
    // queda pendiente y se reproduce al abrir la clasificación (goToLigaInline).
  } catch (e) {
    console.warn('[liga] Envío del diario falló:', e);
  }
}

/* Reordena las filas ya pintadas (en orden final) desde su posición anterior
   hasta la actual, técnica FLIP: cada fila se coloca con un translateY que la
   lleva a donde estaba, y luego se anima ese desplazamiento a 0. */
function ligaAnimateReorder(container, before, after) {
  const rows = Array.from(container.querySelectorAll('.liga-row'));
  if (rows.length < 2) return;

  const bList = (before && Array.isArray(before.clasificacion)) ? before.clasificacion : [];
  const bPos  = new Map(bList.map(p => [p.user_id, p.pos]));

  // Separación vertical entre filas consecutivas (alto de fila + gap).
  const stride = rows[1].offsetTop - rows[0].offsetTop;
  if (!stride) return;

  let algoSeMueve = false;
  rows.forEach((row, i) => {
    const uid      = row.getAttribute('data-uid');
    const posAhora = i + 1;
    const posAntes = bPos.get(uid);
    let delta;
    if (posAntes == null) {
      // Fila nueva (no estaba en la foto de antes): entra desde abajo.
      row.style.opacity = '0';
      delta = stride * 1.5;
      algoSeMueve = true;
    } else {
      delta = (posAntes - posAhora) * stride;   // dónde estaba − dónde está
      if (delta) algoSeMueve = true;
    }
    row.classList.add('liga-row--reorder');
    row.style.transition = 'none';
    row.style.transform  = `translateY(${delta}px)`;
  });

  const limpiar = () => rows.forEach(r => {
    r.style.transition = ''; r.style.transform = ''; r.style.opacity = '';
    r.classList.remove('liga-row--reorder', 'liga-row--climbing');
  });

  if (!algoSeMueve) { limpiar(); return; }

  // Resalta tu fila mientras se mueve, para seguirla con la vista.
  const myUid = after && after.yo;
  const myRow = rows.find(r => r.getAttribute('data-uid') === myUid);

  // Forzar reflow con las filas ya "colocadas" en su sitio antiguo…
  void container.offsetHeight;
  // …y ahora animarlas a su sitio real.
  requestAnimationFrame(() => {
    rows.forEach(row => {
      row.style.transition = 'transform 0.85s cubic-bezier(0.22,1,0.36,1), opacity 0.5s ease';
      row.style.transform  = 'translateY(0)';
      row.style.opacity    = '';
    });
    if (myRow) myRow.classList.add('liga-row--climbing');
  });

  setTimeout(limpiar, 1050);
}

/* Banner "has subido/bajado X puestos" que precede al reordenamiento. */
function ligaClimbBannerHTML(before, after) {
  const bList = (before && Array.isArray(before.clasificacion)) ? before.clasificacion : [];
  const aList = (after  && Array.isArray(after.clasificacion))  ? after.clasificacion  : [];
  const meA = aList.find(p => p.user_id === (after && after.yo));
  if (!meA) return '';
  const meB = bList.find(p => p.user_id === (before && before.yo));
  if (!meB) {
    return `<div class="liga-climb-banner"><span class="lcb-delta">🆕</span>
      <span>Has entrado en tu división · puesto ${meA.pos}</span></div>`;
  }
  const diff = meB.pos - meA.pos;   // +subes, −bajas, 0 igual
  if (diff > 0) {
    return `<div class="liga-climb-banner"><span class="lcb-delta">▲ ${diff}</span>
      <span>Subes al puesto ${meA.pos}</span></div>`;
  }
  if (diff < 0) {
    return `<div class="liga-climb-banner lcb-down"><span class="lcb-delta">▼ ${-diff}</span>
      <span>Bajas al puesto ${meA.pos}</span></div>`;
  }
  return `<div class="liga-climb-banner"><span class="lcb-delta">=</span>
    <span>Sigues en el puesto ${meA.pos}</span></div>`;
}

/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */
let _inited = false;

async function init() {
  // Guard: init puede llamarse dos veces (DOMContentLoaded + callback initMap
  // de Google Maps). Sin esto se duplican los event listeners: cada click en
  // "Confirmar" puntuaría dos veces y el toggle del mapa se anularía a sí mismo.
  if (_inited) return;
  _inited = true;

  state.uid = getUid();

  // Cargar estadios
  try {
    const res = await fetch(sbStorageUrl('game-data', 'el-estadio/estadios.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.estadios = await res.json();
  } catch (e) {
    console.error('No se pudieron cargar los estadios', e);
    const btnJugar = document.getElementById('btn-jugar');
    if (btnJugar) {
      btnJugar.disabled = true;
      btnJugar.textContent = 'No disponible';
      btnJugar.insertAdjacentHTML('afterend',
        '<p class="menu-desc" style="color:var(--np-red,#b5221e);margin-top:10px;">' +
        'No se han podido cargar los estadios. Prueba más tarde.</p>');
    }
    return;
  }

  // Inicializar mapa de juego (en background, sin mostrar)
  initGameMap();

  // Eventos
  document.getElementById('btn-jugar').addEventListener('click', startGame);
  document.getElementById('btn-confirmar').addEventListener('click', confirmarGuess);
  document.getElementById('btn-siguiente').addEventListener('click', siguienteRonda);
  document.getElementById('btn-jugar-de-nuevo').addEventListener('click', () => {
    // "Jugar de nuevo" debe iniciar una partida nueva de inmediato, no solo
    // volver al menú (antes había que pulsar "Jugar" una segunda vez).
    startGame();
  });
  document.getElementById('btn-compartir')?.addEventListener('click', estadioShare);

  // Liga competitiva: panel inline en el menú (bajo "Jugar"/"Volver al Hub")
  document.getElementById('btn-liga-fin')?.addEventListener('click', goToLigaInline);
  document.querySelectorAll('.liga-tab').forEach(b =>
    b.addEventListener('click', () => setLigaTab(b.dataset.tab)));
  // Si el usuario inicia/cierra sesión desde el modal, refrescar el panel
  // en el sitio (de borroso a real, o al revés) sin recargar la página.
  if (window.FHAuth && FHAuth.onIdentity) FHAuth.onIdentity(() => renderLigaInline());

  // Expandir el mapa al pinchar (solo expande — nunca colapsa, para que
  // colocar la chincheta no cierre el panel). Se colapsa solo al pasar de ronda.
  const mapPanel = document.getElementById('map-panel');
  mapPanel.addEventListener('click', () => {
    if (mapPanel.classList.contains('map-collapsed')) {
      mapPanel.classList.remove('map-collapsed');
      mapPanel.classList.add('map-expanded');
    }
    refreshGameMapSize();
  });
  // El hover del CSS también cambia el tamaño del panel → recalcular
  mapPanel.addEventListener('mouseenter', refreshGameMapSize);
  mapPanel.addEventListener('mouseleave', refreshGameMapSize);

  // Menú
  initMenu();
  showScreen('screen-menu');
}

document.addEventListener('DOMContentLoaded', init);

// Compatibilidad: si quedara en caché un index.html antiguo que aún cargue la
// API de Google Maps con callback=initMap, no debe romper nada.
window.initMap = function () { init(); };
