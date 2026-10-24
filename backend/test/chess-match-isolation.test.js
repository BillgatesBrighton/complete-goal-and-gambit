"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Chess } = require("chess.js");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const chessRoutes = require("../routes/chess");
const {
    beginChessJoinAttempt,
    isCurrentChessJoinAttempt,
    hasValidChessMatchSeats,
    joinChessMatchRoom
} = require("../services/chessSocketRooms");

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function makeMatch(id, whiteId, blackId) {
    return {
        id,
        player_white_id: whiteId,
        player_black_id: blackId,
        status: "active",
        result: null,
        winner_id: null,
        fen: INITIAL_FEN,
        pgn: "",
        active_color: "w",
        white_time_ms: 60000,
        black_time_ms: 60000,
        last_move_at: new Date(),
        started_at: new Date(),
        time_control: "1+1",
        match_type: "ranked",
        stake_amount: 0,
        white_name: "white-" + whiteId,
        black_name: "black-" + blackId,
        white_rating: 1200,
        black_rating: 1200,
        draw_offer_user_id: null
    };
}

function createRowLock() {
    let tail = Promise.resolve();
    return async function acquire() {
        const previous = tail;
        let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        return release;
    };
}

function createMemoryChessPool(matches, accounts = new Map()) {
    const locks = new Map(Array.from(matches.keys(), id => ["match:" + id, createRowLock()]));
    let nextLedgerId = 1;
    function getLock(key) {
        if (!locks.has(key)) locks.set(key, createRowLock());
        return locks.get(key);
    }
    return {
        async query(sql, params) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id IS NOT NULL")) return { rows: [] };
            if (text.includes("FROM chess_matches m") && text.includes("WHERE m.id = $1")) {
                const match = matches.get(Number(params[0]));
                if (!match) return { rows: [] };
                const white = accounts.get(Number(match.player_white_id));
                const black = accounts.get(Number(match.player_black_id));
                if (white) Object.assign(match, { white_name: white.username, white_rating: white.rating });
                if (black) Object.assign(match, { black_name: black.username, black_rating: black.rating });
                return { rows: [match] };
            }
            throw new Error("Unexpected pool query in isolated load test: " + text.slice(0, 100));
        },
        async connect() {
            const releases = [];
            let releaseRow = null;
            let lockedMatch = null;
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    if (text === "BEGIN") return { rows: [] };
                    if (text === "COMMIT" || text === "ROLLBACK") {
                        for (const release of releases.splice(0).reverse()) release();
                        if (releaseRow) releaseRow();
                        releaseRow = null;
                        lockedMatch = null;
                        return { rows: [] };
                    }
                    if (text.includes("pg_advisory_xact_lock")) {
                        releases.push(await getLock("advisory:" + String(params[0]))());
                        return { rows: [] };
                    }
                    if (text.includes("SELECT rating, game, account_status FROM users WHERE id=$1 FOR UPDATE")) {
                        const account = accounts.get(Number(params[0]));
                        return { rows: account ? [account] : [] };
                    }
                    if (text.includes("SELECT id, status FROM chess_matches")) {
                        const userId = Number(params[0]);
                        const row = Array.from(matches.values()).find(match =>
                            [Number(match.player_white_id), Number(match.player_black_id)].includes(userId) &&
                            ["waiting", "active", "settling"].includes(match.status));
                        return { rows: row ? [{ id: row.id, status: row.status }] : [] };
                    }
                    if (text.includes("SELECT waiting.id")) {
                        const [userId, matchType, stake, timeControl, ranked, minimum, maximum] = params;
                        const row = Array.from(matches.values()).find(match => {
                            const owner = accounts.get(Number(match.player_white_id));
                            if (!owner || owner.account_status !== "active" || !["chess", "both"].includes(owner.game)) return false;
                            if (match.status !== "waiting" || match.player_black_id != null ||
                                Number(match.player_white_id) === Number(userId) || match.match_type !== matchType ||
                                Number(match.stake_amount) !== Number(stake) || match.time_control !== timeControl) return false;
                            if (ranked && (Number(owner.rating) < Number(minimum) || Number(owner.rating) > Number(maximum))) return false;
                            return !Array.from(matches.values()).some(other => other.id !== match.id &&
                                ["waiting", "active", "settling"].includes(other.status) &&
                                [Number(other.player_white_id), Number(other.player_black_id)].includes(Number(match.player_white_id)));
                        });
                        return { rows: row ? [{ id: row.id }] : [] };
                    }
                    if (text.includes("INSERT INTO chess_matches")) {
                        const [whiteId, fen, initialTime, timeControl, matchType, stake] = params;
                        const id = matches.size ? Math.max(...matches.keys()) + 1 : 1;
                        const account = accounts.get(Number(whiteId));
                        matches.set(id, {
                            ...makeMatch(id, Number(whiteId), null),
                            status: "waiting",
                            fen,
                            pgn: "",
                            white_time_ms: initialTime,
                            black_time_ms: initialTime,
                            time_control: timeControl,
                            match_type: matchType,
                            stake_amount: stake,
                            white_name: account && account.username,
                            white_rating: account && account.rating,
                            black_name: null,
                            black_rating: null
                        });
                        getLock("match:" + id);
                        return { rows: [{ id }] };
                    }
                    if (text.includes("UPDATE chess_matches") && text.includes("SET player_black_id=$1")) {
                        const match = matches.get(Number(params[1]));
                        if (!match) return { rows: [] };
                        match.player_black_id = Number(params[0]);
                        match.status = "active";
                        match.started_at = new Date();
                        match.last_move_at = new Date();
                        match.active_color = "w";
                        return { rows: [] };
                    }
                    if (text.startsWith("UPDATE wallets")) return { rows: [{ user_id: Number(params[1]) }] };
                    if (text.includes("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: nextLedgerId++ }] };
                    if (text.includes("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: Number(params[0]) }] };
                    if (text.startsWith("INSERT INTO transactions") || text.includes("INSERT INTO financial_ledger_entries")) return { rows: [] };
                    if (text === "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE") {
                        const id = Number(params[0]);
                        const acquire = getLock("match:" + id);
                        if (!acquire) return { rows: [] };
                        releaseRow = await acquire();
                        lockedMatch = matches.get(id);
                        return { rows: lockedMatch ? [lockedMatch] : [] };
                    }
                    if (text.startsWith("UPDATE chess_matches SET fen=$1")) {
                        assert.ok(lockedMatch, "a match row must be locked before updating it");
                        const [fen, pgn, whiteTime, blackTime, activeColor, result, winnerId] = params;
                        Object.assign(lockedMatch, {
                            fen,
                            pgn,
                            white_time_ms: whiteTime,
                            black_time_ms: blackTime,
                            active_color: activeColor,
                            last_move_at: new Date(),
                            status: result ? "settling" : "active",
                            result,
                            winner_id: winnerId
                        });
                        return { rows: [] };
                    }
                    throw new Error("Unexpected transaction query in isolated load test: " + text.slice(0, 100));
                },
                release() {
                    for (const release of releases.splice(0).reverse()) release();
                    if (releaseRow) releaseRow();
                    releaseRow = null;
                    lockedMatch = null;
                }
            };
        }
    };
}

async function startIsolatedApi(pool, io) {
    const app = express();
    app.use(express.json());
    app.use("/api/chess", chessRoutes(pool, (req, _res, next) => {
        req.user = { userId: Number(req.headers["x-test-user-id"]) };
        next();
    }, io));
    const server = require("node:http").createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        base: "http://127.0.0.1:" + server.address().port + "/api/chess",
        close: () => new Promise(resolve => {
            server.closeAllConnections();
            server.close(resolve);
        })
    };
}

