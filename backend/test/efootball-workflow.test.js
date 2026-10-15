"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const createEfootballRoutes = require("../routes/efootball");

function makeFixture(overrides) {
    return {
        id: 5,
        creator_id: 1,
        opponent_id: 2,
        code_sender_id: 1,
        status: "waiting",
        external_room_code: "ROOM-42",
        code_sent_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        code_sent: true,
        code_received_at: null,
        code_received_by: null,
        room_code_revision: 0,
        code_correction_requested_at: null,
        code_correction_requested_by: null,
        started_at: null,
        stake_amount: 0,
        creator_ready: false,
        opponent_ready: false,
        creator_username: "sender",
        opponent_username: "receiver",
        verification_status: null,
        screenshot_submitted: false,
        screenshot_sender_id: null,
        ...overrides
    };
}

async function startWorkflowServer(userId, fixture, t) {
    const notifications = [];
    const pushEvents = [];
    const socketEvents = [];
    const queries = [];
    const query = async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes("FROM efootball_matches m") && sql.includes("creator.username AS creator_username")) {
            if (![Number(fixture.creator_id), Number(fixture.opponent_id)].includes(Number(values[1]))) return { rows: [] };
            return { rows: [{ ...fixture }] };
        }
        if (sql.includes("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE")) {
            return { rows: [{ ...fixture }] };
        }
        if (sql.includes("UPDATE efootball_matches SET code_received_at")) {
            fixture.code_received_at = new Date().toISOString();
            fixture.code_received_by = values[0];
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes("external_room_code=$1") && sql.includes("room_code_revision=room_code_revision+1")) {
            fixture.external_room_code = values[0];
            fixture.code_sent = true;
            fixture.code_sent_at = new Date().toISOString();
            fixture.room_code_revision = Number(fixture.room_code_revision || 0) + 1;
            fixture.code_received_at = null;
            fixture.code_received_by = null;
            fixture.code_correction_requested_at = null;
            fixture.code_correction_requested_by = null;
            fixture.creator_ready = Number(values[1]) === Number(fixture.creator_id);
            fixture.opponent_ready = Number(values[1]) === Number(fixture.opponent_id);
            fixture.status = "waiting";
            return { rows: [{ room_code_revision: fixture.room_code_revision }], rowCount: 1 };
        }
        if (sql.includes("UPDATE efootball_matches SET code_correction_requested_at=NOW()")) {
            fixture.code_correction_requested_at = new Date().toISOString();
            fixture.code_correction_requested_by = values[0];
            fixture.code_received_at = null;
            fixture.code_received_by = null;
            fixture.creator_ready = false;
            fixture.opponent_ready = false;
            fixture.status = "waiting";
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT username FROM users WHERE id=$1")) {
            return { rows: [{ username: Number(values[0]) === 1 ? "sender" : "receiver" }] };
        }
        if (sql.includes("INSERT INTO system_notifications")) {
            notifications.push(values);
            return { rows: [{ id: notifications.length, created_at: new Date().toISOString() }], rowCount: 1 };
        }
        if ([
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT efootball_push_enqueue",
            "RELEASE SAVEPOINT efootball_push_enqueue",
            "ROLLBACK TO SAVEPOINT efootball_push_enqueue"
        ].includes(sql.trim())) return { rows: [], rowCount: 0 };
        throw new Error("Unexpected workflow test query: " + sql);
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const pushService = {
        enqueueNotification: async (_client, recipientId, event) => {
            pushEvents.push({ recipientId, event });
            return { id: pushEvents.length, created: true };
        },
        sendPendingJobs: async () => {}
    };
    const io = { to: (room) => ({ emit: (event, data) => socketEvents.push({ room, event, data }) }) };
    const app = express();
    app.use(express.json());
    app.use("/api/efootball", createEfootballRoutes(pool, (req, _res, next) => {
        req.user = { userId };
        next();
    }, io, pushService));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return {
        request: async (url, options) => fetch("http://127.0.0.1:" + server.address().port + url, options),
        notifications,
        pushEvents,
        socketEvents,
        queries,
        fixture
    };
}

