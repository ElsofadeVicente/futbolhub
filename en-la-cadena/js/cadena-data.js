/* =============================================
   CADENA-DATA.JS
   Carga de datos, búsqueda y validación de la
   cadena Jugador ↔ Equipo
   ============================================= */

const CadenaData = (() => {

  /* ── Estado interno ── */
  let nameIndex   = null;  // [[id, name], ...]
  let teamNames   = null;  // [string, ...]
  let playerCache = {};    // { id: playerData }
  let chunkCache  = {};    // { chunkFile: chunkData }

  let selectedSuggestion = null;  // ítem seleccionado del autocomplete
  let suggestionItems    = [];
  let suggestionIndex    = -1;

  /* ── Normalización ── */
  const norm = s =>
    s.toLowerCase()
     .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
     .replace(/[^a-z0-9 ]/g, ' ')
     .replace(/\s+/g, ' ')
     .trim();

  /* ── Chunk helpers ── */
  const RANGES = [
    [0,99999],[100000,199999],[200000,299999],[300000,399999],[400000,499999],
    [500000,599999],[600000,699999],[700000,799999],[800000,899999],[900000,999999],
    [1000000,1099999],[1100000,1199999],[1200000,1299999],[1300000,1399999],[1400000,1499999]
  ];
  function chunkFile(id) {
    id = parseInt(id);
    const r = RANGES.find(([lo, hi]) => id >= lo && id <= hi);
    return r ? `${r[0]}-${r[1]}.json` : null;
  }

  async function loadPlayerChunk(cf) {
    if (chunkCache[cf]) return chunkCache[cf];
    const res = await fetch(`../data/players/chunks/${cf}`);
    if (!res.ok) throw new Error(`Chunk ${cf}: HTTP ${res.status}`);
    const data = await res.json();
    chunkCache[cf] = data;
    return data;
  }

  async function getPlayerById(id) {
    const sid = String(id);
    if (playerCache[sid]) return playerCache[sid];
    const cf = chunkFile(id);
    if (!cf) return null;
    const chunk = await loadPlayerChunk(cf);
    if (chunk[sid]) playerCache[sid] = chunk[sid];
    return chunk[sid] || null;
  }

  /* ── Inicialización: carga índices ── */
  async function init() {
    const [ni, tn] = await Promise.all([
      fetch('../data/players/name-index.json').then(r => r.json()),
      fetch('../data/teams/team-names.json').then(r => r.json())
    ]);
    nameIndex = ni;
    teamNames = tn;
    console.log(`✅ CadenaData: ${nameIndex.length.toLocaleString()} jugadores, ${teamNames.length.toLocaleString()} equipos`);
  }

  /* ── Autocomplete ── */
  let _debounceTimer = null;

  function onInput(value) {
    clearTimeout(_debounceTimer);
    selectedSuggestion = null;

    if (!value || value.length < 2) {
      closeSuggestions();
      return;
    }
    _debounceTimer = setTimeout(() => buildSuggestions(value), 150);
  }

  function buildSuggestions(query) {
    if (!nameIndex || !teamNames) return;
    const q = norm(query);
    const type = CadenaGame.getCurrentTurnType();
    let results = [];

    if (type === 'player') {
      // Buscar en el índice de nombres
      let exact = [], starts = [], contains = [];
      for (const [id, name] of nameIndex) {
        const n = norm(name);
        if (n === q)              exact.push([id, name]);
        else if (n.startsWith(q)) starts.push([id, name]);
        else if (n.includes(q))   contains.push([id, name]);
        if (exact.length + starts.length + contains.length >= 30) break;
      }
      results = [...exact, ...starts, ...contains].slice(0, 8);
      results = results.map(([id, name]) => ({ type: 'player', id, name }));
    } else {
      // Buscar en lista de equipos
      let exact = [], starts = [], contains = [];
      for (const t of teamNames) {
        const n = norm(t);
        if (n === q)              exact.push(t);
        else if (n.startsWith(q)) starts.push(t);
        else if (n.includes(q))   contains.push(t);
        if (exact.length + starts.length + contains.length >= 30) break;
      }
      results = [...exact, ...starts, ...contains].slice(0, 8);
      results = results.map(name => ({ type: 'team', name }));
    }

    renderSuggestions(results, query);
  }

  function highlightMatch(name, query) {
    const q = norm(query);
    const n = norm(name);
    const idx = n.indexOf(q);
    if (idx === -1) return name;
    const before = name.slice(0, idx);
    const match  = name.slice(idx, idx + query.length);
    const after  = name.slice(idx + query.length);
    return `${before}<span class="sug-highlight">${match}</span>${after}`;
  }

  function renderSuggestions(items, query) {
    const box = document.getElementById('suggestions');
    if (!items.length) { closeSuggestions(); return; }

    suggestionItems = items;
    suggestionIndex = -1;

    box.innerHTML = items.map((item, i) => {
      const icon = item.type === 'player' ? '⚽' : '🏟️';
      const meta = item.type === 'player' ? `#${item.id}` : '';
      return `<div class="suggestion-item" data-index="${i}"
                onclick="CadenaData.selectSuggestion(${i})">
        <span class="sug-icon">${icon}</span>
        <span class="sug-name">${highlightMatch(item.name, query)}</span>
        <span class="sug-meta">${meta}</span>
      </div>`;
    }).join('');

    box.classList.add('open');
  }

  function closeSuggestions() {
    const box = document.getElementById('suggestions');
    box.classList.remove('open');
    box.innerHTML = '';
    suggestionItems = [];
    suggestionIndex = -1;
  }

  function selectSuggestion(index) {
    if (index < 0 || index >= suggestionItems.length) return;
    selectedSuggestion = suggestionItems[index];
    document.getElementById('answer-input').value = selectedSuggestion.name;
    closeSuggestions();
  }

  function onKeyDown(e) {
    const box = document.getElementById('suggestions');
    const isOpen = box.classList.contains('open');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) return;
      suggestionIndex = Math.min(suggestionIndex + 1, suggestionItems.length - 1);
      updateSuggestionHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) return;
      suggestionIndex = Math.max(suggestionIndex - 1, -1);
      updateSuggestionHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && suggestionIndex >= 0) {
        selectSuggestion(suggestionIndex);
      } else {
        submitAnswer();
      }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  }

  function updateSuggestionHighlight() {
    const items = document.querySelectorAll('.suggestion-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === suggestionIndex));
    if (suggestionIndex >= 0 && items[suggestionIndex]) {
      items[suggestionIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  /* ── Validación ── */

  /**
   * Valida si un jugador (por ID) jugó en el equipo dado.
   * Retorna { valid, playerData, reason }
   */
  async function validatePlayer(playerId, requiredTeam) {
    const player = await getPlayerById(playerId);
    if (!player) return { valid: false, reason: 'Jugador no encontrado en la base de datos.' };

    if (!requiredTeam) {
      // Primera jugada: cualquier jugador válido
      return { valid: true, playerData: player };
    }

    const qt = norm(requiredTeam);
    const played = (player.teams || []).some(t => norm(t) === qt);

    if (!played) {
      const teamList = (player.teams || []).slice(0, 4).join(', ');
      return {
        valid: false,
        reason: `${player.n} no jugó en ${requiredTeam}. Sus equipos: ${teamList}…`
      };
    }
    return { valid: true, playerData: player };
  }

  /**
   * Valida si un equipo es válido para el jugador dado.
   * Retorna { valid, reason, isOneClubMan }
   */
  function validateTeam(teamName, playerData, previousTeam) {
    const qt = norm(teamName);
    const teams = playerData.teams || [];

    // ¿El jugador jugó en este equipo?
    const played = teams.some(t => norm(t) === qt);
    if (!played) {
      const teamList = teams.slice(0, 4).join(', ');
      return {
        valid: false,
        reason: `${playerData.n} no jugó en ${teamName}. Sus equipos: ${teamList}…`
      };
    }

    // One-club man: solo jugó en un equipo → puede repetir
    const isOneClubMan = teams.length === 1;

    // ¿Repite el equipo anterior?
    if (previousTeam && !isOneClubMan && norm(teamName) === norm(previousTeam)) {
      return {
        valid: false,
        reason: `¡No puedes repetir el equipo anterior (${previousTeam})!`
      };
    }

    return { valid: true, isOneClubMan };
  }

  /* ── Submit answer (entrada pública) ── */
  async function submitAnswer() {
    const input = document.getElementById('answer-input');
    const value = (input.value || '').trim();
    if (!value) return;

    // Disable input mientras validamos
    input.disabled = true;
    document.querySelector('.submit-btn').disabled = true;

    const type = CadenaGame.getCurrentTurnType();
    const state = CadenaGame.getState();

    try {
      if (type === 'player') {
        // Buscar el jugador: primero en selectedSuggestion, si no por nombre en índice
        let playerId   = selectedSuggestion?.id;
        let playerName = selectedSuggestion?.name || value;

        if (!playerId) {
          // Buscar por nombre normalizado
          const q = norm(value);
          const found = nameIndex.find(([id, n]) => norm(n) === q);
          if (!found) {
            App.showToast(`"${value}" no está en la base de datos`, 'error');
            resetInput(input);
            return;
          }
          playerId   = found[0];
          playerName = found[1];
        }

        const lastTeam = state.chain.length > 0 ? state.chain[state.chain.length - 1].value : null;
        const { valid, playerData, reason } = await validatePlayer(playerId, lastTeam);

        if (!valid) {
          App.showToast(reason, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'player');
          resetInput(input);
          return;
        }

        CadenaGame.addToChain({ type: 'player', id: playerId, name: playerName, data: playerData });

      } else {
        // Validar equipo
        const lastEntry   = state.chain[state.chain.length - 1];  // jugador anterior
        const prevTeam    = state.chain.length >= 2 ? state.chain[state.chain.length - 2].value : null;

        let teamName = selectedSuggestion?.name || value;
        // Normalizar al nombre canónico del índice (si existe)
        const q = norm(teamName);
        const canonical = teamNames.find(t => norm(t) === q);
        if (!canonical) {
          App.showToast(`"${teamName}" no está en la base de datos`, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'team');
          resetInput(input);
          return;
        }
        teamName = canonical;

        const { valid, reason, isOneClubMan } = validateTeam(teamName, lastEntry.data, prevTeam);

        if (!valid) {
          App.showToast(reason, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'team');
          resetInput(input);
          return;
        }

        CadenaGame.addToChain({ type: 'team', value: teamName, isOneClubMan });
      }
    } catch (err) {
      console.error('Error validando:', err);
      App.showToast('Error al validar. Inténtalo de nuevo.', 'error');
      resetInput(input);
    }
  }

  function resetInput(input) {
    input.disabled = false;
    input.value = '';
    selectedSuggestion = null;
    document.querySelector('.submit-btn').disabled = false;
    input.focus();
  }

  /* ── API pública ── */
  return { init, onInput, onKeyDown, selectSuggestion, submitAnswer, closeSuggestions, getPlayerById };

})();
