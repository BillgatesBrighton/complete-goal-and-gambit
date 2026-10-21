"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getEfootballScheduleState, eatDateTimeToUtc } = require("../services/efootballScheduleRules");

function eat(year, month, day, hour, minute) {
    return eatDateTimeToUtc(year, month, day, hour, minute);
}

test("EAT matchmaking opens at 4:00 PM and accepts new searches before 12:50 AM", () => {
    const opening = getEfootballScheduleState(eat(2026, 10, 20, 16, 0));
    assert.equal(opening.isMatchmakingOpen, true);
    assert.equal(opening.isSessionActive, true);
    assert.equal(opening.status, "open");
    assert.equal(opening.nextClosesAt, eat(2026, 10, 21, 0, 50).toISOString());

    const lastMinute = getEfootballScheduleState(eat(2026, 10, 21, 0, 49));
    assert.equal(lastMinute.isMatchmakingOpen, true);
    assert.equal(lastMinute.sessionDate, "2026-10-20");
});

test("12:50 AM closes new matchmaking without ending the session before 1:00 AM", () => {
    const state = getEfootballScheduleState(eat(2026, 10, 21, 0, 50));
    assert.equal(state.isMatchmakingOpen, false);
    assert.equal(state.isSessionActive, true);
    assert.equal(state.status, "matchmaking_closed_session_active");
    assert.equal(state.nextOpensAt, eat(2026, 10, 21, 16, 0).toISOString());
    assert.equal(state.sessionDate, "2026-10-20");
});

test("1:00 AM ends the session and daytime reopens at 4:00 PM EAT", () => {
    const ended = getEfootballScheduleState(eat(2026, 10, 21, 1, 0));
    assert.equal(ended.isMatchmakingOpen, false);
    assert.equal(ended.isSessionActive, false);
    assert.equal(ended.nextOpensAt, eat(2026, 10, 21, 16, 0).toISOString());

    const daytime = getEfootballScheduleState(eat(2026, 10, 21, 13, 0));
    assert.equal(daytime.status, "closed");
    assert.equal(daytime.nextClosesAt, eat(2026, 10, 22, 0, 50).toISOString());
});

test("the timezone calculation is independent of the Windows process timezone", () => {
    const local = getEfootballScheduleState(new Date("2026-10-20T13:00:00.000Z"));
    assert.equal(local.localDate, "2026-10-20");
    assert.equal(local.localTime, "16:00:00");
    assert.equal(local.isMatchmakingOpen, true);
});
