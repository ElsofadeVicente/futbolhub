/* =============================================
   PLAYER-DATA-LOADER.JS
   Sistema de carga modular de base de datos
   QUIÉN COÑO FALTA
   ============================================= */

/**
 * PlayerDB - Sistema de carga lazy de jugadores desde chunks
 * 
 * Ventajas:
 * - No carga los 26MB completos al inicio
 * - Carga solo los chunks necesarios
 * - Cache en memoria de chunks ya cargados
 * - Búsqueda O(1) por ID
 * 
 * Uso:
 *   await PlayerDB.init();
 *   const player = await PlayerDB.getPlayer('28003');
 *   console.log(player.n); // "Lionel Messi"
 */

const PlayerDB = {
    // Estado interno
    meta: null,           // Metadata de chunks (meta.json)
    cache: {},            // Chunks ya cargados: { "chunks/0-99999.json": {...} }
    basePath: '../data/players/',  // Ruta base (ajustar según juego)
    initialized: false,
    
    /**
     * Inicializar el sistema cargando metadata
     * DEBE llamarse antes de usar cualquier otra función
     */
    async init() {
        if (this.initialized) return;
        
        try {
            const response = await fetch(`${this.basePath}meta.json`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.meta = await response.json();
            this.initialized = true;
            console.log(`✅ PlayerDB inicializado: ${this.meta.totalPlayers.toLocaleString()} jugadores en ${this.meta.ranges.length} chunks`);
        } catch (error) {
            console.error('❌ Error al inicializar PlayerDB:', error);
            throw error;
        }
    },
    
    /**
     * Encuentra el chunk que contiene un ID específico
     * @param {string|number} playerId - ID del jugador (ej: "28003" o 28003)
     * @returns {object|null} Range object o null si no existe
     */
    findChunkForId(playerId) {
        if (!this.initialized) {
            throw new Error('PlayerDB no inicializado. Llama a PlayerDB.init() primero.');
        }
        
        const id = parseInt(playerId);
        return this.meta.ranges.find(range => id >= range.min && id <= range.max);
    },
    
    /**
     * Carga un chunk específico (si no está en cache)
     * @param {string} chunkFile - Path del chunk (ej: "chunks/0-99999.json")
     * @returns {object} Datos del chunk
     */
    async loadChunk(chunkFile) {
        // Si ya está en cache, devolverlo
        if (this.cache[chunkFile]) {
            console.log(`📦 Chunk en cache: ${chunkFile}`);
            return this.cache[chunkFile];
        }
        
        // Cargar desde servidor
        console.log(`⬇️ Cargando chunk: ${chunkFile}`);
        try {
            const response = await fetch(`${this.basePath}${chunkFile}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            
            // Guardar en cache
            this.cache[chunkFile] = data;
            console.log(`✅ Chunk cargado: ${chunkFile} (${Object.keys(data).length} jugadores)`);
            
            return data;
        } catch (error) {
            console.error(`❌ Error al cargar chunk ${chunkFile}:`, error);
            throw error;
        }
    },
    
    /**
     * Obtiene un jugador por su ID
     * @param {string|number} playerId - ID del jugador
     * @returns {object|null} Datos del jugador o null si no existe
     */
    async getPlayer(playerId) {
        if (!this.initialized) {
            await this.init();
        }
        
        // 1. Encontrar chunk que contiene este ID
        const range = this.findChunkForId(playerId);
        if (!range) {
            console.warn(`⚠️ No se encontró chunk para ID ${playerId}`);
            return null;
        }
        
        // 2. Cargar chunk (si no está en cache)
        const chunk = await this.loadChunk(range.file);
        
        // 3. Devolver jugador
        const playerIdStr = playerId.toString();
        if (!chunk[playerIdStr]) {
            console.warn(`⚠️ Jugador ${playerId} no existe en chunk ${range.file}`);
            return null;
        }
        
        return chunk[playerIdStr];
    },
    
    /**
     * Obtiene múltiples jugadores (optimizado para IDs consecutivos)
     * @param {Array<string|number>} playerIds - Array de IDs
     * @returns {Array<object>} Array de jugadores (null si no existe)
     */
    async getPlayers(playerIds) {
        if (!this.initialized) {
            await this.init();
        }
        
        // Agrupar IDs por chunk para minimizar requests
        const chunkGroups = {};
        
        for (const id of playerIds) {
            const range = this.findChunkForId(id);
            if (range) {
                if (!chunkGroups[range.file]) {
                    chunkGroups[range.file] = [];
                }
                chunkGroups[range.file].push(id.toString());
            }
        }
        
        // Cargar chunks necesarios
        const results = [];
        for (const [chunkFile, ids] of Object.entries(chunkGroups)) {
            const chunk = await this.loadChunk(chunkFile);
            for (const id of ids) {
                results.push(chunk[id] || null);
            }
        }
        
        return results;
    },
    
    /**
     * Busca jugadores por nombre (requiere cargar chunks)
     * ⚠️ LENTO - Solo para búsquedas esporádicas
     * @param {string} searchTerm - Término de búsqueda
     * @param {number} maxResults - Máximo de resultados (default: 10)
     * @returns {Array<object>} Jugadores encontrados
     */
    async searchByName(searchTerm, maxResults = 10) {
        if (!this.initialized) {
            await this.init();
        }
        
        const term = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const results = [];
        
        // Cargar chunks uno por uno hasta encontrar suficientes resultados
        for (const range of this.meta.ranges) {
            if (results.length >= maxResults) break;
            
            const chunk = await this.loadChunk(range.file);
            
            for (const [id, player] of Object.entries(chunk)) {
                if (results.length >= maxResults) break;
                
                const playerName = player.n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                if (playerName.includes(term)) {
                    results.push({ id, ...player });
                }
            }
        }
        
        return results;
    },
    
    /**
     * Pre-carga chunks específicos (para optimizar)
     * Útil si sabes que vas a necesitar varios jugadores de un rango
     * @param {Array<number>} rangeIndices - Índices de ranges a pre-cargar
     */
    async preloadChunks(rangeIndices) {
        if (!this.initialized) {
            await this.init();
        }
        
        const promises = rangeIndices.map(index => {
            const range = this.meta.ranges[index];
            return range ? this.loadChunk(range.file) : Promise.resolve();
        });
        
        await Promise.all(promises);
        console.log(`✅ Pre-carga completada: ${rangeIndices.length} chunks`);
    },
    
    /**
     * Limpia la cache (libera memoria)
     * Útil si el juego va a estar mucho tiempo abierto
     */
    clearCache() {
        this.cache = {};
        console.log('🧹 Cache limpiada');
    },
    
    /**
     * Obtiene estadísticas de uso de cache
     * @returns {object} Stats de cache
     */
    getCacheStats() {
        const chunksInCache = Object.keys(this.cache).length;
        const totalChunks = this.meta ? this.meta.ranges.length : 0;
        let totalPlayersInCache = 0;
        
        for (const chunk of Object.values(this.cache)) {
            totalPlayersInCache += Object.keys(chunk).length;
        }
        
        return {
            chunksInCache,
            totalChunks,
            cachePercentage: totalChunks > 0 ? Math.round((chunksInCache / totalChunks) * 100) : 0,
            totalPlayersInCache,
            totalPlayers: this.meta ? this.meta.totalPlayers : 0
        };
    }
};

// ── EJEMPLO DE USO ──────────────────────────

/*
// 1. Inicializar al cargar el juego
await PlayerDB.init();

// 2. Buscar un jugador por ID
const messi = await PlayerDB.getPlayer('28003');
console.log(messi.n);  // "Lionel Messi"
console.log(messi.teams);  // ["Barcelona", "PSG", ...]

// 3. Buscar múltiples jugadores (más eficiente)
const players = await PlayerDB.getPlayers(['28003', '8198', '3366']);
players.forEach(p => console.log(p ? p.n : 'No encontrado'));

// 4. Búsqueda por nombre (LENTO - usar con cuidado)
const cristianos = await PlayerDB.searchByName('cristiano', 5);
cristianos.forEach(p => console.log(`${p.n} (${p.nat})`));

// 5. Pre-cargar chunks si sabes que los necesitarás
// Útil para "¿Quién Soy?" si vas a mostrar varios jugadores
await PlayerDB.preloadChunks([0, 1, 2]); // Pre-carga primeros 3 chunks

// 6. Verificar cache
console.log(PlayerDB.getCacheStats());
// { chunksInCache: 3, totalChunks: 15, cachePercentage: 20, ... }

// 7. Limpiar cache si es necesario
PlayerDB.clearCache();
*/

// ── EXPORTAR ────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlayerDB;
}
