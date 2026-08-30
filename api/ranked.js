/* =============================================================================
   API/RANKED.JS — Árbitro autoritativo de Coche Clasificatoria (ranked 1v1)
   -----------------------------------------------------------------------------
   PLAN-coche-ranked.md, §5. Función serverless de Vercel (mismo patrón sin
   dependencias que api/titulares.js y api/img.js: module.exports = async
   function handler(req, res), sin framework).

   POR QUÉ EXISTE: Firebase RTDB (donde vive la sala en vivo, temporizadores,
   presencia) NO es de fiar para decidir quién gana ni cuánto ELO se mueve —
   cualquiera con la sala puede escribir ahí. Esta función es la única fuente
   de verdad: genera/valida cada rejilla con el MISMO motor que el cliente
   (js/ranked-engine.js + js/futbol-restrictions.js) contra los chunks reales
   de Supabase Storage, y es quien calcula y persiste ELO/rating/récord en
   Postgres — con la service_role key, saltando RLS por diseño (es el único
   escritor de las tablas ranked_*, ver supabase/setup_ranked.sql).

   Acciones (POST { action, ... }): crear · submit · cerrar · forfeit.

   Requiere SUPABASE_SECRET_KEY en el entorno de Vercel (mismo secreto que ya
   usa api/img.js). Sin ella, la función no puede escribir y responde 500.
   ============================================================================= */
'use strict';

const path = require('path');
const crypto = require('crypto');
const { SUPABASE_URL, SUPABASE_KEY } = require(path.join(__dirname, '..', 'js', 'supabase-config.js'));
const FR = require(path.join(__dirname, '..', 'js', 'futbol-restrictions.js'));
const RankedEngine = require(path.join(__dirname, '..', 'js', 'ranked-engine.js'));

const SECRET = process.env.SUPABASE_SECRET_KEY;

/* ── Constantes tunables (PLAN-coche-ranked.md §9) ── */
const ELO_BASE             = 200;
const ELO_MIN              = 0;
const ELO_K_PROVISIONAL    = 40;
const ELO_K_NORMAL         = 24;
const ELO_K_ESTABLE        = 16;
const PARTIDAS_PROVISIONAL = 10;
const TRAMOS_UMBRALES      = [0, 350, 550, 750, 950, 1150, 1350, 1600];
const RANKED_PUNTOS        = 5;      // puntos totales para ganar la partida
const RANKED_DEADLINE_MS   = 90000;  // inactividad del rival -> forfeit

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* tramoDeElo: DEBE ser identica a ranked_tramo_de_elo() en
   supabase/setup_ranked.sql y a la copia de cliente en js/ranked.js (Fase 1+).
   Es cosmetica pura: no se guarda, se deriva del elo en cada lectura. */
function tramoDeElo(elo) {
  let t = 0;
  for (let i = 0; i < TRAMOS_UMBRALES.length; i++) if (elo >= TRAMOS_UMBRALES[i]) t = i;
  return t;
}

function kFactor(partidas, elo) {
  if (partidas < PARTIDAS_PROVISIONAL) return ELO_K_PROVISIONAL;
  if (elo >= 1350) return ELO_K_ESTABLE;
  return ELO_K_NORMAL;
}

/* ELO clasico de dos jugadores. sa: 1 victoria, 0.5 empate, 0 derrota. */
function eloUpdate(ra, rb, sa, ka, kb) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const eb = 1 - ea;
  const sb = 1 - sa;
  const na = Math.max(ELO_MIN, ra + Math.round(ka * (sa - ea)));
  const nb = Math.max(ELO_MIN, rb + Math.round(kb * (sb - eb)));
  return { na, nb, da: na - ra, db: nb - rb };
}

/* ── Motor compartido: cargado UNA vez por instancia caliente de la función,
   igual que la caché en memoria de FR en el navegador. ── */
let _engineReady = null;
function ensureEngine() {
  if (!_engineReady) {
    _engineReady = FR.init().then(() => {
      RankedEngine.setTeammateData(FR.TEAMMATES_LIST, FR.reverseTeammate, FR.reverseTeammateIds);
    }).catch(e => {
      // Si FR.init() falla (p.ej. un hipo de Storage), no dejar la promesa
      // rota cacheada para siempre: la instancia caliente reintentaria en
      // la SIGUIENTE llamada en vez de devolver 500 hasta que Vercel recicle
      // el contenedor.
      _engineReady = null;
      throw e;
    });
  }
  return _engineReady;
}

/* ── Acceso a Supabase con la service_role key (bypassa RLS: es el unico
   escritor de las tablas ranked_*) ── */
