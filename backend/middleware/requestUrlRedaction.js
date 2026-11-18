"use strict";

function redactSensitiveRequestUrl(value) {
    return String(value || "")
        .replace(/(\/api\/payments\/(?:payout-(?:result|timeout)|c2b-(?:confirmation|validation))\/)[^/?]+/i, "$1[redacted]")
        .replace(/(\/api\/payments\/callback\/)[^/?]+/i, "$1[redacted]");
}

module.exports = redactSensitiveRequestUrl;
