"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const rateLimit = require("../middleware/rateLimit");
const { publicAccountRole } = require("../middleware/adminAuthorization");
const createToken = require("../services/authToken");
const defaultEmailService = require("../services/emailService");
const router = express.Router();

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts. Please wait 15 minutes."
});

const accountChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6,
    message: "Too many account changes. Please wait 15 minutes."
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "Too many accounts created from this connection. Try again later."
});

const emailVerificationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 4,
    message: "Too many email verification requests. Please wait before trying again."
});

const emailVerificationAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many email verification attempts. Please wait before trying again."
});


// ======================================================
// HELPERS
// ======================================================

function normalizeUsername(value) {

    return String(value || "")
        .trim()
        .toLowerCase();

}


function normalizePhone(value) {

    return String(value || "")
        .trim();

}


// ======================================================
function normalizePhoneForSms(value) {
    let phone = String(value || "").trim().replace(/[()\s-]/g, "");
    if (phone.startsWith("00")) phone = "+" + phone.slice(2);
    if (/^0[17]\d{8}$/.test(phone)) phone = "+254" + phone.slice(1);
    else if (/^254[17]\d{8}$/.test(phone)) phone = "+" + phone;
    else if (/^[1-9]\d{8,14}$/.test(phone)) phone = "+" + phone;
    return /^\+[1-9]\d{8,14}$/.test(phone) ? phone : null;
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function hashEmailToken(secret) {
    return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function makeEmailToken(pageEnvName) {
    let pageText = String(process.env[pageEnvName] || "").trim();
    if (!pageText && pageEnvName === "EMAIL_VERIFICATION_FRONTEND_URL") {
        try { pageText = new URL("verify-email.html", process.env.PASSWORD_RESET_FRONTEND_URL).toString(); }
        catch (_) {}
    }
    let pageUrl;
    try {
        pageUrl = new URL(pageText);
        if (pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) return null;
        if (pageUrl.protocol !== "https:" && !(pageUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(pageUrl.hostname))) return null;
    } catch (_) { return null; }
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    pageUrl.hash = new URLSearchParams({ id, secret }).toString();
    return { id, secret, hash: hashEmailToken(secret), url: pageUrl.toString() };
}

function tokenMatches(expectedHash, secret) {
    if (!/^[a-f0-9]{64}$/i.test(String(expectedHash || ""))) return false;
    const expected = Buffer.from(expectedHash, "hex");
    const actual = Buffer.from(hashEmailToken(secret), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ROUTES
// ======================================================

module.exports = function(pool, authenticateToken, io, options) {
    options = options || {};
    const emailService = options.emailService || defaultEmailService;


    // ==================================================
    // REGISTER
    // ==================================================

    router.post(
        "/register",
        registerLimiter,
        async function(req, res) {
            let client;
            try {

                let {
                    username,
                    phone,
                    password,
                    email,
                    game,
                    chessRating
                } = req.body || {};

                email = normalizeEmail(email);
                game = String(game || "").trim().toLowerCase();
                if (!["chess", "konami", "both"].includes(game)) {
                    return res.status(400).json({
                        success: false,
                        message: "Please choose a game (Chess, eFootball or Both)."
                    });
                }

                // Chess rating the player declares at sign up.
                // eFootball-only players keep the default and never see it.
                let startRating = 1200;
                if (game === "chess" || game === "both") {
                    startRating = Number(chessRating);
                    if (!Number.isInteger(startRating) || startRating < 100 || startRating > 3000) {
                        return res.status(400).json({
                            success: false,
                            message: "Enter your chess rating as a whole number between 100 and 3000."
                        });
                    }
                }


                username =
                    normalizeUsername(username);

                phone =
                    normalizePhone(phone);

                if (!isValidEmail(email)) {
                    return res.status(400).json({
                        success: false,
                        message: "Enter a valid email address."
                    });
                }


                // -------------------------------
                // VALIDATION
                // -------------------------------

                if (
                    !username ||
                    !phone ||
                    !password
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Username, phone and password are required."

                    });

                }


                if (
                    username.length < 3 ||
                    username.length > 30
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Username must contain 3 to 30 characters."

                    });

                }


                if (
                    !/^[a-z0-9_]+$/.test(username)
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Username may contain only letters, numbers and underscores."

                    });

                }


                if (typeof password !== "string") {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid password."
                    });
                }

                if (!/^\+?[0-9]{9,15}$/.test(phone.replace(/[\s-]/g, ""))) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Enter a valid phone number."
                    });
                }

                if (password.length > 128) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Password is too long."
                    });
                }

                if (password.length < 8) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Password must be at least 8 characters."

                    });

                }

                if (!emailService || typeof emailService.isConfigured !== "function" || !emailService.isConfigured()) {
                    return res.status(503).json({
                        success: false,
                        message: "Email verification is temporarily unavailable. Please try again later."
                    });
                }
                const verification = makeEmailToken("EMAIL_VERIFICATION_FRONTEND_URL");
                if (!verification) {
                    return res.status(503).json({
                        success: false,
                        message: "Email verification is temporarily unavailable. Please try again later."
                    });
                }

                client = await pool.connect();


                // -------------------------------
                // BEGIN TRANSACTION
                // -------------------------------

                await client.query("BEGIN");


                // -------------------------------
                // DUPLICATE CHECK
                // -------------------------------

                const existingUser =
                    await client.query(
                        `
                        SELECT id
                        FROM users
                        WHERE username = $1
                           OR phone = $2
                           OR (LOWER(email) = $3 AND email_verified_at IS NOT NULL)
                        LIMIT 1
                        `,
                        [
                            username,
                            phone,
                            email
                        ]
                    );


                if (
                    existingUser.rows.length > 0
                ) {

                    await client.query(
                        "ROLLBACK"
                    );


                    return res.status(409).json({

                        success: false,

                        message:
                            "Username, phone number or email is already linked to an account."

                    });

                }


                // -------------------------------
                // PASSWORD HASH
                // -------------------------------

                const passwordHash =
                    await bcrypt.hash(
                        password,
                        12
                    );


                // -------------------------------
                // CREATE USER
                // -------------------------------

                const userResult =
                    await client.query(
                        `
                        INSERT INTO users
                        (
                            username,
                            phone,
                            email,
                            password_hash,
                            rating,
                            game
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6
                        )
                        RETURNING
                            id,
                            username,
                            phone,
                            email,
                            rating,
                            game,
                            role,
                            account_status,
                            suspended_until,
                            auth_version,
                            email_verified_at,
                            created_at
                        `,
                        [
                            username,
                            phone,
                            email,
                            passwordHash,
                            startRating,
                            game
                        ]
                    );


                const user =
                    userResult.rows[0];

                await client.query(
                    `INSERT INTO email_verification_requests
                        (id,user_id,email,token_hash,expires_at)
                     VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 minutes')`,
                    [verification.id, user.id, email, verification.hash]
                );


                // -------------------------------
                // CREATE WALLET
                // -------------------------------

                await client.query(
                    `
                    INSERT INTO wallets
                    (
                        user_id,
                        balance,
                        locked_balance,
                        currency
                    )
                    VALUES
                    (
                        $1,
                        0.00,
                        0.00,
                        'KES'
                    )
                    `,
                    [user.id]
                );


                // -------------------------------
                // COMMIT
                // -------------------------------

                await client.query("COMMIT");

                let emailVerificationSent = true;
                try {
                    await emailService.sendVerificationEmail(email, username, verification.url);
                } catch (_) {
                    emailVerificationSent = false;
                    await pool.query(
                        "UPDATE email_verification_requests SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL",
                        [verification.id]
                    ).catch(function() {});
                    console.error("Registration email verification delivery failed.");
                }


                // -------------------------------
                // TOKEN
                // -------------------------------

                const token =
                    createToken(user);

                user.role = publicAccountRole(user);


                res.status(201).json({

                    success: true,

                    message:
                        emailVerificationSent
                            ? "Account created. Check your email to verify your address."
                            : "Account created, but the verification email could not be sent. Sign in and request another verification link from Account settings.",

                    emailVerificationSent,

                    token,

                    user

                });


            } catch (error) {

                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch (rollbackError) {
                    console.error(
                        "Registration rollback error:",
                        rollbackError.message
                    );
                }


                console.error(
                    "Registration error:",
                    error.message
                );

                if (error && error.code === "23505") {
                    const constraint = String(error.constraint || "").toLowerCase();
                    return res.status(409).json({
                        success: false,
                        message: constraint.includes("email")
                            ? "That email address is already linked to an account."
                            : "Username or phone number already exists."
                    });
                }


                res.status(500).json({

                    success: false,

                    message:
                        "Failed to create account."

                });


            } finally {

                if (client) client.release();

            }

        }
    );

    router.post("/email/verify", emailVerificationAttemptLimiter, async function(req, res) {
        const body = req.body || {};
        const id = String(body.id || "").trim();
        const secret = String(body.secret || "").trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
            !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
            return res.status(400).json({ success: false, message: "This verification link is invalid or expired." });
        }

        let client;
        let transactionOpen = false;
        let previousEmail = null;
        let account = null;
        let verifiedEmail = null;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            transactionOpen = true;
            const request = await client.query(
                `SELECT id,user_id,email,token_hash,expires_at,consumed_at
                   FROM email_verification_requests WHERE id=$1 FOR UPDATE`,
                [id]
            );
            if (!request.rows.length || !tokenMatches(request.rows[0].token_hash, secret) ||
                request.rows[0].consumed_at || new Date(request.rows[0].expires_at) <= new Date()) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This verification link is invalid or expired." });
            }

            const row = request.rows[0];
            const userResult = await client.query(
                "SELECT id,username,email,email_verified_at FROM users WHERE id=$1 AND account_status='active' FOR UPDATE",
                [row.user_id]
            );
            if (!userResult.rows.length) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(400).json({ success: false, message: "This verification link is invalid or expired." });
            }
            account = userResult.rows[0];
            previousEmail = account.email_verified_at ? account.email : null;
            verifiedEmail = normalizeEmail(row.email);
            const updated = await client.query(
                "UPDATE users SET email=$1,email_verified_at=NOW() WHERE id=$2 AND account_status='active' RETURNING email_verified_at",
                [verifiedEmail, account.id]
            );
            await client.query(
                "UPDATE email_verification_requests SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
                [account.id]
            );
            await client.query("COMMIT");
            transactionOpen = false;

            if (previousEmail && previousEmail.toLowerCase() !== verifiedEmail) {
                try { await emailService.sendEmailChangedNotice(previousEmail, account.username, verifiedEmail); }
                catch (_) { console.error("Email address change notice delivery failed."); }
            }
            return res.json({
                success: true,
                message: "Email address verified successfully.",
                email: verifiedEmail,
                emailVerifiedAt: updated.rows[0].email_verified_at
            });
        } catch (error) {
            if (transactionOpen && client) await client.query("ROLLBACK").catch(function() {});
            if (error && error.code === "23505") {
                return res.status(409).json({ success: false, message: "That email address is already linked to another account." });
            }
            console.error("Email verification failed:", error && error.code || "INTERNAL");
            return res.status(503).json({ success: false, message: "Could not verify this email. Please try again later." });
        } finally {
            if (client) client.release();
        }
    });

    router.post("/email/request-verification", authenticateToken, emailVerificationLimiter, async function(req, res) {
        const body = req.body || {};
        const email = normalizeEmail(body.email);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Enter a valid email address." });
        if (!currentPassword) return res.status(400).json({ success: false, message: "Enter your current password to confirm this email change." });
        if (!emailService || typeof emailService.isConfigured !== "function" || !emailService.isConfigured()) {
            return res.status(503).json({ success: false, message: "Email verification is temporarily unavailable. Please try again later." });
        }
        const verification = makeEmailToken("EMAIL_VERIFICATION_FRONTEND_URL");
        if (!verification) return res.status(503).json({ success: false, message: "Email verification is temporarily unavailable. Please try again later." });

        let client;
        let transactionOpen = false;
        let account;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            transactionOpen = true;
            const userResult = await client.query(
                `SELECT id,username,email,email_verified_at,password_hash
                   FROM users WHERE id=$1 AND account_status='active' FOR UPDATE`,
                [req.user.userId]
            );
            if (!userResult.rows.length) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(404).json({ success: false, message: "Active account not found." });
            }
            account = userResult.rows[0];
            if (!(await bcrypt.compare(currentPassword, account.password_hash))) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(401).json({ success: false, message: "Current password is incorrect." });
            }
            if (account.email_verified_at && normalizeEmail(account.email) === email) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(409).json({ success: false, message: "That email address is already verified on your account." });
            }
            const duplicate = await client.query(
                "SELECT id FROM users WHERE LOWER(email)=$1 AND email_verified_at IS NOT NULL AND id<>$2 LIMIT 1",
                [email, account.id]
            );
            if (duplicate.rows.length) {
                await client.query("ROLLBACK");
                transactionOpen = false;
                return res.status(409).json({ success: false, message: "That email address is already linked to another account." });
            }

            await client.query(
                "UPDATE email_verification_requests SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
                [account.id]
            );
            await client.query(
                `INSERT INTO email_verification_requests(id,user_id,email,token_hash,expires_at)
                 VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 minutes')`,
                [verification.id, account.id, email, verification.hash]
            );
            await client.query("COMMIT");
            transactionOpen = false;
        } catch (error) {
            if (transactionOpen && client) await client.query("ROLLBACK").catch(function() {});
            console.error("Email verification request failed:", error && error.code || "INTERNAL");
            return res.status(503).json({ success: false, message: "Could not request email verification. Please try again later." });
        } finally {
            if (client) client.release();
        }

        try {
            await emailService.sendVerificationEmail(email, account.username, verification.url);
            return res.status(202).json({ success: true, message: "Check that email address for a verification link. It expires in 30 minutes." });
        } catch (_) {
            await pool.query(
                "UPDATE email_verification_requests SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL",
                [verification.id]
            ).catch(function() {});
            console.error("Account email verification delivery failed.");
            return res.status(503).json({ success: false, message: "The verification email could not be sent. Please try again later." });
        }
    });


    // ==================================================
    // LOGIN
    // ==================================================

    router.post(
        "/login",
        loginLimiter,
        async function(req, res) {

            try {

                const username =
                    normalizeUsername(
                        req.body.username
                    );

                const password =
                    String(
                        req.body.password || ""
                    );


                if (
                    !username ||
                    !password
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Username and password are required."

                    });

                }


                const result =
                    await pool.query(
                        `
                        SELECT
                            id,
                            username,
                            phone,
                            password_hash,
                            rating,
                            game,
                            role,
                            account_status,
                            suspended_until,
                            auth_version,
                            email,
                            email_verified_at,
                            created_at
                        FROM users
                        WHERE username = $1
                        `,
                        [username]
                    );


                if (
                    result.rows.length === 0
                ) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid username or password."

                    });

                }


                const user =
                    result.rows[0];

                const passwordMatch =
                    await bcrypt.compare(
                        password,
                        user.password_hash
                    );


                if (!passwordMatch) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid username or password."

                    });

                }

                // Check moderation only after the password is verified so
                // the login endpoint does not reveal account state to an
                // unauthenticated caller. Include suspended_until in the
                // query above so timed suspensions can expire normally.
                if (user.account_status === "closed") {
                    return res.status(403).json({
                        success: false,
                        message: "This account has been closed."
                    });
                }

                if (user.account_status === "suspended") {
                    if (user.suspended_until && new Date(user.suspended_until) <= new Date()) {
                        const activated = await pool.query(
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
                            const current = await pool.query(
                                "SELECT account_status, suspended_until FROM users WHERE id = $1",
                                [user.id]
                            );
                            if (!current.rows.length || current.rows[0].account_status !== "active") {
                                return res.status(403).json({
                                    success: false,
                                    message: current.rows[0] && current.rows[0].account_status === "closed"
                                        ? "This account has been closed."
                                        : "This account is currently suspended.",
                                    suspendedUntil: current.rows[0] && current.rows[0].suspended_until
                                });
                            }
                            Object.assign(user, current.rows[0]);
                        }
                    } else {
                        return res.status(403).json({
                            success: false,
                            message: "This account is currently suspended.",
                            suspendedUntil: user.suspended_until
                        });
                    }
                }


                const token =
                    createToken(user);


                res.json({

                    success: true,

                    message:
                        "Login successful.",

                    token,

                    user: {

                        id:
                            user.id,

                        username:
                            user.username,

                        phone:
                            user.phone,

                        email:
                            user.email,

                        email_verified_at:
                            user.email_verified_at,

                        rating:
                            user.rating,

                        game:
                            user.game,

                        role:
                            publicAccountRole(user),

                        account_status:
                            user.account_status,

                        created_at:
                            user.created_at

                    }

                });


            } catch (error) {

                console.error(
                    "Login error:",
                    error.message
                );


                res.status(500).json({

                    success: false,

                    message:
                        "Login failed."

                });

            }

        }
    );


    // Signed-in users can update their username and/or password after
    // re-entering the current password. A version bump invalidates old JWTs.
    router.patch(
        "/account",
        authenticateToken,
        accountChangeLimiter,
        async function(req, res) {
            const body = req.body || {};
            const currentPassword = typeof body.currentPassword === "string"
                ? body.currentPassword
                : "";
            const usernameProvided = Object.prototype.hasOwnProperty.call(body, "username");
            const username = usernameProvided ? normalizeUsername(body.username) : "";
            const phoneProvided = Object.prototype.hasOwnProperty.call(body, "phone");
            const phone = phoneProvided ? normalizePhoneForSms(body.phone) : null;
            const gameProvided = Object.prototype.hasOwnProperty.call(body, "game");
            const game = gameProvided ? String(body.game || "").trim().toLowerCase() : "";
            const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
            const changesPassword = newPassword.length > 0;

            if (!currentPassword) {
                return res.status(400).json({ success: false, message: "Enter your current password to confirm this change." });
            }
            if (!usernameProvided && !phoneProvided && !gameProvided && !changesPassword) {
                return res.status(400).json({ success: false, message: "Enter a new username, phone number, game, or password." });
            }
            if (usernameProvided && (!username || username.length < 3 || username.length > 30 || !/^[a-z0-9_]+$/.test(username))) {
                return res.status(400).json({ success: false, message: "Username must be 3–30 characters using letters, numbers, or underscores." });
            }
            if (changesPassword && (newPassword.length < 8 || newPassword.length > 128)) {
                return res.status(400).json({ success: false, message: "New password must be 8–128 characters." });
            }
            if (phoneProvided && !phone) {
                return res.status(400).json({ success: false, message: "Enter a valid phone number, including its country code if it is not Kenyan." });
            }
            if (gameProvided && !["chess", "konami", "both"].includes(game)) {
                return res.status(400).json({ success: false, message: "Choose Chess, eFootball, or Both games." });
            }

            try {
                const current = await pool.query(
                    `SELECT id,username,phone,password_hash,rating,game,role,auth_version
                     FROM users WHERE id=$1 AND account_status='active'`,
                    [req.user.userId]
                );
                if (!current.rows.length) {
                    return res.status(404).json({ success: false, message: "Active account not found." });
                }

                const user = current.rows[0];
                if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
                    return res.status(401).json({ success: false, message: "Current password is incorrect." });
                }

                const nextUsername = usernameProvided ? username : user.username;
                const nextPhone = phoneProvided ? phone : user.phone;
                const nextGame = gameProvided ? game : user.game;
                if (nextUsername === user.username && nextPhone === user.phone && nextGame === user.game && !changesPassword) {
                    return res.status(400).json({ success: false, message: "Enter a value that is different from your current account details." });
                }
                if (changesPassword && await bcrypt.compare(newPassword, user.password_hash)) {
                    return res.status(400).json({ success: false, message: "Choose a password you have not used for this account." });
                }

                const passwordHash = changesPassword
                    ? await bcrypt.hash(newPassword, 12)
                    : user.password_hash;
                const updated = await pool.query(
                    `UPDATE users
                     SET username=$1,phone=$2,game=$3,password_hash=$4,auth_version=auth_version+1
                     WHERE id=$5 AND account_status='active'
                     RETURNING id,username,phone,rating,game,role,auth_version`,
                    [nextUsername, nextPhone, nextGame, passwordHash, user.id]
                );
                if (!updated.rows.length) {
                    return res.status(404).json({ success: false, message: "Active account not found." });
                }

                const changedUser = updated.rows[0];
                const token = createToken(changedUser);
                changedUser.role = publicAccountRole(changedUser);
                if (io) io.in("user_" + changedUser.id).disconnectSockets(true);
                return res.json({
                    success: true,
                    message: "Account updated. Other sessions have been signed out.",
                    token,
                    user: changedUser
                });
            } catch (error) {
                if (error && error.code === "23505") {
                    const constraint = String(error.constraint || "").toLowerCase();
                    return res.status(409).json({
                        success: false,
                        message: constraint.includes("email")
                            ? "That email address is already linked to another account."
                            : constraint.includes("phone")
                                ? "That phone number is already linked to another account."
                                : "That username is already in use."
                    });
                }
                console.error("Account update error:", error && error.message);
                return res.status(500).json({ success: false, message: "Could not update account. Please try again." });
            }
        }
    );

    return router;

};
