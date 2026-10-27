"use strict";

/**
 * Tracks authenticated Socket.IO sockets by match and user. A user's match
 * becomes paused as soon as their last usable socket disconnects; a second
 * tab prevents that transition. A refresh can reconnect and resume the same
 * match after the pause transaction completes.
 */
function createChessConnectionMonitor(options) {
    const settings = options || {};
    const pauseMatch = settings.pauseMatch;
    const resumeMatch = settings.resumeMatch;
    const matches = new Map();
    const socketRecords = new Map();
    const pauseInflight = new Map();
    const resumeInflight = new Map();
    let generation = 0;

    function participantKey(matchId, userId) {
        return Number(matchId) + ":" + Number(userId);
    }

    function matchEntry(matchId) {
        const id = Number(matchId);
        let entry = matches.get(id);
        if (!entry) {
            entry = { players: new Set(), users: new Map() };
            matches.set(id, entry);
        }
        return entry;
    }

    function connectedUserIds(matchId) {
        const entry = matches.get(Number(matchId));
        if (!entry) return new Set();
        return new Set(Array.from(entry.users.entries())
            .filter(([, sockets]) => sockets.size > 0)
            .map(([userId]) => Number(userId)));
    }

    function isMatchReady(matchId) {
        const entry = matches.get(Number(matchId));
        return allParticipantsConnected(entry, connectedUserIds(matchId));
    }

    function allParticipantsConnected(entry, connected) {
        return !!entry && entry.players.size > 0 &&
            Array.from(entry.players).every(userId => connected.has(userId));
    }

    function cleanupEmptyMatch(matchId) {
        const id = Number(matchId);
        const entry = matches.get(id);
        if (!entry || pauseInflight.has(id) || resumeInflight.has(id)) return;
        const hasSockets = Array.from(entry.users.values()).some(sockets => sockets.size > 0);
        if (!hasSockets) matches.delete(id);
    }

    function resumeIfReady(matchId) {
        const id = Number(matchId);
        const entry = matches.get(id);
        if (!entry || !resumeMatch || !allParticipantsConnected(entry, connectedUserIds(id))) {
            cleanupEmptyMatch(id);
            return Promise.resolve(null);
        }
        if (resumeInflight.has(id)) return resumeInflight.get(id);
        const operation = Promise.resolve()
            .then(() => resumeMatch(id, connectedUserIds(id)))
            .catch(error => {
                if (typeof settings.onError === "function") settings.onError(error, id, "resume");
                return null;
            })
            .finally(() => {
                if (resumeInflight.get(id) === operation) resumeInflight.delete(id);
                cleanupEmptyMatch(id);
            });
        resumeInflight.set(id, operation);
        return operation;
    }

    function maybeResume(matchId) {
        const id = Number(matchId);
        const pause = pauseInflight.get(id);
        if (pause) return pause.then(() => resumeIfReady(id));
        return resumeIfReady(id);
    }

    function pauseForLostUser(matchId, userId, pauseOptions) {
        const id = Number(matchId), uid = Number(userId);
        if (!pauseMatch || pauseInflight.has(id)) return pauseInflight.get(id) || Promise.resolve(null);
        const entry = matches.get(id);
        // A replacement connection may already have arrived while the old
        // socket's delayed disconnect callback was being delivered.
        if (entry && entry.users.get(uid) && entry.users.get(uid).size) return Promise.resolve(null);

        const operation = Promise.resolve().then(async function() {
            const currentEntry = matches.get(id);
            if (allParticipantsConnected(currentEntry, connectedUserIds(id))) return null;
            return pauseMatch(id, uid, pauseOptions);
        }).catch(error => {
            if (typeof settings.onError === "function") settings.onError(error, id, "pause");
            return null;
        }).then(async function(result) {
            if (result && result.paused) await resumeIfReady(id);
            return result;
        }).finally(() => {
            if (pauseInflight.get(id) === operation) pauseInflight.delete(id);
            cleanupEmptyMatch(id);
        });
        pauseInflight.set(id, operation);
        return operation;
    }

    function leaveSocket(socket) {
        if (!socket || !socket.id) return false;
        const record = socketRecords.get(socket.id);
        if (!record || record.socket !== socket || (socket.chessConnection && socket.chessConnection !== record)) return false;
        socketRecords.delete(socket.id);
        const entry = matches.get(record.matchId);
        const sockets = entry && entry.users.get(record.userId);
        if (sockets) {
            sockets.delete(socket.id);
            if (!sockets.size) {
                entry.users.delete(record.userId);
                void pauseForLostUser(record.matchId, record.userId);
            }
        }
        socket.chessConnection = null;
        cleanupEmptyMatch(record.matchId);
        return true;
    }

    function joinMatch(socket, details) {
        if (!socket || !socket.id || !details) return Promise.resolve(null);
        const matchId = Number(details.matchId);
        const userId = Number(socket.user && socket.user.userId);
        const whiteId = Number(details.playerWhiteId);
        const blackId = Number(details.playerBlackId);
        if (!Number.isSafeInteger(matchId) || matchId <= 0 ||
            !Number.isSafeInteger(userId) || userId <= 0 ||
            ![whiteId, blackId].includes(userId)) return Promise.resolve(null);
        const existing = socketRecords.get(socket.id);
        if (existing && existing.socket !== socket) return Promise.resolve(null);

        // A retry of chess:join on the same socket must not briefly remove the
        // user's final connection and pause the match. Keep room membership
        // idempotent while still allowing a paused match to resume below.
        if (existing && existing.matchId === matchId && existing.userId === userId) {
            const entry = matchEntry(matchId);
            entry.players = new Set([whiteId, blackId].filter(id => Number.isSafeInteger(id) && id > 0));
            if (details.connectionPausedAt || pauseInflight.has(matchId)) return maybeResume(matchId);
            return Promise.resolve(null);
        }

        const firstObservation = !matches.has(matchId);
        leaveSocket(socket);
        const entry = matchEntry(matchId);
        entry.players = new Set([whiteId, blackId].filter(id => Number.isSafeInteger(id) && id > 0));
        const sockets = entry.users.get(userId) || new Set();
        sockets.add(socket.id);
        entry.users.set(userId, sockets);
        const record = { matchId, userId, generation: ++generation, socket };
        socketRecords.set(socket.id, record);
        socket.chessConnection = record;

        if (details.status === "active" && !allParticipantsConnected(entry, connectedUserIds(matchId))) {
            const connected = connectedUserIds(matchId);
            const missingUserId = Array.from(entry.players).find(id => !connected.has(id));
            // After a process restart the monitor has no record of the prior
            // socket loss. Conservatively pause from the last persisted clock
            // values rather than charging downtime or allowing a timeout.
            return pauseForLostUser(matchId, missingUserId, {
                preserveStoredClock: firstObservation && !details.connectionPausedAt
            });
        }
        if (details.connectionPausedAt || pauseInflight.has(matchId)) return maybeResume(matchId);
        return Promise.resolve(null);
    }

    function stop() {
        socketRecords.clear();
        matches.clear();
        pauseInflight.clear();
        resumeInflight.clear();
    }

    return {
        joinMatch,
        leaveSocket,
        isMatchReady,
        connectedUserIds,
        stop
    };
}

module.exports = createChessConnectionMonitor;
