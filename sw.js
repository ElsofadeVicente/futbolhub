/* =============================================
   SW.JS — Service Worker de FutbolHUB
   Estrategia:
   - Imágenes, fuentes y chunks de jugadores (pesados e inmutables):
     cache-first → la segunda visita carga al instante.
   - HTML / JS / CSS / JSON diarios: network-first con fallback a caché
     → siempre fresco si hay conexión, y funciona offline si no la hay.
   Sube la versión de CACHE para invalidar todo tras cambios grandes.
   ============================================= */
'use strict';

/* v12: hay que TIRAR las cachés anteriores enteras, no solo invalidar: las
   entradas guardadas hasta ahora llevan dentro la cabecera 'Content-Encoding:
   br' de Vercel con el cuerpo YA descomprimido (ver guardar() más abajo), y
   servir una de esas es justo lo que descargaba el archivo de 0 KB. */
const CACHE = 'futbolhub-v12';

/* Imágenes externas que queremos disponibles offline (La Carrera, Coche):
   escudos de club (tmssl) y retratos de jugador (transfermarkt). Son
   inmutables → cache-first aunque sean de otro origen (respuesta opaca).

   OJO con las respuestas opacas: una petición de <img> a otro dominio va
   en modo no-cors, así que la respuesta llega SIEMPRE con status 0 y
   ok=false, dé el servidor un 200 o un 404. Es decir: desde aquí no se
   puede distinguir una foto buena de un fallo puntual (un 429 por pedir
   muchas de golpe, un corte de red…). Guardar el fallo en una caché
   cache-first lo vuelve permanente: esa foto ya no vuelve a cargar nunca
   en ese dispositivo, aunque el jugador sí tenga foto en la base.

   Por eso quien avisa de que una entrada está mal es la página, que sí lo
   sabe (le salta el onerror de la <img>): js/img-heal.js la borra de aquí
   y reintenta. Ver también el mensaje 'drop-image' de abajo. */
const EXTERNAL_IMG_HOSTS = ['tmssl.akamaized.net', 'img.a.transfermarkt.technology'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

/* La página avisa de una imagen que no ha cargado: fuera de la caché,
   para que el siguiente intento vaya a la red y se guarde la buena. */
self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || data.type !== 'drop-image' || !data.url) return;
  e.waitUntil((async () => {
    try {
      const url = new URL(data.url);
      const cache = await caches.open(CACHE);
      await cache.delete(url.origin + url.pathname);
    } catch (err) { /* url rara: nada que borrar */ }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Borrar cachés de versiones anteriores
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ¿Recurso "estático" que apenas cambia? → cache-first */
function isStaticAsset(url) {
  if (/\.(png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|mp3|ogg)$/i.test(url.pathname)) return true;
  if (url.pathname.includes('/chunks/'))  return true;   // datos de jugadores (varios MB)
  if (url.pathname.includes('/logos/'))   return true;
  if (url.pathname.includes('/flags/'))   return true;
  if (url.pathname.includes('/photos/'))  return true;
  return false;
}

/* ── GUARDAR EN CACHÉ SIN ENVENENARLA ──────────────────────────────────
   Vercel sirve el HTML (y el JS, y el CSS) comprimido:

     Content-Encoding: br
     Content-Disposition: inline; filename="el-estadio"
     X-Content-Type-Options: nosniff

   fetch() te entrega el cuerpo YA descomprimido, pero la Response conserva
   esa cabecera 'Content-Encoding: br'. Al meterla tal cual en la Cache API
   se guarda la pareja imposible: cuerpo en claro + cabecera que dice que
   viene en brotli. La próxima vez que se sirva desde caché (o sea, cuando
   falle la red: justo lo que pasa a cada rato en un móvil), el navegador
   intenta descomprimir algo que ya está descomprimido, se queda sin cuerpo,
   y con 'nosniff' no puede rescatarlo adivinando el tipo → lo trata como
   descarga y usa el filename de Content-Disposition.

   De ahí el archivo de 0 KB llamado 'el-estadio' al entrar en el juego, o
   'www.futbolhub.es' (la raíz no lleva filename, así que el navegador cae
   al nombre del host) al pulsar "← Volver".

   Por eso se guarda una copia con las cabeceras de transporte fuera. Se va
   también Content-Disposition: no aporta nada aquí y es la que convierte
   cualquier tropiezo futuro en una descarga en vez de en una página fea. */
function limpiar(res) {
  const h = new Headers(res.headers);
  h.delete('content-encoding');
  h.delete('content-length');
  h.delete('content-disposition');
  return h;
}

async function guardar(cache, key, res) {
  try {
    if (!res || !res.ok || res.type === 'opaqueredirect' || res.redirected) return;
    const h = limpiar(res);
    /* Sin tipo declarado, 'nosniff' no deja al navegador adivinar y acabaría
       en descarga otra vez. Mejor no guardarlo. */
    if (!h.get('content-type')) return;
    const cuerpo = await res.blob();
    if (!cuerpo.size) return;   // respuesta cortada a medias: no vale de nada
    await cache.put(key, new Response(cuerpo, {
      status: res.status, statusText: res.statusText, headers: h,
    }));
  } catch (err) {
    /* Cuota llena, almacenamiento capado en incógnito, respuesta rara: que no
       se guarde no es motivo para tumbar la petición, que ya está servida. */
  }
}

/* waitUntil lanza si el evento ya se cerró (respuesta servida y SW a punto
   de dormirse). Guardar es opcional; fallar aquí no lo es. */
function enSegundoPlano(e, promesa) {
  try { e.waitUntil(promesa); } catch (err) { /* evento cerrado: se pierde la copia */ }
}

/* Red de seguridad para lo que ya estuviera guardado mal (otra versión del
   SW, una caché que sobreviva a la limpieza): si la entrada trae cabecera de
   compresión, se reconstruye antes de devolverla. */
function servir(hit) {
  if (!hit || !hit.headers.get('content-encoding')) return hit;
  return new Response(hit.body, {
    status: hit.status, statusText: hit.statusText, headers: limpiar(hit),
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Escudos y retratos externos de La Carrera → cache-first (offline).
  if (EXTERNAL_IMG_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = url.origin + url.pathname;
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // Cachea también respuestas opacas (no-cors) de las CDNs de imágenes:
        // no hay forma de mirar dentro, así que si la foto viene mal la
        // borrará la página con el mensaje 'drop-image'.
        if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // No interceptar el resto de orígenes (Firebase, tiles de OSM, Street View,
  // CDNs, y también anuncios/analítica como AdSense) — que sigan su curso
  // normal y NUNCA se cacheen aquí.
  if (url.origin !== self.location.origin) return;

  // Clave de caché SIN query: varios juegos usan cache-busting (?v=timestamp)
  // y sin esto cada visita añadiría una copia nueva a la caché para siempre.
  const cacheKey = url.origin + url.pathname;

  if (isStaticAsset(url)) {
    // CACHE-FIRST
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(cacheKey);
      if (hit) return servir(hit);
      try {
        const res = await fetch(req);
        enSegundoPlano(e, guardar(cache, cacheKey, res.clone()));
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
  } else {
    // NETWORK-FIRST con fallback a caché (offline)
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        enSegundoPlano(e, guardar(cache, cacheKey, res.clone()));
        return res;
      } catch (err) {
        const hit = await cache.match(cacheKey);
        if (hit) return servir(hit);
        throw err;
      }
    })());
  }
});
