"use strict";

const crypto = require("crypto");
const { readKeyring } = require("./chatEncryption");

const MAGIC = Buffer.from("GGPD1", "ascii");
const AAD_PREFIX = "goal-gambit:private-evidence:v1:";

function isPrivateDataEncrypted(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= MAGIC.length && buffer.subarray(0,MAGIC.length).equals(MAGIC);
}

function encryptPrivateBuffer(buffer, env) {
    if (!Buffer.isBuffer(buffer)) throw new Error("Private evidence must be a buffer.");
    const keyring = readKeyring(env), keyId = keyring.activeKeyId, key = keyring.keys.get(keyId);
    if (!key) {
        const error = new Error("Private evidence encryption is not configured.");
        error.code = "CHAT_ENCRYPTION_NOT_CONFIGURED";
        throw error;
    }
    const id = Buffer.from(keyId,"utf8");
    if (id.length < 1 || id.length > 80) throw new Error("Private evidence encryption key ID is invalid.");
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm",key,iv);
    cipher.setAAD(Buffer.from(AAD_PREFIX+keyId,"utf8"));
    const encrypted=Buffer.concat([cipher.update(buffer),cipher.final()]);
    return Buffer.concat([MAGIC,Buffer.from([id.length]),id,iv,cipher.getAuthTag(),encrypted]);
}

function decryptPrivateBuffer(buffer, env) {
    if (!isPrivateDataEncrypted(buffer)) return buffer;
    const idLength=buffer[MAGIC.length],idStart=MAGIC.length+1,idEnd=idStart+idLength;
    if(!idLength||idEnd+28>buffer.length)throw new Error("Private evidence envelope is invalid.");
    const keyId=buffer.toString("utf8",idStart,idEnd),key=readKeyring(env).keys.get(keyId);
    if(!key){const error=new Error("A required private evidence encryption key is unavailable.");error.code="CHAT_ENCRYPTION_KEY_UNAVAILABLE";throw error;}
    try{
        const iv=buffer.subarray(idEnd,idEnd+12),tag=buffer.subarray(idEnd+12,idEnd+28),ciphertext=buffer.subarray(idEnd+28);
        const decipher=crypto.createDecipheriv("aes-256-gcm",key,iv);decipher.setAAD(Buffer.from(AAD_PREFIX+keyId,"utf8"));decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    }catch(_){throw new Error("Private evidence integrity check failed.");}
}

module.exports={encryptPrivateBuffer,decryptPrivateBuffer,isPrivateDataEncrypted};
