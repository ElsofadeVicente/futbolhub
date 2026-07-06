/* =============================================
   SHARED.JS — Funciones compartidas
   QUIÉN COÑO FALTA
   ============================================= */

// ── ESTADÍSTICAS GLOBALES ────────────────────
// (usadas activamente por En el Once: stats/loadStats/saveStats/displayStats)

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
        try {
            stats = JSON.parse(saved);
        } catch (e) {
            // localStorage corrupto — no romper la página, empezar de cero
            console.warn('footballStats corrupto, reseteando:', e);
        }
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

// ── INIT (ejecutar al cargar cualquier página) ──

document.addEventListener('DOMContentLoaded', () => {
    loadStats();
});

// ── EXPORTAR PARA USO EN MÓDULOS ─────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // Stats
        loadStats,
        saveStats,
    };
}
