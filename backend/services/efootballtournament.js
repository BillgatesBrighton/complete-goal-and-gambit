"use strict";

const ROUND_DURATION_MINUTES = 20;
const LEAGUE_ROUND_DURATION_MINUTES = 25;

function pairingsForRound(players, roundNumber) {
    const circle = players.slice();
    if (circle.length < 2) return [];
    if (circle.length % 2) circle.push(null);

    const count = circle.length;
    const roundsPerCycle = count - 1;
    const rotation = (Math.max(1, Number(roundNumber) || 1) - 1) % roundsPerCycle;
    for (let turn = 0; turn < rotation; turn += 1) {
        const last = circle.pop();
        circle.splice(1, 0, last);
    }

    const pairings = [];
    for (let index = 0; index < count / 2; index += 1) {
        const home = circle[index];
        const away = circle[count - 1 - index];
        if (home) pairings.push({ home, away: away || null });
        else if (away) pairings.push({ home: away, away: null });
    }
    return pairings;
}

async function recordFixtureResult(client, fixture, result) {
    if (["completed", "walkover", "draw", "bye"].includes(String(fixture.status))) return false;

    const homeId = Number(fixture.home_id);
    const awayId = fixture.away_id == null ? null : Number(fixture.away_id);
    const homeScore = Number(result.homeScore || 0);
    const awayScore = Number(result.awayScore || 0);
    const status = result.status || "draw";
    const winnerId = result.winnerId == null ? null : Number(result.winnerId);

    if (awayId !== null) {
        const homeWin = winnerId === homeId ? 1 : 0;
        const awayWin = winnerId === awayId ? 1 : 0;
        const draw = winnerId === null ? 1 : 0;
        await client.query(
            `UPDATE efootball_tournament_members
                SET played=played+1,
                    wins=wins+$1, draws=draws+$2, losses=losses+$3,
                    points=points+$4, goal_difference=goal_difference+$5,
                    goals_for=goals_for+$6, goals_against=goals_against+$7
              WHERE tournament_id=$8 AND user_id=$9`,
            [homeWin, draw, awayWin, homeWin * 3 + draw, homeScore - awayScore, homeScore, awayScore, fixture.tournament_id, homeId]
        );
        await client.query(
            `UPDATE efootball_tournament_members
                SET played=played+1,
                    wins=wins+$1, draws=draws+$2, losses=losses+$3,
                    points=points+$4, goal_difference=goal_difference+$5,
                    goals_for=goals_for+$6, goals_against=goals_against+$7
              WHERE tournament_id=$8 AND user_id=$9`,
            [awayWin, draw, homeWin, awayWin * 3 + draw, awayScore - homeScore, awayScore, homeScore, fixture.tournament_id, awayId]
        );
    }

    await client.query(
        `UPDATE efootball_tournament_fixtures
            SET status=$1, home_score=$2, away_score=$3, winner_id=$4, resolved_at=NOW()
          WHERE id=$5`,
        [status, homeScore, awayScore, winnerId, fixture.id]
    );
    return true;
}

async function recordLeagueFixtureResult(client, fixture, result) {
    if (["completed", "walkover", "draw", "bye"].includes(String(fixture.status))) return false;
    const homeId = Number(fixture.home_id);
    const awayId = fixture.away_id == null ? null : Number(fixture.away_id);
    const homeScore = Number(result.homeScore || 0);
    const awayScore = Number(result.awayScore || 0);
    const winnerId = result.winnerId == null ? null : Number(result.winnerId);
    const status = result.status || "draw";
    if (awayId !== null) {
        const homeWin = winnerId === homeId ? 1 : 0;
        const awayWin = winnerId === awayId ? 1 : 0;
        const draw = winnerId === null ? 1 : 0;
        await client.query(
            `UPDATE efootball_league_members
                SET played=played+1,wins=wins+$1,draws=draws+$2,losses=losses+$3,
                    points=points+$4,goal_difference=goal_difference+$5,
                    goals_for=goals_for+$6,goals_against=goals_against+$7
              WHERE league_id=$8 AND user_id=$9`,
            [homeWin, draw, awayWin, homeWin * 3 + draw, homeScore - awayScore, homeScore, awayScore, fixture.league_id, homeId]
        );
        await client.query(
            `UPDATE efootball_league_members
                SET played=played+1,wins=wins+$1,draws=draws+$2,losses=losses+$3,
                    points=points+$4,goal_difference=goal_difference+$5,
                    goals_for=goals_for+$6,goals_against=goals_against+$7
              WHERE league_id=$8 AND user_id=$9`,
            [awayWin, draw, homeWin, awayWin * 3 + draw, awayScore - homeScore, awayScore, homeScore, fixture.league_id, awayId]
        );
    }
    await client.query(
        `UPDATE efootball_league_fixtures
            SET status=$1,home_score=$2,away_score=$3,winner_id=$4,resolved_at=NOW()
          WHERE id=$5`,
        [status, homeScore, awayScore, winnerId, fixture.id]
    );
    return true;
}

