package com.goalgambit.trial;

/** Small FEN board reader. The backend remains the authority for legal moves. */
final class ChessPosition {
    private final char[][] board = new char[8][8];

    ChessPosition(String fen) {
        if (fen == null || fen.trim().isEmpty()) throw new IllegalArgumentException("Chess position is empty.");
        String[] parts = fen.trim().split("\\s+");
        String[] ranks = parts[0].split("/");
        if (ranks.length != 8) throw new IllegalArgumentException("Chess position is invalid.");
        for (int row = 0; row < 8; row++) {
            int col = 0;
            for (int i = 0; i < ranks[row].length(); i++) {
                char symbol = ranks[row].charAt(i);
                if (symbol >= '1' && symbol <= '8') {
                    col += symbol - '0';
                } else if ("pnbrqkPNBRQK".indexOf(symbol) >= 0 && col < 8) {
                    board[row][col++] = symbol;
                } else {
                    throw new IllegalArgumentException("Chess position is invalid.");
                }
            }
            if (col != 8) throw new IllegalArgumentException("Chess position is incomplete.");
        }
    }

    char pieceAt(String square) {
        int[] point = point(square);
        return board[point[0]][point[1]];
    }

    String squareAt(int displayRow, int displayCol, String playerColor) {
        if (displayRow < 0 || displayRow > 7 || displayCol < 0 || displayCol > 7) {
            throw new IllegalArgumentException("Board cell is out of range.");
        }
        boolean blackPerspective = "b".equalsIgnoreCase(playerColor);
        int row = blackPerspective ? 7 - displayRow : displayRow;
        int col = blackPerspective ? 7 - displayCol : displayCol;
        return String.valueOf((char) ('a' + col)) + (8 - row);
    }

    static int[] point(String square) {
        if (square == null || !square.matches("[a-h][1-8]")) throw new IllegalArgumentException("Invalid chess square.");
        int col = square.charAt(0) - 'a';
        int row = 8 - (square.charAt(1) - '0');
        return new int[] { row, col };
    }
}
