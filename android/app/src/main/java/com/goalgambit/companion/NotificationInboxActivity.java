package com.goalgambit.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.util.HashSet;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class NotificationInboxActivity extends Activity {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private final HashSet<String> renderedIds = new HashSet<>();
    private LinearLayout list;
    private TextView status;
    private Button olderButton;
    private String cursor;
    private boolean hasMore;
    private boolean loading;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(8, 8, 8));
        getWindow().setNavigationBarColor(Color.rgb(8, 8, 8));
        render();
        loadPage(true);
    }

    private void render() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(8, 8, 8));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, dp(24), pad, dp(28));
        scroll.addView(root);
        setContentView(scroll);

        TextView title = new TextView(this);
        title.setText("NOTIFICATIONS");
        title.setTextSize(23);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setTextColor(Color.rgb(237, 195, 53));
        root.addView(title);

        status = text("Loading your notifications…", 14, Color.LTGRAY);
        root.addView(status, margins(-1, -2, 0, 8, 0, 14));

        Button retry = button("REFRESH INBOX");
        retry.setOnClickListener(view -> loadPage(true));
        root.addView(retry, margins(-1, -2, 0, 0, 0, 12));

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        root.addView(list, margins(-1, -2, 0, 0, 0, 4));

        olderButton = button("LOAD OLDER NOTIFICATIONS");
        olderButton.setOnClickListener(view -> loadPage(false));
        root.addView(olderButton, margins(-1, -2, 0, 8, 0, 14));

        Button home = button("BACK TO COMPANION");
        home.setOnClickListener(view -> finish());
        root.addView(home, margins(-1, -2, 0, 0, 0, 0));
    }

    private void loadPage(boolean reset) {
        String bearer = TokenStore.read(this);
        if (bearer == null) {
            finish();
            startActivity(new Intent(this, MainActivity.class));
            return;
        }
        if (loading) return;
        loading = true;
        String before = reset ? null : cursor;
        if (reset) {
            cursor = null;
            hasMore = false;
            renderedIds.clear();
            list.removeAllViews();
            status.setText("Loading your notifications…");
        }
        olderButton.setEnabled(false);
        EXECUTOR.execute(() -> {
            Api.Result result = null;
            Exception failure = null;
            try { result = Api.getNotificationHistory(bearer, 50, before); }
            catch (Exception error) { failure = error; }
            Api.Result response = result;
            Exception error = failure;
            runOnUiThread(() -> {
                loading = false;
                olderButton.setEnabled(true);
                if (error != null || response == null || !response.ok()) {
                    status.setText(response == null
                        ? "Notifications could not be loaded. Check your connection and retry."
                        : response.message("Notifications could not be loaded. Check your connection and retry."));
                    olderButton.setVisibility(ViewGroup.GONE);
                    if (list.getChildCount() == 0) list.addView(text("Your notification history will appear here.", 14, Color.LTGRAY));
                    return;
                }

                JSONArray notifications = response.json.optJSONArray("notifications");
                int added = 0;
                if (notifications != null) {
                    for (int index = 0; index < notifications.length(); index++) {
                        JSONObject item = notifications.optJSONObject(index);
                        if (item != null && renderItem(item)) added++;
                    }
                }
                int unread = response.json.optInt("unreadCount", 0);
                status.setText(unread + " unread · recent notifications from GOAL$GAMBIT");
                hasMore = response.json.optBoolean("hasMore", false);
                cursor = response.json.isNull("nextCursor") ? null : response.json.optString("nextCursor", null);
                olderButton.setVisibility(hasMore ? ViewGroup.VISIBLE : ViewGroup.GONE);
                if (list.getChildCount() == 0 && added == 0) {
                    list.addView(text("You're all caught up. New alerts will appear here.", 14, Color.LTGRAY));
                }
            });
        });
    }

    private boolean renderItem(JSONObject item) {
        String id = item.optString("id", "");
        if (id.isEmpty() || !renderedIds.add(id)) return false;
        boolean unread = item.isNull("read_at");
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(13), dp(12), dp(13), dp(12));
        card.setBackgroundColor(unread ? Color.rgb(42, 35, 18) : Color.rgb(24, 24, 24));
        card.addView(text(item.optString("title", "GOAL$GAMBIT"), 16, Color.rgb(237, 195, 53)));
        card.addView(text(item.optString("body", "Open GOAL$GAMBIT to view this update."), 14, Color.WHITE), margins(-1, -2, 0, 5, 0, 4));
        String detail = (unread ? "Unread" : "Read") + " · " + formatTimestamp(item.optString("created_at", ""));
        String delivery = item.optString("deliveryStatus", "");
        if (!delivery.isEmpty()) detail += " · " + delivery.replace('_', ' ');
        card.addView(text(detail, 12, Color.LTGRAY));
        Button open = button(unread ? "OPEN · MARK READ" : "OPEN DETAILS");
        card.addView(open, margins(-1, -2, 0, 8, 0, 0));
        open.setOnClickListener(view -> openNotification(item));
        list.addView(card, margins(-1, -2, 0, 0, 0, 9));
        return true;
    }

    private void openNotification(JSONObject item) {
        String bearer = TokenStore.read(this);
        long eventId = item.optLong("id", 0L);
        String eventKey = item.optString("event_key", "");
        long matchId = item.optLong("match_id", 0L);
        Intent intent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(Notifications.EXTRA_PUSH_EVENT_ID, eventId)
            .putExtra(Notifications.EXTRA_EVENT_KEY, eventKey)
            .putExtra(Notifications.EXTRA_MATCH_ID, matchId);
        long chessMatchId = Notifications.chessMatchIdFromEventKey(eventKey);
        if (chessMatchId > 0) intent.putExtra(Notifications.EXTRA_CHESS_MATCH_ID, chessMatchId);
        if (eventKey.startsWith("support-reply:") || eventKey.startsWith("support-message:")) {
            intent.putExtra(Notifications.EXTRA_OPEN_SUPPORT, true);
        }
        String[] parts = eventKey.split(":");
        if (eventKey.startsWith("admin-announcement:") && parts.length > 1) {
            try { intent.putExtra(Notifications.EXTRA_ANNOUNCEMENT_ID, Long.parseLong(parts[1])); }
            catch (NumberFormatException ignored) {}
        }
        if (bearer != null && eventId > 0) {
            EXECUTOR.execute(() -> {
                try { Api.markNotificationRead(eventId, bearer); } catch (Exception ignored) {}
            });
        }
        startActivity(intent);
    }

    private String formatTimestamp(String raw) {
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
            java.util.Date date = parser.parse(raw);
            if (date == null) return raw;
            return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(date);
        } catch (Exception ignored) {
            return raw.isEmpty() ? "Time unavailable" : raw;
        }
    }

    private TextView text(String value, float size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextColor(Color.rgb(18, 18, 18));
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(237, 195, 53)));
        return button;
    }

    private LinearLayout.LayoutParams margins(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
