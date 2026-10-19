"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const { enqueueAnnouncementToAudience } = require("../services/adminAnnouncementReminders");
const companionGuideVersion = require("./companion").GUIDE_VERSION;
const companionTermsVersion = require("./companion").TERMS_VERSION;

module.exports = function(pool, authenticateToken, getOnlineUserIds, pushService) {
    const router = express.Router();
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
                `SELECT u.id, u.username, u.phone, u.game, u.rating, u.role, u.account_status,
                        u.suspended_until, u.moderation_reason, u.created_at,
                        COALESCE(w.balance,0)::numeric(12,2) AS balance,
                        COALESCE(w.locked_balance,0)::numeric(12,2) AS locked_balance
                 FROM users u LEFT JOIN wallets w ON w.user_id=u.id
                 WHERE ($1 = '' OR LOWER(u.username) LIKE '%' || $1 || '%' OR u.phone LIKE '%' || $1 || '%')
                 ORDER BY u.created_at DESC LIMIT 200`,
                [q]
            );
            const onlineIds = new Set(
                (typeof getOnlineUserIds === "function" ? getOnlineUserIds() : [])
                    .map(function(id) { return String(Number(id)); })
            );
            res.json({
                success:true,
                users:r.rows.map(function(user) {
                    return Object.assign({}, user, { online: onlineIds.has(String(Number(user.id))) });
                })
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({success:false,message:"Failed to load users."});
        }
    });

    // Adjust only available balance; locked match/competition stakes are never
    // touched. The wallet, user transaction, and detailed audit are atomic.
    router.post("/users/:id/wallet-adjustment", authenticateToken, adminOnly, async (req, res) => {
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
            const wallet = await client.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1 FOR UPDATE", [userId]);
            const previous = Number(wallet.rows[0].balance);
            const updated = await client.query(
                `UPDATE wallets SET balance=balance+$1,updated_at=NOW()
                  WHERE user_id=$2 AND balance+$1 >= 0
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
                `SELECT ct.id, ct.admin_cleared_at, ct.support_category,ct.support_subject,ct.support_status,
                        u.id AS user_id, u.username,
                        (SELECT message FROM chat_messages m WHERE m.thread_id=ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                        (SELECT created_at FROM chat_messages m WHERE m.thread_id=ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
                        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id=ct.id AND m.sender_id <> $1 AND m.read_at IS NULL)::int AS unread
                 FROM chat_threads ct
                 JOIN users u ON u.id=ct.user_one_id
                 WHERE ct.thread_type='support'
                   AND ($2::boolean OR (ct.admin_cleared_at IS NULL AND COALESCE(ct.support_status,'open')<>'resolved'))
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
                `SELECT m.id,m.sender_id,m.message,m.created_at,m.read_at,m.client_message_id,u.username
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
            const m = await client.query(
                `INSERT INTO chat_messages(thread_id,sender_id,message) VALUES($1,$2,$3)
                 RETURNING id,sender_id,message,created_at,client_message_id`,
                [threadId,req.user.userId,message]
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
            res.json({success:true,message:m.rows[0]});
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
