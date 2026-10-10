"use strict";

const jwt = require("jsonwebtoken");

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
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return unauthorized(res, "Invalid authentication token.");
    }

    if (!dbPool) {
        return res.status(503).json({
            success: false,
            message: "Account status is temporarily unavailable. Please try again."
        });
    }

    try {
        // Read the account on every authenticated request so suspended and
        // closed accounts lose access immediately, even with a valid JWT.
        const result = await dbPool.query(
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
            const activated = await dbPool.query(
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
                const current = await dbPool.query(
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

        req.user = {
            ...decoded,
            userId: user.id,
            username: user.username,
            role: user.role
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
