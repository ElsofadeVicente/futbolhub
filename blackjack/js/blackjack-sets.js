/* =============================================
   BLACKJACK-SETS.JS
   Generación de sets balanceados de jugadores
   QUIÉN COÑO FALTA — Blackjack de Fútbol
   ============================================= */

const BlackjackSets = (() => {

  /* ─── Semilla PRNG determinista (Mulberry32) ─── */
  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ─── Fisher-Yates con PRNG dado ─── */
  function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ─────────────────────────────────────────────
     getStatValue
     Devuelve el valor numérico de un jugador
     según el modo de juego activo.
     ───────────────────────────────────────────── */
  function getStatValue(player, mode) {
    if (!player) return 0;
    switch (mode) {
      case 'mv':
        return player.mv || 0;
      case 'national':
        return (player.nt && player.nt.c) ? player.nt.c : 0;
      case 'age': {
        if (!player.b) return 0;
        const birthYear = parseInt(player.b);
        if (isNaN(birthYear)) return 0;
        return new Date().getFullYear() - birthYear;
      }
      default:
        return player.mv || 0;
    }
  }

  /* ─────────────────────────────────────────────
     generateSet
     Genera un set de 10 jugadores balanceado.

     Params:
       playerPool  Array<{id, data}> — pool de candidatos con .mv/.goals etc.
       mode        'mv' | 'goals' | 'national'
       seed        number — semilla compartida del servidor para el set global
                   (el orden por jugador se deriva de seed + playerId)

     Returns:
       {
         objective,          — cifra objetivo
         players: [{id, name, nat, club, pos, _value}],  _value siempre oculto en cliente
         exactCombinations,  — número de combis exactas encontradas (debug)
       }
   ───────────────────────────────────────────── */
  function generateSet(playerPool, mode, seed) {
    const rng = mulberry32(seed);

    // Filtrar jugadores sin valor
    const valid = playerPool.filter(p => getStatValue(p.data, mode) > 0);
    if (valid.length < 10) {
      console.error('[BlackjackSets] Pool insuficiente:', valid.length);
      return null;
    }

    // Enriquecer con _value para simplificar accesos
    const pool = valid.map(p => ({
      id:    p.id,
      name:  p.data.n   || '?',
      nat:   p.data.nat || '',
      club:  p.data.club || '',
      pos:   p.data.p   || '',
      img:   p.data.img || null,
      _value: getStatValue(p.data, mode),
    }));

    // Ordenar por valor y calcular percentiles
    pool.sort((a, b) => a._value - b._value);
    const p10 = pool[Math.floor(pool.length * 0.10)]._value;
    const p25 = pool[Math.floor(pool.length * 0.25)]._value;
    const p50 = pool[Math.floor(pool.length * 0.50)]._value;
    const p75 = pool[Math.floor(pool.length * 0.75)]._value;
    const p80 = pool[Math.floor(pool.length * 0.80)]._value;
    const p90 = pool[Math.floor(pool.length * 0.90)]._value;
    const p95 = pool[Math.floor(pool.length * 0.95)]._value;

    // ── Intentar generar un set válido (máx 30 intentos) ──
    for (let attempt = 0; attempt < 30; attempt++) {
      const attemptSeed = seed + attempt * 1337;
      const result = _tryGenerateSet(pool, p10, p25, p50, p75, p80, p90, p95, mode, mulberry32(attemptSeed));
      if (result) return result;
    }

    // Fallback: set completamente aleatorio con objetivo calculado post-hoc
    console.warn('[BlackjackSets] Usando fallback aleatorio');
    return _fallbackSet(pool, mode, mulberry32(seed + 99999));
  }

  /* ─── Intento de generación con invariantes ─── */
  function _tryGenerateSet(pool, p10, p25, p50, p75, p80, p90, p95, mode, rng) {

    // 1. Objetivo según modo con distribución de tiers
    //    Tier normal (55%): objetivos bajos/medios  → sets de jugadores asequibles
    //    Tier alto   (30%): objetivos medios/altos  → sets mixtos
    //    Tier élite  (15%): objetivos muy altos     → sets de jugadores caros
    let objRaw;
    if (mode === 'age') {
      // Edades individuales son 17-40 — el objetivo debe ser suma de 3-6 jugadores
      // p50 típico ~26 años → objetivo entre 3×p50 y 6×p50 = 78-156 años
      const multiplier = 3 + rng() * 3; // entre 3 y 6
      objRaw = p50 * multiplier;
    } else {
      const tier = rng();
      if (tier < 0.15) {
        // Tier élite (15%): objetivo entre p80 y p95, a veces aún más alto
        objRaw = p80 + rng() * (p95 - p80) * 1.5;
      } else if (tier < 0.45) {
        // Tier alto (30%): objetivo entre p50 y p85
        objRaw = p50 + rng() * (p80 - p50);
      } else {
        // Tier normal (55%): objetivo entre p10 y p60
        objRaw = p10 + rng() * (p75 - p10) * 0.65;
      }
    }
    const objective = _roundObjective(objRaw, mode);

    if (objective <= 0) return null;

    // 2. Distribución del set: totalmente aleatoria pero con rangos definidos
    //    Elegimos aleatoriamente cuántos jugadores de cada franja
    //    La suma total DEBE ser >= 2× el objetivo para garantizar tensión
    const SET_SIZE = 10;

    // Rangos de valor expresados como fracción del objetivo
    // Ejemplo: "alto" = 0.4–0.95× el objetivo
    const brackets = [
      { label: 'muy-alto',  minF: 0.75, maxF: 0.97, minCount: 0, maxCount: 2 },
      { label: 'alto',      minF: 0.35, maxF: 0.74, minCount: 0, maxCount: 3 },
      { label: 'medio',     minF: 0.12, maxF: 0.34, minCount: 0, maxCount: 5 },
      { label: 'bajo',      minF: 0.03, maxF: 0.11, minCount: 0, maxCount: 5 },
      { label: 'micro',     minF: 0.01, maxF: 0.02, minCount: 0, maxCount: 3 },
    ];

    // Seleccionar candidatos por franja
    const byBracket = brackets.map(b => ({
      ...b,
      candidates: pool.filter(p =>
        p._value >= b.minF * objective &&
        p._value <= b.maxF * objective
      )
    }));

    // Tirar aleatoriamente cuántos de cada franja (sin forzar distribución fija)
    // Solo restricción: la suma total >= 2× objetivo
    let selected = [];
    const used = new Set();

    // Asignación aleatoria: para cada franja, tomamos entre 0 y maxCount
    for (const b of byBracket) {
      if (b.candidates.length === 0) continue;
      const available = b.candidates.filter(p => !used.has(p.id));
      if (available.length === 0) continue;
      const count = Math.floor(rng() * (Math.min(b.maxCount, available.length) + 1));
      const picks = shuffle(available, rng).slice(0, count);
      picks.forEach(p => { selected.push(p); used.add(p.id); });
    }

    // Rellenar hasta 10 con jugadores aleatorios no usados
    const remaining = shuffle(pool.filter(p => !used.has(p.id)), rng);
    while (selected.length < SET_SIZE && remaining.length > 0) {
      const p = remaining.shift();
      selected.push(p);
      used.add(p.id);
    }

    if (selected.length < SET_SIZE) return null;
    selected = selected.slice(0, SET_SIZE);

    // Dedup defensivo: elimina IDs repetidos que pudieran colarse por edge cases del pool
    const seenIds = new Set();
    selected = selected.filter(p => {
      if (seenIds.has(p.id)) { console.warn('[BlackjackSets] Duplicado eliminado:', p.id); return false; }
      seenIds.add(p.id);
      return true;
    });
    if (selected.length < SET_SIZE) return null;

    const totalSum = selected.reduce((s, p) => s + p._value, 0);

    // Invariante 1: suma total >= 2× objetivo
    if (totalSum < 2 * objective) return null;

    if (mode === 'age') {
      // Para edades: solo exigir al menos 3 combinaciones cercanas al objetivo (±15%)
      // El exacto es casi imposible con enteros pequeños
      const nearCombos = _countNearSums(selected.map(p => p._value), objective, 0.15);
      if (nearCombos < 3) return null;
      return { objective, players: selected, exactCombinations: 0 };
    }

    // Invariante 2: debe existir al menos 1 combinación exacta (subset sum)
    const exactCombos = _countSubsetSums(selected.map(p => p._value), objective);
    if (exactCombos === 0) return null;

    // Invariante 3: debe haber al menos 3 combinaciones que lleguen a ±15% del objetivo
    const nearCombos = _countNearSums(selected.map(p => p._value), objective, 0.15);
    if (nearCombos < 3) return null;

    return {
      objective,
      players: selected,
      exactCombinations: exactCombos,
    };
  }

  /* ─── Fallback: set aleatorio, objetivo = media de posibles sumas ─── */
  function _fallbackSet(pool, mode, rng) {
    const selected = shuffle(pool, rng).slice(0, 10);
    const values   = selected.map(p => p._value).sort((a, b) => a - b);
    let midSum;
    if (mode === 'age') {
      // Para edades, sumar 4-5 jugadores del centro
      midSum = values[2] + values[3] + values[4] + values[5] + values[6];
    } else {
      midSum = values[3] + values[4] + values[5];
    }
    const objective = _roundObjective(midSum, mode);
    return { objective, players: selected, exactCombinations: 0 };
  }

  /* ─── Redondear objetivo a cifra limpia según modo ─── */
  function _roundObjective(raw, mode) {
    if (mode === 'mv') {
      // Redondear solo a 1M para cifras naturales y variadas
      return Math.round(raw / 1e6) * 1e6;
    }
    if (mode === 'goals') {
      return Math.round(raw);
    }
    if (mode === 'national') {
      return Math.round(raw);
    }
    return Math.round(raw);
  }

  /* ─── Subset-sum exacto (DP, máx 10 elementos) ─── */
  function _countSubsetSums(values, target) {
    // DP de conteo de subsets que suman exactamente target
    // Para mv: normalizar a unidades de 1M para reducir espacio
    const scale = _getScale(values, target);
    const t = Math.round(target / scale);
    const vals = values.map(v => Math.round(v / scale));

    // dp[s] = número de subsets que suman s
    const dp = new Array(t + 1).fill(0);
    dp[0] = 1;

    for (const v of vals) {
      if (v > t) continue;
      // Recorrer al revés para no contar el mismo elemento dos veces
      for (let s = t; s >= v; s--) {
        dp[s] += dp[s - v];
      }
    }
    return dp[t];
  }

  /* ─── Conteo de sumas dentro de ±pct del objetivo ─── */
  function _countNearSums(values, target, pct) {
    const lo = Math.floor(target * (1 - pct));
    const hi = Math.floor(target * (1 + pct));
    const scale = _getScale(values, hi);
    const hiS = Math.round(hi / scale);
    const loS = Math.round(lo / scale);
    const vals = values.map(v => Math.round(v / scale));

    const dp = new Array(hiS + 1).fill(0);
    dp[0] = 1;
    for (const v of vals) {
      if (v > hiS) continue;
      for (let s = hiS; s >= v; s--) {
        dp[s] += dp[s - v];
      }
    }
    let count = 0;
    for (let s = loS; s <= hiS; s++) count += dp[s];
    return count;
  }

  /* ─── Escala para normalizar valores al DP ─── */
  function _getScale(values, target) {
    // Evitar arrays DP gigantes para mv (valores en €)
    const max = Math.max(...values, target);
    if (max >= 1e9) return 1e7;   // 10M
    if (max >= 1e8) return 1e6;   // 1M
    if (max >= 1e6) return 1e5;   // 100k
    return 1;
  }

  /* ─────────────────────────────────────────────
     getPlayerOrder
     Devuelve el orden de las cartas para un jugador
     concreto (mismas cartas, orden diferente).

     seed      — semilla global del set
     playerId  — id del jugador (para personalizar el orden)
     players   — array de jugadores del set
   ───────────────────────────────────────────── */
  function getPlayerOrder(seed, playerId, players) {
    // Semilla combinada: seed XOR hash del playerId
    const pid = typeof playerId === 'string'
      ? playerId.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)
      : playerId;
    const personalSeed = (seed ^ (pid * 2654435761)) >>> 0;
    const rng = mulberry32(personalSeed);
    return shuffle(players.map((_, i) => i), rng);
  }

  /* ─────────────────────────────────────────────
     formatValue
     Formatea el valor según el modo para mostrarlo
   ───────────────────────────────────────────── */
  function formatValue(value, mode) {
    if (mode === 'mv') {
      if (value >= 1e9) return (value / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B€';
      if (value >= 1e6) return (value / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M€';
      if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'K€';
      return value + '€';
    }
    if (mode === 'national') return value + ' internacionales';
    if (mode === 'age') return value + (value === 1 ? ' año' : ' años');
    return String(value);
  }

  /* ─────────────────────────────────────────────
     formatObjective — versión corta para UI
   ───────────────────────────────────────────── */
  function formatObjective(value, mode) {
    if (mode === 'mv') {
      if (value >= 1e9) return (value / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B€';
      if (value >= 1e6) return (value / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M€';
      return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'K€';
    }
    if (mode === 'national') return value + ' caps';
    if (mode === 'age') return value + ' años';
    return String(value);
  }

  /* ─── API pública ─── */
  return {
    generateSet,
    getPlayerOrder,
    getStatValue,
    formatValue,
    formatObjective,
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BlackjackSets;
}
