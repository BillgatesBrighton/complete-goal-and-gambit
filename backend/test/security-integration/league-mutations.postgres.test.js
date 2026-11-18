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
const leagueRoutes = require("../../routes/leagues");
const createAuthToken = require("../../services/authToken");
const { ACCOUNT_MUTATION_LOCK_NAMESPACE } = require("../../services/authSession");
const { creditPlatform } = require("../../services/adminWalletAccounting");

const TEST_SECRET = "security-league-test-secret";
const GATE_KEY = "864205173";
const EXPECTED_DATABASE = "goal_gambit_security_test";
const EXPECTED_ROLE = "goal_gambit_security_test_user";
let fixture;
let httpServer;
let httpBase;
let previousJwtSecret;

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    fixture = await createFixture();
    for (const [name, pool] of [["application", fixture.pool], ["lock", fixture.lockPool]]) {
        const result = await pool.query("SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name");
        assert.deepEqual(result.rows[0], {
            database_name: EXPECTED_DATABASE,
            role_name: EXPECTED_ROLE,
            schema_name: fixture.schema
        }, name + " pool must be isolated before league fixture writes");
    }
    authenticateToken.setPool(fixture.pool);
    const app = express();
    app.use(express.json());
    const io = { in() { return { disconnectSockets() {} }; } };
    app.use("/api/auth", authRoutes(fixture.pool, authenticateToken, io));
    app.use("/api/leagues", leagueRoutes(fixture.pool, authenticateToken));
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

async function createUser(prefix, role) {
    const user = await fixture.createUser(prefix);
    await fixture.pool.query("UPDATE users SET game='konami',role=COALESCE($2,role) WHERE id=$1", [user.id, role || null]);
    await fixture.pool.query("INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,100,0,'KES')", [user.id]);
    return user;
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
    } finally {
        client.release();
    }
}

async function createLeague(prefix, fee) {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const result = await fixture.pool.query(
        "INSERT INTO efootball_leagues(name,entry_stake,status) VALUES($1,$2,'open') RETURNING id,name",
        [((prefix + suffix).slice(0, 30)), fee]
    );
    return result.rows[0];
}

async function createPlatformAdmins(count) {
    const admins = [];
    for (let index = 0; index < count; index += 1) {
        const admin = await fixture.createUser("it_league_admin_");
        await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
        await fixture.pool.query("INSERT INTO admin_wallets(admin_id,balance,reserved_balance) VALUES($1,0,0)", [admin.id]);
        admins.push(admin);
    }
    return admins;
}

async function join(identity, league) {
    return request(httpBase, "/api/leagues/" + league.id + "/join", { method: "POST", token: identity.token, body: {} });
}

