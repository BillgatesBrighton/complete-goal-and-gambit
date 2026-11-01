package com.goalgambit.trial;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.Manifest;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class MainActivity extends Activity implements ChessRealtimeClient.Listener {
    private static final int BG = Color.rgb(8, 8, 8);
    private static final int PANEL = Color.rgb(22, 22, 22);
    private static final int GOLD = Color.rgb(239, 198, 55);
    private static final int MUTED_GOLD = Color.rgb(195, 168, 88);
    private static final int TEXT = Color.rgb(244, 242, 236);
    private static final int SUBTLE = Color.rgb(179, 179, 179);
    private static final String TERMS_URL = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/pages/terms.html";
    private static final String ALERT_CHANNEL_ID = "gg_player_alerts";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 501;
    private static final String OPEN_NOTIFICATIONS_EXTRA = "open_notifications";

    private final ExecutorService requests = Executors.newFixedThreadPool(3);
    private final Set<String> legalDestinations = new HashSet<>();
    private final Set<String> shownNotificationKeys = new HashSet<>();
    private LinearLayout root;
    private LinearLayout content;
    private LinearLayout navigation;
    private ScrollView pageScroll;
    private TextView connectionStatus;
    private TextView pageStatus;
    private String token;
    private String currentScreen = "home";
    private JSONObject currentUser = new JSONObject();
    private boolean registering;
    private boolean requestBusy;
    private boolean moveBusy;
    private boolean socketAvailable;
    private long currentChessMatchId;
    private long selectedTournamentId;
    private String currentPlayerColor = "w";
    private String selectedSquare;
    private JSONObject currentChessState;
    private JSONObject currentEfootballMatch;
    private String chessMatchType = "ranked";
    private String chessSpeed = "rapid";
    private String chessTimeControl = "10:00";
    private int chessStake = 20;
    private ChessBoardView chessBoard;
    private TextView chessClockInfo;
    private TextView chessMatchStatus;
    private LinearLayout activeMatchesList;
    private LinearLayout chessHistoryList;
    private LinearLayout chessScheduleList;
    private LinearLayout notificationList;
    private ChessRealtimeClient chessSocket;
    private Spinner registrationGame;
    private EditText registrationRating;
    private EditText supportSubject;
    private EditText supportMessage;
    private Spinner supportCategory;
    private String pendingRegistrationMessage = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().getDecorView().setSystemUiVisibility(0);
        buildShell();
        token = SessionStore.read(this);
        if (token == null || token.trim().isEmpty()) {
            token = null;
            renderAuth();
        } else {
            validateSession();
        }
    }

    @Override
    protected void onDestroy() {
        if (chessSocket != null) chessSocket.close();
        requests.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (token != null && "notifications".equals(currentScreen) && notificationList != null) {
            loadNotifications(notificationList);
        }
    }

    private void buildShell() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setPadding(dp(18), dp(16), dp(18), dp(8));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOrientation(LinearLayout.HORIZONTAL);
        TextView logo = text("GOAL$GAMBIT", 25, GOLD, true);
        try {
            Typeface pacifico = Typeface.createFromAsset(getAssets(), "fonts/Pacifico-Regular.ttf");
            logo.setTypeface(Typeface.create(pacifico, Typeface.BOLD));
        } catch (RuntimeException ignored) {}
        header.addView(logo, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView playerBadge = text("PLAYER", 10, BG, true);
        playerBadge.setGravity(Gravity.CENTER);
        playerBadge.setPadding(dp(10), dp(5), dp(10), dp(5));
        playerBadge.setBackground(round(GOLD, dp(12), 0, 0));
        header.addView(playerBadge, wrap());
        root.addView(header, matchWrap());

        TextView subtitle = text("COMPETE · PLAY · FOLLOW YOUR GAMES", 10, SUBTLE, true);
        subtitle.setLetterSpacing(0.08f);
        root.addView(subtitle, margins(-1, -2, 0, dp(2), 0, dp(10)));
        connectionStatus = text("Connecting securely…", 12, SUBTLE, false);
        root.addView(connectionStatus, margins(-1, -2, 0, 0, 0, dp(10)));

        pageScroll = new ScrollView(this);
        pageScroll.setFillViewport(true);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(0, 0, 0, dp(12));
        pageScroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        root.addView(pageScroll, new LinearLayout.LayoutParams(-1, 0, 1f));

        navigation = new LinearLayout(this);
        navigation.setOrientation(LinearLayout.VERTICAL);
        navigation.setPadding(0, dp(5), 0, dp(2));
        navigation.setVisibility(View.GONE);
        root.addView(navigation, matchWrap());
        setContentView(root);
    }

    private void renderAuth() {
        currentScreen = "auth";
        navigation.setVisibility(View.GONE);
        content.removeAllViews();
        addHeading(registering ? "Create your player account" : "Welcome back", "Sign in to the existing GOAL$GAMBIT service. This trial uses real account authentication.");

        EditText username = input("Username", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        content.addView(username, margins(-1, dp(52), 0, dp(14), 0, 0));
        EditText phone = null;
        EditText email = null;
        if (registering) {
            phone = input("Phone number", InputType.TYPE_CLASS_PHONE);
            content.addView(phone, margins(-1, dp(52), 0, dp(10), 0, 0));
            email = input("Email address", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
            content.addView(email, margins(-1, dp(52), 0, dp(10), 0, 0));

            TextView gameLabel = text("GAME ACCESS", 12, MUTED_GOLD, true);
            content.addView(gameLabel, margins(-1, -2, 0, dp(10), 0, dp(5)));
            registrationGame = new Spinner(this);
            ArrayAdapter<String> gameAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item,
                new String[] { "Chess", "eFootball", "Both" });
            gameAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            registrationGame.setAdapter(gameAdapter);
            registrationGame.setBackground(round(Color.rgb(36, 36, 36), dp(7), Color.rgb(74, 67, 48), dp(1)));
            content.addView(registrationGame, margins(-1, dp(50), 0, 0, 0, dp(10)));

            registrationRating = input("Chess rating (100–3000)", InputType.TYPE_CLASS_NUMBER);
            registrationRating.setText("1200");
            content.addView(registrationRating, margins(-1, dp(52), 0, 0, 0, dp(8)));
        } else {
            registrationGame = null;
            registrationRating = null;
        }

        EditText password = input("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        content.addView(password, margins(-1, dp(52), 0, registering ? 0 : dp(10), 0, 0));
        if (registering) {
            TextView emailNotice = text("A verified email address is required. GOAL$GAMBIT will send the verification email using its existing account flow.", 12, SUBTLE, false);
            content.addView(emailNotice, margins(-1, -2, 0, dp(10), 0, 0));
            CheckBox terms = new CheckBox(this);
            terms.setText("I have read and agree to the GOAL$GAMBIT terms");
            terms.setTextColor(TEXT);
            terms.setButtonTintList(android.content.res.ColorStateList.valueOf(GOLD));
            content.addView(terms, margins(-1, -2, 0, dp(4), 0, dp(4)));
            Button readTerms = secondaryButton("READ TERMS");
            content.addView(readTerms, margins(-1, dp(46), 0, 0, 0, dp(12)));
            readTerms.setOnClickListener(v -> openUrl(TERMS_URL));

            Button create = primaryButton("CREATE PLAYER ACCOUNT");
            content.addView(create, margins(-1, dp(54), 0, 0, 0, dp(8)));
            EditText finalPhone = phone;
            EditText finalEmail = email;
            create.setOnClickListener(v -> submitRegistration(username, finalPhone, finalEmail, password, terms, create));
        } else {
            Button signIn = primaryButton("SIGN IN");
            content.addView(signIn, margins(-1, dp(54), 0, dp(12), 0, dp(8)));
            signIn.setOnClickListener(v -> submitLogin(username, password, signIn));
        }

        Button switchMode = secondaryButton(registering ? "I ALREADY HAVE AN ACCOUNT" : "CREATE A NEW ACCOUNT");
        content.addView(switchMode, margins(-1, dp(48), 0, 0, 0, dp(14)));
        switchMode.setOnClickListener(v -> {
            registering = !registering;
            renderAuth();
        });
        TextView privacy = text("Your session token is encrypted with Android Keystore. The trial app has no administrator tools.", 11, SUBTLE, false);
        content.addView(privacy, margins(-1, -2, 0, dp(8), 0, dp(4)));
        pageStatus = text("", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, 0));
    }

    private void submitLogin(EditText username, EditText password, Button button) {
        String name = username.getText().toString().trim();
        String pass = password.getText().toString();
        if (name.isEmpty() || pass.isEmpty()) {
            showMessage("Enter your username and password.", true);
            return;
        }
        button.setEnabled(false);
        showMessage("Signing in securely…", false);
        JSONObject body = new JSONObject();
        try { body.put("username", name); body.put("password", pass); }
        catch (Exception ignored) {}
        request("POST", "/api/auth/login", null, body, result -> {
            button.setEnabled(true);
            String receivedToken = result.object.optString("token", "");
            if (!result.ok() || receivedToken.isEmpty()) {
                showMessage(result.message("Sign in failed. Check your details and try again."), true);
                return;
            }
            if (!SessionStore.save(this, receivedToken)) {
                showMessage("The secure session could not be saved on this device.", true);
                return;
            }
            token = receivedToken;
            currentUser = result.object.optJSONObject("user") == null ? new JSONObject() : result.object.optJSONObject("user");
            pendingRegistrationMessage = "";
            enterPlayerApp();
        });
    }

    private void submitRegistration(EditText username, EditText phone, EditText email,
                                    EditText password, CheckBox terms, Button button) {
        String name = username.getText().toString().trim();
        String phoneValue = phone.getText().toString().trim();
        String emailValue = email.getText().toString().trim();
        String passwordValue = password.getText().toString();
        String gameLabel = String.valueOf(registrationGame.getSelectedItem());
        String game = "Chess".equals(gameLabel) ? "chess" : "eFootball".equals(gameLabel) ? "konami" : "both";
        if (!terms.isChecked()) {
            showMessage("Please read and accept the terms before creating an account.", true);
            return;
        }
        JSONObject body = new JSONObject();
        try {
            body.put("username", name);
            body.put("phone", phoneValue);
            body.put("email", emailValue);
            body.put("password", passwordValue);
            body.put("game", game);
            if (!"konami".equals(game)) body.put("chessRating", registrationRating.getText().toString().trim());
        } catch (Exception ignored) {}
        button.setEnabled(false);
        showMessage("Creating your account through GOAL$GAMBIT…", false);
        request("POST", "/api/auth/register", null, body, result -> {
            button.setEnabled(true);
            String receivedToken = result.object.optString("token", "");
            if (!result.ok() || receivedToken.isEmpty()) {
                showMessage(result.message("Account creation failed. Please try again."), true);
                return;
            }
            if (!SessionStore.save(this, receivedToken)) {
                showMessage("Account created, but this device could not save the secure session. Sign in to continue.", true);
                registering = false;
                renderAuth();
                return;
            }
            token = receivedToken;
            currentUser = result.object.optJSONObject("user") == null ? new JSONObject() : result.object.optJSONObject("user");
            pendingRegistrationMessage = result.object.optBoolean("emailVerificationSent", false)
                ? "Account created. Check your email for the verification link."
                : "Account created. Email verification delivery needs attention; use Account settings on the website to request another link.";
            enterPlayerApp();
        });
    }

    private void validateSession() {
        request("GET", "/api/me", token, null, result -> {
            if (!result.ok()) {
                SessionStore.clear(this);
                token = null;
                currentUser = new JSONObject();
                setConnection("Sign in to connect to GOAL$GAMBIT", false);
                renderAuth();
                return;
            }
            currentUser = result.object.optJSONObject("user") == null ? new JSONObject() : result.object.optJSONObject("user");
            enterPlayerApp();
        });
    }

    private void enterPlayerApp() {
        registering = false;
        navigation.setVisibility(View.VISIBLE);
        setConnection("Connected to GOAL$GAMBIT", true);
        preparePlayerNotifications();
        if (chessSocket != null) chessSocket.close();
        chessSocket = new ChessRealtimeClient(this);
        chessSocket.connect(token);
        boolean openNotifications = getIntent() != null && getIntent().getBooleanExtra(OPEN_NOTIFICATIONS_EXTRA, false);
        if (openNotifications) getIntent().removeExtra(OPEN_NOTIFICATIONS_EXTRA);
        navigate(openNotifications ? "notifications" : "home");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(OPEN_NOTIFICATIONS_EXTRA, false) && token != null) {
            intent.removeExtra(OPEN_NOTIFICATIONS_EXTRA);
            navigate("notifications");
        }
    }

    private void preparePlayerNotifications() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                ALERT_CHANNEL_ID, "GOAL$GAMBIT player alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Live GOAL$GAMBIT match and account alerts");
            channel.enableVibration(true);
            manager.createNotificationChannel(channel);
        }
        boolean alreadyAsked = getPreferences(MODE_PRIVATE).getBoolean("player_notification_permission_asked", false);
        if (Build.VERSION.SDK_INT >= 33 && !alreadyAsked && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("player_notification_permission_asked", true).apply();
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "GOAL$GAMBIT match alerts are enabled on this device.", Toast.LENGTH_SHORT).show();
        }
    }

    private void showPlayerNotification(JSONObject payload) {
        if (payload == null || token == null) return;
        String title = payload.optString("title", "GOAL$GAMBIT match alert").trim();
        String message = payload.optString("message", payload.optString("body", "You have a new account update.")).trim();
        if (title.isEmpty()) title = "GOAL$GAMBIT match alert";
        if (message.isEmpty()) message = "Open GOAL$GAMBIT to review your update.";
        String eventId = payload.optString("id", "");
        String uniqueKey = eventId.isEmpty()
            ? payload.optString("type", "alert") + "|" + payload.optString("created_at", "") + "|" + title + "|" + message
            : "event:" + eventId;
        if (!shownNotificationKeys.add(uniqueKey)) return;
        if (shownNotificationKeys.size() > 150) shownNotificationKeys.clear();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        Intent openApp = new Intent(this, MainActivity.class);
        openApp.putExtra(OPEN_NOTIFICATIONS_EXTRA, true);
        openApp.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 7510, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, ALERT_CHANNEL_ID)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH);
        builder.setSmallIcon(com.goalgambit.trial.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(new Notification.BigTextStyle().bigText(message))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(contentIntent);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            int notificationId = eventId.isEmpty() ? uniqueKey.hashCode() : eventId.hashCode();
            try { manager.notify(notificationId == 0 ? 7511 : notificationId, builder.build()); }
            catch (SecurityException ignored) { }
        }
    }

    private void navigate(String screen) {
        currentScreen = screen;
        if (navigation != null && token != null) buildNavigation();
        if ("home".equals(screen)) renderHome();
        else if ("chess".equals(screen)) renderChess();
        else if ("efootball".equals(screen)) renderEfootball();
        else if ("efootballMatch".equals(screen)) renderEfootballMatch();
        else if ("leagues".equals(screen)) renderLeagues();
        else if ("tournament".equals(screen)) renderTournamentDetail();
        else if ("wallet".equals(screen)) renderWallet();
        else if ("more".equals(screen)) renderMore();
        else if ("profile".equals(screen)) renderProfile();
        else if ("leaderboard".equals(screen)) renderLeaderboard();
        else if ("notifications".equals(screen)) renderNotifications();
        else if ("support".equals(screen)) renderSupport();
    }

    private void renderHome() {
        content.removeAllViews();
        addHeading("Welcome back,", currentUser.optString("username", "player"));
        TextView motto = text("YOUR GOAL$GAMBIT PLAYER HUB\nChess, eFootball, competitions, wallet and support — connected to your account.", 14, TEXT, true);
        motto.setPadding(dp(14), dp(15), dp(14), dp(15));
        motto.setBackground(round(PANEL, dp(8), Color.rgb(94, 75, 25), dp(1)));
        content.addView(motto, margins(-1, -2, 0, dp(8), 0, dp(12)));
        if (!pendingRegistrationMessage.isEmpty()) {
            addNotice(pendingRegistrationMessage, MUTED_GOLD);
            pendingRegistrationMessage = "";
        }

        LinearLayout summary = card();
        summary.addView(text("ACCOUNT SNAPSHOT", 12, GOLD, true), margins(-1, -2, 0, 0, 0, dp(6)));
        summary.addView(text("Chess rating  " + currentUser.optInt("rating", 1200) + "\nGame access  " + gameName(currentUser.optString("game", "")) + "\nAccount  Active", 13, TEXT, false));
        Button account = secondaryButton("PROFILE & ACCOUNT SETTINGS");
        summary.addView(account, margins(-1, dp(42), 0, dp(8), 0, 0));
        account.setOnClickListener(v -> navigate("profile"));
        content.addView(summary, margins(-1, -2, 0, 0, 0, dp(10)));

        LinearLayout quick = card();
        quick.addView(text("QUICK ACCESS", 12, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        addQuickAction(quick, "CHESS LOBBY", "Ranked, casual, active games and history", "chess");
        addQuickAction(quick, "eFOOTBALL MATCH HUB", "Room codes, ready check and score reports", "efootball");
        addQuickAction(quick, "LEAGUES & TOURNAMENTS", "Entries, fixtures, groups and standings", "leagues");
        addQuickAction(quick, "WALLET", "Available funds, M-Pesa deposit and history", "wallet");
        addQuickAction(quick, "NOTIFICATIONS", "Account alerts, event reminders and announcements", "notifications");
        content.addView(quick, margins(-1, -2, 0, 0, 0, dp(10)));

        LinearLayout snapshot = new LinearLayout(this);
        snapshot.setOrientation(LinearLayout.VERTICAL);
        content.addView(snapshot, matchWrap());
        loadHomeSnapshot(snapshot);
        pageStatus = text("", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, 0));
        refreshIdentity();
    }

    private void addQuickAction(LinearLayout parent, String title, String description, String destination) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(9), dp(9), dp(7), dp(9));
        row.setBackground(round(Color.rgb(15, 15, 15), dp(7), Color.rgb(48, 48, 48), dp(1)));
        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.addView(text(title, 13, TEXT, true));
        info.addView(text(description, 10, SUBTLE, false), margins(-1, -2, 0, dp(2), 0, 0));
        row.addView(info, new LinearLayout.LayoutParams(0, -2, 1f));
        row.addView(text("›", 24, GOLD, true), wrap());
        parent.addView(row, margins(-1, -2, 0, 0, 0, dp(6)));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> navigate(destination));
    }

    private void loadHomeSnapshot(LinearLayout parent) {
        parent.removeAllViews();
        parent.addView(text("YOUR LIVE OVERVIEW", 12, GOLD, true), margins(-1, -2, 0, 0, 0, dp(6)));
        final JSONObject[] wallet = { null };
        final JSONArray[] chessHistory = { null };
        final JSONArray[] football = { null };
        final JSONArray[] notices = { null };
        final int[] pending = { 4 };
        Runnable settled = () -> {
            if (--pending[0] != 0 || !"home".equals(currentScreen)) return;
            LinearLayout overview = card();
            overview.addView(text("ACCOUNT ACTIVITY", 11, MUTED_GOLD, true), margins(-1, -2, 0, 0, 0, dp(5)));
            overview.addView(text("Chess history entries  " + (chessHistory[0] == null ? "—" : chessHistory[0].length()) +
                "\nActive eFootball matches  " + (football == null || football[0] == null ? "—" : football[0].length()) +
                "\nUnread announcements  " + (notices == null || notices[0] == null ? "—" : notices[0].length()), 12, TEXT, false));
            if (wallet[0] != null) {
                JSONObject data = wallet[0].optJSONObject("wallet");
                if (data != null) overview.addView(text("Available wallet balance  KSh " + money(data.optDouble("availableBalance", data.optDouble("balance", 0))), 12, GOLD, true), margins(-1, -2, 0, dp(7), 0, 0));
            }
            parent.addView(overview, margins(-1, -2, 0, 0, 0, dp(8)));
            if (football[0] != null && football[0].length() > 0) {
                JSONObject first = football[0].optJSONObject(0);
                if (first != null) {
                    LinearLayout live = card();
                    live.addView(text("CONTINUE YOUR eFOOTBALL MATCH", 11, GOLD, true));
                    live.addView(text("Match #" + first.optLong("id", 0) + " · " + first.optString("status", "active") + " · vs " + first.optString("opponentUsername", "waiting"), 12, TEXT, false), margins(-1, -2, 0, dp(4), 0, dp(3)));
                    Button open = primaryButton("OPEN MATCH HUB");
                    live.addView(open, matchWrap());
                    open.setOnClickListener(v -> navigate("efootball"));
                    parent.addView(live, margins(-1, -2, 0, 0, 0, dp(8)));
                }
            }
        };
        request("GET", "/api/wallet", token, null, result -> { if (result.ok()) wallet[0] = result.object; settled.run(); });
        request("GET", "/api/efootball/matches/active", token, null, result -> { if (result.ok()) football[0] = result.object.optJSONArray("matches"); settled.run(); });
        request("GET", "/api/chat/announcements", token, null, result -> { if (result.ok()) notices[0] = result.object.optJSONArray("announcements"); settled.run(); });
        if (chessSocket != null && chessSocket.isConnected()) chessSocket.refreshMatches();
        request("GET", "/api/chess/history/mine", token, null, result -> {
            if (result.ok()) chessHistory[0] = result.object.optJSONArray("games");
            settled.run();
        });
    }

    private void addHomeAction(String title, String description, String destination) {
        LinearLayout panel = card();
        panel.setClickable(true);
        panel.setFocusable(true);
        panel.addView(text(title, 16, GOLD, true));
        panel.addView(text(description, 12, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
        content.addView(panel, margins(-1, -2, 0, 0, 0, dp(9)));
        panel.setOnClickListener(v -> navigate(destination));
    }

    private void refreshIdentity() {
        request("GET", "/api/me", token, null, result -> {
            if (!"home".equals(currentScreen)) return;
            if (result.status == 401) {
                expireSession();
                return;
            }
            if (!result.ok()) {
                pageStatus.setText(result.message("Your profile could not be refreshed."));
                return;
            }
            currentUser = result.object.optJSONObject("user") == null ? currentUser : result.object.optJSONObject("user");
            setConnection("Connected to GOAL$GAMBIT", true);
        });
    }

    private void renderMore() {
        content.removeAllViews();
        addHeading("Player services", "Your account tools and updates.");
        addHomeAction("LEADERBOARD", "Compare player rankings.", "leaderboard");
        addHomeAction("NOTIFICATIONS", "Review notifications attached to your account.", "notifications");
        addHomeAction("PLAYER PROFILE", "View your registered details.", "profile");
        addHomeAction("SUPPORT CHATBOX", "Send a message to the GOAL$GAMBIT support team.", "support");
        Button signOut = secondaryButton("SIGN OUT");
        content.addView(signOut, margins(-1, dp(50), 0, dp(12), 0, 0));
        signOut.setOnClickListener(v -> signOut());
    }

    private void renderProfile() {
        content.removeAllViews();
        addHeading("Profile & account", "Manage your player details and email verification. Sensitive changes require your current password.");
        pageStatus = text("Loading your account…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, 0));
        request("GET", "/api/me", token, null, result -> {
            if (!"profile".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            if (!result.ok()) { pageStatus.setText(result.message("Could not load your profile.")); return; }
            currentUser = result.object.optJSONObject("user") == null ? currentUser : result.object.optJSONObject("user");
            pageStatus.setText("");
            LinearLayout details = card();
            addDetail(details, "USERNAME", currentUser.optString("username", "—"));
            addDetail(details, "GAME ACCESS", gameName(currentUser.optString("game", "")));
            addDetail(details, "CHESS RATING", String.valueOf(currentUser.optInt("rating", 1200)));
            addDetail(details, "EMAIL", currentUser.optString("email", "Not added"));
            addDetail(details, "EMAIL STATUS", currentUser.isNull("email_verified_at") ? "Not verified · add or verify an email for recovery" : "Verified");
            content.addView(details, margins(-1, -2, 0, 0, 0, dp(11)));

            content.addView(text("ACCOUNT DETAILS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(6)));
            EditText username = input("New username (leave blank to keep current)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            EditText phone = input("New phone number (leave blank to keep current)", InputType.TYPE_CLASS_PHONE);
            content.addView(username, margins(-1, dp(49), 0, 0, 0, dp(7)));
            content.addView(phone, margins(-1, dp(49), 0, 0, 0, dp(7)));
            Spinner game = optionSpinner(new String[] { "Chess", "eFootball", "Both" });
            String currentGame = currentUser.optString("game", "both");
            game.setSelection("chess".equalsIgnoreCase(currentGame) ? 0 : "konami".equalsIgnoreCase(currentGame) ? 1 : 2);
            content.addView(game, margins(-1, dp(48), 0, 0, 0, dp(7)));
            EditText newPassword = input("New password (optional, 8–128 characters)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            EditText confirmPassword = input("Confirm new password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            EditText currentPassword = input("Current password to authorize changes", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            content.addView(newPassword, margins(-1, dp(49), 0, 0, 0, dp(7)));
            content.addView(confirmPassword, margins(-1, dp(49), 0, 0, 0, dp(7)));
            content.addView(currentPassword, margins(-1, dp(49), 0, 0, 0, dp(8)));
            Button save = primaryButton("SAVE ACCOUNT CHANGES");
            content.addView(save, margins(-1, dp(50), 0, 0, 0, dp(16)));
            save.setOnClickListener(v -> savePlayerAccount(username, phone, game, newPassword, confirmPassword, currentPassword, save));

            content.addView(text("EMAIL & PASSWORD RECOVERY", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(6)));
            addNotice("Email changes are not active until you open the verification link sent to that address. The website and app continue using the backend’s existing verification record.", MUTED_GOLD);
            EditText email = input("Email address", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
            EditText emailPassword = input("Current password to verify email change", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            content.addView(email, margins(-1, dp(49), 0, 0, 0, dp(7)));
            content.addView(emailPassword, margins(-1, dp(49), 0, 0, 0, dp(7)));
            Button verify = secondaryButton("SEND EMAIL VERIFICATION LINK");
            content.addView(verify, margins(-1, dp(48), 0, 0, 0, dp(10)));
            verify.setOnClickListener(v -> requestEmailVerification(email, emailPassword, verify));
        });
    }

    private void savePlayerAccount(EditText username, EditText phone, Spinner game, EditText newPassword,
                                   EditText confirmation, EditText currentPassword, Button save) {
        String currentPass = currentPassword.getText().toString();
        String nextPassword = newPassword.getText().toString();
        if (currentPass.isEmpty()) { showMessage("Enter your current password to authorize account changes.", true); return; }
        if (nextPassword.length() > 0 && (nextPassword.length() < 8 || nextPassword.length() > 128 || !nextPassword.equals(confirmation.getText().toString()))) {
            showMessage("New passwords must match and contain 8–128 characters.", true); return;
        }
        JSONObject body = new JSONObject();
        try {
            body.put("currentPassword", currentPass);
            String newName = username.getText().toString().trim();
            String newPhone = phone.getText().toString().trim();
            String currentName = currentUser.optString("username", "");
            String currentPhone = currentUser.optString("phone", "");
            if (!newName.isEmpty() && !newName.equals(currentName)) body.put("username", newName);
            if (!newPhone.isEmpty() && !newPhone.equals(currentPhone)) body.put("phone", newPhone);
            String selectedGame = game.getSelectedItemPosition() == 0 ? "chess" : game.getSelectedItemPosition() == 1 ? "konami" : "both";
            if (!selectedGame.equalsIgnoreCase(currentUser.optString("game", ""))) body.put("game", selectedGame);
            if (!nextPassword.isEmpty()) body.put("newPassword", nextPassword);
        } catch (Exception ignored) {}
        if (body.length() <= 1) { showMessage("Enter at least one account change before saving.", true); return; }
        save.setEnabled(false);
        request("POST", "/api/auth/account", token, body, result -> {
            save.setEnabled(true);
            if (!result.ok()) { showMessage(result.message("Account changes were not saved."), true); return; }
            String nextToken = result.object.optString("token", "");
            if (nextToken.isEmpty() || !SessionStore.save(this, nextToken)) { expireSession(); return; }
            token = nextToken;
            JSONObject user = result.object.optJSONObject("user");
            if (user != null) currentUser = user;
            showMessage(result.message("Account updated."), false);
            enterPlayerApp();
        });
    }

    private void requestEmailVerification(EditText email, EditText password, Button button) {
        String address = email.getText().toString().trim();
        String currentPassword = password.getText().toString();
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches() || currentPassword.isEmpty()) {
            showMessage("Enter a valid email and your current password.", true); return;
        }
        JSONObject body = new JSONObject();
        try { body.put("email", address); body.put("currentPassword", currentPassword); } catch (Exception ignored) {}
        button.setEnabled(false);
        request("POST", "/api/auth/email/request-verification", token, body, result -> {
            button.setEnabled(true);
            showMessage(result.message(result.ok() ? "Check your email for the verification link." : "Email verification could not be requested."), !result.ok());
        });
    }

    private void renderChess() {
        currentScreen = "chess";
        content.removeAllViews();
        addHeading("Chess", "Choose a ranked clock and stake, challenge a Chess player, or resume a live game. The server validates every move and result.");
        content.addView(text("MATCHMAKING SETTINGS", 12, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        Spinner typeSpinner = optionSpinner(new String[] { "Ranked match · stake applies", "Casual match · no stake" });
        typeSpinner.setSelection("casual".equals(chessMatchType) ? 1 : 0);
        content.addView(typeSpinner, margins(-1, dp(48), 0, 0, 0, dp(7)));
        typeSpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                String selectedType = position == 1 ? "casual" : "ranked";
                if (!selectedType.equals(chessMatchType)) { chessMatchType = selectedType; renderChess(); }
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        Spinner speedSpinner = optionSpinner(new String[] { "Rapid", "Blitz", "Bullet" });
        speedSpinner.setSelection("bullet".equals(chessSpeed) ? 2 : "blitz".equals(chessSpeed) ? 1 : 0);
        content.addView(speedSpinner, margins(-1, dp(48), 0, 0, 0, dp(7)));
        speedSpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                String selected = position == 2 ? "bullet" : position == 1 ? "blitz" : "rapid";
                if (!selected.equals(chessSpeed)) { chessSpeed = selected; renderChess(); }
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        String[] controls = chessControlOptions(chessMatchType, chessSpeed);
        int selectedControl = Math.max(0, Arrays.asList(controls).indexOf(chessTimeControl));
        Spinner timeSpinner = optionSpinner(controls);
        timeSpinner.setSelection(selectedControl);
        content.addView(timeSpinner, margins(-1, dp(48), 0, 0, 0, dp(7)));
        timeSpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                if (position >= 0 && position < controls.length) chessTimeControl = controls[position];
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        Spinner stakeSpinner = null;
        if ("ranked".equals(chessMatchType)) {
            stakeSpinner = optionSpinner(new String[] { "KSh 20 stake", "KSh 50 stake", "KSh 100 stake" });
            stakeSpinner.setSelection(chessStake == 100 ? 2 : chessStake == 50 ? 1 : 0);
            content.addView(stakeSpinner, margins(-1, dp(48), 0, 0, 0, dp(7)));
        } else {
            addNotice("Casual matches use the selected clock and do not lock or use wallet funds.", MUTED_GOLD);
        }
        Button find = primaryButton("FIND A REAL OPPONENT");
        content.addView(find, margins(-1, dp(54), 0, 0, 0, dp(7)));
        Spinner finalStakeSpinner = stakeSpinner;
        find.setOnClickListener(v -> startConfiguredChess(find, finalStakeSpinner));
        Button challenge = secondaryButton("CHALLENGE A CHESS PLAYER");
        content.addView(challenge, margins(-1, dp(48), 0, 0, 0, dp(14)));
        challenge.setOnClickListener(v -> showDirectChessChallenge());
        pageStatus = text("Connecting to the chess service…", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, 0, 0, dp(10)));
        Button refresh = secondaryButton("REFRESH CHESS MATCHES");
        content.addView(refresh, margins(-1, dp(46), 0, 0, 0, dp(16)));
        refresh.setOnClickListener(v -> {
            if (chessSocket != null) chessSocket.refreshMatches();
            loadChessHistory();
            pageStatus.setText("Refreshing your active and completed games…");
        });
        content.addView(text("YOUR ACTIVE MATCHES", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        activeMatchesList = new LinearLayout(this);
        activeMatchesList.setOrientation(LinearLayout.VERTICAL);
        content.addView(activeMatchesList, margins(-1, -2, 0, 0, 0, dp(16)));
        content.addView(text("RECENT RESULTS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        chessHistoryList = new LinearLayout(this);
        chessHistoryList.setOrientation(LinearLayout.VERTICAL);
        content.addView(chessHistoryList, margins(-1, -2, 0, 0, 0, dp(12)));
        loadChessHistory(chessHistoryList);
        content.addView(text("CHALLENGES & INVITATIONS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        LinearLayout scheduleList = new LinearLayout(this);
        scheduleList.setOrientation(LinearLayout.VERTICAL);
        chessScheduleList = scheduleList;
        content.addView(scheduleList, matchWrap());
        loadChessSchedules(scheduleList);
        if (chessSocket != null) chessSocket.refreshMatches();
    }

    private String[] chessControlOptions(String type, String speed) {
        if ("casual".equals(type)) return new String[] { "5:00", "10:00", "10+5", "15+10" };
        if ("bullet".equals(speed)) return new String[] { "1:00", "1+1", "2:00", "2+1" };
        if ("blitz".equals(speed)) return new String[] { "3:00", "3+2", "5:00" };
        return new String[] { "10:00", "10+5", "10+15", "15+10" };
    }

    private void startConfiguredChess(Button button, Spinner stakeSpinner) {
        int stake = 0;
        if ("ranked".equals(chessMatchType)) {
            int selected = stakeSpinner == null ? 0 : stakeSpinner.getSelectedItemPosition();
            stake = selected == 2 ? 100 : selected == 1 ? 50 : 20;
        }
        chessStake = stake == 0 ? chessStake : stake;
        final int selectedStake = stake;
        String type = chessMatchType;
        String speed = chessSpeed;
        String timeControl = chessTimeControl;
        new AlertDialog.Builder(this)
            .setTitle("Confirm Chess matchmaking")
            .setMessage(("ranked".equals(type) ? "RANKED · KSh " + selectedStake + " stake\n" : "CASUAL · no stake\n") +
                speed.toUpperCase(Locale.ROOT) + " · " + timeControl + "\n\n" +
                (selectedStake > 0 ? "The server will reserve this amount from your available wallet balance. If the search is cancelled before play, the server handles any eligible refund." : "No wallet funds will be used.") +
                "\n\nThe backend selects and validates the opponent and match.")
            .setNegativeButton("NOT NOW", (dialog, which) -> dialog.dismiss())
            .setPositiveButton("FIND OPPONENT", (dialog, which) -> {
                if (requestBusy) return;
                requestBusy = true;
                button.setEnabled(false);
                pageStatus.setText("Joining the " + type + " " + speed + " queue…");
                JSONObject body = new JSONObject();
                try {
                    body.put("matchType", type);
                    body.put("speed", speed);
                    body.put("timeControl", timeControl);
                    body.put("stake", selectedStake);
                } catch (Exception ignored) {}
                request("POST", "/api/chess/create", token, body, result -> {
                    requestBusy = false;
                    button.setEnabled(true);
                    if (!result.ok()) {
                        pageStatus.setText(result.message("Could not start matchmaking."));
                        return;
                    }
                    JSONObject match = result.object.optJSONObject("match");
                    if (match == null) {
                        pageStatus.setText("Matchmaking returned no match details. Refresh your chess matches.");
                        return;
                    }
                    long id = match.optLong("matchId", match.optLong("id", 0));
                    pageStatus.setText(result.object.optBoolean("matched", false)
                        ? "Opponent found. Loading your match…"
                        : "Your search is saved on the GOAL$GAMBIT server. Return here to resume or cancel it.");
                    if (id > 0) openChessMatch(id);
                    if (chessSocket != null) chessSocket.refreshMatches();
                });
            }).show();
    }

    private void showDirectChessChallenge() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        EditText username = input("Opponent's Chess username", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        form.addView(username, margins(-1, dp(50), 0, 0, 0, dp(8)));
        Spinner clock = optionSpinner(new String[] { "10+5 Rapid", "3+2 Blitz", "1+1 Bullet" });
        form.addView(clock, margins(-1, dp(48), 0, 0, 0, dp(8)));
        Spinner stake = optionSpinner(new String[] { "KSh 20 stake", "KSh 50 stake", "KSh 100 stake" });
        form.addView(stake, matchWrap());
        new AlertDialog.Builder(this).setTitle("Direct Chess challenge")
            .setMessage("Send a live challenge to a known GOAL$GAMBIT Chess player. The server reserves your stake now; the invited player must accept before a match starts.")
            .setView(form)
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("SEND CHALLENGE", (dialog, which) -> {
                String opponent = username.getText().toString().trim();
                if (!opponent.matches("[A-Za-z0-9_]{3,30}")) { showMessage("Enter a valid Chess username.", true); return; }
                int selectedStake = stake.getSelectedItemPosition() == 2 ? 100 : stake.getSelectedItemPosition() == 1 ? 50 : 20;
                String[] clocks = { "10+5", "3+2", "1+1" };
                JSONObject body = new JSONObject();
                try {
                    body.put("type", "direct");
                    body.put("opponentUsername", opponent);
                    body.put("timeControl", clocks[Math.max(0, clock.getSelectedItemPosition())]);
                    body.put("stakeAmount", selectedStake);
                } catch (Exception ignored) {}
                request("POST", "/api/chess/schedules", token, body, result -> {
                    if (!result.ok()) { if (pageStatus != null) pageStatus.setText(result.message("The challenge was not sent.")); return; }
                    if (pageStatus != null) pageStatus.setText(result.message("Challenge sent. The server has reserved your stake."));
                    renderChess();
                });
            }).show();
    }

    private void loadChessSchedules() {
        if (chessScheduleList != null) loadChessSchedules(chessScheduleList);
    }

    private void loadChessSchedules(LinearLayout list) {
        list.removeAllViews();
        request("GET", "/api/chess/schedules", token, null, result -> {
            if (!"chess".equals(currentScreen) || list != chessScheduleList) return;
            list.removeAllViews();
            JSONArray schedules = result.object.optJSONArray("schedules");
            if (!result.ok() || schedules == null || schedules.length() == 0) {
                list.addView(text(result.ok() ? "No active challenges or invitations." : result.message("Chess invitations could not be loaded."), 12, SUBTLE, false));
                return;
            }
            for (int i = 0; i < schedules.length(); i++) {
                JSONObject schedule = schedules.optJSONObject(i);
                if (schedule == null) continue;
                long id = schedule.optLong("id", 0);
                LinearLayout panel = card();
                panel.addView(text((schedule.optBoolean("isHost") ? "CHALLENGE TO · " : "CHALLENGE FROM · ") + schedule.optString("opponentUsername", "Player"), 13, GOLD, true));
                panel.addView(text(schedule.optString("status", "pending").toUpperCase(Locale.ROOT) + " · " +
                    schedule.optString("timeControl", "Chess") + " · KSh " + money(schedule.optDouble("stakeAmount", 0)) + " stake", 12, TEXT, false), margins(-1, -2, 0, dp(4), 0, dp(6)));
                if (schedule.optBoolean("canRespond")) {
                    Button accept = primaryButton("ACCEPT CHALLENGE");
                    Button decline = secondaryButton("DECLINE");
                    panel.addView(accept, margins(-1, dp(42), 0, 0, 0, dp(5)));
                    panel.addView(decline, matchWrap());
                    accept.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Accept Chess challenge?")
                        .setMessage("KSh " + money(schedule.optDouble("stakeAmount", 0)) + " will be reserved by GOAL$GAMBIT before the game starts. Confirm the stake and clock before accepting.")
                        .setNegativeButton("NOT NOW", null).setPositiveButton("ACCEPT", (dialog, which) -> updateChessSchedule(id, "accept", schedule)).show());
                    decline.setOnClickListener(v -> updateChessSchedule(id, "decline", schedule));
                } else if (schedule.optBoolean("canCancel")) {
                    Button cancel = secondaryButton("CANCEL CHALLENGE");
                    panel.addView(cancel, matchWrap());
                    cancel.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Cancel Chess challenge?")
                        .setMessage("The backend checks whether your reserved stake can be refunded for this challenge status.")
                        .setNegativeButton("KEEP", null).setPositiveButton("CANCEL CHALLENGE", (dialog, which) -> cancelChessSchedule(id)).show());
                } else if (schedule.optLong("matchId", 0) > 0) {
                    Button open = primaryButton("OPEN LIVE GAME");
                    panel.addView(open, matchWrap());
                    open.setOnClickListener(v -> openChessMatch(schedule.optLong("matchId", 0)));
                }
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(7)));
            }
        });
    }

    private void updateChessSchedule(long id, String action, JSONObject schedule) {
        JSONObject body = new JSONObject();
        try { body.put("action", action); } catch (Exception ignored) {}
        request("POST", "/api/chess/schedules/" + id + "/respond", token, body, result -> {
            if (!result.ok()) { showMessage(result.message("The Chess challenge could not be updated."), true); return; }
            long matchId = result.object.optLong("matchId", 0);
            if ("accept".equals(action) && matchId > 0) { openChessMatch(matchId); return; }
            showMessage(result.message("Challenge updated."), false);
            renderChess();
        });
    }

    private void cancelChessSchedule(long id) {
        request("POST", "/api/chess/schedules/" + id + "/cancel", token, new JSONObject(), result -> {
            if (!result.ok()) { showMessage(result.message("The Chess challenge could not be cancelled."), true); return; }
            showMessage(result.message("Challenge cancelled."), false);
            renderChess();
        });
    }

    @Override
    public void onStatus(String status) {
        socketAvailable = status != null && status.startsWith("Connected");
        setConnection(status, socketAvailable);
        if (pageStatus != null && ("chess".equals(currentScreen) || "chessboard".equals(currentScreen))) {
            pageStatus.setText(status);
        }
    }

    @Override
    public void onMatches(List<JSONObject> matches) {
        if (!"chess".equals(currentScreen) || activeMatchesList == null) return;
        activeMatchesList.removeAllViews();
        if (matches == null || matches.isEmpty()) {
            activeMatchesList.addView(text("No active chess matches. Find a casual opponent to start.", 12, SUBTLE, false));
            if (pageStatus != null) pageStatus.setText(socketAvailable ? "Chess service connected" : "Waiting for chess service connection…");
            return;
        }
        if (pageStatus != null) pageStatus.setText("Your active chess matches");
        for (JSONObject match : matches) {
            long id = match.optLong("matchId", 0);
            if (id <= 0) continue;
            LinearLayout panel = card();
            panel.addView(text("MATCH #" + id + " · " + match.optString("status", "active").toUpperCase(Locale.ROOT), 15, GOLD, true));
            panel.addView(text(match.optString("timeControl", "Chess") + " · " + sideLabel(match.optString("activeColor", "w")) + " to move", 12, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, dp(6)));
            Button open = primaryButton("OPEN MATCH");
            panel.addView(open, margins(-1, dp(44), 0, dp(5), 0, 0));
            open.setOnClickListener(v -> openChessMatch(id));
            activeMatchesList.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
        }
    }

    @Override
    public void onPlayerNotification(JSONObject notification) {
        showPlayerNotification(notification);
        if (pageStatus != null && ("efootball".equals(currentScreen) || "efootballMatch".equals(currentScreen))) {
            pageStatus.setText("New match alert received · open Notifications to review it.");
        }
    }

    @Override
    public void onMatchEvent(JSONObject state, String event) {
        if ("match_available".equals(event)) {
            if (chessSocket != null) chessSocket.refreshMatches();
            return;
        }
        long eventMatchId = state.optLong("matchId", 0);
        if (currentChessMatchId <= 0 || (eventMatchId > 0 && eventMatchId != currentChessMatchId)) return;
        if ("move".equals(event) || "joined".equals(event) || "match_ready".equals(event) ||
            "player_connected".equals(event) || "connection_ready".equals(event) ||
            "paused".equals(event) || "resumed".equals(event) || "game_over".equals(event)) {
            refreshChessMatch(currentChessMatchId);
        }
    }

    private void openChessMatch(long matchId) {
        if (matchId <= 0) return;
        currentChessMatchId = matchId;
        selectedSquare = null;
        legalDestinations.clear();
        currentChessState = null;
        if (chessSocket != null) chessSocket.setMatch(matchId);
        currentScreen = "chessboard";
        renderChessBoardLoading();
        refreshChessMatch(matchId);
    }

    private void renderChessBoardLoading() {
        content.removeAllViews();
        Button back = secondaryButton("‹  BACK TO CHESS");
        content.addView(back, margins(-1, dp(44), 0, 0, 0, dp(12)));
        back.setOnClickListener(v -> {
            if (chessSocket != null) chessSocket.setMatch(0);
            currentChessMatchId = 0;
            navigate("chess");
        });
        addHeading("Chess match #" + currentChessMatchId, "Synchronizing the current server position…");
        pageStatus = text("Loading authoritative match state…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
    }

    private void refreshChessMatch(long matchId) {
        if (matchId <= 0 || matchId != currentChessMatchId) return;
        request("GET", "/api/chess/" + matchId, token, null, result -> {
            if (matchId != currentChessMatchId || !"chessboard".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            if (!result.ok()) {
                if (pageStatus != null) pageStatus.setText(result.message("Could not synchronize this chess match."));
                return;
            }
            JSONObject match = result.object.optJSONObject("match");
            if (match == null) {
                if (pageStatus != null) pageStatus.setText("The server returned no chess match state.");
                return;
            }
            String previousFen = currentChessState == null ? "" : currentChessState.optString("fen", "");
            String nextFen = match.optString("fen", "");
            if (!previousFen.isEmpty() && !previousFen.equals(nextFen)) {
                selectedSquare = null;
                legalDestinations.clear();
            }
            currentChessState = match;
            currentPlayerColor = match.optString("playerColor", "w");
            if (chessBoard == null || !contentContainsBoard()) renderChessMatch();
            else updateChessBoard();
            if (!result.object.optBoolean("connectionReady", true) || match.optBoolean("connectionPaused", false)) {
                if (pageStatus != null) pageStatus.setText("Match paused while the server restores a reliable connection.");
            }
        });
    }

    private boolean contentContainsBoard() {
        if (chessBoard == null) return false;
        return chessBoard.getParent() != null;
    }

    private void renderChessMatch() {
        content.removeAllViews();
        Button back = secondaryButton("‹  BACK TO CHESS");
        content.addView(back, margins(-1, dp(44), 0, 0, 0, dp(10)));
        back.setOnClickListener(v -> {
            if (chessSocket != null) chessSocket.setMatch(0);
            currentChessMatchId = 0;
            chessBoard = null;
            navigate("chess");
        });
        TextView title = text("CHESS MATCH #" + currentChessMatchId, 17, GOLD, true);
        content.addView(title, margins(-1, -2, 0, 0, 0, dp(5)));
        TextView opponent = text("", 14, TEXT, true);
        content.addView(opponent, margins(-1, -2, 0, 0, 0, dp(4)));
        TextView ownName = text("", 14, GOLD, true);
        pageStatus = text("", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, 0, 0, dp(7)));

        String white = currentChessState.optString("whiteName", "White");
        String black = currentChessState.optString("blackName", "Black");
        boolean whitePlayer = "w".equalsIgnoreCase(currentPlayerColor);
        opponent.setText((whitePlayer ? "OPPONENT · " + black : "OPPONENT · " + white).toUpperCase(Locale.ROOT));
        content.addView(text("WHITE · " + white + "    /    BLACK · " + black, 11, SUBTLE, false), margins(-1, -2, 0, 0, 0, dp(8)));

        chessClockInfo = text("", 12, TEXT, false);
        chessClockInfo.setGravity(Gravity.CENTER);
        chessClockInfo.setPadding(dp(10), dp(8), dp(10), dp(8));
        chessClockInfo.setBackground(round(PANEL, dp(6), 0, 0));
        content.addView(chessClockInfo, margins(-1, -2, 0, 0, 0, dp(10)));

        chessBoard = new ChessBoardView(this);
        content.addView(chessBoard, margins(-1, -2, 0, 0, 0, dp(10)));

        ownName.setText((whitePlayer ? "YOU · " + white : "YOU · " + black).toUpperCase(Locale.ROOT));
        content.addView(ownName, margins(-1, -2, 0, 0, 0, dp(5)));
        chessMatchStatus = text("", 12, SUBTLE, false);
        content.addView(chessMatchStatus, margins(-1, -2, 0, 0, 0, dp(8)));
        updateChessBoard();
        String status = currentChessState.optString("status", "unknown");
        if ("waiting".equals(status)) pageStatus.setText("Waiting for a real opponent to join this casual match.");
        else if (currentChessState.optBoolean("connectionPaused", false)) pageStatus.setText("Connection interrupted · the server has paused the match.");
        else if ("active".equals(status)) pageStatus.setText(chessSocket != null && chessSocket.isConnected() ? "Live match connection" : "Restoring live match connection…");
        else pageStatus.setText("Match " + status + ".");

        if ("waiting".equals(status) && currentChessState.optDouble("stake", 0) == 0) {
            Button cancel = secondaryButton("CANCEL CASUAL SEARCH");
            content.addView(cancel, margins(-1, dp(46), 0, dp(4), 0, dp(10)));
            cancel.setOnClickListener(v -> cancelCasualSearch(currentChessMatchId, cancel));
        }
    }

    private void updateChessBoard() {
        if (currentChessState == null || chessBoard == null) return;
        if (chessClockInfo != null) {
            chessClockInfo.setText("WHITE  " + clockText(currentChessState.optLong("whiteTimeMs", 0)) +
                "      BLACK  " + clockText(currentChessState.optLong("blackTimeMs", 0)));
        }
        if (chessMatchStatus != null) {
            chessMatchStatus.setText(currentChessState.optString("status", "unknown").toUpperCase(Locale.ROOT) +
                " · " + sideLabel(currentChessState.optString("activeColor", "w")) + " to move");
        }
        try {
            chessBoard.show(currentChessState.getString("fen"), currentPlayerColor,
                legalDestinations, selectedSquare,
                jsonSquare(currentChessState.optJSONObject("lastMove"), "from"),
                jsonSquare(currentChessState.optJSONObject("lastMove"), "to"),
                currentChessState.optString("checkSquare", ""),
                "active".equals(currentChessState.optString("status", "")) &&
                    !currentChessState.optBoolean("connectionPaused", false) ? this::onSquareTapped : null);
        } catch (Exception error) {
            if (pageStatus != null) pageStatus.setText("The chess position could not be displayed. Refresh this match.");
        }
    }

    private void onSquareTapped(String square) {
        if (currentChessState == null || moveBusy) return;
        if (!"active".equals(currentChessState.optString("status", "")) || currentChessState.optBoolean("connectionPaused", false)) {
            if (pageStatus != null) pageStatus.setText("This match is not ready for moves.");
            return;
        }
        if (!currentPlayerColor.equalsIgnoreCase(currentChessState.optString("activeColor", "w"))) {
            if (pageStatus != null) pageStatus.setText("Waiting for the opponent’s move.");
            return;
        }
        try {
            ChessPosition position = new ChessPosition(currentChessState.getString("fen"));
            char piece = position.pieceAt(square);
            boolean ownPiece = piece != '\0' && ((Character.isUpperCase(piece) && "w".equalsIgnoreCase(currentPlayerColor)) ||
                (Character.isLowerCase(piece) && "b".equalsIgnoreCase(currentPlayerColor)));
            if (selectedSquare == null || (ownPiece && !legalDestinations.contains(square))) {
                if (ownPiece) loadLegalMoves(square);
                else if (pageStatus != null) pageStatus.setText("Select one of your pieces.");
                return;
            }
            if (legalDestinations.contains(square)) {
                char movingPiece = position.pieceAt(selectedSquare);
                if (Character.toLowerCase(movingPiece) == 'p' && (square.endsWith("1") || square.endsWith("8"))) {
                    choosePromotion(selectedSquare, square);
                } else submitChessMove(selectedSquare, square, "q");
            } else if (ownPiece) {
                loadLegalMoves(square);
            } else {
                selectedSquare = null;
                legalDestinations.clear();
                updateChessBoard();
            }
        } catch (Exception ignored) {
            if (pageStatus != null) pageStatus.setText("The current chess position could not be read. Refresh the match.");
        }
    }

    private void loadLegalMoves(String square) {
        long matchId = currentChessMatchId;
        String requestedFen = currentChessState == null ? "" : currentChessState.optString("fen", "");
        selectedSquare = square;
        legalDestinations.clear();
        updateChessBoard();
        request("GET", "/api/chess/" + matchId + "/legal-moves?square=" + square, token, null, result -> {
            if (matchId != currentChessMatchId || currentChessState == null) return;
            if (!requestedFen.equals(currentChessState.optString("fen", ""))) return;
            if (!result.ok()) {
                selectedSquare = null;
                if (pageStatus != null) pageStatus.setText(result.message("Could not check legal moves."));
                updateChessBoard();
                return;
            }
            JSONArray moves = result.object.optJSONArray("moves");
            if (moves != null) for (int i = 0; i < moves.length(); i++) {
                JSONObject move = moves.optJSONObject(i);
                if (move != null) {
                    String to = move.optString("to", "");
                    if (to.matches("[a-h][1-8]")) legalDestinations.add(to);
                }
            }
            if (pageStatus != null) pageStatus.setText(legalDestinations.isEmpty() ? "No legal moves from " + square + "." : "Choose a highlighted destination.");
            updateChessBoard();
        });
    }

    private void choosePromotion(String from, String to) {
        String[] choices = { "Queen", "Rook", "Bishop", "Knight" };
        String[] codes = { "q", "r", "b", "n" };
        new AlertDialog.Builder(this).setTitle("Promote pawn")
            .setItems(choices, (dialog, which) -> submitChessMove(from, to, codes[which])).show();
    }

    private void submitChessMove(String from, String to, String promotion) {
        if (moveBusy) return;
        long matchId = currentChessMatchId;
        moveBusy = true;
        if (pageStatus != null) pageStatus.setText("Submitting move for server validation…");
        JSONObject body = new JSONObject();
        try { body.put("from", from); body.put("to", to); body.put("promotion", promotion); }
        catch (Exception ignored) {}
        request("POST", "/api/chess/" + matchId + "/move", token, body, result -> {
            moveBusy = false;
            if (matchId != currentChessMatchId) return;
            if (!result.ok()) {
                JSONObject rejected = result.object.optJSONObject("match");
                if (rejected != null) currentChessState = rejected;
                selectedSquare = null;
                legalDestinations.clear();
                if (pageStatus != null) pageStatus.setText(result.message("Move rejected by the server."));
                updateChessBoard();
                if (rejected == null) refreshChessMatch(matchId);
                return;
            }
            JSONObject updated = result.object.optJSONObject("match");
            if (updated != null) currentChessState = updated;
            selectedSquare = null;
            legalDestinations.clear();
            playMoveSound();
            updateChessBoard();
            if (pageStatus != null) pageStatus.setText("Move accepted by GOAL$GAMBIT.");
        });
    }

    private void cancelCasualSearch(long matchId, Button button) {
        new AlertDialog.Builder(this).setTitle("Cancel search?")
            .setMessage("This cancels your waiting zero-stake casual search.")
            .setNegativeButton("KEEP SEARCHING", (dialog, which) -> dialog.dismiss())
            .setPositiveButton("CANCEL SEARCH", (dialog, which) -> {
                button.setEnabled(false);
                request("POST", "/api/chess/" + matchId + "/cancel", token, new JSONObject(), result -> {
                    if (!result.ok()) {
                        button.setEnabled(true);
                        if (pageStatus != null) pageStatus.setText(result.message("Could not cancel this search."));
                        return;
                    }
                    if (chessSocket != null) chessSocket.setMatch(0);
                    currentChessMatchId = 0;
                    navigate("chess");
                });
            }).show();
    }

    private void playMoveSound() {
        android.media.MediaPlayer player = android.media.MediaPlayer.create(this, R.raw.chess_move);
        if (player == null) return;
        player.setOnCompletionListener(android.media.MediaPlayer::release);
        player.setOnErrorListener((mp, what, extra) -> { mp.release(); return true; });
        player.start();
    }

    private void loadChessHistory() {
        if (chessHistoryList != null) loadChessHistory(chessHistoryList);
    }

    private void loadChessHistory(LinearLayout list) {
        if (list == null) return;
        list.removeAllViews();
        TextView loading = text("Loading your completed games…", 12, SUBTLE, false);
        list.addView(loading);
        request("GET", "/api/chess/history/mine", token, null, result -> {
            if (!"chess".equals(currentScreen) || list != chessHistoryList) return;
            list.removeAllViews();
            if (!result.ok()) {
                list.addView(text(result.message("History is unavailable."), 12, SUBTLE, false));
                return;
            }
            JSONArray games = result.object.optJSONArray("games");
            if (games == null || games.length() == 0) {
                list.addView(text("No completed chess games yet.", 12, SUBTLE, false));
                return;
            }
            for (int i = 0; i < games.length(); i++) {
                JSONObject game = games.optJSONObject(i);
                if (game == null) continue;
                LinearLayout panel = card();
                panel.addView(text("GAME #" + game.optLong("id", 0) + " · " + game.optString("result", "Completed").toUpperCase(Locale.ROOT), 13, GOLD, true));
                panel.addView(text(game.optString("mode", "Chess") + " · " + formatTime(game.optString("date", "")), 11, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, 0));
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(7)));
            }
        });
    }

    private void loadLeague(String leagueId) {
        if (leagueId == null || leagueId.isEmpty()) return;
        content.removeAllViews();
        Button back = secondaryButton("‹  BACK TO LEAGUES");
        content.addView(back, margins(-1, dp(44), 0, 0, 0, dp(10)));
        back.setOnClickListener(v -> navigate("leagues"));
        addHeading("League details", "Server-published division table, player fixtures and entry status.");
        pageStatus = text("Loading league information…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        LinearLayout details = new LinearLayout(this);
        details.setOrientation(LinearLayout.VERTICAL);
        content.addView(details, matchWrap());
        request("GET", "/api/leagues/" + Uri.encode(leagueId), token, null, result -> {
            if (!"leagues".equals(currentScreen)) return;
            if (!result.ok()) { pageStatus.setText(result.message("Could not load league details.")); return; }
            JSONObject league = result.object.optJSONObject("league");
            JSONArray standings = result.object.optJSONArray("standings");
            if (league != null) {
                LinearLayout panel = card();
                panel.addView(text(league.optString("name", "League").toUpperCase(Locale.ROOT), 17, GOLD, true));
                panel.addView(text(league.optString("description", "League standings") +
                    "\nSeason · " + league.optString("status", "active") +
                    " · Entry · KSh " + money(league.optDouble("entry_stake", 0)), 12, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
                details.addView(panel, margins(-1, -2, 0, 0, 0, dp(12)));
            }
            details.addView(text("STANDINGS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
            if (standings == null || standings.length() == 0) {
                addNoticeTo(details, "No standings are available yet.", SUBTLE);
            } else {
                for (int i = 0; i < standings.length(); i++) {
                    JSONObject row = standings.optJSONObject(i);
                    if (row == null) continue;
                    LinearLayout item = card();
                    item.addView(text((i + 1) + ". " + row.optString("username", "Player"), 14, TEXT, true));
                    item.addView(text("Points " + row.optInt("points", 0) + " · Wins " + row.optInt("wins", 0) + " · GD " + row.optInt("goal_difference", 0), 11, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, 0));
                    details.addView(item, margins(-1, -2, 0, 0, 0, dp(6)));
                }
            }
            details.addView(text("YOUR FIXTURES", 13, GOLD, true), margins(-1, -2, 0, dp(10), 0, dp(7)));
            request("GET", "/api/leagues/" + Uri.encode(leagueId) + "/fixtures", token, null, fixturesResult -> {
                if (!"leagues".equals(currentScreen)) return;
                JSONArray fixtures = fixturesResult.object.optJSONArray("fixtures");
                if (!fixturesResult.ok()) {
                    addNoticeTo(details, fixturesResult.message("Fixtures are available only to eligible league players."), SUBTLE);
                    return;
                }
                JSONObject membership = fixturesResult.object;
                if (membership.optBoolean("isMember")) {
                    String buttons = "Your league membership is active.";
                    if (membership.optBoolean("canCancel")) buttons += " You can cancel before fixtures are released.";
                    if (membership.optBoolean("canForfeit")) buttons += " You can forfeit remaining fixtures.";
                    addNoticeTo(details, buttons, MUTED_GOLD);
                    if (membership.optBoolean("canCancel")) {
                        Button cancel = secondaryButton("CANCEL LEAGUE ENTRY");
                        details.addView(cancel, margins(-1, dp(44), 0, 0, 0, dp(8)));
                        cancel.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Cancel league entry?")
                            .setMessage("The server will check eligibility and refund the entry fee if your first opponent fixture has not been released.")
                            .setNegativeButton("KEEP ENTRY", null).setPositiveButton("CANCEL ENTRY", (dialog, which) -> request("POST", "/api/leagues/" + Uri.encode(leagueId) + "/cancel", token, new JSONObject(), action -> {
                                if (!action.ok()) showMessage(action.message("Could not cancel league entry."), true);
                                else { showMessage(action.message("League entry cancelled."), false); renderLeagues(); }
                            })).show());
                    } else if (membership.optBoolean("canForfeit")) {
                        Button forfeit = secondaryButton("FORFEIT REMAINING FIXTURES");
                        details.addView(forfeit, margins(-1, dp(44), 0, 0, 0, dp(8)));
                        forfeit.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Forfeit this league?")
                            .setMessage("Remaining eligible fixtures may be awarded as walkovers. Your entry fee is not refunded.")
                            .setNegativeButton("KEEP PLAYING", null).setPositiveButton("FORFEIT", (dialog, which) -> request("POST", "/api/leagues/" + Uri.encode(leagueId) + "/forfeit", token, new JSONObject(), action -> {
                                if (!action.ok()) showMessage(action.message("Could not forfeit this league."), true);
                                else { showMessage(action.message("League forfeited."), false); renderLeagues(); }
                            })).show());
                    }
                } else {
                    addNoticeTo(details, "You are not a member of this league. Entry is required before fixtures can be played.", SUBTLE);
                }
                if (fixtures == null || fixtures.length() == 0) {
                    addNoticeTo(details, "No fixtures are available.", SUBTLE);
                    return;
                }
                for (int i = 0; i < fixtures.length(); i++) {
                    JSONObject fixture = fixtures.optJSONObject(i);
                    if (fixture == null) continue;
                    LinearLayout item = card();
                    item.addView(text(fixture.optString("home", "Home") + "  vs  " + fixture.optString("away", "Waiting"), 13, TEXT, true));
                    item.addView(text(fixture.optString("round_name", "Fixture") + " · " + fixture.optString("status", "scheduled"), 11, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, 0));
                    if (fixture.optBoolean("mine") && fixture.optLong("away_id", 0) > 0 && membership.optBoolean("isMember") &&
                        ("scheduled".equals(fixture.optString("status")) || "playing".equals(fixture.optString("status")) || "waiting".equals(fixture.optString("status")))) {
                        Button play = primaryButton("OPEN / START THIS FIXTURE");
                        item.addView(play, margins(-1, dp(42), 0, dp(4), 0, 0));
                        String leagueName = league == null ? leagueId : league.optString("name", leagueId);
                        long fixtureId = fixture.optLong("fixture_id", 0);
                        play.setOnClickListener(v -> startCompetitionMatch("league-" + leagueName.toLowerCase(Locale.ROOT), leagueName, fixtureId, 0, play));
                    }
                    details.addView(item, margins(-1, -2, 0, 0, 0, dp(6)));
                }
            });
            pageStatus.setText("Live league data loaded from GOAL$GAMBIT.");
        });
    }

    private void loadNotifications(LinearLayout list) {
        list.removeAllViews();
        list.addView(text("Loading your GOAL$GAMBIT alerts…", 12, SUBTLE, false));
        final int[] pending = { supportsEfootballNotifications() ? 3 : 2 };
        Runnable settled = () -> {
            if (--pending[0] != 0 || !"notifications".equals(currentScreen)) return;
            if (list.getChildCount() == 0) list.addView(text("No saved notifications yet.", 13, SUBTLE, false));
            if (pageStatus != null) pageStatus.setText("Your account notification inbox is up to date.");
        };
        Runnable removeLoading = () -> {
            if (list.getChildCount() == 1 && list.getChildAt(0) instanceof TextView &&
                "Loading your GOAL$GAMBIT alerts…".contentEquals(((TextView) list.getChildAt(0)).getText())) list.removeAllViews();
        };
        request("GET", "/api/push/history?limit=50", token, null, result -> {
            if (!"notifications".equals(currentScreen)) return;
            removeLoading.run();
            if (result.ok()) {
                JSONArray notifications = result.object.optJSONArray("notifications");
                if (notifications != null) for (int i = 0; i < notifications.length(); i++) {
                    JSONObject notification = notifications.optJSONObject(i);
                    if (notification == null) continue;
                    addNotificationCard(list, notification, "body", "deliveryStatus", "/api/push/history/", "push");
                }
            } else if (result.status == 401) {
                expireSession();
            } else addNoticeTo(list, result.message("Account notification history is temporarily unavailable."), Color.rgb(126, 77, 54));
            settled.run();
        });
        request("GET", "/api/chat/announcements", token, null, result -> {
            if (!"notifications".equals(currentScreen)) return;
            removeLoading.run();
            if (result.ok()) {
                JSONArray announcements = result.object.optJSONArray("announcements");
                if (announcements != null) for (int i = 0; i < announcements.length(); i++) {
                    JSONObject announcement = announcements.optJSONObject(i);
                    if (announcement == null) continue;
                    LinearLayout panel = card();
                    String eventName = announcement.optString("event_name", "");
                    panel.addView(text(eventName.isEmpty() ? "GOAL$GAMBIT ANNOUNCEMENT" : eventName.toUpperCase(Locale.ROOT), 14, GOLD, true));
                    panel.addView(text(announcement.optString("message", ""), 13, TEXT, false), margins(-1, -2, 0, dp(4), 0, 0));
                    String eventAt = announcement.optString("event_at", "");
                    if (!eventAt.isEmpty()) panel.addView(text("Event time · " + formatTime(eventAt), 11, MUTED_GOLD, false), margins(-1, -2, 0, dp(4), 0, 0));
                    panel.addView(text("Posted " + formatTime(announcement.optString("published_at", announcement.optString("created_at", ""))), 10, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
                    long id = announcement.optLong("id", 0);
                    if (id > 0 && !announcement.optBoolean("is_read", false)) {
                        Button markRead = secondaryButton("MARK READ");
                        panel.addView(markRead, margins(-1, dp(38), 0, dp(6), 0, 0));
                        markRead.setOnClickListener(v -> request("POST", "/api/chat/announcements/" + id + "/read", token, new JSONObject(), readResult -> {
                            if (readResult.ok()) loadNotifications(list);
                        }));
                    }
                    list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
                }
            } else if (result.status == 401) expireSession();
            else addNoticeTo(list, result.message("Event announcements are temporarily unavailable."), Color.rgb(126, 77, 54));
            settled.run();
        });
        if (supportsEfootballNotifications()) {
            request("GET", "/api/efootball/notifications", token, null, result -> {
                if (!"notifications".equals(currentScreen)) return;
                removeLoading.run();
                if (result.ok()) {
                    JSONArray notifications = result.object.optJSONArray("notifications");
                    if (notifications != null) for (int i = 0; i < notifications.length(); i++) {
                        JSONObject notification = notifications.optJSONObject(i);
                        if (notification != null) addNotificationCard(list, notification, "message", "", "/api/efootball/notifications/", "system");
                    }
                } else if (result.status == 401) expireSession();
                else addNoticeTo(list, result.message("Match alerts are temporarily unavailable."), Color.rgb(126, 77, 54));
                settled.run();
            });
        }
    }

    private boolean supportsEfootballNotifications() {
        String game = currentUser.optString("game", "");
        return "konami".equalsIgnoreCase(game) || "both".equalsIgnoreCase(game);
    }

    private void addNotificationCard(LinearLayout list, JSONObject notification, String bodyKey,
                                     String statusKey, String readPath, String source) {
        LinearLayout panel = card();
        panel.addView(text(notification.optString("title", "GOAL$GAMBIT notification"), 14, GOLD, true));
        panel.addView(text(notification.optString(bodyKey, ""), 13, TEXT, false), margins(-1, -2, 0, dp(4), 0, 0));
        String status = statusKey.isEmpty() ? "" : notification.optString(statusKey, "");
        String timestamp = formatTime(notification.optString("created_at", ""));
        panel.addView(text(status.isEmpty() ? timestamp : timestamp + " · " + status, 10, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
        long id = notification.optLong("id", 0);
        if (id > 0 && notification.isNull("read_at")) {
            Button markRead = secondaryButton("MARK READ");
            panel.addView(markRead, margins(-1, dp(38), 0, dp(6), 0, 0));
            markRead.setOnClickListener(v -> {
                markRead.setEnabled(false);
                String path = readPath + id + "/read";
                request("POST", path, token, new JSONObject(), readResult -> {
                    if (readResult.ok()) loadNotifications(list);
                    else {
                        markRead.setEnabled(true);
                        showMessage(readResult.message("This alert could not be marked read."), true);
                    }
                });
            });
        }
        list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
    }

    private void sendSupport(Button send, LinearLayout messageList) {
        if (requestBusy) return;
        String message = supportMessage.getText().toString().trim();
        String subject = supportSubject.getText().toString().trim();
        if (message.isEmpty()) {
            pageStatus.setText("Write a message before sending.");
            return;
        }
        String category;
        switch (supportCategory.getSelectedItemPosition()) {
            case 1: category = "suggestion"; break;
            case 2: category = "technical"; break;
            case 3: category = "match_room_code"; break;
            case 4: category = "account"; break;
            case 5: category = "important"; break;
            default: category = "general";
        }
        JSONObject body = new JSONObject();
        try {
            body.put("message", message);
            body.put("subject", subject);
            body.put("category", category);
            body.put("clientMessageId", UUID.randomUUID().toString().replace("-", ""));
        } catch (Exception ignored) {}
        requestBusy = true;
        send.setEnabled(false);
        pageStatus.setText("Sending to support…");
        request("POST", "/api/chat/support", token, body, result -> {
            requestBusy = false;
            send.setEnabled(true);
            if (!result.ok()) {
                pageStatus.setText(result.message("Message was not sent. Your text is still here; try again."));
                return;
            }
            supportMessage.setText("");
            pageStatus.setText("Message sent to GOAL$GAMBIT support.");
            request("GET", "/api/chat/support", token, null, refresh -> {
                if (refresh.ok() && "support".equals(currentScreen)) drawSupportMessages(messageList, refresh.object.optJSONArray("messages"));
            });
        });
    }

    private void drawSupportMessages(LinearLayout container, JSONArray messages) {
        container.removeAllViews();
        if (messages == null || messages.length() == 0) {
            container.addView(text("No support messages yet. Send a message to open a private conversation.", 12, SUBTLE, false));
            return;
        }
        for (int i = 0; i < messages.length(); i++) {
            JSONObject item = messages.optJSONObject(i);
            if (item == null) continue;
            boolean mine = item.optLong("sender_id", -1) == currentUser.optLong("id", -2);
            LinearLayout bubble = new LinearLayout(this);
            bubble.setOrientation(LinearLayout.VERTICAL);
            bubble.setPadding(dp(11), dp(9), dp(11), dp(9));
            bubble.setBackground(round(mine ? Color.rgb(53, 43, 17) : PANEL, dp(8), mine ? Color.rgb(108, 86, 31) : Color.rgb(48, 48, 48), dp(1)));
            bubble.addView(text(mine ? "YOU" : item.optString("username", "GOAL$GAMBIT SUPPORT"), 10, MUTED_GOLD, true));
            bubble.addView(text(item.optString("message", ""), 13, TEXT, false), margins(-1, -2, 0, dp(3), 0, 0));
            bubble.addView(text(formatTime(item.optString("created_at", "")), 9, SUBTLE, false));
            container.addView(bubble, margins(-1, -2, 0, 0, 0, dp(6)));
        }
    }

    private void buildNavigation() {
        navigation.removeAllViews();
        HorizontalScrollView strip = new HorizontalScrollView(this);
        strip.setHorizontalScrollBarEnabled(false);
        LinearLayout items = new LinearLayout(this);
        items.setOrientation(LinearLayout.HORIZONTAL);
        String[][] tabs = { {"HOME", "home"}, {"CHESS", "chess"}, {"eFOOTBALL", "efootball"}, {"LEAGUES", "leagues"}, {"WALLET", "wallet"}, {"ALERTS", "notifications"}, {"MORE", "more"} };
        for (String[] tab : tabs) {
            Button button = new Button(this);
            button.setText(tab[0]);
            button.setTextSize(10);
            button.setTextColor(currentScreen.equals(tab[1]) ? BG : TEXT);
            button.setAllCaps(false);
            button.setMinHeight(dp(42));
            button.setMinWidth(dp(74));
            button.setPadding(dp(8), 0, dp(8), 0);
            button.setBackground(round(currentScreen.equals(tab[1]) ? GOLD : PANEL, dp(8), Color.rgb(62, 55, 36), dp(1)));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, dp(42));
            lp.setMargins(dp(3), dp(2), dp(3), dp(2));
            items.addView(button, lp);
            button.setOnClickListener(v -> navigate(tab[1]));
        }
        strip.addView(items);
        navigation.addView(strip, matchWrap());
    }

    private void request(String method, String path, String bearer, JSONObject body, Consumer<ApiClient.Result> callback) {
        requests.execute(() -> {
            ApiClient.Result result;
            try {
                result = ApiClient.request(method, path, bearer, body);
            } catch (Exception error) {
                JSONObject failure = new JSONObject();
                try { failure.put("message", error.getMessage() == null ? "The service is unavailable. Check your connection and try again." : error.getMessage()); }
                catch (Exception ignored) {}
                result = new ApiClient.Result(0, failure, null, false);
            }
            ApiClient.Result finalResult = result;
            runOnUiThread(() -> {
                if (callback != null && !isFinishing()) callback.accept(finalResult);
            });
        });
    }

    private void signOut() {
        if (chessSocket != null) {
            chessSocket.close();
            chessSocket = null;
        }
        SessionStore.clear(this);
        token = null;
        currentUser = new JSONObject();
        currentChessMatchId = 0;
        currentChessState = null;
        legalDestinations.clear();
        chessBoard = null;
        registering = false;
        setConnection("Signed out", false);
        renderAuth();
    }

    private void expireSession() {
        SessionStore.clear(this);
        token = null;
        if (chessSocket != null) chessSocket.close();
        chessSocket = null;
        currentUser = new JSONObject();
        currentChessMatchId = 0;
        currentChessState = null;
        navigation.setVisibility(View.GONE);
        setConnection("Please sign in again", false);
        renderAuth();
    }

    private void showMessage(String message, boolean error) {
        if (pageStatus != null && "auth".equals(currentScreen)) {
            pageStatus.setText(message);
            pageStatus.setTextColor(error ? Color.rgb(255, 126, 126) : SUBTLE);
        } else Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private void setConnection(String status, boolean connected) {
        if (connectionStatus == null) return;
        connectionStatus.setText(status == null ? "" : status);
        connectionStatus.setTextColor(connected ? Color.rgb(144, 203, 150) : SUBTLE);
    }

    private void openUrl(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
        catch (Exception ignored) { Toast.makeText(this, "Could not open the terms page.", Toast.LENGTH_SHORT).show(); }
    }

    private void addHeading(String title, String description) {
        TextView heading = text(title, 23, GOLD, true);
        content.addView(heading, margins(-1, -2, 0, 0, 0, dp(3)));
        TextView details = text(description, 13, SUBTLE, false);
        if ("Welcome back,".equals(title)) {
            try {
                Typeface pacifico = Typeface.createFromAsset(getAssets(), "fonts/Pacifico-Regular.ttf");
                details.setTypeface(Typeface.create(pacifico, Typeface.BOLD));
                details.setTextSize(25);
                details.setTextColor(MUTED_GOLD);
            } catch (RuntimeException ignored) {}
        }
        content.addView(details, margins(-1, -2, 0, 0, 0, dp(13)));
    }

    private void addNotice(String message, int color) { addNoticeTo(content, message, color); }

    private void addNoticeTo(LinearLayout parent, String message, int color) {
        TextView notice = text(message, 12, TEXT, false);
        notice.setPadding(dp(12), dp(10), dp(12), dp(10));
        notice.setBackground(round(PANEL, dp(6), color, dp(1)));
        parent.addView(notice, margins(-1, -2, 0, 0, 0, dp(10)));
    }

    private LinearLayout card() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(13), dp(12), dp(13), dp(12));
        panel.setBackground(round(PANEL, dp(9), Color.rgb(47, 47, 47), dp(1)));
        return panel;
    }

    private void addDetail(LinearLayout parent, String label, String value) {
        parent.addView(text(label, 10, MUTED_GOLD, true), margins(-1, -2, 0, dp(4), 0, dp(2)));
        parent.addView(text(value == null || value.isEmpty() ? "—" : value, 14, TEXT, false), margins(-1, -2, 0, 0, 0, dp(12)));
    }

    private EditText input(String hint, int inputType) {
        EditText edit = new EditText(this);
        edit.setSingleLine(true);
        edit.setTextColor(TEXT);
        edit.setHintTextColor(Color.rgb(135, 135, 135));
        edit.setHint(hint);
        edit.setTextSize(14);
        edit.setInputType(inputType);
        edit.setPadding(dp(13), dp(8), dp(13), dp(8));
        edit.setBackground(round(Color.rgb(28, 28, 28), dp(7), Color.rgb(76, 66, 39), dp(1)));
        return edit;
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value == null ? "" : value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setLineSpacing(dp(2), 1f);
        return view;
    }

    private Button primaryButton(String label) { return styleButton(label, GOLD, BG, Color.rgb(196, 157, 30)); }
    private Button secondaryButton(String label) { return styleButton(label, Color.rgb(18, 18, 18), GOLD, Color.rgb(131, 106, 36)); }

    private Button styleButton(String label, int fill, int foreground, int stroke) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(foreground);
        button.setTextSize(12);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setMinHeight(dp(44));
        button.setPadding(dp(10), dp(4), dp(10), dp(4));
        button.setBackground(round(fill, dp(8), stroke, dp(1)));
        return button;
    }

    private GradientDrawable round(int fill, int radius, int stroke, int strokeWidth) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(radius);
        if (strokeWidth > 0) shape.setStroke(strokeWidth, stroke);
        return shape;
    }

    private LinearLayout.LayoutParams margins(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(left, top, right, bottom);
        return params;
    }

    private LinearLayout.LayoutParams matchWrap() { return new LinearLayout.LayoutParams(-1, -2); }
    private LinearLayout.LayoutParams wrap() { return new LinearLayout.LayoutParams(-2, -2); }
    private int dp(int size) { return Math.round(size * getResources().getDisplayMetrics().density); }

    private Spinner optionSpinner(String[] options) {
        Spinner spinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, options);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        spinner.setPadding(dp(8), 0, dp(8), 0);
        spinner.setBackground(round(Color.rgb(36, 36, 36), dp(7), Color.rgb(74, 67, 48), dp(1)));
        return spinner;
    }

    private static String gameName(String game) {
        if ("konami".equalsIgnoreCase(game)) return "eFootball";
        if ("both".equalsIgnoreCase(game)) return "Chess + eFootball";
        if ("chess".equalsIgnoreCase(game)) return "Chess";
        return "Player";
    }

    private static String sideLabel(String side) { return "b".equalsIgnoreCase(side) ? "Black" : "White"; }

    private static String money(double amount) { return String.format(Locale.US, "%.2f", amount); }

    private static String clockText(long millis) {
        long total = Math.max(0, millis) / 1000;
        return String.format(Locale.US, "%d:%02d", total / 60, total % 60);
    }

    private static String formatTime(String value) {
        if (value == null || value.trim().isEmpty()) return "Time unavailable";
        try {
            String[] patterns = { "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX" };
            java.util.Date date = null;
            for (String pattern : patterns) {
                try {
                    java.text.SimpleDateFormat parser = new java.text.SimpleDateFormat(pattern, Locale.US);
                    parser.setLenient(false);
                    date = parser.parse(value);
                    if (date != null) break;
                } catch (Exception ignoredPattern) {}
            }
            return date == null ? value.replace('T', ' ') : DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(date);
        } catch (Exception ignored) {
            return value.replace('T', ' ');
        }
    }

    private static String jsonSquare(JSONObject object, String key) {
        if (object == null) return "";
        String value = object.optString(key, "");
        return value.matches("[a-h][1-8]") ? value : "";
    }

    @Override
    public void onBackPressed() {
        if ("chessboard".equals(currentScreen)) {
            if (chessSocket != null) chessSocket.setMatch(0);
            currentChessMatchId = 0;
            chessBoard = null;
            navigate("chess");
        } else if ("efootballMatch".equals(currentScreen)) {
            navigate("efootball");
        } else if ("tournament".equals(currentScreen)) {
            navigate("leagues");
        } else if ("profile".equals(currentScreen) || "support".equals(currentScreen) ||
                   "notifications".equals(currentScreen) || "leaderboard".equals(currentScreen)) {
            navigate("more");
        } else if (!"home".equals(currentScreen) && token != null) {
            navigate("home");
        } else {
            super.onBackPressed();
        }
    }

    private void renderEfootball() {
        content.removeAllViews();
        addHeading("eFootball Match Hub", "Create or resume a real backend match. Room codes, readiness and results are private to its two players.");
        addNotice("Ranked search uses KSh 20, 50, or 100 and is available during the server’s scheduled match window. The backend controls matching, fees, results and settlement.", MUTED_GOLD);
        pageStatus = text("Checking matchmaking availability…", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, 0, 0, dp(8)));
        request("GET", "/api/efootball/status", token, null, result -> {
            if (!"efootball".equals(currentScreen)) return;
            if (result.ok()) {
                JSONObject schedule = result.object.optJSONObject("schedule");
                pageStatus.setText(schedule == null ? "Matchmaking status loaded from GOAL$GAMBIT." :
                    (schedule.optBoolean("isMatchmakingOpen") ? "Ranked matchmaking is open now." : schedule.optString("message", "New ranked searches are currently closed.")));
            } else pageStatus.setText(result.message("Could not check matchmaking status. You can still open an existing match."));
        });
        Spinner stake = optionSpinner(new String[] { "KSh 20 ranked stake", "KSh 50 ranked stake", "KSh 100 ranked stake" });
        content.addView(stake, margins(-1, dp(48), 0, 0, 0, dp(8)));
        Button search = primaryButton("FIND RANKED eFOOTBALL OPPONENT");
        content.addView(search, margins(-1, dp(52), 0, 0, 0, dp(14)));
        search.setOnClickListener(v -> startEfootballRankedSearch(search, stake.getSelectedItemPosition()));
        Button refresh = secondaryButton("REFRESH MATCH HUB");
        content.addView(refresh, margins(-1, dp(44), 0, 0, 0, dp(12)));
        refresh.setOnClickListener(v -> renderEfootball());
        content.addView(text("ACTIVE MATCHES", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        LinearLayout active = new LinearLayout(this);
        active.setOrientation(LinearLayout.VERTICAL);
        content.addView(active, margins(-1, -2, 0, 0, 0, dp(12)));
        content.addView(text("RECENT MATCH HISTORY", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        LinearLayout history = new LinearLayout(this);
        history.setOrientation(LinearLayout.VERTICAL);
        content.addView(history, matchWrap());
        loadEfootballMatches(active, history);
    }

    private void startEfootballRankedSearch(Button button, int selectedIndex) {
        int stakeAmount = selectedIndex == 2 ? 100 : selectedIndex == 1 ? 50 : 20;
        new AlertDialog.Builder(this).setTitle("Enter ranked eFootball?")
            .setMessage("KSh " + stakeAmount + " will be locked from your available wallet balance by the server. GOAL$GAMBIT will match you with an eligible player; winnings and refunds follow the server’s settlement rules. Continue?")
            .setNegativeButton("CANCEL", null).setPositiveButton("FIND OPPONENT", (dialog, which) -> {
                button.setEnabled(false);
                JSONObject body = new JSONObject();
                try { body.put("mode", "ranked"); body.put("stake_amount", stakeAmount); }
                catch (Exception ignored) {}
                request("POST", "/api/efootball/matches", token, body, result -> {
                    button.setEnabled(true);
                    if (!result.ok()) { showMessage(result.message("Ranked matchmaking could not start."), true); return; }
                    JSONObject match = result.object.optJSONObject("match");
                    if (match == null) { showMessage("The server returned no match details. Refresh your Match Hub.", true); return; }
                    showMessage(result.object.optString("message", "Your ranked search is saved on the server."), false);
                    openEfootballMatch(match);
                });
            }).show();
    }

    private void loadEfootballMatches(LinearLayout active, LinearLayout history) {
        active.removeAllViews();
        history.removeAllViews();
        request("GET", "/api/efootball/matches/active", token, null, result -> {
            if (!"efootball".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            JSONArray matches = result.object.optJSONArray("matches");
            if (!result.ok() || matches == null || matches.length() == 0) {
                active.addView(text(result.ok() ? "No active eFootball matches. Start a ranked search or join an eligible competition fixture." : result.message("Could not load active eFootball matches."), 12, SUBTLE, false));
                return;
            }
            for (int i = 0; i < matches.length(); i++) {
                JSONObject match = matches.optJSONObject(i);
                if (match == null) continue;
                LinearLayout panel = card();
                panel.addView(text("MATCH #" + match.optLong("id", 0) + " · " + match.optString("status", "unknown").toUpperCase(Locale.ROOT), 15, GOLD, true));
                panel.addView(text(match.optString("mode", "eFootball") + " · vs " + match.optString("opponentUsername", "Waiting for opponent") +
                    "\nStake KSh " + money(match.optDouble("stake_amount", match.optDouble("stakeAmount", 0))) +
                    " · room code " + (match.optBoolean("codeSent") ? "sent" : "waiting"), 12, TEXT, false), margins(-1, -2, 0, dp(4), 0, dp(6)));
                Button open = primaryButton("OPEN MATCH HUB");
                panel.addView(open, matchWrap());
                open.setOnClickListener(v -> openEfootballMatch(match));
                active.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
            }
        });
        request("GET", "/api/efootball/matches/history/mine", token, null, result -> {
            if (!"efootball".equals(currentScreen)) return;
            JSONArray games = result.object.optJSONArray("matches");
            if (!result.ok() || games == null || games.length() == 0) {
                history.addView(text(result.ok() ? "No completed eFootball matches yet." : result.message("Match history could not be loaded."), 12, SUBTLE, false));
                return;
            }
            for (int i = 0; i < Math.min(games.length(), 20); i++) {
                JSONObject game = games.optJSONObject(i);
                if (game == null) continue;
                LinearLayout row = card();
                row.addView(text("MATCH #" + game.optLong("id", 0) + " · " + game.optString("status", "completed").toUpperCase(Locale.ROOT), 13, GOLD, true));
                row.addView(text(game.optString("creator_username", "Player") + "  " + game.optString("creator_score", "—") + " : " + game.optString("opponent_score", "—") + "  " + game.optString("opponent_username", "Opponent") +
                    "\n" + formatTime(game.optString("finished_at", game.optString("created_at", ""))), 11, TEXT, false), margins(-1, -2, 0, dp(3), 0, 0));
                history.addView(row, margins(-1, -2, 0, 0, 0, dp(7)));
            }
        });
    }

    private void openEfootballMatch(JSONObject match) {
        if (match == null) return;
        currentEfootballMatch = match;
        navigate("efootballMatch");
    }

    private void renderEfootballMatch() {
        JSONObject match = currentEfootballMatch;
        if (match == null) { navigate("efootball"); return; }
        content.removeAllViews();
        Button back = secondaryButton("‹  BACK TO MATCH HUB");
        content.addView(back, margins(-1, dp(44), 0, 0, 0, dp(10)));
        back.setOnClickListener(v -> navigate("efootball"));
        long id = match.optLong("id", 0);
        addHeading("Match #" + id, "Your private eFootball room. The server confirms every step before the match or result changes.");
        pageStatus = text("", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, dp(8)));
        LinearLayout details = card();
        details.addView(text(match.optString("status", "unknown").toUpperCase(Locale.ROOT) + " · " + match.optString("mode", "eFootball"), 14, GOLD, true));
        details.addView(text("You · " + match.optString("yourName", currentUser.optString("username", "You")) +
            "\nOpponent · " + match.optString("opponentName", match.optString("opponentUsername", "Waiting")) +
            "\nStake · KSh " + money(match.optDouble("stake_amount", match.optDouble("stakeAmount", 0))) +
            "\nRoom-code sender · " + match.optString("codeSenderName", match.optBoolean("youAreSender") ? "You" : "Opponent"), 12, TEXT, false), margins(-1, -2, 0, dp(5), 0, 0));
        content.addView(details, margins(-1, -2, 0, 0, 0, dp(10)));

        if (match.optBoolean("youAreSender") && (!match.optBoolean("codeSent") || match.optBoolean("codeCorrectionRequested"))) {
            addNotice("You are the selected sender. Paste the official room code from eFootball; it will be sent only to your matched opponent.", MUTED_GOLD);
            Button send = primaryButton(match.optBoolean("codeCorrectionRequested") ? "SEND REPLACEMENT ROOM CODE" : "SEND ROOM CODE TO OPPONENT");
            content.addView(send, margins(-1, dp(50), 0, 0, 0, dp(8)));
            send.setOnClickListener(v -> promptRoomCode(id, send));
        } else if (match.optBoolean("youAreReceiver") && match.optBoolean("codeSent")) {
            String roomCode = match.optString("room_code", "");
            if (!roomCode.isEmpty()) {
                LinearLayout codeCard = card();
                codeCard.addView(text("OFFICIAL ROOM CODE", 11, GOLD, true));
                codeCard.addView(text(roomCode, 25, TEXT, true), margins(-1, -2, 0, dp(4), 0, dp(4)));
                Button copy = secondaryButton("COPY ROOM CODE");
                codeCard.addView(copy, matchWrap());
                copy.setOnClickListener(v -> {
                    ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("GOAL$GAMBIT room code", roomCode));
                    showMessage("Room code copied.", false);
                });
                content.addView(codeCard, margins(-1, -2, 0, 0, 0, dp(8)));
            }
            if (!match.optBoolean("codeReceived")) {
                Button received = primaryButton("CONFIRM CODE RECEIVED");
                content.addView(received, margins(-1, dp(48), 0, 0, 0, dp(7)));
                received.setOnClickListener(v -> sendEfootballAction(id, "/code-received", new JSONObject(), "Code receipt confirmed."));
                Button correction = secondaryButton("REQUEST A REPLACEMENT CODE");
                content.addView(correction, margins(-1, dp(46), 0, 0, 0, dp(9)));
                correction.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Request a new room code?")
                    .setMessage("This tells the sender to replace the code. The current room code will no longer be treated as confirmed.")
                    .setNegativeButton("KEEP CODE", null).setPositiveButton("REQUEST REPLACEMENT", (dialog, which) -> sendEfootballAction(id, "/code-correction", new JSONObject(), "Replacement requested." )).show());
            }
        }

        if (match.optBoolean("codeSent") && match.optBoolean("codeReceived") && !"playing".equals(match.optString("status"))) {
            Button ready = primaryButton(match.optBoolean("yourReady") ? "YOU ARE READY · WAITING FOR OPPONENT" : "I'M READY");
            ready.setEnabled(!match.optBoolean("yourReady"));
            content.addView(ready, margins(-1, dp(50), 0, 0, 0, dp(8)));
            ready.setOnClickListener(v -> sendEfootballAction(id, "/ready", new JSONObject(), "Ready status saved."));
            content.addView(text("You · " + (match.optBoolean("yourReady") ? "Ready" : "Not ready") + "    ·    Opponent · " + (match.optBoolean("opponentReady") ? "Ready" : "Waiting"), 11, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, dp(8)));
        }

        if ("waiting".equals(match.optString("status")) && !match.optBoolean("codeSent")) {
            Button cancel = secondaryButton("CANCEL MATCH SEARCH");
            content.addView(cancel, margins(-1, dp(46), 0, 0, 0, dp(9)));
            cancel.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Cancel this match?")
                .setMessage("The backend will cancel the search and apply any eligible stake refund to both players.")
                .setNegativeButton("KEEP SEARCHING", null).setPositiveButton("CANCEL MATCH", (dialog, which) -> sendEfootballAction(id, "/cancel", new JSONObject(), "Match cancelled." )).show());
        }

        if ("playing".equals(match.optString("status")) && match.optBoolean("canEditScore")) {
            content.addView(text("SUBMIT YOUR MATCH RESULT", 13, GOLD, true), margins(-1, -2, 0, dp(5), 0, dp(6)));
            EditText yourScore = input("Your goals", InputType.TYPE_CLASS_NUMBER);
            EditText opponentScore = input("Opponent goals", InputType.TYPE_CLASS_NUMBER);
            content.addView(yourScore, margins(-1, dp(48), 0, 0, 0, dp(7)));
            content.addView(opponentScore, margins(-1, dp(48), 0, 0, 0, dp(7)));
            Button submit = primaryButton("SUBMIT SCORES FOR SERVER VERIFICATION");
            content.addView(submit, margins(-1, dp(52), 0, 0, 0, dp(10)));
            submit.setOnClickListener(v -> submitEfootballResult(id, yourScore, opponentScore, submit));
        } else if (match.optBoolean("creator_submitted") || match.optBoolean("opponent_submitted")) {
            addNotice("A score report has been submitted. Current settlement and verification status: " + match.optString("status", "awaiting confirmation") + ".", MUTED_GOLD);
        }
        if ("awaiting_verification".equals(match.optString("status")) || "disputed".equals(match.optString("status"))) {
            Button audit = secondaryButton("VIEW RESULT VERIFICATION");
            content.addView(audit, margins(-1, dp(46), 0, 0, 0, dp(8)));
            audit.setOnClickListener(v -> loadEfootballAudit(id));
        }
        Button refresh = secondaryButton("REFRESH MATCH FROM SERVER");
        content.addView(refresh, margins(-1, dp(44), 0, 0, 0, dp(8)));
        refresh.setOnClickListener(v -> refreshEfootballMatch(id));
    }

    private void promptRoomCode(long matchId, Button button) {
        EditText code = input("Paste official eFootball room code", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        code.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("Send room code privately")
            .setMessage("Only the opponent assigned to this match can receive this code.")
            .setView(code).setNegativeButton("CANCEL", null).setPositiveButton("SEND CODE", (dialog, which) -> {
                JSONObject body = new JSONObject();
                try { body.put("code", code.getText().toString().trim()); } catch (Exception ignored) {}
                sendEfootballAction(matchId, "/send-code", body, "Room code sent to your matched opponent.");
            }).show();
    }

    private void sendEfootballAction(long matchId, String action, JSONObject body, String fallback) {
        request("POST", "/api/efootball/matches/" + matchId + action, token, body, result -> {
            if (!result.ok()) { if (pageStatus != null) pageStatus.setText(result.message("The match action was not accepted.")); showMessage(result.message("The match action was not accepted."), true); return; }
            showMessage(result.object.optString("message", fallback), false);
            JSONObject updated = result.object.optJSONObject("match");
            if (updated != null) currentEfootballMatch = updated;
            refreshEfootballMatch(matchId);
        });
    }

    private void refreshEfootballMatch(long matchId) {
        request("GET", "/api/efootball/matches/active", token, null, result -> {
            if (!result.ok()) { showMessage(result.message("Could not refresh this match."), true); return; }
            JSONArray matches = result.object.optJSONArray("matches");
            if (matches != null) for (int i = 0; i < matches.length(); i++) {
                JSONObject match = matches.optJSONObject(i);
                if (match != null && match.optLong("id", 0) == matchId) { currentEfootballMatch = match; renderEfootballMatch(); return; }
            }
            navigate("efootball");
            showMessage("This match is no longer active. Check your recent match history.", false);
        });
    }

    private void submitEfootballResult(long matchId, EditText own, EditText opponent, Button submit) {
        String ownText = own.getText().toString().trim(), opponentText = opponent.getText().toString().trim();
        if (!ownText.matches("\\d{1,2}") || !opponentText.matches("\\d{1,2}")) { showMessage("Enter both scores as whole numbers from 0 to 99.", true); return; }
        new AlertDialog.Builder(this).setTitle("Submit this score?")
            .setMessage("You are reporting " + ownText + "–" + opponentText + ". The other player must submit their score too; the backend verifies agreement before settlement.")
            .setNegativeButton("REVIEW", null).setPositiveButton("SUBMIT SCORE", (dialog, which) -> {
                JSONObject body = new JSONObject();
                try { body.put("yourScore", Integer.parseInt(ownText)); body.put("opponentScore", Integer.parseInt(opponentText)); }
                catch (Exception ignored) {}
                submit.setEnabled(false);
                request("POST", "/api/efootball/matches/" + matchId + "/result", token, body, result -> {
                    submit.setEnabled(true);
                    if (!result.ok()) { showMessage(result.message("The score could not be submitted."), true); return; }
                    showMessage(result.object.optString("message", "Score submitted to GOAL$GAMBIT for verification."), false);
                    refreshEfootballMatch(matchId);
                });
            }).show();
    }

    private void loadEfootballAudit(long matchId) {
        request("GET", "/api/efootball/matches/" + matchId + "/audit", token, null, result -> {
            if (!result.ok()) { showMessage(result.message("Verification details are unavailable."), true); return; }
            JSONObject audit = result.object.optJSONObject("audit");
            if (audit == null) audit = result.object;
            String summary = "Status · " + audit.optString("status", currentEfootballMatch.optString("status", "under review")) +
                "\nYour score · " + audit.optString("yourScore", "not available") +
                "\nOpponent report · " + audit.optString("opponentScore", "not available") +
                "\nEvidence · " + (currentEfootballMatch.optBoolean("screenshotSubmitted") ? "submitted" : "not submitted") +
                "\n\nThe backend remains responsible for score verification and final settlement.";
            new AlertDialog.Builder(this).setTitle("Match result verification").setMessage(summary).setPositiveButton("OK", null).show();
        });
    }

    private void renderLeagues() {
        content.removeAllViews();
        addHeading("Competitions", "Explore eFootball divisions and tournaments, review entry fees, open your fixtures and follow official standings.");
        if (!"konami".equalsIgnoreCase(currentUser.optString("game")) && !"both".equalsIgnoreCase(currentUser.optString("game"))) {
            addNotice("Your account is not registered for eFootball. These competitions require eFootball access on your GOAL$GAMBIT account.", MUTED_GOLD);
        }
        pageStatus = text("Loading league seasons and tournaments…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        content.addView(text("LEAGUE DIVISIONS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL);
        content.addView(list, margins(-1, -2, 0, 0, 0, dp(14)));
        request("GET", "/api/leagues", token, null, result -> {
            if (!"leagues".equals(currentScreen)) return;
            if (!result.ok()) { pageStatus.setText(result.message("Could not load leagues.")); return; }
            JSONArray leagues = result.object.optJSONArray("leagues");
            list.removeAllViews();
            if (leagues == null || leagues.length() == 0) list.addView(text("No eFootball leagues are configured.", 12, SUBTLE, false));
            if (leagues != null) for (int i = 0; i < leagues.length(); i++) {
                JSONObject league = leagues.optJSONObject(i);
                if (league == null) continue;
                String id = league.optString("id", league.optString("name", ""));
                LinearLayout panel = card();
                String name = league.optString("name", "League");
                panel.addView(text(name.toUpperCase(Locale.ROOT), 16, GOLD, true));
                panel.addView(text(league.optString("description", "Season standings and fixtures") +
                    "\nStatus · " + league.optString("status", "active") + " · Players · " + league.optInt("players", 0) +
                    "\nEntry fee · KSh " + money(league.optDouble("entry_stake", 0)), 11, TEXT, false), margins(-1, -2, 0, dp(4), 0, dp(6)));
                Button open = secondaryButton("VIEW STANDINGS & FIXTURES");
                panel.addView(open, margins(-1, dp(42), 0, 0, 0, dp(5)));
                open.setOnClickListener(v -> loadLeague(id));
                Button enter = primaryButton("JOIN " + name.toUpperCase(Locale.ROOT));
                panel.addView(enter, matchWrap());
                enter.setOnClickListener(v -> loadLeagueEntry(id, name, league.optDouble("entry_stake", 0)));
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
            }
            pageStatus.setText("League information and membership checks come from the backend.");
        });
        content.addView(text("TOURNAMENTS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
        LinearLayout tournaments = new LinearLayout(this); tournaments.setOrientation(LinearLayout.VERTICAL);
        content.addView(tournaments, matchWrap());
        loadTournamentCards(tournaments);
    }

    private void loadLeagueEntry(String leagueId, String name, double fee) {
        request("GET", "/api/leagues/" + Uri.encode(leagueId) + "/fixtures", token, null, status -> {
            if (!status.ok()) { showMessage(status.message("Could not check league membership."), true); return; }
            if (status.object.optBoolean("isMember")) { loadLeague(leagueId); return; }
            new AlertDialog.Builder(this).setTitle("Join " + name + "?")
                .setMessage("Entry fee · KSh " + money(fee) + "\n\nThe server will check your account and wallet, then save your membership. If an entry fee applies it is charged once for the season.")
                .setNegativeButton("NOT NOW", null).setPositiveButton("JOIN LEAGUE", (dialog, which) -> request("POST", "/api/leagues/" + Uri.encode(leagueId) + "/join", token, new JSONObject(), joined -> {
                    if (!joined.ok()) { showMessage(joined.message("League entry could not be completed."), true); return; }
                    showMessage(joined.message("League entry confirmed."), false);
                    loadLeague(leagueId);
                })).show();
        });
    }

    private void loadTournamentCards(LinearLayout list) {
        request("GET", "/api/tournaments", token, null, result -> {
            if (!"leagues".equals(currentScreen)) return;
            list.removeAllViews();
            JSONArray tournaments = result.object.optJSONArray("tournaments");
            if (!result.ok() || tournaments == null || tournaments.length() == 0) {
                list.addView(text(result.ok() ? "No tournaments are open or scheduled." : result.message("Tournaments could not be loaded."), 12, SUBTLE, false));
                return;
            }
            for (int i = 0; i < tournaments.length(); i++) {
                JSONObject tournament = tournaments.optJSONObject(i);
                if (tournament == null) continue;
                long id = tournament.optLong("id", 0);
                LinearLayout panel = card();
                panel.addView(text(tournament.optString("name", "Tournament").toUpperCase(Locale.ROOT), 15, GOLD, true));
                panel.addView(text(tournament.optString("tier", "eFootball") + " · " + tournament.optString("status", "open") +
                    "\nEntry · KSh " + money(tournament.optDouble("entry_fee", 0)) +
                    " · Players · " + tournament.optInt("players", 0) + "/" + tournament.optInt("max_players", 0) +
                    "\nStarts · " + formatTime(tournament.optString("starts_at", "")), 11, TEXT, false), margins(-1, -2, 0, dp(4), 0, dp(6)));
                Button view = secondaryButton(tournament.optBoolean("joined") ? "OPEN MY GROUP & FIXTURES" : "VIEW GROUPS & FIXTURES");
                panel.addView(view, margins(-1, dp(42), 0, 0, 0, dp(5)));
                view.setOnClickListener(v -> openTournament(id));
                if (!tournament.optBoolean("joined") && !tournament.optBoolean("forfeited") && !tournament.optBoolean("capacity_full") && "open".equals(tournament.optString("status"))) {
                    Button join = primaryButton("ENTER TOURNAMENT");
                    panel.addView(join, matchWrap());
                    join.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Enter tournament?")
                        .setMessage("Entry fee · KSh " + money(tournament.optDouble("entry_fee", 0)) + "\nCapacity · " + tournament.optInt("players", 0) + " of " + tournament.optInt("max_players", 0) + "\n\nThe backend will reserve or charge the entry according to tournament rules. Continue?")
                        .setNegativeButton("CANCEL", null).setPositiveButton("ENTER", (dialog, which) -> request("POST", "/api/tournaments/" + id + "/join", token, new JSONObject(), joined -> {
                            if (!joined.ok()) { showMessage(joined.message("Tournament entry was not accepted."), true); return; }
                            showMessage(joined.message("Tournament entry confirmed."), false);
                            openTournament(id);
                        })).show());
                }
                if (tournament.optBoolean("can_cancel")) {
                    Button cancel = secondaryButton("CANCEL ENTRY & REFUND"); panel.addView(cancel, margins(-1, dp(42), 0, dp(5), 0, 0));
                    cancel.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Cancel tournament entry?")
                        .setMessage("The backend will verify that you have not started your first match and, if eligible, refund the entry stake.")
                        .setNegativeButton("KEEP ENTRY", null).setPositiveButton("CANCEL ENTRY", (dialog, which) -> tournamentAction(id, "cancel", "Tournament entry cancelled." )).show());
                } else if (tournament.optBoolean("can_forfeit")) {
                    Button forfeit = secondaryButton("FORFEIT REMAINING FIXTURES"); panel.addView(forfeit, margins(-1, dp(42), 0, dp(5), 0, 0));
                    forfeit.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Forfeit tournament?")
                        .setMessage("Remaining fixtures may be awarded as walkovers. The entry fee is not refunded.")
                        .setNegativeButton("KEEP PLAYING", null).setPositiveButton("FORFEIT", (dialog, which) -> tournamentAction(id, "forfeit", "Tournament forfeited." )).show());
                }
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
            }
        });
    }

    private void tournamentAction(long id, String action, String fallback) {
        request("POST", "/api/tournaments/" + id + "/" + action, token, new JSONObject(), result -> {
            if (!result.ok()) { showMessage(result.message("Tournament action was not accepted."), true); return; }
            showMessage(result.object.optString("message", fallback), false);
            renderLeagues();
        });
    }

    private void openTournament(long id) {
        selectedTournamentId = id;
        navigate("tournament");
    }

    private void renderTournamentDetail() {
        content.removeAllViews();
        Button back = secondaryButton("‹  BACK TO COMPETITIONS");
        content.addView(back, margins(-1, dp(44), 0, 0, 0, dp(10)));
        back.setOnClickListener(v -> navigate("leagues"));
        addHeading("Tournament", "Official group tables, round dates and fixtures.");
        pageStatus = text("Loading tournament details…", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, dp(8)));
        LinearLayout sections = new LinearLayout(this); sections.setOrientation(LinearLayout.VERTICAL);
        content.addView(sections, matchWrap());
        long tournamentId = selectedTournamentId;
        request("GET", "/api/tournaments/" + tournamentId + "/status", token, null, result -> {
            if (!"tournament".equals(currentScreen)) return;
            if (!result.ok()) { pageStatus.setText(result.message("Could not load tournament details.")); return; }
            JSONObject tournament = result.object.optJSONObject("tournament");
            JSONArray standings = result.object.optJSONArray("standings");
            JSONArray fixtures = result.object.optJSONArray("fixtures");
            if (tournament != null) {
                LinearLayout summary = card();
                summary.addView(text(tournament.optString("name", "Tournament").toUpperCase(Locale.ROOT), 16, GOLD, true));
                summary.addView(text(tournament.optString("status", "open") + " · " + tournament.optString("tier", "eFootball") +
                    "\nEntry · KSh " + money(tournament.optDouble("entry_fee", 0)) + " · Players · " + tournament.optInt("players", 0) + "/" + tournament.optInt("max_players", 0) +
                    "\nStarts · " + formatTime(tournament.optString("starts_at", "")), 12, TEXT, false), margins(-1, -2, 0, dp(4), 0, 0));
                if (tournament.optBoolean("can_cancel")) {
                    Button cancel = secondaryButton("CANCEL ENTRY & REFUND"); summary.addView(cancel, margins(-1, dp(42), 0, dp(6), 0, 0));
                    cancel.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Cancel entry?")
                        .setMessage("The backend checks eligibility and handles any permitted refund.")
                        .setNegativeButton("KEEP", null).setPositiveButton("CANCEL ENTRY", (dialog, which) -> tournamentAction(tournamentId, "cancel", "Tournament entry cancelled." )).show());
                } else if (tournament.optBoolean("can_forfeit")) {
                    Button forfeit = secondaryButton("FORFEIT TOURNAMENT"); summary.addView(forfeit, margins(-1, dp(42), 0, dp(6), 0, 0));
                    forfeit.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Forfeit tournament?")
                        .setMessage("This ends your remaining tournament fixtures. Entry fee is not refunded.")
                        .setNegativeButton("KEEP PLAYING", null).setPositiveButton("FORFEIT", (dialog, which) -> tournamentAction(tournamentId, "forfeit", "Tournament forfeited." )).show());
                }
                sections.addView(summary, margins(-1, -2, 0, 0, 0, dp(12)));
            }
            pageStatus.setText("Tournament data is synchronized from the server.");
            sections.addView(text("GROUP STANDINGS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(6)));
            if (standings == null || standings.length() == 0) addNoticeTo(sections, "Groups will appear when the server assigns tournament entries.", SUBTLE);
            else for (int i = 0; i < standings.length(); i++) {
                JSONObject row = standings.optJSONObject(i); if (row == null) continue;
                LinearLayout item = card();
                item.addView(text("GROUP " + row.optString("group_code", "—") + " · " + row.optString("username", "Player"), 13, TEXT, true));
                item.addView(text("P " + row.optInt("played", 0) + " · W " + row.optInt("wins", 0) + " · D " + row.optInt("draws", 0) + " · L " + row.optInt("losses", 0) + " · Pts " + row.optInt("points", 0) + " · GD " + row.optInt("goal_difference", 0), 10, SUBTLE, false));
                sections.addView(item, margins(-1, -2, 0, 0, 0, dp(6)));
            }
            sections.addView(text("TOURNAMENT FIXTURES", 13, GOLD, true), margins(-1, -2, 0, dp(10), 0, dp(6)));
            if (fixtures == null || fixtures.length() == 0) addNoticeTo(sections, "No fixtures have been released yet.", SUBTLE);
            else for (int i = 0; i < fixtures.length(); i++) {
                JSONObject fixture = fixtures.optJSONObject(i); if (fixture == null) continue;
                LinearLayout item = card();
                item.addView(text(fixture.optString("home", "Home") + "  vs  " + fixture.optString("away", "Waiting"), 12, TEXT, true));
                item.addView(text(fixture.optString("round_name", "Fixture") + " · " + fixture.optString("status", "scheduled"), 10, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, 0));
                if (fixture.optBoolean("mine") && fixture.optLong("away_id", 0) > 0 && ("scheduled".equals(fixture.optString("status")) || "playing".equals(fixture.optString("status")) || "waiting".equals(fixture.optString("status")))) {
                    Button open = primaryButton("OPEN / START FIXTURE"); item.addView(open, margins(-1, dp(40), 0, dp(3), 0, 0));
                    open.setOnClickListener(v -> startCompetitionMatch("tournament", "", 0, tournamentId, open));
                }
                sections.addView(item, margins(-1, -2, 0, 0, 0, dp(6)));
            }
        });
    }

    private void startCompetitionMatch(String mode, String league, long fixtureId, long tournamentId, Button button) {
        new AlertDialog.Builder(this).setTitle("Open this competition fixture?")
            .setMessage("The backend checks the assigned fixture and your competition membership. No additional ranked match stake is added here; the competition entry is handled separately.")
            .setNegativeButton("CANCEL", null).setPositiveButton("OPEN FIXTURE", (dialog, which) -> {
                button.setEnabled(false);
                JSONObject body = new JSONObject();
                try {
                    body.put("mode", mode);
                    body.put("stake_amount", 0);
                    if (!league.isEmpty()) { body.put("league", league.replaceAll("(?i)\\s+league$", "")); if (fixtureId > 0) body.put("league_fixture_id", fixtureId); }
                    if (tournamentId > 0) body.put("tournament_id", tournamentId);
                } catch (Exception ignored) {}
                request("POST", "/api/efootball/matches", token, body, result -> {
                    button.setEnabled(true);
                    if (!result.ok()) { showMessage(result.message("This competition fixture cannot be opened yet."), true); return; }
                    JSONObject match = result.object.optJSONObject("match");
                    if (match == null) { showMessage("The server returned no match details. Refresh this fixture.", true); return; }
                    openEfootballMatch(match);
                });
            }).show();
    }

    private void renderWallet() {
        content.removeAllViews();
        addHeading("Wallet", "Live account balance, M-Pesa deposit requests, withdrawal quotes and transaction history.");
        addNotice("Only the authenticated backend can start or confirm a payment. An STK request is not a completed deposit; the wallet updates after Safaricom confirms it.", MUTED_GOLD);
        pageStatus = text("Loading your wallet…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        LinearLayout walletBox = new LinearLayout(this);
        walletBox.setOrientation(LinearLayout.VERTICAL);
        content.addView(walletBox, matchWrap());
        request("GET", "/api/wallet", token, null, result -> {
            if (!"wallet".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            if (!result.ok()) { pageStatus.setText(result.message("Could not load your wallet.")); return; }
            JSONObject wallet = result.object.optJSONObject("wallet");
            walletBox.removeAllViews();
            if (wallet == null) { pageStatus.setText("Wallet details were not returned."); return; }
            pageStatus.setText("");
            LinearLayout panel = card();
            panel.addView(text("AVAILABLE BALANCE", 12, GOLD, true));
            panel.addView(text("KSh " + money(wallet.optDouble("availableBalance", wallet.optDouble("balance", 0))), 28, TEXT, true), margins(-1, -2, 0, dp(5), 0, dp(10)));
            panel.addView(text("Locked: KSh " + money(wallet.optDouble("lockedBalance", 0)) + "\nReserved for withdrawal: KSh " + money(wallet.optDouble("reservedWithdrawalBalance", 0)), 13, SUBTLE, false));
            walletBox.addView(panel, margins(-1, -2, 0, 0, 0, dp(15)));
            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            Button deposit = primaryButton("DEPOSIT");
            Button withdraw = secondaryButton("WITHDRAW");
            actions.addView(deposit, new LinearLayout.LayoutParams(0, dp(48), 1f));
            LinearLayout.LayoutParams withdrawLp = new LinearLayout.LayoutParams(0, dp(48), 1f);
            withdrawLp.setMargins(dp(7), 0, 0, 0);
            actions.addView(withdraw, withdrawLp);
            walletBox.addView(actions, margins(-1, -2, 0, 0, 0, dp(9)));
            deposit.setOnClickListener(v -> showDepositForm());
            withdraw.setOnClickListener(v -> showWithdrawalForm());
            walletBox.addView(text("RECENT TRANSACTIONS", 13, GOLD, true), margins(-1, -2, 0, 0, 0, dp(7)));
            request("GET", "/api/wallet/transactions?limit=30", token, null, txResult -> {
                if (!"wallet".equals(currentScreen)) return;
                if (!txResult.ok()) { addNoticeTo(walletBox, txResult.message("Could not load transaction history."), SUBTLE); return; }
                JSONArray transactions = txResult.object.optJSONArray("transactions");
                if (transactions == null || transactions.length() == 0) {
                    addNoticeTo(walletBox, "No transactions are available.", SUBTLE);
                    return;
                }
                for (int i = 0; i < transactions.length(); i++) {
                    JSONObject tx = transactions.optJSONObject(i);
                    if (tx == null) continue;
                    LinearLayout row = card();
                    row.addView(text(tx.optString("description", tx.optString("transaction_type", "Wallet activity")), 14, TEXT, true));
                    row.addView(text("KSh " + money(tx.optDouble("amount", 0)) + " · " + tx.optString("status", "unknown") + " · " + formatTime(tx.optString("created_at", "")), 11, SUBTLE, false), margins(-1, -2, 0, dp(3), 0, 0));
                    walletBox.addView(row, margins(-1, -2, 0, 0, 0, dp(7)));
                }
            });
        });
    }

    private void showDepositForm() {
        LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL);
        EditText amount = input("Amount in whole KSh", InputType.TYPE_CLASS_NUMBER);
        EditText phone = input("M-Pesa phone (07… or 2547…)", InputType.TYPE_CLASS_PHONE);
        String existingPhone = currentUser.optString("phone", ""); if (!existingPhone.isEmpty()) phone.setText(existingPhone);
        form.addView(amount, margins(-1, dp(50), 0, 0, 0, dp(8)));
        form.addView(phone, margins(-1, dp(50), 0, 0, 0, dp(4)));
        new AlertDialog.Builder(this).setTitle("Deposit using M-Pesa STK")
            .setMessage("The backend sends the payment prompt. Check your phone and enter your M-Pesa PIN there. Funds are credited only after the server verifies the provider callback.")
            .setView(form).setNegativeButton("CANCEL", null).setPositiveButton("SEND STK PROMPT", (dialog, which) -> {
                String value = amount.getText().toString().trim(), msisdn = phone.getText().toString().trim();
                if (!value.matches("[1-9][0-9]{0,6}") || msisdn.isEmpty()) { showMessage("Enter a whole KSh amount and M-Pesa number.", true); return; }
                JSONObject body = new JSONObject();
                try { body.put("amount", Integer.parseInt(value)); body.put("phone", msisdn); } catch (Exception ignored) {}
                request("POST", "/api/mpesa/stk-push", token, body, result -> {
                    if (!result.ok()) { showMessage(result.message("The STK prompt could not be started."), true); return; }
                    showMessage("Check your phone for the M-Pesa STK prompt. Your wallet will update only after payment is confirmed.", false);
                    renderWallet();
                });
            }).show();
    }

    private void showWithdrawalForm() {
        LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL);
        EditText amount = input("Withdrawal amount in whole KSh", InputType.TYPE_CLASS_NUMBER);
        EditText phone = input("M-Pesa recipient number", InputType.TYPE_CLASS_PHONE);
        String existingPhone = currentUser.optString("phone", ""); if (!existingPhone.isEmpty()) phone.setText(existingPhone);
        form.addView(amount, margins(-1, dp(50), 0, 0, 0, dp(8)));
        form.addView(phone, margins(-1, dp(50), 0, 0, 0, dp(4)));
        new AlertDialog.Builder(this).setTitle("Request a withdrawal")
            .setMessage("The server will quote the current processing fee and payout before requesting your confirmation. The server may reserve the withdrawal amount after confirmation.")
            .setView(form).setNegativeButton("CANCEL", null).setPositiveButton("GET SERVER QUOTE", (dialog, which) -> {
                String value = amount.getText().toString().trim(), msisdn = phone.getText().toString().trim();
                if (!value.matches("[1-9][0-9]{0,6}") || msisdn.isEmpty()) { showMessage("Enter a whole KSh amount and recipient number.", true); return; }
                JSONObject body = new JSONObject();
                try { body.put("amount", Integer.parseInt(value)); body.put("phone", msisdn); } catch (Exception ignored) {}
                request("POST", "/api/wallet/withdraw/quote", token, body, quoteResult -> {
                    if (!quoteResult.ok()) { showMessage(quoteResult.message("The server could not prepare a withdrawal quote."), true); return; }
                    JSONObject quote = quoteResult.object.optJSONObject("quote");
                    if (quote == null) { showMessage("The server returned no withdrawal quote.", true); return; }
                    if (!quote.optBoolean("eligible")) { showMessage(quote.optString("reason", "This withdrawal is not available."), true); renderWallet(); return; }
                    String quoteText = "Withdrawal amount · KSh " + money(quote.optDouble("amount", 0)) +
                        "\nProcessing fee · KSh " + money(quote.optDouble("fee", 0)) +
                        "\nM-Pesa payout · KSh " + money(quote.optDouble("payout", 0)) +
                        "\n\nIf you confirm, the server will reserve KSh " + money(quote.optDouble("amount", 0)) + " and create a pending manual payout request. The payout is not instant.";
                    new AlertDialog.Builder(this).setTitle("Confirm server quote").setMessage(quoteText)
                        .setNegativeButton("CANCEL", null).setPositiveButton("CONFIRM WITHDRAWAL", (confirmDialog, confirmWhich) -> {
                            request("POST", "/api/wallet/withdraw/manual", token, body, withdrawal -> {
                                if (!withdrawal.ok()) { showMessage(withdrawal.message("Withdrawal request was not accepted."), true); renderWallet(); return; }
                                showMessage(withdrawal.object.optString("message", "Withdrawal request saved by the backend."), false);
                                renderWallet();
                            });
                        }).show();
                });
            }).show();
    }

    private void renderLeaderboard() {
        content.removeAllViews();
        addHeading("Leaderboard", "Current player rankings from GOAL$GAMBIT.");
        pageStatus = text("Loading leaderboard…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        content.addView(list, matchWrap());
        request("GET", "/api/leaderboard?limit=20", null, null, result -> {
            if (!"leaderboard".equals(currentScreen)) return;
            if (!result.ok()) { pageStatus.setText(result.message("Could not load the leaderboard.")); return; }
            list.removeAllViews();
            pageStatus.setText(result.array.length() == 0 ? "No leaderboard results are available yet." : "Top players");
            for (int i = 0; i < result.array.length(); i++) {
                JSONObject player = result.array.optJSONObject(i);
                if (player == null) continue;
                LinearLayout panel = card();
                panel.setOrientation(LinearLayout.HORIZONTAL);
                panel.setGravity(Gravity.CENTER_VERTICAL);
                TextView rank = text(String.format(Locale.ROOT, "%02d", i + 1), 17, GOLD, true);
                panel.addView(rank, margins(dp(40), -2, 0, 0, dp(8), 0));
                LinearLayout info = new LinearLayout(this);
                info.setOrientation(LinearLayout.VERTICAL);
                info.addView(text(player.optString("username", "Player"), 14, TEXT, true));
                info.addView(text("Rating " + player.optInt("rating", 0) + " · " + player.optInt("games", 0) + " games", 11, SUBTLE, false));
                panel.addView(info, new LinearLayout.LayoutParams(0, -2, 1f));
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(7)));
            }
        });
    }

    private void renderNotifications() {
        content.removeAllViews();
        addHeading("Notifications", "Account alerts, match updates and administrator announcements.");
        boolean allowed = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        String deliveryState = !allowed
            ? "Allow Android notifications below to receive heads-up match alerts."
            : socketAvailable
                ? "Live match alerts are connected. Saved alerts remain available in your account inbox."
                : "Saved alerts are available in your account inbox. Live alerts will resume when the secure connection is restored.";
        addNotice(deliveryState, MUTED_GOLD);
        pageStatus = text("Loading notifications…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        Button refresh = secondaryButton("REFRESH NOTIFICATIONS");
        content.addView(refresh, margins(-1, dp(45), 0, 0, 0, dp(10)));
        Button deviceSettings = secondaryButton("ANDROID NOTIFICATION SETTINGS");
        content.addView(deviceSettings, margins(-1, dp(43), 0, 0, 0, dp(10)));
        deviceSettings.setOnClickListener(v -> openNotificationSettings());
        notificationList = new LinearLayout(this);
        notificationList.setOrientation(LinearLayout.VERTICAL);
        content.addView(notificationList, matchWrap());
        refresh.setOnClickListener(v -> loadNotifications(notificationList));
        loadNotifications(notificationList);
    }

    private void openNotificationSettings() {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            } else {
                intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
            }
            startActivity(intent);
        } catch (RuntimeException error) {
            Toast.makeText(this, "Open Android Settings and allow notifications for GOAL$GAMBIT.", Toast.LENGTH_LONG).show();
        }
    }

    private void renderSupport() {
        content.removeAllViews();
        addHeading("Support chatbox", "Messages are sent to the authenticated GOAL$GAMBIT support thread.");
        pageStatus = text("Loading support messages…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, 0));
        LinearLayout messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        content.addView(messages, margins(-1, -2, 0, 0, 0, dp(10)));
        supportCategory = new Spinner(this);
        String[] categories = { "General inquiry", "Suggestion", "Technical problem", "Match or room code", "Account problem", "Important report" };
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, categories);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        supportCategory.setAdapter(adapter);
        supportCategory.setBackground(round(Color.rgb(36, 36, 36), dp(7), Color.rgb(74, 67, 48), dp(1)));
        content.addView(supportCategory, margins(-1, dp(50), 0, dp(7), 0, 0));
        supportSubject = input("Subject (optional)", InputType.TYPE_CLASS_TEXT);
        content.addView(supportSubject, margins(-1, dp(50), 0, dp(7), 0, 0));
        supportMessage = input("Write to GOAL$GAMBIT support…", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        supportMessage.setGravity(Gravity.TOP | Gravity.START);
        supportMessage.setMinLines(3);
        content.addView(supportMessage, margins(-1, dp(108), 0, dp(7), 0, 0));
        Button send = primaryButton("SEND TO SUPPORT");
        content.addView(send, margins(-1, dp(52), 0, 0, 0, dp(12)));
        send.setOnClickListener(v -> sendSupport(send, messages));
        request("GET", "/api/chat/support", token, null, result -> {
            if (!"support".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            if (!result.ok()) { pageStatus.setText(result.message("Could not load support chat.")); return; }
            drawSupportMessages(messages, result.object.optJSONArray("messages"));
            pageStatus.setText("Support inbox connected");
        });
    }
}
