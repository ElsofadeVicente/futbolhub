/* =============================================================================
   SUPERDRAFT — script principal
   Motor de restricciones compartido: window.FR (js/futbol-restrictions.js)
   -----------------------------------------------------------------------------
   Cada dia: un OBJETIVO-metrica fijo (evaluado como SUMA sobre los once) y una
   FORMACION que rota. Cada ronda la tragaperras para en un BADGE (club, liga o
   nacionalidad). Eliges un jugador que cumpla el badge y encaje por POSICION en
   una linea con hueco libre; su valor de la metrica se suma al marcador.

   Reglas de badge (semantica):
     nacionalidad -> historico (nationalTeam); retirados incluidos
     club         -> SIEMPRE club actual (chunk.club); retirados no valen
     liga         -> liga del club actual; retirados no valen
   Objetivo valor de mercado -> solo jugadores activos (mv > 0).
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

  /* ─────────── Objetivos (metrica del dia, todo SUMA) ─────────── */
  /* families: badges que pueden salir. activeOnly: solo jugadores con mv. */
  const OBJECTIVES = [
    { key:'age_old',    metric:'age',    dir:'max', title:'EL ONCE MÁS VIEJO',           short:'MÁS VIEJO',   unit:'años',    families:['nat','club','league'] },
    { key:'age_young',  metric:'age',    dir:'min', title:'EL ONCE MÁS JOVEN',           short:'MÁS JOVEN',   unit:'años',    families:['nat','club','league'] },
    { key:'height_tall',metric:'height', dir:'max', title:'EL ONCE MÁS ALTO',            short:'MÁS ALTO',    unit:'cm',      families:['nat','club','league'] },
    { key:'height_low', metric:'height', dir:'min', title:'EL ONCE MÁS BAJO',            short:'MÁS BAJO',    unit:'cm',      families:['nat','club','league'] },
    { key:'mv_high',    metric:'mv',     dir:'max', title:'EL ONCE MÁS CARO',            short:'MÁS CARO',    unit:'€',       families:['nat','club','league'], activeOnly:true },
    { key:'caps',       metric:'caps',   dir:'max', title:'MÁS INTERNACIONALIDADES',     short:'INTERNAC.',   unit:'caps',    families:['nat'] },
    { key:'natgoals',   metric:'natGoals',dir:'max',title:'MÁS GOLES CON LA SELECCIÓN',  short:'GOLES SEL.',  unit:'goles',   families:['nat'] },
    { key:'goals',      metric:'goals',  dir:'max', title:'MÁS GOLES EN SU CARRERA',     short:'GOLES',       unit:'goles',   families:['nat','club','league'] },
    { key:'apps',       metric:'apps',   dir:'max', title:'MÁS PARTIDOS EN SU CARRERA',  short:'PARTIDOS',    unit:'part.',   families:['nat','club','league'] },
    { key:'clg',        metric:'clg',    dir:'max', title:'MÁS GOLES EN CHAMPIONS',      short:'GOLES UCL',   unit:'goles',   families:['club','league'] },
  ];

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
    if (obj && obj.activeOnly && !(p.mv > 0)) return false;
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
    for (const pos of order) {
      let best = null, bestScore = -1;
      for (let t = 0; t < 60; t++) {
        const b = pools[Math.floor(rng() * pools.length)];
        const key = b.kind + ':' + b.value;
        const allC = countFor(b, objective, pos, all, 3);
        if (allC < 1) continue;                    // sin solucion posible -> descartar
        const genC = countFor(b, objective, pos, gen, 1);   // ¿reconocible?
        let score = allC + (genC > 0 ? 1000 : 0) + (used.has(key) ? -500 : 0);
        if (score > bestScore) { bestScore = score; best = b; }
        if (genC > 0 && !used.has(key)) break;     // suficientemente bueno
      }
      if (!best) {
        // Fallback: cualquiera con al menos 1 jugador de esa posicion.
        for (const b of FR.rng.shuffle(pools, rng)) {
          if (countFor(b, objective, pos, all, 1) >= 1) { best = b; break; }
        }
        best = best || pools[0];
      }
      used.add(best.kind + ':' + best.value);
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

  /* ═══════════════════ TRAGAPERRAS (reel) ═══════════════════ */
  let _reelImgs = [];
  function buildReelImages() {
    const pools = buildBadgePools(D.objective.families);
    _reelImgs = pools.map(b => b.img).filter(Boolean);
  }

  function startRound() {
    if (S.over) return;
    const badge = D.badges[S.round];
    S.curBadge = badge;
    S.spinning = true;
    renderField();                 // deshabilita clicks en los slots mientras gira
    const reel = $('sd-reel-img');
    const cap  = $('sd-reel-label');
    cap.textContent = '';
    cap.classList.remove('locked');

    // 7 imagenes en ~3s a velocidad constante, parada SECA en el objetivo.
    const pool = _reelImgs.filter(Boolean);
    const rng  = Math.random;
    const frames = [];
    for (let k = 0; k < 6; k++) frames.push(pool[Math.floor(rng() * pool.length)] || badge.img);
    frames.push(badge.img);        // 7º = objetivo (donde para)
    const N = frames.length;       // 7
    const interval = 3000 / N;     // ~428ms, constante

    let i = 0;
    const tick = () => {
      const src = frames[i];
      if (src) { reel.style.display = ''; reel.src = src; } else { reel.style.display = 'none'; }
      const fr = reel.parentElement;
      fr.classList.remove('pop'); void fr.offsetWidth; fr.classList.add('pop');
      i++;
      if (i < N) setTimeout(tick, interval);
      else setTimeout(() => lockBadge(badge), interval);
    };
    tick();
  }

  function lockBadge(badge) {
    S.spinning = false;
    const reel = $('sd-reel-img');
    reel.style.display = ''; reel.src = badge.img;
    const cap = $('sd-reel-label');
    cap.textContent = badge.label;
    cap.classList.add('locked');
    $('sd-reel').classList.add('locked');
    setTimeout(() => $('sd-reel').classList.remove('locked'), 420);
    renderField();                 // ahora los slots vuelven a ser clicables
  }

  /* ═══════════════════ AUTOCOMPLETADO + ENVIO ═══════════════════ */
  let acItems = [], acIndex = -1;

  function onInput() {
    const q = ($('player-input').value || '').trim();
    const list = $('autocomplete-list');
    if (q.length < 2) { list.classList.add('hidden'); acItems = []; return; }
    acItems = FR.suggest(q, 8); acIndex = 0;   // primera preseleccionada -> Enter la elige
    if (!acItems.length) { list.classList.add('hidden'); return; }
    list.innerHTML = acItems.map((it, idx) =>
      `<div class="autocomplete-item${idx === 0 ? ' selected' : ''}" data-idx="${idx}" onmousedown="event.preventDefault();SD.pick(${idx})">${esc(it.name)}</div>`
    ).join('');
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
    submit();
  }

  /* Abre el modal de busqueda para un slot concreto (posicion elegida). */
  function openPick(bucket, idx) {
    if (!S || S.spinning || S.over) return;
    if (S.lines[bucket][idx]) return;   // ya ocupado
    S.pickSlot = { bucket, idx };
    $('sd-modal-sub').textContent = `${LINE_LABEL[bucket]} · ${S.curBadge ? S.curBadge.label : ''}`;
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

  async function submit() {
    if (!S || S.over || S.spinning || !S.pickSlot) return;
    const input = $('player-input');
    const name = (input.value || '').trim();
    if (!name) return;
    input.disabled = true;
    try {
      const player = await FR.resolvePlayer(name);
      if (!player) { toast('No encuentro ese futbolista', 'err'); return; }
      if (S.usedIds.has(String(player.id))) { toast(`${player.name} ya lo has usado`, 'err'); return; }

      const badge = S.curBadge;
      if (!matchesBadge(player, badge, D.objective)) {
        if (D.objective.activeOnly && !(player.mv > 0))
          toast(`${player.name} está retirado (objetivo solo para jugadores en activo)`, 'err');
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
    setTimeout(() => showScreen('screen-end'), 650);
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

  /* ═══════════════════ PANTALLAS / NAV ═══════════════════ */
  function showScreen(id) {
    ['screen-intro','screen-game','screen-end'].forEach(s => {
      const el = $(s); if (el) el.classList.toggle('active', s === id);
    });
  }

  function loadDay(day) {
    curDay = Math.max(1, Math.min(day, maxDay));
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
    showScreen('screen-intro');
  }

  function objectiveHint(obj) {
    const fam = obj.families;
    let src = fam.includes('club') ? 'clubes, ligas y nacionalidades'
            : fam.includes('league') ? 'ligas y nacionalidades'
            : 'nacionalidades';
    const dir = obj.dir === 'min' ? 'La suma más BAJA gana.' : 'La suma más ALTA gana.';
    const act = obj.activeOnly ? ' Solo jugadores en activo.' : '';
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
    loadDay(maxDay);

    // Listeners
    $('sd-start-btn').addEventListener('click', startGame);
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
