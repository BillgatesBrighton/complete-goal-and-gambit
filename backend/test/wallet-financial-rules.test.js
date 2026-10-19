"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rankedMatchPayout } = require("../services/rankedMatchPayout");
const { distributePrizePoolCents, settleEfootballCompetition } = require("../services/efootballpayouts");
const { recordJournal } = require("../services/financialLedger");
const { creditPlatform, debitPlatformAvailable } = require("../services/adminWalletAccounting");
const financialRateLimit = require("../middleware/financialRateLimit");

test("ranked match stakes use the configured winner amounts and return both stakes on a draw", () => {
    assert.deepEqual(rankedMatchPayout(20, "win"), { winner: 39, platform: 1, refundEach: 0 });
    assert.deepEqual(rankedMatchPayout(50, "win"), { winner: 90, platform: 10, refundEach: 0 });
    assert.deepEqual(rankedMatchPayout(100, "win"), { winner: 180, platform: 20, refundEach: 0 });
    assert.deepEqual(rankedMatchPayout(50, "draw"), { winner: null, refundEach: 50, platform: 0 });
    assert.throws(() => rankedMatchPayout(25, "win"), /unsupported/);
});

test("5:4:3 prize allocation is deterministic, cent exact, and retains shares without eligible finishers", () => {
    const split = distributePrizePoolCents(125000, 3);
    assert.deepEqual(split, { awards: [52083, 41667, 31250], retainedCents: 0 });
    assert.deepEqual(distributePrizePoolCents(125000, 3), split);
    assert.deepEqual(distributePrizePoolCents(120000, 2), { awards: [50000, 40000], retainedCents: 30000 });
    assert.deepEqual(distributePrizePoolCents(120000, 1), { awards: [50000], retainedCents: 70000 });
    assert.deepEqual(distributePrizePoolCents(120000, 0), { awards: [], retainedCents: 120000 });
});

test("financial ledger refuses unbalanced journals before writing any rows", async () => {
    const writes = [];
    const client = { async query(sql, params) { writes.push({ sql: String(sql), params }); return { rows: [{ id: 1 }] }; } };
    await assert.rejects(recordJournal(client, {
        reference: "bad-journal", transactionType: "test",
        postings: [
            { accountType: "user_wallet_available", accountId: 1, debit: 10 },
            { accountType: "admin_wallet_available", accountId: 9, credit: 9 }
        ]
    }), /must be equal/);
    assert.equal(writes.length, 0);
});

test("financial ledger posts a balanced journal only after all entries are inserted", async () => {
    const writes = [];
    const client = { async query(sql, params) {
        const text = String(sql).trim();
        writes.push(text);
        if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: 11 }] };
        if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }], rowCount: 1 };
        return { rows: [] };
    } };
    const result = await recordJournal(client, {
        reference: "balanced-journal", transactionType: "test_transfer",
        postings: [
            { accountType: "user_wallet_available", accountId: 4, debit: 12.5 },
            { accountType: "admin_wallet_available", accountId: 9, credit: 12.5 }
        ]
    });
    assert.equal(result.amount, 12.5);
    assert.equal(writes.filter((sql) => sql.startsWith("INSERT INTO financial_ledger_entries")).length, 2);
    assert.match(writes.at(-1), /^UPDATE financial_ledger_transactions SET posted_at/);
});

