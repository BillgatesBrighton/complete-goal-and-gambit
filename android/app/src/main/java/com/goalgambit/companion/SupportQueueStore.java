package com.goalgambit.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class SupportQueueStore {
    private static final String PREFS = "gg_device";
    private static final String QUEUE_KEY = "support_message_queue";

    private SupportQueueStore() {}

    static synchronized void enqueue(Context context, long ownerUserId, JSONObject payload) throws Exception {
        if (ownerUserId <= 0) throw new IllegalArgumentException("The signed-in account could not be verified locally.");
        String messageId = payload.optString("clientMessageId", "");
        if (messageId.isEmpty()) throw new IllegalArgumentException("Message reference is missing.");
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray queue = readQueue(prefs);
        for (int index = 0; index < queue.length(); index++) {
            JSONObject existing = queue.optJSONObject(index);
            if (existing != null && messageId.equals(existing.optString("id"))) return;
        }
        JSONObject entry = new JSONObject();
        entry.put("id", messageId);
        entry.put("ownerUserId", ownerUserId);
        entry.put("payload", TokenStore.protectPendingMessage(payload.toString()));
        queue.put(entry);
        prefs.edit().putString(QUEUE_KEY, queue.toString()).apply();
    }

    static synchronized List<JSONObject> pending(Context context, long ownerUserId) {
        ArrayList<JSONObject> result = new ArrayList<>();
        JSONArray queue = readQueue(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        for (int index = 0; index < queue.length(); index++) {
            JSONObject entry = queue.optJSONObject(index);
            if (entry == null || entry.optLong("ownerUserId", 0L) != ownerUserId) continue;
            try {
                JSONObject payload = new JSONObject(TokenStore.unprotectPendingMessage(entry.getString("payload")));
                result.add(payload);
            } catch (Exception ignored) {
                // Keep an unreadable entry for diagnosis/recovery; never send its ciphertext.
            }
        }
        return result;
    }

    static synchronized void remove(Context context, String messageId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray queue = readQueue(prefs);
        JSONArray kept = new JSONArray();
        for (int index = 0; index < queue.length(); index++) {
            JSONObject entry = queue.optJSONObject(index);
            if (entry != null && !messageId.equals(entry.optString("id"))) kept.put(entry);
        }
        prefs.edit().putString(QUEUE_KEY, kept.toString()).apply();
    }

    private static JSONArray readQueue(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(QUEUE_KEY, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }
}
