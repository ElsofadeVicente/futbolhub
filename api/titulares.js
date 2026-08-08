/* =============================================
   API/TITULARES.JS — Titulares de fútbol para el ticker del hub
   QUIÉN COÑO FALTA

   Función serverless de Vercel. El ticker de la portada llevaba texto
   escrito a mano ("LA CARRERA · NUEVO JUEGO", "EL ONCE #124 LISTO") que se
   quedó viejo en cuanto salieron juegos nuevos. Ahora trae titulares de
   verdad de la prensa deportiva española.

   POR QUÉ UNA FUNCIÓN Y NO UN FETCH DESDE EL NAVEGADOR:
   los RSS de Marca/AS/MD no mandan CORS, así que el navegador no puede
   leerlos directamente. Además así se pide UNA vez cada 10 minutos para
   todos los visitantes (la CDN de Vercel cachea la respuesta) en vez de
   una vez por visitante, que sería castigar al medio que nos lo da gratis.

   QUÉ DEVUELVE:
     { titulares: [{ t: "titular", u: "url", s: "MARCA" }, ...], ts: 1234 }

   Solo titular + enlace a la noticia original, que es justo para lo que
   está un RSS. Nada de copiar el cuerpo del artículo.
   ============================================= */

'use strict';

const FUENTES = [
  { nombre: 'MARCA', url: 'https://e00-marca.uecdn.es/rss/futbol/primera-division.xml' },
  // OJO con AS: sus feeds antiguos (as.com/rss/futbol/primera.xml,
  // as.com/rss/futbol/portada.xml) siguen devolviendo HTTP 200 pero están
  // ABANDONADOS — el contenido más nuevo que tienen es de junio/agosto de
  // 2022. Por ahí se coló un "acuerdo Madrid-Mónaco por Tchouaméni" de hace
  // cuatro años. El bueno es este, el de su CMS actual (Arc).
  { nombre: 'AS',    url: 'https://as.com/arc/outboundfeeds/rss/category/futbol/?outputType=xml' },
  { nombre: 'MD',    url: 'https://www.mundodeportivo.com/feed/rss/futbol/' },
  { nombre: 'SPORT', url: 'https://www.sport.es/es/rss/futbol/rss.xml' },
];

const POR_FUENTE   = 6;      // titulares que cogemos de cada medio
const TOTAL_MAX    = 18;     // los que devolvemos al final
const TIMEOUT_MS   = 4000;   // si un medio tarda más, se va sin él

/* Ventana de frescura. Cualquier titular más viejo que esto se descarta, y
   también los que no traigan una fecha que se pueda leer.
   No es paranoia: un feed puede quedarse congelado años y seguir
   respondiendo 200 tan tranquilo (le pasó al de AS). Sin este filtro el
   ticker de "última hora" enseñaba fichajes de 2022 como si fueran de hoy.
   72 h da margen de sobra para un domingo flojo sin colar nada rancio. */
const MAX_ANTIGUEDAD_MS = 72 * 60 * 60 * 1000;

/* Entidades XML/HTML más comunes en titulares en castellano. */
const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°', euro: '€',
};

function decodificar(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => (e in ENTIDADES ? ENTIDADES[e] : m))
    .replace(/<[^>]*>/g, '')      // por si el título trae marcado dentro
    .replace(/\s+/g, ' ')
    .trim();
}

/* Fecha de publicación del item. Los cuatro feeds usan <pubDate> (RFC 822),
   pero alguno mete <dc:date> (ISO) — se prueban los dos. */
function fechaDe(item) {
  const crudo = (item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1]
             || (item.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1];
  if (!crudo) return NaN;
  return Date.parse(decodificar(crudo));
}

/* Saca <title>, <link> y la fecha de cada <item> del RSS. Nada de
   dependencias: estos feeds son RSS 2.0 planos y no compensa meter un
   parser entero. */
function parsearRss(xml, nombre, ahora) {
  const out = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const t = decodificar((item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const u = decodificar((item.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    const f = fechaDe(item);

    if (!t || t.length < 12) continue;
    if (!/^https:\/\//i.test(u)) continue;          // enlace raro → fuera
    if (!f) continue;                               // sin fecha legible → fuera
    if (ahora - f > MAX_ANTIGUEDAD_MS) continue;    // rancio → fuera
    if (f - ahora > 24 * 60 * 60 * 1000) continue;  // fechado en el futuro → fuera

    out.push({ t: t.length > 110 ? t.slice(0, 107).trimEnd() + '…' : t, u, s: nombre, f });
  }
  // Lo más nuevo primero, y nos quedamos con los N mejores de cada medio.
  out.sort((a, b) => b.f - a.f);
  return out.slice(0, POR_FUENTE);
}

async function traer(fuente, ahora) {
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(fuente.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'FutbolHUB/1.0 (+https://www.futbolhub.es)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!res.ok) return [];
    return parsearRss(await res.text(), fuente.nombre, ahora);
  } catch {
    return [];   // un medio caído no puede tumbar el ticker
  } finally {
    clearTimeout(kill);
  }
}

/* Intercala los medios (MARCA, AS, MD, SPORT, MARCA, AS…) para que el
   ticker no enseñe seis titulares seguidos del mismo periódico. */
function intercalar(listas) {
  const out = [];
  const max = Math.max(0, ...listas.map(l => l.length));
  for (let i = 0; i < max; i++) {
    for (const lista of listas) {
      if (lista[i]) out.push(lista[i]);
    }
  }
  return out.slice(0, TOTAL_MAX);
}

module.exports = async function handler(req, res) {
  const ahora = Date.now();
  const listas = await Promise.all(FUENTES.map(f => traer(f, ahora)));
  // La marca de tiempo solo servía para ordenar y filtrar: fuera del JSON.
  const titulares = intercalar(listas).map(({ t, u, s }) => ({ t, u, s }));

  // Cache en la CDN de Vercel: 10 min fresco + 1 h sirviendo el anterior
  // mientras revalida. Si los medios fallan, el ticker sigue con lo último
  // bueno en vez de quedarse en blanco.
  res.setHeader(
    'Cache-Control',
    titulares.length
      ? 'public, s-maxage=600, stale-while-revalidate=3600'
      : 'public, s-maxage=60'      // sin nada que dar, reintentar pronto
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).end(JSON.stringify({ titulares, ts: Date.now() }));
};
