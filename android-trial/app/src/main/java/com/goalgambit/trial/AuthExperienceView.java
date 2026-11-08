package com.goalgambit.trial;

import android.content.Context;
import android.graphics.Rect;
import android.opengl.Matrix;
import android.os.SystemClock;
import android.util.Log;
import android.view.Choreographer;
import android.view.TextureView;
import android.view.View;
import android.view.ViewTreeObserver;

import com.google.android.filament.Engine;
import com.google.android.filament.Filament;
import com.google.android.filament.EntityManager;
import com.google.android.filament.LightManager;
import com.google.android.filament.TransformManager;
import com.google.android.filament.android.UiHelper;
import com.google.android.filament.utils.ModelViewer;
import com.google.android.filament.utils.Utils;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/** Filament-powered, locally bundled 3D authentication scene and transitions. */
final class AuthExperienceView extends TextureView implements Choreographer.FrameCallback {
    private static final String TAG = "GGAuth3D";
    enum Mode { LOGIN, REGISTRATION, OPENING, DROP_KING, REVEAL_REGISTRATION, LOGIN_JOURNEY, LOGIN_RETURN, LOGIN_COMPLETE, REVEAL_HOME }

    private static final class Target {
        final View view;
        final String label;
        Target(View view, String label) { this.view = view; this.label = label; }
    }

    private final List<Target> targets = new ArrayList<>();
    private ModelViewer viewer;
    private View revealTarget;
    private Mode mode = Mode.LOGIN;
    private long stageStartMs;
    private long lastFrameNs;
    private float progress;
    private float journeyStartProgress;
    private float focusWorldX;
    private float focusWorldY;
    private float torchX = .67f;
    private float torchY = -1.66f;
    private float torchRotation;
    private boolean running;
    private boolean sceneReady;
    private boolean pendingRegistrationReveal;
    private Runnable transitionDone;
    private int kingEntity;
    private int torchEntity;
    private int ballEntity;
    private int logoEntity;
    private float worldHalfHeight = 2.9f;
    private float worldHalfWidth = 1.3f;

    static { Utils.init(); }

