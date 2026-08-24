/* =============================================================================
   FUTBOL-RESTRICTIONS.JS  —  Motor compartido de restricciones de futbol
   -----------------------------------------------------------------------------
   Extraido de coche/js/script.js para poder reutilizarlo en Coche y en
   Tres en Raya (y futuros juegos). Expone window.FR con:

     FR.init()                      -> Promise, carga datos (chunks + mapas)
     FR.ready                       -> Promise que resuelve tras init()
     FR.validate(player, r)         -> bool: el jugador cumple la restriccion r
     FR.isRedundant(rA, rB)         -> bool: rA hace redundante/imposible a rB
     FR.familyUsed(list, cand, idx) -> bool: ya hay una restriccion de esa familia
     FR.buildCandidates(rng, opts)  -> [restriccion...] pool mezclado
     FR.countMatching(r, pool, min) -> nº de jugadores que cumplen r (early-exit)
     FR.countMatchingPair(a,b,pool,min) -> nº que cumplen a Y b
     FR.resolvePlayer(name)         -> Promise<player|null> (por name-index)
     FR.resolvePlayerById(id)       -> Promise<player|null> (por id; homonimos)
     FR.suggest(input, limit, opts) -> [meta] autocompletado (opts.filter(meta))
     FR.playerMeta(id, name)        -> {id,name,club,position,nationalTeam,...}
     FR.normalize(s), FR.acNorm(s), FR.acTight(s)
     FR.rng.mulberry32/shuffle/weightedShuffle
     FR.genPool / FR.playersDb / FR.nameIndex   (getters)
     FR.CLUBS_LIST, FR.NATIONALITIES, ...        (constantes)

   Requiere que js/supabase-config.js este cargado antes (usa sbStorageUrl).
   Los datos de restriccion (entrenados_por, ganadores, companeros, perf_stats,
   gen_pool) viven en game-data/general/; se lee de ahi con respaldo a
   game-data/coche/ para no romper mientras no se haya subido la copia general.
   ============================================================================= */
'use strict';

