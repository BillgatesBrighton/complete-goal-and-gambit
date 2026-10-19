"use strict";

const crypto = require("crypto");
const { creditPlatform, debitPlatformAvailable, releasePlatformReservation, lockPlatformWallets } = require("./adminWalletAccounting");

const PODIUM_WEIGHTS = [5, 4, 3];

function amountToCents(value) {
    return Math.max(0, Math.round(Number(value || 0) * 100));
}

function allocateCents(total, weights) {
    const sum = weights.reduce((value, weight) => value + weight, 0);
    if (!total || !sum || !weights.length) return weights.map(() => 0);
    const result = weights.map((weight) => Math.floor(total * weight / sum));
    let remainder = total - result.reduce((value, amount) => value + amount, 0);
    for (let index = 0; remainder > 0; index = (index + 1) % result.length) {
        result[index] += 1;
        remainder -= 1;
    }
    return result;
}

function distributePrizePoolCents(totalPoolCents, eligibleCount) {
    if (!Number.isSafeInteger(totalPoolCents) || totalPoolCents < 0) throw new Error("Invalid collected entry pool.");
    const count = Math.max(0, Math.min(3, Number(eligibleCount) || 0));
    const allShares = PODIUM_WEIGHTS.map((weight) => Math.floor(totalPoolCents * weight / 12));
    if (count === 3) {
        let remainder = totalPoolCents - allShares.reduce((sum, amount) => sum + amount, 0);
        const order = PODIUM_WEIGHTS.map((weight, index) => ({ index, remainder: totalPoolCents * weight % 12 }))
            .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
        for (let index = 0; remainder > 0; index += 1, remainder -= 1) allShares[order[index % 3].index] += 1;
    }
    const awards = allShares.slice(0, count);
    return { awards, retainedCents: totalPoolCents - awards.reduce((sum, amount) => sum + amount, 0) };
}

/**
 * Settle only finalized competitions, from the actual paid membership fees.
 * The prize pool uses a 5:4:3 split. Any share without an eligible podium
 * recipient remains in the platform wallet; entry fees are never refunded.
 */
