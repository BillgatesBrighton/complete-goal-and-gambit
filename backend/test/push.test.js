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
const createAndroidPushService = require("../services/androidPush");
const { cleanSubscription, cleanAndroidToken } = require("../routes/push");
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

test("Android token validation rejects empty, short, and whitespace-bearing tokens", () => {
    assert.equal(cleanAndroidToken("A".repeat(100)), "A".repeat(100));
    assert.equal(cleanAndroidToken("short"), null);
    assert.equal(cleanAndroidToken("A".repeat(40) + "\n"), null);
});

test("Android subscription API assigns device ownership from authentication", async (t) => {
    const calls = [];
    const pool = {
        query: async (sql, values) => {
            calls.push({ sql, values });
            return { rows: [{ id: 1 }], rowCount: 1 };
        }
    };
    const service = { status: () => ({ configured: true, androidConfigured: true }) };
    const app = express();
    app.use(express.json());
    app.use("/api/push", createPushRoutes(pool, (req, _res, next) => {
        req.user = { userId: 12 };
        next();
    }, service));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const token = "A".repeat(120);
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/push/android/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: 999, token, deviceId: "device-1" })
    });
    assert.equal(response.status, 201);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[0], 12);
    assert.equal(calls[0].values[1], token);
});

test("Android push queue sends a data-only room-code action and records the delivery", async () => {
    const sentMessages = [];
    const queries = [];
    const job = {
        id: 9, event_id: 5, token_id: 2, attempt_count: 0,
        event_key: "efootball-match:44:room-code-needed", match_id: 44,
        title: "GOAL$GAMBIT — Match Room Code", body: "Your opponent is waiting. Paste the room code below and tap Send.",
        target_path: "pages/match-room.html?matchId=44", token: "fake-fcm-registration-token"
    };
    const pool = {
        connect: async () => ({
            query: async (sql, values) => {
                queries.push({ sql, values });
                return sql.includes("SELECT j.id,j.event_id") ? { rows: [job] } : { rows: [], rowCount: 1 };
            },
            release: () => {}
        })
    };
    const service = createAndroidPushService(pool, {
        projectId: "test-project",
        messaging: { send: async (message) => { sentMessages.push(message); return "fcm-message-id"; } }
    });
    const inserted = await service.enqueueNotification({
        query: async (sql, values) => {
            queries.push({ sql, values });
            return { rows: [] };
        }
    }, 5, 7);
    assert.equal(inserted, true);
    await service.sendPendingJobs();
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].data.matchId, "44");
    assert.equal(sentMessages[0].data.eventKey, "efootball-match:44:room-code-needed");
    assert.equal(sentMessages[0].data.title, "GOAL$GAMBIT");
    assert.equal(sentMessages[0].data.body, "Your match room code is needed. Reply now.");
    assert.equal(sentMessages[0].android.priority, "high");
    assert.equal(Object.prototype.hasOwnProperty.call(sentMessages[0], "notification"), false);
    assert.equal(sentMessages[0].data.roomCode, undefined);
    assert.ok(queries.some((query) => query.sql.includes("INSERT INTO android_push_delivery_attempts")));
    assert.ok(queries.some((query) => query.sql.includes("UPDATE android_push_delivery_jobs SET status=$2")));
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

test("notification inbox paginates per authenticated user and syncs read state", async (t) => {
    const queries = [];
    const pool = {
        query: async (sql, values) => {
            queries.push({ sql, values });
            if (sql.includes("SELECT e.id, e.title")) return { rows: [
                { id: 9, title: "GOAL$GAMBIT", body: "New announcement available.", read_at: null, delivery_count: 1, accepted_count: 1, failed_count: 0, pending_count: 0 },
                { id: 8, title: "GOAL$GAMBIT", body: "Your match starts soon. Get ready!", read_at: null, delivery_count: 1, accepted_count: 1, failed_count: 0, pending_count: 0 }
            ] };
            if (sql.includes("COUNT(*)::int AS unread_count")) return { rows: [{ unread_count: 4 }] };
            if (sql.includes("UPDATE push_notification_events")) return { rows: [{ id: 9, read_at: "2026-10-19T08:00:00.000Z" }] };
            return { rows: [] };
        }
    };
    const service = { status: () => ({ configured: true, androidConfigured: true }) };
    const app = express();
    app.use(express.json());
    app.use("/api/push", createPushRoutes(pool, (req, _res, next) => { req.user = { userId: 12 }; next(); }, service));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const base = "http://127.0.0.1:" + server.address().port + "/api/push/history?limit=1";
    const historyResponse = await fetch(base);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    assert.equal(history.unreadCount, 4);
    assert.equal(history.notifications.length, 1);
    assert.equal(history.notifications[0].id, 9);
    assert.equal(history.hasMore, true);
    assert.equal(history.nextCursor, "9");
    assert.deepEqual(queries[0].values, [12, null, 2]);

    const readResponse = await fetch(base.replace("?limit=1", "/9/read"), { method: "POST" });
    assert.equal(readResponse.status, 200);
    assert.deepEqual(queries[2].values, [9, 12]);
});

