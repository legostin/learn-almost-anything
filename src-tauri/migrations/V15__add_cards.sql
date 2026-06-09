-- Per-CARD FSRS spaced repetition. Replaces the per-submodule SM-2 `reviews`
-- table, which is kept untouched (read-only) for rollback.

CREATE TABLE cards (
    id             TEXT PRIMARY KEY,
    course_id      TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    module_id      TEXT NOT NULL,
    submodule_id   TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL DEFAULT 'flashcard',
    position       INTEGER NOT NULL DEFAULT 0,
    front          TEXT NOT NULL,
    back           TEXT NOT NULL,
    concept        TEXT,
    anchor         TEXT,
    content_hash   TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    -- FSRS state (mirrors rs_fsrs::Card)
    state          INTEGER NOT NULL DEFAULT 0,  -- 0 New, 1 Learning, 2 Review, 3 Relearning
    due_at         INTEGER NOT NULL,
    stability      REAL NOT NULL DEFAULT 0,
    difficulty     REAL NOT NULL DEFAULT 0,
    elapsed_days   INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    reps           INTEGER NOT NULL DEFAULT 0,
    lapses         INTEGER NOT NULL DEFAULT 0,
    last_review_at INTEGER,
    suspended      INTEGER NOT NULL DEFAULT 0,
    leech          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cards_due ON cards(course_id, suspended, due_at);
CREATE INDEX idx_cards_submodule ON cards(submodule_id, position);

-- Full review history: drives streak/heatmap and is exactly the data the
-- FSRS optimizer needs if we later train per-user parameters.
CREATE TABLE review_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id           TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    course_id         TEXT NOT NULL,
    reviewed_at       INTEGER NOT NULL,
    rating            INTEGER NOT NULL,        -- 1 Again, 2 Hard, 3 Good, 4 Easy
    state_before      INTEGER NOT NULL,
    stability_before  REAL NOT NULL,
    difficulty_before REAL NOT NULL,
    stability_after   REAL NOT NULL,
    difficulty_after  REAL NOT NULL,
    elapsed_days      INTEGER NOT NULL,
    scheduled_days    INTEGER NOT NULL,
    due_after         INTEGER NOT NULL,
    source            TEXT NOT NULL DEFAULT 'manual' -- manual|ai|test_seed|diagnostic|inline
);
CREATE INDEX idx_review_log_time ON review_log(reviewed_at);
CREATE INDEX idx_review_log_card ON review_log(card_id, reviewed_at);

-- Learner profile (level/goals/prior knowledge), distinct from
-- generation_profile which is the cost/quality tier profile.
ALTER TABLE courses ADD COLUMN learner_profile TEXT;

-- One-time flags (cards backfill marker etc.).
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
