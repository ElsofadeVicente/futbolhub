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

/**
 * Quita acentos/diéresis/eñes de un nombre de archivo para que coincida con
 * la clave real en Supabase Storage (los buckets rechazan claves no-ASCII;
 * ver admin/upload_images_to_storage.py:safe_key, misma normalización).
 */
function sbStorageSafeKey(name) {
    return String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/* Buckets de IMAGEN (escudos, banderas, logos de liga, fotos de entrenador,
 * iconos de trofeo). Se sirven por api/data.js en vez de directos a Supabase:
 * son ~140 sitios de llamada repartidos por los 14 juegos y pesan lo suyo —
 * una partida de Superdraft precarga 49 imagenes, unos 666 KB. Supabase las
 * manda ademas con `Cache-Control: no-cache`, asi que hoy se revalidan todas
 * en cada carga; por el proxy van con cache de CDN y de navegador.
 *
 * Los buckets de DATOS (player-db, game-data) NO estan aqui a proposito: sus
 * lecturas ya se enrutan una a una con fhDataUrl/fhFetchData, porque ahi hay
 * que distinguir lo estatico (se cachea) de la edicion del dia (no). */
const FH_BUCKETS_IMAGEN = ['team-logos', 'team-flags', 'league-logos', 'coach-photos', 'trophy-icons'];

/** URL pública de un archivo en Supabase Storage (buckets creados como públicos).
 *  Admite rutas con subcarpetas ("juego/archivo.json"): cada segmento se
 *  normaliza y codifica por separado para no convertir "/" en "%2F".
 *
 *  Para los buckets de imagen devuelve la URL de nuestro proxy cacheado, y
 *  ABSOLUTA (no "/api/data?…") para no cambiarle el contrato a quien haga
 *  `new URL(sbStorageUrl(...))`. Fuera del navegador (Node, tests) no hay
 *  origen al que apuntar, así que se sigue devolviendo la de Supabase. */
function sbStorageUrl(bucket, name) {
    const key = String(name)
        .split('/')
        .map(part => encodeURIComponent(sbStorageSafeKey(part)))
        .join('/');
    if (FH_BUCKETS_IMAGEN.includes(bucket) && typeof location !== "undefined" && location.origin) {
        return `${location.origin}/api/data?b=${bucket}&k=${key}`;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`;
}

/* URL del mismo archivo pero a través de api/data.js, que lo cachea en la CDN
 * de Vercel. Solo para los datos GORDOS y que cambian poco (chunks de
 * jugadores, data/general, name-index): son 1,48 MB por visitante nuevo y con
 * el plan Free de Supabase (5 GB/mes) eso son ~3.600 partidas al mes. El
 * contenido diario NO debe pasar por aquí — pesa poco y ahí la frescura
 * importa. Ver el comentario de cabecera de api/data.js. */
function fhDataUrl(bucket, name) {
    const key = String(name)
        .split('/')
        .map(part => sbStorageSafeKey(part))
        .join('/');
    return `/api/data?b=${encodeURIComponent(bucket)}&k=${encodeURIComponent(key)}`;
}

/**
 * Pide un archivo de datos por el proxy cacheado y, si eso falla por lo que
 * sea, lo vuelve a pedir directo a Supabase.
 *
 * El respaldo no es paranoia: sin él, cualquier entorno sin funciones de api/
 * (un `python -m http.server`, un Preview mal configurado) dejaría a los
 * juegos sin datos, y un fallo del proxy en producción tumbaría Coche, Bingo,
 * Tres en Raya y Superdraft a la vez. Con él, lo peor que pasa es que se
 * vuelve al comportamiento de antes: funciona, solo que sin cachear.
 *
 * Devuelve la Response (ya comprobada con res.ok) o lanza, para que quien
 * llama distinga "no hay datos" de "no se pudo pedir" — que es justo lo que
 * confundía el catch-devuelve-null de La Carrera (ver CLAUDE.md).
 */
async function fhFetchData(bucket, name, opts = {}) {
    try {
        const res = await fetch(fhDataUrl(bucket, name), opts);
        if (res.ok) return res;
    } catch { /* al respaldo */ }
    const res = await fetch(sbStorageUrl(bucket, name), opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${bucket}/${name}`);
    return res;
}

/* Hosts de Transfermarkt cuyas imágenes NO se sirven en directo: se ve el
 * dominio de origen al inspeccionar o arrastrar la imagen, y son fotos y
 * escudos que no nos pertenecen. fhImgUrl() las reescribe para que pasen por
 * api/img.js, que las cachea en el bucket 'img-cache' de Supabase Storage la
 * primera vez que se piden y las sirve desde ahí (mismo dominio, futbolhub.es)
 * el resto de veces. Si se añade un host aquí, hay que añadirlo también al
 * allowlist de api/img.js (HOSTS_PERMITIDOS) o el proxy los rechaza con 400. */
const FH_IMG_HOSTS_PROXY = ["tmssl.akamaized.net", "img.a.transfermarkt.technology"];

/**
 * Reescribe una URL de imagen externa de Transfermarkt para que pase por
 * nuestro proxy/caché propio. Las URLs que ya son nuestras (Supabase Storage,
 * mismo origen, data:/blob:) o vacías se devuelven tal cual — es un no-op
 * seguro para llamarlo siempre, aunque el campo no sea de Transfermarkt.
 */
function fhImgUrl(url) {
    if (!url) return url;
    let u;
    try {
        u = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    } catch {
        return url;
    }
    if (!FH_IMG_HOSTS_PROXY.includes(u.hostname)) return url;
    return `/api/img?u=${encodeURIComponent(u.href)}`;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        SUPABASE_URL, SUPABASE_KEY, SB_HEADERS, sbFetch, sbFetchAll,
        sbStorageUrl, sbStorageSafeKey, fhDataUrl, fhFetchData, FH_BUCKETS_IMAGEN,
        fhImgUrl, FH_IMG_HOSTS_PROXY,
    };
}
