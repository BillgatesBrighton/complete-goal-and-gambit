package com.goalgambit.trial;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Delivers authenticated GOAL$GAMBIT background alerts to the Player App. */
public final class PlayerFirebaseMessagingService extends FirebaseMessagingService {
    private static final ExecutorService REGISTRATION = Executors.newSingleThreadExecutor();

    @Override public void onNewToken(String token) {
        super.onNewToken(token);
        PlayerPushRegistration.saveToken(this, token);
        REGISTRATION.execute(() -> PlayerPushRegistration.registerIfSignedIn(this));
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        if (SessionStore.read(this) == null) return;
        Map<String, String> data = message.getData();
        if (data == null || data.isEmpty()) return;
        PlayerPushNotifications.showPush(this, data);
    }
}
