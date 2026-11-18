"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
require("./config").readConfig();
const { createFixture, verifiedPool } = require("./fixture");
const { readConfig, EXPECTED_DATABASE, EXPECTED_ROLE } = require("./config");
const { request } = require("./httpHarness");
const authenticateToken = require("../../middleware/authMiddleware");
const chessRoutes = require("../../routes/chess");
const chessCompetitionRoutes = require("../../routes/chessCompetitions");
const createAuthToken = require("../../services/authToken");
const { processDueChessTournamentMatches } = require("../../services/chessTournamentScheduling");
const { settleChessTournamentGroup } = require("../../services/chessTournamentPayouts");

const TEST_SECRET = "security-chess-tournament-schedule-test-secret";
let fixture;
let inventoryPool;
let schemasBefore;
let server;
let base;
let previousJwtSecret;
let admin;

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    inventoryPool = await verifiedPool(readConfig());
    const identity = await inventoryPool.query("SELECT current_database() AS database_name,current_user AS role_name");
    assert.deepEqual(identity.rows[0], { database_name: EXPECTED_DATABASE, role_name: EXPECTED_ROLE });
    schemasBefore = (await inventoryPool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
    )).rows.map(row=>row.nspname);

    fixture = await createFixture();
    for (const [name, pool] of [["application",fixture.pool],["Socket.IO lock",fixture.lockPool]]) {
        const poolIdentity = await pool.query("SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name");
        assert.deepEqual(poolIdentity.rows[0], { database_name: EXPECTED_DATABASE, role_name: EXPECTED_ROLE, schema_name: fixture.schema }, name + " pool must be isolated before writes");
    }
    authenticateToken.setPool(fixture.pool);
    admin = await fixture.createUser("it_chess_schedule_admin_");
    await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    await fixture.pool.query("INSERT INTO admin_wallets(admin_id,balance,reserved_balance) VALUES($1,0,0)", [admin.id]);

    const app = express();
    app.use(express.json());
    const originalSetInterval = global.setInterval;
    global.setInterval = function () { return { unref() {} }; };
    try {
        const io={to(){return {emit(){}}},in(){return {disconnectSockets(){}}}};
        app.use("/api/chess/competitions", chessCompetitionRoutes(fixture.pool,authenticateToken));
        app.use("/api/chess", chessRoutes(fixture.pool, authenticateToken, io));
    } finally {
        global.setInterval = originalSetInterval;
    }
    server = http.createServer(app);
    await new Promise((resolve,reject)=>{
        server.once("error",reject);
        server.listen(0,"127.0.0.1",resolve);
    });
    base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
    if (server && server.listening) await new Promise(resolve=>server.close(resolve));
    if (fixture) await fixture.close();
    if (inventoryPool) {
        const afterSchemas = (await inventoryPool.query(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
        )).rows.map(row=>row.nspname);
        assert.deepEqual(afterSchemas, schemasBefore, "the test run must preserve every pre-existing security_it_* schema");
        await inventoryPool.end();
    }
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
});

async function createPlayer(prefix) {
    const user = await fixture.createUser(prefix);
    await fixture.pool.query("UPDATE users SET game='chess' WHERE id=$1", [user.id]);
    await fixture.pool.query("INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,100,0,'KES')", [user.id]);
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const token = await createAuthToken({ ...user, auth_version: 0 }, client);
        await client.query("COMMIT");
        return { user, token, sessionId: jwt.verify(token,TEST_SECRET).jti };
    } catch (error) {
        await client.query("ROLLBACK").catch(()=>{});
        throw error;
    } finally { client.release(); }
}

function schedulePayload(timeControl, stake, scheduledAt, deadlineAt) {
    return { matchType:"tournament",speed:timeControl==="3+2"?"blitz":timeControl==="1+1"?"bullet":"rapid",timeControl,stake,scheduledAt,deadlineAt };
}

