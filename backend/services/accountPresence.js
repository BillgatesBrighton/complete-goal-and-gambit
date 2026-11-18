"use strict";

const DEFAULT_TTL_MS = 90_000;

function createAccountPresence(options) {
    options = options || {};
    const now = typeof options.now === "function" ? options.now : Date.now;
    const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    const websiteSockets = new Map();
    const chessSockets = new Map();
    const applicationSockets = new Map();
    const applicationActivity = new Map();

    function getUserSocketMap(store, userId, create) {
        const id = Number(userId);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        let sockets = store.get(id);
        if (!sockets && create) {
            sockets = new Map();
            store.set(id, sockets);
        }
        return sockets || null;
    }

    function setWebsitePresence(userId, socketId, active) {
        if (!socketId) return false;
        const sockets = getUserSocketMap(websiteSockets, userId, Boolean(active));
        if (!sockets) return false;
        if (active) sockets.set(String(socketId), now());
        else sockets.delete(String(socketId));
        if (!sockets.size) websiteSockets.delete(Number(userId));
        return true;
    }

    function setChessMatchPresence(userId, matchId, socketId, active) {
        const uid = Number(userId);
        const mid = Number(matchId);
        if (!socketId || !Number.isSafeInteger(mid) || mid <= 0) return false;
        let matches = getUserSocketMap(chessSockets, uid, Boolean(active));
        if (!matches) return false;
        let sockets = matches.get(mid);
        if (!sockets && active) {
            sockets = new Map();
            matches.set(mid, sockets);
        }
        if (!sockets) return false;
        if (active) sockets.set(String(socketId), now());
        else sockets.delete(String(socketId));
        if (!sockets.size) matches.delete(mid);
        if (!matches.size) chessSockets.delete(uid);
        return true;
    }

    function setApplicationSocket(userId, socketId, clientType, connected) {
        if (!socketId) return false;
        const sockets = getUserSocketMap(applicationSockets, userId, Boolean(connected));
        if (!sockets) return false;
        if (connected) sockets.set(String(socketId), String(clientType || "unknown"));
        else sockets.delete(String(socketId));
        if (!sockets.size) applicationSockets.delete(Number(userId));
        return true;
    }

    function recordApplicationActivity(userId, socketId) {
        if (!socketId) return false;
        const sockets = getUserSocketMap(applicationActivity, userId, true);
        if (!sockets) return false;
        sockets.set(String(socketId), now());
        return true;
    }

    function getAdminPresence(userId) {
        const id = Number(userId);
        const connections = getUserSocketMap(applicationSockets, id, false);
        if (!connections || !connections.size) return "offline";
        const hasWebsite = Array.from(connections.values()).includes("website");
        if (!hasWebsite) return "unavailable";
        const activity = getUserSocketMap(applicationActivity, id, false);
        let latest = 0;
        if (activity) for (const [socketId, stamp] of activity) {
            if (!connections.has(socketId)) activity.delete(socketId);
            else if (stamp > latest) latest = stamp;
        }
        if (activity && !activity.size) applicationActivity.delete(id);
        if (!latest) return "unavailable";
        return now() - latest <= 5 * 60 * 1000 ? "online" : "away";
    }

    function clearSocket(socketId) {
        const key = String(socketId || "");
        if (!key) return;
        for (const [userId, sockets] of websiteSockets) {
            sockets.delete(key);
            if (!sockets.size) websiteSockets.delete(userId);
        }
        for (const [userId, sockets] of applicationSockets) {
            sockets.delete(key);
            if (!sockets.size) applicationSockets.delete(userId);
        }
        for (const [userId, sockets] of applicationActivity) {
            sockets.delete(key);
            if (!sockets.size) applicationActivity.delete(userId);
        }
        for (const [userId, matches] of chessSockets) {
            for (const [matchId, sockets] of matches) {
                sockets.delete(key);
                if (!sockets.size) matches.delete(matchId);
            }
            if (!matches.size) chessSockets.delete(userId);
        }
    }

    function hasFreshSocket(sockets, stamp) {
        if (!sockets) return false;
        let active = false;
        for (const [socketId, lastSeen] of sockets) {
            if (stamp - lastSeen > ttlMs) sockets.delete(socketId);
            else active = true;
        }
        return active;
    }

    function isWebsitePresent(userId) {
        const sockets = getUserSocketMap(websiteSockets, userId, false);
        const active = hasFreshSocket(sockets, now());
        if (sockets && !sockets.size) websiteSockets.delete(Number(userId));
        return active;
    }

    function isChessMatchVisible(userId, matchId) {
        const matches = getUserSocketMap(chessSockets, userId, false);
        const sockets = matches && matches.get(Number(matchId));
        const active = hasFreshSocket(sockets, now());
        if (matches && sockets && !sockets.size) matches.delete(Number(matchId));
        if (matches && !matches.size) chessSockets.delete(Number(userId));
        return active;
    }

    return { setWebsitePresence, setChessMatchPresence, setApplicationSocket, recordApplicationActivity,
        getAdminPresence, clearSocket, isWebsitePresent, isChessMatchVisible };
}

module.exports = createAccountPresence;
