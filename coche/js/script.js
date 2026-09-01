/* =============================================
   SCRIPT.JS — COCHE (Restricciones de Fútbol)
   QUIÉN COÑO FALTA  —  v10
   ============================================= */
'use strict';

/* ── Escapa texto para insertar de forma segura en HTML (texto o atributo) ── */
function _escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Normalización de texto compartida entre _loadData y App ── */
function _acNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d').replace(/ı/g,'i').replace(/İ/g,'i').replace(/ß/g,'b').replace(/œ/g,'oe').replace(/[\u200b-\u200f]/g,'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    /* Los ap\u00f3strofes desaparecen en vez de convertirse en espacio: as\u00ed
       "Eto'o" se lee "etoo" y se encuentra escribi\u00e9ndolo sin ap\u00f3strofe,
       que es como lo escribe todo el mundo. Igual con O'Shea, N'Golo\u2026 */
    .replace(/['\u2018\u2019\u00b4`\u02bc]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Versi\u00f3n "pegada": la misma normalizaci\u00f3n pero sin espacios. Permite
   encontrar a un jugador tanto si escribes el nombre junto como separado
   ("etoo" / "eto o", "alexanderarnold" / "alexander arnold"). */
function _acTight(s) {
  return _acNorm(s).replace(/ /g, '');
}

/* ═══════════════════════════════════════════════════════════════
   1. BASE DE DATOS
   ═══════════════════════════════════════════════════════════════ */
let PLAYERS_DB = [];
let GEN_POOL   = [];  // pool curado (~1500) usado SOLO por Restrictions.generate()
let NAME_INDEX  = [];

/* ── Compañeros para las restricciones "Compañero de X" ──
   Se construye en _loadData desde compañeros_principal.json (227 jugadores
   curados) en vez de estar escrita a mano. Antes eran 38 nombres fijos, asi
   que Jesé, Lamela, Areola o Lingard no podian salir NUNCA por mucho que
   estuvieran en la base con 500 compañeros cada uno. Comprobados los 227: el
   peor tiene 45 compañeros dentro del pool de generacion, de sobra para
   montar una ronda.
   La MISMA lista viaja al worker por postMessage: asi no hay dos copias que
   puedan divergir, que es contra lo que avisa el comentario del `new Worker`. */
let TEAMMATES_LIST = [];

/* Nombre corto para la etiqueta, solo de los que ya lo tenian curado. El resto
   sale con su nombre completo ("Compañero de Erik Lamela"), que se lee igual
   de bien y evita inventar abreviaturas ambiguas (hay dos Thiago, tres Danilo). */
const TEAMMATE_DISPLAY = {
  '28003':'Messi',   '132098':'Kane',      '3979':'Casillas',  '342229':'Mbappé',
  '45320':'Di María','48280':'Cavani',     '7825':'Reina',     '17259':'Neuer',
  '58358':'Müller',  '35207':'Reus',       '5817':'Pirlo',     '406625':'Lautaro',
  '4673':'Sneijder', '288230':'Dembélé',   '27992':'Modric',   '26399':'Agüero',
  '88755':'De Bruyne','3455':'Ibrahimovic','5023':'Buffon',    '3111':'Zidane',
  '164770':'Varane', '148455':'Salah',     '225083':'Kanté',   '4360':'Robben',
  '7767':'Torres',   '5958':'Totti',
};

function _buildTeammatesList(companeros) {
  return Object.entries(companeros).map(([id, pd]) => ({
    name: pd.name, display: TEAMMATE_DISPLAY[id] || pd.name, id, icon: '⚽',
  }));
}

/* Pool para generar restricciones: GEN_POOL si ya cargó, si no PLAYERS_DB
   (nunca vacío una vez cargados los datos). */
function _genPool() { return GEN_POOL.length ? GEN_POOL : PLAYERS_DB; }

/* ── Mapas globales para validación de jugadores fuera de PLAYERS_DB ── */
let _TROPHY_MAP         = {};  // id → [trophyName, ...]
let _COACH_MAP          = {};  // id → [coachName, ...]
let _TEAMMATE_MAP       = {};  // id → [playerName, ...]
let _REVERSE_TEAMMATE   = {};  // normalizedName → Set<normalizedName> (relación inversa)
let _REVERSE_TEAMMATE_IDS = {}; // normalizedName(famoso) → Set<id_string> (check por ID)
let _PERF_MAP           = {};  // id → { lg:[cids 1a división], clg:goles Champions, bsg:mejor temporada }

let _acItems         = [];
let _acIndex         = -1;
let _acSelected      = null;
let _acDebounce      = null;
let _teamLeaguePrio  = null;
let _chunkCache      = {};
let _playerDataCache = {};
let _chunksPreloaded = false;
let _chunksPromise   = null;

/* ═══════════════════════════════════════════════════════════════
   1a. LOOKUP INDIVIDUAL POR ID (igual que Cadena)
   Permite validar cualquier jugador del name-index,
   no solo los de compañeros_principal.json
   ═══════════════════════════════════════════════════════════════ */
const _CHUNK_RANGES = [
  [0,99999],[100000,199999],[200000,299999],[300000,399999],[400000,499999],
  [500000,599999],[600000,699999],[700000,799999],[800000,899999],[900000,999999],
  [1000000,1099999],[1100000,1199999],[1200000,1299999],[1300000,1399999],[1400000,1499999]
];
function _chunkFileForId(id) {
  const n = parseInt(id);
  const r = _CHUNK_RANGES.find(([lo,hi]) => n >= lo && n <= hi);
  return r ? `../data/players/chunks/${r[0]}-${r[1]}.json` : null;
}

/* ── Carga el chunk de jugadores (bucket player-db) para el rango de IDs
   que ya calcula _chunkFileForId/CHUNK_NAMES, con la misma forma
   { "id": {...datos...}, ... } que tenían los archivos JSON originales. ── */
async function _fetchChunkRangeFromSupabase(cf) {
  const m = cf.match(/(\d+)-(\d+)\.json$/);
  if (!m) return null;
  const [, lo, hi] = m;
  try {
    const res = await fetch(sbStorageUrl('player-db', `players/chunks/${lo}-${hi}.json`), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[Coche] Error cargando jugadores:', e);
    return null;
  }
}

/* ── Antes data/teams/league-teams.json, ahora player-db/leagues/ ── */
async function _fetchLeaguesFromSupabase() {
  try {
    const res = await fetch(sbStorageUrl('player-db', 'leagues/league-teams.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[Coche] Error cargando ligas:', e);
    return null;
  }
}

/* Datos de restricción (compañeros_principal.json, entrenados_por.json, etc.):
   ahora son GENERALES (compartidos con Tres en Raya) y viven en
   game-data/general/. Se lee de ahí con respaldo a game-data/coche/ mientras no
   se haya subido la copia general a Supabase, para no romper nada. */
async function _fetchCocheJsonFile(name) {
  for (const prefix of ['general', 'coche']) {
    try {
      const res = await fetch(sbStorageUrl('game-data', `${prefix}/${name}`), { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch (e) { /* siguiente prefijo */ }
  }
  console.warn(`[Coche] Error cargando ${name} (general ni coche)`);
  return {};
}

async function _getChunkData(id) {
  const sid = String(id);
  if (_playerDataCache[sid]) return _playerDataCache[sid];
  const cf = _chunkFileForId(id);
  if (!cf) return null;
  /* Si no hay cache, o hay cache parcial y el ID no está: fetch completo */
  if (!_chunkCache[cf] || (!_chunkCache[cf][sid] && !_chunkCache[cf].__full)) {
    const full = await _fetchChunkRangeFromSupabase(cf);
    if (!full) return null;
    full.__full = true;
    _chunkCache[cf] = full;
  }
  _playerDataCache[sid] = _chunkCache[cf]?.[sid] || null;
  return _playerDataCache[sid];
}

/* ── Normalización de pie de jugador (global, usada en varios sitios) ── */
function _normFoot(f) {
  if (!f) return null;
  const fl = f.toLowerCase();
  if (fl.includes('zurdo'))   return 'left';
  if (fl.includes('ambi'))    return 'both';
  if (fl.includes('diestro')) return 'right';
  return null;
}

/* Construye un objeto jugador completo desde datos de chunk + mapas globales */
function _buildPlayerFromChunk(id, chunk) {
  if (!chunk) return null;
  const sid = String(id);
  const transfers = chunk.tr || [];
  const maxFee = transfers.length
    ? Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0))
    : 0;
  return {
    id:          sid,
    name:        chunk.n || '?',
    img:         chunk.img || null,
    aliases:     [],
    teammates:   _TEAMMATE_MAP[sid]       || [],
    coaches:     _COACH_MAP[sid]          || [],
    trophies:    [...new Set(_TROPHY_MAP[sid] || [])],
    nationalTeam: chunk.nat               || null,
    teams:       chunk.teams              || [],
    heightCm:    chunk.h ? parseFloat(chunk.h) : null,
    foot:        _normFoot(chunk.f),
    birthYear:   chunk.b ? parseInt(chunk.b, 10) : null,
    goals:       typeof chunk.goals === 'number' ? chunk.goals : null,
    apps:        typeof chunk.apps  === 'number' ? chunk.apps  : null,
    position:    chunk.p || null,
    caps:        chunk.nt ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0,
    natGoals:    (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0,
    maxFee,
    lg:          _PERF_MAP[sid]?.lg  || [],
    clg:         _PERF_MAP[sid]?.clg || 0,
    bsg:         _PERF_MAP[sid]?.bsg || 0,
  };
}

/* Busca un jugador por nombre: primero PLAYERS_DB, luego chunks.
   Siempre intenta enriquecer los datos con el chunk para garantizar
   que 'teams' esté completo incluso si _loadData no lo cargó. */
async function findPlayerAsync(inputName) {
  /* Misma normalizacion que el autocompletado (_acNorm), para que lo que se ve
     en la lista de sugerencias sea exactamente lo que se acepta al enviar.
     El "tight" ignora ademas los espacios: asi "Etoo" encuentra a Eto'o. */
  const norm  = s => _acNorm(s);
  const tight = s => _acTight(s);
  const n  = norm(inputName);
  const nt = tight(inputName);
  if (!n) return null;

  const sameName = (a) => norm(a) === n || (nt && tight(a) === nt);

  /* 1. Buscar en PLAYERS_DB - puede haber duplicados por nombre */
  const matches = PLAYERS_DB.filter(p =>
    sameName(p.name) || (p.aliases||[]).some(a => sameName(a))
  );
  /* Si hay un solo match, usarlo; si hay varios, preferir el que tiene teammates (companeros_principal) */
  const inDB = matches.length === 1 ? matches[0]
    : matches.length > 1 ? (matches.find(p => (p.teammates||[]).length > 0) || matches[0])
    : null;

  const playerId = inDB ? inDB.id : null;
  let chunkId    = playerId;

  /* Si no está en PLAYERS_DB, buscar ID en NAME_INDEX */
  if (!chunkId) {
    const entry = NAME_INDEX.find(([, name]) => sameName(name));
    if (!entry) return null;
    chunkId = String(entry[0]);
  }

  /* 2. Cargar chunk — siempre, para garantizar teams completo */
  const chunk = await _getChunkData(chunkId);

  /* 3a. Jugador en PLAYERS_DB → enriquecer SIEMPRE desde chunk (fuente única de datos) */
  if (inDB) {
    if (chunk) {
      inDB.img          = inDB.img || chunk.img || null;
      inDB.teams        = chunk.teams    || [];
      inDB.heightCm     = chunk.h        ? parseFloat(chunk.h)   : null;
      inDB.foot         = _normFoot(chunk.f);
      inDB.birthYear    = chunk.b        ? parseInt(chunk.b, 10) : null;
      inDB.goals        = typeof chunk.goals === 'number' ? chunk.goals : null;
      inDB.apps         = typeof chunk.apps  === 'number' ? chunk.apps  : null;
      inDB.position     = chunk.p        || null;
      inDB.nationalTeam = chunk.nat      || null;
      inDB.caps         = chunk.nt       ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0;
      const transfers   = chunk.tr || [];
      inDB.maxFee       = transfers.length
        ? Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0))
        : 0;
      console.log(`[findPlayerAsync] enriquecido desde chunk para ${inDB.name}`);
    }
    const mapTrophies = _TROPHY_MAP[inDB.id] || [];
    if (mapTrophies.length > 0) {
      inDB.trophies = [...new Set([...(inDB.trophies || []), ...mapTrophies])];
    }
    return inDB;
  }

  /* 3b. Fuera de PLAYERS_DB → construir desde chunk */
  const built = _buildPlayerFromChunk(chunkId, chunk);
  if (!built) { console.warn(`[findPlayerAsync] Sin datos de chunk para ID ${chunkId}`); }
  return built;
}

/* ═══════════════════════════════════════════════════════════════
   1b. _loadData  —  Carga y transforma todos los JSON de data/
   ═══════════════════════════════════════════════════════════════ */
async function _loadData() {
  const CHUNKS_BASE = '../data/players/chunks/';

  /* ── A: Cargar TODOS los chunks en paralelo junto con los demás JSON ── */
  const CHUNK_NAMES = [
    '0-99999','100000-199999','200000-299999','300000-399999','400000-499999',
    '500000-599999','600000-699999','700000-799999','800000-899999','900000-999999',
    '1000000-1099999','1100000-1199999','1200000-1299999','1300000-1399999','1400000-1499999',
  ];

  const metaPromises = [
    _fetchCocheJsonFile('companeros_principal.json'),
    _fetchCocheJsonFile('entrenados_por.json'),
    _fetchCocheJsonFile('ganadores_clubes_internacional.json'),
    _fetchCocheJsonFile('ganadores_seleccion.json'),
    _fetchCocheJsonFile('GanadoresLigayCopa.json'),
    _fetchCocheJsonFile('premios_individuales.json'),
    _fetchLeaguesFromSupabase(),
    _fetchCocheJsonFile('perf_stats.json'),
    _fetchCocheJsonFile('gen_pool.json'),
  ];

  const chunkPromises = CHUNK_NAMES.map(c => {
    const cf = `${CHUNKS_BASE}${c}.json`;
    /* Si ya está en caché (precarga de DOMContentLoaded), reusar */
    if (_chunkCache[cf]?.__full) return Promise.resolve({ path: cf, data: _chunkCache[cf] });
    return _fetchChunkRangeFromSupabase(cf)
      .then(data => ({ path: cf, data }))
      .catch(() => ({ path: cf, data: null }));
  });

  const [metaResults, chunkResults] = await Promise.all([
    Promise.all(metaPromises),
    Promise.all(chunkPromises),
  ]);

  const [companeros, entrenados, clubInt, seleccion, ligaCopa, premios, leagueData, perfStats, genPool] = metaResults;

  /* Stats precomputadas de performances (ligas 1ª div por cid, goles Champions,
     mejor temporada) — expuestas para validar jugadores fuera de PLAYERS_DB. */
  _PERF_MAP = perfStats && !Array.isArray(perfStats) ? perfStats : {};

  /* Poblar _chunkCache y fusionar todos los chunks */
  const allChunkData = {};
  for (const { path: cf, data } of chunkResults) {
    if (!data) continue;
    data.__full = true;
    _chunkCache[cf] = data;
    for (const [id, pdata] of Object.entries(data)) {
      if (id === '__full') continue;
      allChunkData[id] = pdata;
    }
  }
  _chunksPreloaded = true;
  if (!_chunksPromise) _chunksPromise = Promise.resolve();

  console.log(`✅ Chunks cargados: ${Object.keys(allChunkData).length} jugadores`);

  /* Antes se pedía aparte a data/players/name-index.json; ahora usamos
     los mismos datos que ya hemos traído de Supabase para no duplicar la petición. */
  NAME_INDEX = Object.entries(allChunkData).map(([id, p]) => [parseInt(id, 10), p.n]);

  _teamLeaguePrio = {};
  if (leagueData) {
    for (const [, leagueInfo] of Object.entries(leagueData)) {
      for (const teamName of (leagueInfo.teams || [])) {
        const key = _acNorm(teamName);
        if (_teamLeaguePrio[key] === undefined || leagueInfo.priority < _teamLeaguePrio[key]) {
          _teamLeaguePrio[key] = leagueInfo.priority;
        }
      }
    }
  }

  /* nameMap: id → nombre. Primero desde name-index (cubre TODOS los jugadores),
     luego sobreescribir con companeros_principal (fuente de verdad para los famosos). */
  const nameMap = {};
  for (const [id, name] of NAME_INDEX) {
    nameMap[String(id)] = name;
  }
  for (const [id, pd] of Object.entries(companeros)) nameMap[id] = pd.name;

  /* Trofeos: id → [nombre, ...] */
  const trophyMap  = {};
  const allWinners = { ...clubInt, ...seleccion, ...ligaCopa, ...premios };
  for (const [trophy, pids] of Object.entries(allWinners)) {
    for (const pid of pids) {
      const id = String(pid);
      if (!trophyMap[id]) trophyMap[id] = [];
      trophyMap[id].push(trophy);
    }
  }
  /* Exponer globalmente para validar jugadores fuera de PLAYERS_DB */
  _TROPHY_MAP = trophyMap;

  /* Entrenadores: id → [nombre, ...] */
  const coachMap = {};
  for (const coachData of Object.values(entrenados)) {
    for (const pid of coachData.players) {
      const id = String(pid);
      if (!coachMap[id]) coachMap[id] = [];
      coachMap[id].push(coachData.name);
    }
  }
  _COACH_MAP = coachMap;

  /* Compañeros: id → [nombre, ...] */
  const teammateMap = {};
  for (const [id, pd] of Object.entries(companeros)) {
    const names = [];
    for (const tid of pd.teammates || []) {
      const tidStr = String(tid);
      if (nameMap[tidStr]) names.push(nameMap[tidStr]);
    }
    teammateMap[id] = [...new Set(names)];
  }
  _TEAMMATE_MAP = teammateMap;

  /* Mapa famoso→compañeros: normName(famoso) → Set<normName(compañero)>
     Clave = nombre normalizado del FAMOSO (r.value en validate).
     Set = todos sus compañeros (resueltos ahora desde name-index + companeros_principal).
     Esto permite validar en AMBOS sentidos:
       A) El jugador escrito es clave en companeros_principal → player.teammates tiene al famoso.
       B) El jugador escrito NO es clave pero figura en el array del famoso → reverseMap lo cubre. */
  const reverseMap = {};
  const _norm = s => String(s||'').toLowerCase()
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d').replace(/ı/g,'i').replace(/İ/g,'i').replace(/ß/g,'b').replace(/œ/g,'oe').replace(/[\u200b-\u200f]/g,'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ').trim();
  for (const [id, names] of Object.entries(teammateMap)) {
    const ownerName = nameMap[id];
    if (!ownerName) continue;
    const ownerNorm = _norm(ownerName);
    /* ownerNorm = famoso; names = sus compañeros (ahora bien resueltos con name-index) */
    if (!reverseMap[ownerNorm]) reverseMap[ownerNorm] = new Set();
    for (const tName of names) {
      reverseMap[ownerNorm].add(_norm(tName));
    }
  }
  _REVERSE_TEAMMATE = reverseMap;

  /* Mapa inverso por ID: normName(famoso) → Set<id_string> de sus compañeros.
     Evita fallos de resolución de nombres (prefijos #N, etc.) */
  const reverseIdMap = {};
  for (const [id, pd] of Object.entries(companeros)) {
    const ownerName = nameMap[id];
    if (!ownerName) continue;
    const ownerNorm = _norm(ownerName);
    if (!reverseIdMap[ownerNorm]) reverseIdMap[ownerNorm] = new Set();
    for (const tid of pd.teammates || []) {
      reverseIdMap[ownerNorm].add(String(tid));
    }
  }
  _REVERSE_TEAMMATE_IDS = reverseIdMap;

  /* Los 227 curados pasan a ser candidatos de "Compañero de X" (antes 38
     escritos a mano). Ver TEAMMATES_LIST arriba. */
  TEAMMATES_LIST = _buildTeammatesList(companeros);

  /* Dedup: Coche delega validate()/_isRedundant() en el motor compartido FR.
     FR.validate('teammate') necesita estos mapas inversos; se los inyectamos
     (ya construidos) para no recargar datos. */
  try { if (window.FR && FR.setTeammateMaps) FR.setTeammateMaps(_REVERSE_TEAMMATE, _REVERSE_TEAMMATE_IDS); } catch (e) {}

  /* Restrictions.generate() ahora delega en RankedEngine.generate() (Fase 0 de
     PLAN-coche-ranked.md): el generador necesita esta misma lista y estos
     mismos mapas inversos, o generaria con la lista de respaldo (38 nombres)
     en vez de los 227 curados. Sin esto, el hilo principal (sin Worker
     disponible) generaria una rejilla DISTINTA a la del Worker con la misma
     semilla. */
  try { if (window.RankedEngine) RankedEngine.setTeammateData(TEAMMATES_LIST, _REVERSE_TEAMMATE, _REVERSE_TEAMMATE_IDS); } catch (e) {}

  /* Máxima transferencia en €  */
  function _maxFee(transfers) {
    if (!transfers || !transfers.length) return 0;
    return Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0));
  }

  /* PLAYERS_DB = solo compañeros_principal, enriquecidos con companeros-data.json
     (datos completos de chunk: img, apps, goals, nt, tr, etc.).
     Pequeño (~227 jugadores) → rápido de recorrer para matches directos.
     Más tarde se enriquece con TODOS los chunks (_enrichPlayersDBFromChunks,
     dispara justo después de esta función) para que findPlayerAsync y los
     bots reconozcan y puedan usar cualquier futbolista real — eso NO se toca.
     La GENERACIÓN de restricciones usa un pool aparte, GEN_POOL (ver más abajo
     en este mismo _loadData), curado por fama para que las rondas salgan
     variadas y generate() no tenga que recorrer los ~8000 jugadores enteros.
     findPlayerAsync usa chunks on-demand para validar respuestas del usuario. */
  const playersDb = Object.entries(companeros).map(([id, pd]) => {
    const chunk = allChunkData[id] || {};
    const ps    = _PERF_MAP[id] || {};
    return {
      id,
      idNum:        parseInt(id, 10),
      name:         pd.name,
      img:          chunk.img  || null,
      aliases:      [],
      teammates:    teammateMap[id]           || [],
      coaches:      coachMap[id]              || [],
      trophies:     [...new Set(trophyMap[id] || [])],
      nationalTeam: chunk.nat                 || null,
      teams:        chunk.teams               || [],
      heightCm:     chunk.h  ? parseFloat(chunk.h)  : null,
      foot:         _normFoot(chunk.f),
      birthYear:    chunk.b  ? parseInt(chunk.b, 10) : null,
      goals:        typeof chunk.goals === 'number' ? chunk.goals : null,
      apps:         typeof chunk.apps  === 'number' ? chunk.apps  : null,
      position:     chunk.p  || null,
      caps:         chunk.nt ? (parseInt((chunk.nt.c !== undefined ? chunk.nt.c : chunk.nt) || '0', 10) || 0) : 0,
      natGoals:     (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0,
      maxFee:       chunk.maxFee ?? _maxFee(chunk.tr ?? []),
      lg:           ps.lg  || [],
      clg:          ps.clg || 0,
      bsg:          ps.bsg || 0,
    };
  });

  /* GEN_POOL: pool aparte de ~1500 jugadores reconocibles (gen_pool.json,
     precomputado por fama con admin/build_coche_perf.py), usado SOLO para
     generar restricciones. Si gen_pool.json no cargó, cae a companeros_principal
     (el comportamiento de antes) — nunca se queda vacío. */
  const poolIds = (Array.isArray(genPool) && genPool.length)
    ? genPool.map(String)
    : Object.keys(companeros);
  GEN_POOL = poolIds.filter(id => allChunkData[id]).map(id => {
    const chunk = allChunkData[id];
    const ps    = _PERF_MAP[id] || {};
    return {
      id,
      idNum:        parseInt(id, 10),
      name:         nameMap[id] || chunk.n || '?',
      img:          chunk.img  || null,
      aliases:      [],
      teammates:    teammateMap[id]           || [],
      coaches:      coachMap[id]              || [],
      trophies:     [...new Set(trophyMap[id] || [])],
      nationalTeam: chunk.nat                 || null,
      teams:        chunk.teams               || [],
      heightCm:     chunk.h  ? parseFloat(chunk.h)  : null,
      foot:         _normFoot(chunk.f),
      birthYear:    chunk.b  ? parseInt(chunk.b, 10) : null,
      goals:        typeof chunk.goals === 'number' ? chunk.goals : null,
      apps:         typeof chunk.apps  === 'number' ? chunk.apps  : null,
      position:     chunk.p  || null,
      caps:         chunk.nt ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0,
      natGoals:     (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0,
      maxFee:       chunk.maxFee ?? _maxFee(chunk.tr ?? []),
      lg:           ps.lg  || [],
      clg:          ps.clg || 0,
      bsg:          ps.bsg || 0,
    };
  });

  return playersDb;
}

/* ═══════════════════════════════════════════════════════════════
   2. RESTRICTIONS
   ═══════════════════════════════════════════════════════════════ */
const Restrictions = (() => {

  /* normalize() era local a este bloque (borrado en la Fase 0 del plan de
     ranked junto con generate()/CLUBS_LIST/etc.) pero validate/findPlayer/
     suggest/Restrictions.normalize la siguen necesitando aqui abajo. Misma
     logica byte a byte en RankedEngine (extraida de este mismo archivo). */
  const normalize = RankedEngine.normalize;

  /* ────────── Generar restricciones (delegado en el motor compartido) ──────────
     PLAN-coche-ranked.md, Fase 0 (2026-08-29): esto era una copia completa de
     coche/js/restrictions-worker.js -- constantes CLUBS_LIST, NATIONALITIES,
     LEAGUE_TEAMS/CIDS/LOGOS, TROPHIES, COACHES_LIST + generate()/_buildCandidates/_matching/
     _isRedundant/_familyUsed/_removeRedundancies/_ensureSolution -- con el
     riesgo de divergencia del que ya avisaba el comentario del "new Worker"
     de mas abajo (el "?v="). _isRedundant()/validate() ya delegaban en FR desde
     2026-08-03; ahora generate() delega en js/ranked-engine.js, que ES ese
     mismo codigo extraido a un modulo cargable en navegador, Worker y Node
     (lo usa tambien coche/js/restrictions-worker.js y el arbitro de
     Clasificatoria, api/ranked.js). Verificado: 300 semillas reales contra
     FR.genPool, 0 discrepancias frente al generador viejo. */
  function generate(seed, db) {
    return RankedEngine.generate(seed, db);
  }

  /* ────────── Validar un jugador contra una restricción ────────── */
  function validate(player, r) {
    /* Dedup: lógica delegada en el motor compartido FR (idéntica, verificada). */
    return FR.validate(player, r);
  }

  function findPlayer(inputName, db) {
    const norm = normalize(inputName);
    if (!norm) return null;
    return db.find(p =>
      normalize(p.name) === norm || (p.aliases || []).some(a => normalize(a) === norm)
    ) || null;
  }

  function validateAll(inputName, restrictions, db) {
    const player = findPlayer(inputName, db);
    if (!player) return { valid:false, player:null, matches:[], matchCount:0 };
    const matches    = restrictions.map(r => validate(player, r));
    const matchCount = matches.filter(Boolean).length;
    return { valid:true, player, matches, matchCount };
  }

  function suggest(input, db, limit = 8) {
    const norm = normalize(input);
    if (!norm || norm.length < 2) return [];
    const fromDB = db.filter(p =>
      normalize(p.name).includes(norm) || (p.aliases || []).some(a => normalize(a).includes(norm))
    ).map(p => ({ id:p.id, name:p.name, inDB:true }));

    const dbIds  = new Set(fromDB.map(p => String(p.id)));
    const fromIdx = NAME_INDEX
      .filter(([id, name]) => !dbIds.has(String(id)) && normalize(name).includes(norm))
      .slice(0, limit - fromDB.length)
      .map(([id, name]) => ({ id:String(id), name, inDB:false }));

    return [...fromDB, ...fromIdx].slice(0, limit);
  }

  return { generate, validate, validateAll, findPlayer, normalize, suggest };
})();

/* ═══════════════════════════════════════════════════════════════
   3. SYNC  —  Firebase Realtime DB
   ═══════════════════════════════════════════════════════════════ */
const Sync = (() => {
  const ROOMS_PATH = 'restricciones/rooms';
  const MM_PATH    = 'restricciones/matchmaking';
  const FB  = () => window._FB;
  function _ref(path) { const {db,ref}=FB(); return ref(db,path); }

  function _genCode() {
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  }
  function _genId() { return Math.random().toString(36).slice(2,10)+Date.now().toString(36); }

  /* Bots: viven en el mismo nodo players que los humanos, pero no cuentan
     para mantener la sala viva ni pueden heredar el host (no tienen
     navegador que ejecute la lógica de la partida). */
  const _isBot = (p) => !!(p && p.isBot);
  function _humanIds(players, exceptId) {
    return Object.keys(players||{}).filter(pid => pid!==exceptId && !_isBot(players[pid]));
  }

  /* ── onDisconnect: qué hace Firebase si ESTE cliente se corta ──
     En el lobby elimina el nodo del jugador (no dejar fantasmas que ocupan
     hueco, duplican al jugador al volver y, si eran host, congelan la sala);
     con la partida en curso solo marca connected:false para permitir
     reconectar sin perder nombre/puntuación. Mismo criterio que Blackjack. */

  /* CANCELAR ANTES DE ARMAR, SIEMPRE.

     Las operaciones de onDisconnect se ACUMULAN en el mismo camino, no se
     sustituyen: si al entrar al lobby se armo un .remove() y luego, al
     empezar la partida, se arma un .update({connected:false}), Firebase se
     queda con el remove ya aplicado y le mete el update encima, o sea que al
     cortarse la conexion escribe el nodo entero como {connected:false} —
     borrando nombre, puntuacion y isHost.

     Eso es exactamente lo que dejaba al anfitrion fuera de su propia partida
     al irse la app a segundo plano: su nodo quedaba SIN NOMBRE, los demas lo
     filtraban de _players (nodo fantasma), el failover promovia a otro y la
     limpieza de fantasmas que hace el anfitrion nuevo lo borraba del todo.
     Al volver, tryReconnect no encontraba su hueco y joinRoom respondia "la
     partida ya ha comenzado".

     Con el cancel() previo, el update en partida solo toca `connected` y el
     nodo sobrevive entero. */
  function _cancelOnDisconnect(path) {
    try {
      if (window._FBOnDisconnect) {
        const {db,ref}=FB();
        window._FBOnDisconnect(ref(db,path)).cancel().catch(()=>{});
      }
    } catch(e) { /* sin onDisconnect no hay nada que cancelar */ }
  }
  function _onDisconnectRemove(path) {
    try {
      if (window._FBOnDisconnect) {
        const {db,ref}=FB();
        _cancelOnDisconnect(path);
        window._FBOnDisconnect(ref(db,path)).remove().catch(()=>{});
      }
    } catch(e) { console.warn('[Sync] onDisconnect no disponible:', e); }
  }
  function _onDisconnectSetConnectedFalse(path) {
    try {
      if (window._FBOnDisconnect) {
        const {db,ref}=FB();
        _cancelOnDisconnect(path);
        window._FBOnDisconnect(ref(db,path)).update({connected:false}).catch(()=>{});
      }
    } catch(e) { console.warn('[Sync] onDisconnect no disponible:', e); }
  }
  /* Rearmar según el estado de la sala (onDisconnect es un hook de servidor:
     no puede consultar el estado en el momento real del corte). */
  function rearmOnDisconnect(code, playerId, roomStatus) {
    const path = `${ROOMS_PATH}/${code}/players/${playerId}`;
    if (roomStatus==='waiting' || roomStatus==='resetting') _onDisconnectRemove(path);
    else _onDisconnectSetConnectedFalse(path);
  }

  async function createRoom(hostName, avatar) {
    const {set,serverTimestamp}=FB();
    const code=_genCode(), hostId=_genId();
    await set(_ref(`${ROOMS_PATH}/${code}`),{
      status:'waiting', round:0, pointsToWin:7, roundSecs:60,
      isPublic:false, createdAt:Date.now(), lobbyAt:Date.now(),
      players:{[hostId]:{name:hostName,avatar:avatar||null,score:0,connected:true,isHost:true}},
      restrictions:null, roundSeed:0, roundStartAt:null,
      submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
    });
    _onDisconnectRemove(`${ROOMS_PATH}/${code}/players/${hostId}`);
    return {code, playerId:hostId};
  }

  async function joinRoom(code, playerName, avatar, allowRanked) {
    const {get,update}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');
    const room = snap.val();
    /* Clasificatoria no se une a mano por código: solo por emparejamiento
       (_unirseAPartidaEmparejada pasa allowRanked=true). Sin este freno, el
       código/enlace de una sala ranked (que se enseñaba igual que el de una
       privada) dejaba entrar a un tercero a un "1 contra 1". */
    if (room.isRanked && !allowRanked) throw new Error('Esa sala es de Clasificatoria: solo se entra por emparejamiento');
    if (room.status !== 'waiting') throw new Error('La partida ya ha comenzado');
    const count = Object.keys(room.players||{}).length;
    if (room.isRanked && count >= 2) throw new Error('Esa partida clasificatoria ya tiene sus dos jugadores');
    if (count >= 5) throw new Error('Sala llena (máx. 5 jugadores)');
    const playerId = _genId();
    await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
      name:playerName, avatar:avatar||null, score:0, connected:true, isHost:false,
    });
    _onDisconnectRemove(`${ROOMS_PATH}/${code}/players/${playerId}`);
    return {code, playerId};
  }

  /* ── Reconexión: reusar el hueco de una sesión anterior ──
     Evita el bug de "salgo dos veces en la sala": al recargar la pestaña,
     el jugador guardado en sessionStorage se reutiliza en vez de crear un
     segundo nodo con el mismo nombre. Devuelve true si reconectó.

     Antes exigía status==='waiting', así que volver a la app A MITAD DE
     RONDA (el móvil mata la pestaña de verdad, no solo la oculta — típico
     tras una llamada) nunca reconectaba: caía al respaldo de _volverALaSala
     (Sync.joinRoom), que TAMBIÉN exige 'waiting' y lanza "La partida ya ha
     comenzado". El jugador se quedaba fuera de su propia partida —contra
     bots, sin nadie más que pueda cerrar la ronda— hasta que la sala
     expirase. Ahora solo se bloquea 'expired' (sala ya cerrada de verdad);
     el nodo del jugador sigue existiendo en 'playing'/'reveal' porque ahí
     el onDisconnect solo pone connected:false, no lo borra (rearmOnDisconnect). */
  async function tryReconnect(code, playerId, name, avatar) {
    const {get,update}=FB();
    try {
      const roomSnap = await get(_ref(`${ROOMS_PATH}/${code}`));
      if (!roomSnap.exists()) return false;
      if (roomSnap.val().status === 'expired') return false;
      const playerSnap = await get(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`));
      if (!playerSnap.exists()) return false;
      await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
        connected:true, name, avatar:avatar||null,
      });
      /* Rearmar según el estado real de la sala (en partida, solo marcar
         connected:false al próximo corte; en waiting, sí se puede borrar). */
      rearmOnDisconnect(code, playerId, roomSnap.val().status);
      /* Se devuelve el status (verdadero igualmente) para que quien llama
         sepa si está reconectando a un lobby o a una partida ya en marcha
         y no fuerce la pantalla de espera encima de una ronda en curso. */
      return roomSnap.val().status || true;
    } catch(e) { return false; }
  }

  /* ── Volver a primer plano tras un corte ──
     Al irse la app a segundo plano (cambiar de app, bloquear la pantalla)
     el móvil cierra el socket de Firebase y salta el onDisconnect: en
     partida deja al jugador con connected:false. Al volver, Firebase
     reconecta solo pero NADIE vuelve a poner connected:true, así que el
     jugador se queda de fantasma: no cuenta para el recuento de respuestas
     y en el lobby desaparece de la lista. Además el onDisconnect ya se
     consumió, así que hay que volver a armarlo. */
  async function resume(code, playerId, roomStatus) {
    const {get,update}=FB();
    try {
      const snap = await get(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`));
      if (!snap.exists()) return false;
      if (snap.val().connected === false) {
        await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`), {connected:true});
      }
      rearmOnDisconnect(code, playerId, roomStatus);
      return true;
    } catch(e) { console.warn('[Sync] resume error:', e); return false; }
  }

  async function findOrCreatePublicRoom(playerName, avatar) {
    const {get,set,update}=FB();
    const snap = await get(_ref(MM_PATH));
    const candidates = [];
    if (snap.exists()) {
      for (const [code, data] of Object.entries(snap.val())) {
        if (data && typeof data==='object' && data.status==='waiting') candidates.push(code);
      }
    }
    for (const code of candidates) {
      try {
        const roomSnap = await get(_ref(`${ROOMS_PATH}/${code}`));
        if (!roomSnap.exists() || roomSnap.val().status!=='waiting') {
          set(_ref(`${MM_PATH}/${code}`), null).catch(()=>{});
          continue;
        }

        /* Sala zombie: lleva más de 3 min en lobby sin empezar. Pasaba
           cuando el host se iba sin pulsar Salir (fantasma): nadie corría
           su timer de expiración y la sala quedaba atrapando jugadores
           para siempre. Expirar y seguir buscando. */
        const lobbyAt = roomSnap.val().lobbyAt || 0;
        if (lobbyAt > 0 && (Date.now() - lobbyAt) > 3*60*1000) {
          console.log(`[Sync] Sala zombie detectada (${code}), limpiando…`);
          expirePublicRoom(code).catch(()=>{});
          continue;
        }

        const result = await joinRoom(code, playerName, avatar);
        const newCount = Object.keys(roomSnap.val().players||{}).length + 1;
        update(_ref(`${MM_PATH}/${code}`),{playerCount:newCount}).catch(()=>{});
        return {...result, isHost:false, isPublic:true};
      } catch(e) {
        console.warn(`[Sync] Sala pública ${code} no disponible:`, e.message);
        set(_ref(`${MM_PATH}/${code}`), null).catch(()=>{});
      }
    }
    const myCode = _genCode(), myId = _genId();
    await set(_ref(`${MM_PATH}/${myCode}`),{code:myCode, status:'waiting', playerCount:1});
    try {
      await set(_ref(`${ROOMS_PATH}/${myCode}`),{
        status:'waiting', round:0, pointsToWin:7, roundSecs:60,
        isPublic:true, createdAt:Date.now(), lobbyAt:Date.now(),
        players:{[myId]:{name:playerName,avatar:avatar||null,score:0,connected:true,isHost:true}},
        restrictions:null, roundSeed:0, roundStartAt:null,
        submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
      });
      _onDisconnectRemove(`${ROOMS_PATH}/${myCode}/players/${myId}`);
    } catch(e) {
      set(_ref(`${MM_PATH}/${myCode}`), null).catch(()=>{});
      throw e;
    }
    return {code:myCode, playerId:myId, isHost:true, isPublic:true};
  }

  function listenRoom(code, callback) {
    const {onValue}=FB();
    return onValue(_ref(`${ROOMS_PATH}/${code}`), snap => {
      if (!snap.exists()) return;
      callback(snap.val());
    });
  }

  async function startGame(code, roundData) {
    const {update}=FB();
    await update(_ref(`${ROOMS_PATH}/${code}`),{
      status:'playing', round:1,
      roundSeed:roundData.seed, restrictions:roundData.restrictions,
      roundStartAt:Date.now(), submissions:{}, lockedPlayers:{}, doneCount:0, results:null,
      pointsToWin: roundData.pointsToWin ?? 7,
      roundSecs:   roundData.roundSecs   ?? 60,
      isSuddenDeath: false, suddenDeathPlayers: [],
    });
    update(_ref(`${MM_PATH}/${code}`),{status:'started'}).catch(()=>{});
  }

  async function nextRound(code, roundNum, roundData, updatedPlayers) {
    const {update}=FB();
    const batch = {};
    batch[`${ROOMS_PATH}/${code}/status`]             = 'playing';
    batch[`${ROOMS_PATH}/${code}/round`]              = roundNum;
    batch[`${ROOMS_PATH}/${code}/roundSeed`]          = roundData.seed;
    batch[`${ROOMS_PATH}/${code}/restrictions`]       = roundData.restrictions;
    batch[`${ROOMS_PATH}/${code}/roundStartAt`]       = Date.now();
    batch[`${ROOMS_PATH}/${code}/submissions`]        = {};
    batch[`${ROOMS_PATH}/${code}/lockedPlayers`]      = {};
    batch[`${ROOMS_PATH}/${code}/doneCount`]          = 0;
    batch[`${ROOMS_PATH}/${code}/results`]            = null;
    batch[`${ROOMS_PATH}/${code}/pointsToWin`]        = roundData.pointsToWin ?? 7;
    batch[`${ROOMS_PATH}/${code}/roundSecs`]          = roundData.roundSecs   ?? 60;
    batch[`${ROOMS_PATH}/${code}/isSuddenDeath`]      = roundData.isSuddenDeath      ?? false;
    batch[`${ROOMS_PATH}/${code}/suddenDeathPlayers`] = roundData.suddenDeathPlayers ?? [];
    for (const p of updatedPlayers) {
      batch[`${ROOMS_PATH}/${code}/players/${p.id}/score`] = p.score;
    }
    await update(_ref('/'), batch);
  }

  async function submitAnswer(code, playerId, footballerName, footballerId) {
    const {update,runTransaction,get}=FB();
    const lockKey = Restrictions.normalize(footballerName)
      .replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'');
    if (!lockKey) throw new Error('Nombre inválido');

    /* runTransaction puede reintentar el callback varias veces ante conflictos.
       La variable 'locked' debe reflejar el resultado del ÚLTIMO intento,
       no del primero. Además, al retornar undefined para abortar,
       Firebase no lanza error — hay que verificar post-transacción. */
    const result = await runTransaction(
      _ref(`${ROOMS_PATH}/${code}/lockedPlayers/${lockKey}`),
      current => {
        if (current !== null && current !== undefined) return;  /* abortar: ya ocupado */
        return playerId;
      }
    );

    /* result.committed === false cuando la transacción se abortó (retornó undefined).
       Doble verificación: leer el valor final para confirmar que ESTE jugador lo bloqueó,
       ya que en condiciones de alta concurrencia el committed puede ser ambiguo. */
    if (!result.committed) {
      throw new Error('Este futbolista ya fue elegido por otro jugador');
    }
    const finalVal = result.snapshot.val();
    if (finalVal !== playerId) {
      throw new Error('Este futbolista ya fue elegido por otro jugador');
    }

    await update(_ref(`${ROOMS_PATH}/${code}/submissions/${playerId}`),{
      playerName:footballerName, footballerId:footballerId||null, submittedAt:Date.now(),
    });
    const res = await runTransaction(
      _ref(`${ROOMS_PATH}/${code}/doneCount`), cur => (cur||0)+1
    );
    return res.snapshot.val();
  }

  async function startReveal(code, results, updatedPlayers) {
    const {get,update,runTransaction}=FB();

    /* Verificar que la partida sigue en 'playing' antes de proceder */
    const snap = await get(_ref(`${ROOMS_PATH}/${code}/status`));
    if (!snap.exists() || snap.val() !== 'playing') return;

    /* Escribir resultados y puntuaciones ANTES de cambiar el status.
       Asi cuando el listener reciba status='reveal', los resultados ya estan disponibles. */
    const batch = {};
    batch[`${ROOMS_PATH}/${code}/results`]     = results;
    batch[`${ROOMS_PATH}/${code}/revealStart`] = Date.now();
    updatedPlayers.forEach(p=>{
      batch[`${ROOMS_PATH}/${code}/players/${p.id}/score`] = p.score;
    });
    await update(_ref('/'), batch);

    /* Ahora si cambiar el status a 'reveal' — los clientes veran results ya disponibles */
    await runTransaction(_ref(`${ROOMS_PATH}/${code}/status`), current => {
      if (current==='playing') return 'reveal';
      return undefined;
    });
  }

  async function setFinished(code, winnerId, updatedPlayers) {
    const {update}=FB();
    const batch = { [`${ROOMS_PATH}/${code}/status`]:'finished', [`${ROOMS_PATH}/${code}/winnerId`]:winnerId };
    for (const p of updatedPlayers) {
      batch[`${ROOMS_PATH}/${code}/players/${p.id}/score`] = p.score;
    }
    await update(_ref('/'), batch);
  }

  /* Reclama atómicamente el derecho a resetear la sala tras "Jugar de nuevo".
     Sólo UN cliente gana la transición desde un estado terminal/no-waiting
     hacia 'resetting'. El ganador hace resetToLobby; los demás re-unirse.
     Devuelve true si ESTE cliente ganó la reclamación. */
  async function claimReset(code) {
    const {runTransaction}=FB();
    const result = await runTransaction(_ref(`${ROOMS_PATH}/${code}/status`), current => {
      /* Si ya está en waiting o resetting → otro jugador ya lo gestiona, abortar */
      if (current === 'waiting' || current === 'resetting') return;
      /* Si la sala expiró o no existe, abortar */
      if (current === 'expired' || current === null || current === undefined) return;
      /* finished / reveal / playing → reclamamos el reset */
      return 'resetting';
    });
    return result.committed && result.snapshot.val() === 'resetting';
  }

  async function resetToLobby(code, players, newHostId) {
    const {update,get}=FB();
    /* Solo incluir al jugador que pulsó "Jugar de nuevo" como host.
       Los demás se re-unirán cuando ellos pulsen el botón. */
    const hostPlayer = players[newHostId];
    const resetPlayers = {
      [newHostId]: {
        name: hostPlayer?.name || '…',
        avatar: hostPlayer?.avatar || null,
        score: 0,
        connected: true,
        isHost: true,
      },
    };
    await update(_ref(`${ROOMS_PATH}/${code}`),{
      status:'waiting', round:0, roundSeed:0, restrictions:null, roundStartAt:null,
      submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
      lobbyAt:Date.now(), resetAt:Date.now(), players:resetPlayers,
    });
    try {
      const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
      if (snap.exists() && snap.val().isPublic) {
        await update(_ref(`${MM_PATH}/${code}`),{
          status:'waiting', playerCount:1,
        });
      }
    } catch(e) {}
  }

  /* Re-unirse a una sala existente en waiting (para "Jugar de nuevo" de no-hosts) */
  async function rejoinRoom(code, playerId, playerName, avatar) {
    const {get,update}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');
    const room = snap.val();
    if (room.status !== 'waiting') throw new Error('La partida ya ha comenzado');
    const count = Object.keys(room.players||{}).length;
    if (count >= 5) throw new Error('Sala llena (máx. 5 jugadores)');
    await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
      name:playerName, avatar:avatar||null, score:0, connected:true, isHost:false,
    });
    _onDisconnectRemove(`${ROOMS_PATH}/${code}/players/${playerId}`);
  }

  /* Volver a una partida YA EMPEZADA reocupando tu propio hueco.
     rejoinRoom exige 'waiting' porque es la de "jugar de nuevo"; esta es para
     el caso contrario: te fuiste a segundo plano en mitad de la ronda, tu nodo
     desaparecio y al volver no hay hueco que reconectar. Se reescribe con TU
     playerId de siempre (no se duplica) y con la puntuacion que tuvieras, que
     el cliente conserva de la ultima foto de la sala. */
  async function rejoinInProgress(code, playerId, playerName, avatar, score, wasHost) {
    const {get,update}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');
    const room = snap.val();
    if (room.status === 'expired') throw new Error('La sala expiró');
    if (room.status === 'waiting' || room.status === 'resetting')
      throw new Error('La sala volvió al lobby');
    /* La corona NO se recupera sola: si mientras faltabas promovieron a otro,
       el que manda es el que esta dentro. Solo se conserva si nadie la tiene. */
    const hayHost = Object.values(room.players||{}).some(p => p && p.isHost===true && p.connected!==false);
    /* Si el nodo sigue ahi (solo se perdio la conexion), manda SU puntuacion:
       la que traiga quien llama es un respaldo para cuando el nodo ya no
       existe, y pisar la buena con ella seria robarle puntos al jugador. */
    const previo = (room.players||{})[playerId];
    const pts = previo && typeof previo.score === 'number' ? previo.score : (Number(score)||0);
    await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
      name:playerName, avatar:avatar||null, score:pts,
      connected:true, isHost: (!hayHost && !!wasHost),
    });
    rearmOnDisconnect(code, playerId, room.status);
    return { isHost: (!hayHost && !!wasHost) };
  }

  async function expirePublicRoom(code) {
    const {update,remove}=FB();
    try {
      await update(_ref(`${ROOMS_PATH}/${code}`),{status:'expired'});
      setTimeout(()=>{
        remove(_ref(`${MM_PATH}/${code}`)).catch(()=>{});
        remove(_ref(`${ROOMS_PATH}/${code}`)).catch(()=>{});
      }, 4000);
    } catch(e) { console.warn('[Sync] expirePublicRoom error:', e); }
  }

  async function disconnect(code, playerId) {
    const {get,update,remove}=FB();
    try {
      const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
      if (!snap.exists()) return;
      const room = snap.val();
      if (room.status==='waiting' || room.status==='resetting') {
        await remove(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`));
        /* Solo los humanos mantienen la sala en pie: si se va el último,
           se cierra aunque queden bots dentro. */
        const humans = _humanIds(room.players, playerId);
        if (humans.length===0) {
          /* Sala vacía → eliminarla (pública o privada) para no dejar basura */
          remove(_ref(`${ROOMS_PATH}/${code}`)).catch(()=>{});
          if (room.isPublic) remove(_ref(`${MM_PATH}/${code}`)).catch(()=>{});
        } else if (room.isPublic) {
          update(_ref(`${MM_PATH}/${code}`),{playerCount:humans.length}).catch(()=>{});
        }
        if (humans.length>0 && room.players?.[playerId]?.isHost) {
          const nextPid = humans[0];
          if (nextPid) update(_ref(`${ROOMS_PATH}/${code}/players/${nextPid}`),{isHost:true}).catch(()=>{});
        }
      } else {
        await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{connected:false});
        /* Failover de host en partida: si el host se desconecta a mitad,
           promover a otro jugador conectado para que el juego no se congele
           (nadie dispararía reveal / siguiente ronda). */
        if (room.players?.[playerId]?.isHost) {
          const nextPid = _humanIds(room.players, playerId)
            .find(pid => room.players[pid]?.connected!==false);
          if (nextPid) {
            update(_ref(`${ROOMS_PATH}/${code}/players/${nextPid}`),{isHost:true}).catch(()=>{});
            update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{isHost:false}).catch(()=>{});
          }
        }
      }
    } catch(e) { console.warn('[Sync] disconnect error:', e); }
  }

  async function getRoom(code) {
    const {get}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) return null;
    return snap.val();
  }

  async function updateRoomSettings(code, settings) {
    const {update}=FB();
    await update(_ref(`${ROOMS_PATH}/${code}`), settings);
  }

  /* ── CLASIFICATORIA (ranked 1v1) ──
     Misma sala que Privada/Pública (reutiliza toda la máquina de
     rondas/reveal/reconexión ya probada), marcada con isRanked+matchId+
     seedBase. isPublic:false a propósito: no lleva bots ni ajustes
     editables, y el código no se comparte (se entra por emparejamiento,
     nunca a mano). */
  async function createRankedRoom(hostName, avatar, matchId, seedBase) {
    const {set}=FB();
    const code=_genCode(), hostId=_genId();
    await set(_ref(`${ROOMS_PATH}/${code}`),{
      status:'waiting', round:0, pointsToWin:5, roundSecs:45,
      isPublic:false, isRanked:true, rankedMatchId:matchId, rankedSeedBase:seedBase,
      createdAt:Date.now(), lobbyAt:Date.now(),
      players:{[hostId]:{name:hostName,avatar:avatar||null,score:0,connected:true,isHost:true}},
      restrictions:null, roundSeed:0, roundStartAt:null,
      submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
    });
    _onDisconnectRemove(`${ROOMS_PATH}/${code}/players/${hostId}`);
    return {code, playerId:hostId};
  }

  /* Cola de emparejamiento: NO decide el resultado, solo con quién juegas
     (ver PLAN-coche-ranked.md §6.1) — manipularla en el peor caso solo
     cambia el rival, nunca el ELO que se aplica al cerrar la partida. */
  const RANKED_QUEUE_PATH = 'restricciones/ranked_queue';
  const RANKED_PAIR_PATH  = 'restricciones/ranked_pairings';

  async function rankedQueueJoin(uid, elo, name, avatar) {
    const {set}=FB();
    await set(_ref(`${RANKED_QUEUE_PATH}/${uid}`), { elo, ts: Date.now(), name, avatar: avatar||null });
    _onDisconnectRemove(`${RANKED_QUEUE_PATH}/${uid}`);
  }
  async function rankedQueueLeave(uid) {
    const {set}=FB();
    _cancelOnDisconnect(`${RANKED_QUEUE_PATH}/${uid}`);
    await set(_ref(`${RANKED_QUEUE_PATH}/${uid}`), null);
  }
  function rankedListenQueue(callback) {
    const {onValue}=FB();
    return onValue(_ref(RANKED_QUEUE_PATH), snap => callback(snap.exists() ? snap.val() : {}));
  }
  async function rankedAnnouncePairing(targetUid, payload) {
    const {set}=FB();
    await set(_ref(`${RANKED_PAIR_PATH}/${targetUid}`), payload);
  }
  function rankedListenPairing(uid, callback) {
    const {onValue}=FB();
    return onValue(_ref(`${RANKED_PAIR_PATH}/${uid}`), snap => { if (snap.exists()) callback(snap.val()); });
  }
  async function rankedClearPairing(uid) {
    const {set}=FB();
    await set(_ref(`${RANKED_PAIR_PATH}/${uid}`), null);
  }

  return {
    createRoom, joinRoom, findOrCreatePublicRoom, listenRoom,
    startGame, nextRound, submitAnswer, startReveal, setFinished,
    resetToLobby, claimReset, rejoinRoom, rejoinInProgress, expirePublicRoom, disconnect, getRoom, updateRoomSettings,
    tryReconnect, rearmOnDisconnect, resume,
    createRankedRoom, rankedQueueJoin, rankedQueueLeave, rankedListenQueue,
    rankedAnnouncePairing, rankedListenPairing, rankedClearPairing,
  };
})();

