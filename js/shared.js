/* =============================================
   SHARED.JS — Funciones compartidas
   QUIÉN COÑO FALTA
   ============================================= */

// ── CONFIGURACIÓN ────────────────────────────

function toggleSettings() {
    document.getElementById('settings-modal').classList.toggle('active');
}

function toggleContrast() {
    document.body.classList.toggle('high-contrast');
    const toggle = document.getElementById('contrast-toggle');
    toggle.classList.toggle('active');
    localStorage.setItem('highContrast', toggle.classList.contains('active'));
}

function loadSettings() {
    if (localStorage.getItem('highContrast') === 'true') {
        document.body.classList.add('high-contrast');
        const toggle = document.getElementById('contrast-toggle');
        if (toggle) toggle.classList.add('active');
    }
}

// ── ESTADÍSTICAS GLOBALES ────────────────────

let stats = {
    matchesCompleted: 0,
    playersGuessed:   0,
    totalAttempts:    0,
    currentStreak:    0,
    bestStreak:       0
};

function loadStats() {
    const saved = localStorage.getItem('footballStats');
    if (saved) {
        stats = JSON.parse(saved);
    }
    displayStats();
}

function saveStats() {
    localStorage.setItem('footballStats', JSON.stringify(stats));
    displayStats();
}

function displayStats() {
    const elements = {
        matches: document.getElementById('stat-matches'),
        players: document.getElementById('stat-players'),
        success: document.getElementById('stat-success'),
        streak: document.getElementById('stat-streak'),
        bestStreak: document.getElementById('stat-best-streak')
    };

    if (elements.matches) elements.matches.textContent = stats.matchesCompleted;
    if (elements.players) elements.players.textContent = stats.playersGuessed;
    
    if (elements.success) {
        const rate = stats.totalAttempts > 0
            ? Math.round((stats.playersGuessed / stats.totalAttempts) * 100)
            : 0;
        elements.success.textContent = rate + '%';
    }
    
    if (elements.streak) elements.streak.textContent = stats.currentStreak;
    if (elements.bestStreak) elements.bestStreak.textContent = stats.bestStreak;
}

function resetStats() {
    if (confirm('¿Seguro que quieres resetear todas las estadísticas?')) {
        stats = {
            matchesCompleted: 0,
            playersGuessed:   0,
            totalAttempts:    0,
            currentStreak:    0,
            bestStreak:       0
        };
        saveStats();
    }
}

function updateStats(guessed, failed, revealed) {
    stats.matchesCompleted++;
    stats.playersGuessed += guessed;
    stats.totalAttempts += (guessed + failed);
    
    // Actualizar racha
    if (guessed === 11) {
        stats.currentStreak++;
        if (stats.currentStreak > stats.bestStreak) {
            stats.bestStreak = stats.currentStreak;
        }
    } else {
        stats.currentStreak = 0;
    }
    
    saveStats();
}

// ── UTILIDADES DE FECHA ──────────────────────

/**
 * Obtiene el índice del partido diario usando la fecha actual
 * como semilla determinista (mismo para todos los usuarios)
 */
function getDailyMatchIndex(totalMatches) {
    const today = new Date();
    const seed  = today.getFullYear() * 10000
                + (today.getMonth() + 1) * 100
                + today.getDate();

    let hash = seed;
    hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
    hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
    hash = (hash >>> 16) ^ hash;

    return Math.abs(hash) % totalMatches;
}

/**
 * Calcula el número de edición basado en fecha de inicio
 * @param {string} startDate - Fecha de inicio en formato YYYY-MM-DD
 * @returns {number} Número de edición
 */
function getEditionNumber(startDate) {
    const start = new Date(startDate);
    const today = new Date();
    const diffTime = Math.abs(today - start);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays + 1;
}

/**
 * Calcula tiempo restante hasta medianoche
 * @returns {string} Tiempo formateado HH:MM:SS
 */
function getTimeUntilMidnight() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const diff = tomorrow - now;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Inicia countdown que se actualiza cada segundo
 * @param {string} elementId - ID del elemento donde mostrar el countdown
 */
function startCountdown(elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    function update() {
        element.textContent = `Siguiente partido en ${getTimeUntilMidnight()}`;
    }
    
    update();
    setInterval(update, 1000);
}

// ── UTILIDADES DE LOCALSTORAGE ───────────────

/**
 * Guarda progreso de un juego
 * @param {string} gameKey - Identificador del juego
 * @param {object} data - Datos a guardar
 */
function saveGameProgress(gameKey, data) {
    localStorage.setItem(gameKey, JSON.stringify(data));
}

/**
 * Carga progreso de un juego
 * @param {string} gameKey - Identificador del juego
 * @returns {object|null} Datos guardados o null
 */
function loadGameProgress(gameKey) {
    const saved = localStorage.getItem(gameKey);
    return saved ? JSON.parse(saved) : null;
}

/**
 * Borra progreso de un juego
 * @param {string} gameKey - Identificador del juego
 */
function clearGameProgress(gameKey) {
    localStorage.removeItem(gameKey);
}

// ── UTILIDADES DE TEXTO ──────────────────────

/**
 * Normaliza texto removiendo acentos y caracteres especiales
 * @param {string} text - Texto a normalizar
 * @returns {string} Texto normalizado
 */
function normalizeText(text) {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .toUpperCase()
        .trim();
}

/**
 * Compara dos textos de forma flexible (sin acentos, sin espacios extra)
 * @param {string} text1 
 * @param {string} text2 
 * @returns {boolean}
 */
function compareText(text1, text2) {
    return normalizeText(text1) === normalizeText(text2);
}

// ── INIT (ejecutar al cargar cualquier página) ──

document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadSettings();
});

// ── EXPORTAR PARA USO EN MÓDULOS ─────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // Config
        toggleSettings,
        toggleContrast,
        loadSettings,
        // Stats
        loadStats,
        saveStats,
        updateStats,
        resetStats,
        // Utils
        getDailyMatchIndex,
        getEditionNumber,
        getTimeUntilMidnight,
        startCountdown,
        saveGameProgress,
        loadGameProgress,
        clearGameProgress,
        normalizeText,
        compareText
    };
}