async function resolveExpiredRound(client, round) {
    const fixtures = await client.query(
        `SELECT f.*, m.id AS linked_match_id, m.creator_id, m.opponent_id, m.status AS match_status,
                m.creator_score, m.opponent_score, m.result_status, m.settled_at
           FROM efootball_tournament_fixtures f
           LEFT JOIN efootball_matches m ON m.id=f.match_id
          WHERE f.tournament_id=$1 AND f.round_number=$2 AND f.status IN ('scheduled','playing')
          ORDER BY f.id
          FOR UPDATE OF f`,
        [round.tournament_id, round.round_number]
    );

    for (const fixture of fixtures.rows) {
        if (fixture.away_id == null) {
            await client.query(
                "UPDATE efootball_tournament_fixtures SET status='bye',resolved_at=NOW() WHERE id=$1",
                [fixture.id]
            );
            continue;
        }

        const linkedMatch = fixture.linked_match_id ? {
            id: Number(fixture.linked_match_id),
            creatorId: Number(fixture.creator_id),
            opponentId: fixture.opponent_id == null ? null : Number(fixture.opponent_id),
            status: String(fixture.match_status || ""),
            creatorScore: fixture.creator_score,
            opponentScore: fixture.opponent_score,
            resultStatus: fixture.result_status,
            settledAt: fixture.settled_at
        } : null;

        if (linkedMatch && linkedMatch.status === "completed") {
            const homeScore = Number(linkedMatch.creatorScore || 0) * (linkedMatch.creatorId === Number(fixture.home_id) ? 1 : 0) +
                Number(linkedMatch.opponentScore || 0) * (linkedMatch.opponentId === Number(fixture.home_id) ? 1 : 0);
            const awayScore = Number(linkedMatch.creatorScore || 0) * (linkedMatch.creatorId === Number(fixture.away_id) ? 1 : 0) +
                Number(linkedMatch.opponentScore || 0) * (linkedMatch.opponentId === Number(fixture.away_id) ? 1 : 0);
            const winnerId = homeScore > awayScore ? Number(fixture.home_id) : awayScore > homeScore ? Number(fixture.away_id) : null;
            await client.query(
                `UPDATE efootball_tournament_fixtures SET status=$1,home_score=$2,away_score=$3,winner_id=$4,resolved_at=COALESCE(resolved_at,NOW()) WHERE id=$5`,
                [linkedMatch.resultStatus === "walkover" ? "walkover" : "completed", homeScore, awayScore, winnerId, fixture.id]
            );
            continue;
        }

        if (linkedMatch && linkedMatch.status === "disputed") {
            await client.query("UPDATE efootball_tournament_fixtures SET status='disputed' WHERE id=$1", [fixture.id]);
            continue;
        }

        if (linkedMatch && ["waiting", "ready", "playing", "awaiting_verification"].includes(linkedMatch.status)) {
            await client.query(
                `UPDATE efootball_matches
                    SET creator_score=0, opponent_score=0, winner_id=NULL,
                        status='completed', result_status='round_timeout_draw',
                        finished_at=NOW(), settled_at=NOW()
                  WHERE id=$1 AND settled_at IS NULL`,
                [linkedMatch.id]
            );
            await client.query(
                `UPDATE efootball_result_verifications
                    SET status='round_timeout', score_check='round_timeout'
                  WHERE match_id=$1 AND status NOT IN ('verified','review_required')`,
                [linkedMatch.id]
            );
        }

        await recordFixtureResult(client, fixture, { status: "draw", homeScore: 0, awayScore: 0, winnerId: null });
    }

    await client.query(
        "UPDATE efootball_tournament_rounds SET completed_at=NOW() WHERE id=$1 AND completed_at IS NULL",
        [round.id]
    );
}

