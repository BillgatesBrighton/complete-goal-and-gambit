"use strict";

const express = require("express");
const { Chess } = require("chess.js");

// ======================================================
// GOAL$GAMBIT CHESS ROUTES
// ======================================================

const ALLOWED_STAKES = [20, 50, 100];

const MATCH_TYPES = [
"casual",
"ranked",
"tournament"
];

const ELO_K = 32;
const DEFAULT_RATING = 1200;
const RATING_BRACKET_SIZE = 200;

function getRatingBracket(rating) {
    const normalized = Math.max(100, Number(rating) || DEFAULT_RATING);
    const minimum = 100 + Math.floor((normalized - 100) / RATING_BRACKET_SIZE) * RATING_BRACKET_SIZE;
    return { minimum, maximum: minimum + RATING_BRACKET_SIZE - 1 };
}

// ======================================================
// RANKED CONTROLS
// ======================================================

const RANKED_CONTROLS = {

rapid: {
    "10:00": { minutes: 10, increment: 0 },
    "10+5": { minutes: 10, increment: 5 },
    "10+15": { minutes: 10, increment: 15 },
    "15+10": { minutes: 15, increment: 10 }
},

blitz: {
    "3:00": { minutes: 3, increment: 0 },
    "3+2": { minutes: 3, increment: 2 },
    "5:00": { minutes: 5, increment: 0 }
},

bullet: {
    "1:00": { minutes: 1, increment: 0 },
    "1+1": { minutes: 1, increment: 1 },
    "2:00": { minutes: 2, increment: 0 },
    "2+1": { minutes: 2, increment: 1 }
}

};

// ======================================================
// FIXED TOURNAMENT CONTROLS
// ======================================================

const TOURNAMENT_CONTROLS = {

rapid: {
    minutes: 10,
    increment: 5
},

blitz: {
    minutes: 3,
    increment: 2
},

bullet: {
    minutes: 1,
    increment: 1
}

};

// ======================================================
// ACTIVE FLAG TIMERS
// ======================================================

const activeTimers = new Map();

// ======================================================
// BASIC HELPERS
// ======================================================

function normalizeMatchType(value) {

const type = String(value || "casual")
    .trim()
    .toLowerCase();

if (!MATCH_TYPES.includes(type)) {
    return null;
}

return type;

}

function normalizeStake(value, matchType) {

if (matchType === "casual") {
    return 0;
}

const stake = Number(value);

if (!Number.isFinite(stake)) {
    return null;
}

if (!ALLOWED_STAKES.includes(stake)) {
    return null;
}

return stake;

}

function getSpeed(value) {

const mode = String(value || "")
    .trim()
    .toLowerCase();

if (mode.includes("bullet")) {
    return "bullet";
}

if (mode.includes("blitz")) {
    return "blitz";
}

if (mode.includes("rapid")) {
    return "rapid";
}

return null;

}

function formatTimeControl(minutes, increment) {

if (Number(increment) === 0) {
    return `${minutes}:00`;
}

return `${minutes}+${increment}`;

}

// ======================================================
// CONTROL VALIDATION
// ======================================================

function getControl(matchType, speed, requestedTime) {

const normalizedType = normalizeMatchType(matchType);

if (!normalizedType) {
    return null;
}

const normalizedSpeed = getSpeed(speed);

if (!normalizedSpeed) {
    return null;
}

// Tournament clocks are fixed.
if (normalizedType === "tournament") {

    const control =
        TOURNAMENT_CONTROLS[normalizedSpeed];

    if (!control) {
        return null;
    }

    return {
        minutes: control.minutes,
        increment: control.increment,
        label: formatTimeControl(
            control.minutes,
            control.increment
        )
    };
}

// Ranked clocks are selected by the player.
if (normalizedType === "ranked") {

    const controls =
        RANKED_CONTROLS[normalizedSpeed];

    if (!controls) {
        return null;
    }

    const key =
        String(requestedTime || "")
            .trim();

    const control = controls[key];

    if (!control) {
        return null;
    }

    return {
        minutes: control.minutes,
        increment: control.increment,
        label: formatTimeControl(
            control.minutes,
            control.increment
        )
    };
}

// Casual games.
const value =
    String(requestedTime || "10:00")
        .trim();

let minutes;
let increment;

if (value.includes("+")) {

    const parts = value.split("+");

    if (parts.length !== 2) {
        return null;
    }

    minutes = Number(parts[0]);
    increment = Number(parts[1]);

} else if (value.includes(":")) {

    const parts = value.split(":");

    if (parts.length !== 2) {
        return null;
    }

    minutes = Number(parts[0]);
    increment = Number(parts[1]);

} else {

    return null;
}

if (
    !Number.isInteger(minutes) ||
    minutes <= 0 ||
    !Number.isInteger(increment) ||
    increment < 0
) {
    return null;
}

return {
    minutes,
    increment,
    label: formatTimeControl(
        minutes,
        increment
    )
};

}

// ======================================================
// PLAYER HELPERS
// ======================================================

function getPlayerColor(match, userId) {

const id = Number(userId);

if (
    Number(match.player_white_id) === id
) {
    return "w";
}

if (
    Number(match.player_black_id) === id
) {
    return "b";
}

return null;

}

function getOpponentId(match, userId) {

const id = Number(userId);

if (
    Number(match.player_white_id) === id
) {
    return Number(match.player_black_id);
}

if (
    Number(match.player_black_id) === id
) {
    return Number(match.player_white_id);
}

return null;

}

