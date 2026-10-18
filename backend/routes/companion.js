"use strict";

const express = require("express");

module.exports = function createCompanionRoutes(pool, authenticateToken) {
    const router = express.Router();

    router.get("/profile", authenticateToken, (req, res) => {
        res.set("Cache-Control", "private, no-store");
        res.json({ success: true, username: String(req.user.username || "") });
    });

    router.get("/upcoming", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        try {
            const result = await pool.query(
                `SELECT EXISTS (
                    SELECT 1 FROM chess_scheduled_matches s
                     WHERE (s.host_user_id=$1 OR s.guest_user_id=$1)
                       AND s.status='accepted'
                       AND s.scheduled_at>=NOW()-INTERVAL '30 minutes'
                       AND s.scheduled_at<=NOW()+INTERVAL '30 days'
                    UNION ALL
                    SELECT 1
                      FROM efootball_league_fixtures f
                      JOIN efootball_league_rounds r
                        ON r.league_id=f.league_id AND r.round_number=f.round_number
                      JOIN efootball_leagues l ON l.id=f.league_id
                      LEFT JOIN efootball_matches m ON m.id=f.match_id
                     WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                       AND f.status IN ('scheduled','playing')
                       AND l.status IN ('open','in_progress')
                       AND r.completed_at IS NULL
                       AND (r.deadline_at IS NULL OR r.deadline_at>NOW())
                       AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                    UNION ALL
                    SELECT 1
                      FROM efootball_tournament_fixtures f
                      JOIN efootball_tournament_rounds r
                        ON r.tournament_id=f.tournament_id AND r.round_number=f.round_number
                      JOIN efootball_tournaments t ON t.id=f.tournament_id
                      LEFT JOIN efootball_matches m ON m.id=f.match_id
                     WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                       AND f.status IN ('scheduled','playing')
                       AND t.status IN ('open','in_progress')
                       AND r.completed_at IS NULL
                       AND (r.deadline_at IS NULL OR r.deadline_at>NOW())
                       AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                    UNION ALL
                    SELECT 1 FROM efootball_matches m
                     WHERE (m.creator_id=$1 OR m.opponent_id=$1)
                       AND m.status IN ('waiting','ready')
                       AND m.started_at IS NULL AND m.settled_at IS NULL
                ) AS has_upcoming_games`,
                [userId]
            );
            res.set("Cache-Control", "private, no-store");
            res.json({ success: true, hasUpcomingGames: Boolean(result.rows[0] && result.rows[0].has_upcoming_games) });
        } catch (error) {
            console.error("Companion upcoming-game status failed.");
            res.status(500).json({ success: false, message: "Could not check upcoming games." });
        }
    });

    return router;
};