test("financial write limits are user-scoped and log a repeated burst once per window", () => {
    const limiter = financialRateLimit("test-action", { windowMs: 60000, max: 1 });
    const req = { ip: "127.0.0.1", baseUrl: "/api/wallet", path: "/withdraw", user: { userId: 23 } };
    const logs = [];
    const oldWarn = console.warn;
    console.warn = (...args) => logs.push(args);
    try {
        let allowed = false;
        limiter(req, { set() {}, status() { return this; }, json() {} }, () => { allowed = true; });
        assert.equal(allowed, true);
        const response = { code: 200, body: null, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        req.path = "/withdraw/manual";
        limiter(req, response, () => { throw new Error("limited financial request must not reach the handler"); });
        assert.equal(response.code, 429);
        assert.match(response.body.message, /financial requests/i);
        req.path = "/withdraw";
        limiter(req, response, () => {});
        assert.equal(logs.length, 1, "a burst generates one security log per identity and window");
        assert.match(logs[0][0], /Financial activity rate limit exceeded/);
    } finally {
        console.warn = oldWarn;
    }
});

test("entry-fee transfer debits the player and reserves the same amount across admin wallets", async () => {
    const state = {
        admins: [{ admin_id: 31, balance: 0, reserved_balance: 0 }, { admin_id: 32, balance: 0, reserved_balance: 0 }],
        adminTransactions: [], entries: [], nextJournalId: 1
    };
    const client = { async query(sql, params = []) {
        const text = String(sql).replace(/\s+/g, " ").trim();
        if (text === "SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE") return { rows: state.admins.map((row) => ({ id: row.admin_id })) };
        if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
        if (text.startsWith("SELECT admin_id,balance,reserved_balance,currency FROM admin_wallets")) {
            return { rows: state.admins.map((row) => ({ ...row, currency: "KES" })) };
        }
        if (text.startsWith("UPDATE admin_wallets SET balance=balance+")) {
            const wallet = state.admins.find((row) => row.admin_id === params[2]);
            wallet.balance += Number(params[0]); wallet.reserved_balance += Number(params[1]);
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith("INSERT INTO admin_wallet_transactions")) {
            state.adminTransactions.push({ adminId: params[0], amount: Number(params[2]), reference: params[3] });
            return { rows: [] };
        }
        if (text.startsWith("INSERT INTO financial_ledger_transactions")) return { rows: [{ id: state.nextJournalId++ }] };
        if (text.startsWith("INSERT INTO financial_ledger_entries")) {
            state.entries.push({ accountType: params[1], accountId: params[2], debit: Number(params[3]), credit: Number(params[4]) });
            return { rows: [] };
        }
        if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }] };
        throw new Error("Unexpected entry-fee test query: " + text);
    } };
    const allocations = await creditPlatform(client, {
        amount: 100.01, reference: "league-entry-once", transactionType: "league_entry_fee",
        reserve: true, context: { competitionId: 6, userId: 5 },
        debitPostings: [{ accountType: "user_wallet_available", accountId: 5, debit: 100.01 }]
    });
    assert.deepEqual(allocations, [{ adminId: 31, cents: 5001 }, { adminId: 32, cents: 5000 }]);
    assert.deepEqual(state.admins.map((row) => row.reserved_balance), [50.01, 50]);
    assert.equal(Math.round(state.adminTransactions.reduce((sum, row) => sum + row.amount, 0) * 100), 10001);
    assert.equal(state.entries.reduce((sum, entry) => sum + entry.debit, 0).toFixed(2), "100.01");
    assert.equal(state.entries.reduce((sum, entry) => sum + entry.credit, 0).toFixed(2), "100.01");
});

test("competition prizes are held when the available admin-wallet pool is insufficient", async () => {
    let balanceWrites = 0;
    const client = { async query(sql) {
        const text = String(sql).replace(/\s+/g, " ").trim();
        if (text === "SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE") return { rows: [{ id: 31 }] };
        if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
        if (text.startsWith("SELECT admin_id,balance,reserved_balance,currency FROM admin_wallets")) return { rows: [{ admin_id: 31, balance: 15, reserved_balance: 5, currency: "KES" }] };
        if (text.startsWith("UPDATE admin_wallets")) balanceWrites += 1;
        throw new Error("Unexpected insufficient-pool query: " + text);
    } };
    await assert.rejects(debitPlatformAvailable(client, { amount: 11, reference: "unfunded-award", transactionType: "competition_prize_paid" }),
        (error) => error.status === 409 && error.code === "INSUFFICIENT_PLATFORM_FUNDS");
    assert.equal(balanceWrites, 0);
});

