/* =============================================
   EXTENDED-DATA-LOADER.JS
   Loader para datos extendidos de jugadores

   Lee desde Supabase Storage (bucket "player-db"), subido con
   admin/upload_player_db_to_storage.py:
     - performances  → player-db/performances/chunks/ + manifest.json
     - transfers     → player-db/transfers/chunks/    + manifest.json
     - teammates     → player-db/teammates/chunks/    + manifest.json
     - national      → player-db/national/all.json      (un solo archivo)
     - teams         → player-db/teams/details.json      (un solo archivo)
     - team_names    → player-db/team-names/team-names.json (un solo archivo)

   Requiere que js/supabase-config.js esté cargado antes que este archivo.
   ============================================= */

/* ─────────────────────────────────────────────────────────────────────────
   ExtendedDB — loader genérico para datos chunkeados por rango de player_id.
   A diferencia del diseño original (rangos de 100k hardcodeados en el JS),
   los rangos se leen de un manifest.json generado en cada subida: el reparto
   de "performances" ya no son bloques limpios de 100k (se subdividió el
   0-99999 en archivos más pequeños en algún momento), así que hardcodear la
   lista se queda obsoleto en cuanto cambia el reparto de archivos.

   Uso:
     const db = new ExtendedDB('performances');
     await db.get('28003');   // → [ {s:'24/25', g:30, ...}, ... ]
     await db.getMany(['28003','8198']);
   ───────────────────────────────────────────────────────────────────────── */
class ExtendedDB {
    /** @param {string} type - 'performances' | 'transfers' | 'teammates' */
    constructor(type) {
        this.type     = type;
        this.manifest = null;   // { totalPlayers, ranges: [{min,max,file,count}] }
        this.cache    = {};     // { 'archivo.json': { playerId: [...] } }
        this._initPromise = null;
    }

    async _init() {
        if (this.manifest) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = (async () => {
            const res = await fetch(sbStorageUrl('player-db', `${this.type}/chunks/manifest.json`), { cache: 'no-cache' });
            if (!res.ok) throw new Error(`[ExtendedDB:${this.type}] HTTP ${res.status} al cargar manifest`);
            this.manifest = await res.json();
        })();

        return this._initPromise;
    }

    /** Devuelve el nombre de chunk para un player_id dado, o null */
    _chunkFor(playerId) {
        const id = parseInt(playerId);
        const range = this.manifest.ranges.find(r => id >= r.min && id <= r.max);
        return range ? range.file : null;
    }

    /** Carga un chunk (con cache en memoria) */
    async _loadChunk(chunkFile) {
        if (this.cache[chunkFile]) return this.cache[chunkFile];

        const url = sbStorageUrl('player-db', `${this.type}/chunks/${chunkFile}`);
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
        await this._init();
        const chunkFile = this._chunkFor(playerId);
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
        await this._init();

        // Agrupar IDs por chunk
        const groups = {};
        for (const id of playerIds) {
            const chunkFile = this._chunkFor(id);
            if (!chunkFile) continue;
            (groups[chunkFile] ??= []).push(id);
        }

        const result = {};
        for (const [chunkFile, ids] of Object.entries(groups)) {
            const chunk = await this._loadChunk(chunkFile);
            for (const id of ids) result[String(id)] = chunk[String(id)] ?? null;
        }
        for (const id of playerIds) {
            if (!(String(id) in result)) result[String(id)] = null;
        }
        return result;
    }

    /** Se mantiene por compatibilidad, ya no hace falta (no hay cache de chunks pre-Supabase). */
    clearCache() { this.cache = {}; }
}

/* -----------------------------------------------------------------------
   NationalDB -- selecciones nacionales. Archivo pequeño (~5.000 filas):
   se carga entero una vez en memoria para que .get() siga siendo síncrono
   como antes (los juegos ya hacen NationalDB.get(id) sin await).
   ----------------------------------------------------------------------- */
const NationalDB = {
    data: null,

    async init() {
        if (this.data) return;
        const res = await fetch(sbStorageUrl('player-db', 'national/all.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`[NationalDB] HTTP ${res.status}`);
        this.data = await res.json();
        console.log(`NationalDB cargado: ${Object.keys(this.data).length.toLocaleString()} jugadores`);
    },

    /** @returns {Array|null} */
    get(playerId) {
        if (!this.data) throw new Error("[NationalDB] No inicializado. Llama a NationalDB.init() primero.");
        return this.data[String(playerId)] ?? null;
    },
};

/* -----------------------------------------------------------------------
   TeamsDB -- info de equipos. Archivo pequeño (~2.200 filas), misma lógica
   que NationalDB: se carga entero para mantener .get()/.search() síncronos.
   ----------------------------------------------------------------------- */
const TeamsDB = {
    data: null,

    async init() {
        if (this.data) return;
        const res = await fetch(sbStorageUrl('player-db', 'teams/details.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`[TeamsDB] HTTP ${res.status}`);
        this.data = await res.json();
        console.log(`TeamsDB cargado: ${Object.keys(this.data).length.toLocaleString()} equipos`);
    },

    /** @returns {Object|null} */
    get(teamId) {
        if (!this.data) throw new Error("[TeamsDB] No inicializado. Llama a TeamsDB.init() primero.");
        return this.data[String(teamId)] ?? null;
    },

    /** Busca equipos por nombre (parcial, insensible a mayúsculas/acentos) */
    search(term) {
        if (!this.data) throw new Error("[TeamsDB] No inicializado.");
        const DIACRITICS_RE = new RegExp("[" + String.fromCharCode(0x0300) + "-" + String.fromCharCode(0x036f) + "]", "g");
        const stripAccents = s => s.normalize("NFD").replace(DIACRITICS_RE, "");
        const t = stripAccents(term.toLowerCase());
        return Object.entries(this.data)
            .filter(([, v]) => stripAccents(v.n.toLowerCase()).includes(t))
            .map(([id, v]) => ({ id, ...v }));
    },
};

/* -----------------------------------------------------------------------
   TeamNamesDB -- lista plana de nombres de equipo.
   ----------------------------------------------------------------------- */
const TeamNamesDB = {
    names: null,

    async init() {
        if (this.names) return;
        const res = await fetch(sbStorageUrl('player-db', 'team-names/team-names.json'), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`[TeamNamesDB] HTTP ${res.status}`);
        this.names = await res.json();
        console.log(`TeamNamesDB cargado: ${this.names.length.toLocaleString()} nombres de equipo`);
    },

    /** @returns {Array<string>} */
    getAll() {
        if (!this.names) throw new Error("[TeamNamesDB] No inicializado. Llama a TeamNamesDB.init() primero.");
        return this.names;
    },
};

/* -----------------------------------------------------------------------
   Instancias pre-configuradas (listas para usar)
   ----------------------------------------------------------------------- */
const PerformancesDB = new ExtendedDB("performances");
const TransfersDB    = new ExtendedDB("transfers");
const TeammatesDB    = new ExtendedDB("teammates");

// Exportar para entornos Node.js (tests, scripts de build)
if (typeof module !== "undefined" && module.exports) {
    module.exports = { ExtendedDB, NationalDB, TeamsDB, TeamNamesDB, PerformancesDB, TransfersDB, TeammatesDB };
}
