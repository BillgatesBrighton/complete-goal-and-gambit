package com.goalgambit.companion;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Sends a low-frequency authenticated activity check while the account stays signed in. */
public final class CompanionHeartbeatWorker extends Worker {
    private static final String UNIQUE_WORK = "gg_companion_installation_heartbeat";

    public CompanionHeartbeatWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            CompanionHeartbeatWorker.class, 24, TimeUnit.HOURS
        ).setConstraints(constraints).build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
            UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request
        );
    }

    static void cancel(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(UNIQUE_WORK);
    }

    @NonNull
    @Override
    public Result doWork() {
        String bearer = TokenStore.read(getApplicationContext());
        if (bearer == null || bearer.trim().isEmpty()) return Result.success();
        try {
            Api.Result heartbeat = Api.heartbeatCompanion(getApplicationContext(), bearer);
            if (heartbeat.status == 404) {
                heartbeat = Api.registerCompanion(getApplicationContext(), bearer);
            }
            if (!heartbeat.ok()) return heartbeat.status >= 500 ? Result.retry() : Result.success();
            Api.updateCompanionNotificationStatus(getApplicationContext(), bearer);
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        }
    }
}
