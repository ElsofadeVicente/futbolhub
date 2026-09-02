/* =============================================
   BOT-NAMES.JS
   Nombres de los jugadores automáticos de salas públicas.

   Fuente principal: bot-names.json en Supabase Storage
   (bucket game-data), igual que el resto de datos de los
   juegos. Se edita subiendo el archivo otra vez, sin tocar
   código ni desplegar.

   Si Storage no responde, cae a la copia local
   data/bot-names.json que va en el repo.

   Si no hay ningún nombre disponible NO se inventa
   ninguno: simplemente no se añaden bots. Es preferible
   una sala sin bots a una sala con nombres de relleno
   evidentes.
   ============================================= */

const BotNames = (() => {

  const STORAGE_FILE = 'bot-names.json';           // en el bucket game-data
  const LOCAL_JSON   = '../data/bot-names.json';   // respaldo dentro del repo

  let _names   = null;   // array ya cargado
  let _promise = null;

  /* ─── Normaliza para comparar nombres (evita chocar con humanos) ─── */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /* ─── Limpia y deduplica una lista cruda de nombres ─── */
  function _clean(list) {
    const out  = [];
    const seen = new Set();
    for (const raw of (list || [])) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      const k = norm(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
    return out;
  }

  /* ─── Lee y normaliza un JSON de nombres ───
     Admite tanto ["a","b"] como {"names":["a","b"]} */
  async function _fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return _clean(Array.isArray(data) ? data : data?.names);
  }

  /* ─── Supabase Storage (override opcional) ─── */
  function _fromStorage() {
    if (typeof sbStorageUrl !== 'function') {
      return Promise.reject(new Error('sbStorageUrl no disponible'));
    }
    return _fetchJson(fhDataUrl('game-data', STORAGE_FILE));
  }

  /* ─── Copia local del repo (fuente principal) ─── */
  function _fromLocalJson() {
    return _fetchJson(LOCAL_JSON);
  }

  /* ═══════════════════════════════════════════
     CARGAR (cacheado, una sola vez por sesión)
     ═══════════════════════════════════════════ */
  function load() {
    if (_names)   return Promise.resolve(_names);
    if (_promise) return _promise;

    /* PRIMERO LA COPIA LOCAL, y no es un detalle: `game-data/bot-names.json`
       NUNCA se ha subido a Storage (no hay ninguna seccion de
       sync_supabase.py que lo suba), asi que pedirlo primero era un 400
       garantizado en CADA carga de los 6 juegos con bots — y encima en la
       ruta critica, retrasando la creacion de bots lo que tarde esa ida y
       vuelta a Supabase. El archivo local esta en git, se despliega con el
       resto del sitio y es el que manda de verdad.

       Si algun dia se quieren cambiar los nombres SIN desplegar: sube
       data/bot-names.json a game-data/ (haria falta anadirlo al sync) y
       vuelve a poner _fromStorage() delante. */
    _promise = _fromLocalJson()
      .then(list => {
        if (list && list.length) return list;
        throw new Error('archivo vacío');
      })
      .catch(e => {
        console.warn('[BotNames] copia local no disponible (' + e.message + '), probando Storage');
        return _fromStorage();
      })
      .then(list => {
        _names = list || [];
        console.log(`[BotNames] ${_names.length} nombres disponibles`);
        return _names;
      })
      .catch(e => {
        console.warn('[BotNames] Sin nombres disponibles:', e.message);
        _names = [];
        return _names;
      });

    return _promise;
  }

  /* ═══════════════════════════════════════════
     ELEGIR N NOMBRES AL AZAR
     taken — nombres ya presentes en la sala (humanos y bots)
             que no se pueden repetir.
     Devuelve menos de `count` si no hay suficientes libres.
     ═══════════════════════════════════════════ */
  function pick(count, taken = []) {
    if (!_names || !_names.length || count <= 0) return [];

    const used = new Set(taken.map(norm));
    const free = _names.filter(n => !used.has(norm(n)));
    if (!free.length) return [];

    // Fisher-Yates parcial: barajar solo lo necesario
    const pool = [...free];
    const out  = [];
    for (let i = 0; i < count && pool.length; i++) {
      const j = Math.floor(Math.random() * pool.length);
      out.push(pool.splice(j, 1)[0]);
    }
    return out;
  }

  /* ─── ¿Hay nombres? (sin disparar la carga) ─── */
  function ready() {
    return Array.isArray(_names) && _names.length > 0;
  }

  return { load, pick, ready, norm };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BotNames;
}
