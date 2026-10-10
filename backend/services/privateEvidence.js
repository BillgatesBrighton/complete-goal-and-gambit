"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const TYPES = Object.freeze({
    jpeg: { mime: "image/jpeg", extension: ".jpg" },
    png: { mime: "image/png", extension: ".png" },
    webp: { mime: "image/webp", extension: ".webp" }
});

function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return TYPES.png;
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return TYPES.jpeg;
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return TYPES.webp;
    return null;
}

function getImageType(buffer, declaredMime) {
    const type = detectImageType(buffer);
    if (!type || (declaredMime && String(declaredMime).toLowerCase() !== type.mime)) return null;
    return type;
}

function safeStoragePath(directory, storageKey) {
    const key = String(storageKey || "");
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(key)) return null;
    const root = path.resolve(directory);
    const target = path.resolve(root, key);
    if (path.dirname(target) !== root) return null;
    return target;
}

async function storePrivateImage(directory, buffer, type) {
    const extension = type && type.extension;
    if (!Buffer.isBuffer(buffer) || !type || !Object.values(TYPES).some((candidate) => candidate.mime === type.mime)) {
        throw new Error("Invalid image data.");
    }
    await fs.promises.mkdir(directory, { recursive: true });
    const storageKey = randomUUID() + extension;
    const target = safeStoragePath(directory, storageKey);
    await fs.promises.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
    return { storageKey, path: target, mimeType: type.mime, byteSize: buffer.length };
}

module.exports = { detectImageType, getImageType, safeStoragePath, storePrivateImage };
