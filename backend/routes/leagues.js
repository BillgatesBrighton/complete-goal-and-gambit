"use strict";
const express = require("express");
const gameAccess = require("../middleware/gameAccess");

const MAX_LEAGUE_PLAYERS = 20;

module.exports = function (pool, authenticateToken) {
    const router = express.Router();

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

    router.get("/:id/fixtures", authenticateToken, async (req,res)=>{
        try {
            const l=await findLeague(pool,req.params.id);
            if(!l) return res.status(404).json({success:false,message:"League not found."});
            res.set("Cache-Control", "no-store");
            const r=await pool.query(`
                SELECT m.id,m.creator_id AS home_id,m.opponent_id AS away_id,
                       hu.username AS home,au.username AS away,m.round_name,m.status,
                       CASE WHEN m.status='completed' THEN m.creator_score END AS home_score,
                       CASE WHEN m.status='completed' THEN m.opponent_score END AS away_score,
                       m.created_at,m.started_at,m.finished_at
                FROM efootball_matches m
                JOIN users hu ON hu.id=m.creator_id
                LEFT JOIN users au ON au.id=m.opponent_id
                WHERE m.league=$1
                ORDER BY COALESCE(m.started_at,m.created_at) DESC,m.id DESC
                LIMIT 100`,[l.name]);
            const me=Number(req.user.userId);
            res.json({success:true,league:l,fixtures:r.rows.map(x=>({...x,id:Number(x.id),home_id:Number(x.home_id),away_id:x.away_id===null?null:Number(x.away_id),home_score:x.home_score===null?null:Number(x.home_score),away_score:x.away_score===null?null:Number(x.away_score),mine:me===Number(x.home_id)||me===Number(x.away_id)}))});
        } catch(e){res.status(500).json({success:false,message:"Failed to load live fixtures."});}
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

    // Joining charges the entry stake from the wallet. No balance = no entry.
    router.post("/:id/join", authenticateToken, async (req, res) => {
        const uid = Number(req.user.userId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const u = await client.query("SELECT game FROM users WHERE id = $1", [uid]);
            if (u.rows.length && u.rows[0].game === "chess") {
                throw new Error("Your account is registered for Chess only.");
            }

            const league = await findLeague(client, req.params.id);
            if (!league) throw new Error("League not found.");

            const already = await client.query(
                "SELECT 1 FROM efootball_league_members WHERE league_id = $1 AND user_id = $2",
                [league.id, uid]);
            if (already.rows.length) {
                await client.query("ROLLBACK");
                return res.json({ success: true, alreadyJoined: true, message: "You are already in the " + league.name + " League." });
            }

            const count = await client.query(
                "SELECT COUNT(*)::int AS n FROM efootball_league_members WHERE league_id = $1", [league.id]);
            if (count.rows[0].n >= MAX_LEAGUE_PLAYERS) throw new Error(league.name + " League is full.");

            const fee = Number(league.entry_stake || 0);
            if (fee > 0) {
                const w = await client.query(
                    `UPDATE wallets SET balance = balance - $1, locked_balance = locked_balance + $1, updated_at = NOW()
                      WHERE user_id = $2 AND balance >= $1 RETURNING balance`, [fee, uid]);
                if (!w.rows.length) throw new Error("Insufficient wallet balance. You need KSh " + fee + " to join the " + league.name + " League.");
                await client.query(
                    `INSERT INTO transactions(user_id, transaction_type, amount, currency, status, reference, description)
                     VALUES($1, 'league_entry', $2, 'KES', 'completed', $3, $4)`,
                    [uid, fee, `LEAGUE-${league.id}-${uid}-${Date.now()}`, league.name + " League entry fee"]);
            }

            await client.query(
                "INSERT INTO efootball_league_members(league_id, user_id, fee_paid) VALUES($1, $2, $3)",
                [league.id, uid, fee]);
            await client.query("COMMIT");
            res.json({ success: true, message: "Joined the " + league.name + " League.", entryFee: fee });
        } catch (e) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            res.status(400).json({ success: false, message: e.message });
        } finally {
            client.release();
        }
    });

    return router;
};
