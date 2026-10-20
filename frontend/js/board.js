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
let config = {};
let matchId = Number(params.get("matchId") || 0) || null;
let playerColor = "w";
let boardFlipped = false;
let selectedSquare = null;
let state = null;
let clockTimer = null;
let socket = null;
let socketMatchId = null;
let localWhiteMs = 0;
let localBlackMs = 0;
let localClockAt = 0;
let legalTargets = [];
let illegalSquares = new Set();
let illegalFeedbackTimer = null;
let pendingPromotion = null;
let movePending = false;
let cancelPending = false;
let resignPending = false;
let timeoutCheckAt = 0;
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
function apiBase(){
  const configured = window.GG_API_BASE || (window.GG && window.GG.API_BASE);
  if(configured) return String(configured).replace(/\/+$/, "");
  const h=location.hostname;
  const isLocal=h==="localhost"||h==="127.0.0.1";
  const frontendPorts=["3000","5173","5500","8080"];
  if(location.protocol==="file:"||(isLocal&&(!location.port||frontendPorts.includes(location.port)))) return "http://localhost:5000";
  return "";
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
    const unacknowledged=(record.moves||[]).filter(move=>!move.serverAcknowledged);
    record.serverSnapshot=snapshot;
    if(!unacknowledged.length){
      if(record.claimedResult&&["awaiting-verification","conflict"].includes(record.sync?.status)){
        record.updatedAt=Date.now();
        return record;
      }
      record.baseline=snapshot;record.latest=snapshot;
      record.sync={...(record.sync||{}),status:"synced",lastError:""};
    }else{
      const matching=(record.moves||[]).findIndex(move=>move.fenAfter===snapshot.fen&&move.pgnAfter===snapshot.pgn);
      if(matching>=0){
        record.moves.forEach((move,index)=>{if(index<=matching)move.serverAcknowledged=true});
        const pending=(record.moves||[]).some(move=>!move.serverAcknowledged);
        record.sync={...(record.sync||{}),status:pending?"pending":"synced",lastError:""};
        if(!pending)record.baseline=snapshot;
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
    const index=(record.moves||[]).findIndex(move=>move.fenAfter===match.fen&&move.pgnAfter===match.pgn);
    if(index>=0)record.moves.forEach((move,position)=>{if(position<=index)move.serverAcknowledged=true});
    const pending=(record.moves||[]).some(move=>!move.serverAcknowledged);
    record.serverSnapshot=matchSnapshot(match);
    record.sync={...(record.sync||{}),status:pending?"pending":"synced",lastError:""};
    if(!pending)record.baseline=record.serverSnapshot;
    record.updatedAt=Date.now();
    return record;
  });
}
function finishOfflineOnTime(reason){
  if(!state||state.status!=="active")return;
  const losingColor=state.activeColor;
  const finished={...state,whiteTimeMs:remaining("w"),blackTimeMs:remaining("b"),status:"offline_pending",result:null,claimedResult:losingColor==="w"?"black_win":"white_win",terminationReason:reason,savedAt:Date.now()};
  state=finished;stateVersion++;movePending=false;
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
  if(state&&state.activeColor===color&&state.status==="active"&&localClockAt) ms-=Date.now()-localClockAt;
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
function renderBoard(){
  if(!chessBoard)return;
  chessBoard.innerHTML="";
  const b=currentBoard();
  for(let vr=0;vr<8;vr++){
    for(let vc=0;vc<8;vc++){
      const r=boardFlipped?7-vr:vr, c=boardFlipped?7-vc:vc;
      const sq=document.createElement("button"); sq.type="button"; sq.className="square";
      sq.dataset.square=squareName(r,c);
      if((r+c)%2===0)sq.classList.add("light");else sq.classList.add("dark");
      if(selectedSquare===sq.dataset.square)sq.classList.add("selected");
      if(illegalSquares.has(sq.dataset.square))sq.classList.add("illegal-move");
      if(state?.lastMove&&(state.lastMove.from===sq.dataset.square||state.lastMove.to===sq.dataset.square))sq.classList.add("last-move");
      const target=legalTargets.find(x=>x.to===sq.dataset.square);
      if(target)sq.classList.add(target.capture?"possible-capture":"possible-move");
      if(state?.checkSquare===sq.dataset.square)sq.classList.add("in-check");
      const p=b[r][c];
      const label=sq.dataset.square+(p?" "+(p.color==="w"?"white ":"black ")+p.type:" empty")+(target?" legal move":"");
      sq.setAttribute("aria-label",label);
      if(p){const glyph=document.createElement("span");glyph.className="piece-glyph "+(p.color==="w"?"white-piece":"black-piece");glyph.textContent=symbols[p.color][p.type];sq.appendChild(glyph);}
      if(vr===7){const fileLabel=document.createElement("span");fileLabel.className="coord-file";fileLabel.textContent=files[c];sq.appendChild(fileLabel)}
      if(vc===0){const rankLabel=document.createElement("span");rankLabel.className="coord-rank";rankLabel.textContent=String(8-r);sq.appendChild(rankLabel)}
      sq.addEventListener("click",()=>clickSquare(sq.dataset.square)); chessBoard.appendChild(sq);
    }
  }
  renderMoves(); updateClocks();
}
function renderMoves(){
  if(!moveListElement)return;
  const pgn=state?.pgn||"";
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
  if(whiteClockElement){whiteClockElement.textContent=formatClock(white);whiteClockElement.classList.toggle("active",!!state&&state.status==="active"&&state.activeColor==="w");whiteClockElement.classList.toggle("critical",!!state&&state.status==="active"&&state.activeColor==="w"&&white<=10000)}
  if(blackClockElement){blackClockElement.textContent=formatClock(black);blackClockElement.classList.toggle("active",!!state&&state.status==="active"&&state.activeColor==="b");blackClockElement.classList.toggle("critical",!!state&&state.status==="active"&&state.activeColor==="b"&&black<=10000)}
  const active=state&&state.status==="active"?(state.activeColor==="w"?white:black):null;
  if(active!==null&&active<=0&&Date.now()-timeoutCheckAt>1000){
    timeoutCheckAt=Date.now();
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
  try{return state&&state.fen?new Chess(state.fen):null}
  catch(_){return null}
}
function selectPiece(sq){
  const chess=currentRulesPosition();
  if(!chess){setStatus("The current board could not be validated. Refresh the match before moving.","waiting");return}
  const piece=chess.get(sq);
  const movableColor=offlineMode?chess.turn():playerColor;
  selectedSquare=sq;
  legalTargets=piece&&piece.color===movableColor
    ?chess.moves({square:sq,verbose:true}).map(move=>({from:move.from,to:move.to,capture:Boolean(move.captured),flags:move.flags,san:move.san,promotion:move.promotion||null}))
    :[];
  renderBoard();
  const checkHint=chess.isCheck()?" You are in check; choose a move that protects your king.":"";
  setStatus(legalTargets.length?"Choose a highlighted legal square."+checkHint:(chess.isCheck()?"Check — this piece has no legal move that protects your king.":"That piece has no legal moves."),chess.isCheck()?"waiting":"ready");
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
  cancelPromotion();
  if(!isLegal){flashIllegalMove(move.from,move.to);setStatus("That promotion is not legal in the current position.","waiting");return}
  selectedSquare=null;legalTargets=[];renderBoard();
  return sendMove(move.from,move.to,piece);
}
function clickSquare(sq){
  if(!state||state.status!=="active"||(!offlineMode&&state.activeColor!==playerColor)||state.result||movePending)return;
  const b=currentBoard(),{r,c}=parseSquare(sq),p=b[r][c];
  const movableColor=offlineMode?state.activeColor:playerColor;
  if(selectedSquare){
    const targets=legalTargets.filter(move=>move.to===sq);
    if(targets.length){
      const from=selectedSquare;
      if(targets.some(move=>move.promotion)){openPromotionChooser(from,sq);return}
      selectedSquare=null;legalTargets=[];renderBoard();sendMove(from,sq);return;
    }
    if(p&&p.color===movableColor){selectPiece(sq);return}
    if(sq!==selectedSquare){flashIllegalMove(selectedSquare,sq);setStatus("That move is illegal. Choose a highlighted square.","waiting");return}
  }
  if(p&&p.color===movableColor){selectPiece(sq);return}
  selectedSquare=null;legalTargets=[];renderBoard();
}
async function sendMove(from,to,promotion){
  if(!state||state.status!=="active"||(!offlineMode&&state.activeColor!==playerColor)||movePending)return false;
  const chess=currentRulesPosition();
  if(!chess){setStatus("The current board could not be validated. Refresh the match before moving.","waiting");return false}
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
  const submittedMatchId=Number(matchId),submittedEpoch=boardEpoch;
  const movedAt=Date.now(),moverColor=state.activeColor;
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
    claimedResult:terminal?.result||null,terminationReason:terminal?.reason||null,savedAt:movedAt};
  const entry={actorColor:moverColor,actorUserId:moverColor===playerColor?getUserId():null,from:move.from,to:move.to,promotion:move.promotion||null,san:move.san,flags:move.flags,
    fenBefore:state.fen,pgnBefore:state.pgn||"",fenAfter:chess.fen(),pgnAfter:chess.pgn(),clocksBefore,clocksAfter,
    elapsedBeforeMoveMs:Math.max(0,movedAt-(localClockAt||movedAt)),movedAt:new Date(movedAt).toISOString(),before:matchSnapshot({...state,...clocksBefore})};
  state=nextState;stateVersion++;localWhiteMs=clocksAfter.whiteTimeMs;localBlackMs=clocksAfter.blackTimeMs;localClockAt=movedAt;
  const versionAtSubmit=stateVersion;
  selectedSquare=null;legalTargets=[];clearIllegalFeedback();movePending=true;
  setPlayers();renderBoard();setStatus(offlineMode?"Local move saved on this device.":"Move saved locally; confirming with the server…","ready");
  let record;
  try{record=await recordLocalMove(entry,nextState,terminal)}catch(error){
    state=stateBeforeMove(entry);localWhiteMs=clocksBefore.whiteTimeMs;localBlackMs=clocksBefore.blackTimeMs;localClockAt=movedAt;movePending=false;
    renderBoard();setStatus("This move could not be saved on this device, so it was not submitted.","waiting");
    setConnectionStatus("Local storage unavailable · match unchanged","offline");return false;
  }
  if(offlineMode||navigator.onLine===false){
    movePending=false;offlineMode=true;offlineConflict=offlineConflict||record.sync.status==="conflict";
    setConnectionStatus("Offline local board · opponent cannot see these moves; results are unverified.","offline");
    setStatus(terminal?"Local game finished — awaiting server verification.":"Local position saved. You can continue here, but it is not synchronized.","waiting");
    scheduleMatchPolling();return true;
  }
  setConnectionStatus("");
  const r=await api("/api/chess/"+submittedMatchId+"/move",{method:"POST",body:{from,to,promotion:promotion||"q"}});
  movePending=false;
  if(submittedEpoch!==boardEpoch||submittedMatchId!==Number(matchId))return false;
  if(!r.ok&&r.status===0){offlineMode=true;retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));lastConnectionError=r.data.message||"The server is offline.";
    setConnectionStatus("Offline local board · opponent cannot see these moves; results are unverified.","offline");
    setStatus(terminal?"Local game finished — awaiting server verification.":"Move saved locally. You can continue here, but it is not synchronized.","waiting");scheduleMatchPolling();return true}
  if(!r.ok){offlineMode=true;offlineConflict=true;await markOfflineConflict(submittedMatchId,r.data.message||"The server rejected this move history.");
    if(r.status===400)flashIllegalMove(from,to);setConnectionStatus("Saved local history conflicts with the server · result is unverified.","offline");setStatus(r.data.message||"Server could not verify this local move.","waiting");return false}
  const confirmedState=r.data.match||r.data;
  if(!sameSavedPosition(nextState,confirmedState)){
    await markOfflineConflict(submittedMatchId,"The server response did not confirm the locally saved move.",confirmedState);
    offlineMode=true;offlineConflict=true;
    applyState(confirmedState);
    setConnectionStatus("Server position differs from the saved move · local evidence is preserved for review.","offline");
    setStatus("The server did not confirm this move. Your local record was saved for review.","waiting");
    return false;
  }
  await acknowledgeLocalMoves(confirmedState);
  offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
  if(stateVersion===versionAtSubmit)applyState(confirmedState);
  else if(!sameAuthoritativeMatchState(state,confirmedState))loadMatch();
  return true;
}
function stateBeforeMove(entry){
  const before=entry.before||{};
  return {...state,...before,fen:entry.fenBefore,pgn:entry.pgnBefore,activeColor:entry.actorColor,status:"active",result:null,claimedResult:null};
}
function markOfflineConflict(id,message,serverMatch){
  return updateOfflineRecord(id,record=>{
    if(!record)return null;
    if(serverMatch)record.serverSnapshot=matchSnapshot(serverMatch);
    record.sync={...(record.sync||{}),status:"conflict",lastError:String(message||"Local match history needs review."),attempts:Number(record.sync?.attempts||0)+1,lastAttemptAt:Date.now()};
    record.updatedAt=Date.now();return record;
  });
}
function sameAuthoritativeMatchState(left,right){
  return !!left&&!!right&&Number(left.matchId)===Number(right.matchId)&&left.fen===right.fen&&left.pgn===right.pgn&&left.status===right.status&&left.result===right.result&&Number(left.winnerId||0)===Number(right.winnerId||0)&&left.activeColor===right.activeColor&&Number(left.drawOfferUserId||0)===Number(right.drawOfferUserId||0);
}
function applyState(m){
  if(!m)return;
  if(m.matchId&&Number(m.matchId)!==Number(matchId))return;
  if(state&&state.fen!==m.fen){selectedSquare=null;legalTargets=[];clearIllegalFeedback();cancelPromotion();movePending=false}
  stateVersion++;
  state=m; playerColor=m.playerColor||playerColor;
  if(!orientationSet&&m.playerColor){boardFlipped=m.playerColor==="b";orientationSet=true} localWhiteMs=Number(m.whiteTimeMs||0);localBlackMs=Number(m.blackTimeMs||0);localClockAt=Date.now();
  const check=m.checkSquare?" · CHECK":"";
  setInfo();setPlayers();setStatus(m.status==="active"?(m.activeColor===playerColor?"Your turn":"Opponent's turn")+check:(m.status==="waiting"?"Searching for an opponent…":m.status==="settling"?"Settling result…":m.status==="cancelled"?"Search cancelled":"Game finished"),m.status==="waiting"||m.status==="settling"?"waiting":"ready");
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
}
function getUserId(){
  const saved=Number(localStorage.getItem("goalGambitUserId")||0);
  if(saved)return saved;
  try{const part=token().split(".")[1];return Number(JSON.parse(atob(part.replace(/-/g,"+").replace(/_/g,"/"))).userId||0)}catch(_){return 0}
}
function sameSavedPosition(left,right){
  return !!left&&!!right&&left.fen===right.fen&&(left.pgn||"")===(right.pgn||"");
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
  localWhiteMs=Number(restored.whiteTimeMs||0);localBlackMs=Number(restored.blackTimeMs||0);localClockAt=Date.now();
  offlineMode=true;offlineConflict=record.sync?.status==="conflict"||record.sync?.status==="awaiting-verification";movePending=false;
  setInfo();setPlayers();updateMatchActions();renderBoard();
  setConnectionStatus(offlineConflict?"Saved local match · awaiting server review; result is not official.":"Offline local board · opponent cannot see these moves; results are unverified.","offline");
  setStatus(restored.status==="offline_pending"?"Local game finished — awaiting server verification.":"Saved local position restored. This board is not synchronized with your opponent.","waiting");
  scheduleMatchPolling();
  return true;
}
async function reconcileServerMatch(serverMatch){
  const record=await readOfflineRecord(matchId);
  const pending=(record?.moves||[]).filter(move=>!move.serverAcknowledged);
  if(record&&!pending.length&&record.claimedResult&&record.latest?.status==="offline_pending"){
    if(serverMatch.status==="completed"&&serverMatch.result===record.claimedResult&&sameSavedPosition(record.latest,serverMatch)){
      const snapshot=matchSnapshot(serverMatch);
      await updateOfflineRecord(matchId,current=>{
        if(!current)return null;
        current.serverSnapshot=snapshot;current.baseline=snapshot;current.latest=snapshot;
        current.sync={...(current.sync||{}),status:"synced",lastError:""};current.updatedAt=Date.now();return current;
      });
      offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
      applyState(serverMatch);return true;
    }
    await markOfflineConflict(matchId,"The locally observed clock result does not match a completed server result.",serverMatch);
    offlineMode=true;offlineConflict=true;movePending=false;
    setConnectionStatus("The server result differs from the local clock claim · saved evidence needs review.","offline");
    setStatus("The server could not confirm the local clock result. The saved match is preserved for review.","waiting");
    return false;
  }
  if(!record||!pending.length){
    offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
    applyState(serverMatch);return true;
  }
  if(sameSavedPosition(record.latest,serverMatch)){
    await acknowledgeLocalMoves(serverMatch);
    offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");
    applyState(serverMatch);return true;
  }
  const alreadyAccepted=(record.moves||[]).find(move=>!move.serverAcknowledged&&move.fenAfter===serverMatch.fen&&move.pgnAfter===(serverMatch.pgn||""));
  if(alreadyAccepted){
    await acknowledgeLocalMoves(serverMatch);
    return reconcileServerMatch(serverMatch);
  }
  const next=pending[0];
  const baselineMatches=sameSavedPosition(record.baseline,serverMatch)||sameSavedPosition({fen:next.fenBefore,pgn:next.pgnBefore},serverMatch);
  if(baselineMatches&&pending.length===1&&Number(next.actorUserId)===Number(getUserId())&&next.actorColor===serverMatch.activeColor&&serverMatch.status==="active"){
    setConnectionStatus("Connection restored · verifying the saved move…","recovery");
    await updateOfflineRecord(matchId,current=>{
      if(!current)return null;
      current.sync={...(current.sync||{}),status:"syncing",attempts:Number(current.sync?.attempts||0)+1,lastAttemptAt:Date.now(),lastError:""};
      current.updatedAt=Date.now();return current;
    });
    const response=await api("/api/chess/"+matchId+"/move",{method:"POST",body:{from:next.from,to:next.to,promotion:next.promotion||"q"}});
    if(response.ok){
      const confirmed=response.data.match||response.data;
      if(!sameSavedPosition({fen:next.fenAfter,pgn:next.pgnAfter},confirmed)){
        await markOfflineConflict(matchId,"The server response did not confirm the locally saved move.",confirmed);
        offlineMode=true;offlineConflict=true;movePending=false;
        applyState(confirmed);
        setConnectionStatus("Server position differs from the saved move · local evidence is preserved for review.","offline");
        setStatus("The server did not confirm this move. Your local record was saved for review.","waiting");
        return false;
      }
      await acknowledgeLocalMoves(confirmed);
      offlineMode=false;offlineConflict=false;retryDelayMs=2000;lastConnectionError="";setConnectionStatus("");applyState(confirmed);return true;
    }
    if(response.status===0){
      offlineMode=true;retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));lastConnectionError=response.data.message||"The server is offline.";
      await updateOfflineRecord(matchId,current=>{if(!current)return null;current.sync={...(current.sync||{}),status:"pending",lastError:lastConnectionError};current.updatedAt=Date.now();return current});
      setConnectionStatus("Move saved on this device · server confirmation is pending.","offline");
      return false;
    }
  }
  await markOfflineConflict(matchId,"The saved moves do not match the current server position or cannot be verified from this device.");
  offlineMode=true;offlineConflict=true;movePending=false;
  setConnectionStatus("Saved local history conflicts with the server · result is unverified.","offline");
  setStatus("Local game preserved. The server position differs, so no result was submitted.","waiting");
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
        if(stateVersion===versionAtRequest)await reconcileServerMatch(r.data.match);
        else refreshQueued=true;
      }else if(r.status!==0){
        setStatus(r.data.message||"Could not load this chess match. Return to chess and start a new match.","waiting");
      }else{
        offlineMode=true;retryDelayMs=Math.min(30000,Math.max(4000,retryDelayMs*2));lastConnectionError=r.data.message||"The server is offline.";
        setConnectionStatus("Server unavailable · local moves stay on this device and are unverified.","offline");
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
  const waiting=!!state&&state.status==="waiting"&&!offlineMode;
  const active=!!state&&state.status==="active"&&!offlineMode;
  if(cancelSearchButton){cancelSearchButton.hidden=!waiting;cancelSearchButton.classList.toggle("hidden",!waiting);cancelSearchButton.disabled=cancelPending}
  if(drawButton){drawButton.hidden=!active;drawButton.disabled=!active}
  if(resignButton){resignButton.hidden=!active;resignButton.disabled=!active||resignPending}
}
function cleanupSocket(){
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
  matchId=next;state=null;selectedSquare=null;legalTargets=[];
  offlineMode=false;offlineConflict=false;
  movePending=false;localWhiteMs=0;localBlackMs=0;localClockAt=0;orientationSet=false;
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
  if(!window.io){scheduleMatchPolling();return}
  const epoch=boardEpoch;
  try{
    const candidate=window.io(apiBase()||location.origin,{auth:{token:token()},transports:["websocket","polling"]});
    socket=candidate;socketMatchId=targetMatchId;
    const isCurrent=()=>isCurrentMatchSocket(candidate,targetMatchId,epoch);
    candidate.on("connect",()=>{
      if(!isCurrent())return;
      candidate.emit("chess:join",{matchId:targetMatchId});
      loadMatch();
      scheduleMatchPolling();
    });
    candidate.on("disconnect",()=>{if(isCurrent())scheduleMatchPolling()});
    candidate.on("chess:move",data=>{
      if(!isCurrent()||Number(data&&data.matchId)!==targetMatchId)return;
      if(Number(data.actorUserId)===Number(getUserId()))return;
      loadMatch();
    });
    candidate.on("chess:match_ready",data=>{
      if(!isCurrent()||(data&&data.matchId!=null&&Number(data.matchId)!==targetMatchId))return;
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
  }catch(e){console.warn(e);cleanupSocket()}
  scheduleMatchPolling();
}
function scheduleMatchPolling(){
  if(pollTimer){clearTimeout(pollTimer);pollTimer=null}
  if(!matchId||!state||!(state.status==="waiting"||state.status==="active"||(offlineMode&&state.status==="offline_pending"))||document.hidden||offlineConflict)return;
  const interval=socket&&socket.connected?10000:(offlineMode?retryDelayMs:2000);
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
async function resign(){if(!matchId||!state||state.status!=="active")return;if(!confirm("Resign this match? It will be recorded as a loss and the match will be settled."))return;resignPending=true;updateMatchActions();try{const r=await api("/api/chess/"+matchId+"/resign",{method:"POST"});if(r.ok)applyState(r.data.match);else setStatus(r.data.message||"Unable to resign.","waiting")}catch(_){setStatus("Could not reach the server. The match is still active.","waiting")}finally{resignPending=false;updateMatchActions()}}
async function offerDraw(){if(!matchId||!state||state.status!=="active")return;const r=await api("/api/chess/"+matchId+"/draw",{method:"POST"});setStatus(r.data.message||(r.ok?"Draw offer sent.":"Unable to offer a draw."),r.ok?"ready":"waiting")}
async function respondDraw(accept){if(!matchId)return;const r=await api("/api/chess/"+matchId+"/draw/respond",{method:"POST",body:{accept}});if(r.ok&&r.data.match)applyState(r.data.match);if(drawPanelElement)drawPanelElement.classList.add("hidden")}

if(flipButton)flipButton.addEventListener("click",()=>{boardFlipped=!boardFlipped;renderBoard()});
if(cancelSearchButton)cancelSearchButton.addEventListener("click",cancelSearch);
if(resignButton)resignButton.addEventListener("click",resign);
if(drawButton)drawButton.addEventListener("click",offerDraw);
if(acceptDrawButton)acceptDrawButton.addEventListener("click",()=>respondDraw(true));
if(declineDrawButton)declineDrawButton.addEventListener("click",()=>respondDraw(false));
if(returnDashboardButton)returnDashboardButton.addEventListener("click",()=>location.href="chess.html");
Object.entries(promotionButtons).forEach(([piece,button])=>{if(button)button.addEventListener("click",()=>choosePromotion(piece))});
if(cancelPromotionButton)cancelPromotionButton.addEventListener("click",cancelPromotion);
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&pendingPromotion)cancelPromotion()});
window.addEventListener("online",()=>{retryDelayMs=2000;if(matchId)loadMatch()});
window.addEventListener("offline",()=>{offlineMode=true;setConnectionStatus("Server unavailable · local moves stay on this device and are unverified.","offline");scheduleMatchPolling()});
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
