"use strict";

const assert = require("assert");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const adminRoutes = require("../routes/admin");
const adminComplaintCases = require("../routes/adminComplaintCases");
const { configuredAdministratorIds, isAuthorizedAdministrator, publicAccountRole } = require("../middleware/adminAuthorization");

async function main() {
    process.env.ADMIN_USER_IDS = "39,40";
    assert.deepStrictEqual(Array.from(configuredAdministratorIds()).sort((a, b) => a - b), [39, 40], "the explicit allowlist contains exactly the two existing administrators");
    assert(isAuthorizedAdministrator({ id: 39, role: "admin" }));
    assert(isAuthorizedAdministrator({ id: 40, role: "admin" }));
    assert.strictEqual(publicAccountRole({ id: 39, role: "admin" }), "admin");
    assert.strictEqual(publicAccountRole({ id: 40, role: "admin" }), "admin");
    assert(!isAuthorizedAdministrator({ id: 41, role: "admin" }), "a database admin role outside the immutable allowlist is not authorization");
    assert(!isAuthorizedAdministrator({ id: 39, role: "user" }), "the allowlist alone does not grant a database role");
    assert.strictEqual(publicAccountRole({ id: 41, role: "admin" }), "user", "unlisted roles are not exposed to clients");
    assert.strictEqual(configuredAdministratorIds("39,40,41").size, 0, "the configuration rejects more than two accounts");
    assert.strictEqual(configuredAdministratorIds("").size, 0, "missing allowlist configuration fails closed");

    const authRoutes = fs.readFileSync(path.join(__dirname, "../routes/auth.js"), "utf8");
    assert(authRoutes.includes("user.role = publicAccountRole(user)"), "registration and login responses must expose only an allowlisted admin role");
    assert(authRoutes.includes("changedUser.role = publicAccountRole(changedUser)"), "account-update responses must preserve the same role policy");
    const adminPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/admin.html"), "utf8");
    const adminScript = fs.readFileSync(path.join(__dirname, "../../frontend/js/admin.js"), "utf8");
    const privateDashboard = fs.readFileSync(path.join(__dirname, "../private-pages/admin-dashboard.html"), "utf8");
    const reviewPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/admin-verifications.html"), "utf8");
    const privateReviewPage = fs.readFileSync(path.join(__dirname, "../private-pages/admin-verifications.html"), "utf8");
    const publicDarajaPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/daraja-check.html"), "utf8");
    const privateDarajaPage = fs.readFileSync(path.join(__dirname, "../private-pages/admin-daraja-check.html"), "utf8");
    assert(!adminPage.includes("GOAL$GAMBIT Admin Desk"), "the public page must not contain the dashboard markup");
    assert(adminPage.includes("/api/admin/dashboard-page"), "the public page must request the dashboard from the backend");
    assert(adminPage.includes('GG.api("/api/me", { noRedirect: true })'), "the public admin loader must show authentication failures instead of silently redirecting away");
    assert(adminPage.includes("server did not authorize this account"), "the public admin loader must explain server-side role rejection");
    const accessScript = adminPage.match(/<script>([\s\S]*?)<\/script>/i);
    assert(accessScript, "the public access page must have its role-checking loader");
    new Function(accessScript[1]);
    assert(/<main\b[^>]*\bid="app"[^>]*\bhidden\b/.test(privateDashboard), "the served dashboard must start hidden until its role check completes");
    assert(!reviewPage.includes("<h1>⚖ Result Reviews</h1>"), "the public result-review page must not contain admin screen markup");
    assert(reviewPage.includes("/api/admin/result-review-page"), "the result-review screen must load from the backend");
    const reviewLoader = reviewPage.match(/<script>([\s\S]*?)<\/script>/i);
    assert(reviewLoader, "the public result-review page must have its role-checking loader");
    new Function(reviewLoader[1]);
    assert(privateReviewPage.includes("<h1>⚖ Result Reviews</h1>"), "the private backend copy must retain the result-review screen");
    assert(!publicDarajaPage.includes("SEND STK PROMPT"), "public static files must not expose administrator diagnostics controls");
    assert(publicDarajaPage.includes("/api/admin/daraja-check-page"), "Daraja controls must load from the protected backend page route");
    assert(privateDarajaPage.includes("SEND STK PROMPT"), "the private page retains its legitimate administrator controls");
    assert(adminScript.includes('r.data.user.role!=="admin"'), "the dashboard must verify the current account role");
    assert(adminScript.includes("/api/admin/password-recovery?status="), "the recovery manager must load pending and processed request statuses");
    assert(privateDashboard.includes('id="passwordRecoveryFilter"'), "the recovery manager must provide a status filter");
    assert(privateDashboard.includes("admin-recovery-shared-statuses"), "the updated recovery manager must bypass stale browser script caches");
    assert(adminScript.includes('addEventListener("visibilitychange"'), "returning to the tab must recheck access");

    const queryLog = [];
    const recoveryRows = new Map([
        ["00000000-0000-4000-8000-000000000001", { id: "00000000-0000-4000-8000-000000000001", user_id: 20, status: "pending", expires_at: new Date(Date.now() + 86400000), requested_username: "player_one", submitted_phone: "254700123456", created_at: new Date(), matched_active_account: true, account_username: "player_one", registered_phone: "254700123456", account_id: 20, account_status: "active" }],
        ["00000000-0000-4000-8000-000000000002", { id: "00000000-0000-4000-8000-000000000002", user_id: 21, status: "pending", expires_at: new Date(Date.now() + 86400000), requested_username: "player_two", submitted_phone: "254711123456", created_at: new Date(), matched_active_account: true, account_username: "player_two", registered_phone: "254711123456", account_id: 21, account_status: "active" }]
    ]);
    const reviewedRequests = [];
    const phone = "254700123456";
    const pool = {
        async query(sql, params) {
            queryLog.push(String(sql));
            if (/SELECT id,\s*username,\s*role FROM users WHERE id\s*=\s*\$1/i.test(String(sql))) {
                const accountId = Number(params[0]);
                return { rows: [{ id: accountId, username: accountId === 40 ? "billgates" : accountId === 39 ? "briton" : "player", role: [39, 40, 41].includes(accountId) ? "admin" : "player" }] };
            }
            if (/FROM password_recovery_requests r/i.test(String(sql))) {
                const status = params && params[0] === "all" ? "all" : "pending";
                return { rows: Array.from(recoveryRows.values()).filter(row => status === "all" || row.status === "pending") };
            }
            if (String(sql).includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: 1 }] };
            if (String(sql).includes("SELECT c.id,c.complaint_ref")) {
                return { rows: [{ id: 7, complaint_ref: "GG-000007", reporter_username: "reporter", reporter_phone: phone, reported_username: "reported", reported_phone: "254711111111", status: "open" }] };
            }
            if (String(sql).includes("SELECT status,COUNT(*)::int AS count FROM complaints")) return { rows: [{ status: "open", count: 1 }] };
            throw new Error("Unexpected test query: " + String(sql).slice(0, 100));
        },
        async connect() {
            return {
                async query(sql, params) {
                    const statement = String(sql);
                    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(statement)) return { rows: [] };
                    if (/SELECT id,user_id,status,expires_at\s+FROM password_recovery_requests/i.test(statement)) {
                        const request = recoveryRows.get(String(params[0]));
                        return { rows: request ? [{ id: request.id, user_id: request.user_id, status: request.status, expires_at: request.expires_at }] : [] };
                    }
                    if (/SELECT id,auth_version FROM users/i.test(statement)) return { rows: [{ id: Number(params[0]), auth_version: 0 }] };
                    if (/UPDATE password_recovery_requests\s+SET status='approved'/i.test(statement)) {
                        const request = recoveryRows.get(String(params[3]));
                        request.status = "approved";
                        request.approval_expires_at = new Date(Date.now() + 30 * 60000);
                        request.reviewed_by = Number(params[1]);
                        request.reviewed_at = new Date();
                        request.review_note = params[2];
                        reviewedRequests.push({ id: request.id, reviewer: request.reviewed_by });
                        return { rows: [] };
                    }
                    throw new Error("Unexpected recovery review query: " + statement.slice(0, 100));
                },
                release() {}
            };
        }
    };
    const app = express();
    app.use(express.json());
    function authenticateTestUser(req, res, next) {
        const id = Number(req.get("x-test-user"));
        if (!Number.isInteger(id) || id <= 0) return res.status(401).json({ success: false });
        req.user = { userId: id, role: req.get("x-test-role") || "player" };
        next();
    }
    app.use("/api/admin", adminRoutes(pool, authenticateTestUser));
    app.use("/api/admin/complaint-cases", adminComplaintCases(pool, authenticateTestUser));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const adminBase = "http://127.0.0.1:" + address.port + "/api/admin";
    const base = adminBase + "/complaint-cases";
    try {
        const anonymous = await fetch(base);
        assert.strictEqual(anonymous.status, 401, "anonymous requests must be rejected");
        assert(!JSON.stringify(await anonymous.json()).includes(phone), "anonymous responses must not contain phones");

        queryLog.length = 0;
        const player = await fetch(base, { headers: { "x-test-user": "2" } });
        const playerBody = await player.text();
        assert.strictEqual(player.status, 403, "non-admin requests must be rejected");
        assert(!playerBody.includes(phone), "non-admin responses must not contain phones");
        assert.strictEqual(queryLog.length, 1, "non-admin role rejection must happen before complaint queries");

        const playerPage = await fetch(adminBase + "/dashboard-page", { headers: { "x-test-user": "2" } });
        const playerPageBody = await playerPage.text();
        assert.strictEqual(playerPage.status, 403, "non-admins must not be served the private dashboard HTML");
        assert(!playerPageBody.includes("GOAL$GAMBIT Admin Desk"), "non-admin responses must not contain private dashboard markup");
        const playerReviewPage = await fetch(adminBase + "/result-review-page", { headers: { "x-test-user": "2" } });
        assert.strictEqual(playerReviewPage.status, 403, "non-admins must not be served the result-review screen");

        const forgedRole = await fetch(base, { headers: { "x-test-user": "2", "x-test-role": "admin" } });
        assert.strictEqual(forgedRole.status, 403, "a forged client-side role cannot access complaint APIs");
        const unlistedDatabaseAdmin = await fetch(base, { headers: { "x-test-user": "41" } });
        assert.strictEqual(unlistedDatabaseAdmin.status, 403, "an account with an admin database role outside the allowlist is denied");

        const admin = await fetch(base, { headers: { "x-test-user": "40" } });
        const adminBody = await admin.text();
        assert.strictEqual(admin.status, 200, "admins must be able to load complaint cases");
        assert(adminBody.includes(phone), "the admin complaint dashboard should include registered phone numbers");
        assert.strictEqual(admin.headers.get("cache-control"), "private, no-store", "admin case data must not be cached");

        const adminPageResponse = await fetch(adminBase + "/dashboard-page", { headers: { "x-test-user": "40" } });
        const adminPageBody = await adminPageResponse.text();
        assert.strictEqual(adminPageResponse.status, 200, "admins must be served the private dashboard HTML");
        assert(adminPageBody.includes("GOAL$GAMBIT Admin Desk"), "the admin page endpoint should serve the dashboard to admins");
        assert.strictEqual(adminPageResponse.headers.get("cache-control"), "private, no-store", "private dashboard HTML must not be cached");
        const secondAdminPage = await fetch(adminBase + "/dashboard-page", { headers: { "x-test-user": "39" } });
        assert.strictEqual(secondAdminPage.status, 200, "the second authorized admin must also be served the private dashboard");
        assert((await secondAdminPage.text()).includes("GOAL$GAMBIT Admin Desk"), "both admins must receive the same admin page");
        const adminReviewPage = await fetch(adminBase + "/result-review-page", { headers: { "x-test-user": "40" } });
        assert.strictEqual(adminReviewPage.status, 200, "admins must be served the private result-review screen");
        assert((await adminReviewPage.text()).includes("Result Reviews"), "admins should receive the result-review markup");

        const darajaPage = await fetch(adminBase + "/daraja-check-page", { headers: { "x-test-user": "39" } });
        assert.strictEqual(darajaPage.status, 200, "an allowlisted admin can load the protected Daraja page");
        assert((await darajaPage.text()).includes("SEND STK PROMPT"));
        const deniedDarajaPage = await fetch(adminBase + "/daraja-check-page", { headers: { "x-test-user": "2" } });
        assert.strictEqual(deniedDarajaPage.status, 403, "ordinary players cannot load protected administrator markup");

        for (const adminId of [40, 39]) {
            const recoveryQueue = await fetch(adminBase + "/password-recovery?status=all", { headers: { "x-test-user": String(adminId) } });
            assert.strictEqual(recoveryQueue.status, 200, "each authorized admin must be able to view all recovery requests");
            const queueBody = await recoveryQueue.json();
            assert.strictEqual(queueBody.requests.length, 2, "both admins must see the same recovery queue");
        }
        for (const [adminId, requestId] of [[40, "00000000-0000-4000-8000-000000000001"], [39, "00000000-0000-4000-8000-000000000002"]]) {
            const reviewed = await fetch(adminBase + "/password-recovery/" + requestId + "/review", {
                method: "POST",
                headers: { "x-test-user": String(adminId), "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "approve", note: "Verified using the player's trusted contact." })
            });
            assert.strictEqual(reviewed.status, 200, "each admin must independently approve a verified player request");
            assert.strictEqual(recoveryRows.get(requestId).status, "approved", "approval status must persist for refreshes");
        }
        assert.deepStrictEqual(reviewedRequests.map(row => row.reviewer), [40, 39], "each admin must be recorded as the reviewer for their own request");
        const updatedQueue = await fetch(adminBase + "/password-recovery?status=all", { headers: { "x-test-user": "39" } });
        const updatedBody = await updatedQueue.json();
        assert(updatedBody.requests.every(row => row.status === "approved"), "either admin can refresh the shared queue and see persisted review statuses");
        const unauthorizedRecovery = await fetch(adminBase + "/password-recovery?status=all", { headers: { "x-test-user": "2" } });
        assert.strictEqual(unauthorizedRecovery.status, 403, "non-admin accounts must not access password recovery management");
        console.log("Admin access test passed.");
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