async function seedLeagueEntry(identity, league, fee) {
    const admins = await createPlatformAdmins(2);
    const entryReference = "LEAGUE-" + league.id + "-" + identity.userId + "-seed";
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("UPDATE wallets SET balance=balance-$1 WHERE user_id=$2", [fee, identity.userId]);
        await client.query(
            `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
             VALUES($1,'league_entry',$2,'KES','completed',$3,'test league entry')`,
            [identity.userId, fee, entryReference]
        );
        await creditPlatform(client, {
            amount: fee, reference: entryReference, transactionType: "league_entry_fee",
            description: "test league entry", context: { competitionType: "league", competitionId: Number(league.id), userId: identity.userId },
            reserve: true, debitPostings: [{ accountType: "user_wallet_available", accountId: identity.userId, debit: fee }]
        });
        await client.query(
            `INSERT INTO efootball_league_members(league_id,user_id,fee_paid,fee_transferred,entry_reference)
             VALUES($1,$2,$3,TRUE,$4)`, [league.id, identity.userId, fee, entryReference]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    return admins;
}

async function seedFirstFixture(identity, league) {
    const opponent = await createUser("it_league_opp_");
    await fixture.pool.query(
        "INSERT INTO efootball_league_members(league_id,user_id,fee_paid,fee_transferred) VALUES($1,$2,0,FALSE)",
        [league.id, opponent.id]
    );
    const result = await fixture.pool.query(
        `INSERT INTO efootball_league_fixtures(league_id,round_number,home_id,away_id,status)
         VALUES($1,1,$2,$3,'scheduled') RETURNING id`, [league.id, identity.userId, opponent.id]
    );
    return result.rows[0].id;
}

async function stateFor(kind, leagueId, userId) {
    const result = await fixture.pool.query(`
        SELECT l.status,
               COALESCE(w.balance,0)::numeric AS balance,
               COALESCE(w.locked_balance,0)::numeric AS locked_balance,
               (SELECT count(*)::int FROM efootball_league_members WHERE league_id=$1 AND user_id=$2) AS member_count,
               (SELECT played FROM efootball_league_members WHERE league_id=$1 AND user_id=$2) AS played,
               (SELECT forfeited_at FROM efootball_league_members WHERE league_id=$1 AND user_id=$2) AS forfeited_at,
               (SELECT status FROM efootball_league_fixtures WHERE league_id=$1 AND home_id=$2 ORDER BY id LIMIT 1) AS fixture_status,
               (SELECT count(*)::int FROM transactions WHERE user_id=$2 AND transaction_type IN ('league_entry','league_entry_refund','league_refund','league_forfeit')
                 AND (reference LIKE 'LEAGUE-'||$1::text||'-%' OR reference LIKE 'LEAGUE-CANCEL-'||$1::text||'-%' OR reference LIKE 'LEAGUE-FORFEIT-'||$1::text||'-%')) AS transaction_count,
               (SELECT count(*)::int FROM financial_ledger_transactions WHERE context->>'competitionId'=$1::text) AS ledger_count
          FROM efootball_leagues l LEFT JOIN wallets w ON w.user_id=$2 WHERE l.id=$1`, [leagueId, userId]);
    assert.equal(result.rows.length, 1, kind + " league should exist");
    return result.rows[0];
}

async function addGateTrigger({ table, name, when, fail }) {
    const fn = "security_it_league_" + name + "_fn";
    const trigger = "security_it_league_" + name;
    await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ${when} THEN
          ${fail ? "RAISE EXCEPTION 'security integration forced league rollback';" : "PERFORM pg_advisory_xact_lock(" + GATE_KEY + "::bigint);"}
        END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE ${name.startsWith("join") ? "INSERT" : "UPDATE OR DELETE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
}

async function startGate() {
    const client = await fixture.pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [GATE_KEY]);
    return async () => { await client.query("SELECT pg_advisory_unlock($1::bigint)", [GATE_KEY]); client.release(); };
}

async function waitFor(description, query, params) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        const result = await fixture.pool.query(query, params || []);
        if (result.rows[0] && result.rows[0].ready) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for PostgreSQL barrier: " + description);
}

async function waitForGate(table) {
    await waitFor(table + " write paused in trigger", `SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1
    ) AS ready`, ["%" + table + "%"]);
}

async function waitForAccountLock(mode, granted, userId) {
    await waitFor("account mutation lock " + mode + " granted=" + granted, `SELECT EXISTS(
        SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND mode=$3 AND granted=$4
    ) AS ready`, [ACCOUNT_MUTATION_LOCK_NAMESPACE, userId, mode, granted]);
}

