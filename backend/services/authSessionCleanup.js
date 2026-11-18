"use strict";

const RETENTION_DAYS = 90;
const BATCH_SIZE = 500;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createAuthSessionCleanup(pool, options) {
    options = options || {};
    const retentionDays = Number.isInteger(options.retentionDays) && options.retentionDays >= 90
        ? options.retentionDays : RETENTION_DAYS;
    const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 && options.batchSize <= BATCH_SIZE
        ? options.batchSize : BATCH_SIZE;
    const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs >= 60_000
        ? options.intervalMs : RUN_INTERVAL_MS;
    let timer = null;
    let running = false;

    async function runOnce() {
        if (running) return 0;
        running = true;
        try {
            const result = await pool.query(
                `WITH expired_batch AS (
                    SELECT id FROM auth_sessions
                     WHERE expires_at < NOW() - ($1::integer * INTERVAL '1 day')
                     ORDER BY expires_at
                     LIMIT $2
                     FOR UPDATE SKIP LOCKED
                 )
                 DELETE FROM auth_sessions s
                  USING expired_batch b
                  WHERE s.id=b.id
                 RETURNING s.id`,
                [retentionDays, batchSize]
            );
            return Number(result.rowCount || (result.rows && result.rows.length) || 0);
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer) return;
        // Retain security records for 90 days after token expiry. Cleanup is
        // batched and runs daily, never on an HTTP request or socket packet.
        timer = setInterval(() => {
            runOnce().catch((error) => {
                console.error("Expired authentication session cleanup failed:", error && error.message);
            });
        }, intervalMs);
        if (timer && typeof timer.unref === "function") timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { runOnce, start, stop };
}

module.exports = createAuthSessionCleanup;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
module.exports.BATCH_SIZE = BATCH_SIZE;
module.exports.RUN_INTERVAL_MS = RUN_INTERVAL_MS;
