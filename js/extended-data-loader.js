/* =============================================
   EXTENDED-DATA-LOADER.JS
   Loader para datos extendidos de jugadores -- ahora desde Supabase

   Misma API de siempre: ExtendedDB, NationalDB, TeamsDB, TeamNamesDB.
   Requiere que js/supabase-config.js este cargado antes que este archivo.
   ============================================= */

/* -----------------------------------------------------------------------
   ExtendedDB -- loader generico para 'performances' / 'transfers' / 'teammates'
   Uso:
     const db = new ExtendedDB('performances');
     await db.get('28003');
     await db.getMany(['28003','8198']);
   ----------------------------------------------------------------------- */
class ExtendedDB {
    /** @param {string} type - 'performances' | 'transfers' | 'teammates' (= nombre de la tabla) */
    constructor(type) {
        this.type = type;
    }

    /** @returns {Array|null} */
    async get(playerId) {
        const rows = await sbFetch(`${this.type}?player_id=eq.${encodeURIComponent(playerId)}&select=data`);
        return rows.length ? rows[0].data : null;
    }

    /** @returns {Object} { playerId: data | null } */
    async getMany(playerIds) {
        const result = {};
        if (!playerIds.length) return result;
        const idsParam = playerIds.map(id => encodeURIComponent(id)).join(",");
        const rows = await sbFetch(`${this.type}?player_id=in.(${idsParam})&select=player_id,data`);
        const byId = {};
        for (const r of rows) byId[String(r.player_id)] = r.data;
        for (const pid of playerIds) result[String(pid)] = byId[String(pid)] ?? null;
        return result;
    }

    /** Se mantiene por compatibilidad, ya no hace falta (no hay cache de chunks). */
    clearCache() {}
}

/* -----------------------------------------------------------------------
   NationalDB -- selecciones nacionales. Tabla pequena (~5.000 filas):
   se carga entera una vez en memoria para que .get() siga siendo sincrono
   como antes (los juegos ya hacen NationalDB.get(id) sin await).
   ----------------------------------------------------------------------- */
const NationalDB = {
    data: null,

    async init() {
        if (this.data) return;
        const rows = await sbFetchAll("national_team_records?select=player_id,data");
        this.data = {};
        for (const r of rows) this.data[String(r.player_id)] = r.data;
        console.log(`NationalDB cargado: ${Object.keys(this.data).length.toLocaleString()} jugadores`);
    },

    /** @returns {Array|null} */
    get(playerId) {
        if (!this.data) throw new Error("[NationalDB] No inicializado. Llama a NationalDB.init() primero.");
        return this.data[String(playerId)] ?? null;
    },
};

/* -----------------------------------------------------------------------
   TeamsDB -- info de equipos. Tabla pequena (~2.200 filas), misma logica
   que NationalDB: se carga entera para mantener .get()/.search() sincronos.
   ----------------------------------------------------------------------- */
const TeamsDB = {
    data: null,

    async init() {
        if (this.data) return;
        const rows = await sbFetchAll("teams?select=id,data");
        this.data = {};
        for (const r of rows) this.data[String(r.id)] = r.data;
        console.log(`TeamsDB cargado: ${Object.keys(this.data).length.toLocaleString()} equipos`);
    },

    /** @returns {Object|null} */
    get(teamId) {
        if (!this.data) throw new Error("[TeamsDB] No inicializado. Llama a TeamsDB.init() primero.");
        return this.data[String(teamId)] ?? null;
    },

    /** Busca equipos por nombre (parcial, insensible a mayusculas/acentos) */
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
   TeamNamesDB -- lista plana de nombres de equipo (sustituye a
   data/teams/team-names.json). Ojo: NO es lo mismo que TeamsDB.
   ----------------------------------------------------------------------- */
const TeamNamesDB = {
    names: null,

    async init() {
        if (this.names) return;
        const rows = await sbFetchAll("team_names_index?select=name");
        this.names = rows.map(r => r.name);
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
