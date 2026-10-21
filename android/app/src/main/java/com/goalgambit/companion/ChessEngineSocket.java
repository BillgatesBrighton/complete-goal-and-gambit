package com.goalgambit.companion;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;
import io.socket.engineio.client.transports.Polling;
import io.socket.engineio.client.transports.WebSocket;

/** Authenticated, optional companion connection for native chess-state processing. */
final class ChessEngineSocket {
    interface StatusListener { void onStatus(String status); }

    private final String bearer;
    private final StatusListener statusListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService engineExecutor = Executors.newSingleThreadExecutor();
    private final NativeChessEngine engine = new NativeChessEngine();
    private final Set<Long> subscribedMatches = Collections.synchronizedSet(new HashSet<>());
    private volatile Socket socket;
    private volatile boolean closed;

    ChessEngineSocket(String bearer, StatusListener statusListener) {
        this.bearer = bearer;
        this.statusListener = statusListener;
    }

    void connect() {
        if (bearer == null || bearer.trim().isEmpty() || closed) return;
        try {
            IO.Options options = new IO.Options();
            options.auth = Collections.singletonMap("token", bearer);
            options.reconnection = true;
            options.reconnectionAttempts = Integer.MAX_VALUE;
            options.reconnectionDelay = 1000;
            options.reconnectionDelayMax = 10000;
            options.timeout = 10000;
            options.transports = new String[] { WebSocket.NAME, Polling.NAME };
            options.forceNew = true;

            Socket created = IO.socket(BuildConfig.API_BASE_URL.replaceAll("/+$", ""), options);
            socket = created;
            created.on(Socket.EVENT_CONNECT, args -> {
                subscribedMatches.clear();
                setStatus("Connected · syncing active chess matches");
                created.emit("chess:engine:ready");
            });
            created.on(Socket.EVENT_DISCONNECT, args -> {
                subscribedMatches.clear();
                setStatus("Offline · website chess keeps working with its local rules engine");
            });
            created.on(Socket.EVENT_CONNECT_ERROR, args -> {
                setStatus("Offline · website chess keeps working with its local rules engine");
            });
            created.on("chess:engine:matches", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null || !payload.optBoolean("success", false)) {
                    setStatus("Connected · no active chess matches to assist");
                    return;
                }
                JSONArray matches = payload.optJSONArray("matches");
                if (matches == null || matches.length() == 0) {
                    setStatus("Connected · waiting for a chess match");
                    return;
                }
                for (int index = 0; index < matches.length(); index++) {
                    JSONObject item = matches.optJSONObject(index);
                    if (item != null) subscribe(item.optLong("matchId", 0));
                }
            });
            created.on("chess:engine:match_available", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null) subscribe(payload.optLong("matchId", 0));
            });
            created.on("chess:engine:snapshot", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null) return;
                long matchId = payload.optLong("matchId", 0);
                String fen = payload.optString("fen", "");
                if (matchId <= 0 || fen.isEmpty()) return;
                engineExecutor.execute(() -> engine.seedSnapshot(
                    matchId,
                    fen,
                    payload.optString("pgn", ""),
                    payload.optInt("ply", 0),
                    payload.optLong("whiteTimeMs", 0),
                    payload.optLong("blackTimeMs", 0),
                    payload.optString("activeColor", "w"),
                    payload.optString("timeControl", ""),
                    SystemClock.elapsedRealtime()
                ));
                setStatus("Connected · native chess engine ready for " + matchId);
            });
            created.on("chess:engine:move", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null) engineExecutor.execute(() -> processMove(created, payload));
            });
            created.on("chess:engine:subscribe_error", args -> {
                JSONObject payload = firstObject(args);
                setStatus(payload == null ? "Connected · a match could not be loaded" : payload.optString("message", "A match could not be loaded"));
            });
            created.connect();
        } catch (URISyntaxException | RuntimeException error) {
            setStatus("Offline · website chess keeps working with its local rules engine");
        }
    }

    private void subscribe(long matchId) {
        Socket active = socket;
        if (active == null || !active.connected() || matchId <= 0 || !subscribedMatches.add(matchId)) return;
        JSONObject request = new JSONObject();
        try { request.put("matchId", matchId); }
        catch (Exception ignored) { return; }
        active.emit("chess:engine:subscribe", request);
    }

    private void processMove(Socket active, JSONObject payload) {
        long matchId = payload.optLong("matchId", 0);
        long ply = payload.optLong("ply", 0);
        JSONObject move = payload.optJSONObject("move");
        if (matchId <= 0 || ply <= 0 || move == null) return;

        NativeChessEngine.Result result = engine.processMove(
            payload.optString("requestId", ""),
            matchId,
            (int) ply,
            payload.optString("fenBefore", ""),
            payload.optString("pgnBefore", ""),
            move.optString("from", ""),
            move.optString("to", ""),
            move.isNull("promotion") ? null : move.optString("promotion", null),
            payload.optString("expectedFen", ""),
            payload.optString("expectedPgn", ""),
            payload.optBoolean("clockIsCurrent", false),
            payload.optLong("whiteTimeMs", 0),
            payload.optLong("blackTimeMs", 0),
            payload.optString("activeColor", "w"),
            payload.optString("timeControl", ""),
            SystemClock.elapsedRealtime()
        );

        JSONObject response = new JSONObject();
        try {
            response.put("requestId", payload.optString("requestId", ""));
            response.put("matchId", matchId);
            response.put("ply", ply);
            response.put("legal", result.legal);
            response.put("stale", result.stale);
            response.put("historyComplete", result.historyComplete);
            response.put("resultingFen", result.resultingFen);
            response.put("pgn", result.pgn);
            response.put("check", result.check);
            response.put("checkmate", result.checkmate);
            response.put("stalemate", result.stalemate);
            response.put("draw", result.draw);
            response.put("agreesWithExpectedPosition", result.agreesWithExpectedPosition);
            response.put("legalMoves", new JSONArray(result.legalMoves));
            if (result.error != null) response.put("error", result.error);
            if (result.clockEstimate != null) {
                JSONObject clock = new JSONObject();
                clock.put("whiteTimeMs", result.clockEstimate.whiteTimeMs);
                clock.put("blackTimeMs", result.clockEstimate.blackTimeMs);
                clock.put("activeColor", result.clockEstimate.activeColor);
                response.put("clockEstimate", clock);
            }
        } catch (Exception ignored) { return; }

        if (!closed && active == socket && active.connected()) {
            active.emit("chess:engine:result", response);
            if (result.stale) {
                JSONObject resync = new JSONObject();
                try { resync.put("matchId", matchId); active.emit("chess:engine:resync", resync); }
                catch (Exception ignored) {}
            }
        }
    }

    private static JSONObject firstObject(Object[] args) {
        return args != null && args.length > 0 && args[0] instanceof JSONObject ? (JSONObject) args[0] : null;
    }

    private void setStatus(String status) {
        if (statusListener != null) mainHandler.post(() -> statusListener.onStatus(status));
    }

    void close() {
        closed = true;
        Socket active = socket;
        socket = null;
        if (active != null) {
            active.off();
            active.disconnect();
            active.close();
        }
        engineExecutor.shutdownNow();
    }
}
