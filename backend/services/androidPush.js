"use strict";

function configuredFirebaseMessaging(options) {
    if (options && options.messaging) {
        return { messaging: options.messaging, projectId: options.projectId || "test", error: null };
    }

    const projectId = String(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
    const hasCredentials = Boolean(
        String(process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim() ||
        process.env.K_SERVICE ||
        process.env.FUNCTIONS_EMULATOR
    );
    if (!projectId || !hasCredentials) {
        return {
            messaging: null,
            projectId: null,
            error: "Set FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS to enable Android push."
        };
    }

    try {
        const adminApp = require("firebase-admin/app");
        const adminMessaging = require("firebase-admin/messaging");
        const name = "goal-gambit-" + projectId;
        const app = adminApp.getApps().find(function (item) { return item.name === name; }) ||
            adminApp.initializeApp({
                credential: adminApp.applicationDefault(),
                projectId: projectId
            }, name);
        return { messaging: adminMessaging.getMessaging(app), projectId: projectId, error: null };
    } catch (error) {
        return { messaging: null, projectId: projectId, error: "Firebase Admin could not initialize." };
    }
}

function createAndroidPushService(pool, options) {
    const firebase = configuredFirebaseMessaging(options || {});
    const messaging = firebase.messaging;
    let timer = null;
    let running = false;

    async function enqueueNotification(client, eventId, userId) {
        if (!messaging) return false;
        try {
            await client.query(
                "INSERT INTO android_push_delivery_jobs(event_id,token_id) " +
                "SELECT $1,t.id FROM android_push_tokens t " +
                "WHERE t.user_id=$2 AND t.active=TRUE " +
                "AND NOT EXISTS (SELECT 1 FROM android_push_delivery_jobs j WHERE j.event_id=$1 AND j.token_id=t.id) " +
                "ON CONFLICT DO NOTHING",
                [Number(eventId), Number(userId)]
            );
            return true;
        } catch (error) {
            console.error("Android push job enqueue failed.");
            return false;
        }
    }

    async function sendOne(job) {
        let outcome = "failed";
        let errorCode = null;
        let deactivate = false;
        try {
            const data = {
                eventId: String(job.event_id),
                eventKey: String(job.event_key || ""),
                matchId: job.match_id == null ? "" : String(job.match_id),
                title: String(job.title || "GOAL$GAMBIT match update").slice(0, 120),
                body: String(job.body || "Open GOAL$GAMBIT to view your match update.").slice(0, 240),
                targetPath: String(job.target_path || "pages/match-hub.html")
            };
            await messaging.send({
                token: job.token,
                data: data,
                android: { priority: "high", ttl: 3600000 }
            });
            outcome = "accepted";
        } catch (error) {
            errorCode = String(error && error.code || "messaging/unknown-error").slice(0, 100);
            // Log the provider's stable error code (never the registration token)
            // so delivery failures can be distinguished from database failures.
            console.error("Firebase Android push send failed:", errorCode);
            deactivate = errorCode === "messaging/registration-token-not-registered" ||
                errorCode === "messaging/invalid-registration-token";
            const retryable = !deactivate && (
                errorCode.indexOf("server-unavailable") !== -1 ||
                errorCode.indexOf("internal-error") !== -1 ||
                errorCode.indexOf("quota-exceeded") !== -1 ||
                errorCode.indexOf("network-error") !== -1 ||
                errorCode.indexOf("unknown-error") !== -1
            );
            outcome = retryable && job.attempt_count < 8 ? "queued" : "failed";
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                "INSERT INTO android_push_delivery_attempts(job_id,attempt_number,outcome,error_summary) " +
                "VALUES($1,$2,$3,$4) ON CONFLICT(job_id,attempt_number) DO NOTHING",
                [job.id, job.attempt_count, outcome, errorCode ? "Firebase delivery error: " + errorCode : null]
            );
            const retry = outcome === "queued";
            const delaySeconds = Math.min(3600, 15 * Math.pow(2, Math.max(0, job.attempt_count - 1)));
            await client.query(
                "UPDATE android_push_delivery_jobs SET status=$2::varchar," +
                "next_attempt_at=CASE WHEN $3 THEN NOW()+($4::int*INTERVAL '1 second') ELSE next_attempt_at END," +
                "accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE accepted_at END," +
                "last_error=$5,updated_at=NOW() WHERE id=$1",
                [job.id, outcome, retry, delaySeconds, errorCode ? "Firebase delivery error: " + errorCode : null]
            );
            if (deactivate) {
                await client.query("UPDATE android_push_tokens SET active=FALSE,updated_at=NOW() WHERE id=$1", [job.token_id]);
                await client.query(
                    "UPDATE android_push_delivery_jobs SET status='failed',updated_at=NOW() " +
                    "WHERE token_id=$1 AND status='queued'",
                    [job.token_id]
                );
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            console.error("Android push delivery status could not be saved:", error && error.code || "database-error");
        } finally {
            client.release();
        }
    }

    async function sendPendingJobs() {
        if (!messaging || running) return;
        running = true;
        const client = await pool.connect();
        let jobs = [];
        try {
            await client.query("BEGIN");
            await client.query(
                "UPDATE android_push_delivery_jobs SET status='queued',updated_at=NOW() " +
                "WHERE status='sending' AND updated_at<NOW()-INTERVAL '2 minutes'"
            );
            const selected = await client.query(
                "SELECT j.id,j.event_id,j.token_id,j.attempt_count,e.event_key,e.match_id,e.title,e.body,e.target_path,t.token " +
                "FROM android_push_delivery_jobs j " +
                "JOIN push_notification_events e ON e.id=j.event_id " +
                "JOIN android_push_tokens t ON t.id=j.token_id AND t.active=TRUE " +
                "WHERE j.status='queued' AND j.next_attempt_at<=NOW() " +
                "ORDER BY j.created_at,j.id LIMIT 20 FOR UPDATE OF j SKIP LOCKED"
            );
            jobs = selected.rows.map(function (row) {
                return Object.assign({}, row, {
                    id: Number(row.id),
                    event_id: Number(row.event_id),
                    token_id: Number(row.token_id),
                    attempt_count: Number(row.attempt_count) + 1
                });
            });
            for (const job of jobs) {
                await client.query(
                    "UPDATE android_push_delivery_jobs SET status='sending',attempt_count=attempt_count+1,updated_at=NOW() WHERE id=$1",
                    [job.id]
                );
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            console.error("Android push queue could not be read.");
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
        if (!messaging) {
            if (firebase.error) console.info("Android push is not configured.");
            return false;
        }
        if (!timer) {
            timer = setInterval(sendPendingJobs, 5000);
            timer.unref();
            sendPendingJobs().catch(function () {});
        }
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function status() {
        return { configured: Boolean(messaging), projectId: messaging ? firebase.projectId : null };
    }

    return { enqueueNotification, sendPendingJobs, start, stop, status };
}

module.exports = createAndroidPushService;
