"use strict";

const express = require("express");
const { randomUUID, randomInt } = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { settleEfootballMatch } = require("../services/efootballsettlement");
const { recordJournal } = require("../services/financialLedger");
const {
    ensureTournamentRound, ensureLeagueRound,
} = require("../services/efootballtournament");
const { analyzeScreenshot, matchesExpected } = require("../services/imageverification");

module.exports = function (pool, authenticateToken, io, pushService) {

    const router = express.Router();
    const SEARCH_PRESENCE_TTL_SECONDS = 120;
    const ACTIVE_PRESENCE_SECONDS = 60;
    const COMPETITION_ATTENDANCE_MINUTES = 5;
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

    function analyzeScreenshotWithTimeout(buffer) {
        let timeout;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("OCR analysis timed out after 15 seconds.")), 15000);
        });
        return Promise.race([analyzeScreenshot(buffer), timeoutPromise])
            .finally(() => clearTimeout(timeout));
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

        const inserted = await client.query(
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
            RETURNING id, created_at
            `,
            [
                userId,
                type,
                title,
                message,
                matchId
            ]
        );
        if (io && inserted.rows[0]) {
            io.to("user_" + Number(userId)).emit("efootball:notification", {
                id: Number(inserted.rows[0].id),
                type: String(type || ""),
                title: String(title || ""),
                message: String(message || ""),
                match_id: matchId == null ? null : Number(matchId),
                created_at: inserted.rows[0].created_at
            });
        }
    }

    async function ensureResultVerification(client, match) {
        const existing = await client.query(
            "SELECT id,selected_player_id,screenshot_path FROM efootball_result_verifications WHERE match_id=$1 ORDER BY id LIMIT 1 FOR UPDATE",
            [match.id]
        );
        if (existing.rows[0]) return existing.rows[0];
        const participants = [Number(match.creator_id), Number(match.opponent_id)].filter(Number.isSafeInteger);
        if (participants.length !== 2) return null;
        const selectedPlayerId = participants[randomInt(0, participants.length)];
        const inserted = await client.query(
            "INSERT INTO efootball_result_verifications(match_id,selected_player_id,status,score_check) VALUES($1,$2,'awaiting_scores','awaiting_scores') RETURNING id,selected_player_id,screenshot_path",
            [match.id, selectedPlayerId]
        );
        return inserted.rows[0];
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
                    await recordJournal(client, {
                        reference: "EF-SEARCH-EXPIRED-JOURNAL-" + match.id,
                        transactionType: "efootball_search_stake_refund",
                        amount: stake,
                        description: "Expired eFootball search stake returned to the player",
                        context: { matchId: Number(match.id), userId: Number(match.creator_id) },
                        postings: [
                            { accountType: "efootball_match_locked", accountId: Number(match.creator_id), debit: stake },
                            { accountType: "user_wallet_available", accountId: Number(match.creator_id), credit: stake }
                        ]
                    });
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

    async function queuePush(client, userId, event) {
        if (pushService && typeof pushService.enqueueNotification === "function") {
            await client.query("SAVEPOINT efootball_push_enqueue");
            try {
                const queued = await pushService.enqueueNotification(client, userId, event);
                await client.query("RELEASE SAVEPOINT efootball_push_enqueue");
                return queued;
            } catch (error) {
                await client.query("ROLLBACK TO SAVEPOINT efootball_push_enqueue").catch(() => {});
                await client.query("RELEASE SAVEPOINT efootball_push_enqueue").catch(() => {});
                // Push delivery is useful but must not roll back the match or
                // either player's score report.
                console.error("eFootball push enqueue failed:", error.message);
                return null;
            }
        }
        return null;
    }

    function emitMatchUpdate(userId, matchId, reason) {
        if (!io || !userId) return;
        io.to("user_" + Number(userId)).emit("efootball:match-update", {
            matchId: Number(matchId),
            reason: String(reason || "match-updated")
        });
    }

    function wakePushQueue() {
        if (pushService && typeof pushService.sendPendingJobs === "function") {
            pushService.sendPendingJobs().catch(() => {});
        }
    }

    async function settleTournamentWalkover(matchId) {
        const client = await pool.connect();
        let resolved = null;
        try {
            await client.query("BEGIN");
            const peek = await client.query(
                "SELECT id,tournament_fixture_id,league_fixture_id FROM efootball_matches WHERE id=$1 AND ((mode='tournament' AND tournament_id IS NOT NULL) OR (mode LIKE 'league-%' AND league_fixture_id IS NOT NULL))",
                [matchId]
            );
            if (!peek.rows.length) {
                await client.query("COMMIT");
                return null;
            }
            if (peek.rows[0].tournament_fixture_id) {
                await client.query("SELECT id FROM efootball_tournament_fixtures WHERE id=$1 FOR UPDATE", [peek.rows[0].tournament_fixture_id]);
            } else if (peek.rows[0].league_fixture_id) {
                await client.query("SELECT id FROM efootball_league_fixtures WHERE id=$1 FOR UPDATE", [peek.rows[0].league_fixture_id]);
            }
            const found = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            const match = found.rows[0];
            if (!match.opponent_id || !match.attendance_deadline_at || match.settled_at ||
                !["waiting", "ready", "playing", "awaiting_verification"].includes(match.status)) {
                await client.query("COMMIT");
                return null;
            }

            const deadline = await client.query(
                `SELECT attendance_deadline_at <= NOW() AS due,
                        creator_last_seen_at > NOW()-($2::int*INTERVAL '1 second') AS creator_present,
                        opponent_last_seen_at > NOW()-($2::int*INTERVAL '1 second') AS opponent_present
                   FROM efootball_matches WHERE id=$1`,
                [matchId, ACTIVE_PRESENCE_SECONDS]
            );
            const presence = deadline.rows[0];
            if (!presence.due || Boolean(presence.creator_present) === Boolean(presence.opponent_present)) {
                await client.query("COMMIT");
                return null;
            }

            const winnerId = presence.creator_present ? Number(match.creator_id) : Number(match.opponent_id);
            const creatorScore = winnerId === Number(match.creator_id) ? 3 : 0;
            const opponentScore = winnerId === Number(match.opponent_id) ? 3 : 0;
            await settleEfootballMatch(client, match, { creatorScore, opponentScore }, winnerId);
            await client.query(
                `UPDATE efootball_matches SET result_status='walkover' WHERE id=$1`,
                [matchId]
            );

            const fixtureResult = match.tournament_fixture_id
                ? await client.query("SELECT * FROM efootball_tournament_fixtures WHERE id=$1 FOR UPDATE", [match.tournament_fixture_id])
                : match.league_fixture_id
                    ? await client.query("SELECT * FROM efootball_league_fixtures WHERE id=$1 FOR UPDATE", [match.league_fixture_id])
                    : { rows: [] };
            if (fixtureResult.rows[0]) {
                const fixture = fixtureResult.rows[0];
                const homeScore = Number(fixture.home_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                const awayScore = Number(fixture.away_id) === Number(match.creator_id) ? creatorScore : opponentScore;
                const fixtureTable = match.tournament_fixture_id ? "efootball_tournament_fixtures" : "efootball_league_fixtures";
                await client.query(
                    `UPDATE ${fixtureTable} SET status='walkover',home_score=$1,away_score=$2,winner_id=$3,resolved_at=NOW() WHERE id=$4`,
                    [homeScore, awayScore, winnerId, fixture.id]
                );
            }
            if (match.tournament_id) {
                await client.query(
                    `UPDATE efootball_tournament_members SET first_match_at=COALESCE(first_match_at,NOW())
                      WHERE tournament_id=$1 AND user_id=ANY($2::int[])`,
                    [match.tournament_id, [Number(match.creator_id), Number(match.opponent_id)]]
                );
            }

            for (const participantId of [Number(match.creator_id), Number(match.opponent_id)]) {
                const competitionName = match.tournament_id ? "tournament" : (match.league || "league") + " league";
                const participantMessage = participantId === winnerId
                    ? "You received the " + competitionName + " walkover after the 5-minute Match Hub check-in ended."
                    : "Your opponent received the " + competitionName + " walkover after the 5-minute Match Hub check-in ended.";
                await createSystemNotification(client, participantId, "competition_walkover", "Match walkover", participantMessage, matchId);
                await queuePush(client, participantId, {
                    eventKey: "efootball-competition-match:" + matchId + ":walkover:" + participantId,
                    matchId,
                    title: "Match walkover",
                    body: participantMessage,
                    page: "match-results"
                });
            }
            await client.query("COMMIT");
            resolved = { creatorId: Number(match.creator_id), opponentId: Number(match.opponent_id) };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Tournament walkover settlement failed:", error.message);
        } finally {
            client.release();
        }
        if (resolved) {
            emitMatchUpdate(resolved.creatorId, matchId, "tournament-walkover");
            emitMatchUpdate(resolved.opponentId, matchId, "tournament-walkover");
            wakePushQueue();
        }
        return resolved;
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
                v.score_check AS score_check,
                (v.screenshot_path IS NOT NULL) AS screenshot_submitted,
                v.selected_player_id AS screenshot_sender_id,
                (m.creator_last_seen_at > NOW() - ($3::int * INTERVAL '1 second')) AS creator_present_now,
                (m.opponent_last_seen_at > NOW() - ($3::int * INTERVAL '1 second')) AS opponent_present_now,
                EXISTS (SELECT 1 FROM complaints c WHERE c.match_id=m.id AND c.source='efootball_result_dispute') AS admin_complaint_submitted,
                (SELECT c.complaint_ref FROM complaints c WHERE c.match_id=m.id AND c.source='efootball_result_dispute' ORDER BY c.id DESC LIMIT 1) AS admin_complaint_ref

            FROM efootball_matches m

            JOIN users creator
                ON creator.id = m.creator_id

            LEFT JOIN users opponent
                ON opponent.id = m.opponent_id

            LEFT JOIN users winner
                ON winner.id = m.winner_id

            LEFT JOIN LATERAL (
                SELECT status, score_check, screenshot_path, selected_player_id
                  FROM efootball_result_verifications
                 WHERE match_id = m.id
                 ORDER BY (screenshot_path IS NOT NULL) DESC, id DESC
                 LIMIT 1
            ) v ON TRUE

            WHERE m.id = $1
              AND (
                    m.creator_id = $2
                    OR m.opponent_id = $2
                  )

            LIMIT 1
            `,
            [
                matchId,
                userId,
                ACTIVE_PRESENCE_SECONDS
            ]
        );

        return result.rows[0] ? presentMatch(result.rows[0], userId) : null;
    }

    function presentMatch(match, userId) {
        if (!match) return null;
        const isCreator = Number(match.creator_id) === Number(userId);
        const creatorId = Number(match.creator_id);
        const opponentId = match.opponent_id == null ? null : Number(match.opponent_id);
        const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
        const shownCode = match.external_room_code || null;
        const safe = { ...match };
        // room_code is an internal unique placeholder required by the legacy
        // table. Never expose it as if it were the real eFootball room code.
        const senderIsParticipant = senderId !== null && (senderId === creatorId || senderId === opponentId);
        const isSender = senderIsParticipant && senderId === Number(userId);
        const receiverId = senderIsParticipant && opponentId !== null
            ? (senderId === creatorId ? opponentId : creatorId)
            : null;
        safe.room_code = shownCode && !isSender && !match.code_correction_requested_at ? shownCode : null;
        delete safe.external_room_code;
        safe.opponentFound = Boolean(match.opponent_id);
        safe.youAreCreator = isCreator;
        safe.youAreSender = isSender;
        safe.youAreReceiver = senderIsParticipant && receiverId === Number(userId);
        safe.codeReceived = Boolean(senderIsParticipant && match.code_received_at && Number(match.code_received_by) === receiverId);
        safe.codeReceivedAt = match.code_received_at || null;
        safe.codeSentAt = match.code_sent_at || null;
        safe.codeCorrectionRequested = Boolean(match.code_correction_requested_at);
        safe.codeCorrectionRequestedAt = match.code_correction_requested_at || null;
        safe.roomCodeRevision = Number(match.room_code_revision || 0);
        safe.codeSenderName = senderId === Number(match.creator_id)
            ? (match.creator_username || null)
            : senderId === Number(match.opponent_id)
                ? (match.opponent_username || null)
                : null;
        safe.codeReceiverId = receiverId;
        safe.codeReceiverName = receiverId === creatorId
            ? (match.creator_username || null)
            : receiverId === opponentId
                ? (match.opponent_username || null)
                : null;
        safe.yourName = isCreator ? match.creator_username : match.opponent_username;
        safe.opponentName = isCreator ? match.opponent_username : match.creator_username;
        safe.yourReady = Boolean(isCreator ? match.creator_ready : match.opponent_ready);
        safe.opponentReady = Boolean(isCreator ? match.opponent_ready : match.creator_ready);
        safe.codeSent = Boolean(match.code_sent && match.external_room_code);
        safe.verificationStatus = match.verification_status || null;
        safe.scoreCheck = match.score_check || null;
        safe.screenshotSubmitted = Boolean(match.screenshot_submitted);
        safe.youMustUploadScreenshot = match.screenshot_sender_id != null && Number(match.screenshot_sender_id) === Number(userId);
        safe.resultRound = Number(match.result_round || 1);
        safe.adminComplaintSubmitted = Boolean(match.admin_complaint_submitted);
        safe.adminComplaintRef = match.admin_complaint_ref || null;
        safe.attendanceDeadlineAt = match.attendance_deadline_at || null;
        safe.attendanceCountdownSeconds = match.attendance_deadline_at
            ? Math.max(0, Math.ceil((new Date(match.attendance_deadline_at).getTime() - Date.now()) / 1000))
            : null;
        safe.youArePresent = Boolean(isCreator ? match.creator_present_now : match.opponent_present_now);
        safe.opponentIsPresent = Boolean(isCreator ? match.opponent_present_now : match.creator_present_now);
        const ownSubmitted = isCreator ? Boolean(match.creator_submitted) : Boolean(match.opponent_submitted);
        safe.canEditScore = match.status === "playing" && !ownSubmitted;
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
                        AND COALESCE(m.finished_at, m.created_at) > COALESCE(
                            (SELECT cleared_at FROM user_history_clears
                             WHERE user_id = $1 AND history_type = 'matches'),
                            '-infinity'::timestamptz
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
        let roundName = cleanRound(req.body && req.body.round_name);
        const tournamentId = req.body && req.body.tournament_id ? Number(req.body.tournament_id) : null;
        let tournamentFixtureId = null;
        let leagueId = null;
        let leagueFixtureId = null;
        const requestedLeagueFixtureId = req.body && req.body.league_fixture_id != null
            ? Number(req.body.league_fixture_id)
            : null;
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
        if (isLeague && requestedLeagueFixtureId !== null &&
            (!Number.isSafeInteger(requestedLeagueFixtureId) || requestedLeagueFixtureId <= 0)) {
            return res.status(400).json({ success: false, message: "Choose a valid released league fixture." });
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
                    "SELECT l.id,l.name FROM efootball_league_members lm JOIN efootball_leagues l ON l.id=lm.league_id WHERE lm.user_id=$1 AND LOWER(l.name)=LOWER($2)",
                    [userId, league]
                );
                if (!member.rows.length) throw Object.assign(new Error("Join this league before starting a league match."), { status: 403 });
                leagueId = Number(member.rows[0].id);
                const round = await ensureLeagueRound(client, leagueId, true);
                if (!round || round.completed_at) throw Object.assign(new Error("This league round has ended. Refresh the fixtures for the next round."), { status: 409 });
                const fixture = await client.query(
                    `SELECT f.id,f.home_id,f.away_id,f.match_id,m.status AS match_status
                       FROM efootball_league_fixtures f
                       LEFT JOIN efootball_matches m ON m.id=f.match_id
                      WHERE f.league_id=$1 AND f.round_number=$2
                        AND (f.home_id=$3 OR f.away_id=$3)
                        AND ($4::bigint IS NULL OR f.id=$4)
                        AND f.status IN ('scheduled','playing')
                      ORDER BY f.id LIMIT 1 FOR UPDATE OF f`,
                    [leagueId, round.round_number, userId, requestedLeagueFixtureId]
                );
                if (!fixture.rows.length) throw Object.assign(new Error("You have no playable fixture in this league round. Refresh the live fixtures or wait for the next round."), { status: 409 });
                const selectedFixture = fixture.rows[0];
                if (selectedFixture.away_id == null) throw Object.assign(new Error("You have a bye this league round. Your next fixture will appear when the round ends."), { status: 409 });
                if (selectedFixture.match_id && selectedFixture.match_status === "cancelled") {
                    await client.query("UPDATE efootball_league_fixtures SET match_id=NULL,status='scheduled' WHERE id=$1", [selectedFixture.id]);
                }
                leagueFixtureId = Number(selectedFixture.id);
                roundName = "League Round " + Number(round.round_number);
            }
            if (isTournament) {
                const member = await client.query(
                    "SELECT tm.group_code FROM efootball_tournament_members tm JOIN efootball_tournaments t ON t.id=tm.tournament_id WHERE tm.user_id=$1 AND tm.tournament_id=$2 AND t.status IN ('open','in_progress')",
                    [userId, tournamentId]
                );
                if (!member.rows.length) throw Object.assign(new Error("Join an open tournament before starting a tournament match."), { status: 403 });
                if (!member.rows[0].group_code) throw Object.assign(new Error("Your tournament group is not assigned yet. Please refresh and try again."), { status: 409 });
                const round = await ensureTournamentRound(client, tournamentId, true);
                if (!round || round.completed_at) throw Object.assign(new Error("This tournament round has ended. Refresh the fixtures for the next round."), { status: 409 });
                let fixture = await client.query(
                    `SELECT f.id, f.home_id, f.away_id, f.match_id, m.status AS match_status
                       FROM efootball_tournament_fixtures f
                       LEFT JOIN efootball_matches m ON m.id=f.match_id
                      WHERE f.tournament_id=$1 AND f.round_number=$2
                        AND (f.home_id=$3 OR f.away_id=$3)
                        AND f.status IN ('scheduled','playing')
                      ORDER BY f.id LIMIT 1 FOR UPDATE OF f`,
                    [tournamentId, round.round_number, userId]
                );
                if (!fixture.rows.length) throw Object.assign(new Error("You have no playable fixture in this round. Check the group table for your bye or wait for the next round."), { status: 409 });
                const selectedFixture = fixture.rows[0];
                if (selectedFixture.away_id == null) throw Object.assign(new Error("You have a bye this round. Your next fixture will appear when the round ends."), { status: 409 });
                if (selectedFixture.match_id && selectedFixture.match_status === "cancelled") {
                    await client.query(
                        "UPDATE efootball_tournament_fixtures SET match_id=NULL,status='scheduled' WHERE id=$1",
                        [selectedFixture.id]
                    );
                }
                tournamentFixtureId = Number(selectedFixture.id);
                roundName = "Group " + member.rows[0].group_code + " · Round " + Number(round.round_number);
            }

            // Serialize searches for the same ranked stake, league division,
            // tournament round, or tournament. Two simultaneous searches
            // should join the same waiting player instead of making parallel
            // orphan queue entries.
            const queueKey = [
                "goal-gambit-efootball", mode, league || "", roundName || "",
                tournamentId || "", tournamentFixtureId || "", stake
            ].join(":");
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                [queueKey]
            );

            const existing = await client.query(
                "SELECT id,mode,league,tournament_id,tournament_fixture_id,league_fixture_id FROM efootball_matches WHERE (creator_id=$1 OR opponent_id=$1) AND status IN ('waiting','ready','playing','awaiting_verification','disputed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
                [userId]
            );
            if (existing.rows.length) {
                const current = existing.rows[0];
                if (current.mode !== mode || (isLeague && String(current.league || "").toLowerCase() !== String(league || "").toLowerCase()) ||
                    (isTournament && Number(current.tournament_id) !== Number(tournamentId)) ||
                    (isLeague && Number(current.league_fixture_id) !== Number(leagueFixtureId)) ||
                    (isTournament && Number(current.tournament_fixture_id) !== Number(tournamentFixtureId))) {
                    throw Object.assign(new Error("You already have an active match in another queue. Finish or cancel it before entering this mode."), { status: 409 });
                }
                const match = await getMatchForUser(client, current.id, userId);
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
                    AND waiting.tournament_fixture_id IS NOT DISTINCT FROM $8
                    AND waiting.league_fixture_id IS NOT DISTINCT FROM $9
                    AND waiting_player.account_status='active'
                    AND waiting_player.game IN ('konami','both')
                    AND NOT EXISTS (
                        SELECT 1 FROM efootball_matches other
                         WHERE other.id<>waiting.id
                           AND other.status IN ('waiting','ready','playing','awaiting_verification','disputed')
                           AND (other.creator_id=waiting.creator_id OR other.opponent_id=waiting.creator_id)
                    )
                  ORDER BY waiting.created_at, waiting.id LIMIT 1 FOR UPDATE OF waiting SKIP LOCKED`,
                [userId, mode, league, roundName, tournamentId, stake, SEARCH_PRESENCE_TTL_SECONDS, tournamentFixtureId, leagueFixtureId]
            );

            if (candidate.rows.length) {
                if (stake > 0) {
                    const locked = await client.query(
                        "UPDATE wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING user_id",
                        [stake, userId]
                    );
                    if (!locked.rows.length) throw Object.assign(new Error("Insufficient available wallet balance. You need KSh " + stake.toFixed(2) + " to join this match."), { status: 402 });
                }
                const senderId = randomInt(0, 2) === 0 ? Number(candidate.rows[0].creator_id) : userId;
                await client.query(
                    `UPDATE efootball_matches
                        SET opponent_id=$1, code_sender_id=$2, creator_ready=FALSE, opponent_ready=FALSE,
                            paired_at=CASE WHEN mode='tournament' OR mode LIKE 'league-%' THEN NOW() ELSE paired_at END,
                            attendance_deadline_at=CASE WHEN mode='tournament' OR mode LIKE 'league-%' THEN NOW()+($4::int*INTERVAL '1 minute') ELSE NULL END,
                            creator_last_seen_at=NOW(), opponent_last_seen_at=NOW()
                      WHERE id=$3`,
                    [userId, senderId, candidate.rows[0].id, COMPETITION_ATTENDANCE_MINUTES]
                );
                if (isTournament) {
                    await client.query(
                        "UPDATE efootball_tournament_fixtures SET match_id=$1,status='playing' WHERE id=$2",
                        [candidate.rows[0].id, tournamentFixtureId]
                    );
                }
                if (isLeague) {
                    await client.query("UPDATE efootball_league_fixtures SET match_id=$1,status='playing' WHERE id=$2", [candidate.rows[0].id, leagueFixtureId]);
                }
                if (stake > 0) {
                    const stakeReference = "EF-LOCK-" + candidate.rows[0].id + "-" + userId + "-" + randomUUID();
                    await client.query(
                        "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                        [userId, stake, stakeReference]
                    );
                    await recordJournal(client, {
                        reference: "EF-STAKE-LOCK-JOURNAL-" + candidate.rows[0].id + "-" + userId,
                        transactionType: "efootball_stake_lock",
                        amount: stake,
                        description: "eFootball stake moved to locked player funds",
                        context: { matchId: Number(candidate.rows[0].id), userId },
                        postings: [
                            { accountType: "user_wallet_available", accountId: userId, debit: stake },
                            { accountType: "efootball_match_locked", accountId: userId, credit: stake }
                        ]
                    });
                }

                const senderMessage = senderId === userId
                    ? "You were randomly chosen to create the eFootball room and send its code. Enter it on your match page when ready."
                    : "Your opponent was chosen to create the eFootball room. The room code will arrive here when sent.";
                const receiverId = senderId === userId ? Number(candidate.rows[0].creator_id) : userId;
                await createSystemNotification(client, senderId, "room_code_sender", "You are sending the room code", senderMessage, candidate.rows[0].id);
                await createSystemNotification(client, receiverId, "room_code_waiting", "Opponent is preparing the room code", "Your opponent will receive a reminder when the room code is sent.", candidate.rows[0].id);
                await queuePush(client, senderId, { eventKey: "efootball-match:" + candidate.rows[0].id + ":room-code-needed", matchId: candidate.rows[0].id, title: "GOAL$GAMBIT — Match Room Code", body: "Your opponent is waiting. Paste the room code below and tap Send.", page: "match-room" });
                const match = await getMatchForUser(client, candidate.rows[0].id, userId);
                await client.query("COMMIT");
                emitMatchUpdate(Number(candidate.rows[0].creator_id), candidate.rows[0].id, "opponent-found");
                emitMatchUpdate(userId, candidate.rows[0].id, "opponent-found");
                wakePushQueue();
                return res.status(201).json({ success: true, matched: true, message: "Opponent found.", match: match });
            }

            if (stake > 0) {
                const locked = await client.query(
                    "UPDATE wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING user_id",
                    [stake, userId]
                );
                if (!locked.rows.length) throw Object.assign(new Error("Insufficient available wallet balance. You need KSh " + stake.toFixed(2) + " to join this match."), { status: 402 });
            }

            const created = await client.query(
                `INSERT INTO efootball_matches
                    (creator_id,mode,league,round_name,tournament_id,tournament_fixture_id,league_fixture_id,stake_amount,room_code,status,
                     creator_ready,opponent_ready,code_sent,creator_submitted,opponent_submitted,search_last_seen_at,creator_last_seen_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting',FALSE,FALSE,FALSE,FALSE,FALSE,NOW(),NOW()) RETURNING id`,
                [userId, mode, league, roundName, tournamentId, tournamentFixtureId, leagueFixtureId, stake, roomCode()]
            );
            const matchId = created.rows[0].id;
            if (isTournament) {
                await client.query(
                    "UPDATE efootball_tournament_fixtures SET match_id=$1,status='playing' WHERE id=$2",
                    [matchId, tournamentFixtureId]
                );
            }
            if (isLeague) {
                await client.query("UPDATE efootball_league_fixtures SET match_id=$1,status='playing' WHERE id=$2", [matchId, leagueFixtureId]);
            }
            if (stake > 0) {
                const stakeReference = "EF-LOCK-" + matchId + "-" + userId + "-" + randomUUID();
                await client.query(
                    "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                    [userId, stake, stakeReference]
                );
                await recordJournal(client, {
                    reference: "EF-STAKE-LOCK-JOURNAL-" + matchId + "-" + userId,
                    transactionType: "efootball_stake_lock",
                    amount: stake,
                    description: "eFootball stake moved to locked player funds",
                    context: { matchId: Number(matchId), userId },
                    postings: [
                        { accountType: "user_wallet_available", accountId: userId, debit: stake },
                        { accountType: "efootball_match_locked", accountId: userId, credit: stake }
                    ]
                });
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
                await recordJournal(client, {
                    reference: "EF-CANCEL-JOURNAL-" + matchId,
                    transactionType: "efootball_match_stake_refund",
                    amount: stake * participantIds.length,
                    description: "eFootball match cancelled before play; locked stakes returned",
                    context: { matchId, participants: participantIds },
                    postings: participantIds.flatMap((participantId) => [
                        { accountType: "efootball_match_locked", accountId: participantId, debit: stake },
                        { accountType: "user_wallet_available", accountId: participantId, credit: stake }
                    ])
                });
            }
            const cancelledMatch = await client.query(
                `UPDATE efootball_matches
                    SET status='cancelled', result_status='cancelled', finished_at=NOW(), settled_at=NOW(),
                        search_last_seen_at=NULL, creator_ready=FALSE, opponent_ready=FALSE,
                        external_room_code=NULL, code_sent=FALSE, code_sender_id=NULL,
                        code_received_at=NULL, code_received_by=NULL,
                        code_correction_requested_at=NULL, code_correction_requested_by=NULL
                  WHERE id=$1 AND status IN ('waiting','ready') AND started_at IS NULL
                  RETURNING id`,
                [matchId]
            );
            if (!cancelledMatch.rows.length) {
                throw Object.assign(new Error("This match changed and can no longer be cancelled."), { status: 409 });
            }
            for (const participantId of participantIds) {
                const message = stake > 0
                    ? "This match was cancelled before play began. All locked stakes were refunded."
                    : "This match was cancelled before play began.";
                await createSystemNotification(
                    client,
                    participantId,
                    "match_cancelled",
                    "Match cancelled",
                    message,
                    matchId
                );
                await queuePush(client, participantId, {
                    eventKey: "efootball-match:" + matchId + ":cancelled",
                    matchId: matchId,
                    title: "Match cancelled",
                    body: message,
                    page: "match-room"
                });
            }
            await client.query("COMMIT");
            for (const participantId of participantIds) emitMatchUpdate(participantId, matchId, "match-cancelled");
            wakePushQueue();
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
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const found = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!found.rows.length) throw Object.assign(new Error("Match not found."), { status: 404 });
            const match = found.rows[0];
            const isCreator = Number(match.creator_id) === userId;
            const isOpponent = Number(match.opponent_id) === userId;
            if (!isCreator && !isOpponent) throw Object.assign(new Error("You are not part of this match."), { status: 403 });

            if (!match.opponent_id && match.status === "waiting" && isCreator) {
                if (!match.search_last_seen_at || new Date(match.search_last_seen_at).getTime() < Date.now() - SEARCH_PRESENCE_TTL_SECONDS * 1000) {
                    await client.query("COMMIT");
                    await expireStaleSearches(userId).catch(() => {});
                    return res.status(409).json({
                        success: false, expired: true,
                        message: "This search is no longer active. Any unmatched stake is being refunded; start a new search when ready."
                    });
                }
                await client.query(
                    "UPDATE efootball_matches SET search_last_seen_at=NOW(),creator_last_seen_at=NOW() WHERE id=$1",
                    [matchId]
                );
            } else if (match.opponent_id && ["waiting", "ready", "playing", "awaiting_verification"].includes(match.status)) {
                const column = isCreator ? "creator_last_seen_at" : "opponent_last_seen_at";
                await client.query("UPDATE efootball_matches SET " + column + "=NOW() WHERE id=$1", [matchId]);
            }
            await client.query("COMMIT");
            if (match.mode === "tournament" || /^league-(bronze|silver|gold)$/.test(match.mode)) await settleTournamentWalkover(matchId);
            const updated = await getMatchForUser(pool, matchId, userId);
            return res.json({ success: true, expiresInSeconds: SEARCH_PRESENCE_TTL_SECONDS, match: updated });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (error.status) return res.status(error.status).json({ success: false, message: error.message });
            return res.status(500).json({ success: false, message: "Unable to renew this match check-in." });
        } finally {
            client.release();
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

                const matchId = Number(req.params.id);
                let match = await getMatchForUser(pool, matchId, req.user.userId);
                if (!match) {
                    return res.status(404).json({ success: false, message: "Match not found." });
                }

                if (match.tournament_id || match.league_fixture_id) {
                    await settleTournamentWalkover(matchId);
                    const timerClient = await pool.connect();
                    try {
                        await timerClient.query("BEGIN");
                        if (match.tournament_id) {
                            await ensureTournamentRound(timerClient, Number(match.tournament_id), false);
                        } else {
                            const league = await timerClient.query("SELECT league_id FROM efootball_league_fixtures WHERE id=$1", [match.league_fixture_id]);
                            if (league.rows[0]) await ensureLeagueRound(timerClient, Number(league.rows[0].league_id), false);
                        }
                        await timerClient.query("COMMIT");
                    } catch (timerError) {
                        await timerClient.query("ROLLBACK").catch(() => {});
                        throw timerError;
                    } finally {
                        timerClient.release();
                    }
                    match = await getMatchForUser(pool, matchId, req.user.userId);
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

                if (match.mode === "tournament") {
                const eligible = await client.query(
                    `SELECT id FROM efootball_tournament_fixtures
                      WHERE id=$1 AND tournament_id=$2 AND status IN ('scheduled','playing')
                        AND (home_id=$3 OR away_id=$3) AND (home_id=$4 OR away_id=$4)
                      FOR UPDATE`,
                    [match.tournament_fixture_id, match.tournament_id, Number(match.creator_id), userId]
                );
                if (!eligible.rows.length) throw Object.assign(new Error("You are not the assigned opponent for this tournament fixture."), { status: 403 });
                } else if (/^league-(bronze|silver|gold)$/.test(match.mode)) {
                const eligible = await client.query(
                    `SELECT f.id FROM efootball_league_fixtures f
                      JOIN efootball_leagues l ON l.id=f.league_id
                      WHERE f.id=$1 AND LOWER(l.name)=LOWER($2)
                        AND f.status IN ('scheduled','playing')
                        AND (f.home_id=$3 OR f.away_id=$3) AND (f.home_id=$4 OR f.away_id=$4)
                      FOR UPDATE OF f`,
                    [match.league_fixture_id, match.league, Number(match.creator_id), userId]
                );
                if (!eligible.rows.length) throw Object.assign(new Error("You are not the assigned opponent for this league fixture."), { status: 403 });
            }

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
                    if (!wallet.rows.length) throw Object.assign(new Error("Insufficient available wallet balance. You need KSh " + Number(match.stake_amount).toFixed(2) + " to join this match."), { status: 402 });
            }
            const senderId = randomInt(0, 2) === 0 ? Number(match.creator_id) : userId;
            await client.query(
                `UPDATE efootball_matches
                    SET opponent_id=$1, code_sender_id=$2, creator_ready=FALSE, opponent_ready=FALSE,
                        paired_at=CASE WHEN mode='tournament' OR mode LIKE 'league-%' THEN NOW() ELSE paired_at END,
                        attendance_deadline_at=CASE WHEN mode='tournament' OR mode LIKE 'league-%' THEN NOW()+($4::int*INTERVAL '1 minute') ELSE NULL END,
                        creator_last_seen_at=NOW(),opponent_last_seen_at=NOW()
                  WHERE id=$3`,
                [userId, senderId, matchId, COMPETITION_ATTENDANCE_MINUTES]
            );
            if (match.mode === "tournament" && match.tournament_fixture_id) {
                await client.query("UPDATE efootball_tournament_fixtures SET match_id=$1,status='playing' WHERE id=$2", [matchId, match.tournament_fixture_id]);
            } else if (/^league-(bronze|silver|gold)$/.test(match.mode) && match.league_fixture_id) {
                await client.query("UPDATE efootball_league_fixtures SET match_id=$1,status='playing' WHERE id=$2", [matchId, match.league_fixture_id]);
            }
            if (Number(match.stake_amount) > 0) {
                const stakeReference = "EF-LOCK-" + matchId + "-" + userId + "-" + randomUUID();
                await client.query(
                    "INSERT INTO transactions (user_id,transaction_type,amount,currency,status,reference,description) VALUES ($1,'stake_lock',$2,'KES','completed',$3,'eFootball match stake locked')",
                    [userId, match.stake_amount, stakeReference]
                );
                await recordJournal(client, {
                    reference: "EF-STAKE-LOCK-JOURNAL-" + matchId + "-" + userId,
                    transactionType: "efootball_stake_lock",
                    amount: Number(match.stake_amount),
                    description: "eFootball stake moved to locked player funds",
                    context: { matchId: Number(matchId), userId },
                    postings: [
                        { accountType: "user_wallet_available", accountId: userId, debit: Number(match.stake_amount) },
                        { accountType: "efootball_match_locked", accountId: userId, credit: Number(match.stake_amount) }
                    ]
                });
            }
            const senderMessage = senderId === userId
                ? "You were randomly chosen to create the room and send its code. Use the match page to send it to your opponent."
                : "Your opponent was chosen to create the room. The code will arrive on your match page.";
            const receiverId = senderId === userId ? Number(match.creator_id) : userId;
            await createSystemNotification(client, senderId, "room_code_sender", "You are sending the room code", senderMessage, matchId);
            await createSystemNotification(client, receiverId, "room_code_waiting", "Opponent is preparing the room code", "Your opponent will be reminded when the code is sent.", matchId);
            await queuePush(client, senderId, { eventKey: "efootball-match:" + matchId + ":room-code-needed", matchId: matchId, title: "GOAL$GAMBIT — Match Room Code", body: "Your opponent is waiting. Paste the room code below and tap Send.", page: "match-room" });
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            emitMatchUpdate(Number(match.creator_id), matchId, "opponent-found");
            emitMatchUpdate(userId, matchId, "opponent-found");
            wakePushQueue();
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
                const match = matchResult.rows[0];

                if (!matchResult.rows.length) {

                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        success: false,
                        message: "Match not found."
                    });
                }
                if (/^league-(bronze|silver|gold)$/.test(match.mode)) {
                    const member = await client.query(
                        `SELECT 1 FROM efootball_league_members lm JOIN efootball_leagues l ON l.id=lm.league_id
                          WHERE lm.user_id=$1 AND LOWER(l.name)=LOWER($2)`,
                        [userId, match.league]
                    );
                    if (!member.rows.length) throw Object.assign(new Error("Join this league before joining its match."), { status: 403 });
                }

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

                if (!match.code_sent || !match.external_room_code || match.code_correction_requested_at) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "Wait for the selected player to send or replace the room code before marking ready." });
                }
                if (!match.code_received_at || Number(match.code_received_by) === Number(match.code_sender_id)) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ success: false, message: "The receiver must confirm the room code before either player can mark ready." });
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

                    if (match.tournament_id) {
                        await client.query(
                            `UPDATE efootball_tournament_members
                                SET first_match_at=COALESCE(first_match_at,NOW())
                              WHERE tournament_id=$1 AND user_id=ANY($2::int[])`,
                            [match.tournament_id, [Number(match.creator_id), Number(match.opponent_id)]]
                        );
                    }

                    await ensureResultVerification(client, updated);

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

                if (updated.creator_ready && updated.opponent_ready && updated.status === "waiting") {
                    const startedMessage = "Both players are ready. Your eFootball match can now be played.";
                    await queuePush(client, Number(match.creator_id), { eventKey: "efootball-match:" + match.id + ":started", matchId: match.id, title: "Match Started", body: startedMessage, page: "match-results" });
                    await queuePush(client, Number(match.opponent_id), { eventKey: "efootball-match:" + match.id + ":started", matchId: match.id, title: "Match Started", body: startedMessage, page: "match-results" });
                }
                await client.query("COMMIT");
                emitMatchUpdate(Number(match.creator_id), match.id, "ready-updated");
                emitMatchUpdate(Number(match.opponent_id), match.id, "ready-updated");
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
        if (!/^[A-Za-z0-9 _-]{1,50}$/.test(code)) return res.status(400).json({ success: false, message: "Enter a room code using letters, numbers, spaces, hyphens or underscores (up to 50 characters)." });

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
            if (!match.opponent_id || !["waiting", "ready"].includes(match.status) || match.started_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The room code can only be sent before the game starts." });
            }

            const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
            const matchParticipants = [Number(match.creator_id), Number(match.opponent_id)];
            if (!matchParticipants.includes(senderId)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match has no valid room-code sender. Contact support before sending a code." });
            }
            if (senderId !== userId) {
                await client.query("COMMIT");
                return res.status(403).json({ success: false, message: "Your opponent was randomly selected to send the room code." });
            }
            const replacingCode = Boolean(
                match.code_sent &&
                match.code_correction_requested_at &&
                Number(match.code_correction_requested_by) !== senderId
            );
            if (match.code_sent && !replacingCode) {
                if (String(match.external_room_code || "") === code) {
                    const updated = await getMatchForUser(client, matchId, userId);
                    await client.query("COMMIT");
                    return res.json({ success: true, duplicate: true, message: "This room code was already saved and sent to your opponent.", room_code: code, match: updated });
                }
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The room code has already been sent. The receiver must explicitly request a replacement before you can send another." });
            }

            const receiverId = senderId === Number(match.creator_id) ? Number(match.opponent_id) : Number(match.creator_id);
            const savedCode = await client.query(
                `UPDATE efootball_matches
                    SET external_room_code=$1,
                        code_sent=TRUE,
                        code_sent_at=NOW(),
                        room_code_revision=room_code_revision+1,
                        code_received_at=NULL,
                        code_received_by=NULL,
                        code_correction_requested_at=NULL,
                        code_correction_requested_by=NULL,
                        creator_ready=CASE WHEN creator_id=$2 THEN TRUE ELSE FALSE END,
                        opponent_ready=CASE WHEN opponent_id=$2 THEN TRUE ELSE FALSE END,
                        status='waiting'
                  WHERE id=$3
                  RETURNING room_code_revision`,
                [code, userId, matchId]
            );
            const revision = Number(savedCode.rows[0] && savedCode.rows[0].room_code_revision || Number(match.room_code_revision || 0) + 1);
            const receiver = await client.query("SELECT username FROM users WHERE id=$1", [receiverId]);
            const sender = await client.query("SELECT username FROM users WHERE id=$1", [userId]);
            await createSystemNotification(
                client, receiverId, replacingCode ? "room_code_replaced" : "room_code", "ROOM CODE RECEIVED",
                (replacingCode ? "Your opponent sent a replacement official eFootball room code for Match GG-" : "Your opponent sent the official eFootball room code for Match GG-") + matchId + ". Open the match room to view it and confirm receipt.", matchId
            );
            await createSystemNotification(
                client, senderId, "room_code_sent", "Room code delivered",
                "Your room code was sent privately to " + (receiver.rows[0] && receiver.rows[0].username || "your opponent") + ".", matchId
            );
            await queuePush(client, receiverId, { eventKey: "efootball-match:" + matchId + ":room-code-sent:" + revision, matchId: matchId, title: "GOAL$GAMBIT — Match Room Code", body: "Your opponent has sent the room code. Open your match to view it.", page: "match-room" });
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            emitMatchUpdate(receiverId, matchId, "room-code-sent");
            emitMatchUpdate(senderId, matchId, "room-code-sent");
            wakePushQueue();
            return res.json({ success: true, message: "Room code sent privately to your opponent.", room_code: code, match: updated });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("Room-code send error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to send room code." });
        } finally {
            client.release();
        }
    }

    async function sendRoomCodeAppNotification(req, res) {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid match ID." });
        }
        if (!pushService || typeof pushService.enqueueNotification !== "function" ||
            typeof pushService.status !== "function" || !pushService.status().androidConfigured) {
            return res.status(503).json({ success: false, message: "Android companion notifications are not available right now." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!result.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Match not found." });
            }

            const match = result.rows[0];
            const participantIds = [Number(match.creator_id), Number(match.opponent_id)];
            if (!participantIds.includes(userId)) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
            if (!senderId || !participantIds.includes(senderId)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match has no valid room-code sender." });
            }
            if (senderId !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "Only the selected room-code sender can notify the companion app." });
            }
            if (!match.opponent_id || !["waiting", "ready"].includes(match.status) || match.started_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Room-code alerts are only available before the match starts." });
            }
            const replacementNeeded = Boolean(
                match.code_sent && match.code_correction_requested_at &&
                Number(match.code_correction_requested_by) !== senderId
            );
            if (match.code_sent && !replacementNeeded) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The room code has already been sent. Wait for your opponent or a replacement request." });
            }

            const activeDevice = await client.query(
                "SELECT 1 FROM android_push_tokens WHERE user_id=$1 AND active=TRUE LIMIT 1",
                [userId]
            );
            if (!activeDevice.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Open the GOAL$GAMBIT Companion on Android and enable notifications first." });
            }

            const reminderPrefix = "efootball-match:" + matchId + ":room-code-needed:manual:%";
            const recentReminder = await client.query(
                `SELECT created_at FROM push_notification_events
                  WHERE user_id=$1 AND match_id=$2 AND event_key LIKE $3
                    AND created_at > NOW()-INTERVAL '60 seconds'
                  ORDER BY created_at DESC LIMIT 1`,
                [userId, matchId, reminderPrefix]
            );
            if (recentReminder.rows.length) {
                const createdAt = new Date(recentReminder.rows[0].created_at).getTime();
                const retryAfterSeconds = Math.max(1, 60 - Math.floor((Date.now() - createdAt) / 1000));
                await client.query("COMMIT");
                return res.status(429).json({
                    success: false,
                    retryAfterSeconds,
                    message: "A room-code notification was just requested. Please wait before sending another."
                });
            }

            const queued = await queuePush(client, userId, {
                eventKey: "efootball-match:" + matchId + ":room-code-needed:manual:" +
                    Number(match.room_code_revision || 0) + ":" + randomUUID(),
                matchId,
                title: "GOAL$GAMBIT — Match Room Code",
                body: "Expand this notification and tap REPLY to type or paste the room code, then tap Send. You can stay in eFootball.",
                page: "match-room",
                androidOnly: true
            });
            if (!queued) {
                await client.query("ROLLBACK");
                return res.status(503).json({ success: false, message: "The companion notification could not be queued. Please try again." });
            }

            const androidJob = await client.query(
                `SELECT 1
                   FROM android_push_delivery_jobs j
                   JOIN android_push_tokens t ON t.id=j.token_id
                  WHERE j.event_id=$1 AND t.user_id=$2 AND t.active=TRUE
                  LIMIT 1`,
                [queued.id, userId]
            );
            if (!androidJob.rows.length) {
                await client.query("ROLLBACK");
                return res.status(503).json({ success: false, message: "The companion notification could not be queued. Please check that Android notifications are enabled." });
            }

            await client.query("COMMIT");
            wakePushQueue();
            const deliveryDeadline = Date.now() + 6000;
            let delivery = null;
            do {
                const result = await pool.query(
                    `SELECT COUNT(*) FILTER (WHERE j.status='accepted')::int AS accepted_count,
                            COUNT(*) FILTER (WHERE j.status IN ('queued','sending'))::int AS pending_count
                       FROM android_push_delivery_jobs j
                       JOIN android_push_tokens t ON t.id=j.token_id
                      WHERE j.event_id=$1 AND t.user_id=$2`,
                    [queued.id, userId]
                );
                delivery = result.rows[0] || { accepted_count: 0, pending_count: 0 };
                if (Number(delivery.accepted_count) > 0 || Number(delivery.pending_count) === 0 || Date.now() >= deliveryDeadline) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            } while (Date.now() < deliveryDeadline);

            if (Number(delivery.accepted_count) > 0) {
                return res.json({
                    success: true,
                    retryAfterSeconds: 60,
                    message: "Firebase accepted the room-code alert for delivery to your Android Companion."
                });
            }
            if (Number(delivery.pending_count) > 0) {
                return res.status(202).json({
                    success: true,
                    pending: true,
                    retryAfterSeconds: 60,
                    message: "The room-code alert is still queued for Android delivery. Keep the Companion online while Firebase retries."
                });
            }
            return res.status(503).json({
                success: false,
                message: "Firebase could not deliver the alert to an active Android device. Open the Companion, sign in to this GOAL$GAMBIT account, and try again."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Room-code companion notification failed.");
            return res.status(500).json({ success: false, message: "Unable to send a room-code notification to the Companion app." });
        } finally {
            client.release();
        }
    }

    router.post(
        "/matches/:id/room-code-notification",
        authenticateToken,
        sendRoomCodeAppNotification
    );

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

    router.post("/matches/:id/code-correction", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) return res.status(400).json({ success: false, message: "Invalid match ID." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!result.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Match not found." }); }
            const match = result.rows[0];
            if (Number(match.creator_id) !== userId && Number(match.opponent_id) !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (!match.opponent_id || !match.code_sent || !match.external_room_code || !["waiting", "ready"].includes(match.status) || match.started_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "A room code can only be replaced before the match starts." });
            }
            const participantIds = [Number(match.creator_id), Number(match.opponent_id)];
            const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
            if (senderId === null || !participantIds.includes(senderId)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match has no valid room-code sender." });
            }
            if (senderId === userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "Only the receiver can request a room-code replacement." });
            }
            if (match.code_correction_requested_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "A replacement has already been requested. Wait for the sender to submit it." });
            }
            await client.query(
                "UPDATE efootball_matches SET code_correction_requested_at=NOW(),code_correction_requested_by=$1,code_received_at=NULL,code_received_by=NULL,creator_ready=FALSE,opponent_ready=FALSE,status='waiting' WHERE id=$2",
                [userId, matchId]
            );
            await createSystemNotification(client, senderId, "room_code_correction_requested", "Replacement Room Code Requested", "Your opponent requested a replacement room code. Open the match room and send the corrected code.", matchId);
            await queuePush(client, senderId, {
                eventKey: "efootball-match:" + matchId + ":code-correction-requested:" + Number(match.room_code_revision || 0),
                matchId: matchId,
                title: "GOAL$GAMBIT — Match Room Code",
                body: "Your opponent is waiting. Paste the room code below and tap Send.",
                page: "match-room"
            });
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            emitMatchUpdate(senderId, matchId, "code-correction-requested");
            emitMatchUpdate(userId, matchId, "code-correction-requested");
            wakePushQueue();
            return res.json({ success: true, message: "Replacement requested. Your opponent has been notified.", match: updated });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Room-code correction request failed.");
            return res.status(500).json({ success: false, message: "Unable to request a room-code replacement." });
        } finally { client.release(); }
    });


    /* =====================================================
       RECEIVER CONFIRMS ROOM CODE
       ===================================================== */
    router.post("/matches/:id/code-received", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const matchId = Number(req.params.id);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) return res.status(400).json({ success: false, message: "Invalid match ID." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!result.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Match not found." }); }
            const match = result.rows[0];
            if (Number(match.creator_id) !== userId && Number(match.opponent_id) !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (!match.opponent_id || !match.code_sent || !match.external_room_code || match.code_correction_requested_at || !["waiting", "ready"].includes(match.status) || match.started_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match no longer has a room code waiting for receipt." });
            }
            const participantIds = [Number(match.creator_id), Number(match.opponent_id)];
            const senderId = match.code_sender_id == null ? null : Number(match.code_sender_id);
            if (!participantIds.includes(senderId)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This room code has no valid sender. Ask the sender to resend it from the Match Room." });
            }
            if (senderId === userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "Only the receiver can confirm this room code." });
            }
            if (match.code_received_at) {
                if (Number(match.code_received_by) === userId) {
                    const updated = await getMatchForUser(client, matchId, userId);
                    await client.query("COMMIT");
                    return res.json({ success: true, message: "Room-code receipt was already confirmed.", match: updated });
                }
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Room-code receipt was already confirmed." });
            }
            await client.query("UPDATE efootball_matches SET code_received_at=NOW(), code_received_by=$1 WHERE id=$2", [userId, matchId]);
            await createSystemNotification(client, senderId, "room_code_received", "Room Code Received", "Your opponent confirmed receipt of the room code.", matchId);
            await queuePush(client, senderId, { eventKey: "efootball-match:" + matchId + ":room-code-received:" + Number(match.room_code_revision || 0), matchId: matchId, title: "Room Code Received", body: "Your opponent confirmed receipt of the room code.", page: "match-room" });
            const updated = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            emitMatchUpdate(senderId, matchId, "room-code-received");
            emitMatchUpdate(userId, matchId, "room-code-received");
            wakePushQueue();
            return res.json({ success: true, message: "Room code received successfully.", match: updated });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            console.error("Room-code receipt confirmation failed.");
            return res.status(500).json({ success: false, message: "Unable to confirm room-code receipt." });
        } finally { client.release(); }
    });

    /* =====================================================
       RESULT SUBMISSION
       ===================================================== */

    router.post("/matches/:id/result", authenticateToken, async (req, res) => {
        const userId = Number(req.user.userId);
        const score = Number(req.body && (req.body.score !== undefined ? req.body.score : req.body.yourScore));
        const opponentScore = Number(req.body && (req.body.opponent_score !== undefined ? req.body.opponent_score : req.body.opponentScore));
        const requestedRound = Number(req.body && req.body.resultRound);
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
            const userIsCreator = Number(match.creator_id) === userId;
            const userIsOpponent = Number(match.opponent_id) === userId;
            if (!userIsCreator && !userIsOpponent) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (!match.opponent_id || match.status !== "playing" || match.settled_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Scores can only be submitted while this match is in progress." });
            }
            const roundNo = Number(match.result_round || 1);
            if (roundNo !== 1 && roundNo !== 2) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "This match result is already under admin review." });
            }
            if (Number.isInteger(requestedRound) && requestedRound > 0 && requestedRound !== roundNo) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "The score page is on an older submission round. Refresh the match before submitting again." });
            }

            const participants = [Number(match.creator_id), Number(match.opponent_id)];
            const selected = await ensureResultVerification(client, match);
            if (!selected || !participants.includes(Number(selected.selected_player_id))) {
                throw new Error("Could not select a valid screenshot uploader for this match.");
            }

            // Round 2 is available only after first-round reports disagree. Require the selected player's evidence before their second report.
            if (roundNo === 2 && userId === Number(selected.selected_player_id) && !selected.screenshot_path) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    success: false,
                    message: "Upload the match screenshot before submitting your second-round score. Admin will receive the screenshot if the second reports also differ."
                });
            }

            const prior = await client.query(
                "SELECT score_for,score_against FROM efootball_result_reports WHERE match_id=$1 AND user_id=$2 AND round_no=$3",
                [matchId, userId, roundNo]
            );
            if (prior.rows.length &&
                (Number(prior.rows[0].score_for) !== score || Number(prior.rows[0].score_against) !== opponentScore)) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "You already submitted this round. The score is locked while the other player reports." });
            }
            if (!prior.rows.length) {
                await client.query(
                    "INSERT INTO efootball_result_reports(match_id,user_id,round_no,score_for,score_against) VALUES($1,$2,$3,$4,$5)",
                    [matchId, userId, roundNo, score, opponentScore]
                );
            }

            if (userIsCreator) {
                await client.query(
                    "UPDATE efootball_matches SET creator_submitted=TRUE,creator_submitted_score=$1,creator_submitted_opponent_score=$2 WHERE id=$3",
                    [score, opponentScore, matchId]
                );
            } else {
                await client.query(
                    "UPDATE efootball_matches SET opponent_submitted=TRUE,opponent_submitted_score=$1,opponent_submitted_opponent_score=$2 WHERE id=$3",
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
                    message: "Your round " + roundNo + " score is saved. Waiting for the other player to submit.",
                    match: safeMatch
                });
            }

            const creatorScore = Number(current.creator_submitted_score);
            const creatorOpponentScore = Number(current.creator_submitted_opponent_score);
            const reportsAgree = creatorScore === Number(current.opponent_submitted_opponent_score) &&
                creatorOpponentScore === Number(current.opponent_submitted_score);

            if (reportsAgree) {
                const settlement = await settleEfootballMatch(client, current, {
                    creatorScore,
                    opponentScore: creatorOpponentScore
                }, userId);
                if (current.tournament_id && current.tournament_fixture_id) {
                    const fixture = await client.query(
                        "SELECT * FROM efootball_tournament_fixtures WHERE id=$1 FOR UPDATE",
                        [current.tournament_fixture_id]
                    );
                    if (fixture.rows[0]) {
                        const homeScore = Number(fixture.rows[0].home_id) === Number(current.creator_id)
                            ? creatorScore : creatorOpponentScore;
                        const awayScore = Number(fixture.rows[0].away_id) === Number(current.creator_id)
                            ? creatorScore : creatorOpponentScore;
                        await client.query(
                            `UPDATE efootball_tournament_fixtures
                                SET status='completed',home_score=$1,away_score=$2,winner_id=$3,resolved_at=NOW()
                              WHERE id=$4`,
                            [homeScore, awayScore, settlement.winnerId, fixture.rows[0].id]
                        );
                    }
                }
                if (current.league_fixture_id) {
                    const fixture = await client.query("SELECT * FROM efootball_league_fixtures WHERE id=$1 FOR UPDATE", [current.league_fixture_id]);
                    if (fixture.rows[0]) {
                        const homeScore = Number(fixture.rows[0].home_id) === Number(current.creator_id) ? creatorScore : creatorOpponentScore;
                        const awayScore = Number(fixture.rows[0].away_id) === Number(current.creator_id) ? creatorScore : creatorOpponentScore;
                        await client.query(
                            `UPDATE efootball_league_fixtures
                                SET status='completed',home_score=$1,away_score=$2,winner_id=$3,resolved_at=NOW()
                              WHERE id=$4`,
                            [homeScore, awayScore, settlement.winnerId, fixture.rows[0].id]
                        );
                    }
                }
                await client.query(
                    "UPDATE efootball_result_verifications SET status='verified',score_check='matched' WHERE match_id=$1",
                    [matchId]
                );
                const message = settlement.winnerId
                    ? (Number(settlement.payout) > 0
                        ? "Both players' round " + roundNo + " reports match. KSh " + Number(settlement.payout).toFixed(2) + " was credited to the winner."
                        : "Both players' round " + roundNo + " reports match. The result was settled.")
                    : "Both players' round " + roundNo + " reports match. It was a draw and both stakes were returned.";
                for (const participantId of participants) {
                    await createSystemNotification(client, participantId, "match_result_settled", "Match Result Settled", message, matchId);
                    await queuePush(client, participantId, {
                        eventKey: "efootball-match:" + matchId + ":result-settled:" + participantId,
                        matchId,
                        title: "Match Result Settled",
                        body: message,
                        page: "match-results"
                    });
                }
                const safeMatch = await getMatchForUser(client, matchId, userId);
                await client.query("COMMIT");
                emitMatchUpdate(Number(current.creator_id), matchId, "result-settled");
                emitMatchUpdate(Number(current.opponent_id), matchId, "result-settled");
                wakePushQueue();
                return res.json({
                    success: true, pending: false, settled: true, disputed: false,
                    verificationRequired: false, settlement, message, match: safeMatch
                });
            }

            if (roundNo === 1) {
                await client.query(
                    "UPDATE efootball_matches SET result_round=2,creator_submitted=FALSE,opponent_submitted=FALSE,creator_submitted_score=NULL,creator_submitted_opponent_score=NULL,opponent_submitted_score=NULL,opponent_submitted_opponent_score=NULL,result_status='resubmission',submitted_by=NULL WHERE id=$1",
                    [matchId]
                );
                await client.query(
                    "UPDATE efootball_result_verifications SET status='resubmit',score_check='round1_mismatch' WHERE match_id=$1 AND screenshot_path IS NULL",
                    [matchId]
                );
                const message = "The first score reports differ. Both players must enter their scores again for round 2.";
                for (const participantId of participants) {
                    await createSystemNotification(client, participantId, "match_result_resubmission", "Please Re-enter the Result", message, matchId);
                    await queuePush(client, participantId, {
                        eventKey: "efootball-match:" + matchId + ":resubmit:" + participantId,
                        matchId,
                        title: "Submit Scores Again",
                        body: message,
                        page: "match-results"
                    });
                }
                const safeMatch = await getMatchForUser(client, matchId, userId);
                await client.query("COMMIT");
                emitMatchUpdate(Number(current.creator_id), matchId, "result-resubmission");
                emitMatchUpdate(Number(current.opponent_id), matchId, "result-resubmission");
                wakePushQueue();
                return res.json({
                    success: true, pending: true, settled: false, disputed: false,
                    resubmit: true, resultRound: 2,
                    message: "The first reports did not match. Both players must submit their scores again.",
                    match: safeMatch
                });
            }

            const detailResult = await client.query(
                "SELECT r.round_no,u.username,r.score_for,r.score_against,r.submitted_at FROM efootball_result_reports r JOIN users u ON u.id=r.user_id WHERE r.match_id=$1 ORDER BY r.round_no,r.submitted_at,u.username",
                [matchId]
            );
            const reportLines = detailResult.rows.map(function (report) {
                return "Round " + Number(report.round_no) + " - " + report.username + ": " +
                    Number(report.score_for) + "-" + Number(report.score_against);
            });
            if (!selected.screenshot_path) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    success: false,
                    message: "Admin review cannot open without the selected player's match screenshot. Upload it and refresh the result page."
                });
            }
            const description = "The players submitted different score reports in both rounds. The result and locked stake are on hold for admin review.\n\n" +
                reportLines.join("\n") +
                "\n\nA match screenshot is attached to the verification record.";
            const complaintRef = "GG-" + randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase();
            const existingCase = await client.query(
                "SELECT id,complaint_ref FROM complaints WHERE match_id=$1 AND source='efootball_result_dispute' ORDER BY id DESC LIMIT 1 FOR UPDATE",
                [matchId]
            );
            let caseRow = existingCase.rows[0];
            if (!caseRow) {
                const created = await client.query(
                    "INSERT INTO complaints(complaint_ref,reporter_id,reported_user_id,match_id,category,subject,description,status,priority,source) VALUES($1,$2,$3,$4,'match-dispute',$5,$6,'open','high','efootball_result_dispute') RETURNING id,complaint_ref",
                    [complaintRef, userId, userIsCreator ? Number(current.opponent_id) : Number(current.creator_id), matchId, "eFootball score dispute - Match #" + matchId, description]
                );
                caseRow = created.rows[0];
                await client.query(
                    "INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,to_status,message,metadata) VALUES($1,$2,'system','created','open',$3,$4::jsonb)",
                    [caseRow.id, userId, "Both score submissions differed in rounds 1 and 2.", JSON.stringify({ matchId: matchId, resultRound: 2 })]
                );
            } else {
                await client.query(
                    "UPDATE complaints SET description=$1,updated_at=NOW() WHERE id=$2",
                    [description, caseRow.id]
                );
            }

            await client.query(
                "UPDATE efootball_matches SET status='disputed',result_status='disputed',submitted_by=$1 WHERE id=$2",
                [userId, matchId]
            );
            await client.query(
                "UPDATE efootball_result_verifications SET status='review_required',score_check='disputed' WHERE match_id=$1",
                [matchId]
            );
            const disputeMessage = "The second score reports also differ. Admin case " + caseRow.complaint_ref + " is open; the result and any locked stake remain on hold.";
            for (const participantId of participants) {
                await createSystemNotification(client, participantId, "match_disputed", "Result Sent to Admin", disputeMessage, matchId);
                await queuePush(client, participantId, {
                    eventKey: "efootball-match:" + matchId + ":result-disputed:" + participantId,
                    matchId,
                    title: "Result Sent to Admin",
                    body: disputeMessage,
                    page: "match-results"
                });
            }
            const safeMatch = await getMatchForUser(client, matchId, userId);
            await client.query("COMMIT");
            emitMatchUpdate(Number(current.creator_id), matchId, "result-disputed");
            emitMatchUpdate(Number(current.opponent_id), matchId, "result-disputed");
            wakePushQueue();
            return res.json({
                success: true, pending: true, settled: false, disputed: true,
                pendingAdminReview: true, complaintRef: caseRow.complaint_ref,
                message: "Both rounds differed. Case " + caseRow.complaint_ref + " was sent to the admin with both players' reports.",
                match: safeMatch
            });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            console.error("eFootball result submission error:", error);
            return res.status(500).json({ success: false, message: "The server could not save this result. Your score was not confirmed; refresh the match and retry." });
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

                const result = await pool.query(
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

        const uploadDirectory = path.join(__dirname, "..", "uploads", "match-verification");
        const storedName = randomUUID() + extension;
        const storedPath = path.join(uploadDirectory, storedName);
        let fileWritten = false;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const matchResult = await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [matchId]);
            if (!matchResult.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Match not found." });
            }
            const match = matchResult.rows[0];
            if (Number(match.creator_id) !== userId && Number(match.opponent_id) !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "You are not part of this match." });
            }
            if (!["playing", "awaiting_verification", "disputed"].includes(match.status) || match.settled_at) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "Screenshot upload is only available while this match is active or under review." });
            }
            const verification = await ensureResultVerification(client, match);
            if (!verification || Number(verification.selected_player_id) !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "Only the player selected for this match can submit its screenshot." });
            }
            if (verification.screenshot_path) {
                await client.query("ROLLBACK");
                return res.status(409).json({ success: false, message: "A screenshot has already been submitted for this match." });
            }
            await client.query("COMMIT");

            await fs.promises.mkdir(uploadDirectory, { recursive: true });
            await fs.promises.writeFile(storedPath, buffer, { flag: "wx" });
            fileWritten = true;

            let analysis = { text: "", candidates: [] };
            try {
                analysis = await analyzeScreenshotWithTimeout(buffer);
            } catch (ocrError) {
                console.error("Screenshot OCR unavailable:", ocrError.message);
            }

            await client.query("BEGIN");
            const locked = await client.query(
                "SELECT v.id AS verification_id,v.selected_player_id,v.screenshot_path,m.status AS match_status,m.settled_at,m.creator_id,m.opponent_id FROM efootball_result_verifications v JOIN efootball_matches m ON m.id=v.match_id WHERE v.match_id=$1 FOR UPDATE OF v,m",
                [matchId]
            );
            if (!locked.rows.length) {
                await client.query("ROLLBACK");
                await fs.promises.unlink(storedPath).catch(() => {});
                return res.status(409).json({ success: false, message: "This match is no longer accepting screenshot evidence." });
            }
            const current = locked.rows[0];
            if (Number(current.selected_player_id) !== userId ||
                (Number(current.creator_id) !== userId && Number(current.opponent_id) !== userId)) {
                await client.query("ROLLBACK");
                await fs.promises.unlink(storedPath).catch(() => {});
                return res.status(403).json({ success: false, message: "Only the selected match participant can submit this screenshot." });
            }
            if (current.screenshot_path) {
                await client.query("ROLLBACK");
                await fs.promises.unlink(storedPath).catch(() => {});
                return res.status(409).json({ success: false, message: "A screenshot has already been submitted for this match." });
            }
            if (!["playing", "awaiting_verification", "disputed"].includes(current.match_status) || current.settled_at) {
                await client.query("ROLLBACK");
                await fs.promises.unlink(storedPath).catch(() => {});
                return res.status(409).json({ success: false, message: "This match is no longer accepting screenshot evidence." });
            }

            const underReview = current.match_status === "disputed" || current.match_status === "awaiting_verification";
            await client.query(
                "UPDATE efootball_result_verifications SET screenshot_path=$1,submitted_at=NOW(),status=$2,screenshot_ocr_text=$3,detected_score_candidates=$4::jsonb,score_check=$5 WHERE id=$6",
                [storedName, underReview ? "review_required" : "awaiting_scores", analysis.text, JSON.stringify(analysis.candidates), underReview ? "disputed" : "awaiting_scores", current.verification_id]
            );
            const message = underReview
                ? "Screenshot evidence was added to the open admin review. The result remains on hold."
                : "Screenshot saved. It will be included if the two score rounds need admin review.";
            await createSystemNotification(client, Number(current.creator_id), "match_screenshot_received", "Match Screenshot Saved", message, matchId);
            await createSystemNotification(client, Number(current.opponent_id), "match_screenshot_received", "Match Screenshot Saved", message, matchId);
            await client.query("COMMIT");
            return res.json({
                success: true,
                screenshotSubmitted: true,
                pendingAdminReview: underReview,
                scoreCandidates: analysis.candidates,
                message
            });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            if (fileWritten) await fs.promises.unlink(storedPath).catch(() => {});
            console.error("Screenshot verification error:", error.message);
            return res.status(500).json({ success: false, message: "Unable to process the screenshot. Please try again." });
        } finally {
            client.release();
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

                const results = await Promise.all([
                    pool.query(
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
                    ),
                    pool.query(
                        "SELECT COUNT(*)::int AS unread_count FROM system_notifications WHERE user_id=$1 AND read_at IS NULL",
                        [req.user.userId]
                    )
                ]);

                return res.json({
                    success: true,
                    notifications: results[0].rows,
                    unreadCount: Number(results[1].rows[0] && results[1].rows[0].unread_count || 0)
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
       CLEAR CURRENT USER NOTIFICATIONS
       ===================================================== */

    router.delete(
        "/notifications",
        authenticateToken,
        async (req, res) => {

            try {

                const result = await pool.query(
                    "DELETE FROM system_notifications WHERE user_id = $1",
                    [req.user.userId]
                );

                return res.json({
                    success: true,
                    clearedCount: result.rowCount || 0
                });

            } catch (error) {

                console.error(
                    "DELETE /notifications error:",
                    error
                );

                return res.status(500).json({
                    success: false,
                    message: "Unable to clear notifications."
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

    async function processCompetitionTimers() {
        const dueRounds = await pool.query(
            `SELECT DISTINCT tournament_id FROM efootball_tournament_rounds
              WHERE completed_at IS NULL AND deadline_at <= NOW()
              ORDER BY tournament_id LIMIT 50`
        );
        for (const row of dueRounds.rows) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await ensureTournamentRound(client, Number(row.tournament_id), false);
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                console.error("Tournament round timer failed:", error.message);
            } finally {
                client.release();
            }
        }

        const dueLeagueRounds = await pool.query(
            `SELECT DISTINCT league_id FROM efootball_league_rounds
              WHERE completed_at IS NULL AND deadline_at <= NOW()
              ORDER BY league_id LIMIT 50`
        );
        for (const row of dueLeagueRounds.rows) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await ensureLeagueRound(client, Number(row.league_id), false);
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                console.error("League round timer failed:", error.message);
            } finally {
                client.release();
            }
        }

        const dueWalkovers = await pool.query(
            `SELECT id FROM efootball_matches
              WHERE (mode='tournament' OR mode LIKE 'league-%') AND opponent_id IS NOT NULL
                AND status IN ('waiting','ready','playing','awaiting_verification')
                AND settled_at IS NULL AND attendance_deadline_at <= NOW()
              ORDER BY attendance_deadline_at,id LIMIT 100`
        );
        for (const row of dueWalkovers.rows) {
            await settleTournamentWalkover(Number(row.id));
        }
    }
    const tournamentTimer = setInterval(() => {
        processCompetitionTimers().catch(error => console.error("Competition timer worker failed:", error.message));
    }, 5000);
    if (typeof tournamentTimer.unref === "function") tournamentTimer.unref();

    return router;
};





