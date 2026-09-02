/* ══════════════════════════════════════════════
   EN EL TOP — game.js
   ══════════════════════════════════════════════ */
'use strict';

// ── Paths ──────────────────────────────────────
const STATS_KEY         = 'enteltop_stats';
const TODAY_KEY         = 'enteltop_today';
const TIMER_TIMED       = 120;

/* ── PEDIR DATOS SIN QUE UN PARPADEO DE RED ROMPA LA PARTIDA ──────────────
   Un `fetch` pelado se cae entero la primera vez que la PWA vuelve de
   segundo plano, porque iOS tiene la red aún levantándose. FHRed (js/red.js)
   reintenta y espera a que haya conexión. Si esa hoja no llegara a cargar se
   usa fetch normal, para no dejar el juego sin datos por una dependencia. */
function fhJson(url) {
  /* Lo que va por api/data.js (datos estaticos: name-index, team-names,
     ligas) se cachea en el navegador 5 minutos; forzarle `no-cache` seria
     tirar por tierra justo eso. Las ediciones del dia siguen con no-cache,
     que ahi la frescura si importa. */
  var opts = url.startsWith('/api/data') ? undefined : { cache: 'no-cache' };
  if (window.FHRed) return FHRed.json(url, opts);
  return fetch(url, opts).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

/* ── UN FALLO NO PUEDE DEJAR LA PANTALLA VACIA ────────────────────────────
   Antes esto escribía el mensaje reemplazando el innerHTML de #loading-screen
   entero, con lo que se llevaba por delante el botón Volver: quedaba una
   página con cuatro palabras en rojo y ninguna forma de salir, que en la app
   instalada (sin barra de direcciones) es un callejón sin salida. Ahora solo
   se toca el cuerpo, la cabecera se queda, y se deja también la barra de
   ediciones para poder irse a otro día. */
function fallo(texto, detalle) {
  const cuerpo = document.getElementById('loading-body');
  if (cuerpo) {
    cuerpo.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'top-fail';
    p.textContent = detalle ? `${texto} (${detalle})` : texto;
    cuerpo.appendChild(p);
  }
  if (elLoading) elLoading.classList.remove('hidden');
  if (elMode)  elMode.classList.add('hidden');
  if (elGame)  elGame.classList.add('hidden');
  if (elEnd)   elEnd.classList.add('hidden');
  if (elNav && _editions.length > 1) { elNav.classList.remove('hidden'); renderNav(); }
}

// ── Banderas ───────────────────────────────────
const FLAG_REMAP = {
  en: 'gb-eng', sco: 'gb-sct', wls: 'gb-wls', nir: 'gb-nir',
};
function flagUrl(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  return `https://flagcdn.com/w40/${FLAG_REMAP[c] || c}.png`;
}

// ── Normalización de texto ─────────────────────
function norm(s) {
  // Mapeamos primero letras nordicas/especiales que NFD no descompone
  // (o-con-barra, ae-danesa, etc.) para que se acepte "Hojbjerg" al
  // teclear el nombre de jugadores como Hojbjerg, igual que hace Coche.
  return String(s || '').toLowerCase()
    .replace(/\u00f8/g,'o').replace(/\u00e6/g,'ae').replace(/\u00f0/g,'d').replace(/\u00fe/g,'th').replace(/\u0142/g,'l').replace(/\u0111/g,'d').replace(/\u0131/g,'i').replace(/\u0130/g,'i').replace(/\u00df/g,'b').replace(/\u0153/g,'oe').replace(/[\u200b-\u200f]/g,'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Fecha actual en Madrid ─────────────────────
function getTodayMadrid() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid'
  }).format(new Date()); // "YYYY-MM-DD"
}

// ── Ms hasta medianoche de Madrid ─────────────
function getMsUntilMadridMidnight() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(now);
  let h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const s = parseInt(parts.find(p => p.type === 'second').value);
  if (h === 24) h = 0;
  const elapsed = h * 3600 + m * 60 + s;
  return Math.max(0, (86400 - elapsed) * 1000);
}

// ── Formato M:SS ───────────────────────────────
function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Formato HH:MM:SS ───────────────────────────
function formatCountdown(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════
//  STATS (localStorage)
// ══════════════════════════════════════════════
function defaultStats() {
  return { played: 0, wins: 0, streak: 0, maxStreak: 0, hist: Array(11).fill(0) };
}
function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return defaultStats();
    const s = JSON.parse(raw);
    if (!s.hist || s.hist.length < 11) s.hist = Array(11).fill(0);
    return s;
  } catch { return defaultStats(); }
}
function saveStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /**/ }
}
function recordResult(found) {
  const stats = loadStats();
  stats.played++;
  stats.hist[found]++;
  if (found === 10) {
    stats.wins++;
    stats.streak++;
    if (stats.streak > stats.maxStreak) stats.maxStreak = stats.streak;
  } else {
    stats.streak = 0;
  }
  saveStats(stats);
}

// ══════════════════════════════════════════════
//  PARTIDA DIARIA (localStorage)
// ══════════════════════════════════════════════
let _attemptMarked = false;
/* Deja constancia de un intento en curso (score parcial, no el final que
   escribe saveTodayResult al terminar). Solo la primera vez por partida. */
function markAttemptedToday() {
  if (!_isToday || _ended || _attemptMarked) return;
  _attemptMarked = true;
  try {
    localStorage.setItem(`enteltop_day_${getTodayMadrid()}`, JSON.stringify({ score: _found.size }));
  } catch {}
}
function saveTodayResult(questionId, foundArr, score) {
  try {
    localStorage.setItem(TODAY_KEY, JSON.stringify({
      date: getTodayMadrid(),
      questionId,
      found: foundArr,
      score,
      /* Copia de la pregunta del dia (son 10 filas: unos pocos KB). Con esto,
         volver a entrar a una edicion ya jugada no necesita NADA de red y el
         resultado se pinta entero desde local. Era lo que hacia que "termina,
         sal al hub y vuelve" dependiera de una peticion que en la PWA de iOS
         se cae al volver de segundo plano. Mismo criterio que la carrera
         guardada de La Carrera. */
      q: _question ? {
        id: _question.id, q: _question.q, unit: _question.unit,
        hint: _question.hint, type: _question.type, top10: _question.top10
      } : null
    }));
    // Registro por fecha (no se sobreescribe al día siguiente) — lo usa el hub
    // para calcular la racha de días con 10/10.
    localStorage.setItem(`enteltop_day_${getTodayMadrid()}`, JSON.stringify({ score }));
  } catch { /**/ }
}

