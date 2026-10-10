"use strict";

const PRODUCTION_URL = "https://api.africastalking.com/version1/messaging";
const SANDBOX_URL = "https://api.sandbox.africastalking.com/version1/messaging";

function getSettings() {
    const username = String(process.env.AFRICASTALKING_USERNAME || "").trim();
    const apiKey = String(process.env.AFRICASTALKING_API_KEY || "").trim();
    const environment = String(process.env.AFRICASTALKING_ENVIRONMENT || "production").trim().toLowerCase();
    const senderId = String(process.env.AFRICASTALKING_SENDER_ID || "").trim();
    return { username, apiKey, environment, senderId };
}

function isConfigured() {
    const settings = getSettings();
    return Boolean(settings.username && settings.apiKey && ["production", "sandbox"].includes(settings.environment));
}

async function sendSms(to, message) {
    const settings = getSettings();
    if (!settings.username || !settings.apiKey || !["production", "sandbox"].includes(settings.environment)) {
        throw new Error("AFRICASTALKING_NOT_CONFIGURED");
    }

    const form = new URLSearchParams({
        username: settings.username,
        to: String(to),
        message: String(message)
    });
    if (settings.senderId) form.set("from", settings.senderId);

    const response = await fetch(settings.environment === "sandbox" ? SANDBOX_URL : PRODUCTION_URL, {
        method: "POST",
        headers: {
            "apiKey": settings.apiKey,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000)
    });

    let result = null;
    try { result = await response.json(); } catch (error) {}
    const recipients = result && result.SMSMessageData && result.SMSMessageData.Recipients;
    const deliveredToGateway = Array.isArray(recipients) && recipients.some(function(recipient) {
        return Number(recipient.statusCode) === 101 || String(recipient.status || "").toLowerCase() === "success";
    });
    if (!response.ok || !deliveredToGateway) {
        throw new Error("AFRICASTALKING_SEND_FAILED");
    }
}

module.exports = { isConfigured, sendSms };
