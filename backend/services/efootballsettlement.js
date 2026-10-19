"use strict";

const { creditPlatform } = require("./adminWalletAccounting");
const { rankedMatchPayout } = require("./rankedMatchPayout");
const { recordJournal } = require("./financialLedger");

/*
 * GOAL$GAMBIT
 * eFootball settlement service
 *
 * This service settles a match ONLY after the result has been verified.
 * It preserves the existing wallet, transaction, and league-table logic.
 */

async function settleEfootballMatch(client, match, scores, submittedBy) {
    const creatorScore = Number(scores.creatorScore);
    const opponentScore = Number(scores.opponentScore);

    if (
        !Number.isInteger(creatorScore) ||
        !Number.isInteger(opponentScore) ||
        creatorScore < 0 ||
        opponentScore < 0 ||
        creatorScore > 99 ||
        opponentScore > 99
    ) {
        throw new Error("Invalid verified score.");
    }

    const creatorId = Number(match.creator_id);
    const opponentId = Number(match.opponent_id);
    const amount = Number(match.stake_amount || 0);

    let winnerId = null;

    if (creatorScore > opponentScore) {
        winnerId = creatorId;
    } else if (opponentScore > creatorScore) {
        winnerId = opponentId;
    }

    /*
     * Prevent accidental double settlement.
     */
    if (match.status === "completed" || match.settled_at) {
        throw new Error("This match has already been settled.");
    }

    /*
     * Release locked stakes and pay the winner,
     * or refund both players in a draw.
     */
    let payout = 0;

    if (amount > 0) {
        const isRanked = !match.league && !match.tournament_id && (!match.mode || String(match.mode) === "ranked");
        const rankedPayout = isRanked && winnerId ? rankedMatchPayout(amount, "win") : null;
        if (isRanked && !winnerId) rankedMatchPayout(amount, "draw");
        const locked = await client.query(
            `UPDATE wallets
             SET locked_balance = locked_balance - $1,
                 updated_at = NOW()
             WHERE user_id IN ($2, $3)
               AND locked_balance >= $1
             RETURNING user_id`,
            [amount, creatorId, opponentId]
        );

        if (locked.rowCount !== 2) {
            throw new Error("Locked match funds are inconsistent; settlement was stopped.");
        }

        if (winnerId) {
            payout = rankedPayout ? rankedPayout.winner : amount * 2;

            await client.query(
                `UPDATE wallets
                 SET balance = balance + $1,
                     updated_at = NOW()
                 WHERE user_id = $2`,
                [payout, winnerId]
            );

            await client.query(
                `INSERT INTO transactions
                    (user_id, transaction_type, amount, currency, status, reference, description)
                 VALUES
                    ($1, 'match_winnings', $2, 'KES', 'completed', $3,
                     'eFootball match winnings')`,
                [
                    winnerId,
                    payout,
                    `EF-WIN-${match.id}-${winnerId}`
                ]
            );
            if (rankedPayout && rankedPayout.platform > 0) {
                await creditPlatform(client, {
                    amount: rankedPayout.platform,
                    reference: `EF-FEE-${match.id}`,
                    transactionType: "ranked_match_deduction",
                    description: `Ranked eFootball match ${match.id} platform deduction`,
                    matchId: match.id,
                    context: { game: "efootball", matchId: Number(match.id), stake: amount, winnerId },
                    debitPostings: [
                        { accountType: "efootball_match_locked", accountId: creatorId, debit: amount },
                        { accountType: "efootball_match_locked", accountId: opponentId, debit: amount },
                        { accountType: "user_wallet_available", accountId: winnerId, credit: payout }
                    ]
                });
            } else {
                await recordJournal(client, {
                    reference: `EF-WIN-${match.id}-${winnerId}`,
                    transactionType: "efootball_ranked_payout",
                    amount: payout,
                    description: "eFootball winner payout",
                    context: { game: "efootball", matchId: Number(match.id), winnerId },
                    postings: [
                        { accountType: "efootball_match_locked", accountId: creatorId, debit: amount },
                        { accountType: "efootball_match_locked", accountId: opponentId, debit: amount },
                        { accountType: "user_wallet_available", accountId: winnerId, credit: payout }
                    ]
                });
            }
        } else {
            for (const playerId of [creatorId, opponentId]) {
                await client.query(
                    `UPDATE wallets
                     SET balance = balance + $1,
                         updated_at = NOW()
                     WHERE user_id = $2`,
                    [amount, playerId]
                );

                await client.query(
                    `INSERT INTO transactions
                        (user_id, transaction_type, amount, currency, status, reference, description)
                     VALUES
                        ($1, 'match_refund', $2, 'KES', 'completed', $3,
                         'eFootball draw refund')`,
                    [
                        playerId,
                        amount,
                        `EF-DRAW-${match.id}-${playerId}`
                    ]
                );
            }
            await recordJournal(client, {
                reference: `EF-DRAW-${match.id}`,
                transactionType: "efootball_draw_refund",
                amount: amount * 2,
                description: "eFootball draw refunds",
                context: { game: "efootball", matchId: Number(match.id) },
                postings: [
                    { accountType: "efootball_match_locked", accountId: creatorId, debit: amount },
                    { accountType: "efootball_match_locked", accountId: opponentId, debit: amount },
                    { accountType: "user_wallet_available", accountId: creatorId, credit: amount },
                    { accountType: "user_wallet_available", accountId: opponentId, credit: amount }
                ]
            });
        }
    }

    /*
     * Update league statistics only after the result
     * has been verified and the match is actually settled.
     */
    if (match.league) {
        const leagueResult = await client.query(
            `SELECT id
             FROM efootball_leagues
             WHERE LOWER(name) = LOWER($1)`,
            [match.league]
        );

        if (leagueResult.rows.length) {
            const leagueId = leagueResult.rows[0].id;

            const applyLeagueResult = async (playerId, goalsFor, goalsAgainst) => {
                const win = goalsFor > goalsAgainst ? 1 : 0;
                const draw = goalsFor === goalsAgainst ? 1 : 0;
                const loss = goalsFor < goalsAgainst ? 1 : 0;

                await client.query(
                    `UPDATE efootball_league_members
                     SET played = played + 1,
                         wins = wins + $1,
                         draws = draws + $2,
                         losses = losses + $3,
                         points = points + $4,
                         goal_difference = goal_difference + $5,
                         goals_for = goals_for + $6,
                         goals_against = goals_against + $7
                     WHERE league_id = $8
                       AND user_id = $9`,
                    [
                        win,
                        draw,
                        loss,
                        win * 3 + draw,
                        goalsFor - goalsAgainst,
                        goalsFor,
                        goalsAgainst,
                        leagueId,
                        playerId
                    ]
                );
            };

            await applyLeagueResult(
                creatorId,
                creatorScore,
                opponentScore
            );

            await applyLeagueResult(
                opponentId,
                opponentScore,
                creatorScore
            );
        }
    }

    if (match.tournament_id) {
        const updateTournamentMember = async (playerId, goalsFor, goalsAgainst) => {
            const win = goalsFor > goalsAgainst ? 1 : 0;
            const draw = goalsFor === goalsAgainst ? 1 : 0;
            const loss = goalsFor < goalsAgainst ? 1 : 0;
            await client.query(
                `UPDATE efootball_tournament_members
                 SET played = played + 1,
                     wins = wins + $1,
                     draws = draws + $2,
                     losses = losses + $3,
                     points = points + $4,
                     goal_difference = goal_difference + $5,
                     goals_for = goals_for + $6,
                     goals_against = goals_against + $7
                 WHERE tournament_id = $8 AND user_id = $9`,
                [
                    win,
                    draw,
                    loss,
                    win * 3 + draw,
                    goalsFor - goalsAgainst,
                    goalsFor,
                    goalsAgainst,
                    match.tournament_id,
                    playerId
                ]
            );
        };

        await updateTournamentMember(creatorId, creatorScore, opponentScore);
        await updateTournamentMember(opponentId, opponentScore, creatorScore);
    }

    /*
     * Final match settlement.
     */
    await client.query(
        `UPDATE efootball_matches
         SET creator_score = $1,
             opponent_score = $2,
             submitted_by = $3,
             result_status = $4,
             winner_id = $5,
             status = 'completed',
             finished_at = NOW(),
             settled_at = NOW()
         WHERE id = $6`,
        [
            creatorScore,
            opponentScore,
            submittedBy,
            winnerId ? "win" : "draw",
            winnerId,
            match.id
        ]
    );

    return {
        winnerId,
        payout,
        creatorScore,
        opponentScore
    };
}

module.exports = {
    settleEfootballMatch
};
