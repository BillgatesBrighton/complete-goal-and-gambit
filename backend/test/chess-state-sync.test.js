"use strict";

const test = require("node:test");
const { before } = test;
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");
const chessRoutes = require("../routes/chess");

let BrowserChess;
before(async () => {
    const moduleUrl = require("url").pathToFileURL(path.resolve(__dirname, "../../frontend/js/vendor/chess.mjs")).href;
    BrowserChess = (await import(moduleUrl)).Chess;
});

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function matchRow(overrides = {}) {
    return {
        id: 501,
        player_white_id: 41,
        player_black_id: 42,
        status: "active",
        result: null,
        winner_id: null,
        fen: INITIAL_FEN,
        pgn: "",
        active_color: "w",
        white_time_ms: 600000,
        black_time_ms: 600000,
        last_move_at: new Date(),
        time_control: "10+0",
        match_type: "ranked",
        stake_amount: 0,
        white_name: "white-player",
        black_name: "black-player",
        white_rating: 1200,
        black_rating: 1200,
        draw_offer_user_id: null,
        ...overrides
    };
}

async function startChessApi(pool, io, userId = 41) {
    const app = express();
    app.use(express.json());
    app.use("/api/chess", chessRoutes(pool, (req, _res, next) => {
        req.user = { userId };
        next();
    }, io));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        base: "http://127.0.0.1:" + server.address().port + "/api/chess",
        close: () => new Promise(resolve => server.close(resolve))
    };
}

test("ordinary active match GET returns without opening a settlement transaction", async t => {
    let transactionStarts = 0;
    let matchReads = 0;
    const current = matchRow();
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) {
                matchReads++;
                return { rows: [current] };
            }
            throw new Error("Unexpected SQL in read-only test: " + text.slice(0, 120));
        },
        async connect() {
            transactionStarts++;
            throw new Error("An unexpired active match must not start a transaction.");
        }
    };
    const api = await startChessApi(pool);
    t.after(api.close);

    const response = await fetch(api.base + "/501");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.matchId, 501);
    assert.equal(matchReads, 1);
    assert.equal(transactionStarts, 0);
});

test("expired-clock GET rechecks under the existing row lock before settling", async t => {
    const expired = matchRow({
        white_time_ms: 25,
        last_move_at: new Date(Date.now() - 1000)
    });
    const current = matchRow({ white_time_ms: 30000, last_move_at: new Date() });
    const transactionQueries = [];
    let matchReads = 0;
    let updates = 0;
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) {
                matchReads++;
                return { rows: [matchReads === 1 ? expired : current] };
            }
            throw new Error("Unexpected SQL in expiry test: " + text.slice(0, 120));
        },
        async connect() {
            return {
                async query(sql) {
                    const text = String(sql).trim();
                    transactionQueries.push(text);
                    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
                    if (text.includes("SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE")) return { rows: [current] };
                    if (text.startsWith("UPDATE chess_matches")) updates++;
                    throw new Error("Unexpected transaction SQL: " + text.slice(0, 120));
                },
                release() {}
            };
        }
    };
    const api = await startChessApi(pool);
    t.after(api.close);

    const response = await fetch(api.base + "/501");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.status, "active");
    assert.equal(matchReads, 2);
    assert.deepEqual(transactionQueries.slice(0, 2), ["BEGIN", "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE"]);
    assert.equal(transactionQueries.at(-1), "COMMIT");
    assert.equal(updates, 0, "a clock refreshed before the lock must not be settled");
});

