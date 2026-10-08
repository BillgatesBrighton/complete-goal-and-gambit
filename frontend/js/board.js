"use strict";

/* GOAL$GAMBIT CHESS BOARD - repaired client
   Keeps the existing board.html IDs/UI but uses the secure chess backend
   for authoritative legal moves, clocks, results and draw/resign actions. */

const params = new URLSearchParams(location.search);
let config = {};
let matchId = Number(params.get("matchId") || 0) || null;
let playerColor = "w";
let boardFlipped = false;
let selectedSquare = null;
let state = null;
let clockTimer = null;
let socket = null;
let localWhiteMs = 0;
let localBlackMs = 0;
let localClockAt = 0;
let legalTargets = [];
let selectedRequest = 0;
let movePending = false;
let timeoutCheckAt = 0;
let stateVersion = 0;

const chessBoard = document.getElementById("chessBoard");
const gameModeElement = document.getElementById("gameMode");
const gameStatusElement = document.getElementById("gameStatus");
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
const flipButton = document.getElementById("flipButton");
const drawButton = document.getElementById("drawButton");
const resignButton = document.getElementById("resignButton");
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
    const r=await fetch(apiBase()+path,{method:options.method||"GET",headers,body:options.body!==undefined?JSON.stringify(options.body):undefined});
    let data={}; try{data=await r.json()}catch(_){ }
    if(r.status===401){localStorage.removeItem("goalGambitToken");location.href="login.html"}
    return {ok:r.ok,status:r.status,data};
  }catch(_){return {ok:false,status:0,data:{message:"The server connection was lost. Your game is still saved; reconnect and try again."}}}
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
  const speed=(config.rankedMode||config.speed||"rapid").replace(/[^a-z]/gi,"");
  const type=config.tournamentMode?"Tournament":"Ranked";
  const label=speed.charAt(0).toUpperCase()+speed.slice(1)+" "+type;
  if(gameModeElement)gameModeElement.textContent=label;
  if(matchTypeElement)matchTypeElement.textContent=type;
  if(matchTimeElement)matchTimeElement.textContent=state?.timeControl||config.timeControl||"—";
  if(matchStakeElement)matchStakeElement.textContent="KSh "+Number(state?.stake??config.rankedStake??0).toLocaleString("en-KE");
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
  if(active!==null&&active<=0&&Date.now()-timeoutCheckAt>1000){timeoutCheckAt=Date.now();loadMatch()}
}
function setStatus(text, cls){
  if(gameStatusElement)gameStatusElement.textContent=text;
  if(matchStatusElement)matchStatusElement.textContent=text;
  const turnMessage=document.getElementById("turnMessage");if(turnMessage)turnMessage.textContent=text;
  const bar=document.getElementById("statusBar");if(bar){bar.classList.remove("ready","waiting");if(cls)bar.classList.add(cls)}
}
async function selectPiece(sq){
  selectedSquare=sq;legalTargets=[];renderBoard();
  const request=++selectedRequest;
  setStatus("Checking legal moves…","ready");
  const r=await api("/api/chess/"+matchId+"/legal-moves?square="+encodeURIComponent(sq));
  if(request!==selectedRequest)return;
  if(!r.ok){selectedSquare=null;legalTargets=[];renderBoard();setStatus(r.data.message||"Could not check legal moves.","waiting");return}
  legalTargets=r.data.moves||[];renderBoard();
  setStatus(legalTargets.length?"Choose a highlighted legal square.":(r.data.inCheck?"Check — make a legal move to protect your king.":"That piece has no legal moves."),r.data.inCheck?"waiting":"ready");
}
function clickSquare(sq){
  if(!state||state.status!=="active"||state.activeColor!==playerColor||state.result||movePending)return;
  const b=currentBoard(),{r,c}=parseSquare(sq),p=b[r][c];
  if(p&&p.color===playerColor){selectPiece(sq);return}
  if(selectedSquare&&legalTargets.some(x=>x.to===sq)){
    const from=selectedSquare;selectedSquare=null;legalTargets=[];selectedRequest++;sendMove(from,sq);return;
  }
  selectedSquare=null;legalTargets=[];selectedRequest++;renderBoard();
}
async function sendMove(from,to){
  movePending=true;renderBoard();
  setStatus("Sending move…","ready");
  const r=await api("/api/chess/"+matchId+"/move",{method:"POST",body:{from,to,promotion:"q"}});
  movePending=false;
  if(!r.ok){setStatus(r.data.message||"Illegal move.","waiting");await loadMatch();return}
  applyState(r.data.match||r.data);
}
let orientationSet=false;
function applyState(m){
  if(!m)return;
  if(state&&state.fen!==m.fen){selectedSquare=null;legalTargets=[];selectedRequest++;movePending=false}
  stateVersion++;
  state=m; playerColor=m.playerColor||playerColor;
  if(!orientationSet&&m.playerColor){boardFlipped=m.playerColor==="b";orientationSet=true} localWhiteMs=Number(m.whiteTimeMs||0);localBlackMs=Number(m.blackTimeMs||0);localClockAt=Date.now();
  const check=m.checkSquare?" · CHECK":"";
  setInfo();setPlayers();setStatus(m.status==="active"?(m.activeColor===playerColor?"Your turn":"Opponent's turn")+check:(m.status==="waiting"?"Searching for an opponent…":m.status==="cancelled"?"Search cancelled":"Game finished"),m.status==="waiting"?"waiting":"ready");updateCancelButton();renderBoard();
  const active=state&&state.status==="active";if(drawButton)drawButton.disabled=!active;if(resignButton)resignButton.disabled=!active;
  if(m.result)showGameOver(m.result,m.winnerId);
  if(drawPanelElement)drawPanelElement.classList.toggle("hidden",!m.drawOfferUserId||Number(m.drawOfferUserId)===Number(getUserId()));
}
function getUserId(){
  const saved=Number(localStorage.getItem("goalGambitUserId")||0);
  if(saved)return saved;
  try{const part=token().split(".")[1];return Number(JSON.parse(atob(part.replace(/-/g,"+").replace(/_/g,"/"))).userId||0)}catch(_){return 0}
}
async function loadMatch(){
  if(!matchId)return;
  const version=stateVersion;
  const r=await api("/api/chess/"+matchId);
  if(r.ok&&version===stateVersion)applyState(r.data.match);
}
async function createOrJoin(){
  if(!token()){setStatus("Log in required.","waiting");setTimeout(()=>location.href="login.html",1200);return}
  if(matchId){await loadMatch();return}
  const speed=(config.rankedMode||"rapid").toLowerCase(); const tc=config.timeControl||({rapid:"10+5",blitz:"3+2",bullet:"1+1"}[speed]||"10+5");
  setStatus("Checking your wallet…","waiting");
  const created=await api("/api/chess/create",{method:"POST",body:{matchType:config.tournamentMode?"tournament":"ranked",speed,stake:Number(config.rankedStake||0),timeControl:tc}});
  if(created.ok){
    matchId=created.data.match.matchId;
    localStorage.setItem("goalGambitChessMatchId",String(matchId));
    try{const u=new URL(location.href);u.searchParams.set("matchId",String(matchId));history.replaceState(null,"",u.toString())}catch(_){}
    applyState(created.data.match);
  } else {
    const msg=created.data.message||"Unable to create match.";
    setStatus(msg,"waiting");
    if(/insufficient/i.test(msg)){setTimeout(()=>{alert(msg+"\nDeposit funds in your wallet to play.");location.href="wallet.html"},600)}
  }
}
async function cancelSearch(){
  if(!matchId||!state||state.status!=="waiting")return;
  const r=await api("/api/chess/"+matchId+"/cancel",{method:"POST"});
  if(r.ok){location.href="chess.html"}else setStatus(r.data.message||"Could not cancel.","waiting");
}
function updateCancelButton(){
  const bar=document.getElementById("statusBar"); if(!bar)return;
  let btn=document.getElementById("cancelSearchButton");
  const searching=state&&state.status==="waiting";
  if(searching&&!btn){btn=document.createElement("button");btn.id="cancelSearchButton";btn.type="button";btn.textContent="Cancel search (refund stake)";btn.style.cssText="margin-left:12px;padding:6px 12px;border-radius:8px;border:1px solid #f4bd20;background:transparent;color:#f4bd20;cursor:pointer";btn.addEventListener("click",cancelSearch);bar.appendChild(btn)}
  if(!searching&&btn)btn.remove();
}
function setupSocket(){
  if(!matchId||!token())return;
  if(!window.io){loadMatch();return}
  try{socket=window.io(apiBase()||location.origin,{auth:{token:token()},transports:["websocket","polling"]});socket.on("connect",()=>socket.emit("chess:join",{matchId}));socket.on("chess:move",()=>loadMatch());socket.on("chess:match_ready",()=>loadMatch());socket.on("chess:game_over",loadMatch);socket.on("chess:draw_offer",d=>{if(Number(d.userId)!==getUserId()&&drawPanelElement)drawPanelElement.classList.remove("hidden")});}catch(e){console.warn(e)}
}
function showGameOver(result,winnerId){
  if(gameOverModal)gameOverModal.classList.remove("hidden");
  const me=getUserId();const win=winnerId&&Number(winnerId)===me;
  if(gameOverTitleElement)gameOverTitleElement.textContent=result==="draw"?"Draw":win?"You Win":"You Lose";
  if(gameOverMessageElement)gameOverMessageElement.textContent=result==="draw"?"The match ended in a draw.":win?"Congratulations — the server has settled the match.":"The match has ended. The server has settled the result.";
}
async function resign(){if(!matchId)return;if(!confirm("Resign this chess match?"))return;const r=await api("/api/chess/"+matchId+"/resign",{method:"POST"});if(r.ok)applyState(r.data.match);else setStatus(r.data.message||"Unable to resign.","waiting")}
async function offerDraw(){if(!matchId)return;const r=await api("/api/chess/"+matchId+"/draw",{method:"POST"});setStatus(r.data.message||"Draw offer sent.","waiting")}
async function respondDraw(accept){if(!matchId)return;const r=await api("/api/chess/"+matchId+"/draw/respond",{method:"POST",body:{accept}});if(r.ok&&r.data.match)applyState(r.data.match);if(drawPanelElement)drawPanelElement.classList.add("hidden")}

if(flipButton)flipButton.addEventListener("click",()=>{boardFlipped=!boardFlipped;renderBoard()});
if(resignButton)resignButton.addEventListener("click",resign);
if(drawButton)drawButton.addEventListener("click",offerDraw);
if(acceptDrawButton)acceptDrawButton.addEventListener("click",()=>respondDraw(true));
if(declineDrawButton)declineDrawButton.addEventListener("click",()=>respondDraw(false));
if(returnDashboardButton)returnDashboardButton.addEventListener("click",()=>location.href="chess.html");
window.addEventListener("message",event=>{if(!event.data||event.data.type!=="GOAL_GAMBIT_INIT")return;config=event.data.config||{};if(config.matchId)matchId=Number(config.matchId);if(config.player?.color)playerColor=config.player.color;setInfo();createOrJoin().then(setupSocket);window.parent.postMessage({type:"GOAL_GAMBIT_BOARD_READY"},"*")});

setInfo(); renderBoard();
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
// Keep both players' clocks and board state synced if Socket.IO disconnects.
setInterval(()=>{if(matchId&&state&&(state.status==="waiting"||state.status==="active")&&!document.hidden)loadMatch()},2000);
clockTimer=setInterval(updateClocks,250);
