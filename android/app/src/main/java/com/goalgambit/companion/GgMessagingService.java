package com.goalgambit.companion;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import android.content.Intent;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class GgMessagingService extends FirebaseMessagingService {
    private static final ExecutorService REGISTRATION_EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        REGISTRATION_EXECUTOR.execute(() -> {
            String bearer = TokenStore.read(this);
            if (bearer == null || bearer.isEmpty()) return;
            try {
                Api.registerDevice(token, TokenStore.deviceId(this), bearer);
            } catch (Exception ignored) {
                // The next app launch or token refresh retries device registration.
            }
        });
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        if (TokenStore.read(this) == null) return;
        Map<String, String> data = message.getData();
        if (data == null || data.isEmpty()) return;
        String eventKey = data.get("eventKey");
        long chessMatchId = Notifications.chessMatchIdFromEventKey(eventKey);
        boolean chessEventInForeground = eventKey != null &&
            (eventKey.startsWith("chess-match:") || eventKey.startsWith("chess-schedule-")) &&
            MainActivity.isActivityResumed();
        boolean activeTurnInForeground = eventKey != null && eventKey.contains(":turn:") &&
            MainActivity.isForegroundForChessMatch(chessMatchId);
        if (!activeTurnInForeground && !chessEventInForeground) Notifications.showPush(this, data);
        Intent received = new Intent(MainActivity.ACTION_PUSH_RECEIVED).setPackage(getPackageName());
        if (eventKey != null) received.putExtra(Notifications.EXTRA_EVENT_KEY, eventKey);
        if (chessMatchId > 0) {
            received.putExtra(Notifications.EXTRA_CHESS_MATCH_ID, chessMatchId);
            received.putExtra(Notifications.EXTRA_EVENT_KEY, eventKey);
        }
        sendBroadcast(received);
    }
}
