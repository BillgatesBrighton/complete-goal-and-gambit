"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const rateLimit = require("../middleware/rateLimit");
const createToken = require("../services/authToken");
const defaultEmailService = require("../services/emailService");
const { publicAccountRole } = require("../middleware/adminAuthorization");

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

function configuredRecoveryPage(options) {
    const configured = String(options.frontendUrl || process.env.PASSWORD_RESET_FRONTEND_URL || "").trim();
    try {
        const url = new URL(configured);
        if (url.username || url.password || url.search || url.hash) return null;
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
        return url;
    } catch (_) {
        return null;
    }
}

module.exports = function passwordRecoveryRoutes(pool, options) {
    options = options || {};
    const router = express.Router();
    const recoveryPage = configuredRecoveryPage(options);
    const emailService = options.emailService || defaultEmailService;
    const io = options.io || null;
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
        res.setHeader("Referrer-Policy", "no-referrer");
        next();
    });

    // The public response is intentionally consistent and never reveals whether
    // a username/phone pair exists. A reset link goes only to a verified email.
    router.use(express.urlencoded({ extended: false, limit: "2kb" }));

    router.post("/request", requestLimiter, async function(req, res) {
        if (!recoveryPage || !emailService || typeof emailService.isConfigured !== "function" || !emailService.isConfigured()) {
            return res.status(503).json({ success: false, message: "Password recovery is temporarily unavailable. Please try again later." });
        }
        const username = normalizeUsername(req.body && req.body.username);
        const phone = normalizePhone(req.body && req.body.phone);
        if (username.length < 3 || username.length > 30 || !/^[a-z0-9_]+$/.test(username) || !phone) {
            return res.status(202).json({ success: true, message: "If the details match an active account with a verified email, a reset link may arrive at that address." });
        }

        let client;
        let transactionOpen = false;
        let recoveryId = null;
        let secret = null;
        let recipientEmail = null;
        let usernameForEmail = null;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            transactionOpen = true;
            const account = await client.query(
                "SELECT id,phone,email,email_verified_at,auth_version FROM users WHERE username=$1 AND account_status='active' FOR UPDATE",
                [username]
            );
            const row = account.rows[0];
            recipientEmail = row && row.email_verified_at ? String(row.email || "").trim().toLowerCase() : null;
            if (!row || normalizePhone(row.phone) !== phone || !recipientEmail) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(202).json({ success: true, message: "If the details match an active account with a verified email, a reset link may arrive at that address." });
            }

            const userId = Number(row.id);
            usernameForEmail = username;
            const authVersion = Number(row.auth_version || 0);
            recoveryId = crypto.randomUUID();
            secret = crypto.randomBytes(32).toString("base64url");
            // A newer request makes all earlier pending or approved links for
            // this account unusable before the new one is inserted.
            await client.query(
                `UPDATE password_recovery_requests
                    SET status='expired',secret_hash=$1
                  WHERE user_id=$2 AND status IN ('pending','approved')`,
                [hashSecret(crypto.randomBytes(32).toString("hex")), userId]
            );

            await client.query(
                `INSERT INTO password_recovery_requests
                    (id,user_id,requested_username,submitted_phone,secret_hash,status,expires_at,approval_expires_at,auth_version_at_approval)
                 VALUES($1,$2,$3,$4,$5,'approved',NOW()+INTERVAL '30 minutes',NOW()+INTERVAL '30 minutes',$6)`,
                [recoveryId, userId, username, phone, hashSecret(secret), authVersion]
            );
            await client.query("COMMIT");
            transactionOpen = false;
            client.release();
            client = null;

            const resetLink = new URL(recoveryPage.toString());
            resetLink.hash = new URLSearchParams({ ticket: recoveryId, secret }).toString();
            try {
                await emailService.sendPasswordRecoveryEmail(recipientEmail, usernameForEmail, resetLink.toString());
            } catch (_) {
                await pool.query(
                    `UPDATE password_recovery_requests SET status='expired',secret_hash=$1
                      WHERE id=$2 AND status='approved'`,
                    [hashSecret(crypto.randomBytes(32).toString("hex")), recoveryId]
                ).catch(function() {});
                console.error("Password recovery email delivery failed.");
            }
            return res.status(202).json({ success: true, message: "If the details match an active account with a verified email, a reset link may arrive at that address." });
        } catch (error) {
            if (transactionOpen && client) await client.query("ROLLBACK").catch(function() {});
            console.error("Password recovery request failed:", error && error.code || "INTERNAL");
            return res.status(202).json({ success: true, message: "If the details match an active account with a verified email, a reset link may arrive at that address." });
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
                // Use the same public state for an unknown link and an
                // unreviewed request, so this endpoint cannot confirm accounts.
                return res.json({ success: true, status: "pending", approvalExpiresAt: null });
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
            console.error("Password recovery status failed:", error && error.code || "INTERNAL");
            return res.status(500).json({ success: false, message: "Could not check the recovery request. Please try again." });
        }
    });

    router.post("/complete", completeLimiter, async function(req, res) {
        const input = ticketInput(req.body);
        const password = String(req.body && req.body.newPassword || "");
        if (!input || password.length < 8 || password.length > 128) {
            return res.status(400).json({ success: false, message: "Use a valid recovery link and a password between 8 and 128 characters." });
        }

        let client;
        let transactionOpen = false;
        try {
            client = await pool.connect();
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
                `SELECT id,username,phone,rating,game,role,account_status,auth_version,email,email_verified_at,created_at
                   FROM users WHERE id=$1 AND account_status='active' FOR UPDATE`,
                [recovery.user_id]
            );
            if (!account.rows.length || recovery.auth_version_at_approval == null ||
                Number(account.rows[0].auth_version) !== Number(recovery.auth_version_at_approval)) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This recovery link is invalid, expired, or not approved." });
            }

            const passwordHash = await bcrypt.hash(password, 12);
            const updatedAccount = await client.query(
                `UPDATE users SET password_hash=$1,auth_version=auth_version+1
                  WHERE id=$2
                  RETURNING id,username,phone,rating,game,role,account_status,auth_version,email,email_verified_at,created_at`,
                [passwordHash, recovery.user_id]
            );
            await client.query(
                "UPDATE password_reset_codes SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
                [recovery.user_id]
            );
            await client.query(
                `UPDATE password_recovery_requests
                    SET status='expired',secret_hash=$1
                  WHERE user_id=$2 AND id<>$3 AND status IN ('pending','approved')`,
                [hashSecret(crypto.randomBytes(32).toString("hex")), recovery.user_id, recovery.id]
            );
            await client.query(
                "UPDATE email_verification_requests SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
                [recovery.user_id]
            );
            await client.query(
                "UPDATE password_recovery_requests SET status='completed',completed_at=NOW(),secret_hash=$1 WHERE id=$2",
                [hashSecret(crypto.randomBytes(32).toString("hex")), recovery.id]
            );
            const user = updatedAccount.rows[0];
            user.role = publicAccountRole(user);
            const token = createToken(user);
            await client.query("COMMIT");
            transactionOpen = false;
            if (io) io.in("user_" + user.id).disconnectSockets(true);
            if (user.email && user.email_verified_at && typeof emailService.sendPasswordChangedNotice === "function") {
                Promise.resolve(emailService.sendPasswordChangedNotice(user.email, user.username))
                    .catch(function() { console.error("Password change notice delivery failed."); });
            }
            return res.json({
                success: true,
                message: "Password changed. You are now signed in.",
                token,
                user
            });
        } catch (error) {
            if (transactionOpen && client) await client.query("ROLLBACK").catch(function() {});
            console.error("Password reset failed:", error && error.code || "INTERNAL");
            return res.status(503).json({ success: false, message: "Could not reset the password. Please contact support and try again." });
        } finally {
            if (client) client.release();
        }
    });

    return router;
};
