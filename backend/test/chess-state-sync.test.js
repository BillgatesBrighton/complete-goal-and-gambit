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

async function startChessApi(pool, io, userId = 41, pushService) {
    const app = express();
    app.use(express.json());
    const routePool = Object.create(pool);
    if (typeof pool.query !== "function") {
        routePool.query = async function (sql) {
            if (String(sql).includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            throw new Error("Unexpected top-level SQL in test: " + String(sql).slice(0, 120));
        };
    }
    app.use("/api/chess", chessRoutes(routePool, (req, _res, next) => {
        req.user = { userId };
        next();
    }, io, pushService));
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

test("move attempts are rate-limited per authenticated account before taking match locks", async t => {
    const pool = {
        async query(sql) {
            if (String(sql).includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            throw new Error("Malformed moves should not query the database.");
        },
        async connect() { throw new Error("Malformed moves should not acquire a match lock."); }
    };
    const api = await startChessApi(pool);
    t.after(api.close);

    const sendInvalidMove = () => fetch(api.base + "/501/move", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "bad", to: "e4" })
    });
    for (let index = 0; index < 30; index++) assert.equal((await sendInvalidMove()).status, 400);
    const limited = await sendInvalidMove();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("authoritative move position restores PGN history for threefold repetition and rejects mismatched history", () => {
    const history = new BrowserChess(INITIAL_FEN);
    for (const san of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) history.move(san);
    assert.equal(new BrowserChess(history.fen()).isThreefoldRepetition(), false, "FEN alone cannot establish prior repetitions");

    const restored = chessRoutes.createMatchPosition({ fen: history.fen(), pgn: history.pgn() });
    assert.ok(restored);
    assert.equal(restored.fen(), history.fen());
    assert.equal(restored.isThreefoldRepetition(), true, "the authoritative state should retain the repeated-position history");
    assert.equal(chessRoutes.createMatchPosition({ fen: INITIAL_FEN, pgn: history.pgn() }), null,
        "a PGN that does not match the stored FEN must not be used to validate a move");
});

test("authoritative chess rules accept castling, en passant, and promotion and identify terminal positions", () => {
    const specialMoves = [
        { name: "castling", fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", move: { from: "e1", to: "g1" }, flag: "k" },
        { name: "en passant", fen: "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3", move: { from: "e5", to: "d6" }, flag: "e" },
        { name: "knight promotion", fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", move: { from: "a7", to: "a8", promotion: "n" }, flag: "p" }
    ];
    for (const scenario of specialMoves) {
        const position = chessRoutes.createMatchPosition({ fen: scenario.fen, pgn: "" });
        const move = position && position.move(scenario.move);
        assert.ok(move, scenario.name + " must be legal on the authoritative rules engine");
        assert.ok(move.flags.includes(scenario.flag), scenario.name + " must retain its special-move semantics");
    }

    const mate = chessRoutes.createMatchPosition({ fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", pgn: "" });
    assert.ok(mate.move({ from: "f7", to: "g7" }));
    assert.equal(mate.isCheckmate(), true, "the server rules engine must identify checkmate after a legal move");

    const stalemate = chessRoutes.createMatchPosition({ fen: "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1", pgn: "" });
    assert.equal(stalemate.isStalemate(), true);
    assert.equal(stalemate.isDraw(), true);
});

test("successful move response reuses its verified position and move for check and last-move state", () => {
    const match = matchRow({ pgn: "malformed legacy history" });
    const verifiedPosition = {
        fen: () => match.fen,
        isCheck: () => true,
        turn: () => "b",
        board: () => Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, col) =>
            row === 0 && col === 7 ? { type: "k", color: "b" } : null))
    };
    const state = chessRoutes.publicMatchState(match, 41, verifiedPosition, { from: "e2", to: "e4" });
    assert.equal(state.checkSquare, "h8", "the checked king square comes from the already-verified engine position");
    assert.deepEqual(state.lastMove, { from: "e2", to: "e4" }, "the accepted move is reused instead of replaying PGN");
});

test("reused move-response calculation matches the normal public match state", () => {
    const position = new BrowserChess(INITIAL_FEN);
    position.move({ from: "e2", to: "e4" });
    position.move({ from: "e7", to: "e5" });
    const match = matchRow({ fen: position.fen(), pgn: position.pgn(), active_color: position.turn() });
    const acceptedMove = position.history({ verbose: true }).at(-1);
    assert.deepEqual(
        chessRoutes.publicMatchState(match, 41, position, acceptedMove),
        chessRoutes.publicMatchState(match, 41),
        "reusing the verified engine must preserve the response fields and values"
    );
});

test("successive authoritative moves retain the existing PGN history", async t => {
    let current = matchRow();
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) return { rows: [current] };
            throw new Error("Unexpected top-level SQL in PGN history test: " + text.slice(0, 120));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
                    if (text === "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE") return { rows: [current] };
                    if (text.startsWith("UPDATE chess_matches SET fen=$1")) {
                        current = matchRow({
                            fen: params[0], pgn: params[1], white_time_ms: params[2], black_time_ms: params[3],
                            active_color: params[4], last_move_at: new Date(), status: params[5] ? "settling" : "active",
                            result: params[5], winner_id: params[6]
                        });
                        return { rows: [] };
                    }
                    throw new Error("Unexpected transaction SQL in PGN history test: " + text.slice(0, 120));
                },
                release() {}
            };
        }
    };
    const whiteApi = await startChessApi(pool, null, 41);
    const blackApi = await startChessApi(pool, null, 42);
    t.after(async () => { await Promise.all([whiteApi.close(), blackApi.close()]); });

    const play = (api, move) => fetch(api.base + "/501/move", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(move)
    });
    const whiteMove = { from: "e2", to: "e4", expectedFen: current.fen, expectedPly: 0 };
    const white = await play(whiteApi, whiteMove);
    assert.equal(white.status, 200);
    const replay = await play(whiteApi, whiteMove);
    assert.equal(replay.status, 409, "the exact request replay must not be applied to the updated position");
    assert.equal(current.active_color, "b");
    const black = await play(blackApi, { from: "e7", to: "e5", expectedFen: current.fen, expectedPly: 1 });
    const body = await black.json();
    assert.equal(black.status, 200);
    const replayed = new BrowserChess();
    replayed.loadPgn(body.match.pgn);
    assert.equal(body.match.pgn.includes("e4"), true);
    assert.equal(body.match.pgn.includes("e5"), true);
    assert.equal(replayed.fen(), body.match.fen, "stored PGN must describe the authoritative board position");
});

