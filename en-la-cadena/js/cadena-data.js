/* =============================================
   CADENA-DATA.JS
   Carga de datos, búsqueda y validación de la
   cadena Jugador ↔ Equipo
   ============================================= */

const CadenaData = (() => {

  /* ── Estado interno ── */
  let nameIndex        = null;  // [[id, name], ...]
  let teamNames        = null;  // [string, ...]
  let teamLeaguePrio   = null;  // { teamName: priorityNumber } (1=LaLiga … 12=Argentina, 999=sin liga)
  let playerCache      = {};    // { id: playerData }
  let chunkCache       = {};    // { chunkFile: chunkData }

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
    // Guard: no recargar si ya está inicializado
    if (nameIndex && teamNames) return;

    // Cargar los tres ficheros en paralelo
    const [ni, tn, leagueData] = await Promise.all([
      fetch('../data/players/name-index.json').then(r => r.json()),
      fetch('../data/teams/team-names.json').then(r => r.json()),
      fetch('../data/teams/league-teams.json').then(r => r.json()).catch(() => null),
    ]);
    nameIndex = ni;
    teamNames = tn;

    teamLeaguePrio = {};
    if (leagueData) {
      for (const league of leagueData.leagues) {
        for (const teamName of league.teams) {
          // Usar nombre normalizado como clave; si el equipo ya aparece en una
          // liga de mayor prioridad (número más bajo), no sobreescribir.
          const key = norm(teamName);
          if (teamLeaguePrio[key] === undefined || league.priority < teamLeaguePrio[key]) {
            teamLeaguePrio[key] = league.priority;
          }
        }
      }
    } else {
      console.warn('⚠️ league-teams.json no disponible, sin prioridad de ligas');
    }

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

  // Comprueba si la query coincide con el inicio de alguna palabra del nombre
  function wordBoundaryMatch(n, q) {
    // n y q ya están normalizados
    const words = n.split(' ');
    // q puede ser varias palabras (ej: "boca juniors") → buscar subcadena que empiece en límite de palabra
    for (let i = 0; i < words.length; i++) {
      const fromWord = words.slice(i).join(' ');
      if (fromWord.startsWith(q)) return true;
    }
    return false;
  }

  // Traducciones cortas de posición
  const POS_LABEL = { GK: 'Portero', DEF: 'Defensa', MID: 'Centrocampista', FWD: 'Delantero' };

  async function buildSuggestions(query) {
    if (!nameIndex || !teamNames) return;
    const q = norm(query);
    const type = CadenaGame.getCurrentTurnType();
    let results = [];

    if (type === 'player') {
      // Recoger candidatos por categoría sin límite fijo por categoría,
      // para no perder jugadores famosos que estén más adelante en el índice.
      // Sí ponemos un tope por categoría para evitar queries muy genéricas ("a"):
      //   exact: sin límite  |  starts: 300  |  wordBound: 150  |  contains: 80
      let exact = [], starts = [], wordBound = [], contains = [];
      for (const [id, name] of nameIndex) {
        const n = norm(name);
        if      (n === q)                                          exact.push([id, name]);
        else if (n.startsWith(q)          && starts.length   < 300) starts.push([id, name]);
        else if (wordBoundaryMatch(n, q)  && wordBound.length < 150) wordBound.push([id, name]);
        else if (n.includes(q)            && contains.length  <  80) contains.push([id, name]);
        // Parar solo cuando todas las categorías están llenas
        if (starts.length >= 300 && wordBound.length >= 150 && contains.length >= 80) break;
      }

      // Taggear con categoría para mantener prioridad de relevancia
      const tagged = [
        ...exact.map(([id, name])     => ({ id, name, cat: 0 })),
        ...starts.map(([id, name])    => ({ id, name, cat: 1 })),
        ...wordBound.map(([id, name]) => ({ id, name, cat: 2 })),
        ...contains.map(([id, name])  => ({ id, name, cat: 3 })),
      ];

      // Mostrar una preview rápida mientras se cargan los datos
      renderSuggestions(
        tagged.slice(0, 8).map(({ id, name }) => ({ type: 'player', id, name })),
        query
      );

      // Cargar datos en paralelo — máx 300 para no saturar
      // (los chunks se cachean, así que el segundo render es casi instantáneo)
      const toLoad = tagged.slice(0, 300);
      const dataList = await Promise.all(toLoad.map(t => getPlayerById(t.id)));
      const itemsWithData = toLoad.map((t, i) => ({
        type: 'player', id: t.id, name: t.name, cat: t.cat, data: dataList[i]
      }));

      // Ordenar: categoría primero, luego apps DESC dentro de cada categoría
      itemsWithData.sort((a, b) => {
        if (a.cat !== b.cat) return a.cat - b.cat;
        return (b.data?.apps || 0) - (a.data?.apps || 0);
      });

      results = itemsWithData.slice(0, 8);

      // Calcular qué info mostrar para diferenciar jugadores con el mismo nombre
      const finalItems = results.map((item, _, arr) => {
        const d = item.data;
        if (!d) return item;

        const sameName = arr.filter(o => norm(o.name) === norm(item.name));

        let tags = [];

        // Siempre mostrar posición
        const posLabel = POS_LABEL[d.p] || d.p || '';
        if (posLabel) tags.push(posLabel);

        // Si hay otro jugador con mismo nombre Y misma posición → añadir nacionalidad
        if (sameName.length > 1) {
          const samePos = sameName.filter(o => o.data?.p === d.p);
          if (samePos.length > 1 && d.nat) {
            tags.push(d.nat);

            // Si además misma nacionalidad → añadir altura
            const sameNat = samePos.filter(o => o.data?.nat === d.nat);
            if (sameNat.length > 1 && d.h) {
              tags.push(d.h + ' cm');
            }
          }
        }

        return { ...item, disambig: tags.join(' · ') };
      });

      renderSuggestions(finalItems, query);

    } else {
      // Buscar en lista de equipos — escaneamos TODOS para no perdernos nada
      // Cada candidato recibe un código de categoría de match:
      //   0=exact  1=starts  2=wordBound  3=contains
      const candidates = [];
      for (const t of teamNames) {
        const n = norm(t);
        let cat;
        if      (n === q)                   cat = 0;
        else if (n.startsWith(q))           cat = 1;
        else if (wordBoundaryMatch(n, q))   cat = 2;
        else if (n.includes(q))             cat = 3;
        else continue;
        candidates.push({ t, cat });
      }

      // Ordenar en dos bloques:
      //   BLOQUE 1 — matches relevantes (exact/starts/wordBound, cat 0-2):
      //     dentro del bloque: liga primero, luego cat, luego popularidad DESC.
      //     Así "Le" → Leganés [LaLiga,word] y Lecce [SerieA,word] salen antes
      //     que Leyton Orient [desconocido,starts].
      //   BLOQUE 2 — matches "contains" (cat 3):
      //     solo por popularidad; nunca suben sobre el bloque 1.
      //     Así Valencia CF ("va-le-ncia") no ocupa sitios de Lecce o Leyton.
      candidates.sort((a, b) => {
        const aIsContains = a.cat === 3;
        const bIsContains = b.cat === 3;
        if (aIsContains !== bIsContains) return aIsContains ? 1 : -1;  // contains al final
        const prioA = teamLeaguePrio?.[norm(a.t)] ?? 999;
        const prioB = teamLeaguePrio?.[norm(b.t)] ?? 999;
        if (prioA !== prioB) return prioA - prioB;
        return a.cat - b.cat;
      });

      results = candidates.slice(0, 8).map(({ t }) => ({ type: 'team', name: t }));
      renderSuggestions(results, query);
    }
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
      const meta = item.type === 'player' ? (item.disambig || '') : '';
      return `<div class="suggestion-item" data-index="${i}"
                onclick="CadenaData.selectSuggestion(${i})">
        <span class="sug-icon">${icon}</span>
        <span class="sug-name">${highlightMatch(item.name, query)}</span>
        ${meta ? `<span class="sug-meta">${meta}</span>` : ''}
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
    // Auto-confirmar la selección directamente
    submitAnswer();
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

    // Si hay sugerencias visibles y no se ha seleccionado nada explícitamente,
    // usar la sugerencia resaltada o la primera disponible
    if (!selectedSuggestion && suggestionItems.length > 0) {
      const idx = suggestionIndex >= 0 ? suggestionIndex : 0;
      selectedSuggestion = suggestionItems[idx];
      input.value = selectedSuggestion.name;
      closeSuggestions();
    }

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

        // Comprobar que el jugador no ha aparecido ya en la cadena
        const alreadyInChain = state.chain.some(e => e.type === 'player' && e.id === playerId);
        if (alreadyInChain) {
          App.showToast(`⚽ ${playerName} ya ha aparecido en la cadena`, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'player', null);
          resetInput(input);
          return;
        }

        const lastTeam = state.chain.length > 0 ? state.chain[state.chain.length - 1].value : null;
        const { valid, playerData, reason } = await validatePlayer(playerId, lastTeam);

        if (!valid) {
          App.showToast(reason, 'error');
          // Para fallos de jugador no tenemos lista fácil de opciones válidas
          CadenaGame.penalizeWrongAnswer(value, 'player', null);
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

        // Calcular opciones válidas: equipos del jugador anterior, excluyendo el equipo previo
        const playerTeams  = lastEntry?.data?.teams || [];
        const isOCM        = playerTeams.length === 1;
        const prevTeamNorm = prevTeam ? norm(prevTeam) : null;
        const validTeams   = playerTeams.filter(t => !prevTeamNorm || isOCM || norm(t) !== prevTeamNorm);

        if (!canonical) {
          App.showToast(`"${teamName}" no está en la base de datos`, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'team', validTeams);
          resetInput(input);
          return;
        }
        teamName = canonical;

        const { valid, reason, isOneClubMan } = validateTeam(teamName, lastEntry.data, prevTeam);

        if (!valid) {
          App.showToast(reason, 'error');
          CadenaGame.penalizeWrongAnswer(value, 'team', validTeams);
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