async function createPair(options) {
    const first = await createPlayer("it_chess_schedule_white_");
    const second = await createPlayer("it_chess_schedule_black_");
    const body = schedulePayload(options.timeControl,options.stake,options.scheduledAt||null,options.deadlineAt||null);
    const firstResponse = await request(base,"/api/chess/create",{method:"POST",token:first.token,body});
    assert.equal(firstResponse.status,201,firstResponse.body.message);
    const secondResponse = await request(base,"/api/chess/create",{method:"POST",token:second.token,body});
    assert.equal(secondResponse.status,201,secondResponse.body.message);
    return { first,second,matchId:Number(secondResponse.body.match.matchId),match:secondResponse.body.match };
}

async function createWaiting(options) {
    const player = await createPlayer("it_chess_schedule_waiting_");
    const body = schedulePayload(options.timeControl,options.stake,options.scheduledAt||null,options.deadlineAt||null);
    const response = await request(base,"/api/chess/create",{method:"POST",token:player.token,body});
    assert.equal(response.status,201,response.body.message);
    return { player,matchId:Number(response.body.match.matchId),match:response.body.match };
}

async function joinMatch(player,matchId) {
    return request(base,"/api/chess/"+matchId+"/join",{method:"POST",token:player.token});
}

async function waitForChessRowLockWaiters(minimum, timeoutMs) {
    const end = Date.now() + (timeoutMs || 5000);
    while (Date.now() < end) {
        const result = await fixture.pool.query(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
                AND state='active' AND wait_event_type='Lock' AND query ILIKE '%chess_matches%'`
        );
        if (result.rows[0].count >= minimum) return;
        await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail("The concurrent Chess route and scheduler did not both reach the match-row lock barrier.");
}

async function ready(identity, matchId) {
    return request(base,"/api/chess/"+matchId+"/ready",{method:"POST",token:identity.token});
}

async function readMatch(matchId) {
    const result=await fixture.pool.query("SELECT * FROM chess_matches WHERE id=$1",[matchId]);
    return result.rows[0];
}

test("joining an expired scheduled queue is rejected before the joiner's stake is locked", async () => {
    const scheduledAt=new Date(Date.now()-10*60_000).toISOString();
    const deadlineAt=new Date(Date.now()+5*60_000).toISOString();
    const waiting=await createWaiting({timeControl:"10+5",stake:50,scheduledAt,deadlineAt});
    const joiner=await createPlayer("it_chess_schedule_late_join_");
    await fixture.pool.query("UPDATE chess_matches SET deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[waiting.matchId]);
    const before=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[waiting.player.user.id,joiner.user.id]]);

    const response=await joinMatch(joiner,waiting.matchId);
    assert.equal(response.status,409);
    assert.match(response.body.message,/joining deadline has expired/i);
    const match=await readMatch(waiting.matchId);
    assert.equal(match.status,"waiting");
    assert.equal(match.player_black_id,null);
    assert.equal(match.result,null);
    assert.deepEqual((await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[waiting.player.user.id,joiner.user.id]])).rows,before.rows);
    assert.deepEqual((await fixture.pool.query("SELECT user_id,disposition FROM chess_match_financial_dispositions WHERE match_id=$1 ORDER BY user_id",[waiting.matchId])).rows,[{user_id:waiting.player.user.id,disposition:"pending"}]);
});

test("a scheduled queue can still be joined before its deadline", async () => {
    const waiting=await createWaiting({
        timeControl:"3+2",stake:20,
        scheduledAt:new Date(Date.now()-60_000).toISOString(),
        deadlineAt:new Date(Date.now()+5*60_000).toISOString()
    });
    const joiner=await createPlayer("it_chess_schedule_valid_join_");
    const response=await joinMatch(joiner,waiting.matchId);
    assert.equal(response.status,200,response.body.message);
    const match=await readMatch(waiting.matchId);
    assert.equal(match.status,"waiting");
    assert.equal(Number(match.player_black_id),Number(joiner.user.id));
    const wallets=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[waiting.player.user.id,joiner.user.id]]);
    assert.equal(wallets.rows.length,2);
    assert.ok(wallets.rows.every(row=>Number(row.balance)===80&&Number(row.locked_balance)===20));
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM chess_match_financial_dispositions WHERE match_id=$1 AND disposition='pending'",[waiting.matchId])).rows[0].count,2);
});

test("unscheduled one-player tournament queues keep their existing non-expiring behavior", async () => {
    const waiting=await createWaiting({timeControl:"1+1",stake:100});
    assert.equal(waiting.match.scheduledAt,null);
    assert.equal(waiting.match.deadlineAt,null);
    const outcomes=await processDueChessTournamentMatches(fixture.pool);
    assert.equal(outcomes.some(item=>item.matchId===waiting.matchId),false);
    const match=await readMatch(waiting.matchId);
    assert.equal(match.status,"waiting");
    assert.equal(match.result,null);
    const wallet=await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id]);
    assert.equal(Number(wallet.rows[0].balance),0);
    assert.equal(Number(wallet.rows[0].locked_balance),100);
    assert.equal((await fixture.pool.query("SELECT disposition FROM chess_match_financial_dispositions WHERE match_id=$1 AND user_id=$2",[waiting.matchId,waiting.player.user.id])).rows[0].disposition,"pending");
});

test("expired scheduled one-player queue is cancelled and refunded exactly once", async () => {
    const waiting=await createWaiting({
        timeControl:"10+5",stake:50,
        scheduledAt:new Date(Date.now()-10*60_000).toISOString(),
        deadlineAt:new Date(Date.now()-5*60_000).toISOString()
    });
    const adminBefore=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    const first=await processDueChessTournamentMatches(fixture.pool);
    assert.ok(first.some(item=>item.matchId===waiting.matchId&&item.outcome==="cancelled_refunded"));
    const match=await readMatch(waiting.matchId);
    assert.equal(match.status,"cancelled");
    assert.equal(match.result,null);
    assert.equal(match.winner_id,null);
    assert.equal(match.payout_status,"refunded");
    const wallet=await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id]);
    assert.equal(Number(wallet.rows[0].balance),100);
    assert.equal(Number(wallet.rows[0].locked_balance),0);
    assert.equal((await fixture.pool.query("SELECT disposition,reference FROM chess_match_financial_dispositions WHERE match_id=$1 AND user_id=$2",[waiting.matchId,waiting.player.user.id])).rows[0].disposition,"refunded");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM transactions WHERE reference=$1",[`CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,1);
    const journal=await fixture.pool.query(
        `SELECT SUM(e.debit)::numeric AS debit,SUM(e.credit)::numeric AS credit,count(*)::int AS count
           FROM financial_ledger_transactions t JOIN financial_ledger_entries e ON e.transaction_id=t.id
          WHERE t.reference=$1`,[`CHESS-STAKE-UNLOCK-CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`]
    );
    assert.equal(journal.rows[0].count,2);
    assert.equal(Number(journal.rows[0].debit),50);
    assert.equal(Number(journal.rows[0].credit),50);
    assert.deepEqual((await processDueChessTournamentMatches(fixture.pool)),[]);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM transactions WHERE reference=$1",[`CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,1);
    assert.deepEqual((await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id])).rows[0],adminBefore.rows[0]);
});