function loadTodayResult() {
  try {
    const raw = localStorage.getItem(TODAY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== getTodayMadrid()) return null;
    return data;
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  ÍNDICE DE EQUIPOS
// ══════════════════════════════════════════════
function buildTeamIndex(teamNames, leagueTeams) {
  const priorityMap = new Map();
  for (const [, leagueData] of Object.entries(leagueTeams)) {
    for (const teamName of leagueData.teams) {
      if (!priorityMap.has(teamName)) priorityMap.set(teamName, leagueData.priority);
    }
  }
  const result = teamNames.map(name => ({
    name,
    normName: norm(name),
    priority: priorityMap.get(name) || 999
  }));
  result.sort((a, b) => a.priority - b.priority);
  return result;
}

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let _question      = null;
let _nameIndex     = [];
let _teamIndex     = [];
let _found         = new Set();
let _mode          = 'normal';
let _timeLeft      = 0;
let _timerInterval = null;
let _ended         = false;
let _statsSaved    = false;

let _days     = {};   // { "AAAA-MM-DD": entry } de todos los meses cargados
let _editions = [];   // fechas jugables (<= hoy), ASCENDENTE (edición 1 = la más antigua)
let _idx      = 0;    // índice de la edición actual dentro de _editions
let _isToday  = false;
let _hoyFalta = false;

let _acItems    = [];
let _acIdx      = -1;
let _acDebounce = null;
let _cdInterval = null;
let _docClickBound = false;

let _falloDeRed         = false; // alguna peticion del calendario se cayo por red
let _timerStart        = 0;      // instante real de arranque del reloj
let _bindHecho         = false;  // los listeners de una vez ya estan puestos
let _arranqueIncompleto = false; // el juego no llego a montarse: se puede reintentar
let _reintentando      = false;
let _pendientes        = [];     // setTimeout en vuelo, para poder cancelarlos

/* Un setTimeout que se puede cancelar en bloque. Los tres que tiene el juego
   (revelar, pintar el resultado, abrir estadisticas) llegan CON RETRASO, asi
   que si mientras tanto se cambia de edicion caen encima de la partida nueva:
   se veia el panel de resultado del dia anterior sobre un juego recien
   empezado. Cancelarlos al empezar cierra ese hueco. */
function luegoDe(ms, fn) {
  const id = setTimeout(() => {
    _pendientes = _pendientes.filter(x => x !== id);
    fn();
  }, ms);
  _pendientes.push(id);
  return id;
}
function cancelarPendientes() {
  _pendientes.forEach(clearTimeout);
  _pendientes = [];
}

/* ── LOS INDICES DEL AUTOCOMPLETADO SE PIDEN APARTE, Y SIN BLOQUEAR ────────
   name-index.json, team-names.json y league-teams.json SOLO hacen falta
   mientras se juega: para pintar el menu, una edicion del archivo o el
   resultado de una partida ya terminada no se usan para nada.

   Estaban dentro del Promise.all del arranque, o sea que las tres eran
   OBLIGATORIAS para poder enseñar cualquier cosa — y como Promise.all falla
   al primer rechazo, que se cayera una sola dejaba el juego entero en la
   pantalla de error. En la PWA de iOS, que vuelve de segundo plano con la
   red aun levantandose y tumba las primeras peticiones, eso es exactamente
   lo que pasaba al reentrar: tres peticiones que no hacian ninguna falta se
   llevaban por delante una partida de hoy ya jugada y guardada en local.
   Es el mismo arreglo que se le hizo a La Carrera el 2026-09-01.

   Ahora se piden en paralelo pero sin que nadie las espere, y si fallan se
   vuelven a pedir en cuanto alguien las necesita de verdad. */
let _indicesPromesa = null;
function asegurarIndices() {
  if (_indicesPromesa) return _indicesPromesa;
  _indicesPromesa = Promise.all([
    fhJson(fhDataUrl('player-db', 'players/name-index.json')),
    fhJson(fhDataUrl('player-db', 'team-names/team-names.json')),
    fhJson(fhDataUrl('player-db', 'leagues/league-teams.json')),
  ]).then(([nameIndex, teamNames, leagueTeams]) => {
    _nameIndex = nameIndex;
    _teamIndex = buildTeamIndex(teamNames, leagueTeams);
  }).catch(e => {
    // Que el fallo no se quede pegado: el siguiente que los pida, reintenta.
    _indicesPromesa = null;
    throw e;
  });
  return _indicesPromesa;
}

// ── Refs ───────────────────────────────────────
let elLoading, elMode, elGame, elEnd;
let elModeOpts, elStartGameBtn, elStatsOpenBtn;
let elTimerTrack, elTimerFill, elTimerNum;
let elScore, elTitle, elRowsWrap, elArchiveTag;
let elInput, elSugBox, elGiveup;
let elEndEmoji, elEndTitle, elEndSub, elEndQ, elEndRows, elEndStatsBtn;
let elGiveupOverlay, elGiveupYes, elGiveupNo;
let elStatsOverlay, elStatsClose, elStatsNums, elStatsHistBars, elStatsHistLabels, elStatsCountdown;
let elNav, elNavFirst, elNavPrev, elNavNext, elNavLast, elNavLabel;

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
async function init() {
  elLoading         = document.getElementById('loading-screen');
  elMode            = document.getElementById('mode-screen');
  elGame            = document.getElementById('game-screen');
  elEnd             = document.getElementById('end-screen');
  elModeOpts        = document.querySelectorAll('.mode-opt');
  elStartGameBtn    = document.getElementById('start-game-btn');
  elStatsOpenBtn    = document.getElementById('stats-open-btn');
  elTimerTrack      = document.getElementById('timer-track');
  elTimerFill       = document.getElementById('timer-fill');
  elTimerNum        = document.getElementById('timer-num');
  elScore           = document.getElementById('score-badge');
  elTitle           = document.getElementById('question-title');
  elRowsWrap        = document.getElementById('rows-wrap');
  elInput           = document.getElementById('ans-input');
  elSugBox          = document.getElementById('sug-box');
  elGiveup          = document.getElementById('giveup-btn');
  elEndEmoji        = document.getElementById('end-emoji');
  elEndTitle        = document.getElementById('end-title');
  elEndSub          = document.getElementById('end-sub');
  elEndQ            = document.getElementById('end-q');
  elEndRows         = document.getElementById('end-rows');
  elEndStatsBtn     = document.getElementById('end-stats-btn');
  elGiveupOverlay   = document.getElementById('giveup-overlay');
  elGiveupYes       = document.getElementById('giveup-yes-btn');
  elGiveupNo        = document.getElementById('giveup-no-btn');
  elStatsOverlay    = document.getElementById('stats-overlay');
  elStatsClose      = document.getElementById('stats-close-btn');
  elStatsNums       = document.getElementById('stats-nums');
  elStatsHistBars   = document.getElementById('stats-hist-bars');
  elStatsHistLabels = document.getElementById('stats-hist-labels');
  elStatsCountdown  = document.getElementById('stats-countdown');
  elArchiveTag      = document.getElementById('archive-tag');
  elNav             = document.getElementById('day-nav');
  elNavFirst        = document.getElementById('nav-first');
  elNavPrev         = document.getElementById('nav-prev');
  elNavNext         = document.getElementById('nav-next');
  elNavLast         = document.getElementById('nav-last');
  elNavLabel        = document.getElementById('nav-label');

  const today = getTodayMadrid();

  /* Lo UNICO que hay que esperar para poder enseñar algo es el calendario:
     ahi viven la pregunta del dia y su top10. Los indices del autocompletado
     se piden aparte y solo cuando se va a poder jugar (ver mas abajo).
     fhJson y no fetch a pelo: reintenta y ESPERA a que vuelva la conexion
     (ver js/red.js). */
  try {
    await loadAllMonths(today);
  } catch (e) {
    console.error('[En el Top] fallo cargando el calendario', e);
  }

  _editions = Object.keys(_days)
    .filter(d => d <= today && _days[d] && _days[d].id)
    .sort();   // ascendente: edición 1 = la más antigua

  if (!_editions.length) {
    /* Sin calendario no se puede jugar. Pero si la edicion de HOY ya esta
       jugada y guardada entera, el resultado se puede enseñar sin tocar la
       red: es justo el caso de "termino, sale al hub y vuelve a entrar". */
    if (mostrarResultadoGuardadoSinRed()) { _arranqueIncompleto = false; return; }
    _arranqueIncompleto = _falloDeRed;   // solo se reintenta si fue la red
    fallo(_falloDeRed ? 'No se han podido cargar los datos.'
                      : 'No hay preguntas disponibles todavía.');
    return;
  }
  _arranqueIncompleto = false;

  /* ¿Falta la edición de hoy? Se calcula UNA vez, al cargar los meses. */
  _hoyFalta = !(_days[today] && _days[today].id);

  // Al entrar, la de HOY (o la más reciente disponible)... salvo que la URL
  // pida otra. Se valida contra _editions: un ?dia= inventado se ignora.
  const pedido = window.FHRuta && FHRuta.fecha('dia');
  const iPedido = pedido ? _editions.indexOf(pedido) : -1;
  _idx = iPedido >= 0 ? iPedido : _editions.indexOf(today);
  if (_idx < 0) _idx = _editions.length - 1;
  /* Y que la URL no mienta: el día que no existe (o el de hoy, que va sin
     parámetro) se quita, para que recargar no repita el mismo desvío. */
  if (window.FHRuta) {
    const real = _editions[_idx];
    FHRuta.set({ dia: real === today ? null : real });
  }

  /* Los listeners de una vez, UNA VEZ. init() es reintentable (ver
     reintentarArranque): si un arranque fallido vuelve a pasar por aqui, sin
     esta guarda cada boton de la barra de ediciones acabaria con dos, tres o
     cuatro manejadores y un solo toque saltaria varias ediciones — el mismo
     fallo de manejadores duplicados que ya se corrigio en En el Once. */
  if (!_bindHecho) {
    _bindHecho = true;
    bindModalEvents();
    elNavFirst.addEventListener('click', () => goEdition(0));
    elNavPrev .addEventListener('click', () => goEdition(_idx - 1));
    elNavNext .addEventListener('click', () => goEdition(_idx + 1));
    elNavLast .addEventListener('click', () => goEdition(_editions.length - 1));

    // El Atrás del móvil deshace la navegación por ediciones, no sale del juego.
    if (window.FHRuta) FHRuta.alVolver(() => {
      const d = FHRuta.fecha('dia') || getTodayMadrid();
      const i = _editions.indexOf(d);
      if (i >= 0 && i !== _idx) goEdition(i, true);
    });

    bindModeScreenEvents();
  }

  prepareQuestion(_idx);

  /* Rescate propio para js/pantalla-viva.js: si alguna vez se llega a tener
     las cuatro pantallas ocultas, que se vuelva al menú del juego y no a un
     panel genérico. Se declara ANTES de la primera transición, que es
     justo donde puede hacer falta. */
  window.FHPantallaViva = window.FHPantallaViva || {};
  window.FHPantallaViva.rescate = irAlMenu;

  // ¿Ya jugaste la edición de hoy?
  const todayResult = loadTodayResult();
  if (_isToday && todayResult && todayResult.questionId === _question.id) {
    /* Todo el bloque protegido: un resultado guardado con otra forma (found
       que no es una lista, por ejemplo) hacía saltar `new Set(...)` y dejaba
       la carga escondida sin nada detrás. Si algo va mal aquí, al menú, que
       desde ahí se puede volver a jugar. */
    try {
      _found      = new Set(todayResult.found || []);
      _ended      = true;
      _statsSaved = true;
      showEndScreen(todayResult.score === 10);
      return;
    } catch (e) {
      console.error('[En el Top] No se pudo enseñar el resultado guardado', e);
      _ended = false; _statsSaved = false; _found = new Set();
    }
  }

  /* Se va a poder jugar: ahora si merece la pena ir bajando los indices del
     autocompletado, en paralelo y sin que nadie los espere. Aqui abajo y no
     al principio de init() a proposito: por el camino de "hoy ya esta jugado"
     no se usan para nada, y son ~200 KB que en un movil se pagan cada vez que
     se entra a ver el resultado. */
  asegurarIndices().catch(() => { /* se reintenta al escribir */ });

  irAlMenu();
}

/* El resultado de HOY, guardado entero, enseñado sin pedir nada a la red.
   Devuelve true si ha podido. Solo sirve para partidas guardadas a partir
   del 2026-09-01 (antes no se guardaba la pregunta); las de antes siguen el
   camino normal, que ya no depende de los indices. */
function mostrarResultadoGuardadoSinRed() {
  const r = loadTodayResult();
  if (!r || !r.q || !Array.isArray(r.q.top10) || !r.q.top10.length) return false;
  try {
    _question = r.q;
    _question._normMap = buildNormMap(_question.top10);
    _isToday    = true;
    _found      = new Set(r.found || []);
    _ended      = true;
    _statsSaved = true;
    showEndScreen(r.score === 10);
    return true;
  } catch (e) {
    console.error('[En el Top] no se pudo enseñar el resultado guardado sin red', e);
    return false;
  }
}

/* ── VOLVER A INTENTARLO EN VEZ DE QUEDARSE MUERTO ────────────────────────
   Un arranque fallido dejaba en pantalla un mensaje de error del que no se
   salia: nadie reintentaba nunca, asi que el jugador tenia que salir al hub
   y entrar otra vez. En la PWA de iOS ese fallo es el caso NORMAL (la app
   vuelve de segundo plano con la red aun levantandose), asi que quedarse
   muerto ahi es justo lo peor. Ahora se reintenta solo en cuanto la pagina
   vuelve al primer plano, se restaura o recupera conexion — ver
   FHRed.alRecuperar en js/red.js.

   init() es idempotente para esto: los listeners de una vez van detras de
   _bindHecho y el resto es recalcular y repintar. */
function reintentarArranque() {
  if (!_arranqueIncompleto || _reintentando) return;
  _reintentando = true;
  const cuerpo = document.getElementById('loading-body');
  if (cuerpo) {
    cuerpo.innerHTML = '';
    const sp = document.createElement('div'); sp.className = 'spin';
    const p  = document.createElement('p');   p.textContent = 'Reintentando…';
    cuerpo.appendChild(sp); cuerpo.appendChild(p);
  }
  Promise.resolve().then(init).catch(e => {
    console.error('[En el Top] el reintento de arranque fallo', e);
    fallo('No se han podido cargar los datos.');
  }).then(() => { _reintentando = false; });
}

/* Enseñar el menú: se enseña ANTES de esconder, por lo mismo que
   showEndScreen. Es también el rescate del juego. */
function irAlMenu() {
  if (!elMode) return;
  elMode.classList.remove('hidden');
  elLoading.classList.add('hidden');
  elGame.classList.add('hidden');
  elEnd.classList.add('hidden');
}

/* Carga el mes actual y los anteriores (hasta 3 fallos seguidos), para poder
   navegar "muy para atrás" a través de meses. */
async function loadAllMonths(today) {
  let [y, m] = today.slice(0, 7).split('-').map(Number);
  let misses = 0;
  _falloDeRed = false;
  for (let k = 0; k < 36 && misses < 3; k++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    try {
      /* fhJson: un 404 (mes que no existe) no se reintenta y cuenta como
         fallo, pero un parpadeo de red sí. Antes esto era un fetch pelado:
         si la petición del MES EN CURSO se caía al volver la app de segundo
         plano, el juego se quedaba sin la edición de hoy y servía la de
         ayer sin decir nada, con el resultado guardado de hoy sin poder
         enseñarse. */
      const j = await fhJson(sbStorageUrl('game-data', `en-el-top/${key}.json`));
      Object.assign(_days, j.days || j);
      misses = 0;
    } catch (e) {
      /* Un 404 es "ese mes no existe" y es normal (asi se sabe donde acaba el
         archivo). Un fallo SIN status es la red, y eso si se puede reintentar
         mas tarde: hay que distinguirlos o el mensaje miente y el reintento
         no sabe si tiene algo que hacer. */
      if (!(e && e.status)) _falloDeRed = true;
      misses++;
    }
    m--; if (m < 1) { m = 12; y--; }
  }
}

/* Prepara la pregunta de la edición idx (sin arrancar la partida). */
function prepareQuestion(idx) {
  const date = _editions[idx];
  _question = _days[date];
  _question._normMap = buildNormMap(_question.top10);
  _isToday = (date === getTodayMadrid());
}

/* Navega a otra edición (desde el juego o el final) y la carga de cero,
   salvo que sea la de hoy y ya esté jugada: entonces muestra ese resultado
   guardado en vez de reiniciar la partida (igual que la-carrera). */
function goEdition(idx, desdeAtras) {
  stopTimer();
  cancelarPendientes();
  idx = Math.max(0, Math.min(_editions.length - 1, idx));
  _idx = idx;
  prepareQuestion(_idx);

  /* push: cambiar de edición SÍ es moverse a otro sitio y el Atrás debe
     deshacerlo. Cuando la llamada VIENE del Atrás no se toca la URL: ya la ha
     cambiado el navegador, y volver a escribirla encadenaría entradas. */
  if (window.FHRuta && !desdeAtras) {
    const date = _editions[_idx];
    FHRuta.set({ dia: _isToday ? null : date }, { push: true });
  }

  const todayResult = _isToday ? loadTodayResult() : null;
  if (todayResult && todayResult.questionId === _question.id) {
    _found      = new Set(todayResult.found);
    _ended      = true;
    _statsSaved = true;
    showEndScreen(todayResult.score === 10);
    return;
  }

  startGame();
}

function renderNav() {
  if (!elNav || !_editions.length) return;
  const n = _editions.length;
  const atStart = _idx <= 0, atEnd = _idx >= n - 1;
  elNavFirst.disabled = atStart;
  elNavPrev.disabled  = atStart;
  elNavNext.disabled  = atEnd;
  elNavLast.disabled  = atEnd;
  elNavLabel.textContent = `#${_idx + 1}`;
}

function questionType() {
  if (!_question) return 'player';
  if (_question.type) return _question.type;             // explícito gana
  return _question.hint === 'club' ? 'team' : 'player'; // infiere de hint
}

// ══════════════════════════════════════════════
//  MODE SCREEN
// ══════════════════════════════════════════════
function bindModeScreenEvents() {
  elModeOpts.forEach(btn => {
    btn.addEventListener('click', () => {
      elModeOpts.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      _mode = btn.dataset.mode;
    });
  });
  elStartGameBtn.addEventListener('click', startGame);
  elStatsOpenBtn.addEventListener('click', openStats);
}

// ══════════════════════════════════════════════
//  MODAL EVENTS
// ══════════════════════════════════════════════
function bindModalEvents() {
  elGiveupYes.addEventListener('click', () => {
    elGiveupOverlay.classList.add('hidden');
    endGame(false);
  });
  elGiveupNo.addEventListener('click', () => {
    elGiveupOverlay.classList.add('hidden');
    elInput.focus();
  });
  elGiveupOverlay.addEventListener('click', e => {
    if (e.target === elGiveupOverlay) {
      elGiveupOverlay.classList.add('hidden');
      elInput.focus();
    }
  });

  elStatsClose.addEventListener('click', closeStats);
  elStatsOverlay.addEventListener('click', e => {
    if (e.target === elStatsOverlay) closeStats();
  });

  elEndStatsBtn.addEventListener('click', openStats);
}

// ══════════════════════════════════════════════
//  START GAME
// ══════════════════════════════════════════════
function startGame() {
  /* Barrer la partida anterior ANTES de montar la nueva: reloj y setTimeout
     en vuelo (revelar, pintar resultado, abrir estadisticas). Si no, saltar
     de edicion con algo pendiente traia el final de la partida vieja encima
     de la recien empezada. */
  stopTimer();
  cancelarPendientes();
  /* Y los modales de la partida anterior. closeStats() se lleva ademas su
     setInterval del "nuevo Top en HH:MM:SS", que si no seguia latiendo
     debajo del juego nuevo. */
  if (elStatsOverlay)  closeStats();
  if (elGiveupOverlay) elGiveupOverlay.classList.add('hidden');
  asegurarIndices().catch(() => { /* el autocompletado reintenta al escribir */ });

  _found        = new Set();
  _ended        = false;
  _statsSaved   = false;
  _attemptMarked = false;
  _timeLeft   = TIMER_TIMED;

  // Enseñar antes de esconder: ver el comentario de showEndScreen.
  elGame.classList.remove('hidden');
  elMode.classList.add('hidden');
  elEnd.classList.add('hidden');
  elLoading.classList.add('hidden');
  elNav.classList.remove('hidden');
  renderNav();
  elArchiveTag.classList.toggle('hidden', _isToday);
  renderAvisoAtrasada(_editions[_idx]);

  if (_mode === 'normal') {
    elTimerTrack.classList.add('hidden');
    elTimerNum.classList.add('hidden');
  } else {
    elTimerTrack.classList.remove('hidden');
    elTimerNum.classList.remove('hidden');
    updateTimerUI(_timeLeft);
  }

  elInput.placeholder = questionType() === 'team'
    ? 'Escribe el nombre del equipo…'
    : 'Escribe el nombre del futbolista…';

  renderGame();
  bindGameEvents();

  if (_mode === 'timed') startTimer();

  elInput.disabled = false;
  elGiveup.disabled = false;
  elInput.focus();
}

function buildNormMap(top10) {
  const map = new Map();
  for (const p of top10) {
    map.set(norm(p.n), p);
    if (p.id) map.set(String(p.id), p);
  }
  return map;
}

// ══════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════
function renderGame() {
  elTitle.textContent = _question.q;
  elRowsWrap.innerHTML = '';
  for (const p of _question.top10) {
    elRowsWrap.appendChild(makeRow(p));
  }
  updateScore();
}

function makeRow(p) {
  const row = document.createElement('div');
  row.className = 'row';
  row.id = `row-${p.r}`;

  const rank = document.createElement('div');
  rank.className = 'row-rank';
  rank.textContent = `${p.r}.`;

  const flagCell = document.createElement('div');
  const url = (_question.hint === 'nat') ? flagUrl(p.nat) : null;
  if (url) {
    flagCell.className = 'row-flag';
    const img = document.createElement('img');
    img.src = url; img.alt = p.nat || '';
    img.onerror = () => { img.style.display = 'none'; };
    flagCell.appendChild(img);
  } else {
    flagCell.className = 'row-flag empty';
  }

  const nameCell = document.createElement('div');
  nameCell.className = 'row-name';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name-text';
  nameCell.appendChild(nameSpan);
  const valBadge = document.createElement('span');
  valBadge.className = 'val-badge';
  valBadge.textContent = `${p.v} ${_question.unit}`;
  nameCell.appendChild(valBadge);

  row.appendChild(rank);
  row.appendChild(flagCell);
  row.appendChild(nameCell);
  return row;
}

function revealRow(p, state) {
  const row = document.getElementById(`row-${p.r}`);
  if (!row) return;
  row.classList.add(state);
  const ns = row.querySelector('.name-text');
  if (ns) ns.textContent = p.n;
  if (state === 'found') {
    row.classList.add('pop');
    row.addEventListener('animationend', () => row.classList.remove('pop'), { once: true });
  }
}

function updateScore() {
  elScore.textContent = `${_found.size}/10`;
}

// ══════════════════════════════════════════════
//  TIMER
// ══════════════════════════════════════════════
/* stopTimer() lo PRIMERO. Sin eso, cambiar de edicion con el cronometro en
   marcha dejaba el interval anterior corriendo para siempre: _timerInterval
   se sobrescribia con el nuevo y el viejo ya no lo paraba nadie. Y no era
   solo memoria — el interval huerfano seguia contando desde SU arranque, asi
   que al llegar a cero llamaba a endGame(false) sobre la partida que
   estuvieras jugando en ese momento. Medido: tres cambios de edicion dejaban
   tres relojes vivos.

   El instante de arranque va en una variable de modulo (no en un closure)
   para poder rehacer el interval al volver de segundo plano sin perder la
   cuenta: el tiempo se calcula siempre contra el reloj real, asi que
   congelar y descongelar la pagina no regala ni quita segundos. */
function startTimer() {
  stopTimer();
  _timerStart = Date.now();
  _timeLeft   = TIMER_TIMED;
  updateTimerUI(_timeLeft);
  _timerInterval = setInterval(tickTimer, 200);
}

function tickTimer() {
  const elapsed = (Date.now() - _timerStart) / 1000;
  _timeLeft = Math.max(0, TIMER_TIMED - elapsed);
  updateTimerUI(_timeLeft);
  if (_timeLeft <= 0) {
    stopTimer();
    if (!_ended) endGame(false);
  }
}

function stopTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
}

/* Al volver la pagina de segundo plano (o de la congelacion del
   back-forward cache de Safari) el interval puede haberse quedado parado.
   Se pone al dia con el reloj real y se vuelve a enganchar. */
function reanudarReloj() {
  if (_mode !== 'timed' || _ended || !_timerStart) return;
  if (!elGame || elGame.classList.contains('hidden')) return;
  tickTimer();
  if (!_ended && !_timerInterval) _timerInterval = setInterval(tickTimer, 200);
}

function updateTimerUI(t) {
  if (_mode !== 'timed') return;
  const pct = (t / TIMER_TIMED) * 100;
  elTimerFill.style.width = pct + '%';
  elTimerFill.classList.toggle('urgent', t <= 10);
  elTimerNum.textContent = formatTime(t);
  elTimerNum.classList.toggle('low', t <= 20);
}

// ══════════════════════════════════════════════
//  INPUT & AUTOCOMPLETE
// ══════════════════════════════════════════════
function bindGameEvents() {
  const newInput = elInput.cloneNode(true);
  elInput.parentNode.replaceChild(newInput, elInput);
  elInput = newInput;

  elInput.addEventListener('input', () => {
    clearTimeout(_acDebounce);
    if (elInput.value.length < 2) { closeSug(); return; }
    _acDebounce = setTimeout(() => buildSug(elInput.value), 160);
  });

  elInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); moveSug(1);  return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); moveSug(-1); return; }
    if (e.key === 'Escape')     { closeSug(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_acIdx >= 0 && _acItems[_acIdx]) submitSug(_acItems[_acIdx]);
      else if (_acItems.length > 0)         submitSug(_acItems[0]);
    }
  });

  // bindGameEvents() se llama en cada startGame() (cada edición navegada), no
  // solo una vez: elInput/elSugBox son variables de módulo reasignadas más
  // arriba, así que el closure siempre lee el valor vigente — basta con
  // registrar este listener una sola vez en toda la sesión en vez de
  // acumularlo en document (mismo fix que la-carrera).
  if (!_docClickBound) {
    document.addEventListener('click', e => {
      if (!elSugBox.contains(e.target) && e.target !== elInput) closeSug();
    });
    _docClickBound = true;
  }

  const newGiveup = elGiveup.cloneNode(true);
  elGiveup.parentNode.replaceChild(newGiveup, elGiveup);
  elGiveup = newGiveup;

  elGiveup.addEventListener('click', () => {
    if (_ended) return;
    elGiveupOverlay.classList.remove('hidden');
  });
}

