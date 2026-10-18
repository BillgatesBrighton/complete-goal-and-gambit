"use strict";

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("../middleware/rateLimit");

const GUIDE_VERSION = "2026-10-18-v1";
const RECENT_ACTIVITY_DAYS = 7;
const STALE_ACTIVITY_DAYS = 30;
const APK_PATH = path.resolve(__dirname, "../../frontend/downloads/goal-gambit-companion.apk");
const GRADLE_FILE = path.resolve(__dirname, "../../android/app/build.gradle.kts");
const installationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40, message: "Too many companion setup requests. Please try again later." });
const downloadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, message: "Too many app downloads. Please try again later." });
const publicDownloadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 24, message: "Too many app downloads. Please try again later." });

function cleanInstallationId(value) {
    const id = String(value || "").trim();
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ? id : null;
}

function cleanAppVersion(value) {
    const version = String(value || "").trim();
    return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(version) ? version : null;
}

function cleanPermissionStatus(value) {
    const status = String(value || "unknown").trim().toLowerCase();
    return ["granted", "denied", "unknown"].includes(status) ? status : null;
}

function installationHash(installationId) {
    return crypto.createHmac("sha256", String(process.env.JWT_SECRET || ""))
        .update("goal-gambit-companion-installation:" + installationId)
        .digest("hex");
}

let cachedApkMetadata = null;
function getApkMetadata() {
    try {
        const stat = fs.statSync(APK_PATH);
        if (cachedApkMetadata && cachedApkMetadata.mtimeMs === stat.mtimeMs && cachedApkMetadata.fileSize === stat.size) {
            return cachedApkMetadata;
        }
        const gradle = fs.readFileSync(GRADLE_FILE, "utf8");
        const versionMatch = gradle.match(/versionName\s*=\s*"([^"]+)"/);
        const hash = crypto.createHash("sha256").update(fs.readFileSync(APK_PATH)).digest("hex");
        cachedApkMetadata = {
            version: versionMatch ? versionMatch[1] : "unknown",
            fileSize: stat.size,
            sha256: hash,
            releaseDate: stat.mtime.toISOString(),
            mtimeMs: stat.mtimeMs
        };
        return cachedApkMetadata;
    } catch (_) {
        return null;
    }
}

