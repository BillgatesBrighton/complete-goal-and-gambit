package com.goalgambit.companion;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;
import io.socket.engineio.client.transports.Polling;
import io.socket.engineio.client.transports.WebSocket;

/** Authenticated, optional companion connection for native chess-state processing. */
final class ChessEngineSocket {
    interface StatusListener { void onStatus(String status); }
    interface EventListener {
        void onVerifiedMove(long matchId, int ply, String flags, boolean captured, boolean check, boolean checkmate);
    }

    private final String bearer;
    private final StatusListener statusListener;
    private final EventListener eventListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService engineExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService predictionExecutor = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "ChessLegalMovePrediction");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.setDaemon(true);
        return thread;
    });
    private final NativeChessEngine engine = new NativeChessEngine();
    private final Set<Long> subscribedMatches = Collections.synchronizedSet(new HashSet<>());
    private final Set<Long> awaitingAuthoritativeResync = Collections.synchronizedSet(new HashSet<>());
    private volatile Socket socket;
    private volatile boolean closed;
    private volatile long foregroundMatchId;

    ChessEngineSocket(String bearer, StatusListener statusListener, EventListener eventListener) {
        this.bearer = bearer;
        this.statusListener = statusListener;
        this.eventListener = eventListener;
    }

    void connect() {
        if (bearer == null || bearer.trim().isEmpty() || closed) return;
        try {
            IO.Options options = new IO.Options();
            java.util.HashMap<String, String> socketAuth = new java.util.HashMap<>();
            socketAuth.put("token", bearer);
            socketAuth.put("clientType", "android-companion");
            options.auth = socketAuth;
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
                setStatus("Syncing chess match updates…");
                created.emit("chess:engine:ready");
                emitForegroundPresence(created);
            });
            created.on(Socket.EVENT_DISCONNECT, args -> {
                subscribedMatches.clear();
                setStatus("Chess match updates are unavailable. The website chessboard remains available.");
            });
            created.on(Socket.EVENT_CONNECT_ERROR, args -> {
                setStatus("Chess match updates are unavailable. The website chessboard remains available.");
            });
            created.on("chess:engine:matches", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null || !payload.optBoolean("success", false)) {
                    setStatus("No active chess matches.");
                    return;
                }
                JSONArray matches = payload.optJSONArray("matches");
                if (matches == null || matches.length() == 0) {
                    setStatus("Chess match updates are ready.");
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
                boolean acceptResync = awaitingAuthoritativeResync.remove(matchId);
                engineExecutor.execute(() -> {
                    NativeChessEngine.Result result = engine.seedSnapshot(
                        matchId,
                        fen,
                        payload.optString("pgn", ""),
                        payload.optInt("ply", 0),
                        payload.optLong("whiteTimeMs", 0),
                        payload.optLong("blackTimeMs", 0),
                        payload.optString("activeColor", "w"),
                        payload.optString("timeControl", ""),
                        SystemClock.elapsedRealtime(),
                        acceptResync
                    );
                    if (!result.historyComplete || !result.agreesWithExpectedPosition || result.stale) {
                        awaitingAuthoritativeResync.add(matchId);
                        emitIntegrityReport(created, matchId, payload.optInt("ply", 0),
                            "snapshot_mismatch", "snapshot:" + matchId + ":" + payload.optInt("ply", 0),
                            result.resultingFen, fen);
                        setStatus("The server is checking the chess position.");
                        return;
                    }
                    setStatus(payload.optBoolean("connectionPaused", false)
                        ? "Game paused by server · both chess clocks stopped"
                        : "Chess match is synchronized.");
                    if (!payload.optBoolean("connectionPaused", false) &&
                        "active".equalsIgnoreCase(payload.optString("status", ""))) {
                        schedulePrediction(() -> engine.precomputeCurrentPosition(matchId, fen));
                    }
                });
            });
            created.on("chess:engine:move", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null) engineExecutor.execute(() -> processMove(created, payload));
            });
            created.on("chess:engine:subscribe_error", args -> {
                JSONObject payload = firstObject(args);
                setStatus(payload == null ? "Connected · a match could not be loaded" : payload.optString("message", "A match could not be loaded"));
            });
            created.on("chess:engine:integrity_ack", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null || !payload.optBoolean("success", false)) return;
                long matchId = payload.optLong("matchId", 0);
                if (matchId > 0 && payload.optBoolean("serverConsistent", false)) {
                    awaitingAuthoritativeResync.add(matchId);
                    setStatus(payload.optBoolean("connectionPaused", false)
                        ? "Game paused by server · waiting for safe reconnection"
                        : "Chess match sync is being restored.");
                }
            });
            created.on("chess:engine:match_state", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null) return;
                long matchId = payload.optLong("matchId", 0);
                if (payload.optBoolean("connectionPaused", false)) {
                    setStatus("Game paused by server · both chess clocks stopped");
                } else if (matchId > 0) {
                    setStatus("Chess match sync is being restored.");
                }
            });
            created.connect();
        } catch (URISyntaxException | RuntimeException error) {
            setStatus("Chess match updates are unavailable. The website chessboard remains available.");
        }
    }

    void setForegroundMatchId(long matchId) {
        foregroundMatchId = matchId > 0 ? matchId : 0;
        Socket active = socket;
        if (active != null && active.connected()) emitForegroundPresence(active);
    }

    private void emitForegroundPresence(Socket active) {
        if (active == null || !active.connected()) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("matchId", foregroundMatchId);
            payload.put("active", foregroundMatchId > 0);
            active.emit("chess:companion:presence", payload);
        } catch (Exception ignored) {}
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
            response.put("predictionCacheHit", result.predictionCacheHit);
            response.put("positionKey", sha256(result.resultingFen));
            response.put("positionVersion", ply);
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
            if (result.legal && result.historyComplete && result.agreesWithExpectedPosition && !result.stale &&
                eventListener != null) {
                String flags = move.optString("flags", "");
                boolean captured = move.has("captured") && !move.isNull("captured") &&
                    !move.optString("captured", "").isEmpty();
                mainHandler.post(() -> {
                    if (!closed && active == socket) eventListener.onVerifiedMove(
                        matchId, (int) ply, flags, captured, result.check, result.checkmate);
                });
            }
            int predictionBudget = predictionBranchBudget(payload.optString("timeControl", ""));
            if (result.legal && result.historyComplete && result.agreesWithExpectedPosition &&
                payload.optBoolean("clockIsCurrent", false) && !result.checkmate &&
                !result.stalemate && !result.draw && predictionBudget > 0) {
                String confirmedFen = result.resultingFen;
                schedulePrediction(() -> {
                    if (!closed) engine.precomputeNextPositions(matchId, confirmedFen, predictionBudget);
                });
            }
            if (result.stale || !result.historyComplete || !result.legal || !result.agreesWithExpectedPosition) {
                String issue = result.stale ? "stale_state" : !result.historyComplete
                    ? "history_incomplete" : !result.legal ? "illegal_confirmed_move" : "position_mismatch";
                emitIntegrityReport(active, matchId, (int) ply, issue,
                    payload.optString("requestId", ""), result.resultingFen,
                    payload.optString("expectedFen", ""));
                awaitingAuthoritativeResync.add(matchId);
                JSONObject resync = new JSONObject();
                try { resync.put("matchId", matchId); active.emit("chess:engine:resync", resync); }
                catch (Exception ignored) {}
            }
        }
    }

    private static int predictionBranchBudget(String timeControl) {
        try {
            String[] fields = String.valueOf(timeControl).trim().split("[+:/-]", 2);
            double baseMinutes = Double.parseDouble(fields[0]);
            if (baseMinutes <= 2) return 0; // Keep bullet CPU focused on verification and notifications.
            if (baseMinutes <= 5) return 12;
            return 32;
        } catch (RuntimeException invalidControl) {
            return 0;
        }
    }

    private void schedulePrediction(Runnable task) {
        if (closed || task == null) return;
        try { predictionExecutor.execute(task); }
        catch (RejectedExecutionException ignored) {}
    }

    private void emitIntegrityReport(Socket active, long matchId, int ply, String issue,
                                     String requestId, String reconstructedFen, String expectedFen) {
        if (active == null || !active.connected() || matchId <= 0) return;
        JSONObject report = new JSONObject();
        try {
            report.put("matchId", matchId);
            report.put("ply", Math.max(0, ply));
            report.put("requestId", requestId == null || requestId.isEmpty()
                ? "snapshot:" + matchId + ":" + Math.max(0, ply) : requestId);
            report.put("issue", issue == null ? "position_mismatch" : issue);
            report.put("localPositionDigest", sha256(reconstructedFen));
            report.put("serverPositionDigest", sha256(expectedFen));
            active.emit("chess:engine:integrity_report", report);
        } catch (Exception ignored) {}
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(String.valueOf(value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) hex.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            return "";
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
        predictionExecutor.shutdownNow();
    }
}
