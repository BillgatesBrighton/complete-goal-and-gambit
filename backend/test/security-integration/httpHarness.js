"use strict";

const express = require("express");
const http = require("node:http");
const authMiddleware = require("../../middleware/authMiddleware");
const authRoutes = require("../../routes/auth");
const passwordRecoveryRoutes = require("../../routes/passwordRecovery");

async function startHttpHarness(pool, options) {
    options = options || {};
    const io = options.io || { in() { return { disconnectSockets() {} }; } };
    const app = express();
    app.use(express.json());
    authMiddleware.setPool(pool);
    app.use("/api/auth", authRoutes(pool, authMiddleware, io, { emailService: options.emailService }));
    app.use("/api/auth/password-recovery", passwordRecoveryRoutes(pool, {
        io,
        emailService: options.emailService,
        frontendUrl: "http://127.0.0.1/password-recovery.html"
    }));
    app.get("/api/me", authMiddleware, (req, res) => res.json({ success: true, userId: req.user.userId }));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        base: "http://127.0.0.1:" + server.address().port,
        server,
        async close() { await new Promise((resolve) => server.close(resolve)); }
    };
}

async function request(base, path, options) {
    options = options || {};
    const response = await fetch(base + path, {
        method: options.method || "GET",
        headers: {
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(options.token ? { Authorization: "Bearer " + options.token } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    return { status: response.status, body };
}

module.exports = { startHttpHarness, request };
