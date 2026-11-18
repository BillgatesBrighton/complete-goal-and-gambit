"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
require("./config").readConfig();
const { createFixture } = require("./fixture");
const { request } = require("./httpHarness");
const authenticateToken = require("../../middleware/authMiddleware");
const authRoutes = require("../../routes/auth");
const chessCompetitionRoutes = require("../../routes/chessCompetitions");
const createAuthToken = require("../../services/authToken");
const { ACCOUNT_MUTATION_LOCK_NAMESPACE } = require("../../services/authSession");

const TEST_SECRET = "security-chess-competition-test-secret";
const GATE_KEY = "935710392";
const EXPECTED_DATABASE = "goal_gambit_security_test";
const EXPECTED_ROLE = "goal_gambit_security_test_user";
const DEFAULT_CLOCK = "10+5";
const DEFAULT_STAKE = 20;
let fixture;
let httpServer;
let httpBase;
let previousJwtSecret;

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    fixture = await createFixture();
    for (const [name, pool] of [["application", fixture.pool], ["Socket.IO lock", fixture.lockPool]]) {
        const result = await pool.query("SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name");
        assert.deepEqual(result.rows[0], {
            database_name: EXPECTED_DATABASE,
            role_name: EXPECTED_ROLE,
            schema_name: fixture.schema
        }, name + " pool must be isolated before chess competition fixture writes");
    }
    authenticateToken.setPool(fixture.pool);
    const app = express();
    app.use(express.json());
    const io = { in() { return { disconnectSockets() {} }; } };
    app.use("/api/auth", authRoutes(fixture.pool, authenticateToken, io));
    app.get("/api/me", authenticateToken, (req, res) => res.json({ success: true, userId: req.user.userId }));
    // The router owns a periodic payout timer in production. Keep this test focused
    // on request handlers while still instantiating the actual production router.
    const originalSetInterval = global.setInterval;
    global.setInterval = function () { return { unref() {} }; };
    try {
        app.use("/api/chess/competitions", chessCompetitionRoutes(fixture.pool, authenticateToken));
    } finally {
        global.setInterval = originalSetInterval;
    }
    httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
    });
    httpBase = "http://127.0.0.1:" + httpServer.address().port;
});

after(async () => {
    if (httpServer && httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
    if (fixture) await fixture.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
});

async function createUser(prefix) {
    const user = await fixture.createUser(prefix);
    await fixture.pool.query("UPDATE users SET game='chess' WHERE id=$1", [user.id]);
    await fixture.pool.query("INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,100,0,'KES')", [user.id]);
    return user;
}

async function createAdmin() {
    const user = await fixture.createUser("it_chess_comp_admin_");
    await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [user.id]);
    await fixture.pool.query("INSERT INTO admin_wallets(admin_id,balance,reserved_balance) VALUES($1,0,0)", [user.id]);
}

async function createSession(user) {
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const token = await createAuthToken({ ...user, auth_version: 0 }, client);
        await client.query("COMMIT");
        return { token, sessionId: jwt.verify(token, TEST_SECRET).jti, userId: Number(user.id) };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally { client.release(); }
}

async function competitionRequest(identity, action, timeControl, stake) {
    return request(httpBase, "/api/chess/competitions/tournament/entry" + (action ? "/" + action : ""), {
        method: "POST", token: identity.token, body: { timeControl: timeControl || DEFAULT_CLOCK, stake: stake === undefined ? DEFAULT_STAKE : stake }
    });
}

async function enter(identity, timeControl, stake) {
    return competitionRequest(identity, "", timeControl, stake);
}

