"use strict";

const jwt = require("jsonwebtoken");

function createAuthToken(user) {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured.");
    return jwt.sign({
        userId: user.id,
        username: user.username,
        authVersion: Number(user.auth_version || 0)
    }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

module.exports = createAuthToken;
