package com.goalgambit.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.UUID;

public final class MainActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 401;
    private static final ExecutorService API_EXECUTOR = Executors.newSingleThreadExecutor();
    private LinearLayout content;
    private ScrollView screenScroll;
    private TextView statusView;
    private TextView welcomeGreetingView;
    private TextView welcomeNameView;
    private TextView serviceStatusView;
    private TextView upcomingStatusView;
    private TextView announcementsStatusView;
    private TextView supportStatusView;
    private LinearLayout announcementsList;
    private LinearLayout supportMessages;
    private EditText supportSubject;
    private EditText supportComposer;
    private Spinner supportCategory;
    private long selectedMatchId;
    private long selectedAnnouncementId;
    private boolean companionRefreshInFlight;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Notifications.createChannel(this);
        selectedMatchId = getIntent().getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        selectedAnnouncementId = getIntent().getLongExtra(Notifications.EXTRA_ANNOUNCEMENT_ID, 0);
        buildScreen();
        renderAccountState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        String bearer = TokenStore.read(this);
        if (bearer != null) {
            syncCompanionInstallation();
            if (!SupportQueueStore.pending(this, TokenStore.accountUserId(bearer)).isEmpty()) enqueueSupportSync();
            refreshCompanionData();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        selectedMatchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        selectedAnnouncementId = intent.getLongExtra(Notifications.EXTRA_ANNOUNCEMENT_ID, 0);
        if (selectedMatchId > 0) loadMatch(selectedMatchId);
        refreshCompanionData();
        if (intent.getBooleanExtra(Notifications.EXTRA_OPEN_SUPPORT, false) && supportMessages != null) {
            screenScroll.post(() -> screenScroll.smoothScrollTo(0, supportMessages.getTop()));
        }
    }

    private void buildScreen() {
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(8, 8, 8));
        window.setNavigationBarColor(Color.rgb(8, 8, 8));

        screenScroll = new ScrollView(this);
        screenScroll.setBackgroundColor(Color.rgb(8, 8, 8));
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        content.setPadding(pad, dp(28), pad, dp(32));
        screenScroll.addView(content);
        setContentView(screenScroll);

        TextView title = text("GOAL$GAMBIT", 27, Color.rgb(237, 195, 53), true);
        content.addView(title, params(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        String buildLabel = BuildConfig.DEBUG ? "TRIAL BUILD" : "RELEASE BUILD";
        TextView subtitle = text("Notification companion · " + buildLabel + " · v" + BuildConfig.VERSION_NAME, 13, Color.LTGRAY, false);
        content.addView(subtitle, marginParams(-1, -2, 0, 4, 0, 8));
        welcomeGreetingView = text("Welcome back,", 14, Color.rgb(201, 184, 111), false);
        welcomeGreetingView.setVisibility(View.GONE);
        content.addView(welcomeGreetingView, marginParams(-1, -2, 0, 0, 0, 0));
        welcomeNameView = text("player", 37, Color.rgb(201, 184, 111), false);
        welcomeNameView.setVisibility(View.GONE);
        try {
            Typeface pacifico = Typeface.createFromAsset(getAssets(), "fonts/Pacifico-Regular.ttf");
            welcomeNameView.setTypeface(Typeface.create(pacifico, Typeface.BOLD));
        } catch (RuntimeException ignored) {}
        content.addView(welcomeNameView, marginParams(-1, -2, 0, -5, 0, 12));
        statusView = text("", 14, Color.rgb(205, 205, 205), false);
        statusView.setBackgroundColor(Color.rgb(25, 25, 25));
        statusView.setPadding(dp(12), dp(11), dp(12), dp(11));
        content.addView(statusView, marginParams(-1, -2, 0, 0, 0, 16));
        String bearer = TokenStore.read(this);
        if (bearer != null) {
            String cachedUsername = TokenStore.accountUsername(bearer);
            if (!cachedUsername.isEmpty()) welcomeNameView.setText(cachedUsername);
        }
    }

    private void renderAccountState() {
        content.removeViews(5, Math.max(0, content.getChildCount() - 5));
        String bearer = TokenStore.read(this);
        if (bearer == null) {
            if (welcomeGreetingView != null) welcomeGreetingView.setVisibility(View.GONE);
            if (welcomeNameView != null) welcomeNameView.setVisibility(View.GONE);
            if (welcomeNameView != null) welcomeNameView.setText("player");
            showLogin();
        } else {
            if (welcomeGreetingView != null) welcomeGreetingView.setVisibility(View.VISIBLE);
            if (welcomeNameView != null) welcomeNameView.setVisibility(View.VISIBLE);
            String username = TokenStore.accountUsername(bearer);
            if (!username.isEmpty() && welcomeNameView != null) welcomeNameView.setText(username);
            showSignedIn();
        }
    }

    private void showLogin() {
        statusView.setText("Sign in with your existing GOAL$GAMBIT account for announcements, game reminders, and private support chat. Gameplay stays on the website.");
        EditText username = edit("Username");
        EditText password = edit("Password");
        password.setInputType(129);
        content.addView(username, marginParams(-1, -2, 0, 4, 0, 12));
        content.addView(password, marginParams(-1, -2, 0, 0, 0, 14));
        Button login = button("SIGN IN");
        content.addView(login, marginParams(-1, -2, 0, 0, 0, 10));
        login.setOnClickListener(view -> {
            String name = username.getText().toString().trim();
            String pass = password.getText().toString();
            if (name.isEmpty() || pass.isEmpty()) {
                statusView.setText("Enter your username and password.");
                return;
            }
            login.setEnabled(false);
            statusView.setText("Signing in securely…");
            API_EXECUTOR.execute(() -> {
                try {
                    Api.Result result = Api.login(name, pass);
                    String token = result.json.optString("token", "");
                    if (!result.ok() || token.isEmpty()) {
                        runOnUiThread(() -> {
                            statusView.setText(result.message("Sign-in failed."));
                            login.setEnabled(true);
                        });
                        return;
                    }
                    TokenStore.save(this, token);
                    syncCompanionInstallation();
                    runOnUiThread(() -> {
                        Toast.makeText(this, "Signed in to GOAL$GAMBIT.", Toast.LENGTH_SHORT).show();
                        renderAccountState();
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        statusView.setText(error.getMessage() == null ? "Could not reach the GOAL$GAMBIT server." : error.getMessage());
                        login.setEnabled(true);
                    });
                }
            });
        });
        TextView hint = text("Your password is sent only to the configured HTTPS API. The companion stores the returned session token encrypted with Android Keystore.", 12, Color.GRAY, false);
        content.addView(hint, marginParams(-1, -2, 0, 12, 0, 0));
    }

    private void showSignedIn() {
        statusView.setText("Your GOAL$GAMBIT companion for event announcements, upcoming-game reminders, and admin support chat. Room-code replies remain available in match notifications.");
        Button enable = button("ENABLE MATCH NOTIFICATIONS");
        Button test = button("SEND TEST NOTIFICATION");
        Button disable = button("DISABLE NOTIFICATIONS ON THIS DEVICE");
        Button signOut = button("SIGN OUT");
        content.addView(enable, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(test, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(disable, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(signOut, marginParams(-1, -2, 0, 0, 0, 18));
        serviceStatusView = text("Checking companion services…", 13, Color.LTGRAY, false);
        upcomingStatusView = text("Checking upcoming games…", 15, Color.WHITE, false);
        upcomingStatusView.setPadding(dp(12), dp(12), dp(12), dp(12));
        upcomingStatusView.setBackgroundColor(Color.rgb(25, 25, 25));
        content.addView(serviceStatusView, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(text("UPCOMING GAMES", 17, Color.rgb(237, 195, 53), true), marginParams(-1, -2, 0, 8, 0, 7));
        content.addView(upcomingStatusView, marginParams(-1, -2, 0, 0, 0, 8));
        Button openHub = button("OPEN MATCH HUB");
        content.addView(openHub, marginParams(-1, -2, 0, 0, 0, 20));
        openHub.setOnClickListener(view -> openMatchHub());

        content.addView(text("ANNOUNCEMENTS", 17, Color.rgb(237, 195, 53), true), marginParams(-1, -2, 0, 2, 0, 4));
        announcementsStatusView = text("Loading announcements…", 13, Color.LTGRAY, false);
        content.addView(announcementsStatusView, marginParams(-1, -2, 0, 0, 0, 5));
        announcementsList = new LinearLayout(this);
        announcementsList.setOrientation(LinearLayout.VERTICAL);
        content.addView(announcementsList, marginParams(-1, -2, 0, 0, 0, 20));

        content.addView(text("CONTACT ADMIN · SUPPORT CHATBOX", 17, Color.rgb(237, 195, 53), true), marginParams(-1, -2, 0, 2, 0, 4));
        supportStatusView = text("Messages are private to your account. Unsent messages are encrypted and queued on this device.", 13, Color.LTGRAY, false);
        content.addView(supportStatusView, marginParams(-1, -2, 0, 0, 0, 8));
        supportMessages = new LinearLayout(this);
        supportMessages.setOrientation(LinearLayout.VERTICAL);
        supportMessages.setPadding(dp(10), dp(8), dp(10), dp(8));
        supportMessages.setBackgroundColor(Color.rgb(20, 20, 20));
        content.addView(supportMessages, marginParams(-1, -2, 0, 0, 0, 10));
        supportCategory = new Spinner(this);
        String[] categories = {"General inquiry", "Suggestion", "Technical problem", "Match or room-code problem", "Account problem", "Important report"};
        ArrayAdapter<String> categoryAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, categories);
        categoryAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        supportCategory.setAdapter(categoryAdapter);
        content.addView(supportCategory, marginParams(-1, -2, 0, 0, 0, 8));
        supportSubject = edit("Subject (optional)");
        content.addView(supportSubject, marginParams(-1, -2, 0, 0, 0, 8));
        supportComposer = edit("Write to GOAL$GAMBIT support…");
        supportComposer.setSingleLine(false);
        supportComposer.setMinLines(3);
        supportComposer.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        supportComposer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        content.addView(supportComposer, marginParams(-1, -2, 0, 0, 0, 8));
        Button sendSupport = button("SEND TO ADMIN");
        content.addView(sendSupport, marginParams(-1, -2, 0, 0, 0, 20));
        sendSupport.setOnClickListener(view -> sendSupportMessage(sendSupport));
        enable.setOnClickListener(view -> requestNotificationPermission());
        test.setOnClickListener(view -> {
            test.setEnabled(false);
            API_EXECUTOR.execute(() -> {
                try {
                    Api.Result result = Api.testAndroidNotification(TokenStore.read(this));
                    runOnUiThread(() -> {
                        statusView.setText(result.ok() ? "Test queued. Check the Android notification shade."
                            : result.message("Could not send the Android test notification."));
                        test.setEnabled(true);
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        statusView.setText("Could not reach the server to queue a test notification.");
                        test.setEnabled(true);
                    });
                }
            });
        });
        disable.setOnClickListener(view -> disableNotifications(false));
        signOut.setOnClickListener(view -> disableNotifications(true));
        if (selectedMatchId > 0) addMatchLoading(selectedMatchId);
        refreshCompanionData();
    }

    private void refreshCompanionData() {
        String bearer = TokenStore.read(this);
        if (bearer == null || companionRefreshInFlight || announcementsList == null || supportMessages == null) return;
        companionRefreshInFlight = true;
        API_EXECUTOR.execute(() -> {
            Api.Result announcementResult = null;
            Api.Result upcomingResult = null;
            Api.Result supportResult = null;
            Api.Result profileResult = null;
            try { announcementResult = Api.getAnnouncements(bearer); } catch (Exception ignored) {}
            try { upcomingResult = Api.getUpcomingGameStatus(bearer); } catch (Exception ignored) {}
            try { supportResult = Api.getSupportMessages(bearer); } catch (Exception ignored) {}
            try { profileResult = Api.getCompanionProfile(bearer); } catch (Exception ignored) {}
            final Api.Result announcements = announcementResult;
            final Api.Result upcoming = upcomingResult;
            final Api.Result support = supportResult;
            final Api.Result profile = profileResult;
            runOnUiThread(() -> {
                companionRefreshInFlight = false;
                if (TokenStore.read(this) == null || !bearer.equals(TokenStore.read(this))) return;
                if (profile != null && profile.ok() && welcomeNameView != null) {
                    String username = profile.json.optString("username", "").trim();
                    if (!username.isEmpty()) welcomeNameView.setText(username);
                }
                boolean connected = announcements != null && announcements.ok()
                    && upcoming != null && upcoming.ok() && support != null && support.ok();
                if (serviceStatusView != null) serviceStatusView.setText(connected
                    ? "Connected to GOAL$GAMBIT. Support and announcements sync independently of the website pages."
                    : "GOAL$GAMBIT services are temporarily unreachable. Unsent support messages stay queued on this device.");
                if (announcements != null && announcements.ok()) renderAnnouncements(announcements.json);
                else if (announcementsStatusView != null) announcementsStatusView.setText("Announcements could not be refreshed. Try again when connected.");
                if (upcoming != null && upcoming.ok()) {
                    boolean hasUpcoming = upcoming.json.optBoolean("hasUpcomingGames", false);
                    if (upcomingStatusView != null) upcomingStatusView.setText(hasUpcoming
                        ? "You have upcoming games. Open Match Hub to check when they are available."
                        : "No upcoming games are confirmed for your account right now.");
                    long accountId = TokenStore.accountUserId(bearer);
                    SharedPreferences state = getSharedPreferences("gg_companion_state", MODE_PRIVATE);
                    String key = "upcoming_active_" + accountId;
                    boolean wasUpcoming = state.getBoolean(key, false);
                    if (hasUpcoming && !wasUpcoming) Notifications.showUpcomingReminder(this);
                    state.edit().putBoolean(key, hasUpcoming).apply();
                } else if (upcomingStatusView != null) {
                    upcomingStatusView.setText("Upcoming-game status is temporarily unavailable.");
                }
                if (support != null && support.ok()) {
                    renderSupportMessages(support.json, bearer);
                    if (supportStatusView != null) supportStatusView.setText("Support chat connected · replies and announcements sync when you reconnect.");
                } else if (supportStatusView != null) {
                    supportStatusView.setText(support == null
                        ? "Offline or reconnecting. New messages remain queued locally until the server confirms them."
                        : support.message("Could not load support chat. Queued messages have not been marked as delivered."));
                }
                if (selectedAnnouncementId > 0 && announcements != null && announcements.ok()) {
                    long selected = selectedAnnouncementId;
                    selectedAnnouncementId = 0;
                    markAnnouncementRead(selected);
                }
            });
        });
    }

    private void renderAnnouncements(JSONObject response) {
        if (announcementsList == null) return;
        announcementsList.removeAllViews();
        org.json.JSONArray rows = response.optJSONArray("announcements");
        if (rows == null || rows.length() == 0) {
            announcementsStatusView.setText("No announcements are available right now.");
            return;
        }
        announcementsStatusView.setText("" + response.optInt("unreadCount", 0) + " unread · latest announcements are available here after reconnecting.");
        long selectedId = selectedAnnouncementId;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject announcement = rows.optJSONObject(index);
            if (announcement == null) continue;
            long id = announcement.optLong("id", 0L);
            boolean read = announcement.optBoolean("is_read", false);
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(12), dp(10), dp(12), dp(10));
            card.setBackgroundColor(id == selectedId ? Color.rgb(60, 50, 20) : Color.rgb(25, 25, 25));
            String eventName = announcement.optString("event_name", "").trim();
            if (!eventName.isEmpty()) card.addView(text(eventName, 16, Color.rgb(237, 195, 53), true));
            card.addView(text(announcement.optString("message", ""), 14, Color.WHITE, false), marginParams(-1, -2, 0, 4, 0, 4));
            String published = announcement.optString("published_at", announcement.optString("created_at", ""));
            String detail = (read ? "Read" : "Unread") + " · Published " + formatTimestamp(published);
            String eventAt = announcement.optString("event_at", "");
            String eventZone = announcement.optString("event_time_zone", "Africa/Nairobi");
            if (!eventAt.isEmpty()) detail += "\nEvent starts " + formatTimestamp(eventAt, eventZone) + " · " + eventZone;
            card.addView(text(detail, 12, Color.LTGRAY, false));
            if (!read && id > 0) {
                Button markRead = button("MARK AS READ");
                card.addView(markRead, marginParams(-1, -2, 0, 5, 0, 0));
                markRead.setOnClickListener(view -> markAnnouncementRead(id));
            }
            announcementsList.addView(card, marginParams(-1, -2, 0, 0, 0, 8));
        }
    }

    private void markAnnouncementRead(long announcementId) {
        String bearer = TokenStore.read(this);
        if (bearer == null || announcementId <= 0) return;
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result result = Api.markAnnouncementRead(announcementId, bearer);
                runOnUiThread(() -> {
                    if (result.ok()) refreshCompanionData();
                    else if (announcementsStatusView != null) announcementsStatusView.setText(result.message("Could not update announcement status."));
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (announcementsStatusView != null) announcementsStatusView.setText("Could not update read status while offline.");
                });
            }
        });
    }

    private void renderSupportMessages(JSONObject response, String bearer) {
        if (supportMessages == null) return;
        supportMessages.removeAllViews();
        long accountId = TokenStore.accountUserId(bearer);
        java.util.HashSet<String> deliveredIds = new java.util.HashSet<>();
        org.json.JSONArray rows = response.optJSONArray("messages");
        if (rows != null) {
            for (int index = 0; index < rows.length(); index++) {
                JSONObject item = rows.optJSONObject(index);
                if (item == null) continue;
                String clientId = item.optString("client_message_id", "");
                if (!clientId.isEmpty()) {
                    deliveredIds.add(clientId);
                    SupportQueueStore.remove(this, clientId);
                }
                boolean mine = item.optLong("sender_id", 0L) == accountId;
                String speaker = mine ? "You" : "GOAL$GAMBIT Admin";
                String textValue = speaker + " · " + formatTimestamp(item.optString("created_at", ""))
                    + (mine && !item.isNull("read_at") ? " · Seen" : "") + "\n" + item.optString("message", "");
                TextView bubble = text(textValue, 14, Color.WHITE, false);
                bubble.setPadding(dp(10), dp(8), dp(10), dp(8));
                bubble.setBackgroundColor(mine ? Color.rgb(38, 43, 47) : Color.rgb(45, 39, 20));
                supportMessages.addView(bubble, marginParams(-1, -2, 0, 0, 0, 7));
            }
        }
        for (JSONObject pending : SupportQueueStore.pending(this, accountId)) {
            String id = pending.optString("clientMessageId", "");
            if (deliveredIds.contains(id)) continue;
            TextView bubble = text("You · Queued locally · not yet saved\n" + pending.optString("message", ""), 14, Color.LTGRAY, false);
            bubble.setPadding(dp(10), dp(8), dp(10), dp(8));
            bubble.setBackgroundColor(Color.rgb(55, 43, 25));
            supportMessages.addView(bubble, marginParams(-1, -2, 0, 0, 0, 7));
        }
        if (supportMessages.getChildCount() == 0) {
            supportMessages.addView(text("No support messages yet. Send a message to start a private conversation with the admin team.", 13, Color.LTGRAY, false));
        }
    }

    private void sendSupportMessage(Button button) {
        String message = supportComposer == null ? "" : supportComposer.getText().toString().trim();
        String subject = supportSubject == null ? "" : supportSubject.getText().toString().trim();
        String bearer = TokenStore.read(this);
        if (bearer == null || message.isEmpty()) {
            if (supportStatusView != null) supportStatusView.setText(bearer == null ? "Sign in before contacting support." : "Write a message first.");
            return;
        }
        if (message.length() > 2000 || subject.length() > 160) {
            supportStatusView.setText("Messages are limited to 2,000 characters and subjects to 160 characters.");
            return;
        }
        String[] categoryValues = {"general", "suggestion", "technical", "match_room_code", "account", "important"};
        int position = supportCategory == null ? 0 : supportCategory.getSelectedItemPosition();
        JSONObject payload = new JSONObject();
        String messageId = UUID.randomUUID().toString();
        try {
            payload.put("message", message);
            payload.put("clientMessageId", messageId);
            payload.put("category", categoryValues[Math.max(0, Math.min(position, categoryValues.length - 1))]);
            payload.put("subject", subject);
            SupportQueueStore.enqueue(this, TokenStore.accountUserId(bearer), payload);
        } catch (Exception error) {
            supportStatusView.setText("This message could not be safely queued on the device. Please try again.");
            return;
        }
        button.setEnabled(false);
        supportComposer.setText("");
        supportSubject.setText("");
        supportStatusView.setText("Sending to GOAL$GAMBIT support…");
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result result = Api.sendSupportMessage(payload, bearer);
                if (result.ok()) {
                    SupportQueueStore.remove(this, messageId);
                    runOnUiThread(() -> supportStatusView.setText("Saved by GOAL$GAMBIT support. Your message was delivered."));
                } else if (result.status == 400) {
                    SupportQueueStore.remove(this, messageId);
                    runOnUiThread(() -> {
                        supportComposer.setText(message);
                        supportSubject.setText(subject);
                        supportStatusView.setText(result.message("The server rejected this message."));
                    });
                } else {
                    enqueueSupportSync();
                    runOnUiThread(() -> supportStatusView.setText(result.status == 401 || result.status == 403
                        ? result.message("Sign in again before sending support messages.")
                        : "Message is queued securely on this device. The server has not confirmed delivery yet."));
                }
            } catch (Exception error) {
                enqueueSupportSync();
                runOnUiThread(() -> supportStatusView.setText("Offline or reconnecting. Your message is queued on this device and is not yet confirmed as delivered."));
            } finally {
                runOnUiThread(() -> {
                    button.setEnabled(true);
                    refreshCompanionData();
                });
            }
        });
    }

    private void enqueueSupportSync() {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(SupportMessageWorker.class)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(getApplicationContext()).enqueueUniqueWork(
            "gg-support-outbox", ExistingWorkPolicy.APPEND_OR_REPLACE, work);
    }

    private void openMatchHub() {
        String url = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/match-hub.html";
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    private String formatTimestamp(String value) {
        return formatTimestamp(value, null);
    }

    private String formatTimestamp(String value, String timeZone) {
        try {
            java.util.Date parsed = null;
            String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX"};
            for (String pattern : patterns) {
                try {
                    java.text.SimpleDateFormat parser = new java.text.SimpleDateFormat(pattern, java.util.Locale.US);
                    parser.setLenient(false);
                    parsed = parser.parse(value);
                    if (parsed != null) break;
                } catch (Exception ignoredPattern) {}
            }
            if (parsed == null) return value == null || value.isEmpty() ? "Time unavailable" : value;
            java.text.DateFormat format = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT);
            if (timeZone != null && !timeZone.isEmpty()) format.setTimeZone(java.util.TimeZone.getTimeZone(timeZone));
            return format.format(parsed);
        } catch (Exception ignored) {
            return value == null || value.isEmpty() ? "Time unavailable" : value;
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
            return;
        }
        syncCompanionInstallation();
        registerFirebaseToken();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            syncCompanionInstallation();
            registerFirebaseToken();
        } else {
            syncCompanionInstallation();
            statusView.setText("Notification permission was denied. Allow notifications for GOAL$GAMBIT Companion in Android Settings, then try again.");
        }
    }

    private void syncCompanionInstallation() {
        String bearer = TokenStore.read(this);
        if (bearer == null || bearer.trim().isEmpty()) return;
        CompanionHeartbeatWorker.schedule(this);
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result registered = Api.registerCompanion(this, bearer);
                if (registered.status == 401) return;
                if (!registered.ok()) {
                    Api.Result heartbeat = Api.heartbeatCompanion(this, bearer);
                    if (heartbeat.ok()) Api.updateCompanionNotificationStatus(this, bearer);
                }
            } catch (Exception ignored) {
                // A failed or offline registration is retried on the next app open or background check.
            }
        });
    }

    private void registerFirebaseToken() {
        statusView.setText("Registering this Android device for push notifications…");
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(this, task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    statusView.setText("Firebase Cloud Messaging is not configured for this Android build yet.");
                    return;
                }
                String fcmToken = task.getResult();
                API_EXECUTOR.execute(() -> {
                    try {
                        Api.Result result = Api.registerDevice(fcmToken, TokenStore.deviceId(this), TokenStore.read(this));
                        if (result.ok()) Api.registerCompanion(this, TokenStore.read(this));
                        runOnUiThread(() -> statusView.setText(result.ok()
                            ? (BuildConfig.DEBUG ? "Trial build" : "Release build") + " v" + BuildConfig.VERSION_NAME + " is registered for GOAL$GAMBIT notifications."
                            : result.message("Could not register this Android device.")));
                    } catch (Exception error) {
                        runOnUiThread(() -> statusView.setText("Device registration failed. Check the connection and try again."));
                    }
                });
            });
        } catch (Exception error) {
            statusView.setText("Firebase Cloud Messaging is not configured for this Android build yet.");
        }
    }

    private void disableNotifications(boolean signOut) {
        String bearer = TokenStore.read(this);
        statusView.setText(signOut ? "Signing out…" : "Disabling Android notifications…");
        API_EXECUTOR.execute(() -> {
            try {
                FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                    String fcmToken = task.isSuccessful() ? task.getResult() : null;
                    API_EXECUTOR.execute(() -> {
                        try {
                            Api.unregisterDevice(fcmToken, bearer);
                        } catch (Exception ignored) {}
                        if (signOut) {
                            try { Api.unregisterCompanion(this, bearer); } catch (Exception ignored) {}
                            CompanionHeartbeatWorker.cancel(this);
                            TokenStore.clear(this);
                        }
                        try { FirebaseMessaging.getInstance().deleteToken(); } catch (Exception ignored) {}
                        runOnUiThread(() -> {
                            statusView.setText(signOut ? "Signed out. This device's push subscription was disabled where the server was reachable."
                                : "Notifications disabled on this device.");
                            if (signOut) renderAccountState();
                        });
                    });
                });
            } catch (Exception ignored) {
                try {
                    if (signOut) {
                        try { Api.unregisterCompanion(this, bearer); } catch (Exception ignoredUnregister) {}
                        CompanionHeartbeatWorker.cancel(this);
                        TokenStore.clear(this);
                    }
                    FirebaseMessaging.getInstance().deleteToken();
                } catch (Exception ignoredAgain) {}
                runOnUiThread(() -> {
                    statusView.setText(signOut ? "Signed out. The server could not be reached to unregister this device."
                        : "The server could not be reached. Notifications may remain registered until the next connection.");
                    if (signOut) renderAccountState();
                });
            }
        });
    }

    private void addMatchLoading(long matchId) {
        TextView match = text("Loading match " + matchId + "…", 15, Color.WHITE, false);
        match.setBackgroundColor(Color.rgb(22, 22, 22));
        match.setPadding(dp(14), dp(14), dp(14), dp(14));
        content.addView(match, marginParams(-1, -2, 0, 0, 0, 10));
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result result = Api.getMatch(matchId, TokenStore.read(this));
                JSONObject data = result.json.optJSONObject("match");
                runOnUiThread(() -> {
                    if (!result.ok() || data == null) {
                        match.setText(result.message("Could not load this match."));
                        return;
                    }
                    boolean sender = data.optBoolean("youAreSender", false);
                    boolean codeSent = data.optBoolean("codeSent", false);
                    String code = data.optString("room_code", "");
                    String opponent = data.optString("opponent", "your opponent");
                    if (!sender && codeSent && !code.isEmpty()) {
                        match.setText("Room code from " + opponent + "\n\n" + code);
                        Button confirm = button("I RECEIVED THE CODE");
                        content.addView(confirm, marginParams(-1, -2, 0, 0, 0, 12));
                        confirm.setOnClickListener(view -> confirmReceipt(matchId, confirm, match));
                    } else if (sender) {
                        match.setText("You are the room-code sender. While eFootball is open, pull down the notification shade, expand the match alert, tap REPLY, enter the room code, then tap Send on your keyboard.");
                    } else {
                        match.setText("Your opponent has not sent the room code yet.");
                    }
                    Button openWeb = button("OPEN MATCH HUB");
                    content.addView(openWeb, marginParams(-1, -2, 0, 0, 0, 10));
                    openWeb.setOnClickListener(view -> {
                        String url = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/match-hub.html?matchId=" + matchId;
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    });
                });
            } catch (Exception error) {
                runOnUiThread(() -> match.setText("Could not reach the server. Check your connection and retry."));
            }
        });
    }

    private void loadMatch(long matchId) {
        if (content == null || TokenStore.read(this) == null) return;
        renderAccountState();
    }

    private void confirmReceipt(long matchId, Button button, TextView match) {
        button.setEnabled(false);
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result result = Api.confirmRoomCode(matchId, TokenStore.read(this));
                runOnUiThread(() -> {
                    button.setEnabled(true);
                    statusView.setText(result.ok() ? "Receipt confirmed. Your opponent has been notified."
                        : result.message("Could not confirm receipt."));
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    button.setEnabled(true);
                    statusView.setText("Network unavailable. Try confirming receipt again when connected.");
                });
            }
        });
    }

    private EditText edit(String hint) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setHintTextColor(Color.GRAY);
        input.setTextColor(Color.WHITE);
        input.setBackgroundColor(Color.rgb(30, 30, 30));
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        return input;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.rgb(20, 20, 20));
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(237, 195, 53)));
        return button;
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
        return view;
    }

    private LinearLayout.LayoutParams params(int width, int height) {
        return new LinearLayout.LayoutParams(width, height);
    }

    private LinearLayout.LayoutParams marginParams(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
