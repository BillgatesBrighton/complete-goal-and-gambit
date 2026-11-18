"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EXPECTED_DATABASE, EXPECTED_ROLE, readConfig } = require("./config");
const { assertDatabaseIdentity } = require("./fixture");

const valid = {
    GG_SECURITY_TEST_MODE: "1",
    SECURITY_TEST_DB_NAME: EXPECTED_DATABASE,
    SECURITY_TEST_DB_HOST: "127.0.0.1",
    SECURITY_TEST_DB_PORT: "5432",
    SECURITY_TEST_DB_USER: EXPECTED_ROLE,
    SECURITY_TEST_DB_PASSWORD: "not-a-real-secret"
};

test("test database configuration requires explicit mode and dedicated variables", () => {
    assert.throws(() => readConfig({ ...valid, GG_SECURITY_TEST_MODE: undefined }), /GG_SECURITY_TEST_MODE/);
    assert.throws(() => readConfig({ ...valid, SECURITY_TEST_DB_NAME: undefined }), /SECURITY_TEST_DB_NAME/);
    assert.throws(() => readConfig({
        GG_SECURITY_TEST_MODE: "1", DB_HOST: "localhost", DB_NAME: "goal_gambit", DB_USER: "x", DB_PASSWORD: "x"
    }), /SECURITY_TEST_DB_NAME/);
    assert.throws(() => readConfig({ ...valid, SECURITY_TEST_DB_NAME: "goal_gambit" }), /dedicated test database/);
    assert.throws(() => readConfig({ ...valid, SECURITY_TEST_DB_PASSWORD: "" }), /connection settings/);
    assert.throws(() => readConfig({ ...valid, SECURITY_TEST_DB_USER: "some_other_role" }), /connection settings/);
    const config = readConfig(valid);
    assert.equal(config.database, EXPECTED_DATABASE);
    assert.equal(config.host, "127.0.0.1");
});

test("database identity verification rejects missing, unknown, production, and non-dedicated roles", () => {
    assert.throws(() => assertDatabaseIdentity(null), /identity did not match/);
    assert.throws(() => assertDatabaseIdentity(undefined), /identity did not match/);
    assert.throws(() => assertDatabaseIdentity({ database_name: "goal_gambit" }), /identity did not match/);
    assert.throws(() => assertDatabaseIdentity({ database_name: "postgres" }), /identity did not match/);
    assert.throws(() => assertDatabaseIdentity({ database_name: EXPECTED_DATABASE }), /identity did not match/);
    assert.throws(() => assertDatabaseIdentity({ database_name: EXPECTED_DATABASE, role_name: "other_role" }), /identity did not match/);
    assert.doesNotThrow(() => assertDatabaseIdentity({ database_name: EXPECTED_DATABASE, role_name: EXPECTED_ROLE }));
});
