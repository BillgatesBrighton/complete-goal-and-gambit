"use strict";

const { Chess } = require("chess.js");

const MAX_PENDING = 1024;
const PENDING_TTL_MS = 15000;

function makeEngineRoom(userId, matchId) {
    return "chess_engine_" + Number(userId) + "_" + Number(matchId);
}

function getPositionAtPly(pgn, ply) {
    try {
        const played = new Chess();
        if (pgn) played.loadPgn(String(pgn));
        const history = played.history({ verbose: true });
        if (!Number.isInteger(ply) || ply < 0 || ply > history.length) return null;

        const position = new Chess();
        for (let index = 0; index < ply; index++) {
            const move = history[index];
            if (!position.move({ from: move.from, to: move.to, promotion: move.promotion })) return null;
        }
        return { fen: position.fen(), pgn: ply ? position.pgn() : "", history: history };
    } catch (_) {
        return null;
    }
}

function createChessEngineRelay(pool, io) {
    const pending = new Map();

    function prunePending() {
        const now = Date.now();
        for (const [requestId, item] of pending) {
            if (item.expiresAt <= now) pending.delete(requestId);
        }
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    }

    async function readMatch(matchId) {
        const result = await pool.query(
            `SELECT id, player_white_id, player_black_id, status, result, fen, pgn,
                    active_color, white_time_ms, black_time_ms, time_control,
                    last_move_at,
                    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - last_move_at)) * 1000)) AS elapsed_since_move_ms
               FROM chess_matches WHERE id = $1`,
            [matchId]
        );
        return result.rows[0] || null;
    }

    function snapshot(match) {
        const activeColor = match.active_color === "b" ? "b" : "w";
        const elapsed = match.status === "active" ? Number(match.elapsed_since_move_ms || 0) : 0;
        const white = Math.max(0, Number(match.white_time_ms || 0) - (activeColor === "w" ? elapsed : 0));
        const black = Math.max(0, Number(match.black_time_ms || 0) - (activeColor === "b" ? elapsed : 0));
        const ply = getPositionAtPly(match.pgn || "", 0) ?
            (Number(String(match.fen || "").split(/\s+/)[5]) - 1) * 2 + (activeColor === "b" ? 1 : 0) : 0;
        return {
            matchId: Number(match.id),
            status: match.status,
            fen: match.fen,
            pgn: match.pgn || "",
            ply: Number.isInteger(ply) && ply >= 0 ? ply : 0,
            activeColor: activeColor,
            timeControl: match.time_control || "",
            whiteTimeMs: white,
            blackTimeMs: black,
            clockSampledAtMs: Date.now()
        };
    }

    async function listPlayerMatches(userId) {
        const result = await pool.query(
            `SELECT id, player_white_id, player_black_id, status, result, fen, pgn,
                    active_color, white_time_ms, black_time_ms, time_control,
                    last_move_at,
                    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - last_move_at)) * 1000)) AS elapsed_since_move_ms
               FROM chess_matches
              WHERE (player_white_id = $1 OR player_black_id = $1)
                AND status IN ('waiting', 'active')
              ORDER BY id DESC
              LIMIT 20`,
            [userId]
        );
        return result.rows.map(snapshot);
    }

    function sendEngineStatus(userId, matchId, available) {
        if (!io) return;
        io.to("user_" + Number(userId)).emit("chess:engine:status", {
            matchId: Number(matchId),
            available: Boolean(available)
        });
    }

    function attachSocket(socket) {
        const userId = Number(socket.user && socket.user.userId);
        socket.chessEngineMatches = new Set();
        socket.chessEngineReady = false;

        socket.on("chess:engine:ready", async function () {
            if (!Number.isSafeInteger(userId) || userId <= 0) return;
            socket.chessEngineReady = true;
            socket.join("chess_engine_user_" + userId);
            try {
                socket.emit("chess:engine:matches", { success: true, matches: await listPlayerMatches(userId) });
            } catch (_) {
                socket.emit("chess:engine:matches", { success: false, matches: [] });
            }
        });

        socket.on("chess:engine:subscribe", async function (data) {
            const matchId = Number(data && data.matchId);
            if (!socket.chessEngineReady || !Number.isSafeInteger(matchId) || matchId <= 0) return;
            try {
                const match = await readMatch(matchId);
                if (!match || ![Number(match.player_white_id), Number(match.player_black_id)].includes(userId)) {
                    socket.emit("chess:engine:subscribe_error", { matchId: matchId, message: "This account is not a player in that match." });
                    return;
                }
                const room = makeEngineRoom(userId, matchId);
                socket.join(room);
                socket.chessEngineMatches.add(matchId);
                socket.emit("chess:engine:snapshot", snapshot(match));
                sendEngineStatus(userId, matchId, true);
            } catch (_) {
                socket.emit("chess:engine:subscribe_error", { matchId: matchId, message: "The chess position could not be loaded." });
            }
        });

        socket.on("chess:engine:watch", async function (data) {
            const matchId = Number(data && data.matchId);
            if (!Number.isSafeInteger(matchId) || matchId <= 0) return;
            try {
                const match = await readMatch(matchId);
                if (!match || ![Number(match.player_white_id), Number(match.player_black_id)].includes(userId)) return;
                const engineRoom = "chess_engine_user_" + userId;
                const clients = io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms.get(engineRoom);
                sendEngineStatus(userId, matchId, Boolean(clients && clients.size));
                if (clients && clients.size) {
                    io.to(engineRoom).emit("chess:engine:match_available", { matchId: matchId });
                }
            } catch (_) {
                sendEngineStatus(userId, matchId, false);
            }
        });

        socket.on("chess:engine:move", function (data) {
            socket.chessEngineRelayQueue = (socket.chessEngineRelayQueue || Promise.resolve())
                .then(() => relayMove(socket, userId, data))
                .catch(function () {
                    socket.emit("chess:engine:result", {
                        requestId: data && data.requestId,
                        matchId: Number(data && data.matchId) || 0,
                        available: false,
                        message: "Native chess validation is temporarily unavailable."
                    });
                });
        });

        socket.on("chess:engine:result", async function (data) {
            await receiveEngineResult(socket, userId, data).catch(function () {});
        });

        socket.on("chess:engine:resync", async function (data) {
            const matchId = Number(data && data.matchId);
            if (!socket.chessEngineReady || !socket.chessEngineMatches.has(matchId)) return;
            try {
                const match = await readMatch(matchId);
                if (match && [Number(match.player_white_id), Number(match.player_black_id)].includes(userId)) {
                    socket.emit("chess:engine:snapshot", snapshot(match));
                }
            } catch (_) {}
        });

        socket.on("disconnect", function () {
            for (const [requestId, item] of pending) {
                if (item.browserSocketId === socket.id) pending.delete(requestId);
            }
            const userRoom = "chess_engine_user_" + userId;
            setImmediate(function () {
                const clients = io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms.get(userRoom);
                if (!clients || !clients.size) {
                    for (const matchId of socket.chessEngineMatches) sendEngineStatus(userId, matchId, false);
                }
            });
        });
    }

    async function relayMove(socket, userId, data) {
        prunePending();
        const matchId = Number(data && data.matchId);
        const ply = Number(data && data.ply);
        const requestId = String(data && data.requestId || "");
        const move = data && data.move;
        if (!Number.isSafeInteger(matchId) || matchId <= 0 ||
            !Number.isInteger(ply) || ply <= 0 ||
            !/^[A-Za-z0-9:_-]{8,160}$/.test(requestId) ||
            !move || !/^[a-h][1-8]$/.test(String(move.from || "")) ||
            !/^[a-h][1-8]$/.test(String(move.to || "")) ||
            (move.promotion != null && !/^[qrbn]$/.test(String(move.promotion)))) {
            socket.emit("chess:engine:result", { requestId: requestId, matchId: matchId || 0, available: false, message: "Invalid engine request." });
            return;
        }
        if (pending.has(requestId)) return;

        const match = await readMatch(matchId);
        if (!match || !["active", "completed", "settling"].includes(match.status)) {
            socket.emit("chess:engine:result", { requestId: requestId, matchId: matchId, available: false, stale: true });
            return;
        }
        const whiteId = Number(match.player_white_id);
        const blackId = Number(match.player_black_id);
        const expectedActorId = ply % 2 === 1 ? whiteId : blackId;
        if (expectedActorId !== userId) {
            socket.emit("chess:engine:result", { requestId: requestId, matchId: matchId, available: false, stale: true });
            return;
        }

        const before = getPositionAtPly(match.pgn || "", ply - 1);
        const after = getPositionAtPly(match.pgn || "", ply);
        const confirmedMove = after && after.history[ply - 1];
        if (!before || !after || before.fen !== data.fenBefore || after.fen !== data.expectedFen ||
            !confirmedMove || confirmedMove.from !== move.from || confirmedMove.to !== move.to ||
            (confirmedMove.promotion || null) !== (move.promotion || null)) {
            socket.emit("chess:engine:result", { requestId: requestId, matchId: matchId, available: false, stale: true });
            return;
        }

        const eligibleUserIds = [whiteId, blackId];
        pending.set(requestId, {
            browserSocketId: socket.id,
            matchId: matchId,
            ply: ply,
            expectedFen: after.fen,
            eligibleUserIds: eligibleUserIds,
            expiresAt: Date.now() + PENDING_TTL_MS
        });

        const clockIsCurrent = match.fen === after.fen && match.status === "active";
        const engineRequest = {
            requestId: requestId,
            matchId: matchId,
            ply: ply,
            move: { from: move.from, to: move.to, promotion: move.promotion || null },
            fenBefore: before.fen,
            pgnBefore: before.pgn,
            expectedFen: after.fen,
            expectedPgn: after.pgn,
            activeColor: clockIsCurrent ? match.active_color : null,
            timeControl: match.time_control || "",
            whiteTimeMs: clockIsCurrent ? Math.max(0, Number(match.white_time_ms || 0) - (match.active_color === "w" ? Number(match.elapsed_since_move_ms || 0) : 0)) : null,
            blackTimeMs: clockIsCurrent ? Math.max(0, Number(match.black_time_ms || 0) - (match.active_color === "b" ? Number(match.elapsed_since_move_ms || 0) : 0)) : null,
            clockIsCurrent: clockIsCurrent
        };

        let recipients = 0;
        for (const recipientId of eligibleUserIds) {
            const room = makeEngineRoom(recipientId, matchId);
            const clients = io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms.get(room);
            if (clients && clients.size) {
                io.to(room).emit("chess:engine:move", engineRequest);
                recipients += clients.size;
            }
        }
        if (!recipients) {
            pending.delete(requestId);
            socket.emit("chess:engine:result", { requestId: requestId, matchId: matchId, ply: ply, available: false });
        }
    }

    async function receiveEngineResult(socket, userId, data) {
        prunePending();
        const requestId = String(data && data.requestId || "");
        const item = pending.get(requestId);
        if (!item || item.expiresAt <= Date.now() || !socket.chessEngineReady ||
            !socket.chessEngineMatches.has(item.matchId) || !item.eligibleUserIds.includes(userId)) return;

        const match = await readMatch(item.matchId);
        if (!match || !item.eligibleUserIds.includes(Number(match.player_white_id)) ||
            !item.eligibleUserIds.includes(Number(match.player_black_id))) {
            pending.delete(requestId);
            return;
        }
        const authoritativeAtPly = getPositionAtPly(match.pgn || "", item.ply);
        if (!authoritativeAtPly || authoritativeAtPly.fen !== item.expectedFen) {
            pending.delete(requestId);
            return;
        }

        pending.delete(requestId);
        const resultingFen = typeof data.resultingFen === "string" ? data.resultingFen : "";
        const response = {
            requestId: requestId,
            matchId: item.matchId,
            ply: item.ply,
            available: true,
            stale: data.stale === true,
            legal: data.legal === true,
            resultingFen: resultingFen,
            check: data.check === true,
            checkmate: data.checkmate === true,
            stalemate: data.stalemate === true,
            draw: data.draw === true,
            historyComplete: data.historyComplete === true,
            clockEstimate: data.clockEstimate && typeof data.clockEstimate === "object" ? data.clockEstimate : null,
            agreesWithServer: data.legal === true && resultingFen === item.expectedFen,
            source: "android-native-chess-engine"
        };
        io.to(item.browserSocketId).emit("chess:engine:result", response);
    }

    return { attachSocket: attachSocket };
}

module.exports = createChessEngineRelay;
module.exports.getPositionAtPly = getPositionAtPly;
