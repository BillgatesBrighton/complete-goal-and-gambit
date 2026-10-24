# GOAL$GAMBIT Chess Match Isolation and Matchmaking Audit

**Audit date:** 2026-10-24 (Africa/Nairobi)

## Executive summary

The reported self-play incident could not be reproduced against two real authenticated accounts, and the available environment had no isolated PostgreSQL test database configured. The code does not establish that the normal ranked queue fabricated an opponent: it creates a one-player waiting row, then assigns a different authenticated user to the second seat under per-user and per-queue advisory locks. The queue reads ratings from `users`, applies the existing 200-point bracket, and never uses a bot or predicted move as an opponent.

Two confirmed bypasses were fixed:

1. The explicit `POST /api/chess/:id/join` path did not enforce the one-live-match rule or ranked-bracket eligibility. It could let an account claim a second match and bypass the normal ranked queue's bracket check.
2. A Socket.IO connection joining a second chess room stayed subscribed to the first room. Normal board navigation disconnects the previous socket, but the server did not enforce that boundary for repeated or stale join requests.

These are plausible ways to cause confusing opponent/match behavior, but they do **not** prove the specific self-play report’s root cause. The exact incident still needs a trace from two real accounts or safe server logs for the affected match IDs.

## Architecture and move lifecycle

| Stage | Existing component | Behavior |
|---|---|---|
| Ranked queue | `backend/routes/chess.js`, `POST /create` | Authenticated account/rating read, per-user lock, existing-match check, queue lock keyed by match type/stake/clock/bracket, then claim a compatible waiting row or create a waiting row. |
| Explicit join | `backend/routes/chess.js`, `POST /:id/join` | Locks the joining user and target match, then assigns Black. This path now checks both participants’ eligibility, live matches, distinct IDs, and the same ranked bracket. |
| Scheduled match | `backend/routes/chessSchedules.js` | Validates distinct invitees and takes both user advisory locks before creating an active match. |
| Board rules | `frontend/js/board.js`, `currentRulesPosition()` and `selectPiece()`; `frontend/js/vendor/chess.mjs` | Uses local chess.js rules for selection/highlights. The cached rules position is keyed by match ID, FEN, and PGN. Selection does not wait for a legal-moves network request. |
| Official move | `backend/routes/chess.js`, `POST /:id/move` | Locks the specific `chess_matches` row, checks membership, turn, status, clock, expected FEN/ply, and legal move, then stores the authoritative position/PGN and settles terminal results. |
| Match updates | `backend/server.js` and `backend/routes/chess.js` | Sockets join `chess_match_<id>` rooms after membership checks. Move and result events are emitted to that match room. The HTTP move endpoint remains authoritative. |
| Android engine relay | `backend/services/chessEngineRelay.js` | Receives already-confirmed server moves for an advisory native-engine check. It does not create opponent moves or advance a game. Requests are match/ply/FEN checked, expire after 15 seconds, and the pending map is capped at 1,024. |

An official move travels from the browser’s local rules check to authenticated `POST /:id/move`. PostgreSQL serializes concurrent moves for the same match through `SELECT ... FOR UPDATE`. The server commits the position and then emits `chess:move` only to the corresponding `chess_match_<id>` room. The receiving board ignores its own actor event and refreshes its own authorized match state. Other matches use different rows and rooms.

## Confirmed findings and changes

### Matchmaking and player assignment

- Normal `/create` matchmaking already derives the requester’s rating from the database; the client cannot select its bracket. The SQL only chooses an active Chess-eligible waiting player with a compatible time control/stake, a distinct user ID, no other live game, and—when ranked—rating inside the requester’s server-derived bracket.
- `/create` serializes a user’s searches with `goal-gambit-chess-user:<id>` and serializes the compatible queue with a key containing type, stake, clock, and ranked bracket. Simultaneous requests from one user therefore resolve to an existing search/match rather than assigning that account twice through this path.
- **Confirmed defect fixed:** direct `/join` bypassed the live-match and ranked-bracket checks. It now uses the same per-user lock, refuses a second live match, checks the waiting player’s active account/game eligibility, verifies the ranked bracket from both database ratings, and refuses a waiting player already assigned elsewhere.
- **Confirmed malformed-row defense added:** same-user White/Black rows are no longer recognized as a playable seat by the shared player-color helper. The socket room validator also rejects malformed two-seat rows while still allowing the first player to subscribe to a legitimate one-seat `waiting` row.
- A waiting search now serializes an absent opponent as `null` rather than numeric ID `0`; no fake player is returned.

