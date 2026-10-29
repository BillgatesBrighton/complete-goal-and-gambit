"use strict";

function beginChessJoinAttempt(socket) {
    socket.chessJoinGeneration = (Number(socket.chessJoinGeneration) || 0) + 1;
    if (socket.currentChessRoom) socket.leave(socket.currentChessRoom);
    socket.currentChessRoom = null;
    socket.currentChessMatchId = null;
    return socket.chessJoinGeneration;
}

function isCurrentChessJoinAttempt(socket, generation) {
    return socket.chessJoinGeneration === generation;
}

function leaveChessConnectionOnMatchChange(socket, requestedMatchId, connectionMonitor) {
    if (!socket || !connectionMonitor || !socket.chessConnection) return false;
    if (Number(socket.chessConnection.matchId) === Number(requestedMatchId)) return false;
    return connectionMonitor.leaveSocket(socket);
}

function hasValidChessMatchSeats(match) {
    const whiteId = Number(match && match.player_white_id);
    const blackId = Number(match && match.player_black_id);
    const validWhite = Number.isSafeInteger(whiteId) && whiteId > 0;
    const validBlack = Number.isSafeInteger(blackId) && blackId > 0;
    if (match && match.status === "waiting" && validWhite && match.player_black_id == null) return true;
    return validWhite && validBlack && whiteId !== blackId;
}

function joinChessMatchRoom(socket, matchId) {
    const id = Number(matchId);
    const room = "chess_match_" + id;
    if (socket.currentChessRoom && socket.currentChessRoom !== room) {
        socket.leave(socket.currentChessRoom);
    }
    socket.join(room);
    socket.currentChessMatchId = id;
    socket.currentChessRoom = room;
    return room;
}

module.exports = {
    beginChessJoinAttempt,
    isCurrentChessJoinAttempt,
    leaveChessConnectionOnMatchChange,
    hasValidChessMatchSeats,
    joinChessMatchRoom
};
