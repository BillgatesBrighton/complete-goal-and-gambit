# GOAL$GAMBIT Chess Performance Audit Report

**Audit date:** 2026-10-20  
**Project root:** C:\Users\pharaoh\Desktop\GOAL$GAMBIT  
**Git branch:** main (root repository); main (nested backend repository)  
**Scope:** Read-only diagnosis. No application source, schema, records, settings, dependencies, or server process was changed by this audit. This report is the only file created.

## 1. Executive summary

A definitive runtime cause for the reported chess delay could not be measured in this audit. At the time of inspection, the backend did not accept connections on its configured local address or its configured Tailscale HTTPS address, so there was no live chess session against which to measure a move. The backend health checks were refused, not slow application responses. No two-player test match or two authenticated player sessions were available. Median and p95 move latencies therefore cannot be calculated.

The strongest code-level performance candidate is redundant state loading combined with unnecessary database row locking on active-match reads:

- Each board polls the match state every two seconds.
- A Socket.IO move event causes both clients, including the player who just received the full updated state in the HTTP response, to fetch the match again.
- For every active-match GET, the route loads the match, calls a clock-expiry helper that opens a transaction and takes a row lock even when the clock is not expired, then loads the match again.

These behaviors are confirmed by source inspection. They multiply work when two players are connected and can make their reads contend with the row lock used to persist moves. **Confidence that this is avoidable work: high. Confidence that it caused the reported live delay: moderate at most, because no live move timing was available.**

There is also a confirmed operational connectivity problem at audit time: no Node process was listening on the local API port, and the configured HTTPS health endpoint refused its connection. This can explain failed or apparently offline requests, but does not prove the cause of earlier slow moves.

The computer has a 500 GB WDC fixed hard disk, but the brief system-wide disk samples were quiet and were taken with no Node API listener. They do not connect disk activity to chess. **The evidence does not justify an SSD upgrade. Software and service profiling should come first.**

## 2. Baseline and preservation

- Both repositories were on branch main and already had uncommitted changes and untracked files before this report was created. The nested backend repository already had changes in files including routes/chess.js, db/schema.sql, and server.js. All were preserved.
- The backend’s existing start options include backend/start-local.cmd (runs npm start), npm run dev (runs start-online.ps1 with nodemon), and npm run dev:local. backend/README.md documents start-local.cmd and the health URL.
- The frontend is static HTML/JS served by Express from the frontend directory; no separate frontend build command was found. Relevant setup is in backend/server.js and backend/README.md.
- The configured backend environment uses HOST=127.0.0.1, PORT=5000, NODE_ENV=production. These values were read only; no credentials were displayed.
- Starting the application was intentionally avoided: backend/server.js runs the existing db/schema.sql inside a database transaction before it begins listening, so starting it can apply schema changes. That would violate this audit’s no-database-change boundary.

## 3. Architecture map

| Layer | Actual files and functions | Role |
|---|---|---|
| Chess page and frame | frontend/pages/chess-match.html, iframe at lines 862–868; sendBoardConfig at lines 1972–1998 | Loads board.html and sends GOAL_GAMBIT_INIT configuration with postMessage. |
| Board document | frontend/pages/board.html, lines 314–319 | Loads shared API helper, Socket.IO client, and board.js. |
| Browser move logic | frontend/js/board.js | selectPiece requests legal destinations; sendMove posts a move; applyState updates state; renderBoard rebuilds the board; setupSocket joins the match room. |
| API and socket setup | backend/server.js | Creates PostgreSQL pool (lines 93–98), Socket.IO server (around 297), authenticates socket tokens (335–408), validates chess room membership (438–613), and mounts authenticated chess routes (819–828). |
| Chess API and state | backend/routes/chess.js | getMatch (676–701), clock expiry and sweep (1369–1446), match GET (1448–1498), legal-moves GET (1822–1853), and authoritative move POST (1855–1972). No separate chess move service was found. |
| Persistent match state | backend/db/schema.sql, chess_matches definition and indexes (152–245) | Stores match players/status, FEN, PGN, clocks, active color, timestamps, and result. Moves are represented in the match row’s FEN/PGN; no separate chess move-history table was found. |
| Player identity | users table in backend/db/schema.sql; authenticateToken and gameAccess in backend/server.js | Authenticates API and Socket.IO users and restricts chess access. |
| Socket.IO events | backend/server.js and backend/routes/chess.js | Client sends chess:join; server sends chess:joined, chess:player_connected, chess:error, chess:move, chess:game_over, and chess:player_disconnected. A chess:sync request/ack path also exists. Moves themselves are submitted over HTTP, not as client-originated Socket.IO move events. |

