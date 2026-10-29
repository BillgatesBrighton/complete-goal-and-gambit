"use strict";

(function () {
    var form = document.getElementById("chessScheduleForm");
    var dateInput = document.getElementById("chessScheduleAt");
    var dateField = document.getElementById("chessScheduleDateField");
    var opponentInput = document.getElementById("chessScheduleOpponent");
    var invitationTypeInput = document.getElementById("chessInvitationType");
    var stakeInput = document.getElementById("chessChallengeStake");
    var stakeField = document.getElementById("chessScheduleStakeField");
    var clockInput = document.getElementById("chessScheduleClock");
    var submitButton = document.getElementById("chessScheduleSubmit");
    var feedback = document.getElementById("chessScheduleFeedback");
    var list = document.getElementById("chessScheduleList");
    if (!form || !window.GG) return;

    function setDateLimits() {
        var now = new Date();
        var min = new Date(now.getTime() + 10 * 60 * 1000);
        var max = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        function localValue(date) {
            var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
            return local.toISOString().slice(0, 16);
        }
        dateInput.min = localValue(min);
        dateInput.max = localValue(max);
    }

    function showFeedback(message, kind) {
        feedback.textContent = message || "";
        feedback.className = "chess-schedule-feedback" + (kind ? " " + kind : "");
    }

    function applyInvitationType() {
        var direct = invitationTypeInput.value === "direct";
        dateField.hidden = direct;
        dateInput.required = !direct;
        stakeField.hidden = !direct;
        submitButton.textContent = direct ? "Send challenge" : "Send match invitation";
    }

    function button(label, action, scheduleId, secondary) {
        var control = document.createElement("button");
        control.type = "button";
        control.className = "chess-schedule-action" + (secondary ? " secondary" : "");
        control.textContent = label;
        control.dataset.action = action;
        control.dataset.scheduleId = String(scheduleId);
        return control;
    }

    function renderSchedules(schedules) {
        list.replaceChildren();
        if (!schedules.length) {
            var empty = document.createElement("p");
            empty.className = "chess-schedule-empty";
            empty.textContent = "No upcoming Chess matches yet.";
            list.appendChild(empty);
            return;
        }

        schedules.forEach(function (schedule) {
            var card = document.createElement("article");
            card.className = "chess-schedule-card";
            var heading = document.createElement("strong");
            heading.textContent = (schedule.isHost ? "You invited " : "Invitation from ") + schedule.opponentUsername;
            var time = document.createElement("p");
            time.textContent = schedule.isDirectChallenge
                ? "Direct challenge · KSh " + Number(schedule.stakeAmount || 0).toFixed(2) + " · " + schedule.timeControl
                : new Date(schedule.scheduledAt).toLocaleString() + " · " + schedule.timeControl;
            var status = document.createElement("p");
            if (schedule.isDirectChallenge && schedule.status === "pending") {
                status.textContent = schedule.isHost ? "Waiting for the other player to accept. Your stake is reserved." : "Accept to reserve the same stake and start the game.";
            } else if (schedule.isDirectChallenge && schedule.status === "started") {
                status.textContent = "Challenge accepted · the Chess game is ready.";
            } else if (schedule.isDirectChallenge && schedule.status === "declined") {
                status.textContent = schedule.isHost ? "Challenge declined · your reserved stake was returned." : "You declined this Chess challenge.";
            } else if (schedule.isDirectChallenge && schedule.status === "cancelled") {
                status.textContent = schedule.isHost ? "Challenge cancelled · your reserved stake was returned." : "The challenger cancelled this Chess challenge.";
            } else if (schedule.status === "pending") {
                status.textContent = schedule.isHost ? "Waiting for the other player to accept." : "Please accept or decline this invitation.";
            } else if (schedule.status === "accepted") {
                status.textContent = "Accepted · " + (schedule.youReady ? "You are ready" : "You are not ready yet") + " · " + (schedule.opponentReady ? "opponent is ready" : "opponent is not ready");
            } else {
                status.textContent = "Both players are ready. The Chess match has started.";
            }
            card.append(heading, time, status);

            var actions = document.createElement("div");
            actions.className = "chess-schedule-actions";
            if (schedule.canRespond) {
                actions.append(
                    button("Accept", "accept", schedule.id, false),
                    button("Decline", "decline", schedule.id, true)
                );
            }
            if (schedule.canReady) {
                var ready = button(schedule.youReady ? "You are ready" : "I'm ready to play", "ready", schedule.id, false);
                var opensAt = new Date(schedule.scheduledAt).getTime() - 10 * 60 * 1000;
                var closesAt = new Date(schedule.scheduledAt).getTime() + 30 * 60 * 1000;
                ready.disabled = schedule.youReady || Date.now() < opensAt || Date.now() > closesAt;
                if (!schedule.youReady && Date.now() < opensAt) ready.title = "Ready opens 10 minutes before the scheduled time.";
                actions.appendChild(ready);
            }
            if (schedule.canCancel) actions.appendChild(button(schedule.isDirectChallenge ? "Cancel challenge" : "Cancel match", "cancel", schedule.id, true));
            if (schedule.matchId) {
                var open = document.createElement("a");
                open.className = "chess-schedule-action";
                open.href = "board.html?matchId=" + encodeURIComponent(schedule.matchId);
                open.textContent = "Open Chess game";
                actions.appendChild(open);
            }
            if (actions.children.length) card.appendChild(actions);
            list.appendChild(card);
        });
    }

    async function refreshSchedules() {
        var result = await GG.api("/api/chess/schedules", { noRedirect: true });
        if (!result.ok) {
            list.textContent = (result.data && result.data.message) || "Could not load scheduled Chess matches.";
            return;
        }
        renderSchedules(Array.isArray(result.data.schedules) ? result.data.schedules : []);
    }

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var direct = invitationTypeInput.value === "direct";
        var localDate = null;
        if (!direct) {
            setDateLimits();
            localDate = new Date(dateInput.value);
            if (!dateInput.value || !Number.isFinite(localDate.getTime())) {
                showFeedback("Choose a valid future date and time.", "error");
                return;
            }
        }
        submitButton.disabled = true;
        showFeedback(direct ? "Sending the Chess challenge…" : "Sending the Chess invitation…");
        try {
            var result = await GG.api("/api/chess/schedules", {
                method: "POST",
                body: {
                    type: direct ? "direct" : "scheduled",
                    opponentUsername: opponentInput.value.trim(),
                    stakeAmount: direct ? Number(stakeInput.value) : 0,
                    ...(localDate ? { scheduledAt: localDate.toISOString() } : {}),
                    timeControl: clockInput.value,
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Nairobi"
                },
                noRedirect: true
            });
            if (!result.ok) {
                showFeedback((result.data && result.data.message) || (direct ? "Could not send the Chess challenge." : "Could not schedule the Chess match."), "error");
                return;
            }
            showFeedback((result.data && result.data.message) || (direct ? "Challenge sent." : "Invitation sent. If your opponent has Companion notifications enabled, they’ll receive an alert."), "success");
            opponentInput.value = "";
            await refreshSchedules();
        } catch (_) {
            showFeedback("Connection unavailable. Your Chess match was not scheduled.", "error");
        } finally {
            submitButton.disabled = false;
        }
    });

    list.addEventListener("click", async function (event) {
        var control = event.target.closest("[data-action]");
        if (!control || control.disabled) return;
        var action = control.dataset.action;
        var id = encodeURIComponent(control.dataset.scheduleId);
        if (action === "cancel" && !window.confirm(control.textContent === "Cancel challenge"
            ? "Cancel this Chess challenge? Its reserved stake will be returned to your wallet."
            : "Cancel this scheduled Chess match?")) return;
        control.disabled = true;
        var route = action === "accept" || action === "decline" ? "/respond" : "/" + action;
        var body = action === "accept" || action === "decline" ? { action: action } : {};
        try {
            var result = await GG.api("/api/chess/schedules/" + id + route, { method: "POST", body: body, noRedirect: true });
            if (!result.ok) {
                showFeedback((result.data && result.data.message) || "Could not update this scheduled match.", "error");
            } else if ((action === "ready" || action === "accept") && result.data.started && result.data.matchId) {
                location.href = "board.html?matchId=" + encodeURIComponent(result.data.matchId);
                return;
            } else {
                showFeedback(result.data.message || "Scheduled match updated.", "success");
            }
            await refreshSchedules();
        } catch (_) {
            showFeedback("Connection unavailable. Your scheduled match was not updated.", "error");
        } finally {
            control.disabled = false;
        }
    });

    setDateLimits();
    invitationTypeInput.addEventListener("change", applyInvitationType);
    applyInvitationType();
    refreshSchedules();
    window.setInterval(refreshSchedules, 20000);
    window.addEventListener("pageshow", function (event) {
        if (event.persisted) refreshSchedules();
    });
})();
