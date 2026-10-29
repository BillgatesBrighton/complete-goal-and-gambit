package com.goalgambit.companion;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.SoundPool;

import java.util.EnumMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** Small local-only sound player. It is called only for server-verified events. */
final class ChessSoundPlayer {
    static final String PREFERENCES = "companion_local_settings";
    static final String ENABLED_KEY = "chess_sounds_enabled";
    private final Context appContext;
    private final SoundPool soundPool;
    private final EnumMap<ChessSoundType, Integer> sounds = new EnumMap<>(ChessSoundType.class);
    private final Set<Integer> loaded = new LinkedHashSet<>();
    private final LinkedHashSet<String> playedEvents = new LinkedHashSet<>();
    private final Set<Long> checkmateMatches = new LinkedHashSet<>();
    private boolean released;

    ChessSoundPlayer(Context context) {
        appContext = context.getApplicationContext();
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_GAME)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        soundPool = new SoundPool.Builder().setMaxStreams(3).setAudioAttributes(attributes).build();
        soundPool.setOnLoadCompleteListener((pool, soundId, status) -> {
            synchronized (ChessSoundPlayer.this) {
                if (!released && status == 0) loaded.add(soundId);
            }
        });
        load(ChessSoundType.MOVE, R.raw.chess_move);
        load(ChessSoundType.CAPTURE, R.raw.chess_capture);
        load(ChessSoundType.CHECK, R.raw.chess_check);
        load(ChessSoundType.CHECKMATE, R.raw.chess_checkmate);
        load(ChessSoundType.CASTLE, R.raw.chess_castle);
        load(ChessSoundType.GAME_START, R.raw.chess_game_start);
        load(ChessSoundType.GAME_OVER, R.raw.chess_game_over);
        load(ChessSoundType.MATCH_FOUND, R.raw.chess_match_found);
        load(ChessSoundType.CHALLENGE, R.raw.chess_challenge);
        load(ChessSoundType.CHALLENGE_ACCEPTED, R.raw.chess_challenge_accepted);
        load(ChessSoundType.REMINDER, R.raw.chess_reminder);
    }

    private void load(ChessSoundType type, int resourceId) {
        sounds.put(type, soundPool.load(appContext, resourceId, 1));
    }

    synchronized void playVerifiedMove(long matchId, int ply, String flags, boolean captured,
                                       boolean check, boolean checkmate) {
        if (matchId <= 0 || ply <= 0) return;
        ChessSoundType type = ChessSoundType.forMove(flags, captured, check, checkmate);
        if (checkmate) checkmateMatches.add(matchId);
        playOnce(type, "move:" + matchId + ":" + ply);
    }

    synchronized void playNotification(String eventKey) {
        ChessSoundType type = ChessSoundType.forNotification(eventKey);
        if (type == null) return;
        String key = String.valueOf(eventKey).toLowerCase(Locale.ROOT);
        if (type == ChessSoundType.GAME_OVER) {
            long matchId = parseFinishedMatchId(key);
            if (matchId > 0 && checkmateMatches.contains(matchId)) {
                remember("push:" + key);
                return;
            }
        }
        playOnce(type, "push:" + key);
    }

    private void playOnce(ChessSoundType type, String eventKey) {
        if (released || type == null || !enabled() || !remember(eventKey)) return;
        Integer soundId = sounds.get(type);
        if (soundId != null && loaded.contains(soundId)) soundPool.play(soundId, 0.82f, 0.82f, 1, 0, 1.0f);
    }

    private boolean remember(String eventKey) {
        if (!playedEvents.add(eventKey)) return false;
        while (playedEvents.size() > 128) playedEvents.remove(playedEvents.iterator().next());
        while (checkmateMatches.size() > 32) checkmateMatches.remove(checkmateMatches.iterator().next());
        return true;
    }

    private boolean enabled() {
        return appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(ENABLED_KEY, true);
    }

    private static long parseFinishedMatchId(String key) {
        String[] parts = key.split(":");
        if (parts.length != 4 || !"chess-match".equals(parts[0]) || !"finished".equals(parts[2])) return 0;
        try { return Long.parseLong(parts[1]); } catch (NumberFormatException ignored) { return 0; }
    }

    synchronized void release() {
        if (released) return;
        released = true;
        loaded.clear();
        soundPool.release();
    }
}