test("two scheduler pools refund the same expired queue only once", async () => {
    const waiting=await createWaiting({
        timeControl:"1+1",stake:20,
        scheduledAt:new Date(Date.now()-10*60_000).toISOString(),
        deadlineAt:new Date(Date.now()-5*60_000).toISOString()
    });
    const outcomes=await Promise.all([
        processDueChessTournamentMatches(fixture.pool),
        processDueChessTournamentMatches(fixture.lockPool)
    ]);
    assert.equal(outcomes.flat().filter(item=>item.matchId===waiting.matchId&&item.outcome==="cancelled_refunded").length,1);
    assert.equal((await readMatch(waiting.matchId)).status,"cancelled");
    const wallet=await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id]);
    assert.equal(Number(wallet.rows[0].balance),100);
    assert.equal(Number(wallet.rows[0].locked_balance),0);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM transactions WHERE reference=$1",[`CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM financial_ledger_transactions WHERE reference=$1",[`CHESS-STAKE-UNLOCK-CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,1);
});

test("deadline expiry and concurrent join serialize to one cancellation and refund", async () => {
    const waiting=await createWaiting({
        timeControl:"3+2",stake:50,
        scheduledAt:new Date(Date.now()-10*60_000).toISOString(),
        deadlineAt:new Date(Date.now()-5*60_000).toISOString()
    });
    const joiner=await createPlayer("it_chess_schedule_race_join_");
    const blocker=await fixture.pool.connect();
    let joinPromise;
    let expiryPromise;
    try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM chess_matches WHERE id=$1 FOR UPDATE",[waiting.matchId]);
        joinPromise=joinMatch(joiner,waiting.matchId);
        expiryPromise=processDueChessTournamentMatches(fixture.lockPool);
        await waitForChessRowLockWaiters(2,5000);
    } finally {
        await blocker.query("COMMIT").catch(()=>{});
        blocker.release();
    }
    const [joinResponse,expiryOutcomes]=await Promise.all([joinPromise,expiryPromise]);
    assert.equal(joinResponse.status,409);
    assert.ok(["cancelled","waiting"].includes((await readMatch(waiting.matchId)).status));
    if ((await readMatch(waiting.matchId)).status === "waiting") {
        assert.ok(expiryOutcomes.some(item=>item.matchId===waiting.matchId&&item.outcome==="cancelled_refunded"));
    }
    const finalMatch=await readMatch(waiting.matchId);
    assert.equal(finalMatch.status,"cancelled");
    assert.equal(finalMatch.player_black_id,null);
    const wallets=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[waiting.player.user.id,joiner.user.id]]);
    assert.equal(Number(wallets.rows.find(row=>Number(row.user_id)===Number(waiting.player.user.id)).balance),100);
    assert.equal(Number(wallets.rows.find(row=>Number(row.user_id)===Number(waiting.player.user.id)).locked_balance),0);
    assert.equal(Number(wallets.rows.find(row=>Number(row.user_id)===Number(joiner.user.id)).balance),100);
    assert.equal(Number(wallets.rows.find(row=>Number(row.user_id)===Number(joiner.user.id)).locked_balance),0);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM transactions WHERE reference=$1",[`CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,1);
});

