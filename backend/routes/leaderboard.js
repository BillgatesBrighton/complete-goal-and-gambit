"use strict";

const express = require("express");

module.exports = function (pool) {
    const router = express.Router();

    // GET /api/leaderboard?limit=5
    // Public. Returns real players only, ranked by rating.
    router.get("/", async function (req, res) {
        try {
            let limit = Number(req.query.limit || 10);
            if (!Number.isInteger(limit) || limit < 1) limit = 10;
            limit = Math.min(limit, 50);

            const result = await pool.query(
                `
                SELECT
                    u.id,
                    u.username,
                    u.rating,
                    COUNT(m.id)::int AS games,
                    COUNT(m.id) FILTER (WHERE m.winner_id = u.id)::int AS wins,
                    COALESCE(
                        SUM(m.stake_amount) FILTER (WHERE m.winner_id = u.id),
                        0
                    )::float AS winnings
                FROM users u
                JOIN chess_matches m
                  ON m.status = 'completed'
                 AND (m.player_white_id = u.id OR m.player_black_id = u.id)
                GROUP BY u.id, u.username, u.rating
                ORDER BY u.rating DESC, wins DESC
                LIMIT $1
                `,
                [limit]
            );

            res.json(result.rows);
        } catch (error) {
            console.error("Leaderboard error:", error.message);
            res.status(500).json({
                success: false,
                message: "Failed to load leaderboard."
            });
        }
    });

    return router;
};
