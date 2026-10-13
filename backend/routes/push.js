"use strict";

const crypto = require("crypto");
const express = require("express");
const net = require("net");
const rateLimit = require("../middleware/rateLimit");

function cleanSubscription(value) {
    if (!value || typeof value !== "object") return null;
    const endpoint = String(value.endpoint || "").trim();
    const p256dh = String(value.keys && value.keys.p256dh || "").trim();
    const auth = String(value.keys && value.keys.auth || "").trim();
    let parsed;
    try { parsed = new URL(endpoint); } catch (_) { return null; }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || endpoint.length > 2048) return null;
    // Browser push services use public DNS names. Reject IP literals and
    // local-only names to prevent authenticated clients using delivery as SSRF.
    if (net.isIP(hostname) || hostname === "localhost" || /\.(?:localhost|local|internal|home|test)$/.test(hostname)) return null;
    if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,100}$/.test(auth)) return null;
    const expiry = value.expirationTime == null ? null : Number(value.expirationTime);
    if (expiry !== null && (!Number.isFinite(expiry) || expiry < 0 || expiry > 8640000000000000)) return null;
    return { endpoint, p256dh, auth, expiresAt: expiry === null ? null : new Date(expiry).toISOString() };
}

function cleanAndroidToken(value) {
    const raw = String(value || "");
    const token = raw.trim();
    if (raw !== token || token.length < 20 || token.length > 4096 ||
        token.split("").some(function (character) {
            const code = character.charCodeAt(0);
            return code < 33 || code === 127;
        })) return null;
    return token;
}

