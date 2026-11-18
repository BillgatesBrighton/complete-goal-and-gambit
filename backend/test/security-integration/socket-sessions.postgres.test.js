"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: createClient } = require("socket.io-client");
const { randomInt, randomUUID } = require("node:crypto");
require("./config").readConfig();
const {
    ACCOUNT_OPERATION_LOCK_NAMESPACE,
    ACCOUNT_MUTATION_LOCK_NAMESPACE,
    isAuthSessionActive,
    lockActiveAuthSession,
    installSocketSessionGuard
} = require("../../services/authSession");
const { createFixture } = require("./fixture");
const { startHttpHarness, request } = require("./httpHarness");

const TEST_SECRET = "socket-security-integration-only-secret";
let fixture;
let httpHarness;
let socketServer;
let socketIo;
let socketBase;
let previousJwtSecret;
let previousVerificationUrl;
let operationGate;
let operationStarted;
let operationHandlerStarted = false;
let mutationCommitted = false;
let passwordUpdateGateKey = 726180042;

const emailService = {
    isConfigured() { return true; },
    async sendVerificationEmail() {}
};

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    previousVerificationUrl = process.env.EMAIL_VERIFICATION_FRONTEND_URL;
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.EMAIL_VERIFICATION_FRONTEND_URL = "http://127.0.0.1/verify-email.html";
    fixture = await createFixture();
    socketServer = http.createServer();
    socketIo = new Server(socketServer, { transports: ["websocket"] });
    socketIo.use(async (socket, next) => {
        try {
            const decoded = jwt.verify(socket.handshake.auth && socket.handshake.auth.token, TEST_SECRET);
            const userId = Number(decoded.userId);
            const sessionId = String(decoded.jti || "");
            const account = await fixture.pool.query(
                "SELECT id,username,role,auth_version FROM users WHERE id=$1 AND account_status='active'",
                [userId]
            );
            if (!account.rows.length || !(await isAuthSessionActive(fixture.pool, sessionId, userId, decoded.authVersion))) {
                return next(new Error("Invalid or expired authentication session."));
            }
            socket.user = { ...decoded, userId, sessionId, username: account.rows[0].username };
            next();
        } catch (_) {
            next(new Error("Invalid or expired authentication session."));
        }
    });
    await fixture.pool.query(`CREATE TABLE security_socket_writes (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    socketIo.on("connection", (socket) => {
        installSocketSessionGuard(socket, fixture.lockPool);
        socket.join("auth_session_" + socket.user.sessionId);
        socket.on("security:mutation", async (_payload, ack) => {
            operationHandlerStarted = true;
            if (operationGate) {
                operationStarted();
                await operationGate;
            }
            const client = await fixture.pool.connect();
            try {
                await client.query("BEGIN");
                if (!(await lockActiveAuthSession(client, socket.user))) {
                    throw new Error("Authentication session is no longer active.");
                }
                await client.query("INSERT INTO security_socket_writes(user_id,session_id) VALUES($1,$2)",
                    [socket.user.userId, socket.user.sessionId]);
                await client.query("COMMIT");
                mutationCommitted = true;
                if (typeof ack === "function") ack({ success: true });
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                if (typeof ack === "function") ack({ success: false, message: error.message });
            } finally {
                client.release();
            }
        });
    });
    await new Promise((resolve, reject) => {
        socketServer.once("error", reject);
        socketServer.listen(0, "127.0.0.1", resolve);
    });
    socketBase = "http://127.0.0.1:" + socketServer.address().port;

    httpHarness = await startHttpHarness(fixture.pool, { emailService, io: socketIo });
});

after(async () => {
    if (httpHarness) await httpHarness.close();
    if (socketIo) await socketIo.close();
    if (socketServer && socketServer.listening) await new Promise((resolve) => socketServer.close(resolve));
    if (fixture) await fixture.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousVerificationUrl === undefined) delete process.env.EMAIL_VERIFICATION_FRONTEND_URL;
    else process.env.EMAIL_VERIFICATION_FRONTEND_URL = previousVerificationUrl;
});

async function registerAndLogin() {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const username = ("it_socket_" + suffix).slice(0, 30);
    const phone = "+2547" + String(randomInt(10_000_000, 99_999_999));
    const password = "Socket-test-password-123!";
    const registered = await request(httpHarness.base, "/api/auth/register", {
        method: "POST",
        body: { username, phone, email: username + "@example.invalid", password, game: "both", chessRating: 1200 }
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    return {
        user: registered.body.user,
        firstToken: registered.body.token,
        secondToken: (await request(httpHarness.base, "/api/auth/login", {
            method: "POST", body: { username, password }
        })).body.token
    };
}

function connect(token) {
    return new Promise((resolve, reject) => {
        const client = createClient(socketBase, { auth: { token }, transports: ["websocket"], reconnection: false, timeout: 5000 });
        client.once("connect", () => resolve(client));
        client.once("connect_error", (error) => { client.close(); reject(error); });
    });
}

function waitFor(predicate, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const poll = async () => {
            try {
                if (await predicate()) return resolve();
                if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for the PostgreSQL/socket condition."));
                setTimeout(poll, 20);
            } catch (error) { reject(error); }
        };
        poll();
    });
}

function emitAck(client, eventName, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Socket acknowledgement timed out.")), 5000);
        client.emit(eventName, payload, (ack) => { clearTimeout(timer); resolve(ack); });
    });
}

async function waitForBlockedPasswordUpdate() {
    await waitFor(async () => {
        const result = await fixture.pool.query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                 WHERE datname=current_database()
                   AND query ILIKE '%UPDATE users%'
                   AND wait_event_type='Lock'
            ) AS blocked`);
        return result.rows[0].blocked;
    }, 8000);
}

