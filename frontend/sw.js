/* GOAL$GAMBIT notification clicks return to the Match Hub.
   The site polls for new room codes while this page is open. */
self.addEventListener("notificationclick", function(event) {
    event.notification.close();

    const data = event.notification.data || {};
    const target = new URL(data.url || "pages/match-hub.html", self.registration.scope).href;

    event.waitUntil((async function() {
        const windows = await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true
        });
        const scopeUrl = new URL(self.registration.scope);

        for (const client of windows) {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin !== scopeUrl.origin ||
                !clientUrl.href.startsWith(scopeUrl.href)) continue;
            if (typeof client.navigate === "function") {
                await client.navigate(target);
            }
            return client.focus();
        }

        return self.clients.openWindow(target);
    })());
});
