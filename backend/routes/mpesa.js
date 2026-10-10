"use strict";

const express = require("express");

// Daraja responses contain phone numbers, callback payloads, and token metadata.
// Keep operational logs to constant labels; never dump request/response values.
const console = {
    log() {},
    error(label) {
        process.stderr.write(String(label || "Daraja request failed") + "\n");
    }
};

// ======================================================
// GOAL$GAMBIT M-PESA ROUTES
// ======================================================

function envValue(name) {
    let value = String(process.env[name] || "").trim();

    // A hosted Render web service can derive a stable public callback URL
    // from its injected URL. Local development can keep an explicit .env URL.
    if (name === "MPESA_CALLBACK_URL" && !value) {
        const publicBase = String(
            process.env.PUBLIC_BASE_URL ||
            (process.env.RENDER_EXTERNAL_HOSTNAME
                ? "https://" + process.env.RENDER_EXTERNAL_HOSTNAME
                : process.env.RENDER_EXTERNAL_URL || "")
        ).trim();

        if (publicBase) {
            try {
                const callback = new URL(publicBase);
                callback.pathname = "/api/payments/callback";
                callback.search = "";
                callback.hash = "";
                value = callback.toString();
            } catch (_) {}
        }
    }

    if (
        value.length >= 2 &&
        (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        )
    ) {
        value = value.slice(1, -1).trim();
    }

    // Keep older local .env files working while using a callback route that
    // avoids Safaricom's blocked "mpesa" URL keyword.
    if (name === "MPESA_CALLBACK_URL" && value) {
        try {
            const callback = new URL(value);
            callback.pathname = callback.pathname.replace(
                /\/api\/mpesa\/callback\/?$/i,
                "/api/payments/callback"
            );
            value = callback.toString();
        } catch (_) {}
    }

    return value;
}

// ======================================================
// NORMALIZE KENYAN PHONE NUMBER
// ======================================================

function normalizePhone(value) {
    let phone = String(value || "").replace(/\D/g, "");

    if (phone.startsWith("0")) {
        phone = "254" + phone.substring(1);
    }

    if (phone.startsWith("7") || phone.startsWith("1")) {
        phone = "254" + phone;
    }

    return phone;
}

// ======================================================
// ENVIRONMENT
// ======================================================

function isProduction() {
    return (
        envValue("MPESA_ENVIRONMENT").toLowerCase() ===
        "production"
    );
}

// ======================================================
// M-PESA BASE URL
// ======================================================

function mpesaBaseUrl() {
    if (isProduction()) {
        return "https://api.safaricom.co.ke";
    }

    return "https://sandbox.safaricom.co.ke";
}

function callbackUrlIssue(value) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { return "Set a valid public HTTPS callback URL."; }
    const host = parsed.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (parsed.protocol !== "https:" || privateHost) return "The callback must use a public HTTPS URL reachable by Safaricom.";
    if (!/\/api\/payments\/callback\/?$/i.test(parsed.pathname)) {
        return "Use the callback route /api/payments/callback on your public host.";
    }
    if (/(?:^|[./_-])(?:m-pesa|mpesa|safaricom|exe|exec|cmd|sql|query)(?:$|[./_-])/i.test(parsed.host + parsed.pathname)) {
        return "The callback URL contains a keyword Safaricom blocks. Use /api/payments/callback on your public host.";
    }
    if (/(?:ngrok|trycloudflare|loca\.lt|localtunnel|mockbin|requestbin|serveo)/i.test(host)) {
        return "Use a stable public HTTPS host you control; Safaricom may block temporary tunnel callback hosts.";
    }
    return null;
}

// ======================================================
// ACCESS TOKEN CACHE
// ======================================================

let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;
let pendingAccessTokenPromise = null;
let stkProductVerified = false;