## 4. One move lifecycle

1. The player clicks a piece in frontend/js/board.js. selectPiece requests GET /api/chess/:id/legal-moves?square=…; the server loads the match, checks that the authenticated user is a player and it is their turn, then calculates legal moves using chess.js.
2. The player clicks a legal destination. sendMove posts from/to/promotion to POST /api/chess/:id/move. The browser displays “Sending move…” while waiting; it does not optimistically apply the move.
3. The route authenticates the user, opens a PostgreSQL transaction, selects the match row FOR UPDATE, validates membership, active status, turn, clock and move legality, then updates FEN, PGN, clocks, active color and result on chess_matches.
4. The transaction commits. If the game ended, settlement is performed. The route fetches the public match state, broadcasts chess:move (or chess:game_over) to the chess_match_<id> room, and returns the state to the HTTP caller.
5. Both clients listen for chess:move and call loadMatch(), which performs another GET and applies the fetched state. The sender has already received the updated state in the POST response, so its Socket.IO-triggered GET duplicates that state fetch.
6. Independently, every visible board with a waiting or active game polls GET /api/chess/:id every two seconds. The local chess clocks are repainted every 250 ms without fetching state.
7. applyState calls renderBoard. renderBoard clears the board element, recreates 64 square buttons and their children/listeners, and rebuilds the move list. No browser trace was available to determine whether this rendering is perceptible.

### Query and lock path

A normal active-match GET performs the joined getMatch query. It then calls settleExpiredClock unconditionally for active/settling states. For an unexpired active game that helper runs BEGIN, SELECT … FOR UPDATE, and COMMIT, then returns null; the GET route runs getMatch a second time. That is five SQL statements for one ordinary active-match GET, including a write-strength row lock that is not needed to display an unexpired position. The exact duration and lock wait were not measured.

A normal move POST performs a row-locking transaction (BEGIN, SELECT … FOR UPDATE, UPDATE, COMMIT) and a subsequent joined getMatch query before sending its Socket.IO event. End-of-game settlement adds further work.

The server’s chess clock sweep also queries for expired/settling games every 1,000 ms. Its query uses status, player and computed-clock predicates and orders by id.

## 5. Performance measurements

No valid chess move cycles were collected. “N/A” means not measured, not zero.

| Metric | Single player | Two players | Median / p95 | Evidence and limits |
|---|---:|---:|---|---|
| Move-to-server-response | N/A | N/A | N/A / N/A | No reachable local or configured remote API and no authenticated test match. |
| Move-to-opponent-board update | N/A | N/A | N/A / N/A | No two-player browser sessions or event trace. |
| Frontend board render / JavaScript task duration | N/A | N/A | N/A / N/A | No DevTools Performance capture. |
| Chess route and SQL durations | N/A | N/A | N/A / N/A | No route/query timers; pg_stat_statements data was unavailable. |
| Socket.IO event delivery | N/A | N/A | N/A / N/A | Existing logs have connection/join/disconnect messages but no move correlation timestamps or delivery acknowledgement timings. |
| Local /api/health | N/A | N/A | Not a move metric | GET to 127.0.0.1:5000 was refused. No Node listener was found on that port. |
| Configured remote /api/health | N/A | N/A | Not a move metric | One GET to the configured Tailscale HTTPS endpoint was refused after about 2,435 ms of connection attempt. This is not an HTTP response latency. |
| System CPU | Not attributable | Not attributable | Not applicable | Two one-second system samples: 13.60% and 46.28%. They were taken without an available chess backend and are not a chess load comparison. |
| Available RAM / paging | Not attributable | Not attributable | Not applicable | Two samples: 1,915 and 1,914 MB available; Pages/sec 0.99 and 0.00. |
| Node/PostgreSQL working set | Not attributable | Not attributable | Not applicable | Snapshot saw 6 Node processes totaling about 188.3 MB and 12 PostgreSQL processes totaling about 69.7 MB. No Node process was listening, so this cannot be assigned to a live chess server. |
| Disk | Not attributable | Not attributable | Not applicable | Two system samples: disk active time 1.09% and 0.11%; reads 0.00 and 0.97 per second; writes 17.78 and 11.62 per second. Avg disk seconds/read displayed as 0.01 and 0.00; write as 0.00 and 0.00. These are brief system-wide samples, not game-correlated. |

