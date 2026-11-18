package com.goalgambit.trial;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SessionStore {
    private static final String PREFS = "gg_trial_session";
    private static final String KEY_ALIAS = "gg_trial_access_token";

    interface Storage {
        String getString(String key, String fallback);
        long getLong(String key, long fallback);
        boolean getBoolean(String key, boolean fallback);
        String readToken();
        String readTokenForPendingLogout();
        boolean putToken(String token, long generation);
        boolean putPending(String operationId, long generation);
        boolean clearIfPending(String operationId, long generation);
        boolean clearAll();
    }

    static final class LogoutOperation {
        final String id;
        final long generation;
        final String token;

        LogoutOperation(String id, long generation, String token) {
            this.id = id;
            this.generation = generation;
            this.token = token;
        }
    }

    private SessionStore() {}

    static synchronized boolean save(Context context, String token) {
        return save(new PreferencesStorage(prefs(context)), token);
    }

    static synchronized boolean save(Storage storage, String token) {
        if (token == null || token.isEmpty()) return false;
        return storage.putToken(token, storage.getLong("generation", 0) + 1);
    }

    static synchronized String read(Context context) {
        return read(new PreferencesStorage(prefs(context)));
    }

    static synchronized String read(Storage storage) {
        if (storage.getBoolean("logout_pending", false)) return null;
        return storage.readToken();
    }

    static synchronized LogoutOperation beginLogout(Context context) {
        return beginLogout(new PreferencesStorage(prefs(context)));
    }

    static synchronized LogoutOperation pendingLogout(Context context) {
        return pendingLogout(new PreferencesStorage(prefs(context)));
    }

    static synchronized LogoutOperation pendingLogout(Storage storage) {
        if (!storage.getBoolean("logout_pending", false)) return null;
        String id = storage.getString("logout_operation", null);
        long generation = storage.getLong("logout_generation", -1);
        String pendingToken = storage.readTokenForPendingLogout();
        return id == null || generation <= 0 || pendingToken == null ? null : new LogoutOperation(id, generation, pendingToken);
    }

    static synchronized LogoutOperation beginLogout(Storage storage) {
        if (storage.getBoolean("logout_pending", false)) return null;
        String token = read(storage);
        long generation = storage.getLong("generation", 0);
        if (token == null || generation <= 0) return null;
        String operationId = UUID.randomUUID().toString();
        boolean persisted = storage.putPending(operationId, generation);
        return persisted ? new LogoutOperation(operationId, generation, token) : null;
    }

    static synchronized boolean completeLogout(Context context, LogoutOperation operation) {
        boolean cleared = completeLogout(new PreferencesStorage(prefs(context)), operation);
        if (cleared) deleteKey();
        return cleared;
    }

    static synchronized boolean completeLogout(Storage storage, LogoutOperation operation) {
        if (operation == null || !storage.getBoolean("logout_pending", false) ||
            operation.generation != storage.getLong("logout_generation", -1) ||
            !operation.id.equals(storage.getString("logout_operation", null))) return false;
        // The storage performs a single conditional preference transaction.
        // A newer generation is never cleared by this stale completion.
        return storage.clearIfPending(operation.id, operation.generation);
    }

    static synchronized boolean isLogoutPending(Context context) {
        return new PreferencesStorage(prefs(context)).getBoolean("logout_pending", false);
    }

    static synchronized long generation(Context context) {
        return new PreferencesStorage(prefs(context)).getLong("generation", 0);
    }

    static synchronized boolean clear(Context context) {
        boolean preferencesCleared = clear(new PreferencesStorage(prefs(context)));
        boolean keyRemoved = deleteKey();
        return preferencesCleared || keyRemoved;
    }

    static synchronized boolean clear(Storage storage) {
        return storage.clearAll();
    }

    private static boolean deleteKey() {
        boolean keyRemoved = false;
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
            keyRemoved = !store.containsAlias(KEY_ALIAS);
        } catch (Exception ignored) {}
        return keyRemoved;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private static final class PreferencesStorage implements Storage {
        final SharedPreferences preferences;
        PreferencesStorage(SharedPreferences preferences) { this.preferences = preferences; }
        public String getString(String key, String fallback) { return preferences.getString(key, fallback); }
        public long getLong(String key, long fallback) { return preferences.getLong(key, fallback); }
        public boolean getBoolean(String key, boolean fallback) { return preferences.getBoolean(key, fallback); }
        public String readToken() {
            if (preferences.getBoolean("logout_pending", false)) return null;
            return readTokenForPendingLogout();
        }
        public String readTokenForPendingLogout() {
            String ivText = preferences.getString("iv", null);
            String encryptedText = preferences.getString("token", null);
            if (ivText == null || encryptedText == null) return null;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(ivText, Base64.NO_WRAP)));
                return new String(cipher.doFinal(Base64.decode(encryptedText, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception error) { return null; }
        }
        public boolean putToken(String token, long generation) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key());
                byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
                return preferences.edit().putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .putString("token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putLong("generation", generation).putBoolean("logout_pending", false)
                    .remove("logout_operation").remove("logout_generation").commit();
            } catch (Exception error) { return false; }
        }
        public boolean putPending(String operationId, long generation) {
            return preferences.edit().putBoolean("logout_pending", true)
                .putString("logout_operation", operationId).putLong("logout_generation", generation).commit();
        }
        public boolean clearIfPending(String operationId, long generation) {
            if (!preferences.getBoolean("logout_pending", false) ||
                !operationId.equals(preferences.getString("logout_operation", null)) ||
                generation != preferences.getLong("logout_generation", -1)) return false;
            return preferences.edit().clear().commit();
        }
        public boolean clearAll() { return preferences.edit().clear().commit(); }
    }
}