function percentile(values, fraction) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

test("100 isolated active matches accept 200 concurrent authenticated player moves", async t => {
    const matches = new Map();
    const accounts = new Map();
    const openings = [];
    const initial = new Chess();
    for (const whiteMove of initial.moves({ verbose: true })) {
        const afterWhite = new Chess();
        afterWhite.move({ from: whiteMove.from, to: whiteMove.to, promotion: whiteMove.promotion });
        for (const blackMove of afterWhite.moves({ verbose: true }).slice(0, 5)) {
            openings.push({
                white: { from: whiteMove.from, to: whiteMove.to, promotion: whiteMove.promotion || "q" },
                black: { from: blackMove.from, to: blackMove.to, promotion: blackMove.promotion || "q" }
            });
            if (openings.length === 100) break;
        }
        if (openings.length === 100) break;
    }
    assert.equal(openings.length, 100);
    for (let index = 0; index < 200; index++) {
        const bracketBase = index < 100 ? 1200 : 1400;
        const withinBracket = index % 100;
        const id = 10000 + index;
        accounts.set(id, {
            id,
            username: "load-player-" + id,
            rating: bracketBase + withinBracket,
            game: "chess",
            account_status: "active"
        });
    }

    const emitted = [];
    const io = { to(room) { return { emit(event, data) { emitted.push({ room, event, data }); } }; } };
    const api = await startIsolatedApi(createMemoryChessPool(matches, accounts), io);
    t.after(api.close);

    const matchmakingStarted = performance.now();
    const createdMatches = await Promise.all(Array.from(accounts, async ([userId], index) => {
        const withinBracket = index % 100;
        const speed = withinBracket < 50 ? "bullet" : "blitz";
        const timeControl = speed === "bullet" ? "1+1" : "3+2";
        const response = await fetch(api.base + "/create", {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-user-id": String(userId) },
            body: JSON.stringify({
                matchType: "ranked",
                speed,
                timeControl,
                stake: 20,
                rating: 1200,
                bracketMinimum: 1100
            })
        });
        const body = await response.json();
        return { status: response.status, body };
    }));
    const matchmakingMs = performance.now() - matchmakingStarted;
    assert.ok(createdMatches.every(result => result.status === 201 && result.body.success));
    assert.equal(matches.size, 100, "200 concurrent searches should create 100 real two-player matches");
    const colorsByMatch = new Map();
    for (const result of createdMatches) {
        const seats = colorsByMatch.get(Number(result.body.match.matchId)) || [];
        seats.push(result.body.match.playerColor);
        colorsByMatch.set(Number(result.body.match.matchId), seats);
    }
    assert.equal(colorsByMatch.size, 100);
    assert.ok(Array.from(colorsByMatch.values()).every(seats => seats.length === 2 && seats.includes("w") && seats.includes("b")),
        "each match response should assign its two distinct players opposite colors");
    const createdIds = new Set(Array.from(matches.values()).flatMap(match => [Number(match.player_white_id), Number(match.player_black_id)]));
    assert.equal(createdIds.size, 200, "no authenticated test identity may occupy two seats");
    assert.ok(Array.from(matches.values()).every(match => {
        const white = accounts.get(Number(match.player_white_id));
        const black = accounts.get(Number(match.player_black_id));
        const bracket = rating => 100 + Math.floor((Number(rating) - 100) / 200) * 200;
        return match.status === "active" && Number(match.player_white_id) !== Number(match.player_black_id) &&
            bracket(white.rating) === bracket(black.rating) && white.rating >= 1100 && black.rating >= 1100 &&
            white.rating <= 1499 && black.rating <= 1499 && white.id !== black.id &&
            ((white.rating < 1300) === (black.rating < 1300));
    }), "ranked opponents must be distinct and in the same database-derived 200-point bracket");
    assert.equal(Array.from(matches.values()).filter(match => match.time_control === "1+1").length, 50);
    assert.equal(Array.from(matches.values()).filter(match => match.time_control === "3+2").length, 50);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    delay.enable();

    async function submit(matchId, userId, move, expectedFen, expectedPly) {
        const before = performance.now();
        const response = await fetch(api.base + "/" + matchId + "/move", {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-user-id": String(userId) },
            body: JSON.stringify({ ...move, expectedFen, expectedPly })
        });
        const body = await response.json();
        return { status: response.status, body, latency: performance.now() - before };
    }

    const whiteResults = await Promise.all(Array.from(matches, async ([matchId, match], index) => {
        return submit(matchId, match.player_white_id, openings[index].white, INITIAL_FEN, 0);
    }));
    assert.ok(whiteResults.every(result => result.status === 200), "every white move should be accepted");
    const blackResults = await Promise.all(Array.from(matches, async ([matchId, match], index) => {
        return submit(matchId, match.player_black_id, openings[index].black, match.fen, 1);
    }));
    assert.ok(blackResults.every(result => result.status === 200), "every black move should be accepted");

    delay.disable();
    const durationMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const latencies = whiteResults.concat(blackResults).map(result => result.latency);
    const finalPositions = new Set(Array.from(matches.values(), match => match.fen));
    assert.equal(matches.size, 100);
    assert.equal(finalPositions.size, 100, "each match should retain its own independently-played position");
    assert.ok(Array.from(matches.values()).every(match => match.status === "active" && match.active_color === "w"));
    const moveEvents = emitted.filter(item => item.event === "chess:move");
    const readyEvents = emitted.filter(item => item.event === "chess:match_ready");
    assert.equal(moveEvents.length, 200);
    assert.equal(readyEvents.length, 100);
    assert.ok(moveEvents.every(item => item.room === "chess_match_" + item.data.matchId));
    assert.ok(readyEvents.every(item => item.data.match === undefined && Number.isSafeInteger(item.data.matchId)),
        "room broadcasts must not contain a joining player's personalized match state");
    assert.equal(new Set(Array.from(matches.values()).flatMap(match => [match.player_white_id, match.player_black_id])).size, 200);

    console.log("ℹ Isolated route load (100 in-memory matches, 200 test identities, 200 moves; no PostgreSQL or real Socket.IO clients): " +
        "p50 " + percentile(latencies, 0.50).toFixed(2) + " ms, p95 " + percentile(latencies, 0.95).toFixed(2) +
        " ms, " + (200000 / durationMs).toFixed(1) + " accepted moves/s, " +
        (cpu.user / 1000).toFixed(1) + " ms user CPU, " + (cpu.system / 1000).toFixed(1) + " ms system CPU, " +
        ((process.memoryUsage().rss - rssBefore) / (1024 * 1024)).toFixed(1) + " MiB RSS delta, event-loop p95 " +
        (Number(delay.percentile(95)) / 1e6).toFixed(2) + " ms.");
    console.log("ℹ Synthetic concurrent matchmaking: 200 /create requests produced 100 active matches across two authoritative rating brackets and two time controls in " +
        matchmakingMs.toFixed(1) + " ms (in-memory PostgreSQL substitute).");
});

