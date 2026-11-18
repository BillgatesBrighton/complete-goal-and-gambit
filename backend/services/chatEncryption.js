"use strict";

const crypto = require("crypto");

const LEGACY_PLACEHOLDER = "[Encrypted message]";
const AAD_PREFIX = "goal-gambit:chat-message:v1:";

function readKeyring(env) {
    env = env || process.env;
    let raw;
    try { raw = JSON.parse(String(env.CHAT_DATA_ENCRYPTION_KEYS || "{}")); }
    catch (_) { throw new Error("Chat encryption key configuration is invalid."); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Chat encryption key configuration is invalid.");
    }
    const keys = new Map();
    for (const [keyId, encoded] of Object.entries(raw)) {
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || typeof encoded !== "string") {
            throw new Error("Chat encryption key configuration is invalid.");
        }
        const key = Buffer.from(encoded, "base64");
        if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
            throw new Error("Each chat encryption key must be a base64-encoded 32-byte key.");
        }
        keys.set(keyId, key);
    }
    const activeKeyId = String(env.CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID || "");
    if (activeKeyId && !keys.has(activeKeyId)) throw new Error("The active chat encryption key is unavailable.");
    return { keys, activeKeyId };
}

function encryptMessage(message, env) {
    const text = String(message || "");
    if (!text.trim() || text.length > 2000) throw new Error("Chat message length is invalid.");
    const keyring = readKeyring(env);
    const keyId = keyring.activeKeyId;
    const key = keyring.keys.get(keyId);
    if (!key) {
        const error = new Error("Chat encryption is not configured.");
        error.code = "CHAT_ENCRYPTION_NOT_CONFIGURED";
        throw error;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(AAD_PREFIX + keyId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return {
        message: LEGACY_PLACEHOLDER,
        message_ciphertext: ciphertext,
        message_iv: iv,
        message_auth_tag: cipher.getAuthTag(),
        encryption_key_id: keyId
    };
}

function decryptMessage(row, env) {
    if (!row || row.message_ciphertext == null) return String(row && row.message || "");
    const keyId = String(row.encryption_key_id || "");
    const key = readKeyring(env).keys.get(keyId);
    if (!key) {
        const error = new Error("A required chat encryption key is unavailable.");
        error.code = "CHAT_ENCRYPTION_KEY_UNAVAILABLE";
        throw error;
    }
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.message_iv));
        decipher.setAAD(Buffer.from(AAD_PREFIX + keyId, "utf8"));
        decipher.setAuthTag(Buffer.from(row.message_auth_tag));
        return Buffer.concat([
            decipher.update(Buffer.from(row.message_ciphertext)),
            decipher.final()
        ]).toString("utf8");
    } catch (_) {
        const error = new Error("Stored chat message integrity check failed.");
        error.code = "CHAT_ENCRYPTION_INTEGRITY_FAILED";
        throw error;
    }
}

function decryptMessageRows(rows, env) {
    return (Array.isArray(rows) ? rows : []).map((row) => Object.assign({}, row, {
        message: decryptMessage(row, env)
    }));
}

module.exports = { encryptMessage, decryptMessage, decryptMessageRows, readKeyring, LEGACY_PLACEHOLDER };
