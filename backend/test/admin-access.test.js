"use strict";

const assert = require("assert");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const adminRoutes = require("../routes/admin");
const adminComplaintCases = require("../routes/adminComplaintCases");

async function main() {
    const adminPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/admin.html"), "utf8");
    const adminScript = fs.readFileSync(path.join(__dirname, "../../frontend/js/admin.js"), "utf8");
    const privateDashboard = fs.readFileSync(path.join(__dirname, "../private-pages/admin-dashboard.html"), "utf8");
    const reviewPage = fs.readFileSync(path.join(__dirname, "../../frontend/pages/admin-verifications.html"), "utf8");
    const privateReviewPage = fs.readFileSync(path.join(__dirname, "../private-pages/admin-verifications.html"), "utf8");
    assert(!adminPage.includes("GOAL$GAMBIT Admin Desk"), "the public page must not contain the dashboard markup");
    assert(adminPage.includes("/api/admin/dashboard-page"), "the public page must request the dashboard from the backend");
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
    assert(adminScript.includes('r.data.user.role!=="admin"'), "the dashboard must verify the current account role");
    assert(adminScript.includes('addEventListener("visibilitychange"'), "returning to the tab must recheck access");

    const queryLog = [];
    const phone = "TEST_PHONE_ADMIN_ONLY";
    const pool = {
        async query(sql, params) {
            queryLog.push(String(sql));
            if (/SELECT id,\s*username,\s*role FROM users WHERE id\s*=\s*\$1/i.test(String(sql))) {
                return { rows: [{ id: Number(params[0]), username: Number(params[0]) === 1 ? "admin" : "player", role: Number(params[0]) === 1 ? "admin" : "player" }] };
            }
            if (String(sql).includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: 1 }] };
            if (String(sql).includes("SELECT c.id,c.complaint_ref")) {
                return { rows: [{ id: 7, complaint_ref: "GG-000007", reporter_username: "reporter", reporter_phone: phone, reported_username: "reported", reported_phone: "TEST_PHONE_ADMIN_ONLY", status: "open" }] };
            }
            if (String(sql).includes("SELECT status,COUNT(*)::int AS count FROM complaints")) return { rows: [{ status: "open", count: 1 }] };
            throw new Error("Unexpected test query: " + String(sql).slice(0, 100));
        }
    };
    const app = express();
    function authenticateTestUser(req, res, next) {
        const id = Number(req.get("x-test-user"));
        if (!Number.isInteger(id) || id <= 0) return res.status(401).json({ success: false });
        req.user = { userId: id };
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

        const admin = await fetch(base, { headers: { "x-test-user": "1" } });
        const adminBody = await admin.text();
        assert.strictEqual(admin.status, 200, "admins must be able to load complaint cases");
        assert(adminBody.includes(phone), "the admin complaint dashboard should include registered phone numbers");
        assert.strictEqual(admin.headers.get("cache-control"), "private, no-store", "admin case data must not be cached");

        const adminPageResponse = await fetch(adminBase + "/dashboard-page", { headers: { "x-test-user": "1" } });
        const adminPageBody = await adminPageResponse.text();
        assert.strictEqual(adminPageResponse.status, 200, "admins must be served the private dashboard HTML");
        assert(adminPageBody.includes("GOAL$GAMBIT Admin Desk"), "the admin page endpoint should serve the dashboard to admins");
        assert.strictEqual(adminPageResponse.headers.get("cache-control"), "private, no-store", "private dashboard HTML must not be cached");
        const adminReviewPage = await fetch(adminBase + "/result-review-page", { headers: { "x-test-user": "1" } });
        assert.strictEqual(adminReviewPage.status, 200, "admins must be served the private result-review screen");
        assert((await adminReviewPage.text()).includes("Result Reviews"), "admins should receive the result-review markup");
        console.log("Admin access test passed.");
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