function wordBoundaryMatch(n, q) {
  const words = n.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words.slice(i).join(' ').startsWith(q)) return true;
  }
  return false;
}

function buildSug(query) {
  const esEquipo = questionType() === 'team';
  /* Los indices ya no vienen en el arranque (ver asegurarIndices). Si todavia
     no han llegado —o se cayeron— se piden ahora y se repite ESTA misma
     busqueda al llegar, para que el jugador no tenga que volver a escribir. */
  if (esEquipo ? !_teamIndex.length : !_nameIndex.length) {
    asegurarIndices().then(() => {
      if (elInput && elInput.value === query) buildSug(query);
    }).catch(() => { /* sin sugerencias; escribir el nombre entero sigue valiendo */ });
    return;
  }
  if (esEquipo) buildTeamSug(query);
  else          buildPlayerSug(query);
}

function buildPlayerSug(query) {
  const q = norm(query);
  let exact = [], starts = [], wordBound = [], contains = [];
  for (const [id, name] of _nameIndex) {
    const n = norm(name);
    if      (n === q)                 exact.push([id, name]);
    else if (n.startsWith(q))         starts.push([id, name]);
    else if (wordBoundaryMatch(n, q)) wordBound.push([id, name]);
    else if (n.includes(q))           contains.push([id, name]);
    /* Nada de cortar antes de encontrar la coincidencia exacta: escribiendo
       "Diego" se llenaba el cupo con los "Diego ..." que salen antes en el
       índice y el propio Diego, que está más abajo, no aparecía nunca. */
    if (exact.length && starts.length + wordBound.length >= 10 && contains.length >= 4) break;
  }
  const combined = [
    ...exact.map(([id, name]) => ({ id, name })),
    ...starts.map(([id, name]) => ({ id, name })),
    ...wordBound.map(([id, name]) => ({ id, name })),
    ...contains.map(([id, name]) => ({ id, name })),
  ].slice(0, 8);
  renderSug(combined, query);
}

