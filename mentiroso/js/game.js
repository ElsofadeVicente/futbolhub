'use strict';

const FB = window._FB || {};
const db = FB.db;
const ref = FB.ref;
const set = FB.set;
const get = FB.get;
const onValue = FB.onValue;
const runTransaction = FB.runTransaction;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function genId() {
  return 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast ' + kind;
  }, 2400);
}

const HAND_CONFIG = {
  2: { hand: 8, center: 4 },
  3: { hand: 6, center: 3 },
  4: { hand: 6, center: 2 },
  5: { hand: 6, center: 0 },
  6: { hand: 6, center: 0 },
  7: { hand: 6, center: 0 },
  8: { hand: 6, center: 0 }
};

const CENTER_ATTRS = ['flag', 'position', 'club'];
const POINTS_LIMIT = { min: 1, max: 9, value: 3 };
const NUMERIC_THRESHOLD_CACHE = new Map();
const ROOM_ROOT = 'restricciones/rooms';
const ROOM_ROOT_CANDIDATES = [
  'restricciones/rooms',
  'rooms',
  'mentiroso_rooms',
  'rooms/mentiroso',
  'mentiroso/rooms'
];

function loadClientId() {
  try {
    const stored = localStorage.getItem('mentiroso_client_id');
    if (stored) return stored;
    const fresh = genId();
    localStorage.setItem('mentiroso_client_id', fresh);
    return fresh;
  } catch {
    return genId();
  }
}

const Me = {
  clientId: loadClientId(),
  name: '',
  isHost: false,
  roomCode: null,
  roomRoot: ROOM_ROOT
};

let State = null;
let unsubscribeRoom = null;

function roomRef(code) {
  return ref(db, `${Me.roomRoot || ROOM_ROOT}/${code}`);
}

function roomRefAt(root, code) {
  return ref(db, `${root}/${code}`);
}

function hasFirebase() {
  return Boolean(window._FB?.configured && db && ref && set && get && onValue && runTransaction);
}

function serializePlayers(state) {
  const playersMap = {};
  state.players.forEach((player) => {
    playersMap[player.id] = {
      name: player.name,
      isHost: Boolean(player.isHost),
      score: Number(player.score || 0),
      lastGuess: player.lastGuess ?? null,
      cardsCount: Number(player.cardsCount || 0)
    };
  });
  return playersMap;
}

function normalizePlayers(rawState) {
  if (Array.isArray(rawState.players)) return rawState.players;
  const playersMap = rawState.players || {};
  const order = Array.isArray(rawState.playerOrder) ? rawState.playerOrder : Object.keys(playersMap);
  return order
    .filter((id) => playersMap[id])
    .map((id) => ({
      id,
      name: playersMap[id].name,
      isHost: Boolean(playersMap[id].isHost),
      score: Number(playersMap[id].score || 0),
      lastGuess: playersMap[id].lastGuess ?? null,
      cardsCount: Number(playersMap[id].cardsCount || 0)
    }));
}

function serializeStateForFirebase(state) {
  const next = deepClone(state);
  next.playerOrder = next.players.map((player) => player.id);
  next.players = serializePlayers(next);
  return next;
}

function normalizeStateFromFirebase(rawState) {
  const next = deepClone(rawState);
  next.players = normalizePlayers(rawState);
  return next;
}

function showScreen(selector) {
  $$('.screen').forEach((screen) => screen.classList.remove('active'));
  const target = $(selector);
  if (target) target.classList.add('active');
}

function normalizePointsToWin(value) {
  const parsed = Math.floor(Number(value) || POINTS_LIMIT.value);
  return Math.max(POINTS_LIMIT.min, Math.min(POINTS_LIMIT.max, parsed));
}

function stampState(state) {
  state.updatedAt = Date.now();
}

function totalCardsInPlay(state) {
  const hands = Object.values(state.hands || {});
  let total = hands.reduce((sum, hand) => sum + hand.length, 0);
  total += (state.centerCards || []).length;
  return total;
}

function createCardFromPlayer(player) {
  return {
    playerId: player.id,
    playerName: player.name,
    country: player.country,
    countryFlag: player.countryFlag,
    club: player.club,
    clubBadge: player.clubBadge,
    position: player.position,
    stats: { ...player.stats }
  };
}

function sampleN(arr, n) {
  const copy = arr.slice();
  const limit = Math.min(n, copy.length);
  const out = [];
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

function drawRoundDeck(count) {
  return sampleN(window.PLAYERS, count).map(createCardFromPlayer);
}

// Cuenta cuantas cartas del mazo cumplen una condicion candidata.
function countMatchesInDeck(deck, condition) {
  const round = { stat: condition.stat, threshold: condition.threshold };
  return deck.reduce((total, card) => total + (cardMatchesRound(card, round) ? 1 : 0), 0);
}

// Elige una condicion que NO sea degenerada (que no de 0 ni el total entero)
// para las cartas realmente repartidas, asi cada ronda tiene algo que adivinar.
function chooseRoundCondition(deck) {
  let fallback = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = buildRoundCondition();
    const matches = countMatchesInDeck(deck, candidate);
    if (matches >= 1 && matches < deck.length) return candidate;
    if (!fallback || (matches > 0 && fallback.matches === 0)) {
      fallback = { candidate, matches };
    }
  }
  return fallback ? fallback.candidate : buildRoundCondition();
}

