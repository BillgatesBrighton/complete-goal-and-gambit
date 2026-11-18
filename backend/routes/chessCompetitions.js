"use strict";

const express = require("express");
const crypto = require("crypto");
const { settleClosedChessTournamentSeasons } = require("../services/chessTournamentPayouts");
const { creditPlatform } = require("../services/adminWalletAccounting");
const { recordJournal } = require("../services/financialLedger");
const { lockActiveAuthSession } = require("../services/authSession");
const { currentChessSeason, lockChessTournamentGroup } = require("../services/chessTournamentSync");

const SUPPORTED_TIME_CONTROLS = new Set(["10+5", "3+2", "1+1"]);

function chessStandingSql(matchType) {
    return `
        WITH player_results AS (
            SELECT m.player_white_id AS user_id,
                   CASE WHEN m.result = 'draw' THEN 'draw'
                        WHEN m.winner_id = m.player_white_id THEN 'win' ELSE 'loss' END AS outcome
              FROM chess_matches m
             WHERE m.match_type = $1
               AND m.status = 'completed'
               AND m.result IS DISTINCT FROM 'no_contest'
               AND ($1 = 'tournament' OR COALESCE(m.finished_at, m.created_at) >= date_trunc('month', NOW()))
               AND m.player_white_id IS NOT NULL
               AND m.player_black_id IS NOT NULL
               AND ($2::varchar IS NULL OR m.time_control = $2)
               AND ($3::numeric IS NULL OR m.stake_amount = $3)
               AND ($1 <> 'tournament' OR m.season_key=$4)
            UNION ALL
            SELECT m.player_black_id AS user_id,
                   CASE WHEN m.result = 'draw' THEN 'draw'
                        WHEN m.winner_id = m.player_black_id THEN 'win' ELSE 'loss' END AS outcome
              FROM chess_matches m
             WHERE m.match_type = $1
               AND m.status = 'completed'
               AND m.result IS DISTINCT FROM 'no_contest'
               AND ($1 = 'tournament' OR COALESCE(m.finished_at, m.created_at) >= date_trunc('month', NOW()))
               AND m.player_white_id IS NOT NULL
               AND m.player_black_id IS NOT NULL
               AND ($2::varchar IS NULL OR m.time_control = $2)
               AND ($3::numeric IS NULL OR m.stake_amount = $3)
               AND ($1 <> 'tournament' OR m.season_key=$4)
        ), participants AS (
            SELECT r.user_id FROM player_results r
             WHERE $1 <> 'tournament' OR EXISTS (
                SELECT 1 FROM chess_tournament_entries e
                 WHERE e.user_id=r.user_id
                   AND e.season_key=$4
                   AND e.time_control=$2 AND e.stake_amount=$3
                   AND e.cancelled_at IS NULL AND e.forfeited_at IS NULL
             )
            UNION
            SELECT user_id FROM chess_tournament_entries
             WHERE $1='tournament'
               AND season_key=$4
               AND ($2::varchar IS NULL OR time_control=$2)
               AND ($3::numeric IS NULL OR stake_amount=$3)
               AND cancelled_at IS NULL AND forfeited_at IS NULL
        )
        SELECT u.id AS user_id,
               u.username,
               COALESCE(u.rating, 1200)::int AS rating,
               COUNT(r.user_id)::int AS played,
               COUNT(*) FILTER (WHERE r.outcome = 'win')::int AS wins,
               COUNT(*) FILTER (WHERE r.outcome = 'draw')::int AS draws,
               COUNT(*) FILTER (WHERE r.outcome = 'loss')::int AS losses,
               (COUNT(*) FILTER (WHERE r.outcome = 'win') * 3 +
                COUNT(*) FILTER (WHERE r.outcome = 'draw'))::int AS points
          FROM participants p
          JOIN users u ON u.id = p.user_id
          LEFT JOIN player_results r ON r.user_id = p.user_id
         GROUP BY u.id, u.username, u.rating
         ORDER BY points DESC, wins DESC, rating DESC, u.username ASC
         LIMIT 100`;
}