function buildTeamSug(query) {
  const q = norm(query);
  let exact = [], starts = [], wordBound = [], contains = [];
  for (const team of _teamIndex) {
    const n = team.normName;
    if      (n === q)                 exact.push(team);
    else if (n.startsWith(q))         starts.push(team);
    else if (wordBoundaryMatch(n, q)) wordBound.push(team);
    else if (n.includes(q))           contains.push(team);
    /* Nada de cortar antes de encontrar la coincidencia exacta: escribiendo
       "Diego" se llenaba el cupo con los "Diego ..." que salen antes en el
       índice y el propio Diego, que está más abajo, no aparecía nunca. */
    if (exact.length && starts.length + wordBound.length >= 10 && contains.length >= 4) break;
  }
  const combined = [...exact, ...starts, ...wordBound, ...contains].slice(0, 8);
  renderSug(combined.map(t => ({ id: null, name: t.name })), query);
}

function renderSug(items, query) {
  _acItems = items;
  _acIdx   = items.length > 0 ? 0 : -1;
  if (!items.length) { closeSug(); return; }
  elSugBox.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'sug-item' + (i === 0 ? ' active' : '');
    div.innerHTML = `<span class="sug-name">${highlight(item.name, query)}</span>`;
    div.addEventListener('mousedown', e => { e.preventDefault(); submitSug(item); });
    div.addEventListener('mousemove', () => setAcIdx(i));
    elSugBox.appendChild(div);
  });
  elSugBox.classList.add('open');
}

