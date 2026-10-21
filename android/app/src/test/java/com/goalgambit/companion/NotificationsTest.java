package com.goalgambit.companion;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class NotificationsTest {
    @Test
    public void missingChessEventKeyIsSafeForOrdinaryAppLaunch() {
        assertEquals(0L, Notifications.chessMatchIdFromEventKey(null));
    }

    @Test
    public void unrelatedEventKeyDoesNotSelectChessMatch() {
        assertEquals(0L, Notifications.chessMatchIdFromEventKey("room-code-sent:123"));
    }

    @Test
    public void validChessEventKeySelectsItsMatch() {
        assertEquals(123L, Notifications.chessMatchIdFromEventKey("chess-match:123:turn:2"));
    }
}
