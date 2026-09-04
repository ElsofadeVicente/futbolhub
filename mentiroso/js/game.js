/* ═══════════════════════════════════════════════════════════
   GAME.JS — EL MENTIROSO  (rediseño: puja ascendente + vidas)
   ───────────────────────────────────────────────────────────
   Mecánica nueva (sustituye a "cada uno dice un número a ciegas
   y solo puntúa el exacto"):

     · Cada ronda hay UNA apuesta común que solo puede subir.
     · En tu turno: SUBIR, DESAFIAR o llamar MENTIROSO.
     · La ronda acaba en cuanto alguien desafía o llama
       mentiroso; subir solo pasa el turno.
     · DESAFIAR es un duelo con el dueño de la apuesta: tú
       apuestas por (apuesta − 1) y él por la apuesta. Uno de
       los dos acierta siempre; el ganador suma una vida y el
       perdedor la pierde.
     · El resultado mueve VIDAS, no puntos. Gana el último con
       vidas > 0.

   Diferencias de arquitectura respecto a la versión anterior:

     · El turno YA NO se deriva de las apuestas (ya no hay una
       apuesta por jugador): es estado explícito (room.turn) con
       un contador room.turnSeq que sirve de token anti-carrera.
       Todas las acciones se aplican con runTransaction validando
       ese token, así que el reloj de 15 s del jugador y el
       vigilante del anfitrión nunca pueden aplicarse dos veces.

     · Las cartas YA NO se reparten por semilla en cada cliente:
       el anfitrión reparte y publica los IDs (room.dealHands /
       room.dealCenter). Con las reglas nuevas todos los nombres
       son visibles de todas formas, así que publicarlos no
       esconde menos que antes y a cambio elimina el riesgo de
       que dos clientes calculen mesas distintas.

   Depende de MDeck (js/deck.js) para la baraja y las condiciones.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ═══ 1. HELPERS ═══════════════════════════════════════════ */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function escapeHtml(s){
  return String(s??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

/* ── Reloj compartido ─────────────────────────────────────────
   turnAt, studyUntil y resolvedAt son marcas de tiempo ABSOLUTAS que
   escribe un cliente y leen los otros siete. Con `Date.now()` a pelo eso
   da por hecho que los ocho relojes coinciden, y en un movil con la hora
   desajustada no coinciden: el que va adelantado ve TODOS los turnos ya
   vencidos y dispara la accion automatica de los demas nada mas entrar,
   y el que va atrasado no ve vencer ninguno. Firebase publica el desfase
   con su servidor en `.info/serverTimeOffset`; sumandolo, los ocho miden
   contra el MISMO reloj. En practica (sin Firebase) el desfase es 0 y
   todo queda exactamente igual que antes. */
let _clockOffset=0;
function _now(){ return Date.now()+_clockOffset; }
function _watchServerClock(){
  try{
    const FB=window._FB;
    if(!FB||!FB.configured||!FB.onValue)return;
    FB.onValue(FB.ref(FB.db,'.info/serverTimeOffset'),s=>{
      const v=Number(s.val());
      /* Un desfase de mas de un dia es basura, no un reloj mal puesto. */
      if(Number.isFinite(v)&&Math.abs(v)<24*3600*1000)_clockOffset=v;
    });
  }catch(e){}
}

/* ── Cuenta (FutbolHUB): si hay sesión, usar usuario y foto ── */
function _accName(inputId){
  const id=window.FHAuth&&FHAuth.identity&&FHAuth.identity();
  if(id&&id.username)return id.username;
  return (document.getElementById(inputId)?.value||'').trim();
}
function _accAvatar(){
  const id=window.FHAuth&&FHAuth.identity&&FHAuth.identity();
  return (id&&id.avatarUrl)||null;
}
function _avatarInner(p){
  if(window.FHAuth&&FHAuth.avatarInner)return FHAuth.avatarInner(p&&p.name,p&&p.avatar);
  return escapeHtml(((p&&p.name)||'?')[0].toUpperCase());
}
function _setupAccountName(){
  if(!(window.FHAuth&&FHAuth.onIdentity))return;
  const INPUTS=['create-name','join-name','practice-name'];
  FHAuth.onIdentity(id=>{
    INPUTS.forEach(i=>{const el=document.getElementById(i);if(el)el.style.display=id?'none':'';});
    document.querySelectorAll('.account-name-hint').forEach(h=>h.remove());
    if(id)INPUTS.forEach(i=>{
      const el=document.getElementById(i);if(!el)return;
      const hint=document.createElement('p');hint.className='menu-hint account-name-hint';
      hint.style.cssText='margin:0 0 8px;opacity:.7;font-size:.8rem;';
      hint.textContent='Entras como @'+id.username;
      el.parentNode.insertBefore(hint,el);
    });
  });
}

let _toastTimer=null;
function toast(msg,type){const el=$('#toast');if(!el)return;el.textContent=msg;el.className=`toast show ${type||''}`;clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>el.classList.remove('show'),2800);}
/* Se busca la pantalla PRIMERO y solo se apagan las demas si existe. Al reves
   —apagar todas y luego encender— basta con que el id no este para dejar la
   pagina sin ninguna pantalla activa: en blanco y, en la PWA, sin forma de
   salir. El `?.` no salvaba nada: solo hacia que no fallara al esconderlo todo. */
function showScreen(id){
  const destino=$(id);
  if(!destino){console.error('[El Mentiroso] No existe la pantalla '+id);return;}
  destino.classList.add('active');
  $$('.screen').forEach(s=>{if(s!==destino)s.classList.remove('active');});
}
function genCode(n=6){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');}
function genId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36);}

/* ═══ 2. CONSTANTES DE RITMO ═══════════════════════════════ */
const STUDY_MS      = 30000;  // fase de estudio al abrir la ronda: se ve
                              // la mesa pero todavía no se puede pujar
const TURN_MS       = 15000;  // reloj por turno (sección 2 de la spec)
const HOST_GRACE_MS = 4000;   // margen antes de que el anfitrión resuelva por ti
const ANY_GRACE_MS  = 10000;  // margen antes de que lo desatasque cualquiera
const REVEAL_MS     = 12000;  // auto-avance de la pantalla de resolución
/* Lo que tarda un bot en responder. Un bot que contesta en un segundo
   canta que es una máquina, así que el reparto imita a una persona:
   la mayoría de turnos entre 3 y 8 s, más rato cuando la decisión
   cierra la ronda, y de vez en cuando una respuesta rápida. El tope
   se queda por debajo de TURN_MS para que el reloj del turno no llegue
   a cero con el bot todavía pensando. */
const BOT_MIN_MS    = 3000, BOT_MAX_MS = 8000, BOT_CAP_MS = 12000;

/* ═══ 3. REGLAS (reductor puro) ════════════════════════════ */
/* Se usa igual en online (dentro de runTransaction) y en práctica
   (sobre el objeto local), así que las reglas viven en un único
   sitio y no pueden desincronizarse entre los dos modos. */

function _seatsOf(room){ return Array.isArray(room.seats)?room.seats.filter(Boolean):[]; }
function _lives(room,pid){ return Number(room.players?.[pid]?.lives||0); }
function _aliveIds(room){ return Object.keys(room.players||{}).filter(pid=>_lives(room,pid)>0); }
function _isOnline(room,pid){ return room&&room.players&&room.players[pid]&&room.players[pid].connected!==false; }

/* ── Los dos extremos imposibles de la puja ───────────────────
   chooseCondition garantiza que SIEMPRE cumple al menos una carta y
   NUNCA todas, o sea 1 <= real <= n-1. De ahi salen dos jugadas que no
   pueden ganar jamas y que antes estaban ofrecidas como si tal cosa:

     · Subir hasta n. Es afirmar algo imposible: al siguiente le basta
       gritar ¡MENTIROSO! para llevarse la ronda. Por eso el techo real
       de la apuesta es n-1.
     · Cerrar con la apuesta en 1. DESAFIAR exige que cumplan 0 cartas y
       ¡MENTIROSO! exige menos de 1: las dos son perdidas seguras. Hacen
       falta 2 para que cerrar tenga sentido.

   No es una regla escondida: se dice en la ayuda de la barra y en la
   guia, porque saber que siempre cumple alguna y nunca todas es lo que
   permite estimar en vez de adivinar. */
function _techo(room){ return Math.max(1,Number(room&&room.totalCards||0)-1); }
const MIN_CIERRE=2;
/** Vivos Y conectados: los unicos que pueden decidir por si mismos. */
function _activeIds(room){ return _aliveIds(room).filter(pid=>_isOnline(room,pid)); }

/** Siguiente jugador vivo y conectado a partir de pid. */
function _nextSeat(room,pid){
  const s=_seatsOf(room);
  if(!s.length)return null;
  const i=s.indexOf(pid);
  const from=i<0?-1:i;
  for(let k=1;k<=s.length;k++){
    const cand=s[(from+k+s.length)%s.length];
    const p=room.players?.[cand];
    if(p&&p.connected!==false&&Number(p.lives||0)>0)return cand;
  }
  /* Todos los demás desconectados: sigue el orden sin filtrar para
     no dejar la ronda sin turno. */
  return s[(from+1+s.length)%s.length]||null;
}

/** Aplica el resultado de una plantada/desafío. Muta room. */
function _resolve(room,res){
  const before={},after={},eliminated=[];
  /* SIN tope por arriba, y es a proposito. Se probo ponerlo (a las vidas
     de salida) para acortar partidas y salio mal, medido: el premio del
     DUELO es +1 vida, asi que con las vidas llenas no hay +1 que dar y
     DESAFIAR y ¡MENTIROSO! pasan a dar EXACTAMENTE el mismo resultado en
     los tres casos. O sea que los dos botones significaban lo mismo justo
     en la ronda 1, que es donde todos empiezan enteros.
     Y el motivo del tope era falso: el duelo es de saldo cero sobre un
     bote fijo (una ruina del jugador, que termina con probabilidad 1) y
     ademas ¡MENTIROSO! acertado SI saca vidas del bote. */
  Object.keys(res.deltas||{}).forEach(pid=>{
    const p=room.players?.[pid]; if(!p)return;
    const prev=Number(p.lives||0);
    const next=Math.max(0,prev+res.deltas[pid]);
    before[pid]=prev; after[pid]=next;
    p.lives=next;
    if(next===0&&prev>0)eliminated.push(pid);
  });
  res.before=before; res.after=after; res.eliminated=eliminated;
  room.resolution=res;
  room.status='reveal';
  room.turn=null;
  room.turnSeq=Number(room.turnSeq||0)+1;
  room.resolvedAt=_now();

  const alive=_aliveIds(room);
  if(alive.length<=1){
    room.finished=true;
    room.winnerId=alive[0]||null;
    room.winnerName=alive.length?(room.players[alive[0]].name||null):null;
  }
  return true;
}

/**
 * Aplica una acción de turno. Devuelve true si se aplicó.
 * act = {pid, turnSeq, type:'raise'|'duel'|'challenge', value?, actual?, auto?}
 */
