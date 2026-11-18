package com.goalgambit.trial;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/** Runs logout independently of an Activity's request executor and callback. */
final class AuthLogoutCoordinator {
    private static final Executor EXECUTOR = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "gg-auth-logout");
        thread.setDaemon(true);
        return thread;
    });
    private static final Set<String> RUNNING = ConcurrentHashMap.newKeySet();

    interface RevocationRequest {
        boolean revoke() throws Exception;
    }

    private AuthLogoutCoordinator() {}

    static void run(RevocationRequest request, Runnable clearLocalSession, Consumer<Boolean> callback) {
        run(null, request, clearLocalSession, callback);
    }

    static boolean run(String operationId, RevocationRequest request, Runnable clearLocalSession, Consumer<Boolean> callback) {
        if (operationId != null && !RUNNING.add(operationId)) return false;
        EXECUTOR.execute(() -> {
            try {
                runWith(request, clearLocalSession, callback);
            } finally {
                if (operationId != null) RUNNING.remove(operationId);
            }
        });
        return true;
    }

    static boolean isRunning(String operationId) { return RUNNING.contains(operationId); }

    static void runWith(RevocationRequest request, Runnable clearLocalSession, Consumer<Boolean> callback) {
        boolean revoked = false;
        try {
            revoked = request != null && request.revoke();
        } catch (Exception ignored) {
            // Local cleanup still runs; callers report that server revocation
            // could not be confirmed.
        } finally {
            if (clearLocalSession != null) clearLocalSession.run();
        }
        if (callback != null) callback.accept(revoked);
    }
}
