/* =============================================================================
   BINGO — script principal
   Motor de restricciones compartido: window.FR (js/futbol-restrictions.js)
   -----------------------------------------------------------------------------
   Un carton 4x4 con 16 CATEGORIAS (club, pais, liga, titulo, entrenador,
   companero de...). Cada 10 segundos cae un FUTBOLISTA del pool curado
   (del pool compartido, gen_pool.json) y hay que colocarlo en una casilla
   —o saltarlo—.

   No se valida nada en caliente: colocas a ciegas y los aciertos y los fallos
   se revelan de golpe al cerrar el carton. Y es BINGO O NADA: o estan las 16
   bien o no hay bingo; aqui no se cuentan lineas ni se reparten puntos.

   Que categorias cumple cada futbolista NO viene precocinado en ningun JSON:
   se calcula aqui con FR.validate() contra los mismos datos que usan Coche y
   Tres en Raya. Asi el juego no puede desalinearse de la base de datos.

   La partida entera (las 16 categorias y el orden de los futbolistas) se
   deriva de una SEMILLA, asi que en una sala online todos juegan exactamente
   el mismo carton sin tener que sincronizar nada mas.
   ============================================================================= */
'use strict';

(function () {

  /* ─────────── Utilidades ─────────── */
  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  /* ─────────── Constantes de juego ─────────── */
  const SIZE      = 4;                 // carton 4x4
  const CELLS     = SIZE * SIZE;       // 16 casillas
  const TURN_MS   = 10000;             // 10 s por futbolista
  const MIN_POOL  = 10;                // futbolistas del pool que debe cumplir una categoria
  const TOTAL_CALLS = 60;              // futbolistas que caen en una partida

  /* ── LA DIFICULTAD VIVE AQUI ──
     No basta con que el carton TENGA solucion: si por cada casilla caen quince
     nombres validos, colocar no decide nada. Por eso la secuencia se construye
     con la oferta MEDIDA: de cada casilla caen exactamente SUPPLY_PER_CELL
     futbolistas validos en toda la partida, ni uno mas. Y se eligen a proposito
     los que valen para VARIAS casillas, que son los que crean el dilema: cae
     Luis Suárez, vale para "Uruguayo" y para "Ajax", lo gastas en Uruguayo...
     y el siguiente en caer es Cavani, que solo valia para Uruguayo.

     Va atado a TOTAL_CALLS: la escasez es la oferta POR TURNO, no el numero
     pelado. Con 60 futbolistas cayendo, 7 por casilla dejan la misma densidad
     de nombres validos por turno que tenian 2 en una partida de 24. */
  const SUPPLY_PER_CELL = 7;
  /* Señuelos que no valen para NADA del carton. Sin ellos "si encaja, colocalo"
     seria la estrategia perfecta y el boton de saltar sobraria. Rellenan lo que
     falte hasta TOTAL_CALLS (alrededor de un tercio de la partida). */

  /* Cuantas categorias como mucho de cada familia. Sin esto salen cartones
     monotematicos (cuatro "compañero de ..." seguidos). La suma da de sobra
     para llenar las 16 casillas. */
  const FAMILY_MAX = {
    club: 5, nationality: 3, league: 2, league_general: 1,
    trophy_individual: 2, trophy_domestic: 2, trophy_intl: 2, trophy_national: 2,
    coach: 2, teammate: 2, continent: 1,
  };
  const FAMILY_MAX_DEFAULT = 2;

  /* ─────────── Estado ─────────── */
  const G = {
    mode: 'solo',        // 'solo' | 'online'
    phase: 'idle',       // 'idle' | 'playing' | 'reveal' | 'over'
    seed: 0,
    cats: [],            // 16 restricciones (objetos de FR.buildCandidates)
    seq: [],             // futbolistas que van cayendo (objetos de FR)
    idx: 0,              // futbolista en curso
    board: new Array(CELLS).fill(null),   // {player, ok} por casilla
    skipped: [],
    deadline: 0,
    tickId: null,
    result: null,
  };

  let POOL      = [];        // futbolistas curados (objetos completos de FR)
  let POOL_CATS = [];        // claves de categoria curadas ([] = catalogo entero)
  let currentTab = 'solo';

  /* Cache de "quien cumple que": clave de categoria -> array de indices de POOL.
     Se llena bajo demanda; una categoria se recorre una sola vez por sesion. */
  const _satCache = new Map();

  function catKey(r) {
    const v = Array.isArray(r.value) ? r.value.join(',') : (r.value ?? '');
    return `${r.type}|${v}`;
  }

  function satisfiers(r) {
    const key = catKey(r);
    let list = _satCache.get(key);
    if (!list) {
      list = [];
      for (let i = 0; i < POOL.length; i++) if (FR.validate(POOL[i], r)) list.push(i);
      _satCache.set(key, list);
    }
    return list;
  }

  /* ═══════════════ PANTALLAS / AVISOS ═══════════════ */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id)?.classList.add('active');
  }

  function showToast(msg, kind) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  function showError(panel, msg) {
    const el = $('error-' + panel);
    if (!el) return showToast(msg, 'error');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._h);
    el._h = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  /* ═══════════════ ETIQUETAS DE CATEGORIA ═══════════════ */
  /* Las casillas son pequenas: el texto tiene que caber en dos lineas. */
  function shortLabel(r) {
    switch (r.type) {
      case 'club':        return (r.display || r.value).toUpperCase();
      case 'nationality': return (r.label || '').toUpperCase();
      case 'league':      return String(r.value).toUpperCase();
      case 'league_any':  return r.label.replace(/^Ha jugado en /, '').toUpperCase();
      case 'coach':       return 'DT ' + String(r.value).split(' ').slice(-1)[0].toUpperCase();
      case 'teammate':    return 'COMPAÑERO DE ' + String(r.label).replace(/^Compañero de /, '').toUpperCase();
      case 'trophy':      return String(r.label).replace(/^Ganador /, '').toUpperCase();
      case 'trophy_any':  return String(r.label).replace(/^Ganador /, '').toUpperCase();
      case 'continent':   return String(r.label).toUpperCase();
      default:            return String(r.label || '').toUpperCase();
    }
  }

  /* Entrenadores y companeros son FOTOS (avatar circular); logos, banderas y
     trofeos son imagenes sueltas. Mismo criterio que Tres en Raya. */
  function mediaHtml(r) {
    const avatar = (r.type === 'coach' || r.type === 'teammate');
    if (r.imgUrl) {
      /* Sin loading="lazy": las 16 casillas se ven de golpe y el carton tiene
         que estar legible desde el primer segundo. */
      return `<span class="cat-media${avatar ? ' cat-media--avatar' : ''}">
                <img src="${esc(fhImgUrl(r.imgUrl))}" alt="" decoding="async"
                     onerror="this.parentElement.classList.add('broken')">
              </span>`;
    }
    return `<span class="cat-media"><span class="cat-emoji">${esc(r.icon || '⚽')}</span></span>`;
  }

  /* ═══════════════ GENERADOR DE PARTIDA ═══════════════ */
  /* Todo sale de la semilla: mismas 16 categorias y misma secuencia de nombres
     para cualquiera que juegue con esa semilla (asi funcionan las salas). */

  function pickCats(rng, catalogue) {
    const chosen = [];
    const families = {};
    const usedKeys = new Set();

    for (const r of catalogue) {
      if (chosen.length === CELLS) break;
      const key = catKey(r);
      if (usedKeys.has(key)) continue;

      const fam = r.family || r.type;
      if ((families[fam] || 0) >= (FAMILY_MAX[fam] ?? FAMILY_MAX_DEFAULT)) continue;

      /* Nada de parejas donde una categoria hace redundante o imposible a la
         otra ("Español" + "Ganador de la Eurocopa" está bien; "Mide 180 o más"
         + "Mide 190 o más" no aporta nada). */
      if (chosen.some(c => FR.isRedundant(c, r) || FR.isRedundant(r, c))) continue;

      /* Que haya nombres de sobra en el pool para poder llenarla. */
      if (satisfiers(r).length < MIN_POOL) continue;

      chosen.push(r);
      usedKeys.add(key);
      families[fam] = (families[fam] || 0) + 1;
    }
    return chosen.length === CELLS ? chosen : null;
  }

  /* ¿Se puede llenar el carton entero con estos nombres? Emparejamiento maximo
     bipartito (algoritmo de Kuhn) entre casillas y futbolistas de la secuencia.
     Con la oferta tan ajustada ya no basta con contar: hacen falta 16 parejas
     DISTINTAS, y eso hay que comprobarlo de verdad. */
  function hasFullSolution(cats, seqIdx, coverOf) {
    const adj = cats.map(() => []);
    seqIdx.forEach((pi, j) => {
      for (const ci of (coverOf.get(pi) || [])) adj[ci].push(j);
    });
    const matchSeq = new Array(seqIdx.length).fill(-1);
    const tryCell = (ci, seen) => {
      for (const j of adj[ci]) {
        if (seen[j]) continue;
        seen[j] = 1;
        if (matchSeq[j] === -1 || tryCell(matchSeq[j], seen)) { matchSeq[j] = ci; return true; }
      }
      return false;
    };
    let pairs = 0;
    for (let ci = 0; ci < cats.length; ci++) {
      if (tryCell(ci, new Array(seqIdx.length).fill(0))) pairs++;
    }
    return pairs === CELLS;
  }

  /* Construye la secuencia con la oferta racionada: de cada casilla caen
     exactamente SUPPLY_PER_CELL nombres validos en toda la partida. Un nombre
     que vale para tres casillas gasta cupo de las tres, asi que los cruces son
     escasos a proposito y colocarlo mal deja una casilla muerta. Al final se
     comprueba que aun asi el carton perfecto SIGUE siendo posible. */
  function pickSequence(rng, cats) {
    /* Que casillas cubre cada futbolista del pool en ESTE carton */
    const coverOf = new Map();
    cats.forEach((r, ci) => {
      for (const pi of satisfiers(r)) {
        let list = coverOf.get(pi);
        if (!list) coverOf.set(pi, list = []);
        list.push(ci);
      }
    });

    /* count[ci] = cuantos nombres validos para esa casilla llevamos metidos.
       HARD_MAX es el techo, y es la mitad del juego: sin el acaban cayendo
       quince nombres validos para la misma casilla y da igual lo que hagas. */
    const HARD_MAX = SUPPLY_PER_CELL + 2;
    const count = cats.map(() => 0);
    const used = new Set();
    const chosen = [];

    /* Las casillas mas escasas del pool se sirven primero: si esperan, se
       quedan sin candidatos libres. */
    const order = cats
      .map((r, ci) => ({ ci, n: satisfiers(r).length }))
      .sort((a, b) => a.n - b.n);

    /* ── FASE 1: EL ESQUELETO ──
       Un futbolista EXCLUSIVO por casilla, 16 nombres distintos. Esto es lo que
       hace que el carton perfecto exista SIEMPRE, pase lo que pase despues.
       Y se eligen a proposito los que valen para VARIAS casillas: escasez sin
       ambiguedad no es dificultad — si cada nombre solo encaja en un sitio, no
       hay nada que decidir y el juego se rellena solo. El dilema es que caiga
       Luis Suárez valiendo para "Uruguayo" y para "Ajax": el asiento de Suárez
       en el esqueleto es uno solo, y si lo gastas en el otro, algo se rompe. */
    for (const { ci } of order) {
      const cands = FR.rng.shuffle(satisfiers(cats[ci]), rng).filter(pi => !used.has(pi));
      if (!cands.length) return null;
      /* Dos criterios, en este orden: primero el que menos casillas desborda
         por encima del techo (normalmente ninguna), y en igualdad el que vale
         para MAS casillas. El esqueleto no es negociable, asi que si nadie cabe
         se coge al que menos rompa en vez de a uno cualquiera. */
      const over = (pi) => coverOf.get(pi).filter(c => count[c] >= HARD_MAX).length;
      cands.sort((a, b) => (over(a) - over(b)) ||
                           (coverOf.get(b).length - coverOf.get(a).length));
      const pick = cands[0];
      used.add(pick);
      chosen.push(pick);
      for (const c of coverOf.get(pick)) count[c]++;
    }

    /* ── FASE 2: LA TENSION ──
       Se completa hasta SUPPLY_PER_CELL sin pasar del techo, y aqui SI se
       buscan los que valen para varias casillas: son los que te ponen el
       dilema delante. Si alguna casilla no admite segundo candidato se queda
       con uno solo — eso la vuelve mas dificil, no imposible: el esqueleto
       sigue ahi. */
    for (const { ci } of order) {
      while (count[ci] < SUPPLY_PER_CELL) {
        const cands = FR.rng.shuffle(satisfiers(cats[ci]), rng)
          .filter(pi => !used.has(pi) && coverOf.get(pi).every(c => count[c] < HARD_MAX));
        if (!cands.length) break;
        cands.sort((a, b) => coverOf.get(b).length - coverOf.get(a).length);
        const pick = cands[0];
        used.add(pick);
        chosen.push(pick);
        for (const c of coverOf.get(pick)) count[c]++;
      }
    }

    if (!hasFullSolution(cats, chosen, coverOf)) return null;

    /* Señuelos: no valen para ninguna casilla del carton. Se meten los que
       hagan falta para que caigan TOTAL_CALLS futbolistas exactos. Si la oferta
       valida ya llegase sola a TOTAL_CALLS no se recorta: quitar nombres
       validos podria cargarse el carton perfecto que acabamos de comprobar. */
    const decoyPool = FR.rng.shuffle(
      POOL.map((_, i) => i).filter(i => !used.has(i) && !coverOf.has(i)), rng);
    const decoys = decoyPool.slice(0, Math.max(0, TOTAL_CALLS - chosen.length));

    return FR.rng.shuffle([...chosen, ...decoys], rng).map(i => POOL[i]);
  }

  function buildGame(seed) {
    const rng = FR.rng.mulberry32(seed);
    /* Solo categorias con imagen de verdad: una casilla de 70px se lee por el
       escudo/bandera/trofeo, no por el texto. */
    const catalogue = FR.buildCandidates(rng).filter(r => {
      if (!r.imgUrl) return false;
      if (POOL_CATS.length && !POOL_CATS.includes(catKey(r))) return false;
      return true;
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      const cats = pickCats(rng, FR.rng.shuffle(catalogue, rng));
      if (!cats) continue;
      const seq = pickSequence(rng, cats);
      if (seq) return { cats, seq };
    }
    return null;
  }

  /* ═══════════════ RENDER DEL CARTON ═══════════════ */
  function renderBoard() {
    const board = $('board');
    board.innerHTML = G.cats.map((r, i) => `
      <button class="bcell" id="cell-${i}" data-i="${i}" onclick="App.place(${i})"
              style="--d:${i * 22}ms" aria-label="${esc(shortLabel(r))}">
        <span class="bcell-inner">
          ${mediaHtml(r)}
          <span class="bcell-cat">${esc(shortLabel(r))}</span>
          <span class="bcell-name"></span>
          <span class="bcell-stamp"></span>
        </span>
      </button>`).join('');
    /* 'in' se queda pegada de la partida anterior, y con ella puesta las casillas
       nacen ya visibles: la entrada en cascada solo se veia en la primera.
       El reflow (offsetWidth) es lo que hace que el navegador se quede con la
       posicion de salida antes de encender la transicion. Con rAF tambien
       funcionaba, pero rAF no corre en una pestaña en segundo plano y el carton
       se quedaba invisible hasta volver a ella. */
    board.classList.remove('in');
    void board.offsetWidth;
    board.classList.add('in');
  }

  function paintCell(i) {
    const cell = $('cell-' + i);
    if (!cell) return;
    const slot = G.board[i];
    cell.classList.toggle('filled', !!slot);
    cell.querySelector('.bcell-name').textContent = slot ? slot.player.name : '';
  }

  /* ═══════════════ EL LOCUTOR (futbolista en curso) ═══════════════ */
  function splitName(name) {
    const parts = String(name || '').trim().split(' ');
    if (parts.length === 1) return ['', parts[0]];
    return [parts.slice(0, -1).join(' '), parts.slice(-1)[0]];
  }

  function renderCallerContent() {
    const p = G.seq[G.idx];
    const [first, last] = splitName(p?.name);
    $('caller-first').textContent = first;
    $('caller-last').textContent  = last || '';
    $('caller-photo').innerHTML = p?.img
      ? `<img src="${esc(fhImgUrl(p.img))}" alt="" onerror="this.remove()">`
      : '<span class="caller-noimg">⚽</span>';
    $('caller-left').textContent = `${Math.max(0, G.seq.length - G.idx - 1)} POR CAER`;

    /* La foto del siguiente se va cargando durante estos 10 segundos: si no,
       entra tarde y el nombre aparece antes que la cara. */
    const next = G.seq[G.idx + 1];
    if (next && next.img) { const im = new Image(); im.src = fhImgUrl(next.img); }
  }

  /* El relevo va en DOS TIEMPOS y ese orden importa: primero se va el anterior
     y SOLO cuando la ficha está vacía se escribe el nuevo. Escribirlo antes
     hacía que el nombre asomara en la ficha vieja y destripaba quién venía.
       mode 'first' → arranque de partida (entra y ya)
       mode 'fly'   → acaba de volar a una casilla: la ficha ya no está ahí,
                      se corta en seco para no duplicarla con el clon que vuela
       mode 'out'   → saltado: sale animándose
     El reloj no arranca hasta que el nuevo es visible (callback 'then'). */
  let _callerSwap = null;
  function renderCaller(mode, then) {
    const el = $('caller-player');
    clearTimeout(_callerSwap);
    el.classList.remove('enter', 'leaving', 'gone');

    const swapIn = () => {
      renderCallerContent();
      el.classList.remove('leaving', 'gone');
      void el.offsetWidth;             // reinicia la animacion de entrada
      el.classList.add('enter');
      if (then) then();
    };

    if (mode === 'first') { swapIn(); return; }
    el.classList.add(mode === 'fly' ? 'gone' : 'leaving');
    _callerSwap = setTimeout(swapIn, mode === 'fly' ? 200 : 190);
  }

  /* ═══════════════ PARTIDA A MEDIAS ═══════════════
     Recargar la pagina perdia el carton entero: cuatro casillas colocadas y a
     empezar de cero. Ahora se guarda lo justo para reconstruirla, que es MUY
     poco porque la partida es determinista: con la SEMILLA, buildGame() vuelve
     a dar exactamente las mismas 16 categorias y la misma secuencia de
     futbolistas. Solo hay que apuntar por donde ibas.

     Ni las categorias ni los futbolistas se guardan: son objetos gordos (con
     fotos, escudos y listas de ids) y ademas se quedarian congelados si algun
     dia cambia el pool. */
  const CLAVE_PARTIDA = 'bingo-partida';
  const CADUCIDAD_PARTIDA_MS = 3 * 60 * 60 * 1000;   // 3 h, como las salas

  function guardarPartida(msRestantes) {
    if (G.phase !== 'playing') return;
    try {
      localStorage.setItem(CLAVE_PARTIDA, JSON.stringify({
        seed: G.seed,
        mode: G.mode,
        sala: G.mode === 'online' ? (Sync.code || null) : null,
        idx:  G.idx,
        /* Por casilla, la posicion en la secuencia del que pusiste ahi. */
        board: G.board.map(c => (c && c.seqIdx != null) ? c.seqIdx : null),
        /* Huella del carton. La semilla sola NO basta: buildGame() sortea sobre
           el pool, asi que si el pool cambia (un sync de gen_pool.json) la misma
           semilla da OTRAS 16 categorias — y las fichas guardadas caerian en
           casillas que no son, sin fallar ni avisar. Con la huella se detecta y
           se descarta la partida en vez de servir un carton falso. */
        cats: G.cats.map(catKey),
        msLeft: msRestantes != null ? msRestantes : TURN_MS,
        ts: Date.now(),
      }));
    } catch (e) { /* sin espacio o en incognito: se juega igual, sin red */ }
  }

  function leerPartida() {
    try {
      const d = JSON.parse(localStorage.getItem(CLAVE_PARTIDA) || 'null');
      if (!d || typeof d.seed !== 'number' || !Array.isArray(d.board)) return null;
      if (d.board.length !== CELLS) return null;
      if (Date.now() - (d.ts || 0) > CADUCIDAD_PARTIDA_MS) return null;
      return d;
    } catch (e) { return null; }
  }

  function olvidarPartida() {
    try { localStorage.removeItem(CLAVE_PARTIDA); } catch (e) {}
  }

  /* Rehace la partida desde lo guardado. Devuelve false si la semilla ya no
     produce un carton valido (el pool ha cambiado): entonces mas vale empezar
     de cero que dejar a medias un carton que no cuadra. */
  function reanudarPartida(d) {
    const built = buildGame(d.seed);
    if (!built) return false;
    /* Que el carton sea EL MISMO, no solo uno hecho con la misma semilla. */
    if (Array.isArray(d.cats)) {
      const ahora = built.cats.map(catKey);
      if (d.cats.length !== ahora.length || d.cats.some((k, i) => k !== ahora[i])) return false;
    }

    G.mode  = d.mode === 'online' ? 'online' : 'solo';
    G.phase = 'playing';
    G.seed  = d.seed;
    G.cats  = built.cats;
    G.seq   = built.seq;
    G.idx   = Math.max(0, Math.min(d.idx | 0, built.seq.length - 1));
    G.board = d.board.map(si =>
      (si != null && built.seq[si]) ? { player: built.seq[si], ok: null, seqIdx: si } : null);
    /* Los saltados no se guardan: son los que ya pasaron y no estan en el
       carton, asi que salen solos. */
    G.skipped = built.seq.slice(0, G.idx).filter((_, i) => !d.board.includes(i));
    G.result = null;

    $('caller').classList.remove('done', 'urgent');
    $('rivals').classList.toggle('hidden', G.mode !== 'online');
    $('game-hint').textContent = 'Coloca al futbolista en la casilla que creas que cumple';
    showScreen('screen-game');
    renderBoard();
    for (let i = 0; i < CELLS; i++) if (G.board[i]) paintCell(i);
    renderCaller('first');
    startTimer(d.msLeft);
    return true;
  }

  /* ═══════════════ FLUJO DE PARTIDA ═══════════════ */
  function startGame(seed, mode) {
    const built = buildGame(seed);
    if (!built) { showToast('No se ha podido montar el cartón, prueba otra vez', 'error'); return false; }

    G.mode   = mode;
    G.phase  = 'playing';
    G.seed   = seed;
    G.cats   = built.cats;
    G.seq    = built.seq;
    G.idx    = 0;
    G.board  = new Array(CELLS).fill(null);
    G.skipped = [];
    G.result = null;
    olvidarPartida();          // la partida nueva sustituye a la que hubiera

    /* 'done' la pone finish() para apagar el locutor al cerrar el carton, y nadie
       la quitaba: a partir de la segunda partida el futbolista salia a media tinta.
       'urgent' se recalcula en cada tick, pero se limpia aqui por si acaso. */
    $('caller').classList.remove('done', 'urgent');
    $('rivals').classList.toggle('hidden', mode !== 'online');
    $('game-hint').textContent = 'Coloca al futbolista en la casilla que creas que cumple';
    showScreen('screen-game');
    renderBoard();
    renderCaller('first');
    startTimer();
    return true;
  }

  /* ms: cuánto tiempo dar. Sin argumento, el turno entero. Al reanudar una
     partida se pasa lo que quedaba, para que recargar no regale 10 segundos. */
  function startTimer(ms) {
    stopTimer();
    G.deadline = Date.now() + (ms > 0 ? Math.min(ms, TURN_MS) : TURN_MS);
    tick();
    G.tickId = setInterval(tick, 80);
  }

  function stopTimer() {
    if (G.tickId) { clearInterval(G.tickId); G.tickId = null; }
  }

  function tick() {
    const left = Math.max(0, G.deadline - Date.now());
    const frac = left / TURN_MS;
    const ring = $('ring-fill');
    const C = 2 * Math.PI * 28;
    ring.style.strokeDasharray  = C;
    ring.style.strokeDashoffset = C * (1 - frac);
    const secs = Math.ceil(left / 1000);
    $('ring-num').textContent = secs;
    $('caller').classList.toggle('urgent', left <= 3000);
    if (left === 0) { stopTimer(); skip(); }
  }

  /* Coloca al futbolista en curso en la casilla i */
  function place(i) {
    if (G.phase !== 'playing') return;
    if (G.board[i]) { showToast('Esa casilla ya está ocupada', 'warning'); return; }
    const player = G.seq[G.idx];
    if (!player) return;

    stopTimer();
    G.board[i] = { player, ok: null, seqIdx: G.idx };
    /* Se pinta YA: la ficha que vuela es decoración y no puede ser de la que
       dependa el estado (en una pestaña en segundo plano no llega a animarse). */
    paintCell(i);
    const cell = $('cell-' + i);
    cell.classList.add('pop');
    setTimeout(() => cell.classList.remove('pop'), 420);
    flyToCell(i);
    if (G.mode === 'online') Sync.reportProgress(filledCount());
    advance('fly');
  }

  function skip() {
    if (G.phase !== 'playing') return;
    stopTimer();
    G.skipped.push(G.seq[G.idx]);
    advance('out');
  }

  function advance(mode) {
    G.idx++;
    if (filledCount() === CELLS || G.idx >= G.seq.length) { finish(); return; }
    /* Se guarda en cada jugada por si el navegador se cierra de golpe. El
       tiempo que se apunta es el entero, porque el del que entra aun no ha
       empezado a correr; el beforeunload lo afina con lo que quede de verdad. */
    guardarPartida(TURN_MS);
    /* El reloj arranca cuando el nuevo futbolista ya se ve, no antes. */
    renderCaller(mode, startTimer);
  }

  function filledCount() { return G.board.filter(Boolean).length; }

  /* Animacion: la ficha del locutor vuela hasta la casilla (solo estetica) */
  function flyToCell(i) {
    const src = $('caller-player');
    const dst = $('cell-' + i);
    if (!src || !dst || !src.animate) return;

    const a = src.getBoundingClientRect();
    const b = dst.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.className = 'caller-ghost';
    Object.assign(ghost.style, {
      position: 'fixed', left: a.left + 'px', top: a.top + 'px',
      width: a.width + 'px', height: a.height + 'px', margin: '0', zIndex: '400',
    });
    document.body.appendChild(ghost);

    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const scale = Math.min(1, b.width / Math.max(a.width, 1));

    ghost.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.15 },
    ], { duration: 340, easing: 'cubic-bezier(.65,.05,.36,1)' })
      .finished.catch(() => {}).finally(() => ghost.remove());
    /* Red de seguridad: si la pestaña está en segundo plano la animación puede
       no llegar a terminar nunca y el clon se quedaría pegado en pantalla. */
    setTimeout(() => ghost.remove(), 1200);
  }

  /* ═══════════════ CIERRE Y REVELADO ═══════════════ */
  function finish() {
    stopTimer();
    G.phase = 'reveal';
    olvidarPartida();          // carton cerrado: ya no hay nada que reanudar
    $('caller').classList.add('done');
    $('game-hint').textContent = 'CARTÓN CERRADO — revelando…';

    /* Ahora si: se comprueba casilla por casilla. */
    let hits = 0;
    for (let i = 0; i < CELLS; i++) {
      const slot = G.board[i];
      if (!slot) continue;
      slot.ok = FR.validate(slot.player, G.cats[i]);
      if (slot.ok) hits++;
    }
    /* Aqui no hay medias tintas ni lineas que valgan: o cierras las 16 bien
       (BINGO) o no. Los aciertos solo sirven para saber cuanto te ha faltado. */
    const bingo = hits === CELLS;
    /* El récord se lee ANTES de guardarlo: si no, siempre parecería nuevo. */
    G.result = { hits, bingo, filled: filledCount(), prevBest: readBest() };

    revealAnimation(bingo, () => {
      G.phase = 'over';
      saveBest();
      if (G.mode === 'online') Sync.reportResult(G.result);
      showResult();
    });
  }

  /* Las casillas se voltean en cascada. Si estan las 16 bien, el carton entero
     se enciende: eso es el bingo. */
  function revealAnimation(bingo, done) {
    const STEP = 110;
    for (let i = 0; i < CELLS; i++) {
      setTimeout(() => {
        const cell = $('cell-' + i);
        if (!cell) return;
        const slot = G.board[i];
        cell.classList.add('reveal', slot ? (slot.ok ? 'ok' : 'bad') : 'empty');
        const stamp = cell.querySelector('.bcell-stamp');
        if (stamp) stamp.textContent = slot ? (slot.ok ? '✓' : '✗') : '—';
      }, i * STEP);
    }

    const afterCells = CELLS * STEP + 260;
    if (bingo) {
      setTimeout(() => {
        for (let i = 0; i < CELLS; i++) $('cell-' + i)?.classList.add('bingo');
        showToast('¡BINGO!', 'ok');
      }, afterCells);
    }
    setTimeout(done, afterCells + (bingo ? 1100 : 500));
  }

  /* ═══════════════ RESULTADO ═══════════════ */
  function bestKey() { return 'bingo_best'; }

  function readBest() {
    try { return JSON.parse(localStorage.getItem(bestKey()) || 'null'); } catch { return null; }
  }

  /* El récord es el mejor numero de aciertos; aparte se llevan los bingos, que
     es lo unico que de verdad se gana. */
  function saveBest() {
    if (!G.result) return;
    const prev = readBest() || { hits: -1, bingos: 0 };
    const bingos = (prev.bingos || 0) + (G.result.bingo ? 1 : 0);
    if (G.result.hits <= prev.hits && bingos === (prev.bingos || 0)) return;
    try {
      localStorage.setItem(bestKey(), JSON.stringify({
        hits: Math.max(prev.hits, G.result.hits), bingos,
        date: new Date().toISOString().slice(0, 10),
      }));
    } catch { /* modo incognito: sin récord, el juego sigue igual */ }
    renderBestBox();
  }

  function renderBestBox() {
    const b = readBest();
    const box = $('best-box');
    if (!b) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('best-value').textContent = b.bingos
      ? `${b.hits}/16 · ${b.bingos} bingo${b.bingos > 1 ? 's' : ''}`
      : `${b.hits}/16`;
  }

  function showResult() {
    const r = G.result;
    const fails = r.filled - r.hits;
    $('rs-hits').textContent  = `${r.hits}/16`;
    $('rs-fails').textContent = fails;
    $('rs-empty').textContent = CELLS - r.filled;

    $('result-title').textContent = r.bingo ? '¡BINGO!' : 'NO HAY BINGO';
    $('result-title').classList.toggle('is-bingo', r.bingo);

    const prev = r.prevBest;
    $('result-best').textContent =
      r.bingo ? 'Has cerrado el cartón entero'
      : (!prev || r.hits > prev.hits) ? `Tu mejor cartón hasta ahora: ${r.hits}/16`
      : `Tu récord sigue en ${prev.hits}/16`;

    /* Detalle casilla a casilla: en los fallos se dice que SI cumplia ese
       futbolista dentro del carton, que es lo que mas escuece y mas ensena. */
    $('result-detail').innerHTML = `
      <p class="detail-kicker">Cartón al descubierto</p>
      <div class="detail-list">
        ${G.cats.map((cat, i) => {
          const slot = G.board[i];
          if (!slot) {
            return `<div class="detail-row detail-row--empty">
                      <span class="detail-cat">${esc(shortLabel(cat))}</span>
                      <span class="detail-msg">sin rellenar</span>
                    </div>`;
          }
          if (slot.ok) {
            return `<div class="detail-row detail-row--ok">
                      <span class="detail-cat">${esc(shortLabel(cat))}</span>
                      <span class="detail-msg">${esc(slot.player.name)}</span>
                    </div>`;
          }
          const alt = G.cats
            .map((c, j) => (j !== i && FR.validate(slot.player, c)) ? shortLabel(c) : null)
            .filter(Boolean);
          return `<div class="detail-row detail-row--bad">
                    <span class="detail-cat">${esc(shortLabel(cat))}</span>
                    <span class="detail-msg">${esc(slot.player.name)}
                      <em>${alt.length ? 'sí valía para ' + esc(alt.slice(0, 2).join(' · ')) : 'no valía para ninguna casilla'}</em>
                    </span>
                  </div>`;
        }).join('')}
      </div>`;

    showScreen('screen-result');
  }

  /* ═══════════════ ONLINE — Firebase Realtime DB ═══════════════ */
  /* Todos los de la sala juegan el MISMO carton (misma semilla) pero a su
     ritmo: cada uno tiene sus 10 segundos por nombre y su boton de saltar.
     Solo se comparte el progreso (casillas llenas) y el resultado final. */
  const Sync = (() => {
    let roomRef = null, code = null, uid = null, isHost = false, unsub = null, room = null;

    function fb() { return window._FB && window._FB.configured ? window._FB : null; }

    function myUid() {
      if (uid) return uid;
      try {
        uid = localStorage.getItem('bingo_uid');
        if (!uid) { uid = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bingo_uid', uid); }
      } catch { uid = 'u' + Math.random().toString(36).slice(2, 10); }
      return uid;
    }

    function newCode() {
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let s = '';
      for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
      return s;
    }

    async function create(name, isPublic) {
      const F = fb();
      if (!F) throw new Error('sin-firebase');
      code = newCode();
      isHost = true;
      const seed = Math.floor(Math.random() * 2147483647);
      await F.set(F.ref(F.db, `bingo/rooms/${code}`), {
        host: myUid(), status: 'waiting', seed, public: !!isPublic,
        createdAt: F.serverTimestamp(),
        players: { [myUid()]: { name, filled: 0, done: false, joinedAt: F.serverTimestamp() } },
      });
      if (isPublic) {
        await F.set(F.ref(F.db, `bingo/matchmaking/${code}`), {
          status: 'waiting', createdAt: F.serverTimestamp(),
        });
      }
      listen();
      return code;
    }

    async function join(name, joinCode) {
      const F = fb();
      if (!F) throw new Error('sin-firebase');
      const snap = await F.get(F.ref(F.db, `bingo/rooms/${joinCode}`));
      if (!snap.exists()) throw new Error('no-existe');
      const data = snap.val();
      if (data.status !== 'waiting') throw new Error('empezada');
      code = joinCode;
      isHost = data.host === myUid();
      await F.set(F.ref(F.db, `bingo/rooms/${code}/players/${myUid()}`), {
        name, filled: 0, done: false, joinedAt: F.serverTimestamp(),
      });
      listen();
      return code;
    }

    /* Una sala que lleva más de esto esperando es basura: el anfitrión cerró
       el portátil, se le fue la conexión, lo que sea. Sin este corte el
       índice solo crece y cada jugador nuevo prueba una a una todas las
       salas muertas antes de emparejar. */
    const MM_CADUCIDAD_MS = 60 * 60 * 1000;   // 1 hora

    /* Busca una sala publica esperando; si no hay ninguna, crea una. */
    async function findPublic(name) {
      const F = fb();
      if (!F) throw new Error('sin-firebase');
      const snap = await F.get(F.ref(F.db, 'bingo/matchmaking'));
      const rooms = snap.exists() ? snap.val() : {};
      const ahora = Date.now();

      const entradas = Object.entries(rooms).filter(([, v]) => v && v.status === 'waiting');
      const caducadas = entradas.filter(([, v]) => ahora - (v.createdAt || 0) > MM_CADUCIDAD_MS);
      const waiting   = entradas
        .filter(([, v]) => ahora - (v.createdAt || 0) <= MM_CADUCIDAD_MS)
        .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

      // Barrido oportunista: el que pasa por aquí limpia lo que encuentra.
      // En segundo plano, que emparejar no espere a esto.
      caducadas.forEach(([c]) => {
        F.remove(F.ref(F.db, `bingo/matchmaking/${c}`)).catch(() => {});
        F.remove(F.ref(F.db, `bingo/rooms/${c}`)).catch(() => {});
      });

      for (const [c] of waiting) {
        try { return await join(name, c); } catch { /* caducada: probamos la siguiente */ }
      }
      return await create(name, true);
    }

    function listen() {
      const F = fb();
      roomRef = F.ref(F.db, `bingo/rooms/${code}`);
      /* Al perder la conexión hay que BORRAR el jugador, no marcarlo
         offline. Marcándolo, quien cerrase la pestaña se quedaba dentro de
         la sala para siempre con done:false, y entonces:
           · el ranking se quedaba clavado en "2/3 han terminado" y la
             partida no se resolvía nunca para los que sí acabaron;
           · cleanup() solo borra la sala "si no queda nadie", y con el
             fantasma dentro nunca quedaba vacía → salas huérfanas eternas.
         Coche y Blackjack ya lo hacían así (.remove()). */
      if (window._FBOnDisconnect) {
        try {
          window._FBOnDisconnect(F.ref(F.db, `bingo/rooms/${code}/players/${myUid()}`)).remove();
          // Si el que se cae es el anfitrión, la sala deja de estar
          // disponible: fuera del índice de matchmaking (igual que en
          // cleanup()). Si se cae otro, la sala sigue abierta.
          if (isHost) {
            window._FBOnDisconnect(F.ref(F.db, `bingo/matchmaking/${code}`)).remove();
          }
        } catch {}
      }
      unsub = F.onValue(roomRef, (snap) => {
        room = snap.val();
        /* La sala ha desaparecido mientras estabas dentro: fuera también el
           rastro, o recargar intentaría volver a una sala que no existe.
           Se limpia aquí y no dentro de leave(), porque leave() lo llama
           también el beforeunload de una recarga — y ahí borrar la URL sería
           justo cargarse la vuelta. */
        if (!room) { desmarcarSala(); leave(); showToast('La sala ya no existe', 'warning'); return; }
        project();
      });
    }

    /* Refleja el estado de la sala en la pantalla que toque */
    function project() {
      const players = room.players || {};
      const list = Object.entries(players);
      isHost = room.host === myUid();

      if (room.status === 'waiting') {
        $('lobby-code-display').textContent = code;
        $('lobby-count-kicker').textContent = `Jugadores (${list.length})`;
        $('lobby-players').innerHTML = list.map(([id, p]) => `
          <div class="lobby-player-row">
            <div class="lobby-player-avatar">${esc((p.name || '?')[0].toUpperCase())}</div>
            <span class="lobby-player-name">${esc(p.name || 'Jugador')}</span>
            ${id === room.host ? '<span class="lobby-player-host">ANFITRIÓN</span>' : ''}
            ${id === myUid() ? '<span class="lobby-player-you">← TÚ</span>' : ''}
          </div>`).join('');
        $('btn-start-room').classList.toggle('hidden', !isHost);
        $('lobby-hint').textContent = isHost
          ? (list.length > 1 ? 'Cuando queráis' : 'Comparte el código para que se una alguien')
          : 'Esperando al anfitrión…';
        if (G.phase !== 'idle') return;      // ya estabamos jugando
        showScreen('screen-lobby');
        return;
      }

      if (room.status === 'playing') {
        if (G.phase === 'idle') startGame(room.seed, 'online');
        renderRivals();
        if (G.phase === 'over') renderRanking();
        return;
      }
    }

    function renderRivals() {
      const players = Object.entries(room.players || {});
      $('rivals').innerHTML = players.map(([id, p]) => `
        <div class="rival${id === myUid() ? ' me' : ''}">
          <span class="rival-name">${esc(p.name || '?')}</span>
          <span class="rival-bar"><i style="width:${(Math.min(16, p.filled || 0) / 16) * 100}%"></i></span>
          <span class="rival-num">${p.done ? (p.bingo ? 'BINGO' : (Number(p.hits) || 0) + '/16') : (Number(p.filled) || 0) + '/16'}</span>
        </div>`).join('');
    }

    function renderRanking() {
      const players = Object.entries(room.players || {});
      const done = players.filter(([, p]) => p.done);
      const rank = done
        .map(([id, p]) => ({ id, ...p }))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0));
      const box = $('ranking');
      box.classList.remove('hidden');
      box.innerHTML = `
        <p class="detail-kicker">Clasificación (${done.length}/${players.length} han terminado)</p>
        ${rank.map((p, i) => `
          <div class="rank-row${p.id === myUid() ? ' me' : ''}">
            <span class="rank-pos">${i + 1}</span>
            <span class="rank-name">${esc(p.name || '?')}</span>
            <span class="rank-detail">${p.bingo ? 'cartón cerrado' : (CELLS - (Number(p.hits) || 0)) + ' falladas'}</span>
            <span class="rank-points">${p.bingo ? 'BINGO' : (Number(p.hits) || 0) + '/16'}</span>
          </div>`).join('')}
        ${done.length < players.length ? '<p class="lobby-hint">Esperando a los demás…</p>' : ''}`;
    }

    async function start() {
      const F = fb();
      if (!F || !isHost) return;
      await F.update(roomRef, { status: 'playing', startedAt: F.serverTimestamp() });
      if (room && room.public) {
        try { await F.remove(F.ref(F.db, `bingo/matchmaking/${code}`)); } catch {}
      }
    }

    function reportProgress(filled) {
      const F = fb();
      if (!F || !code) return;
      F.update(F.ref(F.db, `bingo/rooms/${code}/players/${myUid()}`), { filled }).catch(() => {});
    }

    function reportResult(r) {
      const F = fb();
      if (!F || !code) return;
      F.update(F.ref(F.db, `bingo/rooms/${code}/players/${myUid()}`), {
        done: true, filled: r.filled, hits: r.hits, bingo: r.bingo,
      }).catch(() => {});
    }

    /* Al salir hay que dejar la base como estaba: quitarme de la sala, sacarla
       del matchmaking si la abrí yo y, si no queda nadie dentro, borrar la sala
       entera. Sin esto se acumulan nodos huérfanos para siempre. */
    async function cleanup(c, wasHost) {
      const F = fb();
      if (!F || !c) return;
      try { await F.remove(F.ref(F.db, `bingo/rooms/${c}/players/${myUid()}`)); } catch {}
      if (wasHost) { try { await F.remove(F.ref(F.db, `bingo/matchmaking/${c}`)); } catch {} }
      try {
        const snap = await F.get(F.ref(F.db, `bingo/rooms/${c}/players`));
        const left = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
        if (!left) {
          await F.remove(F.ref(F.db, `bingo/rooms/${c}`));
          await F.remove(F.ref(F.db, `bingo/matchmaking/${c}`));
        }
      } catch {}
    }

    function leave() {
      cleanup(code, isHost);          // en segundo plano: no bloquea la salida
      if (unsub) { try { unsub(); } catch {} unsub = null; }
      roomRef = null; code = null; room = null; isHost = false;
      G.phase = 'idle';
      stopTimer();
      showScreen('screen-menu');
    }

    /* Mirar una sala sin engancharse a ella: hace falta para decidir si se
       puede reanudar ANTES de escuchar, porque el primer aviso del listener
       llama a project() y ese arrancaría una partida nueva encima. */
    async function peek(c) {
      const F = fb();
      if (!F || !c) return null;
      try {
        const snap = await F.get(F.ref(F.db, `bingo/rooms/${c}`));
        return snap.exists() ? snap.val() : null;
      } catch { return null; }
    }

    /* Volver a una sala que YA está en juego. join() lo prohíbe a propósito
       (nadie puede colarse a mitad de partida), pero volver no es colarse: se
       exige haber guardado una partida de ESA sala y con SU misma semilla, o
       sea que ya estabas dentro cuando empezó. */
    async function rejoin(name, joinCode, filled) {
      const F = fb();
      if (!F) throw new Error('sin-firebase');
      code = joinCode;
      const snap = await F.get(F.ref(F.db, `bingo/rooms/${code}`));
      if (!snap.exists()) { code = null; throw new Error('no-existe'); }
      isHost = snap.val().host === myUid();
      await F.set(F.ref(F.db, `bingo/rooms/${code}/players/${myUid()}`), {
        name, filled: filled || 0, done: false, joinedAt: F.serverTimestamp(),
      });
      listen();
      return code;
    }

    return {
      create, join, findPublic, start, leave, reportProgress, reportResult,
      peek, rejoin,
      get code() { return code; },
      get inRoom() { return !!code; },
    };
  })();

  /* ═══════════════ ACCIONES DEL MENU ═══════════════ */
  function setTab(t) { currentTab = t; }

  function startSolo() {
    G.phase = 'idle';
    startGame(Math.floor(Math.random() * 2147483647), 'solo');
  }

  function nameFrom(inputId, panel) {
    const v = ($(inputId)?.value || '').trim();
    if (!v) { showError(panel, 'Escribe tu nombre'); return null; }
    return v.slice(0, 16);
  }

  /* Estar en una sala se nota en la URL, y con quién eres apuntado al lado:
     así una recarga (o volver a la pestaña) te devuelve a la sala en vez de
     al menú. El nombre va en localStorage y no en la URL — en la URL sería
     un dato personal a la vista y compartible sin querer. */
  function marcarSala(code, name) {
    if (!window.FHRuta || !code) return;
    FHRuta.set({ sala: code });
    FHRuta.recordarSala('bingo', code, name);
  }
  function desmarcarSala() {
    if (!window.FHRuta) return;
    FHRuta.borrar('sala');
    FHRuta.olvidarSala('bingo');
  }

  async function createRoom() {
    const name = nameFrom('input-host-name', 'private');
    if (!name) return;
    try { G.phase = 'idle'; await Sync.create(name, false); marcarSala(Sync.code, name); }
    catch (e) { showError('private', e.message === 'sin-firebase' ? 'El modo online no está disponible ahora mismo' : 'No se ha podido crear la sala'); }
  }

  async function joinRoom() {
    const name = nameFrom('input-join-name', 'private');
    if (!name) return;
    const code = ($('input-join-code')?.value || '').trim().toUpperCase();
    if (code.length !== 6) { showError('private', 'El código tiene 6 caracteres'); return; }
    try { G.phase = 'idle'; await Sync.join(name, code); marcarSala(code, name); }
    catch (e) {
      showError('private',
        e.message === 'no-existe' ? 'No existe ninguna sala con ese código' :
        e.message === 'empezada'  ? 'Esa partida ya ha empezado' :
        'No se ha podido entrar en la sala');
    }
  }

  async function findPublicRoom() {
    const name = nameFrom('input-public-name', 'public');
    if (!name) return;
    const btn = $('btn-find-public');
    btn.disabled = true; btn.textContent = 'BUSCANDO…';
    try { G.phase = 'idle'; await Sync.findPublic(name); marcarSala(Sync.code, name); }
    catch { showError('public', 'No se ha podido buscar sala'); }
    finally { btn.disabled = false; btn.textContent = 'BUSCAR SALA ▶'; }
  }

  function startRoom() { Sync.start(); }
  function leaveRoom()  { desmarcarSala(); Sync.leave(); }

  function copyLink() {
    const url = `${location.origin}${location.pathname}?sala=${Sync.code}`;
    navigator.clipboard?.writeText(url)
      .then(() => showToast('Enlace copiado'))
      .catch(() => showToast(url));
  }

  function playAgain() {
    $('ranking').classList.add('hidden');
    if (G.mode === 'online') { Sync.leave(); return; }
    startSolo();
  }

  function showMenu() {
    stopTimer();
    olvidarPartida();          // salir al menu es abandonar la partida
    desmarcarSala();
    if (Sync.inRoom) Sync.leave();
    G.phase = 'idle';
    $('ranking').classList.add('hidden');
    showScreen('screen-menu');
  }

  function showRules()  { $('rules-overlay').classList.remove('hidden'); }
  function closeRules() { $('rules-overlay').classList.add('hidden'); }

  /* ═══════════════ CARGA DEL POOL ═══════════════
     Bingo ya NO tiene pool propio. Antes leia data/bingo/pool.json, que era una
     copia de gen_pool.json hecha en su dia y que se habia quedado desfasada: los
     dos tenian 1.516 futbolistas pero NO los mismos (Koke y Darijo Srna solo en
     uno, Ndombele y Kadlec solo en el otro), porque gen_pool se regeneraba y
     nadie regeneraba el de aqui detras. Ahora los tres juegos miran la misma
     lista, que se cura en admin/generar_pool.py.

     El filtro por foto NO es un detalle: en Bingo no escribes nombres, el juego
     te suelta caras, asi que un futbolista sin retrato deja un hueco en la
     pantalla. En Coche y en Tres en Raya da igual porque ahi se escribe. */
  function poolDeFR() {
    return (FR.genPool || []).filter(p => p && p.img);
  }

  /* ═══════════════ INIT ═══════════════ */
  /* Al abrir el juego: volver a la sala, a la partida a medias, o a ninguna de
     las dos. Es lo primero que se hace, y no devuelve nada — quien llama solo
     necesita saber que ya ha terminado de intentarlo. */
  /* Se pierde la sala pero no el cartón: sigues la misma partida tú solo. */
  function seguirSinSala() {
    G.mode = 'solo';
    $('rivals').classList.add('hidden');
    desmarcarSala();
    guardarPartida(Math.max(0, G.deadline - Date.now()));   // ya como partida local
    showToast('La sala ya no está — sigues tú solo', 'warning');
  }

  async function retomarDondeLoDejaste() {
    const code = window.FHRuta ? FHRuta.sala()
                               : new URLSearchParams(location.search).get('sala');
    const guardada = leerPartida();

    /* Sin sala en la URL: la partida de práctica que dejaste a medias. Se
       reanuda sola, que es lo que espera quien acaba de recargar sin querer. */
    if (!code) {
      if (guardada && guardada.mode !== 'online') {
        if (reanudarPartida(guardada)) showToast('Sigues donde lo dejaste', 'ok');
        else olvidarPartida();
      }
      return;
    }

    $('tab-private')?.click();
    const input = $('input-join-code');
    if (input) input.value = code.toUpperCase();

    const rec = window.FHRuta && FHRuta.salaRecordada('bingo', code);
    if (!rec) return;           // te han pasado el enlace: que escriba su nombre

    /* Si dejaste una partida a medias EN ESTA sala, no se entra de nuevo: se
       vuelve al cartón que tenías. Se comprueba la SEMILLA contra la de la
       sala, que es la prueba de que sigue siendo la misma partida y no otra
       que haya empezado mientras no estabas. */
    const eraDeEstaSala = guardada && guardada.mode === 'online' &&
      String(guardada.sala || '').toUpperCase() === code.toUpperCase();

    if (eraDeEstaSala) {
      const sala = await Sync.peek(code);
      const mismaPartida = sala && sala.status === 'playing' && sala.seed === guardada.seed;

      if (mismaPartida && reanudarPartida(guardada)) {
        try {
          await Sync.rejoin(rec.nombre, code, filledCount());
          marcarSala(code, rec.nombre);
          showToast('Sigues donde lo dejaste', 'ok');
        } catch (e) {
          seguirSinSala();
        }
        return;
      }

      /* La sala ya no existe. Pasa siempre que estuvieras SOLO en ella: al
         recargar, el beforeunload te saca y, sin nadie dentro, la sala se
         borra. Perder la sala es un incordio; perder el cartón con doce
         casillas puestas es mucho peor, así que la partida continúa en local. */
      if (!sala && reanudarPartida(guardada)) { seguirSinSala(); return; }

      olvidarPartida();         // esa partida ya no se corresponde con la sala
    }

    try {
      await Sync.join(rec.nombre, code);
      marcarSala(code, rec.nombre);
    } catch (e) {
      desmarcarSala();
      showToast(
        e.message === 'no-existe' ? 'Esa sala ya no existe' :
        e.message === 'empezada'  ? 'La partida empezó sin ti' :
        'No se ha podido volver a la sala', 'warning');
    }
  }

  async function init() {
    renderBestBox();
    try {
      $('loading-text').textContent = 'Cargando base de datos…';
      await FR.init();

      POOL_CATS = [];                    /* catalogo entero de restricciones */
      POOL = poolDeFR();

      if (POOL.length < 200) throw new Error('El pool de futbolistas ha llegado incompleto');
      const sinFoto = (FR.genPool || []).length - POOL.length;
      console.log(`✅ [Bingo] Pool compartido: ${POOL.length} futbolistas`
                  + (sinFoto ? ` (${sinFoto} descartados por no tener foto)` : ''));
    } catch (e) {
      console.error(e);
      $('loading-text').textContent = 'No se han podido cargar los datos. Recarga la página.';
      return;
    }

    $('loading-overlay').classList.add('hidden');

    /* Volver a la sala y/o al cartón a medias. Los manejadores globales de
       abajo se registran SIEMPRE, pase lo que pase aquí: cuando esto iba
       entrelazado en init(), un `return` temprano dejaba el juego sin teclado
       y sin guardar al salir. */
    await retomarDondeLoDejaste();

    /* Teclado: 1-9 y letras no; espacio salta. */
    document.addEventListener('keydown', (e) => {
      if (G.phase !== 'playing') return;
      if (e.code === 'Space') { e.preventDefault(); skip(); }
    });

    /* El momento exacto de una recarga: aqui se apunta el tiempo REAL que
       quedaba, que es lo unico que las guardas de cada jugada no saben. */
    const apuntarDondeIba = () => {
      if (G.phase === 'playing') guardarPartida(Math.max(0, G.deadline - Date.now()));
    };
    window.addEventListener('beforeunload', () => {
      apuntarDondeIba();
      if (Sync.inRoom) Sync.leave();
    });
    /* pagehide SOLO guarda, no sale de la sala: en movil salta cada vez que
       cambias de app, y ahi no te has ido a ninguna parte — echarte de la sala
       por mirar una notificacion seria peor que el problema que arregla. */
    window.addEventListener('pagehide', apuntarDondeIba);
  }

  window._AppReal = {
    init, setTab, startSolo, showRules, closeRules,
    createRoom, joinRoom, findPublicRoom, leaveRoom, startRoom, copyLink,
    skip, place, playAgain, showMenu, showToast,
  };

})();
