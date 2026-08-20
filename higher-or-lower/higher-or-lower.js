/* =============================================
   HIGHER-OR-LOWER.JS
   QUIÉN COÑO FALTA
   ============================================= */

const HOL_CONFIG = {
  modes: [
    {
      key:       'top-players',
      folder:    'top-players/',
      files:     ['laliga.json', 'premier-league.json', 'serie-a.json', 'bundesliga.json', 'ligue-1.json'],
      mvMin:     15000000,
      name:      'Top Players',
      logo:      '⭐',          // emoji fallback; sustituye por ruta a imagen si tienes
      desc:      'Las 5 grandes ligas · +15M',
      multiFile: true,
    },
    {
      key:       'laliga',
      file:      'laliga.json',
      name:      'La Liga',
      logo:      '../img/logos/laliga.png',   // ruta relativa al HTML
      logoFallback: '🇪🇸',
      desc:      'Todos los jugadores',
      multiFile: false,
    },
    {
      key:       'premier-league',
      file:      'premier-league.json',
      name:      'Premier League',
      logo:      '../img/logos/premier.png',
      logoFallback: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      desc:      'Todos los jugadores',
      multiFile: false,
    },
    {
      key:       'serie-a',
      file:      'serie-a.json',
      name:      'Serie A',
      logo:      '../img/logos/seriea.png',
      logoFallback: '🇮🇹',
      desc:      'Todos los jugadores',
      multiFile: false,
    },
    {
      key:       'bundesliga',
      file:      'bundesliga.json',
      name:      'Bundesliga',
      logo:      '../img/logos/bundesliga.png',
      logoFallback: '🇩🇪',
      desc:      'Todos los jugadores',
      multiFile: false,
    },
    {
      key:       'ligue-1',
      file:      'ligue-1.json',
      name:      'Ligue 1',
      logo:      '../img/logos/ligue1.png',
      logoFallback: '🇫🇷',
      desc:      'Todos los jugadores',
      multiFile: false,
    },
  ],

  storageKeyPrefix: 'hol_record_',

  categories: {
    mv: {
      label: 'VALOR DE MERCADO',
      format: (v) => {
        if (v == null) return '?';
        if (v >= 1000000) return `${(v / 1000000).toFixed(1).replace('.0', '')} mill. €`;
        if (v >= 1000)    return `${(v / 1000).toFixed(0)} mil €`;
        return `${v} €`;
      },
      field: 'mv',
    },
  },
};

/* ── ESTADO ── */
const HOL = {
  pool: [],
  usedIds: new Set(),
  leftPlayer: null,
  rightPlayer: null,
  score: 0,
  record: 0,
  currentCategory: 'mv',
  currentMode: null,
  isAnimating: false,
  gameOver: false,
  pendingTimers: [],
};

/* Cancela cualquier setTimeout de transición/game-over en vuelo.
   Necesario porque "← Volver" durante la partida no recarga la página:
   si se pulsa a mitad de la animación de acierto/fallo, el setTimeout huérfano
   disparaba chainTransition()/triggerGameOver() más tarde sobre la partida
   nueva que el jugador ya hubiera empezado. */
function cancelPendingTimers() {
  HOL.pendingTimers.forEach(id => clearTimeout(id));
  HOL.pendingTimers.length = 0;
}

let DOM = {};

function cacheDom() {
  DOM = {
    loading:        document.getElementById('hol-loading'),
    game:           document.getElementById('hol-game'),
    modeMenu:       document.getElementById('hol-mode-menu'),
    modeGrid:       document.getElementById('hol-mode-grid'),
    modeName:       document.getElementById('hol-mode-name'),
    scoreValue:     document.getElementById('hol-score-value'),
    recordValue:    document.getElementById('hol-record-value'),
    leftBg:         document.getElementById('hol-left-bg'),
    leftName:       document.getElementById('hol-left-name'),
    leftClub:       document.getElementById('hol-left-club'),
    leftStatLabel:  document.getElementById('hol-left-stat-label'),
    leftStatValue:  document.getElementById('hol-left-stat-value'),
    leftPanel:      document.getElementById('hol-left-panel'),
    rightBg:        document.getElementById('hol-right-bg'),
    rightName:      document.getElementById('hol-right-name'),
    rightClub:      document.getElementById('hol-right-club'),
    rightPanel:     document.getElementById('hol-right-panel'),
    rightStatLabel: document.getElementById('hol-right-stat-label'),
    rightStatValue: document.getElementById('hol-right-stat-value'),
    rightReveal:    document.getElementById('hol-right-reveal'),
    btnHigher:      document.getElementById('hol-btn-higher'),
    btnEqual:       document.getElementById('hol-btn-equal'),
    btnLower:       document.getElementById('hol-btn-lower'),
    choices:        document.getElementById('hol-choices'),
    gameoverScreen: document.getElementById('hol-gameover'),
    goScore:        document.getElementById('hol-go-score'),
    goRecord:       document.getElementById('hol-go-record'),
    playAgainBtn:   document.getElementById('hol-play-again'),
    changeModeBtn:  document.getElementById('hol-change-mode'),
  };
}

