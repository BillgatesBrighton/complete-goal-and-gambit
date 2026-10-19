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
        Notifications.showPush(this, data);
        sendBroadcast(new Intent(MainActivity.ACTION_PUSH_RECEIVED).setPackage(getPackageName()));
    }
}
