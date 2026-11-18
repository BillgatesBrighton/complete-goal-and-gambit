"use strict";

const EXPECTED_DATABASE = "goal_gambit_security_test";
const EXPECTED_ROLE = "goal_gambit_security_test_user";
const PRODUCTION_DATABASE = "goal_gambit";

function readConfig(env) {
    env = env || process.env;
    if (env.GG_SECURITY_TEST_MODE !== "1") {
        throw new Error("Refusing PostgreSQL integration tests: set GG_SECURITY_TEST_MODE=1 explicitly.");
    }
    const database = String(env.SECURITY_TEST_DB_NAME || "").trim();
    if (database === PRODUCTION_DATABASE || database !== EXPECTED_DATABASE) {
        throw new Error("Refusing PostgreSQL integration tests: SECURITY_TEST_DB_NAME must exactly match the dedicated test database.");
    }
    const host = String(env.SECURITY_TEST_DB_HOST || "").trim();
    const user = String(env.SECURITY_TEST_DB_USER || "").trim();
    const password = String(env.SECURITY_TEST_DB_PASSWORD || "");
    const port = Number(env.SECURITY_TEST_DB_PORT || 5432);
    if (!host || user !== EXPECTED_ROLE || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Refusing PostgreSQL integration tests: dedicated SECURITY_TEST_DB_* connection settings are incomplete.");
    }
    return {
        host,
        port,
        user,
        password,
        database: EXPECTED_DATABASE,
        ssl: env.SECURITY_TEST_DB_SSL === "1" ? { rejectUnauthorized: true } : false,
        max: 8,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000
    };
}

module.exports = { EXPECTED_DATABASE, EXPECTED_ROLE, PRODUCTION_DATABASE, readConfig };
