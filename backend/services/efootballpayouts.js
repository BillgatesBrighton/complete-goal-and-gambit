"use strict";

const crypto = require("crypto");

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

/**
 * Settle the paid entry pool at the end of one eFootball season. Caller must
 * hold the competition row FOR UPDATE and be inside a database transaction.
 * Winners receive 5:4:3 times the entry fee, capped by the pool. Any excess
 * pool is returned pro-rata to active entrants; fewer than two entrants get
 * their remaining entry funds returned rather than an unearned champion prize.
 */
async function settleEfootballCompetition(client, type, competition, seasonKey) {
    const competitionId = Number(competition.id);
    const competitionType = type === "tournament" ? "tournament" : "league";
    const table = competitionType === "tournament" ? "efootball_tournament_members" : "efootball_league_members";
    const foreignKey = competitionType === "tournament" ? "tournament_id" : "league_id";
    const entryFee = Number(competitionType === "tournament" ? competition.entry_fee : competition.entry_stake) || 0;

    const alreadySettled = await client.query(
        `SELECT 1 FROM efootball_competition_settlements
          WHERE competition_type=$1 AND competition_id=$2 AND season_key=$3 LIMIT 1`,
        [competitionType, competitionId, seasonKey]
    );
    if (alreadySettled.rows.length) return { alreadySettled: true };

    const members = await client.query(
        `SELECT m.user_id,u.username, m.fee_paid, m.played, m.wins, m.draws, m.losses, m.points,
                goal_difference, goals_for, goals_against
           FROM ${table} m JOIN users u ON u.id=m.user_id
          WHERE m.${foreignKey}=$1 AND m.forfeited_at IS NULL
          ORDER BY m.points DESC, m.wins DESC, m.goal_difference DESC,
                   m.goals_for DESC, m.user_id ASC
          FOR UPDATE OF m`,
        [competitionId]
    );
    if (!members.rows.length) return { alreadySettled: false, participants: 0, pool: 0 };

    const entrants = members.rows.map((row, index) => ({
        userId: Number(row.user_id),
        username: String(row.username),
        rank: index + 1,
        feeCents: amountToCents(row.fee_paid),
        prizeCents: 0,
        refundCents: 0
    }));
    const totalPoolCents = entrants.reduce((total, member) => total + member.feeCents, 0);
    const winners = entrants.length >= 2 ? entrants.slice(0, Math.min(3, entrants.length)) : [];

    if (winners.length) {
        const baseCents = amountToCents(entryFee);
        const weights = winners.map((_, index) => PODIUM_WEIGHTS[index]);
        const nominalPrizeCents = weights.reduce((total, weight) => total + baseCents * weight, 0);
        const prizePoolCents = Math.min(totalPoolCents, nominalPrizeCents);
        const awards = allocateCents(prizePoolCents, weights);
        winners.forEach((member, index) => { member.prizeCents = awards[index]; });
    }

    const refundPoolCents = totalPoolCents - entrants.reduce((total, member) => total + member.prizeCents, 0);
    const refunds = allocateCents(refundPoolCents, entrants.map((member) => member.feeCents));
    entrants.forEach((member, index) => { member.refundCents = refunds[index]; });

    const walletRows = await client.query(
        `SELECT user_id, balance, locked_balance
           FROM wallets
          WHERE user_id = ANY($1::int[])
          ORDER BY user_id
          FOR UPDATE`,
        [entrants.map((member) => member.userId)]
    );
    const wallets = new Map(walletRows.rows.map((row) => [Number(row.user_id), row]));
    for (const member of entrants) {
        const wallet = wallets.get(member.userId);
        if (!wallet || amountToCents(wallet.locked_balance) < member.feeCents) {
            throw new Error("A competition entry stake is no longer fully locked; payout was held for reconciliation.");
        }
    }

    for (const member of entrants) {
        const amount = (member.prizeCents + member.refundCents) / 100;
        await client.query(
            `UPDATE wallets
                SET locked_balance=locked_balance-$1,
                    balance=balance+$2,
                    updated_at=NOW()
              WHERE user_id=$3`,
            [member.feeCents / 100, amount, member.userId]
        );
        const reference = `EC-${competitionType}-${competitionId}-${crypto.randomUUID()}`;
        await client.query(
            `INSERT INTO efootball_competition_settlements
                (competition_type,competition_id,season_key,user_id,username,final_rank,entry_amount,
                 prize_amount,refund_amount,reference)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [competitionType, competitionId, seasonKey, member.userId, member.username, member.rank,
                member.feeCents / 100, member.prizeCents / 100, member.refundCents / 100, reference]
        );
        if (member.prizeCents > 0) {
            await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,'competition_prize',$2,'KES','completed',$3,$4)`,
                [member.userId, member.prizeCents / 100, `${reference}-P`, `${competition.name} season prize · place ${member.rank}`]
            );
        }
        if (member.refundCents > 0) {
            await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,'competition_refund',$2,'KES','completed',$3,$4)`,
                [member.userId, member.refundCents / 100, `${reference}-R`, `${competition.name} unused season-pool balance returned`]
            );
        }
    }

    return {
        alreadySettled: false,
        participants: entrants.length,
        pool: totalPoolCents / 100,
        awards: winners.map((member) => ({ userId: member.userId, rank: member.rank, amount: member.prizeCents / 100 }))
    };
}

module.exports = { settleEfootballCompetition, allocateCents };
