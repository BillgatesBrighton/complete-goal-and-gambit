"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/authMiddleware");
const authRoutes = require("../routes/auth");
const { installSocketSessionGuard, isAuthSessionActive } = require("../services/authSession");

const SECRET = "auth-session-test-secret-with-sufficient-length";

function clone(value) { return value ? { ...value } : value; }

function createPool() {
    const users = new Map();
    const sessions = new Map();
    const disconnected = [];
    const sessionLocks = new Map();
    const exclusiveWaiters = new Map();

    function getSessionLock(sessionId) {
        if (!sessionLocks.has(sessionId)) {
            let readers = 0;
            let writer = false;
            const queue = [];
            const drain = () => {
                if (writer || !queue.length) return;
                if (readers && queue[0].mode === "exclusive") return;
                if (!readers && queue[0].mode === "exclusive") {
                    writer = true;
                    queue.shift().resolve(() => { writer = false; drain(); });
                    return;
                }
                while (queue.length && queue[0].mode === "shared" && !writer) {
                    readers++;
                    queue.shift().resolve(() => { readers--; drain(); });
                }
            };
            sessionLocks.set(sessionId, {
                acquire(mode) {
                    return new Promise((resolve) => {
                        queue.push({ mode, resolve });
                        drain();
                    });
                }
            });
        }
        return sessionLocks.get(sessionId);
    }

    async function addUser(id, username, password) {
        users.set(id, {
            id, username, phone: "+2547000000" + id, password_hash: await bcrypt.hash(password, 4),
            rating: 1200, game: "both", role: "user", account_status: "active",
            suspended_until: null, auth_version: 0, created_at: new Date()
        });
    }

    async function query(sql, params) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        params = params || [];
        if (/FROM users WHERE username = \$1/i.test(statement)) {
            const user = Array.from(users.values()).find((candidate) => candidate.username === params[0]);
            return { rows: user ? [clone(user)] : [] };
        }
        if (/FROM users WHERE id = \$1/i.test(statement)) {
            const user = users.get(Number(params[0]));
            return { rows: user ? [clone(user)] : [] };
        }
        if (/FROM auth_sessions s JOIN users u/i.test(statement)) {
            const [sessionId, userId, authVersion] = params;
            const session = sessions.get(String(sessionId));
            const user = users.get(Number(userId));
            const active = session && user && session.user_id === Number(userId) &&
                session.revoked_at === null && session.expires_at > new Date() &&
                Number(user.auth_version) === Number(authVersion);
            return { rows: active ? [{ "1": 1 }] : [] };
        }
        if (/FROM auth_sessions\s+WHERE id=\$1 AND user_id=\$2 AND revoked_at IS NULL AND expires_at>NOW\(\)/i.test(statement)) {
            const [sessionId, userId] = params;
            const session = sessions.get(String(sessionId));
            const active = session && session.user_id === Number(userId) &&
                session.revoked_at === null && session.expires_at > new Date();
            return { rows: active ? [{ "1": 1 }] : [] };
        }
        if (/UPDATE auth_sessions SET revoked_at=NOW\(\)/i.test(statement)) {
            const [sessionId, userId] = params;
            if (exclusiveWaiters.has(String(sessionId))) exclusiveWaiters.get(String(sessionId))();
            const release = await getSessionLock(String(sessionId)).acquire("exclusive");
            try {
            const session = sessions.get(String(sessionId));
            if (session && session.user_id === Number(userId) && session.revoked_at === null) {
                session.revoked_at = new Date();
            }
            return { rows: [] };
            } finally {
                release();
            }
        }
        throw new Error("Unexpected pool query: " + statement);
    }

    async function connect() {
        const releaseSessionLocks = [];
        const releaseAllSessionLocks = () => {
            while (releaseSessionLocks.length) releaseSessionLocks.pop()();
        };
        return {
            async query(sql, params) {
                const statement = String(sql).replace(/\s+/g, " ").trim();
                params = params || [];
                if (["BEGIN"].includes(statement)) return { rows: [] };
                if (/^SET LOCAL lock_timeout = '10s'$/i.test(statement)) return { rows: [] };
                if (/^SET LOCAL idle_in_transaction_session_timeout = '30s'$/i.test(statement)) return { rows: [] };
                if (/^SELECT pg_advisory_xact_lock(?:_shared)?\(\$1::integer,\$2::integer\)$/i.test(statement)) return { rows: [] };
                if (["COMMIT", "ROLLBACK"].includes(statement)) {
                    releaseAllSessionLocks();
                    return { rows: [] };
                }
                if (/^SELECT auth_version FROM users WHERE id=\$1 FOR SHARE$/i.test(statement)) {
                    const user = users.get(Number(params[0]));
                    return { rows: user ? [{ auth_version: user.auth_version }] : [] };
                }
                if (/^SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=\$1 AND s.user_id=\$2 AND s.revoked_at IS NULL AND s.expires_at>NOW\(\) AND u.auth_version=\$3$/i.test(statement)) {
                    const [sessionId,userId,authVersion]=params;
                    const session=sessions.get(String(sessionId));
                    const user=users.get(Number(userId));
                    const active=session&&user&&session.user_id===Number(userId)&&session.revoked_at===null&&session.expires_at>new Date()&&Number(user.auth_version)===Number(authVersion);
                    return { rows: active ? [{"1":1}] : [] };
                }
                if (/^SELECT id FROM auth_sessions WHERE user_id=\$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE$/i.test(statement)) {
                    const userId=Number(params[0]);
                    const active=Array.from(sessions.values()).filter(session=>session.user_id===userId&&session.revoked_at===null).sort((a,b)=>a.id.localeCompare(b.id));
                    const ids=[];
                    for(const session of active){
                        if(exclusiveWaiters.has(session.id)) exclusiveWaiters.get(session.id)();
                        releaseSessionLocks.push(await getSessionLock(session.id).acquire("exclusive"));
                        ids.push({id:session.id});
                    }
                    return {rows:ids};
                }
                if (/^UPDATE auth_sessions SET revoked_at=NOW\(\) WHERE user_id=\$1 AND id=ANY\(\$2::uuid\[\]\) AND revoked_at IS NULL$/i.test(statement)) {
                    const [userId,ids]=params;
                    for(const id of ids){const session=sessions.get(String(id));if(session&&session.user_id===Number(userId)&&session.revoked_at===null)session.revoked_at=new Date();}
                    return {rows:[],rowCount:ids.length};
                }
                if (/^UPDATE auth_sessions SET revoked_at=NOW\(\) WHERE id=\$1 AND user_id=\$2 AND revoked_at IS NULL$/i.test(statement)) {
                    const [sessionId,userId]=params;
                    if(exclusiveWaiters.has(String(sessionId)))exclusiveWaiters.get(String(sessionId))();
                    releaseSessionLocks.push(await getSessionLock(String(sessionId)).acquire("exclusive"));
                    const session=sessions.get(String(sessionId));
                    if(session&&session.user_id===Number(userId)&&session.revoked_at===null)session.revoked_at=new Date();
                    return {rows:[],rowCount:session?1:0};
                }
                if (/FROM auth_sessions s JOIN users u.*FOR SHARE OF s/i.test(statement)) {
                    const [sessionId, userId, authVersion] = params;
                    releaseSessionLocks.push(await getSessionLock(String(sessionId)).acquire("shared"));
                    const session = sessions.get(String(sessionId));
                    const user = users.get(Number(userId));
                    const active = session && user && session.user_id === Number(userId) &&
                        session.revoked_at === null && session.expires_at > new Date() &&
                        Number(user.auth_version) === Number(authVersion);
                    return { rows: active ? [{ "1": 1 }] : [] };
                }
                if (/INSERT INTO auth_sessions \(id,user_id,created_at,expires_at\)/i.test(statement)) {
                    const [id, userId, createdAt, expiresAt] = params;
                    sessions.set(String(id), {
                        id: String(id), user_id: Number(userId),
                        created_at: new Date(Number(createdAt) * 1000),
                        expires_at: new Date(Number(expiresAt) * 1000), revoked_at: null
                    });
                    return { rows: [] };
                }
                if (/FROM users WHERE id=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                    const user = users.get(Number(params[0]));
                    return { rows: user && user.account_status === "active" ? [clone(user)] : [] };
                }
                if (/UPDATE users SET username=\$1,phone=\$2,game=\$3,password_hash=\$4,auth_version=auth_version\+1/i.test(statement)) {
                    const [username, phone, game, passwordHash, userId] = params;
                    const user = users.get(Number(userId));
                    if (!user) return { rows: [] };
                    Object.assign(user, { username, phone, game, password_hash: passwordHash });
                    user.auth_version += 1;
                    return { rows: [clone(user)] };
                }
                throw new Error("Unexpected client query: " + statement);
            },
            on() {},
            release() { releaseAllSessionLocks(); }
        };
    }

    function watchNextExclusive(sessionId) {
        return new Promise((resolve) => exclusiveWaiters.set(String(sessionId), resolve));
    }

    return { users, sessions, disconnected, addUser, query, connect, watchNextExclusive };
}

