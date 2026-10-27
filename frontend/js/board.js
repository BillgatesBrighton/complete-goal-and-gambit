import { Chess } from "./vendor/chess.mjs";

"use strict";

/* GOAL$GAMBIT CHESS BOARD - repaired client
   Uses chess.js for immediate local legal-move feedback, while the secure
   chess backend remains authoritative for moves, clocks and match results. */

const params = new URLSearchParams(location.search);
const DEFAULT_CHESS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const OFFLINE_DB_NAME = "goal-gambit-chess-offline";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE_NAME = "matches";
const MOVE_SYNC_TIMEOUT_MS = 15000;
let config = {};
let matchId = Number(params.get("matchId") || 0) || null;
let playerColor = "w";
let boardFlipped = false;
let selectedSquare = null;
let state = null;
let cachedRulesPosition = null;
let cachedRulesPositionKey = null;
let clockTimer = null;
let socket = null;
let socketMatchId = null;
let realtimeMatchReady = false;
let localWhiteMs = 0;
let localBlackMs = 0;
let localClockAt = 0;
let legalTargets = [];
const boardSquares = new Map();
const renderedSquareStates = new Map();
const moveSyncQueues = new Map();
const pendingNativeEngineChecks = new Map();
let renderedOrientation = null;
let renderedMovePgn = null;
let lastWhiteClockLabel = null;
let lastBlackClockLabel = null;
let illegalSquares = new Set();
let illegalFeedbackTimer = null;
let pendingPromotion = null;
let queuedPremove = null;
let nativeLegalMoveCache = null;
let cancelPending = false;
let resignPending = false;
let timeoutCheckAt = 0;
let dragState = null;
let suppressSquareClickUntil = 0;
let boardPointerHandlersInstalled = false;
let pendingMovePersistence = 0;
let stateVersion = 0;
let boardEpoch = 0;
let activeRefresh = null;
let refreshQueued = false;
let pollTimer = null;
let createOrJoinPromise = null;
let initializationKey = null;
let initializationPromise = null;
let orientationSet = false;
let offlineDbPromise = null;
let offlineWriteQueue = Promise.resolve();
let offlineMode = false;
let offlineConflict = false;
let retryDelayMs = 2000;
let lastConnectionError = "";

const chessBoard = document.getElementById("chessBoard");
const gameModeElement = document.getElementById("gameMode");
const gameStatusElement = document.getElementById("gameStatus");
const connectionStatusElement = document.getElementById("connectionStatus");
const companionEngineStatusElement = document.getElementById("companionEngineStatus");
const blackClockElement = document.getElementById("blackClock");
const whiteClockElement = document.getElementById("whiteClock");
const blackNameElement = document.getElementById("blackName");
const whiteNameElement = document.getElementById("whiteName");
const blackRatingElement = document.getElementById("blackRating");
const whiteRatingElement = document.getElementById("whiteRating");
const matchTypeElement = document.getElementById("matchType");
const matchTimeElement = document.getElementById("matchTime");
const matchStakeElement = document.getElementById("matchStake");
const matchStatusElement = document.getElementById("matchStatus");
const sideBlackNameElement = document.getElementById("sideBlackName");
const sideWhiteNameElement = document.getElementById("sideWhiteName");
const sideBlackRatingElement = document.getElementById("sideBlackRating");
const sideWhiteRatingElement = document.getElementById("sideWhiteRating");
const moveListElement = document.getElementById("moveList");
const drawPanelElement = document.getElementById("drawPanel");
const gameOverModal = document.getElementById("gameOverModal");
const gameOverTitleElement = document.getElementById("gameOverTitle");
const gameOverMessageElement = document.getElementById("gameOverMessage");
const promotionModal = document.getElementById("promotionModal");
const promotionTitleElement = document.getElementById("promotionTitle");
const cancelPromotionButton = document.getElementById("cancelPromotionButton");
const promotionButtons = {
  q:document.getElementById("promoteQueenButton"),
  r:document.getElementById("promoteRookButton"),
  b:document.getElementById("promoteBishopButton"),
  n:document.getElementById("promoteKnightButton")
};
const flipButton = document.getElementById("flipButton");
const drawButton = document.getElementById("drawButton");
const resignButton = document.getElementById("resignButton");
const cancelSearchButton = document.getElementById("cancelSearchButton");
const cancelPremoveButton = document.getElementById("cancelPremoveButton");
const acceptDrawButton = document.getElementById("acceptDrawButton");
const declineDrawButton = document.getElementById("declineDrawButton");
const returnDashboardButton = document.getElementById("returnDashboardButton");

const files = ["a","b","c","d","e","f","g","h"];
const symbols = {
  w:{k:"♔",q:"♕",r:"♖",b:"♗",n:"♘",p:"♙"},
  b:{k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"}
};

function token(){ return localStorage.getItem("goalGambitToken") || ""; }
function username(){ return localStorage.getItem("goalGambitUsername") || "You"; }
function monotonicNow(){
  const clock=window.performance;
  return clock&&typeof clock.now==="function"?clock.now():Date.now();
}
function apiBase(){
  const configured = window.GG_API_BASE || (window.GG && window.GG.API_BASE);
  if(configured) return String(configured).replace(/\/+$/, "");
  const h=location.hostname;
  const isLocal=h==="localhost"||h==="127.0.0.1";
  const frontendPorts=["3000","5173","5500","8080"];
  if(location.protocol==="file:"||(isLocal&&(!location.port||frontendPorts.includes(location.port)))) return "http://localhost:5000";
  return "";
}
function chessPlyFromFen(fen){
  const fields=String(fen||"").trim().split(/\s+/);
  const fullMove=Number(fields[5]);
  if(!Number.isInteger(fullMove)||fullMove<1)return 0;
  return (fullMove-1)*2+(fields[1]==="b"?1:0);
}
function setCompanionEngineStatus(message,show){
  if(!companionEngineStatusElement)return;
  companionEngineStatusElement.textContent=message||"";
  companionEngineStatusElement.hidden=!show||!message;
}
function notifyNativeEngineOfConfirmedMove(id,entry,confirmedMatch){
  if(!socket||!socket.connected||socketMatchId!==Number(id)||offlineMode||!confirmedMatch||!entry)return;
  const ply=chessPlyFromFen(confirmedMatch.fen);
  if(!ply)return;
  const requestId="gg-"+Number(id)+"-"+ply+"-"+Date.now()+"-"+Math.random().toString(36).slice(2,8);
  const timer=setTimeout(()=>pendingNativeEngineChecks.delete(requestId),15000);
  pendingNativeEngineChecks.set(requestId,{matchId:Number(id),fen:confirmedMatch.fen,ply,timer});
  socket.emit("chess:engine:move",{
    requestId,
    matchId:Number(id),
    ply,
    fenBefore:entry.fenBefore,
    expectedFen:confirmedMatch.fen,
    move:{from:entry.from,to:entry.to,promotion:entry.promotion||null}
  });
}
function handleNativeEngineResult(data){
  if(!data||Number(data.matchId)!==Number(matchId))return;
  const pending=pendingNativeEngineChecks.get(String(data.requestId||""));
  if(!pending)return;
  clearTimeout(pending.timer);
  pendingNativeEngineChecks.delete(String(data.requestId));
  if(data.available===false){
    setCompanionEngineStatus("Companion engine unavailable · website validation remains active",true);
    return;
  }
  if(data.stale)return;
  if(pending.fen!==data.resultingFen)return;
  if(data.legalMovesVerified&&data.agreesWithServer&&data.legal&&state&&
      state.fen===data.resultingFen&&Number(data.positionVersion)===pending.ply&&
      Number(data.positionVersion)>0&&typeof data.positionKey==="string"&&Array.isArray(data.legalMoves)){
    cacheNativeLegalMoves(data,false);
  }
  if(data.agreesWithServer&&data.legal){
    const finding=data.checkmate?"checkmate":data.stalemate?"stalemate":data.draw?"draw":data.check?"check":"position";
    setCompanionEngineStatus("Native Android engine confirmed "+finding+" · server remains authoritative",true);
  }else{
    setCompanionEngineStatus("Native engine differs · server result remains authoritative",true);
  }
  setTimeout(()=>{
    if(companionEngineStatusElement&&companionEngineStatusElement.textContent.startsWith("Native Android engine"))
      setCompanionEngineStatus("",false);
  },4500);
}
function handleNativeEnginePrediction(data){
  if(!data||data.predictionCacheHit!==true)return;
  cacheNativeLegalMoves(data,true);
}
function cacheNativeLegalMoves(data,allowOneFuturePly){
  const id=Number(data&&data.matchId),fen=String(data&&data.fen||data&&data.resultingFen||"");
  const ply=Number(data&&data.positionVersion),key=String(data&&data.positionKey||"");
  if(id!==Number(matchId)||!fen||!Number.isInteger(ply)||ply<=0||
      chessPlyFromFen(fen)!==ply||!/^[a-f0-9]{64}$/i.test(key)||
      data.legalMovesVerified!==true||!Array.isArray(data.legalMoves)||data.legalMoves.length>256)return false;
  const legalMoves=data.legalMoves.map(move=>String(move||"").toLowerCase());
  if(legalMoves.some(move=>!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))||
      new Set(legalMoves).size!==legalMoves.length)return false;
  if(state){
    if(state.status!=="active"||state.connectionPaused)return false;
    const currentPly=chessPlyFromFen(state.fen);
    if(currentPly>ply||(currentPly===ply&&state.fen!==fen)||
        (currentPly<ply&&(!allowOneFuturePly||ply!==currentPly+1)))return false;
  }
  nativeLegalMoveCache={matchId:id,fen,ply,positionKey:key,legalMoves:new Set(legalMoves)};
  return true;
}
async function api(path, options={}){
  const headers={Accept:"application/json"};
  if(options.body!==undefined) headers["Content-Type"]="application/json";
  if(token()) headers.Authorization="Bearer "+token();
  try{
    const r=await fetch(apiBase()+path,{method:options.method||"GET",headers,body:options.body!==undefined?JSON.stringify(options.body):undefined,signal:options.signal});
    let data={}; try{data=await r.json()}catch(_){ }
    if(r.status===401){localStorage.removeItem("goalGambitToken");location.href="login.html"}
    return {ok:r.ok,status:r.status,data};
  }catch(_){return {ok:false,status:0,data:{message:"The server connection was lost. Your game is still saved; reconnect and try again."}}}
}

