/* ═══════════════════════════════════════════════════════════
   GAME.JS — EL MENTIROSO  (reescrito desde cero v7)
   Arquitectura copiada del juego "Restricciones" que funciona.
   - Sync: set/update/remove, runTransaction solo para contadores
   - Cartas repartidas localmente via seed determinista
   - Estado flat en Firebase (sin arrays que se corrompan)
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ═══ 1. HELPERS ═══════════════════════════════════════════ */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function escapeHtml(s) { const d=document.createElement('div'); d.textContent=String(s??''); return d.innerHTML; }

let _toastTimer = null;
function toast(msg, type) {
  const el=$('#toast'); if(!el)return;
  el.textContent=msg; el.className=`toast show ${type||''}`;
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>el.classList.remove('show'),2800);
}

function showScreen(id) {
  $$('.screen').forEach(s=>s.classList.remove('active'));
  $(id)?.classList.add('active');
}

function genCode(len=6) {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:len},()=>c[Math.floor(Math.random()*c.length)]).join('');
}
function genId() { return Math.random().toString(36).slice(2,10)+Date.now().toString(36); }

/* ═══ 2. DATA MAPS ═════════════════════════════════════════ */
const COUNTRY_ISO={'Albania':'AL','Algeria':'DZ','Argentina':'AR','Armenia':'AM','Australia':'AU','Austria':'AT','Belarus':'BY','Belgium':'BE','Benin':'BJ','Bolivia':'BO','Bosnia-Herzegovina':'BA','Brazil':'BR','Bulgaria':'BG','Burkina':'BF','Cameroon':'CM','Canada':'CA','Cape':'CV','Chile':'CL','China':'CN','Colombia':'CO','Congo':'CG','Costa':'CR','Cote':'CI',"Cote d'Ivoire":'CI','Croatia':'HR','Curacao':'CW','Cyprus':'CY','Czech':'CZ','Czech Republic':'CZ','DR':'CD','DR Congo':'CD','Denmark':'DK','Ecuador':'EC','Egypt':'EG','Equatorial':'GQ','Eritrea':'ER','Estonia':'EE','Faroe':'FO','Finland':'FI','France':'FR','French':'GF','Gabon':'GA','Georgia':'GE','Germany':'DE','Ghana':'GH','Greece':'GR','Guinea':'GN','Guinea-Bissau':'GW','Haiti':'HT','Honduras':'HN','Hungary':'HU','Iceland':'IS','Iran':'IR','Iraq':'IQ','Ireland':'IE','Israel':'IL','Italy':'IT','Jamaica':'JM','Japan':'JP','Kazakhstan':'KZ','Korea,':'KR','Korea, South':'KR','Kosovo':'XK','Latvia':'LV','Lebanon':'LB','Liberia':'LR','Lithuania':'LT','Luxembourg':'LU','Mali':'ML','Mexico':'MX','Moldova':'MD','Montenegro':'ME','Morocco':'MA','Netherlands':'NL','New':'NZ','Nigeria':'NG','North':'MK','Norway':'NO','Palestine':'PS','Panama':'PA','Paraguay':'PY','Peru':'PE','Poland':'PL','Portugal':'PT','Qatar':'QA','Romania':'RO','Russia':'RU','Senegal':'SN','Serbia':'RS','Sierra':'SL','Slovakia':'SK','Slovenia':'SI','South':'ZA','Spain':'ES','Suriname':'SR','Sweden':'SE','Switzerland':'CH','Tanzania':'TZ','Thailand':'TH','The':'GM','The Gambia':'GM','Togo':'TG','Trinidad':'TT','Tunisia':'TN','Türkiye':'TR','Ukraine':'UA','United':'US','United States':'US','Uruguay':'UY','Uzbekistan':'UZ','Venezuela':'VE','Zambia':'ZM','Zimbabwe':'ZW'};
const COUNTRY_SPECIAL={'England':'fi-gb-eng','Scotland':'fi-gb-sct','Wales':'fi-gb-wls','Northern Ireland':'fi-gb-nir','Northern':'fi-gb-nir'};

function countryFlagHTML(country,fb) {
  if(!country) return `<span class="card-flag-text">${escapeHtml(fb||'')}</span>`;
  const sp=COUNTRY_SPECIAL[country];
  if(sp) return `<span class="fi ${sp}" title="${escapeHtml(country)}"></span>`;
  const iso=COUNTRY_ISO[country];
  if(iso) return `<span class="fi fi-${iso.toLowerCase()}" title="${escapeHtml(country)}"></span>`;
  return `<span class="card-flag-text">${escapeHtml(fb||country.slice(0,2).toUpperCase())}</span>`;
}

