"use strict";

const express = require("express");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const chessRouteFactory = require("./chess");
const settleChessMatch = chessRouteFactory.settleMatch;

const TERMINAL = new Set(["completed", "cancelled"]);
const CHESS_ACTIVE = new Set(["waiting", "active"]);
const KONAMI_ACTIVE = new Set(["waiting", "ready", "playing", "awaiting_verification", "disputed"]);

module.exports = function createAdminMatchManagementRoutes(pool, authenticateToken) {
    const router = express.Router();

    async function adminOnly(req, res, next) {
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Pragma", "no-cache");
        try {
            const result = await pool.query("SELECT id,username,role FROM users WHERE id=$1", [req.user.userId]);
            if (!result.rows.length || result.rows[0].role !== "admin") {
                return res.status(403).json({ success: false, message: "Administrator access required." });
            }
            req.admin = result.rows[0];
            return next();
        } catch (error) {
            console.error("Admin match authorization failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not verify administrator access." });
        }
    }

    function validId(value) {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    function audit(client, game, matchId, adminId, action, reason, details) {
        return client.query(
            `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,reason,details)
             VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
            [game, matchId, adminId, action, reason || null, JSON.stringify(details || {})]
        );
    }

    function isActive(row) {
        const statuses = row.game === "chess" ? CHESS_ACTIVE : KONAMI_ACTIVE;
        return statuses.has(String(row.status)) && !row.settled_at;
    }

    function canEditScore(row) {
        if (row.game === "chess") {
            return row.status === "active" && row.opponent_id != null && !row.settled_at;
        }
        return row.game === "konami" &&
            ["playing", "awaiting_verification", "disputed"].includes(String(row.status)) &&
            row.opponent_id != null && !row.settled_at;
    }

    function present(row) {
        const match = Object.assign({}, row);
        match.id = Number(row.id);
        match.stake_amount = Number(row.stake_amount || 0);
        match.can_cancel_refund = isActive(row) && !(row.game === "chess" && row.match_type === "tournament");
        match.can_edit_score = canEditScore(row);
        match.is_terminal = TERMINAL.has(String(row.status)) && !!row.settled_at;
        return match;
    }

    router.get("/", authenticateToken, adminOnly, async (req, res) => {
        const game = String(req.query.game || "all").toLowerCase();
        const matchType = String(req.query.type || "all").toLowerCase();
        const includeCleared = String(req.query.includeCleared || "").toLowerCase() === "true";
        if (!["all", "chess", "konami"].includes(game) ||
            !["all", "casual", "ranked", "league", "tournament"].includes(matchType)) {
            return res.status(400).json({ success: false, message: "Choose a valid game and match type." });
        }

        try {
            const lists = [];
            if (game !== "konami") {
                const chess = await pool.query(
                    `SELECT m.id,'chess'::text AS game,m.match_type,m.status,m.result AS result_status,
                            m.player_white_id AS creator_id,m.player_black_id AS opponent_id,
                            white.username AS creator_username,black.username AS opponent_username,
                            m.winner_id,m.stake_amount,m.time_control,m.created_at,m.started_at,m.finished_at,
                            m.settled_at,m.admin_cleared_at,cleared.username AS cleared_by_username,
                            NULL::integer AS creator_score,NULL::integer AS opponent_score,
                            NULL::text AS mode,NULL::text AS league,NULL::bigint AS tournament_id
                       FROM chess_matches m
                       LEFT JOIN users white ON white.id=m.player_white_id
                       LEFT JOIN users black ON black.id=m.player_black_id
                       LEFT JOIN users cleared ON cleared.id=m.admin_cleared_by
                      WHERE ($1::text='all' OR m.match_type=$1)
                        AND ($2::boolean OR m.admin_cleared_at IS NULL)
                      ORDER BY CASE WHEN m.status IN ('waiting','active','settling') THEN 0 ELSE 1 END,
                               COALESCE(m.finished_at,m.created_at) DESC,m.id DESC
                      LIMIT 300`,
                    [matchType, includeCleared]
                );
                lists.push(...chess.rows);
            }
            if (game !== "chess") {
                const konami = await pool.query(
                    `SELECT m.id,'konami'::text AS game,
                            CASE WHEN m.mode='tournament' THEN 'tournament'
                                 WHEN m.mode LIKE 'league-%' THEN 'league' ELSE 'ranked' END AS match_type,
                            m.status,m.result_status,m.creator_id,m.opponent_id,
                            creator.username AS creator_username,opponent.username AS opponent_username,
                            m.winner_id,m.stake_amount,NULL::text AS time_control,m.created_at,m.started_at,
                            m.finished_at,m.settled_at,m.admin_cleared_at,cleared.username AS cleared_by_username,
                            m.creator_score,m.opponent_score,m.mode,m.league,m.tournament_id
                       FROM efootball_matches m
                       JOIN users creator ON creator.id=m.creator_id
                       LEFT JOIN users opponent ON opponent.id=m.opponent_id
                       LEFT JOIN users cleared ON cleared.id=m.admin_cleared_by
                      WHERE ($1::text='all' OR
                             CASE WHEN m.mode='tournament' THEN 'tournament'
                                  WHEN m.mode LIKE 'league-%' THEN 'league' ELSE 'ranked' END=$1)
                        AND ($2::boolean OR m.admin_cleared_at IS NULL)
                      ORDER BY CASE WHEN m.status IN ('waiting','ready','playing','awaiting_verification','disputed') THEN 0 ELSE 1 END,
                               COALESCE(m.finished_at,m.created_at) DESC,m.id DESC
                      LIMIT 300`,
                    [matchType, includeCleared]
                );
                lists.push(...konami.rows);
            }
            lists.sort((a, b) => {
                const activeOrder = Number(!isActive(a)) - Number(!isActive(b));
                return activeOrder || new Date(b.finished_at || b.created_at) - new Date(a.finished_at || a.created_at) || Number(b.id) - Number(a.id);
            });
            return res.json({ success: true, matches: lists.map(present) });
        } catch (error) {
            console.error("Admin match list failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load match management." });
        }
    });

    router.post("/clear-terminal", authenticateToken, adminOnly, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const chess = await client.query(
                `UPDATE chess_matches
                    SET admin_cleared_at=NOW(),admin_cleared_by=$1
                  WHERE admin_cleared_at IS NULL AND settled_at IS NOT NULL
                    AND status IN ('completed','cancelled')
                 RETURNING id`,
                [req.user.userId]
            );
            const konami = await client.query(
                `UPDATE efootball_matches
                    SET admin_cleared_at=NOW(),admin_cleared_by=$1
                  WHERE admin_cleared_at IS NULL AND settled_at IS NOT NULL
                    AND status IN ('completed','cancelled')
                 RETURNING id`,
                [req.user.userId]
            );
            const chessIds = chess.rows.map((row) => Number(row.id));
            const konamiIds = konami.rows.map((row) => Number(row.id));
            if (chessIds.length) {
                await client.query(
                    `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,details)
                     SELECT 'chess',matches.id,$2,'cleared','{}'::jsonb
                       FROM unnest($1::bigint[]) AS matches(id)`,
                    [chessIds, req.user.userId]
                );
            }
            if (konamiIds.length) {
                await client.query(
                    `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,details)
                     SELECT 'konami',matches.id,$2,'cleared','{}'::jsonb
                       FROM unnest($1::bigint[]) AS matches(id)`,
                    [konamiIds, req.user.userId]
                );
            }
            await client.query("COMMIT");
            const count = chessIds.length + konamiIds.length;
            return res.json({ success: true, count, chess: chessIds.length, konami: konamiIds.length, message: count ? count + " completed or cancelled match(es) cleared from the admin list. Match and wallet records are preserved." : "There are no settled matches to clear." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Admin bulk match clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear settled matches." });
        } finally {
            client.release();
        }
    });

    router.post("/:game/:id/cancel-refund", authenticateToken, adminOnly, async (req, res) => {
        const game = String(req.params.game || "").toLowerCase();
        const matchId = validId(req.params.id);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        if (!["chess", "konami"].includes(game) || !matchId) {
            return res.status(400).json({ success: false, message: "Invalid match." });
        }
        if (reason.length < 10) {
            return res.status(400).json({ success: false, message: "Enter an admin reason of at least 10 characters." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const table = game === "chess" ? "chess_matches" : "efootball_matches";
            const found = await client.query("SELECT * FROM " + table + " WHERE id=$1 FOR UPDATE", [matchId]);
            if (!found.rows.length) throw Object.assign(new Error("Match not found."), { status: 404 });
            const match = found.rows[0];
            if (match.settled_at || !(game === "chess" ? CHESS_ACTIVE : KONAMI_ACTIVE).has(String(match.status))) {
                throw Object.assign(new Error("Only an unsettled, active match can be cancelled here."), { status: 409 });
            }
            if (game === "chess" && match.match_type === "tournament") {
                throw Object.assign(new Error("Chess tournament stakes are managed by the competition settlement."), { status: 409 });
            }

            const participants = (game === "chess"
                ? [match.player_white_id, match.player_black_id]
                : [match.creator_id, match.opponent_id])
                .filter(value => value != null).map(Number).filter((value, index, values) => value > 0 && values.indexOf(value) === index)
                .sort((a, b) => a - b);
            if (!participants.length) throw Object.assign(new Error("This match has no refundable player."), { status: 409 });

            const stake = Number(match.stake_amount || 0);
            if (!Number.isFinite(stake) || stake < 0) throw new Error("The match stake is invalid.");
            if (stake > 0) {
                const wallets = await client.query(
                    "SELECT user_id,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE",
                    [participants]
                );
                if (wallets.rows.length !== participants.length) throw new Error("A player wallet is missing; the refund was stopped.");
                for (const playerId of participants) {
                    const ref = game === "chess"
                        ? "CHESS-ADMIN-CANCEL-" + matchId + "-" + playerId
                        : "EF-ADMIN-CANCEL-" + matchId + "-" + playerId;
                    const oldReferences = game === "chess"
                        ? [ref, "CHESS-CANCEL-" + matchId + "-" + playerId,
                           "DRAW-" + matchId + "-" + (Number(match.player_white_id) === playerId ? "W" : "B")]
                        : [ref, "EF-CANCEL-" + matchId + "-" + playerId,
                           "EF-ADMIN-REFUND-" + matchId + "-" + playerId,
                           "EF-SEARCH-EXPIRED-" + matchId, "EF-DRAW-" + matchId + "-" + playerId];
                    const oldRefund = await client.query(
                        "SELECT id FROM transactions WHERE user_id=$1 AND transaction_type='match_refund' AND reference=ANY($2::text[]) LIMIT 1",
                        [playerId, oldReferences]
                    );
                    if (oldRefund.rows.length) throw Object.assign(new Error("A refund is already recorded for this player and match."), { status: 409 });
                    const unlocked = await client.query(
                        `UPDATE wallets SET locked_balance=locked_balance-$1,balance=balance+$1,updated_at=NOW()
                          WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`,
                        [stake, playerId]
                    );
                    if (!unlocked.rows.length) throw new Error("A player's locked stake is insufficient; the refund was stopped.");
                    await client.query(
                        `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                         VALUES($1,'match_refund',$2,'KES','completed',$3,$4)`,
                        [playerId, stake, ref, "Administrator cancelled " + (game === "chess" ? "Chess" : "eFootball") + " match #" + matchId + "; locked stake refunded."]
                    );
                }
            }

            if (game === "chess") {
                await client.query(
                    `UPDATE chess_matches SET status='cancelled',result='admin_cancelled',winner_id=NULL,
                            finished_at=NOW(),settled_at=NOW(),payout_status='refunded',draw_offer_user_id=NULL
                      WHERE id=$1`, [matchId]
                );
            } else {
                await client.query(
                    `UPDATE efootball_matches SET status='cancelled',result_status='admin_cancelled',winner_id=NULL,
                            finished_at=NOW(),settled_at=NOW(),search_last_seen_at=NULL,
                            creator_ready=FALSE,opponent_ready=FALSE,external_room_code=NULL,code_sent=FALSE,
                            code_sender_id=NULL,code_received_at=NULL,code_received_by=NULL,
                            code_correction_requested_at=NULL,code_correction_requested_by=NULL
                      WHERE id=$1`, [matchId]
                );
                if (match.tournament_fixture_id) {
                    const reset = await client.query(
                        `UPDATE efootball_tournament_fixtures
                            SET status='scheduled',match_id=NULL,home_score=NULL,away_score=NULL,winner_id=NULL,resolved_at=NULL
                          WHERE id=$1 AND match_id=$2 AND status IN ('scheduled','playing','disputed') RETURNING id,tournament_id,round_number`,
                        [match.tournament_fixture_id, matchId]
                    );
                    if (!reset.rows.length) throw Object.assign(new Error("The tournament fixture changed; cancellation was stopped."), { status: 409 });
                    await client.query("UPDATE efootball_tournament_rounds SET completed_at=NULL WHERE tournament_id=$1 AND round_number=$2", [reset.rows[0].tournament_id, reset.rows[0].round_number]);
                }
                if (match.league_fixture_id) {
                    const reset = await client.query(
                        `UPDATE efootball_league_fixtures
                            SET status='scheduled',match_id=NULL,home_score=NULL,away_score=NULL,winner_id=NULL,resolved_at=NULL
                          WHERE id=$1 AND match_id=$2 AND status IN ('scheduled','playing','disputed') RETURNING id,league_id,round_number`,
                        [match.league_fixture_id, matchId]
                    );
                    if (!reset.rows.length) throw Object.assign(new Error("The league fixture changed; cancellation was stopped."), { status: 409 });
                    await client.query("UPDATE efootball_league_rounds SET completed_at=NULL WHERE league_id=$1 AND round_number=$2", [reset.rows[0].league_id, reset.rows[0].round_number]);
                }
                for (const playerId of participants) {
                    await client.query(
                        `INSERT INTO system_notifications(user_id,type,title,message,match_id)
                         VALUES($1,'match_cancelled','Match cancelled',$2,$3)`,
                        [playerId, stake > 0 ? "An administrator cancelled this match. Your locked stake was refunded." : "An administrator cancelled this match.", matchId]
                    );
                }
            }
            await audit(client, game, matchId, req.user.userId, "cancel_refund", reason, { participants, stake });
            await client.query("COMMIT");
            return res.json({ success: true, message: stake > 0 ? "Match cancelled and locked stakes refunded." : "Match cancelled. No match stake was locked.", refundedPlayers: stake > 0 ? participants.length : 0 });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || 500;
            if (status === 500) console.error("Admin match cancellation failed:", error.message);
            return res.status(status).json({ success: false, message: status === 500 ? "Could not safely cancel and refund this match." : error.message });
        } finally {
            client.release();
        }
    });

    router.post("/konami/:id/scores", authenticateToken, adminOnly, async (req, res) => {
        const matchId = validId(req.params.id);
        const creatorScore = Number(req.body && req.body.creatorScore);
        const opponentScore = Number(req.body && req.body.opponentScore);
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        if (!matchId || !Number.isInteger(creatorScore) || !Number.isInteger(opponentScore) ||
            creatorScore < 0 || opponentScore < 0 || creatorScore > 99 || opponentScore > 99) {
            return res.status(400).json({ success: false, message: "Enter two whole scores from 0 to 99." });
        }
        if (reason.length < 10) return res.status(400).json({ success: false, message: "Enter an admin reason of at least 10 characters." });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const found = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!found.rows.length) throw Object.assign(new Error("eFootball match not found."), { status: 404 });
            const match = found.rows[0];
            if (!canEditScore(Object.assign({ game: "konami" }, match))) {
                throw Object.assign(new Error("Only an unsettled, started match can receive an administrator score."), { status: 409 });
            }
            const settlement = await settleEfootballMatch(client, match, { creatorScore, opponentScore }, req.user.userId);
            if (match.tournament_fixture_id) {
                const fixture = await client.query("SELECT * FROM efootball_tournament_fixtures WHERE id=$1 FOR UPDATE", [match.tournament_fixture_id]);
                if (fixture.rows[0]) {
                    const f = fixture.rows[0];
                    const homeScore = Number(f.home_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                    const awayScore = Number(f.away_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                    await client.query("UPDATE efootball_tournament_fixtures SET status='completed',home_score=$1,away_score=$2,winner_id=$3,resolved_at=NOW() WHERE id=$4", [homeScore, awayScore, settlement.winnerId, f.id]);
                }
            }
            if (match.league_fixture_id) {
                const fixture = await client.query("SELECT * FROM efootball_league_fixtures WHERE id=$1 FOR UPDATE", [match.league_fixture_id]);
                if (fixture.rows[0]) {
                    const f = fixture.rows[0];
                    const homeScore = Number(f.home_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                    const awayScore = Number(f.away_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                    await client.query("UPDATE efootball_league_fixtures SET status='completed',home_score=$1,away_score=$2,winner_id=$3,resolved_at=NOW() WHERE id=$4", [homeScore, awayScore, settlement.winnerId, f.id]);
                }
            }
            await client.query(
                `UPDATE efootball_result_verifications
                    SET status='verified',score_check='admin_verified',review_note=$1,reviewed_by=$2,reviewed_at=NOW()
                  WHERE match_id=$3`, [reason, req.user.userId, matchId]
            );
            await audit(client, "konami", matchId, req.user.userId, "scores_set", reason, { creatorScore, opponentScore, winnerId: settlement.winnerId });
            for (const playerId of [Number(match.creator_id), Number(match.opponent_id)].filter(Boolean)) {
                await client.query(
                    `INSERT INTO system_notifications(user_id,type,title,message,match_id)
                     VALUES($1,'match_result_settled','Match result settled',$2,$3)`,
                    [playerId, "An administrator recorded the verified score " + creatorScore + "–" + opponentScore + ".", matchId]
                );
            }
            await client.query("COMMIT");
            return res.json({ success: true, message: "Score recorded; wallet settlement and competition standings were updated." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || 500;
            if (status === 500) console.error("Admin match score update failed:", error.message);
            return res.status(status).json({ success: false, message: status === 500 ? "Could not safely record this score." : error.message });
        } finally {
            client.release();
        }
    });

    router.post("/chess/:id/result", authenticateToken, adminOnly, async (req, res) => {
        const matchId = validId(req.params.id);
        const result = String(req.body && req.body.result || "").toLowerCase();
        const reason = String(req.body && req.body.reason || "").trim().slice(0, 1000);
        if (!matchId || !["white_win", "black_win", "draw"].includes(result)) {
            return res.status(400).json({ success: false, message: "Choose White wins, Black wins, or Draw." });
        }
        if (reason.length < 10) return res.status(400).json({ success: false, message: "Enter an admin reason of at least 10 characters." });
        try {
            const found = await pool.query(
                "SELECT player_white_id,player_black_id,status,settled_at FROM chess_matches WHERE id=$1",
                [matchId]
            );
            if (!found.rows.length) return res.status(404).json({ success: false, message: "Chess match not found." });
            const match = found.rows[0];
            if (match.status !== "active" || match.settled_at || match.player_black_id == null) {
                return res.status(409).json({ success: false, message: "Only an unsettled Chess game with both players can receive an administrator result." });
            }
            const winnerId = result === "white_win" ? Number(match.player_white_id) :
                result === "black_win" ? Number(match.player_black_id) : null;
            const settlement = await settleChessMatch(pool, matchId, result, winnerId, {
                adminId: req.user.userId,
                reason: reason
            });
            if (settlement.alreadySettled) {
                return res.status(409).json({ success: false, message: "This Chess match was settled by another action." });
            }
            return res.json({ success: true, message: "Chess result recorded; wallet settlement and rating updates were applied." });
        } catch (error) {
            console.error("Admin Chess result update failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not safely record this Chess result." });
        }
    });

    async function setVisibility(req, res, clear) {
        const game = String(req.params.game || "").toLowerCase();
        const matchId = validId(req.params.id);
        if (!["chess", "konami"].includes(game) || !matchId) {
            return res.status(400).json({ success: false, message: "Invalid match." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const table = game === "chess" ? "chess_matches" : "efootball_matches";
            const found = await client.query("SELECT id,status,settled_at,admin_cleared_at FROM " + table + " WHERE id=$1 FOR UPDATE", [matchId]);
            if (!found.rows.length) throw Object.assign(new Error("Match not found."), { status: 404 });
            const match = found.rows[0];
            if (!TERMINAL.has(String(match.status)) || !match.settled_at) {
                throw Object.assign(new Error("Only a completed or cancelled, settled match can be cleared."), { status: 409 });
            }
            await client.query(
                "UPDATE " + table + " SET admin_cleared_at=$1,admin_cleared_by=$2 WHERE id=$3",
                [clear ? new Date() : null, clear ? req.user.userId : null, matchId]
            );
            await audit(client, game, matchId, req.user.userId, clear ? "cleared" : "restored", null, {});
            await client.query("COMMIT");
            return res.json({ success: true, message: clear ? "Match cleared from the default admin list. Its record remains saved." : "Match restored to the admin list." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || 500;
            if (status === 500) console.error("Admin match visibility update failed:", error.message);
            return res.status(status).json({ success: false, message: status === 500 ? "Could not update the match list." : error.message });
        } finally {
            client.release();
        }
    }

    router.post("/:game/:id/clear", authenticateToken, adminOnly, (req, res) => setVisibility(req, res, true));
    router.post("/:game/:id/restore", authenticateToken, adminOnly, (req, res) => setVisibility(req, res, false));

    return router;
};
