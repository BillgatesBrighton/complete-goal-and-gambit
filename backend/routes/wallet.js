"use strict";

const express = require("express");
const { randomUUID } = require("crypto");


// ======================================================
// CONFIGURATION
// ======================================================

const MAX_AMOUNT = 1000000;

function withdrawalFeeRate(amount) {
    if (amount <= 100) return 0.05;
    if (amount <= 200) return 0.10;
    return 0.20;
}

const routerFactory = function(
    pool,
    authenticateToken,
    mpesaB2c,
    mpesaC2b
) {

    const router = express.Router();

    router.get(
        "/c2b-instructions",
        authenticateToken,
        async function(req, res) {
            if (!mpesaC2b || typeof mpesaC2b.getInstructions !== "function") {
                return res.status(503).json({ success: false, message: "C2B deposits are not configured." });
            }
            try {
                const c2b = await mpesaC2b.getInstructions(Number(req.user.userId));
                if (!c2b) return res.status(404).json({ success: false, message: "Active account not found." });
                c2b.canRegisterCallbacks = req.user.role === "admin";
                return res.json({ success: true, c2b });
            } catch (_) {
                return res.status(503).json({ success: false, message: "C2B deposit instructions are temporarily unavailable." });
            }
        }
    );


    // ==================================================
    // MONEY HELPER
    // ==================================================



    function normalizeMpesaPhone(value) {
        if (value === null || value === undefined) return null;
        const phone = String(value).replace(/\s+/g, "").trim();
        // Kenya mobile formats accepted by the wallet: 07XXXXXXXX, 011XXXXXXX,
        // 07420XXXXX and their 254-prefixed equivalents.
        if (/^07\d{8}$/.test(phone)) return "254" + phone.slice(1);
        if (/^011\d{7}$/.test(phone)) return "254" + phone.slice(1);
        if (/^07420\d{5}$/.test(phone)) return "254" + phone.slice(1);
        if (/^2547\d{8}$/.test(phone)) return phone;
        if (/^25411\d{7}$/.test(phone)) return phone;
        if (/^2547420\d{5}$/.test(phone)) return phone;
        return null;
    }

    function parseMoney(value) {

        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }


        const stringValue =
            String(value).trim();


        if (
            !/^\d+(\.\d{1,2})?$/.test(
                stringValue
            )
        ) {
            return null;
        }


        const amount =
            Number(stringValue);


        if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            amount > MAX_AMOUNT
        ) {
            return null;
        }


        return Number(
            amount.toFixed(2)
        );
    }


    // ==================================================
    // GET WALLET
    // ==================================================

    router.get(
        "/",
        authenticateToken,
        async function(req, res) {

            try {

                const userId =
                    Number(req.user.userId);


                const result =
                    await pool.query(
                        `
                        SELECT
                            id,
                            user_id,
                            balance,
                            locked_balance,
                            currency,
                            created_at,
                            updated_at
                        FROM wallets
                        WHERE user_id = $1
                        `,
                        [userId]
                    );


                if (
                    result.rows.length === 0
                ) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Wallet not found."
                    });
                }


                const wallet =
                    result.rows[0];


                const balance =
                    Number(
                        wallet.balance || 0
                    );


                const lockedBalance =
                    Number(
                        wallet.locked_balance || 0
                    );


                res.json({

                    success: true,

                    wallet: {

                        id:
                            Number(wallet.id),

                        userId:
                            Number(wallet.user_id),

                        balance,

                        lockedBalance,

                        availableBalance:
                            balance,

                        currency:
                            wallet.currency,

                        createdAt:
                            wallet.created_at,

                        updatedAt:
                            wallet.updated_at
                    }

                });

            } catch (error) {

                console.error(
                    "Wallet retrieval error:",
                    error.message
                );


                res.status(500).json({
                    success: false,
                    message:
                        "Failed to retrieve wallet."
                });
            }

        }
    );


    // ==================================================
    // TEST / DEVELOPMENT DEPOSIT
    // ==================================================
    // Free test deposits stay disabled unless explicitly enabled for local
    // development. Real deposits are credited only by a verified provider callback.
    router.post(
        "/deposit",
        authenticateToken,
        async function(req, res) {
            if (process.env.ALLOW_TEST_DEPOSITS !== "true") {
                return res.status(403).json({
                    success: false,
                    message: "Deposits are not available yet. M-Pesa deposits are coming soon."
                });
            }

            const amount = parseMoney(req.body && req.body.amount);
            const mpesaPhone = normalizeMpesaPhone(req.body && req.body.phone);
            if (amount === null) {
                return res.status(400).json({ success: false, message: "Invalid deposit amount." });
            }
            if (mpesaPhone === null) {
                return res.status(400).json({ success: false, message: "Valid Kenyan M-Pesa number is required." });
            }

            const userId = Number(req.user.userId);
            let client;
            try {
                client = await pool.connect();
                await client.query("BEGIN");
                const walletResult = await client.query(
                    "SELECT id, balance, locked_balance, currency FROM wallets WHERE user_id=$1 FOR UPDATE",
                    [userId]
                );
                if (!walletResult.rows.length) throw new Error("Wallet not found.");

                const wallet = walletResult.rows[0];
                const newBalance = Number(wallet.balance || 0) + amount;
                await client.query(
                    "UPDATE wallets SET balance=$1, updated_at=NOW() WHERE user_id=$2",
                    [newBalance, userId]
                );
                const reference = "DEP-" + Date.now() + "-" + userId;
                await client.query(
                    "INSERT INTO transactions (user_id, transaction_type, amount, currency, status, reference, description) VALUES ($1, 'deposit', $2, 'KES', 'completed', $3, 'Development wallet deposit')",
                    [userId, amount, reference]
                );
                await client.query("COMMIT");
                return res.status(201).json({
                    success: true,
                    message: "Deposit completed.",
                    wallet: {
                        balance: Number(newBalance.toFixed(2)),
                        lockedBalance: Number(wallet.locked_balance || 0),
                        availableBalance: Number(newBalance.toFixed(2)),
                        currency: wallet.currency
                    }
                });
            } catch (_) {
                if (client) await client.query("ROLLBACK").catch(() => {});
                return res.status(500).json({
                    success: false,
                    message: "Deposit failed."
                });
            } finally {
                if (client) client.release();
            }
        }
    );

    router.post(
        "/withdraw",
        authenticateToken,
        async function(req, res) {
            const amount = parseMoney(req.body && req.body.amount);
            const mpesaPhone = normalizeMpesaPhone(req.body && req.body.phone);

            if (amount === null) {
                return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
            }
            if (!Number.isSafeInteger(amount)) {
                return res.status(400).json({ success: false, message: "Enter a whole KSh amount for M-Pesa withdrawal." });
            }
            if (mpesaPhone === null) {
                return res.status(400).json({ success: false, message: "Valid Kenyan M-Pesa number is required." });
            }
            if (!mpesaB2c || !mpesaB2c.isConfigured()) {
                const issue = mpesaB2c && typeof mpesaB2c.configurationIssue === "function"
                    ? mpesaB2c.configurationIssue()
                    : null;
                return res.status(503).json({
                    success: false,
                    message: issue || "M-Pesa withdrawals are temporarily unavailable."
                });
            }

            const userId = Number(req.user.userId);
            const callback = mpesaB2c.createCallbackToken();
            const reference = "WD-" + userId + "-" + randomUUID();
            const feeRate = withdrawalFeeRate(amount);
            const fee = Math.round(amount * feeRate);
            const payout = amount - fee;
            if (payout < 1) {
                return res.status(400).json({ success: false, message: "Withdrawal amount is too small after the processing fee." });
            }

            let client;
            let walletCurrency = "KES";
            try {
                client = await pool.connect();
                await client.query("BEGIN");
                const walletResult = await client.query(
                    "SELECT id, balance, locked_balance, currency FROM wallets WHERE user_id=$1 FOR UPDATE",
                    [userId]
                );
                if (!walletResult.rows.length) throw new Error("Wallet not found.");

                const wallet = walletResult.rows[0];
                const balance = Number(wallet.balance || 0);
                if (balance < amount) throw new Error("Insufficient available balance.");

                const pending = await client.query(
                    "SELECT 1 FROM mpesa_payouts WHERE user_id=$1 AND status='pending' LIMIT 1",
                    [userId]
                );
                if (pending.rows.length) {
                    throw new Error("A withdrawal is already awaiting M-Pesa confirmation.");
                }

                await client.query(
                    "UPDATE wallets SET balance=balance - $1, updated_at=NOW() WHERE user_id=$2",
                    [amount, userId]
                );
                await client.query(
                    "INSERT INTO transactions (user_id, transaction_type, amount, currency, status, reference, description) VALUES ($1, 'withdrawal', $2, 'KES', 'pending', $3, 'Wallet withdrawal request')",
                    [userId, payout, reference]
                );
                await client.query(
                    "INSERT INTO transactions (user_id, transaction_type, amount, currency, status, reference, description) VALUES ($1, 'withdrawal_fee', $2, 'KES', 'pending', $3, 'Withdrawal processing fee')",
                    [userId, fee, reference + "-FEE"]
                );
                await client.query(
                    "INSERT INTO mpesa_payouts (reference, user_id, recipient_phone, callback_token_hash, originator_conversation_id) VALUES ($1, $2, $3, $4, $5)",
                    [reference, userId, mpesaPhone, callback.tokenHash, callback.originatorConversationId]
                );
                walletCurrency = wallet.currency || "KES";
                await client.query("COMMIT");
                client.release();
                client = null;
            } catch (error) {
                if (client) {
                    await client.query("ROLLBACK").catch(() => {});
                    client.release();
                    client = null;
                }
                const duplicatePending = error && error.code === "23505" &&
                    String(error.constraint || "").includes("idx_mpesa_payout_one_pending");
                const knownClientError = [
                    "Wallet not found.",
                    "Insufficient available balance.",
                    "A withdrawal is already awaiting M-Pesa confirmation."
                ].includes(error && error.message);
                return res.status(duplicatePending ? 409 : knownClientError ? 400 : 500).json({
                    success: false,
                    message: duplicatePending
                        ? "A withdrawal is already awaiting M-Pesa confirmation."
                        : knownClientError
                            ? error.message
                            : "Could not create the withdrawal request."
                });
            } finally {
                if (client) client.release();
            }

            let outcome;
            try {
                outcome = await mpesaB2c.submitPayout({
                    amount: payout,
                    phone: mpesaPhone,
                    reference,
                    callbackToken: callback.token,
                    originatorConversationId: callback.originatorConversationId
                });
            } catch (_) {
                outcome = {
                    accepted: false,
                    ambiguous: true,
                    message: "Daraja response was not conclusive. The withdrawal is pending confirmation; do not submit it again."
                };
            }

            if (!outcome.accepted && !outcome.ambiguous) {
                try {
                    await mpesaB2c.rejectPayout(reference);
                } catch (_) {
                    return res.status(503).json({
                        success: false,
                        status: "pending",
                        message: "Daraja did not accept the request, but the wallet could not be restored yet. Keep this page open and contact support with reference " + reference + "."
                    });
                }
            }

            let current;
            try {
                const currentResult = await pool.query(
                    "SELECT p.status, w.balance, w.locked_balance, w.currency FROM mpesa_payouts p JOIN wallets w ON w.user_id=p.user_id WHERE p.reference=$1",
                    [reference]
                );
                current = currentResult.rows[0];
            } catch (_) {}

            const status = current ? current.status : "pending";
            const wallet = current ? {
                balance: Number(current.balance),
                lockedBalance: Number(current.locked_balance || 0),
                availableBalance: Number(current.balance),
                currency: current.currency || walletCurrency
            } : undefined;

            if (!outcome.accepted && !outcome.ambiguous && status === "failed") {
                return res.status(502).json({
                    success: false,
                    status: "failed",
                    message: outcome.message || "Daraja rejected this withdrawal. The wallet was restored.",
                    wallet
                });
            }

            const message = outcome.ambiguous
                ? outcome.message
                : status === "completed"
                    ? "M-Pesa confirmed the payout."
                    : status === "failed"
                        ? "M-Pesa did not complete the payout. Your wallet was restored."
                        : "Withdrawal sent to Daraja and awaiting confirmation. Do not submit it again.";

            return res.status(status === "pending" ? 202 : 200).json({
                success: status !== "failed",
                message,
                status,
                fee,
                feeRate,
                payout,
                wallet
            });
        }
    );


    // ==================================================
    // TRANSACTION HISTORY
    // ==================================================

    router.get(
        "/transactions",
        authenticateToken,
        async function(req, res) {

            try {

                const userId =
                    Number(req.user.userId);


                let limit =
                    Number(
                        req.query.limit || 50
                    );


                if (
                    !Number.isInteger(limit) ||
                    limit < 1
                ) {
                    limit = 50;
                }


                limit =
                    Math.min(
                        limit,
                        100
                    );


                const result =
                    await pool.query(
                        `
                        SELECT
                            id,
                            transaction_type,
                            amount,
                            currency,
                            status,
                            reference,
                            description,
                            created_at
                        FROM transactions
                        WHERE user_id = $1
                          AND created_at > COALESCE(
                              (SELECT cleared_at FROM user_history_clears
                               WHERE user_id = $1 AND history_type = 'transactions'),
                              '-infinity'::timestamptz
                          )
                        ORDER BY created_at DESC
                        LIMIT $2
                        `,
                        [
                            userId,
                            limit
                        ]
                    );


                res.json({

                    success: true,

                    transactions:
                        result.rows.map(
                            function(row) {

                                return {

                                    id:
                                        Number(row.id),

                                    type:
                                        row.transaction_type,

                                    amount:
                                        Number(row.amount),

                                    currency:
                                        row.currency,

                                    status:
                                        row.status,

                                    reference:
                                        row.reference,

                                    description:
                                        row.description,

                                    createdAt:
                                        row.created_at
                                };
                            }
                        )

                });

            } catch (error) {

                console.error(
                    "Transaction history error:",
                    error.message
                );


                res.status(500).json({

                    success: false,

                    message:
                        "Failed to retrieve transactions."
                });
            }

        }
    );


    return router;
};


module.exports = routerFactory;
