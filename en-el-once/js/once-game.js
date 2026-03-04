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
let playerAttempts = {};
let playerGuessHistory = {};

let dailyOffset = 0;
let dailyEditionNumber = 0;

let matchStats = { guessed: 0, failed: 0, revealed: 0 };

// ── NAVEGACIÓN ──────────────────────────────

function hideAllScreens() {
    document.getElementById('once-menu').style.display   = 'none';
    document.getElementById('loading').style.display     = 'none';
    document.getElementById('game').style.display        = 'none';
}

function goBackToMenu() {
    hideAllScreens();
    document.getElementById('once-menu').style.display = 'flex';
    // Reset estado
    currentMode = null;
    currentMatch = null;
}

// ── ONCE DIARIO ─────────────────────────────

function getDailyKey(offset) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    return `daily_${yyyy}${mm}${dd}`;
}

function saveDailyResult(offset, result) {
    localStorage.setItem(getDailyKey(offset), JSON.stringify(result));
}

function loadDailyResult(offset) {
    const raw = localStorage.getItem(getDailyKey(offset));
    return raw ? JSON.parse(raw) : null;
}

function getDailyHistoryCount() {
    let count = 0;
    for (let i = 0; i < 365; i++) {
        if (loadDailyResult(i) !== null) count++;
        else break;
    }
    return count;
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

async function loadMatchData(mode) {
    try {
        let folders = [];
        switch (mode) {
            case 'diario':
            case 'random':    folders = ['../data/liga', '../data/champions', '../data/historico']; break;
            case 'liga':      folders = ['../data/liga'];      break;
            case 'champions': folders = ['../data/champions']; break;
            case 'historico': folders = ['../data/historico']; break;
        }

        const knownFiles = {
            '../data/liga': [
                'ALAVES.json','ALMERIA.json','ATHLETIC_CLUB.json','ATLETICO_MADRID.json',
                'BARCELONA.json','CADIZ.json','CELTA_VIGO.json','CORDOBA.json',
                'DEPORTIVO_LA_CORUNA.json','EIBAR.json','ELCHE.json','ESPANYOL.json',
                'GETAFE.json','GIRONA.json','GRANADA.json','LAS_PALMAS.json',
                'LEGANES.json','LEVANTE.json','MALAGA.json','MALLORCA.json',
                'OSASUNA.json','RAYO_VALLECANO.json','REAL_BETIS.json','REAL_MADRID.json',
                'REAL_SOCIEDAD.json','REAL_VALLADOLID.json','SD_HUESCA.json','SEVILLA.json',
                'SPORTING_GIJON.json','VALENCIA.json','VILLARREAL.json'
            ],
            '../data/champions': ['finales.json','semifinales.json','remontadas.json','clasicos.json'],
            '../data/historico': ['mundiales.json','eurocopas.json','olimpiadas.json']
        };

        const allUrls = [];
        for (const folder of folders) {
            for (const file of (knownFiles[folder] || [])) allUrls.push(`${folder}/${file}`);
        }

        const manifestUrls = folders.map(f => ({ folder: f, url: `${f}/manifest.json` }));
        const manifests = await Promise.allSettled(
            manifestUrls.map(({ url }) => fetch(url).then(r => r.ok ? r.json() : null))
        );
        const existingUrls = new Set(allUrls);
        manifests.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value?.files) {
                const folder = manifestUrls[i].folder;
                result.value.files.forEach(file => {
                    const url = `${folder}/${file}`;
                    if (!existingUrls.has(url)) { allUrls.push(url); existingUrls.add(url); }
                });
            }
        });

        let loaded = 0;
        const total = allUrls.length;
        updateLoadingProgress(0, total);

        const results = await Promise.allSettled(
            allUrls.map(url =>
                fetch(url)
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null)
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

function getDailyMatchForOffset(offset) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    let hash = seed;
    hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
    hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
    hash = (hash >>> 16) ^ hash;
    return dailyPool[Math.abs(hash) % dailyPool.length];
}

