"use strict";

const { ensureTournamentRound, ensureLeagueRound } = require("./efootballtournament");
const { getEfootballScheduleState, OPEN_MINUTE } = require("./efootballScheduleRules");

const SCHEDULER_LOCK = "goal-gambit:efootball-daily-scheduler:v1";
const FOUR_MATCH_TARGET = 4;

function eventKey(userId, suffix) {
    return "efootball-schedule:" + String(suffix) + ":" + Number(userId);
}

function previousEatDate(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day - 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function createEfootballScheduler(pool, pushService, io) {
    let timer = null;
    let running = false;

    async function push(client, userId, event) {
        if (!pushService || typeof pushService.enqueueNotification !== "function") return false;
        await client.query("SAVEPOINT efootball_scheduler_push");
        try {
            const queued = await pushService.enqueueNotification(client, Number(userId), event);
            await client.query("RELEASE SAVEPOINT efootball_scheduler_push");
            return Boolean(queued && queued.created);
        } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT efootball_scheduler_push").catch(() => {});
            await client.query("RELEASE SAVEPOINT efootball_scheduler_push").catch(() => {});
            console.error("eFootball scheduler notification enqueue failed:", error.message);
            return false;
        }
    }

    async function log(client, eventType, message, details) {
        await client.query(
            `INSERT INTO efootball_scheduler_logs(event_type,message,details)
             VALUES($1,$2,$3::jsonb)`,
            [String(eventType).slice(0, 40), String(message).slice(0, 300), JSON.stringify(details || {})]
        );
    }

    function emitScheduleUpdate(userId, reason) {
        if (!io || !userId) return;
        io.to("user_" + Number(userId)).emit("efootball:match-update", { scheduleChanged: true, reason: String(reason || "schedule-updated") });
    }

    async function efootballUserIds(client, suffix) {
        const result = await client.query(
            `SELECT u.id FROM users u
              WHERE u.account_status='active' AND u.game IN ('konami','both')
                AND NOT EXISTS (
                    SELECT 1 FROM push_notification_events p
                     WHERE p.user_id=u.id AND p.event_key='efootball-schedule:'||$1||':'||u.id
                )
              ORDER BY u.id`,
            [String(suffix)]
        );
        return result.rows.map(row => Number(row.id));
    }

    async function enqueueWindowNotice(client, state, opening) {
        const eventDate = opening ? state.sessionDate : previousEatDate(state.localDate);
        const suffix = (opening ? "window-open:" : "window-closed:") + eventDate;
        const users = await efootballUserIds(client, suffix);
        const event = opening ? {
            title: "eFootball matchmaking is open",
            body: "New GOAL$GAMBIT eFootball matches are open until 12:50 AM EAT. Open the Match Hub to play.",
            page: "match-hub"
        } : {
            title: "eFootball matchmaking is closed",
            body: "New eFootball searches reopen at 4:00 PM EAT. Confirmed matches remain on your Match Hub.",
            page: "match-hub"
        };
        for (const userId of users) {
            const created = await push(client, userId, Object.assign({ eventKey: eventKey(userId, suffix) }, event));
            if (created) emitScheduleUpdate(userId, opening ? "gaming-window-opened" : "gaming-window-closed");
        }
    }

    async function enqueueBelowTargetNotices(client, targetDate) {
        // EAT calendar dates, rather than the process timezone or the
        // overnight session label, define the daily target.
        const users = await client.query(
            `WITH eat_day AS (
                SELECT $2::date AS local_date
             ), fixture_counts AS (
                SELECT u.id AS user_id,
                       (SELECT COUNT(*) FROM efootball_matches m
                         WHERE m.mode='ranked' AND m.opponent_id IS NOT NULL
                           AND (m.creator_id=u.id OR m.opponent_id=u.id)
                           AND m.status<>'cancelled'
                           AND m.created_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                           AND m.created_at < ((d.local_date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
                       + (SELECT COUNT(*) FROM efootball_league_fixtures f
                           JOIN efootball_league_rounds r ON r.league_id=f.league_id AND r.round_number=f.round_number
                          WHERE (f.home_id=u.id OR f.away_id=u.id) AND f.away_id IS NOT NULL
                            AND f.status IN ('scheduled','playing','completed','walkover','draw')
                            AND r.starts_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                            AND r.starts_at < ((d.local_date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
                       + (SELECT COUNT(*) FROM efootball_tournament_fixtures f
                           JOIN efootball_tournament_rounds r ON r.tournament_id=f.tournament_id AND r.round_number=f.round_number
                          WHERE (f.home_id=u.id OR f.away_id=u.id) AND f.away_id IS NOT NULL
                            AND f.status IN ('scheduled','playing','completed','walkover','draw')
                            AND r.starts_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                            AND r.starts_at < ((d.local_date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')) AS scheduled_count
                  FROM users u CROSS JOIN eat_day d
                 WHERE u.account_status='active' AND u.game IN ('konami','both')
             )
             SELECT user_id,scheduled_count FROM fixture_counts c
              WHERE scheduled_count < $1
                AND NOT EXISTS (
                    SELECT 1 FROM push_notification_events p
                     WHERE p.user_id=c.user_id
                       AND p.event_key='efootball-schedule:daily-target:'||$2||':'||c.user_id
                )
              ORDER BY scheduled_count,user_id`,
            [FOUR_MATCH_TARGET, targetDate]
        );
        let allQueued = true;
        for (const row of users.rows) {
            const created = await push(client, row.user_id, {
                eventKey: eventKey(row.user_id, "daily-target:" + targetDate),
                title: "Your daily fixture update",
                body: "On " + targetDate + ", " + Number(row.scheduled_count) + " of 4 eFootball fixtures were assigned. No more eligible fixtures could be scheduled in that day's window.",
                page: "match-hub"
            });
            if (!created) allQueued = false;
        }
        return allQueued;
    }

    async function notifyTournamentStarted(client, tournamentId, tournamentName) {
        const members = await client.query(
            `SELECT tm.user_id FROM efootball_tournament_members tm
              JOIN users u ON u.id=tm.user_id
             WHERE tm.tournament_id=$1 AND tm.forfeited_at IS NULL
               AND u.account_status='active' AND u.game IN ('konami','both')
               AND NOT EXISTS (SELECT 1 FROM push_notification_events p
                                WHERE p.user_id=tm.user_id
                                  AND p.event_key='efootball-tournament:'||$1||':started')
             ORDER BY tm.user_id`,
            [tournamentId]
        );
        let notified = 0;
        for (const row of members.rows) {
            const created = await push(client, row.user_id, {
                eventKey: "efootball-tournament:" + Number(tournamentId) + ":started",
                title: "Tournament matches are ready",
                body: tournamentName + " has started. Your first fixtures are available in the Match Hub.",
                page: "match-hub"
            });
            if (created) {
                notified += 1;
                emitScheduleUpdate(row.user_id, "tournament-fixtures-scheduled");
            }
        }
        return notified;
    }

    async function reconcileFullTournaments(client, state) {
        const due = await client.query(
            `SELECT t.id,t.name,t.status,t.max_players,t.starts_at,
                    COUNT(tm.id)::int AS players
               FROM efootball_tournaments t
               LEFT JOIN efootball_tournament_members tm
                 ON tm.tournament_id=t.id AND tm.forfeited_at IS NULL
              WHERE t.status IN ('open','scheduled')
              GROUP BY t.id
             HAVING COUNT(tm.id)=t.max_players
                AND (t.starts_at IS NULL OR t.starts_at<=NOW())
              ORDER BY t.id LIMIT 100`
        );
        for (const row of due.rows) {
            const tournamentId = Number(row.id);
            if (!state.isMatchmakingOpen) {
                await client.query("BEGIN");
                try {
                    await client.query("SELECT id FROM efootball_tournaments WHERE id=$1 FOR UPDATE", [tournamentId]);
                    await client.query(
                        "UPDATE efootball_tournaments SET status='scheduled',starts_at=$2 WHERE id=$1 AND status IN ('open','scheduled')",
                        [tournamentId, state.nextOpensAt]
                    );
                    await client.query("COMMIT");
                } catch (error) {
                    await client.query("ROLLBACK").catch(() => {});
                    throw error;
                }
                continue;
            }

            await client.query("BEGIN");
            try {
                const current = await client.query(
                    "SELECT id,name,status FROM efootball_tournaments WHERE id=$1 FOR UPDATE",
                    [tournamentId]
                );
                if (!current.rows.length || current.rows[0].status === "in_progress") {
                    await client.query("COMMIT");
                    continue;
                }
                const round = await ensureTournamentRound(client, tournamentId, true);
                if (round && round.deadline_at) {
                    const notified = await notifyTournamentStarted(client, tournamentId, current.rows[0].name);
                    await log(client, "tournament_started", "A full eFootball tournament started automatically.", {
                        tournamentId, players: Number(row.players), notified
                    });
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            }
        }
    }

    async function reconcileActiveTournamentNotifications(client) {
        const active = await client.query(
            `SELECT t.id,t.name,r.round_number
               FROM efootball_tournaments t
               JOIN LATERAL (
                    SELECT round_number,deadline_at,completed_at
                      FROM efootball_tournament_rounds
                     WHERE tournament_id=t.id
                     ORDER BY round_number DESC LIMIT 1
               ) r ON TRUE
              WHERE t.status='in_progress' AND r.deadline_at IS NOT NULL AND r.completed_at IS NULL
              ORDER BY t.id LIMIT 100`
        );
        for (const tournament of active.rows) {
            const tournamentId = Number(tournament.id);
            const roundNumber = Number(tournament.round_number);
            if (roundNumber === 1) {
                // Cover starts initiated by a status or matchmaking request,
                // including participants who have a first-round bye.
                await notifyTournamentStarted(client, tournamentId, tournament.name);
                continue;
            }
            const members = await client.query(
                `SELECT DISTINCT participant_id FROM (
                    SELECT home_id AS participant_id FROM efootball_tournament_fixtures
                     WHERE tournament_id=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                    UNION ALL
                    SELECT away_id AS participant_id FROM efootball_tournament_fixtures
                     WHERE tournament_id=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                 ) players WHERE participant_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM push_notification_events p
                                    WHERE p.user_id=players.participant_id
                                      AND p.event_key='efootball-tournament:'||$1||':round:'||$2||':ready:'||players.participant_id)
                 ORDER BY participant_id`,
                [tournamentId, roundNumber]
            );
            for (const row of members.rows) {
                const userId = Number(row.participant_id);
                const eventKey = "efootball-tournament:" + tournamentId + ":round:" + roundNumber + ":ready:" + userId;
                const created = await push(client, userId, {
                    eventKey,
                    title: "Tournament fixtures are ready",
                    body: tournament.name + " round " + roundNumber + " is ready. Check your fixture in the Match Hub.",
                    page: "match-hub"
                });
                if (created) emitScheduleUpdate(userId, "tournament-fixtures-scheduled");
            }
        }
    }

    async function startEligibleLeagueRounds(client, state) {
        if (!state.isMatchmakingOpen) return;
        const leagues = await client.query(
            `SELECT l.id,l.name FROM efootball_leagues l
              WHERE l.status IN ('open','in_progress')
                AND (SELECT COUNT(*) FROM efootball_league_members lm
                      WHERE lm.league_id=l.id AND lm.forfeited_at IS NULL)>=2
              ORDER BY l.id LIMIT 100`
        );
        for (const league of leagues.rows) {
            await client.query("BEGIN");
            try {
                const round = await ensureLeagueRound(client, Number(league.id), true);
                // Another request can create/start a league round before this
                // scheduler poll. Reconcile notifications for every active
                // round; push event keys make the operation idempotent.
                if (round && round.deadline_at && !round.completed_at) {
                    const participants = await client.query(
                        `SELECT DISTINCT participant_id FROM (
                            SELECT home_id AS participant_id FROM efootball_league_fixtures
                             WHERE league_id=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                            UNION ALL
                            SELECT away_id AS participant_id FROM efootball_league_fixtures
                             WHERE league_id=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                         ) players WHERE participant_id IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM push_notification_events p
                                            WHERE p.user_id=players.participant_id
                                              AND p.event_key='efootball-league:'||$1||':round:'||$2||':ready:'||players.participant_id)
                         ORDER BY participant_id`,
                        [Number(league.id), Number(round.round_number)]
                    );
                    for (const participant of participants.rows) {
                        const created = await push(client, participant.participant_id, {
                            eventKey: "efootball-league:" + Number(league.id) + ":round:" + Number(round.round_number) + ":ready:" + Number(participant.participant_id),
                            title: "League fixtures are ready",
                            body: league.name + " League Round " + Number(round.round_number) + " is open. Check the Match Hub for your fixture.",
                            page: "match-hub"
                        });
                        if (created) emitScheduleUpdate(participant.participant_id, "league-fixtures-scheduled");
                    }
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            }
        }
    }

    async function postponeOpenRounds(client, state) {
        // The session remains active until 1:00 AM, even though new queues
        // close at 12:50. Only carry unfinished rounds after the session ends.
        if (state.isSessionActive || state.isMatchmakingOpen) return;
        const nextOpen = new Date(state.nextOpensAt);
        const plans = [
            {
                type: "tournament",
                table: "efootball_tournament_rounds",
                parent: "tournament_id",
                fixtures: "efootball_tournament_fixtures",
                roundDuration: 20
            },
            {
                type: "league",
                table: "efootball_league_rounds",
                parent: "league_id",
                fixtures: "efootball_league_fixtures",
                roundDuration: 25
            }
        ];
        for (const plan of plans) {
            const due = await client.query(
                `SELECT id,${plan.parent} AS parent_id,round_number FROM ${plan.table}
                  WHERE completed_at IS NULL AND deadline_at IS NOT NULL
                    AND starts_at IS NOT NULL AND starts_at<$1
                    AND deadline_at<$1
                  ORDER BY id LIMIT 100`,
                [state.nextOpensAt]
            );
            for (const round of due.rows) {
                await client.query("BEGIN");
                try {
                    const locked = await client.query(
                        `SELECT id FROM ${plan.table}
                          WHERE id=$1 AND completed_at IS NULL AND starts_at<$2 AND deadline_at<$2
                          FOR UPDATE`,
                        [round.id, state.nextOpensAt]
                    );
                    if (!locked.rows.length) {
                        await client.query("COMMIT");
                        continue;
                    }
                    const deadline = new Date(nextOpen.getTime() + plan.roundDuration * 60000);
                    await client.query(
                        `UPDATE ${plan.table} SET starts_at=$2,deadline_at=$3 WHERE id=$1 AND completed_at IS NULL`,
                        [round.id, nextOpen.toISOString(), deadline.toISOString()]
                    );
                    const participants = await client.query(
                        `SELECT DISTINCT participant_id FROM (
                            SELECT home_id AS participant_id FROM ${plan.fixtures}
                             WHERE ${plan.parent}=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                            UNION ALL
                            SELECT away_id AS participant_id FROM ${plan.fixtures}
                             WHERE ${plan.parent}=$1 AND round_number=$2 AND away_id IS NOT NULL AND status IN ('scheduled','playing')
                         ) players WHERE participant_id IS NOT NULL ORDER BY participant_id`,
                        [round.parent_id, round.round_number]
                    );
                    let notified = 0;
                    for (const participant of participants.rows) {
                        const created = await push(client, participant.participant_id, {
                            eventKey: "efootball-round-postponed:" + plan.type + ":" + Number(round.id) + ":" + Number(participant.participant_id),
                            title: "Fixture moved to the next playing window",
                            body: "Your confirmed " + plan.type + " fixture stays scheduled and resumes after 4:00 PM EAT. Its result and opponent were preserved.",
                            page: "match-hub"
                        });
                        if (created) notified += 1;
                        emitScheduleUpdate(participant.participant_id, "fixture-postponed");
                    }
                    await log(client, "round_postponed", "An unfinished competition round was carried to the next EAT gaming window.", {
                        roundId: Number(round.id), competitionType: plan.type, competitionId: Number(round.parent_id), roundNumber: Number(round.round_number),
                        startsAt: nextOpen.toISOString(), notified
                    });
                    await client.query("COMMIT");
                } catch (error) {
                    await client.query("ROLLBACK").catch(() => {});
                    throw error;
                }
            }
        }
    }

    async function notifyUnstartedRankedMatches(client, state) {
        if (state.isSessionActive || state.isMatchmakingOpen) return;
        await client.query("BEGIN");
        try {
            const matches = await client.query(
                `SELECT id,creator_id,opponent_id FROM efootball_matches
                  WHERE mode='ranked' AND opponent_id IS NOT NULL
                    AND status IN ('waiting','ready') AND started_at IS NULL AND settled_at IS NULL
                    AND (
                        NOT EXISTS (SELECT 1 FROM push_notification_events p
                                     WHERE p.user_id=efootball_matches.creator_id
                                       AND p.event_key='efootball-match:'||efootball_matches.id||':session-postponed:'||efootball_matches.creator_id)
                        OR NOT EXISTS (SELECT 1 FROM push_notification_events p
                                        WHERE p.user_id=efootball_matches.opponent_id
                                          AND p.event_key='efootball-match:'||efootball_matches.id||':session-postponed:'||efootball_matches.opponent_id)
                    )
                  ORDER BY id LIMIT 500`
            );
            let notified = 0;
            const postponedMatchIds = [];
            for (const match of matches.rows) {
                const matchId = Number(match.id);
                postponedMatchIds.push(matchId);
                for (const userId of [Number(match.creator_id), Number(match.opponent_id)]) {
                    const created = await push(client, userId, {
                        eventKey: "efootball-match:" + matchId + ":session-postponed:" + userId,
                        matchId,
                        title: "Match paused until 4:00 PM EAT",
                        body: "Your confirmed match is saved. Mark ready after the eFootball session reopens at 4:00 PM EAT.",
                        page: "match-room"
                    });
                    if (created) {
                        notified += 1;
                        emitScheduleUpdate(userId, "ranked-match-postponed");
                    }
                }
            }
            if (notified) {
                await log(client, "ranked_match_postponed", "Unstarted confirmed ranked matches were preserved for the next gaming session.", {
                    notificationsQueued: notified,
                    matchIds: postponedMatchIds,
                    nextOpensAt: state.nextOpensAt
                });
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        }
    }

    async function dailyCounts(client, userId) {
        const result = await client.query(
            `WITH eat_day AS (SELECT (NOW() AT TIME ZONE 'Africa/Nairobi')::date AS local_date)
             SELECT
               (SELECT COUNT(*) FROM efootball_matches m,eat_day d
                 WHERE m.mode='ranked' AND m.opponent_id IS NOT NULL
                   AND (m.creator_id=$1 OR m.opponent_id=$1) AND m.status<>'cancelled'
                   AND m.created_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                   AND m.created_at < ((d.local_date+1)::timestamp AT TIME ZONE 'Africa/Nairobi'))::int
               + (SELECT COUNT(*) FROM efootball_league_fixtures f
                   JOIN efootball_league_rounds r ON r.league_id=f.league_id AND r.round_number=f.round_number,eat_day d
                  WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                    AND f.status IN ('scheduled','playing','completed','walkover','draw')
                    AND r.starts_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                    AND r.starts_at < ((d.local_date+1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
               + (SELECT COUNT(*) FROM efootball_tournament_fixtures f
                   JOIN efootball_tournament_rounds r ON r.tournament_id=f.tournament_id AND r.round_number=f.round_number,eat_day d
                  WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                    AND f.status IN ('scheduled','playing','completed','walkover','draw')
                    AND r.starts_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                   AND r.starts_at < ((d.local_date+1)::timestamp AT TIME ZONE 'Africa/Nairobi')) AS assigned_fixtures,
               (SELECT COUNT(*) FROM efootball_matches m,eat_day d
                 WHERE (m.creator_id=$1 OR m.opponent_id=$1) AND m.status='completed'
                   AND m.finished_at >= (d.local_date::timestamp AT TIME ZONE 'Africa/Nairobi')
                   AND m.finished_at < ((d.local_date+1)::timestamp AT TIME ZONE 'Africa/Nairobi'))::int AS completed_games`,
            [Number(userId)]
        );
        return result.rows[0] || { assigned_fixtures: 0, completed_games: 0 };
    }

    async function run() {
        if (running) return;
        running = true;
        const client = await pool.connect();
        let hasLock = false;
        try {
            const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [SCHEDULER_LOCK]);
            hasLock = Boolean(lock.rows[0] && lock.rows[0].locked);
            if (!hasLock) return;

            const clock = await client.query("SELECT NOW() AS now");
            const state = getEfootballScheduleState(clock.rows[0].now);

            // Unique per-user push event keys make these safe to reconcile on
            // every poll and after a server restart without a volatile timer flag.
            await client.query("BEGIN");
            try {
                if (state.isMatchmakingOpen) await enqueueWindowNotice(client, state, true);
                else if (state.minuteOfDay < OPEN_MINUTE) {
                    await enqueueWindowNotice(client, state, false);
                }
                const completedDate = previousEatDate(state.localDate);
                const targetCheck = await client.query(
                    `SELECT 1 FROM efootball_scheduler_logs
                      WHERE event_type='daily_target_checked' AND details->>'targetDate'=$1 LIMIT 1`,
                    [completedDate]
                );
                if (!targetCheck.rows.length) {
                    const allQueued = await enqueueBelowTargetNotices(client, completedDate);
                    if (allQueued) {
                        await log(client, "daily_target_checked", "The prior EAT calendar date fixture target was reconciled.", {
                            targetDate: completedDate
                        });
                    }
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            }

            await postponeOpenRounds(client, state);
            await notifyUnstartedRankedMatches(client, state);
            await reconcileFullTournaments(client, state);
            await reconcileActiveTournamentNotifications(client);
            await startEligibleLeagueRounds(client, state);
        } catch (error) {
            console.error("eFootball daily scheduler failed:", error.message);
            try {
                await pool.query(
                    `INSERT INTO efootball_scheduler_logs(event_type,message,details)
                     VALUES('scheduler_failed',$1,$2::jsonb)`,
                    [String(error.message || "Unknown scheduler error").slice(0, 300), JSON.stringify({ at: new Date().toISOString() })]
                );
            } catch (_) {}
        } finally {
            if (hasLock) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [SCHEDULER_LOCK]).catch(() => {});
            client.release();
            running = false;
        }
    }

    function start() {
        if (timer) return;
        run().catch(() => {});
        timer = setInterval(() => run().catch(() => {}), 30000);
        if (typeof timer.unref === "function") timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    async function snapshot() {
        const clock = await pool.query("SELECT NOW() AS now");
        const state = getEfootballScheduleState(clock.rows[0].now);
        const [tournaments, underTarget, leagues, rejectionSummary, failures, postponements] = await Promise.all([
            pool.query(
                `SELECT t.id,t.name,t.status,t.max_players,t.starts_at,COUNT(DISTINCT tm.id)::int AS players,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status IN ('scheduled','playing'))::int AS outstanding_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='scheduled')::int AS scheduled_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='playing')::int AS active_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status IN ('completed','draw'))::int AS completed_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='walkover')::int AS forfeited_fixtures
                   FROM efootball_tournaments t
                   LEFT JOIN efootball_tournament_members tm ON tm.tournament_id=t.id AND tm.forfeited_at IS NULL
                   LEFT JOIN efootball_tournament_fixtures f ON f.tournament_id=t.id AND f.away_id IS NOT NULL
                  GROUP BY t.id ORDER BY t.id`
            ),
            pool.query(
                `WITH eat_day AS (SELECT (NOW() AT TIME ZONE 'Africa/Nairobi')::date AS local_date),
                 fixture_counts AS (
                    SELECT u.id,u.username,
                       (SELECT COUNT(*) FROM efootball_matches m,eat_day d
                         WHERE m.mode='ranked' AND m.opponent_id IS NOT NULL AND (m.creator_id=u.id OR m.opponent_id=u.id)
                           AND m.status<>'cancelled'
                           AND (m.created_at AT TIME ZONE 'Africa/Nairobi')::date=d.local_date)
                       + (SELECT COUNT(*) FROM efootball_league_fixtures f
                           JOIN efootball_league_rounds r ON r.league_id=f.league_id AND r.round_number=f.round_number,eat_day d
                          WHERE (f.home_id=u.id OR f.away_id=u.id) AND f.away_id IS NOT NULL AND f.status IN ('scheduled','playing','completed','walkover','draw')
                            AND (r.starts_at AT TIME ZONE 'Africa/Nairobi')::date=d.local_date)
                       + (SELECT COUNT(*) FROM efootball_tournament_fixtures f
                           JOIN efootball_tournament_rounds r ON r.tournament_id=f.tournament_id AND r.round_number=f.round_number,eat_day d
                          WHERE (f.home_id=u.id OR f.away_id=u.id) AND f.away_id IS NOT NULL AND f.status IN ('scheduled','playing','completed','walkover','draw')
                            AND (r.starts_at AT TIME ZONE 'Africa/Nairobi')::date=d.local_date)::int AS scheduled_fixtures
                      FROM users u WHERE u.account_status='active' AND u.game IN ('konami','both')
                 )
                 SELECT id,username,scheduled_fixtures,COUNT(*) OVER()::int AS total_count FROM fixture_counts
                  WHERE scheduled_fixtures<$1 ORDER BY scheduled_fixtures,username LIMIT 200`,
                [FOUR_MATCH_TARGET]
            ),
            pool.query(
                `SELECT l.id,l.name,l.status,COUNT(DISTINCT lm.id)::int AS players,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status IN ('scheduled','playing'))::int AS outstanding_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='scheduled')::int AS scheduled_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='playing')::int AS active_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status IN ('completed','draw'))::int AS completed_fixtures,
                        COUNT(DISTINCT f.id) FILTER (WHERE f.status='walkover')::int AS forfeited_fixtures,
                        COALESCE(MAX(r.round_number),0)::int AS current_round
                   FROM efootball_leagues l
                   LEFT JOIN efootball_league_members lm ON lm.league_id=l.id AND lm.forfeited_at IS NULL
                   LEFT JOIN efootball_league_fixtures f ON f.league_id=l.id AND f.away_id IS NOT NULL
                   LEFT JOIN efootball_league_rounds r ON r.league_id=f.league_id AND r.round_number=f.round_number
                  GROUP BY l.id ORDER BY l.id`
            ),
            pool.query(
                `SELECT reason,mode,COUNT(*)::int AS count
                   FROM efootball_matchmaking_rejections
                  WHERE created_at>=NOW()-INTERVAL '24 hours'
                  GROUP BY reason,mode ORDER BY count DESC,reason`
            ),
            pool.query(
                `SELECT event_type,message,details,created_at FROM efootball_scheduler_logs
                  WHERE event_type='scheduler_failed' AND created_at>=NOW()-INTERVAL '7 days'
                  ORDER BY created_at DESC LIMIT 20`
            ),
            pool.query(
                `SELECT event_type,message,details,created_at FROM efootball_scheduler_logs
                  WHERE event_type IN ('round_postponed','ranked_match_postponed')
                    AND created_at>=NOW()-INTERVAL '7 days'
                  ORDER BY created_at DESC LIMIT 30`
            )
        ]);
        return {
            window: state,
            tournaments: tournaments.rows.map(row => ({
                ...row,
                id: Number(row.id),
                players: Number(row.players),
                max_players: Number(row.max_players),
                outstanding_fixtures: Number(row.outstanding_fixtures),
                scheduled_fixtures: Number(row.scheduled_fixtures),
                active_fixtures: Number(row.active_fixtures),
                completed_fixtures: Number(row.completed_fixtures),
                forfeited_fixtures: Number(row.forfeited_fixtures),
                capacity_full: Number(row.players) >= Number(row.max_players)
            })),
            leagues: leagues.rows.map(row => ({
                ...row,
                id: Number(row.id),
                players: Number(row.players),
                max_players: 20,
                outstanding_fixtures: Number(row.outstanding_fixtures),
                scheduled_fixtures: Number(row.scheduled_fixtures),
                active_fixtures: Number(row.active_fixtures),
                completed_fixtures: Number(row.completed_fixtures),
                forfeited_fixtures: Number(row.forfeited_fixtures),
                current_round: Number(row.current_round)
            })),
            playersBelowFourFixtures: underTarget.rows.map(row => ({ ...row, id: Number(row.id), scheduled_fixtures: Number(row.scheduled_fixtures) })),
            playersBelowFourFixturesTotal: Number(underTarget.rows[0] && underTarget.rows[0].total_count || 0),
            rejectionSummary: rejectionSummary.rows,
            schedulerFailures: failures.rows,
            recentPostponements: postponements.rows
        };
    }

    return { start, stop, run, snapshot, dailyCounts };
}

module.exports = createEfootballScheduler;
