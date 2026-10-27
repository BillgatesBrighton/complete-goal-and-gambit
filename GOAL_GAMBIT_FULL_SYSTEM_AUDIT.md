# GOAL$GAMBIT Full System Audit

**Audit date:** 2026-10-27
**Workspace:** `C:\Users\pharaoh\Desktop\GOAL$GAMBIT`

## Executive summary

The audit found and fixed confirmed chess disconnect/recovery defects, a broken landing-page manifest link, and two high-severity vulnerable npm dependencies. Backend authorization, chess isolation, companion notification, password recovery, competition, and wallet behavior have broad automated test coverage, and those suites pass. The offline audit did not use a live backend/database, real payment provider, Android handset, or simultaneous human sessions. A separate live-server snapshot is recorded below.

The most important fix is fail-closed chess reconnection. A connected Socket.IO transport alone no longer makes a match playable: the server confirms that both authenticated players are present and the stored match is unpaused, clients refetch the authoritative position before enabling moves, and the move/result routes reject work when the match room is not ready. A local network loss freezes the displayed clock and prevents new moves immediately. An unconfirmed local move is retained as recovery evidence and is never silently retried as an official move.

## Areas inspected

- Website frontend: 44 HTML pages, board interaction/rendering, API calls, push setup, and local relative `src`/`href` links.
- Backend: 19 route modules, service modules, authenticated route tests, Socket.IO joins/rooms, startup configuration, server health/polling, and request error paths.
- PostgreSQL: chess, wallet/ledger, competition, eFootball, chat, announcement, support, and notification schema/query patterns. The automated audit tests did not query or change the configured database; the later live-server startup and read-only preflight are recorded below.
- Companion app: Android chess socket, native chess rules/cache, notification bridge, Gradle configuration, and unit tests.
- Repository/dependencies: tracked diff, zero-byte tracked files, npm dependency graph and security audit.

## Confirmed findings and fixes

### Chess connection and recovery

- **Ready state previously represented socket membership only.** The server now checks the persisted match after join/resume; a database resume failure leaves both clients paused.
- **An active match could continue timing out before a dropped user was recognized.** The backend now gates timeout settlement on current authenticated room readiness, reports a paused display state while a room is incomplete, and freezes the saved clocks when an active match is first observed after process restart.
- **HTTP actions could bypass the room pause.** Moves, resignations, and draw operations now reject while either player is missing from the authenticated match room. Existing server-side legal-move, turn, clock, result, and settlement validation remains authoritative.
- **The browser previously kept ticking after local connectivity loss and could enable from stale state.** It now captures/fixes the visible clock at loss, waits for socket join plus a successful authoritative GET before enabling active play, immediately rejoins after browser connectivity returns, and polls every 2 seconds until live readiness (10 seconds only when ready and connected).
- **Recovery could resubmit a move that never reached the backend.** The browser now acknowledges a saved move only if the returned authoritative history already includes it. Otherwise it restores the official board, preserves the local evidence, and requires review; it does not POST that move again.
- **Repeated same-socket joins could temporarily remove the player's own presence.** The connection monitor now treats same-match joins idempotently.
- Added regression tests for blocked actions, frozen clocks, process-restart recovery, duplicate joins, accepted-vs-unconfirmed offline moves, and recovery ordering.

### Companion legal-move prediction

- Android computes and caches legal moves keyed to the exact full FEN; speculative work is bounded and deprioritized. Bullet games skip branch speculation.
- The authenticated backend validates reported position/history and only relays a prediction for the exact current active match position to its isolated match room. Browser hints still pass the local chess rules engine; only the backend accepts official moves.
- The companion remains an advisory predictor and notification/connection client. It does not become an authority for moves, clocks, match results, or payouts.

### Website and dependency fixes

- `frontend/pages/index.html` had two incorrect/duplicate manifest links, one inside the navigation. It now has a single correct relative link to `frontend/manifest.webmanifest`.
- The locked `body-parser` and `multer` versions had high-severity denial-of-service advisories. Compatible lockfile updates moved `body-parser` 2.3.0 → 2.4.0, `multer` 2.4.0 → 2.5.0, and `qs` 6.16.0 → 6.17.0. No major version changes were made.
- The existing push test expected an outdated APK fallback call shape; its assertion now checks the current cache-busting fallback behavior.

## Architecture and move lifecycle

1. `frontend/pages/chess-match.html` / `frontend/pages/board.html` load `frontend/js/board.js` and the bundled `frontend/js/vendor/chess.mjs` rules engine.
2. The board calculates legal hints locally, updates the visible position, persists recovery evidence, and submits the move through authenticated `POST /api/chess/:id/move` with expected FEN and ply.
3. `backend/routes/chess.js` authenticates the seat, checks live room readiness, obtains the match row lock, restores PGN history, validates legal move/turn/clock/status, writes the authoritative position and clocks, then returns the authoritative match snapshot.
4. `backend/server.js` maintains authenticated Socket.IO room membership. The move event identifies the acting user without disclosing personalized state; the sender ignores its own event, while the opponent fetches authoritative state.
5. `backend/services/chessEngineRelay.js` sends verified exact-position advisory calculations only within the authenticated match room. Android source is in `android/app/src/main/java/com/goalgambit/companion/ChessEngineSocket.java` and `NativeChessEngine.java`.

## Performance measurements

These are local automated diagnostics, not a real-device or production latency benchmark. They use mocked DOM/API behavior and should not be read as actual network performance.

