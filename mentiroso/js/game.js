/* ═══════════════════════════════════════════════════════════
   GAME.JS — EL MENTIROSO  (reescrito limpio v8)
   - Arquitectura del juego "Restricciones": set/update flat
   - Cartas repartidas localmente por seed (deterministas)
   - Turno DERIVADO de las apuestas (sin estado que sincronizar)
   - MODO PRÁCTICA vs bots (para probar sin Firebase ni 2 PCs)
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ═══ 1. HELPERS ═══════════════════════════════════════════ */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function escapeHtml(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML;}

let _toastTimer=null;
function toast(msg,type){const el=$('#toast');if(!el)return;el.textContent=msg;el.className=`toast show ${type||''}`;clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>el.classList.remove('show'),2800);}
function showScreen(id){$$('.screen').forEach(s=>s.classList.remove('active'));$(id)?.classList.add('active');}
function genCode(n=6){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');}
function genId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36);}

/* ═══ 2. BANDERAS + ESCUDOS ════════════════════════════════ */
const COUNTRY_ISO={'Albania':'AL','Algeria':'DZ','Argentina':'AR','Armenia':'AM','Australia':'AU','Austria':'AT','Belarus':'BY','Belgium':'BE','Benin':'BJ','Bolivia':'BO','Bosnia-Herzegovina':'BA','Brazil':'BR','Bulgaria':'BG','Cameroon':'CM','Canada':'CA','Chile':'CL','China':'CN','Colombia':'CO','Congo':'CG','Costa':'CR','Cote':'CI',"Cote d'Ivoire":'CI','Croatia':'HR','Curacao':'CW','Cyprus':'CY','Czech':'CZ','Denmark':'DK','Ecuador':'EC','Egypt':'EG','Estonia':'EE','Finland':'FI','France':'FR','Gabon':'GA','Georgia':'GE','Germany':'DE','Ghana':'GH','Greece':'GR','Guinea':'GN','Haiti':'HT','Honduras':'HN','Hungary':'HU','Iceland':'IS','Iran':'IR','Iraq':'IQ','Ireland':'IE','Israel':'IL','Italy':'IT','Jamaica':'JM','Japan':'JP','Kazakhstan':'KZ','Korea,':'KR','Korea, South':'KR','Kosovo':'XK','Latvia':'LV','Lebanon':'LB','Lithuania':'LT','Luxembourg':'LU','Mali':'ML','Mexico':'MX','Moldova':'MD','Montenegro':'ME','Morocco':'MA','Netherlands':'NL','Nigeria':'NG','Norway':'NO','Panama':'PA','Paraguay':'PY','Peru':'PE','Poland':'PL','Portugal':'PT','Qatar':'QA','Romania':'RO','Russia':'RU','Senegal':'SN','Serbia':'RS','Slovakia':'SK','Slovenia':'SI','South':'ZA','Spain':'ES','Suriname':'SR','Sweden':'SE','Switzerland':'CH','Tanzania':'TZ','Thailand':'TH','Togo':'TG','Trinidad':'TT','Tunisia':'TN','Türkiye':'TR','Ukraine':'UA','United':'US','United States':'US','Uruguay':'UY','Uzbekistan':'UZ','Venezuela':'VE','Zambia':'ZM','Zimbabwe':'ZW'};
const COUNTRY_SPECIAL={'England':'fi-gb-eng','Scotland':'fi-gb-sct','Wales':'fi-gb-wls','Northern Ireland':'fi-gb-nir'};
function countryFlagHTML(country,fb){
  if(!country)return `<span class="card-flag-text">${escapeHtml(fb||'')}</span>`;
  if(COUNTRY_SPECIAL[country])return `<span class="fi ${COUNTRY_SPECIAL[country]}" title="${escapeHtml(country)}"></span>`;
  const iso=COUNTRY_ISO[country];
  if(iso)return `<span class="fi fi-${iso.toLowerCase()}" title="${escapeHtml(country)}"></span>`;
  return `<span class="card-flag-text">${escapeHtml(fb||country.slice(0,2).toUpperCase())}</span>`;
}
const CLUB_TM={'Bayern Munich':27,'Inter Milan':46,'FC Barcelona':131,'AC Milan':5,'Arsenal FC':11,'Real Madrid':418,'Liverpool FC':31,'Manchester City':281,'Aston Villa':405,'SSC Napoli':6195,'Tottenham Hotspur':148,'Newcastle United':762,'Galatasaray':141,'Manchester United':985,'AS Roma':12,'Atalanta BC':800,'Atlético de Madrid':13,'Juventus FC':506,'Santos FC':4843,'Borussia Dortmund':16,'Chelsea FC':631,'Al-Nassr FC':52908,'Inter Miami CF':53537,'Girona FC':12321,'Bayer 04 Leverkusen':15,'SL Benfica':294,'Ajax Amsterdam':610,'West Ham United':379,'Villarreal CF':1050,'ACF Fiorentina':430,'AFC Bournemouth':989,'Al-Hilal SFC':52918,'Sevilla FC':368,'Paris Saint-Germain':583,'PSV Eindhoven':383,'RB Leipzig':23826,'Real Sociedad':681,'Valencia CF':1049,'Athletic Club':621,'AS Monaco':162,'Sporting CP':336,'FC Porto':720,'CF Monterrey':3716,'Al-Ittihad':45221};
function clubBadgeHTML(name,sz){
  sz=sz||18;const id=CLUB_TM[name];
  const ini=((name||'').replace(/\b(FC|CF|SC|AFC|SL|CA|AS|SS|SSC|AC|ACF|CR|RB)\b/gi,'').trim().split(/\s+/).filter(Boolean).map(w=>w[0]).join('').slice(0,3).toUpperCase())||'?';
  const t=escapeHtml(name||'');
  if(id)return `<img class="card-club-logo" style="width:${sz}px;height:${sz}px" src="https://tmssl.akamaized.net/images/wappen/small/${id}.png" loading="lazy" alt="${t}" title="${t}" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="card-club-initials" title="${t}" style="display:none">${ini}</span>`;
  return `<span class="card-club-initials" title="${t}">${ini}</span>`;
}