async function settleEfootballCompetition(client, type, competition, seasonKey) {
    const competitionId = Number(competition.id);
    const competitionType = type === "tournament" ? "tournament" : "league";
    const table = competitionType === "tournament" ? "efootball_tournament_members" : "efootball_league_members";
    const foreignKey = competitionType === "tournament" ? "tournament_id" : "league_id";
    if (competition.status && competition.status !== "completed") throw new Error("Competition results are not finalized yet.");

    const alreadySettled = await client.query(
        `SELECT 1 FROM efootball_competition_settlements
          WHERE competition_type=$1 AND competition_id=$2 AND season_key=$3 LIMIT 1`,
        [competitionType, competitionId, seasonKey]
    );
    if (alreadySettled.rows.length) return { alreadySettled: true };

    const members = await client.query(
        `SELECT m.user_id,u.username,m.fee_paid,m.fee_transferred,m.entry_reference,m.forfeited_at,
                m.played,m.wins,m.draws,m.losses,m.points,m.goal_difference,m.goals_for,m.goals_against
           FROM ${table} m JOIN users u ON u.id=m.user_id
          WHERE m.${foreignKey}=$1
          ORDER BY m.forfeited_at NULLS FIRST,m.points DESC,m.wins DESC,m.goal_difference DESC,
                   m.goals_for DESC,m.user_id ASC
          FOR UPDATE OF m`,
        [competitionId]
    );
    if (!members.rows.length) return { alreadySettled: false, participants: 0, pool: 0, awards: [], retainedRevenue: 0 };

    const entrants = members.rows.map((row) => ({
        userId: Number(row.user_id), username: String(row.username),
        rank: row.forfeited_at ? null : 0, feeCents: amountToCents(row.fee_paid),
        prizeCents: 0, feeTransferred: Boolean(row.fee_transferred),
        entryReference: row.entry_reference || null, forfeited: Boolean(row.forfeited_at), played: Number(row.played || 0)
    }));
    const poolCents = entrants.reduce((sum, member) => sum + member.feeCents, 0);
    const winners = entrants.filter((member) => !member.forfeited && member.played > 0).slice(0, 3);
    winners.forEach((member, index) => { member.rank = index + 1; });
    const distribution = distributePrizePoolCents(poolCents, winners.length);
    winners.forEach((member, index) => { member.prizeCents = distribution.awards[index] || 0; });

    // Backward compatibility: older entries were left in player locked balances.
    // Move those fees to the admin reserve atomically before settlement.
    const legacyEntries = entrants.filter((member) => member.feeCents > 0 && !member.feeTransferred);
    if (legacyEntries.length) {
        await lockPlatformWallets(client);
        const legacyWallets = await client.query(
            `SELECT user_id,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE`,
            [legacyEntries.map((member) => member.userId)]
        );
        const byUser = new Map(legacyWallets.rows.map((row) => [Number(row.user_id), row]));
        for (const member of legacyEntries) {
            const wallet = byUser.get(member.userId);
            if (!wallet || amountToCents(wallet.locked_balance) < member.feeCents) {
                throw new Error("A legacy competition fee is not fully held; payout was held for reconciliation.");
            }
            const obligations = await client.query(
                `SELECT
                    COALESCE((SELECT SUM(fee_paid) FROM efootball_league_members
                               WHERE user_id=$1 AND fee_paid>0 AND fee_transferred=FALSE),0)
                  + COALESCE((SELECT SUM(fee_paid) FROM efootball_tournament_members
                               WHERE user_id=$1 AND fee_paid>0 AND fee_transferred=FALSE),0)
                  + COALESCE((SELECT SUM(stake_amount) FROM efootball_matches
                               WHERE (creator_id=$1 OR opponent_id=$1) AND stake_amount>0
                                 AND settled_at IS NULL AND status NOT IN ('cancelled')),0)
                  + COALESCE((SELECT SUM(stake_amount) FROM chess_matches
                               WHERE (player_white_id=$1 OR player_black_id=$1) AND stake_amount>0
                                 AND (status NOT IN ('completed','cancelled') OR
                                      (match_type='tournament' AND payout_status='pending_competition'))),0) AS held_obligations`,
                [member.userId]
            );
            if (amountToCents(wallet.locked_balance) < amountToCents(obligations.rows[0] && obligations.rows[0].held_obligations)) {
                throw new Error("A legacy entry fee overlaps other locked matches or entries; settlement was held for reconciliation.");
            }
            await client.query("UPDATE wallets SET locked_balance=locked_balance-$1,updated_at=NOW() WHERE user_id=$2", [member.feeCents / 100, member.userId]);
            const reference = `LEGACY-${competitionType}-${competitionId}-${member.userId}-${crypto.randomUUID()}`;
            await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,'competition_entry_transfer',$2,'KES','completed',$3,$4)`,
                [member.userId, member.feeCents / 100, reference, `${competition.name} legacy entry fee moved to platform pool`]
            );
            await creditPlatform(client, {
                amount: member.feeCents / 100, reference,
                transactionType: `${competitionType}_entry_fee`, description: `${competition.name} legacy entry fee`,
                reserve: true, context: { competitionType, competitionId, userId: member.userId, legacy: true },
                debitPostings: [{ accountType: "user_wallet_locked", accountId: member.userId, debit: member.feeCents / 100 }]
            });
            member.feeTransferred = true;
            member.entryReference = reference;
            await client.query(
                `UPDATE ${table} SET fee_transferred=TRUE,entry_reference=$1 WHERE ${foreignKey}=$2 AND user_id=$3`,
                [reference, competitionId, member.userId]
            );
        }
    }

    // Release each fee held for this competition; other competitions' reserves
    // remain unavailable to withdrawals and unrelated payouts.
    for (const member of entrants) {
        if (member.feeTransferred && member.entryReference) {
            await releasePlatformReservation(client, member.entryReference, `${competition.name} entry reserve released after settlement`);
        }
    }

    const payoutCents = winners.reduce((sum, member) => sum + member.prizeCents, 0);
    const prizeWallets = await client.query(
        "SELECT user_id FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE",
        [winners.map((member) => member.userId)]
    );
    const walletUsers = new Set(prizeWallets.rows.map((row) => Number(row.user_id)));
    if (winners.some((member) => !walletUsers.has(member.userId))) throw new Error("A competition prize recipient wallet is missing.");
    for (const member of winners) {
        if (member.prizeCents > 0) {
            await client.query("UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2", [member.prizeCents / 100, member.userId]);
        }
    }

    const retainedCents = distribution.retainedCents;
    const settlementReference = `EC-${competitionType}-${competitionId}-${crypto.randomUUID()}`;
    if (payoutCents > 0) {
        await debitPlatformAvailable(client, {
            amount: payoutCents / 100, reference: `${settlementReference}-ADMIN`,
            transactionType: "competition_prize_paid", description: `${competition.name} 5:4:3 prize pool distribution`,
            context: { competitionType, competitionId, seasonKey, pool: poolCents / 100, retainedRevenue: retainedCents / 100 },
            creditPostings: winners.filter((member) => member.prizeCents > 0).map((member) => ({
                accountType: "user_wallet_available", accountId: member.userId, credit: member.prizeCents / 100
            }))
        });
    }

    for (const member of entrants) {
        const reference = `EC-${competitionType}-${competitionId}-${crypto.randomUUID()}`;
        await client.query(
            `INSERT INTO efootball_competition_settlements
                (competition_type,competition_id,season_key,user_id,username,final_rank,entry_amount,
                 prize_amount,refund_amount,retained_revenue,reference)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)`,
            [competitionType, competitionId, seasonKey, member.userId, member.username, member.rank,
                member.feeCents / 100, member.prizeCents / 100, reference]
        );
        if (member.prizeCents > 0) {
            await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,'competition_prize',$2,'KES','completed',$3,$4)`,
                [member.userId, member.prizeCents / 100, `${reference}-P`, `${competition.name} season prize · place ${member.rank}`]
            );
        }
    }
    if (entrants.length && retainedCents > 0) {
        await client.query(
            `UPDATE efootball_competition_settlements SET retained_revenue=$1
              WHERE competition_type=$2 AND competition_id=$3 AND season_key=$4 AND user_id=$5`,
            [retainedCents / 100, competitionType, competitionId, entrants[0].userId]
        );
    }

    return {
        alreadySettled: false, participants: entrants.length, pool: poolCents / 100,
        retainedRevenue: retainedCents / 100,
        awards: winners.map((member) => ({ userId: member.userId, rank: member.rank, amount: member.prizeCents / 100 }))
    };
}

module.exports = { settleEfootballCompetition, allocateCents, distributePrizePoolCents };
