package com.goalgambit.companion

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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
        val pending = goAsync()
        val app = context.applicationContext

        EXECUTOR.execute {
            try {
                if (matchId <= 0 || code.isEmpty()) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Enter the official room code, then submit it again.", true)
                    return@execute
                }
                if (!Regex("^[A-Za-z0-9 _-]{1,50}$").matches(code)) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Use letters, numbers, spaces, hyphens or underscores (up to 50 characters).", true)
                    return@execute
                }

                val bearer = TokenStore.read(app)
                if (bearer.isNullOrEmpty()) {
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Sign in to the GOAL\$GAMBIT Companion app before sending a code.", false)
                    return@execute
                }

                Notifications.showReplySending(app, notificationId, matchId, eventKey)
                var result: Api.Result? = null
                for (attempt in 0..2) {
                    try {
                        val attemptResult = Api.sendRoomCode(matchId, code, bearer)
                        result = attemptResult
                        if (attemptResult.ok() || attemptResult.status < 500) break
                    } catch (_: Exception) {
                        // Retry network failures below, then keep the action available for another attempt.
                    }
                    if (attempt < 2) {
                        try { Thread.sleep(500L * (attempt + 1)) } catch (_: InterruptedException) {}
                    }
                }

                if (result?.status == 401) {
                    TokenStore.clear(app)
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey,
                        "Your session expired. Open GOAL\$GAMBIT Companion, sign in, then send the code again.", false)
                    return@execute
                }
                if (result?.ok() == true) {
                    Notifications.showReplySuccess(app, notificationId, matchId, eventKey)
                } else {
                    val canRetry = result == null || result.status >= 500 || result.status == 400
                    val message = result?.message("The code could not be sent.")
                        ?: "Network unavailable. Check your connection and reply with the code again."
                    Notifications.showReplyResult(app, notificationId, matchId, eventKey, message, canRetry)
                }
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        val EXECUTOR: ExecutorService = Executors.newSingleThreadExecutor()
    }
}
