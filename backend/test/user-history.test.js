"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const createUserHistoryRoutes = require("../routes/userHistory");

test("transaction history clear stores a per-user view marker and the transaction query respects it", async (t) => {
    let capturedSql = "";
    let capturedParams = [];
    const pool = {
        async query(sql, params) {
            capturedSql = String(sql);
            capturedParams = params;
            return { rows: [{ cleared_at: "2026-10-13T12:00:00.000Z" }] };
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/history", createUserHistoryRoutes(pool, (req, _res, next) => {
        req.user = { userId: 73 };
        next();
    }));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/history/clear", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ historyType: "transactions" })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(capturedParams[0], 73);
    assert.equal(capturedParams[1], "transactions");
    assert.match(capturedSql, /ON CONFLICT \(user_id, history_type\)/);
    assert.match(body.message, /Wallet and payment records remain securely stored/);

    const walletSource = fs.readFileSync(path.join(__dirname, "../routes/wallet.js"), "utf8");
    const efootballSource = fs.readFileSync(path.join(__dirname, "../routes/efootball.js"), "utf8");
    const chessSource = fs.readFileSync(path.join(__dirname, "../routes/chess.js"), "utf8");
    const apiSource = fs.readFileSync(path.join(__dirname, "../../frontend/js/api.js"), "utf8");
    assert.match(walletSource, /created_at\s*>\s*COALESCE\([\s\S]*history_type\s*=\s*'transactions'/,
        "wallet transaction reads filter out records at or before the clear marker");
    assert.match(efootballSource, /history_type\s*=\s*'matches'[\s\S]*?\)\s*AND\s*m\.status/s,
        "Konami match history reads respect the user's clear marker");
    assert.match(chessSource, /history_type\s*=\s*'matches'[\s\S]*?ORDER BY finished_at/s,
        "Chess match history reads respect the user's clear marker");
    assert.match(apiSource, /cache:\s*options\.cache\s*\|\|\s*"no-store"/,
        "authenticated API reads bypass stale browser cache entries");
    const walletPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/wallet.html"), "utf8");
    const konamiPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/konami.html"), "utf8");
    const chessPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/chess.html"), "utf8");
    const adminScript = fs.readFileSync(path.join(__dirname, "../../frontend/js/admin.js"), "utf8");
    assert.match(walletPage, /finally\s*\{\s*button\.disabled\s*=\s*false;/,
        "wallet clear control re-enables even if request handling fails");
    assert.match(walletPage, /transactionList"\)\.innerHTML\s*=\s*'<div class="empty">No transactions in your history\.<\/div>'/,
        "wallet history rows disappear immediately after a successful clear");
    assert.match(walletPage, /history-toolbar \.history-clear-button \{ align-self: flex-end; \}/,
        "wallet clear control stays aligned to the right on narrow screens");
    assert.match(konamiPage, /finally\s*\{\s*button\.disabled\s*=\s*false;/,
        "Konami clear control re-enables even if request handling fails");
    assert.match(konamiPage, /removeItem\("goalGambitTransactions"\)[\s\S]*?renderTransactions\(\)/,
        "Konami transaction history cache and list are cleared immediately");
    assert.match(konamiPage, /removeItem\("goalGambitGameRecords"\)[\s\S]*?updateDashboard\(\)/,
        "Konami match history cache and dashboard are cleared immediately");
    assert.match(chessPage, /finally\s*\{\s*button\.disabled\s*=\s*false;/,
        "Chess clear control re-enables even if request handling fails");
    assert.match(chessPage, /removeItem\("goalGambitGameRecords"\)[\s\S]*?renderRecords\(\)[\s\S]*?renderStats\(\)/,
        "Chess match history cache, list, and counts are cleared immediately");
    assert.match(adminScript, /Result dispute list updated\.\",\"ok\"\);await loadResults\(\)/,
        "admin result clear refreshes its own list even while the shared dashboard refresh is busy");
    assert.match(adminScript, /Complaint list updated\.\",\"ok\"\);await loadComplaints\(\)/,
        "admin complaint clear refreshes its own list immediately");
    assert.match(adminScript, /Conversation updated\.\",\"ok\"\);await loadThreads\(\)/,
        "admin support clear refreshes its own list immediately");
});