### Socket.IO isolation

- **Confirmed defect fixed:** a socket could join match A and then match B without leaving A. Join attempts now clear the previous room before lookup, use a generation token so stale asynchronous lookups cannot restore an old room, and track only the current match room.
- `chess:match_ready` now broadcasts only `{ success, matchId }`. It no longer sends a joining player’s personalized `publicMatchState` to every member of the room; each browser fetches its own authorized state.
- Move events continue to carry the authenticated actor ID and move only inside the match-ID room. The 100-match mock test checks that each move event’s room matches its match ID.

### Predictions and opponents

- No backend legal-move prediction manager/cache exists in this checkout. The browser computes legal destinations locally; the authenticated `/api/chess/:id/legal-moves` route can supply authoritative-position hints when requested; and every official move is independently checked by the backend.
- The existing client cache includes match ID, full FEN, and PGN, and existing tests verify invalidation after a changed position. Backend legal-move validation still uses chess.js. Existing tests cover castling, en passant, promotion, check safety, terminal positions, illegal moves, and stale engine-relay results.
- The Android engine relay is a post-acceptance audit, not an automated opponent. No predicted move is submitted, shown as an opponent move, or used to advance a match.
- No new prediction cache was added: the current board does not make a network request to show legal destinations, and the local selection measurements below are sub-millisecond at the median in the mocked DOM harness. A server cache would not speed that current selection path. The server endpoint remains available; cache work should follow measured repeated calls rather than add unused shared state.

## Database and scaling evidence

- `backend/db/schema.sql` defines one `chess_matches` row per match with independent IDs, player seats, FEN, PGN, clocks, turn, status, and result. It has indexes for White, Black, status, ranked waiting rows, and active user ratings. It does not have a database constraint preventing identical player IDs or a unique constraint limiting a user to one live match; current enforcement is in transaction-locked application paths, with malformed self-match rows rejected at read/move/socket boundaries.
- `backend/server.js` configures a PostgreSQL pool with `max: 20`, `idleTimeoutMillis: 30000`, and `connectionTimeoutMillis: 10000`. The server uses the default in-process Socket.IO adapter in this deployment; cross-process room delivery was not tested or configured here.
- The chess clock sweep polls every second, selects at most 200 expired/settling matches, and settles them sequentially while a process-wide busy flag is set. This is a code-level capacity consideration if many clocks expire at once, not a measured bottleneck at 100 active matches.
- No PostgreSQL server/test URL was configured in the environment. No database query plans, actual pool wait times, DB CPU, indexes on a live database, production rows, or real user accounts were inspected or changed.

## Measurements

### Isolated 100-match route workload

The new `backend/test/chess-match-isolation.test.js` uses the real Express chess routes and a test-only in-memory PostgreSQL substitute. It sent **200 concurrent `/create` requests** from 200 distinct test identities, producing **100 active matches** across two authoritative test rating brackets and two controls (`1+1` Bullet and `3+2` Blitz). The test included forged client bracket/rating fields and verified that the pairings followed the test account rows. It then submitted **200 legal moves** (one move from each player) across those 100 matches, verified 100 distinct resulting positions, and checked match-room event IDs.

Latest measured run from the Node test process:

- Synthetic matchmaking: 200 concurrent create requests → 100 matches in **1,122.9 ms**.
- Move HTTP response latency through local Express + in-memory DB substitute: **p50 306.83 ms, p95 407.39 ms**; **255.9 accepted moves/s**.
- Test-process CPU: **859 ms user, 94 ms system**; RSS delta **+20.0 MiB**; event-loop delay p95 **319.82 ms**.

These measurements include local HTTP, Express, test scheduling, chess.js, and the in-memory mock. They are not PostgreSQL timings, real Socket.IO delivery, 200 persistent socket connections, or a production capacity result. The event-loop delay is from the concurrent test harness and cannot be attributed to the production server.

