"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const WITHDRAWAL_FEE_RATE = 0.05;
const MAX_WITHDRAWAL = 1000000;

function normalizeMpesaPhone(value) {
    if (value === null || value === undefined) return null;
    const phone = String(value).replace(/\s+/g, "").trim();
    if (/^07\d{8}$/.test(phone)) return "254" + phone.slice(1);
    if (/^011\d{7}$/.test(phone)) return "254" + phone.slice(1);
    if (/^07420\d{5}$/.test(phone)) return "254" + phone.slice(1);
    if (/^2547\d{8}$/.test(phone) || /^25411\d{7}$/.test(phone) || /^2547420\d{5}$/.test(phone)) return phone;
    return null;
}

module.exports = function createAdminWalletRoutes(pool, authenticateToken, mpesaB2c) {
    const router = express.Router();

    async function adminOnly(req, res, next) {
        res.setHeader("Cache-Control", "private, no-store");
        try {
            const result = await pool.query("SELECT id,role FROM users WHERE id=$1", [req.user.userId]);
            if (!result.rows.length || result.rows[0].role !== "admin") {
                return res.status(403).json({ success: false, message: "Administrator access required." });
            }
            return next();
        } catch (error) {
            console.error("Admin wallet authorization failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not verify administrator access." });
        }
    }

    router.get("/", authenticateToken, adminOnly, async (req, res) => {
        const adminId = Number(req.user.userId);
        try {
            await pool.query("INSERT INTO admin_wallets(admin_id) VALUES($1) ON CONFLICT(admin_id) DO NOTHING", [adminId]);
            const [wallet, transactions] = await Promise.all([
                pool.query("SELECT balance,currency FROM admin_wallets WHERE admin_id=$1", [adminId]),
                pool.query("SELECT transaction_type,amount,currency,status,reference,description,created_at FROM admin_wallet_transactions WHERE admin_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50", [adminId])
            ]);
            return res.json({
                success: true,
                wallet: { balance: Number(wallet.rows[0].balance || 0), currency: wallet.rows[0].currency || "KES" },
                transactions: transactions.rows
            });
        } catch (error) {
            console.error("Admin wallet read failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load the administrator wallet." });
        }
    });

    router.post("/withdraw", authenticateToken, adminOnly, async (req, res) => {
        const adminId = Number(req.user.userId);
        const amount = Number(req.body && req.body.amount);
        const phone = normalizeMpesaPhone(req.body && req.body.phone);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_WITHDRAWAL) {
            return res.status(400).json({ success: false, message: "Enter a whole KSh amount from 1 to 1,000,000." });
        }
        if (!phone) return res.status(400).json({ success: false, message: "Enter a valid Kenyan M-Pesa number." });
        if (!mpesaB2c || !mpesaB2c.isConfigured()) {
            const message = mpesaB2c && mpesaB2c.configurationIssue
                ? mpesaB2c.configurationIssue()
                : "M-Pesa withdrawals are temporarily unavailable.";
            return res.status(503).json({ success: false, message });
        }

        const fee = Math.round(amount * WITHDRAWAL_FEE_RATE);
        const payout = amount - fee;
        if (payout < 1) return res.status(400).json({ success: false, message: "Withdrawal amount is too small after the processing fee." });

        const callback = mpesaB2c.createCallbackToken();
        const reference = "ADM-WD-" + adminId + "-" + randomUUID();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const wallet = await client.query("SELECT balance,currency FROM admin_wallets WHERE admin_id=$1 FOR UPDATE", [adminId]);
            if (!wallet.rows.length) throw Object.assign(new Error("Admin wallet not found."), { status: 409 });
            if (Number(wallet.rows[0].balance) < amount) throw Object.assign(new Error("Insufficient administrator wallet balance."), { status: 400 });
            const pending = await client.query("SELECT 1 FROM admin_mpesa_payouts WHERE admin_id=$1 AND status='pending' LIMIT 1", [adminId]);
            if (pending.rows.length) throw Object.assign(new Error("An administrator withdrawal is already awaiting M-Pesa confirmation."), { status: 409 });

            await client.query("UPDATE admin_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2", [amount, adminId]);
            await client.query(
                "INSERT INTO admin_wallet_transactions(admin_id,transaction_type,amount,currency,status,reference,description) VALUES($1,'withdrawal',$2,'KES','pending',$3,'Administrator wallet M-Pesa withdrawal')",
                [adminId, payout, reference]
            );
            await client.query(
                "INSERT INTO admin_wallet_transactions(admin_id,transaction_type,amount,currency,status,reference,description) VALUES($1,'withdrawal_fee',$2,'KES','pending',$3,'Administrator wallet withdrawal processing fee')",
                [adminId, fee, reference + "-FEE"]
            );
            await client.query(
                "INSERT INTO admin_mpesa_payouts(reference,admin_id,recipient_phone,callback_token_hash,originator_conversation_id) VALUES($1,$2,$3,$4,$5)",
                [reference, adminId, phone, callback.tokenHash, callback.originatorConversationId]
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || (error.code === "23505" ? 409 : 500);
            return res.status(status).json({ success: false, message: error.message || "Could not create the administrator withdrawal." });
        } finally {
            client.release();
        }

        let outcome;
        try {
            outcome = await mpesaB2c.submitPayout({
                amount: payout, phone, reference,
                callbackToken: callback.token,
                originatorConversationId: callback.originatorConversationId,
                walletType: "admin"
            });
        } catch (_) {
            outcome = { accepted: false, ambiguous: true, message: "Daraja’s reply was not conclusive. The withdrawal is pending confirmation; do not submit it again." };
        }
        if (!outcome.accepted && !outcome.ambiguous) {
            try { await mpesaB2c.rejectPayout(reference); }
            catch (_) { return res.status(503).json({ success: false, status: "pending", message: "Daraja rejected the request but the administrator wallet could not be restored yet. Keep reference " + reference + " for reconciliation." }); }
        }

        let current = null;
        try {
            const result = await pool.query("SELECT p.status,w.balance,w.currency FROM admin_mpesa_payouts p JOIN admin_wallets w ON w.admin_id=p.admin_id WHERE p.reference=$1", [reference]);
            current = result.rows[0] || null;
        } catch (_) {}
        const status = current ? current.status : "pending";
        const message = outcome.ambiguous
            ? outcome.message
            : status === "completed" ? "M-Pesa confirmed the administrator payout."
                : status === "failed" ? "M-Pesa did not complete the payout. The administrator wallet was restored."
                    : "Withdrawal sent to Daraja and awaiting confirmation. Do not submit it again.";
        return res.status(status === "pending" ? 202 : status === "failed" ? 502 : 200).json({
            success: status !== "failed", status, message, payout,
            wallet: current ? { balance: Number(current.balance), currency: current.currency || "KES" } : undefined
        });
    });

    return router;
};
