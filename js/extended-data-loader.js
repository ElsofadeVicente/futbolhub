/* =============================================
   EXTENDED-DATA-LOADER.JS
   Loader para datos extendidos de jugadores
   QUIÉN COÑO FALTA

   Tipos disponibles:
     - performances  → data/performances/chunks/
     - transfers     → data/transfers/chunks/
     - teammates     → data/teammates/chunks/
     - national      → data/national/all.json  (un solo archivo)
     - teams         → data/teams/details.json  (un solo archivo)
   ============================================= */

/**
 * Rangos de chunks — mismos que los chunks de jugadores.
 * Cada entrada: [min, max, filename]
 */
const CHUNK_RANGES = [
    [0,       99999,   '0-99999.json'],
    [100000,  199999,  '100000-199999.json'],
    [200000,  299999,  '200000-299999.json'],
    [300000,  399999,  '300000-399999.json'],
    [400000,  499999,  '400000-499999.json'],
    [500000,  599999,  '500000-599999.json'],
    [600000,  699999,  '600000-699999.json'],
    [700000,  799999,  '700000-799999.json'],
    [800000,  899999,  '800000-899999.json'],
    [900000,  999999,  '900000-999999.json'],
    [1000000, 1099999, '1000000-1099999.json'],
    [1100000, 1199999, '1100000-1199999.json'],
    [1200000, 1299999, '1200000-1299999.json'],
    [1300000, 1399999, '1300000-1399999.json'],
    [1400000, 1499999, '1400000-1499999.json'],
];

/** Devuelve el nombre de chunk para un player_id dado */
function _chunkFor(playerId) {
    const id = parseInt(playerId);
    const range = CHUNK_RANGES.find(([lo, hi]) => id >= lo && id <= hi);
    return range ? range[2] : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   ExtendedDB — loader genérico para datos chunkeados
   Uso:
     const db = new ExtendedDB('performances');  // o 'transfers' / 'teammates'
     await db.get('28003');   // → [ {s:'24/25', g:30, ...}, ... ]
     await db.getMany(['28003','8198']);
   ───────────────────────────────────────────────────────────────────────── */
class ExtendedDB {
    /**
     * @param {string} type  - 'performances' | 'transfers' | 'teammates'
     * @param {string} [basePath] - ruta base relativa al HTML que lo usa
     */
    constructor(type, basePath = '../data/') {
        this.type     = type;
        this.basePath = basePath;
        this.cache    = {};   // { 'chunkFile': { playerId: [...] } }
    }

    /** Ruta completa al directorio de chunks de este tipo */
    get _dir() {
        return `${this.basePath}${this.type}/chunks/`;
    }

    /** Carga un chunk (con cache en memoria) */
    async _loadChunk(chunkFile) {
        if (this.cache[chunkFile]) return this.cache[chunkFile];

        const url = `${this._dir}${chunkFile}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[ExtendedDB:${this.type}] HTTP ${res.status} → ${url}`);

        const data = await res.json();
        this.cache[chunkFile] = data;
        console.log(`✅ [${this.type}] chunk cargado: ${chunkFile} (${Object.keys(data).length} entradas)`);
        return data;
    }

    /**
     * Obtiene los datos de un jugador.
     * @param {string|number} playerId
     * @returns {Array|null} Array de registros o null si no existe
     */
    async get(playerId) {
        const chunkFile = _chunkFor(playerId);
        if (!chunkFile) return null;

        const chunk = await this._loadChunk(chunkFile);
        return chunk[String(playerId)] ?? null;
    }

    /**
     * Obtiene datos de múltiples jugadores (agrupa por chunk para minimizar requests).
     * @param {Array<string|number>} playerIds
     * @returns {Object} { playerId: data | null }
     */
    async getMany(playerIds) {
        // Agrupar IDs por chunk
        const groups = {};
        for (const pid of playerIds) {
            const cf = _chunkFor(pid);
            if (cf) {
                if (!groups[cf]) groups[cf] = [];
                groups[cf].push(String(pid));
            }
        }

        // Cargar todos los chunks necesarios en paralelo
        await Promise.all(Object.keys(groups).map(cf => this._loadChunk(cf)));

        // Construir resultado
        const result = {};
        for (const pid of playerIds) {
            const cf = _chunkFor(pid);
            result[String(pid)] = cf && this.cache[cf]
                ? (this.cache[cf][String(pid)] ?? null)
                : null;
        }
        return result;
    }

    /** Libera la cache de este loader */
    clearCache() {
        this.cache = {};
    }
}

