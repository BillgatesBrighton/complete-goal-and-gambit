"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createAuthSessionCleanup = require("../services/authSessionCleanup");

test("expired session cleanup retains the 90-day audit window and never deletes active sessions", async () => {
    const now = Date.now();
    const sessions = [
        { id: "active", expires_at: new Date(now + 60_000), revoked_at: null },
        { id: "recent-expired", expires_at: new Date(now - 24 * 60 * 60 * 1000), revoked_at: null },
        { id: "old-expired", expires_at: new Date(now - 91 * 24 * 60 * 60 * 1000), revoked_at: null },
        { id: "old-revoked", expires_at: new Date(now - 100 * 24 * 60 * 60 * 1000), revoked_at: new Date(now - 99 * 24 * 60 * 60 * 1000) }
    ];
    const pool = {
        async query(sql, params) {
            assert.match(sql, /FOR UPDATE SKIP LOCKED/);
            assert.equal(params[0], 90);
            const retentionCutoff = Date.now() - params[0] * 24 * 60 * 60 * 1000;
            const eligible = sessions.filter((row) => row.expires_at.getTime() < retentionCutoff)
                .sort((a, b) => a.expires_at - b.expires_at).slice(0, params[1]);
            for (const row of eligible) sessions.splice(sessions.indexOf(row), 1);
            return { rowCount: eligible.length, rows: eligible.map((row) => ({ id: row.id })) };
        }
    };
    const cleanup = createAuthSessionCleanup(pool, { batchSize: 1 });
    assert.equal(await cleanup.runOnce(), 1, "one bounded batch is removed per run");
    assert.equal(await cleanup.runOnce(), 1, "the next scheduled batch can remove the next old row");
    assert.deepEqual(sessions.map((row) => row.id).sort(), ["active", "recent-expired"]);
    cleanup.stop();
});

test("session cleanup scheduler starts once and can be stopped", () => {
    const cleanup = createAuthSessionCleanup({ query: async () => ({ rowCount: 0, rows: [] }) }, { intervalMs: 60_000 });
    cleanup.start();
    cleanup.start();
    cleanup.stop();
    cleanup.stop();
});