function getWinnerId(match, result) {

if (result === "white_win") {
    return Number(match.player_white_id);
}

if (result === "black_win") {
    return Number(match.player_black_id);
}

return null;

}

// ======================================================
// CHESS ENGINE HELPERS
// ======================================================

function createChess(fen) {

try {

    if (fen) {
        return new Chess(fen);
    }

    return new Chess();

} catch (error) {

    return new Chess();
}

}

function safeFen(chess) {

try {
    return chess.fen();
} catch (error) {
    return new Chess().fen();
}

}

// ======================================================
// CLOCK
// ======================================================

function calculateRemainingTime(match, now = Date.now()) {

let whiteTime =
    Number(match.white_time_ms || 0);

let blackTime =
    Number(match.black_time_ms || 0);

if (
    match.status !== "active" ||
    !match.last_move_at ||
    !match.active_color
) {

    return {
        whiteTimeMs: Math.max(0, whiteTime),
        blackTimeMs: Math.max(0, blackTime)
    };
}

const lastMove =
    new Date(match.last_move_at).getTime();

if (!Number.isFinite(lastMove)) {

    return {
        whiteTimeMs: Math.max(0, whiteTime),
        blackTimeMs: Math.max(0, blackTime)
    };
}

const elapsed =
    Math.max(
        0,
        now - lastMove
    );

if (match.active_color === "w") {

    whiteTime -= elapsed;

} else {

    blackTime -= elapsed;
}

return {
    whiteTimeMs: Math.max(0, whiteTime),
    blackTimeMs: Math.max(0, blackTime)
};

}

function getIncrementMs(timeControl) {

const value =
    String(timeControl || "");

if (!value.includes("+")) {
    return 0;
}

const parts =
    value.split("+");

const increment =
    Number(parts[1]);

if (
    !Number.isFinite(increment) ||
    increment < 0
) {
    return 0;
}

return increment * 1000;

}

// ======================================================
// ELO
// ======================================================

function expectedScore(
playerRating,
opponentRating
) {

return (
    1 /
    (
        1 +
        Math.pow(
            10,
            (
                opponentRating -
                playerRating
            ) / 400
        )
    )
);

}

function calculateNewRating(
playerRating,
opponentRating,
score
) {

const expected =
    expectedScore(
        playerRating,
        opponentRating
    );

return Math.max(
    100,
    Math.round(
        playerRating +
        ELO_K *
        (score - expected)
    )
);

}

// ======================================================
// WALLET LOCK
// ======================================================

async function lockStake(
client,
userId,
amount,
reference
) {

if (amount <= 0) {
    return;
}

const result =
    await client.query(
        `
        UPDATE wallets
        SET
            balance = balance - $1,
            locked_balance = locked_balance + $1,
            updated_at = NOW()
        WHERE user_id = $2
          AND balance >= $1
        RETURNING user_id
        `,
        [
            amount,
            userId
        ]
    );

if (result.rows.length === 0) {

    throw new Error(
        "Insufficient available wallet balance."
    );
}

await client.query(
    `
    INSERT INTO transactions
    (
        user_id,
        transaction_type,
        amount,
        currency,
        status,
        reference,
        description
    )
    VALUES
    (
        $1,
        'stake_lock',
        $2,
        'KES',
        'completed',
        $3,
        'Chess match stake locked'
    )
    `,
    [
        userId,
        amount,
        reference
    ]
);

}

// ======================================================
// WALLET UNLOCK
// ======================================================

async function unlockStake(
client,
userId,
amount,
reference,
description
) {

if (amount <= 0) {
    return;
}

const result =
    await client.query(
        `
        UPDATE wallets
        SET
            balance = balance + $1,
            locked_balance = locked_balance - $1,
            updated_at = NOW()
        WHERE user_id = $2
          AND locked_balance >= $1
        RETURNING user_id
        `,
        [
            amount,
            userId
        ]
    );

if (result.rows.length === 0) {

    throw new Error(
        "Locked wallet balance is insufficient."
    );
}

await client.query(
    `
    INSERT INTO transactions
    (
        user_id,
        transaction_type,
        amount,
        currency,
        status,
        reference,
        description
    )
    VALUES
    (
        $1,
        'match_refund',
        $2,
        'KES',
        'completed',
        $3,
        $4
    )
    `,
    [
        userId,
        amount,
        reference,
        description
    ]
);

}

// ======================================================
// FETCH MATCH
// ======================================================

async function getMatch(pool, matchId) {

const result =
    await pool.query(
        `
        SELECT
            m.*,
            wu.username AS white_name,
            wu.rating   AS white_rating,
            bu.username AS black_name,
            bu.rating   AS black_rating
        FROM chess_matches m
        LEFT JOIN users wu ON wu.id = m.player_white_id
        LEFT JOIN users bu ON bu.id = m.player_black_id
        WHERE m.id = $1
        `,
        [matchId]
    );

if (result.rows.length === 0) {
    return null;
}

return result.rows[0];

}

// ======================================================
// PUBLIC MATCH STATE
// ======================================================

