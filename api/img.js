/* =============================================
   API/IMG.JS — Proxy + caché propio de imágenes de Transfermarkt
   FUTBOLHUB

   Varios juegos muestran escudos y fotos de jugador que viven en las CDN de
   Transfermarkt (tmssl.akamaized.net, img.a.transfermarkt.technology) y se
   piden en el navegador directamente contra ese dominio: quien inspecciona
   la página o arrastra la imagen ve de dónde sale.

   Este endpoint hace de intermediario: la PRIMERA vez que se pide una
   imagen la trae de Transfermarkt, la deja guardada en el bucket
   'img-cache' de Supabase Storage (mismo proyecto que el resto de datos del
   juego) y la sirve; todas las veces siguientes — de cualquier visitante,
   no solo el mismo navegador — se sirve directo desde ahí, sin volver a
   tocar Transfermarkt. El Cache-Control largo hace que además Vercel cachee
   la respuesta en su CDN de borde, así que en régimen normal esto no es más
   lento que pedir la imagen en directo.

   fhImgUrl() en js/supabase-config.js es quien construye la URL que llega
   aquí (?u=<url original>, urlencoded). El allowlist de abajo tiene que
   llevar EXACTAMENTE los mismos hosts que esa función — si no, cualquiera
   podría usar este endpoint como proxy abierto hacia cualquier URL (SSRF).
   ============================================= */

'use strict';

const HOSTS_PERMITIDOS = ['tmssl.akamaized.net', 'img.a.transfermarkt.technology'];

const SUPABASE_URL = 'https://rssvejgdekwysiseqzkd.supabase.co';
const BUCKET = 'img-cache';
const SECRET = process.env.SUPABASE_SECRET_KEY;

// Un año: son fotos y escudos que Transfermarkt apenas cambia, y cuando lo
// hace es con un archivo NUEVO (el nombre lleva un sello de tiempo), así que
// una URL vieja servida en caché nunca queda "desactualizada" de verdad.
const CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';

/* tmssl.akamaized.net + /images/wappen/head/985.png
 *   -> tmssl-akamaized-net/images/wappen/head/985.png
 * Un prefijo por host para que escudos y fotos no compartan carpeta y un
 * mismo path en dos hosts distintos no choque. */
function claveStorage(origen) {
  const prefijo = origen.hostname.replace(/\./g, '-');
  return `${prefijo}${origen.pathname}`;
}

// Antes esto traía el archivo entero de Supabase Storage (GET + descarga
// completa del buffer) para volver a re-enviarlo byte a byte a través de
// esta función — un salto de red de más (Vercel -> Supabase -> Vercel ->
// navegador) en CADA imagen ya cacheada, que es el caso normal. Con miles
// de fotos por partida eso era el segundo incómodo que se notaba al cargar.
// Ahora solo se comprueba con HEAD (sin cuerpo) que el archivo existe, y se
// redirige al navegador directo a la URL pública de Storage: la imagen la
// sirve la CDN de Supabase sin volver a pasar por esta función.
async function existeEnCache(key) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const tipo = res.headers.get('content-type') || '';
    if (!tipo.startsWith('image/')) return null;
    return { url, tipo };
  } catch {
    return null;
  }
}

async function guardarEnCache(key, buf, tipo) {
  // Sin clave secreta (p.ej. un Preview de Vercel sin la variable puesta) no
  // se puede escribir en Storage: se sirve igual, solo que sin cachear.
  if (!SECRET) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
      method: 'POST',
      headers: {
        apikey: SECRET,
        Authorization: `Bearer ${SECRET}`,
        'Content-Type': tipo,
        'x-upsert': 'true',
      },
      body: buf,
    });
  } catch {
    // Si falla el guardado, la próxima visita simplemente vuelve a intentarlo.
  }
}

module.exports = async function handler(req, res) {
  const crudo = req.query.u;
  if (!crudo || typeof crudo !== 'string') {
    res.status(400).end('Falta ?u=');
    return;
  }

  let origen;
  try {
    origen = new URL(crudo);
  } catch {
    res.status(400).end('URL invalida');
    return;
  }
  if (!HOSTS_PERMITIDOS.includes(origen.hostname)) {
    res.status(400).end('Origen no permitido');
    return;
  }

  const key = claveStorage(origen);

  const cacheado = await existeEnCache(key);
  if (cacheado) {
    // writeHead a pelo (no res.redirect, que es un helper de Vercel que el
    // servidor de desarrollo local no reproduce) para que funcione igual
    // en dev-server.js y en producción.
    res.writeHead(301, { Location: cacheado.url, 'Cache-Control': CACHE_CONTROL });
    res.end();
    return;
  }

  let origenRes;
  try {
    origenRes = await fetch(origen.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FutbolHUB/1.0; +https://www.futbolhub.es)' },
    });
  } catch {
    res.status(502).end('No se pudo contactar con el origen');
    return;
  }
  if (!origenRes.ok) {
    res.status(origenRes.status).end('El origen no tiene esa imagen');
    return;
  }
  const tipo = origenRes.headers.get('content-type') || '';
  if (!tipo.startsWith('image/')) {
    res.status(502).end('La respuesta del origen no es una imagen');
    return;
  }
  const buf = Buffer.from(await origenRes.arrayBuffer());

  res.setHeader('Content-Type', tipo);
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.status(200).send(buf);

  // Vercel no da por terminada la función hasta que este handler resuelve,
  // aunque la respuesta ya se haya enviado al cliente con res.send() de
  // arriba — así que esto no añade espera para quien la está pidiendo.
  await guardarEnCache(key, buf, tipo);
};