window.FR = (function () {

  /* ─────────────────── Normalizacion de texto ─────────────────── */
  function acNorm(s) {
    return String(s || '').toLowerCase()
      .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/['\u2018\u2019\u00b4`\u02bc]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function acTight(s) { return acNorm(s).replace(/ /g, ''); }

  const _normCache = new Map();
  function normalize(str) {
    if (!str) return '';
    const key = String(str);
    const cached = _normCache.get(key);
    if (cached !== undefined) return cached;
    const out = key.toLowerCase()
      .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim();
    _normCache.set(key, out);
    return out;
  }
  function _normFoot(f) {
    if (!f) return null;
    const fl = f.toLowerCase();
    if (fl.includes('zurdo'))   return 'left';
    if (fl.includes('ambi'))    return 'both';
    if (fl.includes('diestro')) return 'right';
    return null;
  }

  /* ─────────────────── RNG determinista ─────────────────── */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function weightedShuffle(items, weightFn, rng) {
    const pool = items.map(it => ({ it, w: Math.max(weightFn(it), 1e-6) }));
    const order = [];
    while (pool.length) {
      const total = pool.reduce((s, p) => s + p.w, 0);
      let r = rng() * total;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        r -= pool[i].w;
        if (r <= 0) { idx = i; break; }
      }
      order.push(pool[idx].it);
      pool.splice(idx, 1);
    }
    return order;
  }

  function _logoUrl(tmName) {
    return sbStorageUrl('team-logos', tmName.replace(/ /g, '_') + '.png');
  }

  /* ═══════════════════ CONSTANTES (clubes, ligas, trofeos…) ═══════════════════ */
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
    { tmName:'CA Boca Juniors',      display:'Boca Juniors',   league:'Liga Argentina' },
    { tmName:'CA River Plate',       display:'River Plate',    league:'Liga Argentina' },
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
    { tmName:'Feyenoord Rotterdam',  display:'Feyenoord',      league:'Eredivisie' },
    { tmName:'Newcastle United',     display:'Newcastle',      league:'Premier League' },
    { tmName:'CR Flamengo',          display:'Flamengo',       league:'Brasileirão' },
  ].map(c => ({ ...c, logoUrl: _logoUrl(c.tmName) }));

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
    'Primeira Liga': [
      'SL Benfica','FC Porto','Sporting CP','SC Braga','Vitória Guimarães SC',
      'Rio Ave FC','GD Estoril Praia','FC Famalicão','Moreirense FC','Boavista FC',
      'Gil Vicente FC','CS Marítimo','FC Paços de Ferreira',
    ],
    'Eredivisie': [
      'Ajax Amsterdam','PSV Eindhoven','Feyenoord Rotterdam','AZ Alkmaar','FC Twente Enschede',
      'Vitesse Arnhem','SC Heerenveen','FC Utrecht','FC Groningen','Sparta Rotterdam',
      'Willem II Tilburg','NEC Nijmegen','Go Ahead Eagles','Heracles Almelo','PEC Zwolle',
    ],
    'Süper Lig': [
      'Galatasaray','Fenerbahce','Fenerbahçe','Besiktas JK','Trabzonspor','Basaksehir FK',
      'Bursaspor','Fatih Karagümrük','Kayserispor','Caykur Rizespor','Kasimpasa',
      'Antalyaspor','Sivasspor','Alanyaspor','Konyaspor','Göztepe','MKE Ankaragücü',
    ],
  };

  const LEAGUE_CIDS = {
    'La Liga':'ES1', 'Premier League':'GB1', 'Serie A':'IT1', 'Bundesliga':'L1',
    'Ligue 1':'FR1', 'Eredivisie':'NL1', 'Primeira Liga':'PO1', 'Süper Lig':'TR1',
    'Brasileirão':'BRA1', 'Liga Argentina':'ARG1',
  };
  const LEAGUE_LOGOS = {
    'La Liga':        sbStorageUrl('league-logos', 'LaLiga.png'),
    'Premier League': sbStorageUrl('league-logos', 'PremierLeague.png'),
    'Serie A':        sbStorageUrl('league-logos', 'SerieA.png'),
    'Bundesliga':     sbStorageUrl('league-logos', 'Bundesliga.png'),
    'Ligue 1':        sbStorageUrl('league-logos', 'Ligue1.png'),
    'Eredivisie':     sbStorageUrl('league-logos', 'Eredivisie.png'),
    'Primeira Liga':  sbStorageUrl('league-logos', 'PrimeiraLiga.png'),
    'Süper Lig':      sbStorageUrl('league-logos', 'SuperLig.png'),
    'Brasileirão':    sbStorageUrl('league-logos', 'Brasileirao.png'),
    'Liga Argentina': sbStorageUrl('league-logos', 'LigaArgentina.png'),
  };

  const NATIONALITIES = [
    { tmNat:'Spain',       display:'España',    adj:'Español',    flag:'🇪🇸', flagImg:sbStorageUrl('team-flags','es.png') },
    { tmNat:'England',     display:'Inglaterra', adj:'Inglés',    flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', flagImg:sbStorageUrl('team-flags','eng.png') },
    { tmNat:'France',      display:'Francia',   adj:'Francés',   flag:'🇫🇷', flagImg:sbStorageUrl('team-flags','fr.png') },
    { tmNat:'Argentina',   display:'Argentina', adj:'Argentino', flag:'🇦🇷', flagImg:sbStorageUrl('team-flags','ar.png') },
    { tmNat:'Germany',     display:'Alemania',  adj:'Alemán',    flag:'🇩🇪', flagImg:sbStorageUrl('team-flags','de.png') },
    { tmNat:'Brazil',      display:'Brasil',    adj:'Brasileño', flag:'🇧🇷', flagImg:sbStorageUrl('team-flags','br.png') },
    { tmNat:'Netherlands', display:'Holanda',   adj:'Holandés',  flag:'🇳🇱', flagImg:sbStorageUrl('team-flags','nl.png') },
    { tmNat:'Italy',       display:'Italia',    adj:'Italiano',   flag:'🇮🇹', flagImg:sbStorageUrl('team-flags','it.png') },
    { tmNat:'Uruguay',     display:'Uruguay',   adj:'Uruguayo',   flag:'🇺🇾', flagImg:sbStorageUrl('team-flags','uy.png') },
    { tmNat:'Senegal',     display:'Senegal',   adj:'Senegalés',  flag:'🇸🇳', flagImg:sbStorageUrl('team-flags','sn.png') },
    { tmNat:'Cameroon',    display:'Camerún',   adj:'Camerunés',  flag:'🇨🇲', flagImg:sbStorageUrl('team-flags','cm.png') },
    { tmNat:'Morocco',     display:'Marruecos', adj:'Marroquí',   flag:'🇲🇦', flagImg:sbStorageUrl('team-flags','ma.png') },
    { tmNat:'Japan',       display:'Japón',     adj:'Japonés',    flag:'🇯🇵', flagImg:sbStorageUrl('team-flags','jp.png') },
    /* Ampliacion 2026-08-19: de 13 a 23 nacionalidades. Todas tienen >=67
       jugadores en data/players/chunks (el liston lo marcaba Japon con 49) y
       bandera en el bucket team-flags. Van AL FINAL para no mover el orden de
       las 13 de siempre. Esta lista esta duplicada en tres sitios
       (js/futbol-restrictions.js, coche/js/script.js y
       coche/js/restrictions-worker.js): si divergen, dos jugadores de la misma
       sala de Coche generan rejillas distintas con la misma semilla. */
    { tmNat:'Portugal', display:'Portugal', adj:'Portugués', flag:'🇵🇹', flagImg:sbStorageUrl('team-flags','pt.png') },
    { tmNat:'Belgium', display:'Bélgica', adj:'Belga', flag:'🇧🇪', flagImg:sbStorageUrl('team-flags','be.png') },
    { tmNat:'Croatia', display:'Croacia', adj:'Croata', flag:'🇭🇷', flagImg:sbStorageUrl('team-flags','hr.png') },
    { tmNat:'Serbia', display:'Serbia', adj:'Serbio', flag:'🇷🇸', flagImg:sbStorageUrl('team-flags','rs.png') },
    { tmNat:'Denmark', display:'Dinamarca', adj:'Danés', flag:'🇩🇰', flagImg:sbStorageUrl('team-flags','dk.png') },
    { tmNat:'Colombia', display:'Colombia', adj:'Colombiano', flag:'🇨🇴', flagImg:sbStorageUrl('team-flags','co.png') },
    { tmNat:'Mexico', display:'México', adj:'Mexicano', flag:'🇲🇽', flagImg:sbStorageUrl('team-flags','mx.png') },
    { tmNat:'United States', display:'Estados Unidos', adj:'Estadounidense', flag:'🇺🇸', flagImg:sbStorageUrl('team-flags','us.png') },
    { tmNat:'Nigeria', display:'Nigeria', adj:'Nigeriano', flag:'🇳🇬', flagImg:sbStorageUrl('team-flags','ng.png') },
    { tmNat:'Ivory Coast', display:'Costa de Marfil', adj:'Marfileño', flag:'🇨🇮', flagImg:sbStorageUrl('team-flags','ci.png') },
  ];

  const CONTINENT_LOGOS = {
    europeo:   sbStorageUrl('league-logos', 'Europe.png'),
    americano: sbStorageUrl('league-logos', 'Americas.png'),
    africano:  sbStorageUrl('league-logos', 'Africa.png'),
    asiatico:  sbStorageUrl('league-logos', 'Asia.png'),
  };
  const CONTINENT_NAT = {
    europeo:    ['Spain','England','France','Germany','Netherlands','Portugal','Italy',
                 'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
                 'Czech Republic','Czech','Switzerland','Austria','Turkey','Türkiye','Turkiye','Czechia','Republic of Ireland','Israel','Belarus','Greece','Hungary',
                 'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
                 'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
                 'Ireland','Georgia','Kosovo','North Macedonia','North','Bulgaria','Cyprus','Latvia',
                 'Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar',
                 'Faroe','Faroe Islands'],
    americano:  ['Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
                 'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
                 'Trinidad and Tobago','Curaçao','Suriname','Guadeloupe','Martinique','Montserrat','Puerto Rico','Honduras','Costa Rica','Costa','Panama','Guatemala',
                 'El Salvador','Cuba','Dominican Republic','Canada','Haiti'],
    africano:   ['Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cote','Cameroon',
                 'Morocco','Egypt','Algeria','Tunisia','South Africa','South','Mali','Guinea',
                 'Burkina Faso','DR Congo','DR','Congo','Democratic Republic of the Congo','Republic of the Congo','Togo','Gabon',
                 'Equatorial Guinea','Equatorial','Zimbabwe','Kenya','Cape Verde','Cape','Sierra Leone',
                 'Liberia','Gambia','The','Guinea-Bissau','The Gambia','Rwanda','Ethiopia','Tanzania',
                 'Zambia','Uganda','Angola','Mauritius','Mozambique','Madagascar',
                 'Benin','Niger','Chad','Sudan','South Sudan','Somalia','Eritrea',
                 'Djibouti','Comoros','Lesotho','Botswana','Namibia','Malawi',
                 'Eswatini','Libya','Mauritania','Central African Republic'],
    asiatico:   ['Japan','South Korea','Iran','Saudi Arabia','Saudi','Qatar','UAE','Australia',
                 'China','Iraq','Jordan','Bahrain','Kuwait','Uzbekistan','Vietnam',
                 'Thailand','Indonesia','Philippines','India','Pakistan','Bangladesh',
                 'North Korea','Hong Kong','Malaysia','Oman','Lebanon','Palestine','Syria',
                 'New','New Zealand'],
  };

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
    /* Entrenador nuevo: hay que dejar su foto en coche/data/coaches/<id>.png y
       subirla con admin/upload_images_to_storage.py coach-photos. Si por lo que
       sea todavia no la tiene, marcalo `photo:false` y saldra con imgUrl null:
       aqui se pinta el emoji y Tres en Raya y Bingo, que filtran por imgUrl, no
       lo ofrecen — mejor eso que una imagen rota en una casilla de 70px. */
    { name:'Thomas Tuchel',       id:'7471', icon:'🎽' },
    { name:'Mauricio Pochettino', id:'9044', icon:'🎽' },
  ];

  /* Compañeros para "Compañero de X". Se rellena en init() desde
     companeros_principal.json (227 jugadores curados) en vez de estar escrita
     a mano: antes eran 38 nombres fijos, asi que Lamela, Areola o Lingard no
     podian salir NUNCA aunque estuvieran en la base con 500 companeros cada
     uno. Se rellena EN SITIO (length=0 + push) y no por reasignacion, porque
     el objeto FR exporta esta misma referencia.
     Nombre corto solo para los que ya lo tenian curado; el resto sale con su
     nombre completo, que se lee igual de bien y evita abreviaturas ambiguas
     (hay dos Thiago y tres Danilo en la base). */
  const TEAMMATE_DISPLAY = {
    '28003':'Messi',    '132098':'Kane',      '3979':'Casillas',  '342229':'Mbappé',
    '45320':'Di María', '48280':'Cavani',     '7825':'Reina',     '17259':'Neuer',
    '58358':'Müller',   '35207':'Reus',       '5817':'Pirlo',     '406625':'Lautaro',
    '4673':'Sneijder',  '288230':'Dembélé',   '27992':'Modric',   '26399':'Agüero',
    '88755':'De Bruyne','3455':'Ibrahimovic', '5023':'Buffon',    '3111':'Zidane',
    '164770':'Varane',  '148455':'Salah',     '225083':'Kanté',   '4360':'Robben',
    '7767':'Torres',    '5958':'Totti',
  };
  const TEAMMATES_LIST = [];
  function _fillTeammates(companeros) {
    TEAMMATES_LIST.length = 0;
    for (const [id, pd] of Object.entries(companeros)) {
      TEAMMATES_LIST.push({ name: pd.name, display: TEAMMATE_DISPLAY[id] || pd.name, id, icon: '⚽' });
    }
  }

  const SCORER_TROPHIES = new Set([
    'Pichichi La Liga','Bota de Oro Premier League','Capocannoniere Serie A',
    'Maximo Goleador Bundesliga','Maximo Goleador Ligue 1',
    'Bota de Oro Mundial','Bota de Oro Europea',
  ]);
  const NATIONAL_TROPHIES = new Set(['Eurocopa','Mundial','Copa America']);

  /* ═══════════════════ ESTADO DE DATOS ═══════════════════ */
  let PLAYERS_DB = [];
  let GEN_POOL   = [];
  let NAME_INDEX = [];
  let _TROPHY_MAP         = {};
  let _COACH_MAP          = {};
  let _TEAMMATE_MAP       = {};
  let _REVERSE_TEAMMATE   = {};
  let _REVERSE_TEAMMATE_IDS = {};
  let _PERF_MAP           = {};
  let _chunkCache      = {};
  let _playerDataCache = {};
  let _readyPromise = null;
  /* Todos los chunks ya cargados, indexados por id (id -> chunk crudo). Lo
     rellena _loadData y permite mirar club/posicion/mv de cualquier jugador
     SIN volver a pedir nada, que es lo que necesitan el autocompletado
     filtrado y resolveById. */
  let ALL_CHUNKS = {};

  const _CHUNK_RANGES = [
    [0,99999],[100000,199999],[200000,299999],[300000,399999],[400000,499999],
    [500000,599999],[600000,699999],[700000,799999],[800000,899999],[900000,999999],
    [1000000,1099999],[1100000,1199999],[1200000,1299999],[1300000,1399999],[1400000,1499999]
  ];
  const _CHUNK_NAMES = _CHUNK_RANGES.map(([lo,hi]) => `${lo}-${hi}`);
  function _chunkFileForId(id) {
    const n = parseInt(id);
    const r = _CHUNK_RANGES.find(([lo,hi]) => n >= lo && n <= hi);
    return r ? `${r[0]}-${r[1]}` : null;
  }

  async function _fetchChunkRange(name) {
    try {
      const res = await fetch(sbStorageUrl('player-db', `players/chunks/${name}.json`), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { console.warn('[FR] Error cargando jugadores:', e); return null; }
  }
  async function _fetchLeagues() {
    try {
      const res = await fetch(sbStorageUrl('player-db', 'leagues/league-teams.json'), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { console.warn('[FR] Error cargando ligas:', e); return null; }
  }
  /* Datos de restriccion: general/ con respaldo a coche/ (mientras se sube la
     copia general a Supabase, sigue leyendo la de coche sin romper nada). */
  async function _fetchGeneralJsonFile(name) {
    for (const prefix of ['general', 'coche']) {
      try {
        const res = await fetch(sbStorageUrl('game-data', `${prefix}/${name}`), { cache: 'no-cache' });
        if (res.ok) return await res.json();
      } catch (e) { /* siguiente prefijo */ }
    }
    console.warn(`[FR] No se pudo cargar ${name} (general ni coche)`);
    return {};
  }

  async function _getChunkData(id) {
    const sid = String(id);
    if (_playerDataCache[sid]) return _playerDataCache[sid];
    const cf = _chunkFileForId(id);
    if (!cf) return null;
    if (!_chunkCache[cf] || (!_chunkCache[cf][sid] && !_chunkCache[cf].__full)) {
      const full = await _fetchChunkRange(cf);
      if (!full) return null;
      full.__full = true;
      _chunkCache[cf] = full;
    }
    _playerDataCache[sid] = _chunkCache[cf]?.[sid] || null;
    return _playerDataCache[sid];
  }

  function _maxFee(transfers) {
    if (!transfers || !transfers.length) return 0;
    return Math.max(...transfers.map(t => parseInt(t.fee || '0', 10) || 0));
  }

  function _buildPlayerFromChunk(id, chunk) {
    if (!chunk) return null;
    const sid = String(id);
    return {
      id: sid,
      name: chunk.n || '?',
      img: chunk.img || null,
      aliases: [],
      teammates: _TEAMMATE_MAP[sid] || [],
      coaches:   _COACH_MAP[sid]    || [],
      trophies:  [...new Set(_TROPHY_MAP[sid] || [])],
      nationalTeam: chunk.nat || null,
      teams: chunk.teams || [],
      heightCm: chunk.h ? parseFloat(chunk.h) : null,
      foot: _normFoot(chunk.f),
      birthYear: chunk.b ? parseInt(chunk.b, 10) : null,
      goals: typeof chunk.goals === 'number' ? chunk.goals : null,
      apps:  typeof chunk.apps  === 'number' ? chunk.apps  : null,
      position: chunk.p || null,
      posDetail: chunk.pf || null,
      caps: chunk.nt ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0,
      natGoals: (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0,
      maxFee: _maxFee(chunk.tr || []),
      mv:   typeof chunk.mv === 'number' ? chunk.mv : (parseInt(chunk.mv, 10) || 0),
      club: chunk.club || null,
      lg:  _PERF_MAP[sid]?.lg  || [],
      clg: _PERF_MAP[sid]?.clg || 0,
      bsg: _PERF_MAP[sid]?.bsg || 0,
    };
  }

  /* Resuelve un jugador escrito por el usuario (por name-index, enriquecido
     con el chunk). Equivalente a findPlayerAsync de Coche. */
  async function resolvePlayer(inputName) {
    const n  = acNorm(inputName);
    const nt = acTight(inputName);
    if (!n) return null;
    const sameName = (a) => acNorm(a) === n || (nt && acTight(a) === nt);

    const matches = PLAYERS_DB.filter(p => sameName(p.name) || (p.aliases||[]).some(a => sameName(a)));
    const inDB = matches.length === 1 ? matches[0]
      : matches.length > 1 ? (matches.find(p => (p.teammates||[]).length > 0) || matches[0])
      : null;

    let chunkId = inDB ? inDB.id : null;
    if (!chunkId) {
      const entry = NAME_INDEX.find(([, name]) => sameName(name));
      if (!entry) return null;
      chunkId = String(entry[0]);
    }
    const chunk = await _getChunkData(chunkId);

    if (inDB) {
      if (chunk) {
        inDB.img = inDB.img || chunk.img || null;
        inDB.teams = chunk.teams || [];
        inDB.heightCm = chunk.h ? parseFloat(chunk.h) : null;
        inDB.foot = _normFoot(chunk.f);
        inDB.birthYear = chunk.b ? parseInt(chunk.b, 10) : null;
        inDB.goals = typeof chunk.goals === 'number' ? chunk.goals : null;
        inDB.apps  = typeof chunk.apps  === 'number' ? chunk.apps  : null;
        inDB.position = chunk.p || null;
        inDB.posDetail = chunk.pf || null;
        inDB.nationalTeam = chunk.nat || null;
        inDB.caps = chunk.nt ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0;
        inDB.natGoals = (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0;
        inDB.maxFee = _maxFee(chunk.tr || []);
        inDB.mv   = typeof chunk.mv === 'number' ? chunk.mv : (parseInt(chunk.mv, 10) || 0);
        inDB.club = chunk.club || null;
      }
      const mapTrophies = _TROPHY_MAP[inDB.id] || [];
      if (mapTrophies.length) inDB.trophies = [...new Set([...(inDB.trophies||[]), ...mapTrophies])];
      return inDB;
    }
    return _buildPlayerFromChunk(chunkId, chunk);
  }

  /* Resuelve por ID, no por nombre. Es lo que debe usar un juego cuando el
     jugador viene ELEGIDO de la lista del autocompletado: hay homonimos
     (dos "Koke", dos "Rodri"...) y resolver por texto siempre devuelve al
     mismo, asi que el jugador que el usuario habia pinchado no llegaba nunca.
     Mismo criterio que guess() en La Carrera. */
  async function resolvePlayerById(id) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const inDB = PLAYERS_DB.find(p => String(p.id) === sid);
    const chunk = ALL_CHUNKS[sid] || await _getChunkData(sid);
    if (!inDB) return _buildPlayerFromChunk(sid, chunk);
    if (chunk) {
      inDB.img = inDB.img || chunk.img || null;
      inDB.teams = chunk.teams || [];
      inDB.heightCm = chunk.h ? parseFloat(chunk.h) : null;
      inDB.foot = _normFoot(chunk.f);
      inDB.birthYear = chunk.b ? parseInt(chunk.b, 10) : null;
      inDB.goals = typeof chunk.goals === 'number' ? chunk.goals : null;
      inDB.apps  = typeof chunk.apps  === 'number' ? chunk.apps  : null;
      inDB.position = chunk.p || null;
      inDB.posDetail = chunk.pf || null;
      inDB.nationalTeam = chunk.nat || null;
      inDB.caps = chunk.nt ? (parseInt(chunk.nt.c ?? 0, 10) || 0) : 0;
      inDB.natGoals = (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0;
      inDB.maxFee = _maxFee(chunk.tr || []);
      inDB.mv   = typeof chunk.mv === 'number' ? chunk.mv : (parseInt(chunk.mv, 10) || 0);
      inDB.club = chunk.club || null;
    }
    return inDB;
  }

  /* Ficha ligera de un id para el autocompletado: lo justo para filtrar
     (¿esta en activo?) y para desambiguar homonimos en la lista. */
  function playerMeta(id, name, inDB) {
    const sid = String(id);
    const c = ALL_CHUNKS[sid] || null;
    return {
      id: sid,
      name: name || (c && c.n) || '?',
      inDB: !!inDB,
      hasData: !!c,
      club: (c && c.club) || null,
      position: (c && c.p) || null,
      nationalTeam: (c && c.nat) || null,
      birthYear: (c && c.b) ? parseInt(c.b, 10) : null,
      mv: c ? (typeof c.mv === 'number' ? c.mv : (parseInt(c.mv, 10) || 0)) : 0,
    };
  }

  /* Todos los jugadores del chunk como objetos completos (mv, club, posicion,
     stats…). Se construye una sola vez y se cachea. Lo usa Superdraft para
     validar en generacion que cada dia tiene solucion (semantica club actual). */
  let _ALL_PLAYERS = null;
  function getAllPlayers() {
    if (_ALL_PLAYERS) return _ALL_PLAYERS;
    const out = [];
    for (const cf of Object.keys(_chunkCache)) {
      const data = _chunkCache[cf];
      if (!data) continue;
      for (const id of Object.keys(data)) {
        if (id === '__full') continue;
        const p = _buildPlayerFromChunk(id, data[id]);
        if (p) out.push(p);
      }
    }
    _ALL_PLAYERS = out;
    return out;
  }

  /* Calidad de la coincidencia (0 = mejor). Sin esto el orden lo decidía el
     orden de los datos: escribiendo "Diego" salían antes todos los "Diego
     ..." de la base curada y el propio Diego no aparecía nunca, porque los
     de la base se metían primero y llenaban el hueco. */
  function _matchScore(n, norm) {                           // n ya viene normalizado
    if (n === norm) return 0;                               // el nombre exacto
    if (n.startsWith(norm + ' ')) return 1;                 // primera palabra completa
    const words = n.split(' ');
    if (words.some(w => w === norm)) return 2;              // una palabra exacta
    if (n.startsWith(norm)) return 3;                       // empieza igual
    if (words.some(w => w.startsWith(norm))) return 4;      // alguna palabra empieza igual
    return 5;                                               // aparece por dentro
  }

  /* Autocompletado: PLAYERS_DB + name-index, ordenado por calidad de
     coincidencia y, a igualdad, dando preferencia a los jugadores de la base
     curada (los reconocibles) y al nombre más corto. */
  /* opts.filter(meta) -> bool: deja pasar solo los jugadores que quiera el
     juego (Superdraft lo usa para no sugerir retirados). Cada resultado lleva
     ya club/posicion/nacion/año, que sirven para desambiguar homonimos. */
  function suggest(input, limit = 8, opts = {}) {
    const norm = normalize(input);
    if (!norm || norm.length < 2) return [];
    const PER_BUCKET = 40;
    const buckets = [[], [], [], [], [], []];
    const seen = new Set();
    const filter = typeof opts.filter === 'function' ? opts.filter : null;

    const add = (id, name, inDB, score) => {
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      const meta = playerMeta(key, name, inDB);
      if (filter && !filter(meta)) return;
      const b = buckets[score];
      if (b.length < PER_BUCKET) b.push(meta);
    };

    for (const p of PLAYERS_DB) {
      const n = normalize(p.name);
      let s = n.includes(norm) ? _matchScore(n, norm) : 99;
      /* Los alias ("Kun Agüero") también puntúan, pero se muestra el nombre. */
      for (const a of (p.aliases || [])) {
        const na = normalize(a);
        if (na.includes(norm)) s = Math.min(s, _matchScore(na, norm));
      }
      if (s <= 5) add(p.id, p.name, true, s);
    }
    for (const [id, name] of NAME_INDEX) {
      if (seen.has(String(id))) continue;
      const n = normalize(name);
      if (!n.includes(norm)) continue;
      add(id, name, false, _matchScore(n, norm));
    }

    const out = [];
    for (const b of buckets) {
      b.sort((a, c) => (a.inDB === c.inDB ? a.name.length - c.name.length : (a.inDB ? -1 : 1)));
      for (const it of b) { if (out.length < limit) out.push(it); }
      if (out.length >= limit) break;
    }
    return out;
  }

  /* ═══════════════════ CARGA ═══════════════════ */
  async function _loadData() {
    const metaPromises = [
      _fetchGeneralJsonFile('companeros_principal.json'),
      _fetchGeneralJsonFile('entrenados_por.json'),
      _fetchGeneralJsonFile('ganadores_clubes_internacional.json'),
      _fetchGeneralJsonFile('ganadores_seleccion.json'),
      _fetchGeneralJsonFile('GanadoresLigayCopa.json'),
      _fetchGeneralJsonFile('premios_individuales.json'),
      _fetchLeagues(),
      _fetchGeneralJsonFile('perf_stats.json'),
      _fetchGeneralJsonFile('gen_pool.json'),
    ];
    const chunkPromises = _CHUNK_NAMES.map(c =>
      _fetchChunkRange(c).then(data => ({ name:c, data })).catch(() => ({ name:c, data:null }))
    );
    const [metaResults, chunkResults] = await Promise.all([
      Promise.all(metaPromises), Promise.all(chunkPromises),
    ]);
    const [companeros, entrenados, clubInt, seleccion, ligaCopa, premios, leagueData, perfStats, genPool] = metaResults;

    _PERF_MAP = perfStats && !Array.isArray(perfStats) ? perfStats : {};

    const allChunkData = {};
    for (const { name:c, data } of chunkResults) {
      if (!data) continue;
      data.__full = true;
      _chunkCache[c] = data;
      for (const [id, pdata] of Object.entries(data)) {
        if (id === '__full') continue;
        allChunkData[id] = pdata;
      }
    }
    ALL_CHUNKS = allChunkData;
    console.log(`✅ [FR] Chunks cargados: ${Object.keys(allChunkData).length} jugadores`);

    NAME_INDEX = Object.entries(allChunkData).map(([id, p]) => [parseInt(id, 10), p.n]);

    const nameMap = {};
    for (const [id, name] of NAME_INDEX) nameMap[String(id)] = name;
    for (const [id, pd] of Object.entries(companeros)) nameMap[id] = pd.name;

    const trophyMap = {};
    const allWinners = { ...clubInt, ...seleccion, ...ligaCopa, ...premios };
    for (const [trophy, pids] of Object.entries(allWinners)) {
      for (const pid of pids) {
        const id = String(pid);
        (trophyMap[id] = trophyMap[id] || []).push(trophy);
      }
    }
    _TROPHY_MAP = trophyMap;

    const coachMap = {};
    for (const coachData of Object.values(entrenados)) {
      for (const pid of coachData.players) {
        const id = String(pid);
        (coachMap[id] = coachMap[id] || []).push(coachData.name);
      }
    }
    _COACH_MAP = coachMap;

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

    const _norm = s => String(s||'').toLowerCase()
      .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ').trim();
    const reverseMap = {};
    for (const [id, names] of Object.entries(teammateMap)) {
      const ownerName = nameMap[id];
      if (!ownerName) continue;
      const ownerNorm = _norm(ownerName);
      if (!reverseMap[ownerNorm]) reverseMap[ownerNorm] = new Set();
      for (const tName of names) reverseMap[ownerNorm].add(_norm(tName));
    }
    _REVERSE_TEAMMATE = reverseMap;

    const reverseIdMap = {};
    for (const [id, pd] of Object.entries(companeros)) {
      const ownerName = nameMap[id];
      if (!ownerName) continue;
      const ownerNorm = _norm(ownerName);
      if (!reverseIdMap[ownerNorm]) reverseIdMap[ownerNorm] = new Set();
      for (const tid of pd.teammates || []) reverseIdMap[ownerNorm].add(String(tid));
    }
    _REVERSE_TEAMMATE_IDS = reverseIdMap;

    const _mkPlayer = (id, name) => {
      const chunk = allChunkData[id] || {};
      const ps = _PERF_MAP[id] || {};
      return {
        id, idNum: parseInt(id, 10),
        name: name || chunk.n || '?',
        img: chunk.img || null,
        aliases: [],
        teammates: teammateMap[id] || [],
        coaches:   coachMap[id]    || [],
        trophies:  [...new Set(trophyMap[id] || [])],
        nationalTeam: chunk.nat || null,
        teams: chunk.teams || [],
        heightCm: chunk.h ? parseFloat(chunk.h) : null,
        foot: _normFoot(chunk.f),
        birthYear: chunk.b ? parseInt(chunk.b, 10) : null,
        goals: typeof chunk.goals === 'number' ? chunk.goals : null,
        apps:  typeof chunk.apps  === 'number' ? chunk.apps  : null,
        position: chunk.p || null,
        posDetail: chunk.pf || null,
        caps: chunk.nt ? (parseInt((chunk.nt.c !== undefined ? chunk.nt.c : chunk.nt) || '0', 10) || 0) : 0,
        natGoals: (chunk.nt && typeof chunk.nt === 'object') ? (parseInt(chunk.nt.g ?? 0, 10) || 0) : 0,
        maxFee: _maxFee(chunk.tr || []),
        mv:   typeof chunk.mv === 'number' ? chunk.mv : (parseInt(chunk.mv, 10) || 0),
        club: chunk.club || null,
        lg: ps.lg || [], clg: ps.clg || 0, bsg: ps.bsg || 0,
      };
    };

    PLAYERS_DB = Object.entries(companeros).map(([id, pd]) => _mkPlayer(id, pd.name));

    /* Los 227 curados pasan a ser candidatos de "Compañero de X" (antes 38
       escritos a mano). Afecta a Tres en Raya y a Bingo, que es de donde
       sacan sus cabeceras y sus casillas. */
    _fillTeammates(companeros);

    const poolIds = (Array.isArray(genPool) && genPool.length)
      ? genPool.map(String) : Object.keys(companeros);
    GEN_POOL = poolIds.filter(id => allChunkData[id]).map(id => _mkPlayer(id, nameMap[id]));
  }

  function init() {
    if (!_readyPromise) _readyPromise = _loadData();
    return _readyPromise;
  }

  /* ═══════════════════ VALIDACION ═══════════════════ */
  function validate(player, r) {
    if (!player || !r) return false;
    switch (r.type) {
      case 'club':
        return (player.teams || []).some(c => normalize(c) === normalize(r.value));
      case 'nationality':
        return normalize(player.nationalTeam || '') === normalize(r.value);
      case 'league':
        if (r.cid) {
          if ((player.lg || []).includes(r.cid)) return true;
          if ((player.lg || []).length) return false;
        }
        return (player.teams || []).some(t => (r.teams || []).some(lt => normalize(lt) === normalize(t)));
      case 'league_any':
        return (r.value || []).some(cid => (player.lg || []).includes(cid));
      case 'trophy':
        return (player.trophies || []).includes(r.value);
      case 'trophy_any':
        return (r.value || []).some(tv => (player.trophies || []).includes(tv));
      case 'coach':
        return (player.coaches || []).some(c => normalize(c) === normalize(r.value));
      case 'teammate': {
        const targetNorm = normalize(r.value);
        if ((player.teammates || []).some(t => normalize(t) === targetNorm)) return true;
        if (_REVERSE_TEAMMATE_IDS[targetNorm]?.has(player.id)) return true;
        const playerNorm = normalize(player.name);
        return !!(_REVERSE_TEAMMATE[targetNorm]?.has(playerNorm));
      }
      case 'continent': {
        const nat = (player.nationalTeam || '').trim().replace(/[,;]+$/, '');
        return (CONTINENT_NAT[r.value] || []).includes(nat);
      }
      case 'height_le': return typeof player.heightCm === 'number' && player.heightCm <= r.value;
      case 'height_ge': return typeof player.heightCm === 'number' && player.heightCm >= r.value;
      case 'height_lt': return typeof player.heightCm === 'number' && player.heightCm <  r.value;
      case 'height_gt': return typeof player.heightCm === 'number' && player.heightCm >  r.value;
      case 'position_gk':  return player.position === 'GK'  || (player.position || '').toUpperCase().includes('GK');
      case 'position_def': return player.position === 'DEF' || (player.position || '').toUpperCase().includes('DEF');
      case 'birthDecade': {
        const y = player.birthYear;
        if (typeof y !== 'number') return false;
        if (r.value === '1970s') return y >= 1970 && y <= 1979;
        if (r.value === '1980s') return y >= 1980 && y <= 1989;
        if (r.value === '1990s') return y >= 1990 && y <= 1999;
        if (r.value === '2000s') return y >= 2000 && y <= 2009;
        return false;
      }
      case 'caps_ge': return (player.caps || 0) >= r.value;
      case 'caps_le': return (player.caps || 0) <= r.value;
      case 'caps_0':  return (player.caps || 0) === 0;
      case 'clubs_ge': return (player.teams || []).length >= r.value;
      case 'clubs_le': return (player.teams || []).length <= r.value;
      case 'one_club': return (player.teams || []).length === 1;
      /* Goles y partidos de TODA la carrera. Los dos campos ya venian en cada
         chunk (chunk.goals / chunk.apps) y ya se copiaban al objeto jugador,
         pero no habia ninguna restriccion que los usara. Cobertura: apps en el
         100% de la base, goals en el ~90%. */
      case 'career_goals_ge': return (player.goals || 0) >= r.value;
      case 'career_apps_ge':  return (player.apps  || 0) >= r.value;
      case 'champions_goals_ge': return (player.clg || 0) >= r.value;
      case 'season_goals_ge':    return (player.bsg || 0) >= r.value;
      case 'natGoals_ge':        return (player.natGoals || 0) >= r.value;
      case 'fee_gt': return (player.maxFee || 0) > r.value;
      case 'fee_lt': return (player.maxFee || 0) < r.value;
      case 'foot': return player.foot === 'both' || player.foot === r.value;
      default: return false;
    }
  }

  function countMatching(r, pool, min) {
    const lim = min || 1;
    let count = 0;
    for (let i = 0; i < pool.length; i++) {
      if (validate(pool[i], r)) { count++; if (count >= lim) return count; }
    }
    return count;
  }
  function countMatchingPair(a, b, pool, min) {
    const lim = min || 1;
    let count = 0;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (validate(p, a) && validate(p, b)) { count++; if (count >= lim) return count; }
    }
    return count;
  }

  function isRedundant(rA, rB) {
    if (rA.type === 'club' && rB.type === 'league') {
      const clubObj = CLUBS_LIST.find(c => c.tmName === rA.value);
      if (clubObj && clubObj.league === rB.value) return true;
    }
    if (rA.type === 'trophy' && rB.type === 'trophy_any') {
      if ((rB.value || []).includes(rA.value)) return true;
    }
    if (rA.type === 'trophy_any' && rB.type === 'trophy') {
      if ((rA.value || []).includes(rB.value)) return true;
    }
    if (rA.type === 'nationality' && rB.type === 'continent') return true;
    if (rA.type === 'continent' && rB.type === 'nationality') return true;
    if (rA.type === 'caps_ge' && rB.type === 'caps_ge' && rA.value > rB.value) return true;
    if (rA.type === 'caps_0' && rB.type === 'caps_ge') return true;
    if (rA.type === 'caps_ge' && rA.value >= 1 && rB.type === 'caps_0') return true;
    if (rA.type === 'caps_le' && rB.type === 'caps_le' && rA.value < rB.value) return true;
    if (rA.type === 'champions_goals_ge' && rB.type === 'champions_goals_ge' && rA.value > rB.value) return true;
    if (rA.type === 'season_goals_ge'    && rB.type === 'season_goals_ge'    && rA.value > rB.value) return true;
    if (rA.type === 'natGoals_ge'        && rB.type === 'natGoals_ge'        && rA.value > rB.value) return true;
    if (rA.type === 'career_goals_ge' && rB.type === 'career_goals_ge' && rA.value > rB.value) return true;
    if (rA.type === 'career_apps_ge'  && rB.type === 'career_apps_ge'  && rA.value > rB.value) return true;
    /* Quien lleva 500 partidos oficiales casi seguro ha marcado alguno y ha
       pasado por varios clubes: no tiene gracia cruzarlo con umbrales bajos. */
    if (rA.type === 'career_apps_ge' && rA.value >= 500 && rB.type === 'career_goals_ge' && rB.value <= 50) return true;
    if (rB.type === 'career_apps_ge' && rB.value >= 500 && rA.type === 'career_goals_ge' && rA.value <= 50) return true;
    if (rA.type === 'one_club' && rB.type === 'clubs_le') return true;
    if (rB.type === 'one_club' && rA.type === 'clubs_le') return true;
    if (rA.type === 'one_club' && rB.type === 'clubs_ge') return true;
    if (rB.type === 'one_club' && rA.type === 'clubs_ge') return true;
    if (rA.type === 'position_gk'  && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_gk'  && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'position_def' && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_def' && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'caps_0' && rB.type === 'trophy' && NATIONAL_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'caps_0' && rA.type === 'trophy' && NATIONAL_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'caps_0' && rB.type === 'trophy_any' && (rB.value||[]).some(v => NATIONAL_TROPHIES.has(v))) return true;
    if (rB.type === 'caps_0' && rA.type === 'trophy_any' && (rA.value||[]).some(v => NATIONAL_TROPHIES.has(v))) return true;
    if (rA.type === 'foot' && rB.type === 'foot') return true;
    if (rA.type === 'height_le' && rB.type === 'height_ge') return true;
    if (rA.type === 'height_ge' && rB.type === 'height_le') return true;
    if (rA.type === 'height_ge' && rB.type === 'height_ge' && rA.value > rB.value) return true;
    return false;
  }

  function familyUsed(list, candidate, excludeIdx) {
    const fam = candidate.family || candidate.type;
    return list.some((r, i) => i !== excludeIdx && (r.family || r.type) === fam);
  }

  /* ═══════════════════ CANDIDATOS ═══════════════════
     opts.families: array de familias permitidas (si se pasa, filtra).
     Familias: nationality, league, league_general, trophy_individual,
     trophy_domestic, trophy_intl, trophy_national, trophy_general, coach,
     teammate, continent, birth, height, foot, position, caps, clubs_count,
     fee, champions_goals, season_goals, nat_goals. */
  function buildCandidates(rng, opts = {}) {
    rng = rng || Math.random;
    const candidates = [];

    for (const nat of shuffle(NATIONALITIES, rng))
      candidates.push({ type:'nationality', value:nat.tmNat, label:nat.adj, imgUrl:nat.flagImg, icon:nat.flag, family:'nationality' });

    for (const [liga, cid] of Object.entries(LEAGUE_CIDS))
      candidates.push({ type:'league', value:liga, cid, teams:LEAGUE_TEAMS[liga] || [], label:`Ha jugado en ${liga}`, imgUrl:LEAGUE_LOGOS[liga] || null, icon:'⚽', family:'league' });

    for (const t of shuffle(TROPHIES.individual, rng))
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_individual' });
    for (const t of shuffle(TROPHIES.domestic, rng))
      candidates.push({ type:'trophy', value:t.key, label:t.display, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_domestic' });
    for (const t of shuffle(TROPHIES.international_club, rng))
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_intl' });
    for (const t of shuffle(TROPHIES.national, rng))
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_national' });

    for (const c of shuffle(COACHES_LIST, rng))
      candidates.push({ type:'coach', value:c.name, label:`Entrenado por ${c.name}`, imgUrl:c.photo === false ? null : sbStorageUrl('coach-photos', `${c.id}.png`), icon:c.icon, family:'coach' });

    /* Indice id→jugador: con 227 compañeros, un PLAYERS_DB.find() por cabeza
       es un recorrido completo de la base por cada uno. */
    const byId = new Map();
    for (const x of PLAYERS_DB) byId.set(x.id, x);
    for (const p of shuffle(TEAMMATES_LIST, rng)) {
      const dbPlayer = byId.get(p.id);
      candidates.push({ type:'teammate', value:p.name, label:`Compañero de ${p.display || p.name}`, imgUrl:(dbPlayer && dbPlayer.img) || null, icon:p.icon, family:'teammate' });
    }

    for (const [cont, label] of [['europeo','Europeo'],['americano','Continente Americano'],['africano','Africano'],['asiatico','Asiático']])
      candidates.push({ type:'continent', value:cont, label, imgUrl:CONTINENT_LOGOS[cont], icon:'🌍', family:'continent' });

    for (const [dec, label] of [['1970s','Nacido en los 70'],['1980s','Nacido en los 80'],['1990s','Nacido en los 90'],['2000s','Nacido en los 2000']])
      candidates.push({ type:'birthDecade', value:dec, label, imgUrl:null, icon:'🎂', family:'birth' });

    /* Umbrales sacados de los percentiles reales del pool (p25 177, p50 182,
       p75 186), no a ojo: "180 cm o más" lo cumplia el 59%. */
    candidates.push({ type:'height_le', value:176, label:'Mide 176 cm o menos', imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:185, label:'Mide 185 cm o más',   imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:190, label:'Mide 190 cm o más',   imgUrl:null, icon:'📏', family:'height' });

    /* Solo Zurdo: "Diestro" lo cumplia el 71% del pool (los ambidiestros valen
       para las dos), o sea que no era una pista, era un hueco regalado. */
    candidates.push({ type:'foot', value:'left',  label:'Zurdo',   imgUrl:null, icon:'🦶', family:'foot' });

    candidates.push({ type:'position_gk',  label:'Portero', imgUrl:null, icon:'🧤', family:'position' });
    candidates.push({ type:'position_def', label:'Defensa', imgUrl:null, icon:'🛡️', family:'position' });

    candidates.push({ type:'caps_ge', value:50,  label:'50 o más internacionalidades',   imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_0',             label:'Sin internacionalidades',         imgUrl:null, icon:'🌍', family:'caps' });
    /* Los umbrales se miden contra la BASE ENTERA (8.245), que es contra lo que
       valida el juego cuando escribes un nombre, no contra el pool de generacion.
       Ahi cualquier "menos de X" es un regalo: "50 o menos internacionalidades"
       lo cumplia el 83% y "Internacional (>=1 partido)" el 99%. Fuera los dos;
       quedan solo los cortes por arriba, que si dicen algo (>=50 el 17% de la
       base, >=75 el 8%, >=100 el 4%). */
    candidates.push({ type:'caps_ge', value:75,  label:'75 o más internacionalidades',    imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:100, label:'100 o más internacionalidades',   imgUrl:null, icon:'🌍', family:'caps' });

    /* Solo el corte por abajo. "7 o mas clubes" se quito por peticion del
       usuario: como criterio no dice nada de nadie. "3 o menos" es el 26% de
       la base y si retrata a un futbolista de pocas casas. */
    candidates.push({ type:'clubs_le', value:3, label:'Ha jugado en 3 o menos clubes', imgUrl:null, icon:'🏟️', family:'clubs_count' });
    /* one_club estaba implementado y validado desde siempre, pero no se
       generaba nunca: la categoria existia y no salia jamas. 313 jugadores la
       cumplen, mas que varias nacionalidades. */
    candidates.push({ type:'one_club', value:1, label:'Ha jugado en un solo club', imgUrl:null, icon:'🏟️', family:'clubs_count' });

    /* Umbrales elegidos sobre la base real (8.245 jugadores):
       goles  50 -> 2.340 · 100 -> 1.135 · 200 -> 338
       partidos 500 -> 1.714 · 700 -> 437
       Ninguno deja el candidato tan fino como para atascar la generacion. */
    candidates.push({ type:'career_goals_ge', value:50,  label:'50+ goles en su carrera',  imgUrl:null, icon:'⚽', family:'career_goals' });
    candidates.push({ type:'career_goals_ge', value:100, label:'100+ goles en su carrera', imgUrl:null, icon:'⚽', family:'career_goals' });
    candidates.push({ type:'career_goals_ge', value:200, label:'200+ goles en su carrera', imgUrl:null, icon:'⚽', family:'career_goals' });

    candidates.push({ type:'career_apps_ge', value:500, label:'500+ partidos oficiales', imgUrl:null, icon:'📋', family:'career_apps' });
    candidates.push({ type:'career_apps_ge', value:700, label:'700+ partidos oficiales', imgUrl:null, icon:'📋', family:'career_apps' });

    /* Solo por arriba: "menos de 70M" lo cumplia el 96% del pool y "menos de
       10M" el 77% de la base entera. >20M es el 11% y >40M el 3%. */
    candidates.push({ type:'fee_gt', value:40000000, label:'Traspaso de más de 40M €',  imgUrl:null, icon:'💰', family:'fee' });
    candidates.push({ type:'fee_gt', value:20000000, label:'Traspaso de más de 20M €',  imgUrl:null, icon:'💰', family:'fee' });

    candidates.push({ type:'champions_goals_ge', value:10, label:'10+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });
    candidates.push({ type:'champions_goals_ge', value:20, label:'20+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });
    candidates.push({ type:'champions_goals_ge', value:30, label:'30+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });

    candidates.push({ type:'season_goals_ge', value:10, label:'10+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });
    candidates.push({ type:'season_goals_ge', value:20, label:'20+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });
    candidates.push({ type:'season_goals_ge', value:30, label:'30+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });

    candidates.push({ type:'natGoals_ge', value:20, label:'20+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });
    candidates.push({ type:'natGoals_ge', value:30, label:'30+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });
    candidates.push({ type:'natGoals_ge', value:50, label:'50+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });

    candidates.push({ type:'league_any', value:['MLS1','MEX1'], label:'Ha jugado en MLS/Liga MX', imgUrl:sbStorageUrl('league-logos','UsaMexico.png'), icon:'⚽', family:'league_general' });
    candidates.push({ type:'league_any', value:['SA1','UAE1','QSL','IR1'], label:'Ha jugado en Oriente Medio', imgUrl:sbStorageUrl('league-logos','OrienteMedio.png'), icon:'⚽', family:'league_general' });

    candidates.push({ type:'trophy_any', value:['Liga España','Liga Inglaterra','Liga Italia','Liga Francia','Liga Alemania'], label:'Ganador Liga Doméstica', imgUrl:null, icon:'🏆', family:'trophy_general' });
    candidates.push({ type:'trophy_any', value:['Copa España','Copa Inglaterra','Copa Italia','Copa Francia','Copa Alemania'], label:'Ganador Copa Doméstica', imgUrl:null, icon:'🏆', family:'trophy_general' });
    candidates.push({ type:'trophy_any', value:['Eurocopa','Mundial','Copa America'], label:'Ganador con Selección', imgUrl:null, icon:'🌍', family:'trophy_general' });
    candidates.push({ type:'trophy_any', value:['Champions League','Europa League','Copa Libertadores'], label:'Ganador título continental (clubes)', imgUrl:null, icon:'⭐', family:'trophy_general' });

    /* Clubes: como restriccion propia (Tres en Raya los usa de cabecera) */
    for (const club of shuffle(CLUBS_LIST, rng))
      candidates.push({ type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, display:club.display, imgUrl:club.logoUrl, icon:'🏟️', family:'club' });

    if (Array.isArray(opts.families) && opts.families.length) {
      const allow = new Set(opts.families);
      return candidates.filter(c => allow.has(c.family || c.type));
    }
    return candidates;
  }

  /* ═══════════════════ API PUBLICA ═══════════════════ */
  const FR = {
    init,
    get ready() { return _readyPromise || init(); },
    validate, isRedundant, familyUsed, buildCandidates, countMatching, countMatchingPair,
    resolvePlayer, resolvePlayerById, playerMeta, suggest, getAllPlayers,
    normalize, acNorm, acTight,
    /* Permite a otro juego (p.ej. Coche) inyectar sus mapas inversos de compañeros
       ya construidos, para que FR.validate('teammate') funcione sin FR.init()
       (sin recargar datos). */
    setTeammateMaps(rev, revIds) { _REVERSE_TEAMMATE = rev || {}; _REVERSE_TEAMMATE_IDS = revIds || {}; },
    rng: { mulberry32, shuffle, weightedShuffle },
    get genPool()  { return GEN_POOL; },
    get playersDb(){ return PLAYERS_DB; },
    get nameIndex(){ return NAME_INDEX; },
    CLUBS_LIST, NATIONALITIES, LEAGUE_CIDS, LEAGUE_TEAMS, LEAGUE_LOGOS,
    TROPHIES, COACHES_LIST, TEAMMATES_LIST, CONTINENT_NAT, CONTINENT_LOGOS,
  };
  return FR;
})();