test("move event identifies the authenticated actor without broadcasting match state", async t => {
    let current = matchRow();
    const emitted = [];
    const io = { to(room) { return { emit(event, data) { emitted.push({ room, event, data }); } }; } };
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) return { rows: [current] };
            throw new Error("Unexpected SQL after move: " + text.slice(0, 120));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
                    if (text.includes("SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE")) return { rows: [current] };
                    if (text.startsWith("UPDATE chess_matches SET fen=$1")) {
                        current = matchRow({
                            fen: params[0], pgn: params[1], white_time_ms: params[2],
                            black_time_ms: params[3], active_color: params[4],
                            last_move_at: new Date(), status: params[5] ? "settling" : "active",
                            result: params[5], winner_id: params[6]
                        });
                        return { rows: [] };
                    }
                    throw new Error("Unexpected move transaction SQL: " + text.slice(0, 120));
                },
                release() {}
            };
        }
    };
    const api = await startChessApi(pool, io, 41);
    t.after(api.close);

    const response = await fetch(api.base + "/501/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "e2", to: "e4", promotion: "q" })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    const moveEvent = emitted.find(item => item.event === "chess:move");
    assert.ok(moveEvent);
    assert.equal(moveEvent.data.actorUserId, 41);
    assert.equal(moveEvent.data.matchId, 501);
    assert.equal(Object.hasOwn(moveEvent.data, "match"), false);
    assert.equal(Object.hasOwn(moveEvent.data, "fen"), false);
    assert.equal(Object.hasOwn(moveEvent.data, "playerColor"), false);
});

