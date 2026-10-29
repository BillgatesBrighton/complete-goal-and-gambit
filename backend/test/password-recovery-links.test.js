"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcrypt");
const createPasswordRecoveryRoutes = require("../routes/passwordRecovery");

function createMemoryPool() {
    const users = new Map([
        ["one", { id: 11, username: "one", phone: "+254700000011", account_status: "active", auth_version: 2, password_hash: "before-one" }],
        ["two", { id: 22, username: "two", phone: "+254700000022", account_status: "active", auth_version: 4, password_hash: "before-two" }]
    ]);
    const requests = new Map();
    let transactionTail = Promise.resolve();

    const pool = {
        users,
        requests,
        async query(sql, params) {
            const statement = String(sql);
            if (/SELECT status,secret_hash,expires_at,approval_expires_at/i.test(statement)) {
                const row = requests.get(String(params[0]));
                return { rows: row ? [{
                    status: row.status,
                    secret_hash: row.secret_hash,
                    expires_at: row.expires_at,
                    approval_expires_at: row.approval_expires_at
                }] : [] };
            }
            throw new Error("Unexpected pool query: " + statement);
        },
        async connect() {
            let unlockTransaction = null;
            return {
                async query(sql, params) {
                    const statement = String(sql).trim();
                    if (statement === "BEGIN") {
                        const previous = transactionTail;
                        transactionTail = new Promise((resolve) => { unlockTransaction = resolve; });
                        await previous;
                        return { rows: [] };
                    }
                    if (statement === "COMMIT" || statement === "ROLLBACK") {
                        if (unlockTransaction) unlockTransaction();
                        return { rows: [] };
                    }
                    if (/SELECT id, phone FROM users WHERE username=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                        const user = users.get(String(params[0]));
                        return { rows: user ? [{ id: user.id, phone: user.phone }] : [] };
                    }
                    if (/UPDATE password_recovery_requests\s+SET status='expired',secret_hash=\$1\s+WHERE user_id=\$2/i.test(statement)) {
                        for (const row of requests.values()) {
                            if (row.user_id === Number(params[1]) && ["pending", "approved"].includes(row.status)) {
                                row.status = "expired";
                                row.secret_hash = params[0];
                            }
                        }
                        return { rows: [] };
                    }
                    if (/INSERT INTO password_recovery_requests/i.test(statement)) {
                        const [id, userId, username, phone, secretHash] = params;
                        requests.set(String(id), {
                            id: String(id), user_id: Number(userId), requested_username: username,
                            submitted_phone: phone, secret_hash: secretHash, status: "pending",
                            expires_at: new Date(Date.now() + 30 * 60 * 1000), approval_expires_at: null,
                            auth_version_at_approval: null
                        });
                        return { rows: [] };
                    }
                    if (/SELECT id,user_id,status,secret_hash,expires_at,approval_expires_at,auth_version_at_approval\s+FROM password_recovery_requests WHERE id=\$1 FOR UPDATE/i.test(statement)) {
                        const row = requests.get(String(params[0]));
                        return { rows: row ? [{ ...row }] : [] };
                    }
                    if (/SELECT id,auth_version FROM users WHERE id=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                        const user = Array.from(users.values()).find((entry) => entry.id === Number(params[0]));
                        return { rows: user ? [{ id: user.id, auth_version: user.auth_version }] : [] };
                    }
                    if (/UPDATE users SET password_hash=\$1,auth_version=auth_version\+1 WHERE id=\$2/i.test(statement)) {
                        const user = Array.from(users.values()).find((entry) => entry.id === Number(params[1]));
                        if (user) { user.password_hash = params[0]; user.auth_version += 1; }
                        return { rows: [] };
                    }
                    if (/UPDATE password_reset_codes SET consumed_at=NOW\(\)/i.test(statement)) return { rows: [] };
                    if (/UPDATE password_recovery_requests SET status='completed',completed_at=NOW\(\),secret_hash=\$1 WHERE id=\$2/i.test(statement)) {
                        const row = requests.get(String(params[1]));
                        if (row) { row.status = "completed"; row.secret_hash = params[0]; }
                        return { rows: [] };
                    }
                    throw new Error("Unexpected client query: " + statement);
                },
                release() {}
            };
        }
    };
    return pool;
}

