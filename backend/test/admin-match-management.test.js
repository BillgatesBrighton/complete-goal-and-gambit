"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const createAdminMatchManagementRoutes = require("../routes/adminMatchManagement");

test("admins can view filtered matches, cancel and refund an unsettled match, then clear and restore it", async (t) => {
    const queries = [];
    const writes = [];
    const currentMatch = {
        id: 44, creator_id: 11, opponent_id: 12, mode: "ranked", match_type: "ranked",
        status: "disputed", stake_amount: "50.00", started_at: new Date(), settled_at: null,
        tournament_fixture_id: null, league_fixture_id: null
    };
    const chessMatch = {
        id: 55, player_white_id: 21, player_black_id: 22, status: "active", result: null,
        winner_id: null, match_type: "casual", stake_amount: 0, settled_at: null,
        rating_updated_at: null
    };
    const chessListRow = {
        id: 55, game: "chess", match_type: "casual", status: "active", result_status: null,
        creator_id: 21, opponent_id: 22, creator_username: "white-player", opponent_username: "black-player",
        winner_id: null, stake_amount: "0.00", time_control: "10+5", created_at: new Date().toISOString(),
        started_at: new Date().toISOString(), finished_at: null, settled_at: null, admin_cleared_at: null
    };
    const konamiListRow = {
        id: 44, game: "konami", match_type: "ranked", status: "disputed", result_status: "disputed",
        creator_id: 11, opponent_id: 12, creator_username: "player-a", opponent_username: "player-b",
        winner_id: null, stake_amount: "50.00", created_at: new Date().toISOString(), started_at: new Date().toISOString(),
        finished_at: null, settled_at: null, admin_cleared_at: null, creator_score: 2, opponent_score: 1,
        mode: "ranked", league: null, tournament_id: null
    };
    const pool = {
        async query(sql, params) {
            queries.push({ sql: String(sql), params });
            if (/SELECT id,username,role FROM users WHERE id=\$1/i.test(String(sql))) {
                return { rows: [{ id: Number(params[0]), username: Number(params[0]) === 1 ? "admin" : "player", role: Number(params[0]) === 1 ? "admin" : "user" }] };
            }
        if (String(sql).includes("SELECT player_white_id,player_black_id,status,settled_at,connection_paused_at FROM chess_matches")) return { rows: [{ player_white_id: 21, player_black_id: 22, status: chessMatch.status, settled_at: chessMatch.settled_at, connection_paused_at: chessMatch.connection_paused_at || null }] };
            if (String(sql).includes("FROM efootball_matches m")) return { rows: [konamiListRow] };
            if (String(sql).includes("FROM chess_matches m")) return { rows: [chessListRow] };
            throw new Error("Unexpected pool query: " + String(sql).slice(0, 120));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const text = String(sql).trim();
                    writes.push({ sql: text, params });
                    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
                    if (/^SELECT \*[\s\S]*FROM chess_matches/i.test(text)) return { rows: [chessMatch] };
                    if (text.includes("UPDATE chess_matches") && text.includes("status = 'completed'")) {
                        chessMatch.status = "completed";
                        chessMatch.result = params[0];
                        chessMatch.winner_id = params[1];
                        chessMatch.settled_at = new Date();
                        return { rows: [] };
                    }
                    if (text.startsWith("SELECT * FROM efootball_matches")) return { rows: [currentMatch] };
                    if (text.startsWith("SELECT user_id,locked_balance FROM wallets")) return { rows: [{ user_id: 11, locked_balance: "50.00" }, { user_id: 12, locked_balance: "50.00" }] };
                    if (text.startsWith("SELECT id FROM transactions")) return { rows: [] };
                    if (text.startsWith("UPDATE wallets")) return { rows: [{ user_id: Number(params[1]) }] };
                    if (text.startsWith("UPDATE efootball_matches SET status='cancelled'")) {
                        currentMatch.status = "cancelled";
                        currentMatch.settled_at = new Date();
                        return { rows: [] };
                    }
                    if (text.startsWith("SELECT id,status,settled_at,admin_cleared_at FROM efootball_matches")) {
                        return { rows: [{ id: 44, status: currentMatch.status, settled_at: currentMatch.settled_at, admin_cleared_at: currentMatch.admin_cleared_at || null }] };
                    }
                    if (text.startsWith("UPDATE efootball_matches SET admin_cleared_at")) {
                        currentMatch.admin_cleared_at = params[0];
                        return { rows: [] };
                    }
                    if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: 900 }] };
                    if (text.startsWith("INSERT INTO financial_ledger_entries")) return { rows: [] };
                    if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }], rowCount: 1 };
                    return { rows: [] };
                },
                release() {}
            };
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/admin/matches", createAdminMatchManagementRoutes(pool, (req, res, next) => {
        const id = Number(req.get("x-test-user"));
        if (!id) return res.status(401).json({ success: false });
        req.user = { userId: id };
        return next();
    }));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/admin/matches";

    const player = await fetch(base + "?game=konami&type=ranked", { headers: { "x-test-user": "2" } });
    assert.equal(player.status, 403, "players cannot access admin match management");
    assert.equal(queries.filter((item) => item.sql.includes("FROM efootball_matches m")).length, 0, "unauthorized users do not reach match data queries");

    const listed = await fetch(base + "?game=konami&type=ranked", { headers: { "x-test-user": "1" } });
    const listBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listBody.matches[0].can_cancel_refund, true);
    assert.equal(listBody.matches[0].can_edit_score, true);
    assert.match(queries.at(-1).sql, /CASE WHEN m\.mode='tournament'/, "Konami rows are classified by ranked, league, or tournament mode");

    const chessListed = await fetch(base + "?game=chess&type=casual", { headers: { "x-test-user": "1" } });
    const chessListBody = await chessListed.json();
    assert.equal(chessListed.status, 200);
    assert.equal(chessListBody.matches[0].can_edit_score, true);
    const chessResult = await fetch(base + "/chess/55/result", {
        method: "POST", headers: { "x-test-user": "1", "content-type": "application/json" },
        body: JSON.stringify({ result: "white_win", reason: "Screenshot confirmed White won." })
    });
    assert.equal(chessResult.status, 200);
    assert.equal(chessMatch.result, "white_win");
    assert.ok(writes.some((item) => item.sql.includes("admin_match_management_events") && item.params[0] === 55), "Chess result changes are audited with the settlement");

    const cancel = await fetch(base + "/konami/44/cancel-refund", {
        method: "POST", headers: { "x-test-user": "1", "content-type": "application/json" },
        body: JSON.stringify({ reason: "Player support requested cancellation." })
    });
    const cancelBody = await cancel.json();
    assert.equal(cancel.status, 200);
    assert.equal(cancelBody.refundedPlayers, 2);
    assert.equal(writes.filter((item) => item.sql.startsWith("UPDATE wallets")).length, 2);
    assert.equal(writes.filter((item) => item.sql.startsWith("INSERT INTO transactions")).length, 2);
    assert.ok(writes.some((item) => item.sql.includes("admin_match_management_events")), "cancellation is audited");
    const duplicateCancel = await fetch(base + "/konami/44/cancel-refund", {
        method: "POST", headers: { "x-test-user": "1", "content-type": "application/json" },
        body: JSON.stringify({ reason: "Trying the same refund again." })
    });
    assert.equal(duplicateCancel.status, 409, "a settled match cannot receive a second admin refund");
    assert.equal(writes.filter((item) => item.sql.startsWith("UPDATE wallets")).length, 2);

    const clear = await fetch(base + "/konami/44/clear", { method: "POST", headers: { "x-test-user": "1" } });
    assert.equal(clear.status, 200);
    assert.ok(writes.some((item) => item.sql.startsWith("UPDATE efootball_matches SET admin_cleared_at")));
    const restore = await fetch(base + "/konami/44/restore", { method: "POST", headers: { "x-test-user": "1" } });
    assert.equal(restore.status, 200);
    assert.equal(currentMatch.admin_cleared_at, null);

    const source = fs.readFileSync(path.join(__dirname, "../../frontend/js/admin.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../private-pages/admin-dashboard.html"), "utf8");
    assert.match(html, /id="matchManagement"/, "the private dashboard has a match management section");
    assert.match(source, /data-match-score-form/, "Konami score editing is available in the admin UI");
    assert.match(source, /data-chess-result-form/, "Chess result editing is available in the admin UI");
    assert.match(source, /data-match-wallet/, "admins can jump to the existing wallet adjustment form for either player");
});
