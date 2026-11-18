package com.goalgambit.trial;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.work.BackoffPolicy;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public final class RoomCodeReplyReceiver extends BroadcastReceiver {
    static final String EXTRA_MATCH_ID = "matchId";
    static final String EXTRA_NOTIFICATION_ID = "notificationId";
    static final String EXTRA_EVENT_KEY = "eventKey";
    static final String REMOTE_CODE_KEY = "roomCode";

    @Override public void onReceive(Context context, Intent intent) {
        long matchId = intent.getLongExtra(EXTRA_MATCH_ID, 0);
        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
        String eventKey = intent.getStringExtra(EXTRA_EVENT_KEY);
        String code = RemoteInput.getResultsFromIntent(intent) == null ? "" :
            RemoteInput.getResultsFromIntent(intent).getCharSequence(REMOTE_CODE_KEY, "").toString().trim();
        if (matchId <= 0 || code.isEmpty() || code.length() > 50 || !code.matches("[A-Za-z0-9 _-]+")) {
            PlayerPushNotifications.showActionResult(context, notificationId, matchId, eventKey,
                "Enter a valid room code (up to 50 letters, numbers, spaces, hyphens or underscores).", true);
            return;
        }
        if (SessionStore.read(context) == null) {
            PlayerPushNotifications.showActionResult(context, notificationId, matchId, eventKey,
                "Sign in to GOAL$GAMBIT again before sending this room code.", false);
            return;
        }
        try {
            Data input = new Data.Builder()
                .putLong(RoomCodeSendWorker.KEY_MATCH_ID, matchId)
                .putInt(RoomCodeSendWorker.KEY_NOTIFICATION_ID, notificationId)
                .putString(RoomCodeSendWorker.KEY_EVENT_KEY, eventKey)
                .putString(RoomCodeSendWorker.KEY_PROTECTED_CODE, RoomCodeSecretStore.protect(code))
                .build();
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(RoomCodeSendWorker.class)
                .setInputData(input)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build();
            PlayerPushNotifications.showActionResult(context, notificationId, matchId, eventKey, "Sending room code…", true);
            WorkManager.getInstance(context).enqueueUniqueWork("gg-player-room-code-" + matchId + "-" + notificationId,
                ExistingWorkPolicy.REPLACE, work);
        } catch (Exception error) {
            PlayerPushNotifications.showActionResult(context, notificationId, matchId, eventKey,
                "Could not queue the room-code reply. Open your match and send it there.", true);
        }
    }
}
