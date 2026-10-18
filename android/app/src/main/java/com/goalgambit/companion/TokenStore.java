package com.goalgambit.companion;

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

final class TokenStore {
    private static final String PREFS = "gg_device";
    private static final String KEY_ALIAS = "gg_companion_access_token";
    private static final String PENDING_QUEUE_KEY_ALIAS = "gg_companion_pending_support";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_BITS = 128;

    private TokenStore() {}

    static synchronized void save(Context context, String token) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey(KEY_ALIAS));
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
            .putString("token_iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("token_value", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply();
    }

    static synchronized String read(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String ivText = prefs.getString("token_iv", null);
            String valueText = prefs.getString("token_value", null);
            if (ivText == null || valueText == null) return null;
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(KEY_ALIAS), new GCMParameterSpec(IV_BITS, Base64.decode(ivText, Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(valueText, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    static synchronized String protect(Context context, String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey(KEY_ALIAS));
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] packed = new byte[1 + iv.length + encrypted.length];
        packed[0] = (byte) iv.length;
        System.arraycopy(iv, 0, packed, 1, iv.length);
        System.arraycopy(encrypted, 0, packed, 1 + iv.length, encrypted.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    static synchronized String unprotect(Context context, String value) throws Exception {
        return unprotectWithKey(value, getSecretKey(KEY_ALIAS));
    }

    static synchronized String protectPendingMessage(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey(PENDING_QUEUE_KEY_ALIAS));
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] packed = new byte[1 + iv.length + encrypted.length];
        packed[0] = (byte) iv.length;
        System.arraycopy(iv, 0, packed, 1, iv.length);
        System.arraycopy(encrypted, 0, packed, 1 + iv.length, encrypted.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    static synchronized String unprotectPendingMessage(String value) throws Exception {
        return unprotectWithKey(value, getSecretKey(PENDING_QUEUE_KEY_ALIAS));
    }

    private static String unprotectWithKey(String value, SecretKey key) throws Exception {
        byte[] packed = Base64.decode(value, Base64.NO_WRAP);
        if (packed.length < 2) throw new IllegalArgumentException("Encrypted value is incomplete.");
        int ivLength = packed[0] & 0xff;
        if (ivLength <= 0 || packed.length <= 1 + ivLength) throw new IllegalArgumentException("Encrypted value is incomplete.");
        byte[] iv = java.util.Arrays.copyOfRange(packed, 1, 1 + ivLength);
        byte[] encrypted = java.util.Arrays.copyOfRange(packed, 1 + ivLength, packed.length);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(IV_BITS, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    static synchronized void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("token_iv").remove("token_value").apply();
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {}
    }

    static String deviceId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = prefs.getString("device_id", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString("device_id", id).apply();
        }
        return id;
    }

    static long accountUserId(String token) {
        return accountClaims(token).optLong("userId", 0L);
    }

    static String accountUsername(String token) {
        return accountClaims(token).optString("username", "").trim();
    }

    private static org.json.JSONObject accountClaims(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length < 2) return new org.json.JSONObject();
            String payload = new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
            return new org.json.JSONObject(payload);
        } catch (Exception ignored) {
            return new org.json.JSONObject();
        }
    }

    private static SecretKey getSecretKey(String alias) throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(alias)) {
            return (SecretKey) keyStore.getKey(alias, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
         .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
         .setRandomizedEncryptionRequired(true)
         .build());
        return generator.generateKey();
    }
}