### PostgreSQL read-only observations

- Database-wide cumulative buffer statistics at inspection: 6,558,426 buffer hits and 1,354 blocks read, a 99.98% cache-hit rate. This is cumulative database-wide activity, not chess-only or a per-move measurement.
- chess_matches statistics reported 87,283 sequential scans, zero index scans, and an estimated zero live tuples. The statistics reset time was null, so the counters’ time window is unknown.
- The database has a primary-key B-tree index on chess_matches.id plus player, status, ranked-queue and admin-history indexes. No missing primary-key index was found.
- Plain EXPLAIN (without ANALYZE or executing the query) selected a sequential scan for both the getMatch join and the clock-sweep query, with estimated costs around 1.23 and 1.81. The planner estimated the relation as effectively empty/small; these plans do not establish that the scans are expensive at real match volume. The clock-sweep query is nevertheless a candidate to re-check with representative data because it runs every second.
- At the database snapshot, PostgreSQL reported two sessions for the selected database (one was the audit connection); this does not show pool saturation.
- No application table rows, wallet data, match results, schema settings, or database records were read or changed.

## 6. Root-cause ranking

| Rank | Finding | Status / confidence | Why it matters, especially with two players |
|---|---|---|---|
| 1 | Active-match GET performs an unnecessary FOR UPDATE clock check and then reloads the match | Confirmed code path; high confidence the extra work exists, moderate confidence as a latency cause | Both players’ polls and move-triggered refreshes can serialize on the same match row and contend with a real move transaction. No wait duration was measured. |
| 2 | Each player polls every two seconds, and each room move event triggers another GET for both clients | Confirmed code path; high confidence for duplicate work | Two players increase steady polling; a move causes sender and receiver refreshes, while the sender already has the POST response. Requests can overlap because loadMatch has no in-flight guard. |
| 3 | Backend API was unreachable at audit time; background worker logs show database connection terminations | Confirmed at inspection time; high confidence for current availability issue, not proven as the earlier chess delay | Local and configured remote health checks were refused, and no Node listener was found. server-task.log contains two “Competition timer worker” connection-timeout messages and a “sendPendingJobs” connection-termination error; these are not chess move errors. |
| 4 | One-second clock sweep plans a sequential scan of chess_matches | Confirmed plan for current estimated table size; low-to-moderate concern at scale | A repeated scan may become costly as the table grows. Current tuple estimate is zero, and EXPLAIN cost is low; no production-scale scan or query duration was run. |
| 5 | Full board and move-list DOM are rebuilt after each applied state | Confirmed implementation; low confidence as the primary bottleneck | It runs on POST response, socket refresh and polling. Sixty-four squares alone do not prove a rendering problem; browser timing is needed. |

No duplicate Socket.IO listeners were demonstrated. setupSocket does not guard against repeated invocation, so repeated initialization could create extra sockets; the normal current iframe path sends configuration through postMessage, and no live session/log evidence was available to establish that this happens.

## 7. HDD assessment

Windows reported a WDC WD5000AAKX-221CA1, 500,105,249,280-byte “Fixed hard disk media” ATA device. This confirms that the machine uses a hard disk. It does not show that the disk caused chess latency.

The sampled disk active time was low, available RAM was about 1.9 GB, and paging was near zero in these short snapshots. PostgreSQL’s cumulative database-wide cache-hit rate was 99.98%. The samples were not captured during chess and disk response counters were rounded by the displayed precision. There is no observed disk saturation, sustained paging, or per-move disk wait. **An SSD purchase is not supported by this evidence; first measure and remove software-side redundant requests/locks in an isolated environment.**

## 8. Recommended fixes for a separately approved phase

These are proposals only; none has been applied.

