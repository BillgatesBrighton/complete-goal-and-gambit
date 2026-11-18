package com.goalgambit.trial;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class PlayerPushRegistration {
    private static final String PREFS = "gg_player_push";
    private static final String TOKEN = "fcm_token";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private PlayerPushRegistration() {}

    static void register(Context context) {
        Context app = context.getApplicationContext();
        if (FirebaseApp.getApps(app).isEmpty()) return;
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            saveToken(app, token);
            registerIfSignedIn(app);
        });
    }

    static void saveToken(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        preferences(context).edit().putString(TOKEN, token).apply();
    }

    static void registerIfSignedIn(Context context) {
        Context app = context.getApplicationContext();
        String bearer = SessionStore.read(app);
        String token = preferences(app).getString(TOKEN, null);
        if (bearer == null || bearer.isEmpty() || token == null || token.isEmpty()) return;
        IO.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("token", token);
                body.put("deviceId", deviceId(app));
                body.put("deviceName", Build.MANUFACTURER + " " + Build.MODEL + " · GOAL$GAMBIT Player v" + BuildConfig.VERSION_NAME);
                ApiClient.request("POST", "/api/push/android/subscriptions", bearer, body);
            } catch (Exception ignored) {
                // The next app launch or FCM token refresh retries registration.
            }
        });
    }

    static void unregister(Context context, String bearer) {
        SharedPreferences prefs = preferences(context);
        String token = prefs.getString(TOKEN, null);
        if (token == null || token.isEmpty() || bearer == null || bearer.isEmpty()) return;
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            ApiClient.request("DELETE", "/api/push/android/subscriptions", bearer, body);
        } catch (Exception ignored) { }
    }

    private static String deviceId(Context context) {
        SharedPreferences prefs = preferences(context);
        String id = prefs.getString("device_id", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString("device_id", id).apply();
        }
        return id;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
