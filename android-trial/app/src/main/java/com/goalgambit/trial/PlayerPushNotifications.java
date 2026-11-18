package com.goalgambit.trial;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Map;
import java.util.HashSet;
import java.util.Set;

final class PlayerPushNotifications {
    private static final String GENERAL_CHANNEL = "gg_player_alerts";
    private static final String ROOM_CHANNEL = "gg_player_room_code_v1";
    private PlayerPushNotifications() {}

    static synchronized boolean claimNotification(Context context, String key) {
        if (key == null || key.isEmpty()) return true;
        android.content.SharedPreferences prefs = context.getSharedPreferences("gg_player_notifications", Context.MODE_PRIVATE);
        Set<String> keys = new HashSet<>(prefs.getStringSet("shown", new HashSet<>()));
        if (!keys.add(key)) return false;
        while (keys.size() > 200) keys.remove(keys.iterator().next());
        prefs.edit().putStringSet("shown", keys).apply();
        return true;
    }

    static void showPush(Context context, Map<String, String> data) {
        String eventKey = data.getOrDefault("eventKey", "");
        long matchId = parseLong(data.get("matchId"));
        long eventId = parseLong(data.get("eventId"));
        int id = notificationId(eventId, matchId, eventKey);
        String dedupeKey = eventId > 0 ? "event:" + eventId : eventKey + "|" + matchId;
        if (!claimNotification(context, dedupeKey)) return;
        String title = clean(data.get("title"), "GOAL$GAMBIT update", 100);
        String body = clean(data.get("body"), "Open GOAL$GAMBIT to review your update.", 500);
        post(context, id, matchId, eventKey, eventId, title, body, true);
    }

    static void showActionResult(Context context, int id, long matchId, String eventKey, String message, boolean retry) {
        int safeId = id == 0 ? notificationId(0, matchId, eventKey) : id;
        post(context, safeId, matchId, eventKey, 0, "GOAL$GAMBIT", clean(message, "Match update", 300), retry);
    }

    private static void post(Context context, int id, long matchId, String eventKey, long eventId,
                             String title, String body, boolean allowActions) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        createChannels(manager);
        Intent open = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("open_notifications", true)
            .putExtra(RoomCodeReplyReceiver.EXTRA_MATCH_ID, matchId)
            .putExtra(RoomCodeReplyReceiver.EXTRA_EVENT_KEY, eventKey);
        PendingIntent openIntent = PendingIntent.getActivity(context, id + 1000, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        boolean sender = matchId > 0 && (eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested"));
        boolean receiver = matchId > 0 && (eventKey.contains("room-code-sent") || eventKey.contains("room-code-replaced"));
        String channel = sender ? ROOM_CHANNEL : GENERAL_CHANNEL;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, channel) : new Notification.Builder(context).setPriority(sender ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
        builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(!sender)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(openIntent);
        if (allowActions && sender) {
            Intent reply = new Intent(context, RoomCodeReplyReceiver.class)
                .setAction(context.getPackageName() + ".SEND_ROOM_CODE")
                .putExtra(RoomCodeReplyReceiver.EXTRA_MATCH_ID, matchId)
                .putExtra(RoomCodeReplyReceiver.EXTRA_NOTIFICATION_ID, id)
                .putExtra(RoomCodeReplyReceiver.EXTRA_EVENT_KEY, eventKey);
            PendingIntent action = PendingIntent.getBroadcast(context, id,
                reply, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            RemoteInput input = new RemoteInput.Builder(RoomCodeReplyReceiver.REMOTE_CODE_KEY)
                .setLabel("Type or paste room code").setAllowFreeFormInput(true).build();
            builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_send, "SEND ROOM CODE", action)
                .addRemoteInput(input).setAllowGeneratedReplies(false).build());
        } else if (allowActions && receiver) {
            Intent confirm = new Intent(context, ConfirmRoomCodeReceiver.class)
                .setAction(context.getPackageName() + ".CONFIRM_ROOM_CODE")
                .putExtra(RoomCodeReplyReceiver.EXTRA_MATCH_ID, matchId)
                .putExtra(RoomCodeReplyReceiver.EXTRA_NOTIFICATION_ID, id)
                .putExtra(RoomCodeReplyReceiver.EXTRA_EVENT_KEY, eventKey);
            PendingIntent action = PendingIntent.getBroadcast(context, id + 1,
                confirm, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(new Notification.Action.Builder(android.R.drawable.checkbox_on_background,
                "CONFIRM RECEIPT", action).build());
        }
        try { manager.notify(id, builder.build()); } catch (SecurityException ignored) { }
    }

    private static void createChannels(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel general = new NotificationChannel(GENERAL_CHANNEL, "GOAL$GAMBIT player alerts", NotificationManager.IMPORTANCE_DEFAULT);
        general.setDescription("GOAL$GAMBIT match, competition and account alerts");
        NotificationChannel room = new NotificationChannel(ROOM_CHANNEL, "GOAL$GAMBIT room-code replies", NotificationManager.IMPORTANCE_HIGH);
        room.setDescription("eFootball match alerts with room-code actions");
        room.enableVibration(true);
        manager.createNotificationChannel(general);
        manager.createNotificationChannel(room);
    }

    private static int notificationId(long eventId, long matchId, String eventKey) {
        long key = eventId > 0 ? eventId : matchId > 0 ? matchId * 31 + eventKey.hashCode() : eventKey.hashCode();
        return (int) (10_000 + Math.abs(key % 1_000_000));
    }
    private static long parseLong(String value) {
        try { return Long.parseLong(value == null ? "" : value); } catch (NumberFormatException ignored) { return 0; }
    }
    private static String clean(String value, String fallback, int max) {
        String result = value == null || value.trim().isEmpty() ? fallback : value.trim();
        return result.length() <= max ? result : result.substring(0, max);
    }
}
