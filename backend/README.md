# GOAL$GAMBIT backend (private)

This backend runs on the Windows PC that stores the PostgreSQL database. The
public GitHub Pages site can use it through a stable HTTPS address; the database
port itself must stay private.

## Start it on the PC

1. Make sure PostgreSQL is running on this PC and the existing environment file
   has the database settings. The launcher reads `backend\.env` when present,
   otherwise it reads the Desktop `.env`.
2. Run `start-local.cmd` from this folder. It installs the locked Node packages
   if needed, applies the existing schema migrations, and starts the API on
   `127.0.0.1:5000`.
3. Check `http://127.0.0.1:5000/api/health` for a connected database. Open the
   local app at `http://127.0.0.1:5000/`.

The launcher forces production CORS behavior and disables test wallet deposits
while the PC API is public. Do not expose PostgreSQL port 5432.

## Give the public site a stable HTTPS route without buying a domain

Tailscale Funnel can publish the local API at a stable `https://…ts.net` URL
without router port forwarding. Install Tailscale for Windows, sign in, enable
Funnel in the tailnet admin settings, then run `start-online.cmd`. It configures
Funnel, keeps the public URL in the launcher's process environment, and starts
the API without rewriting either environment file. Configure `.env.webpush`
as described below. If the local backend is already running, stop its window
with Ctrl+C first.

Keep the PC online and the backend process running. Anyone with that URL can
reach the API, so share only the website URL. Funnel exposes the API, never the
database port. Safaricom must accept the generated hostname; if it rejects it,
use a domain you control with a named HTTPS tunnel instead.

The public frontend is configured for the existing Funnel hostname in
`frontend/js/api.js`. If that hostname changes, update and republish that
frontend setting.

## Web Push match notifications and eFootball room-code flow

The backend uses the existing PostgreSQL database and authenticated account
identity for multi-device Web Push. Additions to `schema.sql` create
`push_subscriptions`, `push_notification_events`, `push_delivery_jobs`,
`push_delivery_attempts`, and the receiver-confirmation columns on
`efootball_matches`. The startup migration is additive and safe to rerun; it
does not drop existing accounts, wallet balances, or match history.

Install/update dependencies with `npm ci`. Configure backend Web Push keys in
the ignored `backend/.env.webpush` file (a placeholder is in
`backend/webpush.env.example`):

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (a real contact email or HTTPS site URL)

Generate a pair locally from this directory with
`node -e "const w=require('web-push'); console.log(JSON.stringify(w.generateVAPIDKeys()))"`.
Keep the generated private key out of source control and chat. The public key is
served to the browser from `GET /api/push/vapid-public-key`. The online launcher
sets `PUBLIC_BASE_URL` in its process environment to its current HTTPS Funnel
origin; it does not rewrite the existing `.env`.

The signed-in frontend asks before requesting browser permission. After the
player chooses Enable, it registers the shared service worker, saves that
device's Push API subscription against the authenticated user, and verifies the
backend status. Each browser/device has its own subscription. A match-pairing
transaction queues an idempotent event only for the assigned sender. Code
submission queues a generic alert to the receiver (the code is never included
in push payloads); the receiver reads it from the authorized match endpoint and
confirms receipt. If the code is wrong, the receiver can explicitly request a
replacement; only the original sender can then submit the new code. That
increments the code revision and resets receipt/readiness before play. The
sender receives a separate receipt alert for the current revision. Both players
must confirm readiness before the Results page accepts scores.

Useful endpoints (all private endpoints require the existing bearer token):

- `GET /api/push/vapid-public-key` (public application-server key only)
- `GET /api/push/status`, `GET /api/push/history`
- `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions`
- `POST /api/push/test`, `POST /api/push/click` (click uses an event HMAC)
- `POST /api/efootball/matches/:id/code-correction` (receiver-only before play)
- `POST /api/efootball/matches/:id/code-received`

Delivery history distinguishes queued, push-service accepted, and failed. An
accepted response does not prove that a phone displayed a notification. HTTP
404/410 push responses deactivate expired subscriptions; transient provider
errors retry with backoff. Run automated checks with `npm test`; test the
physical notification and two-account workflow separately on supported HTTPS
devices.

