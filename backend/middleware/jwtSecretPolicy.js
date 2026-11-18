"use strict";

const MINIMUM_JWT_SECRET_BYTES = 32;

function hasAcceptableJwtSecret(value) {
    return typeof value === "string" && Buffer.byteLength(value, "utf8") >= MINIMUM_JWT_SECRET_BYTES;
}

module.exports = { MINIMUM_JWT_SECRET_BYTES, hasAcceptableJwtSecret };
