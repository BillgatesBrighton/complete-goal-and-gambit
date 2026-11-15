"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const walletRoutes = require("../routes/wallet");
const adminWalletRoutes = require("../routes/adminWallet");

async function serve(app, t) {
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return "http://127.0.0.1:" + server.address().port;
}

test("manual withdrawal reserves funds without reducing wallet balance", async (t) => {
    const state = { balance: 1000, reserved: 0, request: null, journalId: 0 };
    const client = {
        async query(sql, params = []) {
            const text = String(sql).replace(/\s+/g, " ").trim();
            if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
            if (text.includes("FROM auth_sessions s")) return { rows: [{ "1": 1 }] };
            if (text.startsWith("SELECT balance,withdrawal_reserved_balance FROM wallets")) return { rows: [{ balance: state.balance, withdrawal_reserved_balance: state.reserved }] };
            if (text.startsWith("SELECT 1 FROM manual_withdrawal_requests")) return { rows: [] };
            if (text.startsWith("UPDATE wallets SET withdrawal_reserved_balance=")) {
                const amount = Number(params[0]);
                if (state.balance - state.reserved < amount) return { rows: [] };
                state.reserved += amount;
                return { rows: [{ balance: state.balance, withdrawal_reserved_balance: state.reserved }] };
            }
            if (text.startsWith("INSERT INTO manual_withdrawal_requests")) {
                state.request = { reference: params[0], total: Number(params[3]), balanceDebitedAtRequest: false };
                return { rows: [] };
            }
            if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: ++state.journalId }] };
            if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }] };
            return { rows: [] };
        },
        release() {}
    };
    const pool = {
        connect: async () => client,
        query: async (sql) => {
            if (String(sql).includes("FROM wallets") && String(sql).includes("withdrawal_reserved_balance")) {
                return { rows: [{ id: 1, user_id: 12, balance: state.balance, locked_balance: 0, withdrawal_reserved_balance: state.reserved, currency: "KES" }] };
            }
            throw new Error("Unexpected pool query: " + String(sql));
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/wallet", walletRoutes(pool, (req, _res, next) => {
        req.user = { userId: 12, sessionId: "test-session", authVersion: 0 };
        next();
    }, {}, {}));
    const base = await serve(app, t);

    const response = await fetch(base + "/api/wallet/withdraw/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 100, phone: "0712345678" })
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.wallet.balance, 1000);
    assert.equal(body.wallet.reservedWithdrawalBalance, 100);
    assert.equal(body.wallet.availableBalance, 900);
    assert.equal(state.balance, 1000, "request creation must leave wallet balance unchanged");
    assert.equal(state.request.balanceDebitedAtRequest, false);

    const walletResponse = await fetch(base + "/api/wallet");
    const walletBody = await walletResponse.json();
    assert.equal(walletBody.wallet.balance, 1000);
    assert.equal(walletBody.wallet.availableBalance, 900);
});

function makeAdminWalletServer(state, t) {
    const previousIds = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = "39,40";
    t.after(() => {
        if (previousIds === undefined) delete process.env.ADMIN_USER_IDS;
        else process.env.ADMIN_USER_IDS = previousIds;
    });
    const client = {
        async query(sql, params = []) {
            const text = String(sql).replace(/\s+/g, " ").trim();
            if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
            if (text.startsWith("SELECT id,reference,user_id,total_amount,fee_amount,payout_amount,recipient_phone,status,funds_reserved,balance_debited_at_request")) {
                return { rows: [{ id: 7, reference: "WD-test", user_id: 12, total_amount: 100, fee_amount: 5, payout_amount: 95, recipient_phone: "254712345678", status: state.status, funds_reserved: true, balance_debited_at_request: false }] };
            }
            if (text.startsWith("SELECT id,reference,user_id,total_amount,status,funds_reserved,balance_debited_at_request")) {
                return { rows: [{ id: 7, reference: "WD-test", user_id: 12, total_amount: 100, status: state.status, funds_reserved: true, balance_debited_at_request: false }] };
            }
            if (text.startsWith("SELECT balance,withdrawal_reserved_balance FROM wallets")) return { rows: [{ balance: state.balance, withdrawal_reserved_balance: state.reserved }] };
            if (text.startsWith("UPDATE wallets") && text.includes("withdrawal_reserved_balance=withdrawal_reserved_balance-$1")) {
                const amount = Number(params[0]);
                if (state.reserved < amount) return { rows: [] };
                if (text.includes("balance=balance-CASE")) state.balance -= params[2] ? 0 : amount;
                if (text.includes("balance=balance+CASE")) state.balance += params[2] ? amount : 0;
                state.reserved -= amount;
                return { rows: [{ balance: state.balance, withdrawal_reserved_balance: state.reserved }] };
            }
            if (text.startsWith("UPDATE manual_withdrawal_requests")) {
                if (text.includes("SET status='completed'")) state.status = "completed";
                if (text.includes("SET status='cancelled'")) state.status = "cancelled";
                return { rows: [] };
            }
            if (text.startsWith("UPDATE transactions")) return { rows: [] };
            if (text.startsWith("SELECT id FROM users WHERE role='admin'")) return { rows: [{ id: 39 }] };
            if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
            if (text.startsWith("SELECT admin_id,balance,reserved_balance,currency FROM admin_wallets")) return { rows: [{ admin_id: 39, balance: 0, reserved_balance: 0, currency: "KES" }] };
            if (text.startsWith("UPDATE admin_wallets")) return { rows: [] };
            if (text.startsWith("INSERT INTO admin_wallet_transactions") || text.startsWith("INSERT INTO system_notifications")) return { rows: [] };
            if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: ++state.journalId }] };
            if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }] };
            return { rows: [] };
        },
        release() {}
    };
    const pool = {
        connect: async () => client,
        query: async (sql) => {
            if (String(sql).includes("SELECT id, username, role FROM users WHERE id = $1")) return { rows: [{ id: 39, username: "admin", role: "admin" }] };
            throw new Error("Unexpected admin pool query: " + String(sql));
        }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/admin/wallet", adminWalletRoutes(pool, (req, _res, next) => {
        req.user = { userId: 39 };
        next();
    }, null, null));
    return serve(app, t);
}

test("admin completion deducts a reserved manual withdrawal from wallet balance", async (t) => {
    const state = { balance: 1000, reserved: 100, status: "pending", journalId: 0 };
    const base = await makeAdminWalletServer(state, t);
    const response = await fetch(base + "/api/admin/wallet/manual-withdrawals/7/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(state.balance, 900);
    assert.equal(state.reserved, 0);
    assert.equal(state.status, "completed");
});

test("admin cancellation releases a pending reservation without changing wallet balance", async (t) => {
    const state = { balance: 1000, reserved: 100, status: "pending", journalId: 0 };
    const base = await makeAdminWalletServer(state, t);
    const response = await fetch(base + "/api/admin/wallet/manual-withdrawals/7/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(state.balance, 1000);
    assert.equal(state.reserved, 0);
});