async function seedMatch(userId, status) {
    const opponent = await createUser("it_chess_comp_opp_");
    const seasonResult = await fixture.pool.query("SELECT TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM') AS season_key");
    const matchResult = await fixture.pool.query(
        `INSERT INTO chess_matches(player_white_id,player_black_id,status,result,winner_id,started_at,finished_at,
                                   time_control,match_type,stake_amount,payout_status,season_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'tournament',$9,$10,$11) RETURNING id`,
        [userId, opponent.id, status, status === "completed" ? "white_win" : null,
            status === "completed" ? userId : null, status === "completed" ? new Date() : null,
            status === "completed" ? new Date() : null, DEFAULT_CLOCK, DEFAULT_STAKE,
            status === "completed" ? "pending_competition" : null, seasonResult.rows[0].season_key]
    );
    await fixture.pool.query("UPDATE wallets SET balance=balance-$1,locked_balance=locked_balance+$1 WHERE user_id=$2", [DEFAULT_STAKE, userId]);
    await fixture.pool.query("UPDATE wallets SET balance=balance-$1,locked_balance=locked_balance+$1 WHERE user_id=$2", [DEFAULT_STAKE, opponent.id]);
    await fixture.pool.query(
        `INSERT INTO chess_match_financial_dispositions(match_id,user_id,season_key,stake_amount,disposition)
         VALUES($1,$2,$3,$4,'pending'),($1,$5,$3,$4,'pending')`,
        [matchResult.rows[0].id,userId,seasonResult.rows[0].season_key,DEFAULT_STAKE,opponent.id]
    );
    return { id: Number(matchResult.rows[0].id), season: seasonResult.rows[0].season_key, opponentId: Number(opponent.id) };
}

async function snapshot(userId, timeControl, stake) {
    const result = await fixture.pool.query(`
        SELECT jsonb_build_object(
            'wallet', (SELECT jsonb_build_object('balance',balance::text,'locked',locked_balance::text)
                         FROM wallets WHERE user_id=$1),
            'entry', (SELECT jsonb_build_object('cancelled',cancelled_at IS NOT NULL,
                                                'forfeited',forfeited_at IS NOT NULL,
                                                'forfeited_amount',forfeited_amount::text)
                        FROM chess_tournament_entries
                       WHERE season_key=TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM')
                         AND time_control=$2 AND stake_amount=$3 AND user_id=$1),
            'matches', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'payout_status',payout_status)
                                                   ORDER BY id)
                                   FROM chess_matches
                                  WHERE match_type='tournament' AND time_control=$2 AND stake_amount=$3
                                    AND season_key=TO_CHAR(date_trunc('month',clock_timestamp() AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM')
                                    AND (player_white_id=$1 OR player_black_id=$1)), '[]'::jsonb),
            'player_transactions', (SELECT count(*)::int FROM transactions
                                     WHERE user_id=$1 AND transaction_type IN ('match_refund','chess_tournament_forfeit')),
            'ledger', COALESCE((SELECT jsonb_agg(jsonb_build_object('reference',t.reference,'type',t.transaction_type,
                                                                    'amount',t.amount::text,'account',e.account_type,
                                                                    'account_id',e.account_id,'debit',e.debit::text,
                                                                    'credit',e.credit::text) ORDER BY t.reference,e.account_type)
                                  FROM financial_ledger_transactions t
                                  JOIN financial_ledger_entries e ON e.transaction_id=t.id
                                 WHERE t.context->>'userId'=$1::text), '[]'::jsonb),
            'platform', (SELECT jsonb_build_object('balance',COALESCE(SUM(balance),0)::text,
                                                   'reserved',COALESCE(SUM(reserved_balance),0)::text)
                           FROM admin_wallets),
            'platform_transactions', (SELECT count(*)::int FROM admin_wallet_transactions)
        ) AS value`, [Number(userId), timeControl || DEFAULT_CLOCK, stake === undefined ? DEFAULT_STAKE : stake]);
    return result.rows[0].value;
}

async function addGateTrigger({ table, name, event, predicate, fail }) {
    name = name || "gate_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const fn = "security_it_chess_comp_" + name + "_fn";
    const trigger = "security_it_chess_comp_" + name;
    const gate = fail ? "RAISE EXCEPTION 'security integration forced chess competition rollback';" :
        "PERFORM pg_advisory_xact_lock(" + GATE_KEY + "::bigint);";
    await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF ${predicate} THEN ${gate} END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
}