function _applyAction(room,act){
  if(!room||room.status!=='playing')return false;
  if(room.turn!==act.pid)return false;
  if(Number(room.turnSeq||0)!==Number(act.turnSeq))return false;
  /* Fase de estudio: la mesa se ve pero todavía no se puja. Se dan 2 s
     de margen porque cada cliente mira su propio reloj y no van finos
     al milisegundo entre sí. */
  if(Number(room.studyUntil||0)-_now()>2000)return false;

  const bet=Number(room.bet||0);

  if(act.type==='raise'){
    const v=Math.floor(Number(act.value));
    if(!Number.isFinite(v)||v<=bet||v>_techo(room))return false;
    room.bet=v;
    room.betOwner=act.pid;
    room.lastAction={pid:act.pid,type:'raise',value:v,auto:!!act.auto};
    /* Historial de la puja. En un juego de farol saber COMO se ha llegado
       a la apuesta que hay (quien subio, cuanto de golpe, quien se limito
       a sumar uno) es la mitad de la informacion; antes solo se veia el
       numero final y habia que acordarse del resto. Se guardan las 12
       ultimas: caben en la tira y no engordan la sala. */
    const hist=Array.isArray(room.history)?room.history.slice(-11):[];
    hist.push({p:act.pid,v:v,a:act.auto?1:0});
    room.history=hist;
    room.passes=0;
    room.turn=_nextSeat(room,act.pid);
    room.turnSeq=Number(room.turnSeq||0)+1;
    room.turnAt=_now();
    return true;
  }

  /* PASAR: no lo pulsa nadie, solo lo genera el reloj, y solo cuando a
     quien le toca se le ha caido la conexion. Antes el reloj le SUBIA la
     apuesta: a quien se le iba la cobertura empujaba el solo la puja
     hasta el techo de la mesa y acababa perdiendo una vida en un duelo
     forzado — castigado por la red, y con la ronda destrozada para los
     demas. Pasar no toca ni la apuesta ni su dueno: solo mueve el turno. */
  if(act.type==='pass'){
    if(!act.auto)return false;
    if(_isOnline(room,act.pid))return false;
    room.passes=Number(room.passes||0)+1;
    room.lastAction={pid:act.pid,type:'pass',auto:true};
    room.turn=_nextSeat(room,act.pid);
    room.turnSeq=Number(room.turnSeq||0)+1;
    room.turnAt=_now();
    return true;
  }

  /* DUELO: retas al dueno de la apuesta. Tu apuestas por bet-1 y el
     por bet, asi que uno de los dos acierta siempre y no hay empate
     posible: si el total real llega a la apuesta gana el, y si se
     queda por debajo ganas tu. El ganador suma una vida y el perdedor
     la pierde. Como ya no existe PLANTARSE, el dueno de la apuesta es
     siempre el jugador anterior en el orden de turno. */
  if(act.type==='duel'){
    if(bet<MIN_CIERRE)return false;
    const owner=room.betOwner;
    if(!owner||!room.players?.[owner])return false;
    const actual=Number(act.actual);
    if(!Number.isFinite(actual))return false;
    const win=(actual<=bet-1);
    /* Se acumula en vez de asignar por si owner y actor fueran el
       mismo (mesa degenerada con un solo jugador vivo): asi las dos
       claves no se pisan y el saldo queda en cero en vez de restar
       una vida de la nada. */
    /* El que GANA el duelo suma una vida y el que lo PIERDE se deja dos.
       No es solo dramatismo: con +1/-1 el duelo era de saldo cero, la mesa
       no perdia vidas y las partidas se eternizaban — medido con bots, 4
       jugadores daban 22 rondas de mediana, p90 39 y colas de 78, con
       alguien acumulando 13 vidas. Con -2 cada duelo saca una vida de la
       mesa: 11 de mediana, p90 15.
       Y mantiene separadas las dos formas de cerrar, que es lo que el tope
       de vidas rompia: la ventaja del DUELO sobre ¡MENTIROSO! es 4p-2 (p =
       lo seguro que estas), o sea que compensa a partir del 50% de
       confianza y con el triple de pendiente. Convencido, duelo;
       sospechando, mentiroso. */
    const deltas={};
    deltas[act.pid]=(deltas[act.pid]||0)+(win?1:-2);
    deltas[owner]=(deltas[owner]||0)+(win?-2:1);
    return _resolve(room,{
      type:act.auto?'timeout':'duel',
      actor:act.pid, target:owner, bet, actual,
      outcome:win?'duel-win':'duel-loss',
      deltas,
    });
  }

  if(act.type==='challenge'){
    if(bet<MIN_CIERRE)return false;
    const owner=room.betOwner;
    if(!owner||!room.players?.[owner])return false;
    const actual=Number(act.actual);
    if(!Number.isFinite(actual))return false;
    let outcome,deltas;
    if(bet>actual){        outcome='challenge-win';   deltas={[owner]:-1}; }
    else if(bet===actual){ outcome='challenge-exact'; deltas={[owner]:+1}; }
    else {                 outcome='challenge-short'; deltas={[act.pid]:-1}; }
    return _resolve(room,{type:'challenge',actor:act.pid,target:owner,bet,actual,outcome,deltas});
  }

  return false;
}

/**
 * Abre una ronda sobre el objeto room. Devuelve true si se aplicó.
 * En la ronda 1 iguala las vidas de todos a startLives: el anfitrión
 * puede cambiar ese ajuste en el lobby después de que alguien haya
 * entrado, y sin esto se jugaba con las vidas del momento de entrar
 * (el lobby prometía 5 y la partida empezaba con 3).
 */
function _applyRoundPayload(room,payload){
  if(!room)return false;
  if(Number(room.round||0)>=payload.round)return false;   // ya la abrió otro
  if(payload.round===1){
    const lives=Number(room.startLives||3);
    Object.values(room.players||{}).forEach(p=>{p.lives=lives;});
  }
  Object.assign(room,payload);
  room.finished=false;room.winnerId=null;room.winnerName=null;
  return true;
}

/** ¿Qué hace el reloj cuando se agotan los 15 s? (spec 4.4) */
function _timeoutAction(room,pid){
  const bet=Number(room.bet||0);
  const total=_techo(room);   // el techo real de la puja, no las cartas
  /* A quien se le ha caido la conexion se le PASA el turno sin tocar la
     apuesta (ver 'pass' en _applyAction). El contador de pasadas es el
     freno: si la mesa entera esta desconectada, pasada una vuelta
     completa se vuelve al comportamiento de siempre y la ronda termina en
     vez de dar vueltas para siempre. */
  const vuelta=Math.max(1,_seatsOf(room).length);
  if(pid&&!_isOnline(room,pid)&&Number(room.passes||0)<vuelta)return {type:'pass',auto:true};
  /* Con las reglas nuevas las dos acciones que cierran la ronda se
     juegan una vida a cara o cruz, y forzar esa apuesta a quien se ha
     quedado sin cobertura seria matarlo por la conexion. Asi que el
     reloj sube la apuesta al minimo y pasa el turno; solo cuando ya no
     se puede subir mas se cierra la ronda con un duelo. */
  if(bet<total)return {type:'raise',value:Math.max(1,bet+1),auto:true};
  return {type:'duel',auto:true};
}

/* ═══ 4. CARTAS DE LA RONDA ════════════════════════════════ */
function _handIds(room,pid){
  const h=(room.dealHands||{})[pid];
  return Array.isArray(h)?h.filter(x=>x!=null):[];
}
function _centerIds(room){
  const c=room.dealCenter;
  return Array.isArray(c)?c.filter(x=>x!=null):[];
}
function _allRoundIds(room){
  const ids=[];
  _seatsOf(room).forEach(pid=>ids.push(..._handIds(room,pid)));
  ids.push(..._centerIds(room));
  return ids;
}
function _condOf(room){
  if(!room.condKey)return null;
  return {
    key:room.condKey,
    arg:room.condArg??null,
    num:(room.condNum===undefined||room.condNum===null)?null:Number(room.condNum),
    label:room.condLabel||'',
  };
}
/** Total real de cartas de la mesa que cumplen la condición. */
function _actualTotal(room){
  const ids=_allRoundIds(room);
  const cards=MDeck.cardsByIds(ids);
  if(cards.length!==ids.length)return null;   // falta alguna carta: no arriesgar
  return MDeck.countMatches(cards,_condOf(room));
}

/* ═══ 5. SYNC (Firebase) ═══════════════════════════════════ */
const Sync=(()=>{
  const PATH='restricciones/rooms';
  const FB=()=>window._FB;
  const _ref=p=>{const{db,ref}=FB();return ref(db,p);};

  /* Presencia: al cerrar la pestaña, marcar connected:false. Sin
     esto un jugador que cierra a mitad de partida congela el turno. */
  function _registerPresence(code,playerId){
    try{
      if(!window._FBOnDisconnect)return;
      const{db,ref}=FB();
      const od=window._FBOnDisconnect(ref(db,`${PATH}/${code}/players/${playerId}/connected`));
      /* cancel() ANTES de armar. Los onDisconnect se ACUMULAN sobre la
         misma ruta en vez de sustituirse (es el fallo que ya se documento
         en Coche y Blackjack), y esta funcion se llama tambien al volver
         a la sala, asi que sin el cancel se van apilando avisos de la
         misma sesion. */
      od.cancel().catch(()=>{}).then(()=>od.set(false).catch(()=>{}));
    }catch(e){}
  }

  /* Cancela el onDisconnect armado por _registerPresence. Sin esto, al salir
     de una sala (o que te expulsen) la pestaña sigue conectada a Firebase y
     el aviso queda pendiente para esa ruta vieja; si luego entras a OTRA sala
     (playerId nuevo, ruta distinta) y esa sí se corta de verdad, Firebase
     dispara el aviso viejo y resucita `players/{playerId}:{connected:false}`
     bajo la sala anterior, aunque ya se hubiera borrado entera. */
  function _cancelPresence(code,playerId){
    try{
      if(!window._FBOnDisconnect)return;
      const{db,ref}=FB();
      window._FBOnDisconnect(ref(db,`${PATH}/${code}/players/${playerId}/connected`)).cancel().catch(()=>{});
    }catch(e){}
  }

  async function createRoom(hostName,mode,startLives,avatar){
    const{set}=FB();
    const code=genCode(),hostId=genId();
    const uid=await window._FBAuthReady;
    await set(_ref(`${PATH}/${code}`),{
      game:'mentiroso',status:'waiting',mode,startLives,
      round:0,seed:0,turnSeq:0,bet:0,betOwner:null,turn:null,studyUntil:0,
      condKey:null,condArg:null,condNum:null,condLabel:null,
      totalCards:0,dealHands:null,dealCenter:null,
      resolution:null,finished:null,winnerId:null,winnerName:null,
      players:{[hostId]:{name:hostName,avatar:avatar||null,lives:startLives,connected:true,isHost:true,uid}},
    });
    _registerPresence(code,hostId);
    return {code,playerId:hostId};
  }

  async function joinRoom(code,playerName,avatar){
    const{get,update}=FB();
    const snap=await get(_ref(`${PATH}/${code}`));
    if(!snap.exists())throw new Error('Sala no encontrada');
    const room=snap.val();
    if(room.game!=='mentiroso')throw new Error('Esa sala es de otro juego');
    if(room.status!=='waiting')throw new Error('La partida ya ha comenzado');
    if(Object.keys(room.players||{}).length>=8)throw new Error('Sala llena');
    const playerId=genId();
    const uid=await window._FBAuthReady;
    await update(_ref(`${PATH}/${code}/players/${playerId}`),{
      name:playerName,avatar:avatar||null,lives:room.startLives||3,connected:true,isHost:false,uid,
    });
    _registerPresence(code,playerId);
    return {code,playerId};
  }

  function listenRoom(code,cb){
    const{onValue}=FB();
    return onValue(_ref(`${PATH}/${code}`),snap=>{if(snap.exists())cb(snap.val());});
  }

  /** Escribe una ronda nueva. Transacción para que dos anfitriones
   *  simultáneos (failover) no repartan dos veces. */
  async function startRound(code,payload){
    const{runTransaction}=FB();
    const res=await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room)return;
      if(!_applyRoundPayload(room,payload))return;
      return room;
    });
    return res&&res.committed;
  }

  /** Aplica una acción de turno con el token turnSeq como guardia. */
  async function act(code,act_){
    const{runTransaction}=FB();
    const res=await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room)return;
      if(!_applyAction(room,act_))return;
      return room;
    });
    return res&&res.committed;
  }

  /** Marca "listo" en la fase de estudio. Cuando lo estan todos los
   *  vivos y conectados, la puja empieza sin esperar los 30 s. */
  async function markReady(code,pid){
    const{runTransaction}=FB();
    await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room||room.status!=='playing')return;
      if(Number(room.studyUntil||0)<=_now())return;
      const ready=Object.assign({},room.ready||{});
      ready[pid]=true;
      room.ready=ready;
      const esperados=Object.keys(room.players||{}).filter(id=>{
        const p=room.players[id];
        return p&&p.connected!==false&&Number(p.lives||0)>0;
      });
      if(esperados.length&&esperados.every(id=>ready[id])){
        room.studyUntil=_now();
        /* turnAt viaja con studyUntil: si no, al saltarse la espera el
           primer turno arrancaba con el reloj ya medio gastado. */
        room.turnAt=_now();
      }
      return room;
    });
  }

  async function setFinished(code){
    const{update}=FB();
    await update(_ref(`${PATH}/${code}`),{status:'finished'});
  }

  async function disconnect(code,playerId){
    _cancelPresence(code,playerId);
    const{get,update,remove:rm}=FB();
    try{
      const snap=await get(_ref(`${PATH}/${code}`));if(!snap.exists())return;
      const room=snap.val();
      if(room.status==='waiting'){
        await rm(_ref(`${PATH}/${code}/players/${playerId}`));
        const rest=Object.keys(room.players||{}).filter(p=>p!==playerId);
        if(!rest.length){rm(_ref(`${PATH}/${code}`)).catch(()=>{});return;}
        if(room.players[playerId]?.isHost)await update(_ref(`${PATH}/${code}/players/${rest[0]}`),{isHost:true});
      }else{
        /* Irse a mitad de partida es RENDIRSE, no solo desconectarse. Sin
           poner las vidas a 0 el asiento se quedaba en la mesa con sus
           vidas intactas: en una partida de dos el que se quedaba no
           podia ganar nunca, porque el final se calcula sobre quien tiene
           vidas, no sobre quien sigue conectado. Perder la cobertura NO
           pasa por aqui (eso lo marca onDisconnect y solo pone
           connected:false): esto solo lo dispara el boton de abandonar. */
        const enJuego=room.status==='playing'||room.status==='reveal';
        await update(_ref(`${PATH}/${code}/players/${playerId}`),
          enJuego?{connected:false,left:true,lives:0}:{connected:false});
        if(enJuego)finishIfOver(code).catch(()=>{});
      }
    }catch(e){console.warn('disconnect',e);}
  }

  async function updateSettings(code,o){const{update}=FB();await update(_ref(`${PATH}/${code}`),o);}
  async function kick(code,pid){const{remove:rm}=FB();await rm(_ref(`${PATH}/${code}/players/${pid}`));}

  /**
   * Vuelve a una sala en la que ya estabas: recargar la pagina, volver de
   * segundo plano, abrir otra vez el enlace de invitacion.
   *
   * Es una TRANSACCION sobre la sala entera, no el `update` ciego de
   * antes. `update()` sobre una ruta que NO existe la CREA, asi que el
   * markConnected anterior tenia dos formas de estropear las cosas, las
   * dos silenciosas:
   *   · si tu registro ya no estaba (habias salido del lobby y eso lo
   *     BORRA), lo resucitaba como {connected:true} — un jugador sin
   *     nombre, sin vidas y sin anfitrion, que ademas dejaba la sala sin
   *     nadie que pudiera empezar;
   *   · si la sala entera ya no estaba (te fuiste el ultimo), la volvia a
   *     crear a medias, sin `status`. Con eso el router de render no casa
   *     con ningun estado, no enciende ninguna pantalla y la pagina se
   *     queda EN BLANCO.
   * @returns {{ok:boolean, reason?:string}}
   */
  async function rejoin(code,playerId,name,avatar,opts){
    const{onValue,runTransaction}=FB();
    const uid=await window._FBAuthReady;

    /* Un LISTENER temporal, no un get(). runTransaction corre su primera
       pasada sobre la copia LOCAL de la sala y, si este cliente no la
       estaba escuchando, esa copia es `null`: la transaccion devuelve
       undefined, aborta ahi mismo y NUNCA llega a preguntarle al
       servidor — o sea que volver a una sala que existe perfectamente
       contestaba "esa sala ya no existe". `get()` tampoco sirve: trae el
       dato pero no lo deja en la copia que mira la transaccion. Se
       mantiene abierto hasta despues de la transaccion y luego se cierra;
       el listener de verdad lo abre despues quien llama. */
    let cerrar=null,inicial;
    try{
      inicial=await new Promise((ok,ko)=>{
        const reloj=setTimeout(()=>ko(new Error('timeout')),8000);
        cerrar=onValue(_ref(`${PATH}/${code}`),
          snap=>{clearTimeout(reloj);ok(snap.exists()?snap.val():null);},
          err=>{clearTimeout(reloj);ko(err);});
      });
    }catch(e){
      if(cerrar)try{cerrar();}catch(_){}
      return {ok:false,reason:'No se pudo comprobar la sala'};
    }
    const cerrarYa=()=>{ if(cerrar)try{cerrar();}catch(_){} cerrar=null; };
    if(!inicial){cerrarYa();return {ok:false,reason:'Esa sala ya no existe'};}
    if(inicial.game!=='mentiroso'){cerrarYa();return {ok:false,reason:'Esa sala es de otro juego'};}

    let motivo='';
    const res=await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room){motivo='Esa sala ya no existe';return;}
      if(room.game!=='mentiroso'){motivo='Esa sala es de otro juego';return;}
      const players=room.players||{};
      const mio=players[playerId];
      if(mio){
        /* `soloSiLibre` es para cuando el playerId sale de localStorage y
           no de la pestana actual: dos personas jugando en el mismo
           navegador comparten localStorage, asi que sin esta guarda la
           segunda se sentaria en el sitio de la primera. Si el asiento
           esta ocupado y vivo, mejor entrar como jugador nuevo. Con la
           partida ya empezada no aplica: ahi volver es la unica opcion. */
        if(opts&&opts.soloSiLibre&&room.status==='waiting'&&mio.connected!==false){
          motivo='__ocupado__';return;
        }
        mio.connected=true;
        mio.left=null;
        if(name)mio.name=name;
        if(avatar||mio.avatar)mio.avatar=avatar||mio.avatar;
        if(uid)mio.uid=uid;
        room.players=players;
        return room;
      }
      /* Tu registro ya no esta. En el lobby se puede volver a entrar; con
         la partida empezada, no: entrar a mitad pediria repartir cartas
         nuevas y eso cambiaria el total de la mesa para todos los demas a
         media puja. */
      if(room.status!=='waiting'){motivo='La partida siguio sin ti';return;}
      if(Object.keys(players).length>=8){motivo='La sala esta llena';return;}
      if(!name){motivo='Hace falta tu nombre para volver a entrar';return;}
      players[playerId]={name,avatar:avatar||null,lives:Number(room.startLives||3),
                         connected:true,isHost:false,uid:uid||null};
      room.players=players;
      return room;
    });
    cerrarYa();
    if(res&&res.committed){_registerPresence(code,playerId);return {ok:true};}
    return {ok:false,reason:motivo||'No se pudo volver a la sala'};
  }

  /**
   * Cierra la partida si ya no queda con quien jugarla. Hace falta porque
   * el final se decidia SOLO dentro de _resolve, y hay una forma de
   * quedarse solo que no pasa por ahi: que los demas abandonen. En una
   * mesa de dos, el que se quedaba no podia ganar nunca — la ronda seguia
   * dando vueltas y el reloj jugaba los turnos del fantasma.
   */
  async function finishIfOver(code){
    const{runTransaction}=FB();
    await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room)return;
      if(room.status!=='playing'&&room.status!=='reveal')return;
      const vivos=Object.keys(room.players||{}).filter(pid=>Number(room.players[pid].lives||0)>0);
      if(vivos.length>1)return;
      room.status='finished';
      room.finished=true;
      room.winnerId=vivos[0]||null;
      room.winnerName=vivos.length?(room.players[vivos[0]].name||null):null;
      room.turn=null;
      room.turnSeq=Number(room.turnSeq||0)+1;
      return room;
    });
  }

  /**
   * Se acabo la partida por incomparecencia: queda UN solo jugador
   * conectado y los demas llevan un buen rato sin dar senales. Sin esto,
   * una mesa de dos en la que al rival se le muere el movil se quedaba
   * abriendo rondas para siempre — el que se quedaba no podia ni ganar ni
   * perder, porque el final se calcula sobre quien tiene vidas y el
   * ausente las conservaba todas.
   */
  async function walkover(code){
    const{runTransaction}=FB();
    await runTransaction(_ref(`${PATH}/${code}`),room=>{
      if(!room)return;
      if(room.status!=='playing'&&room.status!=='reveal')return;
      const ps=room.players||{};
      const enPie=Object.keys(ps).filter(pid=>Number(ps[pid].lives||0)>0);
      const online=enPie.filter(pid=>ps[pid].connected!==false);
      if(online.length!==1||enPie.length<2)return;
      enPie.forEach(pid=>{ if(ps[pid].connected===false)ps[pid].lives=0; });
      room.players=ps;
      room.status='finished';room.finished=true;
      room.winnerId=online[0];room.winnerName=ps[online[0]].name||null;
      room.turn=null;room.turnSeq=Number(room.turnSeq||0)+1;
      return room;
    });
  }

  return {createRoom,joinRoom,listenRoom,startRound,act,setFinished,disconnect,updateSettings,kick,rejoin,finishIfOver,walkover,markReady};
})();

