/* =============================================================================
   SUPERDRAFT — script principal
   Motor de restricciones compartido: window.FR (js/futbol-restrictions.js)
   -----------------------------------------------------------------------------
   Cada dia: un OBJETIVO-metrica fijo (evaluado como SUMA sobre los once) y una
   FORMACION que rota. Cada ronda la tragaperras para en un BADGE (club, liga o
   nacionalidad). Eliges un jugador que cumpla el badge y encaje por POSICION en
   una linea con hueco libre; su valor de la metrica se suma al marcador.

   Reglas de badge (semantica):
     nacionalidad -> historico (nationalTeam)
     club         -> SIEMPRE club actual (chunk.club)
     liga         -> liga del club actual

   QUIEN VALE: por defecto SOLO jugadores en activo (club actual + valor de
   mercado). Las unicas excepciones son los objetivos de seleccion
   (internacionalidades y goles con la seleccion), donde los nombres que
   importan son casi todos retirados: esos llevan retiredOk:true. El mismo
   criterio filtra el autocompletado, para no ofrecer a nadie que luego se
   vaya a rechazar.
   ============================================================================= */
'use strict';

(function () {

  /* ─────────── Utilidades ─────────── */
  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const norm = (s) => FR.normalize(s || '');

  /* Ano de referencia para la edad (fijo, para que el archivo no "envejezca"). */
  const SEASON_YEAR = 2026;
  /* Dia 1 = fecha de lanzamiento. */
  const EPOCH_UTC = Date.UTC(2026, 7, 4);   // 2026-08-04

  /* Hoy en hora de MADRID, no en la del dispositivo: el resto de diarios
     (La Carrera, En el Top, En el Once, El Estadio, Crucigrama) cambian de
     día a medianoche española, y si Superdraft cambiara a otra hora la
     racha del hub se partiría sola para quien juegue desde otro huso. */
  function todayMadrid() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid'
    }).format(new Date()); // "YYYY-MM-DD"
  }

  function todayNumber() {
    const [y, m, d] = todayMadrid().split('-').map(Number);
    const todayUTC = Date.UTC(y, m - 1, d);
    return Math.max(1, Math.floor((todayUTC - EPOCH_UTC) / 86400000) + 1);
  }

  /* Dentro del juego la edicion es un NUMERO (#17), pero en la URL va la FECHA,
     como en el resto de diarios: '?dia=2026-08-20' se entiende y se comparte,
     '?dia=17' no dice nada y ademas se rompe el dia que se mueva el EPOCH. */
  function fechaDeDia(n) {
    return new Date(EPOCH_UTC + (n - 1) * 86400000).toISOString().slice(0, 10);
  }
  function diaDeFecha(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.floor((Date.UTC(y, m - 1, d) - EPOCH_UTC) / 86400000) + 1;
  }

  /* ─────────── Objetivos (metrica del dia, todo SUMA) ─────────── */
  /* families: badges que pueden salir.
     retiredOk: unica excepcion a "solo jugadores en activo" (ver cabecera). */
  const OBJECTIVES = [
    { key:'age_old',    metric:'age',    dir:'max', title:'EL ONCE MÁS VIEJO',           short:'MÁS VIEJO',   unit:'años',    families:['nat','club','league'] },
    { key:'age_young',  metric:'age',    dir:'min', title:'EL ONCE MÁS JOVEN',           short:'MÁS JOVEN',   unit:'años',    families:['nat','club','league'] },
    { key:'height_tall',metric:'height', dir:'max', title:'EL ONCE MÁS ALTO',            short:'MÁS ALTO',    unit:'cm',      families:['nat','club','league'] },
    { key:'height_low', metric:'height', dir:'min', title:'EL ONCE MÁS BAJO',            short:'MÁS BAJO',    unit:'cm',      families:['nat','club','league'] },
    { key:'mv_high',    metric:'mv',     dir:'max', title:'EL ONCE MÁS CARO',            short:'MÁS CARO',    unit:'€',       families:['nat','club','league'] },
    { key:'caps',       metric:'caps',   dir:'max', title:'MÁS INTERNACIONALIDADES',     short:'INTERNAC.',   unit:'caps',    families:['nat'], retiredOk:true },
    { key:'natgoals',   metric:'natGoals',dir:'max',title:'MÁS GOLES CON LA SELECCIÓN',  short:'GOLES SEL.',  unit:'goles',   families:['nat'], retiredOk:true },
    { key:'goals',      metric:'goals',  dir:'max', title:'MÁS GOLES EN SU CARRERA',     short:'GOLES',       unit:'goles',   families:['nat','club','league'] },
    { key:'apps',       metric:'apps',   dir:'max', title:'MÁS PARTIDOS EN SU CARRERA',  short:'PARTIDOS',    unit:'part.',   families:['nat','club','league'] },
    { key:'clg',        metric:'clg',    dir:'max', title:'MÁS GOLES EN CHAMPIONS',      short:'GOLES UCL',   unit:'goles',   families:['club','league'] },
  ];

  /* En activo = tiene club actual Y valor de mercado. Solo con el club se
     colarian los ex-profesionales que acaban en equipos de barrio (el scraper
     les guarda ese club), y solo con el mv se colarian los que estan sin
     equipo. Vale tanto para un jugador completo como para la ficha ligera del
     autocompletado, porque los dos campos se llaman igual. */
  function isActive(p) { return !!(p && p.club && p.mv > 0); }
  function activeRequired(obj) { return !(obj && obj.retiredOk); }

  /* ─────────── Formaciones (rotan cada dia). GK siempre 1. ─────────── */
  const FORMATIONS = [
    { name:'3-4-3', DEF:3, MID:4, FWD:3 },
    { name:'4-4-2', DEF:4, MID:4, FWD:2 },
    { name:'4-3-3', DEF:4, MID:3, FWD:3 },
    { name:'3-5-2', DEF:3, MID:5, FWD:2 },
    { name:'5-3-2', DEF:5, MID:3, FWD:2 },
    { name:'4-5-1', DEF:4, MID:5, FWD:1 },
  ];

  const LINE_LABEL = { GK:'PORTERÍA', DEF:'DEFENSA', MID:'MEDIOCAMPO', FWD:'DELANTERA' };

  /* ─────────── Posicion -> linea del campo ─────────── */
  function posBucket(p) {
    const s = String(p && p.position || '').toUpperCase().trim();
    if (!s) return null;
    if (s.includes('GK')  || s === 'POR') return 'GK';
    if (s.includes('DEF') || s === 'DF')  return 'DEF';
    if (s.includes('MID') || s === 'MED' || s === 'MF') return 'MID';
    if (s.includes('FWD') || s.includes('ATT') || s === 'DEL' || s === 'FW') return 'FWD';
    return null;
  }

  /* ─────────── Metrica de un jugador ─────────── */
  function metricValue(p, metric) {
    switch (metric) {
      case 'age':      return p.birthYear ? (SEASON_YEAR - p.birthYear) : 0;
      case 'height':   return p.heightCm || 0;
      case 'mv':       return p.mv || 0;
      case 'caps':     return p.caps || 0;
      case 'natGoals': return p.natGoals || 0;
      case 'goals':    return p.goals || 0;
      case 'apps':     return p.apps || 0;
      case 'clg':      return p.clg || 0;
      default:         return 0;
    }
  }

  function fmtEuro(v) {
    if (!v) return '0';
    if (v >= 1e6) { const m = v / 1e6; return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + 'M'; }
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(v);
  }
  /* Etiqueta corta para el pill sobre el badge del jugador colocado. */
  function fmtChip(v, metric) {
    if (metric === 'mv') return fmtEuro(v);
    return String(v);
  }
  /* Marcador total (esquina). */
  function fmtTotal(v, obj) {
    if (obj.metric === 'mv') return fmtEuro(v) + ' €';
    return v + ' ' + obj.unit;
  }

  /* ─────────── Pools de badges — SOLO Superdraft ───────────
     Whitelists propias: no afectan a Coche ni a Tres en Raya (que siguen
     usando las constantes completas de FR). Para añadir/quitar, edita estos
     conjuntos. Nacionalidades extra llevan su bandera (team-flags) + adjetivo. */
  const NAT_KEEP = new Set([
    'Spain','England','France','Argentina','Germany','Brazil',
    'Netherlands','Italy','Uruguay','Senegal','Morocco',
  ]);
  const NAT_EXTRA = [
    { kind:'nat', value:'Portugal', label:'Portugués',  img:sbStorageUrl('team-flags','pt.png') },
    { kind:'nat', value:'Colombia', label:'Colombiano', img:sbStorageUrl('team-flags','co.png') },
  ];
  const LEAGUE_KEEP = new Set(['La Liga','Premier League','Serie A','Bundesliga','Ligue 1']);
  const CLUB_KEEP = new Set([
    // Premier
    'Arsenal FC','Manchester City','Manchester United','Aston Villa','Liverpool FC','Chelsea FC','Tottenham Hotspur','Newcastle United',
    // La Liga
    'FC Barcelona','Real Madrid','Atlético de Madrid','Valencia CF','Sevilla FC','Real Betis Balompié','Villarreal CF','Athletic Bilbao','Real Sociedad',
    // Serie A
    'Juventus FC','AS Roma','AC Milan','Inter Milan','SSC Napoli','SS Lazio','Atalanta BC',
    // Bundesliga
    'Bayern Munich','Borussia Dortmund','Bayer 04 Leverkusen',
    // Ligue 1
    'Paris Saint-Germain','AS Monaco','Olympique Lyon','Olympique Marseille',
  ]);

  function buildBadgePools(families) {
    const pools = [];
    if (families.includes('nat')) {
      for (const n of FR.NATIONALITIES)
        if (NAT_KEEP.has(n.tmNat)) pools.push({ kind:'nat', value:n.tmNat, label:n.adj, img:n.flagImg });
      for (const n of NAT_EXTRA) pools.push({ ...n });
    }
    if (families.includes('club')) {
      for (const c of FR.CLUBS_LIST)
        if (CLUB_KEEP.has(c.tmName)) pools.push({ kind:'club', value:c.tmName, label:c.display, img:c.logoUrl });
    }
    if (families.includes('league')) {
      for (const liga of Object.keys(FR.LEAGUE_CIDS))
        if (LEAGUE_KEEP.has(liga)) pools.push({ kind:'league', value:liga, label:liga, img:FR.LEAGUE_LOGOS[liga] || null,
                     teams:FR.LEAGUE_TEAMS[liga] || [] });
    }
    return pools;
  }

  /* ¿El jugador cumple el badge? (semantica descrita arriba). */
  function matchesBadge(p, badge, obj) {
    if (activeRequired(obj) && !isActive(p)) return false;
    if (badge.kind === 'nat')    return norm(p.nationalTeam) === norm(badge.value);
    if (badge.kind === 'club')   return !!p.club && norm(p.club) === norm(badge.value);
    if (badge.kind === 'league') return !!p.club && (badge.teams || []).some(t => norm(t) === norm(p.club));
    return false;
  }

  /* Nº de jugadores del pool que cumplen badge Y son de la posicion pedida. */
  function countFor(badge, obj, pos, pool, min) {
    const lim = min || 1;
    let c = 0;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (posBucket(p) === pos && matchesBadge(p, badge, obj)) { if (++c >= lim) return c; }
    }
    return c;
  }

  /* ─────────── Generacion del dia (determinista) ─────────── */
  function generateDay(day) {
    const seed = ((day * 2654435761) ^ 0x9e3779b9) >>> 0;
    const rng  = FR.rng.mulberry32(seed);
    const objective = OBJECTIVES[Math.floor(rng() * OBJECTIVES.length)];
    const formation = FORMATIONS[Math.floor(rng() * FORMATIONS.length)];

    const reqPos = ['GK',
      ...Array(formation.DEF).fill('DEF'),
      ...Array(formation.MID).fill('MID'),
      ...Array(formation.FWD).fill('FWD')];
    const order  = FR.rng.shuffle(reqPos, rng);

    const pools = buildBadgePools(objective.families);
    const all   = FR.getAllPlayers();
    const gen   = FR.genPool;

    const badges = [];
    const used   = new Set();
    /* Cuantas veces ha salido ya ESE badge para ESA posicion. Un jugador solo
       se puede usar una vez en la partida, asi que repetir "portero del
       Atlético" cuando solo hay un portero en activo deja la ronda sin
       solucion: se exige un candidato mas por cada repeticion. */
    const usedPos = new Map();
    const need = (b, pos) => (usedPos.get(b.kind + ':' + b.value + '|' + pos) || 0) + 1;
    for (const pos of order) {
      let best = null, bestScore = -1;
      for (let t = 0; t < 60; t++) {
        const b = pools[Math.floor(rng() * pools.length)];
        const key = b.kind + ':' + b.value;
        const min = need(b, pos);
        const allC = countFor(b, objective, pos, all, min + 2);
        if (allC < min) continue;                  // sin solucion posible -> descartar
        const genC = countFor(b, objective, pos, gen, 1);   // ¿reconocible?
        let score = allC + (genC > 0 ? 1000 : 0) + (used.has(key) ? -500 : 0);
        if (score > bestScore) { bestScore = score; best = b; }
        if (genC > 0 && !used.has(key)) break;     // suficientemente bueno
      }
      if (!best) {
        // Fallback: cualquiera que aun tenga jugadores libres para esa posicion.
        for (const b of FR.rng.shuffle(pools, rng)) {
          const min = need(b, pos);
          if (countFor(b, objective, pos, all, min) >= min) { best = b; break; }
        }
        best = best || pools[0];
      }
      used.add(best.kind + ':' + best.value);
      const pk = best.kind + ':' + best.value + '|' + pos;
      usedPos.set(pk, (usedPos.get(pk) || 0) + 1);
      badges.push({ ...best, pos });
    }
    return { day, objective, formation, badges, order };
  }

  /* ═══════════════════ ESTADO ═══════════════════ */
  let dataReady = false;
  let curDay    = null;   // nº de dia mostrado
  let maxDay    = null;   // hoy
  let D = null;           // definicion generada del dia
  let S = null;           // estado de partida

  function freshState(def) {
    const lines = {
      GK:  Array(1).fill(null),
      DEF: Array(def.formation.DEF).fill(null),
      MID: Array(def.formation.MID).fill(null),
      FWD: Array(def.formation.FWD).fill(null),
    };
    return { lines, usedIds: new Set(), round: 0, total: 0, over: false, spinning: false, curBadge: null, pickSlot: null };
  }

  /* ═══════════════════ TOAST ═══════════════════ */
  let _toastT = null;
  function toast(msg, kind) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (kind === 'err' ? ' error' : kind === 'warn' ? ' warning' : '');
    clearTimeout(_toastT);
    _toastT = setTimeout(() => { t.className = 'toast'; }, 2200);
  }

  /* ═══════════════════ RENDER: CAMPO ═══════════════════ */
  function pitchLinesHtml() {
    return `<div class="pitch-lines">
      <div class="pl-bounds"></div><div class="pl-half"></div><div class="pl-circle"></div>
      <div class="pl-spot pl-spot-c"></div>
      <div class="pl-pbox pl-top"></div><div class="pl-pbox pl-bottom"></div>
      <div class="pl-gbox pl-top"></div><div class="pl-gbox pl-bottom"></div>
      <div class="pl-arc pl-arc-top"></div><div class="pl-arc pl-arc-bottom"></div>
      <div class="pl-goal pl-top"></div><div class="pl-goal pl-bottom"></div>
      <div class="pl-corner pl-tl"></div><div class="pl-corner pl-tr"></div>
      <div class="pl-corner pl-bl"></div><div class="pl-corner pl-br"></div>
    </div>`;
  }

  function slotHtml(cell, bucket, idx) {
    if (!cell) {
      const active = (!S.spinning && !S.over);
      return `<div class="sd-slot sd-slot--empty${active ? ' sd-slot--active' : ''}"${active ? ` onclick="SD.openPick('${bucket}',${idx})"` : ''}>
        <div class="sd-badge sd-badge--empty">+</div></div>`;
    }
    const img = cell.badge.img
      ? `<img src="${esc(cell.badge.img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '';
    const val = fmtChip(metricValue(cell.player, D.objective.metric), D.objective.metric);
    return `<div class="sd-slot sd-slot--filled">
      <div class="sd-badge sd-badge--${esc(cell.badge.kind)}">${img}<span class="sd-val">${esc(val)}</span></div>
      <div class="sd-name">${esc(shortName(cell.player.name))}</div>
    </div>`;
  }

  function lineHtml(bucket) {
    const cells = S.lines[bucket];
    return `<div class="sd-line sd-line--${bucket.toLowerCase()}">${cells.map((c, i) => slotHtml(c, bucket, i)).join('')}</div>`;
  }

  function renderField() {
    const wrap = $('sd-field');
    wrap.innerHTML = pitchLinesHtml() +
      `<div class="sd-formation">
        ${lineHtml('FWD')}${lineHtml('MID')}${lineHtml('DEF')}${lineHtml('GK')}
      </div>
      <div class="sd-corner sd-corner--left">
        <div class="sd-corner-k">PARTIDA Nº ${D.day}</div>
        <div class="sd-corner-v">${D.formation.name}</div>
      </div>
      <div class="sd-corner sd-corner--right">
        <div class="sd-corner-k">${esc(D.objective.short)}</div>
        <div class="sd-corner-v">${esc(fmtTotal(S.total, D.objective))}</div>
      </div>`;
  }

  function shortName(name) {
    const parts = String(name || '').trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0][0] + '. ' + parts.slice(1).join(' ');
  }

  /* ═══════════════════ TRAGAPERRAS (reel) ═══════════════════
     La tirada es UN transform sobre una tira vertical de escudos, con
     desaceleracion. La version anterior cambiaba el src del mismo <img> siete
     veces con setTimeout y forzaba un reflow (void offsetWidth) en cada
     cambio: como los PNG no estaban precargados, cada fotograma pedia su
     imagen a Storage y se veia el hueco en blanco hasta que bajaba, asi que la
     tragaperras iba a tirones. Ahora las imagenes se precargan al cargar el
     dia y el navegador compone la tirada en GPU, sin un solo reflow. */
  const REEL_CELL   = 132;   // alto de .sd-reel-cell en css/style.css
  const REEL_FRAMES = 14;    // escudos que pasan antes del objetivo
  const REEL_MS     = 2400;
  let _reelImgs = [], _reelPreload = [], _reelTimer = null, _reelDestino = 0;

  function buildReelImages() {
    const pools = buildBadgePools(D.objective.families);
    _reelImgs = pools.map(b => b.img).filter(Boolean);
    /* Se guardan las referencias a proposito: un Image() sin referencia lo
       puede tirar el recolector y la precarga no serviria de nada. */
    _reelPreload = _reelImgs.map(src => {
      const im = new Image();
      im.decoding = 'async';
      im.src = src;
      return im;
    });
  }

  function _sinMovimiento() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function startRound() {
    if (S.over) return;
    const badge = D.badges[S.round];
    S.curBadge = badge;
    S.spinning = true;
    renderField();                 // deshabilita clicks en los slots mientras gira
    const cap = $('sd-reel-label');
    cap.textContent = '';
    cap.classList.remove('locked');

    if (_reelTimer) { clearTimeout(_reelTimer); _reelTimer = null; }

    const strip = $('sd-reel-strip');
    const pool  = _reelImgs.filter(Boolean);
    const rapido = _sinMovimiento() || pool.length === 0;

    const frames = [];
    if (!rapido) {
      for (let k = 0; k < REEL_FRAMES; k++) frames.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    frames.push(badge.img);        // ultimo = objetivo, donde para

    const celda = (src) => `<div class="sd-reel-cell">${
      src ? `<img src="${esc(src)}" alt="" onerror="this.style.visibility='hidden'">` : ''}</div>`;

    strip.style.transition = 'none';
    strip.style.transform  = 'translate3d(0,0,0)';
    strip.innerHTML = frames.map(celda).join('');
    void strip.offsetHeight;       // un unico reflow para fijar el punto de partida

    const dur  = rapido ? 200 : REEL_MS;
    const dist = (frames.length - 1) * REEL_CELL;
    _reelDestino = dist;
    strip.style.transition = `transform ${dur}ms cubic-bezier(.16,.62,.16,1)`;
    strip.style.transform  = `translate3d(0,-${dist}px,0)`;

    /* transitionend + red de seguridad: si la pestaña esta en segundo plano o
       la transicion se cancela, el evento puede no llegar y la ronda se
       quedaria colgada con los slots deshabilitados. */
    let hecho = false;
    const fin = () => {
      if (hecho) return;
      hecho = true;
      strip.removeEventListener('transitionend', fin);
      if (_reelTimer) { clearTimeout(_reelTimer); _reelTimer = null; }
      lockBadge(badge);
    };
    strip.addEventListener('transitionend', fin);
    _reelTimer = setTimeout(fin, dur + 400);
  }

  function lockBadge(badge) {
    S.spinning = false;
    /* Clavar la tira en su sitio sin transicion: si la animacion se cancelo o
       nunca llego a correr (pestaña en segundo plano, y entonces cierra la red
       de seguridad y no transitionend), el escudo que se ve tiene que ser el
       del badge igualmente, no el fotograma en el que se quedo. */
    const strip = $('sd-reel-strip');
    if (strip) {
      strip.style.transition = 'none';
      strip.style.transform  = `translate3d(0,-${_reelDestino}px,0)`;
    }
    const cap = $('sd-reel-label');
    cap.textContent = badge.label;
    cap.classList.add('locked');
    const reel = $('sd-reel');
    reel.classList.add('locked');
    setTimeout(() => reel.classList.remove('locked'), 420);
    renderField();                 // ahora los slots vuelven a ser clicables
  }

  /* ═══════════════════ AUTOCOMPLETADO + ENVIO ═══════════════════ */
  let acItems = [], acIndex = -1;

  /* Nombres repetidos (dos "Koke", dos "Rodri"...): sin nada mas escrito son
     dos filas identicas y elegir bien es imposible. Desambiguacion EN CASCADA,
     igual que Coche y En la Cadena: la posicion siempre, y solo si sigue
     habiendo empate se añade la nacion y despues el año de nacimiento. El club
     NO se enseña: es dato de juego (los badges van de clubes), no una pista. */
  const POS_ES = { GK:'Portero', DEF:'Defensa', MID:'Centrocampista', FWD:'Delantero' };
  function acHint(it, sameName) {
    const bits = [];
    const bucket = posBucket(it);
    if (bucket) bits.push(POS_ES[bucket] || bucket);
    if (sameName.length > 1) {
      const samePos = sameName.filter(o => posBucket(o) === bucket);
      if (samePos.length > 1 && it.nationalTeam) {
        bits.push(it.nationalTeam);
        const sameNat = samePos.filter(o => o.nationalTeam === it.nationalTeam);
        if (sameNat.length > 1 && it.birthYear) bits.push('n. ' + it.birthYear);
      }
    }
    return bits.join(' · ');
  }

  function onInput() {
    const q = ($('player-input').value || '').trim();
    const list = $('autocomplete-list');
    if (q.length < 2) { list.classList.add('hidden'); acItems = []; return; }
    const soloActivos = activeRequired(D && D.objective);
    acItems = FR.suggest(q, 8, { filter: (m) => !soloActivos || isActive(m) });
    acIndex = 0;                               // primera preseleccionada -> Enter la elige
    if (!acItems.length) { list.classList.add('hidden'); return; }
    const porNombre = {};
    for (const it of acItems) (porNombre[norm(it.name)] = porNombre[norm(it.name)] || []).push(it);
    list.innerHTML = acItems.map((it, idx) => {
      const hint = acHint(it, porNombre[norm(it.name)]);
      return `<div class="autocomplete-item${idx === 0 ? ' selected' : ''}" data-idx="${idx}" onmousedown="event.preventDefault();SD.pick(${idx})">${esc(it.name)}${
        hint ? `<span class="ac-hint">${esc(hint)}</span>` : ''}</div>`;
    }).join('');
    list.classList.remove('hidden');
  }
  function paintAc() {
    document.querySelectorAll('.autocomplete-item').forEach((el, idx) =>
      el.classList.toggle('selected', idx === acIndex));
  }
  function onKey(e) {
    const list = $('autocomplete-list');
    const visible = !list.classList.contains('hidden') && acItems.length;
    if (e.key === 'ArrowDown' && visible) { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); paintAc(); }
    else if (e.key === 'ArrowUp' && visible) { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); paintAc(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible && acIndex >= 0) pick(acIndex);
      else submit();
    } else if (e.key === 'Escape') { list.classList.add('hidden'); }
  }
  function pick(idx) {
    const it = acItems[idx]; if (!it) return;
    $('player-input').value = it.name;
    $('autocomplete-list').classList.add('hidden');
    submit(it.id);                    // por ID: el nombre solo no distingue homonimos
  }

  /* Abre el modal de busqueda para un slot concreto (posicion elegida). */
  function openPick(bucket, idx) {
    if (!S || S.spinning || S.over) return;
    if (S.lines[bucket][idx]) return;   // ya ocupado
    S.pickSlot = { bucket, idx };
    $('sd-modal-sub').textContent = `${LINE_LABEL[bucket]} · ${S.curBadge ? S.curBadge.label : ''}`
      + (activeRequired(D.objective) ? ' · SOLO EN ACTIVO' : '');
    const input = $('player-input');
    input.value = ''; input.disabled = false;
    acItems = []; acIndex = -1;
    $('autocomplete-list').classList.add('hidden');
    $('pick-modal').classList.remove('hidden');
    setTimeout(() => input.focus(), 40);
  }
  function closePick() {
    $('pick-modal').classList.add('hidden');
    if (S) S.pickSlot = null;
  }

  /* Nombre escrito a mano (Enter sin elegir de la lista). Entre los homonimos
     se queda con el que tenga sentido para la ronda: primero el que cumple el
     badge, luego cualquiera que este en activo. Si no hay ninguno, se deja el
     de siempre para que el mensaje de error sea el correcto. */
  async function resolveTyped(name) {
    const n = norm(name);
    const cands = FR.suggest(name, 12).filter(it => norm(it.name) === n);
    if (cands.length > 1) {
      const ok = cands.find(it => matchesBadge(it, S.curBadge, D.objective))
              || cands.find(it => isActive(it));
      if (ok) return FR.resolvePlayerById(ok.id);
    }
    return FR.resolvePlayer(name);
  }

  async function submit(pickedId) {
    if (!S || S.over || S.spinning || !S.pickSlot) return;
    const input = $('player-input');
    const name = (input.value || '').trim();
    if (!name) return;
    input.disabled = true;
    try {
      const player = pickedId ? await FR.resolvePlayerById(pickedId) : await resolveTyped(name);
      if (!player) { toast('No encuentro ese futbolista', 'err'); return; }
      if (S.usedIds.has(String(player.id))) { toast(`${player.name} ya lo has usado`, 'err'); return; }

      const badge = S.curBadge;
      if (!matchesBadge(player, badge, D.objective)) {
        if (activeRequired(D.objective) && !isActive(player))
          toast(`${player.name} no está en activo (este objetivo es solo de jugadores en activo)`, 'err');
        else if (badge.kind === 'club' || badge.kind === 'league')
          toast(`${player.name} no juega actualmente en ${badge.label}`, 'err');
        else
          toast(`${player.name} no es ${badge.label.toLowerCase()}`, 'err');
        return;
      }

      const { bucket, idx } = S.pickSlot;
      if (posBucket(player) !== bucket) {
        toast(`${player.name} no juega de ${LINE_LABEL[bucket].toLowerCase()}`, 'warn'); return;
      }
      if (S.lines[bucket][idx]) { toast('Ese puesto ya está ocupado', 'warn'); return; }

      // Colocar en el slot elegido
      S.lines[bucket][idx] = { player, badge };
      S.usedIds.add(String(player.id));
      S.total += metricValue(player, D.objective.metric);
      S.round++;
      closePick();
      renderField();
      toast(`✓ ${shortName(player.name)}`, 'ok');

      if (S.round >= 11) { finish(); }
      else { startRound(); }
    } catch (e) {
      console.error(e); toast('Error al comprobar', 'err');
    } finally {
      if (S && !S.over && S.pickSlot) { input.disabled = false; }
    }
  }

  /* ═══════════════════ FIN ═══════════════════ */
  function finish() {
    S.over = true;
    closePick();
    const best = saveBest(D.day, S.total, D.objective.dir);
    saveDaily(D.day, S.total, D.objective);
    $('sd-end-title').textContent = D.objective.title;
    $('sd-end-total').textContent = fmtTotal(S.total, D.objective);
    const isBest = (D.objective.dir === 'min') ? (S.total <= best) : (S.total >= best);
    $('sd-end-best').textContent = isBest
      ? '¡Tu mejor marca de este día!'
      : `Tu mejor marca: ${fmtTotal(best, D.objective)}`;
    setReplayVisible(D.day !== todayNumber());
    if (D.day === todayNumber()) {
      $('sd-end-best').textContent = 'Partida de hoy completada. Vuelve mañana.';
    }
    setTimeout(() => showScreen('screen-end'), 650);
  }

  /* Compartir. Superdraft era el unico de los cuatro diarios sin este boton, y
     es lo que hace que un juego diario circule. Mismo patron que La Carrera:
     navigator.share en movil, portapapeles en escritorio y textarea de
     emergencia para navegadores viejos.
     El texto NO revela ningun futbolista: solo el objetivo, la formacion y el
     total, para que se pueda pegar sin destripar el reto del dia. */
  function doShare() {
    const btn = $('sd-share-btn');
    if (!btn) return;
    const texto =
      `Superdraft · FutbolHUB · Partida n.º ${D.day}
` +
      `${D.objective.title}
` +
      `${fmtTotal(S.total, D.objective)} · formación ${D.formation.name}
` +
      window.location.origin + window.location.pathname;
    const aviso = () => {
      const antes = btn.innerHTML;
      btn.innerHTML = '✓ ¡Copiado!';
      setTimeout(() => { btn.innerHTML = antes; }, 2000);
    };
    if (navigator.share) { navigator.share({ text: texto }).catch(() => {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(aviso).catch(() => {});
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = texto; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); aviso();
    } catch (e) { /* sin portapapeles: el boton no hace nada, pero no rompe */ }
  }

  function bestKey(day) { return 'superdraft-best-' + day; }
  function saveBest(day, total, dir) {
    let prev = null;
    try { const raw = localStorage.getItem(bestKey(day)); if (raw != null) prev = parseFloat(raw); } catch (e) {}
    let best = total;
    if (prev != null && !isNaN(prev)) best = (dir === 'min') ? Math.min(prev, total) : Math.max(prev, total);
    try { localStorage.setItem(bestKey(day), String(best)); } catch (e) {}
    return best;
  }

  /* Registro POR FECHA de la partida terminada.
     bestKey() va por número de edición, que sirve para el archivo pero no
     para la racha del hub ni para sincronizar entre dispositivos: las dos
     cosas trabajan con claves "<juego>_day_YYYY-MM-DD" (ver
     js/hub-streaks.js y js/progress-sync.js). Superdraft era el único
     diario que no dejaba rastro con fecha, y por eso ni tenía 🔥 en su
     tarjeta ni le viajaba el progreso al móvil. */
  function saveDaily(day, total, objective) {
    if (day !== todayNumber()) return;      // solo el día de hoy hace racha
    try {
      localStorage.setItem(`superdraft_day_${todayMadrid()}`, JSON.stringify({
        day, total, objective: objective.key, unit: objective.unit,
      }));
    } catch (e) {}
  }

  /* Devuelve la partida de HOY si ya se jugo, o null.
     Superdraft es un juego DIARIO: una edicion, un intento. Antes se podia
     reintentar sin limite y solo se guardaba la mejor marca, asi que
     "compartir tu resultado" no significaba nada y la racha premiaba a quien
     insistiera, no a quien acertara. Ahora se juega una vez y hasta manana.
     El archivo (dias pasados) SI se puede repetir: no cuenta para la racha,
     igual que en La Carrera y En el Top. */
  function loadDailyResult(day) {
    if (day !== todayNumber()) return null;
    try {
      const raw = localStorage.getItem(`superdraft_day_${todayMadrid()}`);
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (!r || r.day !== day) return null;
      // Si el objetivo guardado no es el que genera hoy el codigo, ese
      // resultado es de otra generacion: no se puede pintar contra este dia.
      if (r.objective && D && D.objective && r.objective !== D.objective.key) return null;
      return r;
    } catch (e) { return null; }
  }

  /* Pinta el final con un resultado ya guardado, sin volver a jugar. */
  function showSavedResult(r) {
    S.over = true;
    $('sd-end-title').textContent = D.objective.title;
    $('sd-end-total').textContent = fmtTotal(r.total, D.objective);
    $('sd-end-best').textContent = 'Ya has jugado la partida de hoy. Vuelve mañana.';
    setReplayVisible(false);
    showScreen('screen-end');
  }

  /* El boton de reintentar solo tiene sentido en el archivo. */
  function setReplayVisible(visible) {
    const b = $('sd-replay-btn');
    if (b) b.style.display = visible ? '' : 'none';
  }

  /* ═══════════════════ PANTALLAS / NAV ═══════════════════ */
  function showScreen(id) {
    ['screen-intro','screen-game','screen-end'].forEach(s => {
      const el = $(s); if (el) el.classList.toggle('active', s === id);
    });
  }

  function loadDay(day, sinTocarUrl) {
    curDay = Math.max(1, Math.min(day, maxDay));
    /* push: cambiar de edicion SI es moverse a otro sitio y el Atras debe
       deshacerlo. Cuando el dia no cambia (Reintentar, volver al menu) set()
       ve que no hay nada que escribir y no encadena entradas de historial. */
    if (window.FHRuta && !sinTocarUrl) {
      FHRuta.set({ dia: curDay === maxDay ? null : fechaDeDia(curDay) }, { push: true });
    }
    D = generateDay(curDay);
    S = freshState(D);
    buildReelImages();
    // Intro
    $('sd-obj-title').textContent = D.objective.title;
    $('sd-obj-formation').textContent = 'Formación ' + D.formation.name;
    $('sd-obj-hint').textContent = objectiveHint(D.objective);
    $('sd-day-label').textContent = '#' + curDay + (curDay < maxDay ? ' · Archivo' : '');
    $('nav-label').textContent = '#' + curDay;
    $('nav-next').disabled = curDay >= maxDay;
    $('nav-last').disabled = curDay >= maxDay;
    $('nav-prev').disabled = curDay <= 1;
    $('nav-first').disabled = curDay <= 1;

    const yaJugada = loadDailyResult(curDay);
    if (yaJugada) { showSavedResult(yaJugada); return; }
    setReplayVisible(curDay !== todayNumber());
    showScreen('screen-intro');
  }

  function objectiveHint(obj) {
    const fam = obj.families;
    let src = fam.includes('club') ? 'clubes, ligas y nacionalidades'
            : fam.includes('league') ? 'ligas y nacionalidades'
            : 'nacionalidades';
    const dir = obj.dir === 'min' ? 'La suma más BAJA gana.' : 'La suma más ALTA gana.';
    const act = activeRequired(obj) ? ' Solo jugadores en activo.' : ' Valen también los retirados.';
    return `Rellena los 11 puestos. Cada ronda saldrá un badge (${src}); elige un jugador que lo cumpla y colócalo en su posición. ${dir}${act}`;
  }

  function startGame() {
    S = freshState(D);
    renderField();
    showScreen('screen-game');
    startRound();
  }

  /* ═══════════════════ INIT ═══════════════════ */
  async function init() {
    maxDay = todayNumber();
    try {
      await FR.ready;
      dataReady = true;
    } catch (e) {
      console.error('[Superdraft] Error cargando datos:', e);
      $('sd-loading-text').textContent = 'Error al cargar. Recarga la página.';
      return;
    }
    $('loading-overlay').classList.add('hidden');

    /* La URL manda al entrar. Se valida contra el rango real (dia 1 .. hoy):
       una fecha de antes del lanzamiento o del futuro se ignora. */
    const pedido = window.FHRuta && FHRuta.fecha('dia');
    const nPedido = pedido ? diaDeFecha(pedido) : 0;
    loadDay(nPedido >= 1 && nPedido <= maxDay ? nPedido : maxDay, true);
    /* Que la URL no mienta si el dia pedido no valia. */
    if (window.FHRuta) {
      FHRuta.set({ dia: curDay === maxDay ? null : fechaDeDia(curDay) });
    }

    if (window.FHRuta) FHRuta.alVolver(() => {
      const f = FHRuta.fecha('dia');
      const n = f ? diaDeFecha(f) : maxDay;
      if (n >= 1 && n <= maxDay && n !== curDay) loadDay(n, true);
    });

    // Listeners
    /* Un solo manejador: el que comprueba si la partida de hoy ya se jugo.
       Antes aqui habia un addEventListener directo a startGame(); dejar los
       dos haria que cada clic disparara las dos cosas. */
    $('sd-start-btn').addEventListener('click', () => {
      const ya = loadDailyResult(curDay);
      if (ya) { showSavedResult(ya); return; }   // por si se recargo la pantalla
      startGame();
    });
    $('sd-share-btn').addEventListener('click', doShare);
    $('sd-replay-btn').addEventListener('click', () => { loadDay(curDay); startGame(); });
    $('sd-menu-btn').addEventListener('click', () => loadDay(curDay));
    $('nav-prev').addEventListener('click',  () => loadDay(curDay - 1));
    $('nav-next').addEventListener('click',  () => loadDay(curDay + 1));
    $('nav-first').addEventListener('click', () => loadDay(1));
    $('nav-last').addEventListener('click',  () => loadDay(maxDay));
  }

  /* API minima para el HTML inline (autocompletado). */
  window.SD = { pick, openPick, closePick, submit, onInput, onKey, generateDay, matchesBadge, posBucket, dbg: () => ({ D, S }) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