async function createRound(client, tournamentId, roundNumber) {
    const inserted = await client.query(
        `INSERT INTO efootball_tournament_rounds(tournament_id,round_number)
         VALUES($1,$2)
         ON CONFLICT(tournament_id,round_number) DO UPDATE SET tournament_id=EXCLUDED.tournament_id
         RETURNING *`,
        [tournamentId, roundNumber]
    );
    const round = inserted.rows[0];
    const members = await client.query(
        `SELECT user_id,group_code
           FROM efootball_tournament_members
          WHERE tournament_id=$1 AND forfeited_at IS NULL
          ORDER BY group_code,joined_at,id`,
        [tournamentId]
    );
    const groups = new Map();
    for (const member of members.rows) {
        if (!groups.has(member.group_code)) groups.set(member.group_code, []);
        groups.get(member.group_code).push(Number(member.user_id));
    }

    for (const [groupCode, users] of groups.entries()) {
        const pairings = pairingsForRound(users, roundNumber);
        for (const pairing of pairings) {
            await client.query(
                `INSERT INTO efootball_tournament_fixtures
                    (tournament_id,round_number,group_code,home_id,away_id,status)
                 VALUES($1,$2,$3,$4,$5,$6)
                 ON CONFLICT DO NOTHING`,
                [tournamentId, roundNumber, groupCode, pairing.home, pairing.away, pairing.away ? "scheduled" : "bye"]
            );
        }
    }
    return round;
}

async function ensureTournamentRound(client, tournamentId, startIfNeeded) {
    const tournamentResult = await client.query(
        "SELECT id,status FROM efootball_tournaments WHERE id=$1 FOR UPDATE",
        [tournamentId]
    );
    if (!tournamentResult.rows.length || tournamentResult.rows[0].status !== "open") return null;

    let latestResult = await client.query(
        `SELECT * FROM efootball_tournament_rounds
          WHERE tournament_id=$1
          ORDER BY round_number DESC LIMIT 1 FOR UPDATE`,
        [tournamentId]
    );
    let latest = latestResult.rows[0] || null;

    if (latest && latest.deadline_at && !latest.completed_at && new Date(latest.deadline_at).getTime() <= Date.now()) {
        await resolveExpiredRound(client, latest);
        latest = (await client.query(
            "SELECT * FROM efootball_tournament_rounds WHERE tournament_id=$1 ORDER BY round_number DESC LIMIT 1 FOR UPDATE",
            [tournamentId]
        )).rows[0];
    }

    if (!latest || latest.completed_at) {
        const roundJustClosed = Boolean(latest && latest.completed_at);
        const nextRound = latest ? Number(latest.round_number) + 1 : 1;
        latest = await createRound(client, tournamentId, nextRound);
        if ((startIfNeeded || roundJustClosed) && !latest.deadline_at) {
            latest = (await client.query(
                `UPDATE efootball_tournament_rounds
                    SET starts_at=NOW(), deadline_at=NOW()+($2::int * INTERVAL '1 minute')
                  WHERE id=$1 AND deadline_at IS NULL AND completed_at IS NULL
                  RETURNING *`,
                [latest.id, ROUND_DURATION_MINUTES]
            )).rows[0] || latest;
        }
    } else if (!latest.deadline_at) {
        // Before the first match starts, refresh scheduled pairings so players
        // who joined during registration are included in the opening round.
        const activeMatch = await client.query(
            "SELECT 1 FROM efootball_tournament_fixtures WHERE tournament_id=$1 AND round_number=$2 AND match_id IS NOT NULL LIMIT 1",
            [tournamentId, latest.round_number]
        );
        if (!activeMatch.rows.length) {
            await client.query(
                "DELETE FROM efootball_tournament_fixtures WHERE tournament_id=$1 AND round_number=$2 AND status IN ('scheduled','bye')",
                [tournamentId, latest.round_number]
            );
            latest = await createRound(client, tournamentId, Number(latest.round_number));
        }
    }

    if (startIfNeeded && !latest.deadline_at && !latest.completed_at) {
        latest = (await client.query(
            `UPDATE efootball_tournament_rounds
                SET starts_at=NOW(), deadline_at=NOW()+($2::int * INTERVAL '1 minute')
              WHERE id=$1 AND deadline_at IS NULL AND completed_at IS NULL
              RETURNING *`,
            [latest.id, ROUND_DURATION_MINUTES]
        )).rows[0] || latest;
    }
    return latest;
}

