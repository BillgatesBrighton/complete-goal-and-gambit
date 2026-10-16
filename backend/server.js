"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const pg = require("pg");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

require("dotenv").config({
    path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, ".env")
});

// ======================================================
// ROUTES & MIDDLEWARE
// ======================================================

const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallet");
const userHistoryRoutes = require("./routes/userHistory");
const chessRoutes = require("./routes/chess");
const leaderboardRoutes = require("./routes/leaderboard");
const chessCompetitionRoutes = require("./routes/chessCompetitions");
const efootballRoutes = require("./routes/efootball");
const createPushRoutes = require("./routes/push");
const createWebPushService = require("./services/webPush");
const createAndroidPushService = require("./services/androidPush");
const tournamentRoutes = require("./routes/tournaments");
const leagueRoutes = require("./routes/leagues");
const mpesaRoutes = require("./routes/mpesa");
const mpesaB2cFactory = require("./services/mpesaB2c");
const mpesaC2bFactory = require("./services/mpesaC2b");
const adminRoutes = require("./routes/admin");
const adminMatchManagementRoutes = require("./routes/adminMatchManagement");
const adminComplaintCases = require("./routes/adminComplaintCases");
const adminWalletRoutes = require("./routes/adminWallet");
const chatRoutes = require("./routes/chat");
const authenticateToken = require("./middleware/authMiddleware");
const gameAccess = require("./middleware/gameAccess");
const repairDuplicateSupportThreads = require("./db/repairSupportThreads");

// ======================================================
// EXPRESS APPLICATION
// ======================================================

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 5000;
const HOST = String(process.env.HOST || "127.0.0.1");

// ======================================================
// BASIC VALIDATION
// ======================================================

if (!process.env.JWT_SECRET) {

    console.error(
        "ERROR: JWT_SECRET is missing from your .env file."
    );

    process.exit(1);

}

// ======================================================
// POSTGRESQL CONNECTION
// ======================================================

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const databaseConfig = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    };