async function logoutFirst(identity, routePath, body, stateQuery, leagueId, userId) {
    const releaseGate = await startGate();
    let logoutPromise;
    let operationPromise;
    try {
        const trigger = "security_it_league_logout_first_" + leagueId;
        const fn = trigger + "_fn";
        await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF OLD.id='${identity.sessionId}'::uuid THEN PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint); END IF;
            RETURN NEW; END $$`);
        await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock("ExclusiveLock", true, identity.userId);
        operationPromise = request(httpBase, routePath, { method: "POST", token: identity.token, body });
        await waitForAccountLock("ShareLock", false, identity.userId);
    } finally { await releaseGate(); }
    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
    const operationResult = await operationPromise;
    assert.equal(operationResult.status, 401, JSON.stringify(operationResult.body));
    const state = await fixture.pool.query(stateQuery, [leagueId, userId]);
    assert.deepEqual(state.rows[0], { mutated: false }, "logout-first must prevent all league state changes");
}

test("league join synchronizes entry fee and membership with logout", async () => {
    await createPlatformAdmins(2);
    const user = await createUser("it_league_join_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const league = await createLeague("IT Join ", 10);
    const before = await stateFor("join", league.id, user.id);

    await addGateTrigger({ table: "efootball_league_members", name: "join_gate_" + league.id, when: "NEW.league_id=" + Number(league.id) + " AND NEW.user_id=" + Number(user.id) });
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = join(identity, league);
        await waitForGate("efootball_league_members");
        await waitForAccountLock("ShareLock", true, user.id);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock("ExclusiveLock", false, user.id);
    } finally { await releaseGate(); }
    assert.equal((await operation).status, 200);
    assert.equal((await logoutPromise).status, 200);
    const after = await stateFor("join", league.id, user.id);
    assert.equal(Number(after.balance), Number(before.balance) - 10);
    assert.equal(after.member_count, 1);
    assert.equal(after.transaction_count, 1);
    assert.equal(after.ledger_count, 1);
    const secondJoin = await join(second, league);
    assert.equal(secondJoin.status, 200);
    assert.equal(secondJoin.body.alreadyJoined, true);

    const oldSession = await createSession(user);
    const blockedLeague = await createLeague("IT Join Block ", 10);
    const blockedBefore = await stateFor("join", blockedLeague.id, user.id);
    await logoutFirst(oldSession, "/api/leagues/" + blockedLeague.id + "/join", {},
        "SELECT FALSE AS mutated WHERE $1::int=$1::int AND $2::int=$2::int", blockedLeague.id, user.id);
    assert.deepEqual(await stateFor("join", blockedLeague.id, user.id), blockedBefore);

    const rollbackUser = await createUser("it_league_join_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackLeague = await createLeague("IT Join Rollback ", 10);
    await addGateTrigger({ table: "efootball_league_members", name: "join_fail_" + rollbackLeague.id, when: "NEW.league_id=" + Number(rollbackLeague.id) + " AND NEW.user_id=" + Number(rollbackUser.id), fail: true });
    const failed = await join(rollbackIdentity, rollbackLeague);
    assert.equal(failed.status, 500);
    const rollbackState = await stateFor("join", rollbackLeague.id, rollbackUser.id);
    assert.equal(Number(rollbackState.balance), 100);
    assert.equal(rollbackState.member_count, 0);
    assert.equal(rollbackState.transaction_count, 0);
    assert.equal(rollbackState.ledger_count, 0);

    const duplicate = await join(second, league);
    assert.equal(duplicate.status, 200);
    const duplicateState = await stateFor("join", league.id, user.id);
    assert.equal(duplicateState.transaction_count, 1);
    assert.equal(duplicateState.ledger_count, 1);
});

test("league cancel synchronizes refunds and membership removal with logout", async () => {
    const user = await createUser("it_league_cancel_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const league = await createLeague("IT Cancel ", 10);
    await seedLeagueEntry(identity, league, 10);
    const path = "/api/leagues/" + league.id + "/cancel";
    const before = await stateFor("cancel", league.id, user.id);

    await addGateTrigger({ table: "efootball_league_members", name: "cancel_gate_" + league.id,
        when: "OLD.league_id=" + Number(league.id) + " AND OLD.user_id=" + Number(user.id) });
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = request(httpBase, path, { method: "POST", token: identity.token, body: {} });
        await waitForGate("efootball_league_members");
        await waitForAccountLock("ShareLock", true, user.id);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock("ExclusiveLock", false, user.id);
    } finally { await releaseGate(); }
    assert.equal((await operation).status, 200);
    assert.equal((await logoutPromise).status, 200);
    const after = await stateFor("cancel", league.id, user.id);
    assert.equal(Number(after.balance), Number(before.balance) + 10);
    assert.equal(after.member_count, 0);
    assert.equal(after.transaction_count, before.transaction_count, "reserved-fee refunds are recorded in the financial journal, not the player transaction table");
    assert.equal(after.ledger_count, before.ledger_count + 1);
    assert.equal((await request(httpBase, path, { method: "POST", token: second.token, body: {} })).status, 404);

    const oldSession = await createSession(user);
    const blockedLeague = await createLeague("IT Cancel Block ", 10);
    await seedLeagueEntry(oldSession, blockedLeague, 10);
    const blockedBefore = await stateFor("cancel", blockedLeague.id, user.id);
    await logoutFirst(oldSession, "/api/leagues/" + blockedLeague.id + "/cancel", {},
        "SELECT FALSE AS mutated WHERE $1::int=$1::int AND $2::int=$2::int", blockedLeague.id, user.id);
    assert.deepEqual(await stateFor("cancel", blockedLeague.id, user.id), blockedBefore);

    const rollbackUser = await createUser("it_league_cancel_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackLeague = await createLeague("IT Cancel Rollback ", 10);
    await seedLeagueEntry(rollbackIdentity, rollbackLeague, 10);
    await addGateTrigger({ table: "efootball_league_members", name: "cancel_fail_" + rollbackLeague.id,
        when: "OLD.league_id=" + Number(rollbackLeague.id) + " AND OLD.user_id=" + Number(rollbackUser.id), fail: true });
    const failure = await request(httpBase, "/api/leagues/" + rollbackLeague.id + "/cancel", { method: "POST", token: rollbackIdentity.token, body: {} });
    assert.equal(failure.status, 500);
    const rollbackAfter = await stateFor("cancel", rollbackLeague.id, rollbackUser.id);
    assert.equal(Number(rollbackAfter.balance), 90);
    assert.equal(rollbackAfter.member_count, 1);
    assert.equal(rollbackAfter.transaction_count, 1);
    assert.equal(rollbackAfter.ledger_count, 1);

    const duplicate = await request(httpBase, path, { method: "POST", token: second.token, body: {} });
    assert.equal(duplicate.status, 404);
    const final = await stateFor("cancel", league.id, user.id);
    assert.equal(final.transaction_count, after.transaction_count);
    assert.equal(final.ledger_count, after.ledger_count);
});

test("league forfeit synchronizes walkover settlement and accounting with logout", async () => {
    await createPlatformAdmins(2);
    const user = await createUser("it_league_forfeit_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const league = await createLeague("IT Forfeit ", 0);
    await fixture.pool.query("UPDATE wallets SET balance=90,locked_balance=10 WHERE user_id=$1", [user.id]);
    await fixture.pool.query("INSERT INTO efootball_league_members(league_id,user_id,fee_paid,fee_transferred) VALUES($1,$2,10,FALSE)", [league.id, user.id]);
    const fixtureId = await seedFirstFixture(identity, league);
    const path = "/api/leagues/" + league.id + "/forfeit";
    const before = await stateFor("forfeit", league.id, user.id);

    await addGateTrigger({ table: "efootball_league_fixtures", name: "forfeit_gate_" + league.id,
        when: "OLD.id=" + Number(fixtureId) });
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = request(httpBase, path, { method: "POST", token: identity.token, body: {} });
        await waitForGate("efootball_league_fixtures");
        await waitForAccountLock("ShareLock", true, user.id);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock("ExclusiveLock", false, user.id);
    } finally { await releaseGate(); }
    assert.equal((await operation).status, 200);
    assert.equal((await logoutPromise).status, 200);
    const after = await stateFor("forfeit", league.id, user.id);
    assert.equal(after.fixture_status, "walkover");
    assert.ok(after.forfeited_at);
    assert.equal(Number(after.played), 1);
    assert.equal(Number(after.balance), 90);
    assert.equal(Number(after.locked_balance), 0);
    assert.equal(after.transaction_count, before.transaction_count + 1);
    assert.equal(after.ledger_count, before.ledger_count + 1);
    assert.equal((await request(httpBase, path, { method: "POST", token: second.token, body: {} })).status, 409);

    const oldSession = await createSession(user);
    const blockedLeague = await createLeague("IT Forfeit Block ", 0);
    await fixture.pool.query("INSERT INTO efootball_league_members(league_id,user_id) VALUES($1,$2)", [blockedLeague.id, user.id]);
    const blockedFixture = await seedFirstFixture(oldSession, blockedLeague);
    const blockedBefore = await stateFor("forfeit", blockedLeague.id, user.id);
    await logoutFirst(oldSession, "/api/leagues/" + blockedLeague.id + "/forfeit", {},
        "SELECT FALSE AS mutated WHERE $1::int=$1::int AND $2::int=$2::int", blockedLeague.id, user.id);
    assert.deepEqual(await stateFor("forfeit", blockedLeague.id, user.id), blockedBefore);
    assert.ok(blockedFixture);

    const rollbackUser = await createUser("it_league_forfeit_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackLeague = await createLeague("IT Forfeit Rollback ", 0);
    await fixture.pool.query("UPDATE wallets SET balance=90,locked_balance=10 WHERE user_id=$1", [rollbackUser.id]);
    await fixture.pool.query("INSERT INTO efootball_league_members(league_id,user_id,fee_paid,fee_transferred) VALUES($1,$2,10,FALSE)", [rollbackLeague.id, rollbackUser.id]);
    const rollbackFixture = await seedFirstFixture(rollbackIdentity, rollbackLeague);
    await addGateTrigger({ table: "efootball_league_fixtures", name: "forfeit_fail_" + rollbackLeague.id,
        when: "OLD.id=" + Number(rollbackFixture), fail: true });
    const failure = await request(httpBase, "/api/leagues/" + rollbackLeague.id + "/forfeit", { method: "POST", token: rollbackIdentity.token, body: {} });
    assert.equal(failure.status, 500);
    const rollbackAfter = await stateFor("forfeit", rollbackLeague.id, rollbackUser.id);
    assert.equal(rollbackAfter.fixture_status, "scheduled");
    assert.equal(rollbackAfter.forfeited_at, null);
    assert.equal(rollbackAfter.played, 0);
    assert.equal(Number(rollbackAfter.balance), 90);
    assert.equal(Number(rollbackAfter.locked_balance), 10);
    assert.equal(rollbackAfter.transaction_count, 0);
    assert.equal(rollbackAfter.ledger_count, 0);

    const duplicate = await request(httpBase, path, { method: "POST", token: second.token, body: {} });
    assert.equal(duplicate.status, 409);
    const final = await stateFor("forfeit", league.id, user.id);
    assert.equal(final.fixture_status, "walkover");
    assert.equal(final.played, 1);
    assert.equal(final.transaction_count, 1);
    assert.equal(final.ledger_count, 1);
});