/* ═══ 3. CARTAS DETERMINISTAS ══════════════════════════════ */
function mulberry32(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=t+Math.imul(t^(t>>>7),61|t)^t;return ((t^(t>>>14))>>>0)/4294967296;};}
function shuffleRng(arr,rng){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

const HAND_CONFIG=[{min:1,max:2,hand:7,center:4},{min:3,max:3,hand:5,center:4},{min:4,max:4,hand:4,center:4},{min:5,max:5,hand:3,center:3},{min:6,max:10,hand:2,center:0}];
function getHandConfig(n){return HAND_CONFIG.find(c=>c.min<=n&&n<=c.max)||HAND_CONFIG[0];}
const CENTER_ATTRS=['flag','position','club'];

function createCard(p){return {playerId:p.id,playerName:p.name,country:p.country,countryFlag:p.countryFlag,club:p.club,clubBadge:p.clubBadge,position:p.position,stats:p.stats||{}};}

const _threshCache={};
function getThresholds(key){
  if(_threshCache[key])return _threshCache[key];
  const vals=window.PLAYERS.map(p=>Number(p.stats[key])||0).filter(v=>v>0).sort((a,b)=>a-b);
  if(!vals.length)return _threshCache[key]=[];
  const set=new Set();[0.25,0.5,0.75].forEach(q=>{const v=vals[Math.floor(q*vals.length)];if(v>0)set.add(v);});
  return _threshCache[key]=[...set].sort((a,b)=>a-b);
}
function cardMatchesCond(card,cond){
  const v=card.stats[cond.key];
  if(cond.type==='bool')return Boolean(v);
  return Number(v||0)>(cond.threshold||0);
}
function chooseCondition(deck,rng){
  const defs=window.STAT_DEFINITIONS;
  for(let i=0;i<40;i++){
    const def=defs[Math.floor(rng()*defs.length)];
    let threshold=null,label=def.label;
    if(def.type==='number'){
      const opts=getThresholds(def.key);
      if(!opts.length)continue;
      threshold=opts[Math.floor(rng()*opts.length)];
      label=`Mas de ${threshold} ${def.unit}`;
    }
    const cond={key:def.key,type:def.type,label,unit:def.unit||'',threshold};
    const m=deck.reduce((n,c)=>n+(cardMatchesCond(c,cond)?1:0),0);
    if(m>=1&&m<deck.length)return cond;
  }
  const def=defs.find(d=>d.type==='bool')||defs[0];
  return {key:def.key,type:def.type,label:def.label,unit:def.unit||'',threshold:null};
}
function dealRound(seed,sortedIds){
  const rng=mulberry32(seed);
  const n=sortedIds.length;
  const cfg=getHandConfig(n);
  const total=cfg.center+n*cfg.hand;
  const deck=shuffleRng(window.PLAYERS,rng).slice(0,total).map(createCard);
  let idx=0;const hands={};
  sortedIds.forEach(pid=>{hands[pid]=deck.slice(idx,idx+cfg.hand);idx+=cfg.hand;});
  const centerCards=deck.slice(idx).map(c=>({...c,visibleAttr:CENTER_ATTRS[Math.floor(rng()*3)]}));
  const condition=chooseCondition(deck,rng);
  return {hands,centerCards,condition,deck};
}

/* ═══ TURNO derivado ═══════════════════════════════════════ */
function getPlayerOrder(room){
  const ids=Object.keys(room.players||{}).sort();
  if(!ids.length)return[];
  const shift=((room.round||1)-1)%ids.length;
  return [...ids.slice(shift),...ids.slice(0,shift)];
}
function getCurrentTurnId(room){
  const g=room.guesses||{};
  return getPlayerOrder(room).find(pid=>{
    const p=room.players[pid];
    if(p&&p.connected===false)return false;
    return g[pid]===undefined||g[pid]===null;
  })||null;
}
function allGuessed(room){
  const g=room.guesses||{};
  return Object.entries(room.players||{}).filter(([,p])=>p.connected!==false).every(([id])=>g[id]!==undefined&&g[id]!==null);
}

/* ═══ 4. SYNC (Firebase) ═══════════════════════════════════ */
const Sync=(()=>{
  const PATH='restricciones/rooms';
  const FB=()=>window._FB;
  const _ref=p=>{const{db,ref}=FB();return ref(db,p);};

  async function createRoom(hostName,mode,pointsToWin){
    const{set}=FB();
    const code=genCode(),hostId=genId();
    await set(_ref(`${PATH}/${code}`),{
      game:'mentiroso',status:'waiting',mode,pointsToWin,round:0,seed:0,
      condKey:null,condType:null,condLabel:null,condUnit:null,condThreshold:null,
      actualTotal:null,winners:null,winnerName:null,guesses:null,
      players:{[hostId]:{name:hostName,score:0,connected:true,isHost:true}},
    });
    return {code,playerId:hostId};
  }
  async function joinRoom(code,playerName){
    const{get,update}=FB();
    const snap=await get(_ref(`${PATH}/${code}`));
    if(!snap.exists())throw new Error('Sala no encontrada');
    const room=snap.val();
    if(room.game!=='mentiroso')throw new Error('Esa sala es de otro juego');
    if(room.status!=='waiting')throw new Error('La partida ya ha comenzado');
    if(Object.keys(room.players||{}).length>=8)throw new Error('Sala llena');
    const playerId=genId();
    await update(_ref(`${PATH}/${code}/players/${playerId}`),{name:playerName,score:0,connected:true,isHost:false});
    return {code,playerId};
  }
  function listenRoom(code,cb){
    const{onValue}=FB();
    return onValue(_ref(`${PATH}/${code}`),snap=>{if(snap.exists())cb(snap.val());});
  }
  async function startRound(code,roundNum,seed,cond,pointsToWin){
    const{update}=FB();
    await update(_ref(`${PATH}/${code}`),{
      status:'playing',round:roundNum,seed,
      condKey:cond.key,condType:cond.type,condLabel:cond.label,condUnit:cond.unit||'',condThreshold:cond.threshold??null,
      guesses:null,actualTotal:null,winners:null,pointsToWin,
    });
  }
  async function submitGuess(code,playerId,guess){
    const{update}=FB();
    /* Una sola escritura: el número de la apuesta. La presencia = ha apostado. */
    await update(_ref(`${PATH}/${code}`),{[`guesses/${playerId}`]:guess});
  }
  async function triggerReveal(code,actualTotal,winnerNames,scores){
    const{update}=FB();
    const batch={[`${PATH}/${code}/status`]:'reveal',[`${PATH}/${code}/actualTotal`]:actualTotal,[`${PATH}/${code}/winners`]:winnerNames};
    for(const[pid,sc]of Object.entries(scores))batch[`${PATH}/${code}/players/${pid}/score`]=sc;
    await update(_ref('/'),batch);
  }
  async function setFinished(code,winnerName,scores){
    const{update}=FB();
    const batch={[`${PATH}/${code}/status`]:'finished',[`${PATH}/${code}/winnerName`]:winnerName};
    for(const[pid,sc]of Object.entries(scores))batch[`${PATH}/${code}/players/${pid}/score`]=sc;
    await update(_ref('/'),batch);
  }
  async function disconnect(code,playerId){
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
        await update(_ref(`${PATH}/${code}/players/${playerId}`),{connected:false});
      }
    }catch(e){console.warn('disconnect',e);}
  }
  async function getRoom(code){const{get}=FB();const s=await get(_ref(`${PATH}/${code}`));return s.exists()?s.val():null;}
  async function updateSettings(code,o){const{update}=FB();await update(_ref(`${PATH}/${code}`),o);}
  async function kick(code,pid){const{remove:rm}=FB();await rm(_ref(`${PATH}/${code}/players/${pid}`));}

  return {createRoom,joinRoom,listenRoom,startRound,submitGuess,triggerReveal,setFinished,disconnect,getRoom,updateSettings,kick};
})();

