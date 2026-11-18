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
const tournamentRoutes = require("../../routes/tournaments");
const createAuthToken = require("../../services/authToken");
const { ACCOUNT_MUTATION_LOCK_NAMESPACE } = require("../../services/authSession");

const TEST_SECRET = "security-tournament-test-secret";
const GATE_KEY = "935710284";
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
        }, name + " pool must be isolated before tournament fixture writes");
    }
    authenticateToken.setPool(fixture.pool);
    const app = express();
    app.use(express.json());
    const io = { in() { return { disconnectSockets() {} }; } };
    app.use("/api/auth", authRoutes(fixture.pool, authenticateToken, io));
    app.use("/api/tournaments", tournamentRoutes(fixture.pool, authenticateToken, {}));
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
    await fixture.pool.query("UPDATE users SET game='konami' WHERE id=$1", [user.id]);
    await fixture.pool.query("INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,100,0,'KES')", [user.id]);
    return user;
}

async function createAdmins(count) {
    for (let i = 0; i < count; i += 1) {
        const admin = await fixture.createUser("it_tournament_admin_");
        await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
        await fixture.pool.query("INSERT INTO admin_wallets(admin_id,balance,reserved_balance) VALUES($1,0,0)", [admin.id]);
    }
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

async function createTournament(prefix, fee, status) {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const result = await fixture.pool.query(
        "INSERT INTO efootball_tournaments(name,entry_fee,max_players,status) VALUES($1,$2,8,$3) RETURNING id,name",
        [(prefix + suffix).slice(0, 100), fee, status || "open"]
    );
    return result.rows[0];
}

async function route(identity, tournament, action) {
    return request(httpBase, "/api/tournaments/" + tournament.id + "/" + action, {
        method: "POST", token: identity.token, body: {}
    });
}

async function join(identity, tournament) { return route(identity, tournament, "join"); }

async function seedForfeit(identity, tournament, fee) {
    const opponent = await createUser("it_tournament_opp_");
    await fixture.pool.query("UPDATE efootball_tournaments SET status='in_progress' WHERE id=$1", [tournament.id]);
    await fixture.pool.query("UPDATE wallets SET balance=balance-$1,locked_balance=locked_balance+$1 WHERE user_id=$2", [fee, identity.userId]);
    const reference = fee > 0 ? "TOURN-SEED-" + tournament.id + "-" + identity.userId : null;
    await fixture.pool.query(
        `INSERT INTO efootball_tournament_members(tournament_id,user_id,group_code,fee_paid,fee_transferred,entry_reference,played)
         VALUES($1,$2,'A',$3,FALSE,$4,1)`, [tournament.id, identity.userId, fee, reference]
    );
    await fixture.pool.query(
        "INSERT INTO efootball_tournament_members(tournament_id,user_id,group_code) VALUES($1,$2,'A')", [tournament.id, opponent.id]
    );
    const fixtureRow = await fixture.pool.query(
        `INSERT INTO efootball_tournament_fixtures(tournament_id,round_number,group_code,home_id,away_id,status)
         VALUES($1,1,'A',$2,$3,'scheduled') RETURNING id`, [tournament.id, identity.userId, opponent.id]
    );
    return { opponent, fixtureId: Number(fixtureRow.rows[0].id) };
}

async function state(tournament, userId) {
    const result = await fixture.pool.query(`
        SELECT t.status,
               w.balance::numeric AS balance,w.locked_balance::numeric AS locked_balance,
               m.fee_paid::numeric AS fee_paid,m.fee_transferred,m.entry_reference,m.forfeited_at,m.played,
               (SELECT count(*)::int FROM efootball_tournament_members WHERE tournament_id=$1 AND user_id=$2) AS member_count,
               (SELECT status FROM efootball_tournament_fixtures WHERE tournament_id=$1 ORDER BY id LIMIT 1) AS fixture_status,
               (SELECT count(*)::int FROM transactions WHERE user_id=$2 AND transaction_type IN ('tournament_entry','tournament_refund','tournament_forfeit')
                 AND (reference LIKE 'TOURN-'||$1::text||'-%' OR reference LIKE 'TOURN-CANCEL-'||$1::text||'-%' OR reference LIKE 'TOURN-FORFEIT-'||$1::text||'-%')) AS transaction_count,
               (SELECT count(*)::int FROM financial_ledger_transactions WHERE context->>'competitionId'=$1::text) AS ledger_count
          FROM efootball_tournaments t JOIN wallets w ON w.user_id=$2
          LEFT JOIN efootball_tournament_members m ON m.tournament_id=t.id AND m.user_id=$2
         WHERE t.id=$1`, [tournament.id, userId]);
    assert.equal(result.rows.length, 1);
    return result.rows[0];
}

async function addGateTrigger({ table, name, predicate, fail }) {
    const fn = "security_it_tournament_" + name + "_fn";
    const trigger = "security_it_tournament_" + name;
    const event = name.startsWith("join") ? "INSERT" : name.startsWith("cancel") ? "DELETE" : "UPDATE";
    await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF ${predicate} THEN ${fail ? "RAISE EXCEPTION 'security integration forced tournament rollback';" : "PERFORM pg_advisory_xact_lock(" + GATE_KEY + "::bigint);"} END IF;
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
    throw new Error("Timed out waiting for PostgreSQL tournament barrier: " + description);
}

async function waitForDomainWrite(table) {
    await waitFor(table + " write in trigger", `SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1
    ) AS ready`, ["%" + table + "%"]);
}

async function waitForAccountLock(userId, mode, granted) {
    await waitFor("account mutation lock " + mode + " granted=" + granted, `SELECT EXISTS(
        SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND mode=$3 AND granted=$4
    ) AS ready`, [ACCOUNT_MUTATION_LOCK_NAMESPACE, userId, mode, granted]);
}

async function assertLogoutWaits({ identity, tournament, action, gateTable, gatePredicate, snapshot }) {
    await addGateTrigger({ table: gateTable, name: action + "_gate_" + tournament.id, predicate: gatePredicate });
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = route(identity, tournament, action);
        await waitForDomainWrite(gateTable);
        await waitForAccountLock(identity.userId, "ShareLock", true);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock(identity.userId, "ExclusiveLock", false);
        assert.deepEqual(await state(tournament, identity.userId), snapshot, "transaction writes remain uncommitted while paused");
    } finally { await releaseGate(); }
    const operationResult = await operation;
    assert.ok([200, 201].includes(operationResult.status), JSON.stringify(operationResult.body));
    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
    return operationResult;
}

