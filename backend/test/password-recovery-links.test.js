"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const createAuthRoutes = require("../routes/auth");
const createPasswordRecoveryRoutes = require("../routes/passwordRecovery");

const FRONTEND_RESET = "https://play.example/pages/password-recovery.html";
const FRONTEND_VERIFY = "https://play.example/pages/verify-email.html";
const JWT_SECRET_FOR_TEST = "focused-email-recovery-test-secret-not-for-production";

function clone(value) {
    return value ? { ...value } : value;
}

function createMemoryPool() {
    const users = new Map();
    const verificationRequests = new Map();
    const recoveryRequests = new Map();
    let nextUserId = 30;
    let nextWalletUserId = null;

    async function addUser({ id, username, phone, email, verified, password }) {
        users.set(id, {
            id,
            username,
            phone,
            email: email || null,
            email_verified_at: verified ? new Date() : null,
            password_hash: await bcrypt.hash(password, 4),
            rating: 1200,
            game: "both",
            role: "user",
            account_status: "active",
            suspended_until: null,
            auth_version: 0,
            created_at: new Date()
        });
    }

    function findUserByUsername(username) {
        return Array.from(users.values()).find((user) => user.username === username);
    }

    function findUserById(id) {
        return users.get(Number(id));
    }

    async function query(sql, params) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        if (/SELECT\s+id,\s*username,\s*phone,\s*password_hash/i.test(statement) && /FROM users WHERE username = \$1/i.test(statement)) {
            const user = findUserByUsername(params[0]);
            return { rows: user ? [clone(user)] : [] };
        }
        if (/SELECT status,secret_hash,expires_at,approval_expires_at FROM password_recovery_requests/i.test(statement)) {
            const row = recoveryRequests.get(String(params[0]));
            return { rows: row ? [{ status: row.status, secret_hash: row.secret_hash, expires_at: row.expires_at, approval_expires_at: row.approval_expires_at }] : [] };
        }
        throw new Error("Unexpected memory-pool query: " + statement);
    }

    async function connect() {
        const client = {
            async query(sql, params) {
                const statement = String(sql).replace(/\s+/g, " ").trim();
                params = params || [];
                if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };

                if (/SELECT id FROM users WHERE username = \$1 OR phone = \$2 OR \(LOWER\(email\) = \$3 AND email_verified_at IS NOT NULL\) LIMIT 1/i.test(statement)) {
                    const match = Array.from(users.values()).some((user) =>
                        user.username === params[0] || user.phone === params[1] ||
                        (user.email_verified_at && String(user.email || "").toLowerCase() === params[2])
                    );
                    return { rows: match ? [{ id: 1 }] : [] };
                }
                if (/INSERT INTO users/i.test(statement)) {
                    const [username, phone, email, passwordHash, rating, game] = params;
                    const id = nextUserId++;
                    const user = {
                        id, username, phone, email, email_verified_at: null,
                        password_hash: passwordHash, rating, game, role: "user",
                        account_status: "active", suspended_until: null,
                        auth_version: 0, created_at: new Date()
                    };
                    users.set(id, user);
                    nextWalletUserId = id;
                    return { rows: [clone(user)] };
                }
                if (/INSERT INTO email_verification_requests/i.test(statement)) {
                    const [id, userId, email, tokenHash] = params;
                    verificationRequests.set(String(id), {
                        id: String(id), user_id: Number(userId), email,
                        token_hash: tokenHash, expires_at: new Date(Date.now() + 30 * 60 * 1000),
                        consumed_at: null
                    });
                    return { rows: [] };
                }
                if (/INSERT INTO wallets/i.test(statement)) {
                    assert.equal(Number(params[0]), nextWalletUserId, "registration creates the wallet for its new account");
                    return { rows: [] };
                }
                if (/SELECT id,user_id,email,token_hash,expires_at,consumed_at FROM email_verification_requests WHERE id=\$1 FOR UPDATE/i.test(statement)) {
                    const row = verificationRequests.get(String(params[0]));
                    return { rows: row ? [clone(row)] : [] };
                }
                if (/SELECT id,username,email,email_verified_at FROM users WHERE id=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                    const user = findUserById(params[0]);
                    return { rows: user && user.account_status === "active" ? [clone(user)] : [] };
                }
                if (/UPDATE users SET email=\$1,email_verified_at=NOW\(\) WHERE id=\$2 AND account_status='active' RETURNING email_verified_at/i.test(statement)) {
                    const [email, userId] = params;
                    const user = findUserById(userId);
                    const otherVerifiedUser = Array.from(users.values()).find((candidate) =>
                        candidate.id !== Number(userId) && candidate.email_verified_at &&
                        String(candidate.email || "").toLowerCase() === String(email).toLowerCase()
                    );
                    if (otherVerifiedUser) {
                        const error = new Error("unique verified email");
                        error.code = "23505";
                        error.constraint = "idx_users_verified_email_unique_lower";
                        throw error;
                    }
                    user.email = email;
                    user.email_verified_at = new Date();
                    return { rows: [{ email_verified_at: user.email_verified_at }] };
                }
                if (/UPDATE email_verification_requests SET consumed_at=NOW\(\) WHERE user_id=\$1 AND consumed_at IS NULL/i.test(statement)) {
                    for (const row of verificationRequests.values()) {
                        if (row.user_id === Number(params[0]) && !row.consumed_at) row.consumed_at = new Date();
                    }
                    return { rows: [] };
                }
                if (/SELECT id,username,email,email_verified_at,password_hash FROM users WHERE id=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                    const user = findUserById(params[0]);
                    return { rows: user && user.account_status === "active" ? [clone(user)] : [] };
                }
                if (/SELECT id FROM users WHERE LOWER\(email\)=\$1 AND email_verified_at IS NOT NULL AND id<>\$2 LIMIT 1/i.test(statement)) {
                    const user = Array.from(users.values()).find((candidate) => candidate.id !== Number(params[1]) &&
                        candidate.email_verified_at && String(candidate.email || "").toLowerCase() === params[0]);
                    return { rows: user ? [{ id: user.id }] : [] };
                }
                if (/SELECT id,phone,email,email_verified_at,auth_version FROM users WHERE username=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                    const user = findUserByUsername(params[0]);
                    return { rows: user && user.account_status === "active" ? [clone(user)] : [] };
                }
                if (/UPDATE password_recovery_requests SET status='expired',secret_hash=\$1 WHERE user_id=\$2 AND status IN \('pending','approved'\)/i.test(statement)) {
                    for (const row of recoveryRequests.values()) {
                        if (row.user_id === Number(params[1]) && ["pending", "approved"].includes(row.status)) {
                            row.status = "expired";
                            row.secret_hash = params[0];
                        }
                    }
                    return { rows: [] };
                }
                if (/INSERT INTO password_recovery_requests/i.test(statement)) {
                    const [id, userId, username, phone, secretHash, authVersion] = params;
                    const expiry = new Date(Date.now() + 30 * 60 * 1000);
                    recoveryRequests.set(String(id), {
                        id: String(id), user_id: Number(userId), requested_username: username,
                        submitted_phone: phone, secret_hash: secretHash, status: "approved",
                        expires_at: expiry, approval_expires_at: expiry,
                        auth_version_at_approval: Number(authVersion), completed_at: null
                    });
                    return { rows: [] };
                }
                if (/SELECT id,user_id,status,secret_hash,expires_at,approval_expires_at,auth_version_at_approval FROM password_recovery_requests WHERE id=\$1 FOR UPDATE/i.test(statement)) {
                    const row = recoveryRequests.get(String(params[0]));
                    return { rows: row ? [clone(row)] : [] };
                }
                if (/SELECT id,username,phone,rating,game,role,account_status,auth_version,email,email_verified_at,created_at FROM users WHERE id=\$1 AND account_status='active' FOR UPDATE/i.test(statement)) {
                    const user = findUserById(params[0]);
                    return { rows: user && user.account_status === "active" ? [clone(user)] : [] };
                }
                if (/UPDATE users SET password_hash=\$1,auth_version=auth_version\+1 WHERE id=\$2 RETURNING/i.test(statement)) {
                    const [passwordHash, userId] = params;
                    const user = findUserById(userId);
                    user.password_hash = passwordHash;
                    user.auth_version += 1;
                    return { rows: [clone(user)] };
                }
                if (/UPDATE password_reset_codes SET consumed_at=NOW\(\) WHERE user_id=\$1/i.test(statement)) return { rows: [] };
                if (/UPDATE password_recovery_requests SET status='expired',secret_hash=\$1 WHERE user_id=\$2 AND id<>\$3 AND status IN \('pending','approved'\)/i.test(statement)) {
                    for (const row of recoveryRequests.values()) {
                        if (row.user_id === Number(params[1]) && row.id !== String(params[2]) && ["pending", "approved"].includes(row.status)) {
                            row.status = "expired";
                            row.secret_hash = params[0];
                        }
                    }
                    return { rows: [] };
                }
                if (/UPDATE email_verification_requests SET consumed_at=NOW\(\) WHERE user_id=\$1 AND consumed_at IS NULL/i.test(statement)) {
                    for (const row of verificationRequests.values()) {
                        if (row.user_id === Number(params[0]) && !row.consumed_at) row.consumed_at = new Date();
                    }
                    return { rows: [] };
                }
                if (/UPDATE password_recovery_requests SET status='completed',completed_at=NOW\(\),secret_hash=\$1 WHERE id=\$2/i.test(statement)) {
                    const row = recoveryRequests.get(String(params[1]));
                    if (row) {
                        row.status = "completed";
                        row.completed_at = new Date();
                        row.secret_hash = params[0];
                    }
                    return { rows: [] };
                }
                throw new Error("Unexpected memory-client query: " + statement);
            },
            release() {}
        };
        return client;
    }

    return { users, verificationRequests, recoveryRequests, query, connect, addUser };
}