/* ═══ 5. ESTADO APP ════════════════════════════════════════ */
let _roomCode=null,_playerId=null,_isHost=false,_unsub=null,_lastRoom=null;
let _pointsDraft=3,_modeDraft='easy',_botsDraft=2,_guessDraft=0;
let _revealTriggered=false,_skipTimer=null;
let _local=false,_localRoom=null;

function _saveSession(){try{if(!_local)sessionStorage.setItem('mentiroso_s',JSON.stringify({code:_roomCode,pid:_playerId}));}catch{}}
function _clearSession(){try{sessionStorage.removeItem('mentiroso_s');}catch{}}
function _reset(){
  _roomCode=null;_playerId=null;_isHost=false;_lastRoom=null;
  _revealTriggered=false;_guessDraft=0;_local=false;_localRoom=null;
  clearTimeout(_skipTimer);_skipTimer=null;
  if(_unsub){_unsub();_unsub=null;}
  _clearSession();
}
function _getCondition(r){return {key:r.condKey,type:r.condType,label:r.condLabel,unit:r.condUnit||'',threshold:r.condThreshold??null};}
function _ensureExtraStats(){/* compat: las definiciones ya vienen completas en data.js */}

/* ═══ 6. ROUTER DE RENDER ══════════════════════════════════ */
function _onRoomUpdate(room){
  _lastRoom=room;
  if(!room||!room.players)return;
  if(!_local&&!room.players[_playerId]){toast('Has salido de la sala','info');_reset();showScreen('#screen-menu');return;}
  _isHost=_local?true:(room.players[_playerId]?.isHost===true);
  switch(room.status){
    case'waiting':_renderLobby(room);break;
    case'playing':_renderGame(room);break;
    case'reveal':_renderGame(room);_renderReveal(room);break;
    case'finished':_renderGame(room);_renderFinished(room);break;
  }
}

