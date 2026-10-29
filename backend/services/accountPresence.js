"use strict";

const DEFAULT_TTL_MS = 90_000;

function createAccountPresence(options) {
    options = options || {};
    const now = typeof options.now === "function" ? options.now : Date.now;
    const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    const websiteSockets = new Map();
    const chessSockets = new Map();

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

    function clearSocket(socketId) {
        const key = String(socketId || "");
        if (!key) return;
        for (const [userId, sockets] of websiteSockets) {
            sockets.delete(key);
            if (!sockets.size) websiteSockets.delete(userId);
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

    return { setWebsitePresence, setChessMatchPresence, clearSocket, isWebsitePresent, isChessMatchVisible };
}

module.exports = createAccountPresence;
