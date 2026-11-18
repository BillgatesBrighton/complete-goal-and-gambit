package com.goalgambit.trial;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.Test;

public final class AuthLogoutCoordinatorTest {
    private static final class MemoryStorage implements SessionStore.Storage {
        final Map<String, Object> values = new HashMap<>();
        boolean failPendingWrite;
        public String getString(String key, String fallback) { return (String) values.getOrDefault(key, fallback); }
        public long getLong(String key, long fallback) { return ((Number) values.getOrDefault(key, fallback)).longValue(); }
        public boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
        public String readToken() { return getString("token", null); }
        public String readTokenForPendingLogout() { return getString("token", null); }
        public boolean putToken(String token, long generation) {
            values.put("token", token);
            values.put("generation", generation);
            values.put("logout_pending", false);
            values.remove("logout_operation");
            values.remove("logout_generation");
            return true;
        }
        public boolean putPending(String operationId, long generation) {
            if (failPendingWrite) return false;
            values.put("logout_pending", true);
            values.put("logout_operation", operationId);
            values.put("logout_generation", generation);
            return true;
        }
        public boolean clearIfPending(String operationId, long generation) {
            if (!getBoolean("logout_pending", false) ||
                !operationId.equals(getString("logout_operation", null)) ||
                generation != getLong("logout_generation", -1)) return false;
            values.clear();
            return true;
        }
        public boolean clearAll() { values.clear(); return true; }
    }

    @Test
    public void oldLogoutCompletesBeforeNewLogin() {
        MemoryStorage storage = signedIn("player-a-token");
        SessionStore.LogoutOperation logout = SessionStore.beginLogout(storage);
        assertTrue(SessionStore.completeLogout(storage, logout));
        assertNull(SessionStore.read(storage));
        assertTrue(SessionStore.save(storage, "player-b-token"));
        assertEquals("player-b-token", SessionStore.read(storage));
    }

    @Test
    public void recreatedActivityCanLoginAndLateOldCleanupCannotEraseNewGeneration() {
        MemoryStorage storage = signedIn("player-a-token");

        // A starts logout; the durable marker is visible to a recreated Activity.
        SessionStore.LogoutOperation oldLogout = SessionStore.beginLogout(storage);
        assertNotNull(oldLogout);
        assertNull(SessionStore.read(storage));

        // The recreated Activity starts a new login. Its token write atomically
        // advances the generation and supersedes the old pending operation.
        assertTrue(SessionStore.save(storage, "player-b-token"));
        assertEquals("player-b-token", SessionStore.read(storage));

        // The old request completes after the new session was established.
        assertFalse(SessionStore.completeLogout(storage, oldLogout));
        assertEquals("player-b-token", SessionStore.read(storage));
    }

    @Test
    public void pendingStateSurvivesStoreRecreationButOldTokenCannotBeRead() {
        MemoryStorage firstStore = signedIn("player-a-token");
        SessionStore.LogoutOperation operation = SessionStore.beginLogout(firstStore);
        MemoryStorage recreatedProcessStore = new MemoryStorage();
        recreatedProcessStore.values.putAll(firstStore.values);

        assertTrue(recreatedProcessStore.getBoolean("logout_pending", false));
        assertNull(SessionStore.read(recreatedProcessStore));
        assertTrue(SessionStore.completeLogout(recreatedProcessStore, operation));
        assertNull(SessionStore.read(recreatedProcessStore));
    }

    @Test
    public void networkFailureStillConditionallyClearsLocalSessionAndReportsUnconfirmed() {
        MemoryStorage storage = signedIn("player-a-token");
        SessionStore.LogoutOperation logout = SessionStore.beginLogout(storage);
        AtomicBoolean confirmed = new AtomicBoolean(true);
        AuthLogoutCoordinator.runWith(() -> { throw new IOException("offline"); },
            () -> SessionStore.completeLogout(storage, logout), confirmed::set);
        assertFalse(confirmed.get());
        assertNull(SessionStore.read(storage));
        assertFalse(storage.getBoolean("logout_pending", false));
    }

    @Test
    public void failedPendingMarkerDoesNotStartLogoutAndFallbackClearsLocalCredentials() {
        MemoryStorage storage = signedIn("player-a-token");
        storage.failPendingWrite = true;
        SessionStore.LogoutOperation operation = SessionStore.beginLogout(storage);
        assertNull(operation);
        assertEquals("player-a-token", SessionStore.read(storage));

        // MainActivity's fail-closed branch calls SessionStore.clear and does
        // not enqueue a request without a durable marker.
        assertTrue(SessionStore.clear(storage));
        assertNull(SessionStore.read(storage));
    }

    @Test
    public void activityRecreationWithoutLogoutKeepsTheSameStoredSession() {
        MemoryStorage storage = signedIn("player-a-token");
        long generationBeforeRecreation = storage.getLong("generation", 0);
        assertFalse(storage.getBoolean("logout_pending", false));
        assertEquals("player-a-token", SessionStore.read(storage));
        assertEquals(generationBeforeRecreation, storage.getLong("generation", 0));
        assertEquals("player-a-token", SessionStore.read(storage));
    }

    @Test
    public void logoutOperationCompletesAfterActivityCallbackIsGone() throws Exception {
        MemoryStorage storage = signedIn("player-a-token");
        SessionStore.LogoutOperation operation = SessionStore.beginLogout(storage);
        CountDownLatch requestStarted = new CountDownLatch(1);
        CountDownLatch finishRequest = new CountDownLatch(1);
        CountDownLatch cleanupFinished = new CountDownLatch(1);
        AuthLogoutCoordinator.run(operation.id, () -> {
            requestStarted.countDown();
            finishRequest.await(1, TimeUnit.SECONDS);
            throw new IOException("offline");
        }, () -> {
            SessionStore.completeLogout(storage, operation);
            cleanupFinished.countDown();
        }, null);
        assertTrue(requestStarted.await(1, TimeUnit.SECONDS));
        // Represents Activity destruction; app-level operation still cleans up.
        finishRequest.countDown();
        assertTrue(cleanupFinished.await(1, TimeUnit.SECONDS));
        assertNull(SessionStore.read(storage));
    }

    private static MemoryStorage signedIn(String token) {
        MemoryStorage storage = new MemoryStorage();
        assertTrue(SessionStore.save(storage, token));
        return storage;
    }

    private static void assertNotNull(Object value) { assertTrue(value != null); }
}