/* ═══ 6. ESTADO APP ════════════════════════════════════════ */
let _roomCode=null,_playerId=null,_isHost=false,_unsub=null,_lastRoom=null;
let _livesDraft=3,_modeDraft='easy',_botsDraft=2,_raiseDraft=1;
let _local=false,_localRoom=null,_botTimer=null;
let _dealKey='',_autoKey='',_continueKey='',_raiseKey='',_studyOn=null,_histKey='';
let _deckReady=false,_deckError=null;
let _avisoTurno='',_finKey='';
/* Desde cuando veo desconectado a cada jugador. Es contabilidad LOCAL del
   anfitrion (Firebase no guarda el instante de la caida) y solo se usa
   para barrer del lobby a quien lleva ahi de adorno un buen rato. */
const _offDesde=Object.create(null);

function _saveSession(){try{if(!_local)sessionStorage.setItem('mentiroso_s',JSON.stringify({code:_roomCode,pid:_playerId}));}catch{}}
function _clearSession(){try{sessionStorage.removeItem('mentiroso_s');}catch{}}
function _reset(){
  _roomCode=null;_playerId=null;_isHost=false;_lastRoom=null;
  _local=false;_localRoom=null;_dealKey='';_autoKey='';_continueKey='';_raiseKey='';_studyOn=null;_raiseDraft=1;
  _histKey='';_avisoTurno='';_finKey='';_esperandoDesde=0;_ultimoSeq=-1;_pararParpadeo();
  Object.keys(_offDesde).forEach(k=>{delete _offDesde[k];});
  clearTimeout(_botTimer);_botTimer=null;
  if(_unsub){_unsub();_unsub=null;}
  $('#overlay-reveal')?.classList.add('hidden');
  $('#overlay-gameover')?.classList.add('hidden');
  _clearSession();
}

/* ═══ 7. ROUTER DE RENDER ══════════════════════════════════ */
/* Firebase puede entregar una foto VIEJA despues de una nueva, y no es un
   caso raro: cuando una transaccion se aplica en local de forma optimista
   y luego el servidor la rechaza (porque otro cliente hizo antes lo
   mismo), el SDK emite un evento de revocacion con el valor ANTERIOR.
   Visto de verdad al probar el abandono: el panel de ganador se abria y
   acto seguido se cerraba solo, dejando la partida terminada con cara de
   seguir en juego. `round` y `turnSeq` solo crecen, asi que sirven de
   numero de version: una foto con un numero menor del ya pintado se tira.
   El estado 'finished' se deja pasar siempre — es terminal y no puede ser
   una foto vieja. */
const _RANGO={waiting:0,playing:1,reveal:2,finished:3};
let _ultimoSeq=-1;
function _esFotoVieja(room){
  /* El estado entra en el numero de version, y no solo la ronda y el
     turno: al terminar por abandono, la revocacion que llega despues
     traia el MISMO turnSeq que la foto anterior, asi que no se veia como
     vieja y volvia a esconder el panel de ganador. */
  const seq=Number(room.round||0)*1000000+Number(room.turnSeq||0)*10+(_RANGO[room.status]||0);
  if(seq<_ultimoSeq)return true;
  _ultimoSeq=seq;
  return false;
}

/* Escribir en Firebase desde dentro del render VUELVE A ENTRAR aqui, y de
   forma sincrona: el SDK aplica la escritura en la copia local de forma
   optimista y dispara el listener antes de devolver el control. Asi que la
   llamada de dentro pinta el estado nuevo y, al desenrollarse la pila, la
   de fuera sigue por donde iba y lo tapa con el viejo.
   Medido: al abandonar un jugador, el panel de ganador se abria y se
   cerraba solo 18 ms despues — la foto de "partida terminada" la pintaba
   la llamada de dentro y la de fuera volvia a esconderla al llegar a su
   `case 'playing'`. Este contador es el numero de generacion: si mientras
   preparabamos el render ha entrado otra foto, esta ya no manda. */
let _gen=0;
function _onRoomUpdate(room){
  if(!room||!room.players)return;
  if(!_local&&_lastRoom&&_esFotoVieja(room))return;
  const gen=++_gen;
  _lastRoom=room;
  if(!_local&&!room.players[_playerId]){
    /* Tu registro ha desaparecido de la sala: o te ha quitado el
       anfitrion, o llevabas tanto rato desconectado que se te barrio del
       lobby. En el segundo caso se puede volver a entrar, asi que en vez
       de dejarte en el menu sin explicacion se deja el codigo puesto y la
       pestana de UNIRSE abierta. */
    const code=_roomCode,podiaVolver=room.status==='waiting';
    toast(podiaVolver?'Ya no estas en la sala. Puedes volver a entrar.':'Ya no estas en la sala','info');
    _reset();showScreen('#screen-menu');
    if(podiaVolver&&code)_prepararReentrada(code);
    return;
  }
  _isHost=_local?true:(room.players[_playerId]?.isHost===true);

  /* Failover de anfitrión: si el anfitrión cerró la pestaña y la
     partida sigue, el primer conectado (orden determinista por id)
     se autopromociona para que el juego no se congele. */
  /* El failover corre TAMBIEN en el lobby. Antes solo con la partida ya
     empezada, y eso dejaba una sala muerta cada vez que al anfitrion se le
     iba la conexion esperando: nadie mas podia pulsar EMPEZAR y los demas
     se quedaban mirando una lista que no iba a arrancar nunca. */
  if(!_local&&_roomCode&&room.status!=='finished'){
    const connected=Object.entries(room.players).filter(([,p])=>p&&p.connected!==false);
    const hasHost=connected.some(([,p])=>p.isHost===true);
    if(!hasHost&&connected.length){
      const candidate=connected.map(([pid])=>pid).sort()[0];
      if(candidate===_playerId){
        try{
          const{db,ref,update}=window._FB;
          update(ref(db,`restricciones/rooms/${_roomCode}/players/${_playerId}`),{isHost:true}).catch(()=>{});
          const oldHost=Object.entries(room.players).find(([,p])=>p&&p.isHost===true&&p.connected===false);
          if(oldHost)update(ref(db,`restricciones/rooms/${_roomCode}/players/${oldHost[0]}`),{isHost:false}).catch(()=>{});
          _isHost=true;
        }catch(e){}
      }
    }
  }

  /* Si alguien abandona fuera de una resolucion (el boton de abandonar
     pone sus vidas a 0), el final no lo detecta nadie: _resolve es el
     unico que lo mira y solo corre al cerrar una ronda. */
  if(!_local&&_isHost&&(room.status==='playing'||room.status==='reveal')){
    const vivos=_aliveIds(room);
    const k=String(room.round)+':'+vivos.length;
    /* Fuera del render (setTimeout) ademas de la guarda de generacion: una
       transaccion es justo lo que puede volver a entrar aqui. */
    if(vivos.length<=1&&_finKey!==k){
      _finKey=k;
      const code=_roomCode;
      setTimeout(()=>{if(code===_roomCode)Sync.finishIfOver(code).catch(()=>{});},0);
    }
  }
  _avisarTurno(room);

  /* Ha entrado una foto mas nueva mientras tanto (ver la nota de _gen):
     esa ya ha pintado lo que toca, y seguir aqui seria pisarlo. */
  if(gen!==_gen)return;

  switch(room.status){
    case'waiting':
      $('#overlay-reveal').classList.add('hidden');
      $('#overlay-gameover').classList.add('hidden');
      _renderLobby(room);
      break;
    case'playing':
      $('#overlay-reveal').classList.add('hidden');
      $('#overlay-gameover').classList.add('hidden');
      _renderGame(room);
      break;
    case'reveal':
      $('#overlay-gameover').classList.add('hidden');
      _renderGame(room);
      _renderReveal(room);
      break;
    case'finished':
      _renderGame(room);
      $('#overlay-reveal').classList.add('hidden');
      _renderFinished(room);
      break;
  }
}

