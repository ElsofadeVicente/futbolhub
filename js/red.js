/* =============================================
   RED.JS — pedir datos sin que un parpadeo de conexión rompa la partida

   ── POR QUE EXISTE ───────────────────────────────────────────────────────
   El momento en el que aparecían las pantallas en blanco no era "estar sin
   cobertura": era VOLVER A LA APP después de tenerla en segundo plano. iOS
   suspende la red mientras la PWA está detrás, y la primera petición que
   sale al volver se cae aunque la cobertura sea perfecta. Un solo `fetch`
   fallido bastaba para dejar a un juego sin datos, y de ahí a la pantalla
   vacía.

   La cura no es un botón de reintentar —eso es pedirle al jugador que
   arregle lo nuestro—: es que la petición se reintente sola y, sobre todo,
   que ESPERE a que haya red antes de gastar un intento contra la pared.

   Esta lógica nació dentro de la-carrera/js/carrera.js, donde se demostró
   que arreglaba el caso. Vive aquí para que la usen todos los juegos, que
   tenían el mismo `fetch` pelado.

   ── QUE SE REINTENTA Y QUE NO ────────────────────────────────────────────
   Los 4xx que no son 429 NO se reintentan: significan que ese archivo no
   está, y repetirlo tres veces solo retrasa la respuesta. Se reintenta lo
   que puede ser pasajero: el fallo de red, los 5xx y el 429.

   navigator.onLine es poco de fiar en positivo (dice true con una wifi sin
   salida) pero en NEGATIVO es fiable: si dice false, seguro que no hay red.
   Por eso solo se usa para esperar, nunca para dar por buena la conexión.
   ============================================= */