async function resolveExpiredLeagueRound(client, round) {
    const fixtures = await client.query(
        `SELECT f.*,m.id AS linked_match_id,m.creator_id,m.opponent_id,m.status AS match_status,
                m.creator_score,m.opponent_score,m.result_status
           FROM efootball_league_fixtures f LEFT JOIN efootball_matches m ON m.id=f.match_id
          WHERE f.league_id=$1 AND f.round_number=$2 AND f.status IN ('scheduled','playing')
          ORDER BY f.id FOR UPDATE OF f`,
        [round.league_id, round.round_number]
    );
    for (const fixture of fixtures.rows) {
        if (fixture.away_id == null) {
            await client.query("UPDATE efootball_league_fixtures SET status='bye',resolved_at=NOW() WHERE id=$1", [fixture.id]);
            continue;
        }
        if (fixture.linked_match_id && fixture.match_status === "completed") {
            const homeScore = Number(fixture.creator_id) === Number(fixture.home_id)
                ? Number(fixture.creator_score || 0) : Number(fixture.opponent_score || 0);
            const awayScore = Number(fixture.creator_id) === Number(fixture.away_id)
                ? Number(fixture.creator_score || 0) : Number(fixture.opponent_score || 0);
            const winnerId = homeScore > awayScore ? Number(fixture.home_id) : awayScore > homeScore ? Number(fixture.away_id) : null;
            await client.query(
                "UPDATE efootball_league_fixtures SET status=$1,home_score=$2,away_score=$3,winner_id=$4,resolved_at=COALESCE(resolved_at,NOW()) WHERE id=$5",
                [fixture.result_status === "walkover" ? "walkover" : "completed", homeScore, awayScore, winnerId, fixture.id]
            );
            continue;
        }
        if (fixture.linked_match_id && fixture.match_status === "disputed") {
            await client.query("UPDATE efootball_league_fixtures SET status='disputed' WHERE id=$1", [fixture.id]);
            continue;
        }
        if (fixture.linked_match_id && ["waiting", "ready", "playing", "awaiting_verification"].includes(fixture.match_status)) {
            await client.query(
                `UPDATE efootball_matches SET creator_score=0,opponent_score=0,winner_id=NULL,
                        status='completed',result_status='round_timeout_draw',finished_at=NOW(),settled_at=NOW()
                  WHERE id=$1 AND settled_at IS NULL`,
                [fixture.linked_match_id]
            );
            await client.query(
                "UPDATE efootball_result_verifications SET status='round_timeout',score_check='round_timeout' WHERE match_id=$1 AND status NOT IN ('verified','review_required')",
                [fixture.linked_match_id]
            );
        }
        await recordLeagueFixtureResult(client, fixture, { status: "draw", homeScore: 0, awayScore: 0, winnerId: null });
    }
    await client.query("UPDATE efootball_league_rounds SET completed_at=NOW() WHERE id=$1 AND completed_at IS NULL", [round.id]);
}