async function waitForBlockedSessionIssuance(userId) {
    await waitForAdvisoryRequest(ACCOUNT_MUTATION_LOCK_NAMESPACE, userId, "ShareLock");
}

async function waitForAdvisoryRequest(namespace, userId, mode) {
    await waitFor(async () => {
        const result = await fixture.pool.query(`
            SELECT EXISTS(
                SELECT 1 FROM pg_locks
                 WHERE locktype='advisory'
                   AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
                   AND classid=$1::oid AND ($2::integer IS NULL OR objid=$2::oid)
                   AND objsubid=2 AND mode=$3 AND NOT granted
            ) AS waiting`, [namespace, userId, mode]);
        return result.rows[0].waiting;
    }, 8000);
}

async function assertAdvisoryHeld(namespace, userId, mode) {
    const result = await fixture.pool.query(`
        SELECT EXISTS(
            SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode=$3 AND granted
        ) AS held`, [namespace, userId, mode]);
    assert.equal(result.rows[0].held, true, "the expected account-level advisory lock is held");
}

async function waitForSessionRowsLocked(userId) {
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        try {
            await client.query(
                `SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE NOWAIT`,
                [userId]
            );
            await client.query("ROLLBACK");
            return false;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (error.code === "55P03") return true;
            throw error;
        }
    } finally {
        client.release();
    }
}

async function waitForSocketGuardOutcome(userId) {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const pending = await fixture.pool.query(`
            SELECT EXISTS(SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode='ShareLock' AND NOT granted) AS blocked`,
            [ACCOUNT_OPERATION_LOCK_NAMESPACE, Number(userId)]);
        if (pending.rows[0].blocked) return "blocked";
        if (operationHandlerStarted) return "admitted";
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Socket event neither blocked on the account operation gate nor entered its protected handler.");
}

async function waitForSocketGuardPid(userId) {
    let pid = null;
    await waitFor(async () => {
        const result = await fixture.pool.query(`
            SELECT a.pid
              FROM pg_stat_activity a
              JOIN pg_locks l ON l.pid=a.pid
             WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
               AND a.state='idle in transaction'
               AND a.query ILIKE '%auth_sessions s%FOR SHARE%'
               AND l.locktype='advisory' AND l.granted AND l.mode='ShareLock'
               AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=2
             LIMIT 1`, [ACCOUNT_OPERATION_LOCK_NAMESPACE, Number(userId)]);
        if (!result.rows.length) return false;
        pid = Number(result.rows[0].pid);
        return true;
    }, 5000);
    return pid;
}