1. **Measure first in an isolated development environment.** Add temporary development-only correlation timing for match ID and move sequence across browser request start, route entry, database stages, Socket.IO emit, opponent receipt and render completion. Do not log tokens or private profile data. This will separate HTTP/network, lock wait, SQL, event delivery and rendering time.
2. **Avoid locking an unexpired match during a state read.** Calculate remaining time from the already fetched match and invoke the locked settlement path only when the clock is due or the match is already settling; retain server-side revalidation under lock before settling. Expected benefit: reduce each ordinary active GET from about five SQL statements to one and avoid read-path row-lock contention. Risk: clock-expiry boundary behavior must be verified carefully.
3. **Deduplicate synchronization.** Prevent overlapping loadMatch requests; do not refresh the sender from its own move event when its POST response already has the state; keep Socket.IO as the primary opponent update and retain a slower/reconnect/visibility fallback poll. Expected benefit: fewer duplicate GETs and less pressure on the match row. Risk: fallback synchronization must still recover dropped socket events.
4. **Re-measure the clock sweep before changing indexes or cadence.** The current query plan uses a sequential scan, but current estimated table size is tiny. Use a representative isolated dataset and plain EXPLAIN first; use EXPLAIN ANALYZE only on safe development data after approval. Add/change an index only if the plan and measured query time justify it.
5. **Optimize rendering only if browser traces point there.** If render duration is material, update only changed squares/move-list entries rather than recreating the entire board. Preserve legal-move behavior and verify on both players’ boards.

## 9. Files likely to change in a future approved optimization phase

- frontend/js/board.js — poll coalescing, sender event handling, and optionally measured render work.
- backend/routes/chess.js — active state read/clock lock path, move-stage instrumentation, and possibly clock-sweep behavior if measured.
- backend/server.js — only if shared request/Socket.IO timing instrumentation or socket metadata is needed.
- backend/db/schema.sql — only if an isolated, representative query plan proves an index change is warranted; no schema change is currently recommended.
- frontend/pages/board.html — only if a measured browser performance hook is added.

No change is currently recommended to wallet, tournament, result, or eFootball files.

## 10. Testing plan and proposed acceptance criteria

Use a disposable development database, two dedicated test accounts, zero-stake test matches, and the same local machine/browser settings. Do not use production games or balances. First confirm the API health endpoint, then collect an idle baseline and at least 30 valid alternating move cycles with one and two browser sessions. Capture browser Network/Performance traces, correlated route/database timings, Socket.IO delivery/receive marks, and system CPU/RAM/disk counters during the same windows.

Suggested targets for review (not measured or user-approved):

- 30/30 legal moves persist once and appear on both boards with matching FEN/PGN; no missed or duplicate move events.
- Record single-player and two-player p50/p95 end-to-end latency separately; target localhost p50 at or below 250 ms and p95 at or below 750 ms, with two-player p95 no more than 1.5× the single-player baseline.
- A non-expired active-state GET should not acquire a row lock or issue duplicate state queries after optimization.
- No increase in authentication failures, clock errors, stale state, settlement errors, or reconnect failures.
- Recheck the clock-sweep plan and database cache/disk metrics at representative test row counts.

These are candidate targets, not claims about current performance.

## 11. Limitations and next safe diagnostic

- The local server at 127.0.0.1:5000 and the configured Tailscale HTTPS backend were both unreachable during inspection. No Node listener was present; PostgreSQL was listening locally on port 5432.
- The backend startup path applies db/schema.sql before listening. It was not started because doing so could alter the database, which this read-only phase forbids.
- No browser sessions, authenticated test players, isolated test game or DevTools traces were available. No move, wallet, result or matchmaking test was performed.
- Query-level timings were not available: pg_stat_statements data was unavailable, application logs contain no request/query duration or move correlation ID, and Socket.IO logs do not time delivery.
- CPU, memory and disk samples are brief, system-wide and not correlated to chess activity. They cannot establish idle versus one-player versus two-player differences.
- No p50/p95 values can be calculated without move-cycle samples.

**Next safe diagnostic:** after review, provide or approve an isolated development database and two test accounts, then start the backend against that database and capture the 30-cycle baseline. If a dev-only timing patch is needed, approve it separately before any source changes.
