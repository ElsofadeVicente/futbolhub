/* =============================================
   ADS.JS — Unidades de AdSense de FutbolHUB

   Los IDs de cada bloque salen de AdSense -> Anuncios -> Por unidad de
   anuncio (el numero largo del atributo data-ad-slot). Se pegan aqui abajo,
   una sola vez para toda la web.

   IMPORTANTE: un hueco sin ID configurado NO se pinta ni deja rastro. Nada
   de recuadros vacios ni de placeholders — o hay anuncio o no hay nada.

   ── DOS CAMBIOS DE FONDO (2026-08-31) ─────────────────────────────────────

   1) EL SCRIPT DE ADSENSE SE CARGA DESDE AQUI, Y SOLO SI HACE FALTA.
      Antes las 15 paginas traian el <script async src=".../adsbygoogle.js">
      a fuego en el <head>. En los 14 JUEGOS los unicos huecos eran los dos
      rascacielos laterales, que css/ads.css oculta por debajo de 1240px, o
      sea que en CUALQUIER movil —o sea, en la PWA— pasaba esto en cada
      pagina, medido en 375x812:

        · adsbygoogle.js (~161 KB) + show_ads_impl (~491 KB) descargados y
          ejecutados,
        · 5 iframes de terceros levantados (googlesyndication, doubleclick,
          adtrafficquality...),
        · un <ins> metido dentro de una columna en display:none y un
          'TagError: No slot size for availableWidth=0' por cada uno,

      todo para servir CERO anuncios. Peso, bateria, CPU y —lo que mas
      importa aqui— memoria de un proceso que en una PWA de iOS va mucho mas
      justo que en Safari.

   2) CADA HUECO SE PINTA CUANDO SE VE, NO AL CARGAR LA PAGINA.
      Los huecos nuevos de movil viven DENTRO de pantallas que empiezan
      ocultas (el menu de un juego, el panel de fin de partida). Un
      hueco no se enciende hasta que esa pantalla se muestra de verdad, asi
      que el anuncio del panel de resultados no cuesta ni un byte a quien
      todavia esta jugando.

   REGLA DE COLOCACION (lo que NO se hace, y por que):
     · Nada de 'anchor' fijo abajo: se come 50-60px del borde inferior, que
       es donde viven la barra de ediciones (#day-nav), el teclado del
       Crucigrama y los botones de El Estadio y Wordle.
     · Nada de 'vignette' a pantalla completa: dispara en el momento de la
       navegacion, que es justo donde la PWA de iOS venia dando problemas.
     · Las unidades de movil van SIEMPRE en pantallas donde no se juega
       (menu y fin de partida) y DESPUES de los botones de accion, para que
       al cargar no desplacen el boton que el dedo iba a pulsar.
   ============================================= */
