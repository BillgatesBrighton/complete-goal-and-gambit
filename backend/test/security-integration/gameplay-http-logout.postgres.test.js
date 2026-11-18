"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { Chess } = require("chess.js");
const { randomUUID } = require("node:crypto");
require("./config").readConfig();
const { createFixture } = require("./fixture");
const { request } = require("./httpHarness");
const authenticateToken = require("../../middleware/authMiddleware");
const authRoutes = require("../../routes/auth");
const chessRoutes = require("../../routes/chess");
const efootballRoutes = require("../../routes/efootball");
const createAuthToken = require("../../services/authToken");
const {
    ACCOUNT_OPERATION_LOCK_NAMESPACE,
    ACCOUNT_MUTATION_LOCK_NAMESPACE
} = require("../../services/authSession");

const TEST_SECRET = "security-gameplay-http-test-secret";
const GATE_KEY = "726180041";
let fixture;
let httpServer;
let httpBase;
let previousJwtSecret;

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    fixture = await createFixture();

    authenticateToken.setPool(fixture.pool);
    const io = { in() { return { disconnectSockets() {} }; }, to() { return { emit() {} }; } };
    const pushService = {};
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes(fixture.pool, authenticateToken, io));

    // The production router starts an unref'd background clock sweep. Keep
    // this HTTP route harness focused and stop that unrelated periodic worker.
    const originalSetInterval = global.setInterval;
    let chess;
    let efootball;
    try {
        global.setInterval = () => ({ unref() {} });
        chess = chessRoutes(fixture.pool, authenticateToken, io, pushService, {
            isChessMatchVisible() { return true; }
        });
        efootball = efootballRoutes(fixture.pool, authenticateToken, io, pushService, {});
    } finally {
        global.setInterval = originalSetInterval;
    }
    chess.setConnectionMonitor({ isMatchReady() { return true; } });
    app.use("/api/chess", chess);
    app.use("/api/efootball", efootball);

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

