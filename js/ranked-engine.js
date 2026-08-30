/* =============================================================================
   RANKED-ENGINE.JS — Generador determinista de rejillas de Coche, compartido
   -----------------------------------------------------------------------------
   Extraido de coche/js/restrictions-worker.js (PLAN-coche-ranked.md, Fase 0,
   "Un solo generador"). Antes existian TRES copias de generate()/validate()/
   constantes (script.js, restrictions-worker.js, y una version parcial en
   js/futbol-restrictions.js sin generate()) que podian divergir. Para el modo
   Clasificatorio, cliente y arbitro DEBEN producir la MISMA rejilla para la
   misma semilla, asi que ahora hay un solo sitio.

   Cargable en los tres entornos que lo necesitan:
     - Navegador (hilo principal de coche/js/script.js)      <script src=...>
     - Web Worker (coche/js/restrictions-worker.js)           importScripts(...)
     - Node (api/ranked.js, el arbitro serverless)            require(...)

   Requiere sbStorageUrl (de js/supabase-config.js) para las URLs de escudos/
   banderas/trofeos: en navegador y Worker se toma del scope global (cargar
   supabase-config.js ANTES); en Node se hace require() del mismo archivo,
   que ya exporta sbStorageUrl via module.exports.

   API:
     RankedEngine.generate(seed, db)               -> [restriccion x5]
     RankedEngine.validate(player, r)               -> bool
     RankedEngine.setTeammateData(list, revMap, revIdsMap) -> void
     RankedEngine.normalize(str)                    -> string
     RankedEngine.rng.mulberry32/shuffle/weightedShuffle
     RankedEngine.CLUBS_LIST / NATIONALITIES / LEAGUE_CIDS / ...
   ============================================================================= */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./supabase-config').sbStorageUrl);
  } else {
    const g = typeof self !== 'undefined' ? self : root;
    g.RankedEngine = factory(g.sbStorageUrl);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sbStorageUrl) {
  'use strict';

  /* ── Helpers ── */
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
  function _weightedShuffle(items, weightFn, rng) {
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
  const _normCache = new Map();
  function normalize(str) {
    if (!str) return '';
    const key = String(str);
    const cached = _normCache.get(key);
    if (cached !== undefined) return cached;
    const out = key.toLowerCase()
      .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/ð/g,'d').replace(/þ/g,'th').replace(/ł/g,'l').replace(/đ/g,'d').replace(/ı/g,'i').replace(/İ/g,'i').replace(/ß/g,'b').replace(/œ/g,'oe').replace(/[​-‏]/g,'')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ').trim();
    _normCache.set(key, out);
    return out;
  }
  function _logoUrl(tmName) {
    return sbStorageUrl('team-logos', tmName.replace(/ /g, '_') + '.png');
  }

  /* ── Constantes (IDENTICAS a js/futbol-restrictions.js) ── */
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
      'Leeds United','Burnley FC','Blackburn Rovers','Bolton Wanderers','Stoke City',
      'Swansea City','Norwich City','Sunderland AFC','Middlesbrough FC','Birmingham City',
      'Hull City','Southampton FC','Ipswich Town','Luton Town','Sheffield United','Derby County',
    ],
    'Serie A': [
      'Juventus FC','AC Milan','Inter Milan','SSC Napoli','AS Roma','SS Lazio',
      'Atalanta BC','ACF Fiorentina','Torino FC','Udinese Calcio','Bologna FC 1909',
      'Cagliari Calcio','Genoa CFC','Hellas Verona','US Sassuolo','US Lecce',
      'US Cremonese','Parma Calcio 1913','Como 1907','Sampdoria','Empoli FC',
      'Venezia FC','AC Monza','Spezia Calcio','Benevento Calcio','FC Crotone','Frosinone Calcio',
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
      'Le Havre AC','FC Metz','Paris FC','Girondins de Bordeaux','AS Saint-Étienne','Montpellier HSC',
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
    'La Liga':        'ES1',
    'Premier League': 'GB1',
    'Serie A':        'IT1',
    'Bundesliga':     'L1',
    'Ligue 1':        'FR1',
    'Eredivisie':     'NL1',
    'Primeira Liga':  'PO1',
    'Süper Lig':      'TR1',
    'Brasileirão':    'BRA1',
    'Liga Argentina': 'ARG1',
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
    { tmNat:'Spain',       display:'España',     adj:'Español',    flag:'🇪🇸', flagImg:sbStorageUrl('team-flags','es.png') },
    { tmNat:'England',     display:'Inglaterra', adj:'Inglés',     flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', flagImg:sbStorageUrl('team-flags','eng.png') },
    { tmNat:'France',      display:'Francia',    adj:'Francés',    flag:'🇫🇷', flagImg:sbStorageUrl('team-flags','fr.png') },
    { tmNat:'Argentina',   display:'Argentina',  adj:'Argentino',  flag:'🇦🇷', flagImg:sbStorageUrl('team-flags','ar.png') },
    { tmNat:'Germany',     display:'Alemania',   adj:'Alemán',     flag:'🇩🇪', flagImg:sbStorageUrl('team-flags','de.png') },
    { tmNat:'Brazil',      display:'Brasil',     adj:'Brasileño',  flag:'🇧🇷', flagImg:sbStorageUrl('team-flags','br.png') },
    { tmNat:'Netherlands', display:'Holanda',    adj:'Holandés',   flag:'🇳🇱', flagImg:sbStorageUrl('team-flags','nl.png') },
    { tmNat:'Italy',       display:'Italia',     adj:'Italiano',   flag:'🇮🇹', flagImg:sbStorageUrl('team-flags','it.png') },
    { tmNat:'Uruguay',     display:'Uruguay',    adj:'Uruguayo',   flag:'🇺🇾', flagImg:sbStorageUrl('team-flags','uy.png') },
    { tmNat:'Senegal',     display:'Senegal',    adj:'Senegalés',  flag:'🇸🇳', flagImg:sbStorageUrl('team-flags','sn.png') },
    { tmNat:'Cameroon',    display:'Camerún',    adj:'Camerunés',  flag:'🇨🇲', flagImg:sbStorageUrl('team-flags','cm.png') },
    { tmNat:'Morocco',     display:'Marruecos',  adj:'Marroquí',   flag:'🇲🇦', flagImg:sbStorageUrl('team-flags','ma.png') },
    { tmNat:'Japan',       display:'Japón',      adj:'Japonés',    flag:'🇯🇵', flagImg:sbStorageUrl('team-flags','jp.png') },
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
    europeo:    sbStorageUrl('league-logos', 'Europe.png'),
    americano:  sbStorageUrl('league-logos', 'Americas.png'),
    africano:   sbStorageUrl('league-logos', 'Africa.png'),
    asiatico:   sbStorageUrl('league-logos', 'Asia.png'),
  };

  const CONTINENT_NAT = {
    europeo:   ['Spain','England','France','Germany','Netherlands','Portugal','Italy',
                 'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
                 'Czech Republic','Czech','Switzerland','Austria','Turkey','Türkiye','Turkiye','Czechia','Republic of Ireland','Israel','Belarus','Greece','Hungary',
                 'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
                 'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
                 'Ireland','Georgia','Kosovo','North Macedonia','North','Bulgaria','Cyprus','Latvia',
                 'Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar',
                 'Faroe','Faroe Islands'],
    americano: ['Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
                 'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
                 'Trinidad and Tobago','Curaçao','Suriname','Guadeloupe','Martinique','Montserrat','Puerto Rico','Honduras','Costa Rica','Costa','Panama','Guatemala',
                 'El Salvador','Cuba','Dominican Republic','Canada','Haiti'],
    africano:  ['Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cote','Cameroon',
                 'Morocco','Egypt','Algeria','Tunisia','South Africa','South','Mali','Guinea',
                 'Burkina Faso','DR Congo','DR','Congo','Democratic Republic of the Congo','Republic of the Congo','Togo','Gabon',
                 'Equatorial Guinea','Equatorial','Zimbabwe','Kenya','Cape Verde','Cape','Sierra Leone',
                 'Liberia','Gambia','The','Guinea-Bissau','The Gambia','Rwanda','Ethiopia','Tanzania',
                 'Zambia','Uganda','Angola','Mauritius','Mozambique','Madagascar',
                 'Benin','Niger','Chad','Sudan','South Sudan','Somalia','Eritrea',
                 'Djibouti','Comoros','Lesotho','Botswana','Namibia','Malawi',
                 'Eswatini','Libya','Mauritania','Central African Republic'],
    asiatico:  ['Japan','South Korea','Iran','Saudi Arabia','Saudi','Qatar','UAE','Australia',
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
      { key:'Champions League',  display:'Champions League',  icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','champions.png') },
      { key:'Europa League',     display:'Europa League',     icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','europa_league.png') },
      { key:'Copa Libertadores', display:'Copa Libertadores', icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','copa_libertadores.png') },
      { key:'Conference League', display:'Conference League', icon:'⭐', imgUrl:sbStorageUrl('trophy-icons','conference_league.png') },
    ],
    national: [
      { key:'Eurocopa',    display:'Eurocopa',    icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','eurocopa.png') },
      { key:'Mundial',     display:'Mundial',     icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','mundial.png') },
      { key:'Copa America',display:'Copa América', icon:'🌍', imgUrl:sbStorageUrl('trophy-icons','copa_america.png') },
    ],
  };

  const COACHES_LIST = [
    { name:'Hansi Flick',     id:'67',    icon:'🎽' },
    { name:'Jürgen Klopp',    id:'118',   icon:'🎽' },
    { name:'Arsène Wenger',   id:'280',   icon:'🎽' },
    { name:'Carlo Ancelotti', id:'523',   icon:'🎽' },
    { name:'José Mourinho',   id:'781',   icon:'🎽' },
    { name:'Rafael Benítez',  id:'1522',  icon:'🎽' },
    { name:'Diego Simeone',   id:'2868',  icon:'🎽' },
    { name:'Antonio Conte',   id:'3517',  icon:'🎽' },
    { name:'Unai Emery',      id:'5075',  icon:'🎽' },
    { name:'Pep Guardiola',   id:'5672',  icon:'🎽' },
    { name:'Luis Enrique',    id:'6499',  icon:'🎽' },
    { name:'Zinédine Zidane', id:'21284', icon:'🎽' },
    { name:'Thomas Tuchel',      id:'7471', icon:'🎽' },
    { name:'Mauricio Pochettino', id:'9044', icon:'🎽' },
  ];

  /* Respaldo por si nadie llama a setTeammateData (nunca deberia pasar en
     produccion: script.js/api/ranked.js siempre la rellenan desde
     companeros_principal.json, ver comentario historico en el propio
     restrictions-worker.js). */
  let TEAMMATES_LIST = [
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
    { name:'Fernando Llorente',  display:'Fernando Llorente',id:'35564',  icon:'⚽' },
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
    { name:"N'Golo Kanté",       display:'Kanté',            id:'225083', icon:'⚽' },
    { name:'Alexis Sánchez',     display:'Alexis Sánchez',   id:'40433',  icon:'⚽' },
    { name:'Arjen Robben',       display:'Robben',           id:'4360',   icon:'⚽' },
    { name:'Fernando Torres',    display:'Torres',           id:'7767',   icon:'⚽' },
    { name:'Joaquín',            display:'Joaquín',          id:'7663',   icon:'⚽' },
    { name:'Francesco Totti',    display:'Totti',            id:'5958',   icon:'⚽' },
  ];
  let _REVERSE_TEAMMATE     = {};
  let _REVERSE_TEAMMATE_IDS = {};

  /* El hilo/proceso llamante (script.js, restrictions-worker.js, api/ranked.js)
     rellena esto desde companeros_principal.json, igual que hacia el
     postMessage del worker. Sin esto no puede haber tres copias divergentes. */
  function setTeammateData(list, reverseTeammate, reverseTeammateIds) {
    if (Array.isArray(list) && list.length) TEAMMATES_LIST = list;
    _REVERSE_TEAMMATE = {};
    for (const [k, v] of Object.entries(reverseTeammate || {})) _REVERSE_TEAMMATE[k] = new Set(v);
    _REVERSE_TEAMMATE_IDS = {};
    for (const [k, v] of Object.entries(reverseTeammateIds || {})) _REVERSE_TEAMMATE_IDS[k] = new Set(v);
  }

  /* ── validate ── */
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
        return !!(_REVERSE_TEAMMATE[targetNorm]?.has(normalize(player.name)));
      }
      case 'continent':
        return (CONTINENT_NAT[r.value] || []).includes((player.nationalTeam || '').trim().replace(/[,;]+$/, ''));
      case 'height_le': return typeof player.heightCm === 'number' && player.heightCm <= r.value;
      case 'height_ge': return typeof player.heightCm === 'number' && player.heightCm >= r.value;
      case 'height_lt': return typeof player.heightCm === 'number' && player.heightCm < r.value;
      case 'height_gt': return typeof player.heightCm === 'number' && player.heightCm > r.value;
      case 'position_gk':
        return player.position === 'GK' || (player.position || '').toUpperCase().includes('GK');
      case 'position_def':
        return player.position === 'DEF' || (player.position || '').toUpperCase().includes('DEF');
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
      case 'champions_goals_ge': return (player.clg || 0) >= r.value;
      case 'season_goals_ge':    return (player.bsg || 0) >= r.value;
      case 'natGoals_ge':        return (player.natGoals || 0) >= r.value;
      case 'fee_gt': return (player.maxFee || 0) > r.value;
      case 'fee_lt': return (player.maxFee || 0) < r.value;
      case 'team':
        return (player.teams || player.clubs || []).some(c => normalize(c) === normalize(r.value));
      case 'nationalTeam':
        return normalize(player.nationalTeam || '') === normalize(r.value);
      case 'foot':
        return player.foot === 'both' || player.foot === r.value;
      case 'goals_gt': return typeof player.goals === 'number' && player.goals > r.value;
      case 'goals_lt': return typeof player.goals === 'number' && player.goals < r.value;
      case 'apps_gt':  return typeof player.apps  === 'number' && player.apps  > r.value;
      case 'apps_lt':  return typeof player.apps  === 'number' && player.apps  < r.value;
      default: return false;
    }
  }

  function _matching(restriction, db, minNeeded) {
    const min = minNeeded || 2;
    let count = 0;
    for (let i = 0; i < db.length; i++) {
      if (validate(db[i], restriction)) {
        count++;
        if (count >= min) return count;
      }
    }
    return count;
  }

  function _buildCandidates(rng, db) {
    const candidates = [];
    for (const nat of _shuffle(NATIONALITIES, rng)) {
      candidates.push({ type:'nationality', value:nat.tmNat, label:nat.adj, imgUrl:nat.flagImg, icon:nat.flag, family:'nationality' });
    }
    for (const [liga, cid] of Object.entries(LEAGUE_CIDS)) {
      candidates.push({ type:'league', value:liga, cid, teams:LEAGUE_TEAMS[liga]||[], label:`Ha jugado en ${liga}`, imgUrl:LEAGUE_LOGOS[liga]||null, icon:'⚽', family:'league' });
    }
    for (const t of _shuffle(TROPHIES.individual, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_individual' });
    }
    for (const t of _shuffle(TROPHIES.domestic, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:t.display, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_domestic' });
    }
    for (const t of _shuffle(TROPHIES.international_club, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_intl' });
    }
    for (const t of _shuffle(TROPHIES.national, rng)) {
      candidates.push({ type:'trophy', value:t.key, label:`Ganador ${t.display}`, imgUrl:t.imgUrl, icon:t.icon, family:'trophy_national' });
    }
    for (const c of _shuffle(COACHES_LIST, rng)) {
      candidates.push({ type:'coach', value:c.name, label:`Entrenado por ${c.name}`, imgUrl:c.photo === false ? null : sbStorageUrl('coach-photos', `${c.id}.png`), icon:c.icon, family:'coach' });
    }
    const byId = new Map();
    for (const x of db) byId.set(x.id, x);
    for (const p of _shuffle(TEAMMATES_LIST, rng)) {
      const dbPlayer = byId.get(p.id);
      candidates.push({ type:'teammate', value:p.name, label:`Compañero de ${p.display||p.name}`, imgUrl:(dbPlayer && dbPlayer.img) || null, icon:p.icon, family:'teammate' });
    }
    for (const [cont, label] of [['europeo','Europeo'],['americano','Continente Americano'],['africano','Africano'],['asiatico','Asiático']]) {
      candidates.push({ type:'continent', value:cont, label, imgUrl:CONTINENT_LOGOS[cont], icon:'🌍', family:'continent' });
    }
    for (const [dec, label] of [['1970s','Nacido en los 70'],['1980s','Nacido en los 80'],['1990s','Nacido en los 90'],['2000s','Nacido en los 2000']]) {
      candidates.push({ type:'birthDecade', value:dec, label, imgUrl:null, icon:'🎂', family:'birth' });
    }
    candidates.push({ type:'height_le', value:176, label:'Mide 176 cm o menos',  imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:185, label:'Mide 185 cm o más',    imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'height_ge', value:190, label:'Mide 190 cm o más',    imgUrl:null, icon:'📏', family:'height' });
    candidates.push({ type:'foot', value:'left',  label:'Zurdo',       imgUrl:null, icon:'🦶', family:'foot' });
    candidates.push({ type:'position_gk',  label:'Portero',   imgUrl:null, icon:'🧤', family:'position' });
    candidates.push({ type:'position_def', label:'Defensa',   imgUrl:null, icon:'🛡️', family:'position' });
    candidates.push({ type:'caps_ge', value:50,  label:'50 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_0',              label:'Sin internacionalidades',        imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:75,  label:'75 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'caps_ge', value:100, label:'100 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
    candidates.push({ type:'clubs_le', value:3, label:'Ha jugado en 3 o menos clubes',imgUrl:null, icon:'🏟️', family:'clubs_count' });
    candidates.push({ type:'fee_gt', value:40000000, label:'Traspaso de más de 40M €',   imgUrl:null, icon:'💰', family:'fee' });
    candidates.push({ type:'fee_gt', value:20000000, label:'Traspaso de más de 20M €',   imgUrl:null, icon:'💰', family:'fee' });
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
    return candidates;
  }

  function _isRedundant(rA, rB) {
    if (rA.type === 'club' && rB.type === 'league') {
      const c = CLUBS_LIST.find(c => c.tmName === rA.value);
      if (c && c.league === rB.value) return true;
    }
    if (rA.type === 'trophy' && rB.type === 'trophy_any' && (rB.value||[]).includes(rA.value)) return true;
    if (rA.type === 'trophy_any' && rB.type === 'trophy' && (rA.value||[]).includes(rB.value)) return true;
    if (rA.type === 'nationality' && rB.type === 'continent') return true;
    if (rA.type === 'continent' && rB.type === 'nationality') return true;
    if (rA.type === 'caps_ge' && rB.type === 'caps_ge' && rA.value > rB.value) return true;
    if (rA.type === 'caps_0' && rB.type === 'caps_ge') return true;
    if (rA.type === 'caps_ge' && rA.value >= 1 && rB.type === 'caps_0') return true;
    if (rA.type === 'caps_le' && rB.type === 'caps_le' && rA.value < rB.value) return true;
    if (rA.type === 'champions_goals_ge' && rB.type === 'champions_goals_ge' && rA.value > rB.value) return true;
    if (rA.type === 'season_goals_ge'    && rB.type === 'season_goals_ge'    && rA.value > rB.value) return true;
    if (rA.type === 'natGoals_ge'        && rB.type === 'natGoals_ge'        && rA.value > rB.value) return true;
    if (rA.type === 'one_club' && rB.type === 'clubs_ge') return true;
    if (rB.type === 'one_club' && rA.type === 'clubs_ge') return true;
    const SCORER_TROPHIES = new Set(['Pichichi La Liga','Bota de Oro Premier League','Capocannoniere Serie A','Maximo Goleador Bundesliga','Maximo Goleador Ligue 1','Bota de Oro Mundial','Bota de Oro Europea']);
    if (rA.type === 'position_gk' && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_gk' && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;
    if (rA.type === 'position_def' && rB.type === 'trophy' && SCORER_TROPHIES.has(rB.value)) return true;
    if (rB.type === 'position_def' && rA.type === 'trophy' && SCORER_TROPHIES.has(rA.value)) return true;

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
    if (rA.type === 'foot' && rB.type === 'foot') return true;
    if (rA.type === 'height_le' && rB.type === 'height_ge') return true;
    if (rA.type === 'height_ge' && rB.type === 'height_le') return true;
    if (rA.type === 'height_ge' && rB.type === 'height_ge' && rA.value > rB.value) return true;
    return false;
  }

  function _familyUsed(list, candidate, excludeIdx) {
    const fam = candidate.family || candidate.type;
    return list.some((r, i) => i !== excludeIdx && (r.family || r.type) === fam);
  }

  function _removeRedundancies(restrictions, shuffledPool, db) {
    let result = [...restrictions];
    let changed = true;
    /* Tope de iteraciones (nunca se alcanza con datos normales: en produccion
       esto converge en 1-2 vueltas). Es una red de seguridad para el
       arbitro de ranked (api/ranked.js, Node): ahi un bucle sin fin no solo
       cuelga una pestaña, agota el tiempo de la funcion serverless. Sin
       tope, una combinacion rara de pool+semilla que oscile entre dos
       sustituciones redundantes entre si no terminaria nunca. */
    let _guard = 0;
    while (changed && _guard++ < 1000) {
      changed = false;
      outer: for (let i = 0; i < result.length; i++) {
        for (let j = 0; j < result.length; j++) {
          if (i === j) continue;
          if (_isRedundant(result[i], result[j])) {
            const usedFamilies = new Set(result.filter((_, k) => k !== j).map(r => r.family || r.type));
            const replacement = shuffledPool.find(r =>
              !result.includes(r) && !usedFamilies.has(r.family || r.type) &&
              !result.some((e, k) => k !== j && (_isRedundant(e, r) || _isRedundant(r, e))) &&
              _matching(r, db) >= 2
            );
            if (replacement) { result[j] = replacement; changed = true; break outer; }
            const relaxed = shuffledPool.find(r =>
              !result.includes(r) &&
              !result.some((e, k) => k !== j && (_isRedundant(e, r) || _isRedundant(r, e))) &&
              _matching(r, db) >= 2
            );
            if (relaxed) { result[j] = relaxed; changed = true; break outer; }
            break outer;
          }
        }
      }
    }
    return result;
  }

  function _ensureSolution(restrictions, shuffledPool, db) {
    const clubRestrictions = restrictions.filter(r => r.type === 'club');
    const filteredDB = clubRestrictions.length > 0
      ? db.filter(p => clubRestrictions.every(cr => validate(p, cr)))
      : db;
    const MIN_SOLUCIONES = 2;
    const hasSolution = (rs) => {
      const nonClub = rs.filter(r => r.type !== 'club');
      let n = 0;
      for (const p of filteredDB) {
        if (nonClub.every(r => validate(p, r))) { if (++n >= MIN_SOLUCIONES) return true; }
      }
      return false;
    };
    if (hasSolution(restrictions)) return restrictions;
    const result = [...restrictions];
    const swappableIdx = result.map((_, i) => i).filter(i => i >= 2);
    for (const idx of swappableIdx) {
      const original = result[idx];
      for (const candidate of shuffledPool) {
        if (result.includes(candidate)) continue;
        if (_familyUsed(result, candidate, idx)) continue;
        const wouldBeRedundant = result.some((r, i) => i !== idx && (_isRedundant(r, candidate) || _isRedundant(candidate, r)));
        if (wouldBeRedundant) continue;
        result[idx] = candidate;
        if (hasSolution(result)) return result;
      }
      result[idx] = original;
    }
    const anchors = result.slice(0, 2);
    const nonClubPool = shuffledPool.filter(r => r.type !== 'club');
    const nuclear = [...anchors];
    const usedFamilies = {};
    for (const a of anchors) {
      const fam = a.family || a.type;
      usedFamilies[fam] = (usedFamilies[fam] || 0) + 1;
    }
    for (const candidate of nonClubPool) {
      if (nuclear.length >= 5) break;
      const fam = candidate.family || candidate.type;
      if ((usedFamilies[fam] || 0) >= 1) continue;
      if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
      nuclear.push(candidate);
      if (hasSolution(nuclear)) { usedFamilies[fam] = (usedFamilies[fam] || 0) + 1; }
      else { nuclear.pop(); }
    }
    for (const candidate of nonClubPool) {
      if (nuclear.length >= 5) break;
      if (nuclear.includes(candidate)) continue;
      if (_familyUsed(nuclear, candidate, -1)) continue;
      if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
      nuclear.push(candidate);
      if (!hasSolution(nuclear)) nuclear.pop();
    }
    if (hasSolution(nuclear) && nuclear.length === 5) return nuclear;
    for (const candidate of nonClubPool) {
      if (nuclear.length >= 5) break;
      if (nuclear.includes(candidate)) continue;
      if (_familyUsed(nuclear, candidate, -1)) continue;
      if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
      nuclear.push(candidate);
    }
    return nuclear.length === 5 ? nuclear : result;
  }

  const _ONECLUB_PROB = 0.02;

  function generate(seed, db) {
    const rng = _mulberry32(seed);
    const shuffledClubs = _shuffle(CLUBS_LIST, rng);
    const MIN_PAIR = Math.min(3, Math.max(2, Math.floor(db.length / 100)));
    const clubRestrictions = [];

    let club1 = null;
    for (const club of shuffledClubs) {
      const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
      if (_matching(r, db, 1) >= 1) { club1 = { r, meta: club }; break; }
    }
    if (!club1) {
      club1 = { r:{ type:'club', value:shuffledClubs[0].tmName, label:`Ha jugado en ${shuffledClubs[0].display}`, imgUrl:shuffledClubs[0].logoUrl, icon:'🏟️', family:'club' }, meta:shuffledClubs[0] };
    }
    clubRestrictions.push(club1.r);

    if (rng() < _ONECLUB_PROB) {
      let ocmCount = 0;
      for (const p of db) {
        const t = p.teams || [];
        if (t.length === 1 && normalize(t[0]) === normalize(club1.meta.tmName)) {
          if (++ocmCount >= 2) break;
        }
      }
      if (ocmCount >= 2) {
        clubRestrictions.push({ type:'one_club', label:'One Club Man (un solo club)', imgUrl:null, icon:'🏰', family:'clubs_count' });
      }
    }

    const useLeagueAsSecond = clubRestrictions.length < 2 && rng() < 0.15;

    if (useLeagueAsSecond) {
      const club1League = club1.meta.league;
      const otherLeagues = Object.entries(LEAGUE_CIDS).filter(([lg]) => lg !== club1League);
      if (otherLeagues.length > 0) {
        const shuffledLeagues = _shuffle(otherLeagues, rng);
        for (const [liga, cid] of shuffledLeagues) {
          const lr = { type:'league', value:liga, cid, teams:LEAGUE_TEAMS[liga]||[], label:`Ha jugado en ${liga}`, imgUrl:LEAGUE_LOGOS[liga]||null, icon:'⚽', family:'league' };
          if (db.some(p => validate(p, club1.r) && validate(p, lr))) {
            clubRestrictions.push(lr);
            break;
          }
        }
      }
    }

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

    const candidates = _buildCandidates(rng, db);
    const dbIds = new Set(db.map(p => p.id));
    const playable = candidates.filter(r => {
      if (r.type === 'teammate') {
        const s = _REVERSE_TEAMMATE_IDS[normalize(r.value)];
        if (s) { for (const id of s) if (dbIds.has(id)) return true; }
        return _matching(r, db, 1) >= 1;
      }
      return _matching(r, db) >= 2;
    });

    const familyGroups = {};
    for (const r of playable) {
      const fam = r.family || r.type;
      if (!familyGroups[fam]) familyGroups[fam] = [];
      familyGroups[fam].push(r);
    }
    const usedFamilies = new Set();
    if (clubRestrictions.length === 2 && clubRestrictions[1].type === 'league') {
      usedFamilies.add('league');
    } else if (clubRestrictions.length === 2 && clubRestrictions[1].type === 'one_club') {
      usedFamilies.add('clubs_count');
    }

    const familyNames = _weightedShuffle(
      Object.keys(familyGroups).filter(f => {
        if (!usedFamilies.has(f)) {
          if (f === 'position') return rng() < 0.50;
          return true;
        }
        return false;
      }),
      f => familyGroups[f].length,
      rng
    );

    const chosen = [];
    for (const fam of familyNames) {
      if (chosen.length >= 3) break;
      const group = _shuffle(familyGroups[fam], rng);
      const pick = group[0];
      if (pick) { chosen.push(pick); usedFamilies.add(fam); }
    }
    if (chosen.length < 3) {
      const remaining = _shuffle(playable.filter(r => !chosen.includes(r)), rng);
      for (const r of remaining) {
        if (chosen.length >= 3) break;
        chosen.push(r);
      }
    }

    let result = [...clubRestrictions, ...chosen.slice(0, 3)];
    const shuffled = _shuffle(playable, rng);
    result = _removeRedundancies(result, shuffled, db);
    result = _ensureSolution(result, shuffled, db);
    return result;
  }

  return {
    generate,
    validate,
    setTeammateData,
    normalize,
    rng: { mulberry32: _mulberry32, shuffle: _shuffle, weightedShuffle: _weightedShuffle },
    CLUBS_LIST, LEAGUE_TEAMS, LEAGUE_CIDS, LEAGUE_LOGOS, NATIONALITIES,
    CONTINENT_LOGOS, CONTINENT_NAT, TROPHIES, COACHES_LIST,
  };
});
