"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
require("./config").readConfig();
const { createFixture, verifiedPool } = require("./fixture");
const { readConfig, EXPECTED_DATABASE, EXPECTED_ROLE } = require("./config");
const { request } = require("./httpHarness");
const authenticateToken = require("../../middleware/authMiddleware");
const adminRoutes = require("../../routes/admin");
const createAuthToken = require("../../services/authToken");
const jwt = require("jsonwebtoken");

const TEST_SECRET = "security-account-status-session-test-secret";
let fixture;
let inventoryPool;
let schemasBefore;
let server;
let base;
let previousSecret;
let previousAdminIds;
let target;
let admin;
let targetTokens;

before(async () => {
    previousSecret = process.env.JWT_SECRET;
    previousAdminIds = process.env.ADMIN_USER_IDS;
    process.env.JWT_SECRET = TEST_SECRET;
    inventoryPool = await verifiedPool(readConfig());
    const identity = await inventoryPool.query("SELECT current_database() AS database_name,current_user AS role_name");
    assert.deepEqual(identity.rows[0], { database_name: EXPECTED_DATABASE, role_name: EXPECTED_ROLE });
    schemasBefore = (await inventoryPool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
    )).rows.map(row => row.nspname);

    fixture = await createFixture();
    for (const [name, pool] of [["application", fixture.pool], ["Socket.IO lock", fixture.lockPool]]) {
        const result = await pool.query(
            "SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name"
        );
        assert.deepEqual(result.rows[0], {
            database_name: EXPECTED_DATABASE,
            role_name: EXPECTED_ROLE,
            schema_name: fixture.schema
        }, name + " pool must be isolated before writes");
    }
    authenticateToken.setPool(fixture.pool);

    admin = await fixture.createUser("it_status_admin_");
    const otherAdmin = await fixture.createUser("it_status_admin2_");
    target = await fixture.createUser("it_status_target_");
    await fixture.pool.query("UPDATE users SET role='admin' WHERE id=ANY($1::int[])", [[admin.id, otherAdmin.id]]);
    process.env.ADMIN_USER_IDS = admin.id + "," + otherAdmin.id;
    targetTokens = [await tokenFor(target), await tokenFor(target)];
    const adminToken = await tokenFor(admin);

    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRoutes(fixture.pool, authenticateToken));
    app.get("/api/me", authenticateToken, (req, res) => res.json({ success: true, userId: req.user.userId }));
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    base = "http://127.0.0.1:" + server.address().port;
    targetTokens.admin = adminToken;
});

after(async () => {
    if (server && server.listening) await new Promise(resolve => server.close(resolve));
    if (fixture) await fixture.close();
    if (inventoryPool) {
        const schemasAfter = (await inventoryPool.query(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
        )).rows.map(row => row.nspname);
        assert.deepEqual(schemasAfter, schemasBefore, "the run must preserve all pre-existing security_it_* schemas");
        await inventoryPool.end();
    }
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previousAdminIds;
});

async function tokenFor(user) {
    const client = await fixture.pool.connect();
    try {
        await client.query("BEGIN");
        const current = await client.query("SELECT id,username,role,auth_version FROM users WHERE id=$1", [user.id]);
        const token = await createAuthToken(current.rows[0], client);
        await client.query("COMMIT");
        return token;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

test("admin suspension and reactivation atomically revoke old sessions without reviving credentials", async () => {
    const sessionIds = targetTokens.map(token => jwt.verify(token, TEST_SECRET).jti);
    const response = await request(base, "/api/admin/users/" + target.id + "/status", {
        method: "POST",
        token: targetTokens.admin,
        body: { status: "suspended", reason: "security integration" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.account_status, "suspended");
    assert.equal(response.body.user.auth_version, 1);

    const state = await fixture.pool.query(
        `SELECT u.account_status,u.auth_version,s.id,s.revoked_at
           FROM users u JOIN auth_sessions s ON s.user_id=u.id
          WHERE u.id=$1 ORDER BY s.id`, [target.id]
    );
    assert.equal(state.rows.length, 2);
    assert.ok(state.rows.every(row => row.revoked_at));
    assert.deepEqual(state.rows.map(row => row.id).sort(), sessionIds.sort());
    for (const token of targetTokens) {
        const rejected = await request(base, "/api/me", { token });
        assert.equal(rejected.status, 401);
    }

    const reactivated = await request(base, "/api/admin/users/" + target.id + "/status", {
        method: "POST",
        token: targetTokens.admin,
        body: { status: "active", reason: "security integration restore" }
    });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.user.auth_version, 2);
    assert.ok((await request(base, "/api/me", { token: targetTokens[0] })).status === 401,
        "reactivation must not revive credentials issued before suspension");

    const replacementToken = await tokenFor(target);
    assert.equal(jwt.verify(replacementToken, TEST_SECRET).authVersion, 2);
    assert.equal((await request(base, "/api/me", { token: replacementToken })).status, 200);
});

test("account deletion refuses unsettled forfeited Chess dispositions without changing financial or match records", async () => {
    const deleting = await fixture.createUser("it_delete_unsettled_");
    const opponent = await fixture.createUser("it_delete_opponent_");
    await fixture.pool.query(
        "INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,0,0,'KES')",
        [deleting.id]
    );
    const match = await fixture.pool.query(
        `INSERT INTO chess_matches
            (player_white_id,player_black_id,status,result,winner_id,started_at,finished_at,time_control,match_type,stake_amount,payout_status,season_key)
         VALUES($1,$2,'completed','white_win',$1,NOW(),NOW(),'10+5','tournament',20,'pending_competition','2026-11')
         RETURNING id`,
        [deleting.id, opponent.id]
    );
    await fixture.pool.query(
        `INSERT INTO chess_match_financial_dispositions
            (match_id,user_id,season_key,stake_amount,disposition,reference,settled_at)
         VALUES($1,$2,'2026-11',20,'admin_forfeited','CHESS-TEST-FORFEIT',NOW()),
               ($1,$3,'2026-11',20,'pending',NULL,NULL)`,
        [match.rows[0].id, deleting.id, opponent.id]
    );
    const oldToken = await tokenFor(deleting);
    const response = await request(base, "/api/admin/users/" + deleting.id, {
        method: "DELETE",
        token: targetTokens.admin
    });
    assert.equal(response.status, 409);

    const state = await fixture.pool.query(
        `SELECT u.id,w.balance,w.locked_balance,m.player_white_id,m.payout_status,
                COUNT(d.user_id)::int AS disposition_count,
                COUNT(*) FILTER(WHERE d.user_id=$2 AND d.disposition='admin_forfeited')::int AS forfeited_count
           FROM users u JOIN wallets w ON w.user_id=u.id
           JOIN chess_matches m ON m.id=$3
           JOIN chess_match_financial_dispositions d ON d.match_id=m.id
          WHERE u.id=$1 GROUP BY u.id,w.balance,w.locked_balance,m.player_white_id,m.payout_status`,
        [deleting.id, deleting.id, match.rows[0].id]
    );
    assert.deepEqual(state.rows[0], {
        id: deleting.id,
        balance: "0.00",
        locked_balance: "0.00",
        player_white_id: deleting.id,
        payout_status: "pending_competition",
        disposition_count: 2,
        forfeited_count: 1
    });
    assert.equal((await request(base, "/api/me", { token: oldToken })).status, 200,
        "a deletion refused for unsettled finances must leave the player's session active");
});
