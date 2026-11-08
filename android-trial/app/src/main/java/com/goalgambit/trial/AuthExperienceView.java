package com.goalgambit.trial;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;

import java.util.ArrayList;
import java.util.List;

/** Lightweight, bundled Canvas artwork and transitions for player authentication. */
final class AuthExperienceView extends View {
    enum Mode { LOGIN, REGISTRATION, DROP_KING, REVEAL_REGISTRATION, LOGIN_JOURNEY, REVEAL_HOME }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
    private final Paint clearPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Bitmap logo;
    private final List<Target> targets = new ArrayList<>();
    private Mode mode = Mode.LOGIN;
    private long modeStarted = SystemClock.uptimeMillis();
    private float journeyProgress;
    private float revealProgress;
    private boolean pendingRegistrationReveal;
    private boolean reducedMotion;
    private float targetX;
    private float targetY;
    private float desiredTargetX;
    private float desiredTargetY;
    private String targetLabel = "Username";
    private Runnable transitionComplete;
    private ValueAnimator activeAnimator;

    private static final class Target {
        final View view;
        final String label;
        Target(View view, String label) { this.view = view; this.label = label; }
    }

    AuthExperienceView(Context context) {
        super(context);
        setLayerType(View.LAYER_TYPE_HARDWARE, null);
        setClickable(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        try {
            logo = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        } catch (RuntimeException ignored) {
            throw new IllegalStateException("The GOAL$GAMBIT Player App logo could not be loaded.");
        }
        try {
            reducedMotion = android.provider.Settings.Global.getFloat(
                context.getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
        } catch (RuntimeException ignored) { reducedMotion = false; }
        clearPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
    }

    void setMode(Mode next) {
        if (next == Mode.LOGIN || next == Mode.REGISTRATION) {
            mode = next;
            modeStarted = SystemClock.uptimeMillis();
            journeyProgress = 0f;
        }
        invalidate();
    }

    void watch(View view, String label) {
        if (view == null) return;
        targets.add(new Target(view, label));
        view.setOnFocusChangeListener((focused, hasFocus) -> {
            if (hasFocus) {
                targetLabel = label;
                updateTarget(focused);
                invalidate();
            }
        });
    }

    void clearTargets() { targets.clear(); targetX = 0; targetY = 0; desiredTargetX = 0; desiredTargetY = 0; targetLabel = "Username"; }

    void focusOn(View view, String label) {
        if (view == null) return;
        targetLabel = label;
        updateTarget(view);
        invalidate();
    }

    void setPendingRegistrationReveal(boolean pending) { pendingRegistrationReveal = pending; }
    boolean takePendingRegistrationReveal() {
        boolean pending = pendingRegistrationReveal;
        pendingRegistrationReveal = false;
        return pending;
    }

    void startRegistrationJourney(Runnable revealPage) {
        mode = Mode.DROP_KING;
        modeStarted = SystemClock.uptimeMillis();
        invalidate();
        animateFloat(0f, 1f, reducedMotion ? 1 : 1150, value -> {
            journeyProgress = value;
            invalidate();
        }, () -> { if (revealPage != null) revealPage.run(); });
    }

    void revealRegistration() {
        mode = Mode.REVEAL_REGISTRATION;
        revealProgress = 0f;
        invalidate();
        animateFloat(0f, 1f, reducedMotion ? 1 : 1250, value -> {
            revealProgress = value;
            invalidate();
        }, () -> {
            mode = Mode.REGISTRATION;
            modeStarted = SystemClock.uptimeMillis();
            for (Target target : targets) {
                if (target.view.isShown() && target.view.isFocusable()) {
                    target.view.requestFocus();
                    targetLabel = target.label;
                    updateTarget(target.view);
                    break;
                }
            }
            invalidate();
        });
    }

    void startLoginJourney() {
        mode = Mode.LOGIN_JOURNEY;
        journeyProgress = 0f;
        invalidate();
        animateFloat(0f, 0.86f, reducedMotion ? 1 : 1500, value -> {
            journeyProgress = value;
            invalidate();
        }, null);
    }

    void returnToLogin(Runnable done) {
        animateFloat(journeyProgress, 0f, reducedMotion ? 1 : 480, value -> {
            journeyProgress = value;
            invalidate();
        }, () -> {
            mode = Mode.LOGIN;
            modeStarted = SystemClock.uptimeMillis();
            invalidate();
            if (done != null) done.run();
        });
    }

    void completeLoginJourney(Runnable done) {
        animateFloat(journeyProgress, 1f, reducedMotion ? 1 : 420, value -> {
            journeyProgress = value;
            invalidate();
        }, () -> { if (done != null) done.run(); });
    }

    void revealHome() {
        mode = Mode.REVEAL_HOME;
        revealProgress = 0f;
        invalidate();
        animateFloat(0f, 1f, reducedMotion ? 1 : 1150, value -> {
            revealProgress = value;
            invalidate();
        }, () -> setVisibility(GONE));
    }

    private interface FloatUpdate { void update(float value); }
    private void animateFloat(float from, float to, long duration, FloatUpdate update, Runnable end) {
        if (activeAnimator != null) activeAnimator.cancel();
        ValueAnimator animator = ValueAnimator.ofFloat(from, to);
        activeAnimator = animator;
        animator.setDuration(duration);
        animator.setInterpolator(new AccelerateDecelerateInterpolator());
        animator.addUpdateListener(value -> update.update((Float) value.getAnimatedValue()));
        if (end != null) animator.addListener(new AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(Animator animation) { end.run(); }
        });
        animator.start();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth(), h = getHeight();
        if (w <= 0 || h <= 0) return;
        if (mode == Mode.REVEAL_REGISTRATION || mode == Mode.REVEAL_HOME) {
            drawReveal(canvas, w, h, mode == Mode.REVEAL_HOME);
            return;
        }
        if (mode == Mode.LOGIN_JOURNEY) {
            drawArenaJourney(canvas, w, h, journeyProgress);
            return;
        }

        drawAtmosphere(canvas, w, h);
        drawLogoAndBrand(canvas, w, h);
        if (mode == Mode.DROP_KING) drawKingDrop(canvas, w, h, journeyProgress);
        else if (mode == Mode.REGISTRATION) drawFieldGuide(canvas, w, h);
        else drawOpeningKing(canvas, w, h);
        if (mode == Mode.LOGIN) drawFlashlight(canvas, w * .82f, h - dp(43), -0.2f);
        if (mode == Mode.LOGIN || mode == Mode.REGISTRATION) postInvalidateDelayed(reducedMotion ? 220 : 34);
    }

    private void drawAtmosphere(Canvas canvas, float w, float h) {
        paint.setShader(new LinearGradient(0, 0, 0, h * .48f,
            new int[] { 0xff17130a, 0x99080503, 0x00000000 }, null, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, w, h * .48f, paint);
        paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        paint.setColor(0x443e3214);
        canvas.drawOval(new RectF(w * .12f, h * .08f, w * .88f, h * .38f), paint);
        paint.setStyle(Paint.Style.FILL);
    }

    private void drawLogoAndBrand(Canvas canvas, float w, float h) {
        float size = Math.min(dp(106), w * .29f);
        float cx = w * .5f, cy = Math.max(size * .7f, h * .105f);
        paint.setShader(new RadialGradient(cx, cy, size * .85f,
            new int[] { 0x66d8a62f, 0x22c69325, 0x00000000 }, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, size * .85f, paint);
        paint.setShader(null);
        RectF dst = new RectF(cx - size / 2f, cy - size / 2f, cx + size / 2f, cy + size / 2f);
        paint.setAlpha(244);
        canvas.drawBitmap(logo, null, dst, paint);
        paint.setAlpha(255);
        canvas.save();
        canvas.clipRect(dst);
        float shine = (SystemClock.uptimeMillis() % 2800L) / 2800f;
        float x = dst.left - size * .55f + shine * size * 2.1f;
        paint.setShader(new LinearGradient(x - size * .18f, dst.bottom,
            x + size * .18f, dst.top, new int[] { 0x00fff2b0, 0x55fff2b0, 0x00fff2b0 }, null, Shader.TileMode.CLAMP));
        canvas.drawRect(dst, paint);
        paint.setShader(null);
        canvas.restore();
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD));
        paint.setTextSize(dp(21));
        paint.setColor(0xffffd759);
        canvas.drawText("GOAL$GAMBIT", cx, dst.bottom + dp(27), paint);
        paint.setTextSize(dp(9));
        paint.setLetterSpacing(0f);
        paint.setColor(0xffc9b86f);
        canvas.drawText("COMPETE  ·  PLAY  ·  WIN", cx, dst.bottom + dp(44), paint);
        paint.setTextAlign(Paint.Align.LEFT);
    }

    private void drawOpeningKing(Canvas canvas, float w, float h) {
        long elapsed = SystemClock.uptimeMillis() - modeStarted;
        float x = w * .52f;
        float y = h * .24f;
        float swing = reducedMotion ? 0f : (float) Math.sin((elapsed / 1000f) * 2.35f) * 0.15f;
        if (elapsed < 1850 && !reducedMotion) {
            float p = Math.min(1f, elapsed / 1850f);
            float arc = (float) Math.sin(p * Math.PI) * dp(32);
            y -= arc;
            swing += (float) Math.sin(p * 12f) * .16f;
        }
        drawHangingKing(canvas, x, y, swing, 1f);
    }

    private void drawKingDrop(Canvas canvas, float w, float h, float p) {
        float x = w * .52f;
        float topY = h * .24f;
        float landingY = h - dp(145);
        float y = topY + (landingY - topY) * p;
        float rotation = (float) Math.sin(p * Math.PI * 2f) * .55f;
        drawKing(canvas, x, y, rotation, 1f - Math.max(0, p - .82f) * 4f, false);
        float attach = Math.max(0f, Math.min(1f, (p - .58f) / .28f));
        float torchX = w * .82f + (x + dp(28) - w * .82f) * attach;
        float torchY = h - dp(43) + (landingY + dp(30) - (h - dp(43))) * attach;
        drawFlashlight(canvas, torchX, torchY, -.4f * attach);
    }

    private void drawHangingKing(Canvas canvas, float x, float y, float rotation, float alpha) {
        drawKing(canvas, x, y, rotation, alpha, true);
    }

    private void drawKing(Canvas canvas, float x, float y, float rotation, float alpha, boolean string) {
        canvas.save();
        canvas.rotate((float) Math.toDegrees(rotation), x, y);
        int a = Math.max(0, Math.min(255, (int) (255 * alpha)));
        paint.setColor(Color.argb(a, 236, 196, 89));
        paint.setStrokeWidth(dp(1.5f));
        paint.setStyle(Paint.Style.STROKE);
        if (string) canvas.drawLine(x, y - dp(84), x, y - dp(34), paint);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(x - dp(24), y - dp(25), x + dp(25), y + dp(54),
            new int[] { Color.argb(a, 255, 225, 137), Color.argb(a, 180, 118, 34), Color.argb(a, 88, 55, 24) }, null, Shader.TileMode.CLAMP));
        Path body = new Path();
        body.moveTo(x - dp(18), y - dp(7));
        body.quadTo(x, y - dp(22), x + dp(18), y - dp(7));
        body.lineTo(x + dp(23), y + dp(39));
        body.quadTo(x, y + dp(51), x - dp(23), y + dp(39));
        body.close();
        canvas.drawPath(body, paint);
        paint.setShader(null);
        paint.setColor(Color.argb(a, 226, 173, 61));
        canvas.drawRoundRect(new RectF(x - dp(30), y + dp(36), x + dp(30), y + dp(48)), dp(5), dp(5), paint);
        Path crown = new Path();
        crown.moveTo(x - dp(22), y - dp(31));
        crown.lineTo(x - dp(17), y - dp(50));
        crown.lineTo(x - dp(7), y - dp(40));
        crown.lineTo(x, y - dp(57));
        crown.lineTo(x + dp(7), y - dp(40));
        crown.lineTo(x + dp(17), y - dp(50));
        crown.lineTo(x + dp(22), y - dp(31));
        crown.close();
        paint.setShader(new LinearGradient(x, y - dp(56), x, y - dp(28),
            new int[] { Color.argb(a, 255, 231, 139), Color.argb(a, 171, 105, 27) }, null, Shader.TileMode.CLAMP));
        canvas.drawPath(crown, paint);
        paint.setShader(null);
        paint.setColor(Color.argb(a, 52, 33, 13));
        canvas.drawCircle(x - dp(7), y - dp(18), dp(2), paint);
        canvas.drawCircle(x + dp(7), y - dp(18), dp(2), paint);
        paint.setColor(Color.argb(a, 255, 226, 127));
        canvas.drawCircle(x, y - dp(36), dp(2.5f), paint);
        canvas.restore();
    }

