"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const router = express.Router();

module.exports = function(pool, authenticateToken) {
    async function getOrCreateSupportThread(userId) {
        const created = await pool.query(
            `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id)
             VALUES('support',$1,NULL)
             ON CONFLICT (user_one_id)
             WHERE thread_type='support' AND user_two_id IS NULL
             DO NOTHING
             RETURNING id`,
            [userId]
        );
        if (created.rows.length) return created.rows[0].id;

        const existing = await pool.query(
            `SELECT id FROM chat_threads
             WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
             ORDER BY id ASC LIMIT 1`,
            [userId]
        );
        if (!existing.rows.length) throw new Error("Unable to create support conversation.");
        return existing.rows[0].id;
    }

    async function adminOnly(req, res, next) {
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Pragma", "no-cache");
        try {
            const r = await pool.query(
                `SELECT id, username, role FROM users WHERE id = $1`,
                [req.user.userId]
            );
            if (!r.rows.length || r.rows[0].role !== "admin") {
                return res.status(403).json({success:false,message:"Administrator access required."});
            }
            req.admin = r.rows[0];
            next();
        } catch (e) {
            console.error("Admin authorization error:", e.message);
            res.status(500).json({success:false,message:"Could not verify administrator access."});
        }
    }

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

    const verificationDirectory = path.join(__dirname, "..", "uploads", "match-verification");

    router.get("/result-verifications", authenticateToken, adminOnly, async (req, res) => {
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        try {
            const result = await pool.query(
                `SELECT v.id,v.match_id,v.selected_player_id,v.status,v.submitted_at,v.created_at,
                        v.admin_cleared_at,v.admin_cleared_by,
                        v.screenshot_ocr_text,v.detected_score_candidates,v.score_check,v.review_note,v.reviewed_at,
                        (v.screenshot_path IS NOT NULL) AS screenshot_available,
                        m.status AS match_status,m.settled_at,m.mode,m.league,m.tournament_id,
                        m.creator_id,m.opponent_id,m.creator_submitted_score,m.creator_submitted_opponent_score,
                        m.opponent_submitted_score,m.opponent_submitted_opponent_score,
                        creator.username AS creator_username,opponent.username AS opponent_username,
                        selected.username AS selected_username,
                        COALESCE(report_history.reports,'[]'::jsonb) AS reports
                 FROM efootball_result_verifications v
                 JOIN efootball_matches m ON m.id=v.match_id
                 JOIN users creator ON creator.id=m.creator_id
                 LEFT JOIN users opponent ON opponent.id=m.opponent_id
                 JOIN users selected ON selected.id=v.selected_player_id
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
            return res.sendFile(filePath);
        } catch (error) {
            console.error("Admin screenshot read error:", error.message);
            return res.status(500).json({ success: false, message: "Could not open screenshot." });
        }
    });

    router.post("/result-verifications/:id/review", authenticateToken, adminOnly, async (req, res) => {
        const verificationId = Number(req.params.id);
        const decision = String(req.body && req.body.decision || "").toLowerCase();
        const note = String(req.body && req.body.note || "").trim().slice(0, 1000);
        const creatorScore = Number(req.body && req.body.creatorScore);
        const opponentScore = Number(req.body && req.body.opponentScore);
        if (!Number.isSafeInteger(verificationId) || verificationId <= 0 || !["resolve", "reject"].includes(decision)) {
            return res.status(400).json({ success: false, message: "Choose a valid review decision." });
        }
        if (decision === "resolve" && (!Number.isInteger(creatorScore) || !Number.isInteger(opponentScore) || creatorScore < 0 || opponentScore < 0 || creatorScore > 99 || opponentScore > 99)) {
            return res.status(400).json({ success: false, message: "Enter both verified scores from 0 to 99." });
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
                const message = "An admin reviewed the screenshot and resolved the match result. The result and standings are updated.";
                await client.query(
                    "INSERT INTO system_notifications(user_id,type,title,message,match_id) VALUES ($1,'match_verified','Admin Resolved Result',$2,$3),($4,'match_verified','Admin Resolved Result',$5,$6)",
                    [Number(record.creator_id), message, Number(record.match_id), Number(record.opponent_id), message, Number(record.match_id)]
                );
                await client.query("COMMIT");
                return res.json({ success: true, settlement: settlement, message: "Result resolved and settled." });
            }

            await client.query(
                "UPDATE efootball_result_verifications SET status='rejected',reviewed_by=$1,review_note=$2,reviewed_at=NOW() WHERE id=$3",
                [req.user.userId, note || "Screenshot did not establish a reliable score.", verificationId]
            );
            await client.query("UPDATE efootball_matches SET status='disputed',result_status='disputed' WHERE id=$1", [record.match_id]);
            await client.query("COMMIT");
            return res.json({ success: true, message: "Evidence was rejected. Match funds remain locked until another admin decision." });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("Admin result review error:", error.message);
            return res.status(500).json({ success: false, message: "Could not save the result decision." });
        } finally {
            client.release();
        }
    });

    // =========================================================
    // EXISTING ADMIN OVERVIEW
    // =========================================================
    router.get("/overview", authenticateToken, adminOnly, async (req, res) => {
        try {
            const [users, complaints, openChats, announcements] = await Promise.all([
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
                            WHERE active=TRUE`)
            ]);
            res.json({
                success:true,
                users:users.rows[0],
                complaints:complaints.rows[0],
                openChats:openChats.rows[0],
                announcements:announcements.rows[0]
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load admin overview."});
        }
    });

    // =========================================================
    // USER MANAGEMENT (EXISTING)
    // =========================================================
    router.get("/users", authenticateToken, adminOnly, async (req, res) => {
        try {
            const q = String(req.query.search || "").trim().toLowerCase();
            const r = await pool.query(
                `SELECT id, username, phone, game, rating, role, account_status,
                        suspended_until, moderation_reason, created_at
                 FROM users
                 WHERE ($1 = '' OR LOWER(username) LIKE '%' || $1 || '%' OR phone LIKE '%' || $1 || '%')
                 ORDER BY created_at DESC LIMIT 200`,
                [q]
            );
            res.json({success:true,users:r.rows});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load users."});
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
            const [profile, transactions, chess, efootball] = await Promise.all([
                pool.query(
                    `SELECT u.id,u.username,u.phone,u.game,u.rating,u.role,u.account_status,u.created_at,
                            COALESCE(w.balance,0)::numeric(12,2) AS balance,
                            COALESCE(w.locked_balance,0)::numeric(12,2) AS locked_balance
                     FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.id=$1`, [id]),
                pool.query(
                    `SELECT transaction_type,amount,currency,status,reference,description,created_at
                     FROM transactions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10`, [id]),
                pool.query(
                    `SELECT COUNT(*)::int AS played,
                            COUNT(*) FILTER (WHERE winner_id=$1)::int AS wins,
                            COUNT(*) FILTER (WHERE result='draw')::int AS draws
                     FROM chess_matches WHERE (player_white_id=$1 OR player_black_id=$1) AND status='completed'`, [id]),
                pool.query(
                    `SELECT COUNT(*)::int AS played,
                            COUNT(*) FILTER (WHERE status='completed')::int AS completed
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
                     ORDER BY COALESCE(finished_at,created_at) DESC,id DESC LIMIT 8`, [id])
            ]);
            res.json({success:true,dashboard:{user:profile.rows[0],transactions:transactions.rows,
                chess:{stats:chess.rows[0],recent:chessRecent.rows},
                efootball:{stats:efootball.rows[0],recent:efootballRecent.rows}}});
        } catch (e) {
            console.error("Admin user dashboard error:", e.message);
            res.status(500).json({success:false,message:"Failed to load the account dashboard."});
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
            const target = await client.query("SELECT id,username,role FROM users WHERE id=$1 FOR UPDATE", [id]);
            if (!target.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"User not found."});
            }
            if (target.rows[0].role === "admin") {
                await client.query("ROLLBACK");
                return res.status(409).json({success:false,message:"Administrator accounts cannot be permanently deleted from this desk."});
            }
            const wallet = await client.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [id]);
            if (wallet.rows.length && (Number(wallet.rows[0].balance) !== 0 || Number(wallet.rows[0].locked_balance) !== 0)) {
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

        try {
            const r = await pool.query(
                `UPDATE users
                 SET account_status=$1::varchar,
                     suspended_until=$2::timestamptz,
                     moderation_reason=$3::text
                 WHERE id=$4::integer
                 RETURNING id, username, account_status, suspended_until, moderation_reason`,
                [status, status === "suspended" && until && !isNaN(until.getTime()) ? until : null, reason || null, id]
            );
            if (!r.rows.length) return res.status(404).json({success:false,message:"User not found."});

            const auditDescription = "Account status changed to " + status + "." + (reason ? " Admin note: " + reason : "");
            await pool.query(
                `INSERT INTO complaints
                 (reporter_id, reported_user_id, category, subject, description, status, admin_id, admin_note, resolved_at)
                 VALUES ($1,$2,'moderation','Administrator action',$3,'resolved',$4,$3,NOW())`,
                [req.user.userId, id, auditDescription, req.user.userId]
            ).catch(()=>{});

            res.json({success:true,message:`Account ${status}.`,user:r.rows[0]});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to update account."});
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
                `SELECT ct.id, ct.admin_cleared_at, u.id AS user_id, u.username,
                        (SELECT message FROM chat_messages m WHERE m.thread_id=ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                        (SELECT created_at FROM chat_messages m WHERE m.thread_id=ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
                        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id=ct.id AND m.sender_id <> $1 AND m.read_at IS NULL)::int AS unread
                 FROM chat_threads ct
                 JOIN users u ON u.id=ct.user_one_id
                 WHERE ct.thread_type='support' AND ($2::boolean OR ct.admin_cleared_at IS NULL)
                 ORDER BY last_at DESC NULLS LAST`,
                [req.user.userId, includeCleared]
            );
            res.json({success:true,threads:r.rows});
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
                `SELECT m.id,m.sender_id,m.message,m.created_at,m.read_at,u.username
                 FROM chat_messages m JOIN users u ON u.id=m.sender_id
                 WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,
                [t.rows[0].id]
            );
            res.json({success:true,threadId:t.rows[0].id,messages:messages.rows});
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
        try {
            const threadId = await getOrCreateSupportThread(userId);
            const m = await pool.query(
                `INSERT INTO chat_messages(thread_id,sender_id,message) VALUES($1,$2,$3)
                 RETURNING id,sender_id,message,created_at`,
                [threadId,req.user.userId,message]
            );
            await pool.query(`UPDATE chat_threads SET admin_cleared_at=NULL WHERE id=$1`,[threadId]);

            await pool.query(
                `INSERT INTO system_notifications(user_id,type,title,message)
                 VALUES($1,'support_reply',$2,$3)`,
                [userId, `Admin reply from ${req.user.username}`, message]
            );

            res.json({success:true,message:m.rows[0]});
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to send support reply."});
        }
    });

    // =========================================================
    // ADMIN -> ALL USERS ANNOUNCEMENTS
    // =========================================================
    router.get("/announcements", authenticateToken, adminOnly, async (req,res) => {
        try {
            const r=await pool.query(
                `SELECT a.id,a.message,a.created_at,a.active,
                        u.username AS admin_username,
                        (SELECT COUNT(*) FROM users WHERE account_status='active')::int AS active_users
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
        try {
            const r=await pool.query(
                `INSERT INTO admin_announcements(admin_id,message)
                 VALUES($1,$2)
                 RETURNING id,message,created_at,active`,
                [req.user.userId,message]
            );
            res.status(201).json({success:true,message:"Announcement sent to all users.",announcement:r.rows[0]});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to send announcement."});
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

    return router;
};
