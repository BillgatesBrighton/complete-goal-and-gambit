package com.goalgambit.trial;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.widget.LinearLayout;

/** Clips native auth content to the swept cone of the 3D flashlight. */
final class AuthRevealLayout extends LinearLayout {
    private final Path illuminatedArea = new Path();
    private final Paint beamPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean beamRevealActive;
    private float beamProgress;

    AuthRevealLayout(Context context) { super(context); }
    AuthRevealLayout(Context context, AttributeSet attrs) { super(context, attrs); }

    void revealAlongBeam(float progress) {
        beamRevealActive = true;
        beamProgress = Math.max(0f, Math.min(1f, progress));
        invalidate();
    }

    void clearBeamReveal() {
        beamRevealActive = false;
        beamProgress = 1f;
        invalidate();
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (beamRevealActive) return true;
        return super.dispatchTouchEvent(event);
    }

    @Override protected void dispatchDraw(Canvas canvas) {
        if (!beamRevealActive || getWidth() <= 0 || getHeight() <= 0) {
            super.dispatchDraw(canvas);
            return;
        }

        final float width = getWidth();
        final float height = getHeight();
        final float front = height * beamProgress;
        final float sourceX = width * .76f;
        final float startHalfWidth = Math.max(2f, width * .012f);
        final float frontHalfWidth = Math.max(startHalfWidth, width * (.035f + .49f * beamProgress));

        illuminatedArea.reset();
        illuminatedArea.moveTo(sourceX - startHalfWidth, 0f);
        illuminatedArea.lineTo(sourceX + startHalfWidth, 0f);
        illuminatedArea.lineTo(Math.min(width, sourceX + frontHalfWidth), front);
        illuminatedArea.lineTo(Math.max(0f, sourceX - frontHalfWidth), front);
        illuminatedArea.close();

        int clip = canvas.save();
        canvas.clipPath(illuminatedArea);
        super.dispatchDraw(canvas);
        canvas.restoreToCount(clip);

        if (beamProgress > 0f && beamProgress < 1f) {
            float band = Math.max(18f, getResources().getDisplayMetrics().density * 24f);
            float left = Math.max(0f, sourceX - frontHalfWidth);
            float right = Math.min(width, sourceX + frontHalfWidth);
            beamPaint.setShader(new LinearGradient(0f, front - band, 0f, front + band,
                new int[] { 0x00F2B923, 0xB8F6CF61, 0xFFF8E39B, 0xB8F6CF61, 0x00F2B923 },
                new float[] { 0f, .34f, .5f, .66f, 1f }, Shader.TileMode.CLAMP));
            canvas.drawRect(left, front - band, right, front + band, beamPaint);
            beamPaint.setShader(null);
        }
    }
}
