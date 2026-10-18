package com.goalgambit.companion

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class SupportMessageWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val bearer = TokenStore.read(applicationContext)?.takeIf { it.isNotBlank() } ?: return Result.failure()
        val accountId = TokenStore.accountUserId(bearer)
        if (accountId <= 0) return Result.failure()
        val queued = SupportQueueStore.pending(applicationContext, accountId)
        for (payload in queued) {
            try {
                val result = Api.sendSupportMessage(payload, bearer)
                if (result.ok()) {
                    SupportQueueStore.remove(applicationContext, payload.optString("clientMessageId"))
                } else if (isRetryable(result.status) && runAttemptCount < MAX_RETRIES) {
                    return Result.retry()
                } else {
                    return Result.failure()
                }
            } catch (_: Exception) {
                return if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
            }
        }
        return Result.success()
    }

    companion object {
        private const val MAX_RETRIES = 4
        private fun isRetryable(status: Int): Boolean = status == 408 || status == 429 || status >= 500
    }
}
