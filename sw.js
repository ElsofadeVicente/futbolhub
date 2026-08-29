/* =============================================
   SW.JS — Service Worker de FutbolHUB

   NO CACHEA NADA Y NO SE METE EN NINGUNA PETICIÓN.

   Existe solo por dos motivos, los dos administrativos:

     1. Limpiar. Las versiones v1..v16 sí cacheaban, y sus cachés siguen
        dentro de los móviles de quien ya entró. El 'activate' de abajo las
        borra todas, así que instalar esta versión desatasca un dispositivo
        que se quedara con una copia envenenada.

     2. Que Android siga ofreciendo "instalar app". El criterio de
        instalabilidad de Chrome ha pedido históricamente que el sitio tenga
        un service worker CON un manejador de 'fetch' (el requisito se ha ido
        relajando entre versiones, pero cumplirlo no cuesta nada). El de aquí
        abajo está registrado y vacío a propósito: no llama a respondWith(),
        así que el navegador hace cada petición él solo, exactamente igual que
        si no hubiera ningún service worker. En iPhone esto da igual: "Añadir
        a pantalla de inicio" nunca ha necesitado service worker.

   ── POR QUÉ SE VACIÓ (2026-08-29) ─────────────────────────────────────────
   Cinco versiones seguidas persiguiendo el mismo fantasma, todas fallidas:

     v12  limpió las cabeceras de la COPIA en caché (Content-Encoding: br
          sobre un cuerpo ya descomprimido → el navegador se quedaba sin
          cuerpo y, con 'nosniff', lo trataba como descarga: el famoso
          archivo de 0 KB llamado 'el-estadio' o 'www.futbolhub.es').
     v13  dejó de clonar el cuerpo de las navegaciones.
     v14  forzó un refresco de versión.
     v15  apartó al service worker de las navegaciones por completo.
     v16  quitó skipWaiting() por una pantalla en blanco en la PWA de iOS.

   Y el 2026-08-29 se seguía viendo la pantalla en blanco (Bingo → Volver, en
   la PWA instalada de iOS, sin forma de recargar). Con v15 el HTML ya no
   pasaba por aquí, así que la causa que se perseguía no podía explicarlo.

   Lo que quedaba: los subrecursos, que SÍ seguían interceptados con
   respondWith() + clone(). Y sobre todo, que a estas alturas el service
   worker ya no aportaba NADA:

     · Las fotos y escudos ya no se piden a Transfermarkt: van por /api/img,
       proxy propio con su caché en Supabase y en la CDN de Vercel. Peor aún,
       la clave de caché de aquí descartaba la query (?u=...), así que TODAS
       las imágenes del sitio compartían la MISMA entrada: en Bingo, con 16
       categorías con imagen, eran decenas de clone() + blob() + cache.put()
       pisándose sobre una sola clave en cada carga. Trabajo intenso, inútil
       y justo antes de la navegación que se quedaba en blanco.
     · El CSS y el JS se sirven con 'Cache-Control: max-age=0,
       must-revalidate', o sea que van a la red en cada carga igualmente.
     · Los datos de cada juego están en Supabase, otro origen, que este
       service worker no toca.
     · El modo sin conexión nunca fue jugable de verdad, por lo mismo.

   O sea: todo el riesgo, ningún beneficio. Un service worker que no sirve
   nada no puede servir nada roto.

   NO VOLVER A METER AQUÍ NI CACHÉ NI respondWith() sin un motivo nuevo y
   medido. Si algún día hace falta cachear algo, el sitio para hacerlo son
   las cabeceras de Vercel (vercel.json) o la CDN, no este archivo.
   ============================================= */
'use strict';

/* Activarse de inmediato, sin esperar a que se cierren las pestañas abiertas.
   Aquí sí es seguro (y es lo que desatasca a quien esté roto ahora mismo):
   la pantalla en blanco de v16 venía de que skipWaiting() corriera a la vez
   que un respondWith() de una navegación —el fallo de WebKit #261767—, y en
   esta versión no hay ni un solo respondWith(). */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Fuera TODAS las cachés: ya no se guarda nada, y las viejas pueden
    // llevar dentro las respuestas envenenadas de v11/v12.
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Manejador de 'fetch' registrado y VACÍO a propósito: ver el punto 2 de
   arriba. Al no llamar a e.respondWith(), el navegador resuelve la petición
   por su cuenta y este archivo no puede romper nada. */
self.addEventListener('fetch', () => {});