function createJoinPool({ userId, account, existingMatch, waitingMatch, waitingPlayerLive }) {
    const trace = [];
    let updated = false;
    const pool = {
        async query(sql, params) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id IS NOT NULL")) return { rows: [] };
            if (text.includes("FROM chess_matches m") && text.includes("WHERE m.id = $1")) {
                return { rows: waitingMatch ? [waitingMatch] : [] };
            }
            throw new Error("Unexpected top-level join test query: " + text.slice(0, 100));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    trace.push(text);
                    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
                    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
                    if (text.includes("SELECT rating, game, account_status FROM users WHERE id=$1 FOR UPDATE")) {
                        return { rows: [account] };
                    }
                    if (text.includes("SELECT id FROM chess_matches") && text.includes("WHERE (player_white_id=$1 OR player_black_id=$1)")) {
                        return { rows: existingMatch ? [{ id: existingMatch }] : [] };
                    }
                    if (text.includes("FROM chess_matches waiting") && text.includes("FOR UPDATE OF waiting")) {
                        return { rows: waitingMatch ? [waitingMatch] : [] };
                    }
                    if (text.includes("WHERE id<>$1 AND (player_white_id=$2 OR player_black_id=$2)")) {
                        return { rows: waitingPlayerLive ? [{ id: waitingPlayerLive }] : [] };
                    }
                    if (text.includes("UPDATE chess_matches") && text.includes("SET player_black_id=$1")) {
                        waitingMatch.player_black_id = Number(params[0]);
                        waitingMatch.status = "active";
                        updated = true;
                        return { rows: [] };
                    }
                    throw new Error("Unexpected join transaction query: " + text.slice(0, 120));
                },
                release() {}
            };
        }
    };
    return { pool, trace, wasUpdated: () => updated };
}

