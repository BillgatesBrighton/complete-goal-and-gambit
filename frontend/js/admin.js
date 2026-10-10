(function () {
"use strict";
if (!GG.requireLogin()) return;
var $ = function (id) { return document.getElementById(id); };
var esc = GG.escapeHTML;
var adminId = null, selectedUser = null, selectedName = "", messageSig = "", urls = [], busy = false, timer = null, users = [], includeCleared = false, includeClearedComplaints = false;

function say(message, type) { $("notice").textContent = message || ""; $("notice").className = "notice" + (type ? " " + type : ""); }
function date(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? d.toLocaleString() : "Time unavailable"; }
function pair(a,b) { return a == null || b == null ? "Not submitted" : String(a) + " – " + String(b); }
function agree(c) {
    var a=c.creator_submitted_score,b=c.creator_submitted_opponent_score,x=c.opponent_submitted_score,y=c.opponent_submitted_opponent_score;
    if(a==null||b==null||x==null||y==null)return {text:"Waiting for both score reports",kind:"wait",bad:false};
    var ok=Number(a)===Number(y)&&Number(b)===Number(x);
    return {text:ok?"Player reports agree":"Score reports disagree",kind:ok?"good":"alert",bad:!ok};
}
function openResult(c) { return ["pending_screenshot","submitted","review_required","rejected"].indexOf(String(c.status).toLowerCase())>=0&&c.match_status!=="completed"; }

async function loadShots() {
    urls.forEach(URL.revokeObjectURL); urls=[];
    await Promise.all(Array.from(document.querySelectorAll("#resultList img[data-id]")).map(async function(img) {
        try {
            var r=await fetch(GG.API_BASE+"/api/admin/result-verifications/"+encodeURIComponent(img.dataset.id)+"/screenshot",{headers:{Authorization:"Bearer "+GG.getToken()},cache:"no-store"});
            if(!r.ok)throw new Error("Screenshot unavailable");
            var u=URL.createObjectURL(await r.blob()); urls.push(u); if(img.isConnected)img.src=u;
        } catch(e) { if(img.isConnected){var p=document.createElement("div");p.className="empty";p.textContent=e.message;img.replaceWith(p);} }
    }));
}
function renderResult(c) {
    var id=Number(c.id), status=openResult(c), a=agree(c), title="Match #"+c.match_id+" · "+(c.mode||"eFootball");
    var players=(c.creator_username||"Creator")+" vs "+(c.opponent_username||"Opponent");
    var h='<article class="card'+(a.bad?" mismatch":"")+'" data-case="'+id+'"><div class="card-top"><div><h3>'+esc(title)+'</h3><div class="meta">'+esc(players)+" · submitted by "+esc(c.selected_username||"player")+" · "+esc(date(c.submitted_at||c.created_at))+'</div></div><span class="badge '+a.kind+'">'+esc(a.text)+'</span></div>';
    h+='<div class="meta">Review: <strong>'+esc(String(c.status||"unknown").replace(/_/g," "))+'</strong> · Match: '+esc(c.match_status||"unknown")+(c.league?" · "+esc(c.league)+" league":"")+(c.tournament_id?" · Tournament #"+esc(c.tournament_id):"")+'</div>';
    h+='<div class="reports"><div class="report"><span>Creator reported</span><strong>'+esc(pair(c.creator_submitted_score,c.creator_submitted_opponent_score))+'</strong></div><div class="report"><span>Opponent reported</span><strong>'+esc(pair(c.opponent_submitted_score,c.opponent_submitted_opponent_score))+'</strong></div></div>';
    h+='<div class="evidence"><div class="shotbox">'+(c.screenshot_available?'<img class="shot" data-id="'+id+'" alt="Private game screenshot loading">':'No screenshot uploaded yet')+'</div><div><strong>Text read from screenshot</strong><pre class="ocr">'+esc(c.screenshot_ocr_text||"No readable text detected.")+'</pre><div class="meta"><strong>Score candidates:</strong> '+esc(JSON.stringify(c.detected_score_candidates||[]))+'<br><strong>Image check:</strong> '+esc(c.score_check||"not available")+'</div></div></div>';
    if(status&&c.screenshot_available){
        h+='<div class="form"><label>Verified creator score<input class="score" data-creator type="number" min="0" max="99" step="1" inputmode="numeric"></label><label>Verified opponent score<input class="score" data-opponent type="number" min="0" max="99" step="1" inputmode="numeric"></label><label class="wide">Optional admin note<textarea class="note" data-review-note maxlength="1000" placeholder="Note name differences, team orientation, or OCR issues (optional)."></textarea></label></div>';
        h+='<div class="actions"><button class="btn gold" data-review="resolve" data-id="'+id+'" type="button">Resolve result and settle</button><button class="btn red" data-review="reject" data-id="'+id+'" type="button">Reject evidence · keep funds held</button></div><div class="foot">Resolving updates the match, wallet settlement, standings, and player notices.</div>';
    } else if(status) h+='<div class="warn">Waiting for screenshot evidence. Keep this case open until the image is available.</div>';
    else if(c.review_note) h+='<div class="meta">Admin note: '+esc(c.review_note)+'</div>';
    return h+'</article>';
}
async function loadResults() {
    var r=await GG.api("/api/admin/result-verifications");
    if(!r.ok){$("resultList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load result reviews.")+'</div>';return 0;}
    var list=r.data.verifications||[], open=list.filter(openResult), view=$("resultFilter").value==="all"?list:open;
    $("resultList").innerHTML=view.length?view.map(renderResult).join(""):'<div class="empty">'+(open.length?"No reviews in this view.":"No unresolved score disputes.")+'</div>';
    $("statResults").textContent=open.length; $("navResults").textContent=open.length;
    await loadShots(); return open.length;
}
function renderComplaint(c) {
    var id=Number(c.id), s=String(c.status||"open"), closed=s==="resolved"||s==="dismissed", cleared=!!c.admin_cleared_at;
    var h='<article class="card complaint'+(closed?" closed":"")+'" data-complaint-id="'+id+'"><div class="card-top"><div><h3>#'+id+" · "+esc(c.subject||"Player complaint")+'</h3><div class="meta">'+esc(c.reporter_username||"Player")+(c.reported_username?" · About "+esc(c.reported_username):"")+" · "+esc(c.category||"support")+" · "+esc(date(c.created_at))+'</div></div><span class="badge '+(closed?"good":"wait")+'">'+esc(s)+'</span></div>';
    h+='<div class="bodytext">'+esc(c.description||"No description supplied.")+'</div>';
    if(c.admin_note)h+='<div class="meta"><strong>Previous admin note:</strong> '+esc(c.admin_note)+'</div>';
    h+='<div class="reply-row"><label class="sr-only" for="cn'+id+'">Optional admin note</label><textarea id="cn'+id+'" class="note" data-note maxlength="2000" placeholder="Optional admin note; leave blank if none."></textarea>';
    if(s!=="investigating")h+='<button class="btn" data-complaint-action="investigating" data-id="'+id+'">Investigate</button>';
    if(s!=="resolved")h+='<button class="btn gold" data-complaint-action="resolved" data-id="'+id+'">Resolve</button>';
    if(s!=="dismissed")h+='<button class="btn red" data-complaint-action="dismissed" data-id="'+id+'">Dismiss report</button>';
    if(closed)h+='<button class="btn" data-complaint-action="open" data-id="'+id+'">Reopen</button>';
    if(closed)h+='<button class="btn '+(cleared?'':'gold')+'" data-complaint-visibility="'+(cleared?'restore':'clear')+'" data-id="'+id+'">'+(cleared?'Restore to list':'Clear from list')+'</button>';
    return h+'</div></article>';
}
async function loadComplaints() {
    var drafts={}; document.querySelectorAll("#complaintList [data-note]").forEach(function(x){var c=x.closest("[data-complaint-id]");if(c)drafts[c.dataset.complaintId]=x.value;});
    var r=await GG.api("/api/admin/complaints"+(includeClearedComplaints?"?includeCleared=true":""));
    if(!r.ok){$("complaintList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load complaints.")+'</div>';return 0;}
    var all=r.data.complaints||[], open=all.filter(function(c){return c.status==="open"||c.status==="investigating";});
    var view=$("complaintFilter").value==="all"?all:open;
    $("complaintList").innerHTML=view.length?view.map(renderComplaint).join(""):'<div class="empty">'+(open.length?"No complaints in this view.":"No open complaints.")+'</div>';
    Object.keys(drafts).forEach(function(id){var x=document.querySelector('#complaintList [data-complaint-id="'+id+'"] [data-note]');if(x)x.value=drafts[id];});
    $("statComplaints").textContent=open.length; $("navComplaints").textContent=open.length; return open.length;
}
async function loadThreads() {
    var r=await GG.api("/api/admin/support"+(includeCleared?"?includeCleared=true":""));
    if(!r.ok){$("threads").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load inbox.")+'</div>';return;}
    var list=r.data.threads||[], unread=list.reduce(function(n,t){return n+(Number(t.unread)||0);},0);
    $("statUnread").textContent=unread; $("navUnread").textContent=unread;
    $("threads").innerHTML=list.length?list.map(function(t){var id=Number(t.user_id),cleared=!!t.admin_cleared_at;return '<div class="thread-row"><button class="thread'+(id===Number(selectedUser)?" active":"")+'" data-thread="'+id+'" data-name="'+esc(t.username||"Player")+'"><span class="thread-name">'+esc(t.username||"Player")+(Number(t.unread)?' <span class="unread">'+Number(t.unread)+'</span>':"")+(cleared?' <span class="badge">Cleared</span>':"")+'</span><span class="last">'+esc(t.last_message||"No messages yet")+'</span></button><button class="btn" type="button" data-thread-clear="'+id+'">'+(cleared?"Restore":"Clear")+'</button></div>';}).join(""):'<div class="empty">No player support messages in this view.</div>';
}
async function loadMessages(force) {
    if(selectedUser==null)return;
    if(!force&&document.activeElement===$("reply"))return;
    var r=await GG.api("/api/admin/support/"+encodeURIComponent(selectedUser));
    if(!r.ok){$("convhead").textContent=r.data.message||"Could not load conversation.";return;}
    var list=r.data.messages||[], sig=list.map(function(m){return m.id+":"+m.message+":"+(m.read_at||"");}).join("|");
    if(sig===messageSig)return; messageSig=sig;
    var pane=$("messages"), bottom=pane.scrollHeight-pane.scrollTop-pane.clientHeight<70;
    pane.innerHTML=list.length?list.map(function(m){var mine=Number(m.sender_id)===Number(adminId),receipt=mine?(m.read_at?" · Seen by player":" · Sent"):"";return '<div class="bubble'+(mine?" mine":"")+'">'+esc(m.message)+'<small>'+esc(mine?"You":m.username||selectedName)+" · "+esc(date(m.created_at))+esc(receipt)+'</small></div>';}).join(""):'<div class="empty">No messages in this conversation.</div>';
    if(bottom)pane.scrollTop=pane.scrollHeight;
    $("convhead").textContent=selectedName+" · "+list.length+" message"+(list.length===1?"":"s");
}
async function loadUsers() {
    var query=$("userSearch").value.trim(), r=await GG.api("/api/admin/users?search="+encodeURIComponent(query));
    if(!r.ok){$("userList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load accounts.")+'</div>';return;}
    users=r.data.users||[];


    $("userList").innerHTML=users.length?users.map(function(u){
        var id=Number(u.id), self=id===Number(adminId), status=String(u.account_status||"active"), cls=status==="active"?"active-status":status==="suspended"?"suspended-status":"closed-status";
        var h='<article class="userrow" data-user="'+id+'"><div><strong>'+esc(u.username)+(self?' <span class="badge good">You</span>':"")+'</strong><div class="user-meta">'+esc(u.game||"both")+" · "+esc(u.role||"user")+" · Rating "+esc(u.rating)+'</div></div><strong class="'+cls+'">'+esc(status)+'</strong><div class="user-actions">';
        h+='<label class="sr-only" for="un'+id+'">Optional action note</label><input id="un'+id+'" class="note" data-user-note maxlength="1000" placeholder="Optional note">';
        h+='<button class="btn" type="button" data-view-dashboard="'+id+'">View dashboard</button>';
        if(self)h+='<span class="foot">Your admin access is protected.</span>';
        else {
            if(status!=="active")h+='<button class="btn" data-status="active" data-id="'+id+'">Reactivate</button>';
            if(status!=="suspended")h+='<button class="btn" data-status="suspended" data-id="'+id+'">Suspend</button>';
            if(status!=="closed")h+='<button class="btn red" data-status="closed" data-id="'+id+'">Clear account</button>';
            if(u.role!=="admin")h+='<button class="btn red" type="button" data-delete-account="'+id+'">Delete permanently</button>';
        }
        return h+'</div></article>';
    }).join(""):'<div class="empty">No accounts match that search.</div>';
}
async function loadAnnouncements() {
    var r=await GG.api("/api/admin/announcements");
    if(!r.ok){$("announcementList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load announcements.")+'</div>';return;}
    var list=r.data.announcements||[];
    $("announcementList").innerHTML=list.length?list.map(function(a){
        return '<article class="announcement-row"><div><div class="announcement-message">'+esc(a.message)+'</div><div class="meta">'+esc(date(a.created_at))+' · '+(a.active?'Visible to players':'Hidden')+' · '+Number(a.read_count||0)+' reads</div></div>'+(a.active?'<button class="btn" type="button" data-deactivate-announcement="'+Number(a.id)+'">Hide</button>':'<span class="badge">Inactive</span>')+'</article>';
    }).join(""):'<div class="empty">No announcements yet.</div>';
}
async function loadOverview() {
    var r=await GG.api("/api/admin/overview"); if(!r.ok)return;
    var u=r.data.users||{}; $("statRestricted").textContent=(Number(u.suspended)||0)+(Number(u.closed)||0);
}
function editing(id) { var r=$(id),a=document.activeElement;return !!(r&&a&&r.contains(a)&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT")); }
async function refresh(force) {
    if(busy||document.hidden)return; busy=true; $("live").textContent="Updating…";
    try {
        var tasks=[loadOverview()];
        if(force||!editing("resultList"))tasks.push(loadResults());
        if(force||!editing("complaintList"))tasks.push(loadComplaints());
        if(force||!editing("accounts"))tasks.push(loadUsers());
        if(force||!editing("announcementForm"))tasks.push(loadAnnouncements());
        tasks.push(loadThreads()); await Promise.all(tasks); if(selectedUser!=null)await loadMessages(force);
        $("live").textContent="Live · "+new Date().toLocaleTimeString();
    } catch(_){$("live").textContent="Some data could not refresh.";}
    finally{busy=false;}
}
async function complaintAction(btn) {
    var card=btn.closest("[data-complaint-id]"), id=btn.dataset.id, note=card.querySelector("[data-note]").value.trim();
    btn.disabled=true; var r=await GG.api("/api/admin/complaints/"+encodeURIComponent(id),{method:"POST",body:{status:btn.dataset.complaintAction,note:note}});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update complaint.","error");return;}
    say("Complaint #"+id+" updated.","ok"); await refresh(true);
}
async function complaintVisibilityAction(btn) {
    var id=btn.dataset.id, action=btn.dataset.complaintVisibility;
    btn.disabled=true;
    var r=await GG.api("/api/admin/complaints/"+encodeURIComponent(id)+"/"+action,{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update the complaint list.","error");return;}
    say(r.data.message||"Complaint list updated.","ok");await refresh(true);
}
async function resultAction(btn) {
    var card=btn.closest("[data-case]"), decision=btn.dataset.review, body={decision:decision,note:card.querySelector("[data-review-note]")?.value.trim()||""};
    if(decision==="resolve"){
        var a=card.querySelector("[data-creator]"),b=card.querySelector("[data-opponent]");
        if(a.value===""||b.value===""){say("Enter both verified scores from the screenshot.","error");return;}
        body.creatorScore=Number(a.value);body.opponentScore=Number(b.value);
        if(!Number.isInteger(body.creatorScore)||!Number.isInteger(body.opponentScore)||body.creatorScore<0||body.opponentScore<0||body.creatorScore>99||body.opponentScore>99){say("Scores must be whole numbers from 0 to 99.","error");return;}
        if(!confirm("Settle this match using "+body.creatorScore+"–"+body.opponentScore+"? Wallet settlement, standings and player notices will update."))return;
    } else if(!confirm("Reject this evidence? Match funds will remain held for another admin decision."))return;
    btn.disabled=true;var r=await GG.api("/api/admin/result-verifications/"+encodeURIComponent(btn.dataset.id)+"/review",{method:"POST",body:body});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not save result review.","error");return;}
    say(r.data.message||"Result decision saved.","ok");await refresh(true);
}
async function statusAction(btn) {
    var id=Number(btn.dataset.id), status=btn.dataset.status, u=users.find(function(x){return Number(x.id)===id;}), row=btn.closest("[data-user]");
    if(!u)return;
    if(status==="closed"&&!confirm("Close "+u.username+"’s sign-in access? The profile and history remain recoverable."))return;
    if(status==="suspended"&&!confirm("Suspend "+u.username+" from signing in? An admin can reactivate the account."))return;
    var reason=row.querySelector("[data-user-note]").value.trim(); btn.disabled=true;
    var r=await GG.api("/api/admin/users/"+id+"/status",{method:"POST",body:{status:status,reason:reason}});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Account action failed.","error");return;}
    say(u.username+" is now "+status+". "+(reason?"Admin note saved.":"No reason was required."),"ok");await refresh(true);
}

function tile(label,value) { return '<div class="account-tile"><span>'+esc(label)+'</span><strong>'+esc(value==null||value===""?"—":value)+'</strong></div>'; }
function renderAccountDashboard(d) {
    var u=d.user||{}, tx=d.transactions||[], chess=d.chess||{}, ef=d.efootball||{};
    function items(list, render, empty) { return list.length?list.map(function(x){return '<div class="activity-item">'+render(x)+'</div>';}).join(""):'<div class="empty">'+empty+'</div>'; }
    var out='<div class="account-grid">'+tile("Username",u.username)+tile("Phone",u.phone)+tile("Game",u.game)+tile("Rating",u.rating)+tile("Account",u.account_status)+tile("Joined",date(u.created_at))+tile("Wallet",GG.formatMoney(u.balance))+tile("Locked",GG.formatMoney(u.locked_balance))+tile("Role",u.role)+'</div>';
    out+='<div class="account-grid">'+tile("Chess played",chess.stats&&chess.stats.played)+tile("Chess wins",chess.stats&&chess.stats.wins)+tile("Chess draws",chess.stats&&chess.stats.draws)+tile("eFootball matches",ef.stats&&ef.stats.played)+tile("eFootball completed",ef.stats&&ef.stats.completed)+'</div>';
    out+='<div class="activity-grid"><section class="activity-block"><h3>Recent wallet activity</h3>'+items(tx,function(x){return '<strong>'+esc(x.transaction_type)+' · '+esc(GG.formatMoney(x.amount))+'</strong><br>'+esc(x.status)+' · '+esc(date(x.created_at))+(x.reference?'<br>Ref: '+esc(x.reference):'')+(x.description?'<br>'+esc(x.description):'');},"No wallet activity.")+'</section>';
    out+='<section class="activity-block"><h3>Recent chess</h3>'+items(chess.recent||[],function(x){return '<strong>Game #'+esc(x.id)+' · '+esc(x.status)+' · '+esc(x.result||"in progress")+'</strong><br>'+esc(x.match_type)+' · '+esc(x.time_control)+' · '+esc(GG.formatMoney(x.stake_amount))+' · '+esc(date(x.finished_at));},"No chess matches.")+'</section>';
    out+='<section class="activity-block"><h3>Recent eFootball</h3>'+items(ef.recent||[],function(x){return '<strong>Match #'+esc(x.id)+' · '+esc(x.status)+'</strong><br>'+esc(x.mode||"Match")+(x.league?' · '+esc(x.league):'')+(x.creator_score!=null?' · '+esc(x.creator_score)+"–"+esc(x.opponent_score):'')+' · '+esc(GG.formatMoney(x.stake_amount))+' · '+esc(date(x.finished_at||x.created_at));},"No eFootball matches.")+'</section></div>';
    return out;
}
async function viewUserDashboard(btn) {
    var id=Number(btn.dataset.viewDashboard); btn.disabled=true;
    $("accountDialogTitle").textContent="Player dashboard";
    $("accountView").innerHTML='<div class="empty">Loading account activity…</div>';
    $("accountDialog").showModal();
    var r=await GG.api("/api/admin/users/"+encodeURIComponent(id)+"/dashboard"); btn.disabled=false;
    if(!r.ok){$("accountView").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load the account.")+'</div>';return;}
    var user=r.data.dashboard.user; $("accountDialogTitle").textContent=(user.username||"Player")+" · dashboard";
    $("accountView").innerHTML=renderAccountDashboard(r.data.dashboard);
}
async function deleteAccount(btn) {
    var id=Number(btn.dataset.deleteAccount), u=users.find(function(x){return Number(x.id)===id;});
    if(!u)return;
    var typed=prompt('To permanently delete '+u.username+' and linked personal data, type the username exactly. This cannot be undone.');
    if(typed!==u.username)return;
    btn.disabled=true;
    var r=await GG.api("/api/admin/users/"+encodeURIComponent(id),{method:"DELETE"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Account could not be deleted.","error");return;}
    say("Account permanently deleted.","ok");await refresh(true);
}
async function deactivateAnnouncement(btn) {
    btn.disabled=true;
    var r=await GG.api("/api/admin/announcements/"+encodeURIComponent(btn.dataset.deactivateAnnouncement)+"/deactivate",{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not hide announcement.","error");return;}
    say(r.data.message||"Announcement hidden.","ok");await loadAnnouncements();
}

async function clearThreadAction(btn) {
    var id=Number(btn.dataset.threadClear), restore=btn.textContent.trim()==="Restore";
    var target=users.find(function(u){return Number(u.id)===id;});
    var name=target?target.username:(btn.closest(".thread-row").querySelector("[data-thread]").dataset.name||"this player");
    if(!restore&&!confirm("Clear "+name+"’s conversation from the admin inbox? The message history stays saved, and a new player message will reopen it."))return;
    btn.disabled=true;
    var r=await GG.api("/api/admin/support/"+id+(restore?"/restore":"/clear"),{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update the conversation.","error");return;}
    if(selectedUser===id&&!restore){selectedUser=null;selectedName="";messageSig="";$("messages").innerHTML='<div class="empty">Choose a player to read their messages.</div>';$("convhead").textContent="Select a conversation";$("reply").disabled=true;$("sendReply").disabled=true;}
    say(r.data.message||"Conversation updated.","ok");await refresh(true);
}

$("resultFilter").addEventListener("change",function(){loadResults();});
$("complaintFilter").addEventListener("change",function(){loadComplaints();});
$("refresh").addEventListener("click",function(){refresh(true);});
$("logout").addEventListener("click",function(){GG.logout();});
$("searchUsers").addEventListener("click",loadUsers);
$("userSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();loadUsers();}});
$("userSearch").addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(loadUsers,250);});
$("resultList").addEventListener("click",function(e){var b=e.target.closest("[data-review]");if(b)resultAction(b);});
$("complaintList").addEventListener("click",function(e){var b=e.target.closest("[data-complaint-action]");if(b)complaintAction(b);});
$("complaintList").addEventListener("click",function(e){var b=e.target.closest("[data-complaint-visibility]");if(b)complaintVisibilityAction(b);});
$("userList").addEventListener("click",function(e){var view=e.target.closest("[data-view-dashboard]");if(view){viewUserDashboard(view);return;}var del=e.target.closest("[data-delete-account]");if(del){deleteAccount(del);return;}var b=e.target.closest("[data-status]");if(b)statusAction(b);});
$("announcementList").addEventListener("click",function(e){var b=e.target.closest("[data-deactivate-announcement]");if(b)deactivateAnnouncement(b);});
$("announcementForm").addEventListener("submit",async function(e){e.preventDefault();var input=$("announcementMessage"),message=input.value.trim();if(!message)return;$("sendAnnouncement").disabled=true;var r=await GG.api("/api/admin/announcements",{method:"POST",body:{message:message}});$("sendAnnouncement").disabled=false;if(!r.ok){say(r.data.message||"Announcement was not published.","error");return;}input.value="";say(r.data.message||"Announcement published.","ok");await loadAnnouncements();});
$("accountDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-account]"))this.close();});
$("toggleClearedComplaints").addEventListener("click",function(){includeClearedComplaints=!includeClearedComplaints;this.setAttribute("aria-pressed",String(includeClearedComplaints));this.textContent=includeClearedComplaints?"Hide cleared":"Show cleared";loadComplaints();});
$("threads").addEventListener("click",function(e){var action=e.target.closest("[data-thread-clear]");if(action){clearThreadAction(action);return;}var b=e.target.closest("[data-thread]");if(!b)return;selectedUser=Number(b.dataset.thread);selectedName=b.dataset.name||"Player";messageSig="";$("reply").disabled=false;$("sendReply").disabled=false;$("convhead").textContent=selectedName+" · loading";loadThreads().then(function(){return loadMessages(true);});});
$("toggleCleared").addEventListener("click",function(){includeCleared=!includeCleared;this.setAttribute("aria-pressed",String(includeCleared));this.textContent=includeCleared?"Hide cleared":"Show cleared";loadThreads();});
$("replyForm").addEventListener("submit",async function(e){e.preventDefault();if(selectedUser==null)return;var input=$("reply"),message=input.value.trim();if(!message)return;$("sendReply").disabled=true;$("convhead").textContent="Sending…";var r=await GG.api("/api/admin/support/"+encodeURIComponent(selectedUser),{method:"POST",body:{message:message}});if(!r.ok){$("sendReply").disabled=false;$("convhead").textContent=r.data.message||"Reply not sent; your text is still here.";return;}input.value="";messageSig="";$("sendReply").disabled=false;await loadThreads();await loadMessages(true);input.focus();});

async function authorize() {
    var gate=$("gate");
    if(!GG.getToken())return;
    var r=await GG.api("/api/me");
    if(!r.ok||!r.data.user){gate.textContent="Please sign in with an administrator account.";return;}
    if(r.data.user.role!=="admin"){gate.textContent="Administrator access required. This account cannot open the admin desk.";return;}
    adminId=Number(r.data.user.id);$("adminName").textContent=r.data.user.username||"Administrator";
    $("app").hidden=false;gate.hidden=true;say("Admin-only workspace connected.");
    await refresh(true);setInterval(function(){refresh(false);},12000);
}
authorize();
})();

