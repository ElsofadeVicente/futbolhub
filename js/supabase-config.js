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

/** URL pública de un archivo en Supabase Storage (buckets creados como públicos).
 *  Admite rutas con subcarpetas ("juego/archivo.json"): cada segmento se
 *  normaliza y codifica por separado para no convertir "/" en "%2F". */
function sbStorageUrl(bucket, name) {
    const key = String(name)
        .split('/')
        .map(part => encodeURIComponent(sbStorageSafeKey(part)))
        .join('/');
    return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`;
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
        sbStorageUrl, sbStorageSafeKey, fhImgUrl, FH_IMG_HOSTS_PROXY,
    };
}
