package com.goalgambit.trial;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
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
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
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

    private final ExecutorService requests = Executors.newFixedThreadPool(3);
    private final Set<String> legalDestinations = new HashSet<>();
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
    private String currentPlayerColor = "w";
    private String selectedSquare;
    private JSONObject currentChessState;
    private ChessBoardView chessBoard;
    private TextView chessClockInfo;
    private TextView chessMatchStatus;
    private LinearLayout activeMatchesList;
    private LinearLayout chessHistoryList;
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
        TextView trialBadge = text("TRIAL", 11, BG, true);
        trialBadge.setGravity(Gravity.CENTER);
        trialBadge.setPadding(dp(10), dp(5), dp(10), dp(5));
        trialBadge.setBackground(round(GOLD, dp(12), 0, 0));
        header.addView(trialBadge, wrap());
        root.addView(header, matchWrap());

        TextView subtitle = text("NATIVE PLAYER APP · DEVELOPMENT TRIAL", 10, SUBTLE, true);
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
        if (chessSocket != null) chessSocket.close();
        chessSocket = new ChessRealtimeClient(this);
        chessSocket.connect(token);
        navigate("home");
    }

    private void navigate(String screen) {
        currentScreen = screen;
        if (navigation != null && token != null) buildNavigation();
        if ("home".equals(screen)) renderHome();
        else if ("chess".equals(screen)) renderChess();
        else if ("efootball".equals(screen)) renderEfootball();
        else if ("leagues".equals(screen)) renderLeagues();
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
        TextView motto = text("Compete. Win. Earn.", 15, TEXT, true);
        motto.setPadding(dp(14), dp(15), dp(14), dp(15));
        motto.setBackground(round(PANEL, dp(8), 0, 0));
        content.addView(motto, margins(-1, -2, 0, dp(8), 0, dp(14)));
        if (!pendingRegistrationMessage.isEmpty()) {
            addNotice(pendingRegistrationMessage, MUTED_GOLD);
            pendingRegistrationMessage = "";
        }

        LinearLayout summary = card();
        summary.addView(text("PLAYER PROFILE", 12, GOLD, true), margins(-1, -2, 0, 0, 0, dp(5)));
        summary.addView(text("Rating  " + currentUser.optInt("rating", 1200) + "    ·    " + gameName(currentUser.optString("game", "")), 14, TEXT, false));
        content.addView(summary, margins(-1, -2, 0, 0, 0, dp(12)));

        addHomeAction("CHESS", "Open your native chess lobby and zero-stake casual board.", "chess");
        addHomeAction("eFOOTBALL", "Review your current eFootball matches.", "efootball");
        addHomeAction("LEAGUES", "Browse available leagues and read standings.", "leagues");
        addHomeAction("WALLET", "View your actual balance and transaction history.", "wallet");
        addHomeAction("MORE", "Leaderboard, notifications, profile and support.", "more");
        pageStatus = text("", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(8), 0, 0));
        refreshIdentity();
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
        addHeading("Player profile", "Details returned for your signed-in account.");
        pageStatus = text("Loading your profile…", 13, SUBTLE, false);
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
            addDetail(details, "EMAIL STATUS", currentUser.isNull("email_verified_at") ? "Verification may be required" : "Verified");
            content.addView(details, margins(-1, -2, 0, 0, 0, dp(10)));
        });
    }

    private void renderChess() {
        currentScreen = "chess";
        content.removeAllViews();
        addHeading("Chess", "Play a native zero-stake casual match. The GOAL$GAMBIT server validates every move.");
        pageStatus = text("Connecting to the chess service…", 12, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, 0, 0, dp(10)));
        Button casual = primaryButton("FIND A CASUAL OPPONENT · NO STAKE");
        content.addView(casual, margins(-1, dp(54), 0, 0, 0, dp(8)));
        casual.setOnClickListener(v -> startCasualChess(casual));
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
        if (chessSocket != null) chessSocket.refreshMatches();
    }

    private void startCasualChess(Button button) {
        new AlertDialog.Builder(this)
            .setTitle("Find a casual chess opponent?")
            .setMessage("This starts a real zero-stake casual match in GOAL$GAMBIT. No wallet funds are used.")
            .setNegativeButton("NOT NOW", (dialog, which) -> dialog.dismiss())
            .setPositiveButton("FIND OPPONENT", (dialog, which) -> {
                if (requestBusy) return;
                requestBusy = true;
                button.setEnabled(false);
                pageStatus.setText("Joining the casual chess queue…");
                JSONObject body = new JSONObject();
                try {
                    body.put("matchType", "casual");
                    body.put("speed", "rapid");
                    body.put("stake", 0);
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
                        : "You are in the casual queue. Your match will appear here when paired.");
                    if (id > 0) openChessMatch(id);
                    if (chessSocket != null) chessSocket.refreshMatches();
                });
            }).show();
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
        addHeading("League details", "Real standings and fixtures from the GOAL$GAMBIT service.");
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
                panel.addView(text(league.optString("description", "League standings"), 12, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
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
                    details.addView(item, margins(-1, -2, 0, 0, 0, dp(6)));
                }
            });
            pageStatus.setText("League data loaded. Joining and payments are disabled in this trial.");
        });
    }

    private void loadNotifications(LinearLayout list) {
        list.removeAllViews();
        list.addView(text("Loading account notifications…", 12, SUBTLE, false));
        final int[] completed = { 0 };
        Runnable settled = () -> {
            completed[0]++;
            if (completed[0] == 2 && list.getChildCount() == 0 && pageStatus != null) {
                pageStatus.setText("No recent notifications or announcements.");
            } else if (completed[0] == 2 && pageStatus != null) {
                pageStatus.setText("Account notifications and announcements");
            }
        };
        request("GET", "/api/push/history?limit=50", token, null, result -> {
            if (!"notifications".equals(currentScreen)) return;
            if (list.getChildCount() == 1 && "Loading account notifications…".contentEquals(((TextView) list.getChildAt(0)).getText())) list.removeAllViews();
            if (result.ok()) {
                JSONArray notifications = result.object.optJSONArray("notifications");
                if (notifications != null) for (int i = 0; i < notifications.length(); i++) {
                    JSONObject notification = notifications.optJSONObject(i);
                    if (notification == null) continue;
                    LinearLayout panel = card();
                    panel.addView(text(notification.optString("title", "GOAL$GAMBIT notification"), 14, GOLD, true));
                    panel.addView(text(notification.optString("body", ""), 13, TEXT, false), margins(-1, -2, 0, dp(4), 0, 0));
                    panel.addView(text(formatTime(notification.optString("created_at", "")) + " · " + notification.optString("deliveryStatus", "saved"), 10, SUBTLE, false), margins(-1, -2, 0, dp(4), 0, 0));
                    long id = notification.optLong("id", 0);
                    if (id > 0 && notification.isNull("read_at")) {
                        Button markRead = secondaryButton("MARK READ");
                        panel.addView(markRead, margins(-1, dp(38), 0, dp(6), 0, 0));
                        markRead.setOnClickListener(v -> request("POST", "/api/push/history/" + id + "/read", token, new JSONObject(), readResult -> {
                            if (readResult.ok()) loadNotifications(list);
                        }));
                    }
                    list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
                }
            } else if (result.status == 401) {
                expireSession();
            } else if (pageStatus != null) pageStatus.setText(result.message("Could not load notifications."));
            settled.run();
        });
        request("GET", "/api/chat/announcements", token, null, result -> {
            if (!"notifications".equals(currentScreen)) return;
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
            }
            settled.run();
        });
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
        String[][] tabs = { {"HOME", "home"}, {"CHESS", "chess"}, {"eFOOTBALL", "efootball"}, {"LEAGUES", "leagues"}, {"WALLET", "wallet"}, {"MORE", "more"} };
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
        addHeading("eFootball", "Review your real matches and room-code status.");
        addNotice("This trial section is read-only. Ranked match creation, entry fees, and payouts are not enabled here.", MUTED_GOLD);
        pageStatus = text("Loading your active matches…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        content.addView(list, matchWrap());
        request("GET", "/api/efootball/matches/active", token, null, result -> {
            if (!"efootball".equals(currentScreen)) return;
            if (result.status == 401) { expireSession(); return; }
            if (!result.ok()) { pageStatus.setText(result.message("Could not load eFootball matches.")); return; }
            JSONArray matches = result.object.optJSONArray("matches");
            list.removeAllViews();
            pageStatus.setText(matches == null || matches.length() == 0 ? "No active eFootball matches were returned for this account." : "Active matches from your account.");
            if (matches != null) for (int i = 0; i < matches.length(); i++) {
                JSONObject match = matches.optJSONObject(i);
                if (match == null) continue;
                LinearLayout panel = card();
                panel.addView(text("MATCH #" + match.optLong("id", 0) + " · " + match.optString("status", "unknown").toUpperCase(Locale.ROOT), 15, GOLD, true));
                panel.addView(text("Mode: " + match.optString("mode", "eFootball") + "\nOpponent: " + match.optString("opponentUsername", "Waiting") + "\nRoom code: " + (match.optBoolean("hasRoomCode") ? "Received" : "Not available"), 13, TEXT, false), margins(-1, -2, 0, dp(5), 0, 0));
                list.addView(panel, margins(-1, -2, 0, 0, 0, dp(8)));
            }
        });
    }

    private void renderLeagues() {
        content.removeAllViews();
        addHeading("Leagues", "Browse league tables and your eligible fixtures.");
        addNotice("League membership and entry actions are read-only in this trial.", MUTED_GOLD);
        pageStatus = text("Loading leagues…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        content.addView(list, matchWrap());
        request("GET", "/api/leagues", token, null, result -> {
            if (!"leagues".equals(currentScreen)) return;
            if (!result.ok()) { pageStatus.setText(result.message("Could not load leagues.")); return; }
            JSONArray leagues = result.object.optJSONArray("leagues");
            pageStatus.setText(leagues == null || leagues.length() == 0 ? "No leagues are available right now." : "Select a league to view standings and fixtures.");
            list.removeAllViews();
            if (leagues != null) for (int i = 0; i < leagues.length(); i++) {
                JSONObject league = leagues.optJSONObject(i);
                if (league == null) continue;
                String id = league.optString("id", league.optString("name", ""));
                Button open = secondaryButton(league.optString("name", "League").toUpperCase(Locale.ROOT));
                list.addView(open, margins(-1, dp(48), 0, 0, 0, dp(8)));
                open.setOnClickListener(v -> loadLeague(id));
            }
        });
    }

    private void renderWallet() {
        content.removeAllViews();
        addHeading("Wallet", "Your current GOAL$GAMBIT wallet information.");
        addNotice("Read-only in this trial. No deposits, withdrawals, or wallet adjustments can be started here.", MUTED_GOLD);
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
        addHeading("Notifications", "Recent notifications saved for your signed-in account.");
        addNotice("This screen loads the account notification inbox. Remote push for this separate trial package needs its own Firebase registration.", MUTED_GOLD);
        pageStatus = text("Loading notifications…", 13, SUBTLE, false);
        content.addView(pageStatus, margins(-1, -2, 0, dp(10), 0, 0));
        Button refresh = secondaryButton("REFRESH NOTIFICATIONS");
        content.addView(refresh, margins(-1, dp(45), 0, 0, 0, dp(10)));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        content.addView(list, matchWrap());
        refresh.setOnClickListener(v -> loadNotifications(list));
        loadNotifications(list);
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
