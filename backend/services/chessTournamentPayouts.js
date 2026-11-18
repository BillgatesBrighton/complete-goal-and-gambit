"use strict";

const crypto = require("crypto");
const { distributePrizePoolCents } = require("./efootballpayouts");
const { creditPlatform } = require("./adminWalletAccounting");
const { recordJournal } = require("./financialLedger");
const { lockChessTournamentGroup } = require("./chessTournamentSync");

function seasonHasClosed(seasonKey) {
    if (!/^\d{4}-\d{2}$/.test(String(seasonKey || ""))) return false;
    const [year, month] = seasonKey.split("-").map(Number);
    // Africa/Nairobi is UTC+03:00 and has no daylight saving changes.
    const closeAt = Date.UTC(year, month, 1) - 3 * 60 * 60 * 1000;
    return Date.now() >= closeAt;
}

async function settleChessTournamentGroup(pool, seasonKey, timeControl, stakeAmount) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await lockChessTournamentGroup(client, seasonKey, timeControl, stakeAmount, "exclusive");
        const groupState = await client.query(
            `SELECT status FROM chess_tournament_groups
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 FOR UPDATE`,
            [seasonKey,timeControl,stakeAmount]
        );
        if (groupState.rows[0] && groupState.rows[0].status === "settled") {
            await client.query("COMMIT");
            return { alreadySettled: true };
        }
        const closure = await client.query(
            `SELECT closes_at<=clock_timestamp() AS closed FROM chess_tournament_groups
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3`,
            [seasonKey,timeControl,stakeAmount]
        );
        if (!closure.rows[0] || !closure.rows[0].closed) {
            await client.query("COMMIT");
            return { alreadySettled: false, notClosed: true };
        }

        const groupMatches = await client.query(
            `SELECT id,status,payout_status,result,player_white_id,player_black_id,stake_amount
               FROM chess_matches
              WHERE match_type='tournament' AND season_key=$1 AND time_control=$2 AND stake_amount=$3
              ORDER BY id FOR UPDATE`,
            [seasonKey, timeControl, stakeAmount]
        );
        if (groupMatches.rows.some(match => ["waiting", "active", "settling"].includes(String(match.status)))) {
            await client.query("COMMIT");
            return { alreadySettled: false, unresolved: true };
        }

        const pendingMatches = groupMatches.rows.filter(match =>
            match.status === "completed" && match.payout_status === "pending_competition" &&
            match.result !== "no_contest" && Number(match.stake_amount) > 0
        );
        const existingSettlement = await client.query(
            `SELECT count(*)::int AS count FROM chess_competition_settlements
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3`,
            [seasonKey, timeControl, stakeAmount]
        );
        if (!pendingMatches.length) {
            await client.query(
                `UPDATE chess_tournament_groups SET status='settled',settled_at=clock_timestamp()
                  WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND status='open'`,
                [seasonKey,timeControl,stakeAmount]
            );
            await client.query("COMMIT");
            return { alreadySettled: Number(existingSettlement.rows[0].count) > 0, players: 0, pool: 0 };
        }
        if (Number(existingSettlement.rows[0].count) > 0) {
            throw new Error("Chess tournament group has prior settlement rows and new payable matches; manual reconciliation is required.");
        }

        const matchIds = pendingMatches.map(match => Number(match.id));
        const obligations = await client.query(
            `SELECT d.match_id,d.user_id,d.stake_amount,d.disposition
               FROM chess_match_financial_dispositions d
              WHERE d.match_id=ANY($1::bigint[]) ORDER BY d.match_id,d.user_id FOR UPDATE`,
            [matchIds]
        );
        const obligationByMatch = new Map();
        for (const row of obligations.rows) {
            const id = Number(row.match_id);
            if (!obligationByMatch.has(id)) obligationByMatch.set(id, []);
            obligationByMatch.get(id).push(row);
        }
        let pendingObligationCount = 0;
        for (const match of pendingMatches) {
            const rows = obligationByMatch.get(Number(match.id)) || [];
            const expectedUsers = [Number(match.player_white_id), Number(match.player_black_id)].sort((a,b)=>a-b);
            if (rows.length !== 2 || rows.some(row => !["pending","admin_forfeited"].includes(row.disposition) ||
                Number(row.stake_amount) !== Number(match.stake_amount)) ||
                rows.map(row => Number(row.user_id)).sort((a,b)=>a-b).some((id,index)=>id !== expectedUsers[index])) {
                throw new Error("A payable chess match is missing exactly two pending player-stake dispositions; payout is paused for reconciliation.");
            }
            pendingObligationCount += rows.filter(row=>row.disposition === "pending").length;
        }
        if (pendingObligationCount === 0) {
            await client.query(
                `UPDATE chess_matches SET payout_status='forfeited'
                  WHERE id=ANY($1::bigint[]) AND payout_status='pending_competition'`,
                [matchIds]
            );
            await client.query(
                `UPDATE chess_tournament_groups SET status='settled',settled_at=clock_timestamp()
                  WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND status='open'`,
                [seasonKey,timeControl,stakeAmount]
            );
            await client.query("COMMIT");
            return { alreadySettled: false, forfeited: true, players: 0, pool: 0 };
        }

        const standings = await client.query(
            `WITH results AS (
                 SELECT m.player_white_id AS user_id,
                        CASE WHEN m.result='draw' THEN 'draw'
                             WHEN m.winner_id=m.player_white_id THEN 'win' ELSE 'loss' END AS outcome
                   FROM chess_matches m
                  WHERE m.match_type='tournament' AND m.status='completed' AND m.result IS DISTINCT FROM 'no_contest'
                    AND m.season_key=$3 AND m.time_control=$1 AND m.stake_amount=$2
                 UNION ALL
                 SELECT m.player_black_id AS user_id,
                        CASE WHEN m.result='draw' THEN 'draw'
                             WHEN m.winner_id=m.player_black_id THEN 'win' ELSE 'loss' END AS outcome
                   FROM chess_matches m
                  WHERE m.match_type='tournament' AND m.status='completed' AND m.result IS DISTINCT FROM 'no_contest'
                    AND m.season_key=$3 AND m.time_control=$1 AND m.stake_amount=$2
             ), participants AS (
                 SELECT r.user_id FROM results r
                  WHERE EXISTS (
                    SELECT 1 FROM chess_tournament_entries e
                     WHERE e.season_key=$3 AND e.time_control=$1 AND e.stake_amount=$2
                       AND e.user_id=r.user_id AND e.cancelled_at IS NULL AND e.forfeited_at IS NULL
                  )
                 UNION
                 SELECT user_id FROM chess_tournament_entries
                  WHERE season_key=$3 AND time_control=$1 AND stake_amount=$2
                    AND cancelled_at IS NULL AND forfeited_at IS NULL
             )
             SELECT p.user_id,u.username,COALESCE(u.rating,1200)::int AS rating,
                    COUNT(r.user_id)::int AS played,
                    COUNT(*) FILTER(WHERE r.outcome='win')::int AS wins,
                    COUNT(*) FILTER(WHERE r.outcome='draw')::int AS draws,
                    COUNT(*) FILTER(WHERE r.outcome='loss')::int AS losses,
                    (COUNT(*) FILTER(WHERE r.outcome='win')*3+COUNT(*) FILTER(WHERE r.outcome='draw'))::int AS points
               FROM participants p JOIN users u ON u.id=p.user_id
               LEFT JOIN results r ON r.user_id=p.user_id
              GROUP BY p.user_id,u.username,u.rating
              ORDER BY points DESC,wins DESC,rating DESC,u.username ASC`,
            [timeControl, stakeAmount, seasonKey]
        );

        const contributions = new Map();
        for (const row of obligations.rows) {
            if (row.disposition !== "pending") continue;
            const userId = Number(row.user_id);
            contributions.set(userId, (contributions.get(userId) || 0) + Math.round(Number(row.stake_amount) * 100));
        }
        const poolCents = Array.from(contributions.values()).reduce((total,value)=>total+value,0);
        const eligible = standings.rows.filter(row=>Number(row.played)>0).slice(0,3);
        const distribution = distributePrizePoolCents(poolCents,eligible.length);
        const awards = distribution.awards;
        const payoutByUser = new Map(eligible.map((row,index)=>[Number(row.user_id),awards[index]||0]));
        const userIds = Array.from(contributions.keys()).sort((a,b)=>a-b);
        const wallets = await client.query(
            "SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE",
            [userIds]
        );
        const walletByUser = new Map(wallets.rows.map(row=>[Number(row.user_id),row]));
        for (const [userId,amount] of contributions.entries()) {
            const wallet=walletByUser.get(userId);
            if(!wallet||Math.round(Number(wallet.locked_balance)*100)<amount) {
                throw new Error("A chess tournament stake is no longer fully locked; prize settlement is paused for reconciliation.");
            }
        }

        const standingsRank = new Map(standings.rows.map((row,index)=>[Number(row.user_id),index+1]));
        const journalPostings = [];
        const settlementReference = `CHESS-POOL-${seasonKey}-${timeControl}-${Number(stakeAmount).toFixed(2)}`;
        for (const [userId,contributedCents] of contributions.entries()) {
            const row=standings.rows.find(item=>Number(item.user_id)===userId);
            const username=row?String(row.username):"Player";
            const prizeCents=payoutByUser.get(userId)||0;
            const reference=`CHESS-COMP-${crypto.randomUUID()}`;
            const walletUpdate = await client.query(
                `UPDATE wallets SET locked_balance=locked_balance-$1,balance=balance+$2,updated_at=NOW()
                  WHERE user_id=$3 AND locked_balance >= $1 RETURNING user_id`,
                [contributedCents/100,prizeCents/100,userId]
            );
            if (walletUpdate.rowCount !== 1) throw new Error("Chess tournament wallet changed during payout; settlement was rolled back.");
            journalPostings.push({accountType:"chess_match_locked",accountId:userId,debit:contributedCents/100});
            if(prizeCents>0) journalPostings.push({accountType:"user_wallet_available",accountId:userId,credit:prizeCents/100});
            await client.query(
                `INSERT INTO chess_competition_settlements
                    (season_key,time_control,stake_amount,user_id,username,final_rank,contributed,prize_amount,refund_amount,retained_revenue,reference)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)`,
                [seasonKey,timeControl,stakeAmount,userId,username,standingsRank.get(userId)||null,
                    contributedCents/100,prizeCents/100,reference]
            );
            if(prizeCents>0) await client.query(
                `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                 VALUES($1,'competition_prize',$2,'KES','completed',$3,$4)`,
                [userId,prizeCents/100,`${reference}-P`,`Chess ${timeControl} KSh ${stakeAmount} tournament prize · place ${standingsRank.get(userId)||"—"}`]
            );
            await client.query(
                `INSERT INTO system_notifications(user_id,type,title,message)
                 VALUES($1,'competition_settlement','Chess tournament settled',$2)`,
                [userId,`Your ${timeControl} KSh ${stakeAmount} chess tournament season has settled. Prize: KSh ${(prizeCents/100).toFixed(2)}.`]
            );
        }
        const retainedCents = distribution.retainedCents;
        if (poolCents > 0) {
            if (retainedCents > 0) {
                await creditPlatform(client, {
                    amount: retainedCents/100, reference: settlementReference,
                    transactionType: "chess_competition_retained_revenue",
                    description: `Chess ${timeControl} KSh ${stakeAmount} tournament retained pool revenue`,
                    context: {seasonKey,timeControl,stakeAmount,pool:poolCents/100,retainedRevenue:retainedCents/100},
                    debitPostings: journalPostings
                });
            } else {
                await recordJournal(client, {
                    reference: settlementReference,
                    transactionType: "chess_competition_prize_pool_settlement",
                    amount: poolCents/100,
                    description: `Chess ${timeControl} KSh ${stakeAmount} tournament prize pool settlement`,
                    context: {seasonKey,timeControl,stakeAmount,pool:poolCents/100},
                    postings: journalPostings
                });
            }
            if (contributions.size && retainedCents > 0) {
                const firstUserId = userIds[0];
                await client.query(
                    `UPDATE chess_competition_settlements SET retained_revenue=$1
                      WHERE season_key=$2 AND time_control=$3 AND stake_amount=$4 AND user_id=$5`,
                    [retainedCents/100,seasonKey,timeControl,stakeAmount,firstUserId]
                );
            }
        }
        const paidObligations = await client.query(
            `UPDATE chess_match_financial_dispositions SET disposition='competition_paid',settled_at=NOW(),reference=$1
              WHERE match_id=ANY($2::bigint[]) AND disposition='pending' RETURNING match_id`,
            [settlementReference, matchIds]
        );
        if (paidObligations.rowCount !== pendingObligationCount) throw new Error("Chess tournament disposition count changed during payout.");
        const paidMatches = await client.query(
            "UPDATE chess_matches SET payout_status='competition_paid' WHERE id=ANY($1::bigint[]) AND payout_status='pending_competition' RETURNING id",
            [matchIds]
        );
        if (paidMatches.rowCount !== pendingMatches.length) throw new Error("A chess tournament match could not be marked paid after its financial settlement.");
        await client.query(
            `UPDATE chess_tournament_groups SET status='settled',settled_at=clock_timestamp()
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND status='open'`,
            [seasonKey,timeControl,stakeAmount]
        );
        await client.query("COMMIT");
        return {alreadySettled:false,players:contributions.size,pool:poolCents/100,retainedRevenue:retainedCents/100,
            awards:eligible.map((row,index)=>({userId:Number(row.user_id),rank:index+1,amount:(awards[index]||0)/100}))};
    } catch(error) {
        await client.query("ROLLBACK").catch(()=>{});
        throw error;
    } finally {
        client.release();
    }
}

async function settleClosedChessTournamentSeasons(pool) {
    const groups=await pool.query(
        `SELECT season_key,time_control,stake_amount
           FROM chess_tournament_groups
          WHERE status='open' AND closes_at<=clock_timestamp()
          ORDER BY season_key,time_control,stake_amount LIMIT 100`
    );
    const settled=[];
    for(const group of groups.rows){
        try{
            settled.push(await settleChessTournamentGroup(pool,String(group.season_key),String(group.time_control),Number(group.stake_amount)));
        }catch(error){
            console.error("Chess tournament season settlement paused:",error.message);
        }
    }
    return settled;
}

module.exports={settleClosedChessTournamentSeasons,settleChessTournamentGroup,seasonHasClosed};