function highlight(name, query) {
  const q = norm(query);
  const n = norm(name);
  const idx = n.indexOf(q);
  if (idx === -1) return escHtml(name);
  return escHtml(name.slice(0, idx))
    + `<span class="sug-highlight">${escHtml(name.slice(idx, idx + query.length))}</span>`
    + escHtml(name.slice(idx + query.length));
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function moveSug(dir) {
  setAcIdx(Math.max(0, Math.min(_acItems.length - 1, _acIdx + dir)));
}

function setAcIdx(i) {
  _acIdx = i;
  elSugBox.querySelectorAll('.sug-item').forEach((el, j) =>
    el.classList.toggle('active', j === i)
  );
}

function closeSug() {
  elSugBox.classList.remove('open');
  elSugBox.innerHTML = '';
  _acItems = [];
  _acIdx   = -1;
}

function submitSug(item) {
  closeSug();
  elInput.value = '';
  if (_ended) return;
  validate(item.name, item.id);
}

// ══════════════════════════════════════════════
//  VALIDATION
// ══════════════════════════════════════════════
function validate(name, id) {
  // Racha del hub: un intento real rompe la racha ya, no solo al terminar
  // el minuto. Cerrar la app a medio quiz no dejaba nada guardado (el
  // resultado solo se escribía en endGame) y la racha sobrevivía intacta.
  markAttemptedToday();
  const map = _question._normMap;
  let hit = map.get(norm(name));
  if (!hit && id) hit = map.get(String(id));

  if (hit) {
    if (_found.has(hit.r)) { shakeInput(); return; }
    _found.add(hit.r);
    revealRow(hit, 'found');
    updateScore();
    if (_found.size === 10) { stopTimer(); luegoDe(600, () => endGame(true)); }
  } else {
    shakeInput();
  }
}

function shakeInput() {
  elInput.classList.remove('shake');
  void elInput.offsetWidth;
  elInput.classList.add('shake');
  elInput.addEventListener('animationend', () => elInput.classList.remove('shake'), { once: true });
}

// ══════════════════════════════════════════════
//  GAME END
// ══════════════════════════════════════════════
function endGame(won) {
  _ended = true;
  stopTimer();
  closeSug();
  elGiveupOverlay.classList.add('hidden');
  elInput.disabled = true;
  elGiveup.disabled = true;

  if (_isToday && !_statsSaved) {
    _statsSaved = true;
    recordResult(_found.size);
    saveTodayResult(_question.id, [..._found], _found.size);
  }

  for (const p of _question.top10) {
    if (!_found.has(p.r)) revealRow(p, 'revealed');
  }

  luegoDe(900, () => showEndScreen(won));
}

/* PRIMERO SE MONTA, DESPUES SE CAMBIA DE PANTALLA. Y no al revés, que era el
   fallo: esto empezaba escondiendo #game-screen y solo enseñaba #end-screen
   veinte líneas más abajo. Cualquier tropiezo en medio (un dato con otra
   forma, un elemento que no está) dejaba las cuatro pantallas ocultas a la
   vez — o sea, la página en blanco de la que no se puede salir. Montando
   antes, si algo falla no se ha escondido nada todavía y se sigue viendo lo
   que hubiera. */
function showEndScreen(won) {
  const n = _found.size;

  const filas = document.createDocumentFragment();
  try {
    for (const p of (_question.top10 || [])) {
      const row = makeRow(p);
      row.classList.add(_found.has(p.r) ? 'found' : 'revealed');
      const nombre = row.querySelector('.name-text');
      if (nombre) nombre.textContent = p.n;
      filas.appendChild(row);
    }
  } catch (e) {
    /* Sin las filas el resultado se entiende igual (marcador y pregunta), así
       que se enseña de todos modos: mejor un panel incompleto que ninguno. */
    console.error('[En el Top] No se pudieron montar las filas del resultado', e);
  }

  if (n === 10)    { elEndEmoji.textContent = '🏆'; elEndTitle.textContent = '¡Top perfecto!'; }
  else if (n >= 7) { elEndEmoji.textContent = '🥇'; elEndTitle.textContent = '¡Muy bien!'; }
  else if (n >= 4) { elEndEmoji.textContent = '🥈'; elEndTitle.textContent = 'Bien, pero podías más'; }
  else if (n >= 1) { elEndEmoji.textContent = '🥉'; elEndTitle.textContent = 'Malo el día…'; }
  else             { elEndEmoji.textContent = '😬'; elEndTitle.textContent = '¡Sin ninguno!'; }

  elEndSub.textContent = `${n} / 10 adivinados`;
  elEndQ.textContent   = (_question && _question.q) || '';
  elEndRows.innerHTML  = '';
  elEndRows.appendChild(filas);

  // Ya está todo montado: ahora sí se puede cambiar de pantalla.
  elEnd.classList.remove('hidden');
  elGame.classList.add('hidden');
  elLoading.classList.add('hidden');
  elMode.classList.add('hidden');
  /* Sin calendario (resultado enseñado desde local, sin red) la barra de
     ediciones no lleva a ninguna parte: mismo criterio que fallo(). */
  if (_editions.length > 1) { elNav.classList.remove('hidden'); renderNav(); }

  // Abrir estadísticas automáticamente siempre que termine la partida
  // (ganada o perdida), tras un breve delay para que se vea primero el
  // resultado antes de que aparezca el modal encima.
  luegoDe(700, openStats);
}

// ══════════════════════════════════════════════
//  COMPARTIR RESULTADO (estilo Wordle)
// ══════════════════════════════════════════════
function topShare() {
  const n = _found.size;
  const squares = '🟩'.repeat(n) + '⬛'.repeat(Math.max(0, 10 - n));
  const text =
    `En el Top FutbolHUB · ${getTodayMadrid()}\n` +
    `${_question ? _question.q + '\n' : ''}` +
    `${n}/10\n${squares}\n` +
    window.location.origin + window.location.pathname;
  topDoShare(text, document.getElementById('top-share-btn'));
}

function topDoShare(text, btn) {
  const feedback = () => {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ ¡Copiado!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
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
    } catch { /**/ }
  }
}