function publicMatchState(match, userId) {

const color =
    getPlayerColor(
        match,
        userId
    );

const opponentId =
    getOpponentId(
        match,
        userId
    );

const times =
    calculateRemainingTime(match);

const playerRating = color === "w" ? match.white_rating : match.black_rating;
const ratingBracket = match.match_type === "ranked" && playerRating != null
    ? getRatingBracket(playerRating)
    : null;

const position = createChess(match.fen);
let checkSquare = null;
if (position.isCheck()) {
    const board = position.board();
    const checkedColor = position.turn();
    for (let row = 0; row < 8 && !checkSquare; row++) {
        for (let column = 0; column < 8; column++) {
            const piece = board[row][column];
            if (piece && piece.type === "k" && piece.color === checkedColor) {
                checkSquare = String.fromCharCode(97 + column) + (8 - row);
                break;
            }
        }
    }
}

let lastMove = null;
if (match.pgn) {
    try {
        const history = new Chess();
        history.loadPgn(match.pgn);
        const moves = history.history({ verbose: true });
        const move = moves[moves.length - 1];
        if (move) lastMove = { from: move.from, to: move.to };
    } catch (_) {
        // A malformed old PGN should not prevent the board from loading.
    }
}

return {

    matchId:
        Number(match.id),

    status:
        match.status,

    result:
        match.result,

    winnerId:
        match.winner_id
            ? Number(match.winner_id)
            : null,

    playerColor:
        color,

    opponentId,

    playerWhiteId:
        Number(match.player_white_id),

    playerBlackId:
        Number(match.player_black_id),

    fen:
        match.fen,

    lastMove,

    checkSquare,

    pgn:
        match.pgn || "",

    whiteName:
        match.white_name || null,

    blackName:
        match.black_name || null,

    whiteRating:
        match.white_rating != null ? Number(match.white_rating) : null,

    blackRating:
        match.black_rating != null ? Number(match.black_rating) : null,

    whiteTimeMs:
        times.whiteTimeMs,

    blackTimeMs:
        times.blackTimeMs,

    activeColor:
        match.active_color,

    timeControl:
        match.time_control,

    matchType:
        match.match_type,

    ratingBracket:
        ratingBracket ? { minimum: ratingBracket.minimum, maximum: ratingBracket.maximum } : null,

    stake:
        Number(match.stake_amount || 0),

    drawOfferUserId:
        match.draw_offer_user_id
            ? Number(match.draw_offer_user_id)
            : null,

    startedAt:
        match.started_at,

    finishedAt:
        match.finished_at
};

}

// ======================================================
// SETTLEMENT
// ======================================================