(function () {
  'use strict';

  var REINTENTOS   = 3;
  var ESPERA_MS    = [350, 1000];   // entre intento y intento
  var ESPERA_RED_MS = 6000;         // tope esperando a recuperar conexión

  function duerme(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function esperarRed() {
    if (navigator.onLine !== false) return Promise.resolve();
    return new Promise(function (resolve) {
      var listo = false;
      var fin = function () {
        if (listo) return;
        listo = true;
        window.removeEventListener('online', fin);
        resolve();
      };
      window.addEventListener('online', fin);
      setTimeout(fin, ESPERA_RED_MS);
    });
  }

  /* Devuelve la Response (ya comprobada como ok). Para JSON, usa json(). */
  async function pedir(url, opciones) {
    var opts = opciones || {};
    var cache = opts.cache || 'no-cache';

    /* Si el envoltorio global está puesto (lo normal: lo instala este mismo
       archivo más abajo), los reintentos ya los hace él. Repetirlos aquí
       serían tres intentos dentro de otros tres — nueve, y una espera larga
       para el jugador. El bucle de abajo se queda solo como respaldo. */
    if (window.__fhFetchEnvuelto) {
      var res = await fetch(url, { cache: cache });
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status + ' -> ' + url);
        err.status = res.status;
        throw err;
      }
      return res;
    }

    var ultimo;
    for (var intento = 0; intento < REINTENTOS; intento++) {
      if (intento) await duerme(ESPERA_MS[intento - 1] || 1000);
      await esperarRed();
      try {
        var r = await fetch(url, { cache: cache });
        if (r.ok) return r;
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          var e4 = new Error('HTTP ' + r.status + ' -> ' + url);
          e4.status = r.status;
          e4.definitivo = true;
          throw e4;
        }
        ultimo = new Error('HTTP ' + r.status + ' -> ' + url);
      } catch (e) {
        if (e && e.definitivo) throw e;
        ultimo = e;   // fallo de red, o cuerpo cortado: se reintenta
      }
    }
    throw ultimo || new Error('No se pudo cargar ' + url);
  }

  async function json(url, opciones) {
    var r = await pedir(url, opciones);
    return await r.json();
  }

  /* Como json(), pero devuelve `porDefecto` en vez de lanzar. Para datos que
     el juego sabe rellenar sin ellos (una foto, unas estadísticas): así el
     que llama no se ve obligado a un try/catch que acabe convirtiendo un
     fallo de red en un dato vacío sin que nadie se entere. */
  async function jsonOpcional(url, porDefecto, opciones) {
    try { return await json(url, opciones); }
    catch (e) { return porDefecto === undefined ? null : porDefecto; }
  }

  /* ── Y AHORA LO QUE DE VERDAD ARREGLA LOS 14 JUEGOS ─────────────────────
     Las llamadas de arriba solo sirven si el juego las usa, y hay ~25 `fetch`
     pelados repartidos por los 14 juegos (Wordle, En el Once, El Estadio,
     Higher or Lower, los cargadores compartidos de jugadores…). Ir cambiando
     uno a uno es exactamente lo que se lleva un mes haciendo con este fallo:
     se arregla el que se mira y el siguiente sigue igual.

     Así que se envuelve `window.fetch` UNA vez y todas se arreglan a la vez,
     sin tocar ni una línea de los juegos.

     CON MUCHO CUIDADO DE NO ENVOLVER LO QUE NO TOCA:

       · Solo GET. Un POST reintentado puede duplicar una jugada o un
         resultado; eso sería mucho peor que el fallo que arregla.
       · Solo NUESTROS datos (Supabase Storage y nuestro proxy de imágenes).
         Firebase tiene su propia reconexión, AdSense y el CMP no son asunto
         nuestro, y /api/ranked o /api/titulares no se tocan.
       · Nada de peticiones abortadas: si el que llama cancela, se cancela.
       · Y en el peor caso se comporta EXACTAMENTE como `fetch`: devuelve la
         última respuesta mala o lanza el mismo error de red, para que el
         manejo de errores que ya tienen los juegos siga valiendo. */

  var HOSTS_NUESTROS = /(^|\.)supabase\.co$/i;

  function esNuestroDato(url, metodo) {
    if (metodo && metodo.toUpperCase() !== 'GET') return false;
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin) return u.pathname.indexOf('/api/img') === 0;
      return HOSTS_NUESTROS.test(u.hostname) && u.pathname.indexOf('/storage/') === 0;
    } catch (e) { return false; }
  }

  function instalar() {
    if (window.__fhFetchEnvuelto || typeof window.fetch !== 'function') return;
    window.__fhFetchEnvuelto = true;
    var original = window.fetch.bind(window);

    window.fetch = function (entrada, init) {
      var url = (typeof entrada === 'string') ? entrada
              : (entrada && entrada.url) || '';
      var metodo = (init && init.method) || (entrada && entrada.method) || 'GET';
      if (!esNuestroDato(url, metodo)) return original(entrada, init);

      var senal = (init && init.signal) || (entrada && entrada.signal) || null;

      return (async function () {
        var ultimaRespuesta = null, ultimoError = null;
        for (var intento = 0; intento < REINTENTOS; intento++) {
          if (senal && senal.aborted) break;
          if (intento) {
            await duerme(ESPERA_MS[intento - 1] || 1000);
            await esperarRed();
            if (senal && senal.aborted) break;
          }
          try {
            var r = await original(entrada, init);
            if (r.ok) return r;
            // Ese archivo no está: repetirlo no lo va a traer.
            if (r.status >= 400 && r.status < 500 && r.status !== 429) return r;
            ultimaRespuesta = r;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            ultimoError = e;
            /* Un Request solo se puede consumir una vez: si venía como objeto
               Request en vez de como URL, reintentar con el mismo daría
               "body already used". Se devuelve el fallo tal cual. */
            if (typeof entrada !== 'string' && !(entrada instanceof URL)) throw e;
          }
        }
        if (ultimaRespuesta) return ultimaRespuesta;
        throw ultimoError || new TypeError('Failed to fetch');
      })();
    };
  }

  instalar();

  /* ── Y CUANDO EL ARRANQUE YA SE HA CAIDO DEL TODO ───────────────────────
     Reintentar la peticion sirve mientras la pagina esta cargando. Pero si
     el arranque de un juego llego a fallar, lo que queda en pantalla es un
     mensaje de error MUERTO: nadie vuelve a intentarlo nunca, y el jugador
     se queda ahi hasta que sale y entra otra vez a mano. En la PWA de iOS
     eso no es el caso raro, es el normal — la app se suspende, vuelve con la
     red todavia levantandose, la primera tanda de peticiones se cae, y ese
     error se queda para siempre aunque un segundo despues haya cobertura de
     sobra.

     alRecuperar(fn) llama a fn en los tres momentos en que puede haber
     dejado de fallar: al volver la pagina al primer plano, al restaurarse
     (incluido el back-forward cache de Safari) y al recuperar conexion. El
     juego decide si tiene algo que hacer; aqui solo se avisa.

     Se avisa como mucho una vez cada 1,5 s: los tres eventos llegan JUNTOS
     al volver de segundo plano y no tiene sentido reintentar tres veces. */
  var oyentes = [];
  var ultimoAviso = 0;

  function avisar() {
    var ahora = Date.now();
    if (ahora - ultimoAviso < 1500) return;
    ultimoAviso = ahora;
    for (var i = 0; i < oyentes.length; i++) {
      try { oyentes[i](); }
      catch (e) { console.warn('[FHRed] un oyente de recuperacion fallo', e); }
    }
  }

  function alRecuperar(fn) {
    if (typeof fn !== 'function') return;
    oyentes.push(fn);
    if (oyentes.length > 1) return;   // los listeners, una sola vez
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) avisar();
    });
    window.addEventListener('pageshow', avisar);
    window.addEventListener('online', avisar);
  }

  window.FHRed = {
    pedir: pedir, json: json, jsonOpcional: jsonOpcional,
    alRecuperar: alRecuperar,
  };
})();
