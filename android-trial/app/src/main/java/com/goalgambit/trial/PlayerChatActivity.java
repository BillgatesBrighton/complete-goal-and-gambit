package com.goalgambit.trial;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native player-to-player chat backed by the same private chat API as the website. */
public final class PlayerChatActivity extends Activity {
    static final String EXTRA_TOKEN = "player_chat_token";
    static final String EXTRA_USER_ID = "player_chat_user_id";
    private static final int BG = Color.rgb(8, 8, 8), PANEL = Color.rgb(18, 18, 18);
    private static final int GOLD = Color.rgb(244, 189, 32), TEXT = Color.WHITE, MUTED = Color.LTGRAY;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (isFinishing()) return;
            if (selectedUserId > 0) loadConversation(false); else if (!searchingPlayers) loadInbox();
            handler.postDelayed(this, 5000L);
        }
    };
    private String token;
    private long ownUserId, selectedUserId;
    private String selectedUsername = "";
    private LinearLayout body, list;
    private LinearLayout composerPanel;
    private TextView status, title;
    private EditText search, composer;
    private Button sendButton;
    private boolean requestBusy, sendBusy, searchingPlayers;
    private String lastMessageSignature = "";
    private int searchGeneration;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        token = getIntent().getStringExtra(EXTRA_TOKEN);
        ownUserId = getIntent().getLongExtra(EXTRA_USER_ID, 0);
        if (token == null || token.trim().isEmpty()) { finish(); return; }
        buildUi();
        loadInbox();
        handler.postDelayed(poll, 5000L);
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(14), dp(16), dp(10));
        root.setBackgroundColor(BG);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        Button back = button("‹  BACK", false);
        back.setOnClickListener(v -> { if (selectedUserId > 0) showInbox(); else finish(); });
        header.addView(back, new LinearLayout.LayoutParams(-2, dp(44)));
        title = label("PLAYER CHAT", 19, GOLD, true);
        title.setGravity(Gravity.CENTER);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView brand = label("GG", 16, GOLD, true);
        brand.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        header.addView(brand, new LinearLayout.LayoutParams(dp(46), -2));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));
        status = label("Loading conversations…", 12, MUTED, false);
        root.addView(status, margins(-1, dp(34), dp(4)));
        search = new EditText(this);
        search.setSingleLine(true);
        search.setHint("Find a player by username");
        search.setHintTextColor(Color.GRAY);
        search.setTextColor(TEXT);
        search.setTextSize(14);
        search.setPadding(dp(12), 0, dp(12), 0);
        search.setBackground(background(PANEL, Color.rgb(65, 57, 37)));
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        root.addView(search, margins(-1, dp(48), dp(8)));
        search.setOnEditorActionListener((v, action, event) -> { findPlayers(); return true; });
        Button find = button("FIND PLAYERS", true);
        root.addView(find, margins(-1, dp(44), dp(8)));
        find.setOnClickListener(v -> findPlayers());
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(body, new ScrollView.LayoutParams(-1, -2));
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1f));
        composerPanel = new LinearLayout(this);
        composerPanel.setOrientation(LinearLayout.VERTICAL);
        composerPanel.setVisibility(View.GONE);
        composer = new EditText(this);
        composer.setHint("Write a message (max 2000 characters)");
        composer.setHintTextColor(Color.GRAY);
        composer.setTextColor(TEXT);
        composer.setTextSize(14);
        composer.setMinLines(2);
        composer.setMaxLines(5);
        composer.setGravity(Gravity.TOP | Gravity.START);
        composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setBackground(background(PANEL, Color.rgb(65, 57, 37)));
        composer.setPadding(dp(12), dp(10), dp(12), dp(10));
        composerPanel.addView(composer, margins(-1, -2, dp(8)));
        sendButton = button("SEND MESSAGE", true);
        composerPanel.addView(sendButton, margins(-1, dp(46), dp(4)));
        sendButton.setOnClickListener(v -> sendMessage());
        root.addView(composerPanel, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root);
    }

    private void showInbox() {
        searchGeneration++;
        searchingPlayers = false;
        selectedUserId = 0;
        selectedUsername = "";
        lastMessageSignature = "";
        composerPanel.setVisibility(View.GONE);
        title.setText("PLAYER CHAT");
        search.setVisibility(View.VISIBLE);
        loadInbox();
    }

    private void openUser(long id, String username) {
        if (id <= 0 || requestBusy) return;
        searchingPlayers = false;
        searchGeneration++;
        selectedUserId = id;
        selectedUsername = username == null || username.isEmpty() ? "Player" : username;
        lastMessageSignature = "";
        title.setText(selectedUsername);
        search.setVisibility(View.GONE);
        loadConversation(true);
    }

    private void loadInbox() {
        if (requestBusy || selectedUserId > 0) return;
        requestBusy = true;
        api("GET", "/api/chat/inbox", null, result -> {
            requestBusy = false;
            if (!result.ok()) { status.setText(result.message("Chat inbox is unavailable.")); return; }
            JSONArray threads = result.object.optJSONArray("threads");
            body.removeAllViews();
            section("RECENT CONVERSATIONS");
            if (threads == null || threads.length() == 0) rowMessage("No conversations yet. Find a player above to start chatting.");
            else for (int i = 0; i < threads.length(); i++) {
                JSONObject item = threads.optJSONObject(i);
                if (item == null) continue;
                long id = item.optLong("user_id", 0);
                String name = item.optString("username", "Player");
                String preview = item.optString("last_message", "No messages yet");
                String online = item.optBoolean("online") ? " · ONLINE" : "";
                int unread = item.optInt("unread_count", 0);
                addPlayer(name + online, preview + (unread > 0 ? " · " + unread + " new" : ""), id, name);
            }
            status.setText("Private player chat · updates every 5 seconds");
        });
    }

    private void findPlayers() {
        String query = search.getText().toString().trim();
        if (query.isEmpty()) { status.setText("Type a username to find players."); return; }
        searchingPlayers = true;
        int generation = ++searchGeneration;
        api("GET", "/api/chat/users?search=" + android.net.Uri.encode(query), null, result -> {
            if (generation != searchGeneration || selectedUserId > 0) return;
            if (!result.ok()) { status.setText(result.message("Player search is unavailable.")); return; }
            JSONArray users = result.object.optJSONArray("users");
            body.removeAllViews();
            section("PLAYER SEARCH");
            if (users == null || users.length() == 0) rowMessage("No active players matched that username.");
            else for (int i = 0; i < users.length(); i++) {
                JSONObject user = users.optJSONObject(i);
                if (user == null) continue;
                String name = user.optString("username", "Player");
                addPlayer(name + (user.optBoolean("online") ? " · ONLINE" : ""),
                    user.optString("game", "GOAL$GAMBIT player"), user.optLong("id", 0), name);
            }
            status.setText("Choose a player to open a private conversation.");
        });
    }

    private void loadConversation(boolean firstOpen) {
        if (requestBusy || selectedUserId <= 0) return;
        requestBusy = true;
        long target = selectedUserId;
        api("GET", "/api/chat/direct/" + target, null, result -> {
            requestBusy = false;
            if (selectedUserId != target) return;
            if (!result.ok()) { status.setText(result.message("Could not open this conversation.")); return; }
            JSONObject other = result.object.optJSONObject("other");
            if (other != null) selectedUsername = other.optString("username", selectedUsername);
            title.setText(selectedUsername + ((other != null && other.optBoolean("online")) ? " · ONLINE" : ""));
            composerPanel.setVisibility(View.VISIBLE);
            drawConversation(result.object.optJSONArray("messages"), firstOpen);
        });
    }

    private void drawConversation(JSONArray messages, boolean firstOpen) {
        StringBuilder signature = new StringBuilder();
        if (messages != null) for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null) signature.append(m.optLong("id")).append(':').append(m.optString("read_at")).append('|');
        }
        if (!firstOpen && signature.toString().equals(lastMessageSignature)) return;
        lastMessageSignature = signature.toString();
        body.removeAllViews();
        section("PRIVATE CONVERSATION");
        composerPanel.setVisibility(View.VISIBLE);
        if (messages == null || messages.length() == 0) rowMessage("Say hello. Messages stay in this private conversation.");
        else for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message == null) continue;
            boolean mine = message.optLong("sender_id", -1) == ownUserId;
            LinearLayout bubble = new LinearLayout(this);
            bubble.setOrientation(LinearLayout.VERTICAL);
            bubble.setPadding(dp(12), dp(9), dp(12), dp(8));
            bubble.setBackground(background(mine ? Color.rgb(47, 39, 17) : PANEL,
                mine ? Color.rgb(113, 88, 28) : Color.rgb(54, 54, 54)));
            bubble.addView(label(mine ? "YOU" : message.optString("username", selectedUsername), 10, GOLD, true));
            TextView contentText = label(message.optString("message", ""), 14, TEXT, false);
            contentText.setPadding(0, dp(4), 0, dp(4));
            bubble.addView(contentText);
            body.addView(bubble, margins(-1, -2, 0, 0, mine ? dp(28) : dp(4), dp(8)));
        }
        status.setText("Messages are private to you and this player.");
    }

    private void sendMessage() {
        if (sendBusy || composer == null || selectedUserId <= 0) return;
        String value = composer.getText().toString().trim();
        if (value.isEmpty()) { status.setText("Write a message before sending."); return; }
        if (value.length() > 2000) { status.setText("Messages can be up to 2000 characters."); return; }
        sendBusy = true;
        sendButton.setEnabled(false);
        JSONObject body = new JSONObject();
        try { body.put("message", value); } catch (Exception ignored) { return; }
        long target = selectedUserId;
        api("POST", "/api/chat/direct/" + target, body, result -> {
            sendBusy = false;
            sendButton.setEnabled(true);
            if (selectedUserId != target) return;
            if (!result.ok()) { status.setText(result.message("Message was not sent. Try again.")); return; }
            composer.setText("");
            lastMessageSignature = "";
            loadConversation(false);
        });
    }

    private void addPlayer(String name, String detail, long id, String username) {
        if (id <= 0) return;
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        card.setBackground(background(PANEL, Color.rgb(67, 56, 31)));
        card.addView(label(name, 15, GOLD, true));
        TextView sub = label(detail, 12, MUTED, false);
        sub.setPadding(0, dp(4), 0, 0);
        card.addView(sub);
        card.setClickable(true);
        card.setFocusable(true);
        card.setOnClickListener(v -> openUser(id, username));
        body.addView(card, margins(-1, -2, 0, 0, 0, dp(8)));
    }

    private void section(String value) { body.addView(label(value, 11, GOLD, true), margins(-1, -2, 0, 0, 0, dp(8))); }
    private void rowMessage(String value) {
        TextView row = label(value, 13, MUTED, false);
        row.setPadding(dp(12), dp(14), dp(12), dp(14));
        row.setBackground(background(PANEL, Color.rgb(48, 48, 48)));
        body.addView(row, margins(-1, -2, 0, 0, 0, dp(8)));
    }
    private void api(String method, String path, JSONObject payload, java.util.function.Consumer<ApiClient.Result> done) {
        io.execute(() -> {
            ApiClient.Result result;
            try { result = ApiClient.request(method, path, token, payload); }
            catch (Exception error) {
                JSONObject failure = new JSONObject();
                try { failure.put("message", "Could not reach GOAL$GAMBIT. Check your connection and try again."); }
                catch (Exception ignored) { }
                result = new ApiClient.Result(0, failure, null, false);
            }
            ApiClient.Result finalResult = result;
            runOnUiThread(() -> { if (!isFinishing()) done.accept(finalResult); });
        });
    }
    private TextView label(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }
    private Button button(String value, boolean primary) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(12);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(primary ? Color.BLACK : GOLD);
        button.setBackground(background(primary ? GOLD : PANEL, primary ? GOLD : Color.rgb(70, 60, 37)));
        return button;
    }
    private GradientDrawable background(int fill, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(11));
        shape.setStroke(dp(1), stroke);
        return shape;
    }
    private LinearLayout.LayoutParams margins(int width, int height, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(width, height);
        lp.bottomMargin = bottom;
        return lp;
    }
    private LinearLayout.LayoutParams margins(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(width, height);
        lp.setMargins(left, top, right, bottom);
        return lp;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