/* ═══ LOBBY ════════════════════════════════════════════════ */
function _renderLobby(room){
  showScreen('#screen-lobby');
  $('#lobby-code').textContent=_roomCode;
  $('#lobby-mode-pill').textContent=room.mode==='easy'?'FACIL':'DIFICIL';
  const players=Object.entries(room.players||{});
  $('#lobby-count').textContent=`(${players.length})`;
  const list=$('#lobby-players');list.innerHTML='';
  players.forEach(([pid,p])=>{
    const d=document.createElement('div');d.className=`lobby-player-row${pid===_playerId?' me':''}`;
    d.innerHTML=`<span class="lobby-player-avatar">${escapeHtml((p.name||'?')[0].toUpperCase())}</span><span class="lobby-player-name">${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span>${p.isHost?'<span class="lobby-player-host">HOST</span>':''}`;
    list.appendChild(d);
  });
  $('#btn-start').disabled=!_isHost||players.length<2;
  const ch=$('#lobby-points-controls'),cr=$('#lobby-points-readonly');
  if(_isHost){ch?.classList.remove('hidden');cr?.classList.add('hidden');if($('#lobby-points-value'))$('#lobby-points-value').textContent=room.pointsToWin;}
  else{ch?.classList.add('hidden');cr?.classList.remove('hidden');if($('#lobby-points-value-readonly'))$('#lobby-points-value-readonly').textContent=room.pointsToWin;}
  const hint=$('#lobby-hint');
  if(players.length<2)hint.textContent='Se necesitan al menos 2 jugadores.';
  else if(_isHost)hint.textContent=`Gana quien llegue a ${room.pointsToWin} aciertos.`;
  else hint.textContent='Esperando a que el host empiece.';
}

