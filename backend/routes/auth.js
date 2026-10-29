"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const rateLimit = require("../middleware/rateLimit");
const { publicAccountRole } = require("../middleware/adminAuthorization");
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


function createToken(user) {

    if (!process.env.JWT_SECRET) {
        throw new Error(
            "JWT_SECRET is not configured."
        );
    }


    return jwt.sign(
        {
            userId: user.id,
            username: user.username,
            authVersion: Number(user.auth_version || 0)
        },
        process.env.JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );

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

// ROUTES
// ======================================================

module.exports = function(pool, authenticateToken, io) {


    // ==================================================
    // REGISTER
    // ==================================================

    router.post(
        "/register",
        registerLimiter,
        async function(req, res) {

            const client =
                await pool.connect();


            try {

                let {
                    username,
                    phone,
                    password,
                    game,
                    chessRating
                } = req.body;

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
                        LIMIT 1
                        `,
                        [
                            username,
                            phone
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
                            "Username or phone number already exists."

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
                            $5
                        )
                        RETURNING
                            id,
                            username,
                            phone,
                            rating,
                            game,
                            role,
                            account_status,
                            suspended_until,
                            auth_version,
                            created_at
                        `,
                        [
                            username,
                            phone,
                            passwordHash,
                            startRating,
                            game
                        ]
                    );


                const user =
                    userResult.rows[0];


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


                // -------------------------------
                // TOKEN
                // -------------------------------

                const token =
                    createToken(user);

                user.role = publicAccountRole(user);


                res.status(201).json({

                    success: true,

                    message:
                        "Account created successfully.",

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

                if (error.code === "23505") {
                    return res.status(409).json({
                        success: false,
                        message: "Username or phone number already exists."
                    });
                }


                res.status(500).json({

                    success: false,

                    message:
                        "Failed to create account."

                });


            } finally {

                client.release();

            }

        }
    );


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
                        message: constraint.includes("phone")
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