module.exports = function (pool, authenticateToken) {
    const router = express.Router();
    let settlementBusy = false;
    const settlementTimer = setInterval(async function() {
        if (settlementBusy) return;
        settlementBusy = true;
        try { await settleClosedChessTournamentSeasons(pool); }
        finally { settlementBusy = false; }
    }, 60000);
    if (typeof settlementTimer.unref === "function") settlementTimer.unref();

    router.post("/tournament/entry", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const timeControl = String(req.body && req.body.timeControl || "");
        const stake = Number(req.body && req.body.stake);
        if (!Number.isSafeInteger(userId) || userId < 1 || !SUPPORTED_TIME_CONTROLS.has(timeControl) || ![20, 50, 100].includes(stake)) {
            return res.status(400).json({ success: false, message: "Choose a supported chess tournament clock and entry stake." });
        }
        let client;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            if (!(await lockActiveAuthSession(client, req.user))) {
                throw Object.assign(new Error("Authentication session is no longer active."), { status: 401 });
            }
            const seasonKey = await currentChessSeason(client);
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["goal-gambit-chess-user:" + userId]);
            await lockChessTournamentGroup(client, seasonKey, timeControl, stake, "shared");
            if (await currentChessSeason(client) !== seasonKey) {
                throw Object.assign(new Error("This tournament season just changed. Please try again."), { status: 409 });
            }
            const account = await client.query(
                "SELECT game,account_status FROM users WHERE id=$1",
                [userId]
            );
            if (!account.rows.length || account.rows[0].account_status !== "active") {
                throw Object.assign(new Error("Your account cannot enter a chess tournament."), { status: 403 });
            }
            if (!["chess", "both"].includes(account.rows[0].game)) {
                throw Object.assign(new Error("Your account is not registered for Chess."), { status: 403 });
            }
            const inserted = await client.query(
                `INSERT INTO chess_tournament_entries(season_key,time_control,stake_amount,user_id)
                 VALUES($1,$2,$3,$4)
                 ON CONFLICT(season_key,time_control,stake_amount,user_id) DO UPDATE
                    SET cancelled_at=NULL
                  WHERE chess_tournament_entries.forfeited_at IS NULL
                 RETURNING id`,
                [seasonKey, timeControl, stake, userId]
            );
            if (!inserted.rows.length) {
                throw Object.assign(new Error("You have forfeited this chess tournament for the current month."), { status: 409 });
            }
            await client.query("COMMIT");
            return res.json({
                success: true,
                alreadyEntered: inserted.rowCount === 0,
                message: "You are on the live tournament table. Your match stake is locked only when you join a game."
            });
        } catch (error) {
            if (client) await client.query("ROLLBACK").catch(() => {});
            if (Number(error.status) >= 400 && Number(error.status) < 500) {
                return res.status(error.status).json({ success: false, message: error.message });
            }
            console.error("Chess tournament entry error:", error.message);
            return res.status(500).json({ success: false, message: "Could not add you to the chess tournament table." });
        } finally {
            if (client) client.release();
        }
    });

    router.get("/tournament/entry", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const timeControl = String(req.query.timeControl || "");
        const stake = Number(req.query.stake);
        if (!Number.isSafeInteger(userId) || userId < 1 || !SUPPORTED_TIME_CONTROLS.has(timeControl) || ![20, 50, 100].includes(stake)) {
            return res.status(400).json({ success: false, message: "Choose a supported chess tournament clock and entry stake." });
        }
        try {
            const seasonKey = await pool.query("SELECT TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM') AS season_key");
            const season = seasonKey.rows[0].season_key;
            const entryResult = await pool.query(
                `SELECT id,cancelled_at,forfeited_at,forfeited_amount
                   FROM chess_tournament_entries
                  WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND user_id=$4`,
                [season,timeControl,stake,userId]
            );
            const entry = entryResult.rows[0] || null;
            if (!entry || entry.cancelled_at || entry.forfeited_at) {
                return res.json({
                    success: true,
                    joined: false,
                    forfeited: Boolean(entry && entry.forfeited_at),
                    canCancel: false,
                    canForfeit: false,
                    forfeitedAmount: Number(entry && entry.forfeited_amount || 0)
                });
            }
            const matchResult = await pool.query(
                `SELECT id,status,result,started_at,finished_at
                   FROM chess_matches
                  WHERE match_type='tournament' AND time_control=$1 AND stake_amount=$2
                    AND season_key=$3
                    AND (player_white_id=$4 OR player_black_id=$4)
                  ORDER BY id DESC`,
                [timeControl,stake,season,userId]
            );
            const matches = matchResult.rows;
            const hasStartedMatch = matches.some(match =>
                Boolean(match.started_at) || ["active","settling"].includes(String(match.status)) ||
                (String(match.status)==="completed" && match.result!=="no_contest")
            );
            const hasCompletedMatch = matches.some(match => String(match.status) === "completed" && match.result!=="no_contest");
            const hasUnresolvedMatch = matches.some(match =>
                ["active","settling"].includes(String(match.status)) ||
                (Boolean(match.started_at) && !["completed","cancelled"].includes(String(match.status)))
            );
            return res.json({
                success: true,
                joined: true,
                canCancel: !hasStartedMatch,
                canForfeit: hasCompletedMatch && !hasUnresolvedMatch,
                forfeitedAmount: Number(entry.forfeited_amount || 0),
                waitingMatchId: Number((matches.find(match => match.status === "waiting") || {}).id || 0) || null,
                activeMatchId: Number((matches.find(match => match.status === "active") || {}).id || 0) || null
            });
        } catch (error) {
            console.error("Chess tournament entry status error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load your chess tournament entry." });
        }
    });

    router.get("/tournament/entries", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        if (!Number.isSafeInteger(userId) || userId < 1) {
            return res.status(401).json({ success: false, message: "Sign in to view your chess tournaments." });
        }
        res.set("Cache-Control", "no-store");
        try {
            const result = await pool.query(
                `SELECT e.time_control,e.stake_amount,e.joined_at,
                        activity.id AS match_id,activity.status AS match_status
                   FROM chess_tournament_entries e
                   LEFT JOIN LATERAL (
                       SELECT m.id,m.status
                         FROM chess_matches m
                        WHERE m.match_type='tournament' AND m.time_control=e.time_control
                          AND m.stake_amount=e.stake_amount
                          AND m.season_key=e.season_key
                          AND (m.player_white_id=e.user_id OR m.player_black_id=e.user_id)
                          AND m.status IN ('waiting','active','settling')
                        ORDER BY m.id DESC LIMIT 1
                   ) activity ON TRUE
                 WHERE e.season_key=TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM')
                    AND e.user_id=$1 AND e.cancelled_at IS NULL AND e.forfeited_at IS NULL
                  ORDER BY e.joined_at DESC,e.time_control,e.stake_amount`,
                [userId]
            );
            return res.json({ success: true, season: "current_month", entries: result.rows.map(row => ({
                timeControl: String(row.time_control),
                stake: Number(row.stake_amount),
                joinedAt: row.joined_at,
                matchId: row.match_id === null ? null : Number(row.match_id),
                matchStatus: row.match_status || null
            })) });
        } catch (error) {
            console.error("Chess tournament dashboard list error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load your active chess tournaments." });
        }
    });

    router.post("/tournament/entry/cancel", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const timeControl = String(req.body && req.body.timeControl || "");
        const stake = Number(req.body && req.body.stake);
        if (!Number.isSafeInteger(userId) || userId < 1 || !SUPPORTED_TIME_CONTROLS.has(timeControl) || ![20, 50, 100].includes(stake)) {
            return res.status(400).json({ success: false, message: "Choose a supported chess tournament clock and entry stake." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            if (!(await lockActiveAuthSession(client, req.user))) {
                throw Object.assign(new Error("Authentication session is no longer active."), { status: 401 });
            }
            const currentSeason = await currentChessSeason(client);
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["goal-gambit-chess-user:" + userId]);
            await lockChessTournamentGroup(client, currentSeason, timeControl, stake, "shared");
            if (await currentChessSeason(client) !== currentSeason) {
                throw Object.assign(new Error("This tournament season just changed. Please retry in the current season."), { status: 409 });
            }
            const entryResult = await client.query(
                `SELECT * FROM chess_tournament_entries
                  WHERE season_key=$1
                    AND time_control=$2 AND stake_amount=$3 AND user_id=$4 FOR UPDATE`,
                [currentSeason,timeControl,stake,userId]
            );
            if (!entryResult.rows.length || entryResult.rows[0].cancelled_at) {
                const error = Object.assign(new Error("You have not joined this chess tournament."), { status: 404 });
                throw error;
            }
            if (entryResult.rows[0].forfeited_at) {
                const error = Object.assign(new Error("A forfeited chess tournament entry cannot be cancelled or refunded."), { status: 409 });
                throw error;
            }
            const season = entryResult.rows[0].season_key;
            const matches = await client.query(
                `SELECT * FROM chess_matches
                  WHERE match_type='tournament' AND time_control=$1 AND stake_amount=$2
                    AND season_key=$3
                    AND (player_white_id=$4 OR player_black_id=$4)
                    AND status IN ('waiting','active','settling','completed')
                  ORDER BY id FOR UPDATE`,
                [timeControl,stake,season,userId]
            );
            const started = matches.rows.some(match =>
                Boolean(match.started_at) || ["active","settling"].includes(String(match.status)) ||
                (String(match.status)==="completed" && match.result!=="no_contest")
            );
            if (started) {
                const error = Object.assign(new Error("Your first tournament match has started. Use Forfeit tournament instead."), { status: 409 });
                throw error;
            }
            const waitingMatches = matches.rows.filter(match => match.status === "waiting");
            const waitingPlayerIds = Array.from(new Set(waitingMatches.flatMap(match =>
                [Number(match.player_white_id), Number(match.player_black_id)].filter(id => Number.isSafeInteger(id) && id > 0)
            ))).sort((a,b)=>a-b);
            if (waitingPlayerIds.length) {
                await client.query("SELECT user_id FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE", [waitingPlayerIds]);
            }
            let refunded = 0;
            let refundedToOpponent = 0;
            for (const match of waitingMatches) {
                const participants = [Number(match.player_white_id), Number(match.player_black_id)].filter(id=>Number.isSafeInteger(id)&&id>0);
                const amount = Number(match.stake_amount || 0);
                for (const participantId of participants) {
                    if (amount > 0) {
                        const wallet = await client.query(
                            `UPDATE wallets SET balance=balance+$1,locked_balance=locked_balance-$1,updated_at=NOW()
                              WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`,
                            [amount,participantId]
                        );
                        if (wallet.rowCount !== 1) throw new Error("A locked tournament stake could not be refunded safely.");
                        const reference = `CHESS-TOURN-CANCEL-${match.id}-${participantId}`;
                        await client.query(
                            `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                             VALUES($1,'match_refund',$2,'KES','completed',$3,$4)`,
                            [participantId,amount,reference,`Chess ${timeControl} tournament search cancelled and stake refunded`]
                        );
                        await recordJournal(client, {
                            reference: `${reference}-JOURNAL`,
                            transactionType: "chess_tournament_search_refund",
                            amount,
                            description: `Chess ${timeControl} tournament search cancelled and stake refunded`,
                            context: { userId: participantId, matchId: Number(match.id), seasonKey: season },
                            postings: [
                                { accountType: "chess_match_locked", accountId: participantId, debit: amount },
                                { accountType: "user_wallet_available", accountId: participantId, credit: amount }
                            ]
                        });
                    }
                    if (participantId === userId) refunded += amount;
                    else refundedToOpponent += amount;
                    await client.query(
                        `UPDATE chess_match_financial_dispositions
                            SET disposition='refunded',reference=$3,settled_at=NOW()
                          WHERE match_id=$1 AND user_id=$2 AND disposition='pending'`,
                        [match.id,participantId,`CHESS-TOURN-CANCEL-${match.id}-${participantId}`]
                    );
                }
                await client.query(
                    `UPDATE chess_matches SET status='cancelled',finished_at=NOW(),settled_at=NOW(),payout_status='refunded'
                      WHERE id=$1 AND status='waiting'`,
                    [match.id]
                );
            }
            await client.query(
                `UPDATE chess_tournament_entries SET cancelled_at=NOW()
                  WHERE id=$1 AND cancelled_at IS NULL AND forfeited_at IS NULL`,
                [entryResult.rows[0].id]
            );
            await client.query("COMMIT");
            return res.json({
                success: true,
                refunded,
                message: refunded > 0
                    ? "Tournament entry cancelled. KSh " + refunded.toFixed(2) + " was returned to your available wallet balance." + (refundedToOpponent > 0 ? " The paired opponent's KSh " + refundedToOpponent.toFixed(2) + " stake was also returned because the scheduled match was cancelled." : "")
                    : "Tournament entry cancelled. No tournament match stake had been locked."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (Number(error.status) >= 400 && Number(error.status) < 500) return res.status(error.status).json({ success: false, message: error.message });
            console.error("Chess tournament cancellation error:", error.message);
            return res.status(500).json({ success: false, message: "Could not cancel your chess tournament entry safely." });
        } finally {
            client.release();
        }
    });

    router.post("/tournament/entry/forfeit", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const timeControl = String(req.body && req.body.timeControl || "");
        const stake = Number(req.body && req.body.stake);
        if (!Number.isSafeInteger(userId) || userId < 1 || !SUPPORTED_TIME_CONTROLS.has(timeControl) || ![20, 50, 100].includes(stake)) {
            return res.status(400).json({ success: false, message: "Choose a supported chess tournament clock and entry stake." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            if (!(await lockActiveAuthSession(client, req.user))) {
                throw Object.assign(new Error("Authentication session is no longer active."), { status: 401 });
            }
            const season = await currentChessSeason(client);
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["goal-gambit-chess-user:" + userId]);
            await lockChessTournamentGroup(client, season, timeControl, stake, "shared");
            const entryResult = await client.query(
                `SELECT * FROM chess_tournament_entries
                  WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND user_id=$4 FOR UPDATE`,
                [season,timeControl,stake,userId]
            );
            if (!entryResult.rows.length || entryResult.rows[0].cancelled_at) {
                const error = Object.assign(new Error("You have not joined this chess tournament."), { status: 404 });
                throw error;
            }
            if (entryResult.rows[0].forfeited_at) {
                const error = Object.assign(new Error("You have already forfeited this chess tournament."), { status: 409 });
                throw error;
            }
            const matches = await client.query(
                `SELECT * FROM chess_matches
                  WHERE match_type='tournament' AND time_control=$1 AND stake_amount=$2
                    AND season_key=$3
                    AND (player_white_id=$4 OR player_black_id=$4)
                    AND status IN ('waiting','active','settling','completed')
                  ORDER BY id FOR UPDATE`,
                [timeControl,stake,season,userId]
            );
            const hasCompletedMatch = matches.rows.some(match => String(match.status) === "completed" && match.result!=="no_contest");
            if (!hasCompletedMatch) {
                const error = Object.assign(new Error("Forfeit becomes available after your first tournament match is completed. Cancel before then to receive any locked search stake back."), { status: 409 });
                throw error;
            }
            const unresolved = matches.rows.find(match =>
                ["active","settling"].includes(String(match.status)) ||
                (Boolean(match.started_at) && !["completed","cancelled"].includes(String(match.status)))
            );
            if (unresolved) {
                const error = Object.assign(new Error("Finish or resolve your current tournament match before forfeiting."), { status: 409 });
                throw error;
            }
            const waitingMatches = matches.rows.filter(match => match.status === "waiting");
            const affectedWalletIds = Array.from(new Set([userId, ...waitingMatches.flatMap(match =>
                [Number(match.player_white_id),Number(match.player_black_id)].filter(id=>Number.isSafeInteger(id)&&id>0)
            )])).sort((a,b)=>a-b);
            await client.query("SELECT user_id FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE", [affectedWalletIds]);
            for (const match of waitingMatches) {
                const opponents = [Number(match.player_white_id),Number(match.player_black_id)].filter(id=>Number.isSafeInteger(id)&&id>0&&id!==userId);
                const amount = Number(match.stake_amount || 0);
                for (const opponentId of opponents) {
                    if (amount > 0) {
                        const wallet = await client.query(
                            `UPDATE wallets SET balance=balance+$1,locked_balance=locked_balance-$1,updated_at=NOW()
                              WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`, [amount,opponentId]
                        );
                        if (wallet.rowCount !== 1) throw new Error("The paired opponent's locked tournament stake could not be refunded safely.");
                        const refundReference = `CHESS-TOURN-FORFEIT-OPPONENT-${match.id}-${opponentId}`;
                        await client.query(
                            `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                             VALUES($1,'match_refund',$2,'KES','completed',$3,$4)`,
                            [opponentId,amount,refundReference,"Chess tournament search cancelled after the other entry was forfeited"]
                        );
                        await recordJournal(client, {
                            reference: refundReference + "-JOURNAL",transactionType:"chess_tournament_search_refund",
                            amount,description:"Chess tournament search cancelled after the other entry was forfeited",
                            context:{userId:opponentId,matchId:Number(match.id),seasonKey:season},
                            postings:[
                                {accountType:"chess_match_locked",accountId:opponentId,debit:amount},
                                {accountType:"user_wallet_available",accountId:opponentId,credit:amount}
                            ]
                        });
                    }
                    await client.query(
                        `UPDATE chess_match_financial_dispositions
                            SET disposition='refunded',reference=$3,settled_at=NOW()
                          WHERE match_id=$1 AND user_id=$2 AND disposition='pending'`,
                        [match.id,opponentId,`CHESS-TOURN-FORFEIT-OPPONENT-${match.id}-${opponentId}`]
                    );
                }
            }
            const contributions = await client.query(
                `SELECT COALESCE(SUM(d.stake_amount),0)::numeric AS amount
                   FROM chess_match_financial_dispositions d
                   JOIN chess_matches m ON m.id=d.match_id
                  WHERE d.user_id=$1 AND d.season_key=$2 AND d.disposition='pending'
                    AND m.match_type='tournament' AND m.time_control=$3 AND m.stake_amount=$4
                    AND ((m.status='completed' AND m.payout_status='pending_competition') OR m.status='waiting')`,
                [userId,season,timeControl,stake]
            );
            let forfeitedAmount = Number(contributions.rows[0].amount || 0);
            forfeitedAmount = Math.round(forfeitedAmount * 100) / 100;

            if (forfeitedAmount > 0) {
                const locked = await client.query(
                    `UPDATE wallets SET locked_balance=locked_balance-$1,updated_at=NOW()
                      WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`,
                    [forfeitedAmount,userId]
                );
                if (!locked.rows.length) throw new Error("The locked tournament stake could not be transferred safely.");
                const reference = `CHESS-TOURN-FORFEIT-${season}-${userId}-${crypto.randomUUID()}`;
                await creditPlatform(client, {
                    amount: forfeitedAmount,
                    reference,
                    transactionType: "chess_tournament_forfeit_stake",
                    description: `Chess ${timeControl} KSh ${stake} tournament forfeited stake`,
                    context: { userId, seasonKey: season, timeControl, stake, forfeiture: true },
                    debitPostings: [{ accountType: "chess_match_locked", accountId: userId, debit: forfeitedAmount }]
                });
                await client.query(
                    `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'chess_tournament_forfeit',$2,'KES','completed',$3,$4)`,
                    [userId,forfeitedAmount,reference,`Chess ${timeControl} KSh ${stake} tournament stake forfeited to admin wallets`]
                );
                await client.query(
                    `UPDATE chess_match_financial_dispositions d
                        SET disposition='admin_forfeited',reference=$1,settled_at=NOW()
                       FROM chess_matches m
                      WHERE d.match_id=m.id AND d.user_id=$2 AND d.disposition='pending'
                        AND d.season_key=$3 AND m.match_type='tournament' AND m.time_control=$4 AND m.stake_amount=$5
                        AND ((m.status='completed' AND m.payout_status='pending_competition') OR m.status='waiting')`,
                    [reference,userId,season,timeControl,stake]
                );
            }
            for (const match of waitingMatches) {
                await client.query(
                    `UPDATE chess_matches SET status='cancelled',finished_at=NOW(),settled_at=NOW(),payout_status='forfeited'
                      WHERE id=$1 AND status='waiting'`, [match.id]
                );
            }
            await client.query(
                `UPDATE chess_matches m SET payout_status='forfeited'
                  WHERE m.match_type='tournament' AND m.season_key=$1 AND m.time_control=$2 AND m.stake_amount=$3
                    AND m.status='completed' AND m.payout_status='pending_competition'
                    AND NOT EXISTS (SELECT 1 FROM chess_match_financial_dispositions d WHERE d.match_id=m.id AND d.disposition='pending')`,
                [season,timeControl,stake]
            );
            await client.query(
                `UPDATE chess_tournament_entries SET forfeited_at=NOW(),forfeited_amount=$1
                  WHERE id=$2 AND forfeited_at IS NULL`,
                [forfeitedAmount,entryResult.rows[0].id]
            );
            await client.query("COMMIT");
            return res.json({
                success: true,
                forfeited: true,
                stakeTransferred: forfeitedAmount,
                message: forfeitedAmount > 0
                    ? "Tournament forfeited. Your KSh " + forfeitedAmount.toFixed(2) + " stake will not be refunded."
                    : "Tournament forfeited. You are removed from this season's standings."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (Number(error.status) >= 400 && Number(error.status) < 500) return res.status(error.status).json({ success: false, message: error.message });
            console.error("Chess tournament forfeiture error:", error.message);
            return res.status(500).json({ success: false, message: "Could not forfeit the chess tournament entry safely." });
        } finally {
            client.release();
        }
    });

    router.get("/league", async function (req, res) {
        res.set("Cache-Control", "no-store");
        try {
            const [standings, fixtures] = await Promise.all([
                pool.query(chessStandingSql("ranked"), ["ranked", null, null, null]),
                pool.query(
                    `SELECT m.id, m.time_control, m.status, m.result, m.winner_id,
                            wu.username AS white_player, bu.username AS black_player,
                            m.created_at, m.started_at, m.finished_at
                       FROM chess_matches m
                       LEFT JOIN users wu ON wu.id = m.player_white_id
                       LEFT JOIN users bu ON bu.id = m.player_black_id
                      WHERE m.match_type = 'ranked'
                        AND m.created_at >= date_trunc('month', NOW())
                        AND m.status IN ('waiting', 'active', 'settling', 'completed')
                      ORDER BY COALESCE(m.finished_at, m.started_at, m.created_at) DESC, m.id DESC
                      LIMIT 50`
                )
            ]);
            return res.json({
                success: true,
                season: "current_month",
                standings: standings.rows,
                fixtures: fixtures.rows.map(row => ({
                    ...row,
                    id: Number(row.id),
                    winner_id: row.winner_id === null ? null : Number(row.winner_id)
                }))
            });
        } catch (error) {
            console.error("Chess league table error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load the chess league table." });
        }
    });

    router.get("/tournament", async function (req, res) {
        res.set("Cache-Control", "no-store");
        const timeControl = String(req.query.timeControl || "10+5");
        const stake = Number(req.query.stake || 20);
        if (!SUPPORTED_TIME_CONTROLS.has(timeControl) || !Number.isFinite(stake) || stake < 0 || stake > 10000) {
            return res.status(400).json({ success: false, message: "Choose a supported tournament clock and stake." });
        }

        try {
            await settleClosedChessTournamentSeasons(pool);
            const seasonKey = await currentChessSeason(pool);
            const [standings, fixtures] = await Promise.all([
                pool.query(chessStandingSql("tournament"), ["tournament", timeControl, stake, seasonKey]),
                pool.query(
                    `SELECT m.id, m.time_control, m.stake_amount, m.status, m.result, m.winner_id,
                            wu.username AS white_player, bu.username AS black_player,
                            m.created_at, m.started_at, m.finished_at,m.season_key,m.scheduled_at,m.deadline_at
                       FROM chess_matches m
                       LEFT JOIN users wu ON wu.id = m.player_white_id
                       LEFT JOIN users bu ON bu.id = m.player_black_id
                      WHERE m.match_type = 'tournament'
                        AND m.time_control = $1
                        AND m.stake_amount = $2
                        AND m.season_key=$3
                        AND m.status IN ('waiting', 'active', 'settling', 'completed')
                      ORDER BY COALESCE(m.finished_at, m.started_at, m.created_at) DESC, m.id DESC
                      LIMIT 50`,
                    [timeControl, stake, seasonKey]
                )
            ]);
            return res.json({
                success: true,
                tournament: { timeControl, stake, season: seasonKey },
                standings: standings.rows,
                fixtures: fixtures.rows.map(row => ({
                    ...row,
                    id: Number(row.id),
                    stake_amount: Number(row.stake_amount),
                    winner_id: row.winner_id === null ? null : Number(row.winner_id)
                }))
            });
        } catch (error) {
            console.error("Chess tournament table error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load chess tournament standings." });
        }
    });

    return router;
};
