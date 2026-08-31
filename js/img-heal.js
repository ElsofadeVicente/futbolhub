/* =============================================
   IMG-HEAL.JS — Reintentar las fotos que no cargan
   FutbolHUB

   Las fotos de futbolista y los escudos salen de Transfermarkt, pero YA NO
   se piden en directo a su CDN: pasan por /api/img, nuestro proxy con cache
   en Supabase Storage (ver api/img.js y fhImgUrl en js/supabase-config.js).

   Aun asi se caen: un 502 del proxy la primera vez que una imagen se pide
   (que es cuando de verdad va a buscarla a Transfermarkt), un corte de red
   al volver de segundo plano, un 429 por pedir doce escudos de golpe. Y
   cuando eso pasa el navegador se queda con el fallo cacheado un buen rato:
   la foto no vuelve a cargar aunque el jugador si la tenga.

   Aqui si sabemos si una foto esta mal, porque nos lo dice el evento
   'error' de la propia <img>. Al fallar se reintenta hasta MAX_TRIES con
   una espera creciente y un parametro nuevo en la URL, para saltarse
   tambien la cache HTTP del navegador.

   ── CORREGIDO EL 2026-08-31 ───────────────────────────────────────────────
   Este archivo llevaba tiempo SIN REINTENTAR NADA, en silencio. Su lista de
   hosts eran los dos dominios de Transfermarkt, y desde que las imagenes
   pasan por /api/img ninguna <img> del sitio apunta ya ahi: son URLs de
   NUESTRO propio origen, asi que isExternalPhoto() devolvia false siempre y
   el manejador se iba sin hacer nada. Ahora reconoce las tres formas en las
   que puede venir una foto (el proxy, la CDN de Supabase donde el proxy las
   deja, y el hotlink directo por si queda alguno), que es lo que hace falta
   para que vuelva a servir de algo.

   Tambien se ha quitado el aviso al service worker para que borrase la
   entrada de su cache: sw.js ya no cachea nada ni tiene manejador de
   'message', asi que ese postMessage era un no-op.

   Se engancha solo: basta con incluir este archivo en la pagina. Escucha el
   evento 'error' en fase de CAPTURA, que es la unica en la que los errores
   de recurso llegan hasta document.
   ============================================= */
(function () {
  'use strict';

  /* Los hosts de Transfermarkt siguen aqui porque queda algun hotlink
     suelto, pero el caso normal hoy son las otras dos formas. */
  const HOSTS = ['tmssl.akamaized.net', 'img.a.transfermarkt.technology'];
  /* Donde el proxy deja las imagenes ya cacheadas: /api/img redirige aqui. */
  const SUPABASE_IMG = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/img-cache\//;

  const MAX_TRIES  = 2;      // reintentos por imagen (además del original)
  const RETRY_BASE = 600;    // ms; el segundo intento espera el doble
  const PARAM      = '_fhr'; // marca de reintento en la URL

  const tries = new WeakMap();   // <img> → nº de reintentos gastados
  const undo  = new WeakMap();   // <img> → cómo estaba la pantalla antes del fallo

  /* Una foto reintentable es: la que pasa por nuestro proxy, la que ya vive
     en el bucket de imagenes, o un hotlink directo a Transfermarkt. Lo que
     NO entra —y es a proposito— son los escudos y banderas de los otros
     buckets de Storage y cualquier imagen propia del sitio: esas o estan o
     no estan, y reintentarlas solo multiplicaria peticiones. */
  function isExternalPhoto(src) {
    try {
      const u = new URL(src, location.href);
      if (HOSTS.includes(u.hostname)) return true;
      if (SUPABASE_IMG.test(u.href)) return true;
      return u.origin === location.origin && u.pathname === '/api/img';
    } catch { return false; }
  }

  /* Se quita nuestra propia marca antes de reintentar, para que el segundo
     intento no herede el parametro del primero y la URL base sea siempre la
     misma. OJO con /api/img: ahi la query lleva ?u=<url original>, asi que
     hay que borrar SOLO nuestra clave, nunca reconstruir la query entera. */
  function cleanUrl(src) {
    try {
      const u = new URL(src, location.href);
      u.searchParams.delete(PARAM);
      return u.toString();
    } catch { return src; }
  }

  function onError(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.src) return;
    if (!isExternalPhoto(img.src)) return;

    const used = tries.get(img) || 0;
    if (used >= MAX_TRIES) return;      // ya lo hemos intentado bastante
    tries.set(img, used + 1);

    /* Los juegos tienen su propio onerror en la etiqueta: esconden la foto
       y sacan el emoji de repuesto. Esos manejadores corren DESPUÉS que
       este (aquí estamos en fase de captura), así que guardamos ahora cómo
       estaba la pantalla para devolverla a su sitio si el reintento cuela. */
    if (!undo.has(img)) {
      const sib = img.nextElementSibling;
      undo.set(img, {
        display: img.style.display,
        sib,
        sibDisplay: sib ? sib.style.display : null,
      });
    }

    const url = cleanUrl(img.src);

    /* Espera creciente: si el fallo es por pedir muchas fotos a la vez,
       darle un respiro a la CDN antes de volver a la carga. */
    setTimeout(() => {
      if (!img.isConnected) return;     // la pantalla ya ha cambiado
      const sep = url.includes('?') ? '&' : '?';
      img.src = `${url}${sep}${PARAM}=${used + 1}`;
    }, RETRY_BASE * (used + 1));
  }

  /* El reintento ha funcionado: deshacer el "esconde la foto y saca el
     emoji" que había dejado el onerror del juego. */
  function onLoad(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const prev = undo.get(img);
    if (!prev) return;
    undo.delete(img);
    img.style.display = prev.display || '';
    if (prev.sib && prev.sib.isConnected) prev.sib.style.display = prev.sibDisplay || '';
  }

  /* Captura: los eventos 'error' y 'load' de recursos no burbujean, así
     que esta es la única fase en la que llegan hasta aquí. */
  document.addEventListener('error', onError, true);
  document.addEventListener('load',  onLoad,  true);
})();
