"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const createChessEngineRelay = require("../services/chessEngineRelay");
const { Chess } = require("chess.js");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

class FakeSocket {
    constructor(id, userId, io) {
        this.id = id;
        this.user = { userId };
        this.io = io;
        this.handlers = new Map();
        this.outbound = [];
        this.chessEngineMatches = new Set();
        this.chessEngineReady = false;
        this.join(id);
    }
    on(event, handler) { this.handlers.set(event, handler); return this; }
    emit(event, payload) { this.outbound.push({ event, payload }); }
    join(room) {
        const members = this.io.rooms.get(room) || new Set();
        members.add(this.id);
        this.io.rooms.set(room, members);
    }
    async trigger(event, payload) {
        const handler = this.handlers.get(event);
        if (handler) return handler(payload);
    }
    latest(event) { return this.outbound.filter(item => item.event === event).at(-1); }
}

function fakeIo() {
    const io = { rooms: new Map(), sockets: { adapter: { rooms: null } }, socketsById: new Map() };
    io.sockets.adapter.rooms = io.rooms;
    io.to = room => ({
        emit(event, payload) {
            const ids = io.rooms.get(room) || new Set();
            for (const id of ids) io.socketsById.get(id)?.emit(event, payload);
        }
    });
    io.socket = (id, userId) => {
        const socket = new FakeSocket(id, userId, io);
        io.socketsById.set(id, socket);
        return socket;
    };
    return io;
}

function mockPool(match) {
    return {
        async query(sql, params) {
            if (/WHERE \(player_white_id = \$1 OR player_black_id = \$1\)/.test(sql)) {
                const userId = Number(params[0]);
                return { rows: [Number(match.player_white_id), Number(match.player_black_id)].includes(userId) ? [match] : [] };
            }
            assert.equal(Number(params[0]), Number(match.id));
            return { rows: [match] };
        }
    };
}

function e4Match() {
    const chess = new Chess();
    chess.move({ from: "e2", to: "e4" });
    return {
        id: 501,
        player_white_id: 10,
        player_black_id: 20,
        status: "active",
        result: null,
        fen: chess.fen(),
        pgn: chess.pgn(),
        active_color: chess.turn(),
        white_time_ms: 60000,
        black_time_ms: 60000,
        time_control: "1+1",
        elapsed_since_move_ms: 0
    };
}

test("authenticated native engine receives a server-confirmed move and returns an advisory result", async () => {
    const match = e4Match();
    const io = fakeIo();
    const relay = createChessEngineRelay(mockPool(match), io);
    const browser = io.socket("browser-1", 10);
    const nativeApp = io.socket("native-1", 10);
    relay.attachSocket(browser);
    relay.attachSocket(nativeApp);

    await nativeApp.trigger("chess:engine:ready");
    assert.equal(nativeApp.latest("chess:engine:matches").payload.success, true);
    await nativeApp.trigger("chess:engine:subscribe", { matchId: 501 });
    assert.equal(nativeApp.latest("chess:engine:snapshot").payload.fen, match.fen);

    await browser.trigger("chess:engine:move", {
        requestId: "gg-501-1-1000-test",
        matchId: 501,
        ply: 1,
        fenBefore: START,
        expectedFen: AFTER_E4,
        move: { from: "e2", to: "e4", promotion: null }
    });
    await browser.chessEngineRelayQueue;

    const relayed = nativeApp.latest("chess:engine:move").payload;
    assert.equal(relayed.matchId, 501);
    assert.equal(relayed.expectedFen, AFTER_E4);
    assert.equal(relayed.pgnBefore, "");
    assert.equal(relayed.clockIsCurrent, true);

    await nativeApp.trigger("chess:engine:result", {
        requestId: relayed.requestId,
        matchId: 501,
        ply: 1,
        legal: true,
        stale: false,
        historyComplete: true,
        agreesWithExpectedPosition: true,
        legalMoves: new Chess(AFTER_E4).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || "")),
        predictionCacheHit: true,
        resultingFen: AFTER_E4,
        check: false,
        checkmate: false,
        stalemate: false,
        draw: false
    });
    const response = browser.latest("chess:engine:result").payload;
    assert.equal(response.agreesWithServer, true);
    assert.equal(response.source, "android-native-chess-engine");
    assert.equal(response.legalMovesVerified, true);
    assert.equal(response.predictionCacheHit, true);
    assert.equal(response.positionVersion, 1);
    assert.equal(response.positionKey, crypto.createHash("sha256").update(AFTER_E4).digest("hex"));
    assert.deepEqual(response.legalMoves,
        new Chess(AFTER_E4).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || "")));
});