- Local legal-move selection/highlighting, 30 samples in the full-suite run: **p50 0.552 ms, p95 11.344 ms**.
- Companion-cache legal-hint selection in the same run: **p50 0.294 ms, p95 2.195 ms**.
- Synchronous local legal move-to-board update: **p50 1.992 ms, p95 17.067 ms**.
- Client-side move-confirmation processing with an immediate mocked API: **p50 5.094 ms, p95 19.398 ms**; this excludes actual network/backend latency.
- Synthetic route load used 100 in-memory matches, 200 identities, and 200 moves: **batch p50 361.07 ms, p95 443.93 ms, 225.2 accepted moves/s, 19.8 MiB RSS delta**. This used an in-memory PostgreSQL substitute and no real Socket.IO clients; it does not establish production capacity.
- No live PostgreSQL query timings, real Socket.IO delivery timings, phone CPU/RAM, or physical disk activity were measured.

## Verification results

- `cd backend; npm test`: **passed** (all 19 scripts in the configured suite; includes chess, connection monitor, relay, password recovery, eFootball, admin, chat, push/announcements, and wallet tests). Tests use isolated mocks/local HTTP harnesses; they do not start `backend/server.js` or alter the configured database.
- Focused chess state-sync tests: **46/46 passed**.
- Connection-monitor tests: **5/5 passed**.
- Companion relay tests: **5/5 passed**.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities** after the compatible lockfile updates.
- `android/gradlew.bat --no-daemon --rerun-tasks testDebugUnitTest`: **passed, 13 tests** using Android Studio JBR and the installed SDK. The first forced run found a timing-sensitive test that assumed the bounded predictor would always calculate the specific `e5` branch. The test now follows the first branch actually selected by the predictor and verifies the exact-position cache hit; the 30 ms budget remains unchanged.
- `android/gradlew.bat --no-daemon assembleDebug`: **passed**. Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- `node --check` on the edited backend/frontend JavaScript: passed.
- `git diff --check`: passed.
- Static HTML link scan: **356 local references checked, 0 broken** after the manifest correction.
- The only tracked zero-byte file is `.nojekyll`, the intentional GitHub Pages marker.

## Unverified / remaining risks

- No real two-device or two-account chess match, cross-network mobile session, Android notification tap, or live companion reconnection was run. These require authenticated test accounts and a safe live test window.
- The current server snapshot confirms startup and health only. No authenticated users, simultaneous matches, or real-user traffic have been observed yet, so concurrency and match synchronization under real usage remain unverified.
- The connection monitor uses Socket.IO heartbeat/disconnect detection (configured server ping interval 15 seconds, timeout 20 seconds). A remote peer may take time to be declared disconnected; this audit did not measure that detection delay over real networks.
- After an abrupt process crash, the exact time of failure cannot be persisted. Recovery conservatively pauses from the last persisted clock values when a player returns, preventing a downtime-only timeout, but can refund thinking time since the last confirmed move. Exact outage-time clock accounting would need a durable server lease/checkpoint design and a separate migration review.
- The first Android test run exposed a brittle assumption about which prediction branch finishes within the bounded computation window. The focused test was made deterministic and the full forced Android test task then passed. Deprecated Android notification API warnings remain in existing notification code; they did not fail compilation.
- The broader UI journey was statically checked, not manually clicked through every page. Real M-Pesa, SMS, Firebase delivery, payouts, and withdrawal flows were not initiated.

## Live server test phase

The server was started with the existing `cd backend; npm run dev` launcher and remains running in the attached process session. It is listening on `127.0.0.1:5000` and exposed through Tailscale Funnel at [https://desktop-elb0fth.taildd904a.ts.net](https://desktop-elb0fth.taildd904a.ts.net). Local and public HTTPS `GET /api/health` both returned success with PostgreSQL connected, Socket.IO enabled, and the chess backend enabled. A request with the GitHub Pages `Origin` returned HTTP 200 and the expected `Access-Control-Allow-Origin` header.

Before startup, a read-only transaction checked whether the built-in support repair would remove data; it found **0 duplicate groups and 0 support-thread rows to remove**. Startup then completed the existing transactional schema/backfill path before listening. This applied the project's normal idempotent schema setup and data backfills; no deposit, withdrawal, payout, or match operation was initiated. This preflight does not replace a backup or demonstrate multi-user behavior.

The live console remains available in the attached Codex terminal for request/error logs. At the time of this report, only the health check has been exercised; no invited users have produced captured activity yet. Keep this server process and the Tailscale Funnel running during the trial. Once real participants begin, their API errors, Socket.IO joins/disconnects, and match transitions can be inspected from this session. The live phase is therefore **started and ready for users, but not yet complete**; no reliability claim under real simultaneous use is made.

## Files changed

Files changed: `android/app/src/main/java/com/goalgambit/companion/ChessEngineSocket.java`, `NativeChessEngine.java`, and `android/app/src/test/java/com/goalgambit/companion/NativeChessEngineTest.java`; `backend/db/schema.sql`, `package.json`, `package-lock.json`, `routes/adminMatchManagement.js`, `routes/chess.js`, `server.js`, `services/chessEngineRelay.js`, `services/chessConnectionMonitor.js`, and tests `admin-match-management.test.js`, `chess-connection-monitor.test.js`, `chess-engine-relay.test.js`, `chess-state-sync.test.js`, `push.test.js`; `frontend/js/board.js`, `frontend/pages/board.css`, `frontend/pages/board.html`, and `frontend/pages/index.html`; and this report.
