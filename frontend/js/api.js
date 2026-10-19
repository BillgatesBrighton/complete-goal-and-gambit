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
    var ANDROID_COMPANION_DOWNLOAD_URL = "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-companion.apk";
    var PUBLIC_COMPANION_DOWNLOAD_URL = API_BASE
        ? API_BASE.replace(/\/+$/, "") + "/api/companion/public-download"
        : ANDROID_COMPANION_DOWNLOAD_URL;
    var POST_LOGIN_PATH_KEY = "goalGambitPostLoginPath";
    // Resolve the frontend root from this shared script so the worker stays
    // inside /frontend on GitHub Pages and works from the backend's static root.
    var apiScriptUrl = document.currentScript && document.currentScript.src
        ? new URL(document.currentScript.src, location.href)
        : new URL("js/api.js", location.href);
    var frontendRootUrl = new URL("../", apiScriptUrl);
    var presenceSocket = null;
    var presenceScriptPending = false;
    var onlineUserIds = new Set();

    function getToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    function rememberMatchRoomReturn() {
        if (!/\/pages\/match-room\.html$/i.test(location.pathname)) return;
        var params = new URLSearchParams(location.search || "");
        var matchId = params.get("matchId") || "";
        if (!/^[1-9][0-9]*$/.test(matchId)) return;
        var destination = "match-room.html?matchId=" + encodeURIComponent(matchId);
        if (params.get("action") === "send-code") destination += "&action=send-code";
        try { sessionStorage.setItem(POST_LOGIN_PATH_KEY, destination); } catch (_) {}
    }

    function takePostLoginDestination() {
        var destination = "";
        try {
            destination = sessionStorage.getItem(POST_LOGIN_PATH_KEY) || "";
            sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
        } catch (_) {}
        return /^match-room\.html\?matchId=[1-9][0-9]*(?:&action=send-code)?$/.test(destination)
            ? destination
            : "";
    }

    function publishPresence(ids) {
        onlineUserIds = new Set((Array.isArray(ids) ? ids : []).map(function(id) {
            return String(Number(id));
        }).filter(function(id) { return id !== "NaN" && id !== "0"; }));
        window.dispatchEvent(new CustomEvent("gg:presence-update", {
            detail: { onlineUserIds: Array.from(onlineUserIds) }
        }));
    }

    function disconnectPresence() {
        if (presenceSocket) {
            var socket = presenceSocket;
            presenceSocket = null;
            socket.disconnect();
        }
        publishPresence([]);
    }

    function startPresence() {
        if (!getToken()) return;
        if (presenceSocket && (presenceSocket.connected || presenceSocket.active)) return;

        function connect() {
            if (!window.io || !getToken() || presenceSocket) return;
            var socket = window.io(API_BASE || location.origin, {
                auth: { token: getToken() },
                transports: ["websocket", "polling"]
            });
            presenceSocket = socket;
            socket.on("presence:update", function(data) {
                publishPresence(data && data.onlineUserIds);
            });
            socket.on("efootball:match-update", function(data) {
                window.dispatchEvent(new CustomEvent("gg:match-update", { detail: data || {} }));
            });
            socket.on("efootball:notification", function(data) {
                window.dispatchEvent(new CustomEvent("gg:notification-update", { detail: data || {} }));
            });
            socket.on("disconnect", function(reason) {
                publishPresence([]);
                if (reason === "io server disconnect" && presenceSocket === socket) {
                    presenceSocket = null;
                }
            });
        }

        if (window.io) {
            connect();
            return;
        }
        if (presenceScriptPending) return;
        presenceScriptPending = true;
        var script = document.createElement("script");
        script.src = (API_BASE || location.origin).replace(/\/+$/, "") + "/socket.io/socket.io.js";
        script.async = true;
        script.onload = function() {
            presenceScriptPending = false;
            connect();
        };
        script.onerror = function() {
            presenceScriptPending = false;
            script.remove();
        };
        document.head.appendChild(script);
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
        disconnectPresence();
        startPresence();
    }

    function clearSession() {
        disconnectPresence();
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
        sessionStorage.removeItem("goalGambitPushAlternativeAcknowledged");
    }

    function logout() {
        disablePushNotifications({ silent: true }).catch(function() {}).finally(function() {
            clearSession();
            location.href = "login.html";
        });
    }

    async function downloadCompanionApp(statusTarget) {
        var token = getToken();
        if (!token) {
            if (statusTarget) statusTarget.textContent = "Sign in to download the official companion app.";
            return false;
        }
        if (statusTarget) statusTarget.textContent = "Preparing the official Android app…";
        try {
            var response = await fetch(API_BASE + "/api/companion/download", {
                headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.android.package-archive" },
                cache: "no-store"
            });
            if (!response.ok) {
                var problem = {};
                try { problem = await response.json(); } catch (_) {}
                throw new Error(problem.message || "The companion download could not be started. Try again shortly.");
            }
            var blob = await response.blob();
            if (!blob.size) throw new Error("The downloaded app file is empty. Please try again.");
            var objectUrl = URL.createObjectURL(blob);
            var link = document.createElement("a");
            link.href = objectUrl;
            link.download = "goal-gambit-companion.apk";
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(function() { URL.revokeObjectURL(objectUrl); }, 60000);
            if (statusTarget) statusTarget.textContent = "Download started. Open the APK from your Downloads when it finishes.";
            return true;
        } catch (error) {
            if (statusTarget) statusTarget.textContent = error && error.message ? error.message : "The companion download could not be started.";
            return false;
        }
    }

    function showCompanionWelcomeGuide(statusData) {
        if (!document.body || !getToken() || document.getElementById("gg-companion-welcome-guide")) return;
        if (/\/pages\/(?:login|signup)\.html$/i.test(location.pathname)) return;
        var overlay = document.createElement("div");
        overlay.id = "gg-companion-welcome-guide";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "gg-welcome-title");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.86);font:15px/1.55 Arial,Helvetica,sans-serif;color:#f5f1e4";
        var apk = statusData && statusData.apk || {};
        var card = document.createElement("section");
        card.style.cssText = "box-sizing:border-box;width:min(760px,100%);max-height:calc(100dvh - 24px);overflow:auto;padding:clamp(16px,4vw,30px);border:1px solid #8b7124;border-radius:18px;background:#101112;box-shadow:0 18px 60px #000b";
        card.innerHTML = '<div style="color:#dfb82f;font-size:12px;font-weight:800;letter-spacing:.12em">GOAL$GAMBIT · COMPETE. WIN. EARN.</div>' +
            '<h1 id="gg-welcome-title" style="margin:5px 0 4px;color:#f5d45a;font-size:clamp(24px,5vw,34px)">Welcome to GOAL$GAMBIT</h1>' +
            '<p style="margin:0 0 16px;color:#d5d0c2">Complete this quick setup before continuing. Your guide acknowledgement is separate from installing the app, enabling notifications, or adding wallet funds.</p>' +
            '<div style="display:grid;gap:12px">' +
            '<article style="padding:14px;border:1px solid #343331;border-radius:12px;background:#171819"><h2 style="margin:0 0 6px;color:#f0cb4c;font-size:18px">1 · Get the Android Companion</h2><p style="margin:0 0 10px">Use the official download below on a compatible Android device. Open the downloaded APK from Downloads and follow the installation screens. iPhones do not install Android APK files.</p><div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px"><button id="gg-welcome-download" type="button" style="padding:11px 16px;border:0;border-radius:9px;background:#dfb82f;color:#111;font-weight:800">Download Companion APK</button><span id="gg-welcome-download-status" role="status" aria-live="polite" style="color:#c9c3b5"></span></div><p id="gg-welcome-apk-info" style="margin:8px 0 0;color:#a9a69f;font-size:12px;overflow-wrap:anywhere"></p></article>' +
            '<article style="padding:14px;border:1px solid #343331;border-radius:12px;background:#171819"><h2 style="margin:0 0 6px;color:#f0cb4c;font-size:18px">2 · Understand the Play Protect message</h2><p style="margin:0 0 10px">This app is distributed outside Google Play, so Play Protect may not recognize its developer. The message shown below says the app may be unsafe; it is not proof that the app is safe or harmful. Install only if you trust the official GOAL$GAMBIT website and can verify the APK. If Android blocks it and you cannot verify it, stop.</p><img id="gg-welcome-protect-image" alt="Example Google Play Protect warning for GOAL$GAMBIT Companion" style="display:block;width:min(100%,360px);height:auto;margin:0 auto;border:1px solid #4b4635;border-radius:10px"><p style="margin:7px 0 0;color:#aaa;font-size:12px">Example of the Google Play Protect warning that may appear when installing outside Google Play.</p></article>' +
            '<article style="padding:14px;border:1px solid #343331;border-radius:12px;background:#171819"><h2 style="margin:0 0 6px;color:#f0cb4c;font-size:18px">3 · Sign in and allow notifications</h2><p style="margin:0">Open GOAL$GAMBIT Companion and sign in with your existing account. Allow notifications when Android asks. If you denied them earlier, enable them in Android Settings under the app. Notifications can help with match alerts and room-code communication; delivery also depends on your device notification and battery settings.</p></article>' +
            '<article style="padding:14px;border:1px solid #343331;border-radius:12px;background:#171819"><h2 style="margin:0 0 6px;color:#f0cb4c;font-size:18px">4 · Fund your wallet before paid competitions</h2><p style="margin:0 0 10px">Open Wallet, choose Deposit, enter an amount, and follow the official payment instructions. Wait until the deposit is confirmed and visible as available balance. Pending deposits and funds locked in another match are not available entry funds. Review the entry fee and prize rules, never pay an administrator personally, and only deposit what you can afford to lose.</p><a href="wallet.html" style="display:inline-block;padding:10px 14px;border:1px solid #dfb82f;border-radius:9px;color:#f0cb4c;font-weight:800;text-decoration:none">Open Wallet</a></article>' +
            '<p style="margin:0;color:#d5d0c2">Once setup is complete, follow the instructions in each match or competition and submit results honestly.</p>' +
            '<label style="display:flex;align-items:flex-start;gap:10px;padding:12px 0;color:#f5f1e4"><input id="gg-welcome-read" type="checkbox" style="width:20px;height:20px;flex:none;margin-top:2px">I have read this setup guide and understand that acknowledging it does not confirm app installation, notification permission, or wallet funding.</label>' +
            '<p id="gg-welcome-error" role="status" aria-live="polite" style="min-height:1.4em;margin:0;color:#ffaaa5"></p>' +
            '<button id="gg-welcome-continue" type="button" disabled style="width:100%;padding:13px;border:0;border-radius:10px;background:#dfb82f;color:#111;font-weight:800;opacity:.55">I’ve Read the Guide — Continue</button></div>';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.body.style.overflow = "hidden";
        card.querySelector("#gg-welcome-protect-image").src = new URL("pages/images/google-play-protect-warning.jpg", frontendRootUrl).href;
        var info = card.querySelector("#gg-welcome-apk-info");
        if (apk.version) info.textContent = "Version " + apk.version + (apk.fileSize ? " · " + (apk.fileSize / 1048576).toFixed(1) + " MB" : "") + (apk.sha256 ? " · SHA-256: " + apk.sha256 : "");
        card.querySelector("#gg-welcome-download").addEventListener("click", function() {
            downloadCompanionApp(card.querySelector("#gg-welcome-download-status"));
        });
        var checkbox = card.querySelector("#gg-welcome-read");
        var continueButton = card.querySelector("#gg-welcome-continue");
        checkbox.addEventListener("change", function() {
            continueButton.disabled = !checkbox.checked;
            continueButton.style.opacity = checkbox.checked ? "1" : ".55";
        });
        continueButton.addEventListener("click", async function() {
            if (!checkbox.checked) return;
            continueButton.disabled = true;
            continueButton.textContent = "Saving your acknowledgement…";
            var result = await api("/api/companion/acknowledge", { method: "POST", body: { version: statusData.guideVersion } });
            if (!result.ok) {
                card.querySelector("#gg-welcome-error").textContent = result.data.message || "Could not save your acknowledgement. Check your connection and try again.";
                continueButton.disabled = false;
                continueButton.textContent = "I’ve Read the Guide — Continue";
                return;
            }
            document.removeEventListener("keydown", preventGuideDismiss, true);
            document.body.style.overflow = "";
            overlay.remove();
        });
        function preventGuideDismiss(event) {
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); }
            if (event.key === "Tab") {
                var focusable = Array.from(card.querySelectorAll("button:not(:disabled),a[href],input:not(:disabled)"));
                if (!focusable.length) return;
                var first = focusable[0], last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        }
        document.addEventListener("keydown", preventGuideDismiss, true);
        card.querySelector("#gg-welcome-download").focus();
    }

    function showAndroidCompanionGate(data) {
        if (!document.body || document.getElementById("gg-android-companion-required")) return;
        var panel = document.createElement("section");
        panel.id = "gg-android-companion-required";
        panel.setAttribute("role", "alertdialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "gg-android-companion-title");
        panel.style.cssText = "position:fixed;inset:0;z-index:2147483002;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.84);font:15px/1.5 Arial,sans-serif";

        var card = document.createElement("div");
        card.style.cssText = "box-sizing:border-box;width:min(520px,100%);padding:22px;border:1px solid #cba933;border-radius:14px;background:#111;color:#f7f2df;box-shadow:0 14px 42px rgba(0,0,0,.65)";
        var title = document.createElement("h2");
        title.id = "gg-android-companion-title";
        title.style.cssText = "margin:0 0 8px;color:#e4bd43;font-size:21px";
        title.textContent = "Android Companion required for eFootball";
        var explanation = document.createElement("p");
        explanation.textContent = "Install the Android notification companion, sign in with this account, and enable match alerts and room-code chat replies. Play Chess and eFootball on the website. eFootball matches and tournaments unlock after the app registers your phone. Chess remains available for Both accounts.";
        var status = document.createElement("p");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.style.cssText = "min-height:1.4em;margin:0 0 12px;color:#d0c9b5";
        status.textContent = "After enabling notifications in the app, return here and check activation.";
        var download = document.createElement("button");
        download.type = "button";
        download.textContent = "Download Android notification companion";
        download.style.cssText = "display:inline-block;margin:0 0 12px;color:#e4bd43;font-weight:700;background:transparent;border:0;text-decoration:underline;cursor:pointer";
        download.addEventListener("click", function() { downloadCompanionApp(status); });
        var actions = document.createElement("div");
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        var check = document.createElement("button");
        check.type = "button";
        check.textContent = "I enabled notifications — check activation";
        check.style.cssText = "padding:10px 14px;border:0;border-radius:8px;background:#e4bd43;color:#111;font-weight:700";
        var signout = document.createElement("button");
        signout.type = "button";
        signout.textContent = "Sign out";
        signout.style.cssText = "padding:10px 14px;border:1px solid #62562f;border-radius:8px;background:#181818;color:#eee";
        actions.appendChild(check);
        actions.appendChild(signout);
        card.appendChild(title);
        card.appendChild(explanation);
        card.appendChild(download);
        card.appendChild(status);
        card.appendChild(actions);
        panel.appendChild(card);
        document.body.appendChild(panel);

        check.addEventListener("click", async function() {
            check.disabled = true;
            status.textContent = "Checking Android device registration…";
            var result = await api("/api/push/status", { noRedirect: true });
            check.disabled = false;
            if (result.ok && Number(result.data.activeAndroidDevices || 0) > 0) {
                panel.remove();
                location.reload();
                return;
            }
            status.textContent = result.ok && !result.data.androidConfigured
                ? "Android notifications are not configured on the GOAL$GAMBIT server yet. The companion cannot register until server setup is complete."
                : result.data.message || "No Android companion is registered for this account yet. Open the app and enable match notifications, then try again.";
        });
        signout.addEventListener("click", logout);
    }

    async function showAndroidCompanionReminder() {
        if (!document.body || document.getElementById("gg-android-companion-reminder")) return;
        var result = await api("/api/push/status", { noRedirect: true });
        if (!result.ok || Number(result.data.activeAndroidDevices || 0) > 0) return;
        var banner = document.createElement("aside");
        banner.id = "gg-android-companion-reminder";
        banner.setAttribute("role", "status");
        banner.style.cssText = "box-sizing:border-box;padding:12px 16px;border:1px solid #80671e;border-radius:10px;background:#171307;color:#f5e9bd;margin:12px auto;max-width:1100px;font:14px/1.5 Arial,sans-serif";
        var message = document.createElement("span");
        message.textContent = "This account has no Android Companion registered yet. Enable notifications in the companion to receive match alerts and room-code chat replies. Use the Android download link at the top of this page to get the app.";
        banner.appendChild(message);
        document.body.insertBefore(banner, document.body.firstChild);
    }

    async function showAndroidCompanionDownloadLink() {
        if (!document.body || !getToken() || document.getElementById("gg-android-companion-download")) return;
        var banner = document.createElement("aside");
        banner.id = "gg-android-companion-download";
        banner.setAttribute("aria-label", "Android notification companion download");
        banner.style.cssText = "box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 14px;width:100%;padding:10px 16px;border-bottom:1px solid #80671e;background:#171307;color:#f5e9bd;font:14px/1.5 Arial,sans-serif;text-align:center";
        var message = document.createElement("span");
        message.textContent = "GOAL$GAMBIT Android Companion: match alerts and room-code chat replies on your phone.";
        var download = document.createElement("button");
        download.type = "button";
        download.textContent = "Download the Android app";
        download.style.cssText = "color:#f4bd20;font-weight:700;text-decoration:underline";
        var downloadStatus = document.createElement("span");
        downloadStatus.setAttribute("role", "status");
        downloadStatus.setAttribute("aria-live", "polite");
        download.addEventListener("click", function() { downloadCompanionApp(downloadStatus); });
        banner.append(message, download, downloadStatus);
        document.body.insertBefore(banner, document.body.firstChild);
        var status = await api("/api/companion/status", { noRedirect: true });
        if (status.ok && status.data.needsAcknowledgement) showCompanionWelcomeGuide(status.data);
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
                    (isFormData ? options.body : JSON.stringify(options.body)),
                // Account history and wallet responses must never come back
                // from a browser cache after a user clears a list.
                cache: options.cache || "no-store"
            });

            var data = null;
            try { data = await response.json(); } catch (e) {}

            if (response.status === 404 && (!data || !data.message || data.message === "API endpoint not found.")) {
                data = Object.assign({}, data || {}, {
                    message: "This API route was not found on the selected server. Check the API address and update or restart the backend."
                });
            }
            if ([502, 503, 504].indexOf(response.status) >= 0 && (!data || !data.message)) {
                data = Object.assign({}, data || {}, {
                    message: "The API server is temporarily unavailable (HTTP " + response.status + "). Check that the backend and its public tunnel are running."
                });
            }

            if (response.status === 401 && token && !options.noRedirect) {
                clearSession();
                location.href = "login.html";
            }

            if (response.status === 403 && data && data.code === "ANDROID_COMPANION_REQUIRED") {
                showAndroidCompanionGate(data);
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
            rememberMatchRoomReturn();
            location.href = "login.html";
            return false;
        }
        startPresence();
        return true;
    }


    // ------------------------------------------------------------------
    // Web Push setup shared by the account, match and notification pages.
    // Permission is requested only from the explicit Enable button.
    // ------------------------------------------------------------------
    function pushBrowserSupported() {
        return !!(window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
    }

    function konamiNotificationsRequired() {
        var game = String(localStorage.getItem("goalGambitGame") || "").toLowerCase();
        if (!game) {
            try {
                var account = JSON.parse(localStorage.getItem("goalGambitAccount") || "{}");
                game = String(account.game || "").toLowerCase();
            } catch (_) {}
        }
        return game === "konami" || game === "both";
    }

    async function requestPushPermission() {
        if (!pushBrowserSupported()) {
            throw new Error("This browser or device does not support background Web Push. Use a supported browser/device or the GOAL$GAMBIT Android companion for match alerts.");
        }
        var permission = Notification.permission;
        // Call the browser permission prompt before awaiting network work so
        // mobile browsers still see this as a direct response to the user's tap.
        if (permission === "default") permission = await Notification.requestPermission();
        if (permission !== "granted") {
            if (permission === "denied") localStorage.setItem("goalGambitPushPermissionDenied", "1");
            throw new Error(permission === "denied"
                ? "Notifications are blocked for this site. Open the site’s notification permission in browser or phone settings, allow notifications, then return and try again."
                : "Notification permission was not granted.");
        }
        return { permission: permission };
    }

    function pushServiceWorkerUrl() {
        return new URL("sw.js", frontendRootUrl);
    }

    async function registerPushServiceWorker() {
        if (!pushBrowserSupported()) throw new Error("This browser does not support secure Web Push notifications.");
        var workerUrl = pushServiceWorkerUrl();
        var scopeUrl = frontendRootUrl;
        var registration = await navigator.serviceWorker.register(workerUrl.href, { scope: scopeUrl.pathname });
        await navigator.serviceWorker.ready;
        return registration;
    }

    function decodeApplicationServerKey(value) {
        var base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
        while (base64.length % 4) base64 += "=";
        var raw = atob(base64);
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes;
    }

    async function getPushPublicConfig() {
        var result = await api("/api/push/vapid-public-key", { noRedirect: true });
        if (!result.ok || !result.data.configured || !result.data.publicKey) {
            throw new Error(result.data && result.data.message || "Match notifications are not configured on the server yet.");
        }
        return result.data;
    }

    async function syncPushSubscription() {
        if (!pushBrowserSupported() || Notification.permission !== "granted" || !getToken()) {
            return { enabled: false, registered: false, message: "Notifications are not enabled in this browser." };
        }
        var config = await getPushPublicConfig();
        var registration = await registerPushServiceWorker();
        var subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: decodeApplicationServerKey(config.publicKey)
            });
        }
        var saved = await api("/api/push/subscriptions", {
            method: "POST",
            body: { subscription: subscription.toJSON() },
            noRedirect: true
        });
        if (!saved.ok || !saved.data.registered) {
            throw new Error(saved.data.message || "The browser subscription was not saved to your account.");
        }
        var status = await api("/api/push/status", { noRedirect: true });
        if (!status.ok || !status.data.configured || Number(status.data.activeSubscriptions) < 1) {
            throw new Error(status.data.message || "The backend could not verify an active subscription for your account.");
        }
        return { enabled: true, registered: true, activeSubscriptions: Number(status.data.activeSubscriptions), message: "This device is registered for match notifications." };
    }

    async function enablePushNotifications() {
        if (!pushBrowserSupported()) throw new Error("Web Push needs a supported browser and a secure HTTPS page. On iPhone or iPad, add the site to the Home Screen first.");
        if (!getToken()) throw new Error("Sign in before enabling match notifications.");
        await requestPushPermission();
        var result = await syncPushSubscription();
        localStorage.removeItem("goalGambitPushPromptDismissed");
        localStorage.removeItem("goalGambitPushPermissionDenied");
        return result;
    }

    async function disablePushNotifications(options) {
        options = options || {};
        if (!getToken()) return { disabled: false };
        try {
            var registration = null;
            if ("serviceWorker" in navigator) {
                var workerUrl = pushServiceWorkerUrl();
                registration = await navigator.serviceWorker.getRegistration(workerUrl.href);
                if (!registration) registration = await registerPushServiceWorker();
            }
            var subscription = registration ? await registration.pushManager.getSubscription() : null;
            if (!subscription && !options.allDevices) return { disabled: false, message: "There is no push subscription on this device." };
            var response = await api("/api/push/subscriptions", {
                method: "DELETE",
                body: subscription ? { endpoint: subscription.endpoint } : {},
                noRedirect: true
            });
            if (!response.ok) throw new Error(response.data.message || "The backend could not disable this device subscription.");
            if (subscription) await subscription.unsubscribe();
            return { disabled: true };
        } catch (error) {
            if (!options.silent) throw error;
            return { disabled: false, message: error.message };
        }
    }

    async function getPushStatus() {
        var browserSupported = pushBrowserSupported();
        var permission = !browserSupported ? "unsupported" : Notification.permission;
        var localSubscription = false;
        if (browserSupported && permission === "granted") {
            try {
                var registration = await registerPushServiceWorker();
                var subscription = await registration.pushManager.getSubscription();
                if (subscription) {
                    var synchronized = await syncPushSubscription();
                    localSubscription = !!synchronized.registered;
                }
            } catch (_) {}
        }
        var server = getToken() ? await api("/api/push/status", { noRedirect: true }) : { ok: false, data: {} };
        return {
            browserSupported: browserSupported,
            permission: permission,
            configured: !!(server.ok && server.data.configured),
            activeSubscriptions: server.ok ? Number(server.data.activeSubscriptions || 0) : 0,
            androidConfigured: !!(server.ok && server.data.androidConfigured),
            activeAndroidDevices: server.ok ? Number(server.data.activeAndroidDevices || 0) : 0,
            canViewAndroidDeviceDetails: !!(server.ok && server.data.canViewAndroidDeviceDetails),
            androidDevices: server.ok && server.data.canViewAndroidDeviceDetails && Array.isArray(server.data.androidDevices) ? server.data.androidDevices : [],
            thisDeviceRegistered: localSubscription,
            serverReachable: !!server.ok
        };
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
                alert("Your account is registered for " + (g === "konami" ? "eFootball" : "Chess") + " only.");
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
        await showDashboardAnnouncements();
        if (user.game === "konami" || user.game === "both") {
            showAndroidCompanionReminder().catch(function() {});
        }
        return user;
    }

    function announcementDismissalState() {
        var userId = localStorage.getItem("goalGambitUserId") || "current";
        var key = "goalGambitDismissedAnnouncements:" + userId;
        var value = {};
        try { value = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) {}
        return {
            key: key,
            ids: Array.from(new Set((Array.isArray(value.ids) ? value.ids : []).map(String))),
            pending: Array.from(new Set((Array.isArray(value.pending) ? value.pending : []).map(String)))
        };
    }

    function saveAnnouncementDismissalState(state) {
        try {
            localStorage.setItem(state.key, JSON.stringify({ ids: state.ids, pending: state.pending }));
        } catch (e) {}
    }

    function removePendingAnnouncementDismissal(state, id) {
        state.pending = state.pending.filter(function(value) { return value !== String(id); });
        saveAnnouncementDismissalState(state);
    }

    async function showDashboardAnnouncements() {
        var dismissalState = announcementDismissalState();
        if (dismissalState.pending.length) {
            await Promise.all(dismissalState.pending.map(async function(id) {
                var synced = await api("/api/announcements/" + encodeURIComponent(id) + "/dismiss", { method: "POST" });
                if (synced.ok || synced.status === 404) removePendingAnnouncementDismissal(dismissalState, id);
            }));
        }

        var response = await api("/api/announcements/current");
        var list = response.ok && response.data && Array.isArray(response.data.announcements)
            ? response.data.announcements : [];
        var dismissedIds = new Set(dismissalState.ids);
        list = list.filter(function(announcement) { return !dismissedIds.has(String(announcement.id)); });
        if (!list.length || !document.body) return;

        var region = document.createElement("section");
        region.setAttribute("aria-label", "Announcements from GOAL$GAMBIT");
        region.setAttribute("aria-live", "polite");
        region.style.cssText = "box-sizing:border-box;max-width:1120px;margin:12px auto;padding:0 14px;color:#fff;font:14px/1.5 system-ui,Segoe UI,sans-serif";
        list.forEach(function (announcement) {
            var card = document.createElement("article");
            card.style.cssText = "display:flex;gap:14px;align-items:flex-start;justify-content:space-between;margin:0 0 9px;padding:12px 14px;border:1px solid #b88716;border-left:4px solid #f4bd20;border-radius:10px;background:#19160e;box-shadow:0 5px 18px rgba(0,0,0,.18)";
            var copy = document.createElement("div");
            var title = document.createElement("strong");
            title.textContent = "Announcement from GOAL$GAMBIT";
            title.style.cssText = "display:block;color:#f4bd20;margin-bottom:3px";
            var message = document.createElement("div");
            message.textContent = announcement.message || "";
            message.style.whiteSpace = "pre-wrap";
            var when = document.createElement("small");
            var created = new Date(announcement.created_at);
            when.textContent = isNaN(created.getTime()) ? "" : created.toLocaleString();
            when.style.cssText = "display:block;color:#a7adb1;margin-top:5px";
            copy.append(title, message, when);
            var dismiss = document.createElement("button");
            dismiss.type = "button";
            dismiss.textContent = "Dismiss";
            dismiss.setAttribute("aria-label", "Dismiss this announcement");
            dismiss.style.cssText = "flex:none;border:1px solid #555;background:#232629;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font:600 12px system-ui,Segoe UI,sans-serif";
            dismiss.addEventListener("click", function () {
                var id = String(announcement.id);
                if (dismissalState.ids.indexOf(id) === -1) dismissalState.ids.push(id);
                if (dismissalState.pending.indexOf(id) === -1) dismissalState.pending.push(id);
                saveAnnouncementDismissalState(dismissalState);
                card.remove();
                if (!region.children.length) region.remove();
                api("/api/announcements/" + encodeURIComponent(id) + "/dismiss", { method: "POST" })
                    .then(function(result) {
                        if (result.ok || result.status === 404) removePendingAnnouncementDismissal(dismissalState, id);
                    });
            });
            card.append(copy, dismiss);
            region.appendChild(card);
        });
        document.body.insertBefore(region, document.body.firstChild);
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
        androidCompanionDownloadUrl: PUBLIC_COMPANION_DOWNLOAD_URL,
        downloadCompanionApp: downloadCompanionApp,
        api: api,
        getToken: getToken,
        takePostLoginDestination: takePostLoginDestination,
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
        startPresence: startPresence,
        enablePushNotifications: enablePushNotifications,
        requestPushPermission: requestPushPermission,
        supportsPushNotifications: pushBrowserSupported,
        konamiNotificationsRequired: konamiNotificationsRequired,
        disablePushNotifications: disablePushNotifications,
        getPushStatus: getPushStatus,
        syncPushSubscription: syncPushSubscription,
        isUserOnline: function(id) { return onlineUserIds.has(String(Number(id))); },
        getOnlineUserIds: function() { return Array.from(onlineUserIds); },
        escapeHTML: function (value) {
            return String(value == null ? "" : value)
                .replace(/&/g, "&amp;").replace(/</g, "&lt;")
                .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        },
        gameHome: gameHome
    };

    // Show a short offline banner when the backend or database is unreachable.
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
            "position:fixed",
            "top:0",
            "right:0",
            "bottom:0",
            "left:0",
            "z-index:2147483647",
            "width:100vw",
            "min-height:100vh",
            "min-height:100dvh",
            "padding:24px",
            "align-items:center",
            "justify-content:center",
            "text-align:center",
            "font:700 24px/1.35 Arial,Helvetica,sans-serif",
            "color:#111",
            "background:#fff",
            "border:0",
            "box-shadow:none"
        ].join(";");

        // Put the status at the top of the page so it stays visible while scrolling.
        document.body.insertBefore(banner, document.body.firstChild);

        var wasOffline = false;
        var recoveryTimer = null;
        var retryTimer = null;
        var consecutiveFailures = 0;
        var healthCheckInFlight = false;
        var healthBase = API_BASE || location.origin;
        if (!healthBase || healthBase === "null" || location.protocol === "file:") {
            healthBase = "http://localhost:5000";
        }
        healthBase = healthBase.replace(/\/+$/, "");

        function showOffline() {
            window.clearTimeout(recoveryTimer);
            wasOffline = true;
            banner.textContent = "Server offline";
            banner.style.background = "#fff";
            banner.style.color = "#111";
            banner.style.border = "0";
            banner.setAttribute("role", "alert");
            banner.setAttribute("aria-live", "assertive");
            banner.hidden = false;
            banner.style.display = "flex";
        }

        function showOnline() {
            if (wasOffline) {
                wasOffline = false;
                banner.textContent = "Server connection restored.";
                banner.style.background = "#fff";
                banner.style.color = "#111";
                banner.style.border = "0";
                banner.setAttribute("role", "status");
                banner.setAttribute("aria-live", "polite");
                banner.hidden = false;
                banner.style.display = "flex";
                recoveryTimer = window.setTimeout(function () {
                    banner.hidden = true;
                    banner.style.display = "none";
                }, 4500);
            } else if (!recoveryTimer) {
                banner.hidden = true;
                banner.style.display = "none";
            }
        }

        function scheduleHealthRetry() {
            if (retryTimer) return;
            retryTimer = window.setTimeout(function () {
                retryTimer = null;
                checkServer();
            }, 1500);
        }

        async function checkServer() {
            if (healthCheckInFlight) return;
            healthCheckInFlight = true;
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
                    consecutiveFailures = 0;
                    if (retryTimer) {
                        window.clearTimeout(retryTimer);
                        retryTimer = null;
                    }
                    showOnline();
                } else {
                    consecutiveFailures++;
                    if (consecutiveFailures >= 2) showOffline();
                    else scheduleHealthRetry();
                }
            } catch (error) {
                consecutiveFailures++;
                if (consecutiveFailures >= 2) showOffline();
                else scheduleHealthRetry();
            } finally {
                window.clearTimeout(timeout);
                healthCheckInFlight = false;
            }
        }

        checkServer();
        window.setInterval(checkServer, 25000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", showAndroidCompanionDownloadLink, { once: true });
    } else {
        showAndroidCompanionDownloadLink();
    }
    initServerStatus();

})();
