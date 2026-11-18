package com.goalgambit.trial;

import android.content.Context;

import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

public final class RoomCodeSendWorker extends Worker {
    static final String KEY_MATCH_ID = "matchId";
    static final String KEY_NOTIFICATION_ID = "notificationId";
    static final String KEY_EVENT_KEY = "eventKey";
    static final String KEY_PROTECTED_CODE = "protectedRoomCode";

    public RoomCodeSendWorker(Context context, WorkerParameters parameters) { super(context, parameters); }

    @Override public Result doWork() {
        long matchId = getInputData().getLong(KEY_MATCH_ID, 0);
        int notificationId = getInputData().getInt(KEY_NOTIFICATION_ID, 0);
        String eventKey = getInputData().getString(KEY_EVENT_KEY);
        String encrypted = getInputData().getString(KEY_PROTECTED_CODE);
        String bearer = SessionStore.read(getApplicationContext());
        if (matchId <= 0 || encrypted == null || bearer == null) return Result.failure();
        try {
            String code = RoomCodeSecretStore.unprotect(encrypted);
            JSONObject body = new JSONObject();
            body.put("code", code);
            ApiClient.Result response = ApiClient.request("POST", "/api/efootball/matches/" + matchId + "/roomcode", bearer, body);
            if (response.ok()) {
                PlayerPushNotifications.showActionResult(getApplicationContext(), notificationId, matchId, eventKey,
                    "Room code sent privately to your opponent.", false);
                return Result.success();
            }
            if (response.status == 401 || (response.status != 400 && response.status != 403 && response.status != 404 && response.status < 500 && response.status != 429)) {
                PlayerPushNotifications.showActionResult(getApplicationContext(), notificationId, matchId, eventKey,
                    response.message("Room code could not be sent."), false);
                return Result.failure();
            }
            if (runAttemptCount < 5) return Result.retry();
            PlayerPushNotifications.showActionResult(getApplicationContext(), notificationId, matchId, eventKey,
                response.message("Room code could not be sent. Open your match to retry."), true);
            return Result.failure();
        } catch (Exception error) {
            if (runAttemptCount < 5) return Result.retry();
            PlayerPushNotifications.showActionResult(getApplicationContext(), notificationId, matchId, eventKey,
                "Network unavailable. Open your match to send the room code.", true);
            return Result.failure();
        }
    }
}