function buildThresholdOptions(definition) {
  const text = `${definition.key} ${definition.label} ${definition.unit || ''}`.toLowerCase();
  const rawValues = window.PLAYERS
    .map((player) => Number(player.stats?.[definition.key]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (text.includes('altura') || text.includes('height')) return [180, 185, 190];
  if (text.includes('edad') || text.includes('age')) return [30, 35];
  if (text.includes('rojas') || text.includes('red')) return [1, 2];
  if (text.includes('amarillas') || text.includes('yellow')) return [5, 10];
  if (text.includes('asist')) return [5, 10];
  if (text.includes('partidos') || text.includes('apps') || text.includes('appearances') || text.includes('caps')) return [15, 20, 25];
  if (text.includes('goles') || text.includes('goals')) return [5, 10, 15, 20, 25];
  if (rawValues.length === 0) return [1, 2, 3];

  const ratios = [0.2, 0.4, 0.6, 0.8];
  const set = new Set();
  ratios.forEach((ratio) => {
    const idx = Math.max(0, Math.min(rawValues.length - 1, Math.floor(rawValues.length * ratio)));
    set.add(Math.floor(rawValues[idx]));
  });

  return Array.from(set)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
    .slice(0, 5);
}

function getThresholdOptions(definition) {
  if (!NUMERIC_THRESHOLD_CACHE.has(definition.key)) {
    NUMERIC_THRESHOLD_CACHE.set(definition.key, buildThresholdOptions(definition));
  }
  const options = NUMERIC_THRESHOLD_CACHE.get(definition.key) || [];
  return options.length ? options : [1, 2, 3];
}

function buildRoundCondition() {
  const definition = pick(window.STAT_DEFINITIONS);
  if (!definition) {
    return {
      stat: { key: 'goals_career', label: 'goles oficiales en su carrera', unit: 'goles oficiales en su carrera', type: 'number' },
      threshold: 10,
      promptLabel: 'Mas de 10 goles oficiales en su carrera'
    };
  }

  if ((definition.type || 'number') === 'bool') {
    return {
      stat: { ...definition, type: 'bool' },
      threshold: null,
      promptLabel: definition.label
    };
  }

  const options = getThresholdOptions(definition);
  const threshold = pick(options);
  return {
    stat: { ...definition, type: 'number' },
    threshold,
    promptLabel: `Mas de ${threshold} ${definition.unit}`
  };
}

function cardMatchesRound(card, round) {
  const rawValue = card.stats?.[round.stat.key];
  if (round.stat.type === 'bool') return Boolean(rawValue);
  const value = Number(rawValue);
  return Number.isFinite(value) && value > round.threshold;
}

function initRound(state, roundNumber, startIdx) {
  const playerCount = state.players.length;
  const config = getHandConfig(playerCount);
  const totalCardsNeeded = config.center + (playerCount * config.hand);
  const deck = drawRoundDeck(totalCardsNeeded);

  // La condicion se elige contra el mazo ya repartido para evitar rondas
  // triviales (resultado 0 o "todas"). El mazo todavia tiene stats completas.
  const condition = chooseRoundCondition(deck);
  const key = condition.stat.key;
  const fallbackValue = condition.stat.type === 'bool' ? false : 0;

  // Guardamos en cada carta SOLO el dato de la stat de esta ronda. El juego
  // nunca usa otra clave dentro de la ronda, asi que esto reduce el tamaño del
  // estado en Firebase ~50x (antes se guardaban ~50 stats por carta).
  const trimCard = (card) => ({
    playerId: card.playerId,
    playerName: card.playerName,
    country: card.country,
    countryFlag: card.countryFlag,
    club: card.club,
    clubBadge: card.clubBadge,
    position: card.position,
    stats: { [key]: card.stats?.[key] ?? fallbackValue }
  });

  let index = 0;
  state.hands = {};
  state.players.forEach((player) => {
    state.hands[player.id] = deck.slice(index, index + config.hand).map(trimCard);
    player.cardsCount = config.hand;
    player.lastGuess = null;
    index += config.hand;
  });

  state.centerCards = deck.slice(index, index + config.center).map((card) => ({
    ...trimCard(card),
    visibleAttr: pick(CENTER_ATTRS)
  }));

  state.round = {
    number: roundNumber,
    stat: condition.stat,
    threshold: condition.threshold,
    promptLabel: condition.promptLabel,
    guesses: {},
    turnIdx: startIdx,
    startIdx
  };
  state.reveal = null;
  state.pendingWinner = null;
  state.phase = 'playing';
  state.status = 'playing';
}

function getHandConfig(playerCount) {
  if (playerCount <= 2) return HAND_CONFIG[2];
  if (playerCount >= 8) return HAND_CONFIG[8];
  return HAND_CONFIG[playerCount];
}

function getNextTurnIdx(state, fromIdx) {
  for (let step = 1; step <= state.players.length; step++) {
    const idx = (fromIdx + step) % state.players.length;
    const player = state.players[idx];
    if (player && state.round.guesses[player.id] === undefined) return idx;
  }
  return -1;
}

function maybeResolveWinner(state) {
  const topScore = Math.max(...state.players.map((player) => player.score));
  if (topScore < state.pointsToWin) return null;
  const leaders = state.players.filter((player) => player.score === topScore);
  if (leaders.length !== 1) return null;
  return { id: leaders[0].id, name: leaders[0].name, score: leaders[0].score };
}

function resolveRound(state) {
  const revealCards = [];
  state.players.forEach((player) => {
    (state.hands[player.id] || []).forEach((card) => {
      revealCards.push({
        ...card,
        ownerId: player.id,
        ownerName: player.name,
        matches: cardMatchesRound(card, state.round)
      });
    });
  });

  state.centerCards.forEach((card) => {
    revealCards.push({
      ...card,
      ownerId: '__center__',
      ownerName: 'Centro',
      matches: cardMatchesRound(card, state.round)
    });
  });

  const actualTotal = revealCards.filter((card) => card.matches).length;
  const guesses = state.players.map((player) => ({
    id: player.id,
    name: player.name,
    guess: state.round.guesses[player.id]
  }));
  const winners = guesses.filter((entry) => entry.guess === actualTotal);

  winners.forEach((entry) => {
    const player = state.players.find((candidate) => candidate.id === entry.id);
    if (player) player.score += 1;
  });

  state.reveal = {
    stat: deepClone(state.round.stat),
    promptLabel: state.round.promptLabel,
    threshold: state.round.threshold,
    actualTotal,
    guesses,
    winnerIds: winners.map((entry) => entry.id),
    winnerNames: winners.map((entry) => entry.name),
    cards: revealCards
  };
  state.phase = 'reveal';
  state.status = 'reveal';
  state.pendingWinner = maybeResolveWinner(state);
}

function submitGuess(state, clientId, guess) {
  if (state.phase !== 'playing') {
    return { ok: false, reason: 'La ronda no esta aceptando apuestas.' };
  }

  const currentPlayer = state.players[state.round.turnIdx];
  if (!currentPlayer || currentPlayer.id !== clientId) {
    return { ok: false, reason: 'No es tu turno.' };
  }

  const parsedGuess = Math.floor(Number(guess));
  if (!Number.isFinite(parsedGuess) || parsedGuess < 0) {
    return { ok: false, reason: 'La apuesta debe ser 0 o mayor.' };
  }

  const maxGuess = totalCardsInPlay(state);
  if (parsedGuess > maxGuess) {
    return { ok: false, reason: `No puede ser mayor que ${maxGuess}.` };
  }

  state.round.guesses[clientId] = parsedGuess;
  currentPlayer.lastGuess = parsedGuess;

  const nextIdx = getNextTurnIdx(state, state.round.turnIdx);
  if (nextIdx === -1) {
    resolveRound(state);
  } else {
    state.round.turnIdx = nextIdx;
  }

  return { ok: true };
}

function continueAfterReveal(state) {
  if (state.phase !== 'reveal') return;
  if (state.pendingWinner) {
    state.phase = 'gameover';
    state.status = 'finished';
    state.winner = { ...state.pendingWinner };
    return;
  }

  const nextStartIdx = (state.round.startIdx + 1) % state.players.length;
  initRound(state, state.round.number + 1, nextStartIdx);
}

function removePlayerFromState(state, clientId) {
  const idx = state.players.findIndex((player) => player.id === clientId);
  if (idx < 0) return;

  state.players.splice(idx, 1);
  if (Array.isArray(state.playerOrder)) {
    state.playerOrder = state.playerOrder.filter((id) => id !== clientId);
  }
  delete state.hands[clientId];

  if (state.players.length === 0) {
    return;
  }

  if (state.hostId === clientId) {
    const nextHost = state.players[0];
    state.hostId = nextHost.id;
    nextHost.isHost = true;
  }

  state.players.forEach((player) => {
    player.isHost = player.id === state.hostId;
  });

  if (state.phase === 'playing' && state.round) {
    delete state.round.guesses[clientId];
    if (state.players.length < 2) {
      state.phase = 'gameover';
      state.status = 'finished';
      state.winner = { id: state.players[0].id, name: state.players[0].name, score: state.players[0].score };
      return;
    }

    state.round.startIdx = state.round.startIdx % state.players.length;
    state.round.turnIdx = state.round.turnIdx % state.players.length;
    if (getNextTurnIdx(state, state.round.turnIdx - 1) === -1) {
      resolveRound(state);
      return;
    }
    if (!state.players[state.round.turnIdx] || state.round.guesses[state.players[state.round.turnIdx].id] !== undefined) {
      state.round.turnIdx = getNextTurnIdx(state, state.round.turnIdx - 1);
    }
  }

  if (state.phase === 'reveal' && state.players.length < 2) {
    state.pendingWinner = { id: state.players[0].id, name: state.players[0].name, score: state.players[0].score };
  }
}

function createInitialState(code, mode, name) {
  return {
    game: 'mentiroso',
    code,
    status: 'waiting',
    phase: 'lobby',
    mode,
    pointsToWin: normalizePointsToWin(POINTS_LIMIT.value),
    hostId: Me.clientId,
    playerOrder: [Me.clientId],
    players: {
      [Me.clientId]: {
        name,
        isHost: true,
        score: 0,
        lastGuess: null,
        cardsCount: 0
      }
    },
    hands: {},
    centerCards: [],
    round: null,
    reveal: null,
    pendingWinner: null,
    winner: null,
    updatedAt: Date.now()
  };
}

function applyIncomingState(nextState) {
  State = normalizeStateFromFirebase(nextState);
  if (!State) {
    render();
    return;
  }

  State.players.forEach((player) => {
    player.score = Number(player.score || 0);
    player.cardsCount = Number(player.cardsCount || 0);
    if (player.lastGuess === undefined) player.lastGuess = null;
  });
  if (!State.phase && State.status === 'waiting') State.phase = 'lobby';
  if (!State.phase && State.status === 'playing') State.phase = 'playing';
  if (!State.phase && State.status === 'reveal') State.phase = 'reveal';
  if (!State.phase && State.status === 'finished') State.phase = 'gameover';
  State.pointsToWin = normalizePointsToWin(State.pointsToWin);
  Me.isHost = State.hostId === Me.clientId;
  render();
}

function subscribeToRoom(code) {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = onValue(roomRef(code), (snapshot) => {
    const room = snapshot.val();
    if (!room) {
      const hadRoom = Boolean(State);
      clearLocalRoom();
      if (hadRoom) toast('La sala ya no existe.', 'error');
      return;
    }
    applyIncomingState(room);
  }, () => {
    toast('Error de conexion con la sala.', 'error');
  });
}

// Activa un listener real sobre la sala y resuelve cuando llega el PRIMER dato
// del servidor. Necesario antes de runTransaction: sin un listener activo, la
// primera pasada de la transaccion ve null (get() no alimenta esa cache) y la
// union aborta con "La sala no existe" sin reintentar.
function primeRoomCache(code) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const off = onValue(roomRef(code), () => { off(); finish(); }, () => finish());
    } catch {
      finish();
    }
    setTimeout(finish, 3000);
  });
}