function makeSettlementHarness(members) {
    const state = { settled: false, settlementRows: [], transactions: [], journals: [], entries: [], adminBalances: [500, 500] };
    const admins = [{ id: 91 }, { id: 92 }];
    const client = {
        async query(sql, params = []) {
            const text = String(sql).replace(/\s+/g, " ").trim();
            if (text.startsWith("SELECT 1 FROM efootball_competition_settlements")) return { rows: state.settled ? [{ "1": 1 }] : [] };
            if (text.startsWith("SELECT m.user_id,u.username,m.fee_paid")) return { rows: members };
            if (text.startsWith("SELECT user_id FROM wallets WHERE user_id=ANY")) return { rows: params[0].map((user_id) => ({ user_id })) };
            if (text === "SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE") return { rows: admins };
            if (text.startsWith("INSERT INTO admin_wallets")) return { rows: [] };
            if (text.startsWith("SELECT admin_id,balance,reserved_balance,currency FROM admin_wallets")) {
                return { rows: admins.map((admin, index) => ({ admin_id: admin.id, balance: state.adminBalances[index], reserved_balance: 0, currency: "KES" })) };
            }
            if (text.startsWith("UPDATE wallets SET balance=balance+")) return { rows: [], rowCount: 1 };
            if (text.startsWith("INSERT INTO efootball_competition_settlements")) {
                state.settlementRows.push({ text, params });
                if (state.settlementRows.length === members.length) state.settled = true;
                return { rows: [] };
            }
            if (text.startsWith("UPDATE efootball_competition_settlements SET retained_revenue")) {
                state.retained = Number(params[0]);
                return { rows: [], rowCount: 1 };
            }
            if (text.startsWith("INSERT INTO transactions")) { state.transactions.push(params); return { rows: [] }; }
            if (text.startsWith("UPDATE admin_wallets SET balance=balance-")) return { rows: [], rowCount: 1 };
            if (text.startsWith("INSERT INTO admin_wallet_transactions")) return { rows: [] };
            if (text.startsWith("INSERT INTO financial_ledger_transactions")) {
                state.journals.push({ reference: params[0], type: params[1], amount: Number(params[2]), context: JSON.parse(params[4]) });
                return { rows: [{ id: state.journals.length }] };
            }
            if (text.startsWith("INSERT INTO financial_ledger_entries")) {
                state.entries.push({ accountType: params[1], accountId: params[2], debit: Number(params[3]), credit: Number(params[4]) });
                return { rows: [] };
            }
            if (text.startsWith("UPDATE financial_ledger_transactions SET posted_at")) return { rows: [{ id: params[0] }], rowCount: 1 };
            if (text.startsWith("UPDATE efootball_competition_settlements")) return { rows: [], rowCount: 1 };
            throw new Error("Unexpected settlement test query: " + text.slice(0, 160));
        }
    };
    return { client, state };
}

function competitionMember(userId, username, fee, played, points) {
    return {
        user_id: userId, username, fee_paid: fee, fee_transferred: true, entry_reference: null,
        forfeited_at: null, played, wins: points, draws: 0, losses: 0, points,
        goal_difference: points, goals_for: points, goals_against: 0
    };
}

test("competition settlement pays the actual pool once, records retained share, and issues no refunds", async () => {
    const members = [
        competitionMember(1, "first", 100.01, 1, 3),
        competitionMember(2, "second", 100.01, 1, 2),
        competitionMember(3, "third", 100.01, 1, 1)
    ];
    const { client, state } = makeSettlementHarness(members);
    const competition = { id: 7, name: "Practice League", status: "completed" };
    const first = await settleEfootballCompetition(client, "league", competition, "season-1");
    assert.equal(first.pool, 300.03);
    assert.deepEqual(first.awards.map((award) => award.amount), [125.01, 100.01, 75.01]);
    assert.equal(first.retainedRevenue, 0);
    assert(state.settlementRows.every((row) => row.text.includes("$8,0,0,$9")), "every settlement row must have zero refunds and retained revenue until classified");
    assert.equal(state.transactions.filter((row) => String(row[1]).includes("refund")).length, 0);
    assert.equal(state.journals.length, 1);
    assert.equal(state.entries.reduce((sum, entry) => sum + entry.debit, 0).toFixed(2), state.entries.reduce((sum, entry) => sum + entry.credit, 0).toFixed(2));

    const second = await settleEfootballCompetition(client, "league", competition, "season-1");
    assert.deepEqual(second, { alreadySettled: true });
    assert.equal(state.settlementRows.length, 3, "an idempotent retry must not create more settlements");
});

test("competition settlement retains unused podium shares rather than refunding them", async () => {
    const members = [
        competitionMember(1, "winner", 100, 1, 3),
        competitionMember(2, "inactive-a", 100, 0, 0),
        competitionMember(3, "inactive-b", 100, 0, 0)
    ];
    const { client, state } = makeSettlementHarness(members);
    const result = await settleEfootballCompetition(client, "tournament", { id: 8, name: "Open Cup", status: "completed" }, "season-2");
    assert.deepEqual(result.awards, [{ userId: 1, rank: 1, amount: 125 }]);
    assert.equal(result.pool, 300);
    assert.equal(result.retainedRevenue, 175);
    assert.equal(state.retained, 175);
    assert(state.settlementRows.every((row) => row.text.includes("$8,0,0,$9")), "the unused pool must not become participant refunds");
    assert.equal(state.journals[0].context.retainedRevenue, 175);
    assert.equal(state.transactions.filter((row) => String(row[1]).includes("refund")).length, 0);
});
