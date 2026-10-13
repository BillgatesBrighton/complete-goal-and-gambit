package com.goalgambit.companion;

import android.content.Context;
import android.content.Intent;
import android.content.BroadcastReceiver;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class ConfirmCodeReceiver extends BroadcastReceiver {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        long matchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0);
        int notificationId = intent.getIntExtra(Notifications.EXTRA_NOTIFICATION_ID, 0);
        String eventKey = intent.getStringExtra(Notifications.EXTRA_EVENT_KEY);
        android.content.BroadcastReceiver.PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                String bearer = TokenStore.read(app);
                if (bearer == null || bearer.isEmpty()) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Sign in to the GOAL$GAMBIT Companion app to confirm receipt.", false);
                    return;
                }
                Api.Result result = Api.confirmRoomCode(matchId, bearer);
                Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                    result.ok() ? "Receipt confirmed. Your opponent has been notified."
                        : result.message("Could not confirm room-code receipt."),
                    false);
            } catch (Exception error) {
                Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                    "Network unavailable. Open the companion app and confirm receipt when connected.", false);
            } finally {
                pending.finish();
            }
        });
    }
}
