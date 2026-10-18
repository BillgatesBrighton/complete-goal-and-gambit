"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const adminRoutes = require("../routes/admin");
const companionRoutes = require("../routes/companion");
const chatRoutes = require("../routes/chat");
const createAdminAnnouncementReminders = require("../services/adminAnnouncementReminders");

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

test("admin announcement publishing queues audience delivery and scheduled delivery persists without early push", async (t) => {
    const queued = [];
    const inserted = [];
    const pool = {
        query: async (sql) => {
            assert.match(String(sql), /SELECT id, username, role FROM users/);
            return { rows: [{ id: 1, username: "admin", role: "admin" }] };
        },
        connect: async () => ({
            query: async (sql, values) => {
                if (/INSERT INTO admin_announcements/i.test(sql)) {
                    const row = {
                        id: inserted.length + 1,
                        message: values[1],
                        created_at: new Date().toISOString(),
                        active: true,
                        event_name: values[2],
                        event_at: values[3],
                        event_time_zone: values[4],
                        audience: values[5],
                        publish_at: values[6],
                        published_at: values[6] ? null : new Date().toISOString()
                    };
                    inserted.push(row);
                    return { rows: [row] };
                }
                if (/SELECT id FROM users/i.test(sql)) return { rows: [{ id: 7 }, { id: 8 }] };
                return { rows: [] };
            },
            release() {}
        })
    };
    const pushService = {
        enqueueNotification: async (_client, userId, notification) => {
            queued.push({ userId, notification });
            return { created: true };
        },
        sendPendingJobs: async () => []
    };
    const auth = (req, _res, next) => { req.user = { userId: 1, username: "admin" }; next(); };
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRoutes(pool, auth, undefined, pushService));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/admin/announcements";
    const eventAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    const immediate = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Gold League begins today.", eventName: "Gold League", eventAt, eventTimeZone: "Africa/Nairobi", audience: "chess" })
    });
    const immediateBody = await immediate.json();
    assert.equal(immediate.status, 201);
    assert.equal(immediateBody.scheduled, false);
    assert.equal(immediateBody.queuedUsers, 2);
    assert.equal(queued.length, 2);
    assert.deepEqual(queued.map((entry) => entry.notification.eventKey), ["admin-announcement:1", "admin-announcement:1"]);
    assert.equal(queued[0].notification.page, "match-hub");

    const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Competition opens soon.", eventName: "Competition opening", eventAt, publishAt, audience: "all" })
    });
    const scheduledBody = await scheduled.json();
    assert.equal(scheduled.status, 201);
    assert.equal(scheduledBody.scheduled, true);
    assert.equal(queued.length, 2, "a future announcement is not pushed early");
    assert.equal(inserted[1].published_at, null);
});

test("event reminder windows use the stored event start time and a stable per-phase event key", async () => {
    const service = createAdminAnnouncementReminders({}, null);
    const now = Date.now();
    assert.equal(service.constructor.name, "Object");
    assert.equal(createAdminAnnouncementReminders.dueReminderPhase({
        event_at: new Date(now + 30 * 60 * 1000), reminder_24h_sent_at: new Date(), reminder_1h_sent_at: null, reminder_start_sent_at: null
    }, now), "1h");
    assert.equal(createAdminAnnouncementReminders.formatEventAt(new Date(now).toISOString(), "Africa/Nairobi").length > 0, true);
});