/* ═══ 8. LOBBY ═════════════════════════════════════════════ */
function _renderLobby(room){
  showScreen('#screen-lobby');
  $('#lobby-code').textContent=_roomCode||'——————';
  /* El enlace completo debajo del codigo, como en las otras cinco salas: aqui
     el boton copiaba el enlace desde hace tiempo, pero no se ensenaba en
     ningun sitio y el rotulo decia "COPIAR CODIGO". */
  const _linkEl=$('#lobby-link-display');
  if(_linkEl)_linkEl.textContent=_roomCode?_enlaceSala():'';
  $('#lobby-mode-pill').textContent=room.mode==='easy'?'FACIL':'DIFICIL';

  const players=Object.entries(room.players||{});
  /* Se cuentan y se ensenan los CONECTADOS. Antes contaba todo el mundo,
     asi que un fantasma (alguien que cerro el movil y quedo en
     connected:false) valia como segundo jugador y dejaba empezar una
     partida de uno. */
  const online=players.filter(([,p])=>p&&p.connected!==false);
  const fantasmas=players.length-online.length;
  $('#lobby-count').textContent=`(${online.length})`;
  _barrerFantasmas(room,players);
  const list=$('#lobby-players');list.innerHTML='';
  players.forEach(([pid,p])=>{
    const d=document.createElement('div');
    d.className='lobby-player-row'+(p.connected===false?' is-off':'');
    /* ANFITRION y "← TU" con las mismas etiquetas que las otras cinco salas
       (css/sala.css). Antes ponia "HOST" y metia un "(tu)" dentro del propio
       nombre, que ademas se colaba en el texto del jugador. */
    d.innerHTML=`<span class="lobby-player-avatar">${_avatarInner(p)}</span>`+
      `<span class="lobby-player-name">${escapeHtml(p.name)}</span>`+
      `<span class="lobby-player-lives">${_hearts(p.lives??room.startLives??3)}</span>`+
      (p.connected===false?'<span class="lobby-player-off">SIN CONEXIÓN</span>':'')+
      (p.isHost?'<span class="lobby-player-host">ANFITRIÓN</span>':'')+
      (pid===_playerId?'<span class="lobby-player-you">← TÚ</span>':'');
    list.appendChild(d);
  });

  const toggle=$('#lobby-lives-toggle'),ro=$('#lobby-lives-readonly');
  if(_isHost){
    toggle.classList.remove('hidden');ro.classList.add('hidden');
    $$('#lobby-lives-toggle .lives-opt').forEach(b=>b.classList.toggle('active',Number(b.dataset.lives)===Number(room.startLives)));
  }else{
    toggle.classList.add('hidden');ro.classList.remove('hidden');
    $('#lobby-lives-value-readonly').textContent=room.startLives||3;
  }

  $('#btn-start').disabled=!_isHost||online.length<2||!_deckReady;
  const hint=$('#lobby-hint');
  if(!_deckReady)hint.textContent=_deckError?'No se pudo cargar la base de jugadores.':'Cargando plantillas…';
  else if(online.length<2)hint.textContent='Se necesitan al menos 2 jugadores conectados.';
  else if(fantasmas)hint.textContent=fantasmas+(fantasmas>1?' jugadores sin conexion: no cuentan':' jugador sin conexion: no cuenta')+' para empezar.';
  else if(_isHost)hint.textContent=`Cada jugador empieza con ${room.startLives} vidas. Gana el ultimo en pie.`;
  else hint.textContent='Esperando a que el anfitrion empiece.';
}

/* Barre del lobby a quien lleva mas de dos minutos sin conexion. Solo lo
   hace el anfitrion y solo en el lobby: en partida un asiento no se puede
   quitar sin cambiar el total de cartas de la mesa a media puja. Quien
   vuelve lo hace por Sync.rejoin, que en el lobby te readmite. */
const PURGA_MS=120000;
function _barrerFantasmas(room,players){
  if(_local||!_isHost||!_roomCode||room.status!=='waiting')return;
  const ahora=Date.now();
  players.forEach(([pid,p])=>{
    if(!p||p.connected!==false){delete _offDesde[pid];return;}
    if(!_offDesde[pid]){_offDesde[pid]=ahora;return;}
    if(pid===_playerId)return;
    if(ahora-_offDesde[pid]<PURGA_MS)return;
    delete _offDesde[pid];
    Sync.kick(_roomCode,pid).catch(()=>{});
  });
}