test("only the receiver sees the private room code through the match endpoint", async (t) => {
    const fixture = makeFixture();
    const sender = await startWorkflowServer(1, fixture, t);
    const senderResponse = await sender.request("/api/efootball/matches/5");
    const senderBody = await senderResponse.json();
    assert.equal(senderResponse.status, 200);
    assert.equal(senderBody.match.room_code, null);
    assert.equal(Object.hasOwn(senderBody.match, "external_room_code"), false);
    const receiver = await startWorkflowServer(2, fixture, t);
    const receiverResponse = await receiver.request("/api/efootball/matches/5");
    const receiverBody = await receiverResponse.json();
    assert.equal(receiverResponse.status, 200);
    assert.equal(receiverBody.match.room_code, "ROOM-42");
    assert.equal(Object.hasOwn(receiverBody.match, "external_room_code"), false);
});

test("room-code receipt is receiver-only, persistent, and does not start the match", async (t) => {
    const fixture = makeFixture();
    const sender = await startWorkflowServer(1, fixture, t);
    const senderResponse = await sender.request("/api/efootball/matches/5/code-received", { method: "POST" });
    assert.equal(senderResponse.status, 403);
    assert.equal(fixture.code_received_at, null);
    assert.equal(sender.pushEvents.length, 0);

    const receiver = await startWorkflowServer(2, fixture, t);
    const response = await receiver.request("/api/efootball/matches/5/code-received", { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.codeReceived, true);
    assert.equal(fixture.code_received_by, 2);
    assert.equal(fixture.status, "waiting");
    assert.equal(receiver.pushEvents.length, 1);
    assert.equal(receiver.pushEvents[0].recipientId, 1);
    assert.equal(receiver.pushEvents[0].event.body.includes("ROOM-42"), false);
    assert.ok(receiver.socketEvents.some(event => event.room === "user_1" && event.event === "efootball:match-update" && event.data.reason === "room-code-received"));
    assert.ok(receiver.socketEvents.some(event => event.room === "user_2" && event.event === "efootball:match-update" && event.data.reason === "room-code-received"));
    const duplicate = await receiver.request("/api/efootball/matches/5/code-received", { method: "POST" });
    assert.equal(duplicate.status, 200);
    assert.equal(receiver.pushEvents.length, 1);
});

test("sending a room code alerts only the receiver without putting the code in push", async (t) => {
    const fixture = makeFixture({ code_sent: false, external_room_code: null });
    const sender = await startWorkflowServer(1, fixture, t);
    const response = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ROOM-42" })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.room_code, "ROOM-42");
    assert.equal(body.match.room_code, null);
    assert.equal(body.match.codeReceiverId, 2);
    assert.ok(body.match.codeSentAt);
    assert.equal(body.match.yourReady, true);
    assert.equal(body.match.opponentReady, false);
    assert.equal(sender.pushEvents.length, 1);
    assert.equal(sender.pushEvents[0].recipientId, 2);
    assert.equal(sender.pushEvents[0].event.body.includes("ROOM-42"), false);
    assert.equal(sender.pushEvents[0].event.eventKey, "efootball-match:5:room-code-sent:1");
    assert.ok(sender.socketEvents.some(event => event.room === "user_2" && event.event === "efootball:match-update" && event.data.reason === "room-code-sent"));
    assert.ok(sender.socketEvents.some(event => event.room === "user_1" && event.event === "efootball:match-update" && event.data.reason === "room-code-sent"));
    const receiverNotice = sender.socketEvents.find(event => event.room === "user_2" && event.event === "efootball:notification");
    assert.ok(receiverNotice);
    assert.equal(receiverNotice.data.title, "ROOM CODE RECEIVED");
    assert.match(receiverNotice.data.message, /Match GG-5/);
    assert.equal(JSON.stringify(sender.socketEvents).includes("ROOM-42"), false);
});

test("only the assigned sender may send a room code", async (t) => {
    const fixture = makeFixture({ code_sent: false, external_room_code: null });
    const receiver = await startWorkflowServer(2, fixture, t);
    const response = await receiver.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ROOM-42" })
    });
    assert.equal(response.status, 403);
    assert.equal(fixture.external_room_code, null);
    assert.equal(fixture.code_sent, false);
    assert.equal(receiver.notifications.length, 0);
    assert.equal(receiver.pushEvents.length, 0);
});