/* ═══ GAME ═════════════════════════════════════════════════ */
function _renderGame(room){
  showScreen('#screen-game');
  if(room.status==='playing'){$('#overlay-reveal').classList.add('hidden');$('#overlay-gameover').classList.add('hidden');_revealTriggered=false;}
  const cond=_getCondition(room);
  $('#game-round').textContent=String(room.round);
  $('#game-round-stat').textContent=(cond.label||'').toUpperCase();
  $('#game-code').textContent=_local?'PRACTICA':_roomCode;

  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const myHand=deal.hands[_playerId]||[];
  const centerCards=deal.centerCards;
  const order=getPlayerOrder(room);
  const guesses=room.guesses||{};
  const turnId=getCurrentTurnId(room);

  /* Turn ring */
  const ring=$('#turn-ring');ring.innerHTML='';
  order.forEach(pid=>{
    const p=room.players[pid];if(!p)return;
    const chip=document.createElement('div');
    chip.className=`turn-chip${pid===turnId&&room.status==='playing'?' active':''}${pid===_playerId?' me':''}${p.connected===false?' off':''}`;
    const g=guesses[pid];
    chip.innerHTML=`<span>${escapeHtml(p.name)}${pid===_playerId?' (tu)':''}</span><span class="tc-count">${p.score||0} pt</span><span class="tc-guess">${g!==undefined&&g!==null?`dice ${g}`:'...'}</span>${(_isHost&&!_local&&pid!==_playerId)?'<button class="tc-kick" title="Quitar">×</button>':''}`;
    const k=chip.querySelector('.tc-kick');
    if(k)k.addEventListener('click',e=>{e.stopPropagation();_kick(pid,p.name);});
    ring.appendChild(chip);
  });

  /* Center */
  const ce=$('#center-cards');ce.innerHTML='';
  if(!centerCards.length)ce.innerHTML='<div class="empty-inline">Sin cartas en el centro</div>';
  else centerCards.forEach(c=>ce.appendChild(renderCard(c,{mode:'center',cond})));

  /* Bets list */
  $('#bet-round-note').textContent=`Objetivo: ${room.pointsToWin} pts`;
  const be=$('#bet-current');be.innerHTML='';
  order.forEach(pid=>{const p=room.players[pid]||{};const g=guesses[pid];be.innerHTML+=`<div class="guess-row${g===undefined||g===null?' waiting':''}"><span>${escapeHtml(p.name)}</span><span>${g!==undefined&&g!==null?g:'...'}</span></div>`;});

  /* My hand */
  const he=$('#my-hand');he.innerHTML='';
  myHand.forEach(c=>he.appendChild(renderCard(c,{mode:room.mode==='easy'?'own-easy':'own-hard',cond})));
  $('#my-hand-note').textContent=room.mode==='easy'?'Verde = cumple la condicion':'Solo ves nombre y rasgos visibles';

  /* Action bar */
  const iAmDone=guesses[_playerId]!==undefined&&guesses[_playerId]!==null;
  const isMyTurn=turnId===_playerId;
  const totalCards=myHand.length*sortedIds.length+centerCards.length;
  if(room.status==='playing'&&isMyTurn&&!iAmDone){
    $('#action-panel').classList.remove('hidden');
    $('#action-waiting').classList.add('hidden');
    _guessDraft=Math.min(_guessDraft,totalCards);
    $('#step-guess').textContent=_guessDraft;
    $('#guess-max').textContent=totalCards;
    $('#action-panel-label').textContent='TU TURNO';
    clearTimeout(_skipTimer);
  }else{
    $('#action-panel').classList.add('hidden');
    $('#action-waiting').classList.remove('hidden');
    if(!_local&&_isHost&&room.status==='playing'&&turnId&&turnId!==_playerId)_armSkip(turnId);
  }

  /* Host (online) triggers reveal when all guessed */
  if(!_local&&_isHost&&room.status==='playing'&&!_revealTriggered&&allGuessed(room)){
    _revealTriggered=true;_doRevealOnline(room);
  }
}

function _armSkip(pid){
  clearTimeout(_skipTimer);
  _skipTimer=setTimeout(()=>{
    $$('.turn-chip.active').forEach(ch=>{
      ch.classList.add('overdue');
      if(!ch.querySelector('.tc-skip')){
        const b=document.createElement('button');b.className='tc-skip';b.textContent='Saltar';
        b.addEventListener('click',e=>{e.stopPropagation();Sync.submitGuess(_roomCode,pid,0).catch(()=>{});});
        ch.appendChild(b);
      }
    });
  },45000);
}

function _computeReveal(room){
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const cond=_getCondition(room);
  let total=0;deal.deck.forEach(c=>{if(cardMatchesCond(c,cond))total++;});
  const guesses=room.guesses||{};
  const winners=[],scores={};
  Object.entries(room.players).forEach(([pid,p])=>{
    let sc=p.score||0;
    if(guesses[pid]===total){winners.push(p.name);sc++;}
    scores[pid]=sc;
  });
  return {total,winners,scores};
}
async function _doRevealOnline(room){
  const{total,winners,scores}=_computeReveal(room);
  const max=Math.max(...Object.values(scores));
  const leaders=Object.entries(scores).filter(([,s])=>s>=room.pointsToWin&&s===max);
  try{
    if(leaders.length===1)await Sync.setFinished(_roomCode,room.players[leaders[0][0]].name,scores);
    else await Sync.triggerReveal(_roomCode,total,winners.length?winners:['Nadie acertó'],scores);
  }catch(e){console.warn('reveal',e);}
}

/* ═══ REVEAL ═══════════════════════════════════════════════ */
function _renderReveal(room){
  const ov=$('#overlay-reveal');ov.classList.remove('hidden');
  const cond=_getCondition(room);
  const guesses=room.guesses||{};
  const actual=room.actualTotal;
  const winners=room.winners||[];
  if(winners.length&&winners[0]!=='Nadie acertó'){
    $('#reveal-tag').textContent='ACIERTO EXACTO';
    $('#reveal-headline').textContent=winners.join(', ');
    $('#reveal-sub').textContent=`${winners.length===1?'Ha':'Han'} clavado el total`;
  }else{
    $('#reveal-tag').textContent='NADIE ACERTO';
    $('#reveal-headline').textContent='—';
    $('#reveal-sub').textContent='Ningun jugador acerto el total exacto';
  }
  $('#reveal-count').textContent=actual;
  const ge=$('#reveal-guesses');ge.innerHTML='';
  Object.entries(room.players).forEach(([pid,p])=>{const g=guesses[pid]??'—';const hit=Number(g)===actual;ge.innerHTML+=`<div class="guess-row${hit?' hit':''}"><span>${escapeHtml(p.name)}</span><span>${g}${hit?' ✓':''}</span></div>`;});
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const cardsEl=$('#reveal-cards');cardsEl.innerHTML='';
  deal.deck.forEach(c=>{c.matches=cardMatchesCond(c,cond);cardsEl.appendChild(renderCard(c,{mode:'reveal',cond}));});
  $('#reveal-verdict').textContent=cond.label;
  $('#btn-continue').classList.toggle('hidden',!_isHost);
}

