"use strict";

// Older schemas allowed multiple support threads per user because SQL UNIQUE
// constraints treat NULL values as distinct. Merge any legacy duplicates
// before the partial unique index is applied. All messages are moved to the
// oldest thread before redundant thread rows are removed.
async function repairDuplicateSupportThreads(db) {
    const tables = await db.query(
        `SELECT to_regclass('public.chat_threads') IS NOT NULL AS has_threads,
                to_regclass('public.chat_messages') IS NOT NULL AS has_messages`
    );
    if (!tables.rows[0].has_threads || !tables.rows[0].has_messages) return;

    const duplicates = await db.query(
        `SELECT user_one_id, MIN(id) AS keep_id,
                ARRAY_AGG(id ORDER BY id) AS ids
         FROM chat_threads
         WHERE thread_type = 'support' AND user_two_id IS NULL
         GROUP BY user_one_id
         HAVING COUNT(*) > 1`
    );

    for (const row of duplicates.rows) {
        const keepId = String(row.keep_id);
        const removeIds = row.ids.map(String).filter(id => id !== keepId);
        if (!removeIds.length) continue;

        await db.query(
            `UPDATE chat_messages
             SET thread_id = $1
             WHERE thread_id = ANY($2::bigint[])`,
            [keepId, removeIds]
        );
        await db.query(
            `DELETE FROM chat_threads WHERE id = ANY($1::bigint[])`,
            [removeIds]
        );
    }
}

module.exports = repairDuplicateSupportThreads;
