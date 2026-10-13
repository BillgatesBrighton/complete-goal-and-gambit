(function () {
  "use strict";

  function escape(value) {
    return window.GG ? GG.escapeHTML(value == null ? "" : value) : String(value == null ? "" : value);
  }

  function showMessage(container, message, href, linkText) {
    container.innerHTML = '<p class="active-tournament-empty">' + escape(message) +
      (href ? ' <a href="' + href + '">' + escape(linkText) + '</a>' : "") + '</p>';
  }

  async function loadChess(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (!GG.getToken()) {
      showMessage(container, "Sign in to see your current Chess tournament entries.", "login.html", "Log in");
      return;
    }
    var response = await GG.api("/api/chess/competitions/tournament/entries", { noRedirect: true });
    if (!response.ok) {
      showMessage(container, response.data.message || "Could not load your Chess tournaments.");
      return;
    }
    var entries = Array.isArray(response.data.entries) ? response.data.entries : [];
    if (!entries.length) {
      showMessage(container, "You have no active Chess tournament selections this month.", "tournament-lobby.html", "Browse Chess tournaments");
      return;
    }
    var labels = { "10+5": "Rapid · 10+5", "3+2": "Blitz · 3+2", "1+1": "Bullet · 1+1" };
    container.innerHTML = '<div class="active-tournament-list">' + entries.map(function (entry) {
      var clock = labels[entry.timeControl] || entry.timeControl;
      var lobby = "tournament-lobby.html?timeControl=" + encodeURIComponent(entry.timeControl) + "&stake=" + encodeURIComponent(entry.stake);
      var match = Number(entry.matchId) > 0 ? "board.html?matchId=" + encodeURIComponent(Number(entry.matchId)) : "";
      var state = entry.matchStatus === "active" ? "Match in progress" :
        entry.matchStatus === "waiting" ? "Waiting for an opponent" :
        entry.matchStatus === "settling" ? "Match result settling" : "Tournament entry active";
      return '<article class="active-tournament-card"><h3>' + escape(clock) + '</h3>' +
        '<p>KSh ' + Number(entry.stake).toLocaleString("en-KE") + ' match stake · ' + escape(state) + '</p>' +
        '<a class="active-tournament-action" href="' + lobby + '">Open this tournament</a>' +
        (match ? ' <a class="active-tournament-action secondary" href="' + match + '">Resume match</a>' : "") +
        '</article>';
    }).join("") + '</div>';
  }

  async function loadKonami(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (!GG.getToken()) {
      showMessage(container, "Sign in to see your current eFootball tournaments.", "login.html", "Log in");
      return;
    }
    var response = await GG.api("/api/tournaments", { noRedirect: true });
    if (!response.ok) {
      showMessage(container, response.data.message || "Could not load your eFootball tournaments.");
      return;
    }
    var tournaments = Array.isArray(response.data.tournaments) ? response.data.tournaments : [];
    var active = tournaments.filter(function (tournament) {
      return tournament.joined === true && !["completed", "cancelled", "closed"].includes(String(tournament.status || "").toLowerCase());
    });
    if (!active.length) {
      showMessage(container, "You have no active eFootball tournaments.", "tournaments.html", "Browse tournaments");
      return;
    }
    container.innerHTML = '<div class="active-tournament-list">' + active.map(function (tournament) {
      var id = Number(tournament.id);
      var target = "tournament-bracket.html?tournament=" + encodeURIComponent(id);
      var status = String(tournament.status || "open").replace(/_/g, " ");
      return '<article class="active-tournament-card"><h3>' + escape(tournament.name || "eFootball tournament") + '</h3>' +
        '<p>' + escape(tournament.tier || "eFootball") + ' · KSh ' + Number(tournament.entry_fee || 0).toLocaleString("en-KE") + ' entry · ' + escape(status) + '</p>' +
        '<a class="active-tournament-action" href="' + target + '">Open this tournament</a></article>';
    }).join("") + '</div>';
  }

  window.GGActiveTournaments = { loadChess: loadChess, loadKonami: loadKonami };
})();
