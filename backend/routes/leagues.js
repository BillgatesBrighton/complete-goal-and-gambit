"use strict";
const express = require("express");
const { randomUUID } = require("crypto");
const gameAccess = require("../middleware/gameAccess");
const { ensureLeagueRound, recordLeagueFixtureResult } = require("../services/efootballtournament");
const { creditPlatform, refundReservedPlatformFee } = require("../services/adminWalletAccounting");
const { recordJournal } = require("../services/financialLedger");

const MAX_LEAGUE_PLAYERS = 20;

module.exports = function (pool, authenticateToken) {
    const router = express.Router();
    const requireKonamiCompanion = gameAccess(pool, "konami");

    // A league can be addressed by numeric id or by name (Bronze / Silver / Gold).
    async function findLeague(db, key) {
        const isId = /^\d+$/.test(String(key));
        const r = isId
            ? await db.query("SELECT * FROM efootball_leagues WHERE id = $1", [Number(key)])
            : await db.query("SELECT * FROM efootball_leagues WHERE LOWER(name) = LOWER($1)", [String(key)]);
        return r.rows[0] || null;
    }

    router.get("/", async (req, res) => {
        const r = await pool.query(`SELECT l.*, COUNT(m.id)::int AS players
            FROM efootball_leagues l
            LEFT JOIN efootball_league_members m ON m.league_id = l.id
            GROUP BY l.id ORDER BY l.id`);
        res.json({ success: true, leagues: r.rows });
    });

    router.get("/:id/fixtures", authenticateToken, requireKonamiCompanion, async (req,res)=>{
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const l=await findLeague(client,req.params.id);
            if(!l) {
                await client.query("ROLLBACK");
                return res.status(404).json({success:false,message:"League not found."});
            }
            const membership = await client.query(
                "SELECT * FROM efootball_league_members WHERE league_id=$1 AND user_id=$2",
                [l.id, Number(req.user.userId)]
            );
            const round = membership.rows.length
                ? await ensureLeagueRound(client, Number(l.id), true)
                : (await client.query(
                    "SELECT * FROM efootball_league_rounds WHERE league_id=$1 ORDER BY round_number DESC LIMIT 1",
                    [l.id]
                )).rows[0] || null;
            const roundInfo = round ? {
                number: Number(round.round_number),
                starts_at: round.starts_at,
                deadline_at: round.deadline_at,
                completed_at: round.completed_at
            } : null;
            res.set("Cache-Control", "no-store");
            const r=await client.query(`
                SELECT f.id AS fixture_id,f.match_id,f.home_id,f.away_id,
                       m.opponent_id AS matched_opponent_id,
                       hu.username AS home,au.username AS away,
                       COALESCE(m.round_name,'League · Round '||f.round_number) AS round_name,
                       CASE WHEN m.status='disputed' THEN 'disputed'
                            WHEN m.status='awaiting_verification' THEN 'awaiting_verification'
                            WHEN m.status='cancelled' THEN 'cancelled'
                            WHEN m.status='completed' AND m.result_status='walkover' THEN 'walkover'
                            WHEN m.status='completed' THEN 'completed'
                            WHEN m.status IN ('waiting','ready','playing') THEN m.status
                            ELSE f.status END AS status,
                       f.home_score,f.away_score,
                       COALESCE(m.created_at,f.created_at) AS created_at,
                       m.started_at,COALESCE(m.finished_at,f.resolved_at) AS finished_at,
                       f.round_number
                  FROM efootball_league_fixtures f
                  JOIN users hu ON hu.id=f.home_id
                  LEFT JOIN users au ON au.id=f.away_id
                  LEFT JOIN efootball_matches m ON m.id=f.match_id
                 WHERE f.league_id=$1
                UNION ALL
                SELECT NULL::bigint AS fixture_id,m.id AS match_id,m.creator_id AS home_id,m.opponent_id AS away_id,
                       m.opponent_id AS matched_opponent_id,
                       hu.username AS home,au.username AS away,m.round_name,m.status,
                       CASE WHEN m.status='completed' THEN m.creator_score END AS home_score,
                       CASE WHEN m.status='completed' THEN m.opponent_score END AS away_score,
                       m.created_at,m.started_at,m.finished_at,0 AS round_number
                  FROM efootball_matches m
                  JOIN users hu ON hu.id=m.creator_id
                  LEFT JOIN users au ON au.id=m.opponent_id
                 WHERE m.league=$2 AND m.league_fixture_id IS NULL
                 ORDER BY round_number DESC,started_at DESC NULLS LAST,created_at DESC,match_id DESC
                 LIMIT 200`,[l.id,l.name]);
            const me=Number(req.user.userId);
            const actions = membership.rows.length
                ? await client.query(
                    `SELECT
                       (
                         $3::int=0 AND $4::timestamptz IS NULL AND
                         NOT EXISTS (
                           SELECT 1 FROM efootball_league_fixtures f
                            WHERE f.league_id=$1 AND f.round_number=1 AND f.away_id IS NOT NULL
                              AND (f.home_id=$2 OR f.away_id=$2)
                         ) AND NOT EXISTS (
                           SELECT 1 FROM efootball_matches m
                            WHERE (m.league_fixture_id IN (SELECT id FROM efootball_league_fixtures WHERE league_id=$1)
                                   OR m.league=$5)
                              AND (m.creator_id=$2 OR m.opponent_id=$2)
                              AND (m.started_at IS NOT NULL OR m.settled_at IS NOT NULL
                                   OR m.status IN ('playing','awaiting_verification','disputed','completed'))
                         )
                       ) AS can_cancel,
                       (
                         $3::int=0 AND $4::timestamptz IS NULL AND
                         EXISTS (
                           SELECT 1 FROM efootball_league_fixtures f
                            LEFT JOIN efootball_matches m ON m.id=f.match_id
                            WHERE f.league_id=$1 AND f.round_number=1 AND f.away_id IS NOT NULL
                              AND f.status IN ('scheduled','playing')
                              AND (f.home_id=$2 OR f.away_id=$2)
                              AND (m.id IS NULL OR (m.started_at IS NULL AND m.status IN ('waiting','ready')))
                         ) AND NOT EXISTS (
                           SELECT 1 FROM efootball_matches m
                            WHERE (m.league_fixture_id IN (SELECT id FROM efootball_league_fixtures WHERE league_id=$1)
                                   OR m.league=$5)
                              AND (m.creator_id=$2 OR m.opponent_id=$2)
                              AND (m.started_at IS NOT NULL OR m.settled_at IS NOT NULL
                                   OR m.status IN ('playing','awaiting_verification','disputed','completed'))
                         )
                       ) AS can_forfeit`,
                    [l.id, me, Number(membership.rows[0].played || 0), membership.rows[0].forfeited_at, l.name]
                  )
                : { rows: [{ can_cancel: false, can_forfeit: false }] };
            await client.query("COMMIT");
            res.json({success:true,league:l,round:roundInfo,isMember:membership.rows.length > 0,
                canCancel:Boolean(actions.rows[0].can_cancel),canForfeit:Boolean(actions.rows[0].can_forfeit),
                fixtures:r.rows.map(x=>({...x,id:Number(x.match_id == null ? x.fixture_id : x.match_id),fixture_id:x.fixture_id == null ? null : Number(x.fixture_id),match_id:x.match_id == null ? null : Number(x.match_id),matched_opponent_id:x.matched_opponent_id===null?null:Number(x.matched_opponent_id),home_id:Number(x.home_id),away_id:x.away_id===null?null:Number(x.away_id),home_score:x.home_score===null?null:Number(x.home_score),away_score:x.away_score===null?null:Number(x.away_score),round_number:Number(x.round_number||0),mine:me===Number(x.home_id)||me===Number(x.away_id)}))});
        } catch(e){
            await client.query("ROLLBACK").catch(()=>{});
            console.error("League fixtures load failed:", e);
            res.status(500).json({success:false,message:"Failed to load live fixtures."});
        } finally {
            client.release();
        }
    });

    router.get("/:id", async (req, res) => {
        res.set("Cache-Control", "no-store");
        const l = await findLeague(pool, req.params.id);
        if (!l) return res.status(404).json({ success: false, message: "League not found." });
        const s = await pool.query(`SELECT m.*, u.username
            FROM efootball_league_members m JOIN users u ON u.id = m.user_id
            WHERE m.league_id = $1
            ORDER BY m.points DESC, m.goal_difference DESC, m.goals_for DESC, m.wins DESC, u.username ASC`, [l.id]);
        res.json({ success: true, league: l, standings: s.rows });
    });

    // League entry fees move to the platform wallet atomically with membership.
    router.post("/:id/join", authenticateToken, requireKonamiCompanion, async (req, res) => {
        const uid = Number(req.user.userId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const u = await client.query("SELECT game,account_status FROM users WHERE id = $1", [uid]);
            if (!u.rows.length || u.rows[0].account_status !== "active") {
                throw Object.assign(new Error("Your account cannot join an eFootball league."), { status: 403 });
            }
            if (!['konami','both'].includes(u.rows[0].game)) {
                throw Object.assign(new Error("Your account is not registered for eFootball."), { status: 403 });
            }

            const foundLeague = await findLeague(client, req.params.id);
            const league = foundLeague
                ? (await client.query("SELECT * FROM efootball_leagues WHERE id=$1 FOR UPDATE", [foundLeague.id])).rows[0]
                : null;
            if (!league) throw new Error("League not found.");

            const already = await client.query(
                "SELECT 1 FROM efootball_league_members WHERE league_id = $1 AND user_id = $2",
                [league.id, uid]);
            if (already.rows.length) {
                await client.query("ROLLBACK");
                return res.json({ success: true, alreadyJoined: true, message: "You are already in the " + league.name + " League." });
            }

            if (league.status !== "open") {
                throw Object.assign(new Error("This league season has started or ended and is no longer accepting entries."), { status: 409 });
            }

            const count = await client.query(
                "SELECT COUNT(*)::int AS n FROM efootball_league_members WHERE league_id = $1", [league.id]);
            if (count.rows[0].n >= MAX_LEAGUE_PLAYERS) throw new Error(league.name + " League is full.");

            const fee = Number(league.entry_stake);
            if (!Number.isFinite(fee) || fee < 0) {
                throw Object.assign(new Error("This league has an invalid entry fee and cannot accept entries."), { status: 500 });
            }
            let entryReference = null;
            if (fee > 0) {
                const w = await client.query(
                    `UPDATE wallets SET balance = balance - $1, updated_at = NOW()
                      WHERE user_id = $2 AND balance >= $1 RETURNING balance`, [fee, uid]);
                if (!w.rows.length) {
                    throw Object.assign(
                        new Error("Insufficient available wallet balance. You need KSh " + fee.toFixed(2) + " to join the " + league.name + " League."),
                        { status: 402 }
                    );
                }
                entryReference = `LEAGUE-${league.id}-${uid}-${randomUUID()}`;
                await client.query(
                    `INSERT INTO transactions(user_id, transaction_type, amount, currency, status, reference, description)
                     VALUES($1, 'league_entry', $2, 'KES', 'completed', $3, $4)`,
                    [uid, fee, entryReference, league.name + " League entry fee"]);
                await creditPlatform(client, {
                    amount: fee,
                    reference: entryReference,
                    transactionType: "league_entry_fee",
                    description: league.name + " League entry fee",
                    context: { competitionType: "league", competitionId: Number(league.id), userId: uid },
                    reserve: true,
                    debitPostings: [{ accountType: "user_wallet_available", accountId: uid, debit: fee }]
                });
            }

            await client.query(
                `INSERT INTO efootball_league_members(league_id, user_id, fee_paid, fee_transferred, entry_reference)
                 VALUES($1,$2,$3,$4,$5)`,
                [league.id, uid, fee, fee > 0, entryReference]);
            await client.query("COMMIT");
            res.json({ success: true, message: "Joined the " + league.name + " League.", entryFee: fee });
        } catch (e) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            const status = Number(e && e.status);
            if (status >= 400 && status < 500) return res.status(status).json({ success: false, message: e.message });
            console.error("League entry failed:", e && e.message);
            res.status(500).json({ success: false, message: "Could not join this league. Try again." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/cancel", authenticateToken, requireKonamiCompanion, async (req, res) => {
        const uid = Number(req.user.userId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const league = await findLeague(client, req.params.id);
            if (!league) throw Object.assign(new Error("League not found."), { status: 404 });
            await client.query("SELECT id FROM efootball_leagues WHERE id=$1 FOR UPDATE", [league.id]);
            const memberResult = await client.query(
                "SELECT * FROM efootball_league_members WHERE league_id=$1 AND user_id=$2 FOR UPDATE",
                [league.id, uid]
            );
            if (!memberResult.rows.length) throw Object.assign(new Error("You have not joined this league."), { status: 404 });
            const member = memberResult.rows[0];
            const released = await client.query(
                `SELECT 1 FROM efootball_league_fixtures
                  WHERE league_id=$1 AND round_number=1 AND away_id IS NOT NULL
                    AND (home_id=$2 OR away_id=$2) LIMIT 1`,
                [league.id, uid]
            );
            const played = await client.query(
                `SELECT 1 FROM efootball_matches m
                  WHERE (m.league_fixture_id IN (SELECT id FROM efootball_league_fixtures WHERE league_id=$1)
                         OR m.league=$3)
                    AND (m.creator_id=$2 OR m.opponent_id=$2)
                    AND (m.started_at IS NOT NULL OR m.settled_at IS NOT NULL
                         OR m.status IN ('playing','awaiting_verification','disputed','completed'))
                  LIMIT 1 FOR UPDATE`,
                [league.id, uid, league.name]
            );
            if (released.rows.length || played.rows.length || Number(member.played || 0) > 0 || member.forfeited_at) {
                throw Object.assign(new Error("League entry can only be cancelled before your first opponent fixture is released."), { status: 409 });
            }

            const fee = Math.max(0, Number(member.fee_paid || 0));
            if (fee > 0) {
                const reference = `LEAGUE-CANCEL-${league.id}-${uid}-${crypto.randomUUID()}`;
                if (member.fee_transferred && member.entry_reference) {
                    await refundReservedPlatformFee(client, {
                        entryReference: member.entry_reference, amount: fee, userId: uid, reference,
                        transactionType: "league_entry_refund", description: league.name + " League entry refunded",
                        context: { competitionType: "league", competitionId: Number(league.id), userId: uid }
                    });
                } else {
                    const refund = await client.query(
                        `UPDATE wallets SET locked_balance=locked_balance-$1,balance=balance+$1,updated_at=NOW()
                          WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`, [fee, uid]);
                    if (!refund.rows.length) throw new Error("The locked league stake could not be refunded safely.");
                    await client.query(
                        `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                         VALUES($1,'league_refund',$2,'KES','completed',$3,$4)`,
                        [uid, fee, reference, league.name + " League entry refunded"]);
                    await recordJournal(client, {
                        reference: `LEAGUE-LEGACY-REFUND-${league.id}-${uid}-${randomUUID()}`,
                        transactionType: "legacy_league_entry_refund",
                        amount: fee,
                        description: league.name + " legacy League entry fee returned",
                        context: { competitionType: "league", competitionId: Number(league.id), userId: uid },
                        postings: [
                            { accountType: "user_wallet_locked", accountId: uid, debit: fee },
                            { accountType: "user_wallet_available", accountId: uid, credit: fee }
                        ]
                    });
                }
            }
            await client.query(
                `DELETE FROM efootball_league_fixtures
                  WHERE league_id=$1 AND round_number=1 AND away_id IS NULL
                    AND (home_id=$2 OR away_id=$2)`,
                [league.id, uid]
            );
            await client.query("DELETE FROM efootball_league_members WHERE league_id=$1 AND user_id=$2", [league.id, uid]);
            await client.query("COMMIT");
            return res.json({
                success: true,
                refunded: fee,
                message: fee > 0
                    ? "League entry cancelled. KSh " + fee.toFixed(2) + " was returned to your available wallet balance."
                    : "League entry cancelled."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (Number(error.status) >= 400 && Number(error.status) < 500) return res.status(error.status).json({ success: false, message: error.message });
            console.error("League cancellation error:", error.message);
            return res.status(500).json({ success: false, message: "Could not cancel your league entry safely." });
        } finally {
            client.release();
        }
    });

    router.post("/:id/forfeit", authenticateToken, requireKonamiCompanion, async (req, res) => {
        const uid = Number(req.user.userId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const league = await findLeague(client, req.params.id);
            if (!league) throw Object.assign(new Error("League not found."), { status: 404 });
            await client.query("SELECT id FROM efootball_leagues WHERE id=$1 FOR UPDATE", [league.id]);
            const memberResult = await client.query(
                "SELECT * FROM efootball_league_members WHERE league_id=$1 AND user_id=$2 FOR UPDATE",
                [league.id, uid]
            );
            if (!memberResult.rows.length) throw Object.assign(new Error("You have not joined this league."), { status: 404 });
            const member = memberResult.rows[0];
            if (member.forfeited_at) throw Object.assign(new Error("You have already forfeited this league."), { status: 409 });
            if (Number(member.played || 0) > 0) {
                throw Object.assign(new Error("You can only forfeit before your first league match is played."), { status: 409 });
            }

            const fixtureResult = await client.query(
                `SELECT * FROM efootball_league_fixtures
                  WHERE league_id=$1 AND round_number=1 AND away_id IS NOT NULL
                    AND (home_id=$2 OR away_id=$2) AND status IN ('scheduled','playing')
                  ORDER BY id LIMIT 1 FOR UPDATE`,
                [league.id, uid]
            );
            if (!fixtureResult.rows.length) {
                throw Object.assign(new Error("Forfeiting becomes available after your first opponent fixture is released."), { status: 409 });
            }
            const fixture = fixtureResult.rows[0];
            const matchResult = fixture.match_id
                ? await client.query("SELECT * FROM efootball_matches WHERE id=$1 FOR UPDATE", [fixture.match_id])
                : { rows: [] };
            const match = matchResult.rows[0] || null;
            if (match && (match.started_at || match.settled_at ||
                ["playing", "awaiting_verification", "disputed", "completed"].includes(String(match.status)))) {
                throw Object.assign(new Error("Your first league match has already started. Forfeiting is no longer available."), { status: 409 });
            }

            const fee = Math.max(0, Number(member.fee_paid || 0));
            if (!Number.isFinite(fee)) throw Object.assign(new Error("The league stake is invalid."), { status: 500 });
            const legacyLockedFee = fee > 0 && !member.fee_transferred;
            const admins = legacyLockedFee
                ? await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE")
                : { rows: [] };
            if (legacyLockedFee && admins.rows.length < 2) {
                throw Object.assign(new Error("Both administrator accounts must be available before this stake can be forfeited."), { status: 409 });
            }

            if (match) {
                await client.query(
                    `UPDATE efootball_matches
                        SET status='cancelled',result_status='league_entry_forfeit',
                            finished_at=NOW(),settled_at=NOW(),search_last_seen_at=NULL,
                            creator_ready=FALSE,opponent_ready=FALSE,external_room_code=NULL,
                            code_sent=FALSE,code_sender_id=NULL
                      WHERE id=$1 AND started_at IS NULL AND settled_at IS NULL
                        AND status IN ('waiting','ready')`,
                    [match.id]
                );
                await client.query("UPDATE efootball_league_fixtures SET match_id=NULL WHERE id=$1", [fixture.id]);
            }

            if (legacyLockedFee) {
                const transfer = await client.query(
                    `UPDATE wallets SET locked_balance=locked_balance-$1,updated_at=NOW()
                      WHERE user_id=$2 AND locked_balance >= $1 RETURNING user_id`,
                    [fee, uid]
                );
                if (!transfer.rows.length) throw new Error("The locked league stake could not be transferred safely.");
                const reference = `LEAGUE-FORFEIT-${league.id}-${uid}-${crypto.randomUUID()}`;
                await creditPlatform(client, {
                    amount: fee, reference, transactionType: "league_forfeit_stake",
                    description: league.name + " League forfeited entry fee",
                    context: { competitionType: "league", competitionId: Number(league.id), userId: uid, forfeiture: true },
                    reserve: true,
                    debitPostings: [{ accountType: "user_wallet_locked", accountId: uid, debit: fee }]
                });
                await client.query(
                    `INSERT INTO transactions(user_id,transaction_type,amount,currency,status,reference,description)
                     VALUES($1,'league_forfeit',$2,'KES','completed',$3,$4)`,
                    [uid, fee, reference, league.name + " League stake forfeited to both administrator wallets"]
                );
                await client.query(
                    "UPDATE efootball_league_members SET fee_transferred=TRUE,entry_reference=$1 WHERE league_id=$2 AND user_id=$3",
                    [reference, league.id, uid]);
            }

            const userIsHome = Number(fixture.home_id) === uid;
            const winnerId = userIsHome ? Number(fixture.away_id) : Number(fixture.home_id);
            const recorded = await recordLeagueFixtureResult(client, fixture, {
                status: "walkover",
                homeScore: userIsHome ? 0 : 3,
                awayScore: userIsHome ? 3 : 0,
                winnerId
            });
            if (!recorded) throw Object.assign(new Error("This league fixture has already been settled."), { status: 409 });
            await client.query(
                "UPDATE efootball_league_members SET forfeited_at=NOW() WHERE league_id=$1 AND user_id=$2",
                [league.id, uid]
            );
            await client.query("COMMIT");
            return res.json({
                success: true,
                forfeited: true,
                stakeTransferred: fee,
                message: fee > 0
                    ? "League forfeited. Your KSh " + fee.toFixed(2) + " stake will not be refunded, and your opponent received a walkover."
                    : "League forfeited. Your opponent received a walkover."
            });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (Number(error.status) >= 400 && Number(error.status) < 500) return res.status(error.status).json({ success: false, message: error.message });
            console.error("League forfeiture error:", error.message);
            return res.status(500).json({ success: false, message: "Could not forfeit the league entry safely." });
        } finally {
            client.release();
        }
    });

    return router;
};
