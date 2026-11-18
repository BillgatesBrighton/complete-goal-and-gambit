"use strict";

const { creditPlatform } = require("./adminWalletAccounting");
const { lockChessTournamentGroup } = require("./chessTournamentSync");
const { recordJournal } = require("./financialLedger");

function parseOptionalSchedule(body) {
    body = body || {};
    const parse = (value, field) => {
        if (value == null || value === "") return null;
        if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
            throw Object.assign(new Error(field + " must include an explicit timezone offset."), { status: 400 });
        }
        const time = Date.parse(value);
        if (!Number.isFinite(time)) throw Object.assign(new Error("Invalid " + field + "."), { status: 400 });
        return new Date(time);
    };
    const scheduledAt = parse(body.scheduledAt, "scheduledAt");
    const deadlineAt = parse(body.deadlineAt, "deadlineAt");
    if (deadlineAt && !scheduledAt) {
        throw Object.assign(new Error("A deadline requires an explicitly configured schedule."), { status: 400 });
    }
    if (deadlineAt && deadlineAt <= scheduledAt) {
        throw Object.assign(new Error("The match deadline must be after its scheduled start."), { status: 400 });
    }
    return { scheduledAt, deadlineAt };
}

async function processDueChessTournamentMatches(pool, limit) {
    const due = await pool.query(
        `SELECT id FROM chess_matches
          WHERE match_type='tournament' AND season_key IS NOT NULL AND status='waiting'
            AND scheduled_at IS NOT NULL
            AND scheduled_at<=clock_timestamp()
            AND ((player_black_id IS NOT NULL AND white_ready_at IS NOT NULL AND black_ready_at IS NOT NULL)
                 OR (deadline_at IS NOT NULL AND deadline_at<=clock_timestamp()))
          ORDER BY COALESCE(deadline_at,scheduled_at),id LIMIT $1`,
        [Math.max(1, Math.min(200, Number(limit) || 100))]
    );
    const outcomes = [];
    for (const item of due.rows) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const preview = await client.query(
                "SELECT season_key,time_control,stake_amount FROM chess_matches WHERE id=$1 AND match_type='tournament'",
                [item.id]
            );
            if (!preview.rows.length || !preview.rows[0].season_key) {
                await client.query("ROLLBACK");
                continue;
            }
            const group = preview.rows[0];
            await lockChessTournamentGroup(client, group.season_key, group.time_control, group.stake_amount, "shared");
            const locked = await client.query("SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE", [item.id]);
            if (!locked.rows.length || locked.rows[0].status !== "waiting") {
                await client.query("COMMIT");
                continue;
            }
            const match = locked.rows[0];
            const validReady = (readyAt) => readyAt && (!match.deadline_at || new Date(readyAt) <= new Date(match.deadline_at));
            const whiteReady = Boolean(validReady(match.white_ready_at));
            const blackReady = Boolean(validReady(match.black_ready_at));
            const nowResult = await client.query("SELECT clock_timestamp() AS now");
            const now = new Date(nowResult.rows[0].now);
            const deadlinePassed = Boolean(match.deadline_at && now >= new Date(match.deadline_at));

            // A one-player search is not a no-show match. Once its deadline
            // passes, return the sole reserved stake and cancel the queue in
            // this transaction. The match row lock serializes this against a
            // concurrent join; a later join observes the terminal status.
            if (!match.player_black_id) {
                if (!deadlinePassed) {
                    await client.query("COMMIT");
                    continue;
                }
                const playerId = Number(match.player_white_id);
                if (!Number.isSafeInteger(playerId) || playerId <= 0) {
                    throw new Error("Expired Chess tournament queue has no valid waiting player.");
                }
                const stake = Number(match.stake_amount || 0);
                if (!Number.isFinite(stake) || stake < 0) {
                    throw new Error("Expired Chess tournament queue has an invalid stake.");
                }
                if (stake > 0) {
                    await client.query("SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE", [playerId]);
                    const wallet = await client.query(
                        `UPDATE wallets SET balance=balance+$1,locked_balance=locked_balance-$1,updated_at=clock_timestamp()
                          WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`, [stake,playerId]
                    );
                    if (wallet.rowCount !== 1) throw new Error("The expired queue stake could not be refunded safely.");
                    const obligation = await client.query(
                        `UPDATE chess_match_financial_dispositions
                            SET disposition='refunded',reference=$3,settled_at=clock_timestamp()
                          WHERE match_id=$1 AND user_id=$2 AND disposition='pending'
                            AND stake_amount=$4 RETURNING user_id`,
                        [match.id,playerId,`CHESS-CANCEL-${match.id}-${playerId}`,stake]
                    );
                    if (obligation.rowCount !== 1) throw new Error("The expired queue stake disposition is missing or already settled.");
                    const reference = `CHESS-CANCEL-${match.id}-${playerId}`;
                    await client.query(
                        `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                         VALUES($1,'match_refund',$2,'KES','completed',$3,$4)`,
                        [playerId,stake,reference,"Scheduled Chess tournament search expired - stake refunded"]
                    );
                    await recordJournal(client, {
                        reference: `CHESS-STAKE-UNLOCK-${reference}`,
                        transactionType: "chess_stake_refund",
                        amount: stake,
                        description: "Scheduled Chess tournament queue expired before an opponent joined",
                        context: { userId: playerId, matchId: Number(match.id), seasonKey: match.season_key, transactionReference: reference },
                        postings: [
                            { accountType: "chess_match_locked", accountId: playerId, debit: stake },
                            { accountType: "user_wallet_available", accountId: playerId, credit: stake }
                        ]
                    });
                }
                const cancelled = await client.query(
                    `UPDATE chess_matches SET status='cancelled',finished_at=clock_timestamp(),settled_at=clock_timestamp(),payout_status='refunded'
                      WHERE id=$1 AND status='waiting' AND player_black_id IS NULL RETURNING id`, [match.id]
                );
                if (cancelled.rowCount !== 1) throw new Error("The expired Chess tournament queue changed before cancellation.");
                await client.query("COMMIT");
                outcomes.push({ matchId: Number(match.id), outcome: "cancelled_refunded", amount: stake });
                continue;
            }
            if (whiteReady && blackReady && now >= new Date(match.scheduled_at)) {
                await client.query(
                    `UPDATE chess_matches SET status='active',started_at=clock_timestamp(),last_move_at=clock_timestamp(),active_color='w'
                      WHERE id=$1 AND status='waiting'`, [match.id]
                );
                await client.query("COMMIT");
                outcomes.push({ matchId: Number(match.id), outcome: "started" });
                continue;
            }
            if (!deadlinePassed) {
                await client.query("COMMIT");
                continue;
            }

            if (whiteReady !== blackReady) {
                const winnerId = Number(whiteReady ? match.player_white_id : match.player_black_id);
                await client.query(
                    `UPDATE chess_matches SET status='completed',result='walkover',winner_id=$1,
                            finished_at=clock_timestamp(),settled_at=clock_timestamp(),payout_status='pending_competition'
                      WHERE id=$2 AND status='waiting'`, [winnerId, match.id]
                );
                await client.query("COMMIT");
                outcomes.push({ matchId: Number(match.id), outcome: "walkover", winnerId });
                continue;
            }

            const obligations = await client.query(
                `SELECT user_id,stake_amount,disposition FROM chess_match_financial_dispositions
                  WHERE match_id=$1 ORDER BY user_id FOR UPDATE`, [match.id]
            );
            const playerIds = [Number(match.player_white_id), Number(match.player_black_id)].sort((a,b)=>a-b);
            if (obligations.rows.length !== 2 || obligations.rows.some((row,index) =>
                Number(row.user_id) !== playerIds[index] || row.disposition !== "pending" ||
                Number(row.stake_amount) !== Number(match.stake_amount))) {
                throw new Error("Double-no-show match is missing exactly two pending stake dispositions; expiry was rolled back.");
            }
            const amountPerPlayer = Number(match.stake_amount || 0);
            const total = amountPerPlayer * 2;
            for (const userId of playerIds) {
                const wallet = await client.query(
                    `UPDATE wallets SET locked_balance=locked_balance-$1,updated_at=clock_timestamp()
                      WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`, [amountPerPlayer,userId]
                );
                if (wallet.rowCount !== 1) throw new Error("A no-show stake is not fully locked; expiry was rolled back.");
                const reference = `CHESS-NOSHOW-${match.id}-${userId}`;
                await client.query(
                    `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'chess_tournament_no_show',$2,'KES','completed',$3,$4)`,
                    [userId,amountPerPlayer,reference,`Chess tournament match ${match.id} expired after neither player marked Ready`]
                );
            }
            const platformReference = `CHESS-NOSHOW-POOL-${match.id}`;
            await creditPlatform(client, {
                amount: total,
                reference: platformReference,
                transactionType: "chess_tournament_no_show_forfeit",
                description: `Chess tournament match ${match.id} double-no-show stakes reserved for administrators`,
                reserve: true,
                context: { matchId: Number(match.id), seasonKey: match.season_key, result: "no_contest" },
                debitPostings: playerIds.map(userId => ({ accountType: "chess_match_locked", accountId: userId, debit: amountPerPlayer }))
            });
            await client.query(
                `UPDATE chess_match_financial_dispositions SET disposition='admin_forfeited',reference=$1,settled_at=clock_timestamp()
                  WHERE match_id=$2 AND disposition='pending'`, [platformReference,match.id]
            );
            await client.query(
                `UPDATE chess_matches SET status='completed',result='no_contest',winner_id=NULL,
                        finished_at=clock_timestamp(),settled_at=clock_timestamp(),payout_status='forfeited'
                  WHERE id=$1 AND status='waiting'`, [match.id]
            );
            await client.query("COMMIT");
            outcomes.push({ matchId: Number(match.id), outcome: "no_contest", amount: total });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }
    return outcomes;
}

module.exports = { parseOptionalSchedule, processDueChessTournamentMatches };
