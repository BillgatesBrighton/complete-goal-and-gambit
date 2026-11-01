package com.goalgambit.trial;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChessPositionTest {
    private static final String START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    @Test public void readsPiecesFromFen() {
        ChessPosition position = new ChessPosition(START);
        assertEquals('K', position.pieceAt("e1"));
        assertEquals('k', position.pieceAt("e8"));
        assertEquals('P', position.pieceAt("a2"));
        assertEquals('p', position.pieceAt("h7"));
        assertEquals('\0', position.pieceAt("e4"));
    }

    @Test public void whitePerspectivePlacesWhiteHomeRankAtBottom() {
        ChessPosition position = new ChessPosition(START);
        assertEquals("a8", position.squareAt(0, 0, "w"));
        assertEquals("h8", position.squareAt(0, 7, "w"));
        assertEquals("a1", position.squareAt(7, 0, "w"));
        assertEquals("h1", position.squareAt(7, 7, "w"));
    }

    @Test public void blackPerspectivePlacesBlackHomeRankAtBottom() {
        ChessPosition position = new ChessPosition(START);
        assertEquals("h1", position.squareAt(0, 0, "b"));
        assertEquals("a1", position.squareAt(0, 7, "b"));
        assertEquals("h8", position.squareAt(7, 0, "b"));
        assertEquals("a8", position.squareAt(7, 7, "b"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsMalformedFen() {
        new ChessPosition("not-a-position");
    }
}
