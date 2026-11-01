package com.goalgambit.trial;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Picture;
import android.graphics.drawable.GradientDrawable;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

import com.caverock.androidsvg.SVG;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

final class ChessBoardView extends LinearLayout {
    interface SquareListener { void onSquare(String square); }

    private static final int LIGHT = Color.rgb(226, 211, 184);
    private static final int DARK = Color.rgb(119, 94, 66);
    private static final int GOLD = Color.rgb(239, 198, 55);
    private final Map<Character, Bitmap> pieceCache = new HashMap<>();
    private final int boardCellHeight;

    ChessBoardView(Context context) {
        super(context);
        setOrientation(VERTICAL);
        boardCellHeight = dp(42);
        setContentDescription("Chessboard");
    }

    void show(String fen, String playerColor, Set<String> legalDestinations,
              String selectedSquare, String lastFrom, String lastTo,
              String checkSquare, SquareListener listener) {
        ChessPosition position = new ChessPosition(fen);
        Set<String> legal = legalDestinations == null ? new HashSet<>() : legalDestinations;
        removeAllViews();
        for (int displayRow = 0; displayRow < 8; displayRow++) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(HORIZONTAL);
            row.setWeightSum(8f);
            for (int displayCol = 0; displayCol < 8; displayCol++) {
                final String square = position.squareAt(displayRow, displayCol, playerColor);
                final char piece = position.pieceAt(square);
                boolean isLight = ((square.charAt(0) - 'a') + (square.charAt(1) - '1')) % 2 == 1;
                boolean isSelected = square.equals(selectedSquare);
                boolean isLastMove = square.equals(lastFrom) || square.equals(lastTo);
                boolean isCheck = square.equals(checkSquare);
                boolean isLegal = legal.contains(square);

                FrameLayout cell = new FrameLayout(getContext());
                int squareColor = isCheck ? Color.rgb(174, 63, 50) : isLastMove ? Color.rgb(191, 160, 66) : isLight ? LIGHT : DARK;
                cell.setBackground(background(squareColor, isSelected ? GOLD : 0, isSelected ? dp(2) : 0));
                cell.setClickable(listener != null);
                cell.setFocusable(listener != null);
                cell.setContentDescription(accessibleSquare(square, piece));
                cell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
                cell.setAccessibilityDelegate(new AccessibilityDelegate() {
                    @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                        super.onInitializeAccessibilityNodeInfo(host, info);
                        info.setClassName("android.widget.Button");
                        info.setClickable(listener != null);
                    }
                });
                if (piece != '\0') {
                    ImageView image = new ImageView(getContext());
                    image.setImageBitmap(pieceBitmap(piece));
                    image.setScaleType(ImageView.ScaleType.FIT_CENTER);
                    int iconSize = dp(39);
                    FrameLayout.LayoutParams iconParams = new FrameLayout.LayoutParams(iconSize, iconSize, Gravity.CENTER);
                    cell.addView(image, iconParams);
                }
                if (isLegal) {
                    View marker = new View(getContext());
                    int dot = piece == '\0' ? dp(9) : dp(31);
                    marker.setBackground(background(piece == '\0' ? Color.argb(210, 239, 198, 55) : Color.TRANSPARENT,
                        piece == '\0' ? 0 : Color.argb(220, 239, 198, 55), dp(2)));
                    FrameLayout.LayoutParams markerParams = new FrameLayout.LayoutParams(dot, dot, Gravity.CENTER);
                    cell.addView(marker, markerParams);
                    if (piece == '\0') marker.setAlpha(0.75f);
                }
                if (listener != null) cell.setOnClickListener(view -> listener.onSquare(square));
                LinearLayout.LayoutParams cellParams = new LinearLayout.LayoutParams(0, boardCellHeight, 1f);
                row.addView(cell, cellParams);
            }
            addView(row, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, boardCellHeight));
        }
        setBackground(background(Color.rgb(13, 13, 13), GOLD, dp(1)));
        setPadding(dp(1), dp(1), dp(1), dp(1));
    }

    private Bitmap pieceBitmap(char piece) {
        Bitmap cached = pieceCache.get(piece);
        if (cached != null) return cached;
        String color = Character.isUpperCase(piece) ? "w" : "b";
        String type = String.valueOf(Character.toUpperCase(piece));
        try {
            SVG svg = SVG.getFromAsset(getContext().getAssets(), "chess-pieces/fantasy/" + color + type + ".svg");
            Picture picture = svg.renderToPicture(120, 120);
            Bitmap bitmap = Bitmap.createBitmap(120, 120, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawPicture(picture);
            pieceCache.put(piece, bitmap);
            return bitmap;
        } catch (Exception ignored) {
            Bitmap fallback = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
            pieceCache.put(piece, fallback);
            return fallback;
        }
    }

    private static GradientDrawable background(int color, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(0f);
        if (strokeWidth > 0) drawable.setStroke(strokeWidth, strokeColor);
        return drawable;
    }

    private static String accessibleSquare(String square, char piece) {
        if (piece == '\0') return square + " empty square";
        String name;
        switch (Character.toLowerCase(piece)) {
            case 'k': name = "king"; break;
            case 'q': name = "queen"; break;
            case 'r': name = "rook"; break;
            case 'b': name = "bishop"; break;
            case 'n': name = "knight"; break;
            default: name = "pawn";
        }
        return square + " " + (Character.isUpperCase(piece) ? "white " : "black ") + name;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