async function startGate() {
    const client = await fixture.pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [GATE_KEY]);
    return async () => { await client.query("SELECT pg_advisory_unlock($1::bigint)", [GATE_KEY]); client.release(); };
}

async function waitFor(description, sql, params) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        const result = await fixture.pool.query(sql, params || []);
        if (result.rows[0] && result.rows[0].ready) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for PostgreSQL chess competition barrier: " + description);
}

async function waitForDomainWrite(table, verb) {
    await waitFor(table + " " + verb + " trigger", `SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1
    ) AS ready`, ["%" + verb + "%" + table + "%"]);
}

async function waitForAccountLock(userId, mode, granted) {
    await waitFor("account mutation lock " + mode + " granted=" + granted, `SELECT EXISTS(
        SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND mode=$3 AND granted=$4
    ) AS ready`, [ACCOUNT_MUTATION_LOCK_NAMESPACE, userId, mode, granted]);
}

async function assertLogoutWaits({ identity, action, timeControl, stake, trigger }) {
    await addGateTrigger(trigger);
    const before = await snapshot(identity.userId, timeControl, stake);
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = competitionRequest(identity, action, timeControl, stake);
        await waitForDomainWrite(trigger.table, trigger.event);
        await waitForAccountLock(identity.userId, "ShareLock", true);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock(identity.userId, "ExclusiveLock", false);
        assert.deepEqual(await snapshot(identity.userId, timeControl, stake), before,
            "domain and financial writes must remain uncommitted while the operation is paused");
    } finally { await releaseGate(); }
    const operationResult = await operation;
    assert.ok([200, 201].includes(operationResult.status), JSON.stringify(operationResult.body));
    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
    return { before, operationResult };
}

async function assertLogoutWins({ identity, action, timeControl, stake }) {
    const name = "logout_first_" + action + "_" + identity.userId;
    const fn = "security_it_chess_comp_" + name + "_fn";
    const trigger = "security_it_chess_comp_" + name;
    await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.id='${identity.sessionId}'::uuid THEN PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint); END IF;
        RETURN NEW; END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const before = await snapshot(identity.userId, timeControl, stake);
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock(identity.userId, "ExclusiveLock", true);
        operation = competitionRequest(identity, action, timeControl, stake);
        await waitForAccountLock(identity.userId, "ShareLock", false);
    } finally { await releaseGate(); }
    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
    const operationResult = await operation;
    assert.equal(operationResult.status, 401, JSON.stringify(operationResult.body));
    assert.deepEqual(await snapshot(identity.userId, timeControl, stake), before,
        "logout-first must reject the old session without entry, match, wallet or ledger changes");
}

async function seedUserForAction(prefix, action) {
    const user = await createUser(prefix);
    const identity = await createSession(user);
    assert.equal((await enter(identity)).status, 200);
    if (action === "cancel") await seedMatch(user.id, "waiting");
    if (action === "forfeit") await seedMatch(user.id, "completed");
    return { user, identity };
}

