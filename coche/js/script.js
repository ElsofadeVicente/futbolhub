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
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
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
let NAME_INDEX  = [];

/* ── Mapas globales para validación de jugadores fuera de PLAYERS_DB ── */
let _TROPHY_MAP         = {};  // id → [trophyName, ...]
let _COACH_MAP          = {};  // id → [coachName, ...]
let _TEAMMATE_MAP       = {};  // id → [playerName, ...]
let _REVERSE_TEAMMATE   = {};  // normalizedName → Set<normalizedName> (relación inversa)
let _REVERSE_TEAMMATE_IDS = {}; // normalizedName(famoso) → Set<id_string> (check por ID)

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

/* Datos propios de Coche (compañeros_principal.json, entrenados_por.json,
   etc.): archivos planos {clave: data} en Storage, igual que antes. */
async function _fetchCocheJsonFile(name) {
  try {
    const res = await fetch(sbStorageUrl('game-data', `coche/${name}`), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`[Coche] Error cargando coche/${name}:`, e);
    return {};
  }
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
    maxFee,
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

  const [companeros, entrenados, clubInt, seleccion, ligaCopa, premios, leagueData] = metaResults;

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
    .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
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

  /* Máxima transferencia en €  */
  function _maxFee(transfers) {
    if (!transfers || !transfers.length) return 0;
    return Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0));
  }

  /* PLAYERS_DB = solo compañeros_principal, enriquecidos con companeros-data.json
     (datos completos de chunk: img, apps, goals, nt, tr, etc.).
     Pequeño (~227 jugadores) → generate() es rápido.
     findPlayerAsync usa chunks on-demand para validar respuestas del usuario. */
  return Object.entries(companeros).map(([id, pd]) => {
    const chunk = allChunkData[id] || {};
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
      maxFee:       chunk.maxFee ?? _maxFee(chunk.tr ?? []),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   2. RESTRICTIONS
   ═══════════════════════════════════════════════════════════════ */
const Restrictions = (() => {

  /* ────────── Helpers RNG ────────── */
  function _mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function _shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function normalize(str) {
    if (!str) return '';
    return String(str).toLowerCase()
      .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  /* ────────── LOGOS ────────── */
  function _logoUrl(tmName) {
    return sbStorageUrl('team-logos', tmName.replace(/ /g, '_') + '.png');
  }

  /* ────────── LISTA 34 CLUBES ────────── */
  /* tmName = nombre exacto en Transfermarkt (para validar player.teams)  */
  /* display = nombre corto para mostrar en UI                            */
  const CLUBS_LIST = [
    { tmName:'Arsenal FC',           display:'Arsenal',        league:'Premier League' },
    { tmName:'Manchester City',      display:'Man. City',      league:'Premier League' },
    { tmName:'Manchester United',    display:'Man. United',    league:'Premier League' },
    { tmName:'Aston Villa',          display:'Aston Villa',    league:'Premier League' },
    { tmName:'Liverpool FC',         display:'Liverpool',      league:'Premier League' },
    { tmName:'Chelsea FC',           display:'Chelsea',        league:'Premier League' },
    { tmName:'Tottenham Hotspur',    display:'Tottenham',      league:'Premier League' },
    { tmName:'Paris Saint-Germain',  display:'PSG',            league:'Ligue 1' },
    { tmName:'AS Monaco',            display:'Monaco',         league:'Ligue 1' },
    { tmName:'Olympique Lyon',       display:'Lyon',           league:'Ligue 1' },
    { tmName:'Olympique Marseille',  display:'Marseille',      league:'Ligue 1' },
    { tmName:'Bayern Munich',        display:'Bayern',         league:'Bundesliga' },
    { tmName:'Borussia Dortmund',    display:'Dortmund',       league:'Bundesliga' },
    { tmName:'Juventus FC',          display:'Juventus',       league:'Serie A' },
    { tmName:'AS Roma',              display:'Roma',           league:'Serie A' },
    { tmName:'AC Milan',             display:'AC Milan',       league:'Serie A' },
    { tmName:'Inter Milan',          display:'Inter',          league:'Serie A' },
    { tmName:'SSC Napoli',           display:'Napoli',         league:'Serie A' },
    { tmName:'SS Lazio',             display:'Lazio',          league:'Serie A' },
    { tmName:'Ajax Amsterdam',       display:'Ajax',           league:'Eredivisie' },
    { tmName:'CA Boca Juniors',      display:'Boca Juniors',   league:'Argentina',  region:'sudamerica' },
    { tmName:'CA River Plate',       display:'River Plate',    league:'Argentina',  region:'sudamerica' },
    { tmName:'SL Benfica',           display:'Benfica',        league:'Primeira Liga' },
    { tmName:'FC Porto',             display:'Porto',          league:'Primeira Liga' },
    { tmName:'Sporting CP',          display:'Sporting CP',    league:'Primeira Liga' },
    { tmName:'PSV Eindhoven',        display:'PSV',            league:'Eredivisie' },
    { tmName:'FC Barcelona',         display:'Barcelona',      league:'La Liga' },
    { tmName:'Atlético de Madrid',   display:'Atlético',       league:'La Liga' },
    { tmName:'Real Madrid',          display:'Real Madrid',    league:'La Liga' },
    { tmName:'Valencia CF',          display:'Valencia',       league:'La Liga' },
    { tmName:'Sevilla FC',           display:'Sevilla',        league:'La Liga' },
    { tmName:'Real Betis Balompié',  display:'Betis',          league:'La Liga' },
    { tmName:'Villarreal CF',        display:'Villarreal',     league:'La Liga' },
    { tmName:'Athletic Bilbao',      display:'Athletic',       league:'La Liga' },
  { tmName:'Real Sociedad',        display:'Real Sociedad',  league:'La Liga' },
  { tmName:'West Ham United',      display:'West Ham',       league:'Premier League' },
  { tmName:'Leicester City',       display:'Leicester',      league:'Premier League' },
  { tmName:'Bayer 04 Leverkusen',  display:'Leverkusen',     league:'Bundesliga' },
  { tmName:'FC Schalke 04',        display:'Schalke',        league:'Bundesliga' },
  { tmName:'ACF Fiorentina',       display:'Fiorentina',     league:'Serie A' },
  { tmName:'Atalanta BC',          display:'Atalanta',       league:'Serie A' },
  { tmName:'Galatasaray',          display:'Galatasaray',    league:'Süper Lig' },
  { tmName:'Besiktas JK',          display:'Beşiktaş',       league:'Süper Lig' },
  { tmName:'Fenerbahçe',           display:'Fenerbahçe',     league:'Süper Lig' },
  { tmName:'Celtic FC',            display:'Celtic',         league:'Scottish Premiership' },
  { tmName:'Feyenoord Rotterdam',  display:'Feyenoord',      league:'Eredivisie' },
  { tmName:'Newcastle United',     display:'Newcastle',      league:'Premier League' },
  { tmName:'CR Flamengo',          display:'Flamengo',       league:'Brasileirão',  region:'sudamerica' },
  ].map(c => ({ ...c, logoUrl: _logoUrl(c.tmName) }));

  /* ────────── EQUIPOS POR LIGA ────────── */
  /* Nombres exactos de Transfermarkt para validar player.teams */
  const LEAGUE_TEAMS = {
    'La Liga': [
      'FC Barcelona','Real Madrid','Atlético de Madrid','Valencia CF','Sevilla FC',
      'Real Betis Balompié','Villarreal CF','Athletic Bilbao','CA Osasuna','Celta de Vigo',
      'RCD Espanyol Barcelona','RCD Mallorca','Rayo Vallecano','Getafe CF','Girona FC',
      'Levante UD','Real Sociedad','Deportivo Alavés','Elche CF','Real Oviedo',
      'Málaga CF','Deportivo de La Coruña','Real Zaragoza','Cádiz CF','UD Almería',
      'Granada CF','SD Eibar','CD Leganés','SD Huesca','Real Valladolid CF',
      'UD Las Palmas','Sporting Gijón','CD Castellón','FC Cartagena','SD Ponferradina',
    ],
    'Premier League': [
      'Arsenal FC','Manchester City','Manchester United','Liverpool FC','Chelsea FC',
      'Tottenham Hotspur','Aston Villa','West Ham United','Everton FC','Leicester City',
      'Newcastle United','Wolverhampton Wanderers','Brighton & Hove Albion','Crystal Palace',
      'Fulham FC','Brentford FC','Nottingham Forest','AFC Bournemouth',
      'Leeds United','Burnley FC',
      'Blackburn Rovers','Bolton Wanderers','Stoke City','Swansea City','Norwich City',
      'Sunderland AFC','Middlesbrough FC','Birmingham City','Hull City',
      'Southampton FC','Ipswich Town','Luton Town','Sheffield United','Derby County',
    ],
    'Serie A': [
      'Juventus FC','AC Milan','Inter Milan','SSC Napoli','AS Roma','SS Lazio',
      'Atalanta BC','ACF Fiorentina','Torino FC','Udinese Calcio','Bologna FC 1909',
      'Cagliari Calcio','Genoa CFC','Hellas Verona','US Sassuolo','US Lecce',
      'US Cremonese','Parma Calcio 1913','Como 1907',
      'Sampdoria','Empoli FC','Venezia FC','AC Monza','Spezia Calcio',
      'Benevento Calcio','FC Crotone','Frosinone Calcio',
    ],
    'Bundesliga': [
      'Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer 04 Leverkusen',
      'Borussia Mönchengladbach','TSG 1899 Hoffenheim','Eintracht Frankfurt','VfL Wolfsburg',
      'SV Werder Bremen','1.FSV Mainz 05','FC Augsburg','SC Freiburg','1.FC Köln',
      '1.FC Union Berlin','VfB Stuttgart','1.FC Heidenheim 1846','Hamburger SV',
      'FC Schalke 04','Hertha BSC','VfL Bochum 1848','1.FC Nürnberg',
    ],
    'Ligue 1': [
      'Paris Saint-Germain','AS Monaco','Olympique Lyon','Olympique Marseille','LOSC Lille',
      'Stade Rennais FC','OGC Nice','RC Lens','RC Strasbourg Alsace','FC Nantes',
      'Angers SCO','FC Toulouse','Stade Brestois 29','AJ Auxerre','FC Lorient',
      'Le Havre AC','FC Metz','Paris FC',
      'Girondins de Bordeaux','AS Saint-Étienne','Montpellier HSC',
    ],
  };

  /* Logo de liga (bucket league-logos) */
  const LEAGUE_LOGOS = {
    'La Liga':        sbStorageUrl('league-logos', 'LaLiga.png'),
    'Premier League': sbStorageUrl('league-logos', 'PremierLeague.png'),
    'Serie A':        sbStorageUrl('league-logos', 'SerieA.png'),
    'Bundesliga':     sbStorageUrl('league-logos', 'Bundesliga.png'),
    'Ligue 1':        sbStorageUrl('league-logos', 'Ligue1.png'),
  };

  /* ────────── NACIONALIDADES ────────── */
  /* tmNat = valor en chunk.nat (inglés)   */
  const NATIONALITIES = [
    { tmNat:'Spain',       display:'España',    adj:'Español',    flag:'🇪🇸', flagImg:sbStorageUrl('team-flags','es.png') },
    { tmNat:'England',     display:'Inglaterra', adj:'Inglés',    flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', flagImg:sbStorageUrl('team-flags','eng.png') },
    { tmNat:'France',      display:'Francia',   adj:'Francés',   flag:'🇫🇷', flagImg:sbStorageUrl('team-flags','fr.png') },
    { tmNat:'Argentina',   display:'Argentina', adj:'Argentino', flag:'🇦🇷', flagImg:sbStorageUrl('team-flags','ar.png') },
    { tmNat:'Germany',     display:'Alemania',  adj:'Alemán',    flag:'🇩🇪', flagImg:sbStorageUrl('team-flags','de.png') },
    { tmNat:'Brazil',      display:'Brasil',    adj:'Brasileño', flag:'🇧🇷', flagImg:sbStorageUrl('team-flags','br.png') },
    { tmNat:'Netherlands', display:'Holanda',   adj:'Holandés',  flag:'🇳🇱', flagImg:sbStorageUrl('team-flags','nl.png') },
  ];

  /* ────────── CONTINENTES ────────── */
  const CONTINENT_NAT = {
    europeo:    ['Spain','England','France','Germany','Netherlands','Portugal','Italy',
                 'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
                 'Czech Republic','Czech','Switzerland','Austria','Turkey','Türkiye','Greece','Hungary',
                 'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
                 'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
                 'Ireland','Georgia','Kosovo','North Macedonia','North','Bulgaria','Cyprus','Latvia',
                 'Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar',
                 'Faroe','Faroe Islands'],
    americano:  ['Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
                 'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
                 'Trinidad and Tobago','Honduras','Costa Rica','Costa','Panama','Guatemala',
                 'El Salvador','Cuba','Dominican Republic','Canada','Haiti'],
    africano:   ['Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cote','Cameroon',
                 'Morocco','Egypt','Algeria','Tunisia','South Africa','South','Mali','Guinea',
                 'Burkina Faso','DR Congo','DR','Congo','Republic of the Congo','Togo','Gabon',
                 'Equatorial Guinea','Equatorial','Zimbabwe','Kenya','Cape Verde','Cape','Sierra Leone',
                 'Liberia','Gambia','The','Guinea-Bissau','Rwanda','Ethiopia','Tanzania',
                 'Zambia','Uganda','Angola','Mauritius','Mozambique','Madagascar',
                 'Benin','Niger','Chad','Sudan','South Sudan','Somalia','Eritrea',
                 'Djibouti','Comoros','Lesotho','Botswana','Namibia','Malawi',
                 'Eswatini','Libya','Mauritania','Central African Republic'],
    asiatico:   ['Japan','South Korea','Iran','Saudi Arabia','Saudi','Qatar','UAE','Australia',
                 'China','Iraq','Jordan','Bahrain','Kuwait','Uzbekistan','Vietnam',
                 'Thailand','Indonesia','Philippines','India','Pakistan','Bangladesh',
                 'North Korea','Malaysia','Oman','Lebanon','Palestine','Syria',
                 'New','New Zealand'],
  };

  /* ────────── REGIONES ────────── */
  const REGION_PATTERNS = {
    sudamerica:   ['boca','river','flamengo','santos','corinthians','sao paulo','gremio',
                   'palmeiras','atletico mineiro','vasco','fluminense','cruzeiro','sport recife',
                   'internacional','nacional','penarol','estudiantes','independiente',
                   'racing','san lorenzo','newells','rosario','tigre','colo-colo',
                   'u de chile','universidad','alianza','universitario','barcelona guay',
                   'liga de quito','dep quito','deportivo cali','junior','medellin'],
    usa_mexico:   ['galaxy','red bulls','new york city','fc dallas','toronto','seattle',
                   'portland','atlanta united','inter miami','chicago fire','columbus',
                   'new england','real salt lake','colorado','houston',
                   'dc united','d.c. united',
                   'los angeles fc','lafc','san jose','sporting kansas',
                   'vancouver whitecaps','montreal','philadelphia union',
                   'orlando city','nashville sc','minnesota united',
                   'fc cincinnati','austin fc','charlotte fc','st. louis city',
                   'chivas','america','cruz azul','pumas','toluca','monterrey','tigres',
                   'leon','guadalajara','pachuca','necaxa','veracruz','atlas','santos lag'],
    oriente_medio:['al-nassr','al-hilal','al-ittihad','al-ahli','al-qadsia',
                   'al-sadd','al-rayyan','al-duhail','al-ain','al-wahda',
                   'al-shabab','al-raed','al-taawoun','al-faisaly','al-fateh',
                   'al-jazira','al-wasl','al-najma','al-kharaitiyat',
                   'al-wehda','al-ettifaq','al-gharafa','al ain sc','al ain fc',
                   'riyadh','jeddah','sharjah','dubai','abu dhabi','kuwait',
                   'esteghlal','persepolis','tractors','sepahan',
                   'umm salal','pakhtakor','lokomotiv tashkent'],
  };

  /* ────────── TROFEOS DEFINIDOS ────────── */
  /* Estos deben coincidir EXACTAMENTE con las claves de los JSON         */
  const TROPHIES = {
    individual: [
      { key:'Pichichi La Liga',          display:'Pichichi',            icon:'⚽', imgUrl:sbStorageUrl('trophy-icons','pichichi.png') },
      { key:'Bota de Oro Premier League',display:'Bota de Oro Premier', icon:'⚽', imgUrl:sbStorageUrl('trophy-icons','bota_oro_premier.png') },
      { key:'Capocannoniere Serie A',    display:'Capocannoniere',      icon:'⚽', imgUrl:sbStorageUrl('trophy-icons','capocannoniere.png') },
      { key:'Maximo Goleador Bundesliga',display:'Goleador Bundesliga', icon:'⚽', imgUrl:sbStorageUrl('trophy-icons','goleador_bundesliga.png') },
      { key:'Maximo Goleador Ligue 1',   display:'Goleador Ligue 1',    icon:'⚽', imgUrl:sbStorageUrl('trophy-icons','goleador_ligue1.png') },
      { key:'Balon de Oro',              display:'Balón de Oro',        icon:'🏅', imgUrl:sbStorageUrl('trophy-icons','balon_oro.png') },
      { key:'Bota de Oro Mundial',       display:'Bota de Oro Mundial', icon:'🏅', imgUrl:sbStorageUrl('trophy-icons','bota_oro_mundial.png') },
      { key:'Bota de Oro Europea',       display:'Bota de Oro Europea', icon:'🏅', imgUrl:sbStorageUrl('trophy-icons','bota_oro_europea.png') },
    ],
    domestic: [
      { key:'Liga España',    display:'Ganador Liga Española', icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','liga_espana.png') },
      { key:'Liga Inglaterra',display:'Ganador Premier League',icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','liga_inglaterra.png') },
      { key:'Liga Italia',    display:'Ganador Serie A',       icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','liga_italia.png') },
      { key:'Liga Francia',   display:'Ganador Ligue 1',       icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','liga_francia.png') },
      { key:'Liga Alemania',  display:'Ganador Bundesliga',    icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','liga_alemania.png') },
      { key:'Copa España',    display:'Copa del Rey',          icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','copa_espana.png') },
      { key:'Copa Inglaterra',display:'FA Cup',                icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','copa_inglaterra.png') },
      { key:'Copa Italia',    display:'Coppa Italia',          icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','copa_italia.png') },
      { key:'Copa Francia',   display:'Coupe de France',       icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','copa_francia.png') },
      { key:'Copa Alemania',  display:'DFB-Pokal',             icon:'🏆', imgUrl:sbStorageUrl('trophy-icons','copa_alemania.png') },
    ],
    international_club: [
      { key:'Champions League',    display:'Champions League',    icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','champions.png') },
      { key:'Europa League',       display:'Europa League',       icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','europa_league.png') },
      { key:'Copa Libertadores',   display:'Copa Libertadores',   icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','copa_libertadores.png') },
      { key:'Conference League',   display:'Conference League',   icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','conference_league.png') },
    ],
    national: [
      { key:'Eurocopa',    display:'Eurocopa',   icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','eurocopa.png') },
      { key:'Mundial',     display:'Mundial',    icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','mundial.png') },
      { key:'Copa America',display:'Copa América',icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','copa_america.png') },
    ],
  };

  /* ────────── ENTRENADORES ────────── */
  const COACHES_LIST = [
    { name:'Hansi Flick',       id:'67',   icon:'🎽' },
    { name:'Jürgen Klopp',      id:'118',  icon:'🎽' },
    { name:'Arsène Wenger',     id:'280',  icon:'🎽' },
    { name:'Carlo Ancelotti',   id:'523',  icon:'🎽' },
    { name:'José Mourinho',     id:'781',  icon:'🎽' },
    { name:'Rafael Benítez',    id:'1522', icon:'🎽' },
    { name:'Diego Simeone',     id:'2868', icon:'🎽' },
    { name:'Antonio Conte',     id:'3517', icon:'🎽' },
    { name:'Unai Emery',        id:'5075', icon:'🎽' },
    { name:'Pep Guardiola',     id:'5672', icon:'🎽' },
    { name:'Luis Enrique',      id:'6499', icon:'🎽' },
    { name:'Zinédine Zidane',   id:'21284',icon:'🎽' },
  ];

  /* ────────── COMPAÑEROS ────────── */
  /* IDs de jugadores "famosos" para generar restricción compañero-de     */
  const TEAMMATES_LIST = [
    { name:'Lionel Messi',       display:'Messi',            id:'28003',  icon:'⚽' },
    { name:'Cristiano Ronaldo',  display:'Cristiano Ronaldo',id:'8198',   icon:'⚽' },
    { name:'Harry Kane',         display:'Kane',             id:'132098', icon:'⚽' },
    { name:'Iker Casillas',      display:'Casillas',         id:'3979',   icon:'⚽' },
    { name:'Kylian Mbappé',      display:'Mbappé',           id:'342229', icon:'⚽' },
    { name:'Pepe',               display:'Pepe',             id:'14132',  icon:'⚽' },
    { name:'Neymar',             display:'Neymar',           id:'68290',  icon:'⚽' },
    { name:'Ronaldinho',         display:'Ronaldinho',       id:'3373',   icon:'⚽' },
    { name:'Ángel Di María',     display:'Di María',         id:'45320',  icon:'⚽' },
    { name:'Edinson Cavani',     display:'Cavani',           id:'48280',  icon:'⚽' },
    { name:'Xavi',               display:'Xavi',             id:'7607',   icon:'⚽' },
    { name:'Fernando Llorente',  display:'Fernando Llorente',         id:'35564',  icon:'⚽' },
    { name:'Pepe Reina',         display:'Reina',            id:'7825',   icon:'⚽' },
    { name:'Manuel Neuer',       display:'Neuer',            id:'17259',  icon:'⚽' },
    { name:'Thomas Müller',      display:'Müller',           id:'58358',  icon:'⚽' },
    { name:'Marco Reus',         display:'Reus',             id:'35207',  icon:'⚽' },
    { name:'Andrea Pirlo',       display:'Pirlo',            id:'5817',   icon:'⚽' },
    { name:'Lautaro Martínez',   display:'Lautaro',          id:'406625', icon:'⚽' },
    { name:'Wesley Sneijder',    display:'Sneijder',         id:'4673',   icon:'⚽' },
    { name:'Ousmane Dembélé',    display:'Dembélé',          id:'288230', icon:'⚽' },
    { name:'Kaká',               display:'Kaká',             id:'3366',   icon:'⚽' },
    { name:'Luka Modrić',        display:'Modric',           id:'27992',  icon:'⚽' },
    { name:'Sergio Agüero',      display:'Agüero',           id:'26399',  icon:'⚽' },
    { name:'David Villa',        display:'David Villa',      id:'7980',   icon:'⚽' },
    { name:'Kevin De Bruyne',    display:'De Bruyne',        id:'88755',  icon:'⚽' },
    { name:'Zlatan Ibrahimović', display:'Ibrahimovic',      id:'3455',   icon:'⚽' },
    { name:'Gianluigi Buffon',   display:'Buffon',           id:'5023',   icon:'⚽' },
    { name:'Sergio Ramos',       display:'Sergio Ramos',     id:'25557',  icon:'⚽' },
    { name:'Zinédine Zidane',    display:'Zidane',           id:'3111',   icon:'⚽' },
    { name:'Xabi Alonso',        display:'Xabi Alonso',      id:'7476',   icon:'⚽' },
    { name:'Raphaël Varane',     display:'Varane',           id:'164770', icon:'⚽' },
    { name:'Mohamed Salah',      display:'Salah',            id:'148455', icon:'⚽' },
    { name:"N'Golo Kanté",      display:'Kanté',            id:'225083', icon:'⚽' },
    { name:'Alexis Sánchez',     display:'Alexis Sánchez',   id:'40433',  icon:'⚽' },
    { name:'Arjen Robben',       display:'Robben',           id:'4360',   icon:'⚽' },
    { name:'Fernando Torres',    display:'Torres',           id:'7767',   icon:'⚽' },
    { name:'Joaquín',            display:'Joaquín',          id:'7663',   icon:'⚽' },
    { name:'Francesco Totti',    display:'Totti',            id:'5958',   icon:'⚽' },
  ];

  /* ────────── Contar jugadores válidos (con early-exit) ────────── */
  function _matching(restriction, db, minNeeded) {
    const min = minNeeded || 2;
    let count = 0;
    for (let i = 0; i < db.length; i++) {
      if (validate(db[i], restriction)) {
        count++;
        if (count >= min) return count;   /* early exit — no necesitamos contar más */
      }
    }
    return count;
  }

  /* ────────── Construye el pool completo de candidatos mezclados con rng ────────── */
  function _buildCandidates(rng) {
    const candidates = [];

    /* Nacionalidades */
    for (const nat of _shuffle(NATIONALITIES, rng)) {
      candidates.push({
        type:'nationality', value:nat.tmNat, label:nat.adj,
        imgUrl: nat.flagImg, icon: nat.flag, family:'nationality',
      });
    }

    /* Ligas */
    for (const [liga, teams] of Object.entries(LEAGUE_TEAMS)) {
      candidates.push({
        type:'league', value:liga, teams, label:`Ha jugado en ${liga}`,
        imgUrl: LEAGUE_LOGOS[liga] || null, icon:'⚽', family:'league',
      });
    }

    /* Trofeos individuales */
    for (const t of _shuffle(TROPHIES.individual, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_individual' });
    }

    /* Trofeos domésticos */
    for (const t of _shuffle(TROPHIES.domestic, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:t.display, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_domestic' });
    }

    /* Trofeos internacionales con clubes */
    for (const t of _shuffle(TROPHIES.international_club, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_intl' });
    }

    /* Trofeos con selección */
    for (const t of _shuffle(TROPHIES.national, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_national' });
    }

    /* Entrenadores */
    for (const c of _shuffle(COACHES_LIST, rng)) {
      candidates.push({ type:'coach', value:c.name, label:`Entrenado por ${c.name}`, imgUrl:sbStorageUrl('coach-photos', `${c.id}.png`), icon:c.icon, family:'coach' });
    }

    /* Compañeros de */
    for (const p of _shuffle(TEAMMATES_LIST, rng)) {
      /* La foto viene de la BD de jugadores (Supabase), no de un archivo local:
         nunca hubo fotos propias en coche/data/players/photos. */
      const dbPlayer = PLAYERS_DB.find(x => x.id === p.id);
      candidates.push({ type:'teammate', value:p.name, label:`Compañero de ${p.display || p.name}`, imgUrl:(dbPlayer && dbPlayer.img) || null, icon:p.icon, family:'teammate' });
    }

    /* Continent */
    for (const [cont, label] of [['europeo','Europeo'],['americano','Continente Americano'],['africano','Africano'],['asiatico','Asiático']]) {
      candidates.push({ type:'continent', value:cont, label, imgUrl:null, icon:'🌍', family:'continent' });
    }

    /* Nacido en década */
    for (const [dec, label] of [['1980s','Nacido en los 80'],['1990s','Nacido en los 90'],['2000s','Nacido en los 2000']]) {
      candidates.push({ type:'birthDecade', value:dec, label, imgUrl:null, icon:'🎂', family:'birth' });
    }

    /* Altura */
    candidates.push({ type:'height_le', value:180, label:'Mide 180 cm o menos',  imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:180, label:'Mide 180 cm o más',    imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:190, label:'Mide 190 cm o más',    imgUrl:null, icon:'📏', family:'height' });

    /* Pie */
    candidates.push({ type:'foot', value:'left',  label:'Zurdo',       imgUrl:null, icon:'🦶', family:'foot' });
    candidates.push({ type:'foot', value:'right', label:'Diestro',     imgUrl:null, icon:'🦶', family:'foot' });

    /* Posición portero */
    candidates.push({ type:'position_gk',  label:'Portero', imgUrl:null, icon:'🧤', family:'position' });
    candidates.push({ type:'position_def', label:'Defensa', imgUrl:null, icon:'🛡️', family:'position' });

    /* Internacionalidades */
    candidates.push({ type:'caps_ge', value:50,  label:'50 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_le', value:50,  label:'50 o menos internacionalidades', imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_0',              label:'Sin internacionalidades',        imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:1,   label:'Internacional (≥1 partido)',     imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:100, label:'100 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });

    /* Clubes */
    candidates.push({ type:'clubs_ge', value:3, label:'Ha jugado en 3 o más clubes', imgUrl:null, icon:'🏟️', family:'clubs_count' });
    candidates.push({ type:'clubs_le', value:3, label:'Ha jugado en 3 o menos clubes',imgUrl:null, icon:'🏟️', family:'clubs_count' });

    /* Valor de traspaso */
    candidates.push({ type:'fee_gt', value:70000000, label:'Traspaso de más de 70M €',  imgUrl:null, icon:'💰', family:'fee' });
    candidates.push({ type:'fee_lt', value:70000000, label:'Traspaso de menos de 70M €',imgUrl:null, icon:'💰', family:'fee' });

    /* Regiones */
    candidates.push({ type:'region', value:'sudamerica',  label:'Ha jugado en Sudamérica',     imgUrl:null, icon:'🌎', family:'region' });
    candidates.push({ type:'region', value:'usa_mexico',  label:'Ha jugado en EE.UU./México',  imgUrl:null, icon:'🌎', family:'region' });
    candidates.push({ type:'region', value:'oriente_medio',label:'Ha jugado en Oriente Medio', imgUrl:null, icon:'🌎', family:'region' });

    /* Ganador liga/copa doméstica (general) */
    candidates.push({
      type:'trophy_any', value:['Liga España','Liga Inglaterra','Liga Italia','Liga Francia','Liga Alemania'],
      label:'Ganador Liga Doméstica', imgUrl:null, icon:'🏆', family:'trophy_general',
    });
    candidates.push({
      type:'trophy_any', value:['Copa España','Copa Inglaterra','Copa Italia','Copa Francia','Copa Alemania'],
      label:'Ganador Copa Doméstica', imgUrl:null, icon:'🏆', family:'trophy_general',
    });
    candidates.push({
      type:'trophy_any', value:['Eurocopa','Mundial','Copa America'],
      label:'Ganador con Selección', imgUrl:null, icon:'🌍', family:'trophy_general',
    });
    candidates.push({
      type:'trophy_any', value:['Champions League','Europa League','Copa Libertadores'],
      label:'Ganador título continental (clubes)', imgUrl:null, icon:'⭐', family:'trophy_general',
    });

    return candidates;
  }

  /* ────────── Generar restricciones ────────── */
  function generate(seed, db) {
    const rng = _mulberry32(seed);

    /* ══ PASO 1: Elegir restricciones de club ══ */
    const shuffledClubs = _shuffle(CLUBS_LIST, rng);

    /* ── B: Pre-filtrar pares de clubs por intersección mínima ── */
    const MIN_PAIR = Math.min(4, Math.max(2, Math.floor(db.length / 100)));
    const clubRestrictions = [];

    /* Club 1 */
    let club1 = null;
    for (const club of shuffledClubs) {
      const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
      if (_matching(r, db, 1) >= 1) { club1 = { r, meta: club }; break; }
    }
    if (!club1) {
      club1 = { r:{ type:'club', value:shuffledClubs[0].tmName, label:`Ha jugado en ${shuffledClubs[0].display}`, imgUrl:shuffledClubs[0].logoUrl, icon:'🏟️', family:'club' }, meta:shuffledClubs[0] };
    }
    clubRestrictions.push(club1.r);

    /* ── C: ~15% → sustituir club2 por una liga distinta a la del club1 ── */
    const useLeagueAsSecond = rng() < 0.15;

    if (useLeagueAsSecond) {
      const club1League = club1.meta.league;
      const otherLeagues = Object.entries(LEAGUE_TEAMS).filter(([lg]) => lg !== club1League);
      if (otherLeagues.length > 0) {
        const shuffledLeagues = _shuffle(otherLeagues, rng);
        for (const [liga, teams] of shuffledLeagues) {
          const lr = { type:'league', value:liga, teams, label:`Ha jugado en ${liga}`, imgUrl:LEAGUE_LOGOS[liga]||null, icon:'⚽', family:'league' };
          if (db.some(p => validate(p, club1.r) && validate(p, lr))) {
            clubRestrictions.push(lr); break;
          }
        }
      }
    }

    /* Club 2 (si no se usó liga) — B: intersección ≥ MIN_PAIR */
    if (clubRestrictions.length < 2) {
      for (const club of shuffledClubs) {
        if (club.tmName === club1.meta.tmName) continue;
        const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
        let pairCount = 0;
        for (const p of db) {
          if (validate(p, club1.r) && validate(p, r)) {
            pairCount++;
            if (pairCount >= MIN_PAIR) break;
          }
        }
        if (pairCount >= MIN_PAIR) { clubRestrictions.push(r); break; }
      }
    }
    /* Fallback: relajar a ≥ 1 */
    if (clubRestrictions.length < 2) {
      for (const club of shuffledClubs) {
        if (club.tmName === club1.meta.tmName) continue;
        const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
        if (db.some(p => validate(p, club1.r) && validate(p, r))) {
          clubRestrictions.push(r); break;
        }
      }
    }
    if (clubRestrictions.length < 2) {
      for (const club of CLUBS_LIST) {
        if (club.tmName !== club1.meta.tmName) {
          clubRestrictions.push({ type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' });
          break;
        }
      }
    }

    /* ══ PASO 2: Pool de candidatos ══ */
    const candidates = _buildCandidates(rng);

    /* ══ PASO 3: Filtrar jugables (mín 1 para compañeros, mín 2 para el resto) ══ */
    const playable = candidates.filter(r => {
      const min = r.type === 'teammate' ? 1 : 2;
      return _matching(r, db) >= min;
    });

    /* ══ PASO 4: D — Selección ponderada por familia ══
       Elegir primero una FAMILIA al azar (probabilidad uniforme),
       luego un candidato de esa familia. */
    const familyGroups = {};
    for (const r of playable) {
      const fam = r.family || r.type;
      if (!familyGroups[fam]) familyGroups[fam] = [];
      familyGroups[fam].push(r);
    }
    /* No repetir la familia del slot 2 si fue liga (C) */
    const usedFamilies = new Set();
    if (clubRestrictions.length === 2 && clubRestrictions[1].type === 'league') {
      usedFamilies.add('league');
    }

    const familyNames = _shuffle(
      Object.keys(familyGroups).filter(f => {
        if (!usedFamilies.has(f)) {
          if (f === 'position') return rng() < 0.50;
          return true;
        }
        return false;
      }),
      rng
    );
    const chosen = [];
    for (const fam of familyNames) {
      if (chosen.length >= 3) break;
      const group = _shuffle(familyGroups[fam], rng);
      if (group[0]) { chosen.push(group[0]); usedFamilies.add(fam); }
    }
    if (chosen.length < 3) {
      const remaining = _shuffle(playable.filter(r => !chosen.includes(r)), rng);
      for (const r of remaining) {
        if (chosen.length >= 3) break;
        chosen.push(r);
      }
    }

    let result = [...clubRestrictions, ...chosen.slice(0, 3)];

    /* ══ PASO 5: Eliminar redundancias (siempre sustituyendo, nunca eliminando) ══ */
    const shuffled = _shuffle(playable, rng);
    result = _removeRedundancies(result, shuffled, db);

    /* ══ PASO 6: Garantizar que ≥1 jugador cumple las 5 restricciones a la vez ══ */
    if (rng() < 0.70) {
      result = _ensureSolution(result, shuffled, db);
    }

    return result;
  }

  /* ────────── Detecta si rA hace redundante/imposible a rB ────────── */
  function _isRedundant(rA, rB) {
    /* Club de una liga concreta → la restricción de esa liga es redundante
       Ej: "Ha jugado en Tottenham" implica "Ha jugado en Premier League"  */
    if (rA.type === 'club' && rB.type === 'league') {
      const clubObj = CLUBS_LIST.find(c => c.tmName === rA.value);
      if (clubObj && clubObj.league === rB.value) return true;
    }
    /* Club de una región concreta → la restricción de esa región es redundante
       Ej: "Ha jugado en Boca Juniors" implica "Ha jugado en Sudamérica"   */
    if (rA.type === 'club' && rB.type === 'region') {
      const clubObj = CLUBS_LIST.find(c => c.tmName === rA.value);
      if (clubObj && clubObj.region === rB.value) return true;
    }
    /* Trofeo específico → trophy_any que lo incluye es redundante
       Ej: "Ganador Champions" implica "Ganador título continental"        */
    if (rA.type === 'trophy' && rB.type === 'trophy_any') {
      if ((rB.value || []).includes(rA.value)) return true;
    }
    /* trophy_any → trofeo específico que ya está cubierto (sentido inverso) */
    if (rA.type === 'trophy_any' && rB.type === 'trophy') {
      if ((rA.value || []).includes(rB.value)) return true;
    }
    /* Nacionalidad vs continente:
       - Si la nat NO está en el continente → imposible (incompatible)
       - Si la nat SÍ está en el continente → el continente es redundante
         Ej: "Alemán" implica "Europeo", por lo que "Europeo" sobra */
    if (rA.type === 'nationality' && rB.type === 'continent') {
      return true; /* siempre: o incompatible, o redundante — en cualquier caso rB sobra */
    }
    if (rA.type === 'continent' && rB.type === 'nationality') {
      return true; /* siempre: rA (continente) queda cubierto/descartado por rB (nat) */
    }
    /* caps_ge(N) hace redundante a caps_ge(M) si N > M (ej: ≥50 implica ≥1) */
    if (rA.type === 'caps_ge' && rB.type === 'caps_ge' && rA.value > rB.value) return true;
    /* caps_0 y caps_ge(≥1) son incompatibles entre sí */
    if (rA.type === 'caps_0' && rB.type === 'caps_ge') return true;
    if (rA.type === 'caps_ge' && rA.value >= 1 && rB.type === 'caps_0') return true;
    /* caps_le(N) hace redundante a caps_le(M) si N < M (ej: ≤30 implica ≤50) */
    if (rA.type === 'caps_le' && rB.type === 'caps_le' && rA.value < rB.value) return true;

    /* Portero incompatible con trofeos de goleador */
    const SCORER_TROPHIES = new Set([
      'Pichichi La Liga','Bota de Oro Premier League','Capocannoniere Serie A',
      'Maximo Goleador Bundesliga','Maximo Goleador Ligue 1',
      'Bota de Oro Mundial','Bota de Oro Europea',
    ]);
    if (rA.type === 'position_gk' && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_gk' && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'position_def' && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_def' && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;

    /* Sin internacionalidades (caps_0) es incompatible con trofeos de selección nacional */
    const NATIONAL_TROPHIES = new Set(['Eurocopa','Mundial','Copa America']);
    if (rA.type === 'caps_0' && rB.type === 'trophy' && NATIONAL_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'caps_0' && rA.type === 'trophy' && NATIONAL_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'caps_0' && rB.type === 'trophy_any') {
      const vals = rB.value || [];
      if (vals.some(v => NATIONAL_TROPHIES.has(v))) return true;
    }
    if (rB.type === 'caps_0' && rA.type === 'trophy_any') {
      const vals = rA.value || [];
      if (vals.some(v => NATIONAL_TROPHIES.has(v))) return true;
    }

    /* Pie: dos restricciones de foot distintas no pueden coexistir */
    if (rA.type === 'foot' && rB.type === 'foot') return true;

    /* Altura: height_le y height_ge con mismo valor son incompatibles
       (solo jugadores de exactamente ese valor cumplirían ambas) */
    if (rA.type === 'height_le' && rB.type === 'height_ge') return true;
    if (rA.type === 'height_ge' && rB.type === 'height_le') return true;
    /* Dos height_ge: el mayor hace redundante al menor */
    if (rA.type === 'height_ge' && rB.type === 'height_ge' && rA.value > rB.value) return true;

    return false;
  }

  /* ────────── Sustituye restricciones redundantes por otras del pool ────────── */
  function _removeRedundancies(restrictions, shuffledPool, db) {
    let result = [...restrictions];
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < result.length; i++) {
        for (let j = 0; j < result.length; j++) {
          if (i === j) continue;
          if (_isRedundant(result[i], result[j])) {
            /* result[j] es redundante respecto a result[i] — buscar sustituto */
            const usedFamilies = new Set(
              result.filter((_, k) => k !== j).map(r => r.family || r.type)
            );
            const replacement = shuffledPool.find(r =>
              !result.includes(r) &&
              !usedFamilies.has(r.family || r.type) &&
              /* el sustituto no debe ser redundante con ninguna restricción que quede */
              !result.some((existing, k) => k !== j && (_isRedundant(existing, r) || _isRedundant(r, existing))) &&
              _matching(r, db) >= 2
            );
            if (replacement) {
              result[j] = replacement;
              changed = true;
              break outer;
            }
            /* Si no hay sustituto disponible sin solapar familias, intentar
               cualquier candidato aunque repita familia (menos malo que dejar redundancia) */
            const relaxed = shuffledPool.find(r =>
              !result.includes(r) &&
              !result.some((existing, k) => k !== j && (_isRedundant(existing, r) || _isRedundant(r, existing))) &&
              _matching(r, db) >= 2
            );
            if (relaxed) {
              result[j] = relaxed;
              changed = true;
              break outer;
            }
            /* Sin candidatos en absoluto: dejar como está y salir del bucle
               (no se elimina — se mantienen las 5) */
            break outer;
          }
        }
      }
    }
    return result;
  }

  /* ────────── Garantiza que ≥1 jugador cumple todas las restricciones ────────── */
  function _ensureSolution(restrictions, shuffledPool, db) {
    /* Pre-filtrar DB a jugadores que cumplen los clubs fijos (índices 0-1).
       Esto reduce db de ~8000 a ~50-200, acelerando hasSolution 40-100x. */
    const clubRestrictions = restrictions.filter(r => r.type === 'club');
    const filteredDB = clubRestrictions.length > 0
      ? db.filter(p => clubRestrictions.every(cr => validate(p, cr)))
      : db;

    const hasSolution = (rs) => {
      /* Solo comprobar las restricciones no-club contra la DB pre-filtrada */
      const nonClub = rs.filter(r => r.type !== 'club');
      return filteredDB.some(p => nonClub.every(r => validate(p, r)));
    };
    if (hasSolution(restrictions)) return restrictions;

    const result = [...restrictions];
    /* Intentar sustituir restricciones no-club de una en una */
    const swappableIdx = result.map((_, i) => i).filter(i => result[i].type !== 'club');

    for (const idx of swappableIdx) {
      const original = result[idx];
      for (const candidate of shuffledPool) {
        if (result.includes(candidate)) continue;
        /* Evitar redundancias también con el candidato nuevo */
        const wouldBeRedundant = result.some((r, i) =>
          i !== idx && (_isRedundant(r, candidate) || _isRedundant(candidate, r))
        );
        if (wouldBeRedundant) continue;
        result[idx] = candidate;
        if (hasSolution(result)) return result;
      }
      /* Ningún candidato funcionó en esta posición — restaurar */
      result[idx] = original;
    }

    /* Último recurso: sustituir también clubs si es necesario */
    for (let idx = 0; idx < result.length; idx++) {
      if (swappableIdx.includes(idx)) continue; // ya probados
      const original = result[idx];
      for (const candidate of shuffledPool) {
        if (result.includes(candidate)) continue;
        result[idx] = candidate;
        if (hasSolution(result)) return result;
      }
      result[idx] = original;
    }

    /* ── Nuclear fallback: mantener los clubs y reconstruir las 3 no-club desde cero ── */
    const clubs = result.filter(r => r.type === 'club');
    const nonClubPool = shuffledPool.filter(r => r.type !== 'club');
    const nuclear = [...clubs];
    const usedFamilies = {};
    for (const candidate of nonClubPool) {
      if (nuclear.length >= 5) break;
      const fam = candidate.family || candidate.type;
      if ((usedFamilies[fam] || 0) >= 1) continue;
      if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
      nuclear.push(candidate);
      if (hasSolution(nuclear)) {
        usedFamilies[fam] = (usedFamilies[fam] || 0) + 1;
      } else {
        nuclear.pop();
      }
    }
    /* Rellenar hasta 5 si quedaron pocas (sin restricción de familia) */
    for (const candidate of nonClubPool) {
      if (nuclear.length >= 5) break;
      if (nuclear.includes(candidate)) continue;
      if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
      nuclear.push(candidate);
      if (!hasSolution(nuclear)) nuclear.pop();
    }
    if (hasSolution(nuclear) && nuclear.length === 5) return nuclear;

    /* Si absolutamente todo falla (no debería), devolver con clubs al menos correctos */
    return nuclear.length >= 2 ? nuclear : result;
  }

  /* ────────── Validar un jugador contra una restricción ────────── */
  function validate(player, r) {
    if (!player || !r) return false;
    switch (r.type) {
      /* Clubes */
      case 'club': {
        const match = (player.teams || []).some(c => normalize(c) === normalize(r.value));
        return match;
      }

      /* Nacionalidad */
      case 'nationality':
        return normalize(player.nationalTeam || '') === normalize(r.value);

      /* Liga */
      case 'league':
        return (player.teams || []).some(t => (r.teams || []).some(lt => normalize(lt) === normalize(t)));

      /* Trofeo exacto */
      case 'trophy':
        return (player.trophies || []).includes(r.value);

      /* Trofeo: cualquiera del array */
      case 'trophy_any':
        return (r.value || []).some(tv => (player.trophies || []).includes(tv));

      /* Entrenador */
      case 'coach':
        return (player.coaches || []).some(c => normalize(c) === normalize(r.value));

      /* Compañero */
      case 'teammate': {
        const targetNorm = normalize(r.value);
        // Directo: el jugador tiene al famoso en su lista de compañeros
        if ((player.teammates || []).some(t => normalize(t) === targetNorm)) return true;
        // Inverso por ID: el famoso tiene el ID del jugador en su lista (más fiable)
        if (_REVERSE_TEAMMATE_IDS[targetNorm]?.has(player.id)) return true;
        // Inverso por nombre: fallback
        const playerNorm = normalize(player.name);
        return !!(_REVERSE_TEAMMATE[targetNorm]?.has(playerNorm));
      }

      /* Continente */
      case 'continent': {
        const nat = (player.nationalTeam || '').trim().replace(/[,;]+$/, '');
        return (CONTINENT_NAT[r.value] || []).includes(nat);
      }

      /* Altura */
      case 'height_le':
        return typeof player.heightCm === 'number' && player.heightCm <= r.value;
      case 'height_ge':
        return typeof player.heightCm === 'number' && player.heightCm >= r.value;
      case 'height_lt':
        return typeof player.heightCm === 'number' && player.heightCm < r.value;
      case 'height_gt':
        return typeof player.heightCm === 'number' && player.heightCm > r.value;

      /* Posición portero */
      case 'position_gk':
        return player.position === 'GK' || (player.position || '').toUpperCase().includes('GK');
      case 'position_def':
        return player.position === 'DEF' || (player.position || '').toUpperCase().includes('DEF');

      /* Décadas */
      case 'birthDecade': {
        const y = player.birthYear;
        if (typeof y !== 'number') return false;
        if (r.value === '1980s') return y >= 1980 && y <= 1989;
        if (r.value === '1990s') return y >= 1990 && y <= 1999;
        if (r.value === '2000s') return y >= 2000 && y <= 2009;
        return false;
      }

      /* Internacionalidades */
      case 'caps_ge':
        return (player.caps || 0) >= r.value;
      case 'caps_le':
        return (player.caps || 0) <= r.value;
      case 'caps_0':
        return (player.caps || 0) === 0;

      /* Número de clubes */
      case 'clubs_ge':
        return (player.teams || []).length >= r.value;
      case 'clubs_le':
        return (player.teams || []).length <= r.value;

      /* Valor traspaso */
      case 'fee_gt':
        return (player.maxFee || 0) > r.value;
      case 'fee_lt':
        return (player.maxFee || 0) < r.value;

      /* Región jugada */
      case 'region': {
        const patterns = REGION_PATTERNS[r.value] || [];
        return (player.teams || []).some(t =>
          patterns.some(p => normalize(t).includes(p))
        );
      }

      /* Legacy */
      case 'team':
        return (player.teams || player.clubs || []).some(c => normalize(c) === normalize(r.value));
      case 'nationalTeam':
        return normalize(player.nationalTeam || '') === normalize(r.value);
      case 'foot':
        return player.foot === 'both' || player.foot === r.value;
      case 'goals_gt':
        return typeof player.goals === 'number' && player.goals > r.value;
      case 'goals_lt':
        return typeof player.goals === 'number' && player.goals < r.value;
      case 'apps_gt':
        return typeof player.apps === 'number' && player.apps > r.value;
      case 'apps_lt':
        return typeof player.apps === 'number' && player.apps < r.value;

      default: return false;
    }
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
  function _onDisconnectRemove(path) {
    try {
      if (window._FBOnDisconnect) {
        const {db,ref}=FB();
        window._FBOnDisconnect(ref(db,path)).remove().catch(()=>{});
      }
    } catch(e) { console.warn('[Sync] onDisconnect no disponible:', e); }
  }
  function _onDisconnectSetConnectedFalse(path) {
    try {
      if (window._FBOnDisconnect) {
        const {db,ref}=FB();
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

  async function joinRoom(code, playerName, avatar) {
    const {get,update}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');
    const room = snap.val();
    if (room.status !== 'waiting') throw new Error('La partida ya ha comenzado');
    const count = Object.keys(room.players||{}).length;
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
     segundo nodo con el mismo nombre. Devuelve true si reconectó. */
  async function tryReconnect(code, playerId, name, avatar) {
    const {get,update}=FB();
    try {
      const roomSnap = await get(_ref(`${ROOMS_PATH}/${code}`));
      if (!roomSnap.exists()) return false;
      if (roomSnap.val().status !== 'waiting') return false;
      const playerSnap = await get(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`));
      if (!playerSnap.exists()) return false;
      await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
        connected:true, name, avatar:avatar||null,
      });
      /* Rearmar: la reconexión es un navegador nuevo, el hook anterior murió */
      _onDisconnectRemove(`${ROOMS_PATH}/${code}/players/${playerId}`);
      return true;
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

  return {
    createRoom, joinRoom, findOrCreatePublicRoom, listenRoom,
    startGame, nextRound, submitAnswer, startReveal, setFinished,
    resetToLobby, claimReset, rejoinRoom, expirePublicRoom, disconnect, getRoom, updateRoomSettings,
    tryReconnect, rearmOnDisconnect, resume,
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
  let _isLocal    = false;
  let _localName  = '';
  let _localRound = 0;

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

  let _localPointsToWin = 7;
  let _localRoundSecs   = 60;

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
        worker = new Worker('js/restrictions-worker.js');
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
    const NAME_INPUTS = ['input-host-name','input-join-name','input-public-name','input-local-name'];
    FHAuth.onIdentity(id => {
      _syncMyIdentityToRoom();
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

  /* ════════════════════════════════════════
     MODO LOCAL — igual que Blackjack
     ════════════════════════════════════════ */
  async function startLocalGame() {
    const name = _accountName('input-local-name');
    if (!name) { _showError('error-local', 'Escribe tu nombre'); return; }
    _clearError('error-local');

    const btn = document.querySelector('#panel-local .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'CARGANDO…'; }

    try {
      /* Verificar que los datos base cargan (error rápido y visible si hay problema) */
      await _loadGameData();

      _isLocal=true; _isHost=true; _playerId='local-p1';
      _localName=name; _localRound=0;
      _players=[{id:'local-p1', name, avatar:_accountAvatar(), score:0}];

      if (btn) { btn.disabled = false; btn.textContent = 'JUGAR SOLO ▶'; }

      /* Transicionar a screen-round primero (igual que Cadena), para que el countdown
         aparezca sobre la pantalla de juego y no sobre el menú */
      _showScreen('screen-round');
      _renderTopbar(1, _players);
      _renderSubmissions(_players, {});

      /* Mostrar cuenta atrás mínima mientras terminan de precargar todos los chunks
         y se generan las restricciones de la primera ronda en el worker */
      const firstSeed = Date.now() + 1 * 7919;
      _showPreloadCountdown(firstSeed, () => _startLocalRound());

    } catch(e) {
      console.error('[App] startLocalGame error:', e);
      let msg = e.message || 'Error desconocido al cargar datos';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
        msg = '❌ No se pueden leer los JSON. ¿Estás en file://? Usa: npx serve . o python -m http.server 8080';
      } else if (msg.includes('404') || msg.includes('not found') || msg.includes('No se encontró')) {
        msg = '❌ Archivos no encontrados. Comprueba que la carpeta data/ está junto a index.html';
      } else if (msg.includes('vacíos')) {
        msg = '❌ JSON vacíos. Comprueba el archivo compañeros_principal.json';
      }
      _showError('error-local', msg);
      showToast('❌ Error al cargar datos', 'error');
      _isLocal=false; _isHost=false; _playerId=null;
      if (btn) { btn.disabled = false; btn.textContent = 'JUGAR SOLO ▶'; }
    }
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
    _showScreen('screen-menu');
    _preloadDataInBackground();
    _setupAccountName();

    /* Nombres de los jugadores automáticos: se piden ya para que la
       primera sala pública no tenga que esperar a la red. */
    if (typeof BotNames !== 'undefined') BotNames.load();

    const urlParams = new URLSearchParams(window.location.search);
    const salaCode  = urlParams.get('sala');
    if (salaCode) {
      const input = document.getElementById('input-join-code');
      if (input) input.value = salaCode.toUpperCase();
      setTab('private');
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
    ['error-private','error-public','error-local'].forEach(id=>_clearError(id));
    const btnPublic = document.getElementById('btn-find-public');
    if (btnPublic) { btnPublic.disabled=false; btnPublic.textContent='BUSCAR PARTIDA ▶'; }
    const btnPrivPrimary = document.querySelector('#panel-private .btn-primary');
    if (btnPrivPrimary) { btnPrivPrimary.disabled=false; btnPrivPrimary.textContent='CREAR SALA ▶'; }
    const btnPrivSecondary = document.querySelector('#panel-private .btn-secondary');
    if (btnPrivSecondary) { btnPrivSecondary.disabled=false; btnPrivSecondary.textContent='UNIRSE A SALA ▶'; }
  }

  /* ════════════════════════════════════════
     CREAR SALA PRIVADA
     ════════════════════════════════════════ */
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
        const ok = await Sync.tryReconnect(session.code, session.playerId, name, _accountAvatar());
        if (ok) {
          _newSession();
          _roomCode=session.code; _playerId=session.playerId; _isHost=session.isHost===true;
          _isPublic=true; _isLocal=false; _localName=name;
          _saveSession(); _listenRoom(); _showLobby();
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
      const restrictions = await _generateAsync(seed, PLAYERS_DB);
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

  function adjustLocalPoints(delta) {
    _localPointsToWin = Math.max(5, Math.min(15, _localPointsToWin + delta));
    const el = document.getElementById('local-points-display');
    if (el) el.textContent = _localPointsToWin;
  }

  function adjustLocalSecs(delta) {
    _localRoundSecs = Math.max(30, Math.min(120, _localRoundSecs + delta));
    const el = document.getElementById('local-secs-display');
    if (el) el.textContent = _localRoundSecs;
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

  function _startLocalRound() {
    _localRound++;
    _round = _localRound;
    _submitted=false; _mySubmission=null; _mySubmissionId=null; _revealTriggered=false;
    _showScreen('screen-round');
    _renderTopbar(_localRound, _players);
    _renderSubmissions(_players, {});
    const secs = _isSuddenDeath ? SUDDEN_DEATH_SECS : (_localRoundSecs || ROUND_SECS);
    /* Resetear display del timer inmediatamente para no mostrar el valor de la ronda anterior */
    const _timerEl = document.getElementById('round-timer');
    const _barEl   = document.getElementById('round-timer-bar');
    if (_timerEl) { _timerEl.textContent = secs; _timerEl.classList.remove('urgent'); }
    if (_barEl)   { _barEl.style.width = '100%';  _barEl.classList.remove('urgent'); }
    /* Banner muerte súbita local */
    let sdBanner = document.getElementById('sudden-death-banner');
    if (_isSuddenDeath) {
      if (!sdBanner) {
        sdBanner = document.createElement('div');
        sdBanner.id = 'sudden-death-banner';
        sdBanner.style.cssText = "background:#c0392b;color:#fff;text-align:center;padding:8px 0;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:3px;";
        sdBanner.textContent = '💀 MUERTE SÚBITA — RONDA EXPRESS 20s';
        const rg = document.getElementById('restrictions-grid');
        if (rg) rg.parentNode.insertBefore(sdBanner, rg);
      }
    } else if (sdBanner) { sdBanner.remove(); }
    /* Input deshabilitado hasta que salgan las restricciones */
    const pi=document.getElementById('player-input');
    if (pi) { pi.value=''; pi.disabled=true; _acClose(); }
    const sb=document.getElementById('submit-btn');
    if (sb) sb.disabled=true;

    /* Usar cache pregenerada si está disponible; si no, generar ahora.
       En ambos casos el cálculo pesado queda fuera del hilo de pintura. */
    const _doAnimate = (restrictions) => {
      _restrictions = restrictions;
      _nextRestrictionsCache = null;
      _animateRestrictions(_restrictions, () => {
        if (pi) pi.disabled = false;
        if (sb) sb.disabled = false;
        _startTimer(Date.now(), secs);
      });
    };

    if (_nextRestrictionsCache) {
      _doAnimate(_nextRestrictionsCache);
    } else {
      /* Sin cache: generar en worker para no bloquear el hilo principal */
      const seed = Date.now() + _localRound * 7919;
      _generateAsync(seed, PLAYERS_DB)
        .then(restrictions => _doAnimate(restrictions))
        .catch(() => {
          /* Último recurso: sincrónico si el worker falla */
          _doAnimate(Restrictions.generate(seed, PLAYERS_DB));
        });
    }
  }

  /* Pregeneración silenciosa de la siguiente ronda.
     Se llama desde la pantalla de resultados, cuando el usuario
     está leyendo y el hilo principal tiene tiempo libre. */
  function _preGenerateNextRestrictions() {
    if (!PLAYERS_DB.length) return;
    const nextRoundNum = _isLocal ? (_localRound + 1) : (_round + 1);
    const seed = Date.now() + nextRoundNum * 7919;
    _generateAsync(seed, PLAYERS_DB)
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
    history.replaceState({}, '', window.location.pathname);
  }

  /* ════════════════════════════════════════
     LISTENER FIREBASE
     ════════════════════════════════════════ */
  function _listenRoom() {
    if (_unsubRoom) _unsubRoom();
    _unsubRoom = Sync.listenRoom(_roomCode, _onRoomUpdate);
  }

  let _lastArmedStatus = null;   // último status para el que se rearmó onDisconnect

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
      _handleKicked('Has sido expulsado de la sala'); return;
    }
    if (room.players) {
      _players = Object.entries(room.players).map(([id,p])=>({
        id, name:p.name, score:p.score||0, connected:p.connected??true, isHost:p.isHost??false
      }));
      /* Mantener _isHost sincronizado SIEMPRE (no solo en el lobby).
         Permite el failover de host si el host original se desconecta
         a mitad de partida: el juego sigue avanzando. */
      if (!_isLocal && _playerId && room.players[_playerId]) {
        const wasHost = _isHost;
        _isHost = room.players[_playerId].isHost === true;
        if (_isHost && !wasHost && (room.status==='playing' || room.status==='reveal')) {
          /* Nos acaban de promover a host en plena partida: si ya estaban
             todas las respuestas y nadie disparó el reveal, dispararlo ahora. */
          if (room.status==='playing' && !_revealTriggered) {
            const connected = _players.filter(p=>p.connected!==false);
            const expected = _isSuddenDeath
              ? connected.filter(p => _suddenDeathPlayers.includes(p.id)).length
              : connected.length;
            if (expected>0 && (room.doneCount||0)>=expected) _triggerReveal(room);
            /* Heredamos también los bots: sus respuestas las tenía programadas
               el host anterior, así que hay que reprogramarlas o la ronda se
               quedaría esperándolos. Se les pasa el reloj real de la ronda
               (inicio + duración): ellos mismos reparten lo que quede. */
            else if (_isPublic && typeof CocheBots !== 'undefined' && _timerStartAt) {
              const left = _timerTotalSecs - Math.floor((Date.now()-_timerStartAt)/1000);
              if (left > 3) CocheBots.onRound({
                code: _roomCode, room, restrictions: _restrictions,
                roundSecs: _timerTotalSecs, startAt: _timerStartAt,
                isSuddenDeath: _isSuddenDeath,
                suddenDeathPlayers: _suddenDeathPlayers,
              });
            }
          }
          /* Si nos promovieron mientras ya veíamos la pantalla de resultados,
             el botón "SIGUIENTE RONDA" estaba oculto (era de otro host).
             Mostrarlo ahora para que el juego pueda avanzar (evita deadlock). */
          if (room.status==='reveal' && _currentScreen()==='screen-results') {
            const nxt=document.getElementById('btn-next-round');
            if (nxt) { nxt.classList.remove('hidden'); nxt.disabled=false; }
            _preGenerateNextRestrictions();
          }
        }
      }
    }
    /* ── Failover de host en el LOBBY ──
       Si el host desapareció (su onDisconnect borró el nodo) o quedó
       desconectado, la sala se quedaba sin nadie que metiera bots, empezara
       la partida o la expirara. El primer humano conectado (orden
       determinista por id) se autopromociona. Los bots nunca heredan. */
    if (!_isLocal && _playerId && room.status==='waiting' && room.players?.[_playerId]) {
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
          } catch(e) {}
        }
      }
    }

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
    if (_roomCode && !_isPublic) {
      const targetUrl = window.location.pathname + '?sala=' + _roomCode;
      if (!window.location.search.includes(_roomCode)) history.replaceState(null, '', targetUrl);
    }
    const codeCard = document.getElementById('lobby-code-card');
    if (codeCard) codeCard.style.display = _isPublic ? 'none' : '';
    const badge = document.getElementById('lobby-mode-badge');
    if (badge) { badge.style.display = _isPublic ? 'block' : 'none'; badge.textContent = _isPublic ? '🌐 Sala Pública' : ''; }

    const listEl = document.getElementById('lobby-players-list');
    if (listEl && room.players) {
      listEl.innerHTML = Object.entries(room.players)
        .filter(([,p])=>p.connected!==false)
        .map(([pid,p])=>`
          <div class="lobby-player-row">
            <div class="lobby-player-avatar">${_avatarInner(p)}</div>
            <span class="lobby-player-name">${_escHtml(p.name)}</span>
            ${p.isHost ? '<span class="lobby-player-host">HOST</span>' : ''}
            ${pid===_playerId ? '<span style="margin-left:auto;font-size:.7rem;opacity:.4;letter-spacing:1px;">← TÚ</span>' : ''}
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

    if (_isHost && startBtn) {
      startBtn.style.display='block';
      startBtn.disabled = count < 2 || cooldownActive;
      startBtn.textContent = cooldownActive
        ? `ESPERA ${MIN_LOBBY_WAIT - lobbyAge}s…`
        : 'EMPEZAR ▶';
    }
    else if (startBtn) { startBtn.style.display='none'; }
    if (hintEl) {
      if (cooldownActive) hintEl.textContent = 'Esperando a que se unan todos…';
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

    /* Panel de ajustes online — solo visible en sala privada */
    const settingsEl = document.getElementById('lobby-settings');
    if (settingsEl && !_isPublic) {
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
      const startedAt = Date.now();
      _startTimer(startedAt, secs);

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
          startAt: startedAt,
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
        ? `<img class="restriction-img" src="${r.imgUrl}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'"
               alt="">
           <span class="restriction-icon-fallback" style="display:none">${r.icon||'❓'}</span>`
        : `<span class="restriction-icon-fallback">${r.icon||'❓'}</span>`;

      return `<div class="restriction-card">
        <div class="restriction-icon">${iconHtml}</div>
        <div class="restriction-label">${r.label}</div>
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
        if (_isHost && !_revealTriggered && !_isLocal) _triggerReveal(_lastRoom);
        else if (_isLocal) _localReveal();
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
  });
  window.addEventListener('online', _handleResume);

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

    if (_isLocal) { _stopTimer(); _localReveal(); return; }

    try {
      const doneCount = await Sync.submitAnswer(_roomCode, _playerId, player.name, player.id||null);
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
     REVEAL LOCAL
     ════════════════════════════════════════ */
  async function _localReveal() {
    _stopTimer();
    const subs    = _mySubmission ? {[_playerId]:{playerName:_mySubmission, footballerId:_mySubmissionId}} : {};
    const results = await _computeResults(subs, _restrictions, _players);
    _players      = _applyPoints(_players, results);
    const ptw     = _localPointsToWin || POINTS_WIN;

    if (_isSuddenDeath) {
      /* En muerte súbita: ¿alguien ganó esta ronda? */
      const roundWinner = _players
        .filter(p => _suddenDeathPlayers.includes(p.id))
        .find(p => results[p.id]?.isWinner);
      if (roundWinner) {
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        /* Mostrar resultados primero, luego ganador tras 10s */
        _renderResultsUI(_localRound, _restrictions, results, _players);
        _showScreen('screen-results');
        const nxt=document.getElementById('btn-next-round');
        if (nxt) nxt.classList.add('hidden');
        _showFinishedCountdown(null, 10, () => _showLocalFinished(roundWinner, true));
        return;
      }
      /* Bug 3: Narrowing — eliminar a los que sacaron menos puntos */
      const sdScores = _suddenDeathPlayers.map(id => ({id, pts: results[id]?.points||0}));
      const maxPts = Math.max(...sdScores.map(r=>r.pts));
      const stillTied = sdScores.filter(r=>r.pts===maxPts).map(r=>r.id);
      if (stillTied.length < _suddenDeathPlayers.length && stillTied.length >= 2) {
        _suddenDeathPlayers = stillTied;
      }
      /* Si solo queda 1, ese gana */
      if (stillTied.length === 1) {
        const winner = _players.find(p=>p.id===stillTied[0]);
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        _renderResultsUI(_localRound, _restrictions, results, _players);
        _showScreen('screen-results');
        const nxt=document.getElementById('btn-next-round');
        if (nxt) nxt.classList.add('hidden');
        _showFinishedCountdown(null, 10, () => _showLocalFinished(winner, true));
        return;
      }
    } else {
      const reached = _players.filter(p=>p.score>=ptw);
      if (reached.length >= 2) {
        /* Empate → muerte súbita */
        _isSuddenDeath = true;
        _suddenDeathPlayers = reached.map(p=>p.id);
        _renderResultsUI(_localRound, _restrictions, results, _players);
        _showScreen('screen-results');
        const nxt=document.getElementById('btn-next-round');
        if (nxt) nxt.classList.remove('hidden');
        showToast('💀 ¡MUERTE SÚBITA! Rondas express de 20 segundos', 'error');
        return;
      } else if (reached.length === 1) {
        /* Mostrar resultados primero, luego ganador tras 10s */
        _renderResultsUI(_localRound, _restrictions, results, _players);
        _showScreen('screen-results');
        const nxt=document.getElementById('btn-next-round');
        if (nxt) nxt.classList.add('hidden');
        _showFinishedCountdown(null, 10, () => _showLocalFinished(reached[0], true));
        return;
      }
    }

    _renderResultsUI(_localRound, _restrictions, results, _players);
    _showScreen('screen-results');
    const nxt=document.getElementById('btn-next-round');
    if (nxt) nxt.classList.remove('hidden');
    /* Aprovechar que el usuario está leyendo resultados para precalcular
       las restricciones de la siguiente ronda en background */
    _preGenerateNextRestrictions();
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
    if (_isLocal) {
      const ptw = _localPointsToWin || POINTS_WIN;
      /* Muerte súbita local */
      if (!_isSuddenDeath) {
        const reached = _players.filter(p=>p.score>=ptw);
        if (reached.length >= 2) {
          /* Empate → muerte súbita */
          _isSuddenDeath = true;
          _suddenDeathPlayers = reached.map(p=>p.id);
          showToast('💀 ¡MUERTE SÚBITA! Rondas express de 20 segundos', 'error');
          _startLocalRound(); return;
        } else if (reached.length === 1) {
          _showLocalFinished(reached[0]); return;
        }
      } else {
        /* Ya en muerte súbita: ¿hay ganador? */
        /* El ganador se detecta en _localReveal → aquí solo continuamos */
      }
      _startLocalRound(); return;
    }
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
    const _reenableBtn = () => {
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

    const seed = Date.now()+(_round*3137);
    /* Usar cache pregenerada si está disponible (salvo al entrar en muerte súbita) */
    const cached = forceFreshRestrictions ? null : _nextRestrictionsCache;
    _nextRestrictionsCache = null;
    const restrictionsPromise = cached
      ? Promise.resolve(cached)
      : _generateAsync(seed, PLAYERS_DB);

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
      cdEl.style.cssText = "text-align:center;font-family:'Bebas Neue',sans-serif;" +
        "font-size:1rem;letter-spacing:3px;color:#c8a84b;padding:8px 0;opacity:.8;";
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

  function _showLocalFinished(winner, _skipCountdown=false) {
    _stopTimer();
    const doFinish = () => {
      document.getElementById('winner-name').textContent = winner.name;
      const scoresEl=document.getElementById('final-scores');
      if (scoresEl) {
        scoresEl.innerHTML=[..._players].sort((a,b)=>b.score-a.score).map(p=>{
          const isW = p.id===winner.id;
          return '<div class="final-score-item ' + (isW?'winner-item':'') + '">' +
            '<span class="final-score-name">' + _escHtml(p.name) + ' ' + (isW?'🏆':'') + '</span>' +
            '<span class="final-score-pts">' + p.score + ' pts</span>' +
            '</div>';
        }).join('');
      }
      _showScreen('screen-finished');
    };
    if (!_skipCountdown && _currentScreen() === 'screen-results') {
      _showFinishedCountdown(null, 10, doFinish);
    } else {
      doFinish();
    }
  }

  /* ════════════════════════════════════════
     JUGAR DE NUEVO / MENÚ
     ════════════════════════════════════════ */
  async function playAgain() {
    _wantReplay = true;
    if (_isLocal) {
      _players=[{..._players[0],score:0}]; _localRound=0;
      _isSuddenDeath=false; _suddenDeathPlayers=[];
      _nextRestrictionsCache=null;
      /* Limpiar banners y elementos residuales de la partida anterior */
      _cleanupRoundDOM();
      _acClose(); _startLocalRound(); return;
    }
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
    history.replaceState({}, '', window.location.pathname);
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
    history.replaceState({}, '', window.location.pathname);
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
          ? `<img class="result-footballer-photo" src="${r.footballerImg}" alt="" loading="lazy"
                 onerror="this.style.display='none'">`
          : '';

        const metBadges = (r.valid && restrictions)
          ? restrictions.map((rs,i) => {
              if (!r.matches?.[i]) return '';
              const iconHtml = rs.imgUrl
                ? `<img class="rr-badge-img" src="${rs.imgUrl}"
                       onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" alt="">
                   <span style="display:none">${rs.icon||'❓'}</span>`
                : `<span class="rr-badge-icon">${rs.icon||'❓'}</span>`;
              return `<div class="rr-badge met" title="${rs.label}">
                <span class="rr-badge-icon-wrap">${iconHtml}</span>
                <span>${rs.label}</span>
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
      legendEl.innerHTML=`
        <div style="padding:0 14px 12px;">
          <p style="font-size:.7rem;letter-spacing:2px;color:#4ade80;opacity:.7;text-transform:uppercase;margin-bottom:8px;">Las 5 Restricciones</p>
          ${restrictions.map(r=>`
            <div style="display:flex;align-items:center;gap:8px;font-size:.8rem;color:#e8e8e8;opacity:.55;font-weight:600;margin-bottom:4px;">
              ${r.imgUrl
                ? `<img src="${r.imgUrl}" style="width:18px;height:18px;object-fit:contain;"
                      onerror="this.outerHTML='<span>${r.icon||'❓'}</span>'" alt="">`
                : `<span>${r.icon||'❓'}</span>`}
              <span>${r.label}</span>
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
    if (!q) return name;
    const n = _acNorm(name);
    const idx = n.indexOf(q);
    if (idx === -1) return name;
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
    if (startRaw === -1) return name;
    return name.slice(0, startRaw)
      + '<span class="autocomplete-highlight">' + name.slice(startRaw, endRaw) + '</span>'
      + name.slice(endRaw);
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
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
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
    _isLocal=false; _localName=''; _localRound=0;
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
    try { sessionStorage.setItem('coche_session', JSON.stringify({code:_roomCode,playerId:_playerId,isHost:_isHost,isPublic:_isPublic})); } catch(e){}
  }
  function _loadSession() {
    try { const s = sessionStorage.getItem('coche_session'); return s ? JSON.parse(s) : null; } catch(e){ return null; }
  }
  function _clearSession() {
    try { sessionStorage.removeItem('coche_session'); } catch(e){}
  }

  return {
    init, setTab,
    createRoom, joinRoom, findPublicRoom, startLocalGame,
    adjustLocalPoints, adjustLocalSecs,
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
  const _preloadImg = (src) => { const img = new Image(); img.src = src; };
  /* Entrenadores (12 fotos) */
  ['67','118','280','523','781','1522','2868','3517','5075','5672','6499','21284']
    .forEach(id => _preloadImg(sbStorageUrl('coach-photos', `${id}.png`)));
});
