"use strict";

const jwt = require("jsonwebtoken");
const { publicAccountRole } = require("./adminAuthorization");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let dbPool = null;

function setPool(pool) {
    dbPool = pool;
}

function unauthorized(res, message) {
    return res.status(401).json({ success: false, message });
}

async function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
        return unauthorized(res, "Authentication token required.");
    }

    let decoded;
    try {
        decoded = jwt.verify(authHeader.slice(7).trim(), process.env.JWT_SECRET);
    } catch (_) {
        return unauthorized(res, "Invalid or expired authentication token.");
    }

    const userId = Number(decoded && decoded.userId);
    const sessionId = String(decoded && decoded.jti || "");
    if (!Number.isSafeInteger(userId) || userId <= 0 || !UUID_PATTERN.test(sessionId)) {
        return unauthorized(res, "Invalid authentication token.");
    }

    if (!dbPool) {
        return res.status(503).json({
            success: false,
            message: "Account status is temporarily unavailable. Please try again."
        });
    }
    const requestPool = dbPool;

    try {
        // Read the account on every authenticated request so suspended and
        // closed accounts lose access immediately, even with a valid JWT.
        const result = await requestPool.query(
            `SELECT id, username, role, account_status, suspended_until, auth_version
             FROM users WHERE id = $1`,
            [userId]
        );

        if (!result.rows.length) {
            return unauthorized(res, "Account not found.");
        }

        const user = result.rows[0];
        if (Number(decoded.authVersion || 0) !== Number(user.auth_version || 0)) {
            return unauthorized(res, "Your session expired after an account change. Please sign in again.");
        }

        if (user.account_status === "closed") {
            return res.status(403).json({
                success: false,
                message: "This account has been closed."
            });
        }

        if (user.account_status === "suspended" && user.suspended_until) {
            const activated = await requestPool.query(
                `UPDATE users
                 SET account_status = 'active', suspended_until = NULL
                 WHERE id = $1 AND account_status = 'suspended'
                   AND suspended_until <= NOW()
                 RETURNING id`,
                [user.id]
            );
            if (activated.rows.length) {
                user.account_status = "active";
                user.suspended_until = null;
            } else {
                // Re-read if another request changed the account between
                // the initial check and the guarded expiration update.
                const current = await requestPool.query(
                    `SELECT username, role, account_status, suspended_until, auth_version
                     FROM users WHERE id = $1`,
                    [user.id]
                );
                if (!current.rows.length) {
                    return unauthorized(res, "Account not found.");
                }
                Object.assign(user, current.rows[0]);
            }
        }

        if (user.account_status === "closed") {
            return res.status(403).json({
                success: false,
                message: "This account has been closed."
            });
        }

        if (user.account_status === "suspended") {
            return res.status(403).json({
                success: false,
                message: "Your account is currently suspended.",
                suspendedUntil: user.suspended_until
            });
        }

        if (Number(decoded.authVersion || 0) !== Number(user.auth_version || 0)) {
            return unauthorized(res, "Your session expired after an account change. Please sign in again.");
        }

        const session = await requestPool.query(
            `SELECT 1 FROM auth_sessions s
              JOIN users u ON u.id=s.user_id
              WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
                AND s.expires_at>NOW() AND u.auth_version=$3`,
            [sessionId, user.id, Number(decoded.authVersion || 0)]
        );
        if (!session.rows.length) {
            return unauthorized(res, "Invalid or expired authentication session.");
        }

        req.user = {
            ...decoded,
            userId: user.id,
            sessionId,
            username: user.username,
            role: publicAccountRole(user)
        };
        return next();
    } catch (error) {
        // A database outage is not an invalid token. Keep the client session
        // so a temporary outage does not force every player to log in again.
        console.error("Account status lookup failed:", error.message);
        return res.status(503).json({
            success: false,
            message: "Account status is temporarily unavailable. Please try again."
        });
    }
}

authenticateToken.setPool = setPool;
module.exports = authenticateToken;
