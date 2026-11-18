"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MINIMUM_JWT_SECRET_BYTES, hasAcceptableJwtSecret } = require("../middleware/jwtSecretPolicy");

test("JWT signing secret must have at least 32 UTF-8 bytes", () => {
    assert.equal(MINIMUM_JWT_SECRET_BYTES, 32);
    assert.equal(hasAcceptableJwtSecret(undefined), false);
    assert.equal(hasAcceptableJwtSecret("short secret"), false);
    assert.equal(hasAcceptableJwtSecret("a".repeat(31)), false);
    assert.equal(hasAcceptableJwtSecret("a".repeat(32)), true);
    assert.equal(hasAcceptableJwtSecret("é".repeat(16)), true);
});
