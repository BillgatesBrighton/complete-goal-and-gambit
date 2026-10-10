-- GOAL$GAMBIT database schema (PostgreSQL)
-- Safe to run more than once: every statement uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id                  SERIAL PRIMARY KEY,
    username            VARCHAR(30)  NOT NULL UNIQUE,
    phone               VARCHAR(20)  NOT NULL UNIQUE,
    password_hash       TEXT         NOT NULL,
    rating              INTEGER      NOT NULL DEFAULT 1200,
    game                VARCHAR(20)  NOT NULL DEFAULT 'both',
    role                VARCHAR(20)  NOT NULL DEFAULT 'user',
    account_status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    suspended_until     TIMESTAMPTZ,
    moderation_reason   TEXT,
    auth_version        INTEGER      NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Backward-compatible migration for databases created from an older schema.
ALTER TABLE users ADD COLUMN IF NOT EXISTS game VARCHAR(20) NOT NULL DEFAULT 'chess';
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS moderation_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ALTER COLUMN game SET DEFAULT 'both';
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE users ALTER COLUMN account_status SET DEFAULT 'active';


CREATE TABLE IF NOT EXISTS wallets (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER       NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    locked_balance  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
    currency        VARCHAR(3)    NOT NULL DEFAULT 'KES',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id                BIGSERIAL PRIMARY KEY,
    user_id           INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_type  VARCHAR(30)   NOT NULL,
    amount            NUMERIC(12,2) NOT NULL,
    currency          VARCHAR(3)    NOT NULL DEFAULT 'KES',
    status            VARCHAR(20)   NOT NULL DEFAULT 'completed',
    reference         VARCHAR(120)  UNIQUE,
    description       TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reference_unique ON transactions (reference);

-- C2B receipts are durable and idempotent. Unmapped payments stay visible for
-- later reconciliation instead of being silently credited to the wrong wallet.
CREATE TABLE IF NOT EXISTS mpesa_c2b_payments (
    transaction_id      VARCHAR(64) PRIMARY KEY,
    business_shortcode  VARCHAR(12) NOT NULL,
    account_reference   VARCHAR(30) NOT NULL,
    amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'unmatched'
                         CHECK (status IN ('credited', 'unmatched')),
    unmatched_reason     VARCHAR(50),
    received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_unmatched
    ON mpesa_c2b_payments (received_at DESC)
    WHERE status = 'unmatched';
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_user
    ON mpesa_c2b_payments (user_id, received_at DESC);

-- B2C requests keep the callback bearer secret hashed and bind every Daraja
-- response to one specific, pending wallet withdrawal.
CREATE TABLE IF NOT EXISTS mpesa_payouts (
    reference                  VARCHAR(120) PRIMARY KEY REFERENCES transactions(reference) ON DELETE CASCADE,
    user_id                    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_phone            VARCHAR(15) NOT NULL,
    callback_token_hash        CHAR(64) NOT NULL UNIQUE,
    status                     VARCHAR(20) NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'completed', 'failed')),
    provider_status            VARCHAR(20) NOT NULL DEFAULT 'requesting'
                               CHECK (provider_status IN ('requesting', 'accepted', 'unknown', 'completed', 'failed')),
    originator_conversation_id VARCHAR(120) UNIQUE,
    conversation_id            VARCHAR(120),
    result_code                VARCHAR(40),
    result_description         TEXT,
    receipt                    VARCHAR(80),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at                 TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mpesa_payout_one_pending_per_user
    ON mpesa_payouts (user_id)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS chess_matches (
    id                  BIGSERIAL PRIMARY KEY,
    player_white_id     INTEGER REFERENCES users(id),
    player_black_id     INTEGER REFERENCES users(id),
    status              VARCHAR(20)   NOT NULL DEFAULT 'waiting',   -- waiting | active | completed | cancelled
    result              VARCHAR(20),                                -- white_win | black_win | draw
    winner_id           INTEGER REFERENCES users(id),
    fen                 TEXT          NOT NULL DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    pgn                 TEXT,
    white_time_ms       BIGINT        NOT NULL DEFAULT 600000,
    black_time_ms       BIGINT        NOT NULL DEFAULT 600000,
    active_color        CHAR(1)       NOT NULL DEFAULT 'w',
    last_move_at        TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    time_control        VARCHAR(20)   NOT NULL DEFAULT '10+5',
    match_type          VARCHAR(20)   NOT NULL DEFAULT 'casual',    -- casual | ranked | tournament
    stake_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    draw_offer_user_id  INTEGER REFERENCES users(id),
    rating_updated_at   TIMESTAMPTZ,
    settled_at          TIMESTAMPTZ,
    payout_status       VARCHAR(20),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
-- Existing databases keep their original table definition when the schema is
-- re-applied. Add fields introduced by the current chess routes explicitly.
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS fen TEXT;
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS pgn TEXT;
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS active_color CHAR(1);
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS draw_offer_user_id BIGINT;
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS rating_updated_at TIMESTAMPTZ;
-- Queue rows have no black player until a match is found. Keep both player
-- references nullable so older installations match the current table shape
-- and account deletion can anonymize shared game history safely.
ALTER TABLE chess_matches ALTER COLUMN player_white_id DROP NOT NULL;
ALTER TABLE chess_matches ALTER COLUMN player_black_id DROP NOT NULL;

-- Older installations stored the position as current_fen. Copy it into the
-- canonical field when present; the conditional keeps fresh installs simple.
DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'chess_matches'
           AND column_name = 'current_fen'
    ) THEN
        EXECUTE $sql$
            UPDATE chess_matches
               SET fen = current_fen
             WHERE current_fen IS NOT NULL
               AND BTRIM(current_fen) <> ''
               AND (fen IS NULL OR BTRIM(fen) = '')
        $sql$;
    END IF;
END
$migration$;

UPDATE chess_matches
   SET fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
 WHERE fen IS NULL OR BTRIM(fen) = '';
ALTER TABLE chess_matches
    ALTER COLUMN fen SET DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    ALTER COLUMN fen SET NOT NULL;

-- FEN's active side is the source of truth for a match's clock turn.
UPDATE chess_matches
   SET active_color = CASE WHEN split_part(fen, ' ', 2) = 'b' THEN 'b' ELSE 'w' END
 WHERE active_color IS DISTINCT FROM
       CASE WHEN split_part(fen, ' ', 2) = 'b' THEN 'b' ELSE 'w' END;
ALTER TABLE chess_matches
    ALTER COLUMN active_color SET DEFAULT 'w',
    ALTER COLUMN active_color SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chess_matches_white  ON chess_matches (player_white_id);
CREATE INDEX IF NOT EXISTS idx_chess_matches_black  ON chess_matches (player_black_id);
CREATE INDEX IF NOT EXISTS idx_chess_matches_status ON chess_matches (status);


-- ======================================================
-- eFOOTBALL / KONAMI MATCHES
-- ======================================================
CREATE TABLE IF NOT EXISTS efootball_matches (
    id                  BIGSERIAL PRIMARY KEY,
    creator_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    mode                 VARCHAR(30) NOT NULL DEFAULT 'ranked',
    league               VARCHAR(30),
    round_name           VARCHAR(50),
    stake_amount         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (stake_amount >= 0),
    room_code            VARCHAR(20) NOT NULL UNIQUE,
    status               VARCHAR(20) NOT NULL DEFAULT 'waiting',
    creator_ready        BOOLEAN NOT NULL DEFAULT FALSE,
    opponent_ready       BOOLEAN NOT NULL DEFAULT FALSE,
    creator_score        INTEGER,
    opponent_score       INTEGER,
    submitted_by         INTEGER REFERENCES users(id),
    result_status        VARCHAR(20),
    winner_id            INTEGER REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_last_seen_at  TIMESTAMPTZ,
    started_at            TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    settled_at            TIMESTAMPTZ
);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS search_last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_efootball_matches_status ON efootball_matches(status);
CREATE INDEX IF NOT EXISTS idx_efootball_matches_creator ON efootball_matches(creator_id);
CREATE INDEX IF NOT EXISTS idx_efootball_matches_opponent ON efootball_matches(opponent_id);
CREATE INDEX IF NOT EXISTS idx_efootball_waiting_search_activity
    ON efootball_matches(search_last_seen_at, created_at)
    WHERE status='waiting' AND opponent_id IS NULL;

CREATE TABLE IF NOT EXISTS efootball_leagues (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(30) NOT NULL UNIQUE,
    description         TEXT,
    entry_stake         NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS efootball_league_members (
    id                  BIGSERIAL PRIMARY KEY,
    league_id           INTEGER NOT NULL REFERENCES efootball_leagues(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    played              INTEGER NOT NULL DEFAULT 0,
    wins                INTEGER NOT NULL DEFAULT 0,
    draws               INTEGER NOT NULL DEFAULT 0,
    losses              INTEGER NOT NULL DEFAULT 0,
    points              INTEGER NOT NULL DEFAULT 0,
    goal_difference     INTEGER NOT NULL DEFAULT 0,
    goals_for           INTEGER NOT NULL DEFAULT 0,
    goals_against       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(league_id, user_id)
);

CREATE TABLE IF NOT EXISTS efootball_tournaments (
    id                  BIGSERIAL PRIMARY KEY,
    name                VARCHAR(100) NOT NULL UNIQUE,
    tier                VARCHAR(20) NOT NULL DEFAULT 'bronze',
    entry_fee           NUMERIC(12,2) NOT NULL DEFAULT 0,
    max_players         INTEGER NOT NULL DEFAULT 16,
    status              VARCHAR(20) NOT NULL DEFAULT 'open',
    starts_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS efootball_tournament_members (
    id                  BIGSERIAL PRIMARY KEY,
    tournament_id       BIGINT NOT NULL REFERENCES efootball_tournaments(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tournament_id, user_id)
);


-- ======================================================
-- EFOOTBALL RESULT VERIFICATION / SYSTEM NOTIFICATIONS
-- ======================================================
CREATE TABLE IF NOT EXISTS efootball_result_verifications (
    id                  BIGSERIAL PRIMARY KEY,
    match_id            BIGINT NOT NULL REFERENCES efootball_matches(id) ON DELETE CASCADE,
    selected_player_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    screenshot_path     TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    submitted_at        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(match_id)
);
CREATE INDEX IF NOT EXISTS idx_efootball_result_verifications_player
    ON efootball_result_verifications(selected_player_id, status);

CREATE TABLE IF NOT EXISTS system_notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    title       VARCHAR(160) NOT NULL,
    message     TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 4000),
    match_id    BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_notifications_user
    ON system_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_system_notifications_unread
    ON system_notifications(user_id, read_at)
    WHERE read_at IS NULL;


-- ======================================================
-- MIGRATIONS (safe to re-run)
-- ======================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS game VARCHAR(10) NOT NULL DEFAULT 'both';
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_sender_id INTEGER REFERENCES users(id);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS creator_submitted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS opponent_submitted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS creator_submitted_score INTEGER;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS creator_submitted_opponent_score INTEGER;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS opponent_submitted_score INTEGER;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS opponent_submitted_opponent_score INTEGER;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS external_room_code VARCHAR(50);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS tournament_id BIGINT REFERENCES efootball_tournaments(id) ON DELETE SET NULL;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS fee_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE efootball_league_members ADD COLUMN IF NOT EXISTS fee_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE efootball_league_members ADD COLUMN IF NOT EXISTS goals_for INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_league_members ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS played INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS draws INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS goal_difference INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS goals_for INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0;

ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS screenshot_ocr_text TEXT;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS detected_score_candidates JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS score_check VARCHAR(20);
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;


-- ======================================================
-- MODERATION / SUPPORT / CHAT
-- ======================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS moderation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(account_status);

CREATE TABLE IF NOT EXISTS chat_threads (
    id BIGSERIAL PRIMARY KEY,
    thread_type VARCHAR(20) NOT NULL,
    user_one_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    user_two_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admin_cleared_at TIMESTAMPTZ,
    UNIQUE(thread_type, user_one_id, user_two_id)
);
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id);

CREATE TABLE IF NOT EXISTS complaints (
    id BIGSERIAL PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'other',
    subject VARCHAR(160) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    admin_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_reporter ON complaints(reporter_id);


-- ============================================================
-- ADMIN ANNOUNCEMENTS (ADMIN -> ALL USERS)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_announcements (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS admin_announcement_reads (
    announcement_id BIGINT NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (announcement_id, user_id)
);

-- ============================================================
-- GENERAL CHAT (ONE PUBLIC ROOM)
-- ============================================================
CREATE TABLE IF NOT EXISTS general_chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_general_chat_messages_created
    ON general_chat_messages(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_announcements_created
    ON admin_announcements(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_announcement_reads_user
    ON admin_announcement_reads(user_id, announcement_id);

-- Ensure the existing direct/support chat tables have useful indexes.
CREATE INDEX IF NOT EXISTS idx_chat_threads_users
    ON chat_threads(user_one_id, user_two_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created
    ON chat_messages(thread_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_unread
    ON chat_messages(thread_id, read_at)
    WHERE read_at IS NULL;

-- One support thread per user. PostgreSQL UNIQUE constraints treat NULLs as
-- distinct, so support conversations need a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_support_user_unique
    ON chat_threads(user_one_id)
    WHERE thread_type='support' AND user_two_id IS NULL;
