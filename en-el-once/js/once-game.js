// =============================================
// APP.JS — Lógica del juego "En el Once"
// La navegación global y stats están en core.js
// =============================================

// ESTADO DEL JUEGO
let currentMode = null;
let allMatches = [];
let dailyPool = [];
let currentMatchIndex = 0;
let currentMatch = null;
let currentPlayerIndex = null;
let revealedPlayers = new Set();
let failedPlayers = new Set();
let currentGuess = [];
let guessLocked = false; // true mientras se anima/cierra un acierto o un fallo definitivo
let playerAttempts = {};
let playerGuessHistory = {};

let dailyOffset  = 0;

let matchStats = { guessed: 0, failed: 0, revealed: 0 };

// ── NAVEGACIÓN ──────────────────────────────

function hideAllScreens() {
    document.getElementById('once-menu').style.display   = 'none';
    document.getElementById('loading').style.display     = 'none';
    document.getElementById('game').style.display        = 'none';
}

function goBackToMenu() {
    hideAllScreens();
    hideDailyNav();
    document.getElementById('once-menu').style.display = 'flex';
    // Reset estado
    currentMode = null;
    currentMatch = null;
    // El menu es la URL limpia: si no, recargar te devolveria al modo que
    // acabas de abandonar.
    if (window.FHRuta) FHRuta.borrar('modo', 'dia');
}

// ── NOMBRE DE EQUIPO EN EL MARCADOR ─────────
// Bug: con un nombre de equipo muy largo en un lado y uno corto en el otro,
// el marcador (score-display) se descentraba porque el lado largo reclamaba
// más ancho del que le tocaba en el flex. Ahora el nombre siempre se queda
// dentro de su mitad (min-width:0 + overflow en CSS) y aquí, además,
// reducimos el tamaño de letra según la longitud para que quepa entero en
// vez de cortarse — el marcador nunca se mueve del centro.
function setTeamName(elId, name) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = name || '';
    el.classList.remove('team-name--long', 'team-name--xlong');
    const len = (name || '').length;
    if (len > 22)      el.classList.add('team-name--xlong');
    else if (len > 14) el.classList.add('team-name--long');
}

// ── Escudos de equipo ───────────────────────
// El campo homeBadge/awayBadge puede ser:
//   · una URL (escudo real, p.ej. de Transfermarkt) → se pinta como <img>
//   · un emoji (datos antiguos) → se pinta como texto
// Cuando hay escudo real, marcamos .team-info con .has-crest para que el CSS
// muestre el escudo grande y el nombre pequeño debajo. Si el escudo falla al
// cargar, volvemos automáticamente al nombre grande de siempre (fallback).
function isCrestUrl(v) {
    return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

function setTeamBadge(badgeElId, badgeVal, teamName) {
    const badgeEl = document.getElementById(badgeElId);
    if (!badgeEl) return;
    const info = badgeEl.closest('.team-info');
    badgeEl.innerHTML = '';
    badgeEl.textContent = '';

    // Escudo: primero el guardado en el propio partido (URL exacta); si no, el
    // del mapa central escudos.json por nombre de equipo (cubre datos antiguos).
    const crestUrl = isCrestUrl(badgeVal) ? badgeVal.trim() : getCrest(teamName);

    if (crestUrl) {
        if (info) info.classList.add('has-crest');
        const img = document.createElement('img');
        img.className = 'team-crest';
        img.src = crestUrl;
        img.alt = teamName || '';
        img.loading = 'eager';
        // Si el escudo no carga, quitamos .has-crest y el CSS (.team-badge está
        // display:none salvo con .has-crest) esconde el escudo y recupera el
        // nombre grande centrado. IMPORTANTE: NO borramos la <img> del DOM
        // (nada de innerHTML=''), porque img-heal.js reintenta las imágenes
        // externas que fallan y aborta el reintento si la <img> ya no está
        // conectada. Dejándola puesta, un fallo transitorio de la CDN (típico
        // en móvil, sobre todo al volver de segundo plano) se recupera solo.
        img.addEventListener('error', () => {
            if (info) info.classList.remove('has-crest');
        });
        // Al cargar —también cuando el reintento de img-heal cuela— volvemos a
        // marcar .has-crest para que reaparezca el escudo en su sitio.
        img.addEventListener('load', () => {
            if (info) info.classList.add('has-crest');
        });
        badgeEl.appendChild(img);
    } else {
        if (info) info.classList.remove('has-crest');
        if (badgeVal) badgeEl.textContent = badgeVal;   // emoji de respaldo
    }
}

// ── ONCE DIARIO ─────────────────────────────

// Nombres de meses en español, usados para construir el nombre del archivo JSON
const MONTH_NAMES_ES = [
    'Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];

/**
 * Devuelve la fecha "hoy" en la zona horaria de España (Europe/Madrid).
 * Usamos toLocaleString con timeZone para obtener el día correcto incluso si el usuario
 * está en otro huso horario.
 */
function getSpainDate(offsetDays = 0) {
    const now = new Date();
    now.setDate(now.getDate() - offsetDays);
    // Convertir a fecha local de España
    const parts = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const get = type => parseInt(parts.find(p => p.type === type).value, 10);
    return { year: get('year'), month: get('month'), day: get('day') };
}

/* En el juego la edicion diaria es un OFFSET (0 = hoy, 3 = hace tres dias),
   pero en la URL va la FECHA como en el resto de diarios: un '?dia=3' de hoy
   apuntaria a otro partido manana, y un enlace compartido dejaria de valer. */
function fechaDiaria(offsetDays = 0) {
    const { year, month, day } = getSpainDate(offsetDays);
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function offsetDeFecha(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const hoy = getSpainDate(0);
    return Math.round((Date.UTC(hoy.year, hoy.month - 1, hoy.day)
                     - Date.UTC(y, m - 1, d)) / 86400000);
}

/* Los cinco modos del menu. La URL solo acepta estos: cualquier otra cosa se
   ignora y se entra por el menu, en vez de arrancar un modo que no existe. */
const MODOS_URL = ['diario', 'liga', 'champions', 'historico', 'random'];

/** Clave de localStorage: oncediario_YYYYMMDD */
function getDailyKey(offsetDays = 0) {
    const { year, month, day } = getSpainDate(offsetDays);
    return `oncediario_${year}${String(month).padStart(2,'0')}${String(day).padStart(2,'0')}`;
}

function saveDailyResult(offsetDays, result) {
    localStorage.setItem(getDailyKey(offsetDays), JSON.stringify(result));
}

function loadDailyResult(offsetDays) {
    const raw = localStorage.getItem(getDailyKey(offsetDays));
    return raw ? JSON.parse(raw) : null;
}

/**
 * Guarda el progreso de la partida diaria EN CURSO (completed:false), para
 * que otro dispositivo pueda recogerla a medias — antes solo se escribía al
 * terminar el partido entero, así que abrir la web en otro sitio antes de
 * acabar no encontraba nada que sincronizar. No hace falta un reloj que
 * preservar (a diferencia de Bingo): basta con guardar tras cada intento.
 */
function saveDailyProgress() {
    if (currentMode !== 'diario') return;
    saveDailyResult(dailyOffset, {
        revealedPlayers: Array.from(revealedPlayers),
        failedPlayers:   Array.from(failedPlayers),
        matchStats:      { ...matchStats },
        completed:       false
    });
}

// =============================================
// ESTADÍSTICAS DEL ONCE DIARIO
// =============================================

/**
 * Recorre TODAS las partidas del Once Diario guardadas en localStorage
 * (oncediario_AAAAMMDD) y calcula las estadísticas. Se usa el propio historial
 * como fuente de verdad —no un contador aparte— para que las cifras cuadren
 * siempre con lo que el jugador ve en el archivo de ediciones.
 */
function computeOnceStats() {
    const days = [];               // [{ key, ymd, guessed }] ordenado por fecha
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('oncediario_')) continue;
        const ymd = key.slice('oncediario_'.length);
        if (!/^\d{8}$/.test(ymd)) continue;
        let data;
        try { data = JSON.parse(localStorage.getItem(key)); } catch { continue; }
        if (!data) continue;
        // Partidas a medias (completed:false) no cuentan como jugadas todavía;
        // las entradas de antes de esto no llevan el campo y sí cuentan (solo
        // se guardaban al terminar).
        if (data.completed === false) continue;
        const guessed = Number(data.matchStats?.guessed ?? 0);
        days.push({ ymd, guessed: Math.max(0, Math.min(11, guessed)) });
    }
    days.sort((a, b) => a.ymd.localeCompare(b.ymd));

    // Distribución 0..11
    const dist = new Array(12).fill(0);
    days.forEach(d => { dist[d.guessed]++; });

    const played = days.length;
    const perfect = dist[11];
    const totalGuessed = days.reduce((s, d) => s + d.guessed, 0);
    const avg = played ? totalGuessed / played : 0;

    // Rachas de días CONSECUTIVOS jugados (la racha del diario es de asistencia,
    // no de acierto: se juega cada día). Se compara con el día natural anterior.
    const toDate = ymd => new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
    let best = 0, run = 0, prev = null;
    days.forEach(d => {
        const cur = toDate(d.ymd);
        if (prev && Math.round((cur - prev) / 86400000) === 1) run++;
        else run = 1;
        if (run > best) best = run;
        prev = cur;
    });

    // Racha actual: solo cuenta si la última partida es de hoy o de ayer
    let current = 0;
    if (days.length) {
        const todayYmd = getDailyKey(0).slice('oncediario_'.length);
        const yestYmd  = getDailyKey(1).slice('oncediario_'.length);
        const lastYmd  = days[days.length - 1].ymd;
        if (lastYmd === todayYmd || lastYmd === yestYmd) {
            current = 1;
            for (let i = days.length - 1; i > 0; i--) {
                const d1 = toDate(days[i].ymd), d0 = toDate(days[i - 1].ymd);
                if (Math.round((d1 - d0) / 86400000) === 1) current++;
                else break;
            }
        }
    }

    return { played, perfect, avg, dist, current, best, days };
}

function showStatsModal() {
    const s = computeOnceStats();
    const pctPerfect = s.played ? Math.round((s.perfect / s.played) * 100) : 0;

    const tile = (value, label) =>
        `<div class="completion-stat"><div class="completion-stat-value">${value}</div>` +
        `<div class="completion-stat-label">${label}</div></div>`;

    // "Racha de días" para no confundirla con la "Racha de aciertos" (jugadores
    // adivinados seguidos) que se muestra en el modal de fin de partida — son
    // dos métricas distintas y podían leerse como contradictorias con la misma
    // etiqueta "Racha".
    document.getElementById('stats-top').innerHTML =
        tile(s.played, 'Jugadas') +
        tile(s.avg ? s.avg.toFixed(1) : '0', 'Media /11') +
        tile(s.current, 'Racha de días') +
        tile(s.best, 'Mejor racha');

    const emptyEl = document.getElementById('stats-empty');
    const distWrap = document.querySelector('.stats-dist-wrap');
    if (!s.played) {
        emptyEl.style.display = 'block';
        distWrap.style.display = 'none';
    } else {
        emptyEl.style.display = 'none';
        distWrap.style.display = 'block';

        // La barra más alta marca el 100% del ancho disponible
        const max = Math.max(...s.dist);
        const todayYmd = getDailyKey(0).slice('oncediario_'.length);
        const todayEntry = s.days.find(d => d.ymd === todayYmd);
        let rows = '';
        for (let n = 11; n >= 0; n--) {
            const count = s.dist[n];
            const pct = max ? Math.max(count ? 8 : 0, (count / max) * 100) : 0;
            const isCurrent = todayEntry && todayEntry.guessed === n && count > 0;
            const cls = 'stats-dist-row' + (isCurrent ? ' sd-current' : '') + (count === 0 ? ' sd-zero' : '');
            rows += `<div class="${cls}"><span class="sd-label">${n}</span>` +
                    `<span class="sd-bar-wrap"><span class="sd-bar" style="display:inline-block;width:${pct}%">${count}</span></span></div>`;
        }
        document.getElementById('stats-dist').innerHTML = rows;
    }

    document.getElementById('stats-modal').classList.add('active');
}

function closeStatsModal() {
    document.getElementById('stats-modal').classList.remove('active');
}

/**
 * Nombre del archivo JSON para el mes de una fecha con offset.
 * Formato: Septiembre_2026.json
 */
function getDailyFileName(offsetDays = 0) {
    const { year, month } = getSpainDate(offsetDays);
    return `${MONTH_NAMES_ES[month - 1]}_${year}.json`;
}

// =============================================
// CARGA DE DATOS
// =============================================

function updateLoadingProgress(loaded, total) {
    const pct   = total === 0 ? 0 : Math.round((loaded / total) * 100);
    const fill  = document.getElementById('loading-bar-fill');
    const ball  = document.getElementById('loading-ball');
    const pctEl = document.getElementById('loading-percent');
    if (fill)  fill.style.width  = pct + '%';
    if (ball)  ball.style.left   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
}

async function fetchDailyFile(fileName) {
    const res = await fetch(sbStorageUrl('game-data', `en-el-once/once-diario/${fileName}`), { cache: 'no-cache' });
    if (!res.ok) throw new Error('Archivo no encontrado');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('Archivo vacío');
    return data;
}

/** "Septiembre_2026.json" -> { month: 8 (0-index), year: 2026 } para poder ordenar/comparar. */
function parseDailyFileName(fileName) {
    const m = /^([A-Za-zÀ-ÿ]+)_(\d{4})\.json$/.exec(fileName);
    if (!m) return null;
    const month = MONTH_NAMES_ES.findIndex(n => n.toLowerCase() === m[1].toLowerCase());
    if (month === -1) return null;
    return { month, year: parseInt(m[2], 10) };
}

/**
 * Busca, vía en-el-once/once-diario/manifest.json, el mes más reciente que
 * no sea posterior al mes solicitado (para no "adelantar" partidos que aún
 * no tocan). Si no hay datos, no hay nada que ofrecer.
 */
async function findLatestDailyFile(requestedFileName) {
    const requested = parseDailyFileName(requestedFileName);
    let files;
    try {
        const res = await fetch(sbStorageUrl('game-data', 'en-el-once/once-diario/manifest.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error('manifest no disponible');
        const manifest = await res.json();
        files = Array.isArray(manifest.files) ? manifest.files : [];
    } catch {
        return null;
    }
    if (files.length === 0) return null;

    const parsed = files
        .map(f => ({ file: f, info: parseDailyFileName(f) }))
        .filter(x => x.info);

    const eligible = requested
        ? parsed.filter(x => x.info.year < requested.year ||
            (x.info.year === requested.year && x.info.month <= requested.month))
        : parsed;

    const pool = eligible.length > 0 ? eligible : parsed;
    if (pool.length === 0) return null;

    pool.sort((a, b) => (b.info.year - a.info.year) || (b.info.month - a.info.month));
    return pool[0].file;
}

/* Lista de archivos conocidos por carpeta (igual que antes de pasar por
   Supabase). El manifest.json de cada carpeta se suma por si hay archivos
   nuevos que todavía no estén en esta lista. */
const ONCE_KNOWN_FILES = {
    liga: [
        '14_15.json', '15_16.json', '16_17.json',
        '17_18.json', '18_19.json', '19_20.json',
        '20_21.json', '21_22.json', '22_23.json',
        '23_24.json', '24_25.json', '25_26.json'
    ],
    champions: ['finales.json', 'semifinales.json', 'cuartos.json', 'remontadas.json', 'clasicos.json'],
    historico: ['mundiales.json', 'eurocopas.json', 'olimpiadas.json', 'euroamerica.json']
};

async function fetchMatchesByFolder(folder) {
    const urls = new Set((ONCE_KNOWN_FILES[folder] || []).map(file => `en-el-once/${folder}/${file}`));

    try {
        const res = await fetch(sbStorageUrl('game-data', `en-el-once/${folder}/manifest.json`), { cache: 'no-cache' });
        if (res.ok) {
            const manifest = await res.json();
            (manifest.files || []).forEach(file => urls.add(`en-el-once/${folder}/${file}`));
        }
    } catch { /* sin manifest: se usan solo los archivos conocidos */ }

    const results = await Promise.allSettled(
        [...urls].map(path =>
            fetch(sbStorageUrl('game-data', path), { cache: 'no-cache' })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
        )
    );

    const matches = [];
    results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) matches.push(...result.value);
    });
    return matches;
}

