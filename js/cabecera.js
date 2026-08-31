/* =============================================
   CABECERA.JS — el botón Volver y la foto de perfil, EN EL FLUJO

   Hasta el 2026-08-31 los dos eran `position: fixed`: se quedaban clavados
   en las esquinas y se dibujaban ENCIMA del contenido. Auditadas las 15
   páginas a 375x812, se comían el título o la cabecera en 13 de ellas, y en
   Bingo el círculo llegaba a taparle media superficie al botón SALTAR — o
   sea que tocar esa esquina abría el menú de perfil en vez de saltar al
   futbolista. Se intentó tapar el agujero reservándoles una banda con
   paddings, pero eso es compensar un síntoma: mientras floten, cualquier
   pantalla nueva vuelve a nacer con el problema.

   Decisión del usuario: que dejen de flotar. Ahora ocupan su sitio de
   verdad, en una fila propia arriba del todo, y se van con el scroll como
   cualquier cabecera normal.

   ── POR QUÉ HACE FALTA JAVASCRIPT PARA ALGO QUE PARECE CSS ────────────────
   Porque los dos elementos viven en sitios distintos del documento y no hay
   forma de ponerlos en la misma línea sin juntarlos:

     · Cada pantalla de cada juego trae SU PROPIO .fh-volver (hasta 5 en
       Blackjack), porque no todos hacen lo mismo: unos navegan al hub y
       otros llaman a App.leaveRoom() para salir de una sala. No se pueden
       refundir en uno solo.
     · El círculo de perfil es UNO por página y lo inyecta js/profile-widget.js
       directamente en el <body>, sin saber nada de las pantallas del juego.

   Así que aquí se crea una fila (.fh-cabecera) alrededor del .fh-volver que
   esté visible en ese momento y se mete el círculo dentro. Al cambiar de
   pantalla, la fila se rehace en la nueva. El botón se MUEVE, no se copia:
   conserva su onclick y su href, así que cada pantalla sigue haciendo lo
   suyo.

   Cargar DESPUÉS de js/profile-widget.js (que es quien crea el círculo).
   Si por lo que fuera no llegara a cargar, no pasa nada grave: los dos
   siguen viéndose, solo que sueltos.
   ============================================= */
