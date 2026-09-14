/* =============================================
   PRECARGA-FOTOS.JS — precargar en segundo plano, EN ORDEN

   Varios juegos conocen de antemano la secuencia de fotos/escudos que van a
   enseñar mucho antes de que le toque a cada una salir en pantalla: la
   carrera completa de un futbolista en La Carrera, el top 10 del día en En
   el Top, la tirada de la tragaperras... Sin precarga, el navegador no pide
   esa imagen hasta que el <img> se crea en el DOM — justo cuando el jugador
   ya está mirando el hueco vacío —, así que el "gran momento" (revelar un
   escudo, la foto final) se ve con un salto en blanco mientras carga.

   FHPrecarga.encolar(lista) mete URLs EN EL ORDEN en que van a hacer falta
   y las va pidiendo en segundo plano, unas pocas a la vez, sin competir con
   lo que el juego necesita AHORA MISMO: usa requestIdleCallback (respaldo
   setTimeout donde no existe, como Safari) y nunca bloquea el arranque ni
   lo que el jugador está mirando en este instante.

   Deliberadamente SIN concurrencia alta: pedir las 20 fotos de golpe
   competiría por ancho de banda con la imagen que el jugador SÍ está
   esperando ahora mismo (la ronda en curso), que es justo el problema que
   esto intenta evitar en otro sitio. Con 3 a la vez y en cola por orden de
   llegada, las primeras en pedirse son las primeras en necesitarse. */
(function () {
  'use strict';

  const MAX_A_LA_VEZ = 3;
  const vistos = new Set();
  const cola = [];
  let enVuelo = 0;

  function siguiente() {
    while (enVuelo < MAX_A_LA_VEZ && cola.length) {
      const url = cola.shift();
      enVuelo++;
      const img = new Image();
      const listo = () => { enVuelo--; siguiente(); };
      img.onload = listo;
      img.onerror = listo;   // una imagen rota no debe atascar la cola
      img.src = url;
    }
  }

  function programar() {
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
      : (fn) => setTimeout(fn, 60);
    idle(siguiente);
  }

  /* `lista`: una URL o un array de URLs, en el orden en que se van a
     necesitar. Ya vista (en cola, cargando o cargada) se ignora — se puede
     llamar varias veces con solapamiento sin duplicar peticiones. */
  function encolar(lista) {
    if (!lista) return;
    const arr = Array.isArray(lista) ? lista : [lista];
    let hayNuevas = false;
    for (const url of arr) {
      if (!url || typeof url !== 'string' || vistos.has(url)) continue;
      vistos.add(url);
      cola.push(url);
      hayNuevas = true;
    }
    if (hayNuevas) programar();
  }

  window.FHPrecarga = { encolar };
})();
