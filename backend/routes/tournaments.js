"use strict";

const crypto = require("crypto");
const express = require("express");
const { ensureTournamentRound, recordFixtureResult } = require("../services/efootballtournament");

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
                        COALESCE(BOOL_OR(tm.user_id = $1), FALSE) AS joined,
                        EXISTS (
                            SELECT 1 FROM efootball_tournament_members own
                             WHERE own.tournament_id=t.id AND own.user_id=$1 AND own.first_match_at IS NULL
                               AND own.forfeited_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_tournament_fixtures f
                                    WHERE f.tournament_id=t.id AND f.round_number=1 AND f.away_id IS NOT NULL
                                      AND (f.home_id=$1 OR f.away_id=$1)
                               )
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_matches played
                                    WHERE played.tournament_id=t.id
                                      AND (played.creator_id=$1 OR played.opponent_id=$1)
                                      AND (played.started_at IS NOT NULL OR played.status IN ('playing','awaiting_verification','disputed','completed'))
                               )
                        ) AS can_cancel
                        , EXISTS (
                            SELECT 1 FROM efootball_tournament_members own
                             WHERE own.tournament_id=t.id AND own.user_id=$1 AND own.first_match_at IS NULL
                               AND own.forfeited_at IS NULL AND own.played=0
                               AND EXISTS (
                                   SELECT 1 FROM efootball_tournament_fixtures f
                                    LEFT JOIN efootball_matches m ON m.id=f.match_id
                                    WHERE f.tournament_id=t.id AND f.round_number=1 AND f.away_id IS NOT NULL
                                      AND f.status IN ('scheduled','playing')
                                      AND (f.home_id=$1 OR f.away_id=$1)
                                      AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                               )
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_matches played
                                    WHERE played.tournament_id=t.id
                                      AND (played.creator_id=$1 OR played.opponent_id=$1)
                                      AND (played.started_at IS NOT NULL OR played.settled_at IS NOT NULL
                                           OR played.status IN ('playing','awaiting_verification','disputed','completed'))
                               )
                        ) AS can_forfeit
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

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await ensureTournamentRound(client, id, false);

            const tournament = await client.query(
                `SELECT t.id, t.name, t.tier, t.entry_fee, t.max_players,
                        t.status, t.starts_at, t.created_at,
                        COUNT(tm.id)::int AS players,
                        COALESCE(BOOL_OR(tm.user_id = $2), FALSE) AS joined,
                        EXISTS (
                            SELECT 1 FROM efootball_tournament_members own
                             WHERE own.tournament_id=t.id AND own.user_id=$2 AND own.first_match_at IS NULL
                               AND own.forfeited_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_tournament_fixtures f
                                    WHERE f.tournament_id=t.id AND f.round_number=1 AND f.away_id IS NOT NULL
                                      AND (f.home_id=$2 OR f.away_id=$2)
                               )
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_matches played
                                    WHERE played.tournament_id=t.id
                                      AND (played.creator_id=$2 OR played.opponent_id=$2)
                                      AND (played.started_at IS NOT NULL OR played.status IN ('playing','awaiting_verification','disputed','completed'))
                               )
                        ) AS can_cancel
                        , EXISTS (
                            SELECT 1 FROM efootball_tournament_members own
                             WHERE own.tournament_id=t.id AND own.user_id=$2 AND own.first_match_at IS NULL
                               AND own.forfeited_at IS NULL AND own.played=0
                               AND EXISTS (
                                   SELECT 1 FROM efootball_tournament_fixtures f
                                    LEFT JOIN efootball_matches m ON m.id=f.match_id
                                    WHERE f.tournament_id=t.id AND f.round_number=1 AND f.away_id IS NOT NULL
                                      AND f.status IN ('scheduled','playing')
                                      AND (f.home_id=$2 OR f.away_id=$2)
                                      AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                               )
                               AND NOT EXISTS (
                                   SELECT 1 FROM efootball_matches played
                                    WHERE played.tournament_id=t.id
                                      AND (played.creator_id=$2 OR played.opponent_id=$2)
                                      AND (played.started_at IS NOT NULL OR played.settled_at IS NOT NULL
                                           OR played.status IN ('playing','awaiting_verification','disputed','completed'))
                               )
                        ) AS can_forfeit
                 FROM efootball_tournaments t
                 LEFT JOIN efootball_tournament_members tm ON tm.tournament_id=t.id
                 WHERE t.id=$1 GROUP BY t.id`,
                [id, req.user.userId]
            );

            if (!tournament.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Tournament not found." });
            }

            const standings = await client.query(
                `SELECT tm.user_id, u.username, tm.group_code, tm.joined_at,
                        tm.played, tm.wins, tm.draws, tm.losses, tm.points,
                        tm.goal_difference, tm.goals_for, tm.goals_against
                   FROM efootball_tournament_members tm JOIN users u ON u.id=tm.user_id
                  WHERE tm.tournament_id=$1
                  ORDER BY tm.group_code, tm.points DESC, tm.goal_difference DESC,
                           tm.goals_for DESC, tm.wins DESC, tm.joined_at, tm.id`,
                [id]
            );

            const roundResult = await client.query(
                `SELECT round_number, starts_at, deadline_at, completed_at
                   FROM efootball_tournament_rounds WHERE tournament_id=$1
                  ORDER BY round_number DESC LIMIT 1`,
                [id]
            );
            const fixtures = await client.query(
                `SELECT f.id AS fixture_id, f.match_id, f.home_id, f.away_id,
                        hu.username AS home, au.username AS away, f.status,
                        f.group_code,
                        ('Group ' || f.group_code || ' · Round ' || f.round_number) AS round_name,
                        f.home_score, f.away_score, f.winner_id,
                        COALESCE(m.created_at,f.created_at) AS created_at,
                        m.started_at, COALESCE(m.finished_at,f.resolved_at) AS finished_at,
                        f.round_number
                   FROM efootball_tournament_fixtures f
                   JOIN users hu ON hu.id=f.home_id
                   LEFT JOIN users au ON au.id=f.away_id
                   LEFT JOIN efootball_matches m ON m.id=f.match_id
                  WHERE f.tournament_id=$1
                 UNION ALL
                 SELECT NULL::bigint AS fixture_id, m.id AS match_id,
                        m.creator_id AS home_id, m.opponent_id AS away_id,
                        hu.username AS home, au.username AS away, m.status,
                        hm.group_code,
                        COALESCE(m.round_name,'Group ' || hm.group_code) AS round_name,
                        CASE WHEN m.status='completed' THEN m.creator_score END AS home_score,
                        CASE WHEN m.status='completed' THEN m.opponent_score END AS away_score,
                        m.winner_id, m.created_at, m.started_at, m.finished_at, 0 AS round_number
                   FROM efootball_matches m
                   JOIN users hu ON hu.id=m.creator_id
                   LEFT JOIN users au ON au.id=m.opponent_id
                   LEFT JOIN efootball_tournament_members hm
                     ON hm.tournament_id=m.tournament_id AND hm.user_id=m.creator_id
                  WHERE m.tournament_id=$1 AND m.tournament_fixture_id IS NULL
                  ORDER BY round_number DESC, created_at DESC, match_id DESC LIMIT 100`,
                [id]
            );
            await client.query("COMMIT");
            const round = roundResult.rows[0] || null;
            return res.json({
                success: true,
                tournament: tournament.rows[0],
                round: round ? {
                    number: Number(round.round_number), starts_at: round.starts_at,
                    deadline_at: round.deadline_at, completed_at: round.completed_at
                } : null,
                standings: standings.rows,
                fixtures: fixtures.rows.map(row => ({
                    ...row,
                    id: row.match_id == null ? Number(row.fixture_id) : Number(row.match_id),
                    fixture_id: row.fixture_id == null ? null : Number(row.fixture_id),
                    match_id: row.match_id == null ? null : Number(row.match_id),
                    round_number: Number(row.round_number || 0),
                    home_id: Number(row.home_id),
                    away_id: row.away_id === null ? null : Number(row.away_id),
                    home_score: row.home_score === null ? null : Number(row.home_score),
                    away_score: row.away_score === null ? null : Number(row.away_score),
                    mine: Number(row.home_id) === Number(req.user.userId) || Number(row.away_id) === Number(req.user.userId)
                }))
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Tournament status error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Could not load tournament status. Please try again."
            });
        } finally {
            client.release();
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
                `SELECT COUNT(*)::int AS players,
                        COUNT(DISTINCT group_code)::int AS groups
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

            // Keep groups balanced and at no more than four groups. For a
            // 16-player event this creates Groups A-D with four players each.
            const groupCount = Math.min(4, Math.max(1, Math.ceil(capacity / 4)));
            const groupSize = Math.ceil(capacity / groupCount);
            const groupCounts = await client.query(
                `SELECT group_code, COUNT(*)::int AS players
                   FROM efootball_tournament_members
                  WHERE tournament_id = $1
                  GROUP BY group_code`,
                [id]
            );
            const countsByGroup = new Map(groupCounts.rows.map(row => [row.group_code, Number(row.players)]));
            let groupCode = null;
            for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
                const candidateCode = String.fromCharCode(65 + groupIndex);
                if ((countsByGroup.get(candidateCode) || 0) < groupSize) {
                    groupCode = candidateCode;
                    break;
                }
            }
            if (!groupCode) {
                throw httpError(409, "Tournament groups are full. Please refresh and try again.");
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
                    (tournament_id, user_id, fee_paid, group_code)
                 VALUES ($1, $2, $3, $4)`,
                [id, req.user.userId, fee, groupCode]
            );

            await client.query("COMMIT");
            inTransaction = false;
            return res.status(201).json({
                success: true,
                message: "Joined tournament.",
                entryFee: fee,
                group: groupCode
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

    router.post("/:id/cancel", authenticateToken, async (req, res) => {
        const id = parseId(req.params.id);
        const userId = Number(req.user.userId);
        if (!id) return res.status(400).json({ success: false, message: "Invalid tournament ID." });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const tournament = await client.query(
                "SELECT id,name,entry_fee FROM efootball_tournaments WHERE id=$1 FOR UPDATE",
                [id]
            );
            if (!tournament.rows.length) throw httpError(404, "Tournament not found.");
            const memberResult = await client.query(
                `SELECT * FROM efootball_tournament_members
                  WHERE tournament_id=$1 AND user_id=$2 FOR UPDATE`,
                [id, userId]
            );
            if (!memberResult.rows.length) throw httpError(404, "You have not entered this tournament.");
            const member = memberResult.rows[0];

            const releasedFixture = await client.query(
                `SELECT 1 FROM efootball_tournament_fixtures
                  WHERE tournament_id=$1 AND round_number=1 AND away_id IS NOT NULL
                    AND (home_id=$2 OR away_id=$2)
                  LIMIT 1`,
                [id, userId]
            );
            if (releasedFixture.rows.length) {
                throw httpError(409, "The first fixture is out. Use Forfeit tournament to transfer the locked stake to the admins.");
            }

            const played = await client.query(
                `SELECT 1 FROM efootball_matches
                  WHERE tournament_id=$1 AND (creator_id=$2 OR opponent_id=$2)
                    AND (started_at IS NOT NULL OR status IN ('playing','awaiting_verification','disputed','completed'))
                  LIMIT 1 FOR UPDATE`,
                [id, userId]
            );
            if (member.first_match_at || played.rows.length) {
                throw httpError(409, "Tournament entry can only be cancelled before your first match starts.");
            }

            const unstarted = await client.query(
                `SELECT * FROM efootball_matches
                  WHERE tournament_id=$1 AND (creator_id=$2 OR opponent_id=$2)
                    AND status IN ('waiting','ready') AND started_at IS NULL
                  FOR UPDATE`,
                [id, userId]
            );
            for (const match of unstarted.rows) {
                const fixtureResult = match.tournament_fixture_id
                    ? await client.query("SELECT * FROM efootball_tournament_fixtures WHERE id=$1 FOR UPDATE", [match.tournament_fixture_id])
                    : { rows: [] };
                if (fixtureResult.rows[0]) {
                    const fixture = fixtureResult.rows[0];
                    const remainingPlayer = Number(fixture.home_id) === userId ? fixture.away_id : fixture.home_id;
                    if (remainingPlayer) {
                        await client.query(
                            `UPDATE efootball_tournament_fixtures
                                SET home_id=$1, away_id=NULL, match_id=NULL, status='bye',
                                    home_score=NULL, away_score=NULL, winner_id=NULL, resolved_at=NOW()
                              WHERE id=$2`,
                            [remainingPlayer, fixture.id]
                        );
                    } else {
                        await client.query("DELETE FROM efootball_tournament_fixtures WHERE id=$1", [fixture.id]);
                    }
                }
                await client.query(
                    `UPDATE efootball_matches
                        SET status='cancelled', result_status='tournament_entry_cancelled',
                            finished_at=NOW(), settled_at=NOW(), search_last_seen_at=NULL,
                            creator_ready=FALSE, opponent_ready=FALSE, external_room_code=NULL,
                            code_sent=FALSE, code_sender_id=NULL
                      WHERE id=$1`,
                    [match.id]
                );
            }

            const openFixtures = await client.query(
                `SELECT * FROM efootball_tournament_fixtures
                  WHERE tournament_id=$1 AND status IN ('scheduled','playing')
                    AND (home_id=$2 OR away_id=$2)
                  FOR UPDATE`,
                [id, userId]
            );
            for (const fixture of openFixtures.rows) {
                const remainingPlayer = Number(fixture.home_id) === userId ? fixture.away_id : fixture.home_id;
                if (remainingPlayer) {
                    await client.query(
                        `UPDATE efootball_tournament_fixtures
                            SET home_id=$1,away_id=NULL,match_id=NULL,status='bye',
                                home_score=NULL,away_score=NULL,winner_id=NULL,resolved_at=NOW()
                          WHERE id=$2`,
                        [remainingPlayer, fixture.id]
                    );
                } else {
                    await client.query("DELETE FROM efootball_tournament_fixtures WHERE id=$1", [fixture.id]);
                }
            }

            const fee = Number(member.fee_paid || 0);
            if (fee > 0) {
                const refund = await client.query(
                    `UPDATE wallets SET locked_balance=locked_balance-$1,
                            balance=balance+$1, updated_at=NOW()
                      WHERE user_id=$2 AND locked_balance >= $1
                      RETURNING user_id`,
                    [fee, userId]
                );
                if (!refund.rows.length) throw new Error("The locked tournament entry fee could not be refunded safely.");
                await client.query(
                    `INSERT INTO transactions
                        (user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'tournament_refund',$2,'KES','completed',$3,$4)`,
                    [userId, fee, `TOURN-CANCEL-${id}-${userId}-${crypto.randomUUID()}`, tournament.rows[0].name + " entry fee refunded"]
                );
            }

            await client.query("DELETE FROM efootball_tournament_members WHERE tournament_id=$1 AND user_id=$2", [id, userId]);
            await client.query("COMMIT");
            return res.json({
                success: true,
                refunded: fee,
                message: fee > 0
                    ? "Tournament entry cancelled. KSh " + fee.toFixed(2) + " was returned to your available wallet balance."
                    : "Tournament entry cancelled."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (error.status) return res.status(error.status).json({ success: false, message: error.message });
            console.error("Tournament cancellation error:", error.message);
            return res.status(500).json({ success: false, message: "Could not cancel your tournament entry safely." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/forfeit", authenticateToken, async (req, res) => {
        const id = parseId(req.params.id);
        const userId = Number(req.user.userId);
        if (!id) return res.status(400).json({ success: false, message: "Invalid tournament ID." });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const tournamentResult = await client.query(
                "SELECT id,name FROM efootball_tournaments WHERE id=$1 FOR UPDATE",
                [id]
            );
            if (!tournamentResult.rows.length) throw httpError(404, "Tournament not found.");

            const memberResult = await client.query(
                `SELECT * FROM efootball_tournament_members
                  WHERE tournament_id=$1 AND user_id=$2 FOR UPDATE`,
                [id, userId]
            );
            if (!memberResult.rows.length) throw httpError(404, "You have not entered this tournament.");
            const member = memberResult.rows[0];
            if (member.forfeited_at) throw httpError(409, "You have already forfeited this tournament.");
            if (member.first_match_at || Number(member.played || 0) > 0) {
                throw httpError(409, "You can only forfeit before your first tournament match is played.");
            }

            const fixtureResult = await client.query(
                `SELECT * FROM efootball_tournament_fixtures
                  WHERE tournament_id=$1 AND round_number=1 AND away_id IS NOT NULL
                    AND (home_id=$2 OR away_id=$2) AND status IN ('scheduled','playing')
                  ORDER BY id LIMIT 1 FOR UPDATE`,
                [id, userId]
            );
            if (!fixtureResult.rows.length) {
                throw httpError(409, "Forfeiting becomes available after your first opponent fixture is released.");
            }
            const fixture = fixtureResult.rows[0];
            const linkedMatchResult = fixture.match_id
                ? await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [fixture.match_id])
                : { rows: [] };
            const linkedMatch = linkedMatchResult.rows[0] || null;
            if (linkedMatch && (linkedMatch.started_at || linkedMatch.settled_at ||
                ["playing", "awaiting_verification", "disputed", "completed"].includes(String(linkedMatch.status)))) {
                throw httpError(409, "Your first match has already started. Forfeiting is no longer available.");
            }

            const fee = Math.max(0, Number(member.fee_paid || 0));
            if (!Number.isFinite(fee)) throw httpError(500, "The tournament stake is invalid.");
            const admins = fee > 0
                ? await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE")
                : { rows: [] };
            if (fee > 0 && admins.rows.length < 2) {
                throw httpError(409, "Both administrator accounts must be available before this stake can be forfeited.");
            }

            if (linkedMatch) {
                await client.query(
                    `UPDATE efootball_matches
                        SET status='cancelled',result_status='tournament_entry_forfeit',
                            finished_at=NOW(),settled_at=NOW(),search_last_seen_at=NULL,
                            creator_ready=FALSE,opponent_ready=FALSE,external_room_code=NULL,
                            code_sent=FALSE,code_sender_id=NULL
                      WHERE id=$1 AND started_at IS NULL AND settled_at IS NULL
                        AND status IN ('waiting','ready')`,
                    [linkedMatch.id]
                );
            }

            if (fee > 0) {
                const movedStake = await client.query(
                    `UPDATE wallets SET locked_balance=locked_balance-$1,updated_at=NOW()
                      WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`,
                    [fee, userId]
                );
                if (!movedStake.rows.length) throw new Error("The locked tournament stake could not be transferred safely.");

                const totalCents = Math.round(fee * 100);
                const baseCents = Math.floor(totalCents / admins.rows.length);
                let remainder = totalCents - baseCents * admins.rows.length;
                const reference = `TOURN-FORFEIT-${id}-${userId}-${crypto.randomUUID()}`;
                for (const admin of admins.rows) {
                    const cents = baseCents + (remainder > 0 ? 1 : 0);
                    if (remainder > 0) remainder -= 1;
                    const share = (cents / 100).toFixed(2);
                    await client.query(
                        "INSERT INTO admin_wallets(admin_id) VALUES($1) ON CONFLICT(admin_id) DO NOTHING",
                        [admin.id]
                    );
                    await client.query(
                        "UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2",
                        [share, admin.id]
                    );
                    await client.query(
                        `INSERT INTO admin_wallet_transactions
                            (admin_id,transaction_type,amount,currency,status,reference,description)
                         VALUES($1,'tournament_forfeit_stake',$2,'KES','completed',$3,$4)`,
                        [admin.id, share, `${reference}-${admin.id}`, tournamentResult.rows[0].name + " forfeited tournament stake share"]
                    );
                }
                await client.query(
                    `INSERT INTO transactions
                        (user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'tournament_forfeit',$2,'KES','completed',$3,$4)`,
                    [userId, fee, reference, tournamentResult.rows[0].name + " stake forfeited to both administrator wallets"]
                );
            }

            const forfeiterIsHome = Number(fixture.home_id) === userId;
            const winnerId = forfeiterIsHome ? Number(fixture.away_id) : Number(fixture.home_id);
            const homeScore = forfeiterIsHome ? 0 : 3;
            const awayScore = forfeiterIsHome ? 3 : 0;
            const recorded = await recordFixtureResult(client, fixture, {
                status: "walkover",
                homeScore,
                awayScore,
                winnerId
            });
            if (!recorded) throw httpError(409, "This fixture has already been settled.");

            await client.query(
                `UPDATE efootball_tournament_members
                    SET forfeited_at=NOW(),first_match_at=COALESCE(first_match_at,NOW())
                  WHERE tournament_id=$1 AND user_id=$2`,
                [id, userId]
            );
            await client.query(
                `UPDATE efootball_tournament_members SET first_match_at=COALESCE(first_match_at,NOW())
                  WHERE tournament_id=$1 AND user_id=$2`,
                [id, winnerId]
            );

            await client.query("COMMIT");
            return res.json({
                success: true,
                forfeited: true,
                stakeTransferred: fee,
                message: fee > 0
                    ? "Tournament forfeited. Your KSh " + fee.toFixed(2) + " stake was split between both admin wallets, and your opponent received a walkover."
                    : "Tournament forfeited. Your opponent received a walkover."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (error.status) return res.status(error.status).json({ success: false, message: error.message });
            console.error("Tournament forfeiture error:", error.message);
            return res.status(500).json({ success: false, message: "Could not forfeit the tournament entry safely." });
        } finally {
            client.release();
        }
    });

    return router;
};
