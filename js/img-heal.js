/* =============================================
   IMG-HEAL.JS — Reintentar las fotos que no cargan
   QUIÉN COÑO FALTA

   Las fotos de futbolista y los escudos vienen de CDNs externas
   (transfermarkt, tmssl). Cuando una de esas peticiones falla —un 429 por
   pedir varias de golpe, un corte de red al volver de segundo plano, un
   404 puntual— el navegador se queda con la respuesta rota:

     · El service worker (sw.js) las guarda cache-first. Como son
       peticiones no-cors, la respuesta es opaca y desde el SW no hay
       manera de distinguir una foto buena de un error: se guarda el fallo
       y esa foto ya no vuelve a cargar NUNCA en ese dispositivo, aunque
       el jugador sí tenga foto en la base de datos.
     · Y aunque no hubiera SW, la caché HTTP del navegador puede repetir
       el fallo un buen rato.

   Aquí sí sabemos si una foto está mal: nos lo dice el evento 'error' de
   la propia <img>. Así que al fallar:
     1. Le decimos al service worker que borre esa entrada de su caché.
     2. Reintentamos (hasta MAX_TRIES) con una espera creciente y un
        parámetro nuevo en la URL, para saltarnos también la caché HTTP.

   Se engancha solo: basta con incluir este archivo en la página. No hace
   falta tocar el HTML de ningún juego porque escucha el evento 'error' en
   fase de captura, que es la única que burbujea hasta document.
   ============================================= */
(function () {
  'use strict';

  /* Solo las CDNs de imágenes: las de nuestro propio dominio ya se
     controlan desde el sw.js y no tienen este problema. */
  const HOSTS = ['tmssl.akamaized.net', 'img.a.transfermarkt.technology'];

  const MAX_TRIES  = 2;      // reintentos por imagen (además del original)
  const RETRY_BASE = 600;    // ms; el segundo intento espera el doble
  const PARAM      = '_fhr'; // marca de reintento en la URL

  const tries = new WeakMap();   // <img> → nº de reintentos gastados
  const undo  = new WeakMap();   // <img> → cómo estaba la pantalla antes del fallo

  function isExternalPhoto(src) {
    try { return HOSTS.includes(new URL(src, location.href).hostname); }
    catch { return false; }
  }

  /* Quitar nuestra propia marca para pedir siempre desde la URL limpia:
     así el service worker (que ignora la query) guarda una sola entrada. */
  function cleanUrl(src) {
    try {
      const u = new URL(src, location.href);
      u.searchParams.delete(PARAM);
      return u.toString();
    } catch { return src; }
  }

  function dropFromSW(url) {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.controller) return;
    try { sw.controller.postMessage({ type: 'drop-image', url }); } catch (e) { /* nada */ }
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
    dropFromSW(url);

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
