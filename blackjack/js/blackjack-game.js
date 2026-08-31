/* =============================================
   BLACKJACK-GAME.JS
   Lógica principal — Blackjack de Fútbol
   QUIÉN COÑO FALTA
   ============================================= */

const BlackjackGame = (() => {

  /* ── Escapa texto para insertar de forma segura en HTML (texto o atributo) ── */
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ═══════════════════════════════════════════
     CONSTANTES
     ═══════════════════════════════════════════ */
  const CARDS_PER_ROUND  = 10;
  const POINTS_TO_WIN    = 5;
  const POINTS_EXACT     = 2;
  const POINTS_CLOSEST   = 1;
  const CARD_TIMER_SECS  = 8;
  const REVEAL_CARD_MS   = 1800;   // ms entre cada carta en el reveal
  const REVEAL_DELAY_MS  = 600;    // pausa antes de empezar el reveal
  const BUST_PAUSE_MS    = 1100;   // pausa al pasarte del objetivo antes de mostrar la siguiente carta

  /* ═══════════════════════════════════════════
     ESTADO GLOBAL
     ═══════════════════════════════════════════ */
  let state = null;
  let cardTimerInterval = null;
  let cardTimerStart    = 0;
  let _persistedScores  = {};   // scores acumulados entre rondas, nunca se resetean

  /* ── Timers de animación pendientes (bust pause, reveal, fin de partida…) ──
     Igual que en Higher-or-Lower: "← Salir" durante una animación no recarga
     la página, solo vuelve al menú. Sin cancelar estos timeouts/intervals,
     uno huérfano puede disparar más tarde sobre la partida NUEVA que el
     jugador ya haya empezado (state es una variable de módulo compartida). */
  let _pendingTimers = [];
  function _setTimeout(fn, ms) { const id = setTimeout(fn, ms); _pendingTimers.push(id); return id; }
  function _setInterval(fn, ms) { const id = setInterval(fn, ms); _pendingTimers.push(id); return id; }
  function _cancelPendingTimers() {
    _pendingTimers.forEach(id => { clearTimeout(id); clearInterval(id); });
    _pendingTimers = [];
  }

  /* ── Estado inicial de partida ── */
  function freshState(players, mode, roomCode, isHost, myPlayerId) {
    return {
      // Partida
      mode,           // 'mv' | 'national' | 'age'
      roomCode,
      isHost,
      myPlayerId,
      players: players.map((p, i) => {
        const id = p.id || String(i);
        // _persistedScores es la fuente de verdad local — siempre tiene el acumulado correcto
        const score = (_persistedScores[id] !== undefined)
          ? _persistedScores[id]
          : (p.score || 0);
        return { id, name: p.name, score, connected: true };
      }),

      // Ronda
      round:        0,
      phase:        'waiting',  // 'waiting' | 'selecting' | 'reveal' | 'scoring' | 'finished'
      objective:    0,
      setPlayers:   [],         // los 10 jugadores del set [{id,name,nat,club,pos,_value}]
      setSeed:      0,

      // Por jugador en esta ronda
      // hands[playerId] = { cardOrder:[], picked:[], standing:false, bust:false, total:0 }
      hands: {},

      // Progreso propio
      currentCardIdx: 0,   // índice en cardOrder del jugador local
    };
  }

  /* ── Estado de mano por jugador ── */
  function freshHand(cardOrder) {
    return {
      cardOrder,    // [0..9] índices del set en orden personal
      picked:       [],     // índices del set que añadió
      standing:     false,
      bust:         false,
      total:        0,
      doneAt:       null,   // timestamp cuando terminó (plantado o última carta)
    };
  }

  /* ─── Accesores ─── */
  function getState() { return state; }

  function myHand() {
    if (!state) return null;
    return state.hands[state.myPlayerId] || null;
  }

  function currentCard() {
    const h = myHand();
    // bust NO bloquea — el jugador sigue viendo cartas
    if (!h || h.standing) return null;
    const idx = h.cardOrder[state.currentCardIdx];
    return state.setPlayers[idx] || null;
  }

  /* ═══════════════════════════════════════════
     INICIALIZACIÓN DE RONDA
     ═══════════════════════════════════════════ */
  function startRound(roundData) {
    // roundData: { round, objective, setPlayers, setSeed, players?, mode?, roomCode?, isHost?, myPlayerId? }

    // Siempre reconstruir estado con los datos frescos de Firebase
    // Los scores vienen de roundData.players (fuente de verdad)
    state = freshState(
      roundData.players    || (state ? state.players : []),
      roundData.mode       || (state ? state.mode : 'mv'),
      roundData.roomCode   || (state ? state.roomCode : null),
      roundData.isHost     !== undefined ? roundData.isHost : (state ? state.isHost : false),
      roundData.myPlayerId || (state ? state.myPlayerId : null)
    );

    state.round      = roundData.round;
    state.objective  = roundData.objective;
    state.setPlayers = roundData.setPlayers;
    state.setSeed    = roundData.setSeed;
    state.phase      = 'selecting';

    // Crear manos para cada jugador con su orden personal
    state.hands = {};
    for (const p of state.players) {
      const order = BlackjackSets.getPlayerOrder(roundData.setSeed, p.id, roundData.setPlayers);
      state.hands[p.id] = freshHand(order);
    }

    state.currentCardIdx = 0;

    // Limpiar UI de la ronda anterior
    const bustEl = document.getElementById('bust-indicator');
    if (bustEl) bustEl.classList.add('hidden');
    const nextBtn = document.getElementById('btn-next-round');
    if (nextBtn) nextBtn.classList.add('hidden');

    _updateRoundUI();
    _updateScoreboard();
    _showPhase('selecting');
    _showNextCard();
  }

  /* ═══════════════════════════════════════════
     ACCIONES DEL JUGADOR
     ═══════════════════════════════════════════ */

  /* ── Añadir carta ── */
  function actionAdd() {
    _stopCardTimer();
    const h   = myHand();
    const card = currentCard();
    // h.bust NO bloquea — el jugador sigue viendo cartas aunque se haya pasado
    if (!h || !card || h.standing) return;

    h.picked.push(h.cardOrder[state.currentCardIdx]);
    h.total += card._value;

    const justBusted = h.total > state.objective && !h.bust;
    if (justBusted) {
      h.bust = true;
      _showBustIndicator(h.total);
    }

    if (justBusted) {
      // Pausa para que se vea el aviso de "te has pasado" en vez de saltar
      // a la siguiente carta en el mismo instante en que aparece.
      const btnAdd     = document.getElementById('btn-add');
      const btnDiscard = document.getElementById('btn-discard');
      const btnStand   = document.getElementById('btn-stand');
      if (btnAdd)     btnAdd.disabled     = true;
      if (btnDiscard) btnDiscard.disabled = true;
      if (btnStand)   btnStand.disabled   = true;
      _setTimeout(() => _advanceCard(h), BUST_PAUSE_MS);
    } else {
      _advanceCard(h);
    }
  }

  /* ── Descartar carta ── */
  function actionDiscard() {
    _stopCardTimer();
    const h = myHand();
    // h.bust NO bloquea — el jugador sigue viendo cartas aunque se haya pasado
    if (!h || h.standing) return;
    _advanceCard(h);
  }

  /* ── Plantarse ── */
  function actionStand() {
    _stopCardTimer();
    const h = myHand();
    if (!h || h.standing || h.total === 0) return;

    h.standing = true;
    h.doneAt   = Date.now();
    _onPlayerDone();
  }

  /* ── Timeout: carta descartada automáticamente ── */
  function _onCardTimeout() {
    const h = myHand();
    if (!h || h.standing) return;
    App.showToast('⏰ Tiempo — carta descartada', 'warning');
    _advanceCard(h);
  }

  /* ─── Avanzar a la siguiente carta o terminar ─── */
  function _advanceCard(hand) {
    state.currentCardIdx++;

    if (state.currentCardIdx >= CARDS_PER_ROUND) {
      // Visto todas las cartas
      hand.doneAt = Date.now();
      _onPlayerDone();
    } else {
      _showNextCard();
    }
  }

  /* ─── Jugador terminó su ronda ─── */
  function _onPlayerDone() {
    _stopCardTimer();
    _showPhase('waiting-reveal');

    const hand = myHand();
    const handData = {
      picked:   hand.picked,
      bust:     hand.bust,
      standing: hand.standing,
    };

    // Notificar a App (que gestiona Firebase y el trigger del reveal)
    if (typeof App !== 'undefined' && App.onPlayerDone) {
      App.onPlayerDone(handData);
    } else {
      // Fallback local
      _checkAllDone();
    }
  }

  /* ─── ¿Terminaron todos? ─── */
  function _checkAllDone() {
    const allDone = state.players.every(p => {
      const h = state.hands[p.id];
      return h && (h.standing || h.bust || h.doneAt !== null);
    });
    if (allDone) startReveal();
  }

  /* ═══════════════════════════════════════════
     FASE REVEAL
     ═══════════════════════════════════════════ */
  function startReveal() {
    state.phase = 'reveal';
    _showPhase('reveal');
    _buildRevealUI();

    _setTimeout(() => {
      _runRevealAnimation();
    }, REVEAL_DELAY_MS);
  }

  function _runRevealAnimation() {
    // Construir lista de cartas escogidas por cada jugador en orden de cardOrder
    const playerCards = state.players.map(p => {
      const h = state.hands[p.id];
      if (!h) return { id: p.id, cards: [] };
      // Solo las cartas que el jugador añadió, en el orden que aparecieron
      const cards = h.cardOrder
        .filter(idx => h.picked.includes(idx))
        .map(idx => state.setPlayers[idx]);
      return { id: p.id, cards };
    });

    // El máximo de cartas escogidas entre todos los jugadores
    const maxCards = Math.max(...playerCards.map(p => p.cards.length), 0);

    let step = 0;
    const iv = _setInterval(() => {
      if (step >= maxCards) {
        clearInterval(iv);
        _setTimeout(_finalizeReveal, 800);
        return;
      }

      // Revelar la carta `step` de cada jugador (si tiene esa carta)
      for (const pc of playerCards) {
        if (step < pc.cards.length) {
          const player = pc.cards[step];
          const h = state.hands[pc.id];
          h._revealTotal = (h._revealTotal || 0) + (player._value || 0);
          _renderRevealCard(pc.id, player);
          _updateRevealCounter(pc.id, h._revealTotal);
        }
      }
      step++;
    }, REVEAL_CARD_MS);
  }

  function _finalizeReveal() {
    const results = _computeResults();
    _highlightRevealResults(results);
    _assignPoints(results);
    _updateScoreboard();

    // Notificar scores actualizados a App (host sube a Firebase, todos guardan localmente)
    if (typeof App !== 'undefined' && App.onRoundScoresReady) {
      App.onRoundScoresReady(state.players);
    }

    const eligible = state.players.filter(p => p.score >= POINTS_TO_WIN);
    const winner = eligible.length
      ? eligible.reduce((best, p) => (p.score > best.score ? p : best), eligible[0])
      : null;
    if (winner) {
      _setTimeout(() => _endGame(winner), 2000);
    } else {
      // Botón siguiente ronda: solo host, aparece después de que el reveal haya terminado
      _setTimeout(() => {
        const btn = document.getElementById('btn-next-round');
        if (btn && state.isHost) btn.classList.remove('hidden');
      }, 1800);
    }
  }

  /* ═══════════════════════════════════════════
     CÁLCULO DE RESULTADOS
     ═══════════════════════════════════════════ */

  // Modo local: 1 jugador sin sala. Gana puntos solo si llega al 80% del objetivo sin pasarse.
  const _isLocalMode = () => state.roomCode === null && state.players.length === 1;

  function _computeResults() {
    const obj = state.objective;
    const results = state.players.map(p => {
      const h = state.hands[p.id];
      const total = h ? (h._revealTotal !== undefined ? h._revealTotal : h.total) : 0;
      const bust  = total > obj;
      const exact = !bust && total === obj;
      const diff  = bust ? Infinity : obj - total;
      return { playerId: p.id, total, bust, exact, diff };
    });

    // Modo local: puntos solo si total >= 80% del objetivo
    if (_isLocalMode()) {
      const threshold = obj * 0.8;
      results.forEach(r => {
        if (r.bust || r.total < threshold) {
          r.points = 0;
          r.missed = !r.bust;   // llegó pero no alcanzó el 80%
        } else if (r.exact) {
          r.points = POINTS_EXACT;
        } else {
          r.points = POINTS_CLOSEST;
        }
      });
      return results;
    }

    // Modo multijugador: el más cercano sin pasarse gana
    results.sort((a, b) => a.diff - b.diff);
    const notBust = results.filter(r => !r.bust);

    if (notBust.length === 0) {
      results.forEach(r => r.points = 0);
      return results;
    }

    const minDiff = notBust[0].diff;
    results.forEach(r => {
      if (r.bust) { r.points = 0; return; }
      if (r.exact)               r.points = POINTS_EXACT;
      else if (r.diff === minDiff) r.points = POINTS_CLOSEST;
      else                       r.points = 0;
    });

    return results;
  }

  function _assignPoints(results) {
    results.forEach(r => {
      const p = state.players.find(p => p.id === r.playerId);
      if (p) {
        p.score += r.points;
        _persistedScores[p.id] = p.score;  // persistir localmente
      }
    });
  }

  /* ═══════════════════════════════════════════
     FIN DE PARTIDA
     ═══════════════════════════════════════════ */
  function _endGame(winner) {
    state.phase = 'finished';
    _showPhase('finished');

    const winnerEl = document.getElementById('winner-name');
    if (winnerEl) winnerEl.textContent = winner.name;

    const scoreList = document.getElementById('final-scores');
    if (scoreList) {
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      scoreList.innerHTML = sorted.map(p =>
        `<div class="final-score-row ${p.id === winner.id ? 'winner' : ''}">
          <span class="fs-name">${escapeHtml(p.name)}</span>
          <span class="fs-pts">${p.score} pt${p.score !== 1 ? 's' : ''}</span>
        </div>`
      ).join('');
    }
  }

  /* ═══════════════════════════════════════════
     TIMER DE CARTA
     ═══════════════════════════════════════════ */
  function _startCardTimer() {
    _stopCardTimer();
    cardTimerStart = Date.now();
    _updateTimerUI(CARD_TIMER_SECS);

    cardTimerInterval = _setInterval(() => {
      const elapsed   = (Date.now() - cardTimerStart) / 1000;
      const remaining = Math.max(0, CARD_TIMER_SECS - elapsed);
      _updateTimerUI(remaining);

      if (remaining <= 0) {
        clearInterval(cardTimerInterval);
        _onCardTimeout();
      }
    }, 100);
  }

  function _stopCardTimer() {
    clearInterval(cardTimerInterval);
  }

  function _updateTimerUI(remaining) {
    const bar  = document.getElementById('card-timer-bar');
    const text = document.getElementById('card-timer-text');
    if (!bar || !text) return;
    const pct = (remaining / CARD_TIMER_SECS) * 100;
    bar.style.width = pct + '%';
    bar.classList.toggle('warning', remaining <= 3);
    text.textContent = Math.ceil(remaining);
  }

  /* ═══════════════════════════════════════════
     UI — CARTA ACTUAL (fase selección)
     ═══════════════════════════════════════════ */
  function _showNextCard() {
    const card = currentCard();
    if (!card) { _onPlayerDone(); return; }

    _startCardTimer();

    const h = myHand();

    // Contador de cartas vistas
    const counterEl = document.getElementById('card-counter');
    if (counterEl) counterEl.textContent = `${state.currentCardIdx + 1} / ${CARDS_PER_ROUND}`;

    // Progreso de jugadores rivales (avatares pulsantes)
    _updateOpponentActivity();

    // Render de la carta
    _renderCurrentCard(card, h);

    // Botones
    const btnAdd    = document.getElementById('btn-add');
    const btnDiscard = document.getElementById('btn-discard');
    const btnStand  = document.getElementById('btn-stand');

    if (btnAdd)    btnAdd.disabled    = false;
    if (btnDiscard) btnDiscard.disabled = false;
    // Stand solo disponible si no bust y tiene algo acumulado
    // Stand disponible si tiene algo acumulado (aunque se haya pasado)
    if (btnStand)  btnStand.disabled = h.total === 0;
  }

  /* ─── club → URL del escudo en Supabase Storage (bucket team-logos) ─── */
  function _getLogoUrl(club) {
    if (!club) return null;
    // Misma lógica que safe_key() en admin/upload_images_to_storage.py, que
    // es quien decide la clave real en Storage: sin quitar acentos/diéresis
    // aquí, un club como "Atlético Saguntino" o "1.FC Köln" pediría un
    // archivo que nunca coincide con el que se subió (Storage rechaza claves
    // no-ASCII, así que la clave subida siempre va sin acentos).
    const fname = club.trim()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[\/:\*\?"<>|]/g, '_')
      .replace(/\s+/g, '_');
    return sbStorageUrl('team-logos', `${fname}.png`);
  }

  /* ─── nat → ruta local de bandera (sin JSON, sin fetch) ─── */
  function _getFlagUrl(nat) {
    if (!nat) return null;
    const MAP = {
      'Spain':'es','England':'gb-eng','France':'fr','Germany':'de',
      'Italy':'it','Portugal':'pt','Brazil':'br','Argentina':'ar',
      'Netherlands':'nl','Belgium':'be','Croatia':'hr','Switzerland':'ch',
      'Denmark':'dk','Sweden':'se','Norway':'no','Poland':'pl',
      'Czech Republic':'cz','Austria':'at','Scotland':'gb-sct',
      'Wales':'gb-wls','Ireland':'ie','Greece':'gr',
      'Türkiye':'tr','Turkiye':'tr','Turkey':'tr','Russia':'ru','Ukraine':'ua',
      'Serbia':'rs','Slovakia':'sk','Hungary':'hu','Romania':'ro',
      'Slovenia':'si','Albania':'al','Iceland':'is','Finland':'fi',
      'Georgia':'ge','Kosovo':'xk','Bosnia and Herzegovina':'ba',
      'North Macedonia':'mk','Montenegro':'me','Bulgaria':'bg',
      'Uruguay':'uy','Colombia':'co','Chile':'cl','Peru':'pe',
      'Ecuador':'ec','Venezuela':'ve','Paraguay':'py','Bolivia':'bo',
      'Mexico':'mx','United States':'us','Canada':'ca',
      'Costa Rica':'cr','Panama':'pa','Jamaica':'jm',
      'Honduras':'hn','Guatemala':'gt',
      'Japan':'jp','South Korea':'kr','Australia':'au',
      'Morocco':'ma','Senegal':'sn','Cameroon':'cm','Ghana':'gh',
      'Nigeria':'ng','Egypt':'eg','Algeria':'dz','Tunisia':'tn',
      'Mali':'ml','Guinea':'gn','Burkina Faso':'bf','Angola':'ao',
      'South Africa':'za','Gabon':'ga','DR Congo':'cd',
      'Zimbabwe':'zw','Zambia':'zm','Kenya':'ke','Ethiopia':'et',
      // Valores truncados en los datos
      'United':'us','DR':'cd','Cote':'ci','Cape':'cv',
      'Dominican':'do','Guadeloupe':'gp',
      // Códigos ISO 3 letras
      'ESP':'es','ENG':'gb-eng','FRA':'fr','GER':'de','ITA':'it',
      'POR':'pt','BRA':'br','ARG':'ar','NED':'nl','BEL':'be',
      'CRO':'hr','SUI':'ch','DEN':'dk','SWE':'se','NOR':'no',
      'POL':'pl','CZE':'cz','AUT':'at','SCO':'gb-sct','WAL':'gb-wls',
      'IRL':'ie','NIR':'gb-nir','GRE':'gr','TUR':'tr','RUS':'ru',
      'UKR':'ua','SRB':'rs','SVK':'sk','HUN':'hu','BUL':'bg',
      'ROU':'ro','SVN':'si','ALB':'al','MNE':'me','MKD':'mk',
      'BIH':'ba','KOS':'xk','ISL':'is','FIN':'fi','GEO':'ge',
      'URU':'uy','COL':'co','CHI':'cl','PER':'pe','ECU':'ec',
      'VEN':'ve','PAR':'py','BOL':'bo','MEX':'mx','USA':'us',
      'CAN':'ca','CRC':'cr','PAN':'pa','JAM':'jm','HON':'hn',
      'GUA':'gt','SEN':'sn','CMR':'cm','GHA':'gh','CIV':'ci',
      'NGA':'ng','MAR':'ma','EGY':'eg','ALG':'dz','TUN':'tn',
      'MLI':'ml','GUI':'gn','COD':'cd','ANG':'ao','RSA':'za',
      'JPN':'jp','KOR':'kr','AUS':'au',
    };
    const iso = MAP[nat];
    return iso ? sbStorageUrl('team-flags', `${iso}.png`) : null;
  }

  function _renderCurrentCard(card, hand) {
    const el = document.getElementById('current-card');
    if (!el) return;

    const cardsLeft = CARDS_PER_ROUND - state.currentCardIdx;

    // ── Foto del jugador ──
    const safeName = escapeHtml(card.name);
    const safeClub = escapeHtml(card.club);
    const safeNat  = escapeHtml(card.nat || '');
    const safePos  = escapeHtml(_posLabel(card.pos));

    const imgHtml = card.img
      ? `<div class="card-face-img">
           <img src="${escapeHtml(fhImgUrl(card.img))}" alt="${safeName}" loading="lazy"
                onerror="this.parentElement.classList.add('img-error')">
         </div>`
      : `<div class="card-face-img card-face-img--empty">
           <span class="card-face-initials">${escapeHtml(card.name.charAt(0))}</span>
         </div>`;

    // ── Escudo del equipo (izquierda) — ruta local derivada del nombre del club ──
    const badgeUrl = _getLogoUrl(card.club);
    const badgeHtml = badgeUrl
      ? `<div class="card-badge-wrap">
           <img src="${escapeHtml(badgeUrl)}" alt="${safeClub}" loading="lazy"
                onerror="this.style.visibility='hidden'">
         </div>`
      : `<div class="card-badge-wrap"></div>`;

    // ── Bandera (centro) — mapa inline, nunca falla ──
    const flagUrl = _getFlagUrl(card.nat);
    const flagHtml = flagUrl
      ? `<div class="card-header-flag">
           <img src="${escapeHtml(flagUrl)}" alt="${safeNat}" loading="lazy" class="card-header-flag-img"
                onerror="this.nextElementSibling && (this.nextElementSibling.style.display='inline'); this.style.display='none'">
           <span class="card-header-flag-nat" style="display:none">${safeNat}</span>
         </div>`
      : `<div class="card-header-flag">
           <span class="card-header-flag-nat">${safeNat}</span>
         </div>`;

    el.innerHTML = `
      <div class="card-stack">
        ${cardsLeft > 2 ? '<div class="card-back card-stack-3"></div>' : ''}
        ${cardsLeft > 1 ? '<div class="card-back card-stack-2"></div>' : ''}
        <div class="card-face card-tinder">

          <!-- Header: escudo (izq) | bandera (centro) | posición (der) -->
          <div class="card-face-header">
            ${badgeHtml}
            ${flagHtml}
            <span class="card-pos">${safePos}</span>
          </div>

          <!-- Foto enmarcada -->
          ${imgHtml}

          <!-- Barra dorada con nombre -->
          <div class="card-namebar">
            <div class="card-face-name">${safeName}</div>
          </div>

          <!-- Footer: cartas restantes -->
          <div class="card-face-footer">
            <span class="card-remaining">${cardsLeft} restantes</span>
          </div>

        </div>
      </div>
    `;
  }

  function _showBustIndicator(total) {
    const el = document.getElementById('bust-indicator');
    if (!el) return;
    const shown = (typeof BlackjackSets !== 'undefined' && BlackjackSets.formatValue)
      ? BlackjackSets.formatValue(total, state.mode)
      : total;
    el.textContent = `¡TE HAS PASADO! (${shown})`;
    el.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════
     UI — REVEAL
     ═══════════════════════════════════════════ */
  function _buildRevealUI() {
    const container = document.getElementById('reveal-players');
    if (!container) return;

    container.innerHTML = state.players.map(p => `
      <div class="reveal-player-area" id="reveal-area-${p.id}">
        <div class="reveal-player-header">
          <span class="reveal-player-name">${escapeHtml(p.name)}</span>
          <span class="reveal-player-total" id="reveal-total-${p.id}">—</span>
        </div>
        <div class="reveal-cards-list" id="reveal-cards-${p.id}">
          <!-- Las cartas escogidas aparecen aquí una a una -->
        </div>
      </div>
    `).join('');
  }

  function _renderRevealCard(playerId, player) {
    const list = document.getElementById(`reveal-cards-${playerId}`);
    if (!list) return;

    // Foto
    const safeName = escapeHtml(player.name);
    const imgHtml = player.img
      ? `<img class="reveal-card-img" src="${escapeHtml(fhImgUrl(player.img))}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="reveal-card-img reveal-card-img--empty">${escapeHtml(player.name.charAt(0))}</div>`;

    // Escudo mini (misma ruta local que usa la carta principal, sin JSON/fetch)
    const badgeUrl = _getLogoUrl(player.club);
    const badgeHtml = badgeUrl
      ? `<img class="reveal-card-badge" src="${escapeHtml(badgeUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
      : '<span style="width:13px"></span>';

    const card = document.createElement('div');
    card.className = 'reveal-card reveal-card--added';
    card.innerHTML = `
      <div class="reveal-card-header">
        ${badgeHtml}
        <span class="reveal-card-pos">${escapeHtml(_posLabel(player.pos))}</span>
      </div>
      ${imgHtml}
      <div class="reveal-card-name">${safeName}</div>
      <div class="reveal-card-value">${BlackjackSets.formatValue(player._value, state.mode)}</div>
    `;
    list.appendChild(card);
    requestAnimationFrame(() => card.classList.add('flip-in'));
  }

  function _updateRevealCounter(playerId, total) {
    const el = document.getElementById(`reveal-total-${playerId}`);
    if (!el) return;
    el.textContent = BlackjackSets.formatValue(total, state.mode);
  }

  function _highlightRevealResults(results) {
    results.forEach(r => {
      const area    = document.getElementById(`reveal-area-${r.playerId}`);
      const totalEl = document.getElementById(`reveal-total-${r.playerId}`);
      if (!area) return;

      area.classList.remove('result-winner', 'result-bust', 'result-neutral');
      if (totalEl) totalEl.classList.remove('total-winner', 'total-bust');

      if (r.bust) {
        area.classList.add('result-bust');
        if (totalEl) totalEl.classList.add('total-bust');
      } else if (r.points > 0) {
        area.classList.add('result-winner');
        if (totalEl) totalEl.classList.add('total-winner');
      } else {
        area.classList.add('result-neutral');
      }

      // Badge de resultado
      const header = area.querySelector('.reveal-player-header');
      if (!header) return;

      if (r.points > 0) {
        const badge = document.createElement('div');
        badge.className = 'reveal-points-badge';
        badge.textContent = r.exact ? `+${POINTS_EXACT} ¡EXACTO!` : `+${POINTS_CLOSEST}`;
        header.appendChild(badge);
      } else if (_isLocalMode() && r.bust) {
        const badge = document.createElement('div');
        badge.className = 'reveal-points-badge reveal-points-bust';
        badge.textContent = '💥 PASADO';
        header.appendChild(badge);
      } else if (_isLocalMode() && r.missed) {
        const badge = document.createElement('div');
        badge.className = 'reveal-points-badge reveal-points-miss';
        const pct = Math.round((r.total / state.objective) * 100);
        badge.textContent = `${pct}% — falta más`;
        header.appendChild(badge);
      }
    });
  }

  /* ═══════════════════════════════════════════
     UI — MARCADOR Y HELPERS
     ═══════════════════════════════════════════ */
  function _updateRoundUI() {
    const roundEl = document.getElementById('round-number');
    if (roundEl) roundEl.textContent = `Ronda ${state.round}`;

    const objEl = document.getElementById('objective-display');
    if (objEl) objEl.textContent = BlackjackSets.formatObjective(state.objective, state.mode);
  }

  function _updateScoreboard() {
    const sb = document.getElementById('scoreboard');
    if (!sb) return;
    sb.innerHTML = state.players.map(p =>
      `<div class="sb-player">
        <span class="sb-name">${escapeHtml(p.name)}</span>
        <span class="sb-score">${p.score}</span>
      </div>`
    ).join('');
  }

  function _updateOpponentActivity() {
    const container = document.getElementById('opponent-activity');
    if (!container) return;
    container.innerHTML = state.players
      .filter(p => p.id !== state.myPlayerId)
      .map(p => {
        const h = state.hands[p.id];
        const done = h && (h.standing || h.doneAt);
        const inner = (window.FHAuth && FHAuth.avatarInner)
          ? FHAuth.avatarInner(p.name, p.avatar)
          : escapeHtml(p.name.charAt(0).toUpperCase());
        return `<div class="opp-avatar ${done ? 'opp-done' : 'opp-thinking'}" title="${escapeHtml(p.name)}">
          ${inner}
        </div>`;
      }).join('');
  }

  /* ── Cambiar pantalla activa ── */
  function _showPhase(phase) {
    const map = {
      'selecting':      'screen-selecting',
      'waiting-reveal': 'screen-waiting',
      'reveal':         'screen-reveal',
      'scoring':        'screen-reveal',
      'finished':       'screen-finished',
    };
    const screenId = map[phase] || 'screen-menu';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
  }

  function _posLabel(pos) {
    const map = { PO: 'POR', DE: 'DEF', MC: 'MED', DE_AP: 'DEL', at: 'DEL' };
    return map[pos] || pos || '?';
  }

  /* ═══════════════════════════════════════════
     API PÚBLICA
     ═══════════════════════════════════════════ */
  return {
    // Init
    freshState,
    getState,
    startRound,

    // Acciones
    actionAdd,
    actionDiscard,
    actionStand,

    // Reveal
    startReveal,

    // Helpers
    checkAllDone: _checkAllDone,
    updateOpponentActivity: _updateOpponentActivity,
    updateScoreboard: _updateScoreboard,
    resetScores: () => { _cancelPendingTimers(); _stopCardTimer(); _persistedScores = {}; state = null; },
    cancelPendingTimers: () => { _cancelPendingTimers(); _stopCardTimer(); },

    // Constantes expuestas
    CARDS_PER_ROUND,
    POINTS_TO_WIN,
    CARD_TIMER_SECS,
    REVEAL_CARD_MS,
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlackjackGame;
}
