/* =============================================
   LA-TORRE-GAME.JS
   5 jugadores, 1 rompe la torre

   Formato del JSON diario:
   {
     "date": "2026-04-02",
     "title": "TORRE DIARIA",
     "subtitle": "Todos menos uno cumplen la misma condición",
     "commonTrait": "Todos han ganado la Champions League",
     "oddPlayerId": "player-3",
     "oddReason": "Nunca la ha ganado.",
     "players": [
       {
         "id": "player-1",
         "name": "Jugador",
         "position": "DC",
         "team": "Equipo",
         "detail": "Dato corto",
         "photo": "https://...",
         "teamLogo": "https://...",
         "flag": "https://..."
       }
     ]
   }
   ============================================= */

let towerData = null;
let towerOffset = 0;
let towerEdition = 1;
let towerState = null;
let towerCountdownInterval = null;
let towerActiveDateString = null;

const TOWER_STORAGE_PREFIX = 'tower_';
const TOWER_STATS_KEY = 'tower_stats';
const TOWER_LAUNCH_DATE = '2026-04-02';
const TOWER_LAYOUT_CLASSES = ['top-left', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const TOWER_TIMEZONE = 'Europe/Madrid';
const TOWER_MAX_FALLBACK_DAYS = 60;
const TOWER_CACHE_BUSTER = '2026-04-03-2';

function towerGoToHub() {
  window.location.href = '../';
}

function towerFormatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function towerParseDateString(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function towerNowPartsInTimezone() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOWER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function towerTodayString() {
  const now = towerNowPartsInTimezone();
  return `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
}

function towerDateForOffset(offset) {
  const date = towerParseDateString(towerTodayString());
  date.setDate(date.getDate() - offset);
  return date;
}

function towerDateString(offset) {
  return towerFormatDate(towerDateForOffset(offset));
}

function towerProgressKey(dateString = towerActiveDateString || towerDateString(towerOffset)) {
  return `${TOWER_STORAGE_PREFIX}${dateString.replace(/-/g, '')}`;
}

function towerDefaultState() {
  return { finished: false, won: false, selectedPlayerId: null, traitRevealed: false };
}

function towerLoadProgress(offset) {
  const raw = localStorage.getItem(towerProgressKey(towerDateString(offset)));
  if (!raw) return towerDefaultState();
  try {
    return { ...towerDefaultState(), ...JSON.parse(raw) };
  } catch {
    return towerDefaultState();
  }
}

function towerSaveProgress() {
  if (!towerData || !towerState || !towerActiveDateString) return;
  localStorage.setItem(towerProgressKey(towerActiveDateString), JSON.stringify(towerState));
}

function towerLoadStats() {
  const raw = localStorage.getItem(TOWER_STATS_KEY);
  if (!raw) return { played: 0, wins: 0, currentStreak: 0, bestStreak: 0 };
  try {
    return { played: 0, wins: 0, currentStreak: 0, bestStreak: 0, ...JSON.parse(raw) };
  } catch {
    return { played: 0, wins: 0, currentStreak: 0, bestStreak: 0 };
  }
}

function towerSaveStats(stats) {
  localStorage.setItem(TOWER_STATS_KEY, JSON.stringify(stats));
  towerRenderStats();
}

function towerRenderStats() {
  const stats = towerLoadStats();
  const rate = stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
  const values = {
    'tower-stat-played': stats.played,
    'tower-stat-wins': stats.wins,
    'tower-stat-rate': `${rate}%`,
    'tower-stat-streak': stats.currentStreak,
    'tower-stat-best': stats.bestStreak
  };

  Object.entries(values).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

function towerResetStats() {
  if (!confirm('¿Seguro que quieres resetear las estadísticas de La Torre?')) return;
  towerSaveStats({ played: 0, wins: 0, currentStreak: 0, bestStreak: 0 });
}

function towerRecordResult(won) {
  const stats = towerLoadStats();
  stats.played += 1;
  if (won) {
    stats.wins += 1;
    stats.currentStreak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
  } else {
    stats.currentStreak = 0;
  }
  towerSaveStats(stats);
}

function towerGetEdition(dateString) {
  const launch = towerParseDateString(TOWER_LAUNCH_DATE);
  const target = towerParseDateString(dateString);
  return Math.max(1, Math.floor((target - launch) / 86400000) + 1);
}

async function towerFetchJson(dateString) {
  const res = await fetch(`data/${dateString}.json?v=${encodeURIComponent(TOWER_CACHE_BUSTER)}`, { cache: 'no-store' });
  if (!res.ok) return null;

  const data = await res.json();
  if (!towerValidateData(data)) return { dateString, data, invalid: true };
  return { dateString, data, invalid: false };
}

async function towerResolveAvailableDay(requestedOffset) {
  const requestedDateString = towerDateString(requestedOffset);
  const exact = await towerFetchJson(requestedDateString);
  if (exact && exact.invalid) {
    return { invalid: true, dateString: requestedDateString };
  }
  if (exact && !exact.invalid) {
    return {
      dateString: requestedDateString,
      data: exact.data,
      offset: requestedOffset
    };
  }

  const launchDate = towerParseDateString(TOWER_LAUNCH_DATE);
  for (let extraDays = 1; extraDays <= TOWER_MAX_FALLBACK_DAYS; extraDays += 1) {
    const fallbackDate = towerParseDateString(requestedDateString);
    fallbackDate.setDate(fallbackDate.getDate() - extraDays);
    if (fallbackDate < launchDate) break;

    const fallbackDateString = towerFormatDate(fallbackDate);
    const fallback = await towerFetchJson(fallbackDateString);
    if (fallback && !fallback.invalid) {
      return {
        dateString: fallbackDateString,
        data: fallback.data,
        offset: Math.max(0, Math.floor((towerDateForOffset(0) - fallbackDate) / 86400000))
      };
    }
  }

  return null;
}

async function towerLoad(offset) {
  towerOffset = offset;
  towerEdition = towerGetEdition(towerDateString(offset));
  towerActiveDateString = null;

  const screen = document.getElementById('tower-screen');
  screen.innerHTML = `
    <div class="tower-empty">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:4px;color:var(--neon-green);animation:pulse 1s infinite;">CARGANDO...</div>
      <div style="font-size:2rem;">🗼</div>
    </div>`;

  const resolvedDay = await towerResolveAvailableDay(offset);
  if (!resolvedDay) {
    towerRenderUnavailable();
    return;
  }
  if (resolvedDay.invalid) {
    towerRenderInvalid();
    return;
  }

  towerData = resolvedDay.data;
  towerActiveDateString = resolvedDay.dateString;
  towerOffset = resolvedDay.offset;
  towerEdition = towerGetEdition(towerActiveDateString);

  await towerEnrichPlayers();

  towerState = towerLoadProgress(towerOffset);
  towerRenderScreen();
  if (towerState.finished) setTimeout(() => towerOpenResultModal(), 250);
}

function towerValidateData(data) {
  return !!(data && typeof data.commonTrait === 'string' && typeof data.oddPlayerId === 'string' && Array.isArray(data.players) && data.players.length === 5 && data.players.some(player => player.id === data.oddPlayerId));
}

async function towerEnrichPlayers() {
  if (!towerData || !Array.isArray(towerData.players) || typeof PlayerDB === 'undefined') return;

  const playersWithIds = towerData.players.filter(player => player.playerId);
  if (playersWithIds.length === 0) return;

  try {
    PlayerDB.basePath = '../data/players/';
    await PlayerDB.init();

    for (const player of playersWithIds) {
      const dbPlayer = await PlayerDB.getPlayer(player.playerId);
      if (!dbPlayer) continue;

      if (!player.photo && dbPlayer.img) player.photo = dbPlayer.img;
      if (!player.position && dbPlayer.p) player.position = dbPlayer.p;
      if (!player.team && dbPlayer.club) player.team = dbPlayer.club;
      if (!player.detail && dbPlayer.nat) player.detail = dbPlayer.nat;
    }
  } catch (error) {
    console.warn('[La Torre] No se pudieron enriquecer las fotos desde PlayerDB:', error);
  }
}

function towerRenderUnavailable() {
  document.getElementById('tower-screen').innerHTML = `
    <div class="tower-empty">
      <div style="font-size:3rem;">😕</div>
      <div class="tower-empty-title">TORRE NO DISPONIBLE</div>
      <div class="tower-empty-copy">El archivo diario no está subido todavía. Cuando pongas el JSON del día en <code>data/AAAA-MM-DD.json</code>, aparecerá automáticamente.</div>
      <button class="next-btn" onclick="towerGoToHub()">← Volver al hub</button>
    </div>`;
}

function towerRenderInvalid() {
  document.getElementById('tower-screen').innerHTML = `
    <div class="tower-empty">
      <div style="font-size:3rem;">⚠️</div>
      <div class="tower-empty-title">JSON INVÁLIDO</div>
      <div class="tower-empty-copy">El archivo diario existe, pero no tiene la estructura esperada para La Torre.</div>
      <button class="next-btn" onclick="towerGoToHub()">← Volver al hub</button>
    </div>`;
}

function towerRenderScreen() {
  const canBack = towerEdition > 1;
  const canForward = towerOffset > 0;
  const traitVisible = towerState.traitRevealed;
  const subtitle = towerData.subtitle || 'Encuentra al futbolista que rompe el patrón';

  document.getElementById('tower-screen').innerHTML = `
    <div class="tower-header">
      <div class="tower-top-row">
        <button class="tower-back-btn" onclick="towerGoToHub()">← VOLVER</button>
        <div class="tower-title-block">
          <div class="tower-title">LA TORRE</div>
          <div class="tower-subtitle">${towerEscapeHtml(subtitle)}</div>
        </div>
      </div>
      <div class="tower-daily-nav">
        <button class="tower-nav-btn" ${canBack ? '' : 'disabled'} onclick="towerLoad(${towerOffset + 1})">← Anterior</button>
        <div class="tower-nav-center">
          <div class="tower-edition">#${towerEdition}</div>
          ${towerOffset > 0 ? '<div class="tower-past-badge">PASADO</div>' : ''}
        </div>
        <button class="tower-nav-btn" ${canForward ? '' : 'disabled'} onclick="towerLoad(0)">Hoy →</button>
      </div>
    </div>

    <div class="tower-body">
      <div class="tower-intro">
        <div class="tower-intro-title">${towerEscapeHtml(towerData.title || 'ROMPE LA TORRE')}</div>
        <div class="tower-intro-sub">Cuatro jugadores comparten una característica. Uno la rompe. Toca la carta del intruso.</div>
      </div>

      <div class="tower-status">
        <div class="tower-status-main">${towerGetStatusText()}</div>
        <div class="tower-status-trait ${traitVisible ? 'visible' : ''}">Rasgo común: ${towerEscapeHtml(towerData.commonTrait)}</div>
      </div>

      <div class="tower-grid">
        ${towerData.players.map((player, index) => `<div class="tower-slot ${TOWER_LAYOUT_CLASSES[index]}">${towerRenderCard(player)}</div>`).join('')}
      </div>
    </div>

    <div class="tower-bottom-bar">
      <div class="tower-footer-note">${towerState.finished ? 'La torre de hoy ya está resuelta.' : 'Solo tienes una decisión. Si fallas, la torre cae.'}</div>
    </div>

    <div class="tower-result-modal" id="tower-result-modal">
      <div class="tower-result-content">
        <div class="tower-result-title" id="tower-result-title"></div>
        <div class="tower-result-sub" id="tower-result-sub"></div>
        <div class="tower-result-trait">
          <div class="tower-result-trait-label">Característica común</div>
          <div class="tower-result-trait-text">${towerEscapeHtml(towerData.commonTrait)}</div>
        </div>
        <div class="tower-result-player" id="tower-result-player"></div>
        <div class="tower-countdown ${towerOffset === 0 ? 'visible' : ''}" id="tower-countdown"></div>
        <div class="tower-modal-actions">
          <button class="next-btn" onclick="towerCloseResultModal()">Ver torre</button>
        </div>
      </div>
    </div>`;

  towerRenderStats();
  towerUpdateResultModalContent();
}

function towerGetStatusText() {
  if (!towerState || !towerState.finished) return 'Selecciona al jugador que <strong>rompe la torre</strong>.';
  if (towerState.won) return 'Acertaste. Has encontrado al jugador que <strong>rompe la torre</strong>.';
  return 'Fallaste. La característica común ya ha sido <strong>revelada</strong>.';
}

function towerRenderCard(player) {
  const selected = towerState.selectedPlayerId === player.id;
  const isOdd = player.id === towerData.oddPlayerId;
  const finished = towerState.finished;

  let stateClass = '';
  if (finished && selected && towerState.won) stateClass = 'selected-winner';
  else if (finished && selected && !towerState.won) stateClass = 'selected-loser';
  else if (finished && isOdd) stateClass = 'revealed-odd';
  else if (finished && !isOdd) stateClass = 'revealed-safe';

  const dimmed = finished && !selected && !isOdd ? 'dimmed' : '';
  const photo = player.photo ? `<img src="${towerEscapeAttribute(player.photo)}" alt="${towerEscapeAttribute(player.name)}">` : `<div class="tower-card-photo-empty">${towerGetInitials(player.name)}</div>`;
  const logo = player.teamLogo ? `<img src="${towerEscapeAttribute(player.teamLogo)}" alt="">` : '';
  const flag = player.flag ? `<img src="${towerEscapeAttribute(player.flag)}" alt="">` : '';

  return `
    <button class="tower-card ${stateClass} ${dimmed}" ${finished ? 'disabled' : ''} onclick="towerPick('${towerEscapeJs(player.id)}')">
      ${towerRenderCardBadge(selected, isOdd)}
      <div class="tower-card-shell">
        <div class="tower-card-top">
          <div class="tower-card-badge">${logo}</div>
          <div class="tower-card-pos">${towerEscapeHtml(player.position || '—')}</div>
          <div class="tower-card-flag">${flag}</div>
        </div>
        <div class="tower-card-photo">${photo}</div>
        <div class="tower-card-namebar">
          <div class="tower-card-name">${towerEscapeHtml(player.name || 'Jugador')}</div>
        </div>
        <div class="tower-card-meta">
          <div class="tower-card-line"><span class="tower-card-label">Equipo:</span> ${towerEscapeHtml(player.team || '—')}</div>
          <div class="tower-card-line"><span class="tower-card-label">Dato:</span> ${towerEscapeHtml(player.detail || player.subtitle || '—')}</div>
          <div class="tower-card-pick">${finished ? 'Torre resuelta' : 'Descartar jugador'}</div>
        </div>
      </div>
    </button>`;
}

function towerRenderCardBadge(selected, isOdd) {
  if (!towerState.finished) return '';
  if (selected && towerState.won) return `<div class="tower-card-badge-result win">ACIERTO</div>`;
  if (selected && !towerState.won) return `<div class="tower-card-badge-result lose">FALLO</div>`;
  if (isOdd) return `<div class="tower-card-badge-result odd">INTRUSO</div>`;
  return '';
}

function towerPick(playerId) {
  if (!towerData || !towerState || towerState.finished) return;

  const won = playerId === towerData.oddPlayerId;
  towerState = { finished: true, won, selectedPlayerId: playerId, traitRevealed: true };
  towerSaveProgress();
  towerRecordResult(won);
  towerRenderScreen();
  towerOpenResultModal();
}

function towerUpdateResultModalContent() {
  if (!towerData || !towerState || !towerState.finished) return;

  const oddPlayer = towerData.players.find(player => player.id === towerData.oddPlayerId);
  const selectedPlayer = towerData.players.find(player => player.id === towerState.selectedPlayerId);
  const title = document.getElementById('tower-result-title');
  const sub = document.getElementById('tower-result-sub');
  const player = document.getElementById('tower-result-player');
  if (!title || !sub || !player) return;

  title.textContent = towerState.won ? '¡TORRE SALVADA!' : 'LA TORRE CAYÓ';
  sub.textContent = towerState.won
    ? `Has encontrado al jugador que no cumplía el patrón en la edición #${towerEdition}.`
    : `La edición #${towerEdition} queda resuelta. El patrón común ya está descubierto.`;
  player.innerHTML = towerState.won
    ? `<strong>${towerEscapeHtml(oddPlayer?.name || '')}</strong> era el intruso.${towerData.oddReason ? ` ${towerEscapeHtml(towerData.oddReason)}` : ''}`
    : `Elegiste a <strong>${towerEscapeHtml(selectedPlayer?.name || '')}</strong>. El intruso real era <strong>${towerEscapeHtml(oddPlayer?.name || '')}</strong>.${towerData.oddReason ? ` ${towerEscapeHtml(towerData.oddReason)}` : ''}`;
}

function towerOpenResultModal() {
  towerUpdateResultModalContent();
  const modal = document.getElementById('tower-result-modal');
  if (!modal) return;

  if (towerCountdownInterval) {
    clearInterval(towerCountdownInterval);
    towerCountdownInterval = null;
  }

  modal.classList.add('active');
  if (towerOffset === 0) {
    const countdown = document.getElementById('tower-countdown');
    if (countdown) {
      const tick = () => { countdown.textContent = `Nuevo reto en ${towerTimeUntilMidnight()}`; };
      tick();
      towerCountdownInterval = setInterval(tick, 1000);
    }
  }
}

function towerCloseResultModal() {
  const modal = document.getElementById('tower-result-modal');
  if (modal) modal.classList.remove('active');
  if (towerCountdownInterval) {
    clearInterval(towerCountdownInterval);
    towerCountdownInterval = null;
  }
}

function towerTimeUntilMidnight() {
  const now = towerNowPartsInTimezone();
  const current = new Date(now.year, now.month - 1, now.day, now.hour, now.minute, now.second);
  const next = new Date(now.year, now.month - 1, now.day + 1, 0, 0, 0);
  const diff = next - current;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function towerGetInitials(name) {
  if (!name) return '??';
  return name.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
}

function towerEscapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function towerEscapeAttribute(value) {
  return towerEscapeHtml(value);
}

function towerEscapeJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

document.addEventListener('DOMContentLoaded', () => {
  towerRenderStats();
  towerLoad(0);
});
