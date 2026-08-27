/* =============================================
   PROGRESS-SYNC.JS — El progreso viaja con la cuenta
   QUIÉN COÑO FALTA

   Cargar SIEMPRE después de js/auth.js.

   Cada juego guarda su progreso en localStorage (la racha del hub se
   calcula leyendo esas claves). Eso ata el progreso al navegador: entras
   desde el móvil y desde el ordenador y son dos historias distintas.

   Aquí se sube ese mismo progreso a profiles.progress (una columna JSON
   del perfil, ver supabase/setup_progreso.sql) y se baja al entrar. Los
   juegos NO se tocan: siguen leyendo y escribiendo su localStorage de
   siempre, y este archivo hace de puente por detrás.

   CÓMO SE JUNTAN DOS DISPOSITIVOS
   Cada clave se guarda con la hora en que se vio cambiar por última vez.
   Al mezclar:
     · Días sueltos (carrera_day_…, cruc_…, enteltop_day_…): gana el más
       reciente. Como cada día se escribe una sola vez, en la práctica no
       hay conflicto: se suman los días de los dos dispositivos y la racha
       sale completa.
     · Contadores acumulados (partidas jugadas, mejor marca, récords de
       Higher or Lower): se quedan con el número más alto de los dos, que
       si no jugar en el móvil borraría lo jugado en el ordenador.
     · Lo demás: gana el más reciente.

   API (window.FHProgress):
     sync()           → baja, mezcla y sube. Devuelve promesa.
     push()           → sube lo que haya ahora.
     snapshot()       → { clave: valor } de todo lo que se sigue.
     onChange(cb)     → avisa cuando el progreso cambia (tras bajar datos).
   También lanza el evento 'fh-progress' en window.
   ============================================= */
