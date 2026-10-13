"use strict";

const crypto = require("crypto");
const express = require("express");

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function parseId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = function (pool, authenticateToken) {
    const router = express.Router();

    // The listing is user-specific because each card shows whether the
    // signed-in player has already entered.
    router.get("/", authenticateToken, async (req, res) => {
        res.set("Cache-Control", "no-store");
        try {
            const result = await pool.query(
                `SELECT t.id, t.name, t.tier, t.entry_fee, t.max_players,
                        t.status, t.starts_at, t.created_at,
                        COUNT(tm.id)::int AS players,
                        COALESCE(BOOL_OR(tm.user_id = $1), FALSE) AS joined
                 FROM efootball_tournaments t
                 LEFT JOIN efootball_tournament_members tm
                   ON tm.tournament_id = t.id
                 GROUP BY t.id
                 ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
                          t.starts_at NULLS LAST, t.created_at DESC`,
                [req.user.userId]
            );

            return res.json({ success: true, tournaments: result.rows });
        } catch (error) {
            console.error("Tournament list error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Could not load tournaments. Please try again."
            });
        }
    });

    router.get("/:id/status", authenticateToken, async (req, res) => {
        res.set("Cache-Control", "no-store");
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: "Invalid tournament ID." });
        }

        try {
            const tournament = await pool.query(
                `SELECT t.id, t.name, t.tier, t.entry_fee, t.max_players,
                        t.status, t.starts_at, t.created_at,
                        COUNT(tm.id)::int AS players,
                        COALESCE(BOOL_OR(tm.user_id = $2), FALSE) AS joined
                 FROM efootball_tournaments t
                 LEFT JOIN efootball_tournament_members tm
                   ON tm.tournament_id = t.id
                 WHERE t.id = $1
                 GROUP BY t.id`,
                [id, req.user.userId]
            );

            if (!tournament.rows.length) {
                return res.status(404).json({ success: false, message: "Tournament not found." });
            }

            const standings = await pool.query(
                `SELECT tm.user_id, u.username, tm.group_code, tm.joined_at,
                        tm.played, tm.wins, tm.draws, tm.losses, tm.points,
                        tm.goal_difference, tm.goals_for, tm.goals_against
                 FROM efootball_tournament_members tm
                 JOIN users u ON u.id = tm.user_id
                 WHERE tm.tournament_id = $1
                 ORDER BY tm.group_code, tm.points DESC, tm.goal_difference DESC,
                          tm.goals_for DESC, tm.wins DESC, tm.joined_at, tm.id`,
                [id]
            );

            const fixtures = await pool.query(
                `SELECT m.id, m.creator_id AS home_id, m.opponent_id AS away_id,
                        hu.username AS home, au.username AS away, m.status, CASE WHEN m.opponent_id IS NULL OR away_member.group_code = home_member.group_code THEN home_member.group_code ELSE NULL END AS group_code, CASE WHEN m.opponent_id IS NOT NULL AND away_member.group_code IS DISTINCT FROM home_member.group_code THEN 'Other matches' ELSE COALESCE(m.round_name, 'Group ' || home_member.group_code) END AS round_name,
                        CASE WHEN m.status = 'completed' THEN m.creator_score END AS home_score,
                        CASE WHEN m.status = 'completed' THEN m.opponent_score END AS away_score,
                        m.created_at, m.started_at, m.finished_at
                   FROM efootball_matches m
                   JOIN users hu ON hu.id = m.creator_id
                   LEFT JOIN users au ON au.id = m.opponent_id LEFT JOIN efootball_tournament_members home_member ON home_member.tournament_id = m.tournament_id AND home_member.user_id = m.creator_id LEFT JOIN efootball_tournament_members away_member ON away_member.tournament_id = m.tournament_id AND away_member.user_id = m.opponent_id
                  WHERE m.tournament_id = $1
                  ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.id DESC
                  LIMIT 50`,
                [id]
            );

            return res.json({
                success: true,
                tournament: tournament.rows[0],
                standings: standings.rows,
                fixtures: fixtures.rows.map(row => ({
                    ...row,
                    id: Number(row.id),
                    home_id: Number(row.home_id),
                    away_id: row.away_id === null ? null : Number(row.away_id),
                    home_score: row.home_score === null ? null : Number(row.home_score),
                    away_score: row.away_score === null ? null : Number(row.away_score),
                    mine: Number(row.home_id) === Number(req.user.userId) || Number(row.away_id) === Number(req.user.userId)
                }))
            });
        } catch (error) {
            console.error("Tournament status error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Could not load tournament status. Please try again."
            });
        }
    });

    router.post("/:id/join", authenticateToken, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: "Invalid tournament ID." });
        }

        let client;
        let inTransaction = false;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            inTransaction = true;

            const user = await client.query(
                "SELECT game FROM users WHERE id = $1",
                [req.user.userId]
            );
            if (!user.rows.length) {
                throw httpError(401, "Account not found.");
            }
            if (user.rows[0].game === "chess") {
                throw httpError(403, "Your account is registered for Chess only.");
            }

            // Serialize entries for this tournament so two simultaneous joins
            // cannot both take the final place or charge the same player twice.
            const tournamentResult = await client.query(
                `SELECT id, name, entry_fee, max_players, status
                 FROM efootball_tournaments
                 WHERE id = $1
                 FOR UPDATE`,
                [id]
            );
            if (!tournamentResult.rows.length) {
                throw httpError(404, "Tournament not found.");
            }

            const tournament = tournamentResult.rows[0];
            const existing = await client.query(
                `SELECT 1 FROM efootball_tournament_members
                 WHERE tournament_id = $1 AND user_id = $2`,
                [id, req.user.userId]
            );
            if (existing.rows.length) {
                await client.query("COMMIT");
                inTransaction = false;
                return res.json({
                    success: true,
                    alreadyJoined: true,
                    message: "You have already joined this tournament."
                });
            }

            if (tournament.status !== "open") {
                throw httpError(409, "This tournament is closed.");
            }

            const count = await client.query(
                `SELECT COUNT(*)::int AS players
                 FROM efootball_tournament_members
                 WHERE tournament_id = $1`,
                [id]
            );
            const capacity = Number(tournament.max_players);
            if (!Number.isInteger(capacity) || capacity < 1) {
                throw httpError(500, "This tournament has an invalid capacity.");
            }
            if (count.rows[0].players >= capacity) { throw httpError(409, "This tournament is full."); } const groupCount = Math.min(4, Math.max(1, Math.ceil(capacity / 4))); const groupSize = Math.ceil(capacity / groupCount); const groupCounts = await client.query("SELECT group_code, COUNT(*)::int AS players FROM efootball_tournament_members WHERE tournament_id = $1 GROUP BY group_code", [id]); const countsByGroup = new Map(groupCounts.rows.map(row => [row.group_code, Number(row.players)])); let groupCode = null; for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) { const candidateCode = String.fromCharCode(65 + groupIndex); if ((countsByGroup.get(candidateCode) || 0) < groupSize) { groupCode = candidateCode; break; } } if (!groupCode) throw httpError(409, "Tournament groups are full. Please refresh and try again.");

            const fee = Number(tournament.entry_fee || 0);
            if (!Number.isFinite(fee) || fee < 0) {
                throw httpError(500, "This tournament has an invalid entry fee.");
            }

            if (fee > 0) {
                const wallet = await client.query(
                    `UPDATE wallets
                     SET balance = balance - $1,
                         locked_balance = locked_balance + $1,
                         updated_at = NOW()
                     WHERE user_id = $2 AND balance >= $1
                     RETURNING user_id`,
                    [fee, req.user.userId]
                );
                if (!wallet.rows.length) {
                    throw httpError(
                        402,
                        "Insufficient wallet balance. You need KSh " + fee + " to enter this tournament."
                    );
                }

                await client.query(
                    `INSERT INTO transactions
                        (user_id, transaction_type, amount, currency, status, reference, description)
                     VALUES ($1, 'tournament_entry', $2, 'KES', 'completed', $3, $4)`,
                    [
                        req.user.userId,
                        fee,
                        `TOURN-${id}-${req.user.userId}-${crypto.randomUUID()}`,
                        tournament.name + " entry fee"
                    ]
                );
            }

            await client.query(
                `INSERT INTO efootball_tournament_members
                    (tournament_id, user_id, fee_paid, group_code)
                 VALUES ($1, $2, $3, $4)`,
                [id, req.user.userId, fee, groupCode]
            );

            await client.query("COMMIT");
            inTransaction = false;
            return res.status(201).json({
                success: true,
                message: "Joined tournament.",
                entryFee: fee, group: groupCode
            });
        } catch (error) {
            if (client && inTransaction) {
                try { await client.query("ROLLBACK"); } catch (_) {}
            }

            if (error.status) {
                return res.status(error.status).json({ success: false, message: error.message });
            }
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "You have already joined this tournament." });
            }

            console.error("Tournament join error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Could not join the tournament. Please try again."
            });
        } finally {
            if (client) client.release();
        }
    });

    return router;
};