test("chess competition entry synchronizes with logout and preserves session isolation", async () => {
    const user = await createUser("it_chess_comp_entry_");
    const first = await createSession(user);
    const second = await createSession(user);
    const admitted = await assertLogoutWaits({ identity: first, action: "", trigger: {
        table: "chess_tournament_entries", name: "entry_admit_" + user.id,
        event: "INSERT", predicate: "NEW.user_id=" + Number(user.id)
    } });
    assert.equal(admitted.operationResult.status, 200);
    const after = await snapshot(user.id);
    assert.equal(after.wallet.balance, "100.00");
    assert.equal(after.wallet.locked, "0.00");
    assert.equal(after.entry.cancelled, false);
    assert.equal((await enter(second)).status, 200, "a distinct active session remains usable after the first session logs out");
    assert.equal((await request(httpBase, "/api/me", { token: second.token })).status, 200,
        "a separate active session remains authenticated after the first session logs out");
    const duplicate = await enter(second);
    assert.equal(duplicate.status, 200);
    assert.equal((await snapshot(user.id)).wallet.balance, "100.00");

    const blocked = await seedUserForAction("it_chess_comp_entry_lost_", "entry");
    await assertLogoutWins({ identity: blocked.identity, action: "" });

    const rollback = await createUser("it_chess_comp_entry_rb_");
    const rollbackIdentity = await createSession(rollback);
    await addGateTrigger({ table: "chess_tournament_entries", name: "entry_fail_" + rollback.id,
        event: "INSERT", predicate: "NEW.user_id=" + Number(rollback.id), fail: true });
    const rollbackBefore = await snapshot(rollback.id);
    const failed = await enter(rollbackIdentity);
    assert.equal(failed.status, 500);
    assert.deepEqual(await snapshot(rollback.id), rollbackBefore, "entry failure must roll back the upsert");
});

test("chess competition cancellation synchronizes and refunds exactly once", async () => {
    const user = await createUser("it_chess_comp_cancel_");
    const first = await createSession(user);
    const second = await createSession(user);
    assert.equal((await enter(first)).status, 200);
    const match = await seedMatch(user.id, "waiting");
    const admitted = await assertLogoutWaits({ identity: first, action: "cancel", trigger: {
        table: "wallets", name: "cancel_admit_" + user.id, event: "UPDATE",
        predicate: "NEW.user_id=" + Number(user.id) + " AND NEW.locked_balance < OLD.locked_balance"
    } });
    assert.equal(admitted.operationResult.body.refunded, DEFAULT_STAKE);
    let after = await snapshot(user.id);
    assert.equal(after.wallet.balance, "100.00");
    assert.equal(after.wallet.locked, "0.00");
    assert.equal(after.entry.cancelled, true);
    assert.equal(after.matches[0].status, "cancelled");
    const cancelLedger = await fixture.pool.query(`
        SELECT t.amount::text AS amount,e.account_type,e.debit::text AS debit,e.credit::text AS credit
          FROM financial_ledger_transactions t JOIN financial_ledger_entries e ON e.transaction_id=t.id
         WHERE t.transaction_type='chess_tournament_search_refund' AND t.context->>'userId'=$1::text
         ORDER BY t.id DESC`, [user.id]);
    assert.equal(cancelLedger.rows.length, 2);
    assert.ok(cancelLedger.rows.every(row => Number(row.amount) === DEFAULT_STAKE));
    assert.ok(cancelLedger.rows.some(row => row.account_type === "chess_match_locked" && Number(row.debit) === DEFAULT_STAKE && Number(row.credit) === 0));
    assert.ok(cancelLedger.rows.some(row => row.account_type === "user_wallet_available" && Number(row.debit) === 0 && Number(row.credit) === DEFAULT_STAKE));
    assert.equal((await competitionRequest(second, "cancel")).status, 404, "duplicate cancellation must not refund twice");
    assert.deepEqual(await snapshot(user.id), after);
    assert.equal((await enter(second)).status, 200, "another active session can still use the account after logout");

    const blocked = await seedUserForAction("it_chess_comp_cancel_lost_", "cancel");
    await assertLogoutWins({ identity: blocked.identity, action: "cancel" });

    const rollback = await createUser("it_chess_comp_cancel_rb_");
    const rollbackIdentity = await createSession(rollback);
    assert.equal((await enter(rollbackIdentity)).status, 200);
    await seedMatch(rollback.id, "waiting");
    await addGateTrigger({ table: "chess_tournament_entries", name: "cancel_fail_" + rollback.id,
        event: "UPDATE", predicate: "NEW.user_id=" + Number(rollback.id) + " AND NEW.cancelled_at IS NOT NULL", fail: true });
    const rollbackBefore = await snapshot(rollback.id);
    const failed = await competitionRequest(rollbackIdentity, "cancel");
    assert.equal(failed.status, 500);
    assert.deepEqual(await snapshot(rollback.id), rollbackBefore, "cancellation failure must roll back wallet, match, entry and ledger changes");
    assert.ok(match.id > 0);
});

