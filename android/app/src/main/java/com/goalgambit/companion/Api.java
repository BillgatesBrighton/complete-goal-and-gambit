package com.goalgambit.companion;

import android.os.Build;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.Manifest;

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

    static Result registerCompanion(Context context, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("installationId", TokenStore.deviceId(context));
        body.put("appVersion", BuildConfig.VERSION_NAME);
        body.put("platform", "android");
        body.put("notificationPermissionStatus", notificationPermissionStatus(context));
        return request("POST", "/api/companion/register", bearer, body);
    }

    static Result heartbeatCompanion(Context context, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("installationId", TokenStore.deviceId(context));
        body.put("appVersion", BuildConfig.VERSION_NAME);
        return request("POST", "/api/companion/heartbeat", bearer, body);
    }

    static Result updateCompanionNotificationStatus(Context context, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("installationId", TokenStore.deviceId(context));
        body.put("status", notificationPermissionStatus(context));
        return request("POST", "/api/companion/notification-status", bearer, body);
    }

    static Result unregisterCompanion(Context context, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("installationId", TokenStore.deviceId(context));
        return request("POST", "/api/companion/unregister", bearer, body);
    }

    private static String notificationPermissionStatus(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return "denied";
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled() ? "granted" : "denied";
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

    static Result getSupportUnreadCount(String bearer) throws Exception {
        return request("GET", "/api/chat/support/unread", bearer, null);
    }

    static Result getNotificationHistory(String bearer, int limit, String beforeId) throws Exception {
        String query = "?limit=" + Math.max(1, Math.min(limit, 100));
        if (beforeId != null && beforeId.matches("[1-9][0-9]{0,18}")) query += "&beforeId=" + beforeId;
        return request("GET", "/api/push/history" + query, bearer, null);
    }

    static Result markNotificationRead(long eventId, String bearer) throws Exception {
        if (eventId <= 0) throw new IllegalArgumentException("Invalid notification id.");
        return request("POST", "/api/push/history/" + eventId + "/read", bearer, new JSONObject());
    }

    static Result getNotificationPreferences(String bearer) throws Exception {
        return request("GET", "/api/companion/notification-preferences", bearer, null);
    }

    static Result saveNotificationPreferences(JSONObject preferences, String bearer) throws Exception {
        JSONObject body = new JSONObject();
        body.put("preferences", preferences);
        return request("PUT", "/api/companion/notification-preferences", bearer, body);
    }

    static Result getCompanionStatus(String bearer) throws Exception {
        return request("GET", "/api/companion/status", bearer, null);
    }

    static Result acceptCompanionTerms(String bearer) throws Exception {
        return request("POST", "/api/companion/terms/accept", bearer, new JSONObject());
    }

    static Result getPushStatus(String bearer) throws Exception {
        return request("GET", "/api/push/status", bearer, null);
    }

    static Result sendSupportMessage(JSONObject payload, String bearer) throws Exception {
        return request("POST", "/api/chat/support", bearer, payload);
    }
}
