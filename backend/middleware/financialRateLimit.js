"use strict";

const rateLimit = require("./rateLimit");

module.exports = function financialRateLimit(action, options) {
    const config = options || {};
    return rateLimit({
        windowMs: Number(config.windowMs) || 10 * 60 * 1000,
        max: Number(config.max) || 10,
        message: config.message || "Too many financial requests. Please wait before trying again.",
        keyGenerator(req) {
            const userId = Number(req.user && req.user.userId);
            return Number.isSafeInteger(userId) && userId > 0
                ? `financial:${action}:user:${userId}`
                : `financial:${action}:ip:${req.ip || "unknown"}`;
        },
        onLimit(req, state) {
            console.warn("Financial activity rate limit exceeded", JSON.stringify({
                action: String(action),
                userId: Number.isSafeInteger(Number(req.user && req.user.userId)) ? Number(req.user.userId) : null,
                ip: req.ip || null,
                path: String(req.baseUrl || "") + String(req.path || ""),
                attempts: state.count,
                windowMs: state.windowMs,
                occurredAt: new Date().toISOString()
            }));
        }
    });
};
