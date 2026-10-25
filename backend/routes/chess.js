"use strict";

const express = require("express");
const { Chess } = require("chess.js");
const rateLimit = require("../middleware/rateLimit");
const { creditPlatform } = require("../services/adminWalletAccounting");
const { rankedMatchPayout } = require("../services/rankedMatchPayout");
const { recordJournal } = require("../services/financialLedger");

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
const whiteId = Number(match.player_white_id);
const blackId = Number(match.player_black_id);

// Refuse malformed historical rows rather than treating one account as both
// players and silently granting it White's seat.
if (Number.isSafeInteger(whiteId) && whiteId > 0 && whiteId === blackId) {
    return null;
}

if (
    whiteId === id
) {
    return "w";
}

if (
    blackId === id
) {
    return "b";
}

return null;

}

function getOpponentId(match, userId) {

const id = Number(userId);
const whiteId = Number(match.player_white_id);
const blackId = Number(match.player_black_id);

if (Number.isSafeInteger(whiteId) && whiteId > 0 && whiteId === blackId) {
    return null;
}

if (
    whiteId === id
) {
    return Number.isSafeInteger(blackId) && blackId > 0 ? blackId : null;
}

if (
    blackId === id
) {
    return Number.isSafeInteger(whiteId) && whiteId > 0 ? whiteId : null;
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

// Rebuild the authoritative rules state from match history so repetition
// draws remain detectable. A FEN-only board cannot know earlier positions.
function createMatchPosition(match) {
    if (!match || typeof match.fen !== "string" || !match.fen) return null;
    try {
        if (match.pgn) {
            const chess = new Chess();
            chess.loadPgn(String(match.pgn));
            return chess.fen() === match.fen ? chess : null;
        }
        return new Chess(match.fen);
    } catch (_) {
        return null;
    }
}

function chessPlyFromFen(fen) {
    const fields = String(fen || "").trim().split(/\s+/);
    const fullMove = Number(fields[5]);
    if (fields.length !== 6 || !Number.isSafeInteger(fullMove) || fullMove < 1 || !["w", "b"].includes(fields[1])) return null;
    return (fullMove - 1) * 2 + (fields[1] === "b" ? 1 : 0);
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
    const error = new Error(
        "Insufficient available wallet balance. You need KSh " + Number(amount).toFixed(2) + " available to join this match."
    );
    error.status = 402;
    throw error;
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

await recordJournal(client, {
    reference: `CHESS-STAKE-LOCK-${reference}`,
    transactionType: "chess_stake_lock",
    amount,
    description: "Chess match stake moved to locked player funds",
    context: { userId: Number(userId), transactionReference: reference },
    postings: [
        { accountType: "user_wallet_available", accountId: Number(userId), debit: amount },
        { accountType: "chess_match_locked", accountId: Number(userId), credit: amount }
    ]
});

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

await recordJournal(client, {
    reference: `CHESS-STAKE-UNLOCK-${reference}`,
    transactionType: "chess_stake_refund",
    amount,
    description: description || "Chess match stake returned to player wallet",
    context: { userId: Number(userId), transactionReference: reference },
    postings: [
        { accountType: "chess_match_locked", accountId: Number(userId), debit: amount },
        { accountType: "user_wallet_available", accountId: Number(userId), credit: amount }
    ]
});

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

function publicMatchState(match, userId, knownPosition, knownMove) {

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

let position = null;
let canReuseKnownMove = false;
if (knownPosition && typeof knownPosition.fen === "function") {
    try {
        if (knownPosition.fen() === match.fen) {
            position = knownPosition;
            canReuseKnownMove = Boolean(knownMove && /^[a-h][1-8]$/.test(knownMove.from) && /^[a-h][1-8]$/.test(knownMove.to));
        }
    } catch (_) {}
}
if (!position) position = createChess(match.fen);
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

let lastMove = canReuseKnownMove ? { from: knownMove.from, to: knownMove.to } : null;
if (!lastMove && match.pgn) {
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
        match.player_white_id == null ? null : Number(match.player_white_id),

    playerBlackId:
        match.player_black_id == null ? null : Number(match.player_black_id),

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
winnerId,
adminAction = null
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
                payout_status = CASE WHEN stake_amount > 0 THEN 'pending_competition' ELSE 'not_applicable' END
            WHERE id = $3
            `,
            [
                result,
                winnerId || null,
                matchId
            ]
        );

        if (adminAction) {
            await client.query(
                `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,reason,details)
                 VALUES('chess',$1,$2,'scores_set',$3,$4::jsonb)`,
                [matchId, adminAction.adminId, adminAction.reason, JSON.stringify({ result: result, winnerId: winnerId || null })]
            );
        }

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

        if (adminAction) {
            await client.query(
                `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,reason,details)
                 VALUES('chess',$1,$2,'scores_set',$3,$4::jsonb)`,
                [matchId, adminAction.adminId, adminAction.reason, JSON.stringify({ result: result, winnerId: winnerId || null })]
            );
        }

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

        rankedMatchPayout(stake, "draw");

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

        const payout = rankedMatchPayout(stake, "win");

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

        const prizePool = payout.winner;

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

        if (payout.platform > 0) {
            await creditPlatform(client, {
                amount: payout.platform,
                reference: `CHESS-FEE-${matchId}`,
                transactionType: "ranked_match_deduction",
                description: `Ranked Chess match ${matchId} platform deduction`,
                context: { game: "chess", matchId: Number(matchId), stake, winnerId: winner },
                debitPostings: [
                    { accountType: "chess_match_locked", accountId: whiteId, debit: stake },
                    { accountType: "chess_match_locked", accountId: blackId, debit: stake },
                    { accountType: "user_wallet_available", accountId: winner, credit: prizePool }
                ]
            });
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

    if (adminAction) {
        await client.query(
            `INSERT INTO admin_match_management_events(game,match_id,admin_id,action,reason,details)
             VALUES('chess',$1,$2,'scores_set',$3,$4::jsonb)`,
            [matchId, adminAction.adminId, adminAction.reason, JSON.stringify({ result: result, winnerId: result === "draw" ? null : Number(winnerId) })]
        );
    }

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
module.exports = function (pool, authenticateToken, io, pushService) {

    const router = express.Router();
    const chessMoveRateLimit = rateLimit({
        windowMs: 10_000,
        max: 30,
        message: "Too many chess move attempts. Please wait a moment and try again.",
        keyGenerator: function (req) { return "chess-moves:" + Number(req.user.userId); }
    });

    // Companion alerts are a notification-only bridge: the website remains the
    // game client and the backend remains authoritative. Keep chess match IDs
    // in the event key because push_notification_events.match_id references
    // eFootball matches in the existing schema.
    function queueChessNotifications(matchId, recipientIds, suffix, title, body) {
        if (!pushService || typeof pushService.enqueueNotification !== "function") return;
        const id = Number(matchId);
        const recipients = Array.from(new Set((recipientIds || []).map(Number)))
            .filter(function (userId) { return Number.isSafeInteger(userId) && userId > 0; });
        if (!Number.isSafeInteger(id) || id <= 0 || !recipients.length) return;

        (async function () {
            const client = await pool.connect();
            let inTransaction = false;
            try {
                await client.query("BEGIN");
                inTransaction = true;
                for (let index = 0; index < recipients.length; index++) {
                    const savepoint = "chess_push_" + index;
                    await client.query("SAVEPOINT " + savepoint);
                    try {
                        await pushService.enqueueNotification(client, recipients[index], {
                            eventKey: "chess-match:" + id + ":" + suffix,
                            title: title,
                            body: body,
                            page: "chess",
                            androidOnly: true
                        });
                        await client.query("RELEASE SAVEPOINT " + savepoint);
                    } catch (error) {
                        await client.query("ROLLBACK TO SAVEPOINT " + savepoint).catch(function () {});
                        await client.query("RELEASE SAVEPOINT " + savepoint).catch(function () {});
                        console.error("Chess companion alert could not be queued.");
                    }
                }
                await client.query("COMMIT");
                inTransaction = false;
            } catch (error) {
                if (inTransaction) await client.query("ROLLBACK").catch(function () {});
                console.error("Chess companion alerts could not be queued.");
            } finally {
                client.release();
            }
        })().catch(function () {
            console.error("Chess companion alerts could not be queued.");
        });
    }

    function queueChessTurnNotification(matchId, match, color, ply) {
        const nextUserId = Number(color === "w" ? match.player_white_id : match.player_black_id);
        if (!Number.isSafeInteger(nextUserId) || nextUserId <= 0 || !Number.isInteger(ply) || ply <= 0) return;
        queueChessNotifications(matchId, [nextUserId], "turn:" + ply,
            "Chess · Your turn", "It is your turn in chess. Open your chessboard to continue.");
    }

    function queueChessFinishedNotifications(matchId, match, result) {
        const recipients = [Number(match.player_white_id), Number(match.player_black_id)];
        queueChessNotifications(matchId, recipients, "finished:" + String(result || "completed"),
            "Chess match finished", "Your chess match has ended. Open GOAL$GAMBIT to view the result.");
    }

    async function registerTournamentEntry(client, userId, control, stake) {
        const entry = await client.query(
            `INSERT INTO chess_tournament_entries(season_key,time_control,stake_amount,user_id)
             VALUES(TO_CHAR(date_trunc('month',NOW()),'YYYY-MM'),$1,$2,$3)
             ON CONFLICT(season_key,time_control,stake_amount,user_id) DO UPDATE
                SET cancelled_at=NULL
              WHERE chess_tournament_entries.forfeited_at IS NULL
             RETURNING id`,
            [control.label, stake, userId]
        );
        if (!entry.rows.length) {
            throw Object.assign(new Error("You have forfeited this chess tournament for the current month."), { status: 409 });
        }
    }

    async function settleExpiredClock(matchId) {
        const client = await pool.connect();
        let inTransaction = false;
        let result = null;
        let winnerId = null;
        let match = null;
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
            match = locked.rows[0];
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
        queueChessFinishedNotifications(matchId, match, settled.result);
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

            let shouldCheckClock = match.status === "settling";
            if (match.status === "active") {
                const times = calculateRemainingTime(match);
                const sideTime = match.active_color === "w"
                    ? times.whiteTimeMs
                    : times.blackTimeMs;
                shouldCheckClock = sideTime <= 0;
            }

            if (shouldCheckClock) {
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
            queueChessFinishedNotifications(matchId, match, settled.result);

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
                if (matchType === "tournament") await registerTournamentEntry(client,userId,control,stake);
                await client.query(
                    `UPDATE chess_matches
                        SET player_black_id=$1, status='active', started_at=NOW(), last_move_at=NOW(), active_color='w'
                      WHERE id=$2`, [userId, id]);
                await client.query("COMMIT");
                const m = await getMatch(pool, id);
                if (io) io.to("chess_match_"+id).emit("chess:match_ready",{success:true,matchId:Number(id)});
                return res.status(201).json({success:true, matched:true, match:publicMatchState(m,userId)});
            }

            if (stake > 0) await lockStake(client,userId,stake,`CHESS-LOCK-${Date.now()}-${userId}`);
            if (matchType === "tournament") await registerTournamentEntry(client,userId,control,stake);
            const r = await client.query(
                `INSERT INTO chess_matches(player_white_id,status,fen,white_time_ms,black_time_ms,time_control,match_type,stake_amount,active_color)
                 VALUES($1,'waiting',$2,$3,$3,$4,$5,$6,'w') RETURNING id`,
                [userId,new Chess().fen(),control.minutes*60000,control.label,matchType,stake]);
            await client.query("COMMIT");
            const match = await getMatch(pool,r.rows[0].id);
            res.status(201).json({success:true, matched:false, match:publicMatchState(match,userId)});
        } catch(e){
            try{await client.query("ROLLBACK")}catch(_){}
            res.status(e.status || 400).json({success:false,message:e.message});
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
                    AND COALESCE(finished_at, created_at) > COALESCE(
                        (SELECT cleared_at FROM user_history_clears
                         WHERE user_id = $1 AND history_type = 'matches'),
                        '-infinity'::timestamptz
                    )
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
    router.post("/:id/join", authenticateToken, async function(req, res) {
        const matchId = Number(req.params.id);
        const userId = Number(req.user.userId);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid chess match ID." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                ["goal-gambit-chess-user:" + userId]
            );
            const account = await client.query(
                "SELECT rating, game, account_status FROM users WHERE id=$1 FOR UPDATE",
                [userId]
            );
            if (!account.rows.length || account.rows[0].account_status !== "active") {
                throw Object.assign(new Error("Your account cannot join a chess match."), { status: 403 });
            }
            if (!["chess", "both"].includes(account.rows[0].game)) {
                throw Object.assign(new Error("Your account is not registered for Chess."), { status: 403 });
            }

            // Match the existing one-live-game rule used by /create. The
            // per-user advisory lock serializes this check against new games.
            const existingMatch = await client.query(
                `SELECT id FROM chess_matches
                  WHERE (player_white_id=$1 OR player_black_id=$1)
                    AND status IN ('waiting','active','settling')
                  ORDER BY id DESC LIMIT 1`,
                [userId]
            );
            if (existingMatch.rows.length) {
                throw Object.assign(new Error("You already have a live Chess match or search. Finish or cancel it before joining another."), { status: 409 });
            }

            const result = await client.query(
                `SELECT waiting.*, waiting_player.rating AS waiting_player_rating,
                        waiting_player.game AS waiting_player_game,
                        waiting_player.account_status AS waiting_player_account_status
                   FROM chess_matches waiting
                   LEFT JOIN users waiting_player ON waiting_player.id=waiting.player_white_id
                  WHERE waiting.id=$1
                  FOR UPDATE OF waiting`,
                [matchId]
            );
            if (!result.rows.length) throw Object.assign(new Error("Chess match not found."), { status: 404 });
            const match = result.rows[0];
            if (match.status !== "waiting" || match.player_black_id) {
                throw Object.assign(new Error("Chess match is no longer available."), { status: 409 });
            }
            if (Number(match.player_white_id) === userId) {
                throw Object.assign(new Error("You cannot join your own match."), { status: 400 });
            }
            if (!Number.isSafeInteger(Number(match.player_white_id)) || Number(match.player_white_id) <= 0 ||
                match.waiting_player_account_status !== "active" ||
                !["chess", "both"].includes(match.waiting_player_game)) {
                throw Object.assign(new Error("This waiting player is no longer eligible for Chess."), { status: 409 });
            }

            if (match.match_type === "ranked") {
                const playerBracket = getRatingBracket(Number(account.rows[0].rating) || DEFAULT_RATING);
                const waitingBracket = getRatingBracket(Number(match.waiting_player_rating) || DEFAULT_RATING);
                if (playerBracket.minimum !== waitingBracket.minimum) {
                    throw Object.assign(new Error("Ranked Chess opponents must be in the same rating bracket."), { status: 409 });
                }
            }

            const waitingPlayerMatch = await client.query(
                `SELECT id FROM chess_matches
                  WHERE id<>$1 AND (player_white_id=$2 OR player_black_id=$2)
                    AND status IN ('waiting','active','settling')
                  LIMIT 1`,
                [matchId, Number(match.player_white_id)]
            );
            if (waitingPlayerMatch.rows.length) {
                throw Object.assign(new Error("This waiting player already has another live Chess match."), { status: 409 });
            }

            const stake = Number(match.stake_amount || 0);
            if (!Number.isFinite(stake) || stake < 0) {
                throw Object.assign(new Error("This match has an invalid stake and cannot be joined."), { status: 409 });
            }
            if (stake > 0) {
                await lockStake(client, userId, stake, `CHESS-LOCK-${Date.now()}-${userId}`);
            }
            if (match.match_type === "tournament") {
                await registerTournamentEntry(client,userId,{label:match.time_control},stake);
            }
            await client.query(
                `UPDATE chess_matches
                    SET player_black_id=$1,status='active',started_at=NOW(),last_move_at=NOW()
                  WHERE id=$2`,
                [userId, matchId]
            );
            await client.query("COMMIT");
            const updated = await getMatch(pool, matchId);
            if (io) io.to("chess_match_" + matchId).emit("chess:match_ready", {
                success: true,
                matchId: Number(matchId)
            });
            return res.json({ success: true, match: publicMatchState(updated, userId) });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            return res.status(error.status || 400).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
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
    router.post("/:id/move", authenticateToken, chessMoveRateLimit, async function(req, res) {
        const matchId = Number(req.params.id);
        const userId = Number(req.user.userId);
        const from = String(req.body && req.body.from || "").toLowerCase();
        const to = String(req.body && req.body.to || "").toLowerCase();
        const requestedPromotion = String(req.body && req.body.promotion || "q").toLowerCase();
        const body = req.body || {};
        const hasExpectedFen = Object.prototype.hasOwnProperty.call(body, "expectedFen");
        const hasExpectedPly = Object.prototype.hasOwnProperty.call(body, "expectedPly");
        const expectedFen = hasExpectedFen ? String(body.expectedFen || "").trim() : "";
        const expectedPly = body.expectedPly;
        if (!Number.isInteger(matchId) || matchId <= 0 || !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
            return res.status(400).json({ success: false, message: "Invalid chess move." });
        }
        if (!/^[qrbn]$/.test(requestedPromotion)) {
            return res.status(400).json({ success: false, message: "Invalid promotion piece." });
        }
        if (hasExpectedFen !== hasExpectedPly || (hasExpectedFen &&
            (expectedFen.length > 160 || expectedFen.split(/\s+/).length !== 6 ||
             !Number.isSafeInteger(expectedPly) || expectedPly < 0))) {
            return res.status(400).json({ success: false, message: "Invalid expected chess position." });
        }

        const client = await pool.connect();
        let inTransaction = false;
        async function reject(status, message, authoritativeMatch) {
            if (inTransaction) {
                await client.query("ROLLBACK");
                inTransaction = false;
            }
            const payload = { success: false, message: message };
            // This is only supplied after player authorization, so a rejected
            // move can still restore the caller to the locked authoritative
            // position without a second, potentially stale GET request.
            if (authoritativeMatch) payload.match = publicMatchState(authoritativeMatch, userId);
            return res.status(status).json(payload);
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
            if (match.status !== "active") return reject(409, "This match is not active.", match);
            if (hasExpectedFen && (expectedFen !== match.fen || expectedPly !== chessPlyFromFen(match.fen))) {
                return reject(409, "The match position changed. Refresh before moving.", match);
            }
            if (match.active_color !== color) return reject(409, "It is not your turn.", match);

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
                queueChessFinishedNotifications(matchId, match, settled.result);
                if (io) io.to("chess_match_" + matchId).emit("chess:game_over", {
                    success: true, matchId: matchId, result: settled.result,
                    winnerId: settled.winnerId, reason: "timeout"
                });
                return res.json({ success: true, timeout: true, match: publicMatchState(updated, userId) });
            }

            const chess = createMatchPosition(match);
            if (!chess) return reject(409, "Chess match history is inconsistent. Refresh the match before moving.");
            let move;
            try {
                move = chess.move({ from: from, to: to, promotion: requestedPromotion });
            } catch (_) {
                return reject(400, "Illegal chess move.", match);
            }
            if (!move) return reject(400, "Illegal chess move.", match);

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

            if (result) {
                const settled = await settleMatch(pool, matchId, result, winnerId);
                queueChessFinishedNotifications(matchId, match, settled.result);
            } else {
                queueChessTurnNotification(matchId, match, chess.turn(), chess.history().length);
            }
            const updated = await getMatch(pool, matchId);
            const publicState = publicMatchState(updated, userId, chess, move);
            if (io) {
                if (result) {
                    io.to("chess_match_" + matchId).emit("chess:game_over", {
                        success: true, matchId: matchId, result: result,
                        winnerId: winnerId, reason: chess.isCheckmate() ? "checkmate" : "draw"
                    });
                } else {
                    io.to("chess_match_" + matchId).emit("chess:move", {
                        success: true, matchId: matchId, actorUserId: userId, move: move
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
    router.post("/:id/draw/respond", authenticateToken, async function(req,res){const matchId=Number(req.params.id),uid=Number(req.user.userId),accept=Boolean(req.body&&req.body.accept);const m=await getMatch(pool,matchId);if(!m)return res.status(404).json({success:false,message:"Chess match not found."});if(!getPlayerColor(m,uid))return res.status(403).json({success:false,message:"You are not a player in this match."});if(Number(m.draw_offer_user_id)===uid)return res.status(400).json({success:false,message:"You cannot accept your own draw offer."});if(!m.draw_offer_user_id)return res.status(400).json({success:false,message:"No draw offer is pending."});if(!accept){await pool.query(`UPDATE chess_matches SET draw_offer_user_id=NULL WHERE id=$1`,[matchId]);if(io)io.to("chess_match_"+matchId).emit("chess:draw_declined",{success:true,matchId});return res.json({success:true,message:"Draw declined."});}const settled=await settleMatch(pool,matchId,"draw",null);queueChessFinishedNotifications(matchId,m,settled.result);const updated=await getMatch(pool,matchId);if(io)io.to("chess_match_"+matchId).emit("chess:game_over",{success:true,matchId,result:settled.result,winnerId:null,reason:"agreed_draw"});res.json({success:true,match:publicMatchState(updated,uid)});});

    return router;

};

module.exports.settleMatch = settleMatch;
module.exports.createMatchPosition = createMatchPosition;
module.exports.publicMatchState = publicMatchState;