/* ═══════════════════════════════════════════════════════════════
   4. APP  —  Coordinador principal
   ═══════════════════════════════════════════════════════════════ */
const App = (() => {

  let _roomCode   = null;
  let _playerId   = null;
  let _isHost     = false;
  let _isPublic   = false;
  let _unsubRoom  = null;
  let _lastRoom   = null;
  /* Token de sesión: se incrementa cada vez que entras/sales de una sala.
     Cualquier operación asíncrona (cargar datos, generar restricciones,
     arrancar partida) captura el token al empezar y se cancela a sí misma
     si el token ha cambiado al terminar. Evita que un "startGame" lento
     escriba sobre una sala distinta a la que iniciaste la acción. */
  let _sessionToken = 0;
  function _newSession() { return ++_sessionToken; }
  /* _isLocal se queda siempre en false (PLAN-coche-ranked.md, Fase 1: modo
     Local eliminado). No se borra de los sitios donde forma parte de una
     condicion compuesta (p.ej. "_isHost && !_isLocal && _isPublic") para no
     tocar ramas de Privada/Publica ya probadas en produccion -- sencillamente
     nunca vuelve a valer true, asi que esas ramas se comportan igual que
     antes de este cambio. _localName SIGUE viva: pese al nombre es el nombre
     de sesion general (Privada/Publica lo usan tambien), no algo del modo
     Local. */
  let _isLocal    = false;
  let _localName  = '';

  /* Clasificatoria (ranked 1v1 por ELO). Fase 1-3 de PLAN-coche-ranked.md. */
  let _isRanked       = false;
  let _rankedMatchId  = null;
  let _rankedSeedBase = 0;

  let _round           = 0;
  let _players         = [];
  let _restrictions    = [];
  let _submitted       = false;
  let _mySubmission    = null;
  let _mySubmissionId  = null;
  let _revealTriggered = false;
  let _wantReplay      = false;   /* Bug 2: solo vuelves al lobby si pulsas "Jugar de nuevo" */

  let _timerInterval  = null;
  /* Guardamos el inicio real (timestamp) y la duración para poder
     reconstruir el intervalo si el navegador lo detiene al pasar la
     app a segundo plano (bug: el temporizador se paraba para siempre
     al volver de segundo plano en móvil). */
  let _timerStartAt   = null;
  let _timerTotalSecs = null;
  const ROUND_SECS    = 60;
  const POINTS_WIN    = 7;   // default

  let _publicLobbyTimer     = null;
  let _publicLobbyWarnTimer = null;
  const PUBLIC_LOBBY_TIMEOUT = 3 * 60 * 1000;
  const PUBLIC_LOBBY_WARN    = 30 * 1000;

  /* Ajustes online (solo host puede cambiarlos en lobby) */
  let _onlinePointsToWin = 7;
  let _onlineRoundSecs   = 60;

  /* Muerte súbita */
  const SUDDEN_DEATH_SECS = 20;
  let _isSuddenDeath      = false;
  let _suddenDeathPlayers = [];   // ids de los jugadores en muerte súbita

  let _toastTimeout = null;

  /* Cache de restricciones pregeneradas para la siguiente ronda */
  let _nextRestrictionsCache = null;

  /* ── Genera restricciones en un Web Worker (hilo separado).
     Devuelve una Promise con el array de restricciones.
     Si el navegador no soporta Worker, cae en sincrónico. ── */
  function _generateAsync(seed, db) {
    return new Promise((resolve, reject) => {
      if (typeof Worker === 'undefined') {
        try { resolve(Restrictions.generate(seed, db)); } catch(e) { reject(e); }
        return;
      }
      let settled = false;
      let worker;
      /* Timeout de seguridad: si el worker no responde en 6s (cuelgue, bucle
         infinito de generación, etc.), abortamos y caemos al modo sincrónico.
         Sin esto, "CARGANDO…" se quedaría para siempre — y con 15s el usuario
         llega a pensar que el botón de "siguiente ronda" no ha hecho nada. */
      const killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { worker && worker.terminate(); } catch(e) {}
        console.warn('[App] Worker timeout — generando restricciones de forma sincrónica');
        try { resolve(Restrictions.generate(seed, db)); } catch(err) { reject(err); }
      }, 6000);
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        try { worker && worker.terminate(); } catch(e) {}
        fn();
      };
      try {
        /* Con version: el worker delega en js/ranked-engine.js (un solo generador,
           PLAN-coche-ranked.md Fase 0), pero sigue haciendo falta el ?v= — sin
           el cache-buster, un navegador con el worker.js viejo en caché no
           recargaria ranked-engine.js hasta que el navegador decida revalidar
           por su cuenta, y mientras tanto seguiria siendo el mismo archivo (no
           hay copia que diverja, pero si el motor compartido cambia de version
           conviene forzar la recarga igualmente). */
        worker = new Worker('js/restrictions-worker.js?v=20260829a');
      } catch(e) {
        finish(() => { try { resolve(Restrictions.generate(seed, db)); } catch(err){ reject(err); } });
        return;
      }
      worker.onmessage = ({ data }) => {
        if (data.ok) finish(() => resolve(data.restrictions));
        else finish(() => { try { resolve(Restrictions.generate(seed, db)); } catch(err){ reject(new Error(data.error||'Worker error')); } });
      };
      worker.onerror = (e) => {
        /* Fallback sincrónico si el worker falla (p.ej. file:// sin CORS) */
        finish(() => { try { resolve(Restrictions.generate(seed, db)); } catch(err) { reject(err); } });
      };
      /* Sets no sobreviven structured clone (postMessage) → convertir a arrays */
      const rtSerialized = {};
      for (const [k, v] of Object.entries(_REVERSE_TEAMMATE)) {
        rtSerialized[k] = v instanceof Set ? [...v] : (Array.isArray(v) ? v : []);
      }
      const rtIdsSerialized = {};
      for (const [k, v] of Object.entries(_REVERSE_TEAMMATE_IDS)) {
        rtIdsSerialized[k] = v instanceof Set ? [...v] : (Array.isArray(v) ? v : []);
      }
      worker.postMessage({
        seed,
        db,
        reverseTeammate:    rtSerialized,
        reverseTeammateIds: rtIdsSerialized,
        /* Fuente unica de la lista de compañeros: la construye este hilo desde
           compañeros_principal.json y el worker la usa tal cual, en vez de
           llevar su propia copia escrita a mano que podria divergir. */
        teammates:          TEAMMATES_LIST,
      });
    });
  }

  /* ════════════════════════════════════════
     CARGA DE DATOS — patrón Blackjack
     Una sola promesa, errores visibles inmediatamente.
     ════════════════════════════════════════ */
  let _dataPromise    = null;

  /* Todos los chunks del servidor */
  const ALL_CHUNKS_LIST = [
    '0-99999','100000-199999','200000-299999','300000-399999','400000-499999',
    '500000-599999','600000-699999','700000-799999','800000-899999','900000-999999',
    '1000000-1099999','1100000-1199999','1200000-1299999','1300000-1399999','1400000-1499999',
  ];

  async function _loadGameData() {
    if (PLAYERS_DB.length > 0) return PLAYERS_DB;   // ya cargado
    if (_dataPromise) return _dataPromise;            // en curso

    _dataPromise = _loadData()
      .then(db => {
        if (!db || db.length === 0) {
          _dataPromise = null;
          throw new Error('Los archivos de datos están vacíos — comprueba que la carpeta data/ existe y contiene los JSON');
        }
        PLAYERS_DB = db;
        console.log(`✅ PLAYERS_DB: ${db.length} jugadores`);
        /* Si los chunks ya se cargaron antes de que el usuario empezara,
           enriquecer ahora que PLAYERS_DB ya existe */
        _enrichPlayersDBFromChunks();
        return PLAYERS_DB;
      })
      .catch(e => {
        _dataPromise = null;
        throw e;
      });

    return _dataPromise;
  }

  /* Precarga silenciosa en background al abrir el menú */
  function _preloadDataInBackground() {
    if (PLAYERS_DB.length > 0 || _dataPromise) return;
    _loadGameData().catch(() => {});
  }

  /* ════════════════════════════════════════
     ENRIQUECER PLAYERS_DB CON TODOS LOS CHUNKS
     Cuando los chunks terminan de cargarse en background,
     añade TODOS los jugadores de chunks que no estén ya
     en PLAYERS_DB. Esto amplía el pool de generate/validate/findPlayer
     de ~227 a ~8000+ jugadores.
     generate() ahora es rápido con 8000+ gracias a _matching con early-exit
     y _ensureSolution con DB pre-filtrada por clubs.
     ════════════════════════════════════════ */
  let _dbEnriched = false;
  function _enrichPlayersDBFromChunks() {
    if (_dbEnriched || PLAYERS_DB.length === 0) return false;
    const hasChunks = Object.values(_chunkCache).some(c => c && c.__full);
    if (!hasChunks) return false;
    _dbEnriched = true;

    const existingIds = new Set(PLAYERS_DB.map(p => p.id));
    let added = 0;

    for (const [cf, chunkObj] of Object.entries(_chunkCache)) {
      if (!chunkObj || !chunkObj.__full) continue;
      for (const [id, chunk] of Object.entries(chunkObj)) {
        if (id === '__full') continue;
        if (existingIds.has(id)) continue;
        const player = _buildPlayerFromChunk(id, chunk);
        if (player && player.name !== '?') {
          PLAYERS_DB.push(player);
          existingIds.add(id);
          added++;
        }
      }
    }
    if (added > 0) {
      console.log(`✅ PLAYERS_DB enriquecido: +${added} jugadores → ${PLAYERS_DB.length} total`);
    }
    return true;
  }

  /* ════════════════════════════════════════
     CUENTA ATRÁS + PRECARGA DE CHUNKS
     Muestra un overlay con espera mínima y,
     si todavía faltan datos, extiende la carga
     hasta que todo esté realmente preparado.
     ════════════════════════════════════════ */
  let _preloadCountdownIv = null;

  function _showPreloadCountdown(seed, onDone) {
    const MIN_PRELOAD_SECONDS = 10;
    let overlay = document.getElementById('countdown-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'countdown-overlay';
      overlay.className = 'countdown-overlay hidden';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="countdown-inner">
        <div class="countdown-label">CARGANDO JUGADORES</div>
        <div id="countdown-number" class="countdown-number">${MIN_PRELOAD_SECONDS}</div>
      </div>`;
    overlay.classList.remove('hidden');
    /* Bug móvil: ocultar por completo el área de envío mientras el overlay
       está visible, para que nunca puedan solaparse aunque el overlay no
       cubra el 100% del viewport visible en algunos navegadores móviles. */
    document.body.classList.add('countdown-active');

    const numEl = document.getElementById('countdown-number');
    let dataReady        = false;
    let countdownDone    = false;
    let generationDone   = false;
    let doneCalled       = false;

    function _tryDone() {
      if (doneCalled) return;
      if (dataReady && countdownDone && generationDone) {
        doneCalled = true;
        if (_preloadCountdownIv) { clearInterval(_preloadCountdownIv); _preloadCountdownIv=null; }
        overlay.classList.add('hidden');
        document.body.classList.remove('countdown-active');
        onDone();
      }
    }

    /* Cargar chunks */
    async function _ensureAllChunksLoaded() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const results = await Promise.all(ALL_CHUNKS_LIST.map(async c => {
          const cf = `../data/players/chunks/${c}.json`;
          if (_chunkCache[cf]?.__full) return true;
          try {
            const data = await _fetchChunkRangeFromSupabase(cf);
            if (!data) return false;
            data.__full = true;
            _chunkCache[cf] = data;
            return true;
          } catch { return false; }
        }));
        const failed = results.filter(r => !r).length;
        if (failed === 0) {
          _chunksPreloaded = true;
          if (!_chunksPromise) _chunksPromise = Promise.resolve();
          return;
        }
        _chunksPromise = null;
        if (attempt < 2) await new Promise(res => setTimeout(res, 1000));
      }
      _chunksPreloaded = true;
      if (!_chunksPromise) _chunksPromise = Promise.resolve();
    }
    _ensureAllChunksLoaded().then(() => _enrichPlayersDBFromChunks());

    /* Cargar datos y luego lanzar generación en el worker */
    _loadGameData()
      .then(db => {
        dataReady = true;
        _tryDone();
        /* Lanzar generación en worker en cuanto tengamos datos — corre en paralelo con el countdown */
        return _generateAsync(seed, db);
      })
      .then(restrictions => {
        _nextRestrictionsCache = restrictions;
        generationDone = true;
        console.log('[App] Restricciones generadas en worker ✓');
        _tryDone();
      })
      .catch(() => {
        dataReady      = true;
        generationDone = true;  /* fallback: _startLocalRound generará sincrónicamente */
        _tryDone();
      });

    /* Countdown basado en Date.now() — inmune al drift */
    const startAt = Date.now();
    if (_preloadCountdownIv) clearInterval(_preloadCountdownIv);
    _preloadCountdownIv = setInterval(() => {
      const elapsed   = Math.floor((Date.now() - startAt) / 1000);
      const remaining = Math.max(0, MIN_PRELOAD_SECONDS - elapsed);

      if (remaining > 0) {
        if (numEl) numEl.textContent = String(remaining);
      } else if (!countdownDone && !(dataReady && generationDone)) {
        if (numEl) numEl.textContent = '⏳';
      }

      if (remaining <= 0 && !countdownDone) {
        countdownDone = true;
        _tryDone();
      }
    }, 200);
  }

  /* Si hay sesión, ocultar los campos de "Tu nombre" (se usará el usuario)
     y mostrar un aviso. Reacciona también si entra/sale de la sesión. */
  /* Empuja mi nombre y mi foto al nodo de la sala.
     Hace falta porque la identidad (sesión + perfil) se resuelve por red: si
     entras a la sala antes de que llegue, tu jugador se guarda sin foto y en
     el lobby sale la inicial para siempre. Al resolverse (o al cambiar de
     cuenta) lo corregimos sobre la marcha. */
  function _syncMyIdentityToRoom() {
    if (_isLocal || !_roomCode || !_playerId) return;
    const id = window.FHAuth && FHAuth.identity && FHAuth.identity();
    if (!id) return;
    /* Solo escribir si de verdad hay algo que corregir: esta función se llama
       en cada refresco del lobby y no debe generar una escritura por refresco. */
    const mine = _lastRoom?.players?.[_playerId];
    if (mine && mine.name === id.username && (mine.avatar || null) === (id.avatarUrl || null)) return;
    try {
      const {db, ref, update} = window._FB;
      update(ref(db, `restricciones/rooms/${_roomCode}/players/${_playerId}`), {
        name:   id.username,
        avatar: id.avatarUrl || null,
      }).catch(()=>{});
    } catch(e) {}
  }

  function _setupAccountName() {
    if (!(window.FHAuth && FHAuth.onIdentity)) return;
    const NAME_INPUTS = ['input-host-name','input-join-name','input-public-name'];
    FHAuth.onIdentity(id => {
      _syncMyIdentityToRoom();
      if (_currentScreen() === 'screen-menu') _refreshRankedPanel();
      NAME_INPUTS.forEach(i => {
        const el = document.getElementById(i);
        if (el) el.style.display = id ? 'none' : '';
      });
      document.querySelectorAll('.account-name-hint').forEach(h => h.remove());
      if (id) {
        NAME_INPUTS.forEach(i => {
          const el = document.getElementById(i);
          if (!el) return;
          const hint = document.createElement('p');
          hint.className = 'panel-hint account-name-hint';
          hint.style.margin = '0 0 8px';
          hint.textContent = 'Entras como @' + id.username;
          el.parentNode.insertBefore(hint, el);
        });
      }
    });
  }

  /* ── Cuenta: si hay sesión iniciada, usamos el usuario y su foto y no
     hace falta pedir el nombre. Si no, se usa el input de siempre. ── */
  function _accountName(inputId) {
    const id = window.FHAuth && FHAuth.identity && FHAuth.identity();
    if (id && id.username) return id.username;
    return document.getElementById(inputId)?.value?.trim() || '';
  }
  function _accountAvatar() {
    const id = window.FHAuth && FHAuth.identity && FHAuth.identity();
    return (id && id.avatarUrl) || null;
  }
  /* HTML de dentro del avatar de un jugador: foto si tiene, si no la inicial */
  function _avatarInner(p) {
    if (window.FHAuth && FHAuth.avatarInner) return FHAuth.avatarInner(p && p.name, p && p.avatar);
    return _escHtml(((p && p.name) || '?').charAt(0).toUpperCase());
  }

  let _onlineCountdownIv = null;

  /* ── Cuenta atrás visual para la primera ronda online ── */
  function _runCountdownThenLoad(onDone) {
    const ONLINE_COUNTDOWN_SECS = 10;
    let overlay = document.getElementById('countdown-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'countdown-overlay';
      overlay.className = 'countdown-overlay hidden';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="countdown-inner">
        <div class="countdown-label">\u00a1EMPIEZA EN!</div>
        <div id="countdown-number" class="countdown-number">${ONLINE_COUNTDOWN_SECS}</div>
      </div>`;
    overlay.classList.remove('hidden');
    document.body.classList.add('countdown-active');
    const numEl = document.getElementById('countdown-number');
    const startAt = Date.now();
    let doneCalled = false;
    if (_onlineCountdownIv) clearInterval(_onlineCountdownIv);
    _onlineCountdownIv = setInterval(() => {
      const elapsed   = Math.floor((Date.now() - startAt) / 1000);
      const remaining = Math.max(0, ONLINE_COUNTDOWN_SECS - elapsed);
      if (numEl) numEl.textContent = remaining > 0 ? String(remaining) : '\u00a1YA!';
      if (remaining <= 0 && !doneCalled) {
        doneCalled = true;
        clearInterval(_onlineCountdownIv); _onlineCountdownIv = null;
        overlay.classList.add('hidden');
        document.body.classList.remove('countdown-active');
        if (PLAYERS_DB.length > 0) { onDone(); return; }
        _loadGameData()
          .then(() => onDone())
          .catch(e => {
            console.error('[App] _runCountdownThenLoad error:', e);
            showToast('\u274c Error cargando datos para la ronda', 'error');
          });
      }
    }, 200);
  }
  /* ════════════════════════════════════════
     INIT
     ════════════════════════════════════════ */
  async function init() {
    /* Blindaje: script.js delega validate()/_isRedundant() en window.FR. Si el
       index.html servido viene cacheado sin la etiqueta de FR, lo cargamos aquí
       para no romper ("FR is not defined"). sbStorageUrl ya está disponible. */
    if (typeof window.FR === 'undefined') {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = '../js/futbol-restrictions.js?v=' + Date.now();
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      } catch (e) { console.error('[Coche] No se pudo cargar futbol-restrictions.js', e); }
    }
    _showScreen('screen-menu');
    _preloadDataInBackground();
    _setupAccountName();

    /* Nombres de los jugadores automáticos: se piden ya para que la
       primera sala pública no tenga que esperar a la red. */
    if (typeof BotNames !== 'undefined') BotNames.load();

    const salaCode = window.FHRuta ? FHRuta.sala()
                                   : new URLSearchParams(window.location.search).get('sala');
    if (salaCode) {
      const input = document.getElementById('input-join-code');
      if (input) input.value = salaCode.toUpperCase();
      setTab('private');
      _volverALaSala(salaCode);
    }

    const pi = document.getElementById('player-input');
    if (pi) {
      pi.addEventListener('input', e => _onPlayerInputChange(e.target.value));
      pi.addEventListener('keydown', e => {
        const listOpen = !document.getElementById('autocomplete-list')?.classList.contains('hidden');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!listOpen) return;
          _acIndex = Math.min(_acIndex + 1, _acItems.length - 1);
          _acUpdateHighlight();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!listOpen) return;
          _acIndex = Math.max(_acIndex - 1, -1);
          _acUpdateHighlight();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (listOpen && _acIndex >= 0) { selectAndSubmit(_acIndex); }
          else submitAnswer();
        } else if (e.key === 'Escape') {
          _acClose();
        }
      });
    }
    document.addEventListener('click', e => {
      if (!e.target.closest('[style*="position:relative"]')) {
        document.getElementById('autocomplete-list')?.classList.add('hidden');
      }
    });
    console.log('✅ App Coche iniciada');
  }

  /* ════════════════════════════════════════
     TABS
     ════════════════════════════════════════ */
  function setTab(tab) {
    document.querySelectorAll('.menu-tab').forEach(b=>b.classList.remove('active'));
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.querySelectorAll('.menu-panel').forEach(p=>p.classList.remove('active'));
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    ['error-private','error-public','error-ranked'].forEach(id=>_clearError(id));
    const btnPublic = document.getElementById('btn-find-public');
    if (btnPublic) { btnPublic.disabled=false; btnPublic.textContent='BUSCAR PARTIDA ▶'; }
    const btnPrivPrimary = document.querySelector('#panel-private .btn-primary');
    if (btnPrivPrimary) { btnPrivPrimary.disabled=false; btnPrivPrimary.textContent='CREAR SALA ▶'; }
    const btnPrivSecondary = document.querySelector('#panel-private .btn-secondary');
    if (btnPrivSecondary) { btnPrivSecondary.disabled=false; btnPrivSecondary.textContent='UNIRSE A SALA ▶'; }
    if (tab === 'ranked') _refreshRankedPanel();
  }

  /* Pinta el bloqueo/desbloqueo y el tramo/ELO/racha del panel Clasificatoria.
     Se llama al abrir la pestaña y en cada cambio de sesión (login/logout). */
  async function _refreshRankedPanel() {
    const locked      = document.getElementById('ranked-locked');
    const unlocked     = document.getElementById('ranked-unlocked');
    const comingSoon  = document.getElementById('ranked-coming-soon');
    if (!RANKED_DISPONIBLE) {
      if (comingSoon) comingSoon.classList.remove('hidden');
      if (locked)   locked.classList.add('hidden');
      if (unlocked) unlocked.classList.add('hidden');
      return;
    }
    if (comingSoon) comingSoon.classList.add('hidden');
    if (!locked || !unlocked || !window.FHAuth) return;
    const session = await FHAuth.getSession();
    if (!session) {
      locked.classList.remove('hidden'); unlocked.classList.add('hidden');
      return;
    }
    locked.classList.add('hidden'); unlocked.classList.remove('hidden');
    if (!window.FHRanked) return;
    try {
      const perfil = await FHRanked.perfil('coche');
      const fila = perfil && Array.isArray(perfil.juegos) && perfil.juegos.find(j => j.juego === 'coche');
      const elo         = fila ? fila.elo       : 200;
      const tramo       = fila ? fila.tramo     : 0;
      const racha       = fila ? fila.racha     : 0;
      const victorias   = fila ? fila.victorias : 0;
      const derrotas    = fila ? fila.derrotas  : 0;
      const provisional = fila ? fila.provisional : true;
      const info = window.FHLiga ? FHLiga.tramoInfo(tramo) : null;
      const logoEl    = document.getElementById('ranked-tramo-logo');
      const nombreEl  = document.getElementById('ranked-tramo-nombre');
      const eloEl     = document.getElementById('ranked-tramo-elo');
      const rachaEl   = document.getElementById('ranked-tramo-racha');
      const recordEl  = document.getElementById('ranked-tramo-record');
      if (logoEl) { if (info) { logoEl.src = info.logo; logoEl.style.display = ''; } else { logoEl.style.display = 'none'; } }
      if (nombreEl) nombreEl.textContent = info ? info.nombre : 'Tercera División';
      if (eloEl) eloEl.textContent = elo + ' ELO' + (provisional ? ' (provisional)' : '');
      if (rachaEl) rachaEl.textContent = '🔥 ' + racha;
      if (recordEl) recordEl.textContent = victorias + 'V-' + derrotas + 'D';
    } catch(e) { console.warn('[App] No se pudo cargar el perfil ranked:', e); }
  }

  /* ════════════════════════════════════════
     CREAR SALA PRIVADA
     ════════════════════════════════════════ */
  /* Volver a la sala tras recargar. La sesión guardada (sessionStorage, y
     localStorage por si se cerró la app) ya traía el playerId; ahora trae
     también el nombre, que es lo que faltaba para reconectar sin preguntar.
     tryReconnect reutiliza TU hueco: entrar de cero te duplicaría en tu propia
     sala, que es justo el fallo contra el que avisa _saveSession(). Si la sala
     ya no existe o la partida arrancó, se deja el código puesto y se pide el
     nombre, como siempre. */
  async function _volverALaSala(code) {
    if (!window._FB?.configured) return;
    const ses = _loadSession();
    if (!ses || !ses.playerId || !ses.name) return;
    if (String(ses.code || '').toUpperCase() !== String(code).toUpperCase()) return;
    try {
      const status = await Sync.tryReconnect(ses.code, ses.playerId, ses.name, _accountAvatar());
      if (status) {
        _newSession();
        _roomCode = ses.code; _playerId = ses.playerId;
        _isHost = !!ses.isHost; _isPublic = !!ses.isPublic;
        _isLocal = false; _localName = ses.name;
        _saveSession(); _listenRoom();
        /* Si la partida ya está en marcha, NO forzar la pantalla de espera:
           el primer snapshot del listener (_onRoomUpdate) ya sabe pintar
           screen-round/resultados/final según toque. _showLobby() aquí solo
           hace falta para el caso 'waiting', que _onRoomUpdate solo repinta
           si YA estábamos en el lobby (si no, nos dejaría colgados en el
           menú). En partida no hace falta ese empujón: el switch de
           _onRoomUpdate no tiene esa condición para 'playing'/'reveal'. */
        if (typeof status !== 'string' || status === 'waiting' || status === 'resetting') _showLobby();
        return;
      }
      /* tryReconnect pide que tu registro siga en la sala, y al recargar
         Firebase ya lo ha borrado por el onDisconnect: es una carrera que se
         pierde casi siempre. Cuando pasa no hay nada que duplicar, así que se
         entra de cero con el mismo nombre. Se intenta en este orden y no al
         revés porque reconectar conserva tu sitio y tu condición de anfitrión. */
      /* Si la partida esta EN MARCHA, joinRoom responde "La partida ya ha
         comenzado" y el jugador se queda fuera de su propia sala — que es
         justo lo que pasaba al volver tras una llamada. Antes de rendirse se
         reocupa el hueco propio con el playerId guardado. */
      try {
        const rip = await Sync.rejoinInProgress(ses.code, ses.playerId, ses.name, _accountAvatar(), 0, ses.isHost);
        _newSession();
        _roomCode = ses.code; _playerId = ses.playerId;
        _isHost = !!rip.isHost; _isPublic = !!ses.isPublic;
        _isLocal = false; _localName = ses.name;
        _saveSession(); _listenRoom();
        return;
      } catch (e) { /* la sala esta en lobby o ya no existe: flujo normal */ }
      const r = await Sync.joinRoom(ses.code, ses.name, _accountAvatar());
      _newSession();
      _roomCode = r.code; _playerId = r.playerId;
      _isHost = false; _isPublic = !!ses.isPublic; _isLocal = false; _localName = ses.name;
      _saveSession(); _listenRoom(); _showLobby();
    } catch (e) {
      _clearSession();
      if (window.FHRuta) FHRuta.borrar('sala');
      _showError('error-private', e.message || 'No se ha podido volver a la sala');
    }
  }

  async function createRoom() {
    if (!window._FB?.configured) {
      showToast('⚠️ Firebase no disponible — comprueba la conexión', 'error');
      _showError('error-private','Firebase no disponible');
      return;
    }
    const name = _accountName('input-host-name');
    if (!name) { _showError('error-private','Escribe tu nombre'); return; }
    _clearError('error-private');
    const btn = document.querySelector('#panel-private .btn-primary');
    _btnLoad(btn,'CREANDO…');
    try {
      const {code,playerId} = await Sync.createRoom(name, _accountAvatar());
      _newSession();
      _roomCode=code; _playerId=playerId; _isHost=true; _isPublic=false; _isLocal=false; _localName=name;
      _saveSession(); _listenRoom(); _showLobby();
    } catch(e) { _showError('error-private', e.message||'Error al crear sala'); }
    finally { _btnReset(btn,'CREAR SALA ▶'); }
  }

  /* ════════════════════════════════════════
     UNIRSE A SALA PRIVADA
     ════════════════════════════════════════ */
  async function joinRoom() {
    if (!window._FB?.configured) {
      showToast('⚠️ Firebase no disponible — comprueba la conexión', 'error');
      _showError('error-private','Firebase no disponible');
      return;
    }
    const name = _accountName('input-join-name');
    const code = document.getElementById('input-join-code')?.value?.trim().toUpperCase();
    if (!name) { _showError('error-private','Escribe tu nombre'); return; }
    if (!code||code.length!==6) { _showError('error-private','Código de 6 caracteres'); return; }
    _clearError('error-private');
    const btn = document.querySelector('#panel-private .btn-secondary');
    _btnLoad(btn,'UNIÉNDOSE…');
    try {
      const result = await Sync.joinRoom(code, name, _accountAvatar());
      _newSession();
      _roomCode=result.code; _playerId=result.playerId; _isHost=false; _isPublic=false; _isLocal=false; _localName=name;
      _saveSession(); _listenRoom(); _showLobby();
    } catch(e) { _showError('error-private', e.message||'Error al unirse'); }
    finally { _btnReset(btn,'UNIRSE A SALA ▶'); }
  }

  /* ════════════════════════════════════════
     SALA PÚBLICA
     ════════════════════════════════════════ */
  async function findPublicRoom() {
    if (!window._FB?.configured) {
      showToast('⚠️ Firebase no disponible — comprueba la conexión', 'error');
      _showError('error-public','Firebase no disponible');
      return;
    }
    const name = _accountName('input-public-name');
    if (!name) { _showError('error-public','Escribe tu nombre'); return; }
    _clearError('error-public');
    const btn = document.getElementById('btn-find-public');
    _btnLoad(btn,'BUSCANDO…');
    try {
      /* Reconectar a la sesión guardada si la hay: al recargar la pestaña
         el jugador reutiliza su hueco en vez de entrar duplicado a su
         propia sala (bug de "salgo dos veces"). */
      const session = _loadSession();
      if (session?.isPublic && session.code && session.playerId) {
        const status = await Sync.tryReconnect(session.code, session.playerId, name, _accountAvatar());
        if (status) {
          _newSession();
          _roomCode=session.code; _playerId=session.playerId; _isHost=session.isHost===true;
          _isPublic=true; _isLocal=false; _localName=name;
          _saveSession(); _listenRoom();
          /* No forzar el lobby si la partida ya está en marcha (ver el mismo
             comentario en _volverALaSala): _onRoomUpdate ya sabe pintar la
             ronda o los resultados en cuanto llegue el primer snapshot. */
          if (typeof status !== 'string' || status === 'waiting' || status === 'resetting') _showLobby();
          _btnReset(btn,'BUSCAR PARTIDA ▶');
          return;
        }
      }

      const result = await Sync.findOrCreatePublicRoom(name, _accountAvatar());
      _newSession();
      _roomCode=result.code; _playerId=result.playerId; _isHost=result.isHost; _isPublic=true; _isLocal=false; _localName=name;
      _saveSession(); _listenRoom(); _showLobby();
    } catch(e) { _showError('error-public', e.message||'Error al buscar partida'); }
    finally { _btnReset(btn,'BUSCAR PARTIDA ▶'); }
  }

  /* ════════════════════════════════════════
     CLASIFICATORIA (ranked 1v1 por ELO)
     PLAN-coche-ranked.md, Fases 1-3. Emparejamiento por cola en Firebase
     (NO autoritativo: solo decide con quién juegas — ver §6.1 del plan);
     el resultado y el ELO los fija siempre api/ranked.js.
     ════════════════════════════════════════ */
  /* Interruptor: codigo entero ya funciona (verificado), pero se guarda
     "en la sombra" hasta decidir como gestionar el lanzamiento (rate
     limiting real, moderacion, temporada 1...). Poner en true reactiva
     la pestaña sin tocar nada mas. */
  const RANKED_DISPONIBLE     = false;
  const RANKED_PUNTOS         = 5;
  const RANKED_SEGUNDOS_RONDA = 45;
  const RANKED_MM_VENTANA_INI  = 50;
  const RANKED_MM_VENTANA_MAX  = 400;
  const RANKED_MM_VENTANA_SEGS = 60;

  let _rankedSearching    = false;
  let _rankedAutoStarting = false;
  let _rankedQueueUnsub   = null;
  let _rankedPairUnsub    = null;
  let _rankedMyUid        = null;
  let _rankedSearchStart  = 0;

  function _rankedVentanaActual() {
    const elapsed = (Date.now() - _rankedSearchStart) / 1000;
    const t = Math.min(1, Math.max(0, elapsed / RANKED_MM_VENTANA_SEGS));
    return RANKED_MM_VENTANA_INI + t * (RANKED_MM_VENTANA_MAX - RANKED_MM_VENTANA_INI);
  }

  function _rankedSetSearchUI(searching, hint) {
    const btn = document.getElementById('btn-buscar-rival');
    const cancelBtn = document.getElementById('btn-cancelar-busqueda');
    if (btn) btn.classList.toggle('hidden', searching);
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !searching);
    const hintEl = document.getElementById('ranked-search-hint');
    if (hintEl) hintEl.textContent = hint || '';
  }

  function _rankedStopListening() {
    if (_rankedQueueUnsub) { try { _rankedQueueUnsub(); } catch(e){} _rankedQueueUnsub=null; }
    if (_rankedPairUnsub)  { try { _rankedPairUnsub();  } catch(e){} _rankedPairUnsub=null; }
  }

  async function buscarRival() {
    if (!RANKED_DISPONIBLE) { showToast('Clasificatoria: muy pronto disponible', 'warning'); return; }
    if (_rankedSearching) return;
    if (!window._FB?.configured) { showToast('⚠️ Firebase no disponible — comprueba la conexión', 'error'); return; }
    if (!window.FHAuth || !window.FHRanked) { showToast('Componentes de Clasificatoria no cargados', 'error'); return; }
    const session = await FHAuth.getSession();
    if (!session) { showToast('Inicia sesión para jugar Clasificatoria', 'error'); return; }
    const uid = session.user.id;
    _rankedMyUid = uid;
    _rankedSetSearchUI(true, 'Cargando datos…');

    try {
      await _loadGameData();
      let elo = 200;
      try {
        const perfil = await FHRanked.perfil('coche');
        const fila = perfil && Array.isArray(perfil.juegos) && perfil.juegos.find(j => j.juego === 'coche');
        if (fila && typeof fila.elo === 'number') elo = fila.elo;
      } catch(e) { console.warn('[App] ranked perfil falló, uso ELO base 200:', e); }

      const identity = FHAuth.identity && FHAuth.identity();
      const name   = (identity && identity.username)  || 'Jugador';
      const avatar = (identity && identity.avatarUrl) || null;

      _rankedSearching   = true;
      _rankedSearchStart = Date.now();
      _rankedSetSearchUI(true, 'Buscando rival…');
      await Sync.rankedQueueJoin(uid, elo, name, avatar);
      _rankedArmarEscucha(uid, elo, name, avatar);
    } catch(e) {
      console.error('[App] buscarRival error:', e);
      showToast('Error buscando rival: ' + (e.message||''), 'error');
      cancelarBusquedaRival();
    }
  }

  /* Escucha la cola de emparejamiento (busca rival por ventana de ELO) y el
     buzón de emparejamiento (por si alguien de uid menor nos encuentra a
     nosotros primero). Un solo sitio para las dos búsquedas: antes el
     reintento de _crearPartidaEmparejada tenía su PROPIA copia de este
     filtro con el ELO fijo en 200 en lugar del real, y nunca volvía a
     escuchar el buzón — así que tras un fallo de red ese jugador solo podía
     emparejar de una forma y con rivales equivocados. */
  function _rankedArmarEscucha(uid, elo, name, avatar) {
    _rankedPairUnsub = Sync.rankedListenPairing(uid, (pairing) => {
      if (!_rankedSearching) return;
      _unirseAPartidaEmparejada(pairing, name, avatar);
    });
    _rankedQueueUnsub = Sync.rankedListenQueue((queue) => {
      if (!_rankedSearching) return;
      const ventana = _rankedVentanaActual();
      const candidatos = Object.entries(queue || {})
        .filter(([otroUid, e]) => otroUid !== uid && e && Math.abs((e.elo??200) - elo) <= ventana)
        .sort((a,b) => Math.abs((a[1].elo??200)-elo) - Math.abs((b[1].elo??200)-elo));
      if (!candidatos.length) return;
      const [rivalUid] = candidatos[0];
      if (uid < rivalUid) _crearPartidaEmparejada(uid, elo, name, avatar, rivalUid);
    });
  }

  async function _crearPartidaEmparejada(myUid, myElo, myName, myAvatar, rivalUid) {
    if (!_rankedSearching) return;
    _rankedSearching = false;
    _rankedStopListening();
    try {
      const { matchId, seedBase } = await FHRanked.call('crear', { juego:'coche', oponente_uid: rivalUid });
      const { code, playerId } = await Sync.createRankedRoom(myName, myAvatar, matchId, seedBase);
      await Sync.rankedAnnouncePairing(rivalUid, { code, matchId, seedBase, from: myUid });
      Sync.rankedQueueLeave(myUid).catch(()=>{});
      Sync.rankedQueueLeave(rivalUid).catch(()=>{});
      _newSession();
      _roomCode=code; _playerId=playerId; _isHost=true; _isPublic=false; _isLocal=false;
      _isRanked=true; _rankedMatchId=matchId; _rankedSeedBase=seedBase; _localName=myName;
      _rankedSetSearchUI(false, '');
      _saveSession(); _listenRoom(); _showLobby();
    } catch(e) {
      console.error('[App] crear partida ranked error:', e);
      showToast('No se pudo crear la partida, reintentando…', 'error');
      _rankedSearching = true; /* seguir buscando: puede que el rival ya no esté disponible */
      _rankedArmarEscucha(myUid, myElo, myName, myAvatar);
    }
  }

  async function _unirseAPartidaEmparejada(pairing, name, avatar) {
    if (!pairing || !pairing.code || !_rankedSearching) return;
    _rankedSearching = false;
    _rankedStopListening();
    try {
      const result = await Sync.joinRoom(pairing.code, name, avatar, true);
      Sync.rankedQueueLeave(_rankedMyUid).catch(()=>{});
      Sync.rankedClearPairing(_rankedMyUid).catch(()=>{});
      _newSession();
      _roomCode=result.code; _playerId=result.playerId; _isHost=false; _isPublic=false; _isLocal=false;
      _isRanked=true; _rankedMatchId=pairing.matchId; _rankedSeedBase=pairing.seedBase; _localName=name;
      _rankedSetSearchUI(false, '');
      _saveSession(); _listenRoom(); _showLobby();
    } catch(e) {
      console.error('[App] unirse a partida emparejada error:', e);
      showToast('No se pudo entrar a la partida emparejada', 'error');
      cancelarBusquedaRival();
    }
  }

  async function cancelarBusquedaRival() {
    _rankedSearching = false;
    _rankedStopListening();
    if (_rankedMyUid) {
      Sync.rankedQueueLeave(_rankedMyUid).catch(()=>{});
      Sync.rankedClearPairing(_rankedMyUid).catch(()=>{});
    }
    _rankedSetSearchUI(false, '');
  }

  /* Auto-empieza en cuanto el segundo jugador entra: en Clasificatoria no hay
     botón EMPEZAR ni ajustes editables (puntos/segundos fijos, ver §9 del
     plan). Solo lo dispara el host, y una sola vez por sala. */
  async function _startRankedGame(room) {
    if (!_isHost || !_isRanked || !_roomCode || _rankedAutoStarting) return;
    const humanCount = Object.values(room.players||{}).filter(p=>p.connected!==false).length;
    if (humanCount < 2) return;
    _rankedAutoStarting = true;
    const startRoom = _roomCode;
    try {
      await _loadGameData();
      const seed = _rankedSeedBase;
      const restrictions = await _generateAsync(seed, _genPool());
      const fresh = await Sync.getRoom(startRoom);
      if (!fresh || fresh.status !== 'waiting' || _roomCode !== startRoom) return;
      await Sync.startGame(startRoom, { seed, restrictions, pointsToWin: RANKED_PUNTOS, roundSecs: RANKED_SEGUNDOS_RONDA });
    } catch(e) {
      console.error('[App] _startRankedGame error:', e);
    } finally {
      _rankedAutoStarting = false;
    }
  }

  let _leaderboardOpen = false;
  async function toggleLeaderboard() {
    const box = document.getElementById('ranked-leaderboard');
    const btn = document.getElementById('btn-ranked-leaderboard');
    if (!box) return;
    _leaderboardOpen = !_leaderboardOpen;
    box.classList.toggle('hidden', !_leaderboardOpen);
    if (btn) btn.textContent = _leaderboardOpen ? 'Ocultar clasificación ▴' : 'Ver clasificación ▾';
    if (!_leaderboardOpen || !window.FHRanked) return;
    box.innerHTML = '<p class="panel-hint">Cargando…</p>';
    try {
      const session = window.FHAuth ? await FHAuth.getSession() : null;
      const data = await FHRanked.leaderboard('coche', 20);
      if (!data || !Array.isArray(data.top) || !data.top.length) {
        box.innerHTML = '<p class="panel-hint">Todavía no hay clasificación esta temporada.</p>';
        return;
      }
      const myUid = session && session.user.id;
      box.innerHTML = '<ol class="ranked-leaderboard-list">' + data.top.map(row => {
        const info = window.FHLiga ? FHLiga.tramoInfo(row.tramo) : null;
        const soyYo = row.user_id === myUid;
        return `<li class="ranked-leaderboard-row${soyYo ? ' ranked-leaderboard-row--yo' : ''}">
          <span class="ranked-leaderboard-puesto">${row.puesto}</span>
          <span class="ranked-leaderboard-nombre">${_escHtml(row.username || '—')}</span>
          <span class="ranked-leaderboard-emoji">${info ? info.emoji : ''}</span>
          <span class="ranked-leaderboard-elo">${row.elo}</span>
        </li>`;
      }).join('') + '</ol>';
    } catch(e) {
      console.warn('[App] No se pudo cargar la clasificación:', e);
      box.innerHTML = '<p class="panel-hint">No se pudo cargar la clasificación.</p>';
    }
  }

  /* ════════════════════════════════════════
     EMPEZAR PARTIDA (host online)
     ════════════════════════════════════════ */
  async function startGame() {
    if (!_isHost || !_roomCode) return;
    const btn = document.getElementById('btn-start-game');
    if (btn) { btn.disabled=true; btn.textContent='CARGANDO…'; }
    /* Capturar identidad de la sesión AHORA. Si el usuario sale, crea otra
       sala, etc. mientras cargamos datos / generamos restricciones, abortamos
       en vez de escribir 'playing' sobre una sala que ya no es esta. */
    const token = _sessionToken;
    const startRoom = _roomCode;
    const stale = () => _sessionToken !== token || _roomCode !== startRoom || !_isHost;
    const restoreBtn = () => {
      const b = document.getElementById('btn-start-game');
      if (b && _currentScreen() === 'screen-lobby') { b.disabled=false; b.textContent='EMPEZAR ▶'; }
    };
    try {
      await _loadGameData();
      if (stale()) { console.warn('[App] startGame abortado: sesión cambiada (post-loadData)'); restoreBtn(); return; }
      const seed         = Date.now();
      const restrictions = await _generateAsync(seed, _genPool());
      if (stale()) { console.warn('[App] startGame abortado: sesión cambiada (post-generate)'); restoreBtn(); return; }
      /* Usar ajustes de _lastRoom (ya sincronizados por el listener) — sin round-trip extra */
      if (_lastRoom?.pointsToWin != null) _onlinePointsToWin = _lastRoom.pointsToWin;
      if (_lastRoom?.roundSecs   != null) _onlineRoundSecs   = _lastRoom.roundSecs;
      /* Última comprobación: la sala debe seguir en 'waiting' (nadie la arrancó ni reseteó) */
      const fresh = await Sync.getRoom(startRoom);
      if (stale()) { console.warn('[App] startGame abortado: sesión cambiada (post-getRoom)'); restoreBtn(); return; }
      if (!fresh || fresh.status !== 'waiting') {
        console.warn('[App] startGame abortado: la sala ya no está en waiting');
        if (btn) { btn.disabled=false; btn.textContent='EMPEZAR ▶'; }
        return;
      }
      const connectedCount = Object.values(fresh.players||{}).filter(p=>p.connected!==false).length;
      if (connectedCount < 2) {
        showToast('Necesitas al menos 2 jugadores conectados', 'error');
        if (btn) { btn.disabled=false; btn.textContent='EMPEZAR ▶'; }
        return;
      }
      await Sync.startGame(startRoom, {seed, restrictions, pointsToWin:_onlinePointsToWin, roundSecs:_onlineRoundSecs});
      _clearPublicLobbyTimer();
    } catch(e) {
      if (stale()) return;
      showToast('Error al iniciar la partida: ' + (e.message||''), 'error');
      console.error('[App] startGame error:', e);
      if (btn) { btn.disabled=false; btn.textContent='EMPEZAR ▶'; }
    }
  }

  /* Ajustes online — solo accesibles para el host en el lobby */
  async function adjustOnlinePoints(delta) {
    if (!_isHost || !_roomCode) return;
    _onlinePointsToWin = Math.max(5, Math.min(15, _onlinePointsToWin + delta));
    const el = document.getElementById('online-points-display');
    if (el) el.textContent = _onlinePointsToWin;
    try { await Sync.updateRoomSettings(_roomCode, { pointsToWin: _onlinePointsToWin }); }
    catch(e) { console.warn('[App] adjustOnlinePoints error:', e); }
  }

  async function adjustOnlineSecs(delta) {
    if (!_isHost || !_roomCode) return;
    _onlineRoundSecs = Math.max(30, Math.min(120, _onlineRoundSecs + delta));
    const el = document.getElementById('online-secs-display');
    if (el) el.textContent = _onlineRoundSecs;
    try { await Sync.updateRoomSettings(_roomCode, { roundSecs: _onlineRoundSecs }); }
    catch(e) { console.warn('[App] adjustOnlineSecs error:', e); }
  }

  /* Pregeneración silenciosa de la siguiente ronda.
     Se llama desde la pantalla de resultados, cuando el usuario
     está leyendo y el hilo principal tiene tiempo libre. */
  function _preGenerateNextRestrictions() {
    if (!PLAYERS_DB.length) return;
    const nextRoundNum = _round + 1;
    /* Clasificatoria: misma formula que en nextRound() (seedBase + ronda
       0-indexada). Si esto se queda con Date.now(), la cache pregenerada
       serviría una rejilla que NO coincide con la que espera el arbitro. */
    const seed = _isRanked ? (_rankedSeedBase + _round) : Date.now() + nextRoundNum * 7919;
    _generateAsync(seed, _genPool())
      .then(restrictions => {
        _nextRestrictionsCache = restrictions;
        console.log('[App] Siguiente ronda pregenerada en worker ✓');
      })
      .catch(() => { _nextRestrictionsCache = null; });
  }

  /* ════════════════════════════════════════
     SALIR
     ════════════════════════════════════════ */
  async function leaveRoom() {
    _newSession();
    _stopTimer(); _clearPublicLobbyTimer();
    if (_unsubRoom) { _unsubRoom(); _unsubRoom=null; }
    if (_roomCode && _playerId && !_isLocal) {
      try { await Sync.disconnect(_roomCode, _playerId); } catch(e) {}
    }
    _clearSession(); _resetState();
    _showScreen('screen-menu');
    if (window.FHRuta) FHRuta.borrar('sala');
    else history.replaceState({}, '', window.location.pathname);
  }

  /* ════════════════════════════════════════
     LISTENER FIREBASE
     ════════════════════════════════════════ */
  function _listenRoom() {
    if (_unsubRoom) _unsubRoom();
    _unsubRoom = Sync.listenRoom(_roomCode, _onRoomUpdate);
  }

  let _lastArmedStatus = null;   // último status para el que se rearmó onDisconnect


  /* Puntuacion propia segun la ultima foto de la sala. Se conserva aparte
     porque si el nodo se borra ya no se puede leer de room.players. */
  let _miPuntuacion = 0;
  let _reingresando = false;

  /* Volver a entrar en la partida reocupando el hueco propio. Un solo intento
     por corte: si la sala ya no admite el reingreso (expiro, volvio al lobby)
     se sale al menu diciendo por que, en vez de dejar al jugador mirando una
     sala de la que ya no forma parte. */
  async function _reingresarEnPartida() {
    if (_reingresando) return;
    if (!_roomCode || !_playerId || !_localName) { _handleKicked('Has salido de la sala'); return; }
    _reingresando = true;
    const token = _sessionToken, sala = _roomCode;
    try {
      const r = await Sync.rejoinInProgress(sala, _playerId, _localName, _accountAvatar(), _miPuntuacion, _isHost);
      if (_sessionToken !== token || _roomCode !== sala) return;
      _isHost = !!r.isHost;
      _saveSession();
      const fresh = await Sync.getRoom(sala);
      if (_sessionToken === token && _roomCode === sala && fresh) _onRoomUpdate(fresh);
    } catch (e) {
      if (_sessionToken !== token || _roomCode !== sala) return;
      _handleKicked(e.message || 'Has salido de la sala');
    } finally {
      _reingresando = false;
    }
  }

  /* ── Failover de anfitrion ──
     Se llama desde _onRoomUpdate y tambien desde el vigilante de 2 s: si el
     que se fue era el anfitrion y nadie mas escribe en la sala, no llegan mas
     eventos de Firebase y sin el vigilante nadie llegaria a promoverse. */
  function _failoverHost(room) {
    if (!_isLocal && _playerId && room.players?.[_playerId]
        && (room.status==='waiting' || room.status==='playing' || room.status==='reveal')) {
      const humans = Object.entries(room.players)
        .filter(([,p]) => !p.isBot && p.connected!==false);
      const hasHost = humans.some(([,p]) => p.isHost===true);
      if (!hasHost && humans.length > 0) {
        const candidate = humans.map(([pid])=>pid).sort()[0];
        if (candidate === _playerId && !_isHost) {
          _isHost = true;
          _saveSession();   // que una recarga posterior recuerde que somos host
          try {
            const {db,ref,update}=window._FB;
            update(ref(db,`restricciones/rooms/${_roomCode}/players/${_playerId}`),{isHost:true}).catch(()=>{});
            /* Y se le quita la corona al que se fue: si vuelve con isHost
               puesto habría dos anfitriones repartiendo a la vez. */
            const viejo = Object.entries(room.players)
              .find(([pid,p]) => pid!==_playerId && p && p.isHost===true && p.connected===false);
            if (viejo) update(ref(db,`restricciones/rooms/${_roomCode}/players/${viejo[0]}`),{isHost:false}).catch(()=>{});
          } catch(e) {}
          /* Asumir las funciones AQUI, no esperando al eco de Firebase: con
             _isHost ya puesto a true, la deteccion por transicion de arriba no
             volveria a saltar y nos quedariamos con la corona pero sin hacer
             nada con ella. */
          _alHeredarHost(room);
          _sincronizarBotonSiguienteRonda(room);
        }
      }
    }
  }

  /* ── Asumir las funciones de anfitrion ──
     Se llama tanto cuando Firebase nos dice que ya somos host (transicion)
     como en el momento de autopromocionarnos en el failover. Es idempotente:
     _triggerReveal se protege con _revealTriggered y los bots se reprograman
     sobre el reloj real de la ronda. */
  function _alHeredarHost(room) {
    if (_isLocal || !room) return;
    if (room.status !== 'playing' && room.status !== 'reveal') return;

    if (room.status === 'playing' && !_revealTriggered) {
      /* Si ya estaban todas las respuestas y nadie disparo el reveal (el que
         debia hacerlo se fue), dispararlo ahora. */
      const connected = _players.filter(p=>p.connected!==false);
      const expected = _isSuddenDeath
        ? connected.filter(p => _suddenDeathPlayers.includes(p.id)).length
        : connected.length;
      if (expected>0 && (room.doneCount||0)>=expected) { _triggerReveal(room); return; }
      /* Heredamos tambien los bots: sus respuestas las tenia programadas el
         host anterior, asi que hay que reprogramarlas o la ronda se quedaria
         esperandolos. Se les pasa el reloj real de la ronda (inicio +
         duracion): ellos mismos reparten lo que quede. */
      if (_isPublic && typeof CocheBots !== 'undefined' && _timerStartAt) {
        const left = _timerTotalSecs - Math.floor((Date.now()-_timerStartAt)/1000);
        if (left > 3) CocheBots.onRound({
          code: _roomCode, room, restrictions: _restrictions,
          roundSecs: _timerTotalSecs, startAt: _timerStartAt,
          isSuddenDeath: _isSuddenDeath,
          suddenDeathPlayers: _suddenDeathPlayers,
        });
      }
      return;
    }

    if (room.status === 'reveal' && _currentScreen()==='screen-results') {
      _preGenerateNextRestrictions();
    }
  }

  /* El boton de pasar de ronda es del anfitrion, y quien lo sea puede cambiar
     a mitad de partida. Repintarlo en cada foto de la sala es lo que evita el
     bloqueo: sin esto, el jugador recien promovido se quedaba en la pantalla
     de resultados con el boton escondido y la partida no avanzaba mas. */
  function _sincronizarBotonSiguienteRonda(room) {
    if (_isLocal || !room) return;
    if (room.status !== 'reveal') { _nextRoundEnCurso = false; return; }
    if (_currentScreen() !== 'screen-results') return;
    if (_finishedDelayTimer) return;      // hay cuenta atras de ganador, no toca
    if (_nextRoundEnCurso) return;        // ya pulsado aqui, la sala esta a punto de cambiar
    const nxt = document.getElementById('btn-next-round');
    if (!nxt) return;
    nxt.classList.toggle('hidden', !_isHost);
    if (_isHost) nxt.disabled = false;
  }

  function _onRoomUpdate(room) {
    _lastRoom = room;
    if (room.status === 'expired') { _handleKicked('La sala pública expiró por inactividad ⏱️'); return; }

    /* Rearmar onDisconnect al cambiar entre lobby y partida: en el lobby un
       corte debe liberar el hueco; en partida solo marcar connected:false. */
    if (!_isLocal && _playerId && _roomCode && room.status !== _lastArmedStatus) {
      _lastArmedStatus = room.status;
      Sync.rearmOnDisconnect(_roomCode, _playerId, room.status);
    }
    if (!_isLocal && _playerId && room.players && !room.players[_playerId]) {
      /* En status waiting/resetting sin nuestro ID: la sala fue reseteada y aún
         no nos hemos re-unido. No expulsar — el jugador se re-unirá al pulsar
         "Jugar de nuevo" (playAgain reintenta hasta que el status sea waiting). */
      if (room.status === 'waiting' || room.status === 'resetting') return;
      /* En partida, que tu nodo desaparezca NO es una expulsión: Coche no
         tiene forma de echar a nadie. Es que el corte de conexión (una
         llamada, cambiar de app) lo borró. Antes se salía al menú con
         "Has sido expulsado" y ya no había manera de volver. Ahora se
         reocupa el mismo hueco, con la puntuación que se tuviera, y solo si
         eso falla se sale. */
      _reingresarEnPartida();
      return;
    }
    if (room.players) {
      _players = Object.entries(room.players)
        /* Ignorar nodos fantasma SIN nombre: se crean cuando una escritura de
           puntuación del host (startReveal/nextRound) resucita el nodo de un
           jugador que el onDisconnect acababa de borrar, dejando solo {score}.
           Sin nombre saldrían con avatar "?" y, al contar como conectados,
           bloquearían el cierre anticipado de la ronda. */
        .filter(([,p]) => p && typeof p.name === 'string' && p.name.trim() !== '')
        .map(([id,p])=>({
          id, name:p.name, score:p.score||0, connected:p.connected??true, isHost:p.isHost??false
        }));
      /* Mantener _isHost sincronizado SIEMPRE (no solo en el lobby).
         Permite el failover de host si el host original se desconecta
         a mitad de partida: el juego sigue avanzando. */
      if (!_isLocal && _playerId && room.players[_playerId]) {
        /* Ultima foto conocida de nuestro registro: es lo que se reescribe si
           el nodo desaparece por un corte (_reingresarEnPartida). */
        _miPuntuacion = room.players[_playerId].score || 0;
        const wasHost = _isHost;
        _isHost = room.players[_playerId].isHost === true;
        if (_isHost && !wasHost) _alHeredarHost(room);
      }
      /* El boton "SIGUIENTE RONDA" se sincroniza con _isHost en CADA foto de
         la sala, no solo en el instante de la promocion. La transicion
         (_isHost && !wasHost) no basta: el failover de mas abajo ya pone
         _isHost=true en local, asi que cuando vuelve el eco de Firebase con
         isHost:true resulta que wasHost tambien es true y la transicion no
         salta nunca. Ese era el motivo real de que el resto de la sala se
         quedara sin poder pasar de ronda cuando el anfitrion se iba: se
         promovia a otro jugador, pero a ese jugador no le salia el boton. */
      _sincronizarBotonSiguienteRonda(room);
    }

    /* El host limpia nodos fantasma (sin nombre): se crean cuando una
       escritura de puntuación (startReveal/nextRound) resucita el nodo de un
       jugador que el onDisconnect acababa de borrar, dejando solo {score}.
       Al no figurar ya en _players nadie los reescribe, así que borrarlos
       aquí los elimina para siempre y no vuelven a salir con avatar "?". */
    if (_isHost && !_isLocal && _roomCode && room.players && window._FB) {
      for (const [pid,p] of Object.entries(room.players)) {
        if (!p || typeof p.name !== 'string' || p.name.trim() === '') {
          const {db,ref,remove}=window._FB;
          remove(ref(db,`restricciones/rooms/${_roomCode}/players/${pid}`)).catch(()=>{});
        }
      }
    }
    /* ── Failover de host ──
       Si el host desapareció (su onDisconnect borró el nodo) o quedó
       desconectado, la sala se quedaba sin nadie que metiera bots, empezara
       la partida o la expirara. El primer humano conectado (orden
       determinista por id) se autopromociona. Los bots nunca heredan.

       Va también EN PARTIDA (playing / reveal), no solo en el lobby: casi
       todo lo que hace avanzar la partida es cosa del anfitrión (cerrar la
       ronda, repartir la siguiente), así que si se va a mitad —cambiar de
       app, una llamada— la sala se quedaba congelada para todos los demás
       hasta que volviera. El bloque de más arriba ya contemplaba "nos acaban
       de promover en plena partida", pero nadie llegaba a promover nunca. */
    _failoverHost(room);

    switch(room.status) {
      case 'resetting':
        /* Transición efímera mientras un jugador resetea la sala.
           No hacer nada: el estado 'waiting' llegará en milisegundos. */
        break;
      case 'waiting':
        /* Resetear estado interno de ronda al volver al lobby (playAgain / resetToLobby).
           Sin esto, _round podría quedarse en su valor anterior y
           la condición room.round !== _round fallaría al empezar nueva partida. */
        _round=0; _submitted=false; _mySubmission=null; _mySubmissionId=null; _revealTriggered=false;
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        _nextRestrictionsCache=null;
        _stopTimer();
        if (_finishedDelayTimer) { clearInterval(_finishedDelayTimer); _finishedDelayTimer=null; }
        if (_onlineCountdownIv) { clearInterval(_onlineCountdownIv); _onlineCountdownIv=null; }
        if (_preloadCountdownIv) { clearInterval(_preloadCountdownIv); _preloadCountdownIv=null; }
        _pendingFinishedRoom=null;
        _cleanupRoundDOM();
        /* Bug 2: Solo ir al lobby si el jugador ha pulsado "Jugar de nuevo"
           o si ya estamos en pantalla de lobby (primera entrada).
           Si no, quedarse en pantalla de fin de partida. */
        if (_wantReplay || _currentScreen() === 'screen-lobby') {
          _updateLobbyUI(room);
        }
        if (room.isRanked && _isHost) _startRankedGame(room);
        break;
      case 'playing':
        if (room.round !== _round) {
          _round=room.round;
          /* Firebase puede devolver el array de restricciones como objeto {0:{…},1:{…},…} */
          const rawR = room.restrictions;
          _restrictions = Array.isArray(rawR) ? rawR
            : rawR && typeof rawR === 'object' ? Object.values(rawR)
            : [];
          _submitted=false; _mySubmission=null; _mySubmissionId=null; _revealTriggered=false;
          /* Leer ajustes de partida desde la sala — SIEMPRE, en cada ronda */
          if (room.pointsToWin != null) _onlinePointsToWin = room.pointsToWin;
          if (room.roundSecs   != null) _onlineRoundSecs   = room.roundSecs;
          console.log('[App] Ronda', room.round, '— pointsToWin:', _onlinePointsToWin, 'roundSecs:', _onlineRoundSecs);
          if (room.isSuddenDeath) {
            _isSuddenDeath = true;
            _suddenDeathPlayers = room.suddenDeathPlayers || [];
          } else {
            _isSuddenDeath = false;
            _suddenDeathPlayers = [];
          }
          _startOnlineRound(room);
        } else {
          _renderSubmissions(_players, room.submissions||{});
          /* Si una persona ya ha bloqueado a su futbolista, los bots que
             falten se dan prisa (2-10 s) en vez de agotar su turno. */
          if (_isHost && _isPublic && !_isLocal && typeof CocheBots !== 'undefined') {
            CocheBots.onHumanAnswer(room);
          }
          if (_isHost && !_revealTriggered) {
            const connected = _players.filter(p=>p.connected!==false);
            /* Bug 3: En muerte súbita solo contar submissions de los jugadores empatados */
            const expected = _isSuddenDeath
              ? connected.filter(p => _suddenDeathPlayers.includes(p.id)).length
              : connected.length;
            if (expected>0 && (room.doneCount||0)>=expected) {
              _triggerReveal(room);
            }
          }
        }
        break;
      case 'reveal':
        if (_currentScreen()!=='screen-results' || room.round !== _round) {
          _round = room.round;
          const rawRev = room.restrictions;
          _restrictions = Array.isArray(rawRev) ? rawRev
            : rawRev && typeof rawRev === 'object' ? Object.values(rawRev)
            : _restrictions;
          _showResultsScreen(room);
        }
        break;
      case 'finished':
        _showFinishedScreen(room);
        break;
    }
  }

  /* ════════════════════════════════════════
     LOBBY UI
     ════════════════════════════════════════ */
  function _showLobby() {
    const base = _lastRoom || {};
    if (!base.players && _playerId) {
      const minRoom = {
        ...base,
        isPublic: _isPublic,
        players: { [_playerId]: { name: _localName || '…', avatar: _accountAvatar(), score: 0, connected: true, isHost: _isHost } },
      };
      _updateLobbyUI(minRoom);
    } else {
      _updateLobbyUI(base);
    }
  }

  function _updateLobbyUI(room) {
    if (_currentScreen() !== 'screen-lobby') _showScreen('screen-lobby');
    _syncMyIdentityToRoom();   // por si entramos antes de que resolviera la sesión
    const code = _roomCode || '------';
    const codeEl = document.getElementById('lobby-code-display');
    if (codeEl) codeEl.textContent = code;
    const linkEl = document.getElementById('lobby-link-display');
    if (linkEl) {
      const url = `${window.location.origin}${window.location.pathname}?sala=${code}`;
      linkEl.textContent = url;
    }
    if (room.players?.[_playerId]) { _isHost = room.players[_playerId].isHost === true; }
    if (typeof room.isPublic === 'boolean') { _isPublic = room.isPublic; }
    /* Restaurar identidad ranked desde la sala: sin esto, recargar a mitad de
       una partida clasificatoria dejaba _isRanked/_rankedMatchId/_rankedSeedBase
       en null para siempre en esa sesión (los únicos sitios que los ponían
       eran _crearPartidaEmparejada/_unirseAPartidaEmparejada, nunca un
       reconexión), y ese jugador dejaba de contar para el árbitro sin avisar. */
    if (typeof room.isRanked === 'boolean') { _isRanked = room.isRanked; }
    if (_isRanked) {
      if (room.rankedMatchId)  _rankedMatchId  = room.rankedMatchId;
      if (room.rankedSeedBase != null) _rankedSeedBase = room.rankedSeedBase;
    }
    /* El código va a la URL estés en sala privada o pública. Antes la pública
       no lo escribía ("no hay nada que compartir") y con eso recargar dentro
       de una partida pública te devolvía al menú sin remedio. Que el enlace de
       invitación no se ofrezca en las públicas ni en las ranked lo sigue
       decidiendo el lobby (lobby-code-card se oculta), no la barra de
       direcciones. */
    if (_roomCode && window.FHRuta) FHRuta.set({ sala: _roomCode });
    else if (_roomCode && !_isPublic) {
      const targetUrl = window.location.pathname + '?sala=' + _roomCode;
      if (!window.location.search.includes(_roomCode)) history.replaceState(null, '', targetUrl);
    }
    /* Ranked no reparte código para unirse a mano (se entra solo por
       emparejamiento): antes salía la misma tarjeta de invitación que en
       Privada porque las salas ranked también llevan isPublic:false, así que
       un código filtrado (captura de pantalla, historial) dejaba colarse a un
       tercero en un "1 contra 1". */
    const codeCard = document.getElementById('lobby-code-card');
    if (codeCard) codeCard.style.display = (_isPublic || _isRanked) ? 'none' : '';
    const badge = document.getElementById('lobby-mode-badge');
    if (badge) {
      badge.style.display = (_isPublic || _isRanked) ? 'block' : 'none';
      badge.textContent = _isRanked ? '🏆 Clasificatoria' : (_isPublic ? '🌐 Sala Pública' : '');
    }

    const listEl = document.getElementById('lobby-players-list');
    if (listEl && room.players) {
      listEl.innerHTML = Object.entries(room.players)
        .filter(([,p])=>p.connected!==false)
        .map(([pid,p])=>`
          <div class="lobby-player-row">
            <div class="lobby-player-avatar">${_avatarInner(p)}</div>
            <span class="lobby-player-name">${_escHtml(p.name)}</span>
            ${p.isHost ? '<span class="lobby-player-host">ANFITRIÓN</span>' : ''}
            ${pid===_playerId ? '<span class="lobby-player-you">← TÚ</span>' : ''}
          </div>
        `).join('');
    }
    const players  = Object.values(room.players||{}).filter(p=>p.connected!==false);
    const count    = players.length;
    const startBtn = document.getElementById('btn-start-game');
    const hintEl   = document.getElementById('lobby-hint');

    /* Bug 2: Cooldown de 10s tras volver al lobby para dar tiempo a que se unan todos */
    const lobbyAge = room.lobbyAt ? Math.floor((Date.now() - room.lobbyAt) / 1000) : 999;
    const MIN_LOBBY_WAIT = 10;
    const cooldownActive = room.resetAt && lobbyAge < MIN_LOBBY_WAIT;

    /* Ranked no tiene boton EMPEZAR manual: arranca sola en cuanto entra el
       rival (_startRankedGame). Enseñarselo al host igual que en Privada
       dejaba clicar "EMPEZAR" -> App.startGame() generico, que usa una
       semilla de Date.now() que el arbitro nunca validaria. */
    if (_isHost && startBtn && !_isRanked) {
      startBtn.style.display='block';
      startBtn.disabled = count < 2 || cooldownActive;
      startBtn.textContent = cooldownActive
        ? `ESPERA ${MIN_LOBBY_WAIT - lobbyAge}s…`
        : 'EMPEZAR ▶';
    }
    else if (startBtn) { startBtn.style.display='none'; }
    if (hintEl) {
      if (_isRanked) hintEl.textContent = count < 2 ? 'Esperando al rival…' : 'Rival encontrado, empezando…';
      else if (cooldownActive) hintEl.textContent = 'Esperando a que se unan todos…';
      else if (_isPublic && !_isHost) hintEl.textContent = 'Esperando a que el host empiece…';
      else if (count < 2) hintEl.textContent = _isPublic ? 'Buscando más jugadores…' : 'Esperando jugadores… (mínimo 2)';
      else hintEl.textContent = `${count} jugadores listos — ¡empieza cuando quieras!`;
    }
    /* Re-render durante el cooldown para actualizar el contador.
       Usar un único timer guardado para evitar acumulación exponencial:
       _updateLobbyUI se llama también en cada update de Firebase, y sin
       este guard cada llamada generaría su propio setTimeout encadenado. */
    if (cooldownActive && _isHost) {
      if (_cooldownTickTimer) clearTimeout(_cooldownTickTimer);
      _cooldownTickTimer = setTimeout(() => {
        _cooldownTickTimer = null;
        if (_lastRoom && _currentScreen()==='screen-lobby') _updateLobbyUI(_lastRoom);
      }, 1000);
    } else if (_cooldownTickTimer) {
      clearTimeout(_cooldownTickTimer); _cooldownTickTimer = null;
    }

    /* Panel de ajustes online — solo visible en sala privada. Ranked tambien
       lleva isPublic:false, asi que sin el !_isRanked de aqui el anfitrion
       de una clasificatoria podia cambiar puntos-para-ganar/segundos por
       ronda (RANKED_PUNTOS/RANKED_SEGUNDOS_RONDA son fijos a proposito). */
    const settingsEl = document.getElementById('lobby-settings');
    if (settingsEl && !_isPublic && !_isRanked) {
      /* Leer valores de la sala si existen */
      if (room.pointsToWin != null) _onlinePointsToWin = room.pointsToWin;
      if (room.roundSecs   != null) _onlineRoundSecs   = room.roundSecs;
      settingsEl.style.display = 'block';
      const ptsEl  = document.getElementById('online-points-display');
      const secsEl = document.getElementById('online-secs-display');
      if (ptsEl)  ptsEl.textContent  = _onlinePointsToWin;
      if (secsEl) secsEl.textContent = _onlineRoundSecs;
      /* Controles visibles/desactivados según si eres host */
      settingsEl.querySelectorAll('.settings-btn').forEach(btn => {
        btn.disabled = !_isHost;
        btn.style.opacity = _isHost ? '1' : '0.3';
      });
    } else if (settingsEl && _isPublic) {
      settingsEl.style.display = 'none';
    }

    /* El timer de expiración corre en TODOS los clientes (no solo el host):
       con un host fantasma nadie lo ejecutaba y la sala nunca moría. */
    if (_isPublic && room.lobbyAt) _startPublicLobbyTimer(room);
    if (_isPublic && room.lobbyAt) _renderPublicLobbyTimer(room.lobbyAt);

    /* Bots: solo los gestiona el host, y solo en salas públicas */
    if (_isHost && !_isLocal && _isPublic && _roomCode && typeof CocheBots !== 'undefined') {
      CocheBots.syncLobby(room, _roomCode);
    }
  }

  /* Timer lobby público */
  let _lobbyRenderTimerIv = null;
  let _cooldownTickTimer  = null;
  function _renderPublicLobbyTimer(lobbyAt) {
    const timerEl = document.getElementById('lobby-autotimer');
    const barEl   = document.getElementById('lobby-autotimer-bar');
    const countEl = document.getElementById('lobby-autotimer-count');
    if (!timerEl) return;
    timerEl.classList.remove('hidden');
    const tick = () => {
      const elapsed   = Date.now() - lobbyAt;
      const remaining = Math.max(0, PUBLIC_LOBBY_TIMEOUT - elapsed);
      const pct       = (remaining / PUBLIC_LOBBY_TIMEOUT) * 100;
      const secs      = Math.floor(remaining / 1000);
      const mins      = Math.floor(secs / 60);
      const s         = String(secs % 60).padStart(2, '0');
      if (barEl)   { barEl.style.width = pct + '%'; barEl.classList.toggle('urgent', secs < 30); }
      if (countEl) { countEl.textContent = `${mins}:${s}`; countEl.classList.toggle('urgent', secs < 30); }
    };
    tick();
    /* Limpiar intervalo anterior antes de crear uno nuevo — _updateLobbyUI se llama
       en cada actualización de Firebase, así que sin esto se acumulan intervalos */
    if (_lobbyRenderTimerIv) clearInterval(_lobbyRenderTimerIv);
    _lobbyRenderTimerIv = setInterval(() => {
      const remaining = Math.max(0, PUBLIC_LOBBY_TIMEOUT - (Date.now() - lobbyAt));
      tick();
      if (remaining <= 0) { clearInterval(_lobbyRenderTimerIv); _lobbyRenderTimerIv = null; }
    }, 1000);
  }

  function _startPublicLobbyTimer(room) {
    if (_publicLobbyTimer) return;
    const lobbyAt   = room.lobbyAt || 0;
    if (!lobbyAt) return;
    const elapsed   = Date.now() - lobbyAt;
    const remaining = PUBLIC_LOBBY_TIMEOUT - elapsed;
    if (remaining <= 0) { _handlePublicRoomExpired(); return; }
    const warnIn = remaining - PUBLIC_LOBBY_WARN;
    if (warnIn > 0) {
      _publicLobbyWarnTimer = setTimeout(()=>{
        _publicLobbyWarnTimer=null;
        showToast('⚠️ La sala expirará en 30 segundos si no empieza', 'error');
      }, warnIn);
    }
    _publicLobbyTimer = setTimeout(()=>{ _publicLobbyTimer=null; _handlePublicRoomExpired(); }, remaining);
  }

  function _clearPublicLobbyTimer() {
    if (_publicLobbyTimer)     { clearTimeout(_publicLobbyTimer);     _publicLobbyTimer=null; }
    if (_publicLobbyWarnTimer) { clearTimeout(_publicLobbyWarnTimer); _publicLobbyWarnTimer=null; }
  }

  async function _handlePublicRoomExpired() {
    /* Puede dispararlo CUALQUIER cliente, no solo el host: si el host es un
       fantasma (cerró sin Salir), nadie expiraba la sala y quedaba atrapando
       jugadores para siempre. Releer la sala primero: si la partida ya
       empezó mientras tanto, no hay nada que expirar. */
    if (!_roomCode) return;
    try {
      const fresh = await Sync.getRoom(_roomCode);
      if (!fresh || fresh.status !== 'waiting') return;
    } catch(e) { return; }
    showToast('⏱️ Sala pública expirada — cerrando…', 'error');
    try { await Sync.expirePublicRoom(_roomCode); } catch(e) {}
    _handleKicked('La sala pública expiró por inactividad ⏱️');
  }

  /* startGame() — ver implementación completa arriba (con _loadGameData) */

  /* ════════════════════════════════════════
     RONDA ONLINE
     ════════════════════════════════════════ */
  function _startOnlineRound(room) {
    if (room.round === 1) {
      /* Transicionar a screen-round PRIMERO para que el overlay
         aparezca sobre ella (igual que hace startLocalGame) */
      _showScreen('screen-round');
      _renderTopbar(room.round, _players);
      _renderSubmissions(_players, {});
      _runCountdownThenLoad(() => _doStartOnlineRound(room));
    } else {
      _doStartOnlineRound(room);
    }
  }

  function _doStartOnlineRound(room) {
    /* En ronda 1 la pantalla ya fue mostrada antes del countdown;
       en rondas posteriores la mostramos aquí */
    if (room.round > 1) _showScreen('screen-round');
    _renderTopbar(room.round, _players);
    _renderSubmissions(_players, {});
    const secs = _isSuddenDeath ? SUDDEN_DEATH_SECS : (_onlineRoundSecs || ROUND_SECS);
    /* Resetear display del timer inmediatamente para no mostrar el valor de la ronda anterior */
    const _timerEl = document.getElementById('round-timer');
    const _barEl   = document.getElementById('round-timer-bar');
    if (_timerEl) { _timerEl.textContent = secs; _timerEl.classList.remove('urgent'); }
    if (_barEl)   { _barEl.style.width = '100%';  _barEl.classList.remove('urgent'); }
    const pi=document.getElementById('player-input');
    const sb=document.getElementById('submit-btn');
    /* En muerte súbita, solo participan los jugadores empatados */
    const canPlay = !_isSuddenDeath || _suddenDeathPlayers.includes(_playerId);
    /* Input deshabilitado hasta que salgan las restricciones */
    if (pi) { pi.value=''; pi.disabled=true; }
    if (sb) sb.disabled=true;
    /* Banner de muerte súbita */
    let sdBanner = document.getElementById('sudden-death-banner');
    if (_isSuddenDeath) {
      if (!sdBanner) {
        sdBanner = document.createElement('div');
        sdBanner.id = 'sudden-death-banner';
        sdBanner.style.cssText = "background:#c0392b;color:#fff;text-align:center;padding:8px 0;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:3px;z-index:10;";
        sdBanner.textContent = '💀 MUERTE SÚBITA — ' + (canPlay ? 'RONDA EXPRESS 20s' : 'ESPECTADOR');
        const rg = document.getElementById('restrictions-grid');
        if (rg) rg.parentNode.insertBefore(sdBanner, rg);
      }
    } else if (sdBanner) { sdBanner.remove(); }
    /* Limpiar grid inmediatamente para que no se vean las restricciones de la ronda anterior
       mientras arranca la animación de las nuevas */
    const grid = document.getElementById('restrictions-grid');
    if (grid) grid.innerHTML = '';

    /* El timer y el input arrancan DESPUÉS de que se muestran todas las restricciones.
       Usamos Date.now() como referencia para que todos los jugadores tengan
       el mismo tiempo disponible independientemente del lag de red. */
    _animateRestrictions(_restrictions, () => {
      if (canPlay) {
        if (pi) pi.disabled = false;
        if (sb) sb.disabled = false;
      }
      /* Normalmente "ahora" SÍ es el inicio real: todos los clientes llegan
         aquí unos segundos después de room.roundStartAt (lo que tarda la
         animación de restricciones) y ese margen es igual para todos.
         Pero si el móvil mató la pestaña de verdad a mitad de ronda (una
         llamada) y Sync.tryReconnect nos devuelve YA en 'playing', este
         mismo camino se ejecuta desde cero con room.round ya avanzado: sin
         esto, "ahora" nos regalaría un cronómetro de secs completos (y a
         los bots con él) aunque al reloj real ya casi no le quedara nada.
         Con eso el reveal solo podía llegar por el rescate de 12s del
         vigilante en vez de por el propio cronómetro — o nunca, si el
         vigilante también arrancaba tarde. Usar roundStartAt cuando el
         hueco es mayor de lo que la animación explica arranca el timer ya
         con el tiempo real que queda (o en 0, disparando el reveal de
         inmediato por el camino normal). */
      const startedAt = Date.now();
      const roomStart = Number(room.roundStartAt) || 0;
      const isResume  = roomStart > 0 && (startedAt - roomStart) > 8000;
      const effectiveStart = isResume ? roomStart : startedAt;
      _startTimer(effectiveStart, secs);

      /* Los bots arrancan su reloj en el mismo instante que el resto:
         cuando terminan de salir las restricciones. Se les pasa ese
         instante (no solo la duración) para que su hora de responder
         sea un punto del reloj de la ronda y no un temporizador suelto
         que el móvil pueda congelar al irse a segundo plano. */
      if (_isHost && !_isLocal && _isPublic && typeof CocheBots !== 'undefined') {
        CocheBots.onRound({
          code: _roomCode,
          room,
          restrictions: _restrictions,
          roundSecs: secs,
          startAt: effectiveStart,
          isSuddenDeath: _isSuddenDeath,
          suddenDeathPlayers: _suddenDeathPlayers,
        });
      }
    });
  }

  /* ════════════════════════════════════════
     ANIMACIÓN DE RESTRICCIONES
     ════════════════════════════════════════ */
  let _animToken = 0;
  function _animateRestrictions(restrictions, onComplete) {
    const grid = document.getElementById('restrictions-grid');
    if (!grid) { onComplete?.(); return; }
    /* Safety: Firebase puede devolver objeto en vez de array */
    if (!Array.isArray(restrictions)) {
      restrictions = restrictions && typeof restrictions === 'object'
        ? Object.values(restrictions) : [];
    }
    if (restrictions.length === 0) { onComplete?.(); return; }

    /* Token de animación: si el jugador sale (o cambia de ronda) durante la
       animación de revelado, las llamadas encadenadas de setTimeout quedan
       canceladas y onComplete (que arranca el timer) NO se dispara en una
       pantalla equivocada. */
    const myToken = ++_animToken;
    const alive = () => _animToken === myToken && _currentScreen() === 'screen-round';

    grid.innerHTML = restrictions.map(r => {
      /* Contenido visual: imagen con fallback a emoji */
      const iconHtml = r.imgUrl
        ? `<img class="restriction-img" src="${_escHtml(fhImgUrl(r.imgUrl))}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'"
               alt="">
           <span class="restriction-icon-fallback" style="display:none">${_escHtml(r.icon||'❓')}</span>`
        : `<span class="restriction-icon-fallback">${_escHtml(r.icon||'❓')}</span>`;

      return `<div class="restriction-card">
        <div class="restriction-icon">${iconHtml}</div>
        <div class="restriction-label">${_escHtml(r.label)}</div>
      </div>`;
    }).join('');

    const cards = grid.querySelectorAll('.restriction-card');
    let i = 0;
    function next() {
      if (!alive()) return;                      /* cancelado: salimos o cambió la ronda */
      if (i >= cards.length) { onComplete?.(); return; }
      cards[i].classList.add('visible'); i++;
      if (i < cards.length) setTimeout(next, 1000);
      else setTimeout(()=>{ if (alive()) onComplete?.(); }, 400);
    }
    setTimeout(next, 300);
  }

  /* ════════════════════════════════════════
     TIMER
     ════════════════════════════════════════ */
  function _startTimer(startAt, totalSecs) {
    _stopTimer();
    const secs = totalSecs || ROUND_SECS;
    /* Recordar inicio real y duración: son la fuente de verdad. El intervalo
       de abajo es solo "para repintar la pantalla cada 500ms" — si el
       navegador deja de llamarlo (pestaña en 2º plano) no pasa nada, porque
       en cuanto vuelva a llamarse (o lo relancemos nosotros) se recalcula
       el tiempo restante a partir del reloj real, no de cuántos ticks hubo. */
    _timerStartAt   = startAt;
    _timerTotalSecs = secs;
    const tick = () => {
      const elapsed   = Math.floor((Date.now()-startAt)/1000);
      const remaining = Math.max(0, secs-elapsed);
      const timerEl   = document.getElementById('round-timer');
      const barEl     = document.getElementById('round-timer-bar');
      if (timerEl) { timerEl.textContent=remaining; timerEl.classList.toggle('urgent',remaining<=10); }
      if (barEl)   { barEl.style.width=(remaining/secs*100)+'%'; barEl.classList.toggle('urgent',remaining<=10); }
      if (remaining<=0) {
        _stopTimer();
        const pi=document.getElementById('player-input');
        const sb=document.getElementById('submit-btn');
        if (pi) pi.disabled=true;
        if (sb) sb.disabled=true;
        if (_isHost && !_revealTriggered) _triggerReveal(_lastRoom);
      }
    };
    tick();
    _timerInterval = setInterval(tick, 500);
  }
  function _stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval=null; }
    _timerStartAt = null; _timerTotalSecs = null;
  }
  /* Bug móvil: al backgrounder la app (cambiar de app, bloquear pantalla, etc.)
     algunos navegadores móviles detienen por completo el setInterval del
     temporizador y no vuelven a llamarlo nunca al volver a primer plano.
     Como _timerStartAt/_timerTotalSecs guardan el origen real (timestamp),
     al volver a ser visible simplemente relanzamos el intervalo desde ahí:
     el tiempo restante se recalcula correctamente aunque hayan pasado
     minutos en segundo plano (y si ya se agotó, _startTimer lo detecta en
     el primer tick y dispara el reveal igual que si hubiera seguido corriendo). */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    /* Lo primero, los bots: sus temporizadores venían congelados y puede
       que a varios les tocara responder hace rato. Así llegan sus
       respuestas ANTES de que el reloj de abajo cierre la ronda. */
    if (_isHost && _isPublic && !_isLocal && typeof CocheBots !== 'undefined') {
      CocheBots.catchUp();
    }
    /* No comprobamos si _timerInterval sigue "vivo": en el caso exacto que
       queremos arreglar, el navegador puede dejarlo apuntando a un intervalo
       ya muerto sin avisar. _startTimer() vuelve a limpiar y crear uno nuevo,
       así que llamarlo de nuevo es siempre seguro (idempotente). */
    if (_timerStartAt !== null) {
      _startTimer(_timerStartAt, _timerTotalSecs);
    }
    _handleResume();
    /* Y sin esperar los 2 s del intervalo: si la ronda ya estaba lista para
       cerrarse mientras la app estaba fuera, se cierra al volver. */
    _roundWatchdog();
  });
  window.addEventListener('online', _handleResume);

  /* ════════════════════════════════════════
     VIGILANTE DE RONDA

     Cerrar la ronda dependia de dos avisos que se pueden perder LOS DOS a la
     vez cuando el movil manda la app a segundo plano a mitad de partida:

       · el reloj de la ronda — _triggerReveal lo apaga nada mas empezar, y
       · los cambios de la sala — si ya ha contestado todo el mundo, nadie
         vuelve a escribir en Firebase y no llega ningun evento mas.

     Si encima el intento de cerrar se aborta a medias (al volver, la sesion
     ya no cuadra y salta uno de los `if (!_live())`, o falla la escritura),
     _revealTriggered vuelve a false y no queda NADIE que lo reintente: la
     ronda se queda clavada aunque hayan respondido todos. Eso es justo lo
     que pasaba al salir de la app en mitad de una partida y volver a entrar.

     El vigilante mira cada 2 s el estado real de la sala y cierra la ronda
     cuando toca. Dos detalles a proposito:

       · cuenta las submissions de verdad, no doneCount: ese contador es una
         escritura aparte y puede descuadrarse si se pierde por el camino.
       · pasados 12 s puede cerrarla CUALQUIER jugador, no solo el anfitrion.
         Si el que se fue era el, la sala ya no se queda esperandole. Cerrar
         dos veces es inofensivo: startReveal cambia el estado con una
         transaccion playing->reveal y los resultados salen de las mismas
         submissions, asi que solo entra el primero.
     ════════════════════════════════════════ */
  const RESCATE_RONDA_MS = 12000;
  let _rondaAtascadaDesde = 0;

  function _rondaListaParaCerrar(room) {
    const conectados = _players.filter(p => p.connected !== false);
    const participantes = _isSuddenDeath
      ? conectados.filter(p => _suddenDeathPlayers.includes(p.id))
      : conectados;
    if (!participantes.length) return false;
    const subs = room.submissions || {};
    if (participantes.every(p => subs[p.id])) return true;
    /* O se acabo el tiempo. roundStartAt/roundSecs viven en la sala, asi que
       valen aunque el reloj local se haya quedado parado en segundo plano. */
    const inicio = Number(room.roundStartAt || 0);
    const secs   = Number(room.roundSecs || ROUND_SECS);
    return inicio > 0 && Date.now() > inicio + secs * 1000 + 2000;
  }

  function _roundWatchdog() {
    if (_isLocal || !_roomCode || !_playerId)                 { _rondaAtascadaDesde = 0; return; }
    const room = _lastRoom;
    /* Antes que nada, quien manda. Si el anfitrion se fue y nadie mas escribe
       en la sala, Firebase no vuelve a avisar de nada y sin este repaso
       periodico nadie llegaria a promoverse: la partida se quedaria esperando
       eternamente a alguien que no va a volver. Y se repinta el boton de pasar
       de ronda, que es lo que deja la pantalla de resultados sin salida. */
    if (room) { _failoverHost(room); _sincronizarBotonSiguienteRonda(room); }
    if (!room || room.status !== 'playing' || _revealTriggered) { _rondaAtascadaDesde = 0; return; }
    if (!room.players || !room.players[_playerId])            { _rondaAtascadaDesde = 0; return; }
    if (!_rondaListaParaCerrar(room))                          { _rondaAtascadaDesde = 0; return; }
    if (!_rondaAtascadaDesde) _rondaAtascadaDesde = Date.now();
    const rescate = Date.now() - _rondaAtascadaDesde >= RESCATE_RONDA_MS;
    if (_isHost || rescate) {
      _rondaAtascadaDesde = 0;
      _triggerReveal(room);
    }
  }
  setInterval(_roundWatchdog, 2000);

  /* ════════════════════════════════════════
     VOLVER A LA PARTIDA

     Al volver de segundo plano hay que reparar tres cosas que el corte
     de conexión deja rotas: nuestro connected:false (el onDisconnect ya
     saltó), el onDisconnect gastado, y la pantalla, que puede haberse
     quedado en un estado del que no se sale sola.
     ════════════════════════════════════════ */
  let _resuming = false;
  async function _handleResume() {
    if (_isLocal || !_roomCode || !_playerId) return;
    if (_resuming) return;
    _resuming = true;
    const token = _sessionToken;
    const room  = _roomCode;
    try {
      const status = _lastRoom?.status || 'playing';
      await Sync.resume(room, _playerId, status);
      if (_sessionToken !== token || _roomCode !== room) return;
      /* Releer la sala: si mientras estábamos fuera cambió algo que el
         listener no nos llegó a entregar, aquí se pone todo al día. */
      const fresh = await Sync.getRoom(room);
      if (_sessionToken !== token || _roomCode !== room) return;
      /* Congelación al volver de segundo plano en el LOBBY: el onDisconnect nos
         borró de la sala mientras la app estaba en 2º plano. En vez de quedar
         con un lobby fantasma del que ya no formamos parte (todo bloqueado),
         nos re-añadimos al MISMO hueco con nuestro playerId de siempre — sin
         crear un duplicado. Solo en waiting (rejoinRoom exige ese estado). */
      if (fresh && fresh.status === 'waiting'
          && _playerId && (!fresh.players || !fresh.players[_playerId])) {
        try {
          await Sync.rejoinRoom(room, _playerId, _localName || '…', _accountAvatar());
          const again = await Sync.getRoom(room);
          if (_sessionToken === token && _roomCode === room && again) {
            _onRoomUpdate(again); return;
          }
        } catch(e) { /* sala llena o desaparecida: seguimos al flujo normal */ }
      }
      if (fresh) _onRoomUpdate(fresh);
    } catch(e) {
      console.warn('[App] resume error:', e);
    } finally {
      _resuming = false;
      _unstickNextRoundBtn();
    }
  }

  /* Red de seguridad del botón "SIGUIENTE RONDA".
     nextRound() lo oculta y deshabilita nada más pulsarlo y solo lo
     devuelve si la escritura en Firebase falla de forma visible. Si el
     corte pilla justo ahí (la escritura se pierde al irse la app a
     segundo plano), la sala se queda en 'reveal' y el botón, escondido:
     la partida no puede avanzar y no hay forma de desbloquearla. */
  function _unstickNextRoundBtn() {
    if (_isLocal || !_isHost) return;
    if (_lastRoom?.status !== 'reveal') return;
    if (_currentScreen() !== 'screen-results') return;
    if (_finishedDelayTimer) return;          // hay cuenta atrás de ganador
    const nxt = document.getElementById('btn-next-round');
    if (!nxt) return;
    nxt.classList.remove('hidden');
    nxt.disabled = false;
  }

  /* ════════════════════════════════════════
     ENVIAR RESPUESTA
     ════════════════════════════════════════ */
  async function submitAnswer() {
    if (_submitted) return;
    const pi   = document.getElementById('player-input');
    const name = pi?.value.trim();
    if (!name) { showToast('Escribe el nombre de un futbolista', 'warning'); return; }
    document.getElementById('autocomplete-list')?.classList.add('hidden');

    /* Bloquear UI mientras buscamos en chunks */
    const sb  = document.getElementById('submit-btn');
    const pi2 = document.getElementById('player-input');
    if (sb)  sb.disabled  = true;
    if (pi2) pi2.disabled = true;

    /* Capturar y consumir _acSelected antes de cualquier await */
    const selectedItem = _acSelected;
    _acSelected = null;

    let player;
    try {
      /* Si el usuario seleccionó una sugerencia concreta, buscar por ID
         para evitar ambigüedades entre jugadores con el mismo nombre
         (ej. varios "Rafinha" con posiciones distintas) */
      if (selectedItem?.id) {
        const chunk = await _getChunkData(selectedItem.id);
        player = _buildPlayerFromChunk(selectedItem.id, chunk);
        /* Enriquecer con mapas globales igual que findPlayerAsync */
        if (player) {
          const sid = String(selectedItem.id);
          const mapTrophies = _TROPHY_MAP[sid] || [];
          if (mapTrophies.length > 0) {
            player.trophies = [...new Set([...(player.trophies || []), ...mapTrophies])];
          }
          player.teammates = _TEAMMATE_MAP[sid] || player.teammates || [];
          player.coaches   = _COACH_MAP[sid]    || player.coaches   || [];
        }
      } else {
        /* Sin selección de autocomplete: buscar por nombre (comportamiento original) */
        player = await findPlayerAsync(name);
      }
    } catch(e) {
      console.error('[submitAnswer] Error buscando jugador:', e);
      player = null;
    }

    if (!player) {
      if (sb)  sb.disabled  = false;
      if (pi2) pi2.disabled = false;
      showToast('Futbolista no encontrado en la base de datos', 'error');
      return;
    }

    _submitted=true; _mySubmission=player.name; _mySubmissionId=player.id||null;
    if (sb)  sb.disabled  = true;
    if (pi2) pi2.disabled = true;
    showToast(`✓ ${player.name} enviado`, 'success');

    try {
      const doneCount = await Sync.submitAnswer(_roomCode, _playerId, player.name, player.id||null);
      /* Clasificatoria: registro AUTORITATIVO en el arbitro (api/ranked.js).
         El marcador que se ve en pantalla sale de Firebase, como siempre; este
         envio es la unica fuente que cuenta para el ELO. Sin bloquear la UI
         (fire-and-forget): si falla, "cerrar" al final de la partida sigue
         siendo el que decide, y este envio se puede reintentar via idempotencia
         (ver api/ranked.js) si algun dia hace falta un reintento explicito. */
      if (_isRanked && _rankedMatchId && window.FHRanked) {
        FHRanked.call('submit', { matchId:_rankedMatchId, ronda:_round-1, answerId: player.id||null })
          .catch(e => console.warn('[App] ranked submit falló (no afecta a esta pantalla):', e));
      }
      const connected = _players.filter(p=>p.connected!==false).length;
      if (_isHost && !_revealTriggered && doneCount>=connected) _triggerReveal(_lastRoom);
    } catch(e) {
      _submitted=false; _mySubmission=null; _mySubmissionId=null;
      if (sb)  sb.disabled=false;
      if (pi2) { pi2.disabled=false; pi2.value=''; }
      showToast(e.message||'Error al enviar', 'error');
    }
  }

  /* ════════════════════════════════════════
     DISPARAR REVEAL (host)
     ════════════════════════════════════════ */
  async function _triggerReveal(room) {
    if (_revealTriggered) return;
    _revealTriggered=true;
    _stopTimer();
    const _token = _sessionToken;
    const _room  = _roomCode;
    const _live  = () => _sessionToken === _token && _roomCode === _room && !_isLocal;

    /* Leer sala fresca de Firebase para asegurar que las submissions
       de todos los jugadores están disponibles (evita el bug de "Sin respuesta") */
    let freshRoom = room;
    try {
      /* Bots que acaban de vencer (típico al volver de segundo plano: sus
         temporizadores estaban congelados y su turno ya había pasado).
         Se les deja terminar antes de cerrar la ronda para que no salga
         "Sin respuesta" por un problema del móvil del host. */
      if (_isPublic && typeof CocheBots !== 'undefined' && CocheBots.pending()) {
        CocheBots.catchUp();
        await CocheBots.settle(3000);
        if (!_live()) { _revealTriggered=false; return; }
      }
      /* Pequeña espera para que Firebase propague todas las submissions */
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!_live()) { _revealTriggered=false; return; }
      const fetched = await Sync.getRoom(_room);
      if (!_live()) { _revealTriggered=false; return; }
      if (fetched) freshRoom = fetched;
    } catch(e) {
      console.warn('[App] No se pudo leer sala fresca, usando datos locales:', e);
    }

    const submissions  = freshRoom?.submissions||{};
    const rawTR = freshRoom?.restrictions;
    const restrictions = Array.isArray(rawTR) ? rawTR
      : rawTR && typeof rawTR === 'object' ? Object.values(rawTR)
      : _restrictions;
    console.log('[App] _triggerReveal submissions:', JSON.stringify(submissions));

    /* En muerte súbita: solo evaluar jugadores participantes */
    const evalPlayers = _isSuddenDeath
      ? _players.filter(p => _suddenDeathPlayers.includes(p.id))
      : _players;
    const results      = await _computeResults(submissions, restrictions, evalPlayers);
    /* Asegurar que no-participantes tienen resultado vacío */
    if (_isSuddenDeath) {
      for (const p of _players) {
        if (!_suddenDeathPlayers.includes(p.id)) {
          results[p.id] = {playerName:null,valid:false,matchCount:0,matches:restrictions.map(()=>false),footballer:null,points:0,isWinner:false};
        }
      }
    }
    const updated      = _applyPoints(_players, results);
    _players = updated;

    /* Muerte súbita: el primero que gana la ronda gana la partida */
    if (_isSuddenDeath) {
      const sdWinner = updated
        .filter(p => _suddenDeathPlayers.includes(p.id))
        .find(p => results[p.id]?.isWinner);
      if (sdWinner) {
        _isSuddenDeath = false; _suddenDeathPlayers = [];
        if (!_live()) { _revealTriggered=false; return; }
        try {
          await Sync.startReveal(_room, results, updated);
          if (!_live()) { _revealTriggered=false; return; }
          await Sync.setFinished(_room, sdWinner.id, updated);
        } catch(e) { console.error('[App] sudden death finish error:', e); _revealTriggered=false; }
        return;
      }
    } else {
      /* Modo normal: comprobar si alguien alcanza pointsToWin */
      const ptw = _onlinePointsToWin || POINTS_WIN;
      const reached = updated.filter(p => p.score >= ptw);
      if (reached.length === 1) {
        if (!_live()) { _revealTriggered=false; return; }
        try {
          await Sync.startReveal(_room, results, updated);
          if (!_live()) { _revealTriggered=false; return; }
          await Sync.setFinished(_room, reached[0].id, updated);
        } catch(e) { console.error('[App] finish error:', e); _revealTriggered=false; }
        return;
      }
    }

    if (!_live()) { _revealTriggered=false; return; }
    try {
      await Sync.startReveal(_room, results, updated);
    } catch(e) {
      console.error('[App] startReveal error:', e);
      _revealTriggered=false;
    }
  }

  /* ════════════════════════════════════════
     MOSTRAR RESULTADOS (online)
     ════════════════════════════════════════ */
  function _showResultsScreen(room) {
    _stopTimer();
    const results = room.results||{};
    const _sToken = _sessionToken;
    const _sRoom  = _roomCode;
    const _stillHere = () => _sessionToken===_sToken && _roomCode===_sRoom && _isHost && !_isLocal;

    /* Muerte súbita online: ¿hay ganador de esta ronda? */
    if (_isSuddenDeath && _isHost) {
      const roundWinner = _players
        .filter(p => _suddenDeathPlayers.includes(p.id))
        .find(p => results[p.id]?.isWinner);
      if (roundWinner) {
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        if (_stillHere()) Sync.setFinished(_sRoom, roundWinner.id, _players).catch(()=>{});
        return;
      }
      /* Bug 3: No hay ganador claro → eliminar a los que sacaron menos puntos.
         Si de 3 empatados, 2 sacan más que el tercero, la siguiente ronda
         de muerte súbita la juegan solo esos 2. */
      const sdScores = _suddenDeathPlayers.map(id => ({id, pts: results[id]?.points||0}));
      const maxPts = Math.max(...sdScores.map(r=>r.pts));
      const stillTied = sdScores.filter(r=>r.pts===maxPts).map(r=>r.id);
      if (stillTied.length < _suddenDeathPlayers.length && stillTied.length >= 2) {
        _suddenDeathPlayers = stillTied;
        console.log('[App] Muerte súbita: eliminados los peores, quedan', stillTied.length);
      } else if (stillTied.length === 1) {
        /* Solo queda 1 → gana la partida */
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        if (_stillHere()) Sync.setFinished(_sRoom, stillTied[0], _players).catch(()=>{});
        return;
      }
    }

    /* Detectar un empate NUEVO justo en el momento del reveal (no esperar a que el
       host pulse "siguiente ronda"), para que TODOS vean el aviso de muerte súbita
       de inmediato — igual que ya ocurre en modo local. nextRound() simplemente
       continuará sin re-detectar, ya que _isSuddenDeath ya estará a true. */
    if (!_isSuddenDeath) {
      const ptwFresh = _onlinePointsToWin || POINTS_WIN;
      const reachedFresh = _players.filter(p => p.score >= ptwFresh);
      if (reachedFresh.length >= 2) {
        _isSuddenDeath = true;
        _suddenDeathPlayers = reachedFresh.map(p => p.id);
        showToast('💀 ¡MUERTE SÚBITA! Rondas express', 'error');
      }
    }

    const rawRes = room.restrictions;
    const safeRestrictions = Array.isArray(rawRes) ? rawRes
      : rawRes && typeof rawRes === 'object' ? Object.values(rawRes)
      : _restrictions;
    _renderResultsUI(room.round, safeRestrictions, results, _players);
    _showScreen('screen-results');

    /* Aprovechar que el host está leyendo los resultados para precalcular
       las restricciones de la siguiente ronda en background (igual que en local) */
    if (_isHost) _preGenerateNextRestrictions();

    /* Banner muerte súbita en pantalla de resultados */
    const existingBanner = document.getElementById('sd-results-banner');
    if (_isSuddenDeath && !existingBanner) {
      const banner = document.createElement('div');
      banner.id = 'sd-results-banner';
      banner.style.cssText = "background:#c0392b;color:#fff;text-align:center;padding:8px 0;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:3px;margin-bottom:8px;";
      banner.textContent = '💀 MUERTE SÚBITA — SIGUIENTE RONDA EXPRESS';
      const listEl = document.getElementById('results-list');
      if (listEl) listEl.parentNode.insertBefore(banner, listEl);
    } else if (!_isSuddenDeath && existingBanner) { existingBanner.remove(); }

    const nxt=document.getElementById('btn-next-round');
    if (nxt) {
      nxt.classList.toggle('hidden', !_isHost);
      if (_isHost) nxt.disabled = false;
    }
  }

  /* ════════════════════════════════════════
     SIGUIENTE RONDA (host)
     ════════════════════════════════════════ */
  async function nextRound() {
    if (!_isHost||!_roomCode) return;
    const _token = _sessionToken;
    const _room  = _roomCode;
    const _live  = () => _sessionToken === _token && _roomCode === _room && _isHost;
    /* Guard: evitar doble llamada mientras se procesa la petición a Firebase */
    const nxtBtn = document.getElementById('btn-next-round');
    if (nxtBtn) {
      if (nxtBtn.disabled) return;
      nxtBtn.disabled = true;
      nxtBtn.classList.add('hidden');
    }
    _nextRoundEnCurso = true;
    const _reenableBtn = () => {
      _nextRoundEnCurso = false;
      if (nxtBtn) { nxtBtn.disabled = false; nxtBtn.classList.remove('hidden'); }
    };
    /* Vigilante: si en 12 s la sala no ha pasado a 'playing' (escritura
       perdida por un corte, worker atascado…), devolver el botón en vez de
       dejar la partida bloqueada sin nada que pulsar. */
    setTimeout(() => {
      if (!_live()) return;
      if (_lastRoom?.status === 'reveal' && _currentScreen() === 'screen-results' && !_finishedDelayTimer) {
        _reenableBtn();
      }
    }, 12000);
    const ptw = _onlinePointsToWin || POINTS_WIN;

    /* Muerte súbita online — normalmente ya se detecta y anuncia en
       _showResultsScreen justo en el momento del reveal (igual que en local).
       Aquí solo actuamos como red de seguridad por si no se hubiera detectado
       antes, y forzamos restricciones frescas para la ronda que entra en
       muerte súbita (nunca reusar la cache pregenerada en ese caso). */
    let forceFreshRestrictions = false;
    if (!_isSuddenDeath) {
      const reached = _players.filter(p=>p.score>=ptw);
      if (reached.length >= 2) {
        _isSuddenDeath = true;
        _suddenDeathPlayers = reached.map(p=>p.id);
        showToast('💀 ¡MUERTE SÚBITA! Rondas express de 20 segundos', 'error');
        forceFreshRestrictions = true;
      } else if (reached.length === 1) {
        try { await Sync.setFinished(_room, reached[0].id, _players); } catch(e) { _reenableBtn(); }
        return;
      }
    }

    /* Clasificatoria: semilla determinista (seedBase + ronda 0-indexada) para
       que el arbitro (api/ranked.js) pueda reproducir exactamente la misma
       rejilla sin fiarse de lo que escriba Firebase. _round es la ronda que
       ACABA de terminar, así que la que entra es la ronda _round (0-indexada). */
    const seed = _isRanked ? (_rankedSeedBase + _round) : Date.now()+(_round*3137);
    /* Usar cache pregenerada si está disponible (salvo al entrar en muerte súbita) */
    const cached = forceFreshRestrictions ? null : _nextRestrictionsCache;
    _nextRestrictionsCache = null;
    const restrictionsPromise = cached
      ? Promise.resolve(cached)
      : _generateAsync(seed, _genPool());

    restrictionsPromise.then(async restrictions => {
      if (!_live()) return;
      try {
        await Sync.nextRound(_room, _round+1, {
          seed, restrictions,
          pointsToWin: _onlinePointsToWin, roundSecs: _onlineRoundSecs,
          isSuddenDeath: _isSuddenDeath, suddenDeathPlayers: _suddenDeathPlayers,
        }, _players);
      } catch(e) { if (_live()) { showToast('Error al iniciar la siguiente ronda', 'error'); _reenableBtn(); } }
    }).catch(() => { if (_live()) { showToast('Error al generar restricciones', 'error'); _reenableBtn(); } });
  }

  /* ════════════════════════════════════════
     FIN DE PARTIDA
     ════════════════════════════════════════ */
  /* Guarda los datos del finished para mostrarlos tras el delay */
  let _pendingFinishedRoom = null;
  let _finishedDelayTimer  = null;
  /* El anfitrion acaba de pulsar SIGUIENTE RONDA y la escritura esta en
     vuelo: mientras tanto la sala sigue en 'reveal', asi que sin esta marca
     _sincronizarBotonSiguienteRonda volveria a enseñar el boton. */
  let _nextRoundEnCurso    = false;

  function _doShowFinished(room) {
    _finishedDelayTimer = null;
    const winnerId   = room.winnerId;
    const winnerName = room.players?.[winnerId]?.name || '—';
    document.getElementById('winner-name').textContent = winnerName;
    const scoresEl = document.getElementById('final-scores');
    if (scoresEl && room.players) {
      const sorted = Object.entries(room.players)
        .map(([id,p])=>({id,name:p.name,score:p.score||0}))
        .sort((a,b)=>b.score-a.score);
      scoresEl.innerHTML = sorted.map(p=>{
        const isW = p.id===winnerId;
        return '<div class="final-score-item ' + (isW?'winner-item':'') + '">' +
          '<span class="final-score-name">' + _escHtml(p.name) + ' ' + (isW?'🏆':'') + '</span>' +
          '<span class="final-score-pts">' + p.score + ' pts</span>' +
          '</div>';
      }).join('');
    }
    _showScreen('screen-finished');

    const rankedBox = document.getElementById('ranked-result-box');
    if (room.isRanked && room.rankedMatchId) {
      _showRankedResult(room);
    } else if (rankedBox) {
      rankedBox.classList.add('hidden'); rankedBox.innerHTML = '';
    }
  }

  /* Clasificatoria: cierra la partida en el árbitro (idempotente — lo puede
     llamar cualquiera de los dos, o los dos a la vez) y pinta ELO antes →
     después + cambio de tramo. El marcador que ya se ve arriba (final-scores)
     sale de Firebase; esto es la confirmación AUTORITATIVA, puede tardar un
     instante y por eso se pinta aparte, no bloquea la pantalla de fin. */
  async function _showRankedResult(room) {
    const box = document.getElementById('ranked-result-box');
    if (!box || !window.FHRanked || !window.FHAuth) return;
    box.classList.remove('hidden');
    box.innerHTML = '<p class="ranked-result-loading">Confirmando resultado con el servidor…</p>';
    try {
      const session = await FHAuth.getSession();
      if (!session) { box.classList.add('hidden'); box.innerHTML=''; return; }
      const myUid = session.user.id;
      const resultado = await FHRanked.call('cerrar', { matchId: room.rankedMatchId });
      const soyA   = resultado.aUid === myUid;
      const delta  = (soyA ? resultado.eloDeltaA : resultado.eloDeltaB) ?? 0;
      const gane   = !!resultado.ganadorUid && resultado.ganadorUid === myUid;
      const empate = !resultado.ganadorUid;

      let despues = null;
      try {
        const perfil = await FHRanked.perfil('coche');
        const fila = perfil && Array.isArray(perfil.juegos) && perfil.juegos.find(j => j.juego === 'coche');
        if (fila && typeof fila.elo === 'number') despues = fila.elo;
      } catch(e) { /* sin perfil fresco, se muestra solo el delta */ }

      const antes = despues != null ? despues - delta : null;
      const tramoDespues = despues != null ? FHRanked.tramoDeElo(despues) : null;
      const tramoAntes   = antes   != null ? FHRanked.tramoDeElo(antes)   : null;
      const subioTramo = tramoAntes != null && tramoDespues != null && tramoDespues > tramoAntes;
      const bajoTramo  = tramoAntes != null && tramoDespues != null && tramoDespues < tramoAntes;
      const infoTramo  = (window.FHLiga && tramoDespues != null) ? FHLiga.tramoInfo(tramoDespues) : null;

      const resultLabel = empate ? 'EMPATE' : (gane ? '¡VICTORIA!' : 'DERROTA');
      const resultClass = empate ? 'ranked-result-tie' : (gane ? 'ranked-result-win' : 'ranked-result-loss');
      const signo = delta > 0 ? '+' : '';

      box.innerHTML = `
        <div class="ranked-result-card ${resultClass}">
          <div class="ranked-result-label">${_escHtml(resultLabel)}</div>
          <div class="ranked-result-elo">
            ${antes != null ? `<span class="ranked-elo-antes">${antes}</span><span class="ranked-elo-arrow">→</span>` : ''}
            <span class="ranked-elo-despues">${despues ?? '—'}</span>
            <span class="ranked-elo-delta">${signo}${delta}</span>
          </div>
          ${infoTramo ? `
            <div class="ranked-result-tramo">
              <img src="${_escHtml(infoTramo.logo)}" alt="" class="ranked-tramo-logo" onerror="this.style.display='none'">
              <span>${infoTramo.emoji} ${_escHtml(infoTramo.nombre)}</span>
            </div>` : ''}
          ${subioTramo ? '<div class="ranked-result-ascenso">⬆ ¡Has subido de tramo!</div>' : ''}
          ${bajoTramo  ? '<div class="ranked-result-descenso">⬇ Has bajado de tramo</div>' : ''}
        </div>`;
    } catch(e) {
      console.warn('[App] No se pudo confirmar el resultado ranked:', e);
      box.innerHTML = '<p class="ranked-result-error">No se pudo confirmar el resultado con el servidor. Tu ELO se actualizará solo si vuelves a abrir Coche más tarde.</p>';
    }
  }

  /* Muestra un contador regresivo antes de ejecutar onDone().
     Usada tanto para el modo local como para el online. */
  function _showFinishedCountdown(roomOrNull, secs, onDone) {
    if (_finishedDelayTimer) return;
    if (roomOrNull) _pendingFinishedRoom = roomOrNull;
    const nxt = document.getElementById('btn-next-round');
    let cdEl = document.getElementById('_finished-cd');
    if (!cdEl) {
      cdEl = document.createElement('div');
      cdEl.id = '_finished-cd';
      /* Por token: el dorado a fuego con opacity .8 daba 2,2:1 sobre el papel
         crema del diseño Clásico, del mismo estilo que la leyenda de abajo. */
      cdEl.style.cssText = "text-align:center;font-family:'Bebas Neue',sans-serif;" +
        "font-size:1rem;letter-spacing:3px;color:var(--np-red);padding:8px 0;";
      const footer = (nxt && nxt.parentNode) || document.querySelector('.results-actions');
      if (footer) footer.insertBefore(cdEl, footer.firstChild);
    }
    if (nxt) nxt.style.display = 'none';
    const endAt = Date.now() + secs * 1000;
    cdEl.textContent = '🏆 GANADOR EN ' + secs + 's…';
    _finishedDelayTimer = setInterval(() => {
      const remaining = Math.ceil((endAt - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(_finishedDelayTimer);
        _finishedDelayTimer = null;
        cdEl.remove();
        if (nxt) nxt.style.display = '';
        if (onDone) onDone();
        else _doShowFinished(_pendingFinishedRoom);
      } else {
        cdEl.textContent = '🏆 GANADOR EN ' + remaining + 's…';
      }
    }, 200);
  }

  function _showFinishedScreen(room) {
    _stopTimer();
    if (_finishedDelayTimer) {
      /* Actualizar datos pero no reiniciar el countdown */
      _pendingFinishedRoom = room;
      return;
    }
    if (_currentScreen() === 'screen-results') {
      /* Estamos viendo los resultados: mostrar countdown de 10s */
      _showFinishedCountdown(room, 10);
    } else {
      /* Aún no vemos resultados: mostrar pantalla de ganadores directamente */
      _doShowFinished(room);
    }
  }

  /* ════════════════════════════════════════
     JUGAR DE NUEVO / MENÚ
     ════════════════════════════════════════ */
  async function playAgain() {
    /* Clasificatoria no tiene "revancha": resetToLobby solo reinicia
       status/round/players, nunca isRanked/rankedMatchId/rankedSeedBase, así
       que reutilizar la sala repetía la MISMA partida ya cerrada con la
       misma semilla (el arbitro rechazaba cada submit con partida_no_activa
       y el resultado final que se veía era el de la partida vieja). Una
       partida ranked nueva exige un "crear" nuevo en el arbitro, así que
       "jugar de nuevo" aquí es simplemente: salir y volver a buscar rival. */
    if (_isRanked) { await leaveRoom(); setTab('ranked'); return; }
    _wantReplay = true;
    if (!_roomCode||!_lastRoom?.players) { showMenu(); return; }
    const token = _sessionToken;
    const room  = _roomCode;
    /* Deshabilitar el botón para evitar dobles pulsaciones */
    const replayBtn = document.getElementById('btn-play-again');
    if (replayBtn) { replayBtn.disabled = true; }
    try {
      /* Reclamar atómicamente el derecho a resetear: sólo un jugador gana.
         Esto elimina la condición de carrera donde AMBOS reseteaban (uno
         sobreescribiendo al otro y echando jugadores del lobby). */
      const won = await Sync.claimReset(room);
      if (_sessionToken !== token || _roomCode !== room) return; /* salimos mientras tanto */
      if (won) {
        /* Somos el resetter → host del nuevo lobby */
        _isHost = true;
        await Sync.resetToLobby(room, _lastRoom.players, _playerId);
        if (_sessionToken !== token || _roomCode !== room) return;
        _showLobby();
      } else {
        /* Otro jugador está reseteando (o ya reseteó) → esperar a 'waiting' y re-unirse.
           Reintentamos un breve periodo por si todavía está en 'resetting'. */
        _isHost = false;
        let joined = false;
        for (let i = 0; i < 20; i++) {            /* hasta ~5s */
          const current = await Sync.getRoom(room);
          if (_sessionToken !== token || _roomCode !== room) return;
          if (!current) { showMenu(); return; }   /* sala desapareció */
          if (current.status === 'waiting') {
            await Sync.rejoinRoom(room, _playerId, _localName, _accountAvatar());
            joined = true;
            break;
          }
          if (current.status === 'expired') { _handleKicked('La sala expiró ⏱️'); return; }
          await new Promise(r => setTimeout(r, 250));
        }
        if (_sessionToken !== token || _roomCode !== room) return;
        if (!joined) { showMenu(); return; }
        _showLobby();
      }
    }
    catch(e) {
      if (_sessionToken !== token || _roomCode !== room) return;
      console.error('[App] playAgain error:', e);
      showMenu();
    }
    finally {
      if (replayBtn) replayBtn.disabled = false;
    }
  }

  function showMenu() {
    _newSession();
    _stopTimer(); _clearPublicLobbyTimer();
    if (_unsubRoom) { _unsubRoom(); _unsubRoom=null; }
    _clearSession(); _resetState();
    _showScreen('screen-menu');
    if (window.FHRuta) FHRuta.borrar('sala');
    else history.replaceState({}, '', window.location.pathname);
    const pBtn=document.getElementById('btn-find-public');
    if (pBtn) { pBtn.disabled=false; pBtn.textContent='BUSCAR PARTIDA ▶'; }
    setTab('private');
  }

  /* ════════════════════════════════════════
     EXPULSIÓN
     ════════════════════════════════════════ */
  function _handleKicked(msg='Has sido expulsado de la sala') {
    _newSession();
    _stopTimer(); _clearPublicLobbyTimer();
    if (_unsubRoom) { _unsubRoom(); _unsubRoom=null; }
    _clearSession(); _resetState();
    _showScreen('screen-menu');
    if (window.FHRuta) FHRuta.borrar('sala');
    else history.replaceState({}, '', window.location.pathname);
    setTab('private');
    setTimeout(()=>showToast(msg,'error'), 300);
  }

  /* ════════════════════════════════════════
     CALCULAR RESULTADOS
     Empate: ambos suman 1 punto. Si nadie
     eligió un jugador válido, nadie suma.
     ════════════════════════════════════════ */
  async function _computeResults(submissions, restrictions, players) {
    const results = {};
    /* Lanzar todos los lookups en paralelo en lugar de uno a uno */
    const lookups = await Promise.all(players.map(p => {
      const sub = submissions[p.id];
      if (!sub || !sub.playerName) return Promise.resolve({ p, sub: null, player: null });
      /* Si hay ID almacenado, buscar por ID directamente para evitar colisiones de nombre */
      const fid = sub.footballerId || null;
      const lookupFn = fid
        ? _getChunkData(fid).then(chunk => {
            let built = _buildPlayerFromChunk(fid, chunk);
            if (built) {
              const sid = String(fid);
              const mapTrophies = _TROPHY_MAP[sid] || [];
              if (mapTrophies.length > 0) built.trophies = [...new Set([...(built.trophies||[]), ...mapTrophies])];
              built.teammates = _TEAMMATE_MAP[sid] || built.teammates || [];
              built.coaches   = _COACH_MAP[sid]    || built.coaches   || [];
            }
            return built;
          })
        : findPlayerAsync(sub.playerName);
      return lookupFn.then(player => ({ p, sub, player })).catch(() => ({ p, sub, player: null }));
    }));
    for (const { p, sub, player } of lookups) {
      if (!sub || !sub.playerName) {
        results[p.id]={playerName:null,valid:false,matchCount:0,matches:restrictions.map(()=>false),footballer:null,points:0,isWinner:false};
        continue;
      }
      if (!player) {
        results[p.id]={playerName:sub.playerName,valid:false,matchCount:0,matches:restrictions.map(()=>false),footballer:null,points:0,isWinner:false};
        continue;
      }
      const matches    = restrictions.map(r => Restrictions.validate(player, r));
      const matchCount = matches.filter(Boolean).length;
      results[p.id]={playerName:sub.playerName, valid:true, matchCount,
        matches, footballer:player.name, footballerImg:player.img||null, points:0, isWinner:false};
    }
    const maxMatches = Math.max(...Object.values(results).map(r=>r.matchCount));
    if (maxMatches>0) {
      /* Calcular diferencia de restricciones respecto al segundo mejor */
      const sortedCounts = Object.values(results)
        .map(r=>r.matchCount).sort((a,b)=>b-a);
      const secondBest = sortedCounts.length > 1 ? sortedCounts[1] : 0;
      /* Puntos = diferencia sobre el segundo (mín 1). En empate todos ganan 1 */
      const winners = Object.values(results).filter(r => r.valid && r.matchCount===maxMatches);
      const pts = winners.length > 1 ? 1 : Math.max(1, maxMatches - secondBest);
      for (const r of winners) { r.isWinner=true; r.points=pts; }
      /* Guardar para mostrarlo en la UI */
      for (const r of Object.values(results)) { r.pointsToWin = pts; }
    }
    return results;
  }

  function _applyPoints(players, results) {
    return players.map(p=>({...p, score:(p.score||0)+(results[p.id]?.points||0)}));
  }

  /* ════════════════════════════════════════
     RENDER
     ════════════════════════════════════════ */
  function _renderTopbar(round, players) {
    const rEl=document.getElementById('round-number');
    if (rEl) rEl.textContent=round;
    const sb=document.getElementById('round-scoreboard');
    if (!sb) return;
    sb.innerHTML=players.map(p=>`
      <div class="sb-player ${p.id===_playerId?'me':''}">
        <span class="sb-name">${_escHtml(p.name)}</span>
        <span class="sb-score">${p.score||0}</span>
      </div>
    `).join('');
  }

  function _renderSubmissions(players, submissions) {
    const grid=document.getElementById('submissions-grid');
    if (!grid) return;
    grid.innerHTML=players.map(p=>{
      const submission = submissions[p.id] || null;
      const sent=!!submission;
      const isMe=p.id===_playerId;
      const chosenName = submission?.playerName?.trim() || '';
      return `
        <div class="submission-item ${sent?'submitted':''} ${isMe?'me':''}">
          <div class="submission-item-head">
            <div class="submission-avatar">${_avatarInner(p)}</div>
            <div class="submission-meta">
              <span class="submission-name">${_escHtml(p.name)}</span>
              <span class="submission-status">${sent?'Jugador bloqueado':'Esperando elección'}</span>
            </div>
          </div>
          <div class="submission-choice ${sent?'':'pending'}">${sent ? _escHtml(chosenName) : 'Aún sin bloquear'}</div>
        </div>
      `;
    }).join('');
  }

  function _renderResultsUI(round, restrictions, results, players) {
    document.getElementById('results-round-num').textContent=round;
    const listEl=document.getElementById('results-list');
    if (listEl) {
      const sorted=[...players]
        .map(p=>({p,r:results[p.id]||{}}))
        .sort((a,b)=>(b.r.isWinner?1:0)-(a.r.isWinner?1:0)||(b.r.matchCount||0)-(a.r.matchCount||0));

      listEl.innerHTML=sorted.map(({p,r})=>{
        const notFound=r.playerName&&!r.valid;
        const noSubmit=!r.playerName;

        const photoHtml = (r.valid && r.footballerImg)
          ? `<img class="result-footballer-photo" src="${_escHtml(fhImgUrl(r.footballerImg))}" alt="" loading="lazy"
                 onerror="this.style.display='none'">`
          : '';

        const metBadges = (r.valid && restrictions)
          ? restrictions.map((rs,i) => {
              if (!r.matches?.[i]) return '';
              const iconHtml = rs.imgUrl
                ? `<img class="rr-badge-img" src="${_escHtml(fhImgUrl(rs.imgUrl))}"
                       onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" alt="">
                   <span style="display:none">${_escHtml(rs.icon||'❓')}</span>`
                : `<span class="rr-badge-icon">${_escHtml(rs.icon||'❓')}</span>`;
              return `<div class="rr-badge met" title="${_escHtml(rs.label)}">
                <span class="rr-badge-icon-wrap">${iconHtml}</span>
                <span>${_escHtml(rs.label)}</span>
              </div>`;
            }).join('')
          : '';

        const footballerHtml = noSubmit
          ? '<div class="result-no-submit">Sin respuesta</div>'
          : notFound
            ? `<div class="result-footballer not-found">${_escHtml(r.playerName)}</div>
               <div class="result-not-found-hint">⚠ No encontrado en la base de datos</div>`
            : `<div class="result-footballer-row">
                <div class="result-main-block">
                  ${photoHtml}
                  <div class="result-footballer-info">
                    <div class="result-footballer">${_escHtml(r.footballer||r.playerName)}</div>
                    <div class="result-match-count"><span class="count-value">${r.matchCount}</span> / ${restrictions?.length||5} restricciones</div>
                  </div>
                </div>
                ${metBadges ? `<div class="result-restrictions">${metBadges}</div>` : ''}
              </div>`;

        return `
          <div class="result-card ${r.isWinner?'winner':''} ${!r.valid&&!noSubmit?'invalid':''}">
            <div class="result-card-header">
              <div class="result-player-name">${_escHtml(p.name)}</div>
              <div style="display:flex;gap:6px;align-items:center;">
                ${r.isWinner?'<div class="result-winner-badge">🏆 GANADOR</div>':''}
                ${r.isWinner?`<div class="result-points-badge">+${r.points||1} pto${(r.points||1)>1?'s':''}</div>`:''}
              </div>
            </div>
            ${footballerHtml}
          </div>`;
      }).join('');
    }

    /* Leyenda de restricciones */
    const legendEl=document.getElementById('results-restrictions-legend');
    if (legendEl&&restrictions) {
      /* Los colores van por token, NO a fuego. Esto llevaba desde el diseño
         oscuro de antes un `color:#e8e8e8; opacity:.55` sobre un panel que hoy
         es papel crema (--np-paper): 1,05:1 de contraste, o sea invisible en el
         diseño Clásico. El `opacity` es lo que remataba la faena, así que
         tampoco vuelve: si hace falta texto tenue, se usa --np-ink-mid. */
      legendEl.innerHTML=`
        <div style="padding:0 14px 12px;">
          <p style="font-size:.7rem;letter-spacing:2px;color:var(--np-red);text-transform:uppercase;margin-bottom:8px;font-weight:700;">Las 5 restricciones</p>
          ${restrictions.map(r=>`
            <div style="display:flex;align-items:center;gap:8px;font-size:.82rem;color:var(--np-ink);font-weight:600;margin-bottom:5px;">
              ${r.imgUrl
                ? `<img src="${_escHtml(fhImgUrl(r.imgUrl))}" style="width:18px;height:18px;object-fit:contain;flex:0 0 auto;"
                      onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" alt="">
                   <span style="flex:0 0 auto;display:none;">${_escHtml(r.icon||'❓')}</span>`
                : `<span style="flex:0 0 auto;">${_escHtml(r.icon||'❓')}</span>`}
              <span>${_escHtml(r.label)}</span>
            </div>`).join('')}
        </div>`;
    }
  }

  /* ════════════════════════════════════════
     AUTOCOMPLETE AVANZADO
     ════════════════════════════════════════ */
  /* _acNorm está definida globalmente al inicio del archivo */

  /* Devuelve true si CUALQUIER palabra individual del nombre empieza por q
     (p.ej. "thierry henry" → true cuando q="henry").
     Usado para dar prioridad cat:2 a apellidos/palabras que empiecen por la query. */
  function _acAnyWordStarts(n, q) {
    return n.split(' ').some(w => w.startsWith(q));
  }

  async function _acGetPlayer(id) {
    return _getChunkData(id);
  }

  function _acBestLeaguePrio(teams) {
    if (!_teamLeaguePrio || !teams?.length) return 999;
    return teams.reduce((best, t) => {
      const p = _teamLeaguePrio[_acNorm(t)] ?? 999;
      return p < best ? p : best;
    }, 999);
  }

  function _acHighlight(name, query) {
    const q = _acNorm(query);
    if (!q) return _escHtml(name);
    const n = _acNorm(name);
    const idx = n.indexOf(q);
    if (idx === -1) return _escHtml(name);
    /* La normalización puede cambiar longitudes (Ø→o, æ→ae, espacios colapsados),
       así que no se puede usar idx directamente sobre 'name'. Mapeamos carácter a
       carácter: avanzamos por 'name' acumulando su forma normalizada hasta cubrir
       el rango [idx, idx+q.length) en coordenadas normalizadas. */
    let normPos = 0, startRaw = -1, endRaw = name.length;
    for (let i = 0; i <= name.length; i++) {
      if (normPos >= idx && startRaw === -1) startRaw = i;
      if (normPos >= idx + q.length) { endRaw = i; break; }
      if (i < name.length) normPos += _acNorm(name[i]).length;
    }
    if (startRaw === -1) return _escHtml(name);
    /* El resultado va a innerHTML: hay que escapar los trozos. En el Top y La
       Carrera ya lo hacen en su highlight(); aquí faltaba, así que un nombre
       de la base con &, < o > rompía el marcado de la lista. */
    return _escHtml(name.slice(0, startRaw))
      + '<span class="autocomplete-highlight">' + _escHtml(name.slice(startRaw, endRaw)) + '</span>'
      + _escHtml(name.slice(endRaw));
  }

  function _acRender(items, query) {
    const list = document.getElementById('autocomplete-list');
    if (!list) return;
    if (!items.length) { _acClose(); return; }
    _acItems = items;
    _acIndex = 0;  // preseleccionar el primero
    list.innerHTML = items.map((item, i) => {
      const meta = item.disambig ? `<span class="autocomplete-nat">${item.disambig}</span>` : '';
      return `<div class="autocomplete-item${i === 0 ? ' selected' : ''}" data-index="${i}"
                   onclick="App.selectAndSubmit(${i})">
        <span>${_acHighlight(item.name, query)}</span>
        ${meta}
      </div>`;
    }).join('');
    list.classList.remove('hidden');
  }

  function _acClose() {
    const list = document.getElementById('autocomplete-list');
    if (list) { list.classList.add('hidden'); list.innerHTML = ''; }
    _acItems = []; _acIndex = -1;
  }

  function _acUpdateHighlight() {
    const els = document.querySelectorAll('#autocomplete-list .autocomplete-item');
    els.forEach((el, i) => el.classList.toggle('selected', i === _acIndex));
    if (_acIndex >= 0 && els[_acIndex]) els[_acIndex].scrollIntoView({ block: 'nearest' });
  }

  async function _onPlayerInputChange(value) {
    clearTimeout(_acDebounce);
    _acSelected = null;
    if (!value || value.length < 2) { _acClose(); return; }

    _acDebounce = setTimeout(async () => {
      const q = _acNorm(value);
      const qTight = _acTight(value);

      /* ── Buscar en NAME_INDEX eliminando duplicados de ID ── */
      let exact = [], starts = [], wordBound = [], contains = [];
      const seenIds = new Set();

      for (const [id, name] of NAME_INDEX) {
        const sid = String(id);
        if (seenIds.has(sid)) continue;       // descartar ID duplicado
        seenIds.add(sid);
        const n = _acNorm(name);
        if      (n === q)               exact.push([sid, name]);
        else if (n.startsWith(q))       starts.push([sid, name]);
        else if (_acAnyWordStarts(n, q)) wordBound.push([sid, name]);
        else if (n.includes(q))         contains.push([sid, name]);
        /* Último intento ignorando los espacios, para que "eto o" encuentre
           a Eto'o y "alexanderarnold" a Alexander-Arnold */
        else if (qTight && _acTight(name).includes(qTight)) contains.push([sid, name]);
      }

      /* También descartar nombres normalizados repetidos (mismo jugador, distinta grafía)
         — solo en la previsualización rápida, el sort final resuelve el resto */
      const tagged = [
        ...exact.map(([id,name])     => ({id, name, cat:0})),
        ...starts.map(([id,name])    => ({id, name, cat:1})),
        ...wordBound.map(([id,name]) => ({id, name, cat:2})),
        ...contains.map(([id,name])  => ({id, name, cat:3})),
      ];

      /* Previsualización rápida — solo primeros 8, sin datos extra */
      _acRender(tagged.slice(0,8).map(t => ({...t, disambig:''})), value);

      /* ── Cargar datos para ordenar correctamente ──
         Si los chunks ya están precargados (_chunksPreloaded), este paso
         es instantáneo porque _getChunkData usa el cache. */
      const FETCH_LIMIT = 40;
      const dataList = await Promise.all(tagged.slice(0, FETCH_LIMIT).map(t => {
        /* Siempre leer desde chunk (en cache tras precarga) para tener datos frescos */
        return _acGetPlayer(t.id);
      }));

      const withData = tagged.slice(0, FETCH_LIMIT).map((t, i) => {
        const d = dataList[i];
        return {
          ...t,
          teams:     d?.teams || [],
          apps:      d?.apps  || 0,
          pos:       d?.p     || '',
          nat:       d?.nat   || '',
          birthYear: d?.b ? parseInt(d.b, 10) : null,
          h:         d?.h ? Math.round(parseFloat(d.h)) : 0,
        };
      });

      /* ── Ordenar: categoría → prioridad de liga → partidos jugados ── */
      withData.sort((a, b) => {
        if (a.cat !== b.cat) return a.cat - b.cat;
        const pa = _acBestLeaguePrio(a.teams);
        const pb = _acBestLeaguePrio(b.teams);
        if (pa !== pb) return pa - pb;
        return (b.apps || 0) - (a.apps || 0);
      });

      /* ── Deduplicar por huella única (nombre + año nac + nación + altura redondeada) ──
         Elimina el mismo jugador indexado dos veces con IDs distintos pero datos idénticos
         (ej. dos Fernando Llorente con mismo año/nación/altura → uno solo).
         Si la huella es diferente (mismo nombre pero distintos datos reales) ambos pasan. */
      const seenFingerprints = new Set();
      const deduped = [];
      for (const item of withData) {
        const fp = `${_acNorm(item.name)}|${item.birthYear||''}|${item.nat||''}|${item.h||0}`;
        if (seenFingerprints.has(fp)) continue;
        seenFingerprints.add(fp);
        deduped.push(item);
        if (deduped.length >= 8) break;
      }

      /* ── Desambiguación en cascada para nombres iguales ──
         Posición → Nacionalidad → Año de nacimiento (igual que Cadena) */
      const POS_LABEL = { GK:'Portero', DEF:'Defensa', MID:'Centrocampista', FWD:'Delantero' };
      const finalItems = deduped.map((item, _, arr) => {
        const sameName = arr.filter(o => _acNorm(o.name) === _acNorm(item.name));
        const tags = [];
        const posLabel = POS_LABEL[item.pos] || item.pos || '';
        if (posLabel) tags.push(posLabel);
        if (sameName.length > 1) {
          const samePos = sameName.filter(o => o.pos === item.pos);
          if (samePos.length > 1 && item.nat) {
            tags.push(item.nat);
            const sameNat = samePos.filter(o => o.nat === item.nat);
            if (sameNat.length > 1 && item.birthYear) tags.push('n. ' + item.birthYear);
          }
        }
        return { ...item, disambig: tags.join(' · ') };
      });

      _acRender(finalItems, value);
    }, 150);
  }

  function selectAutocomplete(indexOrName) {
    let item;
    if (typeof indexOrName === 'number') { item = _acItems[indexOrName]; }
    else { item = _acItems.find(i => i.name === indexOrName); }
    if (!item) return;
    _acSelected = item;
    const pi = document.getElementById('player-input');
    if (pi) pi.value = item.name;
    _acClose();
    pi?.focus();
  }

  /* Click en sugerencia: seleccionar y enviar directamente */
  function selectAndSubmit(indexOrName) {
    selectAutocomplete(indexOrName);
    submitAnswer();
  }

  /* ════════════════════════════════════════
     COPIAR ENLACE
     ════════════════════════════════════════ */
  function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}?sala=${_roomCode}`;
    const linkEl = document.getElementById('lobby-link-display');
    if (linkEl) linkEl.textContent = url;
    const _fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(ok ? '🔗 Enlace copiado' : url, ok ? 'success' : '');
      } catch { showToast(url, ''); }
    };
    const _flashBtn = (ok) => {
      const btn = document.getElementById('btn-copy-link');
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = ok ? '✓ ¡Copiado!' : '📋 ' + url;
      btn.style.color = ok ? '#4ade80' : '#e8c96a';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => { showToast('🔗 Enlace copiado', 'success'); _flashBtn(true); })
        .catch(() => { _fallback(); _flashBtn(false); });
    } else {
      _fallback(); _flashBtn(true);
    }
  }

  /* ════════════════════════════════════════
     TOAST
     ════════════════════════════════════════ */
  function showToast(msg, type='') {
    const el=document.getElementById('toast');
    if (!el) return;
    el.textContent=msg; el.className=`toast show ${type}`;
    clearTimeout(_toastTimeout);
    _toastTimeout=setTimeout(()=>el.classList.remove('show'), 2800);
  }

  /* ════════════════════════════════════════
     HELPERS
     ════════════════════════════════════════ */
  function _showScreen(id) {
    /* Se busca la pantalla PRIMERO y solo se apagan las demás si existe. Al
       revés —apagar todas y luego encender— basta con que el id no esté (un
       renombrado, una pantalla retirada) para dejar la página sin ninguna
       pantalla activa: en blanco y, en la PWA, sin forma de salir. */
    const destino = document.getElementById(id);
    if (!destino) { console.error('[Coche] No existe la pantalla #' + id); return; }
    destino.classList.add('active');
    document.querySelectorAll('.screen').forEach(s => {
      if (s !== destino) s.classList.remove('active');
    });
  }
  function _currentScreen() {
    return [...document.querySelectorAll('.screen')].find(s=>s.classList.contains('active'))?.id||'';
  }
  function _showError(id,msg) { const el=document.getElementById(id); if (el){el.textContent=msg;el.classList.remove('hidden');} }
  function _clearError(id)    { const el=document.getElementById(id); if (el){el.textContent='';el.classList.add('hidden');} }
  function _btnLoad(btn,txt)  { if (btn){btn.disabled=true;btn.textContent=txt;} }
  function _btnReset(btn,txt) { if (btn){btn.disabled=false;btn.textContent=txt;} }

  /* Limpia todos los elementos DOM residuales de partida/ronda anterior */
  function _cleanupRoundDOM() {
    const sdBanner = document.getElementById('sudden-death-banner');
    if (sdBanner) sdBanner.remove();
    const sdResults = document.getElementById('sd-results-banner');
    if (sdResults) sdResults.remove();
    const finishedCd = document.getElementById('_finished-cd');
    if (finishedCd) finishedCd.remove();
    /* Ocultar overlay de countdown por si quedó visible */
    const overlay = document.getElementById('countdown-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.classList.remove('countdown-active');
    /* Limpiar grid de restricciones y submissions */
    const rg = document.getElementById('restrictions-grid');
    if (rg) rg.innerHTML = '';
    const sg = document.getElementById('submissions-grid');
    if (sg) sg.innerHTML = '';
  }

  function _resetState() {
    if (typeof CocheBots !== 'undefined') CocheBots.stop();
    _lastArmedStatus=null;
    _roomCode=null; _playerId=null; _isHost=false; _isPublic=false;
    _isLocal=false; _localName='';
    _isRanked=false; _rankedMatchId=null; _rankedSeedBase=0;
    _round=0; _players=[]; _restrictions=[];
    _submitted=false; _mySubmission=null; _mySubmissionId=null; _revealTriggered=false;
    _lastRoom=null; _wantReplay=false;
    _isSuddenDeath=false; _suddenDeathPlayers=[];
    _onlinePointsToWin=7; _onlineRoundSecs=60;
    _nextRestrictionsCache=null;
    _stopTimer();
    _acClose();
    if (_finishedDelayTimer) { clearInterval(_finishedDelayTimer); _finishedDelayTimer=null; }
    _pendingFinishedRoom=null;
    /* Limpiar intervalo del timer de lobby público */
    if (_lobbyRenderTimerIv) { clearInterval(_lobbyRenderTimerIv); _lobbyRenderTimerIv=null; }
    if (_cooldownTickTimer)  { clearTimeout(_cooldownTickTimer);   _cooldownTickTimer=null; }
    /* Limpiar countdown de precarga */
    if (_preloadCountdownIv) { clearInterval(_preloadCountdownIv); _preloadCountdownIv=null; }
    /* Limpiar countdown online */
    if (_onlineCountdownIv) { clearInterval(_onlineCountdownIv); _onlineCountdownIv=null; }
    /* Limpiar DOM residual */
    _cleanupRoundDOM();
  }

  function _saveSession() {
    /* El nombre entra en la sesión: tryReconnect lo pide, y sin él la vuelta
       automática tras una recarga tendría que preguntarlo otra vez. */
    const data = JSON.stringify({code:_roomCode,playerId:_playerId,isHost:_isHost,isPublic:_isPublic,name:_localName||'',ts:Date.now()});
    try { sessionStorage.setItem('coche_session', data); } catch(e){}
    /* Además en localStorage: al CERRAR la app (no solo recargar la pestaña)
       sessionStorage se borra, y sin la sesión el jugador vuelve a entrar a su
       MISMA sala pública como un segundo nodo duplicado (se veía a sí mismo
       como host + su copia + bots). localStorage sobrevive al cierre y deja
       que tryReconnect reutilice el hueco existente en vez de duplicarlo. */
    try { localStorage.setItem('coche_session', data); } catch(e){}
  }
  function _loadSession() {
    let s = null;
    try { s = sessionStorage.getItem('coche_session'); } catch(e){}
    if (!s) { try { s = localStorage.getItem('coche_session'); } catch(e){} }
    if (!s) return null;
    try {
      const data = JSON.parse(s);
      /* No intentar reconectar a sesiones viejas (>15 min): la sala ya no
         existirá y tryReconnect fallaría igual, pero así se evita ruido. */
      if (data && data.ts && (Date.now() - data.ts) > 15*60*1000) return null;
      return data;
    } catch(e){ return null; }
  }
  function _clearSession() {
    try { sessionStorage.removeItem('coche_session'); } catch(e){}
    try { localStorage.removeItem('coche_session'); } catch(e){}
  }

  return {
    init, setTab,
    createRoom, joinRoom, findPublicRoom,
    buscarRival, cancelarBusquedaRival, toggleLeaderboard,
    adjustOnlinePoints, adjustOnlineSecs,
    leaveRoom, startGame, nextRound,
    submitAnswer, selectAutocomplete, selectAndSubmit,
    playAgain, showMenu, showToast, copyLink,
    _enrichPlayersDBFromChunks,
  };
})();

/* ─────────────────────────────────────────────
   EXPONER App en window
   ───────────────────────────────────────────── */
window._AppReal = App;

/* ─────────────────────────────────────────────
   ARRANQUE — igual que Cadena:
   Precargar datos y chunks nada más abrir la página,
   mientras el usuario está en el menú eligiendo nombre.
   ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  /* Empezar a descargar todos los chunks en background nada más abrir la página,
     mientras el usuario está en el menú eligiendo nombre — igual que Cadena.
     (Los datos de PLAYERS_DB los carga App.init() → _preloadDataInBackground) */
  const chunkPromises = [
    '0-99999','100000-199999','200000-299999','300000-399999','400000-499999',
    '500000-599999','600000-699999','700000-799999','800000-899999','900000-999999',
    '1000000-1099999','1100000-1199999','1200000-1299999','1300000-1399999','1400000-1499999',
  ].map(c => {
    const cf = `../data/players/chunks/${c}.json`;
    if (_chunkCache[cf]?.__full) return Promise.resolve();
    return _fetchChunkRangeFromSupabase(cf).then(data => {
      if (data) { data.__full = true; _chunkCache[cf] = data; }
    }).catch(() => {});
  });
  /* Cuando todos los chunks estén en caché, enriquecer PLAYERS_DB */
  Promise.all(chunkPromises).then(() => {
    if (typeof App !== 'undefined' && App._enrichPlayersDBFromChunks) {
      App._enrichPlayersDBFromChunks();
    }
    /* Compañeros (38 fotos): la foto viene de PLAYERS_DB (Supabase), no de
       un archivo local — nunca hubo fotos propias en data/players/photos. */
    ['28003','8198','132098','3979','342229','14132','68290','3373','45320','48280',
     '7607','35564','7825','17259','58358','35207','5817','406625','4673','288230',
     '3366','27992','26399','7980','88755','3455','5023','25557','3111','7476',
'5958']
      .forEach(id => {
        const p = PLAYERS_DB.find(x => x.id === id);
        if (p && p.img) _preloadImg(p.img);
      });
  });

  /* Precargar imágenes de restricciones (entrenadores, logos, trofeos, banderas)
     en background con baja prioridad para que estén en caché del navegador
     cuando la ronda empiece y las tarjetas se revelen */
  const _preloadImg = (src) => { const img = new Image(); img.src = fhImgUrl(src); };
  /* Entrenadores (12 fotos) */
  ['67','118','280','523','781','1522','2868','3517','5075','5672','6499','21284']
    .forEach(id => _preloadImg(sbStorageUrl('coach-photos', `${id}.png`)));
});
