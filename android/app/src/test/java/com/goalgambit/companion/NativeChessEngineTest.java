package com.goalgambit.companion;

import org.junit.Test;

import static org.junit.Assert.*;

public final class NativeChessEngineTest {
    private static final String START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    @Test public void nativeRulesAcceptLegalMoveAndRejectIllegalMove() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(10, START, "", 0, 60000, 60000, "w", "1+0", 1000);

        NativeChessEngine.Result legal = engine.processMove("move-legal-0001", 10, 1,
            START, "", "e2", "e4", null,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "1. e4",
            false, 0, 0, "b", "1+0", 1200);
        assertTrue(legal.legal);
        assertTrue(legal.agreesWithExpectedPosition);
        assertEquals("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", legal.resultingFen);

        NativeChessEngine other = new NativeChessEngine();
        other.seedSnapshot(11, START, "", 0, 60000, 60000, "w", "1+0", 1000);
        NativeChessEngine.Result illegal = other.processMove("move-illegal-0001", 11, 1,
            START, "", "e2", "e5", null, "", "", false, 0, 0, "b", "1+0", 1200);
        assertFalse(illegal.legal);
        assertEquals(START, illegal.resultingFen);
    }

    @Test public void nativeEngineHandlesCastlingEnPassantAndPromotion() {
        NativeChessEngine castleEngine = new NativeChessEngine();
        String castleStart = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
        castleEngine.seedSnapshot(20, castleStart, "", 0, 60000, 60000, "w", "5+3", 0);
        NativeChessEngine.Result castle = castleEngine.processMove("castle-00000001", 20, 1,
            castleStart, "", "e1", "g1", null,
            "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1", "1. O-O",
            false, 0, 0, "b", "5+3", 10);
        assertTrue(castle.legal);
        assertTrue(castle.agreesWithExpectedPosition);

        NativeChessEngine epEngine = new NativeChessEngine();
        String epStart = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
        epEngine.seedSnapshot(21, epStart, "", 2, 60000, 60000, "w", "1+0", 0);
        NativeChessEngine.Result enPassant = epEngine.processMove("ep-move-00000001", 21, 3,
            epStart, "", "e5", "d6", null,
            "4k3/8/3P4/8/8/8/8/4K3 b - - 0 2", "2. exd6",
            false, 0, 0, "b", "1+0", 10);
        assertTrue(enPassant.legal);
        assertTrue(enPassant.agreesWithExpectedPosition);

        NativeChessEngine promotionEngine = new NativeChessEngine();
        String promotionStart = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
        promotionEngine.seedSnapshot(22, promotionStart, "", 0, 60000, 60000, "w", "1+0", 0);
        NativeChessEngine.Result promotion = promotionEngine.processMove("promote-0000001", 22, 1,
            promotionStart, "", "a7", "a8", "q",
            "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1", "1. a8=Q+",
            false, 0, 0, "b", "1+0", 10);
        assertTrue(promotion.legal);
        assertTrue(promotion.agreesWithExpectedPosition);
    }

    @Test public void nativeEngineDetectsCheckmateAndStalemate() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(30, START, "", 0, 60000, 60000, "w", "1+0", 0);
        String fen = START;
        String pgn = "";
        String[][] moves = {
            {"e2", "e4"}, {"e7", "e5"}, {"d1", "h5"}, {"b8", "c6"},
            {"f1", "c4"}, {"g8", "f6"}, {"h5", "f7"}
        };
        NativeChessEngine.Result last = null;
        for (int index = 0; index < moves.length; index++) {
            last = engine.processMove("mate-move-" + index + "0000", 30, index + 1,
                fen, pgn, moves[index][0], moves[index][1], null,
                "", "", false, 0, 0, "w", "1+0", index * 100L);
            assertTrue(last.legal);
            fen = last.resultingFen;
            pgn = last.pgn;
        }
        assertNotNull(last);
        assertTrue(last.check);
        assertTrue(last.checkmate);
        assertFalse(last.stalemate);

        NativeChessEngine.Result stalemate = engine.analyzePosition("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1", "");
        assertTrue(stalemate.stalemate);
        assertTrue(stalemate.draw);
    }

    @Test public void nativeClockUsesMonotonicElapsedTimeAndIncrement() {
        NativeChessClock clock = new NativeChessClock();
        clock.reset(60000, 60000, "w", 2000, 5000);
        NativeChessClock.Snapshot afterThinking = clock.snapshotAt(7500);
        assertEquals(57500, afterThinking.whiteTimeMs);
        assertEquals(60000, afterThinking.blackTimeMs);

        NativeChessClock.Snapshot afterMove = clock.applyMoveAt("w", 7500);
        assertNotNull(afterMove);
        assertEquals(59500, afterMove.whiteTimeMs);
        assertEquals(60000, afterMove.blackTimeMs);
        assertEquals("b", afterMove.activeColor);
        NativeChessClock.Snapshot blackMove = clock.applyMoveAt("b", 7600);
        assertNotNull(blackMove);
        assertEquals(61900, blackMove.blackTimeMs);
        assertEquals("w", blackMove.activeColor);
        assertEquals(1000, NativeChessClock.incrementFromTimeControl("1+1"));
        assertEquals(0, NativeChessClock.incrementFromTimeControl("5"));
    }

    @Test public void engineAdvancesAdvisoryClockForOrderedLocalMoves() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(40, START, "", 0, 60000, 60000, "w", "1+1", 1000);

        NativeChessEngine.Result move = engine.processMove("clock-move-000001", 40, 1,
            START, "", "e2", "e4", null,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "1. e4",
            false, 0, 0, "b", "1+1", 3000);

        assertNotNull(move.clockEstimate);
        assertEquals(59000, move.clockEstimate.whiteTimeMs);
        assertEquals(60000, move.clockEstimate.blackTimeMs);
        assertEquals("b", move.clockEstimate.activeColor);
    }
}
