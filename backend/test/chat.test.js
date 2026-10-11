"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const createChatRoutes = require("../routes/chat");

test("private inbox returns the last-message read timestamp", async (t) => {
    const readAt = "2026-10-11T09:30:00.000Z";
    let inboxSql = "";
    const pool = {
        query: async (sql) => {
            inboxSql = sql;
            return {
                rows: [{
                    thread_id: 12,
                    user_id: 8,
                    username: "opponent",
                    game: "eFootball",
                    last_message: "See you in the match",
                    last_message_at: readAt,
                    last_message_read_at: readAt,
                    unread_count: 1
                }]
            };
        }
    };
    const app = express();
    app.use("/api/chat", createChatRoutes(
        pool,
        (req, _res, next) => { req.user = { userId: 7 }; next(); },
        () => [8]
    ));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/chat/inbox");
    const body = await response.json();
    const lateralSelection = inboxSql.match(/LEFT JOIN LATERAL\s*\(\s*SELECT([\s\S]*?)FROM chat_messages m/i);

    assert.equal(response.status, 200);
    assert.ok(lateralSelection, "inbox query contains the latest-message lateral query");
    assert.match(lateralSelection[1], /\bm\.read_at\b/, "latest-message query selects read_at");
    assert.equal(body.unreadCount, 1);
    assert.equal(body.threads[0].last_message_read_at, readAt);
    assert.equal(body.threads[0].online, true);
});