function waitingMatch(overrides = {}) {
    return {
        ...makeMatch(700, 41, null),
        status: "waiting",
        player_black_id: null,
        match_type: "ranked",
        waiting_player_rating: 1200,
        waiting_player_game: "chess",
        waiting_player_account_status: "active",
        ...overrides
    };
}

test("manual ranked joins reject an already-matched user and a different rating bracket", async t => {
    const matchedData = createJoinPool({
        userId: 42,
        account: { rating: 1200, game: "chess", account_status: "active" },
        existingMatch: 690,
        waitingMatch: waitingMatch()
    });
    const matchedApi = await startIsolatedApi(matchedData.pool, null);
    t.after(matchedApi.close);
    const alreadyMatched = await fetch(matchedApi.base + "/700/join", {
        method: "POST", headers: { "content-type": "application/json", "x-test-user-id": "42" }, body: "{}"
    });
    assert.equal(alreadyMatched.status, 409);
    assert.equal(matchedData.trace.some(sql => sql.includes("FROM chess_matches waiting")), false,
        "an account with a live match should be rejected before claiming a second seat");

    const bracketData = createJoinPool({
        userId: 42,
        account: { rating: 1700, game: "chess", account_status: "active" },
        waitingMatch: waitingMatch({ waiting_player_rating: 1200 })
    });
    const bracketApi = await startIsolatedApi(bracketData.pool, null);
    t.after(bracketApi.close);
    const wrongBracket = await fetch(bracketApi.base + "/700/join", {
        method: "POST", headers: { "content-type": "application/json", "x-test-user-id": "42" }, body: "{}"
    });
    const wrongBracketBody = await wrongBracket.json();
    assert.equal(wrongBracket.status, 409);
    assert.match(wrongBracketBody.message, /same rating bracket/i);
    assert.equal(bracketData.wasUpdated(), false);
});

