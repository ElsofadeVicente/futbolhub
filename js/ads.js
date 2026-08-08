/* =============================================
   ADS.JS — Unidades de AdSense de FutbolHUB
   QUIÉN COÑO FALTA

   Hasta ahora la web cargaba adsbygoogle.js (226 KB + conexiones a
   adtrafficquality y sodar) en las 14 páginas y NO había ni una sola
   unidad de anuncio: se pagaba el peso entero por cero ingresos, y los
   huecos eran recuadros de mentira que ponían "ESPACIO PUBLICITARIO".

   Ahora los huecos son unidades de verdad. Los IDs de cada bloque salen
   de AdSense → Anuncios → Por unidad de anuncio (el número largo del
   atributo data-ad-slot). Se pegan aquí abajo, una sola vez para toda la
   web.

   IMPORTANTE: un hueco sin ID configurado NO se pinta. Nada de recuadros
   vacíos ni de placeholders — o hay anuncio o no hay nada.
   ============================================= */
(function () {
  'use strict';

  const CLIENT = 'ca-pub-1248309481500017';

  /* ── IDs de las unidades ──
     El data-ad-slot de cada bloque creado en AdSense → Anuncios → Por bloque
     de anuncios. Un hueco con la cadena vacía simplemente no se pinta, así
     que se puede añadir o quitar un emplazamiento desde aquí sin tocar HTML. */
  const SLOTS = {
    'rail-left':  '8439524497',   // "FutbolHUB rail izq"  — vertical, columna izquierda (>=1240px)
    'rail-right': '4500279480',   // "FutbolHUB rail dcha" — vertical, columna derecha  (>=1240px)
    'inline':     '1958976708',   // "FutbolHUB inline"    — horizontal, bajo la rejilla
  };

  /* Los tres son adaptables (data-ad-format="auto"), que es lo que recomienda
     Google: el anuncio se amolda al hueco. A los rascacielos el ancho se lo
     marca el CSS (.ad-slot--rail: 160px), así que AdSense sirve un formato
     vertical; al inline, el ancho del contenido. */
  const FORMATO = {
    'rail-left':  { responsive: true },
    'rail-right': { responsive: true },
    'inline':     { responsive: true },
  };

  function pintar(host) {
    const nombre = host.getAttribute('data-ad');
    const slot   = SLOTS[nombre];
    if (!slot) {
      // Sin ID configurado: fuera el hueco Y la columna que lo envolvía, si
      // se queda vacía. Si no, el grid seguiría reservando 172px a cada lado
      // para nada y el contenido saldría estrechado sin motivo.
      const col = host.closest('.ad-col');
      host.remove();
      if (col && !col.querySelector('[data-ad]')) col.remove();
      return;
    }

    const fmt = FORMATO[nombre] || { responsive: true };
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.setAttribute('data-ad-client', CLIENT);
    ins.setAttribute('data-ad-slot', slot);

    if (fmt.responsive) {
      ins.style.display = 'block';
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
    } else {
      ins.style.display = 'inline-block';
      ins.style.width  = fmt.fixed;
      ins.style.height = fmt.height;
    }

    host.appendChild(ins);
    host.setAttribute('data-ad-filled', '');
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      /* Bloqueador de anuncios, o el script no cargó: sin drama. */
    }
  }

  function init() {
    document.querySelectorAll('[data-ad]').forEach(pintar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
