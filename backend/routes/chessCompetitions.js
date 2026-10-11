"use strict";

const express = require("express");

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
               AND COALESCE(m.finished_at, m.created_at) >= date_trunc('month', NOW())
               AND m.player_white_id IS NOT NULL
               AND m.player_black_id IS NOT NULL
               AND ($2::varchar IS NULL OR m.time_control = $2)
               AND ($3::numeric IS NULL OR m.stake_amount = $3)
            UNION ALL
            SELECT m.player_black_id AS user_id,
                   CASE WHEN m.result = 'draw' THEN 'draw'
                        WHEN m.winner_id = m.player_black_id THEN 'win' ELSE 'loss' END AS outcome
              FROM chess_matches m
             WHERE m.match_type = $1
               AND m.status = 'completed'
               AND COALESCE(m.finished_at, m.created_at) >= date_trunc('month', NOW())
               AND m.player_white_id IS NOT NULL
               AND m.player_black_id IS NOT NULL
               AND ($2::varchar IS NULL OR m.time_control = $2)
               AND ($3::numeric IS NULL OR m.stake_amount = $3)
        )
        SELECT u.id AS user_id,
               u.username,
               COALESCE(u.rating, 1200)::int AS rating,
               COUNT(*)::int AS played,
               COUNT(*) FILTER (WHERE p.outcome = 'win')::int AS wins,
               COUNT(*) FILTER (WHERE p.outcome = 'draw')::int AS draws,
               COUNT(*) FILTER (WHERE p.outcome = 'loss')::int AS losses,
               (COUNT(*) FILTER (WHERE p.outcome = 'win') * 3 +
                COUNT(*) FILTER (WHERE p.outcome = 'draw'))::int AS points
          FROM player_results p
          JOIN users u ON u.id = p.user_id
         GROUP BY u.id, u.username, u.rating
         ORDER BY points DESC, wins DESC, rating DESC, u.username ASC
         LIMIT 100`;
}

module.exports = function (pool) {
    const router = express.Router();

    router.get("/league", async function (req, res) {
        res.set("Cache-Control", "no-store");
        try {
            const [standings, fixtures] = await Promise.all([
                pool.query(chessStandingSql("ranked"), ["ranked", null, null]),
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
            const [standings, fixtures] = await Promise.all([
                pool.query(chessStandingSql("tournament"), ["tournament", timeControl, stake]),
                pool.query(
                    `SELECT m.id, m.time_control, m.stake_amount, m.status, m.result, m.winner_id,
                            wu.username AS white_player, bu.username AS black_player,
                            m.created_at, m.started_at, m.finished_at
                       FROM chess_matches m
                       LEFT JOIN users wu ON wu.id = m.player_white_id
                       LEFT JOIN users bu ON bu.id = m.player_black_id
                      WHERE m.match_type = 'tournament'
                        AND m.time_control = $1
                        AND m.stake_amount = $2
                        AND (m.created_at >= date_trunc('month', NOW())
                             OR m.status IN ('waiting', 'active', 'settling'))
                        AND m.status IN ('waiting', 'active', 'settling', 'completed')
                      ORDER BY COALESCE(m.finished_at, m.started_at, m.created_at) DESC, m.id DESC
                      LIMIT 50`,
                    [timeControl, stake]
                )
            ]);
            return res.json({
                success: true,
                tournament: { timeControl, stake, season: "current_month" },
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
