package com.goalgambit.companion;

import com.github.bhlangonijr.chesslib.Board;
import com.github.bhlangonijr.chesslib.move.Move;
import com.github.bhlangonijr.chesslib.move.MoveList;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Native, local chess rules processing used by the companion's authenticated
 * Socket.IO assist channel. It never decides official online results.
 */
final class NativeChessEngine {
    static final class Result {
        final boolean legal;
        final boolean stale;
        final boolean historyComplete;
        final boolean agreesWithExpectedPosition;
        final boolean check;
        final boolean checkmate;
        final boolean stalemate;
        final boolean draw;
        final String resultingFen;
        final String pgn;
        final String san;
        final List<String> legalMoves;
        final NativeChessClock.Snapshot clockEstimate;
        final String error;

        Result(boolean legal, boolean stale, boolean historyComplete, boolean agreesWithExpectedPosition,
               boolean check, boolean checkmate, boolean stalemate, boolean draw,
               String resultingFen, String pgn, String san, List<String> legalMoves,
               NativeChessClock.Snapshot clockEstimate, String error) {
            this.legal = legal;
            this.stale = stale;
            this.historyComplete = historyComplete;
            this.agreesWithExpectedPosition = agreesWithExpectedPosition;
            this.check = check;
            this.checkmate = checkmate;
            this.stalemate = stalemate;
            this.draw = draw;
            this.resultingFen = resultingFen;
            this.pgn = pgn;
            this.san = san;
            this.legalMoves = legalMoves;
            this.clockEstimate = clockEstimate;
            this.error = error;
        }
    }

    private static final class Position {
        final Board board;
        final MoveList moves;
        final boolean historyComplete;

        Position(Board board, MoveList moves, boolean historyComplete) {
            this.board = board;
            this.moves = moves;
            this.historyComplete = historyComplete;
        }
    }

    private static final class Session {
        Board board;
        MoveList moves;
        String fen;
        String pgn;
        int ply;
        boolean historyComplete;
        final NativeChessClock clock = new NativeChessClock();

        Session(Position position, String fen, String pgn, int ply) {
            board = position.board;
            moves = position.moves;
            this.fen = fen;
            this.pgn = pgn == null ? "" : pgn;
            this.ply = Math.max(0, ply);
            historyComplete = position.historyComplete;
        }
    }

