/* =============================================
   API/DATA.JS — Proxy + caché de CDN para los JSON de datos de juego
   FUTBOLHUB

   EL PROBLEMA QUE RESUELVE (medido el 2026-09-02 contra producción):
   un visitante nuevo a Coche, Bingo, Tres en Raya o Superdraft descarga
   1,48 MB DE SUPABASE antes de poder jugar — los 15 chunks de jugadores
   (945 KB comprimidos) más los 8 archivos de data/general (535 KB). Con el
   plan Free de Supabase (5 GB de egress al mes) eso son ~3.600 partidas y
   se acabó el mes. Un solo vídeo que funcione en redes lo agota en un día.

   Este endpoint hace de intermediario igual que api/img.js hace con las
   imágenes: pide el archivo a Supabase Storage UNA vez, y a partir de ahí
   lo sirve la CDN de Vercel a todo el mundo (s-maxage). O sea que Supabase
   pasa de N descargas a una por región y por hora, y el techo lo pone
   Vercel (100 GB) en vez de Supabase (5 GB): 20 veces más margen.

   QUÉ PASA POR AQUÍ Y QUÉ NO — importa:
   · Los datos GORDOS y que cambian poco: chunks de jugadores, data/general,
     name-index, transfers, performances. Son los que se llevan el ancho de
     banda, y se enrutan uno a uno con fhDataUrl/fhFetchData.
   · Las IMÁGENES de los cinco buckets de escudos/banderas/logos/fotos, que
     además Supabase manda con `Cache-Control: no-cache`. Una partida de
     Superdraft precarga 49 (~666 KB). Las enruta sbStorageUrl en bloque.
   · NO pasa el contenido diario (crucigrama/2026-09.json, en-el-top/...):
     pesa unos pocos KB, así que no mueve la aguja, y ahí la frescura sí
     importa — una edición del día servida en caché una hora de más sería un
     bug visible. Sigue yendo directo a Supabase.

   SSRF: al revés que api/img.js, aquí NO se acepta una URL del cliente. La
   URL se construye con un SUPABASE_URL fijo, un bucket de la lista blanca y
   una clave saneada, así que no hay forma de apuntar esto a otro host.
   ============================================= */

'use strict';

const SUPABASE_URL = 'https://rssvejgdekwysiseqzkd.supabase.co';

// Buckets públicos que se sirven por aquí: los dos de datos de juego y los
// cinco de imagen (escudos, banderas, logos de liga, fotos de entrenador,
// iconos de trofeo). Añadir uno aquí es todo lo que hace falta para poder
// servirlo, pero piénsalo dos veces: lo que entre se cachea una hora en la CDN.
const BUCKETS_PERMITIDOS = [
  'player-db', 'game-data',
  'team-logos', 'team-flags', 'league-logos', 'coach-photos', 'trophy-icons',
];

/* max-age=300  : el navegador no vuelve a pedirlo en 5 minutos. Esto solo ya
 *                arregla que pasar de Coche a Bingo (que comparten los MISMOS
 *                datos) se volviera a bajar 1,48 MB por el `cache:'no-cache'`
 *                que llevaban estos fetch.
 * s-maxage=3600: la CDN de Vercel lo sirve una hora sin tocar Supabase. Es lo
 *                que hace que un pico de tráfico no se coma el egress.
 * SWR 24h      : pasada la hora sirve la copia vieja y la refresca por detrás,
 *                así que nadie espera nunca a Supabase.
 *
 * El precio: tras un `sync.bat players` puede haber hasta una hora sirviendo
 * datos de jugador de antes. Para un valor de mercado o un club que cambian
 * cada varias semanas, es irrelevante. Si alguna vez hiciera falta forzarlo,
 * basta con añadir un ?v= distinto a la URL desde el cliente.
 */
const CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

/* Las IMÁGENES aguantan mucho más que los datos: un escudo o una bandera no
 * cambian nunca, y cuando cambian es porque alguien ha vuelto a subir el
 * archivo a mano. Un día de caché de navegador y una semana de CDN ahorra
 * repetir ~666 KB cada vez que se pasa de un juego a otro; el precio es que
 * tras re-subir un escudo puede verse el viejo un día. Si algún día molesta,
 * la salida es versionar el nombre del archivo, no bajar esto. */
const CACHE_CONTROL_IMG = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800';
const BUCKETS_IMAGEN = ['team-logos', 'team-flags', 'league-logos', 'coach-photos', 'trophy-icons'];

