"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const { recordJournal } = require("../services/financialLedger");
const { enqueueAnnouncementToAudience } = require("../services/adminAnnouncementReminders");
const financialRateLimit = require("../middleware/financialRateLimit");
const { createAdminOnly } = require("../middleware/adminAuthorization");
const { acquireAccountInvalidationLocks, lockAndRevokeUserSessions } = require("../services/authSession");
const { readPrivateImage } = require("../services/privateEvidence");
const { encryptMessage, decryptMessage, decryptMessageRows } = require("../services/chatEncryption");
const { buildJsonExport, buildPdfExport, sha256 } = require("../services/chatEvidenceExport");

function encryptedMessageValues(message) {
    const record=encryptMessage(message);
    return [record.message,record.message_ciphertext,record.message_iv,record.message_auth_tag,record.encryption_key_id];
}
const companionGuideVersion = require("./companion").GUIDE_VERSION;
const companionTermsVersion = require("./companion").TERMS_VERSION;

module.exports = function(pool, authenticateToken, getOnlineUserIds, pushService, efootballScheduler, accountPresence) {
    const router = express.Router();
    const walletAdjustmentLimit = financialRateLimit("admin-wallet-adjustment", { windowMs: 10 * 60 * 1000, max: 30 });
    async function getOrCreateSupportThread(userId, queryable) {
        const db = queryable || pool;
        const created = await db.query(
            `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id)
             VALUES('support',$1,NULL)
             ON CONFLICT (user_one_id)
             WHERE thread_type='support' AND user_two_id IS NULL
             DO NOTHING
             RETURNING id`,
            [userId]
        );
        if (created.rows.length) return created.rows[0].id;

        const existing = await db.query(
            `SELECT id FROM chat_threads
             WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
             ORDER BY id ASC LIMIT 1`,
            [userId]
        );
        if (!existing.rows.length) throw new Error("Unable to create support conversation.");
        return existing.rows[0].id;
    }

    const adminOnly = createAdminOnly(pool, "Admin authorization error");

    router.get("/efootball-scheduler", authenticateToken, adminOnly, async function(req, res) {
        if (!efootballScheduler || typeof efootballScheduler.snapshot !== "function") {
            return res.status(503).json({ success: false, message: "eFootball scheduler status is unavailable." });
        }
        try {
            const snapshot = await efootballScheduler.snapshot();
            return res.json({ success: true, schedule: snapshot });
        } catch (error) {
            console.error("Admin eFootball scheduler status failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load the eFootball scheduler status." });
        }
    });

    // The dashboard HTML lives outside the public frontend directory and is
    // returned only after the authenticated account's current database role is checked.
    router.get("/dashboard-page", authenticateToken, adminOnly, (req, res) => {
        res.sendFile(path.join(__dirname, "..", "private-pages", "admin-dashboard.html"), (error) => {
            if (error && !res.headersSent) {
                console.error("Private admin dashboard page could not be served:", error.message);
                res.status(500).json({ success: false, message: "Could not load the administrator dashboard." });
            }
        });
    });

    router.get("/result-review-page", authenticateToken, adminOnly, (req, res) => {
        res.sendFile(path.join(__dirname, "..", "private-pages", "admin-verifications.html"), (error) => {
            if (error && !res.headersSent) {
                console.error("Private admin result-review page could not be served:", error.message);
                res.status(500).json({ success: false, message: "Could not load administrator result reviews." });
            }
        });
    });

    router.get("/daraja-check-page", authenticateToken, adminOnly, (req, res) => {
        res.sendFile(path.join(__dirname, "..", "private-pages", "admin-daraja-check.html"), (error) => {
            if (error && !res.headersSent) {
                console.error("Private Daraja diagnostics page could not be served:", error.message);
                res.status(500).json({ success: false, message: "Could not load Daraja diagnostics." });
            }
        });
    });

    router.get("/finance/summary", authenticateToken, adminOnly, async (req, res) => {
        const period = String(req.query.period || "daily").toLowerCase();
        const periods = { daily:"day", weekly:"week", monthly:"month", yearly:"year" };
        if (!periods[period]) return res.status(400).json({ success:false, message:"Choose daily, weekly, monthly, or yearly." });
        const timeZone = String(process.env.BUSINESS_TIME_ZONE || "Africa/Nairobi");
        try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date()); }
        catch (_) { return res.status(500).json({ success:false, message:"The configured business timezone is invalid." }); }
        const bucket = period === "daily" ? "hour" : period === "yearly" ? "month" : "day";
        try {
            const [summary, series, available] = await Promise.all([
                pool.query(
                    `WITH bounds AS (
                         SELECT date_trunc($1,NOW() AT TIME ZONE $2) AS local_start,
                                date_trunc($1,NOW() AT TIME ZONE $2) +
                                  CASE $1 WHEN 'day' THEN INTERVAL '1 day' WHEN 'week' THEN INTERVAL '1 week'
                                          WHEN 'month' THEN INTERVAL '1 month' ELSE INTERVAL '1 year' END AS local_end
                     ), flow AS (
                         SELECT t.transaction_type,t.amount,
                                COALESCE(SUM(e.debit) FILTER (WHERE e.account_type ILIKE '%expense%'),0) AS expense_debit,
                                COALESCE(SUM(e.credit) FILTER (WHERE e.account_type ILIKE '%expense%'),0) AS expense_credit,
                                COALESCE(SUM(e.credit) FILTER (WHERE e.account_type IN ('external_mpesa_payout','external_competition_payout')),0) AS payouts
                           FROM financial_ledger_transactions t
                           JOIN bounds b ON t.posted_at >= (b.local_start AT TIME ZONE $2) AND t.posted_at < (b.local_end AT TIME ZONE $2)
                           LEFT JOIN financial_ledger_entries e ON e.transaction_id=t.id
                          WHERE t.posted_at IS NOT NULL GROUP BY t.id,t.transaction_type,t.amount
                     )
                     SELECT
                       COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('verified_mpesa_deposit','verified_mpesa_stk_deposit','development_deposit')),0)::numeric(14,2) AS deposits,
                       COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('competition_prize_paid','chess_competition_prize_pool_settlement')),0)::numeric(14,2) AS prizes_paid,
                       COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('player_withdrawal_paid','admin_mpesa_payout')),0)::numeric(14,2) AS withdrawals,
                       COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('league_entry_refund','tournament_entry_refund','chess_tournament_search_refund','match_refund')),0)::numeric(14,2) AS refunds,
                       COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('player_withdrawal_fee','league_forfeit_stake','tournament_forfeit_stake','chess_tournament_forfeit_stake','efootball_competition_retained_revenue','chess_competition_retained_revenue')),0)::numeric(14,2) AS retained_revenue,
                       COALESCE(SUM(expense_debit-expense_credit),0)::numeric(14,2) AS actual_expenses,
                       COALESCE(SUM(payouts),0)::numeric(14,2) AS provider_payouts,
                       COUNT(*)::int AS journal_count
                     FROM flow`, [periods[period], timeZone]
                ),
                pool.query(
                    `WITH bounds AS (
                         SELECT date_trunc($1,NOW() AT TIME ZONE $2) AS local_start,
                                date_trunc($1,NOW() AT TIME ZONE $2) +
                                  CASE $1 WHEN 'day' THEN INTERVAL '1 day' WHEN 'week' THEN INTERVAL '1 week'
                                          WHEN 'month' THEN INTERVAL '1 month' ELSE INTERVAL '1 year' END AS local_end
                     )
                     SELECT date_trunc($3,t.posted_at AT TIME ZONE $2) AS bucket_local,
                            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('verified_mpesa_deposit','verified_mpesa_stk_deposit','development_deposit')),0)::numeric(14,2) AS deposits,
                            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('competition_prize_paid','chess_competition_prize_pool_settlement')),0)::numeric(14,2) AS prizes_paid,
                            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('player_withdrawal_paid','admin_mpesa_payout')),0)::numeric(14,2) AS withdrawals,
                            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('league_entry_refund','tournament_entry_refund','chess_tournament_search_refund','match_refund')),0)::numeric(14,2) AS refunds
                       FROM financial_ledger_transactions t CROSS JOIN bounds b
                      WHERE t.posted_at >= (b.local_start AT TIME ZONE $2) AND t.posted_at < (b.local_end AT TIME ZONE $2)
                      GROUP BY bucket_local ORDER BY bucket_local`, [periods[period], timeZone, bucket]
                ),
                pool.query(`SELECT COALESCE(SUM(balance-reserved_balance),0)::numeric(14,2) AS available,
                                   COALESCE(SUM(reserved_balance),0)::numeric(14,2) AS reserved
                              FROM admin_wallets`)
            ]);
            const row = summary.rows[0] || {};
            const total = available.rows[0] || {};
            return res.json({ success:true, period, timeZone, currency:"KES", summary:row,
                series:series.rows, platformFunds:{ available:Number(total.available||0), reserved:Number(total.reserved||0) } });
        } catch (error) {
            console.error("Admin finance analytics read failed:", error.message);
            return res.status(500).json({ success:false, message:"Could not load the financial analytics." });
        }
    });

    const verificationDirectory = path.join(__dirname, "..", "uploads", "match-verification");

    router.get("/result-verifications", authenticateToken, adminOnly, async (req, res) => {
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        try {
            const result = await pool.query(
                `SELECT v.id,v.match_id,v.selected_player_id,v.status,v.submitted_at,v.created_at,
                        v.admin_cleared_at,v.admin_cleared_by,
                        v.screenshot_ocr_text,v.detected_score_candidates,v.score_check,v.review_note,v.reviewed_at,
                        (v.screenshot_path IS NOT NULL OR COALESCE(evidence.evidence,'[]'::jsonb)<>'[]'::jsonb) AS screenshot_available,
                        m.status AS match_status,m.settled_at,m.mode,m.league,m.tournament_id,
                        m.creator_id,m.opponent_id,COALESCE(m.code_sender_id,m.creator_id) AS player_a_id,
                        CASE WHEN COALESCE(m.code_sender_id,m.creator_id)=m.creator_id THEN m.opponent_id ELSE m.creator_id END AS player_b_id,
                        m.creator_submitted_score,m.creator_submitted_opponent_score,
                        m.opponent_submitted_score,m.opponent_submitted_opponent_score,
                        creator.username AS creator_username,creator.phone AS creator_phone,
                        opponent.username AS opponent_username,opponent.phone AS opponent_phone,
                        player_a.username AS player_a_username,player_a.phone AS player_a_phone,
                        player_b.username AS player_b_username,player_b.phone AS player_b_phone,
                        selected.username AS selected_username,
                        COALESCE(report_history.reports,'[]'::jsonb) AS reports,
                        COALESCE(evidence.evidence,'[]'::jsonb) AS evidence,
                        COALESCE(event_history.events,'[]'::jsonb) AS event_history
                 FROM efootball_result_verifications v
                 JOIN efootball_matches m ON m.id=v.match_id
                 JOIN users creator ON creator.id=m.creator_id
                 LEFT JOIN users opponent ON opponent.id=m.opponent_id
                 JOIN users selected ON selected.id=v.selected_player_id
                 JOIN users player_a ON player_a.id=COALESCE(m.code_sender_id,m.creator_id)
                 LEFT JOIN users player_b ON player_b.id=CASE WHEN COALESCE(m.code_sender_id,m.creator_id)=m.creator_id THEN m.opponent_id ELSE m.creator_id END
                 LEFT JOIN LATERAL (
                     SELECT jsonb_agg(jsonb_build_object(
                         'roundNo',r.round_no,'username',u.username,
                         'scoreFor',r.score_for,'scoreAgainst',r.score_against,
                         'submittedAt',r.submitted_at
                     ) ORDER BY r.round_no,r.submitted_at,u.username) AS reports
                     FROM efootball_result_reports r
                     JOIN users u ON u.id=r.user_id
                     WHERE r.match_id=m.id
                 ) report_history ON TRUE
                 LEFT JOIN LATERAL (
                     SELECT jsonb_agg(jsonb_build_object(
                         'id',e.id,'uploaderId',e.uploader_id,'username',u.username,'phone',u.phone,
                         'storageKey',e.storage_key,'mimeType',e.mime_type,'byteSize',e.byte_size,'createdAt',e.created_at
                     ) ORDER BY e.created_at,e.id) AS evidence
                       FROM efootball_result_evidence e JOIN users u ON u.id=e.uploader_id
                      WHERE e.verification_id=v.id
                 ) evidence ON TRUE
                 LEFT JOIN LATERAL (
                     SELECT jsonb_agg(jsonb_build_object(
                         'type',a.event_type,'fromStatus',a.from_status,'toStatus',a.to_status,
                         'reason',a.reason,'note',a.note,'createdAt',a.created_at,'adminId',a.admin_id
                     ) ORDER BY a.created_at,a.id) AS events
                       FROM efootball_result_admin_events a WHERE a.verification_id=v.id
                 ) event_history ON TRUE
                 WHERE ($1::boolean OR v.admin_cleared_at IS NULL)
                 ORDER BY CASE WHEN v.status IN ('pending_screenshot','submitted','review_required') THEN 0 ELSE 1 END,
                          v.created_at DESC
                 LIMIT 200`, [includeCleared]
            );
            return res.json({ success: true, verifications: result.rows });
        } catch (error) {
            console.error("Admin result-verification list error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load result reviews." });
        }
    });

    router.post("/result-verifications/clear-resolved", authenticateToken, adminOnly, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cleared = await client.query(
                `UPDATE efootball_result_verifications v
                    SET admin_cleared_at=NOW(),admin_cleared_by=$1
                   FROM efootball_matches m
                  WHERE m.id=v.match_id AND v.admin_cleared_at IS NULL
                    AND m.settled_at IS NOT NULL AND m.status IN ('completed','cancelled')
                 RETURNING v.id`,
                [req.user.userId]
            );
            const ids = cleared.rows.map((row) => Number(row.id));
            if (ids.length) {
                await client.query(
                    `INSERT INTO efootball_result_admin_events(verification_id,admin_id,event_type)
                     SELECT verifications.id,$2,'cleared'
                       FROM unnest($1::bigint[]) AS verifications(id)`,
                    [ids, req.user.userId]
                );
            }
            await client.query("COMMIT");
            return res.json({ success: true, count: ids.length, message: ids.length ? ids.length + " resolved result dispute(s) cleared from the list." : "There are no resolved result disputes to clear." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin bulk result dispute clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear resolved result disputes." });
        } finally {
            client.release();
        }
    });

    async function setResultVisibility(req, res, clear) {
        const verificationId = Number(req.params.id);
        if (!Number.isSafeInteger(verificationId) || verificationId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid result dispute." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const locked = await client.query(
                `SELECT v.id,v.admin_cleared_at,m.status AS match_status,m.settled_at
                   FROM efootball_result_verifications v
                   JOIN efootball_matches m ON m.id=v.match_id
                  WHERE v.id=$1 FOR UPDATE OF v,m`,
                [verificationId]
            );
            if (!locked.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Result dispute not found." });
            }
            const record = locked.rows[0];
            if (clear && (!record.settled_at || !["completed", "cancelled"].includes(record.match_status))) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Resolve or cancel the match before clearing its result dispute." });
            }
            await client.query(
                "UPDATE efootball_result_verifications SET admin_cleared_at=$1,admin_cleared_by=$2 WHERE id=$3",
                [clear ? new Date() : null, req.user.userId, verificationId]
            );
            await client.query(
                "INSERT INTO efootball_result_admin_events(verification_id,admin_id,event_type) VALUES($1,$2,$3)",
                [verificationId, req.user.userId, clear ? "cleared" : "restored"]
            );
            await client.query("COMMIT");
            return res.json({ success: true, cleared: clear, message: clear ? "Resolved result dispute cleared from the list." : "Result dispute restored to the list." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin result dispute visibility update failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not update the result dispute list." });
        } finally {
            client.release();
        }
    }

    router.post("/result-verifications/:id/clear", authenticateToken, adminOnly, (req, res) => setResultVisibility(req, res, true));
    router.post("/result-verifications/:id/restore", authenticateToken, adminOnly, (req, res) => setResultVisibility(req, res, false));

    router.get("/result-verifications/:id/screenshot", authenticateToken, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(
                "SELECT screenshot_path FROM efootball_result_verifications WHERE id=$1",
                [req.params.id]
            );
            const name = result.rows[0] && result.rows[0].screenshot_path;
            if (!name || !/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(name)) {
                return res.status(404).json({ success: false, message: "Screenshot not found." });
            }
            const filePath = path.join(verificationDirectory, path.basename(name));
            if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: "Screenshot file is missing." });
            res.setHeader("Cache-Control", "private, no-store");
            const image=await readPrivateImage(filePath);
            res.setHeader("Content-Length",image.length);
            return res.end(image);
        } catch (error) {
            console.error("Admin screenshot read error:", error.message);
            return res.status(500).json({ success: false, message: "Could not open screenshot." });
        }
    });

    router.get("/result-verifications/:id/evidence/:evidenceId", authenticateToken, adminOnly, async (req, res) => {
        const verificationId = Number(req.params.id), evidenceId = Number(req.params.evidenceId);
        if (!Number.isSafeInteger(verificationId) || verificationId < 1 || !Number.isSafeInteger(evidenceId) || evidenceId < 1) {
            return res.status(400).json({ success:false, message:"Invalid evidence reference." });
        }
        try {
            const result = await pool.query(
                `SELECT e.storage_key,e.mime_type FROM efootball_result_evidence e
                  WHERE e.verification_id=$1 AND e.id=$2`, [verificationId,evidenceId]
            );
            const name = result.rows[0] && result.rows[0].storage_key;
            if (!name || !/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(name)) return res.status(404).json({ success:false, message:"Evidence not found." });
            const filePath = path.join(verificationDirectory,path.basename(name));
            if (!fs.existsSync(filePath)) return res.status(404).json({ success:false, message:"Evidence file is missing." });
            res.setHeader("Content-Type",result.rows[0].mime_type);
            res.setHeader("Content-Disposition","inline");
            res.setHeader("X-Content-Type-Options","nosniff");
            res.setHeader("Cache-Control","private, no-store");
            const image=await readPrivateImage(filePath);
            res.setHeader("Content-Length",image.length);
            return res.end(image);
        } catch (error) {
            console.error("Admin result evidence read failed:",error.message);
            return res.status(500).json({ success:false, message:"Could not open evidence." });
        }
    });

    router.post("/result-verifications/:id/review", authenticateToken, adminOnly, async (req, res) => {
        const verificationId = Number(req.params.id);
        const decision = String(req.body && req.body.decision || "").toLowerCase();
        const note = String(req.body && req.body.note || "").trim().slice(0, 1000);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        const creatorScore = Number(req.body && req.body.creatorScore);
        const opponentScore = Number(req.body && req.body.opponentScore);
        if (!Number.isSafeInteger(verificationId) || verificationId <= 0 || !["resolve", "reject"].includes(decision)) {
            return res.status(400).json({ success: false, message: "Choose a valid review decision." });
        }
        if (decision === "resolve" && (!Number.isInteger(creatorScore) || !Number.isInteger(opponentScore) || creatorScore < 0 || opponentScore < 0 || creatorScore > 99 || opponentScore > 99)) {
            return res.status(400).json({ success: false, message: "Enter both verified scores from 0 to 99." });
        }
        if (decision === "reject" && reason.length < 5) {
            return res.status(400).json({ success:false, message:"A rejection reason of at least 5 characters is required. Funds will remain locked while the case is investigated." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const locked = await client.query(
                `SELECT v.id AS verification_id,v.status AS verification_status,v.screenshot_path,
                        m.id AS match_id,m.status AS match_status,m.creator_id,m.opponent_id,
                        m.stake_amount,m.mode,m.league,m.tournament_id
                 FROM efootball_result_verifications v
                 JOIN efootball_matches m ON m.id=v.match_id
                 WHERE v.id=$1
                 FOR UPDATE OF v,m`,
                [verificationId]
            );
            if (!locked.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Review record not found." });
            }
            const record = locked.rows[0];
            if (!record.screenshot_path) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "A screenshot is required before the dispute can be resolved." });
            }
            if (record.match_status === "completed") {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This result has already been settled." });
            }

            if (decision === "resolve") {
                const fullMatch = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [record.match_id]);
                const settlement = await settleEfootballMatch(client, fullMatch.rows[0], {
                    creatorScore: creatorScore,
                    opponentScore: opponentScore
                }, Number(req.user.userId));
                await client.query(
                    "UPDATE efootball_result_verifications SET status='verified',score_check='admin_override',reviewed_by=$1,review_note=$2,reviewed_at=NOW() WHERE id=$3",
                    [req.user.userId, note || "Resolved from screenshot by admin.", verificationId]
                );
                await client.query(
                    `INSERT INTO efootball_result_admin_events(verification_id,admin_id,event_type,from_status,to_status,note)
                     VALUES($1,$2,'resolved',$3,'verified',$4)`,
                    [verificationId,req.user.userId,record.verification_status,note||"Verified score recorded and settled."]
                );
                const message = "An admin reviewed the screenshot and resolved the match result. The result and standings are updated.";
                await client.query(
                    "INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES ($1,'match_verified','Admin Resolved Result',$2,$3),($4,'match_verified','Admin Resolved Result',$5,$6)",
                    [Number(record.creator_id), message, Number(record.match_id), Number(record.opponent_id), message, Number(record.match_id)]
                );
                await client.query("COMMIT");
                return res.json({ success: true, settlement: settlement, message: "Result resolved and settled." });
            }

            await client.query(
                "UPDATE efootball_result_verifications SET status='investigating',score_check='rejected_pending_investigation',reviewed_by=$1,review_note=$2,reviewed_at=NOW() WHERE id=$3",
                [req.user.userId,reason,verificationId]
            );
            await client.query("UPDATE efootball_matches SET status='disputed',result_status='disputed' WHERE id=$1", [record.match_id]);
            const existingCase=await client.query("SELECT id,status FROM complaints WHERE match_id=$1 AND source='efootball_result_dispute' ORDER BY id DESC LIMIT 1 FOR UPDATE",[record.match_id]);
            let complaintId=existingCase.rows[0]&&existingCase.rows[0].id;
            if(complaintId){
                await client.query("UPDATE complaints SET status='investigating',updated_at=NOW(),admin_id=$2 WHERE id=$1",[complaintId,req.user.userId]);
                await client.query("INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,from_status,to_status,message,metadata) VALUES($1,$2,'admin','result_evidence_rejected',$3,'investigating',$4,$5::jsonb)",[complaintId,req.user.userId,existingCase.rows[0].status,reason,JSON.stringify({verificationId})]);
            }
            await client.query(
                `INSERT INTO efootball_result_admin_events(verification_id,admin_id,event_type,from_status,to_status,reason,metadata)
                 VALUES($1,$2,'rejected',$3,'investigating',$4,$5::jsonb)`,
                [verificationId,req.user.userId,record.verification_status,reason,JSON.stringify({complaintId:complaintId||null,financialDisposition:"unchanged_locked"})]
            );
            await client.query("COMMIT");
            return res.json({ success: true, complaintId:complaintId||null, message: "Evidence was rejected and the case is marked for investigation. Match funds remain locked; no refund or forfeiture was applied." });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("Admin result review error:", error.message);
            return res.status(500).json({ success: false, message: "Could not save the result decision." });
        } finally {
            client.release();
        }
    });

    router.post("/result-verifications/:id/notes", authenticateToken, adminOnly, async (req,res) => {
        const verificationId=Number(req.params.id),note=String(req.body&&req.body.note||"").trim().slice(0,1000);
        if(!Number.isSafeInteger(verificationId)||verificationId<=0||note.length<5)return res.status(400).json({success:false,message:"Enter an investigation note of at least 5 characters."});
        try{
            const current=await pool.query("SELECT status FROM efootball_result_verifications WHERE id=$1",[verificationId]);
            if(!current.rows.length)return res.status(404).json({success:false,message:"Result review not found."});
            await pool.query("INSERT INTO efootball_result_admin_events(verification_id,admin_id,event_type,from_status,to_status,note) VALUES($1,$2,'investigation_note',$3,$3,$4)",[verificationId,req.user.userId,current.rows[0].status,note]);
            return res.json({success:true,message:"Investigation note recorded."});
        }catch(error){console.error("Admin result investigation note failed:",error.message);return res.status(500).json({success:false,message:"Could not record the investigation note."});}
    });

    // =========================================================
    // EXISTING ADMIN OVERVIEW
    // =========================================================
    router.get("/overview", authenticateToken, adminOnly, async (req, res) => {
        try {
            const [users, complaints, openChats, announcements, passwordRecovery] = await Promise.all([
                pool.query(`SELECT COUNT(*)::int AS total,
                                   COUNT(*) FILTER (WHERE account_status='active')::int AS active,
                                   COUNT(*) FILTER (WHERE account_status='suspended')::int AS suspended,
                                   COUNT(*) FILTER (WHERE account_status='closed')::int AS closed
                            FROM users`),
                pool.query(`SELECT COUNT(*)::int AS open FROM complaints WHERE status='open'`),
                pool.query(`SELECT COUNT(DISTINCT thread_id)::int AS open
                            FROM chat_messages cm
                            JOIN chat_threads ct ON ct.id=cm.thread_id
                            WHERE ct.thread_type='support'
                              AND cm.read_at IS NULL
                              AND cm.sender_id <> $1`, [req.user.userId]),
                pool.query(`SELECT COUNT(*)::int AS total
                            FROM admin_announcements
                            WHERE active=TRUE`),
                pool.query(`SELECT COUNT(*)::int AS pending
                            FROM password_recovery_requests
                            WHERE status='pending' AND expires_at>NOW()`)
            ]);
            res.json({
                success:true,
                users:users.rows[0],
                complaints:complaints.rows[0],
                openChats:openChats.rows[0],
                announcements:announcements.rows[0],
                passwordRecovery:passwordRecovery.rows[0]
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load admin overview."});
        }
    });

    router.get("/password-recovery", authenticateToken, adminOnly, async function(req, res) {
        const status = String(req.query.status || "pending").trim().toLowerCase();
        if (!['pending', 'all'].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid recovery request filter." });
        }
        try {
            const result = await pool.query(
                `SELECT r.id,r.requested_username,r.submitted_phone,r.status,r.created_at,r.expires_at,
                        r.approval_expires_at,r.reviewed_at,r.review_note,r.completed_at,
                        u.id AS account_id,u.username AS account_username,u.phone AS registered_phone,
                        u.account_status,
                        (u.id IS NOT NULL AND u.account_status='active') AS matched_active_account
                   FROM password_recovery_requests r
                   LEFT JOIN users u ON u.id=r.user_id
                  WHERE ($1='all' OR (r.status='pending' AND r.expires_at>NOW()))
                  ORDER BY r.created_at DESC LIMIT 100`,
                [status]
            );
            return res.json({ success: true, requests: result.rows });
        } catch (error) {
            console.error("Admin password recovery queue failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load password recovery requests." });
        }
    });

    router.post("/password-recovery/:id/review", authenticateToken, adminOnly, async function(req, res) {
        const id = String(req.params.id || "").trim();
        const decision = String(req.body && req.body.decision || "").trim().toLowerCase();
        const note = String(req.body && req.body.note || "").trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
            !["approve", "deny"].includes(decision) || note.length < 10 || note.length > 500) {
            return res.status(400).json({ success: false, message: "Choose approve or deny and enter a 10–500 character internal verification note." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const locked = await client.query(
                `SELECT id,user_id,status,expires_at
                   FROM password_recovery_requests WHERE id=$1 FOR UPDATE`,
                [id]
            );
            if (!locked.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Recovery request not found." });
            }
            const request = locked.rows[0];
            if (request.status !== "pending") {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This recovery request has already been reviewed." });
            }
            if (new Date(request.expires_at) <= new Date()) {
                await client.query("UPDATE password_recovery_requests SET status='expired' WHERE id=$1", [id]);
                await client.query("COMMIT");
                return res.status(409).json({ success: false, message: "This recovery request has expired." });
            }

            if (decision === "approve") {
                if (!request.user_id || Number(request.user_id) === Number(req.user.userId)) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "This request cannot be approved by this administrator. An active matching account and a second administrator are required." });
                }
                const account = await client.query(
                    "SELECT id,auth_version FROM users WHERE id=$1 AND account_status='active' FOR UPDATE",
                    [request.user_id]
                );
                if (!account.rows.length) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "The matching account is no longer active." });
                }
                await client.query(
                    `UPDATE password_recovery_requests
                        SET status='approved',approval_expires_at=NOW()+INTERVAL '30 minutes',auth_version_at_approval=$1,
                            reviewed_by=$2,reviewed_at=NOW(),review_note=$3
                      WHERE id=$4`,
                    [account.rows[0].auth_version, req.user.userId, note, id]
                );
            } else {
                await client.query(
                    `UPDATE password_recovery_requests
                        SET status='denied',reviewed_by=$1,reviewed_at=NOW(),review_note=$2
                      WHERE id=$3`,
                    [req.user.userId, note, id]
                );
            }

            await client.query("COMMIT");
            return res.json({ success: true, message: decision === "approve"
                ? "Identity review recorded. The claimant’s private recovery link is available for 30 minutes."
                : "Recovery request denied." });
        } catch (error) {
            await client.query("ROLLBACK").catch(function() {});
            console.error("Admin password recovery review failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not save the recovery decision." });
        } finally {
            client.release();
        }
    });

    // =========================================================
    // USER MANAGEMENT (EXISTING)
    // =========================================================
    router.get("/users", authenticateToken, adminOnly, async (req, res) => {
        try {
            const q = String(req.query.search || "").trim().toLowerCase().slice(0, 80);
            const status = ["active", "suspended", "closed"].includes(String(req.query.status || "all")) ? String(req.query.status) : "all";
            const game = ["chess", "konami", "both"].includes(String(req.query.game || "all")) ? String(req.query.game) : "all";
            const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
            const pageSize = Math.max(1, Math.min(60, Number.parseInt(req.query.limit, 10) || 40));
            const filters = [q, status, game];
            const count = await pool.query(
                `SELECT COUNT(*)::int AS total FROM users u
                 WHERE ($1='' OR LOWER(u.username) LIKE '%'||$1||'%' OR u.phone LIKE '%'||$1||'%')
                   AND ($2='all' OR u.account_status=$2) AND ($3='all' OR u.game=$3)`, filters
            );
            const r = await pool.query(
                `SELECT u.id,u.username,u.game,u.rating,u.account_status,u.created_at,
                        COALESCE(cs.completed,0)::int AS chess_completed,
                        COALESCE(es.completed,0)::int AS efootball_completed,
                        GREATEST(cs.last_played,es.last_played) AS last_game_at
                   FROM users u
                   LEFT JOIN LATERAL (
                       SELECT COUNT(*)::int AS completed,MAX(finished_at) AS last_played
                         FROM chess_matches WHERE (player_white_id=u.id OR player_black_id=u.id) AND status='completed'
                   ) cs ON TRUE
                   LEFT JOIN LATERAL (
                       SELECT COUNT(*)::int AS completed,MAX(COALESCE(finished_at,created_at)) AS last_played
                         FROM efootball_matches WHERE (creator_id=u.id OR opponent_id=u.id) AND status='completed'
                   ) es ON TRUE
                  WHERE ($1='' OR LOWER(u.username) LIKE '%'||$1||'%' OR u.phone LIKE '%'||$1||'%')
                    AND ($2='all' OR u.account_status=$2) AND ($3='all' OR u.game=$3)
                  ORDER BY u.created_at DESC,u.id DESC LIMIT $4 OFFSET $5`,
                filters.concat([pageSize, (page - 1) * pageSize])
            );
            res.json({
                success:true, page, pageSize, total:Number(count.rows[0] && count.rows[0].total || 0),
                users:r.rows.map(function(user) {
                    const presence = accountPresence && typeof accountPresence.getAdminPresence === "function"
                        ? accountPresence.getAdminPresence(user.id) : "unavailable";
                    return Object.assign({}, user, { presence:presence });
                })
            });
        } catch (e) {
            console.error("Admin player directory could not be loaded:", e.message);
            res.status(500).json({success:false,message:"Failed to load users."});
        }
    });

    // Finance-only lookup keeps phone search and authoritative spendable
    // amounts out of the player directory response.
    router.get("/users/wallet-lookup", authenticateToken, adminOnly, async (req, res) => {
        const q = String(req.query.search || "").trim().toLowerCase().slice(0, 80);
        if (!q) return res.json({ success:true, users:[] });
        try {
            const result = await pool.query(
                `SELECT u.id,u.username,u.game,
                        COALESCE(w.balance-w.withdrawal_reserved_balance,0)::numeric(12,2) AS balance,
                        COALESCE(w.locked_balance,0)::numeric(12,2) AS locked_balance
                   FROM users u LEFT JOIN wallets w ON w.user_id=u.id
                  WHERE u.account_status='active'
                    AND (LOWER(u.username) LIKE '%'||$1||'%' OR u.phone LIKE '%'||$1||'%')
                  ORDER BY u.username,u.id LIMIT 30`, [q]
            );
            return res.json({ success:true, users:result.rows });
        } catch (error) {
            console.error("Admin wallet player lookup failed:", error.message);
            return res.status(500).json({ success:false, message:"Could not find player accounts." });
        }
    });

    // Adjust only available balance; locked match/competition stakes are never
    // touched. The wallet, user transaction, and detailed audit are atomic.
    router.post("/users/:id/wallet-adjustment", authenticateToken, adminOnly, walletAdjustmentLimit, async (req, res) => {
        const userId = Number(req.params.id);
        const amount = Number(req.body && req.body.amount);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(amount) || amount === 0 ||
            Math.abs(amount) > 1000000 || Math.round(amount * 100) !== amount * 100 || reason.length < 10) {
            return res.status(400).json({success:false,message:"Enter a non-zero adjustment up to KSh 1,000,000 and a reason of at least 10 characters."});
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const target = await client.query("SELECT id,username FROM users WHERE id=$1 FOR UPDATE", [userId]);
            if (!target.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"Account not found."});
            }
            await client.query("INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
            const wallet = await client.query("SELECT balance,locked_balance,withdrawal_reserved_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [userId]);
            const previous = Number(wallet.rows[0].balance);
            const updated = await client.query(
                `UPDATE wallets SET balance=balance+$1,updated_at=NOW()
                  WHERE user_id=$2 AND balance-withdrawal_reserved_balance+$1 >= 0
                  RETURNING balance,locked_balance`,
                [amount, userId]
            );
            if (!updated.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"The debit exceeds the account’s available wallet balance."});
            }
            const reference = `ADMIN-WALLET-${crypto.randomUUID()}`;
            await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,$2,$3,'KES','completed',$4,$5)`,
                [userId, amount > 0 ? "admin_adjustment_credit" : "admin_adjustment_debit", Math.abs(amount), reference, "Admin adjustment: " + reason]
            );
            await client.query(
                `INSERT INTO admin_wallet_adjustments
                    (admin_id,user_id,username,amount,previous_balance,new_balance,reason,reference)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                [req.user.userId, userId, target.rows[0].username, amount, previous, updated.rows[0].balance, reason, reference]
            );
            await recordJournal(client, {
                reference: `ADMIN-ADJUST-JOURNAL-${reference}`,
                transactionType: amount > 0 ? "admin_adjustment_credit" : "admin_adjustment_debit",
                amount: Math.abs(amount),
                description: "Audited administrator wallet adjustment: " + reason,
                context: { adminId: Number(req.user.userId), userId, adjustmentReference: reference },
                postings: amount > 0
                    ? [
                        { accountType: "admin_adjustment_expense", accountId: Number(req.user.userId), debit: amount },
                        { accountType: "user_wallet_available", accountId: userId, credit: amount }
                    ]
                    : [
                        { accountType: "user_wallet_available", accountId: userId, debit: Math.abs(amount) },
                        { accountType: "admin_adjustment_recovery", accountId: Number(req.user.userId), credit: Math.abs(amount) }
                    ]
            });
            await client.query("COMMIT");
            return res.json({success:true,message:"Available wallet balance adjusted. Locked stakes were left unchanged.",wallet:updated.rows[0]});
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin wallet adjustment failed:", error.message);
            return res.status(500).json({success:false,message:"Could not safely adjust this wallet."});
        } finally {
            client.release();
        }
    });

    function competitionTables(type) {
        if (type === "league") return {table:"efootball_league_members", parent:"efootball_leagues", parentKey:"league_id", name:"name", stake:"entry_stake"};
        if (type === "tournament") return {table:"efootball_tournament_members", parent:"efootball_tournaments", parentKey:"tournament_id", name:"name", stake:"entry_fee"};
        return null;
    }

    router.get("/competitions", authenticateToken, adminOnly, async (req, res) => {
        try {
            const [leagues, tournaments] = await Promise.all([
                pool.query(`SELECT 'league' AS type,l.id,l.name,l.status,l.entry_stake AS entry_fee,
                                   COUNT(m.user_id)::int AS players
                              FROM efootball_leagues l LEFT JOIN efootball_league_members m ON m.league_id=l.id
                             GROUP BY l.id ORDER BY l.id`),
                pool.query(`SELECT 'tournament' AS type,t.id,t.name,t.status,t.entry_fee,
                                   COUNT(m.user_id)::int AS players
                              FROM efootball_tournaments t LEFT JOIN efootball_tournament_members m ON m.tournament_id=t.id
                             GROUP BY t.id ORDER BY t.id`)
            ]);
            return res.json({success:true,competitions:leagues.rows.concat(tournaments.rows)});
        } catch (error) {
            console.error("Admin competition list error:", error.message);
            return res.status(500).json({success:false,message:"Could not load competition tables."});
        }
    });

    router.get("/competitions/:type/:id", authenticateToken, adminOnly, async (req, res) => {
        const config = competitionTables(String(req.params.type));
        const id = Number(req.params.id);
        if (!config || !Number.isSafeInteger(id) || id <= 0) return res.status(400).json({success:false,message:"Invalid competition."});
        try {
            const [competition, standings] = await Promise.all([
                pool.query(`SELECT id,${config.name} AS name,status,${config.stake} AS entry_fee,season_rounds,completed_at FROM ${config.parent} WHERE id=$1`, [id]),
                pool.query(
                    `SELECT m.user_id,u.username,m.played,m.wins,m.draws,m.losses,m.points,
                            m.goal_difference,m.goals_for,m.goals_against,m.fee_paid,m.forfeited_at
                       FROM ${config.table} m JOIN users u ON u.id=m.user_id
                      WHERE m.${config.parentKey}=$1
                      ORDER BY m.points DESC,m.wins DESC,m.goal_difference DESC,m.goals_for DESC,u.username ASC`,
                    [id]
                )
            ]);
            if (!competition.rows.length) return res.status(404).json({success:false,message:"Competition not found."});
            return res.json({success:true,competition:competition.rows[0],standings:standings.rows});
        } catch (error) {
            console.error("Admin competition table error:", error.message);
            return res.status(500).json({success:false,message:"Could not load this competition table."});
        }
    });

    router.post("/competitions/:type/:id/standings/:userId", authenticateToken, adminOnly, async (req, res) => {
        const type = String(req.params.type);
        const config = competitionTables(type);
        const id = Number(req.params.id);
        const userId = Number(req.params.userId);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        const numbers = ["wins","draws","losses","goalsFor","goalsAgainst"].map((key) => Number(req.body && req.body[key]));
        if (!config || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
            numbers.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10000) || reason.length < 10) {
            return res.status(400).json({success:false,message:"Provide valid non-negative match and goal totals, plus a reason of at least 10 characters."});
        }
        const [wins,draws,losses,goalsFor,goalsAgainst] = numbers;
        const played = wins + draws + losses;
        if (played > 10000) return res.status(400).json({success:false,message:"The played total is too large."});
        const stats = {played,wins,draws,losses,points:wins*3+draws,goal_difference:goalsFor-goalsAgainst,goals_for:goalsFor,goals_against:goalsAgainst};
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const locked = await client.query(
                `SELECT m.user_id,u.username,m.played,m.wins,m.draws,m.losses,m.points,m.goal_difference,m.goals_for,m.goals_against
                   FROM ${config.table} m JOIN ${config.parent} c ON c.id=m.${config.parentKey}
                   JOIN users u ON u.id=m.user_id
                  WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE OF m,c`,
                [id,userId]
            );
            if (!locked.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"This player is not listed in that competition."});
            }
            const old = locked.rows[0];
            await client.query(
                `UPDATE ${config.table}
                    SET played=$1,wins=$2,draws=$3,losses=$4,points=$5,goal_difference=$6,goals_for=$7,goals_against=$8
                  WHERE ${config.parentKey}=$9 AND user_id=$10`,
                [stats.played,stats.wins,stats.draws,stats.losses,stats.points,stats.goal_difference,stats.goals_for,stats.goals_against,id,userId]
            );
            await client.query(
                `INSERT INTO admin_competition_adjustments
                    (admin_id,competition_type,competition_id,user_id,username,previous_stats,new_stats,reason)
                 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
                [req.user.userId,type,id,userId,old.username,JSON.stringify(old),JSON.stringify(stats),reason]
            );
            await client.query("COMMIT");
            return res.json({success:true,message:"Competition table updated and adjustment recorded.",stats});
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin standings adjustment error:", error.message);
            return res.status(500).json({success:false,message:"Could not safely update this table."});
        } finally {
            client.release();
        }
    });

    // A read-only account dashboard for support and moderation. It does not
    // impersonate the player or expose password/session material.
    router.get("/users/:id/dashboard", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({success:false,message:"Invalid account."});
        }
        try {
            const [profile, transactions, walletActivity, chess, efootball] = await Promise.all([
                pool.query(
                    `SELECT u.id,u.username,u.phone,u.game,u.rating,u.role,u.account_status,u.created_at,
                            COALESCE(w.balance-w.withdrawal_reserved_balance,0)::numeric(12,2) AS available_balance,
                            COALESCE(w.locked_balance,0)::numeric(12,2) AS locked_balance,
                            COALESCE(w.withdrawal_reserved_balance,0)::numeric(12,2) AS withdrawal_reserved_balance
                     FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.id=$1`, [id]),
                pool.query(
                    `SELECT transaction_type,amount,currency,status,reference,description,created_at
                     FROM transactions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [id]),
                pool.query(
                    `SELECT transaction_type,COALESCE(SUM(amount),0)::numeric(14,2) AS amount
                       FROM transactions WHERE user_id=$1 AND status='completed'
                      GROUP BY transaction_type ORDER BY transaction_type`, [id]),
                pool.query(
                    `SELECT COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                            COUNT(*) FILTER (WHERE winner_id=$1 AND status='completed')::int AS wins,
                            COUNT(*) FILTER (WHERE result='draw' AND status='completed')::int AS draws,
                            COUNT(*) FILTER (WHERE status IN ('active','playing','in_progress'))::int AS in_progress,
                            COUNT(*) FILTER (WHERE status IN ('abandoned','cancelled','forfeited'))::int AS abandoned_or_cancelled,
                            COUNT(*) FILTER (WHERE status='disputed')::int AS disputed
                     FROM chess_matches WHERE player_white_id=$1 OR player_black_id=$1`, [id]),
                pool.query(
                    `SELECT COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                            COUNT(*) FILTER (WHERE status IN ('scheduled','waiting','playing','awaiting_verification'))::int AS in_progress,
                            COUNT(*) FILTER (WHERE status='disputed')::int AS disputed,
                            COUNT(*) FILTER (WHERE status IN ('cancelled','abandoned','forfeited'))::int AS cancelled_or_forfeited
                     FROM efootball_matches WHERE creator_id=$1 OR opponent_id=$1`, [id])
            ]);
            if (!profile.rows.length) return res.status(404).json({success:false,message:"User not found."});
            const [chessRecent, efootballRecent] = await Promise.all([
                pool.query(
                    `SELECT id,match_type,time_control,stake_amount,result,winner_id,status,finished_at
                     FROM chess_matches WHERE player_white_id=$1 OR player_black_id=$1
                     ORDER BY COALESCE(finished_at,created_at) DESC,id DESC LIMIT 8`, [id]),
                pool.query(
                    `SELECT id,mode,league,round_name,stake_amount,status,creator_score,opponent_score,created_at,finished_at
                     FROM efootball_matches WHERE creator_id=$1 OR opponent_id=$1
                     ORDER BY COALESCE(finished_at,created_at) DESC,id DESC LIMIT 12`, [id])
            ]);
            const activityTotals = Object.fromEntries(walletActivity.rows.map((row) => [row.transaction_type, Number(row.amount || 0)]));
            res.json({success:true,dashboard:{user:profile.rows[0],transactions:transactions.rows,
                walletActivity:{
                    deposits:(activityTotals.deposit||0)+(activityTotals.development_deposit||0),
                    prizes:activityTotals.competition_prize||0,
                    withdrawals:(activityTotals.withdrawal||0)+(activityTotals.withdrawal_fee||0),
                    refunds:(activityTotals.match_refund||0)+(activityTotals.league_entry_refund||0)+(activityTotals.tournament_entry_refund||0),
                    totalsByType:activityTotals
                },
                chess:{stats:chess.rows[0],recent:chessRecent.rows},
                efootball:{stats:efootball.rows[0],recent:efootballRecent.rows},
                usageDuration:{available:false,reason:"The current sign-in/session records do not measure active use duration."}}});
        } catch (e) {
            console.error("Admin user dashboard error:", e.message);
            res.status(500).json({success:false,message:"Failed to load the account dashboard."});
        }
    });

    async function readSupportHistory(playerId) {
        const [player,threads]=await Promise.all([
            pool.query("SELECT id,username FROM users WHERE id=$1",[playerId]),
            pool.query(`SELECT id,created_at,support_category,support_subject,support_status
                          FROM chat_threads WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
                         ORDER BY id`,[playerId])
        ]);
        if(!player.rows.length)return null;
        return {player:player.rows[0],threads:threads.rows};
    }

    function decodeChatCursor(value) {
        if(!value)return null;
        if(typeof value!=="string"||value.length>300)throw new Error("Invalid message cursor.");
        let cursor;
        try{cursor=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));}catch(_){throw new Error("Invalid message cursor.");}
        const id=Number(cursor&&cursor.id),createdAt=new Date(cursor&&cursor.createdAt);
        if(!Number.isSafeInteger(id)||id<=0||Number.isNaN(createdAt.getTime()))throw new Error("Invalid message cursor.");
        return {id,createdAt};
    }

    async function recordChatHistoryAudit(adminId,playerId,threads,action,format,hash) {
        const client=await pool.connect();
        try{
            await client.query("BEGIN");
            const ids=(threads||[]).map((thread)=>Number(thread.id));
            if(!ids.length)ids.push(null);
            for(const threadId of ids){
                await client.query(
                    `INSERT INTO admin_chat_history_audit_events(admin_id,player_user_id,thread_id,action,export_format,evidence_sha256)
                     VALUES($1,$2,$3,$4,$5,$6)`,[adminId,playerId,threadId,action,format,hash]
                );
            }
            await client.query("COMMIT");
        }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
        finally{client.release();}
    }

    router.get("/users/:id/chat-history",authenticateToken,adminOnly,async(req,res)=>{
        const playerId=Number(req.params.id),limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50));
        if(!Number.isSafeInteger(playerId)||playerId<=0)return res.status(400).json({success:false,message:"Invalid player account."});
        let cursor;
        try{cursor=decodeChatCursor(req.query.before||"");}catch(_){return res.status(400).json({success:false,message:"Invalid message cursor."});}
        try{
            const history=await readSupportHistory(playerId);
            if(!history)return res.status(404).json({success:false,message:"Player account not found."});
            const threadIds=history.threads.map((thread)=>Number(thread.id));
            let rows=[],total=0,hasOlder=false;
            if(threadIds.length){
                const count=await pool.query("SELECT COUNT(*)::int AS total FROM chat_messages WHERE thread_id=ANY($1::bigint[])",[threadIds]);
                total=Number(count.rows[0]&&count.rows[0].total||0);
                const result=await pool.query(
                    `SELECT m.id,m.thread_id,m.sender_id,m.message,m.message_ciphertext,m.message_iv,m.message_auth_tag,
                            m.encryption_key_id,m.created_at,m.read_at,m.client_message_id,u.username
                       FROM chat_messages m JOIN users u ON u.id=m.sender_id
                      WHERE m.thread_id=ANY($1::bigint[])
                        AND ($2::timestamptz IS NULL OR m.created_at<$2 OR (m.created_at=$2 AND m.id<$3))
                      ORDER BY m.created_at DESC,m.id DESC LIMIT $4`,
                    [threadIds,cursor?cursor.createdAt:null,cursor?cursor.id:null,limit]
                );
                rows=result.rows;
                if(rows.length){
                    const oldest=rows[rows.length-1];
                    const more=await pool.query(
                        `SELECT EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=ANY($1::bigint[])
                           AND (m.created_at<$2 OR (m.created_at=$2 AND m.id<$3))) AS has_older`,
                        [threadIds,oldest.created_at,oldest.id]
                    );
                    hasOlder=Boolean(more.rows[0]&&more.rows[0].has_older);
                }
            }
            await recordChatHistoryAudit(Number(req.user.userId),playerId,history.threads,"view",null,null);
            const messages=decryptMessageRows(rows).reverse().map((row)=>Object.assign({},row,{attachments:[]}));
            const oldest=rows.length?rows[rows.length-1]:null;
            const nextBeforeId=oldest?Buffer.from(JSON.stringify({id:Number(oldest.id),createdAt:oldest.created_at}),"utf8").toString("base64url"):null;
            res.set("Cache-Control","private, no-store");
            return res.json({success:true,player:history.player,threadId:history.threads[0]?Number(history.threads[0].id):null,
                threadIds,threads:history.threads,messages,total,hasOlder,nextBeforeId});
        }catch(error){
            if(error.code==="CHAT_ENCRYPTION_KEY_UNAVAILABLE"||error.code==="CHAT_ENCRYPTION_INTEGRITY_FAILED")return res.status(503).json({success:false,message:"Support history is temporarily unavailable because a stored message could not be securely decrypted."});
            console.error("Admin support history read failed:",error.message);
            return res.status(500).json({success:false,message:"Could not load support history."});
        }
    });

    router.get("/users/:id/chat-history/export",authenticateToken,adminOnly,async(req,res)=>{
        const playerId=Number(req.params.id),format=String(req.query.format||"json").toLowerCase();
        if(!Number.isSafeInteger(playerId)||playerId<=0)return res.status(400).json({success:false,message:"Invalid player account."});
        if(!["json","pdf"].includes(format))return res.status(400).json({success:false,message:"Choose JSON or PDF for the evidence export."});
        try{
            const history=await readSupportHistory(playerId);
            if(!history)return res.status(404).json({success:false,message:"Player account not found."});
            const threadIds=history.threads.map((thread)=>Number(thread.id));
            let messages=[];
            if(threadIds.length){
                const result=await pool.query(
                    `SELECT m.id,m.thread_id,m.sender_id,m.message,m.message_ciphertext,m.message_iv,m.message_auth_tag,
                            m.encryption_key_id,m.created_at,m.read_at,m.client_message_id,u.username
                       FROM chat_messages m JOIN users u ON u.id=m.sender_id
                      WHERE m.thread_id=ANY($1::bigint[]) ORDER BY m.created_at,m.id`,[threadIds]
                );
                messages=decryptMessageRows(result.rows).map((row)=>Object.assign({},row,{attachments:[]}));
            }
            const archive={player:history.player,threads:history.threads,messages,admin:{id:Number(req.user.userId),username:req.user.username||"Administrator"}};
            const output=format==="pdf"?await buildPdfExport(archive):buildJsonExport(archive);
            const digest=sha256(output);
            await recordChatHistoryAudit(Number(req.user.userId),playerId,history.threads,"export",format,digest);
            res.set("Cache-Control","private, no-store");
            res.set("X-Content-Type-Options","nosniff");
            res.set("X-Evidence-SHA256",digest);
            res.set("Content-Type",format==="pdf"?"application/pdf":"application/json; charset=utf-8");
            res.set("Content-Disposition",`attachment; filename="goal-gambit-support-${playerId}-${new Date().toISOString().slice(0,10)}.${format}"`);
            return res.end(output);
        }catch(error){
            if(error.code==="CHAT_ENCRYPTION_KEY_UNAVAILABLE"||error.code==="CHAT_ENCRYPTION_INTEGRITY_FAILED")return res.status(503).json({success:false,message:"Support history is temporarily unavailable because a stored message could not be securely decrypted."});
            console.error("Admin support history export failed:",error.message);
            return res.status(500).json({success:false,message:"Could not create the protected evidence export."});
        }
    });

    // Permanently remove a player and their account-linked records. Refuse
    // while funds, withdrawals, or an active match still need settlement.
    router.delete("/users/:id", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({success:false,message:"Invalid account."});
        }
        if (id === Number(req.user.userId)) {
            return res.status(400).json({success:false,message:"You cannot delete your own administrator account."});
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await acquireAccountInvalidationLocks(client, id);
            const target = await client.query("SELECT id,username,role FROM users WHERE id=$1 FOR UPDATE", [id]);
            if (!target.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"User not found."});
            }
            if (target.rows[0].role === "admin") {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"Administrator accounts cannot be permanently deleted from this desk."});
            }
            const unsettledChess = await client.query(
                `SELECT 1
                   FROM chess_match_financial_dispositions d
                   JOIN chess_matches m ON m.id=d.match_id
                  WHERE d.user_id=$1 AND m.match_type='tournament'
                    AND m.payout_status='pending_competition'
                    AND d.disposition IN ('pending','admin_forfeited')
                  LIMIT 1`,
                [id]
            );
            if (unsettledChess.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"This account has an unsettled Chess tournament financial disposition. Settle the season before deleting the account."});
            }
            const wallet = await client.query("SELECT balance,locked_balance,withdrawal_reserved_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [id]);
            if (wallet.rows.length && (Number(wallet.rows[0].balance) !== 0 || Number(wallet.rows[0].locked_balance) !== 0 || Number(wallet.rows[0].withdrawal_reserved_balance || 0) !== 0)) {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"Settle or withdraw the remaining wallet funds before deleting this account."});
            }
            const pending = await client.query("SELECT 1 FROM mpesa_payouts WHERE user_id=$1 AND status='pending' LIMIT 1", [id]);
            if (pending.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"This account has a pending M-Pesa withdrawal. Resolve it before deletion."});
            }
            const activeChess = await client.query("SELECT 1 FROM chess_matches WHERE status IN ('waiting','active') AND (player_white_id=$1 OR player_black_id=$1) LIMIT 1", [id]);
            const activeEfootball = await client.query("SELECT 1 FROM efootball_matches WHERE status IN ('waiting','active','started','in_progress') AND (creator_id=$1 OR opponent_id=$1) LIMIT 1", [id]);
            if (activeChess.rows.length || activeEfootball.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"Finish or cancel the account's active match before deletion."});
            }

            // The target's account gates are held before row locks. Revoke its
            // tracked sessions only after deletion checks pass so a refused
            // deletion does not unexpectedly sign the player out.
            await lockAndRevokeUserSessions(client, id);

            // Remove personal identifiers from shared match and receipt rows
            // that remain useful to other players or for payment reconciliation.
            await client.query(
                `UPDATE chess_matches SET
                    player_white_id=CASE WHEN player_white_id=$1 THEN NULL ELSE player_white_id END,
                    player_black_id=CASE WHEN player_black_id=$1 THEN NULL ELSE player_black_id END,
                    winner_id=CASE WHEN winner_id=$1 THEN NULL ELSE winner_id END,
                    draw_offer_user_id=CASE WHEN draw_offer_user_id=$1 THEN NULL ELSE draw_offer_user_id END
                 WHERE player_white_id=$1 OR player_black_id=$1 OR winner_id=$1 OR draw_offer_user_id=$1`, [id]);
            await client.query(
                `UPDATE efootball_matches SET
                    code_sender_id=CASE WHEN code_sender_id=$1 THEN NULL ELSE code_sender_id END,
                    submitted_by=CASE WHEN submitted_by=$1 THEN NULL ELSE submitted_by END,
                    winner_id=CASE WHEN winner_id=$1 THEN NULL ELSE winner_id END
                 WHERE code_sender_id=$1 OR submitted_by=$1 OR winner_id=$1`, [id]);
            await client.query("UPDATE efootball_result_verifications SET reviewed_by=NULL WHERE reviewed_by=$1", [id]);
            await client.query("UPDATE mpesa_c2b_payments SET user_id=NULL,account_reference='DELETED' WHERE user_id=$1", [id]);
            await client.query("DELETE FROM users WHERE id=$1", [id]);
            await client.query("COMMIT");
            res.json({success:true,message:"Account and linked personal data permanently deleted."});
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin permanent account deletion error:", e.message);
            res.status(500).json({success:false,message:"The account could not be deleted. Resolve linked records and try again."});
        } finally {
            client.release();
        }
    });

    router.post("/users/:id/status", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        const status = String(req.body.status || "").toLowerCase();
        const reason = String(req.body.reason || "").trim().slice(0,1000);
        const until = req.body.suspendedUntil ? new Date(req.body.suspendedUntil) : null;

        if (!Number.isInteger(id) || id <= 0 || !["active","suspended","closed"].includes(status)) {
            return res.status(400).json({success:false,message:"Invalid account action."});
        }
        if (id === Number(req.user.userId) && status !== "active") {
            return res.status(400).json({success:false,message:"You cannot suspend or close your own admin account."});
        }

        const client = await pool.connect();
        let r;
        try {
            await client.query("BEGIN");
            // Account invalidation takes both account gates before any row
            // locks, matching password change/recovery/logout ordering. This
            // waits for admitted work before the moderation result returns.
            await acquireAccountInvalidationLocks(client, id);
            const target = await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]);
            if (!target.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"User not found."});
            }
            await lockAndRevokeUserSessions(client, id);
            r = await client.query(
                `UPDATE users
                 SET account_status=$1::varchar,
                     suspended_until=$2::timestamptz,
                     moderation_reason=$3::text,
                     auth_version=auth_version+1
                 WHERE id=$4::integer
                 RETURNING id, username, account_status, suspended_until, moderation_reason, auth_version`,
                [status, status === "suspended" && until && !isNaN(until.getTime()) ? until : null, reason || null, id]
            );
            if (!r.rows.length) throw new Error("Account disappeared during moderation update.");
            await client.query("COMMIT");

            const auditDescription = "Account status changed to " + status + "." + (reason ? " Admin note: " + reason : "");
            await pool.query(
                `INSERT INTO complaints
                 (reporter_id, reported_user_id, category, subject, description, status, admin_id, admin_note, resolved_at)
                 VALUES ($1,$2,'moderation','Administrator action',$3,'resolved',$4,$3,NOW())`,
                [req.user.userId, id, auditDescription, req.user.userId]
            ).catch(()=>{});

            res.json({success:true,message:`Account ${status}.`,user:r.rows[0]});
        } catch (e) {
            await client.query("ROLLBACK").catch(()=>{});
            console.error(e);
            res.status(500).json({success:false,message:"Failed to update account."});
        } finally {
            client.release();
        }
    });

    // =========================================================
    // COMPLAINTS (EXISTING)
    // =========================================================
    router.get("/complaints", authenticateToken, adminOnly, async (req, res) => {
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        try {
            const r = await pool.query(
                `SELECT c.*, reporter.username AS reporter_username,
                        reported.username AS reported_username,
                        admin.username AS admin_username
                 FROM complaints c
                 JOIN users reporter ON reporter.id=c.reporter_id
                 LEFT JOIN users reported ON reported.id=c.reported_user_id
                 LEFT JOIN users admin ON admin.id=c.admin_id
                 WHERE ($1::boolean OR c.admin_cleared_at IS NULL)
                 ORDER BY CASE WHEN c.status='open' THEN 0 ELSE 1 END, c.created_at DESC
                 LIMIT 300`
                , [includeCleared]
            );
            res.json({success:true,complaints:r.rows});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load complaints."});
        }
    });

    router.post("/complaints/:id", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        const status = String(req.body.status || "resolved").toLowerCase();
        const note = String(req.body.note || "").trim().slice(0,2000);
        if (!Number.isInteger(id) || !["open","investigating","resolved","dismissed"].includes(status)) {
            return res.status(400).json({success:false,message:"Invalid complaint status."});
        }
        try {
            const r = await pool.query(
                `UPDATE complaints SET status=$1, admin_id=$2, admin_note=$3,
                 resolved_at=CASE WHEN $1::varchar IN ('resolved','dismissed') THEN NOW() ELSE NULL END,
                 admin_cleared_at=CASE WHEN $1::varchar IN ('open','investigating') THEN NULL ELSE admin_cleared_at END
                 WHERE id=$4 RETURNING *`,
                [status, req.user.userId, note || null, id]
            );
            if (!r.rows.length) return res.status(404).json({success:false,message:"Complaint not found."});
            res.json({success:true,message:"Complaint updated.",complaint:r.rows[0]});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to update complaint."});
        }
    });

    router.post("/complaints/:id/clear", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({success:false,message:"Invalid complaint."});
        try {
            const r = await pool.query(
                `UPDATE complaints SET admin_cleared_at=NOW()
                 WHERE id=$1 AND status IN ('resolved','dismissed') RETURNING id,admin_cleared_at`, [id]);
            if (!r.rows.length) {
                const exists = await pool.query("SELECT status FROM complaints WHERE id=$1", [id]);
                return exists.rows.length
                    ? res.status(409).json({success:false,message:"Resolve or dismiss this complaint before clearing it."})
                    : res.status(404).json({success:false,message:"Complaint not found."});
            }
            res.json({success:true,message:"Complaint cleared from the active list.",complaint:r.rows[0]});
        } catch (e) {
            console.error("Admin complaint clear error:", e.message);
            res.status(500).json({success:false,message:"Failed to clear complaint."});
        }
    });

    router.post("/complaints/:id/restore", authenticateToken, adminOnly, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({success:false,message:"Invalid complaint."});
        try {
            const r = await pool.query(
                "UPDATE complaints SET admin_cleared_at=NULL WHERE id=$1 RETURNING id,admin_cleared_at", [id]);
            if (!r.rows.length) return res.status(404).json({success:false,message:"Complaint not found."});
            res.json({success:true,message:"Complaint restored to the active list.",complaint:r.rows[0]});
        } catch (e) {
            console.error("Admin complaint restore error:", e.message);
            res.status(500).json({success:false,message:"Failed to restore complaint."});
        }
    });

    // =========================================================
    // SUPPORT CHAT (EXISTING)
    // =========================================================
    router.get("/support", authenticateToken, adminOnly, async (req, res) => {
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        try {
            const r = await pool.query(
                `SELECT ct.id, ct.admin_cleared_at, ct.support_category,ct.support_subject,ct.support_status,
                        u.id AS user_id, u.username,
                        lm.message AS last_message,lm.message_ciphertext,lm.message_iv,lm.message_auth_tag,lm.encryption_key_id,
                        lm.created_at AS last_at,
                        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id=ct.id AND m.sender_id <> $1 AND m.read_at IS NULL)::int AS unread
                 FROM chat_threads ct
                 JOIN users u ON u.id=ct.user_one_id
                 LEFT JOIN LATERAL (SELECT message,message_ciphertext,message_iv,message_auth_tag,encryption_key_id,created_at
                                      FROM chat_messages WHERE thread_id=ct.id ORDER BY created_at DESC,id DESC LIMIT 1) lm ON TRUE
                 WHERE ct.thread_type='support'
                   AND ($2::boolean OR (ct.admin_cleared_at IS NULL AND COALESCE(ct.support_status,'open')<>'resolved'))
                 ORDER BY last_at DESC NULLS LAST`,
                [req.user.userId, includeCleared]
            );
            res.json({success:true,threads:r.rows.map(function(row){return Object.assign({},row,{last_message:decryptMessage(row)});})});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load support chats."});
        }
    });

    router.post("/support/:userId/clear", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return res.status(400).json({success:false,message:"Invalid player account."});
        }
        try {
            const r = await pool.query(
                `UPDATE chat_threads SET admin_cleared_at=NOW()
                 WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
                 RETURNING id`, [userId]
            );
            if (!r.rows.length) return res.status(404).json({success:false,message:"Support conversation not found."});
            res.json({success:true,message:"Conversation cleared from the inbox. Its history is preserved."});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not clear the conversation."});
        }
    });

    router.post("/support/clear-all", authenticateToken, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(
                `UPDATE chat_threads SET admin_cleared_at=NOW()
                  WHERE thread_type='support' AND admin_cleared_at IS NULL
                 RETURNING id`
            );
            const count = result.rows.length;
            return res.json({ success: true, count, message: count ? count + " conversation(s) cleared from the admin inbox. Message history is preserved." : "The admin inbox is already clear." });
        } catch (error) {
            console.error("Admin bulk support clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear the admin inbox." });
        }
    });

    router.post("/support/:userId/restore", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return res.status(400).json({success:false,message:"Invalid player account."});
        }
        try {
            const r = await pool.query(
                `UPDATE chat_threads SET admin_cleared_at=NULL
                 WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
                 RETURNING id`, [userId]
            );
            if (!r.rows.length) return res.status(404).json({success:false,message:"Support conversation not found."});
            res.json({success:true,message:"Conversation restored to the inbox."});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not restore the conversation."});
        }
    });

    router.post("/support/:userId/status", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        const status = String(req.body.status || "").trim().toLowerCase();
        if (!Number.isSafeInteger(userId) || userId <= 0 || !["open", "resolved"].includes(status)) {
            return res.status(400).json({success:false,message:"Choose open or resolved for this support conversation."});
        }
        try {
            const result = await pool.query(
                `UPDATE chat_threads SET support_status=$1,
                        admin_cleared_at=CASE WHEN $1='open' THEN NULL ELSE admin_cleared_at END
                  WHERE thread_type='support' AND user_one_id=$2 AND user_two_id IS NULL
                  RETURNING support_status`,
                [status,userId]
            );
            if (!result.rows.length) return res.status(404).json({success:false,message:"Support conversation not found."});
            res.json({success:true,status:result.rows[0].support_status,
                message:status==='resolved'?"Support conversation marked resolved.":"Support conversation reopened."});
        } catch (error) {
            console.error("Admin support status update failed.");
            res.status(500).json({success:false,message:"Could not update support status."});
        }
    });

    router.get("/support/:userId", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        try {
            const t = await pool.query(
                `SELECT id FROM chat_threads
                 WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL`,
                [userId]
            );
            if (!t.rows.length) return res.json({success:true,threadId:null,messages:[]});
            await pool.query(
                `UPDATE chat_messages SET read_at=NOW()
                 WHERE thread_id=$1 AND sender_id=$2 AND read_at IS NULL`,
                [t.rows[0].id,userId]
            );
            const messages = await pool.query(
                `SELECT m.id,m.sender_id,m.message,m.message_ciphertext,m.message_iv,m.message_auth_tag,m.encryption_key_id,m.created_at,m.read_at,m.client_message_id,u.username
                 FROM chat_messages m JOIN users u ON u.id=m.sender_id
                 WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,
                [t.rows[0].id]
            );
            res.json({success:true,threadId:t.rows[0].id,messages:decryptMessageRows(messages.rows)});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load support conversation."});
        }
    });

    router.post("/support/:userId", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        const message = String(req.body.message || "").trim();
        if (!message || message.length > 2000)
            return res.status(400).json({success:false,message:"Message must be 1-2000 characters."});
        const client=await pool.connect();
        let shouldDispatch=false;
        try {
            await client.query("BEGIN");
            const target=await client.query("SELECT id,username,account_status FROM users WHERE id=$1",[userId]);
            if(!target.rows.length||target.rows[0].account_status!=='active'){
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"Player account is not available."});
            }
            const threadId = await getOrCreateSupportThread(userId,client);
            const sealed=encryptedMessageValues(message);
            const m = await client.query(
                `INSERT INTO chat_messages(thread_id,sender_id,message,message_ciphertext,message_iv,message_auth_tag,encryption_key_id)
                 VALUES($1,$2,$3,$4,$5,$6,$7)
                 RETURNING id,sender_id,message,message_ciphertext,message_iv,message_auth_tag,encryption_key_id,created_at,client_message_id`,
                [threadId,req.user.userId,...sealed]
            );
            await client.query(`UPDATE chat_threads SET admin_cleared_at=NULL WHERE id=$1`,[threadId]);

            await client.query(
                `INSERT INTO system_notifications(user_id,type,title,message)
                 VALUES($1,'support_reply',$2,$3)`,
                [userId, `Admin reply from ${req.user.username}`, "An administrator replied to your support conversation. Open GOAL$GAMBIT Companion to read it."]
            );

            if(pushService&&typeof pushService.enqueueNotification==="function"){
                await client.query("SAVEPOINT support_reply_push");
                try{
                    await pushService.enqueueNotification(client,userId,{
                        eventKey:"support-reply:"+threadId+":"+m.rows[0].id,
                        title:"GOAL$GAMBIT — Admin Support Reply",
                        body:"An administrator replied to your support conversation. Open GOAL$GAMBIT Companion to read it.",
                        page:"match-hub"
                    });
                    await client.query("RELEASE SAVEPOINT support_reply_push");
                    shouldDispatch=true;
                }catch(_){
                    await client.query("ROLLBACK TO SAVEPOINT support_reply_push").catch(function(){});
                    await client.query("RELEASE SAVEPOINT support_reply_push").catch(function(){});
                    console.error("Admin support reply push could not be queued.");
                }
            }
            await client.query("COMMIT");
            res.json({success:true,message:Object.assign({},m.rows[0],{message:decryptMessage(m.rows[0])})});
        } catch (e) {
            await client.query("ROLLBACK").catch(function(){});
            console.error(e);
            res.status(500).json({success:false,message:"Failed to send support reply."});
        } finally {
            client.release();
            if(shouldDispatch&&pushService&&typeof pushService.sendPendingJobs==="function")
                pushService.sendPendingJobs().catch(function(){});
        }
    });

    // =========================================================
    // ADMIN -> ALL USERS ANNOUNCEMENTS
    // =========================================================
    router.get("/announcements", authenticateToken, adminOnly, async (req,res) => {
        try {
            const r=await pool.query(
                `SELECT a.id,a.message,a.created_at,a.active,a.event_name,a.event_at,
                        a.event_time_zone,a.audience,a.publish_at,a.published_at,
                        u.username AS admin_username,
                        (SELECT COUNT(*) FROM users p WHERE p.account_status='active'
                          AND (a.audience='all'
                               OR (a.audience='chess' AND p.game IN ('chess','both'))
                               OR (a.audience='konami' AND p.game IN ('konami','both'))))::int AS active_users
                 FROM admin_announcements a
                 JOIN users u ON u.id=a.admin_id
                 ORDER BY a.created_at DESC,a.id DESC
                 LIMIT 100`
            );
            res.json({success:true,announcements:r.rows});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load announcements."});
        }
    });

    router.post("/announcements", authenticateToken, adminOnly, async (req,res) => {
        const message=String(req.body.message||"").trim();
        if(!message||message.length>2000)
            return res.status(400).json({success:false,message:"Announcement must be 1-2000 characters."});
        const eventName=String(req.body.eventName||"").trim();
        const eventAtInput=String(req.body.eventAt||"").trim();
        const eventTimeZone=String(req.body.eventTimeZone||"Africa/Nairobi").trim();
        const audience=String(req.body.audience||"all").trim().toLowerCase();
        const publishAtInput=String(req.body.publishAt||"").trim();
        if(!["all","chess","konami"].includes(audience))
            return res.status(400).json({success:false,message:"Choose all users, Chess players, or eFootball players."});
        if(eventName.length>160)
            return res.status(400).json({success:false,message:"Event name must be 160 characters or fewer."});
        if(Boolean(eventName)!==Boolean(eventAtInput))
            return res.status(400).json({success:false,message:"Enter both the event name and its date and start time."});
        let eventAt=null, publishAt=null;
        const now=Date.now();
        if(eventAtInput){
            eventAt=new Date(eventAtInput);
            if(Number.isNaN(eventAt.getTime())||eventAt.getTime()<=now)
                return res.status(400).json({success:false,message:"The event start time must be in the future."});
        }
        if(publishAtInput){
            publishAt=new Date(publishAtInput);
            if(Number.isNaN(publishAt.getTime())||publishAt.getTime()<=now)
                return res.status(400).json({success:false,message:"Choose a future delivery time, or leave it blank to publish immediately."});
            if(eventAt&&publishAt.getTime()>=eventAt.getTime())
                return res.status(400).json({success:false,message:"Delivery must be scheduled before the event starts."});
        }
        try {
            new Intl.DateTimeFormat("en",{timeZone:eventTimeZone});
        } catch (_) {
            return res.status(400).json({success:false,message:"Choose a valid event time zone."});
        }
        const client=await pool.connect();
        try {
            await client.query("BEGIN");
            const r=await client.query(
                `INSERT INTO admin_announcements
                    (admin_id,message,event_name,event_at,event_time_zone,audience,publish_at,published_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::timestamptz IS NULL THEN NOW() ELSE NULL END)
                 RETURNING id,message,created_at,active,event_name,event_at,event_time_zone,
                           audience,publish_at,published_at`,
                [req.user.userId,message,eventName||null,eventAt,eventTimeZone,audience,publishAt]
            );
            let queuedUsers=0;
            if(!publishAt) queuedUsers=await enqueueAnnouncementToAudience(client,pushService,r.rows[0],"publish");
            await client.query("COMMIT");
            if(!publishAt&&pushService&&typeof pushService.sendPendingJobs==="function")
                pushService.sendPendingJobs().catch(function(){});
            res.status(201).json({
                success:true,
                scheduled:Boolean(publishAt),
                queuedUsers,
                message:publishAt?"Announcement scheduled for delivery.":"Announcement published to its selected audience.",
                announcement:r.rows[0]
            });
        } catch(e) {
            await client.query("ROLLBACK").catch(function(){});
            console.error(e);
            res.status(500).json({success:false,message:"Failed to send announcement."});
        } finally {
            client.release();
        }
    });

    router.post("/announcements/:id/deactivate", authenticateToken, adminOnly, async (req,res) => {
        const id=Number(req.params.id);
        if(!Number.isInteger(id)||id<=0)
            return res.status(400).json({success:false,message:"Invalid announcement."});
        try {
            const r=await pool.query(
                `UPDATE admin_announcements SET active=FALSE WHERE id=$1 RETURNING id,active`,
                [id]
            );
            if(!r.rows.length)
                return res.status(404).json({success:false,message:"Announcement not found."});
            res.json({success:true,message:"Announcement hidden from users.",announcement:r.rows[0]});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to deactivate announcement."});
        }
    });

    router.post("/announcements/deactivate-all", authenticateToken, adminOnly, async (req,res) => {
        try {
            const result = await pool.query(
                "UPDATE admin_announcements SET active=FALSE WHERE active=TRUE RETURNING id"
            );
            const count = result.rows.length;
            return res.json({ success: true, count, message: count ? count + " active announcement(s) hidden from players." : "There are no active announcements to clear." });
        } catch (error) {
            console.error("Admin bulk announcement clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear active announcements." });
        }
    });

    router.delete("/announcements/:id", authenticateToken, adminOnly, async (req,res) => {
        const id=Number(req.params.id);
        if(!Number.isSafeInteger(id)||id<=0)
            return res.status(400).json({success:false,message:"Invalid announcement."});
        try {
            const r=await pool.query("DELETE FROM admin_announcements WHERE id=$1 RETURNING id",[id]);
            if(!r.rows.length)
                return res.status(404).json({success:false,message:"Announcement not found."});
            return res.json({success:true,message:"Announcement deleted from the admin list and player history."});
        } catch(e) {
            console.error(e);
            return res.status(500).json({success:false,message:"Failed to delete announcement."});
        }
    });

    const companionTrackerCte = `
        WITH installation_rollup AS (
            SELECT user_id,
                   COUNT(*)::int AS installation_count,
                   COUNT(*) FILTER (WHERE unregistered_at IS NULL)::int AS active_installation_count,
                   MIN(registered_at) AS registered_at,
                   MAX(last_seen_at) AS last_seen_at,
                   MAX(last_seen_at) FILTER (WHERE unregistered_at IS NULL) AS active_last_seen_at,
                   (ARRAY_AGG(app_version ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC))[1] AS app_version,
                   (ARRAY_AGG(device_platform ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC))[1] AS device_platform,
                   (ARRAY_AGG(notification_permission_checked_at ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC))[1] AS notification_permission_checked_at,
                   BOOL_OR(unregistered_at IS NULL AND notification_permission_status='granted') AS has_granted_permission,
                   BOOL_OR(unregistered_at IS NULL AND notification_permission_status='denied') AS has_denied_permission,
                   BOOL_OR(unregistered_at IS NULL AND notification_permission_status='unknown') AS has_unknown_permission
              FROM companion_installations
             GROUP BY user_id
        ), download_rollup AS (
            SELECT user_id,MIN(downloaded_at) AS downloaded_at,MAX(last_downloaded_at) AS last_downloaded_at
              FROM companion_download_events GROUP BY user_id
        ), push_token_rollup AS (
            SELECT user_id,
                   COUNT(*) FILTER (WHERE active)::int AS active_push_device_count,
                   COUNT(*) FILTER (WHERE inactive_reason='token_invalid')::int AS invalid_push_token_count,
                   COUNT(*) FILTER (WHERE inactive_reason='user_disabled')::int AS disabled_push_device_count,
                   MAX(updated_at) FILTER (WHERE active) AS latest_push_registration_at
              FROM android_push_tokens GROUP BY user_id
        ), member_rows AS (
            SELECT u.id AS user_id,u.username,u.game,u.account_status,
                   s.onboarding_version,s.onboarding_acknowledged_at,
                   s.terms_accepted_version,s.terms_accepted_at,
                   d.downloaded_at,d.last_downloaded_at,
                   i.installation_count,i.active_installation_count,i.registered_at,i.last_seen_at,
                   i.active_last_seen_at,i.app_version,i.device_platform,i.notification_permission_checked_at,
                   CASE WHEN COALESCE(i.has_granted_permission,FALSE) THEN 'granted'
                        WHEN COALESCE(i.has_denied_permission,FALSE) THEN 'denied'
                        WHEN COALESCE(i.has_unknown_permission,FALSE) THEN 'unknown'
                        ELSE 'unknown' END AS notification_permission_status,
                   (COALESCE(i.active_installation_count,0)>0) AS currently_registered,
                   COALESCE(p.active_push_device_count,0) AS active_push_device_count,
                   COALESCE(p.invalid_push_token_count,0) AS invalid_push_token_count,
                   COALESCE(p.disabled_push_device_count,0) AS disabled_push_device_count,
                   p.latest_push_registration_at,
                   CASE WHEN COALESCE(p.active_push_device_count,0)>0 THEN 'registered'
                        WHEN COALESCE(p.invalid_push_token_count,0)>0 THEN 'token_invalid'
                        WHEN COALESCE(p.disabled_push_device_count,0)>0 THEN 'user_disabled'
                        WHEN COALESCE(i.active_installation_count,0)>0 THEN 'registration_incomplete'
                        ELSE 'not_registered' END AS push_registration_status,
                   (COALESCE(i.active_installation_count,0)>0 AND i.active_last_seen_at>=NOW()-INTERVAL '7 days') AS recently_active,
                   (COALESCE(i.installation_count,0)>0 AND
                       (COALESCE(i.active_installation_count,0)=0 OR i.active_last_seen_at<NOW()-INTERVAL '30 days')) AS stale_or_inactive,
                   COALESCE(s.onboarding_version=$1,FALSE) AS guide_acknowledged,
                   COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE) AS terms_accepted,
                   (COALESCE(i.installation_count,0)>0) AS installation_confirmed,
                   (COALESCE(s.onboarding_version=$1,FALSE)
                    AND COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE)
                    AND COALESCE(i.installation_count,0)>0) AS onboarding_complete
              FROM users u
              LEFT JOIN companion_user_setup s ON s.user_id=u.id
              LEFT JOIN download_rollup d ON d.user_id=u.id
              LEFT JOIN installation_rollup i ON i.user_id=u.id
              LEFT JOIN push_token_rollup p ON p.user_id=u.id
        )`;

    router.get("/companion-tracker", authenticateToken, adminOnly, async (req, res) => {
        const allowedFilters = new Set([
            "all", "guide_not_acknowledged", "download_not_detected", "registration_not_detected",
            "registered", "recently_active", "stale", "notifications_denied", "notifications_unknown",
            "terms_not_accepted", "onboarding_complete"
        ]);
        const filter = String(req.query.filter || "all");
        const search = String(req.query.search || "").trim().slice(0, 80);
        const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
        const pageSize = Math.max(1, Math.min(100, Number.parseInt(req.query.pageSize, 10) || 50));
        if (!allowedFilters.has(filter)) return res.status(400).json({ success: false, message: "Invalid companion tracker filter." });

        const where = [];
        const params = [companionGuideVersion, companionTermsVersion];
        if (search) {
            params.push("%" + search.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_") + "%");
            const searchPatternIndex = params.length;
            params.push(search);
            const searchExactIndex = params.length;
            where.push(`(username ILIKE $${searchPatternIndex} ESCAPE '!' OR user_id::text=$${searchExactIndex})`);
        }
        const filterSql = {
            guide_not_acknowledged: "NOT guide_acknowledged",
            download_not_detected: "downloaded_at IS NULL",
            registration_not_detected: "installation_count IS NULL",
            registered: "currently_registered",
            recently_active: "recently_active",
            stale: "stale_or_inactive",
            notifications_denied: "currently_registered AND notification_permission_status='denied'",
            notifications_unknown: "currently_registered AND notification_permission_status='unknown'",
            terms_not_accepted: "NOT terms_accepted",
            onboarding_complete: "onboarding_complete"
        };
        if (filterSql[filter]) where.push(filterSql[filter]);
        const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
        const countParams = params.slice();
        params.push(pageSize, (page - 1) * pageSize);

        try {
            const [stats, count, members] = await Promise.all([
                pool.query(
                    `SELECT COUNT(*)::int AS total_members,
                            COUNT(*) FILTER (WHERE COALESCE(s.onboarding_version=$1,FALSE))::int AS guide_acknowledged,
                            COUNT(*) FILTER (WHERE COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE))::int AS terms_accepted,
                            COUNT(*) FILTER (WHERE COALESCE(s.onboarding_version=$1,FALSE)
                                AND COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE)
                                AND EXISTS(SELECT 1 FROM companion_installations i WHERE i.user_id=u.id))::int AS onboarding_complete,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_download_events) AS downloaded_members,
                            (SELECT COUNT(*)::int FROM companion_anonymous_download_events) AS anonymous_downloads,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_installations WHERE unregistered_at IS NULL) AS registered_members,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_installations
                              WHERE unregistered_at IS NULL AND last_seen_at>=NOW()-INTERVAL '7 days') AS recently_active_members,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_installations
                              WHERE unregistered_at IS NULL AND notification_permission_status='granted') AS notifications_granted,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_installations
                              WHERE unregistered_at IS NULL AND notification_permission_status='denied') AS notifications_denied,
                            (SELECT COUNT(DISTINCT user_id)::int FROM companion_installations
                              WHERE unregistered_at IS NULL AND notification_permission_status='unknown') AS notifications_unknown
                       FROM users u LEFT JOIN companion_user_setup s ON s.user_id=u.id`,
                    [companionGuideVersion, companionTermsVersion]
                ),
                pool.query(`${companionTrackerCte} SELECT COUNT(*)::int AS total FROM member_rows${whereSql}`, countParams),
                pool.query(
                    `${companionTrackerCte}
                     SELECT user_id,username,game,account_status,onboarding_version,onboarding_acknowledged_at,
                            terms_accepted_version,terms_accepted_at,terms_accepted,installation_confirmed,onboarding_complete,
                            downloaded_at,last_downloaded_at,installation_count,active_installation_count,
                            registered_at,last_seen_at,active_last_seen_at,app_version,device_platform,
                            notification_permission_status,notification_permission_checked_at,
                            active_push_device_count,invalid_push_token_count,disabled_push_device_count,
                            latest_push_registration_at,push_registration_status,
                            currently_registered,recently_active,stale_or_inactive,guide_acknowledged
                       FROM member_rows${whereSql}
                      ORDER BY user_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
                    params
                )
            ]);
            res.set("Cache-Control", "private, no-store");
            return res.json({
                success: true,
                stats: stats.rows[0],
                members: members.rows,
                page,
                pageSize,
                total: Number(count.rows[0] && count.rows[0].total || 0),
                guideVersion: companionGuideVersion,
                termsVersion: companionTermsVersion,
                recentlyActiveDays: 7,
                staleAfterDays: 30
            });
        } catch (error) {
            console.error("Admin companion tracker query failed.");
            return res.status(500).json({ success: false, message: "Could not load companion installation records." });
        }
    });

    router.get("/companion-tracker/:userId", authenticateToken, adminOnly, async (req, res) => {
        const userId = Number(req.params.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ success: false, message: "Invalid member reference." });
        try {
            const result = await pool.query(
                `SELECT u.id AS user_id,u.username,u.game,u.account_status,
                        s.onboarding_version,s.onboarding_acknowledged_at,
                        s.terms_accepted_version,s.terms_accepted_at,
                        COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE) AS terms_accepted,
                        EXISTS(SELECT 1 FROM companion_installations i WHERE i.user_id=u.id) AS installation_confirmed,
                        (COALESCE(s.onboarding_version=$3,FALSE)
                         AND COALESCE(s.terms_accepted_version=$2 AND s.terms_accepted_at IS NOT NULL,FALSE)
                         AND EXISTS(SELECT 1 FROM companion_installations i WHERE i.user_id=u.id)) AS onboarding_complete,
                        EXISTS(SELECT 1 FROM companion_download_events d WHERE d.user_id=u.id) AS downloaded,
                        (SELECT MIN(downloaded_at) FROM companion_download_events d WHERE d.user_id=u.id) AS downloaded_at,
                        COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'platform',i.device_platform,'appVersion',i.app_version,
                            'registeredAt',i.registered_at,'lastSeenAt',i.last_seen_at,
                            'unregisteredAt',i.unregistered_at,
                            'notificationPermissionStatus',i.notification_permission_status,
                            'notificationPermissionCheckedAt',i.notification_permission_checked_at,
                            'currentlyRegistered',i.unregistered_at IS NULL
                         ) ORDER BY i.updated_at DESC,i.id DESC)
                           FROM companion_installations i WHERE i.user_id=u.id),'[]'::jsonb) AS installations,
                        COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'deviceName',t.device_name,'registeredAt',t.created_at,'lastUpdatedAt',t.updated_at,
                            'status',CASE WHEN t.active THEN 'registered'
                                          WHEN t.inactive_reason='token_invalid' THEN 'token_invalid'
                                          WHEN t.inactive_reason='user_disabled' THEN 'user_disabled'
                                          ELSE 'inactive' END
                         ) ORDER BY t.updated_at DESC,t.id DESC)
                           FROM android_push_tokens t WHERE t.user_id=u.id),'[]'::jsonb) AS push_devices
                   FROM users u LEFT JOIN companion_user_setup s ON s.user_id=u.id
                  WHERE u.id=$1`, [userId, companionTermsVersion, companionGuideVersion]
            );
            if (!result.rows.length) return res.status(404).json({ success: false, message: "Member not found." });
            res.set("Cache-Control", "private, no-store");
            return res.json({ success: true, member: result.rows[0] });
        } catch (error) {
            console.error("Admin companion member detail query failed.");
            return res.status(500).json({ success: false, message: "Could not load this member's companion details." });
        }
    });

    return router;
};