/** Deja el menu listo para volver a entrar a una sala concreta. */
function _prepararReentrada(code){
  const inp=$('#join-code');if(inp)inp.value=code;
  const err=$('#join-error');if(err)err.classList.add('hidden');
  $$('.menu-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab==='join'));
  $$('.menu-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel==='join'));
}

/* ═══ 9. PARTIDA ═══════════════════════════════════════════ */
function _hearts(n){
  n=Math.max(0,Number(n)||0);
  if(n===0)return '<span class="hp dead">✕</span>';
  if(n>7)return `<span class="hp">♥</span><span class="hp-x">×${n}</span>`;
  return Array.from({length:n},()=>'<span class="hp">♥</span>').join('');
}

/** Tarjeta de jugador: foto y nombre completo.
 *  La carta NO lleva escudo del club: lo unico que hay que leer para
 *  contar es el nombre, y la chapa de la esquina superior derecha le
 *  competia por el sitio. El club sigue en el titulo emergente. */
function renderCard(card,opts){
  opts=opts||{};
  const el=document.createElement('div');
  el.className='tcard';
  if(!card){
    el.classList.add('tcard-missing');
    el.innerHTML='<div class="tcard-photo"><div class="tcard-fallback">?</div></div><div class="tcard-name">—</div>';
    return el;
  }
  const matches=opts.cond?MDeck.matches(card,opts.cond):false;
  if(opts.reveal)el.classList.add(matches?'r-match':'r-no');
  else if(opts.showMatch&&matches)el.classList.add('is-match');

  const mark=opts.reveal
    ? `<div class="tcard-mark ${matches?'ok':'ko'}">${matches?'✓':'✕'}</div>`
    : (opts.showMatch&&matches?'<div class="tcard-mark ok">✓</div>':'');

  const ini=(card.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  el.title=`${card.name} · ${card.club||''}`;
  /* La marca de ✓/✗ cuelga de la carta, no de la foto: en la pantalla
     de resolucion las cartas van en chapa sin foto y la marca tiene
     que seguir viendose. */
  el.innerHTML=`
    <div class="tcard-photo">
      <img src="${escapeHtml(fhImgUrl(card.img))}" loading="lazy" alt="" onerror="this.closest('.tcard-photo').classList.add('no-photo')">
      <div class="tcard-fallback">${escapeHtml(ini)}</div>
    </div>
    ${mark}
    <div class="tcard-name">${escapeHtml(card.name)}</div>`;
  return el;
}

function _fillRow(el,ids,opts){
  el.innerHTML='';
  if(!ids.length){el.innerHTML='<div class="empty-inline">Sin cartas</div>';return;}
  ids.forEach(id=>el.appendChild(renderCard(MDeck.card(id),opts)));
}

/** Reconstruye la mesa. Solo cuando cambia el reparto/condición,
 *  para que las fotos no parpadeen en cada acción. */
/**
 * Reparte a los rivales alrededor del tapete. Devuelve una zona
 * ('left'|'top'|'right') por rival, en orden de turno: se sube por el
 * lateral izquierdo, se cruza por arriba y se baja por el derecho, que
 * es el sentido en el que van los turnos partiendo de mí (abajo).
 * Se limita el techo de la fila de arriba a 3 asientos para que no se
 * quede una hilera larguísima y las columnas vacías.
 */
/* Por debajo de 760 px la mesa se apila y ya no hay laterales: todos
   los rivales van a una rejilla de dos columnas encima del tapete. */
function _isNarrow(){ return window.matchMedia('(max-width: 759px)').matches; }

function _seatZones(n){
  if(_isNarrow())return Array.from({length:n},()=>'top');
  const REPARTO={
    0:[],
    1:['top'],
    2:['top','top'],
    3:['left','top','right'],
    4:['left','top','top','right'],
    5:['left','top','top','top','right'],
    6:['left','left','top','top','right','right'],
    7:['left','left','top','top','top','right','right'],
  };
  if(REPARTO[n])return REPARTO[n];
  /* Por encima de 7 rivales (la sala son 8 jugadores como mucho) se
     reparte alternando para no dejar ninguna zona desbordada. */
  const z=[];
  for(let i=0;i<n;i++)z.push(['left','top','right'][i%3]);
  return z;
}

/** Un asiento de la mesa: cabecera (avatar, nombre, vidas, estado) + su mano. */
function _buildSeat(room,pid,opts){
  const p=room.players[pid];
  const box=document.createElement('div');
  box.className='seat'+(opts.isMe?' seat--me':'');
  box.dataset.pid=pid;
  box.innerHTML=`
    <div class="seat-head">
      <span class="seat-av">${_avatarInner(p)}</span>
      <span class="seat-name">${escapeHtml(p.name)}${opts.isMe?' (tu)':''}</span>
      <span class="seat-lives"></span>
      ${(!opts.isMe&&_isHost&&!_local)?'<button class="seat-kick" title="Quitar">×</button>':''}
    </div>
    <div class="seat-tag"></div>
    <div class="hand-row seat-cards"></div>`;
  const k=box.querySelector('.seat-kick');
  if(k)k.addEventListener('click',e=>{e.stopPropagation();_kick(pid,p.name);});
  _fillRow(box.querySelector('.seat-cards'),_handIds(room,pid),{cond:opts.cond,showMatch:opts.showMatch});
  return box;
}

function _renderTable(room){
  const cond=_condOf(room);
  const key=[room.round,room.condKey,room.condArg,room.condNum,room.mode,_seatsOf(room).join(','),
             Object.keys(room.players||{}).join(',')].join('|');
  if(key===_dealKey)return;
  _dealKey=key;

  const easy=room.mode==='easy';

  /* Cartas comunes: en el centro del tapete y nunca marcadas (spec 5). */
  _fillRow($('#center-cards'),_centerIds(room),{cond,showMatch:false});
  $('#center-count').textContent=_centerIds(room).length?`(${_centerIds(room).length})`:'';

  const zones={left:$('#zone-left'),top:$('#zone-top'),right:$('#zone-right'),bottom:$('#zone-bottom')};
  Object.values(zones).forEach(z=>{z.innerHTML='';});

  /* Mi asiento, siempre abajo. En Fácil mis cartas van marcadas en
     verde; en Difícil no se marca ninguna, ni las propias. */
  const me=room.players[_playerId];
  if(me){
    const mySeat=_buildSeat(room,_playerId,{isMe:true,cond,showMatch:easy});
    const hint=document.createElement('div');
    hint.className='seat-hint';
    const iPlay=_seatsOf(room).indexOf(_playerId)>=0;
    if(!iPlay)hint.textContent='Estas eliminado: ves la partida pero no repartes ni juegas.';
    else if(easy)hint.textContent='Modo facil: en verde, las tuyas que cumplen la condicion.';
    else hint.textContent='Modo dificil: nadie ve que cartas cumplen. Tu criterio manda.';
    mySeat.appendChild(hint);
    zones.bottom.appendChild(mySeat);
  }

  /* Rivales, en orden de turno, repartidos por los tres lados libres. */
  const seats=_seatsOf(room);
  const others=Object.keys(room.players||{})
    .filter(pid=>pid!==_playerId)
    .sort((a,b)=>{
      const ia=seats.indexOf(a),ib=seats.indexOf(b);
      return (ia<0?99:ia)-(ib<0?99:ib);
    });
  const zonaDe=_seatZones(others.length);
  others.forEach((pid,i)=>{
    if(!room.players[pid])return;
    zones[zonaDe[i]||'top'].appendChild(_buildSeat(room,pid,{isMe:false,cond,showMatch:false}));
  });

  /* Con pocos rivales las columnas laterales sobran: se ocultan para
     que el tapete ocupe todo el ancho. */
  ['left','right'].forEach(z=>zones[z].classList.toggle('empty',!zones[z].children.length));
  /* data-n manda en la rejilla de rivales del movil: con uno o dos no
     tiene sentido partir la fila en dos columnas. */
  zones.top.dataset.n=String(zones.top.children.length);
}

/* ── Encaje en una pantalla ──────────────────────────────────
   La mesa NO se desplaza: tiene que caber entera. Como el alto
   depende de cuanta gente juegue (2 a 8) y del movil de cada uno,
   se prueban tres niveles de compresion y se deja el primero que
   entre. El ultimo escalon deja las cartas de los rivales en solo
   nombre, que es lo unico imprescindible para contar. */
const _DENSITY=['d1','d2','d3','d4'];
function _fitTable(){
  const scr=$('#screen-game');
  if(!scr||!scr.classList.contains('active'))return;
  const box=$('#game-scroll');
  if(!box)return;
  scr.classList.remove(..._DENSITY);
  /* Los escalones se ACUMULAN (d1, luego d1+d2...): asi cada nivel solo
     tiene que describir lo que recorta de nuevo y no puede pasar que un
     nivel mas apretado se deje suelto algo que ya recortaba el anterior. */
  for(const level of _DENSITY){
    if(box.scrollHeight<=box.clientHeight+1)return;
    scr.classList.add(level);
  }
}

/* Al girar el movil o cambiar el tamano de la ventana cambia el
   reparto de asientos (laterales / rejilla), asi que hay que repintar
   la mesa entera, no solo recalcular la compresion. */
let _resizeTimer=null;
window.addEventListener('resize',()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer=setTimeout(()=>{
    const room=_local?_localRoom:_lastRoom;
    if(!room||!$('#screen-game').classList.contains('active'))return;
    _dealKey='';
    _renderGame(room);
  },180);
});

/** Refresca todo lo que cambia turno a turno (barato). */
function _renderState(room){
  const cond=_condOf(room);
  $('#game-round').textContent=String(room.round||1);
  $('#game-mode').textContent=room.mode==='easy'?'FACIL':'DIFICIL';
  $('#game-code').textContent=_local?'PRACTICA':(_roomCode||'——————');
  $('#cond-label').textContent=cond?cond.label:'—';
  $('#cond-total').textContent=Number(room.totalCards||0);

  /* Icono de la condición: escudo, logo de liga, bandera o emoji */
  const iconEl=$('#cond-icon');
  const icon=cond?MDeck.condIcon(cond):null;
  const iconKey=icon?icon.type+':'+icon.value:'';
  if(iconEl.dataset.key!==iconKey){
    iconEl.dataset.key=iconKey;
    if(!icon)iconEl.innerHTML='<span class="cond-emoji">🎭</span>';
    else if(icon.type==='img')iconEl.innerHTML=`<img src="${escapeHtml(icon.value)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cond-emoji',textContent:'🎭'}))">`;
    else iconEl.innerHTML=`<span class="cond-emoji">${escapeHtml(icon.value)}</span>`;
  }

  const bet=Number(room.bet||0);
  const turnId=room.turn;

  /* Vidas y estado de cada asiento de la mesa (el mío incluido). */
  $$('#table-area .seat').forEach(box=>{
    const pid=box.dataset.pid,p=room.players?.[pid];
    if(!p)return;
    const lives=Number(p.lives||0);
    const isTurn=room.status==='playing'&&turnId===pid;
    box.classList.toggle('out',lives<=0);
    box.classList.toggle('off',p.connected===false);
    box.classList.toggle('turn',isTurn);
    box.querySelector('.seat-lives').innerHTML=_hearts(lives);
    const tag=box.querySelector('.seat-tag');
    if(lives<=0)tag.textContent=p.left?'ABANDONO':'ELIMINADO';
    else if(room.betOwner===pid&&bet>0)tag.textContent=`SUBIO A ${bet}`;
    /* "PENSANDO" no vale para quien no esta: la mesa parecia esperar a
       alguien que ya no puede contestar. Su turno se pasa solo. */
    else if(isTurn&&p.connected===false)tag.textContent='SIN CONEXION · SE PASA';
    else if(isTurn)tag.textContent=pid===_playerId?'TE TOCA':'PENSANDO…';
    else if(p.connected===false)tag.textContent='SIN CONEXION';
    else tag.textContent='';
  });

  _renderHistory(room);
  _renderActions(room);
  _renderClock(room);   // el último: manda sobre lo que haya pintado _renderActions
}

/** Nombre corto para la tira de la puja: la primera palabra si con ella
 *  basta para distinguirlo, y el nombre entero si no. Cortar siempre por
 *  la primera palabra dejaba "Bot" y "Bot" para dos bots distintos, y lo
 *  mismo con dos jugadores que se llamen igual de nombre. */
function _nombreCorto(room,pid){
  const nom=String(room.players?.[pid]?.name||'—');
  const corto=nom.split(' ')[0];
  const choca=Object.keys(room.players||{}).some(otro=>
    otro!==pid&&String(room.players[otro]?.name||'').split(' ')[0]===corto);
  return choca?nom:corto;
}

/* Tira con la escalada de la puja. Se repinta solo cuando cambia (clave
   ronda:turnSeq), no en cada tick del reloj. */
function _renderHistory(room){
  const el=$('#bid-history');
  if(!el)return;
  const hist=Array.isArray(room.history)?room.history:[];
  const key=`${room.round}:${room.turnSeq}:${hist.length}`;
  if(key===_histKey)return;
  _histKey=key;
  if(!hist.length||room.status!=='playing'){el.innerHTML='';el.classList.add('hidden');return;}
  el.classList.remove('hidden');
  el.innerHTML=hist.map((h,i)=>{
    const p=room.players?.[h.p];
    const nom=(p&&p.name)||'—';
    const yo=h.p===_playerId?' is-me':'';
    const ult=i===hist.length-1?' is-last':'';
    return `<span class="bh-item${yo}${ult}" title="${escapeHtml(nom)} subio a ${h.v}">`+
           `<b>${escapeHtml(_nombreCorto(room,h.p))}</b> ${h.v}${h.a?'<i title="subida automatica por reloj">⏱</i>':''}</span>`;
  }).join('<span class="bh-sep">›</span>');
}

function _renderActions(room){
  const panel=$('#action-panel'),waiting=$('#action-waiting');
  const bet=Number(room.bet||0);
  const total=Number(room.totalCards||0);
  const isMyTurn=room.status==='playing'&&room.turn===_playerId&&_studyLeft(room)<=0;

  if(!isMyTurn){
    panel.classList.add('hidden');
    waiting.classList.remove('hidden');
    const wl=$('#action-wait-label');
    if(room.status!=='playing')wl.textContent='Ronda terminada';
    else if(_lives(room,_playerId)<=0)wl.textContent='Estas eliminado · sigues como espectador';
    else if(room.turn)wl.textContent=`Turno de ${room.players?.[room.turn]?.name||'—'}`;
    else wl.textContent='Esperando…';
    return;
  }

  panel.classList.remove('hidden');
  waiting.classList.add('hidden');

  /* Cada turno nuevo arranca el selector en la subida minima. Sin
     esto se arrastraba el numero del turno anterior (o de la partida
     anterior) y al abrir una ronda aparecia una apuesta alta ya
     puesta sin que nadie la hubiera elegido. */
  const techo=_techo(room);
  const min=Math.min(techo,bet+1);
  const key=`${room.round}:${room.turnSeq}`;
  if(_raiseKey!==key){_raiseKey=key;_raiseDraft=min;}
  _raiseDraft=clamp(_raiseDraft,min,Math.max(min,techo));
  $('#raise-value').textContent=String(_raiseDraft);

  const canRaise=bet<techo;
  $('#btn-raise').disabled=!canRaise;
  $('#raise-minus').disabled=!canRaise||_raiseDraft<=min;
  $('#raise-plus').disabled=!canRaise||_raiseDraft>=techo;

  /* Primer turno de la ronda: solo se puede abrir subiendo. Y con la
     apuesta en 1 tampoco se puede cerrar: las dos formas de hacerlo son
     perdidas seguras (ver _techo). */
  const opening=bet<=0;
  const puedeCerrar=bet>=MIN_CIERRE;
  $('#act-row').classList.toggle('hidden',!puedeCerrar);
  const ownerName=room.betOwner?(room.players?.[room.betOwner]?.name||'—'):'—';
  /* En el duelo cada uno defiende un numero, asi que la pista dice
     cual te toca a ti; en el mentiroso, a quien se lo llamas. */
  $('#duel-hint').textContent=puedeCerrar?`tu ${bet-1} · ${ownerName} ${bet} · a 2 vidas`:'';
  $('#chal-hint').textContent=puedeCerrar?`a ${ownerName} · a 1 vida`:'';

  const help=$('#bet-help');
  if(opening)help.textContent=`Abres la ronda: di cuantas de las ${total} cartas crees que cumplen. Siempre cumple alguna y nunca todas, asi que la apuesta va de 1 a ${techo}.`;
  else if(!puedeCerrar)help.textContent=`Con la apuesta en 1 no se puede cerrar: cumple al menos una carta, asi que desafiar o llamar mentiroso serian perdidas seguras. Sube.`;
  else if(!canRaise)help.textContent=`La apuesta ya esta en el maximo (${techo} de ${total}). Solo puedes desafiar o llamar mentiroso.`;
  else help.textContent=`Apuesta actual ${bet} de ${total}. Sube; desafia si estas convencido (apuestas ${bet-1}: ganas 1 vida o pierdes 2); o llama mentiroso, que no da vida pero solo cuesta una si te equivocas.`;
}

function _renderGame(room){
  showScreen('#screen-game');
  _renderTable(room);
  _renderState(room);
  _fitTable();
}

/* ── "Estoy listo": saltarse la espera de estudio ──────────
   Los 30 s de estudio son largos cuando ya has contado la mesa (y
   contra bots son 30 s mirando la pared). El boton los corta en
   cuanto lo pulsan TODOS los vivos y conectados; contra bots basta
   con el jugador. */
function _renderReady(room,study){
  const btn=$('#btn-ready');
  if(!btn)return;
  const vivos=Object.keys(room.players||{}).filter(id=>{
    const p=room.players[id];
    return p&&p.connected!==false&&Number(p.lives||0)>0;
  });
  const puedo=study>0&&vivos.indexOf(_playerId)>=0;
  btn.classList.toggle('hidden',!puedo);
  if(!puedo)return;
  if(_local){btn.disabled=false;btn.textContent='EMPEZAR YA';return;}
  const listos=room.ready||{};
  const n=vivos.filter(id=>listos[id]).length;
  btn.disabled=!!listos[_playerId];
  btn.textContent=`${listos[_playerId]?'LISTO':'ESTOY LISTO'} · ${n}/${vivos.length}`;
}

function _markReady(){
  const room=_local?_localRoom:_lastRoom;
  if(!room||room.status!=='playing'||_studyLeft(room)<=0)return;
  if(_local){
    _localRoom.studyUntil=_now();
    _localRoom.turnAt=_now();
    _onRoomUpdate(_localRoom);
    _scheduleBot();          // el bot tenia la espera atada a los 30 s
    return;
  }
  Sync.markReady(_roomCode,_playerId).catch(e=>console.warn('ready',e));
}

/* ── Aviso de turno ──────────────────────────────────────────
   En una partida de ocho pueden pasar minutos entre tus turnos y la gente
   se va a otra pestana. Antes no habia forma de enterarse de que te
   tocaba salvo mirando; ahora vibra una vez y, si la pestana no se ve, el
   titulo parpadea hasta que vuelves. */
const _TITULO=document.title;
let _tituloTimer=null;
function _pararParpadeo(){
  if(_tituloTimer){clearInterval(_tituloTimer);_tituloTimer=null;}
  if(document.title!==_TITULO)document.title=_TITULO;
}
function _parpadearTitulo(){
  if(!document.hidden)return;
  _pararParpadeo();
  let on=false;
  _tituloTimer=setInterval(()=>{
    if(!document.hidden){_pararParpadeo();return;}
    on=!on;document.title=on?'\u25CF ¡TE TOCA! · El Mentiroso':_TITULO;
  },900);
}
function _avisarTurno(room){
  const esMio=!_local&&room.status==='playing'&&room.turn===_playerId
              &&_lives(room,_playerId)>0&&_studyLeft(room)<=0;
  const key=esMio?`${room.round}:${room.turnSeq}`:'';
  if(key===_avisoTurno)return;
  _avisoTurno=key;
  if(!key){_pararParpadeo();return;}
  try{ if(navigator.vibrate)navigator.vibrate(90); }catch(e){}
  _parpadearTitulo();
}

/* ═══ 10. RELOJ DE TURNO ═══════════════════════════════════ */
function _elapsed(from){
  const t=Number(from||0);
  if(!t)return 0;
  return clamp(_now()-t,0,10*60*1000);
}

/** Milisegundos que quedan de fase de estudio (0 si ya se puja). */
function _studyLeft(room){
  if(!room||room.status!=='playing')return 0;
  return Math.max(0,Number(room.studyUntil||0)-_now());
}

/**
 * Pinta la cabecera de apuesta y el reloj. Lo llaman _tick (cada 180 ms)
 * y _renderState (en cada cambio de sala), así que tiene que dejar los
 * mismos textos en los dos caminos: es el único sitio que escribe
 * #bid-value / #bid-owner / #turn-name.
 */
function _renderClock(room){
  const panel=$('.bid-panel');
  const fill=$('#timer-fill'), num=$('#timer-num');
  const kBid=$('#bid-kicker'), kTurn=$('#turn-kicker');
  const study=_studyLeft(room);
  const playing=room.status==='playing';

  /* Al pasar de estudio a puja hay que repintar los botones aunque no
     llegue ninguna novedad de la sala: el primero en hablar tiene que
     ver aparecer su panel solo. */
  const nowStudy=study>0;
  /* Al acabar el estudio desaparece el boton de "listo" y aparece el
     panel de apuesta: cambia el alto de la barra de accion, asi que
     hay que volver a medir el encaje de la mesa. */
  if(_studyOn!==nowStudy){_studyOn=nowStudy;_renderActions(room);_fitTable();}

  if(playing&&study>0){
    panel?.classList.add('study');
    if(kBid)kBid.textContent='LA PUJA EMPIEZA EN';
    if(kTurn)kTurn.textContent='ABRE LA RONDA';
    const secs=Math.ceil(study/1000);
    $('#bid-value').textContent=String(secs);
    $('#bid-owner').textContent='Mira las cartas y calcula cuantas cumplen';
    const opener=room.turn?room.players?.[room.turn]:null;
    $('#turn-name').textContent=room.turn===_playerId?'TU':(opener?opener.name:'—');
    if(fill){fill.style.width=(clamp(study/STUDY_MS,0,1)*100).toFixed(1)+'%';fill.classList.remove('warn');}
    if(num)num.textContent=secs+'s';
    const wl=$('#action-wait-label');
    if(wl)wl.textContent=`Estudia la mesa · la puja empieza en ${secs} s`;
    _renderReady(room,study);
    return;
  }

  _renderReady(room,0);

  panel?.classList.remove('study');
  if(kBid)kBid.textContent='APUESTA ACTUAL';
  if(kTurn)kTurn.textContent='TURNO DE';

  const bet=Number(room.bet||0);
  const owner=room.betOwner?room.players?.[room.betOwner]:null;
  $('#bid-value').textContent=bet>0?String(bet):'—';
  $('#bid-owner').textContent=bet>0
    ? `Subida por ${owner?owner.name:'—'}${room.betOwner===_playerId?' (tu)':''}`
    : 'Nadie ha abierto todavia';
  const turnP=room.turn?room.players?.[room.turn]:null;
  $('#turn-name').textContent=playing
    ? (room.turn===_playerId?'TI':(turnP?turnP.name:'—'))
    : '—';

  if(!playing){
    /* Entre rondas la barra se deja llena y sin cuenta atrás, para que
       no se quede congelada a media carrera. */
    if(fill){fill.style.width='100%';fill.classList.remove('warn');}
    if(num)num.textContent='—';
    return;
  }

  const left=Math.max(0,TURN_MS-_elapsed(room.turnAt));
  const pct=clamp(left/TURN_MS,0,1);
  if(fill){
    fill.style.width=(pct*100).toFixed(1)+'%';
    fill.classList.toggle('warn',pct<0.34);
  }
  if(num)num.textContent=Math.ceil(left/1000)+'s';
}

function _tick(){
  const room=_local?_localRoom:_lastRoom;
  if(!room)return;

  _renderClock(room);
  _avisarTurno(room);

  if(room.status==='playing'&&_studyLeft(room)<=0){
    const left=Math.max(0,TURN_MS-_elapsed(room.turnAt));

    /* Vigilancia en tres niveles. Los navegadores congelan los
       temporizadores de las pestañas en segundo plano, así que no
       basta con que decida el propio jugador (a los 15 s) ni con que
       el anfitrión resuelva por él (a los 19 s): si el anfitrión
       también tiene la pestaña de fondo, la partida se quedaba
       parada para todos. Por eso pasados 25 s cualquier jugador
       conectado puede desatascarla. Aplicar la acción de más es
       imposible: runTransaction valida turnSeq y solo entra la
       primera. */
    const key=`${room.round}:${room.turnSeq}`;
    if(left<=0&&_autoKey!==key){
      const over=_elapsed(room.turnAt);
      const iAmTurn=room.turn===_playerId;
      const botTurn=_local&&room.turn&&room.turn!==_playerId;
      const hostTurn=!botTurn&&_isHost&&over>=TURN_MS+HOST_GRACE_MS;
      const anyTurn=!botTurn&&!_local&&over>=TURN_MS+ANY_GRACE_MS&&!!room.players?.[_playerId];
      if(iAmTurn||hostTurn||anyTurn){
        /* La marca se pone ANTES para no mandar la misma accion dos veces
           en dos ticks seguidos, pero si el envio se rechaza hay que
           soltarla: antes se quedaba puesta y nadie volvia a intentarlo
           nunca, asi que un turno vencido cuya accion no colaba (p. ej.
           faltaba una carta para poder contar el total) dejaba la ronda
           clavada para siempre. */
        _autoKey=key;
        if(_submit(_timeoutAction(room,room.turn),room.turn)===false)_autoKey='';
      }
    }

    /* Practica: si por lo que sea no queda temporizador del bot (una
       accion suya rechazada, la pestana de vuelta de segundo plano), se
       reprograma. Sin esto la partida contra maquinas se quedaba clavada
       en su turno y no habia ningun rescate que la desatascara: los tres
       niveles de vigilancia de arriba no cubren el turno de un bot. */
    if(_local&&!_botTimer&&room.turn&&room.turn!==_playerId)_scheduleBot();
  }

  if(room.status==='reveal'){
    const left=Math.max(0,REVEAL_MS-_elapsed(room.resolvedAt));
    const hint=$('#continue-hint');
    if(hint){
      hint.textContent=_isHost
        ? `Continua sola en ${Math.ceil(left/1000)} s`
        : `La siguiente ronda empieza en ${Math.ceil(left/1000)} s`;
    }
    const key=`${room.round}:${room.turnSeq}`;
    if(_continueKey!==key){
      const over=_elapsed(room.resolvedAt);
      /* Mismo reparto que arriba: primero el anfitrión, y si no
         aparece, cualquiera saca la ronda siguiente. */
      const mine=_isHost&&left<=0;
      const rescue=!_local&&!_isHost&&over>=REVEAL_MS+ANY_GRACE_MS;
      if(mine||rescue){
        /* No se abre una ronda que nadie puede jugar. Antes se repartia
           igual y la mesa se quedaba pujando contra fantasmas. */
        if(!_local&&_activeIds(room).length<2)_esperarRivales(room);
        else{
          _continueKey=key;
          _continueRound(true);
        }
      }
    }
  }
}

/* Al volver de segundo plano el navegador ha tenido el reloj parado:
   recalcular en cuanto la pestaña se ve, sin esperar al siguiente
   intervalo. */
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)return;
  _pararParpadeo();
  _tick();
});