function setConnectionStatus(message, kind){
  if(!connectionStatusElement)return;
  connectionStatusElement.textContent=message||"";
  connectionStatusElement.hidden=!message;
  connectionStatusElement.classList.remove("offline","recovery");
  if(kind)connectionStatusElement.classList.add(kind);
}
function pauseForRealtimeLoss(message){
  if(realtimeMatchReady&&state&&state.status==="active"&&!state.connectionPaused){
    localWhiteMs=remaining("w");localBlackMs=remaining("b");localClockAt=monotonicNow();
  }
  realtimeMatchReady=false;
  clearPremove();
  updateMatchActions();
  updateClocks();
  const warning=message||"Live match connection lost. Gameplay is paused until both players reconnect.";
  setConnectionStatus(warning,"offline");
  if(state&&state.status==="active")setStatus(warning,"waiting");
}
function registerChessServiceWorker(){
  if(!navigator.serviceWorker||!window.isSecureContext)return;
  const workerUrl=new URL("../sw.js",location.href);
  const scopeUrl=new URL("../",location.href);
  navigator.serviceWorker.register(workerUrl.href,{scope:scopeUrl.pathname}).catch(()=>{});
}
function offlineRecordKey(id){return "goalGambitChessOffline:"+Number(id)}
function openOfflineDb(){
  if(!window.indexedDB)return Promise.reject(new Error("IndexedDB is unavailable."));
  if(!offlineDbPromise)offlineDbPromise=new Promise((resolve,reject)=>{
    const request=window.indexedDB.open(OFFLINE_DB_NAME,OFFLINE_DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(OFFLINE_STORE_NAME))db.createObjectStore(OFFLINE_STORE_NAME,{keyPath:"matchId"});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error("Could not open local chess storage."));
    request.onblocked=()=>reject(new Error("Local chess storage is busy."));
  }).catch(error=>{offlineDbPromise=null;throw error});
  return offlineDbPromise;
}
async function readOfflineRecord(id){
  let indexedValue=null,localValue=null;
  try{
    const db=await openOfflineDb();
    indexedValue=await new Promise((resolve,reject)=>{
      const request=db.transaction(OFFLINE_STORE_NAME,"readonly").objectStore(OFFLINE_STORE_NAME).get(Number(id));
      request.onsuccess=()=>resolve(request.result||null);
      request.onerror=()=>reject(request.error||new Error("Could not read local chess storage."));
    });
  }catch(_){}
  try{localValue=JSON.parse(localStorage.getItem(offlineRecordKey(id))||"null")}catch(_){localValue=null}
  if(!indexedValue)return localValue;
  return Number(localValue?.updatedAt||0)>Number(indexedValue.updatedAt||0)?localValue:indexedValue;
}
async function writeOfflineRecord(record){
  try{
    const db=await openOfflineDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(OFFLINE_STORE_NAME,"readwrite");
      tx.objectStore(OFFLINE_STORE_NAME).put(record);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error("Could not save local chess storage."));
      tx.onabort=()=>reject(tx.error||new Error("Local chess storage transaction was cancelled."));
    });
    return;
  }catch(_){}
  localStorage.setItem(offlineRecordKey(record.matchId),JSON.stringify(record));
}
function updateOfflineRecord(id,update){
  const run=async()=>{
    const current=await readOfflineRecord(id);
    const next=await update(current);
    if(next)await writeOfflineRecord(next);
    return next;
  };
  const result=offlineWriteQueue.then(run,run);
  offlineWriteQueue=result.catch(()=>{});
  return result;
}
function calculateCheckSquare(chess){
  if(!chess.isCheck())return null;
  const board=chess.board(),color=chess.turn();
  for(let row=0;row<8;row++)for(let column=0;column<8;column++){
    const piece=board[row][column];
    if(piece&&piece.type==="k"&&piece.color===color)return String.fromCharCode(97+column)+(8-row);
  }
  return null;
}
function matchSnapshot(m){
  return {
    matchId:Number(m.matchId||matchId),status:m.status||"active",result:m.result||null,winnerId:m.winnerId||null,
    playerColor:m.playerColor||playerColor,opponentId:m.opponentId||null,playerWhiteId:m.playerWhiteId||null,playerBlackId:m.playerBlackId||null,
    fen:m.fen||DEFAULT_CHESS_FEN,pgn:m.pgn||"",lastMove:m.lastMove||null,checkSquare:m.checkSquare||null,
    whiteName:m.whiteName||null,blackName:m.blackName||null,whiteRating:m.whiteRating??null,blackRating:m.blackRating??null,
    whiteTimeMs:Number(m.whiteTimeMs??localWhiteMs),blackTimeMs:Number(m.blackTimeMs??localBlackMs),activeColor:m.activeColor||"w",
    timeControl:m.timeControl||config.timeControl||"10+0",matchType:m.matchType||"ranked",stake:Number(m.stake||0),
    drawOfferUserId:m.drawOfferUserId||null,startedAt:m.startedAt||null,finishedAt:m.finishedAt||null,savedAt:Date.now()
  };
}
function newOfflineRecord(snapshot){
  return {
    matchId:snapshot.matchId,userId:getUserId(),playerWhiteId:snapshot.playerWhiteId,playerBlackId:snapshot.playerBlackId,
    opponentId:snapshot.opponentId,playerColor:snapshot.playerColor,matchType:snapshot.matchType,timeControl:snapshot.timeControl,
    stake:snapshot.stake,tournamentId:Number(config.tournamentId)||null,round:Number(config.round)||null,
    initialFen:snapshot.fen,baseline:snapshot,serverSnapshot:snapshot,latest:snapshot,moves:[],
    claimedResult:null,terminationReason:null,sync:{status:"synced",attempts:0,lastAttemptAt:null,lastError:""},updatedAt:Date.now()
  };
}
function persistServerSnapshot(m){
  const snapshot=matchSnapshot(m);
  return updateOfflineRecord(snapshot.matchId,record=>{
    if(!record)record=newOfflineRecord(snapshot);
    const unacknowledged=(record.moves||[]).filter(move=>!move.serverAcknowledged&&!move.rejected);
    record.serverSnapshot=snapshot;
    if(!unacknowledged.length){
      if(record.claimedResult&&["awaiting-verification","conflict"].includes(record.sync?.status)){
        record.updatedAt=Date.now();
        return record;
      }
      record.baseline=snapshot;record.latest=snapshot;
      record.sync={...(record.sync||{}),status:"synced",lastError:""};
    }else{
      const matching=lastMatchingLocalMoveIndex(record.moves||[],snapshot);
      if(matching>=0){
        record.moves.forEach((move,index)=>{if(index<=matching)move.serverAcknowledged=true});
        const pending=(record.moves||[]).some(move=>!move.serverAcknowledged&&!move.rejected);
        record.sync={...(record.sync||{}),status:pending?"pending":"synced",lastError:""};
        if(!pending){record.baseline=snapshot;record.latest=snapshot}
      }else if(snapshot.fen!==record.baseline?.fen||snapshot.pgn!==record.baseline?.pgn){
        record.sync={...(record.sync||{}),status:"conflict",lastError:"The server match differs from the saved local move history."};
      }
    }
    record.updatedAt=Date.now();
    return record;
  });
}
function recordLocalMove(entry,latest,terminal){
  const snapshot=matchSnapshot(latest);
  return updateOfflineRecord(snapshot.matchId,record=>{
    if(!record)record=newOfflineRecord(matchSnapshot(entry.before));
    const sequence=(record.moves||[]).length+1;
    record.moves.push({...entry,sequence,eventId:snapshot.matchId+":"+sequence,serverAcknowledged:false});
    record.latest=snapshot;
    if(terminal){record.claimedResult=terminal.result;record.terminationReason=terminal.reason;record.sync.status="awaiting-verification";}
    else record.sync.status="pending";
    record.updatedAt=Date.now();
    return record;
  });
}
function acknowledgeLocalMoves(match){
  return updateOfflineRecord(match.matchId,record=>{
    if(!record)return null;
    const index=lastMatchingLocalMoveIndex(record.moves||[],match);
    if(index>=0)record.moves.forEach((move,position)=>{if(position<=index)move.serverAcknowledged=true});
    const pending=(record.moves||[]).some(move=>!move.serverAcknowledged&&!move.rejected);
    record.serverSnapshot=matchSnapshot(match);
    record.sync={...(record.sync||{}),status:pending?"pending":"synced",lastError:""};
    if(!pending){record.baseline=record.serverSnapshot;record.latest=record.serverSnapshot}
    record.updatedAt=Date.now();
    return record;
  });
}
function finishOfflineOnTime(reason){
  if(!state||state.status!=="active")return;
  const losingColor=state.activeColor;
  const finished={...state,whiteTimeMs:remaining("w"),blackTimeMs:remaining("b"),status:"offline_pending",result:null,claimedResult:losingColor==="w"?"black_win":"white_win",terminationReason:reason,savedAt:Date.now()};
  state=finished;stateVersion++;
  setStatus("Local clock ended · result awaits server verification.","waiting");
  setConnectionStatus("Offline result saved locally · not official until server verification.","offline");
  renderBoard();updateMatchActions();
  updateOfflineRecord(matchId,record=>{
    if(!record)record=newOfflineRecord(matchSnapshot(finished));
    record.latest=matchSnapshot(finished);record.claimedResult=finished.claimedResult;record.terminationReason=reason;
    record.sync={...(record.sync||{}),status:"awaiting-verification",lastError:"Clock outcome was observed locally and is not server verified."};
    record.updatedAt=Date.now();return record;
  }).catch(()=>setConnectionStatus("Local result could not be saved. Keep this page open for recovery.","offline"));
}

