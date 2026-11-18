"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");

const envFile = path.resolve(__dirname, "..", "..", ".env.security-test");
const loaded = dotenv.config({ path: envFile, override: true, quiet: true });
if (loaded.error) {
    throw new Error("Security integration test settings are missing. Provision backend/.env.security-test first.");
}

// Validate the dedicated settings before launching any PostgreSQL-backed test.
require("./config").readConfig(process.env);

const testFiles = [
    "test/security-integration/config.test.js",
    "test/security-integration/auth-sessions.postgres.test.js",
    "test/security-integration/account-status-sessions.postgres.test.js",
    "test/security-integration/mpesa-stk-callback.postgres.test.js",
    "test/security-integration/gameplay-http-logout.postgres.test.js",
    "test/security-integration/wallet-mutations.postgres.test.js",
    "test/security-integration/league-mutations.postgres.test.js",
    "test/security-integration/tournament-mutations.postgres.test.js",
    "test/security-integration/chess-competition-mutations.postgres.test.js",
    "test/security-integration/chess-tournament-scheduling.postgres.test.js",
    "test/security-integration/socket-sessions.postgres.test.js"
];

for (const testFile of testFiles) {
    const result = spawnSync(process.execPath, ["--test", testFile], {
        cwd: path.resolve(__dirname, "..", ".."),
        env: process.env,
        stdio: "inherit",
        windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
