(function () {
    "use strict";
    if (!window.GG || !GG.getToken()) return;

    var container = document.getElementById("onlineUsers");
    if (!container) return;
    var cachedPlayers = [];

    function render() {
        var players = cachedPlayers.filter(function (player) {
            return player.online || GG.isUserOnline(player.id);
        });
        container.innerHTML = players.length ? players.map(function (player) {
            var id = Number(player.id);
            return '<button type="button" class="user" data-online-player="' + id + '"><span class="presence-dot online"></span>' +
                GG.escapeHTML(player.username || "Player") + '</button>';
        }).join("") : '<div class="hint">No other players are online right now.</div>';
    }

    async function refresh() {
        var result = await GG.api("/api/chat/online");
        if (!result.ok) return;
        cachedPlayers = result.data.users || [];
        render();
    }

    container.addEventListener("click", function (event) {
        var button = event.target.closest("[data-online-player]");
        if (!button) return;
        window.dispatchEvent(new CustomEvent("gg:open-chat-user", {
            detail: { userId: Number(button.dataset.onlinePlayer) }
        }));
    });
    window.addEventListener("gg:presence-update", render);
    GG.startPresence();
    refresh();
    window.setInterval(refresh, 7000);
})();
