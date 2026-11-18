"use strict";

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
require("./config").readConfig();
const { createFixture } = require("./fixture");
const { request } = require("./httpHarness");
const authenticateToken = require("../../middleware/authMiddleware");
const authRoutes = require("../../routes/auth");
const walletRoutes = require("../../routes/wallet");
const adminWalletRoutes = require("../../routes/adminWallet");
const createAuthToken = require("../../services/authToken");
const {
    ACCOUNT_MUTATION_LOCK_NAMESPACE
} = require("../../services/authSession");

const TEST_SECRET = "security-wallet-test-secret";
const GATE_KEY = "830716420";
const EXPECTED_DATABASE = "goal_gambit_security_test";
const EXPECTED_ROLE = "goal_gambit_security_test_user";
let fixture;
let httpServer;
let httpBase;
let previousJwtSecret;
let previousAllowTestDeposits;
let previousAdminUserIds;

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    previousAllowTestDeposits = process.env.ALLOW_TEST_DEPOSITS;
    previousAdminUserIds = process.env.ADMIN_USER_IDS;
    process.env.JWT_SECRET = TEST_SECRET;
    // The production test-deposit route remains disabled by default. Enable it
    // only in this isolated test process to exercise its real transaction.
    process.env.ALLOW_TEST_DEPOSITS = "true";
    fixture = await createFixture();

    for (const [poolName, pool] of [["application", fixture.pool], ["Socket.IO lock", fixture.lockPool]]) {
        const identity = await pool.query(
            "SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name"
        );
        assert.deepEqual(identity.rows[0], {
            database_name: EXPECTED_DATABASE,
            role_name: EXPECTED_ROLE,
            schema_name: fixture.schema
        }, poolName + " pool must use this run's isolated database, role and schema before wallet test writes");
    }

    authenticateToken.setPool(fixture.pool);
    const app = express();
    app.use(express.json());
    const io = { in() { return { disconnectSockets() {} }; } };
    app.use("/api/auth", authRoutes(fixture.pool, authenticateToken, io));
    app.use("/api/wallet", walletRoutes(fixture.pool, authenticateToken, {}, {}));
    app.use("/api/admin/wallet", adminWalletRoutes(fixture.pool, authenticateToken, null, null));
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
    if (previousAllowTestDeposits === undefined) delete process.env.ALLOW_TEST_DEPOSITS;
    else process.env.ALLOW_TEST_DEPOSITS = previousAllowTestDeposits;
    if (previousAdminUserIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previousAdminUserIds;
});

async function createWalletIdentity(balance) {
    const user = await fixture.createUser("it_wallet_");
    await fixture.pool.query(
        "INSERT INTO wallets(user_id,balance,locked_balance,withdrawal_reserved_balance,currency) VALUES($1,$2,0,0,'KES')",
        [user.id, balance]
    );
    return { user, ...(await createSession(user)) };
}

async function createSession(user) {
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const token = await createAuthToken({ ...user, auth_version: 0 }, client);
        await client.query("COMMIT");
        const claims = jwt.verify(token, TEST_SECRET);
        return { token, sessionId: claims.jti };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function walletState(userId) {
    const result = await fixture.pool.query(
        "SELECT balance,locked_balance,withdrawal_reserved_balance FROM wallets WHERE user_id=$1",
        [userId]
    );
    assert.equal(result.rows.length, 1);
    return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
}

async function addAdvisoryGateTrigger(table, suffix, predicate, raiseError) {
    const trigger = "security_it_wallet_gate_" + suffix;
    const fn = trigger + "_fn";
    await fixture.pool.query(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF ${predicate} THEN
                ${raiseError ? "RAISE EXCEPTION 'security integration forced wallet rollback';" : "PERFORM pg_advisory_xact_lock(" + GATE_KEY + "::bigint);"}
            END IF;
            RETURN NEW;
        END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE ${raiseError ? "INSERT" : "UPDATE"} ON ${table}
                              FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
}

async function waitForDatabaseState(description, query, params) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        const result = await fixture.pool.query(query, params || []);
        if (result.rows[0] && result.rows[0].ready) return;
        // Polling PostgreSQL lock/activity state is the synchronization signal;
        // this interval only yields between read-only checks and is not used as
        // an assumption that the request has reached a particular step.
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for deterministic PostgreSQL barrier: " + description);
}

async function waitForBlockedWalletUpdate(userId) {
    await waitForDatabaseState("wallet update trigger", `
        SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query ILIKE 'UPDATE wallets SET%'
        ) AS ready`);
    const lock = await fixture.pool.query(`
        SELECT EXISTS(
            SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode='ShareLock' AND granted
        ) AS held`, [ACCOUNT_MUTATION_LOCK_NAMESPACE, Number(userId)]);
    assert.equal(lock.rows[0].held, true, "wallet route must hold the shared account mutation lock while paused");
}

async function waitForAccountLock(userId, mode, granted) {
    await waitForDatabaseState("account advisory lock " + mode + " granted=" + granted, `
        SELECT EXISTS(
            SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode=$3 AND granted=$4
        ) AS ready`, [ACCOUNT_MUTATION_LOCK_NAMESPACE, Number(userId), mode, granted]);
}

async function startGate() {
    const client = await fixture.pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [GATE_KEY]);
    return async function releaseGate() {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [GATE_KEY]);
        client.release();
    };
}