const CLUB_TM={'Bayern Munich':27,'Inter Milan':46,'FC Barcelona':131,'AC Milan':5,'Arsenal FC':11,'Real Madrid':418,'Liverpool FC':31,'Manchester City':281,'Aston Villa':405,'SSC Napoli':6195,'Tottenham Hotspur':148,'Newcastle United':762,'CR Flamengo':614,'Besiktas JK':114,'Galatasaray':141,'Manchester United':985,'Man Utd':985,'AS Roma':12,'Atalanta BC':800,'Crystal Palace':873,'Atlético de Madrid':13,'SS Lazio':398,'Juventus FC':506,'Fenerbahce':36,'Santos FC':4843,'Feyenoord Rotterdam':234,'Borussia Dortmund':16,'Chelsea FC':631,'Al-Nassr FC':52908,'Inter Miami CF':53537,'Girona FC':12321,'Bayer 04 Leverkusen':15,'Real Betis Balompié':150,'SL Benfica':294,'Ajax Amsterdam':610,'Celtic FC':371,'West Ham United':379,'Villarreal CF':1050,'ACF Fiorentina':430,'Torino FC':416,'Rangers FC':390,'AFC Bournemouth':989,'Al-Hilal SFC':52918,'Sevilla FC':368,'Paris Saint-Germain':583,'PSV Eindhoven':383,'RB Leipzig':23826,'VfL Wolfsburg':82,'Eintracht Frankfurt':24,'VfB Stuttgart':79,'SC Freiburg':17,'Real Sociedad':681,'Valencia CF':1049,'Athletic Club':621,'Olympique de Marseille':244,'Olympique Lyonnais':1041,'AS Monaco':162,'Sporting CP':336,'FC Porto':720};

function clubBadgeHTML(name,sz) {
  sz=sz||18; const id=CLUB_TM[name];
  const ini=((name||'').replace(/\b(FC|CF|SC|AFC|SL|CA|AS|SS|SSC|AC|ACF|CR|VfL|VfB|RCD)\b/gi,'').trim().split(/\s+/).filter(Boolean).map(w=>w[0]).join('').slice(0,3).toUpperCase())||'?';
  const t=escapeHtml(name||'');
  if(id) return `<img class="card-club-logo" style="width:${sz}px;height:${sz}px" src="https://tmssl.akamaized.net/images/wappen/small/${id}.png" loading="lazy" alt="${t}" title="${t}" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="card-club-initials" title="${t}" style="display:none">${ini}</span>`;
  return `<span class="card-club-initials" title="${t}">${ini}</span>`;
}