function clearLocalRoom() {
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
  State = null;
  Me.isHost = false;
  Me.roomCode = null;
  Me.roomRoot = ROOM_ROOT;
  window.__guessDraft = 0;
  window.__guessDraftRound = null;
  $('#overlay-reveal').classList.add('hidden');
  $('#overlay-gameover').classList.add('hidden');
  showScreen('#screen-menu');
}

function isPermissionError(error) {
  const msg = String(error?.code || error?.message || error || '').toLowerCase();
  return msg.includes('permission') || msg.includes('denied') || msg.includes('permission_denied');
}

async function findExistingRoom(code) {
  let sawPermissionError = false;
  for (const root of ROOM_ROOT_CANDIDATES) {
    try {
      const snapshot = await get(roomRefAt(root, code));
      if (snapshot.exists()) {
        return { root, snapshot };
      }
    } catch (error) {
      if (isPermissionError(error)) sawPermissionError = true;
      console.warn('Mentiroso findExistingRoom error', root, error);
    }
  }
  return sawPermissionError ? { permissionDenied: true } : null;
}

async function mutateRoom(code, mutator) {
  if (!hasFirebase()) {
    return { ok: false, reason: 'Firebase no esta disponible.' };
  }
  let failureReason = null;
  let result;
  try {
    result = await runTransaction(roomRef(code), (current) => {
      if (!current) {
        failureReason = 'La sala no existe.';
        return;
      }
      const next = normalizeStateFromFirebase(current);
      const outcome = mutator(next);
      if (outcome && outcome.ok === false) {
        failureReason = outcome.reason || 'No se pudo aplicar el cambio.';
        return;
      }
      stampState(next);
      return serializeStateForFirebase(next);
    }, { applyLocally: false });
  } catch (error) {
    console.warn('Mentiroso mutateRoom error', error);
    return { ok: false, reason: 'Error al guardar la sala.' };
  }

  if (!result.committed) {
    return { ok: false, reason: failureReason || 'No se pudo guardar el cambio.' };
  }
  return { ok: true, state: result.snapshot.val() };
}

