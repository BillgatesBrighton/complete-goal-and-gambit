package com.goalgambit.trial;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

import io.socket.client.IO;
import io.socket.client.Socket;

final class ChessRealtimeClient {
    interface Listener {
        void onStatus(String status);
        void onMatches(List<JSONObject> matches);
        void onMatchEvent(JSONObject state, String event);
        void onPlayerNotification(JSONObject notification);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private Socket socket;
    private long currentMatchId;
    private boolean joined;

    ChessRealtimeClient(Listener listener) {
        this.listener = listener;
    }

    void connect(String token) {
        closeSocket();
        if (token == null || token.isEmpty()) return;
        try {
            IO.Options options = new IO.Options();
            HashMap<String, String> auth = new HashMap<>();
            auth.put("token", token);
            auth.put("clientType", "android-trial");
            options.auth = auth;
            options.reconnection = true;
            options.reconnectionAttempts = Integer.MAX_VALUE;
            options.reconnectionDelay = 1000;
            options.reconnectionDelayMax = 10000;
            options.timeout = 10000;
            options.transports = new String[] { "websocket", "polling" };
            options.forceNew = true;
            socket = IO.socket(BuildConfig.API_BASE_URL.replaceAll("/+$", ""), options);
            Socket active = socket;
            active.on(Socket.EVENT_CONNECT, args -> {
                joined = false;
                emitStatus("Connected · syncing chess matches");
                active.emit("chess:engine:ready", new JSONObject());
                if (currentMatchId > 0) joinCurrentMatch(active);
            });
            active.on(Socket.EVENT_DISCONNECT, args -> {
                joined = false;
                emitStatus("Connection interrupted · reconnecting");
            });
            active.on(Socket.EVENT_CONNECT_ERROR, args -> emitStatus("Chess connection unavailable · retrying"));
            active.on("chess:engine:matches", args -> {
                JSONObject payload = firstObject(args);
                if (payload == null || !payload.optBoolean("success", false)) return;
                JSONArray array = payload.optJSONArray("matches");
                List<JSONObject> matches = new ArrayList<>();
                if (array != null) {
                    for (int i = 0; i < array.length(); i++) {
                        JSONObject match = array.optJSONObject(i);
                        if (match != null) matches.add(match);
                    }
                }
                if (listener != null) main.post(() -> listener.onMatches(matches));
                emitStatus("Connected · chess updates are live");
            });
            active.on("chess:engine:match_available", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null && listener != null) {
                    main.post(() -> listener.onMatchEvent(payload, "match_available"));
                }
            });
            active.on("chess:joined", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null && payload.optBoolean("success", false)) {
                    joined = true;
                    emitStatus("Match connected · synchronizing current position");
                    emitMatchEvent(payload, "joined");
                }
            });
            active.on("chess:match_ready", args -> emitMatchEvent(firstObject(args), "match_ready"));
            active.on("chess:player_connected", args -> emitMatchEvent(firstObject(args), "player_connected"));
            active.on("chess:connection_ready", args -> emitMatchEvent(firstObject(args), "connection_ready"));
            active.on("chess:move", args -> emitMatchEvent(firstObject(args), "move"));
            active.on("chess:paused", args -> emitMatchEvent(firstObject(args), "paused"));
            active.on("chess:resumed", args -> emitMatchEvent(firstObject(args), "resumed"));
            active.on("chess:game_over", args -> emitMatchEvent(firstObject(args), "game_over"));
            active.on("chess:draw_offer", args -> emitMatchEvent(firstObject(args), "draw_offer"));
            active.on("efootball:notification", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null && listener != null) {
                    main.post(() -> listener.onPlayerNotification(payload));
                }
            });
            active.on("chess:error", args -> {
                JSONObject payload = firstObject(args);
                if (payload != null) emitStatus(payload.optString("message", "Chess connection error."));
            });
            active.connect();
        } catch (URISyntaxException | RuntimeException error) {
            emitStatus("Chess connection unavailable · check your connection");
        }
    }

    void setMatch(long matchId) {
        currentMatchId = matchId > 0 ? matchId : 0;
        joined = false;
        if (socket != null && socket.connected() && currentMatchId > 0) joinCurrentMatch(socket);
    }

    void refreshMatches() {
        if (socket != null && socket.connected()) socket.emit("chess:engine:ready", new JSONObject());
    }

    boolean isConnected() {
        return socket != null && socket.connected();
    }

    private void joinCurrentMatch(Socket active) {
        if (active == null || !active.connected() || currentMatchId <= 0 || joined) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("matchId", currentMatchId);
            active.emit("chess:join", payload);
            joined = true;
        } catch (Exception ignored) {}
    }

    private void emitMatchEvent(JSONObject payload, String event) {
        if (payload == null || listener == null) return;
        long eventMatchId = payload.optLong("matchId", 0);
        if (eventMatchId > 0 && currentMatchId > 0 && eventMatchId != currentMatchId) return;
        main.post(() -> listener.onMatchEvent(payload, event));
    }

    private void emitStatus(String status) {
        if (listener != null) main.post(() -> listener.onStatus(status));
    }

    private static JSONObject firstObject(Object[] args) {
        return args != null && args.length > 0 && args[0] instanceof JSONObject ? (JSONObject) args[0] : null;
    }

    void close() {
        currentMatchId = 0;
        closeSocket();
    }

    private void closeSocket() {
        Socket old = socket;
        socket = null;
        joined = false;
        if (old != null) {
            old.off();
            old.disconnect();
            old.close();
        }
    }
}