function getDailyEditionNumber(offset) {
    const launch = new Date(2026, 2, 1);
    const target = new Date();
    target.setDate(target.getDate() - offset);
    target.setHours(0, 0, 0, 0);
    launch.setHours(0, 0, 0, 0);
    return Math.max(1, Math.floor((target - launch) / 86400000) + 1);
}

// =============================================
// INICIAR JUEGO
// =============================================

async function startGame(mode) {
    currentMode  = mode;
    dailyOffset  = 0;
    hideAllScreens();
    document.getElementById('loading').style.display = 'block';

    const loaded = await loadMatchData(mode);
    document.getElementById('loading').style.display = 'none';

    if (!loaded) { goToGame('once'); return; }

    currentMatchIndex = 0;
    if (mode === 'diario') loadDailyMatch(0);
    else loadMatch();
}

// =============================================
// ONCE DIARIO
// =============================================

function loadDailyMatch(offset) {
    dailyOffset        = offset;
    dailyEditionNumber = getDailyEditionNumber(offset);
    currentMatch       = getDailyMatchForOffset(offset);

    revealedPlayers    = new Set();
    failedPlayers      = new Set();
    playerAttempts     = {};
    playerGuessHistory = {};
    matchStats         = { guessed: 0, failed: 0, revealed: 0 };

    document.getElementById('competition').textContent  = currentMatch.competition;
    document.getElementById('home-team').textContent    = currentMatch.homeTeam;
    document.getElementById('away-team').textContent    = currentMatch.awayTeam;
    document.getElementById('score').textContent        = currentMatch.score;
    document.getElementById('date').textContent         = currentMatch.date;
    document.getElementById('playing-team').textContent = `ALINEACIÓN: ${currentMatch.playingTeam}`;

    if (currentMatch.homeBadge) document.getElementById('home-badge').textContent = currentMatch.homeBadge;
    if (currentMatch.awayBadge) document.getElementById('away-badge').textContent = currentMatch.awayBadge;

    document.getElementById('next-match-btn').style.display = 'none';

    updateDailyHeader(offset, dailyEditionNumber);

    document.getElementById('game').style.display = 'block';

    const saved = loadDailyResult(offset);
    if (saved) {
        renderFormationFromSaved(saved);
        showDailyAlreadyPlayed(saved, offset);
    } else {
        renderFormation();
        updateRevealedCount();
    }
}

function updateDailyHeader(offset, edition) {
    let headerEl = document.getElementById('daily-header');
    if (!headerEl) {
        headerEl = document.createElement('div');
        headerEl.id        = 'daily-header';
        headerEl.className = 'daily-header';
        const pt = document.getElementById('playing-team');
        pt.parentNode.insertBefore(headerEl, pt.nextSibling);
    }

    const canGoBack    = edition > 1;
    const canGoForward = offset > 0;

    headerEl.innerHTML = `
        <div class="daily-nav">
            <button class="daily-nav-btn${canGoBack ? '' : ' disabled'}"
                    ${canGoBack ? `onclick="navigateDaily(${offset + 1})"` : 'disabled'}>
                ← Anterior
            </button>
            <div class="daily-edition">
                <span class="daily-label">ONCE DIARIO</span>
                <span class="daily-number">#${edition}</span>
                ${offset > 0 ? '<span class="daily-past-badge">PASADO</span>' : ''}
            </div>
            <button class="daily-nav-btn${canGoForward ? '' : ' disabled'}"
                    ${canGoForward ? `onclick="navigateDaily(0)"` : 'disabled'}>
                Hoy →
            </button>
        </div>
    `;
}

function navigateDaily(newOffset) {
    if (newOffset < 0) return;
    loadDailyMatch(newOffset);
}

function renderFormationFromSaved(saved) {
    revealedPlayers = new Set(saved.revealedPlayers || []);
    failedPlayers   = new Set(saved.failedPlayers   || []);
    matchStats      = saved.matchStats || { guessed: 0, failed: 0, revealed: 0 };
    renderFormation();
    const total = currentMatch.formation.reduce((s, l) => s + l.length, 0);
    document.getElementById('revealed-count').textContent = total;
}