async function createRoomOnline() {
  if (!hasFirebase()) {
    toast('Firebase no se ha cargado bien.', 'error');
    return;
  }
  const name = ($('#create-name').value || '').trim();
  if (!name) {
    toast('Escribe tu nombre', 'error');
    return;
  }

  const selected = $('.mode-opt.active');
  const mode = selected ? selected.dataset.mode : 'easy';

  Me.name = name.slice(0, 16);
  Me.roomRoot = ROOM_ROOT;
  let code = '';
  let created = false;

  try {
    for (let attempt = 0; attempt < 12 && !created; attempt++) {
      code = genCode();
      const existing = await get(roomRefAt(ROOM_ROOT, code));
      if (existing.exists()) continue;
      await set(roomRefAt(ROOM_ROOT, code), createInitialState(code, mode, Me.name));
      created = true;
    }
  } catch (error) {
    console.warn('Mentiroso createRoomOnline error', error);
    toast(error?.message || 'No se pudo crear la sala.', 'error');
    return;
  }

  if (!created) {
    toast('No he podido crear la sala.', 'error');
    return;
  }

  Me.roomCode = code;

  // Comprueba que la sala se puede LEER, no solo escribir. Si las reglas de
  // Firebase permiten escritura pero bloquean lectura, el host veria su propio
  // lobby (cache local) pero nadie podria unirse. Lo detectamos aqui.
  try {
    const check = await get(roomRefAt(ROOM_ROOT, code));
    if (!check.exists()) {
      toast('Sala creada pero no se puede leer. Revisa las reglas de Firebase.', 'error');
    }
  } catch (error) {
    if (isPermissionError(error)) {
      toast('Reglas de Firebase bloquean la lectura: nadie podra unirse.', 'error');
    }
    console.warn('Mentiroso readback error', error);
  }

  subscribeToRoom(code);
}

