/* =============================================
   PLAYER-DATA-LOADER.JS
   Sistema de carga de jugadores — ahora desde Supabase
   QUIÉN COÑO FALTA

   Misma API de siempre (PlayerDB.init/getPlayer/getPlayers/searchByName/...),
   pero por debajo consulta la tabla "players" de Supabase en vez de los
   archivos data/players/chunks/*.json. Los juegos que ya usaban PlayerDB
   no necesitan cambiar nada de su código.

   Requiere que js/supabase-config.js esté cargado antes que este archivo.

   Uso (igual que antes):
   *   await PlayerDB.init();
   *   const player = await PlayerDB.getPlayer('28003');
   *   console.log(player.n); // "Lionel Messi"
   ============================================= */

const PlayerDB = {
    initialized: false,

    /** Ya no hace falta cargar metadata de chunks: solo marca listo. */
    async init() {
        this.initialized = true;
    },

    /**
     * Obtiene un jugador por su ID.
     * @param {string|number} playerId
     * @returns {object|null}
     */
    async getPlayer(playerId) {
        if (!this.initialized) await this.init();
        const rows = await sbFetch(`players?id=eq.${encodeURIComponent(playerId)}&select=data`);
        return rows.length ? rows[0].data : null;
    },

    /**
     * Obtiene varios jugadores a la vez (una sola petición).
     * @param {Array<string|number>} playerIds
     * @returns {Array<object|null>} en el mismo orden que playerIds
     */
    async getPlayers(playerIds) {
        if (!this.initialized) await this.init();
        if (!playerIds.length) return [];
        const idsParam = playerIds.map(id => encodeURIComponent(id)).join(",");
        const rows = await sbFetch(`players?id=in.(${idsParam})&select=id,data`);
        const byId = {};
        for (const r of rows) byId[String(r.id)] = r.data;
        return playerIds.map(id => byId[String(id)] ?? null);
    },

    /**
     * Busca jugadores por nombre (insensible a mayúsculas/acentos básicos).
     * @param {string} searchTerm
     * @param {number} maxResults
     * @returns {Array<object>} cada resultado incluye "id" además de los campos del jugador
     */
    async searchByName(searchTerm, maxResults = 10) {
        if (!this.initialized) await this.init();
        const term = encodeURIComponent(`*${searchTerm}*`);
        const rows = await sbFetch(`players?data->>n=ilike.${term}&select=id,data&limit=${maxResults}`);
        return rows.map(r => ({ id: String(r.id), ...r.data }));
    },

    // ── Compatibilidad: estas funciones ya no hacen falta (no hay chunks
    // que precargar ni cache que limpiar), se dejan como no-op para que
    // el código antiguo que las llame no falle. ──
    async preloadChunks() {},
    clearCache() {},
    getCacheStats() {
        return { chunksInCache: 0, totalChunks: 0, cachePercentage: 100, totalPlayersInCache: 0, totalPlayers: null };
    },
};

// ── EXPORTAR ────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
    module.exports = PlayerDB;
}
