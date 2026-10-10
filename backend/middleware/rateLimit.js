"use strict";

// Simple in-memory rate limiter. Fine for a single server process.
// For multiple servers later, swap this for express-rate-limit + Redis.
function rateLimit({ windowMs, max, message }) {
    const hits = new Map();

    setInterval(function () {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, 60 * 1000).unref();

    return function (req, res, next) {
        const key = req.ip + "|" + req.baseUrl + req.path;
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }

        entry.count++;

        if (entry.count > max) {
            res.set("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
            return res.status(429).json({
                success: false,
                message: message || "Too many attempts. Please try again later."
            });
        }

        next();
    };
}

module.exports = rateLimit;