test("backend rejects an illegal chess move while holding the match lock", async t => {
    const transactionQueries = [];
    const current = matchRow();
    const pool = {
        async connect() {
            return {
                async query(sql) {
                    const text = String(sql).trim();
                    transactionQueries.push(text);
                    if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
                    if (text === "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE") return { rows: [current] };
                    throw new Error("Illegal move must not change match data: " + text.slice(0, 100));
                },
                release() {}
            };
        }
    };
    const api = await startChessApi(pool);
    t.after(api.close);

    const response = await fetch(api.base + "/501/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "e2", to: "e5" })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.message, "Illegal chess move.");
    assert.equal(transactionQueries.at(-1), "ROLLBACK");
});

class FakeElement {
    constructor() {
        this.children = [];
        this.dataset = {};
        this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        this.style = {};
        this.listeners = {};
        this.disabled = false;
        this.hidden = false;
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    focus() {}
}

class FakeSocket {
    constructor() { this.handlers = {}; this.connected = false; this.emitted = []; this.disconnected = false; }
    on(name, callback) { (this.handlers[name] ||= []).push(callback); return this; }
    emit(...args) { this.emitted.push(args); }
    trigger(name, data) { for (const callback of this.handlers[name] || []) callback(data); }
    removeAllListeners() { this.handlers = {}; }
    disconnect() { this.disconnected = true; this.connected = false; }
}

function browserMatch(id, pgn = "") {
    return {
        matchId: id, status: "active", result: null, playerColor: "w", activeColor: "w",
        fen: INITIAL_FEN, pgn, whiteTimeMs: 600000, blackTimeMs: 600000,
        timeControl: "10+0", matchType: "ranked", stake: 0,
        whiteName: "white-player", blackName: "black-player", whiteRating: 1200, blackRating: 1200
    };
}

function pgnAfterMoves(initialFen, moves) {
    const chess = new BrowserChess(initialFen);
    for (const move of moves) chess.move(move);
    return chess.pgn();
}

function responseFor(data) {
    return { ok: true, status: 200, json: async () => data };
}

function createBoardHarness(fetchImpl, { search = "?matchId=1", iframe = false, storage = new Map(), online = true } = {}) {
    const elements = new Map();
    const documentListeners = {};
    const windows = [];
    const windowListeners = {};
    const delays = [];
    const document = {
        hidden: false,
        getElementById(id) { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
        createElement() { return new FakeElement(); },
        addEventListener(name, callback) { documentListeners[name] = callback; }
    };
    const windowObject = {
        GG_API_BASE: "https://api.test",
        addEventListener(name, callback) { windowListeners[name] = callback; },
        io() { const socket = new FakeSocket(); windows.push(socket); return socket; }
    };
    windowObject.parent = iframe ? { postMessage() {} } : windowObject;
    const location = {
        hostname: "site.test", protocol: "https:", port: "", origin: "https://site.test",
        search, href: "https://site.test/frontend/pages/board.html" + search
    };
    storage.set("goalGambitToken", storage.get("goalGambitToken") || "test-token");
    storage.set("goalGambitUserId", storage.get("goalGambitUserId") || "41");
    const context = {
        window: windowObject,
        navigator: { onLine: online, serviceWorker: null },
        document,
        location,
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        history: { replaceState() {} },
        fetch: fetchImpl,
        URL,
        URLSearchParams,
        AbortController,
        console,
        confirm: () => false,
        alert() {},
        setTimeout(_callback, delay) { delays.push(delay); return delays.length; },
        clearTimeout() {},
        setInterval() { return 1; },
        clearInterval() {}
    };
    const source = fs.readFileSync(path.join(__dirname, "../../frontend/js/board.js"), "utf8")
        .replace(/^import\s+\{\s*Chess\s*\}\s+from\s+["'][^"']+["'];\s*/m, "");
    context.Chess = BrowserChess;
    vm.createContext(context);
    vm.runInContext(source + "\n;globalThis.__boardTest={loadMatch,applyState,setMatchId,setupSocket,scheduleMatchPolling,initializeBoard,selectPiece,clickSquare,choosePromotion,sendMove,updateClocks,restoreOfflineMatch,reconcileServerMatch,readOfflineRecord,getState:()=>state,getSocket:()=>socket,getSelectedSquare:()=>selectedSquare,getLegalTargets:()=>legalTargets,getPendingPromotion:()=>pendingPromotion,getOfflineMode:()=>offlineMode,getOfflineConflict:()=>offlineConflict};", context);
    return { board: context.__boardTest, document, documentListeners, windowListeners, sockets: windows, delays, storage, setOnline(value) { context.navigator.onLine = value; } };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function latencyPercentile(samples, percentile) {
    const sorted = samples.slice().sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}

test("board coalesces refreshes, rejects stale responses, filters self events and cleans up switched matches", async () => {
    const firstRequest = deferred();
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    let getCount = 0;
    let activeGets = 0;
    let maxConcurrentGets = 0;
    const harness = createBoardHarness(async url => {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith("/api/chess/")) {
            getCount++;
            activeGets++;
            maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
            const number = getCount;
            if (number === 1) {
                firstStarted();
                try { return await firstRequest.promise; }
                finally { activeGets--; }
            }
            activeGets--;
            return responseFor({ success: true, match: browserMatch(Number(parsed.pathname.split("/").pop()), "1. e4") });
        }
        throw new Error("Unexpected browser request: " + url);
    });

    await started;
    const queuedA = harness.board.loadMatch();
    const queuedB = harness.board.loadMatch();
    harness.board.applyState(browserMatch(1, "newer-state"));
    firstRequest.resolve(responseFor({ success: true, match: browserMatch(1, "stale-state") }));
    await Promise.all([queuedA, queuedB]);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(getCount, 2, "multiple refresh triggers should produce one follow-up request");
    assert.equal(maxConcurrentGets, 1, "match GET requests must not overlap");
    assert.equal(harness.board.getState().pgn, "1. e4", "the stale response must not replace the newer board state");

    const originalSocket = harness.board.getSocket();
    assert.ok(originalSocket);
    const originalMoveHandler = originalSocket.handlers["chess:move"][0];
    const beforeSelfEvent = getCount;
    originalSocket.trigger("chess:move", { matchId: 1, actorUserId: 41 });
    assert.equal(getCount, beforeSelfEvent, "the authenticated mover should not refetch their own move");
    originalSocket.trigger("chess:move", { matchId: 1, actorUserId: 42 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getCount, beforeSelfEvent + 1, "the opponent should fetch authoritative match state once");

    harness.board.setupSocket();
    assert.equal(harness.sockets.length, 1, "repeated setup for the same match must reuse its socket");
    originalSocket.connected = true;
    harness.board.scheduleMatchPolling();
    assert.equal(harness.delays.at(-1), 10000);
    originalSocket.connected = false;
    harness.board.scheduleMatchPolling();
    assert.equal(harness.delays.at(-1), 2000);

    harness.board.setMatchId(2);
    harness.board.setupSocket();
    assert.equal(originalSocket.disconnected, true);
    assert.equal(harness.sockets.length, 2);
    const beforeOldEvent = getCount;
    originalMoveHandler({ matchId: 1, actorUserId: 42 });
    assert.equal(getCount, beforeOldEvent, "a callback from the old match must be ignored after switching");

    harness.documentListeners.visibilitychange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getCount, beforeOldEvent + 1, "returning to a visible page should refresh immediately");
    assert.equal(harness.board.getState().matchId, 2);
});

test("repeated identical board initialization creates at most one matchmaking request", async () => {
    let createCount = 0;
    const createResponse = deferred();
    const harness = createBoardHarness(async (url, options) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/chess/create" && options.method === "POST") {
            createCount++;
            return createResponse.promise;
        }
        throw new Error("Unexpected initialization request: " + url);
    }, { search: "", iframe: true });

    const config = { mode: "ranked", rankedMode: "rapid", rankedStake: 0, timeControl: "10+0", tournamentMode: false };
    const first = harness.board.initializeBoard(config);
    const duplicate = harness.board.initializeBoard(config);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(createCount, 1);
    createResponse.resolve(responseFor({ success: true, match: browserMatch(990) }));
    await Promise.all([first, duplicate]);
    await harness.board.initializeBoard(config);
    assert.equal(createCount, 1);
    assert.equal(harness.sockets.length, 1);
    assert.equal(harness.board.getState().matchId, 990);
});

test("piece selection calculates legal hints locally without a legal-moves API request", async t => {
    let requests = 0;
    const harness = createBoardHarness(async url => {
        requests++;
        throw new Error("Piece selection should not make a request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));

    const selectionSamples = [];
    for (let index = 0; index < 30; index++) {
        const startedAt = performance.now();
        harness.board.selectPiece("e2");
        selectionSamples.push(performance.now() - startedAt);
    }
    assert.equal(harness.board.getSelectedSquare(), "e2");
    assert.deepEqual(harness.board.getLegalTargets().map(move => move.to), ["e3", "e4"]);
    assert.equal(requests, 0);
    t.diagnostic("Local legal selection/highlighting (30 samples, chess.js + mocked DOM; no network or browser paint): p50 " + latencyPercentile(selectionSamples, 0.5).toFixed(3) + " ms, p95 " + latencyPercentile(selectionSamples, 0.95).toFixed(3) + " ms.");
});

test("local rules cover castling, en passant, check safety and all promotion choices", async () => {
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            const body = JSON.parse(options.body);
            assert.equal(body.promotion, "n");
            const promoted = browserMatch(1, "1. a8=N+");
            promoted.fen = "N3k3/8/8/8/8/8/8/4K3 b - - 0 1";
            promoted.pgn = pgnAfterMoves(position.fen, [{ from: "a7", to: "a8", promotion: "n" }]);
            promoted.activeColor = "b";
            return responseFor({ success: true, match: promoted });
        }
        throw new Error("Unexpected chess rules request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);

    const position = browserMatch(1);
    position.fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    harness.board.applyState(position);
    harness.board.selectPiece("e1");
    assert.ok(harness.board.getLegalTargets().some(move => move.to === "g1"), "kingside castle should be legal");
    assert.ok(harness.board.getLegalTargets().some(move => move.to === "c1"), "queenside castle should be legal");

    position.fen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
    harness.board.applyState(position);
    harness.board.selectPiece("e5");
    const enPassant = harness.board.getLegalTargets().find(move => move.to === "d6");
    assert.ok(enPassant);
    assert.equal(enPassant.capture, true);

    position.fen = "4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1";
    harness.board.applyState(position);
    harness.board.selectPiece("e2");
    assert.ok(harness.board.getLegalTargets().every(move => move.to[0] === "e"), "pinned rook cannot expose the king on another file");

    position.fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    harness.board.applyState(position);
    harness.board.selectPiece("a7");
    assert.equal(harness.board.getLegalTargets().filter(move => move.to === "a8").map(move => move.promotion).sort().join(","), "b,n,q,r");
    harness.board.clickSquare("a8");
    assert.equal(harness.board.getPendingPromotion().from, "a7");
    assert.equal(harness.board.getPendingPromotion().to, "a8");
    await harness.board.choosePromotion("n");
    assert.equal(harness.board.getState().fen, "N3k3/8/8/8/8/8/8/4K3 b - - 0 1", "the confirmed server state should update the board");
});

test("checkmate is recognized locally and the confirmed server result updates the board", async () => {
    const local = new BrowserChess("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
    const matingMove = local.moves({ square: "g6", verbose: true }).find(move => move.to === "g7");
    assert.equal(matingMove.san, "Qg7#");
    local.move({ from: "g6", to: "g7" });
    assert.equal(local.isCheckmate(), true);

    const confirmed = browserMatch(1, "1. Qg7#");
    confirmed.pgn = local.pgn();
    confirmed.fen = local.fen();
    confirmed.status = "completed";
    confirmed.result = "white_win";
    confirmed.winnerId = 41;
    confirmed.activeColor = "b";
    const harness = createBoardHarness(async (_url, options = {}) => {
        assert.equal(options.method, "POST");
        return responseFor({ success: true, match: confirmed });
    }, { search: "" });
    harness.board.setMatchId(1);
    const before = browserMatch(1);
    before.fen = "7k/8/5KQ1/8/8/8/8/8 w - - 0 1";
    harness.board.applyState(before);
    assert.equal(await harness.board.sendMove("g6", "g7"), true);
    assert.equal(harness.board.getState().status, "completed");
    assert.equal(harness.board.getState().result, "white_win");
});

test("illegal moves are rejected locally and checked positions expose only king-safe moves", async () => {
    let posts = 0;
    const harness = createBoardHarness(async (_url, options = {}) => {
        if (options.method === "POST") posts++;
        throw new Error("Illegal client moves must never be submitted");
    }, { search: "" });
    harness.board.setMatchId(1);
    const checked = browserMatch(1);
    checked.fen = "4r1k1/8/8/8/8/8/8/4K3 w - - 0 1";
    harness.board.applyState(checked);
    harness.board.selectPiece("e1");
    assert.ok(harness.board.getLegalTargets().length > 0);
    assert.ok(harness.board.getLegalTargets().every(move => move.to !== "e2"), "the king cannot move into the checking rook's attack");
    assert.match(harness.document.getElementById("gameStatus").textContent, /in check/i);

    const pinned = browserMatch(1);
    pinned.fen = "4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1";
    harness.board.applyState(pinned);
    harness.board.selectPiece("e2");
    assert.ok(harness.board.getLegalTargets().every(move => move.to[0] === "e"), "the pinned rook must stay on the king's file");
    assert.equal(await harness.board.sendMove("e2", "d2"), false);
    assert.equal(posts, 0);

    const start = browserMatch(1);
    harness.board.applyState(start);
    assert.equal(await harness.board.sendMove("e2", "e5"), false);
    assert.equal(posts, 0);
});

test("offline moves persist locally and restore after a simulated reload without claiming sync", async () => {
    const storage = new Map();
    let requests = 0;
    const first = createBoardHarness(async () => { requests++; throw new Error("backend offline"); }, { search: "", storage, online: false });
    first.board.setMatchId(1);
    first.board.applyState(browserMatch(1));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await first.board.sendMove("e2", "e4"), true);
    assert.equal(await first.board.sendMove("e7", "e5"), true);
    assert.equal(await first.board.sendMove("g1", "f3"), true);
    assert.equal(requests, 0, "offline turns should not retry failing API requests");
    const saved = JSON.parse(storage.get("goalGambitChessOffline:1"));
    assert.equal(saved.moves.length, 3);
    assert.equal(saved.moves[0].fenBefore, INITIAL_FEN);
    assert.equal(saved.moves[0].fenAfter, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    assert.equal(saved.moves[1].actorUserId, null, "opponent-side local continuation is evidence only");
    assert.equal(saved.sync.status, "pending");

    const reloaded = createBoardHarness(async () => { throw new Error("backend still offline"); }, { search: "", storage, online: false });
    reloaded.board.setMatchId(1);
    assert.equal(await reloaded.board.restoreOfflineMatch(1), true);
    assert.equal(reloaded.board.getState().fen, first.board.getState().fen);
    assert.equal(reloaded.board.getOfflineMode(), true);
    assert.match(reloaded.document.getElementById("connectionStatus").textContent, /opponent cannot see/i);
});

test("a single authenticated offline move syncs only after server acknowledgement", async () => {
    const storage = new Map();
    let movePosts = 0;
    const after = browserMatch(1, "1. e4");
    after.pgn = '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n1. e4 *';
    after.fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    after.activeColor = "b";
    const harness = createBoardHarness(async (url, options = {}) => {
        assert.ok(url.endsWith("/move"));
        assert.equal(options.method, "POST");
        movePosts++;
        return responseFor({ success: true, match: after });
    }, { search: "", storage, online: false });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    await new Promise(resolve => setImmediate(resolve));
    await harness.board.sendMove("e2", "e4");
    harness.setOnline(true);

    assert.equal(await harness.board.reconcileServerMatch(browserMatch(1)), true);
    assert.equal(movePosts, 1);
    assert.equal(harness.board.getState().fen, after.fen);
    await new Promise(resolve => setImmediate(resolve));
    const saved = await harness.board.readOfflineRecord(1);
    assert.equal(saved.sync.status, "synced");
    assert.equal(saved.moves[0].serverAcknowledged, true);
    assert.equal(harness.board.getOfflineMode(), false);
});

test("offline clock expiry is saved locally and remains unverified", async () => {
    const storage = new Map();
    let requests = 0;
    const expired = browserMatch(1);
    expired.whiteTimeMs = 0;
    const harness = createBoardHarness(async () => { requests++; throw new Error("offline requests should be deferred"); }, { search: "", storage, online: false });
    harness.board.setMatchId(1);
    harness.windowListeners.offline();
    assert.equal(harness.board.getOfflineMode(), true);
    harness.board.applyState(expired);
    await new Promise(resolve => setImmediate(resolve));
    harness.board.updateClocks();
    await new Promise(resolve => setImmediate(resolve));

    const saved = await harness.board.readOfflineRecord(1);
    assert.equal(requests, 0);
    assert.equal(harness.board.getState().status, "offline_pending");
    assert.equal(harness.board.getState().result, null, "a local timeout is not an official result");
    assert.equal(saved.claimedResult, "black_win");
    assert.equal(saved.sync.status, "awaiting-verification");

    const official = browserMatch(1);
    official.status = "completed";
    official.result = "black_win";
    official.winnerId = 42;
    assert.equal(await harness.board.reconcileServerMatch(official), true);
    const confirmed = await harness.board.readOfflineRecord(1);
    assert.equal(confirmed.sync.status, "synced");
    assert.equal(confirmed.latest.status, "completed");
});

test("server timeout acknowledgement does not mark an unaccepted local move as synced", async () => {
    const storage = new Map();
    const official = browserMatch(1);
    official.status = "completed";
    official.result = "black_win";
    official.winnerId = 42;
    let movePosts = 0;
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            movePosts++;
            return responseFor({ success: true, timeout: true, match: official });
        }
        throw new Error("Unexpected move recovery request: " + url);
    }, { search: "", storage, online: true });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await harness.board.sendMove("e2", "e4"), false);
    await new Promise(resolve => setImmediate(resolve));

    const saved = await harness.board.readOfflineRecord(1);
    assert.equal(movePosts, 1);
    assert.equal(harness.board.getState().status, "completed", "the authoritative server timeout is shown");
    assert.equal(saved.moves[0].serverAcknowledged, false);
    assert.equal(saved.sync.status, "conflict");
    assert.equal(saved.serverSnapshot.status, "completed");
    assert.equal(harness.board.getOfflineConflict(), true);
});

test("conflicting multi-move offline histories remain local and are never auto-submitted", async () => {
    const storage = new Map();
    let apiCalls = 0;
    const harness = createBoardHarness(async () => { apiCalls++; throw new Error("unexpected request"); }, { search: "", storage, online: false });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    await new Promise(resolve => setImmediate(resolve));
    await harness.board.sendMove("e2", "e4");
    await harness.board.sendMove("e7", "e5");
    const localFen = harness.board.getState().fen;
    harness.setOnline(true);

    assert.equal(await harness.board.reconcileServerMatch(browserMatch(1)), false);
    assert.equal(apiCalls, 0, "the unverifiable opponent move must not be submitted as the authenticated player");
    assert.equal(harness.board.getState().fen, localFen, "conflicting local evidence is preserved");
    assert.equal(harness.board.getOfflineMode(), true);
    assert.equal(harness.board.getOfflineConflict(), true);
    const saved = await harness.board.readOfflineRecord(1);
    assert.equal(saved.sync.status, "conflict");
});

test("move confirmation avoids a duplicate GET when an overlapping refresh already applied the same authoritative state", async t => {
    const postResponse = deferred();
    let postStarted;
    const started = new Promise(resolve => { postStarted = resolve; });
    let requests = 0;
    const harness = createBoardHarness(async (url, options = {}) => {
        requests++;
        if (url.endsWith("/move") && options.method === "POST") {
            postStarted();
            return postResponse.promise;
        }
        throw new Error("Unexpected move confirmation request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));

    const confirmed = browserMatch(1, "1. e4");
    confirmed.pgn = pgnAfterMoves(INITIAL_FEN, [{ from: "e2", to: "e4" }]);
    confirmed.fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    confirmed.activeColor = "b";
    const confirmation = harness.board.sendMove("e2", "e4");
    await started;
    // Model the opponent's event-triggered refresh winning the race with the
    // HTTP response and applying the same authoritative match snapshot first.
    harness.board.applyState(confirmed);
    postResponse.resolve(responseFor({ success: true, match: confirmed }));
    await confirmation;
    assert.equal(requests, 1, "the successful move response should not trigger a duplicate GET when state already matches");
    assert.equal(harness.board.getState().fen, confirmed.fen);
});

test("measures move-confirmation client processing separately from network latency", async t => {
    let requests = 0;
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            requests++;
            return responseFor({ success: true, match: confirmed });
        }
        throw new Error("Unexpected move benchmark request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);
    const confirmed = browserMatch(1, "1. e4");
    confirmed.pgn = pgnAfterMoves(INITIAL_FEN, [{ from: "e2", to: "e4" }]);
    confirmed.fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    confirmed.activeColor = "b";
    harness.board.applyState(browserMatch(1));

    const samples = [];
    for (let index = 0; index < 30; index++) {
        harness.board.applyState(browserMatch(1));
        const startedAt = performance.now();
        await harness.board.sendMove("e2", "e4");
        samples.push(performance.now() - startedAt);
    }
    assert.equal(requests, 30);
    assert.equal(harness.board.getState().fen, confirmed.fen);
    t.diagnostic("Move confirmation client path (30 samples, mocked immediate API; excludes network/server latency): p50 " + latencyPercentile(samples, 0.5).toFixed(3) + " ms, p95 " + latencyPercentile(samples, 0.95).toFixed(3) + " ms.");
});

test("move confirmation refreshes when the board already advanced beyond the HTTP response", async () => {
    const postResponse = deferred();
    let postStarted;
    const started = new Promise(resolve => { postStarted = resolve; });
    let getRequests = 0;
    const newer = browserMatch(1, "1. e4 e5");
    newer.pgn = pgnAfterMoves(INITIAL_FEN, [{ from: "e2", to: "e4" }, { from: "e7", to: "e5" }]);
    newer.fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            postStarted();
            return postResponse.promise;
        }
        if (url.endsWith("/api/chess/1")) {
            getRequests++;
            return responseFor({ success: true, match: newer });
        }
        throw new Error("Unexpected racing move request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));

    const confirmed = browserMatch(1, "1. e4");
    confirmed.pgn = pgnAfterMoves(INITIAL_FEN, [{ from: "e2", to: "e4" }]);
    confirmed.fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    confirmed.activeColor = "b";
    const confirmation = harness.board.sendMove("e2", "e4");
    await started;
    harness.board.applyState(newer);
    postResponse.resolve(responseFor({ success: true, match: confirmed }));
    await confirmation;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(getRequests, 1, "a follow-up GET is needed when an already-applied state differs from the move response");
    assert.equal(harness.board.getState().pgn, newer.pgn, "the more recent authoritative state must be retained");
});