test("expired-queue refund failure rolls back all records and can be retried", async () => {
    const waiting=await createWaiting({
        timeControl:"10+5",stake:100,
        scheduledAt:new Date(Date.now()-10*60_000).toISOString(),
        deadlineAt:new Date(Date.now()-5*60_000).toISOString()
    });
    const walletBefore=await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id]);
    const adminBefore=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    await fixture.pool.query(`CREATE FUNCTION security_it_chess_queue_refund_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced queue refund ledger failure'; END $$`);
    await fixture.pool.query("CREATE TRIGGER security_it_chess_queue_refund_fail BEFORE INSERT ON financial_ledger_transactions FOR EACH ROW EXECUTE FUNCTION security_it_chess_queue_refund_fail_fn()");
    try {
        await assert.rejects(()=>processDueChessTournamentMatches(fixture.pool),/forced queue refund ledger failure/);
    } finally {
        await fixture.pool.query("DROP TRIGGER IF EXISTS security_it_chess_queue_refund_fail ON financial_ledger_transactions");
        await fixture.pool.query("DROP FUNCTION IF EXISTS security_it_chess_queue_refund_fail_fn()");
    }
    assert.equal((await readMatch(waiting.matchId)).status,"waiting");
    assert.deepEqual((await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id])).rows,walletBefore.rows);
    assert.equal((await fixture.pool.query("SELECT disposition FROM chess_match_financial_dispositions WHERE match_id=$1 AND user_id=$2",[waiting.matchId,waiting.player.user.id])).rows[0].disposition,"pending");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM transactions WHERE reference=$1",[`CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,0);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM financial_ledger_transactions WHERE reference=$1",[`CHESS-STAKE-UNLOCK-CHESS-CANCEL-${waiting.matchId}-${waiting.player.user.id}`])).rows[0].count,0);
    assert.deepEqual((await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id])).rows[0],adminBefore.rows[0]);
    assert.ok((await processDueChessTournamentMatches(fixture.pool)).some(item=>item.matchId===waiting.matchId&&item.outcome==="cancelled_refunded"));
    const after=await fixture.pool.query("SELECT balance,locked_balance FROM wallets WHERE user_id=$1",[waiting.player.user.id]);
    assert.equal(Number(after.rows[0].balance),100);
    assert.equal(Number(after.rows[0].locked_balance),0);
});

