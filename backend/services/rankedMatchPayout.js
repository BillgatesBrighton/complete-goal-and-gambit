"use strict";

const PAYOUTS = Object.freeze({
    20: Object.freeze({ winner: 39, platform: 1 }),
    50: Object.freeze({ winner: 90, platform: 10 }),
    100: Object.freeze({ winner: 180, platform: 20 })
});

function rankedMatchPayout(stake, outcome) {
    const amount = Number(stake);
    if (!Number.isSafeInteger(amount) || !Object.prototype.hasOwnProperty.call(PAYOUTS, amount)) {
        throw new Error("Ranked match stake is unsupported.");
    }
    if (outcome === "draw") return { winner: null, refundEach: amount, platform: 0 };
    if (outcome !== "win") throw new Error("Ranked match outcome is invalid.");
    return { ...PAYOUTS[amount], refundEach: 0 };
}

module.exports = { rankedMatchPayout, PAYOUTS };