async function joinRoomOnline() {
  if (!hasFirebase()) {
    toast('Firebase no se ha cargado bien.', 'error');
    return;
  }
  const name = ($('#join-name').value || '').trim();
  const code = ($('#join-code').value || '').trim().toUpperCase();

  if (!name) {
    toast('Escribe tu nombre', 'error');
    return;
  }
  if (code.length < 4) {
    toast('Codigo invalido', 'error');
    return;
  }

  let existing;
  try {
    existing = await findExistingRoom(code);
  } catch (error) {
    console.warn('Mentiroso joinRoomOnline error', error);
    $('#join-error').textContent = 'Error conectando con la sala.';
    $('#join-error').classList.remove('hidden');
    return;
  }
  if (existing && existing.permissionDenied) {
    $('#join-error').textContent = 'Permiso denegado por Firebase. Hay que abrir las reglas de lectura de la base de datos.';
    $('#join-error').classList.remove('hidden');
    return;
  }
  if (!existing || !existing.snapshot || !existing.snapshot.exists()) {
    $('#join-error').textContent = 'Sala no encontrada.';
    $('#join-error').classList.remove('hidden');
    return;
  }
  if (existing.snapshot.val()?.game !== 'mentiroso') {
    $('#join-error').textContent = 'Ese codigo pertenece a otro juego.';
    $('#join-error').classList.remove('hidden');
    return;
  }

  Me.name = name.slice(0, 16);
  Me.roomCode = code;
  Me.roomRoot = existing.root;

  // Sincroniza la sala y espera el primer dato del servidor ANTES de la
  // transaccion, para que runTransaction vea la sala real en su primera pasada.
  subscribeToRoom(code);
  await primeRoomCache(code);

  const joinMutator = (state) => {
    if (state.phase !== 'lobby') return { ok: false, reason: 'La partida ya ha empezado.' };
    if (state.players.length >= 8) return { ok: false, reason: 'Sala llena.' };
    if (state.players.some((player) => player.id === Me.clientId)) return { ok: false, reason: 'Ya estas dentro.' };
    if (!Array.isArray(state.playerOrder)) state.playerOrder = state.players.map((player) => player.id);
    state.players.push({
      id: Me.clientId,
      name: Me.name,
      isHost: false,
      score: 0,
      lastGuess: null,
      cardsCount: 0
    });
    state.playerOrder.push(Me.clientId);
    return { ok: true };
  };

  let joined = await mutateRoom(code, joinMutator);
  // Red de seguridad: si la transaccion vio la sala como inexistente por una
  // lectura aun no sincronizada, reintenta una vez tras un breve respiro.
  if (!joined.ok && /no existe/i.test(joined.reason || '')) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    joined = await mutateRoom(code, joinMutator);
  }

  if (!joined.ok) {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    State = null;
    Me.roomCode = null;
    Me.roomRoot = ROOM_ROOT;
    showScreen('#screen-menu');
    $('#join-error').textContent = joined.reason;
    $('#join-error').classList.remove('hidden');
    return;
  }
}

async function updateHostPointsSetting(nextValue) {
  if (!State || !Me.isHost) return;
  const safeValue = normalizePointsToWin(nextValue);
  const result = await mutateRoom(State.code, (state) => {
    if (state.phase !== 'lobby') return { ok: false, reason: 'La partida ya ha empezado.' };
    if (state.hostId !== Me.clientId) return { ok: false, reason: 'Solo el host puede cambiarlo.' };
    state.pointsToWin = safeValue;
    return { ok: true };
  });
  if (!result.ok) toast(result.reason, 'error');
}

async function startGameOnline() {
  if (!State || !Me.isHost) return;
  const result = await mutateRoom(State.code, (state) => {
    if (state.phase !== 'lobby') return { ok: false, reason: 'La partida ya esta empezada.' };
    if (state.hostId !== Me.clientId) return { ok: false, reason: 'Solo el host puede iniciar.' };
    if (state.players.length < 2) return { ok: false, reason: 'Se necesitan al menos 2 jugadores.' };
    state.players.forEach((player) => {
      player.score = 0;
      player.lastGuess = null;
    });
    state.winner = null;
    state.pendingWinner = null;
    initRound(state, 1, 0);
    return { ok: true };
  });
  if (!result.ok) toast(result.reason, 'error');
}

async function submitGuessOnline(guess) {
  if (!State) return;
  const result = await mutateRoom(State.code, (state) => submitGuess(state, Me.clientId, guess));
  if (!result.ok) toast(result.reason, 'error');
}

async function continueRoundOnline() {
  if (!State || !Me.isHost) return;
  const result = await mutateRoom(State.code, (state) => {
    if (state.hostId !== Me.clientId) return { ok: false, reason: 'Solo el host puede continuar.' };
    continueAfterReveal(state);
    return { ok: true };
  });
  if (!result.ok) toast(result.reason, 'error');
}

