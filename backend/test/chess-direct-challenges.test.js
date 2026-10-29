"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const createChessScheduleRoutes = require("../routes/chessSchedules");

function createMemoryPool() {
    const users = new Map([
        [1, { id: 1, username: "alice", game: "chess", account_status: "active" }],
        [2, { id: 2, username: "bob", game: "both", account_status: "active" }],
        [3, { id: 3, username: "carol", game: "chess", account_status: "active" }]
    ]);
    const wallets = new Map([
        [1, { balance: 500, locked_balance: 0 }],
        [2, { balance: 500, locked_balance: 0 }],
        [3, { balance: 500, locked_balance: 0 }]
    ]);
    const schedules = new Map();
    const matches = new Map();
    let nextScheduleId = 1;
    let nextMatchId = 1;
    let nextLedgerId = 1;

    function decorateSchedule(schedule) {
        return Object.assign({}, schedule, {
            host_username: users.get(schedule.host_user_id).username,
            guest_username: users.get(schedule.guest_user_id).username
        });
    }

    async function query(sql, params) {
        const text = String(sql).replace(/\s+/g, " ").trim();
        if (text.includes("SELECT s.*,h.username AS host_username")) {
            if (text.includes("WHERE s.id=$1")) {
                const row = schedules.get(Number(params[0]));
                return { rows: row ? [decorateSchedule(row)] : [] };
            }
            const userId = Number(params[0]);
            const rows = Array.from(schedules.values()).filter(row =>
                [row.host_user_id, row.guest_user_id].includes(userId) &&
                ((["pending", "accepted"].includes(row.status) && row.scheduled_at != null) ||
                    (row.status === "pending" && row.scheduled_at == null) ||
                    (row.scheduled_at == null && ["declined", "cancelled"].includes(row.status)) ||
                    row.status === "started"));
            return { rows: rows.map(decorateSchedule) };
        }
        if (text.startsWith("SELECT id,username,game,account_status FROM users WHERE id=$1")) {
            const user = users.get(Number(params[0]));
            return { rows: user ? [user] : [] };
        }
        throw new Error("Unexpected pool query in direct challenge test: " + text.slice(0, 180));
    }

    return {
        query,
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).replace(/\s+/g, " ").trim();
                    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.startsWith("SAVEPOINT ") ||
                        text.startsWith("RELEASE SAVEPOINT ") || text.startsWith("ROLLBACK TO SAVEPOINT ")) {
                        return { rows: [] };
                    }
                    if (text.includes("SELECT id FROM users WHERE LOWER(username)=$1")) {
                        const user = Array.from(users.values()).find(item => item.username.toLowerCase() === String(params[0]).toLowerCase());
                        return { rows: user ? [{ id: user.id }] : [] };
                    }
                    if (text.includes("SELECT id,username,game,account_status FROM users WHERE id=ANY($1::int[])")) {
                        return { rows: params[0].map(Number).map(id => users.get(id)).filter(Boolean) };
                    }
                    if (text.includes("SELECT id,username,game,account_status FROM users WHERE id=$1")) {
                        const user = users.get(Number(params[0]));
                        return { rows: user ? [user] : [] };
                    }
                    if (text.includes("SELECT pg_advisory_xact_lock")) return { rows: [] };
                    if (text.includes("FROM chess_matches") && text.includes("status IN ('waiting','active','settling')")) {
                        const ids = params[0].map(Number);
                        const found = Array.from(matches.values()).find(match =>
                            [match.player_white_id, match.player_black_id].some(id => ids.includes(Number(id))) &&
                            ["waiting", "active", "settling"].includes(match.status));
                        return { rows: found ? [{ id: found.id }] : [] };
                    }
                    if (text.includes("FROM chess_scheduled_matches") && text.includes("scheduled_at IS NULL AND status='pending'")) {
                        const ids = params[0].map(Number);
                        const found = Array.from(schedules.values()).find(row => row.scheduled_at == null && row.status === "pending" &&
                            [row.host_user_id, row.guest_user_id].some(id => ids.includes(Number(id))));
                        return { rows: found ? [{ id: found.id }] : [] };
                    }
                    if (text.startsWith("UPDATE wallets") && text.includes("balance = balance - $1")) {
                        const wallet = wallets.get(Number(params[1]));
                        if (!wallet || wallet.balance < Number(params[0])) return { rows: [] };
                        wallet.balance -= Number(params[0]);
                        wallet.locked_balance += Number(params[0]);
                        return { rows: [{ user_id: Number(params[1]) }] };
                    }
                    if (text.startsWith("UPDATE wallets") && text.includes("balance = balance + $1")) {
                        const wallet = wallets.get(Number(params[1]));
                        if (!wallet || wallet.locked_balance < Number(params[0])) return { rows: [] };
                        wallet.balance += Number(params[0]);
                        wallet.locked_balance -= Number(params[0]);
                        return { rows: [{ user_id: Number(params[1]) }] };
                    }
                    if (text.startsWith("INSERT INTO transactions")) return { rows: [{ id: 1 }] };
                    if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: nextLedgerId++ }] };
                    if (text.startsWith("INSERT INTO financial_ledger_entries")) return { rows: [] };
                    if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: Number(params[0]) }] };
                    if (text.startsWith("INSERT INTO chess_scheduled_matches")) {
                        const row = {
                            id: nextScheduleId++, host_user_id: Number(params[0]), guest_user_id: Number(params[1]),
                            scheduled_at: null, time_zone: "Africa/Nairobi", time_control: params[2], status: "pending",
                            stake_amount: Number(params[3]), match_id: null, created_at: new Date()
                        };
                        schedules.set(row.id, row);
                        return { rows: [{ id: row.id }] };
                    }
                    if (text.startsWith("SELECT * FROM chess_scheduled_matches WHERE id=$1 FOR UPDATE")) {
                        const row = schedules.get(Number(params[0]));
                        return { rows: row ? [row] : [] };
                    }
                    if (text.startsWith("UPDATE chess_scheduled_matches SET status='started'")) {
                        const row = schedules.get(Number(params[1]));
                        row.status = "started";
                        row.match_id = Number(params[0]);
                        return { rows: [row] };
                    }
                    if (text.startsWith("UPDATE chess_scheduled_matches SET status='cancelled'")) {
                        const row = schedules.get(Number(params[0]));
                        row.status = "cancelled";
                        return { rows: [row] };
                    }
                    if (text.startsWith("UPDATE chess_scheduled_matches SET status=$1")) {
                        const row = schedules.get(Number(params[1]));
                        row.status = String(params[0]);
                        return { rows: [row] };
                    }
                    if (text.startsWith("SELECT username FROM users WHERE id=$1")) {
                        const user = users.get(Number(params[0]));
                        return { rows: user ? [{ username: user.username }] : [] };
                    }
                    if (text.startsWith("INSERT INTO chess_matches")) {
                        const match = { id: nextMatchId++, player_white_id: Number(params[0]), player_black_id: Number(params[1]),
                            status: "active", fen: params[2], white_time_ms: params[3], black_time_ms: params[3],
                            time_control: params[4], match_type: "ranked", stake_amount: Number(params[5]) };
                        matches.set(match.id, match);
                        return { rows: [{ id: match.id }] };
                    }
                    throw new Error("Unexpected transaction query in direct challenge test: " + text.slice(0, 180));
                },
                release() {}
            };
        },
        state: { users, wallets, schedules, matches }
    };
}