Before the edits, a preliminary version of the same route harness used 100 pre-seeded in-memory matches and 200 moves: p50 **446.49 ms**, p95 **623.04 ms**, **159.9 moves/s**, CPU **1,406 ms user / 156 ms system**, RSS delta **+39.6 MiB**, event-loop p95 **327.16 ms**. The post-edit run additionally created matches through `/create`, used varied opening positions, and ran in a separate process; these runs are **not comparable enough to claim a performance improvement**.

### Local chess interaction baseline

Existing mocked-DOM measurements before edits: piece selection/highlights **p50 0.671 ms / p95 7.594 ms**; synchronous local move-to-board update **p50 1.311 ms / p95 3.995 ms**; move-confirmation client processing with a mocked immediate API **p50 6.238 ms / p95 19.470 ms**. The latest test run measured selection **0.580 / 3.016 ms**, local move update **1.228 / 6.102 ms**, and client confirmation **3.975 / 16.696 ms**. No frontend code changed in this task, and the harness results vary; they do not prove a before/after improvement. They exclude physical display paint, network, PostgreSQL, and real devices.

## Tests and actual results

- `node --test test/chess-competitions.test.js test/chess-match-isolation.test.js test/chess-state-sync.test.js test/chess-engine-relay.test.js` — **45 passed, 0 failed**.
- Coverage added: 100 active route-level matches/200 distinct player identities; concurrent bracketed matchmaking; bullet and blitz queue separation; unique seats; ranked direct-join bracket rejection; existing-live-match rejection; no fabricated casual opponent; malformed self-match rejection; generic ready events; stale socket join suppression and room switching.
- Existing chess tests also passed for server-authoritative move legality, simultaneous same-position move serialization, local legal move generation/cache invalidation, reload/offline recovery, bullet clock behavior, and native engine relay authorization.
- `node --check` on `backend/routes/chess.js`, `backend/server.js`, `backend/services/chessSocketRooms.js`, and the new test file — passed. `git diff --check` — passed.
- `npm test` ran the added isolation suite, chess state-sync suite, and engine-relay suite successfully, then stopped at an unrelated existing failure in `backend/test/push.test.js`: its APK fallback assertion expects `window.location.assign(ANDROID_COMPANION_DOWNLOAD_URL)`, while the committed `frontend/js/api.js` already uses `window.location.assign(url.toString())`. That file was unchanged in this task; the failure is present against the current `HEAD` source. The other tests later in the chain did not run because the script uses `&&`.

## Root-cause ranking

1. **Confirmed defect, high confidence:** `/join` did not enforce the one-live-match or same-ranked-bracket rules. This allowed a bypass of normal matchmaking protections. Fixed and covered with route tests.
2. **Confirmed defect, high confidence:** a socket could remain subscribed to an earlier match room after a later join. Fixed and covered at the room-helper level; a live Socket.IO integration test was unavailable.
3. **Not confirmed:** the user’s exact self-play report. Normal `/create` is coded to create distinct participants; the historical match row and user/session logs for the reported game were unavailable.
4. **No evidence found:** a bot/prediction process acting as the opponent, global chess position cache, or shared mutable board state across browser match instances.
5. **Unverified capacity risk:** actual database pool/lock/query latency, real socket event delivery, and clock-sweep behavior under hundreds of simultaneous expiries.

## Remaining verification needed

To establish the real-world acceptance criteria safely, use an isolated PostgreSQL database with test-only accounts and a separate test server. Connect two independent browser sessions, then run 100 matches with 200 actual Socket.IO clients. Record pool wait time, query timings/plans, CPU/RAM, event-loop delay, socket delivery latency, reconnection, and cross-room delivery. Do not use production wallets, balances, or active matches for that test. The current environment did not provide those test resources, so claims of two real accounts playing, 200 connected clients, production database capacity, or real-device bullet performance remain unverified.

## Files changed

- `backend/routes/chess.js`
- `backend/server.js`
- `backend/services/chessSocketRooms.js` (new)
- `backend/test/chess-match-isolation.test.js` (new)
- `backend/package.json`
- `CHESS_MATCH_ISOLATION_AUDIT_REPORT.md` (this report)
