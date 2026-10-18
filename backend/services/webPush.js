"use strict";

const crypto = require("crypto");
const path = require("path");
const webpush = require("web-push");

// Keep production secrets separate from the protected Daraja/database .env.
// Existing values in .env take precedence; this ignored file supplies only the
// Web Push settings when they are not already provided by the process.
require("dotenv").config({ path: path.join(__dirname, "..", ".env.webpush"), override: false });

const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const subject = String(process.env.VAPID_SUBJECT || "https://billgatesbrighton.github.io/complete-goal-and-gambit/").trim();
let configured = false;
let configurationError = null;

if (publicKey && privateKey) {
    try {
        if (!/^(mailto:[^\s]+|https:\/\/[^\s]+)$/i.test(subject)) {
            throw new Error("VAPID_SUBJECT must be a mailto: or HTTPS URL.");
        }
        webpush.setVapidDetails(subject, publicKey, privateKey);
        configured = true;
    } catch (error) {
        configurationError = error.message;
    }
} else if (publicKey || privateKey) {
    configurationError = "Both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required.";
}

function safeTargetPath(matchId, page) {
    const id = Number(matchId);
    if (page === "chess" && (!Number.isSafeInteger(id) || id <= 0)) return "pages/chess.html";
    if (page === "match-hub" || !Number.isSafeInteger(id) || id <= 0) return "pages/match-hub.html";
    const allowedPage = page === "match-results" ? "match-results" : "match-room";
    return "pages/" + allowedPage + ".html?matchId=" + encodeURIComponent(String(id));
}

function clickToken(eventId) {
    const secret = String(process.env.JWT_SECRET || "");
    if (!secret) return "";
    return crypto.createHmac("sha256", secret).update("gg-push-click:" + String(eventId)).digest("hex");
}

