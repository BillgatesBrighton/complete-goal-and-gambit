package com.goalgambit.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Build

import java.util.Map

object Notifications {
    const val CHANNEL_ID = "goal_gambit_matches_v2"
    private const val ROOM_CODE_CHANNEL_ID = "goal_gambit_room_code_v1"
    const val EXTRA_MATCH_ID = "matchId"
    const val EXTRA_NOTIFICATION_ID = "notificationId"
    const val EXTRA_EVENT_KEY = "eventKey"
    const val EXTRA_ANNOUNCEMENT_ID = "announcementId"
    const val EXTRA_UPCOMING_GAMES = "upcomingGames"
    const val EXTRA_OPEN_SUPPORT = "openSupport"
    const val REMOTE_CODE_KEY = "roomCode"
    private const val UPCOMING_NOTIFICATION_ID = 2_000_041

    @JvmStatic
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val generalChannel = NotificationChannel(
                CHANNEL_ID,
                "GOAL\$GAMBIT reminders",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            generalChannel.description = "Scheduled Chess reminders and match alerts."
            manager.createNotificationChannel(generalChannel)

            // A new channel ID is required because Android does not let apps raise
            // the importance of a channel after a user has seen or changed it.
            val roomCodeChannel = NotificationChannel(
                ROOM_CODE_CHANNEL_ID,
                "GOAL\$GAMBIT room-code replies",
                NotificationManager.IMPORTANCE_HIGH
            )
            roomCodeChannel.description = "Heads-up eFootball alerts with inline room-code replies."
            roomCodeChannel.enableVibration(true)
            roomCodeChannel.vibrationPattern = longArrayOf(0, 250, 120, 250)
            manager.createNotificationChannel(roomCodeChannel)
        }
    }

    @JvmStatic
    fun showPush(context: Context, data: Map<String, String>) {
        val title = limit(data["title"], "GOAL\$GAMBIT match update", 120)
        val body = limit(data["body"], "Open GOAL\$GAMBIT to view your match update.", 240)
        val eventKey = data["eventKey"].orEmpty()
        val matchId = parseLong(data["matchId"])
        val notificationId = notificationId(data["eventId"], matchId)
        val senderAction = eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested")
        post(context, notificationId, build(context, notificationId, matchId, eventKey, title, body, true, senderAction, 0))
    }

    @JvmStatic
    fun showUpcomingReminder(context: Context) {
        createChannel(context)
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_UPCOMING_GAMES, true)
        val pendingIntent = PendingIntent.getActivity(
            context,
            UPCOMING_NOTIFICATION_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            Notification.Builder(context)
        }
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("GOAL\$GAMBIT — Upcoming games")
            .setContentText("You have upcoming games. Open GOAL\$GAMBIT and check your Match Hub.")
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
        post(context, UPCOMING_NOTIFICATION_ID, builder.build())
    }

    @JvmStatic
    fun showReplyResult(context: Context, id: Int, matchId: Long, eventKey: String?, message: String, retry: Boolean) {
        post(context, id, build(context, id, matchId, eventKey.orEmpty(), "GOAL\$GAMBIT — Room Code Not Sent", message, retry, retry, 0))
    }

    @JvmStatic
    fun showReplySending(context: Context, id: Int, matchId: Long, eventKey: String?) {
        post(context, id, build(context, id, matchId, eventKey.orEmpty(), "GOAL\$GAMBIT — Sending Room Code", "Sending room code…", true, true, 0))
    }

    @JvmStatic
    fun showReplySuccess(context: Context, id: Int, matchId: Long, eventKey: String?) {
        post(context, id, build(context, id, matchId, eventKey.orEmpty(), "GOAL\$GAMBIT — Room Code Sent", "Room code sent to your opponent.", false, false, 0))
    }

    private fun build(
        context: Context,
        id: Int,
        matchId: Long,
        eventKey: String,
        title: String,
        body: String,
        allowReply: Boolean,
        persistent: Boolean,
        timeoutAfterMs: Long
    ): Notification {
        createChannel(context)
        val senderAction = eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested")
        val receiverAction = eventKey.contains("room-code-sent") || eventKey.contains("room-code-replaced")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, channelId(eventKey))
        } else {
            Notification.Builder(context)
        }
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(!persistent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setPriority(if (senderAction) Notification.PRIORITY_HIGH else Notification.PRIORITY_DEFAULT)
            .setContentIntent(openMatchIntent(context, id, matchId, eventKey))

        if (senderAction && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_ALL)
        }

        if (timeoutAfterMs > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setTimeoutAfter(timeoutAfterMs)
        }

        if (allowReply && senderAction && matchId > 0) {
            val input = RemoteInput.Builder(REMOTE_CODE_KEY)
                .setLabel("Type or paste room code")
                .setAllowFreeFormInput(true)
                .build()
            val intent = Intent(context, RoomCodeReplyReceiver::class.java)
                .setAction("com.goalgambit.companion.SEND_ROOM_CODE")
                .putExtra(EXTRA_MATCH_ID, matchId)
                .putExtra(EXTRA_NOTIFICATION_ID, id)
                .putExtra(EXTRA_EVENT_KEY, eventKey)
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            val replyBuilder = Notification.Action.Builder(android.R.drawable.ic_menu_send, "REPLY", pendingIntent)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                replyBuilder.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
            }
            builder.addAction(replyBuilder.build())
        } else if (allowReply && receiverAction && matchId > 0) {
            val intent = Intent(context, ConfirmCodeReceiver::class.java)
                .setAction("com.goalgambit.companion.CONFIRM_CODE_RECEIVED")
                .putExtra(EXTRA_MATCH_ID, matchId)
                .putExtra(EXTRA_NOTIFICATION_ID, id)
                .putExtra(EXTRA_EVENT_KEY, eventKey)
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                id + 1,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(
                Notification.Action.Builder(android.R.drawable.checkbox_on_background, "I RECEIVED THE CODE", pendingIntent).build()
            )
        }
        return builder.build()
    }

    private fun openMatchIntent(context: Context, id: Int, matchId: Long, eventKey: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_MATCH_ID, matchId)
            .putExtra(EXTRA_EVENT_KEY, eventKey)
        val announcementId = announcementIdFromEventKey(eventKey)
        if (announcementId > 0) intent.putExtra(EXTRA_ANNOUNCEMENT_ID, announcementId)
        if (eventKey.startsWith("support-reply:") || eventKey.startsWith("support-message:")) {
            intent.putExtra(EXTRA_OPEN_SUPPORT, true)
        }
        return PendingIntent.getActivity(
            context,
            id + 2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun announcementIdFromEventKey(eventKey: String): Long {
        val prefix = "admin-announcement:"
        if (!eventKey.startsWith(prefix)) return 0L
        return eventKey.removePrefix(prefix).substringBefore(':').toLongOrNull() ?: 0L
    }

    private fun channelId(eventKey: String): String =
        if (eventKey.contains("room-code-needed") || eventKey.contains("code-correction-requested")) {
            ROOM_CODE_CHANNEL_ID
        } else {
            CHANNEL_ID
        }

    private fun post(context: Context, id: Int, notification: Notification) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(id, notification)
        } catch (_: SecurityException) {
            // Android 13+ notification permission can be denied independently of FCM registration.
        }
    }

    @JvmStatic
    fun notificationId(eventId: String?, matchId: Long): Int {
        var value = parseLong(eventId)
        if (value <= 0) value = matchId
        return (10_000 + (value % 1_000_000)).toInt()
    }

    @JvmStatic
    fun parseLong(value: String?): Long = value?.toLongOrNull() ?: 0L

    private fun limit(value: String?, fallback: String, max: Int): String {
        val clean = value?.trim().takeUnless { it.isNullOrEmpty() } ?: fallback
        return if (clean.length <= max) clean else clean.substring(0, max)
    }
}
