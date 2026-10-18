(function () {
"use strict";
if (!GG.requireLogin()) return;
var $ = function (id) { return document.getElementById(id); };
var esc = GG.escapeHTML;
var adminId = null, selectedUser = null, selectedName = "", messageSig = null, urls = [], complaintUrls = [], busy = false, timer = null, walletAdjustTimer = null, users = [], walletAdjustmentUsers = [], includeCleared = false, includeClearedComplaints = false, includeClearedResults = false, includeClearedMatches = false, includeInactiveAnnouncements = false, complaintPage = 1, complaintPages = 1, complaintQuery = "", currentComplaintId = null, adminAuthorized = false, authorizePending = false, authorizeAgain = false, accessTimer = null;
var companionPage = 1, companionPages = 1, companionSearch = "", companionTrackerBusy = false;

function say(message, type) { $("notice").textContent = message || ""; $("notice").className = "notice" + (type ? " " + type : ""); }
function updateAccountPresence(ids) {
    var online = new Set((Array.isArray(ids) ? ids : []).map(function(id) { return String(Number(id)); }));
    document.querySelectorAll("[data-account-presence]").forEach(function(badge) {
        var active = online.has(String(Number(badge.dataset.accountPresence)));
        badge.classList.toggle("is-online", active);
        badge.textContent = active ? "Online" : "Offline";
        badge.setAttribute("aria-label", active ? "Online" : "Offline");
    });
}
window.addEventListener("gg:presence-update", function(event) {
    updateAccountPresence(event.detail && event.detail.onlineUserIds);
});
async function clearAdminItems(button, path, promptText, afterClear, legacyClear) {
    if (!confirm(promptText)) return;
    button.disabled = true;
    try {
        var response = await GG.api(path, { method: "POST", body: {} });
        if (!response.ok && response.status === 404 && legacyClear) {
            var legacyResult = await legacyClear();
            say(legacyResult.message, legacyResult.ok ? "ok" : "error");
            try { await afterClear(); }
            catch (_) { say("The clear action completed, but this list could not refresh. Use Refresh to reload it.", "error"); }
            return;
        }
        if (!response.ok) { say(response.data.message || "Could not clear these admin records.", "error"); return; }
        say(response.data.message || "Admin records cleared.", "ok");
        try { await afterClear(); }
        catch (_) { say("The clear action completed, but this list could not refresh. Use Refresh to reload it.", "error"); }
    } catch (_) {
        say("Could not clear these admin records. Check the connection and try again.", "error");
    } finally {
        button.disabled = false;
    }
}
async function clearByLegacyRoutes(records, pathFor, label) {
    var success=0,failed=0,unique=[],seen=new Set();
    records.forEach(function(record){var path=pathFor(record);if(!seen.has(path)){seen.add(path);unique.push(path);}});
    for(var start=0;start<unique.length;start+=8){
        var batch=unique.slice(start,start+8);
        var results=await Promise.all(batch.map(function(path){return GG.api(path,{method:"POST",body:{}});}));
        results.forEach(function(result){if(result.ok)success++;else failed++;});
    }
    if(!unique.length)return {ok:true,message:"There are no "+label+" to clear."};
    return {ok:failed===0,message:success+" "+label+" cleared."+(failed?" "+failed+" could not be cleared; refresh and retry for the remaining items.":"")};
}
function concealDashboard(message, clearData) {
    adminAuthorized = false;
    var app = $("app"), gate = $("gate");
    if (app) app.hidden = true;
    if (gate) { gate.textContent = message || "Checking administrator access…"; gate.hidden = false; }
    if (!clearData) return;
    if (accessTimer) { clearInterval(accessTimer); accessTimer = null; }
    ["accountDialog", "complaintDialog", "companionDialog"].forEach(function(id) { var dialog = $(id); if (dialog && dialog.open) dialog.close(); });
    urls.concat(complaintUrls).forEach(function(url) { URL.revokeObjectURL(url); });
    urls = []; complaintUrls = []; currentComplaintId = null; selectedUser = null; selectedName = ""; messageSig = null; users = [];
    ["resultList", "matchManagementList", "activeComplaintList", "resolvedComplaintList", "complaintView", "adminWalletBalance", "adminWalletTransactions", "manualWithdrawalsList", "userList", "announcementList", "companionTrackerList", "companionView", "threads", "messages", "accountView"].forEach(function(id) {
        var node = $(id); if (node) node.replaceChildren();
    });
    if ($("adminName")) $("adminName").textContent = "Admin";
    adminId = null;
}
function date(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? d.toLocaleString() : "Time unavailable"; }
function pair(a,b) { return a == null || b == null ? "Not submitted" : String(a) + " – " + String(b); }
function namedScoreReport(firstName, firstScore, secondName, secondScore) {
    if(firstScore==null||secondScore==null)return "Not reported";
    return String(firstName)+": "+String(firstScore)+" · "+String(secondName)+": "+String(secondScore);
}
function agree(c) {
    var a=c.creator_submitted_score,b=c.creator_submitted_opponent_score,x=c.opponent_submitted_score,y=c.opponent_submitted_opponent_score;
    if(a==null||b==null||x==null||y==null)return {text:"Waiting for both score reports",kind:"wait",bad:false};
    var ok=Number(a)===Number(y)&&Number(b)===Number(x);
    return {text:ok?"Player reports agree":"Score reports disagree",kind:ok?"good":"alert",bad:!ok};
}
function openResult(c) { return ["pending_screenshot","submitted","review_required","rejected"].indexOf(String(c.status).toLowerCase())>=0&&!c.settled_at&&!["completed","cancelled"].includes(c.match_status); }

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
    var id=Number(c.id), status=openResult(c), resolved=!!c.settled_at&&["completed","cancelled"].includes(c.match_status), cleared=!!c.admin_cleared_at, a=agree(c), title="Match #"+c.match_id+" · "+(c.mode||"eFootball");
    var creatorName=c.creator_username||"Creator", opponentName=c.opponent_username||"Opponent";
    var players=creatorName+" vs "+opponentName;
    var h='<article class="card'+(a.bad?" mismatch":"")+'" data-case="'+id+'"><div class="card-top"><div><h3>'+esc(title)+'</h3><div class="meta">'+esc(players)+" · submitted by "+esc(c.selected_username||"player")+" · "+esc(date(c.submitted_at||c.created_at))+'</div></div><span class="badge '+a.kind+'">'+esc(a.text)+'</span></div>';
    h+='<div class="meta">Review: <strong>'+esc(String(c.status||"unknown").replace(/_/g," "))+'</strong> · Match: '+esc(c.match_status||"unknown")+(c.league?" · "+esc(c.league)+" league":"")+(c.tournament_id?" · Tournament #"+esc(c.tournament_id):"")+'</div>';
    var history=Array.isArray(c.reports)?c.reports:[];
    if(history.length){
        h+='<div class="reports round-history">'+history.map(function(report){var other=report.username===creatorName?opponentName:creatorName;return '<div class="report"><span>Round '+esc(report.roundNo)+' · '+esc(report.username)+' reported</span><strong>'+esc(namedScoreReport(report.username,report.scoreFor,other,report.scoreAgainst))+'</strong></div>';}).join("")+'</div>';
    } else {
        h+='<div class="reports"><div class="report"><span>'+esc(creatorName)+' reported</span><strong>'+esc(creatorName)+': '+esc(c.creator_submitted_score==null?"—":String(c.creator_submitted_score))+' · '+esc(opponentName)+': '+esc(c.creator_submitted_opponent_score==null?"—":String(c.creator_submitted_opponent_score))+'</strong></div><div class="report"><span>'+esc(opponentName)+' reported</span><strong>'+esc(opponentName)+': '+esc(c.opponent_submitted_score==null?"—":String(c.opponent_submitted_score))+' · '+esc(creatorName)+': '+esc(c.opponent_submitted_opponent_score==null?"—":String(c.opponent_submitted_opponent_score))+'</strong></div></div>';
    }
    h+='<div class="evidence"><div class="shotbox">'+(c.screenshot_available?'<img class="shot" data-id="'+id+'" alt="Private game screenshot loading">':'No screenshot uploaded yet')+'</div><div class="meta">'+(c.screenshot_available?'Screenshot evidence is attached for manual admin review.':'Waiting for the selected player to upload screenshot evidence.')+'</div></div>';
    if(status&&c.screenshot_available){
        h+='<div class="form"><label>'+esc(creatorName)+' verified goals<input class="score" data-creator type="number" min="0" max="99" step="1" inputmode="numeric"></label><label>'+esc(opponentName)+' verified goals<input class="score" data-opponent type="number" min="0" max="99" step="1" inputmode="numeric"></label><label class="wide">Optional admin note<textarea class="note" data-review-note maxlength="1000" placeholder="Record what the screenshot shows, including player-name or side differences."></textarea></label></div>';
        h+='<div class="actions"><button class="btn gold" data-review="resolve" data-id="'+id+'" type="button">Resolve result and settle</button><button class="btn red" data-review="reject" data-id="'+id+'" type="button">Reject evidence · keep funds held</button></div><div class="foot">Resolving updates the match, wallet settlement, standings, and player notices.</div>';
    } else if(status) h+='<div class="warn">Waiting for screenshot evidence. Keep this case open until the image is available.</div>';
    else if(c.review_note) h+='<div class="meta">Admin note: '+esc(c.review_note)+'</div>';
    if(resolved)h+='<div class="actions"><button class="btn '+(cleared?'':'gold')+'" type="button" data-result-visibility="'+(cleared?'restore':'clear')+'" data-id="'+id+'">'+(cleared?'Restore to list':'Clear from list')+'</button></div>';
    return h+'</article>';
}
async function loadResults() {
    var r=await GG.api("/api/admin/result-verifications"+(includeClearedResults?"?includeCleared=true":""));
    if(!r.ok){$("resultList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load result reviews.")+'</div>';return 0;}
    var list=r.data.verifications||[], open=list.filter(openResult), resolved=list.filter(function(c){return !!c.settled_at&&["completed","cancelled"].includes(c.match_status);}), filter=$("resultFilter").value, view=filter==="all"?list:filter==="resolved"?resolved:open;
    $("resultList").innerHTML=view.length?view.map(renderResult).join(""):'<div class="empty">'+(filter==="resolved"?"No resolved result disputes.":filter==="all"?"No result disputes found.":"No unresolved score disputes.")+'</div>';
    $("statResults").textContent=open.length; $("navResults").textContent=open.length;
    await loadShots(); return open.length;
}
function renderComplaint(c) {
    var id=Number(c.id), s=String(c.status||"open"), closed=s==="resolved"||s==="dismissed", cleared=!!c.admin_cleared_at;
    var reporter=esc(c.reporter_username||"Player")+" · "+esc(c.reporter_phone||"No phone on file");
    var reported=c.reported_username?esc(c.reported_username)+" · "+esc(c.reported_phone||"No phone on file"):"No other player linked";
    var creatorName=c.creator_username||"Creator", opponentName=c.opponent_username||"Opponent";
    var scoreText=c.creator_submitted?namedScoreReport(creatorName,c.creator_submitted_score,opponentName,c.creator_submitted_opponent_score):"Not reported";
    var opponentText=c.opponent_submitted?namedScoreReport(opponentName,c.opponent_submitted_score,creatorName,c.opponent_submitted_opponent_score):"Not reported";
    var h='<article class="card complaint'+(closed?" closed":"")+'" data-complaint-id="'+id+'"><div class="card-top"><div><h3>'+esc(c.complaint_ref||("#"+id))+" · "+esc(c.subject||"Player complaint")+'</h3><div class="meta">Reporter: '+reporter+'<br>Other player: '+reported+'<br>'+esc(c.category||"support")+' · '+esc(date(c.created_at))+'</div></div><span class="badge '+(closed?"good":"wait")+'">'+esc(s.replace(/_/g," "))+'</span></div>';
    h+='<div class="meta">'+(c.match_id?'Match #'+esc(c.match_id)+' · '+esc(c.match_mode||"eFootball")+' · '+esc(c.match_status||"unknown")+(c.league_name?' · '+esc(c.league_name):"")+(c.tournament_name?' · '+esc(c.tournament_name):"")+'<br>Submitted scores: '+esc(c.creator_username||"Creator")+' '+esc(scoreText)+' · '+esc(c.opponent_username||"Opponent")+' '+esc(opponentText):"Not linked to a match")+' · Evidence: '+Number(c.evidence_count||0)+(c.result_screenshot_available?" + result screenshot":"")+'</div>';
    h+='<div class="actions"><button class="btn gold" type="button" data-open-complaint="'+id+'">Open investigation</button>';
    if(closed)h+='<button class="btn '+(cleared?'':'gold')+'" type="button" data-complaint-visibility="'+(cleared?'restore':'clear')+'" data-id="'+id+'">'+(cleared?'Restore to list':'Clear from list')+'</button>';
    return h+'</div></article>';
}
async function loadComplaints() {
    function paramsFor(status){var params=new URLSearchParams({status:status,page:String(complaintPage),limit:"20",q:complaintQuery});if(includeClearedComplaints)params.set("includeCleared","true");return params;}
    var results=await Promise.all([
        GG.api("/api/admin/complaint-cases?"+paramsFor("active").toString()),
        GG.api("/api/admin/complaint-cases?"+paramsFor("closed").toString())
    ]);
    var activeResult=results[0],closedResult=results[1];
    if(!activeResult.ok){$("activeComplaintList").innerHTML='<div class="empty">'+esc(activeResult.data.message||"Could not load open complaints.")+'</div>';}
    if(!closedResult.ok){$("resolvedComplaintList").innerHTML='<div class="empty">'+esc(closedResult.data.message||"Could not load resolved complaints.")+'</div>';}
    var activeData=activeResult.ok?activeResult.data:{},closedData=closedResult.ok?closedResult.data:{};
    var activeList=activeData.complaints||[],closedList=closedData.complaints||[];
    var counts=activeData.counts||closedData.counts||{};
    complaintPages=Math.max(1,Number(activeData.pages)||1,Number(closedData.pages)||1);
    complaintPage=Math.max(1,Number(activeData.page)||Number(closedData.page)||1);
    if(activeResult.ok)$("activeComplaintList").innerHTML=activeList.length?activeList.map(renderComplaint).join(""):'<div class="empty">No open complaints.</div>';
    if(closedResult.ok)$("resolvedComplaintList").innerHTML=closedList.length?closedList.map(renderComplaint).join(""):'<div class="empty">No resolved or dismissed complaints.</div>';
    $("activeComplaintCount").textContent=String(Number(counts.open||0)+Number(counts.investigating||0)+Number(counts.awaiting_player||0)+Number(counts.awaiting_evidence||0)+Number(counts.escalated||0));
    $("resolvedComplaintCount").textContent=String(Number(counts.resolved||0)+Number(counts.dismissed||0));
    $("complaintsPageLabel").textContent="Page "+complaintPage+" of "+complaintPages+" per box";
    $("complaintsPrev").disabled=complaintPage<=1;$("complaintsNext").disabled=complaintPage>=complaintPages;
    var active=Number(counts.open||0)+Number(counts.investigating||0)+Number(counts.awaiting_player||0)+Number(counts.awaiting_evidence||0)+Number(counts.escalated||0);
    $("statComplaints").textContent=active; $("navComplaints").textContent=active; return active;
}
function caseTile(label,value){return '<div class="account-tile"><span>'+esc(label)+'</span><strong>'+esc(value==null||value===""?"Not available":String(value))+'</strong></div>';}
function renderComplaintCase(c){
    var creatorName=c.creator_username||"Creator", opponentName=c.opponent_username||"Opponent";
    var people={},ids=[c.reporter_id,c.reported_user_id,c.creator_id,c.opponent_id].filter(Boolean).map(Number);
    [[c.reporter_id,c.reporter_username,c.reporter_phone],[c.reported_user_id,c.reported_username,c.reported_phone],[c.creator_id,c.creator_username,c.creator_phone],[c.opponent_id,c.opponent_username,c.opponent_phone]].forEach(function(x){if(x[0])people[Number(x[0])]={id:Number(x[0]),name:x[1]||"Player",phone:x[2]||"No phone on file"};});
    var participantOptions=Object.keys(people).map(function(id){var p=people[id];return '<option value="'+p.id+'">'+esc(p.name)+' · '+esc(p.phone)+'</option>';}).join("");
    var h='<section><div class="meta"><strong>'+esc(c.complaint_ref||("#"+c.id))+'</strong> · '+esc(c.category||"other")+' · '+esc(c.priority||"normal")+' · submitted '+esc(date(c.created_at))+'</div><h3>'+esc(c.subject||"Player complaint")+'</h3><p class="bodytext">'+esc(c.description||"No description supplied.")+'</p>';
    if(c.admin_id)h+='<div class="meta">Assigned reviewer: '+esc(c.assigned_admin_username||"Administrator")+'</div>';
    h+='<div class="account-grid">'+caseTile("Reporting player",c.reporter_username)+caseTile("Registered phone",c.reporter_phone)+caseTile("Internal user ID",c.reporter_id)+caseTile("Account status",c.reporter_account_status);
    h+=caseTile("Other player",c.reported_username)+caseTile("Other player phone",c.reported_phone)+caseTile("Internal user ID",c.reported_user_id)+caseTile("Other player account",c.reported_account_status||"Not linked");h+='</div>';
    if(c.match_id){
        h+='<h3>Match #'+esc(c.match_id)+' investigation</h3><div class="account-grid">'+caseTile("Game / mode",c.match_mode)+caseTile("Match status",c.match_status)+caseTile("League / tournament",[c.league_name,c.tournament_name].filter(Boolean).join(" · ")||"Not listed")+caseTile("Round",c.round_name)+caseTile("Current winner",c.winner_username||"Draw / not set")+caseTile("Stake",c.stake_amount==null?"Not recorded":"KSh "+c.stake_amount)+caseTile("Match created",date(c.match_created_at))+caseTile("Started",date(c.started_at))+caseTile("Finished / settled",date(c.settled_at||c.finished_at))+'</div>';
        h+='<div class="reports"><div class="report"><span>Creator report · '+esc(c.creator_username||"Player")+' · '+esc(c.creator_phone||"No phone")+'</span><strong>'+esc(c.creator_submitted?namedScoreReport(c.creator_username||"Creator",c.creator_submitted_score,c.opponent_username||"Opponent",c.creator_submitted_opponent_score):"No report submitted")+'</strong></div><div class="report"><span>Opponent report · '+esc(c.opponent_username||"Player")+' · '+esc(c.opponent_phone||"No phone")+'</span><strong>'+esc(c.opponent_submitted?namedScoreReport(c.opponent_username||"Opponent",c.opponent_submitted_score,c.creator_username||"Creator",c.opponent_submitted_opponent_score):"No report submitted")+'</strong></div><div class="report"><span>Current database result</span><strong>'+esc(namedScoreReport(c.creator_username||"Creator",c.creator_score,c.opponent_username||"Opponent",c.opponent_score))+' · '+esc(c.winner_username||"Draw / not decided")+'</strong></div><div class="report"><span>Verification workflow</span><strong>'+esc(c.verification_status||"No verification record")+'</strong><div class="meta">Selected uploader: '+esc(c.selected_username||"None")+(c.selected_phone?" · "+esc(c.selected_phone):"")+" · "+esc(date(c.screenshot_submitted_at))+'</div></div></div>';
    }else h+='<div class="warn">This complaint is not associated with a match.</div>';
    h+='<h3>Evidence</h3><div class="evidence">';
    if(c.result_screenshot_available){h+='<div class="shotbox"><a class="evidence-link" target="_blank" rel="noopener" aria-label="Open result screenshot at full size"><img class="shot" data-case-verification="'+esc(c.verification_id)+'" alt="Private result screenshot loading"></a><div class="meta">Result verification screenshot · '+esc(c.selected_username||"Selected player")+' · '+esc(c.selected_phone||"No phone")+' · uploaded '+esc(date(c.screenshot_submitted_at))+'</div></div>';}else h+='<div class="shotbox">No result screenshot has been submitted for this report.</div>';
    if(c.evidence&&c.evidence.length){h+=c.evidence.map(function(ev){return '<div class="shotbox"><a class="evidence-link" target="_blank" rel="noopener" aria-label="Open complaint evidence at full size"><img class="shot" data-case-evidence="'+Number(ev.id)+'" alt="Private complaint evidence loading"></a><div class="meta">Uploaded by '+esc(ev.uploader_username||"Player")+' · '+esc(ev.uploader_phone||"No phone")+' · '+esc(ev.purpose||"evidence")+' · '+esc(date(ev.created_at))+' · '+esc(String(ev.byte_size||0))+' bytes</div></div>';}).join("");}
    else if(!c.result_screenshot_available)h+='<div class="shotbox">No additional complaint evidence has been submitted.</div>';
    h+='</div>';
    if(c.result_screenshot_available)h+='<div class="meta">Selected screenshot uploader: '+esc(c.selected_username||"Unknown")+' · '+esc(date(c.screenshot_submitted_at))+'</div>';
    h+='<h3>Case history</h3>';
    h+=(c.events&&c.events.length)?'<div class="activity-block">'+c.events.map(function(ev){return '<div class="activity-item"><strong>'+esc(String(ev.event_type||"event").replace(/_/g," "))+'</strong> · '+esc(date(ev.created_at))+' · '+esc(ev.actor_username||ev.actor_role||"System")+(ev.from_status||ev.to_status?' · '+esc(ev.from_status||"")+' → '+esc(ev.to_status||""):"")+(ev.message?' <br>'+esc(ev.message):"")+'</div>';}).join("")+'</div>':'<p class="help">No case history is available yet.</p>';
    h+='<h3>Private administrator notes</h3>';
    h+=(c.private_notes&&c.private_notes.length)?'<div class="activity-block">'+c.private_notes.map(function(n){return '<div class="activity-item"><strong>'+esc(n.admin_username||"Administrator")+'</strong> · '+esc(date(n.created_at))+'<br>'+esc(n.note)+'</div>';}).join("")+'</div>':'<p class="help">No private notes yet.</p>';
    h+='<form data-case-note-form="'+Number(c.id)+'" class="form"><label class="wide">Add private investigation note<textarea class="note" name="note" maxlength="4000" required placeholder="Only authorized admins can read this note."></textarea></label><button class="btn gold" type="submit">Save private note</button></form>';
    if(!["resolved","dismissed"].includes(c.status)){
        h+='<h3>Contact a player</h3><form data-case-request-form="'+Number(c.id)+'" class="form"><label>Player<select name="userId" class="select" required>'+participantOptions+'</select></label><label>Request<select name="requestType" class="select"><option value="evidence">Request evidence</option><option value="clarification">Ask for clarification</option></select></label><label class="wide">Private message<textarea class="note" name="message" maxlength="2000" required placeholder="Explain what information would help resolve this case."></textarea></label><button class="btn gold" type="submit">Send private request</button><span class="help">Sent to the player’s support inbox and in-app notifications; Web Push is queued when subscribed.</span></form>';
        h+='<h3>Case status / decision</h3><form data-case-status-form="'+Number(c.id)+'" class="form"><label>Status<select name="status" class="select"><option value="open">New</option><option value="investigating">Under review</option><option value="awaiting_player">Awaiting player response</option><option value="awaiting_evidence">Awaiting evidence</option><option value="escalated">Escalated</option>'+(c.source==="efootball_result_dispute"&&["disputed","awaiting_verification"].includes(c.match_status)?"":'<option value="resolved">Resolved</option><option value="dismissed">Dismissed</option>')+'</select></label><label class="wide">Resolution or dismissal reason<textarea name="reason" class="note" maxlength="2000" placeholder="Required when resolving or dismissing."></textarea></label><button class="btn gold" type="submit">Save status</button></form>';
        if(c.match_id&&["disputed","awaiting_verification"].includes(c.match_status)){
            h+='<h3>Result decision</h3><div class="warn">Enter the scores you verified from the screenshot. Resolving this result credits the winner or refunds both players on a draw, updates standings, and moves the complaint to Resolved.</div><form data-case-decision-form="'+Number(c.id)+'" class="form"><label>'+esc(creatorName)+' verified goals<input class="score" name="creatorScore" type="number" min="0" max="99" step="1" value="'+(c.creator_score==null?"":Number(c.creator_score))+'"></label><label>'+esc(opponentName)+' verified goals<input class="score" name="opponentScore" type="number" min="0" max="99" step="1" value="'+(c.opponent_score==null?"":Number(c.opponent_score))+'"></label><label class="wide">Decision reason<textarea class="note" name="reason" maxlength="2000" minlength="10" required placeholder="Document the evidence and platform rule used."></textarea></label><div class="actions wide"><button class="btn gold" type="button" data-case-decision="correct">Settle score & mark complaint Resolved</button></div></form>';
        }
        if(c.source==="efootball_result_dispute"&&c.match_status==="disputed"&&Number(c.stake_amount)>0){
            var refundTotal=(Number(c.stake_amount)*2).toFixed(2);
            h+='<h3>Refund disputed stakes</h3><div class="warn">If the screenshots and reports do not establish a fair result, cancel the match and return both locked stakes (KSh '+esc(refundTotal)+') directly to the players. No money goes to the administrator wallet.</div><form data-case-forfeit-form="'+Number(c.id)+'" class="form"><label class="wide">Reason for refunding the stakes<textarea class="note" name="reason" maxlength="2000" minlength="10" required placeholder="Record why the dispute cannot be resolved from the evidence."></textarea></label><div class="actions wide"><button class="btn red" type="button" data-case-forfeit="'+Number(c.id)+'">Refund both players &amp; resolve</button></div></form>';
        }
    }else h+='<div class="warn">'+esc(c.status)+': '+esc(c.resolution_reason||"No public resolution reason was recorded.")+'</div>';
    h+='</section>';
    return h;
}
async function loadComplaintImages(){
    complaintUrls.forEach(URL.revokeObjectURL);complaintUrls=[];
    var images=Array.from(document.querySelectorAll("#complaintView img[data-case-evidence],#complaintView img[data-case-verification]"));
    await Promise.all(images.map(async function(img){
        var url=img.dataset.caseEvidence?"/api/admin/complaint-cases/"+encodeURIComponent(currentComplaintId)+"/evidence/"+encodeURIComponent(img.dataset.caseEvidence):"/api/admin/result-verifications/"+encodeURIComponent(img.dataset.caseVerification)+"/screenshot";
        try{var r=await fetch(GG.API_BASE+url,{headers:{Authorization:"Bearer "+GG.getToken()},cache:"no-store"});if(!r.ok)throw new Error("Evidence is unavailable or access was denied.");var blob=await r.blob(),objectUrl=URL.createObjectURL(blob);complaintUrls.push(objectUrl);if(img.isConnected){img.src=objectUrl;img.closest("a").href=objectUrl;}}
        catch(error){if(img.isConnected){var box=img.closest(".shotbox"),empty=document.createElement("div");empty.className="empty";empty.textContent=error.message;img.closest("a").replaceWith(empty);}}
    }));
}
async function openComplaint(id){
    currentComplaintId=Number(id);$("complaintView").innerHTML='<div class="empty">Loading complaint details…</div>';$("complaintDialog").showModal();
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(currentComplaintId));
    if(!r.ok){$("complaintView").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load complaint details.")+'</div>';return;}
    $("complaintView").innerHTML=renderComplaintCase(r.data.complaint);var status=$("complaintView").querySelector('[data-case-status-form] select[name="status"]');if(status)status.value=r.data.complaint.status;
    await loadComplaintImages();
}
async function complaintCaseStatus(form){
    var id=form.dataset.caseStatusForm,status=form.elements.status.value,reason=form.elements.reason.value.trim();
    if(["resolved","dismissed"].includes(status)&&(!reason||!confirm("Save this documented case outcome?")))return;
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/status",{method:"POST",body:{status:status,reason:reason,note:""}});
    if(!r.ok){say(r.data.message||"Could not update complaint status.","error");return;}
    say("Complaint status updated.","ok");await refresh(true);await openComplaint(id);
}
async function complaintPrivateNote(form){
    var id=form.dataset.caseNoteForm,input=form.elements.note,note=input.value.trim();if(!note)return;
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/notes",{method:"POST",body:{note:note}});
    if(!r.ok){say(r.data.message||"Could not save note.","error");return;}
    say("Private note saved.","ok");await openComplaint(id);
}
async function complaintPlayerRequest(form){
    var id=form.dataset.caseRequestForm,message=form.elements.message.value.trim();if(!message)return;
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/requests",{method:"POST",body:{userId:Number(form.elements.userId.value),requestType:form.elements.requestType.value,message:message}});
    if(!r.ok){say(r.data.message||"Could not send player request.","error");return;}
    say("Private request sent to the selected player.","ok");await refresh(true);await openComplaint(id);
}
async function complaintDecision(button){
    var form=button.closest("[data-case-decision-form]"),id=form.dataset.caseDecisionForm,decision=button.dataset.caseDecision,reason=form.elements.reason.value.trim();
    var body={decision:decision,reason:reason};
    if(decision==="correct"){
        if(!reason||!confirm("Correct and settle this match using the entered verified score? This action updates standings and any unsettled match funds.") )return;
        body.creatorScore=Number(form.elements.creatorScore.value);body.opponentScore=Number(form.elements.opponentScore.value);body.confirm=true;
    }else if(!reason||!confirm(decision==="uphold"?"Uphold the currently recorded result?":"Dismiss this unsupported result report?"))return;
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/decision",{method:"POST",body:body});
    if(!r.ok){say(r.data.message||"Could not save the decision.","error");return;}
    say(r.data.message||"Decision saved.","ok");await refresh(true);await openComplaint(id);
}
async function forfeitDisputedStakes(button){
    var form=button.closest("[data-case-forfeit-form]"),id=form&&form.dataset.caseForfeitForm,reason=form&&form.elements.reason.value.trim();
    if(!id||!reason||reason.length<10){say("Enter a reason of at least 10 characters before refunding the stakes.","error");return;}
    if(!confirm("Resolve this disputed match as cancelled and return each locked stake to its player? No funds will be transferred to the administrator wallet."))return;
    button.disabled=true;
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/refund-stakes",{method:"POST",body:{confirm:true,reason:reason}});
    if(!r.ok){button.disabled=false;say(r.data.message||"Could not refund the disputed stakes.","error");return;}
    say(r.data.message+" Total returned: "+GG.formatMoney(r.data.amount)+".","ok");
    await refresh(true);await openComplaint(id);
}
async function loadThreads() {
    var r=await GG.api("/api/admin/support"+(includeCleared?"?includeCleared=true":""));
    if(!r.ok){$("threads").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load inbox.")+'</div>';return;}
    var list=r.data.threads||[], unread=list.reduce(function(n,t){return n+(Number(t.unread)||0);},0);
    $("statUnread").textContent=unread; $("navUnread").textContent=unread;
    $("threads").innerHTML=list.length?list.map(function(t){var id=Number(t.user_id),name=t.username||"Player",cleared=!!t.admin_cleared_at,label=cleared?"Restore chat":"Clear chat",action=cleared?"restore":"clear",resolved=t.support_status==='resolved',topic=[t.support_category,t.support_subject].filter(Boolean).join(" · ");return '<div class="thread-row"><button class="thread'+(id===Number(selectedUser)?" active":"")+'" data-thread="'+id+'" data-name="'+esc(name)+'"><span class="thread-name">'+esc(name)+(Number(t.unread)?' <span class="unread">'+Number(t.unread)+'</span>':"")+(cleared?' <span class="badge">Cleared</span>':"")+(resolved?' <span class="badge">Resolved</span>':'')+'</span>'+(topic?'<span class="meta">'+esc(topic.replace(/_/g," "))+'</span>':'')+'<span class="last">'+esc(t.last_message||"No messages yet")+'</span></button><button class="btn thread-clear" type="button" data-support-status="'+id+'" data-next-status="'+(resolved?'open':'resolved')+'">'+(resolved?'Reopen':'Resolve')+'</button><button class="btn thread-clear" type="button" data-thread-clear="'+id+'" data-thread-action="'+action+'" aria-label="'+label+' for '+esc(name)+'" title="'+label+' for '+esc(name)+'">'+label+'</button></div>';}).join(""):'<div class="empty">No player support messages in this view.</div>';
    var selected=list.find(function(t){return Number(t.user_id)===Number(selectedUser)}), currentClear=$("clearSelectedSupport");
    if(currentClear){var restore=!!(selected&&selected.admin_cleared_at);currentClear.disabled=!selected;currentClear.dataset.threadClear=selected?String(selectedUser):"";currentClear.dataset.threadAction=restore?"restore":"clear";currentClear.textContent=restore?"Restore chat to inbox":"Clear chat from inbox";currentClear.setAttribute("aria-label",currentClear.textContent);currentClear.title=currentClear.textContent;}
}
async function loadMessages(force) {
    if(selectedUser==null)return;
    if(!force&&document.activeElement===$("reply"))return;
    var r=await GG.api("/api/admin/support/"+encodeURIComponent(selectedUser));
    if(!r.ok){$("convheadLabel").textContent=r.data.message||"Could not load conversation.";return;}
    var list=r.data.messages||[], sig=list.map(function(m){return m.id+":"+m.message+":"+(m.read_at||"");}).join("|");
    if(sig===messageSig)return; messageSig=sig;
    var pane=$("messages"), bottom=pane.scrollHeight-pane.scrollTop-pane.clientHeight<70;
    pane.innerHTML=list.length?list.map(function(m){var mine=Number(m.sender_id)===Number(adminId),receipt=mine?(m.read_at?" · Seen by player":" · Sent"):"";return '<div class="bubble'+(mine?" mine":"")+'">'+esc(m.message)+'<small>'+esc(mine?"You":m.username||selectedName)+" · "+esc(date(m.created_at))+esc(receipt)+'</small></div>';}).join(""):'<div class="empty">No messages in this conversation.</div>';
    if(bottom)pane.scrollTop=pane.scrollHeight;
    $("convheadLabel").textContent=selectedName+" · "+list.length+" message"+(list.length===1?"":"s");
}
async function updateSupportStatus(button) {
    button.disabled=true;
    var id=button.dataset.supportStatus,status=button.dataset.nextStatus;
    var result=await GG.api("/api/admin/support/"+encodeURIComponent(id)+"/status",{method:"POST",body:{status:status}});
    if(!result.ok){button.disabled=false;say(result.data.message||"Could not update support status.","error");return;}
    say(result.data.message||"Support status updated.","ok");
    await loadThreads();
}
async function loadUsers() {
    var query=$("userSearch").value.trim(), r=await GG.api("/api/admin/users?search="+encodeURIComponent(query));
    if(!r.ok){$("userList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load accounts.")+'</div>';return;}
    users=r.data.users||[];


    $("userList").innerHTML=users.length?users.map(function(u,index){
        var id=Number(u.id), self=id===Number(adminId), status=String(u.account_status||"active"), cls=status==="active"?"active-status":status==="suspended"?"suspended-status":"closed-status";
        var h='<article class="userrow" data-user="'+id+'"><div><span class="account-number">Account #'+(index+1)+'</span><br><strong>'+esc(u.username)+(self?' <span class="badge good">You</span>':"")+'</strong><span class="account-presence'+(u.online?' is-online':'')+'" data-account-presence="'+id+'" role="status" aria-label="'+(u.online?'Online':'Offline')+'">'+(u.online?'Online':'Offline')+'</span><div class="user-meta">'+esc(u.game||"both")+" · "+esc(u.role||"user")+" · Rating "+esc(u.rating)+"<br>Available "+esc(GG.formatMoney(u.balance||0))+" · Locked "+esc(GG.formatMoney(u.locked_balance||0))+'</div></div><strong class="'+cls+'">'+esc(status)+'</strong><div class="user-actions">';
        h+='<label class="sr-only" for="un'+id+'">Optional action note</label><input id="un'+id+'" class="note" data-user-note maxlength="1000" placeholder="Optional note">';
        h+='<button class="btn" type="button" data-view-dashboard="'+id+'">View dashboard</button>';
        if(self)h+='<span class="foot">Your admin access is protected.</span>';
        else {
            if(status!=="active")h+='<button class="btn" data-status="active" data-id="'+id+'">Reactivate</button>';
            if(status!=="suspended")h+='<button class="btn" data-status="suspended" data-id="'+id+'">Suspend</button>';
            if(status!=="closed")h+='<button class="btn red" data-status="closed" data-id="'+id+'">Close account</button>';
            if(u.role!=="admin")h+='<button class="btn red" type="button" data-delete-account="'+id+'">Delete permanently</button>';
        }
        return h+'</div></article>';
    }).join(""):'<div class="empty">No accounts match that search.</div>';
    updateAccountPresence(GG.getOnlineUserIds());
}
async function loadWalletAdjustmentUsers() {
    var query=$("walletAdjustmentSearch").value.trim();
    if(!query){walletAdjustmentUsers=[];$("walletAdjustmentList").innerHTML='<div class="empty">Search for a username or phone to adjust an available wallet balance.</div>';return;}
    var r=await GG.api("/api/admin/users?search="+encodeURIComponent(query));
    if(!r.ok){$("walletAdjustmentList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not find player accounts.")+'</div>';return;}
    walletAdjustmentUsers=r.data.users||[];
    $("walletAdjustmentList").innerHTML=walletAdjustmentUsers.length?walletAdjustmentUsers.map(function(u){
        var id=Number(u.id),self=id===Number(adminId);
        return '<article class="userrow" data-wallet-user="'+id+'"><div><strong>'+esc(u.username)+(self?' <span class="badge good">You</span>':"")+'</strong><div class="user-meta">'+esc(u.game||"both")+" · "+esc(u.role||"user")+"<br>Available "+esc(GG.formatMoney(u.balance||0))+" · Locked "+esc(GG.formatMoney(u.locked_balance||0))+'</div></div><div class="user-actions"><label>Adjustment amount<input class="wallet-adjust" data-wallet-delta type="number" step="0.01" min="-1000000" max="1000000" placeholder="± KSh"></label><label>Reason<input class="note" data-wallet-reason maxlength="1000" placeholder="Required · at least 10 characters"></label><button class="btn gold" type="button" data-wallet-adjust="'+id+'">Adjust available balance</button></div></article>';
    }).join(""):'<div class="empty">No accounts match that search.</div>';
}
async function loadAnnouncements() {
    var r=await GG.api("/api/admin/announcements");
    if(!r.ok){$("announcementList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load announcements.")+'</div>';return;}
    var all=r.data.announcements||[],list=includeInactiveAnnouncements?all:all.filter(function(a){return !!a.active;});
    $("announcementList").innerHTML=list.length?list.map(function(a){
        var delivery=a.published_at?'Published '+date(a.published_at):a.publish_at?'Scheduled '+date(a.publish_at):'Not delivered';
        var audience=a.audience==='chess'?'Chess players':a.audience==='konami'?'eFootball players':'All active users';
        var details='<div class="meta">'+esc(date(a.created_at))+' · '+esc(delivery)+' · '+esc(audience)+' · '+(a.active?'Visible to players':'Hidden')+'</div>';
        if(a.event_name)details+='<div class="meta">'+esc(a.event_name)+' · starts '+esc(date(a.event_at))+' ('+esc(a.event_time_zone||'Africa/Nairobi')+')</div>';
        var h='<article class="announcement-row"><div><div class="announcement-message">'+esc(a.message)+'</div>'+details+'</div><div class="actions">';
        h+=a.active?'<button class="btn" type="button" data-deactivate-announcement="'+Number(a.id)+'">Hide</button>':'<span class="badge">Inactive</span>';
        h+='<button class="btn red" type="button" data-delete-announcement="'+Number(a.id)+'">Delete</button></div></article>';
        return h;
    }).join(""):'<div class="empty">'+(includeInactiveAnnouncements?"No announcements in the archive.":"No active announcements.")+'</div>';
}
function renderCompanionTrackerRow(member) {
    var id = Number(member.user_id), acknowledged = !!member.guide_acknowledged;
    var downloaded = !!member.downloaded_at;
    var active = !!member.currently_registered;
    var recent = !!member.recently_active;
    var permission = String(member.notification_permission_status || "unknown");
    var registration = active ? (recent ? "Registered · recently active" : "Registered · stale") : member.installation_count ? "Previously registered · inactive" : "Not detected";
    return '<tr><td><strong>' + esc(member.username || "Member") + '</strong><div class="user-meta">User ID ' + id + '</div></td>' +
        '<td>' + (acknowledged ? 'Acknowledged<br><span class="user-meta">' + esc(date(member.onboarding_acknowledged_at)) + '</span>' : 'Not acknowledged') + '</td>' +
        '<td>' + (downloaded ? 'Downloaded<br><span class="user-meta">' + esc(date(member.last_downloaded_at || member.downloaded_at)) + '</span>' : 'Not detected') + '</td>' +
        '<td>' + esc(registration) + (member.last_seen_at ? '<br><span class="user-meta">Last seen ' + esc(date(member.last_seen_at)) + '</span>' : '') + '</td>' +
        '<td>' + esc(permission) + (member.notification_permission_checked_at ? '<br><span class="user-meta">Checked ' + esc(date(member.notification_permission_checked_at)) + '</span>' : '') + '</td>' +
        '<td>' + esc(member.app_version || 'Unknown') + '</td>' +
        '<td>' + esc(member.registered_at ? date(member.registered_at) : '—') + '</td>' +
        '<td><button class="btn" type="button" data-companion-member="' + id + '">Details</button></td></tr>';
}
async function loadCompanionTracker() {
    if (companionTrackerBusy) return;
    companionTrackerBusy = true;
    var params = new URLSearchParams({ filter: $("companionFilter").value, search: companionSearch, page: String(companionPage), pageSize: "40" });
    var r = await GG.api("/api/admin/companion-tracker?" + params.toString());
    companionTrackerBusy = false;
    if (!r.ok) {
        $("companionTrackerList").innerHTML = '<div class="empty">' + esc(r.data.message || "Could not load companion records.") + '</div>';
        return;
    }
    var stats = r.data.stats || {};
    [["companionStatMembers", "total_members"], ["companionStatAcknowledged", "guide_acknowledged"], ["companionStatDownloads", "downloaded_members"], ["companionStatAnonymousDownloads", "anonymous_downloads"], ["companionStatRegistered", "registered_members"], ["companionStatRecent", "recently_active_members"], ["companionStatGranted", "notifications_granted"], ["companionStatDenied", "notifications_denied"], ["companionStatUnknown", "notifications_unknown"]].forEach(function(pair) {
        $(pair[0]).textContent = (Number(stats[pair[1]]) || 0).toLocaleString();
    });
    var members = r.data.members || [];
    $("companionTrackerList").innerHTML = members.length
        ? '<div style="max-width:100%;overflow:auto"><table style="width:100%;min-width:980px;border-collapse:collapse"><thead><tr>' + ["Member", "Guide", "APK download", "Companion", "Notifications", "App version", "Registered", ""].map(function(label) { return '<th scope="col" style="padding:9px;text-align:left;border-bottom:1px solid #3b3b37;color:#e9c547">' + label + '</th>'; }).join("") + '</tr></thead><tbody>' + members.map(renderCompanionTrackerRow).join("") + '</tbody></table></div>'
        : '<div class="empty">No members match this filter.</div>';
    companionPages = Math.max(1, Math.ceil(Number(r.data.total || 0) / Number(r.data.pageSize || 40)));
    companionPage = Number(r.data.page) || 1;
    $("companionPageLabel").textContent = "Page " + companionPage + " of " + companionPages + " · " + Number(r.data.total || 0).toLocaleString() + " members";
    $("companionPrev").disabled = companionPage <= 1;
    $("companionNext").disabled = companionPage >= companionPages;
    $("companionTrackerMessage").textContent = "A download record means the APK was served. It does not confirm installation; only a signed-in app registration does.";
}
async function openCompanionMember(userId) {
    $("companionView").innerHTML = '<div class="empty">Loading companion details…</div>';
    $("companionDialog").showModal();
    var r = await GG.api("/api/admin/companion-tracker/" + encodeURIComponent(userId));
    if (!r.ok) { $("companionView").innerHTML = '<div class="empty">' + esc(r.data.message || "Could not load companion details.") + '</div>'; return; }
    var member = r.data.member || {}, installations = member.installations || [];
    var html = '<h3>' + esc(member.username || "Member") + ' · User ID ' + Number(member.user_id) + '</h3><div class="account-grid">' +
        caseTile("Account game", member.game) + caseTile("Account status", member.account_status) +
        caseTile("Guide version", member.onboarding_version || "Not acknowledged") + caseTile("Guide acknowledgement", date(member.onboarding_acknowledged_at)) +
        caseTile("APK downloaded", member.downloaded ? "Yes" : "Not detected") + caseTile("First download", date(member.downloaded_at)) + '</div><h3>Companion installations</h3>';
    html += installations.length ? installations.map(function(item, index) {
        return '<article class="activity-block"><strong>Installation ' + (index + 1) + ' · ' + esc(item.platform || "Android") + ' · v' + esc(item.appVersion || "unknown") + '</strong>' +
            '<div class="activity-item">Registration: ' + esc(date(item.registeredAt)) + '<br>Last activity: ' + esc(date(item.lastSeenAt)) +
            '<br>Notifications: ' + esc(item.notificationPermissionStatus || "unknown") + (item.notificationPermissionCheckedAt ? ' · checked ' + esc(date(item.notificationPermissionCheckedAt)) : "") +
            (item.unregisteredAt ? '<br>Signed out: ' + esc(date(item.unregisteredAt)) : '<br>Currently registered') + '</div></article>';
    }).join("") : '<div class="empty">No companion installation has been detected for this account.</div>';
    $("companionView").innerHTML = html;
}
async function loadCompetitionList() {
    var response=await GG.api("/api/admin/competitions");
    if(!response.ok){$("competitionTable").innerHTML='<div class="empty">'+esc(response.data.message||"Could not load competition tables.")+'</div>';return;}
    var items=response.data.competitions||[],select=$("competitionSelect"),previous=select.value;
    select.innerHTML='<option value="">Select a league or tournament</option>'+items.map(function(item){
        return '<option value="'+esc(item.type+":"+item.id)+'">'+esc(item.name)+" · "+esc(item.type)+" · "+esc(String(item.status||"open").replace(/_/g," "))+'</option>';
    }).join("");
    if(items.some(function(item){return item.type+":"+item.id===previous;}))select.value=previous;
    if(select.value)await loadCompetitionTable();
}
async function loadCompetitionTable() {
    var selected=$("competitionSelect").value.split(":"),type=selected[0],id=Number(selected[1]);
    if(!type||!Number.isSafeInteger(id)){ $("competitionTable").innerHTML='<div class="empty">Choose a competition to load its table.</div>';return; }
    var response=await GG.api("/api/admin/competitions/"+encodeURIComponent(type)+"/"+encodeURIComponent(id));
    if(!response.ok){$("competitionTable").innerHTML='<div class="empty">'+esc(response.data.message||"Could not load this table.")+'</div>';return;}
    var rows=response.data.standings||[],competition=response.data.competition;
    $("competitionMessage").textContent=competition.name+" · "+String(competition.status||"open").replace(/_/g," ")+" · Entry KSh "+Number(competition.entry_fee||0)+" · "+rows.length+" player(s)";
    $("competitionTable").innerHTML=rows.length?rows.map(function(row,index){
        var forfeited=!!row.forfeited_at;
        return '<article class="competition-row" data-competition-user="'+Number(row.user_id)+'"><div><strong>#'+(index+1)+" · "+esc(row.username)+"</strong><span class=\"badge\">"+(forfeited?"Forfeited":"KSh "+Number(row.fee_paid||0)+" entry")+"</span> <span class=\"meta\">Played "+Number(row.played||0)+" · W "+Number(row.wins||0)+" D "+Number(row.draws||0)+" L "+Number(row.losses||0)+" · Pts "+Number(row.points||0)+" · GD "+Number(row.goal_difference||0)+"</span></div>"+
          '<form class="competition-edit" data-competition-type="'+esc(type)+'" data-competition-id="'+id+'" data-user-id="'+Number(row.user_id)+'">'+
          '<label>Wins<input name="wins" type="number" min="0" max="10000" step="1" value="'+Number(row.wins||0)+'" '+(forfeited?"disabled":"")+'></label><label>Draws<input name="draws" type="number" min="0" max="10000" step="1" value="'+Number(row.draws||0)+'" '+(forfeited?"disabled":"")+'></label><label>Losses<input name="losses" type="number" min="0" max="10000" step="1" value="'+Number(row.losses||0)+'" '+(forfeited?"disabled":"")+'></label><label>Goals for<input name="goalsFor" type="number" min="0" max="10000" step="1" value="'+Number(row.goals_for||0)+'" '+(forfeited?"disabled":"")+'></label><label>Goals against<input name="goalsAgainst" type="number" min="0" max="10000" step="1" value="'+Number(row.goals_against||0)+'" '+(forfeited?"disabled":"")+'></label><label>Reason<input name="reason" maxlength="1000" placeholder="Required · at least 10 characters" '+(forfeited?"disabled":"")+'></label><button class="btn gold" type="submit" '+(forfeited?"disabled":"")+'>Save table edit</button></form></article>';
    }).join(""):'<div class="empty">No entries in this competition yet.</div>';
}
async function saveCompetitionEdit(form) {
    var body={wins:Number(form.elements.wins.value),draws:Number(form.elements.draws.value),losses:Number(form.elements.losses.value),goalsFor:Number(form.elements.goalsFor.value),goalsAgainst:Number(form.elements.goalsAgainst.value),reason:form.elements.reason.value.trim()};
    if(body.reason.length<10){say("Add a reason of at least 10 characters for the table edit.","error");return;}
    var button=form.querySelector("button[type=submit]");button.disabled=true;
    var url="/api/admin/competitions/"+encodeURIComponent(form.dataset.competitionType)+"/"+encodeURIComponent(form.dataset.competitionId)+"/standings/"+encodeURIComponent(form.dataset.userId);
    var response=await GG.api(url,{method:"POST",body:body});button.disabled=false;
    if(!response.ok){say(response.data.message||"Could not update the table.","error");return;}
    say(response.data.message||"Competition table updated.","ok");await loadCompetitionTable();
}
async function loadOverview() {
    var r=await GG.api("/api/admin/overview"); if(!r.ok)return;
    var u=r.data.users||{};
    $("statActiveUsers").textContent=(Number(u.active)||0).toLocaleString();
    $("statRestricted").textContent=((Number(u.suspended)||0)+(Number(u.closed)||0)).toLocaleString();
}
async function loadAdminWallet() {
    var r=await GG.api("/api/admin/wallet");
    if(!r.ok){$("adminWalletBalance").textContent="Unavailable";$("adminWalletTransactions").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load administrator wallet.")+'</div>';return;}
    var wallet=r.data.wallet||{},items=r.data.transactions||[];
    $("adminWalletBalance").textContent=GG.formatMoney(wallet.balance||0);
    $("adminWalletTransactions").innerHTML=items.length?items.map(function(t){
        return '<article class="activity-item"><strong>'+esc(String(t.transaction_type||"wallet activity").replace(/_/g," "))+' · '+esc(GG.formatMoney(t.amount))+'</strong><br>'+esc(t.status||"completed")+' · '+esc(date(t.created_at))+(t.reference?'<br>Ref: '+esc(t.reference):"")+(t.description?'<br>'+esc(t.description):"")+'</article>';
    }).join(""):'<div class="empty">No administrator wallet activity is visible.</div>';
}
async function loadManualWithdrawals() {
    var list=$("manualWithdrawalsList");
    if(!list)return;
    var r=await GG.api("/api/admin/wallet/manual-withdrawals");
    if(!r.ok){list.innerHTML='<div class="empty">'+esc(r.data.message||"Could not load player withdrawal requests.")+'</div>';return;}
    var items=r.data.withdrawals||[];
    var pending=items.filter(function(item){return item.status==="pending";}).length;
    if($("navManualWithdrawals"))$("navManualWithdrawals").textContent=String(pending);
    list.innerHTML=items.length?items.map(function(item){
        var id=Number(item.id), completed=item.status==="completed";
        var h='<article class="withdrawal-row" data-manual-withdrawal="'+id+'"><div class="withdrawal-row-head"><div><strong>'+esc(item.username||"Player")+' · '+esc(item.recipient_phone)+'</strong><div class="user-meta">Request '+esc(item.reference)+' · '+esc(date(item.requested_at))+'</div></div><span class="badge '+(completed?'good':'wait')+'">'+(completed?'Paid manually':'Awaiting manual payout')+'</span></div>';
        h+='<div class="withdrawal-amounts"><span>Wallet deduction after confirmation <strong>'+esc(GG.formatMoney(item.total_amount))+'</strong></span><span>Fee included <strong>'+esc(GG.formatMoney(item.fee_amount))+'</strong></span><span>Send to player <strong>'+esc(GG.formatMoney(item.payout_amount))+'</strong></span><span>Current wallet balance <strong>'+esc(GG.formatMoney(item.current_balance))+'</strong></span></div>';
        if(completed){
            h+='<div class="actions"><button class="btn gold" type="button" data-manual-withdrawal-clear="'+id+'">Clear completed withdrawal</button></div>';
        }else{
            h+='<div class="actions"><button class="btn gold" type="button" data-manual-withdrawal-complete="'+id+'">Confirm payment sent · deduct '+esc(GG.formatMoney(item.total_amount))+'</button></div><div class="foot">Send the listed net amount to the player first. Confirming here then deducts the gross amount (including the fee) from the wallet.</div>';
        }
        return h+'</article>';
    }).join(""):'<div class="empty">No player withdrawals need manual handling.</div>';
}
async function manualWithdrawalAction(button) {
    var id=button.dataset.manualWithdrawalComplete||button.dataset.manualWithdrawalClear;
    var completing=!!button.dataset.manualWithdrawalComplete;
    var card=button.closest("[data-manual-withdrawal]");
    var prompt=completing
        ? "Confirm you have manually sent the listed M-Pesa payout. This will mark the withdrawal successful and deduct its gross amount from the player’s wallet."
        : "Clear this completed withdrawal from the admin queue? The wallet and transaction records remain saved.";
    if(!confirm(prompt))return;
    button.disabled=true;
    var path="/api/admin/wallet/manual-withdrawals/"+encodeURIComponent(id)+(completing?"/complete":"/clear");
    var r=await GG.api(path,{method:"POST",body:{}});
    if(!r.ok){button.disabled=false;say(r.data.message||"Could not update this withdrawal.","error");return;}
    say(r.data.message||"Withdrawal updated.","ok");
    await loadManualWithdrawals();
}
async function clearAdminWalletHistory() {
    if(!confirm("Clear the administrator wallet activity from this view? Financial ledger entries will stay saved for reconciliation."))return;
    var button=$("clearAdminWalletHistory");button.disabled=true;
    var r=await GG.api("/api/admin/wallet/history/clear",{method:"POST",body:{}});button.disabled=false;
    if(!r.ok){say(r.data.message||"Could not clear administrator wallet activity.","error");return;}
    say(r.data.message||"Administrator wallet activity cleared.","ok");await loadAdminWallet();
}
function renderManagedMatch(m) {
    var id=Number(m.id), game=m.game==="chess"?"Chess":"eFootball", cleared=!!m.admin_cleared_at;
    var creator=m.creator_username||"Player", opponent=m.opponent_username||"Waiting for opponent";
    var matchType=String(m.match_type||"match").replace(/_/g," ");
    var mode=m.game==="konami"?(m.league?(m.league+" league"):m.mode||matchType):(m.time_control||matchType);
    var result=m.game==="konami"&&m.creator_score!=null&&m.opponent_score!=null
        ? "Score "+m.creator_score+"–"+m.opponent_score
        : String(m.result_status||"No result").replace(/_/g," ");
    var h='<article class="card" data-managed-match="'+id+'" data-game="'+esc(m.game)+'"><div class="card-top"><div><h3>'+esc(game)+' match #'+id+' · '+esc(matchType)+'</h3><div class="meta">'+esc(creator)+' vs '+esc(opponent)+' · '+esc(mode)+' · '+esc(date(m.created_at))+'</div></div><span class="badge '+(m.is_terminal?"good":"wait")+'">'+esc(String(m.status||"unknown").replace(/_/g," "))+'</span></div>';
    h+='<div class="meta">'+esc(result)+' · Stake per player: '+esc(GG.formatMoney(m.stake_amount||0))+(m.finished_at?' · Finished '+esc(date(m.finished_at)):"")+(m.cleared_by_username?' · Cleared by '+esc(m.cleared_by_username):"")+'</div>';
    h+='<div class="actions">';
    if(m.creator_id)h+='<button class="btn" type="button" data-match-wallet="'+Number(m.creator_id)+'" data-match-username="'+esc(creator)+'">Adjust '+esc(creator)+' wallet</button>';
    if(m.opponent_id)h+='<button class="btn" type="button" data-match-wallet="'+Number(m.opponent_id)+'" data-match-username="'+esc(opponent)+'">Adjust '+esc(opponent)+' wallet</button>';
    h+='</div>';
    if(m.can_cancel_refund){
        h+='<div class="form"><label class="wide">Admin reason<input class="note" data-match-action-reason maxlength="1000" placeholder="Required · at least 10 characters"></label><div class="wide"><button class="btn red" type="button" data-match-cancel-refund="'+id+'">'+(Number(m.stake_amount)>0?'Cancel match · refund locked stake':'Cancel match')+'</button></div></div>';
    } else if(m.game==="chess"&&m.match_type==="tournament"&&!m.is_terminal){
        h+='<div class="foot">Chess tournament stakes are handled by competition settlement.</div>';
    }
    if(m.can_edit_score&&m.game==="chess"){
        h+='<form class="form" data-chess-result-form data-match-id="'+id+'"><strong class="wide">Set verified Chess result</strong><label class="wide">Game result<select class="select" data-chess-result required><option value="">Choose a result</option><option value="white_win">White wins</option><option value="black_win">Black wins</option><option value="draw">Draw</option></select></label><label class="wide">Admin reason<input class="note" data-chess-result-reason maxlength="1000" placeholder="Required · at least 10 characters"></label><div class="wide"><button class="btn gold" type="submit">Save result and settle</button></div><p class="foot wide">This settles the match and updates the wallet and ranked rating where applicable.</p></form>';
    } else if(m.can_edit_score){
        h+='<form class="form" data-match-score-form data-match-id="'+id+'"><strong class="wide">Set verified eFootball score</strong><label>Creator · '+esc(creator)+'<input class="score" data-score-creator type="number" min="0" max="99" step="1" required></label><label>Opponent · '+esc(opponent)+'<input class="score" data-score-opponent type="number" min="0" max="99" step="1" required></label><label class="wide">Admin reason<input class="note" data-score-reason maxlength="1000" placeholder="Required · at least 10 characters"></label><div class="wide"><button class="btn gold" type="submit">Save score and settle</button></div><p class="foot wide">This settles the match and updates the wallet, league/tournament standings, and player notices.</p></form>';
    }
    if(m.is_terminal){
        h+='<div class="actions"><button class="btn '+(cleared?'':'gold')+'" type="button" data-match-visibility="'+(cleared?'restore':'clear')+'" data-id="'+id+'" data-game="'+esc(m.game)+'">'+(cleared?'Restore to list':'Clear from list')+'</button></div>';
    }
    return h+'</article>';
}
async function loadMatchManagement() {
    var params=new URLSearchParams({game:$('matchGameFilter').value,type:$('matchTypeFilter').value});
    if(includeClearedMatches)params.set('includeCleared','true');
    var r=await GG.api('/api/admin/matches?'+params.toString());
    if(!r.ok){$('matchManagementList').innerHTML='<div class="empty">'+esc(r.data.message||'Could not load matches.')+'</div>';return;}
    var list=r.data.matches||[];
    $('matchManagementList').innerHTML=list.length?list.map(renderManagedMatch).join(''):'<div class="empty">No matches in this view.</div>';
}
async function clearAllMatches() {
    await clearAdminItems($('clearAllMatches'),'/api/admin/matches/clear-terminal','Clear all completed or cancelled matches from both Chess and eFootball? Active matches will stay visible. Match, wallet, and audit history will be preserved and cleared matches can be restored.',async function(){
        includeClearedMatches=false;$('toggleClearedMatches').setAttribute('aria-pressed','false');$('toggleClearedMatches').textContent='Show cleared';await loadMatchManagement();
    },legacyClearMatches);
}
async function legacyClearMatches() {
    var records=[],seen=new Set(),games=['chess','konami'],types=['casual','ranked','league','tournament'];
    for(var g=0;g<games.length;g++)for(var t=0;t<types.length;t++){
        var params=new URLSearchParams({game:games[g],type:types[t]}),response=await GG.api('/api/admin/matches?'+params.toString());
        if(!response.ok)return {ok:false,message:response.data.message||'Could not load matches for the compatibility clear.'};
        (response.data.matches||[]).forEach(function(match){
            var key=match.game+':'+match.id;
            if(match.is_terminal&&!match.admin_cleared_at&&!seen.has(key)){seen.add(key);records.push({game:match.game,id:match.id});}
        });
    }
    return clearByLegacyRoutes(records,function(match){return '/api/admin/matches/'+encodeURIComponent(match.game)+'/'+encodeURIComponent(match.id)+'/clear';},'settled matches');
}
async function matchVisibilityAction(btn) {
    var action=btn.dataset.matchVisibility, clear=action==='clear';
    if(clear&&!confirm('Clear this settled match from the default admin list? The match, wallet and audit records will remain saved; it can be restored later.'))return;
    btn.disabled=true;
    var r=await GG.api('/api/admin/matches/'+encodeURIComponent(btn.dataset.game)+'/'+encodeURIComponent(btn.dataset.id)+'/'+action,{method:'POST'});
    if(!r.ok){btn.disabled=false;say(r.data.message||'Could not update this match list.','error');return;}
    say(r.data.message||'Match list updated.','ok');await loadMatchManagement();
}
async function cancelManagedMatch(btn) {
    var card=btn.closest('[data-managed-match]'), reason=card.querySelector('[data-match-action-reason]').value.trim();
    if(reason.length<10){say('Enter an admin reason of at least 10 characters.','error');return;}
    var game=card.dataset.game, id=btn.dataset.matchCancelRefund;
    if(!confirm('Cancel this '+(game==='chess'?'Chess':'eFootball')+' match? Any still-locked match stakes will be returned to the players. This action is recorded in the admin audit history.'))return;
    btn.disabled=true;
    var r=await GG.api('/api/admin/matches/'+encodeURIComponent(game)+'/'+encodeURIComponent(id)+'/cancel-refund',{method:'POST',body:{reason:reason}});
    if(!r.ok){btn.disabled=false;say(r.data.message||'Could not cancel and refund this match.','error');return;}
    say(r.data.message||'Match cancelled.','ok');await refresh(true);
}
async function saveManagedScore(form) {
    var creatorScore=Number(form.querySelector('[data-score-creator]').value), opponentScore=Number(form.querySelector('[data-score-opponent]').value), reason=form.querySelector('[data-score-reason]').value.trim();
    if(!Number.isInteger(creatorScore)||!Number.isInteger(opponentScore)||creatorScore<0||opponentScore<0||creatorScore>99||opponentScore>99){say('Scores must be whole numbers from 0 to 99.','error');return;}
    if(reason.length<10){say('Enter an admin reason of at least 10 characters.','error');return;}
    if(!confirm('Record '+creatorScore+'–'+opponentScore+' as the verified score? This will settle the match, wallet and competition standings.'))return;
    var button=form.querySelector('button[type=submit]');button.disabled=true;
    var r=await GG.api('/api/admin/matches/konami/'+encodeURIComponent(form.dataset.matchId)+'/scores',{method:'POST',body:{creatorScore:creatorScore,opponentScore:opponentScore,reason:reason}});
    if(!r.ok){button.disabled=false;say(r.data.message||'Could not save this score.','error');return;}
    say(r.data.message||'Score saved and settled.','ok');await refresh(true);
}
async function saveManagedChessResult(form) {
    var result=form.querySelector('[data-chess-result]').value, reason=form.querySelector('[data-chess-result-reason]').value.trim();
    if(!['white_win','black_win','draw'].includes(result)){say('Choose the Chess result.','error');return;}
    if(reason.length<10){say('Enter an admin reason of at least 10 characters.','error');return;}
    if(!confirm('Record '+result.replace('_',' ')+' as the Chess result? This will settle the wallet and update ranked ratings where applicable.'))return;
    var button=form.querySelector('button[type=submit]');button.disabled=true;
    var r=await GG.api('/api/admin/matches/chess/'+encodeURIComponent(form.dataset.matchId)+'/result',{method:'POST',body:{result:result,reason:reason}});
    if(!r.ok){button.disabled=false;say(r.data.message||'Could not save this Chess result.','error');return;}
    say(r.data.message||'Chess result saved and settled.','ok');await refresh(true);
}
function updateMatchTypeOptions() {
    var game=$('matchGameFilter').value, select=$('matchTypeFilter'), previous=select.value;
    var options=game==='chess'?['all','casual','ranked','tournament']:game==='konami'?['all','ranked','league','tournament']:['all','ranked','league','tournament'];
    var labels={all:'All match types',casual:'Casual',ranked:'Ranked',league:'League',tournament:'Tournament'};
    select.innerHTML=options.map(function(value){return '<option value="'+value+'">'+labels[value]+'</option>';}).join('');
    select.value=options.indexOf(previous)>=0?previous:'all';
}
function focusMatchPlayerWallet(btn) {
    location.hash='#adminWallet';
    $('walletAdjustmentSearch').value=btn.dataset.matchUsername||'';
    loadWalletAdjustmentUsers();
}
function editing(id) { var r=$(id),a=document.activeElement;return !!(r&&a&&r.contains(a)&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT")); }
async function refresh(force) {
    if(!adminAuthorized||busy||document.hidden)return; busy=true; $("live").textContent="Updating…";
    try {
        var tasks=[loadOverview(),loadManualWithdrawals()];
        if(force||!editing("resultList"))tasks.push(loadResults());
        if(force||!editing("matchManagement"))tasks.push(loadMatchManagement());
        if(force||!editing("complaintSearch"))tasks.push(loadComplaints());
        if(force||!editing("adminWalletWithdrawForm"))tasks.push(loadAdminWallet());
        if(force||!editing("accounts"))tasks.push(loadUsers());
        if(force||!editing("adminWallet")){if($("walletAdjustmentSearch").value.trim())tasks.push(loadWalletAdjustmentUsers());}
        if(force||!editing("competitionSelect"))tasks.push(loadCompetitionList());
        if(force||!editing("announcementForm"))tasks.push(loadAnnouncements());
        if(location.hash==="#companionTracker"&&(force||!editing("companionTracker")))tasks.push(loadCompanionTracker());
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
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/"+action,{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update the complaint list.","error");return;}
    say(r.data.message||"Complaint list updated.","ok");await loadComplaints();
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
async function resultVisibilityAction(btn) {
    var action=btn.dataset.resultVisibility,clear=action==="clear";
    if(clear&&!confirm("Clear this resolved result dispute from the list? Its match and audit history will remain saved; you can restore it later."))return;
    btn.disabled=true;
    var r=await GG.api("/api/admin/result-verifications/"+encodeURIComponent(btn.dataset.id)+"/"+action,{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update the result dispute list.","error");return;}
    say(r.data.message||"Result dispute list updated.","ok");await loadResults();
}
async function clearAllResults() {
    await clearAdminItems($('clearAllResults'),'/api/admin/result-verifications/clear-resolved','Clear all resolved result disputes from the default admin list? Open disputes stay visible, and match and audit history will be preserved.',async function(){
        includeClearedResults=false;$('toggleClearedResults').setAttribute('aria-pressed','false');$('toggleClearedResults').textContent='Show cleared';await loadResults();
    },legacyClearResults);
}
async function legacyClearResults() {
    var response=await GG.api('/api/admin/result-verifications');
    if(!response.ok)return {ok:false,message:response.data.message||'Could not load result disputes for the compatibility clear.'};
    var records=(response.data.verifications||[]).filter(function(item){return !item.admin_cleared_at&&item.settled_at&&['completed','cancelled'].includes(item.match_status);});
    return clearByLegacyRoutes(records,function(item){return '/api/admin/result-verifications/'+encodeURIComponent(item.id)+'/clear';},'resolved result disputes');
}
async function clearResolvedComplaints() {
    await clearAdminItems($('clearResolvedComplaints'),'/api/admin/complaint-cases/clear-resolved','Clear all resolved or dismissed complaints from the admin list? Open complaints stay visible, and case history will be preserved.',async function(){
        includeClearedComplaints=false;$('toggleClearedComplaints').setAttribute('aria-pressed','false');$('toggleClearedComplaints').textContent='Show cleared';complaintPage=1;await loadComplaints();
    },legacyClearComplaints);
}
async function legacyClearComplaints() {
    var records=[],page=1,pages=1;
    while(page<=pages){
        var params=new URLSearchParams({status:'closed',page:String(page),limit:'50',q:''}),response=await GG.api('/api/admin/complaint-cases?'+params.toString());
        if(!response.ok)return {ok:false,message:response.data.message||'Could not load resolved complaints for the compatibility clear.'};
        records=records.concat((response.data.complaints||[]).filter(function(item){return !item.admin_cleared_at&&(item.status==='resolved'||item.status==='dismissed');}));
        pages=Math.max(1,Number(response.data.pages)||1);page++;
    }
    return clearByLegacyRoutes(records,function(item){return '/api/admin/complaint-cases/'+encodeURIComponent(item.id)+'/clear';},'resolved complaints');
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
async function walletAdjustment(btn) {
    var id=Number(btn.dataset.walletAdjust),row=btn.closest("[data-wallet-user]"),user=walletAdjustmentUsers.find(function(item){return Number(item.id)===id;});
    if(!user||!row)return;
    var amount=Number(row.querySelector("[data-wallet-delta]").value),reason=row.querySelector("[data-wallet-reason]").value.trim();
    if(!Number.isFinite(amount)||amount===0||Math.abs(amount)>1000000||Math.round(amount*100)!==amount*100||reason.length<10){say("Enter a non-zero amount up to KSh 1,000,000 and a reason of at least 10 characters.","error");return;}
    var action=amount>0?"add KSh "+amount:"deduct KSh "+Math.abs(amount);
    if(!confirm(action+" from "+user.username+"’s available wallet balance? Locked stakes will not change."))return;
    btn.disabled=true;
    var response=await GG.api("/api/admin/users/"+id+"/wallet-adjustment",{method:"POST",body:{amount:amount,reason:reason}});btn.disabled=false;
    if(!response.ok){say(response.data.message||"Could not adjust wallet balance.","error");return;}
    say(response.data.message||"Wallet adjusted.","ok");await loadWalletAdjustmentUsers();
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
async function deleteAnnouncement(btn) {
    var id=Number(btn.dataset.deleteAnnouncement);
    if(!confirm("Permanently delete this announcement and remove it from player announcement history?"))return;
    btn.disabled=true;
    var r=await GG.api("/api/admin/announcements/"+encodeURIComponent(id),{method:"DELETE"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not delete the announcement.","error");return;}
    say(r.data.message||"Announcement deleted.","ok");await loadAnnouncements();
}

async function clearAllAnnouncements() {
    await clearAdminItems($('clearAllAnnouncements'),'/api/admin/announcements/deactivate-all','Hide all currently active announcements from players? They will remain in the admin archive and can still be reviewed or deleted there.',async function(){
        includeInactiveAnnouncements=false;$('toggleHiddenAnnouncements').setAttribute('aria-pressed','false');$('toggleHiddenAnnouncements').textContent='Show hidden';await loadAnnouncements();
    },legacyClearAnnouncements);
}
async function legacyClearAnnouncements() {
    var response=await GG.api('/api/admin/announcements');
    if(!response.ok)return {ok:false,message:response.data.message||'Could not load announcements for the compatibility clear.'};
    var records=(response.data.announcements||[]).filter(function(item){return !!item.active;});
    return clearByLegacyRoutes(records,function(item){return '/api/admin/announcements/'+encodeURIComponent(item.id)+'/deactivate';},'active announcements hidden');
}

async function clearThreadAction(btn) {
    var id=Number(btn.dataset.threadClear), restore=btn.dataset.threadAction==="restore";
    var target=users.find(function(u){return Number(u.id)===id;}),row=btn.closest(".thread-row"),threadButton=row&&row.querySelector("[data-thread]");
    var name=target?target.username:(threadButton?threadButton.dataset.name:(selectedName||"this player"));
    if(!restore&&!confirm("Clear "+name+"’s conversation from the admin inbox? The message history stays saved, and a new player message will reopen it."))return;
    btn.disabled=true;
    var r=await GG.api("/api/admin/support/"+id+(restore?"/restore":"/clear"),{method:"POST"});
    if(!r.ok){btn.disabled=false;say(r.data.message||"Could not update the conversation.","error");return;}
    if(selectedUser===id&&!restore){selectedUser=null;selectedName="";messageSig=null;$("messages").innerHTML='<div class="empty">Choose a player to read their messages.</div>';$("convheadLabel").textContent="Select a conversation";$("clearSelectedSupport").disabled=true;$("clearSelectedSupport").dataset.threadClear="";$("reply").disabled=true;$("sendReply").disabled=true;}
    say(r.data.message||"Conversation updated.","ok");await loadThreads();
}
async function clearAllSupport() {
    await clearAdminItems($('clearAllSupport'),'/api/admin/support/clear-all','Clear all player conversations from the admin inbox? Message history is preserved, and a new player message can reopen a conversation.',async function(){
        includeCleared=false;$('toggleCleared').setAttribute('aria-pressed','false');$('toggleCleared').textContent='Show cleared';
        if(selectedUser!=null){selectedUser=null;selectedName='';messageSig=null;$('messages').innerHTML='<div class="empty">Choose a player to read their messages.</div>';$('convheadLabel').textContent='Select a conversation';$('clearSelectedSupport').disabled=true;$('clearSelectedSupport').dataset.threadClear='';$('reply').disabled=true;$('sendReply').disabled=true;}
        await loadThreads();
    },legacyClearSupport);
}
async function legacyClearSupport() {
    var response=await GG.api('/api/admin/support');
    if(!response.ok)return {ok:false,message:response.data.message||'Could not load support conversations for the compatibility clear.'};
    var records=(response.data.threads||[]).filter(function(thread){return !thread.admin_cleared_at;});
    return clearByLegacyRoutes(records,function(thread){return '/api/admin/support/'+encodeURIComponent(thread.user_id)+'/clear';},'inbox conversations');
}

$("resultFilter").addEventListener("change",function(){loadResults();});
$("toggleClearedResults").addEventListener("click",function(){includeClearedResults=!includeClearedResults;this.setAttribute("aria-pressed",String(includeClearedResults));this.textContent=includeClearedResults?"Hide cleared":"Show cleared";loadResults();});
$("clearAllResults").addEventListener("click",clearAllResults);
$("matchGameFilter").addEventListener("change",function(){updateMatchTypeOptions();loadMatchManagement();});
$("matchTypeFilter").addEventListener("change",loadMatchManagement);
$("toggleClearedMatches").addEventListener("click",function(){includeClearedMatches=!includeClearedMatches;this.setAttribute("aria-pressed",String(includeClearedMatches));this.textContent=includeClearedMatches?"Hide cleared":"Show cleared";loadMatchManagement();});
$("clearAllMatches").addEventListener("click",clearAllMatches);

$("refresh").addEventListener("click",function(){refresh(true);});
$("logout").addEventListener("click",function(){GG.logout();});
$("searchUsers").addEventListener("click",loadUsers);
$("userSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();loadUsers();}});
$("userSearch").addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(loadUsers,250);});
$("resultList").addEventListener("click",function(e){var b=e.target.closest("[data-review]");if(b){resultAction(b);return;}b=e.target.closest("[data-result-visibility]");if(b)resultVisibilityAction(b);});
$("matchManagementList").addEventListener("click",function(e){var b=e.target.closest("[data-match-cancel-refund]");if(b){cancelManagedMatch(b);return;}b=e.target.closest("[data-match-visibility]");if(b){matchVisibilityAction(b);return;}b=e.target.closest("[data-match-wallet]");if(b)focusMatchPlayerWallet(b);});
$("matchManagementList").addEventListener("submit",function(e){var chess=e.target.closest("[data-chess-result-form]");if(chess){e.preventDefault();saveManagedChessResult(chess);return;}var form=e.target.closest("[data-match-score-form]");if(!form)return;e.preventDefault();saveManagedScore(form);});
$("complaints").addEventListener("click",function(e){var open=e.target.closest("[data-open-complaint]");if(open){openComplaint(open.dataset.openComplaint);return;}var b=e.target.closest("[data-complaint-visibility]");if(b)complaintVisibilityAction(b);});
$("userList").addEventListener("click",function(e){var view=e.target.closest("[data-view-dashboard]");if(view){viewUserDashboard(view);return;}var del=e.target.closest("[data-delete-account]");if(del){deleteAccount(del);return;}var b=e.target.closest("[data-status]");if(b)statusAction(b);});
$("walletAdjustmentList").addEventListener("click",function(e){var adjust=e.target.closest("[data-wallet-adjust]");if(adjust)walletAdjustment(adjust);});
$("walletAdjustmentSearchButton").addEventListener("click",loadWalletAdjustmentUsers);
$("walletAdjustmentSearch").addEventListener("input",function(){clearTimeout(walletAdjustTimer);walletAdjustTimer=setTimeout(loadWalletAdjustmentUsers,250);});
$("walletAdjustmentSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();loadWalletAdjustmentUsers();}});
$("clearAdminWalletHistory").addEventListener("click",clearAdminWalletHistory);
$("manualWithdrawalsList").addEventListener("click",function(e){var complete=e.target.closest("[data-manual-withdrawal-complete]");if(complete){manualWithdrawalAction(complete);return;}var clear=e.target.closest("[data-manual-withdrawal-clear]");if(clear)manualWithdrawalAction(clear);});
$("competitionSelect").addEventListener("change",loadCompetitionTable);
$("competitionTable").addEventListener("submit",function(e){var form=e.target.closest("[data-competition-type]");if(!form)return;e.preventDefault();saveCompetitionEdit(form);});
$("announcementList").addEventListener("click",function(e){var b=e.target.closest("[data-deactivate-announcement]");if(b)deactivateAnnouncement(b);});
$("announcementList").addEventListener("click",function(e){var b=e.target.closest("[data-delete-announcement]");if(b)deleteAnnouncement(b);});
$("clearAllAnnouncements").addEventListener("click",clearAllAnnouncements);
$("toggleHiddenAnnouncements").addEventListener("click",function(){includeInactiveAnnouncements=!includeInactiveAnnouncements;this.setAttribute("aria-pressed",String(includeInactiveAnnouncements));this.textContent=includeInactiveAnnouncements?"Hide hidden":"Show hidden";loadAnnouncements();});
$("searchCompanion").addEventListener("click",function(){companionSearch=$("companionSearch").value.trim();companionPage=1;loadCompanionTracker();});
$("companionSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();$("searchCompanion").click();}});
$("companionFilter").addEventListener("change",function(){companionPage=1;loadCompanionTracker();});
$("companionPrev").addEventListener("click",function(){if(companionPage>1){companionPage--;loadCompanionTracker();}});
$("companionNext").addEventListener("click",function(){if(companionPage<companionPages){companionPage++;loadCompanionTracker();}});
$("companionTrackerList").addEventListener("click",function(e){var button=e.target.closest("[data-companion-member]");if(button)openCompanionMember(button.dataset.companionMember);});
$("companionDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-companion]"))this.close();});
$("announcementForm").addEventListener("submit",async function(e){e.preventDefault();var input=$("announcementMessage"),message=input.value.trim(),eventName=$("announcementEventName").value.trim(),eventValue=$("announcementEventAt").value,publishValue=$("announcementPublishAt").value;if(!message)return;if(Boolean(eventName)!==Boolean(eventValue)){say("Enter both the event name and its date and start time.","error");return;}function toIso(value){return value?new Date(value).toISOString():null;}$("sendAnnouncement").disabled=true;var r=await GG.api("/api/admin/announcements",{method:"POST",body:{message:message,eventName:eventName,eventAt:toIso(eventValue),eventTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||"Africa/Nairobi",publishAt:toIso(publishValue),audience:$("announcementAudience").value}});$("sendAnnouncement").disabled=false;if(!r.ok){say(r.data.message||"Announcement was not published.","error");return;}input.value="";$("announcementEventName").value="";$("announcementEventAt").value="";$("announcementPublishAt").value="";$("announcementAudience").value="all";say(r.data.message||"Announcement published.","ok");await loadAnnouncements();});
$("adminWalletWithdrawForm").addEventListener("submit",async function(e){e.preventDefault();var form=this,amount=Number(form.elements.amount.value),phone=form.elements.phone.value.trim();if(!Number.isSafeInteger(amount)||amount<1||amount>1000000||!phone){$("adminWalletMessage").textContent="Enter a whole KSh amount and valid M-Pesa number.";return;}var fee=Math.round(amount*0.05),payout=amount-fee;if(payout<1){$("adminWalletMessage").textContent="Withdrawal amount is too small after the 5% fee.";return;}if(!confirm("Withdraw KSh "+amount+" from your administrator wallet to "+phone+"? The 5% fee is KSh "+fee+"; estimated payout is KSh "+payout+"."))return;var button=$("adminWalletWithdrawButton");button.disabled=true;$("adminWalletMessage").textContent="Submitting withdrawal to Daraja…";var r=await GG.api("/api/admin/wallet/withdraw",{method:"POST",body:{amount:amount,phone:phone}});button.disabled=false;$("adminWalletMessage").textContent=r.data.message||(r.ok?"Withdrawal submitted.":"Withdrawal was not submitted.");$("adminWalletMessage").className="notice "+(r.ok?"ok":"error");if(r.ok){form.elements.amount.value="";await loadAdminWallet();}});
$("accountDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-account]"))this.close();});
$("complaintDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-complaint]"))this.close();});
$("complaintDialog").addEventListener("close",function(){complaintUrls.forEach(URL.revokeObjectURL);complaintUrls=[];currentComplaintId=null;});
$("complaintView").addEventListener("submit",function(e){e.preventDefault();var f=e.target.closest("[data-case-status-form]");if(f){complaintCaseStatus(f);return;}f=e.target.closest("[data-case-note-form]");if(f){complaintPrivateNote(f);return;}f=e.target.closest("[data-case-request-form]");if(f)complaintPlayerRequest(f);});
$("complaintView").addEventListener("click",function(e){var b=e.target.closest("[data-case-decision]");if(b){complaintDecision(b);return;}b=e.target.closest("[data-case-forfeit]");if(b)forfeitDisputedStakes(b);});
$("searchComplaints").addEventListener("click",function(){complaintQuery=$("complaintSearch").value.trim();complaintPage=1;loadComplaints();});
$("complaintSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();$("searchComplaints").click();}});
$("complaintsPrev").addEventListener("click",function(){if(complaintPage>1){complaintPage--;loadComplaints();}});
$("complaintsNext").addEventListener("click",function(){if(complaintPage<complaintPages){complaintPage++;loadComplaints();}});
$("toggleClearedComplaints").addEventListener("click",function(){includeClearedComplaints=!includeClearedComplaints;this.setAttribute("aria-pressed",String(includeClearedComplaints));this.textContent=includeClearedComplaints?"Hide cleared":"Show cleared";loadComplaints();});
$("clearResolvedComplaints").addEventListener("click",clearResolvedComplaints);
$("threads").addEventListener("click",function(e){var status=e.target.closest("[data-support-status]");if(status){updateSupportStatus(status);return;}var action=e.target.closest("[data-thread-clear]");if(action){clearThreadAction(action);return;}var b=e.target.closest("[data-thread]");if(!b)return;selectedUser=Number(b.dataset.thread);selectedName=b.dataset.name||"Player";messageSig=null;$("reply").disabled=false;$("sendReply").disabled=false;$("convheadLabel").textContent=selectedName+" · loading";loadThreads().then(function(){return loadMessages(true);});});
$("toggleCleared").addEventListener("click",function(){includeCleared=!includeCleared;this.setAttribute("aria-pressed",String(includeCleared));this.textContent=includeCleared?"Hide cleared":"Show cleared";loadThreads();});
$("clearAllSupport").addEventListener("click",clearAllSupport);
$("clearSelectedSupport").addEventListener("click",function(){if(selectedUser!=null)clearThreadAction(this);});
$("replyForm").addEventListener("submit",async function(e){e.preventDefault();if(selectedUser==null)return;var input=$("reply"),message=input.value.trim();if(!message)return;$("sendReply").disabled=true;$("convheadLabel").textContent="Sending…";var r=await GG.api("/api/admin/support/"+encodeURIComponent(selectedUser),{method:"POST",body:{message:message}});if(!r.ok){$("sendReply").disabled=false;$("convheadLabel").textContent=r.data.message||"Reply not sent; your text is still here.";return;}input.value="";messageSig=null;$("sendReply").disabled=false;await loadThreads();await loadMessages(true);input.focus();});

function updateAdminPage() {
    var page=String(location.hash||"#overview").slice(1),titles={overview:["Admin overview","Review results, handle player complaints, and manage the service."],results:["Result disputes","Review match screenshots, compare score reports, and clear resolved result cases."],matchManagement:["Match management","Filter Chess and eFootball matches, settle verified scores, cancel unsettled matches, and refund any locked stakes."],complaints:["Player complaints","Investigate open reports and review resolved complaints."],support:["Support inbox","Read and reply to player support messages."],accounts:["Account access","Review player accounts, suspend or close access, and inspect activity."],competitions:["Competition tables","Review live league and tournament standings and record audited corrections."],adminWallet:["Admin wallet","Adjust player balances and review administrator funds and withdrawals."],announcements:["Player announcements","Publish updates visible on player dashboards."],companionTracker:["Companion App Tracker","Review guide acknowledgement, APK downloads, registered Companion apps, recent activity, and notification permission."]};
    if(!titles[page])page="overview";
    ["results","matchManagement","complaints","support","accounts","competitions","adminWallet","announcements","companionTracker"].forEach(function(id){var panel=$(id);if(panel)panel.hidden=page!=="overview"&&page!==id;});
    $("adminStats").hidden=page!=="overview";$("pageTitle").textContent=titles[page][0];$("pageDescription").textContent=titles[page][1];
    Array.from(document.querySelectorAll("[data-admin-page]")).forEach(function(link){if(link.dataset.adminPage===page)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");});
    if(page==="companionTracker"&&adminAuthorized)loadCompanionTracker();
}
window.addEventListener("hashchange",updateAdminPage);
updateAdminPage();

async function verifyAdminAccess() {
    var r=await GG.api("/api/me");
    if(!r.ok||!r.data.user){concealDashboard("Please sign in with an administrator account.",true);return false;}
    if(r.data.user.role!=="admin"){concealDashboard("Administrator access required. This account cannot open the admin desk.",true);return false;}
    var verifiedId=Number(r.data.user.id);
    if(adminId!==null&&adminId!==verifiedId)concealDashboard("The signed-in account changed. Rechecking administrator access…",true);
    adminId=verifiedId;$("adminName").textContent=r.data.user.username||"Administrator";adminAuthorized=true;
    return true;
}
async function authorize() {
    if(authorizePending){authorizeAgain=true;return;}
    authorizePending=true;
    try {
        if(!GG.getToken()){concealDashboard("Please sign in with an administrator account.",true);return;}
        if(!await verifyAdminAccess()||document.hidden)return;
        $("app").hidden=false;$("gate").hidden=true;say("Admin-only workspace connected.");
        await refresh(true);
        if(!accessTimer)accessTimer=setInterval(async function(){
            if(document.hidden||authorizePending)return;
            if(await verifyAdminAccess())await refresh(false);
        },12000);
    } finally {
        authorizePending=false;
        if(authorizeAgain){authorizeAgain=false;if(!document.hidden)authorize();}
    }
}
document.addEventListener("visibilitychange",function(){if(document.hidden)concealDashboard("Administrator access will be rechecked when you return.",false);else authorize();});
window.addEventListener("pagehide",function(){concealDashboard("Administrator access will be rechecked when you return.",false);});
window.addEventListener("pageshow",function(event){if(event.persisted)authorize();});
authorize();
})();