module.exports = function createCompanionRoutes(pool, authenticateToken) {
    const router = express.Router();

    router.get("/profile", authenticateToken, (req, res) => {
        res.set("Cache-Control", "private, no-store");
        res.json({ success: true, username: String(req.user.username || "") });
    });

    router.get("/status", authenticateToken, async (req, res) => {
        try {
            const userId = Number(req.user.userId);
            const [setup, installation, download] = await Promise.all([
                pool.query(
                    `SELECT onboarding_version,onboarding_acknowledged_at
                       FROM companion_user_setup WHERE user_id=$1`, [userId]
                ),
                pool.query(
                    `SELECT EXISTS(SELECT 1 FROM companion_installations WHERE user_id=$1) AS ever_registered,
                            EXISTS(SELECT 1 FROM companion_installations WHERE user_id=$1 AND unregistered_at IS NULL) AS currently_registered,
                            (SELECT registered_at FROM companion_installations WHERE user_id=$1 ORDER BY registered_at ASC LIMIT 1) AS registered_at,
                            (SELECT last_seen_at FROM companion_installations WHERE user_id=$1 ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC LIMIT 1) AS last_seen_at,
                            (SELECT app_version FROM companion_installations WHERE user_id=$1 ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC LIMIT 1) AS app_version,
                            (SELECT device_platform FROM companion_installations WHERE user_id=$1 ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC LIMIT 1) AS device_platform,
                            (SELECT notification_permission_status FROM companion_installations WHERE user_id=$1 ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC LIMIT 1) AS notification_permission_status,
                            (SELECT notification_permission_checked_at FROM companion_installations WHERE user_id=$1 ORDER BY (unregistered_at IS NULL) DESC,updated_at DESC,id DESC LIMIT 1) AS notification_permission_checked_at`,
                    [userId]
                ),
                pool.query(
                    `SELECT MIN(downloaded_at) AS downloaded_at,MAX(last_downloaded_at) AS last_downloaded_at
                       FROM companion_download_events WHERE user_id=$1`, [userId]
                )
            ]);
            const savedSetup = setup.rows[0] || {};
            const app = installation.rows[0] || {};
            const downloads = download.rows[0] || {};
            const apk = getApkMetadata();
            res.set("Cache-Control", "private, no-store");
            return res.json({
                success: true,
                guideVersion: GUIDE_VERSION,
                onboardingAcknowledgedAt: savedSetup.onboarding_version === GUIDE_VERSION ? savedSetup.onboarding_acknowledged_at : null,
                onboardingAcknowledgedVersion: savedSetup.onboarding_version || null,
                needsAcknowledgement: savedSetup.onboarding_version !== GUIDE_VERSION,
                apk: apk ? {
                    version: apk.version,
                    fileSize: apk.fileSize,
                    sha256: apk.sha256,
                    releaseDate: apk.releaseDate,
                    downloadUrl: "/api/companion/download"
                } : null,
                download: {
                    downloaded: Boolean(downloads.downloaded_at),
                    downloadedAt: downloads.downloaded_at || null,
                    lastDownloadedAt: downloads.last_downloaded_at || null
                },
                companion: {
                    status: app.currently_registered ? "registered" : app.ever_registered ? "previously_registered" : "not_detected",
                    registeredAt: app.registered_at || null,
                    lastSeenAt: app.last_seen_at || null,
                    appVersion: app.app_version || null,
                    platform: app.device_platform || null,
                    notificationPermissionStatus: app.notification_permission_status || "unknown",
                    notificationPermissionCheckedAt: app.notification_permission_checked_at || null,
                    recentlyActive: Boolean(app.currently_registered && app.last_seen_at && Date.now() - new Date(app.last_seen_at).getTime() <= RECENT_ACTIVITY_DAYS * 86400000),
                    staleAfterDays: STALE_ACTIVITY_DAYS
                }
            });
        } catch (error) {
            console.error("Companion account status lookup failed.");
            return res.status(500).json({ success: false, message: "Unable to load companion setup status." });
        }
    });

    router.post("/acknowledge", authenticateToken, installationLimiter, async (req, res) => {
        const version = String(req.body && req.body.version || "").trim();
        if (version !== GUIDE_VERSION) {
            return res.status(400).json({ success: false, message: "This welcome guide version is no longer current. Reload the guide and acknowledge the latest version." });
        }
        try {
            const result = await pool.query(
                `INSERT INTO companion_user_setup(user_id,onboarding_version,onboarding_acknowledged_at,updated_at)
                 VALUES($1,$2,NOW(),NOW())
                 ON CONFLICT(user_id) DO UPDATE SET
                    onboarding_version=EXCLUDED.onboarding_version,
                    onboarding_acknowledged_at=NOW(),updated_at=NOW()
                 RETURNING onboarding_acknowledged_at`,
                [req.user.userId, GUIDE_VERSION]
            );
            res.set("Cache-Control", "private, no-store");
            return res.json({ success: true, version: GUIDE_VERSION, acknowledgedAt: result.rows[0].onboarding_acknowledged_at });
        } catch (error) {
            console.error("Companion welcome-guide acknowledgement failed.");
            return res.status(500).json({ success: false, message: "Could not save the guide acknowledgement." });
        }
    });

    router.post("/register", authenticateToken, installationLimiter, async (req, res) => {
        const installationId = cleanInstallationId(req.body && req.body.installationId);
        const appVersion = cleanAppVersion(req.body && req.body.appVersion);
        const platform = String(req.body && req.body.platform || "android").trim().toLowerCase();
        const permissionStatus = cleanPermissionStatus(req.body && req.body.notificationPermissionStatus);
        if (!installationId || !appVersion || platform !== "android" || !permissionStatus) {
            return res.status(400).json({ success: false, message: "Companion installation details are invalid." });
        }
        const hash = installationHash(installationId);
        let client;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            await client.query(
                `UPDATE companion_installations SET unregistered_at=NOW(),updated_at=NOW()
                  WHERE installation_id_hash=$1 AND user_id<>$2 AND unregistered_at IS NULL`,
                [hash, req.user.userId]
            );
            const saved = await client.query(
                `INSERT INTO companion_installations(
                    user_id,installation_id_hash,device_platform,app_version,last_seen_at,
                    notification_permission_status,notification_permission_checked_at,unregistered_at,updated_at
                 ) VALUES($1,$2,$3,$4,NOW(),$5,NOW(),NULL,NOW())
                 ON CONFLICT(user_id,installation_id_hash) DO UPDATE SET
                    device_platform=EXCLUDED.device_platform,app_version=EXCLUDED.app_version,
                    last_seen_at=NOW(),notification_permission_status=EXCLUDED.notification_permission_status,
                    notification_permission_checked_at=NOW(),unregistered_at=NULL,updated_at=NOW()
                 RETURNING id,registered_at,last_seen_at`,
                [req.user.userId, hash, platform, appVersion, permissionStatus]
            );
            await client.query("COMMIT");
            res.set("Cache-Control", "private, no-store");
            return res.status(201).json({ success: true, registered: true, registeredAt: saved.rows[0].registered_at, lastSeenAt: saved.rows[0].last_seen_at });
        } catch (error) {
            if (client) await client.query("ROLLBACK").catch(() => {});
            console.error("Companion installation registration failed.");
            return res.status(500).json({ success: false, message: "Unable to register this companion installation." });
        } finally {
            if (client) client.release();
        }
    });

    router.post("/heartbeat", authenticateToken, installationLimiter, async (req, res) => {
        const installationId = cleanInstallationId(req.body && req.body.installationId);
        const appVersion = cleanAppVersion(req.body && req.body.appVersion);
        if (!installationId || !appVersion) return res.status(400).json({ success: false, message: "Companion heartbeat details are invalid." });
        try {
            const result = await pool.query(
                `UPDATE companion_installations SET last_seen_at=NOW(),app_version=$3,updated_at=NOW()
                  WHERE user_id=$1 AND installation_id_hash=$2 AND unregistered_at IS NULL
                 RETURNING last_seen_at`,
                [req.user.userId, installationHash(installationId), appVersion]
            );
            if (!result.rows.length) return res.status(404).json({ success: false, message: "This companion installation is not registered to the signed-in account." });
            res.set("Cache-Control", "private, no-store");
            return res.json({ success: true, lastSeenAt: result.rows[0].last_seen_at });
        } catch (error) {
            console.error("Companion heartbeat failed.");
            return res.status(500).json({ success: false, message: "Unable to update companion activity." });
        }
    });

    router.post("/notification-status", authenticateToken, installationLimiter, async (req, res) => {
        const installationId = cleanInstallationId(req.body && req.body.installationId);
        const status = cleanPermissionStatus(req.body && req.body.status);
        if (!installationId || !status) return res.status(400).json({ success: false, message: "Notification permission details are invalid." });
        try {
            const result = await pool.query(
                `UPDATE companion_installations SET notification_permission_status=$3,
                    notification_permission_checked_at=NOW(),updated_at=NOW()
                  WHERE user_id=$1 AND installation_id_hash=$2 AND unregistered_at IS NULL
                 RETURNING notification_permission_status,notification_permission_checked_at`,
                [req.user.userId, installationHash(installationId), status]
            );
            if (!result.rows.length) return res.status(404).json({ success: false, message: "This companion installation is not registered to the signed-in account." });
            res.set("Cache-Control", "private, no-store");
            return res.json({ success: true, status: result.rows[0].notification_permission_status, checkedAt: result.rows[0].notification_permission_checked_at });
        } catch (error) {
            console.error("Companion notification-permission update failed.");
            return res.status(500).json({ success: false, message: "Unable to update notification permission status." });
        }
    });

    router.post("/unregister", authenticateToken, installationLimiter, async (req, res) => {
        const installationId = cleanInstallationId(req.body && req.body.installationId);
        if (!installationId) return res.status(400).json({ success: false, message: "Companion installation id is invalid." });
        try {
            const result = await pool.query(
                `UPDATE companion_installations SET unregistered_at=COALESCE(unregistered_at,NOW()),updated_at=NOW()
                  WHERE user_id=$1 AND installation_id_hash=$2 AND unregistered_at IS NULL RETURNING id`,
                [req.user.userId, installationHash(installationId)]
            );
            res.set("Cache-Control", "private, no-store");
            return res.json({ success: true, unregistered: result.rowCount > 0 });
        } catch (error) {
            console.error("Companion installation sign-out failed.");
            return res.status(500).json({ success: false, message: "Unable to unlink this companion installation." });
        }
    });

    router.get("/download", authenticateToken, downloadLimiter, (req, res) => {
        const metadata = getApkMetadata();
        if (!metadata) return res.status(503).json({ success: false, message: "The Android companion download is unavailable." });
        res.set({
            "Cache-Control": "private, no-store",
            "Content-Type": "application/vnd.android.package-archive",
            "X-Content-Type-Options": "nosniff",
            "X-Companion-SHA256": metadata.sha256,
            "X-Companion-Version": metadata.version
        });
        res.download(APK_PATH, "goal-gambit-companion.apk", async (error) => {
            if (error) {
                if (!res.headersSent) return res.status(500).json({ success: false, message: "The companion APK could not be served." });
                return;
            }
            try {
                await pool.query(
                    `INSERT INTO companion_download_events(user_id,apk_sha256,downloaded_at,last_downloaded_at)
                     VALUES($1,$2,NOW(),NOW())
                     ON CONFLICT(user_id,apk_sha256) DO UPDATE SET last_downloaded_at=NOW()`,
                    [req.user.userId, metadata.sha256]
                );
            } catch (_) {
                console.error("Completed companion APK download could not be recorded.");
            }
        });
    });

    router.get("/public-download", publicDownloadLimiter, (req, res) => {
        const metadata = getApkMetadata();
        if (!metadata) return res.status(503).json({ success: false, message: "The Android companion download is unavailable." });
        res.set({
            "Cache-Control": "no-store",
            "Content-Type": "application/vnd.android.package-archive",
            "X-Content-Type-Options": "nosniff",
            "X-Companion-SHA256": metadata.sha256,
            "X-Companion-Version": metadata.version
        });
        res.download(APK_PATH, "goal-gambit-companion.apk", async (error) => {
            if (error) {
                if (!res.headersSent) return res.status(500).json({ success: false, message: "The companion APK could not be served." });
                return;
            }
            try {
                await pool.query(
                    `INSERT INTO companion_anonymous_download_events(apk_sha256,downloaded_at) VALUES($1,NOW())`,
                    [metadata.sha256]
                );
            } catch (_) {
                console.error("Completed anonymous companion APK download could not be recorded.");
            }
        });
    });

    router.get("/upcoming", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        try {
            const result = await pool.query(
                `SELECT EXISTS (
                    SELECT 1 FROM chess_scheduled_matches s
                     WHERE (s.host_user_id=$1 OR s.guest_user_id=$1)
                       AND s.status='accepted'
                       AND s.scheduled_at>=NOW()-INTERVAL '30 minutes'
                       AND s.scheduled_at<=NOW()+INTERVAL '30 days'
                    UNION ALL
                    SELECT 1
                      FROM efootball_league_fixtures f
                      JOIN efootball_league_rounds r
                        ON r.league_id=f.league_id AND r.round_number=f.round_number
                      JOIN efootball_leagues l ON l.id=f.league_id
                      LEFT JOIN efootball_matches m ON m.id=f.match_id
                     WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                       AND f.status IN ('scheduled','playing')
                       AND l.status IN ('open','in_progress')
                       AND r.completed_at IS NULL
                       AND (r.deadline_at IS NULL OR r.deadline_at>NOW())
                       AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                    UNION ALL
                    SELECT 1
                      FROM efootball_tournament_fixtures f
                      JOIN efootball_tournament_rounds r
                        ON r.tournament_id=f.tournament_id AND r.round_number=f.round_number
                      JOIN efootball_tournaments t ON t.id=f.tournament_id
                      LEFT JOIN efootball_matches m ON m.id=f.match_id
                     WHERE (f.home_id=$1 OR f.away_id=$1) AND f.away_id IS NOT NULL
                       AND f.status IN ('scheduled','playing')
                       AND t.status IN ('open','in_progress')
                       AND r.completed_at IS NULL
                       AND (r.deadline_at IS NULL OR r.deadline_at>NOW())
                       AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                    UNION ALL
                    SELECT 1 FROM efootball_matches m
                     WHERE (m.creator_id=$1 OR m.opponent_id=$1)
                       AND m.status IN ('waiting','ready')
                       AND m.started_at IS NULL AND m.settled_at IS NULL
                ) AS has_upcoming_games`,
                [userId]
            );
            res.set("Cache-Control", "private, no-store");
            res.json({ success: true, hasUpcomingGames: Boolean(result.rows[0] && result.rows[0].has_upcoming_games) });
        } catch (error) {
            console.error("Companion upcoming-game status failed.");
            res.status(500).json({ success: false, message: "Could not check upcoming games." });
        }
    });

    return router;
};

module.exports.GUIDE_VERSION = GUIDE_VERSION;
