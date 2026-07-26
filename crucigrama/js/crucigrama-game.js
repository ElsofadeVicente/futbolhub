/* =============================================
   CRUCIGRAMA-GAME.JS — Lógica del crucigrama diario
   QUIÉN COÑO FALTA
   ============================================= */

// ── ESTADO ──────────────────────────────────

let crucData        = null;   // JSON del crucigrama actual
let crucOffset      = 0;      // 0 = hoy, 1 = ayer, etc.
let crucEdition     = 1;
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
    loadCrucigrama(0);
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
        clean: !crucUsedReveal   // sin usar "Revelar" — cuenta para la racha del hub
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

// ── CARGAR CRUCIGRAMA ────────────────────────

async function loadCrucigrama(offset) {
    crucOffset  = offset;
    crucEdition = crucGetEdition(offset);

    const d = new Date();
    d.setDate(d.getDate() - offset);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    // Show loading state
    const screen = document.getElementById('crucigrama-screen');
    screen.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:4px;color:var(--neon-green);animation:pulse 1s infinite;">CARGANDO...</div>
            <div style="font-size:2rem;">📰</div>
        </div>`;

    try {
        const res = await fetch(sbStorageUrl('game-data', `crucigrama/${dateStr}.json`), { cache: 'no-cache' });
        if (!res.ok) throw new Error('not found');
        crucData = await res.json();
    } catch {
        // Fallback: el día pedido no existe (hueco de calendario, o el de hoy
        // aún no está subido). Usar la edición disponible más cercana SIN
        // pasarse de la fecha pedida — nunca la más reciente de todas, o
        // "← Anterior" en un hueco (p.ej. fin de semana) saltaría al
        // crucigrama más nuevo en vez de retroceder al día válido anterior.
        try {
            const fallback = await fetch(sbStorageUrl('game-data', 'crucigrama/index.json'), { cache: 'no-cache' });
            if (!fallback.ok) throw new Error('no index');
            const index = await fallback.json();
            if (!index.dates || index.dates.length === 0) throw new Error('empty');
            const notAfter = index.dates.filter(d => d <= dateStr);
            const chosenDate = notAfter.length ? notAfter[notAfter.length - 1] : index.dates[0];
            const res2 = await fetch(sbStorageUrl('game-data', `crucigrama/${chosenDate}.json`), { cache: 'no-cache' });
            if (!res2.ok) throw new Error('fallback fail');
            crucData = await res2.json();

            // El puzzle cargado puede no ser el de "offset" días pedido —
            // recalcular offset/edición a partir de la fecha real del puzzle,
            // no de la fecha solicitada.
            const [ly, lm, ld] = chosenDate.split('-').map(Number);
            const latestUTC = Date.UTC(ly, lm - 1, ld);
            const now = new Date();
            const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
            crucOffset  = Math.max(0, Math.round((todayUTC - latestUTC) / 86400000));
            crucEdition = crucGetEdition(crucOffset);
        } catch {
            document.getElementById('crucigrama-screen').innerHTML = `
                <button class="back-to-hub-btn" onclick="goToHub()">← VOLVER</button>
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:16px;padding:20px;">
                    <div style="font-size:3rem;">😓</div>
                    <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;letter-spacing:3px;color:var(--neon-yellow);text-align:center;">
                        CRUCIGRAMA NO DISPONIBLE
                    </div>
                    <div style="font-family:'Rajdhani',sans-serif;font-size:1rem;color:var(--text-light);opacity:0.7;text-align:center;max-width:320px;">
                        El crucigrama de hoy no está disponible todavía.<br>Prueba más tarde o vuelve mañana.
                    </div>
                    <button class="next-btn" style="margin-top:10px;" onclick="goToHub()">← Volver al hub</button>
                </div>`;
            return;
        }
    }

    // Reset state
    crucUserGrid    = {};
    crucSolvedWords = new Set();
    crucSelectedWord = null;
    crucSelectedCell = null;
    crucUsedReveal   = false;

    // Restore saved state if any (clave por fecha real del puzzle cargado)
    const saved = crucLoad();
    if (saved) {
        crucUserGrid    = saved.userGrid    || {};
        crucSolvedWords = new Set(saved.solvedWords || []);
        crucUsedReveal  = saved.clean === false;
    }

    // Rebuild screen
    buildCrucigramaScreen();

    // If already completed, show result modal
    if (crucIsComplete()) {
        setTimeout(() => crucShowCompletion(), 400);
    }
}

// ── CALCULAR EDICIÓN ────────────────────────

function crucGetEdition(offset) {
    // Días de calendario contados en UTC para que un cambio de horario de
    // verano/invierno entre medias no desplace el número de edición en ±1 día.
    const launchUTC = Date.UTC(2026, 2, 3); // 3 marzo 2026
    const now = new Date();
    const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const targetUTC = todayUTC - offset * 86400000;
    return Math.max(1, Math.floor((targetUTC - launchUTC) / 86400000) + 1);
}

// ── CONSTRUIR PANTALLA ───────────────────────

function buildCrucigramaScreen() {
    const screen = document.getElementById('crucigrama-screen');
    screen.innerHTML = '';

    const canBack    = crucEdition > 1;
    const canForward = crucOffset > 0;

    screen.innerHTML = `
        <!-- HEADER -->
        <div class="cruc-header">
            <div class="cruc-nav-row">
                <button class="cruc-back-btn" onclick="goToHub()">← VOLVER</button>
                <div class="cruc-title-block">
                    <div class="cruc-title">EN EL CRUCIGRAMA</div>
                    <div class="cruc-edition">Crucigrama diario de fútbol</div>
                </div>
            </div>
            <div class="cruc-daily-nav">
                <button class="cruc-nav-btn" id="cruc-prev-btn" ${canBack ? '' : 'disabled'}
                        onclick="loadCrucigrama(${crucOffset + 1})">← Anterior</button>
                <div class="cruc-edition-center">
                    <div class="cruc-edition-num">#${crucEdition}</div>
                    ${crucOffset > 0 ? '<div class="cruc-past-badge">PASADO</div>' : ''}
                </div>
                <button class="cruc-nav-btn" id="cruc-next-btn" ${canForward ? '' : 'disabled'}
                        onclick="loadCrucigrama(0)">Hoy →</button>
            </div>
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
            </div>
            <div class="cruc-actions">
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
                        <div class="cruc-comp-stat-value" id="cruc-comp-pct">100%</div>
                        <div class="cruc-comp-stat-label">Completado</div>
                    </div>
                </div>
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

    const { rows, cols } = crucData.grid_size;

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

            if (!crucData.grid[r][c]) {
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
    cell.classList.remove('cruc-cell--word-active', 'cruc-cell--selected', 'cruc-cell--correct');

    if (crucIsCellCorrect(r, c)) {
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
    const { rows, cols } = crucData.grid_size;
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (crucData.grid[r][c]) updateCellVisual(r, c);
}

// ── RENDER PISTAS ────────────────────────────

function renderCluesList() {
    if (!crucData) return;

    const across = crucData.words.filter(w => w.direction === 'across').sort((a,b) => a.number - b.number);
    const down   = crucData.words.filter(w => w.direction === 'down').sort((a,b) => a.number - b.number);

    const buildList = (words) => words.map(w => {
        const isActive  = crucSelectedWord && crucSelectedWord.id === w.id;
        const isSolved  = crucSolvedWords.has(w.id);
        return `<div class="cruc-clue-item ${isActive ? 'active' : ''} ${isSolved ? 'solved' : ''}"
                     onclick="crucSelectWordById(${w.id})" data-clue-id="${w.id}">
                    <div class="cruc-clue-num">${w.number}</div>
                    <div class="cruc-clue-desc">${w.clue}</div>
                </div>`;
    }).join('');

    const acrossHTML = `
        <div class="cruc-clues-section">
            <div class="cruc-clues-heading">HORIZONTALES</div>
            ${buildList(across)}
        </div>`;
    const downHTML = `
        <div class="cruc-clues-section">
            <div class="cruc-clues-heading">VERTICALES</div>
            ${buildList(down)}
        </div>`;

    const colDown   = document.getElementById('cruc-clues-down');
    const colAcross = document.getElementById('cruc-clues-across');
    if (colDown)   colDown.innerHTML   = downHTML;
    if (colAcross) colAcross.innerHTML = acrossHTML;
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
        <div class="cruc-clue-text">${w.clue}</div>`;
}

// ── INTERACCIÓN CON CELDAS ───────────────────

function crucClickCell(r, c) {
    if (!crucData) return;

    // Find all words containing this cell
    const words = crucGetWordsAtCell(r, c);
    if (words.length === 0) return;

    // If already selected and clicking same cell: toggle direction
    if (crucSelectedCell && crucSelectedCell.row === r && crucSelectedCell.col === c
        && crucSelectedWord && words.length > 1) {
        const otherDir = crucSelectedWord.direction === 'across' ? 'down' : 'across';
        const altWord  = words.find(w => w.direction === otherDir);
        if (altWord) {
            crucSelectedWord = altWord;
        }
    } else {
        // Prefer same direction if possible, else first available
        let word = words.find(w => w.direction === (crucSelectedWord?.direction || 'across'));
        if (!word) word = words[0];
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
        if (crucUserGrid[cellKey]) {
            delete crucUserGrid[cellKey];
            // Re-comprobar TODAS las palabras que pasan por la celda: si alguna
            // estaba marcada como resuelta, al borrar la letra deja de estarlo
            // (antes quedaba "resuelta" para siempre y podía dar falso completado).
            crucGetWordsAtCell(row, col).forEach(wd => crucCheckWordSolved(wd));
            updateCellVisual(row, col);
        } else {
            // Move backwards
            const prev = crucGetPrevCell(w, row, col);
            if (prev) {
                crucSelectedCell = prev;
                const prevKey = `${prev.row},${prev.col}`;
                delete crucUserGrid[prevKey];
                crucGetWordsAtCell(prev.row, prev.col).forEach(wd => crucCheckWordSolved(wd));
                updateCellVisual(prev.row, prev.col);
                refreshAllCells();
            }
        }
        crucSave();
        return;
    }

    if (key === 'Tab' || key === 'ArrowRight' || key === 'ArrowDown') {
        crucAdvanceToNextWord();
        return;
    }

    if (!/^[A-ZÁÉÍÓÚÜÑ]$/i.test(key)) return;

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
    if (!crucSelectedCell || !crucData) return;
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
    if (!crucSelectedWord || !crucData) return;
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
    if (!confirm('¿Seguro que quieres revelar toda la cuadrícula?')) return;
    if (!crucData) return;
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

    const modal = document.getElementById('cruc-completion-modal');
    if (!modal) return;

    const total   = crucData.words.length;
    const solved  = crucSolvedWords.size;
    const pct     = Math.round((solved / total) * 100);
    const perfect = solved === total && !revealed;

    document.getElementById('cruc-comp-title').textContent = perfect ? '🏆 ¡PERFECTO!' : '✅ CRUCIGRAMA COMPLETADO';
    document.getElementById('cruc-comp-sub').textContent   = `Crucigrama #${crucEdition} · ${crucData.date}`;
    document.getElementById('cruc-comp-words').textContent = solved;
    document.getElementById('cruc-comp-pct').textContent   = pct + '%';

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
    const clean  = !crucUsedReveal;
    const squares = '🟩'.repeat(Math.min(solved, total)) + '⬛'.repeat(Math.max(0, total - solved));
    const text =
        `El Crucigrama FutbolHUB #${crucEdition}\n` +
        `${solved}/${total} palabras${clean ? ' ✅' : ' 🔍 (con ayudas)'}\n` +
        `${squares}\n` +
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

function crucTimeUntilMidnight() {
    const now  = new Date();
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    const diff = next - now;
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
        else if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]$/i.test(e.key)) { e.preventDefault(); crucHandleKey(e.key.toUpperCase()); }
    });
});

// ── INIT AL CARGAR ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    openCrucigrama();
});
