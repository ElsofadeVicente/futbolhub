/* =============================================
   PANTALLA-VIVA.JS — la página NUNCA se queda sin nada que mirar

   ── EL PROBLEMA DE FONDO, Y POR QUE VOLVIA CADA SEMANA ────────────────────
   Los 14 juegos enseñan una pantalla ESCONDIENDO las demás. Todos, y cada
   uno a su manera: unos con .hidden, otros con .active, otros reemplazando
   el innerHTML del contenedor entero. El patrón es siempre el mismo y
   siempre tiene el mismo agujero:

       esconder lo que hay  →  hacer trabajo  →  enseñar lo siguiente

   Si el trabajo del medio se cae —un fetch que no vuelve, un elemento que no
   está, un `return` por un camino de error— el tercer paso no llega nunca y
   NO QUEDA NI UNA PANTALLA VISIBLE. En un navegador eso es una página en
   blanco; en la PWA instalada, sin barra de direcciones ni botón de
   recargar, es un callejón sin salida: hay que matar la app.

   Se han arreglado unos cuantos de uno en uno (La Carrera, el service
   worker, el once diario…) y el fallo reaparecía en OTRO juego, porque lo
   que se arreglaba era la ocasión, no la regla. Aquí se arregla la regla:

       PASE LO QUE PASE, SIEMPRE HAY ALGO EN PANTALLA
       Y SIEMPRE HAY UNA FORMA DE SALIR.

   Esto NO sustituye a arreglar cada causa —eso se hace aparte, en cada
   juego— pero deja de haber una causa nueva capaz de dejar al usuario
   tirado.

   ── COMO ────────────────────────────────────────────────────────────────
   Se comprueba si hay contenido de verdad (texto, o algo gráfico de tamaño
   real) descontando el "cromo" que sale en todas las páginas y que no prueba
   nada: el círculo de perfil, la fila de la cabecera, las columnas de
   anuncio y la textura de papel. Si no hay nada:

     1. Se llama al rescate propio del juego, si lo ha declarado
        (window.FHPantallaViva.rescate = fn).
     2. Si no, se prueba a enseñar cada pantalla de la página por orden hasta
        que una dé contenido, y se deja esa. Lo que no sirve se deja
        EXACTAMENTE como estaba: encender pantallas a medias sería cambiar
        una página en blanco por una pantalla mentirosa.
     3. Y si ni así, se pinta un panel propio con el mensaje y dos salidas
        (portada y recargar).

   CUANDO se comprueba: al cargar, al volver de segundo plano, al restaurar
   la página, tras un error o una promesa sin capturar, tras un toque y tras
   un cambio de pantalla. O sea, en los momentos en que una transición puede
   haberse quedado a medias — no en un temporizador dando vueltas.

   OJO CON LOS ESTILOS: el panel se maqueta propiedad a propiedad
   (el.style.color = …) y NUNCA con `el.style = "…"` ni con un atributo
   style=. La Carrera lleva la CSP estricta y esas dos formas sí cuentan como
   estilo en línea; la asignación por propiedad no pasa por style-src. Por lo
   mismo, aquí no se inyecta ningún <style>.
   ============================================= */