test("unscheduled tournament matchmaking remains immediate and permanently stores its season", async () => {
    const pair=await createPair({timeControl:"10+5",stake:20});
    assert.equal(pair.match.status,"active");
    const match=await readMatch(pair.matchId);
    assert.match(match.season_key,/^\d{4}-\d{2}$/);
    assert.equal(match.scheduled_at,null);
    assert.equal(match.deadline_at,null);
    const obligations=await fixture.pool.query("SELECT count(*)::int AS n FROM chess_match_financial_dispositions WHERE match_id=$1 AND disposition='pending'",[pair.matchId]);
    assert.equal(obligations.rows[0].n,2);

    const assigned=String(match.season_key);
    await fixture.pool.query("UPDATE chess_matches SET created_at='2026-11-30 20:00:00+00',finished_at='2026-12-01 01:00:00+00',status='completed',result='draw',settled_at=clock_timestamp(),payout_status='pending_competition' WHERE id=$1",[pair.matchId]);
    assert.equal(String((await readMatch(pair.matchId)).season_key),assigned,"changing completion timestamps must never reassign the stored season");
    await fixture.pool.query("UPDATE chess_tournament_groups SET closes_at=clock_timestamp()-INTERVAL '1 day' WHERE season_key=$1 AND time_control='10+5' AND stake_amount=20",[assigned]);
    await settleChessTournamentGroup(fixture.pool,assigned,"10+5",20);
    assert.equal((await readMatch(pair.matchId)).payout_status,"competition_paid");
    const settlement=await fixture.pool.query("SELECT count(*)::int AS n FROM chess_competition_settlements WHERE season_key=$1 AND time_control='10+5' AND stake_amount=20",[assigned]);
    assert.equal(settlement.rows[0].n,2,"settlement must group by the stored creation season rather than the December completion date");
});