const pool = new pg.Pool({
    ...databaseConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
const webPushService = createWebPushService(pool);
const androidPushService = createAndroidPushService(pool);
const pushService = {
    status: function () {
        return Object.assign({}, webPushService.status(), {
            androidConfigured: androidPushService.status().configured
        });
    },
    enqueueNotification: async function (client, userId, notification) {
        const event = await webPushService.enqueueNotification(client, userId, notification);
        if (event.created) {
            await client.query("SAVEPOINT android_push_enqueue");
            try {
                await androidPushService.enqueueNotification(client, event.id, userId);
                await client.query("RELEASE SAVEPOINT android_push_enqueue");
            } catch (error) {
                await client.query("ROLLBACK TO SAVEPOINT android_push_enqueue").catch(function () {});
                await client.query("RELEASE SAVEPOINT android_push_enqueue").catch(function () {});
                console.error("Android push enqueue failed; match action remains committed.");
            }
        }
        return event;
    },
    sendPendingJobs: function () {
        return Promise.allSettled([
            webPushService.sendPendingJobs(),
            androidPushService.sendPendingJobs()
        ]);
    },
    start: function () {
        webPushService.start();
        androidPushService.start();
    },
    stop: function () {
        webPushService.stop();
        androidPushService.stop();
    }
};

authenticateToken.setPool(pool);

pool.on("error", function(error) {

    console.error(
        "Unexpected PostgreSQL pool error:"
    );

    console.error(error);

});

// ======================================================
// CORS
// ======================================================

const allowedOrigins = [

    "http://localhost:5500",

    "http://127.0.0.1:5500",

    "http://localhost:3000",

    "http://127.0.0.1:3000",

    "http://localhost:5173",

    "http://127.0.0.1:5173",

    "http://localhost:8080",

    "http://127.0.0.1:8080",
    "https://billgatesbrighton.github.io",

    "http://localhost:" + PORT,

    "http://127.0.0.1:" + PORT,

    "http://192.168.182.249:" + PORT

].concat(
    String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    String(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(function(o) { return o.trim(); })
        .filter(Boolean)
);

function corsOrigin(origin, callback) {

    // Allow requests that do not contain an Origin header.
    // Useful for Postman and server-to-server requests.

    if (!origin) {

        return callback(null, true);

    }

    // Local file previews send the opaque "null" origin. Permit them only
    // in development; production should always use an explicit site origin.
    if (origin === "null" && process.env.NODE_ENV !== "production") {
        return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {

        return callback(null, true);

    }

    console.warn(
        "Blocked CORS origin:",
        origin
    );

    return callback(
        new Error(
            "Origin not allowed by GOAL$GAMBIT."
        )
    );

}

app.use(
    cors({

        origin: corsOrigin,

        credentials: true

    })

);

// ======================================================
// BODY PARSER
// ======================================================

app.use(
    express.json({

        limit: "10mb"

    })
);

// ======================================================
// SECURITY HEADERS
// ======================================================

app.disable("x-powered-by");

app.use(function(req, res, next) {

    res.set("X-Content-Type-Options", "nosniff");

    res.set("X-Frame-Options", "SAMEORIGIN");

    res.set("Referrer-Policy", "strict-origin-when-cross-origin");

    next();

});

// ======================================================
// BASIC REQUEST LOGGING
// ======================================================

app.use(
    function(req, res, next) {

        const logUrl = req.originalUrl
            .replace(
                /(\/api\/payments\/payout-(?:result|timeout)\/)[^/?]+/i,
                "$1[redacted]"
            )
            .replace(
                /(\/api\/payments\/c2b-(?:confirmation|validation)\/)[^/?]+/i,
                "$1[redacted]"
            );
        console.log(req.method + " " + logUrl);

        next();

    }
);

// ======================================================
// SOCKET.IO
// ======================================================

const io = new Server(

    server,

    {

        cors: {

            origin: corsOrigin,

            methods: [
                "GET",
                "POST"
            ],

            credentials: true

        }

    }

);

const onlineUserSockets = new Map();

function getOnlineUserIds() {
    return Array.from(onlineUserSockets.keys());
}

function broadcastOnlineUsers() {
    io.emit("presence:update", { onlineUserIds: getOnlineUserIds() });
}

// ======================================================
// SOCKET.IO AUTHENTICATION
// ======================================================

io.use(
    async function(socket, next) {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) return next(new Error("Authentication token required."));

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (_) {
            return next(new Error("Invalid or expired authentication token."));
        }

        const userId = Number(decoded && decoded.userId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return next(new Error("Invalid authentication token."));
        }

        try {
            const result = await pool.query(
                `SELECT id, username, role, account_status, suspended_until, auth_version
                 FROM users WHERE id = $1`,
                [userId]
            );
            if (!result.rows.length) {
                return next(new Error("Account not found."));
            }

            let user = result.rows[0];
            if (Number(decoded.authVersion || 0) !== Number(user.auth_version || 0)) {
                return next(new Error("Session expired after an account change."));
            }
            if (user.account_status === "suspended" && user.suspended_until) {
                const activated = await pool.query(
                    `UPDATE users
                     SET account_status = 'active', suspended_until = NULL
                     WHERE id = $1 AND account_status = 'suspended'
                       AND suspended_until <= NOW()
                     RETURNING id`,
                    [user.id]
                );
                if (activated.rows.length) {
                    user.account_status = "active";
                    user.suspended_until = null;
                } else {
                    const current = await pool.query(
                        `SELECT id, username, role, account_status, suspended_until, auth_version
                         FROM users WHERE id = $1`,
                        [user.id]
                    );
                    if (!current.rows.length) return next(new Error("Account not found."));
                    user = current.rows[0];
                }
            }

            if (user.account_status === "closed") {
                return next(new Error("This account has been closed."));
            }
            if (user.account_status === "suspended") {
                return next(new Error("This account is currently suspended."));
            }

            socket.user = {
                ...decoded,
                userId: user.id,
                username: user.username,
                role: user.role
            };
            return next();
        } catch (error) {
            console.error("Socket account check failed:", error.message);
            return next(new Error("Account access could not be verified right now."));
        }
    }
);

// ======================================================
// SOCKET.IO CONNECTION
// ======================================================

io.on(
    "connection",
    function(socket) {

        console.log(
            "Socket connected:",
            socket.user.username,
            "| User ID:",
            socket.user.userId
        );

        const presenceUserId = Number(socket.user.userId);
        const connections = onlineUserSockets.get(presenceUserId) || new Set();
        const wasOffline = connections.size === 0;
        connections.add(socket.id);
        onlineUserSockets.set(presenceUserId, connections);
        socket.join("user_" + presenceUserId);
        if (wasOffline) broadcastOnlineUsers();
        else socket.emit("presence:update", { onlineUserIds: getOnlineUserIds() });

        // ==================================================
        // JOIN CHESS MATCH
        // ==================================================

        socket.on(
            "chess:join",
            async function(data) {

                try {

                    const matchId =
                        Number(
                            data &&
                            data.matchId
                        );

                    if (
                        !Number.isInteger(matchId) ||
                        matchId <= 0
                    ) {

                        socket.emit(
                            "chess:error",
                            {

                                success: false,

                                message:
                                    "Invalid match ID."

                            }
                        );

                        return;

                    }

                    const result =
                        await pool.query(
                            `
                            SELECT
                                id,
                                player_white_id,
                                player_black_id,
                                status,
                                result,
                                time_control,
                                match_type,
                                stake_amount
                            FROM chess_matches
                            WHERE id = $1
                            `,
                            [matchId]
                        );

                    if (
                        result.rows.length === 0
                    ) {

                        socket.emit(
                            "chess:error",
                            {

                                success: false,

                                message:
                                    "Chess match not found."

                            }
                        );

                        return;

                    }

                    const match =
                        result.rows[0];

                    const userId =
                        Number(
                            socket.user.userId
                        );

                    const whiteId =
                        Number(
                            match.player_white_id
                        );

                    const blackId =
                        Number(
                            match.player_black_id
                        );

                    if (
                        whiteId !== userId &&
                        blackId !== userId
                    ) {

                        socket.emit(
                            "chess:error",
                            {

                                success: false,

                                message:
                                    "You are not a player in this match."

                            }
                        );

                        return;

                    }

                    const room =
                        "chess_match_" +
                        matchId;

                    socket.join(room);

                    socket.currentChessMatchId =
                        matchId;

                    socket.currentChessRoom =
                        room;

                    console.log(
                        "Player joined chess match:",
                        socket.user.username,
                        "| Match:",
                        matchId,
                        "| Room:",
                        room
                    );

                    socket.emit(
                        "chess:joined",
                        {

                            success: true,

                            matchId,

                            room,

                            status:
                                match.status,

                            result:
                                match.result,

                            timeControl:
                                match.time_control,

                            matchType:
                                match.match_type,

                            stake:
                                Number(
                                    match.stake_amount || 0
                                )

                        }
                    );

                    io.to(room).emit(
                        "chess:player_connected",
                        {

                            success: true,

                            userId,

                            username:
                                socket.user.username,

                            matchId

                        }
                    );

                } catch (error) {

                    console.error(
                        "Chess socket join error:"
                    );

                    console.error(error);

                    socket.emit(
                        "chess:error",
                        {

                            success: false,

                            message:
                                "Failed to join chess match."

                        }
                    );

                }

            }
        );

        // ==================================================
        // CHESS SOCKET SYNC REQUEST
        // ==================================================

        socket.on(
            "chess:sync",
            function(data) {

                const matchId =
                    Number(
                        data &&
                        data.matchId
                    );

                if (
                    !Number.isInteger(matchId) ||
                    matchId <= 0
                ) {

                    socket.emit(
                        "chess:error",
                        {

                            success: false,

                            message:
                                "Invalid match ID."

                        }
                    );

                    return;

                }

                if (
                    socket.currentChessMatchId !==
                    matchId
                ) {

                    socket.emit(
                        "chess:error",
                        {

                            success: false,

                            message:
                                "You are not connected to this match."

                        }
                    );

                    return;

                }

                socket.emit(
                    "chess:sync_ack",
                    {

                        success: true,

                        matchId

                    }
                );

            }
        );

        // ==================================================
        // DISCONNECT
        // ==================================================

        socket.on(
            "disconnect",
            function(reason) {

                console.log(
                    "Socket disconnected:",
                    socket.user
                        ? socket.user.username
                        : "Unknown user",

                    "| Reason:",
                    reason
                );

                const presenceUserId = Number(socket.user && socket.user.userId);
                const connections = onlineUserSockets.get(presenceUserId);
                if (connections) {
                    connections.delete(socket.id);
                    if (connections.size === 0) {
                        onlineUserSockets.delete(presenceUserId);
                        broadcastOnlineUsers();
                    }
                }

                if (
                    socket.currentChessMatchId &&
                    socket.currentChessRoom
                ) {

                    socket.to(
                        socket.currentChessRoom
                    ).emit(
                        "chess:player_disconnected",
                        {

                            success: true,

                            userId:
                                socket.user.userId,

                            username:
                                socket.user.username,

                            matchId:
                                socket.currentChessMatchId

                        }
                    );

                }

            }
        );

    }
);

// ======================================================
// REST API ROUTES
// ======================================================

const mpesaApi = mpesaRoutes(pool, authenticateToken, pushService);
const mpesaB2c = mpesaB2cFactory(pool);
const mpesaC2b = mpesaC2bFactory(pool, authenticateToken);

app.use(
    "/api/auth",
    authRoutes(pool, authenticateToken, io)
);

app.use(
    "/api/wallet",
    walletRoutes(
        pool,
        authenticateToken,
        mpesaB2c,
        mpesaC2b
    )
);

app.use("/api/history", userHistoryRoutes(pool, authenticateToken));

app.use(
    "/api/leaderboard",
    leaderboardRoutes(pool)
);

app.use(
    "/api/push",
    createPushRoutes(pool, authenticateToken, pushService)
);

// Competition tables contain public standings and fixture summaries. Mount
// before the authenticated chess router so these read-only views are public.
app.use(
    "/api/chess/competitions",
    chessCompetitionRoutes(pool, authenticateToken)
);

app.use(
    "/api/chess",
    authenticateToken,
    gameAccess(pool, "chess"),
    chessRoutes(
        pool,
        authenticateToken,
        io
    )
);

app.use(
    "/api/efootball",
    authenticateToken,
    gameAccess(pool, "konami"),
    efootballRoutes(
        pool,
        authenticateToken,
        io,
        pushService
    )
);

app.use(
    "/api/tournaments",
    tournamentRoutes(
        pool,
        authenticateToken
    )
);

app.use(
    "/api/leagues",
    leagueRoutes(
        pool,
        authenticateToken
    )
);

app.use("/api/mpesa", mpesaApi);
// Safaricom callback URLs must avoid the blocked "mpesa" keyword. Keep the
// established API path for the app and expose a clean callback alias.
app.use("/api/payments", mpesaApi);
app.use("/api/payments", mpesaB2c.router);
app.use("/api/payments", mpesaC2b.router);

app.use(
    "/api/chat",
    chatRoutes(pool, authenticateToken, getOnlineUserIds)
);

app.use(
    "/api/admin",
    adminRoutes(pool, authenticateToken, getOnlineUserIds)
);

app.use(
    "/api/admin/matches",
    adminMatchManagementRoutes(pool, authenticateToken)
);

app.use(
    "/api/admin/complaint-cases",
    adminComplaintCases(pool, authenticateToken, pushService)
);

app.use(
    "/api/admin/wallet",
    adminWalletRoutes(pool, authenticateToken, mpesaB2c, pushService)
);

app.get("/api/announcements/current", authenticateToken, async function(req, res) {
    try {
        const r = await pool.query(
            `SELECT a.id,a.message,a.created_at FROM admin_announcements a
             WHERE a.active=TRUE AND a.created_at >= NOW() - INTERVAL '30 days'
               AND NOT EXISTS (
                   SELECT 1 FROM admin_announcement_dismissals d
                   WHERE d.announcement_id=a.id AND d.user_id=$1
               )
             ORDER BY a.created_at DESC,a.id DESC LIMIT 5`,
            [req.user.userId]
        );
        res.json({success:true,announcements:r.rows});
    } catch (error) {
        console.error("Dashboard announcement load error:", error.message);
        res.status(500).json({success:false,message:"Could not load announcements."});
    }
});

app.post("/api/announcements/:id/dismiss", authenticateToken, async function(req, res) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({success:false,message:"Invalid announcement."});
    }
    try {
        const r = await pool.query(
            `INSERT INTO admin_announcement_dismissals(announcement_id,user_id)
             SELECT a.id,$2 FROM admin_announcements a
             WHERE a.id=$1 AND a.active=TRUE
             ON CONFLICT(announcement_id,user_id)
             DO UPDATE SET dismissed_at=NOW()
             RETURNING announcement_id`,
            [id, req.user.userId]
        );
        if (!r.rows.length) {
            return res.status(404).json({success:false,message:"Announcement not found."});
        }
        res.json({success:true});
    } catch (error) {
        console.error("Dashboard announcement dismissal error:", error.message);
        res.status(500).json({success:false,message:"Could not dismiss announcement."});
    }
});

// ======================================================
// PROTECTED AUTHENTICATION TEST
// ======================================================

app.get(
    "/api/protected-test",

    authenticateToken,

    function(req, res) {

        res.json({

            success: true,

            message:
                "Authentication successful.",

            user:
                req.user

        });

    }
);

// ======================================================
// CURRENT USER
// ======================================================

app.get(
    "/api/me",

    authenticateToken,

    async function(req, res) {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        phone,
                        rating,
                        game,
                        role,
                        account_status,
                        suspended_until,
                        created_at
                    FROM users
                    WHERE id = $1
                    `,
                    [req.user.userId]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "User not found."

                });

            }

            res.json({

                success: true,

                user:
                    result.rows[0]

            });

        } catch (error) {

            console.error(
                "Get current user error:"
            );

            console.error(error);

            res.status(500).json({

                success: false,

                message:
                    "Failed to retrieve user."

            });

        }

    }
);

// ======================================================
// ROOT
// ======================================================

app.get(
    "/",
    function(req, res) {

        res.redirect("/pages/index.html");

    }
);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
    "/api/health",

    async function(req, res) {

        let database =
            "disconnected";

        try {

            await pool.query(
                "SELECT 1"
            );

            database =
                "connected";

        } catch (error) {

            database =
                "disconnected";

        }

        res.status(database === "connected" ? 200 : 503).json({

            success:
                database === "connected",

            message:
                "GOAL$GAMBIT API health status.",

            database,

            realtime:
                "Socket.IO enabled",

            chess:
                "Live chess backend enabled"

        });

    }
);

// ======================================================
// DATABASE TEST
// ======================================================

app.get(
    "/api/database-test",

    async function(req, res) {

        if (process.env.NODE_ENV === "production") {

            return res.status(404).json({
                success: false,
                message: "API endpoint not found."
            });

        }

        try {

            const result =
                await pool.query(
                    "SELECT NOW() AS database_time"
                );

            res.json({

                success: true,

                message:
                    "Database connection is working.",

                databaseTime:
                    result.rows[0].database_time

            });

        } catch (error) {

            console.error(
                "Database test error:"
            );

            console.error(error);

            res.status(500).json({

                success: false,

                message:
                    "Database connection failed."

            });

        }

    }
);

// ======================================================
// FRONTEND (served so the site and API share one origin)
// ======================================================

app.get("/", function(req, res) {
    res.redirect(302, "/pages/index.html");
});

// The admin page holds private account and complaint data in its live DOM.
// Avoid restoring a cached copy when navigating back to it.
app.get("/pages/admin.html", function(req, res, next) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    next();
});

app.use(
    express.static(
        path.join(__dirname, "..", "frontend")
    )
);

// ======================================================
// UNKNOWN API ROUTE
// ======================================================

app.use(
    "/api",

    function(req, res) {

        res.status(404).json({

            success: false,

            message:
                "API endpoint not found."

        });

    }
);

// ======================================================
// GENERAL ERROR HANDLER
// ======================================================

app.use(
    function(error, req, res, next) {

        console.error(
            "Unhandled server error:"
        );

        console.error(error);

        res.status(500).json({

            success: false,

            message:
                "Internal server error."

        });

    }
);

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {

    pushService.stop();

    console.log(
        `\n${signal} received. Shutting down GOAL$GAMBIT...`
    );

    const closeServer = server.listening
        ? new Promise(resolve => server.close(resolve))
        : Promise.resolve();

    closeServer.then(
        async function() {

            try {

                await pool.end();

                console.log(
                    "PostgreSQL pool closed."
                );

                console.log(
                    "GOAL$GAMBIT server stopped."
                );

                process.exit(0);

            } catch (error) {

                console.error(
                    "Shutdown error:"
                );

                console.error(error);

                process.exit(1);

            }

        }
    );

}

process.on(
    "SIGINT",
    function() {

        shutdown("SIGINT");

    }
);

process.on(
    "SIGTERM",
    function() {

        shutdown("SIGTERM");

    }
);

// ======================================================
// START SERVER
// ======================================================

// Apply pending schema changes before listening so pages cannot race an
// unfinished migration. The support-thread repair must precede its index.
async function startServer() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await repairDuplicateSupportThreads(client);
        await client.query(fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8"));
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    pushService.start();
    server.listen(PORT, HOST, function() {

        console.log(
            "===================================="
        );

        console.log(
            "      GOAL$GAMBIT SERVER"
        );

        console.log(
            "===================================="
        );

        console.log(
            "Server running on:"
        );

        console.log(
            `http://${HOST}:${PORT}`
        );

        console.log(
            "Socket.IO realtime server enabled."
        );

        console.log(
            "Authenticated chess connections enabled."
        );

        console.log(
            "===================================="
        );

    });
}

startServer().catch(async function(error) {
    console.error("Database initialization failed:", error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
});