async function settleMatch(
pool,
matchId,
result,
winnerId
) {

const client =
    await pool.connect();

try {

    await client.query("BEGIN");

    const matchResult =
        await client.query(
            `
            SELECT *
            FROM chess_matches
            WHERE id = $1
            FOR UPDATE
            `,
            [matchId]
        );

    if (
        matchResult.rows.length === 0
    ) {

        throw new Error(
            "Chess match not found."
        );
    }

    const match =
        matchResult.rows[0];

    if (
        match.status === "completed" ||
        match.status === "cancelled"
    ) {

        await client.query("COMMIT");

        return {
            alreadySettled: true,
            result: match.result,
            winnerId:
                match.winner_id
                    ? Number(match.winner_id)
                    : null
        };
    }

    const whiteId =
        Number(match.player_white_id);

    const blackId =
        Number(match.player_black_id);

    const stake =
        Number(match.stake_amount || 0);

    // --------------------------------------------------
    // TOURNAMENT
    // --------------------------------------------------

    if (
        match.match_type === "tournament"
    ) {

        await client.query(
            `
            UPDATE chess_matches
            SET
                status = 'completed',
                result = $1,
                winner_id = $2,
                finished_at = NOW(),
                settled_at = NOW(),
                payout_status = 'not_applicable'
            WHERE id = $3
            `,
            [
                result,
                winnerId || null,
                matchId
            ]
        );

        await client.query("COMMIT");

        return {
            alreadySettled: false,
            result,
            winnerId: winnerId || null
        };
    }

    // --------------------------------------------------
    // CASUAL
    // --------------------------------------------------

    if (
        match.match_type === "casual" ||
        stake <= 0
    ) {

        await client.query(
            `
            UPDATE chess_matches
            SET
                status = 'completed',
                result = $1,
                winner_id = $2,
                finished_at = NOW(),
                settled_at = NOW(),
                payout_status = 'not_applicable'
            WHERE id = $3
            `,
            [
                result,
                winnerId || null,
                matchId
            ]
        );

        await client.query("COMMIT");

        return {
            alreadySettled: false,
            result,
            winnerId: winnerId || null
        };
    }

    // --------------------------------------------------
    // LOCK BOTH WALLETS
    // --------------------------------------------------

    const firstId =
        Math.min(
            whiteId,
            blackId
        );

    const secondId =
        Math.max(
            whiteId,
            blackId
        );

    const wallets =
        await client.query(
            `
            SELECT
                user_id,
                balance,
                locked_balance
            FROM wallets
            WHERE user_id IN ($1, $2)
            ORDER BY user_id
            FOR UPDATE
            `,
            [
                firstId,
                secondId
            ]
        );

    if (
        wallets.rows.length !== 2
    ) {

        throw new Error(
            "Both player wallets must exist."
        );
    }

    for (
        const wallet of wallets.rows
    ) {

        if (
            Number(wallet.locked_balance) < stake
        ) {

            throw new Error(
                "Required match stake is not locked."
            );
        }
    }

    // --------------------------------------------------
    // DRAW
    // --------------------------------------------------

    if (result === "draw") {

        await unlockStake(
            client,
            whiteId,
            stake,
            `DRAW-${matchId}-W`,
            "Chess draw stake refund"
        );

        await unlockStake(
            client,
            blackId,
            stake,
            `DRAW-${matchId}-B`,
            "Chess draw stake refund"
        );

    }

    // --------------------------------------------------
    // WIN
    // --------------------------------------------------

    else {

        const winner =
            Number(winnerId);

        if (
            winner !== whiteId &&
            winner !== blackId
        ) {

            throw new Error(
                "Winner is not a player in this match."
            );
        }

        await client.query(
            `
            UPDATE wallets
            SET
                locked_balance =
                    locked_balance - $1,
                updated_at = NOW()
            WHERE user_id IN ($2, $3)
            `,
            [
                stake,
                whiteId,
                blackId
            ]
        );

        const prizePool =
            stake * 2;

        await client.query(
            `
            UPDATE wallets
            SET
                balance = balance + $1,
                updated_at = NOW()
            WHERE user_id = $2
            `,
            [
                prizePool,
                winner
            ]
        );

        await client.query(
            `
            INSERT INTO transactions
            (
                user_id,
                transaction_type,
                amount,
                currency,
                status,
                reference,
                description
            )
            VALUES
            (
                $1,
                'match_winnings',
                $2,
                'KES',
                'completed',
                $3,
                'Chess match winnings'
            )
            `,
            [
                winner,
                prizePool,
                `WIN-${matchId}-${winner}`
            ]
        );
    }

    // --------------------------------------------------
    // RATING
    // --------------------------------------------------

    if (
        match.match_type === "ranked" &&
        !match.rating_updated_at
    ) {

        const ratings =
            await client.query(
                `
                SELECT
                    id,
                    COALESCE(
                        rating,
                        $3
                    ) AS rating
                FROM users
                WHERE id IN ($1, $2)
                ORDER BY id
                FOR UPDATE
                `,
                [
                    whiteId,
                    blackId,
                    DEFAULT_RATING
                ]
            );

        if (
            ratings.rows.length === 2
        ) {

            const white =
                ratings.rows.find(
                    row =>
                        Number(row.id) === whiteId
                );

            const black =
                ratings.rows.find(
                    row =>
                        Number(row.id) === blackId
                );

            const whiteRating =
                Number(white.rating);

            const blackRating =
                Number(black.rating);

            let whiteScore;
            let blackScore;

            if (result === "draw") {

                whiteScore = 0.5;
                blackScore = 0.5;

            } else if (
                Number(winnerId) === whiteId
            ) {

                whiteScore = 1;
                blackScore = 0;

            } else {

                whiteScore = 0;
                blackScore = 1;

            }

            const newWhiteRating =
                calculateNewRating(
                    whiteRating,
                    blackRating,
                    whiteScore
                );

            const newBlackRating =
                calculateNewRating(
                    blackRating,
                    whiteRating,
                    blackScore
                );

            await client.query(
                `UPDATE users SET rating = $1 WHERE id = $2`,
                [newWhiteRating, whiteId]
            );

            await client.query(
                `UPDATE users SET rating = $1 WHERE id = $2`,
                [newBlackRating, blackId]
            );

        }

    }

    // --------------------------------------------------
    // MARK MATCH COMPLETE
    // --------------------------------------------------

    await client.query(
        `
        UPDATE chess_matches
        SET
            status = 'completed',
            result = $1,
            winner_id = $2,
            finished_at = NOW(),
            settled_at = NOW(),
            rating_updated_at = COALESCE(rating_updated_at, NOW())
        WHERE id = $3
        `,
        [
            result,
            result === "draw" ? null : Number(winnerId),
            matchId
        ]
    );

    await client.query("COMMIT");

    return {
        alreadySettled: false,
        result,
        winnerId:
            result === "draw"
                ? null
                : Number(winnerId)
    };

} catch (error) {

    try {
        await client.query("ROLLBACK");
    } catch (rollbackError) {}

    throw error;

} finally {

    client.release();

}

}

