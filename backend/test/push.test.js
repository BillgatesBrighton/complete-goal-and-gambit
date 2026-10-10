"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

process.env.JWT_SECRET = "push-tests-only-secret";
const createWebPushService = require("../services/webPush");
const { cleanSubscription } = require("../routes/push");
const createPushRoutes = require("../routes/push");

const validSubscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
    expirationTime: null,
    keys: { p256dh: "A".repeat(65), auth: "B".repeat(24) }
};

test("push destinations are restricted to internal match pages", () => {
    assert.equal(createWebPushService.safeTargetPath(25, "match-room"), "pages/match-room.html?matchId=25");
    assert.equal(createWebPushService.safeTargetPath(25, "match-results"), "pages/match-results.html?matchId=25");
    assert.equal(createWebPushService.safeTargetPath(null, "match-room"), "pages/match-hub.html");
    assert.equal(createWebPushService.safeTargetPath(25, "https://evil.example"), "pages/match-room.html?matchId=25");
});

test("click tokens are event-bound HMACs", () => {
    const actual = createWebPushService.clickToken(34);
    const expected = crypto.createHmac("sha256", process.env.JWT_SECRET).update("gg-push-click:34").digest("hex");
    assert.equal(actual, expected);
    assert.notEqual(actual, createWebPushService.clickToken(35));
});

test("subscription validation accepts secure browser subscriptions and rejects unsafe endpoints", () => {
    assert.equal(cleanSubscription(validSubscription).endpoint, validSubscription.endpoint);
    assert.equal(cleanSubscription({ ...validSubscription, endpoint: "http://push.example.test" }), null);
    assert.equal(cleanSubscription({ ...validSubscription, endpoint: "https://127.0.0.1/push" }), null);
    assert.equal(cleanSubscription({ ...validSubscription, endpoint: "https://push.localhost/push" }), null);
    assert.equal(cleanSubscription({ ...validSubscription, keys: { p256dh: "short", auth: "short" } }), null);
});

test("subscription API stores ownership from the authenticated account", async (t) => {
    const calls = [];
    const pool = {
        query: async (sql, values) => {
            calls.push({ sql, values });
            return { rows: [{ id: 1 }], rowCount: 1 };
        }
    };
    const service = { status: () => ({ configured: true, publicKey: "public-only" }) };
    const app = express();
    app.use(express.json());
    app.use("/api/push", createPushRoutes(pool, (req, _res, next) => {
        req.user = { userId: 7 };
        next();
    }, service));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "push-test" },
        body: JSON.stringify({ userId: 999, subscription: validSubscription })
    });
    assert.equal(response.status, 201);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[0], 7);
    assert.equal(calls[0].values[1], validSubscription.endpoint);
});

test("match workflow page scripts parse and chat does not prompt for permission on load", () => {
    for (const file of ["match-room.html", "match-results.html", "match-hub.html", "chat.html"]) {
        const fullPath = path.join(__dirname, "..", "..", "frontend", "pages", file);
        const html = fs.readFileSync(fullPath, "utf8");
        const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
            .map((match) => match[1])
            .filter((source) => source.trim());
        assert.ok(scripts.length, file + " contains inline workflow code");
        scripts.forEach((source, index) => new vm.Script(source, { filename: file + ":script-" + index }));
        assert.doesNotMatch(html, /Notification\.requestPermission\(\)/);
    }
});

test("push notification insertion is idempotent and never accepts an external target", async () => {
    let inserts = 0;
    let jobs = 0;
    const targetPaths = [];
    const client = {
        query: async (sql, values) => {
            if (sql.includes("INSERT INTO push_notification_events")) {
                inserts += 1;
                targetPaths.push(values[5]);
                return { rows: inserts === 1 ? [{ id: 4 }] : [] };
            }
            if (sql.includes("SELECT id FROM push_notification_events")) return { rows: [{ id: 4 }] };
            if (sql.includes("INSERT INTO push_delivery_jobs")) {
                jobs += 1;
                assert.equal(values[0], 4);
                assert.equal(values[1], 8);
                return { rows: [] };
            }
            throw new Error("Unexpected query in idempotency test.");
        }
    };
    const service = createWebPushService({}).enqueueNotification;
    const first = await service(client, 8, {
        eventKey: "efootball-match:4:room-code-needed",
        matchId: 4,
        title: "Match ready",
        body: "Open your match.",
        page: "https://evil.example"
    });
    const second = await service(client, 8, {
        eventKey: "efootball-match:4:room-code-needed",
        matchId: 4,
        title: "Changed duplicate",
        body: "Duplicate event.",
        page: "https://evil.example"
    });
    assert.deepEqual(first, { id: 4, created: true });
    assert.deepEqual(second, { id: 4, created: false });
    assert.equal(inserts, 2);
    assert.equal(jobs, 1);
    assert.deepEqual(targetPaths, ["pages/match-room.html?matchId=4", "pages/match-room.html?matchId=4"]);
});