test("match workflow, chat, and wallet page scripts parse", () => {
    for (const file of ["match-room.html", "match-results.html", "match-hub.html", "chat.html", "wallet.html", "login.html"]) {
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

test("Android sender alert offers inline code reply and persists until successful send", () => {
    const androidRoot = path.join(__dirname, "..", "..", "android", "app", "src", "main");
    const notificationSource = fs.readFileSync(path.join(androidRoot, "java", "com", "goalgambit", "companion", "Notifications.kt"), "utf8");
    const replySource = fs.readFileSync(path.join(androidRoot, "java", "com", "goalgambit", "companion", "RoomCodeReplyReceiver.kt"), "utf8");
    const workerSource = fs.readFileSync(path.join(androidRoot, "java", "com", "goalgambit", "companion", "RoomCodeSendWorker.kt"), "utf8");
    const manifest = fs.readFileSync(path.join(androidRoot, "AndroidManifest.xml"), "utf8");
    assert.match(notificationSource, /RemoteInput\.Builder\(REMOTE_CODE_KEY\)/);
    assert.match(notificationSource, /\.setLabel\("Type or paste room code"\)/);
    assert.match(notificationSource, /Builder\(android\.R\.drawable\.ic_menu_send, "SEND", pendingIntent\)/);
    assert.match(notificationSource, /\.setAutoCancel\(!persistent\)/);
    assert.match(notificationSource, /NotificationManager\.IMPORTANCE_DEFAULT/);
    assert.match(notificationSource, /ROOM_CODE_CHANNEL_ID[\s\S]*?NotificationManager\.IMPORTANCE_HIGH/);
    assert.match(notificationSource, /Notification\.PRIORITY_HIGH/);
    assert.match(replySource, /WorkManager\.getInstance\(app\)\.enqueueUniqueWork/);
    assert.match(replySource, /Notifications\.showReplySending/);
    assert.match(replySource, /TokenStore\.protect\(app, code\)/);
    assert.match(workerSource, /Api\.sendRoomCode\(matchId, code, bearer\)/);
    assert.match(workerSource, /if \(response\.ok\(\)\) \{[\s\S]*?Notifications\.showReplySuccess/);
    assert.match(workerSource, /Result\.retry\(\)/);
    assert.match(notificationSource, /Room code sent successfully\./);
    assert.match(notificationSource, /setVisibility\(Notification\.VISIBILITY_PRIVATE\)/);
    assert.match(notificationSource, /Your match room code is needed\. Reply now\./);
    assert.match(notificationSource, /New message from admin\./);
    assert.doesNotMatch(notificationSource, /BigTextStyle/);
    assert.match(replySource, /Regex\("\^\[A-Za-z0-9 _-\]\{1,50\}\$"\)\.matches\(code\)/);
    assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
    assert.doesNotMatch(manifest, /SYSTEM_ALERT_WINDOW|TYPE_APPLICATION_OVERLAY/);
});

test("Android notification payloads use short private-safe templates and preferences are classified by event", () => {
    assert.equal(createAndroidPushService.notificationBody("support-reply:7:18"), "New message from admin.");
    assert.equal(createAndroidPushService.notificationBody("admin-announcement:99"), "New announcement available.");
    assert.equal(createAndroidPushService.notificationBody("admin-announcement:99:reminder:1h"), "Check out your games — competition starts soon!");
    assert.equal(createAndroidPushService.notificationBody("efootball-match:3:room-code-sent:1"), "Your match has a room-code update.");
    const preferenceSql = createAndroidPushService.preferenceEnabledSql("e", "p");
    assert.match(preferenceSql, /room_code_requests/);
    assert.match(preferenceSql, /competition_reminders/);
    assert.match(preferenceSql, /support_replies/);
});

test("browser sender push exposes a button fallback and notification click opens the focused match form", async () => {
    const handlers = new Map();
    const shown = [];
    const client = {
        url: "https://example.test/frontend/pages/match-hub.html",
        navigate: async function (url) { this.url = url; },
        focus: async function () {}
    };
    const self = {
        registration: {
            scope: "https://example.test/frontend/",
            showNotification: async function (title, options) { shown.push({ title, options }); }
        },
        addEventListener: function (name, callback) { handlers.set(name, callback); },
        clients: {
            matchAll: async function () { return [client]; },
            openWindow: async function (url) { client.url = url; return client; }
        }
    };
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "sw.js"), "utf8");
    vm.runInNewContext(source, { self, URL, fetch: async () => ({ ok: true }) });

    let pushWork;
    handlers.get("push")({
        data: { json: () => ({
            title: "GOAL$GAMBIT — Match Room Code",
            body: "Your opponent is waiting. Paste the room code below and tap Send.",
            type: "efootball-match:44:room-code-needed",
            targetPath: "pages/match-room.html?matchId=44",
            eventId: 8,
            tag: "goal-gambit-event-8"
        }) },
        waitUntil: function (promise) { pushWork = promise; }
    });
    await pushWork;
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, "GOAL$GAMBIT — Match Room Code");
    assert.equal(shown[0].options.body, "Your opponent is waiting. Paste the room code below and tap Send.");
    assert.deepEqual(JSON.parse(JSON.stringify(shown[0].options.actions)), [{ action: "send-code", title: "ENTER CODE" }]);
    assert.equal(shown[0].options.data.type, "efootball-match:44:room-code-needed");

    let clickWork;
    handlers.get("notificationclick")({
        action: "",
        notification: { data: shown[0].options.data, close: function () {} },
        waitUntil: function (promise) { clickWork = promise; }
    });
    await clickWork;
    const destination = new URL(client.url);
    assert.equal(destination.pathname, "/frontend/pages/match-room.html");
    assert.equal(destination.searchParams.get("matchId"), "44");
    assert.equal(destination.searchParams.get("action"), "send-code");

    const apiSource = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "js", "api.js"), "utf8");
    const loginSource = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "pages", "login.html"), "utf8");
    const matchRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "pages", "match-room.html"), "utf8");
    assert.match(apiSource, /rememberMatchRoomReturn\(\);\s*location\.href = "login\.html";/);
    assert.match(apiSource, /function takePostLoginDestination\(\)[\s\S]*?match-room\\\.html\\\?matchId=/);
    assert.match(loginSource, /location\.replace\(GG\.takePostLoginDestination\(\) \|\| "dashboard\.html"\);/);
    assert.match(matchRoomSource, /var openCodeFromNotification=params\.get\("action"\)==="send-code"/);
    assert.match(matchRoomSource, /openCodeFromNotification && m\.youAreSender/);
    assert.match(matchRoomSource, /\/api\/efootball\/matches\/"\+encodeURIComponent\(matchId\)\+"\/send-code/);
});

