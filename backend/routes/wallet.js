"use strict";

const express = require("express");
const { randomUUID } = require("crypto");
const { recordJournal } = require("../services/financialLedger");
const financialRateLimit = require("../middleware/financialRateLimit");


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
    const depositLimit = financialRateLimit("player-test-deposit", { windowMs: 15 * 60 * 1000, max: 5 });
    const withdrawalLimit = financialRateLimit("player-withdrawal", { windowMs: 15 * 60 * 1000, max: 5 });

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
                            withdrawal_reserved_balance,
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
                        reservedWithdrawalBalance: Number(wallet.withdrawal_reserved_balance || 0),

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
        depositLimit,
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
                    "SELECT id, balance, locked_balance, withdrawal_reserved_balance, currency FROM wallets WHERE user_id=$1 FOR UPDATE",
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
                await recordJournal(client, {
                    reference, transactionType: "development_deposit", amount,
                    description: "Development-only test deposit",
                    context: { userId, source: "test_deposit" },
                    postings: [
                        { accountType: "external_test_funds", accountId: null, debit: amount },
                        { accountType: "user_wallet_available", accountId: userId, credit: amount }
                    ]
                });
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

    // Manual payout mode is used until the production B2C service is enabled.
    // Reserve the player's funds immediately so a pending request cannot be
    // spent by a second request or match while the admin pays it manually.
    router.post(
        ["/withdraw/manual", "/withdraw"],
        authenticateToken,
        withdrawalLimit,
        async function(req, res) {
            const amount = parseMoney(req.body && req.body.amount);
            const mpesaPhone = normalizeMpesaPhone(req.body && req.body.phone);
            if (amount === null || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
                return res.status(400).json({ success: false, message: "Enter a whole KSh amount from 1 to 1,000,000." });
            }
            if (mpesaPhone === null) {
                return res.status(400).json({ success: false, message: "Valid Kenyan M-Pesa number is required." });
            }

            const userId = Number(req.user.userId);
            const reference = "WD-" + userId + "-" + randomUUID();
            const feeRate = withdrawalFeeRate(amount);
            const fee = Math.round(amount * feeRate);
            const payout = amount - fee;
            if (payout < 1) {
                return res.status(400).json({ success: false, message: "Withdrawal amount is too small after the processing fee." });
            }

            let client;
            try {
                client = await pool.connect();
                await client.query("BEGIN");
                const walletResult = await client.query(
                    "SELECT balance,withdrawal_reserved_balance FROM wallets WHERE user_id=$1 FOR UPDATE",
                    [userId]
                );
                if (!walletResult.rows.length) throw Object.assign(new Error("Wallet not found."), { status: 404 });
                if (Number(walletResult.rows[0].balance || 0) < amount) {
                    throw Object.assign(new Error("Insufficient available balance."), { status: 400 });
                }
                const pending = await client.query(
                    "SELECT 1 FROM manual_withdrawal_requests WHERE user_id=$1 AND status='pending' LIMIT 1",
                    [userId]
                );
                if (pending.rows.length) {
                    throw Object.assign(new Error("You already have a withdrawal request awaiting admin payment."), { status: 409 });
                }
                const reserved = await client.query(
                    `UPDATE wallets SET balance=balance-$1,
                            withdrawal_reserved_balance=withdrawal_reserved_balance+$1,updated_at=NOW()
                      WHERE user_id=$2 AND balance >= $1 RETURNING balance,withdrawal_reserved_balance`,
                    [amount, userId]
                );
                if (!reserved.rows.length) throw Object.assign(new Error("Insufficient available balance."), { status: 400 });
                await client.query(
                    `INSERT INTO manual_withdrawal_requests
                     (reference,user_id,recipient_phone,total_amount,fee_amount,payout_amount,funds_reserved)
                     VALUES($1,$2,$3,$4,$5,$6,TRUE)`,
                    [reference, userId, mpesaPhone, amount, fee, payout]
                );
                await client.query(
                    `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'withdrawal',$2,'KES','pending',$3,$4)`,
                    [userId, payout, reference, "Manual withdrawal request received; wallet deduction waits for admin payment confirmation."]
                );
                await client.query(
                    `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'withdrawal_fee',$2,'KES','pending',$3,$4)`,
                    [userId, fee, reference + "-FEE", "Processing fee included in the withdrawal amount."]
                );
                await recordJournal(client, {
                    reference: `WD-RESERVE-${reference}`, transactionType: "withdrawal_reservation", amount,
                    description: "Player withdrawal funds reserved pending manual payout",
                    context: { userId, withdrawalReference: reference },
                    postings: [
                        { accountType: "user_wallet_available", accountId: userId, debit: amount },
                        { accountType: "user_wallet_withdrawal_reserved", accountId: userId, credit: amount }
                    ]
                });
                await client.query("COMMIT");
                return res.status(202).json({
                    success: true,
                    status: "pending",
                    reference,
                    fee,
                    feeRate,
                    payout,
                    message: "Withdrawal request received. The admin will manually send " +
                        "KSh " + payout.toLocaleString("en-KE") + " to your M-Pesa number. " +
                        "KSh " + amount.toLocaleString("en-KE") + " (including the processing fee) " +
                        "has been reserved and cannot be spent while the request is pending."
                });
            } catch (error) {
                if (client) await client.query("ROLLBACK").catch(() => {});
                const duplicatePending = error && error.code === "23505" &&
                    String(error.constraint || "").includes("idx_manual_withdrawal_one_pending_per_user");
                const status = Number(error && error.status) || (duplicatePending ? 409 : 500);
                if (status >= 500) console.error("Withdrawal request creation failed:", error && error.message);
                return res.status(status).json({
                    success: false,
                    message: duplicatePending
                        ? "You already have a withdrawal request awaiting admin payment."
                        : status < 500 ? error.message || "Could not create the withdrawal request."
                            : "Could not create the withdrawal request. Try again."
                });
            } finally {
                if (client) client.release();
            }
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
