package com.goalgambit.companion;

import android.os.Build;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class Api {
    static final class Result {
        final int status;
        final JSONObject json;
        Result(int status, JSONObject json) {
            this.status = status;
            this.json = json == null ? new JSONObject() : json;
        }
        boolean ok() {
            return status >= 200 && status < 300 && json.optBoolean("success", false);
        }
        String message(String fallback) {
            return json.optString("message", fallback);
        }
    }

    private Api() {}

    static Result request(String method, String path, String bearer, JSONObject body) throws Exception {
        String base = BuildConfig.API_BASE_URL.replaceAll("/+$", "");
        if (!base.startsWith("https://")) throw new IllegalStateException("The companion app requires an HTTPS API URL.");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(12000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (bearer != null && !bearer.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + bearer);
            }
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (stream != null) {
                try (InputStream input = stream) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                    text = new String(output.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            JSONObject json;
            try {
                json = new JSONObject(text);
            } catch (Exception ignored) {
                json = new JSONObject();
                json.put("message", status >= 500 ? "The GOAL$GAMBIT server could not complete the request." : "The server returned an unreadable response.");
            }
            return new Result(status, json);
        } finally {
            connection.disconnect();
        }
    }

    static Result login(String username, String password) throws Exception {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        return request("POST", "/api/auth/login", null, body);
    }

    static Result registerDevice(String token, String deviceId, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("token", token);
        body.put("deviceId", deviceId);
        String build = (BuildConfig.DEBUG ? "Trial" : "Release") + " v" + BuildConfig.VERSION_NAME;
        body.put("deviceName", Build.MANUFACTURER + " " + Build.MODEL + " · " + build);
        return request("POST", "/api/push/android/subscriptions", bearer, body);
    }

    static void unregisterDevice(String fcmToken, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        if (fcmToken != null && !fcmToken.isEmpty()) body.put("token", fcmToken);
        request("DELETE", "/api/push/android/subscriptions", bearer, body);
    }

    static Result sendRoomCode(long matchId, String code, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("code", code);
        return request("POST", "/api/efootball/matches/" + matchId + "/roomcode", bearer, body);
    }

    static Result confirmRoomCode(long matchId, String bearer) throws Exception {
        return request("POST", "/api/efootball/matches/" + matchId + "/code-received", bearer, new JSONObject());
    }

    static Result getMatch(long matchId, String bearer) throws Exception {
        return request("GET", "/api/efootball/matches/" + matchId, bearer, null);
    }

    static Result testAndroidNotification(String bearer) throws Exception {
        return request("POST", "/api/push/android/test", bearer, new JSONObject());
    }

    static Result getAnnouncements(String bearer) throws Exception {
        return request("GET", "/api/chat/announcements", bearer, null);
    }

    static Result markAnnouncementRead(long announcementId, String bearer) throws Exception {
        if (announcementId <= 0) throw new IllegalArgumentException("Invalid announcement id.");
        return request("POST", "/api/chat/announcements/" + announcementId + "/read", bearer, new JSONObject());
    }

    static Result getUpcomingGameStatus(String bearer) throws Exception {
        return request("GET", "/api/companion/upcoming", bearer, null);
    }

    static Result getCompanionProfile(String bearer) throws Exception {
        return request("GET", "/api/companion/profile", bearer, null);
    }

    static Result getSupportMessages(String bearer) throws Exception {
        return request("GET", "/api/chat/support", bearer, null);
    }

    static Result sendSupportMessage(JSONObject payload, String bearer) throws Exception {
        return request("POST", "/api/chat/support", bearer, payload);
    }
}
