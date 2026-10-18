# GOAL$GAMBIT setup (Windows)

## 1. Start the backend and local database

The PostgreSQL database stays on this PC. The backend reads
`backend\.env` if present, otherwise the existing Desktop `.env`; both hold
secrets and must never be committed. Make sure PostgreSQL is running, then double-click
`backend\start-local.cmd`. It installs backend packages if needed, applies
database migrations at startup, and serves the full app at
http://127.0.0.1:5000/.

The launcher runs with production CORS rules and disables test wallet deposits.
Do not expose database port 5432 to the internet.

## 2. Allow the public site and Safaricom to reach your PC

For a no-domain setup, install Tailscale for Windows, sign in, and enable Funnel
in the Tailscale admin page. Configure Web Push once as described below, then
run `backend\start-online.cmd`. It creates a stable HTTPS Funnel route and
keeps its URL in the launcher process only; it does not modify the existing
`.env`. Stop any existing backend window with Ctrl+C before switching to this
online launcher. Keep the PC, Tailscale, and backend running.
Anyone can reach the API through the Funnel URL; the PostgreSQL port remains
private. If Safaricom rejects the generated hostname, a domain you control will
be needed.

The GitHub Pages frontend is configured for the existing Tailscale hostname in
`frontend\js\api.js`. If that hostname ever changes, update `githubPagesBackend`
there and publish the frontend. The backend allows the Pages origin in CORS.

## 3. Phone match notifications and room-code flow

Real Web Push needs an HTTPS frontend, an active backend, and VAPID keys. A
local key pair was created in the ignored `backend\.env.webpush`; keep that
file private and backed up securely. For another installation, copy
`backend\webpush.env.example` to `backend\.env.webpush`, generate a key pair
locally, and fill in:

- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (the private key stays on the backend).
- `VAPID_SUBJECT` (a contact email or the public HTTPS site URL).

Generate a pair from `backend` with:

```powershell
node -e "const w=require('web-push'); console.log(JSON.stringify(w.generateVAPIDKeys()))"
```

Keep its output local and never paste the private key into chat or commit it.
The backend loads `.env.webpush` after the existing
`.env` without replacing its values.

On a supported phone browser, sign in and choose **Enable Notifications** or
open **Notification Settings**. Allow the browser permission and keep it enabled
in phone settings. Android Chrome supports Web Push over HTTPS. iPhone/iPad push
requires iOS/iPadOS 16.4 or later, adding the site to the Home Screen, and
opening that installed app before enabling notifications. Browsers and device
power-saving settings can delay or suppress delivery; a successful push-service
response means accepted for delivery, not proof it appeared on screen.

When matchmaking pairs two players, only the server-assigned sender receives
the match-ready push. Tapping it opens that match's room page. The sender submits
the code there; the receiver is notified and confirms receipt on the same
private match page. Both players then mark ready, and the separate Results page
handles scores and the server-selected screenshot upload. If the receiver says
the code is wrong, they can request a replacement; the sender alone can submit
the corrected code, and both readiness confirmations reset.

The backend stores subscriptions per account and device, plus deduplicated
notification events and retryable delivery jobs. Schema changes apply through
the existing safe startup migrations or `npm run setup-db`; neither drops user
or wallet data. To check setup, use the signed-in **Notification Settings**
page's test button. For an end-to-end workflow, use two accounts with push
enabled on the receiving devices and verify match-ready, room-code, and receipt
alerts. A physical-phone test still needs to be performed on the target devices.

## 4. M-Pesa STK Push

Use sandbox mode while validating. The callback is generated as
`<PUBLIC_BASE_URL>/api/payments/callback`; leave `MPESA_CALLBACK_URL` blank. The
Daraja consumer credentials, shortcode, and passkey must all belong to the same
Daraja app, with M-Pesa Express enabled. OAuth success alone does not confirm
that the app can issue STK requests. For sandbox Lipa na M-Pesa Online,
Safaricom specifies shortcode `174379` and its matching sandbox passkey.
Sandbox requests are simulations, not real phone prompts. Test wallet deposits
are disabled while the PC API is public.

