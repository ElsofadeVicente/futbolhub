/* =============================================
   RANKED.JS — Capa de datos del modo Clasificatoria (ranked 1v1 por ELO)
   PLAN-coche-ranked.md

   Cargar SIEMPRE después de:
     js/auth.js   (usa FHAuth.ready() / FHAuth.getSession(), lleva la sesión)
     js/liga.js   (reutiliza FHLiga.TRAMOS/tramoInfo — mismos nombres/logos
                   de tramo que la liga de El Estadio, ver §2 del plan)

   Esta capa NO decide ninguna puntuación ni ELO — eso lo hace SIEMPRE
   api/ranked.js (el árbitro) o las RPC de solo lectura de Supabase. Aquí
   solo hay: la llamada HTTP al árbitro con el JWT de la sesión adjunto, las
   dos RPC de lectura (perfil/leaderboard) y tramoDeElo(), que es cosmética
   pura y DEBE ser idéntica a ranked_tramo_de_elo() en supabase/setup_ranked.sql
   y a TRAMOS_UMBRALES en api/ranked.js.

   API (window.FHRanked):
     TRAMOS_UMBRALES         → [0,350,550,750,950,1150,1350,1600]
     tramoDeElo(elo)         → 0..7
     call(action, payload)   → POST a /api/ranked con el JWT adjunto
     perfil(juego)           → ranked_perfil (RPC) — {auth,juegos:[...]}|null
     leaderboard(juego,n)    → ranked_leaderboard (RPC) — {juego,temporada,top,yo}|null
   ============================================= */
(function () {
  'use strict';

  if (!window.FHAuth) { console.error('[FHRanked] Falta auth.js'); return; }

  /* supabase-js se carga en diferido (ver js/auth.js): el cliente se pide
     con await FHAuth.ready() dentro de cada funcion, no al cargar. */

  const TRAMOS_UMBRALES = [0, 350, 550, 750, 950, 1150, 1350, 1600];

  function tramoDeElo(elo) {
    let t = 0;
    for (let i = 0; i < TRAMOS_UMBRALES.length; i++) if (elo >= TRAMOS_UMBRALES[i]) t = i;
    return t;
  }

  /* Llama a api/ranked.js con el JWT de la sesión actual. Lanza si no hay
     sesión, si la respuesta no es 2xx, o si el servidor devuelve {error}. */
  async function call(action, payload) {
    const session = await FHAuth.getSession();
    if (!session) throw new Error('Inicia sesión para jugar Clasificatoria');
    const res = await fetch('/api/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, jwt: session.access_token, ...payload }),
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* respuesta sin cuerpo JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `Error del servidor (HTTP ${res.status})`);
    return body;
  }

  async function perfil(juego) {
    try {
      const session = await FHAuth.getSession();
      if (!session) return { auth: false };
      const client = await FHAuth.ready();
      const { data, error } = await client.rpc('ranked_perfil', { p_user: session.user.id });
      if (error) { console.warn('[FHRanked] perfil:', error.message); return null; }
      return data;
    } catch (e) {
      console.warn('[FHRanked] perfil falló:', e);
      return null;
    }
  }

  async function leaderboard(juego, limit) {
    try {
      const client = await FHAuth.ready();
      const { data, error } = await client.rpc('ranked_leaderboard', { p_juego: juego, p_limit: limit || 100 });
      if (error) { console.warn('[FHRanked] leaderboard:', error.message); return null; }
      return data;
    } catch (e) {
      console.warn('[FHRanked] leaderboard falló:', e);
      return null;
    }
  }

  window.FHRanked = { TRAMOS_UMBRALES, tramoDeElo, call, perfil, leaderboard };
})();
