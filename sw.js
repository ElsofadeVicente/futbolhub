/* =============================================
   SW.JS — Service Worker de FutbolHUB
   Estrategia:
   - Imágenes, fuentes y chunks de jugadores (pesados e inmutables):
     cache-first → la segunda visita carga al instante.
   - JS / CSS / JSON diarios: network-first con fallback a caché
     → siempre fresco si hay conexión, y funciona offline si no la hay.
   - Navegaciones (el HTML de cada página): NO se interceptan, ver el
     comentario de esNavegacion() más abajo — es la parte que ha dado
     problemas (el archivo de 0 KB) y ya no la toca el service worker.
   Sube la versión de CACHE para invalidar todo tras cambios grandes.
   ============================================= */
'use strict';

/* v15: las navegaciones dejan de pasar por el service worker (ver el
   comentario de más abajo, en la rama de 'esNavegacion'): v13 ya no clonaba
   el cuerpo y aun así se seguía viendo el archivo de 0 KB, reportado el
   2026-08-28 en iPhone/Safari. v14 solo forzó un refresco de versión; v12
   antes de eso limpió las cabeceras de la COPIA en caché.
   v16: se quita self.skipWaiting() del install (ver el comentario de esa
   rama) por un fallo DISTINTO — pantalla en blanco sin forma de recargar en
   la PWA de iOS — reportado el 2026-08-29. */
const CACHE = 'futbolhub-v16';

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

/* v16: ya NO se llama a self.skipWaiting() aquí. Reportado 2026-08-29 en la
   PWA instalada de iOS: al pulsar "Volver" dentro de una sesión ya abierta
   (La Carrera → hub), la pantalla se quedaba en BLANCO y sin ninguna forma de
   recargar (una PWA standalone no tiene barra de URL ni botón de refrescar,
   así que quedarse así es quedarse atascado del todo hasta forzar el cierre
   de la app). No es el mismo síntoma que el archivo de 0 KB de más abajo (ahí
   se descargaba un archivo; aquí no pasa nada, ni error ni descarga).

   skipWaiting() fuerza a un service worker recién instalado a pasar a
   'activate' YA, aunque la pestaña/PWA que sigue abierta esté controlada por
   el anterior — es justo la combinación que WebKit tiene documentada como
   inestable (bugs.webkit.org #261767, "FetchEvent.respondWith received an
   error: TypeError: Internal error", con página en blanco de resultado): si
   la navegación de "Volver" dispara a la vez la comprobación de actualización
   del SW, activate y skipWaiting corren en paralelo con esa navegación, y en
   ciertas versiones de iOS el resultado es que la petición se queda sin
   resolver para siempre.

   Sin skipWaiting(), el SW nuevo se queda 'esperando' hasta que no quede
   ninguna pestaña/PWA controlada por el viejo — o sea, hasta que el usuario
   cierre la app del todo y la vuelva a abrir. Es el ciclo de vida estándar de
   un service worker (el que tiene cualquier sitio que no llame a
   skipWaiting), y aquí no cuesta nada: el JS/CSS de cada página ya va
   NETWORK-FIRST (ver más abajo), así que la frescura no depende de qué
   versión del SW esté activa en ese momento — solo cambia CUÁNDO se limpian
   las cachés viejas y se activa `clients.claim()`, que ahora pasa en el
   arranque limpio siguiente, no a mitad de una sesión con páginas abiertas. */
self.addEventListener('install', (e) => {});

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

/* ¿Es la navegación a una página (el HTML), y no un recurso de dentro?
   'navigate' cubre pestaña, iframe y volver atrás; destination es el
   respaldo para motores que no rellenen mode. Desde v15 lo que decide esta
   función es si el service worker se aparta del todo de la petición (ver
   la rama de abajo) — así que un falso negativo aquí no da un archivo de
   0 KB, solo hace que ESA URL pase por network-first con caché como si
   fuera un recurso cualquiera (peor, no roto).

   Respaldo por el Accept: 'mode'/'destination' del evento 'fetch' no están
   garantizados en todo motor que implemente Service Workers — algunos
   WebView embebidos de otras apps los dejan vacíos. Toda navegación de
   verdad manda 'Accept: text/html,...'; un CSS/JS/JSON nunca lo hace (piden
   'text/css', comodín genérico, etc.), así que es una señal fiable sin
   falsos positivos previsibles. */
function esNavegacion(req) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

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

  /* ── NAVEGACIONES: no se interceptan en absoluto ──────────────────────
     Historial de esto (el archivo de 0 KB): v12 limpió la COPIA guardada en
     caché (le quitaba 'Content-Encoding: br' antes de meterla). v13 dejó de
     clonar el cuerpo que ve la pestaña, porque clonar parte el cuerpo en dos
     lectores y, si el service worker se dormía a mitad, a la pestaña le
     llegaba un cuerpo VACÍO — con 'nosniff' eso se trata como descarga y
     Vercel le pone de nombre el 'Content-Disposition: inline;
     filename="…"' (o el host en la raíz, que no lleva filename).

     v13 quitó el clone(), pero SIGUE pasando: reportado 2026-08-28, "a
     veces", en iPhone/Safari, igual en el navegador normal que en la PWA
     instalada. O sea que el cuerpo puede llegar vacío incluso pasando el
     `fetch()` a `respondWith()` sin tocarlo — no es nuestro código, es un
     límite de cómo WebKit entrega el cuerpo a través de un service worker
     en una navegación (con memoria justa, tras suspender la pestaña, o
     yendo y viniendo de background). No hay forma de escribir esto "bien":
     la única forma de no volver a verlo es que el service worker no
     intervenga en absoluto en la navegación.

     Así que ahora, para una navegación, NO se llama a e.respondWith(): el
     evento se deja sin responder y el navegador hace la petición él solo,
     exactamente igual que si no hubiera ningún service worker instalado.
     Precio asumido: se pierde el respaldo offline del HTML (sin red, el
     usuario ve la pantalla nativa de "sin conexión" en vez de la última
     copia guardada) — aceptable, porque el sitio depende de Supabase/
     Firebase para los datos de cada juego y offline nunca fue jugable de
     verdad. Los subrecursos (CSS/JS/imágenes) siguen exactamente igual que
     antes, esta rama solo afecta al documento HTML de la navegación. */
  if (esNavegacion(req)) return;

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
