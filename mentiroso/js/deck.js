/* ═══════════════════════════════════════════════════════════
   DECK.JS — EL MENTIROSO · baraja y condiciones
   ───────────────────────────────────────────────────────────
   Antes las cartas salían de la tabla mentiroso_players (32
   jugadores con stats escritas a mano y una foto que ya no
   existe: tmssl.akamaized.net/images/foto/small/{id}.jpg
   devuelve 404 desde hace tiempo, así que NINGUNA carta tenía
   imagen).

   Ahora la baraja se construye con la base de datos real de la
   web (bucket "player-db", los mismos chunks que usan Coche y
   En la Cadena) filtrada por la lista de fama de Coche
   (game-data/coche/gen_pool.json, ~1.500 futbolistas
   reconocibles). De ahí salen:
     · la FOTO real de cada jugador  (campo img del chunk)
     · el ESCUDO de su último club   (bucket team-logos)
     · datos verificables para las condiciones de cada ronda
       (clubes, liga, nacionalidad, posición, pierna, goles,
       partidos, internacionalidades, altura, año de nacimiento
       y nº de clubes)

   IMPORTANTE — determinismo: el reparto NO se recalcula en cada
   cliente a partir de una semilla. El anfitrión reparte y
   escribe en Firebase los IDs de cada carta; los demás solo los
   resuelven contra este pool. Así da igual que un cliente cargue
   los chunks un poco distintos: todos ven exactamente la misma
   mesa. (Con las reglas nuevas los nombres de TODAS las cartas
   son públicos, así que publicar los IDs no esconde nada que el
   jugador no vaya a ver en pantalla.)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const MDeck = (function () {

  /* ═══ 1. RNG determinista ═══════════════════════════════ */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffleRng(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pickRng(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

  /* ═══ 2. Escudos, banderas y logos ══════════════════════ */
  /* Mismo criterio que coche/js/script.js:_logoUrl — el bucket
     guarda "Nombre_Del_Equipo.png" y sbStorageUrl ya quita los
     acentos (las claves de Storage son ASCII). */
  function clubBadge(tmName) {
    if (!tmName) return null;
    return sbStorageUrl('team-logos', String(tmName).replace(/ /g, '_') + '.png');
  }
  function flagUrl(code) { return sbStorageUrl('team-flags', code + '.png'); }
  function leagueLogo(file) { return sbStorageUrl('league-logos', file + '.png'); }

  /* ═══ 3. Catálogos para las condiciones ═════════════════ */
  /* Clubes candidatos: nombre exacto de Transfermarkt (el que
     aparece en chunk.teams) + nombre corto para el titular. */
  const CLUBS = [
    { tm: 'Real Madrid',            name: 'el Real Madrid' },
    { tm: 'FC Barcelona',           name: 'el Barcelona' },
    { tm: 'Atlético de Madrid',     name: 'el Atlético de Madrid' },
    { tm: 'Valencia CF',            name: 'el Valencia' },
    { tm: 'Sevilla FC',             name: 'el Sevilla' },
    { tm: 'Villarreal CF',          name: 'el Villarreal' },
    { tm: 'Real Betis Balompié',    name: 'el Betis' },
    { tm: 'Athletic Bilbao',        name: 'el Athletic' },
    { tm: 'Real Sociedad',          name: 'la Real Sociedad' },
    { tm: 'RCD Espanyol Barcelona', name: 'el Espanyol' },
    { tm: 'Manchester United',      name: 'el Manchester United' },
    { tm: 'Manchester City',        name: 'el Manchester City' },
    { tm: 'Liverpool FC',           name: 'el Liverpool' },
    { tm: 'Chelsea FC',             name: 'el Chelsea' },
    { tm: 'Arsenal FC',             name: 'el Arsenal' },
    { tm: 'Tottenham Hotspur',      name: 'el Tottenham' },
    { tm: 'West Ham United',        name: 'el West Ham' },
    { tm: 'Everton FC',             name: 'el Everton' },
    { tm: 'Newcastle United',       name: 'el Newcastle' },
    { tm: 'Juventus FC',            name: 'la Juventus' },
    { tm: 'AC Milan',               name: 'el Milan' },
    { tm: 'Inter Milan',            name: 'el Inter' },
    { tm: 'AS Roma',                name: 'la Roma' },
    { tm: 'SS Lazio',               name: 'la Lazio' },
    { tm: 'SSC Napoli',             name: 'el Nápoles' },
    { tm: 'ACF Fiorentina',         name: 'la Fiorentina' },
    { tm: 'Atalanta BC',            name: 'el Atalanta' },
    { tm: 'Bayern Munich',          name: 'el Bayern' },
    { tm: 'Borussia Dortmund',      name: 'el Dortmund' },
    { tm: 'Bayer 04 Leverkusen',    name: 'el Leverkusen' },
    { tm: 'FC Schalke 04',          name: 'el Schalke' },
    { tm: 'Paris Saint-Germain',    name: 'el PSG' },
    { tm: 'Olympique Lyon',         name: 'el Lyon' },
    { tm: 'Olympique Marseille',    name: 'el Marsella' },
    { tm: 'AS Monaco',              name: 'el Mónaco' },
    { tm: 'Ajax Amsterdam',         name: 'el Ajax' },
    { tm: 'PSV Eindhoven',          name: 'el PSV' },
    { tm: 'FC Porto',               name: 'el Oporto' },
    { tm: 'SL Benfica',             name: 'el Benfica' },
    { tm: 'Sporting CP',            name: 'el Sporting de Portugal' },
    { tm: 'Galatasaray',            name: 'el Galatasaray' },
  ];

  /* Ligas: lista de equipos históricos de cada una (misma lista
     que usa Coche, para que "ha jugado en la Premier" signifique
     lo mismo en los dos juegos). */
  const LEAGUES = [
    { id: 'La Liga', name: 'LaLiga', logo: 'LaLiga', teams: [
      'FC Barcelona','Real Madrid','Atlético de Madrid','Valencia CF','Sevilla FC',
      'Real Betis Balompié','Villarreal CF','Athletic Bilbao','CA Osasuna','Celta de Vigo',
      'RCD Espanyol Barcelona','RCD Mallorca','Rayo Vallecano','Getafe CF','Girona FC',
      'Levante UD','Real Sociedad','Deportivo Alavés','Elche CF','Real Oviedo',
      'Málaga CF','Deportivo de La Coruña','Real Zaragoza','Cádiz CF','UD Almería',
      'Granada CF','SD Eibar','CD Leganés','SD Huesca','Real Valladolid CF',
      'UD Las Palmas','Sporting Gijón','Racing Santander','Recreativo Huelva','Real Murcia',
    ] },
    { id: 'Premier League', name: 'la Premier League', logo: 'PremierLeague', teams: [
      'Arsenal FC','Manchester City','Manchester United','Liverpool FC','Chelsea FC',
      'Tottenham Hotspur','Aston Villa','West Ham United','Everton FC','Leicester City',
      'Newcastle United','Wolverhampton Wanderers','Brighton & Hove Albion','Crystal Palace',
      'Fulham FC','Brentford FC','Nottingham Forest','AFC Bournemouth',
      'Leeds United','Burnley FC','Blackburn Rovers','Bolton Wanderers','Stoke City',
      'Swansea City','Norwich City','Sunderland AFC','Middlesbrough FC','Birmingham City',
      'Hull City','Southampton FC','Ipswich Town','Luton Town','Sheffield United','Derby County',
      'Wigan Athletic','Portsmouth FC','Charlton Athletic','Queens Park Rangers','Reading FC',
      'West Bromwich Albion','Watford FC','Cardiff City','Huddersfield Town','Blackpool FC',
    ] },
    { id: 'Serie A', name: 'la Serie A', logo: 'SerieA', teams: [
      'Juventus FC','AC Milan','Inter Milan','SSC Napoli','AS Roma','SS Lazio',
      'Atalanta BC','ACF Fiorentina','Torino FC','Udinese Calcio','Bologna FC 1909',
      'Cagliari Calcio','Genoa CFC','Hellas Verona','US Sassuolo','US Lecce',
      'US Cremonese','Parma Calcio 1913','Como 1907','Sampdoria','Empoli FC',
      'Venezia FC','AC Monza','Spezia Calcio','Benevento Calcio','FC Crotone','Frosinone Calcio',
      'UC Sampdoria','Parma FC','Delfino Pescara 1936','Chievo Verona','US Palermo',
      'AC Siena','Calcio Catania','SSC Bari','Brescia Calcio','Reggina 1914',
    ] },
    { id: 'Bundesliga', name: 'la Bundesliga', logo: 'Bundesliga', teams: [
      'Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer 04 Leverkusen',
      'Borussia Mönchengladbach','TSG 1899 Hoffenheim','Eintracht Frankfurt','VfL Wolfsburg',
      'SV Werder Bremen','1.FSV Mainz 05','FC Augsburg','SC Freiburg','1.FC Köln',
      '1.FC Union Berlin','VfB Stuttgart','1.FC Heidenheim 1846','Hamburger SV',
      'FC Schalke 04','Hertha BSC','VfL Bochum 1848','1.FC Nürnberg',
      'Hannover 96','1.FC Kaiserslautern','Arminia Bielefeld','SpVgg Greuther Fürth',
      'Fortuna Düsseldorf','SC Paderborn 07','FC Energie Cottbus','MSV Duisburg',
    ] },
    { id: 'Ligue 1', name: 'la Ligue 1', logo: 'Ligue1', teams: [
      'Paris Saint-Germain','AS Monaco','Olympique Lyon','Olympique Marseille','LOSC Lille',
      'Stade Rennais FC','OGC Nice','RC Lens','RC Strasbourg Alsace','FC Nantes',
      'Angers SCO','FC Toulouse','Stade Brestois 29','AJ Auxerre','FC Lorient',
      'Le Havre AC','FC Metz','Paris FC','Girondins de Bordeaux','AS Saint-Étienne',
      'Montpellier HSC','SC Bastia','Stade de Reims','Dijon FCO','ESTAC Troyes',
      'Valenciennes FC','AC Ajaccio','FC Sochaux-Montbéliard','Nîmes Olympique',
    ] },
    { id: 'Eredivisie', name: 'la Eredivisie', logo: 'Eredivisie', teams: [
      'Ajax Amsterdam','PSV Eindhoven','Feyenoord Rotterdam','AZ Alkmaar','FC Twente Enschede',
      'Vitesse Arnhem','SC Heerenveen','FC Utrecht','FC Groningen','Sparta Rotterdam',
      'Willem II Tilburg','NEC Nijmegen','Go Ahead Eagles','Heracles Almelo','PEC Zwolle',
      'Roda JC Kerkrade','NAC Breda','RKC Waalwijk','FC Volendam','ADO Den Haag',
    ] },
    { id: 'Primeira Liga', name: 'la Liga portuguesa', logo: 'PrimeiraLiga', teams: [
      'SL Benfica','FC Porto','Sporting CP','SC Braga','Vitória Guimarães SC',
      'Rio Ave FC','GD Estoril Praia','FC Famalicão','Moreirense FC','Boavista FC',
      'Gil Vicente FC','CS Marítimo','FC Paços de Ferreira','CD Nacional','Belenenses SAD',
    ] },
    { id: 'Süper Lig', name: 'la Superliga turca', logo: 'SuperLig', teams: [
      'Galatasaray','Fenerbahce','Fenerbahçe','Besiktas JK','Trabzonspor','Basaksehir FK',
      'Bursaspor','Fatih Karagümrük','Kayserispor','Caykur Rizespor','Kasimpasa',
      'Antalyaspor','Sivasspor','Alanyaspor','Konyaspor','Göztepe','MKE Ankaragücü',
    ] },
  ];
  const LEAGUE_SETS = {};
  LEAGUES.forEach(l => { LEAGUE_SETS[l.id] = new Set(l.teams); });

  /* Nacionalidades: tmNat = valor exacto de chunk.nat */
  const NATS = [
    { tm: 'Spain',       name: 'españoles',    flag: 'es'  },
    { tm: 'France',      name: 'franceses',    flag: 'fr'  },
    { tm: 'Italy',       name: 'italianos',    flag: 'it'  },
    { tm: 'Brazil',      name: 'brasileños',   flag: 'br'  },
    { tm: 'Argentina',   name: 'argentinos',   flag: 'ar'  },
    { tm: 'England',     name: 'ingleses',     flag: 'eng' },
    { tm: 'Germany',     name: 'alemanes',     flag: 'de'  },
    { tm: 'Netherlands', name: 'holandeses',   flag: 'nl'  },
    { tm: 'Portugal',    name: 'portugueses',  flag: 'pt'  },
    { tm: 'Belgium',     name: 'belgas',       flag: 'be'  },
    { tm: 'Uruguay',     name: 'uruguayos',    flag: 'uy'  },
    { tm: 'Croatia',     name: 'croatas',      flag: 'hr'  },
  ];

  /* Continentes (mismas listas que coche/js/restrictions-worker.js) */
  const CONTINENTS = [
    { id: 'europeo', name: 'europeos', emoji: '🇪🇺', list: [
      'Spain','England','France','Germany','Netherlands','Portugal','Italy',
      'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
      'Czech Republic','Czech','Switzerland','Austria','Turkey','Türkiye','Greece','Hungary',
      'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
      'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
      'Ireland','Republic of Ireland','Georgia','Kosovo','North Macedonia','Bulgaria','Cyprus',
      'Latvia','Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar',
      'Faroe Islands','Moldova','Belarus','Malta','Andorra','San Marino','Liechtenstein',
    ] },
    { id: 'americano', name: 'americanos', emoji: '🌎', list: [
      'Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
      'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
      'Trinidad and Tobago','Honduras','Costa Rica','Panama','Guatemala',
      'El Salvador','Cuba','Dominican Republic','Canada','Haiti','Curacao','Suriname',
    ] },
    { id: 'africano', name: 'africanos', emoji: '🌍', list: [
      'Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cameroon',
      'Morocco','Egypt','Algeria','Tunisia','South Africa','Mali','Guinea',
      'Burkina Faso','DR Congo','Congo','Republic of the Congo','Togo','Gabon',
      'Equatorial Guinea','Zimbabwe','Kenya','Cape Verde','Sierra Leone',
      'Liberia','Gambia','Guinea-Bissau','Rwanda','Ethiopia','Tanzania',
      'Zambia','Uganda','Angola','Mozambique','Madagascar','Benin','Niger','Libya','Mauritania',
    ] },
  ];
  const CONTINENT_SETS = {};
  CONTINENTS.forEach(c => { CONTINENT_SETS[c.id] = new Set(c.list); });

  const POSITIONS = [
    { id: 'GK',  name: 'porteros',        emoji: '🧤' },
    { id: 'DEF', name: 'defensas',        emoji: '🛡️' },
    { id: 'MID', name: 'centrocampistas', emoji: '🎯' },
    { id: 'FWD', name: 'delanteros',      emoji: '⚽' },
  ];

  const FEET = [
    { id: 'Zurdo',        name: 'zurdos',        emoji: '🦶' },
    { id: 'Diestro',      name: 'diestros',      emoji: '🦶' },
    { id: 'Ambidiestro',  name: 'ambidiestros',  emoji: '🦶' },
  ];

  /* Condiciones numéricas. step = redondeo del umbral para que
     salga un número "de titular" (120 goles, no 117).
     ───────────────────────────────────────────────────────────
     NO valen todas: una condición solo hace juego si el jugador puede
     razonarla mirando 21 nombres. Medido sobre 500 rondas reales, dos
     no lo cumplían y se retiraron:
       · ALTURA — el umbral salía entre 176 y 188 cm, mediana 182, o sea
         clavado en la mediana humana: era tirar 21 monedas. No hay ni un
         atajo mental, y la carta tampoco enseña la posición.
       · Nº DE CLUBES — umbral 4-8, mediana 6. Recordar un RECUENTO es
         mucho más débil que recordar un HECHO ("¿jugó en el Liverpool?"),
         y la carta no trae ningún dato de carrera.
     Las cuatro que quedan sí tienen atajo: delantero (goles),
     internacional fijo (internacionalidades), veterano (partidos). */
  const NUMERIC = [
    { id: 'goals',    label: n => `Han marcado más de ${n} goles oficiales`,        emoji: '⚽',  step: 10 },
    { id: 'apps',     label: n => `Han jugado más de ${n} partidos oficiales`,      emoji: '📋',  step: 25 },
    { id: 'caps',     label: n => `Tienen más de ${n} internacionalidades`,         emoji: '🏳️',  step: 5  },
    { id: 'natGoals', label: n => `Han marcado más de ${n} goles con su selección`, emoji: '🏆',  step: 2  },
  ];
  const NUMERIC_BY_ID = {};
  NUMERIC.forEach(n => { NUMERIC_BY_ID[n.id] = n; });

  /* ═══ 4. Evaluadores ════════════════════════════════════ */
  const FAMILIES = {
    club:      (c, arg) => c.teams.indexOf(arg) >= 0,
    league:    (c, arg) => { const s = LEAGUE_SETS[arg]; return s ? c.teams.some(t => s.has(t)) : false; },
    nat:       (c, arg) => c.nat === arg,
    continent: (c, arg) => { const s = CONTINENT_SETS[arg]; return s ? s.has(c.nat) : false; },
    pos:       (c, arg) => c.pos === arg,
    foot:      (c, arg) => c.foot === arg,
    num:       (c, arg, n) => Number(c[arg] || 0) > n,
    born:      (c, arg, n) => Number(c.birth || 0) < n,
  };

  /** ¿Esta carta cumple la condición? */
  function matches(card, cond) {
    if (!card || !cond) return false;
    const fn = FAMILIES[cond.key];
    return fn ? Boolean(fn(card, cond.arg, cond.num)) : false;
  }
  function countMatches(cards, cond) {
    let n = 0;
    for (const c of cards) if (matches(c, cond)) n++;
    return n;
  }

  /* Icono para el titular de la ronda */
  function condIcon(cond) {
    if (!cond) return null;
    switch (cond.key) {
      case 'club':      return { type: 'img',   value: clubBadge(cond.arg) };
      case 'league':    { const l = LEAGUES.find(x => x.id === cond.arg); return l ? { type: 'img', value: leagueLogo(l.logo) } : null; }
      case 'nat':       { const n = NATS.find(x => x.tm === cond.arg);    return n ? { type: 'img', value: flagUrl(n.flag) } : null; }
      case 'continent': { const c = CONTINENTS.find(x => x.id === cond.arg); return c ? { type: 'emoji', value: c.emoji } : null; }
      case 'pos':       { const p = POSITIONS.find(x => x.id === cond.arg);  return p ? { type: 'emoji', value: p.emoji } : null; }
      case 'foot':      return { type: 'emoji', value: '🦶' };
      case 'born':      return { type: 'emoji', value: '🎂' };
      case 'num':       { const d = NUMERIC_BY_ID[cond.arg]; return d ? { type: 'emoji', value: d.emoji } : null; }
      default:          return null;
    }
  }

  /* ═══ 5. Carga del pool ═════════════════════════════════ */
  /* Solo los rangos que cubren la lista de fama (ids < 800.000):
     ~780 KB comprimidos, y el service worker los comparte con
     Coche y En la Cadena, así que casi siempre vienen de caché. */
  const MAX_POOL_ID = 800000;
  const POOL_LIMIT  = 1500;

  let _pool = [];
  let _byId = Object.create(null);
  let _ready = false;
  let _promise = null;

  function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  /** Convierte una entrada de chunk en una carta, o null si le
   *  faltan datos para poder responder a las condiciones. */
  function _toCard(id, p) {
    if (!p || !p.n || !p.img) return null;
    const teams = Array.isArray(p.teams) ? p.teams.filter(Boolean) : [];
    if (!teams.length) return null;
    const pos = p.p;
    if (['GK', 'DEF', 'MID', 'FWD'].indexOf(pos) < 0) return null;
    if (!p.nat) return null;
    const foot = p.f;
    if (['Diestro', 'Zurdo', 'Ambidiestro'].indexOf(foot) < 0) return null;

    const birth = _num(p.b);
    if (!birth || birth < 1900) return null;
    const height = _num(p.h);
    if (!height || height < 140 || height > 220) return null;

    const apps = _num(p.apps);
    if (apps === null) return null;
    /* Los porteros no traen el campo goals (el scraper lo omite
       en vez de escribir 0). Para el resto, sin goles no hay
       carta: una condición de goles daría un total equivocado. */
    let goals = _num(p.goals);
    if (goals === null) { if (pos !== 'GK') return null; goals = 0; }

    const nt = (p.nt && typeof p.nt === 'object') ? p.nt : {};
    const caps = _num(nt.c) || 0;
    const natGoals = _num(nt.g) || 0;

    const club = p.club || teams[0];
    return {
      id: String(id),
      name: p.n,
      img: p.img,
      club,
      badge: clubBadge(club),
      teams,
      nat: p.nat,
      pos,
      foot,
      apps, goals, caps, natGoals,
      height: Math.round(height),
      clubs: teams.length,
      birth,
    };
  }

  /* Sin `no-cache`: los tres llamantes piden datos estaticos que ya van por
     api/data.js (CDN de Vercel). Ver js/supabase-config.js:fhDataUrl. */
  async function _fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
    return res.json();
  }

  /** Carga el pool. onProgress(0..1) para pintar la barra. */
  function load(onProgress) {
    if (_ready) return Promise.resolve(_pool);
    if (_promise) return _promise;

    _promise = (async () => {
      const meta = await _fetchJson(fhDataUrl('player-db', 'players/meta.json'));
      const ranges = (meta.ranges || []).filter(r => r.min < MAX_POOL_ID);
      if (!ranges.length) throw new Error('meta.json sin rangos utilizables');

      /* La lista de fama es opcional: si falla, el pool se ordena
         por un baremo propio y el juego sigue funcionando. */
      let fame = null;
      try {
        const raw = await _fetchJson(fhDataUrl('game-data', 'coche/gen_pool.json'));
        if (Array.isArray(raw) && raw.length) fame = raw.map(String);
      } catch (e) { console.warn('[Mentiroso] gen_pool.json no disponible, se usa baremo propio', e); }

      let done = 0;
      const total = ranges.length;
      const chunks = await Promise.all(ranges.map(async r => {
        const data = await _fetchJson(fhDataUrl('player-db', 'players/' + r.file));
        done++;
        if (onProgress) onProgress(done / total);
        return data;
      }));

      const all = Object.create(null);
      chunks.forEach(c => Object.assign(all, c));

      /* _byId lleva TODAS las cartas válidas de los chunks, no solo
         las del pool de reparto. Es a propósito: el anfitrión manda
         los IDs repartidos por Firebase y el resto de clientes los
         resuelven aquí. Si _byId fuese solo el pool de 1.500 y dos
         clientes lo recortasen distinto (p. ej. uno cargó la lista
         de fama y otro no), a alguien le faltaría una carta y
         contaría mal el total. Con el índice completo eso no puede
         pasar. */
      _byId = Object.create(null);
      for (const id in all) {
        const card = _toCard(id, all[id]);
        if (card) _byId[card.id] = card;
      }

      /* El pool de reparto sí es el recorte por fama: son las cartas
         que un jugador puede reconocer y valorar. */
      const cards = [];
      const taken = Object.create(null);
      if (fame) {
        for (const id of fame) {
          if (cards.length >= POOL_LIMIT) break;
          const c = _byId[String(id)];
          if (c && !taken[c.id]) { taken[c.id] = true; cards.push(c); }
        }
      }
      if (cards.length < 300) {
        /* Respaldo: los más reconocibles por partidos + goles +
           internacionalidades. Orden estable (por id) ante empates. */
        const rest = Object.keys(_byId).map(k => _byId[k]).filter(c => !taken[c.id]);
        rest.sort((a, b) => {
          const fa = a.apps + a.goals * 3 + a.caps * 4;
          const fb = b.apps + b.goals * 3 + b.caps * 4;
          return fb - fa || (Number(a.id) - Number(b.id));
        });
        for (const c of rest) {
          if (cards.length >= POOL_LIMIT) break;
          taken[c.id] = true; cards.push(c);
        }
      }

      if (cards.length < 60) throw new Error('Pool de cartas insuficiente (' + cards.length + ')');

      _pool = cards;
      _ready = true;
      if (onProgress) onProgress(1);
      return _pool;
    })().catch(err => { _promise = null; throw err; });

    return _promise;
  }

  /* ═══ 6. Reparto ════════════════════════════════════════ */
  /* Manos pequeñas y bastantes cartas comunes: el total de la
     mesa (18-22) es el techo de la puja, que es lo que hace que
     la escalada de apuestas tenga recorrido. */
  const HAND_CONFIG = [
    { max: 2, hand: 6, center: 6 },
    { max: 3, hand: 5, center: 5 },
    { max: 4, hand: 4, center: 5 },
    { max: 5, hand: 3, center: 6 },
    { max: 6, hand: 3, center: 4 },
    { max: 8, hand: 2, center: 6 },
  ];
  function handConfig(nPlayers) {
    return HAND_CONFIG.find(c => nPlayers <= c.max) || HAND_CONFIG[HAND_CONFIG.length - 1];
  }
  /**
   * Reparte una ronda. Solo lo llama quien abre la ronda
   * (anfitrión o práctica); el resultado viaja por Firebase como
   * IDs, así que no hace falta que sea reproducible en el resto
   * de clientes.
   * @returns {{hands:Object, center:string[], cards:Object[]}}
   */
  function deal(seed, seats) {
    if (!_ready) throw new Error('Pool no cargado');
    const rng = mulberry32(seed);
    const cfg = handConfig(seats.length);
    const need = cfg.center + seats.length * cfg.hand;
    const picked = shuffleRng(_pool, rng).slice(0, need);
    const hands = {};
    let i = 0;
    seats.forEach(pid => { hands[pid] = picked.slice(i, i + cfg.hand).map(c => c.id); i += cfg.hand; });
    const center = picked.slice(i).map(c => c.id);
    return { hands, center, cards: picked };
  }

  /** Resuelve IDs → cartas (las que no estén en el pool se omiten). */
  function cardsByIds(ids) {
    const out = [];
    (ids || []).forEach(id => { const c = _byId[String(id)]; if (c) out.push(c); });
    return out;
  }
  function card(id) { return _byId[String(id)] || null; }

  /* ═══ 7. Elección de condición ══════════════════════════ */
  function _quantile(sorted, frac) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(frac * (sorted.length - 1))))];
  }

  /** Todas las condiciones candidatas para este mazo. */
  function _candidates(cards) {
    const out = [];

    CLUBS.forEach(c => out.push({
      key: 'club', arg: c.tm, num: null,
      label: 'Han jugado en ' + c.name,
    }));

    LEAGUES.forEach(l => out.push({
      key: 'league', arg: l.id, num: null,
      label: 'Han jugado en ' + l.name,
    }));

    NATS.forEach(n => out.push({
      key: 'nat', arg: n.tm, num: null,
      label: 'Son ' + n.name,
    }));

    CONTINENTS.forEach(c => out.push({
      key: 'continent', arg: c.id, num: null,
      label: 'Son ' + c.name,
    }));

    POSITIONS.forEach(p => out.push({
      key: 'pos', arg: p.id, num: null,
      label: 'Son ' + p.name,
    }));

    FEET.forEach(f => out.push({
      key: 'foot', arg: f.id, num: null,
      label: 'Son ' + f.name,
    }));

    /* Numéricas: el umbral sale de los cuartiles del propio mazo,
       redondeado, para que el reparto entre "sí" y "no" quede
       repartido en vez de 0 o todas. */
    NUMERIC.forEach(def => {
      const vals = cards.map(c => Number(c[def.id] || 0)).sort((a, b) => a - b);
      const seen = new Set();
      [0.3, 0.5, 0.7].forEach(f => {
        const raw = _quantile(vals, f);
        let n = Math.round(raw / def.step) * def.step;
        if (n <= 0) n = def.step;
        if (seen.has(n)) return;
        seen.add(n);
        out.push({
          key: 'num', arg: def.id, num: n,
          label: def.label(n),
        });
      });
    });

    /* Año de nacimiento: umbral exacto, sin redondeo. */
    {
      const years = cards.map(c => Number(c.birth || 0)).sort((a, b) => a - b);
      const seen = new Set();
      [0.3, 0.5, 0.7].forEach(f => {
        const n = _quantile(years, f);
        if (!n || seen.has(n)) return;
        seen.add(n);
        out.push({ key: 'born', arg: 'birth', num: n, label: `Nacieron antes de ${n}` });
      });
    }

    return out;
  }

  /**
   * Elige la condición de la ronda.
   * @param {Object[]} cards  todas las cartas repartidas
   * @param {Function} rng
   * @param {string}   avoid  firma de la condición anterior (para no repetir)
   */
  function chooseCondition(cards, rng, avoid) {
    const n = cards.length;
    if (!n) return null;

    /* Banda buena: ni trivial (0 o todas) ni casi trivial. */
    const lo = Math.max(2, Math.round(n * 0.15));
    const hi = Math.max(lo + 1, Math.round(n * 0.65));

    const good = [], ok = [];
    _candidates(cards).forEach(cond => {
      if (avoid && condSignature(cond) === avoid) return;
      const m = countMatches(cards, cond);
      if (m < 1 || m >= n) return;
      cond._m = m;
      if (m >= lo && m <= hi) good.push(cond); else ok.push(cond);
    });

    const pool = good.length ? good : ok;
    if (!pool.length) return null;
    const cond = _pickBalanced(pool, rng);
    delete cond._m;
    return cond;
  }

  /** Sortea equilibrando condiciones numéricas y no numéricas. */
  function _pickBalanced(list, rng) {
    const nums = [], rest = [];
    list.forEach(c => ((c.key === 'num' || c.key === 'born') ? nums : rest).push(c));
    if (nums.length && rest.length) return pickRng(rng() < 0.6 ? rest : nums, rng);
    return pickRng(list, rng);
  }

  function condSignature(cond) {
    if (!cond) return '';
    return [cond.key, cond.arg, cond.num].join('|');
  }

  /* ═══ 8. API ════════════════════════════════════════════ */
  return {
    // datos
    load, ready: () => _ready, card, cardsByIds,
    // reparto
    deal,
    // condiciones
    chooseCondition, condSignature, matches, countMatches, condIcon,
    // rng compartido: game.js lo usa para elegir la condición de la ronda
    mulberry32,
  };
})();

if (typeof window !== 'undefined') window.MDeck = MDeck;