/* ── CONSTRUIR LOGO de liga ──
   Intenta cargar imagen real; si falla muestra el emoji de fallback */
function buildLogoEl(mode) {
  const wrap = document.createElement('div');
  wrap.className = 'hol-league-logo';

  if (mode.logo && !mode.logo.startsWith('http') && mode.logo !== '' && !['⭐'].includes(mode.logo)) {
    const img = document.createElement('img');
    img.src = mode.logo;
    img.alt = mode.name;
    img.onerror = () => {
      // Si la imagen no carga, mostrar emoji fallback
      wrap.textContent = mode.logoFallback || '🏆';
    };
    wrap.appendChild(img);
  } else {
    // emoji directo (Top Players u otros sin imagen)
    wrap.textContent = mode.logo || mode.logoFallback || '🏆';
  }

  return wrap;
}

/* ── MENÚ DE MODOS ── */
function buildModeMenu() {
  DOM.modeGrid.innerHTML = '';

  for (const mode of HOL_CONFIG.modes) {
    const record = parseInt(localStorage.getItem(HOL_CONFIG.storageKeyPrefix + mode.key) || '0', 10);

    const card = document.createElement('button');
    card.className = 'hol-mode-card';
    card.dataset.modeKey = mode.key;

    // Logo
    card.appendChild(buildLogoEl(mode));

    // Textos
    const texts = document.createElement('div');
    texts.className = 'hol-mode-texts';
    texts.innerHTML = `
      <span class="hol-mode-title">${mode.name}</span>
      <span class="hol-mode-desc">${mode.desc}</span>
      <span class="hol-mode-record">🏆 RÉCORD: ${record}</span>
    `;
    card.appendChild(texts);

    card.addEventListener('click', () => selectMode(mode.key));
    DOM.modeGrid.appendChild(card);
  }
}

function showModeMenu() {
  cancelPendingTimers();
  HOL.isAnimating = false;
  HOL.currentMode = null;
  buildModeMenu();
  DOM.modeMenu.classList.add('active');
  DOM.game.classList.remove('active');
  /* El menú es la URL limpia: si no, recargar te devolvería al modo que
     acabas de abandonar. */
  if (window.FHRuta) FHRuta.borrar('modo');
}

function hideModeMenu() {
  DOM.modeMenu.classList.remove('active');
  DOM.game.classList.add('active');
}

async function selectMode(modeKey) {
  hideModeMenu();
  HOL.currentMode = modeKey;

  /* El modo en la URL: recargar (o abrir el enlace que te han pasado) te deja
     en La Liga o en Top Players, no en el menú. replace y no push: el Atrás
     debe sacarte del juego de una vez, no recorrer los modos visitados.
     Se escribe SIEMPRE, tambien al entrar por la propia URL: showModeMenu()
     la acaba de limpiar (el menú es la URL limpia) y sin volver a ponerla
     recargar te mandaría al menú justo por el camino que venías a evitar.
     Si el valor ya era ese, set() lo ve y no toca nada. */
  if (window.FHRuta) FHRuta.set({ modo: modeKey });

  const mode = HOL_CONFIG.modes.find(m => m.key === modeKey);
  DOM.loading.classList.remove('hidden');

  const rawData = await loadModeData(mode);

  HOL.pool = Object.entries(rawData)
    .filter(([, p]) => p.mv != null && p.n)
    .map(([id, p]) => ({ id, ...p }));

  console.log(`🎮 [HOL] Modo "${mode.name}" — Pool: ${HOL.pool.length} jugadores`);

  if (HOL.pool.length < 2) {
    alert(`No hay suficientes jugadores para el modo "${mode.name}".`);
    DOM.loading.classList.add('hidden');
    showModeMenu();
    return;
  }

  HOL.record = parseInt(localStorage.getItem(HOL_CONFIG.storageKeyPrefix + modeKey) || '0', 10);
  DOM.recordValue.textContent = HOL.record;
  if (DOM.modeName) DOM.modeName.textContent = mode.name.toUpperCase();

  DOM.loading.classList.add('hidden');
  startNewGame();
}

