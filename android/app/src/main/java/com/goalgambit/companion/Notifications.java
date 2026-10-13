package com.goalgambit.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Map;

final class Notifications {
    static final String CHANNEL_ID = "goal_gambit_matches_v2";
    static final String EXTRA_MATCH_ID = "matchId";
    static final String EXTRA_NOTIFICATION_ID = "notificationId";
    static final String EXTRA_EVENT_KEY = "eventKey";
    static final String REMOTE_CODE_KEY = "roomCode";

    private Notifications() {}

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "GOAL$GAMBIT match alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Match-ready alerts and room-code actions.");
            manager.createNotificationChannel(channel);
        }
    }

    static void showPush(Context context, Map<String, String> data) {
        String title = limit(data.get("title"), "GOAL$GAMBIT match update", 120);
        String body = limit(data.get("body"), "Open GOAL$GAMBIT to view your match update.", 240);
        String eventKey = data.get("eventKey") == null ? "" : data.get("eventKey");
        long matchId = parseLong(data.get("matchId"));
        int notificationId = notificationId(data.get("eventId"), matchId);
        boolean senderAction = eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested");
        post(context, notificationId, build(context, notificationId, matchId, eventKey, title, body, true, senderAction, 0));
    }

    static void showReplyResult(Context context, int id, long matchId, String eventKey, String message, boolean retry) {
        post(context, id, build(context, id, matchId, eventKey, "GOAL$GAMBIT · Room Code", message, retry, retry, 0));
    }

    static void showReplySending(Context context, int id, long matchId, String eventKey) {
        post(context, id, build(context, id, matchId, eventKey, "GOAL$GAMBIT · Room Code",
            "Sending room code…", true, true, 0));
    }

    static void showReplySuccess(Context context, int id, long matchId, String eventKey) {
        post(context, id, build(context, id, matchId, eventKey, "GOAL$GAMBIT · Room Code",
            "Room code sent to your opponent.", false, false, 3000));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                manager.cancel(id);
            }, 3000);
        }
    }

    private static Notification build(
        Context context,
        int id,
        long matchId,
        String eventKey,
        String title,
        String body,
        boolean allowReply,
        boolean persistent,
        long timeoutAfterMs
    ) {
        createChannel(context);
        boolean senderAction = eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested");
        boolean receiverAction = eventKey.contains("room-code-sent") || eventKey.contains("room-code-replaced");
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(!persistent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setPriority(Notification.PRIORITY_DEFAULT)
            .setContentIntent(openMatchIntent(context, id, matchId, eventKey));
        if (timeoutAfterMs > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setTimeoutAfter(timeoutAfterMs);
        }

        if (allowReply && senderAction && matchId > 0) {
            RemoteInput input = new RemoteInput.Builder(REMOTE_CODE_KEY)
                .setLabel("Paste your eFootball room code")
                .build();
            Intent intent = new Intent(context, RoomCodeReplyReceiver.class);
            intent.setAction("com.goalgambit.companion.SEND_ROOM_CODE");
            intent.putExtra(EXTRA_MATCH_ID, matchId);
            intent.putExtra(EXTRA_NOTIFICATION_ID, id);
            intent.putExtra(EXTRA_EVENT_KEY, eventKey);
            PendingIntent action = PendingIntent.getBroadcast(
                context,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
            );
            Notification.Action reply = new Notification.Action.Builder(
                android.R.drawable.ic_menu_send,
                "ENTER ROOM CODE",
                action
            ).addRemoteInput(input).setAllowGeneratedReplies(false).build();
            builder.addAction(reply);
        } else if (allowReply && receiverAction && matchId > 0) {
            Intent intent = new Intent(context, ConfirmCodeReceiver.class);
            intent.setAction("com.goalgambit.companion.CONFIRM_CODE_RECEIVED");
            intent.putExtra(EXTRA_MATCH_ID, matchId);
            intent.putExtra(EXTRA_NOTIFICATION_ID, id);
            intent.putExtra(EXTRA_EVENT_KEY, eventKey);
            PendingIntent action = PendingIntent.getBroadcast(
                context,
                id + 1,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(new Notification.Action.Builder(
                android.R.drawable.checkbox_on_background,
                "I RECEIVED THE CODE",
                action
            ).build());
        }
        return builder.build();
    }

    private static PendingIntent openMatchIntent(Context context, int id, long matchId, String eventKey) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(EXTRA_MATCH_ID, matchId);
        intent.putExtra(EXTRA_EVENT_KEY, eventKey);
        return PendingIntent.getActivity(
            context,
            id + 2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void post(Context context, int id, Notification notification) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify(id, notification);
        } catch (SecurityException ignored) {
            // Android 13+ notification permission can be denied independently of FCM registration.
        }
    }

    static int notificationId(String eventId, long matchId) {
        long value = parseLong(eventId);
        if (value <= 0) value = matchId;
        return (int) (10000 + (value % 1000000));
    }

    static long parseLong(String value) {
        try { return Long.parseLong(value); } catch (Exception ignored) { return 0; }
    }

    private static String limit(String value, String fallback, int max) {
        String clean = value == null ? "" : value.trim();
        if (clean.isEmpty()) clean = fallback;
        return clean.length() <= max ? clean : clean.substring(0, max);
    }
}
