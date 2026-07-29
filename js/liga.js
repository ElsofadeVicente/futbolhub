/* =============================================
   LIGA.JS — Modo competitivo (divisiones + ELO por tramos)
   QUIÉN COÑO FALTA

   Capa de datos COMPARTIDA para el modo competitivo de los juegos.
   El primero que la usa es El Estadio, pero está pensada para reutilizarse:
   cada juego pasa su propio identificador ("juego") y pinta su panel a su
   manera; esta capa solo habla con Supabase.

   Cargar SIEMPRE después de js/auth.js (usa FHAuth.client, que lleva la
   sesión del usuario, así las RPC ven auth.uid()).

   Requiere haber ejecutado supabase/setup_liga.sql en la base de datos.

   Cómo funciona (resumen — el detalle está en el SQL):
     · Liga semanal por divisiones de 50, 8 tramos (Tercera → Mundial).
     · Cada día sumas el total de la partida diaria a tu marcador semanal.
     · Al cerrar la semana suben los 10 mejores y bajan los 10 peores.
     · Top 100 mensual aparte, solo entre jugadores de Mundial.

   API (window.FHLiga):
     TRAMOS                → nombres/insignias de los 8 tramos (0..7).
     tramoInfo(n)          → { nombre, corto, emoji } del tramo n.
     enviarDiario(juego,d) → sube el resultado del día. El servidor RECALCULA
                             la puntuación: pásale d = { pistas: [{id,lat,lng}
                             × 5] } (lo que jugaste: estadio + dónde pusiste el
                             pin) y él saca el total con las coords reales.
                             Devuelve {tramo,...}|null.
     panel(juego)          → clasificación de tu división. {auth:false} si no
                             hay sesión. null si falla.
     top100(juego)         → Top 100 mensual de Mundial. null si falla.
   ============================================= */
(function () {
    'use strict';

    if (!window.FHAuth) { console.error('[FHLiga] Falta auth.js'); return; }
    const client = FHAuth.client;

    /* Logos: escudos reales de cada categoría (Transfermarkt para las
       españolas, los trofeos que ya usa La Carrera para las europeas/Mundial).
       Ruta relativa a la carpeta del juego (un nivel bajo la raíz, como el
       resto de la web: "../img/..."), archivos en img/logos/tramos/. */
    const LOGO_BASE = '../img/logos/tramos/';

    /* Los 8 tramos de la escalera, de abajo (0) a arriba (7). Los nombres
       viven aquí y no en la base de datos: allí el tramo es solo un número. */
    const TRAMOS = [
        { nombre: 'Tercera División',  corto: 'Tercera',    emoji: '🟤', logo: LOGO_BASE + 'tercera.png' },
        { nombre: 'Segunda B',         corto: 'Segunda B',  emoji: '🟫', logo: LOGO_BASE + 'segunda-b.png' },
        { nombre: 'Segunda División',  corto: 'Segunda',    emoji: '⚪', logo: LOGO_BASE + 'segunda.png' },
        { nombre: 'Primera División',  corto: 'Primera',    emoji: '🔵', logo: LOGO_BASE + 'primera.png' },
        { nombre: 'Conference League', corto: 'Conference', emoji: '🟢', logo: LOGO_BASE + 'conference.png' },
        { nombre: 'Europa League',     corto: 'Europa',     emoji: '🟠', logo: LOGO_BASE + 'europa.png' },
        { nombre: 'Champions League',  corto: 'Champions',  emoji: '⭐', logo: LOGO_BASE + 'champions.png' },
        { nombre: 'Mundial',           corto: 'Mundial',    emoji: '🏆', logo: LOGO_BASE + 'mundial.png' },
    ];

    function tramoInfo(n) {
        const i = Math.max(0, Math.min(TRAMOS.length - 1, Number(n) || 0));
        return TRAMOS[i];
    }

    async function enviarDiario(juego, datos) {
        try {
            // El servidor recalcula la puntuación desde las pistas: nunca
            // mandamos el total (ver supabase/setup_liga_recompute.sql).
            const params = { p_juego: juego };
            if (datos && Array.isArray(datos.pistas)) {
                params.p_pistas = datos.pistas;
            } else {
                console.warn('[FHLiga] enviarDiario sin pistas: no se sube nada.');
                return null;
            }
            const { data, error } = await client.rpc('liga_enviar_diario', params);
            if (error) { console.warn('[FHLiga] enviarDiario:', error.message); return null; }
            return data;
        } catch (e) {
            console.warn('[FHLiga] enviarDiario falló:', e);
            return null;
        }
    }

    async function panel(juego) {
        try {
            const { data, error } = await client.rpc('liga_panel', { p_juego: juego });
            if (error) { console.warn('[FHLiga] panel:', error.message); return null; }
            return data;
        } catch (e) {
            console.warn('[FHLiga] panel falló:', e);
            return null;
        }
    }

    async function top100(juego) {
        try {
            const { data, error } = await client.rpc('liga_top100', { p_juego: juego });
            if (error) { console.warn('[FHLiga] top100:', error.message); return null; }
            return data;
        } catch (e) {
            console.warn('[FHLiga] top100 falló:', e);
            return null;
        }
    }

    window.FHLiga = { TRAMOS, tramoInfo, enviarDiario, panel, top100 };
})();