test("scheduled match without deadline starts only after both Ready and never auto-expires", async () => {
    const scheduledAt=new Date(Date.now()+5*60_000).toISOString();
    const pair=await createPair({timeControl:"3+2",stake:50,scheduledAt,deadlineAt:null});
    assert.equal(pair.match.status,"waiting");
    assert.equal((await ready(pair.first,pair.matchId)).status,200);
    assert.equal((await ready(pair.second,pair.matchId)).status,200);
    await fixture.pool.query("UPDATE chess_matches SET scheduled_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[pair.matchId]);
    const outcomes=await processDueChessTournamentMatches(fixture.pool);
    assert.ok(outcomes.some(item=>item.matchId===pair.matchId&&item.outcome==="started"));
    assert.equal((await readMatch(pair.matchId)).status,"active");

    const lone=await createPair({timeControl:"3+2",stake:20,scheduledAt:new Date(Date.now()-60_000).toISOString(),deadlineAt:null});
    await ready(lone.first,lone.matchId);
    await processDueChessTournamentMatches(fixture.pool);
    const unexpired=await readMatch(lone.matchId);
    assert.equal(unexpired.status,"waiting");
    assert.equal(unexpired.result,null,"a match without a deadline cannot be expired");
});

test("one Ready player receives a walkover and the opponent stake is not forfeited", async () => {
    const scheduledAt=new Date(Date.now()-2*60_000).toISOString();
    const deadlineAt=new Date(Date.now()+5*60_000).toISOString();
    const pair=await createPair({timeControl:"1+1",stake:100,scheduledAt,deadlineAt});
    assert.equal((await ready(pair.first,pair.matchId)).status,200);
    await fixture.pool.query("UPDATE chess_matches SET white_ready_at=clock_timestamp()-INTERVAL '2 seconds',deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[pair.matchId]);
    const outcomes=await processDueChessTournamentMatches(fixture.pool);
    assert.ok(outcomes.some(item=>item.matchId===pair.matchId&&item.outcome==="walkover"));
    const match=await readMatch(pair.matchId);
    assert.equal(match.result,"walkover");
    assert.equal(Number(match.winner_id),Number(pair.first.user.id));
    assert.equal(match.payout_status,"pending_competition");
    const dispositions=await fixture.pool.query("SELECT disposition,count(*)::int AS n FROM chess_match_financial_dispositions WHERE match_id=$1 GROUP BY disposition ORDER BY disposition",[pair.matchId]);
    assert.deepEqual(dispositions.rows.map(row=>[row.disposition,row.n]),[["pending",2]]);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM admin_wallet_transactions WHERE reference LIKE $1",[`CHESS-NOSHOW-POOL-${pair.matchId}-%`])).rows[0].n,0);
});

test("double no-show transfers both locked stakes to admin reserve once and rejects late moves", async () => {
    const scheduledAt=new Date(Date.now()-2*60_000).toISOString();
    const deadlineAt=new Date(Date.now()+5*60_000).toISOString();
    const pair=await createPair({timeControl:"10+5",stake:50,scheduledAt,deadlineAt});
    await fixture.pool.query("UPDATE chess_matches SET deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[pair.matchId]);
    const before=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    const outcomes=await processDueChessTournamentMatches(fixture.pool);
    assert.ok(outcomes.some(item=>item.matchId===pair.matchId&&item.outcome==="no_contest"));
    const match=await readMatch(pair.matchId);
    assert.equal(match.result,"no_contest");
    assert.equal(match.winner_id,null);
    assert.equal(match.payout_status,"forfeited");
    const playerWallets=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[pair.first.user.id,pair.second.user.id]]);
    assert.equal(playerWallets.rows.length,2);
    assert.ok(playerWallets.rows.every(row=>Number(row.balance)===50&&Number(row.locked_balance)===0));
    const after=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    assert.equal(Number(after.rows[0].balance)-Number(before.rows[0].balance),100);
    assert.equal(Number(after.rows[0].reserved_balance)-Number(before.rows[0].reserved_balance),100);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM admin_wallet_transactions WHERE reference LIKE $1",[`CHESS-NOSHOW-POOL-${pair.matchId}-%`])).rows[0].n,1);
    const journal=await fixture.pool.query(
        `SELECT e.account_type,e.debit,e.credit FROM financial_ledger_transactions t
          JOIN financial_ledger_entries e ON e.transaction_id=t.id WHERE t.reference=$1 ORDER BY e.account_type,e.account_id`,
        [`CHESS-NOSHOW-POOL-${pair.matchId}`]
    );
    assert.equal(journal.rows.length,3);
    assert.equal(journal.rows.reduce((sum,row)=>sum+Number(row.debit),0),100);
    assert.equal(journal.rows.reduce((sum,row)=>sum+Number(row.credit),0),100);
    assert.deepEqual((await fixture.pool.query("SELECT DISTINCT disposition FROM chess_match_financial_dispositions WHERE match_id=$1",[pair.matchId])).rows.map(row=>row.disposition),["admin_forfeited"]);
    const standings=await request(base,"/api/chess/competitions/tournament?timeControl=10%2B5&stake=50");
    assert.equal(standings.status,200,standings.body.message);
    for(const username of [pair.first.user.username,pair.second.user.username]){
        const row=standings.body.standings.find(item=>item.username===username);
        assert.ok(row);
        assert.equal(Number(row.played),0);
        assert.equal(Number(row.points),0);
    }
    await processDueChessTournamentMatches(fixture.lockPool);
    const afterRepeat=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    assert.deepEqual(afterRepeat.rows[0],after.rows[0]);
    const lateMove=await request(base,"/api/chess/"+pair.matchId+"/move",{method:"POST",token:pair.first.token,body:{from:"e2",to:"e4"}});
    assert.equal(lateMove.status,409);
});

test("double-no-show financial failure rolls back the whole expiry and can be retried", async () => {
    const scheduledAt=new Date(Date.now()-2*60_000).toISOString();
    const deadlineAt=new Date(Date.now()+5*60_000).toISOString();
    const pair=await createPair({timeControl:"10+5",stake:100,scheduledAt,deadlineAt});
    await fixture.pool.query("UPDATE chess_matches SET deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[pair.matchId]);
    const beforeWallets=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[pair.first.user.id,pair.second.user.id]]);
    const beforeAdmin=await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id]);
    await fixture.pool.query(`CREATE FUNCTION security_it_chess_no_show_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced no-show accounting rollback'; END $$`);
    await fixture.pool.query("CREATE TRIGGER security_it_chess_no_show_fail BEFORE UPDATE ON admin_wallets FOR EACH ROW EXECUTE FUNCTION security_it_chess_no_show_fail_fn()");
    await assert.rejects(()=>processDueChessTournamentMatches(fixture.pool),/forced no-show accounting rollback/);
    await fixture.pool.query("DROP TRIGGER security_it_chess_no_show_fail ON admin_wallets");
    await fixture.pool.query("DROP FUNCTION security_it_chess_no_show_fail_fn()");
    const matchAfterFailure=await readMatch(pair.matchId);
    assert.equal(matchAfterFailure.status,"waiting");
    assert.equal(matchAfterFailure.result,null);
    assert.deepEqual((await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[pair.first.user.id,pair.second.user.id]])).rows,beforeWallets.rows);
    assert.deepEqual((await fixture.pool.query("SELECT balance,reserved_balance FROM admin_wallets WHERE admin_id=$1",[admin.id])).rows,beforeAdmin.rows);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM transactions WHERE transaction_type='chess_tournament_no_show' AND user_id=ANY($1::int[])",[[pair.first.user.id,pair.second.user.id]])).rows[0].n,0);
    assert.ok((await processDueChessTournamentMatches(fixture.pool)).some(item=>item.matchId===pair.matchId&&item.outcome==="no_contest"));
});

