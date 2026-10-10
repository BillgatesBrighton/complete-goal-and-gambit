"use strict";

// One-command database setup: npm run setup-db
// Credentials are loaded from backend/.env and are never printed.
const fs = require("fs");
const path = require("path");
const pg = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const repairDuplicateSupportThreads = require("./repairSupportThreads");
const config = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
};
const dbName = process.env.DB_NAME;
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

async function ensureDatabase() {
    if (!config.user || !dbName) {
        throw new Error("DB_USER and DB_NAME must be set in backend/.env");
    }
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
        throw new Error("DB_NAME may only contain letters, numbers and underscores.");
    }

    const admin = new pg.Client({ ...config, database: "postgres" });
    try {
        await admin.connect();
        const result = await admin.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [dbName]
        );
        if (result.rows.length === 0) {
            await admin.query('CREATE DATABASE "' + dbName + '"');
            console.log("Created the configured database.");
        } else {
            console.log("Configured database already exists.");
        }
    } finally {
        await admin.end().catch(() => {});
    }
}

async function setupSchema() {
    const db = new pg.Client({ ...config, database: dbName });
    try {
        await db.connect();
        await db.query("BEGIN");
        // Merge legacy duplicate support threads before the schema adds its
        // unique index. This preserves their messages and is safe to repeat.
        await repairDuplicateSupportThreads(db);
        await db.query(schema);
        await db.query(`
            INSERT INTO efootball_leagues (name, description, entry_stake)
            VALUES
                ('Bronze', 'Bronze eFootball league', 20),
                ('Silver', 'Silver eFootball league', 50),
                ('Gold', 'Gold eFootball league', 100)
            ON CONFLICT (name) DO NOTHING;

            INSERT INTO efootball_tournaments (name, tier, entry_fee, max_players, status)
            SELECT 'Bronze Tournament', 'bronze', 20, 16, 'open'
            WHERE NOT EXISTS (SELECT 1 FROM efootball_tournaments WHERE name = 'Bronze Tournament');
            INSERT INTO efootball_tournaments (name, tier, entry_fee, max_players, status)
            SELECT 'Silver Tournament', 'silver', 50, 16, 'open'
            WHERE NOT EXISTS (SELECT 1 FROM efootball_tournaments WHERE name = 'Silver Tournament');
            INSERT INTO efootball_tournaments (name, tier, entry_fee, max_players, status)
            SELECT 'Gold Tournament', 'gold', 100, 16, 'open'
            WHERE NOT EXISTS (SELECT 1 FROM efootball_tournaments WHERE name = 'Gold Tournament');
        `);
        await db.query("COMMIT");

        const tables = await db.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        );
        console.log("Tables ready: " + tables.rows.map(row => row.table_name).join(", "));
    } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        await db.end().catch(() => {});
    }
}

async function main() {
    await ensureDatabase();
    await setupSchema();
    console.log("\nDatabase setup complete. Now run: npm start");
}

main().catch(function (error) {
    console.error("\nSetup failed: " + error.message);
    if (/password authentication/i.test(error.message)) {
        console.error("-> Check the database login in backend/.env.");
    } else if (/ECONNREFUSED/.test(error.message)) {
        console.error("-> PostgreSQL is not running (or DB_HOST / DB_PORT is wrong).");
    }
    process.exit(1);
});