async function createIdentity(prefix) {
    const user = await fixture.createUser(prefix);
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const token = await createAuthToken({ ...user, auth_version: 0 }, client);
        await client.query("COMMIT");
        return { user, token, sessionId: jwt.verify(token, TEST_SECRET).jti };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function createChessMatch(whiteId, blackId) {
    const result = await fixture.pool.query(
        `INSERT INTO chess_matches(player_white_id,player_black_id,status,fen,pgn,active_color,
                                   white_time_ms,black_time_ms,time_control,match_type,stake_amount)
         VALUES($1,$2,'active','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1','',
                'w',600000,600000,'10+5','casual',0) RETURNING id,fen,pgn,active_color`,
        [whiteId, blackId]
    );
    return result.rows[0];
}

async function createCheckmateMatch(whiteId, blackId) {
    const position = new Chess();
    ["f3", "e5", "g4"].forEach(san => position.move(san));
    await fixture.pool.query(
        "INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,0,0,'KES'),($2,0,0,'KES') ON CONFLICT(user_id) DO NOTHING",
        [whiteId, blackId]
    );
    const result = await fixture.pool.query(
        `INSERT INTO chess_matches(player_white_id,player_black_id,status,fen,pgn,active_color,
                                   white_time_ms,black_time_ms,last_move_at,time_control,match_type,stake_amount)
         VALUES($1,$2,'active',$3,$4,'b',600000,600000,NOW(),'10+5','casual',0)
         RETURNING id,status,fen,pgn,active_color`,
        [whiteId, blackId, position.fen(), position.pgn()]
    );
    return result.rows[0];
}

async function createEfootballMatch(creatorId, opponentId) {
    const roomCode = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    const result = await fixture.pool.query(
        `INSERT INTO efootball_matches(creator_id,opponent_id,mode,stake_amount,room_code,status,
                                       creator_ready,opponent_ready)
         VALUES($1,$2,'ranked',0,$3,'playing',TRUE,TRUE) RETURNING id,creator_submitted,result_round`,
        [creatorId, opponentId, roomCode]
    );
    return result.rows[0];
}

async function activeSession(identity) {
    const result = await fixture.pool.query(
        "SELECT revoked_at,expires_at FROM auth_sessions WHERE id=$1",
        [identity.sessionId]
    );
    return result.rows[0] && result.rows[0].revoked_at == null && new Date(result.rows[0].expires_at) > new Date();
}

async function gateUpdate(table, rowId, triggerSuffix, failAfterRelease) {
    const trigger = "security_it_gate_" + triggerSuffix;
    const functionName = trigger + "_fn";
    const rowPredicate = table === "auth_sessions"
        ? "OLD.id = '" + String(rowId).replace(/'/g, "''") + "'::uuid"
        : "OLD.id = " + Number(rowId);
    await fixture.pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF ${rowPredicate} THEN
                PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint);
                ${failAfterRelease ? "RAISE EXCEPTION 'security integration forced transaction rollback';" : ""}
            END IF;
            RETURN NEW;
        END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
                              FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
}

async function gateChessSettlement(matchId) {
    const trigger = "security_it_gate_chess_settlement";
    const functionName = trigger + "_fn";
    await fixture.pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.id = ${Number(matchId)} AND NEW.status = 'completed' THEN
                PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint);
            END IF;
            RETURN NEW;
        END $$`);
    await fixture.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON chess_matches
                              FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
}

async function waitForBlockedUpdate(table) {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const result = await fixture.pool.query(
            `SELECT EXISTS(
                 SELECT 1 FROM pg_stat_activity
                  WHERE datname=current_database() AND wait_event_type='Lock'
                    AND query ILIKE $1
             ) AS blocked`,
            ["%UPDATE " + table + "%"]
        );
        if (result.rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    const activity = await fixture.pool.query(
        "SELECT wait_event_type,wait_event,left(query,160) AS query FROM pg_stat_activity WHERE datname=current_database() AND state='active'"
    );
    throw new Error("Timed out waiting for a blocked " + table + " update. Active DB statements: " + JSON.stringify(activity.rows));
}

async function waitForBlockedSessionRead() {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const result = await fixture.pool.query(`
            SELECT EXISTS(
                 SELECT 1 FROM pg_stat_activity
                  WHERE datname=current_database() AND wait_event_type='Lock'
                    AND query ILIKE 'SELECT 1 FROM auth_sessions s%'
             ) AS blocked`);
        if (result.rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the gameplay route to block on the revoked session row.");
}

async function waitForAccountLockWait(namespace, userId, mode) {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const result = await fixture.pool.query(`
            SELECT EXISTS(SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode=$3 AND NOT granted) AS blocked`, [namespace, Number(userId), mode]);
        if (result.rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for account advisory lock " + namespace + "/" + userId + " " + mode);
}

async function waitForAccountLockHeld(namespace, userId, mode) {
    const started = Date.now();
    while (Date.now() - started < 8000) {
        const result = await fixture.pool.query(`
            SELECT EXISTS(SELECT 1 FROM pg_locks
             WHERE locktype='advisory'
               AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND classid=$1::oid AND objid=$2::oid AND objsubid=2
               AND mode=$3 AND granted) AS held`, [namespace, Number(userId), mode]);
        if (result.rows[0].held) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for held account advisory lock " + namespace + "/" + userId + " " + mode);
}

async function startGate() {
    const client = await fixture.pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [GATE_KEY]);
    return async function releaseGate() {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [GATE_KEY]);
        client.release();
    };
}

async function runLogoutRace({ table, matchId, path, token, body, stateQuery, logoutLockNamespace = ACCOUNT_MUTATION_LOCK_NAMESPACE }) {
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = request(httpBase, path, { method: "POST", token, body });
        await waitForBlockedUpdate(table);
        assert.equal(await activeSession({ sessionId: jwt.verify(token, TEST_SECRET).jti }), true,
            "the HTTP route passed its session guard and is paused inside its mutation transaction");

        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token, body: {} });
        const earlyLogout = await Promise.race([
            logoutPromise.then(result => ({ result })),
            new Promise(resolve => setTimeout(() => resolve({ pending: true }), 250))
        ]);
        if (earlyLogout.result) throw new Error("Logout returned before the gameplay transaction released its session lock: " + JSON.stringify(earlyLogout.result));
        await waitForAccountLockWait(logoutLockNamespace,
            jwt.verify(token, TEST_SECRET).userId, "ExclusiveLock");
        assert.equal(await activeSession({ sessionId: jwt.verify(token, TEST_SECRET).jti }), true,
            "logout is waiting for the admitted gameplay transaction's session lock");

        const during = await fixture.pool.query(stateQuery, [matchId]);
        assert.equal(during.rows[0].mutated, false, "the gated gameplay mutation is not visible before its transaction commits");
    } finally {
        await releaseGate();
    }

    const result = await operation;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const logout = await logoutPromise;
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    assert.equal(logout.body.revoked, true);
    assert.equal(await activeSession({ sessionId: jwt.verify(token, TEST_SECRET).jti }), false);
    const after = await fixture.pool.query(stateQuery, [matchId]);
    assert.equal(after.rows[0].mutated, true, "the admitted mutation committed before logout returned");
    return result;
}

async function runLogoutFirstRejects({ table, matchId, path, token, body, stateQuery, gameplayLockNamespace = ACCOUNT_MUTATION_LOCK_NAMESPACE }) {
    const sessionId = jwt.verify(token, TEST_SECRET).jti;
    await gateUpdate("auth_sessions", sessionId, "logout_first_" + table);
    const releaseGate = await startGate();
    let logoutPromise;
    let operation;
    try {
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token, body: {} });
        await waitForAccountLockHeld(ACCOUNT_MUTATION_LOCK_NAMESPACE,
            jwt.verify(token, TEST_SECRET).userId, "ExclusiveLock");
        operation = request(httpBase, path, { method: "POST", token, body });
        await waitForAccountLockWait(gameplayLockNamespace,
            jwt.verify(token, TEST_SECRET).userId, "ShareLock");
    } finally {
        await releaseGate();
    }

    const logout = await logoutPromise;
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    const result = await operation;
    assert.equal(result.status, 401, JSON.stringify(result.body));
    assert.equal(await activeSession({ sessionId }), false);
    const state = await fixture.pool.query(stateQuery, [matchId]);
    assert.equal(state.rows[0].mutated, false, "gameplay rejected after logout won the session-row lock");
}

async function runRollbackReleasesLock({ table, matchId, path, token, body, stateQuery, logoutLockNamespace = ACCOUNT_MUTATION_LOCK_NAMESPACE }) {
    await gateUpdate(table, matchId, "rollback_" + table, true);
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = request(httpBase, path, { method: "POST", token, body });
        await waitForBlockedUpdate(table);
        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token, body: {} });
        await waitForAccountLockWait(logoutLockNamespace,
            jwt.verify(token, TEST_SECRET).userId, "ExclusiveLock");
    } finally {
        await releaseGate();
    }
    const result = await operation;
    assert.equal(result.status, 500, JSON.stringify(result.body));
    const logout = await logoutPromise;
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    const state = await fixture.pool.query(stateQuery, [matchId]);
    assert.equal(state.rows[0].mutated, false, "the failed gameplay transaction rolled back its state change");
}

async function runTerminalChessLogoutBarrier({ matchId, token, otherSession }) {
    await gateChessSettlement(matchId);
    const releaseGate = await startGate();
    let operation;
    let logoutPromise;
    try {
        operation = request(httpBase, "/api/chess/" + matchId + "/move", {
            method: "POST", token, body: { from: "d8", to: "h4" }
        });
        await waitForBlockedUpdate("chess_matches");
        const settling = await fixture.pool.query("SELECT status,fen,pgn,result FROM chess_matches WHERE id=$1", [matchId]);
        assert.equal(settling.rows[0].status, "settling", "the move transaction committed before terminal settlement began");
        assert.equal(settling.rows[0].result, "black_win");

        logoutPromise = request(httpBase, "/api/auth/logout", { method: "POST", token, body: {} });
        await waitForAccountLockWait(ACCOUNT_OPERATION_LOCK_NAMESPACE,
            jwt.verify(token, TEST_SECRET).userId, "ExclusiveLock");
        assert.equal(await activeSession({ sessionId: jwt.verify(token, TEST_SECRET).jti }), true,
            "logout waits for the session lease held through terminal settlement");
        assert.equal(await activeSession(otherSession), true, "the other session remains active during this logout");
    } finally {
        await releaseGate();
    }
    const move = await operation;
    assert.equal(move.status, 200, JSON.stringify(move.body));
    const logout = await logoutPromise;
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    const final = await fixture.pool.query("SELECT status,result,winner_id FROM chess_matches WHERE id=$1", [matchId]);
    assert.equal(final.rows[0].status, "completed");
    assert.equal(final.rows[0].result, "black_win");
    assert.equal(Number(final.rows[0].winner_id), Number(jwt.verify(token, TEST_SECRET).userId));
}

test("production chess move route checks sessions, preserves another session, and serializes with logout", async () => {
    const player = await createIdentity("it_http_chess_");
    const opponent = await createIdentity("it_http_chess_opp_");
    const secondSession = await createIdentityTokenForExistingUser(player.user);
    const raceSession = await createIdentityTokenForExistingUser(player.user);

    const normalMatch = await createChessMatch(player.user.id, opponent.user.id);
    const firstMove = await request(httpBase, "/api/chess/" + normalMatch.id + "/move", {
        method: "POST", token: player.token, body: { from: "e2", to: "e4" }
    });
    assert.equal(firstMove.status, 200, JSON.stringify(firstMove.body));
    let state = await fixture.pool.query("SELECT fen,pgn,active_color FROM chess_matches WHERE id=$1", [normalMatch.id]);
    assert.notEqual(state.rows[0].fen, normalMatch.fen);
    assert.equal(state.rows[0].active_color, "b");

    const secondMatch = await createChessMatch(player.user.id, opponent.user.id);
    const logout = await request(httpBase, "/api/auth/logout", { method: "POST", token: player.token, body: {} });
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    const beforeRejected = await fixture.pool.query("SELECT fen,pgn FROM chess_matches WHERE id=$1", [secondMatch.id]);
    const rejected = await request(httpBase, "/api/chess/" + secondMatch.id + "/move", {
        method: "POST", token: player.token, body: { from: "e2", to: "e4" }
    });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.body));
    state = await fixture.pool.query("SELECT fen,pgn FROM chess_matches WHERE id=$1", [secondMatch.id]);
    assert.deepEqual(state.rows[0], beforeRejected.rows[0], "revoked session did not mutate chess state");
    const otherSessionMove = await request(httpBase, "/api/chess/" + secondMatch.id + "/move", {
        method: "POST", token: secondSession.token, body: { from: "e2", to: "e4" }
    });
    assert.equal(otherSessionMove.status, 200, JSON.stringify(otherSessionMove.body));

    const raceMatch = await createChessMatch(player.user.id, opponent.user.id);
    await gateUpdate("chess_matches", raceMatch.id, "chess");
    await runLogoutRace({
        table: "chess_matches", matchId: raceMatch.id,
        path: "/api/chess/" + raceMatch.id + "/move", token: raceSession.token,
        logoutLockNamespace: ACCOUNT_OPERATION_LOCK_NAMESPACE,
        body: { from: "e2", to: "e4" },
        stateQuery: "SELECT (fen <> 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') AS mutated FROM chess_matches WHERE id=$1"
    });
    assert.equal(await activeSession(secondSession), true, "logout revoked only the gameplay token, not the player's other session");

    const terminalSession = await createIdentityTokenForExistingUser(player.user);
    const terminalMatch = await createCheckmateMatch(opponent.user.id, player.user.id);
    await runTerminalChessLogoutBarrier({ matchId: terminalMatch.id, token: terminalSession.token, otherSession: secondSession });

    const logoutFirstSession = await createIdentityTokenForExistingUser(player.user);
    const logoutFirstMatch = await createChessMatch(player.user.id, opponent.user.id);
    await runLogoutFirstRejects({
        table: "chess_matches", matchId: logoutFirstMatch.id,
        path: "/api/chess/" + logoutFirstMatch.id + "/move", token: logoutFirstSession.token,
        gameplayLockNamespace: ACCOUNT_OPERATION_LOCK_NAMESPACE,
        body: { from: "e2", to: "e4" },
        stateQuery: "SELECT (fen <> 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') AS mutated FROM chess_matches WHERE id=$1"
    });

    const rollbackSession = await createIdentityTokenForExistingUser(player.user);
    const rollbackMatch = await createChessMatch(player.user.id, opponent.user.id);
    await runRollbackReleasesLock({
        table: "chess_matches", matchId: rollbackMatch.id,
        path: "/api/chess/" + rollbackMatch.id + "/move", token: rollbackSession.token,
        logoutLockNamespace: ACCOUNT_OPERATION_LOCK_NAMESPACE,
        body: { from: "e2", to: "e4" },
        stateQuery: "SELECT (fen <> 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') AS mutated FROM chess_matches WHERE id=$1"
    });
});

test("production eFootball result route checks sessions, preserves another session, and serializes with logout", async () => {
    const player = await createIdentity("it_http_efb_");
    const opponent = await createIdentity("it_http_efb_opp_");
    const secondSession = await createIdentityTokenForExistingUser(player.user);
    const raceSession = await createIdentityTokenForExistingUser(player.user);

    const normalMatch = await createEfootballMatch(player.user.id, opponent.user.id);
    const body = { score: 2, opponent_score: 1, resultRound: 1 };
    const firstResult = await request(httpBase, "/api/efootball/matches/" + normalMatch.id + "/result", {
        method: "POST", token: player.token, body
    });
    assert.equal(firstResult.status, 200, JSON.stringify(firstResult.body));
    let state = await fixture.pool.query("SELECT creator_submitted,creator_submitted_score,result_round FROM efootball_matches WHERE id=$1", [normalMatch.id]);
    assert.equal(state.rows[0].creator_submitted, true);
    assert.equal(Number(state.rows[0].creator_submitted_score), 2);

    const logout = await request(httpBase, "/api/auth/logout", { method: "POST", token: player.token, body: {} });
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
    const beforeRejected = await fixture.pool.query(
        "SELECT creator_submitted,creator_submitted_score FROM efootball_matches WHERE id=$1", [normalMatch.id]);
    const rejected = await request(httpBase, "/api/efootball/matches/" + normalMatch.id + "/result", {
        method: "POST", token: player.token, body: { score: 3, opponent_score: 1, resultRound: 1 }
    });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.body));
    state = await fixture.pool.query("SELECT creator_submitted,creator_submitted_score FROM efootball_matches WHERE id=$1", [normalMatch.id]);
    assert.deepEqual(state.rows[0], beforeRejected.rows[0], "revoked session did not change eFootball result state");
    const otherSessionResult = await request(httpBase, "/api/efootball/matches/" + normalMatch.id + "/result", {
        method: "POST", token: secondSession.token, body
    });
    assert.equal(otherSessionResult.status, 200, JSON.stringify(otherSessionResult.body));

    const raceMatch = await createEfootballMatch(player.user.id, opponent.user.id);
    await gateUpdate("efootball_matches", raceMatch.id, "efootball");
    await runLogoutRace({
        table: "efootball_matches", matchId: raceMatch.id,
        path: "/api/efootball/matches/" + raceMatch.id + "/result", token: raceSession.token, body,
        stateQuery: "SELECT creator_submitted AS mutated FROM efootball_matches WHERE id=$1"
    });
    assert.equal(await activeSession(secondSession), true, "logout revoked only the gameplay token, not the player's other session");
    const reports = await fixture.pool.query("SELECT count(*)::int AS count FROM efootball_result_reports WHERE match_id=$1", [raceMatch.id]);
    assert.equal(reports.rows[0].count, 1, "the authorized in-flight report committed exactly once after logout");

    const logoutFirstSession = await createIdentityTokenForExistingUser(player.user);
    const logoutFirstMatch = await createEfootballMatch(player.user.id, opponent.user.id);
    await runLogoutFirstRejects({
        table: "efootball_matches", matchId: logoutFirstMatch.id,
        path: "/api/efootball/matches/" + logoutFirstMatch.id + "/result", token: logoutFirstSession.token, body,
        stateQuery: "SELECT creator_submitted AS mutated FROM efootball_matches WHERE id=$1"
    });

    const rollbackSession = await createIdentityTokenForExistingUser(player.user);
    const rollbackMatch = await createEfootballMatch(player.user.id, opponent.user.id);
    await runRollbackReleasesLock({
        table: "efootball_matches", matchId: rollbackMatch.id,
        path: "/api/efootball/matches/" + rollbackMatch.id + "/result", token: rollbackSession.token, body,
        stateQuery: "SELECT creator_submitted AS mutated FROM efootball_matches WHERE id=$1"
    });
    const rolledBackReports = await fixture.pool.query("SELECT count(*)::int AS count FROM efootball_result_reports WHERE match_id=$1", [rollbackMatch.id]);
    assert.equal(rolledBackReports.rows[0].count, 0, "the failed transaction also rolled back its result report");
});

async function createIdentityTokenForExistingUser(user) {
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const token = await createAuthToken({ ...user, auth_version: 0 }, client);
        await client.query("COMMIT");
        return { token, sessionId: jwt.verify(token, TEST_SECRET).jti };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
