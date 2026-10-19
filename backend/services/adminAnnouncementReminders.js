"use strict";

function formatEventAt(value, timeZone) {
    try {
        return new Intl.DateTimeFormat("en-KE", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: timeZone || "Africa/Nairobi"
        }).format(new Date(value));
    } catch (_) {
        return new Date(value).toISOString();
    }
}

function dueReminderPhase(announcement, now) {
    if (!announcement.event_at) return null;
    const minutesUntil = (new Date(announcement.event_at).getTime() - now) / 60000;
    if (minutesUntil < -15) return null;
    if (minutesUntil <= 15 && !announcement.reminder_start_sent_at) return "start";
    if (minutesUntil <= 60 && minutesUntil > 15 && !announcement.reminder_1h_sent_at) return "1h";
    if (minutesUntil <= 24 * 60 && minutesUntil > 60 && !announcement.reminder_24h_sent_at) return "24h";
    return null;
}

async function enqueueAnnouncementToAudience(client, pushService, announcement, phase) {
    if (!pushService || typeof pushService.enqueueNotification !== "function") return 0;
    const recipients = await client.query(
        `SELECT id FROM users
          WHERE account_status='active'
            AND ($1='all'
                 OR ($1='chess' AND game IN ('chess','both'))
                 OR ($1='konami' AND game IN ('konami','both')))
          ORDER BY id`,
        [announcement.audience || "all"]
    );
    const id = Number(announcement.id);
    const eventName = String(announcement.event_name || "").trim();
    const maintenanceSuffix = /maintenance/i.test(eventName) ? ":maintenance" : "";
    const scheduleRevision = announcement.event_at ? new Date(announcement.event_at).getTime() : 0;
    const eventKey = phase === "publish"
        ? "admin-announcement:" + id + maintenanceSuffix
        : "admin-announcement:" + id + ":reminder:" + phase + ":" + scheduleRevision + maintenanceSuffix;
    let title;
    let body;
    if (phase === "publish") {
        title = eventName ? "GOAL$GAMBIT — " + eventName : "GOAL$GAMBIT — Announcement";
        body = announcement.message;
    } else {
        const when = formatEventAt(announcement.event_at, announcement.event_time_zone);
        title = phase === "start" ? "GOAL$GAMBIT — Event starting" : "GOAL$GAMBIT — Upcoming event";
        body = "Reminder: " + (eventName || "An important GOAL$GAMBIT event") +
            " is scheduled for " + when + ". Open GOAL$GAMBIT and check your Match Hub.";
    }

    let queued = 0;
    for (const recipient of recipients.rows) {
        const result = await pushService.enqueueNotification(client, Number(recipient.id), {
            eventKey,
            title: title.slice(0, 160),
            body: String(body).slice(0, 240),
            page: "match-hub"
        });
        if (result && result.created) queued += 1;
    }
    return queued;
}

function createAdminAnnouncementReminders(pool, pushService, options) {
    options = options || {};
    const intervalMs = Number(options.intervalMs) || 60000;
    let timer = null;
    let busy = false;

    async function processOne(id) {
        const client = await pool.connect();
        let queued = false;
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `SELECT id,message,event_name,event_at,event_time_zone,audience,
                        publish_at,published_at,reminder_24h_sent_at,
                        reminder_1h_sent_at,reminder_start_sent_at,active
                   FROM admin_announcements WHERE id=$1 FOR UPDATE`,
                [id]
            );
            const announcement = result.rows[0];
            if (!announcement || !announcement.active) {
                await client.query("ROLLBACK");
                return false;
            }
            const clock = await client.query("SELECT NOW() AS now");
            const now = new Date(clock.rows[0].now).getTime();
            let justPublished = false;
            if (!announcement.published_at && announcement.publish_at && new Date(announcement.publish_at).getTime() <= now) {
                queued = (await enqueueAnnouncementToAudience(client, pushService, announcement, "publish")) > 0;
                await client.query(
                    "UPDATE admin_announcements SET published_at=NOW() WHERE id=$1 AND published_at IS NULL",
                    [id]
                );
                justPublished = true;
            }

            if (announcement.published_at || justPublished) {
                const phase = dueReminderPhase(announcement, now);
                if (phase) {
                    const marker = phase === "24h" ? "reminder_24h_sent_at"
                        : phase === "1h" ? "reminder_1h_sent_at" : "reminder_start_sent_at";
                    const publishedRecently = announcement.published_at &&
                        now - new Date(announcement.published_at).getTime() < 5 * 60 * 1000;
                    if (justPublished || publishedRecently) {
                        // The newly delivered announcement is itself the reminder
                        // for this window. Mark it so the next sweep cannot duplicate it.
                        await client.query("UPDATE admin_announcements SET " + marker + "=NOW() WHERE id=$1", [id]);
                    } else {
                        queued = (await enqueueAnnouncementToAudience(client, pushService, announcement, phase)) > 0 || queued;
                        await client.query("UPDATE admin_announcements SET " + marker + "=NOW() WHERE id=$1", [id]);
                    }
                }
            }
            await client.query("COMMIT");
            return queued;
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            console.error("Admin announcement delivery could not be queued.");
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
                `SELECT id FROM admin_announcements
                  WHERE active=TRUE AND (
                    (published_at IS NULL AND publish_at IS NOT NULL AND publish_at<=NOW())
                    OR (published_at IS NOT NULL AND event_at<=NOW()+INTERVAL '24 hours'
                        AND event_at>=NOW()-INTERVAL '15 minutes'
                        AND ((event_at>NOW()+INTERVAL '60 minutes' AND reminder_24h_sent_at IS NULL)
                          OR (event_at<=NOW()+INTERVAL '60 minutes' AND event_at>NOW()+INTERVAL '15 minutes' AND reminder_1h_sent_at IS NULL)
                          OR (event_at<=NOW()+INTERVAL '15 minutes' AND reminder_start_sent_at IS NULL)))
                  )
                  ORDER BY COALESCE(publish_at,event_at),id LIMIT 100`
            );
            for (const row of due.rows) {
                if (await processOne(Number(row.id))) queued = true;
            }
        } catch (error) {
            console.error("Admin announcement reminder sweep failed.");
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

    return { start, stop, tick, processOne };
}

module.exports = createAdminAnnouncementReminders;
module.exports.enqueueAnnouncementToAudience = enqueueAnnouncementToAudience;
module.exports.dueReminderPhase = dueReminderPhase;
module.exports.formatEventAt = formatEventAt;
