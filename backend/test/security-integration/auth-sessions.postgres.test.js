"use strict";

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { randomInt, randomUUID } = require("node:crypto");
require("./config").readConfig();
const { createFixture } = require("./fixture");
const { startHttpHarness, request } = require("./httpHarness");

const TEST_SECRET = "security-integration-only-secret-not-for-production";
let fixture;
let httpHarness;
let verificationEmailCount = 0;
let recoveryLink = null;
let previousJwtSecret;
let previousVerificationUrl;

const emailService = {
    isConfigured() { return true; },
    async sendVerificationEmail() { verificationEmailCount++; },
    async sendPasswordRecoveryEmail(_email, _username, url) { recoveryLink = url; }
};

before(async () => {
    previousJwtSecret = process.env.JWT_SECRET;
    previousVerificationUrl = process.env.EMAIL_VERIFICATION_FRONTEND_URL;
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.EMAIL_VERIFICATION_FRONTEND_URL = "http://127.0.0.1/verify-email.html";
    fixture = await createFixture();
    httpHarness = await startHttpHarness(fixture.pool, { emailService });
});

after(async () => {
    if (httpHarness) await httpHarness.close();
    if (fixture) await fixture.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousVerificationUrl === undefined) delete process.env.EMAIL_VERIFICATION_FRONTEND_URL;
    else process.env.EMAIL_VERIFICATION_FRONTEND_URL = previousVerificationUrl;
});

async function register(prefix) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const username = (prefix + suffix).slice(0, 30).toLowerCase();
    const phone = "+2547" + String(randomInt(10_000_000, 99_999_999));
    const email = username + "@example.invalid";
    const response = await request(httpHarness.base, "/api/auth/register", {
        method: "POST",
        body: { username, phone, email, password: "Test-password-123!", game: "both", chessRating: 1200 }
    });
    return { ...response, username, phone, email, password: "Test-password-123!" };
}

async function login(account) {
    return request(httpHarness.base, "/api/auth/login", {
        method: "POST", body: { username: account.username, password: account.password }
    });
}

async function sessionRow(token) {
    const claims = jwt.verify(token, TEST_SECRET);
    const result = await fixture.pool.query("SELECT id,user_id,revoked_at,expires_at FROM auth_sessions WHERE id=$1", [claims.jti]);
    return { claims, row: result.rows[0] || null };
}

