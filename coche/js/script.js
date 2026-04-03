/* =============================================
   SCRIPT.JS — COCHE (Restricciones de Fútbol)
   QUIÉN COÑO FALTA  —  v10
   ============================================= */
'use strict';

/* ── Normalización de texto compartida entre _loadData y App ── */
function _acNorm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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

let _acItems         = [];
let _acIndex         = -1;
let _acSelected      = null;
let _acDebounce      = null;
let _teamLeaguePrio  = null;
let _chunkCache      = {};
let _playerDataCache = {};

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
async function _getChunkData(id) {
  const sid = String(id);
  if (_playerDataCache[sid]) return _playerDataCache[sid];
  const cf = _chunkFileForId(id);
  if (!cf) return null;
  /* Si no hay cache, o hay cache parcial y el ID no está: fetch completo */
  if (!_chunkCache[cf] || (!_chunkCache[cf][sid] && !_chunkCache[cf].__full)) {
    try {
      const r = await fetch(cf);
      if (!r.ok) return null;
      const full = await r.json();
      full.__full = true;
      _chunkCache[cf] = full;
    } catch { return null; }
  }
  _playerDataCache[sid] = _chunkCache[cf]?.[sid] || null;
  return _playerDataCache[sid];
}

/* ── Normalización de pie de jugador (global, usada en varios sitios) ── */
function _normFoot(f) {
  if (!f) return null;
  const fl = f.toLowerCase();
  if (fl.includes('zurdo'))   return 'left';
  if (fl.includes('diestro')) return 'right';
  if (fl.includes('ambi'))    return 'both';
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
  const norm = s => String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ').trim();
  const n = norm(inputName);
  if (!n) return null;

  /* 1. Buscar en PLAYERS_DB */
  const inDB = PLAYERS_DB.find(p =>
    norm(p.name) === n || (p.aliases||[]).some(a => norm(a) === n)
  );

  const playerId = inDB ? inDB.id : null;
  let chunkId    = playerId;

  /* Si no está en PLAYERS_DB, buscar ID en NAME_INDEX */
  if (!chunkId) {
    const entry = NAME_INDEX.find(([, name]) => norm(name) === n);
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
  const BASE        = 'data/';
  const CHUNKS_BASE = '../data/players/chunks/';

  const [
    companeros, entrenados, clubInt, seleccion, ligaCopa, premios, nameIdx, leagueData,
  ] = await Promise.all([
    fetch(BASE + 'compa%C3%B1eros_principal.json').then(r => r.json()),
    fetch(BASE + 'entrenados_por.json').then(r => r.json()),
    fetch(BASE + 'ganadores_clubes_internacional.json').then(r => r.json()),
    fetch(BASE + 'ganadores_seleccion.json').then(r => r.json()),
    fetch(BASE + 'GanadoresLigayCopa.json').then(r => r.json()),
    fetch(BASE + 'premios_individuales.json').then(r => r.json()),
    fetch('../data/players/name-index.json').then(r => r.json()).catch(() => []),
    fetch('../data/teams/league-teams.json').then(r => r.json()).catch(() => null),
  ]);

  NAME_INDEX = Array.isArray(nameIdx) ? nameIdx : [];

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

  const neededIds = new Set([
    ...Object.keys(companeros),
    ...Object.values({ ...clubInt, ...seleccion, ...ligaCopa, ...premios })
      .flat().map(id => String(id)),
    ...Object.values(entrenados).flatMap(e => (e.players || []).map(String)),
  ]);

  const chunkGroups = {};
  for (const id of neededIds) {
    const cf = _chunkFileForId(id);
    if (cf) {
      if (!chunkGroups[cf]) chunkGroups[cf] = [];
      chunkGroups[cf].push(id);
    }
  }

  const chunkData = {};
  await Promise.all(Object.entries(chunkGroups).map(async ([cf, ids]) => {
    try {
      const r = await fetch(cf);
      if (!r.ok) return;
      const fullChunk = await r.json();
      const partial = { __full: false };
      for (const id of ids) { if (fullChunk[id]) partial[id] = fullChunk[id]; }
      _chunkCache[cf] = partial;
      for (const id of ids) { if (fullChunk[id]) chunkData[id] = fullChunk[id]; }
    } catch { }
  }));

  /* nameMap: id → nombre. Primero desde name-index (cubre TODOS los jugadores),
     luego sobreescribir con companeros_principal (fuente de verdad para los famosos).
     Esto garantiza que IDs de compañeros que no son clave del JSON (p.ej. Inigo Martinez
     en el array de Sergio Ramos) se resuelven correctamente a su nombre. */
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

  /* Máxima transferencia en €  */
  function _maxFee(transfers) {
    if (!transfers || !transfers.length) return 0;
    return Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0));
  }

  /* PLAYERS_DB incluye los datos del chunk para que generate() pueda validar
     restricciones correctamente. findPlayerAsync siempre refresca desde chunk
     al validar respuestas del usuario (garantizando img y datos actualizados). */
  return Object.entries(companeros).map(([id, pd]) => {
    const chunk = chunkData[id] || {};
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
      maxFee:       _maxFee(chunk.tr),
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
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  /* ────────── LOGOS ────────── */
  function _logoUrl(tmName) {
    return 'data/logos/' + tmName.replace(/ /g, '_') + '.png';
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
    { tmName:'CA Boca Juniors',      display:'Boca Juniors',   league:'Argentina' },
    { tmName:'CA River Plate',       display:'River Plate',    league:'Argentina' },
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

  /* Logo de liga */
  const LEAGUE_LOGOS = {
    'La Liga':        'data/logos/leagues/LaLiga.png',
    'Premier League': 'data/logos/leagues/PremierLeague.png',
    'Serie A':        'data/logos/leagues/SerieA.png',
    'Bundesliga':     'data/logos/leagues/Bundesliga.png',
    'Ligue 1':        'data/logos/leagues/Ligue1.png',
  };

  /* ────────── NACIONALIDADES ────────── */
  /* tmNat = valor en chunk.nat (inglés)   */
  const NATIONALITIES = [
    { tmNat:'Spain',       display:'España',    flag:'🇪🇸', flagImg:'data/flags/es.png' },
    { tmNat:'England',     display:'Inglaterra', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', flagImg:'data/flags/eng.png' },
    { tmNat:'France',      display:'Francia',   flag:'🇫🇷', flagImg:'data/flags/fr.png' },
    { tmNat:'Argentina',   display:'Argentina', flag:'🇦🇷', flagImg:'data/flags/ar.png' },
    { tmNat:'Germany',     display:'Alemania',  flag:'🇩🇪', flagImg:'data/flags/de.png' },
    { tmNat:'Brazil',      display:'Brasil',    flag:'🇧🇷', flagImg:'data/flags/br.png' },
    { tmNat:'Netherlands', display:'Holanda',   flag:'🇳🇱', flagImg:'data/flags/nl.png' },
  ];

  /* ────────── CONTINENTES ────────── */
  const CONTINENT_NAT = {
    europeo:    ['Spain','England','France','Germany','Netherlands','Portugal','Italy',
                 'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
                 'Czech Republic','Switzerland','Austria','Turkey','Greece','Hungary',
                 'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
                 'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
                 'Ireland','Georgia','Kosovo','North Macedonia','Bulgaria','Cyprus','Latvia',
                 'Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar'],
    americano:  ['Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
                 'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
                 'Trinidad and Tobago','Honduras','Costa Rica','Panama','Guatemala',
                 'El Salvador','Cuba','Dominican Republic','Canada','Haiti'],
    africano:   ['Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cameroon',
                 'Morocco','Egypt','Algeria','Tunisia','South Africa','Mali','Guinea',
                 'Burkina Faso','DR Congo','Congo','Republic of the Congo','Togo','Gabon',
                 'Equatorial Guinea','Zimbabwe','Kenya','Cape Verde','Sierra Leone',
                 'Liberia','Gambia','Guinea-Bissau','Rwanda','Ethiopia','Tanzania',
                 'Zambia','Uganda','Angola','Mauritius','Mozambique','Madagascar',
                 'Benin','Niger','Chad','Sudan','South Sudan','Somalia','Eritrea',
                 'Djibouti','Comoros','Lesotho','Botswana','Namibia','Malawi',
                 'Eswatini','Libya','Mauritania','Central African Republic'],
    asiatico:   ['Japan','South Korea','Iran','Saudi Arabia','Qatar','UAE','Australia',
                 'China','Iraq','Jordan','Bahrain','Kuwait','Uzbekistan','Vietnam',
                 'Thailand','Indonesia','Philippines','India','Pakistan','Bangladesh',
                 'North Korea','Malaysia','Oman','Lebanon','Palestine','Syria'],
  };

  /* ────────── REGIONES ────────── */
  const REGION_PATTERNS = {
    sudamerica:   ['boca','river','flamengo','santos','corinthians','sao paulo','gremio',
                   'palmeiras','atletico mineiro','vasco','fluminense','cruzeiro','sport',
                   'internacional','nacional','penarol','estudiantes','independiente',
                   'racing','san lorenzo','newells','rosario','tigre','colo-colo',
                   'u de chile','universidad','alianza','universitario','barcelona guay',
                   'liga de quito','dep quito','deportivo cali','junior','medellin'],
    usa_mexico:   ['galaxy','red bulls','new york city','fc dallas','toronto','seattle',
                   'portland','atlanta united','inter miami','chicago fire','columbus',
                   'new england','real salt lake','colorado','houston','dc united',
                   'chivas','america','cruz azul','pumas','toluca','monterrey','tigres',
                   'leon','guadalajara','pachuca','necaxa','veracruz','atlas','santos lag'],
    oriente_medio:['al-nassr','al-hilal','al-ittihad','al-ahli','al-qadsia',
                   'al-sadd','al-rayyan','al-duhail','al-ain','al-wahda',
                   'al-shabab','al-raed','al-taawoun','al-faisaly','al-fateh',
                   'al-jazira','al-wasl','al-najma','al-kharaitiyat',
                   'al-wehda','al-ettifaq','al ain sc','al ain fc',
                   'riyadh','jeddah','sharjah','dubai','abu dhabi','kuwait',
                   'esteghlal','persepolis','tractors','sepahan',
                   'umm salal','pakhtakor','lokomotiv tashkent'],
  };

  /* ────────── TROFEOS DEFINIDOS ────────── */
  /* Estos deben coincidir EXACTAMENTE con las claves de los JSON         */
  const TROPHIES = {
    individual: [
      { key:'Pichichi La Liga',          display:'Pichichi',            icon:'⚽', imgUrl:'data/trofeos/pichichi.png' },
      { key:'Bota de Oro Premier League',display:'Bota de Oro Premier', icon:'⚽', imgUrl:'data/trofeos/bota_oro_premier.png' },
      { key:'Capocannoniere Serie A',    display:'Capocannoniere',      icon:'⚽', imgUrl:'data/trofeos/capocannoniere.png' },
      { key:'Maximo Goleador Bundesliga',display:'Goleador Bundesliga', icon:'⚽', imgUrl:'data/trofeos/goleador_bundesliga.png' },
      { key:'Maximo Goleador Ligue 1',   display:'Goleador Ligue 1',    icon:'⚽', imgUrl:'data/trofeos/goleador_ligue1.png' },
      { key:'Balon de Oro',              display:'Balón de Oro',        icon:'🏅', imgUrl:'data/trofeos/balon_oro.png' },
      { key:'Bota de Oro Mundial',       display:'Bota de Oro Mundial', icon:'🏅', imgUrl:'data/trofeos/bota_oro_mundial.png' },
      { key:'Bota de Oro Europea',       display:'Bota de Oro Europea', icon:'🏅', imgUrl:'data/trofeos/bota_oro_europea.png' },
    ],
    domestic: [
      { key:'Liga España',    display:'Ganador Liga Española', icon:'🏆', imgUrl:'data/trofeos/liga_espana.png' },
      { key:'Liga Inglaterra',display:'Ganador Premier League',icon:'🏆', imgUrl:'data/trofeos/liga_inglaterra.png' },
      { key:'Liga Italia',    display:'Ganador Serie A',       icon:'🏆', imgUrl:'data/trofeos/liga_italia.png' },
      { key:'Liga Francia',   display:'Ganador Ligue 1',       icon:'🏆', imgUrl:'data/trofeos/liga_francia.png' },
      { key:'Liga Alemania',  display:'Ganador Bundesliga',    icon:'🏆', imgUrl:'data/trofeos/liga_alemania.png' },
      { key:'Copa España',    display:'Copa del Rey',          icon:'🏆', imgUrl:'data/trofeos/copa_espana.png' },
      { key:'Copa Inglaterra',display:'FA Cup',                icon:'🏆', imgUrl:'data/trofeos/copa_inglaterra.png' },
      { key:'Copa Italia',    display:'Coppa Italia',          icon:'🏆', imgUrl:'data/trofeos/copa_italia.png' },
      { key:'Copa Francia',   display:'Coupe de France',       icon:'🏆', imgUrl:'data/trofeos/copa_francia.png' },
      { key:'Copa Alemania',  display:'DFB-Pokal',             icon:'🏆', imgUrl:'data/trofeos/copa_alemania.png' },
    ],
    international_club: [
      { key:'Champions League',    display:'Champions League',    icon:'⭐', imgUrl:'data/trofeos/champions.png' },
      { key:'Europa League',       display:'Europa League',       icon:'⭐', imgUrl:'data/trofeos/europa_league.png' },
      { key:'Copa Libertadores',   display:'Copa Libertadores',   icon:'⭐', imgUrl:'data/trofeos/copa_libertadores.png' },
      { key:'Conference League',   display:'Conference League',   icon:'⭐', imgUrl:'data/trofeos/conference_league.png' },
    ],
    national: [
      { key:'Eurocopa',    display:'Eurocopa',   icon:'🌍', imgUrl:'data/trofeos/eurocopa.png' },
      { key:'Mundial',     display:'Mundial',    icon:'🌍', imgUrl:'data/trofeos/mundial.png' },
      { key:'Copa America',display:'Copa América',icon:'🌍', imgUrl:'data/trofeos/copa_america.png' },
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
    { name:'Messi',            id:'28003',  icon:'⚽' },
    { name:'Cristiano Ronaldo',id:'8198',   icon:'⚽' },
    { name:'Kane',             id:'132098', icon:'⚽' },
    { name:'Casillas',         id:'3979',   icon:'⚽' },
    { name:'Mbappé',           id:'342229', icon:'⚽' },
    { name:'Pepe',             id:'14132',  icon:'⚽' },
    { name:'Neymar',           id:'68290',  icon:'⚽' },
    { name:'Ronaldinho',       id:'3373',   icon:'⚽' },
    { name:'Di María',         id:'44352',  icon:'⚽' },
    { name:'Cavani',           id:'48280',  icon:'⚽' },
    { name:'Xavi',             id:'7607',   icon:'⚽' },
    { name:'Llorente',         id:'7349',   icon:'⚽' },
    { name:'Reina',            id:'7825',   icon:'⚽' },
    { name:'Neuer',            id:'17259',  icon:'⚽' },
    { name:'Müller',           id:'38253',  icon:'⚽' },
    { name:'Reus',             id:'35624',  icon:'⚽' },
    { name:'Pirlo',            id:'5817',   icon:'⚽' },
    { name:'Lautaro Martínez', id:'406625', icon:'⚽' },
    { name:'Sneijder',         id:'4673',   icon:'⚽' },
    { name:'Dembélé',          id:'288230', icon:'⚽' },
    { name:'Kaká',             id:'3366',   icon:'⚽' },
    { name:'Modric',           id:'44853',  icon:'⚽' },
    { name:'Agüero',           id:'26476',  icon:'⚽' },
    { name:'David Villa',      id:'7980',   icon:'⚽' },
    { name:'Mertens',          id:'55735',  icon:'⚽' },
    { name:'De Bruyne',        id:'88755',  icon:'⚽' },
    { name:'Ibrahimovic',      id:'3455',   icon:'⚽' },
    { name:'Buffon',           id:'5023',   icon:'⚽' },
    { name:'Sergio Ramos',     id:'25557',  icon:'⚽' },
    { name:'Zidane',           id:'3111',   icon:'⚽' },
    { name:'Xabi Alonso',      id:'7476',   icon:'⚽' },
    { name:'Varane',           id:'99843',  icon:'⚽' },
    { name:'Salah',            id:'148455', icon:'⚽' },
    { name:'Kanté',            id:'129084', icon:'⚽' },
    { name:'Alexis Sánchez',   id:'55726',  icon:'⚽' },
    { name:'Robben',           id:'4360',   icon:'⚽' },
    { name:'Torres',           id:'7767',   icon:'⚽' },
    { name:'Joaquín',          id:'7663',   icon:'⚽' },
    { name:'Totti',            id:'5958',   icon:'⚽' },
  ];

  /* ────────── Contar jugadores válidos ────────── */
  function _matching(restriction, db) {
    return db.filter(p => validate(p, restriction)).length;
  }

  /* ────────── Generar restricciones ────────── */
  function generate(seed, db) {
    const rng = _mulberry32(seed);

    /* ══ PASO 1: Elegir 2 clubes obligatorios ══ */
    const shuffledClubs = _shuffle(CLUBS_LIST, rng);
    const clubRestrictions = [];
    for (const club of shuffledClubs) {
      if (clubRestrictions.length >= 2) break;
      const r = {
        type:    'club',
        value:   club.tmName,
        label:   `Ha jugado en ${club.display}`,
        imgUrl:  club.logoUrl,
        icon:    '🏟️',
        family:  'club',
      };
      /* solo añadir si al menos 1 jugador lo cumple */
      if (_matching(r, db) >= 1) clubRestrictions.push(r);
    }
    /* Fallback: rellenar si hay menos de 2 */
    if (clubRestrictions.length < 2) {
      for (const club of CLUBS_LIST) {
        if (clubRestrictions.length >= 2) break;
        const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
        if (!clubRestrictions.find(c => c.value === r.value)) clubRestrictions.push(r);
      }
    }

    /* ══ PASO 2: Pool de candidatos para las 3 restantes ══ */
    const candidates = [];

    /* Nacionalidades */
    for (const nat of _shuffle(NATIONALITIES, rng)) {
      candidates.push({
        type:'nationality', value:nat.tmNat, label:`Internacional ${nat.display}`,
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
      candidates.push({ type:'coach', value:c.name, label:`Entrenado por ${c.name}`, imgUrl:`data/coaches/${c.id}.png`, icon:c.icon, family:'coach' });
    }

    /* Compañeros de */
    for (const p of _shuffle(TEAMMATES_LIST, rng)) {
      candidates.push({ type:'teammate', value:p.name, label:`Compañero de ${p.name}`, imgUrl:`data/players/photos/${p.id}.jpg`, icon:p.icon, family:'teammate' });
    }

    /* Continent */
    for (const [cont, label] of [['europeo','Europeo'],['americano','Americano'],['africano','Africano'],['asiatico','Asiático']]) {
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

    /* Posición portero */
    candidates.push({ type:'position_gk', label:'Portero', imgUrl:null, icon:'🧤', family:'position' });

    /* Internacionalidades */
    candidates.push({ type:'caps_ge', value:50,  label:'50 o más internacionalidades', imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_le', value:50,  label:'50 o menos internacionalidades',imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_0',              label:'Sin internacionalidades',       imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:1,   label:'Internacional (≥1 partido)',    imgUrl:null, icon:'🌍', family:'caps' });

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
      label:'Ganador título continental', imgUrl:null, icon:'⭐', family:'trophy_general',
    });

    /* ══ PASO 3: Filtrar jugables (mínimo 2 jugadores) ══ */
    const playable = candidates.filter(r => _matching(r, db) >= 2);
    const shuffled = _shuffle(playable, rng);

    /* ══ PASO 4: Elegir 3 variadas (máx 1 por familia) ══ */
    const chosen   = [];
    const families = {};
    for (const r of shuffled) {
      if (chosen.length >= 3) break;
      const fam = r.family || r.type;
      if ((families[fam] || 0) >= 1) continue;
      chosen.push(r);
      families[fam] = (families[fam] || 0) + 1;
    }
    /* Fallback si no hay suficiente variedad */
    for (const r of shuffled) {
      if (chosen.length >= 3) break;
      if (!chosen.includes(r)) chosen.push(r);
    }

    return [...clubRestrictions, ...chosen.slice(0, 3)];
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
        // Inverso: el famoso tiene al jugador en su lista (jugador no es clave en compañeros_principal)
        const playerNorm = normalize(player.name);
        return !!(_REVERSE_TEAMMATE[targetNorm]?.has(playerNorm));
      }

      /* Continente */
      case 'continent': {
        const nat = player.nationalTeam || '';
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

  async function createRoom(hostName) {
    const {set,serverTimestamp}=FB();
    const code=_genCode(), hostId=_genId();
    await set(_ref(`${ROOMS_PATH}/${code}`),{
      status:'waiting', round:0, pointsToWin:7,
      players:{[hostId]:{name:hostName,score:0,connected:true,isHost:true}},
      restrictions:null, roundSeed:0, roundStartAt:null,
      submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
    });
    return {code, playerId:hostId};
  }

  async function joinRoom(code, playerName) {
    const {get,update}=FB();
    const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
    if (!snap.exists()) throw new Error('Sala no encontrada');
    const room = snap.val();
    if (room.status !== 'waiting') throw new Error('La partida ya ha comenzado');
    const count = Object.keys(room.players||{}).length;
    if (count >= 5) throw new Error('Sala llena (máx. 5 jugadores)');
    const playerId = _genId();
    await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{
      name:playerName, score:0, connected:true, isHost:false,
    });
    return {code, playerId};
  }

  async function findOrCreatePublicRoom(playerName) {
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
        const result = await joinRoom(code, playerName);
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
        status:'waiting', round:0, pointsToWin:7,
        isPublic:true, createdAt:Date.now(), lobbyAt:Date.now(),
        players:{[myId]:{name:playerName,score:0,connected:true,isHost:true}},
        restrictions:null, roundSeed:0, roundStartAt:null,
        submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
      });
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
    await update(_ref(`${ROOMS_PATH}/${code}`),{
      status:'playing', round:roundNum,
      roundSeed:roundData.seed, restrictions:roundData.restrictions,
      roundStartAt:Date.now(), submissions:{}, lockedPlayers:{}, doneCount:0, results:null,
      pointsToWin: roundData.pointsToWin ?? 7,
      roundSecs:   roundData.roundSecs   ?? 60,
      isSuddenDeath:      roundData.isSuddenDeath      ?? false,
      suddenDeathPlayers: roundData.suddenDeathPlayers ?? [],
    });
    for (const p of updatedPlayers) {
      await update(_ref(`${ROOMS_PATH}/${code}/players/${p.id}`),{score:p.score});
    }
  }

  async function submitAnswer(code, playerId, footballerName) {
    const {update,runTransaction}=FB();
    const lockKey = Restrictions.normalize(footballerName)
      .replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'');
    if (!lockKey) throw new Error('Nombre inválido');

    let locked = false;
    await runTransaction(_ref(`${ROOMS_PATH}/${code}/lockedPlayers/${lockKey}`), current => {
      if (current !== null && current !== undefined) return undefined;
      locked = true; return playerId;
    });
    if (!locked) throw new Error('Este futbolista ya fue elegido por otro jugador');

    await update(_ref(`${ROOMS_PATH}/${code}/submissions/${playerId}`),{
      playerName:footballerName, submittedAt:Date.now(),
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
    const scores = {};
    updatedPlayers.forEach(p=>{ scores[p.id]=p.score; });
    await update(_ref(`${ROOMS_PATH}/${code}`),{results, revealStart:Date.now(), scores});
    for (const p of updatedPlayers) {
      await update(_ref(`${ROOMS_PATH}/${code}/players/${p.id}`),{score:p.score});
    }

    /* Ahora si cambiar el status a 'reveal' — los clientes veran results ya disponibles */
    await runTransaction(_ref(`${ROOMS_PATH}/${code}/status`), current => {
      if (current==='playing') return 'reveal';
      return undefined;
    });
  }

  async function setFinished(code, winnerId, updatedPlayers) {
    const {update}=FB();
    for (const p of updatedPlayers) {
      await update(_ref(`${ROOMS_PATH}/${code}/players/${p.id}`),{score:p.score});
    }
    await update(_ref(`${ROOMS_PATH}/${code}`),{status:'finished', winnerId});
  }

  async function resetToLobby(code, players, newHostId) {
    const {update,get}=FB();
    const resetPlayers = {};
    for (const [pid, p] of Object.entries(players)) {
      resetPlayers[pid] = {
        name:p.name, score:0, connected:p.connected??true,
        isHost: newHostId ? pid===newHostId : (p.isHost??false),
      };
    }
    await update(_ref(`${ROOMS_PATH}/${code}`),{
      status:'waiting', round:0, roundSeed:0, restrictions:null, roundStartAt:null,
      submissions:{}, lockedPlayers:{}, doneCount:0, results:null, winnerId:null,
      lobbyAt:Date.now(), resetAt:Date.now(), players:resetPlayers,
    });
    try {
      const snap = await get(_ref(`${ROOMS_PATH}/${code}`));
      if (snap.exists() && snap.val().isPublic) {
        await update(_ref(`${MM_PATH}/${code}`),{
          status:'waiting', playerCount:Object.keys(resetPlayers).length,
        });
      }
    } catch(e) {}
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
      if (room.status==='waiting') {
        await remove(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`));
        const remaining = Object.keys(room.players||{}).filter(pid=>pid!==playerId).length;
        if (remaining===0 && room.isPublic) {
          remove(_ref(`${MM_PATH}/${code}`)).catch(()=>{});
          remove(_ref(`${ROOMS_PATH}/${code}`)).catch(()=>{});
        } else if (room.isPublic) {
          update(_ref(`${MM_PATH}/${code}`),{playerCount:remaining}).catch(()=>{});
        }
        if (room.players?.[playerId]?.isHost) {
          const nextPid = Object.keys(room.players||{}).find(pid=>pid!==playerId);
          if (nextPid) update(_ref(`${ROOMS_PATH}/${code}/players/${nextPid}`),{isHost:true}).catch(()=>{});
        }
      } else {
        await update(_ref(`${ROOMS_PATH}/${code}/players/${playerId}`),{connected:false});
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
    resetToLobby, expirePublicRoom, disconnect, getRoom, updateRoomSettings,
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
  let _isLocal    = false;
  let _localName  = '';
  let _localRound = 0;

  let _round           = 0;
  let _players         = [];
  let _restrictions    = [];
  let _submitted       = false;
  let _mySubmission    = null;
  let _revealTriggered = false;

  let _timerInterval  = null;
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


  /* ════════════════════════════════════════
     CARGA DE DATOS — patrón Blackjack
     Una sola promesa, errores visibles inmediatamente.
     ════════════════════════════════════════ */
  let _dataPromise    = null;
  let _chunksPreloaded = false;
  let _chunksPromise  = null;

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
     CUENTA ATRÁS + PRECARGA DE CHUNKS
     Muestra un overlay con espera mínima y,
     si todavía faltan datos, extiende la carga
     hasta que todo esté realmente preparado.
     ════════════════════════════════════════ */
  function _showPreloadCountdown(onDone) {
    const MIN_PRELOAD_SECONDS = 10;
    /* Usar el overlay del HTML (ya existe con las clases de Cadena) o crearlo */
    let overlay = document.getElementById('countdown-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'countdown-overlay';
      overlay.className = 'countdown-overlay hidden';
      document.body.appendChild(overlay);
    }
    /* Siempre resetear el contenido y quitar hidden para que sea visible */
    overlay.innerHTML = `
      <div class="countdown-inner">
        <div class="countdown-label">CARGANDO JUGADORES</div>
        <div id="countdown-number" class="countdown-number">${MIN_PRELOAD_SECONDS}</div>
      </div>`;
    overlay.classList.remove('hidden');

    const numEl = document.getElementById('countdown-number');
    let dataReady = false;
    let countdownDone = false;
    let doneCalled = false;
    let iv = null;

    function _tryDone() {
      if (doneCalled) return;
      if (dataReady && countdownDone) {
        doneCalled = true;
        if (iv) clearInterval(iv);
        overlay.classList.add('hidden');
        onDone();
      }
    }

    /* Cargar todos los chunks con reintentos (hasta 3) si alguno falla — igual que Cadena */
    async function _ensureAllChunksLoaded() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const results = await Promise.all(ALL_CHUNKS_LIST.map(async c => {
          const cf = `../data/players/chunks/${c}.json`;
          if (_chunkCache[cf]?.__full) return true;
          try {
            const r = await fetch(cf);
            if (!r.ok) return false;
            const data = await r.json();
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
    _ensureAllChunksLoaded();

    /* También asegurarse de que PLAYERS_DB está listo */
    _loadGameData()
      .then(() => { dataReady = true; _tryDone(); })
      .catch(() => { dataReady = true; _tryDone(); });

    /* Cuenta atrás basada en Date.now() — inmune al drift de setInterval bajo carga de red */
    const startAt = Date.now();
    iv = setInterval(() => {
      const elapsed   = Math.floor((Date.now() - startAt) / 1000);
      const remaining = Math.max(0, MIN_PRELOAD_SECONDS - elapsed);

      if (remaining > 0) {
        if (numEl) numEl.textContent = String(remaining);
      } else if (!countdownDone && !dataReady) {
        /* Datos aún no listos — mostrar ⏳ igual que Cadena, más claro que "+3" */
        if (numEl) numEl.textContent = '⏳';
      }

      if (remaining <= 0 && !countdownDone) {
        countdownDone = true;
        _tryDone();
      }
    }, 200); /* Tick cada 200ms para precisión visual sin coste notable */
  }

  /* ════════════════════════════════════════
     MODO LOCAL — igual que Blackjack
     ════════════════════════════════════════ */
  async function startLocalGame() {
    const name = document.getElementById('input-local-name')?.value.trim();
    if (!name) { _showError('error-local', 'Escribe tu nombre'); return; }
    _clearError('error-local');

    const btn = document.querySelector('#panel-local .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'CARGANDO…'; }

    try {
      /* Verificar que los datos base cargan (error rápido y visible si hay problema) */
      await _loadGameData();

      _isLocal=true; _isHost=true; _playerId='local-p1';
      _localName=name; _localRound=0;
      _players=[{id:'local-p1', name, score:0}];

      if (btn) { btn.disabled = false; btn.textContent = 'JUGAR SOLO ▶'; }

      /* Mostrar cuenta atrás mínima mientras terminan de precargar todos los chunks */
      _showPreloadCountdown(() => _startLocalRound());

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

  /* ── También necesitamos un _runCountdownThenLoad para la ronda online ── */
  /* (el countdown ya no se usa para local, pero online lo sigue necesitando) */
  function _runCountdownThenLoad(onDone) {
    /* Para online: simplemente ejecutar onDone cuando los datos estén listos */
    /* Los datos ya fueron cargados en el startGame del host */
    if (PLAYERS_DB.length > 0) { onDone(); return; }
    /* Si por alguna razón no están, cargar y luego ejecutar */
    _loadGameData()
      .then(() => onDone())
      .catch(e => {
        console.error('[App] _runCountdownThenLoad error:', e);
        showToast('❌ Error cargando datos para la ronda', 'error');
      });
  }
  /* ════════════════════════════════════════
     INIT
     ════════════════════════════════════════ */
  async function init() {
    _showScreen('screen-menu');
    _preloadDataInBackground();

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
    const name = document.getElementById('input-host-name')?.value?.trim();
    if (!name) { _showError('error-private','Escribe tu nombre'); return; }
    _clearError('error-private');
    const btn = document.querySelector('#panel-private .btn-primary');
    _btnLoad(btn,'CREANDO…');
    try {
      const {code,playerId} = await Sync.createRoom(name);
      _roomCode=code; _playerId=playerId; _isHost=true; _isPublic=false; _isLocal=false;
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
    const name = document.getElementById('input-join-name')?.value?.trim();
    const code = document.getElementById('input-join-code')?.value?.trim().toUpperCase();
    if (!name) { _showError('error-private','Escribe tu nombre'); return; }
    if (!code||code.length!==6) { _showError('error-private','Código de 6 caracteres'); return; }
    _clearError('error-private');
    const btn = document.querySelector('#panel-private .btn-secondary');
    _btnLoad(btn,'UNIÉNDOSE…');
    try {
      const result = await Sync.joinRoom(code, name);
      _roomCode=result.code; _playerId=result.playerId; _isHost=false; _isPublic=false; _isLocal=false;
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
    const name = document.getElementById('input-public-name')?.value?.trim();
    if (!name) { _showError('error-public','Escribe tu nombre'); return; }
    _clearError('error-public');
    const btn = document.getElementById('btn-find-public');
    _btnLoad(btn,'BUSCANDO…');
    try {
      const result = await Sync.findOrCreatePublicRoom(name);
      _roomCode=result.code; _playerId=result.playerId; _isHost=result.isHost; _isPublic=true; _isLocal=false;
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
    try {
      await _loadGameData();
      const seed         = Date.now();
      const restrictions = Restrictions.generate(seed, PLAYERS_DB);
      /* Leer ajustes actuales de la sala */
      const freshRoom = await Sync.getRoom(_roomCode);
      if (freshRoom?.pointsToWin != null) _onlinePointsToWin = freshRoom.pointsToWin;
      if (freshRoom?.roundSecs   != null) _onlineRoundSecs   = freshRoom.roundSecs;
      await Sync.startGame(_roomCode, {seed, restrictions, pointsToWin:_onlinePointsToWin, roundSecs:_onlineRoundSecs});
      _clearPublicLobbyTimer();
    } catch(e) {
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
    _round        = _localRound;
    _restrictions = Restrictions.generate(Date.now()+_localRound*7919, PLAYERS_DB);
    _submitted=false; _mySubmission=null; _revealTriggered=false;
    _showScreen('screen-round');
    _renderTopbar(_localRound, _players);
    _renderSubmissions(_players, {});
    const secs = _isSuddenDeath ? SUDDEN_DEATH_SECS : (_localRoundSecs || ROUND_SECS);
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
    _animateRestrictions(_restrictions, () => {
      if (pi) pi.disabled = false;
      if (sb) sb.disabled = false;
      _startTimer(Date.now(), secs);
    });
  }

  /* ════════════════════════════════════════
     SALIR
     ════════════════════════════════════════ */
  async function leaveRoom() {
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

  function _onRoomUpdate(room) {
    _lastRoom = room;
    if (room.status === 'expired') { _handleKicked('La sala pública expiró por inactividad ⏱️'); return; }
    if (!_isLocal && _playerId && room.players && !room.players[_playerId]) {
      _handleKicked('Has sido expulsado de la sala'); return;
    }
    if (room.players) {
      _players = Object.entries(room.players).map(([id,p])=>({
        id, name:p.name, score:p.score||0, connected:p.connected??true, isHost:p.isHost??false
      }));
    }
    switch(room.status) {
      case 'waiting': _updateLobbyUI(room); break;
      case 'playing':
        if (room.round !== _round) {
          _round=room.round; _restrictions=room.restrictions||[];
          _submitted=false; _mySubmission=null; _revealTriggered=false;
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
          if (_isHost && !_revealTriggered) {
            const connected = _players.filter(p=>p.connected!==false);
            if (connected.length>0 && (room.doneCount||0)>=connected.length) {
              _triggerReveal(room);
            }
          }
        }
        break;
      case 'reveal':
        if (_currentScreen()!=='screen-results') _showResultsScreen(room);
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
        players: { [_playerId]: { name: _localName || '…', score: 0, connected: true, isHost: _isHost } },
      };
      _updateLobbyUI(minRoom);
    } else {
      _updateLobbyUI(base);
    }
  }

  function _updateLobbyUI(room) {
    if (_currentScreen() !== 'screen-lobby') _showScreen('screen-lobby');
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
            <div class="lobby-player-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <span class="lobby-player-name">${p.name}</span>
            ${p.isHost ? '<span class="lobby-player-host">HOST</span>' : ''}
            ${pid===_playerId ? '<span style="margin-left:auto;font-size:.7rem;opacity:.4;letter-spacing:1px;">← TÚ</span>' : ''}
          </div>
        `).join('');
    }
    const players  = Object.values(room.players||{}).filter(p=>p.connected!==false);
    const count    = players.length;
    const startBtn = document.getElementById('btn-start-game');
    const hintEl   = document.getElementById('lobby-hint');
    if (_isHost && startBtn) { startBtn.style.display='block'; startBtn.disabled=count<2; }
    else if (startBtn) { startBtn.style.display='none'; }
    if (hintEl) {
      if (_isPublic && !_isHost) hintEl.textContent = 'Esperando a que el host empiece…';
      else if (count < 2) hintEl.textContent = _isPublic ? 'Buscando más jugadores…' : 'Esperando jugadores… (mínimo 2)';
      else hintEl.textContent = `${count} jugadores listos — ¡empieza cuando quieras!`;
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

    if (_isHost && _isPublic && room.lobbyAt) _startPublicLobbyTimer(room);
    if (_isPublic && room.lobbyAt) _renderPublicLobbyTimer(room.lobbyAt);
  }

  /* Timer lobby público */
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
    /* Actualizar cada segundo (el original solo llamaba tick() una vez y se quedaba congelado) */
    const iv = setInterval(() => {
      const remaining = Math.max(0, PUBLIC_LOBBY_TIMEOUT - (Date.now() - lobbyAt));
      tick();
      if (remaining <= 0) clearInterval(iv);
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
    if (!_isHost || !_roomCode) return;
    showToast('⏱️ Sala pública expirada — cerrando…', 'error');
    try { await Sync.expirePublicRoom(_roomCode); } catch(e) {}
    _handleKicked('La sala pública expiró por inactividad ⏱️');
  }

  /* startGame() — ver implementación completa arriba (con _loadGameData) */

  /* ════════════════════════════════════════
     RONDA ONLINE
     ════════════════════════════════════════ */
  function _startOnlineRound(room) {
    if (room.round === 1) _runCountdownThenLoad(() => _doStartOnlineRound(room));
    else _doStartOnlineRound(room);
  }

  function _doStartOnlineRound(room) {
    _showScreen('screen-round');
    _renderTopbar(room.round, _players);
    _renderSubmissions(_players, {});
    const secs = _isSuddenDeath ? SUDDEN_DEATH_SECS : (_onlineRoundSecs || ROUND_SECS);
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
    /* El timer y el input arrancan DESPUÉS de que se muestran todas las restricciones.
       Usamos Date.now() como referencia para que todos los jugadores tengan
       el mismo tiempo disponible independientemente del lag de red. */
    _animateRestrictions(_restrictions, () => {
      if (canPlay) {
        if (pi) pi.disabled = false;
        if (sb) sb.disabled = false;
      }
      _startTimer(Date.now(), secs);
    });
  }

  /* ════════════════════════════════════════
     ANIMACIÓN DE RESTRICCIONES
     ════════════════════════════════════════ */
  function _animateRestrictions(restrictions, onComplete) {
    const grid = document.getElementById('restrictions-grid');
    if (!grid) { onComplete?.(); return; }

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
      if (i >= cards.length) { onComplete?.(); return; }
      cards[i].classList.add('visible'); i++;
      if (i < cards.length) setTimeout(next, 1000);
      else setTimeout(()=>onComplete?.(), 400);
    }
    setTimeout(next, 300);
  }

  /* ════════════════════════════════════════
     TIMER
     ════════════════════════════════════════ */
  function _startTimer(startAt, totalSecs) {
    _stopTimer();
    const secs = totalSecs || ROUND_SECS;
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

    let player;
    try {
      /* Busca en PLAYERS_DB primero, luego en chunks (igual que Cadena) */
      player = await findPlayerAsync(name);
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

    _submitted=true; _mySubmission=player.name;
    if (sb)  sb.disabled  = true;
    if (pi2) pi2.disabled = true;
    showToast(`✓ ${player.name} enviado`, 'success');

    if (_isLocal) { _stopTimer(); _localReveal(); return; }

    try {
      const doneCount = await Sync.submitAnswer(_roomCode, _playerId, player.name);
      const connected = _players.filter(p=>p.connected!==false).length;
      if (_isHost && !_revealTriggered && doneCount>=connected) _triggerReveal(_lastRoom);
    } catch(e) {
      _submitted=false; _mySubmission=null;
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

    /* Leer sala fresca de Firebase para asegurar que las submissions
       de todos los jugadores están disponibles (evita el bug de "Sin respuesta") */
    let freshRoom = room;
    try {
      /* Pequeña espera para que Firebase propague todas las submissions */
      await new Promise(resolve => setTimeout(resolve, 500));
      const fetched = await Sync.getRoom(_roomCode);
      if (fetched) freshRoom = fetched;
    } catch(e) {
      console.warn('[App] No se pudo leer sala fresca, usando datos locales:', e);
    }

    const submissions  = freshRoom?.submissions||{};
    const restrictions = freshRoom?.restrictions||_restrictions;
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
        try {
          await Sync.startReveal(_roomCode, results, updated);
          await Sync.setFinished(_roomCode, sdWinner.id, updated);
        } catch(e) { console.error('[App] sudden death finish error:', e); _revealTriggered=false; }
        return;
      }
    } else {
      /* Modo normal: comprobar si alguien alcanza pointsToWin */
      const ptw = _onlinePointsToWin || POINTS_WIN;
      const reached = updated.filter(p => p.score >= ptw);
      if (reached.length === 1) {
        try {
          await Sync.startReveal(_roomCode, results, updated);
          await Sync.setFinished(_roomCode, reached[0].id, updated);
        } catch(e) { console.error('[App] finish error:', e); _revealTriggered=false; }
        return;
      }
    }

    try {
      await Sync.startReveal(_roomCode, results, updated);
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
    const subs    = _mySubmission ? {[_playerId]:{playerName:_mySubmission}} : {};
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
  }

  /* ════════════════════════════════════════
     MOSTRAR RESULTADOS (online)
     ════════════════════════════════════════ */
  function _showResultsScreen(room) {
    _stopTimer();
    const results = room.results||{};

    /* Muerte súbita online: ¿hay ganador de esta ronda? */
    if (_isSuddenDeath && _isHost) {
      const roundWinner = _players
        .filter(p => _suddenDeathPlayers.includes(p.id))
        .find(p => results[p.id]?.isWinner);
      if (roundWinner) {
        _isSuddenDeath=false; _suddenDeathPlayers=[];
        Sync.setFinished(_roomCode, roundWinner.id, _players).catch(()=>{});
        return;
      }
    }

    _renderResultsUI(room.round, room.restrictions||_restrictions, results, _players);
    _showScreen('screen-results');

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
    if (nxt) nxt.classList.toggle('hidden', !_isHost);
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
    const ptw = _onlinePointsToWin || POINTS_WIN;

    /* Detectar muerte súbita */
    if (!_isSuddenDeath) {
      const reached = _players.filter(p=>p.score>=ptw);
      if (reached.length >= 2) {
        /* Empate → iniciar muerte súbita */
        _isSuddenDeath = true;
        _suddenDeathPlayers = reached.map(p=>p.id);
        const seed = Date.now()+(_round*3137);
        const restrictions = Restrictions.generate(seed, PLAYERS_DB);
        try {
          await Sync.nextRound(_roomCode, _round+1, {
            seed, restrictions,
            pointsToWin: _onlinePointsToWin, roundSecs: _onlineRoundSecs,
            isSuddenDeath: true, suddenDeathPlayers: _suddenDeathPlayers,
          }, _players);
        } catch(e) { showToast('Error al iniciar muerte súbita', 'error'); }
        return;
      } else if (reached.length === 1) {
        try { await Sync.setFinished(_roomCode, reached[0].id, _players); } catch(e) {}
        return;
      }
    } else {
      /* Ya en muerte súbita — ¿hay ganador? */
      /* Se detecta en _triggerReveal/_showResultsScreen */
    }

    const seed = Date.now()+(_round*3137);
    const restrictions = Restrictions.generate(seed, PLAYERS_DB);
    try {
      await Sync.nextRound(_roomCode, _round+1, {
        seed, restrictions,
        pointsToWin: _onlinePointsToWin, roundSecs: _onlineRoundSecs,
        isSuddenDeath: _isSuddenDeath, suddenDeathPlayers: _suddenDeathPlayers,
      }, _players);
    } catch(e) { showToast('Error al iniciar la siguiente ronda', 'error'); }
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
          '<span class="final-score-name">' + p.name + ' ' + (isW?'🏆':'') + '</span>' +
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
      const footer = document.getElementById('reveal-footer') || (nxt && nxt.parentNode);
      if (footer) footer.insertBefore(cdEl, footer.firstChild);
    }
    if (nxt) nxt.style.display = 'none';
    let remaining = secs;
    cdEl.textContent = '🏆 GANADOR EN ' + remaining + 's…';
    _finishedDelayTimer = setInterval(() => {
      remaining--;
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
    }, 1000);
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
            '<span class="final-score-name">' + p.name + ' ' + (isW?'🏆':'') + '</span>' +
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
    if (_isLocal) {
      _players=[{..._players[0],score:0}]; _localRound=0;
      _isSuddenDeath=false; _suddenDeathPlayers=[];
      _acClose(); _startLocalRound(); return;
    }
    if (!_roomCode||!_lastRoom?.players) { showMenu(); return; }
    try { await Sync.resetToLobby(_roomCode, _lastRoom.players, _playerId); }
    catch(e) { console.error('[App] playAgain error:', e); showMenu(); }
  }

  function showMenu() {
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
    for (const p of players) {
      const sub = submissions[p.id];
      if (!sub||!sub.playerName) {
        results[p.id]={playerName:null,valid:false,matchCount:0,matches:restrictions.map(()=>false),footballer:null,points:0,isWinner:false};
        continue;
      }
      /* Buscar jugador: primero PLAYERS_DB, luego chunks (como Cadena) */
      const player = await findPlayerAsync(sub.playerName);
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
        <span class="sb-name">${p.name}</span>
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
            <div class="submission-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <div class="submission-meta">
              <span class="submission-name">${p.name}</span>
              <span class="submission-status">${sent?'Jugador bloqueado':'Esperando elección'}</span>
            </div>
          </div>
          <div class="submission-choice ${sent?'':'pending'}">${sent ? chosenName : 'Aún sin bloquear'}</div>
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
            ? `<div class="result-footballer not-found">${r.playerName}</div>
               <div class="result-not-found-hint">⚠ No encontrado en la base de datos</div>`
            : `<div class="result-footballer-row">
                <div class="result-main-block">
                  ${photoHtml}
                  <div class="result-footballer-info">
                    <div class="result-footballer">${r.footballer||r.playerName}</div>
                    <div class="result-match-count"><span class="count-value">${r.matchCount}</span> / ${restrictions?.length||5} restricciones</div>
                  </div>
                </div>
                ${metBadges ? `<div class="result-restrictions">${metBadges}</div>` : ''}
              </div>`;

        return `
          <div class="result-card ${r.isWinner?'winner':''} ${!r.valid&&!noSubmit?'invalid':''}">
            <div class="result-card-header">
              <div class="result-player-name">${p.name}</div>
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
    const n = _acNorm(name);
    const idx = n.indexOf(q);
    if (idx === -1) return name;
    return name.slice(0, idx)
      + '<span class="autocomplete-highlight">' + name.slice(idx, idx + query.length) + '</span>'
      + name.slice(idx + query.length);
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
          teams: d?.teams || [],
          apps:  d?.apps  || 0,
          pos:   d?.p     || '',
          nat:   d?.nat   || '',
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

      /* ── Eliminar duplicados de nombre normalizado post-sort ──
         Quedarse con el de mejor posición (que tiene mejores datos) */
      const seenNorms = new Set();
      const deduped = [];
      for (const item of withData) {
        const key = _acNorm(item.name);
        if (seenNorms.has(key)) continue;
        seenNorms.add(key);
        deduped.push(item);
        if (deduped.length >= 8) break;
      }

      /* ── Desambiguación para nombres iguales ── */
      const POS_LABEL = { GK:'Portero', DEF:'Defensa', MID:'Centrocampista', FWD:'Delantero' };
      const finalItems = deduped.map((item, _, arr) => {
        const sameName = arr.filter(o => _acNorm(o.name) === _acNorm(item.name));
        const tags = [];
        const posLabel = POS_LABEL[item.pos] || item.pos || '';
        if (posLabel) tags.push(posLabel);
        if (sameName.length > 1 && item.nat) tags.push(item.nat);
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

  function _resetState() {
    _roomCode=null; _playerId=null; _isHost=false; _isPublic=false;
    _isLocal=false; _localName=''; _localRound=0;
    _round=0; _players=[]; _restrictions=[];
    _submitted=false; _mySubmission=null; _revealTriggered=false;
    _lastRoom=null;
    _isSuddenDeath=false; _suddenDeathPlayers=[];
    _onlinePointsToWin=7; _onlineRoundSecs=60;
    _stopTimer();
    _acClose();
  }

  function _saveSession() {
    try { sessionStorage.setItem('coche_session', JSON.stringify({code:_roomCode,playerId:_playerId,isHost:_isHost,isPublic:_isPublic})); } catch(e){}
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
    _continueLocalGame: null, /* se asigna dinámicamente desde _runCountdownThenLoad */
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
  [
    '0-99999','100000-199999','200000-299999','300000-399999','400000-499999',
    '500000-599999','600000-699999','700000-799999','800000-899999','900000-999999',
    '1000000-1099999','1100000-1199999','1200000-1299999','1300000-1399999','1400000-1499999',
  ].forEach(c => {
    const cf = `../data/players/chunks/${c}.json`;
    if (_chunkCache[cf]?.__full) return;
    fetch(cf).then(r => r.ok ? r.json() : null).then(data => {
      if (data) { data.__full = true; _chunkCache[cf] = data; }
    }).catch(() => {});
  });
});