    private void drawFlashlight(Canvas canvas, float x, float y, float rotation) {
        canvas.save();
        canvas.rotate((float) Math.toDegrees(rotation), x, y);
        paint.setShader(new RadialGradient(x, y - dp(29), dp(105),
            new int[] { 0x55ffe998, 0x20ffe998, 0x00ffe998 }, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(x, y - dp(29), dp(105), paint);
        paint.setShader(null);
        Path beam = new Path();
        beam.moveTo(x - dp(10), y - dp(30));
        beam.lineTo(x - dp(94), y - dp(170));
        beam.lineTo(x + dp(82), y - dp(170));
        beam.lineTo(x + dp(10), y - dp(30));
        beam.close();
        paint.setShader(new LinearGradient(x, y - dp(36), x, y - dp(170),
            new int[] { 0x44ffe9a0, 0x14ffe9a0, 0x00ffe9a0 }, null, Shader.TileMode.CLAMP));
        canvas.drawPath(beam, paint);
        paint.setShader(null);
        paint.setShader(new LinearGradient(x - dp(28), y - dp(11), x + dp(27), y + dp(10),
            new int[] { 0xff353a42, 0xffb7bdc4, 0xff292d33 }, null, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(new RectF(x - dp(28), y - dp(9), x + dp(24), y + dp(9)), dp(8), dp(8), paint);
        paint.setShader(null);
        paint.setColor(0xff24282d);
        canvas.drawRoundRect(new RectF(x + dp(16), y - dp(14), x + dp(31), y + dp(14)), dp(5), dp(5), paint);
        paint.setShader(new RadialGradient(x + dp(30), y, dp(13),
            new int[] { 0xffffffff, 0xffffe7a0, 0xffd2a944 }, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(x + dp(29), y, dp(8), paint);
        paint.setShader(null);
        canvas.restore();
    }

    private void drawFieldGuide(Canvas canvas, float w, float h) {
        View focused = findFocused();
        if (focused != null) updateTarget(focused);
        if (targetX <= 0) { targetX = w * .47f; targetY = h * .53f; desiredTargetX = targetX; desiredTargetY = targetY; }
        targetX += (desiredTargetX - targetX) * (reducedMotion ? 1f : .24f);
        targetY += (desiredTargetY - targetY) * (reducedMotion ? 1f : .24f);
        float tx = targetX;
        float ty = targetY;
        float kingX = w - dp(48), kingY = Math.min(h - dp(145), ty + dp(90));
        int layer = canvas.saveLayer(0, 0, w, h, null);
        canvas.drawColor(0x66000000);
        canvas.drawRoundRect(new RectF(tx - dp(51), ty - dp(36), tx + dp(51), ty + dp(36)), dp(12), dp(12), clearPaint);
        canvas.restoreToCount(layer);
        drawKing(canvas, kingX, kingY, reducedMotion ? 0 : (float) Math.sin(SystemClock.uptimeMillis() / 850f) * .035f, .92f, false);
        drawFlashlight(canvas, kingX - dp(18), kingY + dp(45), (float) Math.atan2(ty - kingY, tx - kingX));
        paint.setColor(0x66ffe995);
        paint.setStrokeWidth(dp(1.3f));
        canvas.drawLine(kingX - dp(20), kingY + dp(40), tx, ty, paint);
        paint.setColor(0x99ffe9a0);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        canvas.drawRoundRect(new RectF(tx - dp(42), ty - dp(27), tx + dp(42), ty + dp(27)), dp(12), dp(12), paint);
        paint.setStyle(Paint.Style.FILL);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(dp(9));
        paint.setColor(0xffffdd76);
        canvas.drawText(targetLabel.toUpperCase(), tx, ty - dp(34), paint);
        paint.setTextAlign(Paint.Align.LEFT);
        postInvalidateDelayed(reducedMotion ? 220 : 40);
    }

    private View findFocused() {
        for (Target target : targets) if (target.view.hasFocus()) return target.view;
        return null;
    }

    private void updateTarget(View target) {
        int[] p = new int[2];
        target.getLocationOnScreen(p);
        int[] own = new int[2];
        getLocationOnScreen(own);
        desiredTargetX = p[0] - own[0] + target.getWidth() * .5f;
        desiredTargetY = p[1] - own[1] + target.getHeight() * .5f;
        if (targetX <= 0) { targetX = desiredTargetX; targetY = desiredTargetY; }
    }

    private void drawReveal(Canvas canvas, float w, float h, boolean upward) {
        int save = canvas.saveLayer(0, 0, w, h, null);
        canvas.drawColor(0xff030303);
        float edge = upward ? h * (1f - revealProgress) : h * revealProgress;
        if (upward) canvas.drawRect(0, edge, w, h, clearPaint);
        else canvas.drawRect(0, 0, w, edge, clearPaint);
        float x = w * (upward ? .25f : .74f);
        drawSpotlight(canvas, x, edge, upward);
        canvas.restoreToCount(save);
        drawHangingKing(canvas, x, edge - (upward ? dp(43) : -dp(43)), 0, 1f);
        drawFlashlight(canvas, x + dp(23), edge, upward ? -1.05f : 1.05f);
    }

    private void drawSpotlight(Canvas canvas, float x, float y, boolean upward) {
        float radius = dp(75);
        paint.setShader(new RadialGradient(x, y, radius,
            new int[] { 0x00ffffff, 0x44ffe69a, 0x00ffffff }, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(x, y, radius, paint);
        paint.setShader(null);
        paint.setColor(0x77ffe9aa);
        paint.setStrokeWidth(dp(2));
        canvas.drawLine(x, y, x, y + (upward ? dp(90) : -dp(90)), paint);
    }

    private void drawArenaJourney(Canvas canvas, float w, float h, float progress) {
        canvas.drawColor(0xff050505);
        paint.setShader(new RadialGradient(w * .5f, h * .53f, w * .8f,
            new int[] { 0xff1c1608, 0xff090806, 0xff020202 }, null, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, w, h, paint);
        paint.setShader(null);
        Path tunnel = new Path();
        tunnel.moveTo(w * .12f, h * .82f);
        tunnel.lineTo(w * .36f, h * .28f);
        tunnel.quadTo(w * .5f, h * .12f, w * .64f, h * .28f);
        tunnel.lineTo(w * .88f, h * .82f);
        tunnel.close();
        paint.setColor(0xff0d0c09);
        canvas.drawPath(tunnel, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2));
        paint.setShader(new LinearGradient(w * .12f, h * .82f, w * .5f, h * .28f,
            new int[] { 0x00d4a630, 0xfff2c757 }, null, Shader.TileMode.CLAMP));
        canvas.drawLine(w * .12f, h * .82f, w * .36f, h * .28f, paint);
        canvas.drawLine(w * .88f, h * .82f, w * .64f, h * .28f, paint);
        paint.setShader(null);
        paint.setStyle(Paint.Style.FILL);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(dp(18));
        paint.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD));
        paint.setColor(0xffffd75e);
        canvas.drawText("THE ARENA", w * .5f, h * .43f, paint);
        paint.setTextSize(dp(10));
        paint.setColor(0xffc6b477);
        canvas.drawText("GOAL$GAMBIT", w * .5f, h * .48f, paint);
        float x = w * (.5f + .27f * (1f - progress));
        float y = h * (.78f - .34f * progress);
        float r = dp(17) * (1f - progress * .7f);
        paint.setShader(new RadialGradient(x - r * .25f, y - r * .3f, r * 1.3f,
            new int[] { 0xffffffff, 0xffd7ae50, 0xff292725 }, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(x, y, r, paint);
        paint.setShader(null);
        paint.setColor(0x66f5c94f);
        paint.setStrokeWidth(dp(2));
        canvas.drawLine(x - r, y + r * .9f, x - r - dp(70) * (1f - progress), y + r * 1.4f, paint);
        if (progress > .65f) {
            paint.setColor(Color.argb((int) (170 * ((progress - .65f) / .35f)), 255, 221, 116));
            canvas.drawCircle(w * .5f, h * .55f, dp(8) * (1f - progress), paint);
        }
        paint.setTextAlign(Paint.Align.LEFT);
    }

    private float dp(float value) { return value * getResources().getDisplayMetrics().density; }
}
