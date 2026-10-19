"use strict";

const express = require("express");
const crypto = require("crypto");
const daraja = require("../routes/mpesa");
const { recordJournal } = require("./financialLedger");

const CALLBACK_TOKEN_BYTES = 32;
const TOKEN_EXPIRY_SKEW_MS = 60000;

function envValue(name) {
    let value = String(process.env[name] || "").trim();
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        value = value.slice(1, -1).trim();
    }
    return value;
}

function createCallbackToken() {
    const token = crypto.randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url");
    return {
        token,
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        originatorConversationId: "GG" + crypto.randomUUID().replace(/-/g, "")
    };
}

function safeText(value, maxLength) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, maxLength);
}

function publicBaseUrl() {
    const configured = envValue("PUBLIC_BASE_URL") ||
        (envValue("RENDER_EXTERNAL_HOSTNAME")
            ? "https://" + envValue("RENDER_EXTERNAL_HOSTNAME")
            : envValue("RENDER_EXTERNAL_URL"));
    if (!configured) return null;
    try {
        return new URL(configured);
    } catch (_) {
        return null;
    }
}

function callbackUrl(kind, token) {
    const url = publicBaseUrl();
    if (!url) throw new Error("Public HTTPS callback base URL is not configured.");
    url.pathname = "/api/payments/payout-" + kind + "/" + encodeURIComponent(token);
    url.search = "";
    url.hash = "";
    return url.toString();
}

