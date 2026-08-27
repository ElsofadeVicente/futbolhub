/* =============================================
   CRUCIGRAMA-GAME.JS — Lógica del crucigrama diario
   QUIÉN COÑO FALTA
   ============================================= */

// ── ESTADO ──────────────────────────────────

let crucData        = null;   // entrada del crucigrama actual
let crucOffset      = 0;      // 0 = la edición de hoy, >0 = ediciones anteriores
let crucEdition     = 1;      // nº de edición = posición en la lista de días publicados
let crucIndex       = null;   // { months:[...], days:[...] } del índice de Storage
let crucEditions    = [];     // días publicados y jugables (<= hoy), ASCENDENTE
let crucIdx         = 0;      // índice de la edición actual dentro de crucEditions
const crucMonthCache = {};    // "AAAA-MM" -> { fecha: entrada }, meses ya descargados
let crucCells       = null;   // Set de "r,c" jugables, derivado de las palabras
let crucSegundos    = 0;      // tiempo jugado en este puzzle
let crucRelojTimer  = null;
let crucUsedCheck   = false;  // se pulsó "Comprobar" en este puzzle
let crucMalas       = new Set(); // "r,c" marcadas como error por Comprobar
let crucAtrasado    = false;  // hoy no tiene edición y se sirve la anterior
let crucUserGrid    = {};     // (r,c) -> letra introducida por el usuario
let crucSolvedWords = new Set();  // ids de palabras resueltas
let crucSelectedWord = null;  // { word, direction }
let crucSelectedCell = null;  // { row, col }
let crucCountdownInterval = null;
let crucHidden      = false;  // input nativo móvil
let crucUsedReveal  = false;  // se usó "Revelar" (letra/palabra/todo) en este puzzle

// ── NAVEGACIÓN ──────────────────────────────

function goToHub() {
    window.location.href = '../';
}

function openCrucigrama() {
    // Ya estamos en la página del crucigrama, solo cargamos
    crucStart();
}

// ── GUARDAR / CARGAR ESTADO ──────────────────

/* FIX: la clave se deriva de la fecha REAL del crucigrama cargado (crucData.date),
   no de la fecha calculada con el offset. Con el fallback al último disponible,
   el offset no corresponde al puzzle real y el progreso se guardaba en otra clave. */
function crucKeyFor(dateStr) {
    return `cruc_${String(dateStr).replace(/-/g, '')}`;
}

function crucSave() {
    if (!crucData || !crucData.date) return;
    const state = {
        userGrid: Object.fromEntries(
            Object.entries(crucUserGrid).map(([k, v]) => [k, v])
        ),
        solvedWords: Array.from(crucSolvedWords),
        completed: crucIsComplete(),
        clean: !crucUsedReveal,  // sin usar "Revelar" — cuenta para la racha del hub
        segundos: crucSegundos,
        checked: crucUsedCheck
    };
    try {
        localStorage.setItem(crucKeyFor(crucData.date), JSON.stringify(state));
    } catch {}
}

function crucLoad() {
    if (!crucData || !crucData.date) return null;
    try {
        const raw = localStorage.getItem(crucKeyFor(crucData.date));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// ── CRONÓMETRO ───────────────────────────────
// Cuenta solo mientras la pestaña está a la vista: dejarlo abierto de fondo
// media mañana no debería arruinar la marca del día.

function crucFormatoTiempo(seg) {
    const m = Math.floor(seg / 60), s = seg % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function crucRelojArranca() {
    crucRelojPara();
    if (crucIsComplete()) return;
    crucRelojTimer = setInterval(() => {
        if (document.hidden) return;
        crucSegundos++;
        const el = document.getElementById('cruc-reloj');
        if (el) el.textContent = crucFormatoTiempo(crucSegundos);
        if (crucSegundos % 10 === 0) crucSave();
    }, 1000);
}

function crucRelojPara() {
    if (crucRelojTimer) { clearInterval(crucRelojTimer); crucRelojTimer = null; }
}

// ── COMPROBAR ────────────────────────────────

/* Marca en rojo las letras equivocadas. Cuenta como ayuda y se dice en el
   resultado, pero NO rompe la racha del hub: esa sigue mirando solo si se
   usó "Revelar" (clave 'clean'), que es lo que hubo siempre — cambiarlo
   ahora invalidaría rachas que la gente ya tiene. */
function crucComprobar() {
    if (!crucData) return;
    // Con el crucigrama ya resuelto no hay nada que comprobar, y marcarlo como
    // "con ayudas" a toro pasado ROMPE la racha del hub de forma retroactiva:
    // lo resolviste limpio, pulsaste el botón por curiosidad y ese día dejaba
    // de contar. Lo mismo vale para los tres Revelar.
    if (crucIsComplete()) return;
    crucMalas = new Set();
    // Se cuentan CASILLAS, no pasadas: las de cruce pertenecen a dos palabras
    // y sumando por palabra el mensaje decía "5 letras mal" con 4 en rojo.
    const puestas = new Set();
    for (const w of crucData.words) {
        crucGetWordCells(w).forEach(({ row, col }, i) => {
            const escrita = crucUserGrid[`${row},${col}`];
            if (!escrita) return;
            puestas.add(`${row},${col}`);
            if (escrita !== crucNormalize(w.answer[i])) crucMalas.add(`${row},${col}`);
        });
    }
    // Solo cuenta como ayuda si de verdad había algo que comprobar: pulsarlo
    // con la rejilla vacía no te dice nada, y te costaba el "sin ayudas".
    if (puestas.size) crucUsedCheck = true;

    refreshAllCells();
    crucSave();

    const mal = crucMalas.size;
    const bar = document.getElementById('cruc-clue-bar');
    if (bar) {
        const texto = !puestas.size ? 'Todavía no has escrito nada.'
            : mal ? `${mal} ${mal === 1 ? 'letra mal' : 'letras mal'} (en rojo)`
                  : 'Todo lo que llevas está bien';
        bar.innerHTML = `<div class="cruc-clue-direction">COMPROBAR</div>
                         <div class="cruc-clue-text">${crucEsc(texto)}</div>`;
    }
    // La marca se va en cuanto toques algo, para no dejar el rojo pegado.
    setTimeout(() => { if (crucMalas.size) { crucMalas = new Set(); refreshAllCells(); } }, 4000);
}

// ── ESTADÍSTICAS ─────────────────────────────

const CRUC_STATS_KEY = 'cruc-stats';

function crucStatsLeer() {
    try {
        return JSON.parse(localStorage.getItem(CRUC_STATS_KEY)) || {};
    } catch { return {}; }
}

function crucStatsGuardar(s) {
    try { localStorage.setItem(CRUC_STATS_KEY, JSON.stringify(s)); } catch {}
}

/* Se apunta una sola vez por puzzle (marca 'hechos' por fecha), así que
   volver a abrir uno resuelto no infla los contadores. */
function crucStatsApuntar() {
    if (!crucData || !crucData.date) return;
    const s = crucStatsLeer();
    s.hechos = s.hechos || {};
    if (s.hechos[crucData.date]) return;
    s.hechos[crucData.date] = 1;
    s.jugados    = (s.jugados || 0) + 1;
    s.completados = (s.completados || 0) + 1;
    if (!crucUsedReveal && !crucUsedCheck) s.limpios = (s.limpios || 0) + 1;
    // Un 0 no es un tiempo: las partidas guardadas antes de que existiera el
    // cronómetro se restauran sin 'segundos', y al abrirlas hundían el tiempo
    // medio y podían colarse como récord.
    if (crucSegundos > 0) {
        if (!crucUsedReveal && (!s.mejorTiempo || crucSegundos < s.mejorTiempo)) {
            s.mejorTiempo = crucSegundos;
        }
        s.tiempoTotal = (s.tiempoTotal || 0) + crucSegundos;
        s.cronometrados = (s.cronometrados || 0) + 1;
    }
    crucStatsGuardar(s);
}

function crucStatsHTML() {
    const s = crucStatsLeer();
    const conTiempo = s.cronometrados || 0;
    const media = conTiempo ? Math.round((s.tiempoTotal || 0) / conTiempo) : 0;
    const filas = [
        ['Resueltos', s.completados || 0],
        ['Mejor tiempo', s.mejorTiempo ? crucFormatoTiempo(s.mejorTiempo) : '—'],
        ['Tiempo medio', media ? crucFormatoTiempo(media) : '—'],
    ];
    return filas.map(([k, v]) => `
        <div class="cruc-comp-stat">
            <div class="cruc-comp-stat-value">${v}</div>
            <div class="cruc-comp-stat-label">${k}</div>
        </div>`).join('');
}

// ── CARGAR CRUCIGRAMA ────────────────────────

/* Hoy en hora de MADRID, no en la del dispositivo.
   Los crucigramas se generan y se nombran con el calendario español; con la
   fecha local, quien jugara desde otro huso pedía el archivo de otro día y
   además su racha del hub cambiaba a una hora distinta que la de La Carrera,
   En el Top o En el Once (que sí iban por Madrid desde el principio). */
function crucTodayMadrid() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Madrid'
    }).format(new Date()); // "YYYY-MM-DD"
}

