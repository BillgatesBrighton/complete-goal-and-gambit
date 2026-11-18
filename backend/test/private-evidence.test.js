"use strict";

const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { detectImageType, getImageType, safeStoragePath } = require("../services/privateEvidence");
const { encryptMessage, decryptMessage } = require("../services/chatEncryption");
const { encryptPrivateBuffer, decryptPrivateBuffer, isPrivateDataEncrypted } = require("../services/privateDataEncryption");

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
assert.strictEqual(detectImageType(png).mime, "image/png");
assert.strictEqual(getImageType(png, "image/png").extension, ".png");
assert.strictEqual(getImageType(png, "image/jpeg"), null, "declared MIME must match the file signature");
assert.strictEqual(detectImageType(Buffer.from("not an image")), null, "unsupported file signatures must be rejected");

const directory = path.resolve("private-evidence-test");
assert.strictEqual(safeStoragePath(directory, "01234567-89ab-cdef-0123-456789abcdef.png"), path.join(directory, "01234567-89ab-cdef-0123-456789abcdef.png"));
assert.strictEqual(safeStoragePath(directory, "../outside.png"), null, "path traversal must be rejected");
assert.strictEqual(safeStoragePath(directory, "user-upload.png"), null, "client filenames must not be accepted as storage keys");

const oldKey = crypto.randomBytes(32).toString("base64");
const newKey = crypto.randomBytes(32).toString("base64");
const oldKeyring = { CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID: "old", CHAT_DATA_ENCRYPTION_KEYS: JSON.stringify({ old: oldKey }) };
const rotatedKeyring = { CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID: "new", CHAT_DATA_ENCRYPTION_KEYS: JSON.stringify({ old: oldKey, new: newKey }) };
const plaintext = "A confidential support message with Unicode: ñ ♟";
const encryptedMessage = encryptMessage(plaintext, oldKeyring);
assert.strictEqual(encryptedMessage.message, "[Encrypted message]", "plaintext is not stored in the compatibility column");
assert.strictEqual(decryptMessage(encryptedMessage, oldKeyring), plaintext, "encrypted messages round-trip");
assert.strictEqual(decryptMessage(encryptedMessage, rotatedKeyring), plaintext, "old keys remain usable during key rotation");
const encryptedAfterRotation = encryptMessage(plaintext, rotatedKeyring);
assert.strictEqual(encryptedAfterRotation.encryption_key_id, "new", "new messages use the active key");
assert.throws(() => decryptMessage(encryptedMessage, { CHAT_DATA_ENCRYPTION_KEYS: "{}" }), error => error.code === "CHAT_ENCRYPTION_KEY_UNAVAILABLE");
assert.throws(() => encryptMessage(plaintext, { CHAT_DATA_ENCRYPTION_KEYS: "{}" }), error => error.code === "CHAT_ENCRYPTION_NOT_CONFIGURED");

const privateImage = Buffer.from("private image bytes");
const encryptedImage = encryptPrivateBuffer(privateImage, oldKeyring);
assert.strictEqual(isPrivateDataEncrypted(encryptedImage), true, "private evidence is stored in an encrypted envelope");
assert.deepStrictEqual(decryptPrivateBuffer(encryptedImage, rotatedKeyring), privateImage, "private evidence decrypts during key rotation");
const corruptImage = Buffer.from(encryptedImage);
corruptImage[corruptImage.length - 1] ^= 1;
assert.throws(() => decryptPrivateBuffer(corruptImage, oldKeyring), /integrity check failed/);
console.log("Private evidence validation and encryption tests passed.");