test("chess competition forfeiture synchronizes the stake transfer and platform ledger", async () => {
    await createAdmin();
    const user = await createUser("it_chess_comp_forfeit_");
    const first = await createSession(user);
    const second = await createSession(user);
    assert.equal((await enter(first)).status, 200);
    const match = await seedMatch(user.id, "completed");
    const admitted = await assertLogoutWaits({ identity: first, action: "forfeit", trigger: {
        table: "wallets", name: "forfeit_admit_" + user.id, event: "UPDATE",
        predicate: "NEW.user_id=" + Number(user.id) + " AND NEW.locked_balance < OLD.locked_balance"
    } });
    assert.equal(admitted.operationResult.body.stakeTransferred, DEFAULT_STAKE);
    let after = await snapshot(user.id);
    assert.equal(after.wallet.balance, "80.00");
    assert.equal(after.wallet.locked, "0.00");
    assert.equal(after.entry.forfeited, true);
    assert.equal(Number(after.entry.forfeited_amount), DEFAULT_STAKE);
    assert.equal(after.matches[0].status, "completed");
    assert.equal(Number(after.platform.balance), DEFAULT_STAKE);
    const forfeitLedger = await fixture.pool.query(`
        SELECT t.amount::text AS amount,e.account_type,e.debit::text AS debit,e.credit::text AS credit
          FROM financial_ledger_transactions t JOIN financial_ledger_entries e ON e.transaction_id=t.id
         WHERE t.transaction_type='chess_tournament_forfeit_stake' AND t.context->>'userId'=$1::text
         ORDER BY t.id DESC`, [user.id]);
    assert.equal(forfeitLedger.rows.length, 2);
    assert.ok(forfeitLedger.rows.every(row => Number(row.amount) === DEFAULT_STAKE));
    assert.ok(forfeitLedger.rows.some(row => row.account_type === "chess_match_locked" && Number(row.debit) === DEFAULT_STAKE && Number(row.credit) === 0));
    assert.ok(forfeitLedger.rows.some(row => row.account_type === "admin_wallet_available" && Number(row.debit) === 0 && Number(row.credit) === DEFAULT_STAKE));
    assert.equal((await competitionRequest(second, "forfeit")).status, 409, "duplicate forfeiture must not transfer the stake twice");
    assert.deepEqual(await snapshot(user.id), after);
    assert.equal((await enter(second, "3+2", 50)).status, 200, "a second session remains usable for another valid competition entry");

    const blocked = await seedUserForAction("it_chess_comp_forfeit_lost_", "forfeit");
    await assertLogoutWins({ identity: blocked.identity, action: "forfeit" });

    const rollback = await createUser("it_chess_comp_forfeit_rb_");
    const rollbackIdentity = await createSession(rollback);
    assert.equal((await enter(rollbackIdentity)).status, 200);
    await seedMatch(rollback.id, "completed");
    await addGateTrigger({ table: "chess_tournament_entries", name: "forfeit_fail_" + rollback.id,
        event: "UPDATE", predicate: "NEW.user_id=" + Number(rollback.id) + " AND NEW.forfeited_at IS NOT NULL", fail: true });
    const rollbackBefore = await snapshot(rollback.id);
    const failed = await competitionRequest(rollbackIdentity, "forfeit");
    assert.equal(failed.status, 500);
    assert.deepEqual(await snapshot(rollback.id), rollbackBefore, "forfeiture failure must roll back wallet, platform, transaction, entry and ledger changes");
    assert.ok(match.id > 0);
});
