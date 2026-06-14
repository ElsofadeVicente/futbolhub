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

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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

/* URL de Street View embed desde coordenadas */
function svEmbedUrl(lat, lng) {
  // Construye URL de Google Maps Street View embed apuntando a las coords exactas
  // heading=0, pitch=0, fov=90 para vista neutra
  const encoded = encodeURIComponent(`${lat},${lng}`);
  return `https://www.google.com/maps/embed/v1/streetview?key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY&location=${encoded}&heading=0&pitch=0&fov=90`;
}

/* Nota: la key de arriba es solo para pruebas con embed/v1.
   La versión iframe sin key usa este formato alternativo: */
function svEmbedUrlFree(lat, lng) {
  // Formato de embed gratuito vía URL de Google Maps normal
  // Construye la URL de Street View panorámica sin API key
  return `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}&cbp=12,0,,0,0&output=svembed`;
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

  showScreen('screen-game');
  loadRonda(0);
}

/* ══════════════════════════════════════════════
   GOOGLE MAPS — mapa de guess
   ══════════════════════════════════════════════ */
let gameMap    = null;
let gameMarker = null;

function initGameMap() {
  if (gameMap) { gameMap = null; gameMarker = null; }

  gameMap = new google.maps.Map(document.getElementById('map-leaflet'), {
    center: { lat: 20, lng: 0 },
    zoom: 2,
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
  });

  gameMap.addListener('click', (e) => {
    const lat = e.latLng.lat();
    const lng = e.latLng.lng();
    state.guess = { lat, lng };

    if (gameMarker) {
      gameMarker.setPosition({ lat, lng });
    } else {
      const markerSvg = `
        <svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
          <path d="M14,2 C8.48,2 4,6.48 4,12 C4,19 14,36 14,36 C14,36 24,19 24,12 C24,6.48 19.52,2 14,2 Z" fill="#b5221e" stroke="#0f120e" stroke-width="2"/>
          <circle cx="14" cy="12" r="4" fill="#0f120e"/>
        </svg>
      `;
      
      gameMarker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat, lng },
        map: gameMap,
        content: createSvgElement(markerSvg),
        title: 'Tu pin',
      });
    }

    document.getElementById('map-hint').textContent = 'Confirma tu ubicación';
    document.getElementById('btn-confirmar').disabled = false;
  });
}

function createSvgElement(svgString) {
  const div = document.createElement('div');
  div.innerHTML = svgString;
  return div.firstElementChild;
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
  document.getElementById('sv-frame').src = svEmbedUrlFree(lat, lng);

  // Reset mapa
  document.getElementById('map-hint').textContent = 'Haz clic en el mapa para colocar tu pin';
  document.getElementById('btn-confirmar').disabled = true;
  document.getElementById('map-panel').classList.remove('map-expanded');
  document.getElementById('map-panel').classList.add('map-collapsed');

  if (gameMarker) { gameMarker.map = null; gameMarker = null; }
  if (gameMap) {
    gameMap.setCenter({ lat: 20, lng: 0 });
    gameMap.setZoom(2);
  }
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

function mostrarFin() {
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
  updateStats(total);
  saveScoreFirebase(total);

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
   INIT
   ══════════════════════════════════════════════ */
async function init() {
  state.uid = getUid();

  // Cargar estadios
  try {
    const res = await fetch('./data/estadios.json');
    state.estadios = await res.json();
  } catch (e) {
    console.error('No se pudieron cargar los estadios', e);
    return;
  }

  // Inicializar mapa de juego (en background, sin mostrar)
  initGameMap();

  // Eventos
  document.getElementById('btn-jugar').addEventListener('click', startGame);
  document.getElementById('btn-confirmar').addEventListener('click', confirmarGuess);
  document.getElementById('btn-siguiente').addEventListener('click', siguienteRonda);
  document.getElementById('btn-jugar-de-nuevo').addEventListener('click', () => {
    state.rondaActual = 0;
    state.scores      = [];
    state.guesses     = [];
    state.guess       = null;
    showScreen('screen-menu');
    initMenu();
  });

  // Expandir mapa al hacer clic en el panel
  document.getElementById('map-panel').addEventListener('click', () => {
    const panel = document.getElementById('map-panel');
    panel.classList.toggle('map-expanded');
    panel.classList.toggle('map-collapsed');
    if (gameMap) setTimeout(() => google.maps.event.trigger(gameMap, 'resize'), 260);
  });

  // Menú
  initMenu();
  showScreen('screen-menu');
}

document.addEventListener('DOMContentLoaded', () => {
  // Si Google Maps ya cargó, init directo; si no, espera al callback
  if (typeof google !== 'undefined' && google.maps) {
    init();
  }
  // si no, window.initMap lo arrancará (callback de la API)
});

window.initMap = function () {
  init();
};
