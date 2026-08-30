'use strict';
/* ═══════════════════════════════════════════════════════════════
   RESTRICTIONS WORKER — envoltorio fino sobre js/ranked-engine.js
   -----------------------------------------------------------------
   Ejecuta RankedEngine.generate() en un hilo separado para no bloquear
   el hilo principal (countdown, UI, animaciones).

   PLAN-coche-ranked.md, Fase 0 (2026-08-29): este archivo llevaba su
   PROPIA copia completa de CLUBS_LIST/NATIONALITIES/generate()/
   _ensureSolution/etc., con el riesgo de divergencia que avisaba el
   comentario del `new Worker(...?v=)` de coche/js/script.js: si esta
   copia y la de script.js se desincronizaban, dos jugadores de la misma
   sala podían generar rejillas DISTINTAS con la misma semilla. Ahora las
   dos (y el árbitro de Clasificatoria, api/ranked.js) llaman al MISMO
   código en js/ranked-engine.js — solo puede haber una copia porque ya
   no hay ninguna.

   Recibe: { seed, db, teammates, reverseTeammate, reverseTeammateIds }
   Emite:  { ok:true, restrictions } | { ok:false, error }
   ═══════════════════════════════════════════════════════════════ */

/* Los Workers no comparten scope con la página: hay que importar los
   mismos archivos compartidos que usa el resto de la web, en orden
   (ranked-engine.js necesita sbStorageUrl, que trae supabase-config.js). */
importScripts('../../js/supabase-config.js', '../../js/ranked-engine.js?v=20260830a');

self.onmessage = function ({ data }) {
  RankedEngine.setTeammateData(data.teammates, data.reverseTeammate, data.reverseTeammateIds);
  try {
    const restrictions = RankedEngine.generate(data.seed, data.db);
    self.postMessage({ ok: true, restrictions });
  } catch (e) {
    self.postMessage({ ok: false, error: e.message });
  }
};
