"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const redactSensitiveRequestUrl = require("../middleware/requestUrlRedaction");

test("request logs redact bearer callback capabilities and existing payout callback tokens", () => {
    assert.equal(
        redactSensitiveRequestUrl("/api/payments/callback/AbCd_123456789012345678901234567890123456789012"),
        "/api/payments/callback/[redacted]"
    );
    assert.equal(
        redactSensitiveRequestUrl("/api/payments/payout-result/secret-token?x=1"),
        "/api/payments/payout-result/[redacted]?x=1"
    );
    assert.equal(
        redactSensitiveRequestUrl("/api/payments/c2b-confirmation/another-secret"),
        "/api/payments/c2b-confirmation/[redacted]"
    );
    assert.equal(redactSensitiveRequestUrl("/api/wallet"), "/api/wallet");
});
