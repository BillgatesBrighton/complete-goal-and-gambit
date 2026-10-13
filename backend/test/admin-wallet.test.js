"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const createAdminWalletRoutes = require("../routes/adminWallet");

test("admin wallet history clear endpoint clears the view without deleting ledger records", async (t) => {
    const queries = [];
    const clearedAt = "2026-10-13T12:00:00.000Z";
    const pool = {
        async query(sql, params) {
            const text = String(sql).trim();
            queries.push({ text, params });
            if (text === "SELECT id,role FROM users WHERE id=$1") return { rows: [{ id: 9, role: "admin" }] };
            if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
            if (text.startsWith("SELECT balance,currency FROM admin_wallets")) return { rows: [{ balance: "80.00", currency: "KES" }] };
            if (text.startsWith("SELECT cleared_at FROM admin_wallet_history_clears")) return { rows: [{ cleared_at: null }] };
            if (text.startsWith("SELECT transaction_type,amount,currency,status,reference,description,created_at")) return { rows: [] };
            if (text.startsWith("INSERT INTO admin_wallet_history_clears")) return { rows: [{ cleared_at: clearedAt }] };
            throw new Error("Unexpected admin wallet query: " + text.slice(0, 100));
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/admin/wallet", createAdminWalletRoutes(pool, (req, _res, next) => {
        req.user = { userId: 9 };
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
    assert.deepEqual(body.transactions, []);
    assert(queries.some((query) => query.text.includes("created_at > COALESCE") && query.text.includes("admin_wallet_history_clears")),
        "wallet activity reads should apply the per-admin clear marker");
});