function parseFen(fen){
  const rows=(fen||"").split(" ")[0].split("/");
  const board=[];
  for(let r=0;r<8;r++){
    const row=[];
    for(const ch of rows[r]||""){
      if(/^[1-8]$/.test(ch)){for(let i=0;i<Number(ch);i++)row.push(null)}
      else row.push({color:ch===ch.toUpperCase()?"w":"b",type:ch.toLowerCase()});
    }
    while(row.length<8)row.push(null); board.push(row.slice(0,8));
  }
  return board;
}
function squareName(r,c){return files[c]+(8-r)}
function parseSquare(s){return {r:8-Number(s[1]),c:files.indexOf(s[0])}}
function formatClock(ms){ms=Math.max(0,Math.floor(ms));const sec=Math.ceil(ms/1000),m=Math.floor(sec/60),s=sec%60;return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")}
function remaining(color){
  let ms=color==="w"?localWhiteMs:localBlackMs;
  if(state&&realtimeMatchReady&&state.activeColor===color&&state.status==="active"&&!state.connectionPaused) ms-=monotonicNow()-localClockAt;
  return Math.max(0,ms);
}
function currentBoard(){return parseFen(state&&state.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")}

function setInfo(){
  const timeControl=state?.timeControl||config.timeControl||"";
  const speed=(config.rankedMode||config.speed||speedForTimeControl(timeControl)).replace(/[^a-z]/gi,"");
  const matchType=state?.matchType|| (config.tournamentMode?"tournament":"ranked");
  const type=matchType==="tournament"?"Tournament":matchType==="casual"?"Casual":"Ranked";
  const label=speed.charAt(0).toUpperCase()+speed.slice(1)+" "+type;
  if(gameModeElement)gameModeElement.textContent=label;
  if(matchTypeElement)matchTypeElement.textContent=type;
  if(matchTimeElement)matchTimeElement.textContent=timeControl||"—";
  if(matchStakeElement)matchStakeElement.textContent="KSh "+Number(state?.stake??config.rankedStake??0).toLocaleString("en-KE");
}
function speedForTimeControl(value){
  const control=String(value||"").trim();
  if(/^(1:00|1\+1|2:00|2\+1)$/.test(control))return "bullet";
  if(/^(3:00|3\+2|5:00)$/.test(control))return "blitz";
  return "rapid";
}
function setPlayers(){
  const mine=state?.playerColor;
  const white=state?.whiteName||(mine==="w"?username():"Waiting…");
  const black=state?.blackName||(mine==="b"?username():"Searching…");
  const wr=state?.whiteRating!=null?state.whiteRating:"—";
  const br=state?.blackRating!=null?state.blackRating:"—";
  [whiteNameElement,sideWhiteNameElement].forEach(x=>{if(x)x.textContent=white});
  [blackNameElement,sideBlackNameElement].forEach(x=>{if(x)x.textContent=black});
  [whiteRatingElement,sideWhiteRatingElement].forEach(x=>{if(x)x.textContent=wr});
  [blackRatingElement,sideBlackRatingElement].forEach(x=>{if(x)x.textContent=br});
}
function positionPlayerBars(){
  const boardWrapper=chessBoard?.parentElement;
  const section=boardWrapper?.parentElement;
  const blackBar=blackNameElement?.closest(".player-bar");
  const whiteBar=whiteNameElement?.closest(".player-bar");
  if(!section||!boardWrapper||!blackBar||!whiteBar)return;
  const topBar=playerColor==="b"?whiteBar:blackBar;
  const bottomBar=playerColor==="b"?blackBar:whiteBar;
  section.insertBefore(topBar,section.firstElementChild);
  section.insertBefore(boardWrapper,topBar.nextElementSibling);
  section.insertBefore(bottomBar,boardWrapper.nextElementSibling);
}
function createBoardSquare(name){
  const square=document.createElement("button");
  square.type="button";square.className="square";square.dataset.square=name;
  const glyph=document.createElement("span");glyph.className="piece-glyph";glyph.setAttribute("aria-hidden","true");
  const fileLabel=document.createElement("span");fileLabel.className="coord-file";fileLabel.setAttribute("aria-hidden","true");
  const rankLabel=document.createElement("span");rankLabel.className="coord-rank";rankLabel.setAttribute("aria-hidden","true");
  square.append(glyph,fileLabel,rankLabel);
  square.addEventListener("click",()=>{
    if(Date.now()<suppressSquareClickUntil)return;
    clickSquare(square.dataset.square);
  });
  boardSquares.set(name,{element:square,glyph,fileLabel,rankLabel});
  chessBoard.appendChild(square);
  return boardSquares.get(name);
}
function ensureBoardSquares(){
  if(!chessBoard)return;
  if(boardSquares.size<64){
    for(let r=0;r<8;r++)for(let c=0;c<8;c++)createBoardSquare(squareName(r,c));
  }
  installBoardPointerHandlers();
}
function renderBoard(){
  if(!chessBoard)return;
  ensureBoardSquares();
  const b=currentBoard();
  const targets=new Map(legalTargets.map(move=>[move.to,move]));
  for(let vr=0;vr<8;vr++){
    for(let vc=0;vc<8;vc++){
      const r=boardFlipped?7-vr:vr, c=boardFlipped?7-vc:vc;
      const name=squareName(r,c),cell=boardSquares.get(name),sq=cell.element;
      const target=targets.get(name);
      const classes=["square",(r+c)%2===0?"light":"dark"];
      if(selectedSquare===name)classes.push("selected");
      if(queuedPremove&&(queuedPremove.from===name||queuedPremove.to===name))classes.push("premove-selected");
      if(illegalSquares.has(name))classes.push("illegal-move");
      if(state?.lastMove&&(state.lastMove.from===name||state.lastMove.to===name))classes.push("last-move");
      if(target)classes.push(target.premove?"premove-destination":target.capture?"possible-capture":"possible-move");
      if(state?.checkSquare===name)classes.push("in-check");
      const className=classes.join(" ");
      const previous=renderedSquareStates.get(name)||{};
      if(previous.className!==className)sq.className=className;
      if(renderedOrientation!==boardFlipped){
        sq.style.gridRow=String(vr+1);sq.style.gridColumn=String(vc+1);
      }
      const p=b[r][c];
      const pieceKey=p?p.color+p.type:"";
      if(previous.pieceKey!==pieceKey){
        cell.glyph.textContent=p?symbols[p.color][p.type]:"";
        cell.glyph.className="piece-glyph"+(p?" "+(p.color==="w"?"white-piece":"black-piece"):"");
        cell.glyph.style.transform="";
      }
      const label=name+(p?" "+(p.color==="w"?"white ":"black ")+p.type:" empty")+(target?" legal move":"");
      if(previous.label!==label)sq.setAttribute("aria-label",label);
      if(renderedOrientation!==boardFlipped||previous.fileVisible!==(vr===7)){
        cell.fileLabel.hidden=vr!==7;
        if(vr===7)cell.fileLabel.textContent=files[c];
      }
      if(renderedOrientation!==boardFlipped||previous.rankVisible!==(vc===0)){
        cell.rankLabel.hidden=vc!==0;
        if(vc===0)cell.rankLabel.textContent=String(8-r);
      }
      renderedSquareStates.set(name,{className,pieceKey,label,fileVisible:vr===7,rankVisible:vc===0});
    }
  }
  renderedOrientation=boardFlipped;
  renderMoves();updateClocks();
}
function renderMoves(){
  if(!moveListElement)return;
  const pgn=state?.pgn||"";
  if(renderedMovePgn===pgn)return;
  renderedMovePgn=pgn;
  const moves=pgn.match(/(?:O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g)||[];
  moveListElement.innerHTML="";
  if(!moves.length){moveListElement.innerHTML='<div class="empty-moves">No moves yet</div>';return}
  for(let i=0;i<moves.length;i+=2){
    const row=document.createElement("div");row.className="move-row";
    const number=document.createElement("span");number.className="move-number";number.textContent=(i/2+1)+".";
    const white=document.createElement("span");white.className="move-white";white.textContent=moves[i];
    const black=document.createElement("span");black.className="move-black";black.textContent=moves[i+1]||"";
    row.append(number,white,black);moveListElement.appendChild(row);
  }
}
function updateClocks(){
  const white=remaining("w"),black=remaining("b");
  if(whiteClockElement){const label=formatClock(white);if(label!==lastWhiteClockLabel){whiteClockElement.textContent=label;lastWhiteClockLabel=label}whiteClockElement.classList.toggle("active",!!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&state.activeColor==="w");whiteClockElement.classList.toggle("critical",!!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&state.activeColor==="w"&&white<=10000)}
  if(blackClockElement){const label=formatClock(black);if(label!==lastBlackClockLabel){blackClockElement.textContent=label;lastBlackClockLabel=label}blackClockElement.classList.toggle("active",!!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&state.activeColor==="b");blackClockElement.classList.toggle("critical",!!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&state.activeColor==="b"&&black<=10000)}
  const active=state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused?(state.activeColor==="w"?white:black):null;
  if(active!==null&&active<=0&&monotonicNow()-timeoutCheckAt>1000){
    timeoutCheckAt=monotonicNow();
    if(offlineMode)finishOfflineOnTime("timeout");else loadMatch();
  }
}
function setStatus(text, cls){
  if(gameStatusElement)gameStatusElement.textContent=text;
  if(matchStatusElement)matchStatusElement.textContent=text;
  const turnMessage=document.getElementById("turnMessage");if(turnMessage)turnMessage.textContent=text;
  const bar=document.getElementById("statusBar");if(bar){bar.classList.remove("ready","waiting");if(cls)bar.classList.add(cls)}
}
function currentRulesPosition(){
  if(!state||!state.fen){invalidateRulesPosition();return null}
  const key=JSON.stringify([Number(matchId)||0,String(state.fen),String(state.pgn||"")]);
  if(cachedRulesPosition&&cachedRulesPositionKey===key)return cachedRulesPosition;
  invalidateRulesPosition();
  try{
    let chess;
    if(state.pgn){
      chess=new Chess();chess.loadPgn(state.pgn);
      if(chess.fen()!==state.fen)return null;
    }else chess=new Chess(state.fen);
    cachedRulesPosition=chess;cachedRulesPositionKey=key;
    return chess;
  }
  catch(_){return null}
}
function invalidateRulesPosition(){
  cachedRulesPosition=null;cachedRulesPositionKey=null;
}
function selectPiece(sq){
  const actual=currentRulesPosition();
  const premoving=!!state&&state.activeColor!==playerColor;
  let chess=actual;
  if(premoving&&state.fen){
    try{const fields=state.fen.trim().split(/\s+/);fields[1]=playerColor;chess=new Chess(fields.join(" "))}catch(_){chess=null}
  }
  if(!chess){setStatus("The current board could not be validated. Refresh the match before moving.","waiting");return}
  if(!premoving&&chess.turn()!==state.activeColor){setStatus("The board is syncing with the server. Wait for the current position to load.","waiting");if(!offlineMode)loadMatch();return}
  const piece=chess.get(sq);
  const movableColor=playerColor;
  selectedSquare=sq;
  const nativeCache=!premoving&&nativeLegalMoveCache&&nativeLegalMoveCache.matchId===Number(matchId)&&
    nativeLegalMoveCache.fen===state.fen&&nativeLegalMoveCache.ply===chessPlyFromFen(state.fen)
    ?nativeLegalMoveCache:null;
  legalTargets=piece&&piece.color===movableColor
    ?(nativeCache
      ?Array.from(nativeCache.legalMoves).filter(move=>move.slice(0,2)===sq).map(move=>nativeLegalTarget(chess,move))
      :chess.moves({square:sq,verbose:true}).map(move=>({from:move.from,to:move.to,capture:Boolean(move.captured),flags:move.flags,san:move.san,promotion:move.promotion||null,premove:premoving})))
    :[];
  renderBoard();
  const checkHint=chess.isCheck()?" You are in check; choose a move that protects your king.":"";
  setStatus(legalTargets.length?(premoving?"Choose a highlighted square to queue your premove.":"Choose a highlighted legal square.")+checkHint:(chess.isCheck()?"Check — this piece has no legal move that protects your king.":"That piece has no legal moves."),chess.isCheck()?"waiting":"ready");
}
function nativeLegalTarget(chess,uci){
  const from=uci.slice(0,2),to=uci.slice(2,4),piece=chess.get(from),target=chess.get(to);
  const fields=String(chess.fen()||"").split(/\s+/),epTarget=fields[3]||"-";
  const enPassant=piece&&piece.type==="p"&&from[0]!==to[0]&&!target&&epTarget===to;
  return {from,to,capture:Boolean(target||enPassant),flags:"",san:"",promotion:uci.length===5?uci[4]:null,premove:false};
}
function flashIllegalMove(from,to){
  if(illegalFeedbackTimer)clearTimeout(illegalFeedbackTimer);
  illegalSquares=new Set([from,to].filter(Boolean));
  renderBoard();
  illegalFeedbackTimer=setTimeout(()=>{
    illegalSquares.clear();illegalFeedbackTimer=null;renderBoard();
  },700);
}
function clearIllegalFeedback(){
  if(illegalFeedbackTimer)clearTimeout(illegalFeedbackTimer);
  illegalFeedbackTimer=null;illegalSquares.clear();
}
function boardCanInteract(){
  return !!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&!state.result&&!offlineMode&&!offlineConflict&&navigator.onLine!==false&&state.activeColor===playerColor;
}
function boardCanSelect(){
  return !!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&!state.result&&!offlineMode&&!offlineConflict&&navigator.onLine!==false;
}
function boardCanQueuePremove(){
  return boardCanSelect()&&state.activeColor!==playerColor&&
    !moveSyncQueues.has(Number(matchId))&&pendingMovePersistence===0;
}
function clearPremove(message){
  if(!queuedPremove)return;
  queuedPremove=null;
  if(cancelPremoveButton){cancelPremoveButton.hidden=true;cancelPremoveButton.classList.add("hidden")}
  renderBoard();
  if(message)setStatus(message,"waiting");
}
function queuePremove(from,to,promotion){
  if(!boardCanQueuePremove())return false;
  queuedPremove={from,to,promotion:promotion||null,queuedFen:state&&state.fen||""};
  selectedSquare=null;legalTargets=[];
  if(cancelPremoveButton){cancelPremoveButton.hidden=false;cancelPremoveButton.classList.remove("hidden")}
  renderBoard();
  setStatus("Premove queued. It will be checked against the opponent’s confirmed move; tap Cancel Premove to remove it.","ready");
  return true;
}
function squareFromTarget(target){
  let element=target;
  while(element&&element!==chessBoard){
    if(element.dataset&&element.dataset.square)return element;
    element=element.parentElement;
  }
  return null;
}
function clearDragVisual(){
  if(!dragState)return;
  const glyph=dragState.glyph;
  if(glyph){glyph.style.transform="";glyph.classList.remove("dragging")}
  const id=dragState.pointerId;
  if(chessBoard&&id!=null&&typeof chessBoard.releasePointerCapture==="function"){
    try{if(!chessBoard.hasPointerCapture||chessBoard.hasPointerCapture(id))chessBoard.releasePointerCapture(id)}catch(_){}
  }
}
function handleBoardPointerDown(event){
  if(!boardCanSelect()||pendingPromotion||event.isPrimary===false||(event.button!=null&&event.button!==0))return;
  const square=squareFromTarget(event.target);
  if(!square)return;
  const piece=currentRulesPosition()?.get(square.dataset.square);
  const movableColor=playerColor;
  if(!piece||piece.color!==movableColor)return;
  dragState={pointerId:event.pointerId,from:square.dataset.square,x:Number(event.clientX)||0,y:Number(event.clientY)||0,dragging:false,glyph:null};
}
function handleBoardPointerMove(event){
  if(!dragState||(dragState.pointerId!=null&&event.pointerId!==dragState.pointerId))return;
  const dx=(Number(event.clientX)||0)-dragState.x,dy=(Number(event.clientY)||0)-dragState.y;
  if(!dragState.dragging&&Math.hypot(dx,dy)<8)return;
  if(!dragState.dragging){
    dragState.dragging=true;
    selectPiece(dragState.from);
    dragState.glyph=boardSquares.get(dragState.from)?.glyph||null;
    if(dragState.glyph)dragState.glyph.classList.add("dragging");
    if(chessBoard&&dragState.pointerId!=null&&typeof chessBoard.setPointerCapture==="function"){
      try{chessBoard.setPointerCapture(dragState.pointerId)}catch(_){}
    }
  }
  if(typeof event.preventDefault==="function")event.preventDefault();
  if(dragState.glyph)dragState.glyph.style.transform="translate3d("+dx+"px,"+dy+"px,0) scale(1.08)";
}
function handleBoardPointerUp(event){
  if(!dragState||(dragState.pointerId!=null&&event.pointerId!==dragState.pointerId))return;
  const finished=dragState;
  let target=null;
  if(finished.dragging){
    const hit=document.elementFromPoint&&Number.isFinite(Number(event.clientX))&&Number.isFinite(Number(event.clientY))
      ?document.elementFromPoint(event.clientX,event.clientY):null;
    target=squareFromTarget(hit)||squareFromTarget(event.target);
  }
  clearDragVisual();dragState=null;
  if(finished.dragging){
    suppressSquareClickUntil=Date.now()+400;
    if(target&&target.dataset.square!==finished.from)clickSquare(target.dataset.square);
  }
}
function handleBoardPointerCancel(event){
  if(!dragState||(dragState.pointerId!=null&&event.pointerId!==dragState.pointerId))return;
  clearDragVisual();dragState=null;
}
function installBoardPointerHandlers(){
  if(!chessBoard||boardPointerHandlersInstalled)return;
  boardPointerHandlersInstalled=true;
  chessBoard.addEventListener("pointerdown",handleBoardPointerDown);
  chessBoard.addEventListener("pointermove",handleBoardPointerMove);
  chessBoard.addEventListener("pointerup",handleBoardPointerUp);
  chessBoard.addEventListener("pointercancel",handleBoardPointerCancel);
}
function openPromotionChooser(from,to){
  pendingPromotion={from,to};
  if(promotionTitleElement)promotionTitleElement.textContent="Choose a piece for your pawn on "+to.toUpperCase();
  Object.entries(promotionButtons).forEach(([piece,button])=>{
    if(!button)return;
    button.textContent=symbols[playerColor][piece];
    button.setAttribute("aria-label","Promote to "+({q:"queen",r:"rook",b:"bishop",n:"knight"}[piece]));
  });
  if(promotionModal)promotionModal.classList.remove("hidden");
  if(promotionButtons.q)promotionButtons.q.focus();
}
function cancelPromotion(){
  pendingPromotion=null;
  if(promotionModal)promotionModal.classList.add("hidden");
}
function choosePromotion(piece){
  const move=pendingPromotion;
  if(!move)return;
  const isLegal=legalTargets.some(candidate=>candidate.from===move.from&&candidate.to===move.to&&candidate.promotion===piece);
  const premoving=!!state&&state.activeColor!==playerColor;
  cancelPromotion();
  if(!isLegal){flashIllegalMove(move.from,move.to);setStatus("That promotion is not legal in the current position.","waiting");return}
  selectedSquare=null;legalTargets=[];
  if(premoving){queuePremove(move.from,move.to,piece);return}
  return sendMove(move.from,move.to,piece);
}
function clickSquare(sq){
  if(!boardCanSelect())return;
  const b=currentBoard(),{r,c}=parseSquare(sq),p=b[r][c];
  const movableColor=playerColor;
  if(selectedSquare){
    const targets=legalTargets.filter(move=>move.to===sq);
    if(targets.length){
      const from=selectedSquare;
      if(targets.some(move=>move.promotion)){openPromotionChooser(from,sq);return}
      const premoving=state.activeColor!==playerColor;
      selectedSquare=null;legalTargets=[];
      if(premoving){
        if(!boardCanQueuePremove()){setStatus("Wait for your current move to be confirmed before queuing a premove.","waiting");renderBoard();return}
        queuePremove(from,sq,null);
      }else sendMove(from,sq);
      return;
    }
    if(p&&p.color===movableColor){selectPiece(sq);return}
    if(sq!==selectedSquare){flashIllegalMove(selectedSquare,sq);setStatus("That move is illegal. Choose a highlighted square.","waiting");return}
  }
  if(p&&p.color===movableColor){selectPiece(sq);return}
  selectedSquare=null;legalTargets=[];renderBoard();
}
function enqueueMoveSynchronization(id,task){
  const key=Number(id),previous=moveSyncQueues.get(key)||Promise.resolve();
  const operation=previous.then(task,task);
  const tail=operation.catch(()=>{});
  moveSyncQueues.set(key,tail);
  tail.then(()=>{if(moveSyncQueues.get(key)===tail)moveSyncQueues.delete(key)});
  return operation;
}
async function markLocalMoveRejected(id,entry,authoritative,message){
  const snapshot=matchSnapshot(authoritative);
  const record=await updateOfflineRecord(id,current=>{
    if(!current)return null;
    const rejected=current.moves.find(move=>!move.serverAcknowledged&&!move.rejected&&
      move.fenBefore===entry.fenBefore&&move.fenAfter===entry.fenAfter&&move.from===entry.from&&move.to===entry.to);
    if(rejected){
      rejected.rejected=true;
      rejected.rejectedAt=Date.now();
      rejected.rejectionReason=String(message||"The server did not accept this move.").slice(0,300);
      if(current.latest?.fen===rejected.fenAfter){current.claimedResult=null;current.terminationReason=null;}
    }
    const unresolved=current.moves.some(move=>!move.serverAcknowledged&&!move.rejected);
    current.serverSnapshot=snapshot;
    if(!unresolved){
      current.baseline=snapshot;current.latest=snapshot;
      current.sync={...(current.sync||{}),status:"synced",lastError:String(message||"The server rejected the move; its authoritative position was restored.")};
    }else{
      current.sync={...(current.sync||{}),status:"conflict",lastError:"Other saved moves still differ from the authoritative server position."};
    }
    current.updatedAt=Date.now();
    return current;
  });
  return !!(record&&record.sync&&record.sync.status==="conflict");
}
function applyMoveSnapshotWithoutRollback(id,epoch,versionAtSubmit,serverMatch){
  if(epoch!==boardEpoch||Number(id)!==Number(matchId))return;
  if(stateVersion===versionAtSubmit){applyState(serverMatch);return}
  if(positionInHistory(serverMatch,state))return;
  if(positionInHistory(state,serverMatch)){applyState(serverMatch);return}
  loadMatch();
}
async function acceptMoveSnapshot(id,epoch,versionAtSubmit,serverMatch){
  await acknowledgeLocalMoves(serverMatch);
  if(epoch!==boardEpoch||Number(id)!==Number(matchId))return;
  offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
  applyMoveSnapshotWithoutRollback(id,epoch,versionAtSubmit,serverMatch);
}
async function recoverRejectedMove(id,epoch,versionAtSubmit,entry,nextState,responseData,message){
  let authoritative=responseData&&responseData.match;
  if(!authoritative||Number(authoritative.matchId)!==Number(id)){
    const refreshed=await api("/api/chess/"+id);
    authoritative=refreshed.ok&&refreshed.data&&refreshed.data.match&&Number(refreshed.data.match.matchId)===Number(id)
      ?refreshed.data.match:null;
  }
  if(authoritative){
    if(positionInHistory(nextState,authoritative)){
      await acceptMoveSnapshot(id,epoch,versionAtSubmit,authoritative);
      return true;
    }
    const unresolved=await markLocalMoveRejected(id,entry,authoritative,message);
    if(epoch!==boardEpoch||Number(id)!==Number(matchId))return false;
    offlineMode=unresolved;offlineConflict=unresolved;
    if(!unresolved){retryDelayMs=2000;lastConnectionError=""}
    applyMoveSnapshotWithoutRollback(id,epoch,versionAtSubmit,authoritative);
    updateMatchActions();
    setConnectionStatus(unresolved
      ?"The server position was restored, but other saved moves still need review. Further play is paused."
      :"The server rejected this move. The official position was restored; the unconfirmed move is saved for review.",unresolved?"offline":"recovery");
    setStatus(unresolved?"Moves are paused until the saved history can be reconciled.":(message||"The server did not accept that move. Check the official position and try again."),"waiting");
    return false;
  }
  await updateOfflineRecord(id,current=>{
    if(!current)return null;
    current.sync={...(current.sync||{}),status:"pending",lastError:String(message||"The server rejected the move, but its latest position could not be loaded.")};
    current.updatedAt=Date.now();return current;
  }).catch(()=>{});
  if(epoch===boardEpoch&&Number(id)===Number(matchId)){
    offlineMode=true;offlineConflict=false;lastConnectionError=String(message||"The server position is unavailable.");
    retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));
    updateMatchActions();
    setConnectionStatus("The move is unconfirmed. Further moves are paused while the server position is recovered.","offline");
    setStatus("Do not continue this game until the server confirms its current position.","waiting");
    scheduleMatchPolling();
  }
  return false;
}
async function sendMove(from,to,promotion){
  if(!boardCanInteract())return false;
  const chess=currentRulesPosition();
  if(!chess){setStatus("The current board could not be validated. Refresh the match before moving.","waiting");return false}
  if(chess.turn()!==state.activeColor){setStatus("The board is syncing with the server. Wait for the current position to load.","waiting");if(!offlineMode)loadMatch();return false}
  const candidates=chess.moves({square:from,verbose:true}).filter(move=>move.to===to);
  if(!candidates.length){flashIllegalMove(from,to);setStatus("That move is illegal. The board has not changed.","waiting");return false}
  const promotionRequired=candidates.some(move=>Boolean(move.promotion));
  if(promotionRequired&&!promotion){openPromotionChooser(from,to);return false}
  const selectedMove=candidates.find(move=>!promotionRequired||move.promotion===promotion);
  if(!selectedMove){flashIllegalMove(from,to);setStatus("Choose a valid promotion piece.","waiting");return false}
  let move;
  try{move=chess.move({from,to,...(promotionRequired?{promotion}: {})})}
  catch(_){flashIllegalMove(from,to);setStatus("That move is illegal. The board has not changed.","waiting");return false}
  if(!move){flashIllegalMove(from,to);setStatus("That move is illegal. The board has not changed.","waiting");return false}
  invalidateRulesPosition();
  const submittedMatchId=Number(matchId),submittedEpoch=boardEpoch;
  const movedAt=monotonicNow(),movedAtWall=Date.now(),moverColor=state.activeColor;
  const clocksBefore={whiteTimeMs:remaining("w"),blackTimeMs:remaining("b")};
  const incrementMatch=String(state.timeControl||config.timeControl||"").match(/\+(\d+)$/);
  const incrementMs=incrementMatch?Number(incrementMatch[1])*1000:0;
  const clocksAfter={
    whiteTimeMs:Math.max(0,clocksBefore.whiteTimeMs+(moverColor==="w"?incrementMs:0)),
    blackTimeMs:Math.max(0,clocksBefore.blackTimeMs+(moverColor==="b"?incrementMs:0))
  };
  let terminal=null;
  if(chess.isCheckmate())terminal={result:moverColor==="w"?"white_win":"black_win",reason:"checkmate"};
  else if(chess.isDraw()||chess.isStalemate()||chess.isThreefoldRepetition()||chess.isInsufficientMaterial())terminal={result:"draw",reason:chess.isStalemate()?"stalemate":"draw"};
  const nextState={...state,fen:chess.fen(),pgn:chess.pgn(),activeColor:chess.turn(),lastMove:{from:move.from,to:move.to},checkSquare:calculateCheckSquare(chess),
    whiteTimeMs:clocksAfter.whiteTimeMs,blackTimeMs:clocksAfter.blackTimeMs,status:terminal?"offline_pending":"active",result:null,
    claimedResult:terminal?.result||null,terminationReason:terminal?.reason||null,savedAt:movedAtWall};
  const entry={actorColor:moverColor,actorUserId:moverColor===playerColor?getUserId():null,from:move.from,to:move.to,promotion:move.promotion||null,san:move.san,flags:move.flags,
    fenBefore:state.fen,pgnBefore:state.pgn||"",fenAfter:chess.fen(),pgnAfter:chess.pgn(),clocksBefore,clocksAfter,
    elapsedBeforeMoveMs:Math.max(0,movedAt-localClockAt),movedAt:new Date(movedAtWall).toISOString(),before:matchSnapshot({...state,...clocksBefore})};
  state=nextState;stateVersion++;localWhiteMs=clocksAfter.whiteTimeMs;localBlackMs=clocksAfter.blackTimeMs;localClockAt=movedAt;
  const versionAtSubmit=stateVersion,offlineAtMove=offlineMode||navigator.onLine===false;
  selectedSquare=null;legalTargets=[];clearIllegalFeedback();
  setPlayers();renderBoard();setStatus(offlineAtMove?"Move shown locally; saving recovery data…":"Move shown locally; syncing with the server…","ready");
  pendingMovePersistence++;
  let durableMove;
  try{durableMove=recordLocalMove(entry,nextState,terminal)}catch(error){durableMove=Promise.reject(error)}
  const recordPromise=Promise.resolve(durableMove).then(record=>{pendingMovePersistence=Math.max(0,pendingMovePersistence-1);return record},error=>{pendingMovePersistence=Math.max(0,pendingMovePersistence-1);throw error});
  return enqueueMoveSynchronization(submittedMatchId,async()=>{
    const isCurrent=()=>submittedEpoch===boardEpoch&&submittedMatchId===Number(matchId);
    let record;
    try{record=await recordPromise}catch(error){
      if(isCurrent()){
        offlineMode=true;offlineConflict=true;
        updateMatchActions();
        setConnectionStatus("Local recovery could not save this move. It was not sent; keep this match open.","offline");
        setStatus("Move is visible locally, but recovery storage failed. Do not refresh this page.","waiting");
      }else setConnectionStatus("A move from the previous match could not be saved locally. Reopen that match for recovery review.","recovery");
      return false;
    }
    if(offlineAtMove||offlineMode||navigator.onLine===false){
      if(isCurrent()){
        offlineMode=true;offlineConflict=offlineConflict||record.sync.status==="conflict";
        updateMatchActions();
        setConnectionStatus("Connection lost. This move is unconfirmed; further moves are paused until the server position is recovered.","offline");
        setStatus(terminal?"The local result is unverified and is not official.":"The move is saved for recovery, but the opponent cannot see it yet.","waiting");
        scheduleMatchPolling();
      }
      return false;
    }
    if(offlineConflict){
      if(isCurrent()){setConnectionStatus("Saved local history conflicts with the server · result is unverified.","offline");setStatus("Move saved locally but not sent because this match needs recovery.","waiting")}
      return false;
    }
    if(isCurrent())setConnectionStatus("");
    const controller=new AbortController();
    const requestTimeout=setTimeout(()=>controller.abort(),MOVE_SYNC_TIMEOUT_MS);
    let r;
    try{r=await api("/api/chess/"+submittedMatchId+"/move",{method:"POST",body:{from,to,promotion:promotion||"q",expectedFen:entry.fenBefore,expectedPly:chessPlyFromFen(entry.fenBefore)},signal:controller.signal})}
    finally{clearTimeout(requestTimeout)}
    if(!r.ok&&r.status===0){
      await updateOfflineRecord(submittedMatchId,current=>{if(!current)return null;current.sync={...(current.sync||{}),status:"pending",lastError:r.data.message||"The server is offline."};current.updatedAt=Date.now();return current}).catch(()=>{});
      if(isCurrent()){
        offlineMode=true;retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));lastConnectionError=r.data.message||"The server is offline.";
        pauseForRealtimeLoss("Server confirmation is unavailable. Gameplay and clocks are paused until both players reconnect.");
        setConnectionStatus("Server confirmation is pending. Further moves are paused until synchronization returns.","offline");
        setStatus(terminal?"The local result is unverified and is not official.":"This move is saved for recovery; the opponent cannot see it yet.","waiting");scheduleMatchPolling();
      }
      return false;
    }
    if(!r.ok){
      if(r.status===400)flashIllegalMove(from,to);
      return recoverRejectedMove(submittedMatchId,submittedEpoch,versionAtSubmit,entry,nextState,r.data,r.data.message||"The server rejected this move.");
    }
    const confirmedState=r.data.match||r.data;
    if(!positionInHistory(nextState,confirmedState)){
      if(r.data&&r.data.timeout===true){
        return recoverRejectedMove(submittedMatchId,submittedEpoch,versionAtSubmit,entry,nextState,r.data,"The server clock expired before this move was accepted.");
      }
      const refreshed=await api("/api/chess/"+submittedMatchId);
      const latest=refreshed.ok&&refreshed.data&&refreshed.data.match&&Number(refreshed.data.match.matchId)===submittedMatchId
        ?refreshed.data.match:confirmedState;
      if(positionInHistory(nextState,latest)){
        if(isCurrent())notifyNativeEngineOfConfirmedMove(submittedMatchId,entry,latest);
        await acceptMoveSnapshot(submittedMatchId,submittedEpoch,versionAtSubmit,latest);
        return true;
      }
      await markOfflineConflict(submittedMatchId,"The successful move response did not contain the submitted move.",latest);
      if(isCurrent()){
        offlineMode=true;offlineConflict=true;
        if(stateVersion===versionAtSubmit)applyState(latest);else loadMatch();
        updateMatchActions();
        setConnectionStatus("The server returned a different position. The official board was restored; local move evidence is preserved for review.","offline");
        setStatus("This move was not confirmed. Play is paused until the saved history is reconciled.","waiting");
      }
      return false;
    }
    if(isCurrent())notifyNativeEngineOfConfirmedMove(submittedMatchId,entry,confirmedState);
    await acceptMoveSnapshot(submittedMatchId,submittedEpoch,versionAtSubmit,confirmedState);
    return true;
  }).catch(error=>{
    console.error("Chess move synchronization failed:",error);
    if(submittedEpoch===boardEpoch&&submittedMatchId===Number(matchId)){
      offlineMode=true;offlineConflict=false;
      pauseForRealtimeLoss("Move confirmation failed. Gameplay and clocks are paused while the server position is recovered.");
      setConnectionStatus("Move confirmation failed. Further moves are paused while the server position is recovered.","offline");
      setStatus("Do not continue until this match synchronizes with the server.","waiting");
      scheduleMatchPolling();
    }
    return false;
  });
}
function markOfflineConflict(id,message,serverMatch){
  return updateOfflineRecord(id,record=>{
    if(!record)return null;
    if(serverMatch)record.serverSnapshot=matchSnapshot(serverMatch);
    record.sync={...(record.sync||{}),status:"conflict",lastError:String(message||"Local match history needs review."),attempts:Number(record.sync?.attempts||0)+1,lastAttemptAt:Date.now()};
    record.updatedAt=Date.now();return record;
  });
}
function applyState(m){
  if(!m)return;
  if(m.matchId&&Number(m.matchId)!==Number(matchId))return;
  const previousPlayerColor=playerColor;
  if(state&&state.fen!==m.fen){selectedSquare=null;legalTargets=[];clearIllegalFeedback();cancelPromotion();clearDragVisual();dragState=null}
  stateVersion++;
  state=m; playerColor=m.playerColor||playerColor;
  if(nativeLegalMoveCache){
    const cachedPly=nativeLegalMoveCache.ply,currentPly=chessPlyFromFen(m.fen);
    if(nativeLegalMoveCache.matchId!==Number(matchId)||currentPly>cachedPly||
       (currentPly===cachedPly&&nativeLegalMoveCache.fen!==m.fen)||
       (currentPly<cachedPly&&cachedPly!==currentPly+1))nativeLegalMoveCache=null;
  }
  if(m.connectionPaused||m.status!=="active"||offlineMode||offlineConflict){
    queuedPremove=null;
    if(cancelPremoveButton){cancelPremoveButton.hidden=true;cancelPremoveButton.classList.add("hidden")}
  }
  if(m.playerColor&&(!orientationSet||previousPlayerColor!==m.playerColor)){boardFlipped=m.playerColor==="b";orientationSet=true;positionPlayerBars()} localWhiteMs=Number(m.whiteTimeMs||0);localBlackMs=Number(m.blackTimeMs||0);localClockAt=monotonicNow();
  const check=m.checkSquare?" · CHECK":"";
  const pausedMessage=m.connectionPaused
    ?(m.connectionPauseReason==="integrity"?"Game paused by the server while it verifies the official position.":"Connection interrupted. The server has paused this game for both players while it restores the connection.")
    :null;
  const liveWarning=!realtimeMatchReady&&m.status==="active"?"Waiting for both players to establish the live match connection. Official play is paused.":null;
  setInfo();setPlayers();setStatus(pausedMessage||liveWarning||(m.status==="active"?(m.activeColor===playerColor?"Your turn":"Opponent's turn")+check:(m.status==="waiting"?"Searching for an opponent…":m.status==="settling"?"Settling result…":m.status==="cancelled"?"Search cancelled":"Game finished")),m.connectionPaused||liveWarning||m.status==="waiting"||m.status==="settling"?"waiting":"ready");
  if(m.connectionPaused)setConnectionStatus(pausedMessage,"recovery");
  else if(liveWarning)setConnectionStatus(liveWarning,"offline");
  else if(realtimeMatchReady&&!offlineMode&&!offlineConflict)setConnectionStatus("");
  if(m.status==="waiting"){
    const turnMessage=document.getElementById("turnMessage");
    const bracket=m.ratingBracket;
    if(turnMessage)turnMessage.textContent=bracket
      ? "Searching within your " + bracket.minimum + "–" + bracket.maximum + " chess rating bracket, with the same clock and stake. Your stake is locked while you search."
      : "Searching for a chess player with the same settings. Your stake is locked while you search.";
  }
  updateMatchActions();renderBoard();
  if(m.result)showGameOver(m.result,m.winnerId);
  if(drawPanelElement)drawPanelElement.classList.toggle("hidden",!m.drawOfferUserId||Number(m.drawOfferUserId)===Number(getUserId()));
  persistServerSnapshot(m).catch(()=>setConnectionStatus("Match loaded, but local recovery storage is unavailable.","recovery"));
  scheduleMatchPolling();
  const premove=queuedPremove&&m.status==="active"&&!m.connectionPaused&&m.activeColor===playerColor&&m.fen!==queuedPremove.queuedFen
    ?{...queuedPremove}:null;
  if(premove){
    queuedPremove=null;
    if(cancelPremoveButton){cancelPremoveButton.hidden=true;cancelPremoveButton.classList.add("hidden")}
    renderBoard();
    setStatus("Checking your queued premove against the confirmed position…","waiting");
    Promise.resolve().then(()=>sendMove(premove.from,premove.to,premove.promotion)).then(accepted=>{
      if(!accepted&&Number(matchId)===Number(m.matchId)&&state&&state.status==="active"&&state.activeColor===playerColor)
        setStatus("Premove cancelled because it is no longer legal after the opponent’s move.","waiting");
    });
  }
}
function getUserId(){
  const saved=Number(localStorage.getItem("goalGambitUserId")||0);
  if(saved)return saved;
  try{const part=token().split(".")[1];return Number(JSON.parse(atob(part.replace(/-/g,"+").replace(/_/g,"/"))).userId||0)}catch(_){return 0}
}
function sameSavedPosition(left,right){
  return !!left&&!!right&&left.fen===right.fen&&(left.pgn||"")===(right.pgn||"");
}
function pgnPosition(position){
  if(!position||!position.fen)return null;
  try{
    const chess=new Chess();
    let initialFen=DEFAULT_CHESS_FEN;
    if(position.pgn){
      chess.loadPgn(position.pgn);
      const headers=chess.getHeaders();
      const fenHeader=Object.keys(headers).find(key=>key.toLowerCase()==="fen");
      initialFen=fenHeader?headers[fenHeader]:DEFAULT_CHESS_FEN;
    }else{
      chess.load(position.fen);
      initialFen=position.fen;
    }
    if(chess.fen()!==position.fen)return null;
    const moves=chess.history({verbose:true}).map(move=>move.from+move.to+(move.promotion||""));
    return {initialFen,moves};
  }catch(_){return null}
}
function positionInHistory(ancestor,descendant){
  if(!ancestor||!descendant)return false;
  const ancestorId=Number(ancestor.matchId||0),descendantId=Number(descendant.matchId||0);
  if(ancestorId&&descendantId&&ancestorId!==descendantId)return false;
  if(sameSavedPosition(ancestor,descendant))return true;
  const first=pgnPosition(ancestor),later=pgnPosition(descendant);
  if(!first||!later||first.initialFen!==later.initialFen||first.moves.length>later.moves.length)return false;
  return first.moves.every((move,index)=>move===later.moves[index]);
}
function lastMatchingLocalMoveIndex(moves,match){
  let matchIndex=-1;
  for(let index=0;index<moves.length;index++){
    const move=moves[index];
    if(positionInHistory({matchId:match.matchId,fen:move.fenAfter,pgn:move.pgnAfter},match))matchIndex=index;
  }
  return matchIndex;
}
async function restoreOfflineMatch(id){
  const record=await readOfflineRecord(id);
  if(!record||Number(record.matchId)!==Number(id)||Number(record.userId)!==Number(getUserId())||!record.latest)return false;
  const restored={...record.latest};
  const elapsed=Math.max(0,Date.now()-Number(restored.savedAt||record.updatedAt||Date.now()));
  if(restored.status==="active"){
    if(restored.activeColor==="w")restored.whiteTimeMs=Math.max(0,Number(restored.whiteTimeMs||0)-elapsed);
    else restored.blackTimeMs=Math.max(0,Number(restored.blackTimeMs||0)-elapsed);
    if((restored.activeColor==="w"?restored.whiteTimeMs:restored.blackTimeMs)<=0){
      restored.status="offline_pending";restored.claimedResult=restored.activeColor==="w"?"black_win":"white_win";restored.terminationReason="timeout";
      record.claimedResult=restored.claimedResult;record.terminationReason="timeout";record.latest=restored;record.sync.status="awaiting-verification";
      writeOfflineRecord(record).catch(()=>{});
    }
  }
  matchId=Number(id);state=restored;playerColor=record.playerColor||restored.playerColor||playerColor;
  localWhiteMs=Number(restored.whiteTimeMs||0);localBlackMs=Number(restored.blackTimeMs||0);localClockAt=monotonicNow();
  offlineMode=true;offlineConflict=record.sync?.status==="conflict"||record.sync?.status==="awaiting-verification";
  setInfo();setPlayers();updateMatchActions();renderBoard();
  setConnectionStatus(offlineConflict?"Saved match history needs server review; moves are paused.":"Saved local position is unconfirmed. Moves are paused until the server position is recovered.","offline");
  setStatus(restored.status==="offline_pending"?"The local result is unverified and is not official.":"This saved board is not synchronized with your opponent.","waiting");
  scheduleMatchPolling();
  return true;
}
async function reconcileServerMatch(serverMatch){
  const recoveryMatchId=Number(matchId),recoveryEpoch=boardEpoch;
  const isCurrentRecovery=()=>recoveryEpoch===boardEpoch&&recoveryMatchId===Number(matchId);
  if(!Number.isInteger(recoveryMatchId)||recoveryMatchId<=0||Number(serverMatch?.matchId)!==recoveryMatchId)return false;
  const record=await readOfflineRecord(recoveryMatchId);
  if(!isCurrentRecovery())return false;
  const pending=(record?.moves||[]).filter(move=>!move.serverAcknowledged&&!move.rejected);
  if(record&&!pending.length&&record.claimedResult&&record.latest?.status==="offline_pending"){
    if(serverMatch.status==="completed"&&serverMatch.result===record.claimedResult&&sameSavedPosition(record.latest,serverMatch)){
      const snapshot=matchSnapshot(serverMatch);
      await updateOfflineRecord(recoveryMatchId,current=>{
        if(!current)return null;
        current.serverSnapshot=snapshot;current.baseline=snapshot;current.latest=snapshot;
        current.sync={...(current.sync||{}),status:"synced",lastError:""};current.updatedAt=Date.now();return current;
      });
      if(!isCurrentRecovery())return false;
      offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
      applyState(serverMatch);return true;
    }
    await markOfflineConflict(recoveryMatchId,"The locally observed clock result does not match a completed server result.",serverMatch);
    if(!isCurrentRecovery())return false;
    offlineMode=true;offlineConflict=true;
    setConnectionStatus("The server result differs from the local clock claim · saved evidence needs review.","offline");
    setStatus("The server could not confirm the local clock result. The saved match is preserved for review.","waiting");
    return false;
  }
  if(!record||!pending.length){
    offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
    applyState(serverMatch);return true;
  }
  const acceptedMove=(record.moves||[]).find(move=>!move.serverAcknowledged&&!move.rejected&&
    positionInHistory({matchId:serverMatch.matchId,fen:move.fenAfter,pgn:move.pgnAfter},serverMatch));
  if(positionInHistory(record.latest,serverMatch)||acceptedMove){
    await acknowledgeLocalMoves(serverMatch);
    if(!isCurrentRecovery())return false;
    offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
    applyState(serverMatch);return true;
  }
  await markOfflineConflict(recoveryMatchId,"The server did not confirm the saved offline move. It was not resubmitted.",serverMatch);
  if(!isCurrentRecovery())return false;
  offlineMode=true;offlineConflict=true;
  applyState(serverMatch);
  updateMatchActions();
  setConnectionStatus("The server did not confirm the saved move. The official board was restored; local evidence is preserved for review.","offline");
  setStatus("This move was not resubmitted and is not official. Review the saved move before continuing.","waiting");
  return false;
}
async function loadMatch(){
  const requestedMatchId=Number(matchId),requestedEpoch=boardEpoch;
  if(!Number.isInteger(requestedMatchId)||requestedMatchId<=0)return;

  if(activeRefresh){
    if(activeRefresh.matchId===requestedMatchId&&activeRefresh.epoch===requestedEpoch){
      refreshQueued=true;
      return activeRefresh.promise;
    }
    activeRefresh.controller.abort();
    await activeRefresh.promise;
    if(requestedEpoch!==boardEpoch||requestedMatchId!==Number(matchId))return;
  }

  const refresh={matchId:requestedMatchId,epoch:requestedEpoch,controller:null,promise:null};
  refresh.promise=(async()=>{
    do{
      refreshQueued=false;
      const versionAtRequest=stateVersion;
      refresh.controller=new AbortController();
      const r=await api("/api/chess/"+requestedMatchId,{signal:refresh.controller.signal});
      if(requestedEpoch!==boardEpoch||requestedMatchId!==Number(matchId))return;
      if(r.ok){
        retryDelayMs=2000;lastConnectionError="";
        const activeMatch=r.data.match?.status==="active";
        if(activeMatch&&r.data.connectionReady===false){
          pauseForRealtimeLoss("Waiting for both players to establish the live match connection. Official play is paused.");
        }
        if(stateVersion===versionAtRequest){
          const synchronized=await reconcileServerMatch(r.data.match);
          if(activeMatch&&r.data.connectionReady===true&&synchronized&&socket&&socket.connected&&navigator.onLine!==false&&!offlineMode&&!offlineConflict&&!r.data.match.connectionPaused){
            realtimeMatchReady=true;
            updateMatchActions();updateClocks();
            applyState(r.data.match);
          }
        }else refreshQueued=true;
      }else if(r.status!==0){
        setStatus(r.data.message||"Could not load this chess match. Return to chess and start a new match.","waiting");
      }else{
        offlineMode=true;retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));lastConnectionError=r.data.message||"The server is offline.";
        updateMatchActions();
        setConnectionStatus("Server unavailable. Moves are paused until synchronization is restored.","offline");
        if(!state)await restoreOfflineMatch(requestedMatchId);
        else setStatus("Connection lost. Your saved local board is still available.","waiting");
      }
    }while(refreshQueued&&requestedEpoch===boardEpoch&&requestedMatchId===Number(matchId));
  })();
  activeRefresh=refresh;
  try{
    await refresh.promise;
  }finally{
    if(activeRefresh===refresh)activeRefresh=null;
    if(requestedEpoch===boardEpoch&&requestedMatchId===Number(matchId))scheduleMatchPolling();
  }
}
function createOrJoin(){
  if(createOrJoinPromise)return createOrJoinPromise;
  const operation=(async()=>{
  if(!token()){setStatus("Log in required.","waiting");setTimeout(()=>location.href="login.html",1200);return}
  if(matchId){await loadMatch();return}
  if(await restoreSavedMatch())return;
  const speed=(config.rankedMode||"rapid").toLowerCase(); const tc=config.timeControl||({rapid:"10+5",blitz:"3+2",bullet:"1+1"}[speed]||"10+5");
  setStatus("Checking your wallet…","waiting");
  const created=await api("/api/chess/create",{method:"POST",body:{matchType:config.tournamentMode?"tournament":"ranked",speed,stake:Number(config.rankedStake||0),timeControl:tc}});
  if(created.ok){
    setMatchId(created.data.match.matchId);
    rememberMatch(matchId);
    applyState(created.data.match);
  } else {
    const msg=created.data.message||"Unable to create match.";
    setStatus(msg,"waiting");
    if(/insufficient/i.test(msg)){setTimeout(()=>{alert(msg+"\nDeposit funds in your wallet to play.");location.href="wallet.html"},600)}
  }
  })();
  createOrJoinPromise=operation;
  operation.then(()=>{if(createOrJoinPromise===operation)createOrJoinPromise=null},()=>{if(createOrJoinPromise===operation)createOrJoinPromise=null});
  return operation;
}
function rememberMatch(id){
  localStorage.setItem("goalGambitChessMatchId",String(id));
  try{const u=new URL(location.href);u.searchParams.set("matchId",String(id));history.replaceState(null,"",u.toString())}catch(_){}
}
async function restoreSavedMatch(){
  const savedId=Number(localStorage.getItem("goalGambitChessMatchId")||0);
  if(!Number.isInteger(savedId)||savedId<=0)return false;
  const requestEpoch=boardEpoch;
  setStatus("Reconnecting to your previous chess match…","waiting");
  const r=await api("/api/chess/"+savedId);
  if(requestEpoch!==boardEpoch)return true;
  const m=r.data&&r.data.match;
  if(r.ok&&m){
    if(["waiting","active","settling"].includes(m.status)){
      setMatchId(savedId);
      const timeControl=m.timeControl||config.timeControl;
      config={...config,rankedMode:speedForTimeControl(timeControl),tournamentMode:m.matchType==="tournament",rankedStake:Number(m.stake||0),timeControl};
      rememberMatch(savedId);
      applyState(m);
      return true;
    }
    localStorage.removeItem("goalGambitChessMatchId");
    return false;
  }
  if(r.status===403||r.status===404){
    localStorage.removeItem("goalGambitChessMatchId");
    return false;
  }
  if(r.status===0){
    setMatchId(savedId);
    if(await restoreOfflineMatch(savedId))return true;
  }
  setStatus((r.data&&r.data.message)||"Could not reconnect to the previous match. Check the server connection before starting another search.","waiting");
  return true;
}
async function cancelSearch(){
  if(!matchId||!state||state.status!=="waiting")return;
  if(!confirm("Cancel this search? Any locked stake will be refunded."))return;
  cancelPending=true;updateMatchActions();
  try{
    const r=await api("/api/chess/"+matchId+"/cancel",{method:"POST"});
    if(r.ok){if(Number(localStorage.getItem("goalGambitChessMatchId"))===Number(matchId))localStorage.removeItem("goalGambitChessMatchId");location.href="chess.html"}
    else setStatus(r.data.message||"Could not cancel the search.","waiting");
  }catch(_){setStatus("Could not reach the server. Your search is still active.","waiting")}
  finally{cancelPending=false;updateMatchActions()}
}
function updateMatchActions(){
  const waiting=!!state&&state.status==="waiting"&&!offlineMode&&navigator.onLine!==false;
  const active=!!state&&realtimeMatchReady&&state.status==="active"&&!state.connectionPaused&&!offlineMode&&!offlineConflict&&navigator.onLine!==false;
  if(cancelSearchButton){cancelSearchButton.hidden=!waiting;cancelSearchButton.classList.toggle("hidden",!waiting);cancelSearchButton.disabled=cancelPending}
  if(drawButton){drawButton.hidden=!active;drawButton.disabled=!active}
  if(resignButton){resignButton.hidden=!active;resignButton.disabled=!active||resignPending}
}
function cleanupSocket(){
  realtimeMatchReady=false;
  if(!socket)return;
  const previous=socket;
  socket=null;socketMatchId=null;
  if(typeof previous.removeAllListeners==="function")previous.removeAllListeners();
  if(typeof previous.disconnect==="function")previous.disconnect();
}
function setMatchId(value){
  const next=Number(value)||null;
  if(next===matchId)return false;
  boardEpoch++;stateVersion++;refreshQueued=false;
  if(activeRefresh&&activeRefresh.controller)activeRefresh.controller.abort();
  if(pollTimer){clearTimeout(pollTimer);pollTimer=null}
  cleanupSocket();
  clearIllegalFeedback();cancelPromotion();
  queuedPremove=null;
  if(cancelPremoveButton){cancelPremoveButton.hidden=true;cancelPremoveButton.classList.add("hidden")}
  matchId=next;state=null;selectedSquare=null;legalTargets=[];nativeLegalMoveCache=null;
  realtimeMatchReady=false;
  offlineMode=false;offlineConflict=false;
  localWhiteMs=0;localBlackMs=0;localClockAt=0;orientationSet=false;
  setInfo();updateMatchActions();renderBoard();
  return true;
}
function isCurrentMatchSocket(candidate,id,epoch){
  return socket===candidate&&socketMatchId===id&&Number(matchId)===id&&boardEpoch===epoch;
}
function setupSocket(){
  const targetMatchId=Number(matchId);
  if(!Number.isInteger(targetMatchId)||targetMatchId<=0||!token())return;
  if(socket&&socketMatchId===targetMatchId)return;
  cleanupSocket();
  if(!window.io){pauseForRealtimeLoss("Live match connectivity is unavailable. Official play is paused.");scheduleMatchPolling();return}
  const epoch=boardEpoch;
  try{
    const candidate=window.io(apiBase()||location.origin,{auth:{token:token()},transports:["websocket","polling"]});
    socket=candidate;socketMatchId=targetMatchId;
    realtimeMatchReady=false;
    const isCurrent=()=>isCurrentMatchSocket(candidate,targetMatchId,epoch);
    candidate.on("connect",()=>{
      if(!isCurrent())return;
      realtimeMatchReady=false;
      updateMatchActions();updateClocks();
      candidate.emit("chess:join",{matchId:targetMatchId});
      candidate.emit("chess:engine:watch",{matchId:targetMatchId});
      loadMatch();
      scheduleMatchPolling();
    });
    candidate.on("chess:joined",data=>{
      if(!isCurrent()||!data||data.success!==true||Number(data.matchId)!==targetMatchId)return;
      if(candidate.connected&&data.connectionReady){loadMatch()}
      else pauseForRealtimeLoss("Waiting for both players to reconnect to this match. Official play is paused.");
    });
    candidate.on("chess:connection_ready",data=>{
      if(!isCurrent()||!data||data.success!==true||Number(data.matchId)!==targetMatchId||!candidate.connected)return;
      loadMatch();
    });
    candidate.on("chess:error",data=>{
      if(!isCurrent())return;
      pauseForRealtimeLoss(data&&data.message||"The server did not authorize this live match connection.");
    });
    candidate.on("disconnect",()=>{
      if(!isCurrent())return;
      pauseForRealtimeLoss("Live match connection lost. Gameplay and clocks are paused while both players reconnect.");
      scheduleMatchPolling();
    });
    candidate.on("connect_error",()=>{
      if(!isCurrent())return;
      pauseForRealtimeLoss("The live match server cannot be reached. Gameplay is paused until reconnection.");
      scheduleMatchPolling();
    });
    candidate.on("chess:engine:status",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      setCompanionEngineStatus(data&&data.available?"Native Android chess engine connected":"",Boolean(data&&data.available));
    });
    candidate.on("chess:engine:result",data=>{
      if(isCurrent())handleNativeEngineResult(data);
    });
    candidate.on("chess:engine:prediction",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      handleNativeEnginePrediction(data);
    });
    candidate.on("chess:move",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      if(Number(data.actorUserId)===Number(getUserId()))return;
      loadMatch();
    });
    const handleAuthoritativePause=data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      pauseForRealtimeLoss(data.connectionPauseReason==="integrity"
        ?"Game paused by the server while it verifies the official position."
        :"Connection interrupted. The server has paused this game for both players while it restores the connection.");
      clearPremove();
      if(state){
        state={...state,connectionPaused:true,connectionPauseReason:data.connectionPauseReason||"connection"};
        updateMatchActions();updateClocks();
      }
      loadMatch();
    };
    candidate.on("chess:paused",handleAuthoritativePause);
    candidate.on("chess:integrity_paused",handleAuthoritativePause);
    candidate.on("chess:resumed",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      loadMatch();
    });
    candidate.on("chess:integrity_warning",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      pauseForRealtimeLoss("The server is checking the official chess position.");
      clearPremove();updateMatchActions();updateClocks();
      setConnectionStatus("The server is checking the official chess position.","recovery");
      loadMatch();
    });
    candidate.on("chess:match_ready",data=>{
      if(!isCurrent()||(data&&data.matchId!=null&&Number(data.matchId)!==targetMatchId))return;
      candidate.emit("chess:engine:watch",{matchId:targetMatchId});
      loadMatch();
    });
    candidate.on("chess:game_over",data=>{
      if(!isCurrent()||(data&&data.matchId!=null&&Number(data.matchId)!==targetMatchId))return;
      loadMatch();
    });
    candidate.on("chess:draw_offer",data=>{
      if(!isCurrent()||(data&&data.matchId!=null&&Number(data.matchId)!==targetMatchId))return;
      if(Number(data&&data.userId)!==Number(getUserId())&&drawPanelElement)drawPanelElement.classList.remove("hidden");
    });
  }catch(e){console.warn(e);cleanupSocket();pauseForRealtimeLoss("The live match connection could not be started. Official play is paused.")}
  scheduleMatchPolling();
}
function scheduleMatchPolling(){
  if(pollTimer){clearTimeout(pollTimer);pollTimer=null}
  if(!matchId||!state||!(state.status==="waiting"||state.status==="active"||(offlineMode&&state.status==="offline_pending"))||document.hidden||offlineConflict)return;
  const interval=socket&&socket.connected&&realtimeMatchReady?10000:2000;
  const scheduledMatchId=Number(matchId),scheduledEpoch=boardEpoch;
  pollTimer=setTimeout(()=>{
    pollTimer=null;
    if(!document.hidden&&scheduledEpoch===boardEpoch&&scheduledMatchId===Number(matchId))loadMatch();
  },interval);
}
function boardConfigurationKey(value){
  const targetId=Number(value&&value.matchId)||0;
  if(targetId>0)return "match:"+targetId;
  const c=value||{};
  return "search:"+[c.mode||"",c.rankedMode||c.speed||"",Number(c.rankedStake||0),c.timeControl||"",Boolean(c.tournamentMode),c.tournamentId||""].join("|");
}
function initializeBoard(nextConfig){
  const requestedConfig=nextConfig&&typeof nextConfig==="object"?nextConfig:{};
  const key=boardConfigurationKey(requestedConfig);
  if(initializationKey===key){
    if(initializationPromise)return initializationPromise;
    setupSocket();
    return Promise.resolve();
  }
  const previous=initializationPromise;
  initializationKey=key;
  const operation=(async()=>{
    if(previous){try{await previous}catch(_){}}
    if(initializationKey!==key)return;
    config=requestedConfig;
    const requestedMatchId=Number(config.matchId)||0;
    if(requestedMatchId>0)setMatchId(requestedMatchId);
    else if(state&&(state.status==="completed"||state.status==="cancelled"))setMatchId(null);
    if(config.player&&config.player.color)playerColor=config.player.color;
    setInfo();
    await createOrJoin();
    if(initializationKey===key)setupSocket();
  })();
  initializationPromise=operation;
  operation.then(()=>{if(initializationPromise===operation)initializationPromise=null},error=>{
    if(initializationPromise===operation)initializationPromise=null;
    console.error("Chess board initialization failed:",error);
  });
  return operation;
}
function showGameOver(result,winnerId){
  if(Number(localStorage.getItem("goalGambitChessMatchId"))===Number(matchId))localStorage.removeItem("goalGambitChessMatchId");
  if(gameOverModal)gameOverModal.classList.remove("hidden");
  const me=getUserId();const win=winnerId&&Number(winnerId)===me;
  if(gameOverTitleElement)gameOverTitleElement.textContent=result==="draw"?"Draw":win?"You Win":"You Lose";
  if(gameOverMessageElement)gameOverMessageElement.textContent=result==="draw"?"The match ended in a draw.":win?"Congratulations — the server has settled the match.":"The match has ended. The server has settled the result.";
}
async function resign(){if(!matchId||!state||state.status!=="active"||!realtimeMatchReady)return;if(!confirm("Resign this match? It will be recorded as a loss and the match will be settled."))return;resignPending=true;updateMatchActions();try{const r=await api("/api/chess/"+matchId+"/resign",{method:"POST"});if(r.ok)applyState(r.data.match);else setStatus(r.data.message||"Unable to resign.","waiting")}catch(_){setStatus("Could not reach the server. The match is still active.","waiting")}finally{resignPending=false;updateMatchActions()}}
async function offerDraw(){if(!matchId||!state||state.status!=="active"||!realtimeMatchReady)return;const r=await api("/api/chess/"+matchId+"/draw",{method:"POST"});setStatus(r.data.message||(r.ok?"Draw offer sent.":"Unable to offer a draw."),r.ok?"ready":"waiting")}
async function respondDraw(accept){if(!matchId||!realtimeMatchReady)return;const r=await api("/api/chess/"+matchId+"/draw/respond",{method:"POST",body:{accept}});if(r.ok&&r.data.match)applyState(r.data.match);if(drawPanelElement)drawPanelElement.classList.add("hidden")}

