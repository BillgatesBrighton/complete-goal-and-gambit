"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const emailService = require("../services/emailService");

if (!emailService.isConfigured()) {
    console.error("Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USERNAME, SMTP_APP_PASSWORD, EMAIL_FROM_NAME, and EMAIL_FROM_ADDRESS in backend/.env.");
    process.exitCode = 1;
} else {
    emailService.verifyConnection().then(function() {
        console.log("Gmail SMTP connection verified. No email was sent.");
    }).catch(function() {
        console.error("Gmail SMTP connection failed. Check the App Password and Gmail security settings; no credentials were printed.");
        process.exitCode = 1;
    });
}
