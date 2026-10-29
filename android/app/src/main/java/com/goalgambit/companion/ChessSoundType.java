package com.goalgambit.companion;

/** Sound classification for already verified chess and challenge events. */
enum ChessSoundType {
    MOVE,
    CAPTURE,
    CHECK,
    CHECKMATE,
    CASTLE,
    GAME_START,
    GAME_OVER,
    MATCH_FOUND,
    CHALLENGE,
    CHALLENGE_ACCEPTED,
    REMINDER;

    static ChessSoundType forMove(String flags, boolean captured, boolean check, boolean checkmate) {
        if (checkmate) return CHECKMATE;
        if (check) return CHECK;
        String moveFlags = String.valueOf(flags == null ? "" : flags).toLowerCase(java.util.Locale.ROOT);
        if (moveFlags.contains("k") || moveFlags.contains("q")) return CASTLE;
        if (captured || moveFlags.contains("c") || moveFlags.contains("e")) return CAPTURE;
        return MOVE;
    }

    static ChessSoundType forNotification(String eventKey) {
        String key = String.valueOf(eventKey == null ? "" : eventKey).toLowerCase(java.util.Locale.ROOT);
        if (key.matches("chess-match:[0-9]+:finished:(white_win|black_win|draw|completed)")) return GAME_OVER;
        if (key.matches("chess-match:[0-9]+:turn:1")) return MATCH_FOUND;
        if (key.startsWith("chess-schedule-invite:")) return CHALLENGE;
        if (key.startsWith("chess-schedule-accepted:")) return CHALLENGE_ACCEPTED;
        if (key.startsWith("chess-schedule-started:")) return GAME_START;
        if (key.startsWith("chess-schedule-reminder-")) return REMINDER;
        return null;
    }
}