/* Queda un solo jugador conectado: no se abre ronda nueva, se espera. Si
   pasado un minuto y medio nadie vuelve, la partida se da por terminada
   en vez de dejar al que se quedo mirando una pantalla que no avanza. */
const ESPERA_MAX_MS=90000;
let _esperandoDesde=0;
function _esperarRivales(room){
  if(!_esperandoDesde)_esperandoDesde=Date.now();
  const restan=Math.max(0,ESPERA_MAX_MS-(Date.now()-_esperandoDesde));
  const hint=$('#continue-hint');
  if(hint)hint.textContent=restan>0
    ? `Esperando a que vuelva alguien… (${Math.ceil(restan/1000)} s)`
    : 'Nadie ha vuelto: cerrando la partida…';
  if(restan<=0&&_isHost&&_roomCode)Sync.walkover(_roomCode).catch(()=>{});
}

/* ═══ 11. RESOLUCIÓN (overlay) ═════════════════════════════ */
/* Cuanto cambio de verdad las vidas de un jugador. NO se lee de
   res.deltas: eso es lo que la jugada PEDIA, y con el tope de vidas
   puesto pedir +1 a quien ya las tiene todas no da nada. El panel de
   resolucion tiene que contar lo que ha pasado, no lo que iba a pasar. */
function _cambioDe(res,pid){
  const b=res.before&&res.before[pid], a=res.after&&res.after[pid];
  if(b===undefined||a===undefined)return 0;
  return Number(a)-Number(b);
}
function _verdicto(room,res){
  const P=pid=>escapeHtml(room.players?.[pid]?.name||'—');
  const orden=[];
  [res.actor,res.target].forEach(p=>{if(p&&orden.indexOf(p)<0)orden.push(p);});
  Object.keys(res.deltas||{}).forEach(p=>{if(orden.indexOf(p)<0)orden.push(p);});
  const t=[];
  orden.forEach(pid=>{
    if(!res.deltas||res.deltas[pid]===undefined)return;
    const d=_cambioDe(res,pid);
    const v=n=>n===1?'1 vida':n+' vidas';
    if(d>0)t.push(`${P(pid)} gana ${v(d)}`);
    else if(d<0)t.push(`${P(pid)} pierde ${v(-d)}`);
    else t.push(`${P(pid)} se queda igual`);
  });
  return t.length?t.join(' · '):'Nadie cambia de vidas';
}

function _resolutionCopy(room,res){
  const P=pid=>escapeHtml(room.players?.[pid]?.name||'—');
  const auto=res.type==='timeout';
  /* El color va por lo que te ha pasado A TI, no por si le fue bien al
     que desafio. Antes un espectador veia el panel en rojo por una
     jugada que no le tocaba ni una vida. */
  const mio=_cambioDe(res,_playerId);
  const tono=mio>0?'win':(mio<0?'lose':'neutral');
  const V=_verdicto(room,res);
  switch(res.outcome){
    case'duel-win':return{
      tag:auto?'SE ACABO EL TIEMPO · DUELO':'DUELO GANADO',
      head:`${P(res.actor)} desafio a ${P(res.target)}`,
      sub:`${P(res.actor)} apostaba ${res.bet-1} y ${P(res.target)} ${res.bet}: cumplen ${res.actual}`,
      verdict:V,tone:tono};
    case'duel-loss':return{
      tag:auto?'SE ACABO EL TIEMPO · DUELO':'DUELO PERDIDO',
      head:`${P(res.actor)} desafio a ${P(res.target)}`,
      sub:`${P(res.actor)} apostaba ${res.bet-1} y ${P(res.target)} ${res.bet}: cumplen ${res.actual}`,
      verdict:V,tone:tono};
    case'challenge-win':return{
      tag:'MENTIROSO CAZADO',
      head:`${P(res.actor)} llamo mentiroso a ${P(res.target)}`,
      sub:`La apuesta era ${res.bet} y solo cumplen ${res.actual}`,
      verdict:V,tone:tono};
    case'challenge-exact':return{
      tag:'ERA VERDAD',
      head:`${P(res.actor)} llamo mentiroso a ${P(res.target)}`,
      sub:`${P(res.target)} habia clavado el numero: ${res.actual}`,
      verdict:V,tone:tono};
    case'challenge-short':return{
      tag:'SE QUEDO CORTO',
      head:`${P(res.actor)} llamo mentiroso a ${P(res.target)}`,
      sub:`La apuesta era ${res.bet} y cumplen ${res.actual}: no era mentira`,
      verdict:V,tone:tono};
    default:return{tag:'RONDA TERMINADA',head:'—',sub:'',verdict:V,tone:tono};
  }
}

function _renderReveal(room){
  const res=room.resolution;
  if(!res)return;
  const ov=$('#overlay-reveal');ov.classList.remove('hidden');
  const cond=_condOf(room);
  const copy=_resolutionCopy(room,res);

  $('#reveal-tag').textContent=copy.tag;
  $('#reveal-headline').innerHTML=copy.head;
  $('#reveal-sub').innerHTML=copy.sub;
  $('#reveal-bet').textContent=res.bet;
  $('#reveal-actual').textContent=res.actual;
  $('#reveal-vs').textContent=res.bet===res.actual?'=':(res.bet>res.actual?'>':'<');
  const verdict=$('#reveal-verdict');
  verdict.innerHTML=copy.verdict;
  verdict.className='reveal-verdict '+(copy.tone||'neutral');

  /* Vidas antes → después, y quién queda fuera */
  const lv=$('#reveal-lives');lv.innerHTML='';
  Object.entries(room.players||{}).forEach(([pid,p])=>{
    const now=Number(p.lives||0);
    const before=res.before&&res.before[pid]!==undefined?res.before[pid]:now;
    const delta=now-before;
    const row=document.createElement('div');
    row.className='life-row'+(delta>0?' up':delta<0?' down':'')+(now<=0?' out':'');
    row.innerHTML=`<span class="life-name">${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span>`+
      `<span class="life-hearts">${_hearts(now)}</span>`+
      `<span class="life-delta">${delta>0?'+'+delta:delta<0?'−'+(-delta):'—'}${now<=0?' · ELIMINADO':''}</span>`;
    lv.appendChild(row);
  });

  $('#reveal-cond').textContent=cond?cond.label.toUpperCase():'';

  /* Todas las cartas con ✓/✗ */
  const cardsEl=$('#reveal-cards');cardsEl.innerHTML='';
  const center=_centerIds(room);
  if(center.length){
    const sec=document.createElement('div');sec.className='reveal-section';
    sec.innerHTML='<div class="reveal-section-label">Mesa central</div>';
    const row=document.createElement('div');row.className='reveal-row-cards';
    center.forEach(id=>row.appendChild(renderCard(MDeck.card(id),{cond,reveal:true})));
    sec.appendChild(row);cardsEl.appendChild(sec);
  }
  _seatsOf(room).forEach(pid=>{
    const p=room.players?.[pid];if(!p)return;
    const hand=_handIds(room,pid);if(!hand.length)return;
    const sec=document.createElement('div');sec.className='reveal-section';
    sec.innerHTML=`<div class="reveal-section-label${pid===_playerId?' is-me':''}">${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</div>`;
    const row=document.createElement('div');row.className='reveal-row-cards';
    hand.forEach(id=>row.appendChild(renderCard(MDeck.card(id),{cond,reveal:true})));
    sec.appendChild(row);cardsEl.appendChild(sec);
  });

  const btn=$('#btn-continue');
  btn.classList.toggle('hidden',!_isHost);
  btn.textContent=room.finished?'VER GANADOR':'SIGUIENTE RONDA';
}

