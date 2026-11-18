"use strict";

const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const { acquireAccountMutationLock } = require("./authSession");

const TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

async function createAuthToken(user, client, options) {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured.");
    if (!client || typeof client.query !== "function") {
        throw new Error("An active database transaction is required to issue an authentication session.");
    }
    options = options || {};
    // Password change/recovery already hold both exclusive account gates.
    // Every other issuer takes the shared mutation gate before touching the
    // user row so it cannot race invalidation or issue a stale-version token.
    if (options.accountMutationLockHeld !== "exclusive") {
        await acquireAccountMutationLock(client, user.id, "shared");
    }
    // Recheck after the mutation gate so a login that read an old auth_version
    // before invalidation cannot create a stale session afterward.
    const account = await client.query(
        "SELECT auth_version FROM users WHERE id=$1 FOR SHARE",
        [user.id]
    );
    if (!account.rows.length || Number(account.rows[0].auth_version || 0) !== Number(user.auth_version || 0)) {
        throw new Error("Authentication version changed before a session could be issued.");
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TOKEN_LIFETIME_SECONDS;
    const sessionId = randomUUID();
    await client.query(
        `INSERT INTO auth_sessions (id,user_id,created_at,expires_at)
         VALUES ($1,$2,to_timestamp($3),to_timestamp($4))`,
        [sessionId, user.id, now, expiresAt]
    );
    return jwt.sign({
        userId: user.id,
        username: user.username,
        authVersion: Number(user.auth_version || 0),
        jti: sessionId,
        iat: now,
        exp: expiresAt
    }, process.env.JWT_SECRET);
}

createAuthToken.TOKEN_LIFETIME_SECONDS = TOKEN_LIFETIME_SECONDS;
module.exports = createAuthToken;
