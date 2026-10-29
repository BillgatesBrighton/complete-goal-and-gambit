"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const chessRoutes = require("../routes/chess");
const createChessConnectionMonitor = require("../services/chessConnectionMonitor");
const { leaveChessConnectionOnMatchChange } = require("../services/chessSocketRooms");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeSocket(id, userId) {
    return { id, user: { userId } };
}

test("connection monitor counts tabs, pauses on the last socket, and resumes the existing match after both return", async () => {
    const paused = [];
    const resumed = [];
    const monitor = createChessConnectionMonitor({
        async pauseMatch(matchId, userId) { paused.push([matchId, userId]); return { paused: true }; },
        async resumeMatch(matchId, users) { resumed.push([matchId, Array.from(users).sort()]); return { resumed: true }; }
    });

    const whiteTabA = fakeSocket("white-a", 41);
    const whiteTabB = fakeSocket("white-b", 41);
    const blackTab = fakeSocket("black-a", 42);
    await monitor.joinMatch(whiteTabA, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    await monitor.joinMatch(whiteTabB, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    await monitor.joinMatch(blackTab, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    assert.equal(monitor.isMatchReady(501), true);
    await monitor.joinMatch(whiteTabA, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    assert.equal(paused.length, 0, "repeating an authenticated join on the same socket is idempotent");
    assert.equal(monitor.isMatchReady(501), true);

    monitor.leaveSocket(whiteTabA);
    await flush();
    assert.equal(paused.length, 0, "closing one tab must not mark a still-connected user offline");
    monitor.leaveSocket(whiteTabB);
    await flush();
    assert.deepEqual(paused, [[501, 41]], "the server pauses as soon as the user's final match socket disappears");
    assert.equal(resumed.length, 0, "the connected opponent alone cannot resume play");

    const refreshedWhite = fakeSocket("white-refresh", 41);
    await monitor.joinMatch(refreshedWhite, {
        matchId: 501, playerWhiteId: 41, playerBlackId: 42, connectionPausedAt: new Date()
    });
    assert.equal(resumed.length, 1, "both authenticated seats must have a match socket before the server may resume");
    assert.deepEqual(resumed[0], [501, [41, 42]]);

    monitor.leaveSocket(refreshedWhite);
    await flush();
    assert.equal(paused.length, 2, "a later last-socket loss pauses the same match again");
    const recoveredWhite = fakeSocket("white-recovered", 41);
    await monitor.joinMatch(recoveredWhite, {
        matchId: 501, playerWhiteId: 41, playerBlackId: 42, connectionPausedAt: new Date()
    });
    assert.equal(resumed.length, 2);
    monitor.stop();
});

test("same-match socket retries do not simulate a disconnect before reconnecting", async () => {
    const paused = [];
    const monitor = createChessConnectionMonitor({
        async pauseMatch(matchId, userId) { paused.push([matchId, userId]); return { paused: true }; },
        async resumeMatch() { return { resumed: true }; }
    });
    const white = fakeSocket("white-retry", 41);
    const black = fakeSocket("black-retry", 42);
    const details = { matchId: 501, playerWhiteId: 41, playerBlackId: 42, status: "active" };

    await monitor.joinMatch(white, details);
    await monitor.joinMatch(black, details);
    assert.equal(monitor.isMatchReady(501), true);
    const pausesBeforeRetry = paused.length;

    assert.equal(leaveChessConnectionOnMatchChange(white, 501, monitor), false,
        "the server keeps the same match socket registered when handling a repeated join");
    await monitor.joinMatch(white, details);
    assert.equal(paused.length, pausesBeforeRetry,
        "a same-match retry must not trigger another pause transition");
    assert.equal(monitor.isMatchReady(501), true);

    monitor.stop();
});

test("first observation of an active match after monitor restart pauses conservatively at persisted clocks", async () => {
    const pauses = [];
    const monitor = createChessConnectionMonitor({
        async pauseMatch(matchId, userId, options) {
            pauses.push({ matchId, userId, options });
            return { paused: true };
        }
    });
    const white = fakeSocket("white-after-restart", 41);
    await monitor.joinMatch(white, {
        matchId: 502, playerWhiteId: 41, playerBlackId: 42,
        status: "active", connectionPausedAt: null
    });
    assert.equal(pauses.length, 1);
    assert.deepEqual(pauses[0], {
        matchId: 502, userId: 42, options: { preserveStoredClock: true }
    });
    assert.equal(monitor.isMatchReady(502), false, "one returning player cannot resume official play");
    monitor.stop();
});

test("a disconnect from an old socket cannot mark its still-connected replacement offline", async () => {
    const paused = [];
    const monitor = createChessConnectionMonitor({
        async pauseMatch(matchId, userId) { paused.push([matchId, userId]); return { paused: true }; }
    });
    const oldSocket = fakeSocket("reused-id", 41);
    await monitor.joinMatch(oldSocket, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    const replacement = fakeSocket("replacement-id", 41);
    await monitor.joinMatch(replacement, { matchId: 501, playerWhiteId: 41, playerBlackId: 42 });
    assert.equal(monitor.leaveSocket(oldSocket), true, "the old socket record is removed independently");
    await flush();
    assert.equal(paused.length, 0);
    assert.deepEqual(Array.from(monitor.connectedUserIds(501)), [41]);
    monitor.stop();
});

function createPausedMatchPool() {
    const row = {
        id: 501, player_white_id: 41, player_black_id: 42, status: "active",
        result: null, winner_id: null, fen: START_FEN, pgn: "", active_color: "w",
        white_time_ms: 60000, black_time_ms: 60000,
        last_move_at: new Date(Date.now() - 5000), time_control: "1+0",
        match_type: "ranked", stake_amount: 0, white_name: "white", black_name: "black",
        white_rating: 1200, black_rating: 1200, draw_offer_user_id: null,
        connection_paused_at: null, connection_pause_reason: null, connection_lost_user_id: null
    };
    const events = [];
    const io = { to(room) { return { emit(name, data) { events.push({ room, name, data }); } }; } };
    const pool = {
        async query(sql) {
            if (String(sql).includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (String(sql).includes("FROM chess_matches m")) return { rows: [{ ...row }] };
            throw new Error("Unexpected pool query in isolated chess pause test: " + String(sql).slice(0, 120));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql);
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
                    if (/SELECT\s+\*\s+FROM\s+chess_matches\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(text)) return { rows: [{ ...row }] };
                    if (text.includes("SET white_time_ms=$1,black_time_ms=$2,last_move_at=NULL")) {
                        row.white_time_ms = params[0]; row.black_time_ms = params[1]; row.last_move_at = null;
                        row.connection_pause_reason = params[2]; row.connection_lost_user_id = params[3];
                        row.connection_paused_at = new Date();
                        return { rows: [], rowCount: 1 };
                    }
                    if (text.includes("SET last_move_at=NOW(),connection_paused_at=NULL")) {
                        row.last_move_at = new Date(); row.connection_paused_at = null;
                        row.connection_pause_reason = null; row.connection_lost_user_id = null;
                        return { rows: [], rowCount: 1 };
                    }
                    throw new Error("Unexpected isolated chess pause transaction: " + text.slice(0, 160));
                },
                release() {}
            };
        }
    };
    return { row, pool, io, events };
}

test("server pause freezes both clock values, broadcasts, blocks moves, and resumes from saved time", async t => {
    const { row, pool, io, events } = createPausedMatchPool();
    const router = chessRoutes(pool, (req, _res, next) => { req.user = { userId: 41 }; next(); }, io);
    const pause = await router.pauseForConnectionLoss(501, 42);

    assert.equal(pause.paused, true);
    assert.ok(row.connection_paused_at);
    assert.equal(row.last_move_at, null);
    assert.ok(row.white_time_ms <= 55000 && row.white_time_ms > 0, "the active side retains only confirmed elapsed time");
    assert.equal(row.black_time_ms, 60000, "the inactive side keeps its full remaining time");
    assert.equal(events.some(event => event.name === "chess:paused" && event.room === "chess_match_501"), true);
    assert.equal(events.filter(event => event.name === "chess:engine:match_state").length, 2,
        "both participants' companion user rooms receive the server pause status");

    const app = express();
    app.use(express.json());
    app.use("/api/chess", router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/chess/501/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "e2", to: "e4", expectedFen: START_FEN, expectedPly: 0 })
    });
    assert.equal(response.status, 409, "the paused server rejects a legal-looking client move");
    await assert.rejects(chessRoutes.settleMatch(pool, 501, "white_win", 41), /paused/i,
        "the shared financial settlement path rejects a paused match");

    const partialResume = await router.resumeAfterConnection(501, new Set([41]));
    assert.equal(partialResume.reason, "players_not_reconnected");
    assert.ok(row.connection_paused_at, "one reconnected player cannot resume the clock");
    const storedWhite = row.white_time_ms;
    const storedBlack = row.black_time_ms;
    const resumed = await router.resumeAfterConnection(501, new Set([41, 42]));
    assert.equal(resumed.resumed, true);
    assert.equal(row.connection_paused_at, null);
    assert.ok(row.last_move_at instanceof Date);
    assert.equal(row.white_time_ms, storedWhite);
    assert.equal(row.black_time_ms, storedBlack);
    assert.equal(events.some(event => event.name === "chess:resumed"), true);
});

test("process recovery pause preserves persisted clocks instead of expiring a match during backend downtime", async () => {
    const { row, pool } = createPausedMatchPool();
    const router = chessRoutes(pool, (req, _res, next) => { req.user = { userId: 41 }; next(); }, null);
    const paused = await router.pauseForConnectionLoss(501, 42, { preserveStoredClock: true });
    assert.equal(paused.paused, true);
    assert.equal(row.white_time_ms, 60000);
    assert.equal(row.black_time_ms, 60000);
    assert.ok(row.connection_paused_at);
    assert.equal(row.last_move_at, null);
});