async function loadMatchData(mode, offsetDays = 0) {
    try {
        let folders = [];
        switch (mode) {
            case 'diario':    folders = ['once-diario']; break;
            case 'random':    folders = ['liga', 'champions', 'historico']; break;
            case 'liga':      folders = ['liga'];      break;
            case 'champions': folders = ['champions']; break;
            case 'historico': folders = ['historico']; break;
        }

        // Para modo diario: cargar el archivo del mes de hoy y, si todavía no
        // se ha subido (el scraper va por detrás del calendario real), caer
        // al mes disponible más reciente en vez de dejar el modo sin jugar.
        if (mode === 'diario') {
            const fileName = getDailyFileName(0);
            try {
                const data = await fetchDailyFile(fileName);
                dailyPool  = data;
                allMatches = data;
                dailyLoadedFile = fileName;
                dailyLoadedForOffset = 0;
                dailyAvailability[0] = true;
                updateLoadingProgress(1, 1);
                return true;
            } catch (e) {
                console.warn(`[En el Once] "${fileName}" no disponible, buscando el mes más reciente…`, e);
                try {
                    const fallbackFile = await findLatestDailyFile(fileName);
                    if (!fallbackFile) throw new Error('Sin archivos disponibles');
                    const data = await fetchDailyFile(fallbackFile);
                    dailyPool  = data;
                    allMatches = data;
                    dailyLoadedFile = fallbackFile;
                    dailyLoadedForOffset = 0;
                    dailyAvailability[0] = true;
                    updateLoadingProgress(1, 1);
                    return true;
                } catch (e2) {
                    console.error('Error cargando once diario:', e2);
                    alert('No hay partidos disponibles para este mes.');
                    return false;
                }
            }
        }

        let loaded = 0;
        const total = folders.length;
        updateLoadingProgress(0, total);

        const results = await Promise.allSettled(
            folders.map(folder =>
                fetchMatchesByFolder(folder)
                    .catch(() => [])
                    .finally(() => { loaded++; updateLoadingProgress(loaded, total); })
            )
        );

        const allLoadedMatches = [];
        results.forEach(result => {
            if (result.status === 'fulfilled' && Array.isArray(result.value))
                allLoadedMatches.push(...result.value);
        });

        if (allLoadedMatches.length === 0) throw new Error('No se encontraron partidos');

        if (mode === 'diario') {
            dailyPool  = allLoadedMatches;
            allMatches = allLoadedMatches;
        } else {
            allMatches = shuffleArray(allLoadedMatches);
        }

        return true;

    } catch (error) {
        console.error('Error cargando datos:', error);
        alert('Error al cargar los datos.');
        return false;
    }
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Devuelve el partido del día para el offset dado.
 * El índice es el día del mes - 1 (0-based) en hora española.
 * Si no hay partido para ese día (mes incompleto), toma el último disponible.
 */
function getDailyMatchForOffset(offsetDays) {
    const { day } = getSpainDate(offsetDays);
    // Si las entradas traen el día explícito (_day, lo escribe la herramienta
    // de curación admin/generar_once_diario.py), se busca por día real: así el
    // calendario funciona aunque falte algún día intermedio. Si no (datos
    // antiguos sin _day, p.ej. Septiembre), se cae al índice posicional de
    // siempre: posición 0 = día 1, etc.
    const byDay = dailyPool.find(m => m && Number(m._day) === day);
    if (byDay) return byDay;
    const index = Math.min(day - 1, dailyPool.length - 1);
    return dailyPool[index];
}

/**
 * Devuelve una cadena legible con la fecha española del offset.
 * Ej: "24 de junio" para hoy, "23 de junio" para ayer.
 */
function getDailyDateLabel(offsetDays) {
    const { year, month, day } = getSpainDate(offsetDays);
    const months = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `${day} de ${months[month - 1]}`;
}

// =============================================
// INICIAR JUEGO
// =============================================

async function startGame(mode, offsetInicial, sinTocarUrl) {
    currentMode  = mode;
    dailyOffset  = 0;
    hideAllScreens();
    document.getElementById('loading').style.display = 'block';

    /* El modo entra en la URL: recargar (o volver desde otra pestana, o abrir
       un enlace compartido) te devuelve al modo en el que estabas y no al menu.
       replace y no push: el Atras tiene que sacarte al menu de una vez, no
       recorrer los modos por los que hayas pasado. */
    if (window.FHRuta && !sinTocarUrl) FHRuta.set({ modo: mode, dia: null });

    const loaded = await loadMatchData(mode, 0);
    document.getElementById('loading').style.display = 'none';

    if (!loaded) { goBackToMenu(); return; }

    currentMatchIndex = 0;
    if (mode === 'diario') loadDailyMatch(offsetInicial || 0);
    else loadMatch();
}

// =============================================
// ONCE DIARIO
// =============================================

// Cache de disponibilidad: offset (días) -> true/false
const dailyAvailability = {};
// Cache de pools ya cargados por nombre de archivo, para no refetchear al navegar
const dailyPoolCache = {};
// Archivo mensual actualmente cargado en dailyPool (para saber si hay que recargar)
let dailyLoadedFile = null;
// offsetDays que ese archivo satisface de verdad (puede ser un mes de respaldo
// distinto del "archivo esperado" si el mes real todavía no está publicado).
let dailyLoadedForOffset = null;

/**
 * Comprueba si existe un partido para el offset dado.
 * Usa caché para no repetir el fetch en cada navegación.
 * GitHub Pages no soporta HEAD, así que usa GET y guarda el resultado.
 */
async function checkDayAvailable(offsetDays) {
    if (offsetDays === 0) return true;
    if (dailyAvailability[offsetDays] !== undefined) return dailyAvailability[offsetDays];

    const fileName = getDailyFileName(offsetDays);
    const { day } = getSpainDate(offsetDays);

    // Si ya tenemos el pool en caché para ese archivo, solo verificar que tiene ese día
    if (dailyPoolCache[fileName]) {
        const available = (day - 1) < dailyPoolCache[fileName].length;
        dailyAvailability[offsetDays] = available;
        return available;
    }

    try {
        const data = await fetchDailyFile(fileName);
        // Guardar en caché para reutilizar si el usuario navega a ese mes
        dailyPoolCache[fileName] = data;
        const available = (day - 1) < data.length;
        dailyAvailability[offsetDays] = available;
        return available;
    } catch(e) {
        dailyAvailability[offsetDays] = false;
        return false;
    }
}

async function loadDailyMatch(offsetDays, sinTocarUrl) {
    dailyOffset = offsetDays;

    /* push: cambiar de edicion SI es moverse a otro sitio, y el Atras debe
       deshacerlo. Hoy va sin parametro, que la URL corta es la de hoy. */
    if (window.FHRuta && !sinTocarUrl) {
        /* set() no toca el historial si el valor ya era ese, asi que arrancar
           el modo (que ya deja ?modo=diario) no encadena una entrada de mas. */
        FHRuta.set({ modo: 'diario', dia: offsetDays === 0 ? null : fechaDiaria(offsetDays) },
                   { push: true });
    }

    // Cargar el pool correcto si cambia de mes o está vacío.
    // FIX (anterior): comparar con el archivo REALMENTE cargado (dailyLoadedFile),
    // no con el archivo de hoy. Antes, al navegar a un mes anterior y volver a
    // "Hoy", el pool seguía siendo el del mes anterior y se mostraba una
    // alineación errónea.
    // FIX (2026-08-26): comparar por OFFSET satisfecho (dailyLoadedForOffset), no
    // por nombre de archivo. Si el mes real de este offset aún no está publicado,
    // loadMatchData ya cayó a un mes de respaldo para el offset 0 — comparar por
    // archivo hacía que esto reintentara el archivo inexistente en cada llamada,
    // y al fallar machacaba dailyAvailability[offsetDays] a "false" aunque la
    // pantalla siguiera mostrando (correctamente) el partido de respaldo.
    const neededFile  = getDailyFileName(offsetDays);
    const needsReload = dailyLoadedForOffset !== offsetDays || dailyPool.length === 0;

    if (needsReload) {
        // Primero mirar si ya lo tenemos en caché (prefetcheado por checkDayAvailable)
        if (dailyPoolCache[neededFile]) {
            dailyPool = dailyPoolCache[neededFile];
            dailyLoadedFile = neededFile;
            dailyLoadedForOffset = offsetDays;
        } else {
            document.getElementById('loading').style.display = 'block';
            try {
                const data = await fetchDailyFile(neededFile);
                dailyPool = data;
                dailyLoadedFile = neededFile;
                dailyLoadedForOffset = offsetDays;
                dailyPoolCache[neededFile] = data;
                dailyAvailability[offsetDays] = true;
            } catch(e) {
                // El mes de este offset todavía no está publicado: caer al mes
                // disponible más reciente, igual que hace loadMatchData al
                // arrancar. Sin esto, offsetDays se marcaba "no disponible" con
                // un valor falso mientras dailyPool seguía teniendo datos válidos
                // de un intento anterior — y currentMatch se guardaba más abajo
                // bajo la fecha de HOY aunque fuera en realidad de otro mes.
                try {
                    const fallbackFile = await findLatestDailyFile(neededFile);
                    if (!fallbackFile) throw new Error('Sin archivos disponibles');
                    const data = dailyPoolCache[fallbackFile] || await fetchDailyFile(fallbackFile);
                    dailyPool = data;
                    dailyLoadedFile = fallbackFile;
                    dailyLoadedForOffset = offsetDays;
                    dailyPoolCache[fallbackFile] = data;
                    dailyAvailability[offsetDays] = true;
                } catch (e2) {
                    dailyAvailability[offsetDays] = false;
                }
            }
            document.getElementById('loading').style.display = 'none';
        }
    }

    currentMatch = getDailyMatchForOffset(offsetDays);
    if (!currentMatch) {
        alert('No hay partido disponible para este día.');
        return;
    }

    revealedPlayers    = new Set();
    failedPlayers      = new Set();
    playerAttempts     = {};
    playerGuessHistory = {};
    matchStats         = { guessed: 0, failed: 0, revealed: 0 };

    document.getElementById('competition').textContent  = currentMatch.competition;
    setTeamName('home-team', currentMatch.homeTeam);
    setTeamName('away-team', currentMatch.awayTeam);
    document.getElementById('score').textContent        = currentMatch.score;
    document.getElementById('date').textContent         = currentMatch.date;
    document.getElementById('playing-team').textContent = `ALINEACIÓN: ${currentMatch.playingTeam}`;

    setTeamBadge('home-badge', currentMatch.homeBadge, currentMatch.homeTeam);
    setTeamBadge('away-badge', currentMatch.awayBadge, currentMatch.awayTeam);
    renderGoals();

    document.getElementById('next-match-btn').style.display = 'none';

    // Comprobar si el día anterior existe (async, no bloquea la carga)
    const prevAvailable = offsetDays < 30 ? await checkDayAvailable(offsetDays + 1) : false;
    updateDailyHeader(offsetDays, prevAvailable);

    document.getElementById('game').style.display = 'block';

    const saved = loadDailyResult(offsetDays);
    if (saved && saved.completed !== false) {
        // Partida terminada (o guardada antes de que existiera el campo
        // completed, que solo se escribía al terminar): pantalla de "ya jugaste".
        renderFormationFromSaved(saved);
        showDailyAlreadyPlayed(saved, offsetDays);
    } else if (saved) {
        // Partida a medias, guardada desde este mismo dispositivo u otro:
        // se retoma donde se dejó, sin pasar por la pantalla de resultado.
        renderFormationFromSaved(saved);
    } else {
        renderFormation();
        updateRevealedCount();
    }
}

function updateDailyHeader(offsetDays, prevAvailable = false) {
    const navEl = document.getElementById('day-nav');
    if (!navEl) return;

    document.body.classList.add('daily-nav-active');
    navEl.classList.remove('hidden');

    const canGoBack    = prevAvailable;      // hay archivo para el día anterior
    const canGoForward = offsetDays > 0;     // no estamos ya en hoy

    const dateLabel = getDailyDateLabel(offsetDays);

    document.getElementById('nav-label').textContent = dateLabel;
    const firstBtn = document.getElementById('nav-first');
    const prevBtn  = document.getElementById('nav-prev');
    const nextBtn  = document.getElementById('nav-next');
    const lastBtn  = document.getElementById('nav-last');
    firstBtn.disabled = !canGoBack;
    prevBtn.disabled  = !canGoBack;
    nextBtn.disabled  = !canGoForward;
    lastBtn.disabled  = !canGoForward;
}

function hideDailyNav() {
    document.body.classList.remove('daily-nav-active');
    const navEl = document.getElementById('day-nav');
    if (navEl) navEl.classList.add('hidden');
}

async function navigateDaily(newOffset) {
    if (newOffset < 0 || newOffset > 30) return;
    await loadDailyMatch(newOffset);
}

async function navigateDailyStep(delta) {
    await navigateDaily(dailyOffset + delta);
}

// Salta a la edición más antigua disponible, comprobando hacia atrás desde
// el límite de 30 días (los resultados se cachean en dailyAvailability, así
// que repetir esta comprobación al navegar no supone refetchear nada).
async function navigateDailyFirst() {
    let target = dailyOffset;
    for (let offset = dailyOffset + 1; offset <= 30; offset++) {
        const available = await checkDayAvailable(offset);
        if (available) target = offset;
        else break;
    }
    if (target !== dailyOffset) await loadDailyMatch(target);
}

function renderFormationFromSaved(saved) {
    revealedPlayers = new Set(saved.revealedPlayers || []);
    failedPlayers   = new Set(saved.failedPlayers   || []);
    matchStats      = saved.matchStats || { guessed: 0, failed: 0, revealed: 0 };
    renderFormation();
    // El renderGoals() de más arriba (en loadDailyMatch) corrió con
    // revealedPlayers todavía vacío, antes de aplicar este guardado: sin
    // repetirlo aquí, un gol de un jugador ya revelado se queda tapado para
    // siempre al cargar desde otro dispositivo (o al recargar).
    renderGoals();
    if (saved.completed === false) {
        // A medias: el contador es el de verdad y puede completar el partido
        // desde aquí (updateRevealedCount ya sabe disparar el modal si toca).
        updateRevealedCount();
    } else {
        const total = currentMatch.formation.reduce((s, l) => s + l.length, 0);
        document.getElementById('revealed-count').textContent = total;
    }
}

function showDailyAlreadyPlayed(saved, offsetDays) {
    setTimeout(() => {
        document.getElementById('completion-match').textContent =
            `${currentMatch.homeTeam} ${currentMatch.score} ${currentMatch.awayTeam} • ${currentMatch.date}`;
        document.getElementById('comp-guessed').textContent  = saved.matchStats?.guessed  ?? 0;
        document.getElementById('comp-failed').textContent   = saved.matchStats?.failed   ?? 0;
        document.getElementById('comp-revealed').textContent = saved.matchStats?.revealed ?? 0;

        if (offsetDays === 0) {
            document.querySelector('.completion-title').textContent =
                saved.matchStats?.guessed === 11 ? '🏆 ¡ONCE PERFECTO!' : '✅ YA JUGASTE HOY';
        } else {
            const dateLabel = getDailyDateLabel(offsetDays);
            document.querySelector('.completion-title').textContent = `📅 ${dateLabel.toUpperCase()}`;
        }

        document.getElementById('comp-streak').style.display = 'none';
        const nextBtn = document.querySelector('.completion-buttons .next-btn');
        if (nextBtn) nextBtn.style.display = 'none';

        // Solo mostrar countdown si es hoy
        if (offsetDays === 0) startDailyCountdown();
        else {
            const el = document.getElementById('comp-countdown');
            if (el) el.style.display = 'none';
        }

        document.getElementById('completion-modal').classList.add('active');
    }, 400);
}

// =============================================
// PARTIDOS NORMALES
// =============================================

function loadMatch() {
    if (currentMatchIndex >= allMatches.length) {
        alert('¡Has completado todos los partidos de este modo!');
        // FIX: goToGame() no existe en esta página — lanzaba ReferenceError
        // y dejaba la pantalla congelada al agotar los partidos del modo.
        goBackToMenu();
        return;
    }

    currentMatch       = allMatches[currentMatchIndex];
    revealedPlayers    = new Set();
    failedPlayers      = new Set();
    playerAttempts     = {};
    playerGuessHistory = {};
    matchStats         = { guessed: 0, failed: 0, revealed: 0 };

    document.getElementById('competition').textContent  = currentMatch.competition;
    setTeamName('home-team', currentMatch.homeTeam);
    setTeamName('away-team', currentMatch.awayTeam);
    document.getElementById('score').textContent        = currentMatch.score;
    document.getElementById('date').textContent         = currentMatch.date;
    document.getElementById('playing-team').textContent = `ALINEACIÓN: ${currentMatch.playingTeam}`;

    setTeamBadge('home-badge', currentMatch.homeBadge, currentMatch.homeTeam);
    setTeamBadge('away-badge', currentMatch.awayBadge, currentMatch.awayTeam);
    renderGoals();

    document.getElementById('next-match-btn').style.display = 'inline-block';

    hideDailyNav();

    renderFormation();
    updateRevealedCount();
    document.getElementById('game').style.display = 'block';
}

// =============================================
// CAMISETAS (kits por equipo) + CAMPO
// =============================================

let _currentKit = null;
let _jerseyUID  = 0;

// Portero: kit propio, siempre contrasta con el cesped y con el equipo
const GK_KIT = { p:'#23262e', s:'#c7f94b', pat:'solid', sl:'#1c1f25', col:'#c7f94b', num:'#c7f94b' };

function _hex2rgb(h){ h=h.replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function _lum(h){ const [r,g,b]=_hex2rgb(h); return (0.2126*r+0.7152*g+0.0722*b)/255; }
function _autoNum(h){ return _lum(h)>0.58 ? '#16181d' : '#ffffff'; }
function _hslHex(h,s,l){ s/=100; l/=100; const a=s*Math.min(l,1-l); const f=n=>{ const k=(n+h/30)%12; return l-a*Math.max(-1,Math.min(k-3,Math.min(9-k,1))); }; const to=x=>Math.round(255*x).toString(16).padStart(2,'0'); return '#'+to(f(0))+to(f(8))+to(f(4)); }

// patrones: solid | stripes | hoops | halves | diagonalhalves | sash | centerband | checkers
// Reglas ordenadas: los nombres ambiguos (ATLETICO antes que MADRID) van primero.
const KIT_RULES = [
  // ---- España ----
  [['ATLETICO','ATLETI','ATHLETICO'], {p:'#cb3524',s:'#ffffff',pat:'stripes',sl:'#1c3a73',col:'#1c3a73',num:'#ffffff'}],
  [['ATHLETIC','BILBAO'],             {p:'#ee2523',s:'#ffffff',pat:'stripes',sl:'#ffffff',col:'#0a1a3f',num:'#ffffff'}],
  [['REAL SOCIEDAD','SOCIEDAD'],      {p:'#0a52a0',s:'#ffffff',pat:'stripes',sl:'#ffffff',col:'#ffffff',num:'#ffffff'}],
  [['REAL BETIS','BETIS'],            {p:'#129b4a',s:'#ffffff',pat:'stripes',sl:'#ffffff',col:'#ffffff',num:'#ffffff'}],
  [['VALLADOLID'],                    {p:'#6f2c91',s:'#ffffff',pat:'stripes',sl:'#ffffff',col:'#ffffff',num:'#ffffff'}],
  [['REAL MADRID'],                   {p:'#ffffff',s:'#febe10',pat:'solid',sl:'#ffffff',col:'#0b1f4d',num:'#0b1f4d'}],
  [['BARCELONA','BARCA','BARÇA'],     {p:'#a50044',s:'#004d98',pat:'stripes',sl:'#004d98',col:'#ffd000',num:'#ffd000'}],
  [['SEVILLA'],                       {p:'#ffffff',s:'#d81e33',pat:'solid',sl:'#ffffff',col:'#d81e33',num:'#d81e33'}],
  [['VILLARREAL'],                    {p:'#ffe667',s:'#0a2240',pat:'solid',sl:'#ffe667',col:'#0a2240',num:'#16315e'}],
  [['VALENCIA'],                      {p:'#ffffff',s:'#ee3524',pat:'solid',sl:'#ffffff',col:'#111111',num:'#1a1a1a'}],
  [['CELTA'],                         {p:'#8ac3ee',s:'#e4002b',pat:'solid',sl:'#8ac3ee',col:'#e4002b',num:'#143b6b'}],
  [['GETAFE'],                        {p:'#005999',s:'#ffffff',pat:'solid',sl:'#005999',col:'#ffffff',num:'#ffffff'}],
  [['GIRONA'],                        {p:'#cd2534',s:'#ffffff',pat:'stripes',sl:'#cd2534',col:'#ffffff',num:'#ffffff'}],
  [['OSASUNA'],                       {p:'#d91a21',s:'#0a2240',pat:'solid',sl:'#0a2240',col:'#0a2240',num:'#ffffff'}],
  [['RAYO'],                          {p:'#ffffff',s:'#e53027',pat:'sash',sl:'#ffffff',col:'#e53027',num:'#1a1a1a'}],
  [['ESPANYOL'],                      {p:'#0072ce',s:'#ffffff',pat:'stripes',sl:'#0072ce',col:'#ffffff',num:'#ffffff'}],
  [['MALLORCA'],                      {p:'#e2231a',s:'#1a1a1a',pat:'solid',sl:'#1a1a1a',col:'#1a1a1a',num:'#ffffff'}],
  [['ALAVES'],                        {p:'#0761af',s:'#ffffff',pat:'stripes',sl:'#0761af',col:'#ffffff',num:'#ffffff'}],
  [['GRANADA'],                       {p:'#c8102e',s:'#ffffff',pat:'hoops',sl:'#c8102e',col:'#1a1a1a',num:'#ffffff'}],
  [['CADIZ'],                         {p:'#f4d600',s:'#0a3d91',pat:'solid',sl:'#f4d600',col:'#0a3d91',num:'#0a3d91'}],
  [['ELCHE'],                         {p:'#ffffff',s:'#0a8f3c',pat:'hband',sl:'#0a8f3c',col:'#0a8f3c',num:'#1a1a1a'}],
  [['ALMERIA'],                       {p:'#ce1126',s:'#ffffff',pat:'stripes',sl:'#ce1126',col:'#ffffff',num:'#ffffff'}],
  [['EIBAR'],                         {p:'#1a2d6b',s:'#7d1f35',pat:'stripes',sl:'#1a2d6b',col:'#7d1f35',num:'#ffffff'}],
  [['DEPORTIVO','CORUNA','CORUÑA'],   {p:'#ffffff',s:'#1a3a6b',pat:'stripes',sl:'#1a3a6b',col:'#1a3a6b',num:'#1a3a6b'}],
  [['LEGANES'],                       {p:'#004b9f',s:'#ffffff',pat:'stripes',sl:'#004b9f',col:'#ffffff',num:'#ffffff'}],
  [['LAS PALMAS','PALMAS'],           {p:'#ffe000',s:'#0067b1',pat:'solid',sl:'#ffe000',col:'#0067b1',num:'#0067b1'}],
  [['LEVANTE'],                       {p:'#004b9d',s:'#9d1846',pat:'stripes',sl:'#9d1846',col:'#9d1846',num:'#ffffff'}],
  // ---- Inglaterra ----
  [['MANCHESTER CITY','MAN CITY'],          {p:'#6cabdd',s:'#1c2c5b',pat:'solid',sl:'#6cabdd',col:'#1c2c5b',num:'#1c2c5b'}],
  [['MANCHESTER UNITED','MAN UTD','MAN UNITED'], {p:'#da291c',s:'#000000',pat:'solid',sl:'#da291c',col:'#1a1a1a',num:'#ffffff'}],
  [['LIVERPOOL'],                           {p:'#c8102e',s:'#ffffff',pat:'solid',sl:'#c8102e',col:'#00b2a9',num:'#ffffff'}],
  [['CHELSEA'],                             {p:'#034694',s:'#ffffff',pat:'solid',sl:'#034694',col:'#ffffff',num:'#ffffff'}],
  [['ARSENAL'],                             {p:'#ef0107',s:'#ffffff',pat:'solid',sl:'#ffffff',col:'#1a1a1a',num:'#ffffff'}],
  [['TOTTENHAM','SPURS'],                   {p:'#ffffff',s:'#132257',pat:'solid',sl:'#ffffff',col:'#132257',num:'#132257'}],
  [['NEWCASTLE'],                           {p:'#ffffff',s:'#241f20',pat:'stripes',sl:'#241f20',col:'#241f20',num:'#241f20'}],
  // ---- Alemania ----
  [['BAYERN','MUNICH','MUNCHEN'],     {p:'#dc052d',s:'#ffffff',pat:'solid',sl:'#dc052d',col:'#0066b2',num:'#ffffff'}],
  [['DORTMUND','BVB'],                {p:'#fde100',s:'#1a1a1a',pat:'solid',sl:'#fde100',col:'#1a1a1a',num:'#1a1a1a'}],
  [['LEVERKUSEN'],                    {p:'#e32219',s:'#1a1a1a',pat:'solid',sl:'#1a1a1a',col:'#1a1a1a',num:'#ffffff'}],
  [['LEIPZIG'],                       {p:'#ffffff',s:'#dd0741',pat:'solid',sl:'#ffffff',col:'#dd0741',num:'#dd0741'}],
  // ---- Italia ----
  [['JUVENTUS','JUVE'],               {p:'#ffffff',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#1a1a1a'}],
  [['INTER','INTERNAZIONALE'],        {p:'#0b1f8c',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#ffffff'}],
  [['MILAN'],                         {p:'#fb090b',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#ffffff'}],
  [['NAPOLI'],                        {p:'#12a0d7',s:'#ffffff',pat:'solid',sl:'#12a0d7',col:'#ffffff',num:'#ffffff'}],
  [['ROMA'],                          {p:'#8e1f2f',s:'#f0bc42',pat:'solid',sl:'#8e1f2f',col:'#f0bc42',num:'#f0bc42'}],
  [['LAZIO'],                         {p:'#87d8f7',s:'#13235b',pat:'solid',sl:'#87d8f7',col:'#13235b',num:'#13235b'}],
  [['ATALANTA'],                      {p:'#1d71b8',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#ffffff'}],
  // ---- Francia ----
  [['PARIS','PSG'],                   {p:'#0b2240',s:'#da291c',pat:'centerband',sl:'#0b2240',col:'#da291c',num:'#ffffff',edge:true}],
  [['MARSEILLE','MARSELLA'],          {p:'#ffffff',s:'#2faadc',pat:'solid',sl:'#ffffff',col:'#2faadc',num:'#2faadc'}],
  [['LYON','LYONNAIS'],               {p:'#ffffff',s:'#da291c',pat:'solid',sl:'#ffffff',col:'#13235b',num:'#13235b'}],
  [['MONACO'],                        {p:'#e3001b',s:'#ffffff',pat:'diagonalhalves',sl:'#e3001b',col:'#ffffff',num:'#1a1a1a'}],
  // ---- Portugal ----
  [['PORTO'],                         {p:'#00428c',s:'#ffffff',pat:'stripes',sl:'#00428c',col:'#ffffff',num:'#ffffff'}],
  [['BENFICA'],                       {p:'#e40521',s:'#ffffff',pat:'solid',sl:'#e40521',col:'#ffffff',num:'#ffffff'}],
  [['SPORTING LISBOA','SPORTING CP'], {p:'#008057',s:'#ffffff',pat:'hoops',sl:'#008057',col:'#1a1a1a',num:'#ffffff'}],
  [['SPORTING GIJON','GIJÓN','GIJON','SPORTING DE GIJON'], {p:'#e8002d',s:'#ffffff',pat:'stripes',sl:'#e8002d',col:'#e8002d',num:'#ffffff'}],
  // ---- Paises Bajos ----
  [['AJAX'],                          {p:'#ffffff',s:'#d2122e',pat:'centerband',sl:'#ffffff',col:'#d2122e',num:'#1a1a1a'}],
  [['PSV'],                           {p:'#ee2e24',s:'#ffffff',pat:'solid',sl:'#ffffff',col:'#1a1a1a',num:'#ffffff'}],
  [['FEYENOORD'],                     {p:'#c81e1e',s:'#ffffff',pat:'halves',sl:'#ffffff',col:'#1a1a1a',num:'#ffffff'}],
  // ---- Escocia ----
  [['CELTIC'],                        {p:'#16603e',s:'#ffffff',pat:'hoops',sl:'#16603e',col:'#1a1a1a',num:'#ffffff'}],
  [['RANGERS'],                       {p:'#1b458f',s:'#ffffff',pat:'solid',sl:'#1b458f',col:'#e01020',num:'#ffffff'}],
  // ---- Turquia / Ucrania ----
  [['GALATASARAY'],                   {p:'#a90432',s:'#fdb912',pat:'halves',sl:'#a90432',col:'#fdb912',num:'#ffffff'}],
  [['FENERBAHCE'],                    {p:'#ffed00',s:'#14467a',pat:'stripes',sl:'#14467a',col:'#14467a',num:'#14467a'}],
  [['BESIKTAS'],                      {p:'#ffffff',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#1a1a1a'}],
  [['SHAKHTAR'],                      {p:'#f58220',s:'#000000',pat:'stripes',sl:'#000000',col:'#000000',num:'#1a1a1a'}],
  // ---- Selecciones ----
  [['ESPANA','ESPAÑA','SPAIN'],                 {p:'#c60b1e',s:'#f9d616',pat:'solid',sl:'#c60b1e',col:'#13235b',num:'#f9d616'}],
  [['BRASIL','BRAZIL'],                         {p:'#ffdf00',s:'#009739',pat:'solid',sl:'#009739',col:'#009739',num:'#0a3d91'}],
  [['ARGENTINA'],                              {p:'#75aadb',s:'#ffffff',pat:'stripes',sl:'#75aadb',col:'#f6b40e',num:'#13235b'}],
  [['ALEMANIA','GERMANY','DEUTSCHLAND'],        {p:'#ffffff',s:'#1a1a1a',pat:'solid',sl:'#ffffff',col:'#1a1a1a',num:'#1a1a1a'}],
  [['FRANCIA','FRANCE'],                        {p:'#1a2d6b',s:'#ffffff',pat:'solid',sl:'#1a2d6b',col:'#e3001b',num:'#ffffff'}],
  [['ITALIA','ITALY'],                          {p:'#1e4fa0',s:'#ffffff',pat:'solid',sl:'#1e4fa0',col:'#ffffff',num:'#ffffff'}],
  [['INGLATERRA','ENGLAND'],                    {p:'#ffffff',s:'#e3001b',pat:'solid',sl:'#ffffff',col:'#13235b',num:'#13235b'}],
  [['PORTUGAL'],                               {p:'#c00000',s:'#0a6b3b',pat:'solid',sl:'#c00000',col:'#0a6b3b',num:'#f6d100'}],
  [['HOLANDA','NETHERLANDS','PAISES BAJOS','ORANJE'], {p:'#ec8b00',s:'#ffffff',pat:'solid',sl:'#ec8b00',col:'#13235b',num:'#13235b'}],
  [['BELGICA','BELGIUM'],                       {p:'#e30613',s:'#f9d616',pat:'solid',sl:'#e30613',col:'#1a1a1a',num:'#f9d616'}],
  [['URUGUAY'],                                {p:'#4f9bd9',s:'#ffffff',pat:'solid',sl:'#4f9bd9',col:'#13235b',num:'#13235b'}],
  [['MEXICO'],                                 {p:'#006847',s:'#ffffff',pat:'solid',sl:'#006847',col:'#e3001b',num:'#ffffff'}],
  [['CROACIA','CROATIA','HRVATSKA'],            {p:'#d3122e',s:'#ffffff',pat:'checkers',sl:'#d3122e',col:'#13235b',num:'#13235b'}],
  [['COLOMBIA'],                               {p:'#fcd116',s:'#003893',pat:'solid',sl:'#fcd116',col:'#003893',num:'#003893'}],
  [['CHILE'],                                  {p:'#d52b1e',s:'#0039a6',pat:'solid',sl:'#d52b1e',col:'#0039a6',num:'#ffffff'}],
  [['JAPON','JAPAN'],                          {p:'#0b1f8c',s:'#ffffff',pat:'solid',sl:'#0b1f8c',col:'#ffffff',num:'#ffffff'}],
  [['NIGERIA'],                                {p:'#008751',s:'#ffffff',pat:'solid',sl:'#ffffff',col:'#1a1a1a',num:'#ffffff'}],
  [['CAMERUN','CAMEROON'],                      {p:'#008751',s:'#fcd116',pat:'solid',sl:'#008751',col:'#e3001b',num:'#fcd116'}],
  [['ESTADOS UNIDOS','UNITED STATES'],          {p:'#ffffff',s:'#13235b',pat:'solid',sl:'#ffffff',col:'#bf0a30',num:'#13235b'}],
];

function _fallbackKit(n){
  let h=0; for(let i=0;i<n.length;i++) h=(h*31+n.charCodeAt(i))>>>0;
  const hue=h%360;
  const main=_hslHex(hue,60,44);
  const second=((h>>3)&1) ? '#ffffff' : _hslHex((hue+210)%360,52,38);
  const pats=['solid','stripes','solid','sash'];
  const pat=pats[(h>>5)%pats.length];
  return { p:main, s:second, pat, sl: pat==='stripes'?second:main, col:second, num:_autoNum(main) };
}

/* Reglas activas: por defecto las embebidas (KIT_RULES); si en-el-once/kits.json
   existe y es v\u00e1lido, se sustituyen por las de ah\u00ed (editable sin tocar c\u00f3digo). */
let _kitRules = KIT_RULES;
let _gkKit    = GK_KIT;

function loadKitsJson() {
  fetch(sbStorageUrl('game-data', 'en-el-once/kits.json'), { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      if (Array.isArray(data.rules)) {
        const rules = data.rules
          .filter(r => Array.isArray(r.keys) && r.keys.length && r.kit && r.kit.p)
          .map(r => [r.keys.map(k => String(k).toUpperCase()), r.kit]);
        if (rules.length) {
          _kitRules = rules;
          console.log(`\u2705 Kits cargados desde kits.json: ${rules.length} reglas`);
        }
      }
      if (data.gk && data.gk.p) _gkKit = data.gk;
    })
    .catch(() => { /* sin kits.json: se usan las reglas embebidas */ });
}

function getKit(team){
  const n=(team||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  for(const [keys,kit] of _kitRules){ if(keys.some(k=>n.includes(k))) return kit; }
  return _fallbackKit(n);
}

/* \u2500\u2500 ESCUDOS por equipo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   Mapa central en-el-once/escudos.json (nombre de equipo -> URL del escudo).
   Permite mostrar escudos en TODOS los partidos \u2014incluso los antiguos que
   guardan un emoji en homeBadge/awayBadge\u2014 sin reescribir sus JSON: el juego
   busca aqu\u00ed el escudo por el nombre del equipo. Mismo emparejamiento que los
   kits (nombre normalizado + includes de cada clave). El scraper del calendario
   (admin/generar_once_diario.py) va rellenando este archivo solo. */
let _crestRules = [];   // [[keys(may\u00fasculas), url], ...]

function loadEscudosJson() {
  fetch(sbStorageUrl('game-data', 'en-el-once/escudos.json'), { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !Array.isArray(data.teams)) return;
      const rules = data.teams
        .filter(t => Array.isArray(t.keys) && t.keys.length && typeof t.crest === 'string' && /^https?:\/\//i.test(t.crest))
        .map(t => [t.keys.map(k => String(k).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()), t.crest.trim()]);
      if (rules.length) {
        _crestRules = rules;
        // Si ya hay un partido en pantalla, refrescar sus escudos ahora que el
        // mapa est\u00e1 disponible (evita que el primer partido se quede sin escudo).
        if (currentMatch && document.getElementById('game') &&
            document.getElementById('game').style.display !== 'none') {
          setTeamBadge('home-badge', currentMatch.homeBadge, currentMatch.homeTeam);
          setTeamBadge('away-badge', currentMatch.awayBadge, currentMatch.awayTeam);
        }
      }
    })
    .catch(() => { /* sin escudos.json: se usa el emoji/nombre de siempre */ });
}

function getCrest(team){
  if (!_crestRules.length) return null;
  const n = (team || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  for (const [keys, url] of _crestRules) { if (keys.some(k => n.includes(k))) return url; }
  return null;
}

function _pattern(pat, main, second, K){
  switch(pat){
    case 'stripes': { let r=''; const x0=23,x1=77,n=6,w=(x1-x0)/n; for(let i=1;i<n;i+=2) r+=`<rect x="${(x0+i*w).toFixed(1)}" y="0" width="${(w+0.4).toFixed(1)}" height="100" fill="${second}"/>`; return r; }
    case 'hoops':   { let r=''; const y0=10,y1=98,n=7,h=(y1-y0)/n; for(let i=1;i<n;i+=2) r+=`<rect x="0" y="${(y0+i*h).toFixed(1)}" width="100" height="${(h+0.4).toFixed(1)}" fill="${second}"/>`; return r; }
    case 'halves':  return `<rect x="50" y="0" width="50" height="100" fill="${second}"/>`;
    case 'diagonalhalves': return `<polygon points="100,0 100,100 12,100" fill="${second}"/>`;
    case 'sash':    return `<polygon points="73,1 97,25 31,100 8,80" fill="${second}"/>`;
    case 'centerband': { let r=`<rect x="41" y="0" width="18" height="100" fill="${second}"/>`; if(K&&K.edge) r+=`<rect x="39.4" y="0" width="1.5" height="100" fill="#fff"/><rect x="59.1" y="0" width="1.5" height="100" fill="#fff"/>`; return r; }
    case 'hband': return `<rect x="0" y="41" width="100" height="18" fill="${second}"/>`;
    case 'checkers': { let r=''; const x0=23,y0=5,cw=(77-23)/5,ch=(99-5)/6; for(let i=0;i<5;i++) for(let j=0;j<6;j++){ if((i+j)%2) r+=`<rect x="${(x0+i*cw).toFixed(1)}" y="${(y0+j*ch).toFixed(1)}" width="${(cw+0.3).toFixed(1)}" height="${(ch+0.3).toFixed(1)}" fill="${second}"/>`; } return r; }
    default: return '';
  }
}

function buildJerseySVG(kit, number, isGK){
  const uid='k'+(_jerseyUID++);
  const K = isGK ? _gkKit : (kit || _fallbackKit(''));
  const main   = K.p;
  const second = K.s || _hslHex(0,0,30);
  const pat    = isGK ? 'solid' : (K.pat||'solid');
  const sleeve = K.sl || (pat==='stripes' ? second : main);
  const collar = K.col || K.s || 'rgba(0,0,0,0.30)';
  const num    = K.num || _autoNum(main);
  // fondo garantizado: rect semitransparente detrás del número, solo en camisetas con patrón
  const bgDark  = _lum(num) > 0.42;
  const numStroke = bgDark ? '#000000' : '#ffffff';
  const body='M28 11 L25 47 L23 95 L77 95 L75 47 L72 11 C64 19 36 19 28 11 Z';
  const lsl ='M28 11 L8 21 L3 41 L25 47 Z';
  const rsl ='M72 11 L92 21 L97 41 L75 47 Z';
  const neck='M28 11 C36 19 64 19 72 11';
  return `<svg class="jersey-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><clipPath id="${uid}b"><path d="${body}"/></clipPath>`
    + `<linearGradient id="${uid}s" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="#fff" stop-opacity="0.16"/>`
    + `<stop offset="0.42" stop-color="#fff" stop-opacity="0"/>`
    + `<stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>`
    + `<path d="${lsl}" fill="${sleeve}"/><path d="${rsl}" fill="${sleeve}"/>`
    + `<path d="${lsl}" fill="url(#${uid}s)"/><path d="${rsl}" fill="url(#${uid}s)"/>`
    + `<g clip-path="url(#${uid}b)"><rect x="0" y="0" width="100" height="100" fill="${main}"/>`
    + _pattern(pat, main, second, K)
    + `<rect x="0" y="0" width="100" height="100" fill="url(#${uid}s)"/></g>`
    + `<path d="${body}" fill="none" stroke="rgba(0,0,0,0.30)" stroke-width="1.4"/>`
    + `<path d="${lsl}" fill="none" stroke="rgba(0,0,0,0.24)" stroke-width="1.1"/>`
    + `<path d="${rsl}" fill="none" stroke="rgba(0,0,0,0.24)" stroke-width="1.1"/>`
    + `<path d="${neck}" fill="none" stroke="${collar}" stroke-width="3.6" stroke-linecap="round"/>`
    + `<text x="50" y="66" text-anchor="middle" font-family="'Bebas Neue','Rajdhani',sans-serif" font-size="31" font-weight="700" paint-order="stroke" stroke="${numStroke}" stroke-width="3.5" stroke-linejoin="round" fill="${num}">${number!=null?number:''}</text>`
    + `</svg>`;
}

// ---- Marcas del campo (se inyectan una vez dentro de .field-container) ----
const PITCH_HTML = `
<div class="pitch-lines" aria-hidden="true">
  <div class="pl-bounds"></div>
  <div class="pl-half"></div>
  <div class="pl-circle"></div>
  <div class="pl-spot pl-spot-c"></div>
  <div class="pl-pbox pl-top"></div>
  <div class="pl-pbox pl-bottom"></div>
  <div class="pl-gbox pl-top"></div>
  <div class="pl-gbox pl-bottom"></div>
  <div class="pl-spot pl-spot-top"></div>
  <div class="pl-spot pl-spot-bottom"></div>
  <div class="pl-arc pl-arc-top"></div>
  <div class="pl-arc pl-arc-bottom"></div>
  <div class="pl-goal pl-top"></div>
  <div class="pl-goal pl-bottom"></div>
  <i class="pl-corner pl-tl"></i><i class="pl-corner pl-tr"></i>
  <i class="pl-corner pl-bl"></i><i class="pl-corner pl-br"></i>
</div>`;

function ensurePitch(){
  const fc = document.querySelector('.field-container');
  if(!fc || fc.querySelector('.pitch-lines')) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = PITCH_HTML.trim();
  fc.insertBefore(tmp.firstChild, fc.firstChild);
}

// =============================================
// RENDER FORMACIÓN
// =============================================

/**
 * Cada posición tiene un "grupo de fila" (rowGroup).
 * Todos los jugadores del mismo grupo se muestran en la misma fila visual.
 * El número determina la altura: mayor número = más arriba en el campo.
 *
 * Grupos:
 *  1 → Portero (GK)
 *  2 → Defensas (CB, LB, RB, LWB, RWB, SW)
 *  3 → Centrocampistas: CM, CDM, DM y cualquier posición de mediocampo
 *  4 → CAM / Mediapunta  (línea propia entre medios y delanteros)
 *  5 → Delanteros: ST, CF, LW, RW, LM, RM y similares
 *
 * LM/RM = extremos/bandas → grupo 5 (delanteros), igual que LW/RW
 */
const ROW_GROUP = {
    'GK':1,
    'CB':2,'LB':2,'RB':2,'DF':2,'SW':2,'LCB':2,'RCB':2,
    'CDM':3,'DM':3,'MCD':3,'PIVOT':3,'PIVOTE':3,'VOL':3,
    'CM':3,'MC':3,'MF':3,'BOX':3,
    'LWB':3,'RWB':3,
    'CAM':4,'AM':4,'MCO':4,'TREQUARTISTA':4,'MEZ':4,'MEDIAPUNTA':4,
    'ST':5,'CF':5,'LW':5,'RW':5,'FW':5,'ATT':5,'SS':5,'DC':5,
};

// LM/RM: fila 3 si no hay CAM, fila 4 si hay CAM
const WIDE_MID = new Set(['LM','RM','ML','MR']);
// LW/RW: normalmente fila 5, pero fila 4 si hay CAM y NO hay ST/CF
const WIDE_FWD = new Set(['LW','RW']);
const STRIKER_POS = new Set(['ST','CF','FW','ATT','SS','DC']);

function getRowGroup(position, hasCAM, hasStriker) {
    if (!position) return 3;
    const pos = position.toUpperCase().trim();
    if (WIDE_MID.has(pos)) return hasCAM ? 4 : 3;
    if (WIDE_FWD.has(pos)) return hasCAM ? 4 : 5;
    return ROW_GROUP[pos] ?? 3;
}

function buildPlayerCard(player, globalIndex) {
    const isRevealed = revealedPlayers.has(globalIndex);

    const playerCard = document.createElement('div');
    const pos = (player.position || '').toUpperCase().trim();
    const isGK = pos === 'GK';
    playerCard.className = 'player-card' + (isRevealed ? ' revealed' : '') + (isGK ? ' goalkeeper' : '');

    const jersey = document.createElement('div');
    jersey.className = 'jersey' + (isGK ? ' goalkeeper' : '');
    jersey.onclick = () => openGuessModal(globalIndex);
    jersey.innerHTML = buildJerseySVG(_currentKit, player.number, isGK);

    const nameContainer = document.createElement('div');
    nameContainer.className = 'player-name-container';

    if (isRevealed) {
        const revealedName = document.createElement('div');
        const knownName = getKnownName(player.name);
        const longClass = knownName.length > 10 ? ' revealed-name--long' : '';
        revealedName.className   = 'revealed-name' + (failedPlayers.has(globalIndex) ? ' failed-reveal' : '') + longClass;
        revealedName.textContent = knownName;
        nameContainer.appendChild(revealedName);
    } else {
        const displayName = getKnownName(player.name);
        for (const char of displayName) {
            const slot = document.createElement('div');
            if (char === ' ') {
                slot.className = 'name-slot space';
            } else if ("'-.·".includes(char)) {
                slot.className   = 'name-slot special-char-slot';
                slot.textContent = char;
            } else {
                slot.className = 'name-slot';
            }
            nameContainer.appendChild(slot);
        }
    }

    playerCard.appendChild(jersey);
    playerCard.appendChild(nameContainer);
    return playerCard;
}

function renderFormation() {
    ensurePitch();
    _currentKit = getKit(currentMatch && currentMatch.playingTeam);
    const formationContainer = document.getElementById('formation');
    formationContainer.innerHTML = '';
    const formation = currentMatch.formation;

    // 1. Aplanar todos los jugadores manteniendo su índice global
    const allPlayers = [];
    let globalOffset = 0;
    formation.forEach(line => {
        line.forEach((player, i) => {
            allPlayers.push({ player, globalIndex: globalOffset + i });
        });
        globalOffset += line.length;
    });

    // 2. Detectar si hay CAM y si hay delantero centro (ST/CF) en la alineación
    const hasCAM     = allPlayers.some(({ player }) => ROW_GROUP[(player.position || '').toUpperCase().trim()] === 4);
    const hasStriker = allPlayers.some(({ player }) => STRIKER_POS.has((player.position || '').toUpperCase().trim()));

    // 3. Agrupar por rowGroup manteniendo el orden original dentro de cada grupo
    const groups = new Map();
    allPlayers.forEach(({ player, globalIndex }) => {
        const group = getRowGroup(player.position, hasCAM, hasStriker);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ player, globalIndex });
    });

    // 3. Renderizar siempre los 5 slots (grupos 1-5).
    // column-reverse del contenedor invierte la visual: grupo 1 (GK) queda abajo, grupo 5 (delanteros) arriba.
    // Si un grupo no tiene jugadores se inserta un spacer invisible para mantener el campo siempre igual de alto.
    const LEFT_POS  = new Set(['LM','LW','LWB','ML']);
    const RIGHT_POS = new Set(['RM','RW','RWB','MR']);

    // Formación "de 4 líneas" real: sin CAM (grupo 4 vacío) pero con
    // mediocampo (3) y ataque (5). En este caso el mediocampo quedaba pegado
    // a la defensa y todo el hueco vacío se acumulaba entre mediocampo y
    // ataque. Lo arreglamos partiendo ese hueco en dos mitades, una antes y
    // otra después del mediocampo, para que quede situado a medio camino
    // entre donde estaría la línea 3 y la línea 4 de una alineación de 5
    // líneas — en vez de coincidir exactamente con la línea 3.
    const isFourLineFormation = !groups.has(4) && groups.has(3) && groups.has(5);

    const slots = isFourLineFormation
        ? [{ group: 1 }, { group: 2 }, { spacerHalf: true }, { group: 3 }, { spacerHalf: true }, { group: 5 }]
        : [1, 2, 3, 4, 5].map(group => ({ group }));

    slots.forEach(slot => {
        const lineDiv = document.createElement('div');

        if (slot.spacerHalf) {
            lineDiv.className = 'line line--spacer line--spacer-half';
            formationContainer.appendChild(lineDiv);
            return;
        }

        const group = slot.group;
        if (!groups.has(group)) {
            // Slot vacío: spacer que ocupa el hueco sin mostrar nada
            lineDiv.className = 'line line--spacer';
            formationContainer.appendChild(lineDiv);
            return;
        }

        lineDiv.className = 'line';
        const players = groups.get(group);

        // Ordenar: izquierdas primero, derechas al final, centro en medio
        const left   = players.filter(({ player }) => LEFT_POS.has((player.position || '').toUpperCase().trim()));
        const right  = players.filter(({ player }) => RIGHT_POS.has((player.position || '').toUpperCase().trim()));
        const center = players.filter(({ player }) => {
            const pos = (player.position || '').toUpperCase().trim();
            return !LEFT_POS.has(pos) && !RIGHT_POS.has(pos);
        });

        [...left, ...center, ...right].forEach(({ player, globalIndex }) => {
            lineDiv.appendChild(buildPlayerCard(player, globalIndex));
        });
        formationContainer.appendChild(lineDiv);
    });
}

// =============================================
// MODAL ADIVINANZA
// =============================================

function openGuessModal(playerIndex) {
    if (revealedPlayers.has(playerIndex) && !failedPlayers.has(playerIndex)) return;
    if (currentMode === 'diario') {
        const saved = loadDailyResult(dailyOffset);
        // Solo bloquea si el día ya está TERMINADO — una partida a medias
        // (completed:false) tiene que poder seguir jugándose.
        if (saved && saved.completed !== false) return;
    }

    currentPlayerIndex = playerIndex;
    currentGuess       = [];
    guessLocked        = false;
    const isReadOnly   = failedPlayers.has(playerIndex);

    if (!playerAttempts[playerIndex])     playerAttempts[playerIndex] = 0;
    if (!playerGuessHistory[playerIndex]) playerGuessHistory[playerIndex] = [];

    const player    = getPlayerByIndex(playerIndex);
    const cleanName = getKnownName(player.name).toUpperCase();

    const guessGrid = document.getElementById('guess-grid');
    guessGrid.innerHTML = '';

    for (let i = 0; i < 6; i++) {
        const row = document.createElement('div');
        row.className = 'guess-row';
        let cellIndex = 0;
        for (let j = 0; j < cleanName.length; j++) {
            const char = cleanName[j];
            const cell = document.createElement('div');
            if (char === ' ') {
                cell.className = 'wordle-space';
            } else if ("'-.·".includes(char)) {
                cell.className   = 'letter-cell special-char-cell';
                cell.textContent = char;
                cell.id          = `cell-${i}-${j}-special`;
            } else {
                cell.className = 'letter-cell';
                cell.id        = `cell-${i}-${cellIndex}`;
                cellIndex++;
            }
            row.appendChild(cell);
        }
        guessGrid.appendChild(row);
    }

    const history = playerGuessHistory[playerIndex];
    for (let i = 0; i < history.length; i++) {
        const attempt = history[i];
        let letterIndex = 0;
        for (let j = 0; j < cleanName.length; j++) {
            const char = cleanName[j];
            if (' \'-.·'.includes(char)) continue;
            const cell = document.getElementById(`cell-${i}-${letterIndex}`);
            if (cell && letterIndex < attempt.guess.length) {
                cell.textContent = attempt.guess[letterIndex];
                cell.classList.add(attempt.status[letterIndex], 'flip');
            }
            letterIndex++;
        }
    }

    resetKeyboard();
    currentRow = history.length;
    for (const attempt of history) updateKeyboard(attempt.guess.split(''), attempt.status);

    document.getElementById('guess-modal').classList.add('active');

    if (isReadOnly) {
        document.getElementById('guess-modal').classList.add('read-only');
        document.querySelectorAll('.key').forEach(k => { k.disabled = true; k.style.opacity = '0.5'; k.style.cursor = 'not-allowed'; });
        document.getElementById('reveal-btn-modal').style.display = 'none';
        document.querySelector('.modal-title').textContent = 'INTENTOS REALIZADOS';
    } else {
        document.getElementById('guess-modal').classList.remove('read-only');
        document.querySelectorAll('.key').forEach(k => { k.disabled = false; k.style.opacity = '1'; k.style.cursor = 'pointer'; });
        document.getElementById('reveal-btn-modal').style.display = 'block';
        document.querySelector('.modal-title').textContent = 'ADIVINA EL JUGADOR';
    }
}

// =============================================
// GOLEADORES BAJO EL MARCADOR
// =============================================

/**
 * Pinta los goles del partido debajo del marcador: minuto siempre, y el nombre
 * solo si NO hay que adivinarlo o si ya se ha acertado.
 *
 * La regla no es "los goles del rival se ven": es "se tapa el nombre si el que
 * marcó es TITULAR del equipo que hay que adivinar". La diferencia está en los
 * goles en propia puerta, que cuentan para el rival pero los marca un jugador
 * del equipo que estás adivinando: enseñarlos sería cantar un nombre del once.
 * Un gol de un suplente sí se ve, porque no está en el once y no se puede
 * acertar nunca.
 *
 * Los partidos curados antes de esto no traen `goals` y simplemente no pintan
 * nada.
 */
function renderGoals() {
    const box = document.getElementById('match-goals');
    if (!box) return;
    const goals = (currentMatch && currentMatch.goals) || [];
    if (!goals.length) { box.innerHTML = ''; return; }

    const lados = { home: [], away: [] };
    goals.forEach(g => {
        const lado = g.side === 'away' ? 'away' : 'home';
        lados[lado].push(golHTML(g));
    });

    box.innerHTML =
        `<div class="mg-side mg-side--home">${lados.home.join('')}</div>` +
        `<div class="mg-side mg-side--away">${lados.away.join('')}</div>`;
}

function golHTML(g) {
    const tapado  = (g.xi !== undefined && g.xi !== null);
    const visto   = !tapado || revealedPlayers.has(g.xi);
    // Si está en el once, el nombre bueno es el del once (por si se corrigió a
    // mano en la herramienta después de sacar los goles).
    const enOnce  = tapado ? getPlayerByIndex(g.xi) : null;
    const nombre  = (enOnce && enOnce.name) || g.name || '';
    const minuto  = `${g.minute}${g.added ? '+' + g.added : ''}'`;
    const marcas  = [g.pen ? 'p' : '', g.own ? 'p.p.' : ''].filter(Boolean).join(' ');
    const tag     = marcas ? ` <span class="mg-tag">(${escapeHtml(marcas)})</span>` : '';
    const quien   = visto
        ? `<span class="mg-name">${escapeHtml(nombre)}</span>`
        : `<span class="mg-hidden" aria-label="goleador por descubrir">•••</span>`;
    return `<div class="mg-goal${visto && tapado ? ' mg-goal--revealed' : ''}">`
         + `${quien} <span class="mg-min">${escapeHtml(minuto)}</span>${tag}</div>`;
}

function escapeHtml(t) {
    return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPlayerByIndex(index) {
    let count = 0;
    for (const line of currentMatch.formation) {
        for (const player of line) {
            if (count === index) return player;
            count++;
        }
    }
    return null;
}

// =============================================
// WORDLE
// =============================================

let currentRow = 0;

// Nota: se llama onceNormalizeText (no normalizeText) para no pisar la
// funci\u00f3n global normalizeText(text) de shared.js \u2014 esta p\u00e1gina carga ambos
// scripts y, al declarar las dos una funci\u00f3n global con el mismo nombre, la
// de shared.js quedaba inalcanzable (c\u00f3digo muerto) en esta p\u00e1gina.
function onceNormalizeText(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function removeAbbreviations(name) {
    return name.replace(/\b[A-Z]{1,2}\.\s+/g, '').trim();
}

function removeSpecialChars(name) {
    return name.replace(/[\s'\-·.]/g, '');
}

function getKnownName(fullName) {
    let name = removeAbbreviations(fullName);

    const exceptions = {
        'JORDI ALBA': 'JORDI ALBA', 'DANI CARVAJAL': 'CARVAJAL',
        'DANI ALVES': 'ALVES', 'DANIEL ALVES': 'ALVES',
        'DANIEL CARVAJAL': 'CARVAJAL', 'DIEGO COSTA': 'DIEGO COSTA',
        'WISSAM BEN YEDDER': 'BEN YEDDER', 'MUNIR EL HADDADI': 'MUNIR',
        'MOI GOMEZ': 'MOI GOMEZ', 'CUCHO HERNANDEZ': 'CUCHO',
        'RAFA SILVA': 'RAFA', 'JOAO MARIO': 'JOAO MARIO',
        'XAVI HERNANDEZ': 'XAVI',
        'ERIC MAXIM CHOUPO-MOTING': 'CHOUPO-MOTING', 'CHOUPO-MOTING': 'CHOUPO-MOTING',
        'ALISSON BECKER': 'ALISSON',
        'ADRIAN LOPEZ': 'ADRIAN',
        'JUANFRAN TORRES': 'JUANFRAN', 'JUAN FRANCISCO TORRES': 'JUANFRAN',
        'ABDE EZZALZOULI': 'ABDE',
        'GIORGI MAMARDASHVILI': 'MAMARDASHVILI', 'MAMARDASHVILI': 'MAMARDASHVILI',
        'GIOVANNI LO CELSO': 'LO CELSO', 'LO CELSO': 'LO CELSO',
        'DAVID LUIZ': 'DAVID LUIZ', 'DAVID LUIZ MOREIRA MARINHO': 'DAVID LUIZ',
        'STEPHAN EL SHAARAWY': 'EL SHAARAWY', 'EL SHAARAWY': 'EL SHAARAWY',
        'RAUL GONZALEZ': 'RAUL', 'RAUL GONZALEZ BLANCO': 'RAUL'
    };
    const nameNorm = onceNormalizeText(name);
    if (exceptions[nameNorm]) return exceptions[nameNorm];

    const words = name.split(' ');
    if (words.length === 1) return words[0];

    const monoNames = [
        'NEYMAR','RONALDINHO','RONALDO','RIVALDO','CAFU','ROBERTO','CASEMIRO',
        'FERNANDINHO','WILLIAN','FRED','PAULINHO','HULK','OSCAR','RAMIRES',
        'LUCAS','RAFAEL','FABINHO','EDERSON','ALISSON','ADRIANO','ROBINHO',
        'KAKÁ','THIAGO','FIRMINO','RICHARLISON','RAPHINHA','RODRYGO',
        'VINÍCIUS','MILITÃO','MARQUINHOS','DANILO','FELIPE','RENAN','EMERSON',
        'ALEX','ANDERSON','PEPE'
    ];
    if (monoNames.includes(words[0])) return words[0];

    const suffixes = ['JR','JR.','SR','SR.','II','III','IV'];
    let cleanWords = [...words];
    if (suffixes.includes(cleanWords[cleanWords.length - 1])) cleanWords.pop();
    if (cleanWords.length === 1) return cleanWords[0];

    const particles = ['DE','VAN','DER','TER','VON','DA','DI','DEL','LA','LE','VAN DER','VAN DE','DOS','DAS','SAN'];
    if (cleanWords.length === 2 && particles.includes(cleanWords[0])) return cleanWords.join(' ');

    if (cleanWords.length >= 3) {
        const lastTwo = cleanWords.slice(-2).join(' ');
        for (const p of particles) { if (lastTwo.startsWith(p + ' ')) return lastTwo; }
        const lastThree = cleanWords.slice(-3).join(' ');
        for (const p of particles) { if (lastThree.includes(' ' + p + ' ')) return lastThree; }
    }

    return cleanWords[cleanWords.length - 1];
}

function handleKeyPress(key) {
    if (failedPlayers.has(currentPlayerIndex)) return;
    if (guessLocked) return;
    const player     = getPlayerByIndex(currentPlayerIndex);
    const targetName = onceNormalizeText(removeSpecialChars(getKnownName(player.name)));

    if (key === 'Enter') { if (currentGuess.length === targetName.length) checkGuess(); return; }
    if (key === 'Delete') { if (currentGuess.length > 0) { currentGuess.pop(); updateCurrentRow(); } return; }
    if (currentGuess.length < targetName.length) { currentGuess.push(key); updateCurrentRow(); }
}

function updateCurrentRow() {
    const player       = getPlayerByIndex(currentPlayerIndex);
    const targetLength = onceNormalizeText(removeSpecialChars(getKnownName(player.name))).length;
    for (let i = 0; i < targetLength; i++) {
        const cell = document.getElementById(`cell-${currentRow}-${i}`);
        if (cell) {
            cell.textContent = currentGuess[i] || '';
            if (!cell.classList.contains('correct') && !cell.classList.contains('present') &&
                !cell.classList.contains('absent') && !cell.classList.contains('flip')) {
                cell.className = 'letter-cell';
            }
        }
    }
}

function checkGuess() {
    const player     = getPlayerByIndex(currentPlayerIndex);
    const targetName = onceNormalizeText(removeSpecialChars(getKnownName(player.name)));
    const guessWord  = currentGuess.join('');

    if (guessWord === targetName) {
        // Evita que un segundo Enter durante la animación (currentGuess sigue
        // lleno hasta que se cierra el modal) vuelva a ejecutar esta rama y
        // duplique el punto/historial.
        guessLocked = true;
        if (!playerGuessHistory[currentPlayerIndex]) playerGuessHistory[currentPlayerIndex] = [];
        playerGuessHistory[currentPlayerIndex].push({
            guess: guessWord, status: new Array(targetName.length).fill('correct')
        });
        animateCorrectGuess();
        setTimeout(() => { revealPlayer(currentPlayerIndex); closeGuessModal(); updateOnceStats('correct'); }, 1500);
        return;
    }

    const targetArray  = targetName.split('');
    const guessArray   = guessWord.split('');
    const letterStatus = new Array(targetName.length).fill('absent');
    const used         = new Set();

    for (let i = 0; i < guessArray.length; i++) {
        if (guessArray[i] === targetArray[i]) { letterStatus[i] = 'correct'; used.add(i); }
    }
    for (let i = 0; i < guessArray.length; i++) {
        if (letterStatus[i] === 'correct') continue;
        for (let j = 0; j < targetArray.length; j++) {
            if (used.has(j)) continue;
            if (guessArray[i] === targetArray[j]) { letterStatus[i] = 'present'; used.add(j); break; }
        }
    }

    for (let i = 0; i < guessArray.length; i++) {
        const cell = document.getElementById(`cell-${currentRow}-${i}`);
        setTimeout(() => { cell.classList.add('flip', letterStatus[i]); }, i * 100);
    }
    setTimeout(() => updateKeyboard(guessArray, letterStatus), guessArray.length * 100);

    if (!playerGuessHistory[currentPlayerIndex]) playerGuessHistory[currentPlayerIndex] = [];
    playerGuessHistory[currentPlayerIndex].push({ guess: guessWord, status: letterStatus });

    currentRow++;
    currentGuess = [];
    if (!playerAttempts[currentPlayerIndex]) playerAttempts[currentPlayerIndex] = 0;
    playerAttempts[currentPlayerIndex]++;

    if (currentRow >= 6) {
        guessLocked = true;
        setTimeout(() => { revealPlayer(currentPlayerIndex, true); closeGuessModal(); updateOnceStats('failed'); }, 1000);
    }
}

function animateCorrectGuess() {
    const player       = getPlayerByIndex(currentPlayerIndex);
    const targetLength = onceNormalizeText(removeSpecialChars(getKnownName(player.name))).length;
    for (let i = 0; i < targetLength; i++) {
        const cell = document.getElementById(`cell-${currentRow}-${i}`);
        setTimeout(() => cell.classList.add('flip', 'correct'), i * 100);
    }
}

function updateKeyboard(guessArray, letterStatus) {
    for (let i = 0; i < guessArray.length; i++) {
        const key = document.querySelector(`[data-key="${guessArray[i]}"]`);
        if (!key) continue;
        const s = letterStatus[i];
        if (s === 'correct') { key.classList.remove('present','absent'); key.classList.add('correct'); }
        else if (s === 'present' && !key.classList.contains('correct')) { key.classList.remove('absent'); key.classList.add('present'); }
        else if (s === 'absent' && !key.classList.contains('correct') && !key.classList.contains('present')) { key.classList.add('absent'); }
    }
}

function resetKeyboard() {
    document.querySelectorAll('.key').forEach(k => k.classList.remove('correct','present','absent'));
    currentRow = 0;
}

// =============================================
// REVELAR
// =============================================

function revealPlayer(playerIndex, isFailed = false) {
    revealedPlayers.add(playerIndex);
    if (isFailed) { failedPlayers.add(playerIndex); }
    else { delete playerGuessHistory[playerIndex]; delete playerAttempts[playerIndex]; }
    renderFormation();
    renderGoals();      // si ese jugador marcó, su nombre ya se puede enseñar
    updateRevealedCount();
    // Si esto completa el partido, updateRevealedCount ya dispara
    // showCompletionModal (con completed:true) 600ms después, que pisa este
    // guardado a medias con el resultado final.
    saveDailyProgress();
}

function revealPlayerFromModal() {
    if (currentPlayerIndex !== null) {
        revealPlayer(currentPlayerIndex);
        closeGuessModal();
        updateOnceStats('voluntary');
    }
}

function updateRevealedCount() {
    const total = currentMatch.formation.reduce((s, l) => s + l.length, 0);
    document.getElementById('revealed-count').textContent = revealedPlayers.size;
    if (revealedPlayers.size === total) setTimeout(() => showCompletionModal(), 600);
}

// =============================================
// MODAL COMPLETADO
// =============================================

let dailyCountdownInterval = null;

/**
 * Calcula el tiempo hasta las 00:00 hora española del día siguiente.
 * Usamos la diferencia entre el timestamp actual y el próximo medianoche en Europe/Madrid.
 */
function getTimeUntilNextDaily() {
    const now = new Date();

    // Construir "mañana a las 00:00 en Madrid" como timestamp UTC
    // Primero obtenemos la fecha de mañana en hora española
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowParts = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(tomorrow);
    const getP = type => parseInt(tomorrowParts.find(p => p.type === type).value, 10);
    const tY = getP('year'), tM = getP('month'), tD = getP('day');

    // Convertir "tY-tM-tD 00:00:00 Madrid" a UTC usando Date.parse con offset aproximado
    // La forma más correcta es usar un formatter para encontrar el offset
    const midnightMadridStr = `${tY}-${String(tM).padStart(2,'0')}-${String(tD).padStart(2,'0')}T00:00:00`;
    // Creamos la fecha como si fuera UTC y luego ajustamos con el offset de Madrid
    const madridOffset = (() => {
        const testDate = new Date(midnightMadridStr + 'Z');
        const localStr = testDate.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour12: false,
            year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' });
        // Extraer la hora de Madrid para el timestamp UTC testDate
        const h = parseInt(localStr.slice(12,14), 10);
        // Si en UTC las 00:00 son las h en Madrid, el offset Madrid→UTC es -h horas
        return h; // horas que hay que restar en UTC para que en Madrid sea medianoche
    })();

    // Construir el timestamp de la próxima medianoche Madrid en UTC
    const nextMidnightUTC = new Date(midnightMadridStr + 'Z');
    nextMidnightUTC.setUTCHours(nextMidnightUTC.getUTCHours() - madridOffset);

    const diff = nextMidnightUTC - now;
    if (diff <= 0) return '00:00:00';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function startDailyCountdown() {
    const el = document.getElementById('comp-countdown');
    if (!el) return;
    el.style.display = 'block';
    el.textContent   = `⏱ Nuevo once en ${getTimeUntilNextDaily()}`;
    if (dailyCountdownInterval) clearInterval(dailyCountdownInterval);
    dailyCountdownInterval = setInterval(() => {
        el.textContent = `⏱ Nuevo once en ${getTimeUntilNextDaily()}`;
    }, 1000);
}

function showCompletionModal() {
    document.getElementById('completion-match').textContent =
        `${currentMatch.homeTeam} ${currentMatch.score} ${currentMatch.awayTeam} • ${currentMatch.date}`;
    document.getElementById('comp-guessed').textContent  = matchStats.guessed;
    document.getElementById('comp-failed').textContent   = matchStats.failed;
    document.getElementById('comp-revealed').textContent = matchStats.revealed;

    const streakEl = document.getElementById('comp-streak');
    if (stats.currentStreak >= 3 && (currentMode !== 'diario' || dailyOffset === 0)) {
        streakEl.textContent = `🔥 Racha de aciertos: ${stats.currentStreak}`; streakEl.style.display = 'block';
    } else { streakEl.style.display = 'none'; }

    document.querySelector('.completion-title').textContent =
        matchStats.guessed === 11 ? '🏆 ¡ONCE PERFECTO!' : '✅ ALINEACIÓN COMPLETADA';

    const nextBtn = document.querySelector('.completion-buttons .next-btn');
    if (nextBtn) nextBtn.style.display = currentMode === 'diario' ? 'none' : 'block';

    const countdownEl = document.getElementById('comp-countdown');
    if (currentMode === 'diario' && dailyOffset === 0) {
        startDailyCountdown();
        saveDailyResult(0, {
            revealedPlayers: Array.from(revealedPlayers),
            failedPlayers:   Array.from(failedPlayers),
            matchStats:      { ...matchStats },
            completed:       true
        });
    } else if (currentMode === 'diario' && dailyOffset > 0) {
        // Guardar el resultado del día anterior también (para no perder el progreso)
        saveDailyResult(dailyOffset, {
            revealedPlayers: Array.from(revealedPlayers),
            failedPlayers:   Array.from(failedPlayers),
            matchStats:      { ...matchStats },
            completed:       true
        });
        if (countdownEl) countdownEl.style.display = 'none';
        if (dailyCountdownInterval) clearInterval(dailyCountdownInterval);
    } else {
        if (countdownEl) countdownEl.style.display = 'none';
        if (dailyCountdownInterval) clearInterval(dailyCountdownInterval);
    }

    document.getElementById('completion-modal').classList.add('active');
    stats.matchesCompleted++;
    saveStats();
}

// =============================================
// COMPARTIR RESULTADO (estilo Wordle)
// =============================================

function onceShare() {
    if (!currentMatch) return;
    const g = matchStats.guessed  || 0;
    const f = matchStats.failed   || 0;
    const r = matchStats.revealed || 0;
    const rest = Math.max(0, 11 - g - f - r);
    const squares = '🟩'.repeat(g) + '🟨'.repeat(f) + '⬛'.repeat(r + rest);
    const dateLabel = (currentMode === 'diario') ? ` · ${getDailyDateLabel(dailyOffset)}` : '';
    const url = window.location.origin + window.location.pathname;
    const text =
        `En el Once ⚽${dateLabel}\n` +
        `${currentMatch.homeTeam} ${currentMatch.score} ${currentMatch.awayTeam}\n` +
        `🎯 ${g}/11\n${squares}\n${url}`;
    onceShareWithImage(text);
}

/** Intenta compartir una IMAGEN con los escudos del partido; si no se puede
 *  (navegador sin compartir-archivos, escudos no disponibles o canvas
 *  "tainted" por CORS), cae al compartir de texto de siempre. */
async function onceShareWithImage(text) {
    const btn = document.getElementById('once-share-btn');
    let file = null;
    try { file = await buildOnceShareImage(); } catch (e) { file = null; }

    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], text });
            return;
        } catch (e) {
            if (e && e.name === 'AbortError') return;   // el usuario canceló
        }
    }
    onceDoShare(text, btn);
}

function _crestFor(team, badge) {
    return isCrestUrl(badge) ? badge.trim() : getCrest(team);
}

function _loadCrossImg(src) {
    return new Promise((resolve, reject) => {
        if (!src) { reject(new Error('sin escudo')); return; }
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('no carga'));
        im.src = src;
    });
}

/** Dibuja una tarjeta 1080×566 (ratio social) con escudos, equipos, resultado
 *  y marca. Devuelve un File PNG o lanza si algo falla (para caer a texto). */
async function buildOnceShareImage() {
    if (!currentMatch) throw new Error('sin partido');
    const g = matchStats.guessed || 0, f = matchStats.failed || 0, r = matchStats.revealed || 0;
    const rest = Math.max(0, 11 - g - f - r);

    const homeImg = await _loadCrossImg(_crestFor(currentMatch.homeTeam, currentMatch.homeBadge));
    const awayImg = await _loadCrossImg(_crestFor(currentMatch.awayTeam, currentMatch.awayBadge));

    const W = 1080, H = 566;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');

    // Fondo
    const bg = x.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#171a21');
    bg.addColorStop(1, '#0d0f14');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(200,168,75,0.55)'; x.lineWidth = 6;
    x.strokeRect(3, 3, W - 6, H - 6);

    x.textAlign = 'center'; x.textBaseline = 'middle';

    // Cabecera
    x.fillStyle = '#c8a84b';
    x.font = '700 40px Anton, Impact, sans-serif';
    x.fillText('EN EL ONCE', W / 2, 62);
    if (currentMode === 'diario') {
        x.fillStyle = 'rgba(255,255,255,0.6)';
        x.font = '600 24px Rajdhani, Arial, sans-serif';
        x.fillText(getDailyDateLabel(dailyOffset).toUpperCase(), W / 2, 104);
    }

    // Escudos + equipos + marcador
    const cy = 240, crest = 150;
    const drawCrest = (img, cx) => {
        const ratio = img.width && img.height ? img.width / img.height : 1;
        let w = crest, h = crest;
        if (ratio > 1) h = crest / ratio; else w = crest * ratio;
        x.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    };
    drawCrest(homeImg, 250);
    drawCrest(awayImg, 830);

    x.fillStyle = '#fff';
    x.font = '700 34px Anton, Impact, sans-serif';
    x.fillText(currentMatch.score || '', W / 2, cy);

    x.font = '700 26px Rajdhani, Arial, sans-serif';
    const clip = (s) => (s || '').length > 20 ? s.slice(0, 19) + '…' : (s || '');
    x.fillText(clip(currentMatch.homeTeam).toUpperCase(), 250, cy + crest / 2 + 30);
    x.fillText(clip(currentMatch.awayTeam).toUpperCase(), 830, cy + crest / 2 + 30);

    // Resultado 11 cuadros
    const cols = ['#3ecf6b', '#e8c341', '#3a3f4b'];
    const seq = [].concat(Array(g).fill(0), Array(f).fill(1), Array(r + rest).fill(2));
    const sq = 54, gap = 8, totalW = 11 * sq + 10 * gap, sx = (W - totalW) / 2, sy = 400;
    for (let i = 0; i < 11; i++) {
        x.fillStyle = cols[seq[i] ?? 2];
        const px = sx + i * (sq + gap);
        x.beginPath();
        if (x.roundRect) x.roundRect(px, sy, sq, sq, 10); else x.rect(px, sy, sq, sq);
        x.fill();
    }

    // Marcador de aciertos + marca
    x.fillStyle = '#fff';
    x.font = '700 32px Rajdhani, Arial, sans-serif';
    x.fillText(`🎯 ${g}/11`, W / 2, 512);
    x.fillStyle = 'rgba(200,168,75,0.9)';
    x.font = '600 22px Rajdhani, Arial, sans-serif';
    x.fillText('futbolhub.es', W / 2, 545);

    const blob = await new Promise((res, rej) =>
        c.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
    return new File([blob], 'en-el-once.png', { type: 'image/png' });
}

function onceDoShare(text, btn) {
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
        } catch { /**/ }
    }
}

function closeCompletionModal() {
    document.getElementById('completion-modal').classList.remove('active');
    if (dailyCountdownInterval) { clearInterval(dailyCountdownInterval); dailyCountdownInterval = null; }
}

function closeGuessModal() {
    document.getElementById('guess-modal').classList.remove('active');
    currentPlayerIndex = null;
}

// =============================================
// NAVEGACIÓN
// =============================================

function nextMatch() {
    document.getElementById('completion-modal').classList.remove('active');
    currentMatchIndex++;
    loadMatch();
}

function giveUp() {
    if (confirm('¿Seguro que quieres revelar todos los jugadores?')) {
        const total = currentMatch.formation.reduce((s, l) => s + l.length, 0);
        let newlyRevealed = 0;
        for (let i = 0; i < total; i++) {
            if (!revealedPlayers.has(i)) { revealedPlayers.add(i); newlyRevealed++; }
        }
        matchStats.revealed += newlyRevealed;
        // Cuentan como intentos fallidos (nunca se sumaron a totalAttempts al
        // revelarse, a diferencia de los aciertos/fallos que pasan por
        // updateOnceStats) — restar aquí dejaba el contador global negativo.
        stats.totalAttempts += newlyRevealed;
        renderFormation();
        updateRevealedCount();
        stats.currentStreak = 0;
        saveStats();
    }
}

// =============================================
// ESTADÍSTICAS
// =============================================

// Nota: se llama updateOnceStats (no updateStats) para no pisar la función
// global updateStats(guessed,failed,revealed) definida en shared.js — ambos
// scripts comparten el mismo objeto global `stats`, pero con formas de
// actualizarlo distintas (por evento aquí, por partida completa en shared.js).
function updateOnceStats(mode) {
    stats.totalAttempts++;
    const isDailyToday = currentMode === 'diario' && dailyOffset === 0;
    if (mode === 'correct') {
        stats.playersGuessed++; matchStats.guessed++;
        // Solo aumentar racha en modos no-diario, o en el diario de HOY
        if (currentMode !== 'diario' || isDailyToday) {
            stats.currentStreak++;
            if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
        }
    } else if (mode === 'failed') {
        matchStats.failed++;
        if (currentMode !== 'diario' || isDailyToday) {
            stats.currentStreak = 0;
        }
    } else if (mode === 'voluntary') {
        matchStats.revealed++; stats.totalAttempts--;
    }
    saveStats();
}

// =============================================
// MOBILE
// =============================================

function isMobile() {
    return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent) || window.innerWidth <= 600;
}

function focusMobileInput() {
    const mi = document.getElementById('mobile-hidden-input');
    if (mi) mi.focus();
}

// =============================================
// EVENT LISTENERS
// =============================================

document.addEventListener('DOMContentLoaded', () => {
    const mobileInput = document.createElement('input');
    mobileInput.id = 'mobile-hidden-input';
    mobileInput.setAttribute('type', 'text');
    mobileInput.setAttribute('autocomplete', 'off');
    mobileInput.setAttribute('autocorrect', 'off');
    mobileInput.setAttribute('autocapitalize', 'characters');
    mobileInput.setAttribute('spellcheck', 'false');
    mobileInput.style.cssText = `position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:none;outline:none;background:transparent;color:transparent;font-size:16px;pointer-events:none;z-index:-1;`;
    document.body.appendChild(mobileInput);

    mobileInput.addEventListener('input', () => {
        const val = mobileInput.value;
        if (!val) return;
        for (const ch of val) { if (/^[a-zA-ZñÑ]$/.test(ch)) handleKeyPress(ch.toUpperCase()); }
        mobileInput.value = '';
    });

    mobileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')     { e.preventDefault(); handleKeyPress('Enter');  mobileInput.value = ''; }
        else if (e.key === 'Backspace') { e.preventDefault(); handleKeyPress('Delete'); mobileInput.value = ''; }
    });

    document.querySelectorAll('.key').forEach(key => {
        key.addEventListener('click', () => handleKeyPress(key.getAttribute('data-key')));
    });

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('guess-modal').classList.contains('active')) return;
        if (isMobile()) return;
        if (e.key === 'Enter') handleKeyPress('Enter');
        else if (e.key === 'Backspace') handleKeyPress('Delete');
        else if (/^[a-zA-ZñÑ]$/.test(e.key)) handleKeyPress(e.key.toUpperCase());
    });

    document.getElementById('next-match-btn').addEventListener('click', nextMatch);
    document.getElementById('give-up-btn').addEventListener('click', giveUp);
    document.getElementById('home-btn').addEventListener('click', goBackToMenu);
    document.getElementById('back-btn').addEventListener('click', closeGuessModal);
    document.getElementById('reveal-btn-modal').addEventListener('click', revealPlayerFromModal);
});

// ── INIT AL CARGAR ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Cargar kits y escudos editables desde Supabase en background
    loadKitsJson();
    loadEscudosJson();

    // Mostrar menú del once por defecto
    hideAllScreens();
    document.getElementById('once-menu').style.display = 'flex';

    /* ...salvo que la URL diga otra cosa. Nada de esto es de fiar (lo escribe
       cualquiera en la barra): el modo se comprueba contra la lista real y el
       dia contra la ventana de 30 dias que admite la navegacion diaria. */
    if (window.FHRuta) {
        const modo = FHRuta.get('modo');
        if (MODOS_URL.includes(modo)) {
            let off = 0;
            if (modo === 'diario') {
                const f = FHRuta.fecha('dia');
                const o = f ? offsetDeFecha(f) : 0;
                if (o >= 0 && o <= 30) off = o;
            }
            startGame(modo, off, true);
        } else if (modo) {
            FHRuta.borrar('modo', 'dia');   // que la URL no mienta
        }

        /* El Atras: dentro del diario recorre las ediciones; en cualquier otro
           modo (y al llegar a la URL limpia) devuelve al menu. */
        FHRuta.alVolver(() => {
            const m = FHRuta.get('modo');
            if (!MODOS_URL.includes(m)) { if (currentMode) goBackToMenu(); return; }
            if (m === 'diario' && currentMode === 'diario') {
                const f = FHRuta.fecha('dia');
                const o = f ? offsetDeFecha(f) : 0;
                if (o >= 0 && o <= 30 && o !== dailyOffset) loadDailyMatch(o, true);
                return;
            }
            if (m !== currentMode) startGame(m, 0, true);
        });
    }

    // Actualizar subtítulo del botón diario con la fecha de hoy
    const subtitleEl = document.getElementById('daily-btn-subtitle');
    if (subtitleEl) {
        const months = ['enero','febrero','marzo','abril','mayo','junio',
                        'julio','agosto','septiembre','octubre','noviembre','diciembre'];
        const { day, month } = getSpainDate(0);
        subtitleEl.textContent = `Partidos del ${day} de ${months[month - 1]} · cambia a medianoche`;
    }
});
;