/* ── CARGA DE DATOS (bucket player-db/higher-or-lower/) ── */
async function loadModeData(mode) {
  if (mode.multiFile) {
    const allPlayers = {};
    let loaded = 0;
    for (const file of mode.files) {
      try {
        const res = await fetch(sbStorageUrl('player-db', `higher-or-lower/${mode.folder}${file}`), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const [id, player] of Object.entries(data)) {
          if (mode.mvMin == null || (player.mv != null && player.mv >= mode.mvMin)) {
            allPlayers[id] = player;
          }
        }
        loaded++;
      } catch (e) {
        console.warn(`⚠️ [HOL] No se pudo cargar ${mode.folder}${file}:`, e.message);
      }
    }
    if (loaded === 0) console.error('❌ [HOL] Ningún archivo cargado.');
    return allPlayers;
  }

  try {
    const res = await fetch(sbStorageUrl('player-db', `higher-or-lower/${mode.file}`), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`❌ [HOL] No se pudo cargar ${mode.file}:`, e.message);
    return {};
  }
}

/* ── INICIALIZACIÓN ── */
async function initGame() {
  cacheDom();

  DOM.btnHigher.addEventListener('click', () => handleChoice('higher'));
  DOM.btnEqual.addEventListener('click',  () => handleChoice('equal'));
  DOM.btnLower.addEventListener('click',  () => handleChoice('lower'));

  DOM.playAgainBtn.addEventListener('click', restartGame);
  if (DOM.changeModeBtn) DOM.changeModeBtn.addEventListener('click', () => {
    DOM.gameoverScreen.classList.remove('active');
    showModeMenu();
  });

  /* Se lee ANTES de pintar el menú: showModeMenu() limpia ?modo= (el menú es
     la URL limpia), así que leerlo después devolvería siempre null. */
  const pedido = window.FHRuta ? FHRuta.get('modo') : null;

  DOM.loading.classList.add('hidden');
  showModeMenu();

  /* La URL manda al entrar. El modo se comprueba contra la lista real de
     HOL_CONFIG: cualquier otra cosa se ignora y se entra por el menú. */
  if (window.FHRuta) {
    if (pedido && HOL_CONFIG.modes.some(m => m.key === pedido)) selectMode(pedido);

    FHRuta.alVolver(() => {
      const m = FHRuta.get('modo');
      if (m && HOL_CONFIG.modes.some(x => x.key === m)) {
        if (m !== HOL.currentMode) selectMode(m);
      } else if (HOL.currentMode) {
        DOM.gameoverScreen.classList.remove('active');
        showModeMenu();
      }
    });
  }
}

/* ── LÓGICA DEL JUEGO ── */
function startNewGame() {
  HOL.score = 0;
  HOL.usedIds.clear();
  HOL.gameOver = false;
  HOL.isAnimating = false;
  HOL.currentCategory = 'mv';

  DOM.scoreValue.textContent = '0';
  DOM.gameoverScreen.classList.remove('active');

  HOL.leftPlayer  = pickRandomPlayer(null);
  HOL.rightPlayer = pickRandomPlayer(HOL.leftPlayer);

  renderLeft();
  renderRight();
  enableChoices();
}

function restartGame() { startNewGame(); }

function pickRandomPlayer(referencePlayer) {
  if (HOL.usedIds.size >= HOL.pool.length - 2) {
    HOL.usedIds.clear();
    if (HOL.leftPlayer)  HOL.usedIds.add(HOL.leftPlayer.id);
    if (HOL.rightPlayer) HOL.usedIds.add(HOL.rightPlayer.id);
  }

  const available = HOL.pool.filter(p => !HOL.usedIds.has(p.id));
  if (available.length === 0) return HOL.pool[0];

  if (!referencePlayer || referencePlayer.mv == null) {
    const pick = available[Math.floor(Math.random() * available.length)];
    HOL.usedIds.add(pick.id);
    return pick;
  }

  const refMv = referencePlayer.mv;
  const bucketEqual = available.filter(p => p.mv != null && p.mv === refMv);

  if (bucketEqual.length > 0 && Math.random() < 0.10) {
    const pick = bucketEqual[Math.floor(Math.random() * bucketEqual.length)];
    HOL.usedIds.add(pick.id);
    return pick;
  }

  const bucket5  = available.filter(p => p.mv != null && p.mv !== refMv && Math.abs(p.mv - refMv) <=  5_000_000);
  const bucket10 = available.filter(p => p.mv != null && p.mv !== refMv && Math.abs(p.mv - refMv) <= 10_000_000);
  const bucket15 = available.filter(p => p.mv != null && p.mv !== refMv && Math.abs(p.mv - refMv) <= 15_000_000);

  const roll = Math.random();
  let pool;
  if      (roll < 0.15 && bucket5.length  > 0) pool = bucket5;
  else if (roll < 0.30 && bucket10.length > 0) pool = bucket10;
  else if (roll < 0.45 && bucket15.length > 0) pool = bucket15;
  else pool = available;

  const pick = pool[Math.floor(Math.random() * pool.length)];
  HOL.usedIds.add(pick.id);
  return pick;
}

