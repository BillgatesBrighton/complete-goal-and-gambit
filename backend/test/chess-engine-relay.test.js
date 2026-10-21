"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
        resultingFen: AFTER_E4,
        check: false,
        checkmate: false,
        stalemate: false,
        draw: false
    });
    const response = browser.latest("chess:engine:result").payload;
    assert.equal(response.agreesWithServer, true);
    assert.equal(response.source, "android-native-chess-engine");
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