(function () {
  'use strict';

  /* getClientRects() vacío = no lo está pintando nadie, ni él ni ningún
     ancestro. Es la prueba que no obliga a saber QUIÉN lo escondió (una
     .screen sin .active, un [hidden], un display:none heredado…). */
  function visible(el) {
    return !!(el && el.getClientRects().length);
  }

  /* Se guarda la referencia al círculo, y no se busca cada vez con
     querySelector, por una razón concreta: El Crucigrama REEMPLAZA el
     innerHTML de #crucigrama-screen al arrancar. Si el círculo estaba
     dentro, ese reemplazo lo saca del documento y un querySelector ya no lo
     encuentra nunca más — desaparecía la foto de perfil del juego entero.
     Con la referencia guardada se detecta que se ha quedado fuera y se
     vuelve a colgar. */
  let circulo = null;
  function elCirculo() {
    if (!circulo || !circulo.isConnected) {
      const enDoc = document.querySelector('.pw-root');
      if (enDoc) circulo = enDoc;
      else if (circulo) document.body.appendChild(circulo);   // lo habían arrancado
    }
    return circulo;
  }

  /* La pantalla que se está viendo AHORA. Hace falta para las pantallas que
     no traen botón Volver (durante una partida de Bingo, de Coche…): ahí no
     hay ningún ancla, y sin esto el círculo se quedaba dentro de la fila de
     una pantalla ya oculta, o sea invisible.

     Se resuelve preguntándole al navegador qué está pintando arriba del
     todo y subiendo hasta la pantalla que lo contiene. Es más fiable que una
     lista de ids: cada juego llama a las suyas de forma distinta (.screen,
     #once-menu, .hol-game, .sd-intro-wrap…) y una lista se queda coja en
     cuanto alguien añade una. */
  function pantallaVisible() {
    const x = Math.round((document.documentElement.clientWidth || 320) / 2);
    let n = document.elementFromPoint(x, 2);
    if (!n) return null;
    while (n && n.parentElement && n.parentElement !== document.body) {
      if (n.classList && n.classList.contains('screen')) return n;
      n = n.parentElement;
    }
    return (n && n !== document.body) ? n : null;
  }

  /* Si el contenedor es flex EN FILA, la cabecera se le pondria al lado del
     contenido en vez de encima. Con wrap, el flex-basis: 100% de la fila la
     manda a su propia linea; con align-content al principio, esa linea queda
     arriba del todo en vez de repartirse a lo alto.

     Se escribe propiedad a propiedad y NO con `el.style = "..."`: asignar la
     cadena entera cuenta como estilo en linea y La Carrera lleva la CSP
     estricta, que los bloquea. Propiedad a propiedad no pasa por style-src. */
  function prepararPadre(padre) {
    const cs = getComputedStyle(padre);
    if (cs.display.indexOf('flex') === -1) return;
    if (cs.flexDirection.indexOf('row') !== 0) return;      // ya es columna
    if (cs.flexWrap === 'nowrap') padre.style.flexWrap = 'wrap';
    if (cs.alignContent === 'normal' || cs.alignContent === 'stretch') {
      padre.style.alignContent = 'flex-start';
    }
  }

  function filaDe(padre, antesDe) {
    let fila = padre.querySelector(':scope > .fh-cabecera');
    if (!fila) {
      fila = document.createElement('div');
      /* --suelta = fila sin boton Volver, creada en una pantalla que no
         tiene ancla. Necesita empujarse ella sola hacia arriba: estas
         pantallas suelen centrar su contenido (la de "Cargando…" de La
         Carrera lo hace), y sin eso el circulo aparecia flotando en mitad
         de la pagina hasta que la pantalla de verdad tomaba el relevo. */
      fila.className = 'fh-cabecera fh-cabecera--suelta';
      padre.insertBefore(fila, antesDe || padre.firstChild);
      prepararPadre(padre);
    }
    return fila;
  }

  function colocar() {
    const pw = elCirculo();

    let btn = null;
    const botones = document.querySelectorAll('.fh-volver');
    for (let i = 0; i < botones.length; i++) {
      if (visible(botones[i])) { btn = botones[i]; break; }
    }

    if (btn) {
      let fila = btn.parentElement;
      if (!fila || !fila.classList.contains('fh-cabecera')) {
        const padre = btn.parentElement;
        fila = document.createElement('div');
        fila.className = 'fh-cabecera';
        padre.insertBefore(fila, btn);
        fila.appendChild(btn);
        prepararPadre(padre);
      }
      if (pw && pw.parentElement !== fila) fila.appendChild(pw);
      return;
    }

    if (!pw) return;

    /* Sin botón Volver: la portada mete el círculo en la cabecera del
       periódico, que es donde estaba flotando antes. */
    const mast = document.querySelector('.masthead-top');
    if (mast) {
      if (pw.parentElement !== mast) mast.appendChild(pw);
      return;
    }

    /* Y una pantalla de juego sin botón Volver se lleva su propia fila, solo
       con el círculo. Si ya está en una fila que se ve, no se toca. */
    const suFila = pw.closest('.fh-cabecera');
    if (suFila && visible(suFila)) return;
    const pantalla = pantallaVisible();
    if (pantalla) filaDe(pantalla).appendChild(pw);
    else if (!pw.isConnected) document.body.appendChild(pw);
  }

  /* Cambiar de pantalla es un cambio de ATRIBUTO (una .screen que gana
     .active, un panel al que le quitan [hidden]), no de scroll ni de
     tamaño. Se mira como mucho una vez por tick.

     setTimeout y NO requestAnimationFrame: rAF no corre con la pestaña
     oculta ni con la app en segundo plano, y ahí la cabecera se quedaría
     sin recolocar. Mismo tropiezo que ya estaba documentado en Bingo. */
  let pedido = 0;
  function pedirRepaso() {
    if (pedido) return;
    pedido = setTimeout(function () { pedido = 0; colocar(); }, 0);
  }

  function arrancar() {
    colocar();
    if (!('MutationObserver' in window)) return;

    /* Dos vigilantes, y a propósito no uno con todo activado: `childList`
       con `subtree` sobre el <body> se dispara con CADA cambio del DOM del
       juego (Coche repinta el marcador varias veces por segundo), y aquí
       solo interesa una cosa de la lista de hijos: que aparezca el círculo,
       que el widget cuelga del <body> directamente. */
    new MutationObserver(pedirRepaso).observe(document.body, { childList: true });
    new MutationObserver(pedirRepaso).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
})();
