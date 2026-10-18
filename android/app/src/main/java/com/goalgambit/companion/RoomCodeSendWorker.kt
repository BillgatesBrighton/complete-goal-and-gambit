package com.goalgambit.companion

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class RoomCodeSendWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val matchId = inputData.getLong(KEY_MATCH_ID, 0L)
        val notificationId = inputData.getInt(KEY_NOTIFICATION_ID, 0)
        val eventKey = inputData.getString(KEY_EVENT_KEY)
        val protectedCode = inputData.getString(KEY_PROTECTED_CODE)

        if (matchId <= 0 || notificationId <= 0 || protectedCode.isNullOrEmpty()) {
            Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                "The room-code reply could not be read. Reply with the code again.", true)
            return Result.failure()
        }

        val bearer = TokenStore.read(applicationContext)
        if (bearer.isNullOrEmpty()) {
            Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                "Your session expired. Sign in to GOAL\$GAMBIT Companion, then reply with the code again.", false)
            return Result.failure()
        }

        val code = try {
            TokenStore.unprotect(applicationContext, protectedCode)
        } catch (_: Exception) {
            Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                "The queued reply could not be decrypted. Reply with the room code again.", true)
            return Result.failure()
        }

        return try {
            val response = Api.sendRoomCode(matchId, code, bearer)
            if (response.ok()) {
                Notifications.showReplySuccess(applicationContext, notificationId, matchId, eventKey)
                Result.success()
            } else if (response.status == 401) {
                TokenStore.clear(applicationContext)
                Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                    "Your session expired. Sign in to GOAL\$GAMBIT Companion, then reply with the code again.", false)
                Result.failure()
            } else if (isRetryable(response.status) && runAttemptCount < MAX_RETRIES) {
                Result.retry()
            } else {
                val canRetryManually = response.status == 400 || isRetryable(response.status)
                Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                    response.message("The room code could not be sent."), canRetryManually)
                Result.failure()
            }
        } catch (_: Exception) {
            if (runAttemptCount < MAX_RETRIES) {
                Result.retry()
            } else {
                Notifications.showReplyResult(applicationContext, notificationId, matchId, eventKey,
                    "Network unavailable. Check your connection and reply with the code again.", true)
                Result.failure()
            }
        }
    }

    companion object {
        const val KEY_MATCH_ID = "matchId"
        const val KEY_NOTIFICATION_ID = "notificationId"
        const val KEY_EVENT_KEY = "eventKey"
        const val KEY_PROTECTED_CODE = "protectedRoomCode"
        private const val MAX_RETRIES = 5

        private fun isRetryable(status: Int): Boolean = status == 408 || status == 429 || status >= 500
    }
}
