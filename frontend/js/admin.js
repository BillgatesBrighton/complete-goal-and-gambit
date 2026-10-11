(function () {
"use strict";
if (!GG.requireLogin()) return;
var $ = function (id) { return document.getElementById(id); };
var esc = GG.escapeHTML;
var adminId = null, selectedUser = null, selectedName = "", messageSig = "", urls = [], complaintUrls = [], busy = false, timer = null, users = [], includeCleared = false, includeClearedComplaints = false, complaintPage = 1, complaintPages = 1, complaintQuery = "", currentComplaintId = null, adminAuthorized = false, authorizePending = false, authorizeAgain = false, accessTimer = null;

function say(message, type) { $("notice").textContent = message || ""; $("notice").className = "notice" + (type ? " " + type : ""); }
function concealDashboard(message, clearData) {
    adminAuthorized = false;
    var app = $("app"), gate = $("gate");
    if (app) app.hidden = true;
    if (gate) { gate.textContent = message || "Checking administrator access…"; gate.hidden = false; }
    if (!clearData) return;
    if (accessTimer) { clearInterval(accessTimer); accessTimer = null; }
    ["accountDialog", "complaintDialog"].forEach(function(id) { var dialog = $(id); if (dialog && dialog.open) dialog.close(); });
    urls.concat(complaintUrls).forEach(function(url) { URL.revokeObjectURL(url); });
    urls = []; complaintUrls = []; currentComplaintId = null; selectedUser = null; selectedName = ""; messageSig = ""; users = [];
    ["resultList", "complaintList", "complaintView", "userList", "announcementList", "threads", "messages", "accountView"].forEach(function(id) {
        var node = $(id); if (node) node.replaceChildren();
    });
    if ($("adminName")) $("adminName").textContent = "Admin";
    adminId = null;
}
function date(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? d.toLocaleString() : "Time unavailable"; }
function pair(a,b) { return a == null || b == null ? "Not submitted" : String(a) + " – " + String(b); }
function namedScoreReport(firstName,firstScore,secondName,secondScore) { return firstScore==null||secondScore==null ? "Not reported" : String(firstName)+": "+String(firstScore)+" · "+String(secondName)+": "+String(secondScore); }
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
    var creatorName=c.creator_username||"Creator", opponentName=c.opponent_username||"Opponent";
    var players=creatorName+" vs "+opponentName;
    var h='<article class="card'+(a.bad?" mismatch":"")+'" data-case="'+id+'"><div class="card-top"><div><h3>'+esc(title)+'</h3><div class="meta">'+esc(players)+" · submitted by "+esc(c.selected_username||"player")+" · "+esc(date(c.submitted_at||c.created_at))+'</div></div><span class="badge '+a.kind+'">'+esc(a.text)+'</span></div>';
    h+='<div class="meta">Review: <strong>'+esc(String(c.status||"unknown").replace(/_/g," "))+'</strong> · Match: '+esc(c.match_status||"unknown")+(c.league?" · "+esc(c.league)+" league":"")+(c.tournament_id?" · Tournament #"+esc(c.tournament_id):"")+'</div>';
    var history=Array.isArray(c.reports)?c.reports:[];
    if(history.length){
        h+='<div class="reports round-history">'+history.map(function(report){var other=report.username===creatorName?opponentName:creatorName;return '<div class="report"><span>Round '+esc(report.roundNo)+' · '+esc(report.username)+' reported</span><strong>'+esc(namedScoreReport(report.username,report.scoreFor,other,report.scoreAgainst))+'</strong></div>';}).join("")+'</div>';
    } else {
        h+='<div class="reports"><div class="report"><span>'+esc(creatorName)+' reported</span><strong>'+esc(namedScoreReport(c.creator_username||"Creator",c.creator_submitted_score,c.opponent_username||"Opponent",c.creator_submitted_opponent_score))+'</strong></div><div class="report"><span>'+esc(opponentName)+' reported</span><strong>'+esc(namedScoreReport(c.opponent_username||"Opponent",c.opponent_submitted_score,c.creator_username||"Creator",c.opponent_submitted_opponent_score))+'</strong></div></div>';
    }
    h+='<div class="evidence"><div class="shotbox">'+(c.screenshot_available?'<img class="shot" data-id="'+id+'" alt="Private game screenshot loading">':'No screenshot uploaded yet')+'</div><div><strong>Text read from screenshot</strong><pre class="ocr">'+esc(c.screenshot_ocr_text||"No readable text detected.")+'</pre><div class="meta"><strong>Score candidates:</strong> '+esc(JSON.stringify(c.detected_score_candidates||[]))+'<br><strong>Image check:</strong> '+esc(c.score_check||"not available")+'</div></div></div>';
    if(status&&c.screenshot_available){
        h+='<div class="form"><label>'+esc(creatorName)+' verified goals<input class="score" data-creator type="number" min="0" max="99" step="1" inputmode="numeric"></label><label>'+esc(opponentName)+' verified goals<input class="score" data-opponent type="number" min="0" max="99" step="1" inputmode="numeric"></label><label class="wide">Optional admin note<textarea class="note" data-review-note maxlength="1000" placeholder="Note name differences, team orientation, or OCR issues (optional)."></textarea></label></div>';
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
    var reporter=esc(c.reporter_username||"Player")+" · "+esc(c.reporter_phone||"No phone on file");
    var reported=c.reported_username?esc(c.reported_username)+" · "+esc(c.reported_phone||"No phone on file"):"No other player linked";
    var scoreText=c.creator_submitted?namedScoreReport(c.creator_username||"Creator",c.creator_submitted_score,c.opponent_username||"Opponent",c.creator_submitted_opponent_score):"Not reported";
    var opponentText=c.opponent_submitted?namedScoreReport(c.opponent_username||"Opponent",c.opponent_submitted_score,c.creator_username||"Creator",c.opponent_submitted_opponent_score):"Not reported";
    var h='<article class="card complaint'+(closed?" closed":"")+'" data-complaint-id="'+id+'"><div class="card-top"><div><h3>'+esc(c.complaint_ref||("#"+id))+" · "+esc(c.subject||"Player complaint")+'</h3><div class="meta">Reporter: '+reporter+'<br>Other player: '+reported+'<br>'+esc(c.category||"support")+' · '+esc(date(c.created_at))+'</div></div><span class="badge '+(closed?"good":"wait")+'">'+esc(s.replace(/_/g," "))+'</span></div>';
    h+='<div class="meta">'+(c.match_id?'Match #'+esc(c.match_id)+' · '+esc(c.match_mode||"eFootball")+' · '+esc(c.match_status||"unknown")+(c.league_name?' · '+esc(c.league_name):"")+(c.tournament_name?' · '+esc(c.tournament_name):"")+'<br>Creator report: '+esc(scoreText)+' · opponent report: '+esc(opponentText):"Not linked to a match")+' · Evidence: '+Number(c.evidence_count||0)+(c.result_screenshot_available?" + result screenshot":"")+'</div>';
    h+='<div class="actions"><button class="btn gold" type="button" data-open-complaint="'+id+'">Open investigation</button>';
    if(closed)h+='<button class="btn '+(cleared?'':'gold')+'" type="button" data-complaint-visibility="'+(cleared?'restore':'clear')+'" data-id="'+id+'">'+(cleared?'Restore to list':'Clear from list')+'</button>';
    return h+'</div></article>';
}
async function loadComplaints() {
    var params=new URLSearchParams({status:$("complaintFilter").value,page:String(complaintPage),limit:"20",q:complaintQuery});
    if(includeClearedComplaints)params.set("includeCleared","true");
    var r=await GG.api("/api/admin/complaint-cases?"+params.toString());
    if(!r.ok){$("complaintList").innerHTML='<div class="empty">'+esc(r.data.message||"Could not load complaints.")+'</div>';return 0;}
    var list=r.data.complaints||[],counts=r.data.counts||{};
    complaintPages=Number(r.data.pages)||1;complaintPage=Number(r.data.page)||1;
    $("complaintList").innerHTML=list.length?list.map(renderComplaint).join(""):'<div class="empty">No complaints in this view.</div>';
    $("complaintsPageLabel").textContent="Page "+complaintPage+" of "+complaintPages+" · "+Number(r.data.total||0)+" cases";
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
    if(c.screenshot_ocr_text||c.score_check)h+='<div class="meta">Screenshot check: '+esc(c.score_check||"pending")+' · Selected uploader: '+esc(c.selected_username||"Unknown")+'</div><pre class="ocr">'+esc(c.screenshot_ocr_text||"No readable text detected.")+'</pre>';
    h+='<h3>Case history</h3>';
    h+=(c.events&&c.events.length)?'<div class="activity-block">'+c.events.map(function(ev){return '<div class="activity-item"><strong>'+esc(String(ev.event_type||"event").replace(/_/g," "))+'</strong> · '+esc(date(ev.created_at))+' · '+esc(ev.actor_username||ev.actor_role||"System")+(ev.from_status||ev.to_status?' · '+esc(ev.from_status||"")+' → '+esc(ev.to_status||""):"")+(ev.message?' <br>'+esc(ev.message):"")+'</div>';}).join("")+'</div>':'<p class="help">No case history is available yet.</p>';
    h+='<h3>Private administrator notes</h3>';
    h+=(c.private_notes&&c.private_notes.length)?'<div class="activity-block">'+c.private_notes.map(function(n){return '<div class="activity-item"><strong>'+esc(n.admin_username||"Administrator")+'</strong> · '+esc(date(n.created_at))+'<br>'+esc(n.note)+'</div>';}).join("")+'</div>':'<p class="help">No private notes yet.</p>';
    h+='<form data-case-note-form="'+Number(c.id)+'" class="form"><label class="wide">Add private investigation note<textarea class="note" name="note" maxlength="4000" required placeholder="Only authorized admins can read this note."></textarea></label><button class="btn gold" type="submit">Save private note</button></form>';
    if(!["resolved","dismissed"].includes(c.status)){
        h+='<h3>Contact a player</h3><form data-case-request-form="'+Number(c.id)+'" class="form"><label>Player<select name="userId" class="select" required>'+participantOptions+'</select></label><label>Request<select name="requestType" class="select"><option value="evidence">Request evidence</option><option value="clarification">Ask for clarification</option></select></label><label class="wide">Private message<textarea class="note" name="message" maxlength="2000" required placeholder="Explain what information would help resolve this case."></textarea></label><button class="btn gold" type="submit">Send private request</button><span class="help">Sent to the player’s support inbox and in-app notifications; Web Push is queued when subscribed.</span></form>';
        h+='<h3>Case status / decision</h3><form data-case-status-form="'+Number(c.id)+'" class="form"><label>Status<select name="status" class="select"><option value="open">New</option><option value="investigating">Under review</option><option value="awaiting_player">Awaiting player response</option><option value="awaiting_evidence">Awaiting evidence</option><option value="escalated">Escalated</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label><label class="wide">Resolution or dismissal reason<textarea name="reason" class="note" maxlength="2000" placeholder="Required when resolving or dismissing."></textarea></label><button class="btn gold" type="submit">Save status</button></form>';
        if(c.match_id&&["disputed","awaiting_verification"].includes(c.match_status)){
            h+='<h3>Result decision</h3><div class="warn">A correction requires actual evidence, a reason, explicit confirmation, and an unsettled match. Settled financial results are referred to reconciliation.</div><form data-case-decision-form="'+Number(c.id)+'" class="form"><label>'+esc(creatorName)+' verified goals<input class="score" name="creatorScore" type="number" min="0" max="99" step="1" value="'+(c.creator_score==null?"":Number(c.creator_score))+'"></label><label>'+esc(opponentName)+' verified goals<input class="score" name="opponentScore" type="number" min="0" max="99" step="1" value="'+(c.opponent_score==null?"":Number(c.opponent_score))+'"></label><label class="wide">Decision reason<textarea class="note" name="reason" maxlength="2000" minlength="10" required placeholder="Document the evidence and platform rule used."></textarea></label><div class="actions wide"><button class="btn" type="button" data-case-decision="uphold">Uphold recorded result</button><button class="btn red" type="button" data-case-decision="reject">Reject unsupported report</button><button class="btn gold" type="button" data-case-decision="correct">Correct result and settle</button></div></form>';
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
        return '<article class="announcement-row"><div><div class="announcement-message">'+esc(a.message)+'</div><div class="meta">'+esc(date(a.created_at))+' · '+(a.active?'Visible to players':'Hidden')+'</div></div>'+(a.active?'<button class="btn" type="button" data-deactivate-announcement="'+Number(a.id)+'">Hide</button>':'<span class="badge">Inactive</span>')+'</article>';
    }).join(""):'<div class="empty">No announcements yet.</div>';
}
async function loadOverview() {
    var r=await GG.api("/api/admin/overview"); if(!r.ok)return;
    var u=r.data.users||{}; $("statRestricted").textContent=(Number(u.suspended)||0)+(Number(u.closed)||0);
}
function editing(id) { var r=$(id),a=document.activeElement;return !!(r&&a&&r.contains(a)&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT")); }
async function refresh(force) {
    if(!adminAuthorized||busy||document.hidden)return; busy=true; $("live").textContent="Updating…";
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
    var r=await GG.api("/api/admin/complaint-cases/"+encodeURIComponent(id)+"/"+action,{method:"POST"});
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
$("complaintFilter").addEventListener("change",function(){complaintPage=1;loadComplaints();});
$("refresh").addEventListener("click",function(){refresh(true);});
$("logout").addEventListener("click",function(){GG.logout();});
$("searchUsers").addEventListener("click",loadUsers);
$("userSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();loadUsers();}});
$("userSearch").addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(loadUsers,250);});
$("resultList").addEventListener("click",function(e){var b=e.target.closest("[data-review]");if(b)resultAction(b);});
$("complaintList").addEventListener("click",function(e){var open=e.target.closest("[data-open-complaint]");if(open){openComplaint(open.dataset.openComplaint);return;}var b=e.target.closest("[data-complaint-visibility]");if(b)complaintVisibilityAction(b);});
$("userList").addEventListener("click",function(e){var view=e.target.closest("[data-view-dashboard]");if(view){viewUserDashboard(view);return;}var del=e.target.closest("[data-delete-account]");if(del){deleteAccount(del);return;}var b=e.target.closest("[data-status]");if(b)statusAction(b);});
$("announcementList").addEventListener("click",function(e){var b=e.target.closest("[data-deactivate-announcement]");if(b)deactivateAnnouncement(b);});
$("announcementForm").addEventListener("submit",async function(e){e.preventDefault();var input=$("announcementMessage"),message=input.value.trim();if(!message)return;$("sendAnnouncement").disabled=true;var r=await GG.api("/api/admin/announcements",{method:"POST",body:{message:message}});$("sendAnnouncement").disabled=false;if(!r.ok){say(r.data.message||"Announcement was not published.","error");return;}input.value="";say(r.data.message||"Announcement published.","ok");await loadAnnouncements();});
$("accountDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-account]"))this.close();});
$("complaintDialog").addEventListener("click",function(e){if(e.target===this||e.target.closest("[data-close-complaint]"))this.close();});
$("complaintDialog").addEventListener("close",function(){complaintUrls.forEach(URL.revokeObjectURL);complaintUrls=[];currentComplaintId=null;});
$("complaintView").addEventListener("submit",function(e){e.preventDefault();var f=e.target.closest("[data-case-status-form]");if(f){complaintCaseStatus(f);return;}f=e.target.closest("[data-case-note-form]");if(f){complaintPrivateNote(f);return;}f=e.target.closest("[data-case-request-form]");if(f)complaintPlayerRequest(f);});
$("complaintView").addEventListener("click",function(e){var b=e.target.closest("[data-case-decision]");if(b)complaintDecision(b);});
$("searchComplaints").addEventListener("click",function(){complaintQuery=$("complaintSearch").value.trim();complaintPage=1;loadComplaints();});
$("complaintSearch").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();$("searchComplaints").click();}});
$("complaintsPrev").addEventListener("click",function(){if(complaintPage>1){complaintPage--;loadComplaints();}});
$("complaintsNext").addEventListener("click",function(){if(complaintPage<complaintPages){complaintPage++;loadComplaints();}});
$("toggleClearedComplaints").addEventListener("click",function(){includeClearedComplaints=!includeClearedComplaints;this.setAttribute("aria-pressed",String(includeClearedComplaints));this.textContent=includeClearedComplaints?"Hide cleared":"Show cleared";loadComplaints();});
$("threads").addEventListener("click",function(e){var action=e.target.closest("[data-thread-clear]");if(action){clearThreadAction(action);return;}var b=e.target.closest("[data-thread]");if(!b)return;selectedUser=Number(b.dataset.thread);selectedName=b.dataset.name||"Player";messageSig="";$("reply").disabled=false;$("sendReply").disabled=false;$("convhead").textContent=selectedName+" · loading";loadThreads().then(function(){return loadMessages(true);});});
$("toggleCleared").addEventListener("click",function(){includeCleared=!includeCleared;this.setAttribute("aria-pressed",String(includeCleared));this.textContent=includeCleared?"Hide cleared":"Show cleared";loadThreads();});
$("replyForm").addEventListener("submit",async function(e){e.preventDefault();if(selectedUser==null)return;var input=$("reply"),message=input.value.trim();if(!message)return;$("sendReply").disabled=true;$("convhead").textContent="Sending…";var r=await GG.api("/api/admin/support/"+encodeURIComponent(selectedUser),{method:"POST",body:{message:message}});if(!r.ok){$("sendReply").disabled=false;$("convhead").textContent=r.data.message||"Reply not sent; your text is still here.";return;}input.value="";messageSig="";$("sendReply").disabled=false;await loadThreads();await loadMessages(true);input.focus();});

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
