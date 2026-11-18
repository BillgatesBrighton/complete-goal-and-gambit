"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");

process.env.ADMIN_USER_IDS = "39,40";
process.env.BUSINESS_TIME_ZONE = "Africa/Nairobi";
process.env.CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID = "admin-redesign-test";
process.env.CHAT_DATA_ENCRYPTION_KEYS = JSON.stringify({
    "admin-redesign-test": crypto.randomBytes(32).toString("base64")
});

const { encryptMessage } = require("../services/chatEncryption");
const adminRoutes = require("../routes/admin");

const playerId = 41;
const threadId = 91;
const supportMessage = "Private support message for read-only history.";
const sealedMessage = encryptMessage(supportMessage);
const messageRow = {
    id: 120,
    thread_id: threadId,
    sender_id: playerId,
    username: "sample-player",
    created_at: new Date("2026-11-18T10:00:00.000Z"),
    read_at: null,
    client_message_id: null,
    ...sealedMessage
};
const observedSql = [];
const auditEvents = [];
const resultEvents = [];

const pool = {
    async query(sql, params) {
        sql = String(sql);
        observedSql.push(sql);
        if (/SELECT id, username, role FROM users WHERE id = \$1/i.test(sql)) {
            return { rows: [{ id: 39, username: "test-admin", role: "admin" }] };
        }
        if (/SELECT id,username FROM users WHERE id=\$1/i.test(sql)) {
            return { rows: [{ id: playerId, username: "sample-player" }] };
        }
        if (sql.includes("FROM chat_threads WHERE thread_type='support'")) {
            return { rows: [{ id: threadId, created_at: new Date("2026-11-18T09:00:00.000Z"), support_category: "technical", support_subject: "Test case", support_status: "open" }] };
        }
        if (sql.includes("COUNT(*)::int AS total FROM chat_messages")) return { rows: [{ total: 1 }] };
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM chat_messages")) return { rows: [{ has_older: false }] };
        if (sql.includes("FROM chat_messages m")) return { rows: [messageRow] };
        if (sql.includes("SELECT COUNT(*)::int AS total FROM users u")) return { rows: [{ total: 1 }] };
        if (sql.includes("SELECT u.id,u.username,u.game,u.rating")) {
            return { rows: [{ id: playerId, username: "sample-player", game: "chess", rating: 700, account_status: "active", created_at: new Date("2026-11-18T08:00:00.000Z"), chess_completed: 2, efootball_completed: 0, last_game_at: null }] };
        }
        if (sql.includes("WITH bounds AS") && sql.includes("date_trunc($3")) return { rows: [] };
        if (sql.includes("WITH bounds AS")) return { rows: [{ deposits: "100.00", prizes_paid: "0.00", withdrawals: "0.00", refunds: "0.00", retained_revenue: "0.00", actual_expenses: "0.00", provider_payouts: "0.00", journal_count: 1 }] };
        if (sql.includes("FROM admin_wallets")) return { rows: [{ available: "50.00", reserved: "10.00" }] };
        throw new Error("Unexpected admin redesign query: " + sql.slice(0, 140));
    },
    async connect() {
        return {
            async query(sql, params) {
                sql = String(sql);
                observedSql.push(sql);
                if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
                if (sql.includes("INSERT INTO admin_chat_history_audit_events")) {
                    auditEvents.push(params);
                    return { rows: [] };
                }
                if (sql.includes("SELECT v.id AS verification_id")) {
                    return { rows: [{ verification_id: 72, verification_status: "review_required", screenshot_path: "evidence.jpg", match_id: 82, match_status: "disputed", creator_id: 41, opponent_id: 42, stake_amount: 100, mode: "ranked", league: null, tournament_id: null }] };
                }
                if (sql.startsWith("UPDATE efootball_result_verifications")) return { rows: [] };
                if (sql.startsWith("UPDATE efootball_matches SET status='disputed'")) return { rows: [] };
                if (sql.includes("SELECT id,status FROM complaints")) return { rows: [] };
                if (sql.includes("INSERT INTO efootball_result_admin_events")) {
                    resultEvents.push(params);
                    return { rows: [] };
                }
                throw new Error("Unexpected admin redesign transaction: " + sql.slice(0, 140));
            },
            release() {}
        };
    }
};

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes(
    pool,
    (req, _res, next) => { req.user = { userId: 39, username: "test-admin", role: "admin" }; next(); },
    () => [],
    null,
    null,
    { getAdminPresence: () => "online" }
));