/** Sanea la clave. Los buckets son públicos, así que aquí no se protege un
 *  secreto: se trata de que no se pueda construir una URL que signifique otra
 *  cosa para Storage (subir de directorio, colar una query...). */
function claveValida(k) {
  if (typeof k !== 'string' || !k || k.length > 300) return false;
  if (k.startsWith('/') || k.includes('..') || k.includes('//')) return false;
  // Control, comillas y los que separan partes de una URL. Todo lo demás
  // (espacios, "&", acentos...) se deja pasar y se codifica al construirla.
  return !/[\u0000-\u001f\u007f?#\\"'<>]/.test(k);
}

/** Codifica la clave segmento a segmento, igual que sbStorageUrl en el cliente:
 *  hay que codificar cada parte SIN convertir las "/" en %2F. Sin esto, un
 *  escudo como "Brighton_&_Hove_Albion.png" metía un "&" crudo en la URL de
 *  origen y Storage veía una query donde había un nombre de archivo. */
function claveCodificada(k) {
  return k.split('/').map(encodeURIComponent).join('/');
}

module.exports = async function handler(req, res) {
  const bucket = req.query.b;
  const clave = req.query.k;

  if (!BUCKETS_PERMITIDOS.includes(bucket)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(400).end('Bucket no permitido');
    return;
  }
  if (!claveValida(clave)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(400).end('Clave no valida');
    return;
  }

  const urlDe = k => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${claveCodificada(k)}`;

  /* WEBP PRIMERO. `admin/optimizar_imagenes.py` deja un .webp al lado de cada
   * imagen que se beneficie (23,4 MB -> 3,8 MB en total, un 84%), pero los
   * ~140 sitios de llamada del cliente siguen pidiendo el .png de siempre.
   * En vez de tocarlos todos, se resuelve aqui: se prueba el .webp y, si no
   * existe, se sirve el original.
   *
   * NO se mira la cabecera Accept a proposito. Hacerlo obligaria a mandar
   * `Vary: Accept`, y como el Accept varia muchisimo entre navegadores eso
   * fragmentaria la cache de la CDN — que es justo lo que da valor a todo
   * esto. WebP lo soporta cualquier navegador desde Safari 14 (2020), asi
   * que se sirve siempre y punto.
   *
   * El precio es una peticion de mas a Storage cuando NO hay webp (las 169
   * banderas y escudos pequenos donde WebP no compensaba). Se paga una vez
   * por region y por hora: a partir de ahi contesta la CDN. */
  const mAlt = /^(.+)\.(png|jpe?g)$/i.exec(clave);
  let url = urlDe(clave);
  if (mAlt) {
    const webp = mAlt[1] + '.webp';
    try {
      const r = await fetch(urlDe(webp), { method: 'HEAD' });
      if (r.ok) url = urlDe(webp);
    } catch { /* se queda con el original */ }
  }

  let origen;
  try {
    // 'identity' a propósito: Supabase sirve estos JSON con Content-Encoding:
    // br. Si se dejara negociar, habría que reenviar el cuerpo comprimido y
    // su cabecera a mano — y una cabecera de compresión mal reenviada es
    // exactamente el bug del archivo de 0 KB que costó seis versiones de
    // sw.js (ver CLAUDE.md). Pidiéndolo sin comprimir, aquí se maneja texto
    // plano y es Vercel quien comprime al salir hacia el navegador.
    origen = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  } catch {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(502).end('No se pudo contactar con Storage');
    return;
  }

  if (!origen.ok) {
    // El 404 se cachea corto: si el archivo aún no está subido, que no se
    // quede una hora dando error cuando aparezca.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30');
    res.status(origen.status).end('Storage devolvio ' + origen.status);
    return;
  }

  const buf = Buffer.from(await origen.arrayBuffer());

  // Content-Type SIEMPRE. Safari no pinta una respuesta sin tipo: la ofrece
  // como archivo (ver la v19 en CLAUDE.md).
  res.setHeader('Content-Type', origen.headers.get('content-type') || 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', BUCKETS_IMAGEN.includes(bucket) ? CACHE_CONTROL_IMG : CACHE_CONTROL);
  const etag = origen.headers.get('etag');
  if (etag) res.setHeader('ETag', etag);
  res.status(200).send(buf);
};
