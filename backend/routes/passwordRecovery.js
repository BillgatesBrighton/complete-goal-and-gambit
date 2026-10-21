"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const rateLimit = require("../middleware/rateLimit");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
    let phone = String(value || "").trim().replace(/[()\s-]/g, "");
    if (phone.startsWith("00")) phone = "+" + phone.slice(2);
    if (/^0[17]\d{8}$/.test(phone)) phone = "+254" + phone.slice(1);
    else if (/^254[17]\d{8}$/.test(phone)) phone = "+" + phone;
    else if (/^[1-9]\d{8,14}$/.test(phone)) phone = "+" + phone;
    return /^\+[1-9]\d{8,14}$/.test(phone) ? phone : null;
}

function hashSecret(secret) {
    return crypto.createHash("sha256").update(secret).digest("hex");
}

function secretMatches(expectedHex, secret) {
    if (!/^[a-f0-9]{64}$/i.test(String(expectedHex || ""))) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const submitted = Buffer.from(hashSecret(secret), "hex");
    return expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted);
}

function ticketInput(body) {
    const ticketId = String(body && body.ticketId || "").trim();
    const secret = String(body && body.secret || "").trim();
    return UUID_PATTERN.test(ticketId) && TOKEN_PATTERN.test(secret) ? { ticketId, secret } : null;
}

module.exports = function passwordRecoveryRoutes(pool) {
    const router = express.Router();
    const requestLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 4,
        message: "Too many recovery requests. Please wait before trying again."
    });
    const statusLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 30,
        message: "Too many status checks. Please wait before trying again."
    });
    const completeLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 6,
        message: "Too many password reset attempts. Please wait before trying again."
    });

    router.use(function(_req, res, next) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        next();
    });

    router.post("/request", requestLimiter, async function(req, res) {
        const username = normalizeUsername(req.body && req.body.username);
        const phone = normalizePhone(req.body && req.body.phone);
        if (username.length < 3 || username.length > 30 || !/^[a-z0-9_]+$/.test(username) || !phone) {
            return res.status(400).json({
                success: false,
                message: "Enter your account username and a valid phone number, including its country code if needed."
            });
        }

        let client;
        let transactionOpen = false;
        try {
            client = await pool.connect();
            // Validate both registration credentials against the active account
            // before creating any recovery ticket. Lock the row so a concurrent
            // account change cannot replace the phone between validation and insert.
            await client.query("BEGIN");
            transactionOpen = true;
            const account = await client.query(
                "SELECT id, phone FROM users WHERE username=$1 AND account_status='active' FOR UPDATE",
                [username]
            );
            if (!account.rows.length || normalizePhone(account.rows[0].phone) !== phone) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({
                    success: false,
                    message: "Those details could not be verified. Enter the username and phone number saved when you created the account, then try again."
                });
            }

            const userId = Number(account.rows[0].id);
            const ticketId = crypto.randomUUID();
            const secret = crypto.randomBytes(32).toString("base64url");

            await client.query(
                `INSERT INTO password_recovery_requests
                    (id,user_id,requested_username,submitted_phone,secret_hash,status,expires_at)
                 VALUES($1,$2,$3,$4,$5,'pending',NOW()+INTERVAL '7 days')`,
                [ticketId, userId, username, phone, hashSecret(secret)]
            );
            await client.query("COMMIT");
            transactionOpen = false;

            return res.status(202).json({
                success: true,
                ticketId,
                secret,
                message: "If the details match an active account, support will review your request. Keep the private recovery link; you will need it after approval."
            });
        } catch (error) {
            if (transactionOpen) await client.query("ROLLBACK").catch(function() {});
            console.error("Support-assisted password recovery request failed:", error && error.message);
            return res.status(500).json({ success: false, message: "Could not submit the recovery request. Please try again later." });
        } finally {
            if (client) client.release();
        }
    });

    router.post("/status", statusLimiter, async function(req, res) {
        const input = ticketInput(req.body);
        if (!input) return res.status(400).json({ success: false, message: "This recovery link is invalid or expired." });

        try {
            const result = await pool.query(
                `SELECT status,secret_hash,expires_at,approval_expires_at
                   FROM password_recovery_requests WHERE id=$1`,
                [input.ticketId]
            );
            if (!result.rows.length || !secretMatches(result.rows[0].secret_hash, input.secret)) {
                return res.status(404).json({ success: false, message: "This recovery link is invalid or expired." });
            }

            const request = result.rows[0];
            let status = request.status;
            if ((status === "pending" && new Date(request.expires_at) <= new Date()) ||
                (status === "approved" && (!request.approval_expires_at || new Date(request.approval_expires_at) <= new Date()))) {
                status = "expired";
            }
            return res.json({
                success: true,
                status,
                approvalExpiresAt: request.approval_expires_at || null
            });
        } catch (error) {
            console.error("Support-assisted password recovery status failed:", error && error.message);
            return res.status(500).json({ success: false, message: "Could not check the recovery request. Please try again." });
        }
    });

    router.post("/complete", completeLimiter, async function(req, res) {
        const input = ticketInput(req.body);
        const password = String(req.body && req.body.newPassword || "");
        if (!input || password.length < 8 || password.length > 128) {
            return res.status(400).json({ success: false, message: "Use a valid recovery link and a password between 8 and 128 characters." });
        }

        const client = await pool.connect();
        let transactionOpen = false;
        try {
            await client.query("BEGIN");
            transactionOpen = true;
            const result = await client.query(
                `SELECT id,user_id,status,secret_hash,expires_at,approval_expires_at,auth_version_at_approval
                   FROM password_recovery_requests WHERE id=$1 FOR UPDATE`,
                [input.ticketId]
            );
            if (!result.rows.length || !secretMatches(result.rows[0].secret_hash, input.secret)) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This recovery link is invalid, expired, or not approved." });
            }

            const recovery = result.rows[0];
            if (recovery.status !== "approved" || !recovery.user_id || !recovery.approval_expires_at ||
                new Date(recovery.approval_expires_at) <= new Date()) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This recovery link is invalid, expired, or not approved." });
            }

            const account = await client.query(
                "SELECT id,auth_version FROM users WHERE id=$1 AND account_status='active' FOR UPDATE",
                [recovery.user_id]
            );
            if (!account.rows.length || recovery.auth_version_at_approval == null ||
                Number(account.rows[0].auth_version) !== Number(recovery.auth_version_at_approval)) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This recovery link is invalid, expired, or not approved." });
            }

            const passwordHash = await bcrypt.hash(password, 12);
            await client.query(
                "UPDATE users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2",
                [passwordHash, recovery.user_id]
            );
            await client.query(
                "UPDATE password_reset_codes SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
                [recovery.user_id]
            );
            await client.query(
                "UPDATE password_recovery_requests SET status='completed',completed_at=NOW(),secret_hash=$1 WHERE id=$2",
                [hashSecret(crypto.randomBytes(32).toString("hex")), recovery.id]
            );
            await client.query("COMMIT");
            transactionOpen = false;
            return res.json({ success: true, message: "Password reset. Sign in with your new password." });
        } catch (error) {
            if (transactionOpen) await client.query("ROLLBACK").catch(function() {});
            console.error("Support-assisted password reset failed:", error && error.message);
            return res.status(500).json({ success: false, message: "Could not reset the password. Please contact support and try again." });
        } finally {
            client.release();
        }
    });

    return router;
};
