"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const emailService = require("../services/emailService");

const recipient = String(process.argv[2] || "").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient) || recipient.length > 254) {
    console.error("Usage: npm run email:test -- address-you-control@example.com");
    process.exitCode = 2;
} else if (!emailService.isConfigured()) {
    console.error("Email is not configured. Set the required SMTP values in backend/.env first.");
    process.exitCode = 1;
} else {
    emailService.sendTestEmail(recipient).then(function() {
        console.log("Test email accepted by Gmail SMTP. Check the recipient inbox and spam folder.");
    }).catch(function() {
        console.error("Test email could not be sent. Check the App Password and Gmail settings; no credentials were printed.");
        process.exitCode = 1;
    });
}