Android Chrome supports Web Push on HTTPS. iOS/iPadOS 16.4 or newer requires
adding the site to the Home Screen and enabling permission from the installed
web app. Browser permission, operating-system settings, connectivity, and
battery policies can affect delivery.

For troubleshooting, check `GET /api/health` for database connectivity and
`GET /api/push/vapid-public-key` for `configured: true` (the response includes
only the public key). In Notification Settings, verify this device is registered
and inspect the delivery history. A 404/410 provider response means that device
subscription was expired and deactivated; re-enable notifications on that
device. For an unreachable public site, check `tailscale funnel status`, the
HTTPS URL shown by the online launcher, and the matching frontend API hostname.

## Native Android companion with notification reply

The optional source project in `../android` uses Firebase Cloud Messaging
(FCM). FCM data messages let the app create a normal Android notification with
a `RemoteInput` action, so the room-code sender can submit the code from the
notification while eFootball remains open. Android direct reply is available
from Android 7.0 (API 24), which is the app's minimum SDK. Android 13+ also
requires the user to grant notification permission. The notification contains
no room code before submission. This does not use a floating bubble, pop a
heads-up banner over eFootball, or ask for overlay permission.

Standard Web Push notifications do not provide a custom inline text field.
Supported browsers may show an `ENTER CODE` action button; activating it (or
tapping the notification body) opens the authenticated, match-specific Match
Room page with the existing sender code form opened and focused. On iPhone and
iPad, Web Push requires a Home Screen web app on iOS/iPadOS 16.4 or later;
Safari on macOS supports Web Push on macOS 13 or later. These browser alerts
use the same page-based reply fallback, not native Android direct reply.

The Android companion delivers native match notifications and room-code chat
replies from the notification shade; gameplay remains on the website. Konami
eFootball access requires an active companion device registration. Chess-only
accounts do not need the app; Both accounts can use Chess while they set it up.
Setup requires Android Studio, JDK 17, Android SDK 36, a Firebase Android app
with package name `com.goalgambit.companion`, and Cloud Messaging enabled. Put
the Firebase client configuration at `android/app/google-services.json`; this
file is ignored by Git. Give the backend a Firebase service account through
`FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`. The credential JSON
must stay outside this repository. A placeholder is in `backend/.env.example`;
merge its settings into the private `.env` or provide them in the backend
process environment.

Build a debug APK from the `android` directory with
`gradlew.bat assembleDebug`. To use a different HTTPS API host, add
`-PGG_API_BASE_URL=https://your-backend-host`. The result is
`android/app/build/outputs/apk/debug/app-debug.apk`. After installation, sign
in to the companion, enable notifications, and send a test notification. A
real phone test is still required to verify notification display and inline
reply behavior on the target Android version.

## Daraja STK

Keep `MPESA_ENVIRONMENT=sandbox` while validating. The Daraja consumer key,
consumer secret, shortcode, and passkey must come from the same app, and that
app must have the M-Pesa Express product enabled. Safaricom's sandbox Lipa na
M-Pesa Online shortcode is `174379`; use its matching sandbox test passkey.
An OAuth token alone does not prove STK product access. Never commit the Desktop
`.env` or copy its values into a public repository.

For a production Buy Goods Till, set `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`,
`MPESA_SHORTCODE` and `MPESA_STORE_NUMBER` to the approved Store/Head Office number
used with the passkey, and `MPESA_TILL_NUMBER` to the customer-facing Till number.
The STK request uses the store shortcode for `BusinessShortCode` and its password,
and the Till number for `PartyB`. PayBill requests continue to use the shortcode
for both fields.

## Daraja B2C wallet withdrawals