async function fetchWithTimeout(url, options, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ======================================================
// GET M-PESA ACCESS TOKEN
// ======================================================

async function getAccessToken(forceRefresh = false) {

    // Daraja invalidates a previous token when it issues another one. Share
    // concurrent refreshes so simultaneous pushes don't invalidate each other.
    if (pendingAccessTokenPromise) {
        return pendingAccessTokenPromise;
    }

    if (
        !forceRefresh &&
        cachedAccessToken &&
        Date.now() < cachedTokenExpiresAt
    ) {
        console.log(
            "Using cached M-Pesa access token."
        );

        return cachedAccessToken;
    }

    pendingAccessTokenPromise = fetchNewAccessToken();
    try {
        return await pendingAccessTokenPromise;
    } finally {
        pendingAccessTokenPromise = null;
    }
}

async function fetchNewAccessToken() {

    const consumerKey =
        envValue("MPESA_CONSUMER_KEY");

    const consumerSecret =
        envValue("MPESA_CONSUMER_SECRET");

    if (!consumerKey) {
        throw new Error(
            "MPESA_CONSUMER_KEY is missing from .env"
        );
    }

    if (!consumerSecret) {
        throw new Error(
            "MPESA_CONSUMER_SECRET is missing from .env"
        );
    }

    const environment =
        isProduction()
            ? "production"
            : "sandbox";

    const oauthUrl =
        mpesaBaseUrl() +
        "/oauth/v1/generate?grant_type=client_credentials";

    console.log("");
    console.log("==============================================");
    console.log("GOAL$GAMBIT M-PESA OAUTH");
    console.log("==============================================");

    console.log(
        "Environment:",
        environment
    );

    console.log(
        "OAuth URL:",
        oauthUrl
    );

    console.log(
        "Consumer key loaded:",
        Boolean(consumerKey)
    );

    console.log(
        "Consumer secret loaded:",
        Boolean(consumerSecret)
    );

    console.log("==============================================");

    const basicCredentials =
        Buffer
            .from(
                consumerKey +
                ":" +
                consumerSecret,
                "utf8"
            )
            .toString("base64");

    let response;

    try {

        response =
            await fetchWithTimeout(
                oauthUrl,
                {
                    method: "GET",

                    headers: {
                        "Authorization":
                            "Basic " +
                            basicCredentials,

                        "Accept":
                            "application/json"
                    }
                }
            );

    } catch (error) {

        console.error(
            "M-Pesa OAuth network error:",
            error
        );

        throw new Error(
            "Could not connect to Safaricom OAuth: " +
            error.message
        );
    }

    const responseText =
        await response.text();

    console.log(
        "M-Pesa OAuth HTTP status:",
        response.status
    );

    console.log(
        "M-Pesa OAuth content-type:",
        response.headers.get(
            "content-type"
        ) || "[none]"
    );

    let data = {};

    if (responseText) {

        try {

            data =
                JSON.parse(
                    responseText
                );

        } catch (error) {

            console.log(
                "OAuth response was not JSON."
            );
        }
    }

    if (!response.ok) {

        throw new Error(
            "M-Pesa OAuth failed with HTTP " + response.status +
            (data.errorCode ? " (provider code " + String(data.errorCode).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) + ")" : ".")
        );
    }

    const accessToken =
        String(
            data.access_token || ""
        ).trim();

    if (!accessToken) {

        throw new Error(
            "Safaricom OAuth succeeded but no access token was returned."
        );
    }

    const expiresIn =
        Number(
            data.expires_in || 3599
        );

    cachedAccessToken =
        accessToken;

    cachedTokenExpiresAt =
        Date.now() +
        Math.max(
            expiresIn - 60,
            60
        ) *
        1000;

    console.log(
        "M-Pesa access token received successfully."
    );

    console.log(
        "Token expires in:",
        expiresIn
    );

    console.log(
        "=============================================="
    );

    return accessToken;
}

// ======================================================
// NAIROBI TIMESTAMP
// ======================================================

function getMpesaTimestamp() {

    const parts =
        new Intl.DateTimeFormat(
            "en-GB",
            {
                timeZone: "Africa/Nairobi",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23"
            }
        )
        .formatToParts(
            new Date()
        )
        .reduce(
            (result, part) => {
                result[part.type] =
                    part.value;

                return result;
            },
            {}
        );

    return (
        parts.year +
        parts.month +
        parts.day +
        parts.hour +
        parts.minute +
        parts.second
    );
}

