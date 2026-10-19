"use strict";

const express = require("express");
const crypto = require("crypto");
const daraja = require("../routes/mpesa");
const { recordJournal } = require("./financialLedger");

const MAX_C2B_AMOUNT = 1000000;
const router = express.Router();
let cachedC2bAccessToken = "";
let c2bAccessTokenExpiresAt = 0;
let pendingC2bTokenRequest = null;

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

function enabled() {
    return envValue("MPESA_C2B_ENABLED").toLowerCase() === "true";
}

function c2bConsumerCredentials() {
    return {
        key: envValue("MPESA_C2B_CONSUMER_KEY") || envValue("MPESA_CONSUMER_KEY"),
        secret: envValue("MPESA_C2B_CONSUMER_SECRET") || envValue("MPESA_CONSUMER_SECRET")
    };
}

async function getC2bAccessToken() {
    if (cachedC2bAccessToken && Date.now() < c2bAccessTokenExpiresAt) return cachedC2bAccessToken;
    if (pendingC2bTokenRequest) return pendingC2bTokenRequest;

    pendingC2bTokenRequest = (async function() {
        const credentials = c2bConsumerCredentials();
        if (!credentials.key || !credentials.secret) {
            throw new Error("C2B sandbox credentials are missing.");
        }
        const basic = Buffer.from(credentials.key + ":" + credentials.secret, "utf8").toString("base64");
        const response = await daraja.fetchWithTimeout(
            daraja.mpesaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials",
            {
                method: "GET",
                headers: { Authorization: "Basic " + basic }
            },
            12000
        );
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch (_) { body = {}; }
        if (!response.ok || !body.access_token) {
            throw new Error("Daraja did not issue a C2B access token.");
        }
        const expiresIn = Number(body.expires_in) || 3600;
        cachedC2bAccessToken = String(body.access_token);
        c2bAccessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
        return cachedC2bAccessToken;
    })();

    try {
        return await pendingC2bTokenRequest;
    } finally {
        pendingC2bTokenRequest = null;
    }
}

function signingSecret() {
    return envValue("MPESA_C2B_CALLBACK_SECRET") || envValue("JWT_SECRET");
}

function callbackToken() {
    const secret = signingSecret();
    if (secret.length < 32) return "";
    return crypto
        .createHmac("sha256", secret)
        .update("goal-gambit-c2b-callback-v1")
        .digest("base64url");
}

function constantTimeMatch(value, expected) {
    const supplied = Buffer.from(String(value || ""));
    const actual = Buffer.from(String(expected || ""));
    return supplied.length === actual.length && supplied.length > 0 &&
        crypto.timingSafeEqual(supplied, actual);
}

function publicBaseUrl() {
    const configured = envValue("PUBLIC_BASE_URL") ||
        (envValue("RENDER_EXTERNAL_HOSTNAME")
            ? "https://" + envValue("RENDER_EXTERNAL_HOSTNAME")
            : envValue("RENDER_EXTERNAL_URL"));
    if (!configured) return null;

    try {
        const url = new URL(configured);
        const host = url.hostname.toLowerCase();
        const privateHost = host === "localhost" || host.endsWith(".localhost") ||
            host.endsWith(".local") || host === "::1" || /^127\./.test(host) ||
            /^10\./.test(host) || /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (url.protocol !== "https:" || privateHost || url.username || url.password) return null;
        if (/(?:^|[./_-])(?:m-pesa|mpesa|safaricom|exe|exec|cmd|sql|query)(?:$|[./_-])/i.test(host)) return null;
        if (/(?:ngrok|trycloudflare|loca\.lt|localtunnel|mockbin|requestbin|serveo)/i.test(host)) return null;
        return url.origin;
    } catch (_) {
        return null;
    }
}

function callbackUrls() {
    const base = publicBaseUrl();
    const token = callbackToken();
    if (!base || !token) return null;
    return {
        confirmationUrl: base + "/api/payments/c2b-confirmation/" + token,
        validationUrl: base + "/api/payments/c2b-validation/" + token
    };
}

function shortcode() {
    const value = envValue("MPESA_C2B_SHORTCODE");
    return /^\d{5,7}$/.test(value) ? value : "";
}

function accountReference(userId) {
    const secret = signingSecret();
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0 || secret.length < 32) return "";
    const idPart = id.toString(36).toUpperCase();
    const mac = crypto.createHmac("sha256", secret)
        .update("goal-gambit-wallet-c2b-v1:" + id)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase();
    return "GG" + idPart + mac;
}

function accountIdFromReference(value) {
    const reference = String(value || "").trim().toUpperCase();
    const match = /^GG([0-9A-Z]{1,8})([A-F0-9]{8})$/.exec(reference);
    if (!match) return null;

    const id = parseInt(match[1], 36);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const expected = accountReference(id);
    return constantTimeMatch(reference, expected) ? id : null;
}