async function leaveRoomOnline() {
  if (!Me.roomCode) {
    clearLocalRoom();
    return;
  }

  const currentCode = Me.roomCode;
  await runTransaction(roomRef(currentCode), (current) => {
    if (!current) return current;
    const next = deepClone(current);
    removePlayerFromState(next, Me.clientId);
    if (next.players.length === 0) return null;
    stampState(next);
    return next;
  }, { applyLocally: false }).catch((error) => {
    console.warn('Mentiroso leaveRoomOnline error', error);
  });

  clearLocalRoom();
}

function render() {
  if (!State) {
    showScreen('#screen-menu');
    return;
  }

  if (State.phase === 'lobby') return renderLobby();
  if (State.phase === 'playing') return renderGame();
  if (State.phase === 'reveal') return renderGameWithReveal();
  if (State.phase === 'gameover') return renderGameOver();
}

function setPointsDraft(value) {
  const nextValue = normalizePointsToWin(value);
  POINTS_LIMIT.value = nextValue;
  $('#create-points-value').textContent = String(nextValue);
}

function updateLobbyPointsControls() {
  if (!State) return;
  $('#lobby-points-value').textContent = String(State.pointsToWin);
  $('#lobby-points-value-readonly').textContent = String(State.pointsToWin);

  if (Me.isHost && State.phase === 'lobby') {
    $('#lobby-points-controls').classList.remove('hidden');
    $('#lobby-points-readonly').classList.add('hidden');
  } else {
    $('#lobby-points-controls').classList.add('hidden');
    $('#lobby-points-readonly').classList.remove('hidden');
  }
}

function renderLobby() {
  showScreen('#screen-lobby');
  $('#overlay-reveal').classList.add('hidden');
  $('#overlay-gameover').classList.add('hidden');

  $('#lobby-code').textContent = State.code;
  $('#lobby-mode-pill').textContent = State.mode === 'easy' ? 'FACIL' : 'DIFICIL';
  $('#lobby-count').textContent = `(${State.players.length})`;

  const playersEl = $('#lobby-players');
  playersEl.innerHTML = '';
  State.players.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'lobby-player-row' + (player.id === Me.clientId ? ' me' : '');
    row.innerHTML = `
      <div class="lobby-player-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</div>
      <div class="lobby-player-name">${escapeHtml(player.name)}${player.id === Me.clientId ? ' (tu)' : ''}</div>
      ${player.isHost ? '<div class="lobby-player-host">HOST</div>' : ''}
    `;
    playersEl.appendChild(row);
  });

  updateLobbyPointsControls();
  $('#btn-start').disabled = !(Me.isHost && State.players.length >= 2);

  const hint = $('#lobby-hint');
  if (!Me.isHost) {
    hint.textContent = 'Esperando a que el host inicie la partida.';
  } else if (State.players.length < 2) {
    hint.textContent = 'Se necesitan al menos 2 jugadores.';
  } else {
    hint.textContent = `La partida se gana al llegar a ${State.pointsToWin} rondas acertadas.`;
  }
}

function renderGuessSummary() {
  const list = State.players
    .map((player) => {
      const guess = State.round.guesses[player.id];
      if (guess === undefined) {
        return `<div class="guess-row waiting"><span>${escapeHtml(player.name)}</span><span>...</span></div>`;
      }
      return `<div class="guess-row"><span>${escapeHtml(player.name)}</span><span>${guess}</span></div>`;
    })
    .join('');

  return list || '<div class="guess-row waiting"><span>Sin apuestas aun</span><span>...</span></div>';
}

function renderGame() {
  showScreen('#screen-game');
  $('#overlay-reveal').classList.add('hidden');
  $('#overlay-gameover').classList.add('hidden');
  renderGameCommon();
  renderActionBar();
}

function renderGameWithReveal() {
  showScreen('#screen-game');
  renderGameCommon();
  renderActionBar();
  renderRevealOverlay();
}

function renderGameCommon() {
  $('#game-round').textContent = String(State.round.number);
  $('#game-round-stat').textContent = State.round.promptLabel.toUpperCase();
  $('#game-code').textContent = State.code;

  const ring = $('#turn-ring');
  ring.innerHTML = '';
  State.players.forEach((player, index) => {
    const chip = document.createElement('div');
    const classes = ['turn-chip'];
    if (State.phase === 'playing' && index === State.round.turnIdx) classes.push('active');
    if (player.id === Me.clientId) classes.push('me');
    chip.className = classes.join(' ');
    const guessed = State.round.guesses[player.id];
    chip.innerHTML = `
      <span>${escapeHtml(player.name)}${player.id === Me.clientId ? ' (tu)' : ''}</span>
      <span class="tc-count">${player.score} pt</span>
      <span class="tc-guess">${guessed === undefined ? 'sin apuesta' : `dice ${guessed}`}</span>
    `;
    ring.appendChild(chip);
  });

  const centerEl = $('#center-cards');
  centerEl.innerHTML = '';
  if (State.centerCards.length === 0) {
    centerEl.innerHTML = '<div class="empty-inline">Sin cartas en el centro</div>';
  } else {
    State.centerCards.forEach((card) => centerEl.appendChild(renderCard(card, { mode: 'center' })));
  }

  $('#bet-round-note').textContent = `Objetivo: ${State.pointsToWin} puntos`;
  $('#bet-current').innerHTML = renderGuessSummary();

  const myHandEl = $('#my-hand');
  myHandEl.innerHTML = '';
  const myHand = State.hands[Me.clientId] || [];
  myHand.forEach((card) => {
    myHandEl.appendChild(renderCard(card, {
      mode: State.mode === 'easy' ? 'own-easy' : 'own-hard',
      round: State.round
    }));
  });
  $('#my-hand-note').textContent = State.mode === 'easy'
    ? 'Verde = esta carta cumple la condicion de la ronda'
    : 'Solo ves el nombre y los rasgos visibles';
}