/* ─────────────────────────────────────────────────────────────────────────
   NationalDB — carga datos de selecciones nacionales (un solo archivo)
   Uso:
     await NationalDB.init('../data/');
     NationalDB.get('28003');  // → [ {tid:3224, m:180, g:106, ...}, ... ]
   ───────────────────────────────────────────────────────────────────────── */
const NationalDB = {
    data: null,

    async init(basePath = '../data/') {
        if (this.data) return;
        const res = await fetch(`${basePath}national/all.json`);
        if (!res.ok) throw new Error(`[NationalDB] HTTP ${res.status}`);
        this.data = await res.json();
        console.log(`✅ NationalDB cargado: ${Object.keys(this.data).length.toLocaleString()} jugadores`);
    },

    /** @returns {Array|null} */
    get(playerId) {
        if (!this.data) throw new Error('[NationalDB] No inicializado. Llama a NationalDB.init() primero.');
        return this.data[String(playerId)] ?? null;
    }
};

/* ─────────────────────────────────────────────────────────────────────────
   TeamsDB — carga info de equipos (un solo archivo, ~600 KB)
   Uso:
     await TeamsDB.init('../data/');
     TeamsDB.get('131');  // → { n:'Barcelona', logo:'...', ctry:'Spain', seasons:[...] }
   ───────────────────────────────────────────────────────────────────────── */
const TeamsDB = {
    data: null,

    async init(basePath = '../data/') {
        if (this.data) return;
        const res = await fetch(`${basePath}teams/details.json`);
        if (!res.ok) throw new Error(`[TeamsDB] HTTP ${res.status}`);
        this.data = await res.json();
        console.log(`✅ TeamsDB cargado: ${Object.keys(this.data).length.toLocaleString()} equipos`);
    },

    /** @returns {Object|null} */
    get(teamId) {
        if (!this.data) throw new Error('[TeamsDB] No inicializado. Llama a TeamsDB.init() primero.');
        return this.data[String(teamId)] ?? null;
    },

    /** Busca equipos por nombre (parcial, insensible a mayúsculas/acentos) */
    search(term) {
        if (!this.data) throw new Error('[TeamsDB] No inicializado.');
        const t = term.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return Object.entries(this.data)
            .filter(([, v]) => v.n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(t))
            .map(([id, v]) => ({ id, ...v }));
    }
};

/* ─────────────────────────────────────────────────────────────────────────
   Instancias pre-configuradas (listas para usar, ajustar basePath si hace falta)
   ───────────────────────────────────────────────────────────────────────── */
const PerformancesDB = new ExtendedDB('performances');
const TransfersDB    = new ExtendedDB('transfers');
const TeammatesDB    = new ExtendedDB('teammates');

