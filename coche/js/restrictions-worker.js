'use strict';
/* ═══════════════════════════════════════════════════════════════
   RESTRICTIONS WORKER
   Ejecuta Restrictions.generate() en un hilo separado para no
   bloquear el hilo principal (countdown, UI, animaciones).
   Recibe: { seed, db, reverseTeammate, reverseTeammateIds }
   Emite:  array de restricciones generadas
   ═══════════════════════════════════════════════════════════════ */

/* sbStorageUrl (URLs de Supabase Storage para escudos/banderas/trofeos/
   entrenadores) — los Workers no comparten scope con la página, así que
   hay que importar el mismo archivo compartido que usa el resto de la web. */
importScripts('../../js/supabase-config.js');

let _REVERSE_TEAMMATE     = {};
let _REVERSE_TEAMMATE_IDS = {};

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
/* Memoizada: normalize() se llama con las mismas cadenas (club/liga/
   nacionalidad/jugador) miles de veces por generate() -- con el pool de
   generacion ampliado (~1500 jugadores) recalcular NFD+regex en cada
   llamada era medible. Cache pura, sin efectos secundarios. DEBE seguir
   igual que la de coche/js/script.js para que el seed sea determinista. */
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
function _logoUrl(tmName) {
  return sbStorageUrl('team-logos', tmName.replace(/ /g, '_') + '.png');
}

/* ── Constantes (deben ser idénticas a las de Restrictions en script.js) ── */
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
  { tmName:'Celtic FC',            display:'Celtic',         league:'Scottish Premiership' },
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

/* Ligas 1ª división: display → cid de performances (distingue 1ª de 2ª) */
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
  'Liga Argentina': 'AR1',
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
];

/* Icono de silueta por continente (bucket league-logos, reutilizado) */
const CONTINENT_LOGOS = {
  europeo:    sbStorageUrl('league-logos', 'Europe.png'),
  americano:  sbStorageUrl('league-logos', 'Americas.png'),
  africano:   sbStorageUrl('league-logos', 'Africa.png'),
  asiatico:   sbStorageUrl('league-logos', 'Asia.png'),
};

const CONTINENT_NAT = {
  europeo:   ['Spain','England','France','Germany','Netherlands','Portugal','Italy',
               'Belgium','Croatia','Serbia','Denmark','Sweden','Norway','Poland',
               'Czech Republic','Czech','Switzerland','Austria','Turkey','Türkiye','Greece','Hungary',
               'Slovakia','Romania','Ukraine','Russia','Scotland','Wales','Northern Ireland',
               'Finland','Albania','Slovenia','Bosnia-Herzegovina','Montenegro','Iceland',
               'Ireland','Georgia','Kosovo','North Macedonia','North','Bulgaria','Cyprus','Latvia',
               'Lithuania','Estonia','Azerbaijan','Armenia','Luxembourg','Gibraltar',
               'Faroe','Faroe Islands'],
  americano: ['Argentina','Brazil','Colombia','Uruguay','Chile','Mexico','Paraguay',
               'Bolivia','Peru','Venezuela','Ecuador','United States','Jamaica',
               'Trinidad and Tobago','Honduras','Costa Rica','Costa','Panama','Guatemala',
               'El Salvador','Cuba','Dominican Republic','Canada','Haiti'],
  africano:  ['Senegal','Nigeria','Ghana','Ivory Coast',"Côte d'Ivoire",'Cote','Cameroon',
               'Morocco','Egypt','Algeria','Tunisia','South Africa','South','Mali','Guinea',
               'Burkina Faso','DR Congo','DR','Congo','Republic of the Congo','Togo','Gabon',
               'Equatorial Guinea','Zimbabwe','Kenya','Cape Verde','Cape','Sierra Leone',
               'Liberia','Gambia','The','Guinea-Bissau','Rwanda','Ethiopia','Tanzania',
               'Zambia','Uganda','Angola','Mauritius','Mozambique','Madagascar',
               'Benin','Niger','Chad','Sudan','South Sudan','Somalia','Eritrea',
               'Djibouti','Comoros','Lesotho','Botswana','Namibia','Malawi',
               'Eswatini','Libya','Mauritania','Central African Republic'],
  asiatico:  ['Japan','South Korea','Iran','Saudi Arabia','Saudi','Qatar','UAE','Australia',
               'China','Iraq','Jordan','Bahrain','Kuwait','Uzbekistan','Vietnam',
               'Thailand','Indonesia','Philippines','India','Pakistan','Bangladesh',
               'North Korea','Malaysia','Oman','Lebanon','Palestine','Syria',
               'New','New Zealand'],
};

