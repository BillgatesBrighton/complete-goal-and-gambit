"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createEfootballScheduler = require("../services/efootballScheduler");
const { eatDateTimeToUtc } = require("../services/efootballScheduleRules");

async function runSchedulerAt(hour, minute) {
    const sqlLog = [];
    const now = eatDateTimeToUtc(2026, 10, 21, hour, minute);
    const query = async (sql) => {
        const statement = String(sql).trim();
        sqlLog.push(statement);
        if (statement.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
        if (statement === "SELECT NOW() AS now") return { rows: [{ now }] };
        return { rows: [], rowCount: 0 };
    };
    const pool = {
        connect: async () => ({ query, release() {} }),
        query
    };
    const scheduler = createEfootballScheduler(pool, null, null);
    await scheduler.run();
    return sqlLog;
}

test("scheduler keeps unfinished rounds active through 12:59 AM EAT", async () => {
    const sqlLog = await runSchedulerAt(0, 59);
    assert.equal(sqlLog.some(sql => /SELECT id,(tournament_id|league_id) AS parent_id,round_number FROM efootball_(tournament|league)_rounds/.test(sql)), false);
});

test("scheduler begins carrying unfinished rounds after the 1:00 AM EAT session boundary", async () => {
    const sqlLog = await runSchedulerAt(1, 0);
    assert.equal(sqlLog.some(sql => sql.includes("FROM efootball_tournament_rounds") && sql.includes("parent_id")), true);
    assert.equal(sqlLog.some(sql => sql.includes("FROM efootball_league_rounds") && sql.includes("parent_id")), true);
});
