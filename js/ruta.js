/* =============================================
   RUTA.JS — el estado recuperable vive en la URL

   Hasta ahora la barra de direcciones no decía nada: daba igual que
   estuvieras en el once de Champions, en el crucigrama del martes o dentro
   de una sala, la URL era siempre la misma. Al recargar (o al volver desde
   otra pestaña, o al compartir el enlace) acababas en el menú.

   Aquí vive el vocabulario común para que no haya trece maneras distintas
   de hacerlo. Los nombres de clave son los tres que ya se usaban o se
   entienden solos:

     ?sala=ABCD          la sala online   (ya era el convenio de la casa)
     ?modo=champions     el modo de juego
     ?dia=2026-08-20     la edición de un juego diario (SIEMPRE fecha ISO,
                         aunque el juego cuente por número de día)

   Query params y no '#': ?sala= ya iba así y los enlaces de invitación que
   la gente tenga por ahí compartidos tienen que seguir valiendo.

   NADA de lo que llega por aquí es de fiar: lo escribe cualquiera en la
   barra. Cada juego valida lo suyo contra su lista real (que la fecha esté
   entre sus ediciones, que el modo exista) antes de hacerle caso.
   ============================================= */
(function () {
  'use strict';

  function params() { return new URLSearchParams(location.search); }

  function get(clave) {
    const v = params().get(clave);
    return (v == null || v === '') ? null : v;
  }

  /* Escribe o borra claves SIN tocar las demás: ?sala= y ?modo= conviven, y
     un juego no puede cargarse la clave de otro por escribir la suya.
     Pasar null / '' / false borra la clave.

     push:true deja rastro en el historial. Solo para lo que el usuario vive
     como "me he movido a otro sitio" (cambiar de día), porque ahí el botón
     Atrás del móvil tiene que devolverle a la edición anterior. Para el modo
     y la sala se reemplaza: si no, salir de una sala y volver a entrar te
     deja diez entradas de basura y el Atrás no lleva a ninguna parte. */
  function set(cambios, opciones) {
    const p = params();
    let tocado = false;

    for (const k in cambios) {
      const v = cambios[k];
      const nuevo = (v == null || v === false || v === '') ? null : String(v);
      if (nuevo === p.get(k)) continue;
      if (nuevo === null) p.delete(k); else p.set(k, nuevo);
      tocado = true;
    }
    if (!tocado) return false;

    const qs = p.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    try {
      history[(opciones && opciones.push) ? 'pushState' : 'replaceState'](
        { fhRuta: true }, '', url);
      return true;
    } catch (e) {
      /* history falla en file:// y en algún navegador con el historial lleno.
         No es motivo para tumbar un juego: la URL se queda como estaba. */
      return false;
    }
  }

  function borrar() {
    const cambios = {};
    for (let i = 0; i < arguments.length; i++) cambios[arguments[i]] = null;
    return set(cambios);
  }

  /* El botón Atrás. El callback recibe los params ya leídos. */
  function alVolver(fn) {
    window.addEventListener('popstate', function () {
      try { fn(params()); } catch (e) { console.warn('[ruta] Atrás:', e); }
    });
  }

  /* Fecha ISO válida y con pinta de fecha de verdad, para no pasarle a un
     juego un '?dia=<script>' o un '2026-13-45'. Devuelve null si no cuela. */
  function fecha(clave) {
    const v = get(clave || 'dia');
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + 'T00:00:00Z');
    return (!isNaN(d) && d.toISOString().slice(0, 10) === v) ? v : null;
  }

  /* ── VOLVER A UNA SALA ────────────────────────────────────────────────
     Con ?sala= en la URL ya se sabía a QUÉ sala volver, pero no QUIÉN eras:
     al recargar te tocaba escribir el nombre otra vez y pulsar Unirse. Aquí
     se recuerda el nombre con el que entraste, para que la vuelta sea sola.

     Se guarda por juego y CADUCA: una sala de hace dos días no existe ya en
     Firebase, y arrastrarte a ella al abrir el juego sería peor que no hacer
     nada. La ventana es corta a propósito.

     El código de la sala NO se saca de aquí, se saca de la URL: si no, abrir
     el juego normalmente te metería en la última sala en la que estuviste. */
  const CLAVE_SALA = 'fh_sala_';
  const VENTANA_SALA_MS = 3 * 60 * 60 * 1000;   // 3 horas

  /* `datos` es para lo que cada juego necesite además del nombre. En La Cadena
     es el número de asiento: sin él, volver a la sala te AÑADE como jugador
     nuevo y te quedas duplicado al lado de tu propio fantasma. */
  function recordarSala(juego, codigo, nombre, datos) {
    try {
      localStorage.setItem(CLAVE_SALA + juego, JSON.stringify({
        codigo: String(codigo), nombre: String(nombre || ''),
        datos: datos || null, ts: Date.now(),
      }));
    } catch (e) { /* modo incógnito, cuota llena: se pierde la vuelta, no el juego */ }
  }

  /* Devuelve { codigo, nombre } solo si lo recordado es de ESA sala y aún
     está dentro de la ventana. En cualquier otro caso, null. */
  function salaRecordada(juego, codigo) {
    if (!codigo) return null;
    try {
      const raw = localStorage.getItem(CLAVE_SALA + juego);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.codigo || !d.nombre) return null;
      if (Date.now() - (d.ts || 0) > VENTANA_SALA_MS) return null;
      if (String(d.codigo).toUpperCase() !== String(codigo).toUpperCase()) return null;
      return { codigo: d.codigo, nombre: d.nombre, datos: d.datos || null };
    } catch (e) { return null; }
  }

  function olvidarSala(juego) {
    try { localStorage.removeItem(CLAVE_SALA + juego); } catch (e) {}
  }

  /* Código de sala válido: 4-8 letras y números. Lo escribe cualquiera en la
     barra, así que no se le pasa a Firebase tal cual. */
  function sala() {
    const v = get('sala');
    return (v && /^[A-Za-z0-9]{4,8}$/.test(v)) ? v.toUpperCase() : null;
  }

  window.FHRuta = { get, set, borrar, alVolver, fecha, params,
                    sala, recordarSala, salaRecordada, olvidarSala };
})();