// Map only known, non-sensitive Daraja descriptions into user-facing hints.
// Never echo a raw provider response, which could contain request details.
function safeStkProviderHint(data) {
    const descriptions = [
        data && data.errorMessage,
        data && data.error_description,
        data && data.message,
        data && data.error
    ].filter(value => typeof value === "string").join(" ").toLowerCase();

    if (/merchant.?validate|merchant validation|wrong credentials/.test(descriptions)) {
        return "Daraja reports merchant validation failed. Check that the sandbox shortcode and Lipa na M-Pesa passkey match, and that the OAuth keys belong to this same app.";
    }

    if (/transaction.{0,40}(being processed|still processing|in progress)|in process/.test(descriptions)) {
        return "Daraja reports a transaction is still processing. Check the phone and wait for it to clear before trying again.";
    }

    if (/merchant does not exist|insufficient funds/.test(descriptions)) {
        return "Daraja could not validate the merchant. Check the shortcode, matching Lipa na M-Pesa passkey, and sandbox app configuration.";
    }

    return "";
}

// ======================================================
// SEND STK PUSH
// ======================================================

async function sendStkPush({
    accessToken,
    shortcode,
    passkey,
    transactionType,
    amount,
    phone,
    callbackUrl
}) {

    const stkUrl =
        mpesaBaseUrl() +
        "/mpesa/stkpush/v1/processrequest";

    const timestamp =
        getMpesaTimestamp();

    // --------------------------------------------------
    // GENERATE PASSWORD
    // --------------------------------------------------

    const password =
        Buffer
            .from(
                shortcode +
                passkey +
                timestamp,
                "utf8"
            )
            .toString("base64");

    // --------------------------------------------------
    // STK REQUEST BODY
    // --------------------------------------------------

    const requestBody = {

        BusinessShortCode:
            shortcode,

        Password:
            password,

        Timestamp:
            timestamp,

        TransactionType:
            transactionType,

        Amount:
            Math.floor(amount),

        PartyA:
            phone,

        PartyB:
            shortcode,

        PhoneNumber:
            phone,

        CallBackURL:
            callbackUrl,

        AccountReference:
            "GOALSGAMBIT",

        TransactionDesc:
            "Wallet deposit"
    };

    console.log("");
    console.log("==============================================");
    console.log("GOAL$GAMBIT M-PESA STK PUSH");
    console.log("==============================================");

    console.log(
        "Environment:",
        isProduction()
            ? "production"
            : "sandbox"
    );

    console.log(
        "STK URL:",
        stkUrl
    );

    console.log(
        "Transaction type:",
        transactionType
    );

    console.log("==============================================");

    let response;

    try {

        response =
            await fetchWithTimeout(
                stkUrl,
                {
                    method: "POST",

                    headers: {
                        "Authorization":
                            "Bearer " +
                            accessToken,

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"
                    },

                    body:
                        JSON.stringify(
                            requestBody
                        )
                }
            );

    } catch (error) {

        console.error(
            "M-Pesa STK network error:",
            error
        );

        throw new Error(
            "Could not connect to Safaricom STK Push: " +
            error.message
        );
    }

    const responseText =
        await response.text();

    console.log(
        "M-Pesa STK HTTP status:",
        response.status
    );

    console.log(
        "M-Pesa STK content-type:",
        response.headers.get(
            "content-type"
        ) || "[none]"
    );

    let data = {};

    if (responseText) {

        try {

            data =
                JSON.parse(
                    responseText
                );

        } catch (error) {

            console.log(
                "STK response was not JSON."
            );
        }
    }

    // --------------------------------------------------
    // INVALID TOKEN
    // --------------------------------------------------

    if (
        response.status === 401 ||
        (
            response.status === 404 &&
            (
                responseText.includes(
                    "Invalid Access Token"
                ) ||
                data.errorCode ===
                "404.001.03"
            )
        )
    ) {

        // Let the route refresh and retry exactly once after an explicit
        // invalid-token response. Keeping retry logic in one place avoids
        // sending duplicate STK requests.
        const providerCode = String(data.errorCode || data.error || "")
            .replace(/[^A-Za-z0-9._-]/g, "")
            .slice(0, 48);
        const environment = isProduction() ? "production" : "sandbox";
        const error = new Error(
            "Daraja authenticated OAuth but rejected the STK access token." +
            (providerCode ? " Provider code: " + providerCode + "." : "") +
            " Confirm M-Pesa Express is enabled on the selected " + environment + " app and that the credentials and shortcode belong to that same environment and app."
        );

        error.mpesaStatus =
            response.status;

        error.providerCode = providerCode;

        error.invalidToken =
            true;

        throw error;
    }

    // --------------------------------------------------
    // OTHER ERRORS
    // --------------------------------------------------

    if (!response.ok) {

        const providerCode = String(data.errorCode || data.error || "")
            .replace(/[^A-Za-z0-9._-]/g, "")
            .slice(0, 48);
        const providerHint = safeStkProviderHint(data);
        const genericHint = providerCode === "500.001.1001"
            ? "Daraja's description was unavailable. This code can indicate merchant validation or an in-progress request; verify the sandbox shortcode/passkey pair and avoid retrying while a prompt may still be open."
            : "";

        const error =
            new Error(
                "M-Pesa STK Push failed with HTTP " + response.status +
                (providerCode ? " (provider code " + providerCode + ")." : ".") +
                (providerHint || genericHint ? " " + (providerHint || genericHint) : "")
            );

        error.mpesaStatus =
            response.status;

        throw error;
    }

    return data;
}

