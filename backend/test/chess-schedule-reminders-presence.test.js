"use strict";

const assert = require("node:assert/strict");
const createChessScheduleReminders = require("../services/chessScheduleReminders");

function fixture(presentUsers) {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const schedule = {
        id: 17,
        status: "accepted",
        host_user_id: 39,
        guest_user_id: 40,
        scheduled_at: new Date(now.getTime() + 5 * 60 * 1000),
        time_zone: "Africa/Nairobi",
        reminder_10m_sent_at: null,
        reminder_60m_sent_at: null,
        reminder_start_sent_at: null
    };
    const queued = [];
    const pool = {
        async query(sql) {
            if (/SELECT id FROM chess_scheduled_matches/i.test(String(sql))) {
                return { rows: schedule.reminder_10m_sent_at ? [] : [{ id: schedule.id }] };
            }
            throw new Error("Unexpected pool query: " + sql);
        },
        async connect() {
            return {
                async query(sql, params) {
                    const statement = String(sql);
                    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(statement)) return { rows: [] };
                    if (/SELECT s\.\* FROM chess_scheduled_matches/i.test(statement)) return { rows: [{ ...schedule }] };
                    if (/SELECT NOW\(\) AS now/i.test(statement)) return { rows: [{ now }] };
                    if (/UPDATE chess_scheduled_matches SET reminder_10m_sent_at=NOW\(\)/i.test(statement)) {
                        schedule.reminder_10m_sent_at = now;
                        return { rows: [] };
                    }
                    throw new Error("Unexpected client query: " + statement);
                },
                release() {}
            };
        }
    };
    const push = {
        async enqueueNotification(_client, userId, notification) { queued.push({ userId, notification }); },
        async sendPendingJobs() {}
    };
    return {
        queued,
        schedule,
        service: createChessScheduleReminders(pool, push, {
            isWebsitePresent: userId => presentUsers.includes(Number(userId))
        })
    };
}

(async function main() {
    const activeHost = fixture([39]);
    await activeHost.service.tick();
    assert.deepEqual(activeHost.queued.map(row => row.userId), [40], "only the player away from the website receives the personal reminder");
    assert.ok(activeHost.schedule.reminder_10m_sent_at, "a suppressed reminder phase is still marked to avoid duplicate delivery");
    await activeHost.service.tick();
    assert.equal(activeHost.queued.length, 1, "repeated sweeps do not duplicate a reminder");

    const nobodyPresent = fixture([]);
    await nobodyPresent.service.tick();
    assert.deepEqual(nobodyPresent.queued.map(row => row.userId), [39, 40], "both absent players receive their personal reminders");
    console.log("Chess schedule presence suppression tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
