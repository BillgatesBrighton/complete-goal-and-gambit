"use strict";

const express = require("express");

module.exports = function createUserHistoryRoutes(pool, authenticateToken) {
    const router = express.Router();

    router.post("/clear", authenticateToken, async function (req, res) {
        const historyType = String(req.body && req.body.historyType || "");
        if (!["transactions", "matches"].includes(historyType)) {
            return res.status(400).json({ success: false, message: "Choose transaction or match history to clear." });
        }

        try {
            const result = await pool.query(
                `INSERT INTO user_history_clears (user_id, history_type, cleared_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (user_id, history_type)
                 DO UPDATE SET cleared_at = EXCLUDED.cleared_at
                 RETURNING cleared_at`,
                [Number(req.user.userId), historyType]
            );
            return res.json({
                success: true,
                historyType,
                clearedAt: result.rows[0].cleared_at,
                message: historyType === "transactions"
                    ? "Transaction history list cleared. Wallet and payment records remain securely stored."
                    : "Match history list cleared. Match and settlement records remain securely stored."
            });
        } catch (error) {
            console.error("User history clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear history right now." });
        }
    });

    return router;
};
