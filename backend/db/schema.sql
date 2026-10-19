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


CREATE TABLE IF NOT EXISTS password_reset_codes (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash         VARCHAR(64) NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_count     INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
    consumed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_expiry
    ON password_reset_codes(expires_at);

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

-- Manual wallet withdrawal requests stay visible to admins until paid,
-- declined, and (for completed requests) cleared from the admin queue.
CREATE TABLE IF NOT EXISTS manual_withdrawal_requests (
    id                  BIGSERIAL PRIMARY KEY,
    reference           VARCHAR(120) NOT NULL UNIQUE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_phone     VARCHAR(20) NOT NULL,
    total_amount        NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
    fee_amount          NUMERIC(12,2) NOT NULL CHECK (fee_amount >= 0),
    payout_amount       NUMERIC(12,2) NOT NULL CHECK (payout_amount > 0),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','completed','cancelled')),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    resolved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    admin_cleared_at    TIMESTAMPTZ,
    admin_cleared_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_withdrawal_one_pending_per_user
    ON manual_withdrawal_requests(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_manual_withdrawal_admin_queue
    ON manual_withdrawal_requests(status, admin_cleared_at, requested_at DESC);

-- Per-user view markers let players clear old history without deleting the
-- financial ledger or match records used for settlements, disputes and audit.
CREATE TABLE IF NOT EXISTS user_history_clears (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    history_type VARCHAR(20) NOT NULL CHECK (history_type IN ('transactions', 'matches')),
    cleared_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, history_type)
);

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
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS payout_status VARCHAR(20);
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;
ALTER TABLE chess_matches ADD COLUMN IF NOT EXISTS admin_cleared_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE chess_matches
   SET payout_status='pending_competition'
 WHERE match_type='tournament' AND status='completed' AND stake_amount>0
   AND (payout_status IS NULL OR payout_status='not_applicable');
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
-- Keep ranked searches fast as many players wait in the same rating,
-- time-control, and stake queue. The partial index stores waiting rows only.
CREATE INDEX IF NOT EXISTS idx_chess_ranked_waiting_queue
    ON chess_matches (time_control, stake_amount, id)
    WHERE match_type='ranked' AND status='waiting' AND player_black_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_active_chess_users_by_rating
    ON users (rating, id)
    WHERE account_status='active' AND game IN ('chess','both');
CREATE INDEX IF NOT EXISTS idx_chess_matches_admin_history
    ON chess_matches (admin_cleared_at, finished_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS chess_scheduled_matches (
    id                      BIGSERIAL PRIMARY KEY,
    host_user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guest_user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheduled_at             TIMESTAMPTZ NOT NULL,
    time_zone                VARCHAR(64) NOT NULL DEFAULT 'Africa/Nairobi',
    time_control             VARCHAR(20) NOT NULL DEFAULT '10+5',
    status                   VARCHAR(20) NOT NULL DEFAULT 'pending',
    host_ready_at            TIMESTAMPTZ,
    guest_ready_at           TIMESTAMPTZ,
    match_id                 INTEGER REFERENCES chess_matches(id) ON DELETE SET NULL,
    reminder_60m_sent_at     TIMESTAMPTZ,
    reminder_10m_sent_at     TIMESTAMPTZ,
    reminder_start_sent_at   TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chess_scheduled_matches_different_players CHECK (host_user_id <> guest_user_id),
    CONSTRAINT chess_scheduled_matches_status CHECK (status IN ('pending','accepted','declined','cancelled','started')),
    CONSTRAINT chess_scheduled_matches_control CHECK (time_control IN ('10+5','3+2','1+1'))
);
CREATE INDEX IF NOT EXISTS idx_chess_scheduled_matches_due
    ON chess_scheduled_matches (scheduled_at)
    WHERE status='accepted';
CREATE INDEX IF NOT EXISTS idx_chess_scheduled_matches_host
    ON chess_scheduled_matches (host_user_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_chess_scheduled_matches_guest
    ON chess_scheduled_matches (guest_user_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS chess_tournament_entries (
    id              BIGSERIAL PRIMARY KEY,
    season_key      VARCHAR(7) NOT NULL,
    time_control    VARCHAR(20) NOT NULL,
    stake_amount    NUMERIC(12,2) NOT NULL CHECK (stake_amount >= 0),
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at    TIMESTAMPTZ,
    forfeited_at    TIMESTAMPTZ,
    forfeited_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (forfeited_amount >= 0),
    UNIQUE(season_key,time_control,stake_amount,user_id)
);
ALTER TABLE chess_tournament_entries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE chess_tournament_entries ADD COLUMN IF NOT EXISTS forfeited_at TIMESTAMPTZ;
ALTER TABLE chess_tournament_entries ADD COLUMN IF NOT EXISTS forfeited_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_chess_tournament_entries_live
    ON chess_tournament_entries(season_key,time_control,stake_amount,joined_at)
    WHERE cancelled_at IS NULL AND forfeited_at IS NULL;

CREATE TABLE IF NOT EXISTS chess_competition_settlements (
    id              BIGSERIAL PRIMARY KEY,
    season_key      VARCHAR(7) NOT NULL,
    time_control    VARCHAR(20) NOT NULL,
    stake_amount    NUMERIC(12,2) NOT NULL,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username        VARCHAR(30) NOT NULL,
    final_rank      INTEGER,
    contributed     NUMERIC(12,2) NOT NULL DEFAULT 0,
    prize_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    reference       VARCHAR(120) NOT NULL UNIQUE,
    settled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(season_key,time_control,stake_amount,username)
);
CREATE INDEX IF NOT EXISTS idx_chess_competition_settlements_season
    ON chess_competition_settlements(season_key,time_control,stake_amount,final_rank);


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
    room_code_revision   INTEGER NOT NULL DEFAULT 0 CHECK (room_code_revision >= 0),
    code_correction_requested_at TIMESTAMPTZ,
    code_correction_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status               VARCHAR(30) NOT NULL DEFAULT 'waiting',
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
-- 'awaiting_verification' is 21 characters; keep enough room for every
-- supported match state on databases created with the older VARCHAR(20).
ALTER TABLE efootball_matches ALTER COLUMN status TYPE VARCHAR(30);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS search_last_seen_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS creator_last_seen_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS opponent_last_seen_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS paired_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS attendance_deadline_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS admin_cleared_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_efootball_matches_status ON efootball_matches(status);
CREATE INDEX IF NOT EXISTS idx_efootball_matches_creator ON efootball_matches(creator_id);
CREATE INDEX IF NOT EXISTS idx_efootball_matches_opponent ON efootball_matches(opponent_id);
CREATE INDEX IF NOT EXISTS idx_efootball_matches_admin_history
    ON efootball_matches (admin_cleared_at, finished_at DESC, id DESC);

-- Audited administrative match actions. Game and match ID are a polymorphic
-- pair so the same history can cover chess and Konami records.
CREATE TABLE IF NOT EXISTS admin_match_management_events (
    id          BIGSERIAL PRIMARY KEY,
    game        VARCHAR(10) NOT NULL CHECK (game IN ('chess', 'konami')),
    match_id    BIGINT NOT NULL,
    admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(30) NOT NULL,
    reason      TEXT,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_match_management_events_recent
    ON admin_match_management_events(game, match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_efootball_waiting_search_activity
    ON efootball_matches(search_last_seen_at, created_at)
    WHERE status='waiting' AND opponent_id IS NULL;
-- Ranked eFootball queues are split by stake and oldest search first. This
-- avoids scanning every mode's waiting matches as the ranked pool grows.
CREATE INDEX IF NOT EXISTS idx_efootball_ranked_waiting_queue
    ON efootball_matches (stake_amount, created_at, id)
    WHERE mode='ranked' AND status='waiting' AND opponent_id IS NULL;

CREATE TABLE IF NOT EXISTS efootball_leagues (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(30) NOT NULL UNIQUE,
    description         TEXT,
    entry_stake         NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status              VARCHAR(20) NOT NULL DEFAULT 'open'
);
ALTER TABLE efootball_leagues ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE efootball_leagues ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE efootball_leagues ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE efootball_leagues ADD COLUMN IF NOT EXISTS season_rounds INTEGER;

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

CREATE TABLE IF NOT EXISTS efootball_league_rounds (
    id              BIGSERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL REFERENCES efootball_leagues(id) ON DELETE CASCADE,
    round_number    INTEGER NOT NULL CHECK (round_number > 0),
    starts_at       TIMESTAMPTZ,
    deadline_at     TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_id, round_number)
);
CREATE TABLE IF NOT EXISTS efootball_league_fixtures (
    id              BIGSERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL REFERENCES efootball_leagues(id) ON DELETE CASCADE,
    round_number    INTEGER NOT NULL CHECK (round_number > 0),
    home_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    away_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    match_id        BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    home_score      INTEGER,
    away_score      INTEGER,
    winner_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_id, round_number, home_id, away_id)
);
CREATE INDEX IF NOT EXISTS efootball_league_fixtures_round_idx
    ON efootball_league_fixtures(league_id, round_number, status);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS league_fixture_id BIGINT REFERENCES efootball_league_fixtures(id) ON DELETE SET NULL;

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
    group_code           VARCHAR(2),
    UNIQUE(tournament_id, user_id)
);
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS first_match_at TIMESTAMPTZ;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS forfeited_at TIMESTAMPTZ;

-- Tournament rounds have a shared 20-minute result window. Fixtures are
-- generated once per round and retain their opponent assignment even when
-- neither player starts matchmaking.
CREATE TABLE IF NOT EXISTS efootball_tournament_rounds (
    id              BIGSERIAL PRIMARY KEY,
    tournament_id   BIGINT NOT NULL REFERENCES efootball_tournaments(id) ON DELETE CASCADE,
    round_number    INTEGER NOT NULL CHECK (round_number > 0),
    starts_at       TIMESTAMPTZ,
    deadline_at     TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tournament_id, round_number)
);
CREATE TABLE IF NOT EXISTS efootball_tournament_fixtures (
    id              BIGSERIAL PRIMARY KEY,
    tournament_id   BIGINT NOT NULL REFERENCES efootball_tournaments(id) ON DELETE CASCADE,
    round_number    INTEGER NOT NULL CHECK (round_number > 0),
    group_code      VARCHAR(2) NOT NULL,
    home_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    away_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    match_id        BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    home_score      INTEGER,
    away_score      INTEGER,
    winner_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tournament_id, round_number, group_code, home_id, away_id)
);
CREATE INDEX IF NOT EXISTS efootball_tournament_fixtures_round_idx
    ON efootball_tournament_fixtures(tournament_id, round_number, group_code, status);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS tournament_fixture_id BIGINT REFERENCES efootball_tournament_fixtures(id) ON DELETE SET NULL;


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
-- CREATE TABLE IF NOT EXISTS does not add constraints to an older table.
-- Keep the per-match uniqueness required by the result route's ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS efootball_result_verifications_match_id_key
    ON efootball_result_verifications(match_id);
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
-- Authenticated, multi-device Web Push subscriptions and durable delivery history.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint            TEXT NOT NULL UNIQUE,
    p256dh              TEXT NOT NULL,
    auth                TEXT NOT NULL,
    expiration_time     TIMESTAMPTZ,
    user_agent          VARCHAR(300),
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_active
    ON push_subscriptions(user_id, active);

CREATE TABLE IF NOT EXISTS push_notification_events (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id            BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL,
    event_key           VARCHAR(180) NOT NULL,
    title               VARCHAR(160) NOT NULL,
    body                VARCHAR(240) NOT NULL,
    target_path         VARCHAR(300) NOT NULL,
    clicked_at          TIMESTAMPTZ,
    click_action        VARCHAR(30),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, event_key)
);
ALTER TABLE push_notification_events
    ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_push_events_user_created
    ON push_notification_events(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS companion_notification_preferences (
    user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    match_reminders         BOOLEAN NOT NULL DEFAULT TRUE,
    competition_reminders  BOOLEAN NOT NULL DEFAULT TRUE,
    room_code_requests     BOOLEAN NOT NULL DEFAULT TRUE,
    admin_announcements    BOOLEAN NOT NULL DEFAULT TRUE,
    support_replies        BOOLEAN NOT NULL DEFAULT TRUE,
    general_updates        BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_delivery_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES push_notification_events(id) ON DELETE CASCADE,
    subscription_id     BIGINT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sending', 'accepted', 'failed')),
    attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at         TIMESTAMPTZ,
    last_http_status    INTEGER,
    last_error          VARCHAR(240),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_push_jobs_pending
    ON push_delivery_jobs(status, next_attempt_at, id)
    WHERE status IN ('queued', 'sending');

CREATE TABLE IF NOT EXISTS push_delivery_attempts (
    id                  BIGSERIAL PRIMARY KEY,
    job_id              BIGINT NOT NULL REFERENCES push_delivery_jobs(id) ON DELETE CASCADE,
    attempt_number      INTEGER NOT NULL CHECK (attempt_number > 0),
    outcome             VARCHAR(20) NOT NULL,
    http_status         INTEGER,
    error_summary       VARCHAR(240),
    attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(job_id, attempt_number)
);

-- Native Android devices use Firebase Cloud Messaging so their notification
-- can contain an Android RemoteInput reply action. Tokens and jobs are kept
-- separate from browser Push API subscriptions.
CREATE TABLE IF NOT EXISTS android_push_tokens (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token               TEXT NOT NULL UNIQUE,
    device_id           VARCHAR(80),
    device_name         VARCHAR(120),
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    inactive_reason     VARCHAR(30) CHECK (inactive_reason IS NULL OR inactive_reason IN ('user_disabled', 'token_invalid')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE android_push_tokens
    ADD COLUMN IF NOT EXISTS inactive_reason VARCHAR(30);
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid='android_push_tokens'::regclass
           AND conname='android_push_tokens_inactive_reason_check'
    ) THEN
        ALTER TABLE android_push_tokens
            ADD CONSTRAINT android_push_tokens_inactive_reason_check
            CHECK (inactive_reason IS NULL OR inactive_reason IN ('user_disabled', 'token_invalid'));
    END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_android_push_tokens_user_active
    ON android_push_tokens(user_id, active);

CREATE TABLE IF NOT EXISTS android_push_delivery_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES push_notification_events(id) ON DELETE CASCADE,
    token_id            BIGINT NOT NULL REFERENCES android_push_tokens(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sending', 'accepted', 'failed')),
    attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at         TIMESTAMPTZ,
    last_error          VARCHAR(240),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_android_push_jobs_pending
    ON android_push_delivery_jobs(status, next_attempt_at, id)
    WHERE status IN ('queued', 'sending');

CREATE TABLE IF NOT EXISTS android_push_delivery_attempts (
    id                  BIGSERIAL PRIMARY KEY,
    job_id              BIGINT NOT NULL REFERENCES android_push_delivery_jobs(id) ON DELETE CASCADE,
    attempt_number      INTEGER NOT NULL CHECK (attempt_number > 0),
    outcome             VARCHAR(20) NOT NULL,
    error_summary       VARCHAR(240),
    attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(job_id, attempt_number)
);

-- The account-level setup guide acknowledgement is versioned so the owner can
-- require an existing member to review updated instructions.
CREATE TABLE IF NOT EXISTS companion_user_setup (
    user_id                     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    onboarding_version          VARCHAR(40) NOT NULL,
    onboarding_acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A random app-generated installation id is HMACed server-side. This keeps a
-- stable installation record without retaining the raw id or device model.
CREATE TABLE IF NOT EXISTS companion_installations (
    id                              BIGSERIAL PRIMARY KEY,
    user_id                         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id_hash            CHAR(64) NOT NULL,
    device_platform                 VARCHAR(24) NOT NULL DEFAULT 'android'
                                    CHECK (device_platform IN ('android')),
    app_version                     VARCHAR(40) NOT NULL,
    registered_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unregistered_at                 TIMESTAMPTZ,
    notification_permission_status  VARCHAR(10) NOT NULL DEFAULT 'unknown'
                                    CHECK (notification_permission_status IN ('granted','denied','unknown')),
    notification_permission_checked_at TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, installation_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_companion_installations_user_activity
    ON companion_installations(user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_companion_installations_hash_active
    ON companion_installations(installation_id_hash, unregistered_at);

-- Downloads are recorded after the APK response completes. The unique key
-- counts a member once per APK checksum while retaining the latest download.
CREATE TABLE IF NOT EXISTS companion_download_events (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    apk_sha256          CHAR(64) NOT NULL,
    downloaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_downloaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, apk_sha256)
);
CREATE INDEX IF NOT EXISTS idx_companion_download_events_user
    ON companion_download_events(user_id, downloaded_at DESC);

-- Public sign-up-page downloads are counted anonymously and are never
-- attributed to a registered member or correlated with an IP/device.
CREATE TABLE IF NOT EXISTS companion_anonymous_download_events (
    id          BIGSERIAL PRIMARY KEY,
    apk_sha256  CHAR(64) NOT NULL,
    downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_companion_anonymous_downloads_created
    ON companion_anonymous_download_events(downloaded_at DESC);


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
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS result_round SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS external_room_code VARCHAR(50);
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS room_code_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_sent_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_correction_requested_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_correction_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_received_at TIMESTAMPTZ;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS code_received_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE efootball_matches ADD COLUMN IF NOT EXISTS tournament_id BIGINT REFERENCES efootball_tournaments(id) ON DELETE SET NULL;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS fee_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE efootball_tournament_members ADD COLUMN IF NOT EXISTS group_code VARCHAR(2);
ALTER TABLE efootball_league_members ADD COLUMN IF NOT EXISTS fee_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE efootball_league_members ADD COLUMN IF NOT EXISTS forfeited_at TIMESTAMPTZ;
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
ALTER TABLE efootball_tournaments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE efootball_tournaments ADD COLUMN IF NOT EXISTS season_rounds INTEGER;

-- Assign existing entries to stable groups of up to four, preserving entry order.
WITH ranked_members AS (
    SELECT tm.id,
           ROW_NUMBER() OVER (PARTITION BY tm.tournament_id ORDER BY tm.joined_at, tm.id) AS member_rank,
           GREATEST(1, CEIL(t.max_players::numeric /
               LEAST(4, GREATEST(1, CEIL(t.max_players::numeric / 4))))) AS group_size
      FROM efootball_tournament_members tm
      JOIN efootball_tournaments t ON t.id = tm.tournament_id
     WHERE tm.group_code IS NULL
)
UPDATE efootball_tournament_members tm
   SET group_code = CHR(65 + FLOOR((ranked.member_rank - 1) / ranked.group_size)::integer)
  FROM ranked_members ranked
 WHERE tm.id = ranked.id;

ALTER TABLE efootball_tournament_members ALTER COLUMN group_code SET NOT NULL;
CREATE INDEX IF NOT EXISTS efootball_tournament_members_group_idx
    ON efootball_tournament_members(tournament_id, group_code, user_id);

-- Season-end awards and player-funded entry-pool refunds. The per-player
-- row makes payout execution idempotent and keeps a readable audit trail.
CREATE TABLE IF NOT EXISTS efootball_competition_settlements (
    id                  BIGSERIAL PRIMARY KEY,
    competition_type    VARCHAR(20) NOT NULL CHECK (competition_type IN ('league','tournament')),
    competition_id      BIGINT NOT NULL,
    season_key          VARCHAR(40) NOT NULL,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username            VARCHAR(30) NOT NULL,
    final_rank          INTEGER,
    entry_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    prize_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
    reference           VARCHAR(120) NOT NULL UNIQUE,
    settled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(competition_type, competition_id, season_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_efootball_competition_settlements_season
    ON efootball_competition_settlements(competition_type, competition_id, season_key, final_rank);

-- Every administrator balance or competition-table edit is retained for review.
CREATE TABLE IF NOT EXISTS admin_wallet_adjustments (
    id                  BIGSERIAL PRIMARY KEY,
    admin_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username            VARCHAR(30) NOT NULL,
    amount              NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    previous_balance    NUMERIC(12,2) NOT NULL,
    new_balance         NUMERIC(12,2) NOT NULL,
    reason              TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
    reference           VARCHAR(120) NOT NULL UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_wallet_adjustments_recent
    ON admin_wallet_adjustments(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_competition_adjustments (
    id                  BIGSERIAL PRIMARY KEY,
    admin_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    competition_type    VARCHAR(20) NOT NULL CHECK (competition_type IN ('league','tournament')),
    competition_id      BIGINT NOT NULL,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username            VARCHAR(30) NOT NULL,
    previous_stats      JSONB NOT NULL,
    new_stats           JSONB NOT NULL,
    reason              TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_competition_adjustments_recent
    ON admin_competition_adjustments(competition_type, competition_id, created_at DESC, id DESC);

-- Keep existing active, same-group matches in the correct group-stage feed.
UPDATE efootball_matches m
   SET round_name = 'Group ' || home.group_code
  FROM efootball_tournament_members home
 WHERE m.tournament_id = home.tournament_id
   AND m.creator_id = home.user_id
   AND m.round_name IS NULL
   AND (m.opponent_id IS NULL OR EXISTS (
       SELECT 1
         FROM efootball_tournament_members away
        WHERE away.tournament_id = m.tournament_id
          AND away.user_id = m.opponent_id
          AND away.group_code = home.group_code
   ));

ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS screenshot_ocr_text TEXT;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS detected_score_candidates JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS score_check VARCHAR(20);
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;
ALTER TABLE efootball_result_verifications ADD COLUMN IF NOT EXISTS admin_cleared_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS efootball_result_admin_events (
    id BIGSERIAL PRIMARY KEY,
    verification_id BIGINT NOT NULL REFERENCES efootball_result_verifications(id) ON DELETE CASCADE,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_efootball_result_admin_events_recent
    ON efootball_result_admin_events(verification_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS efootball_result_reports (
    id BIGSERIAL PRIMARY KEY,
    match_id BIGINT NOT NULL REFERENCES efootball_matches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    round_no SMALLINT NOT NULL CHECK (round_no IN (1,2)),
    score_for INTEGER NOT NULL CHECK (score_for BETWEEN 0 AND 99),
    score_against INTEGER NOT NULL CHECK (score_against BETWEEN 0 AND 99),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(match_id,user_id,round_no)
);
CREATE INDEX IF NOT EXISTS idx_efootball_result_reports_match
    ON efootball_result_reports(match_id, round_no, submitted_at);

INSERT INTO efootball_result_verifications(match_id,selected_player_id,status,score_check)
SELECT m.id,
       CASE WHEN random() < 0.5 THEN m.creator_id ELSE m.opponent_id END,
       'awaiting_scores','awaiting_scores'
  FROM efootball_matches m
 WHERE m.opponent_id IS NOT NULL
   AND m.status IN ('playing','awaiting_verification','disputed')
   AND NOT EXISTS (
       SELECT 1 FROM efootball_result_verifications v WHERE v.match_id=m.id
   );


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
    support_category VARCHAR(40),
    support_subject VARCHAR(160),
    support_status VARCHAR(20) NOT NULL DEFAULT 'open',
    UNIQUE(thread_type, user_one_id, user_two_id)
);
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS admin_cleared_at TIMESTAMPTZ;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS support_category VARCHAR(40);
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS support_subject VARCHAR(160);
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS support_status VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS user_one_cleared_at TIMESTAMPTZ;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS user_two_cleared_at TIMESTAMPTZ;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS user_cleared_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    client_message_id VARCHAR(80)
);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_sender_client_id
    ON chat_messages(sender_id,client_message_id) WHERE client_message_id IS NOT NULL;

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
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS user_cleared_at TIMESTAMPTZ;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complaint_ref VARCHAR(40);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS match_id BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'support';
UPDATE complaints SET complaint_ref = 'GG-' || LPAD(id::text, 10, '0') WHERE complaint_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_complaints_reference ON complaints(complaint_ref);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_reporter ON complaints(reporter_id);
CREATE INDEX IF NOT EXISTS idx_complaints_match ON complaints(match_id, created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_case_events (
    id BIGSERIAL PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_role VARCHAR(20) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    from_status VARCHAR(30),
    to_status VARCHAR(30),
    message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_complaint_case_events_case
    ON complaint_case_events(complaint_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS complaint_admin_notes (
    id BIGSERIAL PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_complaint_admin_notes_case
    ON complaint_admin_notes(complaint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_evidence_requests (
    id BIGSERIAL PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    request_type VARCHAR(20) NOT NULL CHECK (request_type IN ('evidence','clarification')),
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    fulfilled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_complaint_evidence_requests_case
    ON complaint_evidence_requests(complaint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_evidence (
    id BIGSERIAL PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    match_id BIGINT REFERENCES efootball_matches(id) ON DELETE SET NULL,
    verification_id BIGINT REFERENCES efootball_result_verifications(id) ON DELETE SET NULL,
    request_id BIGINT REFERENCES complaint_evidence_requests(id) ON DELETE SET NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_key VARCHAR(64) NOT NULL UNIQUE,
    mime_type VARCHAR(40) NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
    purpose VARCHAR(40) NOT NULL DEFAULT 'complaint',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_complaint_evidence_case
    ON complaint_evidence(complaint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaint_evidence_match
    ON complaint_evidence(match_id, created_at DESC);

CREATE TABLE IF NOT EXISTS efootball_result_corrections (
    id BIGSERIAL PRIMARY KEY,
    match_id BIGINT NOT NULL REFERENCES efootball_matches(id) ON DELETE RESTRICT,
    complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
    admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    old_creator_score INTEGER,
    old_opponent_score INTEGER,
    old_winner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    new_creator_score INTEGER NOT NULL,
    new_opponent_score INTEGER NOT NULL,
    new_winner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(complaint_id)
);
CREATE INDEX IF NOT EXISTS idx_efootball_result_corrections_match
    ON efootball_result_corrections(match_id, created_at DESC);

-- Dedicated administrator wallet. Funds may enter only through audited
-- administrator dispute resolutions; no player deposit route targets it.
CREATE TABLE IF NOT EXISTS admin_wallets (
    admin_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    balance     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency    VARCHAR(3) NOT NULL DEFAULT 'KES',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_wallet_transactions (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    transaction_type VARCHAR(40) NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'KES',
    status          VARCHAR(20) NOT NULL DEFAULT 'completed',
    reference       VARCHAR(120) NOT NULL UNIQUE,
    description     TEXT,
    complaint_id    BIGINT REFERENCES complaints(id) ON DELETE RESTRICT,
    match_id        BIGINT REFERENCES efootball_matches(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_wallet_transactions_recent
    ON admin_wallet_transactions(admin_id, created_at DESC, id DESC);

-- Administrators may clear the activity view without deleting financial
-- entries that are needed for payout reconciliation and audit.
CREATE TABLE IF NOT EXISTS admin_wallet_history_clears (
    admin_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    cleared_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_mpesa_payouts (
    reference                  VARCHAR(120) PRIMARY KEY REFERENCES admin_wallet_transactions(reference) ON DELETE CASCADE,
    admin_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_mpesa_payout_one_pending
    ON admin_mpesa_payouts(admin_id)
    WHERE status='pending';


-- ============================================================
-- ADMIN ANNOUNCEMENTS (ADMIN -> ALL USERS)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_announcements (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    event_name  VARCHAR(160),
    event_at    TIMESTAMPTZ,
    event_time_zone VARCHAR(64) NOT NULL DEFAULT 'Africa/Nairobi',
    audience    VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (audience IN ('all','chess','konami')),
    publish_at  TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    reminder_24h_sent_at TIMESTAMPTZ,
    reminder_1h_sent_at TIMESTAMPTZ,
    reminder_start_sent_at TIMESTAMPTZ
);

-- Additive announcement fields for existing installations. Existing messages
-- remain published at their original creation time and remain visible.
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS event_name VARCHAR(160);
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS event_time_zone VARCHAR(64) NOT NULL DEFAULT 'Africa/Nairobi';
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS audience VARCHAR(20) NOT NULL DEFAULT 'all';
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ;
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS reminder_1h_sent_at TIMESTAMPTZ;
ALTER TABLE admin_announcements ADD COLUMN IF NOT EXISTS reminder_start_sent_at TIMESTAMPTZ;
UPDATE admin_announcements SET published_at=created_at
 WHERE published_at IS NULL AND publish_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_announcement_reads (
    announcement_id BIGINT NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS admin_announcement_dismissals (
    announcement_id BIGINT NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
CREATE INDEX IF NOT EXISTS idx_admin_announcements_publish_due
    ON admin_announcements(publish_at,id) WHERE active=TRUE AND published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_announcements_event_due
    ON admin_announcements(event_at,id) WHERE active=TRUE AND published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_announcement_reads_user
    ON admin_announcement_reads(user_id, announcement_id);

CREATE INDEX IF NOT EXISTS idx_admin_announcement_dismissals_user
    ON admin_announcement_dismissals(user_id, announcement_id);

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
