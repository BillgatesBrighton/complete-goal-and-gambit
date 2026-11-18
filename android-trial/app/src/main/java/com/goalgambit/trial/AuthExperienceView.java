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
    enum Mode { LOGIN, REGISTRATION, LOGO_ILLUMINATE, KING_FALL, KING_GREETING, KING_JUMP_RELEASE, PICKUP_FLASHLIGHT, REVEAL_REGISTRATION, SETTLE_REGISTRATION, LOGIN_JOURNEY, LOGIN_RETURN, LOGIN_COMPLETE, REVEAL_HOME }

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
    private long pausedAtMs;
    private Runnable transitionDone;
    private int kingEntity;
    private int kingUpperBodyEntity;
    private int kingRightArmEntity;
    private int kingLeftArmEntity;
    private int torchEntity;
    private int flashlightSpotEntity;
    private int ballEntity;
    private int logoEntity;
    private int logoSpotEntity;
    private int warmFillLightEntity;
    private int coolFillLightEntity;
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
        warmFillLightEntity=addDirectional(engine,.70f,.48f,.25f,12000f,-.32f,-.22f,-1f);
        coolFillLightEntity=addDirectional(engine,.42f,.53f,.76f,8000f,.58f,-.08f,-1f);
    }

    private int addDirectional(Engine engine,float r,float g,float b,float lux,float dx,float dy,float dz) {
        int entity=EntityManager.get().create();
        new LightManager.Builder(LightManager.Type.DIRECTIONAL)
            .color(r,g,b).intensity(lux).direction(dx,dy,dz).castShadows(false)
            .build(engine,entity);
        viewer.getScene().addEntity(entity);
        return entity;
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
        kingUpperBodyEntity = viewer.getAsset().getFirstEntityByName("KingUpperBodyPivot");
        kingRightArmEntity = viewer.getAsset().getFirstEntityByName("KingRightArmPivot");
        kingLeftArmEntity = viewer.getAsset().getFirstEntityByName("KingLeftArmPivot");
        torchEntity = viewer.getAsset().getFirstEntityByName("FlashlightRoot");
        flashlightSpotEntity = viewer.getAsset().getFirstEntityByName("FlashlightSpotlight");
        ballEntity = viewer.getAsset().getFirstEntityByName("MatchBallRoot");
        logoEntity = viewer.getAsset().getFirstEntityByName("Goal Gambit three-dimensional crest");
        logoSpotEntity = viewer.getAsset().getFirstEntityByName("GoalLogoSpotlight");
        setObject(logoEntity,0f,2.48f,-.55f,0f,.60f);
        setObject(kingEntity, -.28f, 2.08f, -.10f, 0f, .58f);
        setArmAngle(0f);
                setObject(torchEntity, 3.4f, -1.66f, .20f, 0f, 1f);
        setObject(ballEntity, 3.4f, -1.7f, .45f, 0f, 1f);
        setBodyTurn(0f);
        setRightArmAngle(0f);
        setLeftArmAngle(0f);
        setLightIntensity(logoSpotEntity, 0f);
        setLightIntensity(warmFillLightEntity, 0f);
        setLightIntensity(coolFillLightEntity, 0f);
        setLightIntensity(flashlightSpotEntity, 1800f);
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
                setObject(kingEntity, -.24f, -1.63f, -.10f, 0f, .58f);
                setBodyTurn(0f);
                setArmAngle(0f);
                setLeftArmAngle(0f);
                setObject(ballEntity, 3.4f, -1.75f, .45f, 0f, 1f);
                setTorchAim(3.4f, -3.2f, 0f);
                setLightIntensity(flashlightSpotEntity,0f);
                setLogoSpotPosition(0f);
                setLightIntensity(logoSpotEntity, 11500f);
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
        mode = Mode.PICKUP_FLASHLIGHT;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = revealPage;
        progress = 0f;
        scheduleFrames();
    }

    void revealRegistration() {
        mode = Mode.REVEAL_REGISTRATION;
        stageStartMs = SystemClock.uptimeMillis();
        progress = 0f;
        applyBeamReveal(0f);
        scheduleFrames();
    }

    void startOpeningSequence(Runnable showLogin) {
        mode = Mode.LOGO_ILLUMINATE;
        stageStartMs = SystemClock.uptimeMillis();
        transitionDone = showLogin;
        progress = 0f;
        setObject(kingEntity, -.28f, 2.08f, -.10f, 0f, .58f);
        setBodyTurn(0f);
        setRightArmAngle(0f);
        setLeftArmAngle(0f);
        setObject(logoEntity,0f,2.48f,-.55f,0f,.60f);
        setTorchAim(3.4f, -3.2f, 0f);
        setLogoSpotPosition(-1.45f);
        setObject(ballEntity, 3.4f, -1.7f, .45f, 0f, 1f);
        setLightIntensity(logoSpotEntity, 0f);
        setLightIntensity(warmFillLightEntity, 0f);
        setLightIntensity(coolFillLightEntity, 0f);
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

    void onHostResume() {
        if (pausedAtMs != 0L) {
            stageStartMs += SystemClock.uptimeMillis() - pausedAtMs;
            pausedAtMs = 0L;
        }
        running = true;
        scheduleFrames();
    }
    void onHostPause() { running = false; pausedAtMs = SystemClock.uptimeMillis(); stopFrames(); }
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
        switch (mode) {
            case LOGO_ILLUMINATE: {
                float sweep=smooth(t/1.85f);
                setLogoSpotPosition(lerp(-1.45f,1.45f,sweep));
                setLightIntensity(logoSpotEntity, 26000f * smooth(t / .45f));
                if (t >= 1.85f) beginStage(Mode.KING_FALL, now);
                break;
            }
            case KING_FALL: {
                setLightIntensity(warmFillLightEntity, 8500f * smooth(t / .7f));
                setLightIntensity(coolFillLightEntity, 5200f * smooth(t / .7f));
                float fall = Math.min(1f, t / .92f);
                float impact = Math.max(0f, t - .92f);
                float y = 2.08f - 3.71f * fall * fall;
                float angle = 0f;
                if (impact > 0f) {
                    y = -1.63f + .13f * (float)Math.exp(-9f * impact) * (float)Math.sin(18f * impact);
                }
                setObject(kingEntity, -.20f - .10f * fall, y, -.10f, angle, .58f);
                setBodyTurn(.16f*(1f-fall));
                if (t >= 1.32f) beginStage(Mode.KING_GREETING, now);
                break;
            }
            case KING_GREETING: {
                setLightIntensity(warmFillLightEntity,12000f);
                setLightIntensity(coolFillLightEntity,8000f);
                float raise=smooth(t/.72f);
                float right=lerp(.10f,2.63f,raise);
                float waveStart=smooth((t-.72f)/.22f);
                float wave=waveStart*(.18f+.30f*(float)Math.sin((t-.72f)*11f));
                float crouch=.075f*(1f-smooth(t/.32f));
                float kingX=lerp(-.30f,-.08f,smooth(t/.55f));
                setObject(kingEntity,kingX,-1.63f-crouch,-.10f,.025f*(float)Math.sin(t*2f),.58f);
                setBodyTurn(.24f*smooth(t/.48f)+.025f*(float)Math.sin(t*1.5f));
                setRightArmAngle(right);
                setLeftArmAngle(lerp(0f,-2.35f,waveStart)+wave);
                float handX=kingX+.58f*(.20f+.415f*(float)Math.sin(right));
                float handY=-1.63f-crouch+.58f*(-.28f-.415f*(float)Math.cos(right));
                setTorchAim(handX,handY,right+(float)Math.PI);
                setLightIntensity(flashlightSpotEntity,5200f+1400f*raise);
                if(t>=3.15f) beginStage(Mode.KING_JUMP_RELEASE,now);
                break;
            }
            case KING_JUMP_RELEASE: {
                final float duration=2.35f;
                float p=Math.min(1f,t/duration);
                float jumpHeight=1.72f;
                float y=-1.63f+4f*jumpHeight*p*(1f-p);
                float turn=.24f+.12f*(float)Math.sin(p*Math.PI);
                setObject(kingEntity,lerp(-.08f,-.20f,p),y,-.10f,.11f*(float)Math.sin(p*Math.PI*2f),.58f);
                setBodyTurn(turn);
                setRightArmAngle(2.63f-.08f*p);
                setLeftArmAngle(-2.35f+.10f*(float)Math.sin(p*Math.PI));
                float releaseAt=.94f;
                if(t<releaseAt) {
                    setObject(ballEntity,3.4f,-1.7f,.45f,0f,1f);
                } else {
                    float flight=t-releaseAt;
                    float releaseScale=smooth(flight/.16f);
                    float startY=-1.63f+4f*jumpHeight*(releaseAt/duration)*(1f-releaseAt/duration)+.25f;
                    float x=-.20f+.39f-.48f*flight;
                    float ballY=startY+.90f*flight-1.65f*flight*flight;
                    float z=.58f+1.38f*flight;
                    float zoom=1f+Math.min(1.45f,flight*1.15f);
                    setObject(ballEntity,x,ballY,z,flight*8.8f,releaseScale*zoom);
                }
                if(t>=duration) finish(Mode.LOGIN);
                break;
            }
            case LOGIN:
                setObject(kingEntity, -.24f + (float)Math.sin(t*1.6f)*.025f, -1.63f, -.10f, (float)Math.sin(t*1.6f)*.015f, .58f);
                setBodyTurn(.025f*(float)Math.sin(t*1.1f));
                setTorchAim(3.4f, -3.2f, 0f);
                break;
            case PICKUP_FLASHLIGHT: {
                float p = smooth(t / 1.5f);
                float kingX = lerp(-.24f, 0f, p);
                float kingY = lerp(-1.63f, 2.30f, p);
                float kingAngle = 0f;
                float arm = smooth((p - .18f) / .62f) * 1.20f;
                setObject(kingEntity, kingX, kingY, -.10f, kingAngle, .58f);
                setRightArmAngle(arm);
                setLeftArmAngle(0f);
                float handX = kingX + .23f + .53f * (float)Math.sin(arm);
                float handY = kingY - .30f - .53f * (float)Math.cos(arm);
                float torchY = lerp(-1.66f, handY, p);
                setTorchAim(lerp(.67f, handX, p), torchY, lerp(0f, (float)Math.PI, p));
                setLightIntensity(flashlightSpotEntity, 3200f + 2400f * p);
                if (t >= 1.52f) {
                    setRightArmAngle(1.20f);
                    beginStage(Mode.REVEAL_REGISTRATION, now);
                    if (transitionDone != null) {
                        Runnable callback = transitionDone;
                        transitionDone = null;
                        post(callback);
                    }
                }
                break;
            }
            case REVEAL_REGISTRATION: {
                progress = smooth(t/2.6f);
                float py = lerp(2.0f,-2.65f,progress);
                setObject(kingEntity,0f,py+.49f,-.10f,0f,.58f);
                setRightArmAngle(1.20f);
                setLeftArmAngle(0f);
                setTorchAim(.72f,py,(float)Math.PI);
                setLightIntensity(flashlightSpotEntity,5600f);
                applyBeamReveal(progress);
                if (progress >= 1f) {
                    applyBeamReveal(1f);
                    if (revealTarget instanceof AuthRevealLayout) ((AuthRevealLayout) revealTarget).clearBeamReveal();
                    mode=Mode.SETTLE_REGISTRATION;
                    stageStartMs=now;
                }
                break;
            }
            case SETTLE_REGISTRATION: {
                float p=smooth(t/.52f);
                setObject(kingEntity,0f,lerp(-2.16f,-.70f,p),-.10f,0f,.58f);
                setRightArmAngle(1.20f);
                setLeftArmAngle(0f);
                setTorchAim(.72f,lerp(-2.65f,-1.18f,p),(float)Math.PI);
                if(t>=.52f) {
                    finish(Mode.REGISTRATION);
                    updateFocusedTarget();
                }
                break;
            }
            case REGISTRATION:
                updateFocusedTarget();
                setObject(kingEntity,0f,-.70f,-.10f,0f,.58f);
                setBodyTurn(.025f*(float)Math.sin(t*1.1f));
                aimTorchAtFocus();
                break;
            case LOGIN_JOURNEY: {
                progress=smooth(t/1.55f);
                drawBallJourney(progress);
                setObject(kingEntity,-.24f,-1.63f,-.10f,0f,.58f);
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
        float x=lerp(.42f,0f,p);
        float y=lerp(-1.75f,-1.42f,p);
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
        setTorchAim(.72f,-1.18f,torchRotation);
    }

    private void setTorchAim(float x,float y,float rotation) {
        torchX=x;torchY=y;torchRotation=rotation;
        setObject(torchEntity,x,y,.48f,rotation,.80f);
    }

    private void setArmAngle(float angle) {
        if (viewer==null || kingRightArmEntity==0) return;
        setArmAngle(kingRightArmEntity,.20f,angle);
    }

    private void setRightArmAngle(float angle) { setArmAngle(angle); }

    private void setLeftArmAngle(float angle) {
        setArmAngle(kingLeftArmEntity,-.20f,angle);
    }

    private void setArmAngle(int entity,float shoulderX,float angle) {
        if (viewer==null || entity==0) return;
        TransformManager manager=viewer.getEngine().getTransformManager();
        int instance=manager.getInstance(entity);
        if(instance==0)return;
        float[] m=new float[16];
        Matrix.setIdentityM(m,0);
        Matrix.translateM(m,0,shoulderX,-.28f,.035f);
        Matrix.rotateM(m,0,(float)Math.toDegrees(angle),0f,0f,1f);
        manager.setTransform(instance,m);
    }

    private void setBodyTurn(float yaw) {
        if(viewer==null||kingUpperBodyEntity==0)return;
        TransformManager manager=viewer.getEngine().getTransformManager();
        int instance=manager.getInstance(kingUpperBodyEntity);
        if(instance==0)return;
        float[] m=new float[16];
        Matrix.setIdentityM(m,0);
        Matrix.rotateM(m,0,(float)Math.toDegrees(yaw),0f,1f,0f);
        manager.setTransform(instance,m);
    }

    private void setLogoSpotPosition(float x) {
        if(viewer==null||logoSpotEntity==0)return;
        TransformManager manager=viewer.getEngine().getTransformManager();
        int instance=manager.getInstance(logoSpotEntity);
        if(instance==0)return;
        float[] m=new float[16];
        Matrix.setIdentityM(m,0);
        Matrix.translateM(m,0,x,2.98f,1.75f);
        Matrix.rotateM(m,0,-24.8f,1f,0f,0f);
        manager.setTransform(instance,m);
    }

    private void setLightIntensity(int entity,float intensity) {
        if (viewer==null || entity==0) return;
        LightManager lights=viewer.getEngine().getLightManager();
        int instance=lights.getInstance(entity);
        if(instance!=0) lights.setIntensity(instance,Math.max(0f,intensity));
    }

    private void beginStage(Mode next,long now) {
        Mode previous=mode;
        mode=next;
        stageStartMs=now;
        progress=0f;
        Log.d(TAG,"Auth scene transition: "+previous+" -> "+next);
    }

    private void applyRevealClip(float p,boolean fromBottom) {
        if (revealTarget==null || revealTarget.getWidth()<=0 || revealTarget.getHeight()<=0) return;
        int w=revealTarget.getWidth(),h=revealTarget.getHeight();
        int top=fromBottom?Math.round(h*(1f-p)):0;
        int bottom=fromBottom?h:Math.round(h*p);
        revealTarget.setClipBounds(new Rect(0,Math.max(0,top),w,Math.min(h,Math.max(top,bottom))));
    }

    private void applyBeamReveal(float p) {
        if (revealTarget instanceof AuthRevealLayout) {
            ((AuthRevealLayout) revealTarget).revealAlongBeam(p);
        } else {
            applyRevealClip(p, false);
        }
    }

    private void finish(Mode next) {
        Mode old=mode;
        mode=next;
        stageStartMs=SystemClock.uptimeMillis();
        progress=0f;
        if ((old==Mode.REVEAL_REGISTRATION || old==Mode.REVEAL_HOME) && revealTarget!=null) revealTarget.setClipBounds(null);
        if (next==Mode.LOGIN) {
            setObject(ballEntity,.42f,-1.75f,.05f,0f,.72f);
            setObject(kingEntity,-.24f,-1.63f,-.10f,0f,.58f);
            setBodyTurn(0f);
            setArmAngle(0f);
            setLeftArmAngle(0f);
            setTorchAim(3.4f,-3.2f,0f);
            setLightIntensity(flashlightSpotEntity,0f);
            setLogoSpotPosition(0f);
            setLightIntensity(logoSpotEntity,11500f);
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
        viewer=null;sceneReady=false;kingEntity=0;kingUpperBodyEntity=0;kingRightArmEntity=0;kingLeftArmEntity=0;torchEntity=0;flashlightSpotEntity=0;ballEntity=0;logoEntity=0;logoSpotEntity=0;warmFillLightEntity=0;coolFillLightEntity=0;
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if(viewer==null)initializeScene(Math.max(1,getWidth()),Math.max(1,getHeight()));
        if(running)scheduleFrames();
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh) { super.onSizeChanged(w,h,oldw,oldh); updateCamera(w,h); }
    @Override protected void onDetachedFromWindow() { stopFrames(); destroyViewer(); super.onDetachedFromWindow(); }
}
