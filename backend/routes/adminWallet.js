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

module.exports = function createAdminWalletRoutes(pool, authenticateToken, mpesaB2c, pushService) {
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
            const [wallet, clearMarker, transactions] = await Promise.all([
                pool.query("SELECT balance,currency FROM admin_wallets WHERE admin_id=$1", [adminId]),
                pool.query("SELECT cleared_at FROM admin_wallet_history_clears WHERE admin_id=$1", [adminId]),
                pool.query(`SELECT transaction_type,amount,currency,status,reference,description,created_at
                              FROM admin_wallet_transactions
                             WHERE admin_id=$1
                               AND created_at > COALESCE((SELECT cleared_at FROM admin_wallet_history_clears WHERE admin_id=$1),'-infinity'::timestamptz)
                             ORDER BY created_at DESC,id DESC LIMIT 50`, [adminId])
            ]);
            return res.json({
                success: true,
                wallet: { balance: Number(wallet.rows[0].balance || 0), currency: wallet.rows[0].currency || "KES" },
                historyClearedAt: clearMarker.rows[0] ? clearMarker.rows[0].cleared_at : null,
                transactions: transactions.rows
            });
        } catch (error) {
            console.error("Admin wallet read failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load the administrator wallet." });
        }
    });

    router.get("/manual-withdrawals", authenticateToken, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT r.id,r.reference,r.user_id,r.recipient_phone,r.total_amount,
                        r.fee_amount,r.payout_amount,r.status,r.requested_at,r.completed_at,
                        r.admin_cleared_at, u.username, COALESCE(w.balance,0)::numeric(12,2) AS current_balance
                   FROM manual_withdrawal_requests r
                   JOIN users u ON u.id=r.user_id
                   LEFT JOIN wallets w ON w.user_id=r.user_id
                  WHERE r.status IN ('pending','completed') AND r.admin_cleared_at IS NULL
                  ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,
                           r.requested_at DESC
                  LIMIT 200`
            );
            return res.json({ success: true, withdrawals: result.rows });
        } catch (error) {
            console.error("Manual withdrawal queue read failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load manual withdrawal requests." });
        }
    });

    router.post("/manual-withdrawals/:id/complete", authenticateToken, adminOnly, async (req, res) => {
        const requestId = Number(req.params.id);
        if (!Number.isSafeInteger(requestId) || requestId < 1) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal request." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const requestResult = await client.query(
                `SELECT id,reference,user_id,total_amount,fee_amount,payout_amount,recipient_phone,status
                   FROM manual_withdrawal_requests WHERE id=$1 FOR UPDATE`,
                [requestId]
            );
            if (!requestResult.rows.length) throw Object.assign(new Error("Withdrawal request not found."), { status: 404 });
            const request = requestResult.rows[0];
            if (request.status !== "pending") throw Object.assign(new Error("This withdrawal is no longer pending."), { status: 409 });

            const walletResult = await client.query(
                "SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE",
                [request.user_id]
            );
            if (!walletResult.rows.length) throw Object.assign(new Error("Player wallet not found."), { status: 404 });
            const total = Number(request.total_amount);
            const currentBalance = Number(walletResult.rows[0].balance || 0);
            if (currentBalance < total) {
                throw Object.assign(new Error("The player’s current wallet balance is below the total withdrawal amount. The request was not completed."), { status: 409 });
            }

            const walletUpdate = await client.query(
                "UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance",
                [total, request.user_id]
            );
            await client.query(
                `UPDATE manual_withdrawal_requests
                    SET status='completed',completed_at=NOW(),resolved_by=$2
                  WHERE id=$1`,
                [requestId, Number(req.user.userId)]
            );
            await client.query(
                `UPDATE transactions SET status='completed',description=$1
                  WHERE user_id=$2 AND reference=$3 AND transaction_type='withdrawal'`,
                ["Manual M-Pesa payout confirmed by admin. Reference " + request.reference, request.user_id, request.reference]
            );
            await client.query(
                `UPDATE transactions SET status='completed',description=$1
                  WHERE user_id=$2 AND reference=$3 AND transaction_type='withdrawal_fee'`,
                ["Processing fee included in the completed manual withdrawal.", request.user_id, request.reference + "-FEE"]
            );
            const successMessage = "Your manual M-Pesa withdrawal of KSh " +
                Number(request.payout_amount).toLocaleString("en-KE") + " was confirmed by the admin. " +
                "KSh " + total.toLocaleString("en-KE") + " including the processing fee was deducted from your wallet.";
            await client.query(
                "INSERT INTO system_notifications(user_id,type,title,message) VALUES($1,'withdrawal_completed','Withdrawal successful',$2)",
                [request.user_id, successMessage]
            );
            if (pushService && typeof pushService.enqueueNotification === "function") {
                await client.query("SAVEPOINT manual_withdrawal_push_enqueue");
                try {
                    await pushService.enqueueNotification(client, Number(request.user_id), {
                        eventKey: "manual-withdrawal:" + request.reference + ":completed",
                        title: "GOAL$GAMBIT — Withdrawal Successful",
                        body: "Your manual M-Pesa payout was confirmed. Open GOAL$GAMBIT to view your updated wallet.",
                        page: "match-hub"
                    });
                    await client.query("RELEASE SAVEPOINT manual_withdrawal_push_enqueue");
                } catch (pushError) {
                    await client.query("ROLLBACK TO SAVEPOINT manual_withdrawal_push_enqueue").catch(() => {});
                    await client.query("RELEASE SAVEPOINT manual_withdrawal_push_enqueue").catch(() => {});
                    console.error("Manual withdrawal push enqueue failed:", pushError.message);
                }
            }
            await client.query("COMMIT");
            if (pushService && typeof pushService.sendPendingJobs === "function") {
                pushService.sendPendingJobs().catch(function() {});
            }
            return res.json({
                success: true,
                message: "Manual payment confirmed. KSh " + Number(request.total_amount).toLocaleString("en-KE") +
                    " was deducted from the player wallet.",
                withdrawal: { id: requestId, status: "completed", reference: request.reference },
                wallet: { balance: Number(walletUpdate.rows[0].balance) }
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            return res.status(Number(error.status) || 500).json({
                success: false,
                message: error.message || "Could not complete the manual withdrawal."
            });
        } finally {
            client.release();
        }
    });

    router.post("/manual-withdrawals/:id/clear", authenticateToken, adminOnly, async (req, res) => {
        const requestId = Number(req.params.id);
        if (!Number.isSafeInteger(requestId) || requestId < 1) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal request." });
        }
        try {
            const result = await pool.query(
                `UPDATE manual_withdrawal_requests
                    SET admin_cleared_at=NOW(),admin_cleared_by=$2
                  WHERE id=$1 AND status='completed' AND admin_cleared_at IS NULL
                  RETURNING id`,
                [requestId, Number(req.user.userId)]
            );
            if (!result.rows.length) {
                return res.status(409).json({ success: false, message: "Only a completed, uncleared withdrawal can be cleared." });
            }
            return res.json({ success: true, message: "Completed withdrawal cleared from the admin queue." });
        } catch (error) {
            console.error("Manual withdrawal clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear this completed withdrawal." });
        }
    });

    router.post("/history/clear", authenticateToken, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(
                `INSERT INTO admin_wallet_history_clears(admin_id,cleared_at)
                 VALUES($1,NOW())
                 ON CONFLICT(admin_id) DO UPDATE SET cleared_at=EXCLUDED.cleared_at
                 RETURNING cleared_at`,
                [Number(req.user.userId)]
            );
            return res.json({
                success: true,
                clearedAt: result.rows[0].cleared_at,
                message: "Administrator wallet activity was cleared from this view. Financial ledger records were retained for reconciliation."
            });
        } catch (error) {
            console.error("Admin wallet history clear failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not clear administrator wallet activity." });
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