const REGION_PATTERNS = {
  oriente_medio: ['al-nassr','al-hilal','al-ittihad','al-ahli','al-qadsia',
                  'al-sadd','al-rayyan','al-duhail','al-ain','al-wahda',
                  'al-shabab','al-raed','al-taawoun','al-faisaly','al-fateh',
                  'al-jazira','al-wasl','al-najma','al-kharaitiyat',
                  'al-wehda','al-ettifaq','al-gharafa','al ain sc','al ain fc',
                  'riyadh','jeddah','sharjah','dubai','abu dhabi','kuwait',
                  'esteghlal','persepolis','tractors','sepahan',
                  'umm salal','pakhtakor','lokomotiv tashkent'],
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
];

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
  { name:"N'Golo Kanté",       display:'Kanté',            id:'225083', icon:'⚽' },
  { name:'Alexis Sánchez',     display:'Alexis Sánchez',   id:'40433',  icon:'⚽' },
  { name:'Arjen Robben',       display:'Robben',           id:'4360',   icon:'⚽' },
  { name:'Fernando Torres',    display:'Torres',           id:'7767',   icon:'⚽' },
  { name:'Joaquín',            display:'Joaquín',          id:'7663',   icon:'⚽' },
  { name:'Francesco Totti',    display:'Totti',            id:'5958',   icon:'⚽' },
];

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
    case 'region': {
      const patterns = REGION_PATTERNS[r.value] || [];
      return (player.teams || []).some(t => patterns.some(p => normalize(t).includes(p)));
    }
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
    candidates.push({ type:'coach', value:c.name, label:`Entrenado por ${c.name}`, imgUrl:sbStorageUrl('coach-photos', `${c.id}.png`), icon:c.icon, family:'coach' });
  }
  for (const p of _shuffle(TEAMMATES_LIST, rng)) {
    /* La foto viene de la BD de jugadores (Supabase), no de un archivo local:
       nunca hubo fotos propias en coche/data/players/photos. */
    const dbPlayer = db.find(x => x.id === p.id);
    candidates.push({ type:'teammate', value:p.name, label:`Compañero de ${p.display||p.name}`, imgUrl:(dbPlayer && dbPlayer.img) || null, icon:p.icon, family:'teammate' });
  }
  for (const [cont, label] of [['europeo','Europeo'],['americano','Continente Americano'],['africano','Africano'],['asiatico','Asiático']]) {
    candidates.push({ type:'continent', value:cont, label, imgUrl:CONTINENT_LOGOS[cont], icon:'🌍', family:'continent' });
  }
  for (const [dec, label] of [['1980s','Nacido en los 80'],['1990s','Nacido en los 90'],['2000s','Nacido en los 2000']]) {
    candidates.push({ type:'birthDecade', value:dec, label, imgUrl:null, icon:'🎂', family:'birth' });
  }
  candidates.push({ type:'height_le', value:180, label:'Mide 180 cm o menos',  imgUrl:null, icon:'📏', family:'height' });
  candidates.push({ type:'height_ge', value:180, label:'Mide 180 cm o más',    imgUrl:null, icon:'📏', family:'height' });
  candidates.push({ type:'height_ge', value:190, label:'Mide 190 cm o más',    imgUrl:null, icon:'📏', family:'height' });
  candidates.push({ type:'foot', value:'left',  label:'Zurdo',       imgUrl:null, icon:'🦶', family:'foot' });
  candidates.push({ type:'foot', value:'right', label:'Diestro',     imgUrl:null, icon:'🦶', family:'foot' });
  candidates.push({ type:'position_gk',  label:'Portero',   imgUrl:null, icon:'🧤', family:'position' });
  candidates.push({ type:'position_def', label:'Defensa',   imgUrl:null, icon:'🛡️', family:'position' });
  candidates.push({ type:'caps_ge', value:50,  label:'50 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
  candidates.push({ type:'caps_le', value:50,  label:'50 o menos internacionalidades',imgUrl:null, icon:'🌍', family:'caps' });
  candidates.push({ type:'caps_0',              label:'Sin internacionalidades',        imgUrl:null, icon:'🌍', family:'caps' });
  candidates.push({ type:'caps_ge', value:1,   label:'Internacional (≥1 partido)',     imgUrl:null, icon:'🌍', family:'caps' });
  candidates.push({ type:'caps_ge', value:100, label:'100 o más internacionalidades',  imgUrl:null, icon:'🌍', family:'caps' });
  candidates.push({ type:'clubs_ge', value:3, label:'Ha jugado en 3 o más clubes', imgUrl:null, icon:'🏟️', family:'clubs_count' });
  candidates.push({ type:'clubs_le', value:3, label:'Ha jugado en 3 o menos clubes',imgUrl:null, icon:'🏟️', family:'clubs_count' });
  candidates.push({ type:'fee_gt', value:70000000, label:'Traspaso de más de 70M €',   imgUrl:null, icon:'💰', family:'fee' });
  candidates.push({ type:'fee_lt', value:70000000, label:'Traspaso de menos de 70M €', imgUrl:null, icon:'💰', family:'fee' });
  candidates.push({ type:'champions_goals_ge', value:10, label:'10+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });
  candidates.push({ type:'champions_goals_ge', value:20, label:'20+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });
  candidates.push({ type:'champions_goals_ge', value:30, label:'30+ goles en Champions', imgUrl:null, icon:'⭐', family:'champions_goals' });
  candidates.push({ type:'season_goals_ge', value:10, label:'10+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });
  candidates.push({ type:'season_goals_ge', value:20, label:'20+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });
  candidates.push({ type:'season_goals_ge', value:30, label:'30+ goles en una temporada de liga', imgUrl:null, icon:'⚽', family:'season_goals' });
  candidates.push({ type:'natGoals_ge', value:20, label:'20+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });
  candidates.push({ type:'natGoals_ge', value:30, label:'30+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });
  candidates.push({ type:'natGoals_ge', value:50, label:'50+ goles con su selección', imgUrl:null, icon:'🌍', family:'nat_goals' });
  candidates.push({ type:'region', value:'oriente_medio',label:'Ha jugado en Oriente Medio', imgUrl:null, icon:'🌎', family:'region' });
  candidates.push({ type:'league_any', value:['MLS1','MEX1'], label:'Ha jugado en MLS/Liga MX', imgUrl:sbStorageUrl('league-logos','UsaMexico.png'), icon:'⚽', family:'league_general' });
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
  if (rA.type === 'club' && rB.type === 'region') {
    const c = CLUBS_LIST.find(c => c.tmName === rA.value);
    if (c && c.region === rB.value) return true;
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

  /* Pie: dos restricciones de foot distintas no pueden coexistir */
  if (rA.type === 'foot' && rB.type === 'foot') return true;

  /* Altura: incompatibilidades */
  if (rA.type === 'height_le' && rB.type === 'height_ge') return true;
  if (rA.type === 'height_ge' && rB.type === 'height_le') return true;
  if (rA.type === 'height_ge' && rB.type === 'height_ge' && rA.value > rB.value) return true;

  return false;
}

function _removeRedundancies(restrictions, shuffledPool, db) {
  let result = [...restrictions];
  let changed = true;
  while (changed) {
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
  /* Pre-filtrar DB a jugadores que cumplen los clubs fijos.
     Reduce db de ~8000 a ~50-200, acelerando hasSolution 40-100x. */
  const clubRestrictions = restrictions.filter(r => r.type === 'club');
  const filteredDB = clubRestrictions.length > 0
    ? db.filter(p => clubRestrictions.every(cr => validate(p, cr)))
    : db;
  const hasSolution = (rs) => {
    const nonClub = rs.filter(r => r.type !== 'club');
    return filteredDB.some(p => nonClub.every(r => validate(p, r)));
  };
  if (hasSolution(restrictions)) return restrictions;
  const result = [...restrictions];
  const swappableIdx = result.map((_, i) => i).filter(i => result[i].type !== 'club');
  for (const idx of swappableIdx) {
    const original = result[idx];
    for (const candidate of shuffledPool) {
      if (result.includes(candidate)) continue;
      const wouldBeRedundant = result.some((r, i) => i !== idx && (_isRedundant(r, candidate) || _isRedundant(candidate, r)));
      if (wouldBeRedundant) continue;
      result[idx] = candidate;
      if (hasSolution(result)) return result;
    }
    result[idx] = original;
  }
  for (let idx = 0; idx < result.length; idx++) {
    if (swappableIdx.includes(idx)) continue;
    const original = result[idx];
    for (const candidate of shuffledPool) {
      if (result.includes(candidate)) continue;
      result[idx] = candidate;
      if (hasSolution(result)) return result;
    }
    result[idx] = original;
  }
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
    if (hasSolution(nuclear)) { usedFamilies[fam] = (usedFamilies[fam] || 0) + 1; }
    else { nuclear.pop(); }
  }
  for (const candidate of nonClubPool) {
    if (nuclear.length >= 5) break;
    if (nuclear.includes(candidate)) continue;
    if (nuclear.some(r => _isRedundant(r, candidate) || _isRedundant(candidate, r))) continue;
    nuclear.push(candidate);
    if (!hasSolution(nuclear)) nuclear.pop();
  }
  if (hasSolution(nuclear) && nuclear.length === 5) return nuclear;
  return nuclear.length >= 2 ? nuclear : result;
}

const _ONECLUB_PROB = 0.02;   // muy poco frecuente: ~1 de cada 50 rondas

function generate(seed, db) {
  const rng = _mulberry32(seed);
  const shuffledClubs = _shuffle(CLUBS_LIST, rng);

  /* ── B: Pre-filtrar pares de clubs por intersección mínima ──
     Elegir club1 y luego buscar club2 que tenga ≥ MIN_PAIR jugadores
     en común con club1 en la DB. */
  const MIN_PAIR = Math.min(4, Math.max(2, Math.floor(db.length / 100)));
  const clubRestrictions = [];

  /* Club 1 — el primero que tenga al menos 1 jugador */
  let club1 = null;
  for (const club of shuffledClubs) {
    const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
    if (_matching(r, db, 1) >= 1) { club1 = { r, meta: club }; break; }
  }
  if (!club1) {
    club1 = { r:{ type:'club', value:shuffledClubs[0].tmName, label:`Ha jugado en ${shuffledClubs[0].display}`, imgUrl:shuffledClubs[0].logoUrl, icon:'🏟️', family:'club' }, meta:shuffledClubs[0] };
  }
  clubRestrictions.push(club1.r);

  /* ── One Club Man (~2%): sustituye el slot de "club 2" por "toda su
     carrera en un solo club", igual que la liga lo hace con 15%. Nunca
     cambia el total de restricciones (siguen siendo 5 siempre) — solo
     aplica si el club1 elegido tiene ≥2 one-club-men reales en la BD.
     DEBE ser idéntico al de coche/js/script.js para que el seed sea determinista. */
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

  /* ── C: Con ~15% de probabilidad, sustituir el segundo club por una liga
     (siempre de una liga DISTINTA a la del club1; solo si el slot 2 no lo
     ocupó ya One Club Man) ── */
  const useLeagueAsSecond = clubRestrictions.length < 2 && rng() < 0.15;

  if (useLeagueAsSecond) {
    const club1League = club1.meta.league;
    const otherLeagues = Object.entries(LEAGUE_CIDS).filter(([lg]) => lg !== club1League);
    if (otherLeagues.length > 0) {
      const shuffledLeagues = _shuffle(otherLeagues, rng);
      for (const [liga, cid] of shuffledLeagues) {
        const lr = { type:'league', value:liga, cid, teams:LEAGUE_TEAMS[liga]||[], label:`Ha jugado en ${liga}`, imgUrl:LEAGUE_LOGOS[liga]||null, icon:'⚽', family:'league' };
        /* Comprobar que hay intersección con club1 */
        if (db.some(p => validate(p, club1.r) && validate(p, lr))) {
          clubRestrictions.push(lr);
          break;
        }
      }
    }
    /* Si no se encontró liga válida, caer en club normal */
  }

  /* Club 2 (si no se usó liga) — buscar con intersección ≥ MIN_PAIR */
  if (clubRestrictions.length < 2) {
    for (const club of shuffledClubs) {
      if (club.tmName === club1.meta.tmName) continue;
      const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
      /* B: Contar intersección con club1 */
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

  /* Fallback: si ningún par cumple MIN_PAIR, relajar a ≥ 1 */
  if (clubRestrictions.length < 2) {
    for (const club of shuffledClubs) {
      if (club.tmName === club1.meta.tmName) continue;
      const r = { type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' };
      if (db.some(p => validate(p, club1.r) && validate(p, r))) {
        clubRestrictions.push(r); break;
      }
    }
  }
  /* Último fallback: cualquier club distinto */
  if (clubRestrictions.length < 2) {
    for (const club of CLUBS_LIST) {
      if (club.tmName !== club1.meta.tmName) {
        clubRestrictions.push({ type:'club', value:club.tmName, label:`Ha jugado en ${club.display}`, imgUrl:club.logoUrl, icon:'🏟️', family:'club' });
        break;
      }
    }
  }

  /* ── D: Selección ponderada por familia ──
     En vez de barajar todo el pool y tomar los primeros,
     elegir primero una FAMILIA al azar (todas con igual probabilidad)
     y luego un candidato random de esa familia. */
  const candidates = _buildCandidates(rng, db);
  const playable = candidates.filter(r => _matching(r, db) >= (r.type === 'teammate' ? 1 : 2));

  /* Agrupar por familia */
  const familyGroups = {};
  for (const r of playable) {
    const fam = r.family || r.type;
    if (!familyGroups[fam]) familyGroups[fam] = [];
    familyGroups[fam].push(r);
  }
  /* No incluir la familia del slot 2 si fue liga o One Club Man */
  const usedFamilies = new Set();
  if (clubRestrictions.length === 2 && clubRestrictions[1].type === 'league') {
    usedFamilies.add('league');
  } else if (clubRestrictions.length === 2 && clubRestrictions[1].type === 'one_club') {
    usedFamilies.add('clubs_count');
  }

  const familyNames = _shuffle(
    Object.keys(familyGroups).filter(f => {
      if (!usedFamilies.has(f)) {
        if (f === 'position') return rng() < 0.50; // sale ~mitad de veces
        return true;
      }
      return false;
    }),
    rng
  );

  const chosen = [];
  /* Ronda 1: una restricción de cada familia distinta */
  for (const fam of familyNames) {
    if (chosen.length >= 3) break;
    const group = _shuffle(familyGroups[fam], rng);
    const pick = group[0];
    if (pick) { chosen.push(pick); usedFamilies.add(fam); }
  }
  /* Ronda 2: si faltan, repetir familias */
  if (chosen.length < 3) {
    const remaining = _shuffle(playable.filter(r => !chosen.includes(r)), rng);
    for (const r of remaining) {
      if (chosen.length >= 3) break;
      chosen.push(r);
    }
  }

  let result = [...clubRestrictions, ...chosen.slice(0, 3)];
  const shuffled = _shuffle(playable, rng); /* pool para reemplazos */
  result = _removeRedundancies(result, shuffled, db);
  if (rng() < 0.70) result = _ensureSolution(result, shuffled, db);
  return result;
}

/* ── Entrada del worker ── */
self.onmessage = function({ data }) {
  /* Reconstruir Sets desde arrays (structured clone no preserva Set) */
  _REVERSE_TEAMMATE = {};
  for (const [k, v] of Object.entries(data.reverseTeammate || {})) {
    _REVERSE_TEAMMATE[k] = new Set(v);
  }
  _REVERSE_TEAMMATE_IDS = {};
  for (const [k, v] of Object.entries(data.reverseTeammateIds || {})) {
    _REVERSE_TEAMMATE_IDS[k] = new Set(v);
  }
  try {
    const restrictions = generate(data.seed, data.db);
    self.postMessage({ ok: true, restrictions });
  } catch(e) {
    self.postMessage({ ok: false, error: e.message });
  }
};