async function createLeagueRound(client, leagueId, roundNumber) {
    const inserted = await client.query(
        `INSERT INTO efootball_league_rounds(league_id,round_number) VALUES($1,$2)
         ON CONFLICT(league_id,round_number) DO UPDATE SET league_id=EXCLUDED.league_id RETURNING *`,
        [leagueId, roundNumber]
    );
    const members = await client.query(
        "SELECT user_id FROM efootball_league_members WHERE league_id=$1 AND forfeited_at IS NULL ORDER BY user_id",
        [leagueId]
    );
    for (const pairing of pairingsForRound(members.rows.map(row => Number(row.user_id)), roundNumber)) {
        await client.query(
            `INSERT INTO efootball_league_fixtures(league_id,round_number,home_id,away_id,status)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [leagueId, roundNumber, pairing.home, pairing.away, pairing.away ? "scheduled" : "bye"]
        );
    }
    return inserted.rows[0];
}

async function ensureLeagueRound(client, leagueId, startIfNeeded) {
    const league = await client.query("SELECT id FROM efootball_leagues WHERE id=$1 FOR UPDATE", [leagueId]);
    if (!league.rows.length) return null;
    const memberCount = await client.query(
        "SELECT COUNT(*)::int AS count FROM efootball_league_members WHERE league_id=$1 AND forfeited_at IS NULL",
        [leagueId]
    );
    const players = Number(memberCount.rows[0] && memberCount.rows[0].count || 0);
    let latest = (await client.query(
        "SELECT * FROM efootball_league_rounds WHERE league_id=$1 ORDER BY round_number DESC LIMIT 1 FOR UPDATE",
        [leagueId]
    )).rows[0] || null;
    // A league needs two enrolled players before it publishes fixtures or
    // starts its 25-minute round clock. This also lets a second signup join
    // the initial pairing instead of arriving after a one-player bye round.
    if (players < 2) return latest;
    if (latest && latest.deadline_at && !latest.completed_at && new Date(latest.deadline_at).getTime() <= Date.now()) {
        await resolveExpiredLeagueRound(client, latest);
        latest = (await client.query(
            "SELECT * FROM efootball_league_rounds WHERE league_id=$1 ORDER BY round_number DESC LIMIT 1 FOR UPDATE",
            [leagueId]
        )).rows[0];
    }
    if (!latest || latest.completed_at) {
        const roundJustClosed = Boolean(latest && latest.completed_at);
        latest = await createLeagueRound(client, leagueId, latest ? Number(latest.round_number) + 1 : 1);
        if ((startIfNeeded || roundJustClosed) && latest && !latest.deadline_at) {
            latest = (await client.query(
                `UPDATE efootball_league_rounds SET starts_at=NOW(),deadline_at=NOW()+($2::int*INTERVAL '1 minute')
                  WHERE id=$1 AND deadline_at IS NULL AND completed_at IS NULL RETURNING *`,
                [latest.id, LEAGUE_ROUND_DURATION_MINUTES]
            )).rows[0] || latest;
        }
    } else if (!latest.deadline_at) {
        const activeMatch = await client.query(
            "SELECT 1 FROM efootball_league_fixtures WHERE league_id=$1 AND round_number=$2 AND match_id IS NOT NULL LIMIT 1",
            [leagueId, latest.round_number]
        );
        if (!activeMatch.rows.length) {
            await client.query("DELETE FROM efootball_league_fixtures WHERE league_id=$1 AND round_number=$2 AND status IN ('scheduled','bye')", [leagueId, latest.round_number]);
            latest = await createLeagueRound(client, leagueId, Number(latest.round_number));
        }
    }
    if (startIfNeeded && latest && !latest.deadline_at && !latest.completed_at) {
        latest = (await client.query(
            `UPDATE efootball_league_rounds SET starts_at=NOW(),deadline_at=NOW()+($2::int*INTERVAL '1 minute')
              WHERE id=$1 AND deadline_at IS NULL AND completed_at IS NULL RETURNING *`,
            [latest.id, LEAGUE_ROUND_DURATION_MINUTES]
        )).rows[0] || latest;
    }
    return latest;
}

module.exports = {
    ROUND_DURATION_MINUTES,
    LEAGUE_ROUND_DURATION_MINUTES,
    ensureTournamentRound,
    ensureLeagueRound,
    recordFixtureResult,
    recordLeagueFixtureResult
};
