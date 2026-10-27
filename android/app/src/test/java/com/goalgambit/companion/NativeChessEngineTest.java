package com.goalgambit.companion;

import org.junit.Test;

import com.github.bhlangonijr.chesslib.Board;
import com.github.bhlangonijr.chesslib.move.Move;
import com.github.bhlangonijr.chesslib.move.MoveList;

import static org.junit.Assert.*;

public final class NativeChessEngineTest {
    private static final String START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    @Test public void nativeRulesAcceptLegalMoveAndRejectIllegalMove() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(10, START, "", 0, 60000, 60000, "w", "1+0", 1000, false);

        NativeChessEngine.Result legal = engine.processMove("move-legal-0001", 10, 1,
            START, "", "e2", "e4", null,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "1. e4",
            false, 0, 0, "b", "1+0", 1200);
        assertTrue(legal.legal);
        assertTrue(legal.agreesWithExpectedPosition);
        assertEquals("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", legal.resultingFen);

        NativeChessEngine other = new NativeChessEngine();
        other.seedSnapshot(11, START, "", 0, 60000, 60000, "w", "1+0", 1000, false);
        NativeChessEngine.Result illegal = other.processMove("move-illegal-0001", 11, 1,
            START, "", "e2", "e5", null, "", "", false, 0, 0, "b", "1+0", 1200);
        assertFalse(illegal.legal);
        assertEquals(START, illegal.resultingFen);
    }

    @Test public void nativeEngineHandlesCastlingEnPassantAndPromotion() {
        String castleStart = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
        NativeChessEngine.Result castle = new NativeChessEngine().analyzePosition(castleStart, "");
        assertTrue(castle.legalMoves.contains("e1g1"));

        String epStart = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
        NativeChessEngine.Result enPassant = new NativeChessEngine().analyzePosition(epStart, "");
        assertTrue(enPassant.legalMoves.contains("e5d6"));

        String promotionStart = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
        NativeChessEngine.Result promotion = new NativeChessEngine().analyzePosition(promotionStart, "");
        assertTrue(promotion.legalMoves.contains("a7a8q"));
        assertTrue(promotion.legalMoves.contains("a7a8r"));
        assertTrue(promotion.legalMoves.contains("a7a8b"));
        assertTrue(promotion.legalMoves.contains("a7a8n"));
    }

    @Test public void nativeEngineDetectsCheckmateAndStalemate() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(30, START, "", 0, 60000, 60000, "w", "1+0", 0, false);
        String fen = START;
        String pgn = "";
        String[][] moves = {
            {"e2", "e4"}, {"e7", "e5"}, {"d1", "h5"}, {"b8", "c6"},
            {"f1", "c4"}, {"g8", "f6"}, {"h5", "f7"}
        };
        Board expectedBoard = new Board();
        MoveList expectedMoves = new MoveList();
        NativeChessEngine.Result last = null;
        for (int index = 0; index < moves.length; index++) {
            applyExpectedMove(expectedBoard, expectedMoves, moves[index][0], moves[index][1]);
            last = engine.processMove("mate-move-" + index + "0000", 30, index + 1,
                fen, pgn, moves[index][0], moves[index][1], null,
                expectedFen(expectedBoard), expectedMoves.toSanWithMoveNumbers(), false,
                0, 0, expectedBoard.getSideToMove().toString().toLowerCase(), "1+0", index * 100L);
            assertTrue("move " + moves[index][0] + moves[index][1] + " was rejected: " + last.error, last.legal);
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
        engine.seedSnapshot(40, START, "", 0, 60000, 60000, "w", "1+1", 1000, false);

        NativeChessEngine.Result move = engine.processMove("clock-move-000001", 40, 1,
            START, "", "e2", "e4", null,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "1. e4",
            false, 0, 0, "b", "1+1", 3000);

        assertNotNull(move.clockEstimate);
        assertEquals(59000, move.clockEstimate.whiteTimeMs);
        assertEquals(60000, move.clockEstimate.blackTimeMs);
        assertEquals("b", move.clockEstimate.activeColor);
    }

    @Test public void nativeEngineRetainsPositionHistoryForThreefoldRepetition() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(50, START, "", 0, 60000, 60000, "w", "1+0", 0, false);
        String fen = START;
        String pgn = "";
        String[][] moves = {
            {"g1", "f3"}, {"g8", "f6"}, {"f3", "g1"}, {"f6", "g8"},
            {"g1", "f3"}, {"g8", "f6"}, {"f3", "g1"}, {"f6", "g8"}
        };
        Board expectedBoard = new Board();
        MoveList expectedMoves = new MoveList();
        NativeChessEngine.Result last = null;
        for (int index = 0; index < moves.length; index++) {
            applyExpectedMove(expectedBoard, expectedMoves, moves[index][0], moves[index][1]);
            last = engine.processMove("repetition-move-" + index + "0000", 50, index + 1,
                fen, pgn, moves[index][0], moves[index][1], null,
                expectedFen(expectedBoard), expectedMoves.toSanWithMoveNumbers(), false,
                0, 0, expectedBoard.getSideToMove().toString().toLowerCase(), "1+0", index * 100L);
            assertTrue("move " + moves[index][0] + moves[index][1] + " was rejected: " + last.error, last.legal);
            fen = last.resultingFen;
            pgn = last.pgn;
        }
        assertNotNull(last);
        assertTrue("the native rules engine should recognize the third occurrence of the position", last.draw);
    }

    @Test public void companionPrecomputesBoundedRepliesAndUsesOnlyAnExactPositionHit() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(55, START, "", 0, 60000, 60000, "w", "5+0", 0, false);
        assertEquals("an exact verified snapshot gets its immediate legal moves first", 1,
            engine.precomputeCurrentPosition(55, START));
        assertEquals("a repeated request does not duplicate immediate-position work", 0,
            engine.precomputeCurrentPosition(55, START));
        String afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        NativeChessEngine.Result e4 = engine.processMove("prediction-e4-0001", 55, 1,
            START, "", "e2", "e4", null, afterE4, "1. e4",
            false, 0, 0, "b", "5+0", 100);
        assertTrue(e4.agreesWithExpectedPosition);

        int prepared = engine.precomputeNextPositions(55, afterE4, 32);
        assertTrue("the bounded worker should prepare plausible opponent replies", prepared > 0);
        assertTrue(prepared <= 32);

        Board predictionRoot = new Board();
        predictionRoot.loadFromFen(afterE4);
        Move predictedReply = predictionRoot.legalMoves().get(0);
        String predictedReplyUci = predictedReply.toString();
        String replyFrom = predictedReplyUci.substring(0, 2);
        String replyTo = predictedReplyUci.substring(2, 4);
        String promotion = predictedReplyUci.length() > 4 ? predictedReplyUci.substring(4) : null;
        Board expectedBoard = new Board();
        MoveList expectedMoves = new MoveList();
        applyExpectedMove(expectedBoard, expectedMoves, "e2", "e4");
        applyExpectedMove(expectedBoard, expectedMoves, replyFrom, replyTo);
        String afterReply = expectedFen(expectedBoard);
        NativeChessEngine.Result reply = engine.processMove("prediction-reply-0002", 55, 2,
            afterE4, "1. e4", replyFrom, replyTo, promotion, afterReply, expectedMoves.toSanWithMoveNumbers(),
            false, 0, 0, "w", "5+0", 200);
        assertTrue(reply.legal);
        assertTrue(reply.agreesWithExpectedPosition);
        assertTrue("the resulting exact FEN should hit the predicted legal-move list", reply.predictionCacheHit);
        String expectedNextMove = expectedBoard.legalMoves().get(0).toString();
        assertTrue("the exact-FEN cache hit should include a legal move for the resulting position",
            reply.legalMoves.contains(expectedNextMove));
        assertEquals("older branches are discarded after a confirmed different position", 0,
            engine.precomputeNextPositions(55, afterE4, 32));
        NativeChessEngine.PredictionStats stats = engine.predictionStats();
        assertTrue(stats.cacheHits > 0);
        assertTrue(stats.cachedPositions <= 128);
        assertTrue(stats.predictedBranches > 0);
        assertTrue(stats.predictionComputeNanos > 0);
        assertTrue(stats.estimatedCacheBytes > 0);
    }

    @Test public void bulletControlSkipsSpeculativeBranchesButKeepsImmediateLegalMoves() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(56, START, "", 0, 60000, 60000, "w", "1+0", 0, false);
        assertEquals(1, engine.precomputeCurrentPosition(56, START));
        assertEquals("the move's immediate confirmed position remains inexpensive", 0,
            engine.precomputeNextPositions(56, START, 0));
        assertEquals(1, engine.predictionStats().cachedPositions);
        assertEquals(0, engine.predictionStats().predictedBranches);
    }

    @Test public void mismatchedSnapshotDoesNotReplacePreviouslyVerifiedPosition() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(60, START, "", 0, 60000, 60000, "w", "1+0", 0, false);
        String afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        NativeChessEngine.Result first = engine.processMove("verified-e4-0001", 60, 1,
            START, "", "e2", "e4", null, afterE4, "1. e4",
            false, 0, 0, "b", "1+0", 100);
        assertTrue(first.agreesWithExpectedPosition);

        NativeChessEngine.Result rejectedSnapshot = engine.seedSnapshot(60, START, "", 0,
            60000, 60000, "w", "1+0", 200, false);
        assertTrue(rejectedSnapshot.stale);

        NativeChessEngine.Result next = engine.processMove("verified-e5-0002", 60, 2,
            afterE4, "1. e4", "e7", "e5", null,
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "1. e4 e5",
            false, 0, 0, "w", "1+0", 300);
        assertTrue("the verifier must continue from its prior verified line", next.legal);
        assertTrue(next.agreesWithExpectedPosition);
    }

    @Test public void mismatchInConfirmedMoveMarksSessionUnverifiedUntilServerResync() {
        NativeChessEngine engine = new NativeChessEngine();
        engine.seedSnapshot(61, START, "", 0, 60000, 60000, "w", "1+0", 0, false);
        NativeChessEngine.Result mismatch = engine.processMove("mismatch-e4-0001", 61, 1,
            START, "", "e2", "e4", null,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1", "1. e4",
            false, 0, 0, "b", "1+0", 100);
        assertTrue(mismatch.legal);
        assertFalse(mismatch.agreesWithExpectedPosition);

        NativeChessEngine.Result blocked = engine.processMove("blocked-e5-0002", 61, 2,
            mismatch.resultingFen, mismatch.pgn, "e7", "e5", null, "", "",
            false, 0, 0, "w", "1+0", 200);
        assertTrue(blocked.stale);
        assertFalse(blocked.legal);

        String officialAfterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        NativeChessEngine.Result reconciled = engine.seedSnapshot(61, officialAfterE4, "1. e4", 1,
            60000, 60000, "b", "1+0", 300, true);
        assertTrue(reconciled.historyComplete);
        assertTrue(reconciled.agreesWithExpectedPosition);
        assertFalse(reconciled.stale);
    }

    private static void applyExpectedMove(Board board, MoveList moves, String from, String to) {
        Move move = new Move(from + to, board.getSideToMove());
        assertTrue("test fixture move must be legal: " + from + to, board.legalMoves().contains(move));
        assertTrue(board.doMove(move, false));
        moves.add(move);
    }

    private static String expectedFen(Board board) {
        String[] fields = board.getFen().trim().split("\\s+");
        if (fields.length >= 4 && !"-".equals(fields[3])) {
            String target = fields[3];
            boolean capturable = false;
            for (Move move : board.legalMoves()) {
                String uci = move.toString();
                if (uci.length() >= 4 && uci.substring(2, 4).equals(target)) {
                    capturable = true;
                    break;
                }
            }
            if (!capturable) fields[3] = "-";
        }
        return String.join(" ", fields);
    }
}