async function startTestServer(t) {
    const previousSecret = process.env.JWT_SECRET;
    const previousAdmins = process.env.ADMIN_USER_IDS;
    process.env.JWT_SECRET = SECRET;
    process.env.ADMIN_USER_IDS = "";
    t.after(() => {
        if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
        if (previousAdmins === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = previousAdmins;
    });

    const pool = createPool();
    await pool.addUser(1, "alice", "alice-current-password");
    await pool.addUser(2, "bob", "bob-current-password");
    const authenticateForPool = (req, res, next) => {
        authMiddleware.setPool(pool);
        return authMiddleware(req, res, next);
    };
    const io = { in(room) { return { disconnectSockets() { pool.disconnected.push(room); } }; } };
    const app = express();
    let requestNumber = 0;
    app.use(express.json());
    app.use((req, _res, next) => {
        Object.defineProperty(req, "ip", { configurable: true, value: "session-test-" + (++requestNumber) });
        next();
    });
    app.use("/api/auth", authRoutes(pool, authenticateForPool, io, { emailService: { isConfigured: () => true } }));
    app.get("/api/me", authenticateForPool, (req, res) => res.json({ success: true, userId: req.user.userId }));
    app.get("/api/wallet", authenticateForPool, (req, res) => res.json({ success: true, walletOwner: req.user.userId }));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { pool, server, base: "http://127.0.0.1:" + server.address().port };
}

async function post(base, path, body, token) {
    const response = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify(body || {})
    });
    return { status: response.status, body: await response.json() };
}