function b2cBaseUrl() {
    return envValue("MPESA_B2C_ENVIRONMENT").toLowerCase() === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

function configurationIssue() {
    if (envValue("MPESA_B2C_ENABLED").toLowerCase() !== "true") {
        return "M-Pesa withdrawals are not enabled yet. The administrator must configure an approved B2C payout account.";
    }
    const environment = envValue("MPESA_B2C_ENVIRONMENT").toLowerCase();
    if (environment !== "sandbox" && environment !== "production") {
        return "Set MPESA_B2C_ENVIRONMENT to sandbox or production for the separate B2C Daraja app.";
    }

    const required = [
        "MPESA_B2C_CONSUMER_KEY",
        "MPESA_B2C_CONSUMER_SECRET",
        "MPESA_B2C_SHORTCODE",
        "MPESA_B2C_INITIATOR_NAME",
        "MPESA_B2C_SECURITY_CREDENTIAL"
    ];
    if (required.some(name => !envValue(name))) {
        return "M-Pesa B2C settings are incomplete. Configure the separate B2C app keys, approved payout shortcode, API initiator, and encrypted security credential.";
    }

    const shortcode = envValue("MPESA_B2C_SHORTCODE");
    if (!/^\d{5,7}$/.test(shortcode)) {
        return "MPESA_B2C_SHORTCODE must be the approved 5–7 digit B2C disbursement shortcode.";
    }

    const publicBase = publicBaseUrl();
    if (!publicBase) {
        return "Set a valid public HTTPS callback base URL.";
    }
    const host = publicBase.hostname.toLowerCase();
    const privateHost =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host === "::1" ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (publicBase.protocol !== "https:" || privateHost) {
        return "The B2C callback base URL must be public HTTPS.";
    }
    if (publicBase.username || publicBase.password) {
        return "The B2C callback URL cannot contain login credentials.";
    }
    return null;
}

function parameterValue(parameters, key) {
    const rows = parameters && parameters.ResultParameter;
    if (!Array.isArray(rows)) return null;
    const item = rows.find(row => row && row.Key === key);
    return item && item.Value !== undefined ? item.Value : null;
}

function hashMatches(token, expectedHash) {
    if (
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{40,60}$/.test(token) ||
        typeof expectedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(expectedHash)
    ) {
        return false;
    }
    const actual = crypto.createHash("sha256").update(token).digest();
    const expected = Buffer.from(expectedHash, "hex");
    return crypto.timingSafeEqual(actual, expected);
}

function createMpesaB2c(pool) {
    const router = express.Router();
    let cachedB2cAccessToken = "";
    let b2cAccessTokenExpiresAt = 0;
    let pendingB2cTokenRequest = null;

    async function getB2cAccessToken() {
        if (cachedB2cAccessToken && Date.now() < b2cAccessTokenExpiresAt) {
            return cachedB2cAccessToken;
        }
        if (pendingB2cTokenRequest) return pendingB2cTokenRequest;

        pendingB2cTokenRequest = (async function() {
            const consumerKey = envValue("MPESA_B2C_CONSUMER_KEY");
            const consumerSecret = envValue("MPESA_B2C_CONSUMER_SECRET");
            const basic = Buffer.from(consumerKey + ":" + consumerSecret, "utf8").toString("base64");
            const response = await daraja.fetchWithTimeout(
                b2cBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials",
                {
                    method: "GET",
                    headers: { Authorization: "Basic " + basic }
                },
                12000
            );
            let data;
            try {
                data = await response.json();
            } catch (_) {
                data = null;
            }
            if (!response.ok || !data || !data.access_token) {
                throw new Error("Daraja did not issue a B2C access token.");
            }

            const expiresInSeconds = Number(data.expires_in) || 3600;
            cachedB2cAccessToken = String(data.access_token);
            b2cAccessTokenExpiresAt = Date.now() + Math.max(1, expiresInSeconds - 60) * 1000;
            return cachedB2cAccessToken;
        })();

        try {
            return await pendingB2cTokenRequest;
        } finally {
            pendingB2cTokenRequest = null;
        }
    }

    function isConfigured() {
        return configurationIssue() === null;
    }

    async function updateProviderState(reference, state, response, walletType) {
        const payoutTable = walletType === "admin" ? "admin_mpesa_payouts" : "mpesa_payouts";
        await pool.query(
            `UPDATE ${payoutTable} SET provider_status=$1, originator_conversation_id=COALESCE(originator_conversation_id, $2), conversation_id=COALESCE($3, conversation_id), updated_at=NOW() WHERE reference=$4 AND status='pending'`,
            [
                state,
                safeText(response && response.OriginatorConversationID, 120) || null,
                safeText(response && response.ConversationID, 120) || null,
                reference
            ]
        );
    }

    async function finalize(reference, outcome) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            let walletType = "player";
            let found = await client.query(
                "SELECT p.reference, p.user_id, p.status, w.amount AS payout_amount, f.amount AS fee_amount FROM mpesa_payouts p JOIN transactions w ON w.reference=p.reference LEFT JOIN transactions f ON f.reference=p.reference || '-FEE' WHERE p.reference=$1 FOR UPDATE OF p",
                [reference]
            );
            if (!found.rows.length) {
                walletType = "admin";
                found = await client.query(
                    "SELECT p.reference,p.admin_id AS user_id,p.status,w.amount AS payout_amount,f.amount AS fee_amount FROM admin_mpesa_payouts p JOIN admin_wallet_transactions w ON w.reference=p.reference LEFT JOIN admin_wallet_transactions f ON f.reference=p.reference || '-FEE' WHERE p.reference=$1 FOR UPDATE OF p",
                    [reference]
                );
            }
            if (!found.rows.length) {
                await client.query("ROLLBACK");
                return false;
            }
            const payout = found.rows[0];
            if (payout.status !== "pending") {
                await client.query("COMMIT");
                return true;
            }

            const successful = outcome.success === true;
            const newStatus = successful ? "completed" : "failed";
            const ledgerTable = walletType === "admin" ? "admin_wallet_transactions" : "transactions";
            const payoutTable = walletType === "admin" ? "admin_mpesa_payouts" : "mpesa_payouts";
            await client.query(`UPDATE ${ledgerTable} SET status=$1 WHERE reference IN ($2, $3) AND status='pending'`, [newStatus, reference, reference + "-FEE"]);
            const payoutAmount = Number(payout.payout_amount);
            const feeAmount = Number(payout.fee_amount || 0);
            const gross = payoutAmount + feeAmount;
            if (!successful) {
                const walletTable = walletType === "admin" ? "admin_wallets" : "wallets";
                const ownerColumn = walletType === "admin" ? "admin_id" : "user_id";
                await client.query(`UPDATE ${walletTable} SET balance=balance + $1, updated_at=NOW() WHERE ${ownerColumn}=$2`, [gross, payout.user_id]);
            }
            const journalRef = `${walletType === "admin" ? "ADM" : "PLAYER"}-WD-${successful ? "PAID" : "RESTORED"}-${reference}`;
            const debitAccount = walletType === "admin" ? "admin_withdrawal_pending" : "player_withdrawal_pending";
            const returnAccount = walletType === "admin" ? "admin_wallet_available" : "user_wallet_available";
            await recordJournal(client, {
                reference: journalRef,
                transactionType: successful ? "verified_mpesa_withdrawal" : "failed_mpesa_withdrawal_restoration",
                amount: gross,
                description: successful ? "M-Pesa B2C payout confirmed by verified provider callback" : "Failed M-Pesa B2C payout returned to originating wallet",
                context: { walletType, ownerId: Number(payout.user_id), withdrawalReference: reference, resultCode: outcome.resultCode || null },
                postings: successful
                    ? [
                        { accountType: debitAccount, accountId: Number(payout.user_id), debit: gross },
                        { accountType: "external_mpesa_payout", accountId: null, credit: payoutAmount },
                        ...(feeAmount > 0 ? [{ accountType: "external_provider_fee", accountId: null, credit: feeAmount }] : [])
                    ]
                    : [
                        { accountType: debitAccount, accountId: Number(payout.user_id), debit: gross },
                        { accountType: returnAccount, accountId: Number(payout.user_id), credit: gross }
                    ]
            });
            await client.query(
                `UPDATE ${payoutTable} SET status=$1, provider_status=$2, result_code=$3, result_description=$4, receipt=$5, conversation_id=COALESCE($6, conversation_id), updated_at=NOW(), settled_at=NOW() WHERE reference=$7`,
                [
                    newStatus,
                    successful ? "completed" : "failed",
                    outcome.resultCode === null || outcome.resultCode === undefined ? null : String(outcome.resultCode).slice(0, 40),
                    safeText(outcome.description, 240) || (successful ? "Payout confirmed." : "Payout failed."),
                    safeText(outcome.receipt, 80) || null,
                    safeText(outcome.conversationId, 120) || null,
                    reference
                ]
            );
            await client.query("COMMIT");
            return true;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function settleCallback(token, kind, body) {
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        let lookup = await pool.query(
            "SELECT reference, callback_token_hash, originator_conversation_id, status FROM mpesa_payouts WHERE callback_token_hash=$1",
            [tokenHash]
        );
        if (!lookup.rows.length) {
            lookup = await pool.query(
                "SELECT reference,callback_token_hash,originator_conversation_id,status FROM admin_mpesa_payouts WHERE callback_token_hash=$1",
                [tokenHash]
            );
        }
        if (!lookup.rows.length || !hashMatches(token, lookup.rows[0].callback_token_hash)) {
            return { found: false };
        }

        const root = body && body.Result;
        if (!root || typeof root !== "object") {
            throw new Error("Invalid Daraja callback payload.");
        }
        if (
            root.OriginatorConversationID &&
            String(root.OriginatorConversationID) !== String(lookup.rows[0].originator_conversation_id)
        ) {
            return { found: false };
        }
        const resultCode = root.ResultCode;
        const success = kind === "result" && Number(resultCode) === 0;
        const parameters = root.ResultParameters;
        const accepted = await finalize(lookup.rows[0].reference, {
            success,
            resultCode: resultCode === undefined ? null : resultCode,
            description: safeText(root.ResultDesc, 240) ||
                (kind === "timeout" ? "Daraja queue timeout." : success ? "Payout confirmed." : "Payout was not completed."),
            receipt: parameterValue(parameters, "TransactionReceipt"),
            conversationId: root.ConversationID
        });
        return { found: accepted };
    }

    async function submitPayout(details) {
        const issue = configurationIssue();
        if (issue) {
            return { accepted: false, ambiguous: false, message: issue };
        }

        const amount = Number(details.amount);
        if (!Number.isSafeInteger(amount) || amount < 1) {
            return { accepted: false, ambiguous: false, message: "B2C payout amount must be a whole KSh amount." };
        }

        let accessToken;
        try {
            accessToken = await getB2cAccessToken();
        } catch (_) {
            return {
                accepted: false,
                ambiguous: false,
                message: "Daraja authentication failed. Your withdrawal was not sent."
            };
        }

        const payload = {
            OriginatorConversationID: details.originatorConversationId,
            InitiatorName: envValue("MPESA_B2C_INITIATOR_NAME"),
            SecurityCredential: envValue("MPESA_B2C_SECURITY_CREDENTIAL"),
            CommandID: envValue("MPESA_B2C_COMMAND_ID") || "BusinessPayment",
            Amount: amount,
            PartyA: envValue("MPESA_B2C_SHORTCODE"),
            PartyB: String(details.phone),
            Remarks: "GOALGAMBIT wallet withdrawal",
            QueueTimeOutURL: callbackUrl("timeout", details.callbackToken),
            ResultURL: callbackUrl("result", details.callbackToken),
            Occassion: "Wallet withdrawal " + details.reference.slice(-24)
        };

        let response;
        try {
            response = await daraja.fetchWithTimeout(
                b2cBaseUrl() + "/mpesa/b2c/v3/paymentrequest",
                {
                    method: "POST",
                    headers: {
                        Authorization: "Bearer " + accessToken,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                },
                20000
            );
        } catch (_) {
            await updateProviderState(details.reference, "unknown", null, details.walletType).catch(() => {});
            return {
                accepted: false,
                ambiguous: true,
                message: "Daraja’s reply was not received. The withdrawal is pending confirmation; do not submit it again."
            };
        }

        let data;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }

        if (!response.ok) {
            if (response.status >= 500 || response.status === 408 || response.status === 429 || !data) {
                await updateProviderState(details.reference, "unknown", null, details.walletType).catch(() => {});
                return {
                    accepted: false,
                    ambiguous: true,
                    message: "Daraja’s reply was not conclusive. The withdrawal is pending confirmation; do not submit it again."
                };
            }
            return {
                accepted: false,
                ambiguous: false,
                message: "Daraja rejected this withdrawal. The wallet will be restored."
            };
        }

        if (!data || String(data.ResponseCode) !== "0") {
            if (data && data.ResponseCode !== undefined) {
                return {
                    accepted: false,
                    ambiguous: false,
                    message: "Daraja rejected this withdrawal. The wallet will be restored."
                };
            }
            await updateProviderState(details.reference, "unknown", null, details.walletType).catch(() => {});
            return {
                accepted: false,
                ambiguous: true,
                message: "Daraja’s reply was not conclusive. The withdrawal is pending confirmation; do not submit it again."
            };
        }

        await updateProviderState(details.reference, "accepted", data, details.walletType);
        return { accepted: true, ambiguous: false };
    }

    router.post("/payout-result/:token", async (req, res) => {
        try {
            const result = await settleCallback(req.params.token, "result", req.body);
            if (!result.found) return res.status(404).json({ ResultCode: 1, ResultDesc: "Unknown callback." });
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        } catch (_) {
            return res.status(503).json({ ResultCode: 1, ResultDesc: "Callback settlement will be retried." });
        }
    });

    router.post("/payout-timeout/:token", async (req, res) => {
        try {
            const result = await settleCallback(req.params.token, "timeout", req.body);
            if (!result.found) return res.status(404).json({ ResultCode: 1, ResultDesc: "Unknown callback." });
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        } catch (_) {
            return res.status(503).json({ ResultCode: 1, ResultDesc: "Callback settlement will be retried." });
        }
    });

    return {
        router,
        isConfigured,
        configurationIssue,
        createCallbackToken,
        submitPayout,
        rejectPayout: async function(reference) {
            return finalize(reference, {
                success: false,
                resultCode: null,
                description: "Daraja rejected the payout request before processing it."
            });
        }
    };
}

module.exports = createMpesaB2c;