/* ═══ FINISHED ═════════════════════════════════════════════ */
function _renderFinished(room){
  const ov=$('#overlay-gameover');ov.classList.remove('hidden');
  $('#winner-name').textContent=room.winnerName||'—';
  const sb=$('#winner-scoreboard');sb.innerHTML='';
  Object.entries(room.players||{}).sort((a,b)=>(b[1].score||0)-(a[1].score||0)).forEach(([,p])=>{sb.innerHTML+=`<div class="guess-row"><span>${escapeHtml(p.name)}</span><span>${p.score||0} pt</span></div>`;});
}

/* ═══ RENDER CARD ══════════════════════════════════════════ */
function renderCard(card,opts){
  const el=document.createElement('div');el.className='card';
  const{mode,cond}=opts;const isCenter=mode==='center';
  const photo=`https://tmssl.akamaized.net/images/foto/small/${card.playerId}.jpg`;
  const ini=(card.playerName||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  let hint='';
  if(isCenter){
    let icon,lbl,typ;
    if(card.visibleAttr==='flag'){typ='País';icon=`<div class="hint-flag">${countryFlagHTML(card.country,card.countryFlag)}</div>`;lbl=card.country;}
    else if(card.visibleAttr==='position'){typ='Posición';icon=`<div class="hint-pos">${escapeHtml(card.position)}</div>`;lbl=card.position;}
    else{typ='Club';icon=`<div class="hint-badge">${clubBadgeHTML(card.club,36)}</div>`;lbl=card.club;}
    hint=`<div class="card-hint-overlay"><span class="card-hint-type">${escapeHtml(typ)}</span>${icon}<span class="card-hint-label">${escapeHtml((lbl||'').toUpperCase())}</span></div>`;
  }
  const photoHtml=`<div class="card-photo-wrap${isCenter?' center-photo':''}"><img class="card-photo-img" src="${photo}" loading="lazy" alt="" onerror="this.closest('.card-photo-wrap').classList.add('no-photo')"><div class="card-photo-fallback">${escapeHtml(ini)}</div>${isCenter?hint:`<div class="card-photo-name">${escapeHtml(card.playerName)}</div>`}</div>`;
  const ident=isCenter?'':`<div class="card-identity">${countryFlagHTML(card.country,card.countryFlag)}${clubBadgeHTML(card.club)}</div>`;
  let stat='';
  if(mode==='own-easy'||mode==='reveal'){
    const raw=card.stats[cond.key];
    const matches=mode==='reveal'?card.matches:cardMatchesCond(card,cond);
    const disp=cond.type==='bool'?(raw?'SI':'NO'):(raw??0);
    const b=document.createElement('div');b.className=`card-badge ${matches?'ok':'ko'}`;b.textContent=matches?'OK':'NO';el.appendChild(b);
    if(mode==='reveal')el.classList.add('revealed',matches?'match':'nomatch');
    stat=`<div class="card-stat"><span>${escapeHtml(cond.type==='bool'?cond.label:cond.unit)}</span><span class="card-stat-val">${escapeHtml(String(disp))}</span></div>`;
  }else{
    stat='<div class="card-stat hidden-stat">OCULTO</div>';
  }
  el.innerHTML+=photoHtml+ident+stat;
  return el;
}

/* ═══ 7. MODO PRÁCTICA (vs bots) ═══════════════════════════ */
const BOT_NAMES=['Bot Pirlo','Bot Xavi','Bot Kanté','Bot Pogba','Bot Vidal','Bot Alonso','Bot Busquets'];
/* 4 rondas PREDETERMINADAS (siempre las mismas) para verificar el juego:
   club → companero → numero → combo. Tras la 4a se repiten en bucle. */
const PRACTICE_SEEDS=[2,3,1,4];
function _startLocal(){
  const name=($('#practice-name').value||'').trim()||'Tú';
  _local=true;_isHost=true;_playerId='me';_roomCode=null;
  const players={me:{name,score:0,connected:true,isHost:true}};
  for(let i=0;i<_botsDraft;i++)players['bot'+i]={name:BOT_NAMES[i%BOT_NAMES.length],score:0,connected:true,isHost:false};
  _localRoom={game:'mentiroso',status:'waiting',mode:_modeDraft,pointsToWin:_pointsDraft,round:0,seed:0,players,guesses:{}};
  _localStartRound(1);
}
function _localStartRound(roundNum){
  const room=_localRoom;if(!room)return;
  const sortedIds=Object.keys(room.players).sort();
  const seed=PRACTICE_SEEDS[(roundNum-1)%PRACTICE_SEEDS.length];
  const deal=dealRound(seed,sortedIds);
  const c=deal.condition;
  room.round=roundNum;room.seed=seed;
  room.condKey=c.key;room.condType=c.type;room.condLabel=c.label;room.condUnit=c.unit;room.condThreshold=c.threshold;
  room.guesses={};room.actualTotal=null;room.winners=null;room.status='playing';
  _revealTriggered=false;
  _onRoomUpdate(room);
  _localBotTurn();
}
function _botGuess(room,botId){
  const sortedIds=Object.keys(room.players).sort();
  const deal=dealRound(room.seed,sortedIds);
  const cond=_getCondition(room);
  const visible=[...(deal.hands[botId]||[]),...deal.centerCards];
  const vm=visible.filter(c=>cardMatchesCond(c,cond)).length;
  const total=deal.deck.length;
  const est=Math.round(vm/Math.max(1,visible.length)*total);
  const noise=Math.floor(Math.random()*3)-1;
  return Math.max(0,Math.min(total,est+noise));
}
function _localBotTurn(){
  const room=_localRoom;if(!room||room.status!=='playing')return;
  const turnId=getCurrentTurnId(room);
  if(!turnId||turnId==='me')return;
  setTimeout(()=>{
    if(_localRoom!==room||room.status!=='playing')return;
    if(getCurrentTurnId(room)!==turnId)return;
    room.guesses[turnId]=_botGuess(room,turnId);
    _onRoomUpdate(room);
    if(allGuessed(room))_localReveal();
    else _localBotTurn();
  },650);
}
function _localReveal(){
  const room=_localRoom;
  const{total,winners,scores}=_computeReveal(room);
  Object.entries(scores).forEach(([pid,sc])=>{room.players[pid].score=sc;});
  room.actualTotal=total;room.winners=winners.length?winners:['Nadie acertó'];
  const max=Math.max(...Object.values(room.players).map(p=>p.score||0));
  const leaders=Object.entries(room.players).filter(([,p])=>(p.score||0)>=room.pointsToWin&&(p.score||0)===max);
  if(leaders.length===1){room.status='finished';room.winnerName=leaders[0][1].name;}
  else room.status='reveal';
  _onRoomUpdate(room);
}

/* ═══ 8. ACCIONES ══════════════════════════════════════════ */
async function _createRoom(){
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  const name=($('#create-name').value||'').trim();
  if(!name){toast('Escribe tu nombre','error');return;}
  try{
    const{code,playerId}=await Sync.createRoom(name,_modeDraft,_pointsDraft);
    _local=false;_roomCode=code;_playerId=playerId;_isHost=true;
    _saveSession();_unsub=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){toast(e.message,'error');}
}
async function _joinRoom(){
  if(!window._FB?.configured){toast('Firebase no cargado','error');return;}
  const name=($('#join-name').value||'').trim();
  const code=($('#join-code').value||'').trim().toUpperCase();
  if(!name){toast('Escribe tu nombre','error');return;}
  if(code.length<4){toast('Código inválido','error');return;}
  try{
    const r=await Sync.joinRoom(code,name);
    _local=false;_roomCode=r.code;_playerId=r.playerId;_isHost=false;
    _saveSession();_unsub=Sync.listenRoom(code,_onRoomUpdate);
  }catch(e){$('#join-error').textContent=e.message;$('#join-error').classList.remove('hidden');}
}
async function _startGame(){
  if(_local||!_isHost||!_roomCode||!_lastRoom)return;
  const sortedIds=Object.keys(_lastRoom.players).sort();
  const seed=Date.now()+Math.floor(Math.random()*100000);
  const deal=dealRound(seed,sortedIds);
  try{await Sync.startRound(_roomCode,1,seed,deal.condition,_lastRoom.pointsToWin);}
  catch(e){toast('Error al iniciar','error');}
}
async function _submitGuess(){
  const room=_lastRoom;if(!room)return;
  if(getCurrentTurnId(room)!==_playerId){toast('No es tu turno','error');return;}
  if(_local){
    room.guesses[_playerId]=_guessDraft;_onRoomUpdate(room);
    if(allGuessed(room))_localReveal();else _localBotTurn();
    return;
  }
  try{await Sync.submitGuess(_roomCode,_playerId,_guessDraft);}
  catch(e){toast(e.message,'error');}
}
async function _continueRound(){
  if(!_isHost)return;
  if(_local){_localStartRound((_localRoom.round||0)+1);return;}
  if(!_roomCode||!_lastRoom)return;
  const next=(_lastRoom.round||0)+1;
  const sortedIds=Object.keys(_lastRoom.players).sort();
  const seed=Date.now()+next*7919;
  const deal=dealRound(seed,sortedIds);
  try{await Sync.startRound(_roomCode,next,seed,deal.condition,_lastRoom.pointsToWin);}
  catch(e){toast('Error','error');}
}
async function _leaveRoom(){
  if(!_local&&_roomCode&&_playerId){try{await Sync.disconnect(_roomCode,_playerId);}catch{}}
  _reset();showScreen('#screen-menu');
}
async function _kick(pid,name){
  if(!confirm(`¿Quitar a ${name}?`))return;
  try{await Sync.kick(_roomCode,pid);toast(`${name} eliminado`,'info');}catch{toast('Error','error');}
}

/* ═══ 9. BOOT ══════════════════════════════════════════════ */
function boot(){
  if(!window.PLAYERS||!window.PLAYERS.length){toast('Faltan datos de jugadores','error');return;}

  /* Tabs */
  $$('.menu-tab').forEach(tab=>tab.addEventListener('click',()=>{
    $$('.menu-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');
    $$('.menu-panel').forEach(p=>p.classList.remove('active'));
    $(`.menu-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
  }));
  /* Mode */
  $$('.mode-opt').forEach(b=>b.addEventListener('click',()=>{$$('.mode-opt').forEach(x=>x.classList.remove('active'));b.classList.add('active');_modeDraft=b.dataset.mode;}));
  /* Points steppers */
  $('#btn-points-minus')?.addEventListener('click',()=>{_pointsDraft=Math.max(1,_pointsDraft-1);$('#create-points-value').textContent=_pointsDraft;});
  $('#btn-points-plus')?.addEventListener('click',()=>{_pointsDraft=Math.min(10,_pointsDraft+1);$('#create-points-value').textContent=_pointsDraft;});
  $('#btn-lobby-points-minus')?.addEventListener('click',()=>{if(_isHost&&_roomCode)Sync.updateSettings(_roomCode,{pointsToWin:Math.max(1,(_lastRoom?.pointsToWin||3)-1)}).catch(()=>{});});
  $('#btn-lobby-points-plus')?.addEventListener('click',()=>{if(_isHost&&_roomCode)Sync.updateSettings(_roomCode,{pointsToWin:Math.min(10,(_lastRoom?.pointsToWin||3)+1)}).catch(()=>{});});
  /* Bots stepper (practica) */
  $('#btn-bots-minus')?.addEventListener('click',()=>{_botsDraft=Math.max(1,_botsDraft-1);if($('#practice-bots-value'))$('#practice-bots-value').textContent=_botsDraft;});
  $('#btn-bots-plus')?.addEventListener('click',()=>{_botsDraft=Math.min(5,_botsDraft+1);if($('#practice-bots-value'))$('#practice-bots-value').textContent=_botsDraft;});
  /* Buttons */
  $('#btn-create')?.addEventListener('click',_createRoom);
  $('#btn-join')?.addEventListener('click',_joinRoom);
  $('#btn-practice')?.addEventListener('click',_startLocal);
  $('#btn-start')?.addEventListener('click',_startGame);
  $('#btn-guess')?.addEventListener('click',_submitGuess);
  $('#btn-continue')?.addEventListener('click',_continueRound);
  $('#btn-menu')?.addEventListener('click',_leaveRoom);
  $('[data-action="leave-lobby"]')?.addEventListener('click',_leaveRoom);
  $('#btn-copy-code')?.addEventListener('click',()=>{navigator.clipboard?.writeText(_roomCode||'').then(()=>toast('Código copiado','success')).catch(()=>{});});
  /* Guess stepper */
  $('#guess-minus')?.addEventListener('click',()=>{_guessDraft=Math.max(0,_guessDraft-1);$('#step-guess').textContent=_guessDraft;});
  $('#guess-plus')?.addEventListener('click',()=>{const m=Number($('#guess-max').textContent)||0;_guessDraft=Math.min(m,_guessDraft+1);$('#step-guess').textContent=_guessDraft;});
  /* beforeunload — solo lobby online */
  window.addEventListener('beforeunload',()=>{if(!_local&&_roomCode&&_playerId&&_lastRoom?.status==='waiting')Sync.disconnect(_roomCode,_playerId).catch(()=>{});});
  /* ?sala= */
  const sala=new URLSearchParams(window.location.search).get('sala');
  if(sala){$('#join-code').value=sala;$$('.menu-tab').forEach(t=>t.classList.remove('active'));$('.menu-tab[data-tab="join"]')?.classList.add('active');$$('.menu-panel').forEach(p=>p.classList.remove('active'));$('.menu-panel[data-panel="join"]')?.classList.add('active');}
  /* Restaurar sesión online */
  try{const s=JSON.parse(sessionStorage.getItem('mentiroso_s')||'null');if(s&&s.code&&s.pid&&window._FB?.configured){_roomCode=s.code;_playerId=s.pid;_unsub=Sync.listenRoom(s.code,_onRoomUpdate);return;}}catch{}
  if($('#create-points-value'))$('#create-points-value').textContent=_pointsDraft;
  showScreen('#screen-menu');
}
boot();