async function login(base, username, password) {
    return post(base, "/api/auth/login", { username, password });
}

async function get(base, path, token) {
    const response = await fetch(base + path, { headers: { Authorization: "Bearer " + token } });
    return { status: response.status, body: await response.json() };
}

describe("authentication session lifecycle", { concurrency: false }, () => {
test("per-session logout revokes only its token and protects player and wallet routes", async (t) => {
    const { pool, server, base } = await startTestServer(t);
    const first = await login(base, "alice", "alice-current-password");
    const second = await login(base, "alice", "alice-current-password");
    const bob = await login(base, "bob", "bob-current-password");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(bob.status, 200);
    const firstClaims = jwt.verify(first.body.token, SECRET);
    const secondClaims = jwt.verify(second.body.token, SECRET);
    const bobClaims = jwt.verify(bob.body.token, SECRET);
    assert.notEqual(firstClaims.jti, secondClaims.jti, "each login creates a distinct session identifier");
    assert.equal(pool.sessions.get(firstClaims.jti).user_id, 1);
    assert.equal(pool.sessions.get(bobClaims.jti).user_id, 2);
    assert.equal((await get(base, "/api/me", first.body.token)).status, 200);
    assert.equal((await get(base, "/api/wallet", first.body.token)).body.walletOwner, 1);

    const logout = await post(base, "/api/auth/logout", {}, first.body.token);
    assert.equal(logout.status, 200);
    assert.equal(logout.body.revoked, true);
    assert.ok(pool.sessions.get(firstClaims.jti).revoked_at);
    assert.deepEqual(pool.disconnected, ["auth_session_" + firstClaims.jti], "logout disconnects only sockets in the current session room");
    assert.equal((await get(base, "/api/me", first.body.token)).status, 401, "the exact JWT fails immediately after logout");
    assert.equal((await get(base, "/api/wallet", first.body.token)).status, 401);
    assert.equal((await post(base, "/api/auth/logout", {}, first.body.token)).status, 401, "a repeated request cannot change unrelated sessions");
    assert.equal((await get(base, "/api/me", second.body.token)).status, 200, "another active session on the same account remains valid");

    const forgedCrossAccount = jwt.sign({
        userId: 1, username: "alice", authVersion: 0, jti: bobClaims.jti,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
    }, SECRET);
    assert.equal((await post(base, "/api/auth/logout", {}, forgedCrossAccount)).status, 401,
        "a session belonging to another account cannot authenticate or be revoked");
    assert.equal((await get(base, "/api/me", bob.body.token)).status, 200, "the attempted cross-account logout leaves Bob's session active");
    assert.deepEqual(pool.disconnected, ["auth_session_" + firstClaims.jti], "cross-account logout does not disconnect Bob's socket room");

    const legacy = jwt.sign({ userId: 1, username: "alice", authVersion: 0 }, SECRET, { expiresIn: "1h" });
    assert.equal((await get(base, "/api/me", legacy)).status, 401, "untracked legacy JWTs fail closed");

    pool.sessions.get(secondClaims.jti).expires_at = new Date(Date.now() - 1000);
    assert.equal((await get(base, "/api/me", second.body.token)).status, 401, "an expired database session is rejected even while its JWT is unexpired");
    assert.ok(server.listening);
});

test("password change invalidates older sessions but returns a new tracked session", async (t) => {
    const { pool, base } = await startTestServer(t);
    const first = await login(base, "alice", "alice-current-password");
    const second = await login(base, "alice", "alice-current-password");
    const oldClaims = jwt.verify(first.body.token, SECRET);
    const changed = await post(base, "/api/auth/account", {
        currentPassword: "alice-current-password", newPassword: "alice-new-password"
    }, first.body.token);
    assert.equal(changed.status, 200);
    const newClaims = jwt.verify(changed.body.token, SECRET);
    assert.ok(pool.sessions.has(newClaims.jti), "the new token has a committed session row: " + newClaims.jti + " keys=" + Array.from(pool.sessions.keys()).join(","));
    assert.equal(pool.sessions.get(newClaims.jti).user_id, 1);
    assert.equal((await get(base, "/api/me", first.body.token)).status, 401);
    assert.equal((await get(base, "/api/me", second.body.token)).status, 401);
    assert.equal((await get(base, "/api/me", changed.body.token)).status, 200);
    assert.equal(Number(pool.users.get(1).auth_version), Number(oldClaims.authVersion) + 1);
});

test("revoked sessions cannot reconnect sockets or continue authenticated socket packets", async (t) => {
    const { pool, base } = await startTestServer(t);
    const signedIn = await login(base, "alice", "alice-current-password");
    const claims = jwt.verify(signedIn.body.token, SECRET);
    assert.equal(await isAuthSessionActive(pool, claims.jti, claims.userId, claims.authVersion), true);

    const socket = {
        user: { sessionId: claims.jti, userId: claims.userId, authVersion: claims.authVersion },
        data: {},
        listeners: new Map(),
        disconnected: false,
        on(eventName, listener) { this.listeners.set(eventName, listener); return this; },
        receive(eventName, ...args) { return this.listeners.get(eventName)(...args); },
        disconnect() { this.disconnected = true; }
    };
    installSocketSessionGuard(socket, pool);
    let packetCount = 0;
    socket.on("chess:join", () => { packetCount++; });
    await socket.receive("chess:join", {});
    assert.equal(packetCount, 1, "a valid tracked session can perform an authenticated socket operation");

    assert.equal((await post(base, "/api/auth/logout", {}, signedIn.body.token)).status, 200);
    assert.equal(await isAuthSessionActive(pool, claims.jti, claims.userId, claims.authVersion), false,
        "a new socket handshake using the revoked session is denied by the shared session check");
    let packetRejected = false;
    socket.on("chess:move", () => { packetCount++; });
    await socket.receive("chess:move", {}, (error) => { packetRejected = Boolean(error); });
    assert.equal(packetCount, 1, "the revoked packet listener is never called");
    assert.equal(packetRejected, true);
    assert.equal(socket.disconnected, true);
});

test("logout waits for an admitted socket operation and blocks later operations for only that session", async (t) => {
    const { pool, base } = await startTestServer(t);
    const first = await login(base, "alice", "alice-current-password");
    const second = await login(base, "alice", "alice-current-password");
    const firstClaims = jwt.verify(first.body.token, SECRET);
    const secondClaims = jwt.verify(second.body.token, SECRET);
    const makeSocket = (claims) => ({
        id: claims.jti,
        user: { sessionId: claims.jti, userId: claims.userId, authVersion: claims.authVersion },
        data: {}, listeners: new Map(), disconnected: false,
        on(eventName, listener) { this.listeners.set(eventName, listener); return this; },
        receive(eventName, ...args) { return this.listeners.get(eventName)(...args); },
        disconnect() { this.disconnected = true; }
    });
    const firstSocket = makeSocket(firstClaims);
    const secondSocket = makeSocket(secondClaims);
    installSocketSessionGuard(firstSocket, pool);
    installSocketSessionGuard(secondSocket, pool);

    let releaseOperation;
    let operationStarted;
    const started = new Promise((resolve) => { operationStarted = resolve; });
    const operationGate = new Promise((resolve) => { releaseOperation = resolve; });
    let operationCommitted = false;
    firstSocket.on("chess:test-mutation", async function() {
        operationStarted();
        await operationGate;
        operationCommitted = true;
    });
    const inFlight = firstSocket.receive("chess:test-mutation");
    await started;

    const logoutWaiting = pool.watchNextExclusive(firstClaims.jti);
    const logoutPromise = post(base, "/api/auth/logout", {}, first.body.token);
    await logoutWaiting;
    assert.equal(operationCommitted, false, "the admitted handler remains in flight while logout waits for its row lock");
    releaseOperation();
    await inFlight;
    const logout = await logoutPromise;
    assert.equal(operationCommitted, true);
    assert.equal(logout.status, 200, "logout responds only after the admitted operation has finished");

    let laterOperationRan = false;
    firstSocket.on("chess:later-mutation", function() { laterOperationRan = true; });
    await firstSocket.receive("chess:later-mutation");
    assert.equal(laterOperationRan, false);
    assert.equal(firstSocket.disconnected, true);

    let otherSessionRan = false;
    secondSocket.on("chess:still-active", function() { otherSessionRan = true; });
    await secondSocket.receive("chess:still-active");
    assert.equal(otherSessionRan, true, "another device session for the same account remains active");
    assert.equal(secondSocket.disconnected, false);
    assert.deepEqual(pool.disconnected, ["auth_session_" + firstClaims.jti]);
});
});