async function postJson(server, endpoint, body, headers) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(headers || {}) },
        body: JSON.stringify(body || {})
    });
    return { status: response.status, body: await response.json() };
}

function fragmentValues(link) {
    return new URLSearchParams(new URL(link).hash.slice(1));
}

test("registration, email verification, and verified-email password recovery are secure end to end", async (t) => {
    const previousEnv = {
        JWT_SECRET: process.env.JWT_SECRET,
        EMAIL_VERIFICATION_FRONTEND_URL: process.env.EMAIL_VERIFICATION_FRONTEND_URL,
        PASSWORD_RESET_FRONTEND_URL: process.env.PASSWORD_RESET_FRONTEND_URL,
        ADMIN_USER_IDS: process.env.ADMIN_USER_IDS
    };
    process.env.JWT_SECRET = JWT_SECRET_FOR_TEST;
    process.env.EMAIL_VERIFICATION_FRONTEND_URL = FRONTEND_VERIFY;
    process.env.PASSWORD_RESET_FRONTEND_URL = FRONTEND_RESET;
    process.env.ADMIN_USER_IDS = "";
    t.after(() => {
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const pool = createMemoryPool();
    await pool.addUser({ id: 11, username: "alice", phone: "+254700000011", email: "alice@example.org", verified: true, password: "alice-old-password" });
    await pool.addUser({ id: 22, username: "bob", phone: "+254700000022", password: "bob-current-password" });
    const sent = [];
    const emailService = {
        isConfigured: () => true,
        async sendVerificationEmail(to, greeting, url) { sent.push({ type: "verify", to, greeting, url }); },
        async sendPasswordRecoveryEmail(to, greeting, url) { sent.push({ type: "reset", to, greeting, url }); },
        async sendPasswordChangedNotice(to, greeting) { sent.push({ type: "changed", to, greeting }); },
        async sendEmailChangedNotice(to, greeting, newEmail) { sent.push({ type: "email-change", to, greeting, newEmail }); }
    };
    const disconnectedRooms = [];
    const io = { in(room) { return { disconnectSockets() { disconnectedRooms.push(room); } }; } };
    const authenticate = function(req, res, next) {
        const userId = Number(req.get("x-test-user-id"));
        if (!userId) return res.status(401).json({ success: false, message: "Authentication required." });
        req.user = { userId };
        return next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/auth", createAuthRoutes(pool, authenticate, io, { emailService }));
    app.use("/api/auth/password-recovery", createPasswordRecoveryRoutes(pool, {
        frontendUrl: FRONTEND_RESET, emailService, io
    }));
    app.use("/api/auth/password-recovery-expiry-test", createPasswordRecoveryRoutes(pool, {
        frontendUrl: FRONTEND_RESET, emailService, io
    }));
    app.use(function(error, _req, res, _next) {
        res.status(500).json({ success: false, message: "Internal test error." });
        if (error) process.stderr.write("Unexpected test middleware error.\n");
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const invalidEmail = await postJson(server, "/api/auth/register", {
        username: "newuser", phone: "0700000033", email: "not-an-email",
        password: "new-user-password", game: "both", chessRating: 1200
    });
    assert.equal(invalidEmail.status, 400);
    assert.equal(pool.users.size, 2, "invalid addresses do not create an account");

    const registration = await postJson(server, "/api/auth/register", {
        username: "newuser", phone: "0700000033", email: " NewUser@Example.org ",
        password: "new-user-password", game: "both", chessRating: 1200
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.user.email, "newuser@example.org");
    assert.equal(registration.body.user.email_verified_at, null, "signup never marks an entered address verified");
    assert.equal(registration.body.emailVerificationSent, true);
    assert.equal(sent.at(-1).to, "newuser@example.org");
    assert.equal(pool.users.get(registration.body.user.id).email_verified_at, null);

    const signupVerification = fragmentValues(sent.at(-1).url);
    const signupRequest = pool.verificationRequests.get(signupVerification.get("id"));
    assert.ok(signupRequest);
    assert.notEqual(signupRequest.token_hash, signupVerification.get("secret"), "only a hash is stored");
    assert.equal(new URL(sent.at(-1).url).origin + new URL(sent.at(-1).url).pathname, FRONTEND_VERIFY);
    const verifiedSignup = await postJson(server, "/api/auth/email/verify", {
        id: signupVerification.get("id"), secret: signupVerification.get("secret")
    });
    assert.equal(verifiedSignup.status, 200);
    assert.equal(verifiedSignup.body.email, "newuser@example.org");
    assert.ok(pool.users.get(registration.body.user.id).email_verified_at);
    const reusedSignupLink = await postJson(server, "/api/auth/email/verify", {
        id: signupVerification.get("id"), secret: signupVerification.get("secret")
    });
    assert.equal(reusedSignupLink.status, 400, "verification links are single use");

    const duplicateVerifiedEmail = await postJson(server, "/api/auth/register", {
        username: "anotheruser", phone: "0700000055", email: "ALICE@example.org",
        password: "another-user-password", game: "chess", chessRating: 1200
    });
    assert.equal(duplicateVerifiedEmail.status, 409, "registration rejects an address already verified on another account");
    assert.equal(pool.users.size, 3, "duplicate verified addresses do not create accounts");

    const expiredSignup = await postJson(server, "/api/auth/register", {
        username: "expireduser", phone: "0700000044", email: "expired@example.org",
        password: "expired-user-password", game: "chess", chessRating: 1200
    });
    assert.equal(expiredSignup.status, 201);
    const expiredVerificationValues = fragmentValues(sent.at(-1).url);
    pool.verificationRequests.get(expiredVerificationValues.get("id")).expires_at = new Date(Date.now() - 1000);
    const expiredVerification = await postJson(server, "/api/auth/email/verify", {
        id: expiredVerificationValues.get("id"), secret: expiredVerificationValues.get("secret")
    });
    assert.equal(expiredVerification.status, 400, "expired verification links are rejected");

    const unauthenticatedAdd = await postJson(server, "/api/auth/email/request-verification", {
        email: "bob@example.org", currentPassword: "bob-current-password"
    });
    assert.equal(unauthenticatedAdd.status, 401);
    const wrongPassword = await postJson(server, "/api/auth/email/request-verification", {
        email: "bob@example.org", currentPassword: "wrong-password"
    }, { "x-test-user-id": "22" });
    assert.equal(wrongPassword.status, 401);

    const addEmail = await postJson(server, "/api/auth/email/request-verification", {
        email: " Bob@Example.org ", currentPassword: "bob-current-password"
    }, { "x-test-user-id": "22" });
    assert.equal(addEmail.status, 202);
    assert.equal(sent.at(-1).to, "bob@example.org");
    assert.equal(pool.users.get(22).email, null, "existing account email stays unset until the link is opened");
    const bobVerification = fragmentValues(sent.at(-1).url);
    const verifiedBob = await postJson(server, "/api/auth/email/verify", {
        id: bobVerification.get("id"), secret: bobVerification.get("secret")
    });
    assert.equal(verifiedBob.status, 200);
    assert.equal(pool.users.get(22).email, "bob@example.org");
    assert.ok(pool.users.get(22).email_verified_at);

    const duplicateVerifiedAddress = await postJson(server, "/api/auth/email/request-verification", {
        email: "alice@example.org", currentPassword: "bob-current-password"
    }, { "x-test-user-id": "22" });
    assert.equal(duplicateVerifiedAddress.status, 409, "verified addresses cannot be attached to a second account");

    const changeEmail = await postJson(server, "/api/auth/email/request-verification", {
        email: "bob-new@example.org", currentPassword: "bob-current-password"
    }, { "x-test-user-id": "22" });
    assert.equal(changeEmail.status, 202);
    assert.equal(pool.users.get(22).email, "bob@example.org", "old verified email remains active during a change");
    const changedVerification = fragmentValues(sent.at(-1).url);
    const changedBobEmail = await postJson(server, "/api/auth/email/verify", {
        id: changedVerification.get("id"), secret: changedVerification.get("secret")
    });
    assert.equal(changedBobEmail.status, 200);
    assert.equal(pool.users.get(22).email, "bob-new@example.org");
    assert.ok(sent.some((item) => item.type === "email-change" && item.to === "bob@example.org"), "old verified address receives a change notice");

    const startingMailCount = sent.length;
    const mismatch = await postJson(server, "/api/auth/password-recovery/request", {
        username: "alice", phone: "0700000099"
    });
    assert.equal(mismatch.status, 202);
    assert.equal(sent.length, startingMailCount, "mismatched identity data never produces an email");
    const genericWithoutEmail = await postJson(server, "/api/auth/password-recovery/request", {
        username: "expireduser", phone: "0700000044"
    });
    assert.equal(genericWithoutEmail.status, 202);
    assert.equal(sent.length, startingMailCount, "an account without verified email gets no reset link");

    const resetRequest = await postJson(server, "/api/auth/password-recovery/request", {
        username: "alice", phone: "0700000011"
    });
    assert.equal(resetRequest.status, 202);
    assert.match(resetRequest.body.message, /verified email/i);
    assert.equal(sent.at(-1).type, "reset");
    assert.equal(sent.at(-1).to, "alice@example.org", "only the verified address receives the reset link");
    const resetValues = fragmentValues(sent.at(-1).url);
    const resetRow = pool.recoveryRequests.get(resetValues.get("ticket"));
    assert.ok(resetRow);
    assert.notEqual(resetRow.secret_hash, resetValues.get("secret"), "the reset token is stored only as a hash");
    assert.equal(new URL(sent.at(-1).url).origin + new URL(sent.at(-1).url).pathname, FRONTEND_RESET);

    const expiredReset = await postJson(server, "/api/auth/password-recovery-expiry-test/request", {
        username: "alice", phone: "0700000011"
    });
    const expiredValues = fragmentValues(sent.at(-1).url);
    const expiredRow = pool.recoveryRequests.get(expiredValues.get("ticket"));
    expiredRow.approval_expires_at = new Date(Date.now() - 1000);
    const expiredStatus = await postJson(server, "/api/auth/password-recovery-expiry-test/status", {
        ticketId: expiredValues.get("ticket"), secret: expiredValues.get("secret")
    });
    assert.equal(expiredStatus.body.status, "expired");
    const expiredResetCompletion = await postJson(server, "/api/auth/password-recovery-expiry-test/complete", {
        ticketId: expiredValues.get("ticket"), secret: expiredValues.get("secret"), newPassword: "expired-new-password"
    });
    assert.equal(expiredResetCompletion.status, 400);

    const finalResetRequest = await postJson(server, "/api/auth/password-recovery/request", {
        username: "alice", phone: "0700000011"
    });
    assert.equal(finalResetRequest.status, 202);
    const finalResetValues = fragmentValues(sent.at(-1).url);
    const reset = await postJson(server, "/api/auth/password-recovery/complete", {
        ticketId: finalResetValues.get("ticket"), secret: finalResetValues.get("secret"), newPassword: "alice-new-password"
    });
    assert.equal(reset.status, 200);
    assert.ok(reset.body.token, "successful reset establishes a normal authenticated session");
    assert.equal(reset.body.user.username, "alice");
    assert.equal(reset.body.user.auth_version, 1);
    const claims = jwt.verify(reset.body.token, JWT_SECRET_FOR_TEST);
    assert.equal(claims.userId, 11);
    assert.equal(claims.authVersion, 1);
    assert.equal(pool.users.get(11).auth_version, 1);
    assert.equal(await bcrypt.compare("alice-new-password", pool.users.get(11).password_hash), true);
    assert.ok(disconnectedRooms.includes("user_11"), "old live sessions are disconnected after password change");

    const loginAfterReset = await postJson(server, "/api/auth/login", {
        username: "alice", password: "alice-new-password"
    });
    assert.equal(loginAfterReset.status, 200, "the new password is accepted by normal authentication");
    const reusedReset = await postJson(server, "/api/auth/password-recovery/complete", {
        ticketId: finalResetValues.get("ticket"), secret: finalResetValues.get("secret"), newPassword: "another-password"
    });
    assert.equal(reusedReset.status, 400, "a successful reset link cannot be reused");
});

test("email pages and recovery page scripts parse and keep private tokens in URL fragments", () => {
    for (const filename of ["verify-email.html", "password-recovery.html", "signup.html", "account.html"]) {
        const html = fs.readFileSync(path.join(__dirname, "../../frontend/pages", filename), "utf8");
        const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
        for (const script of scripts) {
            if (!script[1].trim()) continue;
            assert.doesNotThrow(() => new Function(script[1]), filename + " inline script parses");
        }
    }
    const verifyHtml = fs.readFileSync(path.join(__dirname, "../../frontend/pages/verify-email.html"), "utf8");
    const recoveryHtml = fs.readFileSync(path.join(__dirname, "../../frontend/pages/password-recovery.html"), "utf8");
    assert.match(verifyHtml, /name="referrer" content="no-referrer"/i);
    assert.match(recoveryHtml, /name="referrer" content="no-referrer"/i);
    assert.match(recoveryHtml, /GG\.saveSession\(result\.data\.token,result\.data\.user/);
    assert.match(recoveryHtml, /location\.replace\("dashboard\.html"\)/);
    assert.doesNotMatch(recoveryHtml, /AFRICASTALKING|sendSms|verification code/i);
});

test("email provider configuration requires the official Gmail App Password sender", () => {
    const service = require("../services/emailService");
    const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USERNAME", "SMTP_APP_PASSWORD", "EMAIL_FROM_NAME", "EMAIL_FROM_ADDRESS"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        assert.equal(service.isConfigured(), false);
        process.env.SMTP_HOST = "smtp.gmail.com";
        process.env.SMTP_PORT = "465";
        process.env.SMTP_SECURE = "true";
        process.env.SMTP_USERNAME = "goalgambitsupport@gmail.com";
        process.env.SMTP_APP_PASSWORD = "fake-test-app-password";
        process.env.EMAIL_FROM_NAME = "GOAL$GAMBIT Support";
        process.env.EMAIL_FROM_ADDRESS = "goalgambitsupport@gmail.com";
        assert.equal(service.isConfigured(), true);
        process.env.EMAIL_FROM_ADDRESS = "attacker@example.org";
        assert.equal(service.isConfigured(), false, "messages cannot claim an unrelated sender address");
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
