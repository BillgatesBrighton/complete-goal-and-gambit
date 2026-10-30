"use strict";

const nodemailer = require("nodemailer");

const OFFICIAL_SENDER = "goalgambitsupport@gmail.com";
let cachedTransport = null;
let cachedTransportKey = "";

function settings() {
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")).trim().toLowerCase() === "true";
    return {
        host: String(process.env.SMTP_HOST || "smtp.gmail.com").trim().toLowerCase(),
        port,
        secure,
        username: String(process.env.SMTP_USERNAME || "").trim().toLowerCase(),
        password: String(process.env.SMTP_APP_PASSWORD || "").replace(/\s+/g, ""),
        fromName: String(process.env.EMAIL_FROM_NAME || "GOAL$GAMBIT Support").trim(),
        fromAddress: String(process.env.EMAIL_FROM_ADDRESS || OFFICIAL_SENDER).trim().toLowerCase()
    };
}

function isConfigured() {
    const config = settings();
    return config.host === "smtp.gmail.com" &&
        [465, 587].includes(config.port) &&
        config.secure === (config.port === 465) &&
        config.username === OFFICIAL_SENDER &&
        config.fromAddress === OFFICIAL_SENDER &&
        Boolean(config.password) &&
        Boolean(config.fromName);
}

function transport() {
    const config = settings();
    if (!isConfigured()) throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
    const key = [config.host, config.port, config.secure, config.username, config.password].join("\n");
    if (cachedTransport && cachedTransportKey === key) return { client: cachedTransport, config };
    if (cachedTransport) cachedTransport.close();
    cachedTransport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.secure,
        auth: { user: config.username, pass: config.password },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });
    cachedTransportKey = key;
    return { client: cachedTransport, config };
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function(character) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
    });
}

function template(title, greeting, message, link, buttonLabel, expiryNote) {
    const safeGreeting = escapeHtml(greeting || "player");
    const safeMessage = escapeHtml(message);
    const safeLink = escapeHtml(link);
    const safeButton = escapeHtml(buttonLabel);
    const safeTitle = escapeHtml(title);
    const linkMarkup = link
        ? `<p style="margin:26px 0"><a href="${safeLink}" style="display:inline-block;padding:13px 20px;border-radius:9px;background:#f4bd20;color:#111;text-decoration:none;font-weight:800">${safeButton}</a></p><p style="font-size:12px;color:#777;line-height:1.5">If the button does not work, copy this link into your browser:<br><span style="overflow-wrap:anywhere">${safeLink}</span></p>`
        : "";
    return `<!doctype html><html><body style="margin:0;background:#090909;color:#f4f1e8;font-family:Arial,sans-serif"><div style="max-width:600px;margin:24px auto;padding:28px 22px;background:#111;border:1px solid #463a16;border-radius:16px"><div style="color:#f4bd20;font-size:22px;font-weight:800;letter-spacing:1px">GOAL$GAMBIT</div><h1 style="color:#f4bd20;font-size:22px;margin:26px 0 14px">${safeTitle}</h1><p style="font-size:16px;line-height:1.6">Hello ${safeGreeting},</p><p style="font-size:16px;line-height:1.6">${safeMessage}</p>${linkMarkup}<p style="font-size:13px;color:#aaa;line-height:1.5">${escapeHtml(expiryNote)} If you did not request this, you can ignore this email.</p><hr style="border:0;border-top:1px solid #333;margin:24px 0"><p style="font-size:12px;color:#999">GOAL$GAMBIT Support · ${OFFICIAL_SENDER}</p></div></body></html>`;
}

async function send(to, subject, title, greeting, message, link, buttonLabel, expiryNote) {
    const { client, config } = transport();
    const safeMessage = String(message || "");
    const safeLink = String(link || "");
    await client.sendMail({
        from: { name: config.fromName, address: config.fromAddress },
        to: String(to),
        subject: subject,
        text: `GOAL$GAMBIT\n\n${title}\n\nHello ${greeting || "player"},\n${safeMessage}${safeLink ? "\n\n" + buttonLabel + ": " + safeLink : ""}\n\n${expiryNote} If you did not request this, ignore this email.\n\nGOAL$GAMBIT Support · ${OFFICIAL_SENDER}`,
        html: template(title, greeting, message, link, buttonLabel, expiryNote)
    });
}

async function verifyConnection() {
    const { client } = transport();
    return client.verify();
}

module.exports = {
    isConfigured,
    verifyConnection,
    sendVerificationEmail: (to, greeting, link) => send(to, "Verify your GOAL$GAMBIT email", "Verify your email address", greeting, "Confirm that this email address belongs to you and secure your GOAL$GAMBIT account.", link, "Verify email", "This link expires in 30 minutes."),
    sendPasswordRecoveryEmail: (to, greeting, link) => send(to, "GOAL$GAMBIT password reset", "Reset your password", greeting, "A password reset was requested for your account. Use this one-time link to choose a new password.", link, "Reset password", "This link expires in 30 minutes."),
    sendPasswordChangedNotice: (to, greeting) => send(to, "GOAL$GAMBIT password changed", "Your password was changed", greeting, "The password for your GOAL$GAMBIT account was changed. If you did not make this change, contact support immediately.", "", "", "This notice does not contain a reset link."),
    sendEmailChangedNotice: (to, greeting, newEmail) => send(to, "GOAL$GAMBIT email address changed", "Your account email was changed", greeting, "The verified email address on your account was changed to " + newEmail + ". If you did not make this change, contact support immediately.", "", "", "This notice does not contain a verification link."),
    sendTestEmail: (to) => send(to, "GOAL$GAMBIT email delivery test", "Email delivery test", "there", "This is a test of the GOAL$GAMBIT email sender. No account action is required.", "", "", "This message contains no password or reset link.")
};
