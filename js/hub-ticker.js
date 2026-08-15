/* =============================================
   HUB-TICKER.JS — Rellena el ticker rojo de la portada
   QUIÉN COÑO FALTA

   Pide los titulares a /api/titulares (ver api/titulares.js) y los pinta
   en el ticker. Si no hay respuesta —sin conexión, la función caída, o
   estás abriendo el HTML en local sin `vercel dev`— se queda el texto que
   trae el HTML de fábrica y no pasa nada.

   El ticker necesita SU CONTENIDO REPETIDO 3 VECES: la animación de CSS
   desplaza la tira un -33.33% y vuelve a empezar, así que el bucle solo
   es invisible si los tres tercios son idénticos.
   ============================================= */
(function () {
  'use strict';

  const strip = document.querySelector('.ticker-strip');
  if (!strip) return;

  /* El HTML trae UN solo segmento de reserva (repetirlo tres veces allí eran
     ~180 palabras duplicadas dentro de la portada). Aquí se clona hasta los
     tres que necesita el bucle de la animación. */
  (function clonarSegmentos() {
    const segs = strip.querySelectorAll('.tick-seg');
    if (segs.length !== 1) return;               // ya vienen los tres: nada que hacer
    strip.appendChild(segs[0].cloneNode(true));
    strip.appendChild(segs[0].cloneNode(true));
  })();

  /* Velocidad de desplazamiento, en píxeles por segundo.
     Este es el número que hay que tocar si el ticker va rápido o lento;
     NO la duración del @keyframes. */
  const VELOCIDAD_PX_S = 50;

  /* La duración de la animación tiene que salir del ANCHO del contenido, no
     ser un número fijo. El CSS traía 38s, que iban bien con el texto corto
     de reserva (un segmento de ~1.400 px ≈ 37 px/s), pero al meter 18
     titulares de prensa el segmento pasó a ~11.700 px: los mismos 38 s
     pasaron a ser 308 px/s, imposible de leer.

     La animación desplaza la tira un -33.33%, y la tira son 3 segmentos
     idénticos, así que un ciclo = recorrer exactamente UN segmento. */
  function ajustarVelocidad() {
    const seg = strip.querySelector('.tick-seg');
    if (!seg) return;
    const ancho = seg.getBoundingClientRect().width;
    if (!ancho) return;
    strip.style.animationDuration = (ancho / VELOCIDAD_PX_S).toFixed(1) + 's';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Un titular = solo TEXTO, con el medio del que sale. Nada de enlaces:
     el ticker es un adorno de portada, no un sitio del que sacar al usuario
     a otra web (y menos con una partida a medias). */
  function segmento(titulares) {
    const trozos = titulares.map((n, i) => {
      const clase = i % 3 === 0 ? 'tick-accent' : 'tick-normal';
      return `<span class="${clase}"> ${esc(n.t)} <span class="tick-src">· ${esc(n.s)}</span> </span>` +
             `<span class="tick-normal"> · </span>`;
    }).join('');
    return `<span class="tick-seg"><span class="tick-label">FÚTBOL</span>${trozos}</span>`;
  }

  /* El texto de reserva del HTML también necesita su velocidad: si /api/
     falla, sin esto se quedaría con los 38s del CSS. Se mide cuando las
     fuentes estén listas, porque con la fuente de sistema el ancho medido
     no es el definitivo. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(ajustarVelocidad);
  } else {
    ajustarVelocidad();
  }

  fetch('/api/titulares', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      const titulares = data && Array.isArray(data.titulares) ? data.titulares : [];
      if (titulares.length < 4) return;          // muy poco: mejor dejar lo de fábrica
      const seg = segmento(titulares);
      strip.innerHTML = seg + seg + seg;         // los tres tercios del bucle
      // Contenido nuevo => segmento de otro ancho => hay que recalcular.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(ajustarVelocidad);
      } else {
        ajustarVelocidad();
      }
    })
    .catch(() => { /* sin titulares: se queda el texto del HTML */ });
})();