function showDailyAlreadyPlayed(saved, offset) {
    setTimeout(() => {
        document.getElementById('completion-match').textContent =
            `${currentMatch.homeTeam} ${currentMatch.score} ${currentMatch.awayTeam} • ${currentMatch.date}`;
        document.getElementById('comp-guessed').textContent  = saved.matchStats?.guessed  ?? 0;
        document.getElementById('comp-failed').textContent   = saved.matchStats?.failed   ?? 0;
        document.getElementById('comp-revealed').textContent = saved.matchStats?.revealed ?? 0;

        document.querySelector('.completion-title').textContent = offset === 0
            ? (saved.matchStats?.guessed === 11 ? '🏆 ¡ONCE PERFECTO!' : '✅ YA JUGASTE HOY')
            : `📅 ONCE #${getDailyEditionNumber(offset)}`;

        document.getElementById('comp-streak').style.display = 'none';
        const nextBtn = document.querySelector('.completion-buttons .next-btn');
        if (nextBtn) nextBtn.style.display = 'none';

        // Solo mostrar countdown si es hoy
        if (offset === 0) startDailyCountdown();
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
        goToGame('once');
        return;
    }

    currentMatch       = allMatches[currentMatchIndex];
    revealedPlayers    = new Set();
    failedPlayers      = new Set();
    playerAttempts     = {};
    playerGuessHistory = {};
    matchStats         = { guessed: 0, failed: 0, revealed: 0 };

    document.getElementById('competition').textContent  = currentMatch.competition;
    document.getElementById('home-team').textContent    = currentMatch.homeTeam;
    document.getElementById('away-team').textContent    = currentMatch.awayTeam;
    document.getElementById('score').textContent        = currentMatch.score;
    document.getElementById('date').textContent         = currentMatch.date;
    document.getElementById('playing-team').textContent = `ALINEACIÓN: ${currentMatch.playingTeam}`;

    if (currentMatch.homeBadge) document.getElementById('home-badge').textContent = currentMatch.homeBadge;
    if (currentMatch.awayBadge) document.getElementById('away-badge').textContent = currentMatch.awayBadge;

    document.getElementById('next-match-btn').style.display = 'inline-block';

    const dh = document.getElementById('daily-header');
    if (dh) dh.remove();

    renderFormation();
    updateRevealedCount();
    document.getElementById('game').style.display = 'block';
}

// =============================================
// RENDER FORMACIÓN
// =============================================

function renderFormation() {
    const formationContainer = document.getElementById('formation');
    formationContainer.innerHTML = '';
    const formation = currentMatch.formation;

    formation.forEach((line, lineIndex) => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'line';

        line.forEach((player, playerIndex) => {
            const globalIndex = formation.slice(0, lineIndex).reduce((s, l) => s + l.length, 0) + playerIndex;
            const isRevealed  = revealedPlayers.has(globalIndex);

            const playerCard = document.createElement('div');
            playerCard.className = 'player-card' + (isRevealed ? ' revealed' : '');

            const jersey = document.createElement('div');
            jersey.className   = `jersey ${player.position === 'GK' ? 'goalkeeper' : ''}`;
            jersey.textContent = player.number || '';
            jersey.onclick     = () => openGuessModal(globalIndex);

            const nameContainer = document.createElement('div');
            nameContainer.className = 'player-name-container';

            if (isRevealed) {
                const revealedName = document.createElement('div');
                revealedName.className   = 'revealed-name' + (failedPlayers.has(globalIndex) ? ' failed-reveal' : '');
                revealedName.textContent = getKnownName(player.name);
                nameContainer.appendChild(revealedName);
            } else {
                const displayName = getKnownName(player.name);
                for (const char of displayName) {
                    const slot = document.createElement('div');
                    slot.className = char === ' ' ? 'name-slot space' : 'name-slot';
                    nameContainer.appendChild(slot);
                }
            }

            playerCard.appendChild(jersey);
            playerCard.appendChild(nameContainer);
            lineDiv.appendChild(playerCard);
        });

        formationContainer.appendChild(lineDiv);
    });
}