async function installPasswordUpdateTrigger(userId, mode) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const functionName = "security_it_password_gate_" + suffix;
    const triggerName = functionName + "_trigger";
    const statement = mode === "fail"
        ? "RAISE EXCEPTION 'security integration password transaction failure';"
        : "PERFORM pg_advisory_xact_lock(" + passwordUpdateGateKey + "::bigint);";
    await fixture.pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.id = ${Number(userId)} THEN
                ${statement}
            END IF;
            RETURN NEW;
        END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF auth_version,password_hash ON users
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
}

async function releaseOperationGate() {
    if (operationGate) {
        const release = operationGate.release;
        operationGate = null;
        if (release) release();
    }
}

function pauseProtectedOperation() {
    let release;
    operationGate = new Promise(resolve => { release = resolve; });
    operationGate.release = release;
    operationStarted = null;
    const started = new Promise(resolve => { operationStarted = resolve; });
    return { started, release };
}

test("password change waits for an admitted Socket.IO operation before confirming success", async () => {
    const account = await registerAndLogin();
    const oldClaims = jwt.verify(account.firstToken, TEST_SECRET);
    const socket = await connect(account.firstToken);
    const pause = pauseProtectedOperation();
    operationHandlerStarted = false;
    mutationCommitted = false;
    const operation = emitAck(socket, "security:mutation", {});
    await pause.started;

    let changeResolved = false;
    let changePromise;
    try {
        changePromise = request(httpHarness.base, "/api/auth/account", {
            method: "PATCH", token: account.firstToken,
            body: { currentPassword: "Socket-test-password-123!", newPassword: "Socket-password-next-456!" }
        }).then(result => { changeResolved = true; return result; });
        await waitForAdvisoryRequest(ACCOUNT_OPERATION_LOCK_NAMESPACE, account.user.id, "ExclusiveLock");
        const changeWasBlockedByActiveSocket = !changeResolved && !mutationCommitted;

        await releaseOperationGate();
        const operationAck = await operation;
        const changed = await changePromise;
        const replacementSocket = await connect(changed.body.token);
        assert.deepEqual(await emitAck(replacementSocket, "security:mutation", {}), { success: true },
            "replacement session can perform protected work");
        const afterChangeAck = await emitAck(socket, "security:mutation", {});
        await assert.rejects(connect(account.firstToken), /Invalid or expired authentication session|Session expired after an account change/);
        assert.deepEqual(operationAck, { success: true });
        assert.deepEqual(afterChangeAck, { success: false, message: "Authentication session is no longer active." });
        assert.equal(mutationCommitted, true);
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.notEqual(jwt.verify(changed.body.token, TEST_SECRET).jti, oldClaims.jti);
        assert.equal(await isAuthSessionActive(fixture.pool, oldClaims.jti, oldClaims.userId, oldClaims.authVersion), false);

        replacementSocket.close();
        assert.equal(changeWasBlockedByActiveSocket, true,
            "successful password change must not return before admitted protected socket work finishes");
    } finally {
        await releaseOperationGate();
        socket.close();
        if (changePromise) await changePromise.catch(() => {});
    }
});