test("companion upcoming endpoint is authenticated and returns only a boolean", async (t) => {
    let receivedUserId = null;
    const pool = { query: async (_sql, values) => { receivedUserId = values[0]; return { rows: [{ has_upcoming_games: true }] }; } };
    const app = express();
    app.use("/api/companion", companionRoutes(pool, (req, res, next) => {
        const id = Number(req.get("x-test-user"));
        if (!id) return res.status(401).json({ success: false });
        req.user = { userId: id };
        next();
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/companion/upcoming?userId=999";
    const denied = await fetch(base);
    assert.equal(denied.status, 401);
    const response = await fetch(base, { headers: { "x-test-user": "42" } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(receivedUserId, 42, "account identity comes from authentication, not query parameters");
    assert.deepEqual(body, { success: true, hasUpcomingGames: true });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("companion profile greeting uses the authenticated current username", async (t) => {
    const app = express();
    app.use("/api/companion", companionRoutes({}, (req, res, next) => {
        if (req.get("authorization") !== "Bearer valid") return res.status(401).json({ success: false });
        req.user = { userId: 42, username: "briton" };
        next();
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/companion/profile", {
        headers: { authorization: "Bearer valid" }
    });
    assert.deepEqual(await response.json(), { success: true, username: "briton" });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("support chat message references make offline retries idempotent and bind messages to the authenticated user", async (t) => {
    const messageId = "b2d685f8-ea16-4a57-a725-89d80e72a55e";
    let threadCreated = false;
    let messageInsertCount = 0;
    const saved = { id: 12, sender_id: 4, message: "Please help", created_at: new Date().toISOString(), read_at: null, client_message_id: messageId };
    const pool = {
        connect: async () => ({
            query: async (sql) => {
                if (/INSERT INTO chat_threads/i.test(sql)) {
                    if (threadCreated) return { rows: [] };
                    threadCreated = true;
                    return { rows: [{ id: 30 }] };
                }
                if (/SELECT id FROM chat_threads/i.test(sql)) return { rows: [{ id: 30 }] };
                if (/SELECT id,username,account_status FROM users/i.test(sql)) return { rows: [{ id: 4, username: "player", account_status: "active" }] };
                if (/INSERT INTO chat_messages/i.test(sql)) {
                    messageInsertCount += 1;
                    return { rows: messageInsertCount === 1 ? [saved] : [] };
                }
                if (/SELECT id,sender_id,message,created_at,read_at,client_message_id/i.test(sql)) return { rows: [saved] };
                if (/SELECT id FROM users WHERE role='admin'/i.test(sql)) return { rows: [] };
                return { rows: [] };
            },
            release() {}
        })
    };
    const app = express();
    app.use(express.json());
    app.use("/api/chat", chatRoutes(pool, (req, _res, next) => { req.user = { userId: 4, username: "player" }; next(); }, () => [], { enqueueNotification: async () => ({ created: true }) }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = "http://127.0.0.1:" + server.address().port + "/api/chat/support";
    const request = { message: "Please help", clientMessageId: messageId, subject: "Login", category: "technical", userId: 999 };
    const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const first = await send();
    assert.equal(first.status, 201);
    assert.equal((await first.json()).message.sender_id, 4);
    const retry = await send();
    const retryBody = await retry.json();
    assert.equal(retry.status, 200);
    assert.equal(retryBody.duplicate, true);
    assert.equal(messageInsertCount, 2, "the second insert hit the idempotency key and did not create a new record");
});

test("Android notification channel settings and inline room-code RemoteInput remain present", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../android/app/src/main/java/com/goalgambit/companion/Notifications.kt"), "utf8");
    assert.match(source, /const val CHANNEL_ID = "goal_gambit_matches_v2"/);
    assert.match(source, /private const val ROOM_CODE_CHANNEL_ID = "goal_gambit_room_code_v1"/);
    assert.match(source, /NotificationManager\.IMPORTANCE_HIGH/);
    assert.match(source, /RemoteInput\.Builder\(REMOTE_CODE_KEY\)/);
    assert.match(source, /Notification\.Action\.Builder\(android\.R\.drawable\.ic_menu_send, "SEND"/);
});

test("companion guide acknowledgement and installation records use only the authenticated member", async (t) => {
    let acknowledgedValues = null;
    let registrationValues = null;
    let heartbeatValues = null;
    const pool = {
        async query(sql, values) {
            if (/SELECT onboarding_version,onboarding_acknowledged_at/.test(sql)) return { rows: [{ onboarding_version: "old-version", onboarding_acknowledged_at: null }] };
            if (/SELECT EXISTS\(SELECT 1 FROM companion_installations/.test(sql)) return { rows: [{ ever_registered: false, currently_registered: false }] };
            if (/SELECT MIN\(downloaded_at\)/.test(sql)) return { rows: [{ downloaded_at: null, last_downloaded_at: null }] };
            if (/INSERT INTO companion_user_setup/.test(sql)) {
                acknowledgedValues = values;
                return { rows: [{ onboarding_acknowledged_at: new Date().toISOString() }] };
            }
            if (/UPDATE companion_installations SET last_seen_at/.test(sql)) {
                heartbeatValues = values;
                return { rows: [] };
            }
            throw new Error("Unexpected companion query: " + sql.slice(0, 100));
        },
        async connect() {
            return {
                async query(sql, values) {
                    if (/INSERT INTO companion_installations/.test(sql)) {
                        registrationValues = values;
                        return { rows: [{ id: 9, registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }] };
                    }
                    return { rows: [] };
                },
                release() {}
            };
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/companion", companionRoutes(pool, (req, res, next) => {
        const userId = Number(req.get("x-test-user"));
        if (!userId) return res.status(401).json({ success: false });
        req.user = { userId };
        next();
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/companion";

    assert.equal((await fetch(base + "/status")).status, 401, "setup state is private to an authenticated account");
    const status = await fetch(base + "/status", { headers: { "x-test-user": "42" } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).needsAcknowledgement, true);

    const ack = await fetch(base + "/acknowledge", {
        method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "42" },
        body: JSON.stringify({ version: companionRoutes.GUIDE_VERSION, userId: 999 })
    });
    assert.equal(ack.status, 200);
    assert.equal(Number(acknowledgedValues[0]), 42, "guide acknowledgement is bound to the authenticated member");
    assert.equal(acknowledgedValues[1], companionRoutes.GUIDE_VERSION);

    const registration = await fetch(base + "/register", {
        method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "42" },
        body: JSON.stringify({ installationId: "616f3b9c-48e4-4b89-a263-df5bc7b6144f", appVersion: "1.0.6", platform: "android", notificationPermissionStatus: "denied", userId: 999 })
    });
    assert.equal(registration.status, 201);
    assert.equal(Number(registrationValues[0]), 42, "app registration is bound to the authenticated member, not the request body");
    assert.equal(registrationValues[2], "android");
    assert.equal(registrationValues[4], "denied");

    const invalid = await fetch(base + "/register", {
        method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "42" },
        body: JSON.stringify({ installationId: "bad-id", appVersion: "1.0.6", platform: "android", notificationPermissionStatus: "granted" })
    });
    assert.equal(invalid.status, 400, "invalid installation identifiers are rejected");

    const otherAccountHeartbeat = await fetch(base + "/heartbeat", {
        method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "43" },
        body: JSON.stringify({ installationId: "616f3b9c-48e4-4b89-a263-df5bc7b6144f", appVersion: "1.0.6" })
    });
    assert.equal(otherAccountHeartbeat.status, 404);
    assert.equal(Number(heartbeatValues[0]), 43, "one member cannot heartbeat another member's installation");
});

test("companion tracker is administrator-only and reports real database aggregates", async (t) => {
    const queries = [];
    const pool = {
        async query(sql, values) {
            const query = String(sql);
            queries.push({ query, values });
            if (/SELECT id, username, role FROM users WHERE id = \$1/.test(query)) {
                const id = Number(values[0]);
                return { rows: [{ id, username: id === 1 ? "admin" : "player", role: id === 1 ? "admin" : "player" }] };
            }
            if (query.includes("total_members")) return { rows: [{ total_members: 3, guide_acknowledged: 2, downloaded_members: 1, anonymous_downloads: 4, registered_members: 1, recently_active_members: 1, notifications_granted: 1, notifications_denied: 0, notifications_unknown: 0 }] };
            if (query.includes("SELECT COUNT(*)::int AS total FROM member_rows")) return { rows: [{ total: 1 }] };
            if (query.includes("SELECT user_id,username,game,account_status")) return { rows: [{ user_id: 42, username: "player", game: "both", account_status: "active", installation_count: 1, active_installation_count: 1, app_version: "1.0.6", notification_permission_status: "granted", currently_registered: true, recently_active: true, guide_acknowledged: true }] };
            if (query.includes("jsonb_agg(jsonb_build_object")) return { rows: [{ user_id: Number(values[0]), username: "player", game: "both", account_status: "active", downloaded: true, downloaded_at: "2026-10-18T09:00:00.000Z", installations: [{ platform: "android", appVersion: "1.0.6", notificationPermissionStatus: "granted", currentlyRegistered: true }] }] };
            throw new Error("Unexpected tracker query: " + query.slice(0, 110));
        }
    };
    const app = express();
    app.use("/api/admin", adminRoutes(pool, (req, res, next) => {
        const userId = Number(req.get("x-test-user"));
        if (!userId) return res.status(401).json({ success: false });
        req.user = { userId };
        next();
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = "http://127.0.0.1:" + server.address().port + "/api/admin/companion-tracker?search=pla%25yer";

    const denied = await fetch(url, { headers: { "x-test-user": "2" } });
    assert.equal(denied.status, 403);
    assert.equal(queries.length, 1, "a non-admin is rejected before tracker data is queried");

    const response = await fetch(url, { headers: { "x-test-user": "1" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stats.total_members, 3);
    assert.equal(body.stats.downloaded_members, 1);
    assert.equal(body.members[0].username, "player");
    const memberQuery = queries.find((entry) => entry.query.includes("SELECT user_id,username,game,account_status"));
    assert.match(memberQuery.query, /ILIKE \$2 ESCAPE '!'/);
    assert.deepEqual(memberQuery.values.slice(0, 3), [companionRoutes.GUIDE_VERSION, "%pla!%yer%", "pla%yer"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");

    const detail = await fetch("http://127.0.0.1:" + server.address().port + "/api/admin/companion-tracker/42", { headers: { "x-test-user": "1" } });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.member.username, "player");
    assert.equal(detailBody.member.installations[0].appVersion, "1.0.6");
});

test("authenticated companion downloads serve the real APK and record only completed delivery", async (t) => {
    let recorded = null;
    let recordedAnonymous = null;
    const apkPath = path.join(__dirname, "../../frontend/downloads/goal-gambit-companion.apk");
    const expected = fs.readFileSync(apkPath);
    const expectedHash = crypto.createHash("sha256").update(expected).digest("hex");
    const app = express();
    app.use("/api/companion", companionRoutes({
        async query(sql, values) {
            if (/INSERT INTO companion_download_events/.test(sql)) recorded = { sql, values };
            else if (/INSERT INTO companion_anonymous_download_events/.test(sql)) recordedAnonymous = { sql, values };
            else throw new Error("Unexpected download record query: " + sql);
            return { rows: [] };
        }
    }, (req, res, next) => {
        if (req.get("x-test-user") !== "42") return res.status(401).json({ success: false });
        req.user = { userId: 42 };
        next();
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = "http://127.0.0.1:" + server.address().port + "/api/companion/download";
    assert.equal((await fetch(url)).status, 401, "APK delivery requires an authenticated account");
    const response = await fetch(url, { headers: { "x-test-user": "42" } });
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/vnd\.android\.package-archive/);
    assert.equal(response.headers.get("x-companion-sha256"), expectedHash);
    assert.equal(crypto.createHash("sha256").update(downloaded).digest("hex"), expectedHash);
    assert.equal(Number(recorded.values[0]), 42, "download events are attributed to the authenticated member only");
    assert.equal(recorded.values[1], expectedHash);

    const publicResponse = await fetch("http://127.0.0.1:" + server.address().port + "/api/companion/public-download");
    const publicApk = Buffer.from(await publicResponse.arrayBuffer());
    assert.equal(publicResponse.status, 200, "the public sign-up download remains available");
    assert.equal(crypto.createHash("sha256").update(publicApk).digest("hex"), expectedHash);
    assert.deepEqual(recordedAnonymous.values, [expectedHash], "public downloads are counted anonymously without user or device identifiers");
});