// ======================================================
// ROUTES
// ======================================================

module.exports = function (
    pool,
    authenticateToken
) {

    const router =
        express.Router();

    router.get("/connectivity", authenticateToken, async (req, res) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ success:false, message:"Administrator access is required." });
        }
        const required = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"];
        const missing = required.filter(name => !envValue(name));
        if (missing.length) {
            return res.status(503).json({ success:false, oauthConnected:false, configurationReady:false, readyForStk:false, stkProductVerified:false, missing, message:"Daraja configuration is incomplete." });
        }
        const callbackIssue = callbackUrlIssue(envValue("MPESA_CALLBACK_URL"));
        const sandboxShortcodeMatches = isProduction() || envValue("MPESA_SHORTCODE") === "174379";
        const transactionType = envValue("MPESA_TRANSACTION_TYPE") || "CustomerPayBillOnline";
        const transactionTypeSupported = ["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(transactionType);
        const baseConfigReady = !callbackIssue && sandboxShortcodeMatches && transactionTypeSupported;
        try {
            await getAccessToken();
            return res.json({
                success:true,
                oauthConnected:true,
                configurationReady:baseConfigReady,
                // OAuth cannot prove that this Daraja app has M-Pesa Express
                // access. Only an actual provider-accepted STK request can.
                readyForStk:baseConfigReady && stkProductVerified,
                stkProductVerified,
                environment:isProduction() ? "production" : "sandbox",
                callbackReady:!callbackIssue,
                sandboxShortcodeMatches,
                transactionTypeSupported,
                callbackMessage:callbackIssue,
                message:!baseConfigReady
                    ? (callbackIssue || "OAuth works, but the STK shortcode or transaction type does not match the selected environment.")
                    : stkProductVerified
                        ? "OAuth, local configuration, and M-Pesa Express access passed an earlier STK request."
                        : "OAuth and local configuration passed. Confirm M-Pesa Express is added to this Daraja app; the OAuth check does not verify product access."
            });
        } catch (_) {
            return res.status(503).json({
                success:false,
                oauthConnected:false,
                configurationReady:false,
                readyForStk:false,
                stkProductVerified:false,
                environment:isProduction() ? "production" : "sandbox",
                callbackReady:!callbackIssue,
                sandboxShortcodeMatches,
                transactionTypeSupported,
                callbackMessage:callbackIssue,
                message:"Could not authenticate with Daraja. Check the consumer credentials and environment settings."
            });
        }
    });

    // ==================================================
    // STK PUSH
    // ==================================================

    router.post(
        "/stk-push",
        authenticateToken,

        async (req, res) => {

            try {

                console.log("");
                console.log(
                    "========== STK PUSH REQUEST =========="
                );

                const amount =
                    Number(
                        req.body &&
                        req.body.amount
                    );

                const phone =
                    normalizePhone(
                        req.body &&
                        req.body.phone
                    );

                // ------------------------------------------
                // VALIDATE AMOUNT
                // ------------------------------------------

                if (
                    !Number.isFinite(amount) ||
                    !Number.isSafeInteger(amount) ||
                    amount < 1
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Valid amount is required."
                    });
                }

                // ------------------------------------------
                // VALIDATE PHONE
                // ------------------------------------------

                if (
                    !/^254\d{9}$/.test(phone)
                ) {

                    return res.status(400).json({

                        success:
                            false,

                        message:
                            "Valid Kenyan phone number is required."
                    });
                }

                // ------------------------------------------
                // LOAD M-PESA CONFIG
                // ------------------------------------------

                const shortcode =
                    envValue(
                        "MPESA_SHORTCODE"
                    );

                const passkey =
                    envValue(
                        "MPESA_PASSKEY"
                    );

                const callbackUrl =
                    envValue(
                        "MPESA_CALLBACK_URL"
                    );

                const transactionType =
                    envValue(
                        "MPESA_TRANSACTION_TYPE"
                    ) ||
                    "CustomerPayBillOnline";

                if (!["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(transactionType)) {
                    return res.status(503).json({
                        success: false,
                        message: "MPESA_TRANSACTION_TYPE must be CustomerPayBillOnline or CustomerBuyGoodsOnline."
                    });
                }

                if (!shortcode) {

                    throw new Error(
                        "MPESA_SHORTCODE is missing from .env"
                    );
                }

                if (!isProduction() && shortcode !== "174379") {
                    return res.status(503).json({
                        success: false,
                        message: "Sandbox Lipa na M-Pesa Online requires shortcode 174379 and its matching sandbox passkey."
                    });
                }

                if (!passkey) {

                    throw new Error(
                        "MPESA_PASSKEY is missing from .env"
                    );
                }

                if (!callbackUrl) {

                    throw new Error(
                        "MPESA_CALLBACK_URL is missing from .env"
                    );
                }

                const callbackIssue = callbackUrlIssue(callbackUrl);
                if (callbackIssue) {
                    return res.status(503).json({ success:false, message:callbackIssue });
                }

                // ------------------------------------------
                // GET ACCESS TOKEN
                // ------------------------------------------

                let accessToken;

                try {

                    accessToken =
                        await getAccessToken();

                } catch (error) {

                    console.error(
                        "M-Pesa OAuth error:",
                        error
                    );

                    throw error;
                }

                // ------------------------------------------
                // SEND STK PUSH
                // ------------------------------------------

                let stkResponse;

                try {

                    stkResponse =
                        await sendStkPush({

                            accessToken:
                                accessToken,

                            shortcode:
                                shortcode,

                            passkey:
                                passkey,

                            transactionType:
                                transactionType,

                            amount:
                                amount,

                            phone:
                                phone,

                            callbackUrl:
                                callbackUrl
                        });

                } catch (error) {

                    // --------------------------------------
                    // REFRESH TOKEN ON TOKEN ERROR
                    // --------------------------------------

                    if (
                        error.invalidToken === true
                    ) {

                        console.log(
                            "Access token rejected. Refreshing token and retrying STK once..."
                        );

                        cachedAccessToken =
                            null;

                        cachedTokenExpiresAt =
                            0;

                        const freshToken =
                            await getAccessToken(
                                true
                            );

                        try {
                            stkResponse =
                                await sendStkPush({

                                    accessToken:
                                        freshToken,

                                    shortcode:
                                        shortcode,

                                    passkey:
                                        passkey,

                                    transactionType:
                                        transactionType,

                                    amount:
                                        amount,

                                    phone:
                                        phone,

                                    callbackUrl:
                                        callbackUrl
                                });
                        } catch (retryError) {
                            if (retryError.invalidToken === true) {
                                const error = new Error(
                                    "Daraja also rejected a freshly issued access token for STK Push" +
                                    (retryError.mpesaStatus ? " (HTTP " + retryError.mpesaStatus + ")" : "") +
                                    (retryError.providerCode ? " with provider code " + retryError.providerCode : "") +
                                    ". Check that the consumer key and secret belong to the same Daraja app and environment as the STK settings, and that M-Pesa Express is enabled for that app. This is a Daraja access error; the callback URL is not reached until STK is accepted."
                                );
                                error.mpesaStatus = retryError.mpesaStatus;
                                error.upstreamFailure = true;
                                throw error;
                            }
                            throw retryError;
                        }

                    } else {

                        throw error;
                    }
                }

                // ------------------------------------------
                // CHECK RESPONSE CODE
                // ------------------------------------------

                if (
                    stkResponse.ResponseCode !==
                    undefined &&
                    String(
                        stkResponse.ResponseCode
                    ) !== "0"
                ) {

                    return res.status(502).json({

                        success:
                            false,

                        message:
                            stkResponse.ResponseDescription ||
                            "M-Pesa rejected the STK Push.",

                        data:
                            stkResponse
                    });
                }

                // ------------------------------------------
                // CHECK CHECKOUT REQUEST ID
                // ------------------------------------------

                if (
                    !stkResponse.CheckoutRequestID
                ) {

                    return res.status(502).json({

                        success:
                            false,

                        message:
                            "M-Pesa did not return a CheckoutRequestID.",

                        data:
                            stkResponse
                    });
                }

                // A provider-accepted checkout proves this app can use STK.
                stkProductVerified = true;

                // ------------------------------------------
                // TRANSACTION REFERENCE
                // ------------------------------------------

                const reference =
                    "MPESA-" +
                    stkResponse.CheckoutRequestID;

                // ------------------------------------------
                // SAVE PENDING TRANSACTION
                // ------------------------------------------

                const insertSQL = `
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
                        'deposit',
                        $2,
                        'KES',
                        'pending',
                        $3,
                        'M-Pesa STK Push deposit'
                    )
                `;

                await pool.query(
                    insertSQL,
                    [
                        req.user.userId,
                        amount,
                        reference
                    ]
                );

                console.log(
                    "Pending transaction saved:",
                    reference
                );

                // ------------------------------------------
                // RETURN SUCCESS
                // ------------------------------------------

                return res.json({

                    success:
                        true,

                    message:
                        stkResponse.CustomerMessage ||
                        "STK Push sent to your phone.",

                    checkoutRequestId:
                        stkResponse.CheckoutRequestID,

                    merchantRequestId:
                        stkResponse.MerchantRequestID
                });

            } catch (error) {

                console.error(
                    "M-Pesa STK Push ERROR:",
                    error
                );

                return res.status(error.upstreamFailure || error.mpesaStatus ? 502 : 500).json({

                    success:
                        false,

                    message:
                        error.message
                });
            }
        }
    );

    // ==================================================
    // M-PESA CALLBACK
    // ==================================================

    router.post(
        "/callback",

        async (req, res) => {

            try {

                console.log("");
                console.log(
                    "========== M-PESA CALLBACK =========="
                );

                const callback =
                    req.body &&
                    req.body.Body &&
                    req.body.Body.stkCallback;

                if (!callback) {

                    console.log(
                        "No stkCallback found."
                    );

                    return res.json({

                        ResultCode:
                            0,

                        ResultDesc:
                            "Accepted"
                    });
                }

                const checkoutRequestId =
                    callback.CheckoutRequestID;

                const reference =
                    "MPESA-" +
                    checkoutRequestId;

                console.log(
                    "CheckoutRequestID:",
                    checkoutRequestId
                );

                console.log(
                    "ResultCode:",
                    callback.ResultCode
                );

                console.log(
                    "ResultDesc:",
                    callback.ResultDesc
                );

                // ------------------------------------------
                // FIND TRANSACTION
                // ------------------------------------------

                const transactionResult =
                    await pool.query(
                        `
                        SELECT *
                        FROM transactions
                        WHERE reference = $1
                        LIMIT 1
                        `,
                        [
                            reference
                        ]
                    );

                if (
                    transactionResult.rows.length === 0
                ) {

                    console.log(
                        "Transaction not found:",
                        reference
                    );

                    return res.json({

                        ResultCode:
                            0,

                        ResultDesc:
                            "Accepted"
                    });
                }

                // ==================================================
                // SUCCESSFUL PAYMENT
                // ==================================================

                if (
                    String(
                        callback.ResultCode
                    ) === "0"
                ) {

                    const metadata =
                        callback.CallbackMetadata &&
                        Array.isArray(
                            callback.CallbackMetadata.Item
                        )
                            ? callback.CallbackMetadata.Item
                            : [];

                    const receiptItem =
                        metadata.find(
                            item =>
                                item.Name ===
                                "MpesaReceiptNumber"
                        );

                    const receipt =
                        receiptItem
                            ? receiptItem.Value
                            : null;

                    const client =
                        await pool.connect();

                    try {

                        await client.query(
                            "BEGIN"
                        );

                        // ------------------------------------------
                        // LOCK TRANSACTION
                        // ------------------------------------------

                        const lockedResult =
                            await client.query(
                                `
                                SELECT *
                                FROM transactions
                                WHERE reference = $1
                                FOR UPDATE
                                `,
                                [
                                    reference
                                ]
                            );

                        const transaction =
                            lockedResult.rows[0];

                        if (!transaction) {

                            await client.query(
                                "COMMIT"
                            );

                            return res.json({

                                ResultCode:
                                    0,

                                ResultDesc:
                                    "Accepted"
                            });
                        }

                        // ------------------------------------------
                        // PREVENT DOUBLE CREDIT
                        // ------------------------------------------

                        if (
                            transaction.status ===
                            "completed"
                        ) {

                            await client.query(
                                "COMMIT"
                            );

                            console.log(
                                "Transaction already completed:",
                                reference
                            );

                            return res.json({

                                ResultCode:
                                    0,

                                ResultDesc:
                                    "Accepted"
                            });
                        }

                        const userId =
                            transaction.user_id;

                        const amount =
                            Number(
                                transaction.amount
                            );

                        // ------------------------------------------
                        // CREDIT WALLET
                        // ------------------------------------------

                        const walletResult =
                            await client.query(
                                `
                                UPDATE wallets
                                SET
                                    balance =
                                        balance + $1,
                                    updated_at =
                                        NOW()
                                WHERE user_id = $2
                                RETURNING balance
                                `,
                                [
                                    amount,
                                    userId
                                ]
                            );

                        if (
                            walletResult.rowCount === 0
                        ) {

                            throw new Error(
                                "Wallet not found for user " +
                                userId
                            );
                        }

                        // ------------------------------------------
                        // COMPLETE TRANSACTION
                        // ------------------------------------------

                        const description =
                            receipt
                                ? "M-Pesa deposit - Receipt " +
                                  receipt
                                : "M-Pesa deposit completed";

                        await client.query(
                            `
                            UPDATE transactions
                            SET
                                status = 'completed',
                                description = $1
                            WHERE reference = $2
                            `,
                            [
                                description,
                                reference
                            ]
                        );

                        await client.query(
                            "COMMIT"
                        );

                        console.log(
                            "=============================================="
                        );

                        console.log(
                            "M-PESA PAYMENT SUCCESS"
                        );

                        console.log(
                            "User:",
                            userId
                        );

                        console.log(
                            "Amount credited:",
                            amount
                        );

                        console.log(
                            "Receipt:",
                            receipt || "N/A"
                        );

                        console.log(
                            "New wallet balance:",
                            walletResult.rows[0].balance
                        );

                        console.log(
                            "=============================================="
                        );

                    } catch (error) {

                        try {
                            await client.query(
                                "ROLLBACK"
                            );
                        } catch (_) {}

                        throw error;

                    } finally {

                        client.release();
                    }

                } else {

                    // ==================================================
                    // FAILED / CANCELLED PAYMENT
                    // ==================================================

                    await pool.query(
                        `
                        UPDATE transactions
                        SET
                            status = 'failed',
                            description = $1
                        WHERE reference = $2
                        `,
                        [
                            callback.ResultDesc ||
                            "M-Pesa payment failed",

                            reference
                        ]
                    );

                    console.log(
                        "M-Pesa payment failed:",
                        reference
                    );

                    console.log(
                        "Reason:",
                        callback.ResultDesc ||
                        "Unknown"
                    );
                }

                // ------------------------------------------
                // ACKNOWLEDGE SAFARICOM
                // ------------------------------------------

                return res.json({

                    ResultCode:
                        0,

                    ResultDesc:
                        "Accepted"
                });

            } catch (error) {

                console.error(
                    "M-Pesa callback error:",
                    error
                );

                return res.json({

                    ResultCode:
                        0,

                    ResultDesc:
                        "Accepted"
                });
            }
        }
    );

    // ==================================================
    // RETURN ROUTER
    // ==================================================

    return router;
};

// Shared internally with the B2C payout service so both M-Pesa flows use one
// OAuth cache and the same environment-specific Daraja host.
module.exports.getAccessToken = getAccessToken;
module.exports.mpesaBaseUrl = mpesaBaseUrl;
module.exports.fetchWithTimeout = fetchWithTimeout;
