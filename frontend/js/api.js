/* =========================================================
   GOAL$GAMBIT shared API helper
   Include on any page that talks to the backend:
   <script src="../js/api.js"></script>
========================================================= */
(function () {
    "use strict";

    // Use port 5000 for file previews and common local frontend servers.
    // A custom local backend port (for example :5001) remains same-origin.
    var host = location.hostname;
    var isLocal = host === "localhost" || host === "127.0.0.1";
    var frontendPorts = ["3000", "5173", "5500", "8080"];
    var needsDefaultBackend = location.protocol === "file:" ||
        (isLocal && (!location.port || frontendPorts.indexOf(location.port) !== -1));
    var githubPagesBackend = host === "billgatesbrighton.github.io"
        ? "https://desktop-elb0fth.taildd904a.ts.net"
        : "";
    var API_BASE = window.GG_API_BASE ||
        (needsDefaultBackend ? "http://localhost:5000" : githubPagesBackend);

    var TOKEN_KEY = "goalGambitToken";

    function getToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    function saveSession(token, user, game) {
        game = user.game || game || "";
        localStorage.setItem(TOKEN_KEY, token);
        if (user.rating != null) localStorage.setItem("goalGambitRating", String(user.rating));
        localStorage.setItem("goalGambitGame", game);
        localStorage.setItem("goalGambitUsername", user.username);
        if (user.id != null) localStorage.setItem("goalGambitUserId", String(user.id));
        localStorage.setItem("goalGambitLoggedIn", "true");

        // Safe copy of the account for older pages. NO password is stored.
        var previous = {};
        try { previous = JSON.parse(localStorage.getItem("goalGambitAccount") || "{}") || {}; } catch (e) {}
        localStorage.setItem("goalGambitAccount", JSON.stringify({
            username: user.username,
            phone: user.phone || previous.phone || "",
            game: game || previous.game || ""
        }));
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem("goalGambitLoggedIn");
        localStorage.removeItem("goalGambitAccount");
        localStorage.removeItem("goalGambitUsername");
        localStorage.removeItem("goalGambitUserId");
        localStorage.removeItem("goalGambitBalance");
        localStorage.removeItem("goalGambitRating");
        localStorage.removeItem("goalGambitGame");
        localStorage.removeItem("goalGambitCurrentMatch");
        localStorage.removeItem("goalGambitTransactions");
    }

    function logout() {
        clearSession();
        location.href = "login.html";
    }

    // Sends the request with the login token. Always resolves to
    // { ok, status, data } and never throws on HTTP errors.
    async function api(path, options) {
        options = options || {};
        var headers = { "Accept": "application/json" };
        var isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
        if (options.body !== undefined && !isFormData) headers["Content-Type"] = "application/json";
        var token = getToken();
        if (token) headers["Authorization"] = "Bearer " + token;

        try {
            var response = await fetch(API_BASE + path, {
                method: options.method || "GET",
                headers: headers,
                body: options.body === undefined ? undefined :
                    (isFormData ? options.body : JSON.stringify(options.body))
            });

            var data = null;
            try { data = await response.json(); } catch (e) {}

            if (response.status === 401 && token && !options.noRedirect) {
                clearSession();
                location.href = "login.html";
            }

            return { ok: response.ok, status: response.status, data: data || {} };
        } catch (error) {
            return {
                ok: false,
                status: 0,
                data: { message: "Cannot reach the server. Make sure the backend is running." }
            };
        }
    }

    // Call at the top of any page that needs a logged-in user.
    function requireLogin() {
        if (!getToken()) {
            location.href = "login.html";
            return false;
        }
        return true;
    }


    // ------------------------------------------------------------------
    // Wallet / profile helpers shared by every dashboard and match page
    // ------------------------------------------------------------------
    function formatMoney(amount) {
        return "KSh " + Number(amount || 0).toLocaleString("en-KE", {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        });
    }

    // Reads the real wallet balance from the server and caches it.
    async function refreshBalance() {
        var w = await api("/api/wallet");
        if (w.ok && w.data.wallet) {
            var b = Number(w.data.wallet.balance) || 0;
            localStorage.setItem("goalGambitBalance", b.toFixed(2));
            return b;
        }
        return null;
    }

    // True when the wallet can cover `amount`. Shows a message if not.
    async function hasBalance(amount) {
        amount = Number(amount) || 0;
        if (amount <= 0) return true;
        var balance = await refreshBalance();
        if (balance === null) {
            alert("Could not check your wallet balance. Make sure the server is running.");
            return false;
        }
        if (balance < amount) {
            if (confirm("Insufficient balance. You need KSh " + amount + " but only have " +
                formatMoney(balance) + ".\n\nOpen your wallet to deposit?")) {
                location.href = "wallet.html";
            }
            return false;
        }
        return true;
    }

    // Used by the chess ranked / tournament pages: checks the account's
    // game and the wallet balance, then opens the board.
    async function guardedGo(url, stake, game) {
        if (!getToken()) { location.href = "login.html"; return; }
        var me = await api("/api/me");
        if (me.ok && me.data.user && game) {
            var g = me.data.user.game;
            if (g !== "both" && g !== game) {
                alert("Your account is registered for " + (g === "konami" ? "Konami eFootball" : "Chess") + " only.");
                return;
            }
        }
        if (await hasBalance(stake)) location.href = url;
    }

    // Home page for a given game choice.
    function homeFor(user) {
        return gameHome(user && user.game);
    }

    function gameHome(game) {
        game = String(game || "").trim().toLowerCase();

        if (game === "chess") return "chess.html";
        if (game === "konami") return "konami.html";
        if (game === "both") return "both.html";

        return "dashboard.html";
    }

    // Call at the top of a dashboard. Sends players of the wrong game to
    // their own dashboard, then fills in username, rating and balance.
    //   GG.initDashboard("chess")  -> chess.html  (chess + both players)
    //   GG.initDashboard("konami") -> konami.html (konami + both players)
    //   GG.initDashboard("both")   -> both.html   (players who chose both)
    async function initDashboard(page) {
        if (!requireLogin()) return null;
        var me = await api("/api/me");
        if (!me.ok || !me.data.user) return null;
        var user = me.data.user;

        // Each dashboard is only for the matching signup choice.
        // "both" players use both.html and may also open chess.html / konami.html.
        var allowed = page === "both" ? ["both"] : [page, "both"];
        if (allowed.indexOf(user.game) === -1) {
            location.replace(gameHome(user.game));
            return null;
        }

        localStorage.setItem("goalGambitUsername", user.username);
        localStorage.setItem("goalGambitGame", user.game || "");
        localStorage.setItem("goalGambitRating", String(user.rating));
        localStorage.setItem("goalGambitUserId", String(user.id));
        try {
            var acc = JSON.parse(localStorage.getItem("goalGambitAccount") || "{}") || {};
            acc.username = user.username; acc.phone = user.phone; acc.game = user.game;
            localStorage.setItem("goalGambitAccount", JSON.stringify(acc));
        } catch (e) {}

        fillProfile(user);
        var balance = await refreshBalance();
        if (balance !== null) fillBalance(balance);
        return user;
    }

    function fillProfile(user) {
        document.querySelectorAll("[data-gg='username']").forEach(function (el) {
            el.textContent = user.username;
        });
        document.querySelectorAll("[data-gg='rating']").forEach(function (el) {
            el.textContent = user.rating;
        });
        document.querySelectorAll("[data-gg='phone']").forEach(function (el) {
            el.textContent = user.phone || "-";
        });
    }

    function fillBalance(balance) {
        document.querySelectorAll("[data-gg='balance']").forEach(function (el) {
            el.textContent = formatMoney(balance);
        });
    }

    window.GG = {
        API_BASE: API_BASE,
        api: api,
        getToken: getToken,
        saveSession: saveSession,
        clearSession: clearSession,
        logout: logout,
        requireLogin: requireLogin,
        refreshBalance: refreshBalance,
        hasBalance: hasBalance,
        guardedGo: guardedGo,
        homeFor: homeFor,
        initDashboard: initDashboard,
        fillProfile: fillProfile,
        fillBalance: fillBalance,
        formatMoney: formatMoney,
        escapeHTML: function (value) {
            return String(value == null ? "" : value)
                .replace(/&/g, "&amp;").replace(/</g, "&lt;")
                .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        },
        gameHome: gameHome
    };

    // Show a shared maintenance banner when the backend or database is unreachable.
    // The health probe is read-only, unauthenticated, and never sends payment data.
    function initServerStatus() {
        if (window.__GG_STATUS_MONITOR_STARTED || !document.body) return;
        window.__GG_STATUS_MONITOR_STARTED = true;

        var banner = document.createElement("div");
        banner.id = "gg-server-status";
        banner.hidden = true;
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        banner.style.cssText = [
            "box-sizing:border-box",
            "display:none",
            "position:sticky",
            "top:0",
            "z-index:2147483000",
            "width:100%",
            "padding:11px 16px",
            "text-align:center",
            "font:600 14px/1.45 Arial,Helvetica,sans-serif",
            "color:#fff7ed",
            "background:#2b1710",
            "border-bottom:2px solid #f4bd20",
            "box-shadow:0 3px 12px rgba(0,0,0,.3)"
        ].join(";");

        // Put the status at the top of the page so it stays visible while scrolling.
        document.body.insertBefore(banner, document.body.firstChild);

        var wasOffline = false;
        var recoveryTimer = null;
        var healthBase = API_BASE || location.origin;
        if (!healthBase || healthBase === "null" || location.protocol === "file:") {
            healthBase = "http://localhost:5000";
        }
        healthBase = healthBase.replace(/\/+$/, "");

        function showOffline() {
            window.clearTimeout(recoveryTimer);
            wasOffline = true;
            banner.textContent = "⚠ Server under maintenance. The server or database is offline, so some features are unavailable. Please try again shortly.";
            banner.style.background = "#2b1710";
            banner.style.color = "#fff7ed";
            banner.style.borderBottomColor = "#f4bd20";
            banner.setAttribute("role", "alert");
            banner.setAttribute("aria-live", "assertive");
            banner.hidden = false;
            banner.style.display = "block";
        }

        function showOnline() {
            if (wasOffline) {
                wasOffline = false;
                banner.textContent = "Server connection restored.";
                banner.style.background = "#123021";
                banner.style.color = "#e9fff1";
                banner.style.borderBottomColor = "#56c781";
                banner.setAttribute("role", "status");
                banner.setAttribute("aria-live", "polite");
                banner.hidden = false;
                banner.style.display = "block";
                recoveryTimer = window.setTimeout(function () {
                    banner.hidden = true;
                    banner.style.display = "none";
                }, 4500);
            } else if (!recoveryTimer) {
                banner.hidden = true;
                banner.style.display = "none";
            }
        }

        async function checkServer() {
            var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
            var timeout = window.setTimeout(function () {
                if (controller) controller.abort();
            }, 7000);
            try {
                var response = await fetch(healthBase + "/api/health", {
                    method: "GET",
                    headers: { "Accept": "application/json" },
                    cache: "no-store",
                    credentials: "omit",
                    signal: controller ? controller.signal : undefined
                });
                var health = await response.json();
                if (response.ok && health && health.success === true && health.database === "connected") {
                    showOnline();
                } else {
                    showOffline();
                }
            } catch (error) {
                showOffline();
            } finally {
                window.clearTimeout(timeout);
            }
        }

        checkServer();
        window.setInterval(checkServer, 25000);
    }

    initServerStatus();

})();