if(flipButton)flipButton.addEventListener("click",()=>{boardFlipped=!boardFlipped;renderBoard()});
if(cancelSearchButton)cancelSearchButton.addEventListener("click",cancelSearch);
if(cancelPremoveButton)cancelPremoveButton.addEventListener("click",()=>clearPremove("Premove cancelled."));
if(resignButton)resignButton.addEventListener("click",resign);
if(drawButton)drawButton.addEventListener("click",offerDraw);
if(acceptDrawButton)acceptDrawButton.addEventListener("click",()=>respondDraw(true));
if(declineDrawButton)declineDrawButton.addEventListener("click",()=>respondDraw(false));
if(returnDashboardButton)returnDashboardButton.addEventListener("click",()=>location.href="chess.html");
Object.entries(promotionButtons).forEach(([piece,button])=>{if(button)button.addEventListener("click",()=>choosePromotion(piece))});
if(cancelPromotionButton)cancelPromotionButton.addEventListener("click",cancelPromotion);
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&pendingPromotion)cancelPromotion()});
window.addEventListener("online",()=>{
  retryDelayMs=2000;
  if(matchId&&socket&&socket.connected){
    realtimeMatchReady=false;updateMatchActions();updateClocks();
    socket.emit("chess:join",{matchId:Number(matchId)});
    socket.emit("chess:engine:watch",{matchId:Number(matchId)});
  }else if(matchId&&!socket)setupSocket();
  if(matchId)loadMatch();
});
window.addEventListener("offline",()=>{
  offlineMode=true;clearPremove();
  pauseForRealtimeLoss("Connection lost. Gameplay and clocks are paused until the server position is recovered.");
  setStatus("Do not continue this match until synchronization returns.","waiting");
  scheduleMatchPolling();
});
window.addEventListener("beforeunload",event=>{
  if(pendingMovePersistence>0){event.preventDefault();event.returnValue=""}
});
window.addEventListener("gg-chess-socket-ready",()=>setupSocket());
window.addEventListener("message",event=>{if(!event.data||event.data.type!=="GOAL_GAMBIT_INIT")return;initializeBoard(event.data.config||{}).catch(error=>console.error("Chess board initialization failed:",error));window.parent.postMessage({type:"GOAL_GAMBIT_BOARD_READY"},"*")});