function _renderFinished(room){
  $('#overlay-gameover').classList.remove('hidden');
  $('#winner-name').textContent=room.winnerName||'—';
  const sb=$('#winner-scoreboard');sb.innerHTML='';
  Object.entries(room.players||{})
    .sort((a,b)=>(Number(b[1].lives||0))-(Number(a[1].lives||0)))
    .forEach(([pid,p])=>{
      const lives=Number(p.lives||0);
      sb.innerHTML+=`<div class="life-row${lives<=0?' out':''}">`+
        `<span class="life-name">${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span>`+
        `<span class="life-hearts">${_hearts(lives)}</span>`+
        `<span class="life-delta">${lives<=0?'ELIMINADO':'EN PIE'}</span></div>`;
    });
}

/* ═══ 12. ENVÍO DE ACCIONES ════════════════════════════════ */
/** Envía una acción del turno actual. pid por defecto = el turno. */
/** @returns {boolean} false si no se ha llegado a enviar nada. */
function _submit(action,pid){
  const room=_local?_localRoom:_lastRoom;
  if(!room||room.status!=='playing')return false;
  if(_studyLeft(room)>0)return false;
  const actor=pid||room.turn;
  if(!actor||room.turn!==actor)return false;

  const act={...action,pid:actor,turnSeq:Number(room.turnSeq||0)};

  if(act.type==='duel'||act.type==='challenge'){
    const actual=_actualTotal(room);
    if(actual===null){
      toast('Faltan datos de alguna carta. Recarga la pagina.','error');
      return false;
    }
    act.actual=actual;
  }

  if(_local){
    const ok=_applyAction(_localRoom,act);
    if(ok)_onRoomUpdate(_localRoom);
    /* Se reprograma tanto si la accion entro como si no: si la del bot se
       rechaza y nadie vuelve a llamar aqui, la practica se queda parada. */
    _scheduleBot();
    return ok;
  }
  Sync.act(_roomCode,act).catch(e=>console.warn('act',e));
  return true;
}

/* ═══ 13. APERTURA DE RONDA ════════════════════════════════ */
function _buildRoundPayload(room,roundNum){
  const alive=_aliveIds(room);
  if(alive.length<2)return null;
  const shift=(roundNum-1)%alive.length;
  const seats=[...alive.slice(shift),...alive.slice(0,shift)];

  /* Prueba varias semillas hasta dar con una condición que parta
     la mesa en dos (ni 0 ni todas cumplen). */
  let seed=0,deal=null,cond=null;
  const prevSig=room.condKey?MDeck.condSignature(_condOf(room)):'';
  for(let i=0;i<8&&!cond;i++){
    seed=(Date.now()+roundNum*7919+i*104729)>>>0;
    deal=MDeck.deal(seed,seats);
    cond=MDeck.chooseCondition(deal.cards,MDeck.mulberry32(seed^0x9E3779B9),prevSig);
  }
  if(!cond)return null;

  return {
    status:'playing',
    round:roundNum,
    seed,
    seats,
    dealHands:deal.hands,
    dealCenter:deal.center,
    totalCards:deal.cards.length,
    condKey:cond.key,condArg:cond.arg,condNum:cond.num,
    condLabel:cond.label,
    bet:0,betOwner:null,
    /* Abre el primero de la rotacion que este conectado: si abre un
       ausente, la ronda se queda parada hasta que salte el rescate. */
    turn:seats.find(pid=>room.players?.[pid]?.connected!==false)||seats[0],
    turnSeq:Number(room.turnSeq||0)+1,
    /* turnAt en el futuro: hasta que no acaba el estudio, _elapsed da 0
       y el reloj del primer turno se queda parado y lleno. */
    studyUntil:_now()+STUDY_MS,
    turnAt:_now()+STUDY_MS,
    lastAction:null,
    history:null,
    passes:0,
    ready:null,
    resolution:null,
    resolvedAt:null,
  };
}

async function _startRound(roundNum){
  const room=_local?_localRoom:_lastRoom;
  if(!room)return;
  if(!MDeck.ready()){toast('Todavia se estan cargando las plantillas','error');return;}
  const payload=_buildRoundPayload(room,roundNum);
  if(!payload){
    toast('No se pudo preparar la ronda','error');
    return;
  }
  _autoKey='';_continueKey='';_dealKey='';_raiseKey='';_studyOn=null;
  if(_local){
    _applyRoundPayload(_localRoom,payload);
    _onRoomUpdate(_localRoom);
    _scheduleBot();
    return;
  }
  try{await Sync.startRound(_roomCode,payload);}
  catch(e){console.warn('startRound',e);toast('Error al iniciar la ronda','error');}
}

/** @param {boolean} rescue permite continuar sin ser anfitrión (ver _tick) */
async function _continueRound(rescue){
  const room=_local?_localRoom:_lastRoom;
  if(!room)return;
  if(!_isHost&&!rescue)return;
  if(!_local&&!room.finished&&_activeIds(room).length<2){_esperarRivales(room);return;}
  _esperandoDesde=0;
  if(room.finished){
    if(_local){_localRoom.status='finished';_onRoomUpdate(_localRoom);}
    else Sync.setFinished(_roomCode).catch(()=>{});
    return;
  }
  await _startRound(Number(room.round||0)+1);
}

/* ═══ 14. PRÁCTICA (bots) ══════════════════════════════════ */
const BOT_NAMES=['Bot Pirlo','Bot Xavi','Bot Kante','Bot Pogba','Bot Vidal','Bot Alonso','Bot Busquets'];

function _startLocal(){
  if(!MDeck.ready()){toast('Todavia se estan cargando las plantillas','error');return;}
  const name=_accName('practice-name')||'Tu';
  _reset();
  _local=true;_isHost=true;_playerId='me';_roomCode=null;
  const players={me:{name,avatar:_accAvatar(),lives:_livesDraft,connected:true,isHost:true}};
  for(let i=0;i<_botsDraft;i++){
    players['bot'+i]={name:BOT_NAMES[i%BOT_NAMES.length],avatar:null,lives:_livesDraft,connected:true,isHost:false};
  }
  _localRoom={
    game:'mentiroso',status:'waiting',mode:_modeDraft,startLives:_livesDraft,
    round:0,turnSeq:0,bet:0,betOwner:null,turn:null,studyUntil:0,totalCards:0,players,
  };
  _startRound(1);
}

/** Estimación del bot: conoce el total real, pero con ruido. */
function _botEstimate(room){
  const actual=_actualTotal(room);
  const total=Number(room.totalCards||0);
  if(actual===null)return Math.round(total/3);
  const spread=Math.max(1,Math.round(total*0.14));
  const noise=Math.round((Math.random()*2-1)*spread);
  return clamp(actual+noise,0,total);
}

function _botAction(room){
  const total=_techo(room);   // el techo real de la puja, no las cartas
  const bet=Number(room.bet||0);
  const est=_botEstimate(room);

  if(bet<=0)return {type:'raise',value:clamp(Math.round(est*0.6)||1,1,total)};

  /* Cuanto cree el bot que la apuesta se ha pasado. Las dos formas de
     cerrar la ronda dicen lo mismo ("ahi no llegas") y se diferencian
     en lo que arriesgan: el DUELO gana una vida si acierta pero la
     pierde en cuanto el total llegue a la apuesta, y MENTIROSO no da
     vida pero solo la quita si la apuesta se queda corta. Asi que el
     bot desafia cuando esta convencido y llama mentiroso cuando solo
     lo sospecha. */
  const exceso=bet-est;

  /* Con la apuesta en 1 no se puede cerrar (perdida segura), asi que el
     bot sube aunque crea que ya se han pasado. */
  if(bet<MIN_CIERRE)return {type:'raise',value:clamp(Math.max(bet+1,Math.min(est,bet+2)),bet+1,total)};
  if(bet>=total)return exceso>0?{type:'duel'}:{type:'challenge'};
  /* El duelo cuesta DOS vidas si falla, asi que solo sale cuando el bot
     cree que la apuesta se ha pasado de largo. Con una sospecha justa
     prefiere gritar mentiroso, que solo cuesta una. */
  if(exceso>=3)return Math.random()<0.65?{type:'duel'}:{type:'challenge'};
  if(exceso===2)return Math.random()<0.40?{type:'duel'}:{type:'challenge'};
  if(exceso===1)return Math.random()<0.15?{type:'duel'}
                     :(Math.random()<0.5?{type:'challenge'}:{type:'raise',value:bet+1});
  if(exceso===0)return Math.random()<0.45?{type:'challenge'}:{type:'raise',value:bet+1};
  const step=1+Math.floor(Math.random()*2);
  return {type:'raise',value:clamp(Math.max(bet+1,Math.min(est,bet+step)),bet+1,total)};
}

/** Cuánto "piensa" el bot antes de responder, según lo que va a hacer. */
function _botDelay(action){
  let ms=BOT_MIN_MS+Math.random()*(BOT_MAX_MS-BOT_MIN_MS);
  /* Desafiar o llamar mentiroso cierra la ronda y se juega una vida:
     ahí cualquiera se lo piensa un poco más que para subir de 4 a 5. */
  if(action.type!=='raise')ms+=1500+Math.random()*2500;
  /* Alguna vez la jugada es evidente y sale sola. */
  if(Math.random()<0.15)ms*=0.45;
  return clamp(ms,1200,BOT_CAP_MS);
}

function _scheduleBot(){
  clearTimeout(_botTimer);_botTimer=null;
  const room=_localRoom;
  if(!room||room.status!=='playing')return;
  const turn=room.turn;
  if(!turn||turn===_playerId)return;
  const seq=room.turnSeq;
  /* La decisión se toma ya para poder ajustar la espera a lo que va a
     hacer; al disparar se revalida que el turno siga siendo el mismo. */
  const accion=_botAction(room);
  const espera=_studyLeft(room)+_botDelay(accion);
  _botTimer=setTimeout(()=>{
    /* Se suelta la referencia al entrar: el vigilante de _tick usa
       justamente "no hay temporizador" para saber que hay que reprogramar,
       y con el identificador viejo puesto no lo veria nunca. */
    _botTimer=null;
    if(_localRoom!==room||room.status!=='playing')return;
    if(room.turn!==turn||room.turnSeq!==seq)return;
    _submit(accion,turn);
  },espera);
}

/* ── La sala vive en la URL (js/ruta.js, mismo convenio que el resto
      de juegos con sala): asi el enlace se puede compartir y recargar
      la pagina te devuelve a la sala en vez de al menu. ── */
function _marcarSalaEnRuta(code,name,pid){
  if(!window.FHRuta)return;
  FHRuta.set({sala:code});
  /* El playerId viaja en `datos`: es lo unico que le falta a la vuelta
     para reocupar TU sitio (con tus vidas y tu condicion de anfitrion) en
     vez de entrar de cero como un jugador nuevo. Va en localStorage con
     la ventana de 3 h de FHRuta, no en la URL: la URL se comparte y el
     que la reciba no puede ser tu. */
  FHRuta.recordarSala('mentiroso',code,name,pid?{pid}:null);
}

/**
 * Vuelve a una sala en la que ya estabas. Es lo que faltaba: hasta ahora
 * recargar la pagina llamaba a un `update` ciego que decia "estoy
 * conectado" sin comprobar que la sala ni tu registro siguieran ahi, y
 * entrar por el enlace con la partida empezada respondia "La partida ya
 * ha comenzado" aunque fueras uno de los que estaban jugando.
 */
async function _volverALaSala(v){
  showScreen('#screen-menu');
  const nombre=v.name||_accName('join-name')||_accName('create-name')||'';
  let r;
  try{ r=await Sync.rejoin(v.code,v.pid,nombre,_accAvatar(),v.soloSiLibre?{soloSiLibre:true}:null); }
  catch(e){ r={ok:false,reason:'No se pudo volver a la sala'}; }
  if(!r.ok){
    _clearSession();
    _roomCode=null;_playerId=null;
    /* El asiento sigue ocupado desde otra pestana: no es un error, es que
       ahi no habia nada que recuperar. Se deja el menu listo para entrar
       como jugador nuevo y NO se borra lo recordado. */
    if(r.reason!=='__ocupado__'){_olvidarSalaEnRuta();toast(r.reason,'info');}
    _prepararReentrada(v.code);
    return;
  }
  _local=false;_roomCode=v.code;_playerId=v.pid;
  _marcarSalaEnRuta(v.code,nombre,v.pid);
  _saveSession();
  _unsub=Sync.listenRoom(v.code,_onRoomUpdate);
}
function _olvidarSalaEnRuta(){
  if(!window.FHRuta)return;
  FHRuta.borrar('sala');
  FHRuta.olvidarSala('mentiroso');
}
/** Enlace de invitacion a la sala actual. */
function _enlaceSala(){
  const u=new URL(window.location.href);
  u.search='?sala='+encodeURIComponent(_roomCode||'');
  u.hash='';
  return u.toString();
}

