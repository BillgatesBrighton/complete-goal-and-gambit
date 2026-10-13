"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const chessCompetitionRoutes = require("../routes/chessCompetitions");

test("Chess competition frontend endpoints are mounted and do not return API 404s", async (t) => {
    const queries = [];
    const pool = {
        async query(sql, params) {
            const text = String(sql);
            queries.push({ text, params });
            if (text.includes("SELECT DISTINCT TO_CHAR")) return { rows: [] };
            if (text.includes("WITH player_results")) return { rows: [] };
            if (text.includes("FROM chess_matches m") && text.includes("match_type = 'ranked'")) return { rows: [] };
            if (text.includes("FROM chess_matches m") && text.includes("match_type = 'tournament'")) return { rows: [] };
            if (text.includes("SELECT game,account_status FROM users WHERE id=$1")) {
                return { rows: [{ game: "both", account_status: "active" }] };
            }
            if (text.includes("INSERT INTO chess_tournament_entries")) return { rowCount: 1, rows: [{ id: 91 }] };
            throw new Error("Unexpected Chess competition query: " + text.slice(0, 100));
        }
    };
    const app = express();
    app.use(express.json());
    const authenticateTestUser = (req, _res, next) => {
        req.user = { userId: 73 };
        next();
    };

    // Keep the same order used by server.js: the public competition router must
    // receive these requests before the authenticated /api/chess game router.
    app.use("/api/chess/competitions", chessCompetitionRoutes(pool, authenticateTestUser));
    app.use("/api/chess", (_req, res) => res.status(404).json({ success: false, message: "Chess game route not found." }));
    app.use("/api", (_req, res) => res.status(404).json({ success: false, message: "API endpoint not found." }));

    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port + "/api/chess/competitions";

    const tournament = await fetch(base + "/tournament?timeControl=3%2B2&stake=50");
    assert.equal(tournament.status, 200);
    assert.equal(tournament.headers.get("cache-control"), "no-store");
    assert.deepEqual((await tournament.json()).fixtures, []);

    const league = await fetch(base + "/league");
    assert.equal(league.status, 200);
    assert.deepEqual((await league.json()).standings, []);

    const entry = await fetch(base + "/tournament/entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeControl: "3+2", stake: 50 })
    });
    assert.equal(entry.status, 200);
    assert.equal((await entry.json()).success, true);
    assert.equal(queries.filter((query) => query.text.includes("INSERT INTO chess_tournament_entries")).length, 1);

    const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const frontend = fs.readFileSync(path.join(__dirname, "../../frontend/pages/tournament-lobby.html"), "utf8");
    assert(serverSource.indexOf('"/api/chess/competitions"') < serverSource.indexOf('"/api/chess"'),
        "Chess competition routes must be mounted before the general Chess router");
    assert.match(frontend, /\/api\/chess\/competitions\/tournament\?/,
        "the tournament lobby must call the mounted Chess tournament route");
});