async function assertLogoutWaitsForWalletMutation({ identity, path, body, tableSuffix, expectedStatus, verify }) {
    await addAdvisoryGateTrigger(
        "wallets", tableSuffix,
        "OLD.user_id = " + Number(identity.user.id),
        false
    );
    const releaseGate = await startGate();
    let mutation;
    let logout;
    let logoutResolved = false;
    try {
        mutation = request(httpBase, path, { method: "POST", token: identity.token, body });
        await waitForBlockedWalletUpdate(identity.user.id);
        logout = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} })
            .then(result => { logoutResolved = true; return result; });
        await waitForAccountLock(identity.user.id, "ExclusiveLock", false);
        assert.equal(logoutResolved, false, "logout must wait while the admitted wallet transaction holds its account lock");
    } finally {
        await releaseGate();
    }
    const result = await mutation;
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    const signedOut = await logout;
    assert.equal(signedOut.status, 200, JSON.stringify(signedOut.body));
    assert.equal(signedOut.body.revoked, true);
    await verify(result);
}

describe("production player wallet mutations synchronize with session revocation", { concurrency: false }, () => {
    test("an admitted development deposit commits before logout returns", async () => {
        const identity = await createWalletIdentity(100);
        await assertLogoutWaitsForWalletMutation({
            identity,
            path: "/api/wallet/deposit",
            body: { amount: 10, phone: "0712345678" },
            tableSuffix: "deposit",
            expectedStatus: 201,
            verify: async () => {
                assert.deepEqual(await walletState(identity.user.id), {
                    balance: 110, locked_balance: 0, withdrawal_reserved_balance: 0
                });
                const transactions = await fixture.pool.query(
                    "SELECT count(*)::int AS count FROM transactions WHERE user_id=$1 AND transaction_type='deposit'",
                    [identity.user.id]
                );
                const journal = await fixture.pool.query(
                    `SELECT count(*)::int AS headers,
                            (SELECT count(*)::int FROM financial_ledger_entries e JOIN financial_ledger_transactions t ON t.id=e.transaction_id WHERE t.reference LIKE 'DEP-%' AND t.context->>'userId'=$1) AS entries
                       FROM financial_ledger_transactions WHERE context->>'userId'=$1 AND transaction_type='development_deposit'`,
                    [String(identity.user.id)]
                );
                assert.equal(transactions.rows[0].count, 1);
                assert.equal(journal.rows[0].headers, 1);
                assert.equal(journal.rows[0].entries, 2);
            }
        });
    });

    test("manual withdrawal stays in the wallet until admin confirms payment", async () => {
        const identity = await createWalletIdentity(1000);
        const observerSession = await createSession(identity.user);
        await assertLogoutWaitsForWalletMutation({
            identity,
            path: "/api/wallet/withdraw/manual",
            body: { amount: 100, phone: "0712345678" },
            tableSuffix: "withdrawal",
            expectedStatus: 202,
            verify: async result => {
                assert.equal(result.body.fee, 5);
                assert.equal(result.body.payout, 95);
                assert.deepEqual(await walletState(identity.user.id), {
                    balance: 1000, locked_balance: 0, withdrawal_reserved_balance: 100
                });
                assert.deepEqual(result.body.wallet, {
                    balance: 1000,
                    reservedWithdrawalBalance: 100,
                    availableBalance: 900
                });
                const walletResponse = await request(httpBase, "/api/wallet", { token: observerSession.token });
                assert.equal(walletResponse.status, 200, JSON.stringify(walletResponse.body));
                assert.equal(walletResponse.body.wallet.balance, 1000);
                assert.equal(walletResponse.body.wallet.availableBalance, 900);
                const records = await fixture.pool.query(
                    `SELECT (SELECT count(*)::int FROM manual_withdrawal_requests WHERE user_id=$1) AS requests,
                            (SELECT count(*)::int FROM transactions WHERE user_id=$1 AND transaction_type IN ('withdrawal','withdrawal_fee')) AS transactions,
                            (SELECT count(*)::int FROM financial_ledger_transactions WHERE reference LIKE 'WD-RESERVE-WD-'||$1||'-%') AS journals,
                            (SELECT count(*)::int FROM financial_ledger_entries e JOIN financial_ledger_transactions t ON t.id=e.transaction_id WHERE t.reference LIKE 'WD-RESERVE-WD-'||$1||'-%') AS entries`,
                    [identity.user.id]
                );
                assert.deepEqual(records.rows[0], { requests: 1, transactions: 2, journals: 1, entries: 2 });
            }
        });

        const admin = await fixture.createUser("it_wallet_admin_");
        await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
        process.env.ADMIN_USER_IDS = admin.id + ",999999999";
        const adminIdentity = await createSession(admin);
        const requestRow = await fixture.pool.query(
            "SELECT id FROM manual_withdrawal_requests WHERE user_id=$1 AND status='pending'",
            [identity.user.id]
        );
        const completed = await request(httpBase, "/api/admin/wallet/manual-withdrawals/" + requestRow.rows[0].id + "/complete", {
            method: "POST", token: adminIdentity.token, body: {}
        });
        assert.equal(completed.status, 200, JSON.stringify(completed.body));
        assert.deepEqual(await walletState(identity.user.id), {
            balance: 900, locked_balance: 0, withdrawal_reserved_balance: 0
        });
    });

    test("logout winning first rejects wallet work while a second session remains usable", async () => {
        const identity = await createWalletIdentity(1000);
        const secondSession = await createSession(identity.user);
        const before = await walletState(identity.user.id);
        const trigger = "security_it_wallet_logout_first";
        const fn = trigger + "_fn";
        await fixture.pool.query(`
            CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.id = '${identity.sessionId}'::uuid THEN
                    PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint);
                END IF;
                RETURN NEW;
            END $$`);
        await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON auth_sessions
                                  FOR EACH ROW EXECUTE FUNCTION ${fn}()`);

        const releaseGate = await startGate();
        let logout;
        let rejected;
        try {
            logout = request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
            await waitForAccountLock(identity.user.id, "ExclusiveLock", true);
            rejected = request(httpBase, "/api/wallet/withdraw", {
                method: "POST", token: identity.token, body: { amount: 100, phone: "0712345678" }
            });
            await waitForAccountLock(identity.user.id, "ShareLock", false);
        } finally {
            await releaseGate();
        }

        const logoutResult = await logout;
        assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.body));
        const rejectedResult = await rejected;
        assert.equal(rejectedResult.status, 401, JSON.stringify(rejectedResult.body));
        assert.deepEqual(await walletState(identity.user.id), before);
        const none = await fixture.pool.query(
            "SELECT (SELECT count(*)::int FROM manual_withdrawal_requests WHERE user_id=$1) AS requests,(SELECT count(*)::int FROM transactions WHERE user_id=$1) AS transactions",
            [identity.user.id]
        );
        assert.deepEqual(none.rows[0], { requests: 0, transactions: 0 });

        const otherSessionWithdrawal = await request(httpBase, "/api/wallet/withdraw", {
            method: "POST", token: secondSession.token, body: { amount: 100, phone: "0712345678" }
        });
        assert.equal(otherSessionWithdrawal.status, 202, JSON.stringify(otherSessionWithdrawal.body));
        assert.equal(otherSessionWithdrawal.body.payout, 95);
        const sessionRows = await fixture.pool.query(
            "SELECT id,revoked_at FROM auth_sessions WHERE user_id=$1 ORDER BY id",
            [identity.user.id]
        );
        const sessionsById = new Map(sessionRows.rows.map(row => [row.id, row]));
        assert.ok(sessionsById.has(identity.sessionId), "logout session row should remain present");
        assert.ok(sessionsById.has(secondSession.sessionId), "independent session row should remain present");
        assert.notEqual(sessionsById.get(identity.sessionId).revoked_at, null, "logout should revoke only its initiating session");
        assert.equal(sessionsById.get(secondSession.sessionId).revoked_at, null, "the independent session should remain active");
    });

    test("withdrawal failure rolls back wallet, request, transaction and journal writes and releases the lock", async () => {
        const identity = await createWalletIdentity(1000);
        const trigger = "security_it_wallet_force_rollback";
        const fn = trigger + "_fn";
        await fixture.pool.query(`
            CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.user_id = ${Number(identity.user.id)} AND NEW.transaction_type = 'withdrawal_fee' THEN
                    RAISE EXCEPTION 'security integration forced wallet rollback';
                END IF;
                RETURN NEW;
            END $$`);
        await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON transactions
                                  FOR EACH ROW EXECUTE FUNCTION ${fn}()`);

        const result = await request(httpBase, "/api/wallet/withdraw/manual", {
            method: "POST", token: identity.token, body: { amount: 100, phone: "0712345678" }
        });
        assert.equal(result.status, 500, JSON.stringify(result.body));
        assert.deepEqual(await walletState(identity.user.id), {
            balance: 1000, locked_balance: 0, withdrawal_reserved_balance: 0
        });
        const records = await fixture.pool.query(
            `SELECT (SELECT count(*)::int FROM manual_withdrawal_requests WHERE user_id=$1) AS requests,
                    (SELECT count(*)::int FROM transactions WHERE user_id=$1) AS transactions,
                    (SELECT count(*)::int FROM financial_ledger_transactions WHERE context->>'userId'=$2) AS journals`,
            [identity.user.id, String(identity.user.id)]
        );
        assert.deepEqual(records.rows[0], { requests: 0, transactions: 0, journals: 0 });

        const logout = await request(httpBase, "/api/auth/logout", { method: "POST", token: identity.token, body: {} });
        assert.equal(logout.status, 200, JSON.stringify(logout.body));
    });

    test("duplicate manual withdrawal requests across route aliases reserve funds only once", async () => {
        const identity = await createWalletIdentity(1000);
        const responses = await Promise.all([
            request(httpBase, "/api/wallet/withdraw/manual", {
                method: "POST", token: identity.token, body: { amount: 100, phone: "0712345678" }
            }),
            request(httpBase, "/api/wallet/withdraw", {
                method: "POST", token: identity.token, body: { amount: 100, phone: "0712345678" }
            })
        ]);
        assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
        assert.deepEqual(await walletState(identity.user.id), {
            balance: 1000, locked_balance: 0, withdrawal_reserved_balance: 100
        });
        const records = await fixture.pool.query(
            `SELECT (SELECT count(*)::int FROM manual_withdrawal_requests WHERE user_id=$1 AND status='pending') AS requests,
                    (SELECT count(*)::int FROM transactions WHERE user_id=$1 AND transaction_type IN ('withdrawal','withdrawal_fee')) AS transactions,
                    (SELECT count(*)::int FROM financial_ledger_transactions WHERE reference LIKE 'WD-RESERVE-WD-'||$1||'-%') AS journals`,
            [identity.user.id]
        );
        assert.deepEqual(records.rows[0], { requests: 1, transactions: 2, journals: 1 });
    });

    test("withdrawal quote remains read-only", async () => {
        const identity = await createWalletIdentity(1000);
        const before = await walletState(identity.user.id);
        const result = await request(httpBase, "/api/wallet/withdraw/quote", {
            method: "POST", token: identity.token, body: { amount: 100, phone: "0712345678" }
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(await walletState(identity.user.id), before);
        const writes = await fixture.pool.query(
            `SELECT (SELECT count(*)::int FROM transactions WHERE user_id=$1) AS transactions,
                    (SELECT count(*)::int FROM manual_withdrawal_requests WHERE user_id=$1) AS requests,
                    (SELECT count(*)::int FROM financial_ledger_transactions WHERE context->>'userId'=$2) AS journals`,
            [identity.user.id, String(identity.user.id)]
        );
        assert.deepEqual(writes.rows[0], { transactions: 0, requests: 0, journals: 0 });
    });
});
