"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const { recordJournal } = require("../services/financialLedger");
const { safeStoragePath } = require("../services/privateEvidence");
const { createAdminOnly } = require("../middleware/adminAuthorization");

const CASE_STATUSES = new Set(["open", "investigating", "awaiting_player", "awaiting_evidence", "escalated", "resolved", "dismissed"]);
const EVIDENCE_DIR = path.join(__dirname, "..", "uploads", "complaint-evidence");

module.exports = function createAdminComplaintCases(pool, authenticateToken, pushService) {
    const router = express.Router();

    const adminOnly = createAdminOnly(pool, "Complaint admin authorization failed");

    function validId(value) {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    async function audit(client, caseId, adminId, eventType, fromStatus, toStatus, message, metadata) {
        await client.query(
            `INSERT INTO complaint_case_events
                (complaint_id,actor_id,actor_role,event_type,from_status,to_status,message,metadata)
             VALUES($1,$2,'admin',$3,$4,$5,$6,$7::jsonb)`,
            [caseId, adminId, eventType, fromStatus || null, toStatus || null, message || null, JSON.stringify(metadata || {})]
        );
    }

    async function queuePush(client, userId, eventKey, matchId, title, body, page) {
        if (!pushService || typeof pushService.enqueueNotification !== "function") return;
        await client.query("SAVEPOINT complaint_push");
        try {
            await pushService.enqueueNotification(client, Number(userId), { eventKey, matchId, page, title, body });
            await client.query("RELEASE SAVEPOINT complaint_push");
        } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT complaint_push");
            await client.query("RELEASE SAVEPOINT complaint_push");
            console.error("Complaint push enqueue failed:", error.message);
        }
    }

    router.get("/", authenticateToken, adminOnly, async (req, res) => {
        const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
        const limit = Math.max(5, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        const status = String(req.query.status || "all").toLowerCase();
        const category = String(req.query.category || "all").toLowerCase().slice(0, 40);
        const query = String(req.query.q || "").trim().slice(0, 100);
        if (status !== "all" && status !== "active" && status !== "closed" && !CASE_STATUSES.has(status)) return res.status(400).json({ success: false, message: "Invalid complaint filter." });
        try {
            const params = [includeCleared];
            let where = "($1::boolean OR c.admin_cleared_at IS NULL) AND c.source <> 'efootball_result_dispute'";
            if (status === "active") {
                where += " AND c.status IN ('open','investigating','awaiting_player','awaiting_evidence','escalated')";
            } else if (status === "closed") {
                where += " AND c.status IN ('resolved','dismissed')";
            } else if (status !== "all") {
                params.push(status);
                where += ` AND c.status=$${params.length}`;
            }
            if (category !== "all") {
                params.push(category);
                where += ` AND LOWER(c.category)=$${params.length}`;
            }
            if (query) {
                params.push("%" + query.replace(/[\\%_]/g, "\\$&") + "%");
                const n = params.length;
                where += ` AND (c.complaint_ref ILIKE $${n} OR c.subject ILIKE $${n} OR reporter.username ILIKE $${n} OR reporter.phone ILIKE $${n} OR reported.username ILIKE $${n} OR reported.phone ILIKE $${n} OR m.id::text ILIKE $${n} OR m.mode ILIKE $${n} OR m.league ILIKE $${n})`;
            }
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total
                   FROM complaints c
                   JOIN users reporter ON reporter.id=c.reporter_id
                   LEFT JOIN users reported ON reported.id=c.reported_user_id
                   LEFT JOIN efootball_matches m ON m.id=c.match_id
                  WHERE ${where}`,
                params
            );
            const offset = (page - 1) * limit;
            const listParams = params.concat([limit, offset]);
            const cases = await pool.query(
                `SELECT c.id,c.complaint_ref,c.reporter_id,c.reported_user_id,c.match_id,c.category,c.subject,c.description,
                        c.status,c.priority,c.admin_id,c.admin_note,c.resolution_reason,c.created_at,c.updated_at,c.resolved_at,c.admin_cleared_at,
                        reporter.username AS reporter_username,reporter.phone AS reporter_phone,reporter.account_status AS reporter_account_status,
                        reported.username AS reported_username,reported.phone AS reported_phone,reported.account_status AS reported_account_status,
                        reviewer.username AS assigned_admin_username,
                        m.status AS match_status,m.mode AS match_mode,m.league AS league_name,m.round_name,m.tournament_id,t.name AS tournament_name,
                        m.creator_id,m.opponent_id,m.creator_score,m.opponent_score,m.winner_id,
                        m.creator_submitted,m.creator_submitted_score,m.creator_submitted_opponent_score,
                        m.opponent_submitted,m.opponent_submitted_score,m.opponent_submitted_opponent_score,
                        creator.username AS creator_username,creator.phone AS creator_phone,
                        opponent.username AS opponent_username,opponent.phone AS opponent_phone,
                        winner.username AS winner_username,
                        v.id AS verification_id,v.status AS verification_status,v.selected_player_id,
                        selected.username AS selected_username,selected.phone AS selected_phone,v.submitted_at AS screenshot_submitted_at,
                        (v.screenshot_path IS NOT NULL) AS result_screenshot_available,
                        (SELECT COUNT(*)::int FROM complaint_evidence ce WHERE ce.complaint_id=c.id) AS evidence_count
                   FROM complaints c
                   JOIN users reporter ON reporter.id=c.reporter_id
                   LEFT JOIN users reported ON reported.id=c.reported_user_id
                   LEFT JOIN users reviewer ON reviewer.id=c.admin_id
                   LEFT JOIN efootball_matches m ON m.id=c.match_id
                   LEFT JOIN efootball_tournaments t ON t.id=m.tournament_id
                   LEFT JOIN users creator ON creator.id=m.creator_id
                   LEFT JOIN users opponent ON opponent.id=m.opponent_id
                   LEFT JOIN users winner ON winner.id=m.winner_id
                   LEFT JOIN efootball_result_verifications v ON v.match_id=m.id
                   LEFT JOIN users selected ON selected.id=v.selected_player_id
                  WHERE ${where}
                  ORDER BY CASE WHEN c.status IN ('open','investigating','awaiting_player','awaiting_evidence','escalated') THEN 0 ELSE 1 END,
                           c.updated_at DESC,c.id DESC
                  LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                listParams
            );
            const counts = await pool.query(
                `SELECT status,COUNT(*)::int AS count FROM complaints
                  WHERE ($1::boolean OR admin_cleared_at IS NULL)
                    AND source <> 'efootball_result_dispute'
                  GROUP BY status`, [includeCleared]
            );
            const total = Number(countResult.rows[0].total || 0);
            return res.json({ success: true, complaints: cases.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), counts: Object.fromEntries(counts.rows.map((row) => [row.status, row.count])) });
        } catch (error) {
            console.error("Admin complaint list failed:", error.message);
            return res.status(500).json({ success: false, message: "Failed to load complaints." });
        }
    });

    router.post("/clear-resolved", authenticateToken, adminOnly, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cleared = await client.query(
                `UPDATE complaints
                    SET admin_cleared_at=NOW(),updated_at=NOW()
                  WHERE admin_cleared_at IS NULL AND status IN ('resolved','dismissed')
                    AND source <> 'efootball_result_dispute'
                 RETURNING id`
            );
            const ids = cleared.rows.map((row) => Number(row.id));
            if (ids.length) {
                await client.query(
                    `INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,message)
                     SELECT cases.id,$2,'admin','cleared','Complaint hidden from the active list.'
                       FROM unnest($1::bigint[]) AS cases(id)`,
                    [ids, req.user.userId]
                );
            }
            await client.query("COMMIT");
            return res.json({ success: true, count: ids.length, message: ids.length ? ids.length + " resolved complaint(s) cleared from the admin list." : "There are no resolved complaints to clear." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin bulk complaint clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear resolved complaints." });
        } finally {
            client.release();
        }
    });

    router.get("/:id", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid complaint reference." });
        try {
            const result = await pool.query(
                `SELECT c.*,reporter.username AS reporter_username,reporter.phone AS reporter_phone,reporter.account_status AS reporter_account_status,
                        reported.username AS reported_username,reported.phone AS reported_phone,reported.account_status AS reported_account_status,
                        reviewer.username AS assigned_admin_username,
                        m.status AS match_status,m.mode AS match_mode,m.league AS league_name,m.round_name,m.tournament_id,t.name AS tournament_name,
                        m.creator_id,m.opponent_id,m.creator_score,m.opponent_score,m.winner_id,m.created_at AS match_created_at,
                        m.started_at,m.finished_at,m.settled_at,m.stake_amount,
                        m.creator_submitted,m.creator_submitted_score,m.creator_submitted_opponent_score,
                        m.opponent_submitted,m.opponent_submitted_score,m.opponent_submitted_opponent_score,
                        creator.username AS creator_username,creator.phone AS creator_phone,creator.account_status AS creator_account_status,
                        opponent.username AS opponent_username,opponent.phone AS opponent_phone,opponent.account_status AS opponent_account_status,
                        winner.username AS winner_username,
                        v.id AS verification_id,v.selected_player_id,v.status AS verification_status,v.submitted_at AS screenshot_submitted_at,
                        v.created_at AS verification_created_at,v.screenshot_ocr_text,v.detected_score_candidates,v.score_check,v.review_note,v.reviewed_at,
                        selected.username AS selected_username,selected.phone AS selected_phone,
                        (v.screenshot_path IS NOT NULL) AS result_screenshot_available
                   FROM complaints c
                   JOIN users reporter ON reporter.id=c.reporter_id
                   LEFT JOIN users reported ON reported.id=c.reported_user_id
                   LEFT JOIN users reviewer ON reviewer.id=c.admin_id
                   LEFT JOIN efootball_matches m ON m.id=c.match_id
                   LEFT JOIN efootball_tournaments t ON t.id=m.tournament_id
                   LEFT JOIN users creator ON creator.id=m.creator_id
                   LEFT JOIN users opponent ON opponent.id=m.opponent_id
                   LEFT JOIN users winner ON winner.id=m.winner_id
                   LEFT JOIN efootball_result_verifications v ON v.match_id=m.id
                   LEFT JOIN users selected ON selected.id=v.selected_player_id
                  WHERE c.id=$1`, [id]
            );
            if (!result.rows.length) return res.status(404).json({ success: false, message: "Complaint not found." });
            const [evidence, events, notes, requests, corrections] = await Promise.all([
                pool.query(
                    `SELECT e.id,e.match_id,e.verification_id,e.request_id,e.uploader_id,e.mime_type,e.byte_size,e.purpose,e.created_at,
                            u.username AS uploader_username,u.phone AS uploader_phone,er.request_type
                       FROM complaint_evidence e JOIN users u ON u.id=e.uploader_id
                       LEFT JOIN complaint_evidence_requests er ON er.id=e.request_id
                      WHERE e.complaint_id=$1 ORDER BY e.created_at,e.id`, [id]
                ),
                pool.query(
                    `SELECT e.id,e.actor_id,e.actor_role,e.event_type,e.from_status,e.to_status,e.message,e.metadata,e.created_at,u.username AS actor_username
                       FROM complaint_case_events e LEFT JOIN users u ON u.id=e.actor_id
                      WHERE e.complaint_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 200`, [id]
                ),
                pool.query(
                    `SELECT n.id,n.admin_id,n.note,n.created_at,u.username AS admin_username
                       FROM complaint_admin_notes n LEFT JOIN users u ON u.id=n.admin_id
                      WHERE n.complaint_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 100`, [id]
                ),
                pool.query(
                    `SELECT r.id,r.target_user_id,r.request_type,r.message,r.status,r.created_at,r.fulfilled_at,u.username AS target_username,u.phone AS target_phone
                       FROM complaint_evidence_requests r JOIN users u ON u.id=r.target_user_id
                      WHERE r.complaint_id=$1 ORDER BY r.created_at DESC,r.id DESC`, [id]
                ),
                pool.query(
                    `SELECT id,admin_id,old_creator_score,old_opponent_score,old_winner_id,new_creator_score,new_opponent_score,new_winner_id,reason,created_at
                       FROM efootball_result_corrections WHERE complaint_id=$1 ORDER BY created_at DESC`, [id]
                )
            ]);
            const caseData = result.rows[0];
            caseData.evidence = evidence.rows;
            caseData.events = events.rows;
            caseData.private_notes = notes.rows;
            caseData.evidence_requests = requests.rows;
            caseData.corrections = corrections.rows;
            caseData.reported_scores = {
                creator: caseData.creator_submitted ? [caseData.creator_submitted_score, caseData.creator_submitted_opponent_score] : null,
                opponent: caseData.opponent_submitted ? [caseData.opponent_submitted_score, caseData.opponent_submitted_opponent_score] : null,
                current: caseData.creator_score == null || caseData.opponent_score == null ? null : [caseData.creator_score, caseData.opponent_score],
                winner: caseData.winner_username || null
            };
            return res.json({ success: true, complaint: caseData });
        } catch (error) {
            console.error("Admin complaint details failed:", error.message);
            return res.status(500).json({ success: false, message: "Failed to load complaint details." });
        }
    });

    router.get("/:id/evidence/:evidenceId", authenticateToken, adminOnly, async (req, res) => {
        const caseId = validId(req.params.id);
        const evidenceId = validId(req.params.evidenceId);
        if (!caseId || !evidenceId) return res.status(400).json({ success: false, message: "Invalid evidence reference." });
        try {
            const result = await pool.query("SELECT storage_key,mime_type FROM complaint_evidence WHERE complaint_id=$1 AND id=$2", [caseId, evidenceId]);
            if (!result.rows.length) return res.status(404).json({ success: false, message: "Evidence not found." });
            const file = safeStoragePath(EVIDENCE_DIR, result.rows[0].storage_key);
            if (!file || !fs.existsSync(file)) return res.status(404).json({ success: false, message: "Evidence file is missing." });
            await pool.query(
                `INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,message,metadata)
                 VALUES($1,$2,'admin','evidence_viewed','Administrator opened private evidence',$3::jsonb)`,
                [caseId, req.user.userId, JSON.stringify({ evidenceId })]
            );
            res.setHeader("Content-Type", result.rows[0].mime_type);
            res.setHeader("Content-Disposition", "inline");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "private, no-store");
            return res.sendFile(file);
        } catch (error) {
            console.error("Admin complaint evidence read failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not open evidence." });
        }
    });

    router.post("/:id/status", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        const status = String(req.body.status || "").toLowerCase();
        const reason = String(req.body.reason || "").trim().slice(0, 2000);
        const note = String(req.body.note || "").trim().slice(0, 4000);
        if (!id || !CASE_STATUSES.has(status)) return res.status(400).json({ success: false, message: "Choose a valid complaint status." });
        if (["resolved", "dismissed"].includes(status) && reason.length < 5) return res.status(400).json({ success: false, message: "Enter a documented reason before closing the complaint." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const current = await client.query("SELECT c.status,c.reporter_id,c.complaint_ref,c.match_id,m.status AS match_status FROM complaints c LEFT JOIN efootball_matches m ON m.id=c.match_id WHERE c.id=$1 FOR UPDATE OF c", [id]);
            if (!current.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Complaint not found." }); }
            const fromStatus = current.rows[0].status;
            if (["resolved", "dismissed"].includes(status) && current.rows[0].match_id && ["disputed", "awaiting_verification"].includes(current.rows[0].match_status)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Use the result decision controls to close an unresolved match dispute." });
            }
            const update = await client.query(
                `UPDATE complaints SET status=$1,admin_id=$2,admin_note=COALESCE($3,admin_note),
                     resolution_reason=CASE WHEN $1 IN ('resolved','dismissed') THEN $4 ELSE NULL END,
                     resolved_at=CASE WHEN $1 IN ('resolved','dismissed') THEN NOW() ELSE NULL END,
                     updated_at=NOW(),admin_cleared_at=CASE WHEN $1 IN ('open','investigating','awaiting_player','awaiting_evidence','escalated') THEN NULL ELSE admin_cleared_at END
                  WHERE id=$5 RETURNING complaint_ref,status,resolution_reason`,
                [status, req.user.userId, note || null, reason || null, id]
            );
            if (note) await client.query("INSERT INTO complaint_admin_notes(complaint_id,admin_id,note) VALUES($1,$2,$3)", [id, req.user.userId, note]);
            await audit(client, id, req.user.userId, "status_changed", fromStatus, status, reason || note || null, { resolutionReason: reason || null });
            const playerMessage = "Complaint " + update.rows[0].complaint_ref + " status: " + status.replace(/_/g, " ") + (reason && ["resolved", "dismissed"].includes(status) ? ". " + reason : ". Check the support page for updates.");
            await client.query("INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES($1,'complaint_status','Complaint status updated',$2,$3)", [current.rows[0].reporter_id, playerMessage, current.rows[0].match_id]);
            await queuePush(client, current.rows[0].reporter_id, "complaint:" + update.rows[0].complaint_ref + ":status:" + Date.now(), current.rows[0].match_id, "Complaint status updated", "Complaint " + update.rows[0].complaint_ref + " is " + status.replace(/_/g, " ") + ". Check GOAL$GAMBIT for details.", "match-hub");
            await client.query("COMMIT");
            return res.json({ success: true, complaint: update.rows[0] });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin complaint status update failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not update complaint status." });
        } finally { client.release(); }
    });

    router.post("/:id/notes", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        const note = String(req.body.note || "").trim().slice(0, 4000);
        if (!id || !note) return res.status(400).json({ success: false, message: "Enter an administrative note." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const exists = await client.query("SELECT status FROM complaints WHERE id=$1 FOR UPDATE", [id]);
            if (!exists.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Complaint not found." }); }
            const result = await client.query("INSERT INTO complaint_admin_notes(complaint_id,admin_id,note) VALUES($1,$2,$3) RETURNING id,admin_id,note,created_at", [id, req.user.userId, note]);
            await audit(client, id, req.user.userId, "private_note_added", exists.rows[0].status, exists.rows[0].status, "Private investigation note added.", {});
            await client.query("COMMIT");
            return res.status(201).json({ success: true, note: result.rows[0] });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin complaint note failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not save the private note." });
        } finally { client.release(); }
    });

    router.post("/:id/requests", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        const targetId = validId(req.body.userId);
        const requestType = String(req.body.requestType || "").toLowerCase();
        const message = String(req.body.message || "").trim().slice(0, 2000);
        if (!id || !targetId || !["evidence", "clarification"].includes(requestType) || !message) {
            return res.status(400).json({ success: false, message: "Choose a player and enter the request details." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const c = await client.query(
                `SELECT c.status,c.complaint_ref,c.reporter_id,c.reported_user_id,c.match_id,
                        m.creator_id,m.opponent_id,m.status AS match_status
                   FROM complaints c LEFT JOIN efootball_matches m ON m.id=c.match_id
                  WHERE c.id=$1 FOR UPDATE OF c`, [id]
            );
            if (!c.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Complaint not found." }); }
            const record = c.rows[0];
            const permitted = new Set([record.reporter_id, record.reported_user_id, record.creator_id, record.opponent_id].filter(Boolean).map(Number));
            if (!permitted.has(targetId)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The selected player is not part of this complaint." }); }
            if (["resolved", "dismissed"].includes(record.status)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Reopen the complaint before requesting a response." }); }
            const request = await client.query(
                `INSERT INTO complaint_evidence_requests(complaint_id,target_user_id,requested_by,request_type,message)
                 VALUES($1,$2,$3,$4,$5) RETURNING id`, [id, targetId, req.user.userId, requestType, message]
            );
            const threadInsert = await client.query(
                `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id) VALUES('support',$1,NULL)
                 ON CONFLICT (user_one_id) WHERE thread_type='support' AND user_two_id IS NULL DO NOTHING RETURNING id`, [targetId]
            );
            const threadId = threadInsert.rows[0] ? threadInsert.rows[0].id : (await client.query("SELECT id FROM chat_threads WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL ORDER BY id LIMIT 1", [targetId])).rows[0].id;
            const playerFacing = `Admin requested ${requestType === "evidence" ? "evidence" : "clarification"} for complaint ${record.complaint_ref}: ${message}`;
            await client.query("INSERT INTO chat_messages(thread_id,sender_id,message) VALUES($1,$2,$3)", [threadId, req.user.userId, playerFacing]);
            await client.query("UPDATE chat_threads SET admin_cleared_at=NULL WHERE id=$1", [threadId]);
            await client.query("INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES($1,$2,$3,$4,$5)", [targetId, "complaint_request", "Complaint response requested", playerFacing, record.match_id]);
            const nextStatus = requestType === "evidence" ? "awaiting_evidence" : "awaiting_player";
            await client.query("UPDATE complaints SET status=$1,admin_id=$2,updated_at=NOW(),admin_cleared_at=NULL WHERE id=$3", [nextStatus, req.user.userId, id]);
            await audit(client, id, req.user.userId, requestType === "evidence" ? "evidence_requested" : "clarification_requested", record.status, nextStatus, "A private player request was sent.", { requestId: Number(request.rows[0].id), targetUserId: targetId });
            await queuePush(client, targetId, "complaint:" + record.complaint_ref + ":request:" + request.rows[0].id, record.match_id, requestType === "evidence" ? "Evidence requested" : "Response requested", "Please check your private GOAL$GAMBIT support messages about complaint " + record.complaint_ref + ".", record.match_id ? "match-room" : "match-hub");
            await client.query("COMMIT");
            if (pushService && typeof pushService.sendPendingJobs === "function") pushService.sendPendingJobs().catch(() => {});
            return res.status(201).json({ success: true, message: "Private request sent.", requestId: Number(request.rows[0].id) });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin complaint request failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not send the private request." });
        } finally { client.release(); }
    });

    router.post("/:id/decision", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        const decision = String(req.body.decision || "").toLowerCase();
        const reason = String(req.body.reason || "").trim().slice(0, 2000);
        const creatorScore = Number(req.body.creatorScore);
        const opponentScore = Number(req.body.opponentScore);
        if (!id || !["uphold", "reject", "correct"].includes(decision) || reason.length < 10) {
            return res.status(400).json({ success: false, message: "Choose a decision and provide a reason of at least 10 characters." });
        }
        if (decision === "correct" && (req.body.confirm !== true || !Number.isInteger(creatorScore) || !Number.isInteger(opponentScore) || creatorScore < 0 || opponentScore < 0 || creatorScore > 99 || opponentScore > 99)) {
            return res.status(400).json({ success: false, message: "Confirm the correction and enter valid scores from 0 to 99." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const caseResult = await client.query("SELECT * FROM complaints WHERE id=$1 FOR UPDATE", [id]);
            if (!caseResult.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Complaint not found." }); }
            const complaint = caseResult.rows[0];
            if (complaint.status === "resolved" || complaint.status === "dismissed") { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "This complaint is already closed." }); }
            if (complaint.match_id && complaint.source === "efootball_result_dispute" && decision !== "correct") {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Settle the verified score or use the audited disputed-stake transfer before closing this match complaint." });
            }
            if (decision === "correct") {
                if (req.body.confirm !== true) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Explicit confirmation is required." }); }
                if (!complaint.match_id) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "This complaint is not linked to a match." }); }
                const matchResult = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [complaint.match_id]);
                if (!matchResult.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Match not found." }); }
                const match = matchResult.rows[0];
                if (match.status === "completed" || match.settled_at) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "This match is already settled. Refer it for the platform's financial reconciliation process before changing its result." });
                }
                if (!match.opponent_id || !["disputed", "awaiting_verification"].includes(match.status)) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "This match is not in an eligible verification state." });
                }
                const verification = await client.query("SELECT * FROM efootball_result_verifications WHERE match_id=$1 FOR UPDATE", [match.id]);
                const evidence = await client.query("SELECT 1 FROM complaint_evidence WHERE complaint_id=$1 UNION ALL SELECT 1 FROM efootball_result_verifications WHERE match_id=$2 AND screenshot_path IS NOT NULL LIMIT 1", [id, match.id]);
                if (!verification.rows.length || !evidence.rows.length) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "Result correction requires the existing screenshot verification record and actual evidence." });
                }
                const winnerId = creatorScore > opponentScore ? Number(match.creator_id) : opponentScore > creatorScore ? Number(match.opponent_id) : null;
                await client.query(
                    `INSERT INTO efootball_result_corrections
                        (match_id,complaint_id,admin_id,old_creator_score,old_opponent_score,old_winner_id,new_creator_score,new_opponent_score,new_winner_id,reason)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                    [match.id, id, req.user.userId, match.creator_score, match.opponent_score, match.winner_id, creatorScore, opponentScore, winnerId, reason]
                );
                const settlement = await settleEfootballMatch(client, match, { creatorScore, opponentScore }, req.user.userId);
                await client.query(
                    "UPDATE efootball_result_verifications SET status='verified',score_check='admin_override',reviewed_by=$1,review_note=$2,reviewed_at=NOW() WHERE match_id=$3",
                    [req.user.userId, reason, match.id]
                );
                await client.query(
                    `INSERT INTO system_notifications(user_id,type,title,message,match_id)
                     VALUES($1,'match_verified','Match result corrected',$2,$3),($4,'match_verified','Match result corrected',$5,$6)`,
                    [Number(match.creator_id), "An administrator reviewed the complaint and corrected the match result. Reason: " + reason, Number(match.id), Number(match.opponent_id), "An administrator reviewed the complaint and corrected the match result. Reason: " + reason, Number(match.id)]
                );
                for (const userId of [Number(match.creator_id), Number(match.opponent_id)]) {
                    await queuePush(client, userId, "match-correction:" + match.id + ":complaint:" + complaint.complaint_ref + ":" + userId, Number(match.id), "Match result reviewed", "An administrator reviewed the result. Check the match page for the outcome.", "match-results");
                }
                await client.query("UPDATE complaints SET status='resolved',admin_id=$1,resolution_reason=$2,resolved_at=NOW(),updated_at=NOW() WHERE id=$3", [req.user.userId, reason, id]);
                await audit(client, id, req.user.userId, "result_corrected", complaint.status, "resolved", reason, {
                    matchId: Number(match.id), oldResult: { creatorScore: match.creator_score, opponentScore: match.opponent_score, winnerId: match.winner_id },
                    submittedReports: { creator: [match.creator_submitted_score, match.creator_submitted_opponent_score], opponent: [match.opponent_submitted_score, match.opponent_submitted_opponent_score] },
                    newResult: { creatorScore, opponentScore, winnerId: settlement.winnerId }
                });
                await client.query("COMMIT");
                if (pushService && typeof pushService.sendPendingJobs === "function") pushService.sendPendingJobs().catch(() => {});
                return res.json({ success: true, message: "Result corrected and settlement completed.", settlement });
            }
            const nextStatus = decision === "uphold" ? "resolved" : "dismissed";
            await client.query("UPDATE complaints SET status=$1,admin_id=$2,resolution_reason=$3,resolved_at=NOW(),updated_at=NOW() WHERE id=$4", [nextStatus, req.user.userId, reason, id]);
            await audit(client, id, req.user.userId, decision === "uphold" ? "result_upheld" : "report_rejected", complaint.status, nextStatus, reason, {});
            await client.query("INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES($1,'complaint_status','Complaint decision recorded',$2,$3)", [complaint.reporter_id, "Complaint " + complaint.complaint_ref + " was " + (decision === "uphold" ? "resolved" : "dismissed") + ". " + reason, complaint.match_id]);
            await queuePush(client, complaint.reporter_id, "complaint:" + complaint.complaint_ref + ":decision", complaint.match_id, "Complaint decision recorded", "Complaint " + complaint.complaint_ref + " has been " + (decision === "uphold" ? "resolved" : "dismissed") + ". Check GOAL$GAMBIT for details.", "match-hub");
            await client.query("COMMIT");
            return res.json({ success: true, message: decision === "uphold" ? "Recorded result upheld." : "Unsupported report dismissed." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin complaint decision failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not save the decision." });
        } finally { client.release(); }
    });

    async function refundDisputedStakes(req, res) {
        const id = validId(req.params.id);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 2000);
        if (!id || !req.body || req.body.confirm !== true || reason.length < 10) {
            return res.status(400).json({ success: false, message: "Confirm the refund and enter a reason of at least 10 characters." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const caseResult = await client.query("SELECT * FROM complaints WHERE id=$1 FOR UPDATE", [id]);
            if (!caseResult.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Complaint not found." });
            }
            const complaint = caseResult.rows[0];
            if (["resolved", "dismissed"].includes(complaint.status)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This complaint is already closed." });
            }
            if (!complaint.match_id || complaint.source !== "efootball_result_dispute") {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Only an open eFootball result dispute can refund match stakes." });
            }

            const matchResult = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [complaint.match_id]);
            if (!matchResult.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Disputed match not found." });
            }
            const match = matchResult.rows[0];
            if (match.status !== "disputed" || match.settled_at || !match.opponent_id) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match is no longer an unsettled dispute eligible for a stake refund." });
            }
            const stake = Number(match.stake_amount || 0);
            if (!Number.isFinite(stake) || stake <= 0) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This disputed match has no locked stake to refund." });
            }
            const stakeAmount = stake.toFixed(2);
            const totalAmount = (stake * 2).toFixed(2);
            const participants = [Number(match.creator_id), Number(match.opponent_id)].sort((a, b) => a - b);
            const wallets = await client.query("SELECT user_id,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE", [participants]);
            if (wallets.rows.length !== 2 || wallets.rows.some((wallet) => Number(wallet.locked_balance || 0) < stake)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The players’ locked stakes do not match this match. Refund stopped for reconciliation." });
            }

            const refundReferences = participants.map((playerId) => "EF-DISPUTE-REFUND-" + match.id + "-" + playerId);
            const priorRefund = await client.query(
                "SELECT reference FROM transactions WHERE reference=ANY($1::text[]) LIMIT 1",
                [refundReferences]
            );
            if (priorRefund.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "A refund is already recorded for this match. No second credit was issued." });
            }
            for (const playerId of participants) {
                const refunded = await client.query(
                    "UPDATE wallets SET locked_balance=locked_balance-$1,balance=balance+$1,updated_at=NOW() WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id",
                    [stakeAmount, playerId]
                );
                if (refunded.rowCount !== 1) throw new Error("A player's locked stake changed during refund.");
                const reference = "EF-DISPUTE-REFUND-" + match.id + "-" + playerId;
                await client.query(
                    "INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description) VALUES($1,'match_refund',$2,'KES','completed',$3,$4)",
                    [playerId, stakeAmount, reference, "eFootball dispute resolved; locked stake returned to player · " + complaint.complaint_ref]
                );
            }
            await recordJournal(client, {
                reference: "EF-DISPUTE-REFUND-JOURNAL-" + match.id,
                transactionType: "efootball_dispute_stake_refund",
                amount: Number(totalAmount),
                description: "Administrator resolved a disputed eFootball match by returning both locked stakes",
                context: { matchId: Number(match.id), complaintId: Number(id), participants },
                postings: participants.flatMap((playerId) => [
                    { accountType: "efootball_match_locked", accountId: playerId, debit: Number(stakeAmount) },
                    { accountType: "user_wallet_available", accountId: playerId, credit: Number(stakeAmount) }
                ])
            });
            await client.query(
                "UPDATE efootball_matches SET status='cancelled',result_status='admin_refunded',settled_at=NOW(),finished_at=COALESCE(finished_at,NOW()),winner_id=NULL,submitted_by=$1 WHERE id=$2",
                [req.user.userId, match.id]
            );
            await client.query(
                "UPDATE efootball_result_verifications SET status='admin_refunded',score_check='admin_refunded',reviewed_by=$1,review_note=$2,reviewed_at=NOW() WHERE match_id=$3",
                [req.user.userId, reason, match.id]
            );
            await client.query(
                "UPDATE complaints SET status='resolved',admin_id=$1,resolution_reason=$2,resolved_at=NOW(),updated_at=NOW() WHERE id=$3",
                [req.user.userId, reason, id]
            );
            await audit(client, id, req.user.userId, "stakes_refunded_to_players", complaint.status, "resolved", reason, {
                matchId: Number(match.id), refundedPlayers: participants, stakePerPlayer: stakeAmount, totalRefunded: totalAmount, references: refundReferences
            });
            const notice = "The administrator resolved disputed match " + match.id + " and returned your locked stake (KSh " + stakeAmount + ") to your wallet. Reason: " + reason;
            for (const playerId of participants) {
                await client.query("INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES($1,'match_dispute_resolved','Dispute Resolved', $2,$3)", [playerId, notice, match.id]);
                await queuePush(client, playerId, "match-refunded:" + match.id + ":" + playerId, Number(match.id), "Dispute Resolved · Stake Returned", "The administrator returned your match stake. Check your wallet for details.", "match-hub");
            }
            await client.query("COMMIT");
            if (pushService && typeof pushService.sendPendingJobs === "function") pushService.sendPendingJobs().catch(() => {});
            return res.json({ success: true, message: "The complaint was resolved and both players’ locked stakes were returned to their wallets.", amount: Number(totalAmount), refundedPlayers: participants.length });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin disputed stake refund failed:", error.message);
            return res.status(500).json({ success: false, message: error.message === "A player's locked stake changed during refund." ? "A player's locked stake changed. No refund was issued; refresh and reconcile the match." : "Could not refund the disputed stakes." });
        } finally {
            client.release();
        }
    }

    router.post("/:id/refund-stakes", authenticateToken, adminOnly, refundDisputedStakes);
    // Older open admin pages use the former path. It now invokes the safe
    // refund flow too, so a stale client can never transfer players' stakes.
    router.post("/:id/forfeit-stakes", authenticateToken, adminOnly, refundDisputedStakes);

    router.post("/:id/clear", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid complaint." });
        try {
            const result = await pool.query("UPDATE complaints SET admin_cleared_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('resolved','dismissed') RETURNING id", [id]);
            if (!result.rows.length) return res.status(409).json({ success: false, message: "Resolve or dismiss the complaint before clearing it." });
            await pool.query("INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,message) VALUES($1,$2,'admin','cleared','Complaint hidden from the active list.')", [id, req.user.userId]);
            return res.json({ success: true });
        } catch (error) {
            console.error("Admin complaint clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear complaint." });
        }
    });

    router.post("/:id/restore", authenticateToken, adminOnly, async (req, res) => {
        const id = validId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid complaint." });
        try {
            const result = await pool.query("UPDATE complaints SET admin_cleared_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING id,status", [id]);
            if (!result.rows.length) return res.status(404).json({ success: false, message: "Complaint not found." });
            await pool.query("INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,message) VALUES($1,$2,'admin','restored','Complaint restored to the admin list.')", [id, req.user.userId]);
            return res.json({ success: true, status: result.rows[0].status });
        } catch (error) {
            console.error("Admin complaint restore failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not restore complaint." });
        }
    });

    return router;
};
