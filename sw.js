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

/* v11: imagenes del hub y logos de liga reoptimizados (pesaban hasta 20x lo
   que debian). Como van por cache-first, sin subir la version los que ya
   entraron seguirian viendo las viejas para siempre. */
const CACHE = 'futbolhub-v11';

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
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(cacheKey, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
  } else {
    // NETWORK-FIRST con fallback a caché (offline)
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(cacheKey, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
