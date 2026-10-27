package com.goalgambit.companion;

import com.github.bhlangonijr.chesslib.Board;
import com.github.bhlangonijr.chesslib.move.Move;
import com.github.bhlangonijr.chesslib.move.MoveList;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
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
        final boolean predictionCacheHit;
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
            this(legal, stale, historyComplete, agreesWithExpectedPosition, check, checkmate,
                stalemate, draw, resultingFen, pgn, san, legalMoves, clockEstimate, error, false);
        }

        Result(boolean legal, boolean stale, boolean historyComplete, boolean agreesWithExpectedPosition,
               boolean check, boolean checkmate, boolean stalemate, boolean draw,
               String resultingFen, String pgn, String san, List<String> legalMoves,
               NativeChessClock.Snapshot clockEstimate, String error, boolean predictionCacheHit) {
            this.legal = legal;
            this.stale = stale;
            this.historyComplete = historyComplete;
            this.agreesWithExpectedPosition = agreesWithExpectedPosition;
            this.check = check;
            this.checkmate = checkmate;
            this.stalemate = stalemate;
            this.draw = draw;
            this.predictionCacheHit = predictionCacheHit;
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
        boolean verified;
        final NativeChessClock clock = new NativeChessClock();

        Session(Position position, String fen, String pgn, int ply) {
            board = position.board;
            moves = position.moves;
            this.fen = fen;
            this.pgn = pgn == null ? "" : pgn;
            this.ply = Math.max(0, ply);
            historyComplete = position.historyComplete;
            verified = position.historyComplete && sameFen(position.board, fen);
        }
    }

    private static final class CachedMoves {
        final String fen;
        final List<String> moves;

        CachedMoves(String fen, List<String> moves) {
            this.fen = fen;
            this.moves = moves;
        }
    }

    static final class PredictionStats {
        final long cacheHits;
        final long cacheMisses;
        final int cachedPositions;
        final long predictedBranches;
        final long predictionComputeNanos;
        final long estimatedCacheBytes;

        PredictionStats(long cacheHits, long cacheMisses, int cachedPositions,
                        long predictedBranches, long predictionComputeNanos,
                        long estimatedCacheBytes) {
            this.cacheHits = cacheHits;
            this.cacheMisses = cacheMisses;
            this.cachedPositions = cachedPositions;
            this.predictedBranches = predictedBranches;
            this.predictionComputeNanos = predictionComputeNanos;
            this.estimatedCacheBytes = estimatedCacheBytes;
        }
    }

    private static final int MAX_PREDICTED_POSITIONS = 128;
    private static final int MAX_BRANCHES = 32;
    private static final long MAX_PREDICTION_NANOS = 30_000_000L;

    private final LinkedHashMap<Long, Session> sessions = new LinkedHashMap<Long, Session>(16, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<Long, Session> eldest) { return size() > 16; }
    };
    private final LinkedHashMap<String, Result> recentResults = new LinkedHashMap<String, Result>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Result> eldest) { return size() > 64; }
    };
    private final Object predictionCacheLock = new Object();
    private final LinkedHashMap<String, CachedMoves> predictionCache = new LinkedHashMap<String, CachedMoves>(64, 0.75f, true);
    private final Map<Long, Long> predictionGeneration = new HashMap<>();
    private final Map<Long, String> predictionSourceFen = new HashMap<>();
    private long predictionCacheHits;
    private long predictionCacheMisses;
    private long predictedBranches;
    private long predictionComputeNanos;

    synchronized Result seedSnapshot(long matchId, String fen, String pgn, int ply,
                                     long whiteMs, long blackMs, String activeColor,
                                     String timeControl, long nowElapsedMs,
                                     boolean acceptAuthoritativeResync) {
        Position position = buildPosition(fen, pgn);
        Session previous = sessions.get(matchId);
        boolean consistent = position.historyComplete && sameFen(position.board, fen);
        if (previous != null && !acceptAuthoritativeResync &&
            (ply < previous.ply || (ply == previous.ply && !previous.fen.equals(fen)))) {
            return inspect(previous.board, previous.historyComplete,
                previous.clock.snapshotAt(nowElapsedMs), false, false, true,
                "The server snapshot differs from the last verified local position.");
        }
        if (!consistent) {
            return inspect(position.board, position.historyComplete, null, false, false, true,
                "The server snapshot move history does not match its position.");
        }
        clearPredictionCache(matchId);
        Session session = new Session(position, fen, pgn, ply);
        session.clock.reset(whiteMs, blackMs, activeColor,
            NativeChessClock.incrementFromTimeControl(timeControl), nowElapsedMs);
        session.verified = true;
        sessions.put(matchId, session);
        return inspect(session.board, true, session.clock.snapshotAt(nowElapsedMs), true, true, false, null);
    }

    synchronized Result analyzePosition(String fen, String pgn) {
        Position position = buildPosition(fen, pgn);
        return inspect(position.board, position.historyComplete, null, true, false);
    }

    synchronized int precomputeCurrentPosition(long matchId, String sourceFen) {
        Session session = sessions.get(matchId);
        if (session == null || !session.verified || sourceFen == null ||
            !sourceFen.equals(session.fen) || !sameFen(session.board, sourceFen)) return 0;
        if (getCachedLegalMoves(matchId, sourceFen) != null) return 0;
        storeCachedLegalMoves(matchId, sourceFen, moveStrings(session.board.legalMoves()));
        return 1;
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
        if (session != null && !session.verified) {
            Result unverified = inspect(session.board, session.historyComplete,
                session.clock.snapshotAt(nowElapsedMs), false, false, true,
                "The native position is unverified; a server snapshot is required.");
            recentResults.put(requestId, unverified);
            return unverified;
        }
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

        if (session == null) {
            Position base = buildPosition(fenBefore, pgnBefore);
            if (!base.historyComplete || !sameFen(base.board, fenBefore)) {
                Result unverifiable = inspect(base.board, base.historyComplete, null, false, false, true,
                    "The previous server position could not be independently reconstructed.");
                recentResults.put(requestId, unverifiable);
                return unverifiable;
            }
            session = new Session(base, fenBefore, pgnBefore, ply - 1);
            sessions.put(matchId, session);
        }

        if (session.ply != ply - 1 || !session.fen.equals(fenBefore)) {
            Result stale = inspect(session.board, session.historyComplete,
                session.clock.snapshotAt(nowElapsedMs), false, false, true,
                "The confirmed move is out of order or starts from a different verified position.");
            recentResults.put(requestId, stale);
            return stale;
        }

        Board board = session.board;
        String[] beforeFields = board.getFen().split("\\s+");
        String moverColor = beforeFields.length > 1 && "b".equals(beforeFields[1]) ? "b" : "w";
        String requestedUci = from + to + (promotion == null ? "" : promotion.toLowerCase(java.util.Locale.ROOT));
        Move legalMove = null;
        List<String> cachedCurrentMoves = getCachedLegalMoves(matchId, canonicalFen(board));
        if (cachedCurrentMoves != null) {
            if (cachedCurrentMoves.contains(requestedUci.toLowerCase(java.util.Locale.ROOT))) {
                legalMove = new Move(requestedUci, board.getSideToMove());
            }
        } else {
            List<Move> generated = board.legalMoves();
            List<String> generatedUci = moveStrings(generated);
            storeCachedLegalMoves(matchId, canonicalFen(board), generatedUci);
            for (Move candidate : generated) {
                if (candidate.toString().equalsIgnoreCase(requestedUci)) { legalMove = candidate; break; }
            }
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
        List<String> resultingLegalMoves = getCachedLegalMoves(matchId, resultingFen);
        boolean resultingPositionCacheHit = resultingLegalMoves != null;
        if (resultingLegalMoves == null) {
            resultingLegalMoves = moveStrings(board.legalMoves());
            storeCachedLegalMoves(matchId, resultingFen, resultingLegalMoves);
        }
        boolean agreesWithExpectedPosition = expectedFen != null && sameFen(board, expectedFen);
        Result result = inspect(board, session.historyComplete, clock, true,
            agreesWithExpectedPosition, resultingLegalMoves);
        Result withMove = new Result(result.legal, result.stale, result.historyComplete,
            result.agreesWithExpectedPosition, result.check, result.checkmate, result.stalemate,
            result.draw, result.resultingFen, resultingPgn, san, result.legalMoves, clock, null,
            resultingPositionCacheHit);

        session.verified = withMove.historyComplete && withMove.agreesWithExpectedPosition;
        if (session.verified) retainOnlyPredictionFor(matchId, resultingFen);
        else clearPredictionCache(matchId);
        recentResults.put(requestId, withMove);
        return withMove;
    }

    private static Result inspect(Board board, boolean historyComplete, NativeChessClock.Snapshot clock,
                                  boolean legal, boolean agrees) {
        return inspect(board, historyComplete, clock, legal, agrees, false, null);
    }

    private static Result inspect(Board board, boolean historyComplete, NativeChessClock.Snapshot clock,
                                  boolean legal, boolean agrees, boolean stale, String error) {
        return inspect(board, historyComplete, clock, legal, agrees, stale, error,
            moveStrings(board.legalMoves()));
    }

    private static Result inspect(Board board, boolean historyComplete, NativeChessClock.Snapshot clock,
                                  boolean legal, boolean agrees, boolean stale, String error,
                                  List<String> legalMoves) {
        boolean check = board.isKingAttacked();
        boolean mate = board.isMated();
        boolean stalemate = board.isStaleMate();
        boolean draw = board.isDraw() || stalemate;
        return new Result(legal, stale, historyComplete, agrees, check, mate, stalemate, draw,
            canonicalFen(board), "", "", legalMoves, clock, error);
    }

    private static Result inspect(Board board, boolean historyComplete, NativeChessClock.Snapshot clock,
                                  boolean legal, boolean agrees, List<String> legalMoves) {
        return inspect(board, historyComplete, clock, legal, agrees, false, null, legalMoves);
    }

    private static List<String> moveStrings(List<Move> moves) {
        List<String> result = new ArrayList<>();
        try {
            for (Move move : moves) result.add(move.toString().toLowerCase(java.util.Locale.ROOT));
        } catch (RuntimeException ignored) {}
        return result;
    }

    private List<String> getCachedLegalMoves(long matchId, String fen) {
        String key = predictionCacheKey(matchId, fen);
        synchronized (predictionCacheLock) {
            CachedMoves entry = predictionCache.get(key);
            if (entry != null && entry.fen.equals(fen)) {
                predictionCacheHits++;
                return new ArrayList<>(entry.moves);
            }
            predictionCacheMisses++;
            return null;
        }
    }

    private void storeCachedLegalMoves(long matchId, String fen, List<String> moves) {
        if (matchId <= 0 || fen == null || fen.isEmpty() || moves == null) return;
        synchronized (predictionCacheLock) {
            predictionCache.put(predictionCacheKey(matchId, fen), new CachedMoves(fen, new ArrayList<>(moves)));
            trimPredictionCache();
        }
    }

    private void clearPredictionCache(long matchId) {
        synchronized (predictionCacheLock) {
            predictionGeneration.put(matchId, predictionGeneration.getOrDefault(matchId, 0L) + 1L);
            predictionSourceFen.remove(matchId);
            removeMatchPredictions(matchId, null);
        }
    }

    private void retainOnlyPredictionFor(long matchId, String fen) {
        synchronized (predictionCacheLock) {
            predictionGeneration.put(matchId, predictionGeneration.getOrDefault(matchId, 0L) + 1L);
            predictionSourceFen.put(matchId, fen);
            removeMatchPredictions(matchId, predictionCacheKey(matchId, fen));
        }
    }

    private void removeMatchPredictions(long matchId, String keepKey) {
        String prefix = matchId + ":";
        Iterator<Map.Entry<String, CachedMoves>> iterator = predictionCache.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, CachedMoves> entry = iterator.next();
            if (entry.getKey().startsWith(prefix) && !entry.getKey().equals(keepKey)) iterator.remove();
        }
    }

    private void trimPredictionCache() {
        while (predictionCache.size() > MAX_PREDICTED_POSITIONS) {
            predictionCache.remove(predictionCache.keySet().iterator().next());
        }
    }

    private static String predictionCacheKey(long matchId, String fen) {
        return matchId + ":" + sha256(String.valueOf(fen));
    }

    /**
     * Precomputes legal replies for bounded positions reached after the current
     * side's possible moves. Run from the low-priority prediction executor.
     * Results are committed only if the source position is still current.
     */
    int precomputeNextPositions(long matchId, String sourceFen, int maxBranches) {
        if (matchId <= 0 || sourceFen == null || sourceFen.isEmpty() || maxBranches <= 0) return 0;
        long startedAt = System.nanoTime();
        final long generation;
        synchronized (predictionCacheLock) {
            if (!sourceFen.equals(predictionSourceFen.get(matchId))) return 0;
            generation = predictionGeneration.getOrDefault(matchId, 0L);
        }
        Board root = new Board();
        try { root.loadFromFen(sourceFen); }
        catch (RuntimeException invalidFen) { return 0; }
        if (!sameFen(root, sourceFen)) return 0;
        List<Move> responses = root.legalMoves();
        int limit = Math.min(Math.min(MAX_BRANCHES, maxBranches), responses.size());
        long deadline = System.nanoTime() + MAX_PREDICTION_NANOS;
        LinkedHashMap<String, CachedMoves> computed = new LinkedHashMap<>();
        for (int index = 0; index < limit; index++) {
            if (System.nanoTime() >= deadline) break;
            Board branch = root.clone();
            if (!branch.doMove(responses.get(index), false)) continue;
            String branchFen = canonicalFen(branch);
            computed.put(predictionCacheKey(matchId, branchFen),
                new CachedMoves(branchFen, moveStrings(branch.legalMoves())));
        }
        synchronized (predictionCacheLock) {
            if (generation != predictionGeneration.getOrDefault(matchId, 0L) ||
                !sourceFen.equals(predictionSourceFen.get(matchId))) return 0;
            predictionCache.putAll(computed);
            trimPredictionCache();
            predictedBranches += computed.size();
            predictionComputeNanos += Math.max(0L, System.nanoTime() - startedAt);
        }
        return computed.size();
    }

    PredictionStats predictionStats() {
        synchronized (predictionCacheLock) {
            long estimatedBytes = 0L;
            for (Map.Entry<String, CachedMoves> entry : predictionCache.entrySet()) {
                estimatedBytes += 32L + (entry.getKey().length() + entry.getValue().fen.length()) * 2L;
                for (String move : entry.getValue().moves) estimatedBytes += 16L + move.length() * 2L;
            }
            return new PredictionStats(predictionCacheHits, predictionCacheMisses,
                predictionCache.size(), predictedBranches, predictionComputeNanos, estimatedBytes);
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest(String.valueOf(value).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
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
