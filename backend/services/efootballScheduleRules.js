"use strict";

const TIME_ZONE = "Africa/Nairobi";
const OPEN_MINUTE = 16 * 60;
const MATCHMAKING_CUTOFF_MINUTE = 50;
const SESSION_END_MINUTE = 60;

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
});

function partsInEat(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("A valid date is required.");
    const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const second = Number(parts.second);
    return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        minuteOfDay: hour * 60 + minute,
        date: `${parts.year}-${parts.month}-${parts.day}`
    };
}

function eatDateTimeToUtc(year, month, day, hour, minute, second = 0) {
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    // Determine the IANA zone's offset at the desired local time. This avoids
    // relying on the Windows/Node process timezone or a hard-coded UTC offset.
    const guess = new Date(desiredAsUtc);
    const zoned = Object.fromEntries(partsFormatter.formatToParts(guess).map((part) => [part.type, part.value]));
    const zonedAsUtc = Date.UTC(
        Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day),
        Number(zoned.hour), Number(zoned.minute), Number(zoned.second)
    );
    return new Date(desiredAsUtc - (zonedAsUtc - desiredAsUtc));
}

function shiftDate(year, month, day, days) {
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function getEfootballScheduleState(now = new Date()) {
    const local = partsInEat(now);
    const minute = local.minuteOfDay;
    const isMatchmakingOpen = minute >= OPEN_MINUTE || minute < MATCHMAKING_CUTOFF_MINUTE;
    const isSessionActive = minute >= OPEN_MINUTE || minute < SESSION_END_MINUTE;
    const nextOpenDate = minute < OPEN_MINUTE
        ? { year: local.year, month: local.month, day: local.day }
        : shiftDate(local.year, local.month, local.day, 1);
    const nextCloseDate = minute >= MATCHMAKING_CUTOFF_MINUTE
        ? shiftDate(local.year, local.month, local.day, 1)
        : { year: local.year, month: local.month, day: local.day };
    const sessionDate = minute < SESSION_END_MINUTE
        ? shiftDate(local.year, local.month, local.day, -1)
        : { year: local.year, month: local.month, day: local.day };
    const nextSessionEndDate = minute >= OPEN_MINUTE
        ? shiftDate(local.year, local.month, local.day, 1)
        : { year: local.year, month: local.month, day: local.day };

    return {
        timeZone: TIME_ZONE,
        localDate: local.date,
        localTime: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(local.second).padStart(2, "0")}`,
        minuteOfDay: minute,
        isMatchmakingOpen,
        isSessionActive,
        status: isMatchmakingOpen ? "open" : isSessionActive ? "matchmaking_closed_session_active" : "closed",
        nextOpensAt: eatDateTimeToUtc(nextOpenDate.year, nextOpenDate.month, nextOpenDate.day, 16, 0).toISOString(),
        nextClosesAt: eatDateTimeToUtc(nextCloseDate.year, nextCloseDate.month, nextCloseDate.day, 0, 50).toISOString(),
        sessionEndsAt: isSessionActive
            ? eatDateTimeToUtc(nextSessionEndDate.year, nextSessionEndDate.month, nextSessionEndDate.day, 1, 0).toISOString()
            : null,
        sessionDate: `${sessionDate.year}-${String(sessionDate.month).padStart(2, "0")}-${String(sessionDate.day).padStart(2, "0")}`
    };
}

function getNextOpeningAt(now = new Date()) {
    return getEfootballScheduleState(now).nextOpensAt;
}

module.exports = {
    TIME_ZONE,
    OPEN_MINUTE,
    MATCHMAKING_CUTOFF_MINUTE,
    SESSION_END_MINUTE,
    partsInEat,
    eatDateTimeToUtc,
    getEfootballScheduleState,
    getNextOpeningAt
};
