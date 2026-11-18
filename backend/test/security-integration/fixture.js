"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { EXPECTED_DATABASE, EXPECTED_ROLE, PRODUCTION_DATABASE, readConfig } = require("./config");

function assertDatabaseIdentity(identity) {
    if (!identity || identity.database_name !== EXPECTED_DATABASE || identity.database_name === PRODUCTION_DATABASE ||
        identity.role_name !== EXPECTED_ROLE) {
        throw new Error("Refusing test database operation: PostgreSQL identity did not match the dedicated database and restricted role.");
    }
}

async function verifiedPool(config, options) {
    const pool = new Pool({ ...config, ...options });
    let client;
    try {
        client = await pool.connect();
        const identity = await client.query("SELECT current_database() AS database_name,current_user AS role_name");
        assertDatabaseIdentity(identity.rows[0]);
    } catch (error) {
        if (client) client.release();
        await pool.end().catch(() => {});
        if (/Refusing test database operation/.test(error.message)) throw error;
        throw new Error("Could not verify the dedicated PostgreSQL test database; no schema or test writes were attempted.");
    }
    if (client) client.release();
    return pool;
}

async function createFixture() {
    const config = readConfig();
    const bootstrapPool = await verifiedPool(config);
    const schema = "security_it_" + randomUUID().replace(/-/g, "");
    let schemaCreated = false;
    let appPool;
    let lockPool;
    try {
        await bootstrapPool.query('CREATE SCHEMA "' + schema + '"');
        schemaCreated = true;
        const scopedOptions = { options: "-c search_path=" + schema, max: 8 };
        appPool = await verifiedPool(config, scopedOptions);
        lockPool = await verifiedPool(config, scopedOptions);
        for (const [poolName, scopedPool] of [["application", appPool], ["Socket.IO lock", lockPool]]) {
            const schemaIdentity = await scopedPool.query(
                "SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name"
            );
            const identity = schemaIdentity.rows[0];
            if (!identity || identity.database_name !== EXPECTED_DATABASE ||
                identity.role_name !== EXPECTED_ROLE || identity.role_name !== config.user || identity.schema_name !== schema) {
                throw new Error("Refusing schema initialization: " + poolName + " pool identity/search_path did not match this run's dedicated database, role and unique schema.");
            }
        }

        // The per-run schema is newly created and empty. Apply the same complete
        // application schema file used by backend startup, inside one transaction.
        const client = await appPool.connect();
        try {
            await client.query("BEGIN");
            const schemaSql = fs.readFileSync(path.join(__dirname, "..", "..", "db", "schema.sql"), "utf8");
            await client.query(schemaSql);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        if (lockPool) await lockPool.end().catch(() => {});
        if (appPool) await appPool.end().catch(() => {});
        if (schemaCreated) await bootstrapPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(() => {});
        await bootstrapPool.end().catch(() => {});
        throw error;
    }

    let closed = false;
    return {
        database: EXPECTED_DATABASE,
        schema,
        pool: appPool,
        lockPool,
        async close() {
            if (closed) return;
            closed = true;
            await lockPool.end();
            await appPool.end();
            const identity = await bootstrapPool.query("SELECT current_database() AS database_name");
            if (!identity.rows.length || identity.rows[0].database_name !== EXPECTED_DATABASE) {
                throw new Error("Refusing test cleanup: database identity changed before schema removal.");
            }
            await bootstrapPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
            await bootstrapPool.end();
        },
        async createUser(usernamePrefix) {
            const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
            const username = (usernamePrefix + suffix).slice(0, 30).toLowerCase();
            const phone = "+2547" + String(require("node:crypto").randomInt(10_000_000, 99_999_999));
            const result = await appPool.query(
                `INSERT INTO users(username,phone,password_hash,rating,game)
                 VALUES($1,$2,'integration-fixture-unused-hash',1200,'both') RETURNING id,username,phone`,
                [username, phone]
            );
            return result.rows[0];
        }
    };
}

module.exports = { assertDatabaseIdentity, createFixture, verifiedPool };
