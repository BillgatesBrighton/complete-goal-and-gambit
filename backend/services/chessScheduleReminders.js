"use strict";

function formatScheduledAt(value, timeZone) {
    try {
        return new Intl.DateTimeFormat("en-KE", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timeZone || "Africa/Nairobi"
        }).format(new Date(value));
    } catch (_) {
        return new Date(value).toISOString();
    }
}

function createChessScheduleReminders(pool, pushService, options) {
    options = options || {};
    const intervalMs = Number(options.intervalMs) || 60000;
    const isWebsitePresent = typeof options.isWebsitePresent === "function"
        ? options.isWebsitePresent
        : function () { return false; };
    let timer = null;
    let busy = false;

    async function processOne(scheduleId) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `SELECT s.* FROM chess_scheduled_matches s
                  WHERE s.id=$1 FOR UPDATE OF s`,
                [scheduleId]
            );
            const schedule = result.rows[0];
            if (!schedule || schedule.status !== "accepted") {
                await client.query("ROLLBACK");
                return false;
            }

            const clock = await client.query("SELECT NOW() AS now");
            const now = new Date(clock.rows[0].now).getTime();
            const startsAt = new Date(schedule.scheduled_at).getTime();
            const minutesUntil = (startsAt - now) / 60000;
            let phase = null;
            let marker = null;
            if (minutesUntil <= 0 && minutesUntil >= -15 && !schedule.reminder_start_sent_at) {
                phase = "start";
                marker = "reminder_start_sent_at";
            } else if (minutesUntil > 0 && minutesUntil <= 10 && !schedule.reminder_10m_sent_at) {
                phase = "10m";
                marker = "reminder_10m_sent_at";
            } else if (minutesUntil > 10 && minutesUntil <= 60 && !schedule.reminder_60m_sent_at) {
                phase = "60m";
                marker = "reminder_60m_sent_at";
            }
            if (!phase) {
                await client.query("ROLLBACK");
                return false;
            }

            const timestamp = formatScheduledAt(schedule.scheduled_at, schedule.time_zone);
            const scheduleRevision = new Date(schedule.scheduled_at).getTime();
            const title = phase === "start" ? "Your Chess match is ready to start"
                : phase === "10m" ? "Your Chess match starts in 10 minutes"
                : "Your Chess match is coming up";
            const userIds = [Number(schedule.host_user_id), Number(schedule.guest_user_id)];
            for (const userId of userIds) {
                // A visible authenticated website session can already show the
                // user's Match Hub. Suppress only this personal game reminder;
                // unrelated announcements and security notices are unaffected.
                if (isWebsitePresent(userId)) continue;
                const body = phase === "start"
                    ? "Your Chess game is scheduled for " + timestamp + ". Open GOAL$GAMBIT and check your Match Hub."
                    : phase === "10m"
                        ? "You have a Chess game coming up at " + timestamp + ". Open GOAL$GAMBIT to check your Match Hub."
                        : "You have an upcoming Chess game at " + timestamp + ". Open GOAL$GAMBIT and check your Match Hub.";
                await pushService.enqueueNotification(client, userId, {
                    eventKey: "chess-schedule-reminder-" + phase + ":" + schedule.id + ":" + scheduleRevision,
                    title: title,
                    body: body,
                    page: "chess"
                });
            }
            await client.query("UPDATE chess_scheduled_matches SET " + marker + "=NOW(),updated_at=NOW() WHERE id=$1", [scheduleId]);
            await client.query("COMMIT");
            return true;
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            console.error("Chess schedule reminder could not be queued.");
            return false;
        } finally {
            client.release();
        }
    }

    async function tick() {
        if (busy) return;
        busy = true;
        let queued = false;
        try {
            const due = await pool.query(
                `SELECT id FROM chess_scheduled_matches
                  WHERE status='accepted'
                    AND (
                        (scheduled_at > NOW()+INTERVAL '10 minutes' AND scheduled_at <= NOW()+INTERVAL '60 minutes' AND reminder_60m_sent_at IS NULL)
                        OR (scheduled_at > NOW() AND scheduled_at <= NOW()+INTERVAL '10 minutes' AND reminder_10m_sent_at IS NULL)
                        OR (scheduled_at <= NOW() AND scheduled_at >= NOW()-INTERVAL '15 minutes' AND reminder_start_sent_at IS NULL)
                    )
                  ORDER BY scheduled_at ASC,id ASC
                  LIMIT 100`
            );
            for (const row of due.rows) {
                if (await processOne(Number(row.id))) queued = true;
            }
        } catch (error) {
            console.error("Chess schedule reminder sweep failed.");
        } finally {
            busy = false;
        }
        if (queued && pushService && typeof pushService.sendPendingJobs === "function") {
            pushService.sendPendingJobs().catch(function () {});
        }
    }

    function start() {
        if (timer) return;
        tick();
        timer = setInterval(tick, intervalMs);
        if (typeof timer.unref === "function") timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, tick };
}

module.exports = createChessScheduleReminders;
