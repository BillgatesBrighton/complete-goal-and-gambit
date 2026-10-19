package com.goalgambit.companion;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SettingsActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 403;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final LinkedHashMap<String, String> LABELS = new LinkedHashMap<>();
    static {
        LABELS.put("matchReminders", "Personal match reminders");
        LABELS.put("competitionReminders", "Competition reminders");
        LABELS.put("roomCodeRequests", "Room-code requests and replies");
        LABELS.put("adminAnnouncements", "Admin announcements");
        LABELS.put("supportReplies", "Support replies");
        LABELS.put("generalUpdates", "Optional general updates");
    }

    private final Map<String, CheckBox> checks = new LinkedHashMap<>();
    private TextView status;
    private Button saveButton;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Notifications.createChannel(this);
        getWindow().setStatusBarColor(Color.rgb(8, 8, 8));
        getWindow().setNavigationBarColor(Color.rgb(8, 8, 8));
        render();
        loadPreferences();
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

        TextView title = text("SETTINGS", 23, Color.rgb(237, 195, 53), true);
        root.addView(title);
        root.addView(text("Choose which GOAL$GAMBIT alerts this account receives. Room-code replies stay tied to the active match and selected sender.", 14, Color.LTGRAY, false), margins(-1, -2, 0, 7, 0, 14));

        status = text("Checking Android notification permission…", 13, Color.LTGRAY, false);
        status.setPadding(dp(12), dp(10), dp(12), dp(10));
        status.setBackgroundColor(Color.rgb(25, 25, 25));
        root.addView(status, margins(-1, -2, 0, 0, 0, 9));

        for (Map.Entry<String, String> entry : LABELS.entrySet()) {
            CheckBox check = new CheckBox(this);
            check.setText(entry.getValue());
            check.setTextColor(Color.WHITE);
            check.setButtonTintList(android.content.res.ColorStateList.valueOf(Color.rgb(237, 195, 53)));
            checks.put(entry.getKey(), check);
            root.addView(check, margins(-1, -2, 0, 0, 0, 3));
        }

        saveButton = button("SAVE NOTIFICATION PREFERENCES");
        saveButton.setOnClickListener(view -> savePreferences());
        root.addView(saveButton, margins(-1, -2, 0, 10, 0, 9));

        Button permission = button("ENABLE NOTIFICATIONS");
        permission.setOnClickListener(view -> enableNotifications());
        root.addView(permission, margins(-1, -2, 0, 0, 0, 8));

        Button systemSettings = button("OPEN ANDROID NOTIFICATION SETTINGS");
        systemSettings.setOnClickListener(view -> openAndroidSettings());
        root.addView(systemSettings, margins(-1, -2, 0, 0, 0, 8));

        Button disable = button("DISABLE NOTIFICATIONS ON THIS DEVICE");
        disable.setOnClickListener(view -> disableThisDevice());
        root.addView(disable, margins(-1, -2, 0, 0, 0, 8));

        Button test = button("SEND TEST ALERT");
        test.setOnClickListener(view -> sendTestAlert(test));
        root.addView(test, margins(-1, -2, 0, 0, 0, 12));

        Button home = button("BACK TO COMPANION");
        home.setOnClickListener(view -> finish());
        root.addView(home, margins(-1, -2, 0, 0, 0, 0));
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionStatus();
    }

    private void updatePermissionStatus() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        boolean enabled = manager != null && manager.areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 33) {
            enabled = enabled && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }
        status.setText(enabled
            ? "Android notifications are allowed. You can change channel sounds and previews in Android Settings."
            : "Android notifications are blocked by the phone. Allow them in Android Settings to receive alerts.");
    }

    private void loadPreferences() {
        String bearer = TokenStore.read(this);
        if (bearer == null) {
            finish();
            startActivity(new Intent(this, MainActivity.class));
            return;
        }
        saveButton.setEnabled(false);
        EXECUTOR.execute(() -> {
            Api.Result result = null;
            try { result = Api.getNotificationPreferences(bearer); } catch (Exception ignored) {}
            Api.Result response = result;
            runOnUiThread(() -> {
                saveButton.setEnabled(true);
                if (response == null || !response.ok()) {
                    status.setText(response == null ? "Preferences could not be loaded. Your current server settings remain in place." : response.message("Preferences could not be loaded."));
                    return;
                }
                JSONObject saved = response.json.optJSONObject("preferences");
                if (saved == null) return;
                for (String key : LABELS.keySet()) {
                    CheckBox check = checks.get(key);
                    if (check != null) check.setChecked(saved.optBoolean(key, !"generalUpdates".equals(key)));
                }
            });
        });
    }

    private void savePreferences() {
        String bearer = TokenStore.read(this);
        if (bearer == null) return;
        JSONObject values = new JSONObject();
        try {
            for (String key : LABELS.keySet()) values.put(key, checks.get(key).isChecked());
        } catch (Exception error) {
            status.setText("Notification settings could not be prepared. Try again.");
            return;
        }
        saveButton.setEnabled(false);
        status.setText("Saving notification preferences…");
        EXECUTOR.execute(() -> {
            Api.Result result = null;
            try { result = Api.saveNotificationPreferences(values, bearer); } catch (Exception ignored) {}
            Api.Result response = result;
            runOnUiThread(() -> {
                saveButton.setEnabled(true);
                status.setText(response != null && response.ok()
                    ? "Preferences saved to your GOAL$GAMBIT account. Android permission still follows the phone's settings."
                    : response == null ? "Could not reach GOAL$GAMBIT. Preferences were not saved." : response.message("Preferences were not saved."));
            });
        });
    }

    private void enableNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            new AlertDialog.Builder(this)
                .setTitle("Allow GOAL$GAMBIT alerts?")
                .setMessage("Notifications can alert you about selected matches, competition times, support replies, and secure room-code requests while you are away from the app.")
                .setNegativeButton("Not now", null)
                .setPositiveButton("Continue", (dialog, which) -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS))
                .show();
            return;
        }
        registerPushToken();
        openAndroidSettings();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) registerPushToken();
        updatePermissionStatus();
    }

    private void registerPushToken() {
        String bearer = TokenStore.read(this);
        if (bearer == null) return;
        EXECUTOR.execute(() -> {
            Api.Result accountStatus = null;
            try { accountStatus = Api.getCompanionStatus(bearer); } catch (Exception ignored) {}
            Api.Result verifiedStatus = accountStatus;
            runOnUiThread(() -> {
                if (TokenStore.read(this) == null || !bearer.equals(TokenStore.read(this))) return;
                if (verifiedStatus == null || !verifiedStatus.ok() || !verifiedStatus.json.optBoolean("termsAccepted", false)) {
                    status.setText(verifiedStatus == null
                        ? "Could not verify Terms and Conditions. Notification registration was not started."
                        : verifiedStatus.ok() ? "Accept the current Terms and Conditions in the companion app before enabling notifications."
                        : verifiedStatus.message("Could not verify Terms and Conditions."));
                    return;
                }
                registerPushTokenAfterTerms(bearer);
            });
        });
    }

    private void registerPushTokenAfterTerms(String bearer) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(this, task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    status.setText("Firebase could not register this device. Try again when connected.");
                    return;
                }
                String token = task.getResult();
                EXECUTOR.execute(() -> {
                    try {
                        Api.Result result = Api.registerDevice(token, TokenStore.deviceId(this), bearer);
                        Api.registerCompanion(this, bearer);
                        runOnUiThread(() -> status.setText(result.ok()
                            ? "This Android device is registered for the notification types you selected."
                            : result.message("This device could not be registered.")));
                    } catch (Exception error) {
                        runOnUiThread(() -> status.setText("The server could not register this device. Try again when connected."));
                    }
                });
            });
        } catch (Exception error) {
            status.setText("Firebase notification setup is unavailable in this build.");
        }
    }

    private void openAndroidSettings() {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        }
        try { startActivity(intent); }
        catch (Exception ignored) { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
    }

    private void sendTestAlert(Button button) {
        String bearer = TokenStore.read(this);
        if (bearer == null) return;
        button.setEnabled(false);
        EXECUTOR.execute(() -> {
            Api.Result result = null;
            try { result = Api.testAndroidNotification(bearer); } catch (Exception ignored) {}
            Api.Result response = result;
            runOnUiThread(() -> {
                button.setEnabled(true);
                Toast.makeText(this, response != null && response.ok()
                    ? "Test alert queued. Check your device notification settings."
                    : response == null ? "Could not reach GOAL$GAMBIT." : response.message("Test alert was not queued."), Toast.LENGTH_LONG).show();
            });
        });
    }

    private void disableThisDevice() {
        String bearer = TokenStore.read(this);
        if (bearer == null) return;
        new AlertDialog.Builder(this)
            .setTitle("Disable this device's alerts?")
            .setMessage("This removes this Android device's push registration. Your account and other registered devices remain active.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Disable", (dialog, which) -> {
                status.setText("Disabling notifications on this device…");
                try {
                    FirebaseMessaging.getInstance().getToken().addOnCompleteListener(this, task -> {
                        if (!task.isSuccessful() || task.getResult() == null) {
                            status.setText("This device's token could not be read. Turn off GOAL$GAMBIT alerts in Android Settings instead.");
                            return;
                        }
                        String token = task.getResult();
                        EXECUTOR.execute(() -> {
                            try {
                                Api.unregisterDevice(token, bearer);
                                FirebaseMessaging.getInstance().deleteToken();
                                runOnUiThread(() -> status.setText("Notifications were disabled on this device. Other devices on your account are unchanged."));
                            } catch (Exception error) {
                                runOnUiThread(() -> status.setText("Could not confirm the device was unregistered. Try again when connected."));
                            }
                        });
                    });
                } catch (Exception error) {
                    status.setText("This device could not be unregistered right now.");
                }
            })
            .show();
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
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