(function () {
  'use strict';

  const CLIENT = 'ca-pub-1248309481500017';
  const LOADER = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + CLIENT;

  /* ── IDs de las unidades ──
     Un hueco con la cadena vacia simplemente no se pinta, asi que se puede
     anadir o quitar un emplazamiento desde aqui sin tocar HTML.

     'movil-menu' y 'movil-final' estan puestos pero SIN ID todavia: la
     cuenta de AdSense sigue pendiente de revision, asi que no hay unidades
     que crear. En cuanto aprueben el sitio se crean dos bloques display
     adaptables y se pegan aqui: los huecos ya estan repartidos por los 14
     juegos y se encienden todos a la vez, sin tocar ni un HTML. */
  const SLOTS = {
    'rail-left':   '8439524497',  // "FutbolHUB rail izq"  — vertical, columna izquierda (>=1240px)
    'rail-right':  '4500279480',  // "FutbolHUB rail dcha" — vertical, columna derecha  (>=1240px)
    'inline':      '1958976708',  // "FutbolHUB inline"    — horizontal, bajo la rejilla del hub
    'movil-menu':  '',            // menu de cada juego, debajo de la descripcion (<1240px)
    'movil-final': '',            // panel de fin de partida, tras los botones (<1240px)
  };

  /* Un hueco solo cuenta si ocupa sitio de verdad. offsetWidth es la prueba
     buena: da 0 tanto si el propio hueco esta oculto como si lo esta
     cualquier ancestro —que es el caso de .ad-col en movil y el de una
     .screen sin .active— y no obliga a saber QUIEN lo oculto. La altura no
     vale: un hueco sin llenar mide 0 de alto a proposito
     (.ad-slot:not([data-ad-filled])). */
  function visible(host) {
    return host.offsetWidth > 0;
  }

  function pintar(host) {
    if (host.hasAttribute('data-ad-filled')) return;
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.setAttribute('data-ad-client', CLIENT);
    ins.setAttribute('data-ad-slot', SLOTS[host.getAttribute('data-ad')]);
    ins.style.display = 'block';
    ins.setAttribute('data-ad-format', 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');

    host.appendChild(ins);
    host.setAttribute('data-ad-filled', '');
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      /* Bloqueador de anuncios, o el script no cargo: sin drama. */
    }
  }

  /* Sin ID configurado: fuera el hueco Y la columna que lo envolvia, si se
     queda vacia. Si no, el grid seguiria reservando 172px a cada lado para
     nada y el contenido saldria estrechado sin motivo. */
  function tirar(host) {
    const col = host.closest('.ad-col');
    host.remove();
    if (col && !col.querySelector('[data-ad]')) col.remove();
  }

  let cargado = false;
  function cargarAdSense() {
    if (cargado) return;
    cargado = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = LOADER;
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  }

  function encender(host) {
    cargarAdSense();
    pintar(host);
  }

  /* ── CUANDO SE ENCIENDE CADA HUECO ──────────────────────────────────
     El criterio es offsetWidth > 0 y NADA MAS. Es la unica prueba que vale
     aqui, y la razon es una trampa que costo encontrar: un hueco sin llenar
     mide 0 DE ALTO a proposito (.ad-slot:not([data-ad-filled])), para no
     dejar un boquete de 600px si AdSense no sirve nada. Con area cero, un
     IntersectionObserver NO llega a decir que el hueco es visible aunque
     este perfectamente en pantalla — probado: los dos rascacielos salian
     160x0 en un escritorio de 1400px y no se pintaba ninguno. El ancho, en
     cambio, si es real (160px el rascacielos, 336px el de movil) y se va a
     0 en cuanto lo esconde el propio hueco o CUALQUIER ancestro, que es lo
     que pasa con .ad-col en movil y con una .screen sin .active.

     Como el ancho puede cambiar sin scroll ni resize —el juego le pone
     .active a otra pantalla y ahi aparece el hueco del panel de
     resultados—, se vigilan los cambios de atributo del documento: se mira
     una vez por fotograma como mucho, y en cuanto no queda ningun hueco por
     resolver se suelta el vigilante. */
  let repasoPedido = 0;
  function pedirRepaso() {
    if (repasoPedido) return;
    /* setTimeout y NO requestAnimationFrame: rAF no se ejecuta con la
       pestana oculta o en segundo plano, asi que un panel de resultados que
       se abriera con el movil bloqueado (o con la app detras de otra) se
       quedaria sin encender su hueco para siempre. Es el mismo tropiezo que
       ya se documento en Bingo con la entrada en cascada del carton. */
    repasoPedido = setTimeout(() => { repasoPedido = 0; repasar(); }, 0);
  }

  const vigilante = ('MutationObserver' in window)
    ? new MutationObserver(pedirRepaso)
    : null;

  function repasar() {
    document.querySelectorAll('[data-ad]:not([data-ad-filled])').forEach(host => {
      if (!SLOTS[host.getAttribute('data-ad')]) { tirar(host); return; }
      if (visible(host)) encender(host);
    });
    /* Nada mas que esperar: fuera el vigilante, para no pagar un callback
       por cada clase que cambie durante la partida. */
    if (vigilante && !document.querySelector('[data-ad]:not([data-ad-filled])')) {
      vigilante.disconnect();
    }
  }

  function init() {
    repasar();
    /* Una pantalla que se muestra (una .screen que gana .active, un panel al
       que le quitan [hidden]) es un cambio de ATRIBUTO, no de scroll: es lo
       unico que hace aparecer los huecos de movil. */
    if (vigilante && document.querySelector('[data-ad]:not([data-ad-filled])')) {
      vigilante.observe(document.body, {
        subtree: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'style'],
      });
    }
    /* Cruzar el umbral de las columnas (girar la tableta, agrandar la
       ventana) hace visible un hueco que antes no lo era. matchMedia y no
       'resize' para no repasar el DOM en cada pixel del arrastre. */
    try {
      const mq = window.matchMedia('(min-width: 1240px)');
      const alCambiar = () => pedirRepaso();
      if (mq.addEventListener) mq.addEventListener('change', alCambiar);
      else if (mq.addListener) mq.addListener(alCambiar);   // Safari < 14
    } catch (e) { /* sin matchMedia: se queda con el repaso inicial */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
