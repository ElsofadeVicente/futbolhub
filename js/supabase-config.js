/* =============================================
   SUPABASE-CONFIG.JS
   Configuracion compartida para todos los juegos.
   La "publishable key" es segura de exponer en el navegador
   (equivalente a la antigua "anon key"): con RLS activado solo
   permite lectura publica, nunca escritura.
   ============================================= */
const SUPABASE_URL = "https://rssvejgdekwysiseqzkd.supabase.co";
const SUPABASE_KEY  = "sb_publishable_sb0W0JZJJv3uLJOaKU525g_aPsH6Xk1";

const SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
};

/** Llamada genérica a la API REST de Supabase (PostgREST). */
async function sbFetch(path, { headers = {}, ...opts } = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: { ...SB_HEADERS, ...headers },
    });
    if (!res.ok) {
        throw new Error(`[Supabase] HTTP ${res.status} en ${path}: ${await res.text()}`);
    }
    return res.json();
}

/**
 * Como Supabase limita cada respuesta a 1000 filas, esta función pagina
 * automáticamente hasta traer la tabla completa. Úsala solo con tablas
 * pequeñas que necesites entera en memoria (teams, leagues, national...).
 */
async function sbFetchAll(path, pageSize = 1000) {
    const all = [];
    let offset = 0;
    const sep = path.includes("?") ? "&" : "?";
    while (true) {
        const page = await sbFetch(`${path}${sep}limit=${pageSize}&offset=${offset}`);
        all.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
    }
    return all;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SUPABASE_URL, SUPABASE_KEY, SB_HEADERS, sbFetch, sbFetchAll };
}
