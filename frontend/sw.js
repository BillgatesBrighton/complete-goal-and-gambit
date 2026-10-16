"use strict";

function safeTargetPath(value) {
    const path = String(value || "");
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
