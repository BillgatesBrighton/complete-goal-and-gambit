package com.goalgambit.companion;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
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
import android.widget.CheckBox;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    static final String ACTION_PUSH_RECEIVED = "com.goalgambit.companion.PUSH_RECEIVED";
    private static final ExecutorService API_EXECUTOR = Executors.newSingleThreadExecutor();
    private LinearLayout content;
    private ScrollView screenScroll;
    private TextView statusView;
    private TextView welcomeGreetingView;
    private TextView welcomeNameView;
    private TextView serviceStatusView;
    private TextView chessEngineStatusView;
    private TextView upcomingStatusView;
    private TextView announcementsStatusView;
    private TextView supportStatusView;
    private View chessMatchNoticeCard;
    private LinearLayout announcementsList;
    private LinearLayout supportMessages;
    private Button notificationsShortcut;
    private Button supportShortcut;
    private EditText supportSubject;
    private EditText supportComposer;
    private Spinner supportCategory;
    private long selectedMatchId;
    private long selectedChessMatchId;
    private String selectedChessMatchEventKey;
    private long selectedAnnouncementId;
    private long selectedPushEventId;
    private boolean companionRefreshInFlight;
    private boolean pushReceiverRegistered;
    private boolean companionTermsAccepted;
    private String latestCompanionVersion;
    private ChessEngineSocket chessEngineSocket;
    private String chessEngineToken;
    private String termsStatusInFlightToken;
    private String termsStatusCheckedToken;

    private final BroadcastReceiver pushReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, Intent intent) {
            refreshCompanionData();
            refreshNotificationCount();
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Notifications.createChannel(this);
        selectedMatchId = getIntent().getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        selectedChessMatchEventKey = getIntent().getStringExtra(Notifications.EXTRA_EVENT_KEY);
        selectedChessMatchId = getIntent().getLongExtra(Notifications.EXTRA_CHESS_MATCH_ID,
            Notifications.chessMatchIdFromEventKey(selectedChessMatchEventKey));
        selectedAnnouncementId = getIntent().getLongExtra(Notifications.EXTRA_ANNOUNCEMENT_ID, 0);
        selectedPushEventId = getIntent().getLongExtra(Notifications.EXTRA_PUSH_EVENT_ID, 0);
        buildScreen();
        renderAccountState();
        markSelectedNotificationRead();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!pushReceiverRegistered) {
            IntentFilter filter = new IntentFilter(ACTION_PUSH_RECEIVED);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(pushReceiver, filter, RECEIVER_NOT_EXPORTED);
            else registerReceiver(pushReceiver, filter);
            pushReceiverRegistered = true;
        }
        String bearer = TokenStore.read(this);
        if (bearer != null && companionTermsAccepted) {
            ensureChessEngineSocket(bearer);
            syncCompanionInstallation();
            if (!SupportQueueStore.pending(this, TokenStore.accountUserId(bearer)).isEmpty()) enqueueSupportSync();
            refreshCompanionData();
            refreshNotificationCount();
        }
    }

    @Override
    protected void onPause() {
        if (pushReceiverRegistered) {
            unregisterReceiver(pushReceiver);
            pushReceiverRegistered = false;
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopChessEngineSocket();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        selectedMatchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        selectedChessMatchEventKey = intent.getStringExtra(Notifications.EXTRA_EVENT_KEY);
        selectedChessMatchId = intent.getLongExtra(Notifications.EXTRA_CHESS_MATCH_ID,
            Notifications.chessMatchIdFromEventKey(selectedChessMatchEventKey));
        selectedAnnouncementId = intent.getLongExtra(Notifications.EXTRA_ANNOUNCEMENT_ID, 0);
        selectedPushEventId = intent.getLongExtra(Notifications.EXTRA_PUSH_EVENT_ID, 0);
        markSelectedNotificationRead();
        if (selectedMatchId > 0) loadMatch(selectedMatchId);
        if (selectedChessMatchId > 0 && companionTermsAccepted) addChessMatchNotice(selectedChessMatchId, selectedChessMatchEventKey);
        refreshCompanionData();
        refreshNotificationCount();
        if (intent.getBooleanExtra(Notifications.EXTRA_OPEN_SUPPORT, false) && supportMessages != null) {
            screenScroll.post(() -> screenScroll.smoothScrollTo(0, supportMessages.getTop()));
        }
        if (selectedAnnouncementId > 0 && announcementsList != null) {
            screenScroll.post(() -> screenScroll.smoothScrollTo(0, announcementsList.getTop()));
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
        TextView subtitle = text("Chess engine and notification companion · " + buildLabel + " · v" + BuildConfig.VERSION_NAME, 13, Color.LTGRAY, false);
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
            stopChessEngineSocket();
            companionTermsAccepted = false;
            termsStatusCheckedToken = null;
            if (welcomeGreetingView != null) welcomeGreetingView.setVisibility(View.GONE);
            if (welcomeNameView != null) welcomeNameView.setVisibility(View.GONE);
            if (welcomeNameView != null) welcomeNameView.setText("player");
            showLogin();
        } else {
            if (welcomeGreetingView != null) welcomeGreetingView.setVisibility(View.VISIBLE);
            if (welcomeNameView != null) welcomeNameView.setVisibility(View.VISIBLE);
            String username = TokenStore.accountUsername(bearer);
            if (!username.isEmpty() && welcomeNameView != null) welcomeNameView.setText(username);
            if (companionTermsAccepted && bearer.equals(termsStatusCheckedToken)) {
                showSignedIn();
            } else {
                checkCompanionTerms(bearer);
            }
        }
    }

    private void checkCompanionTerms(String bearer) {
        if (bearer.equals(termsStatusInFlightToken)) return;
        termsStatusInFlightToken = bearer;
        statusView.setText("Checking your current Terms and Conditions…");
        API_EXECUTOR.execute(() -> {
            Api.Result result = null;
            try { result = Api.getCompanionStatus(bearer); } catch (Exception ignored) {}
            Api.Result status = result;
            runOnUiThread(() -> {
                if (bearer.equals(termsStatusInFlightToken)) termsStatusInFlightToken = null;
                if (TokenStore.read(this) == null || !bearer.equals(TokenStore.read(this))) return;
                termsStatusCheckedToken = bearer;
                content.removeViews(5, Math.max(0, content.getChildCount() - 5));
                if (status == null || !status.ok()) {
                    showTermsStatusUnavailable(status == null ? "Could not reach the GOAL$GAMBIT server." : status.message("Could not verify your account setup."));
                    return;
                }
                companionTermsAccepted = status.json.optBoolean("termsAccepted", false);
                JSONObject apk = status.json.optJSONObject("apk");
                latestCompanionVersion = apk == null ? null : apk.optString("version", null);
                if (companionTermsAccepted) {
                    showSignedIn();
                    syncCompanionInstallation();
                } else {
                    showTermsAcceptance(status.json.optString("termsUrl", ""));
                }
            });
        });
    }

    private void showTermsAcceptance(String termsUrl) {
        statusView.setText("Review and accept the current Terms and Conditions to finish companion setup.");
        TextView explanation = text("Your acceptance is saved securely to your signed-in GOAL$GAMBIT account. The app will register this installation after you accept.", 14, Color.LTGRAY, false);
        content.addView(explanation, marginParams(-1, -2, 0, 0, 0, 12));
        Button readTerms = button("READ TERMS AND CONDITIONS");
        content.addView(readTerms, marginParams(-1, -2, 0, 0, 0, 12));
        String safeTermsUrl = termsUrl.startsWith("https://") ? termsUrl : "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/terms.html";
        readTerms.setOnClickListener(view -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(safeTermsUrl))));
        CheckBox agree = new CheckBox(this);
        agree.setText("I have read and agree to the GOAL$GAMBIT Terms and Conditions.");
        agree.setTextColor(Color.WHITE);
        agree.setButtonTintList(android.content.res.ColorStateList.valueOf(Color.rgb(237, 195, 53)));
        content.addView(agree, marginParams(-1, -2, 0, 0, 0, 10));
        Button accept = button("ACCEPT AND CONTINUE");
        accept.setEnabled(false);
        content.addView(accept, marginParams(-1, -2, 0, 0, 0, 10));
        agree.setOnCheckedChangeListener((buttonView, checked) -> accept.setEnabled(checked));
        accept.setOnClickListener(view -> {
            if (!agree.isChecked()) return;
            accept.setEnabled(false);
            readTerms.setEnabled(false);
            statusView.setText("Saving your acceptance securely…");
            String bearer = TokenStore.read(this);
            API_EXECUTOR.execute(() -> {
                Api.Result accepted = null;
                try { accepted = Api.acceptCompanionTerms(bearer); } catch (Exception ignored) {}
                Api.Result response = accepted;
                runOnUiThread(() -> {
                    if (bearer == null || !bearer.equals(TokenStore.read(this))) return;
                    if (response == null || !response.ok() || !response.json.optBoolean("accepted", false)) {
                        statusView.setText(response == null ? "Could not reach the server. Your acceptance was not confirmed; please retry." : response.message("Your acceptance was not saved. Please retry."));
                        accept.setEnabled(agree.isChecked());
                        readTerms.setEnabled(true);
                        return;
                    }
                    companionTermsAccepted = true;
                    termsStatusCheckedToken = bearer;
                    Toast.makeText(this, "Terms acceptance saved.", Toast.LENGTH_SHORT).show();
                    renderAccountState();
                    syncCompanionInstallation();
                });
            });
        });
        Button signOut = button("SIGN OUT");
        content.addView(signOut, marginParams(-1, -2, 0, 0, 0, 0));
        signOut.setOnClickListener(view -> disableNotifications(true));
    }

    private void showTermsStatusUnavailable(String message) {
        statusView.setText("Could not confirm your terms status. Companion setup remains paused until the server responds.");
        TextView detail = text(message, 13, Color.LTGRAY, false);
        content.addView(detail, marginParams(-1, -2, 0, 0, 0, 12));
        Button retry = button("RETRY");
        content.addView(retry, marginParams(-1, -2, 0, 0, 0, 10));
        retry.setOnClickListener(view -> {
            termsStatusCheckedToken = null;
            renderAccountState();
        });
        Button signOut = button("SIGN OUT");
        content.addView(signOut, marginParams(-1, -2, 0, 0, 0, 0));
        signOut.setOnClickListener(view -> disableNotifications(true));
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
        statusView.setText("GOAL$GAMBIT | Compete. Win. Earn.");
        addCompanionUpdateNotice();

        LinearLayout quickActions = new LinearLayout(this);
        quickActions.setOrientation(LinearLayout.HORIZONTAL);
        notificationsShortcut = button("NOTIFICATIONS");
        Button settings = button("SETTINGS");
        quickActions.addView(notificationsShortcut, new LinearLayout.LayoutParams(0, dp(50), 1));
        LinearLayout.LayoutParams settingsParams = new LinearLayout.LayoutParams(0, dp(50), 1);
        settingsParams.setMargins(dp(8), 0, 0, 0);
        quickActions.addView(settings, settingsParams);
        content.addView(quickActions, marginParams(-1, -2, 0, 0, 0, 8));
        notificationsShortcut.setOnClickListener(view -> startActivity(new Intent(this, NotificationInboxActivity.class)));
        settings.setOnClickListener(view -> startActivity(new Intent(this, SettingsActivity.class)));

        LinearLayout secondActions = new LinearLayout(this);
        secondActions.setOrientation(LinearLayout.HORIZONTAL);
        supportShortcut = button("SUPPORT INBOX");
        Button help = button("HELP & FAQ");
        secondActions.addView(supportShortcut, new LinearLayout.LayoutParams(0, dp(50), 1));
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(0, dp(50), 1);
        helpParams.setMargins(dp(8), 0, 0, 0);
        secondActions.addView(help, helpParams);
        content.addView(secondActions, marginParams(-1, -2, 0, 0, 0, 12));
        supportShortcut.setOnClickListener(view -> {
            if (supportMessages != null) screenScroll.smoothScrollTo(0, supportMessages.getTop());
        });
        help.setOnClickListener(view -> startActivity(new Intent(this, HelpActivity.class)));

        Button signOut = button("SIGN OUT");
        content.addView(signOut, marginParams(-1, -2, 0, 0, 0, 14));
        signOut.setOnClickListener(view -> disableNotifications(true));
        serviceStatusView = text("Checking companion services…", 13, Color.LTGRAY, false);
        chessEngineStatusView = text("Native chess engine: connecting…", 13, Color.LTGRAY, false);
        content.addView(chessEngineStatusView, marginParams(-1, -2, 0, 0, 0, 9));
        upcomingStatusView = text("Checking upcoming games…", 15, Color.WHITE, false);
        upcomingStatusView.setPadding(dp(12), dp(12), dp(12), dp(12));
        upcomingStatusView.setBackgroundColor(Color.rgb(25, 25, 25));
        content.addView(serviceStatusView, marginParams(-1, -2, 0, 0, 0, 10));
        ensureChessEngineSocket(TokenStore.read(this));
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
        String supportCategoryExtra = getIntent().getStringExtra("supportCategory");
        if ("suggestion".equals(supportCategoryExtra) && supportCategory != null) supportCategory.setSelection(1);
        if (selectedMatchId > 0) addMatchLoading(selectedMatchId);
        if (selectedChessMatchId > 0) addChessMatchNotice(selectedChessMatchId, selectedChessMatchEventKey);
        refreshCompanionData();
    }

    private void addCompanionUpdateNotice() {
        if (compareVersionNumbers(latestCompanionVersion, BuildConfig.VERSION_NAME) <= 0) return;

        LinearLayout notice = new LinearLayout(this);
        notice.setOrientation(LinearLayout.VERTICAL);
        notice.setPadding(dp(14), dp(12), dp(14), dp(12));
        notice.setBackgroundColor(Color.rgb(37, 31, 12));
        TextView heading = text("APP UPDATE AVAILABLE", 15, Color.rgb(237, 195, 53), true);
        TextView detail = text("Version " + latestCompanionVersion + " is ready. Update GOAL$GAMBIT Companion to get the latest fixes.", 13, Color.WHITE, false);
        Button download = button("DOWNLOAD LATEST ANDROID APP");
        notice.addView(heading, marginParams(-1, -2, 0, 0, 0, 5));
        notice.addView(detail, marginParams(-1, -2, 0, 0, 0, 9));
        notice.addView(download, marginParams(-1, -2, 0, 0, 0, 0));
        content.addView(notice, marginParams(-1, -2, 0, 0, 0, 12));
        download.setOnClickListener(view -> {
            String url = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-companion.apk?download=" + System.currentTimeMillis();
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        });
    }

    private static int compareVersionNumbers(String left, String right) {
        Matcher a = Pattern.compile("\\d+").matcher(left == null ? "" : left);
        Matcher b = Pattern.compile("\\d+").matcher(right == null ? "" : right);
        java.util.ArrayList<Long> first = new java.util.ArrayList<>();
        java.util.ArrayList<Long> second = new java.util.ArrayList<>();
        while (a.find()) {
            try { first.add(Long.parseLong(a.group())); } catch (NumberFormatException ignored) { return 0; }
        }
        while (b.find()) {
            try { second.add(Long.parseLong(b.group())); } catch (NumberFormatException ignored) { return 0; }
        }
        if (first.isEmpty() || second.isEmpty()) return 0;
        for (int index = 0; index < Math.max(first.size(), second.size()); index++) {
            long leftPart = index < first.size() ? first.get(index) : 0L;
            long rightPart = index < second.size() ? second.get(index) : 0L;
            if (leftPart != rightPart) return leftPart < rightPart ? -1 : 1;
        }
        return 0;
    }

    private void refreshCompanionData() {
        String bearer = TokenStore.read(this);
        if (bearer == null || !companionTermsAccepted || companionRefreshInFlight || announcementsList == null || supportMessages == null) return;
        companionRefreshInFlight = true;
        API_EXECUTOR.execute(() -> {
            Api.Result announcementResult = null;
            Api.Result upcomingResult = null;
            Api.Result supportResult = null;
            Api.Result supportUnreadResult = null;
            Api.Result profileResult = null;
            Api.Result pushStatusResult = null;
            try { announcementResult = Api.getAnnouncements(bearer); } catch (Exception ignored) {}
            try { upcomingResult = Api.getUpcomingGameStatus(bearer); } catch (Exception ignored) {}
            try { supportUnreadResult = Api.getSupportUnreadCount(bearer); } catch (Exception ignored) {}
            try { supportResult = Api.getSupportMessages(bearer); } catch (Exception ignored) {}
            try { profileResult = Api.getCompanionProfile(bearer); } catch (Exception ignored) {}
            try { pushStatusResult = Api.getPushStatus(bearer); } catch (Exception ignored) {}
            final Api.Result announcements = announcementResult;
            final Api.Result upcoming = upcomingResult;
            final Api.Result support = supportResult;
            final Api.Result supportUnread = supportUnreadResult;
            final Api.Result profile = profileResult;
            final Api.Result pushStatus = pushStatusResult;
            runOnUiThread(() -> {
                companionRefreshInFlight = false;
                if (TokenStore.read(this) == null || !bearer.equals(TokenStore.read(this))) return;
                if (profile != null && profile.ok() && welcomeNameView != null) {
                    String username = profile.json.optString("username", "").trim();
                    if (!username.isEmpty()) welcomeNameView.setText(username);
                }
                boolean connected = announcements != null && announcements.ok()
                    && upcoming != null && upcoming.ok() && support != null && support.ok();
                if (serviceStatusView != null) {
                    if (!connected) {
                        serviceStatusView.setText("Offline or reconnecting · unsent support messages stay queued on this device.");
                    } else {
                        int activeDevices = pushStatus != null && pushStatus.ok() ? pushStatus.json.optInt("activeAndroidDevices", 0) : -1;
                        boolean alertsAllowed = areNotificationsAllowed();
                        String registered = activeDevices < 0 ? "device status unavailable"
                            : activeDevices == 0 ? "no registered device" : activeDevices + (activeDevices == 1 ? " companion device registered" : " companion devices registered");
                        serviceStatusView.setText("Connected · " + registered + (alertsAllowed ? " · Android alerts allowed" : " · notifications need permission"));
                    }
                }
                if (supportUnread != null && supportUnread.ok() && supportShortcut != null) {
                    int count = supportUnread.json.optInt("unreadCount", 0);
                    supportShortcut.setText(count > 0 ? "SUPPORT INBOX · " + count + " NEW" : "SUPPORT INBOX");
                }
                if (announcements != null && announcements.ok()) renderAnnouncements(announcements.json);
                else if (announcementsStatusView != null) announcementsStatusView.setText("Announcements could not be refreshed. Try again when connected.");
                if (upcoming != null && upcoming.ok()) {
                    boolean hasUpcoming = upcoming.json.optBoolean("hasUpcomingGames", false);
                    JSONObject nextGame = upcoming.json.optJSONObject("nextScheduledGame");
                    if (upcomingStatusView != null) {
                        if (!hasUpcoming) upcomingStatusView.setText("No upcoming games are confirmed for your account right now.");
                        else if (nextGame != null && !nextGame.optString("startsAt", "").isEmpty()) {
                            upcomingStatusView.setText("Your next scheduled game · " + nextGame.optString("eventName", "Match") + "\n" + formatTimestamp(nextGame.optString("startsAt", ""), nextGame.optString("timeZone", "Africa/Nairobi")));
                        } else {
                            upcomingStatusView.setText("You have upcoming games. Open Match Hub to check your current match details.");
                        }
                    }
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

    private void refreshNotificationCount() {
        String bearer = TokenStore.read(this);
        if (bearer == null || !companionTermsAccepted || notificationsShortcut == null) return;
        API_EXECUTOR.execute(() -> {
            try {
                Api.Result result = Api.getNotificationHistory(bearer, 1, null);
                if (!result.ok()) return;
                int unread = result.json.optInt("unreadCount", 0);
                runOnUiThread(() -> {
                    if (notificationsShortcut != null) notificationsShortcut.setText(unread > 0 ? "NOTIFICATIONS · " + unread : "NOTIFICATIONS");
                });
            } catch (Exception ignored) {}
        });
    }

    private void markSelectedNotificationRead() {
        long eventId = selectedPushEventId;
        selectedPushEventId = 0;
        String bearer = TokenStore.read(this);
        if (eventId <= 0 || bearer == null) return;
        API_EXECUTOR.execute(() -> {
            try { Api.markNotificationRead(eventId, bearer); } catch (Exception ignored) {}
            refreshNotificationCount();
        });
    }

    private boolean areNotificationsAllowed() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        android.app.NotificationManager manager = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
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

    private void ensureChessEngineSocket(String bearer) {
        if (bearer == null || bearer.trim().isEmpty() || !companionTermsAccepted) {
            stopChessEngineSocket();
            return;
        }
        if (chessEngineSocket != null && bearer.equals(chessEngineToken)) return;
        stopChessEngineSocket();
        chessEngineToken = bearer;
        chessEngineSocket = new ChessEngineSocket(bearer, message -> {
            if (chessEngineStatusView != null) chessEngineStatusView.setText("Native chess engine: " + message);
        });
        chessEngineSocket.connect();
    }

    private void stopChessEngineSocket() {
        if (chessEngineSocket != null) {
            chessEngineSocket.close();
            chessEngineSocket = null;
        }
        chessEngineToken = null;
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

    private void disableNotifications(boolean signOut) {
        if (signOut) stopChessEngineSocket();
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

    private void addChessMatchNotice(long matchId, String eventKey) {
        if (matchId <= 0 || content == null || !companionTermsAccepted) return;
        if (chessMatchNoticeCard != null && chessMatchNoticeCard.getParent() instanceof ViewGroup) {
            ((ViewGroup) chessMatchNoticeCard.getParent()).removeView(chessMatchNoticeCard);
        }
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        card.setBackgroundColor(Color.rgb(25, 25, 25));
        String message = eventKey != null && eventKey.contains(":finished:")
            ? "Your chess match has finished. Open the website board to view the official result."
            : "It is your turn in chess. Continue on the GOAL$GAMBIT website board.";
        card.addView(text("CHESS MATCH UPDATE · #" + matchId, 16, Color.rgb(237, 195, 53), true), marginParams(-1, -2, 0, 0, 0, 5));
        card.addView(text(message, 14, Color.LTGRAY, false), marginParams(-1, -2, 0, 0, 0, 8));
        Button openBoard = button("OPEN CHESSBOARD");
        card.addView(openBoard, marginParams(-1, -2, 0, 0, 0, 0));
        openBoard.setOnClickListener(view -> {
            String url = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/board.html?matchId=" + matchId;
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        });
        content.addView(card, marginParams(-1, -2, 0, 0, 0, 12));
        chessMatchNoticeCard = card;
        if (screenScroll != null) screenScroll.post(() -> screenScroll.smoothScrollTo(0, card.getTop()));
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
