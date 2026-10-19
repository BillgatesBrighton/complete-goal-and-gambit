package com.goalgambit.companion

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.Data
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class RoomCodeReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val matchId = intent.getLongExtra(Notifications.EXTRA_MATCH_ID, 0)
        val notificationId = intent.getIntExtra(Notifications.EXTRA_NOTIFICATION_ID, 0)
        val eventKey = intent.getStringExtra(Notifications.EXTRA_EVENT_KEY)
        val code = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(Notifications.REMOTE_CODE_KEY)
            ?.toString()
            ?.trim()
            .orEmpty()
        val app = context.applicationContext

        if (matchId <= 0 || code.isEmpty()) {
            Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                "Enter the official room code, then submit it again.", true)
            return
        }
        if (!Regex("^[A-Za-z0-9 _-]{1,50}$").matches(code)) {
            Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                "Use letters, numbers, spaces, hyphens or underscores (up to 50 characters).", true)
            return
        }
        if (TokenStore.read(app).isNullOrEmpty()) {
            Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                "Sign in to the GOAL\$GAMBIT Companion app before sending a code.", false)
            return
        }

        try {
            val protectedCode = TokenStore.protect(app, code)
            val input = Data.Builder()
                .putLong(RoomCodeSendWorker.KEY_MATCH_ID, matchId)
                .putInt(RoomCodeSendWorker.KEY_NOTIFICATION_ID, notificationId)
                .putString(RoomCodeSendWorker.KEY_EVENT_KEY, eventKey)
                .putString(RoomCodeSendWorker.KEY_PROTECTED_CODE, protectedCode)
                .build()
            val work = OneTimeWorkRequestBuilder<RoomCodeSendWorker>()
                .setInputData(input)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                // This is a user-initiated action from the notification shade.
                // Ask Android to run it promptly, while keeping a normal-work
                // fallback when expedited-work quota is unavailable.
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            Notifications.showReplySending(app, notificationId, matchId, eventKey)
            WorkManager.getInstance(app).enqueueUniqueWork(
                "goal-gambit-room-code-$matchId-$notificationId",
                // A stale retry must not swallow a newly typed reply. Replacing
                // it also lets the player retry from the still-visible action.
                ExistingWorkPolicy.REPLACE,
                work
            )
        } catch (_: Exception) {
            Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                "The reply could not be queued. Check your connection and send the room code again.", true)
        }
    }
}
