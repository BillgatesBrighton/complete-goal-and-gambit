"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const createAdminWalletRoutes = require("../routes/adminWallet");

test("admin wallet history clear endpoint clears the view without deleting ledger records", async (t) => {
    process.env.ADMIN_USER_IDS = "39,40";
    const queries = [];
    const clearedAt = "2026-10-13T12:00:00.000Z";
    const pool = {
        async query(sql, params) {
            const text = String(sql).trim();
            queries.push({ text, params });
            if (/SELECT id,\s*username,\s*role FROM users WHERE id\s*=\s*\$1/i.test(text)) return { rows: [{ id: 39, username: "briton", role: "admin" }] };
            if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
            if (text.startsWith("SELECT balance,reserved_balance,currency FROM admin_wallets")) return { rows: [{ balance: "80.00", reserved_balance: "10.00", currency: "KES" }] };
            if (text.startsWith("SELECT cleared_at FROM admin_wallet_history_clears")) return { rows: [{ cleared_at: null }] };
            if (text.startsWith("SELECT t.transaction_type,t.amount,t.currency,t.status,t.reference,t.description,t.created_at")) return { rows: [] };
            if (text.includes("SUM(balance-reserved_balance)")) return { rows: [{ total_balance: "80.00", available: "70.00", competition_reserved: "10.00" }] };
            if (text.includes("FROM admin_wallet_transactions WHERE status='completed' GROUP BY transaction_type")) return { rows: [{ transaction_type: "league_entry_fee", amount: "25.00" }] };
            if (text.includes("FROM manual_withdrawal_requests WHERE status='pending'")) return { rows: [{ player_manual: "8.00", admin_provider: "2.00" }] };
            if (text.includes("SUM(retained_revenue) FROM efootball_competition_settlements")) return { rows: [{ efootball: "3.00", chess: "1.00" }] };
            if (text.startsWith("WITH ledger AS (")) return { rows: [{ player_available_mismatches: "0", player_locked_mismatches: "0", player_withdrawal_mismatches: "0", admin_available_mismatches: "0", admin_reserved_mismatches: "0", unbalanced_journals: "0" }] };
            if (text.startsWith("INSERT INTO admin_wallet_history_clears")) return { rows: [{ cleared_at: clearedAt }] };
            throw new Error("Unexpected admin wallet query: " + text.slice(0, 100));
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/admin/wallet", createAdminWalletRoutes(pool, (req, _res, next) => {
        req.user = { userId: 39 };
        next();
    }, null));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/admin/wallet";

    const cleared = await fetch(base + "/history/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(cleared.status, 200);
    assert.match((await cleared.json()).message, /ledger records were retained/);
    assert.equal(queries.filter((query) => query.text.startsWith("INSERT INTO admin_wallet_history_clears")).length, 1);

    const wallet = await fetch(base);
    assert.equal(wallet.status, 200);
    const body = await wallet.json();
    assert.equal(body.wallet.balance, 80);
    assert.equal(body.wallet.reservedBalance, 10);
    assert.equal(body.wallet.availableBalance, 70);
    assert.equal(body.platform.pendingWithdrawalReservations, 10);
    assert.equal(body.platform.retainedPrizePoolRevenue, 4);
    assert.equal(body.platform.totalFundsReceived, 25);
    assert.equal(body.platform.entryFeesCollected, 25);
    assert.deepEqual(body.reconciliation, { player_available_mismatches: 0, player_locked_mismatches: 0, player_withdrawal_mismatches: 0, admin_available_mismatches: 0, admin_reserved_mismatches: 0, unbalanced_journals: 0 });
    assert.deepEqual(body.transactions, []);
    assert(queries.some((query) => query.text.includes("created_at > COALESCE") && query.text.includes("admin_wallet_history_clears")),
        "wallet activity reads should apply the per-admin clear marker");
});