test("verified prediction hits are delivered only to the authenticated match room with exact position identity", async () => {
    const match = e4Match();
    const played = new Chess();
    played.move({ from: "e2", to: "e4" });
    played.move({ from: "e7", to: "e5" });
    match.fen = played.fen();
    match.pgn = played.pgn();
    match.active_color = played.turn();
    const io = fakeIo();
    const relay = createChessEngineRelay(mockPool(match), io);
    const moverBrowser = io.socket("browser-black", 20);
    const receiverBrowser = io.socket("browser-white", 10);
    const unrelatedBrowser = io.socket("browser-other-match", 77);
    moverBrowser.join("chess_match_501");
    receiverBrowser.join("chess_match_501");
    unrelatedBrowser.join("chess_match_999");
    const companion = io.socket("native-black", 20);
    relay.attachSocket(moverBrowser);
    relay.attachSocket(companion);
    await companion.trigger("chess:engine:ready");
    await companion.trigger("chess:engine:subscribe", { matchId: 501 });

    await moverBrowser.trigger("chess:engine:move", {
        requestId: "gg-501-2-1000-black",
        matchId: 501,
        ply: 2,
        fenBefore: AFTER_E4,
        expectedFen: played.fen(),
        move: { from: "e7", to: "e5", promotion: null }
    });
    await moverBrowser.chessEngineRelayQueue;
    const relayed = companion.latest("chess:engine:move").payload;
    await companion.trigger("chess:engine:result", {
        requestId: relayed.requestId,
        matchId: 501,
        ply: 2,
        legal: true,
        stale: false,
        historyComplete: true,
        agreesWithExpectedPosition: true,
        resultingFen: played.fen(),
        legalMoves: played.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || "")),
        predictionCacheHit: true
    });

    const prediction = receiverBrowser.latest("chess:engine:prediction").payload;
    assert.equal(prediction.fen, played.fen());
    assert.equal(prediction.positionVersion, 2);
    assert.equal(prediction.positionKey, crypto.createHash("sha256").update(played.fen()).digest("hex"));
    assert.equal(prediction.legalMovesVerified, true);
    assert.equal(prediction.predictionCacheHit, true);
    assert.equal(unrelatedBrowser.latest("chess:engine:prediction"), undefined);
});

test("authenticated companion integrity reports are checked against server history and trigger safe reconciliation", async () => {
    const match = e4Match();
    const io = fakeIo();
    const pauses = [];
    const relay = createChessEngineRelay(mockPool(match), io, {
        pauseForIntegrity: async matchId => pauses.push(matchId)
    });
    const app = io.socket("native-1", 10);
    relay.attachSocket(app);
    await app.trigger("chess:engine:ready");
    await app.trigger("chess:engine:subscribe", { matchId: 501 });
    const digest = value => crypto.createHash("sha256").update(value).digest("hex");
    await app.trigger("chess:engine:integrity_report", {
        matchId: 501, ply: 1, requestId: "snapshot-501-1", issue: "snapshot_mismatch",
        localPositionDigest: digest(START), serverPositionDigest: digest(AFTER_E4)
    });
    const ack = app.latest("chess:engine:integrity_ack").payload;
    assert.equal(ack.success, true);
    assert.equal(ack.serverConsistent, true);
    assert.equal(pauses.length, 0, "a client mismatch must not pause a server-consistent game");
    assert.equal(app.latest("chess:engine:snapshot").payload.fen, AFTER_E4,
        "the server sends its PGN-verified snapshot back for reconciliation");

    const corrupt = { ...match, fen: START, active_color: "w" };
    const corruptRelay = createChessEngineRelay(mockPool(corrupt), io, {
        pauseForIntegrity: async matchId => pauses.push(matchId)
    });
    const secondApp = io.socket("native-2", 20);
    corruptRelay.attachSocket(secondApp);
    await secondApp.trigger("chess:engine:ready");
    await secondApp.trigger("chess:engine:subscribe", { matchId: 501 });
    await secondApp.trigger("chess:engine:integrity_report", {
        matchId: 501, ply: 1, requestId: "snapshot-corrupt-501", issue: "position_mismatch",
        localPositionDigest: digest(START), serverPositionDigest: digest(AFTER_E4)
    });
    assert.deepEqual(pauses, [501], "only a server-side PGN/FEN inconsistency requests an official pause");
    assert.equal(secondApp.latest("chess:engine:integrity_ack").payload.serverConsistent, false);
});

test("relay rejects an account that is not the mover and never broadcasts private engine data", async () => {
    const match = e4Match();
    const io = fakeIo();
    const relay = createChessEngineRelay(mockPool(match), io);
    const intruderBrowser = io.socket("browser-intruder", 77);
    const whiteEngine = io.socket("native-white", 10);
    const blackEngine = io.socket("native-black", 20);
    relay.attachSocket(intruderBrowser);
    relay.attachSocket(whiteEngine);
    relay.attachSocket(blackEngine);
    await whiteEngine.trigger("chess:engine:ready");
    await whiteEngine.trigger("chess:engine:subscribe", { matchId: 501 });
    await blackEngine.trigger("chess:engine:ready");
    await blackEngine.trigger("chess:engine:subscribe", { matchId: 501 });

    await intruderBrowser.trigger("chess:engine:move", {
        requestId: "gg-501-1-1000-intruder",
        matchId: 501,
        ply: 1,
        fenBefore: START,
        expectedFen: AFTER_E4,
        move: { from: "e2", to: "e4" }
    });
    await intruderBrowser.chessEngineRelayQueue;
    assert.equal(whiteEngine.latest("chess:engine:move"), undefined);
    assert.equal(blackEngine.latest("chess:engine:move"), undefined);
    assert.equal(intruderBrowser.latest("chess:engine:result").payload.stale, true);
});

test("relay refuses a move that does not match the authenticated match history", async () => {
    const match = e4Match();
    const io = fakeIo();
    const relay = createChessEngineRelay(mockPool(match), io);
    const browser = io.socket("browser-1", 10);
    const nativeApp = io.socket("native-1", 10);
    relay.attachSocket(browser);
    relay.attachSocket(nativeApp);
    await nativeApp.trigger("chess:engine:ready");
    await nativeApp.trigger("chess:engine:subscribe", { matchId: 501 });

    await browser.trigger("chess:engine:move", {
        requestId: "gg-501-1-1000-wrongfen",
        matchId: 501,
        ply: 1,
        fenBefore: "8/8/8/8/8/8/4P3/4K2k w - - 0 1",
        expectedFen: AFTER_E4,
        move: { from: "e2", to: "e4" }
    });
    await browser.chessEngineRelayQueue;
    assert.equal(nativeApp.latest("chess:engine:move"), undefined);
    assert.equal(browser.latest("chess:engine:result").payload.stale, true);
});