/* ═══ 15. ACCIONES DE MENÚ ═════════════════════════════════ */
/* Los dos botones de entrada se bloquean mientras la peticion esta en el
   aire. Sin esto, un doble toque en un movil lento creaba DOS salas (te
   quedabas en la segunda y la primera se perdia con el enlace que
   acababas de mandar) o mandaba dos peticiones de union. */
let _entrando=false;
function _bloquearEntrada(v){
  _entrando=v;
  ['#btn-create','#btn-join'].forEach(sel=>{const b=$(sel);if(b)b.disabled=v;});
}

async function _createRoom(){
  if(_entrando)return;
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  if(!_deckReady){toast('Espera a que carguen las plantillas','error');return;}
  const name=_accName('create-name');
  if(!name){toast('Escribe tu nombre','error');return;}
  _bloquearEntrada(true);
  try{
    const{code,playerId}=await Sync.createRoom(name,_modeDraft,_livesDraft,_accAvatar());
    _local=false;_roomCode=code;_playerId=playerId;_isHost=true;
    _marcarSalaEnRuta(code,name,playerId);
    _saveSession();_unsub=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){toast(e.message,'error');}
  finally{_bloquearEntrada(false);}
}
async function _joinRoom(){
  if(_entrando)return;
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  if(!_deckReady){toast('Espera a que carguen las plantillas','error');return;}
  const name=_accName('join-name');
  const code=($('#join-code').value||'').trim().toUpperCase();
  /* El error del intento anterior se limpia AQUI: antes se quedaba en
     pantalla contradiciendo al intento siguiente. */
  $('#join-error').classList.add('hidden');
  if(!name){toast('Escribe tu nombre','error');return;}
  if(!/^[A-Z0-9]{4,8}$/.test(code)){toast('Codigo invalido','error');return;}
  _bloquearEntrada(true);
  try{
    /* Si en este mismo navegador ya estabas dentro de ESA sala, se vuelve
       en vez de entrar de cero: asi se recupera el asiento con sus vidas
       y, si la partida ya ha empezado, se entra igualmente (joinRoom lo
       prohibe con razon, pero volver no es colarse). `soloSiLibre` evita
       lo contrario: quitarle el sitio a alguien que sigue dentro desde
       otra pestana del mismo navegador. */
    const rec=window.FHRuta&&FHRuta.salaRecordada('mentiroso',code);
    if(rec&&rec.datos&&rec.datos.pid){
      const v=await Sync.rejoin(code,rec.datos.pid,name,_accAvatar(),{soloSiLibre:true});
      if(v.ok){
        _local=false;_roomCode=code;_playerId=rec.datos.pid;
        _marcarSalaEnRuta(code,name,rec.datos.pid);
        _saveSession();_unsub=Sync.listenRoom(code,_onRoomUpdate);
        return;
      }
    }
    const r=await Sync.joinRoom(code,name,_accAvatar());
    _local=false;_roomCode=r.code;_playerId=r.playerId;_isHost=false;
    _marcarSalaEnRuta(r.code,name,r.playerId);
    _saveSession();_unsub=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){$('#join-error').textContent=e.message;$('#join-error').classList.remove('hidden');}
  finally{_bloquearEntrada(false);}
}
async function _startGame(){
  if(_local||!_isHost||!_roomCode||!_lastRoom)return;
  if(_activeIds(_lastRoom).length<2){toast('Se necesitan al menos 2 jugadores conectados','error');return;}
  await _startRound(1);
}
async function _leaveRoom(){
  /* Primero se limpia el estado local y se vuelve al menú, y sólo
     después se avisa a Firebase. Al revés, el _reset() quedaba detrás
     del await y podía llegar tarde: si mientras tanto ya se había
     empezado otra partida (p. ej. una práctica), la borraba. */
  const code=_roomCode,pid=_playerId,wasOnline=!_local;
  _reset();
  _olvidarSalaEnRuta();
  showScreen('#screen-menu');
  if(wasOnline&&code&&pid){try{await Sync.disconnect(code,pid);}catch{}}
}
async function _kick(pid,name){
  if(!confirm(`¿Quitar a ${name}?`))return;
  try{await Sync.kick(_roomCode,pid);toast(`${name} eliminado`,'info');}catch{toast('Error','error');}
}

/* ═══ 16. CARGA DE LA BARAJA ═══════════════════════════════ */
function _setDbStatus(text,pct,state){
  const box=$('#db-status'),label=$('#db-status-label'),fill=$('#db-bar-fill');
  if(!box)return;
  box.classList.toggle('done',state==='done');
  box.classList.toggle('error',state==='error');
  if(label)label.textContent=text;
  if(fill)fill.style.width=clamp(pct*100,0,100)+'%';
  if(state==='done')setTimeout(()=>box.classList.add('hidden'),900);
}
function _lockMenu(locked){
  ['#btn-create','#btn-join','#btn-practice'].forEach(sel=>{
    const b=$(sel);if(b)b.disabled=locked;
  });
}
function _loadDeck(){
  _lockMenu(true);
  _setDbStatus('Cargando plantillas…',0.05,'loading');
  MDeck.load(p=>_setDbStatus(`Cargando plantillas… ${Math.round(p*100)}%`,Math.max(0.05,p),'loading'))
    .then(pool=>{
      _deckReady=true;_deckError=null;
      _setDbStatus(`${pool.length} futbolistas listos`,1,'done');
      _lockMenu(false);
      /* _dealKey a cero antes de repintar: _renderTable se salta el
         repintado si la clave del reparto no ha cambiado, asi que una
         mesa dibujada mientras la baraja aun cargaba se quedaba con
         interrogantes en todas las cartas para siempre. Con la vuelta a
         la sala esto pasa de ser raro a ser lo normal. */
      _dealKey='';
      if(_lastRoom)_onRoomUpdate(_lastRoom);
    })
    .catch(err=>{
      console.error('[Mentiroso] no se pudo cargar la baraja',err);
      _deckReady=false;_deckError=err;
      _setDbStatus('No se pudo cargar la base de jugadores. Recarga la pagina.',1,'error');
      _lockMenu(true);
    });
}

/* ═══ 17. BOOT ═════════════════════════════════════════════ */
function boot(){
  if(!window.MDeck){toast('Faltan datos del juego','error');return;}

  /* Tabs */
  $$('.menu-tab').forEach(tab=>tab.addEventListener('click',()=>{
    $$('.menu-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');
    $$('.menu-panel').forEach(p=>p.classList.remove('active'));
    $(`.menu-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
  }));

  /* Modo */
  $$('.mode-opt').forEach(b=>b.addEventListener('click',()=>{
    $$('.mode-opt').forEach(x=>x.classList.remove('active'));b.classList.add('active');
    _modeDraft=b.dataset.mode;
  }));

  /* Vidas iniciales (menú) */
  $$('#lives-toggle .lives-opt').forEach(b=>b.addEventListener('click',()=>{
    $$('#lives-toggle .lives-opt').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');_livesDraft=Number(b.dataset.lives)||3;
  }));
  /* Vidas iniciales (lobby, solo anfitrión) */
  $$('#lobby-lives-toggle .lives-opt').forEach(b=>b.addEventListener('click',()=>{
    if(!_isHost||!_roomCode||!_lastRoom)return;
    /* Además del ajuste, se reparten las vidas nuevas a quien ya
       estuviera en la sala: si no, el lobby prometía 5 vidas y la
       partida arrancaba con las 3 que tenía cada uno al entrar. */
    const n=Number(b.dataset.lives)||3;
    const patch={startLives:n};
    Object.keys(_lastRoom.players||{}).forEach(pid=>{patch[`players/${pid}/lives`]=n;});
    Sync.updateSettings(_roomCode,patch).catch(()=>{});
  }));

  /* Bots (práctica) */
  $('#btn-bots-minus')?.addEventListener('click',()=>{_botsDraft=Math.max(1,_botsDraft-1);$('#practice-bots-value').textContent=_botsDraft;});
  $('#btn-bots-plus')?.addEventListener('click',()=>{_botsDraft=Math.min(5,_botsDraft+1);$('#practice-bots-value').textContent=_botsDraft;});

  /* Botones */
  _setupAccountName();
  $('#btn-create')?.addEventListener('click',_createRoom);
  $('#btn-join')?.addEventListener('click',_joinRoom);
  $('#btn-practice')?.addEventListener('click',_startLocal);
  $('#btn-start')?.addEventListener('click',_startGame);
  $('#btn-menu')?.addEventListener('click',_leaveRoom);
  $('[data-action="leave-lobby"]')?.addEventListener('click',_leaveRoom);
  $('#btn-leave-game')?.addEventListener('click',()=>{
    if(confirm('¿Seguro que quieres abandonar la partida?'))_leaveRoom();
  });
  $('#btn-copy-link')?.addEventListener('click',()=>{
    /* Se copia el ENLACE, no el codigo suelto: quien lo recibe entra de
       un toque en vez de tener que abrir el juego y teclear seis letras. */
    navigator.clipboard?.writeText(_enlaceSala())
      .then(()=>toast('Enlace de invitacion copiado','success'))
      .catch(()=>{
        navigator.clipboard?.writeText(_roomCode||'').then(()=>toast('Codigo copiado','success')).catch(()=>{});
      });
  });
  $('#btn-continue')?.addEventListener('click',()=>{
    const room=_local?_localRoom:_lastRoom;
    if(room)_continueKey=`${room.round}:${room.turnSeq}`;
    _continueRound();
  });

  /* Acciones de turno */
  $('#raise-minus')?.addEventListener('click',()=>{
    const room=_local?_localRoom:_lastRoom;if(!room)return;
    _raiseDraft=Math.max(Number(room.bet||0)+1,_raiseDraft-1);
    _renderActions(room);
  });
  $('#raise-plus')?.addEventListener('click',()=>{
    const room=_local?_localRoom:_lastRoom;if(!room)return;
    _raiseDraft=Math.min(_techo(room),_raiseDraft+1);
    _renderActions(room);
  });
  $('#btn-raise')?.addEventListener('click',()=>{
    const room=_local?_localRoom:_lastRoom;if(!room)return;
    _submit({type:'raise',value:_raiseDraft});
  });
  $('#btn-ready')?.addEventListener('click',_markReady);
  $('#btn-duel')?.addEventListener('click',()=>_submit({type:'duel'}));
  $('#btn-challenge')?.addEventListener('click',()=>_submit({type:'challenge'}));

  /* Reloj */
  setInterval(_tick,180);

  /* beforeunload — solo lobby online */
  window.addEventListener('beforeunload',()=>{
    if(!_local&&_roomCode&&_playerId&&_lastRoom?.status==='waiting')Sync.disconnect(_roomCode,_playerId).catch(()=>{});
  });

  /* ?sala= — validado (lo escribe cualquiera en la barra) y, si venimos
     de recargar, con el nombre con el que ya estabas dentro. */
  const sala=window.FHRuta?FHRuta.sala()
    :(new URLSearchParams(window.location.search).get('sala')||'').toUpperCase();
  if(sala){
    $('#join-code').value=sala;
    const rec=window.FHRuta&&FHRuta.salaRecordada('mentiroso',sala);
    if(rec&&rec.nombre)$('#join-name').value=rec.nombre;
    $$('.menu-tab').forEach(t=>t.classList.remove('active'));
    $('.menu-tab[data-tab="join"]')?.classList.add('active');
    $$('.menu-panel').forEach(p=>p.classList.remove('active'));
    $('.menu-panel[data-panel="join"]')?.classList.add('active');
  }

  _watchServerClock();
  _loadDeck();

  /* ── Volver a una sala ───────────────────────────────────────
     Dos fuentes, y hacen falta las dos:
       · sessionStorage — vale para recargar ESTA pestana, y solo para
         esta: sessionStorage no se comparte entre pestanas.
       · lo que FHRuta recuerda del ?sala= de la URL (localStorage, 3 h) —
         cubre volver a abrir el enlace de invitacion, entrar desde el hub
         o restaurar la pestana en otro momento.
     Antes solo estaba la primera, y ni siquiera comprobaba nada: llamaba
     a un update ciego que decia "estoy conectado" sobre una ruta que
     podia no existir. */
  let vuelta=null;
  try{
    const g=JSON.parse(sessionStorage.getItem('mentiroso_s')||'null');
    if(g&&g.code&&g.pid)vuelta={code:String(g.code),pid:String(g.pid),name:''};
  }catch(e){}
  if(sala){
    /* El enlace manda sobre la sesion guardada: si vienes a una sala y en
       esta pestana quedaba una sesion de OTRA, la vieja sobra — llevarte a
       ella seria ignorar el enlace que acabas de abrir. */
    if(vuelta&&vuelta.code!==sala)vuelta=null;
    const rec=window.FHRuta&&FHRuta.salaRecordada('mentiroso',sala);
    if(rec){
      if(vuelta&&vuelta.code===sala)vuelta.name=rec.nombre||'';
      /* soloSiLibre: este playerId viene de localStorage, que se comparte
         entre pestanas. Si el asiento sigue ocupado y conectado, no se le
         quita a nadie — se entra como jugador nuevo. */
      else if(!vuelta&&rec.datos&&rec.datos.pid)vuelta={code:sala,pid:String(rec.datos.pid),name:rec.nombre||'',soloSiLibre:true};
    }
  }
  if(vuelta&&window._FB&&window._FB.configured){
    showScreen('#screen-menu');
    toast('Volviendo a la sala…','info');
    _volverALaSala(vuelta);
    return;
  }

  showScreen('#screen-menu');
}
boot();