(function () {
    'use strict';

    if (!window.FHAuth) { console.error('[FHProgress] Falta auth.js'); return; }

    /* ── Qué claves se sincronizan ──
       prefix: claves "<prefijo><algo>" (un día, un modo de juego…).
       exact:  claves con nombre fijo.
       merge:  cómo resolver si los dos lados tienen valor.
                 'newest' → el más reciente
                 'max'    → el número más alto (récords)
                 'stats'  → objeto de contadores: número a número, el mayor */
    const TRACKED = [
        /* Resultado de cada día — es lo que da la racha del hub */
        { prefix: 'carrera_day_',  merge: 'newest', daily: true },
        { prefix: 'cruc_',         merge: 'newest', daily: true },
        { prefix: 'enteltop_day_', merge: 'newest', daily: true },
        { prefix: 'oncediario_',   merge: 'newest', daily: true },
        { prefix: 'estadio_daily_',merge: 'newest', daily: true },
        { prefix: 'superdraft_day_', merge: 'newest', daily: true },
        { prefix: 'wordle_day_',   merge: 'newest', daily: true },
        /* Partida de hoy a medias (para seguirla en otro dispositivo) */
        { exact: 'carrera_today',  merge: 'newest' },
        { exact: 'enteltop_today', merge: 'newest' },
        /* Contadores acumulados de cada juego */
        { exact: 'carrera_stats',  merge: 'stats' },
        { exact: 'enteltop_stats', merge: 'stats' },
        { exact: 'estadio-stats',  merge: 'stats' },
        { exact: 'footballStats',  merge: 'stats' },
        { exact: 'wordle-stats',   merge: 'stats' },
        /* Récords de Higher or Lower (un número por modo) */
        { prefix: 'hol_record_',   merge: 'max' },
        /* Mejor marca de cada edición de Superdraft (superdraft-best-<nº>).
           'newest' y no 'max': según el objetivo del día se gana subiendo
           (el once más caro) o bajando (el más joven), así que quedarse con
           el número mayor sería mentir la mitad de los días. */
        { prefix: 'superdraft-best-', merge: 'newest' },
    ];

    const META_KEY    = 'fh_progress_meta';   // clave → cuándo cambió aquí
    const OWNER_KEY   = 'fh_progress_owner';   // de qué cuenta es el progreso local
    const MAX_VALUE   = 40 * 1024;            // no subir valores enormes
    const MAX_DAYS    = 400;                  // días sueltos que se conservan
    const POLL_MS     = 4000;                 // cada cuánto se mira si cambió algo
    const PUSH_DELAY  = 2500;                 // espera antes de subir (agrupa cambios)

    let lastSignature = null;
    let pushTimer     = null;
    let pollTimer     = null;
    let busy          = false;
    let dirty         = false;
    let disabled      = false;   // falta la columna: no insistir en cada intento
    const listeners   = [];

    /* ── Utilidades de localStorage ── */

    function lsGet(k)    { try { return localStorage.getItem(k); } catch { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }

    function ruleFor(key) {
        for (const t of TRACKED) {
            if (t.exact && key === t.exact) return t;
            if (t.prefix && key.startsWith(t.prefix) && key.length > t.prefix.length) return t;
        }
        return null;
    }

    /* Todas las claves seguidas que hay ahora mismo en este navegador */
    function localKeys() {
        const out = [];
        let n = 0;
        try { n = localStorage.length; } catch { return out; }
        for (let i = 0; i < n; i++) {
            let k;
            try { k = localStorage.key(i); } catch { continue; }
            if (k && ruleFor(k)) out.push(k);
        }
        return out;
    }

    function snapshot() {
        const out = {};
        for (const k of localKeys()) {
            const v = lsGet(k);
            if (v != null) out[k] = v;
        }
        return out;
    }

    /* Borra del navegador TODO el progreso seguido (días, contadores, récords)
       y sus marcas de tiempo. Se usa al cambiar de cuenta: el localStorage es
       del navegador, no de la cuenta, así que sin esto una cuenta hereda los
       días, rachas y bloqueos diarios de la que jugó antes en el mismo equipo. */
    function clearTrackedLocal() {
        for (const k of localKeys()) { try { localStorage.removeItem(k); } catch { /* nada */ } }
        try { localStorage.removeItem(META_KEY); } catch { /* nada */ }
        lastSignature = null;
        /* Repintar rachas del hub / perfil: lo recién borrado no debe quedarse
           pegado en pantalla de la sesión anterior. */
        notify();
    }

    /* ── Marcas de tiempo por clave ──
       No hay forma de saber cuándo escribió el juego una clave, así que
       la primera vez que la vemos con un valor nuevo apuntamos la hora.
       Con eso basta para decidir quién gana entre dos dispositivos. */

    function loadMeta() {
        try { return JSON.parse(lsGet(META_KEY) || '{}') || {}; } catch { return {}; }
    }
    function saveMeta(m) { lsSet(META_KEY, JSON.stringify(m)); }

    /* Devuelve el meta al día: {clave: {h: huella, t: ms}} */
    function refreshMeta(values) {
        const meta = loadMeta();
        const now  = Date.now();
        let changed = false;
        for (const [k, v] of Object.entries(values)) {
            const h = hash(v);
            if (!meta[k] || meta[k].h !== h) { meta[k] = { h, t: now }; changed = true; }
        }
        /* Claves que ya no están aquí: se olvidan (si siguen en la nube,
           volverán a bajar en la siguiente mezcla). */
        for (const k of Object.keys(meta)) {
            if (!(k in values)) { delete meta[k]; changed = true; }
        }
        if (changed) saveMeta(meta);
        return meta;
    }

    function hash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
        return h;
    }

    function signature(values) {
        const keys = Object.keys(values).sort();
        return hash(keys.map(k => k + ':' + hash(values[k])).join('|'));
    }

    /* ── Mezcla ── */

    function parse(s) { try { return JSON.parse(s); } catch { return undefined; } }

    /* Objeto de contadores: se queda con el número más alto de cada campo.
       Así jugar en el móvil no borra lo jugado en el ordenador. */
    function mergeStats(aStr, bStr, aNewer) {
        const a = parse(aStr), b = parse(bStr);
        if (a === undefined || b === undefined) return aNewer ? aStr : bStr;
        if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
            return aNewer ? aStr : bStr;
        }
        const out = {};
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            const va = a[k], vb = b[k];
            if (typeof va === 'number' && typeof vb === 'number') out[k] = Math.max(va, vb);
            else if (Array.isArray(va) && Array.isArray(vb)) {
                const len = Math.max(va.length, vb.length);
                const arr = new Array(len);
                for (let i = 0; i < len; i++) {
                    const x = va[i], y = vb[i];
                    arr[i] = (typeof x === 'number' && typeof y === 'number')
                        ? Math.max(x, y)
                        : (x === undefined ? y : x);
                }
                out[k] = arr;
            }
            else if (va === undefined) out[k] = vb;
            else if (vb === undefined) out[k] = va;
            else out[k] = aNewer ? va : vb;
        }
        return JSON.stringify(out);
    }

    function mergeValue(rule, localStr, localT, remoteStr, remoteT) {
        if (localStr == null)  return remoteStr;
        if (remoteStr == null) return localStr;
        if (localStr === remoteStr) return localStr;
        const localNewer = (localT || 0) >= (remoteT || 0);
        if (rule.merge === 'max') {
            const a = parseFloat(localStr), b = parseFloat(remoteStr);
            if (Number.isFinite(a) && Number.isFinite(b)) return String(Math.max(a, b));
            return localNewer ? localStr : remoteStr;
        }
        if (rule.merge === 'stats') return mergeStats(localStr, remoteStr, localNewer);
        return localNewer ? localStr : remoteStr;
    }

    /* Los días sueltos se podan: guardar años de crucigramas resueltos
       engorda el perfil sin aportar nada (la racha mira 400 días atrás). */
    function tooOld(key, rule) {
        if (!rule.daily) return false;
        const m = key.match(/(\d{4})-?(\d{2})-?(\d{2})$/);
        if (!m) return false;
        const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        return (Date.now() - day) > MAX_DAYS * 86400000;
    }

    /* ── Supabase ── */

    async function readRemote() {
        const session = await FHAuth.getSession();
        if (!session) return null;
        const { data, error } = await FHAuth.client
            .from('profiles').select('progress').eq('id', session.user.id).maybeSingle();
        if (error) {
            if (/progress/i.test(error.message || '')) {
                console.warn('[FHProgress] Falta la columna progress: ejecuta supabase/setup_progreso.sql');
                disabled = true;      // sin columna no hay nada que hacer
                stopPolling();
                return null;
            }
            console.warn('[FHProgress] Error leyendo el progreso:', error.message);
            return null;
        }
        const p = data && data.progress;
        return (p && typeof p === 'object' && p.keys) ? p : { v: 1, keys: {} };
    }

    async function writeRemote(payload) {
        const session = await FHAuth.getSession();
        if (!session) return false;
        const { error } = await FHAuth.client
            .from('profiles').update({ progress: payload }).eq('id', session.user.id);
        if (error) {
            console.warn('[FHProgress] Error guardando el progreso:', error.message);
            return false;
        }
        return true;
    }

    /* ── Bajar + mezclar + subir ── */

    async function sync() {
        if (busy || disabled) return false;
        const session = await FHAuth.getSession();
        if (!session) return false;
        busy = true;
        try {
            const localValues = snapshot();
            const meta        = refreshMeta(localValues);
            const remote      = await readRemote();
            if (!remote) return false;

            const remoteKeys = remote.keys || {};
            const merged     = {};      // clave → {s, t}
            let localChanged = false;

            const allKeys = new Set([...Object.keys(localValues), ...Object.keys(remoteKeys)]);
            for (const key of allKeys) {
                /* Claves que envenenarían el prototipo al hacer merged[key]=…
                   El progreso remoto es propio (RLS por fila), así que esto solo
                   sería auto-infligible, pero cortarlo aquí es gratis. */
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
                const rule = ruleFor(key);
                if (!rule) continue;

                const localStr = localValues[key] ?? null;
                const localT   = meta[key] ? meta[key].t : 0;
                const rEntry   = remoteKeys[key];
                const remoteStr = rEntry && typeof rEntry.s === 'string' ? rEntry.s : null;
                const remoteT   = rEntry && typeof rEntry.t === 'number' ? rEntry.t : 0;

                const value = mergeValue(rule, localStr, localT, remoteStr, remoteT);
                if (value == null) continue;

                /* Lo que venga de fuera (o de la mezcla) se escribe aquí para
                   que el juego y la racha del hub lo vean como propio. */
                if (value !== localStr) {
                    if (lsSet(key, value)) localChanged = true;
                }
                if (tooOld(key, rule)) continue;
                if (value.length > MAX_VALUE) continue;

                merged[key] = { s: value, t: Math.max(localT, remoteT) || Date.now() };
            }

            /* Reajustar las marcas locales a lo que ha quedado */
            const newMeta = loadMeta();
            for (const [k, e] of Object.entries(merged)) {
                newMeta[k] = { h: hash(e.s), t: e.t };
            }
            saveMeta(newMeta);

            const payload = { v: 1, keys: merged, updatedAt: Date.now() };
            const same = JSON.stringify(remoteKeys) === JSON.stringify(merged);
            if (!same) await writeRemote(payload);

            lastSignature = signature(snapshot());
            dirty = false;

            if (localChanged) notify();
            return true;
        } catch (e) {
            console.warn('[FHProgress] sync falló:', e);
            return false;
        } finally {
            busy = false;
        }
    }

    /* Subir sin bajar: para cuando acabas una partida y solo hay que
       dejar constancia (el sync completo ya corrió al entrar). */
    async function push() { return sync(); }

    function notify() {
        try { window.dispatchEvent(new CustomEvent('fh-progress')); } catch { /* nada */ }
        listeners.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });
    }

    function onChange(cb) { if (typeof cb === 'function') listeners.push(cb); }

    /* ── Cuándo se sincroniza ──
       No hay forma de que los juegos nos avisen sin tocarlos uno a uno,
       así que se vigila el localStorage: si cambia algo de lo que
       seguimos, se sube al poco (agrupando cambios seguidos). */

    function schedulePush() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { pushTimer = null; sync(); }, PUSH_DELAY);
    }

    function checkLocal() {
        const sig = signature(snapshot());
        if (lastSignature === null) { lastSignature = sig; return; }
        if (sig === lastSignature) return;
        lastSignature = sig;
        dirty = true;
        schedulePush();
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') checkLocal();
        }, POLL_MS);
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            /* Al salir de la pestaña: si hay algo sin subir, subirlo ya
               (sin esperar al agrupador, que puede no llegar a correr). */
            checkLocal();
            if (dirty) { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } sync(); }
        } else {
            checkLocal();
        }
    });

    /* Otra pestaña del mismo navegador ha jugado: recoger el cambio */
    window.addEventListener('storage', (e) => {
        if (e.key && ruleFor(e.key)) { dirty = true; schedulePush(); }
    });

    /* Sesión: al entrar se baja y se mezcla; al salir se deja de vigilar.
       El "dueño" (id de la cuenta) se guarda en el navegador para detectar
       cambios de cuenta. Nos basamos en la SESIÓN, no en identity(), porque
       una cuenta recién creada puede tener sesión sin username todavía. */
    FHAuth.onIdentity(async () => {
        let owner = null;
        try { const s = await FHAuth.getSession(); owner = s ? s.user.id : null; }
        catch { owner = null; }
        const prevOwner = lsGet(OWNER_KEY);

        if (owner) {
            /* Entra una cuenta. Si el navegador guardaba el progreso de OTRA,
               se borra antes de sincronizar: si no, la mezcla lo heredaría
               (rachas y bloqueo del diario de la cuenta anterior). */
            if (prevOwner && prevOwner !== owner) clearTrackedLocal();
            lsSet(OWNER_KEY, owner);
            lastSignature = null;
            sync().then(() => { lastSignature = signature(snapshot()); });
            startPolling();
        } else {
            /* Cierra sesión. Si había una cuenta dueña del progreso local, se
               borra para que quien entre luego (u otra cuenta) no lo herede. */
            if (prevOwner) {
                clearTrackedLocal();
                try { localStorage.removeItem(OWNER_KEY); } catch { /* nada */ }
            }
            stopPolling();
        }
    });

    window.FHProgress = { sync, push, snapshot, onChange };
})();