test("simultaneous same-position move requests serialize and only one can advance the match", async t => {
    let current = matchRow();
    let updates = 0;
    let lockTail = Promise.resolve();
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) return { rows: [current] };
            throw new Error("Unexpected simultaneous-move read: " + text.slice(0, 120));
        },
        async connect() {
            let unlock = null;
            const releaseLock = () => {
                if (!unlock) return;
                const release = unlock;
                unlock = null;
                release();
            };
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    if (text === "BEGIN") return { rows: [] };
                    if (text === "COMMIT" || text === "ROLLBACK") {
                        releaseLock();
                        return { rows: [] };
                    }
                    if (text === "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE") {
                        const previous = lockTail;
                        let releaseTail;
                        lockTail = new Promise(resolve => { releaseTail = resolve; });
                        await previous;
                        unlock = releaseTail;
                        return { rows: [current] };
                    }
                    if (text.startsWith("UPDATE chess_matches SET fen=$1")) {
                        updates++;
                        current = matchRow({
                            fen: params[0], pgn: params[1], white_time_ms: params[2], black_time_ms: params[3],
                            active_color: params[4], last_move_at: new Date(), status: params[5] ? "settling" : "active",
                            result: params[5], winner_id: params[6]
                        });
                        return { rows: [] };
                    }
                    throw new Error("Unexpected simultaneous-move write: " + text.slice(0, 120));
                },
                release: releaseLock
            };
        }
    };
    const api = await startChessApi(pool, null, 41);
    t.after(api.close);
    const expected = { expectedFen: current.fen, expectedPly: 0 };
    const submit = (from, to) => fetch(api.base + "/501/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...expected, from, to })
    });

    const responses = await Promise.all([submit("e2", "e4"), submit("d2", "d4")]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(updates, 1, "only the transaction holding the current row position may write a move");
    assert.equal(current.active_color, "b");
});