/* Resta días a un "YYYY-MM-DD" con aritmética de calendario (nada de restar
   milisegundos a un Date, que en el cambio de hora se va un día). */
const CRUC_MESES = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];

/* "2026-03-09" -> "9 de marzo". Se formatea a mano y no con toLocaleDateString
   para no construir un Date, que interpretaría la fecha en UTC y en husos al
   oeste de Greenwich mostraría el día anterior. */
function crucFechaLarga(dateStr) {
    const [, m, d] = String(dateStr).split('-').map(Number);
    return `${d} de ${CRUC_MESES[m - 1] || ''}`;
}

function crucShiftDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
}

function crucLoading(msg) {
    const screen = document.getElementById('crucigrama-screen');
    if (!screen) return;
    screen.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:4px;color:var(--neon-green);animation:pulse 1s infinite;">${msg}</div>
            <div style="font-size:2rem;">📰</div>
        </div>`;
}

function crucFatal(texto) {
    const screen = document.getElementById('crucigrama-screen');
    if (!screen) return;
    screen.innerHTML = `
        <button class="fh-volver" onclick="goToHub()">← Volver</button>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:16px;padding:20px;">
            <div style="font-size:3rem;">😓</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;letter-spacing:3px;color:var(--neon-yellow);text-align:center;">
                CRUCIGRAMA NO DISPONIBLE
            </div>
            <div style="font-family:'Rajdhani',sans-serif;font-size:1rem;color:var(--text-light);opacity:0.7;text-align:center;max-width:320px;">
                ${texto}
            </div>
            <button class="next-btn" style="margin-top:10px;" onclick="goToHub()">← VOLVER AL HUB</button>
        </div>`;
}

/* Descarga (y cachea) el mes que contiene esa fecha. Los datos van en un JSON
   por MES, como La Carrera y En el Top: crucigrama/AAAA-MM.json con la forma
   { month, days: { "AAAA-MM-DD": entrada } }. */
async function crucLoadMonth(mes) {
    if (crucMonthCache[mes]) return crucMonthCache[mes];
    const res = await fetch(sbStorageUrl('game-data', `crucigrama/${mes}.json`), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`mes ${mes} no disponible`);
    const j = await res.json();
    crucMonthCache[mes] = j.days || {};
    return crucMonthCache[mes];
}

/* Arranque: se lee el índice UNA vez y de ahí sale todo — qué ediciones hay,
   cómo se numeran y qué mes hay que pedir. Antes se pedía el archivo del día
   y, si faltaba, se tanteaba con el índice; con un JSON por mes ese baile
   sobra. Los meses se descargan solo cuando se navega a ellos: un mes de
   crucigramas densos pesa lo suyo y no tiene sentido bajarse el año entero
   para jugar el de hoy. */
async function crucStart() {
    crucLoading('CARGANDO...');

    try {
        const res = await fetch(sbStorageUrl('game-data', 'crucigrama/index.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error('sin índice');
        crucIndex = await res.json();
    } catch {
        crucFatal('No he podido cargar la lista de crucigramas.<br>Prueba a recargar la página.');
        return;
    }

    const hoy = crucTodayMadrid();
    // El índice trae los días publicados; sin ellos (índice viejo) se deducen
    // de los meses, aunque entonces no se puede numerar sin descargarlos.
    const dias = Array.isArray(crucIndex.days) ? crucIndex.days : [];
    crucEditions = dias.filter(d => d <= hoy).sort();

    if (!crucEditions.length) {
        crucFatal('Todavía no hay ningún crucigrama publicado.');
        return;
    }

    // Se abre por el de hoy; si hoy no tiene, por el último publicado.
    const i = crucEditions.indexOf(hoy);
    // Y si hoy no tiene, se DICE. Antes se caía al último disponible en
    // silencio: el juego estuvo 102 días sirviendo el crucigrama del 7 de mayo
    // y en pantalla no se notaba nada raro.
    crucAtrasado = i < 0;

    /* Y si la URL pide una edición concreta, manda ella. Ojo: eso NO es estar
       atrasado — el aviso de "la de hoy no está lista" es para cuando el juego
       se desvía solo, no para cuando el desvío lo has pedido tú. */
    const pedido  = window.FHRuta && FHRuta.fecha('dia');
    const iPedido = pedido ? crucEditions.indexOf(pedido) : -1;

    // El Atrás del móvil deshace la navegación por ediciones.
    if (window.FHRuta) FHRuta.alVolver(() => {
        const d = FHRuta.fecha('dia') || hoy;
        const k = crucEditions.indexOf(d);
        if (k >= 0 && k !== crucIdx) crucGoEdition(k, true);
    });

    await crucGoEdition(iPedido >= 0 ? iPedido : (i >= 0 ? i : crucEditions.length - 1),
                        true);
    /* Que la URL no mienta: el día que no existe (o el de hoy, que va sin
       parámetro) se quita, para que recargar no repita el mismo desvío. */
    if (window.FHRuta) {
        const real = crucEditions[crucIdx];
        FHRuta.set({ dia: real === hoy ? null : real });
    }
}

/* Navega a la edición idx de crucEditions y la deja lista para jugar. */
async function crucGoEdition(idx, sinTocarUrl) {
    // Se para ANTES de cambiar de puzzle: si no, el reloj de la edición que
    // dejas atrás sigue corriendo y le suma segundos a la que abres.
    crucRelojPara();
    idx = Math.max(0, Math.min(crucEditions.length - 1, idx));
    const fecha = crucEditions[idx];
    const mes   = fecha.slice(0, 7);

    /* push: cambiar de edición SÍ es moverse a otro sitio y el Atrás debe
       deshacerlo. Se salta en el arranque y cuando la llamada viene del propio
       Atrás (la URL ya la ha cambiado el navegador). */
    if (window.FHRuta && !sinTocarUrl) {
        FHRuta.set({ dia: fecha === crucTodayMadrid() ? null : fecha }, { push: true });
    }

    if (!crucMonthCache[mes]) crucLoading('CARGANDO...');

    let dias;
    try {
        dias = await crucLoadMonth(mes);
    } catch {
        crucFatal('No he podido cargar ese crucigrama.<br>Prueba a recargar la página.');
        return;
    }
    const entrada = dias[fecha];
    if (!entrada) {
        crucFatal('Ese crucigrama no está donde debería.<br>Prueba con otra edición.');
        return;
    }

    crucIdx     = idx;
    crucData    = crucNormalizeEntry(entrada, fecha);
    // La edición es la POSICIÓN en la lista de días publicados, no los días de
    // calendario desde el lanzamiento: con huecos (marzo no tuvo fines de
    // semana) esa cuenta inflaba el número y el #47 no era el 47º crucigrama.
    crucEdition = idx + 1;
    crucOffset  = fecha === crucTodayMadrid() ? 0 : 1;
    crucCells   = null;

    // Reset state
    crucUserGrid     = {};
    crucSolvedWords  = new Set();
    crucSelectedWord = null;
    crucSelectedCell = null;
    crucUsedReveal   = false;
    crucUsedCheck    = false;
    crucMalas        = new Set();
    crucSegundos     = 0;

    // Restore saved state if any (clave por fecha real del puzzle cargado)
    const saved = crucLoad();
    if (saved) {
        crucUserGrid    = saved.userGrid    || {};
        crucSolvedWords = new Set(saved.solvedWords || []);
        crucUsedReveal  = saved.clean === false;
        crucUsedCheck   = saved.checked === true;
        crucSegundos    = saved.segundos || 0;
    }

    buildCrucigramaScreen();

    if (crucIsComplete()) {
        setTimeout(() => crucShowCompletion(), 400);
    } else {
        crucRelojArranca();
    }
}

// ── GEOMETRÍA DERIVADA DE LAS PALABRAS ──────
// El JSON ya no guarda la rejilla: es redundante (se deduce entera de dónde
// va cada palabra) y ocupaba el 58% del archivo, con una línea por casilla.
// Tampoco guarda 'length' (= answer.length) ni 'number' cuando coincide con
// el id. Se rellenan aquí, una vez, para que el resto del juego siga leyendo
// w.length y w.number como toda la vida.

function crucNormalizeEntry(entrada, fecha) {
    if (entrada._listo) return entrada;
    entrada.date = entrada.date || fecha;
    for (const w of entrada.words) {
        w.length = w.answer.length;
        if (w.number == null) w.number = w.id;
    }
    // La numeración de un crucigrama va por casilla de inicio y en orden de
    // lectura, no por el orden en que se colocaron las palabras: dos palabras
    // que arrancan en la misma casilla comparten número.
    const inicios = [...new Set(entrada.words.map(w => `${w.row},${w.col}`))]
        .map(k => k.split(',').map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const num = new Map(inicios.map(([r, c], i) => [`${r},${c}`, i + 1]));
    for (const w of entrada.words) w.number = num.get(`${w.row},${w.col}`);
    entrada._listo = true;
    return entrada;
}

function crucSize() {
    if (crucData && Array.isArray(crucData.size)) {
        return { rows: crucData.size[0], cols: crucData.size[1] };
    }
    // Formato viejo, por si queda algún archivo sin migrar.
    if (crucData && crucData.grid_size) return crucData.grid_size;
    let rows = 0, cols = 0;
    for (const w of (crucData?.words || [])) {
        const n = w.answer.length;
        rows = Math.max(rows, w.direction === 'down'   ? w.row + n : w.row + 1);
        cols = Math.max(cols, w.direction === 'across' ? w.col + n : w.col + 1);
    }
    return { rows, cols };
}

function crucIsPlayable(r, c) {
    if (!crucCells) {
        crucCells = new Set();
        for (const w of (crucData?.words || [])) {
            for (const p of crucGetWordCells(w)) crucCells.add(`${p.row},${p.col}`);
        }
    }
    return crucCells.has(`${r},${c}`);
}

/* Escapa texto que va por innerHTML. Las pistas son nuestras, pero desde que
   se generan a partir de la base de jugadores llevan apóstrofos y comillas
   (O'Neill, "El Pipita") que romperían el atributo o el marcado. */
function crucEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// ── CONSTRUIR PANTALLA ───────────────────────

function buildCrucigramaScreen() {
    const screen = document.getElementById('crucigrama-screen');
    screen.innerHTML = '';

    const alPrincipio = crucIdx <= 0;
    const alFinal     = crucIdx >= crucEditions.length - 1;

    screen.innerHTML = `
        <!-- HEADER -->
        <div class="cruc-header">
            <div class="cruc-nav-row">
                <button class="fh-volver" onclick="goToHub()">← Volver</button>
                <div class="cruc-title-block">
                    <!-- h1: este render sustituye el innerHTML del contenedor y se
                         llevaba por delante el único encabezado de la página, así
                         que la versión renderizada se quedaba sin H1. -->
                    <h1 class="cruc-title">EN EL CRUCIGRAMA</h1>
                    <div class="cruc-edition">Crucigrama diario de fútbol</div>
                </div>
            </div>
            <div class="cruc-daily-nav">
                <button class="cruc-nav-btn cruc-nav-btn--edge" ${alPrincipio ? 'disabled' : ''}
                        title="Primera edición" onclick="crucGoEdition(0)">«</button>
                <button class="cruc-nav-btn" id="cruc-prev-btn" ${alPrincipio ? 'disabled' : ''}
                        onclick="crucGoEdition(${crucIdx - 1})">‹ Anterior</button>
                <div class="cruc-edition-center">
                    <div class="cruc-edition-num">#${crucEdition}</div>
                    ${crucOffset > 0
                        ? `<div class="cruc-past-badge">${crucFechaLarga(crucData.date)}</div>`
                        : '<div class="cruc-edition-date">Hoy</div>'}
                </div>
                <button class="cruc-nav-btn" id="cruc-next-btn" ${alFinal ? 'disabled' : ''}
                        onclick="crucGoEdition(${crucIdx + 1})">Siguiente ›</button>
                <button class="cruc-nav-btn cruc-nav-btn--edge" ${alFinal ? 'disabled' : ''}
                        title="Última edición" onclick="crucGoEdition(${crucEditions.length - 1})">»</button>
            </div>
            ${crucAtrasado && crucIdx === crucEditions.length - 1
               ? `<p class="fh-atrasado">El crucigrama de hoy todavía no
               está listo. Mientras tanto, aquí tienes el del ${crucFechaLarga(crucData.date)}.</p>` : ''}
            <!-- Enlace a la guía del juego. Va aquí y no solo en el HTML porque
                 este render sustituye el innerHTML del contenedor entero. -->
            <p class="guia-link"><a href="/como-jugar/crucigrama/">Cómo se juega &rarr;</a></p>
        </div>

        <!-- BODY -->
        <div class="cruc-body">

            <!-- COLUMNA IZQUIERDA: VERTICALES (solo desktop) -->
            <div class="cruc-clues-desktop" id="cruc-clues-down"></div>

            <!-- COLUMNA CENTRAL -->
            <div class="cruc-center-col">
                <!-- GRID -->
                <div class="cruc-grid-wrapper">
                    <div class="cruc-grid" id="cruc-grid"></div>
                </div>

                <!-- PISTA ACTIVA -->
                <div class="cruc-clue-bar" id="cruc-clue-bar">
                    <div class="cruc-clue-empty">Pulsa una casilla para ver la pista</div>
                </div>

                <!-- TECLADO VIRTUAL (desktop) -->
                <div class="cruc-keyboard" id="cruc-keyboard">
                    <div class="cruc-keyboard-row">
                        ${['Q','W','E','R','T','Y','U','I','O','P'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                    </div>
                    <div class="cruc-keyboard-row">
                        ${['A','S','D','F','G','H','J','K','L','Ñ'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                    </div>
                    <div class="cruc-keyboard-row">
                        <button class="cruc-key cruc-key--wide" onclick="crucHandleKey('Delete')">⌫</button>
                        ${['Z','X','C','V','B','N','M'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                        <button class="cruc-key cruc-key--wide" onclick="crucHandleKey('Tab')">→</button>
                    </div>
                </div>

                <!-- TAP BAR MÓVIL -->
                <div class="cruc-tap-bar" id="cruc-tap-bar" onclick="crucFocusMobile()">
                    Toca aquí para escribir ✏️
                </div>

            </div>

            <!-- COLUMNA DERECHA: HORIZONTALES (solo desktop) -->
            <div class="cruc-clues-desktop" id="cruc-clues-across"></div>

        </div>

        <!-- BOTTOM BAR -->
        <div class="cruc-bottom-bar">
            <div class="cruc-progress">
                <span id="cruc-solved-count">${crucSolvedWords.size}</span>/${crucData.words.length} palabras
                <span class="cruc-reloj" id="cruc-reloj">${crucFormatoTiempo(crucSegundos)}</span>
            </div>
            <div class="cruc-actions">
                <!-- Solo se ve en movil: en escritorio las pistas ya estan en las
                     dos columnas laterales, asi que el boton sobra. -->
                <button class="cruc-btn-reveal cruc-btn-clues" onclick="crucToggleCluesSheet()">Pistas</button>
                <button class="cruc-btn-reveal" onclick="crucComprobar()">Comprobar</button>
                <div class="cruc-reveal-wrapper" id="cruc-reveal-wrapper">
                    <button class="cruc-btn-reveal" onclick="crucToggleRevealMenu(event)">Revelar ▾</button>
                    <div class="cruc-reveal-menu" id="cruc-reveal-menu">
                        <button class="cruc-reveal-option" onclick="crucRevealLetter()">🔡 Letra</button>
                        <button class="cruc-reveal-option" onclick="crucRevealWord()">📝 Palabra</button>
                        <button class="cruc-reveal-option cruc-reveal-option--danger" onclick="crucRevealAll()">🔲 Cuadrícula</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- PANEL DE PISTAS (movil) -->
        <div class="cruc-clues-sheet" id="cruc-clues-sheet" onclick="crucCluesSheetBackdrop(event)">
            <div class="cruc-clues-sheet-inner">
                <div class="cruc-clues-sheet-head">
                    <span>Todas las pistas</span>
                    <button class="cruc-clues-sheet-close" onclick="crucCloseCluesSheet()">&#10005;</button>
                </div>
                <div class="cruc-clues-sheet-body" id="cruc-clues-mobile"></div>
            </div>
        </div>

        <!-- COMPLETION MODAL -->
        <div class="cruc-completion-modal" id="cruc-completion-modal">
            <div class="cruc-completion-content">
                <div class="cruc-completion-title" id="cruc-comp-title">🏆 ¡COMPLETADO!</div>
                <div class="cruc-completion-sub" id="cruc-comp-sub"></div>
                <div class="cruc-completion-stats">
                    <div class="cruc-comp-stat">
                        <div class="cruc-comp-stat-value" id="cruc-comp-words">${crucData.words.length}</div>
                        <div class="cruc-comp-stat-label">Palabras</div>
                    </div>
                    <div class="cruc-comp-stat">
                        <div class="cruc-comp-stat-value" id="cruc-comp-time">—</div>
                        <div class="cruc-comp-stat-label">Tiempo</div>
                    </div>
                </div>
                <div class="cruc-completion-heading">Tus estadísticas</div>
                <div class="cruc-completion-stats" id="cruc-comp-global"></div>
                <div class="cruc-countdown" id="cruc-countdown" style="display:none;"></div>
                <div class="cruc-completion-btns">
                    <button class="next-btn" id="cruc-share-btn" onclick="crucShare()">📤 Compartir</button>
                    <button class="give-up-btn" onclick="crucCloseCompletion()">Ver crucigrama</button>
                </div>
            </div>
        </div>

    `;

    renderGrid();
    renderCluesList();

    // Recalcular tamaño si cambia el viewport
    window._crucResizeHandler && window.removeEventListener('resize', window._crucResizeHandler);
    window._crucResizeHandler = () => renderGrid();
    window.addEventListener('resize', window._crucResizeHandler);
}

// ── RENDER GRID ──────────────────────────────

function renderGrid() {
    const container = document.getElementById('cruc-grid');
    if (!container || !crucData) return;

    const { rows, cols } = crucSize();

    // Calcular tamaño de celda dinámicamente según el ancho disponible
    const isDesktop = window.innerWidth > 600;
    // En desktop, la columna central ocupa aprox. el ancho total menos dos columnas laterales (210px c/u) y gaps
    const availableWidth  = isDesktop
        ? Math.min(window.innerWidth - 32 - 2 * 230, 480)
        : Math.min(window.innerWidth - 32, 640);
    // En móvil el chrome (header ~90px, clue bar ~80px, tap bar ~60px, bottom bar ~58px, paddings ~36px) ocupa ~324px
    // Usamos 0.38 para dejar espacio suficiente al chrome y que el crucigrama quepa sin scroll
    const availableHeight = window.innerHeight * (isDesktop ? 0.65 : 0.38);
    const cellByWidth  = Math.floor((availableWidth  - 10) / cols);
    const cellByHeight = Math.floor((availableHeight - 10) / rows);
    // En móvil bajamos el mínimo a 20px para que crucígramas grandes quepan en pantalla
    const cellSize = Math.max(isDesktop ? 28 : 20, Math.min(52, cellByWidth, cellByHeight));

    container.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
    container.innerHTML = '';

    // Inyectar tamaño dinámico en el DOM para que el CSS lo use
    let styleEl = document.getElementById('cruc-dynamic-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'cruc-dynamic-style';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
        .cruc-cell { width: ${cellSize}px; height: ${cellSize}px; }
        .cruc-cell-letter { font-size: ${Math.round(cellSize * 0.62)}px; }
        .cruc-cell-number { font-size: ${Math.max(7, Math.round(cellSize * 0.22))}px; }
    `;

    // Build number map: (r,c) -> number
    const numMap = {};
    for (const w of crucData.words) {
        const key = `${w.row},${w.col}`;
        if (!numMap[key]) numMap[key] = w.number;
    }

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = document.createElement('div');
            cell.className = 'cruc-cell';
            cell.dataset.row = r;
            cell.dataset.col = c;

            if (!crucIsPlayable(r, c)) {
                cell.classList.add('cruc-cell--black');
            } else {
                cell.classList.add('cruc-cell--white');

                // Number
                const key = `${r},${c}`;
                if (numMap[key]) {
                    const numEl = document.createElement('div');
                    numEl.className = 'cruc-cell-number';
                    numEl.textContent = numMap[key];
                    cell.appendChild(numEl);
                }

                // Letter
                const letEl = document.createElement('div');
                letEl.className = 'cruc-cell-letter';
                letEl.id = `cruc-letter-${r}-${c}`;
                letEl.textContent = crucUserGrid[key] || '';
                cell.appendChild(letEl);

                cell.addEventListener('click', () => crucClickCell(r, c));

                // Apply state classes
                applyCellClasses(cell, r, c);
            }

            container.appendChild(cell);
        }
    }
}

function applyCellClasses(cell, r, c) {
    cell.classList.remove('cruc-cell--word-active', 'cruc-cell--selected',
                          'cruc-cell--correct', 'cruc-cell--wrong');

    if (crucMalas.has(`${r},${c}`)) {
        cell.classList.add('cruc-cell--wrong');
    } else if (crucIsCellCorrect(r, c)) {
        cell.classList.add('cruc-cell--correct');
    }

    if (crucSelectedWord) {
        const w = crucSelectedWord;
        for (let i = 0; i < w.length; i++) {
            const wr = w.direction === 'across' ? w.row : w.row + i;
            const wc = w.direction === 'across' ? w.col + i : w.col;
            if (wr === r && wc === c) {
                cell.classList.add('cruc-cell--word-active');
                break;
            }
        }
    }

    if (crucSelectedCell && crucSelectedCell.row === r && crucSelectedCell.col === c) {
        cell.classList.add('cruc-cell--selected');
    }
}

function updateCellVisual(r, c) {
    const cell = document.querySelector(`.cruc-cell[data-row="${r}"][data-col="${c}"]`);
    if (!cell) return;
    const letEl = document.getElementById(`cruc-letter-${r}-${c}`);
    if (letEl) letEl.textContent = crucUserGrid[`${r},${c}`] || '';
    applyCellClasses(cell, r, c);
}

function refreshAllCells() {
    if (!crucData) return;
    const { rows, cols } = crucSize();
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (crucIsPlayable(r, c)) updateCellVisual(r, c);
}

// ── RENDER PISTAS ────────────────────────────

function renderCluesList() {
    if (!crucData) return;

    const across = crucData.words.filter(w => w.direction === 'across').sort((a,b) => a.number - b.number);
    const down   = crucData.words.filter(w => w.direction === 'down').sort((a,b) => a.number - b.number);

    // El panel de movil llama a otra funcion para cerrarse solo al elegir; en
    // las columnas de escritorio no hay nada que cerrar.
    const buildList = (words, alElegir) => words.map(w => {
        const isActive  = crucSelectedWord && crucSelectedWord.id === w.id;
        const isSolved  = crucSolvedWords.has(w.id);
        return `<div class="cruc-clue-item ${isActive ? 'active' : ''} ${isSolved ? 'solved' : ''}"
                     onclick="${alElegir}(${w.id})" data-clue-id="${w.id}">
                    <div class="cruc-clue-num">${w.number}</div>
                    <div class="cruc-clue-desc">${crucEsc(w.clue)}</div>
                </div>`;
    }).join('');

    const seccion = (titulo, words, alElegir) => `
        <div class="cruc-clues-section">
            <div class="cruc-clues-heading">${titulo}</div>
            ${buildList(words, alElegir)}
        </div>`;

    const colDown   = document.getElementById('cruc-clues-down');
    const colAcross = document.getElementById('cruc-clues-across');
    if (colDown)   colDown.innerHTML   = seccion('VERTICALES',   down,   'crucSelectWordById');
    if (colAcross) colAcross.innerHTML = seccion('HORIZONTALES', across, 'crucSelectWordById');

    // Movil: las dos listas juntas dentro del panel desplegable.
    const movil = document.getElementById('cruc-clues-mobile');
    if (movil) movil.innerHTML = seccion('HORIZONTALES', across, 'crucSelectFromSheet')
                               + seccion('VERTICALES',   down,   'crucSelectFromSheet');
}

// ── PANEL DE PISTAS (MOVIL) ──────────────────
/* En escritorio las pistas viven en las dos columnas laterales. En movil no
   caben, y hasta ahora solo se veia la pista de la palabra en la que estabas:
   este panel ensena las dos listas completas, horizontales y verticales. */

function crucToggleCluesSheet() {
    const sheet = document.getElementById('cruc-clues-sheet');
    if (!sheet) return;
    if (sheet.classList.contains('open')) return crucCloseCluesSheet();
    renderCluesList();                       // por si cambio algo desde la ultima vez
    sheet.classList.add('open');
    document.body.classList.add('cruc-sheet-abierto');
    // Deja a la vista la pista en la que estas, que puede estar muy abajo.
    const activa = sheet.querySelector('.cruc-clue-item.active');
    if (activa) activa.scrollIntoView({ block: 'center' });
}

function crucCloseCluesSheet() {
    const sheet = document.getElementById('cruc-clues-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    document.body.classList.remove('cruc-sheet-abierto');
}

/* Solo cierra si el toque cae en el velo, no dentro de la lista. */
function crucCluesSheetBackdrop(e) {
    if (e.target.id === 'cruc-clues-sheet') crucCloseCluesSheet();
}

function crucSelectFromSheet(id) {
    crucCloseCluesSheet();
    crucSelectWordById(id);
}

function updateCluesPanel() {
    if (!crucData) return;
    // Update active/solved states in all clue containers (panel móvil + columnas desktop)
    document.querySelectorAll('.cruc-clue-item').forEach(item => {
        const id = parseInt(item.dataset.clueId);
        item.classList.toggle('active',  crucSelectedWord?.id === id);
        item.classList.toggle('solved',  crucSolvedWords.has(id));
    });
}

function updateClueBar() {
    const bar = document.getElementById('cruc-clue-bar');
    if (!bar) return;
    if (!crucSelectedWord) {
        bar.innerHTML = '<div class="cruc-clue-empty">Pulsa una casilla para ver la pista</div>';
        return;
    }
    const w   = crucSelectedWord;
    const dir = w.direction === 'across' ? '→ HORIZONTAL' : '↓ VERTICAL';
    bar.innerHTML = `
        <div class="cruc-clue-direction">${w.number} ${dir}</div>
        <div class="cruc-clue-text">${crucEsc(w.clue)}</div>`;
}

// ── INTERACCIÓN CON CELDAS ───────────────────

function crucClickCell(r, c) {
    if (!crucData) return;

    // Find all words containing this cell
    const words = crucGetWordsAtCell(r, c);
    if (words.length === 0) return;

    // Una casilla con número es el INICIO de una o dos palabras (esa
    // numeración concreta). Pulsarla debe llevar a la pista de ESE número, no
    // a la palabra que solo pasa por ahí en la dirección en la que ya estabas.
    const inicianAqui = words.filter(w => w.row === r && w.col === c);
    const candidatos  = inicianAqui.length ? inicianAqui : words;

    // If already selected and clicking same cell: toggle direction
    if (crucSelectedCell && crucSelectedCell.row === r && crucSelectedCell.col === c
        && crucSelectedWord && candidatos.length > 1) {
        const otherDir = crucSelectedWord.direction === 'across' ? 'down' : 'across';
        const altWord  = candidatos.find(w => w.direction === otherDir);
        if (altWord) {
            crucSelectedWord = altWord;
        }
    } else {
        // Prefer same direction if possible, else first available
        let word = candidatos.find(w => w.direction === (crucSelectedWord?.direction || 'across'));
        if (!word) word = candidatos[0];
        crucSelectedWord = word;
    }

    crucSelectedCell = { row: r, col: c };

    refreshAllCells();
    updateClueBar();
    updateCluesPanel();

    // En móvil: enfocar el input oculto para mostrar el teclado nativo
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) {
        crucFocusMobile();
    }
}

function crucSelectWordById(id) {
    const w = crucData.words.find(x => x.id === id);
    if (!w) return;
    crucSelectedWord = w;
    crucSelectedCell = { row: w.row, col: w.col };
    refreshAllCells();
    updateClueBar();
    updateCluesPanel();
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) {
        crucFocusMobile();
    }
    // Scroll grid into view on mobile
    const grid = document.getElementById('cruc-grid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function crucGetWordsAtCell(r, c) {
    return crucData.words.filter(w => {
        for (let i = 0; i < w.length; i++) {
            const wr = w.direction === 'across' ? w.row : w.row + i;
            const wc = w.direction === 'across' ? w.col + i : w.col;
            if (wr === r && wc === c) return true;
        }
        return false;
    });
}

// ── ENTRADA DE LETRAS ────────────────────────

function crucHandleKey(key) {
    if (!crucSelectedCell || !crucSelectedWord) return;
    if (crucIsComplete()) return;

    const { row, col } = crucSelectedCell;
    const w = crucSelectedWord;

    if (key === 'Delete' || key === 'Backspace') {
        const cellKey = `${row},${col}`;
        // Una palabra ya acertada no se puede borrar: se ha comprobado que es
        // correcta, y deshacerla sería perder un acierto por error de tecleo.
        if (crucUserGrid[cellKey]) {
            if (!crucIsCellCorrect(row, col)) {
                delete crucUserGrid[cellKey];
                // Re-comprobar TODAS las palabras que pasan por la celda: si alguna
                // estaba marcada como resuelta, al borrar la letra deja de estarlo
                // (antes quedaba "resuelta" para siempre y podía dar falso completado).
                crucGetWordsAtCell(row, col).forEach(wd => crucCheckWordSolved(wd));
                updateCellVisual(row, col);
            }
        } else {
            // Move backwards
            const prev = crucGetPrevCell(w, row, col);
            if (prev) {
                crucSelectedCell = prev;
                if (!crucIsCellCorrect(prev.row, prev.col)) {
                    const prevKey = `${prev.row},${prev.col}`;
                    delete crucUserGrid[prevKey];
                    crucGetWordsAtCell(prev.row, prev.col).forEach(wd => crucCheckWordSolved(wd));
                    updateCellVisual(prev.row, prev.col);
                }
                refreshAllCells();
            }
        }
        crucSave();
        return;
    }

    if (key === 'Tab') {
        crucAdvanceToNextWord();
        return;
    }

    // Las flechas mueven el cursor por la rejilla, que es lo que espera
    // cualquiera que haya hecho un crucigrama. Antes saltaban a la palabra
    // siguiente, así que no había forma de recolocarse sin ratón.
    if (key.startsWith('Arrow')) {
        crucMoverCursor(key);
        return;
    }

    if (!/^[A-ZÁÉÍÓÚÜÑ]$/i.test(key)) return;

    // Casilla de una palabra ya acertada: no se pisa, solo se avanza el
    // cursor como si se hubiera escrito, para no romper el flujo de tecleo.
    if (crucIsCellCorrect(row, col)) {
        const next = crucGetNextCell(w, row, col);
        if (next) {
            crucSelectedCell = next;
            refreshAllCells();
        }
        return;
    }

    const letter = crucNormalize(key);
    const cellKey = `${row},${col}`;
    crucUserGrid[cellKey] = letter;
    updateCellVisual(row, col);

    // Check if word is solved — comprobar TODAS las palabras que pasan por la
    // celda, no solo la seleccionada: una letra puede completar también la
    // palabra perpendicular (antes esa palabra nunca se marcaba como resuelta
    // y el crucigrama no se podía completar rellenándolo solo en un sentido).
    crucGetWordsAtCell(row, col).forEach(wd => crucCheckWordSolved(wd));

    // Advance cursor
    const next = crucGetNextCell(w, row, col);
    if (next) {
        crucSelectedCell = next;
        refreshAllCells();
    }

    crucSave();

    // Check full completion
    if (crucIsComplete()) {
        setTimeout(() => crucShowCompletion(), 500);
    }
}

function crucNormalize(letter) {
    // La \u00d1 es una letra distinta de la N: si se le quitan los acentos con
    // normalize('NFD'), su virgulilla se descompone en un car\u00e1cter combinante
    // que cae dentro del rango que borramos abajo, convirti\u00e9ndola en "N" y
    // rompiendo la comparaci\u00f3n (aceptar\u00eda N donde deber\u00eda exigir \u00d1, o viceversa).
    // Por eso se comprueba la \u00d1 ANTES de descomponer y se devuelve intacta.
    const upper = letter.normalize('NFC').toUpperCase();
    if (upper === '\u00d1') return '\u00d1';
    return upper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function crucGetNextCell(word, r, c) {
    const positions = crucGetWordCells(word);
    const idx = positions.findIndex(p => p.row === r && p.col === c);
    if (idx === -1 || idx >= positions.length - 1) return null;
    return positions[idx + 1];
}

function crucGetPrevCell(word, r, c) {
    const positions = crucGetWordCells(word);
    const idx = positions.findIndex(p => p.row === r && p.col === c);
    if (idx <= 0) return null;
    return positions[idx - 1];
}

function crucGetWordCells(word) {
    const cells = [];
    for (let i = 0; i < word.length; i++) {
        cells.push({
            row: word.direction === 'across' ? word.row : word.row + i,
            col: word.direction === 'across' ? word.col + i : word.col
        });
    }
    return cells;
}

/* Mueve el cursor a la siguiente casilla jugable en esa dirección. Si el
   movimiento es perpendicular a la palabra activa, cambia también de palabra:
   bajar estando en una horizontal debe dejarte editando la vertical. */
function crucMoverCursor(tecla) {
    if (!crucSelectedCell) return;
    const pasos = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const [df, dc] = pasos[tecla] || [0, 0];
    const { rows, cols } = crucSize();
    let { row, col } = crucSelectedCell;

    for (let i = 0; i < Math.max(rows, cols); i++) {
        row += df; col += dc;
        if (row < 0 || col < 0 || row >= rows || col >= cols) return;
        if (!crucIsPlayable(row, col)) continue;

        crucSelectedCell = { row, col };
        const quiere = (df !== 0) ? 'down' : 'across';
        const aqui = crucGetWordsAtCell(row, col);
        crucSelectedWord = aqui.find(w => w.direction === quiere)
                        || aqui.find(w => w.id === crucSelectedWord?.id)
                        || aqui[0];
        refreshAllCells();
        updateClueBar();
        updateCluesPanel();
        return;
    }
}

function crucAdvanceToNextWord() {
    if (!crucData || !crucSelectedWord) return;
    const words   = crucData.words;
    const idx     = words.findIndex(w => w.id === crucSelectedWord.id);
    const nextIdx = (idx + 1) % words.length;
    const next    = words[nextIdx];
    crucSelectedWord = next;
    crucSelectedCell = { row: next.row, col: next.col };
    refreshAllCells();
    updateClueBar();
    updateCluesPanel();
}

// ── COMPROBACIÓN DE PALABRAS ─────────────────

function crucCheckWordSolved(word) {
    const cells = crucGetWordCells(word);
    for (let i = 0; i < cells.length; i++) {
        const { row, col } = cells[i];
        const entered = crucUserGrid[`${row},${col}`] || '';
        const correct = crucNormalize(word.answer[i]);
        if (entered !== correct) {
            crucSolvedWords.delete(word.id);
            updateCluesPanel();
            return false;
        }
    }
    crucSolvedWords.add(word.id);
    // Update progress
    const countEl = document.getElementById('cruc-solved-count');
    if (countEl) countEl.textContent = crucSolvedWords.size;
    updateCluesPanel();
    // Flash solved word cells
    cells.forEach(({ row, col }) => updateCellVisual(row, col));
    return true;
}

function crucIsCellCorrect(r, c) {
    // A cell is "correct" if every word through it is solved
    const words = crucGetWordsAtCell(r, c);
    if (words.length === 0) return false;
    return words.some(w => crucSolvedWords.has(w.id));
}

function crucIsComplete() {
    if (!crucData) return false;
    return crucData.words.every(w => crucSolvedWords.has(w.id));
}

// ── MENÚ REVELAR ─────────────────────────────

function crucToggleRevealMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('cruc-reveal-menu');
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    if (!isOpen) {
        // Cerrar al hacer click fuera
        setTimeout(() => {
            document.addEventListener('click', crucCloseRevealMenu, { once: true });
        }, 0);
    }
}

function crucCloseRevealMenu() {
    const menu = document.getElementById('cruc-reveal-menu');
    if (menu) menu.classList.remove('open');
}

function crucRevealLetter() {
    crucCloseRevealMenu();
    if (!crucSelectedCell || !crucData || crucIsComplete()) return;
    crucUsedReveal = true;
    const { row, col } = crucSelectedCell;

    // Encontrar la respuesta correcta para esta celda
    const words = crucGetWordsAtCell(row, col);
    if (words.length === 0) return;
    const word = words[0];
    const cells = crucGetWordCells(word);
    const idx = cells.findIndex(p => p.row === row && p.col === col);
    if (idx === -1) return;

    const correct = crucNormalize(word.answer[idx]);
    crucUserGrid[`${row},${col}`] = correct;
    updateCellVisual(row, col);

    // Comprobar si alguna palabra queda resuelta
    crucGetWordsAtCell(row, col).forEach(w => crucCheckWordSolved(w));

    crucSave();
    if (crucIsComplete()) setTimeout(() => crucShowCompletion(true), 500);
}

function crucRevealWord() {
    crucCloseRevealMenu();
    if (!crucSelectedWord || !crucData || crucIsComplete()) return;
    crucUsedReveal = true;
    const w = crucSelectedWord;
    const cells = crucGetWordCells(w);
    cells.forEach(({ row, col }, i) => {
        crucUserGrid[`${row},${col}`] = crucNormalize(w.answer[i]);
    });
    // Comprobar también las palabras cruzadas que comparten celda con la
    // revelada: rellenar sus letras puede completarlas "de rebote" y hay
    // que marcarlas resueltas igual que hace crucHandleKey/crucRevealLetter.
    const checked = new Set();
    cells.forEach(({ row, col }) => {
        crucGetWordsAtCell(row, col).forEach(ww => {
            if (checked.has(ww.id)) return;
            checked.add(ww.id);
            crucCheckWordSolved(ww);
        });
    });
    const countEl = document.getElementById('cruc-solved-count');
    if (countEl) countEl.textContent = crucSolvedWords.size;
    refreshAllCells();
    updateCluesPanel();
    crucSave();
    if (crucIsComplete()) setTimeout(() => crucShowCompletion(true), 500);
}

// ── REVELAR TODO ─────────────────────────────

function crucRevealAll() {
    crucCloseRevealMenu();
    if (!crucData || crucIsComplete()) return;
    if (!confirm('¿Seguro que quieres revelar toda la cuadrícula?')) return;
    crucUsedReveal = true;
    crucData.words.forEach(w => {
        crucGetWordCells(w).forEach(({ row, col }, i) => {
            crucUserGrid[`${row},${col}`] = crucNormalize(w.answer[i]);
        });
        crucSolvedWords.add(w.id);
    });
    const countEl = document.getElementById('cruc-solved-count');
    if (countEl) countEl.textContent = crucData.words.length;
    refreshAllCells();
    updateCluesPanel();
    crucSave();
    setTimeout(() => crucShowCompletion(true), 500);
}

// ── COMPLETION MODAL ─────────────────────────

function crucShowCompletion(revealed = false) {
    if (crucCountdownInterval) clearInterval(crucCountdownInterval);
    crucRelojPara();

    const modal = document.getElementById('cruc-completion-modal');
    if (!modal) return;

    const total   = crucData.words.length;
    const solved  = crucSolvedWords.size;
    const perfect = solved === total && !revealed && !crucUsedReveal && !crucUsedCheck;

    if (solved === total) crucStatsApuntar();

    const ayuda = crucUsedReveal ? ' · con revelados'
                : crucUsedCheck  ? ' · con comprobaciones' : '';
    document.getElementById('cruc-comp-title').textContent = perfect ? '🏆 ¡PERFECTO!' : '✅ CRUCIGRAMA COMPLETADO';
    document.getElementById('cruc-comp-sub').textContent   =
        `Crucigrama #${crucEdition} · ${crucFechaLarga(crucData.date)}${ayuda}`;
    document.getElementById('cruc-comp-words').textContent = solved;
    document.getElementById('cruc-comp-time').textContent  = crucFormatoTiempo(crucSegundos);
    const global = document.getElementById('cruc-comp-global');
    if (global) global.innerHTML = crucStatsHTML();

    if (crucOffset === 0) {
        const cd = document.getElementById('cruc-countdown');
        if (cd) {
            cd.style.display = 'block';
            const tick = () => { cd.textContent = `⏱ Nuevo crucigrama en ${crucTimeUntilMidnight()}`; };
            tick();
            crucCountdownInterval = setInterval(tick, 1000);
        }
    }

    modal.classList.add('active');
}

function crucCloseCompletion() {
    const modal = document.getElementById('cruc-completion-modal');
    if (modal) modal.classList.remove('active');
    if (crucCountdownInterval) { clearInterval(crucCountdownInterval); crucCountdownInterval = null; }
}

/* ── COMPARTIR RESULTADO (estilo Wordle) ────── */

function crucShare() {
    if (!crucData) return;
    const total  = crucData.words.length;
    const solved = crucSolvedWords.size;
    const limpio = !crucUsedReveal && !crucUsedCheck;
    // En cuadrícula y no en una tira: con 19 palabras la fila de emojis se
    // partía sola en WhatsApp y el resultado quedaba ilegible.
    const casillas = [];
    for (let i = 0; i < total; i += 5) {
        casillas.push(Array.from({ length: Math.min(5, total - i) },
            (_, j) => (i + j < solved ? '🟩' : '⬛')).join(''));
    }
    const text =
        `El Crucigrama FutbolHUB #${crucEdition}\n` +
        `${solved}/${total} palabras en ${crucFormatoTiempo(crucSegundos)}${limpio ? ' ✅' : ' 🔍'}\n` +
        `${casillas.join('\n')}\n` +
        window.location.origin + window.location.pathname;
    crucDoShare(text, document.getElementById('cruc-share-btn'));
}

/* Comparte con la hoja nativa del móvil si existe; si no, copia al portapapeles */
function crucDoShare(text, btn) {
    const feedback = () => {
        if (!btn) return;
        const orig = btn.textContent;
        btn.textContent = '✓ ¡Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    };
    if (navigator.share) {
        navigator.share({ text }).catch(() => {});
    } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(feedback).catch(() => {});
    } else {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            feedback();
        } catch {}
    }
}

/* Cuánto falta para la medianoche DE MADRID, que es cuando cambia el
   crucigrama (crucTodayMadrid manda). Con la medianoche del dispositivo, a
   quien jugara desde otro huso la cuenta atrás le llegaba a cero y seguía
   viendo el mismo crucigrama, o cambiaba con horas de adelanto. */
function crucTimeUntilMidnight() {
    const ahora = new Date();
    const enMadrid = new Date(ahora.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const finDeDia = new Date(enMadrid);
    finDeDia.setHours(24, 0, 0, 0);
    const diff = finDeDia - enMadrid;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── FOCO MÓVIL ───────────────────────────────
// El input oculto global se crea en DOMContentLoaded (al final del archivo).
// Esta función lo enfoca para abrir el teclado nativo en móvil (tap bar).

function crucFocusMobile() {
    const inp = document.getElementById('cruc-mobile-input');
    if (inp) inp.focus({ preventScroll: true });
}
// ── INTEGRACIÓN CON core.js + SETUP GLOBAL ──
document.addEventListener('DOMContentLoaded', () => {

    // Input oculto global (igual que en app.js para el Once)
    //    Se crea UNA SOLA VEZ y persiste toda la sesión.
    const mobileInput = document.createElement('input');
    mobileInput.id = 'cruc-mobile-input';
    mobileInput.type = 'text';
    mobileInput.setAttribute('autocomplete', 'off');
    mobileInput.setAttribute('autocorrect', 'off');
    mobileInput.setAttribute('autocapitalize', 'characters');
    mobileInput.setAttribute('spellcheck', 'false');
    mobileInput.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:none;outline:none;background:transparent;color:transparent;font-size:16px;pointer-events:none;z-index:-1;';
    document.body.appendChild(mobileInput);

    // Evento 'input': teclado nativo móvil (tap bar → focus → escribir)
    mobileInput.addEventListener('input', () => {
        const val = mobileInput.value;
        mobileInput.value = '';
        if (!val) return;
        for (const ch of val) {
            if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]$/i.test(ch)) crucHandleKey(ch.toUpperCase());
        }
    });

    // Backspace en móvil
    mobileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') { e.preventDefault(); mobileInput.value = ''; crucHandleKey('Delete'); }
        else if (e.key === 'Tab')  { e.preventDefault(); crucHandleKey('Tab'); }
    });

    // 3. Teclado físico desktop: igual que en app.js
    //    Solo actúa si el crucigrama está visible Y no es móvil
    document.addEventListener('keydown', (e) => {
        const screen = document.getElementById('crucigrama-screen');
        if (!screen || screen.style.display === 'none') return;

        // En móvil, el input oculto lo maneja todo
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) return;

        const modal = document.getElementById('cruc-completion-modal');
        if (modal && modal.classList.contains('active')) return;

        if (e.key === 'Backspace')                          { e.preventDefault(); crucHandleKey('Delete'); }
        else if (e.key === 'Tab')                           { e.preventDefault(); crucHandleKey('Tab'); }
        else if (e.key.startsWith('Arrow'))                 { e.preventDefault(); crucHandleKey(e.key); }
        else if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]$/i.test(e.key)) { e.preventDefault(); crucHandleKey(e.key.toUpperCase()); }
    });
});

// ── INIT AL CARGAR ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    openCrucigrama();
});