async function assertLogoutWins({ identity, tournament, action, before }) {
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        const name = "logout_first_" + action + "_" + tournament.id;
        const fn = "security_it_tournament_" + name + "_fn";
        await fixture.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF OLD.id='${identity.sessionId}'::uuid THEN PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint); END IF;
            RETURN NEW; END $$`);
        await fixture.pool.query(`CREATE TRIGGER security_it_tournament_${name} BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        await waitForAccountLock(identity.userId, "ExclusiveLock", true);
        operation = route(identity, tournament, action);
        await waitForAccountLock(identity.userId, "ShareLock", false);
    } finally { await releaseGate(); }
    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
    const operationResult = await operation;
    assert.equal(operationResult.status, 401, JSON.stringify(operationResult.body));
    assert.deepEqual(await state(tournament, identity.userId), before, "logout-first rejects the old session without tournament or financial changes");
}

test("tournament entry synchronizes entry fee, platform accounting and membership with logout", async () => {
    await createAdmins(2);
    const user = await createUser("it_tournament_join_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const tournament = await createTournament("IT Entry ", 12, "open");
    const before = await state(tournament, user.id);
    const admitted = await assertLogoutWaits({
        identity, tournament, action: "join", gateTable: "efootball_tournament_members",
        gatePredicate: "NEW.tournament_id=" + Number(tournament.id) + " AND NEW.user_id=" + Number(user.id), snapshot: before
    });
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
    const after = await state(tournament, user.id);
    assert.equal(Number(after.balance), Number(before.balance) - 12);
    assert.equal(after.member_count, 1);
    assert.equal(after.transaction_count, 1);
    assert.equal(after.ledger_count, 1);
    const duplicate = await join(second, tournament);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.alreadyJoined, true);
    const duplicateState = await state(tournament, user.id);
    assert.equal(Number(duplicateState.balance), Number(after.balance));
    assert.equal(duplicateState.transaction_count, 1);
    assert.equal(duplicateState.ledger_count, 1);

    const oldSession = await createSession(user);
    const blocked = await createTournament("IT Entry Block ", 12, "open");
    const blockedBefore = await state(blocked, user.id);
    await assertLogoutWins({ identity: oldSession, tournament: blocked, action: "join", before: blockedBefore });

    const rollbackUser = await createUser("it_tournament_join_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackTournament = await createTournament("IT Entry Rollback ", 12, "open");
    await addGateTrigger({ table: "efootball_tournament_members", name: "join_fail_" + rollbackTournament.id,
        predicate: "NEW.tournament_id=" + Number(rollbackTournament.id) + " AND NEW.user_id=" + Number(rollbackUser.id), fail: true });
    const failed = await join(rollbackIdentity, rollbackTournament);
    assert.equal(failed.status, 500);
    const rolledBack = await state(rollbackTournament, rollbackUser.id);
    assert.equal(Number(rolledBack.balance), 100);
    assert.equal(rolledBack.member_count, 0);
    assert.equal(rolledBack.transaction_count, 0);
    assert.equal(rolledBack.ledger_count, 0);
});

test("tournament cancellation synchronizes refunds and fixture changes with logout", async () => {
    await createAdmins(2);
    const user = await createUser("it_tournament_cancel_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const tournament = await createTournament("IT Cancel ", 10, "open");
    assert.equal((await join(identity, tournament)).status, 201);
    const before = await state(tournament, user.id);
    await assertLogoutWaits({
        identity, tournament, action: "cancel", gateTable: "efootball_tournament_members",
        gatePredicate: "OLD.tournament_id=" + Number(tournament.id) + " AND OLD.user_id=" + Number(user.id), snapshot: before
    });
    const after = await state(tournament, user.id);
    assert.equal(Number(after.balance), Number(before.balance) + 10);
    assert.equal(after.member_count, 0);
    assert.equal(after.ledger_count, before.ledger_count + 1);
    assert.equal((await route(second, tournament, "cancel")).status, 404);
    const afterDuplicate = await state(tournament, user.id);
    assert.equal(Number(afterDuplicate.balance), Number(after.balance));
    assert.equal(afterDuplicate.ledger_count, after.ledger_count);

    const oldSession = await createSession(user);
    const blocked = await createTournament("IT Cancel Block ", 10, "open");
    assert.equal((await join(oldSession, blocked)).status, 201);
    const blockedBefore = await state(blocked, user.id);
    await assertLogoutWins({ identity: oldSession, tournament: blocked, action: "cancel", before: blockedBefore });

    const rollbackUser = await createUser("it_tournament_cancel_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackTournament = await createTournament("IT Cancel Rollback ", 10, "open");
    assert.equal((await join(rollbackIdentity, rollbackTournament)).status, 201);
    const rollbackBefore = await state(rollbackTournament, rollbackUser.id);
    await addGateTrigger({ table: "efootball_tournament_members", name: "cancel_fail_" + rollbackTournament.id,
        predicate: "OLD.tournament_id=" + Number(rollbackTournament.id) + " AND OLD.user_id=" + Number(rollbackUser.id), fail: true });
    const failed = await route(rollbackIdentity, rollbackTournament, "cancel");
    assert.equal(failed.status, 500);
    assert.deepEqual(await state(rollbackTournament, rollbackUser.id), rollbackBefore);
});

test("tournament forfeiture synchronizes stake transfer and walkovers with logout", async () => {
    await createAdmins(2);
    const user = await createUser("it_tournament_forfeit_");
    const identity = await createSession(user);
    const second = await createSession(user);
    const tournament = await createTournament("IT Forfeit ", 0, "in_progress");
    const { fixtureId } = await seedForfeit(identity, tournament, 10);
    const before = await state(tournament, user.id);
    assert.equal(Number(before.balance), 90, "the fixture reserves 10 from the initial 100 available units");
    assert.equal(Number(before.locked_balance), 10, "the fixture holds the reserved stake before forfeiture");
    await assertLogoutWaits({
        identity, tournament, action: "forfeit", gateTable: "efootball_tournament_members",
        gatePredicate: "NEW.tournament_id=" + Number(tournament.id) + " AND NEW.user_id=" + Number(user.id) + " AND NEW.forfeited_at IS NOT NULL", snapshot: before
    });
    const after = await state(tournament, user.id);
    assert.equal(after.forfeited_at !== null, true);
    assert.equal(after.fixture_status, "walkover");
    assert.equal(Number(after.balance), 90, "forfeiture transfers the locked stake and does not restore available funds");
    assert.equal(Number(after.locked_balance), 0);
    assert.equal(after.transaction_count, 1);
    assert.equal(after.ledger_count, 1);
    const forfeitureLedger = await fixture.pool.query(`
        SELECT t.reference,t.amount::numeric AS amount,t.posted_at,e.account_type,
               SUM(e.debit)::numeric AS debit,SUM(e.credit)::numeric AS credit
          FROM financial_ledger_transactions t
          JOIN financial_ledger_entries e ON e.transaction_id=t.id
         WHERE t.reference=$1
         GROUP BY t.id,e.account_type ORDER BY e.account_type`, [after.entry_reference]);
    assert.equal(forfeitureLedger.rows.length, 2, "forfeiture must post locked-stake debit and platform-reserve credit");
    assert.ok(forfeitureLedger.rows.every(row => row.posted_at !== null));
    assert.ok(forfeitureLedger.rows.every(row => Number(row.amount) === 10));
    const userPosting = forfeitureLedger.rows.find(row => row.account_type === "user_wallet_locked");
    const platformPosting = forfeitureLedger.rows.find(row => row.account_type === "admin_wallet_reserved");
    assert.ok(userPosting, "ledger must debit the player's locked wallet");
    assert.ok(platformPosting, "ledger must credit reserved platform wallets");
    assert.equal(Number(userPosting.debit), 10);
    assert.equal(Number(userPosting.credit), 0);
    assert.equal(Number(platformPosting.debit), 0);
    assert.equal(Number(platformPosting.credit), 10);
    const duplicate = await route(second, tournament, "forfeit");
    assert.equal(duplicate.status, 409);
    const afterDuplicate = await state(tournament, user.id);
    assert.equal(Number(afterDuplicate.balance), Number(after.balance));
    assert.equal(afterDuplicate.transaction_count, 1);
    assert.equal(afterDuplicate.ledger_count, 1);
    assert.ok(fixtureId > 0);

    const oldSession = await createSession(user);
    const blockedTournament = await createTournament("IT Forfeit Block ", 0, "in_progress");
    await seedForfeit(oldSession, blockedTournament, 0);
    const blockedBefore = await state(blockedTournament, user.id);
    await assertLogoutWins({ identity: oldSession, tournament: blockedTournament, action: "forfeit", before: blockedBefore });

    const rollbackUser = await createUser("it_tournament_forfeit_rb_");
    const rollbackIdentity = await createSession(rollbackUser);
    const rollbackTournament = await createTournament("IT Forfeit Rollback ", 0, "in_progress");
    const seeded = await seedForfeit(rollbackIdentity, rollbackTournament, 10);
    const rollbackBefore = await state(rollbackTournament, rollbackUser.id);
    await addGateTrigger({ table: "efootball_tournament_fixtures", name: "forfeit_fail_" + rollbackTournament.id,
        predicate: "OLD.id=" + Number(seeded.fixtureId), fail: true });
    const failed = await route(rollbackIdentity, rollbackTournament, "forfeit");
    assert.equal(failed.status, 500);
    assert.deepEqual(await state(rollbackTournament, rollbackUser.id), rollbackBefore);
});
