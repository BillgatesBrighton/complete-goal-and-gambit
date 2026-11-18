package com.goalgambit.trial;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class ConfirmRoomCodeReceiver extends BroadcastReceiver {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    @Override public void onReceive(Context context, Intent intent) {
        android.content.BroadcastReceiver.PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        long matchId = intent.getLongExtra(RoomCodeReplyReceiver.EXTRA_MATCH_ID, 0);
        int notificationId = intent.getIntExtra(RoomCodeReplyReceiver.EXTRA_NOTIFICATION_ID, 0);
        String eventKey = intent.getStringExtra(RoomCodeReplyReceiver.EXTRA_EVENT_KEY);
        IO.execute(() -> {
            try {
                String bearer = SessionStore.read(app);
                if (bearer == null || bearer.isEmpty()) {
                    PlayerPushNotifications.showActionResult(app, notificationId, matchId, eventKey,
                        "Sign in to GOAL$GAMBIT again to confirm receipt.", false);
                    return;
                }
                ApiClient.Result result = ApiClient.request("POST", "/api/efootball/matches/" + matchId + "/code-received", bearer, new JSONObject());
                PlayerPushNotifications.showActionResult(app, notificationId, matchId, eventKey,
                    result.message(result.ok() ? "Room-code receipt confirmed." : "Could not confirm room-code receipt."), false);
            } catch (Exception error) {
                PlayerPushNotifications.showActionResult(app, notificationId, matchId, eventKey,
                    "Network unavailable. Open the match to confirm room-code receipt.", false);
            } finally { pending.finish(); }
        });
    }
}