/* ─────────────────────────────────────────────────────────────────────────
   CAMPOS DE REFERENCIA
   ─────────────────────────────────────────────────────────────────────────

   PERFORMANCES — cada entrada del array:
   { s, cid, cn, tn, [tid], [app], [st], [g], [a], [yc], [rc], [min], [gc], [cs], [pg] }
     s    → temporada           ej: "24/25"
     cid  → competition_id     ej: "ES1"
     cn   → competition_name   ej: "LaLiga"
     tn   → team_name          ej: "Barcelona"
     tid  → team_id
     app  → partidos en grupo
     st   → partidos como titular (nb_on_pitch)
     g    → goles
     a    → asistencias
     yc   → tarjetas amarillas
     rc   → tarjetas rojas directas
     min  → minutos jugados
     gc   → goles encajados (porteros)
     cs   → portería a cero (porteros)
     pg   → penaltis marcados

   TRANSFERS — cada entrada:
   { s, fn, tn, type, [d], [fid], [tid], [val], [fee] }
     s    → temporada           ej: "23/24"
     fn   → equipo origen       ej: "Paris SG"
     tn   → equipo destino      ej: "Miami"
     type → tipo                ej: "Transfer" | "Loan" | "Free Transfer" | "Retired"
     d    → fecha               ej: "2023-07-15"
     fid  → from_team_id
     tid  → to_team_id
     val  → valor de mercado en ese momento (€)
     fee  → tarifa de traspaso (€)

   TEAMMATES — cada entrada (top 50 por joint_goal_participation):
   { id, n, [ppg], [jgp] }
     id   → player_id del compañero
     n    → nombre del compañero
     ppg  → puntos por partido jugando juntos
     jgp  → participaciones en gol conjuntas

   NATIONAL — cada entrada:
   { tid, [m], [g], [shirt], [debut], state }
     tid   → team_id de la selección
     m     → partidos
     g     → goles
     shirt → número de camiseta
     debut → fecha debut
     state → "ACTIVE_NATIONAL_PLAYER" | "FORMER_NATIONAL_PLAYER"

   TEAMS — datos de equipo:
   { n, slug, logo, ctry, seasons: [{y, cid, cn}] }
     n       → nombre del club
     slug    → slug para URL de Transfermarkt
     logo    → URL del escudo
     ctry    → país
     seasons → temporadas y competiciones

   PLAYERS (chunks existentes, campo mv añadido):
   { n, p, nat, b, club, city, pf, teams, apps, goals, [mv], [tr], [nt] }
     mv → valor de mercado actual (€) — NUEVO CAMPO
   ───────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────
   EJEMPLO DE USO EN UN JUEGO
   ─────────────────────────────────────────────────────────────────────────

// 0. Ajustar basePath si el juego está en una subcarpeta (ej: /en-el-once/)
PerformancesDB.basePath = '../data/';
TransfersDB.basePath    = '../data/';
TeammatesDB.basePath    = '../data/';

// 1. Obtener todas las temporadas de Messi
const messiPerfs = await PerformancesDB.get('28003');
messiPerfs.forEach(s => console.log(`${s.s} · ${s.tn}: ${s.g ?? 0}G ${s.a ?? 0}A`));

// 2. Historial de traspasos de Messi
const messiTransfers = await TransfersDB.get('28003');
messiTransfers.forEach(t => console.log(`${t.d} · ${t.fn} → ${t.tn} (${t.type})`));

// 3. Compañeros más frecuentes de Messi
const messiMates = await TeammatesDB.get('28003');
console.log('Top compañeros:', messiMates.slice(0,5).map(m => m.n));

// 4. Selección nacional de Messi
await NationalDB.init('../data/');
const messiNat = NationalDB.get('28003');
console.log(`Partidos internacionales: ${messiNat?.[0]?.m}`);

// 5. Info de un equipo
await TeamsDB.init('../data/');
const barca = TeamsDB.get('131');
console.log(barca.n, barca.ctry, barca.logo);

// 6. Carga múltiple eficiente (mínimos fetches)
const ids = ['28003', '8198', '3366'];
const allTransfers = await TransfersDB.getMany(ids);
console.log(allTransfers['28003']?.[0]?.tn); // último equipo de Messi
   ───────────────────────────────────────────────────────────────────────── */

// Exportar para entornos Node.js (tests, scripts de build)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ExtendedDB, NationalDB, TeamsDB, PerformancesDB, TransfersDB, TeammatesDB };
}