    private final LinkedHashMap<Long, Session> sessions = new LinkedHashMap<Long, Session>(16, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<Long, Session> eldest) { return size() > 16; }
    };
    private final LinkedHashMap<String, Result> recentResults = new LinkedHashMap<String, Result>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Result> eldest) { return size() > 64; }
    };

    synchronized void seedSnapshot(long matchId, String fen, String pgn, int ply,
                                   long whiteMs, long blackMs, String activeColor,
                                   String timeControl, long nowElapsedMs) {
        Position position = buildPosition(fen, pgn);
        Session session = new Session(position, fen, pgn, ply);
        session.clock.reset(whiteMs, blackMs, activeColor,
            NativeChessClock.incrementFromTimeControl(timeControl), nowElapsedMs);
        sessions.put(matchId, session);
    }

    synchronized Result analyzePosition(String fen, String pgn) {
        Position position = buildPosition(fen, pgn);
        return inspect(position.board, position.historyComplete, null, true, false);
    }

    synchronized Result processMove(String requestId, long matchId, int ply,
                                    String fenBefore, String pgnBefore,
                                    String from, String to, String promotion,
                                    String expectedFen, String expectedPgn,
                                    boolean clockIsCurrent, long whiteMs, long blackMs,
                                    String activeColor, String timeControl,
                                    long nowElapsedMs) {
        Result duplicate = recentResults.get(requestId);
        if (duplicate != null) return duplicate;
        if (matchId <= 0 || ply <= 0 || !validSquare(from) || !validSquare(to) ||
            (promotion != null && !promotion.isEmpty() && !"qrbn".contains(promotion))) {
            return error("Invalid native chess request.");
        }

        Session session = sessions.get(matchId);
        if (session != null && ply <= session.ply) {
            if (ply == session.ply && session.fen.equals(expectedFen)) {
                Result alreadyProcessed = inspect(session.board, session.historyComplete,
                    session.clock.snapshotAt(nowElapsedMs), true, true);
                Result confirmed = new Result(alreadyProcessed.legal, false,
                    alreadyProcessed.historyComplete, true, alreadyProcessed.check,
                    alreadyProcessed.checkmate, alreadyProcessed.stalemate, alreadyProcessed.draw,
                    alreadyProcessed.resultingFen, session.pgn, "", alreadyProcessed.legalMoves,
                    alreadyProcessed.clockEstimate, null);
                recentResults.put(requestId, confirmed);
                return confirmed;
            }
            Result stale = new Result(false, true, session.historyComplete, false,
                false, false, false, false, session.fen, session.pgn, "", new ArrayList<>(),
                session.clock.snapshotAt(nowElapsedMs), "Out-of-order chess event.");
            recentResults.put(requestId, stale);
            return stale;
        }

        if (session == null || session.ply != ply - 1 || !session.fen.equals(fenBefore)) {
            Position base = buildPosition(fenBefore, pgnBefore);
            session = new Session(base, fenBefore, pgnBefore, ply - 1);
            sessions.put(matchId, session);
        }

        if (!session.fen.equals(fenBefore)) {
            Result stale = new Result(false, true, session.historyComplete, false,
                false, false, false, false, session.fen, session.pgn, "", new ArrayList<>(),
                session.clock.snapshotAt(nowElapsedMs), "The native position is out of date.");
            recentResults.put(requestId, stale);
            return stale;
        }

        Board board = session.board;
        String[] beforeFields = board.getFen().split("\\s+");
        String moverColor = beforeFields.length > 1 && "b".equals(beforeFields[1]) ? "b" : "w";
        String requestedUci = from + to + (promotion == null ? "" : promotion.toLowerCase(java.util.Locale.ROOT));
        List<Move> generated = board.legalMoves();
        Move legalMove = null;
        for (Move candidate : generated) {
            if (candidate.toString().equalsIgnoreCase(requestedUci)) { legalMove = candidate; break; }
        }
        if (legalMove == null) {
            Result illegal = inspect(board, session.historyComplete, session.clock.snapshotAt(nowElapsedMs), false, false);
            recentResults.put(requestId, illegal);
            return illegal;
        }

        String san = "";
        if (!board.doMove(legalMove, false)) {
            Result invalid = inspect(board, session.historyComplete, session.clock.snapshotAt(nowElapsedMs), false, false);
            recentResults.put(requestId, invalid);
            return invalid;
        }
        session.moves.add(legalMove);
        String resultingFen = canonicalFen(board);
        String resultingPgn;
        try { resultingPgn = session.moves.toSanWithMoveNumbers(); }
        catch (Exception ignored) { resultingPgn = expectedPgn == null ? "" : expectedPgn; }
        session.fen = resultingFen;
        session.pgn = resultingPgn;
        session.ply = ply;

        if (clockIsCurrent) {
            session.clock.reset(whiteMs, blackMs, activeColor,
                NativeChessClock.incrementFromTimeControl(timeControl), nowElapsedMs);
        } else {
            session.clock.applyMoveAt(moverColor, nowElapsedMs);
        }
        NativeChessClock.Snapshot clock = session.clock.snapshotAt(nowElapsedMs);
        Result result = inspect(board, session.historyComplete, clock, true,
            expectedFen != null && sameFen(board, expectedFen));
        Result withMove = new Result(result.legal, result.stale, result.historyComplete,
            result.agreesWithExpectedPosition, result.check, result.checkmate, result.stalemate,
            result.draw, result.resultingFen, resultingPgn, san, result.legalMoves, clock, null);

        if (!withMove.agreesWithExpectedPosition && expectedFen != null && !expectedFen.isEmpty()) {
            Position authoritative = buildPosition(expectedFen, expectedPgn);
            Session corrected = new Session(authoritative, expectedFen, expectedPgn, ply);
            if (clockIsCurrent) corrected.clock.reset(whiteMs, blackMs, activeColor,
                NativeChessClock.incrementFromTimeControl(timeControl), nowElapsedMs);
            sessions.put(matchId, corrected);
        }
        recentResults.put(requestId, withMove);
        return withMove;
    }

    private static Result inspect(Board board, boolean historyComplete, NativeChessClock.Snapshot clock,
                                  boolean legal, boolean agrees) {
        List<String> legalMoves = new ArrayList<>();
        try { for (Move move : board.legalMoves()) legalMoves.add(move.toString().toLowerCase(java.util.Locale.ROOT)); }
        catch (RuntimeException ignored) {}
        boolean check = board.isKingAttacked();
        boolean mate = board.isMated();
        boolean stalemate = board.isStaleMate();
        boolean draw = board.isDraw() || stalemate;
        return new Result(legal, false, historyComplete, agrees, check, mate, stalemate, draw,
            canonicalFen(board), "", "", legalMoves, clock, null);
    }

    private static Position buildPosition(String fen, String pgn) {
        Board board = new Board();
        MoveList moves = new MoveList();
        boolean complete = true;
        try {
            String san = cleanPgn(pgn);
            if (!san.isEmpty()) moves.loadFromSan(san);
            for (Move move : moves) {
                if (!board.doMove(move, false)) throw new IllegalArgumentException("Invalid move history");
            }
        if (fen != null && !fen.isEmpty() && !sameFen(board, fen)) {
                complete = false;
                board.loadFromFen(fen);
                moves = new MoveList(fen);
            }
        } catch (Exception malformedHistory) {
            complete = false;
            board = new Board();
            if (fen != null && !fen.isEmpty()) {
                try { board.loadFromFen(fen); }
                catch (RuntimeException malformedFen) { board = new Board(); }
            }
            moves = new MoveList(fen == null || fen.isEmpty() ? board.getFen() : fen);
        }
        return new Position(board, moves, complete);
    }

    private static String cleanPgn(String pgn) {
        if (pgn == null || pgn.isEmpty()) return "";
        String clean = pgn.replaceAll("(?m)^\\s*\\[[^\\]]*]\\s*$", " ")
            .replaceAll("\\{[^}]*}", " ")
            .replaceAll("\\([^)]*\\)", " ")
            .replaceAll("\\$\\d+", " ")
            .replaceAll("(?:^|\\s)(?:1-0|0-1|1/2-1/2|\\*)(?:\\s|$)", " ");
        return clean.trim();
    }

    private static boolean validSquare(String value) {
        return value != null && value.matches("[a-h][1-8]");
    }

    /** chess.js omits a FEN en-passant target unless a legal capture exists. */
    private static boolean sameFen(Board board, String fen) {
        if (fen == null || fen.isEmpty()) return false;
        Board expected = new Board();
        try { expected.loadFromFen(fen); }
        catch (RuntimeException malformedFen) { return false; }
        return canonicalFen(board).equals(canonicalFen(expected));
    }

    private static String canonicalFen(Board board) {
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

    private static Result error(String message) {
        return new Result(false, false, false, false, false, false, false, false,
            "", "", "", new ArrayList<>(), null, message);
    }
}
