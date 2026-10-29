"use strict";

function isOpaqueRecoveryFormNavigation(req) {
    const getHeader = function(name) {
        if (req && typeof req.get === "function") return req.get(name) || "";
        const headers = req && req.headers || {};
        return headers[name.toLowerCase()] || "";
    };
    const contentType = String(getHeader("content-type")).split(";", 1)[0].trim().toLowerCase();

    return Boolean(req) &&
        String(req.method || "").toUpperCase() === "POST" &&
        req.path === "/api/auth/password-recovery/request" &&
        getHeader("origin") === "null" &&
        contentType === "application/x-www-form-urlencoded" &&
        String(getHeader("sec-fetch-mode")).toLowerCase() === "navigate" &&
        String(getHeader("sec-fetch-dest")).toLowerCase() === "document";
}

module.exports = function passwordRecoveryCors(corsMiddleware) {
    return function(req, res, next) {
        // This one endpoint is a top-level HTML form navigation. It needs no
        // CORS response headers; the recovery route still validates the saved
        // account details, rate-limits requests, and requires admin review.
        if (isOpaqueRecoveryFormNavigation(req)) return next();
        return corsMiddleware(req, res, next);
    };
};

module.exports.isOpaqueRecoveryFormNavigation = isOpaqueRecoveryFormNavigation;
