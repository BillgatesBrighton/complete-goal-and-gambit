package com.goalgambit.companion;

/** A monotonic, advisory chess clock. The server remains authoritative online. */
final class NativeChessClock {
    static final class Snapshot {
        final long whiteTimeMs;
        final long blackTimeMs;
        final String activeColor;

        Snapshot(long whiteTimeMs, long blackTimeMs, String activeColor) {
            this.whiteTimeMs = whiteTimeMs;
            this.blackTimeMs = blackTimeMs;
            this.activeColor = activeColor;
        }
    }

    private long whiteTimeMs;
    private long blackTimeMs;
    private long incrementMs;
    private long lastTickElapsedMs;
    private String activeColor = "w";
    private boolean initialized;

    synchronized void reset(long whiteMs, long blackMs, String active, long increment, long nowElapsedMs) {
        whiteTimeMs = Math.max(0, whiteMs);
        blackTimeMs = Math.max(0, blackMs);
        activeColor = "b".equals(active) ? "b" : "w";
        incrementMs = Math.max(0, increment);
        lastTickElapsedMs = nowElapsedMs;
        initialized = true;
    }

    synchronized Snapshot snapshotAt(long nowElapsedMs) {
        if (!initialized) return new Snapshot(0, 0, activeColor);
        long elapsed = Math.max(0, nowElapsedMs - lastTickElapsedMs);
        long white = whiteTimeMs;
        long black = blackTimeMs;
        if ("w".equals(activeColor)) white = Math.max(0, white - elapsed);
        else black = Math.max(0, black - elapsed);
        return new Snapshot(white, black, activeColor);
    }

    /** Applies a locally confirmed move and its configured increment. */
    synchronized Snapshot applyMoveAt(String moverColor, long nowElapsedMs) {
        if (!initialized || !activeColor.equals(moverColor)) return null;
        Snapshot current = snapshotAt(nowElapsedMs);
        whiteTimeMs = current.whiteTimeMs;
        blackTimeMs = current.blackTimeMs;
        if ("w".equals(moverColor)) whiteTimeMs = safeAdd(whiteTimeMs, incrementMs);
        else blackTimeMs = safeAdd(blackTimeMs, incrementMs);
        activeColor = "w".equals(moverColor) ? "b" : "w";
        lastTickElapsedMs = nowElapsedMs;
        return new Snapshot(whiteTimeMs, blackTimeMs, activeColor);
    }

    static long incrementFromTimeControl(String value) {
        if (value == null) return 0;
        int plus = value.lastIndexOf('+');
        if (plus < 0 || plus == value.length() - 1) return 0;
        try {
            return Math.max(0, Long.parseLong(value.substring(plus + 1).trim())) * 1000L;
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private static long safeAdd(long left, long right) {
        if (Long.MAX_VALUE - left < right) return Long.MAX_VALUE;
        return left + right;
    }
}
