/* =============================================
   SW.JS — Service Worker de FutbolHUB

   NO CACHEA NADA, NO INTERCEPTA NADA Y NO TIENE MANEJADOR DE 'fetch'.

   Existe solo para UNA cosa: limpiar. Las versiones v1..v16 sí cacheaban y
   sus cachés siguen dentro de los móviles de quien entró en su día. El
   'activate' de abajo las borra todas, así que instalar esta version
   desatasca un dispositivo que se quedara con una copia envenenada.

   ── POR QUE YA NO HAY MANEJADOR DE 'fetch' (2026-08-31) ───────────────────
   La v17 lo dejo registrado pero VACIO, razonando que "al no llamar a
   respondWith() el navegador resuelve la peticion por su cuenta". Eso es
   cierto a nivel de resultado, pero NO a nivel de coste: mientras exista un
   listener de 'fetch', el navegador esta obligado a ARRANCAR el service
   worker y a despacharle el evento ANTES de dejar seguir a la navegacion,
   aunque el handler no haga nada. O sea que cada navegacion —tambien la de
   una PWA recien abierta desde el icono, que es el peor caso: proceso en
   frio— sigue pasando por el arranque del worker.

   Ese arranque es lo unico que quedaba entre el usuario y el HTML, y es
   justo donde WebKit ha ido acumulando fallos de documento vacio. Como el
   service worker ya no aporta NADA (ver lista de abajo), la decision es
   quitar el listener del todo: sin listener de 'fetch' se aplica la
   optimizacion que contempla la propia especificacion —el navegador se
   salta el service worker por completo en las navegaciones— y esta pieza
   deja de poder intervenir ni para bien ni para mal.

   Lo que el service worker ya NO aporta, comprobado uno a uno:
     · Las fotos y escudos van por /api/img (proxy propio con cache en
       Supabase y en la CDN de Vercel), no por aqui.
     · El CSS y el JS se sirven con 'Cache-Control: max-age=0,
       must-revalidate': van a la red en cada carga igualmente.
     · Los datos de cada juego estan en Supabase, otro origen, que este
       service worker no ve.
     · El modo sin conexion nunca fue jugable de verdad, por lo mismo.

   ¿Y la instalabilidad? Chrome dejo de exigir service worker (y, antes,
   manejador de 'fetch') para considerar una web instalable: hoy basta con
   HTTPS + manifest con nombre, iconos 192/512, start_url y display. En
   iPhone "Anadir a pantalla de inicio" nunca lo necesito. Se sigue
   registrando el archivo por la limpieza de arriba.

   NO VOLVER A METER AQUI NI CACHE NI respondWith() NI UN LISTENER DE
   'fetch' sin un motivo nuevo y medido. Si hace falta cachear algo, el
   sitio son las cabeceras de Vercel (vercel.json) o la CDN.
   ============================================= */
'use strict';

/* Activarse de inmediato, sin esperar a que se cierren las pestanas
   abiertas: es lo que desatasca a quien tenga la v17 (o peor) instalada.
   Sin ningun respondWith() en el archivo, skipWaiting() no puede cruzarse
   con una navegacion a medio responder. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Fuera TODAS las caches: ya no se guarda nada, y las viejas pueden
    // llevar dentro las respuestas envenenadas de v11/v12.
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Deliberadamente NO hay self.addEventListener('fetch', ...). Ver arriba. */