async function submitRecoveryRequest(server, username, phone) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/auth/password-recovery/request", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, phone }).toString()
    });
    const location = response.headers.get("location");
    assert.equal(response.status, 303);
    assert.ok(location, "request redirects to the configured recovery page");
    assert.equal(await response.text(), "", "the response body does not echo the raw token");
    const url = new URL(location);
    const fragment = new URLSearchParams(url.hash.slice(1));
    assert.equal(url.origin + url.pathname, "https://play.example/pages/password-recovery.html");
    return { ticketId: fragment.get("ticket"), secret: fragment.get("secret") };
}

async function postJson(server, path, body) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
}

test("password recovery issues private unique links and consumes them once", async (t) => {
    const pool = createMemoryPool();
    const app = express();
    app.use(express.json());
    app.use("/api/auth/password-recovery", createPasswordRecoveryRoutes(pool, {
        frontendUrl: "https://play.example/pages/password-recovery.html"
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const firstUserLink = await submitRecoveryRequest(server, "one", "0700000011");
    const secondUserLink = await submitRecoveryRequest(server, "two", "0700000022");
    assert.match(firstUserLink.ticketId, /^[0-9a-f-]{36}$/i);
    assert.match(firstUserLink.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(firstUserLink.secret, secondUserLink.secret, "different accounts receive distinct random tokens");
    assert.notEqual(firstUserLink.ticketId, secondUserLink.ticketId);

    const firstRow = pool.requests.get(firstUserLink.ticketId);
    const secondRow = pool.requests.get(secondUserLink.ticketId);
    assert.ok(firstRow && secondRow);
    assert.notEqual(firstRow.secret_hash, firstUserLink.secret, "only the token hash is persisted");
    assert.equal(firstRow.status, "pending");

    const wrongUserAttempt = await postJson(server, "/api/auth/password-recovery/complete", {
        ticketId: firstUserLink.ticketId, secret: secondUserLink.secret, newPassword: "new-password-one"
    });
    assert.equal(wrongUserAttempt.status, 400, "a different user's link cannot reset this account");
    assert.equal(pool.users.get("one").auth_version, 2);

    const replacementLink = await submitRecoveryRequest(server, "one", "0700000011");
    assert.notEqual(replacementLink.secret, firstUserLink.secret);
    assert.equal(firstRow.status, "expired", "a new request invalidates older outstanding recovery tokens");
    const oldLinkAttempt = await postJson(server, "/api/auth/password-recovery/complete", {
        ticketId: firstUserLink.ticketId, secret: firstUserLink.secret, newPassword: "new-password-one"
    });
    assert.equal(oldLinkAttempt.status, 400);

    const replacementRow = pool.requests.get(replacementLink.ticketId);
    pool.users.get("one").password_hash = await bcrypt.hash("old-password-one", 12);
    replacementRow.status = "approved";
    replacementRow.approval_expires_at = new Date(Date.now() + 30 * 60 * 1000);
    replacementRow.auth_version_at_approval = pool.users.get("one").auth_version;
    const pendingStatus = await postJson(server, "/api/auth/password-recovery/status", replacementLink);
    assert.equal(pendingStatus.body.status, "approved");

    const validReset = await postJson(server, "/api/auth/password-recovery/complete", {
        ...replacementLink, newPassword: "new-password-one"
    });
    assert.equal(validReset.status, 200);
    assert.equal(pool.users.get("one").auth_version, 3);
    assert.equal(await bcrypt.compare("new-password-one", pool.users.get("one").password_hash), true);
    assert.equal(await bcrypt.compare("old-password-one", pool.users.get("one").password_hash), false);

    const reusedLink = await postJson(server, "/api/auth/password-recovery/complete", {
        ...replacementLink, newPassword: "another-password"
    });
    assert.equal(reusedLink.status, 400, "a consumed link cannot be reused");

    secondRow.expires_at = new Date(Date.now() - 1000);
    const expiredStatus = await postJson(server, "/api/auth/password-recovery/status", secondUserLink);
    assert.equal(expiredStatus.body.status, "expired", "expired recovery links are rejected");
    const expiredReset = await postJson(server, "/api/auth/password-recovery/complete", {
        ...secondUserLink, newPassword: "new-password-two"
    });
    assert.equal(expiredReset.status, 400);

    const mismatchedRequest = await submitRecoveryRequest(server, "one", "0700000099");
    assert.equal(pool.requests.has(mismatchedRequest.ticketId), false, "mismatched details do not create a recovery request");
    const genericState = await postJson(server, "/api/auth/password-recovery/status", mismatchedRequest);
    assert.equal(genericState.status, 200);
    assert.equal(genericState.body.status, "pending", "public status does not confirm whether an account matched");
});

test("the existing recovery page submits without exposing its token through JSON", () => {
    const htmlPath = path.join(__dirname, "../../frontend/pages/password-recovery.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
    assert.ok(inlineScript, "recovery page has its inline workflow script");
    assert.doesNotThrow(() => new Function(inlineScript[1]), "recovery page script parses");
    assert.match(html, /name="username"/);
    assert.match(html, /name="phone"/);
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /HTMLFormElement\.prototype\.submit\.call\(requestForm\)/);
    assert.doesNotMatch(html, /AFRICASTALKING|sendSms|verification code/i);
});

test("simultaneous submissions cannot consume one recovery link twice", async (t) => {
    const pool = createMemoryPool();
    const app = express();
    app.use(express.json());
    app.use("/api/auth/password-recovery", createPasswordRecoveryRoutes(pool, {
        frontendUrl: "https://play.example/pages/password-recovery.html"
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const link = await submitRecoveryRequest(server, "two", "0700000022");
    const row = pool.requests.get(link.ticketId);
    row.status = "approved";
    row.approval_expires_at = new Date(Date.now() + 30 * 60 * 1000);
    row.auth_version_at_approval = pool.users.get("two").auth_version;

    const attempts = await Promise.all([
        postJson(server, "/api/auth/password-recovery/complete", { ...link, newPassword: "winner-password" }),
        postJson(server, "/api/auth/password-recovery/complete", { ...link, newPassword: "loser-password" })
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 400]);
    assert.equal(pool.users.get("two").auth_version, 5);
    assert.equal(
        await bcrypt.compare("winner-password", pool.users.get("two").password_hash) ||
        await bcrypt.compare("loser-password", pool.users.get("two").password_hash),
        true
    );
});

test("password reset reports a safe unavailable response when PostgreSQL connection acquisition fails", async (t) => {
    const app = express();
    app.use(express.json());
    app.use("/api/auth/password-recovery", createPasswordRecoveryRoutes({
        async connect() {
            throw new Error("diagnostic PostgreSQL connection timeout");
        }
    }, {
        frontendUrl: "https://play.example/pages/password-recovery.html"
    }));
    app.use(function(_error, _req, res, _next) {
        res.status(500).json({ success: false, message: "Internal server error." });
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const result = await postJson(server, "/api/auth/password-recovery/complete", {
        ticketId: "00000000-0000-4000-8000-000000000000",
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        newPassword: "diagnostic-invalid"
    });

    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
        success: false,
        message: "Could not reset the password. Please contact support and try again."
    });
    assert.doesNotMatch(JSON.stringify(result.body), /diagnostic|PostgreSQL|timeout|stack/i);
});