async function enqueueNotification(client, userId, notification) {
    const recipientId = Number(userId);
    const matchId = notification.matchId == null ? null : Number(notification.matchId);
    const eventKey = String(notification.eventKey || "").trim();
    const title = String(notification.title || "GOAL$GAMBIT").trim().slice(0, 160);
    const body = String(notification.body || "You have a match update.").trim().slice(0, 240);
    if (!Number.isSafeInteger(recipientId) || recipientId <= 0 ||
        (matchId !== null && (!Number.isSafeInteger(matchId) || matchId <= 0)) ||
        !eventKey || eventKey.length > 180 || !title || !body) {
        throw new Error("Invalid push notification event.");
    }
    const targetPath = safeTargetPath(matchId, notification.page);
    const inserted = await client.query(
        `INSERT INTO push_notification_events
            (user_id, match_id, event_key, title, body, target_path)
         SELECT $1, $2, $3, $4, $5, $6
          WHERE NOT EXISTS (
              SELECT 1 FROM push_notification_events
               WHERE user_id=$1 AND event_key=$3
          )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [recipientId, matchId, eventKey, title, body, targetPath]
    );
    let eventId = inserted.rows[0] && Number(inserted.rows[0].id);
    if (!eventId) {
        const existing = await client.query(
            "SELECT id FROM push_notification_events WHERE user_id=$1 AND event_key=$2",
            [recipientId, eventKey]
        );
        eventId = existing.rows[0] && Number(existing.rows[0].id);
    }
    if (!eventId) throw new Error("Push notification event could not be saved.");
    if (inserted.rows.length && notification.androidOnly !== true) {
        await client.query(
            `INSERT INTO push_delivery_jobs (event_id, subscription_id)
             SELECT $1, s.id FROM push_subscriptions s
              WHERE s.user_id=$2 AND s.active=TRUE
                AND NOT EXISTS (
                    SELECT 1 FROM push_delivery_jobs j
                     WHERE j.event_id=$1 AND j.subscription_id=s.id
                )
             ON CONFLICT DO NOTHING`,
            [eventId, recipientId]
        );
    }
    return { id: eventId, created: inserted.rows.length > 0 };
}

function createWebPushService(pool) {
    let timer = null;
    let running = false;

    async function sendOne(job) {
        const payload = {
            title: job.title,
            body: job.body,
            type: job.event_key,
            eventId: Number(job.event_id),
            matchId: job.match_id == null ? null : Number(job.match_id),
            targetPath: safeTargetPath(job.match_id, job.target_path === "pages/chess.html" ? "chess"
                : job.target_path && job.target_path.indexOf("match-results.html") !== -1 ? "match-results" : "match-room"),
            clickToken: clickToken(job.event_id),
            trackingUrl: /^https:\/\//i.test(String(process.env.PUBLIC_BASE_URL || ""))
                ? String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, "") + "/api/push/click" : null,
            tag: "goal-gambit-event-" + job.event_id
        };
        let result = { status: "failed", httpStatus: null, error: null, retry: false, deactivate: false };
        try {
            const response = await webpush.sendNotification(job.subscription, JSON.stringify(payload), {
                TTL: 3600,
                urgency: "high"
            });
            result = { status: "accepted", httpStatus: Number(response.statusCode) || 201, error: null, retry: false, deactivate: false };
        } catch (error) {
            const status = Number(error.statusCode) || null;
            const retry = !status || status === 408 || status === 425 || status === 429 || status >= 500;
            result = {
                status: retry && job.attempt_count < 8 ? "queued" : "failed",
                httpStatus: status,
                error: status === 404 || status === 410 ? "Push subscription expired." : "Push service rejected the delivery.",
                retry: retry && job.attempt_count < 8,
                deactivate: status === 404 || status === 410
            };
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO push_delivery_attempts (job_id, attempt_number, outcome, http_status, error_summary)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (job_id, attempt_number) DO NOTHING`,
                [job.id, job.attempt_count, result.status === "accepted" ? "accepted" : result.status, result.httpStatus, result.error]
            );
            const delaySeconds = Math.min(3600, 15 * Math.pow(2, Math.max(0, job.attempt_count - 1)));
            await client.query(
                `UPDATE push_delivery_jobs
                    SET status=$2,
                        next_attempt_at=CASE WHEN $3 THEN NOW() + ($4::int * INTERVAL '1 second') ELSE next_attempt_at END,
                        accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE accepted_at END,
                        last_http_status=$5,
                        last_error=$6,
                        updated_at=NOW()
                  WHERE id=$1`,
                [job.id, result.status, result.retry, delaySeconds, result.httpStatus, result.error]
            );
            if (result.deactivate) {
                await client.query("UPDATE push_subscriptions SET active=FALSE, updated_at=NOW() WHERE id=$1", [job.subscription_id]);
                await client.query("UPDATE push_delivery_jobs SET status='failed', updated_at=NOW() WHERE subscription_id=$1 AND status='queued'", [job.subscription_id]);
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Push delivery status could not be saved.");
        } finally {
            client.release();
        }
    }

    async function sendPendingJobs() {
        if (!configured || running) return;
        running = true;
        const client = await pool.connect();
        let jobs = [];
        try {
            await client.query("BEGIN");
            await client.query(
                `UPDATE push_delivery_jobs SET status='queued', updated_at=NOW()
                  WHERE status='sending' AND updated_at < NOW() - INTERVAL '2 minutes'`
            );
            const selected = await client.query(
                `SELECT j.id, j.event_id, j.subscription_id, j.attempt_count,
                        e.event_key, e.match_id, e.title, e.body, e.target_path,
                        s.endpoint, s.p256dh, s.auth
                   FROM push_delivery_jobs j
                   JOIN push_notification_events e ON e.id=j.event_id
                   JOIN push_subscriptions s ON s.id=j.subscription_id AND s.active=TRUE
                  WHERE j.status='queued' AND j.next_attempt_at <= NOW()
                  ORDER BY j.created_at, j.id
                  LIMIT 20
                  FOR UPDATE OF j SKIP LOCKED`
            );
            jobs = selected.rows.map((row) => ({
                ...row,
                id: Number(row.id),
                event_id: Number(row.event_id),
                subscription_id: Number(row.subscription_id),
                attempt_count: Number(row.attempt_count) + 1,
                subscription: { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
            }));
            for (const job of jobs) {
                await client.query("UPDATE push_delivery_jobs SET status='sending', attempt_count=attempt_count+1, updated_at=NOW() WHERE id=$1", [job.id]);
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Push delivery queue could not be read.");
            return;
        } finally {
            client.release();
        }

        try {
            for (const job of jobs) await sendOne(job);
        } finally {
            running = false;
        }
    }

    function start() {
        if (!configured) {
            if (configurationError) console.error("Web Push is not configured: " + configurationError);
            return false;
        }
        if (!timer) {
            timer = setInterval(sendPendingJobs, 5000);
            timer.unref();
            sendPendingJobs().catch(() => {});
        }
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function status() {
        return { configured, publicKey: configured ? publicKey : null };
    }

    return { enqueueNotification, sendPendingJobs, start, stop, status, clickToken };
}

module.exports = createWebPushService;
module.exports.safeTargetPath = safeTargetPath;
module.exports.clickToken = clickToken;