async function startApi(pool, t) {
    const app = express();
    app.use(express.json());
    const router = createChessScheduleRoutes(pool, (req, _res, next) => {
        req.user = { userId: Number(req.get("x-test-user")) };
        next();
    }, null, null);
    app.use("/api/chess/schedules", router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return "http://127.0.0.1:" + server.address().port + "/api/chess/schedules";
}

async function post(base, userId, path, body) {
    return fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": String(userId) },
        body: JSON.stringify(body)
    });
}

test("direct Chess challenge reserves both stakes on acceptance, starts immediately, and rejects duplicate pending challenges", async t => {
    const pool = createMemoryPool();
    const base = await startApi(pool, t);
    const host = pool.state.wallets.get(1);
    const guest = pool.state.wallets.get(2);

    const created = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "3+2", stakeAmount: 50 });
    const creation = await created.json();
    assert.equal(created.status, 201);
    assert.equal(creation.schedule.isDirectChallenge, true);
    assert.equal(creation.schedule.scheduledAt, null);
    assert.equal(host.balance, 450);
    assert.equal(host.locked_balance, 50);

    const duplicate = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "3+2", stakeAmount: 50 });
    assert.equal(duplicate.status, 409);
    assert.equal(host.balance, 450, "a duplicate request must not reserve a second stake");
    assert.equal(host.locked_balance, 50);

    const unauthorized = await post(base, 3, "/" + creation.schedule.id + "/respond", { action: "accept" });
    assert.equal(unauthorized.status, 403, "only the invited account may accept a challenge");
    assert.equal(guest.balance, 500);
    assert.equal(guest.locked_balance, 0);

    const accepted = await post(base, 2, "/" + creation.schedule.id + "/respond", { action: "accept" });
    const acceptance = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptance.started, true);
    assert.equal(acceptance.matchId, 1);
    assert.equal(guest.balance, 450);
    assert.equal(guest.locked_balance, 50);
    assert.equal(pool.state.schedules.get(creation.schedule.id).status, "started");
    assert.equal(pool.state.matches.get(acceptance.matchId).stake_amount, 50);
    assert.equal(pool.state.matches.get(acceptance.matchId).match_type, "ranked", "the accepted stake must use the established ranked settlement and rating path");
    assert.equal(pool.state.matches.get(acceptance.matchId).status, "active");
    const repeatedAccept = await post(base, 2, "/" + creation.schedule.id + "/respond", { action: "accept" });
    assert.equal(repeatedAccept.status, 409, "a started challenge cannot lock the guest stake twice");
    assert.equal(guest.balance, 450);
    assert.equal(guest.locked_balance, 50);
    const repeatedInvite = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "3+2", stakeAmount: 50 });
    assert.equal(repeatedInvite.status, 409, "a player in an active direct match cannot create a second challenge");
    assert.equal(host.balance, 450);
    assert.equal(host.locked_balance, 50);
});