module.exports = function createPushRoutes(pool, authenticateToken, pushService) {
    const router = express.Router();
    const registerLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, message: "Too many notification setup requests. Please wait a minute." });
    const testLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: "You can send up to three test notifications per hour." });

    // This public key is safe to publish. The private VAPID key never leaves the backend.
    router.get("/vapid-public-key", (req, res) => {
        const status = pushService.status();
        return res.json({ success: true, configured: status.configured, publicKey: status.publicKey });
    });

    router.get("/status", authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                "SELECT COUNT(*)::int AS active_subscriptions FROM push_subscriptions WHERE user_id=$1 AND active=TRUE",
                [req.user.userId]
            );
            const android = await pool.query(
                "SELECT COUNT(*)::int AS active_subscriptions FROM android_push_tokens WHERE user_id=$1 AND active=TRUE",
                [req.user.userId]
            );
            const config = pushService.status();
            return res.json({
                success: true,
                configured: config.configured,
                androidConfigured: Boolean(config.androidConfigured),
                permissionRequired: true,
                activeSubscriptions: Number(result.rows[0].active_subscriptions || 0),
                activeAndroidDevices: Number(android.rows[0].active_subscriptions || 0)
            });
        } catch (error) {
            console.error("Push status query failed.");
            return res.status(500).json({ success: false, message: "Unable to load notification settings." });
        }
    });

    router.post("/subscriptions", authenticateToken, registerLimiter, async (req, res) => {
        const status = pushService.status();
        if (!status.configured) return res.status(503).json({ success: false, message: "Web Push is not configured on the backend yet." });
        const sub = cleanSubscription(req.body && (req.body.subscription || req.body));
        if (!sub) return res.status(400).json({ success: false, message: "The browser supplied an invalid push subscription." });
        const userAgent = String(req.get("user-agent") || "").slice(0, 300);
        try {
            const saved = await pool.query(
                `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, expiration_time, user_agent, active, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
                 ON CONFLICT (endpoint) DO UPDATE
                    SET p256dh=EXCLUDED.p256dh,
                        auth=EXCLUDED.auth,
                        expiration_time=EXCLUDED.expiration_time,
                        user_agent=EXCLUDED.user_agent,
                        active=TRUE,
                        updated_at=NOW()
                  WHERE push_subscriptions.user_id=EXCLUDED.user_id
                 RETURNING id`,
                [req.user.userId, sub.endpoint, sub.p256dh, sub.auth, sub.expiresAt, userAgent]
            );
            if (!saved.rows.length) {
                return res.status(409).json({ success: false, message: "This device notification subscription belongs to a different account. Disable it from that account first." });
            }
            return res.status(201).json({ success: true, registered: true });
        } catch (error) {
            console.error("Push subscription save failed.");
            return res.status(500).json({ success: false, message: "Unable to save this device's notification subscription." });
        }
    });

    router.delete("/subscriptions", authenticateToken, async (req, res) => {
        const endpoint = String(req.body && req.body.endpoint || "").trim();
        try {
            const result = endpoint
                ? await pool.query("UPDATE push_subscriptions SET active=FALSE, updated_at=NOW() WHERE user_id=$1 AND endpoint=$2 RETURNING id", [req.user.userId, endpoint])
                : await pool.query("UPDATE push_subscriptions SET active=FALSE, updated_at=NOW() WHERE user_id=$1 AND active=TRUE RETURNING id", [req.user.userId]);
            return res.json({ success: true, disabled: result.rowCount || 0 });
        } catch (error) {
            console.error("Push subscription disable failed.");
            return res.status(500).json({ success: false, message: "Unable to disable this device's notifications." });
        }
    });

    router.post("/android/subscriptions", authenticateToken, registerLimiter, async (req, res) => {
        if (!pushService.status().androidConfigured) {
            return res.status(503).json({ success: false, message: "Android push is not configured on the backend yet." });
        }
        const token = cleanAndroidToken(req.body && req.body.token);
        if (!token) return res.status(400).json({ success: false, message: "The Android push token is invalid." });
        const deviceId = String(req.body && req.body.deviceId || "").trim().slice(0, 80) || null;
        const deviceName = String(req.body && req.body.deviceName || "").trim().slice(0, 120) || null;
        try {
            const saved = await pool.query(
                "INSERT INTO android_push_tokens(user_id,token,device_id,device_name,active,updated_at) " +
                "VALUES($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT(token) DO UPDATE SET " +
                "device_id=EXCLUDED.device_id,device_name=EXCLUDED.device_name,active=TRUE,updated_at=NOW() " +
                "WHERE android_push_tokens.user_id=EXCLUDED.user_id RETURNING id",
                [req.user.userId, token, deviceId, deviceName]
            );
            if (!saved.rows.length) {
                return res.status(409).json({ success: false, message: "This device is registered to a different GOAL$GAMBIT account. Sign out of that account first." });
            }
            return res.status(201).json({ success: true, registered: true });
        } catch (error) {
            console.error("Android push token save failed.");
            return res.status(500).json({ success: false, message: "Unable to register this Android device." });
        }
    });

    router.delete("/android/subscriptions", authenticateToken, async (req, res) => {
        const token = req.body && req.body.token ? cleanAndroidToken(req.body.token) : null;
        if (req.body && req.body.token && !token) {
            return res.status(400).json({ success: false, message: "The Android push token is invalid." });
        }
        try {
            const result = token
                ? await pool.query("UPDATE android_push_tokens SET active=FALSE,updated_at=NOW() WHERE user_id=$1 AND token=$2 RETURNING id", [req.user.userId, token])
                : await pool.query("UPDATE android_push_tokens SET active=FALSE,updated_at=NOW() WHERE user_id=$1 AND active=TRUE RETURNING id", [req.user.userId]);
            return res.json({ success: true, disabled: result.rowCount || 0 });
        } catch (error) {
            console.error("Android push token disable failed.");
            return res.status(500).json({ success: false, message: "Unable to disable Android notifications." });
        }
    });

    router.get("/history", authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT e.id, e.title, e.body, e.match_id, e.event_key, e.target_path,
                        e.created_at, e.clicked_at, e.click_action,
                        COUNT(j.status)::int AS delivery_count,
                        COUNT(j.status) FILTER (WHERE j.status='accepted')::int AS accepted_count,
                        COUNT(j.status) FILTER (WHERE j.status='failed')::int AS failed_count,
                        COUNT(j.status) FILTER (WHERE j.status IN ('queued','sending'))::int AS pending_count
                   FROM push_notification_events e
                   LEFT JOIN LATERAL (
                       SELECT status FROM push_delivery_jobs WHERE event_id=e.id
                       UNION ALL
                       SELECT status FROM android_push_delivery_jobs WHERE event_id=e.id
                   ) j ON TRUE
                  WHERE e.user_id=$1
                  GROUP BY e.id
                  ORDER BY e.created_at DESC, e.id DESC
                  LIMIT 100`,
                [req.user.userId]
            );
            return res.json({ success: true, notifications: result.rows.map((row) => ({
                ...row,
                deliveryStatus: Number(row.delivery_count) === 0 ? "not_subscribed"
                    : Number(row.accepted_count) > 0 ? "accepted_by_push_service"
                    : Number(row.pending_count) > 0 ? "queued"
                    : "failed"
            })) });
        } catch (error) {
            console.error("Push notification history query failed.");
            return res.status(500).json({ success: false, message: "Unable to load notification history." });
        }
    });

    router.post("/test", authenticateToken, testLimiter, async (req, res) => {
        if (!pushService.status().configured) return res.status(503).json({ success: false, message: "Web Push is not configured on the backend yet." });
        try {
            const result = await pool.query("SELECT 1 FROM push_subscriptions WHERE user_id=$1 AND active=TRUE LIMIT 1", [req.user.userId]);
            if (!result.rows.length) return res.status(409).json({ success: false, message: "Enable notifications on this device first." });
            const client = await pool.connect();
            let event;
            try {
                await client.query("BEGIN");
                event = await pushService.enqueueNotification(client, req.user.userId, {
                    eventKey: "push-test:" + crypto.randomUUID(),
                    title: "GOAL$GAMBIT test notification",
                    body: "Web Push is connected to this account. This confirms service acceptance, not that the phone displayed it.",
                    page: "match-hub"
                });
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            } finally { client.release(); }
            pushService.sendPendingJobs().catch(() => {});
            return res.status(201).json({ success: true, eventId: event.id, message: "Test notification queued." });
        } catch (error) {
            console.error("Push test event failed.");
            return res.status(500).json({ success: false, message: "Unable to queue a test notification." });
        }
    });

    router.post("/android/test", authenticateToken, testLimiter, async (req, res) => {
        if (!pushService.status().androidConfigured) {
            return res.status(503).json({ success: false, message: "Android push is not configured on the backend yet." });
        }
        try {
            const active = await pool.query(
                "SELECT 1 FROM android_push_tokens WHERE user_id=$1 AND active=TRUE LIMIT 1",
                [req.user.userId]
            );
            if (!active.rows.length) {
                return res.status(409).json({ success: false, message: "Sign in to the Android companion app to register this device first." });
            }
            const client = await pool.connect();
            let event;
            try {
                await client.query("BEGIN");
                event = await pushService.enqueueNotification(client, req.user.userId, {
                    eventKey: "android-push-test:" + crypto.randomUUID(),
                    title: "GOAL$GAMBIT Android test",
                    body: "Android notifications are enabled for this account.",
                    page: "match-hub"
                });
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
            pushService.sendPendingJobs().catch(() => {});
            return res.status(201).json({ success: true, eventId: event.id, message: "Android test notification queued." });
        } catch (error) {
            console.error("Android push test could not be queued.");
            return res.status(500).json({ success: false, message: "Unable to queue an Android test notification." });
        }
    });

    // The click token is a per-event HMAC. This endpoint cannot read private
    // notification content and can only record an interaction for a real event.
    router.post("/click", async (req, res) => {
        const eventId = Number(req.body && req.body.eventId);
        const token = String(req.body && req.body.clickToken || "");
        const action = String(req.body && req.body.action || "open");
        if (!Number.isSafeInteger(eventId) || eventId <= 0 || !/^[a-f0-9]{64}$/i.test(token) || !["open", "send-code", "view-code", "results"].includes(action)) {
            return res.status(400).json({ success: false });
        }
        const expected = Buffer.from(pushService.clickToken(eventId), "hex");
        const provided = Buffer.from(token, "hex");
        if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return res.status(403).json({ success: false });
        try {
            await pool.query(
                `UPDATE push_notification_events
                    SET clicked_at=COALESCE(clicked_at,NOW()), click_action=COALESCE(click_action,$2)
                  WHERE id=$1 AND created_at > NOW() - INTERVAL '30 days'`,
                [eventId, action]
            );
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({ success: false });
        }
    });

    return router;
};

module.exports.cleanSubscription = cleanSubscription;
module.exports.cleanAndroidToken = cleanAndroidToken;