(function () {
  'use strict';

  var ID_PANEL = 'fh-rescate';

  /* Lo que sale en TODAS las páginas y por tanto no prueba que el juego esté
     vivo. Sin descontarlo, la inicial del círculo de perfil ya contaba como
     "hay contenido" y el rescate no saltaría nunca. */
  var CROMO = '#paper-overlay, .pw-root, .fh-cabecera, .ad-col, #' + ID_PANEL +
              ', script, style, link, noscript, template';

  var MIN_TEXTO = 20;    // caracteres de texto útil para dar la página por viva

  function esCromo(el) {
    try { return !!(el && el.closest && el.closest(CROMO)); } catch (e) { return false; }
  }

  /* Texto que se ve de verdad. innerText ya se salta lo oculto (por
     display:none, por un ancestro escondido o por visibility), que es justo
     lo que hace falta aquí y lo que textContent NO daría. */
  function textoUtil() {
    var cuerpo = document.body;
    if (!cuerpo) return 0;
    var n = 0;
    var hijos = cuerpo.children;
    for (var i = 0; i < hijos.length; i++) {
      var hijo = hijos[i];
      try { if (hijo.matches(CROMO)) continue; } catch (e) { /* selector raro */ }
      if (!hijo.getClientRects().length) continue;
      var t = hijo.innerText || '';
      if (t) {
        /* El cromo puede haberse metido DENTRO de una pantalla (cabecera.js
           mueve ahí el botón Volver y el círculo). Se descuenta, o una
           pantalla vacía con solo la cabecera pasaría por buena. */
        var dentro = hijo.querySelectorAll(CROMO);
        for (var j = 0; j < dentro.length; j++) {
          var ct = dentro[j].innerText || '';
          if (ct) t = t.split(ct).join('');
        }
      }
      n += t.trim().length;
      if (n >= MIN_TEXTO) return n;
    }
    return n;
  }

  /* Hay pantallas que son casi toda imagen: el Street View de El Estadio (un
     iframe), la foto de Higher or Lower, el cartón de Bingo. Poco texto ahí
     no significa que estén rotas. */
  function hayGrafico() {
    var g = document.body.querySelectorAll('img, canvas, svg, iframe, video');
    for (var i = 0; i < g.length; i++) {
      if (esCromo(g[i])) continue;
      var r = g[i].getBoundingClientRect();
      if (r.width > 60 && r.height > 60) return true;
    }
    return false;
  }

  function hayContenido() {
    try {
      return textoUtil() >= MIN_TEXTO || hayGrafico();
    } catch (e) {
      /* Si la comprobación misma falla, se da la página por buena: más vale
         no rescatar que romper una página que estaba bien. */
      return true;
    }
  }

  /* ── PASO 2: encender la primera pantalla que dé contenido ─────────────── */

  /* Una pantalla de "Cargando…" tiene texto, así que valdría como rescate y
     dejaría al jugador mirando un spinner que ya no va a terminar nunca —es
     lo que pasó al probarlo—. Se dejan las últimas: solo si no hay ninguna
     otra que sirva, que al menos se vea eso antes que el panel. */
  function esDeCarga(el) {
    var id = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    return /loading|cargando|loader/i.test(id);
  }

  function pantallasCandidatas() {
    var normales = [], carga = [];
    var sel = '.screen, [id$="-screen"], [id^="screen-"], [id$="-menu"], .hol-mode-menu';
    var todas;
    try { todas = document.querySelectorAll(sel); } catch (e) { return normales; }
    for (var i = 0; i < todas.length; i++) {
      var el = todas[i];
      if (esCromo(el)) continue;
      /* Solo contenedores de primer nivel: una pantalla dentro de otra no es
         una alternativa, es una parte. */
      if (el.parentElement !== document.body) continue;
      (esDeCarga(el) ? carga : normales).push(el);
    }
    return normales.concat(carga);
  }

  function intentarPantallas() {
    var cands = pantallasCandidatas();
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var antes = el.className;
      var teniaHidden = el.hasAttribute('hidden');
      el.classList.remove('hidden');
      el.classList.add('active');
      if (teniaHidden) el.removeAttribute('hidden');
      if (hayContenido()) {
        console.warn('[pantalla-viva] No había nada visible; se enseña #' + (el.id || i));
        return true;
      }
      el.className = antes;
      if (teniaHidden) el.setAttribute('hidden', '');
    }
    return false;
  }

  /* ── PASO 3: el panel propio ───────────────────────────────────────────
     Última red. No explica un error técnico que el jugador no puede
     arreglar: dice lo que pasa en una línea y da las dos salidas que sirven. */
  function pintarPanel() {
    if (document.getElementById(ID_PANEL)) return;

    var panel = document.createElement('div');
    panel.id = ID_PANEL;
    panel.setAttribute('role', 'alert');
    var s = panel.style;
    s.position = 'fixed';
    s.top = '0'; s.left = '0'; s.right = '0'; s.bottom = '0';
    s.zIndex = '2147483000';
    s.display = 'flex';
    s.flexDirection = 'column';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.gap = '18px';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = '#f4ead2';
    s.color = '#0f120e';
    s.font = '500 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    var t = document.createElement('p');
    t.textContent = 'No se ha podido montar la pantalla.';
    t.style.margin = '0';
    t.style.fontSize = '17px';
    t.style.fontWeight = '700';

    var sub = document.createElement('p');
    sub.textContent = 'Suele ser un corte de conexión al volver a la app. Tu progreso está guardado.';
    sub.style.margin = '0';
    sub.style.maxWidth = '30em';
    sub.style.opacity = '.75';

    var fila = document.createElement('div');
    fila.style.display = 'flex';
    fila.style.flexWrap = 'wrap';
    fila.style.gap = '10px';
    fila.style.justifyContent = 'center';

    function boton(texto, alPulsar) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = texto;
      var bs = b.style;
      bs.font = 'inherit';
      bs.fontWeight = '700';
      bs.padding = '12px 20px';
      bs.border = '2px solid #0f120e';
      bs.borderRadius = '999px';
      bs.background = '#0f120e';
      bs.color = '#f4ead2';
      bs.cursor = 'pointer';
      b.addEventListener('click', alPulsar);
      return b;
    }

    var reintentar = boton('Reintentar', function () { location.reload(); });
    var portada = boton('Ir a la portada', function () { location.href = '/'; });
    portada.style.background = 'transparent';
    portada.style.color = '#0f120e';

    fila.appendChild(reintentar);
    fila.appendChild(portada);
    panel.appendChild(t);
    panel.appendChild(sub);
    panel.appendChild(fila);
    document.body.appendChild(panel);
    console.warn('[pantalla-viva] Página sin contenido: panel de rescate.');
  }

  function quitarPanel() {
    var p = document.getElementById(ID_PANEL);
    if (p) p.remove();
  }

  /* ── LA COMPROBACIÓN ─────────────────────────────────────────────────
     SIEMPRE SE MIRA DOS VECES antes de tocar nada. Un cambio de pantalla
     tiene un instante en el que lo viejo ya no está y lo nuevo todavía no,
     y actuar ahí sería sustituir un juego que funciona por un panel de
     error — el peor fallo posible para una red de seguridad. Solo se
     rescata si, 400 ms después de la primera lectura, la página SIGUE
     sin nada. Un blanco de verdad no se arregla solo; un parpadeo sí. */
  var revisando = false;
  var confirmando = false;

  function revisar(confirmado) {
    if (revisando || !document.body) return;
    revisando = true;
    try {
      if (hayContenido()) { quitarPanel(); confirmando = false; return; }

      if (!confirmado) {
        if (confirmando) return;
        confirmando = true;
        setTimeout(function () { confirmando = false; revisar(true); }, 400);
        return;
      }

      var api = window.FHPantallaViva;
      if (api && typeof api.rescate === 'function') {
        try { api.rescate(); } catch (e) { console.warn('[pantalla-viva] el rescate del juego falló', e); }
        if (hayContenido()) { quitarPanel(); return; }
      }

      if (intentarPantallas()) { quitarPanel(); return; }

      pintarPanel();
    } finally {
      revisando = false;
    }
  }

  var pedido = 0;
  function pedirRevision(retraso) {
    if (pedido) clearTimeout(pedido);
    pedido = setTimeout(function () { pedido = 0; revisar(); }, retraso || 150);
  }

  /* ── EL CONTENIDO ESTÁ, PERO NO SE VE ──────────────────────────────────
     Caso distinto y con arreglo distinto: la página tiene su contenido pero
     el navegador ha restaurado una posición de scroll que ya no existe (el
     panel de resultados es largo; vuelves y la pantalla de ahora es corta).
     Se ve una franja vacía y parece lo mismo. Solo se toca al RESTAURAR la
     página, nunca mientras se juega: ahí un scroll a la fuerza sería peor
     que el problema. */
  function subirSiSeQuedoEnElVacio() {
    try {
      var raiz = document.scrollingElement || document.documentElement;
      if (!raiz || raiz.scrollTop <= 0) return;
      var W = document.documentElement.clientWidth;
      var H = document.documentElement.clientHeight;
      var puntos = [[W / 2, H * 0.25], [W / 2, H * 0.5], [W / 2, H * 0.75]];
      for (var i = 0; i < puntos.length; i++) {
        var pila = document.elementsFromPoint(puntos[i][0], puntos[i][1]) || [];
        for (var j = 0; j < pila.length; j++) {
          var el = pila[j];
          if (el === document.body || el === document.documentElement) continue;
          if (esCromo(el)) continue;
          if ((el.textContent || '').trim().length) return;   // hay algo que leer
        }
      }
      console.warn('[pantalla-viva] Scroll restaurado a una zona vacía: se sube arriba.');
      raiz.scrollTop = 0;
    } catch (e) { /* nada que hacer */ }
  }

  function arrancar() {
    pedirRevision(800);
    setTimeout(function () { revisar(); }, 2500);

    /* El momento exacto en que una transición se queda a medias. */
    window.addEventListener('error', function () { pedirRevision(200); });
    window.addEventListener('unhandledrejection', function () { pedirRevision(200); });

    /* Volver a la app tras tenerla en segundo plano: es cuando iOS suspende
       la red y la petición en vuelo se cae. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) pedirRevision(250);
    });
    window.addEventListener('pageshow', function () {
      subirSiSeQuedoEnElVacio();
      pedirRevision(250);
    });

    /* Casi todos los cambios de pantalla salen de un toque o del Atrás. */
    document.addEventListener('click', function () { pedirRevision(500); }, true);
    window.addEventListener('popstate', function () { pedirRevision(300); });

    /* Y los que salen solos (un temporizador que termina la partida). Se mira
       como mucho una vez por segundo: aquí interesa el estado final, no cada
       paso intermedio, y la comprobación cara (innerText, que fuerza cálculo
       de estilos) queda así acotada por mucho que el juego repinte.

       childList ADEMAS de attributes, y con subtree: no todas las pantallas se
       esconden con una clase. El Crucigrama reemplaza el innerHTML de su
       contenedor y otros juegos quitan nodos; probándolo se vio que arrancar
       el contenido del DOM no disparaba nada y la página se quedaba en blanco
       sin que el rescate se enterase. */
    if ('MutationObserver' in window) {
      var ultimo = 0;
      new MutationObserver(function () {
        var ahora = Date.now();
        if (ahora - ultimo < 1000) return;
        ultimo = ahora;
        pedirRevision(600);
      }).observe(document.body, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ['class', 'hidden', 'style'],
      });
    }
  }

  window.FHPantallaViva = window.FHPantallaViva || {};
  window.FHPantallaViva.revisar = function () { revisar(); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
})();