    AuthExperienceView(Context context) {
        super(context);
        setOpaque(false);
        setClickable(false);
        setFocusable(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        setAlpha(1f);
    }

    private void initializeScene(int width, int height) {
        destroyViewer();
        try {
            Filament.init();
            viewer = new ModelViewer(this, Engine.create(), new UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK), null);
            addFillLights();
            viewer.setCameraFocalLength(28f);
            viewer.setCameraNear(.05f);
            viewer.setCameraFar(80f);
            viewer.getCamera().lookAt(0.0, 0.0, 7.2, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
            updateCamera(width, height);
            byte[] glb = readAsset("models/auth_world.glb");
            ByteBuffer model = ByteBuffer.allocateDirect(glb.length);
            model.put(glb).flip();
            viewer.loadModelGlb(model);
            viewer.getView().setPostProcessingEnabled(true);
            sceneReady = true;
            cacheSceneEntities();
            Log.i(TAG, "Loaded bundled Filament GLB scene (" + glb.length + " bytes)");
            scheduleFrames();
        } catch (Throwable error) {
            sceneReady = false;
            Log.e(TAG, "Could not initialize the bundled 3D authentication scene", error);
            // Keep the native auth form usable and make the renderer issue visible in logs.
            if (transitionDone != null) {
                Runnable callback = transitionDone;
                transitionDone = null;
                post(callback);
            }
        }
    }

    private void addFillLights() {
        Engine engine=viewer.getEngine();
        addDirectional(engine,.70f,.48f,.25f,32000f,-.32f,-.22f,-1f);
        addDirectional(engine,.42f,.53f,.76f,21000f,.58f,-.08f,-1f);
    }

    private void addDirectional(Engine engine,float r,float g,float b,float lux,float dx,float dy,float dz) {
        int entity=EntityManager.get().create();
        new LightManager.Builder(LightManager.Type.DIRECTIONAL)
            .color(r,g,b).intensity(lux).direction(dx,dy,dz).castShadows(false)
            .build(engine,entity);
        viewer.getScene().addEntity(entity);
    }

    private byte[] readAsset(String path) throws Exception {
        try (InputStream input = getContext().getAssets().open(path);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private void updateCamera(int width, int height) {
        if (viewer == null || width <= 0 || height <= 0) return;
        float aspect = width / (float) height;
        worldHalfHeight = 2.9f;
        worldHalfWidth = worldHalfHeight * aspect;
        viewer.getCamera().lookAt(0.0, 0.0, 7.2, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
    }

    private void cacheSceneEntities() {
        if (viewer == null || viewer.getAsset() == null) return;
        kingEntity = viewer.getAsset().getFirstEntityByName("KingPivot");
        torchEntity = viewer.getAsset().getFirstEntityByName("FlashlightRoot");
        ballEntity = viewer.getAsset().getFirstEntityByName("MatchBallRoot");
        logoEntity = viewer.getAsset().getFirstEntityByName("Goal Gambit three-dimensional crest");
        setObject(kingEntity, 0f, 1.17f, -.10f, 0f, .58f);
        setObject(torchEntity, .67f, -1.66f, .20f, 0f, 1f);
        setObject(ballEntity, -.82f, -1.57f, .45f, 0f, 1f);
    }

    void setRevealTarget(View target) { revealTarget = target; }
    void setPendingRegistrationReveal(boolean pending) { pendingRegistrationReveal = pending; }
    boolean takePendingRegistrationReveal() {
        boolean pending=pendingRegistrationReveal;
        pendingRegistrationReveal=false;
        return pending;
    }

    void setMode(Mode next) {
        if (next == Mode.LOGIN || next == Mode.REGISTRATION) {
            mode = next;
            stageStartMs = SystemClock.uptimeMillis();
            if (next == Mode.LOGIN) {
                setObject(torchEntity, .67f, -1.66f, .20f, 0f, 1f);
                setObject(kingEntity, 0f, 1.17f, -.10f, 0f, .58f);
            } else {
                setObject(kingEntity, .92f, -.95f, .0f, 0f, .58f);
                torchX = .70f; torchY = -.74f; torchRotation = 0f;
                setObject(torchEntity, torchX, torchY, .42f, torchRotation, 1f);
            }
        }
        scheduleFrames();
    }

    void watch(View view, String label) {
        if (view == null) return;
        targets.add(new Target(view, label));
        view.setOnFocusChangeListener((focused, hasFocus) -> {
            if (hasFocus) updateFocus(focused);
        });
    }

    void clearTargets() { targets.clear(); focusWorldX = 0f; focusWorldY = 0f; }

    void focusOn(View view, String label) {
        if (view != null) updateFocus(view);
    }

    private void updateFocus(View view) {
        int[] position = new int[2];
        view.getLocationOnScreen(position);
        int[] scenePosition = new int[2];
        getLocationOnScreen(scenePosition);
        float px = position[0] - scenePosition[0] + view.getWidth() * .5f;
        float py = position[1] - scenePosition[1] + view.getHeight() * .5f;
        focusWorldX = (px / Math.max(1f, getWidth()) - .5f) * worldHalfWidth * 2f;
        focusWorldY = (.5f - py / Math.max(1f, getHeight())) * worldHalfHeight * 2f;
        scheduleFrames();
    }

    void startRegistrationJourney(Runnable revealPage) {
        mode = Mode.DROP_KING;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = revealPage;
        progress = 0f;
        scheduleFrames();
    }

    void revealRegistration() {
        mode = Mode.REVEAL_REGISTRATION;
        stageStartMs = SystemClock.uptimeMillis();
        progress = 0f;
        applyRevealClip(0f, false);
        scheduleFrames();
    }

    void startOpeningSequence(Runnable showLogin) {
        mode = Mode.OPENING;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = showLogin;
        progress = 0f;
        scheduleFrames();
    }

    void startLoginJourney() {
        mode = Mode.LOGIN_JOURNEY;
        stageStartMs = SystemClock.uptimeMillis();
        progress = 0f;
        scheduleFrames();
    }

    void returnToLogin(Runnable done) {
        mode = Mode.LOGIN_RETURN;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = done;
        journeyStartProgress=progress;
        scheduleFrames();
    }

    void completeLoginJourney(Runnable done) {
        mode = Mode.LOGIN_COMPLETE;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = done;
        journeyStartProgress=progress;
        scheduleFrames();
    }

    void revealHome(Runnable done) {
        mode = Mode.REVEAL_HOME;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = done;
        progress = 0f;
        applyRevealClip(0f, true);
        scheduleFrames();
    }

    private void scheduleFrames() {
        if (!running || viewer == null || !sceneReady || !isShown()) return;
        Choreographer.getInstance().removeFrameCallback(this);
        Choreographer.getInstance().postFrameCallback(this);
    }

    void onHostResume() { running = true; scheduleFrames(); }
    void onHostPause() { running = false; stopFrames(); }
    private void stopFrames() { Choreographer.getInstance().removeFrameCallback(this); }

    @Override public void doFrame(long frameTimeNanos) {
        if (!running || viewer == null || !sceneReady || !isShown()) return;
        long now = SystemClock.uptimeMillis();
        if (lastFrameNs != 0 && frameTimeNanos - lastFrameNs < 15_000_000L) {
            Choreographer.getInstance().postFrameCallback(this);
            return;
        }
        lastFrameNs = frameTimeNanos;
        updateScene(now);
        viewer.render(frameTimeNanos);
        Choreographer.getInstance().postFrameCallback(this);
    }

    private void updateScene(long now) {
        float t = (now - stageStartMs) / 1000f;
        float swing = (float) Math.sin(t * 2.4f) * .115f;
        switch (mode) {
            case OPENING: {
                if (t < .55f) {
                    float p = smooth(t / .55f);
                    setObject(kingEntity, 0f, 1.68f + .15f*p, -.10f, -.10f, .50f + .08f*p);
                } else if (t < 1.15f) {
                    float p = smooth((t-.55f)/.60f);
                    setObject(kingEntity, -.10f*p, 1.83f + .24f*(float)Math.sin(p*Math.PI), -.10f, -.24f*p, .58f);
                } else if (t < 1.56f) {
                    float p = (t-1.15f)/.41f;
                    setObject(kingEntity, -.10f + .18f*p, 2.0f - .57f*p, -.10f, -.24f + .78f*p, .58f);
                } else if (t < 2.0f) {
                    float p = smooth((t-1.56f)/.44f);
                    setObject(kingEntity, .08f*(1-p), 1.43f-.26f*p, -.10f, .54f*(1-p), .58f);
                } else {
                    float p = t-2f;
                    setObject(kingEntity, (float)Math.sin(p*2.4f)*.10f, 1.17f, -.10f, swing, .58f);
                }
                if (t >= 2.55f) finish(Mode.LOGIN);
                break;
            }
            case LOGIN:
                setObject(kingEntity, (float)Math.sin(t*2.4f)*.10f, 1.17f, -.10f, swing, .58f);
                setTorchAim(.67f, -1.66f, 0f);
                break;
            case DROP_KING: {
                float p = smooth(t/1.55f);
                float y = lerp(1.17f,-1.42f,p);
                float x = lerp(0f,.72f,p);
                float rz = (float)Math.sin(p*Math.PI*3)*.28f*(1-p);
                setObject(kingEntity,x,y,-.06f,rz,.58f);
                float attach = smooth((p-.68f)/.32f);
                setTorchAim(lerp(.67f,.57f,attach),lerp(-1.66f,-1.05f,attach),lerp(0f,-.20f,attach));
                if (t >= 1.58f) finish(Mode.REGISTRATION);
                break;
            }
            case REVEAL_REGISTRATION: {
                progress = smooth(t/1.7f);
                float py = lerp(2.02f,-.35f,progress);
                setObject(kingEntity,.93f,py-.18f,-.10f,0f,.58f);
                // The same flashlight is carried through the sweep. Its beam and
                // native form clip are driven by this shared progress value.
                setTorchAim(.72f,py, (float)Math.PI);
                applyRevealClip(progress,false);
                if (progress >= 1f) {
                    applyRevealClip(1f,false);
                    mode=Mode.REGISTRATION;
                    stageStartMs=now;
                    setObject(kingEntity,.93f,-.95f,-.10f,0f,.58f);
                    updateFocusedTarget();
                }
                break;
            }
            case REGISTRATION:
                updateFocusedTarget();
                setObject(kingEntity,.93f,-.95f,-.10f,(float)Math.sin(t*1.1f)*.025f,.58f);
                aimTorchAtFocus();
                break;
            case LOGIN_JOURNEY: {
                progress=smooth(t/1.55f);
                drawBallJourney(progress);
                setObject(kingEntity,0f,1.17f,-.10f,0f,.58f);
                break;
            }
            case LOGIN_RETURN:
                progress=journeyStartProgress*(1f-smooth(t/.58f));
                drawBallJourney(progress);
                if(t>=.58f)finish(Mode.LOGIN);
                break;
            case LOGIN_COMPLETE:
                progress=lerp(journeyStartProgress,1f,smooth(t/.46f));
                drawBallJourney(progress);
                if(t>=.46f)finish(Mode.LOGIN);
                break;
            case REVEAL_HOME: {
                progress=smooth(t/1.45f);
                applyRevealClip(progress,true);
                setObject(kingEntity,.93f,lerp(-.95f,1.32f,progress),-.1f,0f,.58f);
                setTorchAim(.72f,lerp(-1.8f,2.05f,progress), (float)Math.PI);
                if (progress>=1f) {
                    applyRevealClip(1f,true);
                    if (transitionDone!=null) finish(Mode.LOGIN);
                }
                break;
            }
        }
    }

    private void drawBallJourney(float p) {
        float z=lerp(.45f,-2.55f,p);
        float x=lerp(-.82f,0f,p);
        float y=lerp(-1.57f,-1.42f,p);
        float radius=1f-p*.56f;
        setObject(ballEntity,x,y,z,p*13f,radius);
    }

    private void updateFocusedTarget() {
        for (Target target : targets) if (target.view.isShown() && target.view.hasFocus()) { updateFocus(target.view); return; }
    }

    private void aimTorchAtFocus() {
        float dx=focusWorldX-torchX, dy=focusWorldY-torchY;
        float desired=(float)Math.atan2(-dx,dy);
        torchRotation += shortestAngle(torchRotation,desired)*.16f;
        setTorchAim(.72f,-.75f,torchRotation);
    }

    private void setTorchAim(float x,float y,float rotation) {
        torchX=x;torchY=y;torchRotation=rotation;
        setObject(torchEntity,x,y,.40f,rotation,1f);
    }

    private void applyRevealClip(float p,boolean fromBottom) {
        if (revealTarget==null || revealTarget.getWidth()<=0 || revealTarget.getHeight()<=0) return;
        int w=revealTarget.getWidth(),h=revealTarget.getHeight();
        int top=fromBottom?Math.round(h*(1f-p)):0;
        int bottom=fromBottom?h:Math.round(h*p);
        revealTarget.setClipBounds(new Rect(0,Math.max(0,top),w,Math.min(h,Math.max(top,bottom))));
    }

    private void finish(Mode next) {
        Mode old=mode;
        mode=next;
        stageStartMs=SystemClock.uptimeMillis();
        progress=0f;
        if ((old==Mode.REVEAL_REGISTRATION || old==Mode.REVEAL_HOME) && revealTarget!=null) revealTarget.setClipBounds(null);
        if (next==Mode.LOGIN) {
            setObject(ballEntity,-.82f,-1.57f,.45f,0f,1f);
            setObject(kingEntity,0f,1.17f,-.10f,0f,.58f);
            setTorchAim(.67f,-1.66f,0f);
        }
        Runnable callback=transitionDone;
        transitionDone=null;
        if (callback!=null) post(callback);
        Log.d(TAG,"Auth scene transition: "+old+" -> "+next);
    }

    private void setObject(int entity,float x,float y,float z,float rz,float scale) {
        if (viewer==null || entity==0) return;
        TransformManager manager=viewer.getEngine().getTransformManager();
        int instance=manager.getInstance(entity);
        if(instance==0)return;
        float[] m=new float[16];
        Matrix.setIdentityM(m,0);
        Matrix.translateM(m,0,x,y,z);
        Matrix.rotateM(m,0,(float)Math.toDegrees(rz),0f,0f,1f);
        Matrix.scaleM(m,0,scale,scale,scale);
        manager.setTransform(instance,m);
    }

    private static float smooth(float t) { t=Math.max(0f,Math.min(1f,t));return t*t*(3f-2f*t); }
    private static float lerp(float a,float b,float t) { return a+(b-a)*Math.max(0f,Math.min(1f,t)); }
    private static float shortestAngle(float a,float b) { return (float)Math.atan2(Math.sin(b-a),Math.cos(b-a)); }

    private void destroyViewer() {
        if(viewer==null)return;
        try{viewer.destroy();}catch(RuntimeException error){Log.w(TAG,"Filament cleanup",error);}
        viewer=null;sceneReady=false;kingEntity=0;torchEntity=0;ballEntity=0;logoEntity=0;
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if(viewer==null)initializeScene(Math.max(1,getWidth()),Math.max(1,getHeight()));
        if(running)scheduleFrames();
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh) { super.onSizeChanged(w,h,oldw,oldh); updateCamera(w,h); }
    @Override protected void onDetachedFromWindow() { stopFrames(); destroyViewer(); super.onDetachedFromWindow(); }
}
