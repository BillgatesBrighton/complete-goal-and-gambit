"use strict";

const crypto = require("crypto");
const { distributePrizePoolCents } = require("./efootballpayouts");
const { creditPlatform } = require("./adminWalletAccounting");
const { recordJournal } = require("./financialLedger");

async function settleChessTournamentGroup(pool, seasonKey, timeControl, stakeAmount) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const lockKey = `chess-tournament-payout:${seasonKey}:${timeControl}:${stakeAmount}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
        const exists = await client.query(
            `SELECT 1 FROM chess_competition_settlements
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 LIMIT 1`,
            [seasonKey,timeControl,stakeAmount]
        );
        if (exists.rows.length) {
            await client.query(
                `UPDATE chess_matches SET payout_status='competition_paid'
                  WHERE match_type='tournament' AND status='completed' AND payout_status='pending_competition'
                    AND time_control=$1 AND stake_amount=$2
                    AND TO_CHAR(date_trunc('month',COALESCE(finished_at,created_at)),'YYYY-MM')=$3`,
                [timeControl,stakeAmount,seasonKey]
            );
            await client.query("COMMIT");
            return {alreadySettled:true};
        }

        const matches = await client.query(
            `SELECT id,player_white_id,player_black_id,stake_amount
               FROM chess_matches
              WHERE match_type='tournament' AND status='completed' AND payout_status='pending_competition'
                AND player_white_id IS NOT NULL AND player_black_id IS NOT NULL
                AND time_control=$1 AND stake_amount=$2
                AND TO_CHAR(date_trunc('month',COALESCE(finished_at,created_at)),'YYYY-MM')=$3
              ORDER BY id FOR UPDATE`,
            [timeControl,stakeAmount,seasonKey]
        );
        if (!matches.rows.length) {
            await client.query("COMMIT");
            return {alreadySettled:false,players:0,pool:0};
        }

        const standings = await client.query(
            `WITH results AS (
                 SELECT m.player_white_id AS user_id,
                        CASE WHEN m.result='draw' THEN 'draw' WHEN m.winner_id=m.player_white_id THEN 'win' ELSE 'loss' END AS outcome
                   FROM chess_matches m
                  WHERE m.match_type='tournament' AND m.status='completed' AND m.time_control=$1 AND m.stake_amount=$2
                    AND TO_CHAR(date_trunc('month',COALESCE(m.finished_at,m.created_at)),'YYYY-MM')=$3
                 UNION ALL
                 SELECT m.player_black_id AS user_id,
                        CASE WHEN m.result='draw' THEN 'draw' WHEN m.winner_id=m.player_black_id THEN 'win' ELSE 'loss' END AS outcome
                   FROM chess_matches m
                  WHERE m.match_type='tournament' AND m.status='completed' AND m.time_control=$1 AND m.stake_amount=$2
                    AND TO_CHAR(date_trunc('month',COALESCE(m.finished_at,m.created_at)),'YYYY-MM')=$3
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
            [timeControl,stakeAmount,seasonKey]
        );

        const forfeitedResult = await client.query(
            `SELECT user_id FROM chess_tournament_entries
              WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3 AND forfeited_at IS NOT NULL`,
            [seasonKey,timeControl,stakeAmount]
        );
        const forfeitedUsers = new Set(forfeitedResult.rows.map(row => Number(row.user_id)));
        const contributions = new Map();
        const matchIds = [];
        for (const match of matches.rows) {
            matchIds.push(Number(match.id));
            const cents = Math.round(Number(match.stake_amount) * 100);
            for (const key of ["player_white_id","player_black_id"]) {
                const userId = Number(match[key]);
                if (!forfeitedUsers.has(userId)) {
                    contributions.set(userId,(contributions.get(userId)||0)+cents);
                }
            }
        }
        const poolCents = Array.from(contributions.values()).reduce((total,value)=>total+value,0);
        const eligible = standings.rows.filter(row=>Number(row.played)>0).slice(0,3);
        const distribution = distributePrizePoolCents(poolCents,eligible.length);
        const awards = distribution.awards;
        const payoutByUser = new Map(eligible.map((row,index)=>[Number(row.user_id),awards[index]||0]));
        const contributionEntries = Array.from(contributions.entries());
        const userIds = contributionEntries.map(([userId])=>userId).sort((a,b)=>a-b);
        const wallets = await client.query(
            "SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE",
            [userIds]
        );
        const walletByUser = new Map(wallets.rows.map(row=>[Number(row.user_id),row]));
        for (const [userId,amount] of contributions.entries()) {
            const wallet=walletByUser.get(userId);
            if(!wallet||Math.round(Number(wallet.locked_balance)*100)<amount) throw new Error("A chess tournament stake is no longer fully locked; prize settlement is paused for reconciliation.");
        }

        const standingsRank = new Map(standings.rows.map((row,index)=>[Number(row.user_id),index+1]));
        const journalPostings = [];
        for (const [userId,contributedCents] of contributions.entries()) {
            const row=standings.rows.find(item=>Number(item.user_id)===userId);
            const username=row?String(row.username):"Player";
            const prizeCents=payoutByUser.get(userId)||0;
            const reference=`CHESS-COMP-${crypto.randomUUID()}`;
            await client.query(
                `UPDATE wallets SET locked_balance=locked_balance-$1,balance=balance+$2,updated_at=NOW()
                  WHERE user_id=$3 AND locked_balance >= $1`,
                [contributedCents/100,prizeCents/100,userId]
            );
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
            const settlementReference = `CHESS-POOL-${crypto.randomUUID()}`;
            if (retainedCents > 0) {
                await creditPlatform(client, {
                    amount: retainedCents/100,
                    reference: settlementReference,
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
            if (contributionEntries.length && retainedCents > 0) {
                await client.query(
                    `UPDATE chess_competition_settlements SET retained_revenue=$1
                      WHERE season_key=$2 AND time_control=$3 AND stake_amount=$4 AND user_id=$5`,
                    [retainedCents/100,seasonKey,timeControl,stakeAmount,contributionEntries[0][0]]
                );
            }
        }
        await client.query("UPDATE chess_matches SET payout_status='competition_paid' WHERE id=ANY($1::bigint[])",[matchIds]);
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
        `SELECT DISTINCT TO_CHAR(date_trunc('month',COALESCE(finished_at,created_at)),'YYYY-MM') AS season_key,
                time_control,stake_amount
           FROM chess_matches
          WHERE match_type='tournament' AND status='completed' AND payout_status='pending_competition'
            AND COALESCE(finished_at,created_at)<date_trunc('month',NOW())
          ORDER BY season_key,time_control,stake_amount LIMIT 100`
    );
    const settled=[];
    for(const group of groups.rows){
        try{
            settled.push(await settleChessTournamentGroup(pool,group.season_key,String(group.time_control),Number(group.stake_amount)));
        }catch(error){
            console.error("Chess tournament season settlement paused:",error.message);
        }
    }
    return settled;
}

module.exports={settleClosedChessTournamentSeasons};
