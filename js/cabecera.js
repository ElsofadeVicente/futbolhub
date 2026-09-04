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
    /* elementsFromPoint y no elementFromPoint: arriba del todo lo primero que
       hay es MUY a menudo la propia cabecera o el circulo (estan justo ahi),
       y devolverlos acababa metiendo el circulo dentro de si mismo —
       HierarchyRequestError, visto en Higher or Lower, que se quedaba sin
       cabecera y con el boton Volver suelto en una columna. */
    const pila = document.elementsFromPoint(x, 2) || [];
    for (let i = 0; i < pila.length; i++) {
      const cand = pila[i];
      if (!cand || !cand.closest) continue;
      if (cand.closest('.pw-root, .fh-cabecera')) continue;
      let n = cand;
      while (n && n.parentElement && n.parentElement !== document.body) {
        if (n.classList && n.classList.contains('screen')) return n;
        n = n.parentElement;
      }
      if (n && n !== document.body && n.nodeType === 1) return n;
    }
    return null;
  }

  /* Deja el contenedor listo para que la fila se coloque ENCIMA del
     contenido y no a su lado, y le devuelve a la fila el ancho completo.

     Las dos cosas dependen de cómo esté maquetado el padre, que es distinto
     en cada juego, así que se mira en runtime en vez de darlo por sabido.

     Se escribe propiedad a propiedad y NO con `el.style = "..."`: asignar la
     cadena entera cuenta como estilo en línea, y La Carrera lleva la CSP
     estricta, que los bloquea. Propiedad a propiedad no pasa por style-src. */
  function ajustar(fila, padre) {
    const cs = getComputedStyle(padre);
    const esFlex = cs.display.indexOf('flex') !== -1;
    const enFila = esFlex && cs.flexDirection.indexOf('row') === 0;

    /* Padre flex EN FILA: la cabecera se pondría al lado del contenido. Con
       wrap + flex-basis 100% se va a su propia línea, y con align-content al
       principio esa línea queda arriba del todo en vez de repartirse a lo
       alto. OJO: el flex-basis del 100% SOLO vale aquí. En un flex en
       COLUMNA el eje principal es el vertical y ese 100% se convierte en
       "todo el alto" — es lo que hizo que la fila midiera 803px en El
       Estadio y mandara el menú fuera de la pantalla. */
    if (enFila) {
      if (cs.flexWrap === 'nowrap') padre.style.flexWrap = 'wrap';
      if (cs.alignContent === 'normal' || cs.alignContent === 'stretch') {
        padre.style.alignContent = 'flex-start';
      }
    }

    /* SACAR LA FILA DEL PADDING DEL CONTENEDOR.
       Cada juego le pone al suyo el padding que le apetece (16px en En el
       Top, 20px en Coche, 80px arriba en En el Once). Si la fila lo hereda,
       el botón Volver se mete hacia dentro y el círculo se despega del borde
       derecho: dejan de estar donde han estado siempre. Y el padding de
       ARRIBA se convierte en hueco muerto encima de la cabecera, que es
       justo lo que se veía en En el Once. Se cancela con márgenes negativos
       y se le devuelve el ancho. */
    const arriba = parseFloat(cs.paddingTop) || 0;
    const izq = parseFloat(cs.paddingLeft) || 0;
    const der = parseFloat(cs.paddingRight) || 0;
    if (arriba) fila.style.marginTop = '-' + arriba + 'px';
    if (izq) fila.style.marginLeft = '-' + izq + 'px';
    if (der) fila.style.marginRight = '-' + der + 'px';
    const extra = izq + der;
    if (extra) fila.style.width = 'calc(100% + ' + extra + 'px)';
    if (enFila) fila.style.flexBasis = extra ? 'calc(100% + ' + extra + 'px)' : '100%';
  }

  /* Una pantalla de "Cargando…" no es sitio para la cabecera: son
     contenedores que centran su contenido, asi que el circulo aparecia solo,
     flotando en mitad de una pagina en blanco, hasta que la pantalla de
     verdad tomaba el relevo. Dura un segundo, pero es lo primero que se ve al
     abrir el juego. Se salta y ya se colocara cuando haya donde. */
  function esPantallaDeCarga(el) {
    const id = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    return /loading|cargando|loader/i.test(id);
  }

  /* Overlays a pantalla completa que no son una pantalla del juego (la
     cuenta atrás de Coche/Blackjack/En la Cadena antes de empezar una
     ronda): son `display:flex` centrando su contenido, y colarles una fila
     de cabecera como hijo más rompe ese centrado — la fila coge
     `flex-basis:100%` (ver ajustar()) y empuja el número grande fuera del
     centro. Se marcan con `.fh-sin-cabecera` en el HTML del juego para que
     cabecera.js no intente montar nada dentro. */
  function tieneCabeceraProhibida(el) {
    return !!(el.closest && el.closest('.fh-sin-cabecera'));
  }

  /* Crea (o reutiliza) la fila al principio de un contenedor. Se usa para
     las pantallas que NO traen boton Volver: la fila lleva solo el circulo. */
  function filaDe(padre) {
    let fila = padre.querySelector(':scope > .fh-cabecera');
    if (!fila) {
      fila = document.createElement('div');
      /* --suelta = fila sin boton Volver. Va marcada por si algun dia hay
         que darle un trato distinto; hoy se maqueta igual. */
      fila.className = 'fh-cabecera fh-cabecera--suelta';
      padre.insertBefore(fila, padre.firstChild);
      ajustar(fila, padre);
    }
    return fila;
  }

  /* Una fila de la que se han llevado el boton y el circulo es un hueco
     vacio que sigue ocupando sitio: en El Crucigrama, que reemplaza el
     innerHTML de su pantalla al arrancar, quedaban 24px muertos arriba del
     todo. Se barren al final de cada colocacion. */
  function barrerVacias() {
    document.querySelectorAll('.fh-cabecera').forEach(function (f) {
      if (!f.firstElementChild) f.remove();
    });
  }

  function colocar() {
    try { colocarAhora(); } finally { barrerVacias(); }
  }

  /* El circulo solo se ensena cuando esta colocado en su sitio. */
  function mostrar(pw, si) {
    pw.style.display = si ? '' : 'none';
  }

  /* Un juego puede reservarle al círculo un hueco PROPIO en su maqueta con
     .fh-widget-slot, y mientras ese hueco se vea manda sobre todo lo demás:
     el botón Volver se queda donde está, en su fila, y el círculo se va al
     hueco. Lo usa Blackjack, que lo mete en la barra de partida junto al
     marcador — antes el círculo abría una fila propia DEBAJO de la barra y
     eran dos bandas de cabecera seguidas comiéndose la pantalla.

     Es la salida limpia para "quiero el círculo AQUÍ": sin esto, la única
     forma era devolverlo a position:fixed, que es justo de lo que se salió
     el 2026-08-31 (ver la cabecera de este archivo). */
  function huecoPropio() {
    const hueco = document.querySelector('.fh-widget-slot');
    return visible(hueco) ? hueco : null;
  }

  function colocarAhora() {
    const pw = elCirculo();

    let btn = null;
    const botones = document.querySelectorAll('.fh-volver');
    for (let i = 0; i < botones.length; i++) {
      if (visible(botones[i])) { btn = botones[i]; break; }
    }

    const hueco = pw ? huecoPropio() : null;
    if (hueco && pw.parentElement !== hueco && !pw.contains(hueco)) {
      hueco.appendChild(pw);
    }

    if (btn) {
      let fila = btn.parentElement;
      if (!fila || !fila.classList.contains('fh-cabecera')) {
        const padre = btn.parentElement;
        fila = document.createElement('div');
        fila.className = 'fh-cabecera';
        padre.insertBefore(fila, btn);
        fila.appendChild(btn);
        ajustar(fila, padre);
      }
      if (!hueco && pw && pw.parentElement !== fila && !pw.contains(fila)) fila.appendChild(pw);
      if (pw) mostrar(pw, true);
      return;
    }

    if (!pw) return;

    if (hueco) { mostrar(pw, true); return; }

    /* Sin botón Volver: la portada mete el círculo en la cabecera del
       periódico, que es donde estaba flotando antes. */
    const mast = document.querySelector('.masthead-top');
    if (mast) {
      if (pw.parentElement !== mast) mast.appendChild(pw);
      mostrar(pw, true);
      return;
    }

    /* Y una pantalla de juego sin botón Volver se lleva su propia fila, solo
       con el círculo. Si ya está en una fila que se ve, no se toca. */
    const suFila = pw.closest('.fh-cabecera');
    if (suFila && visible(suFila)) { mostrar(pw, true); return; }

    const pantalla = pantallaVisible();
    if (pantalla && !esPantallaDeCarga(pantalla) && !tieneCabeceraProhibida(pantalla)) {
      const fila = filaDe(pantalla);
      if (!pw.contains(fila)) {
        fila.appendChild(pw);
        mostrar(pw, true);
        return;
      }
    }

    /* No hay donde ponerlo todavia (la pantalla de "Cargando…"). Se ESCONDE
       en vez de dejarlo suelto: sin esto acababa colgando del final del
       <body>, y en En el Top se veia el circulo solo, al pie de una pagina
       en blanco, hasta que cargaba el menu. */
    if (!pw.isConnected) document.body.appendChild(pw);
    mostrar(pw, false);
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
