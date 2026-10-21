"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const createEfootballRoutes = require("../routes/efootball");
const { eatDateTimeToUtc } = require("../services/efootballScheduleRules");

test("ranked matchmaking rejects a direct API request at the 12:50 AM EAT cutoff and audits it", async (t) => {
    const now = eatDateTimeToUtc(2026, 10, 21, 0, 50);
    const rejections = [];
    const query = async (sql, values) => {
        const statement = String(sql).trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [], rowCount: 0 };
        if (statement === "SELECT NOW() AS now") return { rows: [{ now }] };
        if (statement.includes("FROM efootball_matches") && statement.includes("WHERE status='waiting'") && statement.includes("search_last_seen_at")) {
            return { rows: [] };
        }
        if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (statement.includes("SELECT game, account_status FROM users")) {
            return { rows: [{ game: "konami", account_status: "active" }] };
        }
        if (statement.includes("FROM efootball_matches WHERE (creator_id=$1 OR opponent_id=$1)")) return { rows: [] };
        if (statement.includes("INSERT INTO efootball_matchmaking_rejections")) {
            rejections.push(values);
            return { rows: [], rowCount: 1 };
        }
        throw new Error("Unexpected schedule endpoint query: " + statement);
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const app = express();
    app.use(express.json());
    app.use("/api/efootball", createEfootballRoutes(pool, (req, _res, next) => {
        req.user = { userId: 7 };
        next();
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/efootball/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ranked", stake_amount: 20 })
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.match(body.message, /opens daily at 4:00 PM EAT/);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0][1], "outside_gaming_window");
});
