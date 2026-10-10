"use strict";

const assert = require("assert");
const path = require("path");
const { detectImageType, getImageType, safeStoragePath } = require("../services/privateEvidence");

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
assert.strictEqual(detectImageType(png).mime, "image/png");
assert.strictEqual(getImageType(png, "image/png").extension, ".png");
assert.strictEqual(getImageType(png, "image/jpeg"), null, "declared MIME must match the file signature");
assert.strictEqual(detectImageType(Buffer.from("not an image")), null, "unsupported file signatures must be rejected");

const directory = path.resolve("private-evidence-test");
assert.strictEqual(safeStoragePath(directory, "01234567-89ab-cdef-0123-456789abcdef.png"), path.join(directory, "01234567-89ab-cdef-0123-456789abcdef.png"));
assert.strictEqual(safeStoragePath(directory, "../outside.png"), null, "path traversal must be rejected");
assert.strictEqual(safeStoragePath(directory, "user-upload.png"), null, "client filenames must not be accepted as storage keys");
console.log("Private evidence validation test passed.");
