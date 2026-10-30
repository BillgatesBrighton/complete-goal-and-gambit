# GOAL$GAMBIT email setup

Email verification and password recovery send through Gmail SMTP from the
official mailbox `goalgambitsupport@gmail.com`. The sender uses Nodemailer and
accepts only that mailbox as both the SMTP login and From address.

## Required private settings

Copy the mail settings from `.env.example` into the ignored `backend/.env`:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `SMTP_USERNAME=goalgambitsupport@gmail.com`
- `SMTP_APP_PASSWORD` (Google App Password, not the normal Gmail password)
- `EMAIL_FROM_NAME=GOAL$GAMBIT Support`
- `EMAIL_FROM_ADDRESS=goalgambitsupport@gmail.com`
- `EMAIL_VERIFICATION_FRONTEND_URL` (the trusted HTTPS verification page)
- `PASSWORD_RESET_FRONTEND_URL` (the trusted HTTPS reset page)

## Create a Gmail App Password

1. Sign in to the official Google account and enable 2-Step Verification.
2. Open Google Account → Security → App passwords. Google may not offer this
   option for some managed, protected, or Advanced Protection accounts.
3. Create an app password for GOAL$GAMBIT and put it directly in the private
   `backend/.env` file. Do not send it in chat, email, screenshots, or GitHub.
4. Restart the backend and run the mail connection check after configuration:
   `npm run email:check`
5. To send a plain delivery test to an inbox you control, run
   `npm run email:test -- your-address@example.com` and confirm the message
   arrived. This test does not create an account or send a reset link.

If Google does not offer App Passwords, use an email API with a verified
sender domain/address instead. The current implementation intentionally does
not silently switch providers or report delivery without configured Gmail SMTP.

The database migration is additive: new email columns are nullable for existing
accounts, and an email-verification token table stores only token hashes. Existing
users and account data are preserved. An account's new email becomes the active
verified address only after its one-time verification link is used.
