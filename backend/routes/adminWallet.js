"use strict";

const express = require("express");
const { randomUUID } = require("crypto");
const { recordJournal } = require("../services/financialLedger");
const { creditPlatform } = require("../services/adminWalletAccounting");
const financialRateLimit = require("../middleware/financialRateLimit");
const { createAdminOnly } = require("../middleware/adminAuthorization");

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
    const withdrawalResolutionLimit = financialRateLimit("admin-player-withdrawal-resolution", { windowMs: 10 * 60 * 1000, max: 60 });
    const adminWithdrawalLimit = financialRateLimit("admin-wallet-withdrawal", { windowMs: 10 * 60 * 1000, max: 10 });

    const adminOnly = createAdminOnly(pool, "Admin wallet authorization failed");

    router.get("/", authenticateToken, adminOnly, async (req, res) => {
        const adminId = Number(req.user.userId);
        const search = String(req.query.q || "").trim().slice(0, 80);
        try {
            await pool.query("INSERT INTO admin_wallets(admin_id) VALUES($1) ON CONFLICT(admin_id) DO NOTHING", [adminId]);
            const [wallet, clearMarker, transactions, totals, activity, pendingWithdrawals, retained, reconciliation] = await Promise.all([
                pool.query("SELECT balance,reserved_balance,currency FROM admin_wallets WHERE admin_id=$1", [adminId]),
                pool.query("SELECT cleared_at FROM admin_wallet_history_clears WHERE admin_id=$1", [adminId]),
                pool.query(`SELECT t.transaction_type,t.amount,t.currency,t.status,t.reference,t.description,t.created_at,u.username AS admin_username
                              FROM admin_wallet_transactions t JOIN users u ON u.id=t.admin_id
                             WHERE t.created_at > COALESCE((SELECT c.cleared_at FROM admin_wallet_history_clears c WHERE c.admin_id=t.admin_id),'-infinity'::timestamptz)
                               AND ($1='' OR t.reference ILIKE '%'||$1||'%' OR t.transaction_type ILIKE '%'||$1||'%' OR t.description ILIKE '%'||$1||'%' OR u.username ILIKE '%'||$1||'%')
                             ORDER BY t.created_at DESC,t.id DESC LIMIT 200`, [search]),
                pool.query(`SELECT COALESCE(SUM(balance),0)::numeric(14,2) AS total_balance,
                                   COALESCE(SUM(balance-reserved_balance),0)::numeric(14,2) AS available,
                                   COALESCE(SUM(reserved_balance),0)::numeric(14,2) AS competition_reserved
                              FROM admin_wallets`),
                pool.query(`SELECT transaction_type,COALESCE(SUM(amount),0)::numeric(14,2) AS amount
                              FROM admin_wallet_transactions WHERE status='completed' GROUP BY transaction_type`),
                pool.query(`SELECT
                    COALESCE((SELECT SUM(total_amount) FROM manual_withdrawal_requests WHERE status='pending' AND funds_reserved=TRUE),0)::numeric(14,2) AS player_manual,
                    COALESCE((SELECT SUM(w.amount+COALESCE(f.amount,0)) FROM admin_mpesa_payouts p
                               JOIN admin_wallet_transactions w ON w.reference=p.reference
                               LEFT JOIN admin_wallet_transactions f ON f.reference=p.reference||'-FEE'
                              WHERE p.status='pending'),0)::numeric(14,2) AS admin_provider`),
                pool.query(`SELECT
                    COALESCE((SELECT SUM(retained_revenue) FROM efootball_competition_settlements),0)::numeric(14,2) AS efootball,
                    COALESCE((SELECT SUM(retained_revenue) FROM chess_competition_settlements),0)::numeric(14,2) AS chess,
                    COALESCE((SELECT SUM(prize_amount) FROM chess_competition_settlements),0)::numeric(14,2) AS chess_prizes,
                    COALESCE((SELECT SUM(amount) FROM financial_ledger_transactions WHERE transaction_type='player_withdrawal_paid'),0)::numeric(14,2) AS player_withdrawals`),
                pool.query(`WITH ledger AS (
                                SELECT account_type,account_id,SUM(credit-debit)::numeric(14,2) AS balance
                                  FROM financial_ledger_entries GROUP BY account_type,account_id
                            ), user_available AS (
                                SELECT account_id,balance FROM ledger WHERE account_type='user_wallet_available'
                            ), user_locked AS (
                                SELECT account_id,SUM(balance)::numeric(14,2) AS balance FROM ledger
                                 WHERE account_type IN ('user_wallet_locked','chess_match_locked','efootball_match_locked')
                                 GROUP BY account_id
                            ), user_withdrawal_reserved AS (
                                SELECT account_id,balance FROM ledger WHERE account_type='user_wallet_withdrawal_reserved'
                            ), admin_available AS (
                                SELECT account_id,balance FROM ledger WHERE account_type='admin_wallet_available'
                            ), admin_reserved AS (
                                SELECT account_id,balance FROM ledger WHERE account_type='admin_wallet_reserved'
                            ), invalid_journals AS (
                                SELECT t.id FROM financial_ledger_transactions t
                                LEFT JOIN financial_ledger_entries e ON e.transaction_id=t.id
                                GROUP BY t.id,t.amount,t.posted_at
                                HAVING t.posted_at IS NULL
                                    OR COALESCE(SUM(e.debit),0)<>COALESCE(SUM(e.credit),0)
                                    OR COALESCE(SUM(e.debit),0)<>t.amount
                            )
                            SELECT
                                (SELECT COUNT(*) FROM wallets w FULL OUTER JOIN user_available l ON l.account_id=w.user_id
                                  WHERE COALESCE(w.balance,0)<>COALESCE(l.balance,0)) AS player_available_mismatches,
                                (SELECT COUNT(*) FROM wallets w FULL OUTER JOIN user_locked l ON l.account_id=w.user_id
                                  WHERE COALESCE(w.locked_balance,0)<>COALESCE(l.balance,0)) AS player_locked_mismatches,
                                (SELECT COUNT(*) FROM wallets w FULL OUTER JOIN user_withdrawal_reserved l ON l.account_id=w.user_id
                                  WHERE COALESCE(w.withdrawal_reserved_balance,0)<>COALESCE(l.balance,0)) AS player_withdrawal_mismatches,
                                (SELECT COUNT(*) FROM admin_wallets w FULL OUTER JOIN admin_available l ON l.account_id=w.admin_id
                                  WHERE COALESCE(w.balance-w.reserved_balance,0)<>COALESCE(l.balance,0)) AS admin_available_mismatches,
                                (SELECT COUNT(*) FROM admin_wallets w FULL OUTER JOIN admin_reserved l ON l.account_id=w.admin_id
                                  WHERE COALESCE(w.reserved_balance,0)<>COALESCE(l.balance,0)) AS admin_reserved_mismatches,
                                (SELECT COUNT(*) FROM invalid_journals) AS unbalanced_journals`)
            ]);
            const amounts = new Map(activity.rows.map((row) => [row.transaction_type, Number(row.amount || 0)]));
            const summary = totals.rows[0] || {};
            const pending = pendingWithdrawals.rows[0] || {};
            const retainedRevenue = Number(retained.rows[0] && retained.rows[0].efootball || 0) + Number(retained.rows[0] && retained.rows[0].chess || 0);
            const otherPlatformRevenue = ["player_withdrawal_fee","league_forfeit_stake","tournament_forfeit_stake","chess_tournament_forfeit_stake"]
                .reduce((sum, type) => sum + (amounts.get(type) || 0), 0);
            return res.json({
                success: true,
                wallet: {
                    balance: Number(wallet.rows[0].balance || 0),
                    reservedBalance: Number(wallet.rows[0].reserved_balance || 0),
                    availableBalance: Number(wallet.rows[0].balance || 0) - Number(wallet.rows[0].reserved_balance || 0),
                    currency: wallet.rows[0].currency || "KES"
                },
                platform: {
                    totalFundsReceived: (amounts.get("league_entry_fee") || 0) + (amounts.get("tournament_entry_fee") || 0) + (amounts.get("ranked_match_deduction") || 0) + otherPlatformRevenue,
                    entryFeesCollected: (amounts.get("league_entry_fee") || 0) + (amounts.get("tournament_entry_fee") || 0),
                    otherPlatformRevenue,
                    availableFunds: Number(summary.available || 0),
                    totalBalance: Number(summary.total_balance || 0),
                    competitionReserved: Number(summary.competition_reserved || 0),
                    pendingWithdrawalReservations: Number(pending.player_manual || 0) + Number(pending.admin_provider || 0),
                    leagueEntryFees: amounts.get("league_entry_fee") || 0,
                    tournamentEntryFees: amounts.get("tournament_entry_fee") || 0,
                    rankedMatchDeductions: amounts.get("ranked_match_deduction") || 0,
                    prizesPaid: (amounts.get("competition_prize_paid") || 0) + Number(retained.rows[0] && retained.rows[0].chess_prizes || 0),
                    refundsAndReversals: (amounts.get("league_entry_refund") || 0) + (amounts.get("tournament_entry_refund") || 0) + (amounts.get("chess_tournament_search_refund") || 0),
                    retainedPrizePoolRevenue: retainedRevenue,
                    withdrawals: (amounts.get("withdrawal") || 0) + (amounts.get("withdrawal_fee") || 0) + Number(retained.rows[0] && retained.rows[0].player_withdrawals || 0)
                },
                reconciliation: Object.fromEntries(Object.entries(reconciliation.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)])),
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
                        r.fee_amount,r.payout_amount,r.status,r.funds_reserved,r.requested_at,r.completed_at,
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

    router.post("/manual-withdrawals/:id/complete", authenticateToken, adminOnly, withdrawalResolutionLimit, async (req, res) => {
        const requestId = Number(req.params.id);
        if (!Number.isSafeInteger(requestId) || requestId < 1) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal request." });
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const requestResult = await client.query(
                `SELECT id,reference,user_id,total_amount,fee_amount,payout_amount,recipient_phone,status,funds_reserved
                   FROM manual_withdrawal_requests WHERE id=$1 FOR UPDATE`,
                [requestId]
            );
            if (!requestResult.rows.length) throw Object.assign(new Error("Withdrawal request not found."), { status: 404 });
            const request = requestResult.rows[0];
            if (request.status !== "pending") throw Object.assign(new Error("This withdrawal is no longer pending."), { status: 409 });
            if (!request.funds_reserved) throw Object.assign(new Error("This older pending request was not safely reserved. Cancel it or reconcile it before sending a payout."), { status: 409 });

            const walletResult = await client.query(
                "SELECT balance,withdrawal_reserved_balance FROM wallets WHERE user_id=$1 FOR UPDATE",
                [request.user_id]
            );
            if (!walletResult.rows.length) throw Object.assign(new Error("Player wallet not found."), { status: 404 });
            const total = Number(request.total_amount);
            if (Number(walletResult.rows[0].withdrawal_reserved_balance || 0) < total) throw Object.assign(new Error("Reserved player funds do not reconcile with this withdrawal; it was not completed."), { status: 409 });

            const walletUpdate = await client.query(
                "UPDATE wallets SET withdrawal_reserved_balance=withdrawal_reserved_balance-$1,updated_at=NOW() WHERE user_id=$2 AND withdrawal_reserved_balance >= $1 RETURNING balance,withdrawal_reserved_balance",
                [total, request.user_id]
            );
            if (!walletUpdate.rows.length) throw Object.assign(new Error("Reserved player funds do not reconcile with this withdrawal."), { status: 409 });
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
            const payoutAmount = Number(request.payout_amount);
            const feeAmount = Number(request.fee_amount);
            await recordJournal(client, {
                reference: `WD-PAYOUT-${request.reference}`, transactionType: "player_withdrawal_paid",
                amount: payoutAmount, description: "Manually confirmed M-Pesa payout",
                context: { userId: Number(request.user_id), withdrawalReference: request.reference },
                postings: [
                    { accountType: "user_wallet_withdrawal_reserved", accountId: Number(request.user_id), debit: payoutAmount },
                    { accountType: "external_mpesa_payout", accountId: null, credit: payoutAmount }
                ]
            });
            if (feeAmount > 0) {
                await creditPlatform(client, {
                    amount: feeAmount, reference: `WD-FEE-${request.reference}`,
                    transactionType: "player_withdrawal_fee", description: "Player withdrawal processing fee retained by platform",
                    context: { userId: Number(request.user_id), withdrawalReference: request.reference },
                    debitPostings: [{ accountType: "user_wallet_withdrawal_reserved", accountId: Number(request.user_id), debit: feeAmount }]
                });
            }
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
                wallet: { balance: Number(walletUpdate.rows[0].balance), reservedWithdrawalBalance: Number(walletUpdate.rows[0].withdrawal_reserved_balance) }
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || 500;
            if (status >= 500) console.error("Manual withdrawal resolution failed:", error.message);
            return res.status(status).json({
                success: false,
                message: status >= 500 ? "Could not complete the manual withdrawal." : error.message
            });
        } finally {
            client.release();
        }
    });

    router.post("/manual-withdrawals/:id/cancel", authenticateToken, adminOnly, withdrawalResolutionLimit, async (req, res) => {
        const requestId = Number(req.params.id);
        if (!Number.isSafeInteger(requestId) || requestId < 1) return res.status(400).json({ success: false, message: "Invalid withdrawal request." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const requestResult = await client.query("SELECT id,reference,user_id,total_amount,status,funds_reserved FROM manual_withdrawal_requests WHERE id=$1 FOR UPDATE", [requestId]);
            if (!requestResult.rows.length) throw Object.assign(new Error("Withdrawal request not found."), { status: 404 });
            const request = requestResult.rows[0];
            if (request.status !== "pending") throw Object.assign(new Error("Only a pending withdrawal can be cancelled."), { status: 409 });
            const amount = Number(request.total_amount);
            if (request.funds_reserved) {
                const wallet = await client.query(
                    `UPDATE wallets SET balance=balance+$1,withdrawal_reserved_balance=withdrawal_reserved_balance-$1,updated_at=NOW()
                      WHERE user_id=$2 AND withdrawal_reserved_balance >= $1 RETURNING balance`, [amount, request.user_id]);
                if (!wallet.rows.length) throw Object.assign(new Error("Reserved funds do not reconcile; cancellation was stopped."), { status: 409 });
            }
            await client.query("UPDATE manual_withdrawal_requests SET status='cancelled',resolved_by=$2 WHERE id=$1", [requestId, Number(req.user.userId)]);
            await client.query("UPDATE transactions SET status='cancelled',description='Withdrawal request cancelled and reserved funds returned.' WHERE reference IN ($1,$2) AND status='pending'", [request.reference, request.reference + "-FEE"]);
            if (request.funds_reserved) await recordJournal(client, {
                reference: `WD-CANCEL-${request.reference}`, transactionType: "withdrawal_reservation_release",
                amount, description: "Cancelled withdrawal reservation returned to player wallet",
                context: { userId: Number(request.user_id), withdrawalReference: request.reference },
                postings: [
                    { accountType: "user_wallet_withdrawal_reserved", accountId: Number(request.user_id), debit: amount },
                    { accountType: "user_wallet_available", accountId: Number(request.user_id), credit: amount }
                ]
            });
            await client.query("COMMIT");
            return res.json({ success: true, message: "Withdrawal cancelled and the reserved funds returned to the player." });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || 500;
            if (status >= 500) console.error("Manual withdrawal cancellation failed:", error.message);
            return res.status(status).json({ success: false, message: status >= 500 ? "Could not cancel the withdrawal." : error.message });
        } finally { client.release(); }
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

    router.post("/withdraw", authenticateToken, adminOnly, adminWithdrawalLimit, async (req, res) => {
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
            const wallet = await client.query("SELECT balance,reserved_balance,currency FROM admin_wallets WHERE admin_id=$1 FOR UPDATE", [adminId]);
            if (!wallet.rows.length) throw Object.assign(new Error("Admin wallet not found."), { status: 409 });
            if (Number(wallet.rows[0].balance) - Number(wallet.rows[0].reserved_balance || 0) < amount) throw Object.assign(new Error("Insufficient available administrator wallet balance after competition reserves."), { status: 400 });
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
            await recordJournal(client, {
                reference: `ADM-WD-RESERVE-${reference}`, transactionType: "admin_withdrawal_reservation",
                amount, description: "Administrator M-Pesa payout reserved pending verified provider callback",
                context: { adminId, withdrawalReference: reference },
                postings: [
                    { accountType: "admin_wallet_available", accountId: adminId, debit: amount },
                    { accountType: "admin_withdrawal_pending", accountId: adminId, credit: amount }
                ]
            });
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            const status = Number(error.status) || (error.code === "23505" ? 409 : 500);
            if (status >= 500) console.error("Administrator withdrawal could not be created:", error.message);
            return res.status(status).json({ success: false, message: status >= 500 ? "Could not create the administrator withdrawal." : error.message });
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
            const result = await pool.query("SELECT p.status,w.balance,w.reserved_balance,w.currency FROM admin_mpesa_payouts p JOIN admin_wallets w ON w.admin_id=p.admin_id WHERE p.reference=$1", [reference]);
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
            wallet: current ? { balance: Number(current.balance), availableBalance: Number(current.balance)-Number(current.reserved_balance||0), currency: current.currency || "KES" } : undefined
        });
    });

    return router;
};