## 5. Added server-backed game systems
The repaired project now includes server routes/database structures for:

- Chess match creation, joining, legal moves, clocks, draw offers, resignation and settlement.
- eFootball match creation/matchmaking, ready state, result submission and wallet settlement.
- eFootball leagues and standings.
- eFootball tournaments and tournament status/joining.
- M-Pesa STK Push and callback handling.

The existing visual pages and navigation were retained. eFootball tournament
registration is server-backed; the separate old Chess tournament lobby now
explains that Chess tournament registration is not connected yet.

## 6. What changed in this update
- **Three dashboards.** At sign up a player picks Chess, eFootball or Both.
  The choice is stored on the account (not just in the browser), so login opens
  the right page on any device: `chess.html`, `konami.html` or `both.html`.
  `dashboard.html` is now just a router. Each dashboard shows the live username
  from the server, and the chess/both dashboards show the chess rating.
- **Chess rating at sign up.** Chess and Both players enter their rating (100-3000);
  it becomes their starting rating and then moves with Elo after every game.
- **Background images.** chess.html uses `images/chess-logo.png`, konami.html uses
  `images/konami-logo.png`, both.html uses `pages/images/chess-efootball.jpg`.
- **Balance checks.** Chess ranked/tournament, eFootball ranked/tournament and
  league joins all check the real wallet first (and the server refuses the stake
  lock if the balance is too low).
- **Matchmaking.** Chess: `POST /api/chess/create` pairs you with a waiting player on
  the same type/stake/clock, or opens a search (cancel refunds the stake).
  eFootball: `POST /api/efootball/matches` does the same; the Match Hub now reads the
  opponent, room code, ready state and result from the server.
- **"Enda train"** alert is shown to the loser of an eFootball match in the Match Hub.

Existing databases are upgraded automatically on the next `npm start`
(or run `npm run setup-db`). Existing accounts default to the "both" dashboard.

## 7. GOAL$GAMBIT Android app and required eFootball access

The Android companion enables native Firebase Cloud Messaging (FCM) match
alerts and notification-based room-code chat replies while eFootball stays open
on the website. Chess and eFootball gameplay remain on the website. Players
choosing eFootball or Both must sign in to the companion and enable notifications
before they can enter eFootball matches, leagues, or tournaments. Both accounts
can use Chess while setting up the companion. The API checks for an active
Android device registration, so acknowledging the signup notice alone does not
unlock eFootball access. The notification does not pop over the game or request
overlay permission.

Install Android Studio with JDK 17 and Android SDK 36. In Firebase, register
an Android app with package name `com.goalgambit.companion` and enable Cloud
Messaging. Save its `google-services.json` as
`android\app\google-services.json`. Put the Firebase service-account JSON
outside the project. Configure `FIREBASE_PROJECT_ID` and
`GOOGLE_APPLICATION_CREDENTIALS` in the backend's private environment; merge
the placeholders from `backend\.env.example` into the private
`backend\.env` or set them in the backend process environment. Never commit
either Firebase JSON file.

The public APK will be served from
`https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-companion.apk`.
Do not publish the download until Firebase and the public API host are configured.

From the `android` directory, build a debug APK with
`gradlew.bat assembleDebug`. If the API host differs from the configured
Tailscale address, pass `-PGG_API_BASE_URL=https://your-public-backend-host` to
Gradle. A downloadable build must use an HTTPS API host reachable from the
player's phone over the public internet; a private Tailscale-only address will
not work for other players. The APK is written to
`android\app\build\outputs\apk\debug\app-debug.apk`. After installation,
sign in, enable notifications, and use **SEND TEST NOTIFICATION** to check
delivery. After the public API and Firebase setup are verified, copy the APK
to `frontend/downloads/goal-gambit-companion.apk` and publish the GitHub Pages
update so the signup link becomes available. A real match-ready alert shows **ENTER ROOM CODE** after
you expand it in the notification shade; tap that action to open the reply
field. A physical Android phone test is still required for delivery and inline
reply behavior.