test("a successful chess move queues a private turn alert for only the opponent without using the eFootball match id column", async t => {
    let current = matchRow();
    const notifications = [];
    let resolveQueued;
    const queued = new Promise(resolve => { resolveQueued = resolve; });
    let connections = 0;
    const pool = {
        async query(sql) {
            const text = String(sql);
            if (text.includes("SELECT id FROM chess_matches WHERE player_black_id")) return { rows: [] };
            if (text.includes("FROM chess_matches m")) return { rows: [current] };
            throw new Error("Unexpected top-level SQL in chess notification test: " + text.slice(0, 120));
        },
        async connect() {
            connections++;
            if (connections === 1) {
                return {
                    async query(sql, params) {
                        const text = String(sql).trim();
                        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
                        if (text === "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE") return { rows: [current] };
                        if (text.startsWith("UPDATE chess_matches SET fen=$1")) {
                            current = matchRow({ fen: params[0], pgn: params[1], white_time_ms: params[2], black_time_ms: params[3], active_color: params[4], last_move_at: new Date() });
                            return { rows: [] };
                        }
                        throw new Error("Unexpected chess move query: " + text.slice(0, 120));
                    },
                    release() {}
                };
            }
            return {
                async query(sql) {
                    const text = String(sql).trim();
                    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT chess_push_0|RELEASE SAVEPOINT chess_push_0)$/.test(text)) return { rows: [] };
                    throw new Error("Unexpected chess notification transaction query: " + text);
                },
                release() {}
            };
        }
    };
    const pushService = {
        async enqueueNotification(_client, userId, notification) {
            notifications.push({ userId, notification });
            resolveQueued();
            return { created: true };
        }
    };
    const api = await startChessApi(pool, null, 41, pushService);
    t.after(api.close);

    const response = await fetch(api.base + "/501/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "e2", to: "e4", fen: "forged", pgn: "1. Qh5#", whiteTimeMs: 1, result: "white_win", winnerId: 41 })
    });
    assert.equal(response.status, 200);
    const authoritative = await response.json();
    assert.equal(authoritative.match.result, null, "client-supplied winner claims are ignored");
    assert.equal(authoritative.match.winnerId, null, "the server determines the official winner");
    assert.equal(authoritative.match.status, "active");
    assert.notEqual(authoritative.match.whiteTimeMs, 1, "client-supplied clocks are ignored");
    await Promise.race([queued, new Promise(resolve => setTimeout(resolve, 250))]);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].userId, 42);
    assert.equal(notifications[0].notification.eventKey, "chess-match:501:turn:1");
    assert.equal(notifications[0].notification.matchId, undefined, "chess IDs must not enter the existing eFootball-only push match_id column");
    assert.equal(notifications[0].notification.androidOnly, true);
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
        this.attributes = {};
        this.style = {};
        this.listeners = {};
        this.disabled = false;
        this.hidden = false;
        this.appendCount = 0;
        this.textWriteCount = 0;
        this._className = "";
        this._textContent = "";
        this._innerHTML = "";
        this.classList = {
            add: (...names) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(name => classes.add(name)); this.className = [...classes].join(" "); },
            remove: (...names) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(name => classes.delete(name)); this.className = [...classes].join(" "); },
            toggle: (name, force) => { const present = this.classList.contains(name); const next = force === undefined ? !present : Boolean(force); if (next) this.classList.add(name); else this.classList.remove(name); return next; },
            contains: name => this.className.split(/\s+/).includes(name)
        };
    }
    get className() { return this._className; }
    set className(value) { this._className = String(value || ""); }
    get textContent() { return this._textContent; }
    set textContent(value) { this._textContent = String(value ?? ""); this.textWriteCount++; this.children = []; }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) { this._innerHTML = String(value ?? ""); if (this._innerHTML === "") this.children = []; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    appendChild(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); this.children.push(child); child.parentElement = this; child.parentNode = this; this.appendCount++; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    focus() {}
    setPointerCapture(pointerId) { this.pointerCapture = pointerId; }
    releasePointerCapture(pointerId) { if (this.pointerCapture === pointerId) this.pointerCapture = null; }
    hasPointerCapture(pointerId) { return this.pointerCapture === pointerId; }
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

function createBoardHarness(fetchImpl, { search = "?matchId=1", iframe = false, storage = new Map(), online = true, clock = { now: () => globalThis.performance.now() }, indexedDB = null } = {}) {
    const elements = new Map();
    const documentListeners = {};
    const windows = [];
    const windowListeners = {};
    const delays = [];
    const document = {
        hidden: false,
        getElementById(id) { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
        createElement() { return new FakeElement(); },
        elementFromPoint() { return null; },
        addEventListener(name, callback) { documentListeners[name] = callback; }
    };
    const windowObject = {
        GG_API_BASE: "https://api.test",
        performance: clock,
        indexedDB,
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
    vm.runInContext(source + "\n;globalThis.__boardTest={loadMatch,applyState,setMatchId,setupSocket,scheduleMatchPolling,initializeBoard,selectPiece,clickSquare,choosePromotion,sendMove,updateClocks,renderBoard,currentRulesPosition,restoreOfflineMatch,reconcileServerMatch,readOfflineRecord,handleBoardPointerDown:typeof handleBoardPointerDown===\"function\"?handleBoardPointerDown:()=>{},handleBoardPointerMove:typeof handleBoardPointerMove===\"function\"?handleBoardPointerMove:()=>{},handleBoardPointerUp:typeof handleBoardPointerUp===\"function\"?handleBoardPointerUp:()=>{},handleBoardPointerCancel:typeof handleBoardPointerCancel===\"function\"?handleBoardPointerCancel:()=>{},getState:()=>state,getSocket:()=>socket,getSelectedSquare:()=>selectedSquare,getLegalTargets:()=>legalTargets,getPendingPromotion:()=>pendingPromotion,getOfflineMode:()=>offlineMode,getOfflineConflict:()=>offlineConflict,getRemaining:remaining,getBoardSquares:typeof boardSquares===\"undefined\"?()=>new Map():()=>boardSquares,getSyncQueueCount:()=>typeof moveSyncQueues===\"undefined\"?0:moveSyncQueues.size,getPendingMovePersistence:()=>typeof pendingMovePersistence===\"undefined\"?0:pendingMovePersistence};", context);
    return { board: context.__boardTest, document, elements, documentListeners, windowListeners, sockets: windows, delays, storage, clock, setOnline(value) { context.navigator.onLine = value; } };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function delayedIndexedDb(delayMs = 35) {
    const records = new Map();
    const database = {
        objectStoreNames: { contains: () => true },
        transaction(_storeName, mode) {
            const transaction = { oncomplete: null, onerror: null, onabort: null, error: null };
            transaction.objectStore = () => ({
                get(key) {
                    const request = { result: records.get(Number(key)) || null, onsuccess: null, onerror: null, error: null };
                    setTimeout(() => request.onsuccess?.(), delayMs);
                    return request;
                },
                put(record) {
                    records.set(Number(record.matchId), structuredClone(record));
                    setTimeout(() => transaction.oncomplete?.(), delayMs);
                }
            });
            return transaction;
        }
    };
    return { records, open() { const request = { result: database, onsuccess: null, onerror: null, onblocked: null }; queueMicrotask(() => request.onsuccess?.()); return request; } };
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

test("rules position is reused for repeated selection and invalidated by a changed match position", () => {
    const harness = createBoardHarness(async () => { throw new Error("Local rules lookup must not make requests"); }, { search: "" });
    harness.board.setMatchId(1);
    const opening = browserMatch(1);
    harness.board.applyState(opening);

    const initialPosition = harness.board.currentRulesPosition();
    for (let index = 0; index < 10; index++) harness.board.selectPiece("e2");
    assert.equal(harness.board.currentRulesPosition(), initialPosition, "selection must reuse the already-validated chess.js position");

    const moved = new BrowserChess(INITIAL_FEN);
    moved.move({ from: "e2", to: "e4" });
    const afterMove = browserMatch(1, moved.pgn());
    afterMove.fen = moved.fen();
    afterMove.activeColor = "b";
    harness.board.applyState(afterMove);
    const updatedPosition = harness.board.currentRulesPosition();
    assert.notEqual(updatedPosition, initialPosition, "a changed FEN/PGN must rebuild the rules position");
    assert.equal(updatedPosition.fen(), afterMove.fen);
});

test("board updates reuse the same accessible squares and click handlers", () => {
    const harness = createBoardHarness(async () => { throw new Error("Rendering must not make requests"); }, { search: "" });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    const board = harness.document.getElementById("chessBoard");
    const initialNodes = board.children.slice();
    const initialHandlers = initialNodes.map(square => square.listeners.click);
    const initialAppends = board.appendCount;

    harness.board.selectPiece("e2");
    harness.board.renderBoard();

    assert.equal(board.children.length, 64);
    assert.equal(board.appendCount, initialAppends, "ordinary updates must not detach and rebuild board squares");
    assert.deepEqual(board.children, initialNodes, "all 64 square elements should retain their identity and order");
    assert.deepEqual(board.children.map(square => square.listeners.click), initialHandlers, "rendering must not add or replace per-square click handlers");
    assert.match(harness.board.getBoardSquares().get("e2").element.getAttribute("aria-label"), /e2 white p/);
    assert.ok(harness.board.getBoardSquares().get("e2").element.classList.contains("selected"));
    assert.ok(harness.board.getBoardSquares().get("e4").element.classList.contains("possible-move"));
});

test("measures synchronous local move response separately from storage and network", async t => {
    const harness = createBoardHarness(async () => { throw new Error("Offline local benchmark must not call the backend"); }, { search: "", online: false });
    harness.board.setMatchId(1);
    const expected = new BrowserChess(INITIAL_FEN);
    expected.move({ from: "e2", to: "e4" });
    const samples = [];
    for (let index = 0; index < 30; index++) {
        harness.board.applyState(browserMatch(1));
        const startedAt = performance.now();
        const pendingSync = harness.board.sendMove("e2", "e4");
        samples.push(performance.now() - startedAt);
        assert.equal(harness.board.getState().fen, expected.fen(), "the local board must update before the persistence promise resolves");
        await pendingSync;
    }
    t.diagnostic("Synchronous legal move-to-board update (30 samples, mocked DOM; excludes storage/network): p50 " + latencyPercentile(samples, 0.5).toFixed(3) + " ms, p95 " + latencyPercentile(samples, 0.95).toFixed(3) + " ms.");
});

test("pointer dragging selects locally and makes the dropped legal move immediately", async () => {
    const harness = createBoardHarness(async () => { throw new Error("Offline drag must not submit a request"); }, { search: "", online: false });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    const squares = harness.board.getBoardSquares();
    let prevented = false;
    harness.board.handleBoardPointerDown({ target: squares.get("e2").element, pointerId: 7, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    harness.board.handleBoardPointerMove({ target: harness.document.getElementById("chessBoard"), pointerId: 7, clientX: 40, clientY: 40, preventDefault() { prevented = true; } });
    harness.document.elementFromPoint = () => squares.get("e4").element;
    harness.board.handleBoardPointerUp({ target: harness.document.getElementById("chessBoard"), pointerId: 7, clientX: 100, clientY: 100 });

    const local = new BrowserChess(INITIAL_FEN);
    local.move({ from: "e2", to: "e4" });
    assert.equal(prevented, true, "pointer movement should be captured only after crossing the drag threshold");
    assert.equal(harness.board.getState().fen, local.fen(), "the board should change on drop without waiting for local storage");
    assert.equal(harness.board.getState().activeColor, "b");
    await new Promise(resolve => setImmediate(resolve));
});

test("local board paints before delayed recovery storage and guards against unloading an unwritten move", async () => {
    const indexedDB = delayedIndexedDb(30);
    let posts = 0;
    const confirmed = new BrowserChess(INITIAL_FEN);
    confirmed.move({ from: "e2", to: "e4" });
    const serverState = browserMatch(1, confirmed.pgn());
    serverState.fen = confirmed.fen();
    serverState.activeColor = "b";
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") { posts++; return responseFor({ success: true, match: serverState }); }
        throw new Error("Unexpected delayed storage request: " + url);
    }, { search: "", indexedDB });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));

    const moveCompletion = harness.board.sendMove("e2", "e4");
    assert.equal(harness.board.getState().fen, confirmed.fen(), "local position should update in the same interaction turn");
    assert.equal(harness.board.getPendingMovePersistence(), 1);
    assert.equal(posts, 0, "network sync should wait for the durable local recovery write");
    let prompted = false;
    const unloadEvent = { preventDefault() { prompted = true; }, returnValue: undefined };
    harness.windowListeners.beforeunload(unloadEvent);
    assert.equal(prompted, true, "the browser should warn if a move could be lost by an immediate reload");

    assert.equal(await moveCompletion, true);
    assert.equal(posts, 1);
    assert.equal(harness.board.getPendingMovePersistence(), 0);
    prompted = false;
    harness.windowListeners.beforeunload({ preventDefault() { prompted = true; }, returnValue: undefined });
    assert.equal(prompted, false, "a fully persisted move should not block normal navigation");
});

test("recovery persistence failure is visible and prevents sending an unrecorded move", async () => {
    const indexedDB = { open() { const request = { result: null, onsuccess: null, onerror: null, onblocked: null, error: new Error("IndexedDB unavailable") }; queueMicrotask(() => request.onerror?.()); return request; } };
    const harness = createBoardHarness(async () => { throw new Error("An unrecorded move must never reach the backend"); }, { search: "", indexedDB });
    const originalSet = harness.storage.set.bind(harness.storage);
    harness.storage.set = (key, value) => {
        if (String(key).startsWith("goalGambitChessOffline:")) throw new Error("Local storage unavailable");
        return originalSet(key, value);
    };
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    const pending = harness.board.sendMove("e2", "e4");
    const expected = new BrowserChess(INITIAL_FEN);
    expected.move({ from: "e2", to: "e4" });
    assert.equal(harness.board.getState().fen, expected.fen(), "the attempted move remains visible immediately");
    assert.equal(await pending, false);
    assert.match(harness.document.getElementById("connectionStatus").textContent, /could not save this move/i);
    assert.match(harness.document.getElementById("gameStatus").textContent, /recovery storage failed/i);
});

test("displayed bullet clock uses monotonic elapsed time and skips unchanged text writes", () => {
    let now = 500;
    const clock = { now: () => now };
    const harness = createBoardHarness(async () => { throw new Error("Clock display must not make requests"); }, { search: "", clock });
    harness.board.setMatchId(1);
    const position = browserMatch(1);
    position.timeControl = "1+0";
    position.whiteTimeMs = 6000;
    position.blackTimeMs = 6000;
    harness.board.applyState(position);
    const whiteClock = harness.document.getElementById("whiteClock");
    const firstWriteCount = whiteClock.textWriteCount;

    now = 650;
    harness.board.updateClocks();
    assert.equal(whiteClock.textWriteCount, firstWriteCount, "sub-second timer ticks should not rewrite an unchanged display");
    now = 1500;
    harness.board.updateClocks();
    assert.equal(whiteClock.textContent, "00:05", "elapsed clock time should follow performance.now even if wall time does not change");
    assert.equal(whiteClock.textWriteCount, firstWriteCount + 1);
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

test("optimistic local moves stay interactive while backend submissions remain ordered", async () => {
    const firstResponse = deferred();
    const secondResponse = deferred();
    let firstStarted;
    let secondStarted;
    const firstRequestStarted = new Promise(resolve => { firstStarted = resolve; });
    const secondRequestStarted = new Promise(resolve => { secondStarted = resolve; });
    const submitted = [];
    const harness = createBoardHarness(async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            submitted.push(JSON.parse(options.body));
            if (submitted.length === 1) { firstStarted(); return firstResponse.promise; }
            if (submitted.length === 2) { secondStarted(); return secondResponse.promise; }
        }
        throw new Error("Unexpected queued move request: " + url);
    }, { search: "" });
    harness.board.setMatchId(1);
    harness.board.applyState(browserMatch(1));
    await new Promise(resolve => setImmediate(resolve));

    const firstMove = harness.board.sendMove("e2", "e4");
    const afterWhite = new BrowserChess(INITIAL_FEN);
    afterWhite.move({ from: "e2", to: "e4" });
    assert.equal(harness.board.getState().fen, afterWhite.fen(), "the first move should render synchronously");
    assert.equal(await harness.board.sendMove("e7", "e5"), false, "turn enforcement must still reject a second move by white");
    await firstRequestStarted;
    assert.equal(submitted[0].expectedFen, INITIAL_FEN);
    assert.equal(submitted[0].expectedPly, 0, "the website should bind the move to the starting position and sequence");

    const afterBlack = new BrowserChess(INITIAL_FEN);
    afterBlack.move({ from: "e2", to: "e4" });
    afterBlack.move({ from: "e7", to: "e5" });
    const authoritativeAfterBlack = browserMatch(1, afterBlack.pgn());
    authoritativeAfterBlack.fen = afterBlack.fen();
    authoritativeAfterBlack.activeColor = "w";
    harness.board.applyState(authoritativeAfterBlack);
    harness.board.selectPiece("g1");
    assert.equal(harness.board.getSelectedSquare(), "g1", "a delayed earlier HTTP response must not block the next legitimate turn");

    const secondMove = harness.board.sendMove("g1", "f3");
    const afterKnight = new BrowserChess(INITIAL_FEN);
    afterKnight.move({ from: "e2", to: "e4" });
    afterKnight.move({ from: "e7", to: "e5" });
    afterKnight.move({ from: "g1", to: "f3" });
    assert.equal(harness.board.getState().fen, afterKnight.fen(), "the later legal move should also render immediately");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(submitted.length, 1, "the per-match queue must wait for the earlier response before posting the next move");

    const confirmedWhite = browserMatch(1, afterWhite.pgn());
    confirmedWhite.fen = afterWhite.fen();
    confirmedWhite.activeColor = "b";
    firstResponse.resolve(responseFor({ success: true, match: confirmedWhite }));
    await secondRequestStarted;
    assert.deepEqual(submitted.map(move => [move.from, move.to]), [["e2", "e4"], ["g1", "f3"]]);
    assert.equal(submitted[1].expectedFen, authoritativeAfterBlack.fen);
    assert.equal(submitted[1].expectedPly, 2, "the next move should use the latest authoritative position and ply");

    const confirmedKnight = browserMatch(1, afterKnight.pgn());
    confirmedKnight.fen = afterKnight.fen();
    confirmedKnight.activeColor = "b";
    secondResponse.resolve(responseFor({ success: true, match: confirmedKnight }));
    assert.deepEqual(await Promise.all([firstMove, secondMove]), [true, true]);
    assert.equal(harness.board.getState().fen, confirmedKnight.fen, "an older acknowledgement must not roll back the newer board state");
    await new Promise(resolve => setImmediate(resolve));
    const saved = await harness.board.readOfflineRecord(1);
    assert.ok(saved.moves.every(move => move.serverAcknowledged), "both ordered local records should retain their server acknowledgement");
});

test("two player boards exchange turns through authoritative match snapshots", async () => {
    const serverRules = new BrowserChess(INITIAL_FEN);
    let serverMatch = browserMatch(1);
    const serverStateFor = color => ({ ...serverMatch, playerColor: color });
    const createServerFetch = color => async (url, options = {}) => {
        if (url.endsWith("/move") && options.method === "POST") {
            const submitted = JSON.parse(options.body);
            assert.equal(serverRules.turn(), color, "the server mock should accept only the authoritative side to move");
            const move = serverRules.move({ from: submitted.from, to: submitted.to, promotion: submitted.promotion });
            assert.ok(move, "the server mock should reject illegal moves");
            serverMatch = { ...serverMatch, fen: serverRules.fen(), pgn: serverRules.pgn(), activeColor: serverRules.turn(), lastMove: { from: move.from, to: move.to } };
            return responseFor({ success: true, match: serverStateFor(color) });
        }
        if (url.endsWith("/api/chess/1")) return responseFor({ success: true, match: serverStateFor(color) });
        throw new Error("Unexpected two-board request: " + url);
    };
    const white = createBoardHarness(createServerFetch("w"), { search: "" });
    const blackStorage = new Map([["goalGambitUserId", "42"], ["goalGambitUsername", "black-player"]]);
    const black = createBoardHarness(createServerFetch("b"), { search: "", storage: blackStorage });
    white.board.setMatchId(1);
    black.board.setMatchId(1);
    white.board.applyState(serverStateFor("w"));
    black.board.applyState(serverStateFor("b"));

    assert.equal(await black.board.sendMove("e7", "e5"), false, "black cannot move while the authoritative turn is white");
    const whiteMove = white.board.sendMove("e2", "e4");
    const expectedAfterWhite = new BrowserChess(INITIAL_FEN);
    expectedAfterWhite.move({ from: "e2", to: "e4" });
    assert.equal(white.board.getState().fen, expectedAfterWhite.fen(), "white should see its local move immediately");
    assert.equal(await whiteMove, true);
    black.board.applyState(serverStateFor("b"));

    const blackMove = black.board.sendMove("e7", "e5");
    const expectedFinal = new BrowserChess(INITIAL_FEN);
    expectedFinal.move({ from: "e2", to: "e4" });
    expectedFinal.move({ from: "e7", to: "e5" });
    assert.equal(black.board.getState().fen, expectedFinal.fen(), "black should also see its move immediately");
    assert.equal(await blackMove, true);
    white.board.applyState(serverStateFor("w"));

    assert.equal(white.board.getState().fen, serverRules.fen());
    assert.equal(black.board.getState().fen, serverRules.fen());
    assert.equal(white.board.getState().pgn, black.board.getState().pgn);
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

test("move confirmation keeps a newer authoritative snapshot that already includes the move", async () => {
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

    assert.equal(getRequests, 0, "a newer authoritative snapshot already includes the submitted move, so another GET is redundant");
    assert.equal(harness.board.getState().pgn, newer.pgn, "the more recent authoritative state must be retained");
});