describe("PostgreSQL authentication-session integration", { concurrency: false }, () => {
    test("registration and login persist sessions; logout revokes only its token", async () => {
        const account = await register("it_auth_");
        assert.equal(account.status, 201, JSON.stringify(account.body));
        assert.ok(account.body.token);
        assert.equal(verificationEmailCount > 0, true);
        const registration = await sessionRow(account.body.token);
        assert.ok(registration.row, "registration JWT has a committed database session");
        assert.equal(Number(registration.row.user_id), Number(account.body.user.id));

        const firstLogin = await login(account);
        const secondLogin = await login(account);
        assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.body));
        assert.equal(secondLogin.status, 200, JSON.stringify(secondLogin.body));
        const first = await sessionRow(firstLogin.body.token);
        const second = await sessionRow(secondLogin.body.token);
        assert.ok(first.row && second.row);
        assert.notEqual(first.claims.jti, second.claims.jti);

        assert.equal((await request(httpHarness.base, "/api/me", { token: firstLogin.body.token })).status, 200);
        const logout = await request(httpHarness.base, "/api/auth/logout", { method: "POST", token: firstLogin.body.token, body: {} });
        assert.equal(logout.status, 200, JSON.stringify(logout.body));
        assert.equal(logout.body.revoked, true);
        assert.equal((await request(httpHarness.base, "/api/me", { token: firstLogin.body.token })).status, 401,
            "the exact same JWT is rejected after logout");
        assert.equal((await request(httpHarness.base, "/api/me", { token: secondLogin.body.token })).status, 200,
            "another session on the same account remains active");
    });

    test("password change and password recovery invalidate prior sessions and issue tracked tokens", async () => {
        const account = await register("it_recovery_");
        assert.equal(account.status, 201, JSON.stringify(account.body));
        await fixture.pool.query("UPDATE users SET email_verified_at=NOW() WHERE id=$1", [account.body.user.id]);
        const first = await login(account);
        const other = await login(account);
        assert.equal(first.status, 200);
        assert.equal(other.status, 200);

        const changed = await request(httpHarness.base, "/api/auth/account", {
            method: "POST", token: first.body.token,
            body: { currentPassword: account.password, newPassword: "Changed-password-456!" }
        });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.ok((await sessionRow(changed.body.token)).row);
        assert.equal((await request(httpHarness.base, "/api/me", { token: first.body.token })).status, 401);
        assert.equal((await request(httpHarness.base, "/api/me", { token: other.body.token })).status, 401);
        assert.equal((await request(httpHarness.base, "/api/me", { token: changed.body.token })).status, 200);

        recoveryLink = null;
        const recoveryRequest = await request(httpHarness.base, "/api/auth/password-recovery/request", {
            method: "POST", body: { username: account.username, phone: account.phone }
        });
        assert.equal(recoveryRequest.status, 202);
        assert.ok(recoveryLink, "the test email adapter captured the recovery link");
        const link = new URL(recoveryLink);
        const params = new URLSearchParams(link.hash.slice(1));
        const recovered = await request(httpHarness.base, "/api/auth/password-recovery/complete", {
            method: "POST",
            body: { ticketId: params.get("ticket"), secret: params.get("secret"), newPassword: "Recovered-password-789!" }
        });
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
        assert.ok((await sessionRow(recovered.body.token)).row);
        assert.equal((await request(httpHarness.base, "/api/me", { token: changed.body.token })).status, 401,
            "password recovery invalidates the prior password-change token");
        assert.equal((await request(httpHarness.base, "/api/me", { token: recovered.body.token })).status, 200);
    });

    test("a deferred PostgreSQL failure after session insertion rolls back user and session and exposes no token", async () => {
        await fixture.pool.query(`
            CREATE OR REPLACE FUNCTION security_it_fail_auth_session_commit() RETURNS trigger
            LANGUAGE plpgsql AS $fn$
            BEGIN
                IF EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND username LIKE 'it_rollback_%') THEN
                    RAISE EXCEPTION 'intentional security integration commit failure';
                END IF;
                RETURN NEW;
            END
            $fn$`);
        await fixture.pool.query(`
            CREATE CONSTRAINT TRIGGER security_it_fail_auth_session_commit
            AFTER INSERT ON auth_sessions DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION security_it_fail_auth_session_commit()`);
        const account = await register("it_rollback_");
        try {
            assert.equal(account.status, 500);
            assert.equal(Object.prototype.hasOwnProperty.call(account.body, "token"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(account.body, "user"), false);
            const residue = await fixture.pool.query(
                `SELECT (SELECT COUNT(*) FROM users WHERE username=$1) AS users,
                        (SELECT COUNT(*) FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.username=$1) AS sessions`,
                [account.username]
            );
            assert.equal(Number(residue.rows[0].users), 0);
            assert.equal(Number(residue.rows[0].sessions), 0);
        } finally {
            await fixture.pool.query("DROP TRIGGER IF EXISTS security_it_fail_auth_session_commit ON auth_sessions");
            await fixture.pool.query("DROP FUNCTION IF EXISTS security_it_fail_auth_session_commit()");
        }
    });

    test("expired cleanup removes only old rows in bounded batches and exposes its index plan", async () => {
        const user = await fixture.createUser("it_cleanup_");
        const oldIds = Array.from({ length: 501 }, () => randomUUID());
        const activeId = randomUUID();
        const recentId = randomUUID();
        await fixture.pool.query(
            `INSERT INTO auth_sessions(id,user_id,created_at,expires_at,revoked_at)
             SELECT ids.id,$1,NOW()-INTERVAL '200 days',NOW()-INTERVAL '100 days',
                    CASE WHEN ids.ordinality=1 THEN NOW()-INTERVAL '99 days' ELSE NULL END
               FROM unnest($2::uuid[]) WITH ORDINALITY AS ids(id,ordinality)`,
            [user.id, oldIds]
        );
        await fixture.pool.query(
            `INSERT INTO auth_sessions(id,user_id,created_at,expires_at)
             VALUES($1,$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day'),
                   ($2,$3,NOW()-INTERVAL '20 days',NOW()-INTERVAL '10 days')`,
            [activeId, recentId, user.id]
        );

        const cleanup = require("../../services/authSessionCleanup")(fixture.pool);
        assert.equal(await cleanup.runOnce(), 500);
        let remaining = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM auth_sessions WHERE id=ANY($1::uuid[])", [oldIds]);
        assert.equal(remaining.rows[0].count, 1, "one eligible row remains for the next bounded batch");
        assert.equal(await cleanup.runOnce(), 1);
        remaining = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM auth_sessions WHERE id=ANY($1::uuid[])", [oldIds]);
        assert.equal(remaining.rows[0].count, 0);
        remaining = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM auth_sessions WHERE id=ANY($1::uuid[])", [[activeId, recentId]]);
        assert.equal(remaining.rows[0].count, 2, "active and within-retention rows remain");

        const client = await fixture.pool.connect();
        let plan;
        try {
            await client.query("BEGIN");
            await client.query("SET LOCAL enable_seqscan=off");
            plan = await client.query(`EXPLAIN (FORMAT JSON)
            SELECT id FROM auth_sessions
             WHERE expires_at < NOW() - (90 * INTERVAL '1 day')
             ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED`);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        assert.ok(plan.rows[0]["QUERY PLAN"], "read-only EXPLAIN returned a PostgreSQL plan");
        assert.match(JSON.stringify(plan.rows[0]["QUERY PLAN"]), /idx_auth_sessions_expiry_cleanup/,
            "the forced read-only plan can use the session expiry index");
        const index = await fixture.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_auth_sessions_expiry_cleanup'");
        assert.equal(index.rows.length, 1);
    });
});