function renderActionBar() {
  const panel = $('#action-panel');
  const waiting = $('#action-waiting');
  const me = State.players.find((player) => player.id === Me.clientId);
  const isMyTurn = State.phase === 'playing' && State.players[State.round.turnIdx]?.id === Me.clientId;

  if (!isMyTurn) {
    panel.classList.add('hidden');
    waiting.classList.remove('hidden');
    const label = waiting.querySelector('.action-panel-label');
    if (State.phase === 'reveal') {
      label.textContent = 'REVELANDO RESULTADOS...';
    } else if (State.phase === 'gameover') {
      label.textContent = 'PARTIDA TERMINADA';
    } else {
      const current = State.players[State.round.turnIdx];
      label.textContent = current ? `ESPERANDO A ${current.name.toUpperCase()}...` : 'ESPERANDO...';
    }
    return;
  }

  panel.classList.remove('hidden');
  waiting.classList.add('hidden');

  const maxGuess = totalCardsInPlay(State);
  if (window.__guessDraftRound !== State.round.number) {
    window.__guessDraftRound = State.round.number;
    window.__guessDraft = 0;
  }
  window.__guessDraft = Math.max(0, Math.min(maxGuess, Number(window.__guessDraft || 0)));

  $('#step-guess').textContent = String(window.__guessDraft);
  $('#guess-max').textContent = String(maxGuess);
  $('#guess-minus').disabled = window.__guessDraft <= 0;
  $('#guess-plus').disabled = window.__guessDraft >= maxGuess;
  $('#action-panel-label').textContent = `${escapeHtml(me.name).toUpperCase()} · ADIVINA EL TOTAL EXACTO`;
}

function renderCard(card, opts) {
  const el = document.createElement('div');
  el.className = 'card';
  const { mode, round } = opts;

  let heroContent = '';
  let heroLabel = '';
  if (mode === 'center') {
    el.classList.add('center');
    if (card.visibleAttr === 'flag') {
      heroContent = card.countryFlag;
      heroLabel = card.country;
    } else if (card.visibleAttr === 'position') {
      heroContent = card.position;
      heroLabel = 'posicion';
    } else {
      heroContent = card.clubBadge;
      heroLabel = card.club;
    }
  } else {
    heroContent = card.countryFlag;
    heroLabel = card.position;
  }

  const nameHtml = mode === 'center' ? '' : `<div class="card-name">${escapeHtml(card.playerName)}</div>`;

  let statHtml = '';
  if (mode === 'own-easy') {
    const rawValue = card.stats[round.stat.key];
    const displayValue = round.stat.type === 'bool' ? (rawValue ? 'SI' : 'NO') : rawValue;
    statHtml = `
      <div class="card-stat">
        <span>${escapeHtml(round.stat.type === 'bool' ? round.stat.label : round.stat.unit)}</span>
        <span class="card-stat-val">${escapeHtml(displayValue)}</span>
      </div>
    `;
    const badge = document.createElement('div');
    badge.className = 'card-badge ' + (cardMatchesRound(card, round) ? 'ok' : 'ko');
    badge.textContent = cardMatchesRound(card, round) ? 'OK' : 'NO';
    el.appendChild(badge);
  } else if (mode === 'own-hard' || mode === 'center') {
    statHtml = '<div class="card-stat hidden-stat">oculto</div>';
  } else if (mode === 'reveal') {
    const rawValue = card.stats[round.stat.key];
    const displayValue = round.stat.type === 'bool' ? (rawValue ? 'SI' : 'NO') : rawValue;
    statHtml = `
      <div class="card-stat">
        <span>${escapeHtml(round.stat.type === 'bool' ? round.stat.label : round.stat.unit)}</span>
        <span class="card-stat-val">${escapeHtml(displayValue)}</span>
      </div>
    `;
    el.classList.add('revealed');
    el.classList.add(card.matches ? 'match' : 'nomatch');
  }

  el.innerHTML += `
    <div class="card-kicker">${escapeHtml(mode === 'center' ? 'CENTRO' : card.position)}</div>
    ${nameHtml}
    <div class="card-hero">${heroContent}</div>
    <div class="card-hero-label">${escapeHtml(heroLabel)}</div>
    ${statHtml}
  `;
  return el;
}