function parseAmount(value) {
    const text = String(value === undefined || value === null ? "" : value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [wholeText, fractionText = ""] = text.split(".");
    const whole = Number(wholeText);
    const cents = whole * 100 + Number(fractionText.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_C2B_AMOUNT * 100) return null;
    return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
}

function paymentFrom(body) {
    const transId = String(body && body.TransID || "").trim().toUpperCase();
    const receivedShortcode = String(body && body.BusinessShortCode || "").trim();
    const amount = parseAmount(body && body.TransAmount);
    const reference = String(body && body.BillRefNumber || "").trim().toUpperCase();

    if (!/^[A-Z0-9]{6,32}$/.test(transId)) return { error: "transaction" };
    if (!shortcode() || receivedShortcode !== shortcode()) return { error: "shortcode" };
    if (amount === null) return { error: "amount" };
    return { transId, receivedShortcode, amount, reference, userId: accountIdFromReference(reference) };
}

function validationResult(code, description) {
    return { ResultCode: code, ResultDesc: description };
}

function acknowledge(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
}

module.exports = function createMpesaC2b(pool, authenticateToken) {
    async function getInstructions(userId) {
        const result = await pool.query(
            "SELECT username FROM users WHERE id=$1 AND account_status='active'",
            [userId]
        );
        if (!result.rows.length) return null;

        const code = shortcode();
        const transactionType = envValue("MPESA_C2B_TRANSACTION_TYPE") || "CustomerPayBillOnline";
        const credentials = c2bConsumerCredentials();
        return {
            available: enabled() && Boolean(code) && Boolean(callbackUrls()) &&
                transactionType === "CustomerPayBillOnline" && Boolean(credentials.key) && Boolean(credentials.secret),
            enabled: enabled(),
            shortCode: code || null,
            transactionType,
            accountReference: accountReference(userId) || null,
            accountName: result.rows[0].username,
            callbacksMustBeRegistered: true
        };
    }

    router.post("/c2b-validation/:token", async (req, res) => {
        if (!constantTimeMatch(req.params.token, callbackToken())) {
            return res.status(404).json({ success: false });
        }
        const payment = paymentFrom(req.body || {});
        if (payment.error === "shortcode") {
            return res.json(validationResult("C2B00015", "Rejected"));
        }
        if (payment.error === "amount") {
            return res.json(validationResult("C2B00013", "Rejected"));
        }
        if (payment.error || !payment.userId) {
            return res.json(validationResult("C2B00012", "Rejected"));
        }

        try {
            const user = await pool.query(
                `SELECT u.id FROM users u
                 JOIN wallets w ON w.user_id=u.id
                 WHERE u.id=$1 AND u.account_status='active'`,
                [payment.userId]
            );
            if (!user.rows.length) {
                return res.json(validationResult("C2B00012", "Rejected"));
            }
            return res.json(validationResult("0", "Accepted"));
        } catch (_) {
            return res.json(validationResult("C2B00016", "Rejected"));
        }
    });

    router.post("/c2b-confirmation/:token", async (req, res) => {
        if (!constantTimeMatch(req.params.token, callbackToken())) {
            return res.status(404).json({ success: false });
        }

        const payment = paymentFrom(req.body || {});
        if (payment.error === "transaction" || payment.error === "shortcode") return acknowledge(res);
        if (payment.error === "amount") return acknowledge(res);

        let client;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            const inserted = await client.query(
                `INSERT INTO mpesa_c2b_payments
                    (transaction_id, business_shortcode, account_reference, amount, user_id, status, unmatched_reason)
                 VALUES ($1,$2,$3,$4,NULL,'unmatched',$5)
                 ON CONFLICT (transaction_id) DO NOTHING
                 RETURNING transaction_id`,
                [
                    payment.transId,
                    payment.receivedShortcode,
                    payment.reference.slice(0, 30),
                    payment.amount,
                    payment.userId ? "processing" : "unmapped_account"
                ]
            );

            if (!inserted.rows.length) {
                await client.query("COMMIT");
                return acknowledge(res);
            }

            if (!payment.userId) {
                await client.query("COMMIT");
                return acknowledge(res);
            }

            const user = await client.query(
                "SELECT id FROM users WHERE id=$1 AND account_status='active'",
                [payment.userId]
            );
            const wallet = user.rows.length
                ? await client.query("SELECT id FROM wallets WHERE user_id=$1 FOR UPDATE", [payment.userId])
                : { rows: [] };

            if (!user.rows.length || !wallet.rows.length) {
                await client.query(
                    `UPDATE mpesa_c2b_payments
                     SET unmatched_reason=$1 WHERE transaction_id=$2`,
                    [user.rows.length ? "wallet_missing" : "account_inactive", payment.transId]
                );
                await client.query("COMMIT");
                return acknowledge(res);
            }

            const transaction = await client.query(
                `INSERT INTO transactions
                    (user_id, transaction_type, amount, currency, status, reference, description)
                 VALUES ($1,'deposit',$2,'KES','completed',$3,'M-Pesa C2B deposit')
                 ON CONFLICT (reference) DO NOTHING
                 RETURNING id`,
                [payment.userId, payment.amount, "MPESAC2B-" + payment.transId]
            );

            if (!transaction.rows.length) {
                await client.query(
                    `UPDATE mpesa_c2b_payments
                     SET unmatched_reason='duplicate_wallet_reference' WHERE transaction_id=$1`,
                    [payment.transId]
                );
                await client.query("COMMIT");
                return acknowledge(res);
            }

            await client.query(
                "UPDATE wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2",
                [payment.amount, payment.userId]
            );
            await recordJournal(client, {
                reference: "MPESAC2B-" + payment.transId,
                transactionType: "verified_mpesa_deposit",
                amount: payment.amount,
                description: "Verified M-Pesa C2B receipt credited to player wallet",
                context: { userId: Number(payment.userId), providerTransactionId: payment.transId },
                postings: [
                    { accountType: "external_mpesa_float", accountId: null, debit: payment.amount },
                    { accountType: "user_wallet_available", accountId: Number(payment.userId), credit: payment.amount }
                ]
            });
            await client.query(
                `UPDATE mpesa_c2b_payments
                 SET user_id=$1, status='credited', unmatched_reason=NULL, processed_at=NOW()
                 WHERE transaction_id=$2`,
                [payment.userId, payment.transId]
            );
            await client.query("COMMIT");
            return acknowledge(res);
        } catch (_) {
            if (client) await client.query("ROLLBACK").catch(() => {});
            return res.status(503).json({ ResultCode: 1, ResultDesc: "Temporarily unavailable" });
        } finally {
            if (client) client.release();
        }
    });

    router.post("/c2b/register-urls", authenticateToken, async (req, res) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Administrator access is required." });
        }
        if (!enabled()) {
            return res.status(503).json({ success: false, message: "C2B deposits are disabled in backend/.env." });
        }
        if (envValue("MPESA_ENVIRONMENT").toLowerCase() !== "sandbox") {
            return res.status(403).json({ success: false, message: "This callback registration action is restricted to the Daraja sandbox." });
        }

        const code = shortcode();
        const urls = callbackUrls();
        const credentials = c2bConsumerCredentials();
        if (!code || !urls || !credentials.key || !credentials.secret) {
            return res.status(503).json({ success: false, message: "C2B sandbox configuration is incomplete. Check the app credentials, shortcode and public HTTPS base URL." });
        }

        const responseType = (envValue("MPESA_C2B_RESPONSE_TYPE") || "Completed").trim();
        if (!/^(Completed|Cancelled)$/.test(responseType)) {
            return res.status(400).json({ success: false, message: "MPESA_C2B_RESPONSE_TYPE must be Completed or Cancelled." });
        }

        try {
            const token = await getC2bAccessToken();
            const response = await daraja.fetchWithTimeout(
                daraja.mpesaBaseUrl() + "/mpesa/c2b/v2/registerurl",
                {
                    method: "POST",
                    headers: {
                        Authorization: "Bearer " + token,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        ShortCode: code,
                        ResponseType: responseType,
                        ConfirmationURL: urls.confirmationUrl,
                        ValidationURL: urls.validationUrl
                    })
                },
                15000
            );
            const text = await response.text();
            let provider;
            try { provider = JSON.parse(text); } catch (_) { provider = {}; }

            const providerCode = String(provider.ResponseCode || provider.errorCode || "");
            if (!response.ok || (providerCode && providerCode !== "0")) {
                return res.status(502).json({
                    success: false,
                    message: "Daraja did not accept the C2B callback registration. Confirm C2B is enabled on the same sandbox app as the backend credentials.",
                    providerCode: /^[A-Za-z0-9.]+$/.test(providerCode) ? providerCode : undefined
                });
            }

            return res.json({
                success: true,
                message: "Sandbox C2B callbacks registered. Run the C2B simulator once to confirm delivery.",
                providerCode: providerCode || "0"
            });
        } catch (_) {
            return res.status(502).json({ success: false, message: "Could not reach Daraja to register the C2B callbacks." });
        }
    });

    return {
        router,
        getInstructions,
        isEnabled: enabled
    };
};