test("declining a direct Chess challenge returns the challenger's reserved stake", async t => {
    const pool = createMemoryPool();
    const base = await startApi(pool, t);
    const host = pool.state.wallets.get(1);
    const created = await post(base, 1, "/", { type: "direct", opponentUsername: "carol", timeControl: "10+5", stakeAmount: 20 });
    const creation = await created.json();
    assert.equal(created.status, 201);
    assert.equal(host.balance, 480);
    assert.equal(host.locked_balance, 20);

    const declined = await post(base, 3, "/" + creation.schedule.id + "/respond", { action: "decline" });
    const result = await declined.json();
    assert.equal(declined.status, 200);
    assert.match(result.message, /returned/i);
    assert.equal(host.balance, 500);
    assert.equal(host.locked_balance, 0);
    assert.equal(pool.state.schedules.get(creation.schedule.id).status, "declined");
    for (const userId of [1, 3]) {
        const response = await fetch(base, { headers: { "x-test-user": String(userId) } });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.schedules[0].status, "declined", "both players can see the challenge status after refreshing");
    }
});

test("direct Chess challenges reject unsupported stakes without moving wallet funds", async t => {
    const pool = createMemoryPool();
    const base = await startApi(pool, t);
    const response = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "3+2", stakeAmount: 25 });
    assert.equal(response.status, 400);
    assert.equal(pool.state.wallets.get(1).balance, 500);
    assert.equal(pool.state.wallets.get(1).locked_balance, 0);
    assert.equal(pool.state.schedules.size, 0);
});

test("direct Chess challenge validates usernames and available wallet balance before creating a challenge", async t => {
    const pool = createMemoryPool();
    const base = await startApi(pool, t);
    const invalidUsername = await post(base, 1, "/", { type: "direct", opponentUsername: "not a username", timeControl: "10+5", stakeAmount: 20 });
    assert.equal(invalidUsername.status, 400);

    pool.state.wallets.get(1).balance = 10;
    const insufficient = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "10+5", stakeAmount: 20 });
    assert.equal(insufficient.status, 402);
    assert.match((await insufficient.json()).message, /insufficient available wallet balance/i);
    assert.equal(pool.state.wallets.get(1).balance, 10);
    assert.equal(pool.state.wallets.get(1).locked_balance, 0);
    assert.equal(pool.state.schedules.size, 0);
});

test("cancelling a pending direct Chess challenge returns the challenger's reservation", async t => {
    const pool = createMemoryPool();
    const base = await startApi(pool, t);
    const host = pool.state.wallets.get(1);
    const created = await post(base, 1, "/", { type: "direct", opponentUsername: "bob", timeControl: "1+1", stakeAmount: 100 });
    const creation = await created.json();
    assert.equal(created.status, 201);
    assert.equal(host.balance, 400);
    assert.equal(host.locked_balance, 100);

    const cancelled = await post(base, 1, "/" + creation.schedule.id + "/cancel", {});
    const result = await cancelled.json();
    assert.equal(cancelled.status, 200);
    assert.match(result.message, /returned/i);
    assert.equal(host.balance, 500);
    assert.equal(host.locked_balance, 0);
    assert.equal(pool.state.schedules.get(creation.schedule.id).status, "cancelled");
});
