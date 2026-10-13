package com.goalgambit.companion;

import android.app.Notification;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class RoomCodeReplyReceiver extends BroadcastReceiver {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        long matchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        int notificationId = intent.getIntExtra(Notifications.EXTRA_NOTIFICATION_ID, 0);
        String eventKey = intent.getStringExtra(Notifications.EXTRA_EVENT_KEY);
        CharSequence reply = RemoteInput.getResultsFromIntent(intent) == null
            ? null
            : RemoteInput.getResultsFromIntent(intent).getCharSequence(Notifications.REMOTE_CODE_KEY);
        String code = reply == null ? "" : reply.toString().trim();
        android.content.BroadcastReceiver.PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                if (matchId <= 0 || code.isEmpty()) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Enter the official room code, then submit it again.", true);
                    return;
                }
                String bearer = TokenStore.read(app);
                if (bearer == null || bearer.isEmpty()) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Sign in to the GOAL$GAMBIT Companion app before sending a code.", false);
                    return;
                }
                Notifications.showReplySending(app, notificationId, matchId, eventKey);
                Api.Result result = null;
                Exception lastError = null;
                for (int attempt = 0; attempt < 3; attempt++) {
                    try {
                        result = Api.sendRoomCode(matchId, code, bearer);
                        if (result.ok() || result.status < 500) break;
                    } catch (Exception error) {
                        lastError = error;
                    }
                    if (attempt < 2) {
                        try { Thread.sleep(500L * (attempt + 1)); } catch (InterruptedException ignored) {}
                    }
                }
                if (result != null && result.ok()) {
                    Notifications.showReplySuccess(app, notificationId, matchId, eventKey);
                } else {
                    String message = result != null
                        ? result.message("The code could not be sent.")
                        : "Network unavailable. Check your connection and reply with the code again.";
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey, message, true);
                }
            } finally {
                pending.finish();
            }
        });
    }
}
