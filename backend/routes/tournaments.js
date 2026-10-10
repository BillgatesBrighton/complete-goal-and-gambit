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
                `SELECT tm.user_id, u.username, tm.joined_at,
                        tm.played, tm.wins, tm.draws, tm.losses, tm.points,
                        tm.goal_difference, tm.goals_for, tm.goals_against
                 FROM efootball_tournament_members tm
                 JOIN users u ON u.id = tm.user_id
                 WHERE tm.tournament_id = $1
                 ORDER BY tm.points DESC, tm.goal_difference DESC,
                          tm.goals_for DESC, tm.wins DESC, tm.joined_at, tm.id`,
                [id]
            );

            return res.json({
                success: true,
                tournament: tournament.rows[0],
                standings: standings.rows
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
            if (count.rows[0].players >= capacity) {
                throw httpError(409, "This tournament is full.");
            }

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
                    (tournament_id, user_id, fee_paid)
                 VALUES ($1, $2, $3)`,
                [id, req.user.userId, fee]
            );

            await client.query("COMMIT");
            inTransaction = false;
            return res.status(201).json({
                success: true,
                message: "Joined tournament.",
                entryFee: fee
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