registerChessServiceWorker();
setInfo(); renderBoard();
if(matchId)setStatus("Reconnecting to match…","waiting");
else if(window.parent!==window)setStatus("Waiting for match setup…","waiting");
else if(params.has("mode"))setStatus("Starting ranked match…","waiting");
else setStatus("Choose ranked match settings to begin.","ready");
(function startFromQuery(){
  // board.html?mode=rapid-ranked&minutes=10&increment=5&stake=50  (opened from the ranked / tournament pages)
  const mode=(params.get("mode")||"").toLowerCase();
  if(matchId||!mode||window.parent!==window)return;
  const speed=mode.split("-")[0];
  const minutes=Number(params.get("minutes")||0), inc=Number(params.get("increment")||0);
  config={rankedMode:speed,tournamentMode:mode.includes("tournament"),rankedStake:Number(params.get("stake")||0),timeControl:inc>0?minutes+"+"+inc:minutes+":00"};
  setInfo();
  createOrJoin().then(setupSocket);
})();
if(matchId){loadMatch().then(setupSocket)}else if(window.parent!==window)window.parent.postMessage({type:"GOAL_GAMBIT_BOARD_READY"},"*");
document.addEventListener("visibilitychange",()=>{
  if(document.hidden){scheduleMatchPolling();return}
  if(matchId)loadMatch();
  scheduleMatchPolling();
});
// Socket.IO is the primary update path. Poll at 10s when connected and at
// 2s while disconnected so missed events still recover quickly.
scheduleMatchPolling();
clockTimer=setInterval(updateClocks,250);
