"use strict";

const express = require("express");
const { Chess } = require("chess.js");

const TIME_CONTROLS = new Set(["10+5", "3+2", "1+1"]);
const MINUTES_BY_CONTROL = { "10+5": 10, "3+2": 3, "1+1": 1 };
const MAX_SCHEDULE_DAYS = 30;

function httpError(message, status) {
    return Object.assign(new Error(message), { status: status || 400 });
}

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

function publicSchedule(row, userId) {
    const isHost = Number(row.host_user_id) === Number(userId);
    return {
        id: Number(row.id),
        opponentUsername: isHost ? row.guest_username : row.host_username,
        scheduledAt: row.scheduled_at,
        timeZone: row.time_zone,
        timeControl: row.time_control,
        status: row.status,
        isHost,
        canRespond: !isHost && row.status === "pending",
        canCancel: isHost && ["pending", "accepted"].includes(row.status),
        canReady: row.status === "accepted",
        youReady: Boolean(isHost ? row.host_ready_at : row.guest_ready_at),
        opponentReady: Boolean(isHost ? row.guest_ready_at : row.host_ready_at),
        matchId: Number(row.match_id) || null
    };
}

module.exports = function createChessScheduleRoutes(pool, authenticateToken, pushService) {
    const router = express.Router();

    async function requireChessAccount(queryable, userId) {
        const result = await queryable.query(
            "SELECT id,username,game,account_status FROM users WHERE id=$1",
            [userId]
        );
        const user = result.rows[0];
        if (!user || user.account_status !== "active") throw httpError("Your account cannot schedule a Chess match.", 403);
        if (!["chess", "both"].includes(user.game)) throw httpError("Your account is not registered for Chess.", 403);
        return user;
    }

    async function queueNotification(client, userId, notification) {
        if (!pushService || typeof pushService.enqueueNotification !== "function") return;
        try {
            await client.query("SAVEPOINT chess_schedule_notification");
            await pushService.enqueueNotification(client, userId, notification);
            await client.query("RELEASE SAVEPOINT chess_schedule_notification");
        } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT chess_schedule_notification").catch(function () {});
            await client.query("RELEASE SAVEPOINT chess_schedule_notification").catch(function () {});
            console.error("Chess schedule notification could not be queued.");
        }
    }

    function sendPendingNotifications() {
        if (pushService && typeof pushService.sendPendingJobs === "function") {
            pushService.sendPendingJobs().catch(function () {});
        }
    }

    async function loadSchedule(scheduleId, queryable) {
        const result = await queryable.query(
            `SELECT s.*,h.username AS host_username,g.username AS guest_username
               FROM chess_scheduled_matches s
               JOIN users h ON h.id=s.host_user_id
               JOIN users g ON g.id=s.guest_user_id
              WHERE s.id=$1`,
            [scheduleId]
        );
        return result.rows[0] || null;
    }

    router.get("/", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        try {
            await requireChessAccount(pool, userId);
            const result = await pool.query(
                `SELECT s.*,h.username AS host_username,g.username AS guest_username
                   FROM chess_scheduled_matches s
                   JOIN users h ON h.id=s.host_user_id
                   JOIN users g ON g.id=s.guest_user_id
                  WHERE (s.host_user_id=$1 OR s.guest_user_id=$1)
                    AND ((s.status IN ('pending','accepted') AND s.scheduled_at >= NOW()-INTERVAL '30 minutes')
                         OR (s.status='started' AND s.created_at >= NOW()-INTERVAL '7 days'))
                  ORDER BY s.scheduled_at ASC,s.id ASC
                  LIMIT 30`,
                [userId]
            );
            return res.json({ success: true, schedules: result.rows.map(function (row) { return publicSchedule(row, userId); }) });
        } catch (error) {
            return res.status(error.status || 500).json({ success: false, message: error.message || "Could not load your scheduled Chess matches." });
        }
    });

    router.post("/", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const username = String(req.body && req.body.opponentUsername || "").trim().toLowerCase();
        const scheduledAtMs = Date.parse(req.body && req.body.scheduledAt || "");
        const timeControl = String(req.body && req.body.timeControl || "10+5");
        const timeZone = String(req.body && req.body.timeZone || "Africa/Nairobi").trim();
        if (!/^[a-z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ success: false, message: "Enter the username of the Chess player you want to invite." });
        }
        if (!Number.isFinite(scheduledAtMs) || scheduledAtMs < Date.now() + 10 * 60 * 1000 ||
            scheduledAtMs > Date.now() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
            return res.status(400).json({ success: false, message: "Choose a match time at least 10 minutes from now and within the next 30 days." });
        }
        if (!TIME_CONTROLS.has(timeControl)) {
            return res.status(400).json({ success: false, message: "Choose a supported Chess clock." });
        }
        if (timeZone.length > 64) {
            return res.status(400).json({ success: false, message: "The selected time zone is invalid." });
        }
        try {
            new Intl.DateTimeFormat("en", { timeZone: timeZone }).format(new Date(scheduledAtMs));
        } catch (_) {
            return res.status(400).json({ success: false, message: "The selected time zone is invalid." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["gg-chess-schedule-user:" + userId]);
            const host = await requireChessAccount(client, userId);
            const opponentResult = await client.query(
                "SELECT id,username,game,account_status FROM users WHERE LOWER(username)=$1 FOR UPDATE",
                [username]
            );
            const opponent = opponentResult.rows[0];
            if (!opponent || opponent.account_status !== "active" || !["chess", "both"].includes(opponent.game)) {
                throw httpError("That username does not have an active Chess account.", 404);
            }
            if (Number(opponent.id) === userId) throw httpError("Choose another Chess player for this match.", 400);

            const conflict = await client.query(
                `SELECT id FROM chess_scheduled_matches
                  WHERE status IN ('pending','accepted')
                    AND scheduled_at BETWEEN $1::timestamptz-INTERVAL '30 minutes' AND $1::timestamptz+INTERVAL '30 minutes'
                    AND (host_user_id=ANY($2::int[]) OR guest_user_id=ANY($2::int[]))
                  LIMIT 1`,
                [new Date(scheduledAtMs).toISOString(), [userId, Number(opponent.id)]]
            );
            if (conflict.rows.length) throw httpError("One of these players already has a Chess match scheduled around that time.", 409);

            const inserted = await client.query(
                `INSERT INTO chess_scheduled_matches
                    (host_user_id,guest_user_id,scheduled_at,time_zone,time_control,status)
                 VALUES($1,$2,$3,$4,$5,'pending') RETURNING id`,
                [userId, Number(opponent.id), new Date(scheduledAtMs).toISOString(), timeZone, timeControl]
            );
            const scheduleId = Number(inserted.rows[0].id);
            await queueNotification(client, Number(opponent.id), {
                eventKey: "chess-schedule-invite:" + scheduleId,
                title: "Chess match invitation",
                body: host.username + " invited you to play Chess on " + formatScheduledAt(scheduledAtMs, timeZone) + " (" + timeZone + "). Open GOAL$GAMBIT Chess to accept or decline.",
                page: "chess"
            });
            await client.query("COMMIT");
            sendPendingNotifications();
            const schedule = await loadSchedule(scheduleId, pool);
            return res.status(201).json({ success: true, schedule: publicSchedule(schedule, userId) });
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            return res.status(error.status || 400).json({ success: false, message: error.message || "Could not schedule this Chess match." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/respond", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const scheduleId = Number(req.params.id);
        const action = String(req.body && req.body.action || "").toLowerCase();
        if (!Number.isSafeInteger(scheduleId) || scheduleId < 1 || !["accept", "decline"].includes(action)) {
            return res.status(400).json({ success: false, message: "Choose whether to accept or decline this invitation." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await requireChessAccount(client, userId);
            const result = await client.query("SELECT * FROM chess_scheduled_matches WHERE id=$1 FOR UPDATE", [scheduleId]);
            const schedule = result.rows[0];
            if (!schedule) throw httpError("Scheduled Chess match not found.", 404);
            if (Number(schedule.guest_user_id) !== userId) throw httpError("Only the invited player can respond to this match.", 403);
            if (schedule.status !== "pending") throw httpError("This Chess invitation is no longer waiting for a response.", 409);

            const status = action === "accept" ? "accepted" : "declined";
            await client.query("UPDATE chess_scheduled_matches SET status=$1,updated_at=NOW() WHERE id=$2", [status, scheduleId]);
            const guest = await client.query("SELECT username FROM users WHERE id=$1", [userId]);
            const guestName = guest.rows[0] ? guest.rows[0].username : "Your opponent";
            await queueNotification(client, Number(schedule.host_user_id), {
                eventKey: "chess-schedule-" + status + ":" + scheduleId,
                title: action === "accept" ? "Chess match accepted" : "Chess invitation declined",
                body: guestName + (action === "accept" ? " accepted your Chess match for " : " declined your Chess invitation for ") + formatScheduledAt(schedule.scheduled_at, schedule.time_zone) + ".",
                page: "chess"
            });
            await client.query("COMMIT");
            sendPendingNotifications();
            return res.json({ success: true, status: status, message: action === "accept" ? "Chess match accepted. Both players will receive reminders." : "Chess invitation declined." });
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            return res.status(error.status || 400).json({ success: false, message: error.message || "Could not update this Chess invitation." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/cancel", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const scheduleId = Number(req.params.id);
        if (!Number.isSafeInteger(scheduleId) || scheduleId < 1) return res.status(400).json({ success: false, message: "Invalid scheduled match." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await requireChessAccount(client, userId);
            const result = await client.query("SELECT * FROM chess_scheduled_matches WHERE id=$1 FOR UPDATE", [scheduleId]);
            const schedule = result.rows[0];
            if (!schedule) throw httpError("Scheduled Chess match not found.", 404);
            if (Number(schedule.host_user_id) !== userId) throw httpError("Only the player who scheduled this match can cancel it.", 403);
            if (!["pending", "accepted"].includes(schedule.status)) throw httpError("This Chess match can no longer be cancelled.", 409);

            await client.query("UPDATE chess_scheduled_matches SET status='cancelled',updated_at=NOW() WHERE id=$1", [scheduleId]);
            const host = await client.query("SELECT username FROM users WHERE id=$1", [userId]);
            await queueNotification(client, Number(schedule.guest_user_id), {
                eventKey: "chess-schedule-cancelled:" + scheduleId,
                title: "Chess match cancelled",
                body: (host.rows[0] ? host.rows[0].username : "Your opponent") + " cancelled the Chess match scheduled for " + formatScheduledAt(schedule.scheduled_at, schedule.time_zone) + ".",
                page: "chess"
            });
            await client.query("COMMIT");
            sendPendingNotifications();
            return res.json({ success: true, message: "Scheduled Chess match cancelled." });
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            return res.status(error.status || 400).json({ success: false, message: error.message || "Could not cancel this Chess match." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/ready", authenticateToken, async function (req, res) {
        const userId = Number(req.user && req.user.userId);
        const scheduleId = Number(req.params.id);
        if (!Number.isSafeInteger(scheduleId) || scheduleId < 1) return res.status(400).json({ success: false, message: "Invalid scheduled match." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await requireChessAccount(client, userId);
            const result = await client.query("SELECT * FROM chess_scheduled_matches WHERE id=$1 FOR UPDATE", [scheduleId]);
            const schedule = result.rows[0];
            if (!schedule) throw httpError("Scheduled Chess match not found.", 404);
            const hostId = Number(schedule.host_user_id);
            const guestId = Number(schedule.guest_user_id);
            if (userId !== hostId && userId !== guestId) throw httpError("You are not a player in this scheduled Chess match.", 403);
            if (schedule.status === "started" && schedule.match_id) {
                await client.query("COMMIT");
                return res.json({ success: true, started: true, matchId: Number(schedule.match_id) });
            }
            if (schedule.status !== "accepted") throw httpError("This Chess match must be accepted before either player can get ready.", 409);

            const scheduledTime = new Date(schedule.scheduled_at).getTime();
            const now = Date.now();
            if (now < scheduledTime - 10 * 60 * 1000) throw httpError("You can mark yourself ready 10 minutes before the scheduled time.", 409);
            if (now > scheduledTime + 30 * 60 * 1000) throw httpError("This scheduled Chess match has passed. Schedule another time with your opponent.", 409);

            const readyColumn = userId === hostId ? "host_ready_at" : "guest_ready_at";
            await client.query("UPDATE chess_scheduled_matches SET " + readyColumn + "=COALESCE(" + readyColumn + ",NOW()),updated_at=NOW() WHERE id=$1", [scheduleId]);
            const updated = await client.query("SELECT * FROM chess_scheduled_matches WHERE id=$1 FOR UPDATE", [scheduleId]);
            const ready = updated.rows[0];
            if (!ready.host_ready_at || !ready.guest_ready_at) {
                await client.query("COMMIT");
                return res.json({ success: true, ready: true, started: false, message: "You are ready. The game starts when your opponent is ready too." });
            }

            const playerIds = [hostId, guestId].sort(function (a, b) { return a - b; });
            for (const playerId of playerIds) {
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["goal-gambit-chess-user:" + playerId]);
            }
            const players = await client.query(
                "SELECT id,game,account_status FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",
                [playerIds]
            );
            if (players.rows.length !== 2 || players.rows.some(function (player) {
                return player.account_status !== "active" || !["chess", "both"].includes(player.game);
            })) throw httpError("Both players need active Chess accounts to start this scheduled match.", 403);

            const live = await client.query(
                `SELECT id FROM chess_matches
                  WHERE status IN ('waiting','active','settling')
                    AND (player_white_id=ANY($1::int[]) OR player_black_id=ANY($1::int[]))
                  LIMIT 1`,
                [playerIds]
            );
            if (live.rows.length) throw httpError("One of the players has another active Chess game. Finish it before starting this match.", 409);

            const timeControl = String(ready.time_control);
            const initialTime = MINUTES_BY_CONTROL[timeControl] * 60 * 1000;
            const created = await client.query(
                `INSERT INTO chess_matches
                    (player_white_id,player_black_id,status,fen,white_time_ms,black_time_ms,time_control,match_type,stake_amount,active_color,started_at,last_move_at)
                 VALUES($1,$2,'active',$3,$4,$4,$5,'casual',0,'w',NOW(),NOW())
                 RETURNING id`,
                [hostId, guestId, new Chess().fen(), initialTime, timeControl]
            );
            const matchId = Number(created.rows[0].id);
            await client.query("UPDATE chess_scheduled_matches SET status='started',match_id=$1,updated_at=NOW() WHERE id=$2", [matchId, scheduleId]);
            const usernames = await client.query("SELECT id,username FROM users WHERE id=ANY($1::int[])", [playerIds]);
            const namesById = new Map(usernames.rows.map(function (player) { return [Number(player.id), player.username]; }));
            for (const playerId of playerIds) {
                const opponentId = playerId === hostId ? guestId : hostId;
                await queueNotification(client, playerId, {
                    eventKey: "chess-schedule-started:" + scheduleId,
                    title: "Your scheduled Chess game is ready",
                    body: "Both players are ready for your Chess game with " + (namesById.get(opponentId) || "your opponent") + ". Open the Chess dashboard on the website to play.",
                    page: "chess"
                });
            }
            await client.query("COMMIT");
            sendPendingNotifications();
            return res.json({ success: true, ready: true, started: true, matchId: matchId, message: "Both players are ready. Your Chess game has started." });
        } catch (error) {
            await client.query("ROLLBACK").catch(function () {});
            return res.status(error.status || 400).json({ success: false, message: error.message || "Could not start this scheduled Chess match." });
        } finally {
            client.release();
        }
    });

    return router;
};
