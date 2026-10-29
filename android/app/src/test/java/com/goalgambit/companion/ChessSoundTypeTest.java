package com.goalgambit.companion;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ChessSoundTypeTest {
    @Test public void verifiedMoveFlagsSelectTheRightFeedback() {
        assertEquals(ChessSoundType.MOVE, ChessSoundType.forMove("n", false, false, false));
        assertEquals(ChessSoundType.CAPTURE, ChessSoundType.forMove("c", true, false, false));
        assertEquals(ChessSoundType.CAPTURE, ChessSoundType.forMove("e", false, false, false));
        assertEquals(ChessSoundType.CASTLE, ChessSoundType.forMove("k", false, false, false));
        assertEquals(ChessSoundType.CASTLE, ChessSoundType.forMove("q", false, false, false));
        assertEquals(ChessSoundType.CHECK, ChessSoundType.forMove("n", false, true, false));
        assertEquals(ChessSoundType.CHECKMATE, ChessSoundType.forMove("c", true, true, true));
    }

    @Test public void pushEventKeysMapOnlyKnownChessEventsToSounds() {
        assertEquals(ChessSoundType.MATCH_FOUND, ChessSoundType.forNotification("chess-match:501:turn:1"));
        assertEquals(ChessSoundType.GAME_OVER, ChessSoundType.forNotification("chess-match:501:finished:white_win"));
        assertEquals(ChessSoundType.CHALLENGE, ChessSoundType.forNotification("chess-schedule-invite:72"));
        assertEquals(ChessSoundType.CHALLENGE_ACCEPTED, ChessSoundType.forNotification("chess-schedule-accepted:72"));
        assertEquals(ChessSoundType.GAME_START, ChessSoundType.forNotification("chess-schedule-started:72"));
        assertEquals(ChessSoundType.REMINDER, ChessSoundType.forNotification("chess-schedule-reminder-10m:72:3"));
        assertNull(ChessSoundType.forNotification("room-code-sent:501"));
        assertNull(ChessSoundType.forNotification("chess-match:501:finished:database-error"));
    }
}