// ══════════════════════════════════════════════
//  STATS MODAL + COUNTDOWN
// ══════════════════════════════════════════════
function openStats() {
  renderStatsModal(loadStats());
  elStatsOverlay.classList.remove('hidden');
  startCountdown();
}

function closeStats() {
  elStatsOverlay.classList.add('hidden');
  stopCountdown();
}

function startCountdown() {
  stopCountdown();
  if (!elStatsCountdown) return;
  function tick() {
    const ms = getMsUntilMadridMidnight();
    elStatsCountdown.innerHTML =
      `Nuevo Top en <strong>${formatCountdown(ms)}</strong>`;
  }
  tick();
  _cdInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(_cdInterval);
  _cdInterval = null;
}

function renderStatsModal(stats) {
  const pct = stats.played > 0
    ? Math.round((stats.wins / stats.played) * 100)
    : 0;

  elStatsNums.innerHTML = '';
  [
    { val: stats.played,    label: 'Jugadas' },
    { val: stats.wins,      label: 'Victorias' },
    { val: pct + '%',       label: '%' },
    { val: stats.streak,    label: 'Racha' },
    { val: stats.maxStreak, label: 'Racha\nmáxima' },
  ].forEach(({ val, label }) => {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="stat-val">${val}</div><div class="stat-label">${label}</div>`;
    elStatsNums.appendChild(cell);
  });

  renderHistogram(stats.hist);
}

function renderHistogram(hist) {
  elStatsHistBars.innerHTML   = '';
  elStatsHistLabels.innerHTML = '';
  const maxCount     = Math.max(...hist, 1);
  const currentScore = _ended ? _found.size : null;

  hist.forEach((count, i) => {
    const isCurrent = currentScore !== null && i === currentScore;

    const col = document.createElement('div');
    col.className = 'hist-col';

    const bar = document.createElement('div');
    bar.className = 'hist-bar' + (isCurrent ? ' current' : '');
    bar.style.height = Math.max((count / maxCount) * 100, 4) + '%';

    const cnt = document.createElement('span');
    cnt.className = 'hist-count';
    cnt.textContent = count > 0 ? count : '';
    bar.appendChild(cnt);
    col.appendChild(bar);
    elStatsHistBars.appendChild(col);

    const lbl = document.createElement('div');
    lbl.className = 'hist-label' + (isCurrent ? ' current' : '');
    lbl.textContent = i;
    elStatsHistLabels.appendChild(lbl);
  });
}

// ══════════════════════════════════════════════
//  BOOT Y CICLO DE VIDA
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);

/* SALIR Y VOLVER A ENTRAR NO PUEDE DEJAR EL JUEGO MUERTO.

   Safari (y la PWA de iOS mas todavia) congela la pagina al salir de ella y
   la descongela tal cual al volver: el DOM y las variables siguen intactos,
   asi que NO hay que remontar nada — remontar seria justo lo que se cargaria
   una partida en curso. Lo unico que hay que hacer aqui son dos cosas:

     · Si el arranque llego a fallar, reintentarlo. Antes ese error se
       quedaba en pantalla para siempre.
     · Poner el reloj al dia. Un interval congelado no cuenta el rato que la
       pagina ha estado fuera, asi que al volver enseñaria un tiempo que no
       es; tickTimer lo recalcula contra el reloj real.

   pageshow cubre la restauracion (incluido el back-forward cache),
   visibilitychange el volver de segundo plano y online el recuperar
   cobertura. FHRed.alRecuperar los junta y los limita a un aviso cada 1,5 s,
   porque al volver de segundo plano llegan los tres a la vez. */
function alVolverALaVida() {
  reintentarArranque();
  reanudarReloj();
}
if (window.FHRed && FHRed.alRecuperar) FHRed.alRecuperar(alVolverALaVida);
else {
  window.addEventListener('pageshow', alVolverALaVida);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) alVolverALaVida();
  });
  window.addEventListener('online', alVolverALaVida);
}

/* Al irse (o al congelarse la pagina) se para lo que solo pinta: el
   cronometro de "nuevo Top en HH:MM:SS". El reloj de la partida NO se toca
   aqui — se recalcula solo al volver — y los setTimeout en vuelo tampoco:
   cancelarlos dejaria una partida restaurada del back-forward cache con
   todo revelado y sin panel de resultado. */
window.addEventListener('pagehide', stopCountdown);

/* ── Aviso de edicion atrasada ──────────────────────────────
   Si la edición de HOY no existe, el juego cae a la última disponible sin
   decir nada. Esto lo dice. No confundir con el sello "Archivo": ese sale
   cuando eres TÚ quien navega a una edición pasada, que es lo normal. */
function _fechaLarga(iso) {
  const M = ['enero','febrero','marzo','abril','mayo','junio','julio',
             'agosto','septiembre','octubre','noviembre','diciembre'];
  const p = String(iso).split('-');
  return p.length === 3 ? `${parseInt(p[2], 10)} de ${M[parseInt(p[1], 10) - 1]}` : iso;
}
function renderAvisoAtrasada(fechaMostrada) {
  const anfitrion = document.getElementById('game-main') || document.getElementById('game-screen');
  if (!anfitrion) return;
  let el = document.getElementById('aviso-atrasada');
  const debeVerse = _hoyFalta && fechaMostrada === _editions[_editions.length - 1];
  if (!debeVerse) { if (el) el.classList.add('hidden'); return; }
  if (!el) {
    el = document.createElement('p');
    el.id = 'aviso-atrasada';
    el.className = 'fh-atrasado';
    anfitrion.insertBefore(el, anfitrion.firstChild);
  }
  el.classList.remove('hidden');
  el.textContent = `La edición de hoy todavía no está lista. Mientras tanto, aquí tienes la del ${_fechaLarga(fechaMostrada)}.`;
}