function renderRevealOverlay() {
  const reveal = State.reveal;
  if (!reveal) return;

  $('#overlay-reveal').classList.remove('hidden');
  $('#reveal-tag').textContent = reveal.winnerNames.length ? 'ACIERTO EXACTO' : 'SIN PUNTO';
  $('#reveal-headline').textContent = reveal.promptLabel;
  $('#reveal-sub').textContent = reveal.winnerNames.length
    ? `Puntuan: ${reveal.winnerNames.join(', ')}`
    : 'Nadie ha clavado el total exacto.';
  $('#reveal-count').textContent = String(reveal.actualTotal);

  $('#reveal-guesses').innerHTML = reveal.guesses.map((entry) => {
    const hit = entry.guess === reveal.actualTotal;
    return `
      <div class="reveal-guess ${hit ? 'hit' : ''}">
        <span>${escapeHtml(entry.name)}</span>
        <strong>${entry.guess}</strong>
      </div>
    `;
  }).join('');

  const cardsEl = $('#reveal-cards');
  cardsEl.innerHTML = '';
  reveal.cards.forEach((card, index) => {
    const el = renderCard(card, { mode: 'reveal', round: reveal });
    el.style.animationDelay = `${index * 0.04}s`;
    cardsEl.appendChild(el);
  });

  const verdict = $('#reveal-verdict');
  if (reveal.winnerNames.length) {
    verdict.className = 'reveal-verdict win';
    verdict.textContent = reveal.winnerIds.includes(Me.clientId)
      ? 'Has acertado exacto y sumas 1 punto.'
      : `${reveal.winnerNames.join(', ')} suma 1 punto.`;
  } else {
    verdict.className = 'reveal-verdict neutral';
    verdict.textContent = 'Nadie suma en esta ronda.';
  }

  const continueBtn = $('#btn-continue');
  continueBtn.classList.remove('hidden');
  continueBtn.disabled = !Me.isHost;
  continueBtn.textContent = Me.isHost ? 'SIGUIENTE RONDA' : 'ESPERANDO AL HOST...';
}

function renderGameOver() {
  showScreen('#screen-game');
  renderGameCommon();
  $('#overlay-reveal').classList.add('hidden');
  $('#action-panel').classList.add('hidden');
  $('#action-waiting').classList.remove('hidden');
  $('#action-waiting .action-panel-label').textContent = 'PARTIDA TERMINADA';

  $('#overlay-gameover').classList.remove('hidden');
  $('#winner-name').textContent = State.winner ? `${State.winner.name.toUpperCase()} · ${State.winner.score} PT` : '-';
  $('#winner-scoreboard').innerHTML = State.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((player) => `
      <div class="reveal-guess ${player.id === State.winner?.id ? 'hit' : ''}">
        <span>${escapeHtml(player.name)}</span>
        <strong>${player.score}</strong>
      </div>
    `)
    .join('');
}

$$('.menu-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.menu-tab').forEach((item) => item.classList.remove('active'));
    $$('.menu-panel').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    $(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    $('#join-error').classList.add('hidden');
  });
});

$$('.mode-opt').forEach((option) => {
  option.addEventListener('click', () => {
    $$('.mode-opt').forEach((item) => item.classList.remove('active'));
    option.classList.add('active');
  });
});

$('#btn-points-minus').addEventListener('click', () => setPointsDraft(POINTS_LIMIT.value - 1));
$('#btn-points-plus').addEventListener('click', () => setPointsDraft(POINTS_LIMIT.value + 1));
$('#btn-lobby-points-minus').addEventListener('click', () => updateHostPointsSetting(State.pointsToWin - 1));
$('#btn-lobby-points-plus').addEventListener('click', () => updateHostPointsSetting(State.pointsToWin + 1));
$('#btn-create').addEventListener('click', () => createRoomOnline());
$('#btn-join').addEventListener('click', () => joinRoomOnline());

$('#btn-copy-code').addEventListener('click', async () => {
  if (!State) return;
  try {
    await navigator.clipboard.writeText(State.code);
    toast('Codigo copiado', 'success');
  } catch {
    toast(State.code, 'success');
  }
});

$('#btn-start').addEventListener('click', () => startGameOnline());
$$('[data-action="leave-lobby"]').forEach((button) => {
  button.addEventListener('click', async () => {
    await leaveRoomOnline();
  });
});

$('#guess-minus').addEventListener('click', () => {
  if (!State || State.phase !== 'playing') return;
  window.__guessDraft = Math.max(0, Number(window.__guessDraft || 0) - 1);
  renderActionBar();
});

$('#guess-plus').addEventListener('click', () => {
  if (!State || State.phase !== 'playing') return;
  window.__guessDraft = Math.min(totalCardsInPlay(State), Number(window.__guessDraft || 0) + 1);
  renderActionBar();
});

$('#btn-guess').addEventListener('click', () => {
  if (!State) return;
  submitGuessOnline(Number(window.__guessDraft || 0));
});

$('#btn-continue').addEventListener('click', () => continueRoundOnline());
$('#btn-menu').addEventListener('click', async () => {
  await leaveRoomOnline();
});

window.addEventListener('beforeunload', () => {
  if (!State || !Me.roomCode) return;
  runTransaction(roomRef(Me.roomCode), (current) => {
    if (!current) return current;
    const next = deepClone(current);
    removePlayerFromState(next, Me.clientId);
    if (next.players.length === 0) return null;
    stampState(next);
    return next;
  }, { applyLocally: false }).catch(() => {});
});

function boot() {
  if (!hasFirebase()) {
    console.warn('Mentiroso Firebase bootstrap missing', window._FB);
  }
  if (!window.PLAYERS || !Array.isArray(window.PLAYERS) || window.PLAYERS.length < 3) {
    toast('Faltan datos de jugadores', 'error');
  }
  setPointsDraft(POINTS_LIMIT.value);
  showScreen('#screen-menu');
}

boot();