test("a pending password-change row lock does not admit old-session Socket.IO work", async () => {
    const account = await registerAndLogin();
    const oldClaims = jwt.verify(account.firstToken, TEST_SECRET);
    const socket = await connect(account.firstToken);
    await installPasswordUpdateTrigger(account.user.id, "pause");
    const admin = await fixture.pool.connect();
    await admin.query("SELECT pg_advisory_lock($1::bigint)", [passwordUpdateGateKey]);

    const changePromise = request(httpHarness.base, "/api/auth/account", {
        method: "PATCH", token: account.firstToken,
        body: { currentPassword: "Socket-test-password-123!", newPassword: "Socket-password-pending-789!" }
    });
    let concurrentLogin;
    let operationWasAdmitted = false;
    operationHandlerStarted = false;
    try {
        await waitForBlockedPasswordUpdate();
        await assertAdvisoryHeld(ACCOUNT_OPERATION_LOCK_NAMESPACE, account.user.id, "ExclusiveLock");
        await assertAdvisoryHeld(ACCOUNT_MUTATION_LOCK_NAMESPACE, account.user.id, "ExclusiveLock");
        assert.equal(await waitForSessionRowsLocked(account.user.id), true,
            "password transaction has acquired FOR UPDATE locks on all existing unrevoked session rows");
        operationGate = null;
        operationStarted = null;
        mutationCommitted = false;
        // The expected guard action is to reject then disconnect the socket;
        // an acknowledgement can be lost once transport closure starts.
        socket.emit("security:mutation", {});
        const guardOutcome = await waitForSocketGuardOutcome(account.user.id);
        operationWasAdmitted = guardOutcome === "admitted";
        if (guardOutcome === "blocked") {
            const otherAccount = await registerAndLogin();
            const otherSocket = await connect(otherAccount.firstToken);
            const otherAck = await emitAck(otherSocket, "security:mutation", {});
            assert.deepEqual(otherAck, { success: true }, "another account's session remains independent");
            otherSocket.close();
        }
        concurrentLogin = request(httpHarness.base, "/api/auth/login", {
            method: "POST",
            body: { username: account.user.username, password: "Socket-test-password-123!" }
        });
        await waitForBlockedSessionIssuance(account.user.id);
    } finally {
        await admin.query("SELECT pg_advisory_unlock($1::bigint)", [passwordUpdateGateKey]);
        admin.release();
    }

    const changed = await changePromise;
    const loginAfterChange = await concurrentLogin;
    await releaseOperationGate();
    const replacementSocket = await connect(changed.body.token);
    const replacementAck = await emitAck(replacementSocket, "security:mutation", {});
    await waitFor(() => !socket.connected, 3000);
    replacementSocket.close();
    socket.close();
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(replacementAck, { success: true }, "replacement session remains usable after password commit");
    assert.equal(loginAfterChange.status, 500, JSON.stringify(loginAfterChange.body));
    assert.equal(loginAfterChange.body.token, undefined,
        "a login that validated with the old password snapshot cannot issue a stale auth_version token");
    assert.equal(operationWasAdmitted, false,
        "old-session socket work must not be admitted after password change has acquired the session locks");
    const protectedWrites = await fixture.pool.query(
        "SELECT count(*)::int AS count FROM security_socket_writes WHERE user_id=$1 AND session_id=$2",
        [account.user.id, oldClaims.jti]
    );
    assert.equal(protectedWrites.rows[0].count, 0,
        "the rejected old-session operation must not mutate this account's protected state");
    assert.notEqual(jwt.verify(changed.body.token, TEST_SECRET).jti, oldClaims.jti);
    assert.equal(await isAuthSessionActive(fixture.pool, oldClaims.jti, oldClaims.userId, oldClaims.authVersion), false);
});

test("password-change rollback preserves the old session and releases authorization locks", async () => {
    const account = await registerAndLogin();
    const oldClaims = jwt.verify(account.firstToken, TEST_SECRET);
    const before = await fixture.pool.query("SELECT auth_version,password_hash FROM users WHERE id=$1", [account.user.id]);
    const sessionsBefore = await fixture.pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1", [account.user.id]);
    await installPasswordUpdateTrigger(account.user.id, "fail");

    const failed = await request(httpHarness.base, "/api/auth/account", {
        method: "PATCH", token: account.firstToken,
        body: { currentPassword: "Socket-test-password-123!", newPassword: "Socket-password-failed-111!" }
    });
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    const after = await fixture.pool.query("SELECT auth_version,password_hash FROM users WHERE id=$1", [account.user.id]);
    const sessionsAfter = await fixture.pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1", [account.user.id]);
    assert.deepEqual(after.rows[0], before.rows[0]);
    assert.deepEqual(sessionsAfter.rows[0], sessionsBefore.rows[0]);
    assert.equal(await isAuthSessionActive(fixture.pool, oldClaims.jti, oldClaims.userId, oldClaims.authVersion), true);
    assert.equal(await waitForSessionRowsLocked(account.user.id), false,
        "rollback released the session rows so another transaction can lock them");

    const socket = await connect(account.firstToken);
    const pause = pauseProtectedOperation();
    mutationCommitted = false;
    const operation = emitAck(socket, "security:mutation", {});
    await pause.started;
    await releaseOperationGate();
    assert.deepEqual(await operation, { success: true });
    assert.equal(mutationCommitted, true, "subsequent protected work succeeds after rollback released locks");
    socket.close();
});