// =============================================
// MODAL ADIVINANZA
// =============================================

function openGuessModal(playerIndex) {
    if (revealedPlayers.has(playerIndex) && !failedPlayers.has(playerIndex)) return;
    if (currentMode === 'diario' && loadDailyResult(dailyOffset) !== null) return;

    currentPlayerIndex = playerIndex;
    currentGuess       = [];
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

function normalizeText(text) {
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
        'MOI GOMEZ': 'MOI GOMEZ', 'CUCHO HERNANDEZ': 'CUCHO', 'CUCHO HERNÁNDEZ': 'CUCHO'
    };
    if (exceptions[name]) return exceptions[name];

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
    const player     = getPlayerByIndex(currentPlayerIndex);
    const targetName = normalizeText(removeSpecialChars(getKnownName(player.name)));

    if (key === 'Enter') { if (currentGuess.length === targetName.length) checkGuess(); return; }
    if (key === 'Delete') { if (currentGuess.length > 0) { currentGuess.pop(); updateCurrentRow(); } return; }
    if (currentGuess.length < targetName.length) { currentGuess.push(key); updateCurrentRow(); }
}

function updateCurrentRow() {
    const player       = getPlayerByIndex(currentPlayerIndex);
    const targetLength = normalizeText(removeSpecialChars(getKnownName(player.name))).length;
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
    const targetName = normalizeText(removeSpecialChars(getKnownName(player.name)));
    const guessWord  = currentGuess.join('');

    if (guessWord === targetName) {
        if (!playerGuessHistory[currentPlayerIndex]) playerGuessHistory[currentPlayerIndex] = [];
        playerGuessHistory[currentPlayerIndex].push({
            guess: guessWord, status: new Array(targetName.length).fill('correct')
        });
        animateCorrectGuess();
        setTimeout(() => { revealPlayer(currentPlayerIndex); closeGuessModal(); updateStats('correct'); }, 1500);
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
        setTimeout(() => { revealPlayer(currentPlayerIndex, true); closeGuessModal(); updateStats('failed'); }, 1000);
    }
}

function animateCorrectGuess() {
    const player       = getPlayerByIndex(currentPlayerIndex);
    const targetLength = normalizeText(removeSpecialChars(getKnownName(player.name))).length;
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
    updateRevealedCount();
}

function revealPlayerFromModal() {
    if (currentPlayerIndex !== null) {
        revealPlayer(currentPlayerIndex);
        closeGuessModal();
        updateStats('voluntary');
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

function getTimeUntilNextDaily() {
    const now  = new Date();
    const next = new Date();
    next.setHours(12, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    const diff = next - now;
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
    if (stats.currentStreak >= 3 && currentMode !== 'diario') {
        streakEl.textContent = `🔥 Racha actual: ${stats.currentStreak}`; streakEl.style.display = 'block';
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
            matchStats:      { ...matchStats }
        });
    } else {
        if (countdownEl) countdownEl.style.display = 'none';
        if (dailyCountdownInterval) clearInterval(dailyCountdownInterval);
    }

    document.getElementById('completion-modal').classList.add('active');
    stats.matchesCompleted++;
    saveStats();
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
        for (let i = 0; i < total; i++) revealedPlayers.add(i);
        renderFormation();
        updateRevealedCount();
        stats.currentStreak = 0;
        saveStats();
    }
}

// =============================================
// ESTADÍSTICAS
// =============================================

function updateStats(mode) {
    stats.totalAttempts++;
    if (mode === 'correct') {
        stats.playersGuessed++; matchStats.guessed++;
        stats.currentStreak++;
        if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
    } else if (mode === 'failed') {
        matchStats.failed++; stats.currentStreak = 0;
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
    // Mostrar menú del once por defecto
    hideAllScreens();
    document.getElementById('once-menu').style.display = 'flex';
});
