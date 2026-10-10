"use strict";

const express = require("express");
const { randomUUID, randomInt } = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const { analyzeScreenshot, matchesExpected } = require("../services/imageverification");

module.exports = function (pool, authenticateToken) {

    const router = express.Router();
    const SEARCH_PRESENCE_TTL_SECONDS = 120;
    const screenshotUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 8 * 1024 * 1024, files: 1 },
        fileFilter: function(req, file, callback) {
            const allowed = ["image/jpeg", "image/png", "image/webp"];
            callback(allowed.includes(file.mimetype) ? null : new Error("Use a JPEG, PNG or WebP screenshot."), allowed.includes(file.mimetype));
        }
    }).single("screenshot");

    function receiveScreenshot(req, res, next) {
        screenshotUpload(req, res, function(error) {
            if (!error) return next();
            const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            return res.status(status).json({
                success: false,
                message: status === 413 ? "Screenshot must be 8 MB or smaller." : error.message
            });
        });
    }

    /* =====================================================
       HELPERS
    ===================================================== */

    function roomCode() {
        return randomUUID()
            .replace(/-/g, "")
            .substring(0, 6)
            .toUpperCase();
    }

    function cleanMode(value) {
        return String(value || "ranked")
            .trim()
            .toLowerCase();
    }

    function cleanLeague(value) {
        if (value === undefined || value === null) {
            return null;
        }

        const valueClean = String(value).trim();

        return valueClean || null;
    }

    function cleanRound(value) {
        if (value === undefined || value === null) {
            return null;
        }

        const valueClean = String(value).trim();

        return valueClean || null;
    }

    function validStake(value) {
        const amount = Number(value);

        return (
            Number.isFinite(amount) &&
            [20, 50, 100].includes(amount)
        );
    }

    function validScore(value) {
        const score = Number(value);

        return (
            Number.isInteger(score) &&
            score >= 0 &&
            score <= 99
        );
    }

    async function createSystemNotification(
        client,
        userId,
        type,
        title,
        message,
        matchId = null
    ) {

        if (!userId) {
            return;
        }

        await client.query(
            `
            INSERT INTO system_notifications
            (
                user_id,
                type,
                title,
                message,
                match_id
            )
            VALUES ($1, $2, $3, $4, $5)
            `,
            [
                userId,
                type,
                title,
                message,
                matchId
            ]
        );
    }

    // A waiting row is matchable only while its creator is checking in from
    // the Match Hub. Expired searches are cancelled with their locked stake
    // returned, so closing a tab cannot leave a player in the queue forever.
    async function expireStaleSearches(onlyUserId = null) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const stale = await client.query(
                `SELECT id, creator_id, stake_amount
                   FROM efootball_matches
                  WHERE status='waiting'
                    AND opponent_id IS NULL
                    AND (search_last_seen_at IS NULL OR search_last_seen_at < NOW() - ($1::int * INTERVAL '1 second'))
                    AND ($2::int IS NULL OR creator_id=$2)
                  ORDER BY COALESCE(search_last_seen_at, created_at), id
                  LIMIT 100
                  FOR UPDATE`,
                [SEARCH_PRESENCE_TTL_SECONDS, onlyUserId]
            );

            for (const match of stale.rows) {
                const stake = Number(match.stake_amount || 0);
                if (stake > 0) {
                    const refund = await client.query(
                        `UPDATE wallets
                            SET locked_balance=locked_balance-$1,
                                balance=balance+$1,
                                updated_at=NOW()
                          WHERE user_id=$2 AND locked_balance >= $1
                          RETURNING user_id`,
                        [stake, match.creator_id]
                    );
                    if (!refund.rows.length) {
                        throw new Error("Expired eFootball search stake could not be refunded safely.");
                    }
                    await client.query(
                        `INSERT INTO transactions
                            (user_id,transaction_type,amount,currency,status,reference,description)
                         VALUES ($1,'match_refund',$2,'KES','completed',$3,'eFootball search expired - stake refunded')`,
                        [match.creator_id, stake, "EF-SEARCH-EXPIRED-" + match.id]
                    );
                }

                await client.query(
                    `UPDATE efootball_matches
                        SET status='cancelled', result_status='search_expired',
                            finished_at=NOW(), settled_at=NOW()
                      WHERE id=$1 AND status='waiting' AND opponent_id IS NULL`,
                    [match.id]
                );
                await createSystemNotification(
                    client,
                    match.creator_id,
                    "match_search_expired",
                    "Match search expired",
                    stake > 0
                        ? "Your search expired after the Match Hub stopped checking in. Your locked stake was refunded."
                        : "Your search expired after the Match Hub stopped checking in. Start a new search when ready.",
                    match.id
                );
            }

            await client.query("COMMIT");
            return stale.rows.length;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("eFootball search expiry failed:", error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async function getMatchForUser(client, matchId, userId) {

        const result = await client.query(
            `
            SELECT
                m.*,

                creator.username AS creator_username,
                opponent.username AS opponent_username,

                winner.username AS winner_username,
                v.status AS verification_status,
                (v.screenshot_path IS NOT NULL) AS screenshot_submitted,
                v.selected_player_id AS screenshot_sender_id

            FROM efootball_matches m

            JOIN users creator
                ON creator.id = m.creator_id

            LEFT JOIN users opponent
                ON opponent.id = m.opponent_id

            LEFT JOIN users winner
                ON winner.id = m.winner_id

            LEFT JOIN efootball_result_verifications v
                ON v.match_id = m.id

            WHERE m.id = $1
              AND (
                    m.creator_id = $2
                    OR m.opponent_id = $2
                  )

            LIMIT 1
            `,
            [
                matchId,
                userId
            ]
        );

        return result.rows[0] ? presentMatch(result.rows[0], userId) : null;
    }

    function presentMatch(match, userId) {
        if (!match) return null;
        const isCreator = Number(match.creator_id) === Number(userId);
        const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
        const shownCode = match.external_room_code || null;
        const safe = { ...match };
        // room_code is an internal unique placeholder required by the legacy
        // table. Never expose it as if it were the real Konami room code.
        safe.room_code = shownCode;
        safe.opponentFound = Boolean(match.opponent_id);
        safe.youAreCreator = isCreator;
        safe.youAreSender = senderId !== null && senderId === Number(userId);
        safe.codeSenderName = senderId === Number(match.creator_id)
            ? (match.creator_username || null)
            : senderId === Number(match.opponent_id)
                ? (match.opponent_username || null)
                : null;
        safe.yourName = isCreator ? match.creator_username : match.opponent_username;
        safe.opponentName = isCreator ? match.opponent_username : match.creator_username;
        safe.yourReady = Boolean(isCreator ? match.creator_ready : match.opponent_ready);
        safe.opponentReady = Boolean(isCreator ? match.opponent_ready : match.creator_ready);
        safe.codeSent = Boolean(match.code_sent && shownCode);
        safe.verificationStatus = match.verification_status || null;
        safe.screenshotSubmitted = Boolean(match.screenshot_submitted);
        safe.youMustUploadScreenshot = match.screenshot_sender_id != null && Number(match.screenshot_sender_id) === Number(userId);
        return safe;
    }

    /* =====================================================
       GET MY MATCHES
       ===================================================== */

    router.get(
        "/matches",
        authenticateToken,
        async (req, res) => {

            try {

                const result = await pool.query(
                    `
                    SELECT
                        m.*,

                        creator.username AS creator_username,
                        opponent.username AS opponent_username,

                        winner.username AS winner_username

                    FROM efootball_matches m

                    JOIN users creator
                        ON creator.id = m.creator_id

                    LEFT JOIN users opponent
                        ON opponent.id = m.opponent_id

                    LEFT JOIN users winner
                        ON winner.id = m.winner_id

                    WHERE
                        m.creator_id = $1
                        OR m.opponent_id = $1

                    ORDER BY m.created_at DESC

                    LIMIT 100
                    `,
                    [req.user.userId]
                );

                return res.json({
                    success: true,
                    matches: result.rows.map(match => presentMatch(match, req.user.userId))
                });

            } catch (error) {

                console.error(
                    "GET /matches error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load eFootball matches."
                });
            }
        }
    );


    /* =====================================================
       ACTIVE MATCHES
       ===================================================== */

    router.get(
        "/matches/active",
        authenticateToken,
        async (req, res) => {

            try {

                const result = await pool.query(
                    `
                    SELECT
                        m.*,

                        creator.username AS creator_username,
                        opponent.username AS opponent_username

                    FROM efootball_matches m

                    JOIN users creator
                        ON creator.id = m.creator_id

                    LEFT JOIN users opponent
                        ON opponent.id = m.opponent_id

                    WHERE
                        (
                            m.creator_id = $1
                            OR m.opponent_id = $1
                        )
                        AND m.status IN
                        (
                            'waiting',
                            'playing',
                            'ready',
                            'awaiting_verification',
                            'disputed'
                        )

                    ORDER BY m.created_at DESC
                    `,
                    [req.user.userId]
                );

                return res.json({
                    success: true,
                    matches: result.rows.map(match => presentMatch(match, req.user.userId)),
                    match: result.rows.length
                        ? presentMatch(result.rows[0], req.user.userId)
                        : null
                });

            } catch (error) {

                console.error(
                    "GET /matches/active error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load active matches."
                });
            }
        }
    );


    /* =====================================================
       MATCH HISTORY
       ===================================================== */

    router.get(
        "/matches/history/mine",
        authenticateToken,
        async (req, res) => {

            try {

                const result = await pool.query(
                    `
                    SELECT
                        m.*,

                        creator.username AS creator_username,
                        opponent.username AS opponent_username,

                        winner.username AS winner_username

                    FROM efootball_matches m

                    JOIN users creator
                        ON creator.id = m.creator_id

                    LEFT JOIN users opponent
                        ON opponent.id = m.opponent_id

                    LEFT JOIN users winner
                        ON winner.id = m.winner_id

                    WHERE
                        (
                            m.creator_id = $1
                            OR m.opponent_id = $1
                        )
                        AND m.status IN
                        (
                            'completed',
                            'disputed',
                            'cancelled'
                        )

                    ORDER BY
                        COALESCE(
                            m.finished_at,
                            m.created_at
                        ) DESC

                    LIMIT 100
                    `,
                    [req.user.userId]
                );

                return res.json({
                    success: true,
                    matches: result.rows.map(match => presentMatch(match, req.user.userId))
                });

            } catch (error) {

                console.error(
                    "GET /matches/history/mine error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load match history."
                });
            }
        }
    );


    /* =====================================================
       CREATE MATCH
       ===================================================== */

    router.post("/matches", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const mode = cleanMode(req.body && req.body.mode);
        let league = cleanLeague(req.body && req.body.league);
        const roundName = cleanRound(req.body && req.body.round_name);
        const tournamentId = req.body && req.body.tournament_id ? Number(req.body.tournament_id) : null;
        const requestedStake = Number(req.body && (req.body.stake_amount !== undefined ? req.body.stake_amount : req.body.stake));
        let stake = 0;

        const isRanked = mode === "ranked";
        const isLeague = /^league-(bronze|silver|gold)$/.test(mode);
        const isTournament = mode === "tournament";
        if (!userId || (!isRanked && !isLeague && !isTournament)) {
            return res.status(400).json({ success: false, message: "Choose a valid eFootball match mode." });
        }
        if (isRanked) {
            if (!validStake(requestedStake)) return res.status(400).json({ success: false, message: "Ranked matches support KSh 20, KSh 50 or KSh 100." });
            stake = requestedStake;
        } else if (Number.isFinite(requestedStake) && requestedStake !== 0) {
            return res.status(400).json({ success: false, message: "League and tournament matches do not add another match stake." });
        }
        if (isLeague && (!league || league.toLowerCase() !== mode.slice(7))) {
            return res.status(400).json({ success: false, message: "Choose the league you joined." });
        }
        if (isTournament && (!Number.isSafeInteger(tournamentId) || tournamentId <= 0)) {
            return res.status(400).json({ success: false, message: "A valid tournament is required." });
        }

        try {
            await expireStaleSearches(userId);
        } catch (_) {
            return res.status(503).json({ success: false, message: "An expired search could not be cleared safely. Please retry shortly." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock($1::integer)", [userId]);

            const account = await client.query("SELECT game, account_status FROM users WHERE id=$1", [userId]);
            if (!account.rows.length || account.rows[0].account_status !== "active") {
                throw Object.assign(new Error("Your account cannot start a match."), { status: 403 });
            }
            if (!["konami", "both"].includes(account.rows[0].game)) {
                throw Object.assign(new Error("Your account is not registered for eFootball."), { status: 403 });
            }

            if (isLeague) {
                league = mode.slice(7).charAt(0).toUpperCase() + mode.slice(8);
                const member = await client.query(
                    "SELECT 1 FROM efootball_league_members lm JOIN efootball_leagues l ON l.id=lm.league_id WHERE lm.user_id=$1 AND LOWER(l.name)=LOWER($2)",
                    [userId, league]
                );
                if (!member.rows.length) throw Object.assign(new Error("Join this league before starting a league match."), { status: 403 });
            }
            if (isTournament) {
                const member = await client.query(
                    "SELECT 1 FROM efootball_tournament_members tm JOIN efootball_tournaments t ON t.id=tm.tournament_id WHERE tm.user_id=$1 AND tm.tournament_id=$2 AND t.status='open'",
                    [userId, tournamentId]
                );
                if (!member.rows.length) throw Object.assign(new Error("Join an open tournament before starting a tournament match."), { status: 403 });
            }

            // Serialize searches for the same ranked stake, league division,
            // tournament round, or tournament. Two simultaneous searches
            // should join the same waiting player instead of making parallel
            // orphan queue entries.
            const queueKey = [
                "goal-gambit-efootball", mode, league || "", roundName || "",
                tournamentId || "", stake
            ].join(":");
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                [queueKey]
            );

            const existing = await client.query(
                "SELECT id FROM efootball_matches WHERE (creator_id=$1 OR opponent_id=$1) AND status IN ('waiting','ready','playing','awaiting_verification','disputed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
                [userId]
            );
            if (existing.rows.length) {
                const match = await getMatchForUser(client, existing.rows[0].id, userId);
                await client.query("COMMIT");
                return res.json({ success: true, matched: Boolean(match.opponentFound), match: match });
            }

            const candidate = await client.query(
                `SELECT waiting.id, waiting.creator_id
                   FROM efootball_matches waiting
                   JOIN users waiting_player ON waiting_player.id=waiting.creator_id
                  WHERE waiting.status='waiting' AND waiting.opponent_id IS NULL
                    AND waiting.creator_id<>$1 AND waiting.mode=$2
                    AND waiting.league IS NOT DISTINCT FROM $3
                    AND waiting.round_name IS NOT DISTINCT FROM $4
                    AND waiting.tournament_id IS NOT DISTINCT FROM $5
                    AND waiting.stake_amount=$6
                    AND waiting.search_last_seen_at >= NOW() - ($7::int * INTERVAL '1 second')
                    AND waiting_player.account_status='active'
                    AND waiting_player.game IN ('konami','both')
                    AND NOT EXISTS (
                        SELECT 1 FROM efootball_matches other
                         WHERE other.id<>waiting.id
                           AND other.status IN ('waiting','ready','playing','awaiting_verification','disputed')
                           AND (other.creator_id=waiting.creator_id OR other.opponent_id=waiting.creator_id)
                    )
                  ORDER BY waiting.created_at, waiting.id LIMIT 1 FOR UPDATE OF waiting SKIP LOCKED`,
                [userId, mode, league, roundName, tournamentId, stake, SEARCH_PRESENCE_TTL_SECONDS]
            );

            if (candidate.rows.length) {
                if (stake > 0) {
                    const locked = await client.query(
                        "UPDATE wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING user_id",
                        [stake, userId]
                    );
                    if (!locked.rows.length) throw Object.assign(new Error("Insufficient available balance."), { status: 402 });
                }
                const senderId = randomInt(0, 2) === 0 ? Number(candidate.rows[0].creator_id) : userId;
                await client.query(
                    "UPDATE efootball_matches SET opponent_id=$1, code_sender_id=$2, creator_ready=FALSE, opponent_ready=FALSE WHERE id=$3",
                    [userId, senderId, candidate.rows[0].id]
                );
                if (stake > 0) {
                    await client.query(
                        "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                        [userId, stake, "EF-LOCK-" + candidate.rows[0].id + "-" + userId + "-" + randomUUID()]
                    );
                }

                const senderMessage = senderId === userId
                    ? "You were randomly chosen to create the eFootball room and send its code. Enter it on your match page when ready."
                    : "Your opponent was chosen to create the eFootball room. The room code will arrive here when sent.";
                const receiverId = senderId === userId ? Number(candidate.rows[0].creator_id) : userId;
                await createSystemNotification(client, senderId, "room_code_sender", "You are sending the room code", senderMessage, candidate.rows[0].id);
                await createSystemNotification(client, receiverId, "room_code_waiting", "Opponent is preparing the room code", "Your opponent will receive a reminder when the room code is sent.", candidate.rows[0].id);
                const match = await getMatchForUser(client, candidate.rows[0].id, userId);
                await client.query("COMMIT");
                return res.status(201).json({ success: true, matched: true, message: "Opponent found.", match: match });
            }

            if (stake > 0) {
                const locked = await client.query(
                    "UPDATE wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING user_id",
                    [stake, userId]
                );
                if (!locked.rows.length) throw Object.assign(new Error("Insufficient available balance."), { status: 402 });
            }

            const created = await client.query(
                "INSERT INTO efootball_matches (creator_id,mode,league,round_name,tournament_id,stake_amount,room_code,status,creator_ready,opponent_ready,code_sent,creator_submitted,opponent_submitted,search_last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting',FALSE,FALSE,FALSE,FALSE,FALSE,NOW()) RETURNING id",
                [userId, mode, league, roundName, tournamentId, stake, roomCode()]
            );
            const matchId = created.rows[0].id;
            if (stake > 0) {
                await client.query(
                    "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                    [userId, stake, "EF-LOCK-" + matchId + "-" + userId + "-" + randomUUID()]
                );
            }
            const match = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            return res.status(201).json({ success: true, matched: false, message: "Searching for an opponent.", match: match });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            if (error.status) return res.status(error.status).json({ success: false, message: error.message });
            console.error("eFootball matchmaking error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to start eFootball matchmaking." });
        } finally {
            client.release();
        }
    });

    // Cancel an unmatched search or a paired match before play starts. Refund
    // every locked stake atomically with the match status change.
    router.post("/matches/:id/cancel", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid match ID." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const locked = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!locked.rows.length) throw Object.assign(new Error("Match not found."), { status: 404 });
            const match = locked.rows[0];
            const participantIds = [match.creator_id, match.opponent_id]
                .filter(value => value != null)
                .map(Number)
                .filter(id => Number.isSafeInteger(id) && id > 0);
            if (!participantIds.includes(userId)) {
                throw Object.assign(new Error("Only a player in this match can cancel it."), { status: 403 });
            }
            const isPaired = match.opponent_id != null;
            if (!isPaired && Number(match.creator_id) !== userId) {
                throw Object.assign(new Error("Only the player who started this search can cancel it."), { status: 403 });
            }
            if (!(["waiting", "ready"].includes(match.status)) || match.started_at || (match.creator_ready && match.opponent_ready)) {
                throw Object.assign(new Error("This match has started and can no longer be cancelled."), { status: 409 });
            }
            const stake = Number(match.stake_amount || 0);
            if (stake > 0) {
                const refund = await client.query(
                    `UPDATE wallets
                        SET locked_balance=locked_balance-$1,
                            balance=balance+$1,
                            updated_at=NOW()
                      WHERE user_id=ANY($2::int[]) AND locked_balance >= $1
                      RETURNING user_id`,
                    [stake, participantIds]
                );
                const refundedUserIds = new Set(refund.rows.map(row => Number(row.user_id)));
                if (participantIds.some(id => !refundedUserIds.has(id))) {
                    throw new Error("One or more locked match stakes could not be refunded safely.");
                }
                for (const participantId of participantIds) {
                    await client.query(
                        `INSERT INTO transactions
                            (user_id,transaction_type,amount,currency,status,reference,description)
                         VALUES ($1,'match_refund',$2,'KES','completed',$3,'eFootball match cancelled before play - stake refunded')`,
                        [participantId, stake, "EF-CANCEL-" + matchId + "-" + participantId]
                    );
                }
            }
            await client.query(
                "UPDATE efootball_matches SET status='cancelled', result_status='cancelled', finished_at=NOW(), settled_at=NOW() WHERE id=$1 AND status IN ('waiting','ready') AND started_at IS NULL",
                [matchId]
            );
            for (const participantId of participantIds) {
                await createSystemNotification(
                    client,
                    participantId,
                    "match_cancelled",
                    "Match cancelled",
                    stake > 0
                        ? "This match was cancelled before play began. All locked stakes were refunded."
                        : "This match was cancelled before play began.",
                    matchId
                );
            }
            await client.query("COMMIT");
            return res.json({
                success: true,
                isPaired,
                refundedPlayers: stake > 0 ? participantIds.length : 0,
                message: isPaired
                    ? (stake > 0 ? "Match cancelled. Both players' locked stakes were refunded." : "Match cancelled before play began.")
                    : (stake > 0 ? "Search cancelled and your locked stake was refunded." : "Search cancelled.")
            });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            return res.status(error.status || 400).json({ success: false, message: error.message || "Unable to cancel this search." });
        } finally {
            client.release();
        }
    });

    // Renew a waiting search only while the player is still checking in.
    router.post("/matches/:id/heartbeat", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid match ID." });
        }
        try {
            const renewed = await pool.query(
                `UPDATE efootball_matches
                    SET search_last_seen_at=NOW()
                  WHERE id=$1 AND creator_id=$2 AND status='waiting' AND opponent_id IS NULL
                    AND search_last_seen_at >= NOW() - ($3::int * INTERVAL '1 second')
                  RETURNING id`,
                [matchId, userId, SEARCH_PRESENCE_TTL_SECONDS]
            );
            if (!renewed.rows.length) {
                await expireStaleSearches(userId).catch(() => {});
                return res.status(409).json({
                    success: false,
                    expired: true,
                    message: "This search is no longer active. Any unmatched stake is being refunded; start a new search when ready."
                });
            }
            return res.json({ success: true, expiresInSeconds: SEARCH_PRESENCE_TTL_SECONDS });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Unable to renew this match search." });
        }
    });

    /* =====================================================
       GET MATCH
       ===================================================== */

    router.get(
        "/matches/:id",
        authenticateToken,
        async (req, res) => {

            try {

                const match =
                    await getMatchForUser(
                        pool,
                        req.params.id,
                        req.user.userId
                    );

                if (!match) {

                    return res.status(404).json({
                        success: false,
                        message: "Match not found."
                    });
                }

                return res.json({
                    success: true,
                    match
                });

            } catch (error) {

                console.error(
                    "GET /matches/:id error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to load match."
                });
            }
        }
    );


    /* =====================================================
       JOIN MATCH
       ===================================================== */

    router.post("/matches/:id/join", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid match ID." });
        }
        try {
            await expireStaleSearches();
        } catch (_) {
            return res.status(503).json({ success: false, message: "Expired searches could not be cleared safely. Please retry shortly." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock($1::integer)", [userId]);
            const result = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!result.rows.length) throw Object.assign(new Error("Match not found."), { status: 404 });
            const match = result.rows[0];
            if (Number(match.creator_id) === userId) throw Object.assign(new Error("You cannot join your own match."), { status: 400 });
            if (match.status !== "waiting" || match.opponent_id) throw Object.assign(new Error("This match is no longer available."), { status: 409 });

            const alreadyPlaying = await client.query(
                "SELECT 1 FROM efootball_matches WHERE (creator_id=$1 OR opponent_id=$1) AND status IN ('waiting','ready','playing','awaiting_verification','disputed') LIMIT 1",
                [userId]
            );
            if (alreadyPlaying.rows.length) throw Object.assign(new Error("Finish or cancel your current match first."), { status: 409 });

            if (Number(match.stake_amount) > 0) {
                const wallet = await client.query(
                    "UPDATE wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING user_id",
                    [match.stake_amount, userId]
                );
                if (!wallet.rows.length) throw Object.assign(new Error("Insufficient available balance."), { status: 402 });
            }
            const senderId = randomInt(0, 2) === 0 ? Number(match.creator_id) : userId;
            await client.query(
                "UPDATE efootball_matches SET opponent_id=$1, code_sender_id=$2, creator_ready=FALSE, opponent_ready=FALSE WHERE id=$3",
                [userId, senderId, matchId]
            );
            if (Number(match.stake_amount) > 0) {
                await client.query(
                    "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                    [userId, match.stake_amount, "EF-LOCK-" + matchId + "-" + userId + "-" + randomUUID()]
                );
            }
            const senderMessage = senderId === userId
                ? "You were randomly chosen to create the room and send its code. Use the match page to send it to your opponent."
                : "Your opponent was chosen to create the room. The code will arrive on your match page.";
            const receiverId = senderId === userId ? Number(match.creator_id) : userId;
            await createSystemNotification(client, senderId, "room_code_sender", "You are sending the room code", senderMessage, matchId);
            await createSystemNotification(client, receiverId, "room_code_waiting", "Opponent is preparing the room code", "Your opponent will be reminded when the code is sent.", matchId);
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            return res.status(201).json({ success: true, message: "Match joined.", match: updated });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            if (error.status) return res.status(error.status).json({ success: false, message: error.message });
            console.error("eFootball manual join error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to join match." });
        } finally {
            client.release();
        }
    });
    /* =====================================================
       READY
       ===================================================== */

    router.post(
        "/matches/:id/ready",
        authenticateToken,
        async (req, res) => {

            const client = await pool.connect();

            try {

                const userId =
                    Number(req.user.userId);

                await client.query("BEGIN");

                const matchResult =
                    await client.query(
                        `
                        SELECT *
                        FROM efootball_matches
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [req.params.id]
                    );

                if (!matchResult.rows.length) {

                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "Match not found."
                    });
                }

                const match =
                    matchResult.rows[0];

                const isCreator =
                    Number(match.creator_id) ===
                    userId;

                const isOpponent =
                    Number(match.opponent_id) ===
                    userId;

                if (
                    !isCreator &&
                    !isOpponent
                ) {

                    await client.query("ROLLBACK");

                    return res.status(403).json({
                        success: false,
                        message: "You are not part of this match."
                    });
                }

                if (!match.opponent_id) {

                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        success: false,
                        message:
                            "Waiting for an opponent."
                    });
                }

                if (!["waiting", "ready"].includes(match.status)) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "This match is no longer waiting for players to get ready." });
                }

                if (!match.code_sent || !match.external_room_code) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "Wait for the selected player to send the room code before marking ready." });
                }

                if (isCreator) {

                    await client.query(
                        `
                        UPDATE efootball_matches

                        SET creator_ready = true

                        WHERE id = $1
                        `,
                        [match.id]
                    );

                } else {

                    await client.query(
                        `
                        UPDATE efootball_matches

                        SET opponent_ready = true

                        WHERE id = $1
                        `,
                        [match.id]
                    );

                }

                const updatedResult =
                    await client.query(
                        `
                        SELECT *
                        FROM efootball_matches
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [match.id]
                    );

                const updated =
                    updatedResult.rows[0];

                if (
                    updated.creator_ready &&
                    updated.opponent_ready &&
                    updated.status === "waiting"
                ) {

                    await client.query(
                        `
                        UPDATE efootball_matches

                        SET
                            status = 'playing',
                            started_at = COALESCE(
                                started_at,
                                NOW()
                            )

                        WHERE id = $1
                        `,
                        [match.id]
                    );

                    await createSystemNotification(
                        client,
                        updated.creator_id,
                        "match_started",
                        "Match Started",
                        "Both players are ready. Your eFootball match can now be played.",
                        match.id
                    );

                    await createSystemNotification(
                        client,
                        updated.opponent_id,
                        "match_started",
                        "Match Started",
                        "Both players are ready. Your eFootball match can now be played.",
                        match.id
                    );
                }

                const finalResult =
                    await client.query(
                        `
                        SELECT *
                        FROM efootball_matches
                        WHERE id = $1
                        `,
                        [match.id]
                    );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message: "Ready status updated.",
                    match: finalResult.rows[0]
                });

            } catch (error) {

                try {
                    await client.query("ROLLBACK");
                } catch (_) {}

                console.error(
                    "POST /ready error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to update ready status."
                });

            } finally {

                client.release();

            }
        }
    );


    /* =====================================================
       SEND ROOM CODE
       ===================================================== */

    async function sendRoomCode(req, res) {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        const code = String(req.body && req.body.code || "").trim();
        if (!Number.isSafeInteger(matchId) || matchId <= 0) return res.status(400).json({ success: false, message: "Invalid match ID." });
        if (!/^[A-Za-z0-9 _-]{3,50}$/.test(code)) return res.status(400).json({ success: false, message: "Enter a valid eFootball room code (3-50 letters or numbers)." });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!result.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Match not found." });
            }
            const match = result.rows[0];
            if (Number(match.creator_id) !== userId && Number(match.opponent_id) !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (!match.opponent_id || !["waiting", "ready"].includes(match.status)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The room code can only be sent before the game starts." });
            }

            let senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
            if (!senderId) {
                senderId = randomInt(0, 2) === 0 ? Number(match.creator_id) : Number(match.opponent_id);
                await client.query("UPDATE efootball_matches SET code_sender_id=$1 WHERE id=$2", [senderId, matchId]);
            }
            if (senderId !== userId) {
                await client.query("COMMIT");
                return res.status(403).json({ success: false, message: "Your opponent was randomly selected to send the room code." });
            }
            if (match.code_sent) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The room code has already been sent." });
            }

            const receiverId = senderId === Number(match.creator_id) ? Number(match.opponent_id) : Number(match.creator_id);
            await client.query(
                "UPDATE efootball_matches SET external_room_code=$1, code_sent=TRUE WHERE id=$2",
                [code, matchId]
            );
            const receiver = await client.query("SELECT username FROM users WHERE id=$1", [receiverId]);
            const sender = await client.query("SELECT username FROM users WHERE id=$1", [userId]);
            await createSystemNotification(
                client, receiverId, "room_code", "eFootball Room Code",
                "Your opponent sent the eFootball room code: " + code, matchId
            );
            await createSystemNotification(
                client, senderId, "room_code_sent", "Room code delivered",
                "Your room code was sent privately to " + (receiver.rows[0] && receiver.rows[0].username || "your opponent") + ".", matchId
            );
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            return res.json({ success: true, message: "Room code sent privately to your opponent.", room_code: code, match: updated });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("Room-code send error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to send room code." });
        } finally {
            client.release();
        }
    }
    router.post(
        "/matches/:id/send-code",
        authenticateToken,
        sendRoomCode
    );

    /*
     * Compatibility route for the existing
     * Match Hub frontend.
     */

    router.post(
        "/matches/:id/roomcode",
        authenticateToken,
        sendRoomCode
    );


    /* =====================================================
       RESULT SUBMISSION
       ===================================================== */

    router.post("/matches/:id/result", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const score = Number(req.body && (req.body.score !== undefined ? req.body.score : req.body.yourScore));
        const opponentScore = Number(req.body && (req.body.opponent_score !== undefined ? req.body.opponent_score : req.body.opponentScore));
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0 || !validScore(score) || !validScore(opponentScore)) {
            return res.status(400).json({ success: false, message: "Enter both scores as whole numbers from 0 to 99." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const found = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!found.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Match not found." });
            }
            const match = found.rows[0];
            const isCreator = Number(match.creator_id) === userId;
            const isOpponent = Number(match.opponent_id) === userId;
            if (!isCreator && !isOpponent) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (match.status !== "playing" || !match.opponent_id) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Results can be submitted after both players are ready and the match is playing." });
            }
            if ((isCreator && match.creator_submitted) || (isOpponent && match.opponent_submitted)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "You have already submitted your result." });
            }

            if (isCreator) {
                await client.query(
                    "UPDATE efootball_matches SET creator_submitted=TRUE, creator_submitted_score=$1, creator_submitted_opponent_score=$2 WHERE id=$3",
                    [score, opponentScore, matchId]
                );
            } else {
                await client.query(
                    "UPDATE efootball_matches SET opponent_submitted=TRUE, opponent_submitted_score=$1, opponent_submitted_opponent_score=$2 WHERE id=$3",
                    [score, opponentScore, matchId]
                );
            }

            const currentResult = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            const current = currentResult.rows[0];
            if (!current.creator_submitted || !current.opponent_submitted) {
                const safeMatch = await getMatchForUser(client, matchId, userId);
                await client.query("COMMIT");
                return res.json({
                    success: true, pending: true, settled: false, disputed: false,
                    message: "Your score is recorded. Waiting for your opponent to submit theirs.",
                    match: safeMatch
                });
            }

            const creatorScore = Number(current.creator_submitted_score);
            const creatorOpponentScore = Number(current.creator_submitted_opponent_score);
            const agreed = creatorScore === Number(current.opponent_submitted_opponent_score) &&
                creatorOpponentScore === Number(current.opponent_submitted_score);
            const selectedPlayerId = [Number(current.creator_id), Number(current.opponent_id)]
                .includes(Number(current.code_sender_id))
                    ? Number(current.code_sender_id)
                    : (randomInt(0, 2) === 0 ? Number(current.creator_id) : Number(current.opponent_id));

            await client.query(
                "INSERT INTO efootball_result_verifications (match_id,selected_player_id,status,score_check) VALUES ($1,$2,'pending_screenshot',$3) ON CONFLICT (match_id) DO UPDATE SET selected_player_id=EXCLUDED.selected_player_id,status='pending_screenshot',score_check=EXCLUDED.score_check",
                [matchId, selectedPlayerId, agreed ? "awaiting_screenshot" : "disputed"]
            );

            if (!agreed) {
                await client.query(
                    "UPDATE efootball_matches SET status='disputed', result_status='disputed', submitted_by=$1 WHERE id=$2",
                    [userId, matchId]
                );
                const disputeMessage = "The two score reports do not match. The result is on hold for screenshot evidence and admin review.";
                await createSystemNotification(client, current.creator_id, "match_disputed", "Result Disputed", disputeMessage, matchId);
                await createSystemNotification(client, current.opponent_id, "match_disputed", "Result Disputed", disputeMessage, matchId);
                await createSystemNotification(
                    client, selectedPlayerId, "result_verification", "Screenshot Needed",
                    "Upload the final match screenshot on the match page. The admin will decide any score dispute.", matchId
                );
            } else {
                await client.query(
                    "UPDATE efootball_matches SET status='awaiting_verification', result_status='pending' WHERE id=$1",
                    [matchId]
                );
                await createSystemNotification(
                    client, selectedPlayerId, "result_verification", "Screenshot Verification Required",
                    "Your match needs a final screenshot before the result and table are updated. Upload it on the match page.", matchId
                );
                const otherPlayerId = selectedPlayerId === Number(current.creator_id)
                    ? Number(current.opponent_id) : Number(current.creator_id);
                await createSystemNotification(
                    client, otherPlayerId, "result_verification_wait", "Result Awaiting Screenshot",
                    "The selected player is uploading the match screenshot. The result will be checked before settlement.", matchId
                );
            }

            const safeMatch = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            return res.json({
                success: true, pending: true, settled: false, disputed: !agreed,
                verificationRequired: true,
                message: agreed
                    ? "Both scores agree. Upload the selected match screenshot to verify the result."
                    : "The scores disagree. The match is disputed and will be reviewed by an admin.",
                match: safeMatch
            });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("eFootball result submission error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to process the submitted result." });
        } finally {
            client.release();
        }
    });
    /* =====================================================
       RESULT AUDIT
       ===================================================== */

    router.get(
        "/matches/:id/audit",
        authenticateToken,
        async (req, res) => {

            try {

                const result =
                    await pool.query(
                        `
                        SELECT
                            v.*,
                            u.username AS selected_username

                        FROM efootball_result_verifications v

                        JOIN users u
                            ON u.id = v.selected_player_id

                        JOIN efootball_matches m
                            ON m.id = v.match_id

                        WHERE
                            v.match_id = $1
                            AND (
                                m.creator_id = $2
                                OR m.opponent_id = $2
                            )

                        LIMIT 1
                        `,
                        [
                            req.params.id,
                            req.user.userId
                        ]
                    );

                if (!result.rows.length) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "No verification record found."
                    });
                }

                return res.json({
                    success: true,
                    audit: result.rows[0]
                });

            } catch (error) {

                console.error(
                    "GET /audit error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load verification."
                });
            }
        }
    );


    /* =====================================================
       SUBMIT SCREENSHOT AUDIT
       ===================================================== */

    router.post("/matches/:id/audit/screenshot", authenticateToken, receiveScreenshot, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        const file = req.file;
        if (!Number.isSafeInteger(matchId) || matchId <= 0) return res.status(400).json({ success: false, message: "Invalid match ID." });
        if (!file) return res.status(400).json({ success: false, message: "Choose a match screenshot to upload." });

        const buffer = file.buffer;
        let extension = null;
        if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && file.mimetype === "image/jpeg") extension = ".jpg";
        if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && file.mimetype === "image/png") extension = ".png";
        if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" && file.mimetype === "image/webp") extension = ".webp";
        if (!extension) return res.status(400).json({ success: false, message: "The uploaded file is not a valid JPEG, PNG or WebP image." });

        let storedName = null;
        const uploadDirectory = path.join(__dirname, "..", "uploads", "match-verification");
        try {
            const permission = await pool.query(
                "SELECT v.selected_player_id, v.screenshot_path, m.status AS match_status FROM efootball_result_verifications v JOIN efootball_matches m ON m.id=v.match_id WHERE v.match_id=$1",
                [matchId]
            );
            if (!permission.rows.length) return res.status(404).json({ success: false, message: "No screenshot verification is waiting for this match." });
            const record = permission.rows[0];
            if (Number(record.selected_player_id) !== userId) return res.status(403).json({ success: false, message: "You were not selected to submit this screenshot." });
            if (!["awaiting_verification", "disputed"].includes(record.match_status)) return res.status(409).json({ success: false, message: "This match is not waiting for screenshot verification." });
            if (record.screenshot_path) return res.status(409).json({ success: false, message: "A screenshot has already been submitted for this match." });

            await fs.promises.mkdir(uploadDirectory, { recursive: true });
            storedName = randomUUID() + extension;
            await fs.promises.writeFile(path.join(uploadDirectory, storedName), buffer, { flag: "wx" });

            let analysis = { text: "", candidates: [] };
            try {
                analysis = await analyzeScreenshot(buffer);
            } catch (ocrError) {
                console.error("Screenshot OCR unavailable:", ocrError.message);
            }

            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const locked = await client.query(
                    "SELECT v.id AS verification_id,v.selected_player_id,v.screenshot_path,m.id AS match_id,m.status AS match_status,m.creator_id,m.opponent_id,m.creator_submitted_score,m.creator_submitted_opponent_score FROM efootball_result_verifications v JOIN efootball_matches m ON m.id=v.match_id WHERE v.match_id=$1 FOR UPDATE OF v,m",
                    [matchId]
                );
                if (!locked.rows.length || Number(locked.rows[0].selected_player_id) !== userId) {
                    await client.query("ROLLBACK");
                    return res.status(403).json({ success: false, message: "You are not authorized to submit this screenshot." });
                }
                const current = locked.rows[0];
                if (current.screenshot_path) {
                    await client.query("ROLLBACK");
                    try { await fs.promises.unlink(path.join(uploadDirectory, storedName)); } catch (_) {}
                    storedName = null;
                    return res.status(409).json({ success: false, message: "A screenshot has already been submitted." });
                }
                const disputed = current.match_status === "disputed";
                const matched = !disputed && matchesExpected(
                    analysis.candidates,
                    current.creator_submitted_score,
                    current.creator_submitted_opponent_score
                );
                const scoreCheck = disputed ? "disputed" : matched ? "matched" : analysis.candidates.length ? "mismatch" : "uncertain";
                await client.query(
                    "UPDATE efootball_result_verifications SET screenshot_path=$1,submitted_at=NOW(),status=$2,screenshot_ocr_text=$3,detected_score_candidates=$4::jsonb,score_check=$5 WHERE id=$6",
                    [storedName, matched ? "verified" : "review_required", analysis.text, JSON.stringify(analysis.candidates), scoreCheck, current.verification_id]
                );

                let settlement = null;
                if (matched) {
                    const matchResult = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
                    const match = matchResult.rows[0];
                    settlement = await settleEfootballMatch(client, match, {
                        creatorScore: match.creator_submitted_score,
                        opponentScore: match.creator_submitted_opponent_score
                    }, userId);
                    const message = "The screenshot score matched both submitted results. Your match has been verified and the standings updated.";
                    await createSystemNotification(client, Number(match.creator_id), "match_verified", "Result Verified", message, matchId);
                    await createSystemNotification(client, Number(match.opponent_id), "match_verified", "Result Verified", message, matchId);
                } else {
                    await client.query(
                        "UPDATE efootball_matches SET status='disputed',result_status='disputed' WHERE id=$1 AND status<>'completed'",
                        [matchId]
                    );
                    const message = "The screenshot score could not confirm the submitted result. An admin will review the evidence; any locked match funds remain on hold.";
                    await createSystemNotification(client, Number(current.creator_id), "match_admin_review", "Admin Review Required", message, matchId);
                    await createSystemNotification(client, Number(current.opponent_id), "match_admin_review", "Admin Review Required", message, matchId);
                }
                await client.query("COMMIT");
                return res.json({
                    success: true,
                    verified: matched,
                    pendingAdminReview: !matched,
                    scoreCheck: scoreCheck,
                    scoreCandidates: analysis.candidates,
                    settlement: settlement,
                    message: matched
                        ? "Screenshot score matched. The result and standings are updated."
                        : "Screenshot stored securely. OCR could not verify the exact score, so an admin must review it."
                });
            } catch (error) {
                try { await client.query("ROLLBACK"); } catch (_) {}
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            if (storedName) {
                try { await fs.promises.unlink(path.join(uploadDirectory, storedName)); } catch (_) {}
            }
            console.error("Screenshot verification error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to process the screenshot. Please try again." });
        }
    });
    /* =====================================================
       SYSTEM NOTIFICATIONS
       ===================================================== */

    router.get(
        "/notifications",
        authenticateToken,
        async (req, res) => {

            try {

                const result =
                    await pool.query(
                        `
                        SELECT
                            id,
                            type,
                            title,
                            message,
                            match_id,
                            read_at,
                            created_at

                        FROM system_notifications

                        WHERE user_id = $1

                        ORDER BY created_at DESC

                        LIMIT 100
                        `,
                        [req.user.userId]
                    );

                return res.json({
                    success: true,
                    notifications:
                        result.rows
                });

            } catch (error) {

                console.error(
                    "GET /notifications error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load notifications."
                });
            }
        }
    );


    /* =====================================================
       MARK NOTIFICATION READ
       ===================================================== */

    router.post(
        "/notifications/:id/read",
        authenticateToken,
        async (req, res) => {

            try {

                const result =
                    await pool.query(
                        `
                        UPDATE system_notifications

                        SET read_at = NOW()

                        WHERE
                            id = $1
                            AND user_id = $2

                        RETURNING id
                        `,
                        [
                            req.params.id,
                            req.user.userId
                        ]
                    );

                if (!result.rows.length) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Notification not found."
                    });
                }

                return res.json({
                    success: true
                });

            } catch (error) {

                console.error(
                    "POST /notifications/:id/read error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to mark notification as read."
                });
            }
        }
    );


    /* =====================================================
       STATUS
       ===================================================== */

    router.get(
        "/status",
        authenticateToken,
        async (req, res) => {

            try {

                const result =
                    await pool.query(
                        `
                        SELECT
                            COUNT(*) FILTER (
                                WHERE status IN
                                (
                                    'waiting',
                                    'playing'
                                )
                            ) AS active_matches,

                            COUNT(*) AS total_matches

                        FROM efootball_matches

                        WHERE
                            creator_id = $1
                            OR opponent_id = $1
                        `,
                        [req.user.userId]
                    );

                return res.json({
                    success: true,
                    status: result.rows[0]
                });

            } catch (error) {

                console.error(
                    "GET /status error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Unable to load eFootball status."
                });
            }
        }
    );


    const searchExpiryTimer = setInterval(() => {
        expireStaleSearches().catch(() => {});
    }, 15000);
    if (typeof searchExpiryTimer.unref === "function") searchExpiryTimer.unref();

    return router;
};





