/* =============================================
   CADENA-DATA.JS
   Carga de datos, búsqueda y validación de la
   cadena Jugador ↔ Equipo — ahora desde Supabase
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
     .normalize('NFD').replace(/[̀-ͯ]/g, '')
     .replace(/[^a-z0-9 ]/g, ' ')
     .replace(/\s+/g, ' ')
     .trim();


  /* ── Filtro de filiales ── */
  function isFilialTeam(name) {
    if (!name) return false;
    if (/Juan Pablo II/.test(name)) return false;
    if (/\b(II|III)\s*($|\()/.test(name)) return true;
    if (/\bII\b/.test(name)) return true;
    if (/\s[BC]$/.test(name)) return true;
    if (/\bU[\s-]?\d{2}\b/i.test(name)) return true;
    if (/\bUnder[\s-]?\d{1,2}\b/i.test(name)) return true;
    const keywords = ["reserve","youth","juvenil","filial","canterano","academy","mestalla","castilla"];
    const lower = name.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }

  function filterTeams(teams) {
    return (teams || []).filter(t => !isFilialTeam(t));
  }

  /* ── Chunk helpers (ahora contra Supabase, no contra archivos JSON) ── */
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
    const res = await fetch(sbStorageUrl('player-db', `players/chunks/${cf}`));
    if (!res.ok) throw new Error(`Chunk no encontrado: ${cf}`);
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
  let _initPromise = null;  // Singleton: evita cargas duplicadas en paralelo

  async function init() {
    if (nameIndex && teamNames) return;   // ya cargado
    if (_initPromise) return _initPromise; // carga en curso, esperar

    _initPromise = (async () => {
      const [ni, tn, leagueTeams] = await Promise.all([
        fetch(sbStorageUrl('player-db', 'players/name-index.json')).then(r => r.json()),
        fetch(sbStorageUrl('player-db', 'team-names/team-names.json')).then(r => r.json()),
        fetch(sbStorageUrl('player-db', 'leagues/league-teams.json')).then(r => r.json()).catch(() => null),
      ]);

      nameIndex = ni;
      teamNames = tn.filter(t => !isFilialTeam(t));

      teamLeaguePrio = {};
      if (leagueTeams) {
        // Estructura: { "La Liga": { priority: 1, teams: [...] }, ... }
        for (const leagueInfo of Object.values(leagueTeams)) {
          for (const teamName of leagueInfo.teams) {
            const key = norm(teamName);
            if (teamLeaguePrio[key] === undefined || leagueInfo.priority < teamLeaguePrio[key]) {
              teamLeaguePrio[key] = leagueInfo.priority;
            }
          }
        }
      } else {
        console.warn('⚠️ leagues no disponible, sin prioridad de ligas');
      }

      console.log(`✅ CadenaData: ${nameIndex.length.toLocaleString()} jugadores, ${teamNames.length.toLocaleString()} equipos`);
    })();

    return _initPromise;
  }

  /* ── Precarga de todos los chunks de jugadores ── */
  const ALL_CHUNKS = [
    '0-99999.json','100000-199999.json','200000-299999.json','300000-399999.json',
    '400000-499999.json','500000-599999.json','600000-699999.json','700000-799999.json',
    '800000-899999.json','900000-999999.json','1000000-1099999.json','1100000-1199999.json',
    '1200000-1299999.json','1300000-1399999.json','1400000-1499999.json'
  ];
  let _chunksPromise = null;
  let _chunksLoaded  = false;

  async function preloadAllChunks() {
    if (_chunksLoaded) return;           // ya cargados con éxito, no repetir
    if (_chunksPromise) return _chunksPromise; // carga en curso, esperar
    _chunksPromise = Promise.all(
      ALL_CHUNKS.map(cf => loadPlayerChunk(cf).catch(() => null))
    ).then(results => {
      // Solo marcar como cargado si todos los chunks respondieron (no null)
      const failed = results.filter(r => r === null).length;
      if (failed === 0) {
        _chunksLoaded = true;
      } else {
        // Hubo fallos — resetear para poder reintentar
        _chunksPromise = null;
        console.warn(`⚠️ ${failed} chunks fallaron al precargar`);
      }
    });
    return _chunksPromise;
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

  function wordBoundaryMatch(n, q) {
    const words = n.split(' ');
    for (let i = 0; i < words.length; i++) {
      const fromWord = words.slice(i).join(' ');
      if (fromWord.startsWith(q)) return true;
    }
    return false;
  }

  const POS_LABEL = { GK: 'Portero', DEF: 'Defensa', MID: 'Centrocampista', FWD: 'Delantero' };

  async function buildSuggestions(query) {
    if (!nameIndex || !teamNames) return;
    const q = norm(query);
    const type = CadenaGame.getCurrentTurnType();
    let results = [];

    if (type === 'player') {
      let exact = [], starts = [], wordBound = [], contains = [];
      for (const [id, name] of nameIndex) {
        const n = norm(name);
        if      (n === q)                  exact.push([id, name]);
        else if (n.startsWith(q))          starts.push([id, name]);
        else if (wordBoundaryMatch(n, q))  wordBound.push([id, name]);
        else if (n.includes(q))            contains.push([id, name]);
      }

      const tagged = [
        ...exact.map(([id, name])     => ({ id, name, cat: 0 })),
        ...starts.map(([id, name])    => ({ id, name, cat: 1 })),
        ...wordBound.map(([id, name]) => ({ id, name, cat: 2 })),
        ...contains.map(([id, name])  => ({ id, name, cat: 3 })),
      ];

      // Render provisional rápido con los primeros 8 del índice
      renderSuggestions(
        tagged.slice(0, 8).map(({ id, name }) => ({ type: 'player', id, name })),
        query
      );

      // Cargar datos de TODOS los candidatos para poder ordenar correctamente
      const dataList = await Promise.all(tagged.map(t => getPlayerById(t.id)));
      const itemsWithData = tagged.map((t, i) => ({
        type: 'player', id: t.id, name: t.name, cat: t.cat, data: dataList[i]
      }));

      // Calcular mejor prioridad de liga de cada jugador
      const bestLeaguePrio = (data) => {
        const ft = filterTeams(data?.teams);
        if (!ft.length) return 999;
        return ft.reduce((best, t) => {
          const p = teamLeaguePrio?.[norm(t)] ?? 999;
          return p < best ? p : best;
        }, 999);
      };

      itemsWithData.sort((a, b) => {
        if (a.cat !== b.cat) return a.cat - b.cat;
        const prioA = bestLeaguePrio(a.data);
        const prioB = bestLeaguePrio(b.data);
        if (prioA !== prioB) return prioA - prioB;
        return (b.data?.apps || 0) - (a.data?.apps || 0);
      });

      // Excluir jugadores que SOLO tienen equipos filiales (no tendrían salida válida)
      // y deduplicar por huella única para evitar duplicados reales en la base de datos
      // (mismo jugador indexado dos veces con IDs distintos pero datos idénticos)
      const seenFingerprints = new Set();
      const playableItems = itemsWithData.filter(item => {
        if (!filterTeams(item.data?.teams).length) return false;
        const d = item.data;
        const fingerprint = d
          ? `${norm(item.name)}|${d.b || ''}|${d.nat || ''}|${Math.round(d.h || 0)}`
          : String(item.id);
        if (seenFingerprints.has(fingerprint)) return false;
        seenFingerprints.add(fingerprint);
        return true;
      });
      results = playableItems.slice(0, 8);

      const finalItems = results.map((item, _, arr) => {
        const d = item.data;
        if (!d) return item;
        const sameName = arr.filter(o => norm(o.name) === norm(item.name));
        let tags = [];
        const posLabel = POS_LABEL[d.p] || d.p || '';
        if (posLabel) tags.push(posLabel);
        if (sameName.length > 1) {
          const samePos = sameName.filter(o => o.data?.p === d.p);
          if (samePos.length > 1 && d.nat) {
            tags.push(d.nat);
            const sameNat = samePos.filter(o => o.data?.nat === d.nat);
            if (sameNat.length > 1 && d.h) tags.push(d.h + ' cm');
          }
        }
        return { ...item, disambig: tags.join(' · ') };
      });

      renderSuggestions(finalItems, query);

    } else {
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

      candidates.sort((a, b) => {
        const aIsContains = a.cat === 3;
        const bIsContains = b.cat === 3;
        if (aIsContains !== bIsContains) return aIsContains ? 1 : -1;
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
      if (isOpen && suggestionIndex >= 0) selectSuggestion(suggestionIndex);
      else submitAnswer();
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
  async function validatePlayer(playerId, requiredTeam) {
    const player = await getPlayerById(playerId);
    if (!player) return { valid: false, reason: 'Jugador no encontrado en la base de datos.' };
    const playerTeamsFilt = filterTeams(player.teams);
    if (!playerTeamsFilt.length) return { valid: false, reason: `${player.n} solo ha jugado en equipos filiales y no es válido en este juego.` };
    if (!requiredTeam) return { valid: true, playerData: player };
    const qt = norm(requiredTeam);
    const played = playerTeamsFilt.some(t => norm(t) === qt);
    if (!played) {
      const teamList = playerTeamsFilt.slice(0, 4).join(', ');
      return { valid: false, reason: `${player.n} no jugó en ${requiredTeam}. Sus equipos: ${teamList}…` };
    }
    return { valid: true, playerData: player };
  }

  function validateTeam(teamName, playerData, previousTeam) {
    const qt = norm(teamName);
    const teams = filterTeams(playerData.teams);
    const played = teams.some(t => norm(t) === qt);
    if (!played) {
      const teamList = teams.slice(0, 4).join(', ');
      return { valid: false, reason: `${playerData.n} no jugó en ${teamName}. Sus equipos: ${teamList}…` };
    }
    const isOneClubMan = teams.length === 1;
    if (previousTeam && !isOneClubMan && norm(teamName) === norm(previousTeam)) {
      return { valid: false, reason: `¡No puedes repetir el equipo anterior (${previousTeam})!` };
    }
    return { valid: true, isOneClubMan };
  }

  /* ── Submit answer ── */
  async function submitAnswer() {
    const input = document.getElementById('answer-input');
    const value = (input.value || '').trim();
    if (!value) return;

    if (!selectedSuggestion && suggestionItems.length > 0) {
      const idx = suggestionIndex >= 0 ? suggestionIndex : 0;
      selectedSuggestion = suggestionItems[idx];
      input.value = selectedSuggestion.name;
      closeSuggestions();
    }

    input.disabled = true;
    document.querySelector('.submit-btn').disabled = true;

    const type = CadenaGame.getCurrentTurnType();
    const state = CadenaGame.getState();

    try {
      if (type === 'player') {
        let playerId   = selectedSuggestion?.id;
        let playerName = selectedSuggestion?.name || value;

        if (!playerId) {
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
          CadenaGame.penalizeWrongAnswer(value, 'player', null);
          resetInput(input);
          return;
        }

        CadenaGame.addToChain({
          type: 'player', id: playerId, name: playerName, data: playerData,
          nat: playerData?.nat || null,
          b:   playerData?.b   || null
        });

      } else {
        const lastEntry = state.chain[state.chain.length - 1];
        const prevTeam  = state.chain.length >= 2 ? state.chain[state.chain.length - 2].value : null;

        // En online lastEntry.data no viaja por Firebase — cargar por id desde chunks locales
        // Los chunks están precargados en memoria tras el countdown, así que esto es instantáneo
        let playerData = lastEntry?.data;
        if (!playerData && lastEntry?.id) {
          playerData = await getPlayerById(lastEntry.id);
        }
        if (!playerData) {
          App.showToast('Error: no se encontró el jugador anterior', 'error');
          resetInput(input);
          return;
        }

        let teamName = selectedSuggestion?.name || value;
        const q = norm(teamName);
        const canonical = teamNames.find(t => norm(t) === q);

        const playerTeams  = filterTeams(playerData?.teams);
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

        const { valid, reason, isOneClubMan } = validateTeam(teamName, playerData, prevTeam);

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
  return { init, preloadAllChunks, chunksLoaded: () => _chunksLoaded, onInput, onKeyDown, selectSuggestion, submitAnswer, closeSuggestions, getPlayerById };

})();