test("unresolved matches block closed-season payout; completed obligations settle exactly once across pools", async () => {
    const scheduledAt=new Date(Date.now()+5*60_000).toISOString();
    const waiting=await createPair({timeControl:"3+2",stake:100,scheduledAt,deadlineAt:null});
    const keyGroup=await fixture.pool.query("SELECT season_key,time_control,stake_amount FROM chess_matches WHERE id=$1",[waiting.matchId]);
    await fixture.pool.query("UPDATE chess_tournament_groups SET closes_at=clock_timestamp()-INTERVAL '1 day' WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3",[keyGroup.rows[0].season_key,keyGroup.rows[0].time_control,keyGroup.rows[0].stake_amount]);
    const blocked=await settleChessTournamentGroup(fixture.pool,String(keyGroup.rows[0].season_key),String(keyGroup.rows[0].time_control),Number(keyGroup.rows[0].stake_amount));
    assert.equal(blocked.unresolved,true);

    const scheduledNow=new Date(Date.now()-2*60_000).toISOString();
    const deadline=new Date(Date.now()+5*60_000).toISOString();
    const payable=await createPair({timeControl:"1+1",stake:20,scheduledAt:scheduledNow,deadlineAt:deadline});
    await ready(payable.first,payable.matchId);
    await ready(payable.second,payable.matchId);
    await fixture.pool.query("UPDATE chess_matches SET scheduled_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[payable.matchId]);
    await processDueChessTournamentMatches(fixture.pool);
    const resignation=await request(base,"/api/chess/"+payable.matchId+"/resign",{method:"POST",token:payable.first.token});
    assert.equal(resignation.status,200,resignation.body.message);
    const group=await fixture.pool.query("SELECT season_key,time_control,stake_amount FROM chess_matches WHERE id=$1",[payable.matchId]);
    await fixture.pool.query("UPDATE chess_tournament_groups SET closes_at=clock_timestamp()-INTERVAL '1 day' WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3",[group.rows[0].season_key,group.rows[0].time_control,group.rows[0].stake_amount]);
    const args=[String(group.rows[0].season_key),String(group.rows[0].time_control),Number(group.rows[0].stake_amount)];
    const walletBefore=await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[payable.first.user.id,payable.second.user.id]]);
    await fixture.pool.query(`CREATE FUNCTION security_it_chess_payout_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced chess payout rollback'; END $$`);
    await fixture.pool.query("CREATE TRIGGER security_it_chess_payout_fail BEFORE UPDATE ON admin_wallets FOR EACH ROW EXECUTE FUNCTION security_it_chess_payout_fail_fn()");
    await assert.rejects(()=>settleChessTournamentGroup(fixture.pool,...args),/forced chess payout rollback/);
    await fixture.pool.query("DROP TRIGGER security_it_chess_payout_fail ON admin_wallets");
    await fixture.pool.query("DROP FUNCTION security_it_chess_payout_fail_fn()");
    assert.equal((await readMatch(payable.matchId)).payout_status,"pending_competition");
    assert.deepEqual((await fixture.pool.query("SELECT user_id,balance,locked_balance FROM wallets WHERE user_id=ANY($1::int[]) ORDER BY user_id",[[payable.first.user.id,payable.second.user.id]])).rows,walletBefore.rows);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM chess_competition_settlements WHERE season_key=$1 AND time_control=$2 AND stake_amount=$3",args)).rows[0].n,0);
    const results=await Promise.all([
        settleChessTournamentGroup(fixture.pool,...args),
        settleChessTournamentGroup(fixture.lockPool,...args)
    ]);
    assert.equal(results.filter(item=>item.alreadySettled===true).length,1);
    assert.equal((await readMatch(payable.matchId)).payout_status,"competition_paid");
    const dispositions=await fixture.pool.query("SELECT disposition,count(*)::int AS n FROM chess_match_financial_dispositions WHERE match_id=$1 GROUP BY disposition",[payable.matchId]);
    assert.deepEqual(dispositions.rows.map(row=>[row.disposition,row.n]),[["competition_paid",2]]);
    const ledger=await fixture.pool.query(
        `SELECT SUM(e.debit)::numeric AS debits,SUM(e.credit)::numeric AS credits FROM financial_ledger_transactions t
          JOIN financial_ledger_entries e ON e.transaction_id=t.id WHERE t.reference=$1`,
        [`CHESS-POOL-${args[0]}-${args[1]}-${Number(args[2]).toFixed(2)}`]
    );
    assert.equal(Number(ledger.rows[0].debits),Number(ledger.rows[0].credits));
});