test("room-code input is validated and retries of a committed send are idempotent", async (t) => {
    const fixture = makeFixture({ code_sent: false, external_room_code: null });
    const sender = await startWorkflowServer(1, fixture, t);
    for (const code of ["", "ROOM/42"]) {
        const invalid = await sender.request("/api/efootball/matches/5/send-code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
        });
        assert.equal(invalid.status, 400);
    }
    const first = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ROOM-42" })
    });
    assert.equal(first.status, 200);
    assert.equal(fixture.room_code_revision, 1);
    const notificationCount = sender.notifications.length;
    const pushCount = sender.pushEvents.length;
    const retry = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ROOM-42" })
    });
    const retryBody = await retry.json();
    assert.equal(retry.status, 200);
    assert.equal(retryBody.duplicate, true);
    assert.equal(fixture.room_code_revision, 1);
    assert.equal(sender.notifications.length, notificationCount);
    assert.equal(sender.pushEvents.length, pushCount);
    const conflictingRetry = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "OTHER-43" })
    });
    assert.equal(conflictingRetry.status, 409);
});

test("an offline receiver can retrieve the saved room code and match notification later", async (t) => {
    const fixture = makeFixture({ code_sent: false, external_room_code: null });
    const sender = await startWorkflowServer(1, fixture, t);
    const sent = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ROOM-42" })
    });
    assert.equal(sent.status, 200);
    assert.equal(sender.notifications[0][0], 2);

    const receiver = await startWorkflowServer(2, fixture, t);
    const reopened = await receiver.request("/api/efootball/matches/5");
    const body = await reopened.json();
    assert.equal(reopened.status, 200);
    assert.equal(body.match.room_code, "ROOM-42");
    assert.equal(body.match.codeSent, true);
    assert.ok(body.match.codeSentAt);
});

test("an unrelated account cannot retrieve the room code", async (t) => {
    const outsider = await startWorkflowServer(99, makeFixture(), t);
    const response = await outsider.request("/api/efootball/matches/5");
    assert.equal(response.status, 404);
});

test("only the receiver can request a replacement and only the sender can submit it", async (t) => {
    const fixture = makeFixture({ room_code_revision: 1, code_sent: true, external_room_code: "OLD-42", code_received_at: new Date().toISOString(), code_received_by: 2 });
    const senderRequest = await startWorkflowServer(1, fixture, t);
    const denied = await senderRequest.request("/api/efootball/matches/5/code-correction", { method: "POST" });
    assert.equal(denied.status, 403);

    const receiver = await startWorkflowServer(2, fixture, t);
    const requested = await receiver.request("/api/efootball/matches/5/code-correction", { method: "POST" });
    assert.equal(requested.status, 200);
    assert.equal(fixture.code_correction_requested_by, 2);
    assert.equal(fixture.code_received_at, null);
    assert.equal(receiver.pushEvents[0].recipientId, 1);
    assert.equal(receiver.pushEvents[0].event.body.includes("OLD-42"), false);
    const hiddenOldCode = await receiver.request("/api/efootball/matches/5");
    assert.equal((await hiddenOldCode.json()).match.room_code, null);
    const staleConfirmation = await receiver.request("/api/efootball/matches/5/code-received", { method: "POST" });
    assert.equal(staleConfirmation.status, 409);
    assert.equal(fixture.code_received_at, null);

    const sender = await startWorkflowServer(1, fixture, t);
    const replacement = await sender.request("/api/efootball/matches/5/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "NEW-77" })
    });
    const body = await replacement.json();
    assert.equal(replacement.status, 200);
    assert.equal(body.room_code, "NEW-77");
    assert.equal(body.match.room_code, null);
    assert.equal(fixture.room_code_revision, 2);
    assert.equal(fixture.code_correction_requested_at, null);
    assert.equal(fixture.code_received_at, null);
    assert.equal(sender.pushEvents[0].recipientId, 2);
    assert.equal(sender.pushEvents[0].event.eventKey, "efootball-match:5:room-code-sent:2");
    assert.equal(sender.pushEvents[0].event.body.includes("NEW-77"), false);
});

test("a nonparticipant cannot confirm receipt or submit a match result", async (t) => {
    const fixture = makeFixture({ status: "playing", code_received_at: new Date().toISOString(), code_received_by: 2 });
    const outsider = await startWorkflowServer(99, fixture, t);
    const receipt = await outsider.request("/api/efootball/matches/5/code-received", { method: "POST" });
    assert.equal(receipt.status, 403);
    const result = await outsider.request("/api/efootball/matches/5/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yourScore: 1, opponentScore: 0 })
    });
    assert.equal(result.status, 403);
});