test("a same-bracket ranked join pairs two distinct players and broadcasts no personalized state", async t => {
    const data = createJoinPool({
        userId: 42,
        account: { rating: 1200, game: "both", account_status: "active" },
        waitingMatch: waitingMatch({ waiting_player_rating: 1299 })
    });
    const emitted = [];
    const io = { to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } };
    const api = await startIsolatedApi(data.pool, io);
    t.after(api.close);
    const response = await fetch(api.base + "/700/join", {
        method: "POST", headers: { "content-type": "application/json", "x-test-user-id": "42" }, body: "{}"
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.match.playerWhiteId, 41);
    assert.equal(body.match.playerBlackId, 42);
    assert.equal(body.match.playerColor, "b");
    assert.equal(data.wasUpdated(), true);
    assert.deepEqual(emitted, [{ room: "chess_match_700", event: "chess:match_ready", payload: { success: true, matchId: 700 } }]);
});

test("self-assigned historical match rows cannot be read as a playable seat", async t => {
    const malformed = new Map([[501, makeMatch(501, 41, 41)]]);
    const api = await startIsolatedApi(createMemoryChessPool(malformed), null);
    t.after(api.close);
    const response = await fetch(api.base + "/501", { headers: { "x-test-user-id": "41" } });
    assert.equal(response.status, 403);
});

test("an unmatched casual search remains a one-player waiting match without a fabricated opponent", async t => {
    const created = {
        ...makeMatch(701, 53, null),
        status: "waiting",
        player_black_id: null,
        black_name: null,
        black_rating: null,
        match_type: "casual",
        time_control: "10:00"
    };
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id IS NOT NULL")) return { rows: [] };
            if (text.includes("FROM chess_matches m") && text.includes("WHERE m.id = $1")) return { rows: [created] };
            throw new Error("Unexpected top-level create query: " + text.slice(0, 100));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
                    if (text.includes("SELECT rating, game, account_status FROM users WHERE id=$1 FOR UPDATE")) {
                        return { rows: [{ rating: 1200, game: "chess", account_status: "active" }] };
                    }
                    if (text.includes("SELECT id, status FROM chess_matches")) return { rows: [] };
                    if (text.includes("SELECT waiting.id")) return { rows: [] };
                    if (text.includes("INSERT INTO chess_matches")) return { rows: [{ id: created.id }] };
                    throw new Error("Unexpected create transaction query: " + text.slice(0, 120));
                },
                release() {}
            };
        }
    };
    const api = await startIsolatedApi(pool, null);
    t.after(api.close);
    const response = await fetch(api.base + "/create", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user-id": "53" },
        body: JSON.stringify({ matchType: "casual", speed: "rapid", timeControl: "10:00" })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.matched, false);
    assert.equal(body.match.status, "waiting");
    assert.equal(body.match.playerBlackId, null);
    assert.equal(body.match.opponentId, null);
    assert.equal(body.match.blackName, null);
});

test("socket room switching leaves the old room and stale join lookups are ignored", () => {
    assert.equal(hasValidChessMatchSeats({ status: "waiting", player_white_id: 41, player_black_id: null }), true,
        "the searching white player must remain subscribed while a real opponent is sought");
    assert.equal(hasValidChessMatchSeats({ status: "active", player_white_id: 41, player_black_id: 41 }), false);
    assert.equal(hasValidChessMatchSeats({ status: "active", player_white_id: 41, player_black_id: 42 }), true);
    const socket = {
        rooms: new Set(),
        join(room) { this.rooms.add(room); },
        leave(room) { this.rooms.delete(room); }
    };
    const oldAttempt = beginChessJoinAttempt(socket);
    joinChessMatchRoom(socket, 1);
    const newAttempt = beginChessJoinAttempt(socket);
    assert.equal(isCurrentChessJoinAttempt(socket, oldAttempt), false);
    assert.equal(isCurrentChessJoinAttempt(socket, newAttempt), true);
    assert.deepEqual(Array.from(socket.rooms), [], "switching begins by leaving the stale private match room");
    assert.equal(socket.currentChessMatchId, null);
    joinChessMatchRoom(socket, 2);
    assert.deepEqual(Array.from(socket.rooms), ["chess_match_2"]);
    assert.equal(socket.currentChessMatchId, 2);
});