let server;
let base;
test.before(async () => {
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    base = "http://127.0.0.1:" + server.address().port + "/api/admin";
});
test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

test("directory omits contact data and finance returns ledger categories without a profit estimate", async () => {
    const directory = await fetch(base + "/users?search=sample&page=1&limit=40&status=active&game=chess");
    assert.equal(directory.status, 200);
    const directoryBody = await directory.json();
    assert.equal(directoryBody.users[0].presence, "online");
    assert.equal(Object.hasOwn(directoryBody.users[0], "phone"), false);
    assert.equal(Object.hasOwn(directoryBody.users[0], "email"), false);

    const finance = await fetch(base + "/finance/summary?period=daily");
    assert.equal(finance.status, 200);
    const financeBody = await finance.json();
    assert.equal(financeBody.summary.deposits, "100.00");
    assert.equal(Object.hasOwn(financeBody.summary, "profit"), false);
    assert.equal(Object.hasOwn(financeBody, "profit"), false);
    assert.equal(financeBody.timeZone, "Africa/Nairobi");
});

test("chat history decrypts read-only, hashes exports, and records immutable audit events", async () => {
    const view = await fetch(base + "/users/" + playerId + "/chat-history");
    assert.equal(view.status, 200);
    const viewBody = await view.json();
    assert.equal(viewBody.messages[0].message, supportMessage);
    assert.deepEqual(viewBody.messages[0].attachments, []);
    assert.equal(viewBody.messages[0].read_at, null);

    const exportResponse = await fetch(base + "/users/" + playerId + "/chat-history/export?format=json");
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("cache-control"), "private, no-store");
    const exportBytes = Buffer.from(await exportResponse.arrayBuffer());
    const digest = crypto.createHash("sha256").update(exportBytes).digest("hex");
    assert.equal(exportResponse.headers.get("x-evidence-sha256"), digest);
    const archive = JSON.parse(exportBytes.toString("utf8"));
    assert.equal(archive.messages[0].message, supportMessage);
    assert.equal(archive.integrity.algorithm, "SHA-256");

    const pdfResponse = await fetch(base + "/users/" + playerId + "/chat-history/export?format=pdf");
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get("content-type"), /application\/pdf/);
    const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString("ascii"), "%PDF-");
    const pdfDigest = crypto.createHash("sha256").update(pdfBytes).digest("hex");
    assert.equal(pdfResponse.headers.get("x-evidence-sha256"), pdfDigest);

    assert.equal(auditEvents.filter((event) => event[3] === "view").length, 1);
    assert.equal(auditEvents.filter((event) => event[3] === "export" && event[4] === "json" && event[5] === digest).length, 1);
    assert.equal(auditEvents.filter((event) => event[3] === "export" && event[4] === "pdf" && event[5] === pdfDigest).length, 1);
    assert.equal(observedSql.some((sql) => /UPDATE\s+chat_messages\s+SET\s+read_at/i.test(sql)), false);
});

test("rejecting evidence requires a reason and records investigation without touching funds", async () => {
    const missingReason = await fetch(base + "/result-verifications/72/review", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject" })
    });
    assert.equal(missingReason.status, 400);

    const reject = await fetch(base + "/result-verifications/72/review", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject", reason: "Evidence does not show the final score." })
    });
    assert.equal(reject.status, 200);
    const result = await reject.json();
    assert.match(result.message, /remain locked/);
    const event = resultEvents.at(-1);
    assert.equal(event[2], "review_required");
    assert.equal(event[3], "Evidence does not show the final score.");
    assert.equal(JSON.parse(event[4]).financialDisposition, "unchanged_locked");
    assert.equal(observedSql.some((sql) => sql.includes("'rejected'")), true);
    assert.equal(observedSql.some((sql) => /(?:UPDATE|INSERT INTO)\s+(?:wallets|financial_ledger_transactions|financial_ledger_entries)/i.test(sql)), false);
});
