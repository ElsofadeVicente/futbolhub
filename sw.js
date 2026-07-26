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

const CACHE = 'futbolhub-v5';

/* Imágenes externas que queremos disponibles offline (La Carrera):
   escudos de club (tmssl) y retratos de jugador (transfermarkt). Son
   inmutables → cache-first aunque sean de otro origen (respuesta opaca). */
const EXTERNAL_IMG_HOSTS = ['tmssl.akamaized.net', 'img.a.transfermarkt.technology'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
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
        // Cachea también respuestas opacas (no-cors) de las CDNs de imágenes.
        if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // No interceptar el resto de orígenes (Firebase, tiles de OSM,
  // Street View, CDNs…) — que sigan su curso normal.
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
