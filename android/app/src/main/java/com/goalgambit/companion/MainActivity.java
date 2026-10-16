package com.goalgambit.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 401;
    private static final ExecutorService API_EXECUTOR = Executors.newSingleThreadExecutor();
    private LinearLayout content;
    private TextView statusView;
    private long selectedMatchId;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Notifications.createChannel(this);
        selectedMatchId = getIntent().getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        buildScreen();
        renderAccountState();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        selectedMatchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        if (selectedMatchId > 0) loadMatch(selectedMatchId);
    }

    private void buildScreen() {
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(8, 8, 8));
        window.setNavigationBarColor(Color.rgb(8, 8, 8));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(8, 8, 8));
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        content.setPadding(pad, dp(28), pad, dp(32));
        scroll.addView(content);
        setContentView(scroll);

        TextView title = text("GOAL$GAMBIT", 27, Color.rgb(237, 195, 53), true);
        content.addView(title, params(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView subtitle = text("Android match companion", 15, Color.LTGRAY, false);
        content.addView(subtitle, marginParams(-1, -2, 0, 4, 0, 20));
        statusView = text("", 14, Color.rgb(205, 205, 205), false);
        statusView.setBackgroundColor(Color.rgb(25, 25, 25));
        statusView.setPadding(dp(12), dp(11), dp(12), dp(11));
        content.addView(statusView, marginParams(-1, -2, 0, 0, 0, 16));
    }

    private void renderAccountState() {
        content.removeViews(3, Math.max(0, content.getChildCount() - 3));
        if (TokenStore.read(this) == null) {
            showLogin();
        } else {
            showSignedIn();
        }
    }

    private void showLogin() {
        statusView.setText("Sign in with your existing GOAL$GAMBIT account to register this Android device for match alerts.");
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
        statusView.setText("Signed in. Enable Android notifications to receive match alerts and send a room code from the notification reply without opening the website.");
        Button enable = button("ENABLE MATCH NOTIFICATIONS");
        Button test = button("SEND TEST NOTIFICATION");
        Button disable = button("DISABLE NOTIFICATIONS ON THIS DEVICE");
        Button signOut = button("SIGN OUT");
        content.addView(enable, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(test, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(disable, marginParams(-1, -2, 0, 0, 0, 10));
        content.addView(signOut, marginParams(-1, -2, 0, 0, 0, 18));
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
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
            return;
        }
        registerFirebaseToken();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            registerFirebaseToken();
        } else {
            statusView.setText("Notification permission was denied. Allow notifications for GOAL$GAMBIT Companion in Android Settings, then try again.");
        }
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
                        runOnUiThread(() -> statusView.setText(result.ok()
                            ? "This device is registered for GOAL$GAMBIT match notifications."
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
                        if (signOut) TokenStore.clear(this);
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
                    if (signOut) TokenStore.clear(this);
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