/* ═══ 3. CARD SYSTEM (determinista) ══════════════════════════ */
function mulberry32(seed) {
  return function() {
    seed|=0; seed=seed+0x6D2B79F5|0;
    let t=Math.imul(seed^(seed>>>15),1|seed);
    t=t+Math.imul(t^(t>>>7),61|t)^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function shuffleRng(arr,rng) {
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

const HAND_CONFIG=[
  {min:2,max:2,hand:7,center:4},
  {min:3,max:3,hand:5,center:4},
  {min:4,max:4,hand:4,center:4},
  {min:5,max:5,hand:3,center:3},
  {min:6,max:8,hand:2,center:0},
];
function getHandConfig(n) { return HAND_CONFIG.find(c=>c.min<=n&&n<=c.max)||HAND_CONFIG[0]; }
const CENTER_ATTRS=['flag','position','club'];

function createCard(player) {
  return {
    playerId: player.id,
    playerName: player.name,
    country: player.country,
    countryFlag: player.countryFlag,
    club: player.club,
    clubBadge: player.clubBadge,
    position: player.position,
    stats: {...player.stats},
  };
}

/* Threshold cache para condiciones numéricas */
const _threshCache = {};
function getThresholds(key) {
  if(_threshCache[key]) return _threshCache[key];
  const vals = window.PLAYERS.map(p=>Number(p.stats[key])||0).filter(v=>v>0);
  if(!vals.length) return _threshCache[key]=[];
  vals.sort((a,b)=>a-b);
  const set=new Set(), pcts=[0.25,0.5,0.75];
  pcts.forEach(p=>{ const v=vals[Math.floor(p*vals.length)]; if(v>0)set.add(v); });
  return _threshCache[key]=[...set].sort((a,b)=>a-b);
}

function cardMatchesCond(card, cond) {
  const val = card.stats[cond.key];
  if(cond.type==='bool') return Boolean(val);
  return Number(val||0) > (cond.threshold||0);
}

/* Elige condición no-degenerada contra el deck dado, usando el rng del seed */
function chooseCondition(deck, rng) {
  const defs=window.STAT_DEFINITIONS;
  for(let i=0;i<30;i++){
    const def=defs[Math.floor(rng()*defs.length)];
    let threshold=null, label=def.label;
    if(def.type==='number'){
      const opts=getThresholds(def.key);
      if(!opts.length) continue;
      threshold=opts[Math.floor(rng()*opts.length)];
      label=`Mas de ${threshold} ${def.unit}`;
    }
    const cond={key:def.key,type:def.type,label,unit:def.unit||'',threshold};
    const m=deck.reduce((n,c)=>n+(cardMatchesCond(c,cond)?1:0),0);
    if(m>=1 && m<deck.length) return cond;
  }
  const def=defs[Math.floor(rng()*defs.length)];
  return {key:def.key,type:def.type,label:def.label,unit:def.unit||'',threshold:null};
}

/* Reparto determinista: mismo seed + mismos playerIds = mismas cartas siempre */
function dealRound(seed, sortedPlayerIds) {
  const rng=mulberry32(seed);
  const n=sortedPlayerIds.length;
  const cfg=getHandConfig(n);
  const total=cfg.center+(n*cfg.hand);
  const shuffled=shuffleRng(window.PLAYERS,rng);
  const deck=shuffled.slice(0,total).map(createCard);

  let idx=0;
  const hands={};
  sortedPlayerIds.forEach(pid=>{
    hands[pid]=deck.slice(idx,idx+cfg.hand);
    idx+=cfg.hand;
  });
  const centerCards=deck.slice(idx).map(c=>({...c, visibleAttr:CENTER_ATTRS[Math.floor(rng()*3)]}));
  const condition=chooseCondition(deck,rng);
  return {hands,centerCards,condition,deck};
}

/* Orden de turno rotado por ronda */
function getPlayerOrder(room) {
  const ids=Object.keys(room.players||{}).sort();
  const shift=((room.round||1)-1)%ids.length;
  return [...ids.slice(shift),...ids.slice(0,shift)];
}
function getCurrentTurnId(room) {
  const order=getPlayerOrder(room);
  const guesses=room.guesses||{};
  return order.find(pid=>guesses[pid]===undefined||guesses[pid]===null)||null;
}
function allGuessed(room) {
  const connected=Object.entries(room.players||{}).filter(([,p])=>p.connected!==false).map(([id])=>id);
  const guesses=room.guesses||{};
  return connected.every(pid=>guesses[pid]!==undefined&&guesses[pid]!==null);
}

/* ═══ 4. SYNC MODULE ═══════════════════════════════════════ */
const Sync = (() => {
  const PATH='restricciones/rooms';
  const FB=()=>window._FB;
  const _ref=p=>{const{db,ref}=FB();return ref(db,p);};

  async function createRoom(hostName,mode,pointsToWin) {
    const{set}=FB();
    const code=genCode(), hostId=genId();
    await set(_ref(`${PATH}/${code}`),{
      game:'mentiroso', status:'waiting', mode, pointsToWin,
      round:0, seed:0,
      condKey:null,condType:null,condLabel:null,condUnit:null,condThreshold:null,
      guessCount:0, guesses:null, actualTotal:null, winners:null,
      players:{[hostId]:{name:hostName,score:0,connected:true,isHost:true}},
    });
    return {code,playerId:hostId};
  }

  async function joinRoom(code,playerName) {
    const{get,update}=FB();
    const snap=await get(_ref(`${PATH}/${code}`));
    if(!snap.exists()) throw new Error('Sala no encontrada');
    const room=snap.val();
    if(room.game!=='mentiroso') throw new Error('Esa sala es de otro juego');
    if(room.status!=='waiting') throw new Error('La partida ya ha comenzado');
    const count=Object.keys(room.players||{}).length;
    if(count>=8) throw new Error('Sala llena');
    const playerId=genId();
    await update(_ref(`${PATH}/${code}/players/${playerId}`),{
      name:playerName,score:0,connected:true,isHost:false,
    });
    return {code,playerId};
  }

  function listenRoom(code,cb) {
    const{onValue}=FB();
    return onValue(_ref(`${PATH}/${code}`),snap=>{
      if(!snap.exists()) return;
      cb(snap.val());
    });
  }

  async function startRound(code,roundNum,seed,cond,pointsToWin) {
    const{update}=FB();
    await update(_ref(`${PATH}/${code}`),{
      status:'playing', round:roundNum, seed,
      condKey:cond.key, condType:cond.type, condLabel:cond.label,
      condUnit:cond.unit||'', condThreshold:cond.threshold??null,
      guessCount:0, guesses:null, actualTotal:null, winners:null,
      pointsToWin,
    });
  }

  async function submitGuess(code,playerId,guess) {
    const{update,runTransaction}=FB();
    await update(_ref(`${PATH}/${code}/guesses/${playerId}`),{'.sv':'timestamp'});
    await update(_ref(`${PATH}/${code}`),{[`guesses/${playerId}`]:guess});
    const res=await runTransaction(_ref(`${PATH}/${code}/guessCount`),cur=>(cur||0)+1);
    return res.snapshot.val();
  }

  async function triggerReveal(code,actualTotal,winnerNames,updatedScores) {
    const{update}=FB();
    const batch={
      [`${PATH}/${code}/status`]:'reveal',
      [`${PATH}/${code}/actualTotal`]:actualTotal,
      [`${PATH}/${code}/winners`]:winnerNames,
    };
    for(const[pid,score] of Object.entries(updatedScores)){
      batch[`${PATH}/${code}/players/${pid}/score`]=score;
    }
    await update(_ref('/'),batch);
  }

  async function setFinished(code,winnerName,updatedScores) {
    const{update}=FB();
    const batch={[`${PATH}/${code}/status`]:'finished',[`${PATH}/${code}/winnerName`]:winnerName};
    for(const[pid,score] of Object.entries(updatedScores)) batch[`${PATH}/${code}/players/${pid}/score`]=score;
    await update(_ref('/'),batch);
  }

  async function disconnect(code,playerId) {
    const{get,update,remove:rm}=FB();
    try{
      const snap=await get(_ref(`${PATH}/${code}`));
      if(!snap.exists())return;
      const room=snap.val();
      if(room.status==='waiting'){
        await rm(_ref(`${PATH}/${code}/players/${playerId}`));
        const remaining=Object.keys(room.players||{}).filter(p=>p!==playerId);
        if(!remaining.length){ rm(_ref(`${PATH}/${code}`)).catch(()=>{}); return; }
        if(room.players[playerId]?.isHost){
          await update(_ref(`${PATH}/${code}/players/${remaining[0]}`),{isHost:true});
        }
      } else {
        await update(_ref(`${PATH}/${code}/players/${playerId}`),{connected:false});
      }
    }catch(e){console.warn('disconnect error',e);}
  }

  async function getRoom(code) {
    const{get}=FB();
    const snap=await get(_ref(`${PATH}/${code}`));
    return snap.exists()?snap.val():null;
  }

  async function updateSettings(code,settings) {
    const{update}=FB();
    await update(_ref(`${PATH}/${code}`),settings);
  }

  async function skipPlayerGuess(code,playerId) {
    return submitGuess(code,playerId,0);
  }

  return {createRoom,joinRoom,listenRoom,startRound,submitGuess,triggerReveal,
          setFinished,disconnect,getRoom,updateSettings,skipPlayerGuess};
})();

/* ═══ 5. APP ═══════════════════════════════════════════════ */
let _roomCode=null, _playerId=null, _isHost=false, _unsubRoom=null;
let _lastRoom=null, _pointsDraft=3, _modeDraft='easy';
let _submitted=false, _revealTriggered=false;
let _guessDraft=0, _skipTimer=null;

function _saveSession(){try{sessionStorage.setItem('mentiroso_s',JSON.stringify({code:_roomCode,pid:_playerId}))}catch{}}
function _clearSession(){try{sessionStorage.removeItem('mentiroso_s')}catch{}}

function _resetState() {
  _roomCode=null;_playerId=null;_isHost=false;_lastRoom=null;
  _submitted=false;_revealTriggered=false;_guessDraft=0;
  clearTimeout(_skipTimer);_skipTimer=null;
  if(_unsubRoom){_unsubRoom();_unsubRoom=null;}
  _clearSession();
}

/* — Añadir stats extra que están en los datos pero no en las definiciones — */
function _ensureExtraStats() {
  if(!Array.isArray(window.STAT_DEFINITIONS))return;
  const extra=[
    {key:'played_barcelona_chelsea',label:'han pasado por Barcelona y Chelsea',unit:'SI/NO',type:'bool'},
    {key:'played_real_juventus',label:'han pasado por Real Madrid y Juventus',unit:'SI/NO',type:'bool'},
    {key:'played_psg_barcelona',label:'han pasado por PSG y Barcelona',unit:'SI/NO',type:'bool'},
    {key:'played_bayern_dortmund',label:'han pasado por Bayern y Dortmund',unit:'SI/NO',type:'bool'},
  ];
  const has=new Set(window.STAT_DEFINITIONS.map(d=>d.key));
  extra.forEach(d=>{if(!has.has(d.key))window.STAT_DEFINITIONS.push(d);});
}

/* — Room update callback — */
function _onRoomUpdate(room) {
  _lastRoom=room;
  if(!room||!room.players) return;
  if(!room.players[_playerId]){
    toast('Has sido expulsado de la sala','error');
    _resetState(); showScreen('#screen-menu'); return;
  }
  _isHost=room.players[_playerId]?.isHost===true;

  switch(room.status) {
    case 'waiting': _renderLobby(room); break;
    case 'playing': _renderGame(room); break;
    case 'reveal':  _renderReveal(room); break;
    case 'finished':_renderFinished(room); break;
  }
}

/* ═══ RENDER LOBBY ═════════════════════════════════════════ */
function _renderLobby(room) {
  showScreen('#screen-lobby');
  $('#lobby-code').textContent=_roomCode;
  $('#lobby-mode-pill').textContent=room.mode==='easy'?'FACIL':'DIFICIL';
  const players=Object.entries(room.players||{});
  $('#lobby-count').textContent=`(${players.length})`;

  const list=$('#lobby-players'); list.innerHTML='';
  players.forEach(([pid,p])=>{
    const div=document.createElement('div'); div.className='lobby-player-row';
    div.innerHTML=`
      <span class="lp-avatar">${escapeHtml((p.name||'?')[0].toUpperCase())}</span>
      <span class="lp-name">${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span>
      ${p.isHost?'<span class="lp-host">HOST</span>':''}
    `;
    list.appendChild(div);
  });

  const btn=$('#btn-start');
  btn.disabled=!_isHost||players.length<2;

  /* Points controls */
  const ctrlHost=$('#lobby-points-controls');
  const ctrlRead=$('#lobby-points-readonly');
  if(_isHost){ctrlHost.classList.remove('hidden');ctrlRead.classList.add('hidden');$('#lobby-points-value').textContent=room.pointsToWin;}
  else{ctrlHost.classList.add('hidden');ctrlRead.classList.remove('hidden');$('#lobby-points-value-readonly').textContent=room.pointsToWin;}

  const hint=$('#lobby-hint');
  if(players.length<2) hint.textContent='Se necesitan al menos 2 jugadores.';
  else if(_isHost) hint.textContent=`Gana quien llegue a ${room.pointsToWin} rondas acertadas.`;
  else hint.textContent='Esperando a que el host inicie la partida.';
}

/* ═══ RENDER GAME ══════════════════════════════════════════ */
function _renderGame(room) {
  showScreen('#screen-game');
  $('#overlay-reveal').classList.add('hidden');
  $('#overlay-gameover').classList.add('hidden');
  _revealTriggered=false;

  /* Header */
  const cond=_getCondition(room);
  $('#game-round').textContent=String(room.round);
  $('#game-round-stat').textContent=(cond.label||'').toUpperCase();
  $('#game-code').textContent=_roomCode;

  /* Deal determinista */
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const myHand=deal.hands[_playerId]||[];
  const centerCards=deal.centerCards;

  /* Turn ring */
  const order=getPlayerOrder(room);
  const guesses=room.guesses||{};
  const currentTurnId=getCurrentTurnId(room);
  const ring=$('#turn-ring'); ring.innerHTML='';
  order.forEach(pid=>{
    const p=room.players[pid]; if(!p)return;
    const chip=document.createElement('div');
    const isActive=pid===currentTurnId;
    chip.className=`turn-chip${isActive?' active':''}${pid===_playerId?' me':''}`;
    const g=guesses[pid];
    chip.innerHTML=`
      <span>${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span>
      <span class="tc-count">${p.score||0} pt</span>
      <span class="tc-guess">${g!==undefined&&g!==null?`dice ${g}`:'...'}</span>
      ${_isHost&&pid!==_playerId?'<button class="tc-kick" title="Quitar">×</button>':''}
    `;
    const kick=chip.querySelector('.tc-kick');
    if(kick) kick.addEventListener('click',e=>{e.stopPropagation();_kickPlayer(pid,p.name);});
    ring.appendChild(chip);
  });

  /* Center cards */
  const centerEl=$('#center-cards'); centerEl.innerHTML='';
  if(!centerCards.length) centerEl.innerHTML='<div class="empty-inline">Sin cartas en el centro</div>';
  else centerCards.forEach(c=>centerEl.appendChild(renderCard(c,{mode:'center',cond})));

  /* Bets */
  $('#bet-round-note').textContent=`Objetivo: ${room.pointsToWin} puntos`;
  const betEl=$('#bet-current'); betEl.innerHTML='';
  order.forEach(pid=>{
    const p=room.players[pid]||{}; const g=guesses[pid];
    betEl.innerHTML+=`<div class="guess-row${g===undefined||g===null?' waiting':''}"><span>${escapeHtml(p.name)}</span><span>${g!==undefined&&g!==null?g:'...'}</span></div>`;
  });

  /* My hand */
  const handEl=$('#my-hand'); handEl.innerHTML='';
  myHand.forEach(c=>handEl.appendChild(renderCard(c,{mode:room.mode==='easy'?'own-easy':'own-hard',cond})));
  $('#my-hand-note').textContent=room.mode==='easy'?'Verde = esta carta cumple la condicion':'Solo ves nombre y rasgos visibles';

  /* Action bar */
  const isMyTurn=currentTurnId===_playerId;
  const totalCards=myHand.length*sortedIds.length+centerCards.length;
  if(isMyTurn && !_submitted){
    $('#action-panel').classList.remove('hidden');
    $('#action-waiting').classList.add('hidden');
    _guessDraft=Math.min(_guessDraft,totalCards);
    $('#step-guess').textContent=_guessDraft;
    $('#guess-max').textContent=totalCards;
    $('#action-panel-label').textContent='TU TURNO';
    clearTimeout(_skipTimer);
  } else {
    $('#action-panel').classList.add('hidden');
    $('#action-waiting').classList.remove('hidden');
    /* Skip timer para host */
    if(_isHost && currentTurnId && currentTurnId!==_playerId) _armSkip(currentTurnId);
  }

  /* Check if all guessed → host triggers reveal */
  if(_isHost && !_revealTriggered && allGuessed(room)){
    _revealTriggered=true;
    _doReveal(room);
  }
}

function _armSkip(pid) {
  clearTimeout(_skipTimer);
  _skipTimer=setTimeout(()=>{
    $$('.turn-chip.active').forEach(ch=>{
      ch.classList.add('overdue');
      if(!ch.querySelector('.tc-skip')){
        const btn=document.createElement('button');btn.className='tc-skip';btn.textContent='Saltar';
        btn.addEventListener('click',e=>{e.stopPropagation();_skipTurn(pid);});
        ch.appendChild(btn);
      }
    });
  },45000);
}

async function _doReveal(room) {
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const cond=_getCondition(room);
  let actualTotal=0;
  deal.deck.forEach(c=>{if(cardMatchesCond(c,cond))actualTotal++;});
  const guesses=room.guesses||{};
  const winnerNames=[];
  const scores={};
  Object.entries(room.players).forEach(([pid,p])=>{
    let sc=p.score||0;
    if(guesses[pid]===actualTotal){winnerNames.push(p.name);sc++;}
    scores[pid]=sc;
  });
  /* Check if someone won the game */
  const maxScore=Math.max(...Object.values(scores));
  const leaders=Object.entries(scores).filter(([,s])=>s>=room.pointsToWin&&s===maxScore);
  if(leaders.length===1){
    const[winnerId]=leaders[0];
    await Sync.setFinished(_roomCode,room.players[winnerId].name,scores);
  } else {
    await Sync.triggerReveal(_roomCode,actualTotal,winnerNames.length?winnerNames:['Nadie acertó'],scores);
  }
}

/* ═══ RENDER REVEAL ════════════════════════════════════════ */
function _renderReveal(room) {
  showScreen('#screen-game');
  _submitted=false;
  const overlay=$('#overlay-reveal'); overlay.classList.remove('hidden');

  const cond=_getCondition(room);
  const guesses=room.guesses||{};
  const actual=room.actualTotal;
  const winners=room.winners||[];

  if(winners.length&&winners[0]!=='Nadie acertó'){
    $('#reveal-tag').textContent='ACIERTO EXACTO';
    $('#reveal-headline').textContent=winners.join(', ');
    $('#reveal-sub').textContent=`${winners.length===1?'Ha':'Han'} clavado el total exacto`;
  } else {
    $('#reveal-tag').textContent='NADIE ACERTÓ';
    $('#reveal-headline').textContent='—';
    $('#reveal-sub').textContent='Ningún jugador acertó el total exacto';
  }
  $('#reveal-count').textContent=actual;

  const guessesEl=$('#reveal-guesses'); guessesEl.innerHTML='';
  Object.entries(room.players).forEach(([pid,p])=>{
    const g=guesses[pid]??'—';
    const hit=Number(g)===actual;
    guessesEl.innerHTML+=`<div class="guess-row${hit?' hit':''}""><span>${escapeHtml(p.name)}</span><span>${g}${hit?' ✓':''}</span></div>`;
  });

  /* Reveal cards */
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const cardsEl=$('#reveal-cards'); cardsEl.innerHTML='';
  deal.deck.forEach(c=>{
    c.matches=cardMatchesCond(c,cond);
    cardsEl.appendChild(renderCard(c,{mode:'reveal',cond}));
  });

  $('#reveal-verdict').textContent=cond.label;
  const contBtn=$('#btn-continue');
  if(_isHost){contBtn.classList.remove('hidden');}else{contBtn.classList.add('hidden');}
}

/* ═══ RENDER FINISHED ══════════════════════════════════════ */
function _renderFinished(room) {
  showScreen('#screen-game');
  const overlay=$('#overlay-gameover'); overlay.classList.remove('hidden');
  $('#winner-name').textContent=room.winnerName||'—';
  const sb=$('#winner-scoreboard'); sb.innerHTML='';
  Object.entries(room.players||{}).sort((a,b)=>(b[1].score||0)-(a[1].score||0)).forEach(([,p])=>{
    sb.innerHTML+=`<div class="guess-row"><span>${escapeHtml(p.name)}</span><span>${p.score||0} pt</span></div>`;
  });
}

/* ═══ RENDER CARD ══════════════════════════════════════════ */
function renderCard(card,opts) {
  const el=document.createElement('div'); el.className='card';
  const{mode,cond}=opts;
  const isCenter=mode==='center';
  const photoUrl=`https://tmssl.akamaized.net/images/foto/small/${card.playerId}.jpg`;
  const ini=(card.playerName||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

  let hintHtml='';
  if(isCenter){
    let icon,lbl,typ;
    if(card.visibleAttr==='flag'){typ='País';icon=`<div class="hint-flag">${countryFlagHTML(card.country,card.countryFlag)}</div>`;lbl=card.country;}
    else if(card.visibleAttr==='position'){typ='Posición';icon=`<div class="hint-pos">${escapeHtml(card.position)}</div>`;lbl=card.position;}
    else{typ='Club';icon=`<div class="hint-badge">${clubBadgeHTML(card.club,36)}</div>`;lbl=card.club;}
    hintHtml=`<div class="card-hint-overlay"><span class="card-hint-type">${escapeHtml(typ)}</span>${icon}<span class="card-hint-label">${escapeHtml((lbl||'').toUpperCase())}</span></div>`;
  }

  const photoHtml=`<div class="card-photo-wrap${isCenter?' center-photo':''}"><img class="card-photo-img" src="${photoUrl}" loading="lazy" alt="" onerror="this.closest('.card-photo-wrap').classList.add('no-photo')"><div class="card-photo-fallback">${escapeHtml(ini)}</div>${isCenter?hintHtml:`<div class="card-photo-name">${escapeHtml(card.playerName)}</div>`}</div>`;
  const identHtml=isCenter?'':`<div class="card-identity">${countryFlagHTML(card.country,card.countryFlag)}${clubBadgeHTML(card.club)}</div>`;

  let statHtml='';
  if(mode==='own-easy'){
    const raw=card.stats[cond.key]; const matches=cardMatchesCond(card,cond);
    const disp=cond.type==='bool'?(raw?'SI':'NO'):raw;
    const badge=document.createElement('div');badge.className=`card-badge ${matches?'ok':'ko'}`;badge.textContent=matches?'OK':'NO';
    el.appendChild(badge);
    statHtml=`<div class="card-stat"><span>${escapeHtml(cond.type==='bool'?cond.label:cond.unit)}</span><span class="card-stat-val">${escapeHtml(String(disp??0))}</span></div>`;
  } else if(mode==='own-hard'||isCenter){
    statHtml='<div class="card-stat hidden-stat">OCULTO</div>';
  } else if(mode==='reveal'){
    const raw=card.stats[cond.key]; const matches=card.matches;
    const disp=cond.type==='bool'?(raw?'SI':'NO'):raw;
    const badge=document.createElement('div');badge.className=`card-badge ${matches?'ok':'ko'}`;badge.textContent=matches?'OK':'NO';
    el.appendChild(badge);
    el.classList.add('revealed',matches?'match':'nomatch');
    statHtml=`<div class="card-stat"><span>${escapeHtml(cond.type==='bool'?cond.label:cond.unit)}</span><span class="card-stat-val">${escapeHtml(String(disp??0))}</span></div>`;
  }
  el.innerHTML+=photoHtml+identHtml+statHtml;
  return el;
}

/* ═══ HELPERS ══════════════════════════════════════════════ */
function _getCondition(room) {
  return {key:room.condKey,type:room.condType,label:room.condLabel,unit:room.condUnit||'',threshold:room.condThreshold??null};
}

async function _kickPlayer(pid,name) {
  if(!confirm(`¿Quitar a ${name}?`))return;
  const{remove:rm}=window._FB;
  try{
    await rm(window._FB.ref(window._FB.db,`restricciones/rooms/${_roomCode}/players/${pid}`));
    toast(`${name} eliminado`,'info');
  }catch(e){toast('Error al expulsar','error');}
}

async function _skipTurn(pid) {
  try{await Sync.skipPlayerGuess(_roomCode,pid);toast('Turno saltado','info');}
  catch(e){toast('Error al saltar turno','error');}
}

/* ═══ UI ACTIONS ═══════════════════════════════════════════ */
async function _createRoom() {
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  const name=($('#create-name').value||'').trim();
  if(!name){toast('Escribe tu nombre','error');return;}
  try{
    const{code,playerId}=await Sync.createRoom(name,_modeDraft,_pointsDraft);
    _roomCode=code;_playerId=playerId;_isHost=true;_submitted=false;
    _saveSession();
    _unsubRoom=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){toast(e.message,'error');}
}

async function _joinRoom() {
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  const name=($('#join-name').value||'').trim();
  const code=($('#join-code').value||'').trim().toUpperCase();
  if(!name){toast('Escribe tu nombre','error');return;}
  if(code.length<4){toast('Código inválido','error');return;}
  try{
    const res=await Sync.joinRoom(code,name);
    _roomCode=res.code;_playerId=res.playerId;_isHost=false;_submitted=false;
    _saveSession();
    _unsubRoom=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){
    $('#join-error').textContent=e.message;$('#join-error').classList.remove('hidden');
  }
}

async function _startGame() {
  if(!_isHost||!_roomCode||!_lastRoom)return;
  const sortedIds=Object.keys(_lastRoom.players).sort();
  const seed=Date.now()+Math.floor(Math.random()*100000);
  const deal=dealRound(seed,sortedIds);
  try{await Sync.startRound(_roomCode,1,seed,deal.condition,_lastRoom.pointsToWin);}
  catch(e){toast('Error al iniciar: '+e.message,'error');}
}

async function _submitGuess() {
  if(!_roomCode||_submitted)return;
  const room=_lastRoom; if(!room)return;
  const currentId=getCurrentTurnId(room);
  if(currentId!==_playerId){toast('No es tu turno','error');return;}
  _submitted=true;
  try{
    const count=await Sync.submitGuess(_roomCode,_playerId,_guessDraft);
    /* Host checks if all guessed */
    const connected=Object.entries(room.players).filter(([,p])=>p.connected!==false).length;
    if(_isHost&&!_revealTriggered&&count>=connected){
      _revealTriggered=true;
      const fresh=await Sync.getRoom(_roomCode);
      if(fresh) _doReveal(fresh);
    }
  }catch(e){toast(e.message,'error');_submitted=false;}
}

async function _continueRound() {
  if(!_isHost||!_roomCode||!_lastRoom)return;
  const room=_lastRoom;
  const nextRound=(room.round||0)+1;
  const sortedIds=Object.keys(room.players).sort();
  const seed=Date.now()+nextRound*7919;
  const deal=dealRound(seed,sortedIds);
  try{await Sync.startRound(_roomCode,nextRound,seed,deal.condition,room.pointsToWin);}
  catch(e){toast('Error: '+e.message,'error');}
}

async function _leaveRoom() {
  if(_roomCode&&_playerId){
    try{await Sync.disconnect(_roomCode,_playerId);}catch{}
  }
  _resetState();
  showScreen('#screen-menu');
}

/* ═══ 6. BOOT ═════════════════════════════════════════════ */
function boot() {
  if(!window._FB?.configured) console.warn('Firebase no disponible');
  if(!window.PLAYERS||!window.PLAYERS.length) { toast('Faltan datos de jugadores','error'); return; }
  _ensureExtraStats();

  /* Tabs */
  $$('.menu-tab').forEach(tab=>tab.addEventListener('click',()=>{
    $$('.menu-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    $$('.menu-panel').forEach(p=>p.classList.remove('active'));
    $(`.menu-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
  }));

  /* Mode toggle */
  $$('.mode-opt').forEach(btn=>btn.addEventListener('click',()=>{
    $$('.mode-opt').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _modeDraft=btn.dataset.mode;
  }));

  /* Points stepper (menu) */
  $('#btn-points-minus')?.addEventListener('click',()=>{
    _pointsDraft=Math.max(1,_pointsDraft-1);
    $('#create-points-value').textContent=_pointsDraft;
  });
  $('#btn-points-plus')?.addEventListener('click',()=>{
    _pointsDraft=Math.min(10,_pointsDraft+1);
    $('#create-points-value').textContent=_pointsDraft;
  });
  /* Points stepper (lobby, host only) */
  $('#btn-lobby-points-minus')?.addEventListener('click',async()=>{
    if(!_isHost||!_roomCode)return;
    const v=Math.max(1,(_lastRoom?.pointsToWin||3)-1);
    try{await Sync.updateSettings(_roomCode,{pointsToWin:v});}catch{}
  });
  $('#btn-lobby-points-plus')?.addEventListener('click',async()=>{
    if(!_isHost||!_roomCode)return;
    const v=Math.min(10,(_lastRoom?.pointsToWin||3)+1);
    try{await Sync.updateSettings(_roomCode,{pointsToWin:v});}catch{}
  });

  /* Buttons */
  $('#btn-create').addEventListener('click',_createRoom);
  $('#btn-join').addEventListener('click',_joinRoom);
  $('#btn-start').addEventListener('click',_startGame);
  $('#btn-guess').addEventListener('click',_submitGuess);
  $('#btn-continue').addEventListener('click',_continueRound);
  $('#btn-menu').addEventListener('click',_leaveRoom);
  $('#btn-copy-code')?.addEventListener('click',()=>{
    navigator.clipboard?.writeText(_roomCode||'').then(()=>toast('Código copiado','success')).catch(()=>{});
  });

  /* Guess stepper */
  $('#guess-minus')?.addEventListener('click',()=>{
    _guessDraft=Math.max(0,_guessDraft-1); $('#step-guess').textContent=_guessDraft;
  });
  $('#guess-plus')?.addEventListener('click',()=>{
    const max=Number($('#guess-max').textContent)||0;
    _guessDraft=Math.min(max,_guessDraft+1); $('#step-guess').textContent=_guessDraft;
  });

  /* Leave lobby */
  $('[data-action="leave-lobby"]')?.addEventListener('click',_leaveRoom);

  /* Beforeunload — solo en lobby */
  window.addEventListener('beforeunload',()=>{
    if(!_roomCode||!_playerId||!_lastRoom)return;
    if(_lastRoom.status==='waiting') Sync.disconnect(_roomCode,_playerId).catch(()=>{});
  });

  /* URL param */
  const params=new URLSearchParams(window.location.search);
  const salaParam=params.get('sala');
  if(salaParam){
    $('#join-code').value=salaParam;
    $$('.menu-tab').forEach(t=>t.classList.remove('active'));
    $(`.menu-tab[data-tab="join"]`)?.classList.add('active');
    $$('.menu-panel').forEach(p=>p.classList.remove('active'));
    $(`.menu-panel[data-panel="join"]`)?.classList.add('active');
  }

  /* Session restore */
  try{
    const s=JSON.parse(sessionStorage.getItem('mentiroso_s')||'null');
    if(s&&s.code&&s.pid){
      _roomCode=s.code;_playerId=s.pid;
      _unsubRoom=Sync.listenRoom(s.code,_onRoomUpdate);
      return; /* no mostramos menú, el listener mostrará la pantalla correcta */
    }
  }catch{}

  $('#create-points-value').textContent=_pointsDraft;
  showScreen('#screen-menu');
}

boot();