async function sbAdmin(pathAndQuery, opts = {}) {
  if (!SECRET) throw new Error('Falta SUPABASE_SECRET_KEY en el entorno');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} en ${pathAndQuery}: ${texto}`);
  }
  const texto = await res.text();
  return texto ? JSON.parse(texto) : null;
}

/* Verifica el JWT del cliente contra Supabase Auth (equivalente a
   supabaseAdmin.auth.getUser(token), sin depender de @supabase/supabase-js
   — este proyecto no tiene package.json ni esa dependencia). */
async function verifyUser(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

/* Reutiliza rl_allow (supabase/setup_liga_ratelimit.sql). Si el limitador
   falla por lo que sea, no se bloquea la partida por un fallo ajeno. */
async function rlAllow(key, limit, windowSec) {
  try {
    const ok = await sbAdmin('rpc/rl_allow', {
      method: 'POST',
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_sec: windowSec }),
    });
    return ok === true;
  } catch {
    return true;
  }
}

function sendJson(res, code, obj) {
  res.status(code);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function resultadoDe(match) {
  return {
    matchId: match.id,
    estado: match.estado,
    ganadorUid: match.ganador_uid,
    aUid: match.a_uid,
    bUid: match.b_uid,
    aPts: match.a_pts,
    bPts: match.b_pts,
    eloDeltaA: match.elo_delta_a,
    eloDeltaB: match.elo_delta_b,
  };
}

async function getMatch(matchId) {
  const filas = await sbAdmin(`ranked_match?id=eq.${encodeURIComponent(matchId)}&limit=1`);
  return filas && filas[0];
}

async function getOrCreateRating(juego, uid) {
  const filas = await sbAdmin(`ranked_rating?juego=eq.${encodeURIComponent(juego)}&user_id=eq.${uid}&limit=1`);
  if (filas && filas.length) return filas[0];
  const creado = await sbAdmin('ranked_rating', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify([{ juego, user_id: uid, elo: ELO_BASE }]),
  });
  if (creado && creado.length) return creado[0];
  // Perdio la carrera contra otra invocacion concurrente que la creo primero.
  const filas2 = await sbAdmin(`ranked_rating?juego=eq.${encodeURIComponent(juego)}&user_id=eq.${uid}&limit=1`);
  return filas2[0];
}

async function aplicarRatingYRecord(juego, uid, ratingPrevia, nuevoElo, resultado) {
  const partidas  = ratingPrevia.partidas + 1;
  const victorias = ratingPrevia.victorias + (resultado === 1 ? 1 : 0);
  const derrotas  = ratingPrevia.derrotas + (resultado === 0 ? 1 : 0);
  const racha     = resultado === 1 ? Math.max(1, ratingPrevia.racha + 1) : 0;

  await sbAdmin(`ranked_rating?juego=eq.${encodeURIComponent(juego)}&user_id=eq.${uid}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({
      elo: nuevoElo, partidas, victorias, derrotas, racha,
      provisional: partidas < PARTIDAS_PROVISIONAL,
      updated_at: new Date().toISOString(),
    }),
  });

  const tramo = tramoDeElo(nuevoElo);
  const registros = await sbAdmin(`ranked_record?juego=eq.${encodeURIComponent(juego)}&user_id=eq.${uid}&limit=1`);
  const previo = registros && registros[0];
  if (!previo) {
    await sbAdmin('ranked_record', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify([{ juego, user_id: uid, elo_max: nuevoElo, tramo_max: tramo }]),
    });
  } else if (nuevoElo > previo.elo_max || tramo > previo.tramo_max) {
    await sbAdmin(`ranked_record?juego=eq.${encodeURIComponent(juego)}&user_id=eq.${uid}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({
        elo_max: Math.max(previo.elo_max, nuevoElo),
        tramo_max: Math.max(previo.tramo_max, tramo),
      }),
    });
  }
}

/* Cierra la partida de forma idempotente: la ESCRITURA que decide (el PATCH
   condicionado a estado=activa) es atomica en Postgres, asi que si las dos
   partes llaman a "cerrar" (o a "forfeit") a la vez, solo una gana la
   carrera y aplica ELO; la otra simplemente lee el resultado ya guardado. */
async function aplicarResultado(match, aPts, bPts, ganadorUid) {
  const ratingA = await getOrCreateRating(match.juego, match.a_uid);
  const ratingB = await getOrCreateRating(match.juego, match.b_uid);
  const sa = ganadorUid === match.a_uid ? 1 : ganadorUid === match.b_uid ? 0 : 0.5;
  const sb = 1 - sa;
  const kA = kFactor(ratingA.partidas, ratingA.elo);
  const kB = kFactor(ratingB.partidas, ratingB.elo);
  const { na, nb, da, db } = eloUpdate(ratingA.elo, ratingB.elo, sa, kA, kB);

  const claimed = await sbAdmin(
    `ranked_match?id=eq.${encodeURIComponent(match.id)}&estado=eq.activa`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        estado: 'terminada', ganador_uid: ganadorUid,
        a_pts: aPts, b_pts: bPts, elo_delta_a: da, elo_delta_b: db,
      }),
    }
  );
  if (!claimed || !claimed.length) {
    // Otra invocacion cerro la partida primero: su resultado es el bueno.
    const actual = await getMatch(match.id);
    return resultadoDe(actual);
  }

  await aplicarRatingYRecord(match.juego, match.a_uid, ratingA, na, sa);
  await aplicarRatingYRecord(match.juego, match.b_uid, ratingB, nb, sb);

  return resultadoDe(claimed[0]);
}

async function sumaPuntos(matchId, aUid, bUid) {
  const rondas = await sbAdmin(`ranked_match_ronda?match_id=eq.${encodeURIComponent(matchId)}&order=ronda.asc`);
  let aPts = 0, bPts = 0;
  for (const r of rondas || []) {
    if (r.uid === aUid) aPts += r.puntos;
    else if (r.uid === bUid) bPts += r.puntos;
  }
  return { aPts, bPts };
}

/* ═══════════════════ ACCIONES ═══════════════════ */

async function accionCrear(body, res) {
  const { juego, oponente_uid: oponenteUid, jwt } = body;
  const user = await verifyUser(jwt);
  if (!user) return sendJson(res, 401, { error: 'no_autenticado' });
  if (!juego || !oponenteUid) return sendJson(res, 400, { error: 'faltan_datos' });
  // oponenteUid llega tal cual del cuerpo JSON del cliente: sin validar su
  // forma, un uid con caracteres de la sintaxis de filtros de PostgREST
  // (',', ')', '&') podia distorsionar el "or=(...)" de abajo, y el mismo
  // valor se escribe despues tal cual en la columna uuid de la insercion.
  if (!UUID_RE.test(oponenteUid)) return sendJson(res, 400, { error: 'rival_invalido' });
  if (oponenteUid === user.id) return sendJson(res, 400, { error: 'rival_invalido' });

  // Idempotencia: si ya hay una partida activa entre estos dos, se devuelve
  // en vez de crear otra (reintento de red del cliente, doble clic...).
  const filtro = `juego=eq.${encodeURIComponent(juego)}&estado=eq.activa` +
    `&or=(and(a_uid.eq.${encodeURIComponent(user.id)},b_uid.eq.${encodeURIComponent(oponenteUid)}),and(a_uid.eq.${encodeURIComponent(oponenteUid)},b_uid.eq.${encodeURIComponent(user.id)}))` +
    `&order=created_at.desc&limit=1`;
  const existentes = await sbAdmin(`ranked_match?${filtro}`);
  if (existentes && existentes.length) {
    const m = existentes[0];
    return sendJson(res, 200, { matchId: m.id, seedBase: m.seed_base });
  }

  const seedBase = crypto.randomInt(1, 2 ** 31 - 1);
  const deadline = new Date(Date.now() + RANKED_DEADLINE_MS).toISOString();
  const creados = await sbAdmin('ranked_match', {
    method: 'POST',
    body: JSON.stringify([{ juego, a_uid: user.id, b_uid: oponenteUid, seed_base: seedBase, deadline }]),
  });
  const m = creados[0];
  return sendJson(res, 200, { matchId: m.id, seedBase: m.seed_base });
}

async function accionSubmit(body, res) {
  const { matchId, ronda, answerId, jwt } = body;
  const user = await verifyUser(jwt);
  if (!user) return sendJson(res, 401, { error: 'no_autenticado' });
  if (!matchId || !Number.isInteger(ronda) || ronda < 0 || ronda > 500) {
    return sendJson(res, 400, { error: 'datos_invalidos' });
  }

  if (!(await rlAllow(`ranked_submit:${user.id}`, 60, 60))) {
    return sendJson(res, 429, { error: 'rate_limited' });
  }

  const match = await getMatch(matchId);
  if (!match) return sendJson(res, 404, { error: 'partida_no_encontrada' });
  if (match.a_uid !== user.id && match.b_uid !== user.id) {
    return sendJson(res, 403, { error: 'no_participante' });
  }
  if (match.estado !== 'activa') return sendJson(res, 409, { error: 'partida_no_activa' });

  // Idempotencia: reintento de red no vuelve a puntuar la misma ronda.
  const previa = await sbAdmin(
    `ranked_match_ronda?match_id=eq.${encodeURIComponent(matchId)}&ronda=eq.${ronda}&uid=eq.${user.id}&limit=1`
  );
  if (previa && previa.length) {
    return sendJson(res, 200, { puntos: previa[0].puntos, yaRegistrado: true });
  }

  await ensureEngine();
  const restricciones = RankedEngine.generate(match.seed_base + ronda, FR.genPool);

  let puntos = 0;
  let answerIdStr = null;
  if (answerId != null && String(answerId).trim()) {
    answerIdStr = String(answerId).trim();
    const jugador = await FR.resolvePlayerById(answerIdStr);
    if (jugador) {
      // Puntos = nº de restricciones de las 5 que el jugador elegido cumple
      // (0-5), NUNCA lo que mande el cliente: es la validacion autoritativa.
      puntos = restricciones.reduce((n, r) => n + (RankedEngine.validate(jugador, r) ? 1 : 0), 0);
    }
  }

  await sbAdmin('ranked_match_ronda', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify([{ match_id: matchId, ronda, uid: user.id, answer_id: answerIdStr, puntos }]),
  });

  // Renovar el plazo de inactividad: "deadline" se fija al crear la partida
  // y sin esto seguiria fijo ahi, asi que CUALQUIER partida de mas de 90s
  // (la inmensa mayoria, con varias rondas de hasta 45s) se volveria
  // forfeit-eable aunque los dos sigan jugando con normalidad. Cada submit
  // de cualquiera de los dos jugadores empuja el plazo hacia adelante.
  // AWAIT a proposito (mismo patron que guardarEnCache en api/img.js): Vercel
  // no da la invocacion por terminada hasta que ESTA funcion resuelve, asi
  // que sin esperarla el contenedor podia reciclarse con la escritura a
  // medias y el plazo se quedaba sin renovar.
  try {
    await sbAdmin(`ranked_match?id=eq.${encodeURIComponent(matchId)}&estado=eq.activa`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ deadline: new Date(Date.now() + RANKED_DEADLINE_MS).toISOString() }),
    });
  } catch (e) { console.warn('[ranked] no se pudo renovar el plazo:', e); }

  return sendJson(res, 200, { puntos });
}

async function accionCerrar(body, res) {
  const { matchId, jwt } = body;
  const user = await verifyUser(jwt);
  if (!user) return sendJson(res, 401, { error: 'no_autenticado' });
  if (!matchId) return sendJson(res, 400, { error: 'faltan_datos' });

  const match = await getMatch(matchId);
  if (!match) return sendJson(res, 404, { error: 'partida_no_encontrada' });
  if (match.a_uid !== user.id && match.b_uid !== user.id) {
    return sendJson(res, 403, { error: 'no_participante' });
  }
  if (match.estado === 'terminada') return sendJson(res, 200, resultadoDe(match));
  if (match.estado === 'abandonada') return sendJson(res, 409, { error: 'partida_abandonada' });

  const { aPts, bPts } = await sumaPuntos(matchId, match.a_uid, match.b_uid);
  let ganadorUid = null;
  if (aPts > bPts) ganadorUid = match.a_uid;
  else if (bPts > aPts) ganadorUid = match.b_uid;
  // Empate real (aPts === bPts, incluido 0-0 si nadie puntuo nada): sa=sb=0.5.

  const resultado = await aplicarResultado(match, aPts, bPts, ganadorUid);
  return sendJson(res, 200, resultado);
}

async function accionForfeit(body, res) {
  const { matchId, jwt } = body;
  const user = await verifyUser(jwt);
  if (!user) return sendJson(res, 401, { error: 'no_autenticado' });
  if (!matchId) return sendJson(res, 400, { error: 'faltan_datos' });

  const match = await getMatch(matchId);
  if (!match) return sendJson(res, 404, { error: 'partida_no_encontrada' });
  if (match.a_uid !== user.id && match.b_uid !== user.id) {
    return sendJson(res, 403, { error: 'no_participante' });
  }
  if (match.estado === 'terminada') return sendJson(res, 200, resultadoDe(match));
  if (Date.now() < new Date(match.deadline).getTime()) {
    return sendJson(res, 409, { error: 'plazo_no_cumplido' });
  }

  // Quien pide el forfeit gana: el deadline ya paso sin actividad del rival.
  const { aPts, bPts } = await sumaPuntos(matchId, match.a_uid, match.b_uid);
  const resultado = await aplicarResultado(match, aPts, bPts, user.id);
  return sendJson(res, 200, resultado);
}

/* ═══════════════════ ENTRADA ═══════════════════ */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    switch (body.action) {
      case 'crear':   return await accionCrear(body, res);
      case 'submit':  return await accionSubmit(body, res);
      case 'cerrar':  return await accionCerrar(body, res);
      case 'forfeit': return await accionForfeit(body, res);
      default:
        return sendJson(res, 400, { error: 'accion_desconocida' });
    }
  } catch (e) {
    console.error('[ranked]', e);
    return sendJson(res, 500, { error: 'error_interno', detalle: e.message });
  }
};
