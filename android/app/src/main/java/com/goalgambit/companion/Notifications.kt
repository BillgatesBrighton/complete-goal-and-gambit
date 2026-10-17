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
    const val EXTRA_MATCH_ID = "matchId"
    const val EXTRA_NOTIFICATION_ID = "notificationId"
    const val EXTRA_EVENT_KEY = "eventKey"
    const val REMOTE_CODE_KEY = "roomCode"

    @JvmStatic
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "GOAL\$GAMBIT reminders",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            channel.description = "Scheduled Chess reminders, match alerts, and room-code chat actions."
            manager.createNotificationChannel(channel)
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
            Notification.Builder(context, CHANNEL_ID)
        } else {
            Notification.Builder(context)
        }
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(!persistent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setPriority(Notification.PRIORITY_DEFAULT)
            .setContentIntent(openMatchIntent(context, id, matchId, eventKey))

        if (timeoutAfterMs > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setTimeoutAfter(timeoutAfterMs)
        }

        if (allowReply && senderAction && matchId > 0) {
            val input = RemoteInput.Builder(REMOTE_CODE_KEY)
                .setLabel("Paste room code")
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
            val reply = Notification.Action.Builder(android.R.drawable.ic_menu_send, "REPLY", pendingIntent)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(false)
                .build()
            builder.addAction(reply)
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
        return PendingIntent.getActivity(
            context,
            id + 2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
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
