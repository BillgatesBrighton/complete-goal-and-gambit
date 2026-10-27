"use strict";

// Keep the website chess shell available when a player returns during a brief
// backend/site outage. This cache is limited to static chess resources; API
// responses and Socket.IO traffic are never cached. The push handlers below
// remain unchanged.
const CHESS_SHELL_CACHE = "goal-gambit-chess-shell-v3";
const CHESS_SHELL_ASSETS = [
    "pages/chess-match.html",
    "pages/board.html",
    "pages/chess.html",
    "pages/board.css",
    "pages/board-lichess.css",
    "js/api.js",
    "js/board.js",
    "js/chess-schedules.js",
    "js/active-tournaments.js",
    "js/vendor/chess.mjs",
    "manifest.webmanifest",
    "images/notification-icon.svg"
];
const CHESS_SHELL_NAVIGATIONS = new Set(["pages/chess-match.html", "pages/board.html", "pages/chess.html"]);

function chessShellPath(url) {
    const scopePath = new URL(self.registration.scope).pathname;
    if (!url.pathname.startsWith(scopePath)) return "";
    return url.pathname.slice(scopePath.length).replace(/^\/+/, "");
}

self.addEventListener("install", function(event) {
    event.waitUntil(caches.open(CHESS_SHELL_CACHE).then(function(cache) {
        return cache.addAll(CHESS_SHELL_ASSETS.map(function(path) {
            if (path === "js/board.js") path += "?v=20261027-player-name-sync";
            return new URL(path, self.registration.scope).href;
        }));
    }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener("activate", function(event) {
    event.waitUntil(caches.keys().then(function(keys) {
        return Promise.all(keys.filter(function(key) {
            return key.startsWith("goal-gambit-chess-shell-") && key !== CHESS_SHELL_CACHE;
        }).map(function(key) { return caches.delete(key); }));
    }).then(function() { return self.clients.claim(); }));
});

self.addEventListener("fetch", function(event) {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || /\/(?:api|socket\.io)(?:\/|$)/i.test(url.pathname)) return;
    const path = chessShellPath(url);
    if (!path) return;

    if (CHESS_SHELL_NAVIGATIONS.has(path) && request.mode === "navigate") {
        event.respondWith((async function() {
            try {
                const response = await fetch(request);
                if (response.ok) {
                    const cache = await caches.open(CHESS_SHELL_CACHE);
                    await cache.put(new URL(path, self.registration.scope).href, response.clone());
                }
                return response;
            } catch (_) {
                const cached = await caches.match(new URL(path, self.registration.scope).href, { ignoreSearch: true });
                return cached || new Response("<!doctype html><title>Chess offline</title><p>Chess is unavailable until this page has been loaded once while connected.</p>", {
                    headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503
                });
            }
        })());
        return;
    }

    if (!CHESS_SHELL_ASSETS.includes(path)) return;

    // api.js contains the live backend address and server-status check. Keep
    // its cache for offline chess pages, but refresh it whenever the network
    // is available so older clients cannot remain pinned to stale API config.
    if (path === "js/api.js") {
        event.respondWith((async function() {
            try {
                const response = await fetch(request, { cache: "no-cache" });
                if (response.ok) {
                    const cache = await caches.open(CHESS_SHELL_CACHE);
                    await cache.put(new URL(path, self.registration.scope).href, response.clone());
                    return response;
                }
                const cached = await caches.match(request, { ignoreSearch: true });
                return cached || response;
            } catch (error) {
                const cached = await caches.match(request, { ignoreSearch: true });
                if (cached) return cached;
                throw error;
            }
        })());
        return;
    }

    event.respondWith((async function() {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CHESS_SHELL_CACHE);
            await cache.put(new URL(path, self.registration.scope).href, response.clone());
        }
        return response;
    })());
});

function safeTargetPath(value) {
    const path = String(value || "");
    if (path === "pages/chess.html") return path;
    if (/^pages\/(match-room|match-results|match-hub)\.html(?:\?matchId=[1-9][0-9]*)?$/.test(path)) return path;
    return "pages/match-hub.html";
}

self.addEventListener("push", function(event) {
    event.waitUntil((async function() {
        let payload = {};
        try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
        if (!payload || typeof payload !== "object") payload = {};
        const title = String(payload.title || "GOAL$GAMBIT match update").slice(0, 120);
        const body = String(payload.body || "Open GOAL$GAMBIT to view your match update.").slice(0, 240);
        const eventId = Number(payload.eventId) || 0;
        const eventType = String(payload.type || "");
        const senderReply = eventType.includes("room-code-needed") || eventType.includes("code-correction-requested");
        const targetPath = safeTargetPath(payload.targetPath);
        const options = {
            body: body,
            icon: "images/notification-icon.svg",
            tag: String(payload.tag || (eventId ? "goal-gambit-event-" + eventId : "goal-gambit-update")),
            renotify: false,
            // Web Notification actions are buttons only; they do not support
            // an inline text field. This action opens the authenticated
            // Match Room sender form as the reliable browser fallback.
            actions: senderReply ? [{ action: "send-code", title: "ENTER CODE" }] : [],
            data: {
                targetPath: targetPath,
                eventId: eventId,
                type: eventType,
                clickToken: String(payload.clickToken || ""),
                trackingUrl: String(payload.trackingUrl || "")
            }
        };
        try {
            await self.registration.showNotification(title, options);
        } catch (_) {
            // Some browsers reject action buttons. Retry the same safe alert without actions.
            delete options.actions;
            await self.registration.showNotification(title, options);
        }
    })());
});

self.addEventListener("notificationclick", function(event) {
    event.notification.close();
    const data = event.notification.data || {};
    const targetUrl = new URL(safeTargetPath(data.targetPath), self.registration.scope);
    const action = ["send-code", "view-code", "results"].includes(event.action) ? event.action : "open";
    const senderReply = String(data.type || "").includes("room-code-needed") ||
        String(data.type || "").includes("code-correction-requested");
    if (action === "send-code" || (action === "open" && senderReply)) {
        targetUrl.searchParams.set("action", "send-code");
    }
    const target = targetUrl.href;

    event.waitUntil((async function() {
        const tasks = [];
        const trackingUrl = String(data.trackingUrl || "");
        if (data.eventId && data.clickToken && /^https:\/\//i.test(trackingUrl)) {
            tasks.push(fetch(trackingUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ eventId: data.eventId, clickToken: data.clickToken, action: action }),
                mode: "cors",
                credentials: "omit",
                keepalive: true
            }).catch(function() {}));
        }
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const scopeUrl = new URL(self.registration.scope);
        for (const client of windows) {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin !== scopeUrl.origin || !clientUrl.href.startsWith(scopeUrl.href)) continue;
            if (typeof client.navigate === "function" && client.url !== target) await client.navigate(target);
            tasks.push(client.focus());
            await Promise.all(tasks);
            return;
        }
        tasks.push(self.clients.openWindow(target));
        await Promise.all(tasks);
    })());
});

// A rotated browser subscription is synchronized when an authenticated app
// page is open. On the next visit, api.js also upserts the current subscription.
self.addEventListener("pushsubscriptionchange", function(event) {
    event.waitUntil((async function() {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) {
            client.postMessage({ type: "GG_PUSH_SUBSCRIPTION_CHANGED" });
        }
    })());
});