// ======================================================
// ROUTER
// ======================================================
//
// NOTE: the original upload of this file was cut off before the
// route handlers. Only the two routes below were rebuilt from the
// helpers that survived. Create-match, matchmaking, move, draw offer
// and flag-timer routes still need to be restored/written.
//
module.exports = function (pool, authenticateToken, io) {

    const router = express.Router();

    async function settleExpiredClock(matchId) {
        const client = await pool.connect();
        let inTransaction = false;
        let result = null;
        let winnerId = null;
        try {
            await client.query("BEGIN");
            inTransaction = true;
            const locked = await client.query(
                "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE",
                [matchId]
            );
            if (!locked.rows.length) {
                await client.query("COMMIT");
                inTransaction = false;
                return null;
            }
            const match = locked.rows[0];
            if (match.status === "settling" && match.result) {
                result = match.result;
                winnerId = match.winner_id ? Number(match.winner_id) : null;
            } else if (match.status === "active") {
                const times = calculateRemainingTime(match);
                const sideTime = match.active_color === "w" ? times.whiteTimeMs : times.blackTimeMs;
                if (sideTime <= 0) {
                    result = match.active_color === "w" ? "black_win" : "white_win";
                    winnerId = getWinnerId(match, result);
                    await client.query(
                        "UPDATE chess_matches SET status='settling', result=$1, winner_id=$2, white_time_ms=$3, black_time_ms=$4 WHERE id=$5",
                        [result, winnerId, times.whiteTimeMs, times.blackTimeMs, matchId]
                    );
                }
            }
            await client.query("COMMIT");
            inTransaction = false;
        } catch (error) {
            if (inTransaction) {
                try { await client.query("ROLLBACK"); } catch (_) {}
                inTransaction = false;
            }
            throw error;
        } finally {
            client.release();
        }

        if (!result) return null;
        const settled = await settleMatch(pool, matchId, result, winnerId);
        const updated = await getMatch(pool, matchId);
        if (io && updated && updated.status === "completed") {
            io.to("chess_match_" + matchId).emit("chess:game_over", {
                success: true, matchId: matchId, result: settled.result,
                winnerId: settled.winnerId, reason: result === "draw" ? "draw" : "timeout"
            });
        }
        return updated;
    }

    // The server owns the clocks even if both players close their browsers.
    // Settling is retried after a transient wallet/DB failure.
    let clockSweepBusy = false;
    const clockSweep = setInterval(async function() {
        if (clockSweepBusy) return;
        clockSweepBusy = true;
        try {
            const active = await pool.query(
                "SELECT id FROM chess_matches WHERE player_black_id IS NOT NULL AND (status='settling' OR (status='active' AND last_move_at IS NOT NULL AND ((active_color='w' AND last_move_at + white_time_ms * INTERVAL '1 millisecond' <= NOW()) OR (active_color='b' AND last_move_at + black_time_ms * INTERVAL '1 millisecond' <= NOW())))) ORDER BY id LIMIT 200"
            );
            for (const row of active.rows) {
                try { await settleExpiredClock(Number(row.id)); }
                catch (error) { console.error("Chess clock settlement error:", error.message); }
            }
        } catch (error) {
            console.error("Chess clock sweep error:", error.message);
        } finally {
            clockSweepBusy = false;
        }
    }, 1000);
    if (typeof clockSweep.unref === "function") clockSweep.unref();

    // GET /api/chess/:id  -> current state of a match you are playing in
    router.get("/:id", authenticateToken, async function (req, res) {

        try {

            const matchId = Number(req.params.id);

            if (!Number.isInteger(matchId) || matchId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid match ID."
                });
            }

            let match = await getMatch(pool, matchId);

            if (!match) {
                return res.status(404).json({
                    success: false,
                    message: "Chess match not found."
                });
            }

            if (!getPlayerColor(match, req.user.userId)) {
                return res.status(403).json({
                    success: false,
                    message: "You are not a player in this match."
                });
            }

            if (match.status === "active" || match.status === "settling") {
                const afterClock = await settleExpiredClock(matchId);
                if (afterClock) match = afterClock;
                else match = await getMatch(pool, matchId);
            }

            res.json({
                success: true,
                match: publicMatchState(match, req.user.userId)
            });

        } catch (error) {

            console.error("Get chess match error:", error.message);

            res.status(500).json({
                success: false,
                message: "Failed to load match."
            });

        }

    });

    // POST /api/chess/:id/resign  -> you lose, opponent wins, stakes settle
    router.post("/:id/resign", authenticateToken, async function (req, res) {

        try {

            const matchId = Number(req.params.id);

            if (!Number.isInteger(matchId) || matchId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid match ID."
                });
            }

            const match = await getMatch(pool, matchId);

            if (!match) {
                return res.status(404).json({
                    success: false,
                    message: "Chess match not found."
                });
            }

            const color = getPlayerColor(match, req.user.userId);

            if (!color) {
                return res.status(403).json({
                    success: false,
                    message: "You are not a player in this match."
                });
            }

            if (match.status !== "active") {
                return res.status(400).json({
                    success: false,
                    message: "This match is not active."
                });
            }

            const result = color === "w" ? "black_win" : "white_win";

            const settled = await settleMatch(
                pool,
                matchId,
                result,
                getWinnerId(match, result)
            );

            const updated = await getMatch(pool, matchId);

            if (io && updated) {
                io.to("chess_match_" + matchId).emit("chess:game_over", {
                    success: true,
                    matchId,
                    result: settled.result,
                    winnerId: settled.winnerId,
                    reason: "resignation"
                });
            }

            res.json({
                success: true,
                message: "You resigned.",
                match: updated
                    ? publicMatchState(updated, req.user.userId)
                    : null
            });

        } catch (error) {

            console.error("Resign error:", error.message);

            res.status(500).json({
                success: false,
                message: "Failed to resign."
            });

        }

    });


    // POST /api/chess/create -> matchmaking.
    // Ranked queue entries pair only with an active chess account in the
    // same 200-point rating bracket, with the same clock and stake.
    // Other modes still require an eligible chess account and same settings.
    // The stake is locked from the wallet first; no balance = no match.
    router.post("/create", authenticateToken, async function(req, res) {
        const userId = Number(req.user.userId);
        const matchType = normalizeMatchType(req.body && req.body.matchType || "ranked");
        const speed = req.body && req.body.speed || "rapid";
        const control = getControl(matchType, speed, req.body && req.body.timeControl);
        const stake = normalizeStake(req.body && req.body.stake, matchType);
        if (!matchType || !control || stake === null) return res.status(400).json({success:false,message:"Invalid chess match settings."});
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // A user may search from several tabs/settings at once. Serialize
            // by user first, then reconnect to any existing live match.
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                ["goal-gambit-chess-user:" + userId]
            );
            const account = await client.query(
                "SELECT rating, game, account_status FROM users WHERE id=$1 FOR UPDATE",
                [userId]
            );
            if (!account.rows.length || account.rows[0].account_status !== "active") {
                throw new Error("Your account cannot start a chess match.");
            }
            if (!["chess", "both"].includes(account.rows[0].game)) {
                throw new Error("Your account is not registered for Chess.");
            }
            const playerRating = Number(account.rows[0].rating) || DEFAULT_RATING;
            const bracket = getRatingBracket(playerRating);

            const mine = await client.query(
                `SELECT id, status FROM chess_matches
                  WHERE (player_white_id=$1 OR player_black_id=$1)
                    AND status IN ('waiting','active','settling')
                  ORDER BY id DESC LIMIT 1 FOR UPDATE`,
                [userId]
            );
            if (mine.rows.length) {
                await client.query("COMMIT");
                const existing = await getMatch(pool, mine.rows[0].id);
                return res.json({
                    success: true,
                    matched: existing.status === "active",
                    match: publicMatchState(existing, userId)
                });
            }

            // Serialize queue changes so simultaneous searches join an
            // existing waiting player instead of opening parallel searches.
            const queueKey = [
                "goal-gambit-chess", matchType, stake, control.label,
                matchType === "ranked" ? bracket.minimum : "open"
            ].join(":");
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                [queueKey]
            );

            const open = await client.query(
                `SELECT waiting.id
                   FROM chess_matches waiting
                   JOIN users waiting_player ON waiting_player.id=waiting.player_white_id
                  WHERE waiting.status='waiting' AND waiting.player_black_id IS NULL
                    AND waiting.player_white_id<>$1 AND waiting.match_type=$2
                    AND waiting.stake_amount=$3 AND waiting.time_control=$4
                    AND waiting_player.account_status='active'
                    AND waiting_player.game IN ('chess','both')
                    AND ($5::boolean=FALSE OR
                         (waiting_player.rating >= $6 AND waiting_player.rating <= $7))
                    AND NOT EXISTS (
                        SELECT 1 FROM chess_matches other
                         WHERE other.id<>waiting.id
                           AND other.status IN ('waiting','active','settling')
                           AND (other.player_white_id=waiting.player_white_id
                                OR other.player_black_id=waiting.player_white_id)
                    )
                  ORDER BY waiting.id ASC LIMIT 1 FOR UPDATE OF waiting`,
                [userId, matchType, stake, control.label, matchType === "ranked", bracket.minimum, bracket.maximum]);

            if (open.rows.length) {
                const id = open.rows[0].id;
                if (stake > 0) await lockStake(client,userId,stake,`CHESS-LOCK-${Date.now()}-${userId}`);
                await client.query(
                    `UPDATE chess_matches
                        SET player_black_id=$1, status='active', started_at=NOW(), last_move_at=NOW(), active_color='w'
                      WHERE id=$2`, [userId, id]);
                await client.query("COMMIT");
                const m = await getMatch(pool, id);
                if (io) io.to("chess_match_"+id).emit("chess:match_ready",{success:true,match:publicMatchState(m,userId)});
                return res.status(201).json({success:true, matched:true, match:publicMatchState(m,userId)});
            }

            if (stake > 0) await lockStake(client,userId,stake,`CHESS-LOCK-${Date.now()}-${userId}`);
            const r = await client.query(
                `INSERT INTO chess_matches(player_white_id,status,fen,white_time_ms,black_time_ms,time_control,match_type,stake_amount,active_color)
                 VALUES($1,'waiting',$2,$3,$3,$4,$5,$6,'w') RETURNING id`,
                [userId,new Chess().fen(),control.minutes*60000,control.label,matchType,stake]);
            await client.query("COMMIT");
            const match = await getMatch(pool,r.rows[0].id);
            res.status(201).json({success:true, matched:false, match:publicMatchState(match,userId)});
        } catch(e){
            try{await client.query("ROLLBACK")}catch(_){}
            res.status(400).json({success:false,message:e.message});
        } finally{client.release();}
    });

    // GET /api/chess/history/mine -> your finished games for the dashboard
    router.get("/history/mine", authenticateToken, async function (req, res) {
        try {
            const uid = Number(req.user.userId);
            const r = await pool.query(
                `SELECT id, match_type, time_control, stake_amount, result, winner_id,
                        player_white_id, player_black_id, finished_at
                   FROM chess_matches
                  WHERE (player_white_id = $1 OR player_black_id = $1) AND status = 'completed'
                  ORDER BY finished_at DESC NULLS LAST, id DESC
                  LIMIT 100`, [uid]);
            const games = r.rows.map(function (m) {
                let outcome = "Draw";
                if (m.result !== "draw") {
                    outcome = Number(m.winner_id) === uid ? "Win" : "Loss";
                }
                return {
                    id: Number(m.id),
                    game: "Chess",
                    mode: (m.match_type === "tournament" ? "Tournament " : "Ranked ") + (m.time_control || ""),
                    stake: Number(m.stake_amount || 0),
                    result: outcome,
                    date: m.finished_at
                };
            });
            res.json({ success: true, games });
        } catch (error) {
            console.error("Chess history error:", error.message);
            res.status(500).json({ success: false, message: "Failed to load history." });
        }
    });

    // POST /api/chess/:id/cancel -> stop searching and get the stake back
    router.post("/:id/cancel", authenticateToken, async function(req, res) {
        const matchId = Number(req.params.id), userId = Number(req.user.userId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const r = await client.query(`SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE`, [matchId]);
            if (!r.rows.length) throw new Error("Chess match not found.");
            const m = r.rows[0];
            if (Number(m.player_white_id) !== userId) throw new Error("Only the player who opened the search can cancel it.");
            if (m.status !== "waiting") throw new Error("This match has already started.");
            const stake = Number(m.stake_amount || 0);
            if (stake > 0) await unlockStake(client, userId, stake, `CHESS-CANCEL-${matchId}-${userId}`, "Chess search cancelled - stake refunded");
            await client.query(`UPDATE chess_matches SET status='cancelled', finished_at=NOW(), settled_at=NOW(), payout_status='refunded' WHERE id=$1`, [matchId]);
            await client.query("COMMIT");
            res.json({success:true, message:"Search cancelled."});
        } catch(e) {
            try{await client.query("ROLLBACK")}catch(_){}
            res.status(400).json({success:false,message:e.message});
        } finally {client.release();}
    });

    // POST /api/chess/:id/join -> join a waiting match and lock the second stake
    router.post("/:id/join", authenticateToken, async function(req,res){
        const matchId=Number(req.params.id), userId=Number(req.user.userId), client=await pool.connect();
        try{await client.query("BEGIN");const r=await client.query(`SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE`,[matchId]);if(!r.rows.length)throw new Error("Chess match not found.");const m=r.rows[0];if(m.status!=="waiting"||m.player_black_id)throw new Error("Chess match is no longer available.");if(Number(m.player_white_id)===userId)throw new Error("You cannot join your own match.");const stake=Number(m.stake_amount||0);if(stake>0)await lockStake(client,userId,stake,`CHESS-LOCK-${Date.now()}-${userId}`);const q=await client.query(`UPDATE chess_matches SET player_black_id=$1,status='active',started_at=NOW(),last_move_at=NOW() WHERE id=$2 RETURNING id`,[userId,matchId]);await client.query("COMMIT");const match=await getMatch(pool,matchId);if(io)io.to("chess_match_"+matchId).emit("chess:match_ready",{success:true,match:publicMatchState(match,userId)});res.json({success:true,match:publicMatchState(match,userId)});}catch(e){try{await client.query("ROLLBACK")}catch(_){}res.status(400).json({success:false,message:e.message});}finally{client.release();}
    });

    // Return legal destinations from the same server-side chess position used
    // to validate moves. These hints are convenience only; POST /move remains
    // authoritative and validates every attempted move again.
    router.get("/:id/legal-moves", authenticateToken, async function(req, res) {
        const matchId = Number(req.params.id);
        const userId = Number(req.user.userId);
        const square = String(req.query.square || "").toLowerCase();
        if (!Number.isInteger(matchId) || matchId <= 0 || !/^[a-h][1-8]$/.test(square)) {
            return res.status(400).json({ success: false, message: "Invalid match or square." });
        }
        try {
            const match = await getMatch(pool, matchId);
            if (!match) return res.status(404).json({ success: false, message: "Chess match not found." });
            const color = getPlayerColor(match, userId);
            if (!color) return res.status(403).json({ success: false, message: "You are not a player in this match." });
            if (match.status !== "active" || match.active_color !== color) {
                return res.json({ success: true, moves: [], inCheck: false });
            }
            const chess = new Chess(match.fen);
            const piece = chess.get(square);
            if (!piece || piece.color !== color) {
                return res.json({ success: true, moves: [], inCheck: chess.isCheck() });
            }
            const moves = chess.moves({ square, verbose: true }).map(function(move) {
                return { to: move.to, capture: Boolean(move.captured), flags: move.flags, san: move.san };
            });
            return res.json({ success: true, moves, inCheck: chess.isCheck() });
        } catch (error) {
            console.error("Chess legal moves error:", error.message);
            return res.status(500).json({ success: false, message: "Could not load legal moves." });
        }
    });

    // POST /api/chess/:id/move -> locked, server-authoritative chess move.
    router.post("/:id/move", authenticateToken, async function(req, res) {
        const matchId = Number(req.params.id);
        const userId = Number(req.user.userId);
        const from = String(req.body && req.body.from || "").toLowerCase();
        const to = String(req.body && req.body.to || "").toLowerCase();
        const requestedPromotion = String(req.body && req.body.promotion || "q").toLowerCase();
        if (!Number.isInteger(matchId) || matchId <= 0 || !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
            return res.status(400).json({ success: false, message: "Invalid chess move." });
        }
        if (!/^[qrbn]$/.test(requestedPromotion)) {
            return res.status(400).json({ success: false, message: "Invalid promotion piece." });
        }

        const client = await pool.connect();
        let inTransaction = false;
        async function reject(status, message) {
            if (inTransaction) {
                await client.query("ROLLBACK");
                inTransaction = false;
            }
            return res.status(status).json({ success: false, message: message });
        }

        try {
            await client.query("BEGIN");
            inTransaction = true;
            const locked = await client.query(
                "SELECT * FROM chess_matches WHERE id=$1 FOR UPDATE",
                [matchId]
            );
            if (!locked.rows.length) return reject(404, "Chess match not found.");

            const match = locked.rows[0];
            const color = getPlayerColor(match, userId);
            if (!color) return reject(403, "You are not a player in this match.");
            if (match.status !== "active") return reject(409, "This match is not active.");
            if (match.active_color !== color) return reject(409, "It is not your turn.");

            const times = calculateRemainingTime(match);
            const remaining = color === "w" ? times.whiteTimeMs : times.blackTimeMs;
            if (remaining <= 0) {
                const result = color === "w" ? "black_win" : "white_win";
                const winnerId = getWinnerId(match, result);
                await client.query(
                    "UPDATE chess_matches SET status='settling', result=$1, winner_id=$2, white_time_ms=$3, black_time_ms=$4 WHERE id=$5",
                    [result, winnerId, times.whiteTimeMs, times.blackTimeMs, matchId]
                );
                await client.query("COMMIT");
                inTransaction = false;
                const settled = await settleMatch(pool, matchId, result, winnerId);
                const updated = await getMatch(pool, matchId);
                if (io) io.to("chess_match_" + matchId).emit("chess:game_over", {
                    success: true, matchId: matchId, result: settled.result,
                    winnerId: settled.winnerId, reason: "timeout"
                });
                return res.json({ success: true, timeout: true, match: publicMatchState(updated, userId) });
            }

            const chess = new Chess(match.fen);
            let move;
            try {
                move = chess.move({ from: from, to: to, promotion: requestedPromotion });
            } catch (_) {
                return reject(400, "Illegal chess move.");
            }
            if (!move) return reject(400, "Illegal chess move.");

            const increment = getIncrementMs(match.time_control);
            let whiteMs = times.whiteTimeMs;
            let blackMs = times.blackTimeMs;
            if (color === "w") whiteMs += increment;
            else blackMs += increment;

            let result = null;
            let winnerId = null;
            if (chess.isCheckmate()) {
                result = color === "w" ? "white_win" : "black_win";
                winnerId = userId;
            } else if (chess.isDraw() || chess.isStalemate() ||
                       chess.isThreefoldRepetition() || chess.isInsufficientMaterial()) {
                result = "draw";
            }

            await client.query(
                "UPDATE chess_matches SET fen=$1, pgn=$2, white_time_ms=$3, black_time_ms=$4, active_color=$5, last_move_at=NOW(), started_at=COALESCE(started_at,NOW()), status=CASE WHEN $6::varchar IS NULL THEN 'active' ELSE 'settling' END, result=$6, winner_id=$7 WHERE id=$8",
                [chess.fen(), chess.pgn(), whiteMs, blackMs, chess.turn(), result, winnerId, matchId]
            );
            await client.query("COMMIT");
            inTransaction = false;

            if (result) await settleMatch(pool, matchId, result, winnerId);
            const updated = await getMatch(pool, matchId);
            const publicState = publicMatchState(updated, userId);
            if (io) {
                if (result) {
                    io.to("chess_match_" + matchId).emit("chess:game_over", {
                        success: true, matchId: matchId, result: result,
                        winnerId: winnerId, reason: chess.isCheckmate() ? "checkmate" : "draw"
                    });
                } else {
                    io.to("chess_match_" + matchId).emit("chess:move", {
                        success: true, matchId: matchId, move: move
                    });
                }
            }
            return res.json({ success: true, move: move, match: publicState });
        } catch (error) {
            if (inTransaction) {
                try { await client.query("ROLLBACK"); } catch (_) {}
                inTransaction = false;
            }
            console.error("Chess move error:", error.message);
            return res.status(500).json({ success: false, message: "Failed to process move." });
        } finally {
            client.release();
        }
    });
    router.post("/:id/draw", authenticateToken, async function(req,res){const matchId=Number(req.params.id),uid=Number(req.user.userId);const m=await getMatch(pool,matchId);if(!m)return res.status(404).json({success:false,message:"Chess match not found."});if(!getPlayerColor(m,uid))return res.status(403).json({success:false,message:"You are not a player in this match."});if(m.status!=="active")return res.status(400).json({success:false,message:"Match is not active."});await pool.query(`UPDATE chess_matches SET draw_offer_user_id=$1 WHERE id=$2`,[uid,matchId]);if(io)io.to("chess_match_"+matchId).emit("chess:draw_offer",{success:true,matchId,userId:uid});res.json({success:true,message:"Draw offer sent."});});
    router.post("/:id/draw/respond", authenticateToken, async function(req,res){const matchId=Number(req.params.id),uid=Number(req.user.userId),accept=Boolean(req.body&&req.body.accept);const m=await getMatch(pool,matchId);if(!m)return res.status(404).json({success:false,message:"Chess match not found."});if(!getPlayerColor(m,uid))return res.status(403).json({success:false,message:"You are not a player in this match."});if(Number(m.draw_offer_user_id)===uid)return res.status(400).json({success:false,message:"You cannot accept your own draw offer."});if(!m.draw_offer_user_id)return res.status(400).json({success:false,message:"No draw offer is pending."});if(!accept){await pool.query(`UPDATE chess_matches SET draw_offer_user_id=NULL WHERE id=$1`,[matchId]);if(io)io.to("chess_match_"+matchId).emit("chess:draw_declined",{success:true,matchId});return res.json({success:true,message:"Draw declined."});}const settled=await settleMatch(pool,matchId,"draw",null);const updated=await getMatch(pool,matchId);if(io)io.to("chess_match_"+matchId).emit("chess:game_over",{success:true,matchId,result:settled.result,winnerId:null,reason:"agreed_draw"});res.json({success:true,match:publicMatchState(updated,uid)});});

    return router;

};