test("browser fallback still shows sender notification when notification action buttons are unsupported", async () => {
    const handlers = new Map();
    const shown = [];
    const self = {
        registration: {
            scope: "https://example.test/frontend/",
            showNotification: async function (title, options) {
                if (options.actions && options.actions.length) throw new TypeError("Notification actions are unsupported.");
                shown.push({ title, options });
            }
        },
        addEventListener: function (name, callback) { handlers.set(name, callback); },
        clients: { matchAll: async function () { return []; }, openWindow: async function () {} }
    };
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "sw.js"), "utf8");
    vm.runInNewContext(source, { self, URL, fetch: async () => ({ ok: true }) });
    let pushWork;
    handlers.get("push")({
        data: { json: () => ({
            title: "GOAL$GAMBIT — Match Room Code",
            body: "Your opponent is waiting. Paste the room code below and tap Send.",
            type: "efootball-match:45:room-code-needed",
            targetPath: "pages/match-room.html?matchId=45"
        }) },
        waitUntil: function (promise) { pushWork = promise; }
    });
    await pushWork;
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, "GOAL$GAMBIT — Match Room Code");
    assert.equal(Object.hasOwn(shown[0].options, "actions"), false);
    assert.equal(shown[0].options.data.type, "efootball-match:45:room-code-needed");
});

test("Konami sender assignment queues the private sender alert using the assigned match sender", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "routes", "efootball.js"), "utf8");
    assert.match(source, /const senderId = randomInt\(0, 2\) === 0 \? Number\(candidate\.rows\[0\]\.creator_id\) : userId;/);
    assert.match(source, /queuePush\(client, senderId, \{ eventKey: "efootball-match:" \+ candidate\.rows\[0\]\.id \+ ":room-code-needed"/);
    assert.match(source, /title: "GOAL\$GAMBIT — Match Room Code", body: "Your opponent is waiting\. Paste the room code below and tap Send\."/);
    assert.match(source, /queuePush\(client, senderId, \{ eventKey: "efootball-match:" \+ matchId \+ ":room-code-needed"/);
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