The wallet withdrawal endpoint uses its own Daraja app, OAuth token cache,
environment, and credentials, separate from the existing STK/C2B deposit app.
Set `MPESA_B2C_ENABLED=true`, `MPESA_B2C_ENVIRONMENT=sandbox` or `production`,
and the B2C app keys below. Keep the existing C2B app and its credentials
unchanged for deposits. Safaricom currently allows either C2B or B2C on a
Daraja app, so use a separate production B2C app to avoid disrupting deposits.
Production also requires Safaricom B2C go-live approval and an approved B2C
disbursement shortcode (or a PayBill/Till converted to a one account that can
receive and disburse).

Set `MPESA_B2C_CONSUMER_KEY`, `MPESA_B2C_CONSUMER_SECRET`,
`MPESA_B2C_SHORTCODE`, `MPESA_B2C_INITIATOR_NAME`, and
`MPESA_B2C_SECURITY_CREDENTIAL` in the private backend .env. The security
credential must be Daraja's encrypted credential for the matching B2C API
initiator; never put the raw initiator password in .env or source control.
The command defaults to BusinessPayment. Keep MPESA_B2C_ENABLED=false until
the separate B2C app, shortcode, and initiator are approved and ready.

PUBLIC_BASE_URL (or the platform-provided public URL) must point to this backend
over HTTPS so Safaricom can reach the per-withdrawal result and queue-timeout callbacks. Each callback
uses a random secret token, stored only as a hash, and can settle only its
matching withdrawal. The backend holds the withdrawal amount while Daraja
processes it, completes it only after a success callback, and restores it after
a failure or queue timeout. If the provider response is unclear, the request
stays pending; do not retry it until its state is known.

Amounts must be whole shillings. The processing fee is 5% for withdrawals up to
KSh 100, 10% for KSh 101–200, and 20% above KSh 200, rounded to the nearest
shilling. The wallet shows the estimated net payout before submitting without
displaying the percentage schedule. The wallet rejects requests before
deducting funds when any required B2C or public callback setting is missing.

Safaricom references:
[B2C API](https://developer.safaricom.co.ke/apis/BusinessToCustomer) and
[Getting Started](https://developer.safaricom.co.ke/apis/GettingStarted).

## Daraja C2B wallet deposits (sandbox)

C2B wallet deposits are separate from STK Push. Keep
`MPESA_C2B_ENABLED=false` until the Daraja app whose consumer key and secret
are in this backend has the C2B product enabled. Then set
`MPESA_C2B_SHORTCODE` to its PayBill shortcode and keep
`MPESA_C2B_TRANSACTION_TYPE=CustomerPayBillOnline`. A Till payment has no
reliable account reference for wallet crediting, so this flow intentionally
accepts PayBill only.

If C2B is enabled on a separate Daraja app from STK, set
`MPESA_C2B_CONSUMER_KEY` and `MPESA_C2B_CONSUMER_SECRET`; otherwise C2B falls
back to `MPESA_CONSUMER_KEY` and `MPESA_CONSUMER_SECRET`. Do not point C2B at
the separate B2C app. Keep C2B disabled until its app credentials and shortcode
are confirmed.

The wallet shows a per-account payment reference. The confirmation callback
credits a wallet only when its signed reference resolves to an active account;
duplicate receipts are idempotent, and unmapped receipts are retained in
`mpesa_c2b_payments` without crediting any wallet. Safaricom callback URLs are
derived from `PUBLIC_BASE_URL` and contain a signed token, so old explicit
`MPESA_C2B_CONFIRMATION_URL` and `MPESA_C2B_VALIDATION_URL` values are ignored.
The callback URLs avoid the blocked `mpesa` path keyword.

After enabling C2B and confirming the matching app credentials, sign in as an
administrator, open Wallet, and choose **Register sandbox callbacks** before
running the Daraja C2B simulator. Registration only configures the callback
URLs; it does not charge or pay anyone. If `JWT_SECRET` changes, register the
callbacks again because the signed callback path changes. C2B validation is
optional at Safaricom and must be separately enabled on the shortcode before
Daraja will call the validation URL.

Safaricom reference: [C2B API](https://developer.safaricom.co.ke/apis/CustomerToBusiness).

To stop public access:

    tailscale funnel reset

Then stop the backend window. The local PostgreSQL data remains on this PC.