test("a lost Socket.IO operation connection cannot let a stale mutation commit after password change", async () => {
    const account = await registerAndLogin();
    const claims = jwt.verify(account.firstToken, TEST_SECRET);
    const before = await fixture.pool.query("SELECT count(*)::int AS n FROM security_socket_writes WHERE user_id=$1", [account.user.id]);
    const socket = await connect(account.firstToken);
    const pause = pauseProtectedOperation();
    operationHandlerStarted = false;
    mutationCommitted = false;
    const operation = emitAck(socket, "security:mutation", {});
    await pause.started;

    const guardPid = await waitForSocketGuardPid(account.user.id);
    const terminated = await fixture.pool.query("SELECT pg_terminate_backend($1) AS terminated", [guardPid]);
    assert.equal(terminated.rows[0].terminated, true, "the test terminates only this run's guarded socket connection");

    const changed = await request(httpHarness.base, "/api/auth/account", {
        method: "PATCH", token: account.firstToken,
        body: { currentPassword: "Socket-test-password-123!", newPassword: "Socket-password-after-loss-987!" }
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    await releaseOperationGate();
    const ack = await operation;
    const after = await fixture.pool.query("SELECT count(*)::int AS n FROM security_socket_writes WHERE user_id=$1", [account.user.id]);
    assert.equal(after.rows[0].n, before.rows[0].n,
        "the handler's own mutation transaction revalidated after the password change and wrote nothing");
    assert.equal(mutationCommitted, false);
    assert.equal(await isAuthSessionActive(fixture.pool, claims.jti, claims.userId, claims.authVersion), false);
    assert.notDeepEqual(ack, { success: true });
    socket.close();
});

test("PostgreSQL row locking orders a protected Socket.IO mutation before logout and isolates sessions", async () => {
    const account = await registerAndLogin();
    const firstClaims = jwt.verify(account.firstToken, TEST_SECRET);
    const secondClaims = jwt.verify(account.secondToken, TEST_SECRET);
    const firstSocket = await connect(account.firstToken);
    const secondSocket = await connect(account.secondToken);
    let firstDisconnected = false;
    firstSocket.once("disconnect", () => { firstDisconnected = true; });

    let release;
    operationStarted = null;
    const started = new Promise((resolve) => { operationStarted = resolve; });
    operationGate = new Promise((resolve) => { release = resolve; });
    mutationCommitted = false;
    const firstMutation = emitAck(firstSocket, "security:mutation", {});
    await started;

    const logoutPromise = request(httpHarness.base, "/api/auth/logout", {
        method: "POST", token: account.firstToken, body: {}
    });
    // Logout first requests the exclusive account operation gate. The active
    // Socket.IO handler holds its shared gate until its awaited work settles.
    await waitForAdvisoryRequest(ACCOUNT_OPERATION_LOCK_NAMESPACE, firstClaims.userId, "ExclusiveLock");
    assert.equal(mutationCommitted, false);

    // A same-account operation on another session queues behind logout's
    // exclusive account gate, but that session remains active and usable once
    // the synchronization barrier completes.
    const secondMutation = emitAck(secondSocket, "security:mutation", {});

    release();
    operationGate = null;
    const ack = await firstMutation;
    assert.deepEqual(ack, { success: true });
    assert.equal(mutationCommitted, true, "protected write committed before the guard released its row lock");
    const logout = await logoutPromise;
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    assert.equal(logout.body.revoked, true);
    await waitFor(() => firstDisconnected, 3000);

    await assert.rejects(connect(account.firstToken), /Invalid or expired authentication session/);
    assert.equal(secondSocket.connected, true, "the other session socket remains connected");
    assert.equal(await isAuthSessionActive(fixture.pool, secondClaims.jti, secondClaims.userId, secondClaims.authVersion), true);
    const secondAck = await secondMutation;
    assert.deepEqual(secondAck, { success: true }, "the other session can still perform a protected operation");
    assert.equal(await isAuthSessionActive(fixture.pool, firstClaims.jti, firstClaims.userId, firstClaims.authVersion), false);

    firstSocket.close();
    secondSocket.close();
});
