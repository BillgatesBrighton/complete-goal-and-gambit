"use strict";

const SEASON_TIME_ZONE = "Africa/Nairobi";
const GROUP_LOCK_PREFIX = "chess-tournament-payout:";

async function currentChessSeason(client) {
    const result = await client.query(
        "SELECT TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM') AS season_key"
    );
    return String(result.rows[0].season_key);
}

async function lockChessTournamentGroup(client, seasonKey, timeControl, stakeAmount, mode) {
    if (!/^\d{4}-\d{2}$/.test(String(seasonKey || "")) || !timeControl || !Number.isFinite(Number(stakeAmount))) {
        throw new Error("A valid chess tournament group is required for synchronization.");
    }
    const lockMode = mode || "shared";
    if (lockMode !== "shared" && lockMode !== "exclusive") {
        throw new Error("Invalid chess tournament group lock mode.");
    }
    await client.query("SET LOCAL lock_timeout = '10s'");
    const fn = lockMode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
    const key = GROUP_LOCK_PREFIX + seasonKey + ":" + timeControl + ":" + Number(stakeAmount).toString();
    await client.query("SELECT " + fn + "(hashtextextended($1,0))", [key]);
    await client.query(
        `INSERT INTO chess_tournament_groups(season_key,time_control,stake_amount,closes_at)
         VALUES($1::text,$2,$3,(to_date($1::text || '-01','YYYY-MM-DD') + INTERVAL '1 month') AT TIME ZONE 'Africa/Nairobi')
         ON CONFLICT(season_key,time_control,stake_amount) DO NOTHING`,
        [seasonKey,timeControl,Number(stakeAmount)]
    );
    const group = await client.query(
        `SELECT status FROM chess_tournament_groups
          WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3`,
        [seasonKey,timeControl,Number(stakeAmount)]
    );
    if (!group.rows.length) throw new Error("Chess tournament group state could not be created.");
    if (lockMode === "shared" && group.rows[0].status === "settled") {
        throw Object.assign(new Error("This chess tournament group has already been settled."), { status: 409 });
    }
}

async function lockChessMatchGroup(client, matchId, mode) {
    const result = await client.query(
        "SELECT match_type,season_key,time_control,stake_amount FROM chess_matches WHERE id=$1",
        [matchId]
    );
    if (!result.rows.length) return null;
    const match = result.rows[0];
    if (match.match_type !== "tournament") return match;
    // Legacy rows intentionally remain unassigned. They stay playable under
    // their existing rules but are excluded from automatic season settlement.
    if (!match.season_key) return match;
    await lockChessTournamentGroup(client, match.season_key, match.time_control, match.stake_amount, mode || "shared");
    return match;
}

module.exports = { SEASON_TIME_ZONE, currentChessSeason, lockChessTournamentGroup, lockChessMatchGroup };