/* ── RENDER ── */
function renderLeft() {
  const p = HOL.leftPlayer;
  const cat = HOL_CONFIG.categories[HOL.currentCategory];
  setPlayerBg(DOM.leftBg, p);
  DOM.leftName.textContent = p.n;
  DOM.leftClub.textContent = p.club || (p.teams && p.teams[0]) || '';
  DOM.leftStatLabel.textContent = cat.label;
  DOM.leftStatValue.textContent = cat.format(getStatValue(p));
  DOM.leftPanel.classList.remove('sliding-out', 'sliding-in', 'flash-correct', 'flash-wrong');
}

function renderRight() {
  const p = HOL.rightPlayer;
  const cat = HOL_CONFIG.categories[HOL.currentCategory];
  setPlayerBg(DOM.rightBg, p);
  DOM.rightName.textContent = p.n;
  DOM.rightClub.textContent = p.club || (p.teams && p.teams[0]) || '';
  DOM.rightStatLabel.textContent = cat.label;
  DOM.rightStatValue.textContent = cat.format(getStatValue(p));
  DOM.rightReveal.classList.remove('visible');
  DOM.rightPanel.classList.remove('sliding-out', 'sliding-in', 'flash-correct', 'flash-wrong');
}

function setPlayerBg(bgEl, player) {
  bgEl.style.backgroundImage = player.img
    ? `url(${player.img})`
    : 'linear-gradient(135deg, #1a2a3a 0%, #0f1a28 100%)';
}

function getStatValue(player) {
  const field = HOL_CONFIG.categories[HOL.currentCategory].field;
  const val = player[field];
  return val != null ? Number(val) : null;
}

/* ── RESPUESTA ── */
function handleChoice(choice) {
  if (HOL.isAnimating || HOL.gameOver) return;
  HOL.isAnimating = true;

  const leftVal  = getStatValue(HOL.leftPlayer);
  const rightVal = getStatValue(HOL.rightPlayer);

  let correctChoice;
  if      (rightVal > leftVal)  correctChoice = 'higher';
  else if (rightVal === leftVal) correctChoice = 'equal';
  else                           correctChoice = 'lower';

  const isCorrect = (choice === correctChoice);

  DOM.rightReveal.classList.add('visible');

  const btnMap = { higher: DOM.btnHigher, equal: DOM.btnEqual, lower: DOM.btnLower };
  disableChoices();
  btnMap[choice].classList.add(isCorrect ? 'correct-pick' : 'wrong-pick');
  DOM.rightPanel.classList.add(isCorrect ? 'flash-correct' : 'flash-wrong');

  if (isCorrect) {
    HOL.score++;
    DOM.scoreValue.textContent = HOL.score;
    HOL.pendingTimers.push(setTimeout(() => chainTransition(), 1400));
  } else {
    HOL.pendingTimers.push(setTimeout(() => triggerGameOver(), 1600));
  }
}

function chainTransition() {
  DOM.rightReveal.classList.remove('visible');
  DOM.rightStatValue.textContent = '';
  DOM.rightStatLabel.textContent = '';

  DOM.leftPanel.classList.add('sliding-out');
  DOM.rightPanel.classList.add('sliding-out');

  HOL.pendingTimers.push(setTimeout(() => {
    HOL.leftPlayer  = HOL.rightPlayer;
    HOL.rightPlayer = pickRandomPlayer(HOL.leftPlayer);

    renderLeft();
    renderRight();
    enableChoices();

    DOM.leftPanel.classList.add('sliding-in');
    DOM.rightPanel.classList.add('sliding-in');

    HOL.isAnimating = false;
  }, 450));
}

function triggerGameOver() {
  HOL.gameOver = true;
  HOL.isAnimating = false;

  let isNewRecord = false;
  if (HOL.score > HOL.record) {
    HOL.record = HOL.score;
    localStorage.setItem(HOL_CONFIG.storageKeyPrefix + HOL.currentMode, String(HOL.record));
    isNewRecord = true;
  }
  DOM.recordValue.textContent = HOL.record;
  DOM.goScore.textContent = HOL.score;
  DOM.goRecord.innerHTML = isNewRecord
    ? `<span class="new-record">🏆 ¡NUEVO RÉCORD!</span>`
    : `Tu récord: <strong>${HOL.record}</strong>`;

  DOM.gameoverScreen.classList.add('active');
}

function enableChoices() {
  [DOM.btnHigher, DOM.btnEqual, DOM.btnLower].forEach(btn => {
    btn.classList.remove('disabled', 'correct-pick', 'wrong-pick');
    btn.disabled = false;
  });
}

function disableChoices() {
  [DOM.btnHigher, DOM.btnEqual, DOM.btnLower].forEach(btn => {
    btn.classList.add('disabled');
    btn.disabled = true;
  });
}

document.addEventListener('DOMContentLoaded', initGame);
